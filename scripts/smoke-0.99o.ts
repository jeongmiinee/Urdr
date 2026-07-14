import {
  PROGRAM_VERSION,
  createEmptyMap,
  defaultGeneratorSettings,
  getStateAtYear,
  pointInTerritoryState,
  type GeneratedMapData,
  type MapGenerationAlgorithm,
} from "../src/model/world.ts";
import { generateWorldMap } from "../src/generator/generateWorld.ts";
import { applyGeneratedCountries, enforceMapPlacementConstraints, isLandAtPoint } from "../src/generator/mapPlacement.ts";
import { normalizeProject } from "../src/storage/projectStorage.ts";
import { UPDATE_HISTORY } from "../src/updateHistory.ts";
import demoProjectData from "../src/demoProjectData.json";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function hashNumbers(values: number[]): string {
  let hash = 2166136261 >>> 0;
  const stride = Math.max(1, Math.floor(values.length / 4096));
  for (let index = 0; index < values.length; index += stride) {
    const value = Math.round((values[index] ?? 0) * 1000);
    hash ^= value;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function shapeMetrics(data: GeneratedMapData): { circularity: number; aspectRatio: number; compactness: number; landRatio: number } {
  const { gridWidth: width, gridHeight: height } = data;
  const land = data.elevationMap.map((value) => value > data.seaLevel);
  let area = 0;
  let perimeter = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (!land[index]) continue;
      area += 1;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x + dx; const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height || !land[ny * width + nx]) perimeter += 1;
      }
    }
  }
  const bboxWidth = Math.max(1, maxX - minX + 1);
  const bboxHeight = Math.max(1, maxY - minY + 1);
  return {
    circularity: area > 0 && perimeter > 0 ? 4 * Math.PI * area / (perimeter * perimeter) : 0,
    aspectRatio: Math.max(bboxWidth / bboxHeight, bboxHeight / bboxWidth),
    compactness: area / Math.max(1, bboxWidth * bboxHeight),
    landRatio: area / Math.max(1, width * height),
  };
}

assert(PROGRAM_VERSION === "0.99o", "program version mismatch");
assert(UPDATE_HISTORY[0]?.version === "0.99o", "latest update history entry missing");
assert(UPDATE_HISTORY[0].changes.length >= 24, "v0.99o update history is too sparse");
assert(UPDATE_HISTORY.reduce((sum, entry) => sum + entry.changes.length, 0) >= 350, "complete update history is too sparse");

const normalizedDemo = normalizeProject(structuredClone(demoProjectData));
assert(normalizedDemo.version === "0.99o", "static demo migration failed");
assert(normalizedDemo.maps[0]?.generatedStates.length > 0, "static demo map missing");
assert(normalizedDemo.maps[0]?.locations.length >= 20, "static demo locations missing");
assert(normalizedDemo.wikiArticles.length >= 80, "static demo wiki coverage missing");
const demoGenerated = normalizedDemo.maps[0].generatedStates[0]?.value;
assert(demoGenerated?.settings.algorithm === "perlin", "legacy demo algorithm did not migrate safely");
assert(demoGenerated.settings.skeletonRepairPasses >= 1, "new skeleton defaults were not migrated");

