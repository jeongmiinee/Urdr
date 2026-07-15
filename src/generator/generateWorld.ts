import type {
  GeneratedContourSegment,
  GeneratedMapData,
  GeneratedRiverSegment,
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
import { cellValuesToVertexValues, createGridTransform, nearestPowerOfTwo, normalizePowerOfTwo } from "./gridTransform";
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
  guidedNormalizedPath,
} from "./localBoundaryTerrain";
import { segmentDistance } from "./pathGeometry";

const clamp = (value: number, min = 0, max = 1) =>
  Math.max(min, Math.min(max, value));

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
    const amplitude =
      (0.07 + settings.coastlineDetail * 0.055) * Math.pow(0.58, stage);
    for (let y = 0; y < nextHeight; y += 1)
      for (let x = 0; x < nextWidth; x += 1) {
        const index = y * nextWidth + x;
        const boundaryNoise =
          fractalPerlinNoise(
            x / Math.max(7, nextWidth / (9 + stage * 4)),
            y / Math.max(7, nextHeight / (9 + stage * 4)),
            settings.seed + 70_013 + stage * 977,
            3,
            0.54,
            2.03,
          ) - 0.5;
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
          px * 7.1,
          py * 7.1,
          settings.seed + 2203 + algorithmSalt,
          4,
          0.51,
          2.08,
        ) - 0.5;
      const fine =
        fractalNoise(
          px * 19,
          py * 19,
          settings.seed + 3301 + algorithmSalt,
          3,
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
        medium * 0.108 +
        fine * 0.046 +
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

function mergeCoincidentRiverCorridors(
  rivers: GeneratedRiverSegment[],
  worldWidth: number,
  worldHeight: number,
  gridWidth: number,
  gridHeight: number,
): GeneratedRiverSegment[] {
  const cellSize = Math.max(worldWidth / Math.max(1, gridWidth), worldHeight / Math.max(1, gridHeight));
  const snap = Math.max(1e-6, cellSize * 0.7);
  const merged = new Map<string, GeneratedRiverSegment>();
  for (const segment of [...rivers].sort((a, b) => b.width - a.width)) {
    const mx = (segment.start.x + segment.end.x) * 0.5;
    const my = (segment.start.y + segment.end.y) * 0.5;
    const angle = Math.atan2(segment.end.y - segment.start.y, segment.end.x - segment.start.x);
    const normalizedAngle = ((angle % Math.PI) + Math.PI) % Math.PI;
    const key = `${segment.basinId}:${Math.round(mx / snap)}:${Math.round(my / snap)}:${Math.round(normalizedAngle / (Math.PI / 12))}`;
    const previous = merged.get(key);
    if (!previous) {
      merged.set(key, segment);
      continue;
    }
    merged.set(key, {
      ...previous,
      flow: Math.max(previous.flow, segment.flow),
      magnitude: Math.max(previous.magnitude, segment.magnitude),
      order: Math.max(previous.order, segment.order),
      width: Math.max(previous.width, segment.width),
      mouth: previous.mouth || segment.mouth,
    });
  }
  return [...merged.values()];
}

function finalizeRiverNetwork(
  rivers: GeneratedRiverSegment[],
  worldWidth: number,
  worldHeight: number,
  gridWidth: number,
  gridHeight: number,
): GeneratedRiverSegment[] {
  return mergeCoincidentRiverCorridors(
    enforceRiverMinimumLengths(rivers, worldWidth, worldHeight, gridWidth, gridHeight),
    worldWidth,
    worldHeight,
    gridWidth,
    gridHeight,
  );
}

function enforceRiverMinimumLengths(
  rivers: GeneratedRiverSegment[],
  worldWidth: number,
  worldHeight: number,
  gridWidth: number,
  gridHeight: number,
): GeneratedRiverSegment[] {
  const cellSize = Math.max(worldWidth / Math.max(1, gridWidth), worldHeight / Math.max(1, gridHeight));
  const lengths = new Map<number, number>();
  for (const segment of rivers) {
    const key = segment.riverId ?? segment.basinId;
    const length = Math.hypot(segment.end.x - segment.start.x, segment.end.y - segment.start.y);
    lengths.set(key, (lengths.get(key) ?? 0) + length);
  }
  return rivers.map((segment) => {
    const key = segment.riverId ?? segment.basinId;
    const totalLength = lengths.get(key) ?? 0;
    const required = cellSize * (segment.order >= 5 ? 34 : segment.order === 4 ? 24 : segment.order === 3 ? 15 : segment.order === 2 ? 8 : 3);
    if (totalLength >= required) return segment;
    const ratio = Math.max(0.18, totalLength / Math.max(cellSize, required));
    const orderCap = totalLength >= cellSize * 15 ? 3 : totalLength >= cellSize * 8 ? 2 : 1;
    return {
      ...segment,
      order: Math.min(segment.order, orderCap),
      width: Math.min(segment.width, 0.55 + Math.sqrt(Math.max(1, segment.magnitude)) * 0.28 + ratio * 0.75),
    };
  });
}

function createGuidedRiverSegments(
  settings: GeneratorSettings,
  worldWidth: number,
  worldHeight: number,
): GeneratedRiverSegment[] {
  if ((settings.mapScope !== "local" && settings.mapScope !== "regional") || settings.localRegionType !== "river") return [];
  const path = guidedNormalizedPath(settings.riverGuide, settings.seed + 997).map((point) => ({
    x: point.x * worldWidth,
    y: point.y * worldHeight,
  }));
  const sampled = resamplePath(path, Math.max(worldWidth, worldHeight) / 90);
  const rivers: GeneratedRiverSegment[] = [];
  for (let index = 1; index < sampled.length; index += 1) {
    const progress = index / Math.max(1, sampled.length - 1);
    rivers.push({
      start: sampled[index - 1],
      end: sampled[index],
      flow: 1 + progress * 6,
      magnitude: Math.max(1, Math.round(1 + progress * 5)),
      width: 0.75 + progress * 2.8,
      order: Math.max(1, Math.round(1 + progress * 3)),
      basinId: -10,
      mouth: index === sampled.length - 1,
      riverId: -10,
      sequence: index - 1,
    });
  }
  return rivers;
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
    const normalizedResult = normalizeElevation(
      repaired,
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
  let elevationMap = stabilized.map((value) => {
    if (value < 0.5)
      return Math.round(seaLevel - 4200 * Math.pow((0.5 - value) / 0.5, 1.22));
    return Math.round(
      seaLevel +
        effectiveSettings.maxElevation * Math.pow((value - 0.5) / 0.5, 2.15),
    );
  });
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
  const environment = calculateEnvironment(
    elevationMap,
    width,
    height,
    seaLevel,
    effectiveSettings,
  );
  const hydrology = buildHydrology(
    elevationMap,
    environment.runoffMap,
    width,
    height,
    seaLevel,
    worldWidth,
    worldHeight,
    effectiveSettings,
  );
  const guidedRivers = createGuidedRiverSegments(
    effectiveSettings,
    worldWidth,
    worldHeight,
  );
  const waterTypeMap = [...initialWaterTypeMap];
  for (let index = 0; index < waterTypeMap.length; index += 1)
    if ((hydrology.freshwaterLakeMap[index] ?? 0) > 0)
      waterTypeMap[index] = "freshwater";
  enforceLocalBoundaryWaterTypes(waterTypeMap, width, height, effectiveSettings);
  const landMask = waterTypeMap.map((type) => (type === "land" ? 1 : 0));
  const actualContinentCount = landComponents(
    landMask.map((value) => value >= 0.5),
    width,
    height,
  ).length;
  const terrainMap = refineTerrainWithWaterAccess(
    environment.terrainMap,
    elevationMap,
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
  const contours: GeneratedContourSegment[] = [];
  let minimumElevation = Number.POSITIVE_INFINITY;
  for (const value of elevationMap)
    minimumElevation = Math.min(minimumElevation, value);
  const contourStart =
    Math.floor(minimumElevation / effectiveSettings.contourInterval) *
    effectiveSettings.contourInterval;
  for (
    let elevation = contourStart;
    elevation < effectiveSettings.maxElevation;
    elevation += effectiveSettings.contourInterval
  ) {
    if (elevation === seaLevel) continue;
    const segments = extractSegments(
      elevationMap,
      width,
      height,
      elevation,
      worldWidth,
      worldHeight,
    );
    const isMajor =
      Math.abs(elevation) % (effectiveSettings.contourInterval * 5) === 0;
    const curvedSegments = curveSegmentNetwork(
      segments,
      Math.max(worldWidth / width, worldHeight / height) * (quality === "preview" ? 0.85 : 0.38),
      true,
      quality,
    );
    for (const segment of curvedSegments)
      contours.push({ ...segment, elevation, isMajor });
  }

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
    snowCoverMap: environment.snowCoverMap,
    snowBaseTerrainMap: terrainMap.map((terrain, index) =>
      terrain === "snow"
        ? (environment.snowBaseTerrainMap[index] ?? "mountain")
        : terrain,
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
    rivers: finalizeRiverNetwork([...hydrology.rivers, ...guidedRivers], worldWidth, worldHeight, width, height),
    generatedAt: new Date().toISOString(),
    environmentModel: { engine: "builtin", version: "0.99u-grid-atlas-hierarchical-hydrology" },
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
  const environment = calculateEnvironment(
    elevationMap,
    width,
    height,
    nextSeaLevel,
    settings,
  );
  const initialWaterTypeMap = classifyWaterBodies(
    elevationMap,
    width,
    height,
    nextSeaLevel,
    settings,
  );
  const contours: GeneratedContourSegment[] = [];
  let minimumElevation = Number.POSITIVE_INFINITY;
  for (const value of elevationMap)
    minimumElevation = Math.min(minimumElevation, value);
  let maximumElevation = settings.maxElevation;
  for (const value of elevationMap)
    maximumElevation = Math.max(maximumElevation, value);
  const contourStart =
    Math.floor(minimumElevation / settings.contourInterval) *
    settings.contourInterval;
  for (
    let elevation = contourStart;
    elevation < maximumElevation;
    elevation += settings.contourInterval
  ) {
    if (elevation === nextSeaLevel) continue;
    const segments = extractSegments(
      elevationMap,
      width,
      height,
      elevation,
      source.worldWidth,
      source.worldHeight,
    );
    const isMajor = Math.abs(elevation) % (settings.contourInterval * 5) === 0;
    const curvedSegments = curveSegmentNetwork(
      segments,
      Math.max(source.worldWidth / width, source.worldHeight / height) * 0.1,
      true,
    );
    for (const segment of curvedSegments)
      contours.push({ ...segment, elevation, isMajor });
  }
  let actualContinentCount = 0;
  const hydrology = buildHydrology(
    elevationMap,
    environment.runoffMap,
    width,
    height,
    nextSeaLevel,
    source.worldWidth,
    source.worldHeight,
    settings,
  );
  const guidedRivers = createGuidedRiverSegments(settings, source.worldWidth, source.worldHeight);
  const waterTypeMap = [...initialWaterTypeMap];
  for (let index = 0; index < waterTypeMap.length; index += 1)
    if ((hydrology.freshwaterLakeMap[index] ?? 0) > 0)
      waterTypeMap[index] = "freshwater";
  enforceLocalBoundaryWaterTypes(waterTypeMap, width, height, settings);
  const rawTerrainMap = terrainOverride
    ? [...terrainOverride]
    : refineTerrainWithWaterAccess(
        environment.terrainMap,
        elevationMap,
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
    elevationMap,
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
  const validation = validateGeneratedResult(
    elevationMap,
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
    elevationMap: [...elevationMap],
    landMask: waterTypeMap.map((type) => (type === "land" ? 1 : 0)),
    waterTypeMap,
    coastalTerrainMap,
    baseTerrainMap: [...terrainMap],
    agricultureMap,
    terrainMap,
    snowCoverMap: terrainOverride
      ? source.snowCoverMap
      : environment.snowCoverMap,
    snowBaseTerrainMap: terrainOverride
      ? terrainMap.map((terrain, index) =>
          terrain === "snow"
            ? (source.snowBaseTerrainMap?.[index] ?? "mountain")
            : terrain,
        )
      : environment.snowBaseTerrainMap,
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
    rivers: finalizeRiverNetwork([...hydrology.rivers, ...guidedRivers], source.worldWidth, source.worldHeight, source.gridWidth, source.gridHeight),
    actualContinentCount,
    qualityScore: validation.score,
    qualityIssues: validation.issues,
    generatedAt: new Date().toISOString(),
  };
}
