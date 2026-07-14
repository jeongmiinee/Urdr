import { readFileSync } from "node:fs";
import {
  MAP_SCALE_RANGES,
  PROGRAM_VERSION,
  createEmptyMap,
  createEmptyProject,
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

function hasGrowingRiver(data: GeneratedMapData): boolean {
  let firstWidth = 0;
  let previousEnd: { x: number; y: number } | null = null;
  let previousBasin = -1;
  for (const segment of data.rivers) {
    const continuous =
      previousEnd !== null &&
      previousBasin === segment.basinId &&
      Math.hypot(
        previousEnd.x - segment.start.x,
        previousEnd.y - segment.start.y,
      ) < 1e-6;
    if (!continuous) firstWidth = segment.width;
    if (continuous && segment.width > firstWidth * 1.18) return true;
    previousEnd = segment.end;
    previousBasin = segment.basinId;
    if (segment.mouth) previousEnd = null;
  }
  return false;
}

assert(PROGRAM_VERSION === "0.99p", "program version mismatch");
assert(
  UPDATE_HISTORY[0]?.version === "0.99p",
  "latest update history entry missing",
);
assert(
  MAP_SCALE_RANGES.local.min === 1 && MAP_SCALE_RANGES.local.max === 100,
  "local range mismatch",
);
assert(
  MAP_SCALE_RANGES.regional.min === 100 &&
    MAP_SCALE_RANGES.regional.max === 1000,
  "regional range mismatch",
);
assert(
  MAP_SCALE_RANGES.continent.min === 1000 &&
    MAP_SCALE_RANGES.continent.max === 10000,
  "continent range mismatch",
);
assert(
  MAP_SCALE_RANGES.world.min === 10000 && MAP_SCALE_RANGES.world.max === 40000,
  "world range mismatch",
);

const emptyProject = createEmptyProject("통합 테스트");
assert(
  emptyProject.maps.length === 0 && emptyProject.activeMapId === null,
  "new project must not choose a map engine",
);
const freeLocal = createEmptyMap("자유 지방", 160, 100, "free", "local", 40);
const realisticWorld = createEmptyMap(
  "현실 세계",
  160,
  100,
  "realistic",
  "world",
  32000,
);
assert(
  freeLocal.generationMode === "free" && freeLocal.scaleMode === "local",
  "free map metadata mismatch",
);
assert(
  realisticWorld.generationMode === "realistic" &&
    realisticWorld.scaleMode === "world",
  "realistic map metadata mismatch",
);

const normalizedDemo = normalizeProject(structuredClone(demoProjectData));
assert(
  normalizedDemo.version === "0.99p",
  "demo migration did not adopt v0.99p",
);
assert(
  normalizedDemo.maps[0]?.generationMode === "realistic",
  "legacy map mode migration missing",
);

const defaults = defaultGeneratorSettings();
const settings = {
  ...defaults,
  analysisResolution: 512 as const,
  renderResolution: 512 as const,
  mapScope: "continent" as const,
  mapScaleKm: 4200,
  mapShape: "supercontinent" as const,
  continentCount: 1,
  landRatio: 0.48,
  generateCountries: false,
  riverNodeCount: 20,
  seed: 734_521,
};

console.log("[smoke] realistic generation, lake metadata, downstream width");
const generated = generateWorldMap(settings, 160, 100, "preview");
assert(
  generated.gridWidth === 512 && generated.gridHeight === 320,
  "preview grid mismatch",
);
assert(
  generated.waterTypeMap.length === generated.elevationMap.length,
  "water map mismatch",
);
assert(
  generated.lakeIdMap.length === generated.elevationMap.length,
  "lake id map mismatch",
);
assert(
  generated.lakeIdMap.every(
    (id) =>
      id === -1 || (id >= 0 && id < generated.lakeSurfaceElevations.length),
  ),
  "invalid lake id",
);
assert(generated.rivers.length > 0, "rivers missing");
assert(
  hasGrowingRiver(generated),
  "no downstream-growing river sequence detected",
);

const viewportSource = readFileSync(
  new URL("../src/components/MapViewport.tsx", import.meta.url),
  "utf8",
);
assert(
  viewportSource.includes("resolution: textResolution()"),
  "high-resolution text layer missing",
);
assert(
  viewportSource.includes("width: width / Math.max(1, viewScale)"),
  "road maximum screen width cap missing",
);
assert(
  viewportSource.includes("cappedLocalScale(viewScale)"),
  "label/icon maximum size cap missing",
);
const hydrologySource = readFileSync(
  new URL("../src/generator/generateWorld.ts", import.meta.url),
  "utf8",
);
assert(
  hydrologySource.includes("lakeSurfaceElevations.push(surfaceLevel)"),
  "equal lake surface storage missing",
);
assert(
  hydrologySource.includes("downstreamGrowth"),
  "downstream width growth missing",
);
assert(
  hydrologySource.includes("mouthEnvelope"),
  "coastal river curvature missing",
);
const styles = readFileSync(
  new URL("../src/styles.css", import.meta.url),
  "utf8",
);
assert(
  styles.includes("max-height: calc(100vh - 40px)"),
  "settings modal scroll cap missing",
);
assert(
  styles.includes("--preview-font-scale"),
  "live font preview scaling missing",
);

console.log(
  JSON.stringify(
    {
      version: PROGRAM_VERSION,
      mapsInNewProject: emptyProject.maps.length,
      mapScales: MAP_SCALE_RANGES,
      grid: [generated.gridWidth, generated.gridHeight],
      rivers: generated.rivers.length,
      lakes: generated.lakeSurfaceElevations.length,
      growingRiver: hasGrowingRiver(generated),
      qualityScore: generated.qualityScore,
    },
    null,
    2,
  ),
);
