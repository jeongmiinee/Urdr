import { useEffect, useMemo, useRef, useState } from "react";
import type { EditorTool, LayerVisibility, LocationState, MapData, MapEditorMode, PlaceName, Point, TerrainType, TerritoryState, WorldEvent, WorldProject } from "../model/world";
import { createId, currentEvents, generatedAtYear, getStateAtYear, pointInPolygon, upsertTemporalStateAtYear, visibleLocations, worldYearLengthDays } from "../model/world";
import { alignMapFeaturesToGenerated, enforceTerritoryConstraints, nearestGeneratedPoint, routePathOnLand } from "../generator/mapPlacement";
import { applyElevationBrushStrokeImmediate, applySeaLevel, applyTerrainBrushStrokeImmediate, buildBrushStrokePolygon, createSmoothCurve, resampleBrushStroke, type ElevationBrushMode } from "../generator/mapEditing";
import { paintTerritoryPartsOnLand } from "../generator/vectorTerritories";
import { CURRENT_SURFACE_VECTOR_VERSION, surfaceGeometryFingerprint } from "../generator/surfaceVectors";
import { environmentRange, environmentValueAtTimeline, environmentUnit, type EnvironmentLayerKind } from "../generator/renderGenerated";
import { Inspector } from "./Inspector";
import { useTransientMessage } from "../hooks/useTransientMessage";
import { climateLayerLabel, LayerPanel } from "./LayerPanel";
import { MapViewport } from "./MapViewport";
import { Toolbar } from "./Toolbar";
import { createGridTransform, sampleCellDerivedFieldAtWorld } from "../generator/gridTransform";
import { effectiveTerrainAt } from "../generator/agriculture";
import { normalizeSampledSurfaceElevation } from "../generator/waterElevation";

type Props = { project: WorldProject; map: MapData; onChange: (map: MapData) => void; onOpenGenerator: () => void; onOpenWikiEntity: (entityType: "location" | "event", entityId: string) => void };
const initialLayers: LayerVisibility = { terrain: true, contours: true, coastline: false, territories: false, rivers: true, roads: true, locations: true, labels: true, events: true, windDirection: false, countryNames: true, windSpeed: false, temperature: false, precipitation: false, humidity: false, solarHours: false, solarIrradiance: false, snowfall: false, evapotranspiration: false, soilMoisture: false };
const toolLabels: Record<EditorTool, string> = { select: "선택", terrain: "지형", elevation: "고도", location: "장소", label: "지명", road: "길", river: "강", territory: "영토", event: "사건" };
const TERRAIN_BRUSH_COLORS: Record<TerrainType, number> = {
  mountain: 0x776554, forest: 0x2a6646, desert: 0xd3a84e, snow: 0xe8f0f5,
  grassland: 0x74a148, plain: 0x9db85b, farmland: 0xb0a652, jungle: 0x1c5b30,
  wetland: 0x49695b, rock: 0x84715c, bedrock: 0x605044,
};

function packedHexColor(value: string | undefined, fallback: number): number {
  if (!value || !/^#[0-9a-f]{6}$/i.test(value)) return fallback;
  return Number.parseInt(value.slice(1), 16);
}


function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const cross = (p: Point, q: Point, r: Point) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const abC = cross(a, b, c); const abD = cross(a, b, d); const cdA = cross(c, d, a); const cdB = cross(c, d, b);
  return abC * abD < -1e-7 && cdA * cdB < -1e-7;
}
function polygonsOverlap(a: Point[], b: Point[]): boolean {
  if (a.length < 3 || b.length < 3) return false;
  if (a.some((point) => pointInPolygon(point, b)) || b.some((point) => pointInPolygon(point, a))) return true;
  for (let i = 0; i < a.length; i += 1) for (let j = 0; j < b.length; j += 1) if (segmentsIntersect(a[i], a[(i + 1) % a.length], b[j], b[(j + 1) % b.length])) return true;
  return false;
}

