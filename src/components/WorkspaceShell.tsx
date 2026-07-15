import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import type {
  EventCategory,
  GeneratedMapData,
  MapData,
  MapScaleMode,
  SimulationMode,
  WikiArticle,
  WorkspaceTab,
  WorkspaceTabType,
  WorldProject,
} from "../model/world";
import {
  advanceTimeline,
  createEmptyMap,
  createId,
  generatedAtYear,
  projectTemporalBounds,
  upsertTemporalStateAtYear,
  type TimelineState,
} from "../model/world";
import { activeMap } from "../model/worldSelectors";
import { syncAutoWikiArticles } from "../model/wikiSync";
import {
  alignMapFeaturesToGenerated,
  applyGeneratedCountries,
  enforceMapPlacementConstraints,
} from "../generator/mapPlacement";
import { ProjectExplorer } from "./ProjectExplorer";
import { SmartLinkOverlay } from "./SmartLinkOverlay";
import { TabBar } from "./TabBar";
import { TimelinePanel } from "./TimelinePanel";
import type { HeraldicAssetKind } from "../model/world";

const HistoryWindow = lazy(() =>
  import("./HistoryWindow").then((module) => ({ default: module.HistoryWindow })),
);
const MapEditorWindow = lazy(() =>
  import("./MapEditorWindow").then((module) => ({
    default: module.MapEditorWindow,
  })),
);
const MapGeneratorWindow = lazy(() =>
  import("./MapGeneratorWindow").then((module) => ({
    default: module.MapGeneratorWindow,
  })),
);
const ProjectHomeWindow = lazy(() =>
  import("./ProjectHomeWindow").then((module) => ({
    default: module.ProjectHomeWindow,
  })),
);
const SimulationWindow = lazy(() =>
  import("./SimulationWindow").then((module) => ({
    default: module.SimulationWindow,
  })),
);
const WikiWindow = lazy(() =>
  import("./WikiWindow").then((module) => ({ default: module.WikiWindow })),
);
const HeraldryStudioModal = lazy(() =>
  import("./HeraldryStudio").then((module) => ({
    default: module.HeraldryStudioModal,
  })),
);
const SettingsScreen = lazy(() =>
  import("./SettingsScreen").then((module) => ({
    default: module.SettingsScreen,
  })),
);
const NewMapDialog = lazy(() =>
  import("./NewMapDialog").then((module) => ({
    default: module.NewMapDialog,
  })),
);

type Props = {
  project: WorldProject;
  dirty: boolean;
  onChange: (project: WorldProject) => void;
  onSave: () => void;
  onExport: () => void;
  onImport: () => void;
  onHome: () => void;
};

function makeTab(
  type: WorkspaceTabType,
  title: string,
  mapId?: string,
  wikiCategoryId?: string | null,
  wikiEventCategory?: EventCategory | "all",
  wikiArticleId?: string,
): WorkspaceTab {
  return {
    id: createId(`tab-${type}`),
    type,
    title,
    mapId,
    wikiCategoryId,
    wikiEventCategory,
    wikiArticleId,
  };
}

