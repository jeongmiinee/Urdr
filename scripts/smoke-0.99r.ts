import { readFile } from "node:fs/promises";
import { generateWorldMap } from "../src/generator/generateWorld";
import { applyGeneratedCountries } from "../src/generator/mapPlacement";
import {
  createEmptyMap,
  createEmptyProject,
  defaultGeneratorSettings,
  timelineFromActiveCalendarFields,
} from "../src/model/world";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function boundaryIndices(width: number, height: number): number[] {
  const out = new Set<number>();
  for (let x = 0; x < width; x += 1) { out.add(x); out.add((height - 1) * width + x); }
  for (let y = 0; y < height; y += 1) { out.add(y * width); out.add(y * width + width - 1); }
  return [...out];
}
function gridIndexForPoint(x: number, y: number, worldWidth: number, worldHeight: number, gridWidth: number, gridHeight: number): number {
  const gx = Math.max(0, Math.min(gridWidth - 1, Math.round(x / Math.max(1, worldWidth) * (gridWidth - 1))));
  const gy = Math.max(0, Math.min(gridHeight - 1, Math.round(y / Math.max(1, worldHeight) * (gridHeight - 1))));
  return gy * gridWidth + gx;
}

const base = {
  ...defaultGeneratorSettings(),
  renderResolution: 160,
  analysisResolution: 128,
  gridWidth: 160,
  gridHeight: 100,
  generateCountries: false,
  riverNodeCount: 24,
};
const inland = generateWorldMap({ ...base, seed: 9901, mapScope: "local", mapScaleKm: 80, localRegionType: "inland" }, 160, 100, "preview");
const inlandBoundary = boundaryIndices(inland.gridWidth, inland.gridHeight);
assert(inlandBoundary.every((i) => inland.waterTypeMap[i] === "land"), "내륙형 경계가 모두 육지가 아님");

const coastSettings = {
  ...base,
  seed: 9902,
  mapScope: "regional" as const,
  mapScaleKm: 500,
  localRegionType: "coast" as const,
  localBoundary: {
    north: [{ start: 0, end: 1, kind: "land" as const }],
    east: [{ start: 0, end: 0.5, kind: "land" as const }, { start: 0.5, end: 1, kind: "water" as const }],
    south: [{ start: 0, end: 1, kind: "water" as const }],
    west: [{ start: 0, end: 1, kind: "land" as const }],
  },
};
const coast = generateWorldMap(coastSettings, 160, 100, "preview");
const top = Array.from({ length: coast.gridWidth }, (_, x) => coast.waterTypeMap[x]);
const bottom = Array.from({ length: coast.gridWidth }, (_, x) => coast.waterTypeMap[(coast.gridHeight - 1) * coast.gridWidth + x]);
assert(top.every((v) => v === "land"), "해안형 북쪽 육지 제약 실패");
assert(bottom.every((v) => v !== "land"), "해안형 남쪽 바다 제약 실패");

const global = generateWorldMap({
  ...base,
  seed: 9903,
  mapScope: "continent",
  mapScaleKm: 6000,
  cornerWinds: {
    northWest: { directionDeg: 0, speed: 4 }, northEast: { directionDeg: 90, speed: 8 },
    southWest: { directionDeg: 180, speed: 6 }, southEast: { directionDeg: 270, speed: 10 },
  },
}, 160, 100, "preview");
const nw = 0;
const se = global.windXMap.length - 1;
const cornerWindDelta = Math.abs(global.windXMap[nw] - global.windXMap[se]) + Math.abs(global.windYMap[nw] - global.windYMap[se]);
assert(cornerWindDelta > 1, "모서리 풍향 보간 차이가 없음");

const project = createEmptyProject("검증");
const free = createEmptyMap("자유", 160, 100, "free", "regional", 500);
const realistic = createEmptyMap("현실", 160, 100, "realistic", "regional", 500);
project.maps = [free, realistic];
assert(project.maps[0].generationMode === "free" && project.maps[1].generationMode === "realistic", "지도별 엔진 저장 실패");
assert(realistic.editorMode === "view", "지도별 편집 모드 기본값 실패");
const zeroYear = timelineFromActiveCalendarFields(project, realistic.timeline, { year: 0, dateValues: [1, 1], timeValues: [0, 0] }, null);
assert(zeroYear.currentYear === 0, "연도 0이 다른 숫자로 치환됨");

