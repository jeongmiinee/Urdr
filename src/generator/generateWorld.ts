import type {
  GeneratedContourSegment,
  GeneratedMapData,
  GeneratedRiverSegment,
  GeneratorSettings,
  LineSegment,
  Point,
  TerrainType,
  WaterType,
  CoastalTerrainType,
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
import { buildSurfaceRegions } from "./surfaceVectors";

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

function segmentDistance(px: number, py: number, a: Point, b: Point): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const lengthSquared = abx * abx + aby * aby;
  if (lengthSquared <= 1e-9) return Math.hypot(px - a.x, py - a.y);
  const t = clamp(((px - a.x) * abx + (py - a.y) * aby) / lengthSquared);
  return Math.hypot(px - (a.x + abx * t), py - (a.y + aby * t));
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

function classifyTerrain(
  elevation: number,
  temperature: number,
  moisture: number,
  maxElevation: number,
  seaLevel = 0,
): TerrainType {
  const relativeElevation = elevation - seaLevel;
  const normalizedElevation =
    Math.max(0, relativeElevation) / Math.max(1, maxElevation - seaLevel);
  // 수면 아래에도 해저 지형과 등고가 존재하며, 물 표시는 렌더 단계에서 덮어쓴다.
  if (relativeElevation < -1800) return "bedrock";
  if (relativeElevation < 0) return relativeElevation < -450 ? "rock" : "plain";
  if (temperature < 0.16 && relativeElevation > 250) return "snow";
  if (normalizedElevation > 0.78) return "snow";
  if (normalizedElevation > 0.58) return "mountain";
  if (normalizedElevation > 0.46 && moisture < 0.38) return "bedrock";
  if (normalizedElevation > 0.38 && moisture < 0.48) return "rock";
  if (temperature > 0.68 && moisture > 0.66) return "jungle";
  if (temperature > 0.58 && moisture < 0.3) return "desert";
  if (moisture > 0.62) return "forest";
  if (moisture > 0.46) return "grassland";
  if (moisture > 0.34 && relativeElevation < 260) return "grassland";
  return "plain";
}

type Component = { cells: number[]; size: number };

function landComponents(
  mask: boolean[],
  width: number,
  height: number,
): Component[] {
  const visited = new Uint8Array(mask.length);
  const components: Component[] = [];
  const queue = new Int32Array(mask.length);
  const directions = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const;
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || visited[start]) continue;
    let head = 0;
    let tail = 0;
    const cells: number[] = [];
    visited[start] = 1;
    queue[tail++] = start;
    while (head < tail) {
      const index = queue[head++];
      cells.push(index);
      const x = index % width;
      const y = Math.floor(index / width);
      for (const [dx, dy] of directions) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const next = ny * width + nx;
        if (mask[next] && !visited[next]) {
          visited[next] = 1;
          queue[tail++] = next;
        }
      }
    }
    components.push({ cells, size: cells.length });
  }
  return components.sort((a, b) => b.size - a.size);
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
function classifyWaterBodies(
  elevation: number[],
  width: number,
  height: number,
  seaLevel: number,
  settings: GeneratorSettings,
): WaterType[] {
  const result = new Array<WaterType>(elevation.length).fill("land");
  const salt = new Uint8Array(elevation.length);
  const queue = new Int32Array(elevation.length);
  let head = 0;
  let tail = 0;
  const enqueue = (index: number) => {
    if (elevation[index] > seaLevel || salt[index]) return;
    salt[index] = 1;
    queue[tail++] = index;
  };
  for (let x = 0; x < width; x += 1) {
    enqueue(x);
    enqueue((height - 1) * width + x);
  }
  for (let y = 0; y < height; y += 1) {
    enqueue(y * width);
    enqueue(y * width + width - 1);
  }
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const;
  while (head < tail) {
    const index = queue[head++];
    const x = index % width,
      y = Math.floor(index / width);
    for (const [dx, dy] of dirs) {
      const nx = x + dx,
        ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      enqueue(ny * width + nx);
    }
  }
  for (let index = 0; index < elevation.length; index += 1) {
    if (elevation[index] > seaLevel) result[index] = "land";
    else result[index] = salt[index] ? "saltwater" : "freshwater";
  }
  // 내해형의 가장 큰 내부 수역은 명칭과 지질 설정에 맞게 해수로 취급한다.
  if (settings.mapShape === "inland_sea") {
    const visited = new Uint8Array(elevation.length);
    let largest: number[] = [];
    for (let start = 0; start < elevation.length; start += 1) {
      if (result[start] !== "freshwater" || visited[start]) continue;
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
        for (const [dx, dy] of dirs) {
          const nx = x + dx,
            ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const next = ny * width + nx;
          if (result[next] === "freshwater" && !visited[next]) {
            visited[next] = 1;
            queue[tail++] = next;
          }
        }
      }
      if (cells.length > largest.length) largest = cells;
    }
    for (const index of largest) result[index] = "saltwater";
  }
  return result;
}

/** 육지 존재 여부와 고도를 분리하되, 골자 알고리즘의 상대 기복은 보존한다. */
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

type HydrologyResult = {
  rivers: GeneratedRiverSegment[];
  flowAccumulationMap: number[];
  basinMap: number[];
  riverOrderMap: number[];
  riverMagnitudeMap: number[];
  /** 육지 내부에서 끝난 하천이 형성한 담수호 타일. */
  freshwaterLakeMap: number[];
  /** 각 격자가 속한 호수 ID. 호수가 아니면 -1. */
  lakeIdMap: number[];
  /** 호수 ID별 동일 수면 고도. */
  lakeSurfaceElevations: number[];
};

class CellMinHeap {
  private items: Array<{ index: number; priority: number }> = [];

  push(item: { index: number; priority: number }): void {
    let cursor = this.items.length;
    this.items.push(item);
    while (cursor > 0) {
      const parent = Math.floor((cursor - 1) / 2);
      if (this.items[parent].priority <= item.priority) break;
      this.items[cursor] = this.items[parent];
      cursor = parent;
    }
    this.items[cursor] = item;
  }

  pop(): { index: number; priority: number } | undefined {
    if (this.items.length === 0) return undefined;
    const root = this.items[0];
    const last = this.items.pop()!;
    if (this.items.length > 0) {
      let cursor = 0;
      while (true) {
        const left = cursor * 2 + 1;
        const right = left + 1;
        if (left >= this.items.length) break;
        const child =
          right < this.items.length &&
          this.items[right].priority < this.items[left].priority
            ? right
            : left;
        if (this.items[child].priority >= last.priority) break;
        this.items[cursor] = this.items[child];
        cursor = child;
      }
      this.items[cursor] = last;
    }
    return root;
  }

  get length(): number {
    return this.items.length;
  }
}

/** Priority-Flood 방식으로 폐쇄 함몰지를 수문학적으로 연결한다. 원래 지형은 변경하지 않고 흐름 계산면만 만든다. */
function fillDepressions(
  elevation: number[],
  width: number,
  height: number,
  seaLevel: number,
): Float64Array {
  const filled = Float64Array.from(elevation);
  const visited = new Uint8Array(elevation.length);
  const heap = new CellMinHeap();
  const enqueue = (index: number) => {
    if (visited[index]) return;
    visited[index] = 1;
    heap.push({ index, priority: filled[index] });
  };

  // 바다와 지도 외곽은 배수구다. 지역 지도에서는 하천이 지도 밖으로 빠질 수도 있다.
  for (let index = 0; index < elevation.length; index += 1) {
    const x = index % width;
    const y = Math.floor(index / width);
    if (
      elevation[index] <= seaLevel ||
      x === 0 ||
      y === 0 ||
      x === width - 1 ||
      y === height - 1
    )
      enqueue(index);
  }

  const offsets = [
    [-1, -1],
    [0, -1],
    [1, -1],
    [-1, 0],
    [1, 0],
    [-1, 1],
    [0, 1],
    [1, 1],
  ] as const;
  while (heap.length) {
    const current = heap.pop()!;
    const x = current.index % width;
    const y = Math.floor(current.index / width);
    for (const [dx, dy] of offsets) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const next = ny * width + nx;
      if (visited[next]) continue;
      visited[next] = 1;
      if (elevation[next] > seaLevel) {
        // 아주 작은 기울기를 보장해 평탄한 호수 가장자리에서도 하류가 결정되게 한다.
        filled[next] = Math.max(elevation[next], current.priority + 0.001);
      }
      heap.push({ index: next, priority: filled[next] });
    }
  }
  return filled;
}

function quantile(values: number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.max(
      0,
      Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio)),
    )
  ];
}

