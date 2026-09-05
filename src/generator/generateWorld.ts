import type {
  GeneratedContourSegment,
  GeneratedMapData,
  GeneratorSettings,
  LineSegment,
  Point,
  TerrainType,
  WaterType,
} from "../model/world";
import { fractalNoise, fractalPerlinNoise } from "./noise";
import { mulberry32 } from "./random";
import {
  applyCommonWeathering,
  applyTectonicDeformation,
  createTectonicPlatePlan,
  reconcileTectonicPlatePlan,
} from "./geological";
import { generateSkeleton } from "./skeletonAlgorithms";
import { calculateEnvironment } from "./environment";
import { chaikinPath, limitClosedPathCurvature, limitPathCurvature, resamplePath, smoothPath, stitchSegments } from "./pathSmoothing";
import { cellValuesToVertexValues, createGridTransform, nearestPowerOfTwo, normalizePowerOfTwo, sampleCellDerivedFieldAtWorld } from "./gridTransform";
import { buildSurfaceRegions, CURRENT_SURFACE_VECTOR_VERSION, surfaceBoundarySegments } from "./surfaceVectors";
import { landComponents } from "./gridComponents";
import { buildHydrology } from "./hydrology";
import { validateGeneratedResult } from "./generatedValidation";
import { classifyWaterBodies } from "./waterBodies";
import { generateCoastalTerrainTiles } from "./coastalTerrain";
import { refineTerrainWithWaterAccess } from "./terrainRefinement";
import {
  enforceLocalBoundaryWaterTypes,
  generateBoundaryDrivenLocalTerrain,
} from "./localBoundaryTerrain";
import { segmentDistance } from "./pathGeometry";
import {
  reconcileElevationWithWater,
  reconcileElevationWithWaterAndLakes,
  terrainWithoutSubmergedLand,
} from "./waterElevation";

const clamp = (value: number, min = 0, max = 1) =>
  Math.max(min, Math.min(max, value));

function terrainDetailScale(settings: GeneratorSettings): number {
  return clamp(Math.pow(Math.max(1, settings.mapScaleKm) / 450, 0.28), 0.8, 4.2);
}

export function effectiveReliefCeiling(settings: GeneratorSettings): number {
  return Math.max(settings.seaLevel + 1, settings.maxElevation);
}

function elevationNoiseAt(
  x: number,
  y: number,
  width: number,
  height: number,
  seed: number,
): number {
  const nx = x / Math.max(1, width - 1);
  const ny = y / Math.max(1, height - 1);
  const warpX = (fractalPerlinNoise(nx * 2.1, ny * 2.1, seed + 401, 3, 0.52, 2.03) - 0.5) * 0.24;
  const warpY = (fractalPerlinNoise(nx * 2.1, ny * 2.1, seed + 907, 3, 0.52, 2.03) - 0.5) * 0.24;
  const broad = fractalPerlinNoise((nx + warpX) * 3.4, (ny + warpY) * 3.4, seed + 1_603, 4, 0.54, 2.02) - 0.5;
  const detail = fractalPerlinNoise((nx + warpX * 0.35) * 11.5, (ny + warpY * 0.35) * 11.5, seed + 2_117, 4, 0.48, 2.08) - 0.5;
  return broad * 1.55 + detail * 0.45;
}

function buildElevationField(
  normalized: number[],
  landMask: number[],
  width: number,
  height: number,
  settings: GeneratorSettings,
): number[] {
  const seaLevel = settings.seaLevel;
  const maximum = effectiveReliefCeiling(settings);
  const configuredRange = Math.max(0, settings.elevationRangeM);
  const minimum = Math.min(seaLevel, maximum - configuredRange);
  const landRange = Math.max(1, maximum - seaLevel);
  const waterRange = Math.max(1, seaLevel - minimum);
  const noiseAmplitude = Math.max(1, configuredRange)
    * clamp(settings.elevationNoiseStrength)
    * 0.11;

  return normalized.map((value, index) => {
    const x = index % width;
    const y = Math.floor(index / width);
    const noise = elevationNoiseAt(x, y, width, height, settings.seed);
    const isLand = landMask[index] >= 0.5;
    if (!isLand) {
      const depth = clamp((0.5 - value) / 0.5);
      const base = seaLevel - waterRange * Math.pow(depth, 1.22);
      const coastalFade = Math.pow(depth, 0.55);
      return Math.round(clamp(base + noise * noiseAmplitude * 0.55 * coastalFade, minimum, seaLevel));
    }

    const relief = clamp((value - 0.5) / 0.5);
    const base = seaLevel + landRange * Math.pow(relief, 2.15);
    const coastFade = Math.pow(relief, 0.38);
    return Math.round(clamp(base + noise * noiseAmplitude * coastFade, seaLevel + 1, maximum));
  });
}

function smoothGrid(
  values: number[],
  width: number,
  height: number,
  iterations: number,
  blend: number,
): number[] {
  let current = [...values];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const next = [...current];
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const index = y * width + x;
        let sum = 0;
        let count = 0;
        for (let oy = -1; oy <= 1; oy += 1) {
          for (let ox = -1; ox <= 1; ox += 1) {
            if (ox === 0 && oy === 0) continue;
            sum += current[(y + oy) * width + x + ox];
            count += 1;
          }
        }
        next[index] = current[index] * (1 - blend) + (sum / count) * blend;
      }
    }
    current = next;
  }
  return current;
}

function rawShapeMetrics(
  values: number[],
  width: number,
  height: number,
  landRatio: number,
): { circularity: number; aspectRatio: number; compactness: number } {
  const sorted = [...values].sort((a, b) => a - b);
  const threshold =
    sorted[
      Math.max(
        0,
        Math.min(
          sorted.length - 1,
          Math.floor(sorted.length * (1 - landRatio)),
        ),
      )
    ] ?? 0;
  const land = values.map((value) => value > threshold);
  let area = 0;
  let perimeter = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (!land[index]) continue;
      area += 1;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (
          nx < 0 ||
          ny < 0 ||
          nx >= width ||
          ny >= height ||
          !land[ny * width + nx]
        )
          perimeter += 1;
      }
    }
  }
  const bboxWidth = Math.max(1, maxX - minX + 1);
  const bboxHeight = Math.max(1, maxY - minY + 1);
  return {
    circularity:
      area > 0 && perimeter > 0
        ? (4 * Math.PI * area) / (perimeter * perimeter)
        : 0,
    aspectRatio: Math.max(bboxWidth / bboxHeight, bboxHeight / bboxWidth),
    compactness: area / Math.max(1, bboxWidth * bboxHeight),
  };
}

/** 풍화 뒤 다시 둥글어진 대륙에 반도와 만을 추가해 최종 실루엣을 국소 보정한다. */
function repairPostWeatheringShape(
  values: number[],
  width: number,
  height: number,
  settings: GeneratorSettings,
  centers: Point[],
): number[] {
  if (
    (settings.mapScope !== "continent" && settings.mapScope !== "world") ||
    ["island", "volcanic_island", "archipelago"].includes(settings.mapShape)
  )
    return values;
  let current = [...values];
  const random = mulberry32(settings.seed + 4_912_037);
  const passes = Math.max(0, Math.round(settings.skeletonRepairPasses));
  for (let pass = 0; pass < passes; pass += 1) {
    const metrics = rawShapeMetrics(current, width, height, settings.landRatio);
    const tooRound =
      metrics.circularity > 0.34 &&
      metrics.aspectRatio < 1.34 &&
      metrics.compactness > 0.63;
    if (!tooRound) break;
    const center = centers[pass % Math.max(1, centers.length)] ?? {
      x: 0.5,
      y: 0.5,
    };
    const aspect = width / Math.max(1, height);
    const angle = random() * Math.PI * 2;
    const peninsulaEnd = {
      x: clamp(
        center.x + Math.cos(angle) * (0.3 + random() * 0.14),
        0.025,
        0.975,
      ),
      y: clamp(
        center.y + Math.sin(angle) * (0.22 + random() * 0.12),
        0.025,
        0.975,
      ),
    };
    const bayAngle = angle + Math.PI * (0.5 + random() * 0.35);
    const bayOuter = {
      x: clamp(
        center.x + Math.cos(bayAngle) * (0.31 + random() * 0.12),
        0.02,
        0.98,
      ),
      y: clamp(
        center.y + Math.sin(bayAngle) * (0.23 + random() * 0.1),
        0.02,
        0.98,
      ),
    };
    const range = Math.max(0.5, Math.max(...current) - Math.min(...current));
    const peninsulaWidth = 0.034 + random() * 0.014;
    const bayWidth = 0.027 + random() * 0.014;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = y * width + x;
        const nx = x / Math.max(1, width - 1);
        const ny = y / Math.max(1, height - 1);
        const peninsulaDistance = segmentDistance(
          nx * aspect,
          ny,
          { x: center.x * aspect, y: center.y },
          { x: peninsulaEnd.x * aspect, y: peninsulaEnd.y },
        );
        const bayDistance = segmentDistance(
          nx * aspect,
          ny,
          { x: bayOuter.x * aspect, y: bayOuter.y },
          { x: center.x * aspect, y: center.y },
        );
        current[index] +=
          Math.max(0, 1 - peninsulaDistance / peninsulaWidth) * range * 0.34;
        current[index] -= Math.max(0, 1 - bayDistance / bayWidth) * range * 0.3;
      }
    }
  }
  return current;
}

