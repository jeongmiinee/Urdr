import { createGridTransform, sampleCellDerivedFieldAtWorld } from "../generator/gridTransform";
import type {
  AgricultureAssessment,
  GeneratedMapData,
  MapData,
  Point,
  Season,
  TerrainType,
  TimelineState,
  WorldProject,
} from "../model/world";
import { generatedAtYear, worldDayLengthMinutes, worldYearLengthDays } from "../model/world";
import { calculatePointAssessments } from "./agriculture";
import { climateDefinition } from "../generator/climatePresets";
import { effectiveTerrainAt } from "../generator/agriculture";

export const MONTH_LABELS = ["1월", "2월", "3월", "4월", "5월", "6월", "7월", "8월", "9월", "10월", "11월", "12월"] as const;

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;
const SEASON_OFFSETS: Record<Season, number> = { spring: 2, summer: 8, autumn: 1, winter: -8 };

const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value));
const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const round = (value: number, digits = 1) => Number(value.toFixed(digits));

export type MonthlyEnvironmentPoint = {
  month: number;
  season: Season;
  temperatureC: number;
  /** 지형과 계절만 반영한 평년값. */
  normalTemperatureC: number;
  temperatureAnomalyC: number;
  precipitationMm: number;
  normalPrecipitationMm: number;
  precipitationAnomalyMm: number;
  relativeHumidityPercent: number;
  windDirectionDeg: number;
  windSpeedMs: number;
  solarHours: number;
  solarIrradianceKWhM2: number;
  snowfallMm: number;
  snowpackMm: number;
  evapotranspirationMm: number;
  soilMoisturePercent: number;
  waterAccessIndex: number;
  runoffMm: number;
};

export type SeasonalEnvironmentSummary = {
  season: Season;
  months: number[];
  meanTemperatureC: number;
  precipitationMm: number;
  humidityRange: [number, number];
  soilMoistureRange: [number, number];
  snowRange: [number, number];
};

export type EnvironmentMetricRange = { min: number; max: number; mean: number };

export type EnvironmentLocationAnalysis = {
  position: Point;
  gridX: number;
  gridY: number;
  index: number;
  latitudeDeg: number;
  elevationM: number;
  terrain: TerrainType;
  isLand: boolean;
  currentYear: number;
  selectedMonth: number;
  current: MonthlyEnvironmentPoint;
  previousMonth: MonthlyEnvironmentPoint;
  previousYear: MonthlyEnvironmentPoint;
  monthly: MonthlyEnvironmentPoint[];
  seasonal: SeasonalEnvironmentSummary[];
  annual: {
    meanTemperatureC: number;
    annualPrecipitationMm: number;
    meanHumidityPercent: number;
    meanSolarHours: number;
    totalSnowfallMm: number;
    totalEvapotranspirationMm: number;
    temperature: EnvironmentMetricRange;
    precipitation: EnvironmentMetricRange;
    humidity: EnvironmentMetricRange;
    soilMoisture: EnvironmentMetricRange;
    snowpack: EnvironmentMetricRange;
  };
  cropAssessments: AgricultureAssessment[];
  livestockAssessments: AgricultureAssessment[];
  comparisonLabel: string;
  comparison: {
    temperatureC: number;
    precipitationMm: number;
    humidityPercent: number;
    soilMoisturePercent: number;
    waterAccessIndex: number;
  };
};

function seasonForMonth(month: number, latitudeDeg: number): Season {
  const north = latitudeDeg >= 0;
  if (north) {
    if ([3, 4, 5].includes(month)) return "spring";
    if ([6, 7, 8].includes(month)) return "summer";
    if ([9, 10, 11].includes(month)) return "autumn";
    return "winter";
  }
  if ([9, 10, 11].includes(month)) return "spring";
  if ([12, 1, 2].includes(month)) return "summer";
  if ([3, 4, 5].includes(month)) return "autumn";
  return "winter";
}

export function representativeMonth(season: Season, latitudeDeg: number): number {
  const north = latitudeDeg >= 0;
  if (north) return season === "spring" ? 4 : season === "summer" ? 7 : season === "autumn" ? 10 : 1;
  return season === "spring" ? 10 : season === "summer" ? 1 : season === "autumn" ? 4 : 7;
}

function dayOfYearForMonth(month: number): number {
  let day = 15;
  for (let index = 1; index < month; index += 1) day += DAYS_IN_MONTH[index - 1];
  return day;
}

function solarGeometry(latitudeDeg: number, month: number): { dayLength: number; extraterrestrialKWhM2: number } {
  const latitude = clamp(latitudeDeg, -89, 89) * Math.PI / 180;
  const day = dayOfYearForMonth(month);
  const declination = 23.44 * Math.sin((2 * Math.PI * (284 + day)) / 365) * Math.PI / 180;
  const cosineHour = clamp(-Math.tan(latitude) * Math.tan(declination), -1, 1);
  const hourAngle = Math.acos(cosineHour);
  const dayLength = 24 * hourAngle / Math.PI;
  const noonAltitude = Math.max(0.01, Math.PI / 2 - Math.abs(latitude - declination));
  const extraterrestrialKWhM2 = Math.max(0, 1.361 * Math.sin(noonAltitude) * dayLength);
  return { dayLength, extraterrestrialKWhM2 };
}

