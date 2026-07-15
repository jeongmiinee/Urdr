import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { FamilyProfilePanel, GovernmentProfilePanel, ItemProfilePanel, PersonProfilePanel, ReligionProfilePanel } from "./GenealogyPanels";
import { CalendarProfilePanel } from "./CalendarProfilePanel";
import { WikiLinkedText } from "./WikiReferences";
import {
  articleKindLabel,
  eventCategoriesForSystemKey,
  isEventDocumentCategory,
} from "./wikiArticleKinds";
import {
  createId,
  createDefaultCalendarProfile,
  EVENT_CATEGORY_LABELS,
  formatTimelineMoment,
  getStateAtYear,
  type EventCategory,
  type Faction,
  type WikiArticle,
  type WikiCategory,
  type WorldProject,
} from "../model/world";

type WikiNavigationTarget = { categoryId: string | null; eventCategory: EventCategory | "all"; articleId: string };
type Props = { project: WorldProject; onChange: (project: WorldProject) => void; initialCategoryId: string | null; initialEventCategory?: EventCategory | "all"; initialArticleId?: string; onNavigate?: (target: WikiNavigationTarget) => void };

const LinkedEntityHistory = lazy(() =>
  import("./WikiEntityHistory").then((module) => ({ default: module.LinkedEntityHistory })),
);

