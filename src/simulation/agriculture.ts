import type {
  AgricultureAssessment,
  EnvironmentSimulationSummary,
  GeneratedMapData,
  SimulationMode,
  SuitabilityBand,
} from "../model/world";

type CropProfile = {
  id: string;
  name: string;
  idealTemperature: [number, number];
  viableTemperature: [number, number];
  idealPrecipitation: [number, number];
  viablePrecipitation: [number, number];
  idealSolarHours: [number, number];
  frostSensitive: boolean;
  humidityPreference: [number, number];
};

type LivestockProfile = {
  id: string;
  name: string;
  idealTemperature: [number, number];
  viableTemperature: [number, number];
  idealHumidity: [number, number];
  idealPrecipitation: [number, number];
  heatSensitive: boolean;
  coldSensitive: boolean;
};

const CROPS: CropProfile[] = [
  { id: "wheat", name: "밀", idealTemperature: [12, 22], viableTemperature: [2, 30], idealPrecipitation: [450, 900], viablePrecipitation: [280, 1400], idealSolarHours: [7, 13], frostSensitive: false, humidityPreference: [35, 72] },
  { id: "rice", name: "벼", idealTemperature: [20, 30], viableTemperature: [12, 36], idealPrecipitation: [900, 1800], viablePrecipitation: [650, 2600], idealSolarHours: [6, 12], frostSensitive: true, humidityPreference: [58, 92] },
  { id: "barley", name: "보리", idealTemperature: [10, 20], viableTemperature: [0, 28], idealPrecipitation: [350, 750], viablePrecipitation: [220, 1200], idealSolarHours: [6, 13], frostSensitive: false, humidityPreference: [30, 68] },
  { id: "maize", name: "옥수수", idealTemperature: [18, 28], viableTemperature: [9, 35], idealPrecipitation: [500, 1100], viablePrecipitation: [350, 1600], idealSolarHours: [7, 14], frostSensitive: true, humidityPreference: [38, 76] },
  { id: "potato", name: "감자", idealTemperature: [10, 20], viableTemperature: [3, 27], idealPrecipitation: [500, 1000], viablePrecipitation: [350, 1500], idealSolarHours: [5, 12], frostSensitive: false, humidityPreference: [45, 82] },
  { id: "grape", name: "포도", idealTemperature: [15, 25], viableTemperature: [5, 33], idealPrecipitation: [350, 750], viablePrecipitation: [220, 1100], idealSolarHours: [8, 15], frostSensitive: true, humidityPreference: [28, 66] },
];

const LIVESTOCK: LivestockProfile[] = [
  { id: "cattle", name: "소", idealTemperature: [5, 22], viableTemperature: [-18, 34], idealHumidity: [35, 75], idealPrecipitation: [450, 1400], heatSensitive: true, coldSensitive: false },
  { id: "sheep", name: "양", idealTemperature: [2, 20], viableTemperature: [-24, 32], idealHumidity: [25, 68], idealPrecipitation: [250, 900], heatSensitive: false, coldSensitive: false },
  { id: "goat", name: "염소", idealTemperature: [8, 26], viableTemperature: [-8, 38], idealHumidity: [20, 65], idealPrecipitation: [180, 800], heatSensitive: false, coldSensitive: false },
  { id: "pig", name: "돼지", idealTemperature: [12, 24], viableTemperature: [2, 33], idealHumidity: [40, 75], idealPrecipitation: [400, 1500], heatSensitive: true, coldSensitive: true },
  { id: "horse", name: "말", idealTemperature: [5, 22], viableTemperature: [-20, 35], idealHumidity: [28, 72], idealPrecipitation: [300, 1100], heatSensitive: false, coldSensitive: false },
];

const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value));

function rangeScore(value: number, ideal: [number, number], viable: [number, number]): number {
  if (value >= ideal[0] && value <= ideal[1]) return 1;
  if (value < viable[0] || value > viable[1]) return 0;
  if (value < ideal[0]) return clamp((value - viable[0]) / Math.max(0.001, ideal[0] - viable[0]));
  return clamp((viable[1] - value) / Math.max(0.001, viable[1] - ideal[1]));
}

