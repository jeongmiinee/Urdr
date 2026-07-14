import type {
  GeneratedMapData,
  GeneratedSurfaceRegion,
  GeneratorSettings,
  LineSegment,
  Point,
  TerrainType,
  WaterType,
} from "../model/world";
import { chaikinPath, limitClosedPathCurvature, resamplePath, stitchSegments } from "./pathSmoothing";

const TERRAIN_ORDER: TerrainType[] = [
  "bedrock", "rock", "mountain", "desert", "snow", "plain", "grassland",
  "forest", "jungle", "wetland", "farmland",
];

function hash01(value: number): number {
  let x = value | 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return (x >>> 0) / 0xffffffff;
}

function boundaryEdges(mask: Uint8Array, width: number, height: number, worldWidth: number, worldHeight: number): LineSegment[] {
  const cellWidth = worldWidth / Math.max(1, width);
  const cellHeight = worldHeight / Math.max(1, height);
  const segments: LineSegment[] = [];
  const isInside = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x] === 1;
  const point = (x: number, y: number): Point => ({ x: x * cellWidth, y: y * cellHeight });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!isInside(x, y)) continue;
      if (!isInside(x, y - 1)) segments.push({ start: point(x, y), end: point(x + 1, y) });
      if (!isInside(x + 1, y)) segments.push({ start: point(x + 1, y), end: point(x + 1, y + 1) });
      if (!isInside(x, y + 1)) segments.push({ start: point(x + 1, y + 1), end: point(x, y + 1) });
      if (!isInside(x - 1, y)) segments.push({ start: point(x, y + 1), end: point(x, y) });
    }
  }
  return segments;
}

function cumulativeLength(points: Point[]): { lengths: number[]; total: number } {
  const lengths = [0];
  let total = 0;
  for (let index = 1; index <= points.length; index += 1) {
    const a = points[index - 1];
    const b = points[index % points.length];
    total += Math.hypot(b.x - a.x, b.y - a.y);
    lengths.push(total);
  }
  return { lengths, total };
}

