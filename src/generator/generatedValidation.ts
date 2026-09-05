import type { GeneratorSettings, TerrainType } from "../model/world";
import { landComponents } from "./gridComponents";
import type { HydrologyResult } from "./hydrologyTypes";

export function validateGeneratedResult(
  elevationMap: number[],
  terrainMap: TerrainType[],
  hydrology: HydrologyResult,
  width: number,
  height: number,
  seaLevel: number,
  settings: GeneratorSettings,
): { score: number; issues: string[] } {
  let score = 100;
  const issues: string[] = [];
  const land = elevationMap.map((value) => value > seaLevel);
  const landCount = land.filter(Boolean).length;
  if (landCount === 0) {
    issues.push("육지가 생성되지 않았습니다.");
    return { score: 0, issues };
  }
  if (
    hydrology.riverGraph.edges.every((edge) => !edge.render) &&
    settings.basePrecipitationMm > 450 &&
    landCount > width * height * 0.2
  ) {
    issues.push("습윤한 지도인데 하천망이 형성되지 않았습니다.");
    score -= 18;
  }
  if (
    settings.mapScaleKm <= 50 &&
    terrainMap.includes("desert") &&
    terrainMap.includes("snow")
  ) {
    let minLand = Number.POSITIVE_INFINITY;
    let maxLand = Number.NEGATIVE_INFINITY;
    for (const value of elevationMap)
      if (value > seaLevel) {
        minLand = Math.min(minLand, value);
        maxLand = Math.max(maxLand, value);
      }
    const range = Number.isFinite(minLand) ? maxLand - minLand : 0;
    if (range < 2800) {
      issues.push(
        "지역 지도에서 사막과 설원이 설명 가능한 고도차 없이 함께 존재합니다.",
      );
      score -= 24;
    }
  }
  const basinCount = new Set(hydrology.basinMap.filter((value) => value >= 0))
    .size;
  if (basinCount === 0) {
    issues.push("유역을 식별하지 못했습니다.");
    score -= 20;
  }
  const tinyComponents = landComponents(land, width, height).filter(
    (component) => component.size < Math.max(4, width * height * 0.0008),
  ).length;
  if (tinyComponents > 12) {
    issues.push("지나치게 작은 육지 파편이 많습니다.");
    score -= Math.min(15, Math.floor(tinyComponents / 3));
  }
  return { score: Math.max(0, score), issues };
}
