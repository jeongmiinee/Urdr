export const PROGRAM_VERSION = "0.99x" as const;

export type Point = { x: number; y: number };
export type LineSegment = { start: Point; end: Point };
export type TimeRange = { startYear: number; endYear: number | null };
export type TemporalState<T> = TimeRange & { value: T };

export type TimelinePrecision = "year" | "month" | "week" | "date" | "time";

export type TimelineState = {
  minimumYear: number;
  maximumYear: number;
  /** 모든 역사 상태의 기준이 되는 표준 공전 연도. */
  currentYear: number;
  /** 표준 공전 연도 안에서의 0 기반 날짜. */
  currentDayOfYear: number;
  /** 표준 하루 안에서의 0 기반 분. */
  currentMinuteOfDay: number;
  /** 타임라인 표시·재생 단위. 연도 → 월 → 일 → 시각 순으로 순환한다. */
  precision: TimelinePrecision;
  isPlaying: boolean;
  /** 현재 정밀도 한 단위가 진행되는 실제 시간 간격(ms) */
  playbackIntervalMs: 100 | 200 | 333 | 500 | 1000;
};

export const TERRAIN_TYPES = [
  "mountain",
  "forest",
  "desert",
  "snow",
  "grassland",
  "plain",
  "farmland",
  "jungle",
  "wetland",
  "rock",
  "bedrock",
] as const;
export type TerrainType = (typeof TERRAIN_TYPES)[number];

export const WATER_TYPES = ["land", "saltwater", "freshwater"] as const;
export type WaterType = (typeof WATER_TYPES)[number];

export const COASTAL_TERRAIN_TYPES = [
  "none",
  "sand_beach",
  "gravel_beach",
  "rocky_coast",
  "coastal_cliff",
  "mudflat",
  "salt_marsh",
  "sandbar",
  "lagoon",
  "delta",
  "estuary",
] as const;
export type CoastalTerrainType = (typeof COASTAL_TERRAIN_TYPES)[number];

export type MapGenerationScope = "local" | "regional" | "continent" | "world";
export type MapScaleMode = MapGenerationScope;
export const MAP_SCALE_RANGES: Record<
  MapScaleMode,
  { label: string; min: number; max: number; defaultWidth: number }
> = {
  local: { label: "지방 지도", min: 1, max: 100, defaultWidth: 40 },
  regional: { label: "지역 지도", min: 100, max: 1000, defaultWidth: 450 },
  continent: { label: "대륙 지도", min: 1000, max: 10000, defaultWidth: 4200 },
  world: { label: "세계 지도", min: 10000, max: 40000, defaultWidth: 32000 },
};

export function clampMapPhysicalWidth(
  mode: MapScaleMode,
  value: number,
): number {
  const range = MAP_SCALE_RANGES[mode];
  return Math.max(
    range.min,
    Math.min(range.max, Number.isFinite(value) ? value : range.defaultWidth),
  );
}

export function mapScaleModeForWidth(widthKm: number): MapScaleMode {
  if (widthKm < 100) return "local";
  if (widthKm < 1000) return "regional";
  if (widthKm < 10000) return "continent";
  return "world";
}
export type LocalRegionType =
  | "coast"
  | "inland"
  | "mountain"
  | "river"
  | "island"
  | "archipelago";

export type MapGenerationAlgorithm =
  "perlin" | "delaunay_voronoi" | "polygon" | "mst" | "wfc" | "hybrid";
export type MapShapePreset =
  | "island"
  | "volcanic_island"
  | "closed"
  | "continent"
  | "multi_continent"
  | "supercontinent"
  | "archipelago"
  | "inland_sea";
export type KoppenClimateCode =
  | "Af"
  | "Am"
  | "Aw"
  | "As"
  | "BWh"
  | "BWk"
  | "BSh"
  | "BSk"
  | "Csa"
  | "Csb"
  | "Csc"
  | "Cwa"
  | "Cwb"
  | "Cwc"
  | "Cfa"
  | "Cfb"
  | "Cfc"
  | "Dsa"
  | "Dsb"
  | "Dsc"
  | "Dsd"
  | "Dwa"
  | "Dwb"
  | "Dwc"
  | "Dwd"
  | "Dfa"
  | "Dfb"
  | "Dfc"
  | "Dfd"
  | "ET"
  | "EF";
export type ClimatePreset =
  | KoppenClimateCode
  | "temperate_oceanic"
  | "temperate_continental"
  | "mediterranean"
  | "tropical_humid"
  | "arid"
  | "polar"
  | "alpine"
  | "custom";
export type Season = "spring" | "summer" | "autumn" | "winter";
export type SimulationMode = "free" | "realistic";
export type MapEditorMode = "view" | "civilization" | "environment";
export type BoundaryKind = "land" | "water";
export type BoundarySide = "north" | "east" | "south" | "west";
export type BoundarySegment = {
  /** 0~1 범위에서 경계면을 따라 차지하는 시작·끝 비율. */
  start: number;
  end: number;
  kind: BoundaryKind;
};
export type LocalBoundaryConfig = Record<BoundarySide, BoundarySegment[]>;
export type WindVectorSetting = { directionDeg: number; speed: number };
export type CornerWindSettings = {
  northWest: WindVectorSetting;
  northEast: WindVectorSetting;
  southWest: WindVectorSetting;
  southEast: WindVectorSetting;
};
export type GuidedFeatureMode = "endpoints" | "drawn";
export type GuidedFeatureSetting = {
  mode: GuidedFeatureMode;
  /** 지도 좌표 비율(0~1)로 저장되는 중추 경로. */
  path: Point[];
  startSide: BoundarySide;
  startOffset: number;
  endSide: BoundarySide;
  endOffset: number;
  width: number;
  branchiness: number;
};
export type EnvironmentEngineMode =
  "builtin" | "external_import" | "expert_bridge";

export type GeneratorSettings = {
  seed: number;
  latitudeDeg: number;
  algorithm: MapGenerationAlgorithm;
  mapScope: MapGenerationScope;
  localRegionType: LocalRegionType;
  mapShape: MapShapePreset;
  mapScaleKm: number;
  climatePreset: ClimatePreset;
  season: Season;
  /** 선택한 배경기후가 기준으로 삼는 대표 위도. */
  climateReferenceLatitudeDeg: number;
  baseTemperatureC: number;
  /** 배경기후의 기준 상대습도(0~1). */
  baseHumidity: number;
  prevailingWindDirectionDeg: number;
  prevailingWindSpeed: number;
  /** 대륙·세계 지도에서 네 모서리 바람을 보간해 만드는 풍장. */
  cornerWinds: CornerWindSettings;
  /** 지방·지역 지도 경계의 육지/수역 구간 설정. */
  localBoundary: LocalBoundaryConfig;
  /** 군도형에서 생성할 섬 수. 단일 섬형에서는 1로 강제한다. */
  islandCount: number;
  mountainGuide: GuidedFeatureSetting;
  riverGuide: GuidedFeatureSetting;
  basePrecipitationMm: number;
  /** 가장 더운 달과 가장 추운 달의 평균기온 차이. */
  annualTemperatureRangeC: number;
  /** 월·연도별 기후 편차의 전체 강도(0~1). */
  climateVariability: number;
  /** 여러 해에 걸쳐 기후 편차가 이어지는 정도(0~1). */
  climatePersistence: number;
  /** 폭염·한파·가뭄·집중호우 발생 빈도(0~1). */
  extremeEventFrequency: number;
  /** 내륙에 배치할 강 그래프 노드 수. */
  riverNodeCount: number;
  /** 강 노드가 생성될 수 있는 최대 해발고도(m). */
  riverNodeMaxElevation: number;
  /** 생성기에서 종횡비를 고정한 채 논리 월드 좌표를 확대·축소하는 배율. */
  worldCoordinateScale: number;
  /** 논리적 세계 크기와 분리된 최종 렌더 가로 해상도. 2의 거듭제곱만 허용한다. */
  renderResolution: 64 | 128 | 256 | 512 | 1024 | 2048;
  /** 지형·해안·수계 계산에 사용하는 분석 격자의 가로 해상도. 2의 거듭제곱만 허용한다. */
  analysisResolution: 64 | 128 | 256 | 512 | 1024 | 2048;
  /** 국지 해안 지형에 적용되는 평균 조수 간만의 차(m). */
  tidalRangeM: number;
  generateCountries: boolean;
  countryCount: number;
  naturalBorderInfluence: number;
  allowExclaves: boolean;
  maritimeCountryRatio: number;
  nomadicCountryRatio: number;
  mountainCountryRatio: number;
  gridWidth: number;
  gridHeight: number;
  continentCount: number;
  landRatio: number;
  coastlineDetail: number;
  mountainStrength: number;
  /** 전체 지형에 적용되는 세부 노이즈의 강도. */
  noiseStrength: number;
  /** 대륙 골격을 비대칭·비정형으로 변형하는 저주파 동적성. */
  continentDynamics: number;
  /** 둥근 단일 섬을 방지하기 위한 골자 부분 보정 반복 횟수. */
  skeletonRepairPasses: number;
  /** 하이브리드 모드의 WFC 매크로 위상 영향도. */
  hybridWfcStrength: number;
  /** 하이브리드·MST 골격에서 복원할 추가 간선 비율. */
  hybridExtraEdgeRatio: number;
  /** 하이브리드 모드의 펄린 도메인 워핑 영향도. */
  hybridPerlinWarp: number;
  /** 하이브리드 모드의 폴리곤 경계 세분화 강도. */
  hybridPolygonRefinement: number;
  /** 해수면 인접 영역에만 적용되는 해안 평활화 강도. */
  coastSmoothness: number;
  erosion: number;
  temperature: number;
  moisture: number;
  contourInterval: number;
  maxElevation: number;
  seaLevel: number;
};

export type GeneratedContourSegment = LineSegment & {
  elevation: number;
  isMajor: boolean;
  /** 같은 전체 등고선 곡선에 속하는 선분을 묶는 식별자. */
  curveId?: number;
  /** curveId 안에서의 선분 순서. */
  sequence?: number;
};

export type GeneratedRiverSegment = LineSegment & {
  flow: number;
  /** 상류 발원지 수를 누적한 Shreve 계열 규모값. */
  magnitude: number;
  width: number;
  /** Strahler 하천 차수. 본류와 지류의 시각적 위계를 결정한다. */
  order: number;
  /** 같은 하구로 모이는 유역 식별자. */
  basinId: number;
  /** 바다 또는 지도 외곽에 닿는 마지막 하천 구간인지 여부. */
  mouth: boolean;
  /** 같은 상위 하천 곡선에 속하는 선분 식별자. */
  riverId?: number;
  /** riverId 안에서의 선분 순서. */
  sequence?: number;
};

export type GeneratedSurface = TerrainType | "saltwater" | "freshwater";

export type GeneratedSurfaceRegion = {
  /** 같은 지형·수역의 연결 영역을 묶은 벡터 멀티폴리곤. */
  surface: GeneratedSurface;
  polygons: Point[][];
};

export type GeneratedTerritoryRegion = {
  index: number;
  name: string;
  color: string;
  center: Point;
  polygon: Point[];
  /** 영토 안의 호수·해역처럼 채우지 않을 내부 수역 경계. */
  holes?: Point[][];
  coastal: boolean;
  mountainAdapted: boolean;
};

export type GeneratedMapData = {
  settings: GeneratorSettings;
  gridWidth: number;
  gridHeight: number;
  /** 화면·내보내기용 목표 렌더 크기. 계산 격자와 분리된다. */
  renderWidth: number;
  renderHeight: number;
  worldWidth: number;
  worldHeight: number;
  seaLevel: number;
  elevationMap: number[];
  /** 최초 해안선으로 확정된 육지 마스크. 후속 판 활동·침식이 임의의 해수 구멍을 만들지 않도록 보존한다. */
  landMask: number[];
  /** 각 셀의 수역 분류. 외해 연결 수역은 해수, 내륙 수역과 호수는 담수다. */
  waterTypeMap: WaterType[];
  /** 같은 양의 ID를 공유하는 타일만 하나의 동일 수면고도 호수로 연결된다. 호수가 아니면 -1. */
  lakeIdMap: number[];
  /** lakeId별 수면 고도(m). 해수면보다 높을 수 있다. */
  lakeSurfaceElevations: number[];
  /** 국지 해안 지도에서 환경 조건으로 생성된 실제 해안가 타일. */
  coastalTerrainMap: CoastalTerrainType[];
  terrainMap: TerrainType[];
  /** 0~1 적설 피복률. 원래 지형색과 설색을 혼합하는 데 사용한다. */
  snowCoverMap: number[];
  /** 적설 아래의 원래 지형. */
  snowBaseTerrainMap: TerrainType[];
  temperatureMap: number[];
  precipitationMap: number[];
  moistureMap: number[];
  relativeHumidityMap: number[];
  solarHoursMap: number[];
  solarIrradianceMap: number[];
  /** 강수-증발산-침투를 반영한 연간 지표 유출량(mm 상당). */
  runoffMap: number[];
  /** 각 셀로 누적되는 상대 유량. */
  flowAccumulationMap: number[];
  /** 각 육지 셀이 속하는 유역 식별자. 바다는 -1. */
  basinMap: number[];
  /** 각 셀의 Strahler 하천 차수. 하천이 아니면 0. */
  riverOrderMap: number[];
  /** 각 셀을 통과하는 하천의 상류 발원지 누적 규모. 하천이 아니면 0. */
  riverMagnitudeMap: number[];
  windXMap: number[];
  windYMap: number[];
  generatedTerritories: GeneratedTerritoryRegion[];
  /** 래스터 지형을 연결 영역별 곡선 벡터로 변환한 렌더링용 경계. */
  surfaceRegions?: GeneratedSurfaceRegion[];
  coastline: LineSegment[];
  contours: GeneratedContourSegment[];
  rivers: GeneratedRiverSegment[];
  generatedAt: string;
  environmentModel: {
    engine: EnvironmentEngineMode;
    version: string;
    importedSource?: string;
  };
  actualContinentCount: number;
  /** 생성 결과 자동 검증 점수(0~100). */
  qualityScore: number;
  /** 자동 검증에서 발견된 보완 필요 항목. */
  qualityIssues: string[];
};

export type TerrainState = { terrainType: TerrainType; description: string };
export type Terrain = {
  id: string;
  name: string;
  points: Point[];
  baseState: TerrainState;
  changes: TemporalState<TerrainState>[];
};

export type ContourLine = {
  id: string;
  elevation: number;
  points: Point[];
  isClosed: boolean;
  isMajor: boolean;
  labelVisible: boolean;
};

export const LOCATION_TYPES = [
  "village",
  "town",
  "city",
  "capital",
  "ruin",
  "dungeon",
  "sacred_site",
  "landmark",
] as const;
export type LocationType = (typeof LOCATION_TYPES)[number];
export type LocationStatus = "active" | "occupied" | "destroyed" | "abandoned";
export type LocationState = {
  name: string;
  locationType: LocationType;
  position: Point;
  population?: number;
  economy?: number;
  regionName?: string;
  ownerFactionId?: string;
  status: LocationStatus;
  description: string;
};
export type Location = {
  id: string;
  states: TemporalState<LocationState>[];
};

export type FactionKind = "country" | "faction" | "organization";
export type OrganizationType =
  | "general"
  | "order"
  | "merchant_guild"
  | "mercenary_company"
  | "assassin_guild"
  | "knight_order";
export type ActivityRange =
  "land_only" | "land_centered" | "mixed" | "sea_centered" | "sea_only";
export type SelectionStatus = "selected" | "custom" | "undecided" | "none";
export type LinkedReference = { articleId?: string; customText?: string };
export type CountryProfile = {
  /** 체제 접미사를 제외한 국가 고유명. */
  nameRoot?: string;
  /** 체제 접미사를 완전 국명에 표시할지 여부. */
  showRegimeSuffix?: boolean;
  /** 고유명과 체제 접미사 사이에 공백을 둘지 여부. */
  spaceBeforeRegimeSuffix?: boolean;
  politicalSystem: string;
  politicalSystemArticleId?: string;
  stateReligionArticleId?: string;
  stateReligionCustom?: string;
  symbol: string;
  symbolArticleId?: string;
  languageArticleIds: string[];
  languageCustom?: string;
  cultureArticleIds: string[];
  capitalLocationId?: string;
  capitalCustom?: string;
  majorLocationIds: string[];
  majorLocationsCustom?: string;
  cultureCustom?: string;
};
export type GroupProfile = {
  symbol: string;
  symbolArticleId?: string;
  ideology: string;
  ideologyArticleId?: string;
  alignment: string;
  goals: string;
  headquartersLocationId?: string;
  headquartersStatus?: SelectionStatus;
  headquartersCustom?: string;
  languageArticleIds: string[];
  languageCustom?: string;
  cultureArticleIds?: string[];
  cultureCustom?: string;
  countryArticleIds?: string[];
  relatedFactionArticleIds?: string[];
};
export type Faction = {
  id: string;
  foundedYear?: number;
  dissolvedYear?: number;
  kind: FactionKind;
  organizationType?: OrganizationType;
  name: string;
  color: string;
  leaderName?: string;
  leaderArticleId?: string;
  leaderStatus?: SelectionStatus;
  activityRange: ActivityRange;
  /** 국가 외 세력·단체가 영토를 사용할지 여부. 국가는 항상 true로 취급한다. */
  hasTerritory?: boolean;
  /** 영토 데이터는 유지하되 지도에서 숨길지 여부. */
  territoryHidden?: boolean;
  displayFlag?: boolean;
  displayCoatOfArms?: boolean;
  flagAssetId?: string;
  coatOfArmsAssetId?: string;
  /** v0.92 이하 호환용 */
  maritime?: boolean;
  summary: string;
  description: string;
  countryProfile?: CountryProfile;
  groupProfile?: GroupProfile;
};

