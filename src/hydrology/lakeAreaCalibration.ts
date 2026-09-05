import type { GeneratorSettings } from "../model/world";

/** HydroLAKES v1 natural lakes (Lake_type = 1, Lake_area >= 0.1 km2). */
export const HYDROLAKES_NATURAL_AREA_STATS = Object.freeze({
  source: "HydroLAKES v1",
  sourceUrl: "https://www.hydrosheds.org/products/hydrolakes",
  sampleCount: 1_420_891,
  totalAreaKm2: 2_471_784.5700189495,
  meanAreaKm2: 1.7396018202796339,
  standardDeviationKm2: 338.65652979519547,
  minimumAreaKm2: 0.1,
  maximumAreaKm2: 377_001.91,
  medianAreaKm2: 0.23,
  percentile75AreaKm2: 0.5,
  percentile90AreaKm2: 1.25,
  percentile95AreaKm2: 2.38,
  percentile99AreaKm2: 10.24,
  percentile999AreaKm2: 91.0477,
  /** N(>= area) follows approximately area^-1.05434 in the published fit. */
  survivalExponent: 1.05434,
  referenceLandAreaKm2: 148_940_000,
});

export type LakeAreaGenerationPlan = {
  mapAreaKm2: number;
  inlandAreaKm2: number;
  cellAreaKm2: number;
  minimumLakeCells: number;
  minimumVisibleAreaKm2: number;
  expectedVisibleLakeCount: number;
  maximumLakeCount: number;
  maximumTotalLakeCells: number;
  targetLakeCells: number[];
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function deterministicUnit(seed: number, index: number): number {
  let hash = Math.imul(seed + 1, 0x9e3779b1) ^ Math.imul(index + 1, 0x85ebca6b);
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x846ca68b);
  return ((hash ^ (hash >>> 16)) >>> 0) / 4_294_967_296;
}

function sampleTruncatedLakeAreaKm2(
  minimumAreaKm2: number,
  maximumAreaKm2: number,
  unit: number,
): number {
  const alpha = HYDROLAKES_NATURAL_AREA_STATS.survivalExponent;
  const minimum = Math.max(HYDROLAKES_NATURAL_AREA_STATS.minimumAreaKm2, minimumAreaKm2);
  const maximum = Math.max(minimum, maximumAreaKm2);
  if (maximum <= minimum * 1.000001) return minimum;
  const lowerPower = Math.pow(minimum, -alpha);
  const upperPower = Math.pow(maximum, -alpha);
  return Math.pow(lowerPower - clamp(unit, 0, 1) * (lowerPower - upperPower), -1 / alpha);
}

/**
 * Converts the real-world physical lake-area distribution into resolvable grid
 * budgets. Small lakes that cannot occupy a stable connected mask are omitted
 * rather than enlarged into identical artificial lakes.
 */
export function createLakeAreaGenerationPlan(
  settings: GeneratorSettings,
  width: number,
  height: number,
  inlandCellCount: number,
): LakeAreaGenerationPlan {
  const gridCells = Math.max(1, width * height);
  const physicalWidthKm = Math.max(0.001, settings.mapScaleKm);
  const physicalHeightKm = physicalWidthKm * height / Math.max(1, width);
  const mapAreaKm2 = physicalWidthKm * physicalHeightKm;
  const cellAreaKm2 = mapAreaKm2 / gridCells;
  const boundedInlandCells = clamp(Math.round(inlandCellCount), 0, gridCells);
  const inlandAreaKm2 = boundedInlandCells * cellAreaKm2;
  const minimumLakeCells = Math.max(4, Math.round(Math.sqrt(gridCells) * 0.035));
  const minimumVisibleAreaKm2 = Math.max(
    HYDROLAKES_NATURAL_AREA_STATS.minimumAreaKm2,
    minimumLakeCells * cellAreaKm2,
  );
  const density = HYDROLAKES_NATURAL_AREA_STATS.sampleCount
    / HYDROLAKES_NATURAL_AREA_STATS.referenceLandAreaKm2;
  const expectedVisibleLakeCount = inlandAreaKm2 * density * Math.pow(
    minimumVisibleAreaKm2 / HYDROLAKES_NATURAL_AREA_STATS.minimumAreaKm2,
    -HYDROLAKES_NATURAL_AREA_STATS.survivalExponent,
  );
  const hardMaximum = settings.mapScope === "local" || settings.mapScope === "regional" ? 10 : 24;
  const wholeCount = Math.floor(expectedVisibleLakeCount);
  const roundedCount = wholeCount + (
    deterministicUnit(settings.seed + 71_309, 0) < expectedVisibleLakeCount - wholeCount ? 1 : 0
  );
  const maximumLakeCount = clamp(roundedCount, 0, hardMaximum);
  const maximumIndividualAreaKm2 = Math.min(
    HYDROLAKES_NATURAL_AREA_STATS.maximumAreaKm2,
    Math.max(minimumVisibleAreaKm2, inlandAreaKm2 * 0.08),
  );
  const maximumTotalLakeCells = Math.max(
    0,
    Math.min(boundedInlandCells, Math.floor(boundedInlandCells * 0.08)),
  );
  let remainingCells = maximumTotalLakeCells;
  const targetLakeCells = Array.from({ length: maximumLakeCount }, (_, index) => {
    const areaKm2 = sampleTruncatedLakeAreaKm2(
      minimumVisibleAreaKm2,
      maximumIndividualAreaKm2,
      deterministicUnit(settings.seed + 91_907, index),
    );
    return Math.max(minimumLakeCells, Math.round(areaKm2 / Math.max(1e-12, cellAreaKm2)));
  }).sort((a, b) => b - a).map((cells) => {
    const accepted = Math.min(cells, remainingCells);
    remainingCells -= accepted;
    return accepted;
  }).filter((cells) => cells >= minimumLakeCells);

  return {
    mapAreaKm2,
    inlandAreaKm2,
    cellAreaKm2,
    minimumLakeCells,
    minimumVisibleAreaKm2,
    expectedVisibleLakeCount,
    maximumLakeCount: targetLakeCells.length,
    maximumTotalLakeCells,
    targetLakeCells,
  };
}
