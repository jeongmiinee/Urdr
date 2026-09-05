import {
  PROGRAM_VERSION,
  createId,
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
  type WikiDocumentSection,
  type WorldProject,
} from "../model/world";
import { familyContainingPerson, normalizeFamilyMembers, privateLineageFromLegacy } from "../model/genealogy";
import { syncAutoWikiArticles } from "../model/wikiSync";
import { calculateEnvironment } from "../generator/environment";
import { normalizePowerOfTwo } from "../generator/gridTransform";
import { hasValidSurfaceGeometry, refreshSurfaceRegions } from "../generator/surfaceVectors";
import { buildGeneratedContours, rebuildGeneratedMapData } from "../generator/generateWorld";
import { reconcileElevationWithWaterAndLakes, terrainWithoutSubmergedLand } from "../generator/waterElevation";
import {
  createDefaultRpgSettings,
  createEmptyRpgArticleData,
  type RpgArticleData,
  type RpgProjectSettings,
} from "../rpg/schema";

function normalizeRpgSettings(value: Partial<RpgProjectSettings> | undefined): RpgProjectSettings {
  const defaults = createDefaultRpgSettings(Boolean(value?.enabled), Boolean(value?.magicEnabled));
  const legacyGroupIds: Record<string, string> = {
    weapon: "equipment-weapon",
    armor: "equipment-armor",
  };
  const sourceGroups = Array.isArray(value?.groups) ? value.groups : [];
  const sourceDefinitions = Array.isArray(value?.definitions) ? value.definitions : [];
  const sourceSheets = Array.isArray(value?.sheets) ? value.sheets : [];
  const categoryForGroup = (groupId: string) => groupId.startsWith("profession-")
    ? "character-professions"
    : groupId.startsWith("equipment-")
      ? "equipment-attributes"
      : "character-attributes";
  const kindForGroup = (groupId: string) => groupId.startsWith("profession-") ? "profession" as const : "attribute" as const;
  const builtInDefinitionIds = new Set(defaults.definitions.map((definition) => definition.id));
  const builtInSheetIds = new Set(defaults.sheets.map((sheet) => sheet.id));
  const groups = [
    ...defaults.groups.map((group) => ({
      ...group,
      ...(sourceGroups.find((candidate) => candidate.id === group.id) ?? {}),
      label: group.label,
      order: group.order,
      magicOnly: group.magicOnly,
      categoryId: group.categoryId,
      kind: group.kind,
      builtIn: true,
    })),
    ...sourceGroups
      .filter((group) => !defaults.groups.some((candidate) => candidate.id === group.id))
      .filter((group) => group.id !== "weapon" && group.id !== "armor")
      .map((group) => ({
        ...group,
        categoryId: group.categoryId === "person" || group.categoryId === "magic" || group.categoryId === "affiliation"
          ? "character-attributes"
          : group.categoryId === "equipment"
            ? "equipment-attributes"
            : group.categoryId ?? categoryForGroup(group.id),
        kind: group.kind ?? kindForGroup(group.id),
      })),
  ];
  const definitions = [
    ...defaults.definitions.map((definition) => {
      const existing = sourceDefinitions.find((candidate) => candidate.id === definition.id);
      if (!existing) return definition;
      const refreshLabel = definition.id === "mana" || definition.id === "mana_regeneration";
      return {
        ...definition,
        ...existing,
        groupId: definition.groupId,
        categoryId: definition.categoryId,
        kind: definition.kind,
        label: refreshLabel ? definition.label : existing.label,
        magicOnly: definition.magicOnly,
      };
    }),
    ...sourceDefinitions
      .filter((definition) => !builtInDefinitionIds.has(definition.id))
      .map((definition) => ({
        ...definition,
        groupId: legacyGroupIds[definition.groupId] ?? definition.groupId,
        categoryId: categoryForGroup(legacyGroupIds[definition.groupId] ?? definition.groupId),
        kind: definition.kind ?? kindForGroup(legacyGroupIds[definition.groupId] ?? definition.groupId),
      })),
  ];
  const sheets = [
    ...defaults.sheets.map((sheet) => {
      const existing = sourceSheets.find((candidate) => candidate.id === sheet.id);
      if (!existing) return sheet;
      return {
        ...existing,
        label: sheet.label,
        groupIds: sheet.groupIds,
        statIds: [...new Set([...sheet.statIds, ...existing.statIds.filter((id) => !builtInDefinitionIds.has(id))])],
      };
    }),
    ...sourceSheets.filter((sheet) => !builtInSheetIds.has(sheet.id)),
  ];
  return {
    ...defaults,
    ...value,
    enabled: Boolean(value?.enabled),
    magicEnabled: Boolean(value?.magicEnabled),
    definitionCategories: defaults.definitionCategories,
    groups,
    definitions,
    sheets,
    traits: Array.isArray(value?.traits) ? value.traits : [],
    modifierOrder: Array.isArray(value?.modifierOrder) && value.modifierOrder.length
      ? value.modifierOrder
      : defaults.modifierOrder,
  };
}

