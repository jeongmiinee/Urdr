import type { GeneratorSettings, Point } from "../model/world";
import { fractalNoise, fractalPerlinNoise } from "./noise";
import { mulberry32 } from "./random";
import { createLandformField } from "./terrainShapes";

const clamp = (value: number, min = -2, max = 2) => Math.max(min, Math.min(max, value));

type Plate = Point & { vx: number; vy: number; continental: boolean; uplift: number; radius: number; tier: "major" | "medium" | "micro" };
export function estimatedPlateCount(settings: Pick<GeneratorSettings, "mapScaleKm" | "mapScope">): number {
  const earthWidthRatio = Math.max(0.002, settings.mapScaleKm / 40_075);
  const earthScaledCount = Math.round(52 * Math.pow(earthWidthRatio, 1.35));
  return Math.max((settings.mapScope === "local" || settings.mapScope === "regional") ? 4 : 6, Math.min(120, earthScaledCount));
}

export type TectonicPlatePlan = { plates: Plate[] };

/** 판은 최초 지형을 직접 만들지 않고, 이후 지형을 변형할 잠재 구조로만 먼저 배치한다. */
export function createTectonicPlatePlan(settings: GeneratorSettings): TectonicPlatePlan {
  const random = mulberry32(settings.seed + 8_341_919);
  const plateCount = estimatedPlateCount(settings);
  const majorCount = Math.max(1, Math.min(plateCount, Math.round(14 / 52 * plateCount)));
  const mediumCount = Math.max(1, Math.min(plateCount - majorCount, Math.round(0.34 * plateCount)));
  const plates: Plate[] = Array.from({ length: plateCount }, (_, index) => {
    const angle = random() * Math.PI * 2;
    const tier: Plate["tier"] = index < majorCount ? "major" : index < majorCount + mediumCount ? "medium" : "micro";
    const radiusBase = tier === "major" ? 1.65 : tier === "medium" ? 1 : 0.58;
    return {
      x: 0.025 + random() * 0.95,
      y: 0.025 + random() * 0.95,
      vx: Math.cos(angle) * (0.25 + random() * 0.75),
      vy: Math.sin(angle) * (0.25 + random() * 0.75),
      continental: false,
      uplift: 0.6 + random() * 0.8,
      radius: radiusBase * (0.78 + random() * 0.48),
      tier,
    };
  });
  return { plates };
}

/** 1차 지형이 만들어진 뒤 각 판의 육지 비율을 보고 대륙판·해양판 성격을 조정한다. */
export function reconcileTectonicPlatePlan(plan: TectonicPlatePlan, landMask: number[], width: number, height: number): TectonicPlatePlan {
  const samples = plan.plates.map(() => ({ land: 0, total: 0 }));
  const aspect = width / Math.max(1, height);
  const stride = Math.max(1, Math.floor(Math.min(width, height) / 128));
  for (let y = 0; y < height; y += stride) for (let x = 0; x < width; x += stride) {
    const nx = x / Math.max(1, width - 1);
    const ny = y / Math.max(1, height - 1);
    let nearest = 0; let distance = Number.POSITIVE_INFINITY;
    for (let i = 0; i < plan.plates.length; i += 1) {
      const plate = plan.plates[i];
      const d = Math.hypot((nx - plate.x) * aspect, ny - plate.y) / Math.max(0.18, plate.radius);
      if (d < distance) { distance = d; nearest = i; }
    }
    samples[nearest].total += 1;
    if ((landMask[y * width + x] ?? 0) >= 0.5) samples[nearest].land += 1;
  }
  return {
    plates: plan.plates.map((plate, index) => ({
      ...plate,
      continental: samples[index].total > 0 && samples[index].land / samples[index].total >= 0.34,
    })),
  };
}

