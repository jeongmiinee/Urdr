import type {
  GeneratedRiverEdge,
  GeneratedRiverGraph,
  GeneratedRiverNode,
  GeneratedRiverNodeKind,
  GeneratedRiverSegment,
  GeneratorSettings,
  Point,
} from "../model/world";
import { CellMinHeap } from "../generator/cellMinHeap";
import { createGridTransform } from "../generator/gridTransform";
import { limitPathCurvature } from "../generator/pathSmoothing";
import type { HydrologyResult } from "../generator/hydrologyTypes";
import { createLakeAreaGenerationPlan } from "./lakeAreaCalibration";

const NEIGHBORS = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0], [1, 0],
  [-1, 1], [0, 1], [1, 1],
] as const;

const CARDINAL_NEIGHBORS = [
  [0, -1], [1, 0], [0, 1], [-1, 0],
] as const;

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.max(minimum, Math.min(maximum, value));

function quantile(values: number[], ratio: number): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.max(0, Math.min(ordered.length - 1, Math.floor((ordered.length - 1) * ratio)))] ?? 0;
}

type DrainageField = {
  filled: Float64Array;
  receiver: Int32Array;
  visitOrder: Int32Array;
};

/** Priority flood records one previously visited downstream parent for every land cell. */
function buildDrainageField(
  elevation: number[],
  width: number,
  height: number,
  seaLevel: number,
  oceanMask?: ArrayLike<number>,
): DrainageField {
  const filled = Float64Array.from(elevation);
  const receiver = new Int32Array(elevation.length);
  const visitOrder = new Int32Array(elevation.length);
  const visited = new Uint8Array(elevation.length);
  const heap = new CellMinHeap();
  receiver.fill(-1);
  visitOrder.fill(-1);
  let sequence = 0;

  const seed = (index: number) => {
    if (visited[index]) return;
    visited[index] = 1;
    visitOrder[index] = sequence++;
    heap.push({ index, priority: filled[index] });
  };
  for (let index = 0; index < elevation.length; index += 1) {
    const x = index % width;
    const y = Math.floor(index / width);
    if ((oceanMask ? Boolean(oceanMask[index]) : elevation[index] <= seaLevel) || x === 0 || y === 0 || x === width - 1 || y === height - 1)
      seed(index);
  }

  const epsilon = Math.max(1e-5, Math.max(1, Math.abs(seaLevel)) * 1e-9);
  while (heap.length > 0) {
    const current = heap.pop()!;
    const x = current.index % width;
    const y = Math.floor(current.index / width);
    for (const [dx, dy] of NEIGHBORS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const next = ny * width + nx;
      if (visited[next]) continue;
      visited[next] = 1;
      receiver[next] = current.index;
      visitOrder[next] = sequence++;
      filled[next] = (oceanMask ? Boolean(oceanMask[next]) : elevation[next] <= seaLevel)
        ? elevation[next]
        : Math.max(elevation[next], current.priority + epsilon);
      heap.push({ index: next, priority: filled[next] });
    }
  }
  return { filled, receiver, visitOrder };
}

type LakeFields = {
  freshwaterLakeMap: Uint8Array;
  lakeIdMap: Int32Array;
  lakeSurfaceElevations: number[];
};

function lakeCellNoise(index: number, width: number, seed: number): number {
  const x = index % width;
  const y = Math.floor(index / width);
  let hash = Math.imul(x + 1, 374761393) ^ Math.imul(y + 1, 668265263) ^ Math.imul(seed + 1, 1274126177);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 1274126177);
  return ((hash ^ (hash >>> 16)) >>> 0) / 4294967295;
}

function smoothStep(value: number): number {
  return value * value * (3 - 2 * value);
}

