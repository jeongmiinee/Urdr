import {
  PROGRAM_VERSION,
  activeCalendarFieldsFromTimeline,
  timelineFromActiveCalendarFields,
  createDefaultWikiCategories,
  createDemoProject,
  createEmptyMap,
  defaultGeneratorSettings,
  getStateAtYear,
  pointInTerritoryState,
  type WikiCategory,
} from "../src/model/world.ts";
import { generateWorldMap } from "../src/generator/generateWorld.ts";
import { applyGeneratedCountries, enforceMapPlacementConstraints, isLandAtPoint } from "../src/generator/mapPlacement.ts";
import { climateAnnualTemperatureRange, KOPPEN_CLIMATE_CODES } from "../src/generator/climatePresets.ts";
import { estimatedPlateCount } from "../src/generator/geological.ts";
import { analyzeEnvironmentLocation } from "../src/simulation/locationEnvironment.ts";
import { WIKI_TEMPLATE_REGISTRY } from "../src/model/templateRegistry.ts";
import { normalizeProject } from "../src/storage/projectStorage.ts";
import { syncAutoWikiArticles } from "../src/model/wikiSync.ts";
import { smoothPath, stitchSegments } from "../src/generator/pathSmoothing.ts";
import { sortSelectionOptions } from "../src/model/selectionSort.ts";
import { createDefaultHeraldicAsset } from "../src/components/HeraldryStudio.tsx";
import demoProjectData from "../src/demoProjectData.json";
import { UPDATE_HISTORY } from "../src/updateHistory.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

assert(PROGRAM_VERSION === "0.99m", "program version mismatch");
assert(UPDATE_HISTORY[0]?.version === "0.99m", "latest update history entry missing");
assert(UPDATE_HISTORY.reduce((sum, entry) => sum + entry.changes.length, 0) >= 300, "update history is still too sparse");
const staticDemo = demoProjectData as unknown as { version: string; maps: Array<{ generatedStates: unknown[]; locations: unknown[] }>; wikiArticles: unknown[] };
assert(staticDemo.version === "0.99m", "static demo version mismatch");
assert(staticDemo.maps[0]?.generatedStates.length > 0, "static demo generated map missing");
assert(staticDemo.maps[0]?.locations.length >= 22, "static demo settlement coverage missing");
assert(staticDemo.wikiArticles.length >= 80, "static demo wiki coverage missing");
const sortedNames = sortSelectionOptions([
  { id: "en", label: "Beta" }, { id: "ko", label: "가람" }, { id: "n10", label: "10항" }, { id: "n2", label: "2항" }, { id: "other", label: "#기타" },
]);
assert(sortedNames.map((item) => item.id).join(",") === "n2,n10,ko,en,other", "selection ordering mismatch");
const flagAsset = createDefaultHeraldicAsset("flag");
const coatAsset = createDefaultHeraldicAsset("coatOfArms");
assert(flagAsset.kind === "flag" && coatAsset.kind === "coatOfArms", "heraldry asset defaults missing");
assert(flagAsset.patternScale === 1 && flagAsset.symbolScale === 1 && flagAsset.symbolOffsetX === 0 && flagAsset.symbolOffsetY === 0, "heraldry transform defaults missing");

