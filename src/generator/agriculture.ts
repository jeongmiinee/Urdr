import type { GeneratedMapData, TerrainType } from "../model/world";

export const AGRICULTURE_VISIBLE_THRESHOLD = 0.42;

export function naturalTerrainAt(data: GeneratedMapData, index: number): TerrainType {
  const terrain = data.baseTerrainMap?.[index] ?? data.terrainMap[index] ?? "plain";
  return terrain === "farmland" ? "plain" : terrain;
}

export function agricultureAt(data: GeneratedMapData, index: number): number {
  const stored = data.agricultureMap?.[index];
  if (Number.isFinite(stored)) return Math.max(0, Math.min(1, stored ?? 0));
  return data.terrainMap[index] === "farmland" ? 1 : 0;
}

export function effectiveTerrainAt(data: GeneratedMapData, index: number): TerrainType {
  return agricultureAt(data, index) >= AGRICULTURE_VISIBLE_THRESHOLD
    ? "farmland"
    : naturalTerrainAt(data, index);
}

export function normalizedNaturalTerrainMap(data: GeneratedMapData): TerrainType[] {
  return data.terrainMap.map((_terrain, index) => naturalTerrainAt(data, index));
}

export function normalizedAgricultureMap(data: GeneratedMapData): number[] {
  return data.terrainMap.map((_terrain, index) => agricultureAt(data, index));
}