function buildHydrology(
  elevation: number[],
  runoffMap: number[],
  width: number,
  height: number,
  seaLevel: number,
  worldWidth: number,
  worldHeight: number,
  settings: GeneratorSettings,
): HydrologyResult {
  type RiverNode = {
    id: number;
    index: number;
    x: number;
    y: number;
    elevation: number;
    coastal: boolean;
    lake: boolean;
  };
  type RiverEdge = {
    sourceId: number;
    targetId: number;
    path: number[];
    basinId: number;
  };
  const filled = fillDepressions(elevation, width, height, seaLevel);
  const receiver = new Int32Array(elevation.length);
  receiver.fill(-1);
  const naturalReceiver = new Int32Array(elevation.length);
  naturalReceiver.fill(-1);
  const offsets = [
    [-1, -1],
    [0, -1],
    [1, -1],
    [-1, 0],
    [1, 0],
    [-1, 1],
    [0, 1],
    [1, 1],
  ] as const;
  for (let index = 0; index < elevation.length; index += 1) {
    if (elevation[index] <= seaLevel) continue;
    const x = index % width,
      y = Math.floor(index / width);
    let best = -1,
      bestSlope = -Infinity;
    let naturalBest = -1,
      naturalSlope = 0;
    for (const [dx, dy] of offsets) {
      const nx = x + dx,
        ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const candidate = ny * width + nx;
      const distance = dx === 0 || dy === 0 ? 1 : Math.SQRT2;
      const slope = (filled[index] - filled[candidate]) / distance;
      if (
        slope > bestSlope + 1e-9 ||
        (Math.abs(slope - bestSlope) <= 1e-9 && candidate < best)
      ) {
        bestSlope = slope;
        best = candidate;
      }
      const originalSlope =
        (elevation[index] - elevation[candidate]) / distance;
      if (originalSlope > naturalSlope + 1e-9) {
        naturalSlope = originalSlope;
        naturalBest = candidate;
      }
    }
    naturalReceiver[index] = naturalBest;
    if (
      best >= 0 &&
      (filled[best] < filled[index] - 1e-9 || elevation[best] <= seaLevel)
    )
      receiver[index] = best;
  }

  // 1차 배수량을 계산한 뒤, 같은 하강 후보 중 기존 흐름이 큰 셀을 더 선호해 지류의 합류성을 높인다.
  const flowHint = new Float64Array(elevation.length);
  for (let index = 0; index < elevation.length; index += 1)
    flowHint[index] = Math.max(
      0.15,
      Math.log1p(Math.max(0, runoffMap[index] ?? 0)),
    );
  const drainageOrder = Array.from(
    { length: elevation.length },
    (_, index) => index,
  ).sort((a, b) => filled[b] - filled[a]);
  for (const index of drainageOrder) {
    const target = receiver[index];
    if (target >= 0) flowHint[target] += flowHint[index];
  }
  const confluenceScale = Math.max(4, settings.contourInterval * 0.07);
  for (let index = 0; index < elevation.length; index += 1) {
    if (elevation[index] <= seaLevel) continue;
    const x = index % width,
      y = Math.floor(index / width);
    let best = receiver[index],
      bestScore = -Infinity;
    for (const [dx, dy] of offsets) {
      const nx = x + dx,
        ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const candidate = ny * width + nx;
      const distance = dx === 0 || dy === 0 ? 1 : Math.SQRT2;
      const slope = (filled[index] - filled[candidate]) / distance;
      if (slope <= 1e-9 && elevation[candidate] > seaLevel) continue;
      const mergeBonus = Math.log1p(flowHint[candidate]) * confluenceScale;
      const score = slope + mergeBonus;
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    }
    if (best >= 0) receiver[index] = best;
  }

  const isCoast = (index: number) => {
    if (elevation[index] <= seaLevel) return false;
    const x = index % width,
      y = Math.floor(index / width);
    return (
      [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const
    ).some(([dx, dy]) => {
      const nx = x + dx,
        ny = y + dy;
      return (
        nx >= 0 &&
        ny >= 0 &&
        nx < width &&
        ny < height &&
        elevation[ny * width + nx] <= seaLevel
      );
    });
  };
  const coastCells: number[] = [];
  const landCells: number[] = [];
  for (let i = 0; i < elevation.length; i += 1) {
    if (elevation[i] > seaLevel) {
      landCells.push(i);
      if (isCoast(i)) coastCells.push(i);
    }
  }
  const random = mulberry32((settings.seed ^ 0x5a17c9e3) >>> 0);
  const configuredNodes =
    settings.riverNodeCount ?? Math.sqrt(landCells.length) * 0.35;
  const desired = Math.max(
    12,
    Math.min(1800, Math.round(configuredNodes * 1.35)),
  );
  const maxNodeElevation = Math.max(
    seaLevel + 50,
    Math.min(
      settings.maxElevation,
      settings.riverNodeMaxElevation ?? settings.maxElevation * 0.55,
    ),
  );
  const candidateCells = landCells.filter(
    (index) => elevation[index] <= maxNodeElevation && !isCoast(index),
  );
  const baseSpacing = Math.max(
    1.35,
    Math.sqrt(Math.max(1, candidateCells.length) / Math.max(1, desired)) * 0.52,
  );
  const ranked = candidateCells
    .map((index) => {
      const x = index % width,
        y = Math.floor(index / width);
      let lower = 0;
      for (const [dx, dy] of offsets) {
        const nx = x + dx,
          ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        if (filled[ny * width + nx] < filled[index]) lower += 1;
      }
      const wet = Math.max(0, runoffMap[index] ?? 0);
      const elevationRatio = clamp(
        (elevation[index] - seaLevel) /
          Math.max(1, maxNodeElevation - seaLevel),
      );
      const headwaterBias = 0.28 + elevationRatio * 1.18;
      const score =
        (0.12 + Math.log1p(wet) * 0.1 + lower * 0.07 + headwaterBias * 0.48) *
        (0.74 + random() * 0.52);
      return { index, score, elevationRatio };
    })
    .sort((a, b) => b.score - a.score);
  const selected: number[] = [];
  const bandCounts = [0, 0, 0];
  const bandTargets = [
    Math.round(desired * 0.18),
    Math.round(desired * 0.3),
    desired - Math.round(desired * 0.18) - Math.round(desired * 0.3),
  ];
  const bandOf = (ratio: number) => (ratio < 0.34 ? 0 : ratio < 0.66 ? 1 : 2);
  for (const row of ranked) {
    if (selected.length >= desired) break;
    const band = bandOf(row.elevationRatio);
    if (bandCounts[band] >= bandTargets[band]) continue;
    const x = row.index % width,
      y = Math.floor(row.index / width);
    const spacing = baseSpacing * (1.22 - row.elevationRatio * 0.58);
    let ok = true;
    for (const other of selected) {
      const ox = other % width,
        oy = Math.floor(other / width);
      if (Math.hypot(x - ox, y - oy) < spacing) {
        ok = false;
        break;
      }
    }
    if (ok) {
      selected.push(row.index);
      bandCounts[band] += 1;
    }
  }
  for (const row of ranked) {
    if (selected.length >= desired) break;
    if (selected.includes(row.index)) continue;
    const x = row.index % width,
      y = Math.floor(row.index / width);
    const spacing = baseSpacing * (1.05 - row.elevationRatio * 0.48);
    let ok = true;
    for (const other of selected) {
      const ox = other % width,
        oy = Math.floor(other / width);
      if (Math.hypot(x - ox, y - oy) < spacing) {
        ok = false;
        break;
      }
    }
    if (ok) selected.push(row.index);
  }

  const coastTargetCount = Math.max(
    12,
    Math.min(240, Math.round(Math.sqrt(Math.max(1, coastCells.length)) * 1.7)),
  );
  const coastStride = Math.max(
    1,
    Math.floor(coastCells.length / Math.max(1, coastTargetCount)),
  );
  const sampledCoast = coastCells
    .filter((_, i) => i % coastStride === 0)
    .slice(0, coastTargetCount * 2);
  const nodes: RiverNode[] = [];
  const freshwaterLakeMap = new Uint8Array(elevation.length);
  const lakeIdMap = new Int32Array(elevation.length);
  lakeIdMap.fill(-1);
  const lakeSurfaceElevations: number[] = [];
  const lakeNodeByCell = new Map<number, number>();
  const addNode = (index: number, coastal: boolean, lake = false) => {
    const id = nodes.length;
    nodes.push({
      id,
      index,
      x: index % width,
      y: Math.floor(index / width),
      elevation: elevation[index],
      coastal,
      lake,
    });
    return id;
  };
  const internalIds = selected.map((index) => addNode(index, false));
  const coastIds = sampledCoast.map((index) => addNode(index, true));
  const cellNodeIds = new Map<number, number[]>();
  for (const node of nodes) {
    const list = cellNodeIds.get(node.index) ?? [];
    list.push(node.id);
    cellNodeIds.set(node.index, list);
  }
  const runoffThreshold = quantile(
    landCells.map((index) => Math.max(0, runoffMap[index] ?? 0)),
    0.62,
  );
  const terminalFlowThreshold = quantile(
    landCells.map((index) => Math.max(0, flowHint[index] ?? 0)),
    0.78,
  );
  const lakeNodeCells = new Map<number, Set<number>>();
  const acceptedLakeCenters: Array<{ index: number; radius: number }> = [];
  const maxLakeCount = Math.max(
    1,
    Math.min(
      settings.mapScope === "local" || settings.mapScope === "regional" ? 8 : 18,
      Math.round(landCells.length / (settings.mapScope === "local" ? 18_000 : 14_000)),
    ),
  );
  const maxLakeCellTotal = Math.max(
    12,
    Math.floor(landCells.length * (settings.mapScope === "local" || settings.mapScope === "regional" ? 0.012 : 0.02)),
  );
  let lakeCellTotal = 0;

  const createLakeNode = (sink: number, upstream?: number): number | undefined => {
    const existing = lakeNodeByCell.get(sink);
    if (existing !== undefined) return existing;
    if (acceptedLakeCenters.length >= maxLakeCount || lakeCellTotal >= maxLakeCellTotal) return undefined;

    const inflow = Math.max(runoffMap[sink] ?? 0, flowHint[sink] ?? 0);
    const minimumInflow = Math.max(4, runoffThreshold * 0.72, terminalFlowThreshold * 0.24);
    if (inflow < minimumInflow) return undefined;

    // 호수 규모는 종점 강폭뿐 아니라 유량·집수 규모·분지 경사·강수·지도 규모를 함께 반영한다.
    const terminalWidth = 0.5 + Math.min(5.5, Math.log1p(inflow) * 0.72);
    const sx0 = sink % width, sy0 = Math.floor(sink / width);
    const neighborhood:number[]=[];
    for(let oy=-4;oy<=4;oy+=1)for(let ox=-4;ox<=4;ox+=1){const nx=sx0+ox,ny=sy0+oy;if(nx>=0&&ny>=0&&nx<width&&ny<height)neighborhood.push(ny*width+nx);}
    const localRelief = neighborhood.length ? Math.max(...neighborhood.map(i=>elevation[i]))-Math.min(...neighborhood.map(i=>elevation[i])) : 0;
    const slopeRetention = 1 - clamp(localRelief / Math.max(200, settings.maxElevation * 0.18),0,0.72);
    const catchmentFactor = Math.min(2.2, Math.log1p(flowHint[sink] ?? inflow) / 4.2);
    const precipitationFactor = clamp(settings.basePrecipitationMm / 1200,0.55,1.6);
    const scaleFactor = clamp(Math.sqrt(Math.max(1,settings.mapScaleKm)/500),0.65,1.45);
    const shapeJitter = 0.84 + fractalNoise(sx0*0.11,sy0*0.11,settings.seed+91_771,3,0.55,2.05)*0.34;
    const radius = Math.max(2, Math.min(18, Math.round((1.6 + terminalWidth * 1.05 + catchmentFactor * 2.1) * slopeRetention * precipitationFactor * scaleFactor * shapeJitter)));
    const sx = sink % width;
    const sy = Math.floor(sink / width);
    if (acceptedLakeCenters.some((lake) => {
      const lx = lake.index % width;
      const ly = Math.floor(lake.index / width);
      return Math.hypot(lx - sx, ly - sy) < (lake.radius + radius) * 2.2;
    })) return undefined;

    const contourStep = Math.max(1, settings.contourInterval);
    // 호수는 해수면보다 높을 수 있지만, 하나의 호수는 정확히 하나의 등고 수면만 공유한다.
    const surfaceLevel = Math.max(
      seaLevel + Math.max(1, contourStep * 0.05),
      Math.ceil((elevation[sink] + Math.max(1, contourStep * 0.02)) / contourStep) * contourStep,
    );
    const cells: number[] = [];
    const localQueue = [sink];
    const visited = new Set<number>([sink]);
    const carveAllowance = Math.max(3, Math.min(contourStep * 0.2, 42));
    const maxCellsForLake = Math.min(
      maxLakeCellTotal - lakeCellTotal,
      Math.max(14, Math.round(Math.PI * radius * radius * 1.25)),
    );
    const ux = upstream === undefined ? sx - 1 : upstream % width;
    const uy = upstream === undefined ? sy : Math.floor(upstream / width);
    const directionLength = Math.max(1e-6, Math.hypot(sx - ux, sy - uy));
    const dirX = (sx - ux) / directionLength;
    const dirY = (sy - uy) / directionLength;

    while (localQueue.length && cells.length < maxCellsForLake) {
      const index = localQueue.shift()!;
      const x = index % width;
      const y = Math.floor(index / width);
      const dx = x - sx;
      const dy = y - sy;
      const along = dx * dirX + dy * dirY;
      const across = -dx * dirY + dy * dirX;
      const noise = fractalNoise(x * 0.17, y * 0.17, settings.seed + 81_271 + acceptedLakeCenters.length * 997, 3, 0.56, 2.1);
      const localRadius = radius * (0.72 + noise * 0.48);
      const normalizedDistance = Math.hypot(along / 1.14, across / 0.9);
      if (
        normalizedDistance > localRadius ||
        elevation[index] <= seaLevel ||
        elevation[index] > surfaceLevel + carveAllowance
      ) continue;
      cells.push(index);
      for (const [ox, oy] of offsets) {
        const nx = x + ox;
        const ny = y + oy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const next = ny * width + nx;
        if (!visited.has(next)) {
          visited.add(next);
          localQueue.push(next);
        }
      }
    }

    // 우연한 한두 칸짜리 싱크와 작은 치즈 구멍은 호수로 승격하지 않는다.
    const minimumCells = Math.max(5, Math.round(radius * 1.8));
    if (cells.length < minimumCells) return undefined;
    const cellSet = new Set(cells);
    const boundaryCells = cells.filter((cell) => {
      const x = cell % width;
      const y = Math.floor(cell / width);
      return offsets.some(([ox, oy]) => {
        const nx = x + ox;
        const ny = y + oy;
        return nx < 0 || ny < 0 || nx >= width || ny >= height || !cellSet.has(ny * width + nx);
      });
    });
    const inletCell = boundaryCells.reduce((best, cell) => {
      if (upstream === undefined) return best;
      const x = cell % width;
      const y = Math.floor(cell / width);
      const bestX = best % width;
      const bestY = Math.floor(best / width);
      return Math.hypot(x - ux, y - uy) < Math.hypot(bestX - ux, bestY - uy) ? cell : best;
    }, boundaryCells[0] ?? sink);
    // 강의 종점 노드는 호수 내부가 아니라 유입 직전의 육지 경계에 둔다.
    const inletX=inletCell%width,inletY=Math.floor(inletCell/width);
    const outsideCandidates=offsets.map(([ox,oy])=>[inletX+ox,inletY+oy] as const)
      .filter(([x,y])=>x>=0&&y>=0&&x<width&&y<height&&!cellSet.has(y*width+x)&&elevation[y*width+x]>seaLevel)
      .map(([x,y])=>y*width+x);
    const inlet=outsideCandidates.sort((a,b)=>Math.hypot(a%width-ux,Math.floor(a/width)-uy)-Math.hypot(b%width-ux,Math.floor(b/width)-uy))[0] ?? (upstream !== undefined && !cellSet.has(upstream) ? upstream : inletCell);

    const lakeId = lakeSurfaceElevations.length;
    lakeSurfaceElevations.push(surfaceLevel);
    const bedDepth = Math.max(2, Math.min(36, contourStep * 0.12));
    for (const cell of cells) {
      elevation[cell] = Math.min(elevation[cell], surfaceLevel - bedDepth);
      freshwaterLakeMap[cell] = 1;
      lakeIdMap[cell] = lakeId;
      lakeNodeByCell.set(cell, nodes.length);
    }
    const id = addNode(inlet, false, true);
    for (const cell of cells) lakeNodeByCell.set(cell, id);
    lakeNodeCells.set(id, cellSet);
    acceptedLakeCenters.push({ index: sink, radius });
    lakeCellTotal += cells.length;
    const list = cellNodeIds.get(inlet) ?? [];
    list.push(id);
    cellNodeIds.set(inlet, list);
    return id;
  };
  const nearestCoastNode = (index: number): number | undefined => {
    const x = index % width,
      y = Math.floor(index / width);
    let best: number | undefined,
      bestD = Infinity;
    for (const id of coastIds) {
      const n = nodes[id];
      const d = (n.x - x) * (n.x - x) + (n.y - y) * (n.y - y);
      if (d < bestD) {
        bestD = d;
        best = id;
      }
    }
    return best;
  };
  const nearbyLowerNode = (
    index: number,
    sourceId: number,
    radius = 3,
  ): number | undefined => {
    const x = index % width,
      y = Math.floor(index / width),
      currentElevation = elevation[index];
    let best: number | undefined,
      bestScore = Infinity;
    for (let dy = -radius; dy <= radius; dy += 1)
      for (let dx = -radius; dx <= radius; dx += 1) {
        const nx = x + dx,
          ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        for (const id of cellNodeIds.get(ny * width + nx) ?? []) {
          if (id === sourceId) continue;
          const n = nodes[id];
          if (!n.coastal && !n.lake && n.elevation >= currentElevation - 0.001)
            continue;
          const d = dx * dx + dy * dy;
          const attraction = 1 + Math.log1p(flowHint[n.index] ?? 0) * 0.9;
          const score = d / attraction;
          if (score < bestScore) {
            bestScore = score;
            best = id;
          }
        }
      }
    return best;
  };

  const rawEdges: RiverEdge[] = [];
  for (const sourceId of internalIds) {
    const source = nodes[sourceId];
    const path = [source.index];
    const seen = new Set<number>(path);
    let current = source.index,
      targetId: number | undefined;
    const maxSteps = width * height;
    for (let step = 0; step < maxSteps; step += 1) {
      const sourceRatio = clamp(
        (source.elevation - seaLevel) /
          Math.max(1, maxNodeElevation - seaLevel),
      );
      const snapRadius = sourceRatio > 0.65 ? 6 : sourceRatio > 0.35 ? 5 : 4;
      const snap =
        step > 1 ? nearbyLowerNode(current, sourceId, snapRadius) : undefined;
      if (snap !== undefined) {
        targetId = snap;
        break;
      }
      if (step > 1 && naturalReceiver[current] < 0) {
        const lake = createLakeNode(current, path[path.length - 2]);
        if (lake !== undefined) {
          targetId = lake;
          break;
        }
      }
      const next = receiver[current];
      if (next < 0 || seen.has(next)) {
        const lake = createLakeNode(current, path[path.length - 2]);
        if (lake !== undefined) targetId = lake;
        break;
      }
      if (elevation[next] <= seaLevel) {
        targetId = nearestCoastNode(current);
        break;
      }
      path.push(next);
      seen.add(next);
      current = next;
      if (isCoast(current)) {
        targetId = nearestCoastNode(current);
        break;
      }
    }
    if (targetId === undefined) continue;
    const target = nodes[targetId];
    if (target.lake) {
      const lakeCells = lakeNodeCells.get(targetId);
      if (lakeCells) while (path.length > 1 && lakeCells.has(path[path.length - 1])) path.pop();
    }
    if (target.lake) {
      const lakeCells=lakeNodeCells.get(targetId);
      while(path.length>1 && lakeCells?.has(path[path.length-1])) path.pop();
      if(!lakeCells?.has(target.index) && path[path.length-1]!==target.index) path.push(target.index);
    } else if (path[path.length - 1] !== target.index) path.push(target.index);
    rawEdges.push({ sourceId, targetId, path, basinId: -1 });
  }

  const bySource = new Map(rawEdges.map((edge) => [edge.sourceId, edge]));
  const reachesOutlet = (sourceId: number): boolean => {
    const seen = new Set<number>();
    let current = sourceId;
    while (!seen.has(current)) {
      seen.add(current);
      const node = nodes[current];
      if (node?.coastal || node?.lake) return true;
      const edge = bySource.get(current);
      if (!edge) return false;
      current = edge.targetId;
    }
    return false;
  };
  const edges = rawEdges.filter((edge) => reachesOutlet(edge.sourceId));
  const validSource = new Set(edges.map((edge) => edge.sourceId));
  const basinForCoast = new Map<number, number>();
  let nextBasin = 0;
  const edgeBasin = (edge: RiverEdge): number => {
    let current = edge.targetId;
    const seen = new Set<number>();
    while (!seen.has(current)) {
      seen.add(current);
      if (nodes[current]?.coastal || nodes[current]?.lake) {
        if (!basinForCoast.has(current))
          basinForCoast.set(current, nextBasin++);
        return basinForCoast.get(current)!;
      }
      const next = bySource.get(current);
      if (!next) break;
      current = next.targetId;
    }
    return nextBasin++;
  };
  for (const edge of edges) edge.basinId = edgeBasin(edge);

  const incoming = new Map<number, number[]>();
  for (const edge of edges) {
    const list = incoming.get(edge.targetId) ?? [];
    list.push(edge.sourceId);
    incoming.set(edge.targetId, list);
  }

  // 선택된 발원 노드 하나를 Shreve 규모 1로 두고 자연 배수망을 따라 하류로 누적한다.
  // 그래프 노드가 서로 다른 셀에서 같은 수로로 합쳐지는 경우도 빠짐없이 집계한다.
  const cellSourceMagnitude = new Uint32Array(elevation.length);
  for (const sourceId of internalIds) cellSourceMagnitude[nodes[sourceId].index] += 1;
  const magnitudeOrder = [...landCells].sort((a, b) => elevation[b] - elevation[a]);
  for (const cell of magnitudeOrder) {
    const next = receiver[cell];
    if (next >= 0 && next !== cell)
      cellSourceMagnitude[next] += cellSourceMagnitude[cell];
  }

  const memoFlow = new Map<number, number>();
  const memoOrder = new Map<number, number>();
  const memoMagnitude = new Map<number, number>();
  const nodeFlow = (id: number): number => {
    if (memoFlow.has(id)) return memoFlow.get(id)!;
    const own = Math.max(0.2, Math.log1p(runoffMap[nodes[id]?.index] ?? 0));
    const total =
      own +
      (incoming.get(id) ?? []).reduce((sum, child) => sum + nodeFlow(child), 0);
    memoFlow.set(id, total);
    return total;
  };
  const nodeMagnitude = (id: number): number => {
    if (memoMagnitude.has(id)) return memoMagnitude.get(id)!;
    const children = incoming.get(id) ?? [];
    // 각 내륙 노드는 하나의 발원·유입 단위를 더한다. 한 줄기 사슬에서도 하류로 갈수록
    // 유입 노드 수가 누적되고, 여러 지류가 같은 노드로 들어오면 합으로 증가한다.
    const ownContribution = validSource.has(id) ? 1 : 0;
    const graphMagnitude = ownContribution + children.reduce((sum, child) => sum + nodeMagnitude(child), 0);
    const drainageMagnitude = cellSourceMagnitude[nodes[id]?.index] ?? 0;
    const magnitude = Math.max(1, graphMagnitude, drainageMagnitude);
    memoMagnitude.set(id, magnitude);
    return magnitude;
  };
  const nodeOrder = (id: number): number => {
    if (memoOrder.has(id)) return memoOrder.get(id)!;
    const childOrders = (incoming.get(id) ?? []).map(nodeOrder);
    let order = 1;
    if (childOrders.length) {
      const max = Math.max(...childOrders);
      order = max + (childOrders.filter((v) => v === max).length >= 2 ? 1 : 0);
    }
    memoOrder.set(id, order);
    return order;
  };

  const basinMap = new Int32Array(elevation.length);
  basinMap.fill(-1);
  const outletCache = new Int32Array(elevation.length);
  outletCache.fill(-2);
  const outletOf = (start: number): number => {
    if (outletCache[start] !== -2) return outletCache[start];
    const path: number[] = [];
    const seen = new Set<number>();
    let current = start;
    while (
      current >= 0 &&
      elevation[current] > seaLevel &&
      !seen.has(current) &&
      outletCache[current] === -2
    ) {
      seen.add(current);
      path.push(current);
      current = receiver[current];
    }
    const outlet =
      current >= 0 && outletCache[current] >= 0
        ? outletCache[current]
        : current;
    for (const cell of path) outletCache[cell] = outlet;
    return outlet;
  };
  const outletBasin = new Map<number, number>();
  for (const cell of landCells) {
    const outlet = outletOf(cell);
    if (!outletBasin.has(outlet)) outletBasin.set(outlet, outletBasin.size);
    basinMap[cell] = outletBasin.get(outlet)!;
  }

  const flowMap = new Float64Array(elevation.length);
  const riverOrderMap = new Uint8Array(elevation.length);
  const riverMagnitudeMap = new Uint16Array(elevation.length);
  const transform = createGridTransform(worldWidth, worldHeight, width, height);
  const scaleX = transform.cellSizeX, scaleY = transform.cellSizeY;
  const toPoint = (index: number): Point => transform.cellCenterToWorld(index % width, Math.floor(index / width));
  const sampleElevation = (point: Point): number => {
    const gx = clamp(point.x / transform.cellSizeX - 0.5, 0, width - 1);
    const gy = clamp(point.y / transform.cellSizeY - 0.5, 0, height - 1);
    const x0 = Math.floor(gx), y0 = Math.floor(gy);
    const x1 = Math.min(width - 1, x0 + 1), y1 = Math.min(height - 1, y0 + 1);
    const tx = gx - x0, ty = gy - y0;
    const top = elevation[y0 * width + x0] * (1 - tx) + elevation[y0 * width + x1] * tx;
    const bottom = elevation[y1 * width + x0] * (1 - tx) + elevation[y1 * width + x1] * tx;
    return top * (1 - ty) + bottom * ty;
  };
  const riverPointIndex = (point: Point): number => transform.worldToCell(point).index;
  const nodeVisualWidth = (id: number): number => {
    const magnitude = Math.max(1, nodeMagnitude(id));
    const flow = Math.max(0.2, nodeFlow(id));
    const order = Math.max(1, nodeOrder(id));
    return 0.38 + Math.sqrt(magnitude) * 0.34 + Math.log1p(flow) * 0.32 + order * 0.22;
  };
  // 가장 큰 본류부터 벡터망을 만들고 남는 용량에 지류를 추가한다.
  // 고해상도 지도에서도 선분 상한 때문에 본류가 누락되지 않는다.
  const orderedEdges = [...edges].sort((a, b) => {
    const magnitudeDelta = nodeMagnitude(b.sourceId) - nodeMagnitude(a.sourceId);
    if (magnitudeDelta !== 0) return magnitudeDelta;
    const orderDelta = nodeOrder(b.sourceId) - nodeOrder(a.sourceId);
    if (orderDelta !== 0) return orderDelta;
    return nodeFlow(b.sourceId) - nodeFlow(a.sourceId);
  });
  const rivers: GeneratedRiverSegment[] = [];
  for (const edge of orderedEdges) {
    if (!validSource.has(edge.sourceId)) continue;
    const magnitudeValue = Math.max(1, nodeMagnitude(edge.sourceId));
    const orderValue = Math.max(1, nodeOrder(edge.sourceId), Math.floor(Math.log2(magnitudeValue)) + 1);
    const flowValue = nodeFlow(edge.sourceId);
    const targetMagnitudeValue = Math.max(magnitudeValue, nodeMagnitude(edge.targetId));
    edge.path.forEach((cell, pathIndex) => {
      const progress = pathIndex / Math.max(1, edge.path.length - 1);
      const graphMagnitude = Math.round(magnitudeValue + (targetMagnitudeValue - magnitudeValue) * progress);
      const localMagnitude = Math.max(1, graphMagnitude, cellSourceMagnitude[cell] ?? 0);
      const localOrder = Math.max(orderValue, Math.floor(Math.log2(localMagnitude)) + 1);
      flowMap[cell] = Math.max(flowMap[cell], flowValue);
      riverOrderMap[cell] = Math.max(riverOrderMap[cell], localOrder);
      riverMagnitudeMap[cell] = Math.max(riverMagnitudeMap[cell], localMagnitude);
      basinMap[cell] = edge.basinId;
    });
    const raw = edge.path.map(toPoint);
    const cellScale = Math.max(scaleX, scaleY);
    const headwater = orderValue <= 2;
    const simplified = resamplePath(
      raw,
      cellScale * (headwater ? 1.05 : Math.min(3.4, 1.45 + orderValue * 0.34)),
    );
    const coastalTarget = nodes[edge.targetId]?.coastal === true;
    const meandered = simplified.map((point, index, array) => {
      if (index === 0 || index === array.length - 1) return point;
      const progress = index / Math.max(1, array.length - 1);
      const lowerCoastalCurve = coastalTarget && progress > 0.38;
      if (!headwater && !lowerCoastalCurve) return point;
      const previous = array[index - 1],
        next = array[index + 1];
      const dx = next.x - previous.x,
        dy = next.y - previous.y;
      const length = Math.max(1e-9, Math.hypot(dx, dy));
      const headwaterAmplitude = headwater
        ? cellScale * (orderValue === 1 ? 0.52 : 0.28)
        : 0;
      // 하구로 갈수록 한두 번 크게 휘어 해안선에 직선으로 꽂히는 형태를 피한다.
      const mouthEnvelope = lowerCoastalCurve
        ? Math.sin(Math.PI * clamp((progress - 0.38) / 0.62)) *
          cellScale *
          (1.1 + Math.min(1.2, orderValue * 0.16))
        : 0;
      const phase =
        (index + edge.sourceId * 0.73) * 1.37 +
        (coastalTarget ? edge.basinId * 0.91 : 0);
      const amplitude = (headwaterAmplitude + mouthEnvelope) * Math.sin(phase);
      const candidate = {
        x: clamp(point.x - (dy / length) * amplitude, 0, worldWidth),
        y: clamp(point.y + (dx / length) * amplitude, 0, worldHeight),
      };
      return sampleElevation(candidate) <=
        sampleElevation(point) + Math.max(5, settings.contourInterval * 0.08)
        ? candidate
        : point;
    });
    let curved =
      meandered.length >= 3
        ? smoothPath(meandered, {
            spacing:
              cellScale * (headwater ? 0.95 : coastalTarget ? 1.15 : 1.75),
            samplesPerSegment: headwater || coastalTarget ? 3 : 2,
            iterations: headwater || coastalTarget ? 2 : 1,
          })
        : meandered;
    let previousElevation = sampleElevation(curved[0] ?? raw[0]);
    let invalid = false;
    for (let i = 1; i < curved.length; i += 1) {
      const currentElevation = sampleElevation(curved[i]);
      if (
        currentElevation >
        previousElevation + Math.max(8, settings.contourInterval * 0.12)
      ) {
        invalid = true;
        break;
      }
      previousElevation = currentElevation;
    }
    if (invalid) curved = simplified;

    // 호수 경계를 따라 돌거나 같은 호수를 여러 번 드나드는 선을 금지한다.
    // 호수에서 시작하는 유출 강은 최초 육지점부터 시작하고, 유입 강은 최초 호수 진입 직전에 끝난다.
    let startsAtLake = curved.length > 0 && freshwaterLakeMap[riverPointIndex(curved[0])] > 0;
    if (startsAtLake) {
      const firstLandPoint = curved.findIndex((point) => freshwaterLakeMap[riverPointIndex(point)] <= 0);
      if (firstLandPoint < 0 || firstLandPoint >= curved.length - 1) continue;
      curved = curved.slice(firstLandPoint);
    }
    const firstLakePoint = curved.findIndex((point, index) => index > 0 && freshwaterLakeMap[riverPointIndex(point)] > 0);
    const truncatedAtLake = firstLakePoint > 0;
    if (truncatedAtLake) curved = curved.slice(0, firstLakePoint);
    if (curved.length < 2) continue;

    const sourceElevation = sampleElevation(curved[0] ?? raw[0]);
    const finalElevation = sampleElevation(
      curved[curved.length - 1] ?? raw[raw.length - 1],
    );
    const totalDrop = Math.max(1, sourceElevation - finalElevation);
    for (let i = 0; i < curved.length - 1; i += 1) {
      const mouth =
        (truncatedAtLake || nodes[edge.targetId]?.coastal === true ||
          nodes[edge.targetId]?.lake === true) &&
        i === curved.length - 2;
      const pathProgress = (i + 1) / Math.max(1, curved.length - 1);
      const localElevation = sampleElevation(curved[i + 1]);
      const dropProgress = clamp(
        (sourceElevation - localElevation) / totalDrop,
        0,
        1,
      );
      // 상류 발원지 누적 규모와 유량으로 노드 폭을 정하고, 구간 전체에서 smoothstep으로 보간한다.
      // 합류점 전후의 끝·시작 폭이 같은 노드 폭을 공유하므로 갑작스러운 굵기 점프가 사라진다.
      const startWidth = nodeVisualWidth(edge.sourceId);
      const endWidth = nodeVisualWidth(edge.targetId);
      const transition = pathProgress * pathProgress * (3 - 2 * pathProgress);
      const startCellMagnitude = Math.max(magnitudeValue, cellSourceMagnitude[riverPointIndex(curved[i])] ?? 0);
      const endCellMagnitude = Math.max(startCellMagnitude, targetMagnitudeValue, cellSourceMagnitude[riverPointIndex(curved[i + 1])] ?? 0);
      const localMagnitude = Math.max(1, Math.round(startCellMagnitude + (endCellMagnitude - startCellMagnitude) * transition));
      const magnitudeWidth = 0.34 * Math.sqrt(localMagnitude);
      const downstreamWidth = startWidth + (endWidth - startWidth) * transition + dropProgress * 0.12 + magnitudeWidth * 0.18;
      rivers.push({
        start: curved[i],
        end: curved[i + 1],
        flow: flowValue,
        magnitude: localMagnitude,
        width: downstreamWidth,
        order: Math.max(orderValue, Math.floor(Math.log2(localMagnitude)) + 1),
        basinId: edge.basinId,
        mouth,
        riverId: edge.sourceId,
        sequence: i,
      });
      if (rivers.length >= 14000) break;
    }
    if (rivers.length >= 14000) break;
  }
  return {
    rivers,
    flowAccumulationMap: Array.from(flowMap),
    basinMap: Array.from(basinMap),
    riverOrderMap: Array.from(riverOrderMap),
    riverMagnitudeMap: Array.from(riverMagnitudeMap),
    freshwaterLakeMap: Array.from(freshwaterLakeMap),
    lakeIdMap: Array.from(lakeIdMap),
    lakeSurfaceElevations,
  };
}

function gridDistanceFromSources(
  sourceMask: boolean[],
  width: number,
  height: number,
): number[] {
  const distance = new Array<number>(sourceMask.length).fill(
    Number.POSITIVE_INFINITY,
  );
  const queue = new Int32Array(sourceMask.length);
  let head = 0,
    tail = 0;
  for (let i = 0; i < sourceMask.length; i += 1)
    if (sourceMask[i]) {
      distance[i] = 0;
      queue[tail++] = i;
    }
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const;
  while (head < tail) {
    const index = queue[head++],
      x = index % width,
      y = Math.floor(index / width);
    for (const [dx, dy] of dirs) {
      const nx = x + dx,
        ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const next = ny * width + nx;
      if (distance[next] > distance[index] + 1) {
        distance[next] = distance[index] + 1;
        queue[tail++] = next;
      }
    }
  }
  return distance;
}

/** 강수·토양수분뿐 아니라 강·호수·유출량과의 접근성을 반영해 사막 과다 생성을 억제한다. */
function refineTerrainWithWaterAccess(
  terrain: TerrainType[],
  elevation: number[],
  waterTypeMap: WaterType[],
  environment: ReturnType<typeof calculateEnvironment>,
  hydrology: HydrologyResult,
  width: number,
  height: number,
  seaLevel: number,
  settings: GeneratorSettings,
): TerrainType[] {
  const freshwaterSources = waterTypeMap.map(
    (type, index) =>
      type === "freshwater" ||
      (hydrology.riverOrderMap[index] ?? 0) > 0 ||
      (hydrology.freshwaterLakeMap[index] ?? 0) > 0,
  );
  const saltwaterSources = waterTypeMap.map((type) => type === "saltwater");
  const freshwaterDistance = gridDistanceFromSources(
    freshwaterSources,
    width,
    height,
  );
  const coastDistance = gridDistanceFromSources(
    saltwaterSources,
    width,
    height,
  );
  const output = [...terrain];
  const desertMask = new Uint8Array(terrain.length);
  for (let index = 0; index < terrain.length; index += 1) {
    if (waterTypeMap[index] !== "land") continue;
    const temperature = environment.temperatureMap[index] ?? 0;
    const precipitation = environment.precipitationMap[index] ?? 0;
    const moisture = environment.moistureMap[index] ?? 0;
    const runoff = environment.runoffMap[index] ?? 0;
    const potentialEvaporation = Math.max(
      120,
      20 * Math.max(0, temperature + 8),
    );
    const aridity = precipitation / potentialEvaporation;
    const freshAccess = Math.exp(
      -freshwaterDistance[index] / Math.max(3, Math.min(width, height) * 0.018),
    );
    const coastalHumidity = Math.exp(
      -coastDistance[index] / Math.max(4, Math.min(width, height) * 0.035),
    );
    const waterAccess = clamp(
      freshAccess * 0.64 +
        clamp(runoff / 700) * 0.16 +
        moisture * 0.16 +
        coastalHumidity * 0.04,
    );
    const explicitArid =
      String(settings.climatePreset).startsWith("BW") ||
      String(settings.climatePreset).startsWith("BS") ||
      settings.climatePreset === "arid";
    const desertEligible =
      (explicitArid ? aridity < 0.36 : aridity < 0.24) &&
      temperature > 4 &&
      moisture < 0.31 &&
      runoff < 95 &&
      waterAccess < 0.34;
    if (desertEligible) {
      desertMask[index] = 1;
      output[index] = "desert";
    } else if (output[index] === "desert") {
      const relative = elevation[index] - seaLevel;
      output[index] =
        relative > settings.maxElevation * 0.42
          ? "rock"
          : precipitation > 520 || waterAccess > 0.5
            ? "grassland"
            : "plain";
    }
    if (
      freshAccess > 0.66 &&
      ["desert", "plain", "rock"].includes(output[index])
    ) {
      output[index] =
        moisture > 0.58 || runoff > 360
          ? "wetland"
          : precipitation > 430
            ? "grassland"
            : "plain";
    }
  }
  // 작은 사막 반점과 다수결 확장으로 생긴 얇은 사막 띠를 제거한다.
  const components = landComponents(
    Array.from(desertMask, Boolean),
    width,
    height,
  );
  const minimumDesertArea = Math.max(18, Math.round(width * height * 0.00045));
  for (const component of components)
    if (component.size < minimumDesertArea)
      for (const index of component.cells) {
        const precipitation = environment.precipitationMap[index] ?? 0;
        output[index] = precipitation > 520 ? "grassland" : "plain";
      }
  return output;
}

/** 국지 해안 지도에서 바람·파랑·조차·퇴적·하천 조건으로 실제 해안가 타일을 만든다. */
function generateCoastalTerrainTiles(
  elevation: number[],
  waterTypeMap: WaterType[],
  environment: ReturnType<typeof calculateEnvironment>,
  hydrology: HydrologyResult,
  width: number,
  height: number,
  seaLevel: number,
  settings: GeneratorSettings,
): CoastalTerrainType[] {
  const result = new Array<CoastalTerrainType>(elevation.length).fill("none");
  if (
    (settings.mapScope !== "local" && settings.mapScope !== "regional") ||
    settings.localRegionType !== "coast"
  )
    return result;
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const;
  const tidal = clamp((settings.tidalRangeM ?? 2.2) / 12);
  for (let y = 1; y < height - 1; y += 1)
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x;
      if (waterTypeMap[index] !== "land") continue;
      let seaX = 0,
        seaY = 0,
        seaCount = 0,
        freshCount = 0,
        riverNearby = 0;
      for (let oy = -2; oy <= 2; oy += 1)
        for (let ox = -2; ox <= 2; ox += 1) {
          if (ox === 0 && oy === 0) continue;
          const nx = x + ox,
            ny = y + oy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const next = ny * width + nx;
          if (
            Math.abs(ox) + Math.abs(oy) === 1 &&
            waterTypeMap[next] === "saltwater"
          ) {
            seaX += ox;
            seaY += oy;
            seaCount += 1;
          }
          if (waterTypeMap[next] === "freshwater") freshCount += 1;
          if ((hydrology.riverOrderMap[next] ?? 0) > 0)
            riverNearby = Math.max(
              riverNearby,
              hydrology.riverOrderMap[next] ?? 0,
            );
        }
      if (!seaCount) continue;
      const length = Math.max(1e-6, Math.hypot(seaX, seaY));
      const normalX = seaX / length,
        normalY = seaY / length;
      const wx = environment.windXMap[index] ?? 0,
        wy = environment.windYMap[index] ?? 0;
      const windSpeed = Math.hypot(wx, wy),
        windLength = Math.max(1e-6, windSpeed);
      const onshore = Math.max(
        0,
        (wx / windLength) * -normalX + (wy / windLength) * -normalY,
      );
      const alongshore = Math.abs(
        (wx / windLength) * normalY - (wy / windLength) * normalX,
      );
      const wave = clamp(windSpeed / 18) * (0.35 + 0.65 * onshore);
      const left = elevation[index - 1],
        right = elevation[index + 1],
        up = elevation[index - width],
        down = elevation[index + width];
      const slope =
        Math.hypot(right - left, down - up) /
        Math.max(1, settings.maxElevation * 0.18);
      const runoff = environment.runoffMap[index] ?? 0;
      const sediment = clamp(
        ((environment.precipitationMap[index] ?? 0) / 1800) * 0.22 +
          (runoff / 900) * 0.34 +
          (1 - clamp(slope)) * 0.34 +
          riverNearby * 0.08,
      );
      if (riverNearby >= 3 || runoff > 520)
        result[index] = tidal > 0.48 || wave > 0.52 ? "estuary" : "delta";
      else if (slope > 0.56 && wave > 0.48) result[index] = "coastal_cliff";
      else if (slope > 0.38 || wave > 0.68)
        result[index] = sediment > 0.42 ? "gravel_beach" : "rocky_coast";
      else if (tidal > 0.55 && wave < 0.48 && sediment > 0.42)
        result[index] =
          freshCount > 0 || runoff > 280 ? "salt_marsh" : "mudflat";
      else if (alongshore > 0.62 && sediment > 0.56) result[index] = "sandbar";
      else result[index] = sediment > 0.34 ? "sand_beach" : "gravel_beach";
    }
  // 사주 안쪽의 얕은 해수 타일을 석호로 표시한다.
  for (let y = 1; y < height - 1; y += 1)
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x;
      if (waterTypeMap[index] !== "saltwater") continue;
      let bars = 0,
        land = 0;
      for (const [dx, dy] of dirs) {
        const next = (y + dy) * width + x + dx;
        if (result[next] === "sandbar") bars += 1;
        if (waterTypeMap[next] === "land") land += 1;
      }
      if (bars > 0 && land >= 2 && elevation[index] > seaLevel - 120)
        result[index] = "lagoon";
    }
  return result;
}

