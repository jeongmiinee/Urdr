import { pointInPolygon, type GeneratedMapData, type Point, type TerrainType } from "../model/world";
import { rebuildGeneratedMapData } from "./generateWorld";
import { createGridTransform } from "./gridTransform";
import { normalizedAgricultureMap, normalizedNaturalTerrainMap } from "./agriculture";
import { reconcileElevationWithWaterAndLakes } from "./waterElevation";

function cellFromPoint(data: GeneratedMapData, point: Point): { x: number; y: number } {
  const cell = createGridTransform(data.worldWidth, data.worldHeight, data.gridWidth, data.gridHeight).worldToCell(point);
  return { x: cell.x, y: cell.y };
}

function brushRadiusCells(data: GeneratedMapData, radiusWorld: number): { x: number; y: number } {
  return createGridTransform(data.worldWidth, data.worldHeight, data.gridWidth, data.gridHeight).worldRadiusToCellRadius(radiusWorld);
}

export function resampleBrushStroke(points: Point[], maximumSpacing: number): Point[] {
  if (points.length < 2) return points.map((point) => ({ ...point }));
  const spacing = Math.max(1e-4, maximumSpacing);
  const result: Point[] = [{ ...points[0] }];
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    const distance = Math.hypot(end.x - start.x, end.y - start.y);
    const steps = Math.max(1, Math.ceil(distance / spacing));
    for (let step = 1; step <= steps; step += 1) {
      const ratio = step / steps;
      result.push({ x: start.x + (end.x - start.x) * ratio, y: start.y + (end.y - start.y) * ratio });
    }
  }
  return result;
}

export type ElevationBrushMode = "target" | "raise" | "lower";

export type ElevationBrushSettings = {
  mode: ElevationBrushMode;
  value: number;
  strength: number;
  falloff: number;
};

function cellNoise(x: number, y: number): number {
  let value = Math.imul(x + 1, 0x1f123bb5) ^ Math.imul(y + 1, 0x5f356495);
  value = Math.imul(value ^ (value >>> 15), 0x2c1b3c6d);
  value ^= value >>> 12;
  return (value >>> 0) / 0xffffffff;
}

function brushStrokeInfluences(
  data: GeneratedMapData,
  points: Point[],
  radiusWorld: number,
  falloff = 0.65,
  shapeNoise = 0,
): Map<number, number> {
  const transform = createGridTransform(data.worldWidth, data.worldHeight, data.gridWidth, data.gridHeight);
  const { x: radiusX, y: radiusY } = transform.worldRadiusToCellRadius(radiusWorld);
  const spacing = Math.min(transform.cellSizeX, transform.cellSizeY) * 0.48;
  const samples = resampleBrushStroke(points, spacing);
  const influences = new Map<number, number>();
  const safeFalloff = Math.max(0, Math.min(1, falloff));
  const safeNoise = Math.max(0, Math.min(1, shapeNoise));
  for (const point of samples) {
    const center = transform.worldToCell(point);
    for (let y = Math.max(0, center.y - radiusY); y <= Math.min(data.gridHeight - 1, center.y + radiusY); y += 1) {
      for (let x = Math.max(0, center.x - radiusX); x <= Math.min(data.gridWidth - 1, center.x + radiusX); x += 1) {
        const dx = (x - center.x) / Math.max(1, radiusX);
        const dy = (y - center.y) / Math.max(1, radiusY);
        const distance = Math.hypot(dx, dy);
        const boundary = 1 + (cellNoise(x, y) - 0.5) * safeNoise * 0.72;
        if (distance > boundary) continue;
        const normalizedDistance = Math.min(1, distance / Math.max(0.35, boundary));
        const index = y * data.gridWidth + x;
        const softWeight = Math.pow(1 - normalizedDistance, 0.45 + safeFalloff * 2.55);
        const weight = safeFalloff <= 0.001 ? 1 : softWeight;
        influences.set(index, Math.max(influences.get(index) ?? 0, weight));
      }
    }
  }
  return influences;
}

