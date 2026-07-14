import { writeFile } from "node:fs/promises";
import { generateWorldMap } from "../src/generator/generateWorld";
import { applyGeneratedCountries } from "../src/generator/mapPlacement";
import { activeMap, createDemoProject, defaultGeneratorSettings } from "../src/model/world";
import { syncAutoWikiArticles } from "../src/model/wikiSync";

const demo = createDemoProject();
const map = activeMap(demo);
if (!map) throw new Error("demo map missing");
const generated = generateWorldMap({
  ...defaultGeneratorSettings(),
  seed: 842_611_907,
  algorithm: "tectonic",
  mapScope: "continent",
  mapShape: "supercontinent",
  climatePreset: "Cfb",
  climateReferenceLatitudeDeg: 48,
  latitudeDeg: 48,
  continentCount: 1,
  renderResolution: 256,
  gridWidth: 192,
  gridHeight: 120,
  landRatio: 0.63,
  coastlineDetail: 0.72,
  mountainStrength: 0.76,
  continentDynamics: 0.82,
  erosion: 0.72,
  moisture: 0.12,
  annualTemperatureRangeC: 10,
  generateCountries: true,
  countryCount: 3,
  contourInterval: 200,
  riverNodeCount: 120,
  riverNodeMaxElevation: 3600,
}, map.width, map.height, "final");
const result = applyGeneratedCountries(map, generated);
result.map.generatedStates = [{ startYear: result.map.timeline.minimumYear, endYear: null, value: result.generated }];
result.map.generatorSeedHistory = [{ seed: result.generated.settings.seed, settings: result.generated.settings, usedAt: result.generated.generatedAt }];
demo.maps = demo.maps.map((item) => item.id === map.id ? result.map : item);
let synced = syncAutoWikiArticles(demo);
const linkable = synced.wikiArticles.filter((article) => article.title.trim());
synced = {
  ...synced,
  wikiArticles: synced.wikiArticles.map((article, index) => {
    const related = [linkable[(index + 1) % linkable.length], linkable[(index + 5) % linkable.length], linkable[(index + 11) % linkable.length]]
      .filter((candidate, i, rows) => candidate && candidate.id !== article.id && rows.findIndex((row) => row.id === candidate.id) === i);
    const suffix = related.length ? `\n\n관련 문서: ${related.map((candidate) => `[[${candidate.title}]]`).join(", ")}` : "";
    return { ...article, content: article.content.includes("[[") ? article.content : `${article.content}${suffix}` };
  }),
};
await writeFile(new URL("../src/demoProjectData.json", import.meta.url), JSON.stringify(synced));
console.log(JSON.stringify({ maps: synced.maps.length, articles: synced.wikiArticles.length, locations: synced.maps[0]?.locations.length, rivers: generated.rivers.length, bytes: JSON.stringify(synced).length }, null, 2));
