import type { LineSegment, Point } from "../model/world";

function distance(a: Point, b: Point): number { return Math.hypot(a.x - b.x, a.y - b.y); }

export function resamplePath(points: Point[], spacing: number): Point[] {
  if (points.length < 2 || spacing <= 0) return [...points];
  const result: Point[] = [{ ...points[0] }];
  let carried = 0;
  let previous = points[0];
  for (let index = 1; index < points.length; index += 1) {
    const target = points[index];
    let segmentLength = distance(previous, target);
    if (segmentLength <= 1e-8) { previous = target; continue; }
    while (carried + segmentLength >= spacing) {
      const t = (spacing - carried) / segmentLength;
      const next = { x: previous.x + (target.x - previous.x) * t, y: previous.y + (target.y - previous.y) * t };
      result.push(next);
      previous = next;
      segmentLength = distance(previous, target);
      carried = 0;
    }
    carried += segmentLength;
    previous = target;
  }
  const last = points[points.length - 1];
  if (distance(result[result.length - 1], last) > spacing * 0.18) result.push({ ...last });
  else result[result.length - 1] = { ...last };
  return result;
}


function turningAngle(a: Point, b: Point, c: Point): number {
  const ux = b.x - a.x; const uy = b.y - a.y;
  const vx = c.x - b.x; const vy = c.y - b.y;
  const denom = Math.max(1e-9, Math.hypot(ux, uy) * Math.hypot(vx, vy));
  return Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / denom)));
}

function expandSharpCorners(points: Point[], maxTurn: number): Point[] {
  if (points.length < 3) return points.map((point) => ({ ...point }));
  const output: Point[] = [{ ...points[0] }];
  for (let index = 1; index < points.length - 1; index += 1) {
    const a = points[index - 1];
    const b = points[index];
    const c = points[index + 1];
    const angle = turningAngle(a, b, c);
    if (angle <= maxTurn) {
      output.push({ ...b });
      continue;
    }
    const inLength = distance(a, b);
    const outLength = distance(b, c);
    const transition = Math.min(inLength, outLength) * Math.min(0.42, 0.2 + angle / Math.PI * 0.22);
    const inUnit = { x: (b.x - a.x) / Math.max(1e-9, inLength), y: (b.y - a.y) / Math.max(1e-9, inLength) };
    const outUnit = { x: (c.x - b.x) / Math.max(1e-9, outLength), y: (c.y - b.y) / Math.max(1e-9, outLength) };
    output.push(
      { x: b.x - inUnit.x * transition, y: b.y - inUnit.y * transition },
      { x: b.x * 0.72 + (a.x + c.x) * 0.14, y: b.y * 0.72 + (a.y + c.y) * 0.14 },
      { x: b.x + outUnit.x * transition, y: b.y + outUnit.y * transition },
    );
  }
  output.push({ ...points[points.length - 1] });
  return output;
}

function nearestPointOnSegment(point: Point, a: Point, b: Point): Point {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= 1e-12) return { ...a };
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared));
  return { x: a.x + dx * t, y: a.y + dy * t };
}

/** 작은 굴곡이 중간 곡선에, 중간 곡선이 전체 곡선에 종속되도록 거시 경로 쪽으로 약하게 정렬한다. */
function alignToMacroCurve(points: Point[], spacing: number, closed: boolean): Point[] {
  if (points.length < 6) return points;
  let macro = closed ? chaikinPath(points, 2, true) : resamplePath(points, spacing * 4);
  macro = chaikinPath(macro, 2, closed);
  if (macro.length < 3) return points;
  return points.map((point, index) => {
    if (!closed && (index === 0 || index === points.length - 1)) return { ...point };
    let nearest = point;
    let best = Number.POSITIVE_INFINITY;
    const limit = closed ? macro.length : macro.length - 1;
    for (let segment = 0; segment < limit; segment += 1) {
      const candidate = nearestPointOnSegment(point, macro[segment], macro[(segment + 1) % macro.length]);
      const d = distance(point, candidate);
      if (d < best) { best = d; nearest = candidate; }
    }
    const blend = closed ? 0.2 : 0.24;
    return { x: point.x * (1 - blend) + nearest.x * blend, y: point.y * (1 - blend) + nearest.y * blend };
  });
}