// 국가 영토는 경쟁 확산 뒤 침식→팽창 모폴로지 후처리를 거쳐 유효 폴리곤으로 만들어져야 한다.
const countryGenerated = generateWorldMap({ ...coastSettings, seed: 9904, generateCountries: true, countryCount: 3 }, 160, 100, "preview");
const countryMap = createEmptyMap("영토", 160, 100, "realistic", "regional", 500);
const countryResult = applyGeneratedCountries(countryMap, countryGenerated);
assert(countryResult.map.territories.length > 0, "모폴로지 후처리된 국가 영토가 생성되지 않음");
assert(countryResult.map.territories.every((territory) => territory.states.every((state) => state.value.polygon.length >= 3)), "영토 폴리곤이 유효하지 않음");

const demo = JSON.parse(await readFile(new URL("../src/demoProjectData.json", import.meta.url), "utf8"));
const demoMap = demo.maps?.[0];
const demoGenerated = demoMap?.generatedStates?.[0]?.value;
assert(demo.version === "0.99r", "데모 버전이 0.99r이 아님");
assert(demoMap?.physicalWidthKm === 500, "데모 지도 물리 폭이 500km가 아님");
assert(demoMap?.scaleMode === "regional", "데모 지도 규모가 지역 지도가 아님");
assert(demoGenerated?.settings?.mapScaleKm === 500, "데모 생성 설정이 500km가 아님");
const nonCountryIds = new Set(demoMap.factions.filter((faction: { id: string; kind: string }) => faction.kind !== "country").map((faction: { id: string }) => faction.id));
assert(demoMap.factions.filter((faction: { kind: string }) => faction.kind !== "country").every((faction: { hasTerritory?: boolean; territoryHidden?: boolean }) => faction.hasTerritory !== true && faction.territoryHidden !== true), "데모 세력·단체가 기본 영토를 가짐");
assert(demoMap.territories.every((territory: { states: Array<{ value: { ownerFactionId?: string } }> }) => territory.states.every((state) => !state.value.ownerFactionId || !nonCountryIds.has(state.value.ownerFactionId))), "데모에 세력·단체 소유 영토가 있음");

// 생성된 장소와 길의 점은 담수 호수 타일 위에 놓이지 않아야 한다.
for (const location of demoMap.locations) {
  const state = location.states?.[0]?.value;
  if (!state) continue;
  const index = gridIndexForPoint(state.position.x, state.position.y, demoMap.width, demoMap.height, demoGenerated.gridWidth, demoGenerated.gridHeight);
  assert(demoGenerated.waterTypeMap[index] === "land", `장소가 수역 위에 있음: ${state.name}`);
}
for (const road of demoMap.roads ?? []) {
  for (const state of road.states ?? []) {
    for (const point of state.value?.points ?? []) {
      const index = gridIndexForPoint(point.x, point.y, demoMap.width, demoMap.height, demoGenerated.gridWidth, demoGenerated.gridHeight);
      assert(demoGenerated.waterTypeMap[index] === "land", "길이 호수 또는 바다 위를 지남");
    }
  }
}

console.log(JSON.stringify({
  status: "passed",
  inlandBoundaryLand: inlandBoundary.length,
  coastNorthLand: top.length,
  coastSouthWater: bottom.length,
  cornerWindDelta: Number(cornerWindDelta.toFixed(3)),
  territoryCount: countryResult.map.territories.length,
  demoWidthKm: demoMap.physicalWidthKm,
  demoArticles: demo.wikiArticles?.length ?? 0,
  demoLakes: demoGenerated.lakeSurfaceElevations?.length ?? 0,
  yearZero: zeroYear.currentYear,
}, null, 2));