function coherentLakeNoise(index: number, width: number, seed: number, wavelength: number): number {
  const x = (index % width) / wavelength;
  const y = Math.floor(index / width) / wavelength;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = smoothStep(x - x0);
  const ty = smoothStep(y - y0);
  const sample = (sx: number, sy: number) => lakeCellNoise(sy * width + sx, width, seed);
  const north = sample(x0, y0) * (1 - tx) + sample(x0 + 1, y0) * tx;
  const south = sample(x0, y0 + 1) * (1 - tx) + sample(x0 + 1, y0 + 1) * tx;
  return north * (1 - ty) + south * ty;
}

/** Selects one connected, compact lake core instead of truncating DFS order. */
function compactLakeCells(
  component: number[],
  maximumCells: number,
  elevation: number[],
  drainage: DrainageField,
  width: number,
  height: number,
  seed: number,
): number[] {
  if (component.length <= maximumCells) return component;
  const member = new Uint8Array(elevation.length);
  const queued = new Uint8Array(elevation.length);
  const distance = new Int32Array(elevation.length);
  let deepest = component[0];
  let maximumDepth = 0;
  for (const index of component) {
    member[index] = 1;
    const depth = Math.max(0, drainage.filled[index] - elevation[index]);
    if (depth > maximumDepth) { maximumDepth = depth; deepest = index; }
  }

  const heap = new CellMinHeap();
  const wavelength = 3.5 + lakeCellNoise(deepest, width, seed + 311) * 8.5;
  const noiseAmplitude = 1.15 + lakeCellNoise(deepest, width, seed + 719) * 2.35;
  queued[deepest] = 1;
  heap.push({ index: deepest, priority: 0 });
  const selected: number[] = [];
  while (heap.length > 0 && selected.length < maximumCells) {
    const current = heap.pop()!;
    selected.push(current.index);
    const x = current.index % width;
    const y = Math.floor(current.index / width);
    for (const [dx, dy] of CARDINAL_NEIGHBORS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const next = ny * width + nx;
      if (!member[next] || queued[next]) continue;
      queued[next] = 1;
      distance[next] = distance[current.index] + 1;
      const depthRatio = maximumDepth > 0
        ? Math.max(0, drainage.filled[next] - elevation[next]) / maximumDepth
        : 0;
      const coherent = coherentLakeNoise(next, width, seed, wavelength) * 0.72
        + coherentLakeNoise(next, width, seed + 1543, wavelength * 0.47) * 0.22
        + lakeCellNoise(next, width, seed + 2909) * 0.06;
      const irregularity = (coherent - 0.5) * noiseAmplitude;
      heap.push({ index: next, priority: distance[next] + irregularity - depthRatio * 1.4 });
    }
  }
  return selected;
}

