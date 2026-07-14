import type { CoastalTerrainType, GeneratedMapData, TerrainType } from "../model/world";

export type GeneratedPreviewRaster = {
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
};

const TERRAIN_COLORS: Record<TerrainType, [number, number, number]> = {
  mountain: [111, 96, 84], forest: [42, 102, 70], desert: [211, 168, 78], snow: [232, 240, 245],
  grassland: [116, 161, 72], plain: [157, 184, 91], farmland: [176, 166, 82], jungle: [28, 91, 48],
  wetland: [73, 105, 91], rock: [108, 113, 117], bedrock: [75, 78, 82],
};

const COASTAL_COLORS: Partial<Record<CoastalTerrainType, [number, number, number]>> = {
  sand_beach: [226, 205, 142], gravel_beach: [151, 145, 129], rocky_coast: [91, 96, 99],
  coastal_cliff: [89, 77, 67], mudflat: [132, 119, 91], salt_marsh: [82, 124, 92],
  sandbar: [218, 196, 128], lagoon: [75, 154, 171], delta: [112, 145, 89], estuary: [74, 132, 151],
};

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function waterColor(depth: number): [number, number, number] {
  const normalized = Math.max(0, Math.min(1, depth / 5000));
  return [Math.round(48 - normalized * 23), Math.round(126 - normalized * 47), Math.round(170 - normalized * 48)];
}

/** Worker에서도 실행 가능한 DOM 비의존 저해상도 미리보기 래스터를 만든다. */
export function createGeneratedPreviewRaster(data: GeneratedMapData, maximumWidth = 768): GeneratedPreviewRaster {
  const aspect = data.gridHeight / Math.max(1, data.gridWidth);
  const width = Math.max(128, Math.min(maximumWidth, Math.round(data.gridWidth * Math.max(1, maximumWidth / Math.max(1, data.gridWidth)))));
  const height = Math.max(64, Math.round(width * aspect));
  const pixels = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.max(0, Math.min(data.gridHeight - 1, Math.floor(((y + 0.5) / height) * data.gridHeight)));
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.max(0, Math.min(data.gridWidth - 1, Math.floor(((x + 0.5) / width) * data.gridWidth)));
      const index = sourceY * data.gridWidth + sourceX;
      const elevation = data.elevationMap[index] ?? data.seaLevel;
      const waterType = data.waterTypeMap?.[index] ?? (elevation <= data.seaLevel ? "saltwater" : "land");
      const submerged = waterType !== "land";
      const terrain = data.terrainMap[index] ?? "plain";
      const baseTerrain = data.snowBaseTerrainMap?.[index] ?? terrain;
      let [r, g, b] = submerged
        ? waterType === "freshwater" ? [56, 139, 176] : waterColor(data.seaLevel - elevation)
        : (TERRAIN_COLORS[baseTerrain] ?? TERRAIN_COLORS[terrain]);
      const coastal = COASTAL_COLORS[data.coastalTerrainMap?.[index] ?? "none"];
      if (coastal) {
        const mix = submerged ? 0.78 : 0.86;
        r += (coastal[0] - r) * mix;
        g += (coastal[1] - g) * mix;
        b += (coastal[2] - b) * mix;
      }
      if (!submerged) {
        const snowCover = Math.max(0, Math.min(1, data.snowCoverMap?.[index] ?? (terrain === "snow" ? 1 : 0)));
        const snowMix = Math.pow(snowCover, 0.82) * 0.96;
        r += (242 - r) * snowMix;
        g += (247 - g) * snowMix;
        b += (250 - b) * snowMix;
      }
      const left = data.elevationMap[sourceY * data.gridWidth + Math.max(0, sourceX - 1)] ?? elevation;
      const right = data.elevationMap[sourceY * data.gridWidth + Math.min(data.gridWidth - 1, sourceX + 1)] ?? elevation;
      const up = data.elevationMap[Math.max(0, sourceY - 1) * data.gridWidth + sourceX] ?? elevation;
      const down = data.elevationMap[Math.min(data.gridHeight - 1, sourceY + 1) * data.gridWidth + sourceX] ?? elevation;
      const shade = Math.max(-0.16, Math.min(0.16, (left - right + up - down) / 8500));
      const output = (y * width + x) * 4;
      pixels[output] = clampByte(r * (1 + shade));
      pixels[output + 1] = clampByte(g * (1 + shade));
      pixels[output + 2] = clampByte(b * (1 + shade));
      pixels[output + 3] = 255;
    }
  }
  return { width, height, pixels };
}