/** 판 경계는 완성된 1차 고도장에 융기·침강·단층 변형으로 2차 개입한다. */
export function applyTectonicDeformation(
  values: number[], width: number, height: number, settings: GeneratorSettings, plan: TectonicPlatePlan, landMask: number[],
): number[] {
  if (plan.plates.length < 2) return values;
  const result = [...values];
  const aspect = width / Math.max(1, height);
  const activity = 0.22 + settings.mountainStrength * 0.48;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const index = y * width + x;
    const nx = x / Math.max(1, width - 1);
    const ny = y / Math.max(1, height - 1);
    let nearestIndex = 0; let secondIndex = 1;
    let nearestDistance = Number.POSITIVE_INFINITY; let secondDistance = Number.POSITIVE_INFINITY;
    for (let i = 0; i < plan.plates.length; i += 1) {
      const plate = plan.plates[i];
      const d = Math.hypot((nx - plate.x) * aspect, ny - plate.y) / Math.max(0.18, plate.radius);
      if (d < nearestDistance) { secondDistance = nearestDistance; secondIndex = nearestIndex; nearestDistance = d; nearestIndex = i; }
      else if (d < secondDistance) { secondDistance = d; secondIndex = i; }
    }
    const a = plan.plates[nearestIndex]; const b = plan.plates[secondIndex];
    const normalX = b.x - a.x; const normalY = b.y - a.y;
    const length = Math.max(1e-6, Math.hypot(normalX, normalY));
    const relativeMotion = ((a.vx - b.vx) * normalX + (a.vy - b.vy) * normalY) / length;
    const boundary = Math.exp(-Math.abs(secondDistance - nearestDistance) * 78);
    const convergence = Math.max(0, relativeMotion);
    const divergence = Math.max(0, -relativeMotion);
    const collision = a.continental && b.continental ? 1.18 : a.continental !== b.continental ? 0.86 : 0.42;
    const onLand = (landMask[index] ?? 0) >= 0.5;
    const transform = Math.abs((a.vx - b.vx) * (-normalY / length) + (a.vy - b.vy) * (normalX / length));
    const roughness = (fractalPerlinNoise(nx * 16, ny * 16, settings.seed + 43_071, 3, 0.5, 2.04) - 0.5);
    let delta = boundary * activity * (convergence * collision * (onLand ? 0.34 : 0.13) - divergence * (onLand ? 0.16 : 0.24));
    delta += boundary * transform * roughness * 0.055;
    result[index] = clamp(result[index] + delta, -2, 2);
  }
  return result;
}


function thermalErode(values: Float64Array, width: number, height: number, iterations: number, strength: number): Float64Array {
  let current = values;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const next = new Float64Array(current);
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const index = y * width + x;
        let lowest = index;
        let lowestValue = current[index];
        for (let oy = -1; oy <= 1; oy += 1) {
          for (let ox = -1; ox <= 1; ox += 1) {
            if (ox === 0 && oy === 0) continue;
            const neighbor = (y + oy) * width + x + ox;
            if (current[neighbor] < lowestValue) {
              lowestValue = current[neighbor];
              lowest = neighbor;
            }
          }
        }
        const difference = current[index] - lowestValue;
        const talus = 0.035;
        if (lowest !== index && difference > talus) {
          const transfer = (difference - talus) * strength;
          next[index] -= transfer;
          next[lowest] += transfer;
        }
      }
    }
    current = next;
  }
  return current;
}

function hydraulicErode(values: Float64Array, width: number, height: number, iterations: number, strength: number): Float64Array {
  let current = values;
  const directions = [-width - 1, -width, -width + 1, -1, 1, width - 1, width, width + 1];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const order = Array.from({ length: current.length }, (_, index) => index).sort((a, b) => current[b] - current[a]);
    const flow = new Float64Array(current.length); flow.fill(1);
    const receiver = new Int32Array(current.length); receiver.fill(-1);
    for (const index of order) {
      const x = index % width; const y = Math.floor(index / width);
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) continue;
      let best = index; let bestValue = current[index];
      for (const offset of directions) {
        const candidate = index + offset;
        if (current[candidate] < bestValue) { bestValue = current[candidate]; best = candidate; }
      }
      if (best !== index) receiver[index] = best;
    }
    for (const index of order) {
      const target = receiver[index];
      if (target >= 0) flow[target] += flow[index];
    }
    const next = new Float64Array(current);
    const scale = Math.max(1, width * height);
    for (const index of order) {
      const target = receiver[index];
      if (target < 0) continue;
      const slope = Math.max(0, current[index] - current[target]);
      if (slope <= 0) continue;
      const erosion = Math.min(slope * 0.18, Math.log1p(flow[index]) / Math.log(scale) * strength * 0.025);
      next[index] -= erosion;
      next[target] += erosion * 0.28;
    }
    current = next;
  }
  return current;
}

