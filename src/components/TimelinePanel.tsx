import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  activeCalendarFieldsFromTimeline,
  calendarArticles,
  formatTimelineMoment,
  standardDayOfYear,
  standardMonthDay,
  timelineAbsoluteMinute,
  timelineAtRangePercent,
  timelineFromAbsoluteMinute,
  timelineFromActiveCalendarFields,
  timelineRangePercent,
  worldDayLengthMinutes,
  worldYearLengthDays,
  type TimelinePrecision,
  type TimelineState,
  type WorldProject,
} from "../model/world";
import { useLocalization } from "../localization/LocalizationProvider";

type PlaybackInterval = TimelineState["playbackIntervalMs"];

type Props = {
  project: WorldProject;
  timeline: TimelineState;
  minimumYear: number;
  maximumYear: number;
  eventYears?: number[];
  onTimelineChange: (timeline: TimelineState) => void;
  onPlayToggle: () => void;
  onSpeedChange: (intervalMs: PlaybackInterval) => void;
  onCalendarChange: (articleId: string | null) => void;
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
};

const speedValues: PlaybackInterval[] = [100, 200, 333, 500, 1000];
const precisionOrder: TimelinePrecision[] = ["year", "month", "date", "time"];
const precisionUnit = {
  ko: { year: "년", month: "월", week: "주", date: "일", time: "분" },
  en: { year: "year", month: "month", week: "week", date: "day", time: "minute" },
} satisfies Record<"ko" | "en", Record<TimelinePrecision, string>>;
const precisionLabel = {
  ko: { year: "연도", month: "월", week: "주", date: "일", time: "시각" },
  en: { year: "Year", month: "Month", week: "Week", date: "Day", time: "Time" },
} satisfies Record<"ko" | "en", Record<TimelinePrecision, string>>;