export function MapEditorWindow({ project, map, onChange, onOpenGenerator, onOpenWikiEntity }: Props) {
  const [activeTool, setActiveTool] = useState<EditorTool>(() => { const saved = localStorage.getItem("world-archive-active-tool"); return (["select","terrain","elevation","location","label","road","territory","event"] as EditorTool[]).includes(saved as EditorTool) ? saved as EditorTool : "select"; }); const [layers, setLayers] = useState<LayerVisibility>(initialLayers);
  const [selectedLocationId, setSelectedLocationId] = useState<string | null>(null); const [selectedEventId, setSelectedEventId] = useState<string | null>(null); const [selectedPlaceNameId, setSelectedPlaceNameId] = useState<string | null>(null);
  const [inspectorMode, setInspectorMode] = useState<"view" | "edit">("view");
  const [cursor, setCursor] = useState<Point | null>(null); const [overlay, setOverlay] = useState<"layers" | "info" | null>(null);
  const [environmentOpacity, setEnvironmentOpacity] = useState(() => Number(localStorage.getItem("world-archive-paint-opacity") ?? 0.58)); const [legendCollapsed, setLegendCollapsed] = useState(false);
  const [viewScale, setViewScale] = useState(1);
  const [measurementSystem, setMeasurementSystem] = useState<"metric" | "imperial">(() => localStorage.getItem("world-archive-measurement-system") === "imperial" ? "imperial" : "metric");
  const [selectedTerrain, setSelectedTerrain] = useState<TerrainType>(() => (localStorage.getItem("world-archive-selected-terrain") as TerrainType) || "forest"); const [brushRadius, setBrushRadius] = useState(() => Number(localStorage.getItem("world-archive-brush-radius") ?? 5));
  const [elevationDelta, setElevationDelta] = useState(() => Number(localStorage.getItem("world-archive-elevation-delta") ?? 400));
  const [elevationMode, setElevationMode] = useState<ElevationBrushMode>(() => (localStorage.getItem("world-archive-elevation-mode") as ElevationBrushMode) || "target");
  const [brushStrength, setBrushStrength] = useState(() => Number(localStorage.getItem("world-archive-brush-strength") ?? 0.65));
  const [brushFalloff, setBrushFalloff] = useState(() => Number(localStorage.getItem("world-archive-brush-falloff") ?? 0.65));
  const [terrainNoise, setTerrainNoise] = useState(() => Number(localStorage.getItem("world-archive-terrain-brush-noise") ?? 0.35));
  const [territoryFactionId, setTerritoryFactionId] = useState(map.factions[0]?.id ?? ""); const [drawingPoints, setDrawingPoints] = useState<Point[]>([]); const [curveMode, setCurveMode] = useState(true);
  const [notice, setNotice] = useTransientMessage(generatedAtYear(map) ? "현재 연도에 적용된 절차형 지도가 있습니다." : "빈 지도입니다. 지도 생성기를 열어 지형을 만드세요.");
  const mapRef = useRef(map);
  const pendingGeneratedRef = useRef<NonNullable<ReturnType<typeof generatedAtYear>> | null>(generatedAtYear(map));
  const brushPointsRef = useRef<Point[]>([]);
  const brushModeRef = useRef<"terrain" | "elevation" | "territory">("terrain");
  const brushStrokeActiveRef = useRef(false);
  const brushWorkerRef = useRef<Worker | null>(null);
  const brushWorkerBusyRef = useRef(false);
  const brushRequestRef = useRef(0);
  const rapidActionLockRef = useRef(0);
  const selectionTimerRef = useRef<number | null>(null);
  const undoStackRef = useRef<MapData[]>([]);
  const redoStackRef = useRef<MapData[]>([]);
  const [, setHistoryRevision] = useState(0);
  useEffect(() => { mapRef.current = map; pendingGeneratedRef.current = generatedAtYear(map); }, [map]);
  useEffect(() => { undoStackRef.current = []; redoStackRef.current = []; setHistoryRevision((value) => value + 1); }, [map.id]);
  useEffect(() => () => { brushWorkerRef.current?.terminate(); if (selectionTimerRef.current !== null) window.clearTimeout(selectionTimerRef.current); }, []);
  useEffect(() => { localStorage.setItem("world-archive-paint-opacity", String(environmentOpacity)); }, [environmentOpacity]);
  useEffect(() => { localStorage.setItem("world-archive-active-tool", activeTool); }, [activeTool]);
  useEffect(() => { localStorage.setItem("world-archive-selected-terrain", selectedTerrain); }, [selectedTerrain]);
  useEffect(() => { localStorage.setItem("world-archive-brush-radius", String(brushRadius)); }, [brushRadius]);
  useEffect(() => { localStorage.setItem("world-archive-elevation-delta", String(elevationDelta)); }, [elevationDelta]);
  useEffect(() => { localStorage.setItem("world-archive-elevation-mode", elevationMode); }, [elevationMode]);
  useEffect(() => { localStorage.setItem("world-archive-brush-strength", String(brushStrength)); }, [brushStrength]);
  useEffect(() => { localStorage.setItem("world-archive-brush-falloff", String(brushFalloff)); }, [brushFalloff]);
  useEffect(() => { localStorage.setItem("world-archive-terrain-brush-noise", String(terrainNoise)); }, [terrainNoise]);
  useEffect(() => { setInspectorMode("view"); }, [selectedLocationId, selectedEventId]);
  const commitCivilizationTransaction = (nextMap: MapData) => {
    const current = mapRef.current;
    if (nextMap === current) return;
    undoStackRef.current = [...undoStackRef.current.slice(-24), current];
    redoStackRef.current = [];
    mapRef.current = nextMap;
    onChange(nextMap);
    setHistoryRevision((value) => value + 1);
  };
  const undoCivilizationTransaction = () => {
    const previous = undoStackRef.current.at(-1);
    if (!previous) return;
    undoStackRef.current = undoStackRef.current.slice(0, -1);
    redoStackRef.current = [...redoStackRef.current.slice(-24), mapRef.current];
    brushRequestRef.current += 1;
    brushWorkerRef.current?.terminate();
    brushWorkerRef.current = null;
    brushWorkerBusyRef.current = false;
    mapRef.current = previous;
    pendingGeneratedRef.current = generatedAtYear(previous);
    onChange(previous);
    setHistoryRevision((value) => value + 1);
  };
  const redoCivilizationTransaction = () => {
    const next = redoStackRef.current.at(-1);
    if (!next) return;
    redoStackRef.current = redoStackRef.current.slice(0, -1);
    undoStackRef.current = [...undoStackRef.current.slice(-24), mapRef.current];
    brushRequestRef.current += 1;
    brushWorkerRef.current?.terminate();
    brushWorkerRef.current = null;
    brushWorkerBusyRef.current = false;
    mapRef.current = next;
    pendingGeneratedRef.current = generatedAtYear(next);
    onChange(next);
    setHistoryRevision((value) => value + 1);
  };
  useEffect(() => {
    const handleHistoryShortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      const target = event.target as HTMLElement | null;
      if (target?.isContentEditable || /INPUT|TEXTAREA|SELECT/.test(target?.tagName ?? "")) return;
      if (event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redoCivilizationTransaction(); else undoCivilizationTransaction();
      } else if (event.key.toLowerCase() === "y") {
        event.preventDefault();
        redoCivilizationTransaction();
      }
    };
    window.addEventListener("keydown", handleHistoryShortcut);
    return () => window.removeEventListener("keydown", handleHistoryShortcut);
  });
  useEffect(() => {
    const updateUnits = (event?: Event) => {
      const detail = (event as CustomEvent<string> | undefined)?.detail;
      setMeasurementSystem((detail ?? localStorage.getItem("world-archive-measurement-system")) === "imperial" ? "imperial" : "metric");
    };
    window.addEventListener("world-archive:measurement-system", updateUnits);
    window.addEventListener("storage", updateUnits);
    return () => { window.removeEventListener("world-archive:measurement-system", updateUnits); window.removeEventListener("storage", updateUnits); };
  }, []);
  const editorMode: MapEditorMode = map.editorMode ?? "view";
  const generated = generatedAtYear(map); const displayedDraftPoints = curveMode && (activeTool === "road" || activeTool === "label") && drawingPoints.length >= 3 ? createSmoothCurve(drawingPoints) : drawingPoints;
  const terrainLabels: Record<TerrainType, string> = { mountain: "산지", forest: "숲", desert: "사막", snow: "설원", grassland: "초원", plain: "평원", farmland: "농경지", jungle: "열대림", wetland: "습지", rock: "암석", bedrock: "암반" };
  const cursorEnvironment = useMemo(() => {
    if (!cursor || !generated || generated.gridWidth <= 0 || generated.gridHeight <= 0) return null;
    const cell = createGridTransform(generated.worldWidth, generated.worldHeight, generated.gridWidth, generated.gridHeight).worldToCell(cursor);
    const index = cell.index;
    const windX = generated.windXMap[index] ?? 0;
    const windY = generated.windYMap[index] ?? 0;
    const waterType = generated.waterTypeMap[index] ?? "land";
    const sampledElevation = sampleCellDerivedFieldAtWorld(
      generated.elevationMap,
      generated.gridWidth,
      generated.gridHeight,
      generated.worldWidth,
      generated.worldHeight,
      cursor,
    );
    return {
      index,
      terrain: effectiveTerrainAt(generated, index),
      waterType,
      elevation: normalizeSampledSurfaceElevation(
        sampledElevation,
        waterType,
        generated.seaLevel,
        generated.lakeIdMap[index] ?? -1,
        generated.lakeSurfaceElevations,
      ),
      temperature: environmentValueAtTimeline(generated, "temperature", index, map.timeline, worldYearLengthDays(project)),
      precipitation: environmentValueAtTimeline(generated, "precipitation", index, map.timeline, worldYearLengthDays(project)),
      snowfall: environmentValueAtTimeline(generated, "snowfall", index, map.timeline, worldYearLengthDays(project)),
      evapotranspiration: environmentValueAtTimeline(generated, "evapotranspiration", index, map.timeline, worldYearLengthDays(project)),
      soilMoisture: environmentValueAtTimeline(generated, "soilMoisture", index, map.timeline, worldYearLengthDays(project)),
      humidity: environmentValueAtTimeline(generated, "humidity", index, map.timeline, worldYearLengthDays(project)),
      solarHours: environmentValueAtTimeline(generated, "solarHours", index, map.timeline, worldYearLengthDays(project)),
      solarIrradiance: environmentValueAtTimeline(generated, "solarIrradiance", index, map.timeline, worldYearLengthDays(project)),
      windSpeed: environmentValueAtTimeline(generated, "windSpeed", index, map.timeline, worldYearLengthDays(project)),
      windDirection: (Math.atan2(windY, windX) * 180 / Math.PI + 360) % 360,
    };
  }, [cursor, generated, map.width, map.height, map.timeline, project]);
  const activeEnvironmentLayer = (["temperature", "humidity", "windSpeed", "precipitation", "snowfall", "evapotranspiration", "soilMoisture", "solarIrradiance", "solarHours"] as EnvironmentLayerKind[]).find((key) => layers[key]) ?? null;
  const environmentLegend = activeEnvironmentLayer && generated ? environmentRange(generated, activeEnvironmentLayer, map.timeline, worldYearLengthDays(project)) : null;
  const legendMeta: Record<EnvironmentLayerKind, { gradient: string }> = {
    temperature: { gradient: "linear-gradient(90deg,#264ca5,#66c2a5,#f5e27b,#f07e45,#a32232)" },
    precipitation: { gradient: "linear-gradient(90deg,#e6e0bc,#95c475,#3d957d,#214f92)" },
    snowfall: { gradient: "linear-gradient(90deg,#54697c,#97bad0,#e0eff8,#ffffff)" },
    evapotranspiration: { gradient: "linear-gradient(90deg,#476986,#59a681,#e1c35c,#c55c39)" },
    soilMoisture: { gradient: "linear-gradient(90deg,#bb8f54,#b0b86e,#4b9c8b,#295b97)" },
    windSpeed: { gradient: "linear-gradient(90deg,#d7ecff,#6fb7d6,#356aa0,#61337f)" },
    humidity: { gradient: "linear-gradient(90deg,#e0c684,#93c2a9,#499dab,#235c97)" },
    solarHours: { gradient: "linear-gradient(90deg,#4a4a70,#8776a4,#f0b44c,#fff291)" },
    solarIrradiance: { gradient: "linear-gradient(90deg,#4a4a70,#8776a4,#f0b44c,#fff291)" },
  };
  const scaleBar = useMemo(() => {
    const worldKm = Math.max(0.001, generated?.settings.mapScaleKm ?? map.width * 10);
    const pixelsPerKm = Math.max(0.0001, (map.width * 8 * viewScale) / worldKm);
    const targetKm = 110 / pixelsPerKm;
    const nice = (value: number) => { const power = 10 ** Math.floor(Math.log10(Math.max(value, 1e-9))); const unit = value / power; return (unit >= 5 ? 5 : unit >= 2 ? 2 : 1) * power; };
    if (measurementSystem === "imperial") { const miles = nice(targetKm / 1.609344); return { pixels: Math.max(34, Math.min(150, miles * 1.609344 * pixelsPerKm)), label: `${miles < 1 ? miles.toFixed(1) : miles.toLocaleString()} mi` }; }
    const km = nice(targetKm);
    return { pixels: Math.max(34, Math.min(150, km * pixelsPerKm)), label: km < 1 ? `${Math.round(km * 1000)} m` : `${km.toLocaleString()} km` };
  }, [generated, map.width, measurementSystem, viewScale]);
  const cursorSurfaceLabel = cursorEnvironment?.waterType === "saltwater"
    ? "바다"
    : cursorEnvironment?.waterType === "freshwater"
      ? "담수"
      : cursorEnvironment
        ? terrainLabels[cursorEnvironment.terrain]
        : "";
  const coordinateLabel = cursor && cursorEnvironment
    ? `X ${cursor.x.toFixed(1)} · Y ${cursor.y.toFixed(1)} · ${cursorSurfaceLabel} · 해발 ${Math.round(Math.min(cursorEnvironment.waterType === "saltwater" ? generated?.seaLevel ?? 0 : Number.POSITIVE_INFINITY, cursorEnvironment.elevation)).toLocaleString()} m · ${cursorEnvironment.temperature.toFixed(1)}℃`
    : "지도 위에 포인터를 올리세요";
  const environmentValue = activeEnvironmentLayer && cursorEnvironment ? cursorEnvironment[activeEnvironmentLayer] : null;
  const environmentPointerLabel = activeEnvironmentLayer && environmentValue !== null && Number.isFinite(environmentValue)
    ? `${climateLayerLabel(map.timeline.precision, activeEnvironmentLayer)} ${["precipitation", "snowfall", "evapotranspiration", "humidity", "soilMoisture"].includes(activeEnvironmentLayer) ? Math.round(environmentValue) : environmentValue.toFixed(1)}${environmentUnit(activeEnvironmentLayer, map.timeline.precision)}${activeEnvironmentLayer === "windSpeed" ? ` · ${Math.round(cursorEnvironment?.windDirection ?? 0)}°` : ""}`
    : null;
  const brushPreviewColor = activeTool === "territory"
    ? packedHexColor(map.factions.find((faction) => faction.id === territoryFactionId)?.color, 0x94a3b8)
    : TERRAIN_BRUSH_COLORS[selectedTerrain];

  const toolsForMode: Record<MapEditorMode, EditorTool[]> = {
    view: ["select"],
    civilization: ["select", "territory", "location", "label", "road", "event"],
    environment: ["select", "terrain", "elevation"],
  };
  const modeLabels: Record<MapEditorMode, string> = { view: "열람 모드", civilization: "문명 편집 모드", environment: "환경 편집 모드" };
  useEffect(() => {
    if (!toolsForMode[editorMode].includes(activeTool)) setActiveTool("select");
  }, [editorMode, activeTool]);
  const changeTool = (tool: EditorTool) => {
    if (!toolsForMode[editorMode].includes(tool)) return;
    if (tool === "terrain") setLayers((current) => ({ ...current, terrain: true }));
    if (tool === "elevation") setLayers((current) => ({ ...current, terrain: true, contours: true }));
    setActiveTool(tool); setDrawingPoints([]); setSelectedLocationId(null); setSelectedEventId(null); setSelectedPlaceNameId(null); setInspectorMode("view"); setNotice(`${toolLabels[tool]} 도구를 선택했습니다.`);
  };
  const cycleEditorMode = () => {
    const next: MapEditorMode = editorMode === "view" ? "civilization" : editorMode === "civilization" ? "environment" : "view";
    setActiveTool("select"); setDrawingPoints([]); setOverlay(null);
    onChange({ ...map, editorMode: next });
    setNotice(`${modeLabels[next]}로 전환했습니다.`);
  };
  const updateGeneratedAtCurrentYear = (nextGenerated: NonNullable<ReturnType<typeof generatedAtYear>>, message: string) => { const year = map.timeline.currentYear; const nextMap = { ...map, generatedStates: upsertTemporalStateAtYear(map.generatedStates, year, nextGenerated) }; onChange(alignMapFeaturesToGenerated(nextMap, nextGenerated)); setNotice(`${year}년: ${message}`); };
  const beginBrushStroke = () => {
    if (activeTool !== "terrain" && activeTool !== "elevation" && activeTool !== "territory") return;
    if (brushWorkerBusyRef.current) {
      brushWorkerRef.current?.terminate();
      brushWorkerRef.current = null;
      brushWorkerBusyRef.current = false;
    }
    brushRequestRef.current += 1;
    brushModeRef.current = activeTool;
    brushPointsRef.current = [];
    brushStrokeActiveRef.current = true;
  };
  const finishBrushStroke = () => {
    if (!brushStrokeActiveRef.current) return;
    brushStrokeActiveRef.current = false;
    const points = brushPointsRef.current;
    brushPointsRef.current = [];
    if (!points.length) return;
    const mode = brushModeRef.current;
    if (mode === "territory") {
      paintTerritoryStroke(points);
      return;
    }
    const source = pendingGeneratedRef.current ?? generatedAtYear(mapRef.current);
    if (!source) return;
    const nextGenerated = mode === "terrain"
      ? applyTerrainBrushStrokeImmediate(source, points, brushRadius, selectedTerrain, terrainNoise)
      : applyElevationBrushStrokeImmediate(source, points, brushRadius, {
          mode: elevationMode,
          value: elevationDelta,
          strength: brushStrength,
          falloff: brushFalloff,
        });
    const current = mapRef.current;
    const year = current.timeline.currentYear;
    const immediateMap = { ...current, generatedStates: upsertTemporalStateAtYear(current.generatedStates, year, nextGenerated) };
    pendingGeneratedRef.current = nextGenerated;
    commitCivilizationTransaction(immediateMap);
    setNotice(`${year}년: ${mode === "terrain" ? "지형" : "고도"} 스트로크 반영 · 환경 재계산 중`);

    const requestId = ++brushRequestRef.current;
    const worker = brushWorkerRef.current ?? new Worker(new URL("../workers/mapBrushWorker.ts", import.meta.url), {
      type: "module",
      name: "world-archive-brush-worker",
    });
    brushWorkerRef.current = worker;
    brushWorkerBusyRef.current = true;
    worker.onmessage = (event: MessageEvent<{ type: "result" | "error"; requestId: number; generated?: NonNullable<ReturnType<typeof generatedAtYear>>; error?: string }>) => {
      if (event.data.requestId !== brushRequestRef.current || worker !== brushWorkerRef.current) return;
      brushWorkerBusyRef.current = false;
      if (event.data.type === "error" || !event.data.generated) {
        setNotice(`브러시 재계산 실패: ${event.data.error ?? "알 수 없는 오류"}`);
        return;
      }
      const rebuilt = event.data.generated;
      const latestMap = mapRef.current;
      const latestYear = latestMap.timeline.currentYear;
      const mapWithRebuiltState = { ...latestMap, generatedStates: upsertTemporalStateAtYear(latestMap.generatedStates, latestYear, rebuilt) };
      const finalized = mode === "terrain"
        ? mapWithRebuiltState
        : alignMapFeaturesToGenerated(mapWithRebuiltState, rebuilt);
      mapRef.current = finalized;
      pendingGeneratedRef.current = rebuilt;
      onChange(finalized);
      setNotice(`${latestYear}년: 기후·수문·등고선 계산 완료`);
    };
    worker.onerror = () => {
      if (worker !== brushWorkerRef.current) return;
      worker.terminate();
      brushWorkerRef.current = null;
      brushWorkerBusyRef.current = false;
      setNotice("브러시 재계산 Worker를 실행하지 못했습니다.");
    };
    worker.postMessage({ requestId, generated: nextGenerated, mode });
  };

  const paintTerritoryStroke = (points: Point[]) => {
    const currentMap = mapRef.current;
    const currentGenerated = pendingGeneratedRef.current ?? generatedAtYear(currentMap);
    if (!currentGenerated) { setNotice("먼저 절차형 지도를 생성하세요."); return; }
    const cellSpacing = Math.min(
      currentGenerated.worldWidth / Math.max(1, currentGenerated.gridWidth),
      currentGenerated.worldHeight / Math.max(1, currentGenerated.gridHeight),
    ) * 0.55;
    const sampled = resampleBrushStroke(points, Math.max(0.08, Math.min(cellSpacing, brushRadius * 0.3)));
    const uniqueCenters = new Map<string, Point>();
    for (const point of sampled) {
      const center = nearestGeneratedPoint(currentGenerated, point, (_terrain, elevation) => elevation > currentGenerated.seaLevel);
      uniqueCenters.set(`${center.x.toFixed(6)}:${center.y.toFixed(6)}`, center);
    }
    const strokePolygon = buildBrushStrokePolygon([...uniqueCenters.values()], brushRadius)
      .map((candidate) => nearestGeneratedPoint(currentGenerated, candidate, (_terrain, elevation) => elevation > currentGenerated.seaLevel));
    if (strokePolygon.length < 3) return;
    const year = currentMap.timeline.currentYear;
    const ownerId = territoryFactionId || null;
    const ownerTerritories = currentMap.territories.filter((territory) => getStateAtYear(territory.states, year)?.ownerFactionId === ownerId);
    const existing = ownerTerritories.find((territory) => {
      const state = getStateAtYear(territory.states, year)!;
      return (state.parts?.length ? state.parts : [{ polygon: state.polygon }]).some((part) => polygonsOverlap(strokePolygon, part.polygon));
    }) ?? ownerTerritories[0];
    let nextMap: MapData;
    const geometryFingerprint = surfaceGeometryFingerprint(currentGenerated);
    const stateParts = (state: TerritoryState) =>
      state.parts?.length ? state.parts : [{ polygon: state.polygon, holes: state.holes }];
    const ownerParts = existing ? stateParts(getStateAtYear(existing.states, year)!) : [];
    const paintedOwnerParts = paintTerritoryPartsOnLand(currentGenerated, ownerParts, strokePolygon, "union");
    const territoriesAfterOverride = currentMap.territories.flatMap((territory) => {
      if (territory.id === existing?.id) return [territory];
      const state = getStateAtYear(territory.states, year);
      if (!state || !stateParts(state).some((part) => polygonsOverlap(strokePolygon, part.polygon))) return [territory];
      const remainingParts = paintTerritoryPartsOnLand(currentGenerated, stateParts(state), strokePolygon, "subtract");
      if (!remainingParts.length) return [];
      const primary = remainingParts[0];
      return [{ ...territory, states: upsertTemporalStateAtYear(territory.states, year, { ...state, polygon: primary.polygon, holes: primary.holes, parts: remainingParts, geometryVersion: CURRENT_SURFACE_VECTOR_VERSION, geometryFingerprint }) }];
    });
    if (!paintedOwnerParts.length) return;
    const primaryOwnerPart = paintedOwnerParts[0];
    if (existing) {
      const current = getStateAtYear(existing.states, year)!;
      nextMap = { ...currentMap, territories: territoriesAfterOverride.map((territory) => territory.id === existing.id ? { ...territory, states: upsertTemporalStateAtYear(territory.states, year, { ...current, polygon: primaryOwnerPart.polygon, holes: primaryOwnerPart.holes, parts: paintedOwnerParts, geometryVersion: CURRENT_SURFACE_VECTOR_VERSION, geometryFingerprint }) } : territory) };
    } else {
      nextMap = { ...currentMap, territories: [...territoriesAfterOverride, { id: createId("territory"), name: `새 영토 ${currentMap.territories.length + 1}`, states: [{ startYear: year, endYear: null, value: { ownerFactionId: ownerId, polygon: primaryOwnerPart.polygon, holes: primaryOwnerPart.holes, parts: paintedOwnerParts, geometryVersion: CURRENT_SURFACE_VECTOR_VERSION, geometryFingerprint, description: "" } }] }] };
    }
    const constrainedMap = enforceTerritoryConstraints(nextMap, currentGenerated);
    commitCivilizationTransaction(constrainedMap);
    setNotice(`${year}년 영토 스트로크를 반영했습니다.`);
  };

  const handleContinuousStroke = (tool: "road" | "label", rawPoints: Point[]) => {
    const currentMap = mapRef.current;
    const currentGenerated = pendingGeneratedRef.current ?? generatedAtYear(currentMap);
    const spacing = currentGenerated
      ? Math.max(0.08, Math.min(currentGenerated.worldWidth / currentGenerated.gridWidth, currentGenerated.worldHeight / currentGenerated.gridHeight) * 0.45)
      : 0.25;
    const sampled = resampleBrushStroke(rawPoints, spacing);
    if (sampled.length < 2) return;
    const year = currentMap.timeline.currentYear;
    if (tool === "road") {
      const control = sampled.map((point) => currentGenerated
        ? nearestGeneratedPoint(currentGenerated, point, (_terrain, elevation) => elevation > currentGenerated.seaLevel)
        : point);
      const smoothed = curveMode && control.length >= 3 ? createSmoothCurve(control) : control;
      const nodes = currentGenerated ? routePathOnLand(currentGenerated, smoothed) : smoothed;
      if (nodes.length < 2) return;
      commitCivilizationTransaction({
        ...currentMap,
        roads: [...currentMap.roads, { id: createId("road"), name: `새 길 ${currentMap.roads.length + 1}`, nodes, roadType: "secondary", description: "", startYear: year, endYear: null }],
      });
      setNotice(`${year}년에 드래그 경로를 따라 길을 추가했습니다.`);
    } else {
      const path = curveMode && sampled.length >= 3 ? createSmoothCurve(sampled) : sampled;
      const position = path[Math.floor(path.length / 2)] ?? sampled[0];
      const place: PlaceName = {
        id: createId("place"),
        name: `새 지명 ${currentMap.placeNames.length + 1}`,
        position,
        type: "region",
        description: "",
        startYear: year,
        endYear: null,
        placementMode: "path",
        path,
        curve: curveMode,
        letterSpacing: 2.1,
        pathOffset: 0,
      };
      commitCivilizationTransaction({ ...currentMap, placeNames: [...currentMap.placeNames, place] });
      setSelectedPlaceNameId(place.id);
      setSelectedLocationId(null);
      setSelectedEventId(null);
      setOverlay("info");
      setNotice("드래그 기준선을 따라 지명을 추가했습니다.");
    }
    setDrawingPoints([]);
    setActiveTool("select");
  };

  const handleMapClick = (point: Point) => {
    if (point.x < 0 || point.y < 0 || point.x > map.width || point.y > map.height) return; const year = map.timeline.currentYear;
    if (activeTool === "terrain" || activeTool === "elevation" || activeTool === "territory") { if (!generated) { setNotice("먼저 절차형 지도를 생성하세요."); return; } brushPointsRef.current.push(point); return; }
    if (activeTool === "road") { const snapped = generated ? nearestGeneratedPoint(generated, point, (_terrain, elevation) => elevation > generated.seaLevel) : point; setDrawingPoints((items) => [...items, { x: Number(snapped.x.toFixed(2)), y: Number(snapped.y.toFixed(2)) }]); setNotice(`${toolLabels[activeTool]} 제어점 ${drawingPoints.length + 1}개를 기록했습니다.`); return; }
    if (activeTool === "location") { const now = performance.now(); if (now - rapidActionLockRef.current < 250) return; rapidActionLockRef.current = now; const id = createId("location"); const target = generated ? nearestGeneratedPoint(generated, point, (_terrain, elevation) => elevation > generated.seaLevel) : point; const position = { x: Number(target.x.toFixed(1)), y: Number(target.y.toFixed(1)) }; commitCivilizationTransaction({ ...map, locations: [...map.locations, { id, states: [{ startYear: year, endYear: null, value: { name: `새 장소 ${map.locations.length + 1}`, locationType: "city", position, population: 0, economy: 0, status: "active", description: "" } }] }] }); setSelectedLocationId(id); setSelectedEventId(null); setInspectorMode("view"); setActiveTool("select"); setOverlay("info"); setNotice(`${year}년에 장소를 추가했습니다.`); return; }
    if (activeTool === "label") {
      if (selectedPlaceNameId && drawingPoints.length > 0) { setDrawingPoints((points) => [...points, point]); return; }
      const nearest = map.placeNames.filter((item) => item.startYear <= year && (item.endYear === null || item.endYear >= year)).map((item) => {
        const anchors = item.path?.length ? item.path : [item.position];
        return { item, distance: Math.min(...anchors.map((anchor) => Math.hypot(anchor.x - point.x, anchor.y - point.y))) };
      }).sort((a, b) => a.distance - b.distance)[0];
      if (nearest && nearest.distance <= 5) { setSelectedPlaceNameId(nearest.item.id); setSelectedLocationId(null); setSelectedEventId(null); setDrawingPoints(nearest.item.path?.length ? [...nearest.item.path] : [nearest.item.position]); setOverlay("info"); }
      else { setSelectedPlaceNameId(null); setDrawingPoints((points) => [...points, point]); }
      return;
    }
    if (activeTool === "event") { const now = performance.now(); if (now - rapidActionLockRef.current < 250) return; rapidActionLockRef.current = now; const event: WorldEvent = { id: createId("event"), title: `새 사건 ${map.events.length + 1}`, startYear: year, endYear: year, category: "incident", description: "", locationMode: "coordinate", location: { x: Number(point.x.toFixed(1)), y: Number(point.y.toFixed(1)) }, locationText: "", cause: "", result: "", impact: "", startTimeUnknown: false, endTimeUnknown: false, startDateTime: { year }, endDateTime: { year }, participants: [], chronology: [{ id: createId("chronology"), dateTime: { year }, title: "사건 발생", description: "" }], relatedLocationIds: [], relatedFactionIds: [], relatedTerritoryIds: [] }; commitCivilizationTransaction({ ...map, events: [...map.events, event] }); setSelectedEventId(event.id); setSelectedLocationId(null); setSelectedPlaceNameId(null); setInspectorMode("view"); setActiveTool("select"); setOverlay("info"); setNotice(`${year}년에 사건을 추가했습니다.`); return; }
    if (selectionTimerRef.current !== null) window.clearTimeout(selectionTimerRef.current);
    selectionTimerRef.current = window.setTimeout(() => {
      const latestMap = mapRef.current;
      const locationCandidates = visibleLocations(latestMap).map(({ location, state }) => ({ type: "location" as const, id: location.id, distance: Math.hypot(state.position.x - point.x, state.position.y - point.y) }));
      const eventCandidates = currentEvents(latestMap).filter((candidate) => candidate.location).map((candidate) => ({ type: "event" as const, id: candidate.id, distance: Math.hypot(candidate.location!.x - point.x, candidate.location!.y - point.y) }));
      const selected = [...locationCandidates, ...eventCandidates].sort((a, b) => a.distance - b.distance)[0];
      const accepted = selected && selected.distance <= 3.6 ? selected : null;
      setSelectedLocationId(accepted?.type === "location" ? accepted.id : null); setSelectedEventId(accepted?.type === "event" ? accepted.id : null); setSelectedPlaceNameId(null); setInspectorMode("view"); if (accepted) setOverlay("info");
    }, 110);
  };

  const finishDrawing = () => {
    const year = map.timeline.currentYear;
    if (activeTool === "label") {
      if (drawingPoints.length < 1) return;
      const control = curveMode && drawingPoints.length >= 3 ? createSmoothCurve(drawingPoints) : drawingPoints;
      const position = control[Math.floor(control.length / 2)] ?? drawingPoints[0];
      if (selectedPlaceNameId) {
        commitCivilizationTransaction({ ...map, placeNames: map.placeNames.map((item) => item.id === selectedPlaceNameId ? { ...item, position, placementMode: drawingPoints.length >= 2 ? "path" : "point", path: drawingPoints.length >= 2 ? control : undefined, curve: curveMode } : item) });
        setNotice("지명 경로를 수정했습니다.");
      } else {
        const place: PlaceName = { id: createId("place"), name: `새 지명 ${map.placeNames.length + 1}`, position, type: "region", description: "", startYear: year, endYear: null, placementMode: drawingPoints.length >= 2 ? "path" : "point", path: drawingPoints.length >= 2 ? control : undefined, curve: curveMode, letterSpacing: 2.1, pathOffset: 0 };
        commitCivilizationTransaction({ ...map, placeNames: [...map.placeNames, place] }); setSelectedPlaceNameId(place.id); setOverlay("info"); setNotice("경로형 지명을 추가했습니다.");
      }
      setDrawingPoints([]); setActiveTool("select"); return;
    }
    if (drawingPoints.length < 2) return;
    const control = curveMode ? createSmoothCurve(drawingPoints) : drawingPoints;
    const nodes = generated ? routePathOnLand(generated, control) : control;
    if (activeTool === "road") commitCivilizationTransaction({ ...map, roads: [...map.roads, { id: createId("road"), name: `새 길 ${map.roads.length + 1}`, nodes, roadType: "secondary", description: "", startYear: year, endYear: null }] });
    setNotice(`${year}년에 ${curveMode ? "곡선 " : ""}${toolLabels[activeTool]}을 추가했습니다.`); setDrawingPoints([]); setActiveTool("select");
  };
  const updateLocation = (locationId: string, state: LocationState) => {
    const year = map.timeline.currentYear;
    const position = generated
      ? nearestGeneratedPoint(generated, state.position, (_terrain, elevation, x, y) => /항구|항$|항만|포구/.test(state.name)
        ? (generated.waterTypeMap?.[y * generated.gridWidth + x] ?? (elevation > generated.seaLevel ? "land" : "saltwater")) === "land" && (() => {
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
            const nx = x + dx; const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= generated.gridWidth || ny >= generated.gridHeight) return true;
            const neighborIndex = ny * generated.gridWidth + nx;
            if ((generated.waterTypeMap?.[neighborIndex] ?? (generated.elevationMap[neighborIndex] > generated.seaLevel ? "land" : "saltwater")) !== "land") return true;
          }
          return false;
        })()
        : (generated.waterTypeMap?.[y * generated.gridWidth + x] ?? (elevation > generated.seaLevel ? "land" : "saltwater")) === "land")
      : state.position;
    onChange({ ...map, locations: map.locations.map((location) => location.id !== locationId ? location : { ...location, states: upsertTemporalStateAtYear(location.states, year, { ...state, position }) }) });
    setNotice(`${year}년의 장소 상태를 육지 좌표에 저장했습니다.`);
  };
  const removeLocation = (locationId: string) => { const year = map.timeline.currentYear; onChange({ ...map, locations: map.locations.map((location) => { if (location.id !== locationId) return location; const current = getStateAtYear(location.states, year); return current ? { ...location, states: upsertTemporalStateAtYear(location.states, year, { ...current, status: "destroyed" }) } : location; }) }); setSelectedLocationId(null); };
  const hardDeleteLocation = (locationId: string) => { onChange({ ...map, locations: map.locations.filter((location) => location.id !== locationId) }); setSelectedLocationId(null); setNotice("장소의 모든 연도 기록을 완전히 삭제했습니다."); };
  const updateEvent = (nextEvent: WorldEvent) => { onChange({ ...map, events: map.events.map((item) => item.id === nextEvent.id ? nextEvent : item) }); setNotice("사건 속성을 저장했습니다."); };
  const updatePlaceName = (place: PlaceName) => { onChange({ ...map, placeNames: map.placeNames.map((item) => item.id === place.id ? place : item) }); setNotice("지명 명찰을 저장했습니다."); };
  const deletePlaceName = (id: string) => { onChange({ ...map, placeNames: map.placeNames.filter((item) => item.id !== id) }); setSelectedPlaceNameId(null); };

  return <section className={`map-editor-window floating-panels mode-${editorMode}`}>
    <div className="map-column">
      <div className="map-canvas-shell">
        <div className="map-edit-controls">
          <button type="button" className={`map-edit-mode-cycle ${editorMode}`} onClick={cycleEditorMode} title="지도 작업 모드 전환">{modeLabels[editorMode]}</button>
          {editorMode !== "view" && <Toolbar editorMode={editorMode} activeTool={activeTool} onChange={changeTool} selectedTerrain={selectedTerrain} onTerrainChange={setSelectedTerrain} brushRadius={brushRadius} onBrushRadiusChange={setBrushRadius} elevationDelta={elevationDelta} onElevationDeltaChange={setElevationDelta} elevationMode={elevationMode} onElevationModeChange={(mode) => { setElevationMode(mode); if (mode !== "target") setElevationDelta((value) => Math.max(25, Math.abs(value))); }} brushStrength={brushStrength} onBrushStrengthChange={setBrushStrength} brushFalloff={brushFalloff} onBrushFalloffChange={setBrushFalloff} terrainNoise={terrainNoise} onTerrainNoiseChange={setTerrainNoise} seaLevel={generated?.seaLevel ?? 0} onSeaLevelChange={(level) => generated && updateGeneratedAtCurrentYear(applySeaLevel(generated, level), `해수면을 ${level}m로 변경했습니다.`)} factions={map.factions} territoryFactionId={territoryFactionId} onTerritoryFactionChange={setTerritoryFactionId} drawingCount={drawingPoints.length} curveMode={curveMode} onCurveModeChange={setCurveMode} onFinishDrawing={finishDrawing} onCancelDrawing={() => setDrawingPoints([])} canUndo={undoStackRef.current.length > 0} canRedo={redoStackRef.current.length > 0} onUndo={undoCivilizationTransaction} onRedo={redoCivilizationTransaction} />}
        </div>
        <div className="map-editor-notice">{notice}{!generated && <button type="button" onClick={onOpenGenerator}>지도 생성</button>}</div><MapViewport project={project} map={map} layers={layers} activeTool={activeTool} selectedLocationId={selectedLocationId} selectedEventId={selectedEventId} selectedPlaceNameId={selectedPlaceNameId} onMapClick={handleMapClick} onBrushStrokeStart={beginBrushStroke} onBrushStrokeEnd={finishBrushStroke} onContinuousStroke={handleContinuousStroke} onCursorMove={setCursor} draftPoints={displayedDraftPoints} draftTool={activeTool} brushRadius={brushRadius} brushPreviewColor={brushPreviewColor} environmentOpacity={environmentOpacity} onViewScaleChange={setViewScale} />
        <div className="map-pointer-readouts"><div className="map-coordinate-readout">{coordinateLabel}</div>{environmentPointerLabel && <div className="map-environment-readout">{environmentPointerLabel}</div>}</div><div className="map-floating-buttons"><button type="button" className={overlay === "layers" ? "active" : ""} title="레이어 표시" onClick={() => setOverlay((value) => value === "layers" ? null : "layers")}>☷</button><button type="button" className={overlay === "info" ? "active" : ""} title="지도·요소 정보" onClick={() => setOverlay((value) => value === "info" ? null : "info")}>ⓘ</button></div>
        {overlay && <aside className={`map-floating-panel ${overlay}`}><div className="floating-panel-actions">{overlay === "info" && (selectedLocationId || selectedEventId) && <button type="button" className="floating-panel-edit" title="속성 편집" aria-label="속성 편집" onClick={() => setInspectorMode("edit")}>✎</button>}<button type="button" className="floating-panel-close" title="닫기" aria-label="닫기" onClick={() => setOverlay(null)}>×</button></div>{overlay === "layers" ? <LayerPanel layers={layers} precision={map.timeline.precision} onChange={setLayers} environmentOpacity={environmentOpacity} onEnvironmentOpacityChange={setEnvironmentOpacity} /> : <Inspector project={project} map={map} selectedLocationId={selectedLocationId} selectedEventId={selectedEventId} selectedPlaceNameId={selectedPlaceNameId} mode={inspectorMode} onModeChange={setInspectorMode} onOpenWiki={onOpenWikiEntity} onLocationSave={updateLocation} onDeleteLocation={removeLocation} onHardDeleteLocation={hardDeleteLocation} onEventSave={updateEvent} onPlaceNameSave={updatePlaceName} onDeletePlaceName={deletePlaceName} />}</aside>}
        <div className="map-hud-stack">
          {generated && environmentLegend && activeEnvironmentLayer && <aside className={`environment-legend ${legendCollapsed ? "collapsed" : ""}`}><button type="button" onClick={() => setLegendCollapsed((value) => !value)}>{legendCollapsed ? "범례 펼치기" : climateLayerLabel(map.timeline.precision, activeEnvironmentLayer)}</button>{!legendCollapsed && <div className="gradient-legend"><div className="gradient-strip" style={{ background: legendMeta[activeEnvironmentLayer].gradient }} /><div className="gradient-values"><span>{environmentLegend.min.toFixed(["precipitation", "snowfall", "evapotranspiration", "humidity", "soilMoisture"].includes(activeEnvironmentLayer) ? 0 : 1)}{environmentLegend.unit}</span><span>{environmentLegend.max.toFixed(["precipitation", "snowfall", "evapotranspiration", "humidity", "soilMoisture"].includes(activeEnvironmentLayer) ? 0 : 1)}{environmentLegend.unit}</span></div></div>}</aside>}
          <aside className="map-scale-bar" aria-label={`지도 축척 ${scaleBar.label}`}><div className="scale-rule" style={{ width: `${scaleBar.pixels}px` }} /><span>{scaleBar.label}</span></aside>
        </div>
      </div></div>
  </section>;
}
