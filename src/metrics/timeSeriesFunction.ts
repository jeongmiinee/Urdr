export type TimeSeriesPoint = { year: number; value: number };

export type TimeSeriesOptions = {
  logarithmic?: boolean;
  smoothing?: number;
};

export type TimeSeriesSamplingOptions = TimeSeriesOptions & {
  pixelWidth?: number;
  pixelHeight?: number;
  maximumPixelError?: number;
};

type SplineModel = {
  points: TimeSeriesPoint[];
  transformedValues: number[];
  tangents: number[];
  logarithmic: boolean;
  curveStrength: number;
};

const modelCache = new Map<string, SplineModel>();
const MAX_CACHE_SIZE = 96;
const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

export function normalizeTimeSeries(points: TimeSeriesPoint[]): TimeSeriesPoint[] {
  const latestByYear = new Map<number, TimeSeriesPoint>();
  for (const point of points) {
    if (!Number.isFinite(point.year) || !Number.isFinite(point.value)) continue;
    latestByYear.set(point.year, {
      year: point.year,
      value: Math.max(0, point.value),
    });
  }
  return [...latestByYear.values()].sort((left, right) => left.year - right.year);
}

function sign(value: number): -1 | 0 | 1 {
  return value < 0 ? -1 : value > 0 ? 1 : 0;
}

function endpointTangent(
  firstSpan: number,
  secondSpan: number,
  firstSlope: number,
  secondSlope: number,
): number {
  let tangent = ((2 * firstSpan + secondSpan) * firstSlope - firstSpan * secondSlope)
    / Math.max(1e-12, firstSpan + secondSpan);
  if (sign(tangent) !== sign(firstSlope)) return 0;
  if (sign(firstSlope) !== sign(secondSlope) && Math.abs(tangent) > Math.abs(3 * firstSlope)) {
    tangent = 3 * firstSlope;
  }
  return tangent;
}

/** Fritsch-Carlson/PCHIP-style tangents preserve extrema and never move a record. */
function shapePreservingTangents(points: TimeSeriesPoint[], values: number[]): number[] {
  const size = points.length;
  if (size < 2) return new Array(size).fill(0);
  const spans = points.slice(1).map((point, index) =>
    Math.max(1e-12, point.year - points[index].year),
  );
  const slopes = spans.map((span, index) => (values[index + 1] - values[index]) / span);
  if (size === 2) return [slopes[0], slopes[0]];

  const tangents = new Array<number>(size).fill(0);
  tangents[0] = endpointTangent(spans[0], spans[1], slopes[0], slopes[1]);
  tangents[size - 1] = endpointTangent(
    spans[size - 2],
    spans[size - 3],
    slopes[size - 2],
    slopes[size - 3],
  );

  for (let index = 1; index < size - 1; index += 1) {
    const previousSlope = slopes[index - 1];
    const nextSlope = slopes[index];
    if (previousSlope === 0 || nextSlope === 0 || sign(previousSlope) !== sign(nextSlope)) {
      tangents[index] = 0;
      continue;
    }
    const previousSpan = spans[index - 1];
    const nextSpan = spans[index];
    const previousWeight = 2 * nextSpan + previousSpan;
    const nextWeight = nextSpan + 2 * previousSpan;
    tangents[index] = (previousWeight + nextWeight)
      / (previousWeight / previousSlope + nextWeight / nextSlope);
  }
  return tangents;
}

function modelKey(points: TimeSeriesPoint[], options: TimeSeriesOptions): string {
  return `${options.logarithmic !== false ? 1 : 0}|${clamp01(options.smoothing ?? 0.58).toFixed(3)}|${points.map((point) => `${point.year}:${point.value}`).join(";")}`;
}

function fitModel(input: TimeSeriesPoint[], options: TimeSeriesOptions): SplineModel {
  const points = normalizeTimeSeries(input);
  const key = modelKey(points, options);
  const cached = modelCache.get(key);
  if (cached) return cached;

  const logarithmic = options.logarithmic !== false;
  const transformedValues = points.map((point) =>
    logarithmic ? Math.log1p(point.value) : point.value,
  );
  const model: SplineModel = {
    points,
    transformedValues,
    tangents: shapePreservingTangents(points, transformedValues),
    logarithmic,
    curveStrength: clamp01(options.smoothing ?? 0.58),
  };
  modelCache.set(key, model);
  if (modelCache.size > MAX_CACHE_SIZE) {
    modelCache.delete(modelCache.keys().next().value as string);
  }
  return model;
}

