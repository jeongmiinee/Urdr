import { useEffect, useRef, useState } from "react";
import {
  Application,
  Container,
  Graphics,
  Sprite,
  Text,
  Texture,
} from "pixi.js";
import {
  createEnvironmentMapCanvas,
} from "../generator/renderGenerated";
import { smoothPath } from "../generator/pathSmoothing";
import type {
  EditorTool,
  GeneratedMapData,
  LayerVisibility,
  MapData,
  Point,
  WorldProject,
} from "../model/world";
import {
  currentEvents,
  generatedAtYear,
  isYearInRange,
  pointInPolygon,
  terrainAtYear,
  visibleLocations,
  visibleTerritories,
  worldYearLengthDays,
} from "../model/world";
import { isLandAtPoint } from "../generator/mapPlacement";
import { dynamicWindAt } from "../simulation/locationEnvironment";
import {
  MAP_SCALE,
  cappedLocalScale,
  textResolution,
} from "./mapViewportRenderConfig";
import { boxAt, polygonArea, rectOverlap, type Rect } from "./mapViewportGeometry";
import { createNaturalFeatureGraphics } from "./mapViewportNaturalGraphics";
import { createGeneratedLandMaskGraphics, createGeneratedSurfaceGraphics } from "./mapViewportSurfaceGraphics";
import { clientToMapPoint, clientToRendererPoint, type CanvasViewportMetrics } from "./mapPointerCoordinates";

const TERRAIN_COLORS: Record<string, number> = {
  mountain: 0x77645a,
  forest: 0x2d6a4f,
  desert: 0xd4a72c,
  snow: 0xe9f1f7,
  grassland: 0x7cb342,
  plain: 0xa7c957,
  farmland: 0xb4a652,
  jungle: 0x1b5e20,
  wetland: 0x49695b,
  rock: 0x846f5c,
  bedrock: 0x605044,
};

function darkenColor(color: string, factor = 0.58): number {
  const value = Number.parseInt(color.replace("#", ""), 16);
  if (!Number.isFinite(value)) return 0x4b5563;
  const red = Math.round(((value >> 16) & 255) * factor);
  const green = Math.round(((value >> 8) & 255) * factor);
  const blue = Math.round((value & 255) * factor);
  return (red << 16) | (green << 8) | blue;
}

function visualPolygonCandidates(points: Point[]): Point[] {
  if (points.length === 0) return [{ x: 0, y: 0 }];
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const centroid = {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
  };
  const candidates: Point[] = [];
  if (pointInPolygon(centroid, points)) candidates.push(centroid);
  for (let gy = 1; gy < 10; gy += 1)
    for (let gx = 1; gx < 10; gx += 1) {
      const candidate = {
        x: minX + ((maxX - minX) * gx) / 10,
        y: minY + ((maxY - minY) * gy) / 10,
      };
      if (pointInPolygon(candidate, points)) candidates.push(candidate);
    }
  return candidates.length > 0 ? candidates : [points[0]];
}

function chooseCountryLabelPosition(
  points: Point[],
  name: string,
  occupied: Rect[],
): { point: Point; fontSize: number } {
  const candidates = visualPolygonCandidates(points);
  const area = polygonArea(points);
  const baseSize = Math.max(12, Math.min(20, 12 + Math.sqrt(area) * 0.11));
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const polygonCenter = {
    x: (Math.min(...xs) + Math.max(...xs)) / 2,
    y: (Math.min(...ys) + Math.max(...ys)) / 2,
  };
  for (const scale of [1, 0.88, 0.76]) {
    const fontSize = baseSize * scale;
    const width = Math.max(58, name.length * fontSize * 0.76 + 16);
    const height = fontSize * 1.55;
    let best: { point: Point; score: number } | null = null;
    for (const candidate of candidates) {
      const rect = boxAt(candidate, width, height);
      const overlap = occupied.reduce(
        (sum, other) => sum + rectOverlap(rect, other),
        0,
      );
      const edgeClearance = Math.min(
        ...points.map((point) =>
          Math.hypot(candidate.x - point.x, candidate.y - point.y),
        ),
      );
      const centerPenalty = Math.hypot(
        candidate.x - polygonCenter.x,
        candidate.y - polygonCenter.y,
      );
      const score = overlap * 20_000 + centerPenalty * 2 - edgeClearance * 4;
      if (!best || score < best.score) best = { point: candidate, score };
    }
    if (best && best.score < 1_000) return { point: best.point, fontSize };
    if (best && scale === 0.76) return { point: best.point, fontSize };
  }
  return { point: candidates[0], fontSize: baseSize * 0.76 };
}

function placeNameBounds(place: MapData["placeNames"][number]): Rect {
  const points =
    place.path && place.path.length >= 2 ? place.path : [place.position];
  if (points.length === 1 || place.placementMode !== "path")
    return boxAt(place.position, Math.max(42, place.name.length * 15), 24);
  const minX = Math.min(...points.map((point) => point.x)) * MAP_SCALE;
  const maxX = Math.max(...points.map((point) => point.x)) * MAP_SCALE;
  const minY = Math.min(...points.map((point) => point.y)) * MAP_SCALE;
  const maxY = Math.max(...points.map((point) => point.y)) * MAP_SCALE;
  return {
    x: minX - 10,
    y: minY - 13,
    width: Math.max(42, maxX - minX + 20),
    height: Math.max(26, maxY - minY + 26),
  };
}