function generatedSeasonDayLength(data: GeneratedMapData, latitudeDeg: number): number {
  return solarGeometry(latitudeDeg, representativeMonth(data.settings.season, latitudeDeg)).dayLength;
}

function normalizedPattern(pattern: number[]): number[] {
  const average = mean(pattern);
  return pattern.map((value) => value / Math.max(0.001, average));
}

function rawTemporalSignal(seed: number, spatialKey: number, timeKey: number, salt: number): number {
  let value = Math.imul((seed + salt * 97) | 0, 374761393) ^ Math.imul((spatialKey + 1) | 0, 668265263) ^ Math.imul((timeKey + 4096) | 0, 1442695041);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return (((value ^ (value >>> 16)) >>> 0) / 4294967295) * 2 - 1;
}

/** 절대 시점을 기준으로 과거 신호를 가중 평균해 여러 해·여러 달 이어지는 기후 국면을 만든다. */
function persistentTemporalSignal(seed: number, spatialKey: number, timeKey: number, salt: number, persistence: number, window = 8): number {
  let total = 0; let weightTotal = 0;
  const p = clamp(persistence, 0, 0.96);
  for (let lag = 0; lag < window; lag += 1) {
    const weight = Math.pow(p, lag);
    total += rawTemporalSignal(seed, spatialKey, timeKey - lag, salt) * weight;
    weightTotal += weight;
  }
  return total / Math.max(1e-6, weightTotal);
}

function localLatitude(data: GeneratedMapData, point: Point): number {
  const yRatio = clamp(point.y / Math.max(1, data.worldHeight));
  const latSpan = data.settings.mapScope === "continent"
    ? clamp(data.settings.mapScaleKm / 140, 8, 36)
    : clamp(data.settings.mapScaleKm / 80, 0.2, 2.2);
  return clamp(data.settings.latitudeDeg + (0.5 - yRatio) * latSpan, -88.5, 88.5);
}

function pointIndex(data: GeneratedMapData, point: Point): { gridX: number; gridY: number; index: number } {
  const cell = createGridTransform(data.worldWidth, data.worldHeight, data.gridWidth, data.gridHeight).worldToCell(point);
  return { gridX: cell.x, gridY: cell.y, index: cell.index };
}

export function dynamicWindAt(data: GeneratedMapData, point: Point, year: number, month: number): { directionDeg: number; speedMs: number } {
  const { gridX, gridY, index } = pointIndex(data, point);
  const baseWindX = data.windXMap[index] ?? 0;
  const baseWindY = data.windYMap[index] ?? 0;
  const baseWindSpeed = Math.max(0.1, Math.hypot(baseWindX, baseWindY));
  const baseWindDirection = (Math.atan2(baseWindY, baseWindX) * 180 / Math.PI + 360) % 360;
  const variability = clamp(data.settings.climateVariability ?? 0.55);
  const persistence = clamp(data.settings.climatePersistence ?? 0.72);
  const extremeFrequency = clamp(data.settings.extremeEventFrequency ?? 0.12);
  const latitudeDeg = localLatitude(data, point);
  const safeMonth = Math.max(1, Math.min(12, Math.round(month)));
  const absoluteMonth = year * 12 + safeMonth - 1;
  const regionKey = Math.floor(gridX / Math.max(4, Math.round(data.gridWidth / 16))) + Math.floor(gridY / Math.max(4, Math.round(data.gridHeight / 12))) * 31;
  const pattern = normalizedPattern(climateDefinition(data.settings.climatePreset).monthlyPrecipitationPattern);
  const annualTurn = persistentTemporalSignal(data.settings.seed, regionKey, year, 53, 0.68 + persistence * 0.22, 8);
  const annualSpeed = persistentTemporalSignal(data.settings.seed, regionKey, year, 59, 0.62 + persistence * 0.2, 7);
  const monthlyTurn = persistentTemporalSignal(data.settings.seed, regionKey, absoluteMonth, 113, 0.68 + persistence * 0.2, 7);
  const localTurn = persistentTemporalSignal(data.settings.seed, index, absoluteMonth, 127, 0.46 + persistence * 0.16, 4);
  const extremeRoll = (rawTemporalSignal(data.settings.seed, regionKey, absoluteMonth, 97) + 1) / 2;
  const extremeDirection = rawTemporalSignal(data.settings.seed, index, absoluteMonth, 101);
  const extremeActive = extremeRoll > 1 - extremeFrequency * 0.16;
  const seasonalCycle = Math.cos((safeMonth - (latitudeDeg >= 0 ? 7 : 1)) / 12 * Math.PI * 2);
  const seasonalTurn = Math.sin((safeMonth - 1) / 12 * Math.PI * 2) * (7 + variability * 8);
  const monsoonTurn = clamp(pattern[safeMonth - 1] - 1, -0.7, 0.9) * (12 + variability * 22) * (Math.abs(latitudeDeg) < 38 ? 1 : 0.35);
  const stormTurn = extremeActive ? extremeDirection * (18 + variability * 32) : 0;
  const turn = annualTurn * (9 + variability * 18) + monthlyTurn * (8 + variability * 16) + localTurn * (4 + variability * 9) + seasonalTurn + monsoonTurn + stormTurn;
  const directionDeg = ((baseWindDirection + turn) % 360 + 360) % 360;
  const speedFactor = 1 + Math.abs(seasonalCycle) * 0.08 + annualSpeed * variability * 0.12 + Math.abs(monthlyTurn) * variability * 0.08 + (extremeActive ? 0.22 + Math.abs(extremeDirection) * 0.38 : 0);
  return { directionDeg, speedMs: Math.max(0.1, baseWindSpeed * Math.max(0.45, speedFactor)) };
}

