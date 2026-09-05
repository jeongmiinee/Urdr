import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { createEmptyProject, generatedAtYear, type WorldProject } from "./model/world";
import { syncAutoWikiArticles } from "./model/wikiSync";
import { enforceMapPlacementConstraints } from "./generator/mapPlacement";
import { HomeScreen } from "./components/HomeScreen";
import { NewProjectDialog } from "./components/NewProjectDialog";
import { deleteProject, importProjectText, listRecentProjects, loadProject, normalizeProject, saveProject, type RecentProject } from "./storage/projectStorage";
import { buildProjectPackage, downloadPackageBrowser, parseProjectPackage, type ProjectExportProfile } from "./storage/projectPackage";
import { isDesktopRuntime, loadBundledDemoText, openProjectFileFromPlatform, requestQuitFromPlatform, saveBinaryFileToPlatform, subscribeToForwardedProject } from "./platform/runtime";
import { useTransientMessage } from "./hooks/useTransientMessage";
import { prepareHomeBackdrop } from "./graphics/homeBackdropCache";
import { useLocalization } from "./localization";

const WorkspaceShell = lazy(() =>
  import("./components/WorkspaceShell").then((module) => ({
    default: module.WorkspaceShell,
  })),
);

function normalizeProjectPlacement(project: WorldProject): WorldProject {
  return {
    ...project,
    maps: project.maps.map((map) => {
      const generated = generatedAtYear(map);
      return generated ? enforceMapPlacementConstraints(map, generated) : map;
    }),
  };
}

function requiresAutoWikiSync(previous: WorldProject | null, next: WorldProject): boolean {
  if (!previous || previous.maps.length !== next.maps.length) return true;
  if (previous.heraldicAssets !== next.heraldicAssets) return true;
  for (const nextMap of next.maps) {
    const previousMap = previous.maps.find((map) => map.id === nextMap.id);
    if (!previousMap) return true;
    if (
      previousMap.locations !== nextMap.locations
      || previousMap.events !== nextMap.events
      || previousMap.factions !== nextMap.factions
    ) return true;
  }
  return false;
}

