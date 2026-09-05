import type { GeneratedMapData, LocationState, MapData, PlaceName, Point, Road, TerrainType } from "../model/world";
import { mulberry32 } from "./random";
import { getStateAtYear, isYearInRange, pointInPolygon, visibleLocations } from "../model/world";
import { limitPathCurvature, smoothPath } from "./pathSmoothing";
import { createGridTransform, nearestPowerOfTwo } from "./gridTransform";
import { CURRENT_SURFACE_VECTOR_VERSION, refreshSurfaceRegions, surfaceGeometryFingerprint } from "./surfaceVectors";
import { effectiveTerrainAt, normalizedNaturalTerrainMap } from "./agriculture";
import {
  CALIBRATED_NATURAL_BOUNDARY_WEIGHT,
  countryTypeCounts,
  totalCountryCount,
  type CountryArchetype,
} from "./countryGeneration";
import { buildVectorTerritoryRegions, clipTerritoryPartsToLand } from "./vectorTerritories";
import { riverCellMask, sampledRiverBoundaryPoints } from "../hydrology/riverQueries";
import {
  planSettlementHierarchy,
  settlementPoint,
  type PlannedSettlement,
} from "./settlements/hierarchy";


function downsampleGrid<T>(values: T[], sourceWidth: number, sourceHeight: number, targetWidth: number, targetHeight: number): T[] {
  const output = new Array<T>(targetWidth * targetHeight);
  for (let y = 0; y < targetHeight; y += 1) {
    const sy = Math.max(0, Math.min(sourceHeight - 1, Math.round(((y + 0.5) / targetHeight) * sourceHeight - 0.5)));
    for (let x = 0; x < targetWidth; x += 1) {
      const sx = Math.max(0, Math.min(sourceWidth - 1, Math.round(((x + 0.5) / targetWidth) * sourceWidth - 0.5)));
      output[y * targetWidth + x] = values[sy * sourceWidth + sx];
    }
  }
  return output;
}

function placementResolutionSource(source: GeneratedMapData): GeneratedMapData {
  // 도시·영토·도로 배치는 고해상도 환경장을 그대로 복제하지 않고 LOD 격자에서 수행한다.
  // 최종 지형/수문은 원본 해상도를 유지하고 벡터 결과만 월드 좌표로 되돌린다.
  if (source.gridWidth * source.gridHeight <= 65_536) return source;
  const gridWidth = Math.min(256, source.gridWidth);
  const idealHeight = gridWidth * source.gridHeight / Math.max(1, source.gridWidth);
  const gridHeight = Math.min(256, source.gridHeight, nearestPowerOfTwo(idealHeight, 64, 256));
  const sw = source.gridWidth;
  const sh = source.gridHeight;
  return {
    ...source,
    settings: { ...source.settings, gridWidth, gridHeight },
    gridWidth,
    gridHeight,
    elevationMap: downsampleGrid(source.elevationMap, sw, sh, gridWidth, gridHeight),
    landMask: downsampleGrid(source.landMask, sw, sh, gridWidth, gridHeight),
    waterTypeMap: downsampleGrid(source.waterTypeMap, sw, sh, gridWidth, gridHeight),
    coastalTerrainMap: downsampleGrid(source.coastalTerrainMap, sw, sh, gridWidth, gridHeight),
    baseTerrainMap: source.baseTerrainMap ? downsampleGrid(source.baseTerrainMap, sw, sh, gridWidth, gridHeight) : undefined,
    agricultureMap: source.agricultureMap ? downsampleGrid(source.agricultureMap, sw, sh, gridWidth, gridHeight) : undefined,
    terrainMap: downsampleGrid(source.terrainMap, sw, sh, gridWidth, gridHeight),
    snowCoverMap: downsampleGrid(source.snowCoverMap, sw, sh, gridWidth, gridHeight),
    snowBaseTerrainMap: downsampleGrid(source.snowBaseTerrainMap, sw, sh, gridWidth, gridHeight),
    temperatureMap: downsampleGrid(source.temperatureMap, sw, sh, gridWidth, gridHeight),
    precipitationMap: downsampleGrid(source.precipitationMap, sw, sh, gridWidth, gridHeight),
    moistureMap: downsampleGrid(source.moistureMap, sw, sh, gridWidth, gridHeight),
    relativeHumidityMap: downsampleGrid(source.relativeHumidityMap, sw, sh, gridWidth, gridHeight),
    solarHoursMap: downsampleGrid(source.solarHoursMap, sw, sh, gridWidth, gridHeight),
    solarIrradianceMap: downsampleGrid(source.solarIrradianceMap, sw, sh, gridWidth, gridHeight),
    runoffMap: downsampleGrid(source.runoffMap, sw, sh, gridWidth, gridHeight),
    flowAccumulationMap: downsampleGrid(source.flowAccumulationMap, sw, sh, gridWidth, gridHeight),
    basinMap: downsampleGrid(source.basinMap, sw, sh, gridWidth, gridHeight),
    riverOrderMap: downsampleGrid(source.riverOrderMap, sw, sh, gridWidth, gridHeight),
    riverMagnitudeMap: downsampleGrid(source.riverMagnitudeMap, sw, sh, gridWidth, gridHeight),
    windXMap: downsampleGrid(source.windXMap, sw, sh, gridWidth, gridHeight),
    windYMap: downsampleGrid(source.windYMap, sw, sh, gridWidth, gridHeight),
  };
}
function gridCoordinates(data: GeneratedMapData, point: Point): { x: number; y: number } {
  const cell = createGridTransform(data.worldWidth, data.worldHeight, data.gridWidth, data.gridHeight).worldToCell(point);
  return { x: cell.x, y: cell.y };
}

function gridIndex(data: GeneratedMapData, point: Point): number {
  const { x, y } = gridCoordinates(data, point);
  return y * data.gridWidth + x;
}

export function terrainAtPoint(data: GeneratedMapData, point: Point): TerrainType {
  return effectiveTerrainAt(data, gridIndex(data, point));
}

function cellIsLand(data: GeneratedMapData, index: number): boolean {
  return (data.waterTypeMap?.[index] ?? (data.elevationMap[index] > data.seaLevel ? "land" : "saltwater")) === "land";
}

export function isLandAtPoint(data: GeneratedMapData, point: Point): boolean {
  return cellIsLand(data, gridIndex(data, point));
}

function isCoastalCell(data: GeneratedMapData, x: number, y: number): boolean {
  const index = y * data.gridWidth + x;
  if (!cellIsLand(data, index)) return false;
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    const nx = x + dx; const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= data.gridWidth || ny >= data.gridHeight) return true;
    if (!cellIsLand(data, ny * data.gridWidth + nx)) return true;
  }
  return false;
}

function pointFromCell(data: GeneratedMapData, x: number, y: number): Point {
  return createGridTransform(data.worldWidth, data.worldHeight, data.gridWidth, data.gridHeight).cellCenterToWorld(x, y);
}

export function nearestGeneratedPoint(
  data: GeneratedMapData,
  origin: Point,
  predicate: (terrain: TerrainType, elevation: number, x: number, y: number) => boolean,
): Point {
  const originCell = gridCoordinates(data, origin);
  const maxRadius = Math.max(data.gridWidth, data.gridHeight);
  for (let radius = 0; radius <= maxRadius; radius += 1) {
    let best: { x: number; y: number; distance: number } | undefined;
    const consider = (x: number, y: number) => {
      if (x < 0 || y < 0 || x >= data.gridWidth || y >= data.gridHeight) return;
      const index = y * data.gridWidth + x;
      if (!predicate(data.terrainMap[index], data.elevationMap[index], x, y)) return;
      const distance = Math.hypot(x - originCell.x, y - originCell.y);
      if (!best || distance < best.distance) best = { x, y, distance };
    };
    if (radius === 0) consider(originCell.x, originCell.y);
    else {
      for (let dx = -radius; dx <= radius; dx += 1) {
        consider(originCell.x + dx, originCell.y - radius);
        consider(originCell.x + dx, originCell.y + radius);
      }
      for (let dy = -radius + 1; dy < radius; dy += 1) {
        consider(originCell.x - radius, originCell.y + dy);
        consider(originCell.x + radius, originCell.y + dy);
      }
    }
    if (best) return pointFromCell(data, best.x, best.y);
  }
  return origin;
}

function suitablePlacePredicate(place: PlaceName, data: GeneratedMapData) {
  const name = place.name;
  if (/산맥|산|봉|고원/.test(name)) return (terrain: TerrainType, elevation: number) => elevation > 700 && ["mountain", "rock", "snow"].includes(terrain);
  if (/평원|초원|들/.test(name)) return (terrain: TerrainType, elevation: number) => elevation > data.seaLevel && ["plain", "grassland"].includes(terrain);
  if (/숲|삼림/.test(name)) return (terrain: TerrainType) => terrain === "forest" || terrain === "jungle";
  if (/사막|황무지/.test(name)) return (terrain: TerrainType) => terrain === "desert" || terrain === "rock";
  if (/바다|해|만|해협/.test(name) || place.type === "water_body") return (_terrain: TerrainType, elevation: number) => elevation <= data.seaLevel;
  return (_terrain: TerrainType, _elevation: number, x: number, y: number) => cellIsLand(data, y * data.gridWidth + x);
}

function suitableLocationPredicate(state: LocationState, data: GeneratedMapData) {
  // 장소는 해수면보다 높은 담수호 바닥도 피하고 waterTypeMap상 육지 셀에만 놓인다. 항구도 해안의 육지 셀을 사용한다.
  if (/항구|항$|항만|포구/.test(state.name)) return (_terrain: TerrainType, _elevation: number, x: number, y: number) => cellIsLand(data, y * data.gridWidth + x) && isCoastalCell(data, x, y);
  return (_terrain: TerrainType, _elevation: number, x: number, y: number) => cellIsLand(data, y * data.gridWidth + x);
}

class MinHeap {
  private items: Array<{ index: number; priority: number }> = [];
  push(item: { index: number; priority: number }) { this.items.push(item); let i = this.items.length - 1; while (i > 0) { const p = Math.floor((i - 1) / 2); if (this.items[p].priority <= item.priority) break; this.items[i] = this.items[p]; i = p; } this.items[i] = item; }
  pop(): { index: number; priority: number } | undefined { if (this.items.length === 0) return undefined; const root = this.items[0]; const last = this.items.pop()!; if (this.items.length > 0) { let i = 0; while (true) { const l = i * 2 + 1; const r = l + 1; if (l >= this.items.length) break; const c = r < this.items.length && this.items[r].priority < this.items[l].priority ? r : l; if (this.items[c].priority >= last.priority) break; this.items[i] = this.items[c]; i = c; } this.items[i] = last; } return root; }
  get length() { return this.items.length; }
}


function roadMagnetMultiplier(mask: Uint8Array | undefined, width: number, height: number, x: number, y: number, dx: number, dy: number): number {
  if (!mask) return 1;
  const moveLength = Math.max(1e-6, Math.hypot(dx, dy));
  let best = 1;
  for (let oy = -3; oy <= 3; oy += 1) for (let ox = -3; ox <= 3; ox += 1) {
    const nx = x + ox; const ny = y + oy;
    if (nx < 0 || ny < 0 || nx >= width || ny >= height || !mask[ny * width + nx]) continue;
    const distance = Math.hypot(ox, oy);
    if (distance > 3.2) continue;
    // 주변 도로 셀의 주성분 방향을 구해 평행하게 접근하는 경로에만 자석 효과를 준다.
    let xx = 0; let xy = 0; let yy = 0; let samples = 0;
    for (let ty = -2; ty <= 2; ty += 1) for (let tx = -2; tx <= 2; tx += 1) {
      if (tx === 0 && ty === 0) continue;
      const px = nx + tx; const py = ny + ty;
      if (px < 0 || py < 0 || px >= width || py >= height || !mask[py * width + px]) continue;
      const weight = 1 / Math.max(1, Math.hypot(tx, ty));
      xx += tx * tx * weight; xy += tx * ty * weight; yy += ty * ty * weight; samples += 1;
    }
    let alignment = 0;
    if (samples >= 1) {
      const angle = 0.5 * Math.atan2(2 * xy, xx - yy);
      const tangentX = Math.cos(angle); const tangentY = Math.sin(angle);
      alignment = Math.abs((dx * tangentX + dy * tangentY) / moveLength);
    }
    if (alignment < Math.cos(Math.PI / 6)) continue;
    const proximity = Math.max(0, 1 - distance / 3.2);
    best = Math.min(best, 1 - proximity * (0.34 + alignment * 0.28));
  }
  return Math.max(0.36, best);
}

