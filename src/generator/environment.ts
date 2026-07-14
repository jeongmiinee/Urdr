import type { GeneratorSettings, Season, TerrainType } from "../model/world";
import { climateDefinition } from "./climatePresets";
import { fractalNoise, fractalPerlinNoise } from "./noise";
import { terrainPriorForClimate } from "./terrainAtlas";

const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value));

const SEASON_OFFSETS: Record<Season, number> = {
  spring: 2,
  summer: 8,
  autumn: 1,
  winter: -8,
};

export type EnvironmentResult = {
  temperatureMap: number[];
  precipitationMap: number[];
  moistureMap: number[];
  relativeHumidityMap: number[];
  solarHoursMap: number[];
  solarIrradianceMap: number[];
  runoffMap: number[];
  windXMap: number[];
  windYMap: number[];
  terrainMap: TerrainType[];
  snowCoverMap: number[];
  snowBaseTerrainMap: TerrainType[];
};

function computeOceanDistance(
  elevation: number[],
  width: number,
  height: number,
  seaLevel: number,
): number[] {
  const distances = new Array<number>(width * height).fill(Number.POSITIVE_INFINITY);
  const queue = new Int32Array(width * height);
  let head = 0;
  let tail = 0;
  for (let index = 0; index < elevation.length; index += 1) {
    if (elevation[index] <= seaLevel) {
      distances[index] = 0;
      queue[tail++] = index;
    }
  }
  const directions = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
  while (head < tail) {
    const index = queue[head++];
    const x = index % width;
    const y = Math.floor(index / width);
    for (const [dx, dy] of directions) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const next = ny * width + nx;
      if (distances[next] > distances[index] + 1) {
        distances[next] = distances[index] + 1;
        queue[tail++] = next;
      }
    }
  }
  return distances;
}

function smooth(values: number[], width: number, height: number, passes = 1): number[] {
  let current = values;
  for (let pass = 0; pass < passes; pass += 1) {
    const next = [...current];
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const index = y * width + x;
        let sum = current[index] * 4;
        let weight = 4;
        for (let oy = -1; oy <= 1; oy += 1) {
          for (let ox = -1; ox <= 1; ox += 1) {
            if (ox === 0 && oy === 0) continue;
            sum += current[(y + oy) * width + x + ox];
            weight += 1;
          }
        }
        next[index] = sum / weight;
      }
    }
    current = next;
  }
  return current;
}

function sampleBilinear(
  values: ArrayLike<number>,
  width: number,
  height: number,
  x: number,
  y: number,
): number {
  const cx = Math.max(0, Math.min(width - 1, x));
  const cy = Math.max(0, Math.min(height - 1, y));
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const tx = cx - x0;
  const ty = cy - y0;
  const top = values[y0 * width + x0] * (1 - tx) + values[y0 * width + x1] * tx;
  const bottom = values[y1 * width + x0] * (1 - tx) + values[y1 * width + x1] * tx;
  return top * (1 - ty) + bottom * ty;
}