function normalizeRpgArticleData(value: Partial<RpgArticleData> | undefined): RpgArticleData | undefined {
  if (!value) return undefined;
  const defaults = createEmptyRpgArticleData();
  return {
    ...defaults,
    ...value,
    enabled: value.enabled !== false,
    sheetIds: Array.isArray(value.sheetIds) ? value.sheetIds : [],
    visibleGroupIds: Array.isArray(value.visibleGroupIds) ? value.visibleGroupIds : [],
    values: value.values && typeof value.values === "object" ? value.values : {},
    modifiers: Array.isArray(value.modifiers) ? value.modifiers : [],
    traitIds: Array.isArray(value.traitIds) ? value.traitIds : [],
    attackProfiles: Array.isArray(value.attackProfiles) ? value.attackProfiles : [],
    grantedEffects: Array.isArray(value.grantedEffects) ? value.grantedEffects : [],
  };
}
import { countryCountSettings } from "../generator/countryGeneration";
import {
  LEGACY_PROJECT_PREFIXES,
  PROJECT_PREFIX,
  readProjectIndex,
  writeProjectIndex,
  type RecentProject,
} from "./projectIndex";

export type { RecentProject } from "./projectIndex";

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

export function listRecentProjects(): RecentProject[] {
  return readProjectIndex().sort((a, b) =>
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
    ...readProjectIndex().filter((item) => item.id !== saved.id),
  ];
  writeProjectIndex(next);
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
  writeProjectIndex(readProjectIndex().filter((item) => item.id !== projectId));
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
  const normalizedSeaLevel =
    typeof rawSettings.seaLevel === "number"
      ? rawSettings.seaLevel
      : typeof value.seaLevel === "number"
        ? value.seaLevel
        : defaults.seaLevel;
  const normalizedMaxElevation = Math.max(
    50,
    Math.min(20_000, Number(rawSettings.maxElevation ?? defaults.maxElevation)),
  );
  const settings: GeneratedMapData["settings"] = {
    ...defaults,
    ...rawSettings,
    ...countryCountSettings(rawSettings),
    algorithm: normalizeGenerationAlgorithm(rawSettings.algorithm),
    mapScope:
      rawSettings.mapScope === "local" ||
      rawSettings.mapScope === "regional" ||
      rawSettings.mapScope === "world"
        ? rawSettings.mapScope
        : "continent",
    seaLevel: normalizedSeaLevel,
    maxElevation: normalizedMaxElevation,
    elevationRangeM: Math.max(
      0,
      Math.min(
        20_000,
        Number(rawSettings.elevationRangeM ?? normalizedMaxElevation - normalizedSeaLevel + 4_200),
      ),
    ),
    elevationNoiseStrength: Math.max(
      0,
      Math.min(1, Number(rawSettings.elevationNoiseStrength ?? defaults.elevationNoiseStrength)),
    ),
    settlementGenerationYear: 0,
    preserveExistingSettlements: false,
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
  const expectedGridSize = value.gridWidth * value.gridHeight;
  const baseTerrainMap = (
    Array.isArray(value.baseTerrainMap) && value.baseTerrainMap.length === expectedGridSize
      ? value.baseTerrainMap
      : terrainMap
  ).map((terrain) => terrain === "farmland" ? "plain" : terrain) as GeneratedMapData["terrainMap"];
  const agricultureMap =
    Array.isArray(value.agricultureMap) && value.agricultureMap.length === expectedGridSize
      ? value.agricultureMap.map((item) => Math.max(0, Math.min(1, Number.isFinite(item) ? item : 0)))
      : terrainMap.length === expectedGridSize
        ? terrainMap.map((terrain) => terrain === "farmland" ? 1 : 0)
        : new Array(expectedGridSize).fill(0);
  const waterTypeMap: GeneratedMapData["waterTypeMap"] =
    Array.isArray(value.waterTypeMap) && value.waterTypeMap.length === expectedGridSize
      ? value.waterTypeMap.map((item) =>
          item === "freshwater"
            ? "freshwater"
            : item === "saltwater"
              ? "saltwater"
              : "land",
        )
      : (value.elevationMap ?? []).map((item) =>
          item > seaLevel ? "land" : "saltwater",
        );
  const lakeIdMap =
    Array.isArray(value.lakeIdMap) && value.lakeIdMap.length === expectedGridSize
      ? value.lakeIdMap.map((item) => Number.isFinite(item) ? Math.trunc(item) : -1)
      : new Array(expectedGridSize).fill(-1);
  const lakeSurfaceElevations = Array.isArray(value.lakeSurfaceElevations)
    ? value.lakeSurfaceElevations.filter(Number.isFinite)
    : [];
  const elevationMap = reconcileElevationWithWaterAndLakes(
    value.elevationMap ?? [],
    waterTypeMap,
    seaLevel,
    lakeIdMap,
    lakeSurfaceElevations,
  );
  const landMask = waterTypeMap.map((type) => type === "land" ? 1 : 0);
  const environment = calculateEnvironment(
    elevationMap,
    value.gridWidth,
    value.gridHeight,
    seaLevel,
    settings,
  );
  const normalized = {
    ...value,
    seaLevel,
    elevationMap,
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
    landMask,
    waterTypeMap,
    lakeIdMap,
    lakeSurfaceElevations,
    coastalTerrainMap:
      Array.isArray(value.coastalTerrainMap) &&
      value.coastalTerrainMap.length === value.gridWidth * value.gridHeight
        ? value.coastalTerrainMap
        : new Array(value.gridWidth * value.gridHeight).fill("none"),
    baseTerrainMap:
      baseTerrainMap.length === expectedGridSize
        ? terrainWithoutSubmergedLand(baseTerrainMap, waterTypeMap, "plain")
        : terrainWithoutSubmergedLand(environment.terrainMap, waterTypeMap, "plain"),
    agricultureMap,
    terrainMap:
      baseTerrainMap.length === expectedGridSize
        ? terrainWithoutSubmergedLand(baseTerrainMap, waterTypeMap, "plain")
        : terrainWithoutSubmergedLand(environment.terrainMap, waterTypeMap, "plain"),
    snowCoverMap:
      Array.isArray(value.snowCoverMap) &&
      value.snowCoverMap.length === value.gridWidth * value.gridHeight
        ? value.snowCoverMap.map((item, index) => waterTypeMap[index] === "land" ? item : 0)
        : environment.snowCoverMap.map((item, index) => waterTypeMap[index] === "land" ? item : 0),
    snowBaseTerrainMap:
      Array.isArray(value.snowBaseTerrainMap) &&
      value.snowBaseTerrainMap.length === value.gridWidth * value.gridHeight
          ? terrainWithoutSubmergedLand(
              value.snowBaseTerrainMap.map((terrain, index) =>
                (terrain as string) === "swamp"
                  ? "wetland"
                  : terrain === "farmland"
                    ? (baseTerrainMap[index] ?? "plain")
                    : terrain,
              ) as GeneratedMapData["snowBaseTerrainMap"],
              waterTypeMap,
              "plain",
            )
        : terrainWithoutSubmergedLand(environment.snowBaseTerrainMap, waterTypeMap, "plain"),
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
    contours: buildGeneratedContours(
      elevationMap,
      value.gridWidth,
      value.gridHeight,
      value.worldWidth,
      value.worldHeight,
      seaLevel,
      settings.contourInterval,
      "final",
    ),
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
  const surfaceNormalized = hasValidSurfaceGeometry(normalized)
    ? normalized
    : refreshSurfaceRegions(normalized, "final");
  const hydrologyNormalized = surfaceNormalized.riverGraph
    ? surfaceNormalized
    : rebuildGeneratedMapData(
        surfaceNormalized,
        surfaceNormalized.elevationMap,
        surfaceNormalized.terrainMap,
        seaLevel,
        surfaceNormalized.agricultureMap,
      );
  return {
    ...hydrologyNormalized,
    actualContinentCount:
      typeof value.actualContinentCount === "number"
        ? value.actualContinentCount
        : countLandComponents(hydrologyNormalized),
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
    locationMode:
      raw.locationMode === "custom" || raw.locationMode === "coordinate"
        ? raw.locationMode
        : raw.location
          ? "coordinate"
          : "custom",
    location: raw.location ?? null,
    locationText: raw.locationText ?? "",
    cause: raw.cause ?? "",
    result: raw.result ?? "",
    impact: raw.impact ?? "",
    startDateTime,
    endDateTime,
    participants: Array.isArray(raw.participants)
      ? raw.participants.map((participant) => ({
          id:
            participant.id ||
            `participant-${Math.random().toString(36).slice(2, 9)}`,
          organizationArticleId: participant.organizationArticleId,
          organizationName: participant.organizationName ?? "",
          representativeLeaderArticleId: participant.representativeLeaderArticleId,
          representativeLeaderName: participant.representativeLeaderName ?? participant.keyFigures ?? "",
          otherLeaderArticleIds: Array.isArray(participant.otherLeaderArticleIds) ? participant.otherLeaderArticleIds : [],
          otherLeaderNames: Array.isArray(participant.otherLeaderNames) ? participant.otherLeaderNames : [],
          participationScale: participant.participationScale ?? participant.scale ?? "",
          cause: participant.cause ?? "",
          result: participant.result ?? "",
          impact: participant.impact ?? "",
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
      raw?.precision === "month" || raw?.precision === "date" || raw?.precision === "time"
        ? raw.precision
        : raw?.precision === "week"
          ? "date"
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
    // v1.4 removes independent hand-drawn rivers; generated drainage graphs are authoritative.
    rivers: [],
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
                      (faction.countryProfile as
                        | (typeof faction.countryProfile & {
                            languages?: string;
                          })
                        | undefined)?.languages ?? "",
                    cultureArticleIds: [],
                    majorLocationIds: [],
                    ...(faction.countryProfile ?? {}),
                    locationIds: faction.countryProfile?.locationIds ?? [],
                    capitalPeriods: faction.countryProfile?.capitalPeriods
                      ?? (faction.countryProfile?.capitalLocationId ? [{ id: createId("capital-period"), locationId: faction.countryProfile.capitalLocationId }] : []),
                    religionArticleIds: faction.countryProfile?.religionArticleIds
                      ?? (faction.countryProfile?.stateReligionArticleId ? [faction.countryProfile.stateReligionArticleId] : []),
                    predecessorArticleIds: faction.countryProfile?.predecessorArticleIds ?? [],
                    successorArticleIds: faction.countryProfile?.successorArticleIds ?? [],
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
                    scale: faction.groupProfile?.scale ?? "",
                    purpose: faction.groupProfile?.purpose ?? faction.groupProfile?.goals ?? "",
                  }
                : undefined,
          };
        })
      : [],
    territories: Array.isArray(map.territories) ? map.territories : [],
    events: Array.isArray(map.events) ? map.events.map(normalizeEvent) : [],
    generatorSeedHistory: Array.isArray(map.generatorSeedHistory)
      ? map.generatorSeedHistory.slice(0, 3).map((record) => {
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

function normalizeDocumentSections(value: unknown): WikiDocumentSection[] {
  if (!Array.isArray(value)) return [];
  const sections = value.map((entry, index) => {
    const section = entry as Partial<WikiDocumentSection>;
    const legacyLevel = section.level === 2 || section.level === 3 || section.level === 4
      ? section.level
      : 1;
    return {
      id: typeof section.id === "string" && section.id ? section.id : createId("wiki-section"),
      title: typeof section.title === "string" ? section.title : "",
      content: typeof section.content === "string" ? section.content : "",
      parentId: typeof section.parentId === "string" ? section.parentId : null,
      level: legacyLevel,
      includeInToc: true,
      sourceIndex: index,
    };
  });
  const ids = new Set(sections.map((section) => section.id));
  const stack: Array<string | null> = [null, null, null, null];
  return sections.map((section) => {
    let parentId = section.parentId && ids.has(section.parentId) && section.parentId !== section.id
      ? section.parentId
      : null;
    if (!parentId && section.level > 1) parentId = stack[section.level - 2];
    const level = parentId
      ? Math.min(4, (sections.find((candidate) => candidate.id === parentId)?.level ?? 1) + 1) as 1 | 2 | 3 | 4
      : 1;
    stack[level - 1] = section.id;
    for (let depth = level; depth < stack.length; depth += 1) stack[depth] = null;
    return {
      id: section.id,
      title: section.title,
      content: section.content,
      parentId,
      level,
      includeInToc: true,
    };
  });
}

function normalizeProfileSections(value: unknown) {
  const source = Array.isArray(value) ? value : [];
  const sections = source.map((entry, index) => {
    const section = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
    return {
      id: typeof section.id === "string" && section.id ? section.id : createId("profile-section"),
      title: typeof section.title === "string" ? section.title : "",
      content: typeof section.content === "string" ? section.content : "",
      parentId: typeof section.parentId === "string" ? section.parentId : null,
      order: typeof section.order === "number" && Number.isFinite(section.order) ? section.order : index,
    };
  });
  const sectionIds = new Set(sections.map((section) => section.id));
  return sections
    .map((section) => ({ ...section, parentId: section.parentId && sectionIds.has(section.parentId) && section.parentId !== section.id ? section.parentId : null }))
    .sort((a, b) => a.order - b.order)
    .map((section, order) => ({ ...section, order }));
}

function normalizeReligionProfile(value: unknown): NonNullable<WikiArticle["religionProfile"]> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const stringValue = (key: string) => typeof raw[key] === "string" ? raw[key] as string : "";
  const stringList = (key: string) => Array.isArray(raw[key])
    ? (raw[key] as unknown[]).filter((entry): entry is string => typeof entry === "string")
    : [];
  let doctrineSections = normalizeProfileSections(raw.doctrineSections);
  if (doctrineSections.length === 0 && raw.doctrine && typeof raw.doctrine === "object") {
    const legacyDoctrine = raw.doctrine as Record<string, unknown>;
    const labels: Record<string, string> = {
      cosmology: "우주관", divinity: "신관", revelation: "계시", ethics: "윤리",
      ritual: "의례", afterlife: "사후관", clergy: "성직 체계", sacredTexts: "경전",
      prohibitions: "금기", organization: "조직",
    };
    doctrineSections = Object.entries(labels).flatMap(([key, title], order) => {
      const content = typeof legacyDoctrine[key] === "string" ? legacyDoctrine[key] as string : "";
      return content.trim() ? [{ id: createId("doctrine"), title, content, parentId: null, order }] : [];
    });
  }
  doctrineSections = normalizeProfileSections(doctrineSections);
  return {
    traditionLineage: stringValue("traditionLineage"),
    founder: stringValue("founder"),
    foundingPeriod: stringValue("foundingPeriod") || (typeof raw.foundingYear === "number" ? String(raw.foundingYear) : ""),
    holyCity: stringValue("holyCity"),
    distributionRegions: stringList("distributionRegions"),
    adherentPopulation: stringValue("adherentPopulation"),
    religiousInstitutions: stringList("religiousInstitutions").length > 0
      ? stringList("religiousInstitutions")
      : stringList("relatedOrganizationIds"),
    scriptures: stringList("scriptures"),
    majorDenominations: stringList("majorDenominations"),
    doctrineSections,
  };
}

function normalizeCultureProfile(value: unknown): NonNullable<WikiArticle["cultureProfile"]> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const stringList = (key: string) => Array.isArray(raw[key])
    ? (raw[key] as unknown[]).filter((entry): entry is string => typeof entry === "string")
    : typeof raw[key] === "string" && raw[key] ? [raw[key] as string] : [];
  return {
    distributionRegions: stringList("distributionRegions").length > 0 ? stringList("distributionRegions") : stringList("region"),
    relatedLanguageArticleIds: stringList("relatedLanguageArticleIds"),
    relatedReligionArticleIds: stringList("relatedReligionArticleIds"),
    characteristicSections: normalizeProfileSections(raw.characteristicSections),
  };
}

function normalizeTechnologyProfile(value: unknown): NonNullable<WikiArticle["technologyProfile"]> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  return {
    creator: typeof raw.creator === "string" ? raw.creator : "",
    creationPeriod: typeof raw.creationPeriod === "string" ? raw.creationPeriod : "",
    characteristicSections: normalizeProfileSections(raw.characteristicSections),
  };
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
    "technology_engineering",
    "technology_mathematics",
    "technology_science",
    "technology_chemistry",
    "technology_medicine",
    "technology_physics",
    "culture_sphere",
    "culture",
    "religion",
    "language_family",
    "language_branch",
    "language_group",
    "language",
    "dialect",
    "writing_system",
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
    documentSections: normalizeDocumentSections(raw.documentSections),
    showTableOfContents: undefined,
    linkedMapEntityIds: Array.isArray(raw.linkedMapEntityIds)
      ? raw.linkedMapEntityIds
      : [],
    eventCategory: raw.eventCategory
      ? (LEGACY_EVENT_CATEGORY_MAP[raw.eventCategory] ?? "incident")
      : undefined,
    eventProfile: raw.eventProfile
      ? normalizeEvent(raw.eventProfile)
      : undefined,
    diseaseProfile: raw.diseaseProfile ? {
      aliases: typeof raw.diseaseProfile.aliases === "string" ? raw.diseaseProfile.aliases : "",
      cause: typeof raw.diseaseProfile.cause === "string" ? raw.diseaseProfile.cause : "",
      incubationPeriod: typeof raw.diseaseProfile.incubationPeriod === "string" ? raw.diseaseProfile.incubationPeriod : "",
      symptomArticleIds: Array.isArray(raw.diseaseProfile.symptomArticleIds) ? raw.diseaseProfile.symptomArticleIds.filter((id): id is string => typeof id === "string") : [],
      symptomNotes: typeof raw.diseaseProfile.symptomNotes === "string" ? raw.diseaseProfile.symptomNotes : "",
      relatedDiseaseArticleIds: Array.isArray(raw.diseaseProfile.relatedDiseaseArticleIds) ? raw.diseaseProfile.relatedDiseaseArticleIds.filter((id): id is string => typeof id === "string") : [],
      symptoms: Array.isArray(raw.diseaseProfile.symptoms)
        ? raw.diseaseProfile.symptoms.filter((entry): entry is string => typeof entry === "string")
        : typeof raw.diseaseProfile.symptomNotes === "string"
          ? raw.diseaseProfile.symptomNotes.split(/[,\n]/).map((entry) => entry.trim()).filter(Boolean)
          : [],
      aftereffects: Array.isArray(raw.diseaseProfile.aftereffects)
        ? raw.diseaseProfile.aftereffects.filter((entry): entry is string => typeof entry === "string")
        : Array.isArray(raw.diseaseProfile.disabilities)
          ? raw.diseaseProfile.disabilities.filter((entry): entry is string => typeof entry === "string")
          : [],
      debuffs: Array.isArray(raw.diseaseProfile.debuffs)
        ? raw.diseaseProfile.debuffs.flatMap((entry) => {
            if (typeof entry === "string") return [{ target: "", operation: "subtract" as const, value: 0, unit: "percent" as const, duration: "", stacking: "replace" as const, condition: entry }];
            if (!entry || typeof entry !== "object") return [];
            const value = entry as Record<string, unknown>;
            const operation = value.operation === "add" || value.operation === "multiply" || value.operation === "set" ? value.operation : "subtract";
            const unit = value.unit === "point" || value.unit === "multiplier" ? value.unit : "percent";
            const stacking = value.stacking === "stack" || value.stacking === "strongest" ? value.stacking : "replace";
            return [{
              target: typeof value.target === "string" ? value.target : "",
              operation,
              value: typeof value.value === "number" && Number.isFinite(value.value) ? Math.max(0, value.value) : 0,
              unit,
              duration: typeof value.duration === "string" ? value.duration : "",
              stacking,
              condition: typeof value.condition === "string" ? value.condition : "",
            }];
          })
        : [],
    } : undefined,
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
                    locationIds: faction.countryProfile?.locationIds ?? [],
                    capitalPeriods: faction.countryProfile?.capitalPeriods
                      ?? (faction.countryProfile?.capitalLocationId ? [{ id: createId("capital-period"), locationId: faction.countryProfile.capitalLocationId }] : []),
                    religionArticleIds: faction.countryProfile?.religionArticleIds
                      ?? (faction.countryProfile?.stateReligionArticleId ? [faction.countryProfile.stateReligionArticleId] : []),
                    predecessorArticleIds: faction.countryProfile?.predecessorArticleIds ?? [],
                    successorArticleIds: faction.countryProfile?.successorArticleIds ?? [],
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
                    scale: faction.groupProfile?.scale ?? "",
                    purpose: faction.groupProfile?.purpose ?? faction.groupProfile?.goals ?? "",
                  }
                : undefined,
          };
        })()
      : undefined,
    personProfile: raw.personProfile
      ? {
          ...raw.personProfile,
          nationalityArticleIds: raw.personProfile.nationalityArticleIds
            ?? (raw.personProfile.countryArticleId ? [raw.personProfile.countryArticleId] : []),
          affiliationArticleIds: raw.personProfile.affiliationArticleIds
            ?? [...new Set([
              raw.personProfile.primaryAffiliationArticleId,
              ...(raw.personProfile.organizationArticleIds ?? []),
              ...(raw.personProfile.factionArticleIds ?? []),
            ].filter((id): id is string => Boolean(id)))],
          religionArticleIds: raw.personProfile.religionArticleIds
            ?? (raw.personProfile.religionArticleId ? [raw.personProfile.religionArticleId] : []),
          languageArticleIds: raw.personProfile.languageArticleIds ?? [],
          ideologyArticleIds: raw.personProfile.ideologyArticleIds ?? [],
          organizationArticleIds:
            raw.personProfile.organizationArticleIds ?? [],
          factionArticleIds: raw.personProfile.factionArticleIds ?? [],
          loyaltyByAffiliation: raw.personProfile.loyaltyByAffiliation ?? {},
          faithByReligion: raw.personProfile.faithByReligion ?? {},
          spouseArticleIds: raw.personProfile.spouseArticleIds ?? [],
          childArticleIds: raw.personProfile.childArticleIds ?? [],
          privateLineage: raw.personProfile.privateLineage
            ? { members: normalizeFamilyMembers(raw.personProfile.privateLineage.members ?? []) }
            : undefined,
          notes: raw.personProfile.notes ?? "",
        }
      : undefined,
    familyProfile: raw.familyProfile
      ? {
          ...raw.familyProfile,
          formationPeriod: raw.familyProfile.formationPeriod ?? "",
          dissolutionPeriod: raw.familyProfile.dissolutionPeriod ?? "",
          displayMode: raw.familyProfile.displayMode ?? "all",
          members: normalizeFamilyMembers((raw.familyProfile.members ?? []).map((member) => ({
            ...member,
            articleId: member.articleId,
          }))),
          displayFlag: Boolean(raw.familyProfile.displayFlag),
          displayCoatOfArms: Boolean(raw.familyProfile.displayCoatOfArms),
          flagAssetId: raw.familyProfile.flagAssetId,
          coatOfArmsAssetId: raw.familyProfile.coatOfArmsAssetId,
        }
      : undefined,
    itemProfile: raw.itemProfile
      ? {
          subtype: raw.itemProfile.subtype ?? "item",
          itemType: raw.itemProfile.itemType ?? "",
          origin: raw.itemProfile.origin ?? "",
          purpose: raw.itemProfile.purpose ?? "",
          lifecycleStatus: raw.itemProfile.lifecycleStatus ?? "active",
          isUnique: Boolean(raw.itemProfile.isUnique),
          condition: raw.itemProfile.condition ?? "",
          ownershipHistory: Array.isArray(raw.itemProfile.ownershipHistory)
            ? raw.itemProfile.ownershipHistory
            : [],
        }
      : undefined,
    religionProfile: normalizeReligionProfile(raw.religionProfile),
    cultureProfile: normalizeCultureProfile(raw.cultureProfile),
    technologyProfile: normalizeTechnologyProfile(raw.technologyProfile),
    governmentProfile: raw.governmentProfile
      ? { countryNameSuffix: raw.governmentProfile.countryNameSuffix ?? "" }
      : category === "government"
        ? { countryNameSuffix: "" }
        : undefined,
    rpgData: normalizeRpgArticleData(raw.rpgData),
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
        showTableOfContents:
          (raw as Partial<WorldProject>).uiSettings?.showTableOfContents ??
          (raw.wikiArticles?.length
            ? raw.wikiArticles.some((article) => article.showTableOfContents === true)
            : true),
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
        magicEnabled: Boolean(
          (raw as Partial<WorldProject>).worldSettings?.magicEnabled ??
          (raw as Partial<WorldProject>).rpgSettings?.magicEnabled,
        ),
      },
      rpgSettings: normalizeRpgSettings(
        (raw as Partial<WorldProject>).rpgSettings,
      ),
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
        ? (raw as Partial<WorldProject>).heraldicAssets!.map((asset) => {
            const layers = Array.isArray(asset.layers) && asset.layers.length
              ? asset.layers
              : [
                  asset.pattern !== "solid" || asset.patternImageDataUrl
                    ? {
                        id: createId("herald-layer"), kind: asset.patternImageDataUrl ? "image" as const : "pattern" as const,
                        name: "무늬", visible: true, locked: false, pattern: asset.pattern,
                        imageDataUrl: asset.patternImageDataUrl, color: asset.patternColor,
                        offsetX: 0, offsetY: 0, scaleX: asset.patternScale ?? 1, scaleY: asset.patternScale ?? 1,
                        rotation: 0, flipX: false, flipY: false, opacity: 1,
                      }
                    : null,
                  asset.symbol !== "none" || asset.symbolImageDataUrl
                    ? {
                        id: createId("herald-layer"), kind: asset.symbolImageDataUrl ? "image" as const : "symbol" as const,
                        name: "문양", visible: true, locked: false, symbol: asset.symbol,
                        imageDataUrl: asset.symbolImageDataUrl, color: asset.symbolColor,
                        offsetX: asset.symbolOffsetX ?? 0, offsetY: asset.symbolOffsetY ?? 0,
                        scaleX: asset.symbolScale ?? 1, scaleY: asset.symbolScale ?? 1,
                        rotation: 0, flipX: false, flipY: false, opacity: 1,
                      }
                    : null,
                  asset.compositeImageDataUrl
                    ? {
                        id: createId("herald-layer"), kind: "image" as const, name: "업로드 이미지",
                        visible: true, locked: false, imageDataUrl: asset.compositeImageDataUrl, color: "#ffffff",
                        offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1, rotation: 0,
                        flipX: false, flipY: false, opacity: 1,
                      }
                    : null,
                ].filter(Boolean);
            return {
            ...asset,
            source: "generated" as const,
            shape: asset.kind === "flag" && String(asset.shape) === "pennant" ? "rectangle_swallowtail" : asset.shape,
            patternImageDataUrl:
              asset.patternImageDataUrl ??
              (asset.source === "upload" ? asset.imageDataUrl : undefined),
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
            layers: layers as NonNullable<typeof asset.layers>,
          }})
        : [],
      wikiArticles: Array.isArray(raw.wikiArticles)
        ? raw.wikiArticles.map((article) =>
            normalizeWikiArticle(article, wikiCategories),
          )
        : [],
      maps: raw.maps.map(normalizeMap),
    };
    for (const article of project.wikiArticles) {
      const person = article.personProfile;
      if (!person) continue;
      const family = person.familyArticleId
        ? project.wikiArticles.find((candidate) => candidate.id === person.familyArticleId && candidate.familyProfile)
        : familyContainingPerson(project, article.id);
      if (family) {
        person.familyArticleId = family.id;
        person.privateLineage = undefined;
        person.fatherArticleId = undefined;
        person.motherArticleId = undefined;
        person.spouseArticleIds = [];
        person.childArticleIds = [];
      } else if (!person.privateLineage) {
        person.privateLineage = privateLineageFromLegacy(person, article.id, article.title);
      }
    }
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
