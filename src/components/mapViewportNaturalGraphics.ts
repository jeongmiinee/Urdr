import { Container, Graphics } from "pixi.js";
import { stitchSegments } from "../generator/pathSmoothing";
import { surfaceBoundaryPaths } from "../generator/surfaceVectors";
import {
  isYearInRange,
  type GeneratedMapData,
  type LayerVisibility,
  type MapData,
  type Point,
} from "../model/world";
import { MAP_SCALE } from "./mapViewportRenderConfig";

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
): void {
  const source = displayPath(points);
  if (source.length < 2) return;
  const graphics = new Graphics();
  graphics.eventMode = "none";
  graphics.moveTo(source[0].x * MAP_SCALE, source[0].y * MAP_SCALE);
  for (const point of source.slice(1))
    graphics.lineTo(point.x * MAP_SCALE, point.y * MAP_SCALE);
  graphics.stroke({ color, width, alpha });
  container.addChild(graphics);
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
      strokePath(container, path, 0xf1f5f9, 1.65 * widthScale, 0.92);
  }

  if (generated && layers.rivers) {
    for (const river of [...generated.rivers].sort((a, b) => a.width - b.width))
      strokePath(
        container,
        [river.start, river.end],
        0x4c9fdb,
        Math.max(0.75, river.width) * widthScale,
        0.84,
      );
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

  if (layers.rivers) {
    for (const river of map.rivers.filter((item) =>
      isYearInRange(item, map.timeline.currentYear),
    ))
      strokePath(
        container,
        river.nodes,
        0x4f9fe0,
        Math.max(2, river.width) * widthScale,
        0.95,
      );
  }

  return container;
}