/** Adds coherent headlands, bays, islets, and volcanic basins before sea-level clipping. */
function addDynamicLandformStructure(
  values: number[],
  width: number,
  height: number,
  settings: GeneratorSettings,
): number[] {
  if (settings.mapScope === "local" || settings.mapScope === "regional") return values;
  const ordered = [...values].sort((a, b) => a - b);
  const threshold = ordered[Math.max(0, Math.min(ordered.length - 1, Math.floor(ordered.length * (1 - settings.landRatio))))] ?? 0;
  const land = Uint8Array.from(values, (value) => value >= threshold ? 1 : 0);
  let centerX = 0;
  let centerY = 0;
  let landCount = 0;
  const coast: Array<{ x: number; y: number }> = [];
  for (let y = 1; y < height - 1; y += 1) for (let x = 1; x < width - 1; x += 1) {
    const index = y * width + x;
    if (!land[index]) continue;
    centerX += x;
    centerY += y;
    landCount += 1;
    if (!land[index - 1] || !land[index + 1] || !land[index - width] || !land[index + width]) coast.push({ x, y });
  }
  if (landCount === 0 || coast.length < 8) return values;
  centerX /= landCount;
  centerY /= landCount;
  const random = mulberry32(settings.seed + 8_430_119);
  const detail = clamp(settings.coastlineDetail * 0.72 + settings.continentDynamics * 0.28, 0, 1.5);
  const scaleFeatures = Math.max(0, Math.log2(Math.max(250, settings.mapScaleKm) / 500));
  const featureCount = Math.max(3, Math.min(16, Math.round(3 + detail * 5 + scaleFeatures * 1.4)));
  const range = Math.max(0.25, ordered[ordered.length - 1] - ordered[0]);
  const aspect = width / Math.max(1, height);
  const output = [...values];
  const chosen: Array<{ x: number; y: number }> = [];

  for (let feature = 0; feature < featureCount; feature += 1) {
    let anchor = coast[Math.floor(random() * coast.length)] ?? coast[feature % coast.length];
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const candidate = coast[Math.floor(random() * coast.length)] ?? anchor;
      const separated = chosen.every((point) => Math.hypot((candidate.x - point.x) / width, (candidate.y - point.y) / height) > 0.075);
      if (separated) { anchor = candidate; break; }
    }
    chosen.push(anchor);
    const ax = anchor.x / Math.max(1, width - 1);
    const ay = anchor.y / Math.max(1, height - 1);
    let outwardX = anchor.x - centerX;
    let outwardY = anchor.y - centerY;
    const outwardLength = Math.max(1e-6, Math.hypot(outwardX, outwardY));
    outwardX /= outwardLength;
    outwardY /= outwardLength;
    const tangentX = -outwardY;
    const tangentY = outwardX;
    const reach = 0.028 + random() * (0.026 + detail * 0.018);
    const headlandEnd = {
      x: ax + outwardX * reach / aspect + tangentX * (random() - 0.5) * reach * 0.28 / aspect,
      y: ay + outwardY * reach + tangentY * (random() - 0.5) * reach * 0.28,
    };
    const baySide = random() < 0.5 ? -1 : 1;
    const bayStart = {
      x: ax + tangentX * baySide * reach * 0.82 / aspect,
      y: ay + tangentY * baySide * reach * 0.82,
    };
    const bayEnd = {
      x: bayStart.x - outwardX * reach * (0.7 + random() * 0.38) / aspect,
      y: bayStart.y - outwardY * reach * (0.7 + random() * 0.38),
    };
    const headlandWidth = 0.008 + random() * 0.01 + detail * 0.003;
    const bayWidth = 0.009 + random() * 0.012 + detail * 0.003;
    const island = feature % 3 === 0 ? {
      x: ax + outwardX * reach * 1.42 / aspect + tangentX * baySide * reach * 0.3 / aspect,
      y: ay + outwardY * reach * 1.42 + tangentY * baySide * reach * 0.3,
      radius: 0.007 + random() * 0.006,
    } : null;
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const nx = x / Math.max(1, width - 1);
      const ny = y / Math.max(1, height - 1);
      const headlandDistance = segmentDistance(
        nx * aspect, ny,
        { x: ax * aspect, y: ay },
        { x: headlandEnd.x * aspect, y: headlandEnd.y },
      );
      const bayDistance = segmentDistance(
        nx * aspect, ny,
        { x: bayStart.x * aspect, y: bayStart.y },
        { x: bayEnd.x * aspect, y: bayEnd.y },
      );
      const headland = Math.pow(Math.max(0, 1 - headlandDistance / headlandWidth), 1.7);
      const bay = Math.pow(Math.max(0, 1 - bayDistance / bayWidth), 1.55);
      output[index] += headland * range * (0.15 + detail * 0.055);
      output[index] -= bay * range * (0.14 + detail * 0.05);
      if (island) {
        const islandDistance = Math.hypot((nx - island.x) * aspect, ny - island.y);
        output[index] += Math.max(0, 1 - islandDistance / island.radius) * range * 0.19;
      }
    }
  }

  if (settings.mapShape === "volcanic_island") {
    const cx = centerX / Math.max(1, width - 1) + (random() - 0.5) * 0.035;
    const cy = centerY / Math.max(1, height - 1) + (random() - 0.5) * 0.035;
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
      const nx = x / Math.max(1, width - 1);
      const ny = y / Math.max(1, height - 1);
      const radius = Math.hypot((nx - cx) * aspect, ny - cy);
      const rim = Math.exp(-Math.pow((radius - 0.11) / 0.035, 2));
      const basin = Math.exp(-Math.pow(radius / 0.065, 2));
      output[y * width + x] += rim * range * 0.16 - basin * range * 0.24;
    }
  }
  return output;
}

function refineCoastlineCellular(
  values: number[],
  width: number,
  height: number,
  iterations: number,
): number[] {
  let land = values.map((value) => value >= 0.5);
  for (let pass = 0; pass < iterations; pass += 1) {
    const next = [...land];
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const index = y * width + x;
        let neighbors = 0;
        for (let oy = -1; oy <= 1; oy += 1) {
          for (let ox = -1; ox <= 1; ox += 1) {
            if (ox === 0 && oy === 0) continue;
            if (land[(y + oy) * width + x + ox]) neighbors += 1;
          }
        }
        if (land[index] && neighbors <= 2) next[index] = false;
        else if (!land[index] && neighbors >= 6) next[index] = true;
      }
    }
    land = next;
  }
  const reference = smoothGrid(values, width, height, 1, 0.22);
  return values.map((value, index) => {
    const wasLand = value >= 0.5;
    if (wasLand === land[index]) return value;
    return land[index]
      ? Math.max(0.505, reference[index], value)
      : Math.min(0.495, reference[index], value);
  });
}

function resampleRawGrid(
  values: number[],
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
): number[] {
  const result = new Array<number>(targetWidth * targetHeight);
  for (let y = 0; y < targetHeight; y += 1) {
    const sy =
      targetHeight <= 1 ? 0 : (y / (targetHeight - 1)) * (sourceHeight - 1);
    const y0 = Math.floor(sy);
    const y1 = Math.min(sourceHeight - 1, y0 + 1);
    const ty = sy - y0;
    for (let x = 0; x < targetWidth; x += 1) {
      const sx =
        targetWidth <= 1 ? 0 : (x / (targetWidth - 1)) * (sourceWidth - 1);
      const x0 = Math.floor(sx);
      const x1 = Math.min(sourceWidth - 1, x0 + 1);
      const tx = sx - x0;
      const top =
        values[y0 * sourceWidth + x0] * (1 - tx) +
        values[y0 * sourceWidth + x1] * tx;
      const bottom =
        values[y1 * sourceWidth + x0] * (1 - tx) +
        values[y1 * sourceWidth + x1] * tx;
      result[y * targetWidth + x] = top * (1 - ty) + bottom * ty;
    }
  }
  return result;
}

/**
 * Minecraft식 다중 해상도 원칙을 응용한다. 낮은 해상도에서 대륙의 연결 구조를 정한 뒤
 * 2배 안팎으로 확대하며 경계 흔들기와 주변 평균을 섞는다. 최종 격자에서 새 대륙을
 * 다시 뽑지 않으므로 해상도가 달라져도 세계의 큰 골격은 유지된다.
 */
