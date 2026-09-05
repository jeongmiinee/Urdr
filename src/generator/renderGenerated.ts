import type { CoastalTerrainType, GeneratedMapData, GeneratedSurface, Point, TerrainType, TimelineState } from "../model/world";
import { smoothPath, stitchSegments } from "./pathSmoothing";
import { effectiveTerrainAt, naturalTerrainAt } from "./agriculture";
import { isSafeSurfacePolygon } from "./surfaceVectors";
import { renderedRiverEdges } from "../hydrology/riverQueries";
import { minimumRiverScreenWidth } from "../hydrology/riverDisplay";

const TERRAIN_COLORS: Record<TerrainType, [number, number, number]> = {
  mountain: [119, 101, 84],
  forest: [42, 102, 70],
  desert: [211, 168, 78],
  snow: [232, 240, 245],
  grassland: [116, 161, 72],
  plain: [157, 184, 91],
  farmland: [176, 166, 82],
  jungle: [28, 91, 48],
  wetland: [73, 105, 91],
  rock: [132, 113, 92],
  bedrock: [96, 80, 68],
};
const COASTAL_COLORS: Partial<Record<CoastalTerrainType, [number, number, number]>> = {
  sand_beach: [226, 205, 142],
  gravel_beach: [151, 145, 129],
  rocky_coast: [91, 96, 99],
  coastal_cliff: [89, 77, 67],
  mudflat: [132, 119, 91],
  salt_marsh: [82, 124, 92],
  sandbar: [218, 196, 128],
  lagoon: [75, 154, 171],
  delta: [112, 145, 89],
  estuary: [74, 132, 151],
};

export const GENERATED_SURFACE_COLORS: Record<GeneratedSurface, [number, number, number]> = {
  ...TERRAIN_COLORS,
  saltwater: [38, 104, 151],
  freshwater: [56, 139, 176],
};

export const GENERATED_SURFACE_DRAW_ORDER: GeneratedSurface[] = [
  "saltwater", "bedrock", "rock", "mountain", "desert", "snow", "plain", "grassland",
  "forest", "jungle", "wetland", "farmland", "freshwater",
];

/** 래스터 셀을 직접 보이지 않게 하고 연결 지형의 곡선 벡터 멀티폴리곤으로 덮어 그린다. */
export function drawGeneratedSurfaceRegions(canvas: HTMLCanvasElement, data: GeneratedMapData, opacity = 0.96): void {
  if (!data.surfaceRegions?.length) return;
  const context = canvas.getContext("2d");
  if (!context) return;
  const scaleX = canvas.width / Math.max(1e-9, data.worldWidth);
  const scaleY = canvas.height / Math.max(1e-9, data.worldHeight);
  const grouped = new Map(data.surfaceRegions.map((region) => [region.surface, region.polygons]));
  context.save();
  context.globalAlpha = opacity;
  context.imageSmoothingEnabled = true;
  for (const surface of GENERATED_SURFACE_DRAW_ORDER) {
    const polygons = grouped.get(surface)?.filter((polygon) =>
      isSafeSurfacePolygon(data, polygon),
    );
    if (!polygons?.length) continue;
    const [r, g, b] = GENERATED_SURFACE_COLORS[surface];
    context.fillStyle = `rgb(${r},${g},${b})`;
    context.beginPath();
    for (const polygon of polygons) {
      if (polygon.length < 3) continue;
      context.moveTo(polygon[0].x * scaleX, polygon[0].y * scaleY);
      for (let index = 1; index < polygon.length; index += 1) context.lineTo(polygon[index].x * scaleX, polygon[index].y * scaleY);
      context.closePath();
    }
    context.fill("evenodd");
  }
  context.restore();
}

/** Draws the authoritative vector surface model into the current preview canvas. */
export function createGeneratedVectorSurfaceCanvas(
  data: GeneratedMapData,
  targetWidth: number,
  targetHeight: number,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(targetWidth));
  canvas.height = Math.max(1, Math.round(targetHeight));
  const context = canvas.getContext("2d");
  if (!context) return canvas;
  const [red, green, blue] = GENERATED_SURFACE_COLORS.plain;
  context.fillStyle = `rgb(${red},${green},${blue})`;
  context.fillRect(0, 0, canvas.width, canvas.height);
  drawGeneratedSurfaceRegions(canvas, data, 1);
  return canvas;
}



