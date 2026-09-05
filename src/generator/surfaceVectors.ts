import type {
  GeneratedMapData,
  GeneratedSurface,
  GeneratedSurfaceRegion,
  GeneratorSettings,
  LineSegment,
  Point,
  TerrainType,
  WaterType,
} from "../model/world";
import { AGRICULTURE_VISIBLE_THRESHOLD, normalizedAgricultureMap, normalizedNaturalTerrainMap } from "./agriculture";
import { fractalPerlinNoise } from "./noise";

export const CURRENT_SURFACE_VECTOR_VERSION = 9;
const canonicalLandPathCache = new WeakMap<GeneratedMapData, Point[][]>();
const surfaceFingerprintCache = new WeakMap<GeneratedMapData, string>();

const TERRAIN_ORDER: TerrainType[] = [
  "bedrock", "rock", "mountain", "desert", "snow", "plain", "grassland",
  "forest", "jungle", "wetland",
];

function boundaryEdges(mask: Uint8Array, width: number, height: number, worldWidth: number, worldHeight: number): LineSegment[] {
  const cellWidth = worldWidth / Math.max(1, width);
  const cellHeight = worldHeight / Math.max(1, height);
  const segments: LineSegment[] = [];
  const sample = (x: number, y: number): number =>
    x > 0 && y > 0 && x <= width && y <= height
      ? mask[(y - 1) * width + x - 1]
      : 0;
  const point = (x: number, y: number): Point => ({
    x: Math.max(0, Math.min(worldWidth, x)),
    y: Math.max(0, Math.min(worldHeight, y)),
  });
  const add = (start: Point, end: Point) => segments.push({ start, end });

  for (let y = 0; y <= height; y += 1) {
    for (let x = 0; x <= width; x += 1) {
      const state =
        sample(x, y) |
        (sample(x + 1, y) << 1) |
        (sample(x + 1, y + 1) << 2) |
        (sample(x, y + 1) << 3);
      if (state === 0 || state === 15) continue;
      const top = point(x * cellWidth, (y - 0.5) * cellHeight);
      const right = point((x + 0.5) * cellWidth, y * cellHeight);
      const bottom = point(x * cellWidth, (y + 0.5) * cellHeight);
      const left = point((x - 0.5) * cellWidth, y * cellHeight);
      switch (state) {
        case 1: add(left, top); break;
        case 2: add(top, right); break;
        case 3: add(left, right); break;
        case 4: add(right, bottom); break;
        case 5:
        case 10:
          // Complementary masks must choose the same saddle diagonal or adjacent
          // terrain fills create an X-shaped crack at this cell.
          if ((x + y) % 2 === 0) { add(left, top); add(right, bottom); }
          else { add(top, right); add(bottom, left); }
          break;
        case 6: add(top, bottom); break;
        case 7: add(left, bottom); break;
        case 8: add(bottom, left); break;
        case 9: add(top, bottom); break;
        case 11: add(right, bottom); break;
        case 12: add(left, right); break;
        case 13: add(top, right); break;
        case 14: add(left, top); break;
      }
    }
  }
  return segments;
}

/**
 * Marching-squares surface boundaries must be degree-two closed graphs. This
 * tracer rejects branches and open fragments instead of guessing a connection.
 */
function traceClosedBoundaryLoops(segments: LineSegment[]): Point[][] {
  const keyOf = (point: Point) => `${point.x.toFixed(12)}:${point.y.toFixed(12)}`;
  const adjacency = new Map<string, number[]>();
  for (let index = 0; index < segments.length; index += 1) {
    for (const point of [segments[index].start, segments[index].end]) {
      const key = keyOf(point);
      const connected = adjacency.get(key) ?? [];
      connected.push(index);
      adjacency.set(key, connected);
    }
  }

  const used = new Uint8Array(segments.length);
  const loops: Point[][] = [];
  for (let startEdge = 0; startEdge < segments.length; startEdge += 1) {
    if (used[startEdge]) continue;
    const first = segments[startEdge].start;
    const firstKey = keyOf(first);
    const path: Point[] = [{ ...first }];
    let currentPoint = first;
    let edgeIndex = startEdge;
    let closed = false;
    for (let guard = 0; guard <= segments.length; guard += 1) {
      if (used[edgeIndex]) break;
      const edge = segments[edgeIndex];
      used[edgeIndex] = 1;
      const next = keyOf(currentPoint) === keyOf(edge.start) ? edge.end : edge.start;
      path.push({ ...next });
      const nextKey = keyOf(next);
      if (nextKey === firstKey) {
        closed = true;
        break;
      }
      const candidates = (adjacency.get(nextKey) ?? []).filter((candidate) => !used[candidate]);
      if (candidates.length !== 1 || (adjacency.get(nextKey)?.length ?? 0) !== 2) break;
      currentPoint = next;
      edgeIndex = candidates[0];
    }
    if (closed && path.length >= 5) loops.push(path);
  }
  return loops;
}