function validateGeneratedResult(
  elevationMap: number[],
  terrainMap: TerrainType[],
  hydrology: HydrologyResult,
  width: number,
  height: number,
  seaLevel: number,
  settings: GeneratorSettings,
): { score: number; issues: string[] } {
  let score = 100;
  const issues: string[] = [];
  const land = elevationMap.map((value) => value > seaLevel);
  const landCount = land.filter(Boolean).length;
  if (landCount === 0) {
    issues.push("육지가 생성되지 않았습니다.");
    return { score: 0, issues };
  }
  if (
    hydrology.rivers.length === 0 &&
    settings.basePrecipitationMm > 450 &&
    landCount > width * height * 0.2
  ) {
    issues.push("습윤한 지도인데 하천망이 형성되지 않았습니다.");
    score -= 18;
  }
  if (
    settings.mapScaleKm <= 50 &&
    terrainMap.includes("desert") &&
    terrainMap.includes("snow")
  ) {
    let minLand = Number.POSITIVE_INFINITY;
    let maxLand = Number.NEGATIVE_INFINITY;
    for (const value of elevationMap)
      if (value > seaLevel) {
        minLand = Math.min(minLand, value);
        maxLand = Math.max(maxLand, value);
      }
    const range = Number.isFinite(minLand) ? maxLand - minLand : 0;
    if (range < 2800) {
      issues.push(
        "지역 지도에서 사막과 설원이 설명 가능한 고도차 없이 함께 존재합니다.",
      );
      score -= 24;
    }
  }
  const basinCount = new Set(hydrology.basinMap.filter((value) => value >= 0))
    .size;
  if (basinCount === 0) {
    issues.push("유역을 식별하지 못했습니다.");
    score -= 20;
  }
  const tinyComponents = landComponents(land, width, height).filter(
    (component) => component.size < Math.max(4, width * height * 0.0008),
  ).length;
  if (tinyComponents > 12) {
    issues.push("지나치게 작은 육지 파편이 많습니다.");
    score -= Math.min(15, Math.floor(tinyComponents / 3));
  }
  return { score: Math.max(0, score), issues };
}

