import {
  PROGRAM_VERSION,
  createDefaultWikiCategories,
  createDemoProject,
  createEmptyMap,
  defaultGeneratorSettings,
  getStateAtYear,
  pointInPolygon,
  type WikiCategory,
} from "../src/model/world.ts";
import { generateWorldMap } from "../src/generator/generateWorld.ts";
import { applyGeneratedCountries } from "../src/generator/mapPlacement.ts";
import { climateAnnualTemperatureRange, KOPPEN_CLIMATE_CODES } from "../src/generator/climatePresets.ts";
import { estimatedPlateCount } from "../src/generator/geological.ts";
import { analyzeEnvironmentLocation } from "../src/simulation/locationEnvironment.ts";
import { WIKI_TEMPLATE_REGISTRY } from "../src/model/templateRegistry.ts";
import { normalizeProject } from "../src/storage/projectStorage.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

assert(PROGRAM_VERSION === "0.99f", "program version mismatch");
assert(new Set(KOPPEN_CLIMATE_CODES).size === KOPPEN_CLIMATE_CODES.length, "duplicate Köppen code");
assert(KOPPEN_CLIMATE_CODES.length === 31, "Köppen coverage is incomplete");
assert(climateAnnualTemperatureRange("Cfb") < climateAnnualTemperatureRange("Dfd"), "annual temperature range presets are not differentiated");
for (const key of ["other", "person", "family", "organization", "faction", "country", "calendar", "event"] as WikiCategory[]) {
  assert(WIKI_TEMPLATE_REGISTRY.some((item) => item.key === key), `missing template ${key}`);
}

const categories = createDefaultWikiCategories();
assert(!categories.some((category) => category.id === "wiki-category-nature-all"), "nature aggregate category must not exist");
const demo = createDemoProject();
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

const territoryCounts: number[] = [];
for (const seed of [2217, 4471, 7819]) {
  const countryMap = createEmptyMap(`영토 검사 ${seed}`, 160, 100);
  const countrySource = generateWorldMap({ ...common, renderResolution: 512, algorithm: "tectonic", generateCountries: true, countryCount: 5, seed }, countryMap.width, countryMap.height, "preview");
  const placedForSeed = applyGeneratedCountries(countryMap, countrySource);
  territoryCounts.push(placedForSeed.map.territories.length);
  for (let y = 0; y < 50; y += 1) for (let x = 0; x < 80; x += 1) {
    const point = { x: (x + 0.5) / 80 * countryMap.width, y: (y + 0.5) / 50 * countryMap.height };
    const owners = placedForSeed.map.territories.filter((territory) => {
      const state = getStateAtYear(territory.states, placedForSeed.map.timeline.currentYear);
      return state ? pointInPolygon(point, state.polygon) : false;
    });
    assert(owners.length <= 1, `territory overlap detected for seed ${seed} at ${x},${y}`);
  }
}

const legacy = structuredClone(demo);
legacy.version = "0.99d" as never;
legacy.maps[0].generatorSeedHistory = Array.from({ length: 6 }, (_, index) => ({
  seed: index + 1,
  settings: { ...defaultGeneratorSettings(), algorithm: index % 2 ? "sdf" : "perlin" },
  usedAt: new Date(2026, 0, index + 1).toISOString(),
}));
const normalized = normalizeProject(legacy);
assert(normalized.version === "0.99f", "migration version mismatch");
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
  migratedSeedCount: normalized.maps[0].generatorSeedHistory.length,
  demoSettlements: { cities: demoCityCount, villages: demoVillageCount },
  climateAnomaly: jan.current.temperatureAnomalyC,
}, null, 2));