function terrainFor(
  elevation: number,
  seaLevel: number,
  maxElevation: number,
  temperatureC: number,
  precipitationMm: number,
  moisture: number,
  runoffMm: number,
  slope: number,
  cellIndex: number,
  settings: GeneratorSettings,
): TerrainType {
  const relative = elevation - seaLevel;
  const normalized = Math.max(0, relative) / Math.max(1, maxElevation - seaLevel);
  if (relative < -1800) return "bedrock";
  if (relative < 0) return relative < -450 ? "rock" : "plain";
  if (normalized > 0.82) return "mountain";

  const prior = terrainPriorForClimate(settings.climatePreset);
  const potentialEvaporation = Math.max(120, 20 * Math.max(0, temperatureC + 8));
  const aridity = precipitationMm / potentialEvaporation;
  const wetness = clamp(moisture * 0.62 + Math.min(1, runoffMm / 900) * 0.38);
  const slopeFactor = clamp(slope * 6.5);
  const lowland = clamp(1 - normalized / 0.48);
  const temperate = clamp(1 - Math.abs(temperatureC - 14) / 22);
  const warm = clamp((temperatureC - 13) / 18);
  const cold = clamp((5 - temperatureC) / 18);
  const dryClimate = String(settings.climatePreset).startsWith("B") || ["arid", "mediterranean", "Csa", "Csb", "Csc"].includes(settings.climatePreset);
  const localMap = settings.mapScaleKm <= 50;

  const scores: Partial<Record<TerrainType, number>> = {
    mountain: (prior.mountain ?? 0.04) * 2 + normalized * 3.2 + slopeFactor * 1.15,
    rock: (prior.rock ?? 0.04) * 2 + normalized * 1.35 + slopeFactor * 1.75 + clamp((0.48 - wetness) * 1.4),
    wetland: (prior.wetland ?? 0.02) * 2 + wetness * 2.2 + lowland * 0.9 + clamp(runoffMm / 1100) * 1.2 - slopeFactor * 2.4,
    desert: (prior.desert ?? 0.01) * 2.2 + clamp((0.7 - aridity) / 0.7) * 2.6 + warm * 0.45 - wetness * 1.6,
    jungle: (prior.jungle ?? 0.01) * 2.2 + warm * 1.3 + clamp((precipitationMm - 1050) / 1200) * 1.8 + wetness * 1.1 - normalized * 1.15,
    forest: (prior.forest ?? 0.12) * 2.1 + temperate * 0.95 + clamp((precipitationMm - 420) / 1200) * 1.25 + wetness * 0.72 - slopeFactor * 0.15,
    grassland: (prior.grassland ?? 0.16) * 2.1 + temperate * 0.7 + clamp(1 - Math.abs(aridity - 0.85) / 0.85) * 0.8 + lowland * 0.35,
    plain: (prior.plain ?? 0.18) * 2 + lowland * 1.15 + clamp(1 - slopeFactor) * 0.6,
  };

  if (!dryClimate && (localMap || aridity > 0.58)) scores.desert = (scores.desert ?? 0) - 2.1;
  if (temperatureC < 16 || precipitationMm < 1050) scores.jungle = (scores.jungle ?? 0) - 1.7;
  if (wetness < 0.58 || slopeFactor > 0.35) scores.wetland = (scores.wetland ?? 0) - 1.5;
  if (temperatureC < -4) {
    scores.forest = (scores.forest ?? 0) + cold * 0.4;
    scores.jungle = -10;
  }

  const candidates = Object.entries(scores) as Array<[TerrainType, number]>;
  let selected: TerrainType = "plain";
  let bestScore = -Infinity;
  for (let index = 0; index < candidates.length; index += 1) {
    const [terrain, score] = candidates[index];
    const jitter = (deterministicCellRandom(cellIndex + index * 101, index * 17 + 5, settings.seed + 44_771) - 0.5) * 0.22;
    if (score + jitter > bestScore) {
      bestScore = score + jitter;
      selected = terrain;
    }
  }
  return selected;
}

function snowCoverageFor(
  elevation: number,
  seaLevel: number,
  maxElevation: number,
  temperatureC: number,
  precipitationMm: number,
): number {
  if (elevation <= seaLevel || precipitationMm < 45 || temperatureC > 4.5) return 0;
  const relative = Math.max(0, elevation - seaLevel);
  const cold = clamp((3.5 - temperatureC) / 16);
  const snowSupply = clamp((precipitationMm - 45) / 720);
  const altitude = clamp(relative / Math.max(1200, maxElevation * 0.72));
  return clamp(cold * (0.28 + snowSupply * 0.72) + altitude * cold * 0.22);
}

function deterministicCellRandom(x: number, y: number, seed: number): number {
  let value = Math.imul(x + 1, 374761393) ^ Math.imul(y + 1, 668265263) ^ Math.imul(seed | 0, 1442695041);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
}