function routeLandCells(data: GeneratedMapData, startPoint: Point, endPoint: Point, existingRoadMask?: Uint8Array, allowFallback = true): Point[] {
  const startSnapped = nearestGeneratedPoint(data, startPoint, (_terrain, _elevation, x, y) => cellIsLand(data, y * data.gridWidth + x));
  const endSnapped = nearestGeneratedPoint(data, endPoint, (_terrain, _elevation, x, y) => cellIsLand(data, y * data.gridWidth + x));
  const start = gridCoordinates(data, startSnapped); const goal = gridCoordinates(data, endSnapped);
  const total = data.gridWidth * data.gridHeight;
  const g = new Float64Array(total); g.fill(Number.POSITIVE_INFINITY);
  const previous = new Int32Array(total); previous.fill(-1);
  const closed = new Uint8Array(total);
  const startIndex = start.y * data.gridWidth + start.x; const goalIndex = goal.y * data.gridWidth + goal.x;
  const heap = new MinHeap(); g[startIndex] = 0; heap.push({ index: startIndex, priority: 0 });
  const directions = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1],[2,1],[2,-1],[-2,1],[-2,-1],[1,2],[-1,2],[1,-2],[-1,-2]] as const;
  const elevationRange = Math.max(300, data.settings.maxElevation - data.seaLevel);
  while (heap.length) {
    const current = heap.pop()!; if (closed[current.index]) continue; closed[current.index] = 1; if (current.index === goalIndex) break;
    const cx = current.index % data.gridWidth; const cy = Math.floor(current.index / data.gridWidth); const currentElevation = data.elevationMap[current.index];
    for (const [dx, dy] of directions) {
      const nx = cx + dx; const ny = cy + dy; if (nx < 0 || ny < 0 || nx >= data.gridWidth || ny >= data.gridHeight) continue;
      const next = ny * data.gridWidth + nx; const elevation = data.elevationMap[next]; if (!cellIsLand(data, next)) continue;
      const leapSteps = Math.max(Math.abs(dx), Math.abs(dy));
      let leapBlocked = false;
      for (let leap = 1; leap < leapSteps; leap += 1) {
        const ix = Math.round(cx + dx * leap / leapSteps); const iy = Math.round(cy + dy * leap / leapSteps);
        if (!cellIsLand(data, iy * data.gridWidth + ix)) { leapBlocked = true; break; }
      }
      if (leapBlocked) continue;
      const baseDistance = Math.hypot(dx, dy);
      const delta = elevation - currentElevation;
      const slopeNorm = Math.abs(delta) / Math.max(35, elevationRange * 0.018);
      const uphillNorm = Math.max(0, delta) / Math.max(30, elevationRange * 0.015);
      const downhillNorm = Math.max(0, -delta) / Math.max(45, elevationRange * 0.025);
      const normalizedElevation = Math.max(0, elevation - data.seaLevel) / elevationRange;
      let terrainPenalty = 0;
      const terrain = data.terrainMap[next];
      if (["mountain", "snow", "rock"].includes(terrain)) terrainPenalty += 5.5;
      if (terrain === "wetland") terrainPenalty += 3.4;
      if (["desert", "jungle", "forest"].includes(terrain)) terrainPenalty += 1.2;
      const riverOrder = data.riverOrderMap?.[next] ?? 0;
      const crossingPenalty = riverOrder > 0 && (data.riverOrderMap?.[current.index] ?? 0) === 0 ? 2.5 + riverOrder * 2.1 : 0;
      let summitPenalty = 0;
      if (normalizedElevation > 0.48) {
        let neighborMean = 0; let count = 0;
        for (const [sx, sy] of [[1,0],[-1,0],[0,1],[0,-1]] as const) { const px = nx + sx; const py = ny + sy; if (px < 0 || py < 0 || px >= data.gridWidth || py >= data.gridHeight) continue; neighborMean += data.elevationMap[py * data.gridWidth + px]; count += 1; }
        neighborMean /= Math.max(1, count);
        summitPenalty = Math.max(0, elevation - neighborMean) / Math.max(20, elevationRange * 0.01) * 5 + Math.pow(normalizedElevation, 2.2) * 8;
      }
      let step = baseDistance + slopeNorm * 5.5 + Math.pow(uphillNorm, 2) * 12 + Math.pow(downhillNorm, 2) * 2.2 + terrainPenalty + crossingPenalty + summitPenalty;
      if (existingRoadMask?.[next]) step *= 0.34;
      else step *= roadMagnetMultiplier(existingRoadMask, data.gridWidth, data.gridHeight, nx, ny, dx, dy);
      if (slopeNorm > 7 || normalizedElevation > 0.92) step += 80;
      const candidate = g[current.index] + step;
      if (candidate >= g[next]) continue;
      g[next] = candidate; previous[next] = current.index;
      const heuristic = Math.hypot(goal.x - nx, goal.y - ny);
      heap.push({ index: next, priority: candidate + heuristic });
    }
  }
  if (previous[goalIndex] < 0 && goalIndex !== startIndex) return allowFallback ? [startSnapped, endSnapped] : [];
  const cells: number[] = []; let cursor = goalIndex; cells.push(cursor); while (cursor !== startIndex && previous[cursor] >= 0) { cursor = previous[cursor]; cells.push(cursor); } cells.reverse();
  const sampleEvery = Math.max(1, Math.floor(cells.length / 240));
  return cells.filter((_item, index) => index === 0 || index === cells.length - 1 || index % sampleEvery === 0).map((index) => pointFromCell(data, index % data.gridWidth, Math.floor(index / data.gridWidth)));
}

export function routePathOnLand(data: GeneratedMapData, nodes: Point[]): Point[] {
  if (nodes.length < 2) return nodes.map((node) => nearestGeneratedPoint(data, node, (_terrain, _elevation, x, y) => cellIsLand(data, y * data.gridWidth + x)));
  const routed: Point[] = [];
  for (let index = 0; index < nodes.length - 1; index += 1) {
    const segment = routeLandCells(data, nodes[index], nodes[index + 1]);
    if (index > 0) segment.shift();
    routed.push(...segment);
  }
  const cleaned = removeRoadBacktracking(routed);
  return curveRoadNodes(data, cleaned);
}

function territoryPolygonOnNaturalBoundaries(map: MapData, data: GeneratedMapData, polygon: Point[], factionId: string | null): Point[] {
  if (polygon.length < 3) return polygon;
  const faction = map.factions.find((item) => item.id === factionId);
  const traced = polygon.map((point) => nearestGeneratedPoint(data, point, (_terrain, _elevation, x, y) => cellIsLand(data, y * data.gridWidth + x)));
  const naturalPoints: Array<{ point: Point; kind: "coastline" | "river" | "mountain" }> = [
    ...data.coastline.flatMap((line) => [
      { point: line.start, kind: "coastline" as const },
      { point: line.end, kind: "coastline" as const },
    ]),
    ...sampledRiverBoundaryPoints(data).map((point) => ({ point, kind: "river" as const })),
  ];
  for (let y = 0; y < data.gridHeight; y += 3) for (let x = 0; x < data.gridWidth; x += 3) {
    const index = y * data.gridWidth + x;
    if (["mountain", "rock", "snow"].includes(data.terrainMap[index])) {
      naturalPoints.push({ point: pointFromCell(data, x, y), kind: "mountain" });
    }
  }
  const threshold = Math.max(map.width, map.height) * 0.028;
  const snapped = traced.map((point) => {
    let nearest: { point: Point; kind: "coastline" | "river" | "mountain" } | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const candidate of naturalPoints) {
      const distance = Math.hypot(candidate.point.x - point.x, candidate.point.y - point.y);
      if (distance > threshold) continue;
      let score = distance;
      if (faction?.maritime) {
        score *= candidate.kind === "coastline" ? 0.68 : candidate.kind === "river" ? 1.02 : 1.22;
      } else if (faction?.activityRange === "land_only" || faction?.activityRange === "land_centered") {
        score *= candidate.kind === "mountain" ? 0.78 : candidate.kind === "river" ? 0.9 : 1.18;
      } else {
        score *= candidate.kind === "river" ? 0.88 : candidate.kind === "mountain" ? 0.94 : 1.04;
      }
      if (score < bestScore) { bestScore = score; nearest = candidate; }
    }
    return nearest?.point ?? point;
  });
  return snapped.map((point) => nearestGeneratedPoint(data, point, (_terrain, _elevation, x, y) => cellIsLand(data, y * data.gridWidth + x)));
}

function territoryArea(points: Point[]): number {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index]; const b = points[(index + 1) % points.length];
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area) / 2;
}

function normalizeTerritoryRing(points: Point[]): Point[] {
  const result: Point[] = [];
  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    const previous = result[result.length - 1];
    if (!previous || Math.hypot(point.x - previous.x, point.y - previous.y) > 1e-7) result.push({ ...point });
  }
  if (result.length > 1 && Math.hypot(result[0].x - result[result.length - 1].x, result[0].y - result[result.length - 1].y) <= 1e-7) result.pop();
  return territoryArea(result) > 1e-8 ? result : [];
}

/** Keeps territory topology as native vectors; validation never rasterizes or retraces it. */
export function enforceTerritoryConstraints(map: MapData, generatedInput: GeneratedMapData): MapData {
  const geometryFingerprint = surfaceGeometryFingerprint(generatedInput);
  const territories = map.territories.map((territory) => ({
    ...territory,
    states: territory.states.map((state) => {
      const polygon = normalizeTerritoryRing(state.value.polygon);
      const holes = (state.value.holes ?? [])
        .map(normalizeTerritoryRing)
        .filter((hole) => hole.length >= 3 && polygon.length >= 3 && pointInPolygon(hole[0], polygon));
      if (polygon.length < 3) return state;
      if (state.value.geometryVersion === CURRENT_SURFACE_VECTOR_VERSION && state.value.geometryFingerprint === geometryFingerprint && state.value.parts?.length) {
        const parts = state.value.parts.map((part) => ({
          polygon: normalizeTerritoryRing(part.polygon),
          holes: (part.holes ?? []).map(normalizeTerritoryRing).filter((hole) => hole.length >= 3),
        })).filter((part) => part.polygon.length >= 3);
        const primary = parts[0];
        return primary ? { ...state, value: { ...state.value, polygon: primary.polygon, holes: primary.holes, parts } } : state;
      }
      const sourceParts = state.value.parts?.length
        ? state.value.parts.map((part) => ({ polygon: normalizeTerritoryRing(part.polygon), holes: part.holes ?? [] }))
        : [{ polygon, holes }];
      const parts = sourceParts.flatMap((part) =>
        part.polygon.length >= 3
          ? clipTerritoryPartsToLand(generatedInput, part.polygon, part.holes)
          : [],
      ).sort((a, b) => territoryArea(b.polygon) - territoryArea(a.polygon));
      const primary = parts[0];
      return primary ? {
        ...state,
        value: {
          ...state.value,
          polygon: primary.polygon,
          holes: primary.holes,
          parts,
          geometryVersion: CURRENT_SURFACE_VECTOR_VERSION,
          geometryFingerprint,
        },
      } : { ...state, value: { ...state.value, polygon: [], holes: [], parts: [], geometryVersion: CURRENT_SURFACE_VECTOR_VERSION, geometryFingerprint } };
    }),
  })).filter((territory) =>
    !territory.id.startsWith("generated-territory-")
    || territory.states.some((state) => state.value.polygon.length >= 3 || (state.value.parts?.length ?? 0) > 0),
  );
  return {
    ...map,
    territories,
  };
}

/** 장소를 육지로 옮기고 영토 벡터를 정규화한다. 불러오기 직후에도 사용할 수 있다. */
export function enforceMapPlacementConstraints(map: MapData, generated: GeneratedMapData): MapData {
  const locations = map.locations.map((location) => ({
    ...location,
    states: location.states.map((record) => ({
      ...record,
      value: { ...record.value, position: nearestGeneratedPoint(generated, record.value.position, suitableLocationPredicate(record.value, generated)) },
    })),
  }));
  return enforceTerritoryConstraints({ ...map, locations }, generated);
}

