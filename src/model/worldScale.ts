import type {
  GeneratedMapData,
  LineSegment,
  MapData,
  Point,
  TemporalState,
} from "./world";

function scalePoint(point: Point, scaleX: number, scaleY: number): Point {
  return { x: point.x * scaleX, y: point.y * scaleY };
}

function scalePoints(points: Point[], scaleX: number, scaleY: number): Point[] {
  return points.map((point) => scalePoint(point, scaleX, scaleY));
}

function scaleSegments<T extends LineSegment>(
  segments: T[],
  scaleX: number,
  scaleY: number,
): T[] {
  return segments.map((segment) => ({
    ...segment,
    start: scalePoint(segment.start, scaleX, scaleY),
    end: scalePoint(segment.end, scaleX, scaleY),
  }));
}

function scaleTemporalValue<T>(
  state: TemporalState<T>,
  transform: (value: T) => T,
): TemporalState<T> {
  return { ...state, value: transform(state.value) };
}

function scaleGeneratedMap(
  generated: GeneratedMapData,
  scaleX: number,
  scaleY: number,
  nextWidth: number,
  nextHeight: number,
  nextWorldCoordinateScale?: number,
): GeneratedMapData {
  return {
    ...generated,
    settings: {
      ...generated.settings,
      worldCoordinateScale:
        nextWorldCoordinateScale ?? generated.settings.worldCoordinateScale ?? 1,
    },
    worldWidth: nextWidth,
    worldHeight: nextHeight,
    surfaceRegions: generated.surfaceRegions?.map((region) => ({
      ...region,
      polygons: region.polygons.map((polygon) =>
        scalePoints(polygon, scaleX, scaleY),
      ),
    })),
    coastline: scaleSegments(generated.coastline, scaleX, scaleY),
    contours: scaleSegments(generated.contours, scaleX, scaleY),
    rivers: scaleSegments(generated.rivers, scaleX, scaleY),
    generatedTerritories: generated.generatedTerritories.map((territory) => ({
      ...territory,
      center: scalePoint(territory.center, scaleX, scaleY),
      polygon: scalePoints(territory.polygon, scaleX, scaleY),
      holes: territory.holes?.map((hole) => scalePoints(hole, scaleX, scaleY)),
    })),
  };
}

/**
 * 논리 월드 좌표 공간을 바꾸면서 지도상의 모든 벡터 요소를 같은 비율로 재투영한다.
 * 래스터 환경 배열과 물리적 km 축척, 계산/렌더 해상도는 바꾸지 않는다.
 */
export function rescaleMapWorld(
  map: MapData,
  nextWidth: number,
  nextHeight: number,
  nextWorldCoordinateScale?: number,
): MapData {
  const safeWidth = Math.max(1e-6, nextWidth);
  const safeHeight = Math.max(1e-6, nextHeight);
  const scaleX = safeWidth / Math.max(1e-6, map.width);
  const scaleY = safeHeight / Math.max(1e-6, map.height);
  const uniformRadiusScale = Math.sqrt(Math.abs(scaleX * scaleY));

  return {
    ...map,
    width: safeWidth,
    height: safeHeight,
    lastModifiedDate: new Date().toISOString(),
    generatedStates: map.generatedStates.map((state) =>
      scaleTemporalValue(state, (generated) =>
        generated
          ? scaleGeneratedMap(
              generated,
              scaleX,
              scaleY,
              safeWidth,
              safeHeight,
              nextWorldCoordinateScale,
            )
          : null,
      ),
    ),
    terrains: map.terrains.map((terrain) => ({
      ...terrain,
      points: scalePoints(terrain.points, scaleX, scaleY),
    })),
    contourLines: map.contourLines.map((line) => ({
      ...line,
      points: scalePoints(line.points, scaleX, scaleY),
    })),
    locations: map.locations.map((location) => ({
      ...location,
      states: location.states.map((state) =>
        scaleTemporalValue(state, (value) => ({
          ...value,
          position: scalePoint(value.position, scaleX, scaleY),
        })),
      ),
    })),
    roads: map.roads.map((road) => ({
      ...road,
      nodes: road.nodes.map((node) => ({
        ...node,
        ...scalePoint(node, scaleX, scaleY),
      })),
    })),
    rivers: map.rivers.map((river) => ({
      ...river,
      nodes: river.nodes.map((node) => ({
        ...node,
        ...scalePoint(node, scaleX, scaleY),
      })),
    })),
    mountains: map.mountains.map((mountain) => ({
      ...mountain,
      peakPosition: scalePoint(mountain.peakPosition, scaleX, scaleY),
      baseRadius: mountain.baseRadius * uniformRadiusScale,
    })),
    placeNames: map.placeNames.map((placeName) => ({
      ...placeName,
      position: scalePoint(placeName.position, scaleX, scaleY),
      path: placeName.path
        ? scalePoints(placeName.path, scaleX, scaleY)
        : undefined,
      pathOffset:
        placeName.pathOffset === undefined
          ? undefined
          : placeName.pathOffset * uniformRadiusScale,
    })),
    territories: map.territories.map((territory) => ({
      ...territory,
      states: territory.states.map((state) =>
        scaleTemporalValue(state, (value) => ({
          ...value,
          polygon: scalePoints(value.polygon, scaleX, scaleY),
          holes: value.holes?.map((hole) =>
            scalePoints(hole, scaleX, scaleY),
          ),
        })),
      ),
    })),
    events: map.events.map((event) => ({
      ...event,
      location: event.location
        ? scalePoint(event.location, scaleX, scaleY)
        : null,
    })),
    environmentPins: map.environmentPins.map((pin) => ({
      ...pin,
      position: scalePoint(pin.position, scaleX, scaleY),
    })),
  };
}