function representativeDayOfYear(season: Season): number {
  return season === "spring" ? 80 : season === "summer" ? 172 : season === "autumn" ? 266 : 355;
}

function solarGeometry(latitudeDeg: number, season: Season): { dayLength: number; noonAltitudeRad: number; declinationRad: number } {
  const latitude = Math.max(-89, Math.min(89, latitudeDeg)) * Math.PI / 180;
  const day = representativeDayOfYear(season);
  const declination = 23.44 * Math.sin((2 * Math.PI * (284 + day)) / 365) * Math.PI / 180;
  const cosineHour = Math.max(-1, Math.min(1, -Math.tan(latitude) * Math.tan(declination)));
  const hourAngle = Math.acos(cosineHour);
  const dayLength = 24 * hourAngle / Math.PI;
  const noonAltitude = Math.max(0.01, Math.PI / 2 - Math.abs(latitude - declination));
  return { dayLength, noonAltitudeRad: noonAltitude, declinationRad: declination };
}

function windVector(directionDeg: number, speed: number): { x: number; y: number } {
  const radians = (directionDeg * Math.PI) / 180;
  const magnitude = Math.max(0.2, speed);
  return { x: Math.cos(radians) * magnitude, y: Math.sin(radians) * magnitude };
}

function configuredWindAt(settings: GeneratorSettings, nx: number, ny: number): { x: number; y: number } {
  if (settings.mapScope !== "continent" && settings.mapScope !== "world")
    return windVector(settings.prevailingWindDirectionDeg || 0, settings.prevailingWindSpeed || 6);
  const corners = settings.cornerWinds;
  const nw = windVector(corners.northWest.directionDeg, corners.northWest.speed);
  const ne = windVector(corners.northEast.directionDeg, corners.northEast.speed);
  const sw = windVector(corners.southWest.directionDeg, corners.southWest.speed);
  const se = windVector(corners.southEast.directionDeg, corners.southEast.speed);
  const topX = nw.x * (1 - nx) + ne.x * nx;
  const topY = nw.y * (1 - nx) + ne.y * nx;
  const bottomX = sw.x * (1 - nx) + se.x * nx;
  const bottomY = sw.y * (1 - nx) + se.y * nx;
  let x = topX * (1 - ny) + bottomX * ny;
  let y = topY * (1 - ny) + bottomY * ny;
  // 세계 지도에서는 좌우 경계에서 급격한 방향 단절이 보이지 않도록 완만한 순환 보정을 섞는다.
  if (settings.mapScope === "world") {
    const seam = Math.pow(Math.abs(nx - 0.5) * 2, 5);
    const westX = nw.x * (1 - ny) + sw.x * ny;
    const westY = nw.y * (1 - ny) + sw.y * ny;
    const eastX = ne.x * (1 - ny) + se.x * ny;
    const eastY = ne.y * (1 - ny) + se.y * ny;
    const seamX = (westX + eastX) / 2;
    const seamY = (westY + eastY) / 2;
    x = x * (1 - seam * 0.45) + seamX * seam * 0.45;
    y = y * (1 - seam * 0.45) + seamY * seam * 0.45;
  }
  return { x, y };
}

/**
 * 평균 기후를 계산한다. 지역 지도에서는 배경기후와 지형성 미기후를,
 * 대륙 규모에서는 완만한 위도대·내륙성 효과를 추가한다.
 */