function resampleNumberGrid(
  values: number[],
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
  nearest = false,
): number[] {
  if (sourceWidth === targetWidth && sourceHeight === targetHeight)
    return [...values];
  const output = new Array<number>(targetWidth * targetHeight);
  for (let y = 0; y < targetHeight; y += 1) {
    const sourceY =
      targetHeight <= 1 ? 0 : (y * (sourceHeight - 1)) / (targetHeight - 1);
    const y0 = Math.floor(sourceY);
    const y1 = Math.min(sourceHeight - 1, y0 + 1);
    const ty = sourceY - y0;
    for (let x = 0; x < targetWidth; x += 1) {
      const sourceX =
        targetWidth <= 1 ? 0 : (x * (sourceWidth - 1)) / (targetWidth - 1);
      if (nearest) {
        const nx = Math.min(sourceWidth - 1, Math.round(sourceX));
        const ny = Math.min(sourceHeight - 1, Math.round(sourceY));
        output[y * targetWidth + x] = values[ny * sourceWidth + nx] ?? 0;
        continue;
      }
      const x0 = Math.floor(sourceX);
      const x1 = Math.min(sourceWidth - 1, x0 + 1);
      const tx = sourceX - x0;
      const top =
        (values[y0 * sourceWidth + x0] ?? 0) * (1 - tx) +
        (values[y0 * sourceWidth + x1] ?? 0) * tx;
      const bottom =
        (values[y1 * sourceWidth + x0] ?? 0) * (1 - tx) +
        (values[y1 * sourceWidth + x1] ?? 0) * tx;
      output[y * targetWidth + x] = top * (1 - ty) + bottom * ty;
    }
  }
  return output;
}