/**
 * 도로처럼 큰 회전 반경이 필요한 경로의 급격한 꼭짓점을 여러 완만한 중간점으로 분산한다.
 * 끝점은 고정하며, 최대 각도를 넘는 코너만 반복적으로 이완한다.
 */
export function limitPathCurvature(points: Point[], maxTurnDegrees = 34, passes = 4): Point[] {
  if (points.length < 3) return points.map((point) => ({ ...point }));
  const maxTurn = maxTurnDegrees * Math.PI / 180;
  let current = expandSharpCorners(points, maxTurn);
  for (let pass = 0; pass < passes; pass += 1) {
    const next = current.map((point) => ({ ...point }));
    let changed = false;
    for (let index = 1; index < current.length - 1; index += 1) {
      const a = current[index - 1], b = current[index], c = current[index + 1];
      const angle = turningAngle(a, b, c);
      if (angle <= maxTurn) continue;
      const strength = Math.min(0.46, 0.18 + (angle - maxTurn) / Math.PI * 0.55);
      next[index] = {
        x: b.x * (1 - strength) + ((a.x + c.x) / 2) * strength,
        y: b.y * (1 - strength) + ((a.y + c.y) / 2) * strength,
      };
      changed = true;
    }
    current = next;
    if (!changed) break;
  }
  return current;
}
/** 폐곡선의 모든 점을 이웃 접선에 맞춰 이완해 시작/끝 이음새까지 곡률을 제한한다. */
export function limitClosedPathCurvature(points: Point[], maxTurnDegrees = 30, passes = 8): Point[] {
  if (points.length < 4) return points.map((point) => ({ ...point }));
  const maxTurn = maxTurnDegrees * Math.PI / 180;
  let current = points.map((point) => ({ ...point }));
  for (let pass = 0; pass < passes; pass += 1) {
    const next = current.map((point) => ({ ...point }));
    let changed = false;
    for (let index = 0; index < current.length; index += 1) {
      const a = current[(index - 1 + current.length) % current.length];
      const b = current[index];
      const c = current[(index + 1) % current.length];
      const angle = turningAngle(a, b, c);
      if (angle <= maxTurn) continue;
      const strength = Math.min(0.58, 0.24 + (angle - maxTurn) / Math.PI * 0.7);
      next[index] = {
        x: b.x * (1 - strength) + ((a.x + c.x) / 2) * strength,
        y: b.y * (1 - strength) + ((a.y + c.y) / 2) * strength,
      };
      changed = true;
    }
    current = next;
    if (!changed) break;
  }
  return current;
}

export function chaikinPath(points: Point[], iterations = 1, closed = false): Point[] {
  if (points.length < (closed ? 3 : 4)) return [...points];
  let current = [...points];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const next: Point[] = [];
    if (!closed) next.push({ ...current[0] });
    const limit = closed ? current.length : current.length - 1;
    for (let index = 0; index < limit; index += 1) {
      const a = current[index];
      const b = current[(index + 1) % current.length];
      next.push(
        { x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 },
        { x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 },
      );
    }
    if (!closed) next.push({ ...current[current.length - 1] });
    current = next;
  }
  return current;
}

function catmullPoint(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const t2 = t * t; const t3 = t2 * t;
  return {
    x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
    y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
  };
}

/**
 * 균일 재표본화와 약한 코너 커팅 뒤 Catmull–Rom을 적용한다.
 * 원본 회랑에서 과도하게 벗어나는 오버슈트를 줄이기 위해 Chaikin을 먼저 사용한다.
 */
