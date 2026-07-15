import type { CoastalTerrainType, GeneratorSettings, WaterType } from "../model/world";
import type { calculateEnvironment } from "./environment";
import type { HydrologyResult } from "./hydrologyTypes";

const clamp = (value: number, min = 0, max = 1) =>
  Math.max(min, Math.min(max, value));

/** 국지 해안 지도에서 바람·파랑·조차·퇴적·하천 조건으로 실제 해안가 타일을 만든다. */
export function generateCoastalTerrainTiles(
  elevation: number[],
  waterTypeMap: WaterType[],
  environment: ReturnType<typeof calculateEnvironment>,
  hydrology: HydrologyResult,
  width: number,
  height: number,
  seaLevel: number,
  settings: GeneratorSettings,
): CoastalTerrainType[] {
  const result = new Array<CoastalTerrainType>(elevation.length).fill("none");
  if (
    (settings.mapScope !== "local" && settings.mapScope !== "regional") ||
    settings.localRegionType !== "coast"
  )
    return result;
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const;
  const tidal = clamp((settings.tidalRangeM ?? 2.2) / 12);
  for (let y = 1; y < height - 1; y += 1)
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x;
      if (waterTypeMap[index] !== "land") continue;
      let seaX = 0,
        seaY = 0,
        seaCount = 0,
        freshCount = 0,
        riverNearby = 0;
      for (let oy = -2; oy <= 2; oy += 1)
        for (let ox = -2; ox <= 2; ox += 1) {
          if (ox === 0 && oy === 0) continue;
          const nx = x + ox,
            ny = y + oy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const next = ny * width + nx;
          if (
            Math.abs(ox) + Math.abs(oy) === 1 &&
            waterTypeMap[next] === "saltwater"
          ) {
            seaX += ox;
            seaY += oy;
            seaCount += 1;
          }
          if (waterTypeMap[next] === "freshwater") freshCount += 1;
          if ((hydrology.riverOrderMap[next] ?? 0) > 0)
            riverNearby = Math.max(
              riverNearby,
              hydrology.riverOrderMap[next] ?? 0,
            );
        }
      if (!seaCount) continue;
      const length = Math.max(1e-6, Math.hypot(seaX, seaY));
      const normalX = seaX / length,
        normalY = seaY / length;
      const wx = environment.windXMap[index] ?? 0,
        wy = environment.windYMap[index] ?? 0;
      const windSpeed = Math.hypot(wx, wy),
        windLength = Math.max(1e-6, windSpeed);
      const onshore = Math.max(
        0,
        (wx / windLength) * -normalX + (wy / windLength) * -normalY,
      );
      const alongshore = Math.abs(
        (wx / windLength) * normalY - (wy / windLength) * normalX,
      );
      const wave = clamp(windSpeed / 18) * (0.35 + 0.65 * onshore);
      const left = elevation[index - 1],
        right = elevation[index + 1],
        up = elevation[index - width],
        down = elevation[index + width];
      const slope =
        Math.hypot(right - left, down - up) /
        Math.max(1, settings.maxElevation * 0.18);
      const runoff = environment.runoffMap[index] ?? 0;
      const sediment = clamp(
        ((environment.precipitationMap[index] ?? 0) / 1800) * 0.22 +
          (runoff / 900) * 0.34 +
          (1 - clamp(slope)) * 0.34 +
          riverNearby * 0.08,
      );
      if (riverNearby >= 3 || runoff > 520)
        result[index] = tidal > 0.48 || wave > 0.52 ? "estuary" : "delta";
      else if (slope > 0.56 && wave > 0.48) result[index] = "coastal_cliff";
      else if (slope > 0.38 || wave > 0.68)
        result[index] = sediment > 0.42 ? "gravel_beach" : "rocky_coast";
      else if (tidal > 0.55 && wave < 0.48 && sediment > 0.42)
        result[index] =
          freshCount > 0 || runoff > 280 ? "salt_marsh" : "mudflat";
      else if (alongshore > 0.62 && sediment > 0.56) result[index] = "sandbar";
      else result[index] = sediment > 0.34 ? "sand_beach" : "gravel_beach";
    }
  // 사주 안쪽의 얕은 해수 타일을 석호로 표시한다.
  for (let y = 1; y < height - 1; y += 1)
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x;
      if (waterTypeMap[index] !== "saltwater") continue;
      let bars = 0,
        land = 0;
      for (const [dx, dy] of dirs) {
        const next = (y + dy) * width + x + dx;
        if (result[next] === "sandbar") bars += 1;
        if (waterTypeMap[next] === "land") land += 1;
      }
      if (bars > 0 && land >= 2 && elevation[index] > seaLevel - 120)
        result[index] = "lagoon";
    }
  return result;
}
