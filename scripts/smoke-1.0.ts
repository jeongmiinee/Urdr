import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { generateWorldMap } from "../src/generator/generateWorld";
import { createGridTransform, POWER_OF_TWO_SIZES } from "../src/generator/gridTransform";
import { applyGeneratedCountries } from "../src/generator/mapPlacement";
import { KOPPEN_TERRAIN_PRIORS, TERRAIN_ATLAS_METADATA } from "../src/generator/terrainAtlas";
import {
  createEmptyMap,
  createEmptyProject,
  defaultGeneratorSettings,
  getStateAtYear,
  PROGRAM_VERSION,
  type GeneratedMapData,
  type Point,
  formatTimelineMoment,
  pointInPolygon,
} from "../src/model/world";
import { rescaleMapWorld } from "../src/model/worldScale";
import { createGeneratedPreviewRaster } from "../src/generator/previewRaster";
import { classifyPolygonRings } from "../src/components/mapViewportGeometry";
import { CURRENT_SURFACE_VECTOR_VERSION, hasValidSurfaceGeometry, surfaceBoundarySegments } from "../src/generator/surfaceVectors";
import { normalizeProject } from "../src/storage/projectStorage";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function isPowerOfTwoSize(value: number): boolean {
  return POWER_OF_TWO_SIZES.includes(value as (typeof POWER_OF_TWO_SIZES)[number]);
}

function turnAngle(a: Point, b: Point, c: Point): number {
  const ux = b.x - a.x;
  const uy = b.y - a.y;
  const vx = c.x - b.x;
  const vy = c.y - b.y;
  const um = Math.hypot(ux, uy);
  const vm = Math.hypot(vx, vy);
  if (um < 1e-8 || vm < 1e-8) return 0;
  const cosine = Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (um * vm)));
  return Math.acos(cosine) * 180 / Math.PI;
}

function maxPathTurn(points: Point[]): number {
  let maximum = 0;
  for (let index = 1; index + 1 < points.length; index += 1) {
    maximum = Math.max(maximum, turnAngle(points[index - 1], points[index], points[index + 1]));
  }
  return maximum;
}

function orderedSegmentPaths<T extends { start: Point; end: Point; sequence?: number }>(segments: T[]): Point[][] {
  const ordered = segments.slice().sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
  if (ordered.length === 0) return [];
  const paths: Point[][] = [];
  let current: Point[] = [{ ...ordered[0].start }, { ...ordered[0].end }];
  for (let index = 1; index < ordered.length; index += 1) {
    const segment = ordered[index];
    const tail = current[current.length - 1];
    if (Math.hypot(tail.x - segment.start.x, tail.y - segment.start.y) < 1e-5) current.push({ ...segment.end });
    else {
      paths.push(current);
      current = [{ ...segment.start }, { ...segment.end }];
    }
  }
  paths.push(current);
  return paths;
}

function maximumGroupedTurn<T extends { start: Point; end: Point; sequence?: number }>(
  segments: T[],
  keyOf: (segment: T, index: number) => string,
): number {
  const groups = new Map<string, T[]>();
  segments.forEach((segment, index) => {
    const key = keyOf(segment, index);
    const group = groups.get(key) ?? [];
    group.push(segment);
    groups.set(key, group);
  });
  let maximum = 0;
  for (const group of groups.values()) {
    for (const path of orderedSegmentPaths(group)) maximum = Math.max(maximum, maxPathTurn(path));
  }
  return maximum;
}

function boundaryIndices(width: number, height: number): number[] {
  const indices = new Set<number>();
  for (let x = 0; x < width; x += 1) {
    indices.add(x);
    indices.add((height - 1) * width + x);
  }
  for (let y = 0; y < height; y += 1) {
    indices.add(y * width);
    indices.add(y * width + width - 1);
  }
  return [...indices];
}