function nearbyFreshwaterScore(data: GeneratedMapData, gridX: number, gridY: number): number {
  let best = 0;
  const radius = 8;
  for (let oy = -radius; oy <= radius; oy += 1) {
    for (let ox = -radius; ox <= radius; ox += 1) {
      const x = gridX + ox;
      const y = gridY + oy;
      if (x < 0 || y < 0 || x >= data.gridWidth || y >= data.gridHeight) continue;
      const index = y * data.gridWidth + x;
      if (data.waterTypeMap?.[index] !== "freshwater") continue;
      best = Math.max(best, 1 - Math.hypot(ox, oy) / (radius + 0.001));
    }
  }
  return clamp(best);
}

function nearbyRiverOrder(data: GeneratedMapData, gridX: number, gridY: number): number {
  let order = data.riverOrderMap[gridY * data.gridWidth + gridX] ?? 0;
  for (let oy = -3; oy <= 3; oy += 1) {
    for (let ox = -3; ox <= 3; ox += 1) {
      const x = gridX + ox;
      const y = gridY + oy;
      if (x < 0 || y < 0 || x >= data.gridWidth || y >= data.gridHeight) continue;
      const candidate = data.riverOrderMap[y * data.gridWidth + x] ?? 0;
      order = Math.max(order, candidate - Math.hypot(ox, oy) * 0.22);
    }
  }
  return Math.max(0, order);
}

function range(values: number[]): EnvironmentMetricRange {
  return { min: Math.min(...values), max: Math.max(...values), mean: mean(values) };
}

