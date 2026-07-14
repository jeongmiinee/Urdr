import { useEffect, useMemo, useState } from "react";
import { FamilyProfilePanel, GovernmentProfilePanel, ItemProfilePanel, PersonProfilePanel, ReligionProfilePanel } from "./GenealogyPanels";
import { CalendarProfilePanel } from "./CalendarProfilePanel";
import { HeraldryDisplay, HeraldryEditorFields } from "./HeraldryStudio";
import { sortSelectionOptions } from "../model/selectionSort";
import {
  activeCalendarFieldsFromTimeline,
  activeCalendarYearFromWorldYear,
  createId,
  createDefaultCalendarProfile,
  EVENT_CATEGORIES,
  EVENT_CATEGORY_LABELS,
  factionMetricTimeline,
  formatTimelineMoment,
  getStateAtYear,
  standardDayOfYear,
  standardMonthDay,
  timelineFromActiveCalendarFields,
  worldYearFromActiveCalendarYear,
  type EventCategory,
  type Faction,
  type HistoricalDateTime,
  type Location,
  type LocationState,
  type OrganizationType,
  type TemporalState,
  type WikiArticle,
  type WikiCategory,
  type WorldProject,
} from "../model/world";

type WikiNavigationTarget = { categoryId: string | null; eventCategory: EventCategory | "all"; articleId: string };
type Props = { project: WorldProject; onChange: (project: WorldProject) => void; initialCategoryId: string | null; initialEventCategory?: EventCategory | "all"; initialArticleId?: string; onNavigate?: (target: WikiNavigationTarget) => void };
const locationTypeLabels: Record<string, string> = { village: "마을", town: "읍", city: "도시", capital: "수도", ruin: "폐허", dungeon: "던전", sacred_site: "성지", landmark: "랜드마크" };
const statusLabels: Record<string, string> = { active: "활성", occupied: "점령", destroyed: "파괴됨", abandoned: "버려짐" };
function projectYearLabel(project: WorldProject, year: number): string {
  const map = project.maps.find((item) => item.id === project.activeMapId) ?? project.maps[0];
  if (!map) return `${year}년`;
  return formatTimelineMoment(project, { ...map.timeline, currentYear: year, currentDayOfYear: 0, currentMinuteOfDay: 0, precision: "year" });
}
function yearRange(project: WorldProject, startYear: number, endYear: number | null): string { return endYear === null ? `${projectYearLabel(project, startYear)} 이후` : startYear === endYear ? projectYearLabel(project, startYear) : `${projectYearLabel(project, startYear)}–${projectYearLabel(project, endYear)}`; }
function chronologyValue(dateTime: HistoricalDateTime): number { return (((((dateTime.year * 13) + (dateTime.month ?? 0)) * 32 + (dateTime.day ?? 0)) * 24 + (dateTime.hour ?? 0)) * 60) + (dateTime.minute ?? 0); }
function formatDateTime(project: WorldProject, map: WorldProject["maps"][number], dateTime: HistoricalDateTime | null): string {
  if (!dateTime) return "미정";
  const precision = dateTime.hour !== undefined ? "time" : dateTime.month !== undefined || dateTime.day !== undefined ? "date" : "year";
  return formatTimelineMoment(project, { ...map.timeline, currentYear: dateTime.year, currentDayOfYear: standardDayOfYear(project, dateTime.month ?? 1, dateTime.day ?? 1), currentMinuteOfDay: (dateTime.hour ?? 0) * 60 + (dateTime.minute ?? 0), precision });
}


function WikiLinkedText({ project, text, onOpenArticle }: { project: WorldProject; text: string; onOpenArticle: (id: string) => void }) {
  const parts: Array<string | { title: string; id: string }> = [];
  const pattern = /\[\[([^\]]+)\]\]/g;
  let cursor = 0; let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    if (match.index > cursor) parts.push(text.slice(cursor, match.index));
    const title = match[1].trim();
    const article = project.wikiArticles.find((item) => item.title === title);
    parts.push(article ? { title, id: article.id } : `[[${title}]]`);
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts.map((part, index) => typeof part === "string" ? <span key={index}>{part}</span> : <a key={index} href={`#wiki-${part.id}`} className="wiki-inline-link" onClick={(event) => { event.preventDefault(); onOpenArticle(part.id); }}>{part.title}</a>)}</>;
}

function ActiveYearInput({ project, value, placeholder, onChange }: { project: WorldProject; value?: number; placeholder?: string; onChange: (value?: number) => void }) {
  return <input type="number" placeholder={placeholder} value={value === undefined ? "" : activeCalendarYearFromWorldYear(project, value)} onChange={(event) => onChange(event.target.value === "" ? undefined : worldYearFromActiveCalendarYear(project, Number(event.target.value)))} />;
}

function activeDateTimeFields(project: WorldProject, map: WorldProject["maps"][number], value: HistoricalDateTime) {
  return activeCalendarFieldsFromTimeline(project, {
    ...map.timeline,
    currentYear: value.year,
    currentDayOfYear: standardDayOfYear(project, value.month ?? 1, value.day ?? 1),
    currentMinuteOfDay: (value.hour ?? 0) * 60 + (value.minute ?? 0),
    precision: value.hour !== undefined || value.minute !== undefined ? "time" : value.month !== undefined || value.day !== undefined ? "date" : "year",
  });
}

function historicalDateTimeFromActiveFields(project: WorldProject, map: WorldProject["maps"][number], fields: ReturnType<typeof activeDateTimeFields>): HistoricalDateTime {
  const timeline = timelineFromActiveCalendarFields(project, map.timeline, fields);
  const monthDay = standardMonthDay(project, timeline.currentDayOfYear);
  return { year: timeline.currentYear, month: monthDay.month, day: monthDay.day, hour: Math.floor(timeline.currentMinuteOfDay / 60), minute: timeline.currentMinuteOfDay % 60 };
}

function eventCategoriesForSystemKey(systemKey?: WikiCategory): EventCategory[] {
  if (systemKey === "accident") return ["accident", "natural_disaster"];
  if (systemKey === "war") return ["war"];
  if (systemKey === "battle") return ["battle"];
  return EVENT_CATEGORIES.filter((category) => !["accident", "natural_disaster", "war", "battle"].includes(category));
}
function eventDocumentGroup(category: EventCategory): string {
  if (category === "war") return "전쟁·전투 › 전쟁";
  if (category === "battle") return "전쟁·전투 › 전투";
  if (["accident", "natural_disaster"].includes(category)) return "사건·사고 › 사고";
  return "사건·사고 › 사건";
}
function isEventDocumentCategory(systemKey?: string): boolean {
  return ["event", "accident", "war", "battle"].includes(systemKey ?? "");
}

function smoothMetricPath(coords: Array<{ x: number; y: number }>): string {
  if (coords.length === 0) return "";
  if (coords.length === 1) return `M ${coords[0].x} ${coords[0].y}`;
  let path = `M ${coords[0].x} ${coords[0].y}`;
  for (let index = 0; index < coords.length - 1; index += 1) {
    const p0 = coords[Math.max(0, index - 1)];
    const p1 = coords[index];
    const p2 = coords[index + 1];
    const p3 = coords[Math.min(coords.length - 1, index + 2)];
    const lowY = Math.min(p1.y, p2.y); const highY = Math.max(p1.y, p2.y);
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c1y = Math.max(lowY, Math.min(highY, p1.y + (p2.y - p0.y) / 6));
    const c2y = Math.max(lowY, Math.min(highY, p2.y - (p3.y - p1.y) / 6));
    path += ` C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2.x} ${p2.y}`;
  }
  return path;
}