/** 최초 절차형 지형이 만들어질 때 지명·장소·길·강·영토를 실제 지형에 맞게 재배치한다. */
export function alignMapFeaturesToGenerated(map: MapData, generated: GeneratedMapData): MapData {
  const year = map.timeline.currentYear;
  const placeNames = map.placeNames.map((place) => ({ ...place, position: nearestGeneratedPoint(generated, place.position, suitablePlacePredicate(place, generated)) }));
  let locations = map.locations.map((location) => ({
    ...location,
    states: location.states.map((record) => ({
      ...record,
      value: { ...record.value, position: nearestGeneratedPoint(generated, record.value.position, suitableLocationPredicate(record.value, generated)) },
    })),
  }));
  // 서로 다른 도시가 동일한 육지 셀로 스냅되는 경우, 뒤쪽 도시를 가장 가까운 비점유 셀로 재배치한다.
  // 해안 도시의 광역 기피 반경은 생성 단계에서 처리하고, 이 단계는 정확한 중복과 초근접 충돌만 제거한다.
  const occupiedSettlementPoints: Point[] = [];
  const minimumSettlementGap = Math.max(generated.worldWidth / generated.gridWidth, generated.worldHeight / generated.gridHeight) * 2.5;
  locations = locations.map((location) => {
    const current = getStateAtYear(location.states, year);
    if (!current || current.status !== "active" || !["capital", "city", "town"].includes(current.locationType)) return location;
    let position = current.position;
    if (occupiedSettlementPoints.some((point) => Math.hypot(point.x - position.x, point.y - position.y) < minimumSettlementGap)) {
      const terrainPredicate = suitableLocationPredicate(current, generated);
      position = nearestGeneratedPoint(generated, position, (terrain, elevation, x, y) => {
        if (!terrainPredicate(terrain, elevation, x, y)) return false;
        const candidate = pointFromCell(generated, x, y);
        return occupiedSettlementPoints.every((point) => Math.hypot(point.x - candidate.x, point.y - candidate.y) >= minimumSettlementGap);
      });
    }
    occupiedSettlementPoints.push(position);
    return {
      ...location,
      states: location.states.map((record) => isYearInRange(record, year)
        ? { ...record, value: { ...record.value, position: { ...position } } }
        : record),
    };
  });
  const roads = map.roads.map((road) => ({ ...road, nodes: routePathOnLand(generated, road.nodes) }));
  for (const location of locations) {
    const state = getStateAtYear(location.states, year);
    if (!state || !/관문|관$/.test(state.name) || roads.length === 0) continue;
    const candidates = roads.flatMap((road) => road.nodes);
    const nearest = [...candidates].sort((a, b) => Math.hypot(a.x - state.position.x, a.y - state.position.y) - Math.hypot(b.x - state.position.x, b.y - state.position.y))[0];
    if (nearest) for (const record of location.states) if (record.value.name === state.name) record.value.position = { ...nearest };
  }
  const mapWithPaths = { ...map, placeNames, locations, roads, rivers: [] };
  const territories = map.territories.map((territory) => territory.id.startsWith(GENERATED_TERRITORY_PREFIX) ? territory : ({
    ...territory,
    states: territory.states.map((state) => isYearInRange(state, year) ? ({ ...state, value: { ...state.value, polygon: territoryPolygonOnNaturalBoundaries(mapWithPaths, generated, state.value.polygon, state.value.ownerFactionId), parts: undefined, geometryVersion: undefined, geometryFingerprint: undefined } }) : state),
  }));
  return enforceTerritoryConstraints({ ...mapWithPaths, territories }, generated);
}

const GENERATED_COUNTRY_PREFIX = "generated-country-";
const GENERATED_TERRITORY_PREFIX = "generated-territory-";
const GENERATED_SETTLEMENT_PREFIX = "generated-settlement-";
const GENERATED_ROAD_PREFIX = "generated-road-";
const COUNTRY_COLORS = ["#d65a5a", "#4f7bd9", "#4fa36f", "#d49a3a", "#8a63c7", "#3f9da8", "#b65d91", "#8d7a55", "#6f8f3c", "#b36b3f"];
const GENERATED_COUNTRY_NAMES = ["아르덴 왕국", "네레이드 연방", "벨로란 공국", "세르카 초원국", "루메아 상업동맹", "카르몬 산악국", "에브린 공화국", "탈베르 술탄국", "오르세아 왕령", "미르켄 연합", "다르바니아", "솔라엔 제국"];
const EIGHT_DIRECTIONS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const;

type RegionWave = { index: number; owner: number; priority: number; waterSteps: number };

class RegionHeap {
  private items: RegionWave[] = [];

  push(item: RegionWave): void {
    this.items.push(item);
    let index = this.items.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.items[parent].priority <= item.priority) break;
      this.items[index] = this.items[parent];
      index = parent;
    }
    this.items[index] = item;
  }

  pop(): RegionWave | undefined {
    if (this.items.length === 0) return undefined;
    const root = this.items[0];
    const last = this.items.pop()!;
    if (this.items.length > 0) {
      let index = 0;
      while (true) {
        const left = index * 2 + 1;
        const right = left + 1;
        if (left >= this.items.length) break;
        const child = right < this.items.length && this.items[right].priority < this.items[left].priority ? right : left;
        if (this.items[child].priority >= last.priority) break;
        this.items[index] = this.items[child];
        index = child;
      }
      this.items[index] = last;
    }
    return root;
  }

  get length(): number { return this.items.length; }
}

function maximumWaterCrossingCells(data: GeneratedMapData, archetype: CountryArchetype): number {
  const base = Math.max(2, Math.round(Math.min(data.gridWidth, data.gridHeight) * 0.055));
  return archetype === "maritime" ? Math.round(base * 1.65) : archetype === "commercial" ? Math.round(base * 1.2) : base;
}

function makeCountryArchetypes(count: number, data: GeneratedMapData): CountryArchetype[] {
  const counts = countryTypeCounts(data.settings);
  return [
    ...Array<CountryArchetype>(counts.agricultural).fill("agrarian"),
    ...Array<CountryArchetype>(counts.coastal).fill("maritime"),
    ...Array<CountryArchetype>(counts.nomadic).fill("nomadic"),
    ...Array<CountryArchetype>(counts.mountain).fill("mountain"),
    ...Array<CountryArchetype>(counts.commercial).fill("commercial"),
  ].slice(0, count);
}

function dilateCorridorMask(mask: Uint8Array, width: number, height: number, radius = 2): Uint8Array {
  const output = new Uint8Array(mask);
  for (let index = 0; index < mask.length; index += 1) {
    if (!mask[index]) continue;
    const x = index % width;
    const y = Math.floor(index / width);
    for (let oy = -radius; oy <= radius; oy += 1) for (let ox = -radius; ox <= radius; ox += 1) {
      if (Math.abs(ox) + Math.abs(oy) > radius) continue;
      const nx = x + ox; const ny = y + oy;
      if (nx >= 0 && ny >= 0 && nx < width && ny < height) output[ny * width + nx] = 1;
    }
  }
  return output;
}

function transportCorridorMask(data: GeneratedMapData, map: MapData, citySeeds: number[][] = []): Uint8Array {
  const mask = new Uint8Array(data.gridWidth * data.gridHeight);
  for (const road of map.roads) markRoadMask(data, mask, road.nodes);
  const drawCells = (from: number, to: number) => {
    const ax = from % data.gridWidth; const ay = Math.floor(from / data.gridWidth);
    const bx = to % data.gridWidth; const by = Math.floor(to / data.gridWidth);
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) * 2));
    for (let step = 0; step <= steps; step += 1) {
      const t = step / steps;
      const x = Math.max(0, Math.min(data.gridWidth - 1, Math.round(ax + (bx - ax) * t)));
      const y = Math.max(0, Math.min(data.gridHeight - 1, Math.round(ay + (by - ay) * t)));
      if (cellIsLand(data, y * data.gridWidth + x)) mask[y * data.gridWidth + x] = 1;
    }
  };
  for (const seeds of citySeeds) for (let index = 1; index < seeds.length; index += 1) drawCells(seeds[0], seeds[index]);
  const capitals = citySeeds.map((seeds) => seeds[0]).filter((seed): seed is number => Number.isInteger(seed));
  for (let index = 0; index < capitals.length; index += 1) {
    const from = capitals[index];
    const nearest = capitals
      .filter((candidate) => candidate !== from)
      .sort((a, b) => {
        const ax = a % data.gridWidth; const ay = Math.floor(a / data.gridWidth);
        const bx = b % data.gridWidth; const by = Math.floor(b / data.gridWidth);
        const fx = from % data.gridWidth; const fy = Math.floor(from / data.gridWidth);
        return Math.hypot(ax - fx, ay - fy) - Math.hypot(bx - fx, by - fy);
      })[0];
    if (nearest !== undefined) drawCells(from, nearest);
  }
  return dilateCorridorMask(mask, data.gridWidth, data.gridHeight, 2);
}

type SettlementAttraction = "farmland" | "transport" | "lakeside" | "riverside" | "coastal";
type SettlementCandidate = { index: number; baseScore: number; attractions: SettlementAttraction[] };

function coastalExclusionRadiusKm(data: GeneratedMapData, index: number, importance: number): number {
  const terrain = data.terrainMap[index];
  const x = index % data.gridWidth;
  const y = Math.floor(index / data.gridWidth);
  const jitter = Math.abs(((x * 92837111) ^ (y * 689287499) ^ data.settings.seed) % 1000) / 1000;
  const islandAdjustment = data.settings.localRegionType === "island" || data.settings.localRegionType === "archipelago" ? 0.72 : 1;
  const terrainAdjustment = terrain === "mountain" || terrain === "rock" ? 0.78 : terrain === "farmland" || terrain === "plain" ? 1.08 : 1;
  return Math.max(28, Math.min(240, (48 + importance * 92 + jitter * 58) * islandAdjustment * terrainAdjustment));
}

function coastalCandidateAllowed(
  data: GeneratedMapData,
  candidateIndex: number,
  candidateRadiusKm: number,
  existingRadii: Map<number, number>,
): boolean {
  const candidate = pointFromCell(data, candidateIndex % data.gridWidth, Math.floor(candidateIndex / data.gridWidth));
  const kmPerWorldX = data.settings.mapScaleKm / Math.max(1e-9, data.worldWidth);
  const physicalHeightKm = data.settings.mapScaleKm * data.worldHeight / Math.max(1e-9, data.worldWidth);
  const kmPerWorldY = physicalHeightKm / Math.max(1e-9, data.worldHeight);
  for (const [otherIndex, otherRadiusKm] of existingRadii) {
    const other = pointFromCell(data, otherIndex % data.gridWidth, Math.floor(otherIndex / data.gridWidth));
    const distanceKm = Math.hypot((candidate.x - other.x) * kmPerWorldX, (candidate.y - other.y) * kmPerWorldY);
    const exclusion = Math.max(candidateRadiusKm, otherRadiusKm);
    if (distanceKm < exclusion * 0.55) return false;
    if (distanceKm < exclusion) {
      const survival = (distanceKm / exclusion - 0.55) / 0.45;
      const deterministic = Math.abs(((candidateIndex * 1103515245) ^ (otherIndex * 12345) ^ data.settings.seed) >>> 0) / 0xffffffff;
      if (deterministic > survival * survival) return false;
    }
  }
  return true;
}

function nearWaterType(data: GeneratedMapData, x: number, y: number, wanted: "freshwater" | "saltwater", radius = 2): boolean {
  for (let oy = -radius; oy <= radius; oy += 1) for (let ox = -radius; ox <= radius; ox += 1) {
    const nx=x+ox, ny=y+oy; if(nx<0||ny<0||nx>=data.gridWidth||ny>=data.gridHeight)continue;
    const index=ny*data.gridWidth+nx;
    const type=data.waterTypeMap?.[index] ?? (data.elevationMap[index] <= data.seaLevel ? "saltwater" : "land");
    if(type===wanted)return true;
  }
  return false;
}

function settlementCandidates(data: GeneratedMapData, riverMask: Uint8Array): SettlementCandidate[] {
  const candidates: SettlementCandidate[] = [];
  const centerX=(data.gridWidth-1)/2, centerY=(data.gridHeight-1)/2;
  const centerRadius=Math.max(1,Math.hypot(centerX,centerY));
  for (let y = 1; y < data.gridHeight - 1; y += 1) {
    for (let x = 1; x < data.gridWidth - 1; x += 1) {
      const index = y * data.gridWidth + x;
      const elevation = data.elevationMap[index];
      if (!cellIsLand(data,index) || elevation <= data.seaLevel) continue;
      const terrain = data.terrainMap[index];
      if (["snow","bedrock"].includes(terrain)) continue;
      const temperature = data.temperatureMap[index] ?? 12;
      const precipitation = data.precipitationMap[index] ?? 700;
      const left = data.elevationMap[index - 1], right = data.elevationMap[index + 1];
      const up = data.elevationMap[index - data.gridWidth], down = data.elevationMap[index + data.gridWidth];
      const slope = (Math.abs(left - right) + Math.abs(up - down)) / Math.max(1, data.settings.maxElevation);
      if(slope>0.22)continue;
      const climate = Math.max(0, 1 - Math.abs(temperature - 15) / 28) + Math.max(0, 1 - Math.abs(precipitation - 850) / 1200);
      const farmland = ["farmland", "plain", "grassland"].includes(terrain);
      const coastal = isCoastalCell(data, x, y) || nearWaterType(data,x,y,"saltwater",2);
      const lakeside = nearWaterType(data,x,y,"freshwater",2);
      let riverside = Boolean(riverMask[index]);
      if (!riverside) for (let oy = -2; oy <= 2 && !riverside; oy += 1) for (let ox = -2; ox <= 2; ox += 1) {
        const nx=x+ox,ny=y+oy;if(nx<0||ny<0||nx>=data.gridWidth||ny>=data.gridHeight)continue;
        if(riverMask[ny*data.gridWidth+nx]){riverside=true;break;}
      }
      const centrality=1-Math.min(1,Math.hypot(x-centerX,y-centerY)/centerRadius);
      const transport = centrality>0.42 || (riverside && (coastal||lakeside||farmland));
      const attractions: SettlementAttraction[]=[];
      if(farmland)attractions.push("farmland"); if(transport)attractions.push("transport"); if(lakeside)attractions.push("lakeside"); if(riverside)attractions.push("riverside"); if(coastal)attractions.push("coastal");
      const normalizedAttraction = attractions.length === 0 ? 0 : Math.min(1.75, 0.95 + (attractions.length - 1) * 0.22);
      const jitter = Math.abs(((x * 73856093) ^ (y * 19349663) ^ data.settings.seed) % 1000) / 10000;
      candidates.push({ index, attractions, baseScore: normalizedAttraction + climate + centrality*0.35 - Math.min(2, slope * 7) + jitter });
    }
  }
  return candidates;
}