function buildMonthlySeries(data: GeneratedMapData, point: Point, year: number): MonthlyEnvironmentPoint[] {
  const { gridX, gridY, index } = pointIndex(data, point);
  const latitudeDeg = localLatitude(data, point);
  const baseTemperature = (data.temperatureMap[index] ?? data.settings.baseTemperatureC) - SEASON_OFFSETS[data.settings.season];
  const annualPrecipitation = Math.max(1, data.precipitationMap[index] ?? data.settings.basePrecipitationMm);
  const baseHumidity = clamp(data.relativeHumidityMap[index] ?? (data.moistureMap[index] ?? 0.5) * 100, 4, 100);
  const baseMoisture = clamp((data.moistureMap[index] ?? baseHumidity / 100) * 100, 0, 100);
  const generatedDayLength = generatedSeasonDayLength(data, latitudeDeg);
  const localSunFraction = clamp((data.solarHoursMap[index] ?? generatedDayLength * 0.55) / Math.max(0.1, generatedDayLength), 0.08, 1.08);
  const generatedSolar = solarGeometry(latitudeDeg, representativeMonth(data.settings.season, latitudeDeg));
  const localIrradianceFraction = clamp((data.solarIrradianceMap[index] ?? generatedSolar.extraterrestrialKWhM2 * 0.45) / Math.max(0.1, generatedSolar.extraterrestrialKWhM2), 0.05, 1.15);
  const dryness = 1 - baseHumidity / 100;
  // 연교차는 최고월-최저월 차이이므로 코사인 진폭은 절반을 사용한다.
  const configuredAnnualRange = clamp(data.settings.annualTemperatureRangeC ?? (9 + Math.abs(latitudeDeg) * 0.32 + dryness * 8), 2, 60);
  const oceanModeration = data.settings.mapScope === "local" ? 0.94 : 1;
  const amplitude = configuredAnnualRange * 0.5 * oceanModeration;
  const peakMonth = latitudeDeg >= 0 ? 7 : 1;
  const pattern = normalizedPattern(climateDefinition(data.settings.climatePreset).monthlyPrecipitationPattern);
  const flowMax = data.flowAccumulationMap.reduce((maximum, value) => Math.max(maximum, value), 1);
  const flow = Math.max(0, data.flowAccumulationMap[index] ?? 0);
  const flowScore = Math.log1p(flow) / Math.log1p(flowMax);
  const riverOrder = nearbyRiverOrder(data, gridX, gridY);
  const freshwaterScore = nearbyFreshwaterScore(data, gridX, gridY);
  const runoffAnnual = Math.max(0, data.runoffMap[index] ?? 0);
  const variability = clamp(data.settings.climateVariability ?? 0.55);
  const persistence = clamp(data.settings.climatePersistence ?? 0.72);
  const extremeFrequency = clamp(data.settings.extremeEventFrequency ?? 0.12);
  const regionKey = Math.floor(gridX / Math.max(4, Math.round(data.gridWidth / 16))) + Math.floor(gridY / Math.max(4, Math.round(data.gridHeight / 12))) * 31;
  const globalAnnual = persistentTemporalSignal(data.settings.seed, 0, year, 11, persistence, 10);
  const regionalAnnual = persistentTemporalSignal(data.settings.seed, regionKey, year, 17, persistence, 8);
  const localAnnual = persistentTemporalSignal(data.settings.seed, index, year, 29, persistence * 0.72, 5);
  const temperatureAnnualAnomaly = (globalAnnual * 1.45 + regionalAnnual * 0.9 + localAnnual * 0.42) * variability;
  const wetAnnualSignal = persistentTemporalSignal(data.settings.seed, regionKey, year, 41, persistence, 9) - globalAnnual * 0.16;
  const precipitationAnnualFactor = Math.exp(wetAnnualSignal * variability * 0.24);
  const result: MonthlyEnvironmentPoint[] = [];
  let snowpack = 0;
  let soilStore = baseMoisture;

  for (let month = 1; month <= 12; month += 1) {
    const cycle = Math.cos((month - peakMonth) / 12 * Math.PI * 2);
    const normalTemperatureC = baseTemperature + amplitude * cycle;
    const normalPrecipitationMm = Math.max(0, annualPrecipitation / 12 * pattern[month - 1]);
    const absoluteMonth = year * 12 + month - 1;
    const monthlyTemperatureSignal = persistentTemporalSignal(data.settings.seed, regionKey, absoluteMonth, 67, 0.58 + persistence * 0.25, 5);
    const monthlyWetSignal = persistentTemporalSignal(data.settings.seed, index, absoluteMonth, 79, 0.5 + persistence * 0.25, 4);
    const extremeRoll = (rawTemporalSignal(data.settings.seed, regionKey, absoluteMonth, 97) + 1) / 2;
    const extremeDirection = rawTemporalSignal(data.settings.seed, index, absoluteMonth, 101);
    const extremeActive = extremeRoll > 1 - extremeFrequency * 0.16;
    const extremeTemperature = extremeActive ? Math.sign(extremeDirection || 1) * (2.5 + Math.abs(extremeDirection) * 4.5) * variability : 0;
    const extremePrecipitationFactor = extremeActive
      ? (extremeDirection > 0 ? 1.35 + Math.abs(extremeDirection) * 1.25 : 0.35 + (1 - Math.abs(extremeDirection)) * 0.35)
      : 1;
    const temperatureC = normalTemperatureC + temperatureAnnualAnomaly + monthlyTemperatureSignal * variability * 1.35 + extremeTemperature;
    const precipitationMm = Math.max(0, normalPrecipitationMm * precipitationAnnualFactor * Math.exp(monthlyWetSignal * variability * 0.3) * extremePrecipitationFactor);
    const solar = solarGeometry(latitudeDeg, month);
    const cloudAdjustment = clamp(1.08 - pattern[month - 1] * 0.11, 0.72, 1.16);
    const solarHours = clamp(solar.dayLength * localSunFraction * cloudAdjustment, 0, solar.dayLength);
    const solarIrradianceKWhM2 = Math.max(0, solar.extraterrestrialKWhM2 * localIrradianceFraction * cloudAdjustment);
    const humiditySeasonal = (pattern[month - 1] - 1) * 12 - (temperatureC - baseTemperature) * 0.33;
    const relativeHumidityPercent = clamp(baseHumidity + humiditySeasonal, 5, 100);

    const dynamicWind = dynamicWindAt(data, point, year, month);
    const windDirectionDeg = dynamicWind.directionDeg;
    const windSpeedMs = dynamicWind.speedMs;
    const snowFraction = clamp((2.5 - temperatureC) / 7, 0, 1);
    const snowfallMm = precipitationMm * snowFraction;
    const meltMm = Math.max(0, temperatureC) * (7 + solarIrradianceKWhM2 * 0.8);
    snowpack = Math.max(0, snowpack * 0.78 + snowfallMm - meltMm);
    const dailyRadiationMj = solarIrradianceKWhM2 * 3.6;
    const temperatureRange = clamp(5 + amplitude * 0.42 + dryness * 3, 4, 15);
    const evapotranspirationMm = Math.max(0, 0.0023 * (temperatureC + 17.8) * Math.sqrt(temperatureRange) * dailyRadiationMj * DAYS_IN_MONTH[month - 1]);
    const waterBalance = precipitationMm + snowfallMm * 0.15 - evapotranspirationMm;
    soilStore = clamp(soilStore * 0.76 + baseMoisture * 0.24 + waterBalance * 0.085 + snowpack * 0.018, 0, 100);
    const soilMoisturePercent = soilStore;
    const runoffMm = Math.max(0, runoffAnnual / 12 * pattern[month - 1] + Math.max(0, waterBalance) * 0.18);
    const waterAccessIndex = clamp(
      10 + flowScore * 34 + Math.min(5, riverOrder) * 7 + freshwaterScore * 26 + clamp(runoffMm / 80) * 13 + soilMoisturePercent * 0.17,
      0,
      100,
    );
    result.push({
      month,
      season: seasonForMonth(month, latitudeDeg),
      temperatureC: round(temperatureC, 1),
      normalTemperatureC: round(normalTemperatureC, 1),
      temperatureAnomalyC: round(temperatureC - normalTemperatureC, 1),
      precipitationMm: round(precipitationMm, 1),
      normalPrecipitationMm: round(normalPrecipitationMm, 1),
      precipitationAnomalyMm: round(precipitationMm - normalPrecipitationMm, 1),
      relativeHumidityPercent: round(relativeHumidityPercent, 1),
      windDirectionDeg: round(windDirectionDeg, 0),
      windSpeedMs: round(windSpeedMs, 1),
      solarHours: round(solarHours, 1),
      solarIrradianceKWhM2: round(solarIrradianceKWhM2, 2),
      snowfallMm: round(snowfallMm, 1),
      snowpackMm: round(snowpack, 1),
      evapotranspirationMm: round(evapotranspirationMm, 1),
      soilMoisturePercent: round(soilMoisturePercent, 1),
      waterAccessIndex: round(waterAccessIndex, 0),
      runoffMm: round(runoffMm, 1),
    });
  }
  return result;
}

