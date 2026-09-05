import { Container, Graphics } from "pixi.js";
import { stitchSegments } from "../generator/pathSmoothing";
import { surfaceBoundaryPaths } from "../generator/surfaceVectors";
import {
  type GeneratedMapData,
  type LayerVisibility,
  type MapData,
  type Point,
} from "../model/world";
import { MAP_SCALE } from "./mapViewportRenderConfig";
import { riverHalfWidthInWorldPixels } from "../hydrology/riverDisplay";

function displayPath(points: Point[], maximumPoints = 1800): Point[] {
  if (points.length <= maximumPoints) return points;
  const step = Math.max(1, Math.ceil(points.length / maximumPoints));
  const sampled = points.filter((_point, index) => index % step === 0);
  const last = points[points.length - 1];
  if (sampled[sampled.length - 1] !== last) sampled.push(last);
  return sampled;
}

function strokePath(
  container: Container,
  points: Point[],
  color: number,
  width: number,
  alpha: number,
  maximumPoints = 1800,
): void {
  const source = displayPath(points, maximumPoints);
  if (source.length < 2) return;
  const graphics = new Graphics();
  graphics.eventMode = "none";
  graphics.moveTo(source[0].x * MAP_SCALE, source[0].y * MAP_SCALE);
  for (const point of source.slice(1))
    graphics.lineTo(point.x * MAP_SCALE, point.y * MAP_SCALE);
  graphics.stroke({ color, width, alpha, cap: "round", join: "round" });
  container.addChild(graphics);
}

function riverRibbon(
  data: GeneratedMapData,
  points: Point[],
  widthMeters: number[],
  viewScale: number,
): Graphics | null {
  const source = displayPath(points);
  if (source.length < 2) return null;
  const metersToMapPixels =
    data.worldWidth * MAP_SCALE / Math.max(1, data.settings.mapScaleKm * 1_000);
  const left: Point[] = [];
  const right: Point[] = [];
  for (let index = 0; index < source.length; index += 1) {
    const previous = source[Math.max(0, index - 1)];
    const next = source[Math.min(source.length - 1, index + 1)];
    const dx = next.x - previous.x;
    const dy = next.y - previous.y;
    const length = Math.max(1e-9, Math.hypot(dx, dy));
    const sourceIndex = Math.min(
      widthMeters.length - 1,
      Math.round(index / Math.max(1, source.length - 1) * Math.max(0, widthMeters.length - 1)),
    );
    const halfWidth = riverHalfWidthInWorldPixels(
      widthMeters[sourceIndex] ?? widthMeters[0] ?? 2.5,
      metersToMapPixels,
      viewScale,
    );
    const nx = -dy / length * halfWidth;
    const ny = dx / length * halfWidth;
    left.push({ x: source[index].x * MAP_SCALE + nx, y: source[index].y * MAP_SCALE + ny });
    right.push({ x: source[index].x * MAP_SCALE - nx, y: source[index].y * MAP_SCALE - ny });
  }
  const polygon = [...left, ...right.reverse()];
  const graphics = new Graphics();
  graphics.eventMode = "none";
  graphics.poly(polygon.flatMap((point) => [point.x, point.y])).fill({ color: 0x4c9fdb, alpha: 0.9 });
  const startRadius = Math.hypot(left[0].x - right[right.length - 1].x, left[0].y - right[right.length - 1].y) * 0.5;
  const endRadius = Math.hypot(left[left.length - 1].x - right[0].x, left[left.length - 1].y - right[0].y) * 0.5;
  graphics.circle(source[0].x * MAP_SCALE, source[0].y * MAP_SCALE, startRadius).fill({ color: 0x4c9fdb, alpha: 0.9 });
  graphics.circle(source[source.length - 1].x * MAP_SCALE, source[source.length - 1].y * MAP_SCALE, endRadius).fill({ color: 0x4c9fdb, alpha: 0.9 });
  return graphics;
}

function orderedContourPaths(
  segments: GeneratedMapData["contours"],
): Point[][] {
  const groups = new Map<string, GeneratedMapData["contours"]>();
  for (const segment of segments) {
    const key = `${segment.elevation}:${segment.curveId ?? "legacy"}`;
    const list = groups.get(key) ?? [];
    list.push(segment);
    groups.set(key, list);
  }
  return [...groups.values()].flatMap((group) => {
    if (group.every((segment) => segment.curveId !== undefined)) {
      const ordered = [...group].sort(
        (a, b) => (a.sequence ?? 0) - (b.sequence ?? 0),
      );
      return ordered.length
        ? [[ordered[0].start, ...ordered.map((segment) => segment.end)]]
        : [];
    }
    return group.map((segment) => [segment.start, segment.end]);
  });
}

function coastlinePaths(data: GeneratedMapData): Point[][] {
  const canonicalPaths = surfaceBoundaryPaths(
    data.surfaceRegions,
    "saltwater",
    data.worldWidth,
    data.worldHeight,
    true,
  );
  if (canonicalPaths.length > 0) return canonicalPaths;
  const tolerance =
    Math.max(
      data.worldWidth / Math.max(1, data.gridWidth),
      data.worldHeight / Math.max(1, data.gridHeight),
    ) * 1e-5;
  return stitchSegments(data.coastline, tolerance);
}

/** Draws categorical natural features as zoom-independent GPU vectors. */
export function createNaturalFeatureGraphics(
  map: MapData,
  generated: GeneratedMapData | null,
  layers: LayerVisibility,
  viewScale: number,
): Container {
  const container = new Container();
  container.eventMode = "none";
  const widthScale = 1 / Math.max(1, viewScale);

  if (generated && layers.contours) {
    for (const major of [false, true]) {
      const paths = orderedContourPaths(
        generated.contours.filter((line) => line.isMajor === major),
      );
      for (const path of paths)
        strokePath(
          container,
          path,
          major ? 0x37291e : 0x493b30,
          (major ? 1.2 : 0.55) * widthScale,
          major ? 0.7 : 0.38,
        );
    }
  }

  if (generated && layers.coastline) {
    for (const path of coastlinePaths(generated))
      strokePath(container, path, 0xf1f5f9, 1.65 * widthScale, 0.92, Number.POSITIVE_INFINITY);
  }

  if (generated && layers.rivers) {
    const graphEdges = generated.riverGraph?.edges.filter((edge) => edge.render) ?? [];
    for (const edge of [...graphEdges].sort((a, b) => a.order - b.order || a.id - b.id)) {
      const ribbon = riverRibbon(generated, edge.centerline, edge.widthMeters, viewScale);
      if (ribbon) container.addChild(ribbon);
    }
  }

  if (layers.contours) {
    for (const contour of map.contourLines)
      strokePath(
        container,
        contour.points,
        0x4c4038,
        (contour.isMajor ? 2 : 1) * widthScale,
        0.75,
      );
  }

  return container;
}
