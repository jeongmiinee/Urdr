import type { WaterType } from "../model/world";

/**
 * Keeps the stored elevation field consistent with its authoritative water
 * classification. Saltwater may contain bathymetry, but never positive relief.
 */
export function reconcileElevationWithWater(
  elevation: ArrayLike<number>,
  waterTypes: ArrayLike<WaterType>,
  seaLevel: number,
): number[] {
  const output = new Array<number>(elevation.length);
  for (let index = 0; index < elevation.length; index += 1) {
    const value = Number.isFinite(elevation[index]) ? elevation[index] : seaLevel;
    const waterType = waterTypes[index] ?? (value > seaLevel ? "land" : "saltwater");
    if (waterType === "saltwater") output[index] = Math.min(seaLevel, value);
    else if (waterType === "land") output[index] = Math.max(seaLevel + 1, value);
    else output[index] = Math.max(seaLevel, value);
  }
  return output;
}

/**
 * Applies the public surface-elevation contract after hydrology has finished.
 * Hydrology may temporarily use a lake bed internally, but every cell belonging
 * to a lake exposes the lake's single, level water-surface elevation.
 */
export function reconcileElevationWithWaterAndLakes(
  elevation: ArrayLike<number>,
  waterTypes: ArrayLike<WaterType>,
  seaLevel: number,
  lakeIds?: ArrayLike<number>,
  lakeSurfaceElevations?: ArrayLike<number>,
): number[] {
  const output = reconcileElevationWithWater(elevation, waterTypes, seaLevel);
  if (!lakeIds || !lakeSurfaceElevations) return output;

  for (let index = 0; index < output.length; index += 1) {
    if (waterTypes[index] !== "freshwater") continue;
    const lakeId = Math.trunc(lakeIds[index] ?? -1);
    const surface = lakeSurfaceElevations[lakeId];
    if (lakeId >= 0 && typeof surface === "number" && Number.isFinite(surface)) {
      output[index] = Math.max(seaLevel, surface);
    }
  }
  return output;
}

export function normalizeSampledSurfaceElevation(
  value: number,
  waterType: WaterType,
  seaLevel: number,
  lakeId = -1,
  lakeSurfaceElevations?: ArrayLike<number>,
): number {
  if (waterType === "saltwater") return Math.min(seaLevel, value);
  if (waterType === "land") return Math.max(seaLevel + 1, value);
  const lakeSurface = lakeSurfaceElevations?.[lakeId];
  return typeof lakeSurface === "number" && Number.isFinite(lakeSurface)
    ? Math.max(seaLevel, lakeSurface)
    : Math.max(seaLevel, value);
}

export function terrainWithoutSubmergedLand<T>(
  terrain: ArrayLike<T>,
  waterTypes: ArrayLike<WaterType>,
  neutral: T,
): T[] {
  return Array.from({ length: terrain.length }, (_, index) =>
    waterTypes[index] === "land" ? (terrain[index] ?? neutral) : neutral,
  );
}