const algorithms: MapGenerationAlgorithm[] = ["perlin", "delaunay_voronoi", "polygon", "mst", "wfc", "hybrid"];
const base = {
  ...defaultGeneratorSettings(),
  seed: 142_857,
  renderResolution: 256 as const,
  analysisResolution: 128 as const,
  gridWidth: 256,
  gridHeight: 160,
  mapScope: "continent" as const,
  mapShape: "supercontinent" as const,
  continentCount: 1,
  landRatio: 0.46,
  generateCountries: false,
  skeletonRepairPasses: 3,
};
const algorithmResults: Record<string, { hash: string; metrics: ReturnType<typeof shapeMetrics>; coast: number; rivers: number }> = {};
const hashes = new Set<string>();
for (const algorithm of algorithms) {
  const settings = { ...base, algorithm };
  const first = generateWorldMap(settings, 160, 100, "preview");
  const second = generateWorldMap(settings, 160, 100, "preview");
  assert(first.elevationMap.length === first.gridWidth * first.gridHeight, `${algorithm}: elevation array mismatch`);
  assert(first.terrainMap.length === first.elevationMap.length, `${algorithm}: terrain array mismatch`);
  assert(first.landMask.length === first.elevationMap.length, `${algorithm}: land mask mismatch`);
  assert(first.temperatureMap.length === first.elevationMap.length, `${algorithm}: climate array mismatch`);
  assert(first.environmentModel.version === "0.99o-landmask-post-tectonic", `${algorithm}: environment model mismatch`);
  assert(first.coastline.length > 0, `${algorithm}: coastline missing`);
  assert(first.rivers.length > 0, `${algorithm}: river network missing`);
  const hash = hashNumbers(first.elevationMap);
  assert(hash === hashNumbers(second.elevationMap), `${algorithm}: same seed is not deterministic`);
  hashes.add(hash);
  const metrics = shapeMetrics(first);
  assert(metrics.landRatio > 0.16 && metrics.landRatio < 0.62, `${algorithm}: invalid land ratio ${metrics.landRatio}`);
  const obviouslyRoundIsland = metrics.circularity > 0.68 && metrics.aspectRatio < 1.16 && metrics.compactness > 0.8;
  assert(!obviouslyRoundIsland, `${algorithm}: generated a lone round island`);
  algorithmResults[algorithm] = { hash, metrics, coast: first.coastline.length, rivers: first.rivers.length };
}
assert(hashes.size >= 5, `six algorithms are not sufficiently distinct: ${hashes.size} unique outputs`);
assert(algorithmResults.hybrid.hash !== algorithmResults.perlin.hash, "hybrid collapsed into Perlin output");
assert(algorithmResults.hybrid.hash !== algorithmResults.wfc.hash, "hybrid collapsed into WFC output");

const multi = generateWorldMap({ ...base, algorithm: "hybrid", mapShape: "multi_continent", continentCount: 3, landRatio: 0.42, seed: 881_004 }, 160, 100, "preview");
assert(multi.actualContinentCount >= 2, `multi-continent topology failed: ${multi.actualContinentCount}`);

const maxResolution = generateWorldMap({ ...base, algorithm: "hybrid", renderResolution: 8192, seed: 719_003 }, 160, 100, "final");
assert(maxResolution.renderWidth === 8192, "8192 render metadata missing");
assert(maxResolution.gridWidth <= 768, "analysis LOD exceeded safety limit");
assert(maxResolution.elevationMap.length === maxResolution.gridWidth * maxResolution.gridHeight, "8192 analysis grid mismatch");

// 국가·영토 후처리와 v0.99m의 절대 배치 제약이 새 골자에서도 유지되는지 확인한다.
const map = createEmptyMap("0.99o 영토 검사", 160, 100);
const generated = generateWorldMap({ ...base, algorithm: "hybrid", seed: 905_113, generateCountries: true, countryCount: 3, mapScope: "local", localRegionType: "archipelago", mapShape: "island", continentCount: 1 }, map.width, map.height, "preview");
map.generatedStates = [{ startYear: 0, endYear: null, value: generated }];
const placed = applyGeneratedCountries(map, generated).map;
assert(placed.factions.filter((faction) => faction.kind === "country").length >= 3, "country generation failed");
for (const location of placed.locations) {
  const state = getStateAtYear(location.states, placed.timeline.currentYear);
  if (state) assert(isLandAtPoint(generated, state.position), `location spawned at sea: ${state.name}`);
}
for (let y = 0; y < generated.gridHeight; y += 4) {
  for (let x = 0; x < generated.gridWidth; x += 4) {
    const index = y * generated.gridWidth + x;
    const point = { x: (x + 0.5) / generated.gridWidth * map.width, y: (y + 0.5) / generated.gridHeight * map.height };
    const owners = placed.territories.filter((territory) => {
      const state = getStateAtYear(territory.states, placed.timeline.currentYear);
      return state ? pointInTerritoryState(point, state) : false;
    }).length;
    assert(owners <= 1, `territory overlap remained at ${x},${y}`);
    if (generated.elevationMap[index] <= generated.seaLevel) assert(owners === 0, `territory remained at sea at ${x},${y}`);
  }
}