function terrainElevationFloor(type: TerrainType, seaLevel: number): number {
  switch (type) {
    case "mountain": return seaLevel + 1800;
    case "snow": return seaLevel + 3300;
    case "bedrock": return seaLevel + 1200;
    case "rock": return seaLevel + 850;
    case "wetland": return seaLevel + 10;
    case "farmland": return seaLevel + 35;
    default: return seaLevel + 70;
  }
}


/** 붓 입력 직후 화면에 반영하는 경량 편집. 기후·수문·등고선은 이후 백그라운드에서 재계산한다. */
export function applyTerrainBrushStrokeImmediate(
  data: GeneratedMapData,
  points: Point[],
  radiusWorld: number,
  terrainType: TerrainType,
  shapeNoise = 0,
): GeneratedMapData {
  const terrain = normalizedNaturalTerrainMap(data);
  const agriculture = normalizedAgricultureMap(data);
  const snowBase = [...(data.snowBaseTerrainMap ?? terrain)];
  const snowCover = [...(data.snowCoverMap ?? new Array(data.terrainMap.length).fill(0))];
  for (const index of brushStrokeInfluences(data, points, radiusWorld, 0, shapeNoise).keys()) {
    if (data.waterTypeMap[index] !== "land") continue;
    if (terrainType === "farmland") agriculture[index] = 1;
    else {
      terrain[index] = terrainType;
      agriculture[index] = 0;
    }
    snowBase[index] = terrainType === "snow" ? (snowBase[index] ?? "mountain") : terrain[index];
    snowCover[index] = terrainType === "snow" ? 1 : 0;
  }
  return { ...data, baseTerrainMap: [...terrain], agricultureMap: agriculture, terrainMap: terrain, snowBaseTerrainMap: snowBase, snowCoverMap: snowCover, generatedAt: new Date().toISOString() };
}

export function applyTerrainBrushImmediate(data: GeneratedMapData, point: Point, radiusWorld: number, terrainType: TerrainType): GeneratedMapData {
  return applyTerrainBrushStrokeImmediate(data, [point], radiusWorld, terrainType);
}

/** 고도 붓의 즉시 미리보기. 파생 데이터는 별도 작업 큐에서 다시 계산한다. */
export function applyElevationBrushStrokeImmediate(
  data: GeneratedMapData,
  points: Point[],
  radiusWorld: number,
  settingsOrDelta: ElevationBrushSettings | number,
): GeneratedMapData {
  const settings: ElevationBrushSettings = typeof settingsOrDelta === "number"
    ? { mode: settingsOrDelta < 0 ? "lower" : "raise", value: Math.abs(settingsOrDelta), strength: 1, falloff: 0.65 }
    : settingsOrDelta;
  const elevation = [...data.elevationMap];
  const strength = Math.max(0.01, Math.min(1, settings.strength));
  for (const [index, weight] of brushStrokeInfluences(data, points, radiusWorld, settings.falloff)) {
    if (data.waterTypeMap[index] !== "land") continue;
    const current = elevation[index];
    const next = settings.mode === "target"
      ? current + (settings.value - current) * strength * weight
      : current + (settings.mode === "raise" ? 1 : -1) * Math.abs(settings.value) * strength * weight;
    elevation[index] = Math.max(-9000, Math.min(data.settings.maxElevation * 1.35, next));
  }
  return {
    ...data,
    elevationMap: reconcileElevationWithWaterAndLakes(
      elevation,
      data.waterTypeMap,
      data.seaLevel,
      data.lakeIdMap,
      data.lakeSurfaceElevations,
    ),
    generatedAt: new Date().toISOString(),
  };
}

export function applyElevationBrushImmediate(data: GeneratedMapData, point: Point, radiusWorld: number, delta: number): GeneratedMapData {
  return applyElevationBrushStrokeImmediate(data, [point], radiusWorld, delta);
}