export function WorkspaceShell({
  project,
  dirty,
  onChange,
  onSave,
  onExport,
  onImport,
  onHome,
}: Props) {
  const firstMap = activeMap(project);
  const [explorerCollapsed, setExplorerCollapsed] = useState(false);
  const [heraldryStudio, setHeraldryStudio] =
    useState<HeraldicAssetKind | null>(null);
  const [showNewMapDialog, setShowNewMapDialog] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [tabs, setTabs] = useState<WorkspaceTab[]>(() =>
    firstMap
      ? [
          makeTab(
            generatedAtYear(firstMap) ? "map" : "generator",
            generatedAtYear(firstMap) ? firstMap.title : "지도 생성기",
            firstMap.id,
          ),
        ]
      : [makeTab("home", "프로젝트 홈")],
  );
  const [activeTabId, setActiveTabId] = useState<string | null>(
    () => tabs[0]?.id ?? null,
  );
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;
  const currentMap =
    project.maps.find(
      (map) => map.id === (activeTab?.mapId ?? project.activeMapId),
    ) ?? firstMap;
  const timelineBounds = useMemo(
    () => projectTemporalBounds(project),
    [project],
  );

  const emitChange = (next: WorldProject) =>
    onChange(
      syncAutoWikiArticles({
        ...next,
        lastModifiedDate: new Date().toISOString(),
      }),
    );

  const updateMap = (map: MapData) => {
    const generated = generatedAtYear(map);
    const placementChanged =
      map.locations !== currentMap?.locations ||
      map.territories !== currentMap?.territories ||
      map.timeline.currentYear !== currentMap?.timeline.currentYear;
    const constrained =
      generated && placementChanged
        ? enforceMapPlacementConstraints(map, generated)
        : map;
    emitChange({
      ...project,
      activeMapId: constrained.id,
      maps: project.maps.map((item) =>
        item.id === constrained.id
          ? { ...constrained, lastModifiedDate: new Date().toISOString() }
          : item,
      ),
    });
  };

  const openTab = (
    type: WorkspaceTabType,
    mapId?: string,
    wikiCategoryId?: string | null,
    wikiEventCategory?: EventCategory | "all",
    wikiArticleId?: string,
  ) => {
    const resolvedMap =
      project.maps.find((map) => map.id === mapId) ?? currentMap;
    const existing = tabs.find((tab) => {
      if (tab.type !== type) return false;
      if (
        type === "map" ||
        type === "generator" ||
        type === "timeline" ||
        type === "simulation"
      )
        return tab.mapId === resolvedMap?.id;
      if (type === "wiki")
        return (
          tab.wikiCategoryId === wikiCategoryId &&
          (tab.wikiEventCategory ?? "all") === (wikiEventCategory ?? "all")
        );
      return true;
    });
    if (existing) {
      setTabs((items) =>
        items.map((item) =>
          item.id === existing.id
            ? { ...item, wikiArticleId: wikiArticleId ?? item.wikiArticleId }
            : item,
        ),
      );
      setActiveTabId(existing.id);
      return;
    }
    const title =
      type === "map"
        ? (resolvedMap?.title ?? "지도")
        : type === "generator"
          ? "지도 생성기"
          : type === "wiki"
            ? `${wikiCategoryId === null ? "미지정" : (project.wikiCategories.find((category) => category.id === wikiCategoryId)?.name ?? "세계관 문서")}${wikiEventCategory && wikiEventCategory !== "all" ? ` · ${wikiEventCategory}` : ""}`
            : type === "timeline"
              ? "연표"
              : type === "simulation"
                ? "환경"
                : type === "settings"
                  ? "설정"
                  : "프로젝트 홈";
    const tab = makeTab(
      type,
      title,
      resolvedMap?.id,
      wikiCategoryId,
      wikiEventCategory,
      wikiArticleId,
    );
    setTabs((previous) => [...previous, tab]);
    setActiveTabId(tab.id);
    if (resolvedMap) emitChange({ ...project, activeMapId: resolvedMap.id });
  };

  const openWikiArticle = (article: WikiArticle) =>
    openTab(
      "wiki",
      undefined,
      article.categoryId ?? null,
      article.eventCategory ?? "all",
      article.id,
    );
  const openWikiEntity = (
    entityType: "location" | "event",
    entityId: string,
  ) => {
    const article = project.wikiArticles.find(
      (item) =>
        item.sourceMapId === currentMap?.id &&
        item.sourceEntityId === entityId &&
        item.sourceEntityType === entityType,
    );
    if (article) {
      openWikiArticle(article);
      return;
    }
    const fallbackKey = entityType === "location" ? "location" : "event";
    const categoryId =
      project.wikiCategories.find(
        (category) => category.systemKey === fallbackKey,
      )?.id ?? null;
    openTab("wiki", undefined, categoryId, "all");
  };

  const closeTab = (id: string) => {
    setTabs((previous) => {
      const index = previous.findIndex((tab) => tab.id === id);
      const next = previous.filter((tab) => tab.id !== id);
      if (activeTabId === id)
        setActiveTabId(next[Math.max(0, index - 1)]?.id ?? next[0]?.id ?? null);
      return next;
    });
  };

  const setTimeline = (timeline: TimelineState) => {
    if (!currentMap) return;
    // 연도가 바뀌면 해당 시점의 장소·영토를 다시 검증한다. 같은 연도 안의 일·시간 이동은 재계산하지 않는다.
    const nextMap = { ...currentMap, timeline };
    const generated = generatedAtYear(nextMap);
    const constrained =
      generated && timeline.currentYear !== currentMap.timeline.currentYear
        ? enforceMapPlacementConstraints(nextMap, generated)
        : nextMap;
    onChange({
      ...project,
      activeMapId: currentMap.id,
      maps: project.maps.map((item) =>
        item.id === currentMap.id ? constrained : item,
      ),
    });
  };

  const setYear = (year: number) => {
    if (!currentMap) return;
    setTimeline({ ...currentMap.timeline, currentYear: Math.trunc(year) });
  };

  useEffect(() => {
    if (
      !currentMap?.timeline.isPlaying ||
      document.visibilityState === "hidden"
    )
      return;
    const timer = window.setTimeout(() => {
      setTimeline(
        advanceTimeline(
          project,
          currentMap.timeline,
          timelineBounds.maximumYear,
        ),
      );
    }, currentMap.timeline.playbackIntervalMs);
    return () => window.clearTimeout(timer);
  }, [
    currentMap?.timeline.currentYear,
    currentMap?.timeline.currentDayOfYear,
    currentMap?.timeline.currentMinuteOfDay,
    currentMap?.timeline.precision,
    currentMap?.timeline.isPlaying,
    currentMap?.timeline.playbackIntervalMs,
    timelineBounds.minimumYear,
    timelineBounds.maximumYear,
    project.worldSettings.orbitalPeriodDays,
    project.worldSettings.dayLengthHours,
  ]);

  useEffect(() => {
    document.documentElement.dataset.theme = project.theme;
    localStorage.setItem("world-map-editor-theme", project.theme);
  }, [project.theme]);

  const counts = useMemo(
    () => ({
      maps: project.maps.length,
      wiki: project.wikiArticles.length,
      events: currentMap?.events.length ?? 0,
    }),
    [
      project.maps.length,
      project.wikiArticles.length,
      currentMap?.events.length,
    ],
  );

  const addMap = (
    title: string,
    generationMode: SimulationMode,
    scaleMode: MapScaleMode,
    physicalWidthKm: number,
  ) => {
    const map = createEmptyMap(
      title,
      160,
      100,
      generationMode,
      scaleMode,
      physicalWidthKm,
    );
    emitChange({
      ...project,
      maps: [...project.maps, map],
      activeMapId: map.id,
    });
    const tab = makeTab("generator", "지도 생성기", map.id);
    setTabs((previous) => [...previous, tab]);
    setActiveTabId(tab.id);
    setShowNewMapDialog(false);
  };

  const applyGenerated = (generated: GeneratedMapData) => {
    if (!currentMap) return;
    const record = {
      seed: generated.settings.seed,
      settings: generated.settings,
      usedAt: generated.generatedAt,
    };
    const history = [
      record,
      ...currentMap.generatorSeedHistory.filter(
        (item) => item.seed !== record.seed,
      ),
    ].slice(0, 4);
    const countryResult = applyGeneratedCountries(currentMap, generated);
    const generatedMap = {
      ...countryResult.map,
      generatorSeedHistory: history,
      generatedStates: upsertTemporalStateAtYear(
        countryResult.map.generatedStates,
        countryResult.map.timeline.currentYear,
        countryResult.generated,
      ),
    };
    const aligned = alignMapFeaturesToGenerated(
      generatedMap,
      countryResult.generated,
    );
    emitChange({
      ...project,
      activeMapId: aligned.id,
      maps: project.maps.map((item) =>
        item.id === aligned.id
          ? { ...aligned, lastModifiedDate: new Date().toISOString() }
          : item,
      ),
    });
    setTabs((previous) => {
      const existing = previous.find(
        (tab) => tab.type === "map" && tab.mapId === aligned.id,
      );
      if (existing) {
        window.requestAnimationFrame(() => setActiveTabId(existing.id));
        return previous.map((tab) =>
          tab.id === existing.id ? { ...tab, title: aligned.title } : tab,
        );
      }
      const tab = makeTab("map", aligned.title, aligned.id);
      window.requestAnimationFrame(() => setActiveTabId(tab.id));
      return [...previous, tab];
    });
  };

  return (
    <div className="workspace-shell">
      <header className="workspace-topbar">
        <div className="window-controls">
          <button
            type="button"
            className="menu-button"
            onClick={() => openTab("home")}
          >
            프로젝트 홈
          </button>
          <button
            type="button"
            className="menu-button"
            onClick={() => setExplorerCollapsed((value) => !value)}
          >
            {explorerCollapsed ? "탐색기 펼치기" : "탐색기 접기"}
          </button>
          <button
            type="button"
            className="menu-button"
            onClick={() => setHeraldryStudio("flag")}
          >
            깃발 생성기
          </button>
          <button
            type="button"
            className="menu-button"
            onClick={() => setHeraldryStudio("coatOfArms")}
          >
            문장 생성기
          </button>
        </div>
        <div className="project-titlebar">
          <strong>{project.title}</strong>
          <span>
            v{project.version}
            {dirty ? " · 저장 안 됨" : ""}
          </span>
        </div>
        <div className="top-actions">
          <button type="button" onClick={onSave}>
            저장
          </button>
          <button type="button" onClick={onExport}>
            JSON 내보내기
          </button>
          <button type="button" onClick={onImport}>
            JSON 불러오기
          </button>
          <button
            type="button"
            className="theme-toggle-button"
            title="테마 전환"
            onClick={() =>
              emitChange({
                ...project,
                theme: project.theme === "dark" ? "light" : "dark",
              })
            }
          >
            {project.theme === "dark" ? "☀" : "☾"}
          </button>
          <button type="button" onClick={() => setShowSettings(true)}>
            설정
          </button>
          <button type="button" onClick={onHome}>
            시작 화면
          </button>
        </div>
      </header>

      <div
        className={`workspace-main ${explorerCollapsed ? "explorer-collapsed" : ""}`}
      >
        {!explorerCollapsed && (
          <ProjectExplorer
            project={project}
            onOpen={openTab}
            onAddMap={() => setShowNewMapDialog(true)}
            onChange={emitChange}
          />
        )}
        <section className="document-area">
          <TabBar
            tabs={tabs}
            activeTabId={activeTabId}
            onSelect={setActiveTabId}
            onClose={closeTab}
          />
          <div className="document-content">
            <Suspense
              fallback={
                <div className="workspace-welcome" role="status">
                  <strong>작업 창을 불러오는 중입니다.</strong>
                </div>
              }
            >
              {!activeTab && (
                <div className="workspace-welcome">
                  <strong>작업 창을 여세요.</strong>
                  <p>
                    프로젝트 탐색기에서 지도, 위키, 연표 또는 지도 생성기를
                    선택하세요.
                  </p>
                </div>
              )}
              {activeTab?.type === "map" && currentMap && (
                <MapEditorWindow
                  key={currentMap.id}
                  project={project}
                  map={currentMap}
                  onChange={updateMap}
                  onOpenGenerator={() => openTab("generator", currentMap.id)}
                  onOpenWikiEntity={openWikiEntity}
                />
              )}
              {activeTab?.type === "generator" && currentMap && (
                <MapGeneratorWindow
                  map={currentMap}
                  onApply={applyGenerated}
                  onMapChange={updateMap}
                  onOpenMap={() => openTab("map", currentMap.id)}
                />
              )}
              {activeTab?.type === "wiki" && (
                <WikiWindow
                  project={project}
                  onChange={emitChange}
                  initialCategoryId={activeTab.wikiCategoryId ?? null}
                  initialEventCategory={activeTab.wikiEventCategory ?? "all"}
                  initialArticleId={activeTab.wikiArticleId}
                  onNavigate={(target) =>
                    setTabs((items) =>
                      items.map((item) =>
                        item.id === activeTab.id
                          ? {
                              ...item,
                              wikiCategoryId: target.categoryId,
                              wikiEventCategory: target.eventCategory,
                              wikiArticleId: target.articleId,
                              title:
                                target.categoryId === null
                                  ? "미지정"
                                  : (project.wikiCategories.find(
                                      (category) =>
                                        category.id === target.categoryId,
                                    )?.name ?? "세계관 문서"),
                            }
                          : item,
                      ),
                    )
                  }
                />
              )}
              {activeTab?.type === "timeline" && currentMap && (
                <HistoryWindow
                  project={project}
                  map={currentMap}
                  onYearChange={setYear}
                  onOpenWikiArticle={openWikiArticle}
                />
              )}
              {activeTab?.type === "simulation" && currentMap && (
                <SimulationWindow
                  project={project}
                  map={currentMap}
                  onChange={emitChange}
                />
              )}
              {activeTab?.type === "home" && (
                <ProjectHomeWindow
                  project={project}
                  map={currentMap ?? null}
                  onChange={emitChange}
                  onMapChange={updateMap}
                />
              )}
            </Suspense>
          </div>
        </section>
      </div>

      {currentMap && (
        <TimelinePanel
          project={project}
          timeline={currentMap.timeline}
          minimumYear={timelineBounds.minimumYear}
          maximumYear={timelineBounds.maximumYear}
          eventYears={currentMap.events
            .filter((event) => !event.startTimeUnknown)
            .map((event) => event.startYear)}
          onTimelineChange={setTimeline}
          onPlayToggle={() =>
            setTimeline({
              ...currentMap.timeline,
              isPlaying: !currentMap.timeline.isPlaying,
            })
          }
          onSpeedChange={(playbackIntervalMs) =>
            setTimeline({ ...currentMap.timeline, playbackIntervalMs })
          }
          onCalendarChange={(timelineCalendarArticleId) =>
            emitChange({ ...project, timelineCalendarArticleId })
          }
        />
      )}
      <div className="status-bar">
        <span>지도 {counts.maps}</span>
        <span>위키 {counts.wiki}</span>
        <span>사건·사고 {counts.events}</span>
        <span className="status-spacer" />
        <span>
          {currentMap && generatedAtYear(currentMap)
            ? `현재 연도 지도 시드 ${generatedAtYear(currentMap)?.settings.seed}`
            : "현재 연도 생성 지형 없음"}
        </span>
      </div>
      <SmartLinkOverlay project={project} onChange={emitChange} />
      <Suspense fallback={null}>
        {heraldryStudio && (
          <HeraldryStudioModal
            project={project}
            kind={heraldryStudio}
            onChange={emitChange}
            onClose={() => setHeraldryStudio(null)}
          />
        )}
        {showSettings && (
          <div
            className="settings-modal-backdrop"
            role="dialog"
            aria-modal="true"
            aria-label="설정"
          >
            <SettingsScreen
              embedded
              onBack={() => setShowSettings(false)}
              project={project}
              onProjectChange={emitChange}
            />
          </div>
        )}
        {showNewMapDialog && (
          <NewMapDialog
            suggestedName={`새 지도 ${project.maps.length + 1}`}
            onCancel={() => setShowNewMapDialog(false)}
            onCreate={addMap}
          />
        )}
      </Suspense>
    </div>
  );
}
