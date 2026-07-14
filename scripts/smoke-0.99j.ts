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
import { applyGeneratedCountries } from "../src/generator/mapPlacement.ts";
import { climateAnnualTemperatureRange, KOPPEN_CLIMATE_CODES } from "../src/generator/climatePresets.ts";
import { estimatedPlateCount } from "../src/generator/geological.ts";
import { analyzeEnvironmentLocation } from "../src/simulation/locationEnvironment.ts";
import { WIKI_TEMPLATE_REGISTRY } from "../src/model/templateRegistry.ts";
import { normalizeProject } from "../src/storage/projectStorage.ts";
import { syncAutoWikiArticles } from "../src/model/wikiSync.ts";
import { smoothPath, stitchSegments } from "../src/generator/pathSmoothing.ts";
import { sortSelectionOptions } from "../src/model/selectionSort.ts";
import { createDefaultHeraldicAsset } from "../src/components/HeraldryStudio.tsx";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

assert(PROGRAM_VERSION === "0.99j", "program version mismatch");
const sortedNames = sortSelectionOptions([
  { id: "en", label: "Beta" }, { id: "ko", label: "가람" }, { id: "n10", label: "10항" }, { id: "n2", label: "2항" }, { id: "other", label: "#기타" },
]);
assert(sortedNames.map((item) => item.id).join(",") === "n2,n10,ko,en,other", "selection ordering mismatch");
const flagAsset = createDefaultHeraldicAsset("flag");
const coatAsset = createDefaultHeraldicAsset("coatOfArms");
assert(flagAsset.kind === "flag" && coatAsset.kind === "coatOfArms", "heraldry asset defaults missing");

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
  assert(generatedRoads.length >= countries.length - 1, `generated road network is too sparse for seed ${seed}`);
  for (const road of generatedRoads) {
    assert(road.nodes.length >= 2, `generated road has too few nodes for seed ${seed}`);
    for (const node of road.nodes) {
      const x = Math.max(0, Math.min(countrySource.gridWidth - 1, Math.round(node.x / countryMap.width * (countrySource.gridWidth - 1))));
      const y = Math.max(0, Math.min(countrySource.gridHeight - 1, Math.round(node.y / countryMap.height * (countrySource.gridHeight - 1))));
      assert(countrySource.elevationMap[y * countrySource.gridWidth + x] > countrySource.seaLevel, `road entered water for seed ${seed}`);
    }
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
assert(normalized.version === "0.99j", "migration version mismatch");
assert(Array.isArray(normalized.heraldicAssets), "heraldry asset migration missing");
assert(normalized.maps.every((item) => item.factions.filter((faction) => faction.kind === "country").every((faction) => faction.hasTerritory === true)), "country territory defaults missing");
assert(normalized.uiSettings.fontScale >= 0.85, "ui settings migration missing");
assert(normalized.maps.every((map) => map.events.every((event) => typeof event.endTimeUnknown === "boolean")), "event end unknown migration missing");
assert(normalized.maps[0].generatorSeedHistory.length === 4, "recent seeds should be capped at 4");
assert(normalized.maps[0].generatorSeedHistory.every((item) => item.settings.algorithm !== "sdf"), "legacy SDF should migrate to tectonic");

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
}, null, 2));
