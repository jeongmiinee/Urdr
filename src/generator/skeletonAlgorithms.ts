import { Delaunay } from "d3-delaunay";
import type { GeneratorSettings, Point } from "../model/world";
import { fractalNoise, fractalPerlinNoise } from "./noise";
import { mulberry32 } from "./random";

const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value));

type SkeletonEdge = { a: Point; b: Point; width: number; weight: number };
type NegativeCut = { a: Point; b: Point; width: number; strength: number };
type SkeletonPlan = {
  continentCenters: Point[];
  cores: Point[];
  coreGroups: number[];
  edges: SkeletonEdge[];
  cuts: NegativeCut[];
  islandCores: Array<Point & { radius: number }>;
};

export type SkeletonDiagnostics = {
  repairPasses: number;
  circularity: number;
  aspectRatio: number;
  compactness: number;
  peninsulaCount: number;
  bayCount: number;
};

export type SkeletonResult = {
  raw: number[];
  centers: Point[];
  diagnostics: SkeletonDiagnostics;
};

function distanceToSegment(px: number, py: number, a: Point, b: Point): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const lengthSquared = abx * abx + aby * aby;
  if (lengthSquared <= 1e-9) return Math.hypot(px - a.x, py - a.y);
  const t = clamp(((px - a.x) * abx + (py - a.y) * aby) / lengthSquared);
  return Math.hypot(px - (a.x + abx * t), py - (a.y + aby * t));
}

function smoothGrid(values: number[], width: number, height: number, iterations: number, blend: number): number[] {
  let current = [...values];
  for (let pass = 0; pass < iterations; pass += 1) {
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

function independentContinentCount(settings: GeneratorSettings): number {
  if ((settings.mapScope === "local" || settings.mapScope === "regional")) return 1;
  if (["island", "volcanic_island", "closed", "continent", "supercontinent", "inland_sea"].includes(settings.mapShape)) return 1;
  return Math.max(1, Math.round(settings.continentCount));
}

function scatterContinentCenters(settings: GeneratorSettings, random: () => number): Point[] {
  const count = independentContinentCount(settings);
  if (count === 1) return [{ x: 0.48 + (random() - 0.5) * 0.12, y: 0.5 + (random() - 0.5) * 0.1 }];
  const aspect = 1.55;
  const columns = Math.max(2, Math.ceil(Math.sqrt(count * aspect)));
  const rows = Math.max(1, Math.ceil(count / columns));
  const slots = Array.from({ length: columns * rows }, (_, index) => index);
  for (let index = slots.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [slots[index], slots[swap]] = [slots[swap], slots[index]];
  }
  return slots.slice(0, count).map((slot) => ({
    x: clamp(((slot % columns) + 0.5 + (random() - 0.5) * 0.42) / columns, 0.09, 0.91),
    y: clamp((Math.floor(slot / columns) + 0.5 + (random() - 0.5) * 0.4) / rows, 0.11, 0.89),
  }));
}

function minimumSpanningEdges(points: Point[], indices: number[], widthScale: number, random: () => number): SkeletonEdge[] {
  if (indices.length < 2) return [];
  const connected = new Set<number>([indices[0]]);
  const edges: SkeletonEdge[] = [];
  while (connected.size < indices.length) {
    let bestA = -1;
    let bestB = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const a of connected) {
      for (const b of indices) {
        if (connected.has(b)) continue;
        const distance = Math.hypot((points[a].x - points[b].x) * 1.45, points[a].y - points[b].y);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestA = a;
          bestB = b;
        }
      }
    }
    if (bestA < 0 || bestB < 0) break;
    connected.add(bestB);
    edges.push({
      a: points[bestA],
      b: points[bestB],
      width: widthScale * (0.68 + random() * 0.72),
      weight: 0.76 + random() * 0.2,
    });
  }
  return edges;
}