export function WikiWindow({ project, onChange, initialCategoryId, initialEventCategory = "all", initialArticleId, onNavigate }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [backStack, setBackStack] = useState<string[]>([]);
  const [forwardStack, setForwardStack] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [currentOnly, setCurrentOnly] = useState(() => localStorage.getItem("world-archive-wiki-current-only") === "true");
  const [editMode, setEditMode] = useState(false);
  const [categoryManageMode, setCategoryManageMode] = useState(false);
  const [bulkSelectedIds, setBulkSelectedIds] = useState<string[]>([]);
  const [showDocumentAddDialog, setShowDocumentAddDialog] = useState(false);
  const [documentAddQuery, setDocumentAddQuery] = useState("");
  const [draftProject, setDraftProject] = useState<WorldProject | null>(null);
  const displayProject = editMode && draftProject ? draftProject : project;
  const validCategoryIds = useMemo(() => new Set(displayProject.wikiCategories.map((category) => category.id)), [displayProject.wikiCategories]);
  const articleCategoryId = (article: WikiArticle): string | null => article.categoryId && validCategoryIds.has(article.categoryId) ? article.categoryId : null;
  const categoryDefinition = displayProject.wikiCategories.find((category) => category.id === initialCategoryId);
  const categoryName = initialCategoryId === null ? "미지정" : categoryDefinition?.name ?? "삭제된 카테고리";
  const categoryScopeIds = useMemo(() => {
    if (initialCategoryId === null) return new Set<string | null>([null]);
    const ids = new Set<string | null>();
    const collect = (id: string) => { ids.add(id); for (const child of displayProject.wikiCategories.filter((item) => item.parentId === id)) collect(child.id); };
    collect(initialCategoryId);
    return ids;
  }, [displayProject.wikiCategories, initialCategoryId]);
  const categoryArticles = useMemo(() => displayProject.wikiArticles.filter((article) => categoryScopeIds.has(articleCategoryId(article)) && (!isEventDocumentCategory(categoryDefinition?.systemKey) || initialEventCategory === "all" || article.eventCategory === initialEventCategory)), [displayProject.wikiArticles, displayProject.wikiCategories, categoryScopeIds, categoryDefinition?.systemKey, initialEventCategory]);
  const currentTimelineYear = (displayProject.maps.find((item) => item.id === displayProject.activeMapId) ?? displayProject.maps[0])?.timeline.currentYear ?? 0;
  const articleExistsAtCurrentYear = (article: WikiArticle): boolean => {
    const faction = article.factionProfile ?? displayProject.maps.flatMap((item) => item.factions).find((item) => item.id === article.sourceEntityId);
    if (faction) return (faction.foundedYear === undefined || faction.foundedYear <= currentTimelineYear) && (faction.dissolvedYear === undefined || faction.dissolvedYear >= currentTimelineYear);
    if (article.personProfile) return (article.personProfile.birthYear === undefined || article.personProfile.birthYear <= currentTimelineYear) && (article.personProfile.deathYear === undefined || article.personProfile.deathYear >= currentTimelineYear);
    const map = displayProject.maps.find((item) => item.id === article.sourceMapId);
    const location = map?.locations.find((item) => item.id === article.sourceEntityId);
    if (location) return Boolean(getStateAtYear(location.states, currentTimelineYear));
    const event = map?.events.find((item) => item.id === article.sourceEntityId) ?? article.eventProfile;
    if (event) return !event.startTimeUnknown && event.startYear <= currentTimelineYear && (event.endYear === null || event.endYear >= currentTimelineYear);
    if (article.familyProfile) return article.familyProfile.members.some((member) => (member.birthYear === undefined || member.birthYear <= currentTimelineYear) && (member.deathYear === undefined || member.deathYear >= currentTimelineYear));
    return true;
  };
  const filtered = useMemo(() => categoryArticles.filter((article) => (!currentOnly || articleExistsAtCurrentYear(article)) && `${article.title} ${article.summary} ${article.tags.join(" ")}`.toLowerCase().includes(query.toLowerCase())), [categoryArticles, query, currentOnly, currentTimelineYear]);
  const selected = displayProject.wikiArticles.find((article) => article.id === selectedId) ?? categoryArticles[0] ?? null;
  const hasLinkedEntityHistory = Boolean(
    selected &&
      (selected.eventProfile ||
        selected.factionProfile ||
        (selected.sourceMapId && selected.sourceEntityId && selected.sourceEntityType)),
  );
  const selectedSystemKey: WikiCategory = selected ? ((displayProject.wikiCategories.find((category) => category.id === articleCategoryId(selected))?.templateKey ?? displayProject.wikiCategories.find((category) => category.id === articleCategoryId(selected))?.systemKey ?? selected.category ?? "other") as WikiCategory) : "other";

  useEffect(() => {
    const requested = initialArticleId ? project.wikiArticles.find((article) => article.id === initialArticleId) : undefined;
    const first = requested ?? project.wikiArticles.find((article) => {
      const categoryId = article.categoryId && project.wikiCategories.some((category) => category.id === article.categoryId) ? article.categoryId : null;
      const category = project.wikiCategories.find((item) => item.id === initialCategoryId);
      const descendantIds = new Set<string | null>([initialCategoryId]);
      let changed = true;
      while (changed) { changed = false; for (const item of project.wikiCategories) if (item.parentId && descendantIds.has(item.parentId) && !descendantIds.has(item.id)) { descendantIds.add(item.id); changed = true; } }
      return descendantIds.has(categoryId) && (!isEventDocumentCategory(category?.systemKey) || initialEventCategory === "all" || article.eventCategory === initialEventCategory);
    });
    setSelectedId(first?.id ?? null); setEditMode(false); setCategoryManageMode(false); setBulkSelectedIds([]); setShowDocumentAddDialog(false); setDraftProject(null);
  }, [initialCategoryId, initialEventCategory, initialArticleId]);


  const navigateToArticle = (id: string, historyMode: "push" | "back" | "forward" = "push") => {
    const target = project.wikiArticles.find((article) => article.id === id);
    if (!target || target.id === selectedId) return;
    if (editMode && !window.confirm("저장하지 않은 편집 내용을 버리고 연결 문서로 이동할까요?")) return;
    if (historyMode === "push" && selectedId) { setBackStack((items) => [...items.slice(-49), selectedId]); setForwardStack([]); }
    setSelectedId(target.id); setEditMode(false); setDraftProject(null);
    onNavigate?.({ categoryId: target.categoryId ?? null, eventCategory: target.eventCategory ?? "all", articleId: target.id });
  };
  const goBack = () => {
    const target = backStack[backStack.length - 1]; if (!target) return;
    if (selectedId) setForwardStack((items) => [selectedId, ...items].slice(0, 50));
    setBackStack((items) => items.slice(0, -1)); navigateToArticle(target, "back");
  };
  const goForward = () => {
    const target = forwardStack[0]; if (!target) return;
    if (selectedId) setBackStack((items) => [...items.slice(-49), selectedId]);
    setForwardStack((items) => items.slice(1)); navigateToArticle(target, "forward");
  };

  const beginEdit = () => { setDraftProject(structuredClone(project)); setEditMode(true); };
  const cancelEdit = () => { setDraftProject(null); setEditMode(false); };
  const saveEdit = () => { if (!draftProject) return; onChange({ ...draftProject, lastModifiedDate: new Date().toISOString() }); setDraftProject(null); setEditMode(false); };
  const updateArticle = (patch: Partial<WikiArticle>) => {
    if (!selected) return;
    const manualPatch: Partial<WikiArticle> = {
      ...patch,
      ...(Object.prototype.hasOwnProperty.call(patch, "title") ? { manualTitle: true } : {}),
      ...(Object.prototype.hasOwnProperty.call(patch, "summary") ? { manualSummary: true } : {}),
    };
    setDraftProject((current) => current ? { ...current, wikiArticles: current.wikiArticles.map((article) => article.id === selected.id ? { ...article, ...manualPatch, lastModifiedDate: new Date().toISOString() } : article) } : current);
  };
  const updateDraftProject = (next: WorldProject) => setDraftProject(next);
  const updateGovernmentProfile = (governmentProfile: NonNullable<WikiArticle["governmentProfile"]>) => {
    if (!selected) return;
    setDraftProject((current) => {
      if (!current) return current;
      const suffix = governmentProfile.countryNameSuffix.trim();
      const renameFaction = (faction: Faction): Faction => {
        if (faction.kind !== "country" || faction.countryProfile?.politicalSystemArticleId !== selected.id) return faction;
        const root = faction.countryProfile.nameRoot?.trim() || faction.name;
        const profile = { ...faction.countryProfile, nameRoot: root };
        const name = profile.showRegimeSuffix === false || !suffix
          ? root
          : `${root}${profile.spaceBeforeRegimeSuffix === false ? "" : " "}${suffix}`.trim();
        return { ...faction, name, countryProfile: profile };
      };
      return {
        ...current,
        wikiArticles: current.wikiArticles.map((candidate) => {
          if (candidate.id === selected.id) return { ...candidate, governmentProfile, lastModifiedDate: new Date().toISOString() };
          if (candidate.factionProfile) return { ...candidate, factionProfile: renameFaction(candidate.factionProfile), title: renameFaction(candidate.factionProfile).name };
          return candidate;
        }),
        maps: current.maps.map((map) => ({ ...map, factions: map.factions.map(renameFaction) })),
      };
    });
  };
  const addArticle = () => {
    const now = new Date().toISOString(); const base = structuredClone(project);
    const aggregateChildren = project.wikiCategories.filter((category) => category.parentId === initialCategoryId);
    const preferred = aggregateChildren.find((category) => ["war", "organization", "location"].includes(category.systemKey ?? "")) ?? aggregateChildren[0];
    const rootCategory = project.wikiCategories.find((category) => category.id === initialCategoryId);
    const targetCategoryId = rootCategory?.systemKey || rootCategory?.templateKey ? initialCategoryId : (preferred?.id ?? initialCategoryId);
    const targetDefinition = project.wikiCategories.find((category) => category.id === targetCategoryId);
    const initialSystemKey = targetDefinition?.templateKey ?? targetDefinition?.systemKey ?? "other";
    const article: WikiArticle = {
      id: createId("wiki"), title: "새 문서", category: initialSystemKey, categoryId: targetCategoryId,
      summary: "", content: "", tags: [], linkedMapEntityIds: [],
      eventCategory: isEventDocumentCategory(initialSystemKey) ? (initialSystemKey === "war" ? "war" : initialSystemKey === "battle" ? "battle" : initialEventCategory !== "all" ? initialEventCategory : eventCategoriesForSystemKey(initialSystemKey)[0]) : undefined,
      eventProfile: isEventDocumentCategory(initialSystemKey) ? { id: createId("embedded-event"), title: "새 문서", startYear: project.maps[0]?.timeline.currentYear ?? 0, endYear: project.maps[0]?.timeline.currentYear ?? 0, category: initialSystemKey === "war" ? "war" : initialSystemKey === "battle" ? "battle" : initialSystemKey === "accident" ? "accident" : "incident", description: "", location: null, startTimeUnknown: false, endTimeUnknown: false, startDateTime: { year: project.maps[0]?.timeline.currentYear ?? 0 }, endDateTime: { year: project.maps[0]?.timeline.currentYear ?? 0 }, participants: [], chronology: [], relatedLocationIds: [], relatedFactionIds: [], relatedTerritoryIds: [] } : undefined,
      factionProfile: ["country", "faction", "organization"].includes(initialSystemKey) ? { id: createId("embedded-faction"), kind: initialSystemKey as "country" | "faction" | "organization", name: "새 문서", color: "#5f8fb3", activityRange: "land_centered", summary: "", description: "", leaderStatus: "undecided", ...(initialSystemKey === "country" ? { hasTerritory: true, countryProfile: { nameRoot: "새", showRegimeSuffix: true, spaceBeforeRegimeSuffix: true, politicalSystem: "", symbol: "", languageArticleIds: [], cultureArticleIds: [], majorLocationIds: [] } } : { hasTerritory: false, groupProfile: { symbol: "", ideology: "", alignment: "", goals: "", headquartersStatus: "undecided", languageArticleIds: [] } }) } : undefined,
      calendarProfile: initialSystemKey === "calendar" ? createDefaultCalendarProfile() : undefined,
      governmentProfile: initialSystemKey === "government" ? { countryNameSuffix: "" } : undefined,
      personProfile: initialSystemKey === "person" ? { organizationArticleIds: [], factionArticleIds: [], spouseArticleIds: [], childArticleIds: [], notes: "" } : undefined,
      familyProfile: initialSystemKey === "family" ? { displayMode: "all", members: [] } : undefined,
      itemProfile: initialSystemKey === "item" ? { itemType: "", origin: "", condition: "", ownershipHistory: [] } : undefined,
      religionProfile: initialSystemKey === "religion" ? { leaderTitle: "", symbol: "", alignment: "", relatedOrganizationIds: [] } : undefined,
      createdDate: now, lastModifiedDate: now,
    };
    base.wikiArticles.push(article); setDraftProject(base); setSelectedId(article.id); setEditMode(true);
  };
  const deleteSelected = () => { if (!selected || selected.autoGenerated) return; setDraftProject((current) => current ? { ...current, wikiArticles: current.wikiArticles.filter((article) => article.id !== selected.id) } : current); setSelectedId(null); };

  const toggleBulk = (id: string) => setBulkSelectedIds((items) => items.includes(id) ? items.filter((item) => item !== id) : [...items, id]);
  const addNewInCategory = () => { addArticle(); setCategoryManageMode(false); };
  const targetCategory = () => {
    const aggregateChildren = project.wikiCategories.filter((category) => category.parentId === initialCategoryId);
    const preferred = aggregateChildren.find((category) => ["war", "organization", "location"].includes(category.systemKey ?? "")) ?? aggregateChildren[0];
    const root = project.wikiCategories.find((category) => category.id === initialCategoryId);
    const id = root?.systemKey || root?.templateKey ? initialCategoryId : (preferred?.id ?? initialCategoryId);
    const definition = project.wikiCategories.find((item) => item.id === id);
    return { id, key: (definition?.templateKey ?? definition?.systemKey ?? "other") as WikiCategory };
  };
  const assignBulkToCategory = () => {
    if (bulkSelectedIds.length === 0) return;
    const target = targetCategory();
    onChange({ ...project, wikiArticles: project.wikiArticles.map((article) => bulkSelectedIds.includes(article.id) ? { ...article, categoryId: target.id, category: target.key } : article) });
    setBulkSelectedIds([]); setShowDocumentAddDialog(false); setDocumentAddQuery("");
  };
  const removeArticleFromCategory = (articleId: string) => {
    onChange({ ...project, wikiArticles: project.wikiArticles.map((article) => article.id === articleId ? { ...article, categoryId: null } : article) });
    if (selectedId === articleId) setSelectedId(null);
  };
  const unassignedArticles = project.wikiArticles.filter((article) => !article.categoryId || !project.wikiCategories.some((category) => category.id === article.categoryId));

  return <>
    <section className="wiki-window">
      <aside className="wiki-list-panel">
        <div className="window-heading compact"><p className="eyebrow">WORLD WIKI</p><h2>{categoryName}{initialEventCategory !== "all" ? ` · ${EVENT_CATEGORY_LABELS[initialEventCategory]}` : ""}</h2><small>{categoryArticles.length}개 문서</small></div>
        <><div className="wiki-search"><input placeholder={`${categoryName} 문서 검색`} value={query} onChange={(event) => setQuery(event.target.value)} /><button type="button" className={categoryManageMode ? "active" : ""} onClick={() => { setCategoryManageMode((value) => !value); setBulkSelectedIds([]); setShowDocumentAddDialog(false); }}>{categoryManageMode ? "완료" : "편집"}</button></div><button type="button" className={`wiki-current-filter ${currentOnly ? "active" : ""}`} onClick={() => setCurrentOnly((value) => { const next = !value; localStorage.setItem("world-archive-wiki-current-only", String(next)); return next; })}>{currentOnly ? "✓ 현재 존재하는 항목만 표시" : "현재 존재하는 항목만 표시"}</button></>
        {categoryManageMode && <div className="category-document-toolbar"><button type="button" className="primary-button" onClick={addNewInCategory}>새 문서</button><button type="button" onClick={() => { setShowDocumentAddDialog(true); setBulkSelectedIds([]); }}>문서 추가</button></div>}
        <div className="article-list">{filtered.map((article) => <div className={`article-list-edit-row ${article.id === selected?.id ? "active" : ""}`} key={article.id}><button type="button" className={article.id === selected?.id ? "active" : ""} onClick={() => { if (editMode && !window.confirm("저장하지 않은 편집 내용을 버리고 다른 문서로 이동할까요?")) return; navigateToArticle(article.id); cancelEdit(); }}><span>{articleKindLabel(article)}{article.autoGenerated ? " · 자동" : ""}</span><strong>{article.title}</strong><small>{article.summary || "설명 없음"}</small></button>{categoryManageMode && <button type="button" className="article-category-remove" title="카테고리에서 제거" onClick={() => removeArticleFromCategory(article.id)}>삭제</button>}</div>)}{filtered.length === 0 && <p className="empty-hint">이 카테고리에 표시할 문서가 없습니다.</p>}</div>
      </aside>
      <article className="wiki-editor" data-link-scope={selected ? `wiki:${selected.id}` : "wiki:none"}>{selected ? <><div className="wiki-navigation-bar"><button type="button" onClick={goBack} disabled={backStack.length === 0} title="이전 문서">← 뒤로</button><button type="button" onClick={goForward} disabled={forwardStack.length === 0} title="다음 문서">앞으로 →</button></div><div className="wiki-calendar-context"><span>현재 표시 역법</span><strong>{formatTimelineMoment(displayProject, (displayProject.maps.find((item) => item.id === displayProject.activeMapId) ?? displayProject.maps[0])?.timeline ?? { minimumYear: 0, maximumYear: 0, currentYear: 0, currentDayOfYear: 0, currentMinuteOfDay: 0, precision: "year", isPlaying: false, playbackIntervalMs: 1000 })}</strong></div><div className="wiki-document-title-row">{editMode ? <input className="wiki-title-input" value={selected.title} onChange={(event) => updateArticle({ title: event.target.value })} /> : <h1>{selected.title}</h1>}<div className="editor-save-row">{editMode ? <><button type="button" className="primary-button" onClick={saveEdit}>편집 완료</button><button type="button" className="secondary-button" onClick={cancelEdit}>취소</button></> : <button type="button" className="secondary-button wiki-edit-entry-button" onClick={beginEdit}>편집</button>}</div></div>{editMode && <div className="draft-edit-banner">입력 내용은 아직 초안입니다. <strong>편집 완료</strong>를 눌러야 저장됩니다.</div>}{editMode && <div className="wiki-edit-controls"><label>카테고리<select value={articleCategoryId(selected) ?? ""} onChange={(event) => { const categoryId = event.target.value || null; const category = (displayProject.wikiCategories.find((item) => item.id === categoryId)?.templateKey ?? displayProject.wikiCategories.find((item) => item.id === categoryId)?.systemKey ?? "other") as WikiCategory; updateArticle({ categoryId, category }); }}><option value="">미지정</option>{displayProject.wikiCategories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>{isEventDocumentCategory(selected.category) && <label>사건 하위 분류<select value={selected.eventCategory ?? eventCategoriesForSystemKey(selected.category)[0]} disabled={selected.autoGenerated || ["war", "battle"].includes(selected.category)} onChange={(event) => updateArticle({ eventCategory: event.target.value as EventCategory })}>{eventCategoriesForSystemKey(selected.category).map((category) => <option key={category} value={category}>{EVENT_CATEGORY_LABELS[category]}</option>)}</select></label>}<label>태그<input value={selected.tags.join(", ")} onChange={(event) => updateArticle({ tags: event.target.value.split(",").map((tag) => tag.trim()).filter(Boolean) })} /></label>{!selected.autoGenerated && <button type="button" className="danger-button" onClick={deleteSelected}>문서 삭제</button>}</div>}{selected.autoGenerated && <div className="auto-wiki-banner"><strong>자동 동기화 문서</strong><span>지도와 연표의 변경 사항은 자동 반영되며 추가 본문과 카테고리는 직접 관리할 수 있습니다.</span></div>}{editMode ? <label>요약<input value={selected.summary} onChange={(event) => updateArticle({ summary: event.target.value })} /></label> : <p className="wiki-document-summary"><WikiLinkedText project={displayProject} text={selected.summary || "요약 없음"} onOpenArticle={(id)=>navigateToArticle(id)} /></p>}{selectedSystemKey === "person" && <PersonProfilePanel project={displayProject} article={selected} editMode={editMode} onChange={(personProfile) => updateArticle({ personProfile })} onOpenArticle={(id) => navigateToArticle(id)} />}{selectedSystemKey === "family" && <FamilyProfilePanel project={displayProject} article={selected} editMode={editMode} onChange={(familyProfile) => updateArticle({ familyProfile })} onProjectChange={updateDraftProject} onProjectAndProfileChange={(nextProject, familyProfile) => setDraftProject({ ...nextProject, wikiArticles: nextProject.wikiArticles.map((candidate) => candidate.id === selected.id ? { ...candidate, familyProfile, lastModifiedDate: new Date().toISOString() } : candidate) })} onOpenArticle={(id) => navigateToArticle(id)} />}{selectedSystemKey === "item" && <ItemProfilePanel project={displayProject} article={selected} editMode={editMode} onChange={(itemProfile) => updateArticle({ itemProfile })} />}{selectedSystemKey === "religion" && <ReligionProfilePanel project={displayProject} article={selected} editMode={editMode} onChange={(religionProfile) => updateArticle({ religionProfile })} />}{selectedSystemKey === "calendar" && <CalendarProfilePanel project={displayProject} article={selected} editMode={editMode} onChange={(calendarProfile) => updateArticle({ calendarProfile })} />}{selectedSystemKey === "government" && <GovernmentProfilePanel article={selected} editMode={editMode} onChange={updateGovernmentProfile} />}{hasLinkedEntityHistory && <Suspense fallback={null}><LinkedEntityHistory project={displayProject} article={selected} editMode={editMode} onProjectChange={updateDraftProject} onOpenArticle={(id) => navigateToArticle(id)} /></Suspense>}{editMode ? <label className="wiki-content-label">추가 설정 및 본문 <small>[[문서명]] 형식으로 링크할 수 있습니다.</small><textarea value={selected.content} onChange={(event) => updateArticle({ content: event.target.value })} /></label> : selected.content && <section className="wiki-body-view"><h3>본문</h3><p><WikiLinkedText project={displayProject} text={selected.content} onOpenArticle={(id)=>navigateToArticle(id)} /></p></section>}<footer className="document-meta">마지막 수정: {new Date(selected.lastModifiedDate).toLocaleString("ko-KR")}</footer></> : <div className="empty-document"><strong>{categoryName} 문서가 없습니다.</strong><p>새 문서를 만들거나 지도 요소를 추가하세요.</p><button type="button" className="primary-button" onClick={addArticle}>문서 만들기</button></div>}</article>
    </section>
    {showDocumentAddDialog && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowDocumentAddDialog(false); }}><section className="document-add-dialog" role="dialog" aria-modal="true" aria-label="미지정 문서 추가"><div className="dialog-heading"><div><p className="eyebrow">ADD DOCUMENTS</p><h2>미지정 문서 추가</h2><p>현재 카테고리에 연결할 문서를 선택하세요.</p></div><button type="button" className="icon-button" onClick={() => setShowDocumentAddDialog(false)}>×</button></div><input className="document-add-search" placeholder="미지정 문서 검색" value={documentAddQuery} onChange={(event) => setDocumentAddQuery(event.target.value)} /><div className="bulk-document-list">{unassignedArticles.filter((article) => `${article.title} ${article.summary}`.toLowerCase().includes(documentAddQuery.toLowerCase())).map((article) => <label key={article.id}><input type="checkbox" checked={bulkSelectedIds.includes(article.id)} onChange={() => toggleBulk(article.id)} /><span>{article.title}</span><small>{articleKindLabel(article)}</small></label>)}{unassignedArticles.length === 0 && <p className="empty-hint">추가할 미지정 문서가 없습니다.</p>}</div><div className="dialog-actions"><span>{bulkSelectedIds.length}개 선택</span><button type="button" onClick={() => setShowDocumentAddDialog(false)}>취소</button><button type="button" className="primary-button" disabled={bulkSelectedIds.length === 0} onClick={assignBulkToCategory}>문서 추가</button></div></section></div>}
  </>;
}