function progressivelyRefineSkeleton(
  raw: number[],
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
  settings: GeneratorSettings,
): number[] {
  let current = raw;
  let width = sourceWidth;
  let height = sourceHeight;
  let stage = 0;
  while (width !== targetWidth || height !== targetHeight) {
    const nextWidth = Math.min(
      targetWidth,
      Math.max(width + 1, Math.min(targetWidth, width * 2)),
    );
    const nextHeight = Math.min(
      targetHeight,
      Math.max(
        height + 1,
        Math.min(targetHeight, Math.round((height * nextWidth) / width)),
      ),
    );
    const expanded = resampleRawGrid(
      current,
      width,
      height,
      nextWidth,
      nextHeight,
    );
    const detailScale = terrainDetailScale(settings);
    const amplitude =
      (0.105 + settings.coastlineDetail * 0.085) * Math.pow(0.62, stage);
    for (let y = 0; y < nextHeight; y += 1)
      for (let x = 0; x < nextWidth; x += 1) {
        const index = y * nextWidth + x;
        const broadBoundaryNoise =
          fractalPerlinNoise(
            x / Math.max(5, nextWidth / ((9 + stage * 4) * Math.sqrt(detailScale))),
            y / Math.max(5, nextHeight / ((9 + stage * 4) * Math.sqrt(detailScale))),
            settings.seed + 70_013 + stage * 977,
            4,
            0.56,
            2.03,
          ) - 0.5;
        const regionalBoundaryNoise =
          fractalPerlinNoise(
            x / Math.max(4, nextWidth / ((19 + stage * 7) * Math.sqrt(detailScale))),
            y / Math.max(4, nextHeight / ((19 + stage * 7) * Math.sqrt(detailScale))),
            settings.seed + 170_021 + stage * 1_013,
            3,
            0.5,
            2.11,
          ) - 0.5;
        const boundaryNoise = broadBoundaryNoise * 0.74 + regionalBoundaryNoise * 0.26;
        expanded[index] += boundaryNoise * amplitude * settings.noiseStrength;
      }
    current = smoothGrid(
      expanded,
      nextWidth,
      nextHeight,
      1,
      0.08 + settings.coastSmoothness * 0.05,
    );
    width = nextWidth;
    height = nextHeight;
    stage += 1;
  }
  return current;
}

function oceanDistance(
  elevation: number[],
  width: number,
  height: number,
  seaLevel = 0,
): number[] {
  const distances = new Array<number>(width * height).fill(
    Number.POSITIVE_INFINITY,
  );
  const queue = new Int32Array(width * height);
  let head = 0;
  let tail = 0;
  for (let index = 0; index < elevation.length; index += 1) {
    if (elevation[index] <= seaLevel) {
      distances[index] = 0;
      queue[tail++] = index;
    }
  }
  const directions = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const;
  while (head < tail) {
    const index = queue[head++];
    const x = index % width;
    const y = Math.floor(index / width);
    for (const [dx, dy] of directions) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const next = ny * width + nx;
      if (distances[next] > distances[index] + 1) {
        distances[next] = distances[index] + 1;
        queue[tail++] = next;
      }
    }
  }
  return distances;
}

function interpolatePoint(
  x1: number,
  y1: number,
  value1: number,
  x2: number,
  y2: number,
  value2: number,
  level: number,
): Point {
  const denominator = value2 - value1;
  const t =
    Math.abs(denominator) < 1e-8 ? 0.5 : clamp((level - value1) / denominator);
  return { x: x1 + (x2 - x1) * t, y: y1 + (y2 - y1) * t };
}

function extractSegments(
  values: number[],
  width: number,
  height: number,
  level: number,
  worldWidth: number,
  worldHeight: number,
): LineSegment[] {
  const segments: LineSegment[] = [];
  const vertexValues = cellValuesToVertexValues(values, width, height);
  const vertexWidth = width + 1;
  const transform = createGridTransform(worldWidth, worldHeight, width, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const tl = vertexValues[y * vertexWidth + x];
      const tr = vertexValues[y * vertexWidth + x + 1];
      const br = vertexValues[(y + 1) * vertexWidth + x + 1];
      const bl = vertexValues[(y + 1) * vertexWidth + x];
      const intersections: Point[] = [];
      if (tl < level !== tr < level)
        intersections.push(interpolatePoint(x, y, tl, x + 1, y, tr, level));
      if (tr < level !== br < level)
        intersections.push(interpolatePoint(x + 1, y, tr, x + 1, y + 1, br, level));
      if (br < level !== bl < level)
        intersections.push(interpolatePoint(x + 1, y + 1, br, x, y + 1, bl, level));
      if (bl < level !== tl < level)
        intersections.push(interpolatePoint(x, y + 1, bl, x, y, tl, level));
      const add = (a: Point, b: Point) => segments.push({
        start: transform.cellBoundaryToWorld(a.x, a.y),
        end: transform.cellBoundaryToWorld(b.x, b.y),
      });
      if (intersections.length === 2) add(intersections[0], intersections[1]);
      else if (intersections.length === 4) {
        const center = (tl + tr + br + bl) / 4;
        if (center >= level) {
          add(intersections[0], intersections[3]);
          add(intersections[1], intersections[2]);
        } else {
          add(intersections[0], intersections[1]);
          add(intersections[2], intersections[3]);
        }
      }
    }
  }
  return segments;
}

function decimatePathByDistance(points: Point[], minimumDistance: number, closed: boolean): Point[] {
  if (points.length <= 3) return [...points];
  const result: Point[] = [points[0]];
  for (let index = 1; index < points.length - 1; index += 1) {
    const previous = result[result.length - 1];
    const point = points[index];
    if (Math.hypot(point.x - previous.x, point.y - previous.y) >= minimumDistance)
      result.push(point);
  }
  const last = points[points.length - 1];
  if (!closed || Math.hypot(last.x - result[0].x, last.y - result[0].y) > minimumDistance * 0.55)
    result.push(last);
  return result;
}

function curveSegmentNetwork(
  segments: LineSegment[],
  tolerance: number,
  closedPreferred = false,
  quality: "preview" | "final" = "final",
): Array<LineSegment & { curveId: number; sequence: number }> {
  const curved: Array<LineSegment & { curveId: number; sequence: number }> = [];
  let curveId = 0;
  const preview = quality === "preview";
  const stitchTolerance = Math.max(1e-6, tolerance);
  for (const path of stitchSegments(segments, stitchTolerance)) {
    const closed =
      closedPreferred &&
      path.length > 3 &&
      Math.hypot(
        path[0].x - path[path.length - 1].x,
        path[0].y - path[path.length - 1].y,
      ) <= stitchTolerance * 2.5;
    const rawSource = closed ? path.slice(0, -1) : path;
    let rawLength = 0;
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < rawSource.length; index += 1) {
      const point = rawSource[index];
      minX = Math.min(minX, point.x); minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x); maxY = Math.max(maxY, point.y);
      if (index > 0) rawLength += Math.hypot(point.x - rawSource[index - 1].x, point.y - rawSource[index - 1].y);
    }
    if (closed && rawSource.length > 1) rawLength += Math.hypot(rawSource[0].x - rawSource[rawSource.length - 1].x, rawSource[0].y - rawSource[rawSource.length - 1].y);
    const rawDiameter = Math.hypot(maxX - minX, maxY - minY);
    // 셀보다 훨씬 작은 폐곡선은 실제 지형이 아니라 보간 수치 잡음이므로 버린다.
    if (rawSource.length < 2 || rawLength < stitchTolerance * 1.5 || rawDiameter < stitchTolerance * 0.45) {
      curveId += 1;
      continue;
    }
    // 미리보기는 셀 모서리마다 수십 개의 보간점을 만드는 대신 상위 곡선의 흐름만 유지한다.
    const source = decimatePathByDistance(
      rawSource,
      stitchTolerance * (preview ? 1.45 : 0.65),
      closed,
    );
    const smoothedRaw =
      source.length >= 3
        ? smoothPath(source, {
            closed,
            spacing: stitchTolerance * (preview ? 2.4 : 1.65),
            samplesPerSegment: preview ? 1 : 2,
            iterations: 1,
          })
        : source;
    const rounded = source.length >= 3
      ? chaikinPath(smoothedRaw, preview ? 1 : 2, closed)
      : smoothedRaw;
    const curvatureLimited = closed
      ? limitClosedPathCurvature(rounded, 28, preview ? 8 : 12)
      : limitPathCurvature(rounded, 28, preview ? 6 : 8);
    const sampledSource = closed && curvatureLimited.length > 2
      ? [...curvatureLimited, curvatureLimited[0]]
      : curvatureLimited;
    let smoothed = resamplePath(
      sampledSource,
      Math.max(1e-6, stitchTolerance * (preview ? 1.35 : 0.95)),
    );
    if (
      closed &&
      smoothed.length > 2 &&
      Math.hypot(
        smoothed[0].x - smoothed[smoothed.length - 1].x,
        smoothed[0].y - smoothed[smoothed.length - 1].y,
      ) <= stitchTolerance
    )
      smoothed = smoothed.slice(0, -1);
    smoothed = closed
      ? limitClosedPathCurvature(smoothed, 28, preview ? 10 : 16)
      : limitPathCurvature(smoothed, 28, preview ? 8 : 12);
    if (!preview) {
      smoothed = chaikinPath(smoothed, 1, closed);
      smoothed = closed
        ? limitClosedPathCurvature(smoothed, 26, 18)
        : limitPathCurvature(smoothed, 26, 14);
    }
    // 폐곡선의 거의 동일한 점들이 수치상 큰 회전각으로 판정되는 미세 선분을 제거한다.
    const minimumOutputDistance = stitchTolerance * (preview ? 0.16 : 0.08);
    const compacted = decimatePathByDistance(smoothed, minimumOutputDistance, closed);
    if (compacted.length >= (closed ? 3 : 2)) smoothed = compacted;
    smoothed = closed
      ? limitClosedPathCurvature(smoothed, 26, preview ? 10 : 18)
      : limitPathCurvature(smoothed, 26, preview ? 8 : 14);
    let outputMinX = Number.POSITIVE_INFINITY;
    let outputMinY = Number.POSITIVE_INFINITY;
    let outputMaxX = Number.NEGATIVE_INFINITY;
    let outputMaxY = Number.NEGATIVE_INFINITY;
    for (const point of smoothed) {
      outputMinX = Math.min(outputMinX, point.x); outputMinY = Math.min(outputMinY, point.y);
      outputMaxX = Math.max(outputMaxX, point.x); outputMaxY = Math.max(outputMaxY, point.y);
    }
    if (Math.hypot(outputMaxX - outputMinX, outputMaxY - outputMinY) < stitchTolerance * 0.4) {
      curveId += 1;
      continue;
    }
    for (let index = 0; index < smoothed.length - 1; index += 1)
      curved.push({ start: smoothed[index], end: smoothed[index + 1], curveId, sequence: index });
    if (closed && smoothed.length > 2)
      curved.push({ start: smoothed[smoothed.length - 1], end: smoothed[0], curveId, sequence: smoothed.length - 1 });
    curveId += 1;
  }
  return curved;
}