function drawPathLabel(
  place: MapData["placeNames"][number],
  selected: boolean,
  viewScale: number,
): Container {
  const container = new Container();
  const cap = cappedLocalScale(viewScale);
  const original =
    place.path && place.path.length >= 2 ? place.path : [place.position];
  const points =
    original.length >= 3 && place.curve !== false
      ? smoothPath(original, { samplesPerSegment: 5, iterations: 1 })
      : original;
  if (points.length < 2 || place.placementMode !== "path") {
    const label = new Text({
      text: place.name,
      resolution: textResolution(),
      style: selected
        ? {
            fill: "#facc15",
            fontSize: 17,
            fontStyle: "italic",
            letterSpacing: 1,
            stroke: { color: "#111827", width: 3 },
          }
        : {
            fill: "#dbeafe",
            fontSize: 15,
            fontStyle: "italic",
            letterSpacing: 1,
            stroke: { color: "#111827", width: 2 },
          },
    });
    label.anchor.set(0.5);
    label.position.set(
      place.position.x * MAP_SCALE,
      place.position.y * MAP_SCALE,
    );
    label.scale.set(cap);
    container.addChild(label);
    return container;
  }
  const lengths: number[] = [0];
  for (let index = 1; index < points.length; index += 1)
    lengths.push(
      lengths[index - 1] +
        Math.hypot(
          points[index].x - points[index - 1].x,
          points[index].y - points[index - 1].y,
        ),
    );
  const total = lengths[lengths.length - 1];
  const spacing = Math.max(1.2, place.letterSpacing ?? 2.1);
  const needed = Math.max(0, (place.name.length - 1) * spacing);
  const startDistance = Math.max(0, (total - needed) / 2);
  const pointAt = (distance: number) => {
    const d = Math.max(0, Math.min(total, distance));
    let segment = 0;
    while (segment < lengths.length - 2 && lengths[segment + 1] < d)
      segment += 1;
    const a = points[segment];
    const b = points[segment + 1];
    const segmentLength = Math.max(
      1e-6,
      lengths[segment + 1] - lengths[segment],
    );
    const t = (d - lengths[segment]) / segmentLength;
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    const offset = place.pathOffset ?? 0;
    return {
      x: a.x + (b.x - a.x) * t - Math.sin(angle) * offset,
      y: a.y + (b.y - a.y) * t + Math.cos(angle) * offset,
      angle,
    };
  };
  for (let index = 0; index < place.name.length; index += 1) {
    const sample = pointAt(startDistance + index * spacing);
    let angle = sample.angle;
    if (Math.cos(angle) < 0) angle += Math.PI;
    const character = new Text({
      text: place.name[index],
      resolution: textResolution(),
      style: {
        fill: selected ? "#facc15" : "#dbeafe",
        fontSize: selected ? 16 : 14,
        fontStyle: "italic",
        stroke: { color: "#111827", width: selected ? 3 : 2 },
      },
    });
    character.anchor.set(0.5);
    character.position.set(sample.x * MAP_SCALE, sample.y * MAP_SCALE);
    character.rotation = angle;
    character.scale.set(cap);
    container.addChild(character);
  }
  return container;
}

function scaledPoints(points: Point[]): number[] {
  return points.flatMap((point) => [point.x * MAP_SCALE, point.y * MAP_SCALE]);
}
function drawPolyline(
  points: Point[],
  color: number,
  width: number,
  alpha = 1,
  closed = false,
  smooth = false,
): Graphics {
  const source =
    smooth && points.length >= 3
      ? smoothPath(points, { closed, samplesPerSegment: 5, iterations: 1 })
      : points;
  const graphics = new Graphics();
  if (source.length === 0) return graphics;
  graphics.moveTo(source[0].x * MAP_SCALE, source[0].y * MAP_SCALE);
  for (const point of source.slice(1))
    graphics.lineTo(point.x * MAP_SCALE, point.y * MAP_SCALE);
  if (closed) graphics.closePath();
  graphics.stroke({ color, width, alpha });
  return graphics;
}


function displayPath(points: Point[], maximumPoints = 1800): Point[] {
  if (points.length <= maximumPoints) return points;
  const step = Math.max(1, Math.ceil(points.length / maximumPoints));
  const sampled = points.filter((_point, index) => index % step === 0);
  const last = points[points.length - 1];
  if (sampled[sampled.length - 1] !== last) sampled.push(last);
  return sampled;
}

