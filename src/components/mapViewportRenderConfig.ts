export const MAP_SCALE = 8;

export function textResolution(): number {
  return Math.max(2, Math.min(4, (window.devicePixelRatio || 1) * 2));
}

export function cappedLocalScale(viewScale: number): number {
  return 1 / Math.max(1, viewScale);
}
