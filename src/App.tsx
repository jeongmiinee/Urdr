import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { createEmptyProject, generatedAtYear, type WorldProject } from "./model/world";
import { syncAutoWikiArticles } from "./model/wikiSync";
import { enforceMapPlacementConstraints } from "./generator/mapPlacement";
import { HomeScreen } from "./components/HomeScreen";
import { NewProjectDialog } from "./components/NewProjectDialog";
import { deleteProject, exportProjectBrowser, importProjectFile, importProjectText, listRecentProjects, loadProject, normalizeProject, saveProject, serializeProject, type RecentProject } from "./storage/projectStorage";
import { isDesktopRuntime, loadBundledDemoText, openTextFileFromPlatform, requestQuitFromPlatform, saveTextFileToPlatform } from "./platform/runtime";

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

export default function App() {
  const [theme, setTheme] = useState<"light" | "dark">(() => (localStorage.getItem("world-map-editor-theme") === "light" ? "light" : "dark"));
  const [project, setProject] = useState<WorldProject | null>(null);
  const [dirty, setDirty] = useState(false);
  const [recents, setRecents] = useState<RecentProject[]>([]);
  const [showNewDialog, setShowNewDialog] = useState(false);
  const [notice, setNotice] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const refreshRecents = () => setRecents(listRecentProjects());
  useEffect(refreshRecents, []);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 4_000);
    return () => window.clearTimeout(timer);
  }, [notice]);
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
    setProject(syncAutoWikiArticles(next));
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

  const chooseProjectForPreview = async (): Promise<{ project: WorldProject; name: string } | null> => {
    if (isDesktopRuntime()) {
      const selected = await openTextFileFromPlatform();
      if (!selected) return null;
      return { project: normalizeProjectPlacement(importProjectText(selected.text)), name: selected.name };
    }
    return await new Promise((resolve, reject) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".json,application/json";
      input.onchange = async () => {
        try {
          const file = input.files?.[0];
          if (!file) { resolve(null); return; }
          resolve({ project: normalizeProjectPlacement(await importProjectFile(file)), name: file.name });
        } catch (error) { reject(error); }
      };
      input.click();
    });
  };

  const requestImport = async () => {
    if (project && dirty && !window.confirm("저장되지 않은 변경사항이 있습니다. 현재 프로젝트를 대체하고 JSON 파일을 불러올까요?")) return;
    if (isDesktopRuntime()) {
      try {
        const selected = await openTextFileFromPlatform();
        if (!selected) return;
        const imported = normalizeProjectPlacement(importProjectText(selected.text));
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

  const requestExport = async () => {
    if (!project) return;
    const constrainedProject = normalizeProjectPlacement(project);
    if (isDesktopRuntime()) {
      const ok = await saveTextFileToPlatform(`${project.title || "world-project"}.json`, serializeProject(constrainedProject));
      if (ok) setNotice("JSON 프로젝트 파일을 저장했습니다.");
      return;
    }
    exportProjectBrowser(constrainedProject);
  };

  const handleImportFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const imported = normalizeProjectPlacement(await importProjectFile(file));
      imported.theme = project?.theme ?? theme;
      setProject(imported);
      setDirty(false);
      setNotice("프로젝트를 불러왔습니다.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "프로젝트를 불러오지 못했습니다.");
    }
  };

  const openDemo = async () => {
    setNotice("미리 생성된 데모 프로젝트를 불러오는 중입니다…");
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    const demoText = await loadBundledDemoText();
    const demo = normalizeProjectPlacement(normalizeProject(JSON.parse(demoText)));
    demo.theme = theme;
    setProject(demo);
    setDirty(false);
    setNotice("미리 생성된 데모 프로젝트를 불러왔습니다.");
  };

  const returnToStart = () => {
    if (dirty && !window.confirm("저장되지 않은 변경사항이 있습니다. 시작 화면으로 이동할까요?")) return;
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
            onExport={() => { void requestExport(); }}
            onImport={() => { void requestImport(); }}
            onHome={returnToStart}
          />
        </Suspense>
      ) : (
        <HomeScreen
          recents={recents}
          onNew={() => setShowNewDialog(true)}
          onDemo={() => { void openDemo(); }}
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
          onCreate={(projectTitle) => {
            const created = createEmptyProject(projectTitle);
            created.theme = theme;
            setProject(created);
            setDirty(true);
            setShowNewDialog(false);
          }}
        />
      )}

      <input ref={fileInputRef} hidden type="file" accept="application/json,.json" onChange={(event) => { void handleImportFile(event.target.files?.[0]); event.target.value = ""; }} />
      {notice && <button type="button" className="toast" role="status" aria-live="polite" onClick={() => setNotice("")}>{notice}</button>}
    </>
  );
}