export function createGeologicalRaw(
  settings: GeneratorSettings,
  width: number,
  height: number,
  quality: "preview" | "final",
): { raw: number[]; centers: Point[] } {
  const random = mulberry32(settings.seed + 8_341_919);
  // PB2002의 14개 대형판 + 38개 소형판을 지구 폭 40,075km의 기준점으로 사용한다.
  // 렌더 해상도는 판 수에 영향을 주지 않고, 논리적 지도 폭·면적이 커질 때만 판 수가 증가한다.
  // 지구 폭에서 약 52개가 되도록 보정하고, 세계 폭이 넓어질수록 판 수가 비선형적으로 증가한다.
  // 렌더 해상도 변경은 이 값에 영향을 주지 않는다.
  const plateCount = estimatedPlateCount(settings);
  const majorCount = Math.max(1, Math.min(plateCount, Math.round(14 / 52 * plateCount)));
  const mediumCount = Math.max(1, Math.min(plateCount - majorCount, Math.round(0.34 * plateCount)));
  const plates: Plate[] = Array.from({ length: plateCount }, (_, index) => {
    const angle = random() * Math.PI * 2;
    const tier: Plate["tier"] = index < majorCount ? "major" : index < majorCount + mediumCount ? "medium" : "micro";
    const radiusBase = tier === "major" ? 1.65 : tier === "medium" ? 1.0 : 0.58;
    return {
      x: 0.025 + random() * 0.95,
      y: 0.025 + random() * 0.95,
      vx: Math.cos(angle) * (0.25 + random() * 0.75),
      vy: Math.sin(angle) * (0.25 + random() * 0.75),
      continental: index < Math.max(settings.continentCount, Math.round(plateCount * 0.55)),
      uplift: 0.6 + random() * 0.8,
      radius: radiusBase * (0.78 + random() * 0.48),
      tier,
    };
  });
  const landform = createLandformField(settings, width, height, 8341919);
  const centers = landform.centers;

  const raw = new Float64Array(width * height);
  const aspect = width / height;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const nx0 = x / Math.max(1, width - 1);
      const ny0 = y / Math.max(1, height - 1);
      const warpScale = 0.07 + settings.continentDynamics * 0.1;
      const warpX = (fractalPerlinNoise(nx0 * 2.4, ny0 * 2.4, settings.seed + 101, 4, 0.55, 2.05) - 0.5) * warpScale;
      const warpY = (fractalPerlinNoise(nx0 * 2.4, ny0 * 2.4, settings.seed + 211, 4, 0.55, 2.05) - 0.5) * warpScale;
      const nx = nx0 + warpX;
      const ny = ny0 + warpY;

      const continent = landform.raw[y * width + x];

      let nearestIndex = 0; let secondIndex = 1;
      let nearestDistance = Number.POSITIVE_INFINITY; let secondDistance = Number.POSITIVE_INFINITY;
      for (let index = 0; index < plates.length; index += 1) {
        const plate = plates[index];
        const distance = Math.hypot((nx - plate.x) * aspect, ny - plate.y) / Math.max(0.18, plate.radius);
        if (distance < nearestDistance) {
          secondDistance = nearestDistance; secondIndex = nearestIndex;
          nearestDistance = distance; nearestIndex = index;
        } else if (distance < secondDistance) {
          secondDistance = distance; secondIndex = index;
        }
      }
      const a = plates[nearestIndex]; const b = plates[secondIndex];
      const normalX = b.x - a.x; const normalY = b.y - a.y;
      const normalLength = Math.max(1e-6, Math.hypot(normalX, normalY));
      const relativeMotion = ((a.vx - b.vx) * normalX + (a.vy - b.vy) * normalY) / normalLength;
      const boundary = Math.exp(-Math.abs(secondDistance - nearestDistance) * 95);
      const convergence = Math.max(0, relativeMotion) * boundary;
      const divergence = Math.max(0, -relativeMotion) * boundary;
      const continentalCollision = a.continental && b.continental ? 1.22 : a.continental !== b.continental ? 0.92 : 0.46;
      const tectonic = convergence * continentalCollision * (0.42 + settings.mountainStrength * 0.8) * ((a.uplift + b.uplift) / 2)
        - divergence * (0.18 + settings.coastlineDetail * 0.16);

      // 판 경계가 거시 골자를 담당하고, 다중 옥타브 펄린이 판 내부의 평원·구릉·분지를 보완한다.
      const boundaryPreservation = 1 - Math.min(0.82, boundary * 0.74);
      const broadNoise = (fractalPerlinNoise(nx * 2.6, ny * 2.6, settings.seed + 701, 5, 0.54, 2.01) - 0.5) * 0.58 * settings.noiseStrength;
      const mediumNoise = (fractalPerlinNoise(nx * 7.2, ny * 7.2, settings.seed + 1171, 4, 0.5, 2.08) - 0.5) * 0.24 * settings.noiseStrength;
      const fineNoise = (fractalNoise(nx * 18, ny * 18, settings.seed + 1709, 4, 0.46, 2.15) - 0.5) * (0.12 + settings.coastlineDetail * 0.26) * settings.noiseStrength;
      const interiorDetail = (broadNoise + mediumNoise + fineNoise) * boundaryPreservation;
      raw[y * width + x] = clamp(continent + interiorDetail + tectonic, -2, 2);
    }
  }

  // v0.99d: 판 구조는 지도의 골자만 만든다. 풍화·침식은 모든 골자 알고리즘에 공통 적용한다.
  void quality;
  return { raw: Array.from(raw), centers };
}

export function applyCommonWeathering(
  values: number[],
  width: number,
  height: number,
  settings: GeneratorSettings,
  quality: "preview" | "final",
): number[] {
  if (settings.erosion <= 0.001) return values;
  const source = Float64Array.from(values);
  const thermalIterations = quality === "final" ? Math.round(2 + settings.erosion * 10) : Math.round(1 + settings.erosion * 2);
  const hydraulicIterations = quality === "final" ? Math.round(settings.erosion * 4) : settings.erosion > 0.65 ? 1 : 0;
  let result = thermalErode(source, width, height, thermalIterations, 0.08 + settings.erosion * 0.12);
  if (hydraulicIterations > 0) result = hydraulicErode(result, width, height, hydraulicIterations, 0.3 + settings.erosion * 0.7);
  return Array.from(result);
}
