import { useEffect, useMemo, useRef, useState } from "react";
import {
  createId,
  formatTimelineMoment,
  generatedAtYear,
  upsertTemporalStateAtYear,
  type AgricultureAssessment,
  type EnvironmentPin,
  type EnvironmentSimulationSummary,
  type GeneratedMapData,
  type MapData,
  type Point,
  type Season,
  type WorldProject,
} from "../model/world";
import { createGeneratedMapCanvas } from "../generator/renderGenerated";
import { clientPointToEnvironmentMap } from "./environmentMapCoordinates";
import { genericEnvironmentImportAdapter, type ExternalEnvironmentGrid } from "../simulation/externalModels";
import {
  analyzeEnvironmentLocation,
  findDefaultEnvironmentPoint,
  liveEnvironmentAtTimeline,
  MONTH_LABELS,
  representativeMonth,
  type EnvironmentLocationAnalysis,
} from "../simulation/locationEnvironment";


type Props = {
  project: WorldProject;
  map: MapData;
  onChange: (project: WorldProject) => void;
  onSelectMap: (mapId: string) => void;
};

const BAND_LABELS: Record<AgricultureAssessment["band"], string> = {
  very_low: "매우 낮음",
  low: "낮음",
  moderate: "보통",
  high: "높음",
  very_high: "매우 높음",
};

const SEASON_LABELS: Record<Season, string> = { spring: "봄", summer: "여름", autumn: "가을", winter: "겨울" };
const TERRAIN_LABELS: Record<string, string> = {
  mountain: "산악", forest: "산림", desert: "사막", snow: "설원", grassland: "초원", plain: "평원",
  farmland: "농경지", jungle: "열대림", wetland: "습지", rock: "암석", bedrock: "암반",
};

export function renameEnvironmentPin(map: MapData, id: string, name: string): MapData {
  const trimmed = name.trim();
  if (!trimmed) return map;
  return { ...map, environmentPins: map.environmentPins.map((pin) => pin.id === id ? { ...pin, name: trimmed } : pin) };
}

