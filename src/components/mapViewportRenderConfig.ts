import type { MapData } from "../model/world";

export const MAP_SCALE = 8;

export type BitmapScalingMode = "auto" | "1" | "2" | "4";

export function textResolution(): number {
  return Math.max(2, Math.min(4, (window.devicePixelRatio || 1) * 2));
}

export function cappedLocalScale(viewScale: number): number {
  return 1 / Math.max(1, viewScale);
}

export function readBitmapScalingMode(): BitmapScalingMode {
  const value = localStorage.getItem("world-archive-bitmap-scaling");
  return value === "1" || value === "2" || value === "4" ? value : "auto";
}

export function bitmapScaleFactor(
  mode: BitmapScalingMode,
  map: MapData,
): number {
  if (mode !== "auto") return Number(mode);
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const basePixels = map.width * MAP_SCALE * map.height * MAP_SCALE;
  if (dpr >= 3 && basePixels <= 600_000) return 4;
  if (dpr >= 1.35 || basePixels <= 1_600_000) return 2;
  return 1;
}