function seasonalSummary(monthly: MonthlyEnvironmentPoint[]): SeasonalEnvironmentSummary[] {
  const order: Season[] = ["spring", "summer", "autumn", "winter"];
  return order.map((season) => {
    const rows = monthly.filter((item) => item.season === season);
    const humidity = rows.map((item) => item.relativeHumidityPercent);
    const soil = rows.map((item) => item.soilMoisturePercent);
    const snow = rows.map((item) => item.snowpackMm);
    return {
      season,
      months: rows.map((item) => item.month),
      meanTemperatureC: round(mean(rows.map((item) => item.temperatureC)), 1),
      precipitationMm: round(rows.reduce((sum, item) => sum + item.precipitationMm, 0), 1),
      humidityRange: [Math.min(...humidity), Math.max(...humidity)],
      soilMoistureRange: [Math.min(...soil), Math.max(...soil)],
      snowRange: [Math.min(...snow), Math.max(...snow)],
    };
  });
}

function previousGeneratedState(map: MapData): { data: GeneratedMapData; year: number } | null {
  const currentYear = map.timeline.currentYear;
  const current = map.generatedStates
    .filter((state) => state.value && state.startYear <= currentYear && (state.endYear === null || state.endYear >= currentYear))
    .sort((a, b) => b.startYear - a.startYear)[0];
  if (!current) return null;
  const previous = map.generatedStates
    .filter((state) => state.value && state.startYear < current.startYear)
    .sort((a, b) => b.startYear - a.startYear)[0];
  return previous?.value ? { data: previous.value, year: previous.endYear ?? previous.startYear } : null;
}

export function findDefaultEnvironmentPoint(map: MapData, data: GeneratedMapData): Point {
  if (map.environmentPins[0]) return map.environmentPins[0].position;
  const centerX = Math.floor(data.gridWidth / 2);
  const centerY = Math.floor(data.gridHeight / 2);
  let bestIndex = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < data.elevationMap.length; index += 1) {
    if ((data.waterTypeMap?.[index] ?? (data.elevationMap[index] > data.seaLevel ? "land" : "saltwater")) !== "land") continue;
    const x = index % data.gridWidth;
    const y = Math.floor(index / data.gridWidth);
    const distance = Math.hypot(x - centerX, y - centerY);
    if (distance < bestDistance) { bestDistance = distance; bestIndex = index; }
  }
  if (bestIndex < 0) return { x: map.width / 2, y: map.height / 2 };
  return {
    x: ((bestIndex % data.gridWidth) + 0.5) / data.gridWidth * map.width,
    y: (Math.floor(bestIndex / data.gridWidth) + 0.5) / data.gridHeight * map.height,
  };
}

