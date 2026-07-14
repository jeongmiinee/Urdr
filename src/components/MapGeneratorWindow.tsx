import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import {
  defaultGeneratorSettings,
  generatedAtYear,
  type GeneratedMapData,
  type GeneratorSettings,
  type LocalRegionType,
  type MapShapePreset,
  type ClimatePreset,
  type Season,
  type MapData,
  type MapGenerationScope,
  MAP_SCALE_RANGES,
  type MapScaleMode,
  type BoundarySide,
  type BoundarySegment,
  type GuidedFeatureSetting,
  type Point,
  type SimulationMode,
} from "../model/world";
import { rescaleMapWorld } from "../model/worldScale";
import { GeneratedMapPreview } from "./GeneratedMapPreview";
import type { GeneratedPreviewRaster } from "../generator/previewRaster";
import {
  CLIMATE_PRESET_DEFINITIONS,
  climateAnnualTemperatureRange,
  climateDefinition,
} from "../generator/climatePresets";

type Props = {
  map: MapData;
  onApply: (generated: GeneratedMapData) => void;
  onMapChange: (map: MapData) => void;
  onOpenMap: () => void;
};

type GenerationTaskResult = { generated: GeneratedMapData; preview: GeneratedPreviewRaster | null };

type GenerationTask = {
  promise: Promise<GenerationTaskResult>;
  cancel: () => void;
};

let generationRequestSequence = 0;

function normalizeResolution(value: number | undefined, fallback: number): GeneratorSettings["analysisResolution"] {
  const allowed = [64, 128, 256, 512, 1024, 2048];
  const target = Number.isFinite(value) ? Number(value) : fallback;
  return allowed.reduce((best, item) => Math.abs(item - target) < Math.abs(best - target) ? item : best, fallback) as GeneratorSettings["analysisResolution"];
}

function normalizeGeneratorSettings(source?: Partial<GeneratorSettings> | null): GeneratorSettings {
  const defaults = defaultGeneratorSettings();
  const value = source ?? {};
  return {
    ...defaults,
    ...value,
    cornerWinds: {
      northWest: { ...defaults.cornerWinds.northWest, ...(value.cornerWinds?.northWest ?? {}) },
      northEast: { ...defaults.cornerWinds.northEast, ...(value.cornerWinds?.northEast ?? {}) },
      southWest: { ...defaults.cornerWinds.southWest, ...(value.cornerWinds?.southWest ?? {}) },
      southEast: { ...defaults.cornerWinds.southEast, ...(value.cornerWinds?.southEast ?? {}) },
    },
    localBoundary: {
      north: value.localBoundary?.north?.length ? value.localBoundary.north : defaults.localBoundary.north,
      east: value.localBoundary?.east?.length ? value.localBoundary.east : defaults.localBoundary.east,
      south: value.localBoundary?.south?.length ? value.localBoundary.south : defaults.localBoundary.south,
      west: value.localBoundary?.west?.length ? value.localBoundary.west : defaults.localBoundary.west,
    },
    mountainGuide: { ...defaults.mountainGuide, ...(value.mountainGuide ?? {}), path: [...(value.mountainGuide?.path ?? defaults.mountainGuide.path)] },
    riverGuide: { ...defaults.riverGuide, ...(value.riverGuide ?? {}), path: [...(value.riverGuide?.path ?? defaults.riverGuide.path)] },
    gridWidth: normalizeResolution(value.gridWidth, defaults.gridWidth),
    gridHeight: normalizeResolution(value.gridHeight, defaults.gridHeight),
    analysisResolution: normalizeResolution(value.analysisResolution, defaults.analysisResolution),
    renderResolution: normalizeResolution(value.renderResolution, defaults.renderResolution),
    worldCoordinateScale: Math.max(0.25, Math.min(16, Number(value.worldCoordinateScale ?? defaults.worldCoordinateScale))),
    climateReferenceLatitudeDeg: Number(value.climateReferenceLatitudeDeg ?? value.latitudeDeg ?? defaults.climateReferenceLatitudeDeg),
    latitudeDeg: Number(value.climateReferenceLatitudeDeg ?? value.latitudeDeg ?? defaults.climateReferenceLatitudeDeg),
  };
}

