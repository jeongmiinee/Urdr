import type { GeneratorSettings, Point } from "../model/world";
import { fractalNoise } from "./noise";
import { mulberry32 } from "./random";

const clamp = (value: number, min = -3, max = 3) => Math.max(min, Math.min(max, value));

type Kernel = Point & { rx: number; ry: number; angle: number; weight: number };
type Bridge = { a: Point; b: Point; width: number; weight: number };

function distanceToSegment(px: number, py: number, a: Point, b: Point): number {
  const abx = b.x - a.x; const aby = b.y - a.y;
  const lengthSquared = abx * abx + aby * aby;
  if (lengthSquared <= 1e-9) return Math.hypot(px - a.x, py - a.y);
  const t = Math.max(0, Math.min(1, ((px - a.x) * abx + (py - a.y) * aby) / lengthSquared));
  return Math.hypot(px - (a.x + abx * t), py - (a.y + aby * t));
}

function makeCluster(random: () => number, center: Point, count: number, spread: number, size: number): Kernel[] {
  const kernels: Kernel[] = [];
  for (let index = 0; index < count; index += 1) {
    const angle = random() * Math.PI * 2;
    const radius = index === 0 ? 0 : spread * (0.25 + random() * 0.75);
    kernels.push({
      x: center.x + Math.cos(angle) * radius,
      y: center.y + Math.sin(angle) * radius * 0.72,
      rx: size * (0.72 + random() * 0.62),
      ry: size * (0.48 + random() * 0.55),
      angle: (random() - 0.5) * Math.PI,
      weight: 0.92 + random() * 0.24,
    });
  }
  return kernels;
}

function layoutCenters(settings: GeneratorSettings, random: () => number): Point[] {
  const count = Math.max(1, Math.round(settings.continentCount));
  if (["island", "volcanic_island", "closed", "supercontinent", "inland_sea"].includes(settings.mapShape)) {
    return [{ x: 0.5 + (random() - 0.5) * 0.06, y: 0.5 + (random() - 0.5) * 0.05 }];
  }
  if (settings.mapShape === "continent") return [{ x: 0.5 + (random() - 0.5) * 0.13, y: 0.5 + (random() - 0.5) * 0.1 }];
  const columns = Math.max(1, Math.ceil(Math.sqrt(count * 1.45)));
  const rows = Math.max(1, Math.ceil(count / columns));
  const slots = Array.from({ length: columns * rows }, (_, index) => index);
  for (let index = slots.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [slots[index], slots[swap]] = [slots[swap], slots[index]];
  }
  return slots.slice(0, count).map((slot) => ({
    x: ((slot % columns) + 0.5 + (random() - 0.5) * 0.35) / columns,
    y: (Math.floor(slot / columns) + 0.5 + (random() - 0.5) * 0.35) / rows,
  }));
}