export function analyzeEnvironmentLocation(map: MapData, position: Point, selectedMonth: number): EnvironmentLocationAnalysis | null {
  const data = generatedAtYear(map);
  if (!data) return null;
  const point = {
    x: clamp(position.x, 0, map.width),
    y: clamp(position.y, 0, map.height),
  };
  const month = Math.max(1, Math.min(12, Math.round(selectedMonth)));
  const { gridX, gridY, index } = pointIndex(data, point);
  const latitudeDeg = localLatitude(data, point);
  const monthly = buildMonthlySeries(data, point, map.timeline.currentYear);
  const current = monthly[month - 1];
  const previousMonth = monthly[(month + 10) % 12];
  const previousState = previousGeneratedState(map);
  const previousYearSeries = previousState
    ? buildMonthlySeries(previousState.data, point, previousState.year)
    : buildMonthlySeries(data, point, map.timeline.currentYear - 1);
  const previousYear = previousYearSeries[month - 1];
  const annualPrecipitationMm = monthly.reduce((sum, item) => sum + item.precipitationMm, 0);
  const meanTemperatureC = mean(monthly.map((item) => item.temperatureC));
  const meanHumidityPercent = mean(monthly.map((item) => item.relativeHumidityPercent));
  const meanSolarHours = mean(monthly.map((item) => item.solarHours));
  const isLand = (data.waterTypeMap?.[index] ?? ((data.elevationMap[index] ?? data.seaLevel) > data.seaLevel ? "land" : "saltwater")) === "land";
  const calculatedAssessments = calculatePointAssessments({
    meanTemperatureC,
    annualPrecipitationMm,
    meanHumidityPercent,
    meanSolarHours,
  });
  const assessments = isLand ? calculatedAssessments : {
    cropAssessments: calculatedAssessments.cropAssessments.map((item) => ({ ...item, suitability: 0, productionIndex: 0, band: "very_low" as const, strengths: [], riskLabels: ["해양 지점"], explanation: `${item.name} 적합도는 육지 지점에서만 계산됩니다.` })),
    livestockAssessments: calculatedAssessments.livestockAssessments.map((item) => ({ ...item, suitability: 0, productionIndex: 0, band: "very_low" as const, strengths: [], riskLabels: ["해양 지점"], explanation: `${item.name} 적합도는 육지 지점에서만 계산됩니다.` })),
  };
  return {
    position: point,
    gridX,
    gridY,
    index,
    latitudeDeg: round(latitudeDeg, 2),
    elevationM: Math.round(sampleCellDerivedFieldAtWorld(
      data.elevationMap,
      data.gridWidth,
      data.gridHeight,
      data.worldWidth,
      data.worldHeight,
      point,
    )),
    terrain: effectiveTerrainAt(data, index),
    isLand,
    currentYear: map.timeline.currentYear,
    selectedMonth: month,
    current,
    previousMonth,
    previousYear,
    monthly,
    seasonal: seasonalSummary(monthly),
    annual: {
      meanTemperatureC: round(meanTemperatureC, 1),
      annualPrecipitationMm: round(annualPrecipitationMm, 0),
      meanHumidityPercent: round(meanHumidityPercent, 1),
      meanSolarHours: round(meanSolarHours, 1),
      totalSnowfallMm: round(monthly.reduce((sum, item) => sum + item.snowfallMm, 0), 1),
      totalEvapotranspirationMm: round(monthly.reduce((sum, item) => sum + item.evapotranspirationMm, 0), 1),
      temperature: range(monthly.map((item) => item.temperatureC)),
      precipitation: range(monthly.map((item) => item.precipitationMm)),
      humidity: range(monthly.map((item) => item.relativeHumidityPercent)),
      soilMoisture: range(monthly.map((item) => item.soilMoisturePercent)),
      snowpack: range(monthly.map((item) => item.snowpackMm)),
    },
    cropAssessments: assessments.cropAssessments,
    livestockAssessments: assessments.livestockAssessments,
    comparisonLabel: previousState ? `${previousState.year}년 동일 월 대비` : `${map.timeline.currentYear - 1}년 동일 월 대비`,
    comparison: {
      temperatureC: round(current.temperatureC - previousYear.temperatureC, 1),
      precipitationMm: round(current.precipitationMm - previousYear.precipitationMm, 1),
      humidityPercent: round(current.relativeHumidityPercent - previousYear.relativeHumidityPercent, 1),
      soilMoisturePercent: round(current.soilMoisturePercent - previousYear.soilMoisturePercent, 1),
      waterAccessIndex: round(current.waterAccessIndex - previousYear.waterAccessIndex, 0),
    },
  };
}


