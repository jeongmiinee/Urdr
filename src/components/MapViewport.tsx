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
  createGeneratedMapCanvas,
  createWaterOnlyCanvas,
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

const MAP_SCALE = 8;
function textResolution(): number {
  return Math.max(2, Math.min(4, (window.devicePixelRatio || 1) * 2));
}
function cappedLocalScale(viewScale: number): number {
  return 1 / Math.max(1, viewScale);
}
type BitmapScalingMode = "auto" | "1" | "2" | "4";
function readBitmapScalingMode(): BitmapScalingMode {
  const value = localStorage.getItem("world-archive-bitmap-scaling");
  return value === "1" || value === "2" || value === "4" ? value : "auto";
}
function bitmapScaleFactor(mode: BitmapScalingMode, map: MapData): number {
  if (mode !== "auto") return Number(mode);
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const basePixels = map.width * MAP_SCALE * map.height * MAP_SCALE;
  // 자동 모드는 안정성을 위해 보통 2×를 사용하고, 아주 작은 지도와 고밀도 화면에서만 4×를 허용한다.
  if (dpr >= 3 && basePixels <= 600_000) return 4;
  if (dpr >= 1.35 || basePixels <= 1_600_000) return 2;
  return 1;
}
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
  rock: 0x6c757d,
  bedrock: 0x4b4e52,
};

type Rect = { x: number; y: number; width: number; height: number };

function polygonArea(points: Point[]): number {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index];
    const b = points[(index + 1) % points.length];
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area) / 2;
}

function rectOverlap(a: Rect, b: Rect): number {
  const width = Math.max(
    0,
    Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
  );
  const height = Math.max(
    0,
    Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
  );
  return width * height;
}

function boxAt(center: Point, width: number, height: number): Rect {
  return {
    x: center.x * MAP_SCALE - width / 2,
    y: center.y * MAP_SCALE - height / 2,
    width,
    height,
  };
}

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


function orderedGeneratedContourPaths(segments: GeneratedMapData["contours"]): Point[][] {
  const groups = new Map<string, GeneratedMapData["contours"]>();
  for (const segment of segments) {
    const key = `${segment.elevation}:${segment.curveId ?? "legacy"}`;
    const list = groups.get(key) ?? [];
    list.push(segment);
    groups.set(key, list);
  }
  return [...groups.values()].flatMap((group) => {
    if (group.every((segment) => segment.curveId !== undefined)) {
      const ordered = [...group].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
      return ordered.length ? [[ordered[0].start, ...ordered.map((segment) => segment.end)]] : [];
    }
    return group.map((segment) => [segment.start, segment.end]);
  });
}

function drawCanvasSegments(
  context: CanvasRenderingContext2D,
  segments: Array<{ start: Point; end: Point }>,
  strokeStyle: string,
  lineWidth: number,
): void {
  if (segments.length === 0) return;
  context.beginPath();
  for (const segment of segments) {
    context.moveTo(segment.start.x * MAP_SCALE, segment.start.y * MAP_SCALE);
    context.lineTo(segment.end.x * MAP_SCALE, segment.end.y * MAP_SCALE);
  }
  context.strokeStyle = strokeStyle;
  context.lineWidth = lineWidth;
  context.stroke();
}

function displayPath(points: Point[], maximumPoints = 1800): Point[] {
  if (points.length <= maximumPoints) return points;
  const step = Math.max(1, Math.ceil(points.length / maximumPoints));
  const sampled = points.filter((_point, index) => index % step === 0);
  const last = points[points.length - 1];
  if (sampled[sampled.length - 1] !== last) sampled.push(last);
  return sampled;
}

function drawCanvasPath(
  context: CanvasRenderingContext2D,
  points: Point[],
  strokeStyle: string,
  lineWidth: number,
  alpha = 1,
): void {
  const source = displayPath(points);
  if (source.length < 2) return;
  context.save();
  context.globalAlpha = alpha;
  context.beginPath();
  context.moveTo(source[0].x * MAP_SCALE, source[0].y * MAP_SCALE);
  for (const point of source.slice(1))
    context.lineTo(point.x * MAP_SCALE, point.y * MAP_SCALE);
  context.strokeStyle = strokeStyle;
  context.lineWidth = lineWidth;
  context.stroke();
  context.restore();
}

