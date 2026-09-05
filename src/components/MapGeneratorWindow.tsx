import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  MAP_SCALE_RANGES,
  type MapScaleMode,
  type BoundarySide,
  type BoundarySegment,
} from "../model/world";
import { rescaleMapWorld } from "../model/worldScale";
import { GeneratedMapPreview } from "./GeneratedMapPreview";
import {
  CLIMATE_PRESET_DEFINITIONS,
  climateAnnualTemperatureRange,
  climateDefinition,
} from "../generator/climatePresets";
import {
  countryCountSettings,
  MAX_GENERATED_COUNTRIES,
  totalCountryCount,
} from "../generator/countryGeneration";
import { useLocalization, type MessageKey } from "../localization";
import { formatNumber } from "../formatting";

type Props = {
  map: MapData;
  onApply: (generated: GeneratedMapData, preparedMap?: MapData) => void;
  onMapChange: (map: MapData) => void;
};

type GenerationTaskResult = { generated: GeneratedMapData; preparedMap?: MapData };

type GenerationTask = {
  promise: Promise<GenerationTaskResult>;
  cancel: () => void;
};

type PreparedGeneration = {
  key: string;
  task?: GenerationTask;
  result?: GenerationTaskResult;
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
  const typeCounts = countryCountSettings(value);
  const mapScope = value.mapScope ?? defaults.mapScope;
  const requestedRegionType = value.localRegionType ?? defaults.localRegionType;
  const localRegionType: LocalRegionType = requestedRegionType === "coast" || requestedRegionType === "inland"
    ? requestedRegionType
    : "inland";
  const seaLevel = Number(value.seaLevel ?? defaults.seaLevel);
  const maxElevation = Math.max(
    50,
    Math.min(20_000, Number(value.maxElevation ?? defaults.maxElevation)),
  );
  const elevationRangeM = Math.max(
    0,
    Math.min(20_000, Number(value.elevationRangeM ?? maxElevation - seaLevel + 4_200)),
  );
  return {
    ...defaults,
    ...value,
    ...typeCounts,
    mapScope,
    localRegionType,
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
    seaLevel,
    maxElevation,
    elevationRangeM,
    elevationNoiseStrength: Math.max(
      0,
      Math.min(1, Number(value.elevationNoiseStrength ?? defaults.elevationNoiseStrength)),
    ),
    settlementGenerationYear: 0,
    preserveExistingSettlements: false,
  };
}

function generationCacheKey(settings: GeneratorSettings, map: MapData): string {
  const sourceRevision = {
    id: map.id,
    width: map.width,
    height: map.height,
    modified: map.lastModifiedDate,
    year: map.timeline.currentYear,
    factions: map.factions.map((item) => [item.id, item.kind, item.activityRange, item.hasTerritory]),
    locations: map.locations.map((item) => [
      item.id,
      item.states.length,
      item.states.at(-1)?.startYear,
      item.states.at(-1)?.value.position.x,
      item.states.at(-1)?.value.position.y,
    ]),
    roads: map.roads.map((item) => [item.id, item.nodes.length]),
    territories: map.territories.map((item) => [item.id, item.states.length]),
  };
  return JSON.stringify({
    settings: normalizeGeneratorSettings(settings),
    sourceRevision,
  });
}