const jagged = [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 4, y: 2 }, { x: 4, y: 4 }];
const curved = smoothPath(jagged, { samplesPerSegment: 6, iterations: 1 });
assert(curved.length > jagged.length, "curve sampling did not add smooth points");
assert(Math.hypot(curved[0].x - jagged[0].x, curved[0].y - jagged[0].y) < 1e-6, "curve start moved");
assert(Math.hypot(curved[curved.length - 1].x - jagged[jagged.length - 1].x, curved[curved.length - 1].y - jagged[jagged.length - 1].y) < 1e-6, "curve end moved");
const stitched = stitchSegments([{ start: { x: 0, y: 0 }, end: { x: 1, y: 0 } }, { start: { x: 1, y: 0 }, end: { x: 2, y: 1 } }], 0.01);
assert(stitched.length === 1 && stitched[0].length === 3, "segment stitching failed");
assert(new Set(KOPPEN_CLIMATE_CODES).size === KOPPEN_CLIMATE_CODES.length, "duplicate Köppen code");
assert(KOPPEN_CLIMATE_CODES.length === 31, "Köppen coverage is incomplete");
assert(climateAnnualTemperatureRange("Cfb") < climateAnnualTemperatureRange("Dfd"), "annual temperature range presets are not differentiated");
for (const key of ["other", "person", "family", "organization", "faction", "country", "calendar", "event"] as WikiCategory[]) {
  assert(WIKI_TEMPLATE_REGISTRY.some((item) => item.key === key), `missing template ${key}`);
}

const categories = createDefaultWikiCategories();
assert(!categories.some((category) => category.id === "wiki-category-nature-all"), "nature aggregate category must not exist");
const demo = createDemoProject();
assert(demo.uiSettings.fontScale >= 0.85 && demo.uiSettings.fontScale <= 1.45, "font scale setting missing");
assert(demo.heraldicAssets.length >= 4, "demo heraldry assets missing");
assert(demo.maps[0].factions.some((faction) => faction.displayFlag || faction.displayCoatOfArms), "demo faction heraldry links missing");
assert(demo.wikiArticles.some((article) => article.familyProfile?.displayCoatOfArms), "demo family coat of arms missing");
const government = demo.wikiArticles.find((article) => article.title === "입헌군주제");
assert(government?.governmentProfile?.countryNameSuffix === "왕국", "government country suffix missing");
const activeFields = activeCalendarFieldsFromTimeline(demo, demo.maps[0].timeline);
const roundTripTimeline = timelineFromActiveCalendarFields(demo, demo.maps[0].timeline, activeFields);
assert(roundTripTimeline.currentYear === demo.maps[0].timeline.currentYear && roundTripTimeline.currentDayOfYear === demo.maps[0].timeline.currentDayOfYear, "active calendar edit round trip failed");
for (const key of ["animal", "plant", "tree", "rock", "mineral", "disease"] as WikiCategory[]) {
  const count = demo.wikiArticles.filter((article) => article.category === key).length;
  assert(count >= 3 && count <= 5, `${key} demo count ${count} is outside 3–5`);
}
assert(demo.maps[0].environmentPins.length === 4, "demo pins should be 4");
const activeDemoLocations = demo.maps[0].locations.map((location) => getStateAtYear(location.states, demo.maps[0].timeline.currentYear)).filter(Boolean);
const demoCityCount = activeDemoLocations.filter((state) => state!.locationType === "city" || state!.locationType === "capital").length;
const demoVillageCount = activeDemoLocations.filter((state) => state!.locationType === "village").length;
assert(demoCityCount >= 7, `demo cities should be at least 7, got ${demoCityCount}`);
assert(demoVillageCount >= 15, `demo villages should be at least 15, got ${demoVillageCount}`);
const wikiTitles = new Set(demo.wikiArticles.map((article) => article.title));
assert(demo.wikiArticles.every((article) => article.content.includes("[[")), "every demo article should contain at least one wiki link");
for (const article of demo.wikiArticles) for (const match of article.content.matchAll(/\[\[([^\]]+)\]\]/g)) assert(wikiTitles.has(match[1].trim()), `broken demo wiki link: ${article.title} -> ${match[1]}`);