/** 경계의 큰 흐름을 유지하면서 저·중·고주파 굴곡을 법선 방향으로 합성한다. */
function pathArea(points: Point[]): number {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index];
    const b = points[(index + 1) % points.length];
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area) * 0.5;
}

function orientation(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function ringHasSelfIntersection(points: Point[]): boolean {
  if (points.length < 4) return false;
  const minX = Math.min(...points.map((point) => point.x));
  const maxX = Math.max(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxY = Math.max(...points.map((point) => point.y));
  const bucketSize = Math.max(1e-9, Math.max(maxX - minX, maxY - minY) / 64);
  const buckets = new Map<string, number[]>();
  const segmentBuckets = (a: Point, b: Point): string[] => {
    const left = Math.floor((Math.min(a.x, b.x) - minX) / bucketSize);
    const right = Math.floor((Math.max(a.x, b.x) - minX) / bucketSize);
    const top = Math.floor((Math.min(a.y, b.y) - minY) / bucketSize);
    const bottom = Math.floor((Math.max(a.y, b.y) - minY) / bucketSize);
    const keys: string[] = [];
    for (let y = top; y <= bottom; y += 1)
      for (let x = left; x <= right; x += 1) keys.push(`${x}:${y}`);
    return keys;
  };

  for (let index = 0; index < points.length; index += 1) {
    const a = points[index];
    const b = points[(index + 1) % points.length];
    const keys = segmentBuckets(a, b);
    const candidates = new Set<number>();
    for (const key of keys) for (const candidate of buckets.get(key) ?? []) candidates.add(candidate);
    for (const candidate of candidates) {
      if (candidate === index || Math.abs(candidate - index) === 1 || (candidate === 0 && index === points.length - 1)) continue;
      const c = points[candidate];
      const d = points[(candidate + 1) % points.length];
      if (orientation(a, b, c) * orientation(a, b, d) < -1e-10 && orientation(c, d, a) * orientation(c, d, b) < -1e-10)
        return true;
    }
    for (const key of keys) {
      const entries = buckets.get(key) ?? [];
      entries.push(index);
      buckets.set(key, entries);
    }
  }
  return false;
}

function warpSharedSurfacePoint(
  point: Point,
  cellSize: number,
  worldWidth: number,
  worldHeight: number,
  settings: GeneratorSettings,
): Point {
  const frameDistance = Math.min(point.x, point.y, worldWidth - point.x, worldHeight - point.y);
  const frameFade = Math.max(0, Math.min(1, frameDistance / Math.max(1e-9, cellSize * 1.5)));
  if (frameFade <= 0) return point;
  const nx = point.x / Math.max(1e-9, worldWidth);
  const ny = point.y / Math.max(1e-9, worldHeight);
  const detailScale = Math.max(0.8, Math.min(2.8, Math.pow(Math.max(1, settings.mapScaleKm) / 450, 0.18)));
  const frequency = 18 + detailScale * 7;
  const amplitude = cellSize * (0.12 + Math.min(1.4, settings.coastlineDetail) * 0.075) * frameFade;
  const microFrequency = Math.max(32, worldWidth / Math.max(1e-9, cellSize) * 0.22);
  const dx = ((
    fractalPerlinNoise(nx * frequency, ny * frequency, settings.seed + 610_019, 3, 0.56, 2.03) - 0.5
  ) * amplitude * 2 + (
    fractalPerlinNoise(nx * microFrequency, ny * microFrequency, settings.seed + 611_009, 2, 0.52, 2.11) - 0.5
  ) * cellSize * 0.15) * frameFade;
  const dy = ((
    fractalPerlinNoise(nx * frequency + 37.1, ny * frequency - 19.7, settings.seed + 610_117, 3, 0.56, 2.03) - 0.5
  ) * amplitude * 2 + (
    fractalPerlinNoise(nx * microFrequency + 13.7, ny * microFrequency - 29.1, settings.seed + 611_117, 2, 0.52, 2.11) - 0.5
  ) * cellSize * 0.15) * frameFade;
  return {
    x: Math.max(0, Math.min(worldWidth, point.x + dx)),
    y: Math.max(0, Math.min(worldHeight, point.y + dy)),
  };
}

function regionPaths(
  mask: Uint8Array,
  width: number,
  height: number,
  worldWidth: number,
  worldHeight: number,
  settings: GeneratorSettings,
  waterLike: boolean,
): Point[][] {
  const cellSize = Math.max(worldWidth / width, worldHeight / height);
  const physicalArea = Math.max(1, settings.mapScaleKm * settings.mapScaleKm * height / Math.max(1, width));
  const patchScale = Math.max(0.55, Math.min(3.5, Math.pow(160_000 / physicalArea, 0.18)));
  const segments = boundaryEdges(mask, width, height, worldWidth, worldHeight);
  const paths = traceClosedBoundaryLoops(segments);
  const detailAreaScale = Math.max(0.34, 256 / Math.max(256, width));
  const minimumArea =
    cellSize *
    cellSize *
    (waterLike ? 0.42 : 2.1) *
    patchScale *
    detailAreaScale;
  const result: Point[][] = [];
  for (let index = 0; index < paths.length; index += 1) {
    const raw = paths[index];
    const points = normalizeSurfaceRing(raw.slice(0, -1), cellSize * 1e-7);
    if (points.length < 4 || pathArea(points) < minimumArea || ringHasSelfIntersection(points)) continue;
    const warped = normalizeSurfaceRing(
      points.map((point) => warpSharedSurfacePoint(point, cellSize, worldWidth, worldHeight, settings)),
      cellSize * 1e-7,
    );
    const display = warped.length >= 4 && !ringHasSelfIntersection(warped) ? warped : points;
    if (display.length >= 6 && pathArea(display) >= minimumArea * 0.7) result.push(display);
  }
  return result;
}

/** Removes collapsed frame vertices without independently smoothing shared edges. */
export function normalizeSurfaceRing(points: Point[], epsilon = 1e-9): Point[] {
  const result: Point[] = [];
  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    const previous = result[result.length - 1];
    if (previous && Math.hypot(point.x - previous.x, point.y - previous.y) <= epsilon) continue;
    result.push(point);
  }
  if (result.length > 1 && Math.hypot(result[0].x - result[result.length - 1].x, result[0].y - result[result.length - 1].y) <= epsilon)
    result.pop();
  return result;
}

/** Converts an analysis mask into closed display-vector rings. */
export function vectorMaskPaths(
  mask: Uint8Array,
  width: number,
  height: number,
  worldWidth: number,
  worldHeight: number,
  settings: GeneratorSettings,
): Point[][] {
  return regionPaths(mask, width, height, worldWidth, worldHeight, settings, false);
}

/**
 * Returns the authoritative land rings at the same resolution and with the
 * same shared vertex warp used by every generated surface and territory.
 */
export function canonicalLandPaths(data: GeneratedMapData): Point[][] {
  const cached = canonicalLandPathCache.get(data);
  if (cached) return cached;
  const dimensions = surfaceVectorDimensions(data.gridWidth, data.gridHeight, data.settings, "final");
  const mask = new Uint8Array(dimensions.width * dimensions.height);
  for (let y = 0; y < dimensions.height; y += 1) {
    const sourceY = Math.max(0, Math.min(data.gridHeight - 1, Math.floor((y + 0.5) / dimensions.height * data.gridHeight)));
    for (let x = 0; x < dimensions.width; x += 1) {
      const sourceX = Math.max(0, Math.min(data.gridWidth - 1, Math.floor((x + 0.5) / dimensions.width * data.gridWidth)));
      if (data.waterTypeMap[sourceY * data.gridWidth + sourceX] === "land") mask[y * dimensions.width + x] = 1;
    }
  }
  const paths = vectorMaskPaths(
    mask,
    dimensions.width,
    dimensions.height,
    data.worldWidth,
    data.worldHeight,
    data.settings,
  );
  canonicalLandPathCache.set(data, paths);
  return paths;
}

export function surfaceGeometryFingerprint(data: GeneratedMapData): string {
  const cached = surfaceFingerprintCache.get(data);
  if (cached) return cached;
  let hash = 2166136261;
  for (let index = 0; index < data.waterTypeMap.length; index += 1) {
    const value = data.waterTypeMap[index] === "land" ? 1 : data.waterTypeMap[index] === "freshwater" ? 2 : 3;
    hash ^= value + (index & 255);
    hash = Math.imul(hash, 16777619);
  }
  const fingerprint = `${CURRENT_SURFACE_VECTOR_VERSION}:${data.gridWidth}x${data.gridHeight}:${(hash >>> 0).toString(36)}`;
  surfaceFingerprintCache.set(data, fingerprint);
  return fingerprint;
}

export function surfaceVectorDimensions(
  width: number,
  height: number,
  settings: GeneratorSettings,
  quality: "preview" | "final" = "final",
): { width: number; height: number } {
  const mapDetailScale = Math.max(0.8, Math.min(3.2, Math.pow(Math.max(1, settings.mapScaleKm) / 450, 0.22)));
  const vectorBudget = quality === "preview"
    ? Math.round(256 * Math.min(1.6, mapDetailScale))
    : Math.round(1024 * mapDetailScale);
  const maximumWidth = quality === "preview" ? 512 : 4096;
  const targetWidth = Math.min(width, Math.max(256, Math.min(maximumWidth, vectorBudget)));
  return {
    width: targetWidth,
    height: Math.max(32, Math.round(targetWidth * height / Math.max(1, width))),
  };
}

/**
 * 분석은 래스터로 유지하되 렌더링용으로 같은 지형 연결 영역을 벡터 멀티폴리곤으로 변환한다.
 * 최종 격자가 매우 큰 경우 최대 512 LOD로 내린 뒤 경계를 생성해 데이터 폭증을 막는다.
 */
export function buildSurfaceRegions(
  terrainMap: TerrainType[],
  waterTypeMap: WaterType[],
  width: number,
  height: number,
  worldWidth: number,
  worldHeight: number,
  settings: GeneratorSettings,
  quality: "preview" | "final" = "final",
  agricultureMap?: number[],
): GeneratedSurfaceRegion[] {
  const dimensions = surfaceVectorDimensions(width, height, settings, quality);
  const targetWidth = dimensions.width;
  const targetHeight = dimensions.height;
  const sampleTerrain = new Array<TerrainType>(targetWidth * targetHeight);
  const sampleWater = new Array<WaterType>(targetWidth * targetHeight);
  const sampleAgriculture = new Float32Array(targetWidth * targetHeight);
  for (let y = 0; y < targetHeight; y += 1) {
    const sourceY = Math.max(0, Math.min(height - 1, Math.floor((y + 0.5) / targetHeight * height)));
    for (let x = 0; x < targetWidth; x += 1) {
      const sourceX = Math.max(0, Math.min(width - 1, Math.floor((x + 0.5) / targetWidth * width)));
      const sourceIndex = sourceY * width + sourceX;
      const targetIndex = y * targetWidth + x;
      sampleTerrain[targetIndex] = terrainMap[sourceIndex] ?? "plain";
      sampleWater[targetIndex] = waterTypeMap[sourceIndex] ?? "land";
      sampleAgriculture[targetIndex] = Math.max(0, Math.min(1, agricultureMap?.[sourceIndex] ?? 0));
    }
  }

  // Forest probability fields can leave diagonal one-cell tendrils that become
  // acute GPU triangles. Reclassify only those display-scale outliers before
  // every surface mask is built so no uncovered cell or independent patch fix remains.
  for (let pass = 0; pass < 2; pass += 1) {
    const next = [...sampleTerrain];
    for (let y = 1; y < targetHeight - 1; y += 1) for (let x = 1; x < targetWidth - 1; x += 1) {
      const index = y * targetWidth + x;
      if (sampleWater[index] !== "land" || !["forest", "jungle"].includes(sampleTerrain[index])) continue;
      let woodlandNeighbors = 0;
      let cardinalNeighbors = 0;
      const replacements = new Map<TerrainType, number>();
      for (let oy = -1; oy <= 1; oy += 1) for (let ox = -1; ox <= 1; ox += 1) {
        if (!ox && !oy) continue;
        const terrain = sampleTerrain[(y + oy) * targetWidth + x + ox];
        if (terrain === "forest" || terrain === "jungle") {
          woodlandNeighbors += 1;
          if (!ox || !oy) cardinalNeighbors += 1;
        } else replacements.set(terrain, (replacements.get(terrain) ?? 0) + 1);
      }
      if (woodlandNeighbors > 2 && cardinalNeighbors > 0) continue;
      const replacement = [...replacements].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "grassland";
      next[index] = replacement === "farmland" ? "plain" : replacement;
    }
    for (let index = 0; index < sampleTerrain.length; index += 1) sampleTerrain[index] = next[index];
  }

  const regions: GeneratedSurfaceRegion[] = [];
  for (let typeIndex = 0; typeIndex < TERRAIN_ORDER.length; typeIndex += 1) {
    const terrain = TERRAIN_ORDER[typeIndex];
    const mask = new Uint8Array(sampleTerrain.length);
    let count = 0;
    for (let index = 0; index < mask.length; index += 1) {
      if (sampleWater[index] === "land" && sampleTerrain[index] === terrain) { mask[index] = 1; count += 1; }
    }
    if (!count) continue;
    const polygons = regionPaths(mask, targetWidth, targetHeight, worldWidth, worldHeight, settings, false);
    if (polygons.length) regions.push({ surface: terrain, polygons });
  }
  const farmlandMask = new Uint8Array(sampleTerrain.length);
  let farmlandCount = 0;
  for (let index = 0; index < farmlandMask.length; index += 1) {
    if (sampleWater[index] === "land" && sampleAgriculture[index] >= AGRICULTURE_VISIBLE_THRESHOLD) {
      farmlandMask[index] = 1;
      farmlandCount += 1;
    }
  }
  if (farmlandCount) {
    const polygons = regionPaths(farmlandMask, targetWidth, targetHeight, worldWidth, worldHeight, settings, false);
    if (polygons.length) regions.push({ surface: "farmland", polygons });
  }
  for (const water of ["saltwater", "freshwater"] as const) {
    const mask = new Uint8Array(sampleWater.length);
    let count = 0;
    for (let index = 0; index < mask.length; index += 1) {
      if (sampleWater[index] === water) { mask[index] = 1; count += 1; }
    }
    if (!count) continue;
    const polygons = regionPaths(mask, targetWidth, targetHeight, worldWidth, worldHeight, settings, true);
    if (polygons.length) regions.push({ surface: water, polygons });
  }
  return regions;
}

function isMapFrameSegment(
  segment: LineSegment,
  worldWidth: number,
  worldHeight: number,
): boolean {
  const epsilon = Math.max(worldWidth, worldHeight) * 1e-8;
  const sameVerticalEdge =
    (segment.start.x <= epsilon && segment.end.x <= epsilon) ||
    (segment.start.x >= worldWidth - epsilon &&
      segment.end.x >= worldWidth - epsilon);
  const sameHorizontalEdge =
    (segment.start.y <= epsilon && segment.end.y <= epsilon) ||
    (segment.start.y >= worldHeight - epsilon &&
      segment.end.y >= worldHeight - epsilon);
  return sameVerticalEdge || sameHorizontalEdge;
}

/** Returns the exact polygon edges used to draw a generated surface. */
export function surfaceBoundarySegments(
  regions: GeneratedSurfaceRegion[] | undefined,
  surface: GeneratedSurface,
  worldWidth: number,
  worldHeight: number,
  excludeMapFrame = false,
): LineSegment[] {
  return surfaceBoundaryPaths(
    regions,
    surface,
    worldWidth,
    worldHeight,
    excludeMapFrame,
  ).flatMap((path) =>
    path.slice(1).map((point, index) => ({ start: path[index], end: point })),
  );
}

/** Returns stored polygon paths without reconstructing their adjacency. */
export function surfaceBoundaryPaths(
  regions: GeneratedSurfaceRegion[] | undefined,
  surface: GeneratedSurface,
  worldWidth: number,
  worldHeight: number,
  excludeMapFrame = false,
): Point[][] {
  const paths: Point[][] = [];
  for (const region of regions ?? []) {
    if (region.surface !== surface) continue;
    for (const polygon of region.polygons) {
      const closedLength =
        polygon.length > 1 &&
        Math.hypot(
          polygon[0].x - polygon[polygon.length - 1].x,
          polygon[0].y - polygon[polygon.length - 1].y,
        ) < 1e-9
          ? polygon.length - 1
          : polygon.length;
      if (closedLength < 3) continue;
      const edges = Array.from({ length: closedLength }, (_, index) => ({
          start: polygon[index],
          end: polygon[(index + 1) % closedLength],
      }));
      if (
        !excludeMapFrame ||
        edges.every((edge) => !isMapFrameSegment(edge, worldWidth, worldHeight))
      ) {
        paths.push([...edges.map((edge) => edge.start), edges[0].start]);
        continue;
      }

      const firstFrameEdge = edges.findIndex((edge) =>
        isMapFrameSegment(edge, worldWidth, worldHeight),
      );
      let current: Point[] = [];
      for (let offset = 1; offset <= edges.length; offset += 1) {
        const edge = edges[(firstFrameEdge + offset) % edges.length];
        if (isMapFrameSegment(edge, worldWidth, worldHeight)) {
          if (current.length >= 2) paths.push(current);
          current = [];
        } else {
          if (current.length === 0) current.push(edge.start);
          current.push(edge.end);
        }
      }
      if (current.length >= 2) paths.push(current);
    }
  }
  return paths;
}

export function refreshSurfaceRegions(data: GeneratedMapData, quality: "preview" | "final" = "final"): GeneratedMapData {
  const terrainMap = normalizedNaturalTerrainMap(data);
  const agricultureMap = normalizedAgricultureMap(data);
  const surfaceRegions = buildSurfaceRegions(
    terrainMap,
    data.waterTypeMap,
    data.gridWidth,
    data.gridHeight,
    data.worldWidth,
    data.worldHeight,
    data.settings,
    quality,
    agricultureMap,
  );
  return {
    ...data,
    terrainMap,
    baseTerrainMap: [...terrainMap],
    agricultureMap,
    surfaceVectorVersion: CURRENT_SURFACE_VECTOR_VERSION,
    surfaceRegions,
    coastline: surfaceBoundarySegments(
      surfaceRegions,
      "saltwater",
      data.worldWidth,
      data.worldHeight,
      true,
    ),
  };
}

function surfaceGeometryLimits(data: GeneratedMapData): { maximumEdge: number; epsilon: number } {
  const dimensions = surfaceVectorDimensions(data.gridWidth, data.gridHeight, data.settings, "final");
  const targetWidth = dimensions.width;
  const targetHeight = dimensions.height;
  const cellSize = Math.max(
    data.worldWidth / Math.max(1, targetWidth),
    data.worldHeight / Math.max(1, targetHeight),
  );
  return {
    maximumEdge: cellSize * 1.55,
    epsilon: Math.max(data.worldWidth, data.worldHeight) * 1e-8,
  };
}

/** Prevents malformed rings from reaching Canvas or GPU triangulation. */
export function isSafeSurfacePolygon(data: GeneratedMapData, polygon: Point[]): boolean {
  if (polygon.length < 6) return false;
  const { maximumEdge, epsilon } = surfaceGeometryLimits(data);
  const vertexKeys = new Set<string>();
  let signedArea = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const point = polygon[index];
    const next = polygon[(index + 1) % polygon.length];
    const vertexKey = `${point.x.toFixed(12)}:${point.y.toFixed(12)}`;
    if (
      !Number.isFinite(point.x) || !Number.isFinite(point.y) ||
      point.x < -epsilon || point.y < -epsilon ||
      point.x > data.worldWidth + epsilon || point.y > data.worldHeight + epsilon ||
      vertexKeys.has(vertexKey) ||
      Math.hypot(next.x - point.x, next.y - point.y) > maximumEdge
    ) return false;
    vertexKeys.add(vertexKey);
    signedArea += point.x * next.y - next.x * point.y;
  }
  const minimumArea = Math.max(data.worldWidth, data.worldHeight) ** 2 * 1e-12;
  return Number.isFinite(signedArea) && Math.abs(signedArea) * 0.5 > minimumArea && !ringHasSelfIntersection(polygon);
}

/** Rejects legacy or corrupted polygons before they are reused from storage. */
export function hasValidSurfaceGeometry(data: GeneratedMapData): boolean {
  if (data.surfaceVectorVersion !== CURRENT_SURFACE_VECTOR_VERSION || !data.surfaceRegions?.length) return false;
  for (const region of data.surfaceRegions) {
    for (const polygon of region.polygons) {
      if (!isSafeSurfacePolygon(data, polygon)) return false;
    }
  }
  return true;
}
