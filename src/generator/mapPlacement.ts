import type { GeneratedMapData, LocationState, MapData, PlaceName, Point, Road, TerrainType } from "../model/world";
import { mulberry32 } from "./random";
import { getStateAtYear, isYearInRange, pointInPolygon, visibleLocations } from "../model/world";
import { limitPathCurvature, smoothPath } from "./pathSmoothing";
import { createGridTransform, nearestPowerOfTwo } from "./gridTransform";
import { refreshSurfaceRegions } from "./surfaceVectors";


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
  return data.terrainMap[gridIndex(data, point)] ?? "plain";
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

function routeLandCells(data: GeneratedMapData, startPoint: Point, endPoint: Point, river = false, existingRoadMask?: Uint8Array, allowFallback = true): Point[] {
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
      if (["mountain", "snow", "rock"].includes(terrain)) terrainPenalty += river ? 0.3 : 5.5;
      if (terrain === "wetland") terrainPenalty += river ? 0.1 : 3.4;
      if (["desert", "jungle", "forest"].includes(terrain)) terrainPenalty += river ? 0.15 : 1.2;
      const riverOrder = data.riverOrderMap?.[next] ?? 0;
      const crossingPenalty = !river && riverOrder > 0 && (data.riverOrderMap?.[current.index] ?? 0) === 0 ? 2.5 + riverOrder * 2.1 : 0;
      let summitPenalty = 0;
      if (!river && normalizedElevation > 0.48) {
        let neighborMean = 0; let count = 0;
        for (const [sx, sy] of [[1,0],[-1,0],[0,1],[0,-1]] as const) { const px = nx + sx; const py = ny + sy; if (px < 0 || py < 0 || px >= data.gridWidth || py >= data.gridHeight) continue; neighborMean += data.elevationMap[py * data.gridWidth + px]; count += 1; }
        neighborMean /= Math.max(1, count);
        summitPenalty = Math.max(0, elevation - neighborMean) / Math.max(20, elevationRange * 0.01) * 5 + Math.pow(normalizedElevation, 2.2) * 8;
      }
      let step = baseDistance + slopeNorm * (river ? 2.5 : 5.5) + (river ? Math.max(0, delta) / Math.max(20, elevationRange) * 15 : Math.pow(uphillNorm, 2) * 12 + Math.pow(downhillNorm, 2) * 2.2) + terrainPenalty + crossingPenalty + summitPenalty;
      if (!river && existingRoadMask?.[next]) step *= 0.34;
      else if (!river) step *= roadMagnetMultiplier(existingRoadMask, data.gridWidth, data.gridHeight, nx, ny, dx, dy);
      if (!river && (slopeNorm > 7 || normalizedElevation > 0.92)) step += 80;
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

export function routePathOnLand(data: GeneratedMapData, nodes: Point[], river = false): Point[] {
  if (nodes.length < 2) return nodes.map((node) => nearestGeneratedPoint(data, node, (_terrain, _elevation, x, y) => cellIsLand(data, y * data.gridWidth + x)));
  const routed: Point[] = [];
  for (let index = 0; index < nodes.length - 1; index += 1) {
    const segment = routeLandCells(data, nodes[index], nodes[index + 1], river);
    if (index > 0) segment.shift();
    routed.push(...segment);
  }
  const cleaned = removeRoadBacktracking(routed);
  return river ? cleaned : curveRoadNodes(data, cleaned);
}

function edgeKey(point: [number, number]): string { return `${point[0]},${point[1]}`; }
function traceMaskBoundary(mask: Uint8Array, width: number, height: number, data: GeneratedMapData): Point[] {
  const outgoing = new Map<string, Array<[number, number]>>();
  const addEdge = (a: [number, number], b: [number, number]) => { const key = edgeKey(a); const list = outgoing.get(key) ?? []; list.push(b); outgoing.set(key, list); };
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x] === 1;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    if (!inside(x, y)) continue;
    if (!inside(x, y - 1)) addEdge([x, y], [x + 1, y]);
    if (!inside(x + 1, y)) addEdge([x + 1, y], [x + 1, y + 1]);
    if (!inside(x, y + 1)) addEdge([x + 1, y + 1], [x, y + 1]);
    if (!inside(x - 1, y)) addEdge([x, y + 1], [x, y]);
  }
  const loops: Array<Array<[number, number]>> = [];
  while (outgoing.size) {
    const firstEntry = outgoing.entries().next().value as [string, Array<[number, number]>] | undefined; if (!firstEntry) break;
    const [startKey, firstTargets] = firstEntry; const [sx, sy] = startKey.split(",").map(Number); const loop: Array<[number, number]> = [[sx, sy]]; let currentKey = startKey; let guard = 0;
    while (guard++ < width * height * 8) {
      const targets = outgoing.get(currentKey); if (!targets?.length) break; const next = targets.pop()!; if (targets.length === 0) outgoing.delete(currentKey); currentKey = edgeKey(next); loop.push(next); if (currentKey === startKey) break;
    }
    if (loop.length > 4) loops.push(loop);
  }
  const longest = loops.sort((a, b) => b.length - a.length)[0] ?? [];
  if (longest.length < 4) return [];

  // 국가 마스크는 서로 배타적이므로 셀 경계를 그대로 보존해야 한다. 임의 간격으로
  // 점을 건너뛰면 모서리 사이에 대각선 현이 생겨 인접 국가를 침범할 수 있다.
  // 따라서 직선 위의 중간점만 제거하고 모든 방향 전환점은 유지한다.
  const closed = longest[0][0] === longest[longest.length - 1][0]
    && longest[0][1] === longest[longest.length - 1][1];
  const ring = closed ? longest.slice(0, -1) : [...longest];
  const simplified = ring.filter((point, index) => {
    const previous = ring[(index - 1 + ring.length) % ring.length];
    const next = ring[(index + 1) % ring.length];
    const dx1 = point[0] - previous[0];
    const dy1 = point[1] - previous[1];
    const dx2 = next[0] - point[0];
    const dy2 = next[1] - point[1];
    return dx1 * dy2 - dy1 * dx2 !== 0;
  });
  return simplified.map(([x, y]) => ({
    x: (x / width) * data.worldWidth,
    y: (y / height) * data.worldHeight,
  }));
}


