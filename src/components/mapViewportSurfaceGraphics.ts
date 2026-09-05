import { Container, Graphics } from "pixi.js";
import {
  GENERATED_SURFACE_COLORS,
  GENERATED_SURFACE_DRAW_ORDER,
} from "../generator/renderGenerated";
import {
  pointInPolygon,
  type GeneratedMapData,
  type GeneratedSurface,
  type Point,
} from "../model/world";
import { classifyPolygonRings } from "./mapViewportGeometry";
import { canonicalLandPaths, isSafeSurfacePolygon, normalizeSurfaceRing } from "../generator/surfaceVectors";

function scaledPoints(points: Point[], scale: number): number[] {
  return points.flatMap((point) => [point.x * scale, point.y * scale]);
}

function packedColor([red, green, blue]: [number, number, number]): number {
  return (red << 16) | (green << 8) | blue;
}

/**
 * Keeps generated terrain boundaries as GPU vector geometry so zooming never
 * magnifies a pre-rendered bitmap edge.
 */
export function createGeneratedSurfaceGraphics(
  data: GeneratedMapData,
  coordinateScale: number,
  options: {
    opacity?: number;
    surfaces?: GeneratedSurface[];
    colorOverrides?: Partial<Record<GeneratedSurface, [number, number, number]>>;
  } = {},
): Container {
  const opacity = options.opacity ?? 1;
  const visibleSurfaces = options.surfaces
    ? new Set<GeneratedSurface>(options.surfaces)
    : null;
  const container = new Container();
  container.eventMode = "none";
  if (!visibleSurfaces) {
    const background = new Graphics()
      .rect(
        0,
        0,
        data.worldWidth * coordinateScale,
        data.worldHeight * coordinateScale,
      )
      .fill(packedColor(GENERATED_SURFACE_COLORS.plain));
    background.eventMode = "none";
    container.addChild(background);
  }
  const grouped = new Map(
    (data.surfaceRegions ?? []).map((region) => [region.surface, region.polygons]),
  );

  for (const surface of GENERATED_SURFACE_DRAW_ORDER) {
    if (visibleSurfaces && !visibleSurfaces.has(surface)) continue;
    const polygons = grouped.get(surface)
      ?.map((polygon) => normalizeSurfaceRing(polygon))
      .filter((polygon) => isSafeSurfacePolygon(data, polygon));
    if (!polygons?.length) continue;
    const rings = classifyPolygonRings(polygons);
    const graphics = new Graphics();
    graphics.eventMode = "none";
    graphics.alpha = opacity;

    for (const outer of rings
      .filter((ring) => ring.depth % 2 === 0)
      .sort((a, b) => a.depth - b.depth)) {
      graphics
        .poly(scaledPoints(outer.points, coordinateScale))
        .fill(
          packedColor(
            options.colorOverrides?.[surface] ?? GENERATED_SURFACE_COLORS[surface],
          ),
        );
      for (const hole of rings) {
        if (
          hole.depth === outer.depth + 1 &&
          pointInPolygon(hole.probe, outer.points)
        ) {
          graphics.poly(scaledPoints(hole.points, coordinateScale)).cut();
        }
      }
    }
    container.addChild(graphics);
  }

  return container;
}

/** A topology-identical GPU mask used to keep political fills off all water. */
export function createGeneratedLandMaskGraphics(data: GeneratedMapData, coordinateScale: number): Graphics {
  const graphics = new Graphics();
  graphics.eventMode = "none";
  const rings = classifyPolygonRings(canonicalLandPaths(data));
  for (const outer of rings.filter((ring) => ring.depth % 2 === 0)) {
    graphics.poly(scaledPoints(outer.points, coordinateScale)).fill(0xffffff);
    for (const hole of rings) {
      if (hole.depth === outer.depth + 1 && pointInPolygon(hole.probe, outer.points))
        graphics.poly(scaledPoints(hole.points, coordinateScale)).cut();
    }
  }
  return graphics;
}