function hasSaltwaterWithin(data: GeneratedMapData, index: number, radius: number): boolean {
  const x = index % data.gridWidth;
  const y = Math.floor(index / data.gridWidth);
  for (let offsetY = -radius; offsetY <= radius; offsetY += 1) {
    for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
      if (Math.abs(offsetX) + Math.abs(offsetY) > radius) continue;
      const nearbyX = x + offsetX;
      const nearbyY = y + offsetY;
      if (nearbyX < 0 || nearbyY < 0 || nearbyX >= data.gridWidth || nearbyY >= data.gridHeight) continue;
      if (data.waterTypeMap[nearbyY * data.gridWidth + nearbyX] === "saltwater") return true;
    }
  }
  return false;
}

assert(PROGRAM_VERSION === "1.0", "프로그램 버전이 1.0이 아님");
const generatorComponentSource = await readFile(new URL("../src/components/MapGeneratorWindow.tsx", import.meta.url), "utf8");
const previewComponentSource = await readFile(new URL("../src/components/GeneratedMapPreview.tsx", import.meta.url), "utf8");
const timelineComponentSource = await readFile(new URL("../src/components/TimelinePanel.tsx", import.meta.url), "utf8");
const appSource = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const styleSource = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
assert(!generatorComponentSource.includes("world-scale-presets"), "논리 좌표 nX 빠른 선택 버튼이 남아 있음");
assert(generatorComponentSource.includes("generator-advanced-settings") && generatorComponentSource.includes("generator-advanced-grid"), "시드 아래 접이식 고급 설정 영역이 없음");
assert(generatorComponentSource.includes("렌더 해상도 가로축") && generatorComponentSource.includes("분석·계산 격자 가로축") && generatorComponentSource.includes("worldWidth/Height 배율"), "고급 설정 3개 항목이 통합되지 않음");
assert(!generatorComponentSource.includes("배경기후 기준 위도") && (generatorComponentSource.match(/지도 중심 위도/g)?.length ?? 0) === 1, "지도 중심 위도 설정이 중복됨");
assert(styleSource.includes(".generator-advanced-grid") && styleSource.includes("repeat(3"), "고급 설정 3열 레이아웃이 없음");
assert(generatorComponentSource.includes("raster={previewRaster}"), "Worker 미리보기 래스터가 화면 컴포넌트에 연결되지 않음");
assert(previewComponentSource.includes("ResizeObserver") && previewComponentSource.includes("putImageData"), "실제 컨테이너 크기 기반 미리보기 표시 경로가 없음");
assert(styleSource.includes(".map-generator-root") && styleSource.includes("grid-template-rows: auto minmax(0, 1fr)"), "지도 생성기 루트 높이·스크롤 레이아웃이 없음");
assert(styleSource.includes(".generator-controls::-webkit-scrollbar { display: none"), "지도 생성기 메뉴 숨김 스크롤바 규칙이 없음");
assert(!timelineComponentSource.includes("queueTimelineChange") && timelineComponentSource.includes("dragRatioRef.current"), "타임라인 드래그가 전역 상태를 계속 갱신함");
assert(appSource.includes("window.setTimeout(() => setNotice(\"\"), 4_000)"), "팝업 자동 닫힘 타이머가 없음");
assert(styleSource.includes(":root[data-theme=\"light\"] .category-document-toolbar"), "카테고리 문서 도구 라이트 모드가 없음");
const yearFormatProject = (await import("../src/model/world")).createEmptyProject("연도 표기 검증");
assert(formatTimelineMoment(yearFormatProject, { ...yearFormatProject.maps[0]?.timeline ?? createEmptyMap().timeline, currentYear: 909, precision: "year" }) === "909년", "표준 연도 선행 0 제거 실패");
assert(Object.keys(KOPPEN_TERRAIN_PRIORS).length === 31, "쾨펜 기후 31종 지형 사전확률이 없음");
assert(TERRAIN_ATLAS_METADATA.coordinatePolicy === "aggregated-statistics-only", "지형 아틀라스가 실제 좌표를 보존함");
const windingTestPolygon = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
assert(pointInPolygon({ x: 5, y: 5 }, windingTestPolygon), "시계 방향 폴리곤 내부 판정 실패");
assert(pointInPolygon({ x: 5, y: 5 }, [...windingTestPolygon].reverse()), "반시계 방향 폴리곤 내부 판정 실패");