function createSkeletonPlan(settings: GeneratorSettings, seedOffset = 0): SkeletonPlan {
  const random = mulberry32(settings.seed + seedOffset + 7_193_117);
  const continentCenters = scatterContinentCenters(settings, random);
  const cores: Point[] = [];
  const coreGroups: number[] = [];
  const edges: SkeletonEdge[] = [];
  const cuts: NegativeCut[] = [];
  const islandCores: Array<Point & { radius: number }> = [];

  continentCenters.forEach((center, group) => {
    const baseCount = settings.mapShape === "archipelago"
      ? 3 + Math.floor(random() * 3)
      : 4 + Math.floor(random() * (3 + Math.round(settings.continentDynamics * 3)));
    const coreCount = Math.max(3, Math.min(8, baseCount));
    const majorAngle = random() * Math.PI * 2;
    const spread = continentCenters.length > 1 ? 0.12 : 0.22 + settings.landRatio * 0.09;
    const groupIndices: number[] = [];
    for (let index = 0; index < coreCount; index += 1) {
      const t = coreCount === 1 ? 0 : index / (coreCount - 1) - 0.5;
      const branch = (random() - 0.5) * spread * 0.95;
      const along = t * spread * (1.45 + random() * 0.75);
      const point = {
        x: clamp(center.x + Math.cos(majorAngle) * along - Math.sin(majorAngle) * branch, 0.055, 0.945),
        y: clamp(center.y + Math.sin(majorAngle) * along * 0.72 + Math.cos(majorAngle) * branch * 0.72, 0.065, 0.935),
      };
      groupIndices.push(cores.length);
      cores.push(point);
      coreGroups.push(group);
    }
    const widthScale = settings.mapShape === "archipelago" ? 0.028 : 0.07 + settings.landRatio * 0.05;
    const mst = minimumSpanningEdges(cores, groupIndices, widthScale, random);
    edges.push(...mst);

    const extraRatio = settings.algorithm === "hybrid"
      ? settings.hybridExtraEdgeRatio
      : 0.1 + settings.continentDynamics * 0.2;
    const candidatePairs: Array<{ a: number; b: number; distance: number }> = [];
    for (let a = 0; a < groupIndices.length; a += 1) {
      for (let b = a + 1; b < groupIndices.length; b += 1) {
        const ia = groupIndices[a];
        const ib = groupIndices[b];
        if (mst.some((edge) => (edge.a === cores[ia] && edge.b === cores[ib]) || (edge.a === cores[ib] && edge.b === cores[ia]))) continue;
        candidatePairs.push({ a: ia, b: ib, distance: Math.hypot((cores[ia].x - cores[ib].x) * 1.45, cores[ia].y - cores[ib].y) });
      }
    }
    candidatePairs.sort((a, b) => a.distance - b.distance);
    const extraCount = Math.min(candidatePairs.length, Math.round(mst.length * extraRatio));
    for (const pair of candidatePairs.slice(0, extraCount)) {
      edges.push({ a: cores[pair.a], b: cores[pair.b], width: widthScale * (0.55 + random() * 0.45), weight: 0.62 + random() * 0.16 });
    }

    const bayCount = settings.mapShape === "inland_sea" ? 4 : 2 + Math.round(settings.coastlineDetail * 4);
    for (let index = 0; index < bayCount; index += 1) {
      const angle = random() * Math.PI * 2;
      const outerDistance = 0.22 + random() * 0.2;
      const innerDistance = 0.03 + random() * 0.11;
      cuts.push({
        a: { x: clamp(center.x + Math.cos(angle) * outerDistance, 0.01, 0.99), y: clamp(center.y + Math.sin(angle) * outerDistance * 0.72, 0.01, 0.99) },
        b: { x: clamp(center.x + Math.cos(angle) * innerDistance, 0.04, 0.96), y: clamp(center.y + Math.sin(angle) * innerDistance * 0.72, 0.04, 0.96) },
        width: 0.015 + random() * (0.018 + settings.coastlineDetail * 0.026),
        strength: 0.5 + random() * 0.45,
      });
    }

    const islandCount = settings.mapShape === "archipelago" ? 10 + Math.round(random() * 8) : 2 + Math.round(settings.coastlineDetail * 5);
    for (let index = 0; index < islandCount; index += 1) {
      const angle = random() * Math.PI * 2;
      const radius = 0.18 + random() * (settings.mapShape === "archipelago" ? 0.28 : 0.18);
      islandCores.push({
        x: clamp(center.x + Math.cos(angle) * radius, 0.025, 0.975),
        y: clamp(center.y + Math.sin(angle) * radius * 0.72, 0.025, 0.975),
        radius: settings.mapShape === "archipelago" ? 0.018 + random() * 0.04 : 0.012 + random() * 0.025,
      });
    }
  });

  return { continentCenters, cores, coreGroups, edges, cuts, islandCores };
}

