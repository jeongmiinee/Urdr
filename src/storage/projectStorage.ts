import {
  PROGRAM_VERSION,
  createDefaultWikiCategories,
  createEmptyProject,
  createDefaultCalendarProfile,
  defaultGeneratorSettings,
  clampMapPhysicalWidth,
  mapScaleModeForWidth,
  type GeneratedMapData,
  type Location,
  type EventCategory,
  type HistoricalDateTime,
  type MapData,
  type TemporalState,
  type WorldEvent,
  type WikiArticle,
  type WikiCategoryDefinition,
  type WorldProject,
} from "../model/world";
import { syncAutoWikiArticles } from "../model/wikiSync";
import { calculateEnvironment } from "../generator/environment";
import { normalizePowerOfTwo } from "../generator/gridTransform";

const INDEX_KEY = "world-map-editor-v0.99-index";
const LEGACY_INDEX_KEYS = [
  "world-map-editor-v0.97-index",
  "world-map-editor-v0.96-index",
  "world-map-editor-v0.95-index",
  "world-map-editor-v0.94-index",
  "world-map-editor-v0.93-index",
  "world-map-editor-v0.92-index",
  "world-map-editor-v0.91-index",
  "world-map-editor-v0.9-index",
  "world-map-editor-v0.8-index",
  "world-map-editor-v0.7-index",
  "world-map-editor-v0.6-index",
  "world-map-editor-v0.5-index",
  "world-map-editor-v0.4-index",
];
const PROJECT_PREFIX = "world-map-editor-v0.99-project-";
const LEGACY_PROJECT_PREFIXES = [
  "world-map-editor-v0.97-project-",
  "world-map-editor-v0.96-project-",
  "world-map-editor-v0.95-project-",
  "world-map-editor-v0.94-project-",
  "world-map-editor-v0.93-project-",
  "world-map-editor-v0.92-project-",
  "world-map-editor-v0.91-project-",
  "world-map-editor-v0.9-project-",
  "world-map-editor-v0.8-project-",
  "world-map-editor-v0.7-project-",
  "world-map-editor-v0.6-project-",
  "world-map-editor-v0.5-project-",
  "world-map-editor-v0.4-project-",
];

export type RecentProject = {
  id: string;
  title: string;
  lastModifiedDate: string;
};

function normalizeGenerationAlgorithm(
  value: unknown,
): GeneratedMapData["settings"]["algorithm"] {
  if (value === "voronoi" || value === "delaunay_voronoi")
    return "delaunay_voronoi";
  if (["polygon", "mst", "wfc", "hybrid", "perlin"].includes(String(value)))
    return value as GeneratedMapData["settings"]["algorithm"];
  // 삭제된 SDF·판 구조·heightmap·geological 설정은 생성 결과 자체는 보존하되,
  // 다시 생성할 때에는 가장 중립적인 새 펄린 골자로 이관한다.
  return "perlin";
}

function parseIndex(key: string): RecentProject[] {
  const raw = localStorage.getItem(key);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as RecentProject[];
  } catch {
    return [];
  }
}

function readIndex(): RecentProject[] {
  const items = [
    parseIndex(INDEX_KEY),
    ...LEGACY_INDEX_KEYS.map(parseIndex),
  ].flat();
  return Array.from(new Map(items.map((item) => [item.id, item])).values());
}

function writeIndex(items: RecentProject[]): void {
  localStorage.setItem(INDEX_KEY, JSON.stringify(items.slice(0, 12)));
}

export function listRecentProjects(): RecentProject[] {
  return readIndex().sort((a, b) =>
    b.lastModifiedDate.localeCompare(a.lastModifiedDate),
  );
}

export function saveProject(project: WorldProject): WorldProject {
  const synced = syncAutoWikiArticles(project);
  const saved: WorldProject = {
    ...synced,
    version: PROGRAM_VERSION,
    lastModifiedDate: new Date().toISOString(),
  };
  localStorage.setItem(`${PROJECT_PREFIX}${saved.id}`, JSON.stringify(saved));
  const next = [
    {
      id: saved.id,
      title: saved.title,
      lastModifiedDate: saved.lastModifiedDate,
    },
    ...readIndex().filter((item) => item.id !== saved.id),
  ];
  writeIndex(next);
  return saved;
}

