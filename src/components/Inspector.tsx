import { useEffect, useState } from "react";
import type { LocationState, MapData, PlaceName, WorldEvent, WorldProject } from "../model/world";
import { activeCalendarYearFromWorldYear, currentEvents, EVENT_CATEGORY_LABELS, formatTimelineMoment, generatedAtYear, getStateAtYear, MAP_SCALE_RANGES, visibleLocations, visibleTerritories, worldYearFromActiveCalendarYear } from "../model/world";

type Props = {
  project: WorldProject;
  map: MapData;
  selectedLocationId: string | null;
  selectedEventId: string | null;
  selectedPlaceNameId: string | null;
  mode: "view" | "edit";
  onModeChange: (mode: "view" | "edit") => void;
  onOpenWiki: (entityType: "location" | "event", entityId: string) => void;
  onLocationSave: (locationId: string, state: LocationState) => void;
  onDeleteLocation: (locationId: string) => void;
  onHardDeleteLocation: (locationId: string) => void;
  onEventSave: (event: WorldEvent) => void;
  onPlaceNameSave: (place: PlaceName) => void;
  onDeletePlaceName: (placeId: string) => void;
};

function ActiveYearInput({ project, value, disabled, onChange }: { project: WorldProject; value: number; disabled?: boolean; onChange: (value: number) => void }) {
  return <input type="number" disabled={disabled} value={activeCalendarYearFromWorldYear(project, value)} onChange={(event) => onChange(worldYearFromActiveCalendarYear(project, Number(event.target.value)))} />;
}

