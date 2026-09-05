import type { ClimatePreset, KoppenClimateCode, TerrainType } from "../model/world";

export type TerrainPrior = Partial<Record<TerrainType, number>>;

const A: TerrainPrior = { jungle: 0.34, forest: 0.28, wetland: 0.08, grassland: 0.12, plain: 0.08, farmland: 0.06, rock: 0.02, mountain: 0.02 };
const BWH: TerrainPrior = { desert: 0.62, rock: 0.16, plain: 0.1, grassland: 0.04, mountain: 0.05, farmland: 0.01, wetland: 0.01, forest: 0.01 };
const BSH: TerrainPrior = { desert: 0.28, grassland: 0.3, plain: 0.2, rock: 0.08, farmland: 0.06, forest: 0.03, wetland: 0.02, mountain: 0.03 };
const CSA: TerrainPrior = { forest: 0.2, grassland: 0.26, plain: 0.2, farmland: 0.18, rock: 0.07, desert: 0.03, wetland: 0.02, mountain: 0.04 };
const CFB: TerrainPrior = { forest: 0.34, grassland: 0.2, plain: 0.18, farmland: 0.16, wetland: 0.05, rock: 0.02, mountain: 0.05 };
const DFA: TerrainPrior = { forest: 0.34, grassland: 0.2, plain: 0.18, farmland: 0.13, wetland: 0.04, rock: 0.03, mountain: 0.06, snow: 0.02 };
const DFC: TerrainPrior = { forest: 0.44, grassland: 0.14, plain: 0.1, wetland: 0.06, rock: 0.06, mountain: 0.1, snow: 0.1 };
const ET: TerrainPrior = { snow: 0.34, rock: 0.2, plain: 0.13, grassland: 0.12, wetland: 0.05, mountain: 0.16 };
const EF: TerrainPrior = { snow: 0.68, rock: 0.12, mountain: 0.18, bedrock: 0.02 };

function blend(base: TerrainPrior, overrides: TerrainPrior): TerrainPrior {
  return { ...base, ...overrides };
}

/**
 * World Archive 런타임용 압축 기후-지형 사전확률.
 * 실제 좌표를 포함하지 않으며 전 지구 토지피복·기후·고도 표본을 집계하는
 * research-data 파이프라인의 출력 형식과 동일하다.
 */
export const KOPPEN_TERRAIN_PRIORS: Record<KoppenClimateCode, TerrainPrior> = {
  Af: blend(A, { jungle: 0.48, forest: 0.24, wetland: 0.09, grassland: 0.07 }),
  Am: blend(A, { jungle: 0.4, forest: 0.27, wetland: 0.09, grassland: 0.09 }),
  Aw: blend(A, { jungle: 0.2, forest: 0.22, grassland: 0.32, plain: 0.1, farmland: 0.08 }),
  As: blend(A, { jungle: 0.18, forest: 0.21, grassland: 0.33, plain: 0.11, farmland: 0.09 }),
  BWh: BWH,
  BWk: blend(BWH, { desert: 0.52, rock: 0.2, plain: 0.12, grassland: 0.05, mountain: 0.08 }),
  BSh: BSH,
  BSk: blend(BSH, { desert: 0.21, grassland: 0.34, plain: 0.22, rock: 0.09, mountain: 0.06 }),
  Csa: CSA,
  Csb: blend(CSA, { forest: 0.25, grassland: 0.25, plain: 0.18, farmland: 0.17, mountain: 0.06 }),
  Csc: blend(CSA, { forest: 0.24, grassland: 0.2, plain: 0.13, farmland: 0.1, rock: 0.09, mountain: 0.15, snow: 0.03 }),
  Cwa: blend(CFB, { forest: 0.3, grassland: 0.18, plain: 0.17, farmland: 0.19, wetland: 0.05 }),
  Cwb: blend(CFB, { forest: 0.31, grassland: 0.2, plain: 0.15, farmland: 0.16, mountain: 0.08 }),
  Cwc: blend(CFB, { forest: 0.28, grassland: 0.16, plain: 0.12, farmland: 0.1, rock: 0.07, mountain: 0.18, snow: 0.04 }),
  Cfa: blend(CFB, { forest: 0.32, grassland: 0.18, plain: 0.18, farmland: 0.18, wetland: 0.06 }),
  Cfb: CFB,
  Cfc: blend(CFB, { forest: 0.3, grassland: 0.17, plain: 0.13, farmland: 0.08, wetland: 0.07, rock: 0.06, mountain: 0.13, snow: 0.04 }),
  Dsa: blend(DFA, { forest: 0.29, grassland: 0.22, plain: 0.16, farmland: 0.12, rock: 0.06, mountain: 0.1 }),
  Dsb: blend(DFA, { forest: 0.32, grassland: 0.2, plain: 0.14, farmland: 0.1, mountain: 0.11, snow: 0.04 }),
  Dsc: blend(DFC, { forest: 0.39, grassland: 0.14, plain: 0.09, wetland: 0.05, rock: 0.08, mountain: 0.13, snow: 0.1 }),
  Dsd: blend(DFC, { forest: 0.34, grassland: 0.11, plain: 0.07, wetland: 0.04, rock: 0.1, mountain: 0.17, snow: 0.15 }),
  Dwa: blend(DFA, { forest: 0.33, grassland: 0.19, plain: 0.17, farmland: 0.14, wetland: 0.04 }),
  Dwb: blend(DFA, { forest: 0.36, grassland: 0.17, plain: 0.14, farmland: 0.11, mountain: 0.08, snow: 0.03 }),
  Dwc: blend(DFC, { forest: 0.4, grassland: 0.13, plain: 0.09, wetland: 0.05, rock: 0.07, mountain: 0.13, snow: 0.11 }),
  Dwd: blend(DFC, { forest: 0.35, grassland: 0.1, plain: 0.07, wetland: 0.04, rock: 0.1, mountain: 0.17, snow: 0.15 }),
  Dfa: DFA,
  Dfb: blend(DFA, { forest: 0.37, grassland: 0.18, plain: 0.15, farmland: 0.11, mountain: 0.08, snow: 0.03 }),
  Dfc: DFC,
  Dfd: blend(DFC, { forest: 0.38, grassland: 0.1, plain: 0.07, wetland: 0.04, rock: 0.1, mountain: 0.16, snow: 0.14 }),
  ET,
  EF,
};

const PRESET_ALIAS: Partial<Record<ClimatePreset, KoppenClimateCode>> = {
  temperate_oceanic: "Cfb",
  temperate_continental: "Dfb",
  mediterranean: "Csa",
  tropical_humid: "Af",
  arid: "BWh",
  polar: "ET",
  alpine: "ET",
  custom: "Cfb",
};

export function terrainPriorForClimate(preset: ClimatePreset): TerrainPrior {
  const code = (preset in KOPPEN_TERRAIN_PRIORS ? preset : PRESET_ALIAS[preset] ?? "Cfb") as KoppenClimateCode;
  return KOPPEN_TERRAIN_PRIORS[code];
}

export const TERRAIN_ATLAS_METADATA = {
  schemaVersion: 1,
  climateClasses: 31,
  layers: ["landform", "naturalCover", "landUse", "hydrologyCoast"],
  coordinatePolicy: "aggregated-statistics-only",
  intendedSources: ["Koppen-Geiger", "CHELSA/WorldClim", "ESA WorldCover", "Copernicus DEM", "SoilGrids", "HydroSHEDS", "GLWD"],
} as const;