function orderedSegmentPaths<T extends { start: Point; end: Point; curveId?: number; sequence?: number }>(
  segments: T[],
  tolerance: number,
): Point[][] {
  if (segments.length === 0) return [];
  if (segments.every((segment) => segment.curveId !== undefined)) {
    const groups = new Map<number, T[]>();
    for (const segment of segments) {
      const key = segment.curveId ?? -1;
      const list = groups.get(key) ?? [];
      list.push(segment);
      groups.set(key, list);
    }
    return [...groups.values()].map((group) => {
      const ordered = [...group].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
      return ordered.length ? [ordered[0].start, ...ordered.map((segment) => segment.end)] : [];
    }).filter((path) => path.length >= 2);
  }
  return stitchSegments(segments, tolerance);
}

function clampByte(value: number): number { return Math.max(0, Math.min(255, Math.round(value))); }

function waterColor(depth: number): [number, number, number] {
  const normalized = Math.max(0, Math.min(1, depth / 5000));
  return [Math.round(48 - normalized * 23), Math.round(126 - normalized * 47), Math.round(170 - normalized * 48)];
}

function textureNoise(x: number, y: number, seed: number): number {
  let value = Math.imul((x + 1) ^ seed, 374761393) ^ Math.imul((y + 1) + seed, 668265263);
  value = (value ^ (value >>> 13)) * 1274126177;
  return ((value ^ (value >>> 16)) >>> 0) / 0xffffffff;
}

