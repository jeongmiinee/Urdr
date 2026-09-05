import type { EnvironmentEngineMode, GeneratedMapData } from "../model/world";

export type ExternalEnvironmentGrid = {
  width: number;
  height: number;
  temperatureC?: number[];
  relativeHumidityPercent?: number[];
  precipitationMm?: number[];
  solarHours?: number[];
  solarIrradianceKWhM2?: number[];
  windU?: number[];
  windV?: number[];
  metadata: {
    model: string;
    modelVersion?: string;
    source?: string;
    license: string;
    generatedAt?: string;
  };
};

export type EnvironmentModelAdapter = {
  id: string;
  label: string;
  mode: EnvironmentEngineMode;
  commercialUseNotice: string;
  canRunLocally: boolean;
  importResult(input: ExternalEnvironmentGrid, base: GeneratedMapData): GeneratedMapData;
};

function sameSize(values: number[] | undefined, size: number): values is number[] {
  return Boolean(values && values.length === size && values.every(Number.isFinite));
}

export const genericEnvironmentImportAdapter: EnvironmentModelAdapter = {
  id: "generic-environment-grid",
  label: "외부 환경 격자 가져오기",
  mode: "external_import",
  commercialUseNotice: "가져오는 모델 결과와 원천 데이터의 라이선스는 사용자가 별도로 확인해야 합니다.",
  canRunLocally: true,
  importResult(input, base) {
    if (input.width !== base.gridWidth || input.height !== base.gridHeight) {
      throw new Error("외부 환경 격자의 해상도가 현재 지도와 다릅니다. 먼저 동일 해상도로 재표본화하세요.");
    }
    const size = base.gridWidth * base.gridHeight;
    return {
      ...base,
      temperatureMap: sameSize(input.temperatureC, size) ? [...input.temperatureC] : base.temperatureMap,
      precipitationMap: sameSize(input.precipitationMm, size) ? [...input.precipitationMm] : base.precipitationMap,
      relativeHumidityMap: sameSize(input.relativeHumidityPercent, size) ? [...input.relativeHumidityPercent] : base.relativeHumidityMap,
      solarHoursMap: sameSize(input.solarHours, size) ? [...input.solarHours] : base.solarHoursMap,
      solarIrradianceMap: sameSize(input.solarIrradianceKWhM2, size) ? [...input.solarIrradianceKWhM2] : base.solarIrradianceMap,
      windXMap: sameSize(input.windU, size) ? [...input.windU] : base.windXMap,
      windYMap: sameSize(input.windV, size) ? [...input.windV] : base.windYMap,
      environmentModel: {
        engine: "external_import",
        version: input.metadata.modelVersion ?? "unknown",
        importedSource: `${input.metadata.model} · ${input.metadata.license}`,
      },
      generatedAt: input.metadata.generatedAt ?? new Date().toISOString(),
    };
  },
};
