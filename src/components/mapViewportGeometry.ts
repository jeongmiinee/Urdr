import { pointInPolygon, type Point } from "../model/world";
import { MAP_SCALE } from "./mapViewportRenderConfig";

export type Rect = { x: number; y: number; width: number; height: number };

export function polygonArea(points: Point[]): number {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index];
    const b = points[(index + 1) % points.length];
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area) / 2;
}

export type NestedPolygonRing = {
  points: Point[];
  depth: number;
  probe: Point;
};

function signedPolygonArea(points: Point[]): number {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    area += current.x * next.y - next.x * current.y;
  }
  return area / 2;
}

/** Returns a point just inside the ring instead of reusing a boundary vertex. */
export function polygonInteriorProbe(points: Point[]): Point {
  if (points.length < 3) return points[0] ?? { x: 0, y: 0 };
  const signedArea = signedPolygonArea(points);
  const bounds = points.reduce(
    (result, point) => ({
      minX: Math.min(result.minX, point.x),
      minY: Math.min(result.minY, point.y),
      maxX: Math.max(result.maxX, point.x),
      maxY: Math.max(result.maxY, point.y),
    }),
    { minX: Number.POSITIVE_INFINITY, minY: Number.POSITIVE_INFINITY, maxX: Number.NEGATIVE_INFINITY, maxY: Number.NEGATIVE_INFINITY },
  );
  const epsilon = Math.max(1e-8, Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) * 1e-7);
  const orientation = signedArea >= 0 ? 1 : -1;
  for (let index = 0; index < points.length; index += 1) {
    const start = points[index];
    const end = points[(index + 1) % points.length];
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.hypot(dx, dy);
    if (length <= epsilon) continue;
    const midpoint = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
    const candidate = {
      x: midpoint.x - orientation * dy / length * epsilon,
      y: midpoint.y + orientation * dx / length * epsilon,
    };
    if (pointInPolygon(candidate, points)) return candidate;
  }
  return points[0];
}

/** Classifies compound-polygon rings using the same even-odd nesting rule as Canvas. */
export function classifyPolygonRings(polygons: Point[][]): NestedPolygonRing[] {
  const rings = polygons
    .filter((points) => points.length >= 3)
    .map((points) => ({ points, area: polygonArea(points), depth: 0, probe: polygonInteriorProbe(points) }));

  for (const ring of rings) {
    ring.depth = rings.reduce((depth, candidate) => {
      if (candidate === ring || candidate.area <= ring.area) return depth;
      return pointInPolygon(ring.probe, candidate.points) ? depth + 1 : depth;
    }, 0);
  }

  return rings.map(({ points, depth, probe }) => ({ points, depth, probe }));
}

export function rectOverlap(a: Rect, b: Rect): number {
  const width = Math.max(
    0,
    Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
  );
  const height = Math.max(
    0,
    Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
  );
  return width * height;
}

export function boxAt(center: Point, width: number, height: number): Rect {
  return {
    x: center.x * MAP_SCALE - width / 2,
    y: center.y * MAP_SCALE - height / 2,
    width,
    height,
  };
}