/** 지형은 표면 종류만 칠하고, 물 여부는 해발 고도와 해수면으로 결정한다. */
export function applyTerrainBrush(data: GeneratedMapData, point: Point, radiusWorld: number, terrainType: TerrainType): GeneratedMapData {
  const center = cellFromPoint(data, point);
  const { x: radiusX, y: radiusY } = brushRadiusCells(data, radiusWorld);
  const elevation = [...data.elevationMap];
  const terrain = normalizedNaturalTerrainMap(data);
  const agriculture = normalizedAgricultureMap(data);
  for (let y = Math.max(0, center.y - radiusY); y <= Math.min(data.gridHeight - 1, center.y + radiusY); y += 1) {
    for (let x = Math.max(0, center.x - radiusX); x <= Math.min(data.gridWidth - 1, center.x + radiusX); x += 1) {
      const dx = (x - center.x) / radiusX;
      const dy = (y - center.y) / radiusY;
      if (dx * dx + dy * dy > 1) continue;
      const index = y * data.gridWidth + x;
      if (terrainType === "farmland") agriculture[index] = 1;
      else {
        terrain[index] = terrainType;
        agriculture[index] = 0;
      }
      // 수면 아래에서는 해저 지형만 바꾸고 지표를 강제로 솟게 하지 않는다.
      if (elevation[index] > data.seaLevel) elevation[index] = Math.max(elevation[index], terrainElevationFloor(terrainType, data.seaLevel));
    }
  }
  return rebuildGeneratedMapData(data, elevation, terrain, data.seaLevel, agriculture);
}

export function applyElevationBrush(data: GeneratedMapData, point: Point, radiusWorld: number, delta: number): GeneratedMapData {
  const center = cellFromPoint(data, point);
  const { x: radiusX, y: radiusY } = brushRadiusCells(data, radiusWorld);
  const elevation = [...data.elevationMap];
  for (let y = Math.max(0, center.y - radiusY); y <= Math.min(data.gridHeight - 1, center.y + radiusY); y += 1) {
    for (let x = Math.max(0, center.x - radiusX); x <= Math.min(data.gridWidth - 1, center.x + radiusX); x += 1) {
      const dx = (x - center.x) / radiusX;
      const dy = (y - center.y) / radiusY;
      const distance = Math.sqrt(dx * dx + dy * dy);
      if (distance > 1) continue;
      const weight = Math.pow(1 - distance, 1.5);
      const index = y * data.gridWidth + x;
      elevation[index] = Math.max(-9000, Math.min(data.settings.maxElevation * 1.35, elevation[index] + delta * weight));
    }
  }
  // 고도가 해수면 아래로 내려가면 자동으로 물에 잠기며, 지형·해안선·수중 등고선을 다시 계산한다.
  return rebuildGeneratedMapData(data, elevation, undefined, data.seaLevel);
}

export function applySeaLevel(data: GeneratedMapData, seaLevel: number): GeneratedMapData {
  const safeLevel = Math.max(-5000, Math.min(data.settings.maxElevation - 50, Math.round(seaLevel)));
  return rebuildGeneratedMapData(data, data.elevationMap, undefined, safeLevel);
}



type GridVertex = { x: number; y: number };

function polygonArea(points: Point[]): number {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    area += current.x * next.y - next.x * current.y;
  }
  return area * 0.5;
}

function simplifyClosedPolygon(points: Point[], minimumDistance: number): Point[] {
  if (points.length < 4) return points;
  const distanceFiltered: Point[] = [];
  for (const point of points) {
    const previous = distanceFiltered[distanceFiltered.length - 1];
    if (!previous || Math.hypot(point.x - previous.x, point.y - previous.y) >= minimumDistance) {
      distanceFiltered.push(point);
    }
  }
  if (distanceFiltered.length < 4) return distanceFiltered;
  return distanceFiltered.filter((point, index, all) => {
    const previous = all[(index - 1 + all.length) % all.length];
    const next = all[(index + 1) % all.length];
    const cross = (point.x - previous.x) * (next.y - point.y) - (point.y - previous.y) * (next.x - point.x);
    return Math.abs(cross) > 1e-6;
  });
}