/** Turns significant priority-flood depressions into flat, explicitly identified lakes. */
function identifyLakes(
  elevation: number[],
  runoffMap: number[],
  drainage: DrainageField,
  width: number,
  height: number,
  seaLevel: number,
  settings: GeneratorSettings,
  oceanMask?: ArrayLike<number>,
): LakeFields {
  const freshwaterLakeMap = new Uint8Array(elevation.length);
  const lakeIdMap = new Int32Array(elevation.length);
  const lakeSurfaceElevations: number[] = [];
  const visited = new Uint8Array(elevation.length);
  lakeIdMap.fill(-1);
  const depressionThreshold = Math.max(2, settings.contourInterval * 0.025);
  const candidates = new Uint8Array(elevation.length);
  let inlandCellCount = 0;
  for (let index = 0; index < elevation.length; index += 1)
    if (!(oceanMask ? Boolean(oceanMask[index]) : elevation[index] <= seaLevel)) {
      inlandCellCount += 1;
      if (drainage.filled[index] - elevation[index] >= depressionThreshold)
        candidates[index] = 1;
    }

  const areaPlan = createLakeAreaGenerationPlan(
    settings,
    width,
    height,
    inlandCellCount,
  );

  const components: Array<{ cells: number[]; score: number; surface: number }> = [];
  for (let start = 0; start < candidates.length; start += 1) {
    if (!candidates[start] || visited[start]) continue;
    const queue = [start];
    const cells: number[] = [];
    visited[start] = 1;
    let touchesFrame = false;
    let runoff = 0;
    while (queue.length > 0) {
      const index = queue.pop()!;
      cells.push(index);
      runoff += Math.max(0, runoffMap[index] ?? 0);
      const x = index % width;
      const y = Math.floor(index / width);
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touchesFrame = true;
      for (const [dx, dy] of CARDINAL_NEIGHBORS) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const next = ny * width + nx;
        if (!candidates[next] || visited[next]) continue;
        visited[next] = 1;
        queue.push(next);
      }
    }
    const minimumCells = areaPlan.minimumLakeCells;
    const xs = cells.map((index) => index % width);
    const ys = cells.map((index) => Math.floor(index / width));
    const boundsWidth = Math.max(...xs) - Math.min(...xs) + 1;
    const boundsHeight = Math.max(...ys) - Math.min(...ys) + 1;
    const minimumSpan = Math.min(boundsWidth, boundsHeight);
    const maximumSpan = Math.max(boundsWidth, boundsHeight);
    const compactness = cells.length / Math.max(1, boundsWidth * boundsHeight);
    const stripeLike = minimumSpan < 2 || (minimumSpan < 3 && maximumSpan / minimumSpan > 8) || compactness < 0.12;
    if (touchesFrame || cells.length < minimumCells || stripeLike) continue;
    const surface = Math.max(
      seaLevel + 1,
      Math.round(quantile(cells.map((index) => drainage.filled[index]), 0.88)),
    );
    components.push({ cells, score: runoff * Math.sqrt(cells.length), surface });
  }

  let acceptedCells = 0;
  for (const [componentIndex, component] of components.sort((a, b) => b.score - a.score).entries()) {
    if (
      lakeSurfaceElevations.length >= areaPlan.maximumLakeCount
      || acceptedCells >= areaPlan.maximumTotalLakeCells
    ) break;
    const remainingCells = Math.max(0, areaPlan.maximumTotalLakeCells - acceptedCells);
    const targetCells = areaPlan.targetLakeCells[lakeSurfaceElevations.length] ?? 0;
    const componentBudget = Math.min(remainingCells, targetCells, component.cells.length);
    if (componentBudget < areaPlan.minimumLakeCells) continue;
    const cells = compactLakeCells(
      component.cells,
      componentBudget,
      elevation,
      drainage,
      width,
      height,
      settings.seed + componentIndex * 1009,
    );
    if (cells.length < areaPlan.minimumLakeCells) continue;
    const lakeId = lakeSurfaceElevations.length;
    lakeSurfaceElevations.push(component.surface);
    const bedDepth = Math.max(2, Math.min(48, settings.contourInterval * 0.14));
    for (const index of cells) {
      freshwaterLakeMap[index] = 1;
      lakeIdMap[index] = lakeId;
      elevation[index] = Math.min(elevation[index], component.surface - bedDepth);
    }
    acceptedCells += cells.length;
  }
  return { freshwaterLakeMap, lakeIdMap, lakeSurfaceElevations };
}

function computeBasins(
  land: Uint8Array,
  receiver: Int32Array,
): Int32Array {
  const basinMap = new Int32Array(land.length);
  const outletCache = new Int32Array(land.length);
  basinMap.fill(-1);
  outletCache.fill(-2);
  const basinByOutlet = new Map<number, number>();
  for (let start = 0; start < land.length; start += 1) {
    if (!land[start]) continue;
    const path: number[] = [];
    let current = start;
    while (current >= 0 && land[current] && outletCache[current] === -2) {
      path.push(current);
      current = receiver[current];
    }
    const outlet = current >= 0 && outletCache[current] >= -1 ? outletCache[current] : current;
    for (const cell of path) outletCache[cell] = outlet;
    if (!basinByOutlet.has(outlet)) basinByOutlet.set(outlet, basinByOutlet.size);
    const basin = basinByOutlet.get(outlet)!;
    for (const cell of path) basinMap[cell] = basin;
  }
  return basinMap;
}