function scaffoldValue(plan: SkeletonPlan, x: number, y: number, settings: GeneratorSettings): number {
  const aspect = Math.max(0.65, Math.min(2.4, settings.gridWidth / Math.max(1, settings.gridHeight)));
  let value = -1.3;
  const coreRadius = settings.mapShape === "archipelago" ? 0.05 : 0.12 + settings.landRatio * 0.08;
  for (let index = 0; index < plan.cores.length; index += 1) {
    const core = plan.cores[index];
    const angle = (index * 1.917 + settings.seed * 0.0001) % (Math.PI * 2);
    const dx = (x - core.x) * aspect;
    const dy = y - core.y;
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    const rx = coreRadius * (0.75 + ((index * 37) % 11) / 18);
    const ry = coreRadius * (0.52 + ((index * 19) % 13) / 24);
    const ex = (dx * cosine + dy * sine) / rx;
    const ey = (-dx * sine + dy * cosine) / ry;
    value = Math.max(value, 0.88 - Math.sqrt(ex * ex + ey * ey));
  }
  for (const edge of plan.edges) {
    const distance = distanceToSegment(x * aspect, y, { x: edge.a.x * aspect, y: edge.a.y }, { x: edge.b.x * aspect, y: edge.b.y });
    value = Math.max(value, edge.weight - distance / Math.max(0.006, edge.width));
  }
  for (const island of plan.islandCores) {
    const distance = Math.hypot((x - island.x) * aspect, y - island.y);
    value = Math.max(value, 0.36 - distance / Math.max(0.005, island.radius));
  }
  for (const cut of plan.cuts) {
    const distance = distanceToSegment(x * aspect, y, { x: cut.a.x * aspect, y: cut.a.y }, { x: cut.b.x * aspect, y: cut.b.y });
    value -= Math.max(0, 1 - distance / Math.max(0.006, cut.width)) * cut.strength;
  }
  const edgeDistance = Math.min(x, y, 1 - x, 1 - y);
  if ((settings.mapScope === "continent" || settings.mapScope === "world")) value -= Math.max(0, 0.045 - edgeDistance) * 10;
  if (settings.mapShape === "inland_sea") {
    const center = plan.continentCenters[0];
    const dx = (x - center.x) / 0.18;
    const dy = (y - center.y) / 0.13;
    value -= Math.exp(-(dx * dx + dy * dy) * 1.35) * 1.2;
  }
  return value;
}

function applyLocalRegionBias(raw: number[], width: number, height: number, settings: GeneratorSettings): number[] {
  if ((settings.mapScope !== "local" && settings.mapScope !== "regional")) return raw;
  const next = [...raw];
  const random = mulberry32(settings.seed + 93_101);
  const coastLeft = random() > 0.5;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const nx = x / Math.max(1, width - 1);
      const ny = y / Math.max(1, height - 1);
      if (settings.localRegionType === "coast") next[index] += (coastLeft ? nx : 1 - nx) * 1.1 - 0.45;
      else if (settings.localRegionType === "island") next[index] -= Math.hypot((nx - 0.5) / 0.46, (ny - 0.5) / 0.4) * 0.8;
      else if (settings.localRegionType === "mountain") next[index] += Math.exp(-Math.pow(ny - (0.28 + nx * 0.45), 2) / 0.018) * 0.45;
      else next[index] += 0.18;
    }
  }
  return next;
}