export function calculateEnvironment(
  elevation: number[],
  width: number,
  height: number,
  seaLevel: number,
  settings: GeneratorSettings,
): EnvironmentResult {
  const base = climateDefinition(settings.climatePreset);
  const configuredTemperature = Number.isFinite(settings.baseTemperatureC)
    ? settings.baseTemperatureC
    : base.temperature;
  const configuredPrecipitation = Number.isFinite(settings.basePrecipitationMm)
    ? settings.basePrecipitationMm
    : base.precipitation;
  const configuredHumidity = clamp(Number.isFinite(settings.baseHumidity) ? settings.baseHumidity : base.humidity, 0.05, 0.99);
  const referenceLatitude = Math.abs(Number.isFinite(settings.climateReferenceLatitudeDeg) ? settings.climateReferenceLatitudeDeg : settings.latitudeDeg);
  const mapLatitudeSpan = Math.min(170, settings.mapScaleKm * (height / Math.max(1, width)) / 111);
  const latitudeAt = (y: number) => clamp(settings.latitudeDeg + (0.5 - y / Math.max(1, height - 1)) * mapLatitudeSpan, -89, 89);
  const baseTemperature = configuredTemperature + settings.temperature * 12;
  const basePrecipitation = Math.max(20, configuredPrecipitation * (1 + settings.moisture * 0.65));
  const fallbackWindSpeed = Math.max(0.2, settings.prevailingWindSpeed || base.windSpeed);
  const distances = computeOceanDistance(elevation, width, height, seaLevel);
  const size = width * height;
  const temperatureMap = new Array<number>(size);
  const windXMap = new Array<number>(size);
  const windYMap = new Array<number>(size);
  const gradientX = new Float64Array(size);
  const gradientY = new Float64Array(size);
  const seasonOffset = SEASON_OFFSETS[settings.season] ?? 0;
  const localScale = settings.mapScaleKm <= 50;
  const continentalScale = settings.mapScaleKm >= 1600;
  const cellKm = settings.mapScaleKm / Math.max(width, height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const left = elevation[y * width + Math.max(0, x - 1)];
      const right = elevation[y * width + Math.min(width - 1, x + 1)];
      const up = elevation[Math.max(0, y - 1) * width + x];
      const down = elevation[Math.min(height - 1, y + 1) * width + x];
      const gradX = (right - left) / Math.max(1, 2 * cellKm * 1000);
      const gradY = (down - up) / Math.max(1, 2 * cellKm * 1000);
      gradientX[index] = gradX;
      gradientY[index] = gradY;

      const configuredWind = configuredWindAt(settings, x / Math.max(1, width - 1), y / Math.max(1, height - 1));
      const baseWindX = Number.isFinite(configuredWind.x) ? configuredWind.x : fallbackWindSpeed;
      const baseWindY = Number.isFinite(configuredWind.y) ? configuredWind.y : 0;
      const obstacle = clamp(Math.max(0, elevation[index] - seaLevel) / Math.max(800, settings.maxElevation));
      const cross = baseWindX * gradY - baseWindY * gradX;
      const terrainDeflection = Math.max(-0.7, Math.min(0.7, cross * 8));
      const regionalTurn = (fractalNoise(x / 55, y / 55, settings.seed + 22_141, 3, 0.52, 2.03) - 0.5)
        * (localScale ? 0.28 : 0.48);
      const deflection = terrainDeflection + regionalTurn;
      const cosine = Math.cos(deflection);
      const sine = Math.sin(deflection);
      const localRelief = Math.hypot(gradX, gradY);
      const valleyBoost = 1 + Math.max(0, 0.18 - localRelief) * 0.8;
      const shelter = 1 - obstacle * 0.3;
      const speedNoise = (fractalNoise(x / 38, y / 38, settings.seed + 12_091, 3, 0.52, 2.03) - 0.5) * 0.18;
      windXMap[index] = (baseWindX * cosine - baseWindY * sine) * valleyBoost * shelter * (1 + speedNoise);
      windYMap[index] = (baseWindX * sine + baseWindY * cosine) * valleyBoost * shelter * (1 + speedNoise);

      const cellLatitude = latitudeAt(y);
      const latitudeDifference = Math.abs(cellLatitude) - referenceLatitude;
      const latitudeEffect = -latitudeDifference * (continentalScale ? 0.62 : 0.48);
      const lapse = Math.max(0, elevation[index] - seaLevel) / 1000 * 6.2;
      const oceanModeration = Number.isFinite(distances[index])
        ? Math.exp(-distances[index] / Math.max(3, Math.min(width, height) * (localScale ? 0.2 : 0.12)))
        : 0;
      const aspectSolar = Math.max(-2.2, Math.min(2.2, -gradY * (settings.season === "winter" ? 2.4 : 1.4)));
      const temperatureNoise = (fractalNoise(x / 45, y / 45, settings.seed + 3401, 4, 0.52, 2.03) - 0.5)
        * (localScale ? 0.8 : 2.1);
      const regionalTemperature = (fractalPerlinNoise(x / 62, y / 62, settings.seed + 9107, 4, 0.56, 2.05) - 0.5)
        * (localScale ? 0.55 : 1.15);
      temperatureMap[index] = baseTemperature
        + seasonOffset
        + latitudeEffect
        - lapse
        + oceanModeration * (localScale ? 0.8 : 2.5)
        + aspectSolar
        + temperatureNoise
        + regionalTemperature;
    }
  }

  /*
   * 반(半)라그랑주식 반복 수분 운반. 단일 projectionOrder 패스 대신
   * 각 셀의 실제 국지 풍향에서 상류 수분을 반복 샘플링한다.
   */
  let vapor = new Float64Array(size);
  const accumulatedRain = new Float64Array(size);
  for (let index = 0; index < size; index += 1) {
    const ocean = elevation[index] <= seaLevel;
    const coastal = Number.isFinite(distances[index])
      ? Math.exp(-distances[index] / Math.max(3, Math.min(width, height) * 0.16))
      : 0;
    vapor[index] = ocean ? 1.15 : configuredHumidity * 0.18 + coastal * 0.22;
  }

  const iterations = Math.max(6, Math.min(12, Math.round(Math.sqrt(size) / 34)));
  for (let pass = 0; pass < iterations; pass += 1) {
    const next = new Float64Array(size);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = y * width + x;
        const wx = windXMap[index];
        const wy = windYMap[index];
        const speed = Math.max(0.15, Math.hypot(wx, wy));
        const ux = wx / speed;
        const uy = wy / speed;
        const step = 0.9 + Math.min(1.4, speed / 9);
        const upstreamX = x - ux * step;
        const upstreamY = y - uy * step;
        const upstreamVapor = sampleBilinear(vapor, width, height, upstreamX, upstreamY);
        const upstreamElevation = sampleBilinear(elevation, width, height, upstreamX, upstreamY);
        const coastal = Number.isFinite(distances[index])
          ? Math.exp(-distances[index] / Math.max(4, Math.min(width, height) * 0.18))
          : 0;
        const ocean = elevation[index] <= seaLevel;
        const source = ocean ? 0.3 : coastal * 0.025;
        const available = Math.min(1.6, upstreamVapor * 0.992 + source);
        const upliftKm = Math.max(0, elevation[index] - upstreamElevation) / 1000;
        const descentKm = Math.max(0, upstreamElevation - elevation[index]) / 1000;
        const coldCondensation = Math.max(0, 7 - temperatureMap[index]) / 120;
        const condensationRate = clamp(0.035 + upliftKm * 0.24 + coldCondensation, 0.018, 0.58);
        const rainSignal = available * condensationRate * Math.exp(-descentKm * 0.72);
        accumulatedRain[index] += rainSignal;
        const recycling = ocean ? 0 : Math.min(0.025, accumulatedRain[index] * 0.003);
        next[index] = Math.max(0.012, available - rainSignal + recycling);
      }
    }
    vapor = next;
  }

  const precipitationMap = new Array<number>(size);
  const moistureMap = new Array<number>(size);
  const runoffMap = new Array<number>(size);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const latitude = Math.abs(latitudeAt(y)) / 90;
      const equatorialWet = Math.exp(-(latitude * latitude) / 0.055);
      const subtropicalDry = Math.exp(-Math.pow(latitude - 0.33, 2) / 0.018);
      const temperateWet = Math.exp(-Math.pow(latitude - 0.58, 2) / 0.04);
      const circulationFactor = continentalScale
        ? clamp(0.82 + equatorialWet * 0.24 - subtropicalDry * 0.28 + temperateWet * 0.1, 0.55, 1.28)
        : 1;
      const interiorDryness = Number.isFinite(distances[index])
        ? clamp(1 - distances[index] / Math.max(width, height) * (continentalScale ? 0.72 : 0.28), 0.48, 1)
        : 0.6;
      const seasonalDry = settings.climatePreset === "mediterranean" && settings.season === "summer" ? 0.52 : 1;
      const rainSignal = accumulatedRain[index] / iterations;
      const noise = 0.9 + fractalNoise(x / 36, y / 36, settings.seed + 7919, 4, 0.54, 2.03) * 0.2;
      const regionalRain = 0.94 + fractalPerlinNoise(x / 54, y / 54, settings.seed + 12017, 4, 0.56, 2.04) * 0.12;
      const coastal = Number.isFinite(distances[index])
        ? Math.exp(-distances[index] / Math.max(4, Math.min(width, height) * 0.18))
        : 0;
      const precipitation = Math.max(
        4,
        basePrecipitation
          * (0.42 + rainSignal * 1.48 + coastal * 0.12)
          * circulationFactor
          * interiorDryness
          * seasonalDry
          * noise
          * regionalRain,
      );
      precipitationMap[index] = elevation[index] <= seaLevel
        ? Math.max(basePrecipitation * 0.72, precipitation)
        : precipitation;
      moistureMap[index] = clamp(
        precipitationMap[index] / Math.max(300, basePrecipitation * 1.35) * 0.76
          + vapor[index] * 0.24,
      );

      const temperature = temperatureMap[index];
      const potentialEvapotranspiration = Math.max(60, 17 * Math.max(0, temperature + 7));
      const slope = Math.hypot(gradientX[index], gradientY[index]);
      const infiltration = precipitationMap[index] * (0.12 + clamp(0.18 - slope * 0.3, 0, 0.18));
      runoffMap[index] = elevation[index] <= seaLevel
        ? 0
        : Math.max(0, precipitationMap[index] - potentialEvapotranspiration * 0.58 - infiltration);
    }
  }

  const smoothedTemperature = smooth(temperatureMap, width, height, localScale ? 2 : 1);
  const smoothedPrecipitation = smooth(precipitationMap, width, height, 2);
  const smoothedMoisture = smooth(moistureMap, width, height, 2).map((value) => clamp(value));
  const smoothedRunoff = smooth(runoffMap, width, height, 1).map((value) => Math.max(0, value));
  const relativeHumidityMap = new Array<number>(size);
  const solarHoursMap = new Array<number>(size);
  const solarIrradianceMap = new Array<number>(size);
  const centerLatitude = settings.climateReferenceLatitudeDeg ?? settings.latitudeDeg ?? 38;
  const solar = solarGeometry(centerLatitude, settings.season);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const humidity = clamp(smoothedMoisture[index] * 0.58 + Math.min(1, smoothedPrecipitation[index] / 1800) * 0.22 + configuredHumidity * 0.2);
      relativeHumidityMap[index] = Math.round(clamp(0.14 + humidity * 0.82, 0.08, 0.99) * 1000) / 10;
      const cloudFraction = clamp(smoothedPrecipitation[index] / Math.max(450, basePrecipitation * 1.7) * 0.58 + humidity * 0.25, 0.05, 0.88);
      const slopeX = gradientX[index];
      const slopeY = gradientY[index];
      const slopeMagnitude = Math.min(1.2, Math.hypot(slopeX, slopeY) * 4.5);
      const hemisphereSunY = centerLatitude >= 0 ? -1 : 1;
      const aspectExposure = clamp(0.72 + (-slopeY * hemisphereSunY) * 3.2 - Math.abs(slopeX) * 0.45, 0.32, 1.22);
      const horizonLoss = clamp(slopeMagnitude * 0.18, 0, 0.35);
      const sunshine = solar.dayLength * (1 - cloudFraction * 0.72) * (1 - horizonLoss);
      solarHoursMap[index] = Math.round(clamp(sunshine, 0, solar.dayLength) * 100) / 100;
      const clearSkyDaily = 1361 * Math.sin(solar.noonAltitudeRad) * solar.dayLength / 1000;
      const altitudeGain = 1 + Math.max(0, elevation[index] - seaLevel) / 10000 * 0.09;
      solarIrradianceMap[index] = Math.round(Math.max(0, clearSkyDaily * (1 - cloudFraction * 0.68) * aspectExposure * altitudeGain) * 100) / 100;
    }
  }
  const snowBaseTerrainMap = elevation.map((value, index) => terrainFor(
    value,
    seaLevel,
    settings.maxElevation,
    smoothedTemperature[index],
    smoothedPrecipitation[index],
    smoothedMoisture[index],
    smoothedRunoff[index],
    Math.hypot(gradientX[index], gradientY[index]),
    index,
    settings,
  ));
  const snowCoverMap = elevation.map((value, index) => snowCoverageFor(
    value,
    seaLevel,
    settings.maxElevation,
    smoothedTemperature[index],
    smoothedPrecipitation[index],
  ));
  let terrainMap = snowBaseTerrainMap.map((terrain, index) => {
    const persistentSnow = snowCoverMap[index] >= 0.74 && elevation[index] - seaLevel > 250;
    return persistentSnow ? "snow" : terrain;
  });

  // 월드의 실제 km 면적이 작을수록 지형 패치가 더 크고 연속적으로 보이게 한다.
  const physicalAreaKm2 = Math.max(1, settings.mapScaleKm * settings.mapScaleKm * height / Math.max(1, width));
  const patchScale = clamp(Math.pow(160_000 / physicalAreaKm2, 0.18), 0.58, 3.4);
  const forestNoiseDivisor = 24 * patchScale;

  // 평원·초원에는 기후 적합도와 군집 노이즈에 따라 숲을 확률적으로 배치한다.
  terrainMap = terrainMap.map((terrain, index) => {
    if (terrain !== "plain" && terrain !== "grassland") return terrain;
    const x = index % width;
    const y = Math.floor(index / width);
    const temperatureSuitability = clamp(1 - Math.abs(smoothedTemperature[index] - 15) / 19);
    const precipitationSuitability = clamp((smoothedPrecipitation[index] - 280) / 1250);
    const moistureSuitability = clamp((smoothedMoisture[index] - 0.28) / 0.62);
    const waterBonus = clamp(smoothedRunoff[index] / 850) * 0.1;
    const cluster = fractalPerlinNoise(x / forestNoiseDivisor, y / forestNoiseDivisor, settings.seed + 44_117, 4, 0.58, 2.02);
    const chance = clamp(0.015 + precipitationSuitability * 0.2 + moistureSuitability * 0.2 + temperatureSuitability * 0.08 + waterBonus + Math.max(0, cluster - 0.42) * 0.42, 0, 0.62);
    return cluster > 0.45 && deterministicCellRandom(x, y, settings.seed + 91_331) < chance ? "forest" : terrain;
  });

  // 숲은 독립 셀로 흩어지지 않고 기존 숲 패치의 주변으로 확산한다.
  // 두 번의 군집 성장과 내부 공백 메우기를 통해 큰 숲 덩어리와 자연스러운 가장자리를 만든다.
  for (let pass = 0; pass < Math.max(2, Math.min(5, Math.round(1.5 + patchScale))); pass += 1) {
    const clustered = [...terrainMap];
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const index = y * width + x;
        if (terrainMap[index] !== "plain" && terrainMap[index] !== "grassland" && terrainMap[index] !== "forest") continue;
        let forestNeighbors = 0;
        let eligibleNeighbors = 0;
        for (let oy = -1; oy <= 1; oy += 1) for (let ox = -1; ox <= 1; ox += 1) {
          if (ox === 0 && oy === 0) continue;
          const nearby = terrainMap[(y + oy) * width + x + ox];
          if (nearby === "forest") forestNeighbors += 1;
          if (nearby === "forest" || nearby === "plain" || nearby === "grassland") eligibleNeighbors += 1;
        }
        const suitable = smoothedTemperature[index] > -4 && smoothedTemperature[index] < 31
          && smoothedPrecipitation[index] > 360 && smoothedMoisture[index] > 0.31;
        if (terrainMap[index] !== "forest" && suitable && forestNeighbors >= 2) {
          const growthChance = clamp(0.18 + forestNeighbors * 0.105 + smoothedMoisture[index] * 0.18, 0, 0.92);
          if (deterministicCellRandom(x, y, settings.seed + 137_111 + pass * 977) < growthChance) clustered[index] = "forest";
        } else if (terrainMap[index] === "forest" && forestNeighbors <= 1 && eligibleNeighbors >= 6) {
          if (deterministicCellRandom(x, y, settings.seed + 173_071 + pass * 557) < 0.72) clustered[index] = smoothedMoisture[index] > 0.48 ? "grassland" : "plain";
        }
      }
    }
    terrainMap = clustered;
  }

  // 10여 km 지역 지도에서 물리적 근거 없는 사막·설원 공존을 제거한다.
  if (localScale) {
    const hasDesert = terrainMap.includes("desert");
    const hasSnow = terrainMap.includes("snow");
    let minimumLandElevation = Number.POSITIVE_INFINITY;
    let maximumLandElevation = Number.NEGATIVE_INFINITY;
    for (const value of elevation) if (value > seaLevel) {
      minimumLandElevation = Math.min(minimumLandElevation, value);
      maximumLandElevation = Math.max(maximumLandElevation, value);
    }
    const elevationRange = Number.isFinite(minimumLandElevation) ? maximumLandElevation - minimumLandElevation : 0;
    if (hasDesert && hasSnow && elevationRange < 2800) {
      terrainMap = terrainMap.map((terrain, index) => terrain === "desert"
        ? (smoothedPrecipitation[index] < 260 ? "rock" : "grassland")
        : terrain);
    }
  }

  // 모든 지형에 패치 스케일을 적용한다. 작은 월드는 다수결 정리를 더 반복해 큰 연속 덩어리를 만든다.
  let cleaned = [...terrainMap];
  const cleanupPasses = Math.max(1, Math.min(5, Math.round(patchScale * 1.35)));
  for (let pass = 0; pass < cleanupPasses; pass += 1) {
    const source = [...cleaned];
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const index = y * width + x;
        if (elevation[index] <= seaLevel) continue;
        const counts = new Map<TerrainType, number>();
        for (let oy = -1; oy <= 1; oy += 1) {
          for (let ox = -1; ox <= 1; ox += 1) {
            const terrain = source[(y + oy) * width + x + ox];
            counts.set(terrain, (counts.get(terrain) ?? 0) + 1);
          }
        }
        const [major, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
        const protectedTerrain = ["mountain", "rock", "bedrock", "snow"].includes(source[index]);
        const threshold = patchScale >= 1.45 ? 5 : 6;
        if (count >= threshold && major !== source[index] && !protectedTerrain) cleaned[index] = major;
      }
    }
  }
  // 농경지는 자연 지형 단계에서 생성하지 않는다. 도시 배치 후 별도 후처리에서만 추가한다.
  cleaned = cleaned.map((terrain) => terrain === "farmland" ? "plain" : terrain);

  return {
    temperatureMap: smoothedTemperature,
    precipitationMap: smoothedPrecipitation,
    moistureMap: smoothedMoisture,
    relativeHumidityMap,
    solarHoursMap,
    solarIrradianceMap,
    runoffMap: smoothedRunoff,
    windXMap,
    windYMap,
    terrainMap: cleaned,
    snowCoverMap,
    snowBaseTerrainMap,
  };
}