export type LiveEnvironmentSnapshot = {
  mode: "annual" | "monthly" | "daily" | "weather";
  label: string;
  condition: string;
  temperatureC: number;
  /** 지형과 계절만 반영한 평년값. */
  normalTemperatureC?: number;
  temperatureAnomalyC?: number;
  precipitationMm: number;
  normalPrecipitationMm?: number;
  precipitationAnomalyMm?: number;
  precipitationUnit: string;
  relativeHumidityPercent: number;
  windDirectionDeg: number;
  windSpeedMs: number;
  solarHours: number;
  solarIrradianceKWhM2: number;
  snowfallMm: number;
  snowpackMm: number;
  evapotranspirationMm: number;
  soilMoisturePercent: number;
  waterAccessIndex: number;
  runoffMm: number;
};

function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }
function lerpDirection(a: number, b: number, t: number): number {
  const delta = ((b - a + 540) % 360) - 180;
  return (a + delta * t + 360) % 360;
}
function timelineNoise(seed: number, index: number, year: number, day: number, bucket: number, salt: number): number {
  const value = Math.sin(seed * 0.00191 + index * 0.0217 + year * 0.731 + day * 1.173 + bucket * 0.317 + salt * 3.71) * 43758.5453123;
  return (value - Math.floor(value)) * 2 - 1;
}