function createPerlinRaw(settings: GeneratorSettings, width: number, height: number, plan: SkeletonPlan): number[] {
  const raw = new Array<number>(width * height);
  const warp = 0.04 + settings.continentDynamics * 0.13;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const nx = x / Math.max(1, width - 1);
      const ny = y / Math.max(1, height - 1);
      const wx = nx + (fractalPerlinNoise(nx * 2.2, ny * 2.2, settings.seed + 101, 4, 0.55, 2.03) - 0.5) * warp;
      const wy = ny + (fractalPerlinNoise(nx * 2.45, ny * 2.45, settings.seed + 211, 4, 0.55, 2.07) - 0.5) * warp;
      const base = scaffoldValue(plan, wx, wy, settings);
      const broad = (fractalPerlinNoise(wx * 3.4, wy * 3.4, settings.seed + 701, 5, 0.55, 2.03) - 0.5) * (0.5 + settings.coastlineDetail * 0.38);
      const detail = (fractalNoise(wx * 12.5, wy * 12.5, settings.seed + 1709, 4, 0.5, 2.1) - 0.5) * (0.13 + settings.coastlineDetail * 0.27);
      raw[y * width + x] = base + (broad + detail) * settings.noiseStrength;
    }
  }
  return smoothGrid(raw, width, height, 1, 0.08);
}

function jitteredPoints(settings: GeneratorSettings, width: number, height: number, seedOffset: number, density = 1): Array<[number, number]> {
  const random = mulberry32(settings.seed + seedOffset);
  const target = Math.max(60, Math.round((width * height) / (190 / density)));
  const aspect = width / Math.max(1, height);
  const columns = Math.max(8, Math.round(Math.sqrt(target * aspect)));
  const rows = Math.max(6, Math.round(target / columns));
  const points: Array<[number, number]> = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      points.push([
        clamp((column + 0.5 + (random() - 0.5) * 0.76) / columns, 0.004, 0.996),
        clamp((row + 0.5 + (random() - 0.5) * 0.76) / rows, 0.004, 0.996),
      ]);
    }
  }
  return points;
}

function createVoronoiRaw(settings: GeneratorSettings, width: number, height: number, plan: SkeletonPlan): number[] {
  const points = jitteredPoints(settings, width, height, 4_701_991, 1);
  const delaunay = Delaunay.from(points);
  let values = points.map(([x, y], index) => scaffoldValue(plan, x, y, settings)
    + (fractalNoise(x * 5.4, y * 5.4, settings.seed + 1009, 4, 0.54, 2.03) - 0.5) * 0.34
    + Math.sin(index * 1.618) * 0.03);
  for (let pass = 0; pass < 4; pass += 1) {
    const next = [...values];
    for (let index = 0; index < values.length; index += 1) {
      const neighbors = Array.from(delaunay.neighbors(index)) as number[];
      if (!neighbors.length) continue;
      const average = neighbors.reduce((sum, neighbor) => sum + values[neighbor], 0) / neighbors.length;
      next[index] = values[index] * 0.64 + average * 0.36;
    }
    values = next;
  }
  const raw = new Array<number>(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const nx = x / Math.max(1, width - 1);
      const ny = y / Math.max(1, height - 1);
      const cell = delaunay.find(nx, ny);
      const [sx, sy] = points[cell];
      const distance = Math.hypot(nx - sx, ny - sy);
      const relief = (fractalNoise(nx * 15, ny * 15, settings.seed + 8117, 3, 0.52, 2.11) - 0.5) * 0.16 * settings.noiseStrength;
      raw[y * width + x] = values[cell] - distance * (0.32 + settings.coastlineDetail * 0.42) + relief;
    }
  }
  return smoothGrid(raw, width, height, 1, 0.12);
}