const common = {
  ...defaultGeneratorSettings(),
  renderResolution: 512 as const,
  mapScope: "continent" as const,
  mapShape: "supercontinent" as const,
  climatePreset: "Cfb" as const,
  continentCount: 1,
  landRatio: 0.62,
  generateCountries: false,
  erosion: 0.45,
  riverNodeCount: 96,
  riverNodeMaxElevation: 3000,
};
for (const algorithm of ["perlin", "tectonic"] as const) {
  const generated = generateWorldMap({ ...common, algorithm, seed: 917_000 + algorithm.length }, 160, 100, "preview");
  assert(generated.elevationMap.length === generated.gridWidth * generated.gridHeight, `${algorithm} elevation size mismatch`);
  assert(generated.terrainMap.length === generated.gridWidth * generated.gridHeight, `${algorithm} terrain size mismatch`);
  assert(generated.renderWidth === 512 && generated.renderHeight === 320, `${algorithm} render dimensions mismatch`);
}

const maxResolution = generateWorldMap({ ...common, renderResolution: 8192, algorithm: "tectonic", seed: 999_8192 }, 160, 100, "preview");
assert(maxResolution.renderWidth === 8192 && maxResolution.renderHeight === 5120, "8192 render metadata missing");
assert(maxResolution.gridWidth <= 192, "preview calculation grid should be LOD capped");
assert(maxResolution.rivers.length > 0, "node river network missing");
assert(maxResolution.rivers.some((segment) => segment.mouth), "river mouths missing");
const angleOffGrid = (start: {x:number;y:number}, end: {x:number;y:number}) => {
  const angle = Math.abs(Math.atan2(end.y-start.y,end.x-start.x) * 180 / Math.PI) % 45;
  return Math.min(angle,45-angle) > 1.5;
};
const curvedRiverRatio = maxResolution.rivers.filter((segment)=>angleOffGrid(segment.start,segment.end)).length / Math.max(1,maxResolution.rivers.length);
const curvedCoastRatio = maxResolution.coastline.filter((segment)=>angleOffGrid(segment.start,segment.end)).length / Math.max(1,maxResolution.coastline.length);
assert(curvedRiverRatio > 0.18, `river angles still look grid locked: ${curvedRiverRatio}`);
assert(curvedCoastRatio > 0.18, `coast angles still look grid locked: ${curvedCoastRatio}`);
assert(estimatedPlateCount({ ...common, mapScaleKm: 12_000 }) > estimatedPlateCount({ ...common, mapScaleKm: 4_200 }), "wider worlds must contain more plates");
assert(estimatedPlateCount({ ...common, mapScaleKm: 40_075 }) === 52, "Earth scale should resolve to 52 reference plates");

const climateMap = createEmptyMap("기후 검사", 160, 100);
climateMap.generatedStates = [{ startYear: 0, endYear: null, value: generateWorldMap({ ...common, renderResolution: 256, algorithm: "perlin", seed: 8123 }, climateMap.width, climateMap.height, "preview") }];
const jan = analyzeEnvironmentLocation(climateMap, { x: 80, y: 50 }, 1);
const jul = analyzeEnvironmentLocation(climateMap, { x: 80, y: 50 }, 7);
assert(jan && jul, "monthly environment analysis missing");
assert(jan.current.month === 1 && jul.current.month === 7, "selected month did not propagate");
assert(Math.abs(jan.current.temperatureC - jul.current.temperatureC) >= 2, "monthly climate values did not change");
assert(Number.isFinite(jan.current.normalTemperatureC) && Number.isFinite(jan.current.temperatureAnomalyC), "climate normal/anomaly fields missing");
climateMap.timeline.currentYear = 8;
const year8 = analyzeEnvironmentLocation(climateMap, { x: 80, y: 50 }, 1);
climateMap.timeline.currentYear = 9;
const year9 = analyzeEnvironmentLocation(climateMap, { x: 80, y: 50 }, 1);
assert(year8 && year9 && year8.current.temperatureC !== year9.current.temperatureC, "interannual climate variability missing");
assert(year8 && year9 && year8.current.windDirectionDeg !== year9.current.windDirectionDeg, "interannual wind direction variability missing");
assert(jan.current.windDirectionDeg !== jul.current.windDirectionDeg, "monthly wind direction variability missing");