function runGenerationTask(
  rawSettings: GeneratorSettings,
  width: number,
  height: number,
  quality: "preview" | "final",
  onProgress?: (message: string) => void,
): GenerationTask {
  const settings = normalizeGeneratorSettings(rawSettings);
  const requestId = ++generationRequestSequence;
  let settled = false;
  let posted = false;
  let readyTimeoutId: number | undefined;
  let generationTimeoutId: number | undefined;
  let worker: Worker | null = null;
  let rejectTask: ((reason?: unknown) => void) | null = null;

  const cleanup = () => {
    if (readyTimeoutId !== undefined) window.clearTimeout(readyTimeoutId);
    if (generationTimeoutId !== undefined) window.clearTimeout(generationTimeoutId);
    readyTimeoutId = undefined;
    generationTimeoutId = undefined;
    worker?.terminate();
    worker = null;
  };

  const promise = new Promise<GenerationTaskResult>((resolve, reject) => {
    rejectTask = reject;
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(message));
    };
    const postRequest = () => {
      if (settled || posted || !worker) return;
      posted = true;
      if (readyTimeoutId !== undefined) window.clearTimeout(readyTimeoutId);
      readyTimeoutId = undefined;
      onProgress?.("지도 생성 워커가 준비되었습니다. 설정을 전달하는 중…");
      try {
        // React 상태나 이전 저장 데이터에 비직렬화 값이 섞여도 Worker 전송이 멈추지 않게
        // 순수 데이터 스냅샷만 전달한다.
        const settingsSnapshot = JSON.parse(JSON.stringify(settings)) as GeneratorSettings;
        worker.postMessage({ type: "generate", requestId, settings: settingsSnapshot, width, height, quality });
      } catch (error) {
        fail(`지도 생성 설정을 Worker에 전달하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      generationTimeoutId = window.setTimeout(
        () => fail(quality === "preview"
          ? "미리보기 생성 시간이 초과되었습니다. 해상도를 낮추거나 다시 시도해 주세요."
          : "최종 지도 생성 시간이 초과되었습니다. 분석 해상도를 낮춘 뒤 다시 시도해 주세요."),
        quality === "preview" ? 45_000 : 600_000,
      );
    };

    try {
      onProgress?.("지도 생성 워커를 시작하는 중…");
      worker = new Worker(new URL("../workers/mapGeneratorWorker.ts", import.meta.url), {
        type: "module",
        name: `world-archive-map-${quality}-${requestId}`,
      });
      worker.onmessage = (event: MessageEvent<{
        type?: "ready" | "accepted" | "progress" | "result" | "error";
        requestId?: number;
        message?: string;
        generated?: GeneratedMapData;
        preview?: GeneratedPreviewRaster;
        error?: string;
      }>) => {
        const data = event.data;
        if (settled) return;
        if (data.type === "ready") {
          postRequest();
          return;
        }
        if (data.requestId !== requestId) return;
        if (data.type === "accepted") {
          onProgress?.(quality === "preview"
            ? "설정 수신 완료 · 저해상도 미리보기를 계산하는 중…"
            : "설정 수신 완료 · 고해상도 지도를 계산하는 중…");
          return;
        }
        if (data.type === "progress") {
          if (data.message) onProgress?.(data.message);
          return;
        }
        if (data.type === "error") {
          fail(data.error ?? "지도 생성 Worker에서 오류가 발생했습니다.");
          return;
        }
        if (data.type === "result" && data.generated) {
          settled = true;
          const result = data.generated;
          const preview = data.preview ?? null;
          cleanup();
          resolve({ generated: result, preview });
        }
      };
      worker.onerror = (event) => {
        event.preventDefault?.();
        fail(`지도 생성 Worker를 불러오지 못했습니다: ${event.message || "알 수 없는 스크립트 오류"}`);
      };
      worker.onmessageerror = () => fail("지도 생성 Worker의 결과 데이터를 읽지 못했습니다.");
      readyTimeoutId = window.setTimeout(
        () => fail("지도 생성 Worker가 시작되지 않았습니다. 프로그램을 다시 실행해 주세요."),
        10_000,
      );
    } catch (error) {
      fail(`지도 생성 Worker 초기화에 실패했습니다: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  return {
    promise,
    cancel: () => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectTask?.(new DOMException("지도 생성 요청이 새 요청으로 교체되었습니다.", "AbortError"));
    },
  };
}

const LOCAL_REGION_LABELS: Record<LocalRegionType, string> = {
  coast: "해안",
  inland: "내륙",
  mountain: "산맥",
  river: "강",
  island: "섬 (단일)",
  archipelago: "섬 (군도)",
};

const CONTINENT_SHAPE_OPTIONS: Array<{ value: MapShapePreset; label: string }> =
  [
    { value: "island", label: "섬형" },
    { value: "volcanic_island", label: "화산섬형" },
    { value: "closed", label: "폐쇄 지도형" },
    { value: "continent", label: "대륙형" },
    { value: "multi_continent", label: "다중 대륙형" },
    { value: "supercontinent", label: "초대륙형" },
    { value: "inland_sea", label: "내해형" },
  ];
const SEASON_LABELS: Record<Season, string> = {
  spring: "봄",
  summer: "여름",
  autumn: "가을",
  winter: "겨울",
};
const ALGORITHM_LABELS: Record<GeneratorSettings["algorithm"], string> = {
  perlin: "펄린 노이즈",
  delaunay_voronoi: "Delaunay·Voronoi",
  polygon: "폴리곤",
  mst: "Minimum Spanning Tree",
  wfc: "Wave Function Collapse",
  hybrid: "하이브리드 실험",
};

function NumberSlider({
  label,
  value,
  min,
  max,
  step,
  suffix = "",
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="slider-field">
      <span>
        <strong>{label}</strong>
        <output>
          {value}
          {suffix}
        </output>
      </span>
      <input
        type="range"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}


const BOUNDARY_SIDE_LABELS: Record<BoundarySide, string> = {
  north: "북쪽",
  east: "동쪽",
  south: "남쪽",
  west: "서쪽",
};

function boundaryPreset(segments: BoundarySegment[]): "land" | "water" | "land-water" | "water-land" {
  if (segments.length === 1) return segments[0].kind;
  return segments[0]?.kind === "water" ? "water-land" : "land-water";
}

function boundarySegments(preset: "land" | "water" | "land-water" | "water-land", split = 0.5): BoundarySegment[] {
  if (preset === "land" || preset === "water") return [{ start: 0, end: 1, kind: preset }];
  const first = preset === "land-water" ? "land" : "water";
  const second = first === "land" ? "water" : "land";
  return [
    { start: 0, end: split, kind: first },
    { start: split, end: 1, kind: second },
  ];
}

function BoundaryEditor({ settings, onChange }: { settings: GeneratorSettings; onChange: (next: GeneratorSettings["localBoundary"]) => void }) {
  return <div className="boundary-editor">
    <div className="generator-section-title">지도 경계의 육지·바다</div>
    <p className="generator-help">각 면 전체 또는 한 면 안의 육지·바다 혼합 구간을 먼저 정한 뒤 내부 해안선을 생성합니다.</p>
    {(Object.keys(BOUNDARY_SIDE_LABELS) as BoundarySide[]).map((side) => {
      const segments = settings.localBoundary[side] ?? [{ start: 0, end: 1, kind: "land" as const }];
      const preset = boundaryPreset(segments);
      const split = segments.length > 1 ? Math.round((segments[0].end ?? 0.5) * 100) : 50;
      return <div className="boundary-row" key={side}>
        <strong>{BOUNDARY_SIDE_LABELS[side]}</strong>
        <select value={preset} onChange={(event) => {
          const nextPreset = event.target.value as ReturnType<typeof boundaryPreset>;
          onChange({ ...settings.localBoundary, [side]: boundarySegments(nextPreset, split / 100) });
        }}>
          <option value="land">전체 육지</option>
          <option value="water">전체 바다</option>
          <option value="land-water">육지 → 바다</option>
          <option value="water-land">바다 → 육지</option>
        </select>
        {(preset === "land-water" || preset === "water-land") && <label className="boundary-split">
          <span>분할 {split}%</span>
          <input type="range" min={10} max={90} step={5} value={split} onChange={(event) => onChange({ ...settings.localBoundary, [side]: boundarySegments(preset, Number(event.target.value) / 100) })} />
        </label>}
      </div>;
    })}
  </div>;
}

function GuideEditor({ label, value, onChange }: { label: string; value: GuidedFeatureSetting; onChange: (value: GuidedFeatureSetting) => void }) {
  const addPoint = (event: MouseEvent<SVGSVGElement>) => {
    if (value.mode !== "drawn") return;
    const rect = event.currentTarget.getBoundingClientRect();
    const point: Point = { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) };
    onChange({ ...value, path: [...value.path, point] });
  };
  return <div className="guide-editor">
    <div className="generator-section-title">{label} 중추 경로</div>
    <div className="segmented-control">
      <button type="button" className={value.mode === "endpoints" ? "active" : ""} onClick={() => onChange({ ...value, mode: "endpoints" })}>시작·끝 자동 연결</button>
      <button type="button" className={value.mode === "drawn" ? "active" : ""} onClick={() => onChange({ ...value, mode: "drawn" })}>직접 그리기</button>
    </div>
    {value.mode === "endpoints" ? <div className="guide-endpoints-grid">
      <label>시작 면<select value={value.startSide} onChange={(event) => onChange({ ...value, startSide: event.target.value as BoundarySide })}>{Object.entries(BOUNDARY_SIDE_LABELS).map(([side, text]) => <option key={side} value={side}>{text}</option>)}</select></label>
      <label>시작 위치<input type="range" min={0} max={1} step={0.05} value={value.startOffset} onChange={(event) => onChange({ ...value, startOffset: Number(event.target.value) })} /></label>
      <label>종료 면<select value={value.endSide} onChange={(event) => onChange({ ...value, endSide: event.target.value as BoundarySide })}>{Object.entries(BOUNDARY_SIDE_LABELS).map(([side, text]) => <option key={side} value={side}>{text}</option>)}</select></label>
      <label>종료 위치<input type="range" min={0} max={1} step={0.05} value={value.endOffset} onChange={(event) => onChange({ ...value, endOffset: Number(event.target.value) })} /></label>
    </div> : <>
      <svg className="guide-drawing-pad" viewBox="0 0 320 160" onClick={addPoint} role="img" aria-label={`${label} 중추 경로 직접 그리기`}>
        <rect x="1" y="1" width="318" height="158" rx="8" className="guide-pad-bg" />
        {value.path.length > 1 && <polyline points={value.path.map((point) => `${point.x * 320},${point.y * 160}`).join(" ")} className="guide-pad-line" />}
        {value.path.map((point, index) => <circle key={`${point.x}-${point.y}-${index}`} cx={point.x * 320} cy={point.y * 160} r="4" className="guide-pad-point" />)}
      </svg>
      <button type="button" className="secondary-button" onClick={() => onChange({ ...value, path: [] })}>직접 경로 지우기</button>
    </>}
    <label className="slider-field"><span><strong>중추 폭</strong><output>{Math.round(value.width * 100)}%</output></span><input type="range" min={0.01} max={0.28} step={0.01} value={value.width} onChange={(event) => onChange({ ...value, width: Number(event.target.value) })} /></label>
    <label className="slider-field"><span><strong>굴곡·분기</strong><output>{Math.round(value.branchiness * 100)}%</output></span><input type="range" min={0} max={1} step={0.05} value={value.branchiness} onChange={(event) => onChange({ ...value, branchiness: Number(event.target.value) })} /></label>
  </div>;
}

function CornerWindEditor({ settings, onChange }: { settings: GeneratorSettings; onChange: (value: GeneratorSettings["cornerWinds"]) => void }) {
  const labels: Record<keyof GeneratorSettings["cornerWinds"], string> = { northWest: "북서", northEast: "북동", southWest: "남서", southEast: "남동" };
  return <div className="corner-wind-editor">
    <div className="generator-section-title">모서리별 풍향·풍속</div>
    <p className="generator-help">네 모서리의 바람 벡터를 지도 내부에서 부드럽게 보간해 강수와 비그늘을 계산합니다.</p>
    <div className="corner-wind-grid">{(Object.keys(labels) as Array<keyof typeof labels>).map((key) => {
      const wind = settings.cornerWinds[key];
      return <fieldset key={key}><legend>{labels[key]}</legend>
        <label>풍향<input type="number" min={0} max={359} step={5} value={Math.round(wind.directionDeg)} onChange={(event) => onChange({ ...settings.cornerWinds, [key]: { ...wind, directionDeg: Number(event.target.value) } })} /><span>°</span></label>
        <label>풍속<input type="number" min={0.5} max={30} step={0.5} value={wind.speed} onChange={(event) => onChange({ ...settings.cornerWinds, [key]: { ...wind, speed: Number(event.target.value) } })} /><span>m/s</span></label>
      </fieldset>;
    })}</div>
  </div>;
}

function RealisticMapGeneratorWindow({
  map,
  onApply,
  onMapChange,
  onOpenMap,
}: Props) {
  const currentGenerated = generatedAtYear(map);
  const initial = useMemo<GeneratorSettings>(
    () => normalizeGeneratorSettings({
      ...(currentGenerated?.settings ?? {}),
      mapScope: map.scaleMode,
      mapScaleKm: map.physicalWidthKm,
      seaLevel: currentGenerated?.seaLevel ?? currentGenerated?.settings.seaLevel ?? 0,
    }),
    [map.id, map.timeline.currentYear, map.scaleMode, map.physicalWidthKm],
  );
  const [settings, setSettings] = useState<GeneratorSettings>(initial);
  const [generated, setGenerated] = useState<GeneratedMapData | null>(
    currentGenerated,
  );
  const [previewRaster, setPreviewRaster] = useState<GeneratedPreviewRaster | null>(null);
  const [showContours, setShowContours] = useState(true);
  const [showCoastline, setShowCoastline] = useState(false);
  const [status, setStatus] = useState(
    currentGenerated
      ? `${map.timeline.currentYear}년에 확정된 생성 결과입니다.`
      : `${map.timeline.currentYear}년 지도 미리보기를 준비합니다.`,
  );
  const [isFinalizing, setIsFinalizing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const [advancedOpen, setAdvancedOpen] = useState(() => {
    try { return window.localStorage.getItem("world-archive:map-generator-advanced") === "open"; }
    catch { return false; }
  });
  const generationToken = useRef(0);

  const toggleAdvanced = (open: boolean) => {
    setAdvancedOpen(open);
    try { window.localStorage.setItem("world-archive:map-generator-advanced", open ? "open" : "closed"); } catch { /* 저장 불가 환경에서는 현재 세션만 유지 */ }
  };

  const update = <K extends keyof GeneratorSettings>(
    key: K,
    value: GeneratorSettings[K],
  ) => setSettings((previous) => ({ ...previous, [key]: value }));

  const updateWorldCoordinateScale = (nextScale: number) => {
    const safeScale = Math.max(0.25, Math.min(16, Math.round(nextScale * 4) / 4));
    const currentScale = Math.max(0.25, settings.worldCoordinateScale ?? 1);
    const baseWidth = map.width / currentScale;
    const baseHeight = map.height / currentScale;
    setSettings((previous) => ({ ...previous, worldCoordinateScale: safeScale }));
    onMapChange(
      rescaleMapWorld(
        map,
        baseWidth * safeScale,
        baseHeight * safeScale,
        safeScale,
      ),
    );
  };

  const recordSeed = (nextSettings: GeneratorSettings) => {
    const record = {
      seed: nextSettings.seed,
      settings: { ...nextSettings },
      usedAt: new Date().toISOString(),
    };
    const history = [
      record,
      ...map.generatorSeedHistory.filter((item) => item.seed !== record.seed),
    ].slice(0, 4);
    onMapChange({ ...map, generatorSeedHistory: history });
  };

  useEffect(() => {
    const applied = generatedAtYear(map);
    const nextSettings = normalizeGeneratorSettings({
      ...(applied?.settings ?? {}),
      mapScope: map.scaleMode,
      mapScaleKm: map.physicalWidthKm,
      seaLevel: applied?.seaLevel ?? applied?.settings.seaLevel ?? 0,
    });
    setSettings(nextSettings);
    setGenerated(applied);
    setPreviewRaster(null);
    setStatus(
      applied
        ? `${map.timeline.currentYear}년에 확정된 생성 결과입니다.`
        : `${map.timeline.currentYear}년 지도 미리보기를 준비합니다.`,
    );
  }, [map.id, map.timeline.currentYear]);

  useEffect(() => {
    const token = ++generationToken.current;
    let task: GenerationTask | null = null;
    setPreviewError(null);
    setStatus("설정 변경을 지도 생성 워커에 전달하는 중…");
    const timer = window.setTimeout(() => {
      task = runGenerationTask(settings, map.width, map.height, "preview", setStatus);
      void task.promise.then(({ generated: result, preview }) => {
        if (token !== generationToken.current) return;
        setGenerated(result);
        setPreviewRaster(preview);
        setPreviewError(null);
        const scopeStatus =
          result.settings.mapScope === "continent" ||
          result.settings.mapScope === "world"
            ? `독립 대륙 ${result.actualContinentCount}개`
            : `${LOCAL_REGION_LABELS[result.settings.localRegionType]} 정밀 지도`;
        const riverStatus = result.rivers.length
          ? ` · 하천 ${result.rivers.length.toLocaleString()}구간`
          : "";
        setStatus(
          `미리보기 계산 완료 · ${scopeStatus} · 해안선 ${result.coastline.length.toLocaleString()}구간${riverStatus} · 화면에 표시하는 중…`,
        );
      }).catch((error) => {
        if (token !== generationToken.current || (error instanceof DOMException && error.name === "AbortError")) return;
        const message = error instanceof Error ? error.message : "미리보기 생성에 실패했습니다.";
        setPreviewError(message);
        setStatus(message);
      });
    }, 360);
    return () => {
      window.clearTimeout(timer);
      task?.cancel();
    };
  }, [settings, map.width, map.height, retryNonce]);

  const handlePreviewRendered = useCallback(() => {
    setPreviewError(null);
    setStatus((current) => current.replace(" · 화면에 표시하는 중…", " · 표시 완료"));
  }, []);

  const handlePreviewRenderError = useCallback((message: string) => {
    const detail = `미리보기 표시 실패: ${message}`;
    setPreviewError(detail);
    setStatus(detail);
  }, []);

  const changeScope = (mapScope: MapScaleMode) => {
    const range = MAP_SCALE_RANGES[mapScope];
    setSettings((previous) => {
      const localLike = mapScope === "local" || mapScope === "regional";
      return {
        ...previous,
        mapScope,
        mapScaleKm: range.defaultWidth,
        continentCount:
          mapScope === "world"
            ? Math.max(3, previous.continentCount)
            : localLike
              ? 1
              : Math.max(1, previous.continentCount),
        landRatio: localLike
          ? 0.72
          : Math.min(previous.landRatio, mapScope === "world" ? 0.46 : 0.58),
        coastlineDetail: localLike
          ? Math.max(previous.coastlineDetail, 0.72)
          : previous.coastlineDetail,
        contourInterval: localLike
          ? Math.min(previous.contourInterval, mapScope === "local" ? 50 : 100)
          : Math.max(previous.contourInterval, 200),
      };
    });
    onMapChange({
      ...map,
      scaleMode: mapScope,
      physicalWidthKm: range.defaultWidth,
    });
  };

  const randomizeSeed = () => {
    const next = {
      ...settings,
      seed: Math.floor(Math.random() * 2_000_000_000),
    };
    setSettings(next);
    recordSeed(next);
  };

  const useSeedRecord = (index: number) => {
    const record = map.generatorSeedHistory[index];
    if (!record) return;
    setSettings(normalizeGeneratorSettings({
      ...record.settings,
      seed: record.seed,
    }));
  };

  const finalize = () => {
    if (isFinalizing) return;
    const renderResolution = settings.renderResolution ?? 2048;
    const analysisResolution = settings.analysisResolution ?? 1024;
    if (
      analysisResolution >= 2048 &&
      !window.confirm(
        `계산 격자 ${analysisResolution}은(는) 많은 메모리와 CPU를 사용합니다. Windows 11 64비트 환경에서 다른 대형 프로그램을 닫고 진행하는 것을 권장합니다. 계속할까요?`,
      )
    )
      return;
    setIsFinalizing(true);
    setStatus("고해상도 지형·침식·수계·등고선을 지도 생성 워커에서 최종 계산하고 있습니다…");
    const task = runGenerationTask(settings, map.width, map.height, "final", setStatus);
    void task.promise.then(({ generated: finalMap, preview }) => {
      setGenerated(finalMap);
      setPreviewRaster(preview);
      onApply(finalMap);
      setStatus(
        `${map.timeline.currentYear}년 지도 확정 완료 · 렌더 ${finalMap.renderWidth}×${finalMap.renderHeight} · 계산 ${finalMap.gridWidth}×${finalMap.gridHeight} · 하천 ${finalMap.rivers.length.toLocaleString()}구간 · 품질 ${finalMap.qualityScore}점`,
      );
    }).catch((error) => {
      setStatus(error instanceof Error ? error.message : "지도 확정에 실패했습니다.");
    }).finally(() => setIsFinalizing(false));
  };

  return (
    <section className="generator-window">
      <aside className="generator-controls">
        <div className="window-heading">
          <p className="eyebrow">PROCEDURAL MAP</p>
          <h2>절차형 지도 생성기</h2>
          <p>
            설정은 저해상도 미리보기에 즉시 반영되고, 지도 확정 시 고품질로 다시
            계산됩니다.
          </p>
        </div>
        <div
          className="generation-scope-switch four"
          role="group"
          aria-label="지도 생성 범위"
        >
          {(Object.keys(MAP_SCALE_RANGES) as MapScaleMode[]).map((mode) => (
            <button
              type="button"
              key={mode}
              className={settings.mapScope === mode ? "active" : ""}
              onClick={() => changeScope(mode)}
            >
              <strong>{MAP_SCALE_RANGES[mode].label}</strong>
              <span>
                {MAP_SCALE_RANGES[mode].min.toLocaleString()}–
                {MAP_SCALE_RANGES[mode].max.toLocaleString()}km
              </span>
            </button>
          ))}
        </div>
        {(settings.mapScope === "local" || settings.mapScope === "regional") && <>
          <label className="field-row">
            <span>지역 유형</span>
            <select value={settings.localRegionType} onChange={(event) => update("localRegionType", event.target.value as LocalRegionType)}>
              {Object.entries(LOCAL_REGION_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
            <small>지방·지역 지도는 대륙 골격·판 구조·전역 해수면 판정 없이 경계 조건과 중추 경로로 생성됩니다.</small>
          </label>
          {settings.localRegionType === "coast" && <BoundaryEditor settings={settings} onChange={(value) => update("localBoundary", value)} />}
          {settings.localRegionType === "mountain" && <GuideEditor label="산맥" value={settings.mountainGuide} onChange={(value) => update("mountainGuide", value)} />}
          {settings.localRegionType === "river" && <GuideEditor label="강" value={settings.riverGuide} onChange={(value) => update("riverGuide", value)} />}
          {settings.localRegionType === "archipelago" && <NumberSlider label="군도 섬 개수" value={settings.islandCount} min={2} max={64} step={1} suffix="개" onChange={(value) => update("islandCount", value)} />}
        </>}
        {(settings.mapScope === "continent" || settings.mapScope === "world") && <label className="field-row">
          <span>대륙 골자 생성 알고리즘</span>
          <select value={settings.algorithm} onChange={(event) => update("algorithm", event.target.value as GeneratorSettings["algorithm"])}>
            {Object.entries(ALGORITHM_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <small>대륙·세계 지도에서만 골자와 판 구조를 계산합니다.</small>
        </label>}
        {(settings.mapScope === "continent" ||
          settings.mapScope === "world") && (
          <label className="field-row">
            <span>지도 형태</span>
            <select
              value={settings.mapShape}
              onChange={(event) =>
                update("mapShape", event.target.value as MapShapePreset)
              }
            >
              {CONTINENT_SHAPE_OPTIONS.map(({ value, label }) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <small>
              지도 형태는 육지·바다 골격만 결정하며, 실제 고도는 골자 기복과 판
              활동을 결합해 생성합니다.
            </small>
          </label>
        )}
        <NumberSlider
          label="실제 지도 폭"
          value={Math.round(settings.mapScaleKm)}
          min={MAP_SCALE_RANGES[settings.mapScope].min}
          max={MAP_SCALE_RANGES[settings.mapScope].max}
          step={
            settings.mapScope === "local"
              ? 1
              : settings.mapScope === "regional"
                ? 10
                : 100
          }
          suffix="km"
          onChange={(value) => {
            update("mapScaleKm", value);
            onMapChange({ ...map, physicalWidthKm: value });
          }}
        />
        <div className="seed-input-section">
          <label className="field-row">
            <span>시드</span>
            <div className="inline-control">
              <input
                type="number"
                value={settings.seed}
                onChange={(event) => update("seed", Number(event.target.value))}
              />
              <button type="button" onClick={randomizeSeed}>
                무작위
              </button>
            </div>
          </label>
        </div>
        <details
          className="generator-advanced-settings"
          open={advancedOpen}
          onToggle={(event) => toggleAdvanced(event.currentTarget.open)}
        >
          <summary>고급 설정</summary>
          <div className="generator-advanced-grid">
            <label>
              <span>렌더 해상도 가로축</span>
              <select
                value={settings.renderResolution ?? 2048}
                onChange={(event) => update("renderResolution", Number(event.target.value) as GeneratorSettings["renderResolution"])}
              >
                {[64, 128, 256, 512, 1024, 2048].map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </label>
            <label>
              <span>분석·계산 격자 가로축</span>
              <select
                value={settings.analysisResolution ?? 1024}
                onChange={(event) => update("analysisResolution", Number(event.target.value) as GeneratorSettings["analysisResolution"])}
              >
                {[64, 128, 256, 512, 1024, 2048].map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </label>
            <label>
              <span>worldWidth/Height 배율</span>
              <select value={settings.worldCoordinateScale ?? 1} onChange={(event) => updateWorldCoordinateScale(Number(event.target.value))}>
                {[0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16].map((value) => <option key={value} value={value}>{value}×</option>)}
              </select>
            </label>
          </div>
        </details>
        {map.generatorSeedHistory.length > 0 && (
          <div className="seed-history">
            <span>최근 시드</span>
            {map.generatorSeedHistory.slice(0, 4).map((record, index) => (
              <button
                type="button"
                key={`${record.seed}-${index}`}
                onClick={() => useSeedRecord(index)}
              >
                <strong>{record.seed}</strong>
                <small>
                  {ALGORITHM_LABELS[record.settings.algorithm] ?? "레거시"}
                </small>
              </button>
            ))}
          </div>
        )}
        {(settings.mapScope === "continent" ||
          settings.mapScope === "world") && (
          <NumberSlider
            label="독립 대륙 수"
            value={settings.continentCount}
            min={1}
            max={8}
            step={1}
            onChange={(value) => update("continentCount", value)}
          />
        )}
        <NumberSlider
          label={
            settings.mapScope === "continent" || settings.mapScope === "world"
              ? "육지 비율"
              : "육지·고지 비율"
          }
          value={Math.round(settings.landRatio * 100)}
          min={20}
          max={
            settings.mapScope === "continent" || settings.mapScope === "world"
              ? 68
              : 95
          }
          step={1}
          suffix="%"
          onChange={(value) => update("landRatio", value / 100)}
        />
        <NumberSlider
          label="해안·지표 복잡도"
          value={Math.round(settings.coastlineDetail * 100)}
          min={0}
          max={100}
          step={1}
          suffix="%"
          onChange={(value) => update("coastlineDetail", value / 100)}
        />
        <NumberSlider
          label="산악도"
          value={Math.round(settings.mountainStrength * 100)}
          min={0}
          max={100}
          step={1}
          suffix="%"
          onChange={(value) => update("mountainStrength", value / 100)}
        />
        <NumberSlider
          label="노이즈 강도"
          value={Math.round(settings.noiseStrength * 100)}
          min={0}
          max={100}
          step={1}
          suffix="%"
          onChange={(value) => update("noiseStrength", value / 100)}
        />
        <NumberSlider
          label="대륙 동적성"
          value={Math.round(settings.continentDynamics * 100)}
          min={0}
          max={100}
          step={1}
          suffix="%"
          onChange={(value) => update("continentDynamics", value / 100)}
        />
        <NumberSlider
          label="골자 부분 보정"
          value={settings.skeletonRepairPasses}
          min={0}
          max={4}
          step={1}
          suffix="회"
          onChange={(value) => update("skeletonRepairPasses", value)}
        />
        {settings.algorithm === "hybrid" && (
          <>
            <div className="generator-section-title">하이브리드 실험 설정</div>
            <NumberSlider
              label="WFC 매크로 위상"
              value={Math.round(settings.hybridWfcStrength * 100)}
              min={0}
              max={100}
              step={1}
              suffix="%"
              onChange={(value) => update("hybridWfcStrength", value / 100)}
            />
            <NumberSlider
              label="MST 추가 연결"
              value={Math.round(settings.hybridExtraEdgeRatio * 100)}
              min={0}
              max={60}
              step={1}
              suffix="%"
              onChange={(value) => update("hybridExtraEdgeRatio", value / 100)}
            />
            <NumberSlider
              label="펄린 왜곡"
              value={Math.round(settings.hybridPerlinWarp * 100)}
              min={0}
              max={100}
              step={1}
              suffix="%"
              onChange={(value) => update("hybridPerlinWarp", value / 100)}
            />
            <NumberSlider
              label="폴리곤 세분화"
              value={Math.round(settings.hybridPolygonRefinement * 10) / 10}
              min={0}
              max={3}
              step={0.5}
              suffix="단계"
              onChange={(value) => update("hybridPolygonRefinement", value)}
            />
          </>
        )}
        <NumberSlider
          label="해안 평활도"
          value={Math.round(settings.coastSmoothness * 100)}
          min={0}
          max={100}
          step={1}
          suffix="%"
          onChange={(value) => update("coastSmoothness", value / 100)}
        />
        <NumberSlider
          label="해수면 높이"
          value={settings.seaLevel}
          min={-1500}
          max={1500}
          step={50}
          suffix="m"
          onChange={(value) => update("seaLevel", value)}
        />
        <NumberSlider
          label="침식 강도"
          value={Math.round(settings.erosion * 100)}
          min={0}
          max={100}
          step={1}
          suffix="%"
          onChange={(value) => update("erosion", value / 100)}
        />
        <div className="generator-section-title">환경·기후</div>
        <label className="field-row">
          <span>지역 배경기후</span>
          <select
            value={settings.climatePreset}
            onChange={(event) => {
              const climatePreset = event.target.value as ClimatePreset;
              const defaults = climateDefinition(climatePreset);
              setSettings((previous) =>
                climatePreset === "custom"
                  ? { ...previous, climatePreset }
                  : {
                      ...previous,
                      climatePreset,
                      latitudeDeg: defaults.referenceLatitude,
                      climateReferenceLatitudeDeg: defaults.referenceLatitude,
                      baseTemperatureC: defaults.temperature,
                      basePrecipitationMm: defaults.precipitation,
                      baseHumidity: defaults.humidity,
                      prevailingWindSpeed: defaults.windSpeed,
                      annualTemperatureRangeC:
                        climateAnnualTemperatureRange(climatePreset),
                      temperature: defaults.temperatureCorrection,
                      moisture: defaults.moistureCorrection,
                    },
              );
            }}
          >
            {Array.from(
              new Set(
                CLIMATE_PRESET_DEFINITIONS.filter(
                  (item) => item.group !== "호환",
                ).map((item) => item.group),
              ),
            ).map((group) => (
              <optgroup key={group} label={group}>
                {CLIMATE_PRESET_DEFINITIONS.filter(
                  (item) => item.group === group,
                ).map((item) => (
                  <option key={item.code} value={item.code}>
                    {item.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <small>
            쾨펜의 세부 기후형을 선택하면 기준 위도·기온·강수량·습도와 계절성이
            함께 적용됩니다.
          </small>
        </label>
        <NumberSlider
          label="지도 중심 위도"
          value={Math.round(settings.climateReferenceLatitudeDeg * 10) / 10}
          min={-85}
          max={85}
          step={0.5}
          suffix="°"
          onChange={(value) => setSettings((previous) => ({ ...previous, climateReferenceLatitudeDeg: value, latitudeDeg: value }))}
        />
        <label className="field-row">
          <span>계절</span>
          <select
            value={settings.season}
            onChange={(event) => update("season", event.target.value as Season)}
          >
            {Object.entries(SEASON_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <NumberSlider
          label="기준 기온"
          value={Math.round(settings.baseTemperatureC)}
          min={-35}
          max={35}
          step={1}
          suffix="°C"
          onChange={(value) => update("baseTemperatureC", value)}
        />
        <NumberSlider
          label="연교차"
          value={Math.round(settings.annualTemperatureRangeC ?? 18)}
          min={2}
          max={60}
          step={1}
          suffix="°C"
          onChange={(value) => update("annualTemperatureRangeC", value)}
        />
        <NumberSlider
          label="연·월 변동 강도"
          value={Math.round((settings.climateVariability ?? 0.55) * 100)}
          min={0}
          max={100}
          step={1}
          suffix="%"
          onChange={(value) => update("climateVariability", value / 100)}
        />
        <NumberSlider
          label="기후 지속성"
          value={Math.round((settings.climatePersistence ?? 0.72) * 100)}
          min={0}
          max={98}
          step={1}
          suffix="%"
          onChange={(value) => update("climatePersistence", value / 100)}
        />
        <NumberSlider
          label="극한 현상 빈도"
          value={Math.round((settings.extremeEventFrequency ?? 0.12) * 100)}
          min={0}
          max={50}
          step={1}
          suffix="%"
          onChange={(value) => update("extremeEventFrequency", value / 100)}
        />
        <NumberSlider
          label="기준 상대습도"
          value={Math.round(settings.baseHumidity * 100)}
          min={5}
          max={99}
          step={1}
          suffix="%"
          onChange={(value) => update("baseHumidity", value / 100)}
        />
        <NumberSlider
          label="기본 강수량"
          value={Math.round(settings.basePrecipitationMm)}
          min={50}
          max={3000}
          step={50}
          suffix="mm/년"
          onChange={(value) => update("basePrecipitationMm", value)}
        />
        {(settings.mapScope === "local" || settings.mapScope === "regional") ? <>
          <NumberSlider label="기본 풍향" value={Math.round(settings.prevailingWindDirectionDeg)} min={0} max={359} step={5} suffix="°" onChange={(value) => update("prevailingWindDirectionDeg", value)} />
          <NumberSlider label="기본 풍속" value={Math.round(settings.prevailingWindSpeed * 10) / 10} min={0.5} max={20} step={0.5} suffix="m/s" onChange={(value) => update("prevailingWindSpeed", value)} />
        </> : <CornerWindEditor settings={settings} onChange={(value) => update("cornerWinds", value)} />}
        {(settings.mapScope === "local" || settings.mapScope === "regional") &&
          settings.localRegionType === "coast" && (
            <NumberSlider
              label="조수 간만의 차"
              value={Math.round((settings.tidalRangeM ?? 2.2) * 10) / 10}
              min={0}
              max={15}
              step={0.1}
              suffix="m"
              onChange={(value) => update("tidalRangeM", value)}
            />
          )}
        <NumberSlider
          label="기후 온도 보정"
          value={Math.round(settings.temperature * 100)}
          min={-30}
          max={30}
          step={1}
          suffix="%"
          onChange={(value) => update("temperature", value / 100)}
        />
        <NumberSlider
          label="기후 습도 보정"
          value={Math.round(settings.moisture * 100)}
          min={-30}
          max={30}
          step={1}
          suffix="%"
          onChange={(value) => update("moisture", value / 100)}
        />
        <div className="generator-section-title">국가</div>
        <label className="check-field">
          <input
            type="checkbox"
            checked={settings.generateCountries}
            onChange={(event) =>
              update("generateCountries", event.target.checked)
            }
          />{" "}
          자연경계 기반 국가 자동 생성
        </label>
        {settings.generateCountries && (
          <>
            <NumberSlider
              label="국가 수"
              value={settings.countryCount}
              min={1}
              max={12}
              step={1}
              onChange={(value) => update("countryCount", value)}
            />
            <NumberSlider
              label="자연경계 의존도"
              value={Math.round(settings.naturalBorderInfluence * 100)}
              min={0}
              max={100}
              step={1}
              suffix="%"
              onChange={(value) =>
                update("naturalBorderInfluence", value / 100)
              }
            />
            <label className="check-field">
              <input
                type="checkbox"
                checked={settings.allowExclaves}
                onChange={(event) =>
                  update("allowExclaves", event.target.checked)
                }
              />{" "}
              월경지 허용
            </label>
            <NumberSlider
              label="해양국가 비율"
              value={Math.round(settings.maritimeCountryRatio * 100)}
              min={0}
              max={100}
              step={5}
              suffix="%"
              onChange={(value) => update("maritimeCountryRatio", value / 100)}
            />
            <NumberSlider
              label="유목국가 비율"
              value={Math.round(settings.nomadicCountryRatio * 100)}
              min={0}
              max={100}
              step={5}
              suffix="%"
              onChange={(value) => update("nomadicCountryRatio", value / 100)}
            />
            <NumberSlider
              label="산악국가 비율"
              value={Math.round(settings.mountainCountryRatio * 100)}
              min={0}
              max={100}
              step={5}
              suffix="%"
              onChange={(value) => update("mountainCountryRatio", value / 100)}
            />
          </>
        )}
        <label className="field-row">
          <span>등고선 간격</span>
          <select
            value={settings.contourInterval}
            onChange={(event) =>
              update("contourInterval", Number(event.target.value))
            }
          >
            <option value={50}>50m</option>
            <option value={100}>100m</option>
            <option value={200}>200m</option>
            <option value={250}>250m</option>
            <option value={500}>500m</option>
          </select>
        </label>
        <label className="field-row">
          <span>최고 고도</span>
          <select
            value={settings.maxElevation}
            onChange={(event) =>
              update("maxElevation", Number(event.target.value))
            }
          >
            <option value={3000}>3,000m</option>
            <option value={5000}>5,000m</option>
            <option value={7000}>7,000m</option>
            <option value={9000}>9,000m</option>
          </select>
        </label>
        <div className="generator-buttons">
          <button
            type="button"
            className="primary-button map-finalize-button"
            disabled={isFinalizing}
            onClick={finalize}
          >
            {isFinalizing ? "지도 확정 중…" : "지도 확정"}
          </button>
        </div>
      </aside>
      <div className="generator-stage">
        <div className={`preview-toolbar ${previewError ? "has-error" : ""}`}>
          <span>{status}</span>
          {previewError && <button type="button" className="secondary-button generator-retry-button" onClick={() => setRetryNonce((value) => value + 1)}>미리보기 다시 시도</button>}
          <div className="preview-layer-toggles">
            <label>
              <input
                type="checkbox"
                checked={showCoastline}
                onChange={(event) => setShowCoastline(event.target.checked)}
              />{" "}
              해안선 표시
            </label>
            <label>
              <input
                type="checkbox"
                checked={showContours}
                onChange={(event) => setShowContours(event.target.checked)}
              />{" "}
              등고선 표시
            </label>
          </div>
        </div>
        <GeneratedMapPreview
          data={generated}
          raster={previewRaster}
          showContours={showContours}
          showCoastline={showCoastline}
          onRendered={handlePreviewRendered}
          onRenderError={handlePreviewRenderError}
        />
        {generated && (
          <div
            className={`generation-quality ${generated.qualityScore >= 85 ? "good" : generated.qualityScore >= 65 ? "warning" : "bad"}`}
          >
            <strong>자동 검증 {generated.qualityScore}점</strong>
            {generated.qualityIssues.length > 0 ? (
              <ul>
                {generated.qualityIssues.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
            ) : (
              <span>
                수계·기후·육지 연결성 검사에서 주요 오류가 발견되지 않았습니다.
              </span>
            )}
          </div>
        )}
        <div className="generator-legend">
          <span className="ocean">해수</span>
          <span className="freshwater">담수·호수</span>
          <span className="plain">평원</span>
          <span className="mountain">암반</span>
          <span className="grass">초원</span>
          <span className="forest">숲</span>
          <span className="jungle">열대림</span>
          <span className="wetland">습지</span>
          <span className="desert">사막</span>
          <span className="snow">설원</span>
        </div>
        <button
          type="button"
          className="floating-map-button"
          onClick={onOpenMap}
        >
          지도 편집기로 이동 →
        </button>
      </div>
    </section>
  );
}

function Mapgen4FreeModeWindow({
  map,
  onOpenMap,
}: Pick<Props, "map" | "onOpenMap">) {
  const [instance, setInstance] = useState(0);
  return (
    <section className="mapgen4-free-window">
      <header className="mapgen4-free-heading">
        <div>
          <p className="eyebrow">FREE MODE · INDEPENDENT ENGINE</p>
          <h2>자유 모드 지도 생성기</h2>
          <p>
            Red Blob Games Mapgen4가 독립적으로 실행됩니다. 현실 모드의 판
            구조·침식·기후·수계 계산은 이 화면에 개입하지 않습니다.
          </p>
        </div>
        <div className="mapgen4-free-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={() => setInstance((value) => value + 1)}
          >
            초기 상태로 다시 열기
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={onOpenMap}
          >
            기존 지도 편집기 열기
          </button>
        </div>
      </header>
      <div className="mapgen4-mode-notice">
        <strong>Mapgen4 독립 파이프라인</strong>
        <span>
          바다·얕은 물·계곡·산 도구로 지형을 칠하면 Mapgen4 자체 Worker가 고도,
          지형성 강우, 비그늘, 배수망과 하천을 다시 계산하며 지도별 상태를 자동
          저장합니다.
        </span>
      </div>
      <iframe
        key={instance}
        className="mapgen4-free-frame"
        title="Red Blob Games Mapgen4 자유 모드"
        src={`./mapgen4/index.html?mapId=${encodeURIComponent(map.id)}&instance=${instance}`}
        allow="fullscreen"
      />
    </section>
  );
}

export function MapGeneratorWindow(props: Props) {
  const changeGenerationMode = (mode: SimulationMode) => {
    if (mode === props.map.generationMode) return;
    const hasGenerated = props.map.generatedStates.some((state) => Boolean(state.value));
    if (hasGenerated && !window.confirm("생성 엔진을 바꾸면 현재 지도의 확정 생성 결과가 초기화됩니다. 문명 요소는 유지되지만 지형을 다시 생성해야 합니다. 계속할까요?")) return;
    props.onMapChange({
      ...props.map,
      generationMode: mode,
      generatedStates: hasGenerated ? [] : props.map.generatedStates,
      generatorSeedHistory: hasGenerated ? [] : props.map.generatorSeedHistory,
    });
  };
  return <div className="map-generator-root">
    <div className="map-engine-switch" role="group" aria-label="지도별 생성 엔진">
      <span>이 지도의 생성 모드</span>
      <button type="button" className={props.map.generationMode === "free" ? "active" : ""} onClick={() => changeGenerationMode("free")}>자유 모드 · Mapgen4</button>
      <button type="button" className={props.map.generationMode === "realistic" ? "active" : ""} onClick={() => changeGenerationMode("realistic")}>현실 모드</button>
    </div>
    {props.map.generationMode === "free"
      ? <Mapgen4FreeModeWindow map={props.map} onOpenMap={props.onOpenMap} />
      : <RealisticMapGeneratorWindow {...props} />}
  </div>;
}