function createPolygonRaw(settings: GeneratorSettings, width: number, height: number, plan: SkeletonPlan): number[] {
  const points = jitteredPoints(settings, width, height, 917_233, 0.78);
  const delaunay = Delaunay.from(points);
  const ocean = points.map(([x, y]) => scaffoldValue(plan, x, y, settings) < -0.08 || Math.min(x, y, 1 - x, 1 - y) < 0.025);
  const coastDistance = new Int16Array(points.length);
  coastDistance.fill(-1);
  const queue: number[] = [];
  ocean.forEach((isOcean, index) => {
    if (isOcean) {
      coastDistance[index] = 0;
      queue.push(index);
    }
  });
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head];
    for (const neighbor of delaunay.neighbors(current)) {
      if (coastDistance[neighbor] >= 0) continue;
      coastDistance[neighbor] = coastDistance[current] + 1;
      queue.push(neighbor);
    }
  }
  const cellValues = points.map(([x, y], index) => {
    if (ocean[index]) return -0.7 - Math.min(0.5, coastDistance[index] * 0.03);
    const inland = Math.min(1.2, coastDistance[index] * 0.16);
    const regional = (fractalNoise(x * 6.2, y * 6.2, settings.seed + 3389, 4, 0.54, 2.05) - 0.5) * 0.22;
    return 0.08 + inland + regional + scaffoldValue(plan, x, y, settings) * 0.22;
  });
  const raw = new Array<number>(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const nx = x / Math.max(1, width - 1);
      const ny = y / Math.max(1, height - 1);
      let nearest = -1;
      let nearestDistance = Number.POSITIVE_INFINITY;
      let secondDistance = Number.POSITIVE_INFINITY;
      for (let index = 0; index < points.length; index += 1) {
        const distance = Math.hypot(nx - points[index][0], ny - points[index][1]);
        if (distance < nearestDistance) {
          secondDistance = nearestDistance;
          nearestDistance = distance;
          nearest = index;
        } else if (distance < secondDistance) secondDistance = distance;
      }
      const edgeFactor = clamp((secondDistance - nearestDistance) * 20, 0, 1);
      const edgeJitter = (fractalPerlinNoise(nx * 11, ny * 11, settings.seed + 7711, 3, 0.52, 2.07) - 0.5) * 0.12;
      raw[y * width + x] = cellValues[Math.max(0, nearest)] + edgeFactor * 0.08 + edgeJitter * settings.noiseStrength;
    }
  }
  return smoothGrid(raw, width, height, Math.max(1, Math.round(settings.hybridPolygonRefinement)), 0.1);
}

function createMstRaw(settings: GeneratorSettings, width: number, height: number, plan: SkeletonPlan): number[] {
  const raw = new Array<number>(width * height);
  const aspect = width / Math.max(1, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const nx = x / Math.max(1, width - 1);
      const ny = y / Math.max(1, height - 1);
      let field = -1.25;
      for (let index = 0; index < plan.cores.length; index += 1) {
        const core = plan.cores[index];
        const distance = Math.hypot((nx - core.x) * aspect, ny - core.y);
        field = Math.max(field, 0.8 - distance / (0.055 + ((index * 17) % 9) * 0.006));
      }
      for (const edge of plan.edges) {
        const distance = distanceToSegment(nx * aspect, ny, { x: edge.a.x * aspect, y: edge.a.y }, { x: edge.b.x * aspect, y: edge.b.y });
        field = Math.max(field, edge.weight - distance / (edge.width * (0.72 + settings.continentDynamics * 0.42)));
      }
      for (const cut of plan.cuts) {
        const distance = distanceToSegment(nx * aspect, ny, { x: cut.a.x * aspect, y: cut.a.y }, { x: cut.b.x * aspect, y: cut.b.y });
        field -= Math.max(0, 1 - distance / cut.width) * cut.strength;
      }
      const directional = (fractalPerlinNoise(nx * 5.2, ny * 2.6, settings.seed + 12_647, 4, 0.52, 2.05) - 0.5) * 0.2 * settings.noiseStrength;
      raw[y * width + x] = field + directional;
    }
  }
  return smoothGrid(raw, width, height, 1, 0.08);
}

type WfcState = 0 | 1 | 2 | 3;
const WFC_ALLOWED: Record<WfcState, WfcState[]> = {
  0: [0, 1],
  1: [0, 1, 2],
  2: [1, 2, 3],
  3: [2, 3],
};