const territoryCounts: number[] = [];
const morphologyCityCounts: number[][] = [];
const islandTerritoryCounts: number[][] = [];
for (const seed of [2217, 4471, 7819]) {
  const countryMap = createEmptyMap(`영토 검사 ${seed}`, 160, 100);
  const countrySource = generateWorldMap({ ...common, renderResolution: 512, algorithm: "tectonic", mapShape: "archipelago", continentCount: 6, generateCountries: true, countryCount: 5, seed }, countryMap.width, countryMap.height, "preview");
  const placedForSeed = applyGeneratedCountries(countryMap, countrySource);
  const countries = placedForSeed.map.factions.filter((faction) => faction.kind === "country").slice(0, 5);
  territoryCounts.push(placedForSeed.map.territories.length);
  const cityCounts = countries.map((country) => placedForSeed.map.locations.filter((location) => {
    const state = getStateAtYear(location.states, placedForSeed.map.timeline.currentYear);
    return Boolean(state && state.ownerFactionId === country.id && ["capital", "city", "town"].includes(state.locationType));
  }).length);
  morphologyCityCounts.push(cityCounts);
  assert(cityCounts.every((count) => count >= 4), `each country must have four morphology cities for seed ${seed}`);
  for (const country of countries) {
    assert(Boolean(country.countryProfile?.capitalLocationId), `country capital link missing for ${country.name}`);
    assert((country.countryProfile?.majorLocationIds.length ?? 0) >= 4, `major city links missing for ${country.name}`);
  }
  const componentsByCountry = countries.map((country) => placedForSeed.map.territories.filter((territory) => getStateAtYear(territory.states, placedForSeed.map.timeline.currentYear)?.ownerFactionId === country.id).length);
  islandTerritoryCounts.push(componentsByCountry);
  assert(componentsByCountry.some((count) => count > 1), `sea propagation did not create any island territory for seed ${seed}`);
  const generatedRoads = placedForSeed.map.roads.filter((road) => road.id.startsWith("generated-road-"));
  let roadOffGridSegments = 0; let roadSegments = 0;
  assert(generatedRoads.length >= countries.length - 1, `generated road network is too sparse for seed ${seed}`);
  for (const road of generatedRoads) {
    assert(road.nodes.length >= 2, `generated road has too few nodes for seed ${seed}`);
    for (let nodeIndex = 1; nodeIndex < road.nodes.length; nodeIndex += 1) { roadSegments += 1; if (angleOffGrid(road.nodes[nodeIndex-1], road.nodes[nodeIndex])) roadOffGridSegments += 1; }
    for (const node of road.nodes) {
      const x = Math.max(0, Math.min(countrySource.gridWidth - 1, Math.round(node.x / countryMap.width * (countrySource.gridWidth - 1))));
      const y = Math.max(0, Math.min(countrySource.gridHeight - 1, Math.round(node.y / countryMap.height * (countrySource.gridHeight - 1))));
      assert(countrySource.elevationMap[y * countrySource.gridWidth + x] > countrySource.seaLevel, `road entered water for seed ${seed}`);
    }
  }
  assert(roadOffGridSegments / Math.max(1, roadSegments) > 0.12, `road angles still look grid locked for seed ${seed}`);
  for (const location of placedForSeed.map.locations) {
    const state = getStateAtYear(location.states, placedForSeed.map.timeline.currentYear);
    if (state) assert(isLandAtPoint(placedForSeed.generated, state.position), `location spawned at sea for seed ${seed}: ${state.name}`);
  }

  for (let y = 0; y < countrySource.gridHeight; y += 2) for (let x = 0; x < countrySource.gridWidth; x += 2) {
    const index = y * countrySource.gridWidth + x;
    const point = { x: (x + 0.5) / countrySource.gridWidth * countryMap.width, y: (y + 0.5) / countrySource.gridHeight * countryMap.height };
    const owners = placedForSeed.map.territories.filter((territory) => {
      const state = getStateAtYear(territory.states, placedForSeed.map.timeline.currentYear);
      return state ? pointInTerritoryState(point, state) : false;
    });
    if (countrySource.elevationMap[index] > countrySource.seaLevel) {
      assert(owners.length === 1, `land must have exactly one owner for seed ${seed} at ${x},${y}, got ${owners.length}`);
    } else {
      assert(owners.length === 0, `water must not become territory for seed ${seed} at ${x},${y}`);
    }
  }
}

