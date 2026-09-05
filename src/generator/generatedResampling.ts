import type { GeneratedMapData, GeneratorSettings, TerrainType } from "../model/world";
import { reconcileElevationWithWaterAndLakes, terrainWithoutSubmergedLand } from "./waterElevation";

export function resampleNumberGrid(
  values: number[],
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
  nearest = false,
): number[] {
  if (sourceWidth === targetWidth && sourceHeight === targetHeight)
    return [...values];
  const output = new Array<number>(targetWidth * targetHeight);
  for (let y = 0; y < targetHeight; y += 1) {
    const sourceY =
      targetHeight <= 1 ? 0 : (y * (sourceHeight - 1)) / (targetHeight - 1);
    const y0 = Math.floor(sourceY);
    const y1 = Math.min(sourceHeight - 1, y0 + 1);
    const ty = sourceY - y0;
    for (let x = 0; x < targetWidth; x += 1) {
      const sourceX =
        targetWidth <= 1 ? 0 : (x * (sourceWidth - 1)) / (targetWidth - 1);
      if (nearest) {
        const nx = Math.min(sourceWidth - 1, Math.round(sourceX));
        const ny = Math.min(sourceHeight - 1, Math.round(sourceY));
        output[y * targetWidth + x] = values[ny * sourceWidth + nx] ?? 0;
        continue;
      }
      const x0 = Math.floor(sourceX);
      const x1 = Math.min(sourceWidth - 1, x0 + 1);
      const tx = sourceX - x0;
      const top =
        (values[y0 * sourceWidth + x0] ?? 0) * (1 - tx) +
        (values[y0 * sourceWidth + x1] ?? 0) * tx;
      const bottom =
        (values[y1 * sourceWidth + x0] ?? 0) * (1 - tx) +
        (values[y1 * sourceWidth + x1] ?? 0) * tx;
      output[y * targetWidth + x] = top * (1 - ty) + bottom * ty;
    }
  }
  return output;
}

export function resampleTerrainGrid(
  values: TerrainType[],
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
): TerrainType[] {
  const output = new Array<TerrainType>(targetWidth * targetHeight);
  for (let y = 0; y < targetHeight; y += 1) {
    const sourceY =
      targetHeight <= 1
        ? 0
        : Math.round((y * (sourceHeight - 1)) / (targetHeight - 1));
    for (let x = 0; x < targetWidth; x += 1) {
      const sourceX =
        targetWidth <= 1
          ? 0
          : Math.round((x * (sourceWidth - 1)) / (targetWidth - 1));
      output[y * targetWidth + x] =
        values[sourceY * sourceWidth + sourceX] ?? "plain";
    }
  }
  return output;
}

export function resampleCategoricalGrid<T>(
  values: T[],
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
  fallback: T,
): T[] {
  const output = new Array<T>(targetWidth * targetHeight);
  for (let y = 0; y < targetHeight; y += 1) {
    const sy =
      targetHeight <= 1
        ? 0
        : Math.round((y * (sourceHeight - 1)) / (targetHeight - 1));
    for (let x = 0; x < targetWidth; x += 1) {
      const sx =
        targetWidth <= 1
          ? 0
          : Math.round((x * (sourceWidth - 1)) / (targetWidth - 1));
      output[y * targetWidth + x] = values[sy * sourceWidth + sx] ?? fallback;
    }
  }
  return output;
}