/** 경계의 큰 흐름을 유지하면서 저·중·고주파 굴곡을 법선 방향으로 합성한다. */
function addHierarchicalBoundaryNoise(
  points: Point[],
  seed: number,
  amplitude: number,
  worldWidth: number,
  worldHeight: number,
): Point[] {
  if (points.length < 8 || amplitude <= 0) return points;
  const { lengths, total } = cumulativeLength(points);
  if (total <= 1e-6) return points;
  return points.map((point, index) => {
    const previous = points[(index - 1 + points.length) % points.length];
    const next = points[(index + 1) % points.length];
    const tx = next.x - previous.x;
    const ty = next.y - previous.y;
    const tangentLength = Math.max(1e-9, Math.hypot(tx, ty));
    const nx = -ty / tangentLength;
    const ny = tx / tangentLength;
    const phase = lengths[index] / total;
    const broad = Math.sin((phase * 2.1 + hash01(seed + 11)) * Math.PI * 2) * 0.54;
    const medium = Math.sin((phase * 7.3 + hash01(seed + 37)) * Math.PI * 2) * 0.29;
    const fine = Math.sin((phase * 19.7 + hash01(seed + 71)) * Math.PI * 2) * 0.12;
    const warped = Math.sin((phase * 3.7 + medium * 0.18 + hash01(seed + index * 13)) * Math.PI * 2) * 0.16;
    const displacement = amplitude * (broad + medium + fine + warped);
    return {
      x: Math.max(0, Math.min(worldWidth, point.x + nx * displacement)),
      y: Math.max(0, Math.min(worldHeight, point.y + ny * displacement)),
    };
  });
}

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
  seedOffset: number,
  waterLike: boolean,
  quality: "preview" | "final",
): Point[][] {
  const cellSize = Math.max(worldWidth / width, worldHeight / height);
  const physicalArea = Math.max(1, settings.mapScaleKm * settings.mapScaleKm * height / Math.max(1, width));
  const patchScale = Math.max(0.55, Math.min(3.5, Math.pow(160_000 / physicalArea, 0.18)));
  const segments = boundaryEdges(mask, width, height, worldWidth, worldHeight);
  const paths = stitchSegments(segments, cellSize * 0.18);
  const minimumArea = cellSize * cellSize * (waterLike ? 0.42 : 2.1) * patchScale;
  const result: Point[][] = [];
  for (let index = 0; index < paths.length; index += 1) {
    const raw = paths[index];
    const closed = raw.length > 3 && Math.hypot(raw[0].x - raw[raw.length - 1].x, raw[0].y - raw[raw.length - 1].y) <= cellSize * 0.5;
    if (!closed) continue;
    let points = raw.slice(0, -1);
    if (points.length < 4 || pathArea(points) < minimumArea) continue;
    const spacing = cellSize * (quality === "preview" ? 0.9 : 0.55) * Math.max(0.72, patchScale * 0.72);
    points = resamplePath([...points, points[0]], spacing).slice(0, -1);
    points = chaikinPath(points, waterLike ? 3 : 2, true);
    const noiseAmplitude = cellSize * (waterLike ? 1.18 : 0.42) * (0.62 + settings.coastlineDetail * 0.9) / Math.max(0.8, patchScale * 0.72);
    points = addHierarchicalBoundaryNoise(points, settings.seed + seedOffset + index * 991, noiseAmplitude, worldWidth, worldHeight);
    points = chaikinPath(points, 1, true);
    points = limitClosedPathCurvature(points, waterLike ? 24 : 30, waterLike ? 18 : 12);
    const finalSpacing = cellSize * (waterLike ? 0.34 : 0.52);
    points = resamplePath([...points, points[0]], finalSpacing).slice(0, -1);
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
): GeneratedSurfaceRegion[] {
  const targetWidth = Math.min(width, quality === "preview" ? 192 : 256);
  const targetHeight = Math.max(32, Math.round(targetWidth * height / Math.max(1, width)));
  const sampleTerrain = new Array<TerrainType>(targetWidth * targetHeight);
  const sampleWater = new Array<WaterType>(targetWidth * targetHeight);
  for (let y = 0; y < targetHeight; y += 1) {
    const sourceY = Math.max(0, Math.min(height - 1, Math.floor((y + 0.5) / targetHeight * height)));
    for (let x = 0; x < targetWidth; x += 1) {
      const sourceX = Math.max(0, Math.min(width - 1, Math.floor((x + 0.5) / targetWidth * width)));
      const sourceIndex = sourceY * width + sourceX;
      const targetIndex = y * targetWidth + x;
      sampleTerrain[targetIndex] = terrainMap[sourceIndex] ?? "plain";
      sampleWater[targetIndex] = waterTypeMap[sourceIndex] ?? "land";
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
    const polygons = regionPaths(mask, targetWidth, targetHeight, worldWidth, worldHeight, settings, 10_000 + typeIndex * 3_101, false, quality);
    if (polygons.length) regions.push({ surface: terrain, polygons });
  }
  for (const [waterIndex, water] of (["saltwater", "freshwater"] as const).entries()) {
    const mask = new Uint8Array(sampleWater.length);
    let count = 0;
    for (let index = 0; index < mask.length; index += 1) {
      if (sampleWater[index] === water) { mask[index] = 1; count += 1; }
    }
    if (!count) continue;
    const polygons = regionPaths(mask, targetWidth, targetHeight, worldWidth, worldHeight, settings, 70_000 + waterIndex * 9_977, true, quality);
    if (polygons.length) regions.push({ surface: water, polygons });
  }
  return regions;
}

export function refreshSurfaceRegions(data: GeneratedMapData, quality: "preview" | "final" = "final"): GeneratedMapData {
  return {
    ...data,
    surfaceRegions: buildSurfaceRegions(
      data.terrainMap,
      data.waterTypeMap,
      data.gridWidth,
      data.gridHeight,
      data.worldWidth,
      data.worldHeight,
      data.settings,
      quality,
    ),
  };
}