function archetypePreference(data: GeneratedMapData, riverMask: Uint8Array, transportMask: Uint8Array, index: number, archetype: CountryArchetype): number {
  const x = index % data.gridWidth;
  const y = Math.floor(index / data.gridWidth);
  const terrain = effectiveTerrainAt(data, index);
  const elevation = data.elevationMap[index];
  const precipitation = data.precipitationMap[index] ?? 700;
  if (archetype === "maritime") return isCoastalCell(data, x, y) ? 3.2 : -0.8;
  if (archetype === "mountain") return (["mountain", "rock", "bedrock", "snow"].includes(terrain) ? 2.5 : -0.35) + (elevation > data.seaLevel + Math.max(900, data.settings.maxElevation * 0.22) ? 1.4 : 0);
  if (archetype === "nomadic") return (!isCoastalCell(data, x, y) && ["grassland", "plain"].includes(terrain) ? 2.7 : -0.5) + (precipitation < 650 ? 0.7 : 0);
  if (archetype === "commercial") {
    const centrality = 1 - Math.min(1, Math.hypot(x - (data.gridWidth - 1) / 2, y - (data.gridHeight - 1) / 2) / Math.max(1, Math.hypot(data.gridWidth, data.gridHeight) / 2));
    return transportMask[index] ? 3.4 : centrality * 1.6 + (riverMask[index] ? 0.8 : 0) - 0.35;
  }
  return (terrain === "farmland" ? 3.1 : ["plain", "grassland"].includes(terrain) ? 1.35 : 0) + (riverMask[index] ? 0.8 : 0);
}

function nearestLandCell(data: GeneratedMapData, point: Point): number {
  const snapped = nearestGeneratedPoint(data, point, (_terrain, _elevation, x, y) => cellIsLand(data, y * data.gridWidth + x));
  return gridIndex(data, snapped);
}

function chooseCapitalSeeds(
  data: GeneratedMapData,
  map: MapData,
  countryIds: string[],
  archetypes: CountryArchetype[],
  candidates: SettlementCandidate[],
  riverMask: Uint8Array,
  transportMask: Uint8Array,
): number[] {
  const capitals = new Array<number>(countryIds.length).fill(-1);
  const locations = visibleLocations(map);
  const occupiedSettlementCells = new Set<number>();
  const existingCoastalRadii = new Map<number, number>();
  for (const { state } of locations) {
    if (!["capital", "city", "town"].includes(state.locationType)) continue;
    const cell = nearestLandCell(data, state.position);
    occupiedSettlementCells.add(cell);
    const x = cell % data.gridWidth;
    const y = Math.floor(cell / data.gridWidth);
    if (isCoastalCell(data, x, y) || nearWaterType(data, x, y, "saltwater", 2)) {
      const importance = state.locationType === "capital" ? 1 : state.locationType === "city" ? 0.7 : 0.48;
      existingCoastalRadii.set(cell, coastalExclusionRadiusKm(data, cell, importance));
    }
  }
  for (let country = 0; country < countryIds.length; country += 1) {
    const existing = locations.find(({ state }) => state.ownerFactionId === countryIds[country] && state.locationType === "capital");
    if (existing) capitals[country] = nearestLandCell(data, existing.state.position);
  }

  const minimumDistance = Math.max(7, Math.sqrt(data.gridWidth * data.gridHeight / Math.max(1, countryIds.length)) * 0.55);
  for (let country = 0; country < countryIds.length; country += 1) {
    if (capitals[country] >= 0) continue;
    const ranked = candidates
      .map((candidate) => ({
        ...candidate,
        score: candidate.baseScore + archetypePreference(data, riverMask, transportMask, candidate.index, archetypes[country] ?? "agrarian"),
      }))
      .sort((a, b) => b.score - a.score);
    const selected = ranked.find((candidate) => {
      const x = candidate.index % data.gridWidth;
      const y = Math.floor(candidate.index / data.gridWidth);
      if (occupiedSettlementCells.has(candidate.index)) return false;
      if ([...occupiedSettlementCells].some((seed) => Math.hypot(x - seed % data.gridWidth, y - Math.floor(seed / data.gridWidth)) < 4)) return false;
      const coastal = candidate.attractions.includes("coastal");
      if (coastal) {
        const radius = coastalExclusionRadiusKm(data, candidate.index, 1);
        if (!coastalCandidateAllowed(data, candidate.index, radius, existingCoastalRadii)) return false;
      }
      return capitals.filter((item) => item >= 0).every((seed) => Math.hypot(x - seed % data.gridWidth, y - Math.floor(seed / data.gridWidth)) >= minimumDistance);
    }) ?? ranked.find((candidate) => !occupiedSettlementCells.has(candidate.index) && !capitals.includes(candidate.index));
    if (selected) capitals[country] = selected.index;
  }
  return capitals.map((seed) => seed >= 0 ? seed : candidates[0]?.index ?? 0);
}

function capitalVoronoi(data: GeneratedMapData, capitals: number[]): Int16Array {
  const owner = new Int16Array(data.gridWidth * data.gridHeight);
  const aspect = data.worldWidth / Math.max(1, data.worldHeight);
  for (let index = 0; index < owner.length; index += 1) {
    const x = index % data.gridWidth;
    const y = Math.floor(index / data.gridWidth);
    let bestOwner = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let country = 0; country < capitals.length; country += 1) {
      const seed = capitals[country];
      const sx = seed % data.gridWidth;
      const sy = Math.floor(seed / data.gridWidth);
      const dx = (x - sx) * aspect;
      const dy = y - sy;
      const distance = dx * dx + dy * dy;
      if (distance < bestDistance) { bestDistance = distance; bestOwner = country; }
    }
    owner[index] = bestOwner;
  }
  return owner;
}

/** @deprecated Kept as an exported compatibility helper for older generator scripts. */
export function chooseMorphologySeeds(
  data: GeneratedMapData,
  map: MapData,
  countryIds: string[],
  archetypes: CountryArchetype[],
  capitals: number[],
  voronoiOwner: Int16Array,
  candidates: SettlementCandidate[],
  riverMask: Uint8Array,
  transportMask: Uint8Array,
): number[][] {
  const visible = visibleLocations(map);
  const localRegional = data.settings.mapScope === "local" || data.settings.mapScope === "regional";
  const targetPerCountry = localRegional ? 4 : 3;
  const globalSelected = new Set<number>();
  const coastalRadii = new Map<number, number>();
  for (const { state } of visible) {
    if (!["capital", "city", "town"].includes(state.locationType)) continue;
    const cell = nearestLandCell(data, state.position);
    globalSelected.add(cell);
    const x = cell % data.gridWidth;
    const y = Math.floor(cell / data.gridWidth);
    if (isCoastalCell(data, x, y) || nearWaterType(data, x, y, "saltwater", 2)) {
      const importance = state.locationType === "capital" ? 1 : state.locationType === "city" ? 0.7 : 0.48;
      coastalRadii.set(cell, coastalExclusionRadiusKm(data, cell, importance));
    }
  }
  capitals.forEach((capital) => {
    globalSelected.add(capital);
    if (isCoastalCell(data, capital % data.gridWidth, Math.floor(capital / data.gridWidth)))
      coastalRadii.set(capital, coastalExclusionRadiusKm(data, capital, 1));
  });
  const globalAttractionCounts: Record<SettlementAttraction, number> = { farmland:0,transport:0,lakeside:0,riverside:0,coastal:0 };
  const perTypeSoftLimit = Math.max(1, Math.ceil(countryIds.length * targetPerCountry * 0.3));
  const result:number[][]=[];
  for(let country=0;country<countryIds.length;country+=1){
    const countryId=countryIds[country];
    const selected:number[]=[capitals[country]];
    const localCounts:Record<SettlementAttraction,number>={farmland:0,transport:0,lakeside:0,riverside:0,coastal:0};
    const existing=visible.filter(({state})=>state.ownerFactionId===countryId&&["capital","city","town"].includes(state.locationType))
      .map(({state})=>nearestLandCell(data,state.position)).filter(index=>voronoiOwner[index]===country&&!selected.includes(index));
    for(const index of existing){if(selected.length>=targetPerCountry)break;selected.push(index);globalSelected.add(index);}
    const regionArea=voronoiOwner.reduce((sum,value,index)=>sum+(value===country&&cellIsLand(data,index)?1:0),0);
    const idealSpacing=Math.max(5,Math.sqrt(Math.max(1,regionArea))*0.25);
    const crossCountrySpacing=Math.max(4,idealSpacing*0.68);
    let relaxation=1;
    while(selected.length<targetPerCountry&&relaxation>=0.42){
      const ranked=candidates.filter(c=>voronoiOwner[c.index]===country&&!globalSelected.has(c.index)).map(candidate=>{
        const x=candidate.index%data.gridWidth,y=Math.floor(candidate.index/data.gridWidth);
        const nearestLocal=Math.min(...selected.map(seed=>Math.hypot(x-seed%data.gridWidth,y-Math.floor(seed/data.gridWidth))));
        let diversity=0;
        for(const attraction of candidate.attractions){
          const localPenalty=Math.max(0,localCounts[attraction]-0)*0.75;
          const globalPenalty=Math.max(0,globalAttractionCounts[attraction]-perTypeSoftLimit)*0.45;
          diversity+=0.72-localPenalty-globalPenalty;
        }
        if(candidate.attractions.length===0)diversity-=0.25;
        const spread=Math.min(2.8,nearestLocal/Math.max(1,idealSpacing));
        return {...candidate,score:candidate.baseScore+archetypePreference(data,riverMask,transportMask,candidate.index,archetypes[country]??"agrarian")+spread+diversity};
      }).sort((a,b)=>b.score-a.score);
      const chosen=ranked.find(candidate=>{
        const x=candidate.index%data.gridWidth,y=Math.floor(candidate.index/data.gridWidth);
        const localOk=selected.every(seed=>Math.hypot(x-seed%data.gridWidth,y-Math.floor(seed/data.gridWidth))>=idealSpacing*relaxation);
        const globalOk=[...globalSelected].every(seed=>selected.includes(seed)||Math.hypot(x-seed%data.gridWidth,y-Math.floor(seed/data.gridWidth))>=crossCountrySpacing*relaxation);
        const coastal = candidate.attractions.includes("coastal");
        const candidateRadius = coastal ? coastalExclusionRadiusKm(data, candidate.index, selected.length === 0 ? 1 : 0.58 + candidate.baseScore * 0.08) : 0;
        const coastalOk = !coastal || coastalCandidateAllowed(data, candidate.index, candidateRadius, coastalRadii);
        return localOk&&globalOk&&coastalOk;
      });
      if(!chosen){relaxation-=0.12;continue;}
      selected.push(chosen.index);globalSelected.add(chosen.index);
      if(chosen.attractions.includes("coastal")) coastalRadii.set(chosen.index, coastalExclusionRadiusKm(data, chosen.index, 0.58 + chosen.baseScore * 0.08));
      for(const attraction of chosen.attractions){localCounts[attraction]+=1;globalAttractionCounts[attraction]+=1;}
    }
    if(selected.length<targetPerCountry){
      for(const candidate of candidates.filter(c=>voronoiOwner[c.index]===country&&!globalSelected.has(c.index)).sort((a,b)=>b.baseScore-a.baseScore)){
        const coastal = candidate.attractions.includes("coastal");
        const radius = coastal ? coastalExclusionRadiusKm(data, candidate.index, 0.55) : 0;
        if(coastal && !coastalCandidateAllowed(data, candidate.index, radius, coastalRadii)) continue;
        selected.push(candidate.index);globalSelected.add(candidate.index);
        if(coastal) coastalRadii.set(candidate.index, radius);
        if(selected.length>=targetPerCountry)break;
      }
    }
    while(selected.length<targetPerCountry)selected.push(capitals[country]);
    result.push(selected.slice(0,targetPerCountry));
  }
  return result;
}

export function settlementExpansionCostMultiplier(
  data: GeneratedMapData,
  index: number,
  settlementSeeds: ArrayLike<number>,
): number {
  if (settlementSeeds.length === 0) return 1;
  const x = index % data.gridWidth;
  const y = Math.floor(index / data.gridWidth);
  const cellWidthKm = Math.max(1e-6, data.settings.mapScaleKm / Math.max(1, data.gridWidth));
  const physicalHeightKm = data.settings.mapScaleKm * data.worldHeight / Math.max(1e-6, data.worldWidth);
  const cellHeightKm = Math.max(1e-6, physicalHeightKm / Math.max(1, data.gridHeight));
  for (let seedIndex = 0; seedIndex < settlementSeeds.length; seedIndex += 1) {
    const seed = settlementSeeds[seedIndex];
    const seedX = seed % data.gridWidth;
    const seedY = Math.floor(seed / data.gridWidth);
    if (Math.hypot((x - seedX) * cellWidthKm, (y - seedY) * cellHeightKm) <= 10) return 0.5;
  }
  return 1;
}