function speedLabel(value: PlaybackInterval, precision: TimelinePrecision, language: "ko" | "en"): string {
  const fraction = value === 100 ? "1/10" : value === 200 ? "1/5" : value === 333 ? "1/3" : value === 500 ? "1/2" : "1";
  if (language === "en") return `1 ${precisionUnit.en[precision]} per ${fraction} sec`;
  return `${fraction}초당 1${precisionUnit.ko[precision]}`;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function floorDiv(value: number, divisor: number): number {
  return Math.floor(value / divisor);
}

function addMonths(project: WorldProject, timeline: TimelineState, months: number): TimelineState {
  const currentMonth = standardMonthDay(project, timeline.currentDayOfYear).month;
  const monthIndex = timeline.currentYear * 12 + currentMonth - 1 + months;
  const year = floorDiv(monthIndex, 12);
  const month = ((monthIndex % 12) + 12) % 12 + 1;
  return {
    ...timeline,
    currentYear: year,
    currentDayOfYear: standardDayOfYear(project, month, 1),
    currentMinuteOfDay: 0,
    isPlaying: false,
  };
}

function halfWindowMinutes(project: WorldProject, precision: TimelinePrecision): number {
  const yearMinutes = worldYearLengthDays(project) * worldDayLengthMinutes(project);
  const dayMinutes = worldDayLengthMinutes(project);
  if (precision === "month") return yearMinutes * 10;
  if (precision === "week") return yearMinutes;
  if (precision === "date") return Math.max(dayMinutes, Math.round(worldYearLengthDays(project) / 12) * dayMinutes);
  if (precision === "time") return dayMinutes;
  return yearMinutes;
}

function shiftedTimeline(project: WorldProject, base: TimelineState, ratio: number): TimelineState {
  const bounded = clamp(ratio, -1, 1);
  if (base.precision === "month") return addMonths(project, base, Math.round(bounded * 120));
  const dayLength = worldDayLengthMinutes(project);
  const yearLength = worldYearLengthDays(project);
  const shift = base.precision === "week"
    ? Math.round(bounded * Math.max(1, Math.round(yearLength / 7))) * dayLength * 7
    : base.precision === "date"
      ? Math.round(bounded * Math.max(1, Math.round(yearLength / 12))) * dayLength
      : Math.round(bounded * dayLength);
  return {
    ...timelineFromAbsoluteMinute(project, timelineAbsoluteMinute(project, base) + shift, base),
    isPlaying: false,
  };
}

function snapForPrecision(project: WorldProject, timeline: TimelineState): TimelineState {
  if (timeline.precision === "year") return { ...timeline, currentDayOfYear: 0, currentMinuteOfDay: 0 };
  if (timeline.precision === "month") {
    const month = standardMonthDay(project, timeline.currentDayOfYear).month;
    return { ...timeline, currentDayOfYear: standardDayOfYear(project, month, 1), currentMinuteOfDay: 0 };
  }
  if (timeline.precision === "week") return { ...timeline, currentDayOfYear: Math.floor(timeline.currentDayOfYear / 7) * 7, currentMinuteOfDay: 0 };
  if (timeline.precision === "date") return { ...timeline, currentMinuteOfDay: 0 };
  return timeline;
}

export function TimelinePanel({ project, timeline, minimumYear, maximumYear, eventYears = [], onTimelineChange, onPlayToggle, onSpeedChange, onCalendarChange, collapsed = false, onCollapsedChange }: Props) {
  const { language } = useLocalization();
  const labels = precisionLabel[language];
  const calendars = calendarArticles(project);
  const selectedCalendar = calendars.find((article) => article.id === project.timelineCalendarArticleId) ?? null;
  const [yearDraftPercent, setYearDraftPercent] = useState<number | null>(null);
  const [dragRatio, setDragRatio] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [springing, setSpringing] = useState(false);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const dragBaseRef = useRef<TimelineState>(timeline);
  const dragRatioRef = useRef(0);
  const springTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (springTimerRef.current !== null) window.clearTimeout(springTimerRef.current);
  }, []);

  const isAnnual = timeline.precision === "year";
  const actualPosition = timelineRangePercent(project, timeline, minimumYear, maximumYear);
  const previewTimeline = yearDraftPercent === null
    ? timeline
    : snapForPrecision(project, timelineAtRangePercent(project, timeline, minimumYear, maximumYear, yearDraftPercent));
  const displayTimeline = !isAnnual && dragging
    ? shiftedTimeline(project, dragBaseRef.current, dragRatio)
    : previewTimeline;
  const calendarFields = activeCalendarFieldsFromTimeline(project, timeline, selectedCalendar);
  const halfSpan = halfWindowMinutes(project, timeline.precision);

  const endpoints = useMemo(() => {
    if (isAnnual) {
      const make = (year: number) => formatTimelineMoment(project, { ...displayTimeline, currentYear: year, currentDayOfYear: 0, currentMinuteOfDay: 0, precision: "year" }, selectedCalendar);
      return [make(minimumYear), make(maximumYear)] as const;
    }
    const center = timelineAbsoluteMinute(project, displayTimeline);
    const left = timelineFromAbsoluteMinute(project, center - halfSpan, displayTimeline);
    const right = timelineFromAbsoluteMinute(project, center + halfSpan, displayTimeline);
    return [formatTimelineMoment(project, left, selectedCalendar), formatTimelineMoment(project, right, selectedCalendar)] as const;
  }, [project, displayTimeline, selectedCalendar, isAnnual, halfSpan, minimumYear, maximumYear]);

  const ratioFromPointer = (clientX: number): number => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return 0;
    return clamp((clientX - (rect.left + rect.width / 2)) / (rect.width / 2), -1, 1);
  };

  const updateElasticPosition = (clientX: number) => {
    const ratio = ratioFromPointer(clientX);
    dragRatioRef.current = ratio;
    setDragRatio(ratio);
  };

  const beginElasticDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (isAnnual) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragBaseRef.current = timeline;
    if (springTimerRef.current !== null) window.clearTimeout(springTimerRef.current);
    setSpringing(false);
    setDragging(true);
    updateElasticPosition(event.clientX);
  };

  const finishElasticDrag = (event?: ReactPointerEvent<HTMLButtonElement>) => {
    if (!dragging) return;
    if (event && event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const finalTimeline = shiftedTimeline(project, dragBaseRef.current, dragRatioRef.current);
    onTimelineChange(finalTimeline);
    setDragging(false);
    setSpringing(true);
    dragRatioRef.current = 0;
    setDragRatio(0);
    springTimerRef.current = window.setTimeout(() => setSpringing(false), 420);
  };

  const updateYearWhileDragging = (percent: number) => {
    setYearDraftPercent(percent);
  };

  const finishYearDrag = () => {
    if (yearDraftPercent !== null) onTimelineChange(snapForPrecision(project, timelineAtRangePercent(project, timeline, minimumYear, maximumYear, yearDraftPercent)));
    setYearDraftPercent(null);
  };

  const cyclePrecision = () => {
    const index = precisionOrder.indexOf(timeline.precision === "week" ? "date" : timeline.precision);
    onTimelineChange(snapForPrecision(project, { ...timeline, isPlaying: false, precision: precisionOrder[(index + 1) % precisionOrder.length] }));
    setDragRatio(0);
  };

  const nudgeElastic = (direction: -1 | 1) => {
    const ratio = timeline.precision === "month" ? direction / 120
      : timeline.precision === "date" ? direction / Math.max(1, Math.round(worldYearLengthDays(project) / 12))
        : direction / Math.max(1, worldDayLengthMinutes(project));
    onTimelineChange(shiftedTimeline(project, timeline, ratio));
    setSpringing(true);
    setDragRatio(direction * 0.08);
    requestAnimationFrame(() => setDragRatio(0));
    if (springTimerRef.current !== null) window.clearTimeout(springTimerRef.current);
    springTimerRef.current = window.setTimeout(() => setSpringing(false), 420);
  };

  const commitCalendarFields = (patch: Partial<{ year: number; dateValues: number[]; timeValues: number[] }>) => {
    onTimelineChange(timelineFromActiveCalendarFields(project, timeline, {
      year: patch.year ?? calendarFields.year,
      dateValues: patch.dateValues ?? calendarFields.dateValues,
      timeValues: patch.timeValues ?? calendarFields.timeValues,
    }, selectedCalendar));
  };
  const patchDateValue = (index: number, value: number) => {
    const dateValues = [...calendarFields.dateValues];
    dateValues[index] = value;
    commitCalendarFields({ dateValues });
  };
  const patchTimeValue = (index: number, value: number) => {
    const timeValues = [...calendarFields.timeValues];
    timeValues[index] = value;
    commitCalendarFields({ timeValues });
  };
  const visibleDateValues = calendarFields.dateValues;
  const visibleTimeValues = calendarFields.timeValues.slice(0, 1);

  const eventMarkPositions = isAnnual
    ? eventYears.filter((year) => year >= minimumYear && year <= maximumYear).map((year) => ({ year, percent: ((year - minimumYear) / Math.max(1, maximumYear - minimumYear)) * 100 }))
    : eventYears.map((year) => {
      const eventMinute = timelineAbsoluteMinute(project, { ...displayTimeline, currentYear: year, currentDayOfYear: 0, currentMinuteOfDay: 0 });
      const center = timelineAbsoluteMinute(project, displayTimeline);
      return { year, percent: 50 + ((eventMinute - center) / Math.max(1, halfSpan)) * 50 };
    }).filter((item) => item.percent >= 0 && item.percent <= 100);

  if (collapsed) return <footer className="timeline-panel timeline-panel-collapsed"><button type="button" className="timeline-fold-button" onClick={() => onCollapsedChange?.(false)} aria-label="타임라인 펼치기" title="타임라인 펼치기">⌃</button></footer>;

  return (
    <footer className="timeline-panel calendar-aware-timeline precision-timeline">
      <div className="timeline-leading-controls">
        <button type="button" className="timeline-fold-button" onClick={() => onCollapsedChange?.(true)} aria-label="타임라인 접기" title="타임라인 접기">⌄</button>
        <div className="playback-controls single-control">
          <button type="button" className={`play-button ${timeline.isPlaying ? "playing" : ""}`} onClick={onPlayToggle} aria-label={timeline.isPlaying ? "일시정지" : "재생"} title={timeline.isPlaying ? "일시정지" : "재생"}>
            {timeline.isPlaying ? "Ⅱ" : "▶"}
          </button>
        </div>
      </div>
      <div className="timeline-track">
        <div className="timeline-labels">
          <span>{endpoints[0]}</span>
          <button type="button" className="timeline-current-moment" onClick={cyclePrecision} title="클릭하여 연도 → 월 → 일 → 시각 표시를 전환">
            {formatTimelineMoment(project, displayTimeline, selectedCalendar)}
            <small>{language === "ko" ? `${labels[timeline.precision]} 단위 · 클릭하여 전환` : `${labels[timeline.precision]} unit · click to switch`}</small>
          </button>
          <span>{endpoints[1]}</span>
        </div>
        {isAnnual ? (
          <div className="range-wrap full-range-wrap">
            <input type="range" min={0} max={100} step={0.01} value={yearDraftPercent ?? actualPosition} onChange={(event) => updateYearWhileDragging(Number(event.target.value))} onPointerUp={finishYearDrag} onKeyUp={finishYearDrag} onBlur={finishYearDrag} aria-label="전체 타임라인 위치" />
            <div className="event-marks">{eventMarkPositions.map(({ year, percent }, index) => <span key={`${year}-${index}`} style={{ left: `${percent}%` }} title={`${year}년 사건`} />)}</div>
          </div>
        ) : (
          <div className="range-wrap elastic-range-wrap" ref={trackRef}>
            <div className="elastic-track-line" />
            <div className="event-marks">{eventMarkPositions.map(({ year, percent }, index) => <span key={`${year}-${index}`} style={{ left: `${percent}%` }} title={`${year}년 사건`} />)}</div>
            <button
              type="button"
              className={`elastic-timeline-handle ${dragging ? "dragging" : ""} ${springing ? "springing" : ""}`}
              style={{ left: `${50 + dragRatio * 50}%` }}
              onPointerDown={beginElasticDrag}
              onPointerMove={(event) => { if (dragging) updateElasticPosition(event.clientX); }}
              onPointerUp={finishElasticDrag}
              onPointerCancel={finishElasticDrag}
              onKeyDown={(event) => { if (event.key === "ArrowLeft") { event.preventDefault(); nudgeElastic(-1); } else if (event.key === "ArrowRight") { event.preventDefault(); nudgeElastic(1); } }}
              aria-label={language === "ko" ? `${labels[timeline.precision]} 타임라인 이동` : `Move ${labels[timeline.precision].toLowerCase()} timeline`}
              title="좌우로 당긴 뒤 놓으면 손잡이가 중앙으로 돌아옵니다"
            />
          </div>
        )}
      </div>
      <div className="timeline-options precision-options">
        <div className="standard-date-control active-calendar-date-control">
          <span><span data-user-authored="true">{calendarFields.calendarName}</span>{language === "ko" ? " 기준" : " calendar"}</span>
          <div className="standard-date-fields">
            <input type="number" aria-label={`${calendarFields.calendarName} 연도`} value={calendarFields.year} onChange={(event) => commitCalendarFields({ year: Number(event.target.value) })} />
            {visibleDateValues.map((value, index) => <input key={`date-${index}`} type="number" min={1} aria-label={calendarFields.dateLabels[index] ?? `날짜 ${index + 1}`} title={calendarFields.dateLabels[index]} value={value} onChange={(event) => patchDateValue(index, Number(event.target.value))} />)}
            {visibleTimeValues.map((value, index) => <input key={`time-${index}`} type="number" min={0} aria-label={calendarFields.timeLabels[index] ?? "시간"} title={calendarFields.timeLabels[index]} value={value} onChange={(event) => patchTimeValue(index, Number(event.target.value))} />)}
          </div>
        </div>
        <label className="calendar-mode-control">{language === "ko" ? "표시 역법" : "Display Calendar"}
          <select value={selectedCalendar?.id ?? ""} onChange={(event) => onCalendarChange(event.target.value || null)}>
            <option value="">{language === "ko" ? "표준 공전 주기" : "Standard Orbital Period"}</option>
            {calendars.map((article) => <option data-user-authored="true" key={article.id} value={article.id}>{article.title}</option>)}
          </select>
        </label>
        <label className="speed-control">{language === "ko" ? "재생 속도" : "Playback Speed"}
          <select value={timeline.playbackIntervalMs} onChange={(event) => onSpeedChange(Number(event.target.value) as PlaybackInterval)}>
            {speedValues.map((value) => <option key={value} value={value}>{speedLabel(value, timeline.precision, language)}</option>)}
          </select>
        </label>
      </div>
    </footer>
  );
}
