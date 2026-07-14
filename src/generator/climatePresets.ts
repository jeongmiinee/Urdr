import type { ClimatePreset, KoppenClimateCode } from "../model/world";

export type ClimatePresetDefinition = {
  code: ClimatePreset;
  label: string;
  group: string;
  referenceLatitude: number;
  temperature: number;
  precipitation: number;
  humidity: number;
  windSpeed: number;
  temperatureCorrection: number;
  moistureCorrection: number;
  monthlyPrecipitationPattern: number[];
};

const even = [1,1,1,1,1,1,1,1,1,1,1,1];
const summerWet = [0.35,0.4,0.55,0.8,1.25,1.65,1.85,1.7,1.25,0.8,0.5,0.35];
const winterWet = [1.55,1.45,1.25,0.95,0.55,0.3,0.22,0.25,0.45,0.85,1.25,1.55];
const monsoon = [0.22,0.28,0.45,0.8,1.35,2.1,2.4,2.25,1.7,0.9,0.38,0.22];
const dryWinter = [0.18,0.22,0.35,0.65,1.2,1.75,2.1,1.95,1.35,0.75,0.35,0.2];
const drySummer = winterWet;
const subarctic = [0.45,0.42,0.55,0.8,1.15,1.45,1.6,1.5,1.15,0.8,0.55,0.48];

function d(code: ClimatePreset, label: string, group: string, referenceLatitude: number, temperature: number, precipitation: number, humidity: number, windSpeed: number, pattern = even, temperatureCorrection = 0, moistureCorrection = 0): ClimatePresetDefinition {
  return { code, label, group, referenceLatitude, temperature, precipitation, humidity, windSpeed, monthlyPrecipitationPattern: pattern, temperatureCorrection, moistureCorrection };
}

export const KOPPEN_CLIMATE_CODES = [
  "Af","Am","Aw","As",
  "BWh","BWk","BSh","BSk",
  "Csa","Csb","Csc","Cwa","Cwb","Cwc","Cfa","Cfb","Cfc",
  "Dsa","Dsb","Dsc","Dsd","Dwa","Dwb","Dwc","Dwd","Dfa","Dfb","Dfc","Dfd",
  "ET","EF",
] as const satisfies readonly KoppenClimateCode[];