function resampleTerrainGrid(
  values: TerrainType[],
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
): TerrainType[] {
  const output = new Array<TerrainType>(targetWidth * targetHeight);
  for (let y = 0; y < targetHeight; y += 1) {
    const sourceY =
      targetHeight <= 1
        ? 0
        : Math.round((y * (sourceHeight - 1)) / (targetHeight - 1));
    for (let x = 0; x < targetWidth; x += 1) {
      const sourceX =
        targetWidth <= 1
          ? 0
          : Math.round((x * (sourceWidth - 1)) / (targetWidth - 1));
      output[y * targetWidth + x] =
        values[sourceY * sourceWidth + sourceX] ?? "plain";
    }
  }
  return output;
}

function resampleCategoricalGrid<T>(
  values: T[],
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
  fallback: T,
): T[] {
  const output = new Array<T>(targetWidth * targetHeight);
  for (let y = 0; y < targetHeight; y += 1) {
    const sy =
      targetHeight <= 1
        ? 0
        : Math.round((y * (sourceHeight - 1)) / (targetHeight - 1));
    for (let x = 0; x < targetWidth; x += 1) {
      const sx =
        targetWidth <= 1
          ? 0
          : Math.round((x * (sourceWidth - 1)) / (targetWidth - 1));
      output[y * targetWidth + x] = values[sy * sourceWidth + sx] ?? fallback;
    }
  }
  return output;
}