const nestedSurfaceRings = classifyPolygonRings([
  [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
  [{ x: 2, y: 2 }, { x: 8, y: 2 }, { x: 8, y: 8 }, { x: 2, y: 8 }],
  [{ x: 4, y: 4 }, { x: 6, y: 4 }, { x: 6, y: 6 }, { x: 4, y: 6 }],
  [{ x: 12, y: 0 }, { x: 14, y: 0 }, { x: 14, y: 2 }, { x: 12, y: 2 }],
]);
assert(
  nestedSurfaceRings.map((ring) => ring.depth).join(",") === "0,1,2,0",
  "Surface polygon nesting classification failed",
);
const syntheticCoastline = surfaceBoundarySegments(
  [{
    surface: "saltwater",
    polygons: [
      [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
      [{ x: 3, y: 3 }, { x: 7, y: 3 }, { x: 7, y: 7 }, { x: 3, y: 7 }],
    ],
  }],
  "saltwater",
  10,
  10,
  true,
);
assert(
  syntheticCoastline.length === 4,
  "Map-frame edges leaked into the canonical coastline",
);

const transform = createGridTransform(1000, 500, 1024, 512);
const center = transform.cellCenterToWorld(0, 0);
assert(Math.abs(center.x - 1000 / 2048) < 1e-9, "셀 중심 X 변환 오류");
assert(Math.abs(center.y - 500 / 1024) < 1e-9, "셀 중심 Y 변환 오류");
assert(transform.worldToCell(center).index === 0, "월드→셀 왕복 변환 오류");
assert(transform.cellBoundaryToWorld(1024, 512).x === 1000, "오른쪽 경계 좌표 오류");
assert(transform.cellBoundaryToWorld(1024, 512).y === 500, "아래쪽 경계 좌표 오류");


const defaultPreviewStart = performance.now();
const defaultPreview = generateWorldMap({
  ...defaultGeneratorSettings(),
  generateCountries: false,
}, 160, 100, "preview");
const defaultPreviewMs = performance.now() - defaultPreviewStart;
assert(defaultPreview.gridWidth === 128, `미리보기 LOD가 128이 아님: ${defaultPreview.gridWidth}`);
assert(defaultPreview.contours.length < 20_000, `미리보기 등고선 예산 초과: ${defaultPreview.contours.length}`);
assert(defaultPreviewMs < 8_000, `미리보기 생성이 너무 느림: ${defaultPreviewMs.toFixed(0)}ms`);
assert(!defaultPreview.terrainMap.includes("farmland"), "도시 생성 전 자연 지형에 농경지가 포함됨");
assert((defaultPreview.surfaceRegions?.length ?? 0) >= 4, "지형 벡터 영역이 생성되지 않음");
assert((defaultPreview.surfaceRegions ?? []).every((region) => region.polygons.every((polygon) => polygon.length >= 6)), "벡터 지형 경계 정점이 부족함");
const canonicalPreviewCoastline = surfaceBoundarySegments(
  defaultPreview.surfaceRegions,
  "saltwater",
  defaultPreview.worldWidth,
  defaultPreview.worldHeight,
  true,
);
const segmentKey = (segment: { start: Point; end: Point }) =>
  `${segment.start.x.toFixed(8)},${segment.start.y.toFixed(8)}>${segment.end.x.toFixed(8)},${segment.end.y.toFixed(8)}`;
const canonicalCoastlineKeys = new Set(canonicalPreviewCoastline.map(segmentKey));
assert(
  defaultPreview.coastline.length === canonicalPreviewCoastline.length &&
    defaultPreview.coastline.every((segment) => canonicalCoastlineKeys.has(segmentKey(segment))),
  "Rendered sea boundary and coastline use different geometry",
);
assert(defaultPreview.surfaceVectorVersion === CURRENT_SURFACE_VECTOR_VERSION, "Surface vector schema version was not updated");
assert(hasValidSurfaceGeometry(defaultPreview), "Freshly generated surface geometry failed validation");
const repeatedVertexSurface = structuredClone(defaultPreview);
const repeatedVertexPolygon = repeatedVertexSurface.surfaceRegions?.find((region) => region.polygons.length)?.polygons[0];
if (repeatedVertexPolygon?.length) repeatedVertexPolygon.push({ ...repeatedVertexPolygon[0] });
assert(!hasValidSurfaceGeometry(repeatedVertexSurface), "Repeated surface polygon vertex was not rejected");
const corruptedSurface = structuredClone(defaultPreview);
const corruptedPolygon = corruptedSurface.surfaceRegions?.find((region) => region.polygons.length)?.polygons[0];
if (corruptedPolygon?.length) corruptedPolygon[0] = { x: corruptedSurface.worldWidth, y: corruptedSurface.worldHeight };
assert(!hasValidSurfaceGeometry(corruptedSurface), "Long closing edge in stored surface geometry was not rejected");
const migrationProject = createEmptyProject("Surface migration test");
const migrationMap = createEmptyMap("Surface migration map", defaultPreview.worldWidth, defaultPreview.worldHeight);
migrationProject.maps = [migrationMap];
migrationProject.maps[0].generatedStates = [{
  id: "surface-migration",
  startYear: 0,
  endYear: null,
  value: corruptedSurface,
}];
const migratedSurface = normalizeProject(migrationProject).maps[0].generatedStates[0].value;
assert(migratedSurface?.surfaceVectorVersion === CURRENT_SURFACE_VECTOR_VERSION, "Stored surface vector version was not migrated");
assert(Boolean(migratedSurface && hasValidSurfaceGeometry(migratedSurface)), "Corrupted stored surface geometry was not rebuilt");
const surfaceCellSize = Math.max(
  defaultPreview.worldWidth / Math.min(defaultPreview.gridWidth, 192),
  defaultPreview.worldHeight / Math.max(32, Math.round(Math.min(defaultPreview.gridWidth, 192) * defaultPreview.gridHeight / defaultPreview.gridWidth)),
);
assert(
  defaultPreview.coastline.every((segment) =>
    Math.hypot(segment.end.x - segment.start.x, segment.end.y - segment.start.y) <= surfaceCellSize * 1.01,
  ),
  "Coastline contains a long chord caused by incorrect polygon stitching",
);
const previewRaster = createGeneratedPreviewRaster(defaultPreview, 768);
assert(previewRaster.width >= 128 && previewRaster.height >= 64, "Worker 미리보기 래스터 크기 오류");
assert(previewRaster.pixels.length === previewRaster.width * previewRaster.height * 4, "Worker 미리보기 RGBA 데이터 오류");
assert(previewRaster.pixels.some((value, index) => index % 4 !== 3 && value > 0), "Worker 미리보기 래스터가 비어 있음");

const baseSettings = {
  ...defaultGeneratorSettings(),
  renderResolution: 256 as const,
  analysisResolution: 128 as const,
  gridWidth: 128,
  gridHeight: 64,
  generateCountries: false,
  riverNodeCount: 18,
};
const inland = generateWorldMap({
  ...baseSettings,
  seed: 99201,
  mapScope: "local",
  mapScaleKm: 80,
  localRegionType: "inland",
}, 160, 100, "preview");
assert(isPowerOfTwoSize(inland.gridWidth) && isPowerOfTwoSize(inland.gridHeight), "계산 격자가 2의 거듭제곱이 아님");
assert(isPowerOfTwoSize(inland.renderWidth) && isPowerOfTwoSize(inland.renderHeight), "렌더 해상도가 2의 거듭제곱이 아님");
assert(boundaryIndices(inland.gridWidth, inland.gridHeight).every((index) => inland.waterTypeMap[index] === "land"), "내륙형 경계 제약 실패");

const coastSettings = {
  ...baseSettings,
  seed: 99202,
  mapScope: "regional" as const,
  mapScaleKm: 500,
  localRegionType: "coast" as const,
  localBoundary: {
    north: [{ start: 0, end: 1, kind: "land" as const }],
    east: [{ start: 0, end: 0.5, kind: "land" as const }, { start: 0.5, end: 1, kind: "water" as const }],
    south: [{ start: 0, end: 1, kind: "water" as const }],
    west: [{ start: 0, end: 1, kind: "land" as const }],
  },
};
const coast = generateWorldMap(coastSettings, 160, 100, "preview");
assert(Array.from({ length: coast.gridWidth }, (_, x) => coast.waterTypeMap[x]).every((value) => value === "land"), "해안형 북쪽 육지 제약 실패");
assert(Array.from({ length: coast.gridWidth }, (_, x) => coast.waterTypeMap[(coast.gridHeight - 1) * coast.gridWidth + x]).every((value) => value !== "land"), "해안형 남쪽 바다 제약 실패");
assert(coast.terrainMap.every((terrain, index) => coast.waterTypeMap[index] !== "land" || !["forest", "jungle"].includes(terrain) || !hasSaltwaterWithin(coast, index, 2)), "해안 2셀 완충구역에 숲이 생성됨");

const scaledSourceMap = createEmptyMap("배율 검증", 1000, 500, "realistic", "regional", 5000);
scaledSourceMap.generatedStates = [{ startYear: 0, endYear: null, value: coast }];
scaledSourceMap.roads = [{
  id: "road-scale",
  name: "배율 도로",
  startYear: 0,
  endYear: null,
  nodes: [{ x: 10, y: 20 }, { x: 30, y: 40 }],
  roadType: "main",
  description: "",
}];
const scaledMap = rescaleMapWorld(scaledSourceMap, 4000, 2000, 4);
assert(scaledMap.width === 4000 && scaledMap.height === 2000, "월드 좌표 배율 적용 실패");
assert(scaledMap.physicalWidthKm === 5000, "월드 좌표 배율이 실제 km를 변경함");
assert(scaledMap.roads[0].nodes[1].x === 120 && scaledMap.roads[0].nodes[1].y === 160, "벡터 좌표 재투영 실패");
assert(scaledMap.generatedStates[0].value?.gridWidth === coast.gridWidth, "월드 좌표 배율이 계산 격자를 변경함");

const countryGenerated = generateWorldMap({ ...coastSettings, seed: 99203, generateCountries: true, countryCount: 3 }, 160, 100, "preview");
const countryResult = applyGeneratedCountries(createEmptyMap("국가 검증", 160, 100, "realistic", "regional", 500), countryGenerated);
assert(countryResult.map.territories.length > 0, "국가 영토가 생성되지 않음");
assert(countryResult.map.territories.every((territory) => territory.states.every((state) => state.value.polygon.length >= 3)), "유효하지 않은 영토 폴리곤");
assert((countryResult.generated.agricultureMap ?? []).some((value) => value >= 0.42), "도시 배치 후 농경지가 생성되지 않음");
assert(!countryResult.generated.terrainMap.includes("farmland"), "농경지가 자연 지형 레이어를 덮어씀");
assert((countryResult.generated.surfaceRegions?.some((region) => region.surface === "farmland")) === true, "농경지 벡터 영역이 갱신되지 않음");
let originalUrbanWoodland = 0;
let restrainedUrbanWoodland = 0;
for (const location of countryResult.map.locations) {
  const state = getStateAtYear(location.states, countryResult.map.timeline.currentYear);
  if (!state || !["capital", "city", "town", "village"].includes(state.locationType)) continue;
  const centerX = Math.max(0, Math.min(countryGenerated.gridWidth - 1, Math.floor(state.position.x / countryGenerated.worldWidth * countryGenerated.gridWidth)));
  const centerY = Math.max(0, Math.min(countryGenerated.gridHeight - 1, Math.floor(state.position.y / countryGenerated.worldHeight * countryGenerated.gridHeight)));
  for (let y = Math.max(0, centerY - 4); y <= Math.min(countryGenerated.gridHeight - 1, centerY + 4); y += 1) {
    for (let x = Math.max(0, centerX - 4); x <= Math.min(countryGenerated.gridWidth - 1, centerX + 4); x += 1) {
      const index = y * countryGenerated.gridWidth + x;
      if (["forest", "jungle"].includes(countryGenerated.terrainMap[index])) originalUrbanWoodland += 1;
      if (["forest", "jungle"].includes(countryResult.generated.terrainMap[index])) restrainedUrbanWoodland += 1;
    }
  }
}
assert(restrainedUrbanWoodland <= originalUrbanWoodland, "도시 주변 숲 밀도가 증가함");
assert(originalUrbanWoodland === 0 || restrainedUrbanWoodland < originalUrbanWoodland, "도시 주변 숲 밀도가 감소하지 않음");
for (const territory of countryResult.map.territories) {
  const state = getStateAtYear(territory.states, countryResult.map.timeline.currentYear);
  if (!state?.ownerFactionId) continue;
  const ownerCities = countryResult.map.locations
    .map((location) => getStateAtYear(location.states, countryResult.map.timeline.currentYear))
    .filter((locationState) => locationState && locationState.ownerFactionId === state.ownerFactionId && ["capital", "city", "town"].includes(locationState.locationType));
  assert(ownerCities.some((city) => city && pointInPolygon(city.position, state.polygon) && !(state.holes ?? []).some((hole) => pointInPolygon(city.position, hole))), `도시에서 시작하지 않은 영토가 생성됨: ${territory.name}`);
}


const compressedDemo = await readFile(new URL("../public/demoProjectData.json.gz", import.meta.url));
const demo = JSON.parse(gunzipSync(compressedDemo).toString("utf8"));
const demoMap = demo.maps?.[0];
const demoGenerated = demoMap?.generatedStates?.[0]?.value;
assert(demo.version === "1.0", "데모 버전이 1.0이 아님");
assert(demoMap?.physicalWidthKm === 500, "데모 물리 폭이 500km가 아님");
assert(demoGenerated?.gridWidth === 512 && demoGenerated?.gridHeight === 256, "데모 계산 LOD가 512×256이 아님");
assert(demoGenerated?.renderWidth === 2048 && demoGenerated?.renderHeight === 1024, "데모 렌더 목표가 2048×1024가 아님");
assert((demoGenerated?.surfaceRegions?.length ?? 0) >= 6, "데모 벡터 지형 영역이 부족함");
assert(demoGenerated?.agricultureMap?.some((value: number) => value >= 0.42), "데모 도시 주변 농경지가 생성되지 않음");
assert(!demoGenerated?.terrainMap?.includes("farmland"), "데모 농경지가 자연 지형 레이어를 덮어씀");
assert(demoGenerated?.baseTerrainMap?.length === demoGenerated.gridWidth * demoGenerated.gridHeight, "데모 자연 지형 레이어가 누락됨");
assert(demoGenerated?.agricultureMap?.some((value: number, index: number) => value >= 0.42 && demoGenerated.baseTerrainMap[index] === "forest"), "데모에서 숲 가장자리 개간이 생성되지 않음");
assert(isPowerOfTwoSize(demoGenerated.gridWidth) && isPowerOfTwoSize(demoGenerated.gridHeight), "데모 격자가 2의 거듭제곱이 아님");
assert(Object.keys(demoGenerated.riverMagnitudeMap ?? {}).length > 0 || (demoGenerated.riverMagnitudeMap?.length ?? 0) > 0, "하천 규모 맵이 없음");
assert(Math.max(...demoGenerated.rivers.map((segment: { magnitude: number }) => segment.magnitude)) > 1, "합류 누적 하천 규모가 증가하지 않음");
assert(new Set(demoGenerated.rivers.map((segment: { width: number }) => Math.round(segment.width * 1000))).size > 4, "강폭이 가변적으로 변하지 않음");
assert(demoGenerated.moistureMap?.length === demoGenerated.gridWidth * demoGenerated.gridHeight, "토양수분 환경 데이터가 없음");
const lakeMap = demoGenerated.lakeIdMap ?? [];
assert((demoGenerated.rivers ?? []).every((segment: { start: Point; end: Point }) => {
  const toIndex = (point: Point) => {
    const x = Math.max(0, Math.min(demoGenerated.gridWidth - 1, Math.floor(point.x / demoGenerated.worldWidth * demoGenerated.gridWidth)));
    const y = Math.max(0, Math.min(demoGenerated.gridHeight - 1, Math.floor(point.y / demoGenerated.worldHeight * demoGenerated.gridHeight)));
    return y * demoGenerated.gridWidth + x;
  };
  return !(lakeMap[toIndex(segment.start)] >= 0 && lakeMap[toIndex(segment.end)] >= 0);
}), "강줄기가 호수 내부 경계를 따라 지나감");

let maxRoadTurn = 0;
for (const road of demoMap.roads ?? []) maxRoadTurn = Math.max(maxRoadTurn, maxPathTurn(road.nodes));
const maxContourTurn = maximumGroupedTurn(
  demoGenerated.contours ?? [],
  (segment: { elevation: number; curveId?: string }, index) => `${segment.elevation}:${segment.curveId ?? index}`,
);
const maxRiverTurn = maximumGroupedTurn(
  demoGenerated.rivers ?? [],
  (segment: { riverId?: string }, index) => segment.riverId ?? String(index),
);
assert(maxRoadTurn <= 36, `도로 급회전이 남아 있음: ${maxRoadTurn.toFixed(2)}도`);
assert(maxContourTurn <= 38, `등고선 급회전이 남아 있음: ${maxContourTurn.toFixed(2)}도`);
assert(maxRiverTurn <= 30, `강 급회전이 남아 있음: ${maxRiverTurn.toFixed(2)}도`);

const activeSettlementPositions: Array<{ name: string; point: Point }> = [];
for (const location of demoMap.locations ?? []) {
  const state = getStateAtYear(location.states, demoMap.timeline.currentYear);
  if (!state || state.status !== "active" || !["capital", "city", "town"].includes(state.locationType)) continue;
  assert(activeSettlementPositions.every((entry) => Math.hypot(entry.point.x - state.position.x, entry.point.y - state.position.y) >= 2), `해안 도시 초근접 중복: ${state.name}`);
  activeSettlementPositions.push({ name: state.name, point: state.position });
}

const countries = demoMap.factions.filter((faction: { kind: string; id: string }) => faction.kind === "country");
assert(countries.length === 5, "데모 국가 수가 5개가 아님");
assert((demoMap.territories ?? []).length > 0, "데모 국가 영토가 없음");
assert((demoMap.territories ?? []).every((territory: { id: string }) => territory.id.startsWith("generated-territory-")), "데모가 이전 영토를 재사용함");
const demoTerritoryOwners = new Set((demoMap.territories ?? []).flatMap((territory: { states: Array<{ value: { ownerFactionId?: string } }> }) => territory.states.map((state) => state.value.ownerFactionId).filter(Boolean)));
assert(countries.every((country: { id: string }) => demoTerritoryOwners.has(country.id)), "모든 데모 국가의 영토가 새로 생성되지 않음");
assert(demoMap.locations.length >= 40, "데모 장소 수가 부족함");
assert(demoMap.events.length >= 15, "데모 사건 수가 부족함");
assert(demo.wikiArticles.length >= 120, "데모 위키 문서 수가 부족함");

console.log(JSON.stringify({
  status: "passed",
  version: PROGRAM_VERSION,
  koppenClasses: Object.keys(KOPPEN_TERRAIN_PRIORS).length,
  powerOfTwoSizes: POWER_OF_TWO_SIZES,
  demoGrid: [demoGenerated.gridWidth, demoGenerated.gridHeight],
  demoRender: [demoGenerated.renderWidth, demoGenerated.renderHeight],
  demoCountries: countries.length,
  demoLocations: demoMap.locations.length,
  demoEvents: demoMap.events.length,
  demoArticles: demo.wikiArticles.length,
  riverMagnitudeRange: [
    Math.min(...demoGenerated.rivers.map((segment: { magnitude: number }) => segment.magnitude)),
    Math.max(...demoGenerated.rivers.map((segment: { magnitude: number }) => segment.magnitude)),
  ],
  maxRoadTurn: Number(maxRoadTurn.toFixed(2)),
  maxContourTurn: Number(maxContourTurn.toFixed(2)),
  maxRiverTurn: Number(maxRiverTurn.toFixed(2)),
  activeSettlements: activeSettlementPositions.length,
  defaultPreviewMs: Number(defaultPreviewMs.toFixed(1)),
  defaultPreviewContours: defaultPreview.contours.length,
}, null, 2));