// 불러온 구버전 데이터처럼 바다와 서로 겹치는 영토·장소가 들어와도 최종 정규화가 강제되어야 한다.
const constraintMap = createEmptyMap("배치 제약 검사", 160, 100);
const constraintSource = generateWorldMap({ ...common, renderResolution: 512, algorithm: "perlin", seed: 564_201 }, constraintMap.width, constraintMap.height, "preview");
constraintMap.generatedStates = [{ startYear: 0, endYear: null, value: constraintSource }];
const fullPolygon = [{ x: 0, y: 0 }, { x: constraintMap.width, y: 0 }, { x: constraintMap.width, y: constraintMap.height }, { x: 0, y: constraintMap.height }];
constraintMap.territories = [
  { id: "constraint-territory-a", name: "중첩 영토 A", states: [{ startYear: 0, endYear: null, value: { ownerFactionId: null, polygon: fullPolygon, description: "검사용" } }] },
  { id: "constraint-territory-b", name: "중첩 영토 B", states: [{ startYear: 0, endYear: null, value: { ownerFactionId: null, polygon: fullPolygon, description: "검사용" } }] },
];
let seaIndex = constraintSource.elevationMap.findIndex((elevation) => elevation <= constraintSource.seaLevel);
assert(seaIndex >= 0, "constraint test map has no sea cell");
const seaX = seaIndex % constraintSource.gridWidth; const seaY = Math.floor(seaIndex / constraintSource.gridWidth);
constraintMap.locations = [{ id: "constraint-location", states: [{ startYear: 0, endYear: null, value: { name: "바다 위 장소", locationType: "village", position: { x: (seaX + 0.5) / constraintSource.gridWidth * constraintMap.width, y: (seaY + 0.5) / constraintSource.gridHeight * constraintMap.height }, status: "active", description: "검사용" } }] }];
const constrainedPlacement = enforceMapPlacementConstraints(constraintMap, constraintSource);
const constrainedLocation = getStateAtYear(constrainedPlacement.locations[0].states, 0);
assert(constrainedLocation && isLandAtPoint(constraintSource, constrainedLocation.position), "sea location was not moved to land");
for (let y = 0; y < constraintSource.gridHeight; y += 2) for (let x = 0; x < constraintSource.gridWidth; x += 2) {
  const index = y * constraintSource.gridWidth + x;
  const point = { x: (x + 0.5) / constraintSource.gridWidth * constraintMap.width, y: (y + 0.5) / constraintSource.gridHeight * constraintMap.height };
  const owners = constrainedPlacement.territories.filter((territory) => {
    const state = getStateAtYear(territory.states, 0);
    return state ? pointInTerritoryState(point, state) : false;
  }).length;
  assert(owners <= 1, `overlapping territories remained at ${x},${y}`);
  if (constraintSource.elevationMap[index] <= constraintSource.seaLevel) assert(owners === 0, `territory remained at sea at ${x},${y}`);
}