function signed(value: number, unit = ""): string {
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${value.toFixed(Math.abs(value) >= 10 ? 0 : 1)}${unit}`;
}

function compass(degrees: number): string {
  const labels = ["동", "동남동", "남동", "남남동", "남", "남남서", "남서", "서남서", "서", "서북서", "북서", "북북서", "북", "북북동", "북동", "동북동"];
  return labels[Math.round(((degrees % 360) + 360) % 360 / 22.5) % 16];
}

function AssessmentTable({ title, items, freeMode }: { title: string; items: AgricultureAssessment[]; freeMode: boolean }) {
  return (
    <section className="simulation-card assessment-section">
      <div className="simulation-card-heading"><div><h3>{title} 환경 적합도</h3></div>{freeMode && <span className="reference-badge">참고값</span>}</div>
      <div className="assessment-list">
        {items.map((item) => <article key={`${item.kind}-${item.id}`} className={`assessment-row ${item.band}`}>
          <div className="assessment-score"><strong>{item.suitability}</strong><span>점</span></div>
          <div className="assessment-main"><div><h4>{item.name}</h4><span>{BAND_LABELS[item.band]} · 생산지수 {item.productionIndex}</span></div><p>{item.explanation}</p><div className="assessment-tags">{item.strengths.map((value) => <span className="strength" key={value}>{value}</span>)}{item.riskLabels.map((value) => <span className="risk" key={value}>{value}</span>)}</div></div>
          <dl><div><dt>{item.kind === "crop" ? "생육" : "방목"}</dt><dd>{item.activeMonths}개월</dd></div><div><dt>물 수요</dt><dd>{item.waterDemandIndex}</dd></div></dl>
        </article>)}
      </div>
    </section>
  );
}

function EnvironmentSelectionMap({ map, generated, selectedPoint, pins, onSelect }: {
  map: MapData;
  generated: GeneratedMapData;
  selectedPoint: Point;
  pins: EnvironmentPin[];
  onSelect: (point: Point) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const width = 960;
    const height = Math.max(280, Math.round(width * map.height / Math.max(1, map.width)));
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, width, height);
    context.drawImage(createGeneratedMapCanvas(generated), 0, 0, width, height);
    context.strokeStyle = "rgba(255,255,255,.45)";
    context.lineWidth = 2;
    context.strokeRect(1, 1, width - 2, height - 2);

    for (const [index, pin] of pins.entries()) {
      const x = pin.position.x / map.width * width;
      const y = pin.position.y / map.height * height;
      context.save();
      context.translate(x, y);
      context.rotate(Math.PI / 4);
      context.fillStyle = "#67e8f9";
      context.strokeStyle = "#082f49";
      context.lineWidth = 2;
      context.fillRect(-6, -6, 12, 12);
      context.strokeRect(-6, -6, 12, 12);
      context.restore();
      context.fillStyle = "rgba(8,15,27,.88)";
      context.fillRect(x + 9, y - 12, Math.max(24, pin.name.length * 11), 19);
      context.fillStyle = "#e6f8ff";
      context.font = "12px sans-serif";
      context.fillText(pin.name || `지점 ${index + 1}`, x + 13, y + 2);
    }

    const selectedX = selectedPoint.x / map.width * width;
    const selectedY = selectedPoint.y / map.height * height;
    context.beginPath();
    context.arc(selectedX, selectedY, 9, 0, Math.PI * 2);
    context.fillStyle = "#facc15";
    context.fill();
    context.lineWidth = 3;
    context.strokeStyle = "#ffffff";
    context.stroke();
    context.beginPath();
    context.moveTo(selectedX - 14, selectedY);
    context.lineTo(selectedX + 14, selectedY);
    context.moveTo(selectedX, selectedY - 14);
    context.lineTo(selectedX, selectedY + 14);
    context.lineWidth = 1.5;
    context.strokeStyle = "rgba(255,255,255,.9)";
    context.stroke();
  }, [generated, map.height, map.width, pins, selectedPoint]);

  return <canvas
    ref={canvasRef}
    className="environment-selection-map"
    onClick={(event) => {
      onSelect(clientPointToEnvironmentMap(
        event.currentTarget,
        event.clientX,
        event.clientY,
        map.width,
        map.height,
      ));
    }}
  />;
}

function MonthlyTable({ analysis, timelineLabel }: { analysis: EnvironmentLocationAnalysis; timelineLabel: string }) {
  return <section className="simulation-card monthly-climate-card">
    <div className="simulation-card-heading"><div><h3>월별 환경 변화</h3></div><span className="reference-badge">{timelineLabel} 기준</span></div>
    <div className="monthly-table-wrap"><table className="monthly-climate-table"><thead><tr><th>월</th><th>기온</th><th>강수</th><th>습도</th><th>일조</th><th>적설</th><th>증발산</th><th>토양수분</th></tr></thead><tbody>
      {analysis.monthly.map((item) => <tr key={item.month} className={item.month === analysis.selectedMonth ? "active" : ""}><th>{MONTH_LABELS[item.month - 1]}</th><td>{item.temperatureC.toFixed(1)}℃</td><td>{item.precipitationMm.toFixed(0)}mm</td><td>{item.relativeHumidityPercent.toFixed(0)}%</td><td>{item.solarHours.toFixed(1)}h</td><td>{item.snowpackMm.toFixed(0)}mm</td><td>{item.evapotranspirationMm.toFixed(0)}mm</td><td>{item.soilMoisturePercent.toFixed(0)}%</td></tr>)}
    </tbody></table></div>
  </section>;
}

function PinComparison({ map, month, selectedPoint, onSelect, onRemove, onRename }: {
  map: MapData;
  month: number;
  selectedPoint: Point;
  onSelect: (point: Point) => void;
  onRemove: (id: string) => void;
  onRename: (id: string, name: string) => void;
}) {
  const [editingPinId, setEditingPinId] = useState<string | null>(null);
  const [editingPinName, setEditingPinName] = useState("");
  const rows = useMemo(() => map.environmentPins.map((pin) => ({ pin, analysis: analyzeEnvironmentLocation(map, pin.position, month) })).filter((item): item is { pin: EnvironmentPin; analysis: EnvironmentLocationAnalysis } => Boolean(item.analysis)), [map, month]);
  return <section className="simulation-card pin-comparison-card">
    <div className="simulation-card-heading"><div><h3>고정 지점 비교</h3></div><span className="reference-badge">{MONTH_LABELS[month - 1]}</span></div>
    {rows.length === 0 ? <p className="simulation-muted">지도에서 지점을 선택한 뒤 핀으로 저장하면 여러 지역을 같은 월·연도 기준으로 비교할 수 있습니다.</p> : <div className="pin-comparison-wrap"><table className="pin-comparison-table"><thead><tr><th>지점</th><th>기온</th><th>강수</th><th>습도</th><th>토양수분</th><th>수자원</th><th>최적 작물</th><th /></tr></thead><tbody>{rows.map(({ pin, analysis }) => {
      const bestCrop = [...analysis.cropAssessments].sort((a, b) => b.suitability - a.suitability)[0];
      const active = Math.hypot(pin.position.x - selectedPoint.x, pin.position.y - selectedPoint.y) < 0.01;
      const commitRename = () => { const name = editingPinName.trim(); if (name) onRename(pin.id, name); setEditingPinId(null); };
      return <tr key={pin.id} className={active ? "active" : ""}><th>{editingPinId === pin.id ? <input className="pin-rename-input" autoFocus aria-label="핀 이름" value={editingPinName} onChange={(event) => setEditingPinName(event.target.value)} onBlur={commitRename} onKeyDown={(event) => { if (event.key === "Enter") commitRename(); if (event.key === "Escape") { setEditingPinName(pin.name); setEditingPinId(null); } }} /> : <button type="button" className="pin-select-button" title="더블클릭하여 이름 변경" onClick={() => onSelect(pin.position)} onDoubleClick={() => { setEditingPinId(pin.id); setEditingPinName(pin.name); }}>{pin.name}</button>}<small>X {pin.position.x.toFixed(1)} · Y {pin.position.y.toFixed(1)}</small></th><td>{analysis.current.temperatureC.toFixed(1)}℃</td><td>{analysis.current.precipitationMm.toFixed(0)}mm</td><td>{analysis.current.relativeHumidityPercent.toFixed(0)}%</td><td>{analysis.current.soilMoisturePercent.toFixed(0)}%</td><td>{analysis.current.waterAccessIndex.toFixed(0)}</td><td>{bestCrop?.name ?? "-"} {bestCrop ? `${bestCrop.suitability}점` : ""}</td><td><button type="button" className="danger-ghost pin-delete-button" onClick={() => onRemove(pin.id)}>삭제</button></td></tr>;
    })}</tbody></table></div>}
  </section>;
}

export function SimulationWindow({ project, map, onChange, onSelectMap }: Props) {
  const importInputRef = useRef<HTMLInputElement>(null);
  const [importMessage, setImportMessage] = useState("");
  const generated = generatedAtYear(map);
  const [selectedPoint, setSelectedPoint] = useState<Point | null>(() => generated ? findDefaultEnvironmentPoint(map, generated) : null);
  const [selectedMonth, setSelectedMonth] = useState(() => generated ? representativeMonth(generated.settings.season, generated.settings.latitudeDeg) : 7);
  const [pinName, setPinName] = useState("");
  const timelineMonth = Math.max(1, Math.min(12, Math.floor((map.timeline.currentDayOfYear / Math.max(1, Math.round(project.worldSettings.orbitalPeriodDays))) * 12) + 1));
  const freeMode = map.generationMode === "free";

  useEffect(() => {
    if (generated && !selectedPoint) setSelectedPoint(findDefaultEnvironmentPoint(map, generated));
  }, [generated, map, selectedPoint]);

  useEffect(() => {
    if (map.timeline.precision !== "year") setSelectedMonth(timelineMonth);
  }, [map.timeline.precision, timelineMonth]);

  const analysis = useMemo(() => selectedPoint ? analyzeEnvironmentLocation(map, selectedPoint, selectedMonth) : null, [map, selectedMonth, selectedPoint]);
  const liveEnvironment = useMemo(() => analysis ? liveEnvironmentAtTimeline(project, map, analysis) : null, [analysis, project, map]);

  const updateMap = (nextMap: MapData) => onChange({
    ...project,
    maps: project.maps.map((item) => item.id === map.id ? nextMap : item),
    lastModifiedDate: new Date().toISOString(),
  });

  const persist = () => {
    if (!analysis) return;
    const summary: EnvironmentSimulationSummary = {
      generatedAt: new Date().toISOString(),
      mode: map.generationMode,
      meanTemperatureC: analysis.annual.meanTemperatureC,
      meanPrecipitationMm: analysis.annual.annualPrecipitationMm,
      meanHumidityPercent: analysis.annual.meanHumidityPercent,
      meanSolarHours: analysis.annual.meanSolarHours,
      meanWindSpeed: analysis.monthly.reduce((sum, item) => sum + item.windSpeedMs, 0) / 12,
      cropAssessments: analysis.cropAssessments,
      livestockAssessments: analysis.livestockAssessments,
      notes: ["선택 지점의 월별 기후와 연간 범위를 기준으로 계산한 결과입니다.", freeMode ? "자유 모드에서는 참고 정보로만 사용됩니다." : "현실 모드에서는 생산성의 기본 제약으로 적용됩니다."],
      locationContext: { mapId: map.id, position: analysis.position, month: selectedMonth, year: map.timeline.currentYear, label: pinName.trim() || undefined },
    };
    onChange({ ...project, simulationSummaries: { ...project.simulationSummaries, [map.id]: summary } });
    setImportMessage("현재 선택 지점의 환경 분석을 저장했습니다.");
  };

  const addPin = () => {
    if (!selectedPoint) return;
    const name = pinName.trim() || `비교 지점 ${map.environmentPins.length + 1}`;
    const pin: EnvironmentPin = { id: createId("environment-pin"), name, position: { x: Number(selectedPoint.x.toFixed(2)), y: Number(selectedPoint.y.toFixed(2)) }, createdAt: new Date().toISOString() };
    updateMap({ ...map, environmentPins: [...map.environmentPins, pin], lastModifiedDate: new Date().toISOString() });
    setPinName("");
  };

  const removePin = (id: string) => updateMap({ ...map, environmentPins: map.environmentPins.filter((pin) => pin.id !== id), lastModifiedDate: new Date().toISOString() });
  const renamePin = (id: string, name: string) => updateMap({ ...renameEnvironmentPin(map, id, name), lastModifiedDate: new Date().toISOString() });

  const importEnvironmentGrid = async (file: File | undefined) => {
    if (!file || !generated) return;
    try {
      const parsed = JSON.parse(await file.text()) as ExternalEnvironmentGrid;
      if (!parsed.metadata?.model || !parsed.metadata?.license) throw new Error("외부 환경 격자에는 모델명과 라이선스 메타데이터가 필요합니다.");
      const imported = genericEnvironmentImportAdapter.importResult(parsed, generated);
      const nextMap: MapData = { ...map, generatedStates: upsertTemporalStateAtYear(map.generatedStates, map.timeline.currentYear, imported), lastModifiedDate: new Date().toISOString() };
      const nextSummaries = { ...project.simulationSummaries };
      delete nextSummaries[map.id];
      onChange({ ...project, worldSettings: { ...project.worldSettings, environmentEngine: "external_import" }, simulationSummaries: nextSummaries, maps: project.maps.map((item) => item.id === map.id ? nextMap : item) });
      setImportMessage(`${parsed.metadata.model} 결과를 가져왔습니다. 라이선스: ${parsed.metadata.license}`);
    } catch (error) {
      setImportMessage(error instanceof Error ? error.message : "환경 데이터를 가져오지 못했습니다.");
    }
  };

  return (
    <section className="simulation-window">
      <header className="simulation-header">
        <div><h2>선택 지점 환경 분석</h2></div>
        <div className="simulation-header-actions"><span className={`mode-pill ${map.generationMode}`}>{freeMode ? "자유 모드" : "현실 모드"}</span><button type="button" className="secondary-button" disabled={!generated} onClick={() => importInputRef.current?.click()}>환경 격자 불러오기</button><button type="button" className="primary-button" disabled={!analysis} onClick={persist}>선택 지점 결과 저장</button></div>
      </header>

      <input ref={importInputRef} hidden type="file" accept="application/json,.json" onChange={(event) => { void importEnvironmentGrid(event.target.files?.[0]); event.target.value = ""; }} />
      {importMessage && <p className="simulation-import-message">{importMessage}</p>}

      <section className="simulation-card environment-map-list-panel"><div className="simulation-card-heading"><div><h3>지도 목록</h3></div><span className="reference-badge">{project.maps.length}개</span></div><div className="environment-map-list">{project.maps.map((candidate) => <button type="button" key={candidate.id} className={candidate.id === map.id ? "active" : ""} aria-pressed={candidate.id === map.id} onClick={() => onSelectMap(candidate.id)}><span>{candidate.title}</span><small>{candidate.environmentPins.length}개 핀</small></button>)}</div></section>

      {!generated || !selectedPoint || !analysis ? <div className="empty-document"><strong>환경 데이터가 없습니다.</strong><p>먼저 지도 생성기에서 지도를 확정하세요.</p></div> : <>
        <section className="environment-analysis-layout">
          <div className="environment-map-card simulation-card">
            <div className="simulation-card-heading"><div><h3>지도에서 분석 지점 선택</h3></div><span className="reference-badge">클릭하여 이동</span></div>
            <EnvironmentSelectionMap map={map} generated={generated} selectedPoint={selectedPoint} pins={map.environmentPins} onSelect={setSelectedPoint} />
            <div className="environment-pin-controls"><input value={pinName} onChange={(event) => setPinName(event.target.value)} placeholder={`비교 지점 ${map.environmentPins.length + 1}`} /><button type="button" className="secondary-button" onClick={addPin}>현재 지점 핀 저장</button></div>
          </div>
          <aside className="environment-context-card simulation-card">
            <h3>{pinName.trim() || "현재 선택 지점"}</h3>
            <dl className="environment-location-meta"><div><dt>활성 지도</dt><dd>{map.title}</dd></div><div><dt>생성 기후</dt><dd>{generated.settings.climatePreset}</dd></div><div><dt>분석 시점</dt><dd>{formatTimelineMoment(project, map.timeline)}</dd></div><div><dt>분석 지점</dt><dd>X {analysis.position.x.toFixed(2)} · Y {analysis.position.y.toFixed(2)}</dd></div><div><dt>격자</dt><dd>{analysis.gridX}, {analysis.gridY}</dd></div><div><dt>위도</dt><dd>{analysis.latitudeDeg.toFixed(2)}°</dd></div><div><dt>고도</dt><dd>{analysis.elevationM.toLocaleString()}m</dd></div><div><dt>지형</dt><dd>{analysis.isLand ? (TERRAIN_LABELS[analysis.terrain] ?? analysis.terrain) : "해양"}</dd></div></dl>
            <label className="environment-month-select"><span>{map.timeline.precision === "year" ? "연 평균 기준" : "타임라인 연동 월"}</span><select value={selectedMonth} disabled onChange={(event) => setSelectedMonth(Number(event.target.value))}>{MONTH_LABELS.map((label, index) => <option value={index + 1} key={label}>{label}</option>)}</select></label>
            <div className="environment-season-buttons">{(["spring", "summer", "autumn", "winter"] as Season[]).map((season) => <button type="button" key={season} className={analysis.current.season === season ? "active" : ""} onClick={() => setSelectedMonth(representativeMonth(season, analysis.latitudeDeg))}>{SEASON_LABELS[season]}</button>)}</div>
          </aside>
        </section>

        {liveEnvironment && <section className={`simulation-card live-environment-banner mode-${liveEnvironment.mode}`}><div><h3>{liveEnvironment.label} · {liveEnvironment.condition}</h3><p>{formatTimelineMoment(project, map.timeline)} 기준으로 자동 계산됩니다.</p></div><span className="reference-badge">{map.timeline.precision === "time" ? "현재 기상" : map.timeline.precision === "date" ? "일 평균" : map.timeline.precision === "month" ? "월 평균" : "연 평균"}</span></section>}
        {liveEnvironment && <section className="environment-stat-grid point-stat-grid">
          <article><span>기온</span><strong>{liveEnvironment.temperatureC.toFixed(1)}℃</strong><small>{liveEnvironment.normalTemperatureC !== undefined ? `평년 ${liveEnvironment.normalTemperatureC.toFixed(1)}℃ · 편차 ${(liveEnvironment.temperatureAnomalyC ?? 0) >= 0 ? "+" : ""}${(liveEnvironment.temperatureAnomalyC ?? 0).toFixed(1)}℃` : liveEnvironment.label}</small></article>
          <article><span>{liveEnvironment.mode === "annual" ? "연 강수량" : liveEnvironment.mode === "monthly" ? "월 강수량" : liveEnvironment.mode === "daily" ? "일 강수량" : "강수 강도"}</span><strong>{liveEnvironment.precipitationMm.toFixed(liveEnvironment.mode === "annual" || liveEnvironment.mode === "monthly" ? 0 : 1)}</strong><small>{liveEnvironment.normalPrecipitationMm !== undefined ? `평년 ${liveEnvironment.normalPrecipitationMm.toFixed(0)}mm · 편차 ${(liveEnvironment.precipitationAnomalyMm ?? 0) >= 0 ? "+" : ""}${(liveEnvironment.precipitationAnomalyMm ?? 0).toFixed(0)}mm` : liveEnvironment.precipitationUnit}</small></article>
          <article><span>상대습도</span><strong>{liveEnvironment.relativeHumidityPercent.toFixed(0)}%</strong><small>{liveEnvironment.condition}</small></article>
          <article><span>풍향·풍속</span><strong>{compass(liveEnvironment.windDirectionDeg)} {liveEnvironment.windSpeedMs.toFixed(1)}m/s</strong><small>{liveEnvironment.windDirectionDeg.toFixed(0)}°</small></article>
          <article><span>일조시간</span><strong>{liveEnvironment.solarHours.toFixed(1)}h</strong><small>{liveEnvironment.mode === "weather" ? "현재 일조 상태" : "하루 기준"}</small></article>
          <article><span>일사량</span><strong>{liveEnvironment.solarIrradianceKWhM2.toFixed(2)}</strong><small>kWh/㎡·일</small></article>
          <article><span>강설량</span><strong>{liveEnvironment.snowfallMm.toFixed(1)}mm</strong><small>수분 상당량</small></article>
          <article><span>적설</span><strong>{liveEnvironment.snowpackMm.toFixed(0)}mm</strong><small>추정 적설량</small></article>
          <article><span>증발산량</span><strong>{liveEnvironment.evapotranspirationMm.toFixed(liveEnvironment.mode === "annual" || liveEnvironment.mode === "monthly" ? 0 : 2)}mm</strong><small>{liveEnvironment.mode === "annual" ? "연 추정" : liveEnvironment.mode === "monthly" ? "월 추정" : liveEnvironment.mode === "daily" ? "일 추정" : "시간당 추정"}</small></article>
          <article><span>토양수분</span><strong>{liveEnvironment.soilMoisturePercent.toFixed(0)}%</strong><small>가용수분 지수</small></article>
          <article><span>지표 유출량</span><strong>{liveEnvironment.runoffMm.toFixed(liveEnvironment.mode === "annual" || liveEnvironment.mode === "monthly" ? 0 : 2)}mm</strong><small>{liveEnvironment.mode === "weather" ? "현재 강수 반영" : "기간 환산"}</small></article>
          <article><span>수자원 접근성</span><strong>{liveEnvironment.waterAccessIndex.toFixed(0)}</strong><small>0–100</small></article>
        </section>}

        <section className="simulation-card comparison-delta-card"><div className="simulation-card-heading"><div><h3>{analysis.comparisonLabel}</h3></div></div><div className="comparison-delta-grid"><span>기온 <strong>{signed(analysis.comparison.temperatureC, "℃")}</strong></span><span>강수 <strong>{signed(analysis.comparison.precipitationMm, "mm")}</strong></span><span>습도 <strong>{signed(analysis.comparison.humidityPercent, "%p")}</strong></span><span>토양수분 <strong>{signed(analysis.comparison.soilMoisturePercent, "%p")}</strong></span><span>수자원 <strong>{signed(analysis.comparison.waterAccessIndex)}</strong></span></div></section>

        <section className="simulation-card annual-range-card"><div className="simulation-card-heading"><div><h3>연중 최저·최고 및 누적값</h3></div></div><div className="annual-range-grid">
          <article><span>기온 범위</span><strong>{analysis.annual.temperature.min.toFixed(1)}–{analysis.annual.temperature.max.toFixed(1)}℃</strong><small>연평균 {analysis.annual.meanTemperatureC.toFixed(1)}℃</small></article>
          <article><span>월 강수 범위</span><strong>{analysis.annual.precipitation.min.toFixed(0)}–{analysis.annual.precipitation.max.toFixed(0)}mm</strong><small>연간 {analysis.annual.annualPrecipitationMm.toFixed(0)}mm</small></article>
          <article><span>습도 범위</span><strong>{analysis.annual.humidity.min.toFixed(0)}–{analysis.annual.humidity.max.toFixed(0)}%</strong><small>연평균 {analysis.annual.meanHumidityPercent.toFixed(0)}%</small></article>
          <article><span>토양수분 범위</span><strong>{analysis.annual.soilMoisture.min.toFixed(0)}–{analysis.annual.soilMoisture.max.toFixed(0)}%</strong><small>연평균 {analysis.annual.soilMoisture.mean.toFixed(0)}%</small></article>
          <article><span>적설 범위</span><strong>{analysis.annual.snowpack.min.toFixed(0)}–{analysis.annual.snowpack.max.toFixed(0)}mm</strong><small>연 강설 {analysis.annual.totalSnowfallMm.toFixed(0)}mm</small></article>
          <article><span>증발산 누적</span><strong>{analysis.annual.totalEvapotranspirationMm.toFixed(0)}mm</strong><small>평균 일조 {analysis.annual.meanSolarHours.toFixed(1)}h</small></article>
        </div></section>

        <section className="seasonal-summary-grid">{analysis.seasonal.map((season) => <article className={`simulation-card season-${season.season}`} key={season.season}><p className="section-meta">{SEASON_LABELS[season.season]}</p><h3>{season.meanTemperatureC.toFixed(1)}℃ · {season.precipitationMm.toFixed(0)}mm</h3><p>{season.months.map((month) => MONTH_LABELS[month - 1]).join(" · ")}</p><dl><div><dt>습도</dt><dd>{season.humidityRange[0].toFixed(0)}–{season.humidityRange[1].toFixed(0)}%</dd></div><div><dt>토양수분</dt><dd>{season.soilMoistureRange[0].toFixed(0)}–{season.soilMoistureRange[1].toFixed(0)}%</dd></div><div><dt>적설</dt><dd>{season.snowRange[0].toFixed(0)}–{season.snowRange[1].toFixed(0)}mm</dd></div></dl></article>)}</section>

        <MonthlyTable analysis={analysis} timelineLabel={formatTimelineMoment(project, { ...map.timeline, precision: "year" })} />
        <PinComparison map={map} month={selectedMonth} selectedPoint={selectedPoint} onSelect={setSelectedPoint} onRemove={removePin} onRename={renamePin} />
        <AssessmentTable title="작물" items={analysis.cropAssessments} freeMode={freeMode} />
        <AssessmentTable title="목축" items={analysis.livestockAssessments} freeMode={freeMode} />
        <section className="simulation-card external-model-card"><h3>선택 지점 계산 방식</h3><p>현재 지도의 고도·기온·연 강수·습도·풍장·수문 격자를 기준으로 월별 일사, 강수 분배, 강설·융설, 증발산, 토양수분과 수자원 접근성을 계산합니다. 타임라인이 날짜 단위이면 월간값을 일별로 보간하고, 시각 단위이면 일교차·강수 이벤트·풍속 변화를 반영해 같은 좌표의 날씨를 자동 갱신합니다. 외부 모델 격자를 가져온 경우 해당 값이 같은 계산의 기초 자료로 사용됩니다.</p></section>
      </>}
    </section>
  );
}
