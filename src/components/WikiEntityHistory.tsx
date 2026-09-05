import { HeraldicPreview, HeraldryDisplay, HeraldryEditorFields } from "./HeraldryStudio";
import { useState, type ReactNode } from "react";
import { MetricChart as ResponsiveMetricChart, type MetricPoint } from "./MetricChart";
import { ReferencePicker, WikiInlineLink } from "./WikiReferences";
import { sortSelectionOptions } from "../model/selectionSort";
import {
  activeCalendarFieldsFromTimeline,
  activeCalendarYearFromWorldYear,
  createId,
  factionMetricTimeline,
  formatTimelineMoment,
  getStateAtYear,
  standardDayOfYear,
  standardMonthDay,
  timelineFromActiveCalendarFields,
  worldYearFromActiveCalendarYear,
  type Faction,
  type CountryCapitalPeriod,
  type CountryProfile,
  type HistoricalDateTime,
  type Location,
  type LocationState,
  type OrganizationType,
  type WikiArticle,
  type WikiCategory,
  type WorldProject,
} from "../model/world";
import { activeMap } from "../model/worldSelectors";
import { SettlementPlanView } from "./SettlementPlanView";
import { StructuredInfoPanel, StructuredInfoRow } from "./StructuredInfoPanel";

const locationTypeLabels: Record<string, string> = { village: "마을", town: "읍", city: "도시", capital: "수도", ruin: "폐허", dungeon: "던전", sacred_site: "성지", landmark: "랜드마크" };
const statusLabels: Record<string, string> = { active: "활성", occupied: "점령", destroyed: "파괴됨", abandoned: "버려짐" };