const territoryWithLegacyDoc = structuredClone(demo);
const territory = territoryWithLegacyDoc.maps[0].territories[0];
if (territory) territoryWithLegacyDoc.wikiArticles.push({ id: "legacy-territory-doc", title: territory.name, category: "country", categoryId: null, summary: "legacy", content: "", tags: ["영토"], linkedMapEntityIds: [territory.id], sourceMapId: territoryWithLegacyDoc.maps[0].id, sourceEntityId: territory.id, sourceEntityType: "territory", autoGenerated: true, createdDate: new Date().toISOString(), lastModifiedDate: new Date().toISOString() });
const territorySynced = syncAutoWikiArticles(territoryWithLegacyDoc);
assert(!territorySynced.wikiArticles.some((article) => article.sourceEntityType === "territory"), "territory wiki documents must be removed");

const legacy = structuredClone(demo);
legacy.version = "0.99f" as never;
legacy.maps[0].generatorSeedHistory = Array.from({ length: 6 }, (_, index) => ({
  seed: index + 1,
  settings: { ...defaultGeneratorSettings(), algorithm: index % 2 ? "sdf" : "perlin" },
  usedAt: new Date(2026, 0, index + 1).toISOString(),
}));
const normalized = normalizeProject(legacy);
assert(normalized.version === "0.99m", "migration version mismatch");
assert(Array.isArray(normalized.heraldicAssets), "heraldry asset migration missing");
assert(normalized.maps[0].generatorSeedHistory.every((row) => row.settings.riverNodeCount > 0 && row.settings.riverNodeMaxElevation > 0), "river node setting migration missing");
assert(normalized.heraldicAssets.every((asset) => Number.isFinite(asset.patternScale) && Number.isFinite(asset.symbolScale)), "heraldry transform migration missing");
assert(normalized.maps.every((item) => item.factions.filter((faction) => faction.kind === "country").every((faction) => faction.hasTerritory === true)), "country territory defaults missing");
assert(normalized.uiSettings.fontScale >= 0.85, "ui settings migration missing");
assert(normalized.maps.every((map) => map.events.every((event) => typeof event.endTimeUnknown === "boolean")), "event end unknown migration missing");
assert(normalized.maps[0].generatorSeedHistory.length === 4, "recent seeds should be capped at 4");
assert(normalized.maps[0].generatorSeedHistory.every((item) => item.settings.algorithm !== "sdf"), "legacy SDF should migrate to tectonic");

const firstOrderSegments = maxResolution.rivers.filter((segment) => segment.order === 1);
const mergedSegments = maxResolution.rivers.filter((segment) => segment.order >= 2);
assert(firstOrderSegments.length > mergedSegments.length, "headwater network should contain more detailed segments than merged rivers");
const averageWidth = (rows: typeof maxResolution.rivers) => rows.reduce((sum, row) => sum + row.width, 0) / Math.max(1, rows.length);
assert(mergedSegments.length === 0 || averageWidth(mergedSegments) > averageWidth(firstOrderSegments), "merged downstream rivers should be wider than first-order headwaters");

console.log(JSON.stringify({
  version: PROGRAM_VERSION,
  koppenTypes: KOPPEN_CLIMATE_CODES.length,
  demoArticles: demo.wikiArticles.length,
  render8192: [maxResolution.renderWidth, maxResolution.renderHeight],
  calculationGrid: [maxResolution.gridWidth, maxResolution.gridHeight],
  plateCounts: { regional: estimatedPlateCount({ ...common, mapScaleKm: 4_200 }), wide: estimatedPlateCount({ ...common, mapScaleKm: 12_000 }), earth: estimatedPlateCount({ ...common, mapScaleKm: 40_075 }) },
  monthlyTemperature: { january: jan.current.temperatureC, july: jul.current.temperatureC },
  territoryCounts,
  morphologyCityCounts,
  islandTerritoryCounts,
  migratedSeedCount: normalized.maps[0].generatorSeedHistory.length,
  demoSettlements: { cities: demoCityCount, villages: demoVillageCount },
  climateAnomaly: jan.current.temperatureAnomalyC,
  curvedRatios: { rivers: curvedRiverRatio, coastline: curvedCoastRatio },
}, null, 2));