/** 지형 데이터는 바꾸지 않고 색상 보간과 미세 명암만 고해상도로 합성한다. */
export function createGeneratedMapCanvas(
  data: GeneratedMapData,
  maximumLiveDimension = 4096,
  targetWidth = 0,
  targetHeight = 0,
  includeSurfaceRegions = true,
): HTMLCanvasElement {
  const sourceColors = new Uint8ClampedArray(data.gridWidth * data.gridHeight * 4);
  const submergedMask = new Uint8Array(data.gridWidth * data.gridHeight);
  for (let y = 0; y < data.gridHeight; y += 1) {
    for (let x = 0; x < data.gridWidth; x += 1) {
      const index = y * data.gridWidth + x;
      const elevation = data.elevationMap[index];
      const waterType = data.waterTypeMap?.[index] ?? (elevation <= data.seaLevel ? "saltwater" : "land");
      const submerged = waterType !== "land";
      submergedMask[index] = submerged ? 1 : 0;
      const terrain = effectiveTerrainAt(data, index);
      const naturalTerrain = naturalTerrainAt(data, index);
      const baseTerrain = terrain === "farmland" ? terrain : (data.snowBaseTerrainMap?.[index] ?? naturalTerrain);
      const terrainColor = TERRAIN_COLORS[baseTerrain] ?? TERRAIN_COLORS[terrain] ?? TERRAIN_COLORS.plain;
      let [baseR, baseG, baseB] = submerged
        ? waterType === "freshwater" ? [56, 139, 176] : waterColor(data.seaLevel - elevation)
        : terrainColor;
      const coastalType = data.coastalTerrainMap?.[index] ?? "none";
      const coastalColor = COASTAL_COLORS[coastalType];
      if (coastalColor) {
        const mix = submerged ? 0.78 : 0.86;
        baseR += (coastalColor[0] - baseR) * mix; baseG += (coastalColor[1] - baseG) * mix; baseB += (coastalColor[2] - baseB) * mix;
      }
      if (!submerged) {
        const fallbackSnow = terrain === "snow" ? 1 : 0;
        const snowCover = Math.max(0, Math.min(1, data.snowCoverMap?.[index] ?? fallbackSnow));
        const snowMix = Math.pow(snowCover, 0.82) * 0.96;
        baseR += (242 - baseR) * snowMix; baseG += (247 - baseG) * snowMix; baseB += (250 - baseB) * snowMix;
      }
      const left = data.elevationMap[y * data.gridWidth + Math.max(0, x - 1)];
      const right = data.elevationMap[y * data.gridWidth + Math.min(data.gridWidth - 1, x + 1)];
      const up = data.elevationMap[Math.max(0, y - 1) * data.gridWidth + x];
      const down = data.elevationMap[Math.min(data.gridHeight - 1, y + 1) * data.gridWidth + x];
      const slopeShade = Math.max(-0.18, Math.min(0.18, (left - right + up - down) / 8500));
      const offset = index * 4;
      sourceColors[offset] = clampByte(baseR * (1 + slopeShade)); sourceColors[offset + 1] = clampByte(baseG * (1 + slopeShade)); sourceColors[offset + 2] = clampByte(baseB * (1 + slopeShade)); sourceColors[offset + 3] = 255;
    }
  }

  const requestedWidth = Math.max(data.gridWidth, data.renderWidth ?? data.gridWidth, Math.round(targetWidth));
  const requestedHeight = Math.max(data.gridHeight, data.renderHeight ?? data.gridHeight, Math.round(targetHeight));
  const requestedScale = Math.min(1, maximumLiveDimension / Math.max(requestedWidth, requestedHeight));
  const desiredWidth = Math.max(data.gridWidth * 2, Math.round(requestedWidth * requestedScale));
  const desiredHeight = Math.max(data.gridHeight * 2, Math.round(requestedHeight * requestedScale));
  const detailScale = Math.min(1, maximumLiveDimension / Math.max(desiredWidth, desiredHeight));
  const outputWidth = Math.max(data.gridWidth, Math.round(desiredWidth * detailScale));
  const outputHeight = Math.max(data.gridHeight, Math.round(desiredHeight * detailScale));
  const canvas = document.createElement("canvas"); canvas.width = outputWidth; canvas.height = outputHeight;
  const context = canvas.getContext("2d"); if (!context) return canvas;
  const image = context.createImageData(outputWidth, outputHeight);
  const seed = data.settings.seed | 0;
  for (let y = 0; y < outputHeight; y += 1) {
    const sourceY = ((y + 0.5) / outputHeight) * data.gridHeight - 0.5;
    const sy = Math.max(0, Math.min(data.gridHeight - 1, sourceY));
    const y0 = Math.floor(sy); const y1 = Math.min(data.gridHeight - 1, y0 + 1); const ty = sy - y0;
    for (let x = 0; x < outputWidth; x += 1) {
      const sourceX = ((x + 0.5) / outputWidth) * data.gridWidth - 0.5;
      const sx = Math.max(0, Math.min(data.gridWidth - 1, sourceX));
      const x0 = Math.floor(sx); const x1 = Math.min(data.gridWidth - 1, x0 + 1); const tx = sx - x0;
      const indices = [y0 * data.gridWidth + x0, y0 * data.gridWidth + x1, y1 * data.gridWidth + x0, y1 * data.gridWidth + x1];
      const mixedWater = submergedMask[indices[0]] !== submergedMask[indices[1]] || submergedMask[indices[0]] !== submergedMask[indices[2]] || submergedMask[indices[0]] !== submergedMask[indices[3]];
      const nearest = (Math.round(sy) * data.gridWidth + Math.round(sx));
      const out = (y * outputWidth + x) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        let value: number;
        if (mixedWater) value = sourceColors[nearest * 4 + channel];
        else {
          const top = sourceColors[indices[0] * 4 + channel] * (1 - tx) + sourceColors[indices[1] * 4 + channel] * tx;
          const bottom = sourceColors[indices[2] * 4 + channel] * (1 - tx) + sourceColors[indices[3] * 4 + channel] * tx;
          value = top * (1 - ty) + bottom * ty;
        }
        const fine = (textureNoise(x, y, seed + channel * 101) - 0.5) * 5.2;
        const broad = Math.sin((x + seed % 97) * 0.071) * Math.cos((y - seed % 83) * 0.063) * 1.7;
        image.data[out + channel] = clampByte(value + fine + broad);
      }
      image.data[out + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  if (includeSurfaceRegions) drawGeneratedSurfaceRegions(canvas, data, 0.965);
  return canvas;
}

export function drawGeneratedPreviewOverlays(
  canvas: HTMLCanvasElement,
  data: GeneratedMapData,
  showContours = true,
  showCoastline = false,
): void {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("2D Canvas 컨텍스트를 만들 수 없습니다.");
  const scaleX = canvas.width / Math.max(1e-9, data.worldWidth);
  const scaleY = canvas.height / Math.max(1e-9, data.worldHeight);

  context.lineCap = "round";
  context.lineJoin = "round";
  if (showCoastline) {
    context.strokeStyle = "rgba(242,248,252,0.88)";
    context.lineWidth = Math.max(0.8, canvas.width / 900);
    const coastTolerance = Math.max(data.worldWidth / data.gridWidth, data.worldHeight / data.gridHeight) * 0.12;
    for (const path of stitchSegments(data.coastline, coastTolerance)) {
      const closed = path.length > 3 && Math.hypot(path[0].x - path[path.length - 1].x, path[0].y - path[path.length - 1].y) <= coastTolerance * 2.5;
      const smoothed = smoothPath(closed ? path.slice(0, -1) : path, { closed, samplesPerSegment: 4, iterations: 1 });
      if (smoothed.length < 2) continue;
      context.beginPath(); context.moveTo(smoothed[0].x * scaleX, smoothed[0].y * scaleY);
      for (const point of smoothed.slice(1)) context.lineTo(point.x * scaleX, point.y * scaleY);
      if (closed) context.closePath(); context.stroke();
    }
  }

  const riverEdges = renderedRiverEdges(data);
  if (riverEdges.length) {
    context.strokeStyle = "rgba(72, 161, 224, 0.92)";
    const pixelsPerMeter = canvas.width / Math.max(1, data.settings.mapScaleKm * 1_000);
    for (const edge of [...riverEdges].sort((a, b) => a.order - b.order || a.id - b.id)) {
      for (let index = 1; index < edge.centerline.length; index += 1) {
        const start = edge.centerline[index - 1];
        const end = edge.centerline[index];
        context.beginPath();
        context.moveTo(start.x * scaleX, start.y * scaleY);
        context.lineTo(end.x * scaleX, end.y * scaleY);
        context.lineWidth = Math.max(
          minimumRiverScreenWidth(1),
          (edge.widthMeters[index - 1] + edge.widthMeters[index]) * 0.5 * pixelsPerMeter,
        );
        context.stroke();
      }
    }
  }

  if (showContours) {
    const contourTolerance = Math.max(data.worldWidth / data.gridWidth, data.worldHeight / data.gridHeight) * 0.12;
    for (const major of [false, true]) {
      const levels = Array.from(new Set(data.contours.filter((line) => line.isMajor === major).map((line) => line.elevation)));
      context.strokeStyle = major ? "rgba(38,31,26,0.58)" : "rgba(45,39,34,0.28)";
      context.lineWidth = (major ? 1 : 0.55) * Math.max(0.7, canvas.width / 960);
      for (const level of levels) {
        const segments = data.contours.filter((line) => line.isMajor === major && line.elevation === level);
        for (const path of orderedSegmentPaths(segments, contourTolerance)) {
          const closed = path.length > 3 && Math.hypot(path[0].x - path[path.length - 1].x, path[0].y - path[path.length - 1].y) <= contourTolerance * 2.5;
          const smoothed = smoothPath(closed ? path.slice(0, -1) : path, { closed, samplesPerSegment: 4, iterations: 1 });
          if (smoothed.length < 2) continue;
          context.beginPath();
          context.moveTo(smoothed[0].x * scaleX, smoothed[0].y * scaleY);
          for (const point of smoothed.slice(1)) context.lineTo(point.x * scaleX, point.y * scaleY);
          if (closed) context.closePath();
          context.stroke();
        }
      }
    }
  }
}

export type EnvironmentLayerKind = "temperature" | "precipitation" | "snowfall" | "evapotranspiration" | "soilMoisture" | "windSpeed" | "humidity" | "solarHours" | "solarIrradiance";

function interpolateColor(stops: Array<[number, [number, number, number]]>, value: number): [number, number, number] {
  const sorted=[...stops].sort((a,b)=>a[0]-b[0]);
  if(value<=sorted[0][0])return sorted[0][1];if(value>=sorted[sorted.length-1][0])return sorted[sorted.length-1][1];
  for(let i=0;i<sorted.length-1;i+=1){const[a,ca]=sorted[i], [b,cb]=sorted[i+1];if(value>=a&&value<=b){const t=(value-a)/Math.max(1e-9,b-a);return [ca[0]+(cb[0]-ca[0])*t,ca[1]+(cb[1]-ca[1])*t,ca[2]+(cb[2]-ca[2])*t].map(Math.round) as [number,number,number];}}
  return sorted[0][1];
}

function hashSigned(index: number, salt: number): number {
  let n = Math.imul(index + 1, 0x45d9f3b) ^ Math.imul(salt + 17, 0x27d4eb2d);
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b); n ^= n >>> 16;
  return ((n >>> 0) / 0xffffffff) * 2 - 1;
}

function monthOfTimeline(timeline: TimelineState, yearLengthDays: number): number {
  return Math.max(1, Math.min(12, Math.floor((timeline.currentDayOfYear / Math.max(1, yearLengthDays)) * 12) + 1));
}

export function environmentValueAtTimeline(
  data: GeneratedMapData,
  kind: EnvironmentLayerKind,
  index: number,
  timeline?: TimelineState,
  yearLengthDays = 360,
): number {
  const temperature = data.temperatureMap[index] ?? 0;
  const precipitation = data.precipitationMap[index] ?? 0;
  const moisture = Math.max(0, Math.min(1, data.moistureMap[index] ?? 0));
  const snowCover = Math.max(0, Math.min(1, data.snowCoverMap?.[index] ?? 0));
  const potentialEvapotranspiration = Math.max(0, (temperature + 5) * 18 + (data.solarIrradianceMap[index] ?? 0) * 26);
  const annualEvapotranspiration = Math.min(precipitation + moisture * 220, potentialEvapotranspiration) * (0.42 + moisture * 0.52);
  const annualSnowfall = precipitation * snowCover * Math.max(0.08, Math.min(1, (4 - temperature) / 12));
  const base = kind === "temperature" ? temperature
    : kind === "precipitation" ? precipitation
      : kind === "snowfall" ? annualSnowfall
        : kind === "evapotranspiration" ? annualEvapotranspiration
          : kind === "soilMoisture" ? moisture * 100
            : kind === "humidity" ? data.relativeHumidityMap[index]
              : kind === "solarHours" ? data.solarHoursMap[index]
                : kind === "solarIrradiance" ? data.solarIrradianceMap[index]
                  : Math.hypot(data.windXMap[index] ?? 0, data.windYMap[index] ?? 0);
  if (!timeline || timeline.precision === "year") return base;
  const month = monthOfTimeline(timeline, yearLengthDays);
  const hemisphere = (data.settings.latitudeDeg ?? 35) < 0 ? -1 : 1;
  const seasonal = Math.sin(((month - 1) / 12) * Math.PI * 2 - Math.PI / 2) * hemisphere;
  const dayNoise = hashSigned(index, timeline.currentYear * 397 + timeline.currentDayOfYear * 31);
  const minutePhase = (timeline.currentMinuteOfDay / 1440) * Math.PI * 2;
  const diurnal = Math.sin(minutePhase - Math.PI / 2);
  const precision = timeline.precision;
  if (kind === "temperature") {
    const annualRange = Math.max(4, data.settings.annualTemperatureRangeC ?? 18);
    const daily = precision === "date" || precision === "time" ? dayNoise * 1.8 : 0;
    const hourly = precision === "time" ? diurnal * Math.min(7, annualRange * 0.22) : 0;
    return base + seasonal * annualRange * 0.48 + daily + hourly;
  }
  if (kind === "humidity") {
    const hourly = precision === "time" ? -diurnal * 7 : 0;
    return Math.max(0, Math.min(100, base - seasonal * 7 + (precision === "date" || precision === "time" ? dayNoise * 4 : 0) + hourly));
  }
  if (kind === "windSpeed") {
    return Math.max(0, base * (1 + seasonal * 0.1 + (precision === "date" || precision === "time" ? dayNoise * 0.17 : 0) + (precision === "time" ? Math.max(0, diurnal) * 0.12 : 0)));
  }
  if (kind === "precipitation" || kind === "snowfall" || kind === "evapotranspiration") {
    const wetSeasonFactor = kind === "evapotranspiration" ? 1 + seasonal * 0.22 : 1 - seasonal * 0.3;
    const monthTotal = Math.max(0, base / 12 * wetSeasonFactor);
    if (precision === "month") return monthTotal;
    const dayTotal = Math.max(0, monthTotal / 30 * (1 + dayNoise * (kind === "evapotranspiration" ? 0.18 : 0.8)));
    if (precision === "week") return dayTotal * 7;
    if (precision === "date") return dayTotal;
    const pulse = kind === "evapotranspiration" ? Math.max(0.1, Math.sin(minutePhase - Math.PI / 2)) : Math.max(0, Math.sin(minutePhase * 2 + hashSigned(index, timeline.currentYear) * Math.PI));
    return dayTotal / 24 * pulse * (kind === "evapotranspiration" ? 1.55 : 2.2);
  }
  if (kind === "soilMoisture") {
    const seasonalMoisture = base - seasonal * 9 + dayNoise * (precision === "date" || precision === "time" ? 3.5 : 1.2);
    return Math.max(0, Math.min(100, seasonalMoisture));
  }
  if (kind === "solarHours") {
    const monthly = Math.max(0, Math.min(24, base + seasonal * 2.8));
    if (precision === "month" || precision === "week") return monthly;
    const daily = Math.max(0, Math.min(24, monthly + dayNoise * 1.2));
    if (precision === "date") return daily;
    return Math.max(0, Math.min(1, Math.sin(minutePhase - Math.PI / 2))) * (daily > 0 ? 1 : 0);
  }
  const monthly = Math.max(0, base * (1 + seasonal * 0.25));
  if (precision === "month" || precision === "week") return monthly;
  const daily = Math.max(0, monthly * (1 + dayNoise * 0.12));
  if (precision === "date") return daily;
  return Math.max(0, daily * Math.max(0, Math.sin(minutePhase - Math.PI / 2)) * 1.7);
}

function environmentValues(data: GeneratedMapData, kind: EnvironmentLayerKind, timeline?: TimelineState, yearLengthDays = 360): number[] {
  const length = data.gridWidth * data.gridHeight;
  return Array.from({ length }, (_, index) => environmentValueAtTimeline(data, kind, index, timeline, yearLengthDays));
}

export function environmentUnit(kind: EnvironmentLayerKind, precision: TimelineState["precision"] = "year"): string {
  if (kind === "temperature") return "°C";
  if (kind === "humidity" || kind === "soilMoisture") return "%";
  if (kind === "windSpeed") return "m/s";
  if (kind === "precipitation" || kind === "snowfall" || kind === "evapotranspiration") {
    return precision === "year" ? "mm/년" : precision === "month" ? "mm/월" : precision === "week" ? "mm/주" : precision === "date" ? "mm/일" : "mm/시";
  }
  if (kind === "solarHours") return precision === "time" ? "현재" : "시간/일";
  return precision === "time" ? "kW/㎡" : "kWh/㎡/일";
}

export function environmentRange(data: GeneratedMapData, kind: EnvironmentLayerKind, timeline?: TimelineState, yearLengthDays = 360): { min: number; max: number; unit: string } {
  const values=environmentValues(data,kind,timeline,yearLengthDays);
  let min=Number.POSITIVE_INFINITY,max=Number.NEGATIVE_INFINITY;
  for(const value of values){if(!Number.isFinite(value))continue;if(value<min)min=value;if(value>max)max=value;}
  if(!Number.isFinite(min)||!Number.isFinite(max)){min=0;max=0;}
  return {min,max,unit:environmentUnit(kind,timeline?.precision)};
}

export function createEnvironmentMapCanvas(data: GeneratedMapData, kind: EnvironmentLayerKind, targetWidth = data.gridWidth, targetHeight = data.gridHeight, timeline?: TimelineState, yearLengthDays = 360): HTMLCanvasElement {
  const canvas=document.createElement("canvas");canvas.width=data.gridWidth;canvas.height=data.gridHeight;const context=canvas.getContext("2d");if(!context)return canvas;
  const image=context.createImageData(data.gridWidth,data.gridHeight);const values=environmentValues(data,kind,timeline,yearLengthDays);
  const range=environmentRange(data,kind,timeline,yearLengthDays);const span=Math.max(1e-9,range.max-range.min);
  for(let index=0;index<values.length;index+=1){const normalized=(values[index]-range.min)/span;let color:[number,number,number];
    if(kind==="temperature")color=interpolateColor([[0,[38,76,165]],[0.35,[102,194,165]],[0.55,[245,226,123]],[0.76,[240,126,69]],[1,[163,34,50]]],normalized);
    else if(kind==="precipitation")color=interpolateColor([[0,[230,224,188]],[0.3,[149,196,117]],[0.62,[61,149,125]],[1,[33,79,146]]],normalized);
    else if(kind==="snowfall")color=interpolateColor([[0,[84,105,124]],[0.38,[151,186,208]],[0.72,[224,239,248]],[1,[255,255,255]]],normalized);
    else if(kind==="evapotranspiration")color=interpolateColor([[0,[71,105,134]],[0.4,[89,166,129]],[0.72,[225,195,92]],[1,[197,92,57]]],normalized);
    else if(kind==="soilMoisture")color=interpolateColor([[0,[187,143,84]],[0.36,[176,184,110]],[0.66,[75,156,139]],[1,[41,91,151]]],normalized);
    else if(kind==="humidity")color=interpolateColor([[0,[224,198,132]],[0.38,[147,194,169]],[0.7,[73,157,171]],[1,[35,92,151]]],normalized);
    else if(kind==="solarHours"||kind==="solarIrradiance")color=interpolateColor([[0,[74,74,112]],[0.35,[135,118,164]],[0.62,[240,180,76]],[1,[255,242,145]]],normalized);
    else color=interpolateColor([[0,[223,239,247]],[0.45,[93,180,205]],[0.72,[49,116,169]],[1,[118,52,148]]],normalized);
    const offset=index*4;image.data[offset]=color[0];image.data[offset+1]=color[1];image.data[offset+2]=color[2];image.data[offset+3]=255;
  }
  context.putImageData(image,0,0);
  const outputWidth=Math.max(data.gridWidth,Math.round(targetWidth));const outputHeight=Math.max(data.gridHeight,Math.round(targetHeight));
  if(outputWidth===canvas.width&&outputHeight===canvas.height)return canvas;
  const output=document.createElement("canvas");output.width=outputWidth;output.height=outputHeight;const outputContext=output.getContext("2d");if(!outputContext)return canvas;
  outputContext.imageSmoothingEnabled=true;outputContext.imageSmoothingQuality="high";outputContext.drawImage(canvas,0,0,outputWidth,outputHeight);return output;
}

/** 바탕을 끈 상태에서도 바다와 호수의 범위가 읽히도록 물만 옅게 그린다. */
export function createWaterOnlyCanvas(data: GeneratedMapData, targetWidth = data.gridWidth, targetHeight = data.gridHeight): HTMLCanvasElement {
  const canvas=document.createElement("canvas"); canvas.width=data.gridWidth; canvas.height=data.gridHeight;
  const context=canvas.getContext("2d"); if(!context)return canvas;
  const image=context.createImageData(data.gridWidth,data.gridHeight);
  for(let index=0; index<data.gridWidth*data.gridHeight; index+=1){
    const type=data.waterTypeMap?.[index] ?? (data.elevationMap[index] <= data.seaLevel ? "saltwater" : "land");
    const offset=index*4;
    if(type==="land"){image.data[offset]=248;image.data[offset+1]=248;image.data[offset+2]=246;image.data[offset+3]=255;continue;}
    const freshwater=type==="freshwater";
    const depth=Math.max(0,data.seaLevel-data.elevationMap[index]);
    image.data[offset]=freshwater?185:176-Math.min(20,depth/400);
    image.data[offset+1]=freshwater?220:211-Math.min(24,depth/350);
    image.data[offset+2]=freshwater?232:229-Math.min(18,depth/500);
    image.data[offset+3]=255;
  }
  context.putImageData(image,0,0);
  if(targetWidth===canvas.width&&targetHeight===canvas.height)return canvas;
  const output=document.createElement("canvas");output.width=Math.round(targetWidth);output.height=Math.round(targetHeight);const out=output.getContext("2d");if(!out)return canvas;
  out.imageSmoothingEnabled=true;out.imageSmoothingQuality="high";out.drawImage(canvas,0,0,output.width,output.height);return output;
}
