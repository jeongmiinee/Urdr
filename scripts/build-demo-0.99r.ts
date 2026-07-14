import { writeFile } from "node:fs/promises";
import { generateWorldMap } from "../src/generator/generateWorld";
import { applyGeneratedCountries } from "../src/generator/mapPlacement";
import { activeMap, createDemoProject, defaultGeneratorSettings } from "../src/model/world";
import { syncAutoWikiArticles } from "../src/model/wikiSync";

const demo = createDemoProject();
const map = activeMap(demo);
if (!map) throw new Error("demo map missing");

// 데모는 매 버전 기존 파일을 재사용하지 않고 정확히 500km 지역 지도로 다시 생성한다.
map.title = "에테리아 500km 지역";
map.scaleMode = "regional";
map.physicalWidthKm = 500;
map.generationMode = "realistic";

const settings = {
  ...defaultGeneratorSettings(),
  seed: 990_500_051,
  algorithm: "hybrid" as const,
  mapScope: "regional" as const,
  mapScaleKm: 500,
  localRegionType: "coast" as const,
  localBoundary: {
    north: [{ start: 0, end: 1, kind: "land" as const }],
    east: [
      { start: 0, end: 0.34, kind: "land" as const },
      { start: 0.34, end: 1, kind: "water" as const },
    ],
    south: [{ start: 0, end: 1, kind: "water" as const }],
    west: [{ start: 0, end: 1, kind: "land" as const }],
  },
  prevailingWindDirectionDeg: 245,
  prevailingWindSpeed: 7,
  climatePreset: "Cfb" as const,
  climateReferenceLatitudeDeg: 42,
  latitudeDeg: 42,
  renderResolution: 320,
  analysisResolution: 256,
  gridWidth: 320,
  gridHeight: 200,
  generateCountries: true,
  countryCount: 3,
  contourInterval: 150,
  riverNodeCount: 80,
};

const generated = generateWorldMap(settings, map.width, map.height, "final");
const result = applyGeneratedCountries(map, generated);

// 국가는 영토를 유지하지만 세력·단체는 사용자가 직접 영토 부여를 체크하기 전까지 무영토다.
const cleanedFactions = result.map.factions.map((faction) => faction.kind === "country"
  ? { ...faction, hasTerritory: true, territoryHidden: false }
  : { ...faction, hasTerritory: false, territoryHidden: false });
const countryIds = new Set(cleanedFactions.filter((faction) => faction.kind === "country").map((faction) => faction.id));
const cleanedTerritories = result.map.territories.filter((territory) => territory.states.every((state) => !state.value.ownerFactionId || countryIds.has(state.value.ownerFactionId)));

result.map.factions = cleanedFactions;
result.map.territories = cleanedTerritories;
result.map.scaleMode = "regional";
result.map.physicalWidthKm = 500;
result.map.generatedStates = [{ startYear: result.map.timeline.minimumYear, endYear: null, value: result.generated }];
result.map.generatorSeedHistory = [{ seed: result.generated.settings.seed, settings: result.generated.settings, usedAt: result.generated.generatedAt }];
result.map.editorMode = "view";

demo.maps = demo.maps.map((item) => item.id === map.id ? result.map : item);
let synced = syncAutoWikiArticles(demo);
const linkable = synced.wikiArticles.filter((article) => article.title.trim());
synced = {
  ...synced,
  version: "0.99r",
  wikiArticles: synced.wikiArticles.map((article, index) => {
    const related = [
      linkable[(index + 1) % Math.max(1, linkable.length)],
      linkable[(index + 5) % Math.max(1, linkable.length)],
    ].filter((candidate, i, rows) => candidate && candidate.id !== article.id && rows.findIndex((row) => row.id === candidate.id) === i);
    const suffix = related.length ? `\n\n관련 문서: ${related.map((candidate) => `[[${candidate.title}]]`).join(", ")}` : "";
    return { ...article, content: article.content.includes("[[") ? article.content : `${article.content}${suffix}` };
  }),
};

const demoMap = synced.maps[0];
if (!demoMap || demoMap.scaleMode !== "regional" || demoMap.physicalWidthKm !== 500) {
  throw new Error("데모 지도는 반드시 가로 500km 지역 지도여야 합니다.");
}
const invalidFactions = demoMap.factions.filter((faction) => faction.kind !== "country" && (faction.hasTerritory === true || faction.territoryHidden === true));
if (invalidFactions.length) throw new Error(`세력·단체 기본 영토 오류: ${invalidFactions.map((item) => item.name).join(", ")}`);
const nonCountryIds = new Set(demoMap.factions.filter((faction) => faction.kind !== "country").map((faction) => faction.id));
if (demoMap.territories.some((territory) => territory.states.some((state) => state.value.ownerFactionId && nonCountryIds.has(state.value.ownerFactionId)))) {
  throw new Error("데모에 세력·단체 소유 영토가 남아 있습니다.");
}

await writeFile(new URL("../src/demoProjectData.json", import.meta.url), JSON.stringify(synced));
console.log(JSON.stringify({
  version: synced.version,
  mapTitle: demoMap.title,
  mapScaleKm: generated.settings.mapScaleKm,
  physicalWidthKm: demoMap.physicalWidthKm,
  scope: generated.settings.mapScope,
  localType: generated.settings.localRegionType,
  maps: synced.maps.length,
  articles: synced.wikiArticles.length,
  rivers: generated.rivers.length,
  lakes: generated.lakeSurfaceElevations?.length ?? 0,
  factionsWithoutTerritory: demoMap.factions.filter((faction) => faction.kind !== "country" && faction.hasTerritory !== true).length,
  bytes: JSON.stringify(synced).length,
}, null, 2));
