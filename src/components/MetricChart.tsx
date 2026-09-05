import { useEffect, useMemo, useRef, useState } from "react";
import { normalizeTimeSeries, sampleTimeSeries } from "../metrics/timeSeriesFunction";

export type MetricPoint = { year: number } & Record<string, number | undefined>;
export type MetricSeries = { key: string; label: string; className: string };
type ChartMode = "population" | "economy" | "comparison";

function formatMetricValue(value: number): string {
  if (Math.abs(value) >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(value >= 10_000_000_000 ? 0 : 1)}B`;
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}K`;
  return Math.round(value).toLocaleString();
}

function mergeYears(points: MetricPoint[]): MetricPoint[] {
  const byYear = new Map<number, MetricPoint>();
  for (const point of points) {
    if (!Number.isFinite(point.year)) continue;
    byYear.set(point.year, { ...(byYear.get(point.year) ?? { year: point.year }), ...point });
  }
  return [...byYear.values()].sort((a, b) => a.year - b.year);
}

export function monotoneMetricSamples(
  points: Array<{ year: number; value: number }>,
  logarithmic: boolean,
): Array<{ year: number; value: number }> {
  return sampleTimeSeries(points, { logarithmic, smoothing: 0.58 });
}

function niceStep(span: number, maximumTicks: number): number {
  const raw = span / Math.max(1, maximumTicks);
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(1e-9, raw)));
  const normalized = raw / magnitude;
  const factor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return Math.max(1, factor * magnitude);
}

function linePath(points: Array<{ x: number; y: number }>): string {
  return points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(" ");
}