export function createLandformField(
  settings: GeneratorSettings,
  width: number,
  height: number,
  seedOffset = 0,
): { raw: number[]; centers: Point[] } {
  const random = mulberry32(settings.seed + seedOffset + 3_071_913);
  const centers = layoutCenters(settings, random);
  const kernels: Kernel[] = [];
  const bridges: Bridge[] = [];
  const preset = settings.mapShape;

  if (preset === "island" || preset === "volcanic_island") {
    kernels.push(...makeCluster(random, centers[0], preset === "volcanic_island" ? 2 : 4, 0.08, preset === "volcanic_island" ? 0.31 : 0.26));
  } else if (preset === "closed") {
    kernels.push(...makeCluster(random, centers[0], 5, 0.2, 0.25));
  } else if (preset === "continent") {
    kernels.push(...makeCluster(random, centers[0], 7, 0.25, 0.22));
  } else if (preset === "supercontinent" || preset === "inland_sea") {
    kernels.push(...makeCluster(random, centers[0], 10, 0.31, 0.22));
  } else if (preset === "archipelago") {
    for (const center of centers) kernels.push(...makeCluster(random, center, 6 + Math.round(random() * 4), 0.2, 0.075 + random() * 0.045));
  } else {
    for (const center of centers) kernels.push(...makeCluster(random, center, 4 + Math.round(random() * 3), 0.13, 0.14 + settings.landRatio * 0.09));
  }

  // 가까운 핵 사이에 완만한 육교를 만들어 칼로 자른 듯한 분절을 줄인다.
  for (let index = 0; index < kernels.length; index += 1) {
    let nearest = -1; let nearestDistance = Number.POSITIVE_INFINITY;
    for (let candidate = 0; candidate < kernels.length; candidate += 1) {
      if (candidate === index) continue;
      const distance = Math.hypot(kernels[index].x - kernels[candidate].x, kernels[index].y - kernels[candidate].y);
      if (distance < nearestDistance) { nearestDistance = distance; nearest = candidate; }
    }
    if (nearest >= 0 && nearestDistance < (preset === "archipelago" ? 0.12 : 0.28)) {
      bridges.push({ a: kernels[index], b: kernels[nearest], width: preset === "archipelago" ? 0.018 : 0.045, weight: 0.48 });
    }
  }

  // Random Walk 개념을 독자 구현한 길쭉한 육지 골격. 군도·대륙 프리셋의 다양화에만 사용한다.
  const walkPoints: Point[] = [];
  if (["archipelago", "continent", "supercontinent"].includes(preset)) {
    let cursor = { ...centers[0] };
    let direction = random() * Math.PI * 2;
    const steps = preset === "archipelago" ? 18 : 11;
    for (let step = 0; step < steps; step += 1) {
      walkPoints.push({ ...cursor });
      direction += (random() - 0.5) * 0.9;
      cursor = {
        x: Math.max(0.08, Math.min(0.92, cursor.x + Math.cos(direction) * (0.025 + random() * 0.035))),
        y: Math.max(0.08, Math.min(0.92, cursor.y + Math.sin(direction) * (0.018 + random() * 0.03))),
      };
    }
  }

  const raw = new Array<number>(width * height).fill(-2);
  const aspect = width / height;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const nx0 = x / Math.max(1, width - 1);
      const ny0 = y / Math.max(1, height - 1);
      const warpStrength = 0.055 + settings.coastlineDetail * 0.145;
      const warpX = (fractalNoise(nx0 * 2.15, ny0 * 2.15, settings.seed + seedOffset + 101, 5, 0.55, 2.03) - 0.5) * warpStrength;
      const warpY = (fractalNoise(nx0 * 2.37, ny0 * 2.37, settings.seed + seedOffset + 211, 5, 0.55, 2.07) - 0.5) * warpStrength;
      const nx = nx0 + warpX;
      const ny = ny0 + warpY;
      let field = -2;

      for (const kernel of kernels) {
        const dx = (nx - kernel.x) * aspect;
        const dy = ny - kernel.y;
        const cosine = Math.cos(kernel.angle); const sine = Math.sin(kernel.angle);
        const ex = (dx * cosine + dy * sine) / kernel.rx;
        const ey = (-dx * sine + dy * cosine) / kernel.ry;
        const edge = (1 - Math.sqrt(ex * ex + ey * ey)) * kernel.weight;
        field = Math.max(field, edge);
      }
      for (const bridge of bridges) {
        const distance = distanceToSegment(nx * aspect, ny, { x: bridge.a.x * aspect, y: bridge.a.y }, { x: bridge.b.x * aspect, y: bridge.b.y });
        field = Math.max(field, bridge.weight - distance / bridge.width);
      }
      for (const walk of walkPoints) {
        const distance = Math.hypot((nx - walk.x) * aspect, ny - walk.y);
        field = Math.max(field, 0.42 - distance / (preset === "archipelago" ? 0.055 : 0.085));
      }

      const broad = (fractalNoise(nx * 3.4, ny * 3.4, settings.seed + seedOffset + 701, 5, 0.54, 2.03) - 0.5) * (0.46 + settings.coastlineDetail * 0.36);
      const medium = (fractalNoise(nx * 9.5, ny * 9.5, settings.seed + seedOffset + 1709, 4, 0.5, 2.11) - 0.5) * (0.14 + settings.coastlineDetail * 0.25);
      const fine = (fractalNoise(nx * 24.0, ny * 24.0, settings.seed + seedOffset + 2711, 3, 0.47, 2.19) - 0.5) * (0.035 + settings.coastlineDetail * 0.095);
      let value = field + broad + medium + fine;

      if (["island", "volcanic_island", "closed"].includes(preset)) {
        const edge = Math.min(nx0, ny0, 1 - nx0, 1 - ny0);
        value -= Math.max(0, 0.1 - edge) * 7.5;
      }
      if (preset === "inland_sea") {
        const dx = (nx - 0.52) / 0.2; const dy = (ny - 0.48) / 0.15;
        value -= Math.exp(-(dx * dx + dy * dy) * 1.7) * 1.15;
      }
      if (preset === "volcanic_island") {
        const distance = Math.hypot((nx - centers[0].x) * aspect, ny - centers[0].y);
        value += Math.exp(-distance * distance / 0.022) * 0.55;
      }
      raw[y * width + x] = clamp(value);
    }
  }
  return { raw, centers };
}

/**
 * 기하학적 육지 마스크를 signed distance field로 변환한다.
 * 양수는 육지 내부, 음수는 바다이며 해안선에서 0이 된다.
 */
export function createSignedDistanceField(
  settings: GeneratorSettings,
  width: number,
  height: number,
): { raw: number[]; centers: Point[] } {
  const source = createLandformField({ ...settings, noiseStrength: Math.min(settings.noiseStrength, 0.22) }, width, height, 91_337);
  const land = source.raw.map((value) => value >= 0);
  const inf = 1e9;
  const inside = new Float64Array(width * height);
  const outside = new Float64Array(width * height);
  inside.fill(inf); outside.fill(inf);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const current = land[index];
      let boundary = x === 0 || y === 0 || x === width - 1 || y === height - 1;
      if (!boundary) {
        boundary = land[index - 1] !== current || land[index + 1] !== current || land[index - width] !== current || land[index + width] !== current;
      }
      if (boundary) (current ? inside : outside)[index] = 0;
    }
  }
  const pass = (grid: Float64Array, reverse: boolean) => {
    const ys = reverse ? [...Array(height).keys()].reverse() : [...Array(height).keys()];
    const xs = reverse ? [...Array(width).keys()].reverse() : [...Array(width).keys()];
    for (const y of ys) for (const x of xs) {
      const index = y * width + x;
      let best = grid[index];
      const neighbors = reverse
        ? [[1,0,1],[0,1,1],[1,1,1.414],[-1,1,1.414]]
        : [[-1,0,1],[0,-1,1],[-1,-1,1.414],[1,-1,1.414]];
      for (const [dx,dy,cost] of neighbors) {
        const nx=x+dx, ny=y+dy;
        if (nx<0||ny<0||nx>=width||ny>=height) continue;
        best = Math.min(best, grid[ny*width+nx] + cost);
      }
      grid[index]=best;
    }
  };
  pass(inside,false); pass(inside,true); pass(outside,false); pass(outside,true);
  const scale = Math.max(4, Math.min(width,height) * (0.055 + settings.landRatio * 0.035));
  const raw = new Array<number>(width*height);
  for (let i=0;i<raw.length;i+=1) {
    const signed = land[i] ? inside[i] : -outside[i];
    raw[i] = clamp(signed / scale, -2, 2);
  }
  return { raw, centers: source.centers };
}