function collapseWfc(settings: GeneratorSettings, plan: SkeletonPlan, macroWidth: number, macroHeight: number, seedOffset: number): WfcState[] {
  const random = mulberry32(settings.seed + seedOffset);
  const allStates: WfcState[] = [0, 1, 2, 3];
  const options: WfcState[][] = Array.from({ length: macroWidth * macroHeight }, (_, index) => {
    const x = index % macroWidth;
    const y = Math.floor(index / macroWidth);
    const nx = x / Math.max(1, macroWidth - 1);
    const ny = y / Math.max(1, macroHeight - 1);
    const scaffold = scaffoldValue(plan, nx, ny, settings);
    if (x === 0 || y === 0 || x === macroWidth - 1 || y === macroHeight - 1) return [0];
    if (scaffold > 0.42) return [2, 3];
    if (scaffold > 0.02) return [1, 2];
    if (scaffold > -0.28) return [0, 1, 2];
    return [0, 1];
  });
  const directions = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
  const propagate = (starts: number[]): boolean => {
    const queue = [...starts];
    while (queue.length) {
      const index = queue.shift()!;
      const x = index % macroWidth;
      const y = Math.floor(index / macroWidth);
      for (const [dx, dy] of directions) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= macroWidth || ny >= macroHeight) continue;
        const next = ny * macroWidth + nx;
        const permitted = new Set<WfcState>();
        for (const state of options[index]) for (const allowed of WFC_ALLOWED[state]) permitted.add(allowed);
        const filtered = options[next].filter((state) => permitted.has(state));
        if (!filtered.length) return false;
        if (filtered.length !== options[next].length) {
          options[next] = filtered;
          queue.push(next);
        }
      }
    }
    return true;
  };
  if (!propagate(options.map((_, index) => index))) return options.map((states) => states[0] ?? 0);
  for (let step = 0; step < options.length * 3; step += 1) {
    let target = -1;
    let entropy = Number.POSITIVE_INFINITY;
    for (let index = 0; index < options.length; index += 1) {
      const length = options[index].length;
      if (length > 1 && length < entropy) {
        entropy = length;
        target = index;
      }
    }
    if (target < 0) break;
    const x = target % macroWidth;
    const y = Math.floor(target / macroWidth);
    const nx = x / Math.max(1, macroWidth - 1);
    const ny = y / Math.max(1, macroHeight - 1);
    const scaffold = scaffoldValue(plan, nx, ny, settings);
    const candidates = options[target];
    const weights = candidates.map((state) => {
      const targetState = scaffold > 0.32 ? 3 : scaffold > -0.02 ? 2 : scaffold > -0.28 ? 1 : 0;
      return 1 / (1 + Math.abs(state - targetState) * (1.4 + settings.hybridWfcStrength * 2.2));
    });
    let roll = random() * weights.reduce((sum, value) => sum + value, 0);
    let choice = candidates[0];
    for (let index = 0; index < candidates.length; index += 1) {
      roll -= weights[index];
      if (roll <= 0) {
        choice = candidates[index];
        break;
      }
    }
    options[target] = [choice];
    if (!propagate([target])) {
      options[target] = [candidates[Math.floor(random() * candidates.length)] ?? 0];
      propagate([target]);
    }
  }
  return options.map((states) => states[0] ?? allStates[Math.floor(random() * allStates.length)]);
}

function createWfcRaw(settings: GeneratorSettings, width: number, height: number, plan: SkeletonPlan): number[] {
  const macroWidth = Math.max(16, Math.min(42, Math.round(width / 4)));
  const macroHeight = Math.max(10, Math.round(macroWidth * height / Math.max(1, width)));
  const collapsed = collapseWfc(settings, plan, macroWidth, macroHeight, 51_907);
  const stateValue = [-0.75, -0.12, 0.42, 0.95];
  const raw = new Array<number>(width * height);
  for (let y = 0; y < height; y += 1) {
    const gy = y / Math.max(1, height - 1) * (macroHeight - 1);
    const y0 = Math.floor(gy);
    const y1 = Math.min(macroHeight - 1, y0 + 1);
    const ty = gy - y0;
    for (let x = 0; x < width; x += 1) {
      const gx = x / Math.max(1, width - 1) * (macroWidth - 1);
      const x0 = Math.floor(gx);
      const x1 = Math.min(macroWidth - 1, x0 + 1);
      const tx = gx - x0;
      const top = stateValue[collapsed[y0 * macroWidth + x0]] * (1 - tx) + stateValue[collapsed[y0 * macroWidth + x1]] * tx;
      const bottom = stateValue[collapsed[y1 * macroWidth + x0]] * (1 - tx) + stateValue[collapsed[y1 * macroWidth + x1]] * tx;
      const nx = x / Math.max(1, width - 1);
      const ny = y / Math.max(1, height - 1);
      const detail = (fractalPerlinNoise(nx * 8, ny * 8, settings.seed + 61_101, 3, 0.52, 2.07) - 0.5) * 0.15 * settings.noiseStrength;
      raw[y * width + x] = top * (1 - ty) + bottom * ty + detail;
    }
  }
  return smoothGrid(raw, width, height, 2, 0.16);
}