function createRoadGraphics(
  map: MapData,
  generated: GeneratedMapData | null,
  layers: LayerVisibility,
  viewScale: number,
): Container {
  const container = new Container();
  if (!layers.roads) return container;
  const aboveWater = (point: Point) =>
    !generated || isLandAtPoint(generated, point);
  const roadRank: Record<string, number> = {
    trail: 0,
    secondary: 1,
    bridge: 2,
    main: 3,
  };
  const visibleRoads = map.roads
    .filter((item) => isYearInRange(item, map.timeline.currentYear))
    .sort((a, b) => (roadRank[a.roadType] ?? 0) - (roadRank[b.roadType] ?? 0));
  for (const road of visibleRoads) {
    const valid = displayPath(road.nodes.filter(aboveWater));
    if (valid.length < 2) continue;
    const color =
      road.roadType === "main"
        ? "#5b321d"
        : road.roadType === "bridge"
          ? "#68422b"
          : road.roadType === "secondary"
            ? "#79533a"
            : "#a07d63";
    const width =
      road.roadType === "main"
        ? 3.8
        : road.roadType === "bridge"
          ? 2.9
          : road.roadType === "secondary"
            ? 2.45
            : 1.65;
    const alpha =
      road.roadType === "main"
        ? 0.98
        : road.roadType === "bridge"
          ? 0.95
          : road.roadType === "secondary"
            ? 0.88
            : 0.68;
    const graphics = new Graphics();
    graphics.moveTo(valid[0].x * MAP_SCALE, valid[0].y * MAP_SCALE);
    for (const point of valid.slice(1))
      graphics.lineTo(point.x * MAP_SCALE, point.y * MAP_SCALE);
    graphics.stroke({ color, width: width / Math.max(1, viewScale), alpha });
    container.addChild(graphics);
  }
  return container;
}

type Props = {
  project: WorldProject;
  map: MapData;
  layers: LayerVisibility;
  activeTool: EditorTool;
  selectedLocationId: string | null;
  selectedEventId?: string | null;
  selectedPlaceNameId?: string | null;
  onMapClick: (point: Point) => void;
  onBrushStrokeStart?: () => void;
  onBrushStrokeEnd?: () => void;
  onContinuousStroke?: (tool: "road" | "label", points: Point[]) => void;
  onCursorMove?: (point: Point | null) => void;
  draftPoints?: Point[];
  draftTool?: EditorTool;
  brushRadius?: number;
  brushPreviewColor?: number;
  environmentOpacity?: number;
  onViewScaleChange?: (scale: number) => void;
};

