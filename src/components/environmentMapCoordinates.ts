import type { Point } from "../model/world";

type ContainedCanvasPointOptions = {
  pointerX: number;
  pointerY: number;
  contentWidth: number;
  contentHeight: number;
  intrinsicWidth: number;
  intrinsicHeight: number;
  mapWidth: number;
  mapHeight: number;
};

/**
 * Converts a pointer position inside a canvas content box into world-map coordinates.
 *
 * The environment preview uses `object-fit: contain`. When its CSS height is capped,
 * the bitmap can be letterboxed inside the canvas element. Pointer coordinates must
 * therefore be measured against the rendered bitmap, not the full element box.
 */
export function containedCanvasPointToMap({
  pointerX,
  pointerY,
  contentWidth,
  contentHeight,
  intrinsicWidth,
  intrinsicHeight,
  mapWidth,
  mapHeight,
}: ContainedCanvasPointOptions): Point {
  const safeIntrinsicWidth = Math.max(1, intrinsicWidth);
  const safeIntrinsicHeight = Math.max(1, intrinsicHeight);
  const safeContentWidth = Math.max(1, contentWidth);
  const safeContentHeight = Math.max(1, contentHeight);

  const containScale = Math.min(
    safeContentWidth / safeIntrinsicWidth,
    safeContentHeight / safeIntrinsicHeight,
  );
  const renderedWidth = safeIntrinsicWidth * containScale;
  const renderedHeight = safeIntrinsicHeight * containScale;
  const renderedLeft = (safeContentWidth - renderedWidth) / 2;
  const renderedTop = (safeContentHeight - renderedHeight) / 2;

  const normalizedX = Math.max(0, Math.min(1, (pointerX - renderedLeft) / Math.max(1, renderedWidth)));
  const normalizedY = Math.max(0, Math.min(1, (pointerY - renderedTop) / Math.max(1, renderedHeight)));

  return {
    x: normalizedX * Math.max(0, mapWidth),
    y: normalizedY * Math.max(0, mapHeight),
  };
}

export function clientPointToEnvironmentMap(
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number,
  mapWidth: number,
  mapHeight: number,
): Point {
  const rect = canvas.getBoundingClientRect();
  const cssScaleX = canvas.offsetWidth > 0 ? rect.width / canvas.offsetWidth : 1;
  const cssScaleY = canvas.offsetHeight > 0 ? rect.height / canvas.offsetHeight : 1;

  const contentLeft = canvas.clientLeft * cssScaleX;
  const contentTop = canvas.clientTop * cssScaleY;
  const contentWidth = Math.max(1, canvas.clientWidth * cssScaleX);
  const contentHeight = Math.max(1, canvas.clientHeight * cssScaleY);

  return containedCanvasPointToMap({
    pointerX: clientX - rect.left - contentLeft,
    pointerY: clientY - rect.top - contentTop,
    contentWidth,
    contentHeight,
    intrinsicWidth: canvas.width,
    intrinsicHeight: canvas.height,
    mapWidth,
    mapHeight,
  });
}
