import { writeFile } from "node:fs/promises";
import { generateWorldMap } from "../src/generator/generateWorld";
import { applyGeneratedCountries } from "../src/generator/mapPlacement";
import { activeMap, createDemoProject, createId, defaultGeneratorSettings, type WikiArticle, type WorldEvent } from "../src/model/world";
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
  renderResolution: 160,
  analysisResolution: 128,
  gridWidth: 160,
  gridHeight: 100,
  generateCountries: true,
  countryCount: 5,
  contourInterval: 150,
  riverNodeCount: 36,
};

const generated = generateWorldMap(settings, map.width, map.height, "preview");
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
result.map.timeline = {
  ...result.map.timeline,
  minimumYear: -400,
  maximumYear: 2400,
  currentYear: 1250,
  precision: "year",
};

// 단일 시점만 있던 도시·마을에도 역사적으로 의미 있는 희소 통계 기록을 추가한다.
// 이 값들은 포인트 사이를 그리는 그래프에만 사용되며 중간 연도의 공식 값으로 저장하지 않는다.
result.map.locations = result.map.locations.map((location, locationIndex) => {
  const ordered = [...location.states].sort((a, b) => a.startYear - b.startYear);
  if (ordered.length > 1) return location;
  const initial = ordered[0];
  if (!initial) return location;
  const basePopulation = Math.max(0, initial.value.population ?? (initial.value.locationType === "village" ? 1800 : 14000));
  const baseEconomy = Math.max(0, initial.value.economy ?? (initial.value.locationType === "village" ? 3 : 16));
  const founded = Math.max(-250, Math.min(900, initial.startYear));
  const points = [
    { year: founded, population: Math.round(basePopulation * 0.58), economy: Math.max(1, Math.round(baseEconomy * 0.55)) },
    { year: Math.max(founded + 220, 720 + (locationIndex % 5) * 35), population: Math.round(basePopulation * 0.84), economy: Math.max(1, Math.round(baseEconomy * 0.82)) },
    { year: Math.max(founded + 520, 1250 + (locationIndex % 4) * 45), population: basePopulation, economy: baseEconomy },
    { year: Math.max(founded + 820, 1780 + (locationIndex % 6) * 28), population: Math.round(basePopulation * (1.18 + (locationIndex % 3) * 0.08)), economy: Math.max(1, Math.round(baseEconomy * (1.15 + (locationIndex % 4) * 0.07))) },
  ].filter((point, index, rows) => rows.findIndex((item) => item.year === point.year) === index).sort((a, b) => a.year - b.year);
  return {
    ...location,
    states: points.map((point, index) => ({
      startYear: point.year,
      endYear: index + 1 < points.length ? points[index + 1].year - 1 : null,
      value: { ...initial.value, population: point.population, economy: point.economy },
    })),
  };
});

const now = new Date().toISOString();
const historicalPeople: Array<[string, number, number | undefined, string]> = [
  ["세르마 라디엔", -180, -92, "초기 관개 수로를 설계한 측량가"],
  ["오르벤 칼리오", 214, 287, "삼강 교역 규약을 정리한 법학자"],
  ["마엘라 에스틴", 603, 671, "동부 전쟁기의 야전 의사"],
  ["로시안 테브르", 947, 1022, "네레이드 항로를 개척한 항해사"],
  ["이사벨 노렌", 1268, 1341, "고원 관측소를 세운 기후학자"],
  ["다리온 베스크", 1510, 1589, "서부 도시연합의 중재자"],
  ["셀리아 모르", 1832, 1904, "대에이렌 위생 개혁을 주도한 행정가"],
  ["카이렌 아스트", 2140, undefined, "후기 수로 복원 사업의 책임 기술자"],
];
const peopleArticles: WikiArticle[] = historicalPeople.map(([title, birthYear, deathYear, summary]) => ({
  id: createId("wiki-person"), title, category: "person", categoryId: "wiki-category-person",
  summary, content: `${title}은(는) 에테리아 지역사의 서로 다른 시대를 대표하는 인물이다.`, tags: ["인물", "데모 역사"],
  linkedMapEntityIds: [], createdDate: now, lastModifiedDate: now,
  personProfile: { birthYear, deathYear, organizationArticleIds: [], factionArticleIds: [], spouseArticleIds: [], childArticleIds: [], notes: summary },
}));