export function MapViewport({
  project,
  map,
  layers,
  activeTool,
  selectedLocationId,
  selectedEventId = null,
  selectedPlaceNameId = null,
  onMapClick,
  onBrushStrokeStart,
  onBrushStrokeEnd,
  onContinuousStroke,
  onCursorMove,
  draftPoints = [],
  draftTool = "select",
  brushRadius = 1,
  brushPreviewColor = 0x84cc16,
  environmentOpacity = 0.58,
  onViewScaleChange,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const appRef = useRef<Application | null>(null);
  const worldRef = useRef<Container | null>(null);
  const brushGraphicRef = useRef<Graphics | null>(null);
  const brushStrokeGraphicRef = useRef<Graphics | null>(null);
  const surfaceCacheRef = useRef<{
    source: GeneratedMapData;
    terrainVisible: boolean;
    lightTheme: boolean;
    container: Container;
  } | null>(null);
  const brushRadiusRef = useRef(brushRadius);
  const brushPreviewColorRef = useRef(brushPreviewColor);
  const clickRef = useRef(onMapClick);
  const brushStartRef = useRef(onBrushStrokeStart);
  const brushEndRef = useRef(onBrushStrokeEnd);
  const continuousStrokeRef = useRef(onContinuousStroke);
  const moveRef = useRef(onCursorMove);
  const toolRef = useRef(activeTool);
  const scaleRef = useRef(onViewScaleChange);
  const zoomCommitTimerRef = useRef<number | null>(null);
  const [rendererReady, setRendererReady] = useState(false);
  const [rendererError, setRendererError] = useState("");
  const [viewScale, setViewScale] = useState(1);
  const environmentRasterScale = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  const yearLengthDays = worldYearLengthDays(project);
  clickRef.current = onMapClick;
  brushStartRef.current = onBrushStrokeStart;
  brushEndRef.current = onBrushStrokeEnd;
  continuousStrokeRef.current = onContinuousStroke;
  moveRef.current = onCursorMove;
  toolRef.current = activeTool;
  brushRadiusRef.current = brushRadius;
  brushPreviewColorRef.current = brushPreviewColor;
  scaleRef.current = onViewScaleChange;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let frame = 0;
    const app = new Application();

    const initialize = async () => {
      for (let attempt = 0; attempt < 24 && !disposed; attempt += 1) {
        if (host.clientWidth >= 8 && host.clientHeight >= 8) break;
        await new Promise<void>((resolve) => {
          frame = window.requestAnimationFrame(() => resolve());
        });
      }
      if (disposed) return;
      const width = Math.max(8, host.clientWidth);
      const height = Math.max(8, host.clientHeight);
      await app.init({
        width,
        height,
        preference: "webgl",
        preferWebGLVersion: 2,
        backgroundAlpha: 0,
        antialias: true,
        autoDensity: true,
        resolution: Math.min(window.devicePixelRatio || 1, 4),
      });
      if (disposed) {
        app.destroy(true);
        return;
      }

      host.appendChild(app.canvas);
      app.canvas.className = "pixi-canvas";
      const world = new Container();
      app.stage.addChild(world);

      const fitWorld = () => {
        const viewportWidth = Math.max(8, host.clientWidth);
        const viewportHeight = Math.max(8, host.clientHeight);
        app.renderer.resize(viewportWidth, viewportHeight);
        const padding = 36;
        const scale = Math.max(
          0.25,
          Math.min(
            1.35,
            Math.min(
              (viewportWidth - padding * 2) /
                Math.max(1, map.width * MAP_SCALE),
              (viewportHeight - padding * 2) /
                Math.max(1, map.height * MAP_SCALE),
            ),
          ),
        );
        world.scale.set(scale);
        world.position.set(
          Math.max(12, (viewportWidth - map.width * MAP_SCALE * scale) / 2),
          Math.max(12, (viewportHeight - map.height * MAP_SCALE * scale) / 2),
        );
        setViewScale(scale);
        scaleRef.current?.(scale);
      };
      fitWorld();
      const resizeObserver = new ResizeObserver(fitWorld);
      resizeObserver.observe(host);

      appRef.current = app;
      worldRef.current = world;
      setRendererError("");
      setRendererReady(true);

      let pointerActive = false;
      let painting = false;
      let moved = false;
      let startX = 0;
      let startY = 0;
      let originX = 0;
      let originY = 0;
      let lastPaint: Point | null = null;
      let pendingPaint: Point[] = [];
      let continuousStrokePoints: Point[] = [];
      let continuousStrokeTool: "road" | "label" | null = null;
      let paintFrame = 0;
      const viewportMetrics = (): CanvasViewportMetrics => {
        const rect = app.canvas.getBoundingClientRect();
        return {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
          logicalWidth: app.renderer.width / app.renderer.resolution,
          logicalHeight: app.renderer.height / app.renderer.resolution,
        };
      };
      const mapPoint = (event: PointerEvent | WheelEvent): Point | null =>
        clientToMapPoint(
          { x: event.clientX, y: event.clientY },
          viewportMetrics(),
          {
            x: world.x,
            y: world.y,
            scaleX: world.scale.x,
            scaleY: world.scale.y,
            mapScale: MAP_SCALE,
            mapWidth: map.width,
            mapHeight: map.height,
          },
        );
      const isBrush = () =>
        ["terrain", "elevation", "territory"].includes(toolRef.current);
      const isContinuousStroke = () => toolRef.current === "road" || toolRef.current === "label";
      const paint = (point: Point) => {
        const distance = lastPaint ? Math.hypot(lastPaint.x - point.x, lastPaint.y - point.y) : 0;
        const minimumWorldDistance = 1.5 / Math.max(0.1, world.scale.x * MAP_SCALE);
        if (lastPaint && distance < minimumWorldDistance) return;
        const graphics = brushStrokeGraphicRef.current;
        const color = continuousStrokeTool ? 0x8bd3f7 : toolRef.current === "elevation" ? 0xf59e0b : brushPreviewColorRef.current;
        if (graphics) {
          if (lastPaint) {
            graphics
              .moveTo(lastPaint.x * MAP_SCALE, lastPaint.y * MAP_SCALE)
              .lineTo(point.x * MAP_SCALE, point.y * MAP_SCALE)
              .stroke({ color, width: continuousStrokeTool ? 1.2 * MAP_SCALE : brushRadiusRef.current * MAP_SCALE * 2, alpha: continuousStrokeTool ? 0.9 : 0.2, cap: "round", join: "round" });
          } else {
            graphics
              .circle(point.x * MAP_SCALE, point.y * MAP_SCALE, continuousStrokeTool ? 0.8 * MAP_SCALE : brushRadiusRef.current * MAP_SCALE)
              .fill({ color, alpha: 0.2 });
          }
        }
        if (continuousStrokeTool) continuousStrokePoints.push(point);
        else clickRef.current(point);
        lastPaint = point;
      };
      const schedulePaint = (points: Point[]) => {
        pendingPaint.push(...points);
        if (paintFrame) return;
        paintFrame = window.requestAnimationFrame(() => {
          paintFrame = 0;
          const batch = pendingPaint;
          pendingPaint = [];
          if (pointerActive && painting) for (const point of batch) paint(point);
        });
      };
      const pointerDown = (event: PointerEvent) => {
        const point = mapPoint(event);
        if (!point) return;
        pointerActive = true;
        moved = false;
        startX = event.clientX;
        startY = event.clientY;
        originX = world.x;
        originY = world.y;
        painting = isBrush() || isContinuousStroke();
        continuousStrokeTool = isContinuousStroke() ? toolRef.current as "road" | "label" : null;
        continuousStrokePoints = [];
        lastPaint = null;
        brushStrokeGraphicRef.current?.clear();
        app.canvas.setPointerCapture(event.pointerId);
        if (painting) {
          if (!continuousStrokeTool) brushStartRef.current?.();
          paint(point);
        }
      };
      const pointerMove = (event: PointerEvent) => {
        const point = mapPoint(event);
        const inside = point !== null;
        moveRef.current?.(point);
        const brush = brushGraphicRef.current;
        if (brush) {
          brush.visible = inside && isBrush();
          if (brush.visible && point)
            brush.position.set(point.x * MAP_SCALE, point.y * MAP_SCALE);
        }
        if (!pointerActive) return;
        if (painting) {
          const coalesced = event.getCoalescedEvents?.() ?? [];
          const points = (coalesced.length ? coalesced.map(mapPoint) : [point]).filter((candidate): candidate is Point => candidate !== null);
          schedulePaint(points);
          return;
        }
        const dx =
          (event.clientX - startX) /
          Math.max(
            1e-6,
            app.canvas.getBoundingClientRect().width /
              Math.max(1, app.renderer.width / app.renderer.resolution),
          );
        const dy =
          (event.clientY - startY) /
          Math.max(
            1e-6,
            app.canvas.getBoundingClientRect().height /
              Math.max(1, app.renderer.height / app.renderer.resolution),
          );
        if (Math.hypot(dx, dy) > 4) moved = true;
        world.position.set(originX + dx, originY + dy);
      };
      const pointerUp = (event: PointerEvent) => {
        if (!pointerActive) return;
        pointerActive = false;
        const point = mapPoint(event);
        if (paintFrame) {
          window.cancelAnimationFrame(paintFrame);
          paintFrame = 0;
        }
        if (painting) {
          for (const pending of pendingPaint) paint(pending);
          if (point) paint(point);
        }
        pendingPaint = [];
        if (!painting && !moved && point) clickRef.current(point);
        if (painting) {
          if (continuousStrokeTool && continuousStrokePoints.length >= 2)
            continuousStrokeRef.current?.(continuousStrokeTool, continuousStrokePoints);
          else if (!continuousStrokeTool) brushEndRef.current?.();
        }
        painting = false;
        continuousStrokeTool = null;
        continuousStrokePoints = [];
        lastPaint = null;
      };
      const pointerLeave = () => {
        moveRef.current?.(null);
        if (brushGraphicRef.current) brushGraphicRef.current.visible = false;
      };
      const wheel = (event: WheelEvent) => {
        event.preventDefault();
        event.stopPropagation();
        const rendererPoint = clientToRendererPoint({ x: event.clientX, y: event.clientY }, viewportMetrics());
        if (!rendererPoint) return;
        const mouseX = rendererPoint.x;
        const mouseY = rendererPoint.y;
        const oldScale = world.scale.x;
        const nextScale = Math.min(
          5,
          Math.max(0.2, oldScale * (event.deltaY < 0 ? 1.12 : 0.89)),
        );
        const mapX = (mouseX - world.x) / oldScale;
        const mapY = (mouseY - world.y) / oldScale;
        world.scale.set(nextScale);
        world.position.set(
          mouseX - mapX * nextScale,
          mouseY - mapY * nextScale,
        );
        if (zoomCommitTimerRef.current !== null) window.clearTimeout(zoomCommitTimerRef.current);
        zoomCommitTimerRef.current = window.setTimeout(() => {
          const bucketed = Math.round(nextScale * 8) / 8;
          setViewScale(bucketed);
          scaleRef.current?.(nextScale);
          zoomCommitTimerRef.current = null;
        }, 140);
      };
      app.canvas.addEventListener("pointerdown", pointerDown);
      app.canvas.addEventListener("pointermove", pointerMove);
      app.canvas.addEventListener("pointerup", pointerUp);
      app.canvas.addEventListener("pointercancel", pointerUp);
      app.canvas.addEventListener("pointerleave", pointerLeave);
      app.canvas.addEventListener("wheel", wheel, { passive: false });
      (app as Application & { __cleanup?: () => void }).__cleanup = () => {
        resizeObserver.disconnect();
        app.canvas.removeEventListener("pointerdown", pointerDown);
        app.canvas.removeEventListener("pointermove", pointerMove);
        app.canvas.removeEventListener("pointerup", pointerUp);
        app.canvas.removeEventListener("pointercancel", pointerUp);
        app.canvas.removeEventListener("pointerleave", pointerLeave);
        app.canvas.removeEventListener("wheel", wheel);
        if (paintFrame) window.cancelAnimationFrame(paintFrame);
        if (zoomCommitTimerRef.current !== null) { window.clearTimeout(zoomCommitTimerRef.current); zoomCommitTimerRef.current = null; }
      };
    };

    void initialize().catch((error) => {
      console.error("Map renderer initialization failed", error);
      moveRef.current?.(null);
      setRendererError(
        error instanceof Error
          ? error.message
          : "지도 렌더러를 초기화하지 못했습니다.",
      );
      setRendererReady(false);
    });
    return () => {
      disposed = true;
      if (frame) window.cancelAnimationFrame(frame);
      const current = appRef.current as
        (Application & { __cleanup?: () => void }) | null;
      current?.__cleanup?.();
      if (current) current.destroy(true);
      appRef.current = null;
      worldRef.current = null;
      surfaceCacheRef.current = null;
    };
  }, [map.id, map.width, map.height]);

  useEffect(() => {
    const world = worldRef.current;
    if (!world) return;
    brushGraphicRef.current = null;
    brushStrokeGraphicRef.current = null;
    const removed = world.removeChildren();
    const preservedSurface = surfaceCacheRef.current?.container ?? null;
    for (const child of removed) {
      if (child === preservedSurface) continue;
      if (child instanceof Sprite) child.texture.destroy(true);
      child.destroy({ children: true });
    }
    const lightTheme = document.documentElement.dataset.theme === "light";
    world.addChild(
      new Graphics()
        .rect(0, 0, map.width * MAP_SCALE, map.height * MAP_SCALE)
        .fill(layers.terrain ? (lightTheme ? 0xdfe8ed : 0x142033) : 0xffffff)
        .stroke({ color: lightTheme ? 0x607b8d : 0x64748b, width: 2 }),
    );
    const generated = generatedAtYear(map);
    if (generated) {
      const cached = surfaceCacheRef.current;
      const matches = cached
        && cached.source === generated
        && cached.terrainVisible === layers.terrain
        && cached.lightTheme === lightTheme;
      if (!matches) {
        cached?.container.destroy({ children: true });
        const container = layers.terrain
          ? createGeneratedSurfaceGraphics(generated, MAP_SCALE)
          : createGeneratedSurfaceGraphics(generated, MAP_SCALE, {
              surfaces: ["saltwater", "freshwater"],
              colorOverrides: { saltwater: [176, 211, 229], freshwater: [185, 220, 232] },
            });
        surfaceCacheRef.current = { source: generated, terrainVisible: layers.terrain, lightTheme, container };
      }
      world.addChild(surfaceCacheRef.current!.container);
    } else if (surfaceCacheRef.current) {
      surfaceCacheRef.current.container.destroy({ children: true });
      surfaceCacheRef.current = null;
    }
    if (generated) {
      const environmentKinds: Array<
        [
          boolean,
          (
            | "temperature"
            | "precipitation"
            | "snowfall"
            | "evapotranspiration"
            | "soilMoisture"
            | "windSpeed"
            | "humidity"
            | "solarHours"
            | "solarIrradiance"
          ),
        ]
      > = [
        [layers.temperature, "temperature"],
        [layers.precipitation, "precipitation"],
        [layers.snowfall, "snowfall"],
        [layers.evapotranspiration, "evapotranspiration"],
        [layers.soilMoisture, "soilMoisture"],
        [layers.windSpeed, "windSpeed"],
        [layers.humidity, "humidity"],
        [layers.solarHours, "solarHours"],
        [layers.solarIrradiance, "solarIrradiance"],
      ];
      for (const [visible, kind] of environmentKinds) {
        if (!visible) continue;
        const texture = Texture.from(
          createEnvironmentMapCanvas(
            generated,
            kind,
            map.width * MAP_SCALE * environmentRasterScale,
            map.height * MAP_SCALE * environmentRasterScale,
            map.timeline,
            yearLengthDays,
          ),
        );
        const sprite = new Sprite(texture);
        sprite.width = map.width * MAP_SCALE;
        sprite.height = map.height * MAP_SCALE;
        sprite.alpha = environmentOpacity;
        world.addChild(sprite);
      }
      if (layers.windDirection) {
        const arrows = new Graphics();
        const stepX = Math.max(5, Math.round(generated.gridWidth / 22));
        const stepY = Math.max(5, Math.round(generated.gridHeight / 14));
        for (
          let gy = Math.floor(stepY / 2);
          gy < generated.gridHeight;
          gy += stepY
        )
          for (
            let gx = Math.floor(stepX / 2);
            gx < generated.gridWidth;
            gx += stepX
          ) {
            const px = ((gx + 0.5) / generated.gridWidth) * map.width;
            const py = ((gy + 0.5) / generated.gridHeight) * map.height;
            const yearLength = yearLengthDays;
            const month = Math.max(
              1,
              Math.min(
                12,
                Math.floor(
                  (map.timeline.currentDayOfYear / Math.max(1, yearLength)) *
                    12,
                ) + 1,
              ),
            );
            const wind = dynamicWindAt(
              generated,
              { x: px, y: py },
              map.timeline.currentYear,
              month,
            );
            const speed = wind.speedMs;
            if (speed < 0.05) continue;
            const radians = (wind.directionDeg * Math.PI) / 180;
            const ux = Math.cos(radians);
            const uy = Math.sin(radians);
            const cx = px * MAP_SCALE;
            const cy = py * MAP_SCALE;
            const length = 8 + Math.min(18, speed * 1.8);
            const ex = cx + ux * length;
            const ey = cy + uy * length;
            arrows
              .moveTo(cx - ux * length * 0.35, cy - uy * length * 0.35)
              .lineTo(ex, ey);
            arrows
              .moveTo(ex, ey)
              .lineTo(ex - ux * 5 - uy * 3.2, ey - uy * 5 + ux * 3.2);
            arrows
              .moveTo(ex, ey)
              .lineTo(ex - ux * 5 + uy * 3.2, ey - uy * 5 - ux * 3.2);
          }
        arrows.stroke({
          color: 0xffffff,
          width: 1.25,
          alpha: Math.min(0.95, environmentOpacity + 0.25),
        });
        world.addChild(arrows);
      }
    }
    if (layers.terrain)
      for (const terrain of map.terrains) {
        const state = terrainAtYear(terrain, map.timeline.currentYear);
        world.addChild(
          new Graphics()
            .poly(scaledPoints(terrain.points))
            .fill({
              color: TERRAIN_COLORS[state.terrainType] ?? TERRAIN_COLORS.plain,
              alpha: 0.9,
            })
            .stroke({ color: 0x0f172a, width: 1.2, alpha: 0.55 }),
        );
      }
    if (layers.contours || layers.rivers) {
      world.addChild(
        createNaturalFeatureGraphics(map, generated, { ...layers, coastline: false }, viewScale),
      );
    }
    const territoryRows = visibleTerritories(map);
    const territoryLayer = new Container();
    territoryLayer.eventMode = "none";
    if (layers.territories)
      for (const { state } of territoryRows) {
        const faction = map.factions.find(
          (item) => item.id === state.ownerFactionId,
        );
        const color = faction?.color ?? "#94a3b8";
        const parts = state.parts?.length ? state.parts : [{ polygon: state.polygon, holes: state.holes }];
        for (const part of parts) if (part.polygon.length >= 3) {
          const territoryGraphic = new Graphics()
            .poly(scaledPoints(part.polygon))
            .fill({ color, alpha: environmentOpacity });
          for (const hole of part.holes ?? [])
            if (hole.length >= 3)
              territoryGraphic.poly(scaledPoints(hole)).cut();
          territoryGraphic
            .poly(scaledPoints(part.polygon))
            .stroke({ color: darkenColor(color), width: 1.15 / Math.max(1, viewScale), alpha: 0.9, join: "round" });
          for (const hole of part.holes ?? [])
            if (hole.length >= 3)
              territoryGraphic
                .poly(scaledPoints(hole))
                .stroke({ color: darkenColor(color), width: 0.9 / Math.max(1, viewScale), alpha: 0.75, join: "round" });
          territoryLayer.addChild(territoryGraphic);
        }
      }
    if (layers.territories && territoryLayer.children.length > 0) {
      if (generated) {
        const landMask = createGeneratedLandMaskGraphics(generated, MAP_SCALE);
        world.addChild(landMask);
        territoryLayer.mask = landMask;
      }
      world.addChild(territoryLayer);
    } else territoryLayer.destroy({ children: true });
    if (layers.coastline) {
      world.addChild(
        createNaturalFeatureGraphics(map, generated, { ...layers, contours: false, rivers: false }, viewScale),
      );
    }
    if (layers.roads)
      world.addChild(createRoadGraphics(map, generated, layers, viewScale));

    const occupied: Rect[] = [];
    const labelLayer = new Container();
    if (layers.locations) {
      for (const { location, state } of visibleLocations(map)) {
        const selected = location.id === selectedLocationId;
        const radius = selected ? 8 : 5.5;
        const icon = new Graphics()
          .circle(0, 0, radius)
          .fill(selected ? 0xfacc15 : 0xf8fafc)
          .stroke({
            color: selected ? 0xffffff : 0x172033,
            width: selected ? 2.5 : 1.8,
          });
        icon.position.set(
          state.position.x * MAP_SCALE,
          state.position.y * MAP_SCALE,
        );
        icon.scale.set(cappedLocalScale(viewScale));
        world.addChild(icon);
        occupied.push(boxAt(state.position, radius * 2 + 8, radius * 2 + 8));
        if (layers.labels) {
          const fontSize = selected ? 13 : 11;
          const label = new Text({
            text: state.name,
            resolution: textResolution(),
            style: {
              fill: "#f8fafc",
              fontSize,
              fontWeight: selected ? "700" : "500",
              stroke: { color: "#111827", width: 3 },
            },
          });
          const iconLabelGapPx = 7;
          const labelOffsetWorld = radius * cappedLocalScale(viewScale) + iconLabelGapPx / Math.max(0.001, viewScale);
          label.anchor.set(0, 0.5);
          label.position.set(
            state.position.x * MAP_SCALE + labelOffsetWorld,
            state.position.y * MAP_SCALE,
          );
          label.scale.set(cappedLocalScale(viewScale));
          labelLayer.addChild(label);
          occupied.push({
            x: state.position.x * MAP_SCALE + 5,
            y: state.position.y * MAP_SCALE - 12 - fontSize,
            width: Math.max(34, state.name.length * fontSize * 0.68),
            height: fontSize * 1.5,
          });
        }
      }
    }
    if (layers.events)
      for (const event of currentEvents(map)) {
        if (!event.location) continue;
        const selected = event.id === selectedEventId;
        const y = event.location.y * MAP_SCALE - 16;
        const eventIcon = new Graphics()
          .star(0, 0, 5, selected ? 9 : 7, selected ? 4 : 3)
          .fill(selected ? 0xfacc15 : 0xfb7185)
          .stroke({ color: 0xffffff, width: selected ? 2 : 1.2 });
        eventIcon.position.set(event.location.x * MAP_SCALE, y);
        eventIcon.scale.set(cappedLocalScale(viewScale));
        world.addChild(eventIcon);
        occupied.push({
          x: event.location.x * MAP_SCALE - 10,
          y: y - 10,
          width: 20,
          height: 20,
        });
      }
    if (layers.labels)
      for (const place of map.placeNames.filter((item) =>
        isYearInRange(item, map.timeline.currentYear),
      )) {
        labelLayer.addChild(
          drawPathLabel(place, place.id === selectedPlaceNameId, viewScale),
        );
        occupied.push(placeNameBounds(place));
      }
    if (layers.countryNames) {
      const byOwner = new Map<string, Point[]>();
      for (const { state } of territoryRows) {
        const largestPart = (state.parts?.length ? state.parts : [{ polygon: state.polygon }])
          .filter((part) => part.polygon.length >= 3)
          .sort((a, b) => polygonArea(b.polygon) - polygonArea(a.polygon))[0];
        if (state.ownerFactionId && largestPart) {
          const previous = byOwner.get(state.ownerFactionId);
          if (!previous || polygonArea(largestPart.polygon) > polygonArea(previous))
            byOwner.set(state.ownerFactionId, largestPart.polygon);
        }
      }
      for (const [ownerId, polygon] of byOwner) {
        const faction = map.factions.find((item) => item.id === ownerId);
        if (!faction) continue;
        const placement = chooseCountryLabelPosition(
          polygon,
          faction.name,
          occupied,
        );
        const label = new Text({
          text: faction.name,
          resolution: textResolution(),
          style: {
            fill: "#ffffff",
            fontSize: placement.fontSize,
            fontWeight: "700",
            letterSpacing: 1.5,
            align: "center",
            stroke: { color: "#111827", width: 4 },
            dropShadow: { color: "#000000", alpha: 0.5, blur: 2, distance: 1 },
          },
        });
        label.anchor.set(0.5);
        label.position.set(
          placement.point.x * MAP_SCALE,
          placement.point.y * MAP_SCALE,
        );
        label.scale.set(cappedLocalScale(viewScale));
        labelLayer.addChild(label);
        occupied.push(
          boxAt(
            placement.point,
            Math.max(58, faction.name.length * placement.fontSize * 0.76 + 16),
            placement.fontSize * 1.55,
          ),
        );
      }
    }
    world.addChild(labelLayer);

    const editLayer = new Container();
    if (selectedPlaceNameId) {
      const place = map.placeNames.find(
        (item) => item.id === selectedPlaceNameId,
      );
      if (place?.path?.length) {
        editLayer.addChild(
          drawPolyline(place.path, 0xfacc15, 1.2, 0.65, false, true),
        );
        for (const point of place.path)
          editLayer.addChild(
            new Graphics()
              .circle(point.x * MAP_SCALE, point.y * MAP_SCALE, 3.2)
              .fill(0xfacc15)
              .stroke({ color: 0x111827, width: 1 }),
          );
      }
    }
    if (draftPoints.length > 0) {
      const color = draftTool === "river" ? 0x38bdf8 : 0xf8fafc;
      editLayer.addChild(
        drawPolyline(draftPoints, color, 3, 0.95, false, true),
      );
      for (const point of draftPoints)
        editLayer.addChild(
          new Graphics()
            .circle(point.x * MAP_SCALE, point.y * MAP_SCALE, 4)
            .fill(color)
            .stroke({ color: 0x111827, width: 1 }),
        );
    }
    if (["terrain", "elevation", "territory"].includes(activeTool)) {
      if (activeTool === "terrain" || activeTool === "elevation" || activeTool === "territory") {
        const strokePreview = new Graphics();
        strokePreview.eventMode = "none";
        brushStrokeGraphicRef.current = strokePreview;
        editLayer.addChild(strokePreview);
      }
      const brush = new Graphics()
        .circle(0, 0, brushRadius * MAP_SCALE)
        .fill({ color: 0xffffff, alpha: 0.08 })
        .stroke({ color: 0xfacc15, width: 2.2, alpha: 0.98 });
      brush.visible = false;
      brushGraphicRef.current = brush;
      editLayer.addChild(brush);
    }
    world.addChild(editLayer);
  }, [
    yearLengthDays,
    map.id,
    map.width,
    map.height,
    map.timeline.currentYear,
    map.timeline.currentDayOfYear,
    map.generatedStates,
    map.terrains,
    map.territories,
    map.roads,
    map.locations,
    map.placeNames,
    map.events,
    layers,
    activeTool,
    selectedLocationId,
    selectedEventId,
    selectedPlaceNameId,
    rendererReady,
    draftPoints,
    draftTool,
    brushRadius,
    environmentOpacity,
    environmentRasterScale,
    viewScale,
  ]);

  return (
    <div className="map-viewport-frame">
      <div className="map-viewport" ref={hostRef} />
      {!rendererReady && (
        <div className={`map-render-state ${rendererError ? "error" : ""}`}>
          <strong>
            {rendererError ? "지도 렌더러 오류" : "지도 화면 준비 중"}
          </strong>
          <span>
            {rendererError ||
              "지도 좌표계와 그래픽 레이어를 초기화하고 있습니다."}
          </span>
        </div>
      )}
    </div>
  );
}
