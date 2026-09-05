import type { GeneratorSettings, Point, WaterType } from "../model/world";
import { fractalNoise, fractalPerlinNoise } from "./noise";
import { segmentDistance } from "./pathGeometry";
import { smoothPath } from "./pathSmoothing";
import { mulberry32 } from "./random";

const clamp = (value: number, min = 0, max = 1) =>
  Math.max(min, Math.min(max, value));

function boundaryKindAt(
  settings: GeneratorSettings,
  side: "north" | "east" | "south" | "west",
  offset: number,
): "land" | "water" {
  const type = settings.localRegionType;
  if (type === "inland" || type === "mountain" || type === "river")
    return "land";
  if (type === "island" || type === "archipelago") return "water";
  const boundary = settings.localBoundary;
  const hasAnyLand = (["north", "east", "south", "west"] as const).some(
    (edge) =>
      (boundary?.[edge] ?? []).some((segment) => segment.kind === "land"),
  );
  if (type === "coast" && !hasAnyLand && side === "north") return "land";
  const segments = boundary?.[side] ?? [
    {
      start: 0,
      end: 1,
      kind: side === "south" ? ("water" as const) : ("land" as const),
    },
  ];
  const clamped = clamp(offset);
  const segment = segments.find(
    (item) =>
      clamped >= Math.min(item.start, item.end) &&
      clamped <= Math.max(item.start, item.end),
  );
  return segment?.kind ?? "land";
}

export function enforceLocalBoundaryWaterTypes(
  waterTypeMap: WaterType[],
  width: number,
  height: number,
  settings: GeneratorSettings,
): void {
  if (settings.mapScope !== "local" && settings.mapScope !== "regional")
    return;
  const set = (index: number, kind: "land" | "water") => {
    waterTypeMap[index] = kind === "land" ? "land" : "saltwater";
  };
  for (let x = 0; x < width; x += 1) {
    const t = x / Math.max(1, width - 1);
    set(x, boundaryKindAt(settings, "north", t));
    set((height - 1) * width + x, boundaryKindAt(settings, "south", t));
  }
  for (let y = 1; y < height - 1; y += 1) {
    const t = y / Math.max(1, height - 1);
    set(y * width, boundaryKindAt(settings, "west", t));
    set(y * width + width - 1, boundaryKindAt(settings, "east", t));
  }
}

function boundaryPoint(
  side: "north" | "east" | "south" | "west",
  offset: number,
): Point {
  const t = clamp(offset);
  if (side === "north") return { x: t, y: 0 };
  if (side === "south") return { x: t, y: 1 };
  if (side === "west") return { x: 0, y: t };
  return { x: 1, y: t };
}

export function guidedNormalizedPath(
  guide: GeneratorSettings["mountainGuide"] | GeneratorSettings["riverGuide"],
  seed: number,
): Point[] {
  if (guide.mode === "drawn" && guide.path.length >= 2)
    return smoothPath(
      guide.path.map((point) => ({ x: clamp(point.x), y: clamp(point.y) })),
      {
        samplesPerSegment: 5,
        iterations: 1,
      },
    );
  const start = boundaryPoint(guide.startSide, guide.startOffset);
  const end = boundaryPoint(guide.endSide, guide.endOffset);
  const random = mulberry32((seed + 0x9e3779b9) >>> 0);
  const points: Point[] = [start];
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.max(1e-6, Math.hypot(dx, dy));
  const px = -dy / length;
  const py = dx / length;
  const count = 7;
  for (let index = 1; index < count - 1; index += 1) {
    const t = index / (count - 1);
    const envelope = Math.sin(Math.PI * t);
    const wobble =
      (random() - 0.5) * (0.12 + guide.branchiness * 0.1) * envelope;
    points.push({
      x: clamp(start.x + dx * t + px * wobble),
      y: clamp(start.y + dy * t + py * wobble),
    });
  }
  points.push(end);
  return smoothPath(points, { samplesPerSegment: 6, iterations: 1 });
}

function distanceToNormalizedPath(
  nx: number,
  ny: number,
  path: Point[],
): number {
  let distance = Number.POSITIVE_INFINITY;
  for (let index = 1; index < path.length; index += 1) {
    distance = Math.min(
      distance,
      segmentDistance(nx, ny, path[index - 1], path[index]),
    );
  }
  return distance;
}

/**
 * 지방·지역 전용 생성기. 대륙 골격·판 구조·전역 해수면 판정 대신
 * 경계의 육지/수역 조건과 사용자가 지정한 산맥·강 중추선을 직접 제약으로 사용한다.
 */