function traceMaskRings(mask: Uint8Array, width: number, height: number, data: GeneratedMapData): { polygon: Point[]; holes: Point[][] } {
  const outgoing = new Map<string, Array<[number, number]>>();
  const addEdge = (a: [number, number], b: [number, number]) => { const key = edgeKey(a); const list = outgoing.get(key) ?? []; list.push(b); outgoing.set(key, list); };
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x] === 1;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    if (!inside(x, y)) continue;
    if (!inside(x, y - 1)) addEdge([x, y], [x + 1, y]);
    if (!inside(x + 1, y)) addEdge([x + 1, y], [x + 1, y + 1]);
    if (!inside(x, y + 1)) addEdge([x + 1, y + 1], [x, y + 1]);
    if (!inside(x - 1, y)) addEdge([x, y + 1], [x, y]);
  }
  const loops: Array<Array<[number, number]>> = [];
  while (outgoing.size) {
    const firstEntry = outgoing.entries().next().value as [string, Array<[number, number]>] | undefined;
    if (!firstEntry) break;
    const [startKey] = firstEntry;
    const [sx, sy] = startKey.split(",").map(Number);
    const loop: Array<[number, number]> = [[sx, sy]];
    let currentKey = startKey;
    let guard = 0;
    while (guard++ < width * height * 8) {
      const targets = outgoing.get(currentKey);
      if (!targets?.length) break;
      const next = targets.pop()!;
      if (targets.length === 0) outgoing.delete(currentKey);
      currentKey = edgeKey(next);
      loop.push(next);
      if (currentKey === startKey) break;
    }
    if (loop.length > 4) loops.push(loop);
  }
  const simplify = (loop: Array<[number, number]>): Point[] => {
    const closed = loop[0][0] === loop[loop.length - 1][0] && loop[0][1] === loop[loop.length - 1][1];
    const ring = closed ? loop.slice(0, -1) : [...loop];
    const simplified = ring.filter((point, index) => {
      const previous = ring[(index - 1 + ring.length) % ring.length];
      const next = ring[(index + 1) % ring.length];
      const dx1 = point[0] - previous[0];
      const dy1 = point[1] - previous[1];
      const dx2 = next[0] - point[0];
      const dy2 = next[1] - point[1];
      return dx1 * dy2 - dy1 * dx2 !== 0;
    });
    return simplified.map(([x, y]) => ({ x: (x / width) * data.worldWidth, y: (y / height) * data.worldHeight }));
  };
  const rings = loops.sort((a, b) => b.length - a.length).map(simplify).filter((ring) => ring.length >= 3);
  return { polygon: rings[0] ?? [], holes: rings.slice(1) };
}