export default function App() {
  const { language } = useLocalization();
  const [theme, setTheme] = useState<"light" | "dark">(() => (localStorage.getItem("world-map-editor-theme") === "light" ? "light" : "dark"));
  const [project, setProject] = useState<WorldProject | null>(null);
  const [dirty, setDirty] = useState(false);
  const [recents, setRecents] = useState<RecentProject[]>([]);
  const [showNewDialog, setShowNewDialog] = useState(false);
  const [notice, setNotice] = useTransientMessage();
  const [startup, setStartup] = useState<{ ready: boolean; phase: "project" | "map" | "ready"; backgroundProject: WorldProject | null }>({ ready: false, phase: "project", backgroundProject: null });
  const fileInputRef = useRef<HTMLInputElement>(null);

  const refreshRecents = () => setRecents(listRecentProjects());
  useEffect(() => {
    let cancelled = false;
    const initializeStartScreen = async () => {
      const recentItems = listRecentProjects();
      if (!cancelled) setRecents(recentItems);
      let backgroundProject = recentItems[0] ? loadProject(recentItems[0].id) : null;
      if (!backgroundProject) {
        try {
          backgroundProject = normalizeProject(JSON.parse(await loadBundledDemoText(language)));
        } catch {
          backgroundProject = null;
        }
      }
      if (cancelled) return;
      setStartup({ ready: false, phase: "map", backgroundProject });
      if (backgroundProject) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
        prepareHomeBackdrop(backgroundProject);
      }
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      if (!cancelled) setStartup({ ready: true, phase: "ready", backgroundProject });
    };
    void initializeStartScreen();
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    const activeTheme = project?.theme ?? theme;
    document.documentElement.dataset.theme = activeTheme;
    localStorage.setItem("world-map-editor-theme", activeTheme);
  }, [theme, project?.theme]);

  useEffect(() => {
    const applyFontScale = (value?: number) => {
      const scale = Math.max(0.5, Math.min(1.5, Number(value ?? project?.uiSettings.fontScale ?? localStorage.getItem("world-archive-font-scale")) || 1));
      document.documentElement.style.setProperty("--app-font-scale", String(scale));
      localStorage.setItem("world-archive-font-scale", String(scale));
    };
    applyFontScale();
    const listener = (event: Event) => applyFontScale((event as CustomEvent<number>).detail);
    window.addEventListener("world-archive:font-scale", listener);
    return () => window.removeEventListener("world-archive:font-scale", listener);
  }, [project?.uiSettings.fontScale]);

  useEffect(() => {
    const fallback = 'Inter, Pretendard, "Noto Sans KR", system-ui, sans-serif';
    const applyFontFamily = (value?: string) => {
      const family = String(value ?? project?.uiSettings.fontFamily ?? localStorage.getItem("world-archive-font-family") ?? fallback).trim() || fallback;
      document.documentElement.style.setProperty("--app-font-family", family);
      localStorage.setItem("world-archive-font-family", family);
    };
    applyFontFamily();
    const listener = (event: Event) => applyFontFamily((event as CustomEvent<string>).detail);
    window.addEventListener("world-archive:font-family", listener);
    return () => window.removeEventListener("world-archive:font-family", listener);
  }, [project?.uiSettings.fontFamily]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);

  const handleProjectChange = (next: WorldProject) => {
    setProject((previous) => requiresAutoWikiSync(previous, next) ? syncAutoWikiArticles(next) : next);
    setDirty(true);
  };

  const handleSave = () => {
    if (!project) return;
    const saved = saveProject(normalizeProjectPlacement(syncAutoWikiArticles(project)));
    setProject(saved);
    setDirty(false);
    refreshRecents();
    setNotice("프로젝트를 저장했습니다.");
  };

  const importSelectedProject = async (selected: { name: string; text?: string; bytes?: Uint8Array }): Promise<WorldProject> => {
    if (selected.bytes || selected.name.toLowerCase().endsWith(".worldarchive")) {
      if (!selected.bytes) throw new Error("프로젝트 패키지 바이트를 읽지 못했습니다.");
      return normalizeProject(await parseProjectPackage(selected.bytes));
    }
    if (selected.text === undefined) throw new Error("프로젝트 JSON을 읽지 못했습니다.");
    return importProjectText(selected.text);
  };

  const chooseProjectForPreview = async (): Promise<{ project: WorldProject; name: string } | null> => {
    if (isDesktopRuntime()) {
      const selected = await openProjectFileFromPlatform();
      if (!selected) return null;
      return { project: normalizeProjectPlacement(await importSelectedProject(selected)), name: selected.name };
    }
    return await new Promise((resolve, reject) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".worldarchive,.json,application/zip,application/json";
      input.onchange = async () => {
        try {
          const file = input.files?.[0];
          if (!file) { resolve(null); return; }
          const imported = file.name.toLowerCase().endsWith(".worldarchive")
            ? await parseProjectPackage(new Uint8Array(await file.arrayBuffer()))
            : importProjectText(await file.text());
          resolve({ project: normalizeProjectPlacement(normalizeProject(imported)), name: file.name });
        } catch (error) { reject(error); }
      };
      input.click();
    });
  };

  const requestImport = async () => {
    if (project && dirty && !window.confirm("저장되지 않은 변경사항이 있습니다. 현재 프로젝트를 대체하고 프로젝트 파일을 불러올까요?")) return;
    if (isDesktopRuntime()) {
      try {
        const selected = await openProjectFileFromPlatform();
        if (!selected) return;
        const imported = normalizeProjectPlacement(await importSelectedProject(selected));
        imported.theme = project?.theme ?? theme;
        setProject(imported);
        setDirty(false);
        setNotice(`${selected.name} 파일을 불러왔습니다.`);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "프로젝트를 불러오지 못했습니다.");
      }
      return;
    }
    fileInputRef.current?.click();
  };

  const requestExport = async (profile: ProjectExportProfile = "package") => {
    if (!project) return;
    try {
      const constrainedProject = normalizeProjectPlacement(project);
      setNotice(profile === "package" ? "편집용 프로젝트 패키지를 만드는 중입니다…" : profile === "development" ? "개발용 데이터 패키지를 만드는 중입니다…" : "런타임 스냅샷을 만드는 중입니다…");
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      const bytes = await buildProjectPackage(constrainedProject, profile);
      const base = project.title || "world-project";
      const filename = profile === "package" ? `${base}.worldarchive` : `${base}-${profile}.zip`;
      if (isDesktopRuntime()) {
        const ok = await saveBinaryFileToPlatform(filename, bytes);
        if (ok) setNotice(profile === "package" ? "프로젝트 패키지를 저장했습니다." : "외부 개발용 데이터를 저장했습니다.");
        return;
      }
      downloadPackageBrowser(bytes, filename);
      setNotice("프로젝트 데이터를 내보냈습니다.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "프로젝트 데이터를 내보내지 못했습니다.");
    }
  };

  const handleImportFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const imported = normalizeProjectPlacement(file.name.toLowerCase().endsWith(".worldarchive")
        ? normalizeProject(await parseProjectPackage(new Uint8Array(await file.arrayBuffer())))
        : importProjectText(await file.text()));
      imported.theme = project?.theme ?? theme;
      setProject(imported);
      setDirty(false);
      setNotice("프로젝트를 불러왔습니다.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "프로젝트를 불러오지 못했습니다.");
    }
  };

  const openDemo = async (demoLanguage: "ko" | "en") => {
    setNotice(language === "en" ? "Loading the bundled demo project…" : "미리 생성된 데모 프로젝트를 불러오는 중입니다…");
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    const demoText = await loadBundledDemoText(demoLanguage);
    const demo = normalizeProjectPlacement(normalizeProject(JSON.parse(demoText)));
    demo.theme = theme;
    setProject(demo);
    setDirty(false);
    setNotice(language === "en" ? "The bundled demo project is ready." : "미리 생성된 데모 프로젝트를 불러왔습니다.");
  };

  useEffect(() => subscribeToForwardedProject(async (selected) => {
    if (dirty && !window.confirm(language === "en"
      ? "There are unsaved changes. Replace the current project?"
      : "저장되지 않은 변경사항이 있습니다. 현재 프로젝트를 대체할까요?")) return;
    try {
      const imported = normalizeProjectPlacement(await importSelectedProject(selected));
      imported.theme = project?.theme ?? theme;
      setProject(imported);
      setDirty(false);
      setNotice(language === "en" ? `${selected.name} imported.` : `${selected.name} 파일을 불러왔습니다.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : language === "en" ? "Could not import the project." : "프로젝트를 불러오지 못했습니다.");
    }
  }), [dirty, language, project?.theme, theme]);

  const returnToStart = () => {
    if (dirty && !window.confirm("저장되지 않은 변경사항이 있습니다. 시작 화면으로 이동할까요?")) return;
    if (project) {
      prepareHomeBackdrop(project);
      setStartup({ ready: true, phase: "ready", backgroundProject: project });
    }
    setProject(null);
    setDirty(false);
    refreshRecents();
  };

  return (
    <>
      {project ? (
        <Suspense
          fallback={
            <div className="workspace-welcome" role="status">
              <strong>작업 공간을 불러오는 중입니다.</strong>
            </div>
          }
        >
          <WorkspaceShell
            key={project.id}
            project={project}
            dirty={dirty}
            onChange={handleProjectChange}
            onSave={handleSave}
            onExport={(profile) => { void requestExport(profile); }}
            onImport={() => { void requestImport(); }}
            onHome={returnToStart}
          />
        </Suspense>
      ) : !startup.ready ? (
        <main className="startup-loading-screen" role="status" aria-live="polite">
          <div className="startup-loading-mark" aria-hidden="true" />
          <h1>URDR</h1>
          <p>{language === "en"
            ? startup.phase === "map" ? "Preparing the latest map..." : "Loading the workspace..."
            : startup.phase === "map" ? "최근 지도를 준비하는 중입니다..." : "작업공간을 불러오는 중입니다..."}</p>
        </main>
      ) : (
        <HomeScreen
          recents={recents}
          backgroundProject={startup.backgroundProject}
          onNew={() => setShowNewDialog(true)}
          onDemo={(demoLanguage) => { void openDemo(demoLanguage); }}
          onChooseJson={chooseProjectForPreview}
          onPreviewRecent={(id) => loadProject(id)}
          onOpenProject={(loaded) => { const normalized = normalizeProjectPlacement(loaded); normalized.theme = theme; setProject(normalized); setDirty(false); }}
          onDeleteRecent={(id) => { deleteProject(id); refreshRecents(); }}
          canExit={isDesktopRuntime()}
          onExit={() => { void requestQuitFromPlatform(); }}
          theme={theme}
          onThemeChange={setTheme}
        />
      )}

      {showNewDialog && (
        <NewProjectDialog
          onCancel={() => setShowNewDialog(false)}
          onCreate={(projectTitle, options) => {
            const created = createEmptyProject(projectTitle, options);
            created.theme = theme;
            setProject(created);
            setDirty(true);
            setShowNewDialog(false);
          }}
        />
      )}

      <input ref={fileInputRef} hidden type="file" accept=".worldarchive,.json,application/zip,application/json" onChange={(event) => { void handleImportFile(event.target.files?.[0]); event.target.value = ""; }} />
      {notice && <button type="button" className="toast" role="status" aria-live="polite" onClick={() => setNotice("")}>{notice}</button>}
    </>
  );
}
