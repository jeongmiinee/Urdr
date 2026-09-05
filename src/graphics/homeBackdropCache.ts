import { createGeneratedMapCanvas } from "./index";
import { generatedAtYear, type WorldProject } from "../model/world";
import { activeMap } from "../model/worldSelectors";
import { surfaceGeometryFingerprint } from "../generator/surfaceVectors";

const backdropCache = new Map<string, HTMLCanvasElement>();
const MAXIMUM_CACHED_BACKDROPS = 2;

export function homeBackdropCacheKey(project: WorldProject): string | null {
  const map = activeMap(project);
  const generated = map ? generatedAtYear(map) : null;
  if (!map || !generated) return null;
  const surfaceVersion = generated.surfaceVectorVersion ?? 0;
  const fingerprint = surfaceGeometryFingerprint(generated);
  return [
    project.id,
    map.id,
    map.timeline.currentYear,
    map.timeline.currentDayOfYear,
    map.timeline.currentMinuteOfDay,
    surfaceVersion,
    fingerprint,
    generated.renderWidth,
    generated.renderHeight,
  ].join(":");
}

export function prepareHomeBackdrop(project: WorldProject): HTMLCanvasElement | null {
  const key = homeBackdropCacheKey(project);
  if (!key) return null;
  const cached = backdropCache.get(key);
  if (cached) return cached;

  const map = activeMap(project);
  const generated = map ? generatedAtYear(map) : null;
  if (!generated) return null;
  const canvas = createGeneratedMapCanvas(generated);
  backdropCache.set(key, canvas);
  while (backdropCache.size > MAXIMUM_CACHED_BACKDROPS) {
    const oldestKey = backdropCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    backdropCache.delete(oldestKey);
  }
  return canvas;
}