function intervalAt(points: TimeSeriesPoint[], year: number): number {
  let low = 0;
  let high = points.length - 2;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (year < points[middle].year) high = middle - 1;
    else if (year > points[middle + 1].year) low = middle + 1;
    else return middle;
  }
  return Math.max(0, Math.min(points.length - 2, low));
}

function exactAnchorValue(points: TimeSeriesPoint[], year: number): number | undefined {
  let low = 0;
  let high = points.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (year < points[middle].year) high = middle - 1;
    else if (year > points[middle].year) low = middle + 1;
    else return points[middle].value;
  }
  return undefined;
}

function evaluateModel(model: SplineModel, year: number): number {
  const { points, transformedValues: values, tangents, logarithmic, curveStrength } = model;
  if (points.length === 0) return 0;
  const anchorValue = exactAnchorValue(points, year);
  if (anchorValue !== undefined) return anchorValue;
  if (points.length === 1 || year <= points[0].year) return points[0].value;
  if (year >= points[points.length - 1].year) return points[points.length - 1].value;

  const index = intervalAt(points, year);
  const start = points[index];
  const end = points[index + 1];
  const span = end.year - start.year;
  const t = (year - start.year) / span;
  const linear = values[index] + (values[index + 1] - values[index]) * t;
  const t2 = t * t;
  const t3 = t2 * t;
  const hermite =
    (2 * t3 - 3 * t2 + 1) * values[index]
    + (t3 - 2 * t2 + t) * span * tangents[index]
    + (-2 * t3 + 3 * t2) * values[index + 1]
    + (t3 - t2) * span * tangents[index + 1];
  const minimum = Math.min(values[index], values[index + 1]);
  const maximum = Math.max(values[index], values[index + 1]);
  const transformed = Math.max(
    minimum,
    Math.min(maximum, linear + (hermite - linear) * curveStrength),
  );
  return Math.max(0, logarithmic ? Math.expm1(transformed) : transformed);
}

export function evaluateTimeSeries(
  points: TimeSeriesPoint[],
  year: number,
  options: TimeSeriesOptions = {},
): number {
  return evaluateModel(fitModel(points, options), year);
}

export function sampleTimeSeries(
  points: TimeSeriesPoint[],
  options: TimeSeriesSamplingOptions = {},
): TimeSeriesPoint[] {
  const model = fitModel(points, options);
  if (model.points.length < 2) return model.points;
  const pixelWidth = Math.max(120, options.pixelWidth ?? 760);
  const pixelHeight = Math.max(80, options.pixelHeight ?? 240);
  const maximumPixelError = Math.max(0.2, options.maximumPixelError ?? 0.7);
  const minimum = Math.min(...model.points.map((point) => point.value));
  const maximum = Math.max(...model.points.map((point) => point.value));
  const valueSpan = Math.max(1, maximum - minimum);
  const yearSpan = Math.max(
    1e-9,
    model.points[model.points.length - 1].year - model.points[0].year,
  );
  const output: TimeSeriesPoint[] = [{
    year: model.points[0].year,
    value: model.points[0].value,
  }];

  const appendInterval = (
    startYear: number,
    endYear: number,
    startValue: number,
    endValue: number,
    depth: number,
  ) => {
    const middleYear = (startYear + endYear) / 2;
    const middleValue = evaluateModel(model, middleYear);
    const linearValue = (startValue + endValue) / 2;
    const pixelError = Math.abs(middleValue - linearValue) / valueSpan * pixelHeight;
    const pixelSpan = (endYear - startYear) / yearSpan * pixelWidth;
    if (depth < 9 && pixelSpan > 2 && pixelError > maximumPixelError) {
      appendInterval(startYear, middleYear, startValue, middleValue, depth + 1);
      appendInterval(middleYear, endYear, middleValue, endValue, depth + 1);
      return;
    }
    output.push({ year: endYear, value: endValue });
  };

  for (let index = 0; index < model.points.length - 1; index += 1) {
    const start = model.points[index];
    const end = model.points[index + 1];
    const segments = Math.max(
      2,
      Math.min(12, Math.ceil((end.year - start.year) / yearSpan * pixelWidth / 24)),
    );
    let previousYear = start.year;
    let previousValue = start.value;
    for (let segment = 1; segment <= segments; segment += 1) {
      const nextYear = start.year + (end.year - start.year) * segment / segments;
      const nextValue = segment === segments ? end.value : evaluateModel(model, nextYear);
      appendInterval(previousYear, nextYear, previousValue, nextValue, 0);
      previousYear = nextYear;
      previousValue = nextValue;
    }
  }
  return output;
}