type FlowLink = {
  target: number;
  lakeId: number;
  lakeCell?: number;
  inletPoint?: Point;
  mouthPoint?: Point;
};

function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5 };
}

function smoothCenterline(points: Point[]): Point[] {
  if (points.length < 3) return points;
  let current = points;
  for (let pass = 0; pass < 3; pass += 1) {
    const next: Point[] = [current[0]];
    for (let index = 1; index < current.length; index += 1) {
      const start = current[index - 1];
      const end = current[index];
      next.push(
        { x: start.x * 0.75 + end.x * 0.25, y: start.y * 0.75 + end.y * 0.25 },
        { x: start.x * 0.25 + end.x * 0.75, y: start.y * 0.25 + end.y * 0.75 },
      );
    }
    next.push(current[current.length - 1]);
    current = next;
  }
  return current;
}

function hashUnit(seed: number): number {
  let value = seed | 0;
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  return ((value ^ (value >>> 16)) >>> 0) / 0xffffffff;
}

function resampleCenterline(points: Point[], spacing: number): Point[] {
  if (points.length < 2) return points;
  const cumulative = [0];
  for (let index = 1; index < points.length; index += 1)
    cumulative.push(cumulative[index - 1] + Math.hypot(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y));
  const total = cumulative[cumulative.length - 1];
  if (total <= spacing) return [{ ...points[0] }, { ...points[points.length - 1] }];
  const samples = Math.max(2, Math.ceil(total / Math.max(1e-9, spacing)));
  const result: Point[] = [];
  let segment = 1;
  for (let sample = 0; sample <= samples; sample += 1) {
    const distance = total * sample / samples;
    while (segment < cumulative.length - 1 && cumulative[segment] < distance) segment += 1;
    const startDistance = cumulative[segment - 1];
    const endDistance = cumulative[segment];
    const ratio = endDistance <= startDistance ? 0 : (distance - startDistance) / (endDistance - startDistance);
    const start = points[segment - 1];
    const end = points[segment];
    result.push({ x: start.x + (end.x - start.x) * ratio, y: start.y + (end.y - start.y) * ratio });
  }
  result[0] = { ...points[0] };
  result[result.length - 1] = { ...points[points.length - 1] };
  return result;
}

function segmentsCross(a: Point, b: Point, c: Point, d: Point): boolean {
  const turn = (p: Point, q: Point, r: Point) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  return turn(a, b, c) * turn(a, b, d) < -1e-10 && turn(c, d, a) * turn(c, d, b) < -1e-10;
}

function centerlineSelfIntersects(points: Point[]): boolean {
  for (let first = 1; first < points.length; first += 1)
    for (let second = first + 2; second < points.length; second += 1) {
      if (first === 1 && second === points.length - 1) continue;
      if (segmentsCross(points[first - 1], points[first], points[second - 1], points[second])) return true;
    }
  return false;
}