function formatMetricValue(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}K`;
  return Math.round(value).toLocaleString("ko-KR");
}

function MetricChart({ points, series }: { points: Array<{ year: number } & Record<string, number | undefined>>; series: Array<{ key: string; label: string; className: string }> }) {
  if (points.length === 0) return <p className="empty-hint">기록된 수치가 없습니다.</p>;

  const ordered = [...points].sort((a, b) => a.year - b.year);
  const width = 760;
  const height = 280;
  const paddingLeft = 72;
  const paddingRight = 26;
  const paddingTop = 30;
  const paddingBottom = 48;
  const minYear = Math.min(...ordered.map((point) => point.year));
  const maxYear = Math.max(...ordered.map((point) => point.year));
  const maxValueRaw = Math.max(1, ...ordered.flatMap((point) => series.map((item) => point[item.key]).filter((value): value is number => Number.isFinite(value))));
  const magnitude = 10 ** Math.floor(Math.log10(maxValueRaw));
  const maxValue = Math.ceil((maxValueRaw / magnitude) * 2) / 2 * magnitude;
  const x = (year: number) => paddingLeft + ((year - minYear) / Math.max(1, maxYear - minYear)) * (width - paddingLeft - paddingRight);
  const y = (value: number) => height - paddingBottom - (value / maxValue) * (height - paddingTop - paddingBottom);

  const isMaterialChange = (key: string, previous: number, current: number) => {
    const absolute = Math.abs(current - previous);
    const rate = absolute / Math.max(1, Math.abs(previous));
    const absoluteThreshold = key === "population"
      ? Math.max(100, Math.abs(previous) * 0.005)
      : Math.max(1, Math.abs(previous) * 0.01);
    const rateThreshold = key === "population" ? 0.005 : 0.01;
    return absolute >= absoluteThreshold && rate >= rateThreshold;
  };

  type LabelCandidate = {
    id: string;
    x: number;
    y: number;
    text: string;
    priority: number;
    change: number;
    className: string;
  };

  const materialIds = new Set<string>();
  const candidates: LabelCandidate[] = [];
  for (const item of series) {
    const recorded = ordered.filter((point) => Number.isFinite(point[item.key])) as Array<typeof ordered[number] & Record<string, number>>;
    recorded.forEach((point, index) => {
      const value = point[item.key];
      const previous = recorded[Math.max(0, index - 1)]?.[item.key] ?? value;
      const change = index === 0 ? 0 : Math.abs(value - previous);
      const material = index === 0 || isMaterialChange(item.key, previous, value);
      if (!material) return;
      const id = `${item.key}-${point.year}`;
      materialIds.add(id);
      candidates.push({
        id,
        x: x(point.year),
        y: y(value),
        text: formatMetricValue(value as number),
        priority: change * 1_000_000 + (index === recorded.length - 1 ? 2 : index === 0 ? 1 : 0),
        change,
        className: item.className,
      });
    });
  }

  const accepted: LabelCandidate[] = [];
  const overlap = (a: LabelCandidate, b: LabelCandidate) => Math.abs(a.x - b.x) < 62 && Math.abs((a.y - 16) - (b.y - 16)) < 25;
  for (const candidate of [...candidates].sort((a, b) => b.change - a.change || b.priority - a.priority)) {
    if (!accepted.some((label) => overlap(candidate, label))) accepted.push(candidate);
  }
  const visibleLabels = new Set(accepted.map((item) => item.id));
  const yTicks = Array.from({ length: 5 }, (_, index) => (maxValue * index) / 4);

  return (
    <div className="history-chart-wrap">
      <div className="chart-legend">
        {series.map((item) => <span key={item.key} className={item.className}>{item.label}</span>)}
      </div>
      <svg className="history-chart" viewBox={`0 0 ${width} ${height}`}>
        {yTicks.map((tick) => (
          <g key={tick}>
            <line x1={paddingLeft} y1={y(tick)} x2={width - paddingRight} y2={y(tick)} className="chart-grid" />
            <text x={paddingLeft - 10} y={y(tick) + 4} textAnchor="end" className="chart-y-label">{formatMetricValue(tick)}</text>
          </g>
        ))}
        <line x1={paddingLeft} y1={height - paddingBottom} x2={width - paddingRight} y2={height - paddingBottom} className="chart-axis" />
        <line x1={paddingLeft} y1={paddingTop} x2={paddingLeft} y2={height - paddingBottom} className="chart-axis" />
        <text
          x={16}
          y={(paddingTop + height - paddingBottom) / 2}
          textAnchor="middle"
          className="chart-axis-title"
          transform={`rotate(-90 16 ${(paddingTop + height - paddingBottom) / 2})`}
        >수량</text>
        {series.map((item) => {
          const coords = ordered.filter((point) => Number.isFinite(point[item.key])).map((point) => ({ x: x(point.year), y: y(point[item.key] as number) }));
          return coords.length >= 2 ? <path key={item.key} d={smoothMetricPath(coords)} className={`chart-line ${item.className}`} fill="none" /> : null;
        })}
        {ordered.map((point) => {
          const showYear = series.some((item) => materialIds.has(`${item.key}-${point.year}`));
          return (
            <g key={point.year}>
              {showYear && <text x={x(point.year)} y={height - 15} textAnchor="middle" className="chart-label">{point.year}</text>}
              {series.map((item) => {
                const value = point[item.key];
                const id = `${item.key}-${point.year}`;
                if (!Number.isFinite(value) || !materialIds.has(id)) return null;
                return (
                  <g key={item.key}>
                    <circle cx={x(point.year)} cy={y(value as number)} r="4" className={`chart-point ${item.className}`}>
                      <title>{point.year}년 · {item.label} {(value as number).toLocaleString("ko-KR")}</title>
                    </circle>
                    {visibleLabels.has(id) && (
                      <text x={x(point.year)} y={Math.max(14, y(value as number) - 10)} textAnchor="middle" className={`chart-value-label ${item.className}`}>
                        {formatMetricValue(value as number)}
                      </text>
                    )}
                  </g>
                );
              })}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function LocationHistory({ project, article, location, editMode, onProjectChange }: { project: WorldProject; article: WikiArticle; location: Location; editMode: boolean; onProjectChange: (project: WorldProject) => void }) {
  const map = project.maps.find((item) => item.id === article.sourceMapId);
  if (!map) return null;
  const ordered = [...location.states].sort((a, b) => a.startYear - b.startYear);
  const activeState = [...ordered].reverse().find((state) => state.startYear <= map.timeline.currentYear && (state.endYear === null || state.endYear >= map.timeline.currentYear)) ?? ordered[ordered.length - 1];
  const current = activeState?.value;
  const points = ordered.filter((state) => state.value.population !== undefined || state.value.economy !== undefined).map((state) => ({ year: state.startYear, population: state.value.population, economy: state.value.economy }));
  const currentYear = map.timeline.currentYear;
  const priorPopulation = [...ordered].reverse().find((state) => state.startYear <= currentYear && state.value.population !== undefined);
  const futurePopulation = ordered.find((state) => state.startYear > (priorPopulation?.startYear === currentYear ? currentYear : currentYear - 1) && state.value.population !== undefined);
  const priorEconomy = [...ordered].reverse().find((state) => state.startYear <= currentYear && state.value.economy !== undefined);
  const futureEconomy = ordered.find((state) => state.startYear > (priorEconomy?.startYear === currentYear ? currentYear : currentYear - 1) && state.value.economy !== undefined);
  const metricCell = (state: typeof ordered[number] | undefined, key: "population" | "economy", label: string) => <><span>{state ? `${projectYearLabel(project, state.startYear)} ${label}` : label}</span><strong>{state?.value[key]?.toLocaleString() ?? "기록 없음"}</strong></>;
  const updateLocation = (nextLocation: Location, sourceMapId = map.id) => {
    const nextMaps = project.maps.map((candidate) => {
      if (candidate.id === map.id && sourceMapId !== map.id) return { ...candidate, locations: candidate.locations.filter((entry) => entry.id !== location.id) };
      if (candidate.id === sourceMapId && sourceMapId !== map.id) return { ...candidate, locations: [...candidate.locations.filter((entry) => entry.id !== location.id), nextLocation] };
      if (candidate.id === map.id) return { ...candidate, locations: candidate.locations.map((entry) => entry.id === location.id ? nextLocation : entry) };
      return candidate;
    });
    onProjectChange({ ...project, maps: nextMaps, wikiArticles: project.wikiArticles.map((candidate) => candidate.id === article.id ? { ...candidate, sourceMapId, title: nextLocation.states[nextLocation.states.length - 1]?.value.name ?? candidate.title, lastModifiedDate: new Date().toISOString() } : candidate) });
  };
  const updateState = (patch: Partial<LocationState>) => {
    if (!activeState) return;
    updateLocation({ ...location, states: location.states.map((state) => state === activeState ? { ...state, value: { ...state.value, ...patch } } : state) });
  };
  const updateInitialYear = (year?: number) => {
    if (!ordered[0] || year === undefined) return;
    const first = ordered[0];
    updateLocation({ ...location, states: location.states.map((state) => state === first ? { ...state, startYear: year } : state) });
  };
  if (editMode && current) return <section className="linked-history-section location-document-editor">
    <h3>도시·장소 정보</h3>
    <div className="form-grid two"><label>지도<select value={map.id} onChange={(event) => updateLocation(location, event.target.value)}>{project.maps.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.title}</option>)}</select></label><label>초회 연도<ActiveYearInput project={project} value={ordered[0]?.startYear} onChange={updateInitialYear} /></label></div>
    <div className="form-grid two"><label>현재 이름<input value={current.name} onChange={(event) => updateState({ name: event.target.value })} /></label><label>현재 유형<select value={current.locationType} onChange={(event) => updateState({ locationType: event.target.value as LocationState["locationType"] })}>{Object.entries(locationTypeLabels).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
    <div className="form-grid two"><label>현재 상태<select value={current.status} onChange={(event) => updateState({ status: event.target.value as LocationState["status"] })}>{Object.entries(statusLabels).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>지역명<input value={current.regionName ?? ""} onChange={(event) => updateState({ regionName: event.target.value })} /></label></div>
    <div className="form-grid two"><label>인구<input type="number" value={current.population ?? ""} onChange={(event) => updateState({ population: event.target.value === "" ? undefined : Number(event.target.value) })} /></label><label>경제력<input type="number" value={current.economy ?? ""} onChange={(event) => updateState({ economy: event.target.value === "" ? undefined : Number(event.target.value) })} /></label></div>
    <div className="form-grid two"><label>지도 X<input type="number" value={current.position.x} onChange={(event) => updateState({ position: { ...current.position, x: Number(event.target.value) } })} /></label><label>지도 Y<input type="number" value={current.position.y} onChange={(event) => updateState({ position: { ...current.position, y: Number(event.target.value) } })} /></label></div>
    <label>설명<textarea value={current.description} onChange={(event) => updateState({ description: event.target.value })} /></label>
    <h3>인구·경제력 변화</h3><MetricChart points={points} series={[{ key: "population", label: "인구", className: "population-series" }, { key: "economy", label: "경제력", className: "economy-series" }]} />
  </section>;
  return <section className="linked-history-section"><div className="linked-current-card location-current-card"><div><span>지도</span><strong>{map.title}</strong></div><div><span>조회 연도</span><strong>{formatTimelineMoment(project, map.timeline)}</strong></div><div><span>현재 상태</span><strong>{current ? `${locationTypeLabels[current.locationType]} · ${statusLabels[current.status]}` : "해당 연도에 존재하지 않음"}</strong></div><div className="location-metric-row sparse-metric-row">{metricCell(priorPopulation,"population","인구")}{metricCell(futurePopulation,"population","인구")}{metricCell(priorEconomy,"economy","경제력")}{metricCell(futureEconomy,"economy","경제력")}</div></div><h3>인구·경제력 변화</h3><MetricChart points={points} series={[{ key: "population", label: "인구", className: "population-series" }, { key: "economy", label: "경제력", className: "economy-series" }]} /><h3>시대별 장소 기록</h3><div className="history-table-wrap"><table className="history-table"><thead><tr><th>적용 시기</th><th>이름</th><th>유형</th><th>인구</th><th>경제력</th><th>상태</th><th>좌표</th><th>설명</th></tr></thead><tbody>{ordered.map((state) => <tr key={`${state.startYear}-${state.endYear ?? "now"}`}><td>{yearRange(project, state.startYear, state.endYear)}</td><td>{state.value.name}</td><td>{locationTypeLabels[state.value.locationType]}</td><td>{state.value.population?.toLocaleString() ?? "-"}</td><td>{state.value.economy?.toLocaleString() ?? "-"}</td><td>{statusLabels[state.value.status]}</td><td>{state.value.position.x.toFixed(1)}, {state.value.position.y.toFixed(1)}</td><td>{state.value.description || "-"}</td></tr>)}</tbody></table></div></section>;
}

function EventHistory({ project, article, editMode, onProjectChange }: { project: WorldProject; article: WikiArticle; editMode: boolean; onProjectChange: (project: WorldProject) => void }) {
  const sourceMap = project.maps.find((item) => item.id === article.sourceMapId);
  const map = sourceMap ?? project.maps.find((item) => item.id === project.activeMapId) ?? project.maps[0];
  const sourcedEvent = sourceMap?.events.find((item) => item.id === article.sourceEntityId);
  const event = sourcedEvent ?? article.eventProfile;
  if (!map || !event) return null;
  const updateEvent = (patch: Partial<typeof event>) => {
    if (sourcedEvent && sourceMap) {
      onProjectChange({ ...project, maps: project.maps.map((candidate) => candidate.id === sourceMap.id ? { ...candidate, events: candidate.events.map((entry) => entry.id === event.id ? { ...entry, ...patch } : entry) } : candidate) });
      return;
    }
    onProjectChange({ ...project, wikiArticles: project.wikiArticles.map((candidate) => candidate.id === article.id ? { ...candidate, title: typeof patch.title === "string" ? patch.title : candidate.title, eventCategory: patch.category ?? candidate.eventCategory, eventProfile: { ...event, ...patch }, lastModifiedDate: new Date().toISOString() } : candidate) });
  };
  const updateParticipant = (id: string, patch: Partial<(typeof event.participants)[number]>) => updateEvent({ participants: event.participants.map((item) => item.id === id ? { ...item, ...patch } : item) });
  const updateChronology = (id: string, patch: Partial<(typeof event.chronology)[number]>) => updateEvent({ chronology: event.chronology.map((item) => item.id === id ? { ...item, ...patch } : item) });
  const chronology = [...event.chronology].sort((a, b) => chronologyValue(a.dateTime) - chronologyValue(b.dateTime));
  const dateInput = (value: HistoricalDateTime, onChange: (value: HistoricalDateTime) => void) => {
    const fields = activeDateTimeFields(project, map, value);
    const updateField = (kind: "year" | "date" | "time", index: number, nextValue: number) => {
      const next = { ...fields, dateValues: [...fields.dateValues], timeValues: [...fields.timeValues] };
      if (kind === "year") next.year = nextValue;
      else if (kind === "date") next.dateValues[index] = nextValue;
      else next.timeValues[index] = nextValue;
      onChange(historicalDateTimeFromActiveFields(project, map, next));
    };
    return <div className="event-date-input-wrap"><div className="event-date-inputs active-calendar-date-inputs"><input type="number" aria-label={`${fields.calendarName} 연도`} value={fields.year} onChange={(event) => updateField("year", 0, Number(event.target.value))} />{fields.dateValues.map((entry,index) => <input key={`date-${index}`} type="number" aria-label={fields.dateLabels[index]} placeholder={fields.dateLabels[index]} value={entry} onChange={(event) => updateField("date", index, Number(event.target.value))} />)}{fields.timeValues.map((entry,index) => <input key={`time-${index}`} type="number" aria-label={fields.timeLabels[index]} placeholder={fields.timeLabels[index]} value={entry} onChange={(event) => updateField("time", index, Number(event.target.value))} />)}</div></div>;
  };
  return <section className="linked-history-section event-wiki-document">
    {editMode ? <div className="event-document-editor"><div className="form-grid two"><label>사건명<input value={event.title} onChange={(e) => updateEvent({ title: e.target.value })} /></label><label>분류<select value={event.category} onChange={(e) => updateEvent({ category: e.target.value as EventCategory })}>{EVENT_CATEGORIES.map((category) => <option key={category} value={category}>{EVENT_CATEGORY_LABELS[category]}</option>)}</select></label></div><label>개요<textarea value={event.description} onChange={(e) => updateEvent({ description: e.target.value })} /></label><div className="form-grid two"><label>시작 시점{!event.startTimeUnknown && dateInput(event.startDateTime, (startDateTime) => updateEvent({ startDateTime, startYear: startDateTime.year }))}<span className="checkbox-row"><input type="checkbox" checked={event.startTimeUnknown} onChange={(e) => { const checked = e.target.checked; const chronology = checked && event.chronology.length === 1 && event.chronology[0]?.title === "사건 발생" ? [] : event.chronology; updateEvent({ startTimeUnknown: checked, chronology }); }} /> 시작 시점 미정</span></label><label>종료 시점{!event.endTimeUnknown && dateInput(event.endDateTime ?? { year: event.startDateTime.year }, (endDateTime) => updateEvent({ endDateTime, endYear: endDateTime.year }))}<span className="checkbox-row"><input type="checkbox" checked={event.endTimeUnknown} onChange={(e) => updateEvent({ endTimeUnknown: e.target.checked, endDateTime: e.target.checked ? null : event.endDateTime ?? { year: event.startDateTime.year }, endYear: e.target.checked ? null : event.endYear ?? event.startDateTime.year })} /> 종료 시점 미정</span></label></div></div> : <table className="namuwiki-infobox"><caption>{event.title}</caption><tbody><tr><th>사건 분류</th><td>{eventDocumentGroup(event.category)} › {EVENT_CATEGORY_LABELS[event.category]}</td></tr><tr><th>시작 시점</th><td>{event.startTimeUnknown ? "시작 시점 미정" : formatDateTime(project, map, event.startDateTime)}</td></tr><tr><th>종료 시점</th><td>{event.endTimeUnknown ? "종료 시점 미정" : formatDateTime(project, map, event.endDateTime)}</td></tr><tr><th>지도 위치</th><td>{event.location ? `${event.location.x.toFixed(1)}, ${event.location.y.toFixed(1)}` : "-"}</td></tr><tr><th>개요</th><td>{event.description || "기록 없음"}</td></tr></tbody></table>}
    <h3>대상</h3>
    <div className="intervention-matrix-wrap intervention-view-matrix-wrap"><table className="intervention-matrix intervention-view-matrix"><tbody>
      {([['organizationName','단체명'],['keyFigures','주요 인물'],['scale','규모'],['cause','원인'],['result','결과']] as const).map(([key, label], rowIndex) => <tr key={key}><th>{label}</th>{event.participants.slice(0, 4).map((participant) => <td key={participant.id}>{editMode ? <input value={participant[key]} onChange={(e) => updateParticipant(participant.id, { [key]: e.target.value })} /> : participant[key] || "-"}</td>)}{editMode && event.participants.length < 4 && rowIndex === 0 && <td className="participant-add-cell" rowSpan={5}><button type="button" title="대상 열 추가" onClick={() => updateEvent({ participants: [...event.participants, { id: createId("participant"), organizationName: "", keyFigures: "", scale: "", cause: "", result: "" }] })}>＋</button></td>}</tr>)}
    </tbody></table>{editMode && event.participants.length > 0 && <div className="participant-remove-row">{event.participants.slice(0,4).map((participant, index) => <button type="button" className="danger-ghost" key={participant.id} onClick={() => updateEvent({ participants: event.participants.filter((item) => item.id !== participant.id) })}>{index + 1}열 삭제</button>)}</div>}{event.participants.length === 0 && !editMode && <p className="empty-hint intervention-empty">기록된 대상이 없습니다.</p>}</div>
    <h3>연표</h3>
    {editMode ? <div className="chronology-editor"><button type="button" className="secondary-button" onClick={() => updateEvent({ chronology: [...event.chronology, { id: createId("chronology"), dateTime: { year: event.startYear }, title: "새 기록", description: "" }] })}>＋ 연표 기록</button>{chronology.map((entry) => <div className="chronology-edit-card" key={entry.id}>{dateInput(entry.dateTime, (dateTime) => updateChronology(entry.id, { dateTime }))}<input placeholder="항목" value={entry.title} onChange={(e) => updateChronology(entry.id, { title: e.target.value })} /><textarea placeholder="내용" value={entry.description} onChange={(e) => updateChronology(entry.id, { description: e.target.value })} /><button type="button" className="danger-ghost" onClick={() => updateEvent({ chronology: event.chronology.filter((item) => item.id !== entry.id) })}>삭제</button></div>)}</div> : <div className="history-table-wrap"><table className="history-table event-chronology-table"><thead><tr><th>일시</th><th>항목</th><th>내용</th></tr></thead><tbody>{chronology.map((entry) => <tr key={entry.id}><td>{formatDateTime(project, map, entry.dateTime)}</td><td><strong>{entry.title || "-"}</strong></td><td>{entry.description || "-"}</td></tr>)}{chronology.length === 0 && <tr><td colSpan={3}>기록된 연표가 없습니다.</td></tr>}</tbody></table></div>}
  </section>;
}

function articlesBySystem(project: WorldProject, key: WikiCategory): WikiArticle[] {
  const ids = new Set(project.wikiCategories.filter((item) => (item.templateKey ?? item.systemKey) === key).map((item) => item.id));
  const items = project.wikiArticles.filter((article) => article.category === key || (article.categoryId ? ids.has(article.categoryId) : false));
  const order = sortSelectionOptions(items.map((item) => ({ id: item.id, label: item.title })));
  const rank = new Map(order.map((item, index) => [item.id, index]));
  return items.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
}

const ACTIVITY_RANGE_LABELS: Record<string, string> = { land_only: "육상 활동만", land_centered: "육상 중심", mixed: "육해 활동", sea_centered: "해상 중심", sea_only: "해상 활동만" };

function WikiInlineLink({ project, articleId, fallback, onOpenArticle }: { project: WorldProject; articleId?: string; fallback?: string; onOpenArticle: (id: string) => void }) {
  const linked = articleId ? project.wikiArticles.find((item) => item.id === articleId) : undefined;
  return linked ? <a href={`#wiki-${linked.id}`} className="wiki-inline-link" onClick={(event) => { event.preventDefault(); onOpenArticle(linked.id); }}>{linked.title}</a> : <>{fallback || "미정"}</>;
}