function expansionStepCost(
  data: GeneratedMapData,
  current: number,
  next: number,
  owner: number,
  archetype: CountryArchetype,
  riverMask: Uint8Array,
  transportMask: Uint8Array,
  voronoiOwner: Int16Array,
  diagonal: boolean,
  settlementSeeds: ArrayLike<number>,
): number {
  const settings = data.settings;
  const boundaryWeight = CALIBRATED_NATURAL_BOUNDARY_WEIGHT;
  const currentLand = cellIsLand(data, current);
  const nextLand = cellIsLand(data, next);
  const base = diagonal ? Math.SQRT2 : 1;
  if (!nextLand) {
    const seaTravel = archetype === "maritime" ? 2.2 : archetype === "nomadic" ? 5.2 : 4.3;
    return (base + seaTravel + (currentLand ? 1.2 : 0)) * settlementExpansionCostMultiplier(data, next, settlementSeeds);
  }

  const elevationRange = Math.max(1, settings.maxElevation - data.seaLevel);
  const normalizedElevation = Math.max(0, data.elevationMap[next] - data.seaLevel) / elevationRange;
  const slope = Math.abs(data.elevationMap[next] - data.elevationMap[current]) / Math.max(200, settings.maxElevation);
  let barrier = normalizedElevation * (1.2 + boundaryWeight * 5.5);
  barrier += slope * (3 + boundaryWeight * 11);
  const terrain = effectiveTerrainAt(data, next);
  const nextX = next % data.gridWidth;
  const nextY = Math.floor(next / data.gridWidth);
  const coastal = isCoastalCell(data, nextX, nextY) || nearWaterType(data, nextX, nextY, "saltwater", 2);
  const mountainThreshold = data.seaLevel + Math.max(900, settings.maxElevation * 0.22);
  if (["mountain", "snow", "rock", "bedrock"].includes(terrain)) barrier += (archetype === "mountain" ? 0.2 : 2.7) * boundaryWeight;
  if (["desert", "wetland"].includes(terrain)) barrier += (archetype === "nomadic" ? 0.35 : 1.35) * boundaryWeight;
  if (archetype === "maritime") barrier += coastal ? -1.5 : 0.65;
  if (archetype === "nomadic") barrier += !coastal && ["grassland", "plain"].includes(terrain) ? -1.35 : coastal ? 0.9 : 0;
  if (archetype === "mountain") barrier += data.elevationMap[next] >= mountainThreshold ? -1.45 : 0.45;
  if (archetype === "agrarian") barrier += terrain === "farmland" ? -1.55 : ["plain", "grassland"].includes(terrain) ? -0.45 : 0.2;
  if (archetype === "commercial") barrier += transportMask[next] ? -1.7 : 0.4;
  const riverOrder = data.riverOrderMap?.[next] ?? 0;
  if (riverMask[next] && !riverMask[current]) barrier += (archetype === "agrarian" ? 0.55 : archetype === "commercial" ? 0.8 : 1.25) * (1 + riverOrder * 0.32) * (0.7 + boundaryWeight * 2.5);
  const currentBasin = data.basinMap?.[current] ?? -1;
  const nextBasin = data.basinMap?.[next] ?? -1;
  if (currentBasin >= 0 && nextBasin >= 0 && currentBasin !== nextBasin) barrier += 0.45 * boundaryWeight;
  if (!currentLand) barrier += 1.1;
  if (voronoiOwner[next] !== owner) barrier += 1.3 + boundaryWeight * 3.2;
  return Math.max(0.06, (base + barrier) * settlementExpansionCostMultiplier(data, next, settlementSeeds));
}

type TerritoryGrowthResult = {
  owner: Int16Array;
  cityCost: Float64Array;
};

/**
 * 영토 상승(팽창)은 오직 수도·도시 셀에서 시작한다.
 * 이전처럼 도시 사이의 볼록다각형을 미리 점유하지 않으며, 모든 도달 가능한 셀이
 * 도시 발원 파동에 의해 하나씩 선택될 때까지 계속한다.
 */
function growTerritories(
  data: GeneratedMapData,
  citySeeds: number[][],
  archetypes: CountryArchetype[],
  voronoiOwner: Int16Array,
  riverMask: Uint8Array,
  transportMask: Uint8Array,
): TerritoryGrowthResult {
  const total = data.gridWidth * data.gridHeight;
  const waveOwner = new Int16Array(total); waveOwner.fill(-1);
  const cost = new Float64Array(total); cost.fill(Number.POSITIVE_INFINITY);
  const waterRun = new Uint16Array(total);
  const settled = new Uint8Array(total);
  const heap = new RegionHeap();

  citySeeds.forEach((seeds, owner) => {
    for (const seed of new Set(seeds)) {
      if (seed < 0 || seed >= total || !cellIsLand(data, seed)) continue;
      if (0 < cost[seed] || (cost[seed] === 0 && owner < waveOwner[seed])) {
        waveOwner[seed] = owner;
        cost[seed] = 0;
        heap.push({ index: seed, owner, priority: 0, waterSteps: 0 });
      }
    }
  });

  while (heap.length) {
    const current = heap.pop()!;
    if (
      settled[current.index] ||
      current.owner !== waveOwner[current.index] ||
      current.waterSteps !== waterRun[current.index] ||
      Math.abs(current.priority - cost[current.index]) > 1e-9
    ) continue;
    settled[current.index] = 1;
    const x = current.index % data.gridWidth;
    const y = Math.floor(current.index / data.gridWidth);
    for (const [dx, dy] of EIGHT_DIRECTIONS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= data.gridWidth || ny >= data.gridHeight) continue;
      const next = ny * data.gridWidth + nx;
      if (settled[next] && waveOwner[next] !== current.owner) continue;
      const nextWaterSteps = cellIsLand(data, next) ? 0 : current.waterSteps + 1;
      if (nextWaterSteps > maximumWaterCrossingCells(data, archetypes[current.owner] ?? "agrarian")) continue;
      const candidate = current.priority + expansionStepCost(
        data,
        current.index,
        next,
        current.owner,
        archetypes[current.owner] ?? "agrarian",
        riverMask,
        transportMask,
        voronoiOwner,
        dx !== 0 && dy !== 0,
        citySeeds[current.owner] ?? [],
      );
      if (
        candidate < cost[next] - 1e-9 ||
        (Math.abs(candidate - cost[next]) <= 1e-9 && current.owner < waveOwner[next])
      ) {
        cost[next] = candidate;
        waveOwner[next] = current.owner;
        waterRun[next] = nextWaterSteps;
        heap.push({ index: next, owner: current.owner, priority: candidate, waterSteps: nextWaterSteps });
      }
    }
  }

  const landOwner = new Int16Array(total); landOwner.fill(-1);
  for (let index = 0; index < total; index += 1) {
    if (!cellIsLand(data, index)) continue;
    landOwner[index] = waveOwner[index] >= 0 ? waveOwner[index] : voronoiOwner[index];
    if (!Number.isFinite(cost[index])) cost[index] = Number.MAX_SAFE_INTEGER;
  }
  return { owner: landOwner, cityCost: cost };
}

/**
 * 도시 발원 침식파를 초기 상승 때 기록된 도시 도달 비용 순서로 전 영토에 전달한다.
 * 고정 횟수 후처리가 아니라 마지막 영토 셀까지 실제로 소거한 다음, 빈 지도에서
 * 동일한 도시 종자만으로 다시 경쟁 팽창한다.
 */
function fullyErodeAndRegrowTerritories(
  data: GeneratedMapData,
  initialOwner: Int16Array,
  cityCost: Float64Array,
  citySeeds: number[][],
  archetypes: CountryArchetype[],
  voronoiOwner: Int16Array,
  riverMask: Uint8Array,
  transportMask: Uint8Array,
): Int16Array {
  const total = initialOwner.length;
  const seedSet = new Set(citySeeds.flat());
  const territoryCells: number[] = [];
  for (let index = 0; index < total; index += 1)
    if (cellIsLand(data, index) && initialOwner[index] >= 0) territoryCells.push(index);

  // 침식파는 도시에서 출발한 도달 시간 순으로 진행하고, 동일 시간에는 취약한 경계 셀을 먼저 처리한다.
  territoryCells.sort((a, b) => {
    const costDifference = cityCost[a] - cityCost[b];
    if (Math.abs(costDifference) > 1e-9) return costDifference;
    if (seedSet.has(a) !== seedSet.has(b)) return seedSet.has(a) ? -1 : 1;
    return a - b;
  });

  const fullyEroded = new Int16Array(total); fullyEroded.fill(-1);
  const working = new Int16Array(initialOwner);
  let erodedCount = 0;
  for (const index of territoryCells) {
    if (working[index] < 0) continue;
    working[index] = -1;
    erodedCount += 1;
  }
  // 모든 영토가 실제로 침식됐는지 보장한다. working은 이후 재사용하지 않지만
  // 이 검사는 부분 침식으로 되돌아가는 회귀를 막는다.
  if (erodedCount !== territoryCells.length || territoryCells.some((index) => working[index] >= 0))
    throw new Error("영토 완전 침식 단계가 모든 셀을 처리하지 못했습니다.");

  const regrowCost = new Float64Array(total); regrowCost.fill(Number.POSITIVE_INFINITY);
  const regrowOwner = fullyEroded;
  const settled = new Uint8Array(total);
  const waterRun = new Uint16Array(total);
  const heap = new RegionHeap();
  citySeeds.forEach((seeds, owner) => {
    for (const seed of new Set(seeds)) {
      if (seed < 0 || seed >= total || !cellIsLand(data, seed)) continue;
      if (regrowCost[seed] > 0 || owner < regrowOwner[seed]) {
        regrowCost[seed] = 0;
        regrowOwner[seed] = owner;
        heap.push({ index: seed, owner, priority: 0, waterSteps: 0 });
      }
    }
  });

  while (heap.length) {
    const current = heap.pop()!;
    if (
      settled[current.index] ||
      current.owner !== regrowOwner[current.index] ||
      current.waterSteps !== waterRun[current.index] ||
      Math.abs(current.priority - regrowCost[current.index]) > 1e-9
    ) continue;
    settled[current.index] = 1;
    const x = current.index % data.gridWidth;
    const y = Math.floor(current.index / data.gridWidth);
    for (const [dx, dy] of EIGHT_DIRECTIONS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= data.gridWidth || ny >= data.gridHeight) continue;
      const next = ny * data.gridWidth + nx;
      if (settled[next] && regrowOwner[next] !== current.owner) continue;
      const nextWaterSteps = cellIsLand(data, next) ? 0 : current.waterSteps + 1;
      if (nextWaterSteps > maximumWaterCrossingCells(data, archetypes[current.owner] ?? "agrarian")) continue;

      const formerOwner = initialOwner[next];
      const formerAffinity = formerOwner === current.owner ? -0.18 : formerOwner >= 0 ? 0.28 : 0;
      const originalCost = Number.isFinite(cityCost[next]) ? cityCost[next] : 0;
      const cityDistancePenalty = Math.min(1.2, originalCost / Math.max(12, Math.sqrt(total))) * 0.08;
      const candidate = current.priority + expansionStepCost(
        data,
        current.index,
        next,
        current.owner,
        archetypes[current.owner] ?? "agrarian",
        riverMask,
        transportMask,
        voronoiOwner,
        dx !== 0 && dy !== 0,
        citySeeds[current.owner] ?? [],
      ) + formerAffinity + cityDistancePenalty;
      if (
        candidate < regrowCost[next] - 1e-9 ||
        (Math.abs(candidate - regrowCost[next]) <= 1e-9 && current.owner < regrowOwner[next])
      ) {
        regrowCost[next] = candidate;
        regrowOwner[next] = current.owner;
        waterRun[next] = nextWaterSteps;
        heap.push({ index: next, owner: current.owner, priority: candidate, waterSteps: nextWaterSteps });
      }
    }
  }

  // 도시 파동이 도달하지 못한 육지는 영토로 만들지 않는다. 생성된 모든 영토가
  // 반드시 하나 이상의 도시에서 시작했다는 조건을 유지한다.
  for (let index = 0; index < total; index += 1)
    if (!cellIsLand(data, index)) regrowOwner[index] = -1;
  return regrowOwner;
}

