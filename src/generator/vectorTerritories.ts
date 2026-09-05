import { pointInPolygon, type GeneratedMapData, type Point, type TerritoryPart } from "../model/world";
import { createGridTransform } from "./gridTransform";
import { surfaceVectorDimensions, vectorMaskPaths } from "./surfaceVectors";

export type VectorTerritorySite = {
  owner: number;
  point: Point;
};

export type VectorTerritoryRegion = {
  owner: number;
  polygon: Point[];
  holes: Point[][];
  center: Point;
  coastal: boolean;
};

const EPSILON = 1e-7;

function signedArea(points: Point[]): number {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    area += current.x * next.y - next.x * current.y;
  }
  return area / 2;
}

function normalizeRing(points: Point[]): Point[] {
  const ring: Point[] = [];
  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    const previous = ring[ring.length - 1];
    if (!previous || Math.hypot(point.x - previous.x, point.y - previous.y) > EPSILON)
      ring.push({ ...point });
  }
  if (ring.length > 1 && Math.hypot(ring[0].x - ring[ring.length - 1].x, ring[0].y - ring[ring.length - 1].y) <= EPSILON)
    ring.pop();
  return ring;
}

function interiorProbe(points: Point[]): Point {
  const orientation = signedArea(points) >= 0 ? 1 : -1;
  const scale = Math.max(1, ...points.map((point) => Math.max(Math.abs(point.x), Math.abs(point.y))));
  for (let index = 0; index < points.length; index += 1) {
    const start = points[index];
    const end = points[(index + 1) % points.length];
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.hypot(dx, dy);
    if (length <= EPSILON) continue;
    const probe = {
      x: (start.x + end.x) / 2 - orientation * dy / length * scale * 1e-6,
      y: (start.y + end.y) / 2 + orientation * dx / length * scale * 1e-6,
    };
    if (pointInPolygon(probe, points)) return probe;
  }
  return points[0] ?? { x: 0, y: 0 };
}

function ringContainsPoint(ring: Point[], point: Point): boolean {
  return ring.length >= 3 && pointInPolygon(point, ring);
}

function regionTouchesSaltwater(data: GeneratedMapData, polygon: Point[]): boolean {
  const transform = createGridTransform(data.worldWidth, data.worldHeight, data.gridWidth, data.gridHeight);
  for (const point of polygon) {
    const cell = transform.worldToCell(point);
    for (let oy = -1; oy <= 1; oy += 1) {
      for (let ox = -1; ox <= 1; ox += 1) {
        const x = cell.x + ox;
        const y = cell.y + oy;
        if (x < 0 || y < 0 || x >= data.gridWidth || y >= data.gridHeight) continue;
        if (data.waterTypeMap[y * data.gridWidth + x] === "saltwater") return true;
      }
    }
  }
  return false;
}

/**
 * Vectorizes the morphology result. Water cells can carry transient expansion
 * waves, but ownerMap must contain -1 for every water cell.
 */
export function buildVectorTerritoryRegions(
  data: GeneratedMapData,
  ownerMap: Int16Array,
  sites: VectorTerritorySite[],
  excludedPolygons: Point[][] = [],
  ownerWidth = data.gridWidth,
  ownerHeight = data.gridHeight,
): VectorTerritoryRegion[] {
  const dimensions = surfaceVectorDimensions(data.gridWidth, data.gridHeight, data.settings, "final");
  const transform = createGridTransform(data.worldWidth, data.worldHeight, dimensions.width, dimensions.height);
  const regions: VectorTerritoryRegion[] = [];
  for (const site of sites) {
    const mask = new Uint8Array(dimensions.width * dimensions.height);
    for (let y = 0; y < dimensions.height; y += 1) {
      const dataY = Math.max(0, Math.min(data.gridHeight - 1, Math.floor((y + 0.5) / dimensions.height * data.gridHeight)));
      const ownerY = Math.max(0, Math.min(ownerHeight - 1, Math.floor((y + 0.5) / dimensions.height * ownerHeight)));
      for (let x = 0; x < dimensions.width; x += 1) {
        const dataX = Math.max(0, Math.min(data.gridWidth - 1, Math.floor((x + 0.5) / dimensions.width * data.gridWidth)));
        const ownerX = Math.max(0, Math.min(ownerWidth - 1, Math.floor((x + 0.5) / dimensions.width * ownerWidth)));
        const targetIndex = y * dimensions.width + x;
        if (ownerMap[ownerY * ownerWidth + ownerX] !== site.owner || data.waterTypeMap[dataY * data.gridWidth + dataX] !== "land") continue;
        const point = transform.cellCenterToWorld(x, y);
        if (excludedPolygons.some((polygon) => ringContainsPoint(polygon, point))) continue;
        mask[targetIndex] = 1;
      }
    }
    const rings = vectorMaskPaths(
      mask,
      dimensions.width,
      dimensions.height,
      data.worldWidth,
      data.worldHeight,
      data.settings,
    ).map(normalizeRing).filter((ring) => ring.length >= 3 && Math.abs(signedArea(ring)) > EPSILON);
    const metadata = rings.map((ring) => ({
      ring,
      area: Math.abs(signedArea(ring)),
      probe: interiorProbe(ring),
      depth: 0,
    }));
    for (const entry of metadata) entry.depth = metadata.reduce((depth, candidate) =>
      candidate !== entry && candidate.area > entry.area && ringContainsPoint(candidate.ring, entry.probe)
        ? depth + 1
        : depth, 0);

    const outers = metadata.filter((entry) => entry.depth % 2 === 0);
    for (const outer of outers) {
      const holes = metadata.filter((entry) =>
        entry.depth === outer.depth + 1 && ringContainsPoint(outer.ring, entry.probe),
      ).map((entry) => entry.ring);
      const siteInside = ringContainsPoint(outer.ring, site.point)
        && !holes.some((hole) => ringContainsPoint(hole, site.point));
      regions.push({
        owner: site.owner,
        polygon: outer.ring,
        holes,
        center: siteInside ? { ...site.point } : outer.probe,
        coastal: regionTouchesSaltwater(data, outer.ring),
      });
    }
  }
  return regions;
}

