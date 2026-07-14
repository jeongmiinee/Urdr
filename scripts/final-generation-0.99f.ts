import { defaultGeneratorSettings } from "../src/model/world.ts";
import { generateWorldMap } from "../src/generator/generateWorld.ts";

const started = performance.now();
const generated = generateWorldMap({
  ...defaultGeneratorSettings(),
  algorithm: "tectonic",
  renderResolution: 8192,
  mapScope: "continent",
  mapShape: "supercontinent",
  climatePreset: "Cfb",
  annualTemperatureRangeC: 10,
  erosion: 0.42,
  seed: 990_099,
  generateCountries: false,
}, 160, 100, "final");
if (generated.renderWidth !== 8192 || generated.renderHeight !== 5120) throw new Error("render resolution metadata mismatch");
if (generated.gridWidth > 768) throw new Error("final LOD cap exceeded");
console.log(JSON.stringify({
  render: [generated.renderWidth, generated.renderHeight],
  calculation: [generated.gridWidth, generated.gridHeight],
  cells: generated.gridWidth * generated.gridHeight,
  rivers: generated.rivers.length,
  quality: generated.qualityScore,
  elapsedMs: Math.round(performance.now() - started),
}, null, 2));
