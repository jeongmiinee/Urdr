import type { Point } from "../model/world";

export type CanvasViewportMetrics = {
  left: number;
  top: number;
  width: number;
  height: number;
  logicalWidth: number;
  logicalHeight: number;
};

export type MapViewTransform = {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  mapScale: number;
  mapWidth: number;
  mapHeight: number;
};

export function clientToRendererPoint(
  client: Point,
  viewport: CanvasViewportMetrics,
): Point | null {
  if (viewport.width <= 0 || viewport.height <= 0) return null;
  const x = client.x - viewport.left;
  const y = client.y - viewport.top;
  if (x < 0 || y < 0 || x > viewport.width || y > viewport.height) return null;
  return {
    x: x * viewport.logicalWidth / viewport.width,
    y: y * viewport.logicalHeight / viewport.height,
  };
}

export function clientToMapPoint(
  client: Point,
  viewport: CanvasViewportMetrics,
  transform: MapViewTransform,
): Point | null {
  const renderer = clientToRendererPoint(client, viewport);
  if (!renderer || transform.scaleX === 0 || transform.scaleY === 0 || transform.mapScale === 0) return null;
  const point = {
    x: (renderer.x - transform.x) / transform.scaleX / transform.mapScale,
    y: (renderer.y - transform.y) / transform.scaleY / transform.mapScale,
  };
  if (
    point.x < 0
    || point.y < 0
    || point.x > transform.mapWidth
    || point.y > transform.mapHeight
  ) return null;
  return point;
}