export const CLIMATE_PRESET_DEFINITIONS: ClimatePresetDefinition[] = [
  d("Af", "Af · 열대우림", "A · 열대", 5, 27, 2500, .91, 3.5, even, .08, .22),
  d("Am", "Am · 열대 몬순", "A · 열대", 12, 27, 2200, .86, 4, monsoon, .08, .18),
  d("Aw", "Aw · 사바나(겨울 건조)", "A · 열대", 15, 25, 1150, .66, 4.5, dryWinter, .06, .04),
  d("As", "As · 사바나(여름 건조)", "A · 열대", 15, 25, 1050, .62, 4.5, drySummer, .06, 0),
  d("BWh", "BWh · 고온 사막", "B · 건조", 25, 27, 110, .16, 6.5, even, .13, -.26),
  d("BWk", "BWk · 저온 사막", "B · 건조", 38, 12, 150, .22, 6.5, even, -.02, -.23),
  d("BSh", "BSh · 고온 스텝", "B · 건조", 22, 24, 360, .31, 6, summerWet, .09, -.16),
  d("BSk", "BSk · 저온 스텝", "B · 건조", 42, 9, 420, .36, 6, summerWet, -.03, -.13),
  d("Csa", "Csa · 고온 지중해성", "C · 온대", 36, 18, 520, .47, 4.5, drySummer, .06, -.10),
  d("Csb", "Csb · 온난 지중해성", "C · 온대", 42, 14, 650, .58, 5, drySummer, .01, -.04),
  d("Csc", "Csc · 냉량 지중해성", "C · 온대", 49, 9, 720, .63, 5.5, drySummer, -.04, 0),
  d("Cwa", "Cwa · 온대 겨울 건조·고온 여름", "C · 온대", 28, 18, 1050, .67, 4, dryWinter, .05, .07),
  d("Cwb", "Cwb · 온대 겨울 건조·온난 여름", "C · 온대", 34, 13, 920, .64, 4.5, dryWinter, 0, .04),
  d("Cwc", "Cwc · 온대 겨울 건조·냉량 여름", "C · 온대", 42, 8, 760, .61, 5, dryWinter, -.05, .02),
  d("Cfa", "Cfa · 온난 습윤", "C · 온대", 32, 19, 1250, .73, 4.5, summerWet, .04, .10),
  d("Cfb", "Cfb · 서안 해양성", "C · 온대", 46, 12, 1050, .74, 6, even, 0, .09),
  d("Cfc", "Cfc · 아극 해양성", "C · 온대", 57, 6, 1150, .79, 7.5, even, -.06, .12),
  d("Dsa", "Dsa · 냉대 여름 건조·고온 여름", "D · 냉대", 46, 8, 500, .48, 5.5, drySummer, -.03, -.08),
  d("Dsb", "Dsb · 냉대 여름 건조·온난 여름", "D · 냉대", 51, 5, 560, .52, 6, drySummer, -.06, -.05),
  d("Dsc", "Dsc · 냉대 여름 건조·냉량 여름", "D · 냉대", 58, 0, 620, .56, 6.5, drySummer, -.10, -.02),
  d("Dsd", "Dsd · 냉대 여름 건조·혹한 겨울", "D · 냉대", 64, -7, 520, .52, 7, drySummer, -.14, -.05),
  d("Dwa", "Dwa · 냉대 겨울 건조·고온 여름", "D · 냉대", 43, 10, 700, .55, 5, dryWinter, -.01, -.02),
  d("Dwb", "Dwb · 냉대 겨울 건조·온난 여름", "D · 냉대", 50, 4, 620, .54, 5.5, dryWinter, -.07, -.04),
  d("Dwc", "Dwc · 냉대 겨울 건조·냉량 여름", "D · 냉대", 58, -3, 520, .50, 6, dryWinter, -.12, -.06),
  d("Dwd", "Dwd · 냉대 겨울 건조·혹한 겨울", "D · 냉대", 65, -11, 430, .47, 6.5, dryWinter, -.17, -.08),
  d("Dfa", "Dfa · 냉대 습윤·고온 여름", "D · 냉대", 43, 11, 850, .61, 5, summerWet, -.01, .02),
  d("Dfb", "Dfb · 냉대 습윤·온난 여름", "D · 냉대", 50, 5, 760, .64, 5.5, subarctic, -.07, .04),
  d("Dfc", "Dfc · 아극·냉량 여름", "D · 냉대", 59, -2, 650, .66, 6.5, subarctic, -.12, .04),
  d("Dfd", "Dfd · 아극·혹한 겨울", "D · 냉대", 67, -12, 470, .58, 7.5, subarctic, -.18, -.02),
  d("ET", "ET · 툰드라", "E · 한대", 72, -6, 260, .49, 8, even, -.15, -.08),
  d("EF", "EF · 빙설", "E · 한대", 82, -22, 120, .38, 9, even, -.24, -.16),
  // 구버전 호환 프리셋
  d("temperate_oceanic", "온대 해양성(구버전)", "호환", 45, 13, 1050, .72, 6, even, 0, .08),
  d("temperate_continental", "온대 대륙성(구버전)", "호환", 48, 10, 680, .54, 5, summerWet, -.03, -.08),
  d("mediterranean", "지중해성(구버전)", "호환", 38, 18, 520, .46, 4, drySummer, .05, -.12),
  d("tropical_humid", "열대 습윤(구버전)", "호환", 8, 27, 2200, .9, 4, monsoon, .08, .18),
  d("arid", "건조(구버전)", "호환", 27, 24, 180, .18, 6, even, .1, -.22),
  d("polar", "한대(구버전)", "호환", 72, -14, 220, .42, 8, even, -.12, -.1),
  d("alpine", "고산(구버전)", "호환", 38, 5, 900, .62, 7, even, -.08, .04),
  d("custom", "사용자 지정", "사용자", 38, 15, 800, .58, 5, even),
];

export const CLIMATE_PRESET_BY_CODE = Object.fromEntries(CLIMATE_PRESET_DEFINITIONS.map((item) => [item.code, item])) as Record<ClimatePreset, ClimatePresetDefinition>;

export function climateDefinition(code: ClimatePreset): ClimatePresetDefinition {
  return CLIMATE_PRESET_BY_CODE[code] ?? CLIMATE_PRESET_BY_CODE.custom;
}

/** 쾨펜형별 대표 연교차. 월별 기온 곡선의 기본 진폭으로 사용한다. */
export function climateAnnualTemperatureRange(code: ClimatePreset): number {
  if (["Af", "Am"].includes(code)) return 4;
  if (["Aw", "As", "BWh", "BSh"].includes(code)) return 9;
  if (["Cfb", "Cfc", "temperate_oceanic"].includes(code)) return code === "Cfc" ? 12 : 10;
  if (["Csa", "Csb", "Csc"].includes(code)) return 16;
  if (["Cfa", "Cwa", "Cwb", "Cwc"].includes(code)) return 21;
  if (["BWk", "BSk", "temperate_continental"].includes(code)) return 27;
  if (String(code).startsWith("D")) return ["Dfc", "Dfd", "Dwc", "Dwd"].includes(code) ? 38 : 31;
  if (code === "ET") return 22;
  if (code === "EF" || code === "polar") return 28;
  if (code === "alpine") return 18;
  if (code === "tropical_humid") return 5;
  if (code === "arid") return 20;
  if (code === "mediterranean") return 16;
  return 18;
}
