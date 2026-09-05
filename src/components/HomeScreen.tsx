import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { WorldProject } from "../model/world";
import { generatedAtYear } from "../model/world";
import type { RecentProject } from "../storage/projectStorage";
import { createGeneratedMapCanvas } from "../graphics";
import { prepareHomeBackdrop } from "../graphics/homeBackdropCache";
import { activeMap } from "../model/worldSelectors";
import { useLocalization } from "../localization";
import { formatDateTime } from "../formatting";

const SettingsScreen = lazy(() =>
  import("./SettingsScreen").then((module) => ({
    default: module.SettingsScreen,
  })),
);
const UpdateHistoryDialog = lazy(() =>
  import("./UpdateHistoryDialog").then((module) => ({
    default: module.UpdateHistoryDialog,
  })),
);

type Props = {
  recents: RecentProject[];
  backgroundProject: WorldProject | null;
  onNew: () => void;
  onDemo: (language: "ko" | "en") => void;
  onChooseJson: () => Promise<{ project: WorldProject; name: string } | null>;
  onPreviewRecent: (id: string) => WorldProject | null;
  onOpenProject: (project: WorldProject) => void;
  onDeleteRecent: (id: string) => void;
  onExit: () => void;
  canExit: boolean;
  theme: "light" | "dark";
  onThemeChange: (theme: "light" | "dark") => void;
};

type HomeView = "menu" | "load";

type Selection = { project: WorldProject; sourceLabel: string; recentId?: string };

function WorldPreview({ project }: { project: WorldProject }) {
  const { t } = useLocalization();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const map = activeMap(project);
  const generated = map ? generatedAtYear(map) : null;
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !generated || !project) return;
    const source = prepareHomeBackdrop(project) ?? createGeneratedMapCanvas(generated);
    const context = canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingEnabled = true;
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
  }, [generated]);
  if (!map) return <div className="world-preview-empty">{t("home.noMap")}</div>;
  if (!generated) return <div className="world-preview-empty"><strong>{map.title}</strong><span>{t("home.noGeneratedMap")}</span></div>;
  return <canvas ref={canvasRef} className="world-preview-canvas" width={560} height={310} />;
}

