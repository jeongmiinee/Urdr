import { readFile } from "node:fs/promises";
import { generateWorldMap } from "../src/generator/generateWorld";
import { createEmptyMap, createEmptyProject, defaultGeneratorSettings } from "../src/model/world";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function boundaryIndices(width: number, height: number): number[] {
  const out = new Set<number>();
  for (let x = 0; x < width; x += 1) { out.add(x); out.add((height - 1) * width + x); }
  for (let y = 0; y < height; y += 1) { out.add(y * width); out.add(y * width + width - 1); }
  return [...out];
}
const base = { ...defaultGeneratorSettings(), renderResolution: 160, analysisResolution: 128, gridWidth: 160, gridHeight: 100, generateCountries: false, riverNodeCount: 24 };
const inland = generateWorldMap({ ...base, seed: 9901, mapScope: "local", mapScaleKm: 80, localRegionType: "inland" }, 160, 100, "preview");
const inlandBoundary = boundaryIndices(inland.gridWidth, inland.gridHeight);
assert(inlandBoundary.every((i) => inland.waterTypeMap[i] === "land"), "내륙형 경계가 모두 육지가 아님");

const coast = generateWorldMap({
  ...base, seed: 9902, mapScope: "regional", mapScaleKm: 500, localRegionType: "coast",
  localBoundary: {
    north: [{ start: 0, end: 1, kind: "land" }],
    east: [{ start: 0, end: 0.5, kind: "land" }, { start: 0.5, end: 1, kind: "water" }],
    south: [{ start: 0, end: 1, kind: "water" }],
    west: [{ start: 0, end: 1, kind: "land" }],
  },
}, 160, 100, "preview");
const top = Array.from({length: coast.gridWidth}, (_, x) => coast.waterTypeMap[x]);
const bottom = Array.from({length: coast.gridWidth}, (_, x) => coast.waterTypeMap[(coast.gridHeight - 1) * coast.gridWidth + x]);
assert(top.every((v) => v === "land"), "해안형 북쪽 육지 제약 실패");
assert(bottom.every((v) => v !== "land"), "해안형 남쪽 바다 제약 실패");

const global = generateWorldMap({
  ...base, seed: 9903, mapScope: "continent", mapScaleKm: 6000,
  cornerWinds: {
    northWest: { directionDeg: 0, speed: 4 }, northEast: { directionDeg: 90, speed: 8 },
    southWest: { directionDeg: 180, speed: 6 }, southEast: { directionDeg: 270, speed: 10 },
  },
}, 160, 100, "preview");
const nw = 0, se = global.windXMap.length - 1;
assert(Math.abs(global.windXMap[nw] - global.windXMap[se]) + Math.abs(global.windYMap[nw] - global.windYMap[se]) > 1, "모서리 풍향 보간 차이가 없음");

const project = createEmptyProject("검증");
const free = createEmptyMap("자유", 160, 100, "free", "regional", 500);
const realistic = createEmptyMap("현실", 160, 100, "realistic", "regional", 500);
project.maps = [free, realistic];
assert(project.maps[0].generationMode === "free" && project.maps[1].generationMode === "realistic", "지도별 엔진 저장 실패");
assert(realistic.editorMode === "view", "지도별 편집 모드 기본값 실패");

const demo = JSON.parse(await readFile(new URL("../src/demoProjectData.json", import.meta.url), "utf8"));
const demoGenerated = demo.maps?.[0]?.generatedStates?.[0]?.value;
assert(demo.maps?.[0]?.physicalWidthKm === 500, "데모 지도 물리 폭이 500km가 아님");
assert(demo.maps?.[0]?.scaleMode === "regional", "데모 지도 규모가 지역 지도가 아님");
assert(demoGenerated?.settings?.mapScaleKm === 500, "데모 생성 설정이 500km가 아님");

console.log(JSON.stringify({
  status: "passed",
  inlandBoundaryLand: inlandBoundary.length,
  coastNorthLand: top.length,
  coastSouthWater: bottom.length,
  cornerWindDelta: Number((Math.abs(global.windXMap[nw] - global.windXMap[se]) + Math.abs(global.windYMap[nw] - global.windYMap[se])).toFixed(3)),
  demoWidthKm: demo.maps[0].physicalWidthKm,
  demoArticles: demo.wikiArticles?.length ?? 0,
}, null, 2));
