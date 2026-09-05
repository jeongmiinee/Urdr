import type { GeneratedMapData, LocationType, MapData, Point } from "../../model/world";
import { getStateAtYear } from "../../model/world";
import { createGridTransform } from "../gridTransform";
import { generatedSettlementName } from "./naming";

type SettlementRank = Extract<LocationType, "village" | "town" | "city" | "capital">;

export type PlannedSettlement = {
  cellIndex: number;
  ownerIndex: number;
  rank: SettlementRank;
  score: number;
  population: number;
  economy: number;
  name: string;
  coastal: boolean;
};

export type SettlementHierarchy = {
  sites: PlannedSettlement[];
  growthSeedsByCountry: number[][];
};

type Candidate = {
  index: number;
  owner: number;
  score: number;
  capacity: number;
  coastal: boolean;
  transport: boolean;
};

const SETTLEMENT_RANKS: SettlementRank[] = ["capital", "city", "town", "village"];

function isLand(data: GeneratedMapData, index: number): boolean {
  return data.waterTypeMap[index] === "land" && data.elevationMap[index] > data.seaLevel;
}

function neighborHasWater(data: GeneratedMapData, x: number, y: number, water: "saltwater" | "freshwater", radius: number): boolean {
  for (let oy = -radius; oy <= radius; oy += 1) {
    for (let ox = -radius; ox <= radius; ox += 1) {
      const nx = x + ox;
      const ny = y + oy;
      if (nx < 0 || ny < 0 || nx >= data.gridWidth || ny >= data.gridHeight) continue;
      if (data.waterTypeMap[ny * data.gridWidth + nx] === water) return true;
    }
  }
  return false;
}

function buildCandidates(
  data: GeneratedMapData,
  owner: Int16Array,
  riverMask: Uint8Array,
  transportMask: Uint8Array,
): Candidate[] {
  const candidates: Candidate[] = [];
  const maximumRelief = Math.max(1, data.settings.maxElevation - data.seaLevel);
  for (let y = 1; y < data.gridHeight - 1; y += 1) {
    for (let x = 1; x < data.gridWidth - 1; x += 1) {
      const index = y * data.gridWidth + x;
      if (!isLand(data, index)) continue;
      const terrain = data.terrainMap[index];
      if (["snow", "bedrock", "rock"].includes(terrain)) continue;
      const left = data.elevationMap[index - 1];
      const right = data.elevationMap[index + 1];
      const up = data.elevationMap[index - data.gridWidth];
      const down = data.elevationMap[index + data.gridWidth];
      const slope = (Math.abs(left - right) + Math.abs(up - down)) / maximumRelief;
      if (slope > 0.16) continue;
      const flow = data.flowAccumulationMap[index] ?? 0;
      if (riverMask[index] && flow > 0.14) continue;

      const temperature = data.temperatureMap[index] ?? 12;
      const precipitation = data.precipitationMap[index] ?? 700;
      const climate = Math.max(0, 1 - Math.abs(temperature - 15) / 30)
        + Math.max(0, 1 - Math.abs(precipitation - 850) / 1_350);
      const farmland = data.agricultureMap?.[index] ?? (terrain === "farmland" ? 1 : ["plain", "grassland"].includes(terrain) ? 0.55 : 0.12);
      const freshwater = neighborHasWater(data, x, y, "freshwater", 3);
      const coastal = neighborHasWater(data, x, y, "saltwater", 2);
      const riverAccess = !riverMask[index] && (() => {
        for (let oy = -2; oy <= 2; oy += 1) for (let ox = -2; ox <= 2; ox += 1) {
          if (riverMask[(y + oy) * data.gridWidth + x + ox]) return true;
        }
        return false;
      })();
      const transport = Boolean(transportMask[index]);
      const wetlandPenalty = terrain === "wetland" ? 1.8 : 0;
      const score = climate * 0.62 + farmland * 2.25 + (freshwater ? 0.75 : 0)
        + (riverAccess ? 0.58 : 0) + (coastal ? 0.35 : 0) + (transport ? 0.92 : 0)
        - slope * 8 - wetlandPenalty;
      const capacity = Math.max(0.08, farmland * 0.56 + climate * 0.18 + (freshwater || riverAccess ? 0.18 : 0.04) + (transport ? 0.18 : 0));
      candidates.push({ index, owner: owner[index] ?? -1, score, capacity, coastal, transport });
    }
  }
  return candidates;
}

function targetCounts(data: GeneratedMapData): Record<SettlementRank, number> {
  return {
    village: Math.max(0, Math.trunc(data.settings.settlementVillageCount)),
    town: Math.max(0, Math.trunc(data.settings.settlementTownCount)),
    city: Math.max(0, Math.trunc(data.settings.settlementCityCount)),
    capital: Math.max(0, Math.trunc(data.settings.settlementCapitalCount)),
  };
}

function pointForCell(data: GeneratedMapData, index: number): Point {
  return createGridTransform(data.worldWidth, data.worldHeight, data.gridWidth, data.gridHeight)
    .cellCenterToWorld(index % data.gridWidth, Math.floor(index / data.gridWidth));
}

function existingCounts(map: MapData): Record<SettlementRank, number> {
  const counts: Record<SettlementRank, number> = { village: 0, town: 0, city: 0, capital: 0 };
  for (const location of map.locations) {
    const state = getStateAtYear(location.states, map.timeline.currentYear);
    if (state && SETTLEMENT_RANKS.includes(state.locationType as SettlementRank)) counts[state.locationType as SettlementRank] += 1;
  }
  return counts;
}