function upscaleGeneratedMap(
  base: GeneratedMapData,
  settings: GeneratorSettings,
  targetWidth: number,
  targetHeight: number,
): GeneratedMapData {
  const sw = base.gridWidth;
  const sh = base.gridHeight;
  return {
    ...base,
    settings: { ...settings, gridWidth: targetWidth, gridHeight: targetHeight },
    gridWidth: targetWidth,
    gridHeight: targetHeight,
    renderWidth: targetWidth,
    renderHeight: targetHeight,
    elevationMap: resampleNumberGrid(
      base.elevationMap,
      sw,
      sh,
      targetWidth,
      targetHeight,
    ),
    landMask: resampleNumberGrid(
      base.landMask,
      sw,
      sh,
      targetWidth,
      targetHeight,
      true,
    ).map((value) => (value >= 0.5 ? 1 : 0)),
    waterTypeMap: resampleCategoricalGrid(
      base.waterTypeMap,
      sw,
      sh,
      targetWidth,
      targetHeight,
      "land",
    ),
    coastalTerrainMap: resampleCategoricalGrid(
      base.coastalTerrainMap,
      sw,
      sh,
      targetWidth,
      targetHeight,
      "none",
    ),
    terrainMap: resampleTerrainGrid(
      base.terrainMap,
      sw,
      sh,
      targetWidth,
      targetHeight,
    ),
    snowCoverMap: resampleNumberGrid(
      base.snowCoverMap,
      sw,
      sh,
      targetWidth,
      targetHeight,
    ),
    snowBaseTerrainMap: resampleTerrainGrid(
      base.snowBaseTerrainMap,
      sw,
      sh,
      targetWidth,
      targetHeight,
    ),
    temperatureMap: resampleNumberGrid(
      base.temperatureMap,
      sw,
      sh,
      targetWidth,
      targetHeight,
    ),
    precipitationMap: resampleNumberGrid(
      base.precipitationMap,
      sw,
      sh,
      targetWidth,
      targetHeight,
    ),
    moistureMap: resampleNumberGrid(
      base.moistureMap,
      sw,
      sh,
      targetWidth,
      targetHeight,
    ),
    relativeHumidityMap: resampleNumberGrid(
      base.relativeHumidityMap,
      sw,
      sh,
      targetWidth,
      targetHeight,
    ),
    solarHoursMap: resampleNumberGrid(
      base.solarHoursMap,
      sw,
      sh,
      targetWidth,
      targetHeight,
    ),
    solarIrradianceMap: resampleNumberGrid(
      base.solarIrradianceMap,
      sw,
      sh,
      targetWidth,
      targetHeight,
    ),
    runoffMap: resampleNumberGrid(
      base.runoffMap,
      sw,
      sh,
      targetWidth,
      targetHeight,
    ),
    flowAccumulationMap: resampleNumberGrid(
      base.flowAccumulationMap,
      sw,
      sh,
      targetWidth,
      targetHeight,
    ),
    lakeIdMap: resampleNumberGrid(
      base.lakeIdMap,
      sw,
      sh,
      targetWidth,
      targetHeight,
      true,
    ).map(Math.round),
    lakeSurfaceElevations: [...base.lakeSurfaceElevations],
    basinMap: resampleNumberGrid(
      base.basinMap,
      sw,
      sh,
      targetWidth,
      targetHeight,
      true,
    ).map(Math.round),
    riverOrderMap: resampleNumberGrid(
      base.riverOrderMap,
      sw,
      sh,
      targetWidth,
      targetHeight,
      true,
    ).map(Math.round),
    riverMagnitudeMap: resampleNumberGrid(
      base.riverMagnitudeMap,
      sw,
      sh,
      targetWidth,
      targetHeight,
      true,
    ).map(Math.round),
    windXMap: resampleNumberGrid(
      base.windXMap,
      sw,
      sh,
      targetWidth,
      targetHeight,
    ),
    windYMap: resampleNumberGrid(
      base.windYMap,
      sw,
      sh,
      targetWidth,
      targetHeight,
    ),
    generatedAt: new Date().toISOString(),
    environmentModel: { engine: "builtin", version: "0.99u-grid-atlas-hierarchical-hydrology" },
  };
}


