import type { GeneratorSettings, TerrainType, WaterType } from "../model/world";
import type { calculateEnvironment } from "./environment";
import { landComponents } from "./gridComponents";
import type { HydrologyResult } from "./hydrologyTypes";

const clamp = (value: number, min = 0, max = 1) =>
  Math.max(min, Math.min(max, value));

function gridDistanceFromSources(
  sourceMask: boolean[],
  width: number,
  height: number,
): number[] {
  const distance = new Array<number>(sourceMask.length).fill(
    Number.POSITIVE_INFINITY,
  );
  const queue = new Int32Array(sourceMask.length);
  let head = 0,
    tail = 0;
  for (let i = 0; i < sourceMask.length; i += 1)
    if (sourceMask[i]) {
      distance[i] = 0;
      queue[tail++] = i;
    }
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const;
  while (head < tail) {
    const index = queue[head++],
      x = index % width,
      y = Math.floor(index / width);
    for (const [dx, dy] of dirs) {
      const nx = x + dx,
        ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const next = ny * width + nx;
      if (distance[next] > distance[index] + 1) {
        distance[next] = distance[index] + 1;
        queue[tail++] = next;
      }
    }
  }
  return distance;
}

/** 강수·토양수분뿐 아니라 강·호수·유출량과의 접근성을 반영해 사막 과다 생성을 억제한다. */
export function refineTerrainWithWaterAccess(
  terrain: TerrainType[],
  elevation: number[],
  waterTypeMap: WaterType[],
  environment: ReturnType<typeof calculateEnvironment>,
  hydrology: HydrologyResult,
  width: number,
  height: number,
  seaLevel: number,
  settings: GeneratorSettings,
): TerrainType[] {
  const freshwaterSources = waterTypeMap.map(
    (type, index) =>
      type === "freshwater" ||
      (hydrology.riverOrderMap[index] ?? 0) > 0 ||
      (hydrology.freshwaterLakeMap[index] ?? 0) > 0,
  );
  const saltwaterSources = waterTypeMap.map((type) => type === "saltwater");
  const freshwaterDistance = gridDistanceFromSources(
    freshwaterSources,
    width,
    height,
  );
  const coastDistance = gridDistanceFromSources(
    saltwaterSources,
    width,
    height,
  );
  const output = [...terrain];
  const desertMask = new Uint8Array(terrain.length);
  const coastalWoodlandBufferCells = 2;
  for (let index = 0; index < terrain.length; index += 1) {
    if (waterTypeMap[index] !== "land") continue;
    const temperature = environment.temperatureMap[index] ?? 0;
    const precipitation = environment.precipitationMap[index] ?? 0;
    const moisture = environment.moistureMap[index] ?? 0;
    const runoff = environment.runoffMap[index] ?? 0;
    const potentialEvaporation = Math.max(
      120,
      20 * Math.max(0, temperature + 8),
    );
    const aridity = precipitation / potentialEvaporation;
    const freshAccess = Math.exp(
      -freshwaterDistance[index] / Math.max(3, Math.min(width, height) * 0.018),
    );
    const coastalHumidity = Math.exp(
      -coastDistance[index] / Math.max(4, Math.min(width, height) * 0.035),
    );
    const waterAccess = clamp(
      freshAccess * 0.64 +
        clamp(runoff / 700) * 0.16 +
        moisture * 0.16 +
        coastalHumidity * 0.04,
    );
    const explicitArid =
      String(settings.climatePreset).startsWith("BW") ||
      String(settings.climatePreset).startsWith("BS") ||
      settings.climatePreset === "arid";
    const desertEligible =
      (explicitArid ? aridity < 0.36 : aridity < 0.24) &&
      temperature > 4 &&
      moisture < 0.31 &&
      runoff < 95 &&
      waterAccess < 0.34;
    if (desertEligible) {
      desertMask[index] = 1;
      output[index] = "desert";
    } else if (output[index] === "desert") {
      const relative = elevation[index] - seaLevel;
      output[index] =
        relative > settings.maxElevation * 0.42
          ? "rock"
          : precipitation > 520 || waterAccess > 0.5
            ? "grassland"
            : "plain";
    }
    if (
      freshAccess > 0.66 &&
      ["desert", "plain", "rock"].includes(output[index])
    ) {
      output[index] =
        moisture > 0.58 || runoff > 360
          ? "wetland"
          : precipitation > 430
            ? "grassland"
            : "plain";
    }
    if (
      coastDistance[index] <= coastalWoodlandBufferCells &&
      (output[index] === "forest" || output[index] === "jungle")
    ) {
      output[index] = precipitation > 430 ? "grassland" : "plain";
    }
  }
  // 작은 사막 반점과 다수결 확장으로 생긴 얇은 사막 띠를 제거한다.
  const components = landComponents(
    Array.from(desertMask, Boolean),
    width,
    height,
  );
  const minimumDesertArea = Math.max(18, Math.round(width * height * 0.00045));
  for (const component of components)
    if (component.size < minimumDesertArea)
      for (const index of component.cells) {
        const precipitation = environment.precipitationMap[index] ?? 0;
        output[index] = precipitation > 520 ? "grassland" : "plain";
      }
  return output;
}