export function loadProject(projectId: string): WorldProject | null {
  const raw =
    localStorage.getItem(`${PROJECT_PREFIX}${projectId}`) ??
    LEGACY_PROJECT_PREFIXES.map((prefix) =>
      localStorage.getItem(`${prefix}${projectId}`),
    ).find(Boolean) ??
    null;
  if (!raw) return null;
  try {
    return normalizeProject(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function deleteProject(projectId: string): void {
  localStorage.removeItem(`${PROJECT_PREFIX}${projectId}`);
  for (const prefix of LEGACY_PROJECT_PREFIXES)
    localStorage.removeItem(`${prefix}${projectId}`);
  writeIndex(readIndex().filter((item) => item.id !== projectId));
}

function normalizeLocation(value: unknown): Location {
  const raw = value as Location & { position?: { x: number; y: number } };
  return {
    id: raw.id,
    states: (raw.states ?? []).map((state) => ({
      ...state,
      value: {
        ...state.value,
        position: state.value.position ?? raw.position ?? { x: 0, y: 0 },
        economy:
          typeof state.value.economy === "number" ? state.value.economy : 0,
      },
    })),
  };
}

function countLandComponents(data: GeneratedMapData): number {
  const width = data.gridWidth;
  const height = data.gridHeight;
  const land = data.elevationMap.map(
    (value, index) =>
      (data.waterTypeMap?.[index] ??
        (value > (data.seaLevel ?? 0) ? "land" : "saltwater")) === "land",
  );
  const seen = new Uint8Array(land.length);
  const queue = new Int32Array(land.length);
  let count = 0;
  for (let start = 0; start < land.length; start += 1) {
    if (!land[start] || seen[start]) continue;
    count += 1;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    seen[start] = 1;
    while (head < tail) {
      const index = queue[head++];
      const x = index % width;
      const y = Math.floor(index / width);
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const next = ny * width + nx;
        if (land[next] && !seen[next]) {
          seen[next] = 1;
          queue[tail++] = next;
        }
      }
    }
  }
  return count;
}

function normalizeGeneratedData(value: GeneratedMapData): GeneratedMapData {
  const defaults = defaultGeneratorSettings();
  const rawSettings = (value.settings ?? {}) as Partial<
    GeneratedMapData["settings"]
  > & { mapScope?: string; localRegionType?: string };
  const settings: GeneratedMapData["settings"] = {
    ...defaults,
    ...rawSettings,
    algorithm: normalizeGenerationAlgorithm(rawSettings.algorithm),
    mapScope:
      rawSettings.mapScope === "local" ||
      rawSettings.mapScope === "regional" ||
      rawSettings.mapScope === "world"
        ? rawSettings.mapScope
        : "continent",
    seaLevel:
      typeof rawSettings.seaLevel === "number"
        ? rawSettings.seaLevel
        : typeof value.seaLevel === "number"
          ? value.seaLevel
          : 0,
    localRegionType:
      String(rawSettings.localRegionType) === "river_basin"
        ? "river"
        : String(rawSettings.localRegionType) === "valley"
          ? "inland"
          : (["coast", "inland", "mountain", "river", "island", "archipelago"] as const).includes(rawSettings.localRegionType as never)
            ? (rawSettings.localRegionType as GeneratedMapData["settings"]["localRegionType"])
            : "inland",
    cornerWinds: {
      ...defaults.cornerWinds,
      ...(rawSettings.cornerWinds ?? {}),
      northWest: { ...defaults.cornerWinds.northWest, ...(rawSettings.cornerWinds?.northWest ?? {}) },
      northEast: { ...defaults.cornerWinds.northEast, ...(rawSettings.cornerWinds?.northEast ?? {}) },
      southWest: { ...defaults.cornerWinds.southWest, ...(rawSettings.cornerWinds?.southWest ?? {}) },
      southEast: { ...defaults.cornerWinds.southEast, ...(rawSettings.cornerWinds?.southEast ?? {}) },
    },
    localBoundary: {
      ...defaults.localBoundary,
      ...(rawSettings.localBoundary ?? {}),
    },
    islandCount: Math.max(1, Math.min(64, Math.trunc(Number(rawSettings.islandCount ?? defaults.islandCount)))),
    mountainGuide: { ...defaults.mountainGuide, ...(rawSettings.mountainGuide ?? {}) },
    riverGuide: { ...defaults.riverGuide, ...(rawSettings.riverGuide ?? {}) },
    worldCoordinateScale: Math.max(0.25, Math.min(16, Number(rawSettings.worldCoordinateScale ?? 1))),
    renderResolution: normalizePowerOfTwo(Number(rawSettings.renderResolution ?? defaults.renderResolution), defaults.renderResolution),
    analysisResolution: normalizePowerOfTwo(Number(rawSettings.analysisResolution ?? defaults.analysisResolution), defaults.analysisResolution),
  };
  const seaLevel =
    typeof value.seaLevel === "number" ? value.seaLevel : settings.seaLevel;
  const terrainMap = (value.terrainMap ?? []).map((terrain) =>
    (terrain as string) === "ocean"
      ? "plain"
      : (terrain as string) === "swamp"
        ? "wetland"
        : terrain,
  ) as GeneratedMapData["terrainMap"];
  const environment = calculateEnvironment(
    value.elevationMap ?? [],
    value.gridWidth,
    value.gridHeight,
    seaLevel,
    settings,
  );
  const normalized = {
    ...value,
    seaLevel,
    settings,
    renderWidth:
      typeof value.renderWidth === "number"
        ? value.renderWidth
        : Math.max(
            value.gridWidth,
            settings.renderResolution ?? value.gridWidth,
          ),
    renderHeight:
      typeof value.renderHeight === "number"
        ? value.renderHeight
        : Math.max(
            value.gridHeight,
            Math.round(
              ((settings.renderResolution ?? value.gridWidth) *
                value.worldHeight) /
                Math.max(1, value.worldWidth),
            ),
          ),
    landMask:
      Array.isArray(value.landMask) &&
      value.landMask.length === value.gridWidth * value.gridHeight
        ? value.landMask.map((item) => (item >= 0.5 ? 1 : 0))
        : (value.elevationMap ?? []).map((item) => (item > seaLevel ? 1 : 0)),
    waterTypeMap:
      Array.isArray(value.waterTypeMap) &&
      value.waterTypeMap.length === value.gridWidth * value.gridHeight
        ? value.waterTypeMap.map((item) =>
            item === "freshwater"
              ? "freshwater"
              : item === "saltwater"
                ? "saltwater"
                : "land",
          )
        : (value.elevationMap ?? []).map((item) =>
            item > seaLevel ? "land" : "saltwater",
          ),
    lakeIdMap:
      Array.isArray(value.lakeIdMap) &&
      value.lakeIdMap.length === value.gridWidth * value.gridHeight
        ? value.lakeIdMap.map((item) =>
            Number.isFinite(item) ? Math.trunc(item) : -1,
          )
        : new Array(value.gridWidth * value.gridHeight).fill(-1),
    lakeSurfaceElevations: Array.isArray(value.lakeSurfaceElevations)
      ? value.lakeSurfaceElevations.filter(Number.isFinite)
      : [],
    coastalTerrainMap:
      Array.isArray(value.coastalTerrainMap) &&
      value.coastalTerrainMap.length === value.gridWidth * value.gridHeight
        ? value.coastalTerrainMap
        : new Array(value.gridWidth * value.gridHeight).fill("none"),
    terrainMap:
      terrainMap.length === value.gridWidth * value.gridHeight
        ? terrainMap
        : environment.terrainMap,
    snowCoverMap:
      Array.isArray(value.snowCoverMap) &&
      value.snowCoverMap.length === value.gridWidth * value.gridHeight
        ? value.snowCoverMap
        : environment.snowCoverMap,
    snowBaseTerrainMap:
      Array.isArray(value.snowBaseTerrainMap) &&
      value.snowBaseTerrainMap.length === value.gridWidth * value.gridHeight
        ? (value.snowBaseTerrainMap.map((terrain) =>
            (terrain as string) === "swamp" ? "wetland" : terrain,
          ) as GeneratedMapData["snowBaseTerrainMap"])
        : environment.snowBaseTerrainMap,
    temperatureMap:
      Array.isArray(value.temperatureMap) &&
      value.temperatureMap.length === value.gridWidth * value.gridHeight
        ? value.temperatureMap
        : environment.temperatureMap,
    precipitationMap:
      Array.isArray(value.precipitationMap) &&
      value.precipitationMap.length === value.gridWidth * value.gridHeight
        ? value.precipitationMap
        : environment.precipitationMap,
    moistureMap:
      Array.isArray(value.moistureMap) &&
      value.moistureMap.length === value.gridWidth * value.gridHeight
        ? value.moistureMap
        : environment.moistureMap,
    relativeHumidityMap:
      Array.isArray(value.relativeHumidityMap) &&
      value.relativeHumidityMap.length === value.gridWidth * value.gridHeight
        ? value.relativeHumidityMap
        : environment.relativeHumidityMap,
    solarHoursMap:
      Array.isArray(value.solarHoursMap) &&
      value.solarHoursMap.length === value.gridWidth * value.gridHeight
        ? value.solarHoursMap
        : environment.solarHoursMap,
    solarIrradianceMap:
      Array.isArray(value.solarIrradianceMap) &&
      value.solarIrradianceMap.length === value.gridWidth * value.gridHeight
        ? value.solarIrradianceMap
        : environment.solarIrradianceMap,
    runoffMap:
      Array.isArray(value.runoffMap) &&
      value.runoffMap.length === value.gridWidth * value.gridHeight
        ? value.runoffMap
        : environment.runoffMap,
    flowAccumulationMap:
      Array.isArray(value.flowAccumulationMap) &&
      value.flowAccumulationMap.length === value.gridWidth * value.gridHeight
        ? value.flowAccumulationMap
        : new Array(value.gridWidth * value.gridHeight).fill(0),
    basinMap:
      Array.isArray(value.basinMap) &&
      value.basinMap.length === value.gridWidth * value.gridHeight
        ? value.basinMap
        : new Array(value.gridWidth * value.gridHeight).fill(-1),
    riverOrderMap:
      Array.isArray(value.riverOrderMap) &&
      value.riverOrderMap.length === value.gridWidth * value.gridHeight
        ? value.riverOrderMap
        : new Array(value.gridWidth * value.gridHeight).fill(0),
    riverMagnitudeMap:
      Array.isArray(value.riverMagnitudeMap) &&
      value.riverMagnitudeMap.length === value.gridWidth * value.gridHeight
        ? value.riverMagnitudeMap
        : new Array(value.gridWidth * value.gridHeight).fill(0),
    windXMap:
      Array.isArray(value.windXMap) &&
      value.windXMap.length === value.gridWidth * value.gridHeight
        ? value.windXMap
        : environment.windXMap,
    windYMap:
      Array.isArray(value.windYMap) &&
      value.windYMap.length === value.gridWidth * value.gridHeight
        ? value.windYMap
        : environment.windYMap,
    generatedTerritories: Array.isArray(value.generatedTerritories)
      ? value.generatedTerritories
      : [],
    rivers: Array.isArray(value.rivers)
      ? value.rivers.map((river, index) => ({
          ...river,
          order: typeof river.order === "number" ? river.order : 1,
          magnitude: typeof river.magnitude === "number" ? river.magnitude : Math.max(1, river.order ?? 1),
          basinId: typeof river.basinId === "number" ? river.basinId : index,
          mouth: Boolean(river.mouth),
        }))
      : [],
    qualityScore:
      typeof value.qualityScore === "number" ? value.qualityScore : 100,
    qualityIssues: Array.isArray(value.qualityIssues)
      ? value.qualityIssues.filter(
          (item): item is string => typeof item === "string",
        )
      : [],
    environmentModel: value.environmentModel ?? {
      engine: "builtin",
      version: "0.99v-worker-territory-complete-erosion",
    },
  } as GeneratedMapData;
  return {
    ...normalized,
    actualContinentCount:
      typeof value.actualContinentCount === "number"
        ? value.actualContinentCount
        : countLandComponents(normalized),
  };
}

function normalizeGeneratedStates(
  map: MapData & { generated?: GeneratedMapData | null },
): TemporalState<GeneratedMapData | null>[] {
  if (Array.isArray(map.generatedStates))
    return map.generatedStates.map((state) => ({
      ...state,
      value: state.value ? normalizeGeneratedData(state.value) : null,
    }));
  if (map.generated)
    return [
      {
        startYear: map.timeline?.minimumYear ?? 0,
        endYear: null,
        value: normalizeGeneratedData(map.generated),
      },
    ];
  return [];
}

const LEGACY_EVENT_CATEGORY_MAP: Record<string, EventCategory> = {
  treaty: "treaty",
  war: "war",
  battle: "battle",
  contract: "contract",
  expedition: "expedition",
  exploration: "exploration",
  accident: "accident",
  natural_disaster: "natural_disaster",
  civil_engineering: "civil_engineering",
  festival: "festival",
  incident: "incident",
  politics: "incident",
  disaster: "natural_disaster",
  culture: "festival",
  religion: "incident",
  discovery: "exploration",
  other: "incident",
};

function normalizeDateTime(
  value: unknown,
  fallbackYear: number,
): HistoricalDateTime {
  const raw = value as Partial<HistoricalDateTime> | null | undefined;
  return {
    year: typeof raw?.year === "number" ? raw.year : fallbackYear,
    month: typeof raw?.month === "number" ? raw.month : undefined,
    day: typeof raw?.day === "number" ? raw.day : undefined,
    hour: typeof raw?.hour === "number" ? raw.hour : undefined,
    minute: typeof raw?.minute === "number" ? raw.minute : undefined,
  };
}

function normalizeEvent(value: unknown): WorldEvent {
  const raw = value as Partial<WorldEvent> & { category?: string };
  const startYear = typeof raw.startYear === "number" ? raw.startYear : 0;
  const endYear =
    typeof raw.endYear === "number" || raw.endYear === null
      ? raw.endYear
      : startYear;
  const startDateTime = normalizeDateTime(raw.startDateTime, startYear);
  const endDateTime =
    raw.endDateTime === null
      ? null
      : normalizeDateTime(raw.endDateTime, endYear ?? startYear);
  const chronology =
    Array.isArray(raw.chronology) && raw.chronology.length > 0
      ? raw.chronology.map((entry) => ({
          ...entry,
          id:
            entry.id || `chronology-${Math.random().toString(36).slice(2, 9)}`,
          dateTime: normalizeDateTime(entry.dateTime, startYear),
          title: entry.title ?? "사건 기록",
          description: entry.description ?? "",
        }))
      : [
          {
            id: `chronology-${Math.random().toString(36).slice(2, 9)}`,
            dateTime: startDateTime,
            title: raw.title ?? "사건 발생",
            description: raw.description ?? "",
          },
        ];
  return {
    id: raw.id ?? `event-${Math.random().toString(36).slice(2, 9)}`,
    title: raw.title ?? "이름 없는 사건",
    startTimeUnknown: Boolean(raw.startTimeUnknown),
    endTimeUnknown:
      raw.endTimeUnknown === undefined
        ? raw.endDateTime == null
        : Boolean(raw.endTimeUnknown),
    startYear,
    endYear,
    category:
      LEGACY_EVENT_CATEGORY_MAP[raw.category ?? "incident"] ?? "incident",
    description: raw.description ?? "",
    location: raw.location ?? null,
    startDateTime,
    endDateTime,
    participants: Array.isArray(raw.participants)
      ? raw.participants.map((participant) => ({
          id:
            participant.id ||
            `participant-${Math.random().toString(36).slice(2, 9)}`,
          organizationName: participant.organizationName ?? "",
          keyFigures: participant.keyFigures ?? "",
          scale: participant.scale ?? "",
          cause: participant.cause ?? "",
          result: participant.result ?? "",
        }))
      : [],
    chronology,
    relatedLocationIds: Array.isArray(raw.relatedLocationIds)
      ? raw.relatedLocationIds
      : [],
    relatedFactionIds: Array.isArray(raw.relatedFactionIds)
      ? raw.relatedFactionIds
      : [],
    relatedTerritoryIds: Array.isArray(raw.relatedTerritoryIds)
      ? raw.relatedTerritoryIds
      : [],
  };
}

function normalizeTimeline(value: unknown): MapData["timeline"] {
  const raw = value as
    (Partial<MapData["timeline"]> & { playbackSpeed?: number }) | undefined;
  const interval = raw?.playbackIntervalMs;
  const playbackIntervalMs =
    interval === 100 ||
    interval === 200 ||
    interval === 333 ||
    interval === 500 ||
    interval === 1000
      ? interval
      : 1000;
  return {
    minimumYear: typeof raw?.minimumYear === "number" ? raw.minimumYear : 0,
    maximumYear: typeof raw?.maximumYear === "number" ? raw.maximumYear : 2000,
    currentYear:
      typeof raw?.currentYear === "number" ? Math.trunc(raw.currentYear) : 0,
    currentDayOfYear:
      typeof raw?.currentDayOfYear === "number"
        ? Math.max(0, Math.trunc(raw.currentDayOfYear))
        : 0,
    currentMinuteOfDay:
      typeof raw?.currentMinuteOfDay === "number"
        ? Math.max(0, Math.trunc(raw.currentMinuteOfDay))
        : 0,
    precision:
      raw?.precision === "month" || raw?.precision === "week" || raw?.precision === "date" || raw?.precision === "time"
        ? raw.precision
        : "year",
    isPlaying: Boolean(raw?.isPlaying),
    playbackIntervalMs,
  };
}

function normalizeMap(value: unknown): MapData {
  const map = value as MapData & { generated?: GeneratedMapData | null };
  const generated = Array.isArray(map.generatedStates)
    ? map.generatedStates.find((state) => state.value)?.value
    : map.generated;
  const legacyWidthKm = generated?.settings?.mapScaleKm ?? 4200;
  const scaleMode =
    map.scaleMode === "local" ||
    map.scaleMode === "regional" ||
    map.scaleMode === "world" ||
    map.scaleMode === "continent"
      ? map.scaleMode
      : mapScaleModeForWidth(legacyWidthKm);
  return {
    ...map,
    generationMode: map.generationMode === "free" ? "free" : "realistic",
    scaleMode,
    physicalWidthKm: clampMapPhysicalWidth(
      scaleMode,
      Number(map.physicalWidthKm ?? legacyWidthKm),
    ),
    editorMode:
      map.editorMode === "civilization" || map.editorMode === "environment"
        ? map.editorMode
        : "view",
    timeline: normalizeTimeline(map.timeline),
    generatedStates: normalizeGeneratedStates(map),
    terrains: Array.isArray(map.terrains)
      ? map.terrains.map((terrain) => ({
          ...terrain,
          baseState: {
            ...terrain.baseState,
            terrainType:
              (terrain.baseState.terrainType as string) === "swamp"
                ? "wetland"
                : terrain.baseState.terrainType,
          },
          changes: (terrain.changes ?? []).map((state) => ({
            ...state,
            value: {
              ...state.value,
              terrainType:
                (state.value.terrainType as string) === "swamp"
                  ? "wetland"
                  : state.value.terrainType,
            },
          })),
        }))
      : [],
    contourLines: Array.isArray(map.contourLines) ? map.contourLines : [],
    locations: Array.isArray(map.locations)
      ? map.locations.map(normalizeLocation)
      : [],
    roads: Array.isArray(map.roads) ? map.roads : [],
    rivers: Array.isArray(map.rivers) ? map.rivers : [],
    mountains: Array.isArray(map.mountains) ? map.mountains : [],
    placeNames: Array.isArray(map.placeNames)
      ? map.placeNames.map((place) => ({
          ...place,
          placementMode:
            place.placementMode ??
            (Array.isArray(place.path) && place.path.length >= 2
              ? "path"
              : "point"),
          path:
            Array.isArray(place.path) && place.path.length >= 2
              ? place.path
              : undefined,
          curve: place.curve ?? true,
          letterSpacing:
            typeof place.letterSpacing === "number" ? place.letterSpacing : 2.1,
          pathOffset:
            typeof place.pathOffset === "number" ? place.pathOffset : 0,
        }))
      : [],
    factions: Array.isArray(map.factions)
      ? map.factions.map((faction) => {
          const kind =
            faction.kind === "country" || faction.kind === "organization"
              ? faction.kind
              : "faction";
          return {
            ...faction,
            kind,
            organizationType: faction.organizationType ?? "general",
            foundedYear:
              typeof faction.foundedYear === "number"
                ? faction.foundedYear
                : undefined,
            dissolvedYear:
              typeof faction.dissolvedYear === "number"
                ? faction.dissolvedYear
                : undefined,
            activityRange:
              faction.activityRange ??
              (faction.maritime ? "sea_centered" : "land_centered"),
            hasTerritory:
              kind === "country"
                ? true
                : typeof faction.hasTerritory === "boolean"
                  ? faction.hasTerritory
                  : (map.territories?.some((territory) =>
                      territory.states?.some(
                        (state) => state.value?.ownerFactionId === faction.id,
                      ),
                    ) ?? false),
            territoryHidden: faction.territoryHidden === true,
            displayFlag: Boolean(faction.displayFlag),
            displayCoatOfArms: Boolean(faction.displayCoatOfArms),
            flagAssetId: faction.flagAssetId,
            coatOfArmsAssetId: faction.coatOfArmsAssetId,
            maritime: Boolean(faction.maritime),
            leaderStatus:
              faction.leaderStatus ??
              (faction.leaderArticleId
                ? "selected"
                : faction.leaderName === "없음"
                  ? "none"
                  : faction.leaderName
                    ? "custom"
                    : "undecided"),
            summary: faction.summary ?? faction.description ?? "",
            description: faction.description ?? "",
            countryProfile:
              kind === "country"
                ? {
                    nameRoot: faction.countryProfile?.nameRoot ?? faction.name,
                    showRegimeSuffix:
                      faction.countryProfile?.showRegimeSuffix ?? true,
                    spaceBeforeRegimeSuffix:
                      faction.countryProfile?.spaceBeforeRegimeSuffix ?? true,
                    politicalSystem: "",
                    symbol: "",
                    languageArticleIds: [],
                    languageCustom:
                      (faction.countryProfile as any)?.languages ?? "",
                    cultureArticleIds: [],
                    majorLocationIds: [],
                    ...(faction.countryProfile ?? {}),
                  }
                : undefined,
            groupProfile:
              kind !== "country"
                ? {
                    symbol: "",
                    ideology: "",
                    alignment: "",
                    goals: "",
                    headquartersStatus: "undecided",
                    languageArticleIds: [],
                    languageCustom: "",
                    cultureArticleIds: [],
                    cultureCustom: "",
                    countryArticleIds: [],
                    relatedFactionArticleIds: [],
                    ...(faction.groupProfile ?? {}),
                  }
                : undefined,
          };
        })
      : [],
    territories: Array.isArray(map.territories) ? map.territories : [],
    events: Array.isArray(map.events) ? map.events.map(normalizeEvent) : [],
    generatorSeedHistory: Array.isArray(map.generatorSeedHistory)
      ? map.generatorSeedHistory.slice(0, 4).map((record) => {
          const legacySettings = record.settings ?? {};
          const mergedSettings = {
            ...defaultGeneratorSettings(),
            ...legacySettings,
          };
          return {
            ...record,
            settings: {
              ...mergedSettings,
              algorithm: normalizeGenerationAlgorithm(
                (legacySettings as { algorithm?: string }).algorithm ??
                  mergedSettings.algorithm,
              ),
            },
          };
        })
      : [],
    environmentPins: Array.isArray(map.environmentPins)
      ? map.environmentPins
          .filter((pin) => pin && typeof pin === "object")
          .map((pin, index) => ({
            id:
              typeof pin.id === "string"
                ? pin.id
                : `environment-pin-${index + 1}`,
            name:
              typeof pin.name === "string" && pin.name.trim()
                ? pin.name
                : `비교 지점 ${index + 1}`,
            position: {
              x: Number.isFinite(pin.position?.x)
                ? Math.max(0, Math.min(map.width ?? 160, pin.position.x))
                : (map.width ?? 160) / 2,
              y: Number.isFinite(pin.position?.y)
                ? Math.max(0, Math.min(map.height ?? 100, pin.position.y))
                : (map.height ?? 100) / 2,
            },
            createdAt:
              typeof pin.createdAt === "string"
                ? pin.createdAt
                : new Date().toISOString(),
          }))
      : [],
  };
}

function normalizeWikiCategories(
  value: unknown,
  addMissingDefaults: boolean,
): WikiCategoryDefinition[] {
  const defaults = createDefaultWikiCategories();
  if (!Array.isArray(value)) return defaults;
  const normalized: WikiCategoryDefinition[] = value
    .filter((item) => item && typeof item === "object")
    .map((item) => {
      const raw = item as Partial<WikiCategoryDefinition>;
      const fallback = defaults.find(
        (item) => item.systemKey === raw.systemKey,
      );
      return {
        id:
          typeof raw.id === "string"
            ? raw.id
            : `wiki-category-${Math.random().toString(36).slice(2, 9)}`,
        name:
          typeof raw.name === "string" && raw.name.trim()
            ? raw.systemKey === "country" && raw.name === "국가·세력"
              ? "국가"
              : raw.name
            : "이름 없는 카테고리",
        parentId:
          typeof raw.parentId === "string" || raw.parentId === null
            ? raw.parentId
            : (fallback?.parentId ?? null),
        systemKey: raw.systemKey,
        templateKey:
          raw.templateKey ?? raw.systemKey ?? fallback?.templateKey ?? "other",
        createdDate: raw.createdDate ?? new Date().toISOString(),
      };
    });
  const existingKeys = new Set(
    normalized.map((item) => item.systemKey).filter(Boolean),
  );
  if (addMissingDefaults)
    for (const item of defaults)
      if (
        item.systemKey
          ? !existingKeys.has(item.systemKey)
          : !normalized.some((value) => value.id === item.id)
      )
        normalized.push(item);
  const ids = new Set(normalized.map((item) => item.id));
  return normalized.map((item) => {
    const canonical =
      defaults.find(
        (value) => value.systemKey && value.systemKey === item.systemKey,
      ) ?? defaults.find((value) => value.id === item.id);
    const currentParentId =
      item.parentId && ids.has(item.parentId) ? item.parentId : null;
    const canonicalParentId =
      canonical?.parentId && ids.has(canonical.parentId)
        ? canonical.parentId
        : null;
    const hierarchyLocked = new Set([
      "wiki-category-warfare-root",
      "wiki-category-war",
      "wiki-category-battle",
    ]);
    const parentId = hierarchyLocked.has(canonical?.id ?? "")
      ? canonicalParentId
      : addMissingDefaults && canonical?.systemKey
        ? canonicalParentId
        : (currentParentId ?? canonicalParentId);
    return { ...item, parentId };
  });
}

function normalizeWikiArticle(
  value: unknown,
  categories: WikiCategoryDefinition[],
): WikiArticle {
  const raw = value as WikiArticle;
  const rawCategory = (value as { category?: string }).category;
  const allowed = new Set([
    "world",
    "calendar",
    "country",
    "faction",
    "organization",
    "order",
    "merchant_guild",
    "mercenary_company",
    "assassin_guild",
    "knight_order",
    "city",
    "village",
    "fortress",
    "base",
    "location",
    "person",
    "family",
    "item",
    "technology",
    "culture",
    "religion",
    "language",
    "ideology",
    "government",
    "event",
    "accident",
    "war",
    "battle",
    "animal",
    "plant",
    "tree",
    "rock",
    "mineral",
    "disease",
    "other",
  ]);
  let category = (
    allowed.has(rawCategory ?? "") ? rawCategory : "other"
  ) as WikiArticle["category"];
  if ((raw.eventCategory as string) === "war") category = "war";
  if ((raw.eventCategory as string) === "battle") category = "battle";
  const explicitCategoryId =
    typeof (value as { categoryId?: unknown }).categoryId === "string"
      ? (value as { categoryId: string }).categoryId
      : (value as { categoryId?: unknown }).categoryId === null
        ? null
        : undefined;
  const explicitCategoryDefinition = explicitCategoryId
    ? categories.find((item) => item.id === explicitCategoryId)
    : undefined;
  const mustMoveEventCategory =
    (category === "war" || category === "battle") &&
    explicitCategoryDefinition?.systemKey !== category;
  const categoryId = mustMoveEventCategory
    ? (categories.find((item) => item.systemKey === category)?.id ?? null)
    : explicitCategoryId !== undefined
      ? explicitCategoryId
      : (categories.find((item) => item.systemKey === category)?.id ?? null);
  return {
    ...raw,
    category,
    categoryId,
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    linkedMapEntityIds: Array.isArray(raw.linkedMapEntityIds)
      ? raw.linkedMapEntityIds
      : [],
    eventCategory: raw.eventCategory
      ? (LEGACY_EVENT_CATEGORY_MAP[raw.eventCategory] ?? "incident")
      : undefined,
    eventProfile: raw.eventProfile
      ? normalizeEvent(raw.eventProfile)
      : undefined,
    factionProfile: raw.factionProfile
      ? (() => {
          const faction = raw.factionProfile;
          const kind =
            faction.kind === "country" || faction.kind === "organization"
              ? faction.kind
              : "faction";
          return {
            ...faction,
            kind,
            organizationType: faction.organizationType ?? "general",
            activityRange: faction.activityRange ?? "land_centered",
            hasTerritory:
              kind === "country" ? true : Boolean(faction.hasTerritory),
            territoryHidden: faction.territoryHidden === true,
            displayFlag: Boolean(faction.displayFlag),
            displayCoatOfArms: Boolean(faction.displayCoatOfArms),
            flagAssetId: faction.flagAssetId,
            coatOfArmsAssetId: faction.coatOfArmsAssetId,
            summary: faction.summary ?? "",
            description: faction.description ?? "",
            leaderStatus:
              faction.leaderStatus ??
              (faction.leaderArticleId
                ? "selected"
                : faction.leaderName
                  ? "custom"
                  : "undecided"),
            countryProfile:
              kind === "country"
                ? {
                    nameRoot: faction.countryProfile?.nameRoot ?? faction.name,
                    showRegimeSuffix:
                      faction.countryProfile?.showRegimeSuffix ?? true,
                    spaceBeforeRegimeSuffix:
                      faction.countryProfile?.spaceBeforeRegimeSuffix ?? true,
                    politicalSystem: "",
                    symbol: "",
                    languageArticleIds: [],
                    cultureArticleIds: [],
                    majorLocationIds: [],
                    ...(faction.countryProfile ?? {}),
                  }
                : undefined,
            groupProfile:
              kind !== "country"
                ? {
                    symbol: "",
                    ideology: "",
                    alignment: "",
                    goals: "",
                    headquartersStatus: "undecided",
                    languageArticleIds: [],
                    cultureArticleIds: [],
                    countryArticleIds: [],
                    relatedFactionArticleIds: [],
                    ...(faction.groupProfile ?? {}),
                  }
                : undefined,
          };
        })()
      : undefined,
    personProfile: raw.personProfile
      ? {
          ...raw.personProfile,
          organizationArticleIds:
            raw.personProfile.organizationArticleIds ?? [],
          factionArticleIds: raw.personProfile.factionArticleIds ?? [],
          spouseArticleIds: raw.personProfile.spouseArticleIds ?? [],
          childArticleIds: raw.personProfile.childArticleIds ?? [],
          notes: raw.personProfile.notes ?? "",
        }
      : undefined,
    familyProfile: raw.familyProfile
      ? {
          ...raw.familyProfile,
          displayMode: raw.familyProfile.displayMode ?? "all",
          members: (raw.familyProfile.members ?? []).map((member) => ({
            ...member,
            articleId: member.articleId,
          })),
          displayFlag: Boolean(raw.familyProfile.displayFlag),
          displayCoatOfArms: Boolean(raw.familyProfile.displayCoatOfArms),
          flagAssetId: raw.familyProfile.flagAssetId,
          coatOfArmsAssetId: raw.familyProfile.coatOfArmsAssetId,
        }
      : undefined,
    itemProfile: raw.itemProfile
      ? {
          itemType: raw.itemProfile.itemType ?? "",
          origin: raw.itemProfile.origin ?? "",
          condition: raw.itemProfile.condition ?? "",
          ownershipHistory: Array.isArray(raw.itemProfile.ownershipHistory)
            ? raw.itemProfile.ownershipHistory
            : [],
        }
      : undefined,
    religionProfile: raw.religionProfile
      ? {
          foundingYear: raw.religionProfile.foundingYear,
          leaderTitle: raw.religionProfile.leaderTitle ?? "",
          symbol: raw.religionProfile.symbol ?? "",
          alignment: raw.religionProfile.alignment ?? "",
          relatedOrganizationIds:
            raw.religionProfile.relatedOrganizationIds ?? [],
        }
      : undefined,
    governmentProfile: raw.governmentProfile
      ? { countryNameSuffix: raw.governmentProfile.countryNameSuffix ?? "" }
      : category === "government"
        ? { countryNameSuffix: "" }
        : undefined,
    calendarProfile: raw.calendarProfile
      ? {
          ...createDefaultCalendarProfile(),
          ...raw.calendarProfile,
          creator: raw.calendarProfile.creator ?? "",
          userFactionIds: Array.isArray(raw.calendarProfile.userFactionIds)
            ? raw.calendarProfile.userFactionIds
            : [],
          mechanism: raw.calendarProfile.mechanism ?? "",
          calendarName: raw.calendarProfile.calendarName ?? raw.title ?? "역법",
          displayMode:
            raw.calendarProfile.displayMode === "era" ? "era" : "signed",
          beforeEraName: raw.calendarProfile.beforeEraName ?? "이전",
          afterEraName: raw.calendarProfile.afterEraName ?? "이후",
          beforeEraShortName: raw.calendarProfile.beforeEraShortName ?? "",
          afterEraShortName: raw.calendarProfile.afterEraShortName ?? "",
          epochWorldYear:
            typeof raw.calendarProfile.epochWorldYear === "number"
              ? raw.calendarProfile.epochWorldYear
              : 0,
          dateUnits:
            Array.isArray(raw.calendarProfile.dateUnits) &&
            raw.calendarProfile.dateUnits.length >= 2
              ? raw.calendarProfile.dateUnits.slice(0, 4)
              : createDefaultCalendarProfile().dateUnits,
          timeUnits:
            Array.isArray(raw.calendarProfile.timeUnits) &&
            raw.calendarProfile.timeUnits.length >= 1
              ? raw.calendarProfile.timeUnits.slice(0, 4)
              : createDefaultCalendarProfile().timeUnits,
        }
      : undefined,
  };
}

function legacyMapToProject(
  map: MapData & { version?: string; generated?: GeneratedMapData | null },
): WorldProject {
  const project = createEmptyProject(map.title || "불러온 세계");
  project.maps = [normalizeMap(map)];
  project.activeMapId = map.id;
  return syncAutoWikiArticles(project);
}

export function normalizeProject(value: unknown): WorldProject {
  const raw = value as Partial<WorldProject> & Partial<MapData>;
  if (Array.isArray(raw.maps)) {
    const wikiCategories = normalizeWikiCategories(
      (raw as Partial<WorldProject>).wikiCategories,
      raw.version !== PROGRAM_VERSION,
    );
    const project: WorldProject = {
      ...(raw as WorldProject),
      version: PROGRAM_VERSION,
      theme:
        (raw as Partial<WorldProject>).theme === "light" ? "light" : "dark",
      uiSettings: {
        fontScale: Math.max(
          0.5,
          Math.min(
            1.5,
            Number(
              (raw as Partial<WorldProject>).uiSettings?.fontScale ??
                (typeof localStorage !== "undefined"
                  ? localStorage.getItem("world-archive-font-scale")
                  : 1),
            ) || 1,
          ),
        ),
        fontFamily:
          String(
            (raw as Partial<WorldProject>).uiSettings?.fontFamily ??
              (typeof localStorage !== "undefined"
                ? localStorage.getItem("world-archive-font-family")
                : "") ??
              "",
          ).trim() || 'Inter, Pretendard, "Noto Sans KR", system-ui, sans-serif',
      },
      worldSettings: {
        orbitalPeriodDays: Math.max(
          1,
          Number(
            (raw as Partial<WorldProject>).worldSettings?.orbitalPeriodDays ??
              365,
          ),
        ),
        simulationMode:
          (raw as Partial<WorldProject>).worldSettings?.simulationMode ===
          "realistic"
            ? "realistic"
            : "free",
        environmentEngine: [
          "builtin",
          "external_import",
          "expert_bridge",
        ].includes(
          String(
            (raw as Partial<WorldProject>).worldSettings?.environmentEngine,
          ),
        )
          ? (raw as Partial<WorldProject>).worldSettings!.environmentEngine!
          : "builtin",
        latitudeDeg: Number(
          (raw as Partial<WorldProject>).worldSettings?.latitudeDeg ?? 38,
        ),
        axialTiltDeg: Number(
          (raw as Partial<WorldProject>).worldSettings?.axialTiltDeg ?? 23.44,
        ),
        dayLengthHours: Math.max(
          1,
          Number(
            (raw as Partial<WorldProject>).worldSettings?.dayLengthHours ?? 24,
          ),
        ),
        gravityMs2: Math.max(
          0.1,
          Number(
            (raw as Partial<WorldProject>).worldSettings?.gravityMs2 ?? 9.80665,
          ),
        ),
      },
      simulationSummaries:
        (raw as Partial<WorldProject>).simulationSummaries ?? {},
      timelineCalendarArticleId:
        typeof (raw as Partial<WorldProject>).timelineCalendarArticleId ===
        "string"
          ? (raw as Partial<WorldProject>).timelineCalendarArticleId!
          : null,
      wikiCategories,
      linkedTextFields:
        (raw as Partial<WorldProject>).linkedTextFields &&
        typeof (raw as Partial<WorldProject>).linkedTextFields === "object"
          ? ((raw as Partial<WorldProject>).linkedTextFields as Record<
              string,
              string
            >)
          : {},
      heraldicAssets: Array.isArray(
        (raw as Partial<WorldProject>).heraldicAssets,
      )
        ? (raw as Partial<WorldProject>).heraldicAssets!.map((asset) => ({
            ...asset,
            patternScale: Number.isFinite(asset.patternScale)
              ? asset.patternScale
              : 1,
            symbolScale: Number.isFinite(asset.symbolScale)
              ? asset.symbolScale
              : 1,
            symbolOffsetX: Number.isFinite(asset.symbolOffsetX)
              ? asset.symbolOffsetX
              : 0,
            symbolOffsetY: Number.isFinite(asset.symbolOffsetY)
              ? asset.symbolOffsetY
              : 0,
          }))
        : [],
      wikiArticles: Array.isArray(raw.wikiArticles)
        ? raw.wikiArticles.map((article) =>
            normalizeWikiArticle(article, wikiCategories),
          )
        : [],
      maps: raw.maps.map(normalizeMap),
    };
    return syncAutoWikiArticles(project);
  }
  if (Array.isArray(raw.locations) && typeof raw.title === "string")
    return legacyMapToProject(raw as MapData);
  throw new Error("지원하지 않는 프로젝트 파일입니다.");
}

export function serializeProject(project: WorldProject): string {
  return JSON.stringify(syncAutoWikiArticles(project), null, 2);
}

export function exportProjectBrowser(project: WorldProject): void {
  const blob = new Blob([serializeProject(project)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${project.title || "world-project"}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function importProjectText(text: string): WorldProject {
  return normalizeProject(JSON.parse(text));
}

export async function importProjectFile(file: File): Promise<WorldProject> {
  return importProjectText(await file.text());
}