function projectContourPoint(
  values: number[],
  width: number,
  height: number,
  worldWidth: number,
  worldHeight: number,
  level: number,
  source: Point,
): Point {
  const stepX = Math.max(1e-6, worldWidth / Math.max(1, width) * 0.32);
  const stepY = Math.max(1e-6, worldHeight / Math.max(1, height) * 0.32);
  const maximumMove = Math.max(stepX, stepY) * 0.9;
  let point = { ...source };
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const value = sampleCellDerivedFieldAtWorld(values, width, height, worldWidth, worldHeight, point);
    const dx = (
      sampleCellDerivedFieldAtWorld(values, width, height, worldWidth, worldHeight, { x: point.x + stepX, y: point.y })
      - sampleCellDerivedFieldAtWorld(values, width, height, worldWidth, worldHeight, { x: point.x - stepX, y: point.y })
    ) / (2 * stepX);
    const dy = (
      sampleCellDerivedFieldAtWorld(values, width, height, worldWidth, worldHeight, { x: point.x, y: point.y + stepY })
      - sampleCellDerivedFieldAtWorld(values, width, height, worldWidth, worldHeight, { x: point.x, y: point.y - stepY })
    ) / (2 * stepY);
    const magnitudeSquared = dx * dx + dy * dy;
    if (magnitudeSquared < 1e-12 || Math.abs(value - level) < 0.25) break;
    const rawScale = (value - level) / magnitudeSquared;
    const moveX = clamp(dx * rawScale, -maximumMove, maximumMove);
    const moveY = clamp(dy * rawScale, -maximumMove, maximumMove);
    point = {
      x: clamp(point.x - moveX, 0, worldWidth),
      y: clamp(point.y - moveY, 0, worldHeight),
    };
  }
  return point;
}

function removeProjectedPathBacktracking(points: Point[], closed: boolean, epsilon: number): Point[] {
  if (points.length < (closed ? 3 : 2)) return points;
  const source = closed ? [...points, points[0], points[1]] : points;
  const output: Point[] = [];
  const minimumCosine = Math.cos(28 * Math.PI / 180);
  for (const point of source) {
    if (output.length && Math.hypot(point.x - output[output.length - 1].x, point.y - output[output.length - 1].y) <= epsilon) continue;
    while (output.length >= 2) {
      const a = output[output.length - 2];
      const b = output[output.length - 1];
      const firstLength = Math.hypot(b.x - a.x, b.y - a.y);
      const secondLength = Math.hypot(point.x - b.x, point.y - b.y);
      const cosine = ((b.x - a.x) * (point.x - b.x) + (b.y - a.y) * (point.y - b.y)) /
        Math.max(1e-9, firstLength * secondLength);
      if (cosine >= minimumCosine) break;
      output.pop();
    }
    output.push(point);
  }
  if (!closed) return output;
  return output.slice(0, Math.max(0, output.length - 2));
}

export function buildGeneratedContours(
  elevationMap: number[],
  width: number,
  height: number,
  worldWidth: number,
  worldHeight: number,
  seaLevel: number,
  contourInterval: number,
  quality: "preview" | "final" = "final",
): GeneratedContourSegment[] {
  if (!elevationMap.length || contourInterval <= 0) return [];
  let minimumElevation = Number.POSITIVE_INFINITY;
  let maximumElevation = Number.NEGATIVE_INFINITY;
  for (const value of elevationMap) {
    minimumElevation = Math.min(minimumElevation, value);
    maximumElevation = Math.max(maximumElevation, value);
  }
  const contours: GeneratedContourSegment[] = [];
  const contourStart = Math.floor(minimumElevation / contourInterval) * contourInterval;
  const tolerance = Math.max(worldWidth / width, worldHeight / height) * (quality === "preview" ? 0.68 : 0.28);
  for (let elevation = contourStart; elevation <= maximumElevation; elevation += contourInterval) {
    if (Math.abs(elevation - seaLevel) < 1e-9) continue;
    const curved = curveSegmentNetwork(
      extractSegments(elevationMap, width, height, elevation, worldWidth, worldHeight),
      tolerance,
      true,
      quality,
    );
    const isMajor = Math.abs(elevation) % (contourInterval * 5) === 0;
    const curves = new Map<number, typeof curved>();
    for (const segment of curved) {
      const group = curves.get(segment.curveId) ?? [];
      group.push(segment);
      curves.set(segment.curveId, group);
    }
    for (const [curveId, segments] of curves) {
      const ordered = segments.slice().sort((a, b) => a.sequence - b.sequence);
      const closed = ordered.length > 2 && Math.hypot(
        ordered[0].start.x - ordered[ordered.length - 1].end.x,
        ordered[0].start.y - ordered[ordered.length - 1].end.y,
      ) <= tolerance * 1.5;
      const rawPoints = [ordered[0].start, ...ordered.map((segment) => segment.end)];
      if (closed) rawPoints.pop();
      let projected = rawPoints.map((point) => projectContourPoint(
        elevationMap,
        width,
        height,
        worldWidth,
        worldHeight,
        elevation,
        point,
      ));
      projected = removeProjectedPathBacktracking(projected, closed, tolerance * 0.025);
      projected = decimatePathByDistance(projected, tolerance * 0.08, closed);
      projected = decimatePathByDistance(projected, tolerance * 0.045, closed);
      projected = removeProjectedPathBacktracking(projected, closed, tolerance * 0.01);
      projected = closed
        ? limitClosedPathCurvature(projected, 26, quality === "preview" ? 12 : 22)
        : limitPathCurvature(projected, 26, quality === "preview" ? 10 : 18);
      if (projected.length < (closed ? 3 : 2)) continue;
      let projectedMinX = Number.POSITIVE_INFINITY;
      let projectedMinY = Number.POSITIVE_INFINITY;
      let projectedMaxX = Number.NEGATIVE_INFINITY;
      let projectedMaxY = Number.NEGATIVE_INFINITY;
      let projectedLength = 0;
      for (let index = 0; index < projected.length; index += 1) {
        const point = projected[index];
        projectedMinX = Math.min(projectedMinX, point.x);
        projectedMinY = Math.min(projectedMinY, point.y);
        projectedMaxX = Math.max(projectedMaxX, point.x);
        projectedMaxY = Math.max(projectedMaxY, point.y);
        if (index > 0) projectedLength += Math.hypot(point.x - projected[index - 1].x, point.y - projected[index - 1].y);
      }
      if (closed) projectedLength += Math.hypot(
        projected[0].x - projected[projected.length - 1].x,
        projected[0].y - projected[projected.length - 1].y,
      );
      const projectedDiameter = Math.hypot(projectedMaxX - projectedMinX, projectedMaxY - projectedMinY);
      if (
        projectedDiameter < tolerance * 0.55 ||
        projectedLength < tolerance * 1.65 ||
        (closed && (projectedDiameter < tolerance * 2.6 || projectedLength < tolerance * 5.5))
      ) continue;
      const count = closed ? projected.length : projected.length - 1;
      for (let index = 0; index < count; index += 1) contours.push({
        start: projected[index],
        end: projected[(index + 1) % projected.length],
        curveId,
        sequence: index,
        elevation,
        isMajor,
      });
    }
  }
  return contours;
}

