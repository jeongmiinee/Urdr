import type { GeneratorSettings, TerrainType, WaterType } from "../model/world";
import type { calculateEnvironment } from "./environment";
import { landComponents } from "./gridComponents";
import type { HydrologyResult } from "./hydrologyTypes";
import { fractalPerlinNoise } from "./noise";

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

export function coastalWoodlandBuffer(
  index: number,
  width: number,
  height: number,
  settings: GeneratorSettings,
): number {
  const x = index % width;
  const y = Math.floor(index / width);
  const minimumDimension = Math.max(1, Math.min(width, height));
  const broadScale = Math.max(14, minimumDimension * 0.12);
  const regionalScale = Math.max(8, broadScale * 0.46);
  const broad = fractalPerlinNoise(
    x / broadScale,
    y / broadScale,
    settings.seed + 281_119,
    4,
    0.57,
    2.02,
  );
  const regional = fractalPerlinNoise(
    x / regionalScale,
    y / regionalScale,
    settings.seed + 281_167,
    3,
    0.51,
    2.09,
  );
  const variation = clamp(broad * 0.74 + regional * 0.26);
  const resolutionScale = clamp(Math.sqrt(minimumDimension / 128), 1, 3.4);
  const amplitude = 11 + Math.sqrt(minimumDimension) * 1.65;
  return Math.max(3, Math.round(2 + resolutionScale * 1.5 + variation * variation * amplitude + regional * 4.5));
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
  for (let index = 0; index < terrain.length; index += 1) {
    if (waterTypeMap[index] !== "land") continue;
    const temperature = environment.temperatureMap[index] ?? 0;
    const precipitation = environment.precipitationMap[index] ?? 0;
    const moisture = environment.moistureMap[index] ?? 0;
    const runoff = environment.runoffMap[index] ?? 0;
    const x = index % width;
    const y = Math.floor(index / width);
    const sampleElevation = (sx: number, sy: number) => elevation[
      Math.max(0, Math.min(height - 1, sy)) * width + Math.max(0, Math.min(width - 1, sx))
    ] ?? elevation[index];
    const localRelief = Math.max(
      Math.abs(sampleElevation(x - 1, y) - sampleElevation(x + 1, y)),
      Math.abs(sampleElevation(x, y - 1) - sampleElevation(x, y + 1)),
    ) * 0.5;
    const flatness = 1 - clamp(localRelief / Math.max(18, settings.contourInterval * 0.32));
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
      const accumulatedFlow = Math.max(0, hydrology.flowAccumulationMap[index] ?? 0);
      const convergence = clamp(Math.log1p(accumulatedFlow) / 8);
      const patchNoise = fractalPerlinNoise(
        x / Math.max(9, Math.min(width, height) * 0.055),
        y / Math.max(9, Math.min(width, height) * 0.055),
        settings.seed + 731_321,
        3,
        0.55,
        2.04,
      );
      const coastalPenalty = Math.exp(-coastDistance[index] / Math.max(1.25, Math.min(width, height) * 0.012));
      const wetlandSuitability =
        flatness * 0.31 +
        moisture * 0.22 +
        clamp(runoff / 850) * 0.17 +
        convergence * 0.13 +
        freshAccess * 0.08 +
        patchNoise * 0.16 -
        coastalPenalty * 0.2;
      const tidalCandidate = coastDistance[index] <= 2
        && flatness > 0.88
        && moisture > 0.72
        && runoff > 560
        && patchNoise > 0.62;
      output[index] = wetlandSuitability > 0.72 && (coastDistance[index] > 2 || tidalCandidate)
        ? "wetland"
        : precipitation > 430 || moisture > 0.45
          ? "grassland"
          : "plain";
    }
    if (
      coastDistance[index] <= coastalWoodlandBuffer(index, width, height, settings) &&
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