export type TerritoryState = {
  ownerFactionId: string | null;
  polygon: Point[];
  /** 바다·호수는 영토 채움에서 제외하기 위한 내부 수역 경계. */
  holes?: Point[][];
  description: string;
};
export type Territory = {
  id: string;
  name: string;
  states: TemporalState<TerritoryState>[];
};

export type PathNode = Point & { connectionIds?: string[] };
export type Road = TimeRange & {
  id: string;
  name: string;
  nodes: PathNode[];
  roadType: "main" | "secondary" | "trail" | "bridge";
  description: string;
};
export type River = TimeRange & {
  id: string;
  name: string;
  nodes: PathNode[];
  width: number;
  description: string;
};
export type Mountain = TimeRange & {
  id: string;
  name: string;
  peakPosition: Point;
  baseRadius: number;
  height: number;
  description: string;
};
export type PlaceName = TimeRange & {
  id: string;
  name: string;
  position: Point;
  type: "region" | "landmark" | "water_body" | "geographic_feature";
  description: string;
  /** 기존 단일 지점 배치와 경로를 따르는 지명 배치를 함께 지원한다. */
  placementMode?: "point" | "path";
  /** 논리적 지도 좌표로 저장되는 지명 경로 제어점. */
  path?: Point[];
  /** true이면 Catmull–Rom 곡선으로 보간한다. */
  curve?: boolean;
  letterSpacing?: number;
  pathOffset?: number;
};

export const EVENT_CATEGORIES = [
  "treaty",
  "war",
  "battle",
  "contract",
  "expedition",
  "exploration",
  "accident",
  "natural_disaster",
  "civil_engineering",
  "festival",
  "incident",
] as const;
export type EventCategory = (typeof EVENT_CATEGORIES)[number];

export const EVENT_CATEGORY_LABELS: Record<EventCategory, string> = {
  treaty: "조약",
  war: "전쟁",
  battle: "전투",
  contract: "계약",
  expedition: "원정",
  exploration: "탐험",
  accident: "사고",
  natural_disaster: "자연재해",
  civil_engineering: "토목공사",
  festival: "축제",
  incident: "사건",
};

export type HistoricalDateTime = {
  year: number;
  month?: number;
  day?: number;
  hour?: number;
  minute?: number;
};

export type EventParticipant = {
  id: string;
  organizationName: string;
  keyFigures: string;
  scale: string;
  cause: string;
  result: string;
};

export type EventChronologyEntry = {
  id: string;
  dateTime: HistoricalDateTime;
  title: string;
  description: string;
};

export type WorldEvent = TimeRange & {
  id: string;
  startTimeUnknown: boolean;
  /** 종료 날짜 입력을 비활성화하는 명시적 미정 상태. */
  endTimeUnknown: boolean;
  title: string;
  category: EventCategory;
  description: string;
  location: Point | null;
  startDateTime: HistoricalDateTime;
  endDateTime: HistoricalDateTime | null;
  participants: EventParticipant[];
  chronology: EventChronologyEntry[];
  relatedLocationIds: string[];
  relatedFactionIds: string[];
  relatedTerritoryIds: string[];
};

export type WikiCategory =
  | "world"
  | "calendar"
  | "country"
  | "faction"
  | "organization"
  | "order"
  | "merchant_guild"
  | "mercenary_company"
  | "assassin_guild"
  | "knight_order"
  | "city"
  | "village"
  | "fortress"
  | "base"
  | "location"
  | "person"
  | "family"
  | "item"
  | "technology"
  | "culture"
  | "religion"
  | "language"
  | "ideology"
  | "government"
  | "event"
  | "accident"
  | "war"
  | "battle"
  | "animal"
  | "plant"
  | "tree"
  | "rock"
  | "mineral"
  | "disease"
  | "other";
export type WikiCategoryDefinition = {
  id: string;
  name: string;
  parentId: string | null;
  /** 이 카테고리에서 새 문서를 만들 때 사용할 템플릿. */
  templateKey?: WikiCategory;
  /** 자동 문서가 처음 배치될 기본 분류. 사용자가 분류를 지워도 다시 생성하지 않는다. */
  systemKey?: WikiCategory;
  createdDate: string;
};
export const DEFAULT_WIKI_CATEGORY_NAMES: Array<{
  id: string;
  name: string;
  parentId: string | null;
  systemKey?: WikiCategory;
}> = [
  {
    id: "wiki-category-world",
    systemKey: "world",
    name: "세계",
    parentId: null,
  },
  { id: "wiki-category-people-root", name: "인물·세력", parentId: null },
  {
    id: "wiki-category-country",
    systemKey: "country",
    name: "국가",
    parentId: "wiki-category-people-root",
  },
  {
    id: "wiki-category-faction",
    systemKey: "faction",
    name: "세력",
    parentId: "wiki-category-people-root",
  },
  {
    id: "wiki-category-organization-root",
    name: "단체",
    parentId: "wiki-category-people-root",
  },
  {
    id: "wiki-category-organization",
    systemKey: "organization",
    name: "일반 단체",
    parentId: "wiki-category-organization-root",
  },
  {
    id: "wiki-category-order",
    systemKey: "order",
    name: "교단",
    parentId: "wiki-category-organization-root",
  },
  {
    id: "wiki-category-merchant-guild",
    systemKey: "merchant_guild",
    name: "상단",
    parentId: "wiki-category-organization-root",
  },
  {
    id: "wiki-category-mercenary-company",
    systemKey: "mercenary_company",
    name: "용병단",
    parentId: "wiki-category-organization-root",
  },
  {
    id: "wiki-category-assassin-guild",
    systemKey: "assassin_guild",
    name: "암살단",
    parentId: "wiki-category-organization-root",
  },
  {
    id: "wiki-category-knight-order",
    systemKey: "knight_order",
    name: "기사단",
    parentId: "wiki-category-organization-root",
  },
  {
    id: "wiki-category-family",
    systemKey: "family",
    name: "가문",
    parentId: "wiki-category-people-root",
  },
  {
    id: "wiki-category-person",
    systemKey: "person",
    name: "인물",
    parentId: "wiki-category-people-root",
  },
  { id: "wiki-category-events-root", name: "사건·사고", parentId: null },
  {
    id: "wiki-category-event",
    systemKey: "event",
    name: "사건",
    parentId: "wiki-category-events-root",
  },
  {
    id: "wiki-category-accident",
    systemKey: "accident",
    name: "사고",
    parentId: "wiki-category-events-root",
  },
  {
    id: "wiki-category-warfare-root",
    name: "전쟁·전투",
    parentId: "wiki-category-events-root",
  },
  {
    id: "wiki-category-war",
    systemKey: "war",
    name: "전쟁",
    parentId: "wiki-category-warfare-root",
  },
  {
    id: "wiki-category-battle",
    systemKey: "battle",
    name: "전투",
    parentId: "wiki-category-warfare-root",
  },
  { id: "wiki-category-civilization-root", name: "문명·문화", parentId: null },
  {
    id: "wiki-category-technology",
    systemKey: "technology",
    name: "기술",
    parentId: "wiki-category-civilization-root",
  },
  {
    id: "wiki-category-calendar",
    systemKey: "calendar",
    name: "역법",
    parentId: "wiki-category-civilization-root",
  },
  {
    id: "wiki-category-culture",
    systemKey: "culture",
    name: "문화",
    parentId: "wiki-category-civilization-root",
  },
  {
    id: "wiki-category-religion",
    systemKey: "religion",
    name: "종교",
    parentId: "wiki-category-civilization-root",
  },
  {
    id: "wiki-category-language",
    systemKey: "language",
    name: "언어",
    parentId: "wiki-category-civilization-root",
  },
  {
    id: "wiki-category-ideology",
    systemKey: "ideology",
    name: "사상",
    parentId: "wiki-category-civilization-root",
  },
  {
    id: "wiki-category-government",
    systemKey: "government",
    name: "체제",
    parentId: "wiki-category-civilization-root",
  },
  { id: "wiki-category-assets-root", name: "물건·장소", parentId: null },
  {
    id: "wiki-category-item",
    systemKey: "item",
    name: "물건",
    parentId: "wiki-category-assets-root",
  },
  {
    id: "wiki-category-location-root",
    name: "장소",
    parentId: "wiki-category-assets-root",
  },
  {
    id: "wiki-category-city",
    systemKey: "city",
    name: "도시",
    parentId: "wiki-category-location-root",
  },
  {
    id: "wiki-category-village",
    systemKey: "village",
    name: "마을",
    parentId: "wiki-category-location-root",
  },
  {
    id: "wiki-category-fortress",
    systemKey: "fortress",
    name: "요새",
    parentId: "wiki-category-location-root",
  },
  {
    id: "wiki-category-base",
    systemKey: "base",
    name: "거점",
    parentId: "wiki-category-location-root",
  },
  {
    id: "wiki-category-location",
    systemKey: "location",
    name: "기타 장소",
    parentId: "wiki-category-location-root",
  },
  { id: "wiki-category-nature-root", name: "자연·생태", parentId: null },
  {
    id: "wiki-category-animal",
    systemKey: "animal",
    name: "동물",
    parentId: "wiki-category-nature-root",
  },
  {
    id: "wiki-category-plant",
    systemKey: "plant",
    name: "식물",
    parentId: "wiki-category-nature-root",
  },
  {
    id: "wiki-category-tree",
    systemKey: "tree",
    name: "나무",
    parentId: "wiki-category-nature-root",
  },
  {
    id: "wiki-category-rock",
    systemKey: "rock",
    name: "암석",
    parentId: "wiki-category-nature-root",
  },
  {
    id: "wiki-category-mineral",
    systemKey: "mineral",
    name: "광물",
    parentId: "wiki-category-nature-root",
  },
  {
    id: "wiki-category-disease",
    systemKey: "disease",
    name: "질병",
    parentId: "wiki-category-nature-root",
  },
  {
    id: "wiki-category-other",
    systemKey: "other",
    name: "기타",
    parentId: null,
  },
];
export function createDefaultWikiCategories(): WikiCategoryDefinition[] {
  const now = new Date().toISOString();
  return DEFAULT_WIKI_CATEGORY_NAMES.map(
    ({ id, systemKey, name, parentId }) => ({
      id,
      name,
      parentId,
      systemKey,
      templateKey: systemKey ?? "other",
      createdDate: now,
    }),
  );
}
export type PersonProfile = {
  birthYear?: number;
  deathYear?: number;
  countryArticleId?: string;
  organizationArticleIds: string[];
  factionArticleIds: string[];
  fatherArticleId?: string;
  motherArticleId?: string;
  spouseArticleIds: string[];
  childArticleIds: string[];
  notes: string;
};

export type FamilyTreeMember = {
  id: string;
  articleId?: string;
  name: string;
  birthYear?: number;
  deathYear?: number;
  parentIds: string[];
  partnerIds: string[];
  important: boolean;
  summary: string;
};

export type FamilyProfile = {
  displayMode: "all" | "key";
  members: FamilyTreeMember[];
  displayFlag?: boolean;
  displayCoatOfArms?: boolean;
  flagAssetId?: string;
  coatOfArmsAssetId?: string;
};

export type OwnershipTargetType =
  "person" | "family" | "organization" | "faction" | "country";
export type ItemOwnershipPeriod = TimeRange & {
  id: string;
  ownerType: OwnershipTargetType;
  ownerId: string;
  note: string;
};
export type ItemProfile = {
  itemType: string;
  origin: string;
  condition: string;
  ownershipHistory: ItemOwnershipPeriod[];
};

export type HeraldicAssetKind = "flag" | "coatOfArms";
export type HeraldicAssetSource = "generated" | "upload";
export type FlagShape = "square" | "rectangle" | "pennant" | "triangle";
export type CoatShape = "shield" | "circle" | "square" | "triangle" | "diamond";
export type HeraldicPattern = "solid" | "stripes" | "grid" | "checkered";
export type HeraldicSymbol =
  | "none"
  | "spade"
  | "diamond"
  | "palm"
  | "castle"
  | "spear"
  | "sword"
  | "circle"
  | "crown"
  | "cross"
  | "star"
  | "crescent_star"
  | "iron_cross"
  | "heart"
  | "fortress_wall";
export type HeraldicAsset = {
  id: string;
  kind: HeraldicAssetKind;
  name: string;
  source: HeraldicAssetSource;
  imageDataUrl?: string;
  shape: FlagShape | CoatShape;
  pattern: HeraldicPattern;
  symbol: HeraldicSymbol;
  backgroundColor: string;
  patternColor: string;
  symbolColor: string;
  /** 무늬 간격·크기 배율. */
  patternScale?: number;
  /** 중앙 문양 크기 배율. */
  symbolScale?: number;
  /** 중앙 기준 문양 위치(-1~1). */
  symbolOffsetX?: number;
  symbolOffsetY?: number;
  createdAt: string;
  updatedAt: string;
};

export type GovernmentProfile = {
  /** 국가 고유명 뒤에 자동으로 붙는 체제 명칭. */
  countryNameSuffix: string;
};

export type ReligionProfile = {
  foundingYear?: number;
  leaderTitle: string;
  symbol: string;
  alignment: string;
  relatedOrganizationIds: string[];
};

/** 역법의 날짜 계층. 첫 항목은 연, 마지막 항목은 절대적인 하루다. */
export type CalendarDateUnit = {
  id: string;
  name: string;
  shortName: string;
  /** 이 단위의 상위 단위 하나에 포함되는 개수. 첫 항목에서는 사용하지 않는다. */
  unitsPerParent: number;
};

/** 역법의 시간 계층. 첫 항목은 하루에 포함되는 개수, 이후는 상위 단위 하나에 포함되는 개수다. */
export type CalendarTimeUnit = {
  id: string;
  name: string;
  shortName: string;
  unitsPerParent: number;
};

export type CalendarDisplayMode = "signed" | "era";
export type CalendarProfile = {
  creator: string;
  createdAtYear?: number;
  userFactionIds: string[];
  mechanism: string;
  calendarName: string;
  displayMode: CalendarDisplayMode;
  beforeEraName: string;
  afterEraName: string;
  beforeEraShortName: string;
  afterEraShortName: string;
  /** 이 역법의 1년이 절대적인 하루 몇 개로 구성되는지 결정하는 기준점. */
  epochWorldYear: number;
  dateUnits: CalendarDateUnit[];
  timeUnits: CalendarTimeUnit[];
};

export type WorldSettings = {
  /** 세계가 항성을 한 바퀴 공전하는 절대적인 하루 수. */
  orbitalPeriodDays: number;
  simulationMode: SimulationMode;
  environmentEngine: EnvironmentEngineMode;
  latitudeDeg: number;
  axialTiltDeg: number;
  dayLengthHours: number;
  gravityMs2: number;
};

export type SuitabilityBand =
  "very_low" | "low" | "moderate" | "high" | "very_high";
export type AgricultureAssessment = {
  id: string;
  kind: "crop" | "livestock";
  name: string;
  suitability: number;
  band: SuitabilityBand;
  productionIndex: number;
  activeMonths: number;
  waterDemandIndex: number;
  riskLabels: string[];
  strengths: string[];
  explanation: string;
};
export type EnvironmentSimulationSummary = {
  generatedAt: string;
  mode: SimulationMode;
  meanTemperatureC: number;
  meanPrecipitationMm: number;
  meanHumidityPercent: number;
  meanSolarHours: number;
  meanWindSpeed: number;
  cropAssessments: AgricultureAssessment[];
  livestockAssessments: AgricultureAssessment[];
  notes: string[];
  /** v0.98a부터 선택 지점 결과를 저장할 때 사용한다. */
  locationContext?: {
    mapId: string;
    position: Point;
    month: number;
    year: number;
    label?: string;
  };
};

export type WikiEntityType = "location" | "event" | "faction" | "territory";
export type WikiArticle = {
  id: string;
  title: string;
  /** v0.6 이하 파일 호환용 분류 키 */
  category: WikiCategory;
  /** null이면 프로젝트 탐색기의 고정 '미지정' 부문에 표시된다. */
  categoryId: string | null;
  summary: string;
  content: string;
  tags: string[];
  linkedMapEntityIds: string[];
  sourceMapId?: string;
  sourceEntityId?: string;
  sourceEntityType?: WikiEntityType;
  autoGenerated?: boolean;
  /** 자동 동기화 문서에서 사용자가 직접 편집한 표시 제목·요약을 보존한다. */
  manualTitle?: boolean;
  manualSummary?: boolean;
  eventCategory?: EventCategory;
  /** 지도 엔티티와 연결되지 않은 특수 사건 템플릿의 내장 데이터. */
  eventProfile?: WorldEvent;
  /** 지도 엔티티와 연결되지 않은 국가·세력·단체 템플릿의 내장 데이터. */
  factionProfile?: Faction;
  personProfile?: PersonProfile;
  familyProfile?: FamilyProfile;
  itemProfile?: ItemProfile;
  religionProfile?: ReligionProfile;
  governmentProfile?: GovernmentProfile;
  calendarProfile?: CalendarProfile;
  createdDate: string;
  lastModifiedDate: string;
};

