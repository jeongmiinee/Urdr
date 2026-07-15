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

export const CURRENT_SURFACE_VECTOR_VERSION = 4;

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
        case 5: add(left, top); add(right, bottom); break;
        case 6: add(top, bottom); break;
        case 7: add(left, bottom); break;
        case 8: add(bottom, left); break;
        case 9: add(top, bottom); break;
        case 10: add(top, right); add(bottom, left); break;
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
  const detailAreaScale = Math.max(1, width / 256) ** 2;
  const minimumArea =
    cellSize *
    cellSize *
    (waterLike ? 0.42 : 2.1) *
    patchScale *
    detailAreaScale;
  const result: Point[][] = [];
  for (let index = 0; index < paths.length; index += 1) {
    const raw = paths[index];
    const points = raw.slice(0, -1);
    if (points.length < 4 || pathArea(points) < minimumArea) continue;
    if (points.length >= 6 && pathArea(points) >= minimumArea * 0.7) result.push(points);
  }
  return result;
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
  const targetWidth = Math.min(width, quality === "preview" ? 192 : 512);
  const targetHeight = Math.max(32, Math.round(targetWidth * height / Math.max(1, width)));
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
  const targetWidth = Math.min(data.gridWidth, 512);
  const targetHeight = Math.max(32, Math.round(targetWidth * data.gridHeight / Math.max(1, data.gridWidth)));
  const cellSize = Math.max(
    data.worldWidth / Math.max(1, targetWidth),
    data.worldHeight / Math.max(1, targetHeight),
  );
  return {
    maximumEdge: cellSize * 1.01,
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
  return Number.isFinite(signedArea) && Math.abs(signedArea) * 0.5 > minimumArea;
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