export function MetricChart({ points, series }: { points: MetricPoint[]; series: MetricSeries[] }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [hostWidth, setHostWidth] = useState(760);
  const [mode, setMode] = useState<ChartMode>("population");
  const [showAnchors, setShowAnchors] = useState(true);
  const [smoothing, setSmoothing] = useState(0.58);
  const [hovered, setHovered] = useState<{ year: number; values: Array<{ label: string; value: number }> } | null>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new ResizeObserver((entries) => setHostWidth(Math.max(360, entries[0]?.contentRect.width ?? 760)));
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  const ordered = useMemo(() => mergeYears(points), [points]);
  if (ordered.length === 0 || series.length === 0) return <p className="empty-hint">기록된 수치가 없습니다.</p>;
  const population = series.find((item) => item.key === "population") ?? series[0];
  const economy = series.find((item) => item.key === "economy") ?? series[1] ?? series[0];
  const visibleSeries = mode === "population" ? [population] : mode === "economy" ? [economy] : [population, economy];
  const normalizedSeries = visibleSeries.map((item) => {
    const anchors = ordered
      .filter((point) => Number.isFinite(point[item.key]))
      .map((point) => ({ year: point.year, value: Math.max(0, point[item.key] as number) }));
    const baseline = anchors.find((point) => point.value > 0)?.value ?? 1;
    return {
      ...item,
      anchors: normalizeTimeSeries(mode === "comparison" ? anchors.map((point) => ({ ...point, value: point.value / baseline * 100 })) : anchors),
    };
  });

  const width = Math.max(360, Math.round(hostWidth));
  const height = 286;
  const padding = { left: 68, right: 24, top: 24, bottom: 44 };
  const minYear = ordered[0].year;
  const maxYear = ordered[ordered.length - 1].year;
  const spanYear = Math.max(1, maxYear - minYear);
  const maximumValue = Math.max(1, ...normalizedSeries.flatMap((item) => item.anchors.map((point) => point.value)));
  const valueMagnitude = 10 ** Math.floor(Math.log10(maximumValue));
  const maxValue = Math.ceil(maximumValue / valueMagnitude * 2) / 2 * valueMagnitude;
  const x = (year: number) => padding.left + (year - minYear) / spanYear * (width - padding.left - padding.right);
  const y = (value: number) => height - padding.bottom - value / maxValue * (height - padding.top - padding.bottom);
  const yearStep = niceStep(spanYear, Math.max(2, Math.floor((width - padding.left - padding.right) / 78)));
  const firstTick = Math.ceil(minYear / yearStep) * yearStep;
  const yearTicks: number[] = [];
  for (let tick = firstTick; tick <= maxYear + yearStep * 1e-7; tick += yearStep) yearTicks.push(Number(tick.toFixed(8)));
  const yTicks = Array.from({ length: 5 }, (_value, index) => maxValue * index / 4);

  return <div className="history-chart-wrap metric-chart" ref={hostRef}>
    <div className="metric-chart-toolbar" role="group" aria-label="그래프 표시 항목">
      <button type="button" className={mode === "population" ? "active" : ""} onClick={() => setMode("population")}>인구</button>
      <button type="button" className={mode === "economy" ? "active" : ""} onClick={() => setMode("economy")}>경제력</button>
      <button type="button" className={mode === "comparison" ? "active" : ""} onClick={() => setMode("comparison")}>비교</button>
      <button type="button" className={showAnchors ? "active" : ""} aria-pressed={showAnchors} onClick={() => setShowAnchors((value) => !value)}>기준점</button>
      <label className="metric-smoothing-control">평활도<input type="range" min={0} max={1} step={0.05} value={smoothing} onChange={(event) => setSmoothing(Number(event.target.value))} /></label>
    </div>
    <svg className="history-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${visibleSeries.map((item) => item.label).join(" 및 ")} 변화 그래프`}>
      {yTicks.map((tick) => <g key={tick}><line x1={padding.left} y1={y(tick)} x2={width - padding.right} y2={y(tick)} className="chart-grid"/><text x={padding.left - 10} y={y(tick) + 4} textAnchor="end" className="chart-y-label">{mode === "comparison" ? `${Math.round(tick)}` : formatMetricValue(tick)}</text></g>)}
      <line x1={padding.left} y1={height - padding.bottom} x2={width - padding.right} y2={height - padding.bottom} className="chart-axis"/>
      <line x1={padding.left} y1={padding.top} x2={padding.left} y2={height - padding.bottom} className="chart-axis"/>
      {yearTicks.map((tick) => <text key={tick} x={x(tick)} y={height - 17} textAnchor="middle" className="chart-label">{tick}</text>)}
      {normalizedSeries.map((item) => {
        const samples = sampleTimeSeries(item.anchors, {
          logarithmic: mode !== "comparison",
          smoothing,
          pixelWidth: width - padding.left - padding.right,
          pixelHeight: height - padding.top - padding.bottom,
        });
        const coordinates = samples.map((point) => ({ x: x(point.year), y: y(point.value) }));
        const path = linePath(coordinates);
        const area = coordinates.length > 1 && mode === "population"
          ? `${path} L ${coordinates[coordinates.length - 1].x} ${y(0)} L ${coordinates[0].x} ${y(0)} Z`
          : "";
        return <g key={item.key}>{area && <path d={area} className={`chart-area ${item.className}`}/>}<path d={path} className={`chart-line ${item.className}`} fill="none"/>{showAnchors && item.anchors.map((point) => {
          const original = ordered.find((candidate) => candidate.year === point.year)?.[item.key];
          const values = normalizedSeries.flatMap((candidate) => {
            const anchor = candidate.anchors.find((entry) => entry.year === point.year);
            return anchor ? [{ label: candidate.label, value: mode === "comparison" ? anchor.value : (ordered.find((entry) => entry.year === point.year)?.[candidate.key] as number) }] : [];
          });
          const title = `${point.year} · ${item.label} ${mode === "comparison" ? point.value.toFixed(1) : Number(original).toLocaleString()}`;
          return <circle key={point.year} cx={x(point.year)} cy={y(point.value)} r="3.8" tabIndex={0} className={`chart-point ${item.className}`} onPointerEnter={() => setHovered({ year: point.year, values })} onPointerLeave={() => setHovered(null)} onFocus={() => setHovered({ year: point.year, values })} onBlur={() => setHovered(null)}><title>{title}</title></circle>;
        })}</g>;
      })}
      {hovered && <g className="chart-crosshair"><line x1={x(hovered.year)} y1={padding.top} x2={x(hovered.year)} y2={height - padding.bottom}/><text x={Math.min(width - 130, Math.max(padding.left + 8, x(hovered.year) + 8))} y={padding.top + 15}>{hovered.year} · {hovered.values.map((item) => `${item.label} ${mode === "comparison" ? item.value.toFixed(1) : formatMetricValue(item.value)}`).join(" · ")}</text></g>}
    </svg>
  </div>;
}
