import { useEffect, useMemo, useRef, useState } from "react";
import type { EditorTool, LayerVisibility, LocationState, MapData, MapEditorMode, PlaceName, Point, TerrainType, WorldEvent, WorldProject } from "../model/world";
import { createId, currentEvents, generatedAtYear, getStateAtYear, getTemporalRecordAtYear, pointInPolygon, upsertTemporalStateAtYear, visibleLocations, worldYearLengthDays } from "../model/world";
import { alignMapFeaturesToGenerated, nearestGeneratedPoint, routePathOnLand } from "../generator/mapPlacement";
import { applyElevationBrushImmediate, applySeaLevel, applyTerrainBrushImmediate, brushCirclePoints, buildTerritoryPolygon, createSmoothCurve } from "../generator/mapEditing";
import { environmentRange, environmentValueAtTimeline, environmentUnit, type EnvironmentLayerKind } from "../generator/renderGenerated";
import { rebuildGeneratedMapData } from "../generator/generateWorld";
import { Inspector } from "./Inspector";
import { climateLayerLabel, LayerPanel } from "./LayerPanel";
import { MapViewport } from "./MapViewport";
import { Toolbar } from "./Toolbar";
import { createGridTransform } from "../generator/gridTransform";

type Props = { project: WorldProject; map: MapData; onChange: (map: MapData) => void; onOpenGenerator: () => void; onOpenWikiEntity: (entityType: "location" | "event", entityId: string) => void };
const initialLayers: LayerVisibility = { terrain: true, contours: true, coastline: false, territories: false, rivers: true, roads: true, locations: true, labels: true, events: true, windDirection: false, countryNames: true, windSpeed: false, temperature: false, precipitation: false, humidity: false, solarHours: false, solarIrradiance: false, snowfall: false, evapotranspiration: false, soilMoisture: false };
const toolLabels: Record<EditorTool, string> = { select: "선택", terrain: "지형", elevation: "고도", location: "장소", label: "지명", road: "길", river: "강", territory: "영토", event: "사건" };


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
  const [activeTool, setActiveTool] = useState<EditorTool>(() => { const saved = localStorage.getItem("world-archive-active-tool"); return (["select","terrain","elevation","location","label","road","river","territory","event"] as EditorTool[]).includes(saved as EditorTool) ? saved as EditorTool : "select"; }); const [layers, setLayers] = useState<LayerVisibility>(initialLayers);
  const [selectedLocationId, setSelectedLocationId] = useState<string | null>(null); const [selectedEventId, setSelectedEventId] = useState<string | null>(null); const [selectedPlaceNameId, setSelectedPlaceNameId] = useState<string | null>(null);
  const [inspectorMode, setInspectorMode] = useState<"view" | "edit">("view");
  const [cursor, setCursor] = useState<Point | null>(null); const [overlay, setOverlay] = useState<"layers" | "info" | null>(null);
  const [environmentOpacity, setEnvironmentOpacity] = useState(() => Number(localStorage.getItem("world-archive-paint-opacity") ?? 0.58)); const [legendCollapsed, setLegendCollapsed] = useState(false);
  const [viewScale, setViewScale] = useState(1);
  const [measurementSystem, setMeasurementSystem] = useState<"metric" | "imperial">(() => localStorage.getItem("world-archive-measurement-system") === "imperial" ? "imperial" : "metric");
  const [selectedTerrain, setSelectedTerrain] = useState<TerrainType>(() => (localStorage.getItem("world-archive-selected-terrain") as TerrainType) || "forest"); const [brushRadius, setBrushRadius] = useState(() => Number(localStorage.getItem("world-archive-brush-radius") ?? 5));
  const [elevationDelta, setElevationDelta] = useState(() => Number(localStorage.getItem("world-archive-elevation-delta") ?? 400)); const [territoryFactionId, setTerritoryFactionId] = useState(map.factions[0]?.id ?? ""); const [drawingPoints, setDrawingPoints] = useState<Point[]>([]); const [curveMode, setCurveMode] = useState(true);
  const [notice, setNotice] = useState(generatedAtYear(map) ? "현재 연도에 적용된 절차형 지도가 있습니다." : "빈 지도입니다. 지도 생성기를 열어 지형을 만드세요.");
  const mapRef = useRef(map);
  const pendingGeneratedRef = useRef<NonNullable<ReturnType<typeof generatedAtYear>> | null>(generatedAtYear(map));
  const recalculationTimerRef = useRef<number | null>(null);
  const recalculationModeRef = useRef<"terrain" | "elevation">("terrain");
  const rapidActionLockRef = useRef(0);
  const selectionTimerRef = useRef<number | null>(null);
  useEffect(() => { mapRef.current = map; pendingGeneratedRef.current = generatedAtYear(map); }, [map]);
  useEffect(() => () => { if (recalculationTimerRef.current !== null) window.clearTimeout(recalculationTimerRef.current); if (selectionTimerRef.current !== null) window.clearTimeout(selectionTimerRef.current); }, []);
  useEffect(() => { localStorage.setItem("world-archive-paint-opacity", String(environmentOpacity)); }, [environmentOpacity]);
  useEffect(() => { localStorage.setItem("world-archive-active-tool", activeTool); }, [activeTool]);
  useEffect(() => { localStorage.setItem("world-archive-selected-terrain", selectedTerrain); }, [selectedTerrain]);
  useEffect(() => { localStorage.setItem("world-archive-brush-radius", String(brushRadius)); }, [brushRadius]);
  useEffect(() => { localStorage.setItem("world-archive-elevation-delta", String(elevationDelta)); }, [elevationDelta]);
  useEffect(() => { setInspectorMode("view"); }, [selectedLocationId, selectedEventId]);
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
  const generated = generatedAtYear(map); const displayedDraftPoints = curveMode && (activeTool === "road" || activeTool === "river" || activeTool === "label") && drawingPoints.length >= 3 ? createSmoothCurve(drawingPoints) : drawingPoints;
  const terrainLabels: Record<TerrainType, string> = { mountain: "산지", forest: "숲", desert: "사막", snow: "설원", grassland: "초원", plain: "평원", farmland: "농경지", jungle: "열대림", wetland: "습지", rock: "암석", bedrock: "암반" };
  const cursorEnvironment = useMemo(() => {
    if (!cursor || !generated || generated.gridWidth <= 0 || generated.gridHeight <= 0) return null;
    const cell = createGridTransform(generated.worldWidth, generated.worldHeight, generated.gridWidth, generated.gridHeight).worldToCell(cursor);
    const gx = cell.x;
    const gy = cell.y;
    const index = cell.index;
    const windX = generated.windXMap[index] ?? 0;
    const windY = generated.windYMap[index] ?? 0;
    return {
      index,
      terrain: generated.terrainMap[index] ?? "plain",
      elevation: generated.elevationMap[index] ?? 0,
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
  const coordinateLabel = cursor && cursorEnvironment
    ? `X ${cursor.x.toFixed(1)} · Y ${cursor.y.toFixed(1)} · ${terrainLabels[cursorEnvironment.terrain]} · 해발 ${Math.round(cursorEnvironment.elevation).toLocaleString()} m · ${cursorEnvironment.temperature.toFixed(1)}℃`
    : "지도 위에 포인터를 올리세요";
  const environmentValue = activeEnvironmentLayer && cursorEnvironment ? cursorEnvironment[activeEnvironmentLayer] : null;
  const environmentPointerLabel = activeEnvironmentLayer && environmentValue !== null && Number.isFinite(environmentValue)
    ? `${climateLayerLabel(map.timeline.precision, activeEnvironmentLayer)} ${["precipitation", "snowfall", "evapotranspiration", "humidity", "soilMoisture"].includes(activeEnvironmentLayer) ? Math.round(environmentValue) : environmentValue.toFixed(1)}${environmentUnit(activeEnvironmentLayer, map.timeline.precision)}${activeEnvironmentLayer === "windSpeed" ? ` · ${Math.round(cursorEnvironment?.windDirection ?? 0)}°` : ""}`
    : null;

  const toolsForMode: Record<MapEditorMode, EditorTool[]> = {
    view: ["select"],
    civilization: ["select", "territory", "location", "label", "road", "event"],
    environment: ["select", "terrain", "elevation", "river"],
  };
  const modeLabels: Record<MapEditorMode, string> = { view: "열람 모드", civilization: "문명 편집 모드", environment: "환경 편집 모드" };
  useEffect(() => {
    if (!toolsForMode[editorMode].includes(activeTool)) setActiveTool("select");
  }, [editorMode, activeTool]);
  const changeTool = (tool: EditorTool) => {
    if (!toolsForMode[editorMode].includes(tool)) return;
    setActiveTool(tool); setDrawingPoints([]); setSelectedLocationId(null); setSelectedEventId(null); setSelectedPlaceNameId(null); setInspectorMode("view"); setNotice(`${toolLabels[tool]} 도구를 선택했습니다.`);
  };
  const cycleEditorMode = () => {
    const next: MapEditorMode = editorMode === "view" ? "civilization" : editorMode === "civilization" ? "environment" : "view";
    setActiveTool("select"); setDrawingPoints([]); setOverlay(null);
    onChange({ ...map, editorMode: next });
    setNotice(`${modeLabels[next]}로 전환했습니다.`);
  };
  const updateGeneratedAtCurrentYear = (nextGenerated: NonNullable<ReturnType<typeof generatedAtYear>>, message: string) => { const year = map.timeline.currentYear; const nextMap = { ...map, generatedStates: upsertTemporalStateAtYear(map.generatedStates, year, nextGenerated) }; onChange(alignMapFeaturesToGenerated(nextMap, nextGenerated)); setNotice(`${year}년: ${message}`); };
  const applyBrushImmediately = (nextGenerated: NonNullable<ReturnType<typeof generatedAtYear>>, mode: "terrain" | "elevation", message: string) => {
    const current = mapRef.current;
    const year = current.timeline.currentYear;
    const immediateMap = { ...current, generatedStates: upsertTemporalStateAtYear(current.generatedStates, year, nextGenerated) };
    mapRef.current = immediateMap;
    pendingGeneratedRef.current = nextGenerated;
    recalculationModeRef.current = mode;
    onChange(immediateMap);
    setNotice(`${year}년: ${message} · 파생 환경 계산 중`);
    if (recalculationTimerRef.current !== null) window.clearTimeout(recalculationTimerRef.current);
    recalculationTimerRef.current = window.setTimeout(() => {
      const run = () => {
        const pending = pendingGeneratedRef.current;
        if (!pending) return;
        const rebuilt = rebuildGeneratedMapData(pending, pending.elevationMap, recalculationModeRef.current === "terrain" ? pending.terrainMap : undefined, pending.seaLevel);
        const latestMap = mapRef.current;
        const latestYear = latestMap.timeline.currentYear;
        const finalized = alignMapFeaturesToGenerated({ ...latestMap, generatedStates: upsertTemporalStateAtYear(latestMap.generatedStates, latestYear, rebuilt) }, rebuilt);
        mapRef.current = finalized; pendingGeneratedRef.current = rebuilt; onChange(finalized);
        setNotice(`${latestYear}년: 파생 기후·수문·등고선 계산 완료`);
      };
      const idle = (window as typeof window & { requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number }).requestIdleCallback;
      if (idle) idle(run, { timeout: 450 }); else window.setTimeout(run, 0);
    }, 180);
  };

  const paintTerritory = (point: Point) => {
    if (!generated) { setNotice("먼저 절차형 지도를 생성하세요."); return; }
    const center = nearestGeneratedPoint(generated, point, (_terrain, elevation) => elevation > generated.seaLevel);
    const circle = brushCirclePoints(center, brushRadius).map((candidate) => nearestGeneratedPoint(generated, candidate, (_terrain, elevation) => elevation > generated.seaLevel));
    const year = map.timeline.currentYear;
    const existing = map.territories.find((territory) => getStateAtYear(territory.states, year)?.ownerFactionId === (territoryFactionId || null));
    let nextMap: MapData;
    const candidatePolygon = existing ? buildTerritoryPolygon(getStateAtYear(existing.states, year)!.polygon, circle) : buildTerritoryPolygon([], circle);
    const conflict = map.territories.some((territory) => territory.id !== existing?.id && (() => { const state = getStateAtYear(territory.states, year); return Boolean(state && polygonsOverlap(candidatePolygon, state.polygon)); })());
    if (conflict) { setNotice("영토는 다른 영토와 겹칠 수 없습니다. 경계 밖에서 다시 칠하세요."); return; }
    if (existing) {
      const current = getStateAtYear(existing.states, year)!;
      nextMap = { ...map, territories: map.territories.map((territory) => territory.id === existing.id ? { ...territory, states: upsertTemporalStateAtYear(territory.states, year, { ...current, polygon: candidatePolygon }) } : territory) };
    } else {
      nextMap = { ...map, territories: [...map.territories, { id: createId("territory"), name: `새 영토 ${map.territories.length + 1}`, states: [{ startYear: year, endYear: null, value: { ownerFactionId: territoryFactionId || null, polygon: candidatePolygon, description: "" } }] }] };
    }
    onChange(alignMapFeaturesToGenerated(nextMap, generated)); setNotice(`${year}년 영토를 붓으로 확장했습니다.`);
  };

  const handleMapClick = (point: Point) => {
    if (point.x < 0 || point.y < 0 || point.x > map.width || point.y > map.height) return; const year = map.timeline.currentYear;
    if (activeTool === "terrain") { const source = pendingGeneratedRef.current ?? generated; if (!source) { setNotice("먼저 절차형 지도를 생성하세요."); return; } applyBrushImmediately(applyTerrainBrushImmediate(source, point, brushRadius, selectedTerrain), "terrain", `${selectedTerrain} 지형을 즉시 반영했습니다.`); return; }
    if (activeTool === "elevation") { const source = pendingGeneratedRef.current ?? generated; if (!source) { setNotice("먼저 절차형 지도를 생성하세요."); return; } applyBrushImmediately(applyElevationBrushImmediate(source, point, brushRadius, elevationDelta), "elevation", `고도 ${elevationDelta > 0 ? "+" : ""}${elevationDelta}m를 즉시 반영했습니다.`); return; }
    if (activeTool === "territory") { paintTerritory(point); return; }
    if (activeTool === "road" || activeTool === "river") { const snapped = generated ? nearestGeneratedPoint(generated, point, (_terrain, elevation) => elevation > generated.seaLevel) : point; setDrawingPoints((items) => [...items, { x: Number(snapped.x.toFixed(2)), y: Number(snapped.y.toFixed(2)) }]); setNotice(`${toolLabels[activeTool]} 제어점 ${drawingPoints.length + 1}개를 기록했습니다.`); return; }
    if (activeTool === "location") { const now = performance.now(); if (now - rapidActionLockRef.current < 250) return; rapidActionLockRef.current = now; const id = createId("location"); const target = generated ? nearestGeneratedPoint(generated, point, (_terrain, elevation) => elevation > generated.seaLevel) : point; const position = { x: Number(target.x.toFixed(1)), y: Number(target.y.toFixed(1)) }; onChange({ ...map, locations: [...map.locations, { id, states: [{ startYear: year, endYear: null, value: { name: `새 장소 ${map.locations.length + 1}`, locationType: "city", position, population: 0, economy: 0, status: "active", description: "" } }] }] }); setSelectedLocationId(id); setSelectedEventId(null); setInspectorMode("view"); setActiveTool("select"); setOverlay("info"); setNotice(`${year}년에 장소를 추가했습니다.`); return; }
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
    if (activeTool === "event") { const now = performance.now(); if (now - rapidActionLockRef.current < 250) return; rapidActionLockRef.current = now; const event: WorldEvent = { id: createId("event"), title: `새 사건 ${map.events.length + 1}`, startYear: year, endYear: year, category: "incident", description: "", startTimeUnknown: false, endTimeUnknown: false, location: { x: Number(point.x.toFixed(1)), y: Number(point.y.toFixed(1)) }, startDateTime: { year }, endDateTime: { year }, participants: [], chronology: [{ id: createId("chronology"), dateTime: { year }, title: "사건 발생", description: "" }], relatedLocationIds: [], relatedFactionIds: [], relatedTerritoryIds: [] }; onChange({ ...map, events: [...map.events, event] }); setSelectedEventId(event.id); setSelectedLocationId(null); setSelectedPlaceNameId(null); setInspectorMode("view"); setActiveTool("select"); setOverlay("info"); setNotice(`${year}년에 사건을 추가했습니다.`); return; }
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
        onChange({ ...map, placeNames: map.placeNames.map((item) => item.id === selectedPlaceNameId ? { ...item, position, placementMode: drawingPoints.length >= 2 ? "path" : "point", path: drawingPoints.length >= 2 ? control : undefined, curve: curveMode } : item) });
        setNotice("지명 경로를 수정했습니다.");
      } else {
        const place: PlaceName = { id: createId("place"), name: `새 지명 ${map.placeNames.length + 1}`, position, type: "region", description: "", startYear: year, endYear: null, placementMode: drawingPoints.length >= 2 ? "path" : "point", path: drawingPoints.length >= 2 ? control : undefined, curve: curveMode, letterSpacing: 2.1, pathOffset: 0 };
        onChange({ ...map, placeNames: [...map.placeNames, place] }); setSelectedPlaceNameId(place.id); setOverlay("info"); setNotice("경로형 지명을 추가했습니다.");
      }
      setDrawingPoints([]); setActiveTool("select"); return;
    }
    if (drawingPoints.length < 2) return;
    const control = curveMode ? createSmoothCurve(drawingPoints) : drawingPoints;
    const nodes = generated ? routePathOnLand(generated, control, activeTool === "river") : control;
    if (activeTool === "road") onChange({ ...map, roads: [...map.roads, { id: createId("road"), name: `새 길 ${map.roads.length + 1}`, nodes, roadType: "secondary", description: "", startYear: year, endYear: null }] });
    if (activeTool === "river") onChange({ ...map, rivers: [...map.rivers, { id: createId("river"), name: `새 강 ${map.rivers.length + 1}`, nodes, width: 2, description: "", startYear: year, endYear: null }] });
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
    {editorMode !== "view" && <Toolbar editorMode={editorMode} activeTool={activeTool} onChange={changeTool} selectedTerrain={selectedTerrain} onTerrainChange={setSelectedTerrain} brushRadius={brushRadius} onBrushRadiusChange={setBrushRadius} elevationDelta={elevationDelta} onElevationDeltaChange={setElevationDelta} seaLevel={generated?.seaLevel ?? 0} onSeaLevelChange={(level) => generated && updateGeneratedAtCurrentYear(applySeaLevel(generated, level), `해수면을 ${level}m로 변경했습니다.`)} factions={map.factions} territoryFactionId={territoryFactionId} onTerritoryFactionChange={setTerritoryFactionId} drawingCount={drawingPoints.length} curveMode={curveMode} onCurveModeChange={setCurveMode} onFinishDrawing={finishDrawing} onCancelDrawing={() => setDrawingPoints([])} />}
    <div className="map-column">
      <div className="map-canvas-shell">
        <button type="button" className={`map-edit-mode-cycle ${editorMode}`} onClick={cycleEditorMode} title="지도 작업 모드 전환">{modeLabels[editorMode]}</button>
        <div className="map-editor-notice">{notice}{!generated && <button type="button" onClick={onOpenGenerator}>지도 생성</button>}</div><MapViewport project={project} map={map} layers={layers} activeTool={activeTool} selectedLocationId={selectedLocationId} selectedEventId={selectedEventId} selectedPlaceNameId={selectedPlaceNameId} onMapClick={handleMapClick} onCursorMove={setCursor} draftPoints={displayedDraftPoints} draftTool={activeTool} brushRadius={brushRadius} environmentOpacity={environmentOpacity} onViewScaleChange={setViewScale} />
        <div className="map-pointer-readouts"><div className="map-coordinate-readout">{coordinateLabel}</div>{environmentPointerLabel && <div className="map-environment-readout">{environmentPointerLabel}</div>}</div><div className="map-floating-buttons"><button type="button" className={overlay === "layers" ? "active" : ""} title="레이어 표시" onClick={() => setOverlay((value) => value === "layers" ? null : "layers")}>☷</button><button type="button" className={overlay === "info" ? "active" : ""} title="지도·요소 정보" onClick={() => setOverlay((value) => value === "info" ? null : "info")}>ⓘ</button></div>
        {overlay && <aside className={`map-floating-panel ${overlay}`}><div className="floating-panel-actions">{overlay === "info" && (selectedLocationId || selectedEventId) && <button type="button" className="floating-panel-edit" title="속성 편집" aria-label="속성 편집" onClick={() => setInspectorMode("edit")}>✎</button>}<button type="button" className="floating-panel-close" title="닫기" aria-label="닫기" onClick={() => setOverlay(null)}>×</button></div>{overlay === "layers" ? <LayerPanel layers={layers} precision={map.timeline.precision} onChange={setLayers} environmentOpacity={environmentOpacity} onEnvironmentOpacityChange={setEnvironmentOpacity} /> : <Inspector project={project} map={map} selectedLocationId={selectedLocationId} selectedEventId={selectedEventId} selectedPlaceNameId={selectedPlaceNameId} mode={inspectorMode} onModeChange={setInspectorMode} onOpenWiki={onOpenWikiEntity} onLocationSave={updateLocation} onDeleteLocation={removeLocation} onHardDeleteLocation={hardDeleteLocation} onEventSave={updateEvent} onPlaceNameSave={updatePlaceName} onDeletePlaceName={deletePlaceName} />}</aside>}
        <div className="map-hud-stack">
          {generated && environmentLegend && activeEnvironmentLayer && <aside className={`environment-legend ${legendCollapsed ? "collapsed" : ""}`}><button type="button" onClick={() => setLegendCollapsed((value) => !value)}>{legendCollapsed ? "범례 펼치기" : climateLayerLabel(map.timeline.precision, activeEnvironmentLayer)}</button>{!legendCollapsed && <div className="gradient-legend"><div className="gradient-strip" style={{ background: legendMeta[activeEnvironmentLayer].gradient }} /><div className="gradient-values"><span>{environmentLegend.min.toFixed(["precipitation", "snowfall", "evapotranspiration", "humidity", "soilMoisture"].includes(activeEnvironmentLayer) ? 0 : 1)}{environmentLegend.unit}</span><span>{environmentLegend.max.toFixed(["precipitation", "snowfall", "evapotranspiration", "humidity", "soilMoisture"].includes(activeEnvironmentLayer) ? 0 : 1)}{environmentLegend.unit}</span></div></div>}</aside>}
          <aside className="map-scale-bar" aria-label={`지도 축척 ${scaleBar.label}`}><div className="scale-rule" style={{ width: `${scaleBar.pixels}px` }} /><span>{scaleBar.label}</span></aside>
        </div>
      </div></div>
  </section>;
}