function HomeMapBackdrop({ project }: { project: WorldProject | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const map = project ? activeMap(project) : null;
  const generated = map ? generatedAtYear(map) : null;
  const [paused, setPaused] = useState(typeof document !== "undefined" && document.hidden);
  useEffect(() => {
    const handleVisibility = () => setPaused(document.hidden);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, []);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !generated || !project) return;
    const source = prepareHomeBackdrop(project) ?? createGeneratedMapCanvas(generated);
    const draw = () => {
      const bounds = canvas.getBoundingClientRect();
      const scale = Math.max(1, window.devicePixelRatio || 1);
      canvas.width = Math.max(1, Math.round(bounds.width * scale));
      canvas.height = Math.max(1, Math.round(bounds.height * scale));
      const context = canvas.getContext("2d");
      if (!context) return;
      context.setTransform(scale, 0, 0, scale, 0, 0);
      context.imageSmoothingEnabled = true;
      const fit = Math.max(bounds.width / source.width, bounds.height / source.height);
      const width = source.width * fit;
      const height = source.height * fit;
      context.clearRect(0, 0, bounds.width, bounds.height);
      context.drawImage(source, (bounds.width - width) / 2, (bounds.height - height) / 2, width, height);
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [generated]);
  return <div className={`game-home-map-backdrop${paused ? " paused" : ""}`} aria-hidden="true"><canvas ref={canvasRef} /></div>;
}

export function HomeScreen({ recents, backgroundProject, onNew, onDemo, onChooseJson, onPreviewRecent, onOpenProject, onDeleteRecent, onExit, canExit, theme, onThemeChange }: Props) {
  const { language, t } = useLocalization();
  const [view, setView] = useState<HomeView>("menu");
  const [showSettings, setShowSettings] = useState(false);
  const [showUpdates, setShowUpdates] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [loadError, setLoadError] = useState("");
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const settingsDialogRef = useRef<HTMLDivElement>(null);
  const selectedMap = useMemo(() => selection ? activeMap(selection.project) : null, [selection]);

  useEffect(() => {
    if (!showSettings) return;
    const dialog = settingsDialogRef.current;
    const focusable = () => dialog ? Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')) : [];
    window.requestAnimationFrame(() => focusable()[0]?.focus());
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setShowSettings(false);
        window.requestAnimationFrame(() => settingsButtonRef.current?.focus());
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [showSettings]);

  const closeSettings = () => {
    setShowSettings(false);
    window.requestAnimationFrame(() => settingsButtonRef.current?.focus());
  };

  const chooseJson = async () => {
    setLoadError("");
    try {
      const selected = await onChooseJson();
      if (selected) setSelection({ project: selected.project, sourceLabel: selected.name });
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "프로젝트 파일을 미리 볼 수 없습니다.");
    }
  };

  const chooseRecent = (recent: RecentProject) => {
    setLoadError("");
    const project = onPreviewRecent(recent.id);
    if (!project) { setLoadError(language === "en" ? "The recent project data could not be found." : "최근 프로젝트 데이터를 찾지 못했습니다."); return; }
    setSelection({ project, sourceLabel: t("home.recentSource"), recentId: recent.id });
  };

  return (
    <main className="game-home-screen">
      <HomeMapBackdrop project={backgroundProject} />
      <div className="game-home-backdrop" />
      <section className={`game-menu-shell ${view === "load" ? "load-wide" : ""}`}>
        <div className="game-logo"><h1>{t("home.title")}</h1></div>
        {view === "menu" ? (
          <nav className="game-main-menu" aria-label="메인 메뉴">
            <button type="button" onClick={onNew}>{t("home.create")}</button>
            <button type="button" onClick={() => setView("load")}>{t("home.open")}</button>
            <div className="home-demo-buttons" role="group" aria-label={language === "en" ? "Demo projects" : "데모 프로젝트"}>
              <button type="button" onClick={() => onDemo("ko")} aria-label={language === "en" ? "Open Korean demo" : "한국어 데모 열기"}>{language === "en" ? "Korean Demo" : "한국어 데모"}</button>
              <button type="button" onClick={() => onDemo("en")} aria-label={language === "en" ? "Open English demo" : "영어 데모 열기"}>{language === "en" ? "English Demo" : "영어 데모"}</button>
            </div>
            <button ref={settingsButtonRef} type="button" onClick={() => setShowSettings(true)}>{t("home.settings")}</button>
            {canExit && <button type="button" className="home-exit-button" onClick={onExit}>{t("home.exit")}</button>}
          </nav>
        ) : view === "load" ? (
          <section className="load-project-panel load-project-split">
            <header className="load-project-heading"><button type="button" onClick={() => setView("menu")}>←</button><div><h2>{t("home.loadTitle")}</h2><p>{t("home.loadDescription")}</p></div></header>
            <div className="load-project-left">
              <button type="button" className="primary-button full" onClick={() => { void chooseJson(); }}>{t("home.loadJson")}</button>
              <div className="recent-load-list">
                {recents.map((recent) => <article key={recent.id} className={selection?.recentId === recent.id ? "selected" : ""}><button type="button" className="recent-load-main" onClick={() => chooseRecent(recent)}><strong>{recent.title}</strong><span>{formatDateTime(recent.lastModifiedDate, language)}</span></button><button type="button" className="icon-button" aria-label={language === "en" ? "Delete recent project" : "최근 프로젝트 삭제"} onClick={() => { if (selection?.recentId === recent.id) setSelection(null); onDeleteRecent(recent.id); }}>×</button></article>)}
                {recents.length === 0 && <p className="empty-recent">{t("home.noRecent")}</p>}
              </div>
            </div>
            <article className="load-project-preview">
              {selection ? <>
                <WorldPreview project={selection.project} />
                <div className="world-preview-meta"><p className="section-meta">{selection.sourceLabel}</p><h3>{selection.project.title}</h3><p>{selection.project.description || t("home.noDescription")}</p><dl><div><dt>{t("home.maps")}</dt><dd>{selection.project.maps.length}</dd></div><div><dt>{t("home.documents")}</dt><dd>{selection.project.wikiArticles.length}</dd></div><div><dt>{t("home.events")}</dt><dd>{selection.project.maps.reduce((sum, map) => sum + map.events.length, 0)}</dd></div><div><dt>{t("home.activeMap")}</dt><dd>{selectedMap?.title ?? t("common.none")}</dd></div><div><dt>{t("home.lastModified")}</dt><dd>{formatDateTime(selection.project.lastModifiedDate, language)}</dd></div></dl></div>
                <button type="button" className="primary-button full" onClick={() => onOpenProject(selection.project)}>{t("home.openSelected")}</button>
              </> : <div className="world-preview-placeholder"><strong>{t("home.preview")}</strong><p>{t("home.previewHint")}</p></div>}
              {loadError && <p className="load-project-error">{loadError}</p>}
            </article>
          </section>
        ) : null}
      </section>
      {showSettings && <div className="home-settings-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeSettings(); }} onWheel={(event) => event.stopPropagation()}>
        <div ref={settingsDialogRef} className="home-settings-modal-dialog" role="dialog" aria-modal="true" aria-label={t("settings.title")}>
          <Suspense fallback={<div className="home-settings-loading" role="status">{t("home.loadingSettings")}</div>}>
            <SettingsScreen embedded onBack={closeSettings} />
          </Suspense>
        </div>
      </div>}
      <button type="button" className="home-theme-corner" onClick={() => onThemeChange(theme === "dark" ? "light" : "dark")}>{theme === "dark" ? `☀ ${t("home.lightMode")}` : `☾ ${t("home.darkMode")}`}</button>
      <button type="button" className="home-version" onClick={() => setShowUpdates(true)}>{language === "ko" ? "업데이트 내역" : "Update History"}</button>
      {showUpdates && (
        <Suspense fallback={null}>
          <UpdateHistoryDialog onClose={() => setShowUpdates(false)} />
        </Suspense>
      )}
    </main>
  );
}