function createNaturalFeatureCanvas(
  map: MapData,
  generated: GeneratedMapData | null,
  layers: LayerVisibility,
  bitmapScale: number,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(map.width * MAP_SCALE * bitmapScale));
  canvas.height = Math.max(1, Math.round(map.height * MAP_SCALE * bitmapScale));
  const context = canvas.getContext("2d");
  if (!context) return canvas;
  context.scale(bitmapScale, bitmapScale);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.lineCap = "round";
  context.lineJoin = "round";

  if (generated && layers.contours) {
    for (const major of [false, true]) {
      const paths = orderedGeneratedContourPaths(generated.contours.filter((line) => line.isMajor === major));
      for (const path of paths)
        drawCanvasPath(
          context,
          path,
          major ? "rgba(55,41,30,.70)" : "rgba(73,59,48,.38)",
          major ? 1.2 : 0.55,
        );
    }
  }
  if (generated && layers.coastline)
    drawCanvasSegments(
      context,
      generated.coastline,
      "rgba(241,245,249,.92)",
      1.65,
    );
  if (generated && layers.rivers) {
    for (const river of [...generated.rivers].sort((a, b) => a.width - b.width))
      drawCanvasSegments(
        context,
        [river],
        "rgba(76,159,219,.84)",
        Math.max(0.75, river.width),
      );
  }
  if (layers.contours)
    for (const contour of map.contourLines)
      drawCanvasPath(
        context,
        contour.points,
        "#4c4038",
        contour.isMajor ? 2 : 1,
        0.75,
      );
  if (layers.rivers)
    for (const river of map.rivers.filter((item) =>
      isYearInRange(item, map.timeline.currentYear),
    ))
      drawCanvasPath(
        context,
        river.nodes,
        "#4f9fe0",
        Math.max(2, river.width),
        0.95,
      );
  return canvas;
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
  onCursorMove?: (point: Point | null) => void;
  draftPoints?: Point[];
  draftTool?: EditorTool;
  brushRadius?: number;
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
  onCursorMove,
  draftPoints = [],
  draftTool = "select",
  brushRadius = 1,
  environmentOpacity = 0.58,
  onViewScaleChange,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const appRef = useRef<Application | null>(null);
  const worldRef = useRef<Container | null>(null);
  const brushGraphicRef = useRef<Graphics | null>(null);
  const clickRef = useRef(onMapClick);
  const moveRef = useRef(onCursorMove);
  const toolRef = useRef(activeTool);
  const scaleRef = useRef(onViewScaleChange);
  const zoomCommitTimerRef = useRef<number | null>(null);
  const [rendererReady, setRendererReady] = useState(false);
  const [rendererError, setRendererError] = useState("");
  const [bitmapScalingMode, setBitmapScalingMode] = useState<BitmapScalingMode>(
    () => readBitmapScalingMode(),
  );
  const [viewScale, setViewScale] = useState(1);
  const bitmapScale = bitmapScaleFactor(bitmapScalingMode, map);
  clickRef.current = onMapClick;
  moveRef.current = onCursorMove;
  toolRef.current = activeTool;
  scaleRef.current = onViewScaleChange;

  useEffect(() => {
    const updateBitmapScaling = (event?: Event) => {
      const detail = (event as CustomEvent<string> | undefined)?.detail;
      const value =
        detail ??
        localStorage.getItem("world-archive-bitmap-scaling") ??
        "auto";
      setBitmapScalingMode(
        value === "1" || value === "2" || value === "4" ? value : "auto",
      );
    };
    window.addEventListener(
      "world-archive:bitmap-scaling",
      updateBitmapScaling,
    );
    window.addEventListener("storage", updateBitmapScaling);
    return () => {
      window.removeEventListener(
        "world-archive:bitmap-scaling",
        updateBitmapScaling,
      );
      window.removeEventListener("storage", updateBitmapScaling);
    };
  }, []);

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
      const mapPoint = (event: PointerEvent | WheelEvent): Point => {
        const rect = app.canvas.getBoundingClientRect();
        const cssScaleX =
          rect.width /
          Math.max(1, app.renderer.width / app.renderer.resolution);
        const cssScaleY =
          rect.height /
          Math.max(1, app.renderer.height / app.renderer.resolution);
        return {
          x:
            ((event.clientX - rect.left) / Math.max(1e-6, cssScaleX) -
              world.x) /
            world.scale.x /
            MAP_SCALE,
          y:
            ((event.clientY - rect.top) / Math.max(1e-6, cssScaleY) - world.y) /
            world.scale.y /
            MAP_SCALE,
        };
      };
      const insideMap = (point: Point) =>
        point.x >= 0 &&
        point.y >= 0 &&
        point.x <= map.width &&
        point.y <= map.height;
      const isBrush = () =>
        ["terrain", "elevation", "territory"].includes(toolRef.current);
      const paint = (point: Point) => {
        if (!insideMap(point)) return;
        if (
          lastPaint &&
          Math.hypot(lastPaint.x - point.x, lastPaint.y - point.y) < 0.45
        )
          return;
        lastPaint = point;
        clickRef.current(point);
      };
      const pointerDown = (event: PointerEvent) => {
        const point = mapPoint(event);
        if (!insideMap(point)) return;
        pointerActive = true;
        moved = false;
        startX = event.clientX;
        startY = event.clientY;
        originX = world.x;
        originY = world.y;
        painting = isBrush();
        lastPaint = null;
        app.canvas.setPointerCapture(event.pointerId);
        if (painting) paint(point);
      };
      const pointerMove = (event: PointerEvent) => {
        const point = mapPoint(event);
        const inside = insideMap(point);
        moveRef.current?.(inside ? point : null);
        const brush = brushGraphicRef.current;
        if (brush) {
          brush.visible = inside && isBrush();
          if (brush.visible)
            brush.position.set(point.x * MAP_SCALE, point.y * MAP_SCALE);
        }
        if (!pointerActive) return;
        if (painting) {
          paint(point);
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
        if (!painting && !moved && insideMap(point)) clickRef.current(point);
        painting = false;
        lastPaint = null;
      };
      const pointerLeave = () => {
        moveRef.current?.(null);
        if (brushGraphicRef.current) brushGraphicRef.current.visible = false;
      };
      const wheel = (event: WheelEvent) => {
        event.preventDefault();
        const rect = app.canvas.getBoundingClientRect();
        const cssScaleX =
          rect.width /
          Math.max(1, app.renderer.width / app.renderer.resolution);
        const cssScaleY =
          rect.height /
          Math.max(1, app.renderer.height / app.renderer.resolution);
        const mouseX = (event.clientX - rect.left) / Math.max(1e-6, cssScaleX);
        const mouseY = (event.clientY - rect.top) / Math.max(1e-6, cssScaleY);
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
    };
  }, [map.id, map.width, map.height]);

  useEffect(() => {
    const world = worldRef.current;
    if (!world) return;
    brushGraphicRef.current = null;
    const removed = world.removeChildren();
    for (const child of removed) {
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
      const targetWidth = map.width * MAP_SCALE * bitmapScale;
      const targetHeight = map.height * MAP_SCALE * bitmapScale;
      const texture = Texture.from(
        layers.terrain
          ? createGeneratedMapCanvas(generated, Math.max(targetWidth, targetHeight), targetWidth, targetHeight)
          : createWaterOnlyCanvas(generated, targetWidth, targetHeight),
      );
      const sprite = new Sprite(texture);
      sprite.width = map.width * MAP_SCALE;
      sprite.height = map.height * MAP_SCALE;
      world.addChild(sprite);
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
            map.width * MAP_SCALE * bitmapScale,
            map.height * MAP_SCALE * bitmapScale,
            map.timeline,
            worldYearLengthDays(project),
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
            const yearLength = worldYearLengthDays(project);
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
              color: TERRAIN_COLORS[state.terrainType] ?? 0x777777,
              alpha: 0.9,
            })
            .stroke({ color: 0x0f172a, width: 1.2, alpha: 0.55 }),
        );
      }
    if (layers.contours || layers.coastline || layers.rivers) {
      const naturalTexture = Texture.from(
        createNaturalFeatureCanvas(map, generated, layers, bitmapScale),
      );
      const naturalSprite = new Sprite(naturalTexture);
      naturalSprite.width = map.width * MAP_SCALE;
      naturalSprite.height = map.height * MAP_SCALE;
      world.addChild(naturalSprite);
    }
    const territoryRows = visibleTerritories(map);
    if (layers.territories)
      for (const { state } of territoryRows) {
        const faction = map.factions.find(
          (item) => item.id === state.ownerFactionId,
        );
        const color = faction?.color ?? "#94a3b8";
        if (state.polygon.length >= 3) {
          const territoryGraphic = new Graphics()
            .poly(scaledPoints(state.polygon))
            .fill({ color, alpha: environmentOpacity });
          for (const hole of state.holes ?? [])
            if (hole.length >= 3)
              territoryGraphic.poly(scaledPoints(hole)).cut();
          territoryGraphic
            .poly(scaledPoints(state.polygon))
            .stroke({ color: darkenColor(color), width: 1.15, alpha: 0.9 });
          for (const hole of state.holes ?? [])
            if (hole.length >= 3)
              territoryGraphic
                .poly(scaledPoints(hole))
                .stroke({ color: darkenColor(color), width: 0.9, alpha: 0.75 });
          world.addChild(territoryGraphic);
        }
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
      for (const { state } of territoryRows)
        if (state.ownerFactionId && state.polygon.length >= 3) {
          const previous = byOwner.get(state.ownerFactionId);
          if (!previous || polygonArea(state.polygon) > polygonArea(previous))
            byOwner.set(state.ownerFactionId, state.polygon);
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
    project,
    map.id,
    map.width,
    map.height,
    map.timeline.currentYear,
    map.timeline.currentDayOfYear,
    map.generatedStates,
    map.terrains,
    map.territories,
    map.rivers,
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
    bitmapScale,
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