// 깨진 구버전 데이터도 새 알고리즘 이름과 배치 제약으로 정규화한다.
const legacy = structuredClone(demoProjectData) as any;
legacy.version = "0.99m";
legacy.maps[0].generatedStates[0].value.settings.algorithm = "voronoi";
legacy.maps[0].generatorSeedHistory = [
  { seed: 1, settings: { ...defaultGeneratorSettings(), algorithm: "sdf" }, usedAt: new Date().toISOString() },
  { seed: 2, settings: { ...defaultGeneratorSettings(), algorithm: "voronoi" }, usedAt: new Date().toISOString() },
];
const migrated = normalizeProject(legacy);
assert(migrated.maps[0].generatedStates[0].value?.settings.algorithm === "delaunay_voronoi", "legacy Voronoi migration failed");
assert(migrated.maps[0].generatorSeedHistory[0].settings.algorithm === "perlin", "deleted algorithm migration failed");
assert(migrated.maps[0].generatorSeedHistory[1].settings.algorithm === "delaunay_voronoi", "seed history Voronoi migration failed");

// 외부 JSON처럼 중첩·해상 배치가 들어와도 최종 경계에서 강제로 고친다.
const constrainedMap = createEmptyMap("배치 제약", 160, 100);
constrainedMap.generatedStates = [{ startYear: 0, endYear: null, value: generated }];
const fullPolygon = [{ x: 0, y: 0 }, { x: 160, y: 0 }, { x: 160, y: 100 }, { x: 0, y: 100 }];
constrainedMap.territories = [
  { id: "a", name: "A", states: [{ startYear: 0, endYear: null, value: { ownerFactionId: null, polygon: fullPolygon, description: "" } }] },
  { id: "b", name: "B", states: [{ startYear: 0, endYear: null, value: { ownerFactionId: null, polygon: fullPolygon, description: "" } }] },
];
const seaIndex = generated.elevationMap.findIndex((value) => value <= generated.seaLevel);
assert(seaIndex >= 0, "constraint map has no sea");
const seaX = seaIndex % generated.gridWidth;
const seaY = Math.floor(seaIndex / generated.gridWidth);
constrainedMap.locations = [{ id: "sea", states: [{ startYear: 0, endYear: null, value: { name: "바다 위 장소", locationType: "village", position: { x: (seaX + 0.5) / generated.gridWidth * 160, y: (seaY + 0.5) / generated.gridHeight * 100 }, status: "active", description: "" } }] }];
const constrained = enforceMapPlacementConstraints(constrainedMap, generated);
const correctedLocation = getStateAtYear(constrained.locations[0].states, 0);
assert(correctedLocation && isLandAtPoint(generated, correctedLocation.position), "sea location was not moved to land");
for (let y = 0; y < generated.gridHeight; y += 4) {
  for (let x = 0; x < generated.gridWidth; x += 4) {
    const index = y * generated.gridWidth + x;
    const point = { x: (x + 0.5) / generated.gridWidth * 160, y: (y + 0.5) / generated.gridHeight * 100 };
    const owners = constrained.territories.filter((territory) => {
      const state = getStateAtYear(territory.states, 0);
      return state ? pointInTerritoryState(point, state) : false;
    }).length;
    assert(owners <= 1, `normalized territories overlap at ${x},${y}`);
    if (generated.elevationMap[index] <= generated.seaLevel) assert(owners === 0, `normalized territory remains at sea at ${x},${y}`);
  }
}

console.log(JSON.stringify({
  version: PROGRAM_VERSION,
  algorithms: algorithmResults,
  uniqueSkeletonHashes: hashes.size,
  multiContinentCount: multi.actualContinentCount,
  maxRender: [maxResolution.renderWidth, maxResolution.renderHeight],
  analysisGrid: [maxResolution.gridWidth, maxResolution.gridHeight],
  countries: placed.factions.filter((faction) => faction.kind === "country").length,
  territories: placed.territories.length,
  locations: placed.locations.length,
}, null, 2));