function normalizeElevation(
  raw: number[],
  settings: GeneratorSettings,
  width: number,
  height: number,
  centers: Point[],
): { normalized: number[]; actualContinentCount: number } {
  const erosionIterations = Math.round(
    settings.erosion *
      (settings.mapScope === "local" || settings.mapScope === "regional"
        ? 3
        : 5),
  );
  const eroded = smoothGrid(
    raw,
    width,
    height,
    erosionIterations,
    0.14 + settings.erosion * 0.1,
  );
  const sorted = [...eroded].sort((a, b) => a - b);
  const desiredLandRatio =
    (settings.mapScope === "local" || settings.mapScope === "regional") &&
    ["inland", "mountain", "river"].includes(
      settings.localRegionType,
    )
      ? Math.max(0.86, settings.landRatio)
      : settings.landRatio;
  const thresholdIndex = Math.max(
    0,
    Math.min(
      sorted.length - 1,
      Math.floor(sorted.length * (1 - desiredLandRatio)),
    ),
  );
  const threshold = sorted[thresholdIndex];
  const minimum = sorted[0];
  const maximum = sorted[sorted.length - 1];
  const normalized = eroded.map((value) =>
    value >= threshold
      ? 0.5 + 0.5 * ((value - threshold) / Math.max(1e-6, maximum - threshold))
      : 0.5 - 0.5 * ((threshold - value) / Math.max(1e-6, threshold - minimum)),
  );

  // 해안 평활도는 전체 산악 지형이 아니라 해수면 인접 대역에만 적용한다.
  // 값이 높을수록 잔톱니가 줄고, 낮을수록 원래의 복잡한 해안선을 유지한다.
  if (settings.coastSmoothness > 0.001) {
    const coastReference = smoothGrid(
      normalized,
      width,
      height,
      2,
      0.12 + settings.coastSmoothness * 0.22,
    );
    for (let index = 0; index < normalized.length; index += 1) {
      const distanceFromCoast = Math.abs(normalized[index] - 0.5);
      const coastWeight =
        clamp(1 - distanceFromCoast / 0.19, 0, 1) * settings.coastSmoothness;
      normalized[index] =
        normalized[index] * (1 - coastWeight) +
        coastReference[index] * coastWeight;
    }
    // 별도 버퍼를 사용하는 세포 자동자 후처리로 단일 셀 돌출부와 작은 해안 구멍을 정리한다.
    // 순회 중 원본을 직접 수정하지 않아 방향 편향이 생기지 않는다.
    const refined = refineCoastlineCellular(
      normalized,
      width,
      height,
      settings.coastSmoothness > 0.68 ? 2 : 1,
    );
    for (let index = 0; index < normalized.length; index += 1)
      normalized[index] = refined[index];
  }

  // 해안 평활화가 전체 육지 비율을 과도하게 줄이거나 늘리지 않도록 해수면 기준을 다시 정규화한다.
  // 골자 알고리즘별 형태 차이는 유지하면서 사용자가 지정한 목표 육지 비율에 근접하게 맞춘다.
  {
    const finalSorted = [...normalized].sort((a, b) => a - b);
    const finalThreshold =
      finalSorted[
        Math.max(
          0,
          Math.min(
            finalSorted.length - 1,
            Math.floor(finalSorted.length * (1 - desiredLandRatio)),
          ),
        )
      ] ?? 0.5;
    const finalMinimum = finalSorted[0] ?? 0;
    const finalMaximum = finalSorted[finalSorted.length - 1] ?? 1;
    for (let index = 0; index < normalized.length; index += 1) {
      const value = normalized[index];
      normalized[index] =
        value >= finalThreshold
          ? 0.5 +
            0.5 *
              ((value - finalThreshold) /
                Math.max(1e-6, finalMaximum - finalThreshold))
          : 0.5 -
            0.5 *
              ((finalThreshold - value) /
                Math.max(1e-6, finalThreshold - finalMinimum));
    }
  }

  if (settings.mapScope === "continent" || settings.mapScope === "world") {
    // 가장 가까운 두 대륙 중심의 경계에 좁은 해협을 강제로 만들어 대륙끼리 합쳐지지 않게 한다.
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = y * width + x;
        if (normalized[index] < 0.5 || centers.length < 2) continue;
        const nx = x / (width - 1);
        const ny = y / (height - 1);
        const distances = centers
          .map((center) =>
            Math.hypot((nx - center.x) * (width / height), ny - center.y),
          )
          .sort((a, b) => a - b);
        if (distances[1] - distances[0] < 0.018) normalized[index] = 0.47;
      }
    }
    // 각 대륙 중심에는 반드시 육지 핵을 만들고, 중심과 연결되지 않은 작은 섬은 제거한다.
    for (const center of centers) {
      const cx = Math.round(center.x * (width - 1));
      const cy = Math.round(center.y * (height - 1));
      for (let oy = -2; oy <= 2; oy += 1)
        for (let ox = -2; ox <= 2; ox += 1) {
          const x = cx + ox;
          const y = cy + oy;
          if (x >= 0 && y >= 0 && x < width && y < height)
            normalized[y * width + x] = Math.max(
              normalized[y * width + x],
              0.62 - Math.hypot(ox, oy) * 0.02,
            );
        }
    }
    const components = landComponents(
      normalized.map((value) => value >= 0.5),
      width,
      height,
    );
    const componentByCell = new Int32Array(normalized.length).fill(-1);
    components.forEach((component, componentIndex) => {
      for (const cell of component.cells)
        componentByCell[cell] = componentIndex;
    });
    const centerComponentIndexes = new Set<number>();
    for (const center of centers) {
      const index =
        Math.round(center.y * (height - 1)) * width +
        Math.round(center.x * (width - 1));
      const componentIndex = componentByCell[index];
      if (componentIndex >= 0) centerComponentIndexes.add(componentIndex);
    }
    // 중심이 경계 절삭으로 작은 조각에 놓이더라도 가장 큰 본토는 반드시 보존한다.
    // 그와 별도로 일정 크기 이상의 부속섬을 남겨 ‘둥근 섬 하나’로 축약되는 현상을 막는다.
    const keepComponents = new Set<number>(centerComponentIndexes);
    const requestedMainlands = Math.max(1, centers.length);
    for (
      let componentIndex = 0;
      componentIndex < Math.min(requestedMainlands, components.length);
      componentIndex += 1
    )
      keepComponents.add(componentIndex);
    // 골자 생성기가 의도적으로 만든 부속섬과 섬 사슬은 보존한다. 완전히 고립된 1~3셀 잡음만 제거한다.
    const islandMinimum = 4;
    for (
      let componentIndex = 0;
      componentIndex < components.length;
      componentIndex += 1
    ) {
      if (components[componentIndex].size >= islandMinimum)
        keepComponents.add(componentIndex);
    }
    const keep = new Uint8Array(normalized.length);
    for (const componentIndex of keepComponents)
      for (const cell of components[componentIndex].cells) keep[cell] = 1;
    for (let index = 0; index < normalized.length; index += 1) {
      if (normalized[index] >= 0.5 && keep[index] === 0)
        normalized[index] = 0.47;
    }
    // 독립 대륙 수는 생성 계획의 중심이 실제로 귀속된 연결 요소 수로 계산한다.
    return {
      normalized,
      actualContinentCount: Math.max(1, centerComponentIndexes.size),
    };
  }
  return {
    normalized,
    actualContinentCount: landComponents(
      normalized.map((value) => value >= 0.5),
      width,
      height,
    ).length,
  };
}

/**
 * 닫힌 해안선 안쪽의 수역을 무조건 메우지 않는다. 아주 작은 래스터 잡음만 육지로
 * 복원하고, 의미 있는 내부 수역은 이후 해수/담수 연결성 판정을 위해 보존한다.
 */