function softRangeScore(value: number, ideal: [number, number], tolerance = 0.7): number {
  if (value >= ideal[0] && value <= ideal[1]) return 1;
  const span = Math.max(1, ideal[1] - ideal[0]);
  const distance = value < ideal[0] ? ideal[0] - value : value - ideal[1];
  return clamp(1 - distance / (span * tolerance + 1));
}

function bandFor(score: number): SuitabilityBand {
  return score >= 0.82 ? "very_high" : score >= 0.64 ? "high" : score >= 0.44 ? "moderate" : score >= 0.23 ? "low" : "very_low";
}

function average(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function landIndices(data: GeneratedMapData): number[] {
  const result: number[] = [];
  for (let index = 0; index < data.elevationMap.length; index += 1) {
    if ((data.waterTypeMap?.[index] ?? (data.elevationMap[index] > data.seaLevel ? "land" : "saltwater")) === "land") result.push(index);
  }
  return result;
}

function landMean(map: number[], indices: number[]): number {
  return average(indices.map((index) => Number.isFinite(map[index]) ? map[index] : 0));
}

function buildCropAssessment(profile: CropProfile, temperature: number, precipitation: number, humidity: number, solarHours: number): AgricultureAssessment {
  const temperatureScore = rangeScore(temperature, profile.idealTemperature, profile.viableTemperature);
  const precipitationScore = rangeScore(precipitation, profile.idealPrecipitation, profile.viablePrecipitation);
  const solarScore = softRangeScore(solarHours, profile.idealSolarHours, 1.1);
  const humidityScore = softRangeScore(humidity, profile.humidityPreference, 1.2);
  const score = clamp(temperatureScore * 0.36 + precipitationScore * 0.29 + solarScore * 0.2 + humidityScore * 0.15);
  const risks: string[] = [];
  const strengths: string[] = [];
  if (temperature < profile.viableTemperature[0]) risks.push("저온·냉해 위험");
  if (temperature > profile.viableTemperature[1]) risks.push("고온 스트레스");
  if (precipitation < profile.viablePrecipitation[0]) risks.push("수분 부족·관개 필요");
  if (precipitation > profile.viablePrecipitation[1]) risks.push("과습·병해 위험");
  if (profile.frostSensitive && temperature < 8) risks.push("서리 민감");
  if (temperatureScore > 0.85) strengths.push("생육 적온");
  if (precipitationScore > 0.85) strengths.push("충분한 자연 강수");
  if (solarScore > 0.85) strengths.push("적정 일조");
  const activeMonths = Math.max(1, Math.min(12, Math.round(2 + temperatureScore * 5 + solarScore * 3 + precipitationScore * 2)));
  const waterDemandIndex = clamp(0.45 + Math.max(0, temperature - 15) / 35 - precipitationScore * 0.35);
  return {
    id: profile.id,
    kind: "crop",
    name: profile.name,
    suitability: Math.round(score * 100),
    band: bandFor(score),
    productionIndex: Math.round(score * (0.72 + precipitationScore * 0.28) * 100),
    activeMonths,
    waterDemandIndex: Math.round(waterDemandIndex * 100),
    riskLabels: risks,
    strengths,
    explanation: `${profile.name} 적합도는 기온 ${temperature.toFixed(1)}℃, 강수 ${Math.round(precipitation)}mm, 습도 ${humidity.toFixed(0)}%, 일조 ${solarHours.toFixed(1)}시간을 기준으로 계산되었습니다.`,
  };
}

function buildLivestockAssessment(profile: LivestockProfile, temperature: number, precipitation: number, humidity: number): AgricultureAssessment {
  const temperatureScore = rangeScore(temperature, profile.idealTemperature, profile.viableTemperature);
  const humidityScore = softRangeScore(humidity, profile.idealHumidity, 1.25);
  const pastureScore = softRangeScore(precipitation, profile.idealPrecipitation, 1.15);
  const score = clamp(temperatureScore * 0.48 + humidityScore * 0.22 + pastureScore * 0.3);
  const risks: string[] = [];
  const strengths: string[] = [];
  if (profile.heatSensitive && temperature > profile.idealTemperature[1]) risks.push("열 스트레스");
  if (profile.coldSensitive && temperature < profile.idealTemperature[0]) risks.push("한랭 스트레스");
  if (humidity > profile.idealHumidity[1] + 12) risks.push("고습도 질병 위험");
  if (precipitation < profile.idealPrecipitation[0]) risks.push("초지·사료 부족");
  if (temperatureScore > 0.85) strengths.push("사육 적온");
  if (pastureScore > 0.82) strengths.push("방목지 생산성 양호");
  const activeMonths = Math.max(1, Math.min(12, Math.round(4 + temperatureScore * 4 + pastureScore * 4)));
  const waterDemandIndex = clamp(0.35 + Math.max(0, temperature - 12) / 35 + (1 - pastureScore) * 0.15);
  return {
    id: profile.id,
    kind: "livestock",
    name: profile.name,
    suitability: Math.round(score * 100),
    band: bandFor(score),
    productionIndex: Math.round(score * 100),
    activeMonths,
    waterDemandIndex: Math.round(waterDemandIndex * 100),
    riskLabels: risks,
    strengths,
    explanation: `${profile.name} 적합도는 평균 기온 ${temperature.toFixed(1)}℃, 강수 ${Math.round(precipitation)}mm, 상대습도 ${humidity.toFixed(0)}%를 기준으로 계산되었습니다.`,
  };
}


export type PointSuitabilityInput = {
  meanTemperatureC: number;
  annualPrecipitationMm: number;
  meanHumidityPercent: number;
  meanSolarHours: number;
};

export function calculatePointAssessments(input: PointSuitabilityInput): {
  cropAssessments: AgricultureAssessment[];
  livestockAssessments: AgricultureAssessment[];
} {
  return {
    cropAssessments: CROPS.map((profile) => buildCropAssessment(
      profile,
      input.meanTemperatureC,
      input.annualPrecipitationMm,
      input.meanHumidityPercent,
      input.meanSolarHours,
    )),
    livestockAssessments: LIVESTOCK.map((profile) => buildLivestockAssessment(
      profile,
      input.meanTemperatureC,
      input.annualPrecipitationMm,
      input.meanHumidityPercent,
    )),
  };
}

export function calculateEnvironmentSimulation(data: GeneratedMapData, mode: SimulationMode): EnvironmentSimulationSummary {
  const indices = landIndices(data);
  const meanTemperatureC = landMean(data.temperatureMap, indices);
  const meanPrecipitationMm = landMean(data.precipitationMap, indices);
  const meanHumidityPercent = landMean(data.relativeHumidityMap ?? data.moistureMap.map((value) => value * 100), indices);
  const meanSolarHours = landMean(data.solarHoursMap ?? [], indices);
  const meanWindSpeed = average(indices.map((index) => Math.hypot(data.windXMap[index] ?? 0, data.windYMap[index] ?? 0)));
  const { cropAssessments, livestockAssessments } = calculatePointAssessments({
    meanTemperatureC,
    annualPrecipitationMm: meanPrecipitationMm,
    meanHumidityPercent,
    meanSolarHours,
  });
  return {
    generatedAt: new Date().toISOString(),
    mode,
    meanTemperatureC,
    meanPrecipitationMm,
    meanHumidityPercent,
    meanSolarHours,
    meanWindSpeed,
    cropAssessments,
    livestockAssessments,
    notes: mode === "realistic"
      ? ["환경값이 작물·목축 생산성의 기본 제약으로 적용됩니다.", "현재 결과는 내장 경량 모델의 지역 평균값이며 향후 외부 관측·재분석 데이터로 교체할 수 있습니다."]
      : ["자유 모드에서는 적합도를 참고 정보로만 표시하며 세계관 설정을 제한하지 않습니다."],
  };
}