const laterEvents: WorldEvent[] = [
  [1320, "고원 관측망 창설", "아우렐리아 북부의 기후 관측소들이 하나의 기록망으로 통합되었다."],
  [1584, "서부 도시 중재회의", "수운세와 곡물 가격을 둘러싼 도시 간 분쟁이 중재되었다."],
  [1811, "대에이렌 수질 위기", "도시 팽창으로 인한 수질 악화가 광역 정수 사업으로 이어졌다."],
  [2056, "옛 수로 복원 협약", "폐쇄된 고대 수로를 문화유산과 농업 기반으로 함께 복원하기로 했다."],
  [2280, "연안 방재선 완공", "남부 해안의 범람과 폭풍해일을 완화하는 연속 방재 시설이 완공되었다."],
].map(([year, title, description]) => {
  const y = Number(year);
  return {
    id: createId("event"), title: String(title), category: "event" as const, description: String(description), location: null,
    startTimeUnknown: false, endTimeUnknown: false, startYear: y, endYear: y,
    startDateTime: { year: y, month: 1, day: 1, hour: 9 }, endDateTime: { year: y, month: 1, day: 1, hour: 18 },
    participants: [], chronology: [], relatedLocationIds: [], relatedFactionIds: [], relatedTerritoryIds: [],
  };
});
result.map.events = [...result.map.events, ...laterEvents];

// 일부 단체와 국가는 시대 중간에 해체·소멸해 타임라인 필터와 지도 변화를 확인할 수 있게 한다.
result.map.factions = result.map.factions.map((faction, index) => {
  if (faction.kind === "organization" && index % 2 === 0) return { ...faction, dissolvedYear: 1680 };
  if (faction.kind === "faction" && faction.name === "녹원 협약") return { ...faction, dissolvedYear: 2130 };
  if (faction.kind === "country" && index === result.map.factions.length - 1) return { ...faction, foundedYear: 640, dissolvedYear: 1960 };
  return faction;
});

demo.wikiArticles = [...demo.wikiArticles, ...peopleArticles];
demo.maps = demo.maps.map((item) => item.id === map.id ? result.map : item);
let synced = syncAutoWikiArticles(demo);
const linkable = synced.wikiArticles.filter((article) => article.title.trim());
synced = {
  ...synced,
  version: "0.99s",
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
const visibleNames = [
  ...demoMap.factions.map((item) => item.name),
  ...demoMap.locations.flatMap((item) => item.states.map((state) => state.value.name)),
  ...demoMap.events.map((item) => item.title),
  ...synced.wikiArticles.map((item) => item.title),
];
if (visibleNames.some((name) => /^(생성|새)\s*(국가|도시|마을|장소|사건)|제\d+도시|국가\s*\d+/.test(name))) {
  throw new Error("데모에 임시 자동 생성형 표시명이 남아 있습니다.");
}
const countries = demoMap.factions.filter((faction) => faction.kind === "country");
if (countries.some((country) => !country.flagAssetId || !country.coatOfArmsAssetId)) {
  throw new Error("깃발 또는 문장이 없는 데모 국가가 있습니다.");
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
  countries: demoMap.factions.filter((item) => item.kind === "country").length,
  locations: demoMap.locations.length,
  events: demoMap.events.length,
  historySpan: `${demoMap.timeline.minimumYear}~${demoMap.timeline.maximumYear}`,
  rivers: generated.rivers.length,
  lakes: generated.lakeSurfaceElevations?.length ?? 0,
  factionsWithoutTerritory: demoMap.factions.filter((faction) => faction.kind !== "country" && faction.hasTerritory !== true).length,
  bytes: JSON.stringify(synced).length,
}, null, 2));