function vectorTerritorySites(data: GeneratedMapData, owner: Int16Array, capitals: number[], count: number) {
  const sumX = new Float64Array(count);
  const sumY = new Float64Array(count);
  const cells = new Uint32Array(count);
  for (let index = 0; index < owner.length; index += 1) {
    const country = owner[index];
    if (country < 0 || country >= count || !cellIsLand(data, index)) continue;
    const point = pointFromCell(data, index % data.gridWidth, Math.floor(index / data.gridWidth));
    sumX[country] += point.x;
    sumY[country] += point.y;
    cells[country] += 1;
  }
  const sites = Array.from({ length: count }, (_, country) => {
    const capitalIndex = capitals[country] ?? 0;
    const capital = pointFromCell(data, capitalIndex % data.gridWidth, Math.floor(capitalIndex / data.gridWidth));
    const centroid = cells[country] > 0
      ? { x: sumX[country] / cells[country], y: sumY[country] / cells[country] }
      : capital;
    return {
      owner: country,
      point: {
        x: capital.x * 0.58 + centroid.x * 0.42,
        y: capital.y * 0.58 + centroid.y * 0.42,
      },
    };
  });
  const minimumGap = Math.max(data.worldWidth / data.gridWidth, data.worldHeight / data.gridHeight) * 0.15;
  sites.forEach((site, index) => {
    for (let previous = 0; previous < index; previous += 1) {
      if (Math.hypot(site.point.x - sites[previous].point.x, site.point.y - sites[previous].point.y) >= minimumGap) continue;
      site.point.x = Math.min(data.worldWidth, Math.max(0, site.point.x + minimumGap * (index + 1)));
      site.point.y = Math.min(data.worldHeight, Math.max(0, site.point.y + minimumGap * ((index % 2) * 2 - 1)));
    }
  });
  return sites;
}

function upsertGeneratedSettlements(
  map: MapData,
  source: GeneratedMapData,
  countries: MapData["factions"],
  plannedSites: PlannedSettlement[],
): { locations: MapData["locations"]; factions: MapData["factions"] } {
  const year = 0;
  const preserved = map.locations.filter((location) => !location.id.startsWith(GENERATED_SETTLEMENT_PREFIX));
  const locations = [...preserved];
  const locationIds = new Map<string, string[]>();
  countries.forEach((country) => locationIds.set(country.id, []));
  const rankOrder = { capital: 0, city: 1, town: 2, village: 3 } as const;
  plannedSites
    .slice()
    .sort((a, b) => rankOrder[a.rank] - rankOrder[b.rank] || b.population - a.population)
    .forEach((site) => {
      const country = countries[site.ownerIndex];
      const ownerKey = country?.id ?? "unowned";
      const ownerSites = locationIds.get(ownerKey) ?? [];
      const ordinal = ownerSites.length + 1;
      const id = `${GENERATED_SETTLEMENT_PREFIX}${ownerKey}-${site.rank}-${ordinal}`;
      locations.push({
        id,
        states: [{
          startYear: year,
          endYear: null,
          value: {
            name: site.name,
            locationType: site.rank,
            position: settlementPoint(source, site),
            status: "active",
            description: "",
          },
        }],
      });
      ownerSites.push(id);
      locationIds.set(ownerKey, ownerSites);
    });

  return { locations, factions: map.factions };
}

function markRoadMask(data: GeneratedMapData, mask: Uint8Array, nodes: Point[]): void {
  for (let index = 0; index < nodes.length - 1; index += 1) {
    const a = gridCoordinates(data, nodes[index]);
    const b = gridCoordinates(data, nodes[index + 1]);
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) * 2));
    for (let step = 0; step <= steps; step += 1) {
      const t = step / steps;
      const x = Math.max(0, Math.min(data.gridWidth - 1, Math.round(a.x + (b.x - a.x) * t)));
      const y = Math.max(0, Math.min(data.gridHeight - 1, Math.round(a.y + (b.y - a.y) * t)));
      mask[y * data.gridWidth + x] = 1;
    }
  }
}

function removeRoadBacktracking(nodes: Point[]): Point[] {
  const key = (point: Point) => `${Math.round(point.x * 1000)}:${Math.round(point.y * 1000)}`;
  const result: Point[] = [];
  const positions = new Map<string, number>();
  for (const point of nodes) {
    const pointKey = key(point);
    const previousIndex = positions.get(pointKey);
    if (previousIndex !== undefined) {
      // A-B-A와 같은 즉시 왕복뿐 아니라 짧은 순환도 통째로 제거한다.
      for (let index = result.length - 1; index > previousIndex; index -= 1) positions.delete(key(result[index]));
      result.length = previousIndex + 1;
      continue;
    }
    positions.set(pointKey, result.length);
    result.push({ ...point });
  }
  return result.length >= 2 ? result : nodes.slice(0, 2).map((point) => ({ ...point }));
}

function simplifyRoadNodes(nodes: Point[]): Point[] {
  if (nodes.length <= 3) return nodes;
  const result: Point[] = [nodes[0]];
  for (let index = 1; index < nodes.length - 1; index += 1) {
    const previous = result[result.length - 1];
    const current = nodes[index];
    const next = nodes[index + 1];
    const ax = current.x - previous.x; const ay = current.y - previous.y;
    const bx = next.x - current.x; const by = next.y - current.y;
    const denominator = Math.max(1e-6, Math.hypot(ax, ay) * Math.hypot(bx, by));
    const bend = Math.abs(ax * by - ay * bx) / denominator;
    if (bend > 0.035 || Math.hypot(current.x - previous.x, current.y - previous.y) > 80) result.push(current);
  }
  result.push(nodes[nodes.length - 1]);
  return result;
}

function pruneSharpRoadReversals(data: GeneratedMapData, nodes: Point[], maximumDegrees = 58): Point[] {
  const result = nodes.map((point) => ({ ...point }));
  const maximum = maximumDegrees * Math.PI / 180;
  const segmentIsLand = (a: Point, b: Point) => {
    const steps = Math.max(2, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / Math.max(1e-6, Math.min(data.worldWidth / data.gridWidth, data.worldHeight / data.gridHeight)) * 2));
    for (let step = 0; step <= steps; step += 1) {
      const t = step / steps;
      if (!isLandAtPoint(data, { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })) return false;
    }
    return true;
  };
  for (let pass = 0; pass < 12; pass += 1) {
    let changed = false;
    for (let index = 1; index < result.length - 1; index += 1) {
      const a = result[index - 1];
      const b = result[index];
      const c = result[index + 1];
      const ux = b.x - a.x; const uy = b.y - a.y;
      const vx = c.x - b.x; const vy = c.y - b.y;
      const denominator = Math.max(1e-9, Math.hypot(ux, uy) * Math.hypot(vx, vy));
      const turn = Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / denominator)));
      if (turn <= maximum || !segmentIsLand(a, c)) continue;
      result.splice(index, 1);
      changed = true;
      index = Math.max(0, index - 2);
    }
    if (!changed) break;
  }
  return result;
}


function curveRoadNodes(data: GeneratedMapData, nodes: Point[]): Point[] {
  if (nodes.length < 3) return nodes;
  const cell = Math.max(data.worldWidth / data.gridWidth, data.worldHeight / data.gridHeight);
  const cleaned = pruneSharpRoadReversals(data, removeRoadBacktracking(nodes));
  const constrained = limitPathCurvature(simplifyRoadNodes(cleaned), 32, 8);
  const curved = limitPathCurvature(smoothPath(constrained, { spacing: cell * 0.65, samplesPerSegment: 6, iterations: 2 }), 26, 4);
  const elevationRange = Math.max(300, data.settings.maxElevation - data.seaLevel);
  for (const point of curved) {
    const index = gridIndex(data, point);
    if (!cellIsLand(data, index)) return limitPathCurvature(pruneSharpRoadReversals(data, simplifyRoadNodes(cleaned)), 32, 10);
    const normalized = Math.max(0, data.elevationMap[index] - data.seaLevel) / elevationRange;
    if (normalized > 0.94) return limitPathCurvature(pruneSharpRoadReversals(data, simplifyRoadNodes(cleaned)), 32, 10);
  }
  return limitPathCurvature(pruneSharpRoadReversals(data, curved), 26, 10);
}

function randomLandPoint(data: GeneratedMapData, random: () => number, candidates: SettlementCandidate[]): Point | null {
  if (candidates.length === 0) return null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const candidate = candidates[Math.floor(random() * candidates.length)];
    if (!candidate) continue;
    const terrain = data.terrainMap[candidate.index];
    if (["mountain", "snow"].includes(terrain) && random() < 0.85) continue;
    return pointFromCell(data, candidate.index % data.gridWidth, Math.floor(candidate.index / data.gridWidth));
  }
  const candidate = candidates[Math.floor(random() * candidates.length)];
  return candidate ? pointFromCell(data, candidate.index % data.gridWidth, Math.floor(candidate.index / data.gridWidth)) : null;
}

function connectForwardRoadDeadEnds(
  data: GeneratedMapData,
  generated: Road[],
  preserved: Road[],
  settlementPoints: Point[],
): Road[] {
  const cellSize = Math.max(data.worldWidth / data.gridWidth, data.worldHeight / data.gridHeight);
  const connectionTolerance = cellSize * 1.45;
  const maximumSearchDistance = cellSize * 24;
  const result = generated.map((road) => ({ ...road, nodes: road.nodes.map((point) => ({ ...point })) }));

  const isSettlementEndpoint = (point: Point) =>
    settlementPoints.some((settlement) => Math.hypot(settlement.x - point.x, settlement.y - point.y) <= cellSize * 1.8);

  for (let roadIndex = 0; roadIndex < result.length; roadIndex += 1) {
    for (const side of ["start", "end"] as const) {
      const road = result[roadIndex];
      if (road.nodes.length < 2) continue;
      const endpoint = side === "end" ? road.nodes[road.nodes.length - 1] : road.nodes[0];
      const inside = side === "end" ? road.nodes[road.nodes.length - 2] : road.nodes[1];
      if (isSettlementEndpoint(endpoint)) continue;

      const otherRoads = [...preserved, ...result.filter((_item, index) => index !== roadIndex)];
      const alreadyConnected = otherRoads.some((other) =>
        other.nodes.some((point) => Math.hypot(point.x - endpoint.x, point.y - endpoint.y) <= connectionTolerance));
      if (alreadyConnected) continue;

      const directionLength = Math.max(1e-7, Math.hypot(endpoint.x - inside.x, endpoint.y - inside.y));
      const directionX = (endpoint.x - inside.x) / directionLength;
      const directionY = (endpoint.y - inside.y) / directionLength;
      let target: Point | null = null;
      let targetDistance = Number.POSITIVE_INFINITY;
      for (const other of otherRoads) {
        for (const candidate of other.nodes) {
          const dx = candidate.x - endpoint.x;
          const dy = candidate.y - endpoint.y;
          const distance = Math.hypot(dx, dy);
          if (distance <= connectionTolerance || distance > maximumSearchDistance || distance >= targetDistance) continue;
          if ((dx * directionX + dy * directionY) / Math.max(1e-7, distance) < Math.cos(Math.PI * 0.42)) continue;
          target = candidate;
          targetDistance = distance;
        }
      }
      if (!target) continue;
      const connector = routeLandCells(data, endpoint, target, undefined, false);
      if (connector.length < 2) continue;
      if (side === "end") road.nodes = removeRoadBacktracking([...road.nodes, ...connector.slice(1)]);
      else road.nodes = removeRoadBacktracking([...connector.slice(1).reverse(), ...road.nodes]);
    }
  }
  return result;
}

