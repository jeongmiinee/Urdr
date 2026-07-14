import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { generateWorldMap } from "../src/generator/generateWorld";
import { createGridTransform, POWER_OF_TWO_SIZES } from "../src/generator/gridTransform";
import { applyGeneratedCountries } from "../src/generator/mapPlacement";
import { KOPPEN_TERRAIN_PRIORS, TERRAIN_ATLAS_METADATA } from "../src/generator/terrainAtlas";
import {
  createEmptyMap,
  defaultGeneratorSettings,
  getStateAtYear,
  PROGRAM_VERSION,
  type Point,
  formatTimelineMoment,
} from "../src/model/world";
import { rescaleMapWorld } from "../src/model/worldScale";

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

assert(PROGRAM_VERSION === "0.99u", "프로그램 버전이 0.99u가 아님");
const yearFormatProject = (await import("../src/model/world")).createEmptyProject("연도 표기 검증");
assert(formatTimelineMoment(yearFormatProject, { ...yearFormatProject.maps[0]?.timeline ?? createEmptyMap().timeline, currentYear: 909, precision: "year" }) === "909년", "표준 연도 선행 0 제거 실패");
assert(Object.keys(KOPPEN_TERRAIN_PRIORS).length === 31, "쾨펜 기후 31종 지형 사전확률이 없음");
assert(TERRAIN_ATLAS_METADATA.coordinatePolicy === "aggregated-statistics-only", "지형 아틀라스가 실제 좌표를 보존함");

const transform = createGridTransform(1000, 500, 1024, 512);
const center = transform.cellCenterToWorld(0, 0);
assert(Math.abs(center.x - 1000 / 2048) < 1e-9, "셀 중심 X 변환 오류");
assert(Math.abs(center.y - 500 / 1024) < 1e-9, "셀 중심 Y 변환 오류");
assert(transform.worldToCell(center).index === 0, "월드→셀 왕복 변환 오류");
assert(transform.cellBoundaryToWorld(1024, 512).x === 1000, "오른쪽 경계 좌표 오류");
assert(transform.cellBoundaryToWorld(1024, 512).y === 500, "아래쪽 경계 좌표 오류");

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

const compressedDemo = await readFile(new URL("../public/demoProjectData.json.gz", import.meta.url));
const demo = JSON.parse(gunzipSync(compressedDemo).toString("utf8"));
const demoMap = demo.maps?.[0];
const demoGenerated = demoMap?.generatedStates?.[0]?.value;
assert(demo.version === "0.99u", "데모 버전이 0.99u가 아님");
assert(demoMap?.physicalWidthKm === 500, "데모 물리 폭이 500km가 아님");
assert(demoGenerated?.gridWidth === 512 && demoGenerated?.gridHeight === 256, "데모 계산 LOD가 512×256이 아님");
assert(demoGenerated?.renderWidth === 2048 && demoGenerated?.renderHeight === 1024, "데모 렌더 목표가 2048×1024가 아님");
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

const countries = demoMap.factions.filter((faction: { kind: string }) => faction.kind === "country");
assert(countries.length === 5, "데모 국가 수가 5개가 아님");
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
}, null, 2));