function sealUnintendedInlandWater(
  normalized: number[],
  width: number,
  height: number,
  settings: GeneratorSettings,
): { normalized: number[]; landMask: number[] } {
  const land = normalized.map((value) => value >= 0.5);
  const exterior = new Uint8Array(land.length);
  const queue = new Int32Array(land.length);
  let head = 0;
  let tail = 0;
  const enqueue = (index: number) => {
    if (!land[index] && !exterior[index]) {
      exterior[index] = 1;
      queue[tail++] = index;
    }
  };
  for (let x = 0; x < width; x += 1) {
    enqueue(x);
    enqueue((height - 1) * width + x);
  }
  for (let y = 0; y < height; y += 1) {
    enqueue(y * width);
    enqueue(y * width + width - 1);
  }
  const directions = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const;
  while (head < tail) {
    const index = queue[head++];
    const x = index % width;
    const y = Math.floor(index / width);
    for (const [dx, dy] of directions) {
      const nx = x + dx,
        ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      enqueue(ny * width + nx);
    }
  }
  const visited = new Uint8Array(land.length);
  const enclosed: number[][] = [];
  for (let start = 0; start < land.length; start += 1) {
    if (land[start] || exterior[start] || visited[start]) continue;
    const cells: number[] = [];
    head = 0;
    tail = 0;
    visited[start] = 1;
    queue[tail++] = start;
    while (head < tail) {
      const index = queue[head++];
      cells.push(index);
      const x = index % width,
        y = Math.floor(index / width);
      for (const [dx, dy] of directions) {
        const nx = x + dx,
          ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const next = ny * width + nx;
        if (!land[next] && !exterior[next] && !visited[next]) {
          visited[next] = 1;
          queue[tail++] = next;
        }
      }
    }
    enclosed.push(cells);
  }
  enclosed.sort((a, b) => b.length - a.length);
  const minimumWaterCells = Math.max(6, Math.round(width * height * 0.00002));
  const preserveLargest =
    settings.mapShape === "inland_sea" ? enclosed[0] : undefined;
  const preserveLargestSet = preserveLargest
    ? new Set(preserveLargest)
    : undefined;
  const output = [...normalized];
  for (const cells of enclosed)
    for (const index of cells) {
      const preserve =
        preserveLargestSet?.has(index) || cells.length >= minimumWaterCells;
      if (preserve) continue;
      land[index] = true;
      output[index] = Math.max(0.505, output[index], 0.51);
    }
  return { normalized: output, landMask: land.map((value) => (value ? 1 : 0)) };
}

/** 지도 가장자리와 연결된 저지 수역은 해수, 육지에 둘러싸인 수역은 담수로 분류한다. */
function createNeutralTerrainField(
  shape: number[],
  landMask: number[],
  width: number,
  height: number,
  settings: GeneratorSettings,
): number[] {
  const distances = oceanDistance(
    landMask.map((value) => (value >= 0.5 ? 1 : -1)),
    width,
    height,
    0,
  );
  const algorithmSalt = [...settings.algorithm].reduce(
    (sum, char) => Math.imul(sum ^ char.charCodeAt(0), 16777619) >>> 0,
    2166136261,
  );
  const random = mulberry32((settings.seed + 91_337 + algorithmSalt) >>> 0);
  const angle = random() * Math.PI * 2;
  const gx = Math.cos(angle);
  const gy = Math.sin(angle);
  const phaseX = random() * 173.7 + 11.3;
  const phaseY = random() * 149.9 + 7.1;
  const detailScale = terrainDetailScale(settings);
  const detailOctaves = Math.max(3, Math.min(6, 3 + Math.round(Math.log2(detailScale + 0.5))));
  const variationGain = 0.9 + settings.noiseStrength * 0.55;
  let reliefMean = 0;
  let reliefCount = 0;
  for (let index = 0; index < shape.length; index += 1)
    if ((landMask[index] ?? 0) >= 0.5) {
      reliefMean += clamp((shape[index] - 0.5) / 0.5, 0, 1);
      reliefCount += 1;
    }
  reliefMean /= Math.max(1, reliefCount);
  const output = new Array<number>(shape.length);
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const nx = x / Math.max(1, width - 1),
        ny = y / Math.max(1, height - 1);
      if ((landMask[index] ?? 0) < 0.5) {
        output[index] = Math.min(0.495, shape[index]);
        continue;
      }
      const px = nx + phaseX,
        py = ny + phaseY;
      const broad =
        fractalPerlinNoise(
          px * 2.3,
          py * 2.3,
          settings.seed + 1201 + algorithmSalt,
          5,
          0.55,
          2.02,
        ) - 0.5;
      const medium =
        fractalPerlinNoise(
          px * 7.1 * detailScale,
          py * 7.1 * detailScale,
          settings.seed + 2203 + algorithmSalt,
          4,
          0.51,
          2.08,
        ) - 0.5;
      const fine =
        fractalNoise(
          px * 19 * detailScale,
          py * 19 * detailScale,
          settings.seed + 3301 + algorithmSalt,
          detailOctaves,
          0.48,
          2.13,
        ) - 0.5;
      const directional = ((nx - 0.5) * gx + (ny - 0.5) * gy) * 0.065;
      const inland = clamp(
        distances[index] / Math.max(3, Math.min(width, height) * 0.12),
        0,
        1,
      );
      const shapeRelief = clamp((shape[index] - 0.5) / 0.5, 0, 1);
      const inheritedRelief =
        (shapeRelief - reliefMean) * (0.1 + settings.continentDynamics * 0.06);
      let value =
        0.585 +
        broad * 0.205 +
        medium * 0.142 * variationGain +
        fine * 0.072 * variationGain +
        directional +
        inland * 0.04 +
        inheritedRelief;
      if (settings.mapShape === "volcanic_island") {
        const cx = 0.42 + Math.sin(settings.seed) * 0.09,
          cy = 0.48 + Math.cos(settings.seed * 0.7) * 0.08;
        value +=
          Math.max(0, 1 - Math.hypot((nx - cx) * 1.2, ny - cy) / 0.32) * 0.25;
      }
      if (
        (settings.mapScope === "local" || settings.mapScope === "regional") &&
        settings.localRegionType === "mountain"
      ) {
        const ridge = Math.abs(
          (nx - 0.5) * Math.cos(angle + Math.PI / 2) +
            (ny - 0.5) * Math.sin(angle + Math.PI / 2),
        );
        value += Math.max(0, 1 - ridge / 0.13) * 0.18;
      }
      output[index] = clamp(value, 0.505, 0.995);
    }
  return output;
}

function stabilizeLandMask(values: number[], landMask: number[]): number[] {
  return values.map((value, index) =>
    (landMask[index] ?? 0) >= 0.5
      ? Math.max(0.505, value)
      : Math.min(0.495, value),
  );
}

/** 해안형 국지 지도에서만 풍향·풍속·조차를 이용해 연안 침식·퇴적 지형을 만든다. */
function applyLocalCoastalProcesses(
  elevation: number[],
  landMask: number[],
  width: number,
  height: number,
  seaLevel: number,
  settings: GeneratorSettings,
): number[] {
  if (settings.mapScope !== "local" && settings.mapScope !== "regional") return elevation;
  const result = [...elevation];
  const windAngle =
    ((settings.prevailingWindDirectionDeg + 180) * Math.PI) / 180;
  const windX = Math.cos(windAngle),
    windY = Math.sin(windAngle);
  const waveStrength = clamp(settings.prevailingWindSpeed / 18, 0, 1);
  const tidal = clamp((settings.tidalRangeM ?? 2.2) / 12, 0, 1);
  const directions = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const;
  for (let y = 1; y < height - 1; y += 1)
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x;
      if ((landMask[index] ?? 0) < 0.5) continue;
      let sx = 0,
        sy = 0,
        seaCount = 0;
      for (const [dx, dy] of directions) {
        const next = (y + dy) * width + x + dx;
        if ((landMask[next] ?? 0) < 0.5) {
          sx += dx;
          sy += dy;
          seaCount += 1;
        }
      }
      if (!seaCount) continue;
      const length = Math.max(1e-6, Math.hypot(sx, sy));
      const onshore = Math.max(
        0,
        windX * (-sx / length) + windY * (-sy / length),
      );
      const energy = waveStrength * (0.35 + 0.65 * onshore);
      if (energy > 0.56) {
        result[index] = Math.max(result[index], seaLevel + 35 + energy * 145);
        for (const [dx, dy] of directions) {
          const next = (y + dy) * width + x + dx;
          if ((landMask[next] ?? 0) < 0.5)
            result[next] = Math.min(result[next], seaLevel - 35 - energy * 90);
        }
      } else if (tidal > 0.22 || energy < 0.34) {
        const shelf =
          seaLevel + Math.max(2, 22 * (1 - energy)) * (1 - tidal * 0.45);
        result[index] = result[index] * 0.38 + shelf * 0.62;
        for (const [dx, dy] of directions) {
          const next = (y + dy) * width + x + dx;
          if ((landMask[next] ?? 0) < 0.5)
            result[next] = Math.max(result[next], seaLevel - 18 - tidal * 38);
        }
      }
    }

  // 지방·지역 지도의 연안 해저는 명시적인 해구가 아닌 한 대륙붕처럼 완만하게 낮아진다.
  const waterDistance=new Int32Array(width*height); waterDistance.fill(-1);
  const queue=new Int32Array(width*height); let head=0,tail=0;
  for(let y=0;y<height;y+=1)for(let x=0;x<width;x+=1){const i=y*width+x;if((landMask[i]??0)>=0.5)continue;const adjacent=directions.some(([dx,dy])=>{const nx=x+dx,ny=y+dy;return nx>=0&&ny>=0&&nx<width&&ny<height&&(landMask[ny*width+nx]??0)>=0.5;});if(adjacent){waterDistance[i]=0;queue[tail++]=i;}}
  while(head<tail){const i=queue[head++],x=i%width,y=Math.floor(i/width);for(const[dx,dy]of directions){const nx=x+dx,ny=y+dy;if(nx<0||ny<0||nx>=width||ny>=height)continue;const n=ny*width+nx;if((landMask[n]??0)>=0.5||waterDistance[n]>=0)continue;waterDistance[n]=waterDistance[i]+1;queue[tail++]=n;}}
  const shelfWidth=Math.max(5,Math.round(Math.min(width,height)*0.075));
  const shelfSource=[...result];
  for(let y=1;y<height-1;y+=1)for(let x=1;x<width-1;x+=1){const i=y*width+x,d=waterDistance[i];if(d<0||d>shelfWidth)continue;
    const trenchSignal=fractalNoise(x*0.035,y*0.035,settings.seed+303_707,3,0.58,2.07);
    const explicitTrench=trenchSignal>0.91&&d>shelfWidth*0.45;
    if(explicitTrench)continue;
    const t=d/Math.max(1,shelfWidth);
    const target=seaLevel-(28+Math.pow(t,1.55)*820);
    const neighborAverage=(shelfSource[i-1]+shelfSource[i+1]+shelfSource[i-width]+shelfSource[i+width])/4;
    const softened=target*0.72+neighborAverage*0.28;
    result[i]=result[i]*0.18+softened*0.82;
  }
  return result;
}