function CollapsiblePopulationEconomyChart({ points, editMode, className = "", children }: { points: MetricPoint[]; editMode: boolean; className?: string; children?: ReactNode }) {
  const [readOpen, setReadOpen] = useState(true);
  const [editOpen, setEditOpen] = useState(true);
  const open = editMode ? editOpen : readOpen;
  const setOpen = editMode ? setEditOpen : setReadOpen;
  return <section className={`linked-history-section ${className}`.trim()}>
    <div className="ownership-section-heading metric-section-heading"><h3>경제력 및 인구 그래프</h3><button type="button" className="secondary-button" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "접기" : "펼치기"}</button></div>
    {open && <ResponsiveMetricChart points={points} series={[{ key: "population", label: "인구", className: "population-series" }, { key: "economy", label: "경제력", className: "economy-series" }]} />}
    {children}
  </section>;
}
function projectYearLabel(project: WorldProject, year: number): string {
  const map = activeMap(project);
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

function LocationHistory({ project, article, location, editMode, onProjectChange }: { project: WorldProject; article: WikiArticle; location: Location; editMode: boolean; onProjectChange: (project: WorldProject) => void }) {
  const [timelineOpenRead, setTimelineOpenRead] = useState(true);
  const [timelineOpenEdit, setTimelineOpenEdit] = useState(true);
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
  const metricCell = (state: typeof ordered[number] | undefined, key: "population" | "economy", label: string, placeholder = false) => <div className={`location-metric-cell${placeholder ? " empty" : ""}`} aria-hidden={placeholder || undefined}><span>{state ? `${projectYearLabel(project, state.startYear)} ${label}` : label}</span><strong>{state?.value[key]?.toLocaleString() ?? "기록 없음"}</strong></div>;
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
  const supportsHeraldry = current ? ["town", "city", "capital"].includes(current.locationType) : false;
  const timelineOpen = editMode ? timelineOpenEdit : timelineOpenRead;
  const timelineSection = <><div className="ownership-section-heading temporal-history-heading"><h4>연표</h4><button type="button" className="secondary-button" aria-expanded={timelineOpen} onClick={() => editMode ? setTimelineOpenEdit((value) => !value) : setTimelineOpenRead((value) => !value)}>{timelineOpen ? "접기" : "펼치기"}</button></div>{timelineOpen && <div className="history-table-wrap"><table className="history-table"><thead><tr><th>적용 시기</th><th>이름</th><th>유형</th><th>인구</th><th>경제력</th><th>상태</th><th>좌표</th><th>설명</th></tr></thead><tbody>{ordered.map((state) => <tr key={`${state.startYear}-${state.endYear ?? "now"}`}><td>{yearRange(project, state.startYear, state.endYear)}</td><td>{state.value.name}</td><td>{locationTypeLabels[state.value.locationType]}</td><td>{state.value.population?.toLocaleString() ?? "-"}</td><td>{state.value.economy?.toLocaleString() ?? "-"}</td><td>{statusLabels[state.value.status]}</td><td>{state.value.position.x.toFixed(1)}, {state.value.position.y.toFixed(1)}</td><td>{state.value.description || "-"}</td></tr>)}</tbody></table></div>}</>;
  const metricHistory = (key: "population" | "economy", label: string, prior: typeof priorPopulation, future: typeof futurePopulation) => <div className="location-metric-row sparse-metric-row">{metricCell(prior, key, label)}{metricCell(future, key, label, !future)}</div>;
  const historySection = <CollapsiblePopulationEconomyChart points={points} editMode={editMode} className="location-history-section">{timelineSection}</CollapsiblePopulationEconomyChart>;
  if (editMode && current) return <>
    <StructuredInfoPanel title="도시·장소 정보" className="location-structured-info">
      <StructuredInfoRow label="지도"><select value={map.id} onChange={(event) => updateLocation(location, event.target.value)}>{project.maps.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.title}</option>)}</select></StructuredInfoRow>
      <StructuredInfoRow label="초회 연도"><ActiveYearInput project={project} value={ordered[0]?.startYear} onChange={updateInitialYear} /></StructuredInfoRow>
      <StructuredInfoRow label="현재 이름"><input value={current.name} onChange={(event) => updateState({ name: event.target.value })} /></StructuredInfoRow>
      <StructuredInfoRow label="현재 유형"><select value={current.locationType} onChange={(event) => updateState({ locationType: event.target.value as LocationState["locationType"] })}>{Object.entries(locationTypeLabels).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></StructuredInfoRow>
      <StructuredInfoRow label="현재 상태"><select value={current.status} onChange={(event) => updateState({ status: event.target.value as LocationState["status"] })}>{Object.entries(statusLabels).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></StructuredInfoRow>
      <StructuredInfoRow label="지역명"><input value={current.regionName ?? ""} onChange={(event) => updateState({ regionName: event.target.value })} /></StructuredInfoRow>
      <StructuredInfoRow label="인구"><input type="number" value={current.population ?? ""} onChange={(event) => updateState({ population: event.target.value === "" ? undefined : Number(event.target.value) })} /></StructuredInfoRow>
      <StructuredInfoRow label="경제력"><input type="number" value={current.economy ?? ""} onChange={(event) => updateState({ economy: event.target.value === "" ? undefined : Number(event.target.value) })} /></StructuredInfoRow>
      <StructuredInfoRow label="지도 X"><input type="number" value={current.position.x} onChange={(event) => updateState({ position: { ...current.position, x: Number(event.target.value) } })} /></StructuredInfoRow>
      <StructuredInfoRow label="지도 Y"><input type="number" value={current.position.y} onChange={(event) => updateState({ position: { ...current.position, y: Number(event.target.value) } })} /></StructuredInfoRow>
      <StructuredInfoRow label="설명"><textarea value={current.description} onChange={(event) => updateState({ description: event.target.value })} /></StructuredInfoRow>
    </StructuredInfoPanel>
    {supportsHeraldry && <section className="structured-wiki-panel location-heraldry-section"><HeraldryEditorFields project={project} displayFlag={current.displayFlag} displayCoat={current.displayCoatOfArms} flagAssetId={current.flagAssetId} coatAssetId={current.coatOfArmsAssetId} onChange={(patch) => updateState(patch)} /></section>}
    {current.settlementPlan && <SettlementPlanView plan={current.settlementPlan} />}
    {historySection}
  </>;
  return <>
    {supportsHeraldry && <HeraldryDisplay project={project} showFlag={current?.displayFlag} showCoat={current?.displayCoatOfArms} flagAssetId={current?.flagAssetId} coatAssetId={current?.coatOfArmsAssetId} />}
    <StructuredInfoPanel title="도시·장소 정보" className="location-structured-info">
      <StructuredInfoRow label="지도"><strong>{map.title}</strong></StructuredInfoRow>
      <StructuredInfoRow label="조회 연도"><strong>{formatTimelineMoment(project, map.timeline)}</strong></StructuredInfoRow>
      <StructuredInfoRow label="현재 이름"><strong>{current?.name ?? "해당 연도에 존재하지 않음"}</strong></StructuredInfoRow>
      <StructuredInfoRow label="현재 유형"><strong>{current ? locationTypeLabels[current.locationType] : "-"}</strong></StructuredInfoRow>
      <StructuredInfoRow label="현재 상태"><strong>{current ? statusLabels[current.status] : "-"}</strong></StructuredInfoRow>
      <StructuredInfoRow label="지역명"><strong>{current?.regionName || "미정"}</strong></StructuredInfoRow>
      <StructuredInfoRow label="좌표"><strong>{current ? `${current.position.x.toFixed(1)}, ${current.position.y.toFixed(1)}` : "-"}</strong></StructuredInfoRow>
      <StructuredInfoRow label="설명"><p>{current?.description || "기록 없음"}</p></StructuredInfoRow>
      <StructuredInfoRow label="인구 기록">{metricHistory("population", "인구", priorPopulation, futurePopulation)}</StructuredInfoRow>
      <StructuredInfoRow label="경제력 기록">{metricHistory("economy", "경제력", priorEconomy, futureEconomy)}</StructuredInfoRow>
    </StructuredInfoPanel>
    {current?.settlementPlan && <SettlementPlanView plan={current.settlementPlan} />}
    {historySection}
  </>;
}

const participantOrganizationCategories = new Set<WikiCategory>([
  "country", "faction", "organization", "order", "merchant_guild",
  "mercenary_company", "assassin_guild", "knight_order",
]);

function heraldryFlagIdForArticle(project: WorldProject, article?: WikiArticle): string | undefined {
  if (!article) return undefined;
  if (article.familyProfile?.displayFlag && article.familyProfile.flagAssetId) return article.familyProfile.flagAssetId;
  const faction = article.factionProfile
    ?? project.maps.flatMap((map) => map.factions).find((candidate) => candidate.id === article.sourceEntityId || candidate.id === article.id);
  return faction?.displayFlag === false ? undefined : faction?.flagAssetId;
}

function participantFlagId(project: WorldProject, article?: WikiArticle): string | undefined {
  if (!article) return undefined;
  const direct = heraldryFlagIdForArticle(project, article);
  if (direct) return direct;
  if (article.category !== "person") return undefined;
  const profile = article.personProfile;
  const affiliationIds = [
    profile?.primaryAffiliationArticleId,
    ...(profile?.nationalityArticleIds ?? (profile?.countryArticleId ? [profile.countryArticleId] : [])),
    ...(profile?.affiliationArticleIds ?? [...(profile?.organizationArticleIds ?? []), ...(profile?.factionArticleIds ?? [])]),
  ].filter((id): id is string => Boolean(id));
  for (const id of affiliationIds) {
    const flagId = heraldryFlagIdForArticle(project, project.wikiArticles.find((candidate) => candidate.id === id));
    if (flagId) return flagId;
  }
  return undefined;
}

function ParticipantReference({ project, articleId, fallback }: { project: WorldProject; articleId?: string; fallback: string }) {
  const article = project.wikiArticles.find((candidate) => candidate.id === articleId);
  const flagId = participantFlagId(project, article);
  const flag = project.heraldicAssets.find((asset) => asset.id === flagId && asset.kind === "flag");
  return <span className="participant-linked-reference">{flag && <HeraldicPreview asset={flag} className="participant-inline-flag" />}<span>{article?.title || fallback || "-"}</span></span>;
}

function EventHistory({ project, article, editMode, onProjectChange }: { project: WorldProject; article: WikiArticle; editMode: boolean; onProjectChange: (project: WorldProject) => void }) {
  const [chronologyOpenRead, setChronologyOpenRead] = useState(true);
  const [chronologyOpenEdit, setChronologyOpenEdit] = useState(true);
  const sourceMap = project.maps.find((item) => item.id === article.sourceMapId);
  const map = sourceMap ?? activeMap(project);
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
    return <div className="event-date-input-wrap"><div className="event-date-inputs active-calendar-date-inputs"><input type="number" aria-label={`${fields.calendarName} 연도`} value={fields.year} onChange={(changeEvent) => updateField("year", 0, Number(changeEvent.target.value))} />{fields.dateValues.map((entry,index) => <input key={`date-${index}`} type="number" aria-label={fields.dateLabels[index]} placeholder={fields.dateLabels[index]} value={entry} onChange={(changeEvent) => updateField("date", index, Number(changeEvent.target.value))} />)}{fields.timeValues.map((entry,index) => <input key={`time-${index}`} type="number" aria-label={fields.timeLabels[index]} placeholder={fields.timeLabels[index]} value={entry} onChange={(changeEvent) => updateField("time", index, Number(changeEvent.target.value))} />)}</div></div>;
  };
  const locationValue = event.locationMode === "coordinate"
    ? event.location ? `${event.location.x.toFixed(1)}, ${event.location.y.toFixed(1)}` : "좌표 미지정"
    : event.locationText || "미정";
  const chronologyOpen = editMode ? chronologyOpenEdit : chronologyOpenRead;
  const organizationArticles = project.wikiArticles.filter((candidate) => participantOrganizationCategories.has(candidate.category)).sort((a, b) => a.title.localeCompare(b.title));
  const personArticles = project.wikiArticles.filter((candidate) => candidate.category === "person").sort((a, b) => a.title.localeCompare(b.title));
  const participantRows = [
    ["organization", "개입 단체"], ["representative", "대표 지도자"], ["otherLeaders", "그 외 지도자"],
    ["scale", "개입 규모"], ["cause", "개입 원인"], ["result", "개입 결과"], ["impact", "개입 영향"],
  ] as const;
  const participantCell = (participant: (typeof event.participants)[number], key: (typeof participantRows)[number][0]): ReactNode => {
    if (key === "organization") return editMode
      ? <div className="participant-reference-editor"><select value={participant.organizationArticleId ?? ""} onChange={(changeEvent) => updateParticipant(participant.id, { organizationArticleId: changeEvent.target.value || undefined })}><option value="">미지정</option>{organizationArticles.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.title}</option>)}</select>{!participant.organizationArticleId && participant.organizationName && <small>{participant.organizationName}</small>}</div>
      : <ParticipantReference project={project} articleId={participant.organizationArticleId} fallback={participant.organizationName} />;
    if (key === "representative") return editMode
      ? <div className="participant-reference-editor"><select value={participant.representativeLeaderArticleId ?? ""} onChange={(changeEvent) => updateParticipant(participant.id, { representativeLeaderArticleId: changeEvent.target.value || undefined })}><option value="">미지정</option>{personArticles.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.title}</option>)}</select>{!participant.representativeLeaderArticleId && participant.representativeLeaderName && <small>{participant.representativeLeaderName}</small>}</div>
      : <ParticipantReference project={project} articleId={participant.representativeLeaderArticleId} fallback={participant.representativeLeaderName || participant.keyFigures || ""} />;
    if (key === "otherLeaders") return editMode
      ? <select multiple value={participant.otherLeaderArticleIds} onChange={(changeEvent) => updateParticipant(participant.id, { otherLeaderArticleIds: [...changeEvent.target.selectedOptions].map((option) => option.value) })}>{personArticles.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.title}</option>)}</select>
      : <span className="participant-other-leaders">{participant.otherLeaderArticleIds.length > 0 ? participant.otherLeaderArticleIds.map((id) => <ParticipantReference key={id} project={project} articleId={id} fallback="" />) : participant.otherLeaderNames.join(", ") || "-"}</span>;
    const field = key === "scale" ? "participationScale" : key;
    return editMode
      ? <input value={participant[field]} onChange={(changeEvent) => updateParticipant(participant.id, { [field]: changeEvent.target.value })} />
      : participant[field] || (key === "scale" ? participant.scale : "") || "-";
  };
  return <section className="linked-history-section event-wiki-document">
    <StructuredInfoPanel title={event.category === "war" ? "전쟁 정보" : event.category === "battle" ? "전투 정보" : "사건 정보"} className="event-structured-info">
      <StructuredInfoRow label="개요">{editMode ? <textarea value={event.description} onChange={(changeEvent) => updateEvent({ description: changeEvent.target.value })} /> : <p>{event.description || "기록 없음"}</p>}</StructuredInfoRow>
      <StructuredInfoRow label="위치">{editMode ? <div className="event-location-editor"><select value={event.locationMode} onChange={(changeEvent) => updateEvent({ locationMode: changeEvent.target.value as typeof event.locationMode })}><option value="coordinate">좌표 지정</option><option value="custom">직접 작성</option></select>{event.locationMode === "coordinate" ? <div className="event-coordinate-inputs"><input type="number" aria-label="지도 X" value={event.location?.x ?? ""} onChange={(changeEvent) => updateEvent({ location: { x: Number(changeEvent.target.value), y: event.location?.y ?? 0 } })} /><input type="number" aria-label="지도 Y" value={event.location?.y ?? ""} onChange={(changeEvent) => updateEvent({ location: { x: event.location?.x ?? 0, y: Number(changeEvent.target.value) } })} /></div> : <input value={event.locationText} onChange={(changeEvent) => updateEvent({ locationText: changeEvent.target.value })} />}</div> : locationValue}</StructuredInfoRow>
      <StructuredInfoRow label="기간"><div className="event-period-stack">{editMode ? <><div>{event.startTimeUnknown ? <span>시작 시점 미정</span> : dateInput(event.startDateTime, (startDateTime) => updateEvent({ startDateTime, startYear: startDateTime.year }))}<label className="checkbox-row"><input type="checkbox" checked={event.startTimeUnknown} onChange={(changeEvent) => updateEvent({ startTimeUnknown: changeEvent.target.checked })} /> 시작 시점 미정</label></div><span className="event-period-divider">~</span><div>{event.endTimeUnknown ? <span>종료 시점 미정</span> : dateInput(event.endDateTime ?? { year: event.startDateTime.year }, (endDateTime) => updateEvent({ endDateTime, endYear: endDateTime.year }))}<label className="checkbox-row"><input type="checkbox" checked={event.endTimeUnknown} onChange={(changeEvent) => updateEvent({ endTimeUnknown: changeEvent.target.checked, endDateTime: changeEvent.target.checked ? null : event.endDateTime ?? { year: event.startDateTime.year }, endYear: changeEvent.target.checked ? null : event.endYear ?? event.startDateTime.year })} /> 종료 시점 미정</label></div></> : <><span>{event.startTimeUnknown ? "시작 시점 미정" : formatDateTime(project, map, event.startDateTime)}</span><span className="event-period-divider">~</span><span>{event.endTimeUnknown ? "종료 시점 미정" : formatDateTime(project, map, event.endDateTime)}</span></>}</div></StructuredInfoRow>
      {event.category !== "battle" && <StructuredInfoRow label="원인">{editMode ? <textarea value={event.cause} onChange={(changeEvent) => updateEvent({ cause: changeEvent.target.value })} /> : event.cause || "미정"}</StructuredInfoRow>}
      <StructuredInfoRow label="결과">{editMode ? <textarea value={event.result} onChange={(changeEvent) => updateEvent({ result: changeEvent.target.value })} /> : event.result || "미정"}</StructuredInfoRow>
      <StructuredInfoRow label="영향">{editMode ? <textarea value={event.impact} onChange={(changeEvent) => updateEvent({ impact: changeEvent.target.value })} /> : event.impact || "미정"}</StructuredInfoRow>
    </StructuredInfoPanel>
    <h3>개입 단체</h3>
    <div className="intervention-matrix-wrap intervention-view-matrix-wrap"><table className="intervention-matrix intervention-view-matrix"><tbody>
      {participantRows.map(([key, label], rowIndex) => <tr key={key}><th>{label}</th>{event.participants.slice(0, 4).map((participant) => <td key={participant.id}>{participantCell(participant, key)}</td>)}{editMode && event.participants.length < 4 && rowIndex === 0 && <td className="participant-add-cell" rowSpan={participantRows.length}><button type="button" title="개입 단체 추가" onClick={() => updateEvent({ participants: [...event.participants, { id: createId("participant"), organizationName: "", representativeLeaderName: "", otherLeaderArticleIds: [], otherLeaderNames: [], participationScale: "", cause: "", result: "", impact: "" }] })}>＋</button></td>}</tr>)}
    </tbody></table>{editMode && event.participants.length > 0 && <div className="participant-remove-row">{event.participants.slice(0,4).map((participant, index) => <button type="button" className="danger-ghost" key={participant.id} onClick={() => updateEvent({ participants: event.participants.filter((item) => item.id !== participant.id) })}>{index + 1}열 삭제</button>)}</div>}{event.participants.length === 0 && !editMode && <p className="empty-hint intervention-empty">기록된 개입 단체가 없습니다.</p>}</div>
    <div className="ownership-section-heading temporal-history-heading"><h4>연표</h4><button type="button" className="secondary-button" aria-expanded={chronologyOpen} onClick={() => editMode ? setChronologyOpenEdit((value) => !value) : setChronologyOpenRead((value) => !value)}>{chronologyOpen ? "접기" : "펼치기"}</button></div>
    {chronologyOpen && (editMode ? <div className="chronology-editor"><button type="button" className="secondary-button" onClick={() => updateEvent({ chronology: [...event.chronology, { id: createId("chronology"), dateTime: { year: event.startYear }, title: "새 기록", description: "" }] })}>＋ 연표 기록</button>{chronology.map((entry) => <div className="chronology-edit-card" key={entry.id}>{dateInput(entry.dateTime, (dateTime) => updateChronology(entry.id, { dateTime }))}<input placeholder="항목" value={entry.title} onChange={(changeEvent) => updateChronology(entry.id, { title: changeEvent.target.value })} /><textarea placeholder="내용" value={entry.description} onChange={(changeEvent) => updateChronology(entry.id, { description: changeEvent.target.value })} /><button type="button" className="danger-ghost" onClick={() => updateEvent({ chronology: event.chronology.filter((item) => item.id !== entry.id) })}>삭제</button></div>)}</div> : <div className="history-table-wrap"><table className="history-table event-chronology-table"><thead><tr><th>일시</th><th>항목</th><th>내용</th></tr></thead><tbody>{chronology.map((entry) => <tr key={entry.id}><td>{formatDateTime(project, map, entry.dateTime)}</td><td><strong>{entry.title || "-"}</strong></td><td>{entry.description || "-"}</td></tr>)}{chronology.length === 0 && <tr><td colSpan={3}>기록된 연표가 없습니다.</td></tr>}</tbody></table></div>)}
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