export function upscaleGeneratedMap(
  base: GeneratedMapData,
  settings: GeneratorSettings,
  targetWidth: number,
  targetHeight: number,
): GeneratedMapData {
  const sw = base.gridWidth;
  const sh = base.gridHeight;
  const waterTypeMap = resampleCategoricalGrid(
    base.waterTypeMap,
    sw,
    sh,
    targetWidth,
    targetHeight,
    "land",
  );
  const lakeIdMap = resampleNumberGrid(
    base.lakeIdMap,
    sw,
    sh,
    targetWidth,
    targetHeight,
    true,
  ).map(Math.round);
  const elevationMap = reconcileElevationWithWaterAndLakes(
    resampleNumberGrid(base.elevationMap, sw, sh, targetWidth, targetHeight),
    waterTypeMap,
    base.seaLevel,
    lakeIdMap,
    base.lakeSurfaceElevations,
  );
  const terrainMap = terrainWithoutSubmergedLand(
    resampleTerrainGrid(base.terrainMap, sw, sh, targetWidth, targetHeight),
    waterTypeMap,
    "plain",
  );
  return {
    ...base,
    settings: { ...settings, gridWidth: targetWidth, gridHeight: targetHeight },
    gridWidth: targetWidth,
    gridHeight: targetHeight,
    renderWidth: targetWidth,
    renderHeight: targetHeight,
    elevationMap,
    landMask: waterTypeMap.map((value) => value === "land" ? 1 : 0),
    waterTypeMap,
    coastalTerrainMap: resampleCategoricalGrid(
      base.coastalTerrainMap,
      sw,
      sh,
      targetWidth,
      targetHeight,
      "none",
    ),
    baseTerrainMap: terrainWithoutSubmergedLand(
      resampleTerrainGrid(base.baseTerrainMap ?? base.terrainMap, sw, sh, targetWidth, targetHeight),
      waterTypeMap,
      "plain",
    ),
    agricultureMap: resampleNumberGrid(
      base.agricultureMap ?? new Array(sw * sh).fill(0),
      sw,
      sh,
      targetWidth,
      targetHeight,
    ),
    terrainMap,
    snowCoverMap: resampleNumberGrid(
      base.snowCoverMap,
      sw,
      sh,
      targetWidth,
      targetHeight,
    ),
    snowBaseTerrainMap: resampleTerrainGrid(
      base.snowBaseTerrainMap,
      sw,
      sh,
      targetWidth,
      targetHeight,
    ),
    temperatureMap: resampleNumberGrid(
      base.temperatureMap,
      sw,
      sh,
      targetWidth,
      targetHeight,
    ),
    precipitationMap: resampleNumberGrid(
      base.precipitationMap,
      sw,
      sh,
      targetWidth,
      targetHeight,
    ),
    moistureMap: resampleNumberGrid(
      base.moistureMap,
      sw,
      sh,
      targetWidth,
      targetHeight,
    ),
    relativeHumidityMap: resampleNumberGrid(
      base.relativeHumidityMap,
      sw,
      sh,
      targetWidth,
      targetHeight,
    ),
    solarHoursMap: resampleNumberGrid(
      base.solarHoursMap,
      sw,
      sh,
      targetWidth,
      targetHeight,
    ),
    solarIrradianceMap: resampleNumberGrid(
      base.solarIrradianceMap,
      sw,
      sh,
      targetWidth,
      targetHeight,
    ),
    runoffMap: resampleNumberGrid(
      base.runoffMap,
      sw,
      sh,
      targetWidth,
      targetHeight,
    ),
    flowAccumulationMap: resampleNumberGrid(
      base.flowAccumulationMap,
      sw,
      sh,
      targetWidth,
      targetHeight,
    ),
    lakeIdMap,
    lakeSurfaceElevations: [...base.lakeSurfaceElevations],
    basinMap: resampleNumberGrid(
      base.basinMap,
      sw,
      sh,
      targetWidth,
      targetHeight,
      true,
    ).map(Math.round),
    riverOrderMap: resampleNumberGrid(
      base.riverOrderMap,
      sw,
      sh,
      targetWidth,
      targetHeight,
      true,
    ).map(Math.round),
    riverMagnitudeMap: resampleNumberGrid(
      base.riverMagnitudeMap,
      sw,
      sh,
      targetWidth,
      targetHeight,
      true,
    ).map(Math.round),
    windXMap: resampleNumberGrid(
      base.windXMap,
      sw,
      sh,
      targetWidth,
      targetHeight,
    ),
    windYMap: resampleNumberGrid(
      base.windYMap,
      sw,
      sh,
      targetWidth,
      targetHeight,
    ),
    generatedAt: new Date().toISOString(),
    environmentModel: { engine: "builtin", version: "1.7-stat-ui-generation" },
  };
}