export function smoothPath(points: Point[], options: { closed?: boolean; spacing?: number; samplesPerSegment?: number; iterations?: number } = {}): Point[] {
  const closed = options.closed ?? false;
  if (points.length < (closed ? 3 : 2)) return [...points];
  const extent = Math.max(
    Math.max(...points.map((point) => point.x)) - Math.min(...points.map((point) => point.x)),
    Math.max(...points.map((point) => point.y)) - Math.min(...points.map((point) => point.y)),
  );
  const spacing = Math.max(0.06, options.spacing ?? extent / Math.max(24, points.length * 1.8));
  let prepared = closed ? [...points] : resamplePath(points, spacing);
  prepared = alignToMacroCurve(prepared, spacing, closed);
  if (!closed) prepared = limitPathCurvature(prepared, 34, 5);
  prepared = chaikinPath(prepared, options.iterations ?? 1, closed);
  if (!closed) prepared = limitPathCurvature(prepared, 30, 3);
  if (prepared.length < 3) return prepared;
  const samples = Math.max(3, options.samplesPerSegment ?? 5);
  const result: Point[] = [];
  if (closed) {
    for (let index = 0; index < prepared.length; index += 1) {
      const p0 = prepared[(index - 1 + prepared.length) % prepared.length];
      const p1 = prepared[index];
      const p2 = prepared[(index + 1) % prepared.length];
      const p3 = prepared[(index + 2) % prepared.length];
      for (let step = 0; step < samples; step += 1) result.push(catmullPoint(p0, p1, p2, p3, step / samples));
    }
  } else {
    const padded = [prepared[0], ...prepared, prepared[prepared.length - 1]];
    for (let index = 1; index < padded.length - 2; index += 1) {
      for (let step = 0; step < samples; step += 1) result.push(catmullPoint(padded[index - 1], padded[index], padded[index + 1], padded[index + 2], step / samples));
    }
    result.push({ ...prepared[prepared.length - 1] });
  }
  return result.filter((point, index, array) => index === 0 || distance(point, array[index - 1]) > 1e-5);
}

/** Marching Squares나 하천 구간을 연결된 폴리라인으로 묶는다. */
export function stitchSegments(segments: LineSegment[], tolerance = 0.025): Point[][] {
  if (segments.length === 0) return [];
  const keyOf = (point: Point) => `${Math.round(point.x / tolerance)}:${Math.round(point.y / tolerance)}`;
  const edges = segments.map((segment, index) => ({ index, a: segment.start, b: segment.end, used: false }));
  const adjacency = new Map<string, number[]>();
  for (const edge of edges) {
    for (const point of [edge.a, edge.b]) {
      const key = keyOf(point); const list = adjacency.get(key) ?? []; list.push(edge.index); adjacency.set(key, list);
    }
  }
  const trace = (startEdge: number, startPoint: Point): Point[] => {
    const path: Point[] = [{ ...startPoint }];
    let edgeIndex = startEdge; let current = startPoint;
    while (edgeIndex >= 0) {
      const edge = edges[edgeIndex]; if (edge.used) break; edge.used = true;
      const next = keyOf(current) === keyOf(edge.a) ? edge.b : edge.a;
      path.push({ ...next });
      const candidates = (adjacency.get(keyOf(next)) ?? []).filter((candidate) => !edges[candidate].used);
      if (candidates.length === 0) break;
      let best = candidates[0];
      if (path.length >= 2 && candidates.length > 1) {
        const previous = path[path.length - 2]; const vx = next.x - previous.x; const vy = next.y - previous.y;
        let bestDot = -Infinity;
        for (const candidate of candidates) {
          const candidateEdge = edges[candidate]; const other = keyOf(next) === keyOf(candidateEdge.a) ? candidateEdge.b : candidateEdge.a;
          const ox = other.x - next.x; const oy = other.y - next.y;
          const dot = (vx * ox + vy * oy) / Math.max(1e-9, Math.hypot(vx, vy) * Math.hypot(ox, oy));
          if (dot > bestDot) { bestDot = dot; best = candidate; }
        }
      }
      current = next; edgeIndex = best;
      if (keyOf(current) === keyOf(startPoint)) break;
    }
    return path;
  };
  const paths: Point[][] = [];
  for (const edge of edges) {
    if (edge.used) continue;
    const degreeA = adjacency.get(keyOf(edge.a))?.length ?? 0;
    const degreeB = adjacency.get(keyOf(edge.b))?.length ?? 0;
    if (degreeA !== 2 || degreeB !== 2) paths.push(trace(edge.index, degreeA !== 2 ? edge.a : edge.b));
  }
  for (const edge of edges) if (!edge.used) paths.push(trace(edge.index, edge.a));
  return paths.filter((path) => path.length >= 2);
}
