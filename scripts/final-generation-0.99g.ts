import { createEmptyMap, defaultGeneratorSettings, getStateAtYear, pointInTerritoryState } from "../src/model/world.ts";
import { generateWorldMap } from "../src/generator/generateWorld.ts";
import { applyGeneratedCountries } from "../src/generator/mapPlacement.ts";

const started = performance.now();
const settings = {
  ...defaultGeneratorSettings(),
  algorithm: "tectonic" as const,
  renderResolution: 8192 as const,
  mapScope: "continent" as const,
  mapShape: "archipelago" as const,
  climatePreset: "Cfb" as const,
  annualTemperatureRangeC: 10,
  erosion: 0.42,
  seed: 990_099,
  generateCountries: true,
  countryCount: 6,
  continentCount: 7,
};
const generated = generateWorldMap(settings, 160, 100, "final");
if (generated.renderWidth !== 8192 || generated.renderHeight !== 5120) throw new Error("render resolution metadata mismatch");
if (generated.gridWidth > 768) throw new Error("final LOD cap exceeded");
const map = createEmptyMap("최종 영토 검사", 160, 100);
const placed = applyGeneratedCountries(map, generated);
const countries = placed.map.factions.filter((faction) => faction.kind === "country").slice(0, 6);
for (const country of countries) {
  const cityCount = placed.map.locations.filter((location) => {
    const state = getStateAtYear(location.states, placed.map.timeline.currentYear);
    return Boolean(state && state.ownerFactionId === country.id && ["capital", "city", "town"].includes(state.locationType));
  }).length;
  if (cityCount < 4) throw new Error(`${country.name} morphology city count ${cityCount}`);
}
let sampledLand = 0;
for (let y = 0; y < generated.gridHeight; y += 12) for (let x = 0; x < generated.gridWidth; x += 12) {
  const index = y * generated.gridWidth + x;
  const point = { x: (x + 0.5) / generated.gridWidth * map.width, y: (y + 0.5) / generated.gridHeight * map.height };
  const owners = placed.map.territories.filter((territory) => {
    const state = getStateAtYear(territory.states, placed.map.timeline.currentYear);
    return state ? pointInTerritoryState(point, state) : false;
  });
  if (generated.elevationMap[index] > generated.seaLevel) {
    sampledLand += 1;
    if (owners.length !== 1) throw new Error(`sampled land ownership ${owners.length} at ${x},${y}`);
  } else if (owners.length !== 0) throw new Error(`sampled water became territory at ${x},${y}`);
}
console.log(JSON.stringify({
  render: [generated.renderWidth, generated.renderHeight],
  calculation: [generated.gridWidth, generated.gridHeight],
  cells: generated.gridWidth * generated.gridHeight,
  rivers: generated.rivers.length,
  countries: countries.length,
  territoryPolygons: placed.map.territories.length,
  morphologyCities: placed.map.locations.length,
  sampledLand,
  quality: generated.qualityScore,
  elapsedMs: Math.round(performance.now() - started),
}, null, 2));