export function planSettlementHierarchy(
  data: GeneratedMapData,
  map: MapData,
  countryIds: string[],
  capitalCells: number[],
  owner: Int16Array,
  riverMask: Uint8Array,
  transportMask: Uint8Array,
): SettlementHierarchy {
  const candidates = buildCandidates(data, owner, riverMask, transportMask);
  const desired = targetCounts(data);
  const existing = data.settings.preserveExistingSettlements ? existingCounts(map) : { village: 0, town: 0, city: 0, capital: 0 };
  const usedCells = new Set<number>();
  const sites: PlannedSettlement[] = [];
  const usedNames = new Set<string>();
  const totalDesired = Object.values(desired).reduce((sum, value) => sum + value, 0);
  const baseSpacing = Math.max(2.2, Math.sqrt(data.gridWidth * data.gridHeight / Math.max(1, totalDesired)) * 0.48);

  const addSite = (candidate: Candidate, rank: SettlementRank, sequence: number) => {
    const rankScale = rank === "capital" ? 1 : rank === "city" ? 0.72 : rank === "town" ? 0.34 : 0.11;
    const population = Math.max(
      rank === "village" ? 80 : rank === "town" ? 1_500 : rank === "city" ? 18_000 : 55_000,
      Math.round((rank === "capital" ? 105_000 : rank === "city" ? 42_000 : rank === "town" ? 6_500 : 620)
        * candidate.capacity * (0.82 + Math.max(0, candidate.score) * 0.08)),
    );
    const economy = Math.max(1, Math.min(100, Math.round(candidate.capacity * 38 + (candidate.transport ? 22 : 0) + rankScale * 34)));
    const ownerIndex = candidate.owner >= 0 ? candidate.owner : 0;
    const name = generatedSettlementName(data.settings.seed, ownerIndex, sequence, rank, usedNames);
    sites.push({
      cellIndex: candidate.index,
      ownerIndex,
      rank,
      score: candidate.score,
      population,
      economy,
      name,
      coastal: candidate.coastal,
    });
    usedCells.add(candidate.index);
  };

  const mandatoryCapitals = Math.min(
    Math.max(0, desired.capital - existing.capital),
    capitalCells.length,
  );
  for (let index = 0; index < mandatoryCapitals; index += 1) {
    const cell = capitalCells[index];
    const candidate = candidates.find((item) => item.index === cell) ?? {
      index: cell, owner: index, score: 2, capacity: 0.9, coastal: false, transport: true,
    };
    addSite({ ...candidate, owner: index }, "capital", index);
  }

  let sequence = sites.length;
  for (const rank of SETTLEMENT_RANKS) {
    const alreadyPlanned = sites.filter((site) => site.rank === rank).length;
    const needed = Math.max(0, desired[rank] - existing[rank] - alreadyPlanned);
    const spacingScale = rank === "capital" ? 2.2 : rank === "city" ? 1.65 : rank === "town" ? 1.05 : 0.48;
    let relaxation = 1;
    while (sites.filter((site) => site.rank === rank).length < alreadyPlanned + needed && relaxation >= 0.28) {
      const selected = candidates
        .filter((candidate) => !usedCells.has(candidate.index))
        .map((candidate) => ({
          candidate,
          score: candidate.score
            + candidate.capacity * (rank === "village" ? 1.4 : 2.2)
            + (candidate.transport && rank !== "village" ? 1.1 : 0),
        }))
        .sort((a, b) => b.score - a.score)
        .find(({ candidate }) => {
          const x = candidate.index % data.gridWidth;
          const y = Math.floor(candidate.index / data.gridWidth);
          return sites.every((site) => {
            const sx = site.cellIndex % data.gridWidth;
            const sy = Math.floor(site.cellIndex / data.gridWidth);
            const otherScale = site.rank === "capital" ? 1.8 : site.rank === "city" ? 1.35 : site.rank === "town" ? 0.9 : 0.45;
            return Math.hypot(x - sx, y - sy) >= baseSpacing * Math.max(spacingScale, otherScale) * relaxation;
          });
        });
      if (!selected) {
        relaxation -= 0.12;
        continue;
      }
      addSite(selected.candidate, rank, sequence++);
    }
    while (sites.filter((site) => site.rank === rank).length < alreadyPlanned + needed) {
      const fallback = candidates
        .filter((candidate) => !usedCells.has(candidate.index))
        .sort((a, b) => b.score - a.score)[0];
      if (!fallback) break;
      addSite(fallback, rank, sequence++);
    }
  }

  const growthSeedsByCountry = Array.from({ length: countryIds.length }, () => [] as number[]);
  for (const site of sites) {
    if (growthSeedsByCountry[site.ownerIndex]) growthSeedsByCountry[site.ownerIndex].push(site.cellIndex);
  }
  capitalCells.forEach((cell, country) => {
    if (growthSeedsByCountry[country] && !growthSeedsByCountry[country].includes(cell)) growthSeedsByCountry[country].unshift(cell);
  });
  return { sites, growthSeedsByCountry };
}

export function settlementPoint(data: GeneratedMapData, site: PlannedSettlement): Point {
  return pointForCell(data, site.cellIndex);
}