function createHybridRaw(settings: GeneratorSettings, width: number, height: number, plan: SkeletonPlan): number[] {
  // 1) WFC는 저해상도 육해 위상을 확정한다.
  const macro = createWfcRaw(settings, width, height, plan);
  // 2) Voronoi는 지역 셀의 높이와 인접 구획을 위상 위에 얹는다.
  const regions = createVoronoiRaw(settings, width, height, plan);
  let stage = macro.map((value, index) => value * (0.72 + settings.hybridWfcStrength * 0.18) + regions[index] * 0.24);

  // 3) MST 골격은 단순 평균이 아니라 핵·지협·반도 줄기를 최소 높이로 강제한다.
  const backbone = createMstRaw(settings, width, height, plan);
  stage = stage.map((value, index) => {
    const enforcedBackbone = backbone[index] * (0.72 + settings.hybridExtraEdgeRatio * 0.55);
    return enforcedBackbone > value ? value * 0.42 + enforcedBackbone * 0.72 : value + backbone[index] * 0.08;
  });

  // 4) 펄린은 저주파 대륙을 다시 만들지 않고, 연속적인 잔차 왜곡만 추가한다.
  const perlin = createPerlinRaw(settings, width, height, plan);
  const perlinLow = smoothGrid(perlin, width, height, 3, 0.34);
  const warpStrength = 0.45 + settings.hybridPerlinWarp * 0.7;
  stage = stage.map((value, index) => value + (perlin[index] - perlinLow[index]) * warpStrength);

  // 5) 폴리곤은 셀 경계의 중·고주파 잔차만 더해 해안·지역 경계를 세분화한다.
  const polygon = createPolygonRaw(settings, width, height, plan);
  const polygonLow = smoothGrid(polygon, width, height, 2, 0.4);
  const refinement = 0.34 + settings.hybridPolygonRefinement * 0.16;
  stage = stage.map((value, index) => value + (polygon[index] - polygonLow[index]) * refinement);
  return smoothGrid(stage, width, height, 1, 0.08);
}

function quantileThreshold(values: number[], landRatio: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.floor(sorted.length * (1 - landRatio))))] ?? 0;
}

function measureShape(raw: number[], width: number, height: number, landRatio: number): SkeletonDiagnostics {
  const threshold = quantileThreshold(raw, landRatio);
  const land = raw.map((value) => value >= threshold);
  let area = 0;
  let perimeter = 0;
  let minX = width;
  let minY = height;
  let maxX = 0;
  let maxY = 0;
  let peninsulaCount = 0;
  let bayCount = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const isLand = land[index];
      let landNeighbors = 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < width && ny < height && land[ny * width + nx]) landNeighbors += 1;
        else if (isLand) perimeter += 1;
      }
      if (isLand) {
        area += 1;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
        if (landNeighbors <= 2) peninsulaCount += 1;
      } else if (landNeighbors >= 3) bayCount += 1;
    }
  }
  const bboxWidth = Math.max(1, maxX - minX + 1);
  const bboxHeight = Math.max(1, maxY - minY + 1);
  const aspectRatio = Math.max(bboxWidth / bboxHeight, bboxHeight / bboxWidth);
  const circularity = area > 0 && perimeter > 0 ? (4 * Math.PI * area) / (perimeter * perimeter) : 0;
  const compactness = area / Math.max(1, bboxWidth * bboxHeight);
  return { repairPasses: 0, circularity, aspectRatio, compactness, peninsulaCount, bayCount };
}