export function generateWorldMap(
  settings: GeneratorSettings,
  worldWidth: number,
  worldHeight: number,
  quality: "preview" | "final" = "final",
): GeneratedMapData {
  // v0.99t: 모든 계산·분석·렌더 축을 2의 거듭제곱으로 정렬한다.
  const requestedRender = normalizePowerOfTwo(settings.renderResolution ?? 2048, 2048);
  const requestedAnalysis = normalizePowerOfTwo(settings.analysisResolution ?? 1024, 1024);
  const worldAspect = Math.max(0.125, Math.min(8, worldHeight / Math.max(1, worldWidth)));
  const renderWidth = requestedRender;
  const renderHeight = nearestPowerOfTwo(renderWidth * worldAspect, 64, 2048);
  const analysisWidth = quality === "preview" ? Math.min(requestedAnalysis, 128) : requestedAnalysis;
  const width = normalizePowerOfTwo(analysisWidth, quality === "preview" ? 128 : 1024);
  const height = nearestPowerOfTwo(width * worldAspect, 64, 2048);
  const localArchipelago =
    (settings.mapScope === "local" || settings.mapScope === "regional") &&
    settings.localRegionType === "archipelago";
  const effectiveSettings: GeneratorSettings = {
    ...settings,
    mapShape: localArchipelago ? "archipelago" : settings.mapShape,
    gridWidth: width,
    gridHeight: height,
    analysisResolution:
      requestedAnalysis as GeneratorSettings["analysisResolution"],
    contourInterval:
      quality === "preview"
        ? Math.max(settings.contourInterval, 1000)
        : settings.contourInterval,
  };

  const localLike =
    effectiveSettings.mapScope === "local" ||
    effectiveSettings.mapScope === "regional";

  let sealed: { normalized: number[]; landMask: number[] };
  let initialTerrain: number[];
  let deformed: number[];

  if (localLike) {
    // 지방·지역 지도는 대륙 골격, 판 구조, 전역 해수면 판정을 건너뛴다.
    const local = generateBoundaryDrivenLocalTerrain(
      effectiveSettings,
      width,
      height,
    );
    sealed = { normalized: local.normalized, landMask: local.landMask };
    initialTerrain = createNeutralTerrainField(
      sealed.normalized,
      sealed.landMask,
      width,
      height,
      effectiveSettings,
    );
    deformed = initialTerrain;
  } else {
    // 대륙·세계 지도에서만 대륙 골격과 판 구조를 사용한다.
    const tectonicPlan = createTectonicPlatePlan(effectiveSettings);
    const skeletonWidth = Math.min(
      width,
      quality === "preview" ? 256 : requestedAnalysis >= 1024 ? 512 : 256,
    );
    const skeletonHeight = nearestPowerOfTwo(skeletonWidth * worldAspect, 64, 2048);
    const skeletonSettings = {
      ...effectiveSettings,
      gridWidth: skeletonWidth,
      gridHeight: skeletonHeight,
    };
    const coarseSkeleton = generateSkeleton(
      skeletonSettings,
      skeletonWidth,
      skeletonHeight,
    );
    const skeleton = {
      ...coarseSkeleton,
      raw: progressivelyRefineSkeleton(
        coarseSkeleton.raw,
        skeletonWidth,
        skeletonHeight,
        width,
        height,
        effectiveSettings,
      ),
    };
    const repaired = repairPostWeatheringShape(
      skeleton.raw,
      width,
      height,
      effectiveSettings,
      skeleton.centers,
    );
    const structured = addDynamicLandformStructure(
      repaired,
      width,
      height,
      effectiveSettings,
    );
    const normalizedResult = normalizeElevation(
      structured,
      effectiveSettings,
      width,
      height,
      skeleton.centers,
    );
    sealed = sealUnintendedInlandWater(
      normalizedResult.normalized,
      width,
      height,
      effectiveSettings,
    );
    initialTerrain = createNeutralTerrainField(
      sealed.normalized,
      sealed.landMask,
      width,
      height,
      effectiveSettings,
    );
    const reconciledPlan = reconcileTectonicPlatePlan(
      tectonicPlan,
      sealed.landMask,
      width,
      height,
    );
    deformed = applyTectonicDeformation(
      initialTerrain,
      width,
      height,
      effectiveSettings,
      reconciledPlan,
      sealed.landMask,
    );
  }

  const weathered = applyCommonWeathering(
    deformed,
    width,
    height,
    effectiveSettings,
    quality,
  );
  const stabilized = stabilizeLandMask(weathered, sealed.landMask);
  const seaLevel = effectiveSettings.seaLevel;
  let elevationMap = buildElevationField(
    stabilized,
    sealed.landMask,
    width,
    height,
    effectiveSettings,
  );
  elevationMap = applyLocalCoastalProcesses(
    elevationMap,
    sealed.landMask,
    width,
    height,
    seaLevel,
    effectiveSettings,
  );
  const initialWaterTypeMap: WaterType[] = localLike
    ? sealed.landMask.map((value) => (value >= 0.5 ? "land" : "saltwater"))
    : classifyWaterBodies(
        elevationMap,
        width,
        height,
        seaLevel,
        effectiveSettings,
      );
  enforceLocalBoundaryWaterTypes(initialWaterTypeMap, width, height, effectiveSettings);
  const drainageElevation = [...elevationMap];
  const environmentElevation = reconcileElevationWithWater(elevationMap, initialWaterTypeMap, seaLevel);
  const environment = calculateEnvironment(
    environmentElevation,
    width,
    height,
    seaLevel,
    effectiveSettings,
  );
  const hydrology = buildHydrology(
    drainageElevation,
    environment.runoffMap,
    width,
    height,
    seaLevel,
    worldWidth,
    worldHeight,
    effectiveSettings,
    Uint8Array.from(initialWaterTypeMap, (type) => type === "saltwater" ? 1 : 0),
  );
  const waterTypeMap = [...initialWaterTypeMap];
  for (let index = 0; index < waterTypeMap.length; index += 1)
    if ((hydrology.freshwaterLakeMap[index] ?? 0) > 0)
      waterTypeMap[index] = "freshwater";
  enforceLocalBoundaryWaterTypes(waterTypeMap, width, height, effectiveSettings);
  elevationMap = reconcileElevationWithWaterAndLakes(
    drainageElevation,
    waterTypeMap,
    seaLevel,
    hydrology.lakeIdMap,
    hydrology.lakeSurfaceElevations,
  );
  const landMask = waterTypeMap.map((type) => (type === "land" ? 1 : 0));
  const actualContinentCount = landComponents(
    landMask.map((value) => value >= 0.5),
    width,
    height,
  ).length;
  const terrainMap = refineTerrainWithWaterAccess(
    terrainWithoutSubmergedLand(environment.terrainMap, waterTypeMap, "plain"),
    drainageElevation,
    waterTypeMap,
    environment,
    hydrology,
    width,
    height,
    seaLevel,
    effectiveSettings,
  );
  const coastalTerrainMap = generateCoastalTerrainTiles(
    elevationMap,
    waterTypeMap,
    environment,
    hydrology,
    width,
    height,
    seaLevel,
    effectiveSettings,
  );

  const agricultureMap = new Array(terrainMap.length).fill(0);
  const surfaceRegions = buildSurfaceRegions(
    terrainMap,
    waterTypeMap,
    width,
    height,
    worldWidth,
    worldHeight,
    effectiveSettings,
    quality,
    agricultureMap,
  );
  const coastline = surfaceBoundarySegments(
    surfaceRegions,
    "saltwater",
    worldWidth,
    worldHeight,
    true,
  );
  const contours = buildGeneratedContours(
    elevationMap,
    width,
    height,
    worldWidth,
    worldHeight,
    seaLevel,
    effectiveSettings.contourInterval,
    quality,
  );

  const validation = validateGeneratedResult(
    elevationMap,
    terrainMap,
    hydrology,
    width,
    height,
    seaLevel,
    effectiveSettings,
  );

  return {
    settings: {
      ...settings,
      gridWidth: width,
      gridHeight: height,
      analysisResolution:
        requestedAnalysis as GeneratorSettings["analysisResolution"],
      mapShape: settings.mapShape,
    },
    gridWidth: width,
    gridHeight: height,
    renderWidth,
    renderHeight,
    worldWidth,
    worldHeight,
    seaLevel,
    elevationMap,
    landMask,
    waterTypeMap,
    coastalTerrainMap,
    baseTerrainMap: [...terrainMap],
    agricultureMap,
    terrainMap,
    snowCoverMap: environment.snowCoverMap.map((value, index) => waterTypeMap[index] === "land" ? value : 0),
    snowBaseTerrainMap: terrainMap.map((terrain, index) =>
      terrain === "snow"
        ? (environment.snowBaseTerrainMap[index] ?? "mountain")
        : waterTypeMap[index] === "land" ? terrain : "plain",
    ),
    temperatureMap: environment.temperatureMap,
    precipitationMap: environment.precipitationMap,
    moistureMap: environment.moistureMap,
    relativeHumidityMap: environment.relativeHumidityMap,
    solarHoursMap: environment.solarHoursMap,
    solarIrradianceMap: environment.solarIrradianceMap,
    runoffMap: environment.runoffMap,
    flowAccumulationMap: hydrology.flowAccumulationMap,
    lakeIdMap: hydrology.lakeIdMap,
    lakeSurfaceElevations: hydrology.lakeSurfaceElevations,
    basinMap: hydrology.basinMap,
    riverOrderMap: hydrology.riverOrderMap,
    riverMagnitudeMap: hydrology.riverMagnitudeMap,
    windXMap: environment.windXMap,
    windYMap: environment.windYMap,
    generatedTerritories: [],
    surfaceRegions,
    surfaceVectorVersion: CURRENT_SURFACE_VECTOR_VERSION,
    coastline,
    contours,
    riverGraph: hydrology.riverGraph,
    rivers: hydrology.rivers,
    generatedAt: new Date().toISOString(),
    environmentModel: { engine: "builtin", version: "1.7-stat-ui-generation" },
    actualContinentCount,
    qualityScore: validation.score,
    qualityIssues: validation.issues,
  };
}