export type LayerVisibility = {
  terrain: boolean;
  contours: boolean;
  coastline: boolean;
  territories: boolean;
  rivers: boolean;
  roads: boolean;
  locations: boolean;
  labels: boolean;
  events: boolean;
  windDirection: boolean;
  countryNames: boolean;
  windSpeed: boolean;
  temperature: boolean;
  precipitation: boolean;
  humidity: boolean;
  solarHours: boolean;
  solarIrradiance: boolean;
  snowfall: boolean;
  evapotranspiration: boolean;
  soilMoisture: boolean;
};

export type EditorTool =
  | "select"
  | "terrain"
  | "elevation"
  | "location"
  | "label"
  | "road"
  | "river"
  | "territory"
  | "event";

export type GeneratorSeedRecord = {
  seed: number;
  settings: GeneratorSettings;
  usedAt: string;
};

export type EnvironmentPin = {
  id: string;
  name: string;
  position: Point;
  createdAt: string;
};

export type MapData = {
  id: string;
  title: string;
  /** 지도마다 독립적으로 선택하는 생성 엔진. */
  generationMode: SimulationMode;
  /** 지방·지역·대륙·세계의 물리적 축척 구분. */
  scaleMode: MapScaleMode;
  /** 지도의 실제 가로 폭(km). */
  physicalWidthKm: number;
  /** 지도별 마지막 편집 작업 모드. */
  editorMode: MapEditorMode;
  width: number;
  height: number;
  createdDate: string;
  lastModifiedDate: string;
  timeline: TimelineState;
  generatedStates: TemporalState<GeneratedMapData | null>[];
  terrains: Terrain[];
  contourLines: ContourLine[];
  locations: Location[];
  roads: Road[];
  rivers: River[];
  mountains: Mountain[];
  placeNames: PlaceName[];
  factions: Faction[];
  territories: Territory[];
  events: WorldEvent[];
  generatorSeedHistory: GeneratorSeedRecord[];
  /** 환경 탭에서 고정해 비교하는 좌표 핀. */
  environmentPins: EnvironmentPin[];
};

export type ThemeMode = "light" | "dark";

export type WorldUiSettings = {
  /** 0.50~1.50 범위의 전역 폰트 배율. */
  fontScale: number;
  /** 문서·탐색기·입력창에 실제 적용되는 전역 글꼴. */
  fontFamily: string;
};

export type WorldProject = {
  version: typeof PROGRAM_VERSION;
  id: string;
  title: string;
  description: string;
  theme: ThemeMode;
  uiSettings: WorldUiSettings;
  worldSettings: WorldSettings;
  simulationSummaries: Record<string, EnvironmentSimulationSummary>;
  /** null이면 세계 기준 연도, 값이 있으면 해당 역법으로 타임라인을 표시한다. */
  timelineCalendarArticleId: string | null;
  createdDate: string;
  lastModifiedDate: string;
  maps: MapData[];
  activeMapId: string | null;
  wikiArticles: WikiArticle[];
  wikiCategories: WikiCategoryDefinition[];
  linkedTextFields: Record<string, string>;
  /** 프로젝트에서 재사용하는 깃발·문장 자산 라이브러리. */
  heraldicAssets: HeraldicAsset[];
};

export type WorkspaceTabType =
  | "home"
  | "map"
  | "wiki"
  | "timeline"
  | "generator"
  | "simulation"
  | "settings";
export type WorkspaceTab = {
  id: string;
  type: WorkspaceTabType;
  title: string;
  mapId?: string;
  /** 위키 탭이 표시할 프로젝트 카테고리. null은 미지정 부문. */
  wikiCategoryId?: string | null;
  wikiEventCategory?: EventCategory | "all";
  wikiArticleId?: string;
};

export function createId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function isYearInRange(range: TimeRange, year: number): boolean {
  return (
    year >= range.startYear && (range.endYear === null || year <= range.endYear)
  );
}

export function getStateAtYear<T>(
  states: TemporalState<T>[],
  year: number,
): T | undefined {
  return states
    .filter((state) => isYearInRange(state, year))
    .sort((a, b) => b.startYear - a.startYear)[0]?.value;
}

export function getTemporalRecordAtYear<T>(
  states: TemporalState<T>[],
  year: number,
): TemporalState<T> | undefined {
  return states
    .filter((state) => isYearInRange(state, year))
    .sort((a, b) => b.startYear - a.startYear)[0];
}

/**
 * 현재 연도의 편집을 새 역사 상태로 기록한다.
 * 기존 상태 중간에서 편집하면 이전 상태는 전년도까지 유지되고,
 * 새 상태는 편집 연도부터 기존 종료 연도까지 적용된다.
 */
export function upsertTemporalStateAtYear<T>(
  states: TemporalState<T>[],
  year: number,
  value: T,
): TemporalState<T>[] {
  const sorted = [...states].sort((a, b) => a.startYear - b.startYear);
  const activeIndex = sorted.findIndex((state) => isYearInRange(state, year));

  if (activeIndex >= 0) {
    const active = sorted[activeIndex];
    if (active.startYear === year) {
      sorted[activeIndex] = { ...active, value };
      return sorted;
    }

    const previous: TemporalState<T> = {
      ...active,
      endYear: year - 1,
    };
    const next: TemporalState<T> = {
      startYear: year,
      endYear: active.endYear,
      value,
    };
    sorted.splice(activeIndex, 1, previous, next);
    return sorted;
  }

  const nextState = sorted.find((state) => state.startYear > year);
  sorted.push({
    startYear: year,
    endYear: nextState ? nextState.startYear - 1 : null,
    value,
  });
  return sorted.sort((a, b) => a.startYear - b.startYear);
}

export function latestTemporalState<T>(
  states: TemporalState<T>[],
): TemporalState<T> | undefined {
  return [...states].sort((a, b) => b.startYear - a.startYear)[0];
}

export function terrainAtYear(terrain: Terrain, year: number): TerrainState {
  return getStateAtYear(terrain.changes, year) ?? terrain.baseState;
}

export function generatedAtYear(
  map: MapData,
  year = map.timeline.currentYear,
): GeneratedMapData | null {
  return getStateAtYear(map.generatedStates, year) ?? null;
}

export function visibleLocations(
  map: MapData,
): Array<{ location: Location; state: LocationState }> {
  const results: Array<{ location: Location; state: LocationState }> = [];
  for (const location of map.locations) {
    const state = getStateAtYear(location.states, map.timeline.currentYear);
    if (state && state.status !== "destroyed")
      results.push({ location, state });
  }
  return results;
}

export function visibleTerritories(
  map: MapData,
): Array<{ territory: Territory; state: TerritoryState }> {
  const results: Array<{ territory: Territory; state: TerritoryState }> = [];
  for (const territory of map.territories) {
    const state = getStateAtYear(territory.states, map.timeline.currentYear);
    if (!state) continue;
    const owner = state.ownerFactionId
      ? map.factions.find((faction) => faction.id === state.ownerFactionId)
      : undefined;
    if (owner && owner.kind !== "country" && owner.hasTerritory !== true)
      continue;
    if (owner?.territoryHidden === true) continue;
    results.push({ territory, state });
  }
  return results;
}

export function currentEvents(map: MapData): WorldEvent[] {
  return map.events.filter(
    (event) =>
      !event.startTimeUnknown && isYearInRange(event, map.timeline.currentYear),
  );
}

