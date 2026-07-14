import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { KOPPEN_TERRAIN_PRIORS, TERRAIN_ATLAS_METADATA } from "../src/generator/terrainAtlas";
import { TERRAIN_TYPES, type KoppenClimateCode, type TerrainType } from "../src/model/world";

type Sample = {
  climate: KoppenClimateCode;
  terrain: TerrainType;
  weight?: number;
};

const sampleDirectory = new URL("../research-data/samples/", import.meta.url);
const outputUrl = new URL("../research-data/generated-terrain-atlas.json", import.meta.url);
const validClimates = new Set(Object.keys(KOPPEN_TERRAIN_PRIORS));
const validTerrains = new Set<string>(TERRAIN_TYPES);
const counts = new Map<string, Map<string, number>>();
let sampleCount = 0;

for (const filename of await readdir(sampleDirectory)) {
  if (!filename.endsWith(".jsonl")) continue;
  const content = await readFile(join(sampleDirectory.pathname, filename), "utf8");
  for (const [lineIndex, rawLine] of content.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    let sample: Sample;
    try { sample = JSON.parse(line) as Sample; }
    catch { throw new Error(`${filename}:${lineIndex + 1} JSON 형식 오류`); }
    if (!validClimates.has(sample.climate) || !validTerrains.has(sample.terrain)) continue;
    const weight = Number.isFinite(sample.weight) ? Math.max(0, sample.weight ?? 1) : 1;
    const terrainCounts = counts.get(sample.climate) ?? new Map<string, number>();
    terrainCounts.set(sample.terrain, (terrainCounts.get(sample.terrain) ?? 0) + weight);
    counts.set(sample.climate, terrainCounts);
    sampleCount += 1;
  }
}

const priors: Record<string, Record<string, number>> = {};
for (const climate of Object.keys(KOPPEN_TERRAIN_PRIORS)) {
  const terrainCounts = counts.get(climate);
  if (!terrainCounts || [...terrainCounts.values()].reduce((a, b) => a + b, 0) <= 0) {
    priors[climate] = { ...KOPPEN_TERRAIN_PRIORS[climate as KoppenClimateCode] };
    continue;
  }
  const total = [...terrainCounts.values()].reduce((a, b) => a + b, 0);
  priors[climate] = Object.fromEntries(
    [...terrainCounts.entries()].map(([terrain, value]) => [terrain, Number((value / total).toFixed(6))]),
  );
}

await writeFile(outputUrl, JSON.stringify({
  ...TERRAIN_ATLAS_METADATA,
  generatedAt: new Date().toISOString(),
  sampleCount,
  priors,
}, null, 2));
console.log(JSON.stringify({ output: outputUrl.pathname, climateClasses: Object.keys(priors).length, sampleCount }, null, 2));