function repairRoundLandmass(raw: number[], width: number, height: number, settings: GeneratorSettings, plan: SkeletonPlan): { raw: number[]; diagnostics: SkeletonDiagnostics } {
  let current = [...raw];
  let diagnostics = measureShape(current, width, height, settings.landRatio);
  const random = mulberry32(settings.seed + 880_301);
  const passes = Math.max(0, Math.round(settings.skeletonRepairPasses));
  for (let pass = 0; pass < passes; pass += 1) {
    const tooRound = diagnostics.circularity > 0.24 && diagnostics.aspectRatio < 1.32 && diagnostics.compactness > 0.58;
    const lacksFeatures = diagnostics.peninsulaCount < Math.max(6, width * height * 0.0005) || diagnostics.bayCount < Math.max(4, width * height * 0.00035);
    if (!tooRound && !lacksFeatures) break;
    const center = plan.continentCenters[pass % plan.continentCenters.length] ?? { x: 0.5, y: 0.5 };
    const peninsulaAngle = random() * Math.PI * 2;
    const bayAngle = peninsulaAngle + Math.PI * (0.45 + random() * 0.45);
    const peninsulaEnd = {
      x: clamp(center.x + Math.cos(peninsulaAngle) * (0.23 + random() * 0.15), 0.03, 0.97),
      y: clamp(center.y + Math.sin(peninsulaAngle) * (0.18 + random() * 0.12), 0.03, 0.97),
    };
    const bayStart = {
      x: clamp(center.x + Math.cos(bayAngle) * (0.26 + random() * 0.12), 0.02, 0.98),
      y: clamp(center.y + Math.sin(bayAngle) * (0.2 + random() * 0.1), 0.02, 0.98),
    };
    const aspect = width / Math.max(1, height);
    const peninsulaWidth = 0.034 + random() * 0.018;
    const bayWidth = 0.028 + random() * 0.016;
    const peninsulaStrength = 0.38 + random() * 0.16;
    const bayStrength = 0.34 + random() * 0.14;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = y * width + x;
        const nx = x / Math.max(1, width - 1);
        const ny = y / Math.max(1, height - 1);
        const peninsulaDistance = distanceToSegment(nx * aspect, ny, { x: center.x * aspect, y: center.y }, { x: peninsulaEnd.x * aspect, y: peninsulaEnd.y });
        const bayDistance = distanceToSegment(nx * aspect, ny, { x: bayStart.x * aspect, y: bayStart.y }, { x: center.x * aspect, y: center.y });
        current[index] += Math.max(0, 1 - peninsulaDistance / peninsulaWidth) * peninsulaStrength;
        current[index] -= Math.max(0, 1 - bayDistance / bayWidth) * bayStrength;
      }
    }
    diagnostics = measureShape(current, width, height, settings.landRatio);
    diagnostics.repairPasses = pass + 1;
  }
  return { raw: current, diagnostics };
}

export function generateSkeleton(settings: GeneratorSettings, width: number, height: number): SkeletonResult {
  const normalizedSettings = { ...settings, gridWidth: width, gridHeight: height };
  const plan = createSkeletonPlan(normalizedSettings);
  let raw: number[];
  switch (normalizedSettings.algorithm) {
    case "delaunay_voronoi":
      raw = createVoronoiRaw(normalizedSettings, width, height, plan);
      break;
    case "polygon":
      raw = createPolygonRaw(normalizedSettings, width, height, plan);
      break;
    case "mst":
      raw = createMstRaw(normalizedSettings, width, height, plan);
      break;
    case "wfc":
      raw = createWfcRaw(normalizedSettings, width, height, plan);
      break;
    case "hybrid":
      raw = createHybridRaw(normalizedSettings, width, height, plan);
      break;
    case "perlin":
    default:
      raw = createPerlinRaw(normalizedSettings, width, height, plan);
      break;
  }
  raw = applyLocalRegionBias(raw, width, height, normalizedSettings);
  const repaired = repairRoundLandmass(raw, width, height, normalizedSettings, plan);
  return { raw: repaired.raw, centers: plan.continentCenters, diagnostics: repaired.diagnostics };
}
