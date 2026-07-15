import { useEffect, useMemo, useRef, useState } from "react";
import {
  EVENT_CATEGORY_LABELS,
  formatTimelineMoment,
  standardDayOfYear,
  type HistoricalDateTime,
  type MapData,
  type WikiArticle,
  type WikiCategory,
  type WorldEvent,
  type WorldProject,
} from "../model/world";

type Props = {
  project: WorldProject;
  map: MapData;
  onYearChange: (year: number) => void;
  onOpenWikiArticle: (article: WikiArticle) => void;
};

type TimelineCategory = "events" | "country" | "faction" | "organization" | "location" | "person";
type TimelineItem = {
  id: string;
  year: number;
  category: TimelineCategory;
  title: string;
  change: string;
  sourceLabel: string;
  eventId?: string;
  articleId?: string;
  description?: string;
};

const TIMELINE_LABELS: Record<TimelineCategory, string> = {
  events: "사건·사고",
  country: "국가",
  faction: "세력",
  organization: "단체",
  location: "장소",
  person: "인물",
};

const WIKI_LABELS: Partial<Record<WikiCategory, string>> = {
  country: "국가",
  faction: "세력",
  organization: "단체",
  order: "교단",
  merchant_guild: "상단",
  mercenary_company: "용병단",
  assassin_guild: "암살단",
  knight_order: "기사단",
  city: "도시",
  village: "마을",
  fortress: "요새",
  base: "거점",
  location: "장소",
  person: "인물",
  event: "사건",
  accident: "사고",
  war: "전쟁",
  battle: "전투",
};

function chronologyValue(dateTime: HistoricalDateTime): number {
  return (((((dateTime.year * 13) + (dateTime.month ?? 0)) * 32 + (dateTime.day ?? 0)) * 24 + (dateTime.hour ?? 0)) * 60) + (dateTime.minute ?? 0);
}

function formatWorldYear(project: WorldProject, map: MapData, year: number): string {
  return formatTimelineMoment(project, { ...map.timeline, currentYear: year, currentDayOfYear: 0, currentMinuteOfDay: 0, precision: "year" });
}

function formatDateTime(project: WorldProject, map: MapData, dateTime: HistoricalDateTime | null, unknown = false): string {
  if (unknown) return "시작 시점 미정";
  if (!dateTime) return "종료 시점 미정";
  const precision = dateTime.hour !== undefined ? "time" : dateTime.month !== undefined || dateTime.day !== undefined ? "date" : "year";
  return formatTimelineMoment(project, {
    ...map.timeline,
    currentYear: dateTime.year,
    currentDayOfYear: standardDayOfYear(project, dateTime.month ?? 1, dateTime.day ?? 1),
    currentMinuteOfDay: (dateTime.hour ?? 0) * 60 + (dateTime.minute ?? 0),
    precision,
  });
}

function categoryForFaction(kind: "country" | "faction" | "organization"): TimelineCategory {
  return kind === "country" ? "country" : kind === "organization" ? "organization" : "faction";
}

function articleLabel(project: WorldProject, article: WikiArticle | undefined, fallback: string): string {
  if (!article) return fallback;
  const definition = article.categoryId ? project.wikiCategories.find((item) => item.id === article.categoryId) : undefined;
  return definition?.name ?? WIKI_LABELS[article.category] ?? fallback;
}

function eventArticle(project: WorldProject, eventId: string): WikiArticle | undefined {
  return project.wikiArticles.find((article) => article.sourceEntityType === "event" && article.sourceEntityId === eventId);
}