function chaikinClosed(points: Point[]): Point[] {
  if (points.length < 4) return points;
  const result: Point[] = [];
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    result.push(
      { x: current.x * 0.75 + next.x * 0.25, y: current.y * 0.75 + next.y * 0.25 },
      { x: current.x * 0.25 + next.x * 0.75, y: current.y * 0.25 + next.y * 0.75 },
    );
  }
  return result;
}

function orientation(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function segmentsCross(a: Point, b: Point, c: Point, d: Point): boolean {
  const abC = orientation(a, b, c);
  const abD = orientation(a, b, d);
  const cdA = orientation(c, d, a);
  const cdB = orientation(c, d, b);
  return abC * abD < -1e-7 && cdA * cdB < -1e-7;
}

function hasSelfIntersection(points: Point[]): boolean {
  for (let first = 0; first < points.length; first += 1) {
    const a = points[first];
    const b = points[(first + 1) % points.length];
    for (let second = first + 2; second < points.length; second += 1) {
      if ((second + 1) % points.length === first) continue;
      const c = points[second];
      const d = points[(second + 1) % points.length];
      if (segmentsCross(a, b, c, d)) return true;
    }
  }
  return false;
}

type RasterBooleanOperation = "union" | "subtract";

function traceRasterOperation(existingPolygon: Point[], brushPolygon: Point[], operation: RasterBooleanOperation): Point[][] {
  const source = [...existingPolygon, ...brushPolygon];
  if (source.length < 3) return [];
  const minX = Math.min(...source.map((point) => point.x));
  const maxX = Math.max(...source.map((point) => point.x));
  const minY = Math.min(...source.map((point) => point.y));
  const maxY = Math.max(...source.map((point) => point.y));
  const spanX = Math.max(1e-3, maxX - minX);
  const spanY = Math.max(1e-3, maxY - minY);
  const padding = Math.max(spanX, spanY) * 0.04 + 0.2;
  const left = minX - padding;
  const top = minY - padding;
  const widthWorld = spanX + padding * 2;
  const heightWorld = spanY + padding * 2;
  const resolution = 160;
  const gridWidth = Math.max(24, Math.round(resolution * widthWorld / Math.max(widthWorld, heightWorld)));
  const gridHeight = Math.max(24, Math.round(resolution * heightWorld / Math.max(widthWorld, heightWorld)));
  const mask = new Uint8Array(gridWidth * gridHeight);
  for (let y = 0; y < gridHeight; y += 1) {
    for (let x = 0; x < gridWidth; x += 1) {
      const point = {
        x: left + ((x + 0.5) / gridWidth) * widthWorld,
        y: top + ((y + 0.5) / gridHeight) * heightWorld,
      };
      const inExisting = existingPolygon.length >= 3 && pointInPolygon(point, existingPolygon);
      const inBrush = pointInPolygon(point, brushPolygon);
      if (operation === "union" ? inExisting || inBrush : inExisting && !inBrush) {
        mask[y * gridWidth + x] = 1;
      }
    }
  }

  // 단절된 붓 입력은 하나의 단순 폴리곤으로 표현할 수 없으므로 안전한 볼록껍질로 되돌린다.
  const seen = new Uint8Array(mask.length);
  let components = 0;
  const queue = new Int32Array(mask.length);
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || seen[start]) continue;
    components += 1;
    let head = 0; let tail = 0; queue[tail++] = start; seen[start] = 1;
    while (head < tail) {
      const index = queue[head++];
      const x = index % gridWidth; const y = Math.floor(index / gridWidth);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x + dx; const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= gridWidth || ny >= gridHeight) continue;
        const next = ny * gridWidth + nx;
        if (mask[next] && !seen[next]) { seen[next] = 1; queue[tail++] = next; }
      }
    }
  }
  if (operation === "union" && components !== 1) return [];

  const edges: Array<{ start: GridVertex; end: GridVertex; used: boolean }> = [];
  const isFilled = (x: number, y: number) => x >= 0 && y >= 0 && x < gridWidth && y < gridHeight && mask[y * gridWidth + x] === 1;
  const addEdge = (sx: number, sy: number, ex: number, ey: number) => edges.push({ start: { x: sx, y: sy }, end: { x: ex, y: ey }, used: false });
  for (let y = 0; y < gridHeight; y += 1) for (let x = 0; x < gridWidth; x += 1) {
    if (!isFilled(x, y)) continue;
    if (!isFilled(x, y - 1)) addEdge(x, y, x + 1, y);
    if (!isFilled(x + 1, y)) addEdge(x + 1, y, x + 1, y + 1);
    if (!isFilled(x, y + 1)) addEdge(x + 1, y + 1, x, y + 1);
    if (!isFilled(x - 1, y)) addEdge(x, y + 1, x, y);
  }
  const byStart = new Map<string, number[]>();
  edges.forEach((edge, index) => {
    const key = `${edge.start.x},${edge.start.y}`;
    byStart.set(key, [...(byStart.get(key) ?? []), index]);
  });
  const loops: GridVertex[][] = [];
  for (let edgeIndex = 0; edgeIndex < edges.length; edgeIndex += 1) {
    if (edges[edgeIndex].used) continue;
    const loop: GridVertex[] = [];
    let current = edgeIndex;
    const startKey = `${edges[current].start.x},${edges[current].start.y}`;
    for (let guard = 0; guard <= edges.length + 4; guard += 1) {
      const edge = edges[current];
      if (edge.used) break;
      edge.used = true;
      loop.push(edge.start);
      const endKey = `${edge.end.x},${edge.end.y}`;
      if (endKey === startKey) break;
      const candidates = (byStart.get(endKey) ?? []).filter((index) => !edges[index].used);
      if (candidates.length === 0) break;
      current = candidates[0];
    }
    if (loop.length >= 3) loops.push(loop);
  }
  if (loops.length === 0) return [];
  const toWorld = (vertex: GridVertex): Point => ({
    x: left + (vertex.x / gridWidth) * widthWorld,
    y: top + (vertex.y / gridHeight) * heightWorld,
  });
  return loops
    .map((loop) => loop.map(toWorld))
    .sort((a, b) => Math.abs(polygonArea(b)) - Math.abs(polygonArea(a)));
}

