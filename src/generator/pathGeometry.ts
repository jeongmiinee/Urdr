import type { Point } from "../model/world";

export function segmentDistance(
  px: number,
  py: number,
  a: Point,
  b: Point,
): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const lengthSquared = abx * abx + aby * aby;
  if (lengthSquared <= 1e-9) return Math.hypot(px - a.x, py - a.y);
  const t = Math.max(
    0,
    Math.min(1, ((px - a.x) * abx + (py - a.y) * aby) / lengthSquared),
  );
  return Math.hypot(px - (a.x + abx * t), py - (a.y + aby * t));
}