type ReferenceOption = { id: string; label: string };
function ReferencePicker({ label, options, articleId, customText, allowNone = true, onChange }: { label: string; options: ReferenceOption[]; articleId?: string; customText?: string; allowNone?: boolean; onChange: (value: { articleId?: string; customText?: string; mode: "selected" | "custom" | "undecided" | "none" }) => void }) {
  const [forcedCustom, setForcedCustom] = useState(false);
  const sortedOptions = useMemo(() => sortSelectionOptions(options), [options]);
  const customMode = !articleId && (forcedCustom || (Boolean(customText) && customText !== "없음"));
  const modeValue = articleId ?? (customText === "없음" ? "__none__" : customMode ? "__custom__" : "");
  return <label className="reference-picker smart-reference-field">{label}
    <span className={`reference-picker-row${customMode ? " custom" : ""}`}>
      <select value={modeValue} onChange={(event) => {
        const value = event.target.value;
        if (!value) { setForcedCustom(false); onChange({ mode: "undecided" }); }
        else if (value === "__none__") { setForcedCustom(false); onChange({ customText: "없음", mode: "none" }); }
        else if (value === "__custom__") { setForcedCustom(true); onChange({ customText: customMode ? customText : "", mode: "custom" }); }
        else { setForcedCustom(false); onChange({ articleId: value, mode: "selected" }); }
      }}>
        <option value="">미정</option>
        {allowNone && <option value="__none__">없음</option>}
        <option value="__custom__">직접 입력</option>
        {sortedOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
      </select>
      {customMode && <input autoFocus value={customText ?? ""} placeholder="직접 입력" onChange={(event) => onChange({ customText: event.target.value, mode: "custom" })} />}
    </span>
    <small>문서를 선택하면 문서 ID가 저장되어 열람 화면에서 하이퍼링크로 표시됩니다.</small>
  </label>;
}

function FactionHistory({ project, article, editMode, onProjectChange, onOpenArticle }: { project: WorldProject; article: WikiArticle; editMode: boolean; onProjectChange: (project: WorldProject) => void; onOpenArticle: (id: string) => void }) {
  const sourceMap = project.maps.find((item) => item.id === article.sourceMapId);
  const map = sourceMap ?? project.maps.find((item) => item.id === project.activeMapId) ?? project.maps[0];
  const sourcedFaction = sourceMap?.factions.find((item) => item.id === article.sourceEntityId);
  const faction = sourcedFaction ?? article.factionProfile;
  if (!map || !faction) return null;
  const projectWithFactionPatch = (baseProject: WorldProject, patch: Partial<Faction>): WorldProject => {
    const baseMap = sourceMap ? baseProject.maps.find((item) => item.id === sourceMap.id) : undefined;
    const baseFaction = baseMap?.factions.find((item) => item.id === faction.id) ?? baseProject.wikiArticles.find((candidate) => candidate.id === article.id)?.factionProfile ?? faction;
    const nextName = typeof patch.name === "string" ? patch.name : baseFaction.name;
    if (sourcedFaction && sourceMap) {
      return {
        ...baseProject,
        maps: baseProject.maps.map((item) => item.id === sourceMap.id ? { ...item, factions: item.factions.map((entry) => entry.id === faction.id ? { ...entry, ...patch } : entry) } : item),
        wikiArticles: baseProject.wikiArticles.map((candidate) => candidate.sourceEntityType === "faction" && candidate.sourceEntityId === faction.id ? { ...candidate, title: nextName, lastModifiedDate: new Date().toISOString() } : candidate),
      };
    }
    return { ...baseProject, wikiArticles: baseProject.wikiArticles.map((candidate) => candidate.id === article.id ? { ...candidate, title: nextName, factionProfile: { ...baseFaction, ...patch }, lastModifiedDate: new Date().toISOString() } : candidate) };
  };
  const update = (patch: Partial<Faction>) => onProjectChange(projectWithFactionPatch(project, patch));
  const setTerritoryEnabled = (enabled: boolean) => {
    if (enabled) { update({ hasTerritory: true, territoryHidden: false }); return; }
    const ownedTerritoryIds = sourceMap ? sourceMap.territories.filter((territory) => territory.states.some((state) => state.value.ownerFactionId === faction.id)).map((territory) => territory.id) : [];
    const deleteData = ownedTerritoryIds.length > 0 && typeof window !== "undefined"
      ? window.confirm("기존 영토 데이터도 삭제할까요?\n확인: 영토 삭제 · 취소: 데이터 유지 후 영토 부여만 해제")
      : false;
    if (sourcedFaction && sourceMap) {
      onProjectChange({
        ...project,
        maps: project.maps.map((candidate) => candidate.id === sourceMap.id ? {
          ...candidate,
          factions: candidate.factions.map((entry) => entry.id === faction.id ? { ...entry, hasTerritory: false, territoryHidden: false } : entry),
          territories: deleteData ? candidate.territories.filter((territory) => !ownedTerritoryIds.includes(territory.id)) : candidate.territories,
        } : candidate),
      });
      return;
    }
    update({ hasTerritory: false, territoryHidden: false });
  };
  const articles = (key: WikiCategory) => articlesBySystem(project, key).map((item) => ({ id: item.id, label: item.title }));
  const people = articles("person"); const religions = articles("religion"); const cultures = articles("culture"); const languages = articles("language"); const ideologies = articles("ideology"); const governments = articles("government"); const countries = articles("country").filter((item) => item.id !== article.id); const factions = articles("faction").filter((item) => item.id !== article.id); const symbols = project.wikiArticles.map((item) => ({ id: item.id, label: item.title }));
  const locationOptions = sortSelectionOptions(map.locations.map((entry) => ({ id: entry.id, label: getStateAtYear(entry.states, map.timeline.currentYear)?.name ?? "이름 없는 장소" })));
  const locationWikiId = (locationId?: string) => locationId ? project.wikiArticles.find((item) => item.sourceEntityType === "location" && item.sourceEntityId === locationId)?.id : undefined;
  const leaderStatus = faction.leaderStatus ?? (faction.leaderArticleId ? "selected" : faction.leaderName ? "custom" : "undecided");
  const country = faction.countryProfile ?? { nameRoot: faction.name, showRegimeSuffix: true, spaceBeforeRegimeSuffix: true, politicalSystem: "", symbol: "", languageArticleIds: [], languageCustom: "", cultureArticleIds: [], majorLocationIds: [] };
  const group = faction.groupProfile ?? { symbol: "", ideology: "", alignment: "", goals: "", headquartersStatus: "undecided", languageArticleIds: [], languageCustom: "", cultureArticleIds: [], cultureCustom: "", countryArticleIds: [], relatedFactionArticleIds: [] };
  const governmentArticle = country.politicalSystemArticleId ? project.wikiArticles.find((candidate) => candidate.id === country.politicalSystemArticleId) : undefined;
  const suffix = governmentArticle?.governmentProfile?.countryNameSuffix?.trim() ?? "";
  const inferredRoot = country.nameRoot?.trim() || (suffix && faction.name.endsWith(suffix) ? faction.name.slice(0, -suffix.length) : faction.name);
  const composeCountryName = (root: string, nextSuffix = suffix, profile = country) => {
    const cleanRoot = root.trim(); const cleanSuffix = nextSuffix.trim();
    if (profile.showRegimeSuffix === false || !cleanSuffix) return cleanRoot;
    return `${cleanRoot}${profile.spaceBeforeRegimeSuffix === false ? "" : " "}${cleanSuffix}`.trim();
  };
  const metrics = factionMetricTimeline(map, faction.id);
  const territoryPolygons = (faction.territoryHidden !== true && (faction.kind === "country" || faction.hasTerritory === true)) ? map.territories.flatMap((territory) => {
    const state = getStateAtYear(territory.states, map.timeline.currentYear);
    return state?.ownerFactionId === faction.id && state.polygon.length >= 3 ? [state.polygon] : [];
  }) : [];
  const leaderText = leaderStatus === "none" ? "없음" : leaderStatus === "undecided" ? "미정" : faction.leaderArticleId ? undefined : faction.leaderName;
  const setLeader = ({ articleId, customText, mode }: { articleId?: string; customText?: string; mode: "selected" | "custom" | "undecided" | "none" }) => update({ leaderArticleId: articleId, leaderName: mode === "selected" ? people.find((item) => item.id === articleId)?.label : customText, leaderStatus: mode });
  const profileTitle = faction.kind === "country" ? "국가" : faction.kind === "organization" ? "단체" : "세력";

  if (editMode) return <section className="linked-history-section faction-document faction-edit-layout"><h3>{profileTitle} 정보</h3>
    {faction.kind === "country" && <div className="country-name-editor-row"><label>국가 고유명<input value={inferredRoot} onChange={(event) => { const nameRoot = event.target.value; const nextProfile = { ...country, nameRoot }; update({ name: composeCountryName(nameRoot, suffix, nextProfile), countryProfile: nextProfile }); }} /><small>현재 표시: {composeCountryName(inferredRoot) || "미정"}</small></label><div className="country-suffix-options"><label><input type="checkbox" checked={country.showRegimeSuffix !== false} onChange={(event) => { const nextProfile = { ...country, nameRoot: inferredRoot, showRegimeSuffix: event.target.checked }; update({ name: composeCountryName(inferredRoot, suffix, nextProfile), countryProfile: nextProfile }); }} /> 접미사 표시</label><label><input type="checkbox" checked={country.spaceBeforeRegimeSuffix !== false} onChange={(event) => { const nextProfile = { ...country, nameRoot: inferredRoot, spaceBeforeRegimeSuffix: event.target.checked }; update({ name: composeCountryName(inferredRoot, suffix, nextProfile), countryProfile: nextProfile }); }} /> 접미사 띄어쓰기</label></div></div>}
    <div className="faction-display-activity-row"><div className="faction-display-controls"><label>표시 색상<input type="color" value={faction.color} onChange={(event) => update({ color: event.target.value })} /></label>{faction.kind !== "country" && <><label className="checkbox-row"><input type="checkbox" checked={faction.hasTerritory === true} onChange={(event) => setTerritoryEnabled(event.target.checked)} /> 영토 부여</label><label className={`checkbox-row ${faction.hasTerritory !== true ? "disabled" : ""}`}><input type="checkbox" disabled={faction.hasTerritory !== true} checked={faction.territoryHidden === true} onChange={(event) => update({ territoryHidden: event.target.checked })} /> 영토 숨김</label></>}</div><label className="activity-range-field">활동 반경<select value={faction.activityRange} onChange={(event) => update({ activityRange: event.target.value as Faction["activityRange"] })}>{Object.entries(ACTIVITY_RANGE_LABELS).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
    {faction.kind === "organization" && <label>단체 유형<select value={faction.organizationType ?? "general"} onChange={(event) => update({ organizationType: event.target.value as OrganizationType })}><option value="general">일반 단체</option><option value="order">교단</option><option value="merchant_guild">상단</option><option value="mercenary_company">용병단</option><option value="assassin_guild">암살단</option><option value="knight_order">기사단</option></select></label>}
    <div className="form-grid two"><label>{faction.kind === "country" ? "건국 연도" : "창설 연도"}<ActiveYearInput project={project} value={faction.foundedYear} onChange={(foundedYear) => update({ foundedYear })} /></label><label>{faction.kind === "country" ? "멸망 연도" : "해체 연도"}<ActiveYearInput project={project} value={faction.dissolvedYear} placeholder="현재 존속 중" onChange={(dissolvedYear) => update({ dissolvedYear })} /></label></div>
    <label>상세 정보<textarea value={faction.description} onChange={(event) => update({ description: event.target.value })} /></label>
    <ReferencePicker label="지도자" options={people} articleId={faction.leaderArticleId} customText={leaderStatus === "custom" ? faction.leaderName : leaderStatus === "none" ? "없음" : undefined} onChange={setLeader} />
    <HeraldryEditorFields project={project} displayFlag={faction.displayFlag} displayCoat={faction.displayCoatOfArms} flagAssetId={faction.flagAssetId} coatAssetId={faction.coatOfArmsAssetId} onProjectChange={onProjectChange} onChange={(patch) => update(patch)} onCommit={(nextProject, patch) => onProjectChange(projectWithFactionPatch(nextProject, patch))} />
    {faction.kind === "country" ? <>
      <ReferencePicker label="정치 체제" options={governments} articleId={country.politicalSystemArticleId} customText={country.politicalSystem || undefined} onChange={({articleId,customText,mode}) => { const nextSuffix = articleId ? project.wikiArticles.find((candidate) => candidate.id === articleId)?.governmentProfile?.countryNameSuffix ?? "" : ""; update({ name: composeCountryName(inferredRoot, nextSuffix), countryProfile: { ...country, nameRoot: inferredRoot, politicalSystemArticleId: articleId, politicalSystem: mode === "custom" ? customText ?? "" : mode === "none" ? "없음" : "" } }); }} />
      <ReferencePicker label="국교" options={religions} articleId={country.stateReligionArticleId} customText={country.stateReligionCustom || undefined} onChange={({articleId,customText,mode}) => update({ countryProfile: { ...country, stateReligionArticleId: articleId, stateReligionCustom: mode === "custom" ? customText : mode === "none" ? "없음" : undefined } })} />
      <ReferencePicker label="언어" options={languages} articleId={country.languageArticleIds[0]} customText={country.languageCustom || undefined} onChange={({articleId,customText,mode}) => update({ countryProfile: { ...country, languageArticleIds: articleId ? [articleId] : [], languageCustom: mode === "custom" ? customText : mode === "none" ? "없음" : undefined } })} />
      <ReferencePicker label="문화" options={cultures} articleId={country.cultureArticleIds[0]} customText={country.cultureCustom || undefined} onChange={({articleId,customText,mode}) => update({ countryProfile: { ...country, cultureArticleIds: articleId ? [articleId] : [], cultureCustom: mode === "custom" ? customText : mode === "none" ? "없음" : undefined } })} />
      <ReferencePicker label="수도" options={locationOptions} articleId={country.capitalLocationId} customText={country.capitalCustom || undefined} onChange={({articleId,customText,mode}) => update({ countryProfile: { ...country, capitalLocationId: articleId, capitalCustom: mode === "custom" ? customText : mode === "none" ? "없음" : undefined } })} />
      <ReferencePicker label="주요 도시" options={locationOptions} articleId={country.majorLocationIds[0]} customText={country.majorLocationsCustom || undefined} onChange={({articleId,customText,mode}) => update({ countryProfile: { ...country, majorLocationIds: articleId ? [articleId] : [], majorLocationsCustom: mode === "custom" ? customText : mode === "none" ? "없음" : undefined } })} />
      <h4>경제력 및 인구 그래프</h4><MetricChart points={metrics} series={[{ key: "population", label: "인구", className: "population-series" }, { key: "economy", label: "경제력", className: "economy-series" }]} />
    </> : <>
      <ReferencePicker label="사상" options={ideologies} articleId={group.ideologyArticleId} customText={group.ideology || undefined} onChange={({articleId,customText,mode}) => update({ groupProfile: { ...group, ideologyArticleId: articleId, ideology: mode === "custom" ? customText ?? "" : mode === "none" ? "없음" : "" } })} />
      <ReferencePicker label="상징" options={symbols} articleId={group.symbolArticleId} customText={group.symbol || undefined} onChange={({articleId,customText,mode}) => update({ groupProfile: { ...group, symbolArticleId: articleId, symbol: mode === "custom" ? customText ?? "" : mode === "none" ? "없음" : "" } })} />
      <ReferencePicker label="본부" options={locationOptions} articleId={group.headquartersLocationId} customText={group.headquartersCustom || undefined} onChange={({articleId,customText,mode}) => update({ groupProfile: { ...group, headquartersLocationId: articleId, headquartersCustom: mode === "custom" ? customText : mode === "none" ? "없음" : undefined, headquartersStatus: mode } })} />
      <ReferencePicker label="언어" options={languages} articleId={group.languageArticleIds[0]} customText={group.languageCustom || undefined} onChange={({articleId,customText,mode}) => update({ groupProfile: { ...group, languageArticleIds: articleId ? [articleId] : [], languageCustom: mode === "custom" ? customText : mode === "none" ? "없음" : undefined } })} />
      <ReferencePicker label="문화" options={cultures} articleId={(group.cultureArticleIds ?? [])[0]} customText={group.cultureCustom || undefined} onChange={({articleId,customText,mode}) => update({ groupProfile: { ...group, cultureArticleIds: articleId ? [articleId] : [], cultureCustom: mode === "custom" ? customText : mode === "none" ? "없음" : undefined } })} />
      <ReferencePicker label="소속 국가" options={countries} articleId={(group.countryArticleIds ?? [])[0]} onChange={({articleId}) => update({ groupProfile: { ...group, countryArticleIds: articleId ? [articleId] : [] } })} />
      <ReferencePicker label="관련 세력" options={factions} articleId={(group.relatedFactionArticleIds ?? [])[0]} onChange={({articleId}) => update({ groupProfile: { ...group, relatedFactionArticleIds: articleId ? [articleId] : [] } })} />
      <div className="form-grid two"><label>성향<input value={group.alignment} onChange={(event) => update({ groupProfile: { ...group, alignment: event.target.value } })} /></label><label>목표<input value={group.goals} onChange={(event) => update({ groupProfile: { ...group, goals: event.target.value } })} /></label></div>
    </>}
  </section>;

  return <section className="linked-history-section faction-document"><h3>{profileTitle} 정보</h3><HeraldryDisplay project={project} territoryPolygons={territoryPolygons} territoryColor={faction.color} showFlag={faction.displayFlag} showCoat={faction.displayCoatOfArms} flagAssetId={faction.flagAssetId} coatAssetId={faction.coatOfArmsAssetId} /><table className="namuwiki-infobox faction-infobox"><tbody>
    {faction.kind === "country" && <tr><th>국명</th><td>{composeCountryName(inferredRoot)}</td></tr>}<tr><th>표시 색상</th><td><span className="color-chip" style={{ background: faction.color }} /> {faction.color}</td></tr><tr><th>활동 반경</th><td>{ACTIVITY_RANGE_LABELS[faction.activityRange]}</td></tr>{faction.kind !== "country" && <tr><th>영토</th><td>{faction.hasTerritory ? (faction.territoryHidden ? "부여됨 · 숨김" : "부여됨") : "없음"}</td></tr>}{faction.kind === "organization" && <tr><th>단체 유형</th><td>{{ general: "일반 단체", order: "교단", merchant_guild: "상단", mercenary_company: "용병단", assassin_guild: "암살단", knight_order: "기사단" }[faction.organizationType ?? "general"]}</td></tr>}<tr><th>{faction.kind === "country" ? "건국" : "창설"}</th><td>{faction.foundedYear === undefined ? "미상" : projectYearLabel(project, faction.foundedYear)}</td></tr><tr><th>{faction.kind === "country" ? "멸망" : "해체"}</th><td>{faction.dissolvedYear === undefined ? "현재 존속" : projectYearLabel(project, faction.dissolvedYear)}</td></tr><tr><th>상세 정보</th><td>{faction.description || "기록 없음"}</td></tr><tr><th>지도자</th><td><WikiInlineLink project={project} articleId={faction.leaderArticleId} fallback={leaderText} onOpenArticle={onOpenArticle} /></td></tr>
    {faction.kind === "country" ? <><tr><th>정치 체제</th><td><WikiInlineLink project={project} articleId={country.politicalSystemArticleId} fallback={country.politicalSystem} onOpenArticle={onOpenArticle} /></td></tr><tr><th>국교</th><td><WikiInlineLink project={project} articleId={country.stateReligionArticleId} fallback={country.stateReligionCustom} onOpenArticle={onOpenArticle} /></td></tr><tr><th>언어</th><td>{country.languageArticleIds.map((id,index) => <span key={id}>{index > 0 && ", "}<WikiInlineLink project={project} articleId={id} onOpenArticle={onOpenArticle} /></span>)}{country.languageArticleIds.length === 0 && (country.languageCustom || "미정")}</td></tr><tr><th>문화</th><td>{country.cultureArticleIds.map((id,index) => <span key={id}>{index > 0 && ", "}<WikiInlineLink project={project} articleId={id} onOpenArticle={onOpenArticle} /></span>)}{country.cultureArticleIds.length === 0 && (country.cultureCustom || "미정")}</td></tr><tr><th>수도</th><td><WikiInlineLink project={project} articleId={locationWikiId(country.capitalLocationId)} fallback={country.capitalCustom ?? locationOptions.find((item) => item.id === country.capitalLocationId)?.label} onOpenArticle={onOpenArticle} /></td></tr><tr><th>주요 도시</th><td>{country.majorLocationIds.map((id,index) => <span key={id}>{index > 0 && ", "}<WikiInlineLink project={project} articleId={locationWikiId(id)} fallback={locationOptions.find((item) => item.id === id)?.label} onOpenArticle={onOpenArticle} /></span>)}{country.majorLocationIds.length === 0 && (country.majorLocationsCustom || "미정")}</td></tr></> : <><tr><th>사상</th><td><WikiInlineLink project={project} articleId={group.ideologyArticleId} fallback={group.ideology} onOpenArticle={onOpenArticle} /></td></tr><tr><th>상징</th><td><WikiInlineLink project={project} articleId={group.symbolArticleId} fallback={group.symbol} onOpenArticle={onOpenArticle} /></td></tr><tr><th>본부</th><td><WikiInlineLink project={project} articleId={locationWikiId(group.headquartersLocationId)} fallback={group.headquartersCustom ?? locationOptions.find((item) => item.id === group.headquartersLocationId)?.label} onOpenArticle={onOpenArticle} /></td></tr><tr><th>언어</th><td>{group.languageArticleIds.map((id,index) => <span key={id}>{index > 0 && ", "}<WikiInlineLink project={project} articleId={id} onOpenArticle={onOpenArticle} /></span>)}{group.languageArticleIds.length === 0 && (group.languageCustom || "미정")}</td></tr><tr><th>문화</th><td>{(group.cultureArticleIds ?? []).map((id,index) => <span key={id}>{index > 0 && ", "}<WikiInlineLink project={project} articleId={id} onOpenArticle={onOpenArticle} /></span>)}{(group.cultureArticleIds ?? []).length === 0 && (group.cultureCustom || "미정")}</td></tr><tr><th>소속 국가</th><td>{(group.countryArticleIds ?? []).map((id,index) => <span key={id}>{index > 0 && ", "}<WikiInlineLink project={project} articleId={id} onOpenArticle={onOpenArticle} /></span>)}{(group.countryArticleIds ?? []).length === 0 && "없음"}</td></tr><tr><th>관련 세력</th><td>{(group.relatedFactionArticleIds ?? []).map((id,index) => <span key={id}>{index > 0 && ", "}<WikiInlineLink project={project} articleId={id} onOpenArticle={onOpenArticle} /></span>)}{(group.relatedFactionArticleIds ?? []).length === 0 && "없음"}</td></tr><tr><th>성향</th><td>{group.alignment || "미정"}</td></tr><tr><th>목표</th><td>{group.goals || "미정"}</td></tr></>}
  </tbody></table><><h3>경제력 및 인구 그래프</h3><MetricChart points={metrics} series={[{ key: "population", label: "인구", className: "population-series" }, { key: "economy", label: "경제력", className: "economy-series" }]} /></></section>;
}

function LinkedEntityHistory({ project, article, editMode, onProjectChange, onOpenArticle }: { project: WorldProject; article: WikiArticle; editMode: boolean; onProjectChange: (project: WorldProject) => void; onOpenArticle: (id: string) => void }) {
  if (article.eventProfile || article.sourceEntityType === "event") return <EventHistory project={project} article={article} editMode={editMode} onProjectChange={onProjectChange} />;
  if (article.factionProfile || article.sourceEntityType === "faction") return <FactionHistory project={project} article={article} editMode={editMode} onProjectChange={onProjectChange} onOpenArticle={onOpenArticle} />;
  if (!article.sourceMapId || !article.sourceEntityId || !article.sourceEntityType) return null; const map = project.maps.find((item) => item.id === article.sourceMapId); if (!map) return null;
  if (article.sourceEntityType === "location") { const location = map.locations.find((item) => item.id === article.sourceEntityId); return location ? <LocationHistory project={project} article={article} location={location} editMode={editMode} onProjectChange={onProjectChange} /> : null; }
  const territory = map.territories.find((item) => item.id === article.sourceEntityId); if (!territory) return null; return <section className="linked-history-section"><h3>시대별 영토 기록</h3><div className="history-table-wrap"><table className="history-table"><thead><tr><th>적용 시기</th><th>소유 세력</th><th>경계점 수</th><th>설명</th></tr></thead><tbody>{[...territory.states].sort((a, b) => a.startYear - b.startYear).map((state) => <tr key={`${state.startYear}-${state.endYear ?? "now"}`}><td>{yearRange(project, state.startYear, state.endYear)}</td><td>{map.factions.find((faction) => faction.id === state.value.ownerFactionId)?.name ?? "없음"}</td><td>{state.value.polygon.length}</td><td>{state.value.description || "-"}</td></tr>)}</tbody></table></div></section>;
}

function articleKindLabel(article: WikiArticle): string { if (isEventDocumentCategory(article.category)) return `${eventDocumentGroup(article.eventCategory ?? "incident")} › ${EVENT_CATEGORY_LABELS[article.eventCategory ?? "incident"]}`; if (article.sourceEntityType === "location") return "장소 자동 문서"; if (article.sourceEntityType === "faction") return "국가·세력·단체 자동 문서"; if (article.sourceEntityType === "territory") return "영토 자동 문서"; return article.autoGenerated ? "자동 문서" : "수동 문서"; }

export function WikiWindow({ project, onChange, initialCategoryId, initialEventCategory = "all", initialArticleId, onNavigate }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [backStack, setBackStack] = useState<string[]>([]);
  const [forwardStack, setForwardStack] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [currentOnly, setCurrentOnly] = useState(() => localStorage.getItem("world-archive-wiki-current-only") === "true");
  const [editMode, setEditMode] = useState(false);
  const [categoryManageMode, setCategoryManageMode] = useState(false);
  const [bulkSelectedIds, setBulkSelectedIds] = useState<string[]>([]);
  const [showDocumentAddDialog, setShowDocumentAddDialog] = useState(false);
  const [documentAddQuery, setDocumentAddQuery] = useState("");
  const [draftProject, setDraftProject] = useState<WorldProject | null>(null);
  const displayProject = editMode && draftProject ? draftProject : project;
  const validCategoryIds = useMemo(() => new Set(displayProject.wikiCategories.map((category) => category.id)), [displayProject.wikiCategories]);
  const articleCategoryId = (article: WikiArticle): string | null => article.categoryId && validCategoryIds.has(article.categoryId) ? article.categoryId : null;
  const categoryDefinition = displayProject.wikiCategories.find((category) => category.id === initialCategoryId);
  const categoryName = initialCategoryId === null ? "미지정" : categoryDefinition?.name ?? "삭제된 카테고리";
  const categoryScopeIds = useMemo(() => {
    if (initialCategoryId === null) return new Set<string | null>([null]);
    const ids = new Set<string | null>();
    const collect = (id: string) => { ids.add(id); for (const child of displayProject.wikiCategories.filter((item) => item.parentId === id)) collect(child.id); };
    collect(initialCategoryId);
    return ids;
  }, [displayProject.wikiCategories, initialCategoryId]);
  const categoryArticles = useMemo(() => displayProject.wikiArticles.filter((article) => categoryScopeIds.has(articleCategoryId(article)) && (!isEventDocumentCategory(categoryDefinition?.systemKey) || initialEventCategory === "all" || article.eventCategory === initialEventCategory)), [displayProject.wikiArticles, displayProject.wikiCategories, categoryScopeIds, categoryDefinition?.systemKey, initialEventCategory]);
  const currentTimelineYear = (displayProject.maps.find((item) => item.id === displayProject.activeMapId) ?? displayProject.maps[0])?.timeline.currentYear ?? 0;
  const articleExistsAtCurrentYear = (article: WikiArticle): boolean => {
    const faction = article.factionProfile ?? displayProject.maps.flatMap((item) => item.factions).find((item) => item.id === article.sourceEntityId);
    if (faction) return (faction.foundedYear === undefined || faction.foundedYear <= currentTimelineYear) && (faction.dissolvedYear === undefined || faction.dissolvedYear >= currentTimelineYear);
    if (article.personProfile) return (article.personProfile.birthYear === undefined || article.personProfile.birthYear <= currentTimelineYear) && (article.personProfile.deathYear === undefined || article.personProfile.deathYear >= currentTimelineYear);
    const map = displayProject.maps.find((item) => item.id === article.sourceMapId);
    const location = map?.locations.find((item) => item.id === article.sourceEntityId);
    if (location) return Boolean(getStateAtYear(location.states, currentTimelineYear));
    const event = map?.events.find((item) => item.id === article.sourceEntityId) ?? article.eventProfile;
    if (event) return !event.startTimeUnknown && event.startYear <= currentTimelineYear && (event.endYear === null || event.endYear >= currentTimelineYear);
    if (article.familyProfile) return article.familyProfile.members.some((member) => (member.birthYear === undefined || member.birthYear <= currentTimelineYear) && (member.deathYear === undefined || member.deathYear >= currentTimelineYear));
    return true;
  };
  const filtered = useMemo(() => categoryArticles.filter((article) => (!currentOnly || articleExistsAtCurrentYear(article)) && `${article.title} ${article.summary} ${article.tags.join(" ")}`.toLowerCase().includes(query.toLowerCase())), [categoryArticles, query, currentOnly, currentTimelineYear]);
  const selected = displayProject.wikiArticles.find((article) => article.id === selectedId) ?? categoryArticles[0] ?? null;
  const selectedSystemKey: WikiCategory = selected ? ((displayProject.wikiCategories.find((category) => category.id === articleCategoryId(selected))?.templateKey ?? displayProject.wikiCategories.find((category) => category.id === articleCategoryId(selected))?.systemKey ?? selected.category ?? "other") as WikiCategory) : "other";

  useEffect(() => {
    const requested = initialArticleId ? project.wikiArticles.find((article) => article.id === initialArticleId) : undefined;
    const first = requested ?? project.wikiArticles.find((article) => {
      const categoryId = article.categoryId && project.wikiCategories.some((category) => category.id === article.categoryId) ? article.categoryId : null;
      const category = project.wikiCategories.find((item) => item.id === initialCategoryId);
      const descendantIds = new Set<string | null>([initialCategoryId]);
      let changed = true;
      while (changed) { changed = false; for (const item of project.wikiCategories) if (item.parentId && descendantIds.has(item.parentId) && !descendantIds.has(item.id)) { descendantIds.add(item.id); changed = true; } }
      return descendantIds.has(categoryId) && (!isEventDocumentCategory(category?.systemKey) || initialEventCategory === "all" || article.eventCategory === initialEventCategory);
    });
    setSelectedId(first?.id ?? null); setEditMode(false); setCategoryManageMode(false); setBulkSelectedIds([]); setShowDocumentAddDialog(false); setDraftProject(null);
  }, [initialCategoryId, initialEventCategory, initialArticleId]);


  const navigateToArticle = (id: string, historyMode: "push" | "back" | "forward" = "push") => {
    const target = project.wikiArticles.find((article) => article.id === id);
    if (!target || target.id === selectedId) return;
    if (editMode && !window.confirm("저장하지 않은 편집 내용을 버리고 연결 문서로 이동할까요?")) return;
    if (historyMode === "push" && selectedId) { setBackStack((items) => [...items.slice(-49), selectedId]); setForwardStack([]); }
    setSelectedId(target.id); setEditMode(false); setDraftProject(null);
    onNavigate?.({ categoryId: target.categoryId ?? null, eventCategory: target.eventCategory ?? "all", articleId: target.id });
  };
  const goBack = () => {
    const target = backStack[backStack.length - 1]; if (!target) return;
    if (selectedId) setForwardStack((items) => [selectedId, ...items].slice(0, 50));
    setBackStack((items) => items.slice(0, -1)); navigateToArticle(target, "back");
  };
  const goForward = () => {
    const target = forwardStack[0]; if (!target) return;
    if (selectedId) setBackStack((items) => [...items.slice(-49), selectedId]);
    setForwardStack((items) => items.slice(1)); navigateToArticle(target, "forward");
  };

  const beginEdit = () => { setDraftProject(structuredClone(project)); setEditMode(true); };
  const cancelEdit = () => { setDraftProject(null); setEditMode(false); };
  const saveEdit = () => { if (!draftProject) return; onChange({ ...draftProject, lastModifiedDate: new Date().toISOString() }); setDraftProject(null); setEditMode(false); };
  const updateArticle = (patch: Partial<WikiArticle>) => {
    if (!selected) return;
    const manualPatch: Partial<WikiArticle> = {
      ...patch,
      ...(Object.prototype.hasOwnProperty.call(patch, "title") ? { manualTitle: true } : {}),
      ...(Object.prototype.hasOwnProperty.call(patch, "summary") ? { manualSummary: true } : {}),
    };
    setDraftProject((current) => current ? { ...current, wikiArticles: current.wikiArticles.map((article) => article.id === selected.id ? { ...article, ...manualPatch, lastModifiedDate: new Date().toISOString() } : article) } : current);
  };
  const updateDraftProject = (next: WorldProject) => setDraftProject(next);
  const updateGovernmentProfile = (governmentProfile: NonNullable<WikiArticle["governmentProfile"]>) => {
    if (!selected) return;
    setDraftProject((current) => {
      if (!current) return current;
      const suffix = governmentProfile.countryNameSuffix.trim();
      const renameFaction = (faction: Faction): Faction => {
        if (faction.kind !== "country" || faction.countryProfile?.politicalSystemArticleId !== selected.id) return faction;
        const root = faction.countryProfile.nameRoot?.trim() || faction.name;
        const profile = { ...faction.countryProfile, nameRoot: root };
        const name = profile.showRegimeSuffix === false || !suffix
          ? root
          : `${root}${profile.spaceBeforeRegimeSuffix === false ? "" : " "}${suffix}`.trim();
        return { ...faction, name, countryProfile: profile };
      };
      return {
        ...current,
        wikiArticles: current.wikiArticles.map((candidate) => {
          if (candidate.id === selected.id) return { ...candidate, governmentProfile, lastModifiedDate: new Date().toISOString() };
          if (candidate.factionProfile) return { ...candidate, factionProfile: renameFaction(candidate.factionProfile), title: renameFaction(candidate.factionProfile).name };
          return candidate;
        }),
        maps: current.maps.map((map) => ({ ...map, factions: map.factions.map(renameFaction) })),
      };
    });
  };
  const addArticle = () => {
    const now = new Date().toISOString(); const base = structuredClone(project);
    const aggregateChildren = project.wikiCategories.filter((category) => category.parentId === initialCategoryId);
    const preferred = aggregateChildren.find((category) => ["war", "organization", "location"].includes(category.systemKey ?? "")) ?? aggregateChildren[0];
    const rootCategory = project.wikiCategories.find((category) => category.id === initialCategoryId);
    const targetCategoryId = rootCategory?.systemKey || rootCategory?.templateKey ? initialCategoryId : (preferred?.id ?? initialCategoryId);
    const targetDefinition = project.wikiCategories.find((category) => category.id === targetCategoryId);
    const initialSystemKey = targetDefinition?.templateKey ?? targetDefinition?.systemKey ?? "other";
    const article: WikiArticle = {
      id: createId("wiki"), title: "새 문서", category: initialSystemKey, categoryId: targetCategoryId,
      summary: "", content: "", tags: [], linkedMapEntityIds: [],
      eventCategory: isEventDocumentCategory(initialSystemKey) ? (initialSystemKey === "war" ? "war" : initialSystemKey === "battle" ? "battle" : initialEventCategory !== "all" ? initialEventCategory : eventCategoriesForSystemKey(initialSystemKey)[0]) : undefined,
      eventProfile: isEventDocumentCategory(initialSystemKey) ? { id: createId("embedded-event"), title: "새 문서", startYear: project.maps[0]?.timeline.currentYear ?? 0, endYear: project.maps[0]?.timeline.currentYear ?? 0, category: initialSystemKey === "war" ? "war" : initialSystemKey === "battle" ? "battle" : initialSystemKey === "accident" ? "accident" : "incident", description: "", location: null, startTimeUnknown: false, endTimeUnknown: false, startDateTime: { year: project.maps[0]?.timeline.currentYear ?? 0 }, endDateTime: { year: project.maps[0]?.timeline.currentYear ?? 0 }, participants: [], chronology: [], relatedLocationIds: [], relatedFactionIds: [], relatedTerritoryIds: [] } : undefined,
      factionProfile: ["country", "faction", "organization"].includes(initialSystemKey) ? { id: createId("embedded-faction"), kind: initialSystemKey as "country" | "faction" | "organization", name: "새 문서", color: "#5f8fb3", activityRange: "land_centered", summary: "", description: "", leaderStatus: "undecided", ...(initialSystemKey === "country" ? { hasTerritory: true, countryProfile: { nameRoot: "새", showRegimeSuffix: true, spaceBeforeRegimeSuffix: true, politicalSystem: "", symbol: "", languageArticleIds: [], cultureArticleIds: [], majorLocationIds: [] } } : { hasTerritory: false, groupProfile: { symbol: "", ideology: "", alignment: "", goals: "", headquartersStatus: "undecided", languageArticleIds: [] } }) } : undefined,
      calendarProfile: initialSystemKey === "calendar" ? createDefaultCalendarProfile() : undefined,
      governmentProfile: initialSystemKey === "government" ? { countryNameSuffix: "" } : undefined,
      personProfile: initialSystemKey === "person" ? { organizationArticleIds: [], factionArticleIds: [], spouseArticleIds: [], childArticleIds: [], notes: "" } : undefined,
      familyProfile: initialSystemKey === "family" ? { displayMode: "all", members: [] } : undefined,
      itemProfile: initialSystemKey === "item" ? { itemType: "", origin: "", condition: "", ownershipHistory: [] } : undefined,
      religionProfile: initialSystemKey === "religion" ? { leaderTitle: "", symbol: "", alignment: "", relatedOrganizationIds: [] } : undefined,
      createdDate: now, lastModifiedDate: now,
    };
    base.wikiArticles.push(article); setDraftProject(base); setSelectedId(article.id); setEditMode(true);
  };
  const deleteSelected = () => { if (!selected || selected.autoGenerated) return; setDraftProject((current) => current ? { ...current, wikiArticles: current.wikiArticles.filter((article) => article.id !== selected.id) } : current); setSelectedId(null); };

  const toggleBulk = (id: string) => setBulkSelectedIds((items) => items.includes(id) ? items.filter((item) => item !== id) : [...items, id]);
  const addNewInCategory = () => { addArticle(); setCategoryManageMode(false); };
  const targetCategory = () => {
    const aggregateChildren = project.wikiCategories.filter((category) => category.parentId === initialCategoryId);
    const preferred = aggregateChildren.find((category) => ["war", "organization", "location"].includes(category.systemKey ?? "")) ?? aggregateChildren[0];
    const root = project.wikiCategories.find((category) => category.id === initialCategoryId);
    const id = root?.systemKey || root?.templateKey ? initialCategoryId : (preferred?.id ?? initialCategoryId);
    const definition = project.wikiCategories.find((item) => item.id === id);
    return { id, key: (definition?.templateKey ?? definition?.systemKey ?? "other") as WikiCategory };
  };
  const assignBulkToCategory = () => {
    if (bulkSelectedIds.length === 0) return;
    const target = targetCategory();
    onChange({ ...project, wikiArticles: project.wikiArticles.map((article) => bulkSelectedIds.includes(article.id) ? { ...article, categoryId: target.id, category: target.key } : article) });
    setBulkSelectedIds([]); setShowDocumentAddDialog(false); setDocumentAddQuery("");
  };
  const removeArticleFromCategory = (articleId: string) => {
    onChange({ ...project, wikiArticles: project.wikiArticles.map((article) => article.id === articleId ? { ...article, categoryId: null } : article) });
    if (selectedId === articleId) setSelectedId(null);
  };
  const unassignedArticles = project.wikiArticles.filter((article) => !article.categoryId || !project.wikiCategories.some((category) => category.id === article.categoryId));

  return <>
    <section className="wiki-window">
      <aside className="wiki-list-panel">
        <div className="window-heading compact"><p className="eyebrow">WORLD WIKI</p><h2>{categoryName}{initialEventCategory !== "all" ? ` · ${EVENT_CATEGORY_LABELS[initialEventCategory]}` : ""}</h2><small>{categoryArticles.length}개 문서</small></div>
        <><div className="wiki-search"><input placeholder={`${categoryName} 문서 검색`} value={query} onChange={(event) => setQuery(event.target.value)} /><button type="button" className={categoryManageMode ? "active" : ""} onClick={() => { setCategoryManageMode((value) => !value); setBulkSelectedIds([]); setShowDocumentAddDialog(false); }}>{categoryManageMode ? "완료" : "편집"}</button></div><button type="button" className={`wiki-current-filter ${currentOnly ? "active" : ""}`} onClick={() => setCurrentOnly((value) => { const next = !value; localStorage.setItem("world-archive-wiki-current-only", String(next)); return next; })}>{currentOnly ? "✓ 현재 존재하는 항목만 표시" : "현재 존재하는 항목만 표시"}</button></>
        {categoryManageMode && <div className="category-document-toolbar"><button type="button" className="primary-button" onClick={addNewInCategory}>새 문서</button><button type="button" onClick={() => { setShowDocumentAddDialog(true); setBulkSelectedIds([]); }}>문서 추가</button></div>}
        <div className="article-list">{filtered.map((article) => <div className={`article-list-edit-row ${article.id === selected?.id ? "active" : ""}`} key={article.id}><button type="button" className={article.id === selected?.id ? "active" : ""} onClick={() => { if (editMode && !window.confirm("저장하지 않은 편집 내용을 버리고 다른 문서로 이동할까요?")) return; navigateToArticle(article.id); cancelEdit(); }}><span>{articleKindLabel(article)}{article.autoGenerated ? " · 자동" : ""}</span><strong>{article.title}</strong><small>{article.summary || "설명 없음"}</small></button>{categoryManageMode && <button type="button" className="article-category-remove" title="카테고리에서 제거" onClick={() => removeArticleFromCategory(article.id)}>삭제</button>}</div>)}{filtered.length === 0 && <p className="empty-hint">이 카테고리에 표시할 문서가 없습니다.</p>}</div>
      </aside>
      <article className="wiki-editor" data-link-scope={selected ? `wiki:${selected.id}` : "wiki:none"}>{selected ? <><div className="wiki-navigation-bar"><button type="button" onClick={goBack} disabled={backStack.length === 0} title="이전 문서">← 뒤로</button><button type="button" onClick={goForward} disabled={forwardStack.length === 0} title="다음 문서">앞으로 →</button></div><div className="wiki-calendar-context"><span>현재 표시 역법</span><strong>{formatTimelineMoment(displayProject, (displayProject.maps.find((item) => item.id === displayProject.activeMapId) ?? displayProject.maps[0])?.timeline ?? { minimumYear: 0, maximumYear: 0, currentYear: 0, currentDayOfYear: 0, currentMinuteOfDay: 0, precision: "year", isPlaying: false, playbackIntervalMs: 1000 })}</strong></div><div className="wiki-document-title-row">{editMode ? <input className="wiki-title-input" value={selected.title} onChange={(event) => updateArticle({ title: event.target.value })} /> : <h1>{selected.title}</h1>}<div className="editor-save-row">{editMode ? <><button type="button" className="primary-button" onClick={saveEdit}>편집 완료</button><button type="button" className="secondary-button" onClick={cancelEdit}>취소</button></> : <button type="button" className="secondary-button wiki-edit-entry-button" onClick={beginEdit}>편집</button>}</div></div>{editMode && <div className="draft-edit-banner">입력 내용은 아직 초안입니다. <strong>편집 완료</strong>를 눌러야 저장됩니다.</div>}{editMode && <div className="wiki-edit-controls"><label>카테고리<select value={articleCategoryId(selected) ?? ""} onChange={(event) => { const categoryId = event.target.value || null; const category = (displayProject.wikiCategories.find((item) => item.id === categoryId)?.templateKey ?? displayProject.wikiCategories.find((item) => item.id === categoryId)?.systemKey ?? "other") as WikiCategory; updateArticle({ categoryId, category }); }}><option value="">미지정</option>{displayProject.wikiCategories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>{isEventDocumentCategory(selected.category) && <label>사건 하위 분류<select value={selected.eventCategory ?? eventCategoriesForSystemKey(selected.category)[0]} disabled={selected.autoGenerated || ["war", "battle"].includes(selected.category)} onChange={(event) => updateArticle({ eventCategory: event.target.value as EventCategory })}>{eventCategoriesForSystemKey(selected.category).map((category) => <option key={category} value={category}>{EVENT_CATEGORY_LABELS[category]}</option>)}</select></label>}<label>태그<input value={selected.tags.join(", ")} onChange={(event) => updateArticle({ tags: event.target.value.split(",").map((tag) => tag.trim()).filter(Boolean) })} /></label>{!selected.autoGenerated && <button type="button" className="danger-button" onClick={deleteSelected}>문서 삭제</button>}</div>}{selected.autoGenerated && <div className="auto-wiki-banner"><strong>자동 동기화 문서</strong><span>지도와 연표의 변경 사항은 자동 반영되며 추가 본문과 카테고리는 직접 관리할 수 있습니다.</span></div>}{editMode ? <label>요약<input value={selected.summary} onChange={(event) => updateArticle({ summary: event.target.value })} /></label> : <p className="wiki-document-summary"><WikiLinkedText project={displayProject} text={selected.summary || "요약 없음"} onOpenArticle={(id)=>navigateToArticle(id)} /></p>}{selectedSystemKey === "person" && <PersonProfilePanel project={displayProject} article={selected} editMode={editMode} onChange={(personProfile) => updateArticle({ personProfile })} onOpenArticle={(id) => navigateToArticle(id)} />}{selectedSystemKey === "family" && <FamilyProfilePanel project={displayProject} article={selected} editMode={editMode} onChange={(familyProfile) => updateArticle({ familyProfile })} onProjectChange={updateDraftProject} onProjectAndProfileChange={(nextProject, familyProfile) => setDraftProject({ ...nextProject, wikiArticles: nextProject.wikiArticles.map((candidate) => candidate.id === selected.id ? { ...candidate, familyProfile, lastModifiedDate: new Date().toISOString() } : candidate) })} onOpenArticle={(id) => navigateToArticle(id)} />}{selectedSystemKey === "item" && <ItemProfilePanel project={displayProject} article={selected} editMode={editMode} onChange={(itemProfile) => updateArticle({ itemProfile })} />}{selectedSystemKey === "religion" && <ReligionProfilePanel project={displayProject} article={selected} editMode={editMode} onChange={(religionProfile) => updateArticle({ religionProfile })} />}{selectedSystemKey === "calendar" && <CalendarProfilePanel project={displayProject} article={selected} editMode={editMode} onChange={(calendarProfile) => updateArticle({ calendarProfile })} />}{selectedSystemKey === "government" && <GovernmentProfilePanel article={selected} editMode={editMode} onChange={updateGovernmentProfile} />}<LinkedEntityHistory project={displayProject} article={selected} editMode={editMode} onProjectChange={updateDraftProject} onOpenArticle={(id) => navigateToArticle(id)} />{editMode ? <label className="wiki-content-label">추가 설정 및 본문 <small>[[문서명]] 형식으로 링크할 수 있습니다.</small><textarea value={selected.content} onChange={(event) => updateArticle({ content: event.target.value })} /></label> : selected.content && <section className="wiki-body-view"><h3>본문</h3><p><WikiLinkedText project={displayProject} text={selected.content} onOpenArticle={(id)=>navigateToArticle(id)} /></p></section>}<footer className="document-meta">마지막 수정: {new Date(selected.lastModifiedDate).toLocaleString("ko-KR")}</footer></> : <div className="empty-document"><strong>{categoryName} 문서가 없습니다.</strong><p>새 문서를 만들거나 지도 요소를 추가하세요.</p><button type="button" className="primary-button" onClick={addArticle}>문서 만들기</button></div>}</article>
    </section>
    {showDocumentAddDialog && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowDocumentAddDialog(false); }}><section className="document-add-dialog" role="dialog" aria-modal="true" aria-label="미지정 문서 추가"><div className="dialog-heading"><div><p className="eyebrow">ADD DOCUMENTS</p><h2>미지정 문서 추가</h2><p>현재 카테고리에 연결할 문서를 선택하세요.</p></div><button type="button" className="icon-button" onClick={() => setShowDocumentAddDialog(false)}>×</button></div><input className="document-add-search" placeholder="미지정 문서 검색" value={documentAddQuery} onChange={(event) => setDocumentAddQuery(event.target.value)} /><div className="bulk-document-list">{unassignedArticles.filter((article) => `${article.title} ${article.summary}`.toLowerCase().includes(documentAddQuery.toLowerCase())).map((article) => <label key={article.id}><input type="checkbox" checked={bulkSelectedIds.includes(article.id)} onChange={() => toggleBulk(article.id)} /><span>{article.title}</span><small>{articleKindLabel(article)}</small></label>)}{unassignedArticles.length === 0 && <p className="empty-hint">추가할 미지정 문서가 없습니다.</p>}</div><div className="dialog-actions"><span>{bulkSelectedIds.length}개 선택</span><button type="button" onClick={() => setShowDocumentAddDialog(false)}>취소</button><button type="button" className="primary-button" disabled={bulkSelectedIds.length === 0} onClick={assignBulkToCategory}>문서 추가</button></div></section></div>}
  </>;
}