function generateProceduralRoads(map: MapData, data: GeneratedMapData): Road[] {
  const preserved = map.roads.filter((road) => !road.id.startsWith(GENERATED_ROAD_PREFIX));
  const random = mulberry32((data.settings.seed ^ 0x48a7f31d) >>> 0);
  const year = 0;
  const settlements = visibleLocations(map)
    .filter(({ state }) => ["capital", "city", "town", "village"].includes(state.locationType) && isLandAtPoint(data, state.position))
    .map(({ location, state }) => ({ id: location.id, name: state.name, point: state.position, priority: state.locationType === "capital" ? 4 : state.locationType === "city" ? 3 : state.locationType === "town" ? 2 : 1 }));
  if (settlements.length < 2) return preserved;
  const major = settlements.filter((entry) => entry.priority >= 2);
  const networkTargets = major.length >= 2 ? major : settlements;
  const candidates = settlementCandidates(data, riverCellMask(data));
  const mask = new Uint8Array(data.gridWidth * data.gridHeight);
  for (const road of preserved) markRoadMask(data, mask, road.nodes);
  const generated: Road[] = [];
  const used = new Set<string>();
  const addRoad = (from: { id: string; name: string; point: Point } | null, to: { id: string; name: string; point: Point } | null, type: Road["roadType"], label: string) => {
    if (!from || !to || from.id === to.id) return false;
    const pairKey = [from.id, to.id].sort().join("::");
    if (used.has(pairKey)) return false;
    const a = gridCoordinates(data, from.point); const b = gridCoordinates(data, to.point);
    if (Math.hypot(a.x - b.x, a.y - b.y) < 5) return false;
    const attachToNetwork = generated.length > 0 && (type !== "main" || label.includes("간선"));
    let routed = routeLandCells(
      data,
      attachToNetwork ? to.point : from.point,
      attachToNetwork ? from.point : to.point,
      mask,
      false,
    );
    if (attachToNetwork && routed.length >= 3) {
      const junction = routed.findIndex((point, index) => index > 1 && mask[gridIndex(data, point)] > 0);
      if (junction > 1) routed = routed.slice(0, junction + 1);
      routed.reverse();
    }
    if (routed.length < 2) return false;
    const nodes = curveRoadNodes(data, routed).map((point) => ({ ...point }));
    const direct = Math.hypot(from.point.x - to.point.x, from.point.y - to.point.y);
    const routedLength = nodes.slice(1).reduce((sum, point, index) => sum + Math.hypot(point.x - nodes[index].x, point.y - nodes[index].y), 0);
    if (direct > 0 && routedLength / direct > 4.5) return false;
    const cellSize = Math.max(data.worldWidth / data.gridWidth, data.worldHeight / data.gridHeight);
    const minimumLength: Record<Road["roadType"], number> = {
      main: cellSize * 20,
      secondary: cellSize * 9,
      trail: cellSize * 4,
      bridge: cellSize * 2,
    };
    let effectiveType = type;
    if (effectiveType === "main" && routedLength < minimumLength.main) effectiveType = "secondary";
    if (effectiveType === "secondary" && routedLength < minimumLength.secondary) effectiveType = "trail";
    if (effectiveType === "trail" && routedLength < minimumLength.trail) return false;
    const road: Road = { id: `${GENERATED_ROAD_PREFIX}${generated.length + 1}`, name: label, startYear: year, endYear: null, nodes, roadType: effectiveType, description: "" };
    generated.push(road); used.add(pairKey); markRoadMask(data, mask, nodes); return true;
  };

  // 주요 도시는 최소 신장망에 가까운 방식으로 하나의 간선망에 포함한다.
  const connected = new Set<number>([0]);
  while (connected.size < networkTargets.length) {
    let best: { from: number; to: number; distance: number } | null = null;
    for (const from of connected) for (let to = 0; to < networkTargets.length; to += 1) {
      if (connected.has(to)) continue;
      const distance = Math.hypot(networkTargets[from].point.x - networkTargets[to].point.x, networkTargets[from].point.y - networkTargets[to].point.y);
      if (!best || distance < best.distance) best = { from, to, distance };
    }
    if (!best) break;
    addRoad(networkTargets[best.from], networkTargets[best.to], "main", `${networkTargets[best.from].name}–${networkTargets[best.to].name} 간선`);
    connected.add(best.to);
  }

  // 마을은 가장 가까운 기존 도시 또는 도로망으로 연결한다.
  for (const settlement of settlements.filter((entry) => entry.priority === 1)) {
    const nearest = networkTargets.slice().sort((a,b) => Math.hypot(a.point.x-settlement.point.x,a.point.y-settlement.point.y)-Math.hypot(b.point.x-settlement.point.x,b.point.y-settlement.point.y))[0];
    addRoad(settlement, nearest, "secondary", `${settlement.name} 연결로`);
  }

  const extras = Math.max(4, Math.min(16, Math.round(settlements.length * 0.55)));
  for (let index = 0; index < extras; index += 1) {
    const roll = random();
    if (roll < 0.55) {
      const from = settlements[Math.floor(random() * settlements.length)];
      const to = settlements[Math.floor(random() * settlements.length)];
      addRoad(from, to, random() < 0.35 ? "main" : "secondary", `${from?.name ?? "도시"}–${to?.name ?? "도시"} 도로`);
    } else if (roll < 0.8) {
      const from = settlements[Math.floor(random() * settlements.length)];
      const point = randomLandPoint(data, random, candidates);
      addRoad(from, point ? { id: `point-${index}-b`, name: "지역 지점", point } : null, "trail", `${from?.name ?? "도시"} 지역로`);
    } else {
      const first = randomLandPoint(data, random, candidates);
      const second = randomLandPoint(data, random, candidates);
      addRoad(first ? { id: `point-${index}-a`, name: "지역 지점", point: first } : null, second ? { id: `point-${index}-b`, name: "지역 지점", point: second } : null, "trail", `지역 횡단로 ${index + 1}`);
    }
  }
  return [
    ...preserved,
    ...connectForwardRoadDeadEnds(data, generated, preserved, settlements.map((settlement) => settlement.point))
      .map((road) => ({ ...road, nodes: curveRoadNodes(data, road.nodes) })),
  ];
}



function separateNearbyGeneratedSettlements(map: MapData, data: GeneratedMapData): MapData {
  const year = map.timeline.currentYear;
  const occupied: Point[] = [];
  const locations = map.locations.map((location) => {
    const state = getStateAtYear(location.states, year);
    if (!state || state.status === "destroyed" || !["capital", "city", "town"].includes(state.locationType)) return location;
    let position = state.position;
    const isGenerated = location.id.startsWith(GENERATED_SETTLEMENT_PREFIX);
    const minimumSpacing = 2;
    if (isGenerated && occupied.some((other) => Math.hypot(other.x - position.x, other.y - position.y) < minimumSpacing)) {
      const origin = gridCoordinates(data, position);
      let replacement: Point | null = null;
      for (let radius = 2; radius <= 24 && !replacement; radius += 1) {
        for (let oy = -radius; oy <= radius && !replacement; oy += 1) for (let ox = -radius; ox <= radius; ox += 1) {
          if (Math.max(Math.abs(ox), Math.abs(oy)) !== radius) continue;
          const x = origin.x + ox; const y = origin.y + oy;
          if (x < 0 || y < 0 || x >= data.gridWidth || y >= data.gridHeight) continue;
          const index = y * data.gridWidth + x;
          if (!cellIsLand(data, index) || ["mountain", "snow"].includes(data.terrainMap[index])) continue;
          const candidate = pointFromCell(data, x, y);
          if (occupied.every((other) => Math.hypot(other.x - candidate.x, other.y - candidate.y) >= minimumSpacing)) { replacement = candidate; break; }
        }
      }
      if (replacement) position = replacement;
    }
    occupied.push(position);
    if (position === state.position) return location;
    return {
      ...location,
      states: location.states.map((entry) => isYearInRange(entry, year)
        ? { ...entry, value: { ...entry.value, position } }
        : entry),
    };
  });
  return { ...map, locations };
}

function deterministicPlacementRandom(index: number, seed: number): number {
  let value = Math.imul(index + 1, 374761393) ^ Math.imul(seed | 0, 668265263);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 0xffffffff;
}

function waterDistanceCells(data: GeneratedMapData): Float32Array {
  const size = data.gridWidth * data.gridHeight;
  const distance = new Float32Array(size);
  distance.fill(1e9);
  for (let index = 0; index < size; index += 1) {
    if ((data.riverOrderMap[index] ?? 0) > 0 || data.waterTypeMap[index] === "freshwater") distance[index] = 0;
  }
  const diagonal = Math.SQRT2;
  for (let y = 0; y < data.gridHeight; y += 1) for (let x = 0; x < data.gridWidth; x += 1) {
    const index = y * data.gridWidth + x;
    let best = distance[index];
    if (x > 0) best = Math.min(best, distance[index - 1] + 1);
    if (y > 0) best = Math.min(best, distance[index - data.gridWidth] + 1);
    if (x > 0 && y > 0) best = Math.min(best, distance[index - data.gridWidth - 1] + diagonal);
    if (x + 1 < data.gridWidth && y > 0) best = Math.min(best, distance[index - data.gridWidth + 1] + diagonal);
    distance[index] = best;
  }
  for (let y = data.gridHeight - 1; y >= 0; y -= 1) for (let x = data.gridWidth - 1; x >= 0; x -= 1) {
    const index = y * data.gridWidth + x;
    let best = distance[index];
    if (x + 1 < data.gridWidth) best = Math.min(best, distance[index + 1] + 1);
    if (y + 1 < data.gridHeight) best = Math.min(best, distance[index + data.gridWidth] + 1);
    if (x + 1 < data.gridWidth && y + 1 < data.gridHeight) best = Math.min(best, distance[index + data.gridWidth + 1] + diagonal);
    if (x > 0 && y + 1 < data.gridHeight) best = Math.min(best, distance[index + data.gridWidth - 1] + diagonal);
    distance[index] = best;
  }
  return distance;
}

const urbanWoodlandProfile = {
  capital: { radiusCells: 5, clearingChance: 0.62 },
  city: { radiusCells: 4, clearingChance: 0.5 },
  town: { radiusCells: 3, clearingChance: 0.3 },
  village: { radiusCells: 2, clearingChance: 0.16 },
} as const;

/** 도시권의 자연림을 완전히 지우지 않고 중심부일수록 드물게 솎아낸다. */
function restrainWoodlandAroundSettlements(
  data: GeneratedMapData,
  settlements: ReturnType<typeof visibleLocations>,
  terrainMap: TerrainType[],
): void {
  for (const [settlementIndex, { state }] of settlements.entries()) {
    const profile = urbanWoodlandProfile[state.locationType as keyof typeof urbanWoodlandProfile];
    if (!profile) continue;
    const center = gridCoordinates(data, state.position);
    const population = Math.max(500, state.population ?? 2_000);
    const populationFactor = Math.max(0.85, Math.min(1.25, Math.pow(population / 18_000, 0.08)));
    const radius = profile.radiusCells * populationFactor;
    const extent = Math.ceil(radius);
    for (let y = Math.max(0, center.y - extent); y <= Math.min(data.gridHeight - 1, center.y + extent); y += 1) {
      for (let x = Math.max(0, center.x - extent); x <= Math.min(data.gridWidth - 1, center.x + extent); x += 1) {
        const distance = Math.hypot(x - center.x, y - center.y);
        if (distance > radius) continue;
        const index = y * data.gridWidth + x;
        if (data.waterTypeMap[index] !== "land" || (terrainMap[index] !== "forest" && terrainMap[index] !== "jungle")) continue;
        const centerWeight = 0.35 + 0.65 * (1 - distance / Math.max(1, radius));
        const chance = profile.clearingChance * centerWeight;
        if (deterministicPlacementRandom(index, data.settings.seed + settlementIndex * 65_537) >= chance) continue;
        terrainMap[index] = (data.moistureMap[index] ?? 0.5) > 0.48 ? "grassland" : "plain";
      }
    }
  }
}