export function pointInPolygon(point: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const xi = polygon[i]?.x ?? 0;
    const yi = polygon[i]?.y ?? 0;
    const xj = polygon[j]?.x ?? 0;
    const yj = polygon[j]?.y ?? 0;
    const intersects =
      yi > point.y !== yj > point.y &&
      point.x < ((xj - xi) * (point.y - yi)) / Math.max(1e-9, yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

export function pointInTerritoryState(
  point: Point,
  state: TerritoryState,
): boolean {
  return (
    pointInPolygon(point, state.polygon) &&
    !(state.holes ?? []).some((hole) => pointInPolygon(point, hole))
  );
}

export type FactionMetricPoint = {
  year: number;
  population: number;
  economy: number;
  locationCount: number;
};

/** 국가의 시대별 인구·경제력은 해당 연도 영토 안의 장소 상태를 합산한다. */
export function factionMetricTimeline(
  map: MapData,
  factionId: string,
): FactionMetricPoint[] {
  const years = new Set<number>([
    map.timeline.minimumYear,
    map.timeline.currentYear,
  ]);
  for (const territory of map.territories)
    for (const state of territory.states) {
      years.add(state.startYear);
      if (state.endYear !== null) years.add(state.endYear);
    }
  for (const location of map.locations)
    for (const state of location.states) {
      years.add(state.startYear);
      if (state.endYear !== null) years.add(state.endYear);
    }
  return [...years]
    .filter(
      (year) =>
        year >= map.timeline.minimumYear && year <= map.timeline.maximumYear,
    )
    .sort((a, b) => a - b)
    .map((year) => {
      const territoryStates = map.territories
        .map((territory) => getStateAtYear(territory.states, year))
        .filter((state): state is TerritoryState =>
          Boolean(state && state.ownerFactionId === factionId),
        );
      let population = 0;
      let economy = 0;
      let locationCount = 0;
      for (const location of map.locations) {
        const state = getStateAtYear(location.states, year);
        if (!state || state.status === "destroyed") continue;
        const isInside =
          territoryStates.length > 0
            ? territoryStates.some((territoryState) =>
                pointInTerritoryState(state.position, territoryState),
              )
            : state.ownerFactionId === factionId;
        if (!isInside) continue;
        population += state.population ?? 0;
        economy += state.economy ?? 0;
        locationCount += 1;
      }
      return { year, population, economy, locationCount };
    });
}

export function worldYearLengthDays(project: WorldProject): number {
  return Math.max(1, Math.round(project.worldSettings.orbitalPeriodDays));
}

export function worldDayLengthMinutes(project: WorldProject): number {
  return Math.max(1, Math.round(project.worldSettings.dayLengthHours * 60));
}

export function normalizeTimelineMoment(
  project: WorldProject,
  timeline: TimelineState,
): TimelineState {
  const yearLength = worldYearLengthDays(project);
  const dayLength = worldDayLengthMinutes(project);
  let year = Math.trunc(
    Number.isFinite(timeline.currentYear) ? timeline.currentYear : 0,
  );
  let day = Math.trunc(
    Number.isFinite(timeline.currentDayOfYear) ? timeline.currentDayOfYear : 0,
  );
  let minute = Math.trunc(
    Number.isFinite(timeline.currentMinuteOfDay)
      ? timeline.currentMinuteOfDay
      : 0,
  );
  if (minute >= dayLength || minute < 0) {
    day += Math.floor(minute / dayLength);
    minute = ((minute % dayLength) + dayLength) % dayLength;
  }
  if (day >= yearLength || day < 0) {
    year += Math.floor(day / yearLength);
    day = ((day % yearLength) + yearLength) % yearLength;
  }
  return {
    ...timeline,
    currentYear: year,
    currentDayOfYear: day,
    currentMinuteOfDay: minute,
  };
}

export function timelineAbsoluteMinute(
  project: WorldProject,
  timeline: TimelineState,
): number {
  const normalized = normalizeTimelineMoment(project, timeline);
  const yearLength = worldYearLengthDays(project);
  const dayLength = worldDayLengthMinutes(project);
  return (
    (normalized.currentYear * yearLength + normalized.currentDayOfYear) *
      dayLength +
    normalized.currentMinuteOfDay
  );
}

export function timelineFromAbsoluteMinute(
  project: WorldProject,
  absoluteMinute: number,
  base: TimelineState,
): TimelineState {
  const yearLength = worldYearLengthDays(project);
  const dayLength = worldDayLengthMinutes(project);
  const totalDay = Math.floor(absoluteMinute / dayLength);
  const minute =
    ((Math.trunc(absoluteMinute) % dayLength) + dayLength) % dayLength;
  const year = Math.floor(totalDay / yearLength);
  const day = ((totalDay % yearLength) + yearLength) % yearLength;
  return {
    ...base,
    currentYear: year,
    currentDayOfYear: day,
    currentMinuteOfDay: minute,
  };
}

export function timelineRangePercent(
  project: WorldProject,
  timeline: TimelineState,
  minimumYear: number,
  maximumYear: number,
): number {
  const normalized = normalizeTimelineMoment(project, timeline);
  const safePercent = (value: number, maximumIndex: number) =>
    maximumIndex <= 0
      ? 0
      : Math.max(0, Math.min(100, (value / maximumIndex) * 100));
  if (normalized.precision === "year")
    return safePercent(
      normalized.currentYear - minimumYear,
      maximumYear - minimumYear,
    );

  const yearLength = worldYearLengthDays(project);
  const yearOffset = normalized.currentYear - minimumYear;
  if (normalized.precision === "month") {
    const month = standardMonthDay(project, normalized.currentDayOfYear).month;
    const monthIndex = yearOffset * 12 + (month - 1);
    return safePercent(monthIndex, (maximumYear - minimumYear + 1) * 12 - 1);
  }
  if (normalized.precision === "week" || normalized.precision === "date") {
    const dayIndex = yearOffset * yearLength + normalized.currentDayOfYear;
    return safePercent(
      dayIndex,
      (maximumYear - minimumYear + 1) * yearLength - 1,
    );
  }

  const dayLength = worldDayLengthMinutes(project);
  const minuteIndex =
    (yearOffset * yearLength + normalized.currentDayOfYear) * dayLength +
    normalized.currentMinuteOfDay;
  return safePercent(
    minuteIndex,
    (maximumYear - minimumYear + 1) * yearLength * dayLength - 1,
  );
}

export function timelineAtRangePercent(
  project: WorldProject,
  timeline: TimelineState,
  minimumYear: number,
  maximumYear: number,
  percent: number,
): TimelineState {
  const normalizedPercent = Math.max(0, Math.min(100, percent)) / 100;
  if (timeline.precision === "year") {
    const currentYear =
      minimumYear + Math.round((maximumYear - minimumYear) * normalizedPercent);
    return {
      ...timeline,
      currentYear,
      currentDayOfYear: 0,
      currentMinuteOfDay: 0,
    };
  }

  const yearLength = worldYearLengthDays(project);
  if (timeline.precision === "month") {
    const maximumMonthIndex = (maximumYear - minimumYear + 1) * 12 - 1;
    const monthIndex = Math.round(maximumMonthIndex * normalizedPercent);
    const currentYear = minimumYear + Math.floor(monthIndex / 12);
    const month = (monthIndex % 12) + 1;
    return {
      ...timeline,
      currentYear,
      currentDayOfYear: standardDayOfYear(project, month, 1),
      currentMinuteOfDay: 0,
    };
  }
  if (timeline.precision === "week" || timeline.precision === "date") {
    const maximumDayIndex = (maximumYear - minimumYear + 1) * yearLength - 1;
    const rawDayIndex = Math.round(maximumDayIndex * normalizedPercent);
    const dayIndex = timeline.precision === "week" ? Math.round(rawDayIndex / 7) * 7 : rawDayIndex;
    const boundedDayIndex = Math.max(0, Math.min(maximumDayIndex, dayIndex));
    return {
      ...timeline,
      currentYear: minimumYear + Math.floor(boundedDayIndex / yearLength),
      currentDayOfYear: boundedDayIndex % yearLength,
      currentMinuteOfDay: 0,
    };
  }

  const dayLength = worldDayLengthMinutes(project);
  const maximumMinuteIndex =
    (maximumYear - minimumYear + 1) * yearLength * dayLength - 1;
  const minuteIndex = Math.round(maximumMinuteIndex * normalizedPercent);
  const dayIndex = Math.floor(minuteIndex / dayLength);
  return {
    ...timeline,
    currentYear: minimumYear + Math.floor(dayIndex / yearLength),
    currentDayOfYear: dayIndex % yearLength,
    currentMinuteOfDay: minuteIndex % dayLength,
  };
}

export function advanceTimeline(
  project: WorldProject,
  timeline: TimelineState,
  minimumYear: number,
  maximumYear: number,
): TimelineState {
  const normalized = normalizeTimelineMoment(project, timeline);
  const yearLength = worldYearLengthDays(project);
  const dayLength = worldDayLengthMinutes(project);
  const maximum = (maximumYear + 1) * yearLength * dayLength - 1;
  if (normalized.precision === "month") {
    const currentMonth = standardMonthDay(project, normalized.currentDayOfYear).month;
    const nextMonthIndex = normalized.currentYear * 12 + currentMonth;
    const nextYear = Math.floor(nextMonthIndex / 12);
    const nextMonth = (nextMonthIndex % 12) + 1;
    const atEnd = nextYear > maximumYear;
    return {
      ...normalized,
      currentYear: atEnd ? maximumYear : nextYear,
      currentDayOfYear: standardDayOfYear(project, atEnd ? 12 : nextMonth, 1),
      currentMinuteOfDay: 0,
      isPlaying: !atEnd,
    };
  }
  const step =
    normalized.precision === "year"
      ? yearLength * dayLength
      : normalized.precision === "week"
        ? dayLength * 7
        : normalized.precision === "date"
          ? dayLength
          : 1;
  const nextAbsolute = Math.min(
    maximum,
    timelineAbsoluteMinute(project, normalized) + step,
  );
  const next = timelineFromAbsoluteMinute(project, nextAbsolute, normalized);
  return { ...next, isPlaying: nextAbsolute < maximum };
}

export function standardMonthDay(
  project: WorldProject,
  dayOfYear: number,
): { month: number; day: number; daysInMonth: number } {
  const yearLength = worldYearLengthDays(project);
  const normalizedDay = Math.max(
    0,
    Math.min(yearLength - 1, Math.trunc(dayOfYear)),
  );
  const month = Math.min(12, Math.floor((normalizedDay * 12) / yearLength) + 1);
  const start = Math.floor(((month - 1) * yearLength) / 12);
  const end = Math.floor((month * yearLength) / 12);
  return {
    month,
    day: normalizedDay - start + 1,
    daysInMonth: Math.max(1, end - start),
  };
}

export function standardDayOfYear(
  project: WorldProject,
  month: number,
  day: number,
): number {
  const yearLength = worldYearLengthDays(project);
  const safeMonth = Math.max(1, Math.min(12, Math.trunc(month)));
  const start = Math.floor(((safeMonth - 1) * yearLength) / 12);
  const end = Math.floor((safeMonth * yearLength) / 12);
  return Math.max(
    start,
    Math.min(end - 1, start + Math.max(1, Math.trunc(day)) - 1),
  );
}

function paddedWorldYear(year: number): string {
  // 표준 공전 주기는 연도 앞에 불필요한 0을 붙이지 않는다.
  return String(Math.trunc(year));
}

export function displayedCalendarArticle(
  project: WorldProject,
): WikiArticle | null {
  return (
    calendarArticles(project).find(
      (article) => article.id === project.timelineCalendarArticleId,
    ) ?? null
  );
}

function calendarYearAndDayFromAbsoluteDay(
  project: WorldProject,
  profile: CalendarProfile,
  absoluteDay: number,
): { signedYear: number; dayOfYear: number; yearLength: number } {
  const yearLength = calendarYearLengthDays(profile);
  const epochDay = worldYearToAbsoluteDay(project, profile.epochWorldYear);
  const delta = absoluteDay - epochDay;
  if (delta >= 0)
    return {
      signedYear: Math.floor(delta / yearLength) + 1,
      dayOfYear: delta % yearLength,
      yearLength,
    };
  const distance = Math.abs(delta);
  const signedYear = -Math.ceil(distance / yearLength);
  const remainder = distance % yearLength;
  return {
    signedYear,
    dayOfYear: remainder === 0 ? 0 : yearLength - remainder,
    yearLength,
  };
}

export function formatTimelineMoment(
  project: WorldProject,
  timeline: TimelineState,
  article: WikiArticle | null = displayedCalendarArticle(project),
): string {
  const normalized = normalizeTimelineMoment(project, timeline);
  const precision = normalized.precision;
  const dayLength = worldDayLengthMinutes(project);
  if (!article?.calendarProfile) {
    const date = standardMonthDay(project, normalized.currentDayOfYear);
    const hour = Math.floor(normalized.currentMinuteOfDay / 60);
    const minute = normalized.currentMinuteOfDay % 60;
    if (precision === "year")
      return `${paddedWorldYear(normalized.currentYear)}년`;
    if (precision === "month")
      return `${paddedWorldYear(normalized.currentYear)}년 ${String(date.month).padStart(2, "0")}월`;
    if (precision === "week")
      return `${paddedWorldYear(normalized.currentYear)}년 ${String(date.month).padStart(2, "0")}월 ${String(date.day).padStart(2, "0")}일 주간`;
    if (precision === "date")
      return `${paddedWorldYear(normalized.currentYear)}년 ${String(date.month).padStart(2, "0")}월 ${String(date.day).padStart(2, "0")}일`;
    return `${paddedWorldYear(normalized.currentYear)}년 ${String(date.month).padStart(2, "0")}월 ${String(date.day).padStart(2, "0")}일 ${String(hour).padStart(2, "0")}시 ${String(minute).padStart(2, "0")}분`;
  }
  const profile = article.calendarProfile;
  const absoluteDay =
    normalized.currentYear * worldYearLengthDays(project) +
    normalized.currentDayOfYear;
  const { signedYear, dayOfYear } = calendarYearAndDayFromAbsoluteDay(
    project,
    profile,
    absoluteDay,
  );
  const units = profile.dateUnits;
  const parts: string[] = [];
  if (profile.displayMode === "era") {
    const eraLabel =
      signedYear < 0
        ? profile.beforeEraShortName || profile.beforeEraName || "이전"
        : profile.afterEraShortName || profile.afterEraName || "이후";
    parts.push(
      eraLabel,
      `${Math.abs(signedYear)}${units[0]?.shortName || "년"}`,
    );
  } else
    parts.push(
      `${profile.calendarName || article.title} ${signedYear}${units[0]?.shortName || "년"}`,
    );
  if (precision !== "year") {
    let remainder = dayOfYear;
    const lastDateUnit = precision === "month" ? Math.min(1, units.length - 1) : units.length - 1;
    for (let index = 1; index <= lastDateUnit; index += 1) {
      const lowerProduct = units
        .slice(index + 1)
        .reduce(
          (total, unit) => total * Math.max(1, Math.round(unit.unitsPerParent)),
          1,
        );
      const value = Math.floor(remainder / lowerProduct) + 1;
      remainder %= lowerProduct;
      parts.push(
        `${value}${units[index]?.shortName || units[index]?.name || ""}`,
      );
    }
  }
  if (precision === "week") parts.push("주간");
  if (precision === "time") {
    const fraction = normalized.currentMinuteOfDay / dayLength;
    let remainder = fraction;
    for (const unit of profile.timeUnits) {
      const count = Math.max(1, Math.round(unit.unitsPerParent));
      const value = Math.floor(remainder * count);
      remainder = remainder * count - value;
      parts.push(
        `${String(value).padStart(2, "0")}${unit.shortName || unit.name}`,
      );
    }
  }
  return parts.join(" ");
}

export function createDefaultCalendarProfile(): CalendarProfile {
  return {
    creator: "",
    createdAtYear: 0,
    userFactionIds: [],
    mechanism: "",
    calendarName: "새 역법",
    displayMode: "signed",
    beforeEraName: "역법 이전",
    afterEraName: "역법 이후",
    beforeEraShortName: "",
    afterEraShortName: "",
    epochWorldYear: 0,
    dateUnits: [
      {
        id: createId("calendar-date-unit"),
        name: "년",
        shortName: "년",
        unitsPerParent: 1,
      },
      {
        id: createId("calendar-date-unit"),
        name: "월",
        shortName: "월",
        unitsPerParent: 12,
      },
      {
        id: createId("calendar-date-unit"),
        name: "일",
        shortName: "일",
        unitsPerParent: 30,
      },
    ],
    timeUnits: [
      {
        id: createId("calendar-time-unit"),
        name: "시",
        shortName: "시",
        unitsPerParent: 24,
      },
      {
        id: createId("calendar-time-unit"),
        name: "분",
        shortName: "분",
        unitsPerParent: 60,
      },
      {
        id: createId("calendar-time-unit"),
        name: "초",
        shortName: "초",
        unitsPerParent: 60,
      },
    ],
  };
}

export function calendarArticles(project: WorldProject): WikiArticle[] {
  const calendarCategoryIds = new Set(
    project.wikiCategories
      .filter((category) => category.systemKey === "calendar")
      .map((category) => category.id),
  );
  return project.wikiArticles.filter(
    (article) =>
      Boolean(article.calendarProfile) ||
      article.category === "calendar" ||
      (article.categoryId
        ? calendarCategoryIds.has(article.categoryId)
        : false),
  );
}

/** 역법 1년을 구성하는 절대적인 하루 수. */
export function calendarYearLengthDays(profile: CalendarProfile): number {
  const units =
    profile.dateUnits.length >= 2
      ? profile.dateUnits
      : createDefaultCalendarProfile().dateUnits;
  return Math.max(
    1,
    Math.round(
      units
        .slice(1)
        .reduce(
          (total, unit) => total * Math.max(1, Math.round(unit.unitsPerParent)),
          1,
        ),
    ),
  );
}

export function worldYearToAbsoluteDay(
  project: WorldProject,
  worldYear: number,
): number {
  return Math.round(
    worldYear * Math.max(1, project.worldSettings.orbitalPeriodDays),
  );
}

function calendarYearAndDay(
  project: WorldProject,
  profile: CalendarProfile,
  worldYear: number,
): { signedYear: number; dayOfYear: number; yearLength: number } {
  const yearLength = calendarYearLengthDays(profile);
  const epochDay = worldYearToAbsoluteDay(project, profile.epochWorldYear);
  const delta = worldYearToAbsoluteDay(project, worldYear) - epochDay;
  if (delta >= 0)
    return {
      signedYear: Math.floor(delta / yearLength) + 1,
      dayOfYear: delta % yearLength,
      yearLength,
    };
  const distance = Math.abs(delta);
  const signedYear = -Math.ceil(distance / yearLength);
  const remainder = distance % yearLength;
  return {
    signedYear,
    dayOfYear: remainder === 0 ? 0 : yearLength - remainder,
    yearLength,
  };
}

export type ActiveCalendarFields = {
  year: number;
  dateValues: number[];
  timeValues: number[];
  dateLabels: string[];
  timeLabels: string[];
  calendarName: string;
  usesCustomCalendar: boolean;
};

/** 표준 타임라인 시점을 현재 활성 역법의 편집 필드로 변환한다. */
export function activeCalendarFieldsFromTimeline(
  project: WorldProject,
  timeline: TimelineState,
  article: WikiArticle | null = displayedCalendarArticle(project),
): ActiveCalendarFields {
  const normalized = normalizeTimelineMoment(project, timeline);
  if (!article?.calendarProfile) {
    const date = standardMonthDay(project, normalized.currentDayOfYear);
    return {
      year: normalized.currentYear,
      dateValues: [date.month, date.day],
      timeValues: [
        Math.floor(normalized.currentMinuteOfDay / 60),
        normalized.currentMinuteOfDay % 60,
      ],
      dateLabels: ["월", "일"],
      timeLabels: ["시", "분"],
      calendarName: "세계 기준",
      usesCustomCalendar: false,
    };
  }
  const profile = article.calendarProfile;
  const absoluteDay =
    normalized.currentYear * worldYearLengthDays(project) +
    normalized.currentDayOfYear;
  const { signedYear, dayOfYear } = calendarYearAndDayFromAbsoluteDay(
    project,
    profile,
    absoluteDay,
  );
  let remainder = dayOfYear;
  const dateValues = profile.dateUnits.slice(1).map((unit, offset) => {
    const index = offset + 1;
    const lowerProduct = profile.dateUnits
      .slice(index + 1)
      .reduce(
        (total, lower) => total * Math.max(1, Math.round(lower.unitsPerParent)),
        1,
      );
    const value = Math.floor(remainder / lowerProduct) + 1;
    remainder %= lowerProduct;
    return value;
  });
  const dayLength = worldDayLengthMinutes(project);
  let fraction = normalized.currentMinuteOfDay / dayLength;
  const timeValues = profile.timeUnits.map((unit) => {
    const count = Math.max(1, Math.round(unit.unitsPerParent));
    const value = Math.floor(fraction * count);
    fraction = fraction * count - value;
    return value;
  });
  return {
    year: signedYear,
    dateValues,
    timeValues,
    dateLabels: profile.dateUnits
      .slice(1)
      .map((unit) => unit.shortName || unit.name),
    timeLabels: profile.timeUnits.map((unit) => unit.shortName || unit.name),
    calendarName: profile.calendarName || article.title,
    usesCustomCalendar: true,
  };
}

/** 활성 역법의 편집 필드를 표준 타임라인 시점으로 환산한다. */
export function timelineFromActiveCalendarFields(
  project: WorldProject,
  base: TimelineState,
  fields: Pick<ActiveCalendarFields, "year" | "dateValues" | "timeValues">,
  article: WikiArticle | null = displayedCalendarArticle(project),
): TimelineState {
  if (!article?.calendarProfile) {
    const month = fields.dateValues[0] ?? 1;
    const day = fields.dateValues[1] ?? 1;
    const hour = fields.timeValues[0] ?? 0;
    const minute = fields.timeValues[1] ?? 0;
    return normalizeTimelineMoment(project, {
      ...base,
      currentYear: Math.trunc(fields.year),
      currentDayOfYear: standardDayOfYear(project, month, day),
      currentMinuteOfDay: hour * 60 + minute,
    });
  }
  const profile = article.calendarProfile;
  const yearLength = calendarYearLengthDays(profile);
  const signedYear = Math.trunc(Number.isFinite(fields.year) ? fields.year : 1);
  let dayOfYear = 0;
  for (let offset = 0; offset < profile.dateUnits.length - 1; offset += 1) {
    const index = offset + 1;
    const count = Math.max(
      1,
      Math.round(profile.dateUnits[index]?.unitsPerParent ?? 1),
    );
    const value = Math.max(
      1,
      Math.min(count, Math.trunc(fields.dateValues[offset] ?? 1)),
    );
    const lowerProduct = profile.dateUnits
      .slice(index + 1)
      .reduce(
        (total, lower) => total * Math.max(1, Math.round(lower.unitsPerParent)),
        1,
      );
    dayOfYear += (value - 1) * lowerProduct;
  }
  dayOfYear = Math.max(0, Math.min(yearLength - 1, dayOfYear));
  const epochDay = worldYearToAbsoluteDay(project, profile.epochWorldYear);
  const yearStartDelta =
    signedYear >= 1 ? (signedYear - 1) * yearLength : signedYear * yearLength;
  const absoluteDay = epochDay + yearStartDelta + dayOfYear;
  let fraction = 0;
  let divisor = 1;
  profile.timeUnits.forEach((unit, index) => {
    const count = Math.max(1, Math.round(unit.unitsPerParent));
    divisor *= count;
    const value = Math.max(
      0,
      Math.min(count - 1, Math.trunc(fields.timeValues[index] ?? 0)),
    );
    fraction += value / divisor;
  });
  const absoluteMinute =
    absoluteDay * worldDayLengthMinutes(project) +
    Math.round(fraction * worldDayLengthMinutes(project));
  return normalizeTimelineMoment(
    project,
    timelineFromAbsoluteMinute(project, absoluteMinute, base),
  );
}

export function activeCalendarYearFromWorldYear(
  project: WorldProject,
  worldYear: number,
): number {
  const article = displayedCalendarArticle(project);
  if (!article?.calendarProfile) return worldYear;
  return activeCalendarFieldsFromTimeline(
    project,
    {
      minimumYear: worldYear,
      maximumYear: worldYear,
      currentYear: worldYear,
      currentDayOfYear: 0,
      currentMinuteOfDay: 0,
      precision: "year",
      isPlaying: false,
      playbackIntervalMs: 1000,
    },
    article,
  ).year;
}

export function worldYearFromActiveCalendarYear(
  project: WorldProject,
  displayedYear: number,
): number {
  const article = displayedCalendarArticle(project);
  if (!article?.calendarProfile) return Math.trunc(displayedYear);
  const timeline = timelineFromActiveCalendarFields(
    project,
    {
      minimumYear: -999999,
      maximumYear: 999999,
      currentYear: 0,
      currentDayOfYear: 0,
      currentMinuteOfDay: 0,
      precision: "year",
      isPlaying: false,
      playbackIntervalMs: 1000,
    },
    {
      year: displayedYear,
      dateValues: article.calendarProfile.dateUnits.slice(1).map(() => 1),
      timeValues: article.calendarProfile.timeUnits.map(() => 0),
    },
    article,
  );
  return timeline.currentYear;
}

export function formatCalendarYear(
  project: WorldProject,
  article: WikiArticle,
  worldYear: number,
): string {
  const profile = article.calendarProfile;
  if (!profile) return `${worldYear}년`;
  const { signedYear } = calendarYearAndDay(project, profile, worldYear);
  if (profile.displayMode === "era") {
    const label =
      signedYear < 0
        ? profile.beforeEraName || "이전"
        : profile.afterEraName || "이후";
    const shortLabel =
      signedYear < 0 ? profile.beforeEraShortName : profile.afterEraShortName;
    return `${shortLabel || label} ${Math.abs(signedYear)}${profile.dateUnits[0]?.shortName || "년"}`;
  }
  return `${profile.calendarName || article.title} ${signedYear}${profile.dateUnits[0]?.shortName || "년"}`;
}

/** 현재는 타임라인이 세계 연도 단위이므로, 선택한 세계 연도의 역법상 날짜를 표시한다. */
export function formatCalendarDate(
  project: WorldProject,
  article: WikiArticle,
  worldYear: number,
): string {
  const profile = article.calendarProfile;
  if (!profile) return `${worldYear}년`;
  const { signedYear, dayOfYear } = calendarYearAndDay(
    project,
    profile,
    worldYear,
  );
  const units = profile.dateUnits;
  const parts: string[] = [];
  if (profile.displayMode === "era") {
    const eraLabel =
      signedYear < 0
        ? profile.beforeEraShortName || profile.beforeEraName || "이전"
        : profile.afterEraShortName || profile.afterEraName || "이후";
    parts.push(eraLabel);
    parts.push(`${Math.abs(signedYear)}${units[0]?.shortName || "년"}`);
  } else {
    parts.push(
      `${profile.calendarName || article.title} ${signedYear}${units[0]?.shortName || "년"}`,
    );
  }
  let remainder = dayOfYear;
  for (let index = 1; index < units.length; index += 1) {
    const lowerProduct = units
      .slice(index + 1)
      .reduce(
        (total, unit) => total * Math.max(1, Math.round(unit.unitsPerParent)),
        1,
      );
    const value = Math.floor(remainder / lowerProduct) + 1;
    remainder %= lowerProduct;
    parts.push(
      `${value}${units[index]?.shortName || units[index]?.name || ""}`,
    );
  }
  return parts.join(" ");
}

function addBound(values: number[], value: unknown): void {
  if (typeof value === "number" && Number.isFinite(value))
    values.push(Math.trunc(value));
}

/** 지도와 세계관 문서에 실제로 기록된 가장 이른/늦은 연도로 타임라인 범위를 만든다. */
export function projectTemporalBounds(project: WorldProject): {
  minimumYear: number;
  maximumYear: number;
} {
  const years: number[] = [];
  for (const map of project.maps) {
    addBound(years, map.timeline.currentYear);
    for (const state of map.generatedStates) {
      addBound(years, state.startYear);
      addBound(years, state.endYear);
    }
    for (const terrain of map.terrains)
      for (const state of terrain.changes) {
        addBound(years, state.startYear);
        addBound(years, state.endYear);
      }
    for (const location of map.locations)
      for (const state of location.states) {
        addBound(years, state.startYear);
        addBound(years, state.endYear);
      }
    for (const territory of map.territories)
      for (const state of territory.states) {
        addBound(years, state.startYear);
        addBound(years, state.endYear);
      }
    for (const entry of [
      ...map.roads,
      ...map.rivers,
      ...map.mountains,
      ...map.placeNames,
    ]) {
      addBound(years, entry.startYear);
      addBound(years, entry.endYear);
    }
    for (const event of map.events) {
      if (!event.startTimeUnknown) {
        addBound(years, event.startYear);
        addBound(years, event.startDateTime?.year);
      }
      addBound(years, event.endYear);
      addBound(years, event.endDateTime?.year);
      for (const item of event.chronology) addBound(years, item.dateTime.year);
    }
  }
  for (const article of project.wikiArticles) {
    addBound(years, article.personProfile?.birthYear);
    addBound(years, article.personProfile?.deathYear);
    addBound(years, article.religionProfile?.foundingYear);
    addBound(years, article.calendarProfile?.createdAtYear);
    addBound(years, article.calendarProfile?.epochWorldYear);
    for (const period of article.itemProfile?.ownershipHistory ?? []) {
      addBound(years, period.startYear);
      addBound(years, period.endYear);
    }
    for (const member of article.familyProfile?.members ?? []) {
      addBound(years, member.birthYear);
      addBound(years, member.deathYear);
    }
  }
  if (years.length === 0) return { minimumYear: 0, maximumYear: 100 };
  years.push(0);
  let minimumYear = 0;
  let maximumYear = Math.max(...years);
  if (minimumYear === maximumYear) {
    minimumYear -= 1;
    maximumYear += 1;
  }
  return { minimumYear, maximumYear };
}

export function defaultGeneratorSettings(): GeneratorSettings {
  return {
    seed: 734521,
    algorithm: "hybrid",
    mapScope: "continent",
    localRegionType: "inland",
    mapShape: "supercontinent",
    mapScaleKm: 4200,
    latitudeDeg: 45,
    climatePreset: "Cfb",
    season: "summer",
    climateReferenceLatitudeDeg: 45,
    baseTemperatureC: 13,
    baseHumidity: 0.72,
    prevailingWindDirectionDeg: 270,
    prevailingWindSpeed: 6,
    cornerWinds: {
      northWest: { directionDeg: 250, speed: 7 },
      northEast: { directionDeg: 285, speed: 6 },
      southWest: { directionDeg: 235, speed: 5 },
      southEast: { directionDeg: 300, speed: 6 },
    },
    localBoundary: {
      north: [{ start: 0, end: 1, kind: "land" }],
      east: [{ start: 0, end: 1, kind: "land" }],
      south: [{ start: 0, end: 1, kind: "land" }],
      west: [{ start: 0, end: 1, kind: "land" }],
    },
    islandCount: 6,
    mountainGuide: {
      mode: "endpoints", path: [], startSide: "west", startOffset: 0.35,
      endSide: "east", endOffset: 0.65, width: 0.12, branchiness: 0.25,
    },
    riverGuide: {
      mode: "endpoints", path: [], startSide: "north", startOffset: 0.35,
      endSide: "south", endOffset: 0.68, width: 0.045, branchiness: 0.35,
    },
    basePrecipitationMm: 1050,
    annualTemperatureRangeC: 11,
    climateVariability: 0.55,
    climatePersistence: 0.72,
    extremeEventFrequency: 0.12,
    riverNodeCount: 120,
    riverNodeMaxElevation: 3200,
    worldCoordinateScale: 1,
    renderResolution: 2048,
    analysisResolution: 1024,
    tidalRangeM: 2.2,
    generateCountries: true,
    countryCount: 5,
    naturalBorderInfluence: 0.78,
    allowExclaves: false,
    maritimeCountryRatio: 0.3,
    nomadicCountryRatio: 0.15,
    mountainCountryRatio: 0.2,
    gridWidth: 1024,
    gridHeight: 512,
    continentCount: 3,
    landRatio: 0.48,
    coastlineDetail: 0.64,
    mountainStrength: 0.65,
    noiseStrength: 0.72,
    continentDynamics: 0.62,
    skeletonRepairPasses: 3,
    hybridWfcStrength: 0.65,
    hybridExtraEdgeRatio: 0.22,
    hybridPerlinWarp: 0.58,
    hybridPolygonRefinement: 1.5,
    coastSmoothness: 0.58,
    erosion: 0.55,
    temperature: 0,
    moisture: 0,
    contourInterval: 200,
    maxElevation: 6500,
    seaLevel: 0,
  };
}

export function createEmptyMap(
  title = "새 지도",
  width = 160,
  height = 100,
  generationMode: SimulationMode = "realistic",
  scaleMode: MapScaleMode = "continent",
  physicalWidthKm = 4200,
): MapData {
  const now = new Date().toISOString();
  return {
    id: createId("map"),
    title,
    generationMode,
    scaleMode,
    physicalWidthKm,
    editorMode: "view",
    width,
    height,
    createdDate: now,
    lastModifiedDate: now,
    timeline: {
      minimumYear: 0,
      maximumYear: 2000,
      currentYear: 0,
      currentDayOfYear: 0,
      currentMinuteOfDay: 0,
      precision: "year",
      isPlaying: false,
      playbackIntervalMs: 1000,
    },
    generatedStates: [],
    terrains: [],
    contourLines: [],
    locations: [],
    roads: [],
    rivers: [],
    mountains: [],
    placeNames: [],
    factions: [],
    territories: [],
    events: [],
    generatorSeedHistory: [],
    environmentPins: [],
  };
}

export function createEmptyProject(title = "새로운 세계"): WorldProject {
  const now = new Date().toISOString();
  return {
    version: PROGRAM_VERSION,
    id: createId("project"),
    title,
    description: "",
    theme:
      typeof localStorage !== "undefined" &&
      localStorage.getItem("world-map-editor-theme") === "light"
        ? "light"
        : "dark",
    uiSettings: {
      fontScale: Math.max(
        0.5,
        Math.min(
          1.5,
          Number(
            typeof localStorage !== "undefined"
              ? localStorage.getItem("world-archive-font-scale")
              : 1,
          ) || 1,
        ),
      ),
      fontFamily:
        (typeof localStorage !== "undefined"
          ? localStorage.getItem("world-archive-font-family")
          : null) || 'Inter, Pretendard, "Noto Sans KR", system-ui, sans-serif',
    },
    // simulationMode는 구버전 프로젝트 호환을 위해 남겨 두지만 새 지도 엔진 선택에는 사용하지 않는다.
    worldSettings: {
      orbitalPeriodDays: 365,
      simulationMode: "realistic",
      environmentEngine: "builtin",
      latitudeDeg: 38,
      axialTiltDeg: 23.44,
      dayLengthHours: 24,
      gravityMs2: 9.80665,
    },
    simulationSummaries: {},
    timelineCalendarArticleId: null,
    createdDate: now,
    lastModifiedDate: now,
    maps: [],
    activeMapId: null,
    wikiArticles: [],
    wikiCategories: createDefaultWikiCategories(),
    linkedTextFields: {},
    heraldicAssets: [],
  };
}

export function createDemoProject(): WorldProject {
  const project = createEmptyProject("에테리아 세계");
  const demoMap = createEmptyMap(
    "에테리아 500km 지역",
    160,
    100,
    "realistic",
    "regional",
    500,
  );
  project.maps = [demoMap];
  project.activeMapId = demoMap.id;
  project.worldSettings = {
    ...project.worldSettings,
    orbitalPeriodDays: 200,
    simulationMode: "realistic",
    latitudeDeg: 42,
  };
  const map = project.maps[0];
  map.timeline = {
    ...map.timeline,
    minimumYear: 0,
    maximumYear: 1800,
    currentYear: 1200,
  };
  const demoAureliaFlagId = createId("flag-asset");
  const demoEmberCoatId = createId("coat-asset");
  const demoSilverFlagId = createId("flag-asset");
  const demoFamilyCoatId = createId("coat-asset");

  const silver: Faction = {
    id: createId("faction"),
    kind: "faction",
    hasTerritory: false,
    territoryHidden: false,
    displayFlag: true,
    flagAssetId: demoSilverFlagId,
    foundedYear: 380,
    name: "실버동맹",
    color: "#8ea6c4",
    leaderName: "루나 여왕",
    leaderStatus: "selected",
    activityRange: "land_centered",
    summary: "서부 도시와 귀족 가문이 결성한 방위 동맹",
    description: "서부 교역로와 자유도시의 공동 방위를 위해 결성되었다.",
    groupProfile: {
      symbol: "은빛 초승달",
      ideology: "도시 자치와 상호 방위",
      alignment: "중도·방어적",
      goals: "서부 교역로와 자유도시 보호",
      headquartersLocationId: undefined,
      headquartersStatus: "undecided",
      languageArticleIds: [],
      languageCustom: "공용어",
    },
  };
  const ember: Faction = {
    id: createId("faction"),
    kind: "country",
    hasTerritory: true,
    displayCoatOfArms: true,
    coatOfArmsAssetId: demoEmberCoatId,
    foundedYear: 100,
    name: "적염제국",
    color: "#c75b4b",
    leaderName: "카르도스 3세",
    leaderStatus: "selected",
    activityRange: "land_only",
    summary: "남동부 화산지대의 중앙집권 제국",
    description: "화산석 도시와 중앙 관료제를 기반으로 성장했다.",
    countryProfile: {
      nameRoot: "적염",
      showRegimeSuffix: true,
      spaceBeforeRegimeSuffix: true,
      politicalSystem: "전제군주제",
      symbol: "붉은 불사조",
      languageArticleIds: [],
      languageCustom: "적염어, 공용어",
      cultureArticleIds: [],
      majorLocationIds: [],
    },
  };
  const aurelia: Faction = {
    id: createId("faction"),
    kind: "country",
    hasTerritory: true,
    displayFlag: true,
    flagAssetId: demoAureliaFlagId,
    foundedYear: 0,
    name: "아우렐리아 왕국",
    color: "#d6b85a",
    leaderName: "엘레나 2세",
    leaderStatus: "selected",
    activityRange: "land_centered",
    summary: "북부 고원과 곡창지대를 다스리는 왕국",
    description: "고원 요새와 농경 도시를 중심으로 형성되었다.",
    countryProfile: {
      nameRoot: "아우렐리아",
      showRegimeSuffix: true,
      spaceBeforeRegimeSuffix: true,
      politicalSystem: "입헌군주제",
      symbol: "황금 태양",
      languageArticleIds: [],
      languageCustom: "아우렐리아어",
      cultureArticleIds: [],
      majorLocationIds: [],
    },
  };
  const starOrder: Faction = {
    hasTerritory: false,
    territoryHidden: false,
    id: createId("faction"),
    kind: "organization",
    organizationType: "knight_order",
    foundedYear: 120,
    name: "별빛 기사단",
    color: "#9b8bd2",
    leaderName: "단장 에레스",
    leaderStatus: "selected",
    activityRange: "land_centered",
    summary: "고대 관문과 위험 유물을 수호하는 국제 기사단",
    description: "마도 유물의 봉인과 공동 관리를 맡는다.",
    groupProfile: {
      symbol: "일곱 갈래 별",
      ideology: "지식과 유물의 공공 수호",
      alignment: "질서·중립",
      goals: "고대 관문과 위험 유물 봉인",
      headquartersStatus: "selected",
      languageArticleIds: [],
      languageCustom: "공용어",
    },
  };
  const azureGuild: Faction = {
    hasTerritory: false,
    territoryHidden: false,
    id: createId("faction"),
    kind: "organization",
    organizationType: "merchant_guild",
    foundedYear: 860,
    name: "청람 상단",
    color: "#4ca6b8",
    leaderName: "마리온 벨",
    leaderStatus: "selected",
    activityRange: "sea_centered",
    summary: "대륙 항로와 대상로를 운영하는 상업 연합",
    description: "항구와 해상 거점을 연결하는 상업 네트워크를 운영한다.",
    groupProfile: {
      symbol: "청색 돛",
      ideology: "자유무역",
      alignment: "실용적",
      goals: "안전한 해상·육상 교역망 확대",
      headquartersStatus: "selected",
      languageArticleIds: [],
      languageCustom: "항해 공용어",
    },
  };
  const greenConcord: Faction = {
    hasTerritory: false,
    territoryHidden: false,
    id: createId("faction"),
    kind: "faction",
    foundedYear: 905,
    name: "녹원 협약",
    color: "#5f9c68",
    leaderName: "갈대회의",
    leaderStatus: "custom",
    activityRange: "mixed",
    summary: "내해 습지의 마을과 생태 수호자들이 맺은 연합",
    description:
      "범람원·습지의 공동 관리와 무분별한 광산 개발 저지를 목표로 한다.",
    groupProfile: {
      symbol: "세 갈래 갈대",
      ideology: "생태 공동관리",
      alignment: "중립·지역 방어",
      goals: "습지와 수자원 보전",
      headquartersStatus: "custom",
      headquartersCustom: "이동 회의선",
      languageArticleIds: [],
      languageCustom: "공용어",
    },
  };
  map.factions.push(
    silver,
    ember,
    aurelia,
    starOrder,
    azureGuild,
    greenConcord,
  );

  const eiren: Location = {
    id: createId("location"),
    states: [
      {
        startYear: 0,
        endYear: 499,
        value: {
          name: "에이렌",
          locationType: "city",
          position: { x: 39, y: 46 },
          population: 38000,
          economy: 32,
          ownerFactionId: silver.id,
          status: "active",
          description: "은빛 강 서안의 성곽도시",
        },
      },
      {
        startYear: 500,
        endYear: 699,
        value: {
          name: "에이렌",
          locationType: "capital",
          position: { x: 40, y: 45 },
          population: 52000,
          economy: 43,
          ownerFactionId: silver.id,
          status: "occupied",
          description: "동부 전쟁 기간 임시 수도이자 병참기지",
        },
      },
      {
        startYear: 700,
        endYear: 899,
        value: {
          name: "신에이렌",
          locationType: "capital",
          position: { x: 41, y: 45 },
          population: 68000,
          economy: 57,
          ownerFactionId: silver.id,
          status: "active",
          description: "전후 재건과 수로 확장으로 성장한 수도",
        },
      },
      {
        startYear: 900,
        endYear: null,
        value: {
          name: "대에이렌",
          locationType: "capital",
          position: { x: 41.5, y: 44.8 },
          population: 112000,
          economy: 93,
          ownerFactionId: silver.id,
          status: "active",
          description: "서부 최대의 학술·상업 도시",
        },
      },
    ],
  };
  const pyr: Location = {
    id: createId("location"),
    states: [
      {
        startYear: 100,
        endYear: 511,
        value: {
          name: "피르",
          locationType: "capital",
          position: { x: 123, y: 62 },
          population: 84000,
          economy: 70,
          ownerFactionId: ember.id,
          status: "active",
          description: "적염제국의 화산석 수도",
        },
      },
      {
        startYear: 512,
        endYear: 741,
        value: {
          name: "피르",
          locationType: "capital",
          position: { x: 122, y: 61 },
          population: 73000,
          economy: 61,
          ownerFactionId: ember.id,
          status: "active",
          description: "전쟁 패배 후 성벽을 재건한 수도",
        },
      },
      {
        startYear: 742,
        endYear: 759,
        value: {
          name: "회색 피르",
          locationType: "ruin",
          position: { x: 122, y: 61 },
          population: 19000,
          economy: 16,
          ownerFactionId: ember.id,
          status: "abandoned",
          description: "대분화와 화산재로 도시 대부분이 폐허가 된 시기",
        },
      },
      {
        startYear: 760,
        endYear: null,
        value: {
          name: "신피르",
          locationType: "capital",
          position: { x: 119, y: 64 },
          population: 91000,
          economy: 76,
          ownerFactionId: ember.id,
          status: "active",
          description: "옛 수도 남쪽에 재건된 계획도시",
        },
      },
    ],
  };
  const solheim: Location = {
    id: createId("location"),
    states: [
      {
        startYear: 0,
        endYear: 879,
        value: {
          name: "솔헤임",
          locationType: "town",
          position: { x: 79, y: 24 },
          population: 16000,
          economy: 13,
          ownerFactionId: aurelia.id,
          status: "active",
          description: "북부 고원 관문도시",
        },
      },
      {
        startYear: 880,
        endYear: null,
        value: {
          name: "솔헤임",
          locationType: "city",
          position: { x: 79, y: 24 },
          population: 34000,
          economy: 28,
          ownerFactionId: aurelia.id,
          status: "active",
          description: "북방 원정 이후 군사·교역 중심지",
        },
      },
    ],
  };
  const nereid: Location = {
    id: createId("location"),
    states: [
      {
        startYear: 350,
        endYear: 929,
        value: {
          name: "네레이드 항",
          locationType: "town",
          position: { x: 30, y: 74 },
          population: 12000,
          economy: 10,
          ownerFactionId: silver.id,
          status: "active",
          description: "서해 무역항",
        },
      },
      {
        startYear: 930,
        endYear: null,
        value: {
          name: "네레이드 자유항",
          locationType: "city",
          position: { x: 30, y: 74 },
          population: 47000,
          economy: 39,
          ownerFactionId: azureGuild.id,
          status: "active",
          description: "청람 상단과의 계약으로 성장한 자유무역항",
        },
      },
    ],
  };
  const kharad: Location = {
    id: createId("location"),
    states: [
      {
        startYear: 0,
        endYear: 505,
        value: {
          name: "카라드 관문",
          locationType: "town",
          position: { x: 83, y: 50 },
          population: 9000,
          economy: 8,
          ownerFactionId: aurelia.id,
          status: "active",
          description: "중앙 산맥을 통과하는 요충지",
        },
      },
      {
        startYear: 506,
        endYear: null,
        value: {
          name: "카라드 폐관",
          locationType: "ruin",
          position: { x: 83, y: 50 },
          population: 0,
          economy: 1,
          ownerFactionId: undefined,
          status: "destroyed",
          description: "은빛 강 전투와 함께 파괴된 관문",
        },
      },
    ],
  };
  const settlement = (
    name: string,
    locationType: LocationType,
    x: number,
    y: number,
    ownerFactionId: string,
    population: number,
    economy: number,
    description: string,
  ): Location => ({
    id: createId("location"),
    states: [
      {
        startYear: 0,
        endYear: null,
        value: {
          name,
          locationType,
          position: { x, y },
          population,
          economy,
          ownerFactionId,
          status: "active",
          description,
        },
      },
    ],
  });
  const addedCities = [
    settlement(
      "아스텔라",
      "city",
      62,
      34,
      aurelia.id,
      42000,
      35,
      "북부 곡창지대와 왕도를 잇는 하천 합류점 도시",
    ),
    settlement(
      "발레온",
      "city",
      97,
      47,
      ember.id,
      39000,
      31,
      "중앙 산맥의 동쪽 관문과 광산을 관리하는 도시",
    ),
    settlement(
      "미라벨",
      "city",
      54,
      78,
      silver.id,
      31000,
      29,
      "남서부 범람원의 농업·수운 중심지",
    ),
    settlement(
      "오르시스",
      "city",
      137,
      76,
      ember.id,
      36000,
      33,
      "남동 해안의 조선·화산석 수출항",
    ),
  ];
  const addedVillages = [
    settlement(
      "버드나루",
      "village",
      36,
      63,
      silver.id,
      2400,
      4,
      "은빛 강의 나루와 수차가 있는 마을",
    ),
    settlement(
      "참나무골",
      "village",
      24,
      42,
      silver.id,
      1800,
      3,
      "서부 숲 가장자리의 목재 생산 마을",
    ),
    settlement(
      "해오름촌",
      "village",
      48,
      31,
      aurelia.id,
      2100,
      4,
      "북부 완경사 농경지의 밀 재배 마을",
    ),
    settlement(
      "고개샘",
      "village",
      75,
      39,
      aurelia.id,
      1300,
      3,
      "산악 고개와 샘을 지키는 숙박 마을",
    ),
    settlement(
      "푸른갈대",
      "village",
      67,
      70,
      greenConcord.id,
      1700,
      3,
      "습지 수로와 갈대밭을 관리하는 마을",
    ),
    settlement(
      "모래등",
      "village",
      104,
      72,
      ember.id,
      1600,
      3,
      "건조 구릉의 목축·대상로 마을",
    ),
    settlement(
      "붉은샘",
      "village",
      116,
      48,
      ember.id,
      2300,
      5,
      "온천과 화산석 채석장이 있는 마을",
    ),
    settlement(
      "회암촌",
      "village",
      132,
      57,
      ember.id,
      1500,
      3,
      "현무암 고원의 석공 마을",
    ),
    settlement(
      "바람재",
      "village",
      90,
      29,
      aurelia.id,
      1200,
      2,
      "바람이 강한 고원 목축 마을",
    ),
    settlement(
      "달빛포구",
      "village",
      18,
      82,
      azureGuild.id,
      2600,
      5,
      "네레이드 항로의 어업 포구",
    ),
    settlement(
      "은어울",
      "village",
      43,
      69,
      silver.id,
      2200,
      4,
      "두 지류가 만나는 수산·농업 마을",
    ),
    settlement(
      "느릅벌",
      "village",
      57,
      54,
      silver.id,
      2800,
      5,
      "대에이렌 외곽의 곡물 공급 마을",
    ),
    settlement(
      "별무덤",
      "village",
      85,
      63,
      starOrder.id,
      900,
      2,
      "고대 유적을 감시하는 기사단 거점 마을",
    ),
    settlement(
      "솔바위",
      "village",
      72,
      17,
      aurelia.id,
      1400,
      3,
      "고산 침엽수와 약초를 채집하는 마을",
    ),
    settlement(
      "새벽항",
      "village",
      145,
      84,
      ember.id,
      2400,
      5,
      "오르시스 남쪽의 작은 어항",
    ),
  ];
  map.locations.push(
    eiren,
    pyr,
    solheim,
    nereid,
    kharad,
    ...addedCities,
    ...addedVillages,
  );

  map.territories.push(
    {
      id: createId("territory"),
      name: "실버동맹권",
      states: [
        {
          startYear: 0,
          endYear: 499,
          value: {
            ownerFactionId: silver.id,
            polygon: [
              { x: 12, y: 28 },
              { x: 65, y: 25 },
              { x: 72, y: 73 },
              { x: 15, y: 85 },
            ],
            description: "서부 평원과 항구를 중심으로 한 초기 동맹권",
          },
        },
        {
          startYear: 500,
          endYear: 699,
          value: {
            ownerFactionId: silver.id,
            polygon: [
              { x: 12, y: 28 },
              { x: 58, y: 28 },
              { x: 64, y: 70 },
              { x: 15, y: 85 },
            ],
            description: "동부 전쟁 중 축소된 방어선",
          },
        },
        {
          startYear: 700,
          endYear: null,
          value: {
            ownerFactionId: silver.id,
            polygon: [
              { x: 10, y: 26 },
              { x: 74, y: 24 },
              { x: 78, y: 74 },
              { x: 14, y: 87 },
            ],
            description: "휴전 이후 회복된 서부 영토",
          },
        },
      ],
    },
    {
      id: createId("territory"),
      name: "적염제국령",
      states: [
        {
          startYear: 100,
          endYear: 511,
          value: {
            ownerFactionId: ember.id,
            polygon: [
              { x: 88, y: 39 },
              { x: 151, y: 33 },
              { x: 154, y: 91 },
              { x: 96, y: 89 },
            ],
            description: "동진기 제국 최대 판도",
          },
        },
        {
          startYear: 512,
          endYear: null,
          value: {
            ownerFactionId: ember.id,
            polygon: [
              { x: 102, y: 43 },
              { x: 151, y: 33 },
              { x: 154, y: 91 },
              { x: 105, y: 88 },
            ],
            description: "휴전선 동쪽으로 후퇴한 제국령",
          },
        },
      ],
    },
    {
      id: createId("territory"),
      name: "아우렐리아 왕국령",
      states: [
        {
          startYear: 0,
          endYear: null,
          value: {
            ownerFactionId: aurelia.id,
            polygon: [
              { x: 57, y: 4 },
              { x: 103, y: 3 },
              { x: 105, y: 39 },
              { x: 58, y: 40 },
            ],
            description: "북부 고원과 솔헤임을 포함하는 왕국령",
          },
        },
      ],
    },
    {
      id: createId("territory"),
      name: "청람 해상활동권",
      states: [
        {
          startYear: 930,
          endYear: null,
          value: {
            ownerFactionId: azureGuild.id,
            polygon: [
              { x: 4, y: 58 },
              { x: 52, y: 57 },
              { x: 56, y: 98 },
              { x: 2, y: 98 },
            ],
            description: "네레이드 자유항을 중심으로 한 해상 교역권",
          },
        },
      ],
    },
  );
  map.rivers.push({
    id: createId("river"),
    name: "은빛 강",
    nodes: [
      { x: 77, y: 19 },
      { x: 71, y: 33 },
      { x: 65, y: 49 },
      { x: 52, y: 61 },
      { x: 31, y: 74 },
    ],
    width: 2.2,
    description: "북부 고원에서 서해로 흐르는 대하",
    startYear: 0,
    endYear: null,
  });
  map.roads.push(
    {
      id: createId("road"),
      name: "제국 동서대로",
      nodes: [
        { x: 41, y: 45 },
        { x: 83, y: 50 },
        { x: 122, y: 61 },
      ],
      roadType: "main",
      description: "전쟁 뒤 보수된 대륙 횡단로",
      startYear: 620,
      endYear: null,
    },
    {
      id: createId("road"),
      name: "북방 원정로",
      nodes: [
        { x: 79, y: 24 },
        { x: 86, y: 14 },
        { x: 92, y: 6 },
      ],
      roadType: "trail",
      description: "북방 원정대가 개척한 산악로",
      startYear: 880,
      endYear: null,
    },
  );
  map.placeNames.push(
    {
      id: createId("place"),
      name: "은빛 평원",
      position: { x: 43, y: 55 },
      type: "region",
      description: "서부의 비옥한 평원",
      startYear: 0,
      endYear: null,
    },
    {
      id: createId("place"),
      name: "적염 산맥",
      position: { x: 122, y: 45 },
      type: "geographic_feature",
      description: "활화산과 광산이 이어진 산맥",
      startYear: 0,
      endYear: null,
    },
  );

  const makeEvent = (
    title: string,
    category: EventCategory,
    start: HistoricalDateTime,
    end: HistoricalDateTime | null,
    description: string,
    participants: EventParticipant[],
    chronology: EventChronologyEntry[],
    location: Point | null = null,
  ): WorldEvent => ({
    id: createId("event"),
    title,
    category,
    description,
    location,
    startTimeUnknown: false,
    endTimeUnknown: false,
    startDateTime: start,
    endDateTime: end,
    startYear: start.year,
    endYear: end?.year ?? null,
    participants,
    chronology,
    relatedLocationIds: [],
    relatedFactionIds: [],
    relatedTerritoryIds: [],
  });
  const participant = (
    organizationName: string,
    keyFigures: string,
    scale: string,
    cause: string,
    result: string,
  ): EventParticipant => ({
    id: createId("participant"),
    organizationName,
    keyFigures,
    scale,
    cause,
    result,
  });
  const log = (
    dateTime: HistoricalDateTime,
    title: string,
    description: string,
  ): EventChronologyEntry => ({
    id: createId("chronology"),
    dateTime,
    title,
    description,
  });
  map.events.push(
    makeEvent(
      "삼강 조약",
      "treaty",
      { year: 380, month: 4, day: 2, hour: 10 },
      { year: 380, month: 4, day: 3, hour: 16 },
      "세 국가가 강과 대상로의 공동 이용 원칙을 확립했다.",
      [
        participant(
          "실버동맹",
          "초대 의장 세레네",
          "대표단 18명",
          "수로 분쟁 종식",
          "서부 수로 공동관리",
        ),
        participant(
          "아우렐리아 왕국",
          "아우렐 6세",
          "대표단 12명",
          "곡물 수출 안정",
          "통행세 인하",
        ),
      ],
      [
        log(
          { year: 380, month: 4, day: 2, hour: 10 },
          "회담 개시",
          "세 대표단이 에이렌에 입성했다.",
        ),
        log(
          { year: 380, month: 4, day: 3, hour: 16 },
          "조약 서명",
          "삼강 공동관리 조항이 채택되었다.",
        ),
      ],
      { x: 40, y: 45 },
    ),
    makeEvent(
      "동부 전쟁",
      "war",
      { year: 500, month: 3, day: 14, hour: 6 },
      { year: 512, month: 10, day: 2, hour: 18 },
      "중앙 대륙의 패권과 교역로를 둘러싼 대규모 전쟁.",
      [
        participant(
          "실버동맹",
          "루나 여왕·에레스",
          "야전군 약 4만",
          "중앙 교역로 방어",
          "서부 영토 유지",
        ),
        participant(
          "적염제국",
          "카르도스 3세·바르칸 장군",
          "원정군 약 5만",
          "중앙 대륙 진출",
          "동부 국경 후퇴",
        ),
        participant(
          "별빛 기사단",
          "단장 에레스",
          "기사 800명",
          "고대 관문 보호",
          "카라드 난민 구호",
        ),
      ],
      [
        log(
          { year: 500, month: 3, day: 14, hour: 6 },
          "전쟁 발발",
          "제국 선봉대가 카라드 관문을 공격했다.",
        ),
        log(
          { year: 506, month: 8, day: 9, hour: 15, minute: 30 },
          "은빛 강 전투",
          "실버동맹이 강 서안 방어선을 지켜냈다.",
        ),
        log(
          { year: 512, month: 10, day: 2, hour: 18 },
          "휴전 협정",
          "양측이 동부 평원에서 휴전에 합의했다.",
        ),
      ],
      { x: 83, y: 50 },
    ),
    makeEvent(
      "은빛 강 전투",
      "battle",
      { year: 506, month: 8, day: 9, hour: 15, minute: 30 },
      { year: 506, month: 8, day: 10, hour: 6 },
      "동부 전쟁의 향방을 바꾼 강변 방어전.",
      [
        participant(
          "실버동맹",
          "루나 여왕·에레스",
          "방어군 약 1만 8천",
          "강 서안 방어",
          "제국군 도하 저지",
        ),
        participant(
          "적염제국",
          "바르칸 장군",
          "공격군 약 2만 2천",
          "서부 교두보 확보",
          "동부 평원으로 후퇴",
        ),
      ],
      [
        log(
          { year: 506, month: 8, day: 9, hour: 15, minute: 30 },
          "첫 도하",
          "제국군 선봉대가 은빛 강을 건넜다.",
        ),
        log(
          { year: 506, month: 8, day: 9, hour: 21 },
          "기사단 역습",
          "별빛 기사단이 북측 제방을 탈환했다.",
        ),
        log(
          { year: 506, month: 8, day: 10, hour: 6 },
          "전투 종료",
          "제국군이 동부 평원으로 철수했다.",
        ),
      ],
      { x: 66, y: 49 },
    ),
    makeEvent(
      "대륙 횡단도로 공사",
      "civil_engineering",
      { year: 620, month: 2, day: 1, hour: 8 },
      { year: 635, month: 9, day: 20, hour: 12 },
      "전쟁으로 끊어진 동서 교통망을 재건한 대규모 토목사업.",
      [
        participant(
          "청람 상단",
          "마리온 벨",
          "기술자·노동자 1만 2천",
          "교역 회복",
          "운송기간 절반 단축",
        ),
        participant(
          "실버동맹",
          "공사감 아델",
          "공병 3천",
          "서부 재건",
          "에이렌 경제 성장",
        ),
      ],
      [
        log(
          { year: 620, month: 2, day: 1, hour: 8 },
          "기공식",
          "에이렌 동문에서 공사가 시작되었다.",
        ),
        log(
          { year: 628, month: 6, day: 11, hour: 14 },
          "카라드 터널 관통",
          "중앙 산맥 구간이 연결되었다.",
        ),
        log(
          { year: 635, month: 9, day: 20, hour: 12 },
          "전 구간 개통",
          "동서대로가 공식 개통되었다.",
        ),
      ],
      { x: 83, y: 50 },
    ),
    makeEvent(
      "신에이렌 천년제",
      "festival",
      { year: 700, month: 5, day: 1, hour: 9 },
      { year: 700, month: 5, day: 10, hour: 23 },
      "전후 재건과 도시 개칭을 기념한 대축제.",
      [
        participant(
          "실버동맹",
          "루나 여왕",
          "방문객 약 18만",
          "도시 재건 선포",
          "신에이렌 명칭 정착",
        ),
        participant(
          "청람 상단",
          "마리온 벨",
          "상단 240개",
          "대륙 시장 확대",
          "자유시장 개설",
        ),
      ],
      [
        log(
          { year: 700, month: 5, day: 1, hour: 9 },
          "개막 행진",
          "은빛 대로에서 개막 행진이 시작되었다.",
        ),
        log(
          { year: 700, month: 5, day: 10, hour: 23 },
          "폐막 불꽃",
          "강변 불꽃놀이로 축제가 끝났다.",
        ),
      ],
      { x: 41, y: 45 },
    ),
    makeEvent(
      "적염 대분화",
      "natural_disaster",
      { year: 742, month: 7, day: 18, hour: 3, minute: 12 },
      { year: 742, month: 8, day: 4, hour: 20 },
      "적염 산맥의 연쇄 분화로 피르가 매몰된 자연재해.",
      [
        participant(
          "적염제국",
          "카르도스 3세",
          "피난민 약 7만",
          "수도 주민 구조",
          "수도 남쪽 이전",
        ),
        participant(
          "별빛 기사단",
          "치유기사단",
          "구호대 600명",
          "국경 초월 구호",
          "북부 피난로 확보",
        ),
      ],
      [
        log(
          { year: 742, month: 7, day: 18, hour: 3, minute: 12 },
          "주분화",
          "도시 북쪽 화산이 폭발했다.",
        ),
        log(
          { year: 742, month: 7, day: 18, hour: 5 },
          "피르 성벽 붕괴",
          "화산쇄설류가 북문을 덮쳤다.",
        ),
        log(
          { year: 742, month: 8, day: 4, hour: 20 },
          "구조 종료",
          "공식 구조 작전이 종료되었다.",
        ),
      ],
      { x: 122, y: 61 },
    ),
    makeEvent(
      "북방 설원 원정",
      "expedition",
      { year: 880, month: 1, day: 12, hour: 7 },
      { year: 884, month: 11, day: 2, hour: 17 },
      "아우렐리아 왕국과 기사단이 북방 관문을 조사한 원정.",
      [
        participant(
          "아우렐리아 왕국",
          "왕세자 레온",
          "원정대 2천 4백",
          "북방 위협 조사",
          "솔헤임 승격",
        ),
        participant(
          "별빛 기사단",
          "단장 에레스",
          "마도기사 230명",
          "고대 관문 확인",
          "별의 문 봉인",
        ),
      ],
      [
        log(
          { year: 880, month: 1, day: 12, hour: 7 },
          "솔헤임 출발",
          "원정대가 북문을 통과했다.",
        ),
        log(
          { year: 882, month: 6, day: 3, hour: 11 },
          "별의 문 발견",
          "빙하 아래에서 고대 관문이 발견되었다.",
        ),
        log(
          { year: 884, month: 11, day: 2, hour: 17 },
          "원정대 귀환",
          "생존자들이 솔헤임으로 귀환했다.",
        ),
      ],
      { x: 86, y: 14 },
    ),
    makeEvent(
      "별나침반 탐험",
      "exploration",
      { year: 910, month: 3, day: 8, hour: 5 },
      { year: 913, month: 9, day: 17, hour: 14 },
      "서해 미지 해역의 군도와 항로를 기록한 탐험.",
      [
        participant(
          "청람 상단",
          "탐험가 이리아",
          "선박 7척·선원 430명",
          "신항로 개척",
          "청색 군도 발견",
        ),
        participant(
          "별빛 기사단",
          "천문관 라시드",
          "관측관 18명",
          "별나침반 시험",
          "대양 항법 확립",
        ),
      ],
      [
        log(
          { year: 910, month: 3, day: 8, hour: 5 },
          "네레이드 출항",
          "탐험선단이 서해로 출항했다.",
        ),
        log(
          { year: 912, month: 2, day: 21, hour: 12 },
          "청색 군도 상륙",
          "첫 섬에 관측소를 설치했다.",
        ),
        log(
          { year: 913, month: 9, day: 17, hour: 14 },
          "귀항",
          "새 항로도가 공개되었다.",
        ),
      ],
      { x: 18, y: 78 },
    ),
    makeEvent(
      "네레이드 자유항 계약",
      "contract",
      { year: 930, month: 1, day: 1, hour: 10 },
      { year: 930, month: 1, day: 1, hour: 13 },
      "실버동맹과 청람 상단이 항만 운영권을 분담한 계약.",
      [
        participant(
          "실버동맹",
          "재무관 소피아",
          "행정관 40명",
          "항만 세수 확대",
          "관세 수입 증가",
        ),
        participant(
          "청람 상단",
          "마리온 벨",
          "상선 180척",
          "자유항 운영권",
          "서해 무역 독점",
        ),
      ],
      [
        log(
          { year: 930, month: 1, day: 1, hour: 10 },
          "조항 심의",
          "항만세와 치안 분담 조항을 검토했다.",
        ),
        log(
          { year: 930, month: 1, day: 1, hour: 13 },
          "계약 체결",
          "자유항 헌장이 발효되었다.",
        ),
      ],
      { x: 30, y: 74 },
    ),
    makeEvent(
      "네레이드 제7부두 붕괴",
      "accident",
      { year: 980, month: 8, day: 19, hour: 22, minute: 14 },
      { year: 980, month: 8, day: 20, hour: 6 },
      "폭풍 속 화물 적재 중 부두 일부가 붕괴한 사고.",
      [
        participant(
          "청람 상단",
          "항만장 토레스",
          "작업자 320명",
          "긴급 화물 하역",
          "부두 안전규정 개정",
        ),
      ],
      [
        log(
          { year: 980, month: 8, day: 19, hour: 22, minute: 14 },
          "붕괴 발생",
          "제7부두 북측 기둥이 무너졌다.",
        ),
        log(
          { year: 980, month: 8, day: 20, hour: 6 },
          "구조 종료",
          "구조대가 잔해 수색을 종료했다.",
        ),
      ],
      { x: 30, y: 74 },
    ),
    makeEvent(
      "적염 계승 사건",
      "incident",
      { year: 1020, month: 12, day: 30, hour: 23 },
      { year: 1021, month: 1, day: 2, hour: 8 },
      "황제의 급서 이후 후계파가 충돌한 정치 사건.",
      [
        participant(
          "적염제국 황실",
          "황태자 아르돈",
          "근위대 4천",
          "황위 계승",
          "아르돈 1세 즉위",
        ),
        participant(
          "남부 귀족회의",
          "대공 벨카",
          "사병 2천",
          "섭정권 요구",
          "귀족회의 해산",
        ),
      ],
      [
        log(
          { year: 1020, month: 12, day: 30, hour: 23 },
          "황제 급서",
          "카르도스 3세의 사망이 공표되었다.",
        ),
        log(
          { year: 1021, month: 1, day: 1, hour: 4 },
          "황궁 봉쇄",
          "근위대가 황궁 출입을 통제했다.",
        ),
        log(
          { year: 1021, month: 1, day: 2, hour: 8 },
          "신황 즉위",
          "아르돈 1세가 즉위식을 거행했다.",
        ),
      ],
      { x: 119, y: 64 },
    ),
  );
  const uncertainEvent = makeEvent(
    "첫 별문 개방",
    "exploration",
    { year: 0 },
    null,
    "정확한 시점은 전해지지 않지만 여러 문명권의 기록에 공통으로 등장하는 고대 사건.",
    [
      participant(
        "고대 관측자 집단",
        "이름 미상",
        "규모 미상",
        "별문 구조 조사",
        "후대 역법과 항법의 기원",
      ),
    ],
    [],
    { x: 86, y: 14 },
  );
  uncertainEvent.startTimeUnknown = true;
  map.events.push(uncertainEvent);

  const now = new Date().toISOString();
  project.heraldicAssets.push(
    {
      id: demoAureliaFlagId,
      kind: "flag",
      name: "아우렐리아 왕국기",
      source: "generated",
      shape: "rectangle",
      pattern: "stripes",
      symbol: "diamond",
      backgroundColor: "#d9bd59",
      patternColor: "#f7f0c9",
      symbolColor: "#7a5520",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: demoEmberCoatId,
      kind: "coatOfArms",
      name: "적염 황실 문장",
      source: "generated",
      shape: "shield",
      pattern: "solid",
      symbol: "spade",
      backgroundColor: "#8f2f2b",
      patternColor: "#e9a35c",
      symbolColor: "#f1d19d",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: demoSilverFlagId,
      kind: "flag",
      name: "실버동맹기",
      source: "generated",
      shape: "pennant",
      pattern: "grid",
      symbol: "diamond",
      backgroundColor: "#6885a9",
      patternColor: "#b8c7d9",
      symbolColor: "#f4f7fb",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: demoFamilyCoatId,
      kind: "coatOfArms",
      name: "셀레네 가문 문장",
      source: "generated",
      shape: "circle",
      pattern: "stripes",
      symbol: "palm",
      backgroundColor: "#453d78",
      patternColor: "#9288c8",
      symbolColor: "#f0e7bd",
      createdAt: now,
      updatedAt: now,
    },
  );
  const categoryId = (key: WikiCategory) =>
    project.wikiCategories.find((category) => category.systemKey === key)?.id ??
    null;
  const arcanaCalendar: WikiArticle = {
    id: createId("wiki-calendar"),
    title: "성환력",
    category: "calendar",
    categoryId: categoryId("calendar"),
    summary: "성환식을 역초로 삼는 100일제 역법",
    content:
      "에테리아 세계의 공전 주기 200일과 별개로 행정·상업을 위해 100일을 한 해로 계산한다.",
    tags: ["역법", "시간"],
    linkedMapEntityIds: [],
    createdDate: now,
    lastModifiedDate: now,
    calendarProfile: {
      creator: "은빛 강 천문원",
      createdAtYear: 600,
      userFactionIds: [silver.id, aurelia.id, azureGuild.id],
      mechanism: "",
      calendarName: "성환력",
      displayMode: "era",
      beforeEraName: "성환 이전",
      afterEraName: "성환 이후",
      beforeEraShortName: "BSE",
      afterEraShortName: "ASE",
      epochWorldYear: 600,
      dateUnits: [
        {
          id: createId("calendar-date-unit"),
          name: "년",
          shortName: "년",
          unitsPerParent: 1,
        },
        {
          id: createId("calendar-date-unit"),
          name: "월",
          shortName: "월",
          unitsPerParent: 10,
        },
        {
          id: createId("calendar-date-unit"),
          name: "일",
          shortName: "일",
          unitsPerParent: 10,
        },
      ],
      timeUnits: [
        {
          id: createId("calendar-time-unit"),
          name: "시",
          shortName: "시",
          unitsPerParent: 20,
        },
        {
          id: createId("calendar-time-unit"),
          name: "분",
          shortName: "분",
          unitsPerParent: 50,
        },
        {
          id: createId("calendar-time-unit"),
          name: "초",
          shortName: "초",
          unitsPerParent: 50,
        },
      ],
    },
  };
  project.timelineCalendarArticleId = arcanaCalendar.id;
  const person = (title: string, summary: string): WikiArticle => ({
    id: createId("wiki-person"),
    title,
    category: "person",
    categoryId: categoryId("person"),
    summary,
    content: "",
    tags: ["인물"],
    linkedMapEntityIds: [],
    createdDate: now,
    lastModifiedDate: now,
    personProfile: {
      organizationArticleIds: [],
      factionArticleIds: [],
      spouseArticleIds: [],
      childArticleIds: [],
      notes: "",
    },
  });
  const luna = person(
    "루나 여왕",
    "실버동맹의 장기 집권자이자 전후 재건의 상징",
  );
  const cael = person("카엘 왕자", "루나 여왕의 장남이자 외교 사절");
  const mira = person("미라 공녀", "에이렌 수로 사업을 감독한 기술관");
  const selene = person("세레네 대공비", "루나 여왕의 어머니이자 전 동맹 의장");
  luna.personProfile = {
    ...luna.personProfile!,
    motherArticleId: selene.id,
    childArticleIds: [cael.id, mira.id],
    birthYear: 456,
    notes: "동부 전쟁과 재건기를 통치했다.",
  };
  cael.personProfile = {
    ...cael.personProfile!,
    motherArticleId: luna.id,
    birthYear: 486,
    notes: "삼국 외교를 담당했다.",
  };
  mira.personProfile = {
    ...mira.personProfile!,
    motherArticleId: luna.id,
    birthYear: 491,
    notes: "토목·수리 기술자로 활동했다.",
  };
  selene.personProfile = {
    ...selene.personProfile!,
    childArticleIds: [luna.id],
    birthYear: 428,
    deathYear: 503,
    notes: "초기 실버동맹의 제도를 정비했다.",
  };

  project.wikiArticles.push(
    arcanaCalendar,
    {
      id: createId("wiki"),
      title: "에테리아 세계",
      category: "world",
      categoryId: categoryId("world"),
      summary: "서로 다른 문명·기후·마도 기술이 공존하는 세계",
      content: "은빛 강을 중심으로 서부 동맹, 북부 왕국, 동부 제국이 경쟁한다.",
      tags: ["세계", "개요"],
      linkedMapEntityIds: [],
      createdDate: now,
      lastModifiedDate: now,
    },
    luna,
    cael,
    mira,
    selene,
    {
      id: createId("wiki-family"),
      title: "셀레네 가문",
      category: "family",
      categoryId: categoryId("family"),
      summary: "실버동맹의 의장과 기술관을 배출한 명문가",
      content: "",
      tags: ["가문", "실버동맹"],
      linkedMapEntityIds: [],
      createdDate: now,
      lastModifiedDate: now,
      familyProfile: {
        displayMode: "all",
        displayCoatOfArms: true,
        coatOfArmsAssetId: demoFamilyCoatId,
        members: [
          {
            id: "family-selene",
            articleId: selene.id,
            name: "세레네 대공비",
            birthYear: 428,
            deathYear: 503,
            parentIds: [],
            partnerIds: [],
            important: true,
            summary: "전 동맹 의장",
          },
          {
            id: "family-luna",
            articleId: luna.id,
            name: "루나 여왕",
            birthYear: 456,
            parentIds: ["family-selene"],
            partnerIds: [],
            important: true,
            summary: "전후 재건 군주",
          },
          {
            id: "family-cael",
            articleId: cael.id,
            name: "카엘 왕자",
            birthYear: 486,
            parentIds: ["family-luna"],
            partnerIds: [],
            important: true,
            summary: "외교 사절",
          },
          {
            id: "family-mira",
            articleId: mira.id,
            name: "미라 공녀",
            birthYear: 491,
            parentIds: ["family-luna"],
            partnerIds: [],
            important: true,
            summary: "수리 기술관",
          },
          {
            id: "family-adel",
            name: "아델",
            birthYear: 520,
            parentIds: ["family-cael"],
            partnerIds: [],
            important: false,
            summary: "동서대로 공사감",
          },
          {
            id: "family-sophia",
            name: "소피아",
            birthYear: 556,
            parentIds: ["family-mira"],
            partnerIds: [],
            important: false,
            summary: "재무관",
          },
        ],
      },
    },
    {
      id: createId("wiki-item"),
      title: "별나침반",
      category: "item",
      categoryId: categoryId("item"),
      summary: "별빛을 이용해 방향과 마력 흐름을 측정하는 항법 유물",
      content: "북방 원정에서 회수되어 서해 탐험에 사용되었다.",
      tags: ["물건", "마도구"],
      linkedMapEntityIds: [],
      createdDate: now,
      lastModifiedDate: now,
      itemProfile: {
        itemType: "천문 항법구",
        origin: "북방 별의 문",
        condition: "작동 중",
        ownershipHistory: [],
      },
    },
    {
      id: createId("wiki-item"),
      title: "은빛 왕관",
      category: "item",
      categoryId: categoryId("item"),
      summary: "실버동맹 의장권을 상징하는 의장용 왕관",
      content: "",
      tags: ["물건", "보물"],
      linkedMapEntityIds: [],
      createdDate: now,
      lastModifiedDate: now,
      itemProfile: {
        itemType: "의장용 관",
        origin: "초대 동맹회의",
        condition: "보존 양호",
        ownershipHistory: [],
      },
    },
    {
      id: createId("wiki"),
      title: "별빛 수로공학",
      category: "technology",
      categoryId: categoryId("technology"),
      summary: "고도차와 마력석을 이용해 장거리 수로를 유지하는 기술",
      content: "에이렌 재건과 대륙 횡단도로 공사에 활용되었다.",
      tags: ["기술", "토목"],
      linkedMapEntityIds: [],
      createdDate: now,
      lastModifiedDate: now,
    },
    {
      id: createId("wiki"),
      title: "은빛 강 문화권",
      category: "culture",
      categoryId: categoryId("culture"),
      summary: "수로와 시장을 중심으로 형성된 서부 문화",
      content: "강변 축제와 공동 수로 관리 전통이 발달했다.",
      tags: ["문화"],
      linkedMapEntityIds: [],
      createdDate: now,
      lastModifiedDate: now,
    },
    {
      id: createId("wiki"),
      title: "에테리아 공용어",
      category: "language",
      categoryId: categoryId("language"),
      summary: "대륙 교역과 외교에서 사용되는 공용어",
      content: "지역별 방언과 문자 변형이 존재한다.",
      tags: ["언어"],
      linkedMapEntityIds: [],
      createdDate: now,
      lastModifiedDate: now,
    },
    {
      id: createId("wiki"),
      title: "도시 자치주의",
      category: "ideology",
      categoryId: categoryId("ideology"),
      summary: "도시의 자치권과 상호 방위를 중시하는 사상",
      content: "실버동맹의 정치적 기반이다.",
      tags: ["사상"],
      linkedMapEntityIds: [],
      createdDate: now,
      lastModifiedDate: now,
    },
    {
      id: createId("wiki"),
      title: "입헌군주제",
      category: "government",
      categoryId: categoryId("government"),
      summary: "군주의 권한을 헌장과 의회가 제한하는 체제",
      content: "아우렐리아 왕국에서 시행된다.",
      tags: ["체제"],
      linkedMapEntityIds: [],
      createdDate: now,
      lastModifiedDate: now,
      governmentProfile: { countryNameSuffix: "왕국" },
    },
    {
      id: createId("wiki"),
      title: "별의 길 신앙",
      category: "religion",
      categoryId: categoryId("religion"),
      summary: "별빛을 영혼과 여행의 안내자로 보는 신앙",
      content: "별빛 기사단의 의례와 항해자들의 관습에 영향을 주었다.",
      tags: ["종교"],
      linkedMapEntityIds: [],
      createdDate: now,
      lastModifiedDate: now,
      religionProfile: {
        foundingYear: 240,
        leaderTitle: "길잡이",
        symbol: "여덟 갈래 별",
        alignment: "중립·여행자 보호",
        relatedOrganizationIds: [starOrder.id],
      },
    },
  );
  silver.leaderArticleId = luna.id;
  silver.leaderName = luna.title;
  silver.groupProfile = {
    ...(silver.groupProfile ?? {
      symbol: "",
      ideology: "",
      alignment: "",
      goals: "",
      headquartersStatus: "undecided",
      languageArticleIds: [],
      languageCustom: "",
    }),
    headquartersLocationId: eiren.id,
  };
  ember.countryProfile = {
    ...(ember.countryProfile ?? {
      politicalSystem: "",
      symbol: "",
      languageArticleIds: [],
      languageCustom: "",
      cultureArticleIds: [],
      majorLocationIds: [],
    }),
    capitalLocationId: pyr.id,
    majorLocationIds: [pyr.id],
  };
  aurelia.countryProfile = {
    ...(aurelia.countryProfile ?? {
      politicalSystem: "",
      symbol: "",
      languageArticleIds: [],
      languageCustom: "",
      cultureArticleIds: [],
      majorLocationIds: [],
    }),
    capitalLocationId: solheim.id,
    majorLocationIds: [solheim.id],
  };
  starOrder.groupProfile = {
    ...(starOrder.groupProfile ?? {
      symbol: "",
      ideology: "",
      alignment: "",
      goals: "",
      headquartersStatus: "undecided",
      languageArticleIds: [],
      languageCustom: "",
    }),
    headquartersLocationId: kharad.id,
  };
  azureGuild.groupProfile = {
    ...(azureGuild.groupProfile ?? {
      symbol: "",
      ideology: "",
      alignment: "",
      goals: "",
      headquartersStatus: "undecided",
      languageArticleIds: [],
      languageCustom: "",
    }),
    headquartersLocationId: nereid.id,
  };
  const familyArticle = project.wikiArticles.find(
    (article) => article.title === "셀레네 가문",
  );
  const compass = project.wikiArticles.find(
    (article) => article.title === "별나침반",
  );
  if (compass?.itemProfile)
    compass.itemProfile.ownershipHistory = [
      {
        id: createId("ownership"),
        ownerType: "organization",
        ownerId: starOrder.id,
        startYear: 880,
        endYear: 929,
        note: "북방 원정에서 회수",
      },
      {
        id: createId("ownership"),
        ownerType: "organization",
        ownerId: azureGuild.id,
        startYear: 930,
        endYear: null,
        note: "서해 탐험 계약으로 대여",
      },
    ];
  const crown = project.wikiArticles.find(
    (article) => article.title === "은빛 왕관",
  );
  if (crown?.itemProfile)
    crown.itemProfile.ownershipHistory = [
      {
        id: createId("ownership"),
        ownerType: "family",
        ownerId: familyArticle?.id ?? "",
        startYear: 380,
        endYear: 455,
        note: "셀레네 가문 보관",
      },
      {
        id: createId("ownership"),
        ownerType: "person",
        ownerId: luna.id,
        startYear: 456,
        endYear: null,
        note: "동맹 의장권의 상징",
      },
    ];

  // v0.99d 통합 데모: 새 자연·생태 분류와 템플릿을 실제로 탐색할 수 있도록
  // 각 범주에 2~5개의 서로 연결된 예시 문서를 제공한다.
  const demoArticle = (
    category: WikiCategory,
    title: string,
    summary: string,
    content: string,
    linkedMapEntityIds: string[] = [],
  ): WikiArticle => {
    const base: WikiArticle = {
      id: createId(`wiki-${category}`),
      title,
      category,
      categoryId: categoryId(category),
      summary,
      content,
      tags: [category, "데모"],
      linkedMapEntityIds,
      createdDate: now,
      lastModifiedDate: now,
    };
    if (category === "calendar")
      base.calendarProfile = {
        ...createDefaultCalendarProfile(),
        calendarName: title,
        creator: "에테리아 천문회",
        mechanism: content,
      };
    if (category === "family")
      base.familyProfile = { displayMode: "all", members: [] };
    if (category === "item")
      base.itemProfile = {
        itemType: "기록물",
        origin: "에테리아",
        condition: "양호",
        ownershipHistory: [],
      };
    if (category === "religion")
      base.religionProfile = {
        leaderTitle: "수호자",
        symbol: "원환",
        alignment: "중립",
        relatedOrganizationIds: [],
      };
    if (category === "government")
      base.governmentProfile = {
        countryNameSuffix: title.includes("연합")
          ? "동맹"
          : title.includes("전제")
            ? "제국"
            : "국",
      };
    return base;
  };
  const samples: Partial<
    Record<WikiCategory, Array<[string, string, string, string[]?]>>
  > = {
    world: [
      [
        "안개 내해",
        "초대륙 중앙부를 가르는 거대한 내해",
        "온대 해양성 기후를 대륙 안쪽까지 운반하며 여러 문명권의 교역축을 이룬다.",
        [eiren.id, nereid.id],
      ],
    ],
    calendar: [
      [
        "조석력",
        "항구 도시에서 사용하는 조석 중심 보조 역법",
        "달의 위상과 조차를 기록해 항해와 습지 농업에 활용한다.",
        [nereid.id],
      ],
    ],
    family: [
      [
        "벨카 가문",
        "적염 남부의 광산과 군벌을 지배한 귀족 가문",
        "화산 광물 채굴권을 둘러싸고 황실과 여러 차례 충돌했다.",
        [pyr.id],
      ],
    ],
    technology: [
      [
        "습지 제방술",
        "범람원과 늪지의 수위를 조절하는 토목 기술",
        "갈대 섬유와 현무암 판재를 이용해 계절 범람을 통제한다.",
        [nereid.id],
      ],
      [
        "빙설 저장고",
        "고지대의 눈과 얼음을 여름까지 보존하는 기술",
        "북부 산지의 식량 저장과 약재 운송에 쓰인다.",
        [solheim.id],
      ],
    ],
    culture: [
      [
        "북부 고원 문화권",
        "목축·별 관측·겨울 축제가 발달한 문화",
        "긴 겨울과 강한 바람에 적응한 공동 창고 전통이 있다.",
        [solheim.id],
      ],
      [
        "적염 화산 문화권",
        "화산석 건축과 제련 의례가 발달한 문화",
        "분화와 재건의 기억을 불꽃 의례로 전승한다.",
        [pyr.id],
      ],
    ],
    religion: [
      [
        "강의 어머니 신앙",
        "강과 범람을 생명의 순환으로 보는 민간 신앙",
        "은빛 강 유역의 농민과 뱃사공 사이에서 널리 믿어진다.",
        [eiren.id],
      ],
      [
        "재의 수호신 숭배",
        "화산재 속 재생을 상징하는 적염 지역 신앙",
        "대분화 이후 도시 재건 의례와 결합했다.",
        [pyr.id],
      ],
    ],
    language: [
      [
        "아우렐리아 고원어",
        "북부 왕국의 행정·목축 언어",
        "고지대 지형과 눈 상태를 구분하는 어휘가 풍부하다.",
        [solheim.id],
      ],
      [
        "적염어",
        "남동부 제국의 궁정·제련 언어",
        "광물과 불의 상태를 세밀하게 나타내는 어휘 체계를 갖는다.",
        [pyr.id],
      ],
    ],
    ideology: [
      [
        "강 유역 공동체주의",
        "수로와 범람원 관리의 공동 책임을 강조하는 사상",
        "도시와 농촌의 물 사용권을 공동회의에서 조정한다.",
        [eiren.id],
      ],
      [
        "재건 국가주의",
        "재난 뒤 중앙집권적 복구를 중시하는 정치사상",
        "적염제국의 대분화 이후 관료제 강화에 영향을 주었다.",
        [pyr.id],
      ],
    ],
    government: [
      [
        "도시 연합제",
        "자치도시 대표가 공동 방위와 교역을 협의하는 체제",
        "실버동맹의 초기 통치 구조이다.",
        [eiren.id],
      ],
      [
        "관료 전제정",
        "황제와 전문 관료단이 지방을 직접 통제하는 체제",
        "적염제국의 광산·군수 행정을 지탱한다.",
        [pyr.id],
      ],
    ],
    animal: [
      [
        "은갈기 사슴",
        "온대 숲과 초원 경계에 사는 대형 초식동물",
        "계절마다 은빛 강 상류와 저지대를 이동한다.",
        [eiren.id],
      ],
      [
        "늪등 수달",
        "습지 수로에 둥지를 짓는 반수생 동물",
        "깨끗한 물과 갈대 군락이 유지되는지를 보여주는 지표종이다.",
        [nereid.id],
      ],
      [
        "고원 설매",
        "북부 절벽과 적설지에 서식하는 맹금류",
        "겨울 원정대가 날씨 변화를 예측할 때 관찰한다.",
        [solheim.id],
      ],
    ],
    plant: [
      [
        "청람 갈대",
        "염분과 범람에 강한 습지 식물",
        "제방 보강과 돛줄 제작에 사용된다.",
        [nereid.id],
      ],
      [
        "별무늬 이끼",
        "습윤한 암벽에서 푸른 빛을 내는 이끼",
        "고대 관문 주변의 마력 습도를 가늠하는 데 쓰인다.",
        [kharad.id],
      ],
      [
        "적염 약쑥",
        "화산재 토양에서 자라는 내열성 약초",
        "호흡기 질환과 화상 치료에 이용된다.",
        [pyr.id],
      ],
    ],
    tree: [
      [
        "은피 참나무",
        "서부 온대림의 대표 교목",
        "강한 목재는 수문과 교량 건설에 쓰인다.",
        [eiren.id],
      ],
      [
        "안개 버드나무",
        "강변과 습지 가장자리에 군락을 이루는 나무",
        "뿌리가 하안을 고정해 침식을 줄인다.",
        [nereid.id],
      ],
      [
        "고원 바늘전나무",
        "눈과 강풍에 적응한 북부 침엽수",
        "수지와 목재가 겨울 연료로 중요하다.",
        [solheim.id],
      ],
    ],
    rock: [
      [
        "은빛 편마암",
        "서부 산맥 기반을 이루는 변성암",
        "침식된 절벽에서 밝은 띠무늬가 드러난다.",
        [kharad.id],
      ],
      [
        "적염 현무암",
        "남동부 화산지대의 다공질 화산암",
        "성벽과 수로 판재의 주요 재료이다.",
        [pyr.id],
      ],
      [
        "청람 이암",
        "내해와 삼각주에서 퇴적된 세립질 암석",
        "습지 지층과 고대 기후를 연구하는 자료가 된다.",
        [nereid.id],
      ],
    ],
    mineral: [
      [
        "성광석",
        "별빛을 저장하는 희귀 광물",
        "항법구와 수로 조절 장치의 핵심 재료이다.",
        [kharad.id],
      ],
      [
        "적동광",
        "화산 열수대에서 산출되는 붉은 구리 광물",
        "적염제국의 주화와 무기 생산에 쓰인다.",
        [pyr.id],
      ],
      [
        "안개 소금",
        "내해 습지의 증발지에서 얻는 광물성 소금",
        "식량 보존과 약재 거래의 주요 상품이다.",
        [nereid.id],
      ],
    ],
    disease: [
      [
        "회색폐병",
        "미세 화산재 흡입으로 발생하는 만성 호흡기 질환",
        "대분화 이후 피르 지역에서 크게 유행했다.",
        [pyr.id],
      ],
      [
        "늪열",
        "고온다습한 범람원에서 계절적으로 유행하는 열병",
        "습지 수위와 곤충 개체수에 따라 환자가 증가한다.",
        [nereid.id],
      ],
      [
        "설맹증",
        "고원 적설지의 강한 반사광으로 생기는 시각 장애",
        "북방 원정대가 차광 고글을 개발하게 된 계기이다.",
        [solheim.id],
      ],
    ],
    other: [
      [
        "대륙 기후 관측망",
        "각 지역의 기온·강수·풍향을 공유하는 관측 체계",
        "환경 탭의 지점 비교 기능을 설명하기 위한 데모 기록이다.",
        [eiren.id, pyr.id, solheim.id],
      ],
      [
        "미지정 발굴 기록",
        "아직 정식 카테고리를 배정하지 않은 조사 문서",
        "문서 추가와 카테고리 재배정 UI를 시험하기 위한 예시이다.",
        [kharad.id],
      ],
    ],
  };
  for (const [rawCategory, entries] of Object.entries(samples)) {
    const category = rawCategory as WikiCategory;
    for (const [title, summary, content, links = []] of entries ?? [])
      project.wikiArticles.push(
        demoArticle(category, title, summary, content, links),
      );
  }
  // 문서 추가 창을 시험할 수 있도록 한 문서는 의도적으로 미지정 상태로 둔다.
  const unassigned = project.wikiArticles.find(
    (article) => article.title === "미지정 발굴 기록",
  );
  if (unassigned) unassigned.categoryId = null;

  map.environmentPins = [
    {
      id: createId("environment-pin"),
      name: "은빛 강 평원",
      position: { x: 42, y: 46 },
      createdAt: now,
    },
    {
      id: createId("environment-pin"),
      name: "네레이드 습지",
      position: { x: 30, y: 74 },
      createdAt: now,
    },
    {
      id: createId("environment-pin"),
      name: "솔헤임 고원",
      position: { x: 79, y: 24 },
      createdAt: now,
    },
    {
      id: createId("environment-pin"),
      name: "피르 화산대",
      position: { x: 120, y: 63 },
      createdAt: now,
    },
  ];
  // v0.99k 데모는 모든 문서가 서로 연결된 위키 탐색망을 이룬다.
  const linkableArticles = project.wikiArticles.filter(
    (article) => article.title.trim().length > 0,
  );
  project.wikiArticles = project.wikiArticles.map((article, index) => {
    const entityRelated = linkableArticles.filter(
      (candidate) =>
        candidate.id !== article.id &&
        candidate.linkedMapEntityIds.some((id) =>
          article.linkedMapEntityIds.includes(id),
        ),
    );
    const related = [
      ...entityRelated,
      linkableArticles[(index + 1) % linkableArticles.length],
      linkableArticles[(index + 5) % linkableArticles.length],
    ]
      .filter(
        (candidate, candidateIndex, array) =>
          candidate &&
          candidate.id !== article.id &&
          array.findIndex((row) => row.id === candidate.id) === candidateIndex,
      )
      .slice(0, 3);
    if (article.content.includes("[[") || related.length === 0) return article;
    const linkText = related
      .map((candidate) => `[[${candidate.title}]]`)
      .join(", ");
    return {
      ...article,
      content: `${article.content}${article.content ? "\n\n" : ""}이 기록은 ${linkText} 문서와 역사적·지리적으로 연결된다.`,
    };
  });
  return project;
}

export function activeMap(project: WorldProject): MapData | null {
  return (
    project.maps.find((map) => map.id === project.activeMapId) ??
    project.maps[0] ??
    null
  );
}