/**
 * 기존 영토와 원형 붓을 래스터 합집합으로 결합해 오목한 외곽선을 보존한다.
 * 단절 영역이나 추적 실패가 생기면 자기교차가 없는 볼록껍질로 안전하게 대체한다.
 */
export function buildTerritoryPolygon(existingPolygon: Point[], brushPoints: Point[]): Point[] {
  const merged = [...existingPolygon, ...brushPoints];
  if (merged.length < 3) return merged;
  const traced = traceRasterOperation(existingPolygon, brushPoints, "union")[0];
  if (!traced) return convexHull(merged);
  const extent = Math.max(
    Math.max(...traced.map((point) => point.x)) - Math.min(...traced.map((point) => point.x)),
    Math.max(...traced.map((point) => point.y)) - Math.min(...traced.map((point) => point.y)),
  );
  const simplified = simplifyClosedPolygon(traced, Math.max(0.03, extent / 240));
  const smoothed = chaikinClosed(simplified);
  return smoothed.length >= 3 && !hasSelfIntersection(smoothed) ? smoothed : simplified;
}

export function subtractTerritoryBrush(
  existingPolygon: Point[],
  existingHoles: Point[][],
  brushPoints: Point[],
): { polygon: Point[]; holes: Point[][] } | null {
  const loops = traceRasterOperation(existingPolygon, brushPoints, "subtract");
  if (loops.length === 0) return null;
  const polygon = simplifyClosedPolygon(loops[0], Math.max(0.03, Math.sqrt(Math.abs(polygonArea(loops[0]))) / 180));
  if (polygon.length < 3) return null;
  const generatedHoles = loops.slice(1).filter((loop) => loop.length >= 3 && pointInPolygon(loop[0], polygon));
  const preservedHoles = existingHoles.filter((hole) => !hole.some((point) => pointInPolygon(point, brushPoints)));
  return { polygon, holes: [...preservedHoles, ...generatedHoles] };
}