/** Adds deterministic lowland sinuosity while keeping every sample in its drainage corridor. */
function naturalCenterline(
  points: Point[],
  sourceCell: number,
  targetCell: number,
  order: number,
  discharge: number,
  elevation: number[],
  originalLand: Uint8Array,
  lakeMap: Uint8Array,
  width: number,
  height: number,
  worldWidth: number,
  worldHeight: number,
  seed: number,
): Point[] {
  const smoothed = smoothCenterline(points);
  if (smoothed.length < 3) return smoothed;
  const transform = createGridTransform(worldWidth, worldHeight, width, height);
  const cellSize = Math.min(transform.cellSizeX, transform.cellSizeY);
  const source = resampleCenterline(smoothed, cellSize * 0.58);
  if (source.length < 4) return source;
  const sourceElevation = elevation[sourceCell] ?? 0;
  const targetElevation = elevation[targetCell] ?? sourceElevation;
  const relief = Math.max(0, sourceElevation - targetElevation);
  const lengthCells = source.reduce((sum, point, index) => index === 0 ? 0 : sum + Math.hypot(point.x - source[index - 1].x, point.y - source[index - 1].y) / Math.max(1e-9, cellSize), 0);
  const averageDrop = relief / Math.max(1, lengthCells);
  const lowGradient = 1 - clamp(averageDrop / 42, 0, 1);
  const maturity = clamp(Math.log2(Math.max(1, order + 1)) / 3 + Math.log1p(Math.max(0, discharge)) / 28, 0, 1);
  const amplitude = cellSize * (0.06 + lowGradient * (0.2 + maturity * 0.24));
  const wavelength = cellSize * (5.5 + maturity * 8 + hashUnit(seed + sourceCell * 17 + targetCell * 31) * 4);
  const phase = hashUnit(seed ^ Math.imul(sourceCell + 1, 0x9e3779b1)) * Math.PI * 2;
  const phase2 = hashUnit(seed ^ Math.imul(targetCell + 7, 0x85ebca6b)) * Math.PI * 2;
  const result = source.map((point) => ({ ...point }));
  let traveled = 0;
  for (let index = 1; index < source.length - 1; index += 1) {
    const point = source[index];
    traveled += Math.hypot(source[index].x - source[index - 1].x, source[index].y - source[index - 1].y);
    const previous = source[index - 1];
    const next = source[index + 1];
    const dx = next.x - previous.x;
    const dy = next.y - previous.y;
    const length = Math.max(1e-9, Math.hypot(dx, dy));
    const progress = index / (source.length - 1);
    const taper = Math.pow(Math.sin(Math.PI * progress), 1.35);
    const wave = Math.sin(traveled / wavelength * Math.PI * 2 + phase)
      + Math.sin(traveled / wavelength * Math.PI * 0.86 + phase2) * 0.32;
    let offset = amplitude * taper * wave / 1.32;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = { x: point.x - dy / length * offset, y: point.y + dx / length * offset };
      if (candidate.x >= 0 && candidate.y >= 0 && candidate.x <= worldWidth && candidate.y <= worldHeight) {
        const cell = transform.worldToCell(candidate).index;
        if (originalLand[cell] && !lakeMap[cell]) {
          result[index] = candidate;
          break;
        }
      }
      offset *= 0.5;
    }
  }
  result[0] = { ...points[0] };
  result[result.length - 1] = { ...points[points.length - 1] };
  let relaxed = result;
  for (let pass = 0; pass < 8; pass += 1) {
    const next = relaxed.map((point) => ({ ...point }));
    for (let index = 1; index < relaxed.length - 1; index += 1) {
      const candidate = {
        x: relaxed[index - 1].x * 0.25 + relaxed[index].x * 0.5 + relaxed[index + 1].x * 0.25,
        y: relaxed[index - 1].y * 0.25 + relaxed[index].y * 0.5 + relaxed[index + 1].y * 0.25,
      };
      const cell = transform.worldToCell(candidate).index;
      if (originalLand[cell] && !lakeMap[cell]) next[index] = candidate;
    }
    relaxed = next;
  }
  relaxed[0] = { ...points[0] };
  relaxed[relaxed.length - 1] = { ...points[points.length - 1] };
  const nonIntersecting = centerlineSelfIntersects(relaxed) ? smoothed : relaxed;
  return limitPathCurvature(nonIntersecting, 24, 20);
}

function physicalRiverWidth(discharge: number): number {
  return clamp(2.2 + 8.4 * Math.pow(Math.max(0, discharge), 0.38), 2.5, 1_600);
}

