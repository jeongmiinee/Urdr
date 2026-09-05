import type { LayerVisibility, TimelinePrecision } from "../model/world";

const climateKeys = ["temperature", "humidity", "windSpeed", "precipitation", "snowfall", "evapotranspiration", "soilMoisture", "solarIrradiance", "solarHours"] as const satisfies ReadonlyArray<keyof LayerVisibility>;
const climateBaseLabels: Record<(typeof climateKeys)[number], string> = {
  temperature: "온도",
  humidity: "습도",
  windSpeed: "풍속",
  precipitation: "강수량",
  snowfall: "적설량",
  evapotranspiration: "증발산량",
  soilMoisture: "토양수분",
  solarIrradiance: "일조량",
  solarHours: "일조시간",
};

const politicalHumanLabels = [
  ["territories", "국가 영토"], ["countryNames", "국명"], ["roads", "길"],
  ["locations", "장소"], ["labels", "지명"], ["events", "사건"],
] as const satisfies ReadonlyArray<readonly [keyof LayerVisibility, string]>;

const overlayLabels = [
  ["contours", "등고선"], ["coastline", "해안선"], ["rivers", "강"], ["windDirection", "풍향"],
] as const satisfies ReadonlyArray<readonly [keyof LayerVisibility, string]>;

function periodPrefix(precision: TimelinePrecision, kind: (typeof climateKeys)[number]): string {
  if (precision === "time") return "현재 ";
  const period = precision === "year" ? "연" : precision === "month" ? "월" : precision === "week" ? "주" : precision === "date" ? "일" : "현재";
  if (kind === "precipitation" || kind === "snowfall" || kind === "evapotranspiration") return `${period} `;
  return `${period} 평균 `;
}

export function climateLayerLabel(precision: TimelinePrecision, kind: (typeof climateKeys)[number]): string {
  return `${periodPrefix(precision, kind)}${climateBaseLabels[kind]}`;
}

type Props = {
  layers: LayerVisibility;
  precision: TimelinePrecision;
  onChange: (layers: LayerVisibility) => void;
  environmentOpacity?: number;
  onEnvironmentOpacityChange?: (value: number) => void;
};

export function LayerPanel({ layers, precision, onChange, environmentOpacity = 0.58, onEnvironmentOpacityChange }: Props) {
  const selectedClimate = climateKeys.find((key) => layers[key]) ?? "none";
  const setClimate = (key: (typeof climateKeys)[number] | "none") => {
    const next = { ...layers };
    for (const climateKey of climateKeys) next[climateKey] = false;
    if (key !== "none") next[key] = true;
    onChange(next);
  };
  return (
    <section className="layer-panel">
      <h3>레이어</h3>
      <div className="layer-section compact-section layer-background-section">
        <label className="layer-row"><input type="checkbox" checked={layers.terrain} onChange={(event) => onChange({ ...layers, terrain: event.target.checked })} />지형</label>
        <label className="environment-opacity"><span>레이어 불투명도</span><input type="range" min={0} max={100} value={Math.round(environmentOpacity * 100)} onChange={(event) => onEnvironmentOpacityChange?.(Number(event.target.value) / 100)} /><small>{Math.round(environmentOpacity * 100)}%</small></label>
      </div>
      <div className="layer-section compact-section">
        <h4>기상/기후</h4>
        <div className="layer-grid climate-layer-grid">
          <label className="layer-row"><input type="radio" name="climate-layer" checked={selectedClimate === "none"} onChange={() => setClimate("none")} />없음</label>
          {climateKeys.map((key) => <label className="layer-row" key={key}><input type="radio" name="climate-layer" checked={selectedClimate === key} onChange={() => setClimate(key)} />{climateLayerLabel(precision, key)}</label>)}
        </div>
      </div>
      <div className="layer-section compact-section">
        <h4>정치/인문</h4>
        <div className="layer-grid">{politicalHumanLabels.map(([key, label]) => <label className="layer-row" key={key}><input type="checkbox" checked={layers[key]} onChange={(event) => onChange({ ...layers, [key]: event.target.checked })} />{label}</label>)}</div>
      </div>
      <div className="layer-section compact-section">
        <h4>오버레이</h4>
        <div className="layer-grid">{overlayLabels.map(([key, label]) => <label className="layer-row" key={key}><input type="checkbox" checked={layers[key]} onChange={(event) => onChange({ ...layers, [key]: event.target.checked })} />{label}</label>)}</div>
      </div>
    </section>
  );
}
