import { lazy, Suspense, useState, type CSSProperties } from "react";
import { getRuntimeMetrics, type RuntimeMetrics } from "../platform/runtime";
import type { WorldProject } from "../model/world";
import { useLocalization } from "../localization";
import { formatDateTime } from "../formatting";

const OpenSourceLicenses = lazy(() =>
  import("./OpenSourceLicenses").then((module) => ({
    default: module.OpenSourceLicenses,
  })),
);
const LocalizationWorkspace = lazy(() =>
  import("./LocalizationWorkspace").then((module) => ({
    default: module.LocalizationWorkspace,
  })),
);

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
  const { language, setLanguage, t } = useLocalization();
  const [showLicenses, setShowLicenses] = useState(false);
  const [showLocalization, setShowLocalization] = useState(false);
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
        {onBack && <button type="button" className="settings-close-button" onClick={onBack} aria-label={`${t("settings.title")} ${t("common.close")}`} title={`${t("settings.title")} ${t("common.close")}`}>×</button>}
        <div className="settings-screen-heading">
          <div>
            <h1>{t("settings.title")}</h1>
            <p>{t("settings.description")}</p>
          </div>
        </div>

        <section className="settings-language-section settings-unit-section">
          <div>
            <h2>{t("settings.language")}</h2>
            <p>{t("settings.languageDescription")}</p>
          </div>
          <div className="measurement-stack" role="group" aria-label={t("settings.language")}>
            <button type="button" className={language === "ko" ? "active" : ""} onClick={() => setLanguage("ko")}>{t("settings.korean")}</button>
            <button type="button" className={language === "en" ? "active" : ""} onClick={() => setLanguage("en")}>{t("settings.english")}</button>
          </div>
        </section>

        <section className="settings-font-section">
          <h2>{t("settings.fontSize")}</h2>
          <p>{t("settings.fontSizeDescription")}</p>
          <label className="font-scale-control">
            <span>{t("settings.small")}</span>
            <input
              type="range"
              min={0.5}
              max={1.5}
              step={0.05}
              value={fontScale}
              onChange={(event) => changeFontScale(Number(event.target.value))}
            />
            <span>{t("settings.large")}</span>
            <strong>{Math.round(fontScale * 100)}%</strong>
          </label>
          <label className="font-family-control">
            <span>{t("settings.font")}</span>
            <select value={fontFamily} onChange={(event) => changeFontFamily(event.target.value)}>
              <option value={'Inter, Pretendard, "Noto Sans KR", system-ui, sans-serif'}>{t("settings.defaultSans")}</option>
              <option value={'"Noto Serif KR", Batang, serif'}>{t("settings.serif")}</option>
              <option value={'Gulim, "Malgun Gothic", sans-serif'}>{t("settings.gulim")}</option>
              <option value={'Consolas, "D2Coding", monospace'}>{t("settings.monospace")}</option>
            </select>
          </label>
          <div
            className="font-ui-preview"
            aria-label="글자 크기와 글꼴 미리보기"
            style={{ "--preview-font-scale": fontScale, "--preview-font-family": fontFamily } as CSSProperties}
          >
            <aside className="font-preview-explorer">
              <span>{language === "ko" ? "세계관" : "World"}</span>
              <button type="button">
                <b>{language === "ko" ? "국가" : "Countries"}</b>
                <small>{language === "ko" ? "문서 12개" : "12 documents"}</small>
              </button>
              <button type="button">
                <b>{language === "ko" ? "장소" : "Locations"}</b>
                <small>{language === "ko" ? "문서 24개" : "24 documents"}</small>
              </button>
            </aside>
            <article className="font-preview-document">
              <h3>{language === "ko" ? "아우렐리아 왕국" : "Kingdom of Aurelia"}</h3>
              <table>
                <tbody>
                  <tr>
                    <th>{language === "ko" ? "수도" : "Capital"}</th>
                    <td>{language === "ko" ? "솔라리스" : "Solaris"}</td>
                  </tr>
                  <tr>
                    <th>{language === "ko" ? "체제" : "Government"}</th>
                    <td>{language === "ko" ? "입헌군주제" : "Constitutional monarchy"}</td>
                  </tr>
                </tbody>
              </table>
              <p>{language === "ko"
                ? "북부 고원과 강 유역을 중심으로 성장한 왕국이다. 문서 제목, 표와 본문이 함께 확대되는지 비교할 수 있다."
                : "A kingdom that grew around the northern highlands and river basin. Compare how document titles, tables, and body text scale together."}</p>
            </article>
          </div>
        </section>

        <section className="settings-unit-section">
          <div>
            <h2>{t("settings.measurement")}</h2>
            <p>{t("settings.measurementDescription")}</p>
          </div>
          <div className="measurement-stack">
            <button
              type="button"
              className={measurementSystem === "metric" ? "active" : ""}
              onClick={() => changeMeasurement("metric")}
            >
              {t("settings.metric")}
            </button>
            <button
              type="button"
              className={measurementSystem === "imperial" ? "active" : ""}
              onClick={() => changeMeasurement("imperial")}
            >
              {t("settings.imperial")}
            </button>
          </div>
        </section>

        {project && onProjectChange && <section className="settings-unit-section settings-contents-section">
          <div>
            <h2>{t("settings.documentContents")}</h2>
            <p>{t("settings.documentContentsDescription")}</p>
          </div>
          <button
            type="button"
            className={project.uiSettings.showTableOfContents ? "active" : ""}
            aria-pressed={project.uiSettings.showTableOfContents}
            onClick={() => onProjectChange({
              ...project,
              uiSettings: {
                ...project.uiSettings,
                showTableOfContents: !project.uiSettings.showTableOfContents,
              },
            })}
          >
            {project.uiSettings.showTableOfContents ? t("settings.showContents") : t("settings.hideContents")}
          </button>
        </section>}

        <div className="settings-expand-list">
          <section className={`settings-expand-card ${showLocalization ? "open" : ""}`}>
            <button type="button" className="settings-expand-trigger" onClick={() => setShowLocalization((value) => !value)} aria-expanded={showLocalization}>
              <span><strong>{t("settings.localization")}</strong><small>{t("settings.localizationDescription")}</small></span>
              <b>{showLocalization ? "−" : "+"}</b>
            </button>
            <div className="settings-expand-body" aria-hidden={!showLocalization}>
              {showLocalization && <Suspense fallback={<p className="empty-hint">번역 카탈로그를 불러오는 중입니다.</p>}><LocalizationWorkspace /></Suspense>}
            </div>
          </section>
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
                <strong>{t("settings.diagnostics")}</strong>
                <small>{t("settings.diagnosticsDescription")}</small>
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
                          {formatDateTime(metrics.capturedAt, language)}
                          {language === "ko" ? " 기준" : ""}
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
                <strong>{t("settings.licenses")}</strong>
                <small>{t("settings.licensesDescription")}</small>
              </span>
              <b>{showLicenses ? "−" : "+"}</b>
            </button>
            <div className="settings-expand-body" aria-hidden={!showLicenses}>
              {showLicenses && (
                <Suspense
                  fallback={<p className="empty-hint">라이선스를 불러오는 중입니다.</p>}
                >
                  <OpenSourceLicenses />
                </Suspense>
              )}
            </div>
          </section>
        </div>
      </div>
    </section>
  );
}
