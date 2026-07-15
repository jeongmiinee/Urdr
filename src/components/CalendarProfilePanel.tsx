import {
  activeCalendarYearFromWorldYear,
  calendarYearLengthDays,
  createDefaultCalendarProfile,
  createId,
  formatTimelineMoment,
  worldYearFromActiveCalendarYear,
  type CalendarDateUnit,
  type CalendarProfile,
  type CalendarTimeUnit,
  type WikiArticle,
  type WorldProject,
} from "../model/world";
import { activeMap } from "../model/worldSelectors";

type Props = {
  project: WorldProject;
  article: WikiArticle;
  editMode: boolean;
  onChange: (profile: CalendarProfile) => void;
};

function normalize(profile: CalendarProfile | undefined): CalendarProfile {
  return profile ?? createDefaultCalendarProfile();
}

export function CalendarProfilePanel({ project, article, editMode, onChange }: Props) {
  const profile = normalize(article.calendarProfile);
  const activeTimeline = activeMap(project)?.timeline;
  const allGroups = project.maps.flatMap((map) => map.factions).filter((value, index, array) => array.findIndex((item) => item.id === value.id) === index);
  const update = (patch: Partial<CalendarProfile>) => onChange({ ...profile, ...patch });
  const yearInput = (value: number | undefined, onValue: (value: number) => void) => <input type="number" value={activeCalendarYearFromWorldYear(project, value ?? 0)} onChange={(event) => onValue(worldYearFromActiveCalendarYear(project, Number(event.target.value)))} />;

  const updateDateUnit = (id: string, patch: Partial<CalendarDateUnit>) => update({
    dateUnits: profile.dateUnits.map((unit) => unit.id === id ? { ...unit, ...patch } : unit),
  });
  const updateTimeUnit = (id: string, patch: Partial<CalendarTimeUnit>) => update({
    timeUnits: profile.timeUnits.map((unit) => unit.id === id ? { ...unit, ...patch } : unit),
  });
  const addDateSubdivision = () => {
    if (profile.dateUnits.length >= 4) return;
    const next = [...profile.dateUnits];
    next.splice(Math.max(1, next.length - 1), 0, {
      id: createId("calendar-date-unit"),
      name: `단위 ${next.length}`,
      shortName: `단${next.length}`,
      unitsPerParent: 10,
    });
    update({ dateUnits: next });
  };
  const removeDateSubdivision = (id: string) => {
    const index = profile.dateUnits.findIndex((unit) => unit.id === id);
    if (index <= 0 || index >= profile.dateUnits.length - 1) return;
    update({ dateUnits: profile.dateUnits.filter((unit) => unit.id !== id) });
  };
  const addTimeSubdivision = () => {
    if (profile.timeUnits.length >= 4) return;
    update({
      timeUnits: [...profile.timeUnits, {
        id: createId("calendar-time-unit"),
        name: `시간 단위 ${profile.timeUnits.length + 1}`,
        shortName: `단${profile.timeUnits.length + 1}`,
        unitsPerParent: 60,
      }],
    });
  };
  const removeTimeSubdivision = (id: string) => {
    if (profile.timeUnits.length <= 1) return;
    update({ timeUnits: profile.timeUnits.filter((unit) => unit.id !== id) });
  };
  const toggleFaction = (id: string) => update({
    userFactionIds: profile.userFactionIds.includes(id)
      ? profile.userFactionIds.filter((item) => item !== id)
      : [...profile.userFactionIds, id],
  });

  if (!editMode) {
    return (
      <section className="linked-history-section calendar-document">
        <h3>역법 정보</h3>
        <table className="namuwiki-infobox">
          <tbody>
            <tr><th>제작 주체</th><td>{profile.creator || "미정"}</td></tr>
            <tr><th>제작 시기</th><td>{profile.createdAtYear === undefined ? "미정" : `${activeCalendarYearFromWorldYear(project, profile.createdAtYear)}년`}</td></tr>
            <tr><th>역초</th><td>{activeCalendarYearFromWorldYear(project, profile.epochWorldYear)}년</td></tr>
            <tr><th>표기 방식</th><td>{profile.displayMode === "era" ? `${profile.beforeEraShortName || profile.beforeEraName} / ${profile.afterEraShortName || profile.afterEraName}` : `${profile.calendarName} ±연도`}</td></tr>
            <tr><th>1년 길이</th><td>{calendarYearLengthDays(profile).toLocaleString()}일</td></tr>
            <tr><th>세계 공전 주기</th><td>{project.worldSettings.orbitalPeriodDays.toLocaleString()}일</td></tr>
            <tr><th>사용 단체</th><td>{profile.userFactionIds.map((id) => allGroups.find((group) => group.id === id)?.name).filter(Boolean).join(", ") || "없음"}</td></tr>
          </tbody>
        </table>
        <h3>날짜 단위</h3>
        <div className="calendar-unit-chain">
          {profile.dateUnits.map((unit, index) => <span key={unit.id}>{index > 0 && <b>→</b>} {unit.name}{index > 0 ? ` (${unit.unitsPerParent}${unit.shortName}/${profile.dateUnits[index - 1]?.shortName})` : ""}</span>)}
        </div>
        <h3>시간 단위</h3>
        <div className="calendar-unit-chain">
          {profile.timeUnits.map((unit, index) => <span key={unit.id}>{index > 0 && <b>→</b>} {unit.name} ({unit.unitsPerParent}{unit.shortName}/{index === 0 ? "일" : profile.timeUnits[index - 1]?.shortName})</span>)}
        </div>
        <div className="calendar-preview-card">
          <strong>이 역법으로 현재 시점 변환</strong>
          <span>{activeTimeline ? formatTimelineMoment(project, activeTimeline, article) : "지도 타임라인 없음"}</span>
        </div>
      </section>
    );
  }

  return (
    <section className="linked-history-section calendar-document calendar-editor-panel" data-link-scope={`calendar:${article.id}`}>
      <h3>역법 기본 설정</h3>
      <div className="form-grid two">
        <label>제작 주체<input value={profile.creator} onChange={(event) => update({ creator: event.target.value })} /></label>
        <label>제작 시기{yearInput(profile.createdAtYear, (createdAtYear) => update({ createdAtYear }))}</label>
        <label>역법명<input value={profile.calendarName} onChange={(event) => update({ calendarName: event.target.value })} /></label>
        <label>역초{yearInput(profile.epochWorldYear, (epochWorldYear) => update({ epochWorldYear }))}</label>
      </div>
      <label>표기 방식<select value={profile.displayMode} onChange={(event) => update({ displayMode: event.target.value as CalendarProfile["displayMode"] })}><option value="signed">역법명 + 음수/양수 연도</option><option value="era">전/후 시대명</option></select></label>
      {profile.displayMode === "era" && <><div className="form-grid two"><label>역초 이전 명칭<input value={profile.beforeEraName} onChange={(event) => update({ beforeEraName: event.target.value })} /></label><label>역초 이후 명칭<input value={profile.afterEraName} onChange={(event) => update({ afterEraName: event.target.value })} /></label></div><div className="form-grid two"><label>이전 연호 약칭<input placeholder="예: BC" value={profile.beforeEraShortName} onChange={(event) => update({ beforeEraShortName: event.target.value })} /></label><label>이후 연호 약칭<input placeholder="예: AD" value={profile.afterEraShortName} onChange={(event) => update({ afterEraShortName: event.target.value })} /></label></div></>}
      <h3>사용 단체</h3>
      <div className="calendar-group-grid">{allGroups.map((group) => <label key={group.id}><input type="checkbox" checked={profile.userFactionIds.includes(group.id)} onChange={() => toggleFaction(group.id)} />{group.name}</label>)}{allGroups.length === 0 && <span className="empty-hint">등록된 국가·세력·단체가 없습니다.</span>}</div>

      <div className="calendar-unit-heading"><div><h3>날짜 단위</h3><p>하루는 절대 단위이며, 중간 소단위는 최대 2개까지 추가해 총 4단계로 구성합니다.</p></div><button type="button" className="secondary-button" disabled={profile.dateUnits.length >= 4} onClick={addDateSubdivision}>＋ 소단위</button></div>
      <div className="calendar-unit-editor-list">
        {profile.dateUnits.map((unit, index) => <div className="calendar-unit-editor-row" key={unit.id}>
          <span>{index + 1}</span>
          <input value={unit.name} onChange={(event) => updateDateUnit(unit.id, { name: event.target.value })} />
          <input value={unit.shortName} onChange={(event) => updateDateUnit(unit.id, { shortName: event.target.value })} />
          {index === 0 ? <small>최상위 연 단위</small> : <label>1 {profile.dateUnits[index - 1]?.shortName} = <input type="number" min={1} value={unit.unitsPerParent} onChange={(event) => updateDateUnit(unit.id, { unitsPerParent: Math.max(1, Number(event.target.value)) })} /> {unit.shortName}</label>}
          {index > 0 && index < profile.dateUnits.length - 1 ? <button type="button" className="danger-ghost" onClick={() => removeDateSubdivision(unit.id)}>삭제</button> : <span />}
        </div>)}
      </div>
      <div className="calendar-length-summary">이 역법의 1년 = <strong>{calendarYearLengthDays(profile).toLocaleString()}일</strong> · 내부 표준 공전 1회 = <strong>{project.worldSettings.orbitalPeriodDays.toLocaleString()}일</strong></div>
      <div className="calendar-preview-card">
        <strong>이 역법으로 현재 시점 변환</strong>
        <span>{activeTimeline ? formatTimelineMoment(project, activeTimeline, article) : "지도 타임라인 없음"}</span>
      </div>

      <div className="calendar-unit-heading"><div><h3>시간 단위</h3><p>첫 단위는 하루를 나누고, 이후 단위는 바로 위 단위를 세분합니다. 최대 4단계입니다.</p></div><button type="button" className="secondary-button" disabled={profile.timeUnits.length >= 4} onClick={addTimeSubdivision}>＋ 소단위</button></div>
      <div className="calendar-unit-editor-list">
        {profile.timeUnits.map((unit, index) => <div className="calendar-unit-editor-row" key={unit.id}>
          <span>{index + 1}</span>
          <input value={unit.name} onChange={(event) => updateTimeUnit(unit.id, { name: event.target.value })} />
          <input value={unit.shortName} onChange={(event) => updateTimeUnit(unit.id, { shortName: event.target.value })} />
          <label>1 {index === 0 ? "일" : profile.timeUnits[index - 1]?.shortName} = <input type="number" min={1} value={unit.unitsPerParent} onChange={(event) => updateTimeUnit(unit.id, { unitsPerParent: Math.max(1, Number(event.target.value)) })} /> {unit.shortName}</label>
          <button type="button" className="danger-ghost" disabled={profile.timeUnits.length <= 1} onClick={() => removeTimeSubdivision(unit.id)}>삭제</button>
        </div>)}
      </div>
    </section>
  );
}