/** 도시 형성 뒤 평원·초원 중 수계와 토양 조건이 좋은 곳만 농경지로 전환한다. */
function cultivateFarmlandAroundSettlements(data: GeneratedMapData, map: MapData): GeneratedMapData {
  const settlements = visibleLocations(map).filter(({ state }) => ["capital", "city", "town", "village"].includes(state.locationType));
  const terrainMap = normalizedNaturalTerrainMap(data);
  const agricultureMap = new Array(terrainMap.length).fill(0);
  if (!settlements.length) return refreshSurfaceRegions({ ...data, baseTerrainMap: [...terrainMap], agricultureMap, terrainMap });
  restrainWoodlandAroundSettlements(data, settlements, terrainMap);
  const score = new Float32Array(terrainMap.length);
  const owner = new Int16Array(terrainMap.length);
  owner.fill(-1);
  const budgets = new Int32Array(settlements.length);
  const waterDistance = waterDistanceCells(data);
  const physicalHeightKm = data.settings.mapScaleKm * data.worldHeight / Math.max(1e-9, data.worldWidth);
  const cellKmX = data.settings.mapScaleKm / data.gridWidth;
  const cellKmY = physicalHeightKm / data.gridHeight;
  const meanCellKm = Math.max(0.05, (cellKmX + cellKmY) * 0.5);
  const arid = String(data.settings.climatePreset).startsWith("B") || data.settings.basePrecipitationMm < 520;

  for (const [settlementIndex, { state }] of settlements.entries()) {
    const center = gridCoordinates(data, state.position);
    const population = Math.max(500, state.population ?? (state.locationType === "village" ? 1800 : state.locationType === "town" ? 9000 : 35_000));
    const baseRadius = state.locationType === "capital" ? 62 : state.locationType === "city" ? 48 : state.locationType === "town" ? 31 : 18;
    const radiusKm = baseRadius * Math.max(0.78, Math.min(1.65, Math.pow(population / 18_000, 0.16)));
    const maximumArea = state.locationType === "capital" ? 900 : state.locationType === "city" ? 600 : state.locationType === "town" ? 180 : 55;
    budgets[settlementIndex] = Math.max(3, Math.round(Math.min(maximumArea, population * 0.004) / Math.max(0.01, cellKmX * cellKmY)));
    const radiusX = Math.ceil(radiusKm / cellKmX);
    const radiusY = Math.ceil(radiusKm / cellKmY);
    const coreKm = state.locationType === "capital" || state.locationType === "city" ? 2.4 : 1.2;
    for (let y = Math.max(1, center.y - radiusY); y <= Math.min(data.gridHeight - 2, center.y + radiusY); y += 1) {
      for (let x = Math.max(1, center.x - radiusX); x <= Math.min(data.gridWidth - 2, center.x + radiusX); x += 1) {
        const index = y * data.gridWidth + x;
        const naturalTerrain = terrainMap[index];
        if (data.waterTypeMap[index] !== "land" || !["plain", "grassland", "forest", "jungle"].includes(naturalTerrain)) continue;
        if (naturalTerrain === "forest" || naturalTerrain === "jungle") {
          let woodlandEdge = false;
          for (let oy = -2; oy <= 2 && !woodlandEdge; oy += 1) {
            for (let ox = -2; ox <= 2; ox += 1) {
              const nearby = terrainMap[(y + oy) * data.gridWidth + x + ox];
              if (nearby !== "forest" && nearby !== "jungle") {
                woodlandEdge = true;
                break;
              }
            }
          }
          if (!woodlandEdge) continue;
        }
        const cityDistanceKm = Math.hypot((x - center.x) * cellKmX, (y - center.y) * cellKmY);
        if (cityDistanceKm < coreKm || cityDistanceKm > radiusKm) continue;
        const cityFactor = Math.max(0, 1 - cityDistanceKm / radiusKm);
        const riverKm = waterDistance[index] * meanCellKm;
        // 강둑 바로 옆의 상습 범람대는 피하고, 약간 떨어진 충적평야에서 최고가 된다.
        const optimumKm = arid ? 3.5 : 7.5;
        const spreadKm = arid ? 10 : 18;
        const riverFactor = Math.exp(-Math.pow((riverKm - optimumKm) / spreadKm, 2));
        const maximumWaterDistance = arid ? 24 : 38;
        if (riverKm > maximumWaterDistance && cityDistanceKm > radiusKm * 0.28) continue;
        if (riverKm < 1.2) continue;
        const floodPenalty = riverKm < 2.2 ? 0.58 : 1;
        const left = data.elevationMap[index - 1];
        const right = data.elevationMap[index + 1];
        const up = data.elevationMap[index - data.gridWidth];
        const down = data.elevationMap[index + data.gridWidth];
        const slope = Math.hypot((right - left) / Math.max(1, cellKmX * 2000), (down - up) / Math.max(1, cellKmY * 2000));
        const slopeFactor = Math.max(0, 1 - slope * 5.5);
        const moisture = Math.max(0, Math.min(1, data.moistureMap[index] ?? 0.5));
        const temperature = data.temperatureMap[index] ?? 14;
        const climateFactor = Math.max(0, 1 - Math.abs(temperature - 15) / 27) * (0.55 + moisture * 0.55);
        const drainage = data.coastalTerrainMap[index] === "mudflat" || data.coastalTerrainMap[index] === "salt_marsh" ? 0.15 : 1;
        const waterWeight = arid ? 0.88 : 0.64;
        const clearingFactor = naturalTerrain === "forest" ? 0.67 : naturalTerrain === "jungle" ? 0.42 : 1;
        const suitability = (cityFactor * 0.46 + riverFactor * waterWeight + slopeFactor * 0.24 + climateFactor * 0.18) * clearingFactor * floodPenalty * drainage;
        if (suitability > score[index]) {
          score[index] = suitability;
          owner[index] = settlementIndex;
        }
      }
    }
  }

  const selectedOwner = new Int16Array(terrainMap.length);
  selectedOwner.fill(-1);
  const queued = new Int16Array(terrainMap.length);
  queued.fill(-1);
  const neighbors = (index: number): number[] => {
    const x = index % data.gridWidth;
    const y = Math.floor(index / data.gridWidth);
    const result: number[] = [];
    for (let oy = -1; oy <= 1; oy += 1) for (let ox = -1; ox <= 1; ox += 1) {
      if ((!ox && !oy) || x + ox < 0 || y + oy < 0 || x + ox >= data.gridWidth || y + oy >= data.gridHeight) continue;
      result.push((y + oy) * data.gridWidth + x + ox);
    }
    return result;
  };

  for (let settlementIndex = 0; settlementIndex < settlements.length; settlementIndex += 1) {
    const candidates = Array.from(score.keys())
      .filter((index) => owner[index] === settlementIndex && score[index] > 0.64)
      .sort((a, b) => score[b] - score[a]);
    const seed = candidates.find((index) =>
      neighbors(index).every((nearby) => selectedOwner[nearby] < 0),
    );
    if (seed === undefined) continue;
    const frontier: number[] = [];
    let selected = 0;
    let clearedForest = 0;
    let clearedJungle = 0;
    const queue = (index: number) => {
      if (owner[index] !== settlementIndex || score[index] <= 0.64 || selectedOwner[index] >= 0 || queued[index] === settlementIndex) return;
      if (neighbors(index).some((nearby) => selectedOwner[nearby] >= 0 && selectedOwner[nearby] !== settlementIndex)) return;
      queued[index] = settlementIndex;
      frontier.push(index);
    };
    const accept = (index: number) => {
      selectedOwner[index] = settlementIndex;
      const variation = deterministicPlacementRandom(index, data.settings.seed + settlementIndex * 7919);
      agricultureMap[index] = Math.max(0.56, Math.min(1, 0.58 + (score[index] - 0.64) * 0.46 + variation * 0.08));
      selected += 1;
      if (terrainMap[index] === "forest") clearedForest += 1;
      if (terrainMap[index] === "jungle") clearedJungle += 1;
      for (const nearby of neighbors(index)) queue(nearby);
    };
    accept(seed);
    while (frontier.length > 0 && selected < budgets[settlementIndex]) {
      let bestPosition = 0;
      let bestScore = Number.NEGATIVE_INFINITY;
      for (let position = 0; position < frontier.length; position += 1) {
        const index = frontier[position];
        const variation = deterministicPlacementRandom(index, data.settings.seed + settlementIndex * 104729) * 0.08;
        const candidateScore = score[index] + variation;
        if (candidateScore > bestScore) {
          bestScore = candidateScore;
          bestPosition = position;
        }
      }
      const [index] = frontier.splice(bestPosition, 1);
      if (terrainMap[index] === "forest" && clearedForest >= budgets[settlementIndex] * 0.22) continue;
      if (terrainMap[index] === "jungle" && clearedJungle >= budgets[settlementIndex] * 0.04) continue;
      accept(index);
    }
  }
  // 무작위 점처럼 보이지 않도록 강을 따라 이어진 농경지 패치를 성장시키고 고립 셀을 제거한다.
  return refreshSurfaceRegions({ ...data, baseTerrainMap: [...terrainMap], agricultureMap, terrainMap }, "final");
}

/**
 * 수도 Voronoi와 네 개 도시의 경쟁적 모폴로지 팽창을 이용해 국가 영토를 만든다.
 * 파동은 높은 지대와 강에서 느려지고, 바다를 통과할 수 있지만 바다 셀은 영토로 저장하지 않는다.
 * 먼저 점유된 셀은 다른 국가가 침범하지 않으며, 경계 침식 뒤 재팽창하여 무인지대를 제거한다.
 */
export function applyGeneratedCountries(map: MapData, sourceInput: GeneratedMapData): { map: MapData; generated: GeneratedMapData } {
  const outputSource = sourceInput;
  const source = placementResolutionSource(sourceInput);
  const settings = source.settings;
  const configuredCountryCount = totalCountryCount(settings);
  if (!settings.generateCountries || configuredCountryCount <= 0) {
    const riverMask = riverCellMask(source);
    const transportMask = transportCorridorMask(source, map);
    const owner = new Int16Array(source.gridWidth * source.gridHeight);
    const hierarchy = planSettlementHierarchy(source, map, ["unowned"], [], owner, riverMask, transportMask);
    const settlements = upsertGeneratedSettlements(map, source, [], hierarchy.sites);
    const roads = settings.regenerateSettlementRoads && settings.mapScope !== "continent" && settings.mapScope !== "world"
      ? generateProceduralRoads({ ...map, locations: settlements.locations }, source)
      : map.roads;
    const nextMap = alignMapFeaturesToGenerated({ ...map, locations: settlements.locations, roads }, outputSource);
    return { map: nextMap, generated: cultivateFarmlandAroundSettlements(outputSource, nextMap) };
  }

  const targetCount = configuredCountryCount;
  let factions = [...map.factions];
  let countries = factions.filter((faction) => faction.kind === "country");
  const archetypes = makeCountryArchetypes(targetCount, source);
  for (let index = countries.length; index < targetCount; index += 1) {
    const id = `${GENERATED_COUNTRY_PREFIX}${index + 1}`;
    const archetype = archetypes[index] ?? "agrarian";
    factions.push({
      id,
      kind: "country",
      name: GENERATED_COUNTRY_NAMES[index % GENERATED_COUNTRY_NAMES.length],
      color: COUNTRY_COLORS[index % COUNTRY_COLORS.length],
      activityRange: archetype === "maritime" ? "sea_centered" : archetype === "nomadic" ? "land_only" : "land_centered",
      summary: "",
      description: "",
      foundedYear: 0,
      hasTerritory: true,
    });
  }
  countries = factions.filter((faction) => faction.kind === "country").slice(0, targetCount);
  const countryArchetypes = countries.map((country, index) => country.activityRange === "sea_centered" || country.activityRange === "sea_only"
    ? "maritime"
    : country.summary.includes("산악형")
      ? "mountain"
      : country.summary.includes("유목형")
        ? "nomadic"
        : country.summary.includes("상업형")
          ? "commercial"
        : archetypes[index] ?? "agrarian");

  const riverMask = riverCellMask(source);
  const candidates = settlementCandidates(source, riverMask);
  if (candidates.length === 0) return { map: { ...map, factions }, generated: outputSource };
  const existingTransportMask = transportCorridorMask(source, map);
  const capitals = chooseCapitalSeeds(source, map, countries.map((country) => country.id), countryArchetypes, candidates, riverMask, existingTransportMask);
  const voronoiOwner = capitalVoronoi(source, capitals);
  const hierarchy = planSettlementHierarchy(
    source,
    map,
    countries.map((country) => country.id),
    capitals,
    voronoiOwner,
    riverMask,
    existingTransportMask,
  );
  const citySeeds = hierarchy.growthSeedsByCountry;
  const plannedTransportMask = transportCorridorMask(source, map, citySeeds);
  const initialGrowth = growTerritories(source, citySeeds, countryArchetypes, voronoiOwner, riverMask, plannedTransportMask);
  const owner = fullyErodeAndRegrowTerritories(
    source,
    initialGrowth.owner,
    initialGrowth.cityCost,
    citySeeds,
    countryArchetypes,
    voronoiOwner,
    riverMask,
    plannedTransportMask,
  );
  const existingTerritories = map.territories.filter((territory) => !territory.id.startsWith(GENERATED_TERRITORY_PREFIX));

  const settlements = upsertGeneratedSettlements({ ...map, factions }, source, countries, hierarchy.sites);
  factions = settlements.factions;
  const roads = !source.settings.regenerateSettlementRoads || source.settings.mapScope === "continent" || source.settings.mapScope === "world"
    ? map.roads.filter((road) => !road.id.startsWith(GENERATED_ROAD_PREFIX))
    : generateProceduralRoads({ ...map, factions, locations: settlements.locations }, source);
  countries = factions.filter((faction) => faction.kind === "country").slice(0, targetCount);
  const territories = map.territories.filter((territory) => !territory.id.startsWith(GENERATED_TERRITORY_PREFIX));
  const generatedTerritories: GeneratedMapData["generatedTerritories"] = [];
  const year = 0;
  const reservedPolygons = existingTerritories
    .map((territory) => getStateAtYear(territory.states, year)?.polygon)
    .filter((polygon): polygon is Point[] => Boolean(polygon?.length && polygon.length >= 3));
  const vectorRegions = buildVectorTerritoryRegions(
    outputSource,
    owner,
    vectorTerritorySites(source, owner, capitals, countries.length),
    reservedPolygons,
    source.gridWidth,
    source.gridHeight,
  );

  const territoryPartCounts = new Map<number, number>();
  for (const region of vectorRegions) {
      const countryIndex = region.owner;
      const territoryPart = (territoryPartCounts.get(countryIndex) ?? 0) + 1;
      territoryPartCounts.set(countryIndex, territoryPart);
      const mountainAdapted = owner.some((cellOwner, index) => cellOwner === countryIndex && ["mountain", "rock", "snow"].includes(source.terrainMap[index]));
      generatedTerritories.push({ index: countryIndex, name: countries[countryIndex].name, color: countries[countryIndex].color, center: region.center, polygon: region.polygon, holes: region.holes, coastal: region.coastal, mountainAdapted });
      territories.push({
        id: `${GENERATED_TERRITORY_PREFIX}${countries[countryIndex].id}-${territoryPart}`,
        name: `${countries[countryIndex].name} 영토`,
        states: [{
          startYear: year,
          endYear: null,
          value: {
            ownerFactionId: countries[countryIndex].id,
            polygon: region.polygon,
            holes: region.holes,
            parts: [{ polygon: region.polygon, holes: region.holes }],
            geometryVersion: CURRENT_SURFACE_VECTOR_VERSION,
            geometryFingerprint: surfaceGeometryFingerprint(outputSource),
            description: "",
          },
        }],
      });
  }

  const constrainedMap = enforceTerritoryConstraints({ ...map, factions, locations: settlements.locations, roads, territories }, outputSource);
  const cultivatedSource = cultivateFarmlandAroundSettlements({ ...outputSource, generatedTerritories }, constrainedMap);
  // 배치 벡터는 LOD 환경장에서 이미 지형에 정렬되어 있으므로 고해상도 격자에서 A*를 반복하지 않는다.
  const alignedMap = alignMapFeaturesToGenerated(constrainedMap, cultivatedSource);
  const separatedMap = separateNearbyGeneratedSettlements(alignedMap, cultivatedSource);
  return {
    map: separatedMap,
    generated: cultivatedSource,
  };
}
