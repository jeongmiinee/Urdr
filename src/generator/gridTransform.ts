import type { Point } from "../model/world";

export const POWER_OF_TWO_SIZES = [64, 128, 256, 512, 1024, 2048] as const;
export type PowerOfTwoSize = (typeof POWER_OF_TWO_SIZES)[number];

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export function nearestPowerOfTwo(value: number, min: PowerOfTwoSize = 64, max: PowerOfTwoSize = 2048): PowerOfTwoSize {
  const allowed = POWER_OF_TWO_SIZES.filter((size) => size >= min && size <= max);
  return allowed.reduce((best, size) => Math.abs(size - value) < Math.abs(best - value) ? size : best, allowed[0]);
}

export function normalizePowerOfTwo(value: number, fallback: PowerOfTwoSize = 1024): PowerOfTwoSize {
  return nearestPowerOfTwo(Number.isFinite(value) ? value : fallback);
}

export type GridTransform = {
  worldWidth: number;
  worldHeight: number;
  gridWidth: number;
  gridHeight: number;
  cellSizeX: number;
  cellSizeY: number;
  worldToCell: (point: Point) => { x: number; y: number; index: number };
  cellCenterToWorld: (x: number, y: number) => Point;
  cellBoundaryToWorld: (x: number, y: number) => Point;
  worldRadiusToCellRadius: (radiusWorld: number) => { x: number; y: number };
  normalizedToWorld: (point: Point) => Point;
  worldToNormalized: (point: Point) => Point;
};

/**
 * 월드 좌표, 분석 셀, 경계 정점의 변환을 한곳에서 관리한다.
 * 래스터 값은 셀 중심에 놓이며 셀 경계는 0..gridWidth / 0..gridHeight 정점으로 정의된다.
 */
export function createGridTransform(
  worldWidth: number,
  worldHeight: number,
  gridWidth: number,
  gridHeight: number,
): GridTransform {
  const safeWorldWidth = Math.max(1e-9, worldWidth);
  const safeWorldHeight = Math.max(1e-9, worldHeight);
  const safeGridWidth = Math.max(1, Math.round(gridWidth));
  const safeGridHeight = Math.max(1, Math.round(gridHeight));
  const cellSizeX = safeWorldWidth / safeGridWidth;
  const cellSizeY = safeWorldHeight / safeGridHeight;

  return {
    worldWidth: safeWorldWidth,
    worldHeight: safeWorldHeight,
    gridWidth: safeGridWidth,
    gridHeight: safeGridHeight,
    cellSizeX,
    cellSizeY,
    worldToCell(point) {
      const x = clamp(Math.floor(point.x / cellSizeX), 0, safeGridWidth - 1);
      const y = clamp(Math.floor(point.y / cellSizeY), 0, safeGridHeight - 1);
      return { x, y, index: y * safeGridWidth + x };
    },
    cellCenterToWorld(x, y) {
      return {
        x: (clamp(x, 0, safeGridWidth - 1) + 0.5) * cellSizeX,
        y: (clamp(y, 0, safeGridHeight - 1) + 0.5) * cellSizeY,
      };
    },
    cellBoundaryToWorld(x, y) {
      return {
        x: clamp(x, 0, safeGridWidth) * cellSizeX,
        y: clamp(y, 0, safeGridHeight) * cellSizeY,
      };
    },
    worldRadiusToCellRadius(radiusWorld) {
      return {
        x: Math.max(1, Math.ceil(Math.max(0, radiusWorld) / cellSizeX)),
        y: Math.max(1, Math.ceil(Math.max(0, radiusWorld) / cellSizeY)),
      };
    },
    normalizedToWorld(point) {
      return { x: clamp(point.x, 0, 1) * safeWorldWidth, y: clamp(point.y, 0, 1) * safeWorldHeight };
    },
    worldToNormalized(point) {
      return { x: clamp(point.x / safeWorldWidth, 0, 1), y: clamp(point.y / safeWorldHeight, 0, 1) };
    },
  };
}

/** 셀 중심에 저장된 스칼라장을 Marching Squares용 정점장으로 변환한다. */
export function cellValuesToVertexValues(values: ArrayLike<number>, width: number, height: number): number[] {
  const vertexWidth = width + 1;
  const output = new Array<number>((width + 1) * (height + 1));
  for (let vy = 0; vy <= height; vy += 1) {
    for (let vx = 0; vx <= width; vx += 1) {
      let sum = 0;
      let count = 0;
      for (let oy = -1; oy <= 0; oy += 1) {
        for (let ox = -1; ox <= 0; ox += 1) {
          const cx = vx + ox;
          const cy = vy + oy;
          if (cx < 0 || cy < 0 || cx >= width || cy >= height) continue;
          sum += values[cy * width + cx];
          count += 1;
        }
      }
      const fallbackX = clamp(vx, 0, width - 1);
      const fallbackY = clamp(vy, 0, height - 1);
      output[vy * vertexWidth + vx] = count > 0 ? sum / count : values[fallbackY * width + fallbackX];
    }
  }
  return output;
}

function derivedVertexValue(
  values: ArrayLike<number>,
  width: number,
  height: number,
  vx: number,
  vy: number,
): number {
  let sum = 0;
  let count = 0;
  for (let oy = -1; oy <= 0; oy += 1) {
    for (let ox = -1; ox <= 0; ox += 1) {
      const x = vx + ox;
      const y = vy + oy;
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      sum += values[y * width + x] ?? 0;
      count += 1;
    }
  }
  if (count > 0) return sum / count;
  const x = clamp(vx, 0, Math.max(0, width - 1));
  const y = clamp(vy, 0, Math.max(0, height - 1));
  return values[y * width + x] ?? 0;
}

/** Samples the exact continuous field used by contour marching squares. */
export function sampleCellDerivedFieldAtWorld(
  values: ArrayLike<number>,
  width: number,
  height: number,
  worldWidth: number,
  worldHeight: number,
  point: Point,
): number {
  const gx = clamp(point.x / Math.max(1e-9, worldWidth) * width, 0, width);
  const gy = clamp(point.y / Math.max(1e-9, worldHeight) * height, 0, height);
  const x0 = Math.min(width, Math.floor(gx));
  const y0 = Math.min(height, Math.floor(gy));
  const x1 = Math.min(width, x0 + 1);
  const y1 = Math.min(height, y0 + 1);
  const tx = gx - x0;
  const ty = gy - y0;
  const top = derivedVertexValue(values, width, height, x0, y0) * (1 - tx)
    + derivedVertexValue(values, width, height, x1, y0) * tx;
  const bottom = derivedVertexValue(values, width, height, x0, y1) * (1 - tx)
    + derivedVertexValue(values, width, height, x1, y1) * tx;
  return top * (1 - ty) + bottom * ty;
}