/** Catmull–Rom 보간으로 제어점을 통과하는 부드러운 곡선을 만든다. */
export function createSmoothCurve(points: Point[], samplesPerSegment = 12): Point[] {
  if (points.length < 3) return [...points];
  const result: Point[] = [];
  const p = [points[0], ...points, points[points.length - 1]];
  for (let i = 1; i < p.length - 2; i += 1) {
    const p0 = p[i - 1]; const p1 = p[i]; const p2 = p[i + 1]; const p3 = p[i + 2];
    for (let step = 0; step < samplesPerSegment; step += 1) {
      const t = step / samplesPerSegment;
      const t2 = t * t; const t3 = t2 * t;
      result.push({
        x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      });
    }
  }
  result.push(points[points.length - 1]);
  return result;
}

export function convexHull(points: Point[]): Point[] {
  if (points.length <= 3) return [...points];
  const sorted = [...points].sort((a, b) => a.x === b.x ? a.y - b.y : a.x - b.x);
  const cross = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Point[] = [];
  for (const point of sorted) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) lower.pop(); lower.push(point); }
  const upper: Point[] = [];
  for (const point of [...sorted].reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) upper.pop(); upper.push(point); }
  lower.pop(); upper.pop();
  return [...lower, ...upper];
}

export function brushCirclePoints(center: Point, radius: number, samples = 20): Point[] {
  return Array.from({ length: samples }, (_, index) => {
    const angle = (index / samples) * Math.PI * 2;
    return { x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius };
  });
}

/** Builds one round-capped vector footprint for an entire drag stroke. */
export function buildBrushStrokePolygon(points: Point[], radius: number, capSamples = 10): Point[] {
  if (points.length === 0) return [];
  if (points.length === 1) return brushCirclePoints(points[0], radius, capSamples * 2);
  const cleaned = points.filter((point, index) => index === 0 || Math.hypot(
    point.x - points[index - 1].x,
    point.y - points[index - 1].y,
  ) > 1e-7);
  if (cleaned.length === 1) return brushCirclePoints(cleaned[0], radius, capSamples * 2);
  const normals = cleaned.map((_point, index) => {
    const previous = cleaned[Math.max(0, index - 1)];
    const next = cleaned[Math.min(cleaned.length - 1, index + 1)];
    const dx = next.x - previous.x;
    const dy = next.y - previous.y;
    const length = Math.max(1e-9, Math.hypot(dx, dy));
    return { x: -dy / length, y: dx / length };
  });
  const left = cleaned.map((point, index) => ({
    x: point.x + normals[index].x * radius,
    y: point.y + normals[index].y * radius,
  }));
  const right = cleaned.map((point, index) => ({
    x: point.x - normals[index].x * radius,
    y: point.y - normals[index].y * radius,
  }));
  const result = [...left];
  const end = cleaned[cleaned.length - 1];
  const endAngle = Math.atan2(normals[normals.length - 1].y, normals[normals.length - 1].x);
  for (let sample = 1; sample <= capSamples; sample += 1) {
    const angle = endAngle + Math.PI * sample / capSamples;
    result.push({ x: end.x + Math.cos(angle) * radius, y: end.y + Math.sin(angle) * radius });
  }
  result.push(...right.slice(0, -1).reverse());
  const start = cleaned[0];
  const startAngle = Math.atan2(-normals[0].y, -normals[0].x);
  for (let sample = 1; sample <= capSamples; sample += 1) {
    const angle = startAngle + Math.PI * sample / capSamples;
    result.push({ x: start.x + Math.cos(angle) * radius, y: start.y + Math.sin(angle) * radius });
  }
  return hasSelfIntersection(result) ? convexHull(result) : result;
}