/** 날짜 정밀도에서는 월간 기후를 일 단위로 보간하고, 시각 정밀도에서는 일교차·강수 이벤트·돌풍을 더해 날씨를 만든다. */
export function liveEnvironmentAtTimeline(project: WorldProject, map: MapData, analysis: EnvironmentLocationAnalysis): LiveEnvironmentSnapshot {
  const timeline: TimelineState = map.timeline;
  const yearLength = worldYearLengthDays(project);
  if (timeline.precision === "year") {
    const months = analysis.monthly.length > 0 ? analysis.monthly : [analysis.current];
    const average = <K extends keyof (typeof months)[number]>(key: K) => months.reduce((sum, item) => sum + Number(item[key] ?? 0), 0) / months.length;
    const total = <K extends keyof (typeof months)[number]>(key: K) => months.reduce((sum, item) => sum + Number(item[key] ?? 0), 0);
    const selected = analysis.current;
    return {
      ...selected,
      mode: "annual",
      label: "연 평균 기후",
      condition: "연간 기후",
      temperatureC: round(average("temperatureC"), 1),
      precipitationMm: round(total("precipitationMm"), 0),
      precipitationUnit: "mm/년",
      relativeHumidityPercent: round(average("relativeHumidityPercent"), 1),
      windSpeedMs: round(average("windSpeedMs"), 1),
      solarHours: round(average("solarHours"), 1),
      solarIrradianceKWhM2: round(average("solarIrradianceKWhM2"), 2),
      snowfallMm: round(total("snowfallMm"), 1),
      snowpackMm: round(average("snowpackMm"), 1),
      evapotranspirationMm: round(total("evapotranspirationMm"), 1),
      soilMoisturePercent: round(average("soilMoisturePercent"), 1),
      waterAccessIndex: round(average("waterAccessIndex"), 1),
      runoffMm: round(total("runoffMm"), 1),
    };
  }
  if (timeline.precision === "month") {
    const monthIndex = Math.max(0, Math.min(11, Math.floor((timeline.currentDayOfYear / Math.max(1, yearLength)) * 12)));
    const selected = analysis.monthly[monthIndex] ?? analysis.current;
    return { ...selected, mode: "monthly", label: `${monthIndex + 1}월 평균 기후`, condition: "월 평균 기후", precipitationUnit: "mm/월" };
  }
  const dayLengthMinutes = worldDayLengthMinutes(project);
  const monthPosition = (Math.max(0, Math.min(yearLength - 1, timeline.currentDayOfYear)) / yearLength) * 12;
  const monthIndex = Math.floor(monthPosition) % 12;
  const nextMonthIndex = (monthIndex + 1) % 12;
  const fraction = monthPosition - Math.floor(monthPosition);
  const current = analysis.monthly[monthIndex] ?? analysis.current;
  const next = analysis.monthly[nextMonthIndex] ?? current;
  const climate = {
    temperatureC: lerp(current.temperatureC, next.temperatureC, fraction),
    precipitationMm: lerp(current.precipitationMm, next.precipitationMm, fraction),
    relativeHumidityPercent: lerp(current.relativeHumidityPercent, next.relativeHumidityPercent, fraction),
    windDirectionDeg: lerpDirection(current.windDirectionDeg, next.windDirectionDeg, fraction),
    windSpeedMs: lerp(current.windSpeedMs, next.windSpeedMs, fraction),
    solarHours: lerp(current.solarHours, next.solarHours, fraction),
    solarIrradianceKWhM2: lerp(current.solarIrradianceKWhM2, next.solarIrradianceKWhM2, fraction),
    snowfallMm: lerp(current.snowfallMm, next.snowfallMm, fraction),
    snowpackMm: lerp(current.snowpackMm, next.snowpackMm, fraction),
    evapotranspirationMm: lerp(current.evapotranspirationMm, next.evapotranspirationMm, fraction),
    soilMoisturePercent: lerp(current.soilMoisturePercent, next.soilMoisturePercent, fraction),
    waterAccessIndex: lerp(current.waterAccessIndex, next.waterAccessIndex, fraction),
    runoffMm: lerp(current.runoffMm, next.runoffMm, fraction),
  };
  const approximateDaysInClimateMonth = yearLength / 12;
  const dailyPrecipitation = climate.precipitationMm / approximateDaysInClimateMonth;
  const dailySnow = climate.snowfallMm / approximateDaysInClimateMonth;
  const dailyEvapotranspiration = climate.evapotranspirationMm / approximateDaysInClimateMonth;
  const dailyRunoff = climate.runoffMm / approximateDaysInClimateMonth;
  if (timeline.precision === "date") {
    const daySignal = timelineNoise(analysis.index + 17, analysis.index, timeline.currentYear, timeline.currentDayOfYear, 0, 5);
    const dailyTemperature = climate.temperatureC + daySignal * 1.4;
    const dailyHumidity = clamp(climate.relativeHumidityPercent - daySignal * 3.5, 5, 100);
    const rain = Math.max(0, dailyPrecipitation * (1 + daySignal * 0.45));
    const condition = rain > 6 ? "비" : rain > 1 ? "약한 비" : dailySnow > 1 ? "눈" : dailyHumidity > 82 ? "흐림" : "대체로 맑음";
    return { ...climate, mode: "daily", label: "현재 날짜의 기후", condition, temperatureC: round(dailyTemperature, 1), precipitationMm: round(rain, 1), precipitationUnit: "mm/일", relativeHumidityPercent: round(dailyHumidity, 1), snowfallMm: round(dailySnow, 1), evapotranspirationMm: round(dailyEvapotranspiration, 1), runoffMm: round(dailyRunoff, 1) };
  }

  const hour24 = timeline.currentMinuteOfDay / dayLengthMinutes * 24;
  const bucket = Math.floor(timeline.currentMinuteOfDay / Math.max(1, dayLengthMinutes / 24));
  const weatherSignal = timelineNoise(analysis.index + 31, analysis.index, timeline.currentYear, timeline.currentDayOfYear, bucket, 9);
  const eventSignal = timelineNoise(analysis.index + 47, analysis.index, timeline.currentYear, timeline.currentDayOfYear, Math.floor(bucket / 3), 13);
  const diurnalAmplitude = 2.2 + (100 - climate.relativeHumidityPercent) * 0.035;
  const diurnal = Math.cos((hour24 - 14) / 24 * Math.PI * 2) * diurnalAmplitude;
  const wetProbability = clamp(dailyPrecipitation / 12, 0.03, 0.82);
  const raining = (eventSignal + 1) / 2 < wetProbability;
  const precipitationRate = raining ? Math.max(0.1, dailyPrecipitation * (0.45 + Math.abs(weatherSignal) * 1.8)) : 0;
  const daylightStart = 12 - climate.solarHours / 2;
  const daylightEnd = 12 + climate.solarHours / 2;
  const daylight = hour24 >= daylightStart && hour24 <= daylightEnd;
  const solarFactor = daylight ? Math.sin(((hour24 - daylightStart) / Math.max(0.1, climate.solarHours)) * Math.PI) : 0;
  const temperatureC = climate.temperatureC + diurnal + weatherSignal * 0.8 - (raining ? 1.2 : 0);
  const humidity = clamp(climate.relativeHumidityPercent - diurnal * 1.8 + (raining ? 13 : 0) + weatherSignal * 2, 5, 100);
  const windSpeed = Math.max(0.1, climate.windSpeedMs * (1 + weatherSignal * 0.18 + (raining ? 0.14 : 0)));
  const windDirection = (climate.windDirectionDeg + weatherSignal * 16 + 360) % 360;
  const snowing = raining && temperatureC <= 1.5;
  const condition = snowing ? "눈" : precipitationRate > 4 ? "강한 비" : raining ? "비" : !daylight ? "맑은 밤" : humidity > 83 ? "흐림" : "맑음";
  return {
    ...climate,
    mode: "weather",
    label: "현재 시각의 날씨",
    condition,
    temperatureC: round(temperatureC, 1),
    precipitationMm: round(precipitationRate, 1),
    precipitationUnit: snowing ? "mm/h 눈" : "mm/h",
    relativeHumidityPercent: round(humidity, 1),
    windDirectionDeg: round(windDirection, 0),
    windSpeedMs: round(windSpeed, 1),
    solarHours: daylight ? round(climate.solarHours, 1) : 0,
    solarIrradianceKWhM2: round(climate.solarIrradianceKWhM2 * solarFactor * (raining ? 0.28 : 1), 2),
    snowfallMm: snowing ? round(precipitationRate, 1) : 0,
    evapotranspirationMm: round(dailyEvapotranspiration / 24, 2),
    runoffMm: round(raining ? precipitationRate * 0.18 : dailyRunoff / 24, 2),
  };
}