/** 수동 편집된 고도·지형 격자에서 해안선과 등고선을 다시 계산한다. */
export function rebuildGeneratedMapData(
  source: GeneratedMapData,
  elevationMap: number[],
  terrainOverride?: TerrainType[],
  nextSeaLevel = source.seaLevel ?? 0,
  agricultureOverride?: number[],
): GeneratedMapData {
  const { gridWidth: width, gridHeight: height, settings } = source;
  const drainageElevation = [...elevationMap];
  const priorLakeDepth = Math.max(2, Math.min(48, settings.contourInterval * 0.14));
  for (let index = 0; index < drainageElevation.length; index += 1) {
    if (source.waterTypeMap[index] !== "freshwater") continue;
    const lakeId = Math.trunc(source.lakeIdMap[index] ?? -1);
    const surface = source.lakeSurfaceElevations[lakeId];
    if (lakeId >= 0 && Number.isFinite(surface))
      drainageElevation[index] = Math.min(drainageElevation[index], surface - priorLakeDepth);
  }
  const initialWaterTypeMap = classifyWaterBodies(
    drainageElevation,
    width,
    height,
    nextSeaLevel,
    settings,
  );
  enforceLocalBoundaryWaterTypes(initialWaterTypeMap, width, height, settings);
  let normalizedElevationMap = reconcileElevationWithWater(
    drainageElevation,
    initialWaterTypeMap,
    nextSeaLevel,
  );
  const environment = calculateEnvironment(
    normalizedElevationMap,
    width,
    height,
    nextSeaLevel,
    settings,
  );
  let actualContinentCount = 0;
  const hydrology = buildHydrology(
    drainageElevation,
    environment.runoffMap,
    width,
    height,
    nextSeaLevel,
    source.worldWidth,
    source.worldHeight,
    settings,
    Uint8Array.from(initialWaterTypeMap, (type) => type === "saltwater" ? 1 : 0),
  );
  const waterTypeMap = [...initialWaterTypeMap];
  for (let index = 0; index < waterTypeMap.length; index += 1)
    if ((hydrology.freshwaterLakeMap[index] ?? 0) > 0)
      waterTypeMap[index] = "freshwater";
  enforceLocalBoundaryWaterTypes(waterTypeMap, width, height, settings);
  normalizedElevationMap = reconcileElevationWithWaterAndLakes(
    drainageElevation,
    waterTypeMap,
    nextSeaLevel,
    hydrology.lakeIdMap,
    hydrology.lakeSurfaceElevations,
  );
  const rawTerrainMap = terrainOverride
    ? terrainWithoutSubmergedLand(terrainOverride, waterTypeMap, "plain")
    : refineTerrainWithWaterAccess(
        terrainWithoutSubmergedLand(environment.terrainMap, waterTypeMap, "plain"),
        normalizedElevationMap,
        waterTypeMap,
        environment,
        hydrology,
        width,
        height,
        nextSeaLevel,
        settings,
      );
  const terrainMap = rawTerrainMap.map((terrain): TerrainType =>
    terrain === "farmland" ? "plain" : terrain,
  );
  const agricultureMap = terrainMap.map((_terrain, index) => {
    if (waterTypeMap[index] !== "land") return 0;
    if (rawTerrainMap[index] === "farmland") return 1;
    const value = agricultureOverride?.[index] ?? source.agricultureMap?.[index] ?? 0;
    return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  });
  const coastalTerrainMap = generateCoastalTerrainTiles(
    normalizedElevationMap,
    waterTypeMap,
    environment,
    hydrology,
    width,
    height,
    nextSeaLevel,
    settings,
  );
  const surfaceRegions = buildSurfaceRegions(
    terrainMap,
    waterTypeMap,
    width,
    height,
    source.worldWidth,
    source.worldHeight,
    settings,
    "final",
    agricultureMap,
  );
  const coastline = surfaceBoundarySegments(
    surfaceRegions,
    "saltwater",
    source.worldWidth,
    source.worldHeight,
    true,
  );
  actualContinentCount = landComponents(
    waterTypeMap.map((type) => type === "land"),
    width,
    height,
  ).length;
  const contours = buildGeneratedContours(
    normalizedElevationMap,
    width,
    height,
    source.worldWidth,
    source.worldHeight,
    nextSeaLevel,
    settings.contourInterval,
    "final",
  );
  const validation = validateGeneratedResult(
    normalizedElevationMap,
    terrainMap,
    hydrology,
    width,
    height,
    nextSeaLevel,
    settings,
  );
  return {
    ...source,
    seaLevel: nextSeaLevel,
    elevationMap: normalizedElevationMap,
    landMask: waterTypeMap.map((type) => (type === "land" ? 1 : 0)),
    waterTypeMap,
    coastalTerrainMap,
    baseTerrainMap: [...terrainMap],
    agricultureMap,
    terrainMap,
    snowCoverMap: (terrainOverride
      ? source.snowCoverMap
      : environment.snowCoverMap).map((value, index) => waterTypeMap[index] === "land" ? value : 0),
    snowBaseTerrainMap: terrainOverride
      ? terrainMap.map((terrain, index) =>
          terrain === "snow"
            ? (source.snowBaseTerrainMap?.[index] ?? "mountain")
            : terrain,
        )
      : terrainWithoutSubmergedLand(environment.snowBaseTerrainMap, waterTypeMap, "plain"),
    temperatureMap: environment.temperatureMap,
    precipitationMap: environment.precipitationMap,
    moistureMap: environment.moistureMap,
    relativeHumidityMap: environment.relativeHumidityMap,
    solarHoursMap: environment.solarHoursMap,
    solarIrradianceMap: environment.solarIrradianceMap,
    runoffMap: environment.runoffMap,
    flowAccumulationMap: hydrology.flowAccumulationMap,
    lakeIdMap: hydrology.lakeIdMap,
    lakeSurfaceElevations: hydrology.lakeSurfaceElevations,
    basinMap: hydrology.basinMap,
    riverOrderMap: hydrology.riverOrderMap,
    riverMagnitudeMap: hydrology.riverMagnitudeMap,
    windXMap: environment.windXMap,
    windYMap: environment.windYMap,
    generatedTerritories: source.generatedTerritories ?? [],
    surfaceRegions,
    surfaceVectorVersion: CURRENT_SURFACE_VECTOR_VERSION,
    coastline,
    contours,
    riverGraph: hydrology.riverGraph,
    rivers: hydrology.rivers,
    actualContinentCount,
    qualityScore: validation.score,
    qualityIssues: validation.issues,
    generatedAt: new Date().toISOString(),
  };
}