function MultiReferenceEditor({ label, options, value, onChange }: { label: string; options: Array<{ id: string; label: string }>; value: string[]; onChange: (value: string[]) => void }) {
  const [pendingId, setPendingId] = useState("");
  const available = options.filter((option) => !value.includes(option.id));
  return <div className="multi-reference-editor">
    <div className="multi-reference-add-row">
      <select aria-label={label} value={pendingId} onChange={(event) => setPendingId(event.target.value)}><option value="">추가할 문서 선택</option>{available.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select>
      <button type="button" className="secondary-button" disabled={!pendingId} onClick={() => { if (!pendingId) return; onChange([...value, pendingId]); setPendingId(""); }}>＋</button>
    </div>
    <div className="multi-reference-values">{value.map((id) => <span key={id}>{options.find((option) => option.id === id)?.label ?? "삭제된 문서"}<button type="button" title="연결 해제" onClick={() => onChange(value.filter((candidate) => candidate !== id))}>×</button></span>)}{value.length === 0 && <small>-</small>}</div>
  </div>;
}

function FactionHistory({ project, article, editMode, onProjectChange, onOpenArticle }: { project: WorldProject; article: WikiArticle; editMode: boolean; onProjectChange: (project: WorldProject) => void; onOpenArticle: (id: string) => void }) {
  const sourceMap = project.maps.find((item) => item.id === article.sourceMapId);
  const map = sourceMap ?? activeMap(project);
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
  const people = articles("person"); const religions = articles("religion"); const languages = articles("language"); const ideologies = articles("ideology"); const governments = articles("government"); const countries = articles("country").filter((item) => item.id !== article.id);
  const locationOptions = sortSelectionOptions(map.locations.map((entry) => ({ id: entry.id, label: getStateAtYear(entry.states, map.timeline.currentYear)?.name ?? "이름 없는 장소" })));
  const locationWikiId = (locationId?: string) => locationId ? project.wikiArticles.find((item) => item.sourceEntityType === "location" && item.sourceEntityId === locationId)?.id : undefined;
  const leaderStatus = faction.leaderStatus ?? (faction.leaderArticleId ? "selected" : faction.leaderName ? "custom" : "undecided");
  const country: CountryProfile = faction.countryProfile ?? { nameRoot: faction.name, showRegimeSuffix: true, spaceBeforeRegimeSuffix: true, politicalSystem: "", symbol: "", languageArticleIds: [], languageCustom: "", cultureArticleIds: [], majorLocationIds: [] };
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
    return state?.ownerFactionId === faction.id
      ? (state.parts?.length ? state.parts.map((part) => part.polygon) : [state.polygon]).filter((polygon) => polygon.length >= 3)
      : [];
  }) : [];
  const leaderText = leaderStatus === "none" ? "없음" : leaderStatus === "undecided" ? "미정" : faction.leaderArticleId ? undefined : faction.leaderName;
  const setLeader = ({ articleId, customText, mode }: { articleId?: string; customText?: string; mode: "selected" | "custom" | "undecided" | "none" }) => update({ leaderArticleId: articleId, leaderName: mode === "selected" ? people.find((item) => item.id === articleId)?.label : customText, leaderStatus: mode });
  const profileTitle = faction.kind === "country" ? "국가" : faction.kind === "organization" ? "단체" : "세력";

  if (faction.kind !== "country") {
    const scale = group.scale ?? "";
    const purpose = group.purpose ?? group.goals ?? "";
    const headquartersFallback = group.headquartersCustom ?? locationOptions.find((item) => item.id === group.headquartersLocationId)?.label;
    if (editMode) return <>
      <StructuredInfoPanel title={`${profileTitle} 정보`} className="faction-structured-info faction-edit-layout">
        <StructuredInfoRow label="창설 시기"><ActiveYearInput project={project} value={faction.foundedYear} onChange={(foundedYear) => update({ foundedYear })} /></StructuredInfoRow>
        <StructuredInfoRow label="해산 시기"><ActiveYearInput project={project} value={faction.dissolvedYear} placeholder="미지정" onChange={(dissolvedYear) => update({ dissolvedYear })} /></StructuredInfoRow>
        <StructuredInfoRow label="지도자"><ReferencePicker embedded label="지도자" options={people} articleId={faction.leaderArticleId} customText={leaderStatus === "custom" ? faction.leaderName : leaderStatus === "none" ? "없음" : undefined} onChange={setLeader} /></StructuredInfoRow>
        <StructuredInfoRow label="규모"><input value={scale} onChange={(event) => update({ groupProfile: { ...group, scale: event.target.value } })} /></StructuredInfoRow>
        <StructuredInfoRow label="본부"><ReferencePicker embedded label="본부" options={locationOptions} articleId={group.headquartersLocationId} customText={group.headquartersCustom || undefined} onChange={({articleId,customText,mode}) => update({ groupProfile: { ...group, headquartersLocationId: articleId, headquartersCustom: mode === "custom" ? customText : mode === "none" ? "없음" : undefined, headquartersStatus: mode } })} /></StructuredInfoRow>
        <StructuredInfoRow label="목적"><input value={purpose} onChange={(event) => update({ groupProfile: { ...group, purpose: event.target.value, goals: event.target.value } })} /></StructuredInfoRow>
        <StructuredInfoRow label="성향"><input value={group.alignment} onChange={(event) => update({ groupProfile: { ...group, alignment: event.target.value } })} /></StructuredInfoRow>
        <StructuredInfoRow label="사상"><ReferencePicker embedded label="사상" options={ideologies} articleId={group.ideologyArticleId} customText={group.ideology || undefined} onChange={({articleId,customText,mode}) => update({ groupProfile: { ...group, ideologyArticleId: articleId, ideology: mode === "custom" ? customText ?? "" : mode === "none" ? "없음" : "" } })} /></StructuredInfoRow>
      </StructuredInfoPanel>
      <section className="structured-wiki-panel faction-operational-settings"><div className="section-heading-row"><h3>표시·영토 설정</h3></div><div className="structured-read-grid">
        <StructuredInfoRow label="표시 색상"><input type="color" value={faction.color} onChange={(event) => update({ color: event.target.value })} /></StructuredInfoRow>
        <StructuredInfoRow label="활동 반경"><select value={faction.activityRange} onChange={(event) => update({ activityRange: event.target.value as Faction["activityRange"] })}>{Object.entries(ACTIVITY_RANGE_LABELS).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></StructuredInfoRow>
        <StructuredInfoRow label="영토"><div className="faction-territory-controls"><label className="checkbox-row"><input type="checkbox" checked={faction.hasTerritory === true} onChange={(event) => setTerritoryEnabled(event.target.checked)} /> 영토 부여</label><label className={`checkbox-row ${faction.hasTerritory !== true ? "disabled" : ""}`}><input type="checkbox" disabled={faction.hasTerritory !== true} checked={faction.territoryHidden === true} onChange={(event) => update({ territoryHidden: event.target.checked })} /> 영토 숨김</label></div></StructuredInfoRow>
        {faction.kind === "organization" && <StructuredInfoRow label="단체 유형"><select value={faction.organizationType ?? "general"} onChange={(event) => update({ organizationType: event.target.value as OrganizationType })}><option value="general">일반 단체</option><option value="order">교단</option><option value="merchant_guild">상단</option><option value="mercenary_company">용병단</option><option value="assassin_guild">암살단</option><option value="knight_order">기사단</option></select></StructuredInfoRow>}
      </div></section>
      <section className="structured-wiki-panel faction-heraldry-section"><HeraldryEditorFields project={project} displayFlag={faction.displayFlag} displayCoat={faction.displayCoatOfArms} flagAssetId={faction.flagAssetId} coatAssetId={faction.coatOfArmsAssetId} onChange={(patch) => update(patch)} /></section>
      <CollapsiblePopulationEconomyChart points={metrics} editMode className="faction-metric-section" />
    </>;
    return <><HeraldryDisplay project={project} territoryPolygons={territoryPolygons} territoryColor={faction.color} showFlag={faction.displayFlag} showCoat={faction.displayCoatOfArms} flagAssetId={faction.flagAssetId} coatAssetId={faction.coatOfArmsAssetId} /><StructuredInfoPanel title={`${profileTitle} 정보`} className="faction-structured-info">
      <StructuredInfoRow label="창설 시기">{faction.foundedYear === undefined ? "-" : projectYearLabel(project, faction.foundedYear)}</StructuredInfoRow>
      <StructuredInfoRow label="해산 시기">{faction.dissolvedYear === undefined ? "-" : projectYearLabel(project, faction.dissolvedYear)}</StructuredInfoRow>
      <StructuredInfoRow label="지도자"><WikiInlineLink project={project} articleId={faction.leaderArticleId} fallback={leaderText === "미정" ? "-" : leaderText} onOpenArticle={onOpenArticle} /></StructuredInfoRow>
      <StructuredInfoRow label="규모">{scale || "-"}</StructuredInfoRow>
      <StructuredInfoRow label="본부"><WikiInlineLink project={project} articleId={locationWikiId(group.headquartersLocationId)} fallback={headquartersFallback || "-"} onOpenArticle={onOpenArticle} /></StructuredInfoRow>
      <StructuredInfoRow label="목적">{purpose || "-"}</StructuredInfoRow>
      <StructuredInfoRow label="성향">{group.alignment || "-"}</StructuredInfoRow>
      <StructuredInfoRow label="사상"><WikiInlineLink project={project} articleId={group.ideologyArticleId} fallback={group.ideology || "-"} onOpenArticle={onOpenArticle} /></StructuredInfoRow>
    </StructuredInfoPanel><CollapsiblePopulationEconomyChart points={metrics} editMode={false} className="faction-metric-section" /></>;
  }

  const capitalPeriods = country.capitalPeriods ?? (country.capitalLocationId ? [{ id: "legacy-capital", locationId: country.capitalLocationId, customName: country.capitalCustom }] : []);
  const updateCountry = (patch: Partial<CountryProfile>) => update({ countryProfile: { ...country, ...patch } });
  const updateCapital = (id: string, patch: Partial<CountryCapitalPeriod>) => updateCountry({ capitalPeriods: capitalPeriods.map((entry) => entry.id === id ? { ...entry, ...patch } : entry) });
  const referenceLinks = (ids: string[], fallback?: string) => ids.length ? ids.map((id, index) => <span key={id}>{index > 0 && ", "}<WikiInlineLink project={project} articleId={id} onOpenArticle={onOpenArticle} /></span>) : <>{fallback || "-"}</>;
  const capitalDisplay = [...capitalPeriods].sort((a, b) => (a.startYear ?? Number.NEGATIVE_INFINITY) - (b.startYear ?? Number.NEGATIVE_INFINITY)).map((entry) => {
    const label = entry.customName || locationOptions.find((item) => item.id === entry.locationId)?.label || "-";
    const period = entry.startYear === undefined && entry.endYear === undefined ? "기간 미정" : `${entry.startYear === undefined ? "?" : projectYearLabel(project, entry.startYear)} ~ ${entry.endYear === undefined ? "현재" : projectYearLabel(project, entry.endYear)}`;
    return <div className="country-capital-record" key={entry.id}><WikiInlineLink project={project} articleId={locationWikiId(entry.locationId)} fallback={label} onOpenArticle={onOpenArticle} /><small>{period}</small></div>;
  });
  const transitionColumn = (title: string, ids: string[]) => <div className="country-transition-column"><h4>{title}</h4><div className="country-transition-list">{ids.map((id) => {
    const linked = project.wikiArticles.find((candidate) => candidate.id === id);
    const flagId = heraldryFlagIdForArticle(project, linked);
    const flag = project.heraldicAssets.find((asset) => asset.id === flagId && asset.kind === "flag");
    return <button type="button" className="country-transition-card" key={id} onClick={() => onOpenArticle(id)}>{flag && <HeraldicPreview asset={flag} className="country-transition-heraldry" />}<span>{linked?.title ?? "삭제된 문서"}</span></button>;
  })}{ids.length === 0 && <span className="empty-hint">-</span>}</div></div>;

  if (editMode) return <>
    <StructuredInfoPanel title="국가 정보" className="faction-structured-info faction-edit-layout">
      <StructuredInfoRow label="건국 시기"><ActiveYearInput project={project} value={faction.foundedYear} onChange={(foundedYear) => update({ foundedYear })} /></StructuredInfoRow>
      <StructuredInfoRow label="멸망 시기"><ActiveYearInput project={project} value={faction.dissolvedYear} placeholder="현재 존속" onChange={(dissolvedYear) => update({ dissolvedYear })} /></StructuredInfoRow>
      <StructuredInfoRow label="위치"><MultiReferenceEditor label="국가 위치" options={locationOptions} value={country.locationIds ?? []} onChange={(locationIds) => updateCountry({ locationIds })} /><input className="country-reference-custom" placeholder="직접 입력 위치" value={country.locationCustom ?? ""} onChange={(event) => updateCountry({ locationCustom: event.target.value })} /></StructuredInfoRow>
      <StructuredInfoRow label="수도"><div className="country-capital-editor"><button type="button" className="secondary-button" onClick={() => updateCountry({ capitalPeriods: [...capitalPeriods, { id: createId("capital-period") }] })}>＋ 수도 기록</button>{capitalPeriods.map((entry, index) => <div className="country-capital-edit-record" key={entry.id}><div className="country-capital-edit-heading"><strong>수도 {index + 1}</strong><button type="button" className="danger-ghost" title="수도 기록 삭제" onClick={() => updateCountry({ capitalPeriods: capitalPeriods.filter((candidate) => candidate.id !== entry.id) })}>×</button></div><ReferencePicker embedded label={`수도 ${index + 1}`} options={locationOptions} articleId={entry.locationId} customText={entry.customName} onChange={({articleId,customText,mode}) => updateCapital(entry.id, { locationId: articleId, customName: mode === "custom" ? customText : mode === "none" ? "없음" : undefined })} /><div className="country-capital-date-row"><label>시작<ActiveYearInput project={project} value={entry.startYear} placeholder="미정" onChange={(startYear) => updateCapital(entry.id, { startYear })} /></label><label>종료<ActiveYearInput project={project} value={entry.endYear} placeholder="현재" onChange={(endYear) => updateCapital(entry.id, { endYear })} /></label></div></div>)}</div></StructuredInfoRow>
      <StructuredInfoRow label="정치 체제"><ReferencePicker embedded label="정치 체제" options={governments} articleId={country.politicalSystemArticleId} customText={country.politicalSystem || undefined} onChange={({articleId,customText,mode}) => { const nextSuffix = articleId ? project.wikiArticles.find((candidate) => candidate.id === articleId)?.governmentProfile?.countryNameSuffix ?? "" : ""; update({ name: composeCountryName(inferredRoot, nextSuffix), countryProfile: { ...country, nameRoot: inferredRoot, politicalSystemArticleId: articleId, politicalSystem: mode === "custom" ? customText ?? "" : mode === "none" ? "없음" : "" } }); }} /></StructuredInfoRow>
      <StructuredInfoRow label="국가원수"><ReferencePicker embedded label="국가원수" options={people} articleId={country.headOfStateArticleId} customText={country.headOfStateCustom} onChange={({articleId,customText,mode}) => updateCountry({ headOfStateArticleId: articleId, headOfStateCustom: mode === "custom" ? customText : mode === "none" ? "없음" : undefined })} /></StructuredInfoRow>
      <StructuredInfoRow label="현 지도자"><ReferencePicker embedded label="현 지도자" options={people} articleId={faction.leaderArticleId} customText={leaderStatus === "custom" ? faction.leaderName : leaderStatus === "none" ? "없음" : undefined} onChange={setLeader} /></StructuredInfoRow>
      <StructuredInfoRow label="언어"><MultiReferenceEditor label="국가 언어" options={languages} value={country.languageArticleIds} onChange={(languageArticleIds) => updateCountry({ languageArticleIds })} /></StructuredInfoRow>
      <StructuredInfoRow label="종교"><MultiReferenceEditor label="국가 종교" options={religions} value={country.religionArticleIds ?? []} onChange={(religionArticleIds) => updateCountry({ religionArticleIds })} /></StructuredInfoRow>
    </StructuredInfoPanel>
    <section className="structured-wiki-panel country-transition-panel"><div className="section-heading-row"><h3>성립 전후</h3></div><div className="country-transition-edit-grid"><MultiReferenceEditor label="성립 이전" options={countries} value={country.predecessorArticleIds ?? []} onChange={(predecessorArticleIds) => updateCountry({ predecessorArticleIds })} /><MultiReferenceEditor label="멸망 이후" options={countries} value={country.successorArticleIds ?? []} onChange={(successorArticleIds) => updateCountry({ successorArticleIds })} /></div></section>
    <section className="structured-wiki-panel faction-operational-settings"><div className="section-heading-row"><h3>국명·표시 설정</h3></div><div className="structured-read-grid"><StructuredInfoRow label="국명"><div className="country-name-editor-row"><div><input aria-label="국가 고유명" value={inferredRoot} onChange={(event) => { const nameRoot = event.target.value; const nextProfile = { ...country, nameRoot }; update({ name: composeCountryName(nameRoot, suffix, nextProfile), countryProfile: nextProfile }); }} /><small>현재 표시: {composeCountryName(inferredRoot) || "미정"}</small></div><div className="country-suffix-options"><label><input type="checkbox" checked={country.showRegimeSuffix !== false} onChange={(event) => { const nextProfile = { ...country, nameRoot: inferredRoot, showRegimeSuffix: event.target.checked }; update({ name: composeCountryName(inferredRoot, suffix, nextProfile), countryProfile: nextProfile }); }} /> 접미사 표시</label><label><input type="checkbox" checked={country.spaceBeforeRegimeSuffix !== false} onChange={(event) => { const nextProfile = { ...country, nameRoot: inferredRoot, spaceBeforeRegimeSuffix: event.target.checked }; update({ name: composeCountryName(inferredRoot, suffix, nextProfile), countryProfile: nextProfile }); }} /> 접미사 띄어쓰기</label></div></div></StructuredInfoRow><StructuredInfoRow label="표시 색상"><input type="color" value={faction.color} onChange={(event) => update({ color: event.target.value })} /></StructuredInfoRow><StructuredInfoRow label="활동 반경"><select value={faction.activityRange} onChange={(event) => update({ activityRange: event.target.value as Faction["activityRange"] })}>{Object.entries(ACTIVITY_RANGE_LABELS).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></StructuredInfoRow></div></section>
    <section className="structured-wiki-panel faction-heraldry-section"><HeraldryEditorFields project={project} displayFlag={faction.displayFlag} displayCoat={faction.displayCoatOfArms} flagAssetId={faction.flagAssetId} coatAssetId={faction.coatOfArmsAssetId} onChange={(patch) => update(patch)} /></section>
    <CollapsiblePopulationEconomyChart points={metrics} editMode className="faction-metric-section" />
  </>;

  return <><HeraldryDisplay project={project} territoryPolygons={territoryPolygons} territoryColor={faction.color} showFlag={faction.displayFlag} showCoat={faction.displayCoatOfArms} flagAssetId={faction.flagAssetId} coatAssetId={faction.coatOfArmsAssetId} /><StructuredInfoPanel title="국가 정보" className="faction-structured-info">
    <StructuredInfoRow label="건국 시기">{faction.foundedYear === undefined ? "-" : projectYearLabel(project, faction.foundedYear)}</StructuredInfoRow>
    <StructuredInfoRow label="멸망 시기">{faction.dissolvedYear === undefined ? "-" : projectYearLabel(project, faction.dissolvedYear)}</StructuredInfoRow>
    <StructuredInfoRow label="위치">{(country.locationIds ?? []).length ? (country.locationIds ?? []).map((id, index) => <span key={id}>{index > 0 && ", "}<WikiInlineLink project={project} articleId={locationWikiId(id)} fallback={locationOptions.find((item) => item.id === id)?.label} onOpenArticle={onOpenArticle} /></span>) : country.locationCustom || "-"}</StructuredInfoRow>
    <StructuredInfoRow label="수도"><div className="country-capital-list">{capitalDisplay.length ? capitalDisplay : "-"}</div></StructuredInfoRow>
    <StructuredInfoRow label="정치 체제"><WikiInlineLink project={project} articleId={country.politicalSystemArticleId} fallback={country.politicalSystem || "-"} onOpenArticle={onOpenArticle} /></StructuredInfoRow>
    <StructuredInfoRow label="국가원수"><WikiInlineLink project={project} articleId={country.headOfStateArticleId} fallback={country.headOfStateCustom || "-"} onOpenArticle={onOpenArticle} /></StructuredInfoRow>
    <StructuredInfoRow label="현 지도자"><WikiInlineLink project={project} articleId={faction.leaderArticleId} fallback={leaderText === "미정" ? "-" : leaderText} onOpenArticle={onOpenArticle} /></StructuredInfoRow>
    <StructuredInfoRow label="언어">{referenceLinks(country.languageArticleIds, country.languageCustom)}</StructuredInfoRow>
    <StructuredInfoRow label="종교">{referenceLinks(country.religionArticleIds ?? [], country.stateReligionCustom)}</StructuredInfoRow>
  </StructuredInfoPanel><section className="structured-wiki-panel country-transition-panel"><div className="section-heading-row"><h3>성립 전후</h3></div><div className="country-transition-grid">{transitionColumn("성립 이전", country.predecessorArticleIds ?? [])}{transitionColumn("멸망 이후", country.successorArticleIds ?? [])}</div></section><CollapsiblePopulationEconomyChart points={metrics} editMode={false} className="faction-metric-section" /></>;
}

export function LinkedEntityHistory({ project, article, editMode, onProjectChange, onOpenArticle }: { project: WorldProject; article: WikiArticle; editMode: boolean; onProjectChange: (project: WorldProject) => void; onOpenArticle: (id: string) => void }) {
  if (article.eventProfile || article.sourceEntityType === "event") return <EventHistory project={project} article={article} editMode={editMode} onProjectChange={onProjectChange} />;
  if (article.factionProfile || article.sourceEntityType === "faction") return <FactionHistory project={project} article={article} editMode={editMode} onProjectChange={onProjectChange} onOpenArticle={onOpenArticle} />;
  if (!article.sourceMapId || !article.sourceEntityId || !article.sourceEntityType) return null; const map = project.maps.find((item) => item.id === article.sourceMapId); if (!map) return null;
  if (article.sourceEntityType === "location") { const location = map.locations.find((item) => item.id === article.sourceEntityId); return location ? <LocationHistory project={project} article={article} location={location} editMode={editMode} onProjectChange={onProjectChange} /> : null; }
  const territory = map.territories.find((item) => item.id === article.sourceEntityId); if (!territory) return null; return <section className="linked-history-section"><h3>시대별 영토 기록</h3><div className="history-table-wrap"><table className="history-table"><thead><tr><th>적용 시기</th><th>소유 세력</th><th>경계점 수</th><th>설명</th></tr></thead><tbody>{[...territory.states].sort((a, b) => a.startYear - b.startYear).map((state) => <tr key={`${state.startYear}-${state.endYear ?? "now"}`}><td>{yearRange(project, state.startYear, state.endYear)}</td><td>{map.factions.find((faction) => faction.id === state.value.ownerFactionId)?.name ?? "없음"}</td><td>{state.value.polygon.length}</td><td>{state.value.description || "-"}</td></tr>)}</tbody></table></div></section>;
}