function runGenerationTask(
  rawSettings: GeneratorSettings,
  width: number,
  height: number,
  quality: "preview" | "final",
  onProgress?: (message: string) => void,
  sourceMap?: MapData,
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
        const placementSource = sourceMap ? { ...sourceMap, generatedStates: [] } : undefined;
        worker.postMessage({ type: "generate", requestId, settings: settingsSnapshot, width, height, quality, sourceMap: placementSource });
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
        preparedMap?: MapData;
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
          cleanup();
          resolve({ generated: result, preparedMap: data.preparedMap });
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

const VISIBLE_REALISTIC_SCOPES: MapScaleMode[] = ["local", "regional"];
const REGION_MESSAGE_KEYS: Record<LocalRegionType, MessageKey> = {
  coast: "mapGenerator.coast",
  inland: "mapGenerator.inland",
  mountain: "mapGenerator.mountain",
  river: "mapGenerator.river",
  island: "mapGenerator.island",
  archipelago: "mapGenerator.archipelago",
};

function visibleRegionTypes(mapScope: MapScaleMode): LocalRegionType[] {
  void mapScope;
  return ["coast", "inland"];
}

const CONTINENT_SHAPE_OPTIONS: Array<{ value: MapShapePreset; label: string }> =
  [
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

export function normalizeGeneratorSliderValue(
  candidate: number,
  fallback: number,
  min: number,
  max: number,
  step: number,
): number {
  const finite = Number.isFinite(candidate) ? candidate : fallback;
  const clamped = Math.max(min, Math.min(max, finite));
  const decimals = Math.max(0, (String(step).split(".")[1] ?? "").length);
  const stepped = min + Math.round((clamped - min) / step) * step;
  return Number(Math.max(min, Math.min(max, stepped)).toFixed(decimals));
}

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
  const [draftValue, setDraftValue] = useState(value);
  useEffect(() => setDraftValue(value), [value]);
  const commit = (candidate = draftValue) => {
    const next = normalizeGeneratorSliderValue(candidate, value, min, max, step);
    setDraftValue(next);
    if (next !== value) onChange(next);
  };
  return (
    <label className="slider-field">
      <strong className="slider-label">{label}</strong>
      <input
        className="slider-range"
        type="range"
        value={draftValue}
        min={min}
        max={max}
        step={step}
        aria-label={label}
        onChange={(event) => setDraftValue(Number(event.target.value))}
        onPointerUp={(event) => commit(Number(event.currentTarget.value))}
        onKeyUp={(event) => {
          if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key))
            commit(Number(event.currentTarget.value));
        }}
        onBlur={(event) => commit(Number(event.currentTarget.value))}
      />
      <span className="slider-number-input">
        <input
          type="number"
          value={draftValue}
          min={min}
          max={max}
          step={step}
          aria-label={`${label} 직접 입력`}
          onChange={(event) => setDraftValue(Number(event.target.value))}
          onBlur={(event) => commit(Number(event.currentTarget.value))}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              commit(Number(event.currentTarget.value));
            }
          }}
        />
        {suffix && <span>{suffix}</span>}
      </span>
    </label>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return <label className="number-field">
    <span>{label}</span>
    <input
      type="number"
      min={min}
      max={max}
      step={1}
      value={value}
      onChange={(event) => onChange(Math.max(min, Math.min(max, Math.trunc(Number(event.target.value) || 0))))}
    />
  </label>;
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
  const { t } = useLocalization();
  const sides = Object.keys(BOUNDARY_SIDE_LABELS) as BoundarySide[];
  const [splits, setSplits] = useState<Record<BoundarySide, number>>(() => Object.fromEntries(
    sides.map((side) => {
      const segments = settings.localBoundary[side] ?? [];
      return [side, segments.length > 1 ? Math.round((segments[0].end ?? 0.5) * 100) : 50];
    }),
  ) as Record<BoundarySide, number>);
  const order: ReturnType<typeof boundaryPreset>[] = ["land", "land-water", "water", "water-land"];
  const labels: Record<ReturnType<typeof boundaryPreset>, string> = {
    land: t("mapGenerator.land"), "land-water": t("mapGenerator.landWater"), water: t("mapGenerator.water"), "water-land": t("mapGenerator.waterLand"),
  };
  const sideLabels: Record<BoundarySide, string> = {
    north: t("mapGenerator.north"), east: t("mapGenerator.east"), south: t("mapGenerator.south"), west: t("mapGenerator.west"),
  };
  const changeSide = (side: BoundarySide, preset: ReturnType<typeof boundaryPreset>, split = splits[side]) => {
    onChange({ ...settings.localBoundary, [side]: boundarySegments(preset, split / 100) });
  };
  return <div className="boundary-editor">
    <div className="generator-section-title">{t("mapGenerator.boundaryTitle")}</div>
    <p className="generator-help">{t("mapGenerator.boundaryHelp")}</p>
    <div className="boundary-map-control" role="group" aria-label={t("mapGenerator.boundaryTitle")}>
      <div className="boundary-map-center" aria-hidden="true"><span>{t("mapGenerator.regionMap")}</span></div>
      {sides.map((side) => {
        const preset = boundaryPreset(settings.localBoundary[side] ?? [{ start: 0, end: 1, kind: "land" }]);
        const next = order[(order.indexOf(preset) + 1) % order.length];
        return <button
          type="button"
          key={side}
          className={`boundary-direction boundary-${side} state-${preset}`}
          onClick={() => changeSide(side, next)}
          aria-label={`${sideLabels[side]} ${labels[preset]}`}
          title={`${sideLabels[side]}: ${labels[preset]}`}
        ><strong>{sideLabels[side]}</strong><span>{labels[preset]}</span></button>;
      })}
    </div>
    <div className="boundary-transition-values">
      {sides.map((side) => {
        const preset = boundaryPreset(settings.localBoundary[side] ?? [{ start: 0, end: 1, kind: "land" }]);
        if (preset !== "land-water" && preset !== "water-land") return null;
        return <label key={side}>
          <span>{sideLabels[side]} {t("mapGenerator.transitionPosition")}</span>
          <input type="number" min={10} max={90} step={1} value={splits[side]} onChange={(event) => {
            const split = Math.max(10, Math.min(90, Math.trunc(Number(event.target.value) || 50)));
            setSplits((current) => ({ ...current, [side]: split }));
            changeSide(side, preset, split);
          }} />
          <small>%</small>
        </label>;
      })}
    </div>
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
}: Props) {
  const { language, t } = useLocalization();
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
  const [inputCommitRevision, setInputCommitRevision] = useState(0);
  const [advancedOpen, setAdvancedOpen] = useState(() => {
    try { return window.localStorage.getItem("world-archive:map-generator-advanced") === "open"; }
    catch { return false; }
  });
  const generationToken = useRef(0);
  const rangeInteractionRef = useRef(false);
  const preparedGenerationRef = useRef<PreparedGeneration | null>(null);
  const preparationTimerRef = useRef<number | null>(null);

  const toggleAdvanced = (open: boolean) => {
    setAdvancedOpen(open);
    try { window.localStorage.setItem("world-archive:map-generator-advanced", open ? "open" : "closed"); } catch { /* 저장 불가 환경에서는 현재 세션만 유지 */ }
  };

  const update = <K extends keyof GeneratorSettings>(
    key: K,
    value: GeneratorSettings[K],
  ) => setSettings((previous) => ({ ...previous, [key]: value }));
  const countryInputMax = (key: keyof Pick<GeneratorSettings,
    "agriculturalCountryCount" | "coastalCountryCount" | "nomadicCountryCount" | "mountainCountryCount" | "commercialCountryCount"
  >) => Math.max(0, MAX_GENERATED_COUNTRIES - totalCountryCount(settings) + settings[key]);

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
    ].slice(0, 3);
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
    setStatus(
      applied
        ? `${map.timeline.currentYear}년에 확정된 생성 결과입니다.`
        : `${map.timeline.currentYear}년 지도 미리보기를 준비합니다.`,
    );
  }, [map.id, map.timeline.currentYear]);

  useEffect(() => {
    if (rangeInteractionRef.current) return;
    const token = ++generationToken.current;
    const cacheKey = generationCacheKey(settings, map);
    let task: GenerationTask | null = null;
    if (preparationTimerRef.current !== null) {
      window.clearTimeout(preparationTimerRef.current);
      preparationTimerRef.current = null;
    }
    if (preparedGenerationRef.current?.key !== cacheKey) {
      preparedGenerationRef.current?.task?.cancel();
      preparedGenerationRef.current = null;
    }
    setPreviewError(null);
    setStatus("설정 변경을 지도 생성 워커에 전달하는 중…");
    const timer = window.setTimeout(() => {
      task = runGenerationTask(settings, map.width, map.height, "preview", setStatus);
      void task.promise.then(({ generated: result }) => {
        if (token !== generationToken.current) return;
        setGenerated(result);
        setPreviewError(null);
        const scopeStatus =
          result.settings.mapScope === "continent" ||
          result.settings.mapScope === "world"
            ? `독립 대륙 ${result.actualContinentCount}개`
            : `${LOCAL_REGION_LABELS[result.settings.localRegionType]} 정밀 지도`;
        const riverCount = result.riverGraph?.edges.filter((edge) => edge.render).length ?? 0;
        const riverStatus = riverCount
          ? ` · 하천 ${riverCount.toLocaleString()}개`
          : "";
        setStatus(
          `미리보기 계산 완료 · ${scopeStatus} · 해안선 ${result.coastline.length.toLocaleString()}구간${riverStatus} · 화면에 표시하는 중…`,
        );
        if ((settings.analysisResolution ?? 1024) >= 2048) return;
        preparationTimerRef.current = window.setTimeout(() => {
          preparationTimerRef.current = null;
          if (token !== generationToken.current) return;
          const finalTask = runGenerationTask(
            settings,
            map.width,
            map.height,
            "final",
            (message) => {
              if (token === generationToken.current) {
                setStatus(`고품질 확정 결과 준비 · ${message}`);
              }
            },
            map,
          );
          const prepared: PreparedGeneration = { key: cacheKey, task: finalTask };
          preparedGenerationRef.current = prepared;
          void finalTask.promise.then((finalResult) => {
            if (token !== generationToken.current || preparedGenerationRef.current !== prepared) return;
            prepared.task = undefined;
            prepared.result = finalResult;
            setGenerated(finalResult.generated);
            setStatus(
              `고품질 확정 결과 준비 완료 · 계산 ${finalResult.generated.gridWidth}×${finalResult.generated.gridHeight}`,
            );
          }).catch((error) => {
            if (token !== generationToken.current || preparedGenerationRef.current !== prepared) return;
            preparedGenerationRef.current = null;
            if (error instanceof DOMException && error.name === "AbortError") return;
            setStatus(`고품질 확정 결과 준비 실패 · 완료 버튼을 누르면 다시 시도합니다: ${error instanceof Error ? error.message : String(error)}`);
          });
        }, 240);
      }).catch((error) => {
        if (token !== generationToken.current || (error instanceof DOMException && error.name === "AbortError")) return;
        const message = error instanceof Error ? error.message : "미리보기 생성에 실패했습니다.";
        setPreviewError(message);
        setStatus(message);
      });
    }, 80);
    return () => {
      window.clearTimeout(timer);
      task?.cancel();
      if (preparationTimerRef.current !== null) {
        window.clearTimeout(preparationTimerRef.current);
        preparationTimerRef.current = null;
      }
      if (preparedGenerationRef.current?.key === cacheKey) {
        preparedGenerationRef.current.task?.cancel();
        preparedGenerationRef.current = null;
      }
    };
  }, [settings, map.width, map.height, map.lastModifiedDate, retryNonce, inputCommitRevision]);

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
        localRegionType: mapScope === "regional" && previous.localRegionType === "river" ? "inland" : previous.localRegionType,
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

  const applyPreparedResult = ({ generated: finalMap, preparedMap }: GenerationTaskResult) => {
    setGenerated(finalMap);
    setStatus(
      `${map.timeline.currentYear}년 지도 계산 완료 · 프로젝트에 적용하는 중`,
    );
    window.requestAnimationFrame(() => {
      try {
        onApply(finalMap, preparedMap);
        const riverCount = finalMap.riverGraph?.edges.filter((edge) => edge.render).length ?? 0;
        setStatus(`${map.timeline.currentYear}년 지도 확정 완료 · 렌더 ${finalMap.renderWidth}×${finalMap.renderHeight} · 계산 ${finalMap.gridWidth}×${finalMap.gridHeight} · 하천 ${riverCount.toLocaleString()}개`);
      } catch (error) {
        setStatus(error instanceof Error ? error.message : "완성된 지도를 프로젝트에 적용하지 못했습니다.");
      } finally {
        setIsFinalizing(false);
      }
    });
  };

  const finalize = () => {
    if (isFinalizing) return;
    const analysisResolution = settings.analysisResolution ?? 1024;
    const cacheKey = generationCacheKey(settings, map);
    const prepared = preparedGenerationRef.current?.key === cacheKey
      ? preparedGenerationRef.current
      : null;
    if (
      !prepared &&
      analysisResolution >= 2048 &&
      !window.confirm(
        `계산 격자 ${analysisResolution}은(는) 많은 메모리와 CPU를 사용합니다. Windows 11 64비트 환경에서 다른 대형 프로그램을 닫고 진행하는 것을 권장합니다. 계속할까요?`,
      )
    )
      return;
    setIsFinalizing(true);
    if (prepared?.result) {
      setStatus("준비된 고품질 결과를 프로젝트에 적용하는 중…");
      applyPreparedResult(prepared.result);
      return;
    }

    let finalPromise: Promise<GenerationTaskResult>;
    if (prepared?.task) {
      setStatus("백그라운드에서 준비 중인 고품질 결과를 이어받는 중…");
      finalPromise = prepared.task.promise;
    } else {
      setStatus("고해상도 지형·침식·수계·등고선을 지도 생성 워커에서 최종 계산하고 있습니다…");
      const task = runGenerationTask(settings, map.width, map.height, "final", setStatus, map);
      preparedGenerationRef.current = { key: cacheKey, task };
      finalPromise = task.promise;
    }
    void finalPromise.then((result) => {
      if (preparedGenerationRef.current?.key === cacheKey) {
        preparedGenerationRef.current = { key: cacheKey, result };
      }
      applyPreparedResult(result);
    }).catch((error) => {
      setStatus(error instanceof Error ? error.message : "지도 확정에 실패했습니다.");
      setIsFinalizing(false);
    });
  };

  return (
    <section className="generator-window">
      <aside
        className="generator-controls"
        onPointerDownCapture={(event) => {
          if (event.target instanceof HTMLInputElement && event.target.type === "range") rangeInteractionRef.current = true;
        }}
        onPointerUpCapture={(event) => {
          if (!(event.target instanceof HTMLInputElement) || event.target.type !== "range") return;
          rangeInteractionRef.current = false;
          setInputCommitRevision((revision) => revision + 1);
        }}
        onPointerCancelCapture={() => {
          rangeInteractionRef.current = false;
          setInputCommitRevision((revision) => revision + 1);
        }}
      >
        <div className="window-heading">
          <h2>{t("mapGenerator.title")}</h2>
          <p>{t("mapGenerator.description")}</p>
        </div>
        <div
          className="generation-scope-switch"
          role="group"
          aria-label={t("mapGenerator.scope")}
        >
          {VISIBLE_REALISTIC_SCOPES.map((mode) => (
            <button
              type="button"
              key={mode}
              className={settings.mapScope === mode ? "active" : ""}
              onClick={() => changeScope(mode)}
            >
              <strong>{t(mode === "local" ? "mapGenerator.local" : "mapGenerator.regional")}</strong>
              <span>
                {formatNumber(MAP_SCALE_RANGES[mode].min, language)}–
                {formatNumber(MAP_SCALE_RANGES[mode].max, language)}km
              </span>
            </button>
          ))}
        </div>
        {(settings.mapScope === "local" || settings.mapScope === "regional") && <>
          <label className="field-row">
            <span>{t("mapGenerator.regionType")}</span>
            <select value={settings.localRegionType} onChange={(event) => update("localRegionType", event.target.value as LocalRegionType)}>
              {visibleRegionTypes(settings.mapScope).map((value) => <option key={value} value={value}>{t(REGION_MESSAGE_KEYS[value])}</option>)}
            </select>
            <small>지방·지역 지도는 대륙 골격·판 구조·전역 해수면 판정 없이 경계 조건과 중추 경로로 생성됩니다.</small>
          </label>
          {settings.localRegionType === "coast" && <BoundaryEditor settings={settings} onChange={(value) => update("localBoundary", value)} />}
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
            {map.generatorSeedHistory.slice(0, 3).map((record, index) => (
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
          label="지형 형태 노이즈"
          value={Math.round(settings.noiseStrength * 100)}
          min={0}
          max={100}
          step={1}
          suffix="%"
          onChange={(value) => update("noiseStrength", value / 100)}
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
          국가 생성
        </label>
        {settings.generateCountries && (
          <div className="country-count-settings">
            <div className="country-count-grid">
              <NumberField label="농업국가" value={settings.agriculturalCountryCount} min={0} max={countryInputMax("agriculturalCountryCount")} onChange={(value) => update("agriculturalCountryCount", value)} />
              <NumberField label="해안국가" value={settings.coastalCountryCount} min={0} max={countryInputMax("coastalCountryCount")} onChange={(value) => update("coastalCountryCount", value)} />
              <NumberField label="유목국가" value={settings.nomadicCountryCount} min={0} max={countryInputMax("nomadicCountryCount")} onChange={(value) => update("nomadicCountryCount", value)} />
              <NumberField label="산악국가" value={settings.mountainCountryCount} min={0} max={countryInputMax("mountainCountryCount")} onChange={(value) => update("mountainCountryCount", value)} />
              <NumberField label="상업국가" value={settings.commercialCountryCount} min={0} max={countryInputMax("commercialCountryCount")} onChange={(value) => update("commercialCountryCount", value)} />
            </div>
            <p className="generator-inline-hint">총 {totalCountryCount(settings)}개 국가 · 유형별 지형 비용으로 영토를 성장시킵니다.</p>
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
          </div>
        )}
        <div className="generator-section-title">정착지</div>
        <div className="country-count-grid settlement-count-grid">
          <NumberField label="마을" value={settings.settlementVillageCount} min={0} max={200} onChange={(value) => update("settlementVillageCount", value)} />
          <NumberField label="소도시" value={settings.settlementTownCount} min={0} max={100} onChange={(value) => update("settlementTownCount", value)} />
          <NumberField label="도시" value={settings.settlementCityCount} min={0} max={60} onChange={(value) => update("settlementCityCount", value)} />
          <NumberField label="수도" value={settings.settlementCapitalCount} min={0} max={40} onChange={(value) => update("settlementCapitalCount", value)} />
        </div>
        <label className="check-field">
          <input type="checkbox" checked={settings.regenerateSettlementRoads} onChange={(event) => update("regenerateSettlementRoads", event.target.checked)} />{" "}
          정착지 도로 재생성
        </label>
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
        <NumberSlider
          label="최고 고도"
          value={settings.maxElevation}
          min={50}
          max={20000}
          step={50}
          suffix="m"
          onChange={(value) => update("maxElevation", value)}
        />
        <NumberSlider
          label="최고·최저 고도 간격"
          value={settings.elevationRangeM}
          min={0}
          max={20000}
          step={100}
          suffix="m"
          onChange={(value) => update("elevationRangeM", value)}
        />
        <div className="generator-derived-value">
          최저 고도 <strong>{settings.maxElevation - settings.elevationRangeM}m</strong>
        </div>
        <NumberSlider
          label="고도 노이즈"
          value={Math.round(settings.elevationNoiseStrength * 100)}
          min={0}
          max={100}
          step={1}
          suffix="%"
          onChange={(value) => update("elevationNoiseStrength", value / 100)}
        />
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
          showContours={showContours}
          showCoastline={showCoastline}
          onRendered={handlePreviewRendered}
          onRenderError={handlePreviewRenderError}
        />
        <div className="generator-legend">
          <span className="ocean">해수</span>
          <span className="freshwater">담수·호수</span>
          <span className="plain">평원</span>
          <span className="mountain">암반</span>
          <span className="rock">암석</span>
          <span className="grass">초원</span>
          <span className="forest">숲</span>
          <span className="jungle">열대림</span>
          <span className="wetland">습지</span>
          <span className="desert">사막</span>
          <span className="snow">설원</span>
        </div>
      </div>
    </section>
  );
}

export function MapGeneratorWindow(props: Props) {
  return <div className="map-generator-root"><RealisticMapGeneratorWindow {...props} /></div>;
}