function territoryPartsFromMask(
  data: GeneratedMapData,
  mask: Uint8Array,
  width: number,
  height: number,
): TerritoryPart[] {
  const rings = vectorMaskPaths(
    mask,
    width,
    height,
    data.worldWidth,
    data.worldHeight,
    data.settings,
  ).map(normalizeRing).filter((ring) => ring.length >= 3 && Math.abs(signedArea(ring)) > EPSILON);
  const metadata = rings.map((ring) => ({
    ring,
    area: Math.abs(signedArea(ring)),
    probe: interiorProbe(ring),
    depth: 0,
  }));
  for (const entry of metadata) entry.depth = metadata.reduce((depth, candidate) =>
    candidate !== entry && candidate.area > entry.area && ringContainsPoint(candidate.ring, entry.probe)
      ? depth + 1
      : depth, 0);
  return metadata
    .filter((entry) => entry.depth % 2 === 0)
    .map((outer) => ({
      polygon: outer.ring,
      holes: metadata.filter((entry) =>
        entry.depth === outer.depth + 1 && ringContainsPoint(outer.ring, entry.probe),
      ).map((entry) => entry.ring),
    }))
    .sort((a, b) => Math.abs(signedArea(b.polygon)) - Math.abs(signedArea(a.polygon)));
}

/** Clips arbitrary or legacy political geometry to the canonical land grid. */
export function clipTerritoryPartsToLand(
  data: GeneratedMapData,
  polygon: Point[],
  holes: Point[][] = [],
): TerritoryPart[] {
  if (polygon.length < 3) return [];
  const dimensions = surfaceVectorDimensions(data.gridWidth, data.gridHeight, data.settings, "final");
  const transform = createGridTransform(data.worldWidth, data.worldHeight, dimensions.width, dimensions.height);
  const mask = new Uint8Array(dimensions.width * dimensions.height);
  for (let y = 0; y < dimensions.height; y += 1) {
    const sourceY = Math.max(0, Math.min(data.gridHeight - 1, Math.floor((y + 0.5) / dimensions.height * data.gridHeight)));
    for (let x = 0; x < dimensions.width; x += 1) {
      const sourceX = Math.max(0, Math.min(data.gridWidth - 1, Math.floor((x + 0.5) / dimensions.width * data.gridWidth)));
      if (data.waterTypeMap[sourceY * data.gridWidth + sourceX] !== "land") continue;
      const point = transform.cellCenterToWorld(x, y);
      if (!pointInPolygon(point, polygon) || holes.some((hole) => pointInPolygon(point, hole))) continue;
      mask[y * dimensions.width + x] = 1;
    }
  }
  return territoryPartsFromMask(data, mask, dimensions.width, dimensions.height);
}

export function paintTerritoryPartsOnLand(
  data: GeneratedMapData,
  existingParts: TerritoryPart[],
  brushPolygon: Point[],
  operation: "union" | "subtract",
): TerritoryPart[] {
  if (brushPolygon.length < 3) return existingParts;
  const dimensions = surfaceVectorDimensions(data.gridWidth, data.gridHeight, data.settings, "final");
  const transform = createGridTransform(data.worldWidth, data.worldHeight, dimensions.width, dimensions.height);
  const mask = new Uint8Array(dimensions.width * dimensions.height);
  for (let y = 0; y < dimensions.height; y += 1) {
    const sourceY = Math.max(0, Math.min(data.gridHeight - 1, Math.floor((y + 0.5) / dimensions.height * data.gridHeight)));
    for (let x = 0; x < dimensions.width; x += 1) {
      const sourceX = Math.max(0, Math.min(data.gridWidth - 1, Math.floor((x + 0.5) / dimensions.width * data.gridWidth)));
      if (data.waterTypeMap[sourceY * data.gridWidth + sourceX] !== "land") continue;
      const point = transform.cellCenterToWorld(x, y);
      const owned = existingParts.some((part) =>
        pointInPolygon(point, part.polygon) && !(part.holes ?? []).some((hole) => pointInPolygon(point, hole)),
      );
      const brushed = pointInPolygon(point, brushPolygon);
      if (operation === "union" ? owned || brushed : owned && !brushed)
        mask[y * dimensions.width + x] = 1;
    }
  }
  return territoryPartsFromMask(data, mask, dimensions.width, dimensions.height);
}