export function generateBoundaryDrivenLocalTerrain(
  settings: GeneratorSettings,
  width: number,
  height: number,
): { normalized: number[]; landMask: number[]; centers: Point[] } {
  const size = width * height;
  const landMask = new Array<number>(size).fill(1);
  const random = mulberry32((settings.seed ^ 0x6d2b79f5) >>> 0);
  const type = settings.localRegionType;
  const mountainPath =
    type === "mountain"
      ? guidedNormalizedPath(settings.mountainGuide, settings.seed + 711)
      : [];
  const riverPath =
    type === "river"
      ? guidedNormalizedPath(settings.riverGuide, settings.seed + 997)
      : [];
  const islandCount =
    type === "island"
      ? 1
      : Math.max(2, Math.min(64, Math.round(settings.islandCount || 6)));
  const islandSeeds = Array.from({ length: islandCount }, (_value, index) => ({
    x:
      type === "island"
        ? 0.5 + (random() - 0.5) * 0.08
        : 0.12 + random() * 0.76,
    y:
      type === "island"
        ? 0.5 + (random() - 0.5) * 0.08
        : 0.12 + random() * 0.76,
    rx: type === "island" ? 0.31 + random() * 0.08 : 0.055 + random() * 0.13,
    ry: type === "island" ? 0.25 + random() * 0.08 : 0.045 + random() * 0.12,
    angle: random() * Math.PI,
    weight: 0.86 + random() * 0.28 + index * 0.0001,
  }));

  const boundarySamples: Array<{ x: number; y: number; sign: number }> = [];
  if (type === "coast") {
    const sampleCount = 48;
    for (let index = 0; index <= sampleCount; index += 1) {
      const t = index / sampleCount;
      boundarySamples.push({
        x: t,
        y: 0,
        sign: boundaryKindAt(settings, "north", t) === "land" ? 1 : -1,
      });
      boundarySamples.push({
        x: t,
        y: 1,
        sign: boundaryKindAt(settings, "south", t) === "land" ? 1 : -1,
      });
      boundarySamples.push({
        x: 0,
        y: t,
        sign: boundaryKindAt(settings, "west", t) === "land" ? 1 : -1,
      });
      boundarySamples.push({
        x: 1,
        y: t,
        sign: boundaryKindAt(settings, "east", t) === "land" ? 1 : -1,
      });
    }
  }

  for (let y = 0; y < height; y += 1) {
    const ny = y / Math.max(1, height - 1);
    for (let x = 0; x < width; x += 1) {
      const nx = x / Math.max(1, width - 1);
      const index = y * width + x;
      const broad =
        (fractalPerlinNoise(
          nx * 2.2,
          ny * 2.2,
          settings.seed + 31_901,
          5,
          0.56,
          2.02,
        ) -
          0.5) *
        0.2;
      const medium =
        (fractalNoise(
          nx * 8.4,
          ny * 8.4,
          settings.seed + 71_227,
          4,
          0.52,
          2.05,
        ) -
          0.5) *
        0.09;
      let landScore = 1.1 + broad + medium;

      if (type === "coast") {
        const detail = clamp(
          settings.coastlineDetail * 0.8 + settings.noiseStrength * 0.35,
          0,
          1.35,
        );
        const warpX =
          (fractalPerlinNoise(
            nx * 2.7,
            ny * 2.7,
            settings.seed + 91_031,
            4,
            0.56,
            2.01,
          ) -
            0.5) *
          0.205 *
          detail;
        const warpY =
          (fractalPerlinNoise(
            nx * 2.7 + 19.4,
            ny * 2.7 - 7.2,
            settings.seed + 91_037,
            4,
            0.56,
            2.01,
          ) -
            0.5) *
          0.205 *
          detail;
        const wx = clamp(nx + warpX);
        const wy = clamp(ny + warpY);
        let weighted = 0;
        let totalWeight = 0;
        for (const sample of boundarySamples) {
          const distanceSquared =
            (wx - sample.x) ** 2 + (wy - sample.y) ** 2;
          const weight = 1 / (0.0015 + distanceSquared * 8.4);
          weighted += sample.sign * weight;
          totalWeight += weight;
        }
        const largeBays =
          (fractalPerlinNoise(
            wx * 3.4,
            wy * 3.4,
            settings.seed + 102_211,
            5,
            0.57,
            2.02,
          ) -
            0.5) *
          0.44 *
          detail;
        const capes =
          (fractalNoise(
            wx * 11.5,
            wy * 11.5,
            settings.seed + 102_223,
            4,
            0.53,
            2.07,
          ) -
            0.5) *
          0.265 *
          detail;
        const fineCoast =
          (fractalNoise(
            wx * 31,
            wy * 31,
            settings.seed + 102_229,
            3,
            0.48,
            2.13,
          ) -
            0.5) *
          0.085 *
          detail;
        landScore =
          weighted / Math.max(1e-6, totalWeight) +
          broad * 1.15 +
          largeBays +
          capes +
          fineCoast +
          0.1;
      } else if (type === "island" || type === "archipelago") {
        let islandSignal = -1;
        for (const seed of islandSeeds) {
          const cosine = Math.cos(seed.angle);
          const sine = Math.sin(seed.angle);
          const dx = nx - seed.x;
          const dy = ny - seed.y;
          const rx = (dx * cosine + dy * sine) / seed.rx;
          const ry = (-dx * sine + dy * cosine) / seed.ry;
          const radial = Math.sqrt(rx * rx + ry * ry);
          const warp =
            (fractalNoise(
              nx * 11 + seed.x * 7,
              ny * 11 + seed.y * 7,
              settings.seed + 52_111,
              3,
              0.54,
              2.08,
            ) -
              0.5) *
            0.38;
          islandSignal = Math.max(islandSignal, seed.weight - radial + warp);
        }
        landScore = islandSignal;
      }

      if (type === "mountain") {
        const distance = distanceToNormalizedPath(nx, ny, mountainPath);
        const ridgeWidth = Math.max(
          0.025,
          settings.mountainGuide.width || 0.12,
        );
        landScore +=
          Math.exp(-(distance * distance) / (ridgeWidth * ridgeWidth)) * 0.42;
      }
      if (type === "river") {
        const distance = distanceToNormalizedPath(nx, ny, riverPath);
        const channelWidth = Math.max(
          0.008,
          settings.riverGuide.width || 0.045,
        );
        landScore -=
          Math.exp(-(distance * distance) / (channelWidth * channelWidth)) *
          0.18;
      }

      landMask[index] = landScore >= 0 ? 1 : 0;
    }
  }

  for (let x = 0; x < width; x += 1) {
    const t = x / Math.max(1, width - 1);
    landMask[x] = boundaryKindAt(settings, "north", t) === "land" ? 1 : 0;
    landMask[(height - 1) * width + x] =
      boundaryKindAt(settings, "south", t) === "land" ? 1 : 0;
  }
  for (let y = 0; y < height; y += 1) {
    const t = y / Math.max(1, height - 1);
    landMask[y * width] =
      boundaryKindAt(settings, "west", t) === "land" ? 1 : 0;
    landMask[y * width + width - 1] =
      boundaryKindAt(settings, "east", t) === "land" ? 1 : 0;
  }

  if (type === "island" || type === "archipelago") {
    for (let x = 0; x < width; x += 1) {
      landMask[x] = 0;
      landMask[(height - 1) * width + x] = 0;
    }
    for (let y = 0; y < height; y += 1) {
      landMask[y * width] = 0;
      landMask[y * width + width - 1] = 0;
    }
  }

  const normalized = new Array<number>(size);
  for (let index = 0; index < size; index += 1) {
    const x = index % width;
    const y = Math.floor(index / width);
    const nx = x / Math.max(1, width - 1);
    const ny = y / Math.max(1, height - 1);
    const relief =
      (fractalPerlinNoise(
        nx * 4.6,
        ny * 4.6,
        settings.seed + 8_809,
        5,
        0.54,
        2.03,
      ) -
        0.5) *
      0.22;
    if (landMask[index]) {
      let value = 0.59 + relief;
      if (type === "mountain") {
        const d = distanceToNormalizedPath(nx, ny, mountainPath);
        const w = Math.max(0.025, settings.mountainGuide.width || 0.12);
        value += Math.exp(-(d * d) / (w * w)) * 0.34;
      }
      if (type === "river") {
        const d = distanceToNormalizedPath(nx, ny, riverPath);
        const w = Math.max(0.008, settings.riverGuide.width || 0.045);
        value -= Math.exp(-(d * d) / (w * w)) * 0.12;
      }
      normalized[index] = clamp(value, 0.505, 0.98);
    } else {
      normalized[index] = clamp(0.37 + relief * 0.45, 0.04, 0.495);
    }
  }
  return {
    normalized,
    landMask,
    centers: islandSeeds.map((seed) => ({
      x: seed.x * width,
      y: seed.y * height,
    })),
  };
}
