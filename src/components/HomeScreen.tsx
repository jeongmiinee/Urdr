import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { WorldProject } from "../model/world";
import { generatedAtYear, PROGRAM_VERSION } from "../model/world";
import type { RecentProject } from "../storage/projectStorage";
import { createGeneratedMapCanvas } from "../generator/renderGenerated";
import { UPDATE_HISTORY } from "../updateHistory";
import { SettingsScreen } from "./SettingsScreen";

type Props = {
  recents: RecentProject[];
  onNew: () => void;
  onDemo: () => void;
  onChooseJson: () => Promise<{ project: WorldProject; name: string } | null>;
  onPreviewRecent: (id: string) => WorldProject | null;
  onOpenProject: (project: WorldProject) => void;
  onDeleteRecent: (id: string) => void;
  onExit: () => void;
  canExit: boolean;
  theme: "light" | "dark";
  onThemeChange: (theme: "light" | "dark") => void;
};

type HomeView = "menu" | "load" | "settings";

type Selection = { project: WorldProject; sourceLabel: string; recentId?: string };

function WorldPreview({ project }: { project: WorldProject }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const map = project.maps.find((item) => item.id === project.activeMapId) ?? project.maps[0] ?? null;
  const generated = map ? generatedAtYear(map) : null;
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !generated) return;
    const source = createGeneratedMapCanvas(generated);
    const context = canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingEnabled = true;
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
  }, [generated]);
  if (!map) return <div className="world-preview-empty">지도 없음</div>;
  if (!generated) return <div className="world-preview-empty"><strong>{map.title}</strong><span>아직 확정된 지도가 없습니다.</span></div>;
  return <canvas ref={canvasRef} className="world-preview-canvas" width={560} height={310} />;
}

