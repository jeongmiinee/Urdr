import type { GeneratedRiverSegment, GeneratorSettings, Point } from "../model/world";
import { createGridTransform } from "./gridTransform";
import { CellMinHeap } from "./cellMinHeap";
import type { HydrologyResult } from "./hydrologyTypes";
import { fractalNoise } from "./noise";
import { resamplePath, smoothPath } from "./pathSmoothing";
import { mulberry32 } from "./random";

const clamp = (value: number, min = 0, max = 1) =>
  Math.max(min, Math.min(max, value));

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

export function buildHydrology(
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