function buildTimeline(project: WorldProject, map: MapData): TimelineItem[] {
  const items: TimelineItem[] = [];
  for (const event of map.events) {
    const article = eventArticle(project, event.id);
    const label = articleLabel(project, article, EVENT_CATEGORY_LABELS[event.category]);
    if (!event.startTimeUnknown) {
      items.push({ id: `event-start-${event.id}`, year: event.startDateTime.year, category: "events", title: `${event.title} 시작`, change: EVENT_CATEGORY_LABELS[event.category], sourceLabel: label, eventId: event.id, articleId: article?.id, description: event.description });
    }
    if (event.endDateTime) {
      items.push({ id: `event-end-${event.id}`, year: event.endDateTime.year, category: "events", title: `${event.title} 종료`, change: EVENT_CATEGORY_LABELS[event.category], sourceLabel: label, eventId: event.id, articleId: article?.id, description: event.description });
    }
    for (const entry of event.chronology) {
      items.push({ id: `event-log-${event.id}-${entry.id}`, year: entry.dateTime.year, category: "events", title: entry.title || event.title, change: event.title, sourceLabel: label, eventId: event.id, articleId: article?.id, description: entry.description });
    }
  }

  for (const faction of map.factions) {
    const category = categoryForFaction(faction.kind);
    const article = project.wikiArticles.find((item) => item.sourceEntityType === "faction" && item.sourceEntityId === faction.id);
    const label = articleLabel(project, article, TIMELINE_LABELS[category]);
    if (typeof faction.foundedYear === "number") items.push({ id: `faction-founded-${faction.id}`, year: faction.foundedYear, category, title: `${faction.name} ${faction.kind === "country" ? "건국" : "창설"}`, change: faction.kind === "country" ? "건국" : "창설", sourceLabel: label, articleId: article?.id, description: faction.summary });
    if (typeof faction.dissolvedYear === "number") items.push({ id: `faction-dissolved-${faction.id}`, year: faction.dissolvedYear, category, title: `${faction.name} ${faction.kind === "country" ? "멸망" : "해체"}`, change: faction.kind === "country" ? "멸망" : "해체", sourceLabel: label, articleId: article?.id, description: faction.description });
  }

  for (const location of map.locations) {
    const article = project.wikiArticles.find((item) => item.sourceEntityType === "location" && item.sourceEntityId === location.id);
    const states = [...location.states].sort((a, b) => a.startYear - b.startYear);
    if (!states.length) continue;
    const first = states[0];
    const last = states[states.length - 1];
    const label = articleLabel(project, article, "장소");
    items.push({ id: `location-founded-${location.id}`, year: first.startYear, category: "location", title: `${first.value.name} 설립`, change: "설립", sourceLabel: label, articleId: article?.id, description: first.value.description });
    for (const state of states.slice(1)) items.push({ id: `location-change-${location.id}-${state.startYear}`, year: state.startYear, category: "location", title: `${state.value.name} 상태 변경`, change: state.value.status, sourceLabel: label, articleId: article?.id, description: state.value.description });
    if (last.endYear !== null) items.push({ id: `location-ended-${location.id}`, year: last.endYear, category: "location", title: `${last.value.name} 멸망·폐지`, change: "멸망·폐지", sourceLabel: label, articleId: article?.id, description: last.value.description });
  }

  for (const article of project.wikiArticles) {
    if (!article.personProfile) continue;
    const label = articleLabel(project, article, "인물");
    if (typeof article.personProfile.birthYear === "number") items.push({ id: `person-birth-${article.id}`, year: article.personProfile.birthYear, category: "person", title: `${article.title} 출생`, change: "출생", sourceLabel: label, articleId: article.id, description: article.summary });
    if (typeof article.personProfile.deathYear === "number") items.push({ id: `person-death-${article.id}`, year: article.personProfile.deathYear, category: "person", title: `${article.title} 사망`, change: "사망", sourceLabel: label, articleId: article.id, description: article.summary });
  }

  return items.sort((a, b) => a.year - b.year || a.title.localeCompare(b.title, "ko"));
}

