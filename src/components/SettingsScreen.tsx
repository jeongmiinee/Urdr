import { useState, type CSSProperties } from "react";
import { getRuntimeMetrics, type RuntimeMetrics } from "../platform/runtime";
import { OpenSourceLicenses } from "./OpenSourceLicenses";
import type { WorldProject } from "../model/world";

function formatKb(value: number | undefined): string {
  if (!Number.isFinite(value)) return "-";
  const mb = Number(value) / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`;
}

export function SettingsScreen({
  onBack,
  embedded = false,
  project,
  onProjectChange,
}: {
  onBack?: () => void;
  embedded?: boolean;
  project?: WorldProject;
  onProjectChange?: (project: WorldProject) => void;
}) {
  const [showLicenses, setShowLicenses] = useState(false);
  const [measurementSystem, setMeasurementSystem] = useState<
    "metric" | "imperial"
  >(() =>
    localStorage.getItem("world-archive-measurement-system") === "imperial"
      ? "imperial"
      : "metric",
  );
  const [fontScale, setFontScale] = useState(() =>
    Math.max(0.5, Math.min(1.5, Number(project?.uiSettings.fontScale ?? localStorage.getItem("world-archive-font-scale")) || 1)),
  );
  const fallbackFont = 'Inter, Pretendard, "Noto Sans KR", system-ui, sans-serif';
  const [fontFamily, setFontFamily] = useState(() => project?.uiSettings.fontFamily || localStorage.getItem("world-archive-font-family") || fallbackFont);
  const [bitmapScaling, setBitmapScaling] = useState<"auto" | "1" | "2" | "4">(
    () => {
      const value = localStorage.getItem("world-archive-bitmap-scaling");
      return value === "1" || value === "2" || value === "4" ? value : "auto";
    },
  );
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [metrics, setMetrics] = useState<RuntimeMetrics | null>(null);
  const [metricsStatus, setMetricsStatus] = useState("");

  const changeFontScale = (value: number) => {
    const next = Math.max(0.5, Math.min(1.5, value));
    setFontScale(next);
    localStorage.setItem("world-archive-font-scale", String(next));
    document.documentElement.style.setProperty(
      "--app-font-scale",
      String(next),
    );
    window.dispatchEvent(
      new CustomEvent("world-archive:font-scale", { detail: next }),
    );
    if (project && onProjectChange) onProjectChange({ ...project, uiSettings: { ...project.uiSettings, fontScale: next } });
  };

  const changeFontFamily = (value: string) => {
    const next = value.trim() || fallbackFont;
    setFontFamily(next);
    localStorage.setItem("world-archive-font-family", next);
    document.documentElement.style.setProperty("--app-font-family", next);
    window.dispatchEvent(new CustomEvent("world-archive:font-family", { detail: next }));
    if (project && onProjectChange) onProjectChange({ ...project, uiSettings: { ...project.uiSettings, fontFamily: next } });
  };

  const changeMeasurement = (value: "metric" | "imperial") => {
    setMeasurementSystem(value);
    localStorage.setItem("world-archive-measurement-system", value);
    window.dispatchEvent(
      new CustomEvent("world-archive:measurement-system", { detail: value }),
    );
  };

  const changeBitmapScaling = (value: "auto" | "1" | "2" | "4") => {
    setBitmapScaling(value);
    localStorage.setItem("world-archive-bitmap-scaling", value);
    window.dispatchEvent(
      new CustomEvent("world-archive:bitmap-scaling", { detail: value }),
    );
  };

  const refreshMetrics = async () => {
    setMetricsStatus("측정 중…");
    try {
      const result = await getRuntimeMetrics();
      setMetrics(result);
      setMetricsStatus(
        result ? "" : "데스크톱 실행에서만 프로세스별 진단을 지원합니다.",
      );
    } catch (error) {
      setMetricsStatus(
        error instanceof Error
          ? error.message
          : "진단 정보를 가져오지 못했습니다.",
      );
    }
  };

  const toggleDiagnostics = async () => {
    const next = !showDiagnostics;
    setShowDiagnostics(next);
    if (next && !metrics) await refreshMetrics();
  };

  return (
    <section
      className={embedded ? "settings-screen embedded" : "settings-screen"}
    >
      <div className="settings-screen-card">
        <div className="settings-screen-heading">
          {onBack && <button type="button" className="settings-close-button" onClick={onBack} aria-label="설정 닫기" title="설정 닫기">×</button>}
          <div>
            <p className="eyebrow">SETTINGS</p>
            <h1>설정</h1>
            <p>프로그램 정보, 실행 상태와 표시 방식을 조정합니다.</p>
          </div>
        </div>

        <section className="settings-font-section">
          <h2>글자 크기</h2>
          <p>프로그램 전체의 문서·탐색기·입력창 글자 크기를 조절합니다.</p>
          <label className="font-scale-control">
            <span>작게</span>
            <input
              type="range"
              min={0.5}
              max={1.5}
              step={0.05}
              value={fontScale}
              onChange={(event) => changeFontScale(Number(event.target.value))}
            />
            <span>크게</span>
            <strong>{Math.round(fontScale * 100)}%</strong>
          </label>
          <label className="font-family-control">
            <span>글꼴</span>
            <select value={fontFamily} onChange={(event) => changeFontFamily(event.target.value)}>
              <option value={'Inter, Pretendard, "Noto Sans KR", system-ui, sans-serif'}>기본 고딕</option>
              <option value={'"Noto Serif KR", Batang, serif'}>명조·바탕</option>
              <option value={'Gulim, "Malgun Gothic", sans-serif'}>굴림</option>
              <option value={'Consolas, "D2Coding", monospace'}>고정폭</option>
            </select>
          </label>
          <div
            className="font-ui-preview"
            aria-label="글자 크기와 글꼴 미리보기"
            style={{ "--preview-font-scale": fontScale, "--preview-font-family": fontFamily } as CSSProperties}
          >
            <aside className="font-preview-explorer">
              <span>세계관</span>
              <button type="button">
                <b>국가</b>
                <small>문서 12개</small>
              </button>
              <button type="button">
                <b>장소</b>
                <small>문서 24개</small>
              </button>
            </aside>
            <article className="font-preview-document">
              <h3>아우렐리아 왕국</h3>
              <table>
                <tbody>
                  <tr>
                    <th>수도</th>
                    <td>솔라리스</td>
                  </tr>
                  <tr>
                    <th>체제</th>
                    <td>입헌군주제</td>
                  </tr>
                </tbody>
              </table>
              <p>
                북부 고원과 강 유역을 중심으로 성장한 왕국이다. 문서 제목, 표와
                본문이 함께 확대되는지 비교할 수 있다.
              </p>
            </article>
          </div>
        </section>

        <section className="settings-unit-section">
          <div>
            <h2>기준 도량형</h2>
            <p>지도 축척과 거리 표시에 사용할 기준 단위를 선택합니다.</p>
          </div>
          <div className="measurement-stack">
            <button
              type="button"
              className={measurementSystem === "metric" ? "active" : ""}
              onClick={() => changeMeasurement("metric")}
            >
              미터
            </button>
            <button
              type="button"
              className={measurementSystem === "imperial" ? "active" : ""}
              onClick={() => changeMeasurement("imperial")}
            >
              마일
            </button>
          </div>
        </section>

        <section className="settings-bitmap-section">
          <div>
            <h2>비트맵 스케일링</h2>
            <p>
              지형·길·강·등고선·해안선의 내부 렌더 해상도를 조절합니다. 국명과
              장소명은 별도 고해상도 텍스트로 유지됩니다.
            </p>
          </div>
          <div
            className="bitmap-scaling-grid"
            role="group"
            aria-label="비트맵 스케일링"
          >
            <button
              type="button"
              className={bitmapScaling === "auto" ? "active" : ""}
              onClick={() => changeBitmapScaling("auto")}
            >
              <strong>자동</strong>
              <small>화면 배율과 지도 크기에 맞춤</small>
            </button>
            <button
              type="button"
              className={bitmapScaling === "1" ? "active" : ""}
              onClick={() => changeBitmapScaling("1")}
            >
              <strong>표준 1×</strong>
              <small>메모리 절약</small>
            </button>
            <button
              type="button"
              className={bitmapScaling === "2" ? "active" : ""}
              onClick={() => changeBitmapScaling("2")}
            >
              <strong>고해상도 2×</strong>
              <small>권장 품질</small>
            </button>
            <button
              type="button"
              className={bitmapScaling === "4" ? "active" : ""}
              onClick={() => changeBitmapScaling("4")}
            >
              <strong>최고 품질 4×</strong>
              <small>대용량 메모리 사용</small>
            </button>
          </div>
        </section>

        <div className="settings-expand-list">
          <section
            className={`settings-expand-card ${showDiagnostics ? "open" : ""}`}
          >
            <button
              type="button"
              className="settings-expand-trigger"
              onClick={() => {
                void toggleDiagnostics();
              }}
              aria-expanded={showDiagnostics}
            >
              <span>
                <strong>성능 진단</strong>
                <small>
                  Electron 메인·렌더러·GPU의 CPU와 메모리를 확인합니다.
                </small>
              </span>
              <b>{showDiagnostics ? "−" : "+"}</b>
            </button>
            <div
              className="settings-expand-body"
              aria-hidden={!showDiagnostics}
            >
              {showDiagnostics && (
                <section className="runtime-diagnostics inline">
                  <div className="runtime-diagnostics-heading">
                    <div>
                      <h2>실행 상태</h2>
                      {metrics && (
                        <p>
                          {new Date(metrics.capturedAt).toLocaleString("ko-KR")}{" "}
                          기준
                        </p>
                      )}
                    </div>
                    <button type="button" onClick={refreshMetrics}>
                      새로고침
                    </button>
                  </div>
                  {metricsStatus && (
                    <p className="runtime-diagnostics-status">
                      {metricsStatus}
                    </p>
                  )}
                  {metrics && (
                    <>
                      <dl className="runtime-summary">
                        <div>
                          <dt>메인 프로세스 상주 메모리</dt>
                          <dd>{formatKb(metrics.mainMemory.residentSet)}</dd>
                        </div>
                        <div>
                          <dt>메인 프로세스 전용 메모리</dt>
                          <dd>{formatKb(metrics.mainMemory.private)}</dd>
                        </div>
                      </dl>
                      <div className="runtime-process-table">
                        <table>
                          <thead>
                            <tr>
                              <th>프로세스</th>
                              <th>PID</th>
                              <th>CPU</th>
                              <th>작업 메모리</th>
                              <th>전용 메모리</th>
                            </tr>
                          </thead>
                          <tbody>
                            {metrics.processes.map((processMetric) => (
                              <tr
                                key={`${processMetric.type}-${processMetric.pid}`}
                              >
                                <td>{processMetric.type}</td>
                                <td>{processMetric.pid}</td>
                                <td>{processMetric.cpuPercent.toFixed(1)}%</td>
                                <td>
                                  {formatKb(
                                    processMetric.memory?.workingSetSize,
                                  )}
                                </td>
                                <td>
                                  {formatKb(processMetric.memory?.privateBytes)}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </>
                  )}
                </section>
              )}
            </div>
          </section>
          <section
            className={`settings-expand-card ${showLicenses ? "open" : ""}`}
          >
            <button
              type="button"
              className="settings-expand-trigger"
              onClick={() => setShowLicenses((value) => !value)}
              aria-expanded={showLicenses}
            >
              <span>
                <strong>오픈소스 라이선스</strong>
                <small>사용된 라이브러리와 라이선스 원문을 확인합니다.</small>
              </span>
              <b>{showLicenses ? "−" : "+"}</b>
            </button>
            <div className="settings-expand-body" aria-hidden={!showLicenses}>
              {showLicenses && <OpenSourceLicenses />}
            </div>
          </section>
        </div>
      </div>
    </section>
  );
}
