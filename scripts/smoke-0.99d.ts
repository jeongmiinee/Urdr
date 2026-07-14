import {
  PROGRAM_VERSION,
  createDefaultWikiCategories,
  createDemoProject,
  defaultGeneratorSettings,
  type WikiCategory,
} from "../src/model/world.ts";
import { generateWorldMap } from "../src/generator/generateWorld.ts";
import { KOPPEN_CLIMATE_CODES } from "../src/generator/climatePresets.ts";
import { WIKI_TEMPLATE_REGISTRY } from "../src/model/templateRegistry.ts";
import { normalizeProject } from "../src/storage/projectStorage.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

assert(PROGRAM_VERSION === "0.99d", "program version mismatch");
assert(new Set(KOPPEN_CLIMATE_CODES).size === KOPPEN_CLIMATE_CODES.length, "duplicate Köppen code");
assert(KOPPEN_CLIMATE_CODES.length >= 30, "Köppen coverage is incomplete");
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

const common = {
  ...defaultGeneratorSettings(),
  gridWidth: 128,
  gridHeight: 72,
  mapScope: "continent" as const,
  mapShape: "supercontinent" as const,
  climatePreset: "Cfb" as const,
  continentCount: 1,
  landRatio: 0.62,
  generateCountries: false,
  erosion: 0.7,
};
for (const algorithm of ["sdf", "perlin", "tectonic"] as const) {
  const generated = generateWorldMap({ ...common, algorithm, seed: 917_000 + algorithm.length }, 160, 100, "preview");
  assert(generated.elevationMap.length === 128 * 72, `${algorithm} elevation size mismatch`);
  assert(generated.terrainMap.length === 128 * 72, `${algorithm} terrain size mismatch`);
  assert(generated.temperatureMap.length === 128 * 72, `${algorithm} climate missing`);
  assert(generated.solarHoursMap.length === 128 * 72, `${algorithm} sunlight missing`);
}

const legacy = structuredClone(demo);
legacy.version = "0.99c" as never;
legacy.maps[0].generatorSeedHistory = Array.from({ length: 6 }, (_, index) => ({
  seed: index + 1,
  settings: { ...defaultGeneratorSettings(), algorithm: index % 2 ? "sdf" : "perlin" },
  usedAt: new Date(2026, 0, index + 1).toISOString(),
}));
const normalized = normalizeProject(legacy);
assert(normalized.version === "0.99d", "migration version mismatch");
assert(normalized.maps[0].generatorSeedHistory.length === 4, "recent seeds should be capped at 4");
assert(normalized.wikiCategories.every((category) => Boolean(category.templateKey)), "category template migration failed");

console.log(JSON.stringify({
  version: PROGRAM_VERSION,
  koppenTypes: KOPPEN_CLIMATE_CODES.length,
  templates: WIKI_TEMPLATE_REGISTRY.length,
  demoArticles: demo.wikiArticles.length,
  naturalCounts: Object.fromEntries(["animal", "plant", "tree", "rock", "mineral", "disease"].map((key) => [key, demo.wikiArticles.filter((article) => article.category === key).length])),
  environmentPins: demo.maps[0].environmentPins.length,
  algorithms: ["sdf", "perlin", "tectonic"],
  migratedSeedCount: normalized.maps[0].generatorSeedHistory.length,
}, null, 2));