function boundaryKindAt(
  settings: GeneratorSettings,
  side: "north" | "east" | "south" | "west",
  offset: number,
): "land" | "water" {
  const type = settings.localRegionType;
  if (type === "inland" || type === "mountain" || type === "river") return "land";
  if (type === "island" || type === "archipelago") return "water";
  const boundary = settings.localBoundary;
  const hasAnyLand = (["north", "east", "south", "west"] as const).some((edge) =>
    (boundary?.[edge] ?? []).some((segment) => segment.kind === "land"),
  );
  if (type === "coast" && !hasAnyLand && side === "north") return "land";
  const segments = boundary?.[side] ?? [{ start: 0, end: 1, kind: side === "south" ? "water" : "land" }];
  const clamped = clamp(offset);
  const segment = segments.find((item) => clamped >= Math.min(item.start, item.end) && clamped <= Math.max(item.start, item.end));
  return segment?.kind ?? "land";
}

function enforceLocalBoundaryWaterTypes(
  waterTypeMap: WaterType[],
  width: number,
  height: number,
  settings: GeneratorSettings,
): void {
  if (settings.mapScope !== "local" && settings.mapScope !== "regional") return;
  const set = (index: number, kind: "land" | "water") => { waterTypeMap[index] = kind === "land" ? "land" : "saltwater"; };
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

function guidedNormalizedPath(
  guide: GeneratorSettings["mountainGuide"] | GeneratorSettings["riverGuide"],
  seed: number,
): Point[] {
  if (guide.mode === "drawn" && guide.path.length >= 2)
    return smoothPath(guide.path.map((point) => ({ x: clamp(point.x), y: clamp(point.y) })), {
      samplesPerSegment: 5,
      iterations: 1,
    });
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
    const wobble = (random() - 0.5) * (0.12 + guide.branchiness * 0.1) * envelope;
    points.push({
      x: clamp(start.x + dx * t + px * wobble),
      y: clamp(start.y + dy * t + py * wobble),
    });
  }
  points.push(end);
  return smoothPath(points, { samplesPerSegment: 6, iterations: 1 });
}