export function HomeScreen({ recents, onNew, onDemo, onChooseJson, onPreviewRecent, onOpenProject, onDeleteRecent, onExit, canExit, theme, onThemeChange }: Props) {
  const [view, setView] = useState<HomeView>("menu");
  const [showUpdates, setShowUpdates] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [loadError, setLoadError] = useState("");
  const selectedMap = useMemo(() => selection?.project.maps.find((map) => map.id === selection.project.activeMapId) ?? selection?.project.maps[0] ?? null, [selection]);

  useEffect(() => {
    if (!showUpdates) return;
    const previousOverflow = document.body.style.overflow;
    const previousPadding = document.body.style.paddingRight;
    const scrollbar = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.overflow = "hidden";
    if (scrollbar > 0) document.body.style.paddingRight = `${scrollbar}px`;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setShowUpdates(false); };
    window.addEventListener("keydown", onKey);
    return () => { document.body.style.overflow = previousOverflow; document.body.style.paddingRight = previousPadding; window.removeEventListener("keydown", onKey); };
  }, [showUpdates]);

  const chooseJson = async () => {
    setLoadError("");
    try {
      const selected = await onChooseJson();
      if (selected) setSelection({ project: selected.project, sourceLabel: selected.name });
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "JSON 파일을 미리 볼 수 없습니다.");
    }
  };

  const chooseRecent = (recent: RecentProject) => {
    setLoadError("");
    const project = onPreviewRecent(recent.id);
    if (!project) { setLoadError("최근 프로젝트 데이터를 찾지 못했습니다."); return; }
    setSelection({ project, sourceLabel: "최근 파일", recentId: recent.id });
  };

  if (view === "settings") return <SettingsScreen onBack={() => setView("menu")} />;

  return (
    <main className="game-home-screen">
      <div className="game-home-backdrop" />
      <section className={`game-menu-shell ${view === "load" ? "load-wide" : ""}`}>
        <div className="game-logo"><span>WORLD ARCHIVE</span><h1>가상세계 통합 작업공간</h1><p>지도, 위키, 연표가 하나의 세계로 연결됩니다.</p></div>
        {view === "menu" ? (
          <nav className="game-main-menu" aria-label="메인 메뉴">
            <button type="button" onClick={onNew}>세계 생성하기</button>
            <button type="button" onClick={() => setView("load")}>세계 불러오기</button>
            <button type="button" onClick={onDemo}>데모 프로젝트</button>
            <button type="button" onClick={() => setView("settings")}>설정</button>
            {canExit && <button type="button" className="home-exit-button" onClick={onExit}>종료</button>}
          </nav>
        ) : view === "load" ? (
          <section className="load-project-panel load-project-split">
            <header className="load-project-heading"><button type="button" onClick={() => setView("menu")}>←</button><div><h2>세계 불러오기</h2><p>파일을 선택한 뒤 미리보기를 확인하고 불러옵니다.</p></div></header>
            <div className="load-project-left">
              <button type="button" className="primary-button full" onClick={() => { void chooseJson(); }}>JSON 불러오기</button>
              <div className="recent-load-list">
                {recents.map((recent) => <article key={recent.id} className={selection?.recentId === recent.id ? "selected" : ""}><button type="button" className="recent-load-main" onClick={() => chooseRecent(recent)}><strong>{recent.title}</strong><span>{new Date(recent.lastModifiedDate).toLocaleString("ko-KR")}</span></button><button type="button" className="icon-button" aria-label="최근 프로젝트 삭제" onClick={() => { if (selection?.recentId === recent.id) setSelection(null); onDeleteRecent(recent.id); }}>×</button></article>)}
                {recents.length === 0 && <p className="empty-recent">저장된 최근 프로젝트가 없습니다.</p>}
              </div>
            </div>
            <article className="load-project-preview">
              {selection ? <>
                <WorldPreview project={selection.project} />
                <div className="world-preview-meta"><p className="eyebrow">{selection.sourceLabel}</p><h3>{selection.project.title}</h3><p>{selection.project.description || "세계 설명이 없습니다."}</p><dl><div><dt>버전</dt><dd>v{selection.project.version}</dd></div><div><dt>지도</dt><dd>{selection.project.maps.length}개</dd></div><div><dt>문서</dt><dd>{selection.project.wikiArticles.length}개</dd></div><div><dt>사건</dt><dd>{selection.project.maps.reduce((sum, map) => sum + map.events.length, 0)}개</dd></div><div><dt>활성 지도</dt><dd>{selectedMap?.title ?? "없음"}</dd></div><div><dt>마지막 수정</dt><dd>{new Date(selection.project.lastModifiedDate).toLocaleString("ko-KR")}</dd></div></dl></div>
                <button type="button" className="primary-button full" onClick={() => onOpenProject(selection.project)}>이 파일 불러오기</button>
              </> : <div className="world-preview-placeholder"><strong>세계 미리보기</strong><p>왼쪽에서 최근 파일 또는 JSON 파일을 선택하세요.</p></div>}
              {loadError && <p className="load-project-error">{loadError}</p>}
            </article>
          </section>
        ) : null}
      </section>
      <button type="button" className="home-theme-corner" onClick={() => onThemeChange(theme === "dark" ? "light" : "dark")}>{theme === "dark" ? "☀ 라이트 모드" : "☾ 다크 모드"}</button>
      <button type="button" className="home-version" onClick={() => setShowUpdates(true)}>{`v${PROGRAM_VERSION}`}</button>
      {showUpdates && createPortal(<div className="update-history-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowUpdates(false); }}>
        <section className="update-history-modal" role="dialog" aria-modal="true" aria-labelledby="update-history-title">
          <div className="load-project-heading"><button type="button" onClick={() => setShowUpdates(false)} aria-label="업데이트 내역 닫기">×</button><div><h2 id="update-history-title">업데이트 내역</h2><p>기능·편집·성능·호환성 변경을 버전별로 확인합니다.</p></div></div>
          <div className="update-history-list">{UPDATE_HISTORY.map((entry, index) => <details key={entry.version} open={index === 0}><summary><strong>v{entry.version}</strong><span>{index === 0 ? "현재 버전" : `${entry.changes.length}개 변경`}</span></summary><ul>{entry.changes.map((change) => <li key={change}>{change}</li>)}</ul></details>)}</div>
        </section>
      </div>, document.body)}
    </main>
  );
}
