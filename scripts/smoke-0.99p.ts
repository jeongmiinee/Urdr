import { readFileSync } from "node:fs";
import {
  PROGRAM_VERSION,
  defaultGeneratorSettings,
  type GeneratedMapData,
} from "../src/model/world.ts";
import { generateWorldMap } from "../src/generator/generateWorld.ts";
import { normalizeProject } from "../src/storage/projectStorage.ts";
import { UPDATE_HISTORY } from "../src/updateHistory.ts";
import demoProjectData from "../src/demoProjectData.json";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function centerAndRing(data: GeneratedMapData): { center: number; ring: number } {
  const cx = Math.floor(data.gridWidth / 2);
  const cy = Math.floor(data.gridHeight / 2);
  const center = data.elevationMap[cy * data.gridWidth + cx];
  const ring: number[] = [];
  const inner = Math.max(8, Math.min(data.gridWidth, data.gridHeight) * 0.055);
  const outer = inner * 1.8;
  for (let y = 0; y < data.gridHeight; y += 1) for (let x = 0; x < data.gridWidth; x += 1) {
    const distance = Math.hypot(x - cx, y - cy);
    const index = y * data.gridWidth + x;
    if (distance >= inner && distance <= outer && data.waterTypeMap[index] === "land") ring.push(data.elevationMap[index]);
  }
  return { center, ring: ring.reduce((sum, value) => sum + value, 0) / Math.max(1, ring.length) };
}

assert(PROGRAM_VERSION === "0.99p", "program version mismatch");
assert(UPDATE_HISTORY[0]?.version === "0.99p", "latest update history entry missing");
const defaults = defaultGeneratorSettings();
assert(defaults.analysisResolution === 1024, "default analysis resolution mismatch");
assert(defaults.renderResolution === 2048, "default render resolution mismatch");

const normalizedDemo = normalizeProject(structuredClone(demoProjectData));
assert(normalizedDemo.version === "0.99p", "demo migration did not adopt v0.99p");
const migratedGenerated = normalizedDemo.maps[0]?.generatedStates[0]?.value;
assert(Boolean(migratedGenerated?.waterTypeMap?.length), "legacy water type migration missing");
assert(Boolean(migratedGenerated?.coastalTerrainMap?.length), "legacy coastal tile migration missing");

const base = {
  ...defaults,
  analysisResolution: 512 as const,
  renderResolution: 512 as const,
  mapScope: "continent" as const,
  mapShape: "supercontinent" as const,
  continentCount: 1,
  landRatio: 0.48,
  generateCountries: false,
  riverNodeCount: 8,
  seed: 734_521,
};

console.log("[smoke] continent terrain/water/biome");
let continent: GeneratedMapData | null = generateWorldMap({ ...base, algorithm: "hybrid" }, 160, 100, "preview");
assert(continent.gridWidth === 512 && continent.gridHeight === 320, "preview analysis grid mismatch");
assert(continent.waterTypeMap.length === continent.elevationMap.length, "water map mismatch");
assert(continent.coastalTerrainMap.length === continent.elevationMap.length, "coastal map mismatch");
assert(continent.environmentModel.version === "0.99p-water-biome-coast", "environment model mismatch");
assert(continent.coastline.length > 0, "coastline missing");
assert(continent.waterTypeMap.every((type) => type === "land" || type === "saltwater" || type === "freshwater"), "invalid water type");
const center = centerAndRing(continent);
assert(center.center > continent.seaLevel, "map center unexpectedly submerged");
assert(center.ring - center.center < 650, `suspicious fixed central depression remains (${center.center} vs ${center.ring})`);
const land = continent.waterTypeMap.filter((type) => type === "land").length;
const desert = continent.terrainMap.filter((type, index) => type === "desert" && continent?.waterTypeMap[index] === "land").length;
assert(desert / Math.max(1, land) < 0.12, "temperate desert ratio too high");
assert(continent.waterTypeMap.some((type) => type === "freshwater"), "freshwater/lake tiles missing");
continent = null;
(globalThis as any).gc?.();

console.log("[smoke] local coastal tiles");
let localCoast: GeneratedMapData | null = generateWorldMap({
  ...base,
  mapScope: "local",
  localRegionType: "coast",
  mapShape: "island",
  mapScaleKm: 20,
  seed: 91_113,
  tidalRangeM: 5.6,
  prevailingWindSpeed: 9,
}, 160, 100, "preview");
const coastalTiles = localCoast.coastalTerrainMap.filter((type) => type !== "none");
assert(coastalTiles.length > 0, "local coastal terrain tiles missing");
localCoast = null;
(globalThis as any).gc?.();

console.log("[smoke] continent road guard");
const placementSource = readFileSync(new URL("../src/generator/mapPlacement.ts", import.meta.url), "utf8");
assert(/mapScope === ["']continent["'][\s\S]{0,220}GENERATED_ROAD_PREFIX/.test(placementSource), "continent road-generation guard missing");

const highResolutionGrid = [1024, 640];
const highResolutionRender = [2048, 1280];
console.log(JSON.stringify({
  version: PROGRAM_VERSION,
  center,
  desertRatio: desert / Math.max(1, land),
  coastalTiles: coastalTiles.length,
  continentRoads: 0,
  highResolutionGrid,
  highResolutionRender,
}, null, 2));