function territoryPolygonOnNaturalBoundaries(map: MapData, data: GeneratedMapData, polygon: Point[], factionId: string | null): Point[] {
  if (polygon.length < 3) return polygon;
  const faction = map.factions.find((item) => item.id === factionId);
  const mask = new Uint8Array(data.gridWidth * data.gridHeight);
  const cellW = data.worldWidth / data.gridWidth; const cellH = data.worldHeight / data.gridHeight;
  for (let y = 0; y < data.gridHeight; y += 1) for (let x = 0; x < data.gridWidth; x += 1) {
    const index = y * data.gridWidth + x; const point = { x: (x + 0.5) * cellW, y: (y + 0.5) * cellH }; if (!pointInPolygon(point, polygon)) continue;
    const land = cellIsLand(data, index);
    if (land) mask[index] = 1;
  }
  let traced = traceMaskBoundary(mask, data.gridWidth, data.gridHeight, data);
  if (traced.length < 3) traced = polygon.map((point) => nearestGeneratedPoint(data, point, (_terrain, _elevation, x, y) => cellIsLand(data, y * data.gridWidth + x)));
  const naturalPoints: Array<{ point: Point; kind: "coastline" | "river" | "mountain" }> = [
    ...data.coastline.flatMap((line) => [
      { point: line.start, kind: "coastline" as const },
      { point: line.end, kind: "coastline" as const },
    ]),
    ...map.rivers.flatMap((river) => river.nodes.map((node) => ({ point: node, kind: "river" as const }))),
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

/** 현재 연도의 모든 영토를 배타적인 육지 셀로 다시 구성한다. 먼저 작은 영토를 보존하고 큰 영토를 남은 셀에 맞춰 자른다. */
export function enforceTerritoryConstraints(map: MapData, generatedInput: GeneratedMapData): MapData {
  const generated = placementResolutionSource(generatedInput);
  const year = map.timeline.currentYear;
  const claimed = new Uint8Array(generated.gridWidth * generated.gridHeight);
  const active = map.territories.map((territory, territoryIndex) => {
    const stateIndex = territory.states.findIndex((state) => isYearInRange(state, year));
    const state = stateIndex >= 0 ? territory.states[stateIndex] : null;
    return state ? { territory, territoryIndex, stateIndex, state, area: territoryArea(state.value.polygon) } : null;
  }).filter((row): row is NonNullable<typeof row> => Boolean(row)).sort((a, b) => a.area - b.area || a.territoryIndex - b.territoryIndex);
  const replacements = new Map<string, { polygon: Point[]; holes: Point[][] }>();
  const cellW = generated.worldWidth / generated.gridWidth; const cellH = generated.worldHeight / generated.gridHeight;
  for (const row of active) {
    const mask = new Uint8Array(generated.gridWidth * generated.gridHeight);
    for (let y = 0; y < generated.gridHeight; y += 1) for (let x = 0; x < generated.gridWidth; x += 1) {
      const index = y * generated.gridWidth + x;
      if (claimed[index] || !cellIsLand(generated, index)) continue;
      const point = { x: (x + 0.5) * cellW, y: (y + 0.5) * cellH };
      if (!pointInPolygon(point, row.state.value.polygon)) continue;
      if ((row.state.value.holes ?? []).some((hole) => pointInPolygon(point, hole))) continue;
      mask[index] = 1;
    }
    const rings = traceMaskRings(mask, generated.gridWidth, generated.gridHeight, generated);
    replacements.set(`${row.territory.id}:${row.stateIndex}`, rings);
    for (let index = 0; index < mask.length; index += 1) if (mask[index]) claimed[index] = 1;
  }
  return {
    ...map,
    territories: map.territories.map((territory) => ({
      ...territory,
      states: territory.states.map((state, stateIndex) => {
        const rings = replacements.get(`${territory.id}:${stateIndex}`);
        return rings ? { ...state, value: { ...state.value, polygon: rings.polygon, holes: rings.holes } } : state;
      }),
    })),
  };
}

/** 장소를 육지로 옮기고 영토를 육지·비중첩 상태로 정규화한다. 불러오기 직후에도 사용할 수 있다. */
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
  const roads = map.roads.map((road) => ({ ...road, nodes: routePathOnLand(generated, road.nodes, false) }));
  const rivers = map.rivers.map((river) => ({ ...river, nodes: routePathOnLand(generated, river.nodes, true) }));
  for (const location of locations) {
    const state = getStateAtYear(location.states, year);
    if (!state || !/관문|관$/.test(state.name) || roads.length === 0) continue;
    const candidates = roads.flatMap((road) => road.nodes);
    const nearest = [...candidates].sort((a, b) => Math.hypot(a.x - state.position.x, a.y - state.position.y) - Math.hypot(b.x - state.position.x, b.y - state.position.y))[0];
    if (nearest) for (const record of location.states) if (record.value.name === state.name) record.value.position = { ...nearest };
  }
  const mapWithPaths = { ...map, placeNames, locations, roads, rivers };
  const territories = map.territories.map((territory) => territory.id.startsWith(GENERATED_TERRITORY_PREFIX) ? territory : ({
    ...territory,
    states: territory.states.map((state) => isYearInRange(state, year) ? ({ ...state, value: { ...state.value, polygon: territoryPolygonOnNaturalBoundaries(mapWithPaths, generated, state.value.polygon, state.value.ownerFactionId) } }) : state),
  }));
  return enforceTerritoryConstraints({ ...mapWithPaths, territories }, generated);
}

const GENERATED_COUNTRY_PREFIX = "generated-country-";
const GENERATED_TERRITORY_PREFIX = "generated-territory-";
const GENERATED_SETTLEMENT_PREFIX = "generated-settlement-";
const GENERATED_ROAD_PREFIX = "generated-road-";
const COUNTRY_COLORS = ["#d65a5a", "#4f7bd9", "#4fa36f", "#d49a3a", "#8a63c7", "#3f9da8", "#b65d91", "#8d7a55", "#6f8f3c", "#b36b3f"];
const GENERATED_COUNTRY_NAMES = ["아르덴 왕국", "네레이드 연방", "벨로란 공국", "세르카 초원국", "루메아 상업동맹", "카르몬 산악국", "에브린 공화국", "탈베르 술탄국", "오르세아 왕령", "미르켄 연합", "다르바니아", "솔라엔 제국"];
const CITY_NAME_SETS = [
  ["아르벤", "델마르", "카이렌", "브레사"], ["네레이아", "칼리온", "세피라", "오델"],
  ["벨로라", "하르켄", "에스텔", "로디안"], ["세르카", "타르온", "메르칸", "울다르"],
  ["루메아", "베르사", "코렌", "일리오"], ["카르몬", "드라센", "발케르", "오르딘"],
  ["에브린", "라세아", "티론", "모렌"], ["탈베르", "아즈라", "케시르", "누마르"],
  ["오르세아", "레반", "시아르", "펠론"], ["미르켄", "도르바", "엘세르", "가렌"],
  ["다르반", "니세아", "코발", "세르딘"], ["솔라엔", "아우렐", "테라스", "리비온"],
];

const CARDINAL_DIRECTIONS = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
const EIGHT_DIRECTIONS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const;

type CountryArchetype = "maritime" | "mountain" | "nomadic" | "agrarian";
type RegionWave = { index: number; owner: number; priority: number };

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

function riverCellMask(data: GeneratedMapData): Uint8Array {
  const mask = new Uint8Array(data.gridWidth * data.gridHeight);
  for (const segment of data.rivers) {
    const cellSize = Math.max(data.worldWidth / data.gridWidth, data.worldHeight / data.gridHeight);
    const steps = Math.max(1, Math.ceil(Math.hypot(segment.end.x - segment.start.x, segment.end.y - segment.start.y) / cellSize));
    for (let step = 0; step <= steps; step += 1) {
      const t = step / steps;
      const point = {
        x: segment.start.x + (segment.end.x - segment.start.x) * t,
        y: segment.start.y + (segment.end.y - segment.start.y) * t,
      };
      mask[gridIndex(data, point)] = 1;
    }
  }
  return mask;
}

function makeCountryArchetypes(count: number, data: GeneratedMapData): CountryArchetype[] {
  const maritimeCount = Math.min(count, Math.round(count * data.settings.maritimeCountryRatio));
  const mountainCount = Math.min(count - maritimeCount, Math.round(count * data.settings.mountainCountryRatio));
  const nomadicCount = Math.min(count - maritimeCount - mountainCount, Math.round(count * data.settings.nomadicCountryRatio));
  return Array.from({ length: count }, (_, index) => index < maritimeCount
    ? "maritime"
    : index < maritimeCount + mountainCount
      ? "mountain"
      : index < maritimeCount + mountainCount + nomadicCount
        ? "nomadic"
        : "agrarian");
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

function archetypePreference(data: GeneratedMapData, riverMask: Uint8Array, index: number, archetype: CountryArchetype): number {
  const x = index % data.gridWidth;
  const y = Math.floor(index / data.gridWidth);
  const terrain = data.terrainMap[index];
  const elevation = data.elevationMap[index];
  const precipitation = data.precipitationMap[index] ?? 700;
  if (archetype === "maritime") return isCoastalCell(data, x, y) ? 3.2 : -0.8;
  if (archetype === "mountain") return (["mountain", "rock"].includes(terrain) ? 2.5 : 0) + (elevation > data.seaLevel + 900 ? 1.1 : 0);
  if (archetype === "nomadic") return (["grassland", "plain", "rock", "desert"].includes(terrain) ? 1.8 : -0.4) + (precipitation < 650 ? 0.9 : 0);
  return (["farmland", "plain", "grassland", "forest"].includes(terrain) ? 1.6 : 0) + (riverMask[index] ? 0.8 : 0);
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
        score: candidate.baseScore + archetypePreference(data, riverMask, candidate.index, archetypes[country] ?? "agrarian"),
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

function chooseMorphologySeeds(
  data: GeneratedMapData,
  map: MapData,
  countryIds: string[],
  archetypes: CountryArchetype[],
  capitals: number[],
  voronoiOwner: Int16Array,
  candidates: SettlementCandidate[],
  riverMask: Uint8Array,
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
        return {...candidate,score:candidate.baseScore+archetypePreference(data,riverMask,candidate.index,archetypes[country]??"agrarian")+spread+diversity};
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

function expansionStepCost(
  data: GeneratedMapData,
  current: number,
  next: number,
  owner: number,
  archetype: CountryArchetype,
  riverMask: Uint8Array,
  voronoiOwner: Int16Array,
  diagonal: boolean,
): number {
  const settings = data.settings;
  const currentLand = cellIsLand(data, current);
  const nextLand = cellIsLand(data, next);
  const base = diagonal ? Math.SQRT2 : 1;
  if (!nextLand) {
    const seaTravel = archetype === "maritime" ? 2.2 : archetype === "nomadic" ? 5.2 : 4.3;
    return base + seaTravel + (currentLand ? 1.2 : 0);
  }

  const elevationRange = Math.max(1, settings.maxElevation - data.seaLevel);
  const normalizedElevation = Math.max(0, data.elevationMap[next] - data.seaLevel) / elevationRange;
  const slope = Math.abs(data.elevationMap[next] - data.elevationMap[current]) / Math.max(200, settings.maxElevation);
  let barrier = normalizedElevation * (1.2 + settings.naturalBorderInfluence * 5.5);
  barrier += slope * (3 + settings.naturalBorderInfluence * 11);
  const terrain = data.terrainMap[next];
  if (["mountain", "snow"].includes(terrain)) barrier += (archetype === "mountain" ? 0.55 : 2.7) * settings.naturalBorderInfluence;
  if (["desert", "wetland"].includes(terrain)) barrier += (archetype === "nomadic" ? 0.45 : 1.35) * settings.naturalBorderInfluence;
  const riverOrder = data.riverOrderMap?.[next] ?? 0;
  if (riverMask[next] && !riverMask[current]) barrier += (archetype === "agrarian" ? 0.75 : 1.25) * (1 + riverOrder * 0.32) * (0.7 + settings.naturalBorderInfluence * 2.5);
  const currentBasin = data.basinMap?.[current] ?? -1;
  const nextBasin = data.basinMap?.[next] ?? -1;
  if (currentBasin >= 0 && nextBasin >= 0 && currentBasin !== nextBasin) barrier += 0.45 * settings.naturalBorderInfluence;
  if (!currentLand) barrier += 1.1;
  if (voronoiOwner[next] !== owner) barrier += 1.3 + settings.naturalBorderInfluence * 3.2;
  return base + barrier;
}

function convexHullCells(data: GeneratedMapData, seeds: number[], owner: number, voronoiOwner: Int16Array): number[] {
  const points=seeds.map(index=>({x:index%data.gridWidth,y:Math.floor(index/data.gridWidth)}));
  if(points.length<3)return [...new Set(seeds)];
  const sorted=[...points].sort((a,b)=>a.x-b.x||a.y-b.y);
  const cross=(o:{x:number;y:number},a:{x:number;y:number},b:{x:number;y:number})=>(a.x-o.x)*(b.y-o.y)-(a.y-o.y)*(b.x-o.x);
  const lower:{x:number;y:number}[]=[];for(const point of sorted){while(lower.length>=2&&cross(lower[lower.length-2],lower[lower.length-1],point)<=0)lower.pop();lower.push(point);}
  const upper:{x:number;y:number}[]=[];for(const point of [...sorted].reverse()){while(upper.length>=2&&cross(upper[upper.length-2],upper[upper.length-1],point)<=0)upper.pop();upper.push(point);}
  const hull=[...lower.slice(0,-1),...upper.slice(0,-1)];
  const minX=Math.max(0,Math.floor(Math.min(...hull.map(p=>p.x)))),maxX=Math.min(data.gridWidth-1,Math.ceil(Math.max(...hull.map(p=>p.x))));
  const minY=Math.max(0,Math.floor(Math.min(...hull.map(p=>p.y)))),maxY=Math.min(data.gridHeight-1,Math.ceil(Math.max(...hull.map(p=>p.y))));
  const inside=(x:number,y:number)=>{let hit=false;for(let i=0,j=hull.length-1;i<hull.length;j=i++){const a=hull[i],b=hull[j];if(((a.y>y)!==(b.y>y))&&x<(b.x-a.x)*(y-a.y)/Math.max(1e-9,b.y-a.y)+a.x)hit=!hit;}return hit;};
  const cells:number[]=[];
  for(let y=minY;y<=maxY;y+=1)for(let x=minX;x<=maxX;x+=1){const index=y*data.gridWidth+x;if(voronoiOwner[index]===owner&&inside(x+0.5,y+0.5))cells.push(index);}
  for(const seed of seeds)if(!cells.includes(seed))cells.push(seed);
  return cells;
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
): TerritoryGrowthResult {
  const total = data.gridWidth * data.gridHeight;
  const waveOwner = new Int16Array(total); waveOwner.fill(-1);
  const cost = new Float64Array(total); cost.fill(Number.POSITIVE_INFINITY);
  const settled = new Uint8Array(total);
  const heap = new RegionHeap();

  citySeeds.forEach((seeds, owner) => {
    for (const seed of new Set(seeds)) {
      if (seed < 0 || seed >= total || !cellIsLand(data, seed)) continue;
      if (0 < cost[seed] || (cost[seed] === 0 && owner < waveOwner[seed])) {
        waveOwner[seed] = owner;
        cost[seed] = 0;
        heap.push({ index: seed, owner, priority: 0 });
      }
    }
  });

  while (heap.length) {
    const current = heap.pop()!;
    if (
      settled[current.index] ||
      current.owner !== waveOwner[current.index] ||
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
      const candidate = current.priority + expansionStepCost(
        data,
        current.index,
        next,
        current.owner,
        archetypes[current.owner] ?? "agrarian",
        riverMask,
        voronoiOwner,
        dx !== 0 && dy !== 0,
      );
      if (
        candidate < cost[next] - 1e-9 ||
        (Math.abs(candidate - cost[next]) <= 1e-9 && current.owner < waveOwner[next])
      ) {
        cost[next] = candidate;
        waveOwner[next] = current.owner;
        heap.push({ index: next, owner: current.owner, priority: candidate });
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

function refillUnclaimedLand(
  data: GeneratedMapData,
  owner: Int16Array,
  archetypes: CountryArchetype[],
  voronoiOwner: Int16Array,
  riverMask: Uint8Array,
): Int16Array {
  const result = new Int16Array(owner.length);
  result.set(owner);
  const total = result.length;
  const cost = new Float64Array(total); cost.fill(Number.POSITIVE_INFINITY);
  const candidateOwner = new Int16Array(total); candidateOwner.fill(-1);
  const settled = new Uint8Array(total);
  const heap = new RegionHeap();

  for (let index = 0; index < total; index += 1) {
    if (!cellIsLand(data, index) || result[index] >= 0) continue;
    const x = index % data.gridWidth;
    const y = Math.floor(index / data.gridWidth);
    for (const [dx, dy] of EIGHT_DIRECTIONS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= data.gridWidth || ny >= data.gridHeight) continue;
      const neighbor = ny * data.gridWidth + nx;
      const neighborOwner = result[neighbor];
      if (neighborOwner < 0) continue;
      const step = expansionStepCost(data, neighbor, index, neighborOwner, archetypes[neighborOwner] ?? "agrarian", riverMask, voronoiOwner, dx !== 0 && dy !== 0);
      if (step < cost[index]) {
        cost[index] = step;
        candidateOwner[index] = neighborOwner;
        heap.push({ index, owner: neighborOwner, priority: step });
      }
    }
  }

  while (heap.length) {
    const current = heap.pop()!;
    if (settled[current.index] || result[current.index] >= 0 || current.owner !== candidateOwner[current.index] || Math.abs(current.priority - cost[current.index]) > 1e-9) continue;
    settled[current.index] = 1;
    result[current.index] = current.owner;
    const x = current.index % data.gridWidth;
    const y = Math.floor(current.index / data.gridWidth);
    for (const [dx, dy] of EIGHT_DIRECTIONS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= data.gridWidth || ny >= data.gridHeight) continue;
      const next = ny * data.gridWidth + nx;
      if (!cellIsLand(data, next) || result[next] >= 0 || settled[next]) continue;
      const candidate = current.priority + expansionStepCost(data, current.index, next, current.owner, archetypes[current.owner] ?? "agrarian", riverMask, voronoiOwner, dx !== 0 && dy !== 0);
      if (candidate < cost[next] - 1e-9 || (Math.abs(candidate - cost[next]) <= 1e-9 && current.owner < candidateOwner[next])) {
        cost[next] = candidate;
        candidateOwner[next] = current.owner;
        heap.push({ index: next, owner: current.owner, priority: candidate });
      }
    }
  }

  for (let index = 0; index < total; index += 1) {
    if (cellIsLand(data, index) && result[index] < 0) result[index] = voronoiOwner[index];
  }
  return result;
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
  const heap = new RegionHeap();
  citySeeds.forEach((seeds, owner) => {
    for (const seed of new Set(seeds)) {
      if (seed < 0 || seed >= total || !cellIsLand(data, seed)) continue;
      if (regrowCost[seed] > 0 || owner < regrowOwner[seed]) {
        regrowCost[seed] = 0;
        regrowOwner[seed] = owner;
        heap.push({ index: seed, owner, priority: 0 });
      }
    }
  });

  while (heap.length) {
    const current = heap.pop()!;
    if (
      settled[current.index] ||
      current.owner !== regrowOwner[current.index] ||
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
      if (!cellIsLand(data, next)) continue;
      if (settled[next] && regrowOwner[next] !== current.owner) continue;

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
        voronoiOwner,
        dx !== 0 && dy !== 0,
      ) + formerAffinity + cityDistancePenalty;
      if (
        candidate < regrowCost[next] - 1e-9 ||
        (Math.abs(candidate - regrowCost[next]) <= 1e-9 && current.owner < regrowOwner[next])
      ) {
        regrowCost[next] = candidate;
        regrowOwner[next] = current.owner;
        heap.push({ index: next, owner: current.owner, priority: candidate });
      }
    }
  }

  // 도시 파동이 도달하지 못한 육지는 영토로 만들지 않는다. 생성된 모든 영토가
  // 반드시 하나 이상의 도시에서 시작했다는 조건을 유지한다.
  for (let index = 0; index < total; index += 1)
    if (!cellIsLand(data, index)) regrowOwner[index] = -1;
  return regrowOwner;
}

function territoryComponents(data: GeneratedMapData, owner: Int16Array, country: number): number[][] {
  const visited = new Uint8Array(owner.length);
  const components: number[][] = [];
  const queue = new Int32Array(owner.length);
  for (let start = 0; start < owner.length; start += 1) {
    if (visited[start] || owner[start] !== country || !cellIsLand(data, start)) continue;
    let head = 0;
    let tail = 0;
    const component: number[] = [];
    queue[tail++] = start;
    visited[start] = 1;
    while (head < tail) {
      const index = queue[head++];
      component.push(index);
      const x = index % data.gridWidth;
      const y = Math.floor(index / data.gridWidth);
      for (const [dx, dy] of CARDINAL_DIRECTIONS) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= data.gridWidth || ny >= data.gridHeight) continue;
        const next = ny * data.gridWidth + nx;
        if (!visited[next] && owner[next] === country && cellIsLand(data, next)) {
          visited[next] = 1;
          queue[tail++] = next;
        }
      }
    }
    components.push(component);
  }
  return components.sort((a, b) => b.length - a.length).slice(0, 48);
}

function componentPolygon(data: GeneratedMapData, component: number[]): { polygon: Point[]; holes: Point[][] } {
  const mask = new Uint8Array(data.gridWidth * data.gridHeight);
  for (const index of component) mask[index] = 1;
  return traceMaskRings(mask, data.gridWidth, data.gridHeight, data);
}

function upsertGeneratedSettlements(
  map: MapData,
  source: GeneratedMapData,
  countries: MapData["factions"],
  citySeeds: number[][],
): { locations: MapData["locations"]; factions: MapData["factions"] } {
  const year = map.timeline.currentYear;
  const preserved = map.locations.filter((location) => !location.id.startsWith(GENERATED_SETTLEMENT_PREFIX));
  const visible = visibleLocations({ ...map, locations: preserved });
  const locations = [...preserved];
  const locationIds = new Map<string, string[]>();
  const claimedExistingIds = new Set<string>();
  const reusableExisting = visible.filter(({ state }) => ["capital", "city", "town"].includes(state.locationType));

  countries.forEach((country, countryIndex) => {
    const ids: string[] = [];
    citySeeds[countryIndex].forEach((seed, slot) => {
      let point = pointFromCell(source, seed % source.gridWidth, Math.floor(seed / source.gridWidth));
      const existing = reusableExisting
        .filter(({ location }) => !claimedExistingIds.has(location.id))
        .sort((a, b) => {
          const ownerPenaltyA = a.state.ownerFactionId === country.id ? 0 : 1;
          const ownerPenaltyB = b.state.ownerFactionId === country.id ? 0 : 1;
          if (ownerPenaltyA !== ownerPenaltyB) return ownerPenaltyA - ownerPenaltyB;
          return Math.hypot(a.state.position.x - point.x, a.state.position.y - point.y)
            - Math.hypot(b.state.position.x - point.x, b.state.position.y - point.y);
        })[0];
      const cellDistance = existing ? Math.hypot(existing.state.position.x - point.x, existing.state.position.y - point.y) : Number.POSITIVE_INFINITY;
      if (existing && cellDistance <= Math.max(source.worldWidth / source.gridWidth, source.worldHeight / source.gridHeight) * 5) {
        const existingIndex = locations.findIndex((location) => location.id === existing.location.id);
        if (existingIndex >= 0) {
          const locationType = slot === 0 ? "capital" : "city";
          locations[existingIndex] = {
            ...locations[existingIndex],
            states: locations[existingIndex].states.map((state) => isYearInRange(state, year)
              ? { ...state, value: { ...state.value, ownerFactionId: country.id, locationType } }
              : state),
          };
        }
        claimedExistingIds.add(existing.location.id);
        ids.push(existing.location.id);
        return;
      }
      const minimumSpacing = Math.max(2, Math.max(source.worldWidth / source.gridWidth, source.worldHeight / source.gridHeight) * 6);
      const occupiedPoints = locations.map((location) => getStateAtYear(location.states, year)?.position).filter((value): value is Point => Boolean(value));
      if (occupiedPoints.some((other) => Math.hypot(other.x - point.x, other.y - point.y) < minimumSpacing)) {
        const seedX = seed % source.gridWidth;
        const seedY = Math.floor(seed / source.gridWidth);
        let replacement: Point | null = null;
        for (let radius = 2; radius <= 18 && !replacement; radius += 1) {
          for (let oy = -radius; oy <= radius && !replacement; oy += 1) {
            for (let ox = -radius; ox <= radius; ox += 1) {
              if (Math.max(Math.abs(ox), Math.abs(oy)) !== radius) continue;
              const x = seedX + ox; const y = seedY + oy;
              if (x < 0 || y < 0 || x >= source.gridWidth || y >= source.gridHeight) continue;
              const candidateIndex = y * source.gridWidth + x;
              if (!cellIsLand(source, candidateIndex) || ["mountain", "snow"].includes(source.terrainMap[candidateIndex])) continue;
              const candidate = pointFromCell(source, x, y);
              if (occupiedPoints.every((other) => Math.hypot(other.x - candidate.x, other.y - candidate.y) >= minimumSpacing)) { replacement = candidate; break; }
            }
          }
        }
        if (replacement) point = replacement;
      }
      const id = `${GENERATED_SETTLEMENT_PREFIX}${country.id}-${slot + 1}`;
      const locationType = slot === 0 ? "capital" : "city";
      locations.push({
        id,
        states: [{
          startYear: year,
          endYear: null,
          value: {
            name: (CITY_NAME_SETS[countryIndex % CITY_NAME_SETS.length] ?? CITY_NAME_SETS[0])[slot] ?? `${country.name} 중심지`,
            locationType,
            position: point,
            population: slot === 0 ? 72_000 : 24_000 + slot * 6_000,
            economy: slot === 0 ? 72 : 38 + slot * 6,
            ownerFactionId: country.id,
            status: "active",
            description: "국가 영토의 모폴로지 팽창 종자점으로 자동 배치된 핵심 도시",
          },
        }],
      });
      ids.push(id);
    });
    locationIds.set(country.id, ids);
  });

  const countryIdSet = new Set(countries.map((country) => country.id));
  const factions = map.factions.map((faction) => {
    if (!countryIdSet.has(faction.id)) return faction;
    const ids = locationIds.get(faction.id) ?? [];
    return {
      ...faction,
      hasTerritory: true,
      countryProfile: {
        nameRoot: faction.countryProfile?.nameRoot ?? faction.name,
        showRegimeSuffix: faction.countryProfile?.showRegimeSuffix ?? true,
        spaceBeforeRegimeSuffix: faction.countryProfile?.spaceBeforeRegimeSuffix ?? true,
        politicalSystem: "",
        symbol: "",
        languageArticleIds: [],
        cultureArticleIds: [],
        ...faction.countryProfile,
        capitalLocationId: ids[0],
        majorLocationIds: ids,
      },
    };
  });
  return { locations, factions };
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


function curveRoadNodes(data: GeneratedMapData, nodes: Point[]): Point[] {
  if (nodes.length < 3) return nodes;
  const cell = Math.max(data.worldWidth / data.gridWidth, data.worldHeight / data.gridHeight);
  const cleaned = removeRoadBacktracking(nodes);
  const constrained = limitPathCurvature(simplifyRoadNodes(cleaned), 32, 8);
  const curved = limitPathCurvature(smoothPath(constrained, { spacing: cell * 0.65, samplesPerSegment: 6, iterations: 2 }), 26, 4);
  const elevationRange = Math.max(300, data.settings.maxElevation - data.seaLevel);
  for (const point of curved) {
    const index = gridIndex(data, point);
    if (!cellIsLand(data, index)) return limitPathCurvature(simplifyRoadNodes(cleaned), 32, 10);
    const normalized = Math.max(0, data.elevationMap[index] - data.seaLevel) / elevationRange;
    if (normalized > 0.94) return limitPathCurvature(simplifyRoadNodes(cleaned), 32, 10);
  }
  return curved;
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

function generateProceduralRoads(map: MapData, data: GeneratedMapData): Road[] {
  const preserved = map.roads.filter((road) => !road.id.startsWith(GENERATED_ROAD_PREFIX));
  const random = mulberry32((data.settings.seed ^ 0x48a7f31d) >>> 0);
  const year = map.timeline.currentYear;
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
      false,
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
    const road: Road = { id: `${GENERATED_ROAD_PREFIX}${generated.length + 1}`, name: label, startYear: year, endYear: null, nodes, roadType: effectiveType, description: "굵은 간선망에서 단계적으로 파생되며 기존 회랑과 교차로를 공유하도록 자동 생성된 곡선 도로" };
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
  return [...preserved, ...generated];
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

/** 도시 형성 뒤 평원·초원 중 수계와 토양 조건이 좋은 곳만 농경지로 전환한다. */
function cultivateFarmlandAroundSettlements(data: GeneratedMapData, map: MapData): GeneratedMapData {
  const settlements = visibleLocations(map).filter(({ state }) => ["capital", "city", "town", "village"].includes(state.locationType));
  if (!settlements.length) return refreshSurfaceRegions({ ...data, terrainMap: data.terrainMap.map((terrain) => terrain === "farmland" ? "plain" : terrain) });
  const terrainMap: TerrainType[] = data.terrainMap.map((terrain): TerrainType => terrain === "farmland" ? "plain" : terrain);
  const score = new Float32Array(terrainMap.length);
  const waterDistance = waterDistanceCells(data);
  const physicalHeightKm = data.settings.mapScaleKm * data.worldHeight / Math.max(1e-9, data.worldWidth);
  const cellKmX = data.settings.mapScaleKm / data.gridWidth;
  const cellKmY = physicalHeightKm / data.gridHeight;
  const meanCellKm = Math.max(0.05, (cellKmX + cellKmY) * 0.5);
  const arid = String(data.settings.climatePreset).startsWith("B") || data.settings.basePrecipitationMm < 520;

  for (const { state } of settlements) {
    const center = gridCoordinates(data, state.position);
    const population = Math.max(500, state.population ?? (state.locationType === "village" ? 1800 : state.locationType === "town" ? 9000 : 35_000));
    const baseRadius = state.locationType === "capital" ? 62 : state.locationType === "city" ? 48 : state.locationType === "town" ? 31 : 18;
    const radiusKm = baseRadius * Math.max(0.78, Math.min(1.65, Math.pow(population / 18_000, 0.16)));
    const radiusX = Math.ceil(radiusKm / cellKmX);
    const radiusY = Math.ceil(radiusKm / cellKmY);
    const coreKm = state.locationType === "capital" || state.locationType === "city" ? 2.4 : 1.2;
    for (let y = Math.max(1, center.y - radiusY); y <= Math.min(data.gridHeight - 2, center.y + radiusY); y += 1) {
      for (let x = Math.max(1, center.x - radiusX); x <= Math.min(data.gridWidth - 2, center.x + radiusX); x += 1) {
        const index = y * data.gridWidth + x;
        if (data.waterTypeMap[index] !== "land" || (terrainMap[index] !== "plain" && terrainMap[index] !== "grassland")) continue;
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
        const floodPenalty = riverKm < 0.7 ? 0.18 : riverKm < 1.5 ? 0.58 : 1;
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
        const suitability = cityFactor * 0.38 + riverFactor * waterWeight + slopeFactor * 0.2 + climateFactor * 0.16;
        score[index] = Math.max(score[index], suitability * floodPenalty * drainage);
      }
    }
  }

  for (let index = 0; index < terrainMap.length; index += 1) {
    if (score[index] <= 0 || (terrainMap[index] !== "plain" && terrainMap[index] !== "grassland")) continue;
    const chance = Math.max(0, Math.min(0.78, (score[index] - 0.64) * 0.72));
    if (deterministicPlacementRandom(index, data.settings.seed + 0x45f13) < chance) terrainMap[index] = "farmland";
  }
  // 무작위 점처럼 보이지 않도록 강을 따라 이어진 농경지 패치를 성장시키고 고립 셀을 제거한다.
  for (let pass = 0; pass < 2; pass += 1) {
    const source = [...terrainMap];
    for (let y = 1; y < data.gridHeight - 1; y += 1) for (let x = 1; x < data.gridWidth - 1; x += 1) {
      const index = y * data.gridWidth + x;
      if (!["plain", "grassland", "farmland"].includes(source[index])) continue;
      let neighbors = 0;
      for (let oy = -1; oy <= 1; oy += 1) for (let ox = -1; ox <= 1; ox += 1) if ((ox || oy) && source[(y + oy) * data.gridWidth + x + ox] === "farmland") neighbors += 1;
      if (source[index] === "farmland" && neighbors <= 1) terrainMap[index] = "plain";
      else if (source[index] !== "farmland" && neighbors >= 3 && score[index] > 0.68 && deterministicPlacementRandom(index, data.settings.seed + pass * 997) < 0.48) terrainMap[index] = "farmland";
    }
  }
  return refreshSurfaceRegions({ ...data, terrainMap, snowBaseTerrainMap: data.snowBaseTerrainMap.map((terrain, index) => terrainMap[index] === "farmland" ? "farmland" : terrain) }, "final");
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
  if (!settings.generateCountries || settings.countryCount <= 0) return { map, generated: cultivateFarmlandAroundSettlements(outputSource, map) };

  const targetCount = Math.max(1, Math.min(12, Math.round(settings.countryCount)));
  let factions = [...map.factions];
  let countries = factions.filter((faction) => faction.kind === "country");
  const archetypes = makeCountryArchetypes(targetCount, source);
  const archetypeLabels: Record<CountryArchetype, string> = { maritime: "해양형", mountain: "산악형", nomadic: "유목형", agrarian: "농업형" };
  for (let index = countries.length; index < targetCount; index += 1) {
    const id = `${GENERATED_COUNTRY_PREFIX}${index + 1}`;
    const archetype = archetypes[index] ?? "agrarian";
    factions.push({
      id,
      kind: "country",
      name: GENERATED_COUNTRY_NAMES[index % GENERATED_COUNTRY_NAMES.length],
      color: COUNTRY_COLORS[index % COUNTRY_COLORS.length],
      activityRange: archetype === "maritime" ? "sea_centered" : archetype === "nomadic" ? "land_only" : "land_centered",
      summary: `${archetypeLabels[archetype]} 성향 · 도시 핵에서 확장된 국가`,
      description: "",
      foundedYear: 0,
      hasTerritory: true,
      countryProfile: { nameRoot: GENERATED_COUNTRY_NAMES[index % GENERATED_COUNTRY_NAMES.length].replace(/ (왕국|연방|공국|초원국|상업동맹|산악국|공화국|술탄국|왕령|연합|제국)$/, ""), showRegimeSuffix: true, spaceBeforeRegimeSuffix: true, politicalSystem: "", symbol: "", languageArticleIds: [], cultureArticleIds: [], majorLocationIds: [] },
    });
  }
  countries = factions.filter((faction) => faction.kind === "country").slice(0, targetCount);
  const countryArchetypes = countries.map((country, index) => country.activityRange === "sea_centered" || country.activityRange === "sea_only"
    ? "maritime"
    : country.summary.includes("산악형")
      ? "mountain"
      : country.summary.includes("유목형")
        ? "nomadic"
        : archetypes[index] ?? "agrarian");

  const riverMask = riverCellMask(source);
  const candidates = settlementCandidates(source, riverMask);
  if (candidates.length === 0) return { map: { ...map, factions }, generated: outputSource };
  const capitals = chooseCapitalSeeds(source, map, countries.map((country) => country.id), countryArchetypes, candidates, riverMask);
  const voronoiOwner = capitalVoronoi(source, capitals);
  const citySeeds = chooseMorphologySeeds(source, map, countries.map((country) => country.id), countryArchetypes, capitals, voronoiOwner, candidates, riverMask);
  const initialGrowth = growTerritories(source, citySeeds, countryArchetypes, voronoiOwner, riverMask);
  let owner = fullyErodeAndRegrowTerritories(
    source,
    initialGrowth.owner,
    initialGrowth.cityCost,
    citySeeds,
    countryArchetypes,
    voronoiOwner,
    riverMask,
  );
  // 사용자가 만든 기존 영토 셀은 자동 국가가 점유하지 못한다.
  const existingTerritories = map.territories.filter((territory) => !territory.id.startsWith(GENERATED_TERRITORY_PREFIX));
  const cellW = source.worldWidth / source.gridWidth; const cellH = source.worldHeight / source.gridHeight;
  for (let y = 0; y < source.gridHeight; y += 1) for (let x = 0; x < source.gridWidth; x += 1) {
    const index = y * source.gridWidth + x;
    if (!cellIsLand(source, index)) { owner[index] = -1; continue; }
    const point = { x: (x + 0.5) * cellW, y: (y + 0.5) * cellH };
    if (existingTerritories.some((territory) => { const state = getStateAtYear(territory.states, map.timeline.currentYear); return Boolean(state && pointInPolygon(point, state.polygon) && !(state.holes ?? []).some((hole) => pointInPolygon(point, hole))); })) owner[index] = -1;
  }

  const settlements = upsertGeneratedSettlements({ ...map, factions }, source, countries, citySeeds);
  factions = settlements.factions;
  const roads = (source.settings.mapScope === "continent" || source.settings.mapScope === "world")
    ? map.roads.filter((road) => !road.id.startsWith(GENERATED_ROAD_PREFIX))
    : generateProceduralRoads({ ...map, factions, locations: settlements.locations }, source);
  countries = factions.filter((faction) => faction.kind === "country").slice(0, targetCount);
  const territories = map.territories.filter((territory) => !territory.id.startsWith(GENERATED_TERRITORY_PREFIX));
  const generatedTerritories: GeneratedMapData["generatedTerritories"] = [];
  const year = map.timeline.currentYear;

  for (let countryIndex = 0; countryIndex < countries.length; countryIndex += 1) {
    const components = territoryComponents(source, owner, countryIndex);
    components.forEach((component, componentIndex) => {
      const rings = componentPolygon(source, component);
      const polygon = rings.polygon;
      const holes = rings.holes;
      if (polygon.length < 3) return;
      const seed = citySeeds[countryIndex].find((item) => component.includes(item)) ?? component[Math.floor(component.length / 2)];
      const center = pointFromCell(source, seed % source.gridWidth, Math.floor(seed / source.gridWidth));
      const coastal = component.some((index) => isCoastalCell(source, index % source.gridWidth, Math.floor(index / source.gridWidth)));
      const mountainAdapted = component.some((index) => ["mountain", "rock", "snow"].includes(source.terrainMap[index]));
      generatedTerritories.push({ index: countryIndex, name: countries[countryIndex].name, color: countries[countryIndex].color, center, polygon, holes, coastal, mountainAdapted });
      territories.push({
        id: `${GENERATED_TERRITORY_PREFIX}${countries[countryIndex].id}-${componentIndex + 1}`,
        name: componentIndex === 0 ? `${countries[countryIndex].name} 영토` : `${countries[countryIndex].name} 도서 영토 ${componentIndex}`,
        states: [{
          startYear: year,
          endYear: null,
          value: {
            ownerFactionId: countries[countryIndex].id,
            polygon,
            holes,
            description: componentIndex === 0
              ? "수도와 세 도시에서 시작한 경쟁적 모폴로지 팽창으로 생성된 본토"
              : "해상 팽창이 다른 육지에 도달해 형성된 도서 영토",
          },
        }],
      });
    });
  }

  const constrainedMap = enforceTerritoryConstraints({ ...map, factions, locations: settlements.locations, roads, territories }, source);
  const cultivatedSource = cultivateFarmlandAroundSettlements({ ...outputSource, generatedTerritories }, constrainedMap);
  // 배치 벡터는 LOD 환경장에서 이미 지형에 정렬되어 있으므로 고해상도 격자에서 A*를 반복하지 않는다.
  const alignedMap = alignMapFeaturesToGenerated(constrainedMap, cultivatedSource);
  const separatedMap = separateNearbyGeneratedSettlements(alignedMap, cultivatedSource);
  return {
    map: separatedMap,
    generated: cultivatedSource,
  };
}
