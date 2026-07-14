import { writeFile } from "node:fs/promises";
import { generateWorldMap } from "../src/generator/generateWorld";
import { applyGeneratedCountries } from "../src/generator/mapPlacement";
import { activeMap, createDemoProject, defaultGeneratorSettings } from "../src/model/world";
import { syncAutoWikiArticles } from "../src/model/wikiSync";

const demo = createDemoProject();
const map = activeMap(demo);
if (!map) throw new Error("demo map missing");
const settings = {
  ...defaultGeneratorSettings(),
  seed: 990_500_041,
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
result.map.generatedStates = [{ startYear: result.map.timeline.minimumYear, endYear: null, value: result.generated }];
result.map.generatorSeedHistory = [{ seed: result.generated.settings.seed, settings: result.generated.settings, usedAt: result.generated.generatedAt }];
result.map.editorMode = "view";
demo.maps = demo.maps.map((item) => item.id === map.id ? result.map : item);
let synced = syncAutoWikiArticles(demo);
const linkable = synced.wikiArticles.filter((article) => article.title.trim());
synced = {
  ...synced,
  version: "0.99q",
  wikiArticles: synced.wikiArticles.map((article, index) => {
    const related = [linkable[(index + 1) % Math.max(1, linkable.length)], linkable[(index + 5) % Math.max(1, linkable.length)]]
      .filter((candidate, i, rows) => candidate && candidate.id !== article.id && rows.findIndex((row) => row.id === candidate.id) === i);
    const suffix = related.length ? `\n\n관련 문서: ${related.map((candidate) => `[[${candidate.title}]]`).join(", ")}` : "";
    return { ...article, content: article.content.includes("[[") ? article.content : `${article.content}${suffix}` };
  }),
};
await writeFile(new URL("../src/demoProjectData.json", import.meta.url), JSON.stringify(synced));
console.log(JSON.stringify({
  version: synced.version,
  mapTitle: synced.maps[0]?.title,
  mapScaleKm: generated.settings.mapScaleKm,
  scope: generated.settings.mapScope,
  localType: generated.settings.localRegionType,
  maps: synced.maps.length,
  articles: synced.wikiArticles.length,
  rivers: generated.rivers.length,
  lakes: Object.keys(generated.lakeSurfaceElevations ?? {}).length,
  bytes: JSON.stringify(synced).length,
}, null, 2));
