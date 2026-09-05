import {
  MAP_SCALE_RANGES,
  projectTemporalBounds,
  type EnvironmentEngineMode,
  type MapData,
  type WorldProject,
} from "../model/world";

type Props = {
  project: WorldProject;
  map: MapData | null;
  onChange: (project: WorldProject) => void;
  onMapChange: (map: MapData) => void;
};

export function ProjectSettingsWindow({
  project,
  map,
  onChange,
  onMapChange,
}: Props) {
  const bounds = projectTemporalBounds(project);
  const updateWorldSettings = (patch: Partial<WorldProject["worldSettings"]>) =>
    onChange({
      ...project,
      worldSettings: { ...project.worldSettings, ...patch },
    });
  return (
    <section className="settings-window">
      <div className="settings-card" data-link-scope={`project:${project.id}`}>
        <div className="window-heading">
          <h2>프로젝트 설정</h2>
        </div>
        <label>
          세계 이름
          <input
            value={project.title}
            onChange={(event) =>
              onChange({ ...project, title: event.target.value })
            }
          />
        </label>
        <dl className="summary-list project-immutable-settings">
          <div><dt>수치 시스템</dt><dd>{project.rpgSettings.enabled ? "사용" : "사용 안 함"}</dd></div>
          <div><dt>마법력</dt><dd>{project.rpgSettings.magicEnabled ? "존재" : "없음"}</dd></div>
        </dl>
        <label>
          세계 설명
          <textarea
            value={project.description}
            onChange={(event) =>
              onChange({ ...project, description: event.target.value })
            }
          />
        </label>
        <label>
          환경 엔진
          <select
            value={project.worldSettings.environmentEngine}
            onChange={(event) =>
              updateWorldSettings({
                environmentEngine: event.target.value as EnvironmentEngineMode,
              })
            }
          >
            <option value="builtin">내장 경량 환경 엔진</option>
            <option value="external_import">외부 모델 결과 가져오기</option>
            <option value="expert_bridge">전문가용 모델 브리지</option>
          </select>
        </label>
        <dl className="summary-list project-immutable-settings">
          <div><dt>기준 위도</dt><dd>{project.worldSettings.latitudeDeg}°</dd></div>
          <div><dt>자전축 기울기</dt><dd>{project.worldSettings.axialTiltDeg}°</dd></div>
          <div><dt>하루 길이</dt><dd>{project.worldSettings.dayLengthHours}시간</dd></div>
          <div><dt>중력</dt><dd>{project.worldSettings.gravityMs2}m/s²</dd></div>
          <div><dt>공전 주기</dt><dd>{project.worldSettings.orbitalPeriodDays}일</dd></div>
        </dl>
        <p className="dialog-hint">세계 환경 기준과 수치 시스템은 세계 생성 시 확정되며 프로젝트 홈에서는 변경할 수 없습니다.</p>
        <p className="dialog-hint">
          외부 환경 엔진을 선택해도 모델 실행 파일은 기본 배포본에 포함되지
          않습니다. 가져온 결과의 데이터·모델 라이선스를 별도로 기록해야 합니다.
        </p>
        <dl className="summary-list">
          <div>
            <dt>지도 수</dt>
            <dd>{project.maps.length}</dd>
          </div>
          <div>
            <dt>위키 문서</dt>
            <dd>{project.wikiArticles.length}</dd>
          </div>
          <div>
            <dt>자동 연표 범위</dt>
            <dd>
              {bounds.minimumYear}–{bounds.maximumYear}년
            </dd>
          </div>
        </dl>
      </div>
      {map && (
        <div className="settings-card" data-link-scope={`map:${map.id}`}>
          <div className="window-heading compact">
            <h2>현재 지도</h2>
          </div>
          <label>
            지도 이름
            <input
              value={map.title}
              onChange={(event) =>
                onMapChange({ ...map, title: event.target.value })
              }
            />
          </label>
          <dl className="summary-list">
            <div>
              <dt>지도 규모</dt>
              <dd>{MAP_SCALE_RANGES[map.scaleMode].label}</dd>
            </div>
            <div>
              <dt>실제 폭</dt>
              <dd>{map.physicalWidthKm.toLocaleString()}km</dd>
            </div>
          </dl>
          <p className="dialog-hint">타임라인 범위는 기록된 연도를 기준으로 자동 편성됩니다.</p>
        </div>
      )}
    </section>
  );
}
