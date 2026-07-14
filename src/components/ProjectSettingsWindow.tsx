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
          <p className="eyebrow">PROJECT SETTINGS</p>
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
        <div className="form-grid two">
          <label>
            기준 위도
            <input
              type="number"
              min={-89}
              max={89}
              step={0.1}
              value={project.worldSettings.latitudeDeg}
              onChange={(event) =>
                updateWorldSettings({ latitudeDeg: Number(event.target.value) })
              }
            />
          </label>
          <label>
            자전축 기울기
            <input
              type="number"
              min={0}
              max={90}
              step={0.01}
              value={project.worldSettings.axialTiltDeg}
              onChange={(event) =>
                updateWorldSettings({
                  axialTiltDeg: Number(event.target.value),
                })
              }
            />
          </label>
        </div>
        <div className="form-grid two">
          <label>
            하루 길이(시간)
            <input
              type="number"
              min={1}
              value={project.worldSettings.dayLengthHours}
              onChange={(event) =>
                updateWorldSettings({
                  dayLengthHours: Math.max(1, Number(event.target.value)),
                })
              }
            />
          </label>
          <label>
            중력(m/s²)
            <input
              type="number"
              min={0.1}
              step={0.01}
              value={project.worldSettings.gravityMs2}
              onChange={(event) =>
                updateWorldSettings({
                  gravityMs2: Math.max(0.1, Number(event.target.value)),
                })
              }
            />
          </label>
        </div>
        <label>
          세계 공전 주기(절대적인 하루)
          <input
            type="number"
            min={1}
            value={project.worldSettings.orbitalPeriodDays}
            onChange={(event) =>
              updateWorldSettings({
                orbitalPeriodDays: Math.max(1, Number(event.target.value)),
              })
            }
          />
        </label>
        <p className="dialog-hint">
          외부 환경 엔진을 선택해도 모델 실행 파일은 기본 배포본에 포함되지
          않습니다. 가져온 결과의 데이터·모델 라이선스를 별도로 기록해야 합니다.
        </p>
        <dl className="summary-list">
          <div>
            <dt>버전</dt>
            <dd>{project.version}</dd>
          </div>
          <div>
            <dt>현재 지도 엔진</dt>
            <dd>
              {map
                ? map.generationMode === "free"
                  ? "자유 · Mapgen4"
                  : "현실"
                : "-"}
            </dd>
          </div>
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
            <p className="eyebrow">ACTIVE MAP</p>
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
              <dt>생성 엔진</dt>
              <dd>
                {map.generationMode === "free" ? "자유 · Mapgen4" : "현실"}
              </dd>
            </div>
            <div>
              <dt>지도 규모</dt>
              <dd>{MAP_SCALE_RANGES[map.scaleMode].label}</dd>
            </div>
            <div>
              <dt>실제 폭</dt>
              <dd>{map.physicalWidthKm.toLocaleString()}km</dd>
            </div>
          </dl>
          <p className="dialog-hint">
            생성 엔진과 지도 규모는 새 지도 생성 단계에서 지도별로 정합니다.
            타임라인 범위는 기록된 연도를 기준으로 자동 편성됩니다.
          </p>
        </div>
      )}
    </section>
  );
}