export function Inspector({ project, map, selectedLocationId, selectedEventId, selectedPlaceNameId, mode, onModeChange, onOpenWiki, onLocationSave, onDeleteLocation, onHardDeleteLocation, onEventSave, onPlaceNameSave, onDeletePlaceName }: Props) {
  const location = map.locations.find((item) => item.id === selectedLocationId);
  const currentState = location ? getStateAtYear(location.states, map.timeline.currentYear) : undefined;
  const event = map.events.find((item) => item.id === selectedEventId);
  const place = map.placeNames.find((item) => item.id === selectedPlaceNameId);
  const [locationDraft, setLocationDraft] = useState<LocationState | null>(currentState ? structuredClone(currentState) : null);
  const [eventDraft, setEventDraft] = useState<WorldEvent | null>(event ? structuredClone(event) : null);
  const [placeDraft, setPlaceDraft] = useState<PlaceName | null>(place ? structuredClone(place) : null);
  const generated = generatedAtYear(map);

  useEffect(() => { setLocationDraft(currentState ? structuredClone(currentState) : null); }, [selectedLocationId, map.timeline.currentYear]);
  useEffect(() => { setEventDraft(event ? structuredClone(event) : null); }, [selectedEventId]);
  useEffect(() => { setPlaceDraft(place ? structuredClone(place) : null); }, [selectedPlaceNameId]);

  if (place && placeDraft) {
    return <aside className="inspector"><h2>지명 명찰</h2><div className="temporal-edit-banner"><strong>편집 초안</strong><span>입력 후 저장을 눌러야 반영됩니다.</span></div>
      <label>명칭<input value={placeDraft.name} onChange={(input) => setPlaceDraft({ ...placeDraft, name: input.target.value })} /></label>
      <label>종류<select value={placeDraft.type} onChange={(input) => setPlaceDraft({ ...placeDraft, type: input.target.value as PlaceName["type"] })}><option value="region">지역</option><option value="landmark">랜드마크</option><option value="water_body">수역</option><option value="geographic_feature">지형</option></select></label>
      <label>배치 방식<select value={placeDraft.placementMode ?? (placeDraft.path?.length ? "path" : "point")} onChange={(input) => setPlaceDraft({ ...placeDraft, placementMode: input.target.value as "point" | "path", path: input.target.value === "point" ? undefined : placeDraft.path })}><option value="point">점 배치</option><option value="path">경로 배치</option></select></label>
      <div className="form-grid two compact-grid"><label>X 좌표<input type="number" value={placeDraft.position.x} onChange={(input) => setPlaceDraft({ ...placeDraft, position: { ...placeDraft.position, x: Number(input.target.value) } })} /></label><label>Y 좌표<input type="number" value={placeDraft.position.y} onChange={(input) => setPlaceDraft({ ...placeDraft, position: { ...placeDraft.position, y: Number(input.target.value) } })} /></label></div>
      {(placeDraft.placementMode === "path" || placeDraft.path?.length) && <><label className="checkbox-row"><input type="checkbox" checked={placeDraft.curve ?? true} onChange={(input) => setPlaceDraft({ ...placeDraft, curve: input.target.checked })} />곡선으로 표시</label><label>글자 간격<input type="range" min={0.8} max={5} step={0.1} value={placeDraft.letterSpacing ?? 2.1} onChange={(input) => setPlaceDraft({ ...placeDraft, letterSpacing: Number(input.target.value) })} /><span>{(placeDraft.letterSpacing ?? 2.1).toFixed(1)}</span></label><label>경로 오프셋<input type="range" min={-8} max={8} step={0.5} value={placeDraft.pathOffset ?? 0} onChange={(input) => setPlaceDraft({ ...placeDraft, pathOffset: Number(input.target.value) })} /><span>{(placeDraft.pathOffset ?? 0).toFixed(1)}</span></label><p className="empty-hint">경로를 다시 그리려면 지명 도구로 이 지명을 선택한 뒤 제어점을 추가하세요.</p></>}
      <label>설명<textarea value={placeDraft.description} onChange={(input) => setPlaceDraft({ ...placeDraft, description: input.target.value })} /></label>
      <div className="editor-save-row"><button type="button" className="primary-button" onClick={() => onPlaceNameSave(placeDraft)}>편집 완료</button><button type="button" className="secondary-button" onClick={() => setPlaceDraft(structuredClone(place))}>초안 되돌리기</button></div>
      <button type="button" className="danger-button" onClick={() => onDeletePlaceName(place.id)}>지명 삭제</button>
    </aside>;
  }

  if (event && eventDraft) {
    if (mode === "view") return <aside className="inspector"><h2>사건 속성</h2><dl className="summary-list">
      <div><dt>이름</dt><dd>{event.title}</dd></div><div><dt>유형</dt><dd>{EVENT_CATEGORY_LABELS[event.category]}</dd></div>
      <div><dt>시작</dt><dd>{event.startTimeUnknown ? "미정" : activeCalendarYearFromWorldYear(project, event.startYear)}</dd></div>
      <div><dt>종료</dt><dd>{event.endTimeUnknown || event.endYear === null ? "미정" : activeCalendarYearFromWorldYear(project, event.endYear)}</dd></div>
      <div><dt>좌표</dt><dd>{event.location ? `${event.location.x.toFixed(1)}, ${event.location.y.toFixed(1)}` : "없음"}</dd></div>
    </dl><p className="inspector-description">{event.description || "설명이 없습니다."}</p><button type="button" className="primary-button inspector-wiki-button" onClick={() => onOpenWiki("event", event.id)}>위키로 가기</button></aside>;
    return <aside className="inspector"><h2>사건 속성 편집</h2><div className="temporal-edit-banner"><strong>편집 초안</strong><span>저장해야 변경사항이 반영됩니다.</span></div>
      <label>사건명<input value={eventDraft.title} onChange={(input) => setEventDraft({ ...eventDraft, title: input.target.value })} /></label>
      <label>유형<select value={eventDraft.category} onChange={(input) => setEventDraft({ ...eventDraft, category: input.target.value as WorldEvent["category"] })}>{Object.entries(EVENT_CATEGORY_LABELS).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label className="checkbox-row"><input type="checkbox" checked={eventDraft.startTimeUnknown} onChange={(input) => setEventDraft({ ...eventDraft, startTimeUnknown: input.target.checked })} />시작 시점 미정</label>
      <label>시작 연도<ActiveYearInput project={project} value={eventDraft.startYear} disabled={eventDraft.startTimeUnknown} onChange={(startYear) => setEventDraft({ ...eventDraft, startYear, startDateTime: { ...(eventDraft.startDateTime ?? {}), year: startYear } })} /></label>
      <label className="checkbox-row"><input type="checkbox" checked={eventDraft.endTimeUnknown} onChange={(input) => setEventDraft({ ...eventDraft, endTimeUnknown: input.target.checked, endYear: input.target.checked ? null : (eventDraft.endYear ?? eventDraft.startYear), endDateTime: input.target.checked ? null : (eventDraft.endDateTime ?? { year: eventDraft.startYear }) })} />종료 시점 미정</label>
      <label>종료 연도<ActiveYearInput project={project} value={eventDraft.endYear ?? eventDraft.startYear} disabled={eventDraft.endTimeUnknown} onChange={(endYear) => setEventDraft({ ...eventDraft, endYear, endDateTime: { ...(eventDraft.endDateTime ?? {}), year: endYear } })} /></label>
      <div className="form-grid two compact-grid"><label>X 좌표<input type="number" value={eventDraft.location?.x ?? 0} onChange={(input) => setEventDraft({ ...eventDraft, location: { x: Number(input.target.value), y: eventDraft.location?.y ?? 0 } })} /></label><label>Y 좌표<input type="number" value={eventDraft.location?.y ?? 0} onChange={(input) => setEventDraft({ ...eventDraft, location: { x: eventDraft.location?.x ?? 0, y: Number(input.target.value) } })} /></label></div>
      <label>설명<textarea value={eventDraft.description} onChange={(input) => setEventDraft({ ...eventDraft, description: input.target.value })} /></label>
      <div className="editor-save-row"><button type="button" className="primary-button" onClick={() => { onEventSave(eventDraft); onModeChange("view"); }}>편집 완료</button><button type="button" className="secondary-button" onClick={() => { setEventDraft(structuredClone(event)); onModeChange("view"); }}>취소</button></div>
    </aside>;
  }

  if (!location || !currentState || !locationDraft) {
    return <aside className="inspector"><h2>지도 정보</h2><dl className="summary-list"><div><dt>이름</dt><dd>{map.title}</dd></div><div><dt>지도 크기</dt><dd>{MAP_SCALE_RANGES[map.scaleMode].label} · {map.physicalWidthKm.toLocaleString()}km × {Math.round(map.physicalWidthKm * map.height / Math.max(1, map.width)).toLocaleString()}km</dd></div><div><dt>절차형 지형</dt><dd>{generated ? "적용됨" : "없음"}</dd></div><div><dt>현재 연도</dt><dd>{formatTimelineMoment(project, map.timeline)}</dd></div><div><dt>해수면</dt><dd>{generated ? `${generated.seaLevel}m` : "-"}</dd></div><div><dt>장소</dt><dd>{visibleLocations(map).length}</dd></div><div><dt>영토</dt><dd>{visibleTerritories(map).length}</dd></div><div><dt>사건</dt><dd>{currentEvents(map).length}</dd></div></dl>{generated && <div className="generator-summary"><strong>생성 시드</strong><span>{generated.settings.seed}</span><strong>독립 대륙</strong><span>{generated.actualContinentCount}</span><strong>등고선</strong><span>수중·육상 {generated.contours.length.toLocaleString()}구간</span></div>}<p className="empty-hint">선택 도구로 장소나 사건을 클릭하거나 지명 도구로 명찰을 선택하세요.</p></aside>;
  }

  if (mode === "view") return <aside className="inspector"><h2>장소 속성</h2><dl className="summary-list">
    <div><dt>이름</dt><dd>{currentState.name}</dd></div><div><dt>유형</dt><dd>{currentState.locationType}</dd></div><div><dt>상태</dt><dd>{currentState.status}</dd></div>
    <div><dt>인구</dt><dd>{currentState.population?.toLocaleString() ?? "-"}</dd></div><div><dt>경제력</dt><dd>{currentState.economy?.toLocaleString() ?? "-"}</dd></div>
    <div><dt>좌표</dt><dd>{currentState.position.x.toFixed(1)}, {currentState.position.y.toFixed(1)}</dd></div>
  </dl><p className="inspector-description">{currentState.description || "설명이 없습니다."}</p><button type="button" className="primary-button inspector-wiki-button" onClick={() => onOpenWiki("location", location.id)}>위키로 가기</button></aside>;

  return <aside className="inspector"><h2>장소 속성 편집</h2><div className="temporal-edit-banner"><strong>{formatTimelineMoment(project, map.timeline)} 편집 초안</strong><span>편집 완료를 눌러야 이 연도부터 저장됩니다.</span></div>
    <label>이름<input value={locationDraft.name} onChange={(input) => setLocationDraft({ ...locationDraft, name: input.target.value })} /></label>
    <label>유형<select value={locationDraft.locationType} onChange={(input) => setLocationDraft({ ...locationDraft, locationType: input.target.value as LocationState["locationType"] })}><option value="village">마을</option><option value="town">읍</option><option value="city">도시</option><option value="capital">수도</option><option value="ruin">폐허</option><option value="dungeon">던전</option><option value="sacred_site">성지</option><option value="landmark">랜드마크</option></select></label>
    <label>상태<select value={locationDraft.status} onChange={(input) => setLocationDraft({ ...locationDraft, status: input.target.value as LocationState["status"] })}><option value="active">활성</option><option value="occupied">점령</option><option value="abandoned">버려짐</option><option value="destroyed">파괴됨</option></select></label>
    <div className="form-grid two compact-grid"><label>인구<input type="number" min={0} value={locationDraft.population ?? 0} onChange={(input) => setLocationDraft({ ...locationDraft, population: Number(input.target.value) })} /></label><label>경제력<input type="number" min={0} value={locationDraft.economy ?? 0} onChange={(input) => setLocationDraft({ ...locationDraft, economy: Number(input.target.value) })} /></label></div>
    <div className="form-grid two compact-grid"><label>X 좌표<input type="number" value={locationDraft.position.x} onChange={(input) => setLocationDraft({ ...locationDraft, position: { ...locationDraft.position, x: Number(input.target.value) } })} /></label><label>Y 좌표<input type="number" value={locationDraft.position.y} onChange={(input) => setLocationDraft({ ...locationDraft, position: { ...locationDraft.position, y: Number(input.target.value) } })} /></label></div>
    <label>설명<textarea value={locationDraft.description} onChange={(input) => setLocationDraft({ ...locationDraft, description: input.target.value })} /></label>
    <div className="editor-save-row"><button type="button" className="primary-button" onClick={() => { onLocationSave(location.id, locationDraft); onModeChange("view"); }}>편집 완료</button><button type="button" className="secondary-button" onClick={() => { setLocationDraft(structuredClone(currentState)); onModeChange("view"); }}>취소</button></div>
    <button type="button" className="danger-button" onClick={() => onDeleteLocation(location.id)}>{formatTimelineMoment(project, map.timeline)}부터 장소 제거</button><button type="button" className="danger-button hard-delete-button" onClick={() => { if (window.confirm("이 장소의 모든 연도 기록과 연결된 자동 문서를 완전히 삭제할까요?")) onHardDeleteLocation(location.id); }}>완전 삭제</button>
  </aside>;
}