function distanceToNormalizedPath(nx: number, ny: number, path: Point[]): number {
  let distance = Number.POSITIVE_INFINITY;
  for (let index = 1; index < path.length; index += 1)
    distance = Math.min(distance, segmentDistance(nx, ny, path[index - 1], path[index]));
  return distance;
}

/**
 * 지방·지역 전용 생성기. 대륙 골격·판 구조·전역 해수면 판정 대신
 * 경계의 육지/수역 조건과 사용자가 지정한 산맥·강 중추선을 직접 제약으로 사용한다.
 */
function generateBoundaryDrivenLocalTerrain(
  settings: GeneratorSettings,
  width: number,
  height: number,
): { normalized: number[]; landMask: number[]; centers: Point[] } {
  const size = width * height;
  const score = new Float64Array(size);
  const landMask = new Array<number>(size).fill(1);
  const random = mulberry32((settings.seed ^ 0x6d2b79f5) >>> 0);
  const type = settings.localRegionType;
  const mountainPath = guidedNormalizedPath(settings.mountainGuide, settings.seed + 711);
  const riverPath = guidedNormalizedPath(settings.riverGuide, settings.seed + 997);
  const islandCount = type === "island" ? 1 : Math.max(2, Math.min(64, Math.round(settings.islandCount || 6)));
  const islandSeeds = Array.from({ length: islandCount }, (_value, index) => ({
    x: type === "island" ? 0.5 + (random() - 0.5) * 0.08 : 0.12 + random() * 0.76,
    y: type === "island" ? 0.5 + (random() - 0.5) * 0.08 : 0.12 + random() * 0.76,
    rx: type === "island" ? 0.31 + random() * 0.08 : 0.055 + random() * 0.13,
    ry: type === "island" ? 0.25 + random() * 0.08 : 0.045 + random() * 0.12,
    angle: random() * Math.PI,
    weight: 0.86 + random() * 0.28 + index * 0.0001,
  }));

  const boundarySamples: Array<{ x: number; y: number; sign: number }> = [];
  const sampleCount = 48;
  for (let index = 0; index <= sampleCount; index += 1) {
    const t = index / sampleCount;
    boundarySamples.push({ x: t, y: 0, sign: boundaryKindAt(settings, "north", t) === "land" ? 1 : -1 });
    boundarySamples.push({ x: t, y: 1, sign: boundaryKindAt(settings, "south", t) === "land" ? 1 : -1 });
    boundarySamples.push({ x: 0, y: t, sign: boundaryKindAt(settings, "west", t) === "land" ? 1 : -1 });
    boundarySamples.push({ x: 1, y: t, sign: boundaryKindAt(settings, "east", t) === "land" ? 1 : -1 });
  }

  for (let y = 0; y < height; y += 1) {
    const ny = y / Math.max(1, height - 1);
    for (let x = 0; x < width; x += 1) {
      const nx = x / Math.max(1, width - 1);
      const index = y * width + x;
      const broad = (fractalPerlinNoise(nx * 2.2, ny * 2.2, settings.seed + 31_901, 5, 0.56, 2.02) - 0.5) * 0.2;
      const medium = (fractalNoise(nx * 8.4, ny * 8.4, settings.seed + 71_227, 4, 0.52, 2.05) - 0.5) * 0.09;
      let landScore = 1.1 + broad + medium;

      if (type === "coast") {
        const detail = clamp(settings.coastlineDetail * 0.8 + settings.noiseStrength * 0.35, 0, 1.35);
        const warpX = (fractalPerlinNoise(nx * 2.7, ny * 2.7, settings.seed + 91_031, 4, 0.56, 2.01) - 0.5) * 0.16 * detail;
        const warpY = (fractalPerlinNoise(nx * 2.7 + 19.4, ny * 2.7 - 7.2, settings.seed + 91_037, 4, 0.56, 2.01) - 0.5) * 0.16 * detail;
        const wx = clamp(nx + warpX);
        const wy = clamp(ny + warpY);
        let weighted = 0;
        let totalWeight = 0;
        for (const sample of boundarySamples) {
          const distanceSquared = (wx - sample.x) ** 2 + (wy - sample.y) ** 2;
          const weight = 1 / (0.0015 + distanceSquared * 8.4);
          weighted += sample.sign * weight;
          totalWeight += weight;
        }
        const largeBays = (fractalPerlinNoise(wx * 3.4, wy * 3.4, settings.seed + 102_211, 5, 0.57, 2.02) - 0.5) * 0.34 * detail;
        const capes = (fractalNoise(wx * 11.5, wy * 11.5, settings.seed + 102_223, 4, 0.53, 2.07) - 0.5) * 0.2 * detail;
        const fineCoast = (fractalNoise(wx * 31, wy * 31, settings.seed + 102_229, 3, 0.48, 2.13) - 0.5) * 0.065 * detail;
        landScore = weighted / Math.max(1e-6, totalWeight) + broad * 1.15 + largeBays + capes + fineCoast + 0.1;
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
          const warp = (fractalNoise(nx * 11 + seed.x * 7, ny * 11 + seed.y * 7, settings.seed + 52_111, 3, 0.54, 2.08) - 0.5) * 0.38;
          islandSignal = Math.max(islandSignal, seed.weight - radial + warp);
        }
        landScore = islandSignal;
      }

      if (type === "mountain") {
        const distance = distanceToNormalizedPath(nx, ny, mountainPath);
        const ridgeWidth = Math.max(0.025, settings.mountainGuide.width || 0.12);
        landScore += Math.exp(-(distance * distance) / (ridgeWidth * ridgeWidth)) * 0.42;
      }
      if (type === "river") {
        const distance = distanceToNormalizedPath(nx, ny, riverPath);
        const channelWidth = Math.max(0.008, settings.riverGuide.width || 0.045);
        landScore -= Math.exp(-(distance * distance) / (channelWidth * channelWidth)) * 0.18;
      }

      score[index] = landScore;
      landMask[index] = landScore >= 0 ? 1 : 0;
    }
  }

  // 경계 조건은 최종적으로 정확히 고정한다.
  for (let x = 0; x < width; x += 1) {
    const t = x / Math.max(1, width - 1);
    landMask[x] = boundaryKindAt(settings, "north", t) === "land" ? 1 : 0;
    landMask[(height - 1) * width + x] = boundaryKindAt(settings, "south", t) === "land" ? 1 : 0;
  }
  for (let y = 0; y < height; y += 1) {
    const t = y / Math.max(1, height - 1);
    landMask[y * width] = boundaryKindAt(settings, "west", t) === "land" ? 1 : 0;
    landMask[y * width + width - 1] = boundaryKindAt(settings, "east", t) === "land" ? 1 : 0;
  }

  // 단일 섬/군도는 외곽이 무조건 바다다.
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
    const relief = (fractalPerlinNoise(nx * 4.6, ny * 4.6, settings.seed + 8_809, 5, 0.54, 2.03) - 0.5) * 0.22;
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
  return { normalized, landMask, centers: islandSeeds.map((seed) => ({ x: seed.x * width, y: seed.y * height })) };
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

  const rawCoastline = extractSegments(
    elevationMap,
    width,
    height,
    seaLevel,
    worldWidth,
    worldHeight,
  );
  const coastline = curveSegmentNetwork(
    rawCoastline,
    Math.max(worldWidth / width, worldHeight / height) * (quality === "preview" ? 0.9 : 0.42),
    true,
    quality,
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
    surfaceRegions: buildSurfaceRegions(terrainMap, waterTypeMap, width, height, worldWidth, worldHeight, effectiveSettings, quality),
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
  const coastline = curveSegmentNetwork(
    extractSegments(
      elevationMap,
      width,
      height,
      nextSeaLevel,
      source.worldWidth,
      source.worldHeight,
    ),
    Math.max(source.worldWidth / width, source.worldHeight / height) * 0.14,
    true,
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
  const terrainMap = terrainOverride
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
    surfaceRegions: buildSurfaceRegions(terrainMap, waterTypeMap, width, height, source.worldWidth, source.worldHeight, settings, "final"),
    coastline,
    contours,
    rivers: finalizeRiverNetwork([...hydrology.rivers, ...guidedRivers], source.worldWidth, source.worldHeight, source.gridWidth, source.gridHeight),
    actualContinentCount,
    qualityScore: validation.score,
    qualityIssues: validation.issues,
    generatedAt: new Date().toISOString(),
  };
}