export function HistoryWindow({ project, map, onYearChange, onOpenWikiArticle }: Props) {
  const [enabled, setEnabled] = useState<Set<TimelineCategory>>(() => new Set(Object.keys(TIMELINE_LABELS) as TimelineCategory[]));
  const timeline = useMemo(() => buildTimeline(project, map), [project, map]);
  const visibleTimeline = timeline.filter((item) => enabled.has(item.category));
  const unknownEvents = useMemo(() => map.events.filter((event) => event.startTimeUnknown), [map.events]);
  const [selectedId, setSelectedId] = useState<string | null>(visibleTimeline[0]?.id ?? null);
  const selectionTimerRef = useRef<number | null>(null);
  useEffect(() => () => { if (selectionTimerRef.current !== null) window.clearTimeout(selectionTimerRef.current); }, []);
  const selected = timeline.find((item) => item.id === selectedId) ?? null;
  const selectedEvent: WorldEvent | null = selected?.eventId ? map.events.find((event) => event.id === selected.eventId) ?? null : null;
  const selectedArticle = selected?.articleId ? project.wikiArticles.find((article) => article.id === selected.articleId) : undefined;
  const toggleCategory = (category: TimelineCategory) => setEnabled((current) => {
    const next = new Set(current);
    if (next.has(category)) next.delete(category); else next.add(category);
    return next;
  });

  const activateTimelineItem = (item: TimelineItem) => {
    if (selectionTimerRef.current !== null) window.clearTimeout(selectionTimerRef.current);
    selectionTimerRef.current = window.setTimeout(() => { setSelectedId(item.id); onYearChange(item.year); }, 100);
  };

  const selectUnknownEvent = (event: WorldEvent) => {
    if (selectionTimerRef.current !== null) window.clearTimeout(selectionTimerRef.current);
    selectionTimerRef.current = window.setTimeout(() => { const article = eventArticle(project, event.id); setSelectedId(null); if (article) onOpenWikiArticle(article); }, 100);
  };

  return (
    <section className="history-window history-readonly">
      <aside className="history-list-panel">
        <div className="window-heading compact"><p className="eyebrow">CHRONICLE</p><h2>연표</h2><p>각 문서의 생몰·건국·멸망·설립 기록과 사건 문서를 한 흐름으로 열람합니다.</p></div>
        <div className="timeline-category-toggles">{(Object.keys(TIMELINE_LABELS) as TimelineCategory[]).map((category) => <button type="button" key={category} className={enabled.has(category) ? "active" : ""} onClick={() => toggleCategory(category)}>{TIMELINE_LABELS[category]}</button>)}</div>
        <div className="chronicle-entry-list">
          {visibleTimeline.map((item) => <button type="button" className={selectedId === item.id ? "active" : ""} key={item.id} onClick={() => activateTimelineItem(item)}><time>{formatWorldYear(project, map, item.year)}</time><span>{item.title}</span><small>{item.sourceLabel}</small></button>)}
          {visibleTimeline.length === 0 && <p className="empty-hint">표시할 연표 기록이 없습니다.</p>}
        </div>
        {unknownEvents.length > 0 && <section className="timeline-unknown-panel"><div><p className="eyebrow">UNKNOWN DATE</p><h3>시점 미정 사건</h3></div>{unknownEvents.map((event) => <button type="button" key={event.id} onClick={() => selectUnknownEvent(event)}><span>{event.title}</span><small>{EVENT_CATEGORY_LABELS[event.category]}</small></button>)}</section>}
      </aside>

      <article className="chronicle-reader">
        {selected ? <>
          <header className="chronicle-reader-heading"><div><p className="eyebrow">{formatWorldYear(project, map, selected.year)}</p><h2>{selected.title}</h2><span>{selected.sourceLabel} · {selected.change}</span></div>{selectedArticle && <button type="button" className="secondary-button" onClick={() => onOpenWikiArticle(selectedArticle)}>원본 문서 열기</button>}</header>
          <section className="chronicle-read-card"><dl><div><dt>연도</dt><dd>{formatWorldYear(project, map, selected.year)}</dd></div><div><dt>카테고리</dt><dd>{selected.sourceLabel}</dd></div><div><dt>변경 유형</dt><dd>{selected.change}</dd></div></dl><p>{selected.description || "추가 설명이 없습니다."}</p></section>
          {selectedEvent && <>
            <section className="chronicle-read-card"><h3>사건 정보</h3><dl><div><dt>분류</dt><dd>{EVENT_CATEGORY_LABELS[selectedEvent.category]}</dd></div><div><dt>시작</dt><dd>{formatDateTime(project, map, selectedEvent.startDateTime, selectedEvent.startTimeUnknown)}</dd></div><div><dt>종료</dt><dd>{selectedEvent.endTimeUnknown ? "종료 시점 미정" : formatDateTime(project, map, selectedEvent.endDateTime)}</dd></div></dl><p>{selectedEvent.description || "사건 개요가 없습니다."}</p></section>
            {selectedEvent.participants.length > 0 && <section className="chronicle-read-card"><h3>대상</h3><div className="chronicle-participant-list">{selectedEvent.participants.map((participant) => <article key={participant.id}><strong>{participant.organizationName || "이름 없는 대상"}</strong><span>{participant.keyFigures || "주요 인물 미정"}</span><p>{participant.result || participant.cause || "기록 없음"}</p></article>)}</div></section>}
            {selectedEvent.chronology.length > 0 && <section className="chronicle-read-card"><h3>세부 기록</h3><div className="chronicle-subentries">{[...selectedEvent.chronology].sort((a, b) => chronologyValue(a.dateTime) - chronologyValue(b.dateTime)).map((entry) => <div key={entry.id}><time>{formatDateTime(project, map, entry.dateTime)}</time><strong>{entry.title}</strong><p>{entry.description || "-"}</p></div>)}</div></section>}
          </>}
        </> : <div className="empty-document"><strong>연표 항목을 선택하세요.</strong><p>연표에서는 모든 기록을 열람만 하며, 수정은 원본 문서의 편집 버튼에서 진행합니다.</p></div>}
      </article>
    </section>
  );
}
