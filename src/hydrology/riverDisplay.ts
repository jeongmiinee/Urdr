export const RIVER_OVERVIEW_BREAKPOINT = 0.45;
export const RIVER_NORMAL_MINIMUM_SCREEN_WIDTH = 1.2;

/**
 * Keeps tributaries legible at ordinary zoom levels, then releases the floor
 * continuously in the deep overview so the network does not become uniform.
 */
export function minimumRiverScreenWidth(viewScale: number): number {
  const scale = Math.max(0.05, viewScale);
  if (scale >= RIVER_OVERVIEW_BREAKPOINT)
    return RIVER_NORMAL_MINIMUM_SCREEN_WIDTH;
  return RIVER_NORMAL_MINIMUM_SCREEN_WIDTH
    * Math.pow(scale / RIVER_OVERVIEW_BREAKPOINT, 0.82);
}

export function riverHalfWidthInWorldPixels(
  physicalWidthMeters: number,
  pixelsPerMeterAtUnitScale: number,
  viewScale: number,
): number {
  const scale = Math.max(0.05, viewScale);
  const physicalHalfWidth = Math.max(0, physicalWidthMeters) * pixelsPerMeterAtUnitScale * 0.5;
  const minimumHalfWidth = minimumRiverScreenWidth(scale) * 0.5 / scale;
  return Math.max(physicalHalfWidth, minimumHalfWidth);
}