export function buildHydrology(
  elevation: number[],
  runoffMap: number[],
  width: number,
  height: number,
  seaLevel: number,
  worldWidth: number,
  worldHeight: number,
  settings: GeneratorSettings,
  oceanMask?: ArrayLike<number>,
): HydrologyResult {
  const originalLand = Uint8Array.from(elevation, (value, index) =>
    oceanMask ? (oceanMask[index] ? 0 : 1) : (value > seaLevel ? 1 : 0));
  const drainage = buildDrainageField(elevation, width, height, seaLevel, oceanMask);
  const lakes = identifyLakes(elevation, runoffMap, drainage, width, height, seaLevel, settings, oceanMask);
  const receiver = Int32Array.from(drainage.receiver);
  for (let index = 0; index < receiver.length; index += 1)
    if (lakes.freshwaterLakeMap[index]) receiver[index] = -1;
  const basinMap = computeBasins(originalLand, receiver);
  const physicalWidthKm = Math.max(1, settings.mapScaleKm);
  const physicalHeightKm = physicalWidthKm * worldHeight / Math.max(1e-9, worldWidth);
  const cellAreaKm2 = physicalWidthKm * physicalHeightKm / Math.max(1, width * height);
  const accumulation = new Float64Array(elevation.length);
  for (let index = 0; index < accumulation.length; index += 1)
    if (originalLand[index]) accumulation[index] = Math.max(0.01, (runoffMap[index] ?? 0) / 1_000) * cellAreaKm2;
  const order = Array.from({ length: elevation.length }, (_value, index) => index)
    .filter((index) => originalLand[index])
    .sort((a, b) => drainage.visitOrder[b] - drainage.visitOrder[a]);
  for (const index of order) {
    const target = receiver[index];
    if (target >= 0) accumulation[target] += accumulation[index];
  }

  const landDischarge = order.map((index) => accumulation[index]).filter((value) => value > 0);
  const densityQuantile = settings.mapScope === "local" ? 0.91 : settings.mapScope === "regional" ? 0.93 : 0.95;
  const dischargeThreshold = Math.max(
    cellAreaKm2 * Math.max(0.05, quantile(runoffMap.filter((_value, index) => originalLand[index]), 0.5) / 1_000) * 3,
    quantile(landDischarge, densityQuantile),
  );
  const channel = new Uint8Array(elevation.length);
  for (const index of order)
    if (!lakes.freshwaterLakeMap[index] && accumulation[index] >= dischargeThreshold)
      channel[index] = 1;

  const transform = createGridTransform(worldWidth, worldHeight, width, height);
  const pointOf = (index: number) => transform.cellCenterToWorld(index % width, Math.floor(index / width));
  const boundaryMouthPoint = (index: number): Point => {
    const point = pointOf(index);
    const candidates: Array<{ distance: number; point: Point }> = [
      { distance: point.x, point: { x: 0, y: point.y } },
      { distance: worldWidth - point.x, point: { x: worldWidth, y: point.y } },
      { distance: point.y, point: { x: point.x, y: 0 } },
      { distance: worldHeight - point.y, point: { x: point.x, y: worldHeight } },
    ];
    return candidates.reduce((nearest, candidate) => candidate.distance < nearest.distance ? candidate : nearest).point;
  };
  const flowLink = (start: number): FlowLink => {
    let current = receiver[start];
    let previous = start;
    for (let guard = 0; guard <= elevation.length && current >= 0; guard += 1) {
      if (!originalLand[current])
        return { target: -1, lakeId: -1, mouthPoint: midpoint(pointOf(previous), pointOf(current)) };
      const currentLake = lakes.lakeIdMap[current];
      if (currentLake >= 0)
        return { target: -1, lakeId: currentLake, lakeCell: current, inletPoint: midpoint(pointOf(previous), pointOf(current)) };
      if (channel[current]) return { target: current, lakeId: -1 };
      previous = current;
      current = receiver[current];
    }
    return { target: -1, lakeId: -1, mouthPoint: boundaryMouthPoint(previous) };
  };

  const links = new Map<number, FlowLink>();
  const incoming = new Int32Array(elevation.length);
  for (const index of order) {
    if (!channel[index]) continue;
    const link = flowLink(index);
    links.set(index, link);
    if (link.target >= 0) incoming[link.target] += 1;
  }

  const riverOrderMap = new Uint8Array(elevation.length);
  const riverMagnitudeMap = new Uint16Array(elevation.length);
  for (const index of order) {
    if (!channel[index]) continue;
    const upstream = NEIGHBORS.flatMap(([dx, dy]) => {
      const x = index % width + dx;
      const y = Math.floor(index / width) + dy;
      if (x < 0 || y < 0 || x >= width || y >= height) return [];
      const candidate = y * width + x;
      return channel[candidate] && links.get(candidate)?.target === index ? [candidate] : [];
    });
    if (upstream.length === 0) {
      riverOrderMap[index] = 1;
      riverMagnitudeMap[index] = 1;
    } else {
      const highestOrder = Math.max(...upstream.map((cell) => riverOrderMap[cell] || 1));
      const matching = upstream.filter((cell) => riverOrderMap[cell] === highestOrder).length;
      riverOrderMap[index] = highestOrder + (matching >= 2 ? 1 : 0);
      riverMagnitudeMap[index] = clamp(upstream.reduce((sum, cell) => sum + Math.max(1, riverMagnitudeMap[cell]), 0), 1, 65_535);
    }
  }

  const structural = new Set<number>();
  for (const [cell, link] of links) {
    if (incoming[cell] !== 1 || link.target < 0 || link.lakeId >= 0) structural.add(cell);
    if (link.target >= 0 && incoming[link.target] !== 1) structural.add(link.target);
  }

  const nodes: GeneratedRiverNode[] = [];
  const nodeByCell = new Map<number, number>();

  const nodeKind = (cell: number): GeneratedRiverNodeKind => {
    if (incoming[cell] >= 2) return "confluence";
    if (incoming[cell] === 0) return "source";
    return "outlet";
  };
  const addCellNode = (cell: number): number => {
    const existing = nodeByCell.get(cell);
    if (existing !== undefined) return existing;
    const id = nodes.length;
    nodes.push({
      id,
      kind: nodeKind(cell),
      point: pointOf(cell),
      cellIndex: cell,
      elevation: elevation[cell],
      discharge: accumulation[cell],
      catchmentId: basinMap[cell],
    });
    nodeByCell.set(cell, id);
    return id;
  };
  for (const cell of structural) addCellNode(cell);

  const edges: GeneratedRiverEdge[] = [];
  const addEdge = (
    sourceNodeId: number,
    targetNodeId: number,
    cells: number[],
    points: Point[],
    render: boolean,
    lakeId?: number,
  ) => {
    const uniquePoints = points.filter((point, index) => {
      if (index === 0) return true;
      const previous = points[index - 1];
      return Math.abs(point.x - previous.x) > 1e-10 || Math.abs(point.y - previous.y) > 1e-10;
    });
    if (uniquePoints.length < 2) return;
    const sourceCell = cells[0] ?? nodes[sourceNodeId].cellIndex;
    const targetCell = cells[cells.length - 1] ?? nodes[targetNodeId].cellIndex;
    const edgeOrder = Math.max(1, riverOrderMap[targetCell] || riverOrderMap[sourceCell]);
    const centerline = render
      ? naturalCenterline(
          uniquePoints,
          sourceCell,
          targetCell,
          edgeOrder,
          accumulation[targetCell] || accumulation[sourceCell],
          elevation,
          originalLand,
          lakes.freshwaterLakeMap,
          width,
          height,
          worldWidth,
          worldHeight,
          settings.seed + edges.length * 104_729,
        )
      : uniquePoints;
    const sampleCells = centerline.map((_point, index) =>
      cells[Math.min(cells.length - 1, Math.round(index / Math.max(1, centerline.length - 1) * Math.max(0, cells.length - 1)))] ?? targetCell,
    );
    const dischargeSamples = sampleCells.map((cell) => accumulation[cell] || accumulation[sourceCell]);
    edges.push({
      id: edges.length,
      sourceNodeId,
      targetNodeId,
      centerline,
      dischargeSamples,
      widthMeters: dischargeSamples.map(physicalRiverWidth),
      order: edgeOrder,
      magnitude: Math.max(1, riverMagnitudeMap[targetCell] || riverMagnitudeMap[sourceCell]),
      catchmentId: basinMap[sourceCell],
      render,
      ...(lakeId === undefined ? {} : { lakeId }),
    });
  };

  for (const start of structural) {
    const sourceNodeId = addCellNode(start);
    const cells = [start];
    const points = [nodes[sourceNodeId].point];
    let current = start;
    for (let guard = 0; guard <= elevation.length; guard += 1) {
      const link = links.get(current);
      if (!link) break;
      if (link.lakeId >= 0 && link.inletPoint) {
        const inletNodeId = nodes.length;
        const lakeCell = link.lakeCell ?? current;
        nodes.push({
          id: inletNodeId,
          kind: "lake-inlet",
          point: link.inletPoint,
          cellIndex: lakeCell,
          elevation: lakes.lakeSurfaceElevations[link.lakeId] ?? elevation[lakeCell],
          discharge: accumulation[current],
          catchmentId: basinMap[current],
          lakeId: link.lakeId,
        });
        addEdge(sourceNodeId, inletNodeId, [...cells, lakeCell], [...points, link.inletPoint], true, link.lakeId);
        break;
      }
      if (link.target < 0) {
        const mouthPoint = link.mouthPoint ?? pointOf(current);
        const mouthNodeId = nodes.length;
        nodes.push({
          id: mouthNodeId,
          kind: "mouth",
          point: mouthPoint,
          cellIndex: current,
          elevation: seaLevel,
          discharge: accumulation[current],
          catchmentId: basinMap[current],
        });
        addEdge(sourceNodeId, mouthNodeId, cells, [...points, mouthPoint], true);
        break;
      }
      current = link.target;
      cells.push(current);
      if (structural.has(current)) {
        const targetNodeId = addCellNode(current);
        addEdge(sourceNodeId, targetNodeId, cells, [...points, nodes[targetNodeId].point], true);
        break;
      }
      points.push(pointOf(current));
    }
  }

  const riverGraph: GeneratedRiverGraph = { version: 1, nodes, edges, dischargeThreshold };
  const mapUnitsPerMeter = worldWidth / Math.max(1, settings.mapScaleKm * 1_000);
  const rivers: GeneratedRiverSegment[] = [];
  for (const edge of edges) {
    if (!edge.render) continue;
    for (let index = 1; index < edge.centerline.length; index += 1) {
      const widthMeters = (edge.widthMeters[index - 1] + edge.widthMeters[index]) * 0.5;
      rivers.push({
        start: edge.centerline[index - 1],
        end: edge.centerline[index],
        flow: edge.dischargeSamples[index] ?? edge.dischargeSamples[index - 1] ?? 0,
        magnitude: edge.magnitude,
        width: Math.max(0.02, widthMeters * mapUnitsPerMeter),
        order: edge.order,
        basinId: edge.catchmentId,
        mouth: nodes[edge.targetNodeId]?.kind === "mouth" && index === edge.centerline.length - 1,
        riverId: edge.id,
        sequence: index - 1,
      });
    }
  }

  return {
    rivers,
    riverGraph,
    flowAccumulationMap: Array.from(accumulation),
    basinMap: Array.from(basinMap),
    riverOrderMap: Array.from(riverOrderMap),
    riverMagnitudeMap: Array.from(riverMagnitudeMap),
    freshwaterLakeMap: Array.from(lakes.freshwaterLakeMap),
    lakeIdMap: Array.from(lakes.lakeIdMap),
    lakeSurfaceElevations: lakes.lakeSurfaceElevations,
  };
}
