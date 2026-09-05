import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { FamilyProfilePanel, GovernmentProfilePanel, ItemProfilePanel, PersonProfilePanel, ReligionProfilePanel } from "./GenealogyPanels";
import { CalendarProfilePanel } from "./CalendarProfilePanel";
import { WikiLinkedText } from "./WikiReferences";
import {
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
  type WikiDocumentSection,
  type WorldProject,
} from "../model/world";

function DocumentListTitle({ title }: { title: string }) {
  const viewportRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLSpanElement>(null);
  const [marquee, setMarquee] = useState({ overflowing: false, durationSeconds: 1.2 });
  useLayoutEffect(() => {
    const measure = () => {
      const viewport = viewportRef.current;
      const content = contentRef.current;
      if (!viewport || !content) return;
      const overflow = Math.max(0, content.scrollWidth - viewport.clientWidth);
      setMarquee({
        overflowing: overflow > 1,
        durationSeconds: Math.max(1.05, Math.min(3.2, overflow / 82)),
      });
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    if (viewportRef.current) observer?.observe(viewportRef.current);
    if (contentRef.current) observer?.observe(contentRef.current);
    return () => observer?.disconnect();
  }, [title]);
  return <strong ref={viewportRef} className={`article-list-title marquee-viewport${marquee.overflowing ? " overflowing" : ""}`} data-user-authored="true">
    <span ref={contentRef} className="marquee-content" style={{ "--marquee-duration": `${marquee.durationSeconds}s` } as CSSProperties}>{title}</span>
  </strong>;
}
import { useLocalization } from "../localization";
import { normalizeSearchText } from "../formatting";
import { defaultRpgDataForCategory } from "../rpg/schema";
import { RpgArticlePanel } from "./RpgArticlePanel";
import { DiseaseProfilePanel } from "./DiseaseProfilePanel";
import { isLanguageCategory, LanguageProfilePanel } from "./LanguageProfilePanel";
import { CultureProfilePanel, isCultureCategory } from "./CultureProfilePanel";
import { isTechnologyCategory, TechnologyProfilePanel } from "./TechnologyProfilePanel";
import { WorldProfilePanel } from "./WorldProfilePanel";

type WikiNavigationTarget = { categoryId: string | null; eventCategory: EventCategory | "all"; articleId: string };
type Props = { project: WorldProject; onChange: (project: WorldProject) => void; initialCategoryId: string | null; initialEventCategory?: EventCategory | "all"; initialArticleId?: string; onNavigate?: (target: WikiNavigationTarget) => void };

const LinkedEntityHistory = lazy(() =>
  import("./WikiEntityHistory").then((module) => ({ default: module.LinkedEntityHistory })),
);

function WikiDocumentBody({
  project,
  article,
  editMode,
  onChange,
  onOpenArticle,
}: {
  project: WorldProject;
  article: WikiArticle;
  editMode: boolean;
  onChange: (patch: Partial<WikiArticle>) => void;
  onOpenArticle: (id: string) => void;
}) {
  const { language, t } = useLocalization();
  const sections = article.documentSections ?? [];
  const updateSections = (next: WikiDocumentSection[]) => onChange({ documentSections: next });
  const updateSection = (id: string, patch: Partial<WikiDocumentSection>) => updateSections(
    sections.map((section) => section.id === id ? { ...section, ...patch } : section),
  );
  const childrenOf = (parentId: string | null) => sections.filter((section) => section.parentId === parentId);
  const depthOf = (section: WikiDocumentSection): 1 | 2 | 3 | 4 => {
    let depth = 1;
    let parentId = section.parentId;
    const visited = new Set([section.id]);
    while (parentId && depth < 4 && !visited.has(parentId)) {
      visited.add(parentId);
      depth += 1;
      parentId = sections.find((candidate) => candidate.id === parentId)?.parentId ?? null;
    }
    return depth as 1 | 2 | 3 | 4;
  };
  const flattenTree = (siblingOverrides = new Map<string, WikiDocumentSection[]>()) => {
    const result: WikiDocumentSection[] = [];
    const visit = (parentId: string | null, depth: 1 | 2 | 3 | 4) => {
      const key = parentId ?? "__root__";
      const siblings = siblingOverrides.get(key) ?? childrenOf(parentId);
      for (const section of siblings) {
        result.push({ ...section, parentId, level: depth, includeInToc: true });
        if (depth < 4) visit(section.id, (depth + 1) as 2 | 3 | 4);
      }
    };
    visit(null, 1);
    return result;
  };
  const moveSection = (section: WikiDocumentSection, direction: -1 | 1) => {
    const siblings = childrenOf(section.parentId);
    const index = siblings.findIndex((candidate) => candidate.id === section.id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= siblings.length) return;
    const nextSiblings = [...siblings];
    [nextSiblings[index], nextSiblings[target]] = [nextSiblings[target], nextSiblings[index]];
    updateSections(flattenTree(new Map([[section.parentId ?? "__root__", nextSiblings]])));
  };
  const addSection = (parentId: string | null = null) => {
    const parent = parentId ? sections.find((section) => section.id === parentId) : undefined;
    const level = parent ? Math.min(4, depthOf(parent) + 1) as 1 | 2 | 3 | 4 : 1;
    if (level > 4) return;
    updateSections([...sections, {
    id: createId("wiki-section"),
    title: language === "ko" ? "새 항목" : "New Section",
    content: "",
    parentId,
    level,
    includeInToc: true,
    }]);
  };
  const deleteSection = (section: WikiDocumentSection) => {
    const descendantIds = new Set<string>();
    const collect = (parentId: string) => {
      for (const child of childrenOf(parentId)) {
        descendantIds.add(child.id);
        collect(child.id);
      }
    };
    collect(section.id);
    if (descendantIds.size > 0 && !window.confirm(language === "ko"
      ? `하위 항목 ${descendantIds.size}개도 함께 삭제할까요?`
      : `Delete this section and its ${descendantIds.size} child sections?`)) return;
    updateSections(sections.filter((candidate) => candidate.id !== section.id && !descendantIds.has(candidate.id)));
  };
  const orderedSections = flattenTree();
  const numbering = new Map<string, string>();
  const numberChildren = (parentId: string | null, prefix: number[] = []) => {
    childrenOf(parentId).forEach((section, index) => {
      const path = [...prefix, index + 1];
      numbering.set(section.id, path.join("."));
      numberChildren(section.id, path);
    });
  };
  numberChildren(null);
  const sectionAnchor = (section: WikiDocumentSection) => `wiki-section-${article.id}-${section.id}`;
  const openSection = (section: WikiDocumentSection) => {
    const target = document.getElementById(sectionAnchor(section));
    target?.scrollIntoView({ behavior: "smooth", block: "start" });
    target?.focus({ preventScroll: true });
  };

  const renderEditorSection = (section: WikiDocumentSection) => {
    const depth = depthOf(section);
    const siblings = childrenOf(section.parentId);
    const siblingIndex = siblings.findIndex((candidate) => candidate.id === section.id);
    return <div className={`wiki-section-editor-branch depth-${depth}`} key={section.id}>
      <article className="wiki-section-edit-card">
        <div className="wiki-section-edit-heading">
          <span className="wiki-section-number">{numbering.get(section.id)}</span>
          <input aria-label={language === "ko" ? "목차 제목" : "Section title"} value={section.title} onChange={(event) => updateSection(section.id, { title: event.target.value })} />
          {depth < 4 && <button type="button" className="secondary-button section-add-child" onClick={() => addSection(section.id)}>＋ {t("wiki.addChildSection")}</button>}
          <button type="button" className="icon-button" aria-label={language === "ko" ? "위로 이동" : "Move up"} title={language === "ko" ? "위로 이동" : "Move up"} disabled={siblingIndex === 0} onClick={() => moveSection(section, -1)}>↑</button>
          <button type="button" className="icon-button" aria-label={language === "ko" ? "아래로 이동" : "Move down"} title={language === "ko" ? "아래로 이동" : "Move down"} disabled={siblingIndex === siblings.length - 1} onClick={() => moveSection(section, 1)}>↓</button>
          <button type="button" className="icon-button danger-ghost" aria-label={language === "ko" ? "목차 항목 삭제" : "Delete section"} title={language === "ko" ? "목차 항목 삭제" : "Delete section"} onClick={() => deleteSection(section)}>×</button>
        </div>
        <textarea aria-label={`${section.title} ${language === "ko" ? "내용" : "content"}`} value={section.content} onChange={(event) => updateSection(section.id, { content: event.target.value })} />
      </article>
      {childrenOf(section.id).map(renderEditorSection)}
    </div>;
  };

  if (editMode) return (
    <>
      <label className="wiki-content-label">추가 설정 및 본문 <small>[[문서명]] 형식으로 링크할 수 있습니다.</small><textarea value={article.content} onChange={(event) => onChange({ content: event.target.value })} /></label>
      <section className="wiki-section-editor">
        <div className="section-heading-row">
          <strong>{t("wiki.contents")}</strong>
          <button type="button" className="secondary-button" onClick={() => addSection(null)}>＋ {t("wiki.addSection")}</button>
        </div>
        {childrenOf(null).map(renderEditorSection)}
        {sections.length === 0 && <p className="empty-hint">목차 항목을 추가하면 독립된 제목과 본문을 만들 수 있습니다.</p>}
      </section>
    </>
  );

  return (
    <>
      {project.uiSettings.showTableOfContents && orderedSections.some((section) => section.title.trim()) && <nav className="wiki-document-toc" aria-label={t("wiki.contents")}>
        <strong>{t("wiki.contents")}</strong>
        <ol>{orderedSections.filter((section) => section.title.trim()).map((section) => <li className={`level-${depthOf(section)}`} key={section.id}><button type="button" onClick={() => openSection(section)}><span>{numbering.get(section.id)}</span><span data-user-authored="true">{section.title}</span></button></li>)}</ol>
      </nav>}
      {article.content && <section className="wiki-body-view"><h3>본문</h3><p data-user-authored="true"><WikiLinkedText project={project} text={article.content} onOpenArticle={onOpenArticle} /></p></section>}
      {orderedSections.map((section) => <section className={`wiki-document-section level-${depthOf(section)}`} key={section.id}>
        {depthOf(section) === 1 ? <h2 id={sectionAnchor(section)} tabIndex={-1} data-user-authored="true">{section.title}</h2>
          : depthOf(section) === 2 ? <h3 id={sectionAnchor(section)} tabIndex={-1} data-user-authored="true">{section.title}</h3>
            : depthOf(section) === 3 ? <h4 id={sectionAnchor(section)} tabIndex={-1} data-user-authored="true">{section.title}</h4>
              : <h5 id={sectionAnchor(section)} tabIndex={-1} data-user-authored="true">{section.title}</h5>}
        {section.content && <p data-user-authored="true"><WikiLinkedText project={project} text={section.content} onOpenArticle={onOpenArticle} /></p>}
      </section>)}
    </>
  );
}

export function WikiWindow({ project, onChange, initialCategoryId, initialEventCategory = "all", initialArticleId, onNavigate }: Props) {
  const { language, t } = useLocalization();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [backStack, setBackStack] = useState<string[]>([]);
  const [forwardStack, setForwardStack] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [currentOnly, setCurrentOnly] = useState(() => localStorage.getItem("world-archive-wiki-current-only") === "true");
  const [editMode, setEditMode] = useState(false);
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
  const filtered = useMemo(() => {
    const normalizedQuery = normalizeSearchText(query, language);
    return categoryArticles.filter((article) => (!currentOnly || articleExistsAtCurrentYear(article)) && normalizeSearchText(`${article.title} ${article.summary} ${article.tags.join(" ")}`, language).includes(normalizedQuery));
  }, [categoryArticles, query, currentOnly, currentTimelineYear, language]);
  const selected = displayProject.wikiArticles.find((article) => article.id === selectedId) ?? categoryArticles[0] ?? null;
  const childCategoryIds = new Set(displayProject.wikiCategories.map((category) => category.parentId).filter((id): id is string => Boolean(id)));
  const categoryPath = (categoryId: string): string => {
    const names: string[] = [];
    const visited = new Set<string>();
    let current = displayProject.wikiCategories.find((category) => category.id === categoryId);
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      names.unshift(current.name);
      current = current.parentId
        ? displayProject.wikiCategories.find((category) => category.id === current?.parentId)
        : undefined;
    }
    return names.join(" - ");
  };
  const leafCategoryOptions = displayProject.wikiCategories.filter((category) => !childCategoryIds.has(category.id));
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
    setSelectedId(first?.id ?? null); setEditMode(false); setDraftProject(null);
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
    const preferred = aggregateChildren.find((category) => ["war", "organization", "location", "item"].includes(category.systemKey ?? "")) ?? aggregateChildren[0];
    const rootCategory = project.wikiCategories.find((category) => category.id === initialCategoryId);
    const targetCategoryId = rootCategory?.systemKey || rootCategory?.templateKey ? initialCategoryId : (preferred?.id ?? initialCategoryId);
    const targetDefinition = project.wikiCategories.find((category) => category.id === targetCategoryId);
    const initialSystemKey = targetDefinition?.templateKey ?? targetDefinition?.systemKey ?? "other";
    const article: WikiArticle = {
      id: createId("wiki"), title: "새 문서", category: initialSystemKey, categoryId: targetCategoryId,
      summary: "", content: "", tags: [], linkedMapEntityIds: [],
      eventCategory: isEventDocumentCategory(initialSystemKey) ? (initialSystemKey === "war" ? "war" : initialSystemKey === "battle" ? "battle" : initialEventCategory !== "all" ? initialEventCategory : eventCategoriesForSystemKey(initialSystemKey)[0]) : undefined,
      eventProfile: isEventDocumentCategory(initialSystemKey) ? { id: createId("embedded-event"), title: "새 문서", startYear: project.maps[0]?.timeline.currentYear ?? 0, endYear: project.maps[0]?.timeline.currentYear ?? 0, category: initialSystemKey === "war" ? "war" : initialSystemKey === "battle" ? "battle" : initialSystemKey === "accident" ? "accident" : "incident", description: "", locationMode: "custom", location: null, locationText: "", cause: "", result: "", impact: "", startTimeUnknown: false, endTimeUnknown: false, startDateTime: { year: project.maps[0]?.timeline.currentYear ?? 0 }, endDateTime: { year: project.maps[0]?.timeline.currentYear ?? 0 }, participants: [], chronology: [], relatedLocationIds: [], relatedFactionIds: [], relatedTerritoryIds: [] } : undefined,
      factionProfile: ["country", "faction", "organization"].includes(initialSystemKey) ? { id: createId("embedded-faction"), kind: initialSystemKey as "country" | "faction" | "organization", name: "새 문서", color: "#5f8fb3", activityRange: "land_centered", summary: "", description: "", leaderStatus: "undecided", ...(initialSystemKey === "country" ? { hasTerritory: true, countryProfile: { nameRoot: "새", showRegimeSuffix: true, spaceBeforeRegimeSuffix: true, politicalSystem: "", symbol: "", languageArticleIds: [], cultureArticleIds: [], majorLocationIds: [] } } : { hasTerritory: false, groupProfile: { symbol: "", ideology: "", alignment: "", goals: "", headquartersStatus: "undecided", languageArticleIds: [] } }) } : undefined,
      calendarProfile: initialSystemKey === "calendar" ? createDefaultCalendarProfile() : undefined,
      governmentProfile: initialSystemKey === "government" ? { countryNameSuffix: "" } : undefined,
      personProfile: initialSystemKey === "person" ? { nationalityArticleIds: [], affiliationArticleIds: [], religionArticleIds: [], languageArticleIds: [], ideologyArticleIds: [], organizationArticleIds: [], factionArticleIds: [], spouseArticleIds: [], childArticleIds: [], notes: "" } : undefined,
      familyProfile: initialSystemKey === "family" ? { formationPeriod: "", dissolutionPeriod: "", displayMode: "all", members: [] } : undefined,
      itemProfile: initialSystemKey === "item" ? {
        subtype: targetCategoryId === "wiki-category-weapon" ? "weapon"
          : targetCategoryId === "wiki-category-armor" ? "armor"
            : targetCategoryId === "wiki-category-accessory" ? "accessory" : "item",
        itemType: "", origin: "", purpose: "", lifecycleStatus: "active", isUnique: false,
        condition: "", ownershipHistory: [],
      } : undefined,
      religionProfile: initialSystemKey === "religion" ? {
        traditionLineage: "", founder: "", foundingPeriod: "", holyCity: "",
        distributionRegions: [], adherentPopulation: "", religiousInstitutions: [],
        scriptures: [], majorDenominations: [], doctrineSections: [],
      } : undefined,
      cultureProfile: isCultureCategory(initialSystemKey) ? {
        distributionRegions: [], relatedLanguageArticleIds: [],
        relatedReligionArticleIds: [], characteristicSections: [],
      } : undefined,
      technologyProfile: isTechnologyCategory(initialSystemKey) ? { creator: "", creationPeriod: "", characteristicSections: [] } : undefined,
      diseaseProfile: initialSystemKey === "disease" ? { aliases: "", cause: "", incubationPeriod: "", symptomArticleIds: [], symptomNotes: "", relatedDiseaseArticleIds: [] } : undefined,
      languageProfile: isLanguageCategory(initialSystemKey) ? { writingSystemArticleIds: [], phonology: "", phonotactics: "", morphology: "", syntax: "", wordOrder: "", grammaticalCategories: "", writingSystem: "", numerals: "", registers: "", historicalDevelopment: "", dialects: "", vocabulary: [] } : undefined,
      rpgData: defaultRpgDataForCategory(project.rpgSettings, initialSystemKey),
      createdDate: now, lastModifiedDate: now,
    };
    base.wikiArticles.push(article); setDraftProject(base); setSelectedId(article.id); setEditMode(true);
  };
  const deleteSelected = () => {
    if (!selected || selected.autoGenerated || !window.confirm(language === "ko" ? "이 문서를 삭제할까요?" : "Delete this document?")) return;
    const source = draftProject ?? project;
    onChange({ ...source, wikiArticles: source.wikiArticles.filter((article) => article.id !== selected.id), lastModifiedDate: new Date().toISOString() });
    setDraftProject(null);
    setEditMode(false);
    setSelectedId(null);
  };

  const usesRightInfoColumn = true;
  const profilePanel = selected ? <>
    {selectedSystemKey === "world" && <WorldProfilePanel project={displayProject} language={language} />}
    {selectedSystemKey === "person" && <PersonProfilePanel project={displayProject} article={selected} editMode={editMode} onChange={(personProfile) => updateArticle({ personProfile })} onProjectChange={updateDraftProject} onOpenArticle={(id) => navigateToArticle(id)} />}
    {selectedSystemKey === "family" && <FamilyProfilePanel project={displayProject} article={selected} editMode={editMode} onChange={(familyProfile) => updateArticle({ familyProfile })} onProjectChange={updateDraftProject} onProjectAndProfileChange={(nextProject, familyProfile) => setDraftProject({ ...nextProject, wikiArticles: nextProject.wikiArticles.map((candidate) => candidate.id === selected.id ? { ...candidate, familyProfile, lastModifiedDate: new Date().toISOString() } : candidate) })} onOpenArticle={(id) => navigateToArticle(id)} />}
    {selectedSystemKey === "item" && <ItemProfilePanel project={displayProject} article={selected} editMode={editMode} onChange={(itemProfile) => updateArticle({ itemProfile })} />}
    {selectedSystemKey === "religion" && <ReligionProfilePanel project={displayProject} article={selected} editMode={editMode} onChange={(religionProfile) => updateArticle({ religionProfile })} />}
    {isCultureCategory(selectedSystemKey) && <CultureProfilePanel project={displayProject} article={selected} editMode={editMode} onChange={(cultureProfile) => updateArticle({ cultureProfile })} />}
    {isTechnologyCategory(selectedSystemKey) && <TechnologyProfilePanel article={selected} editMode={editMode} onChange={(technologyProfile) => updateArticle({ technologyProfile })} />}
    {selectedSystemKey === "disease" && <DiseaseProfilePanel project={displayProject} article={selected} editMode={editMode} onChange={(diseaseProfile) => updateArticle({ diseaseProfile })} onOpenArticle={(id) => navigateToArticle(id)} />}
    {isLanguageCategory(selectedSystemKey) && <LanguageProfilePanel project={displayProject} article={selected} editMode={editMode} onChange={(languageProfile) => updateArticle({ languageProfile })} onOpenArticle={(id) => navigateToArticle(id)} />}
    {selectedSystemKey === "calendar" && <CalendarProfilePanel project={displayProject} article={selected} editMode={editMode} onChange={(calendarProfile) => updateArticle({ calendarProfile })} />}
    {selectedSystemKey === "government" && <GovernmentProfilePanel article={selected} editMode={editMode} onChange={updateGovernmentProfile} />}
  </> : null;
  const rpgPanel = selected ? <RpgArticlePanel project={displayProject} article={selected} category={selectedSystemKey} editMode={editMode} onArticleChange={(rpgData) => updateArticle({ rpgData })} onProjectChange={updateDraftProject} onOpenArticle={(id) => navigateToArticle(id)} /> : null;
  const linkedHistory = selected && hasLinkedEntityHistory ? <Suspense fallback={null}><LinkedEntityHistory project={displayProject} article={selected} editMode={editMode} onProjectChange={updateDraftProject} onOpenArticle={(id) => navigateToArticle(id)} /></Suspense> : null;

  return <>
    <section className="wiki-window">
      <aside className="wiki-list-panel">
        <div className="window-heading compact"><h2><span data-user-authored="true">{categoryName}</span>{initialEventCategory !== "all" ? ` · ${EVENT_CATEGORY_LABELS[initialEventCategory]}` : ""}</h2><small>{categoryArticles.length}개 문서</small></div>
        <div className="wiki-search wiki-search-without-edit"><input placeholder={t("wiki.search", { category: categoryName })} value={query} onChange={(event) => setQuery(event.target.value)} /></div><button type="button" className={`wiki-current-filter ${currentOnly ? "active" : ""}`} onClick={() => setCurrentOnly((value) => { const next = !value; localStorage.setItem("world-archive-wiki-current-only", String(next)); return next; })}>{currentOnly ? t("wiki.currentOnlyActive") : t("wiki.currentOnly")}</button>
        <div className="article-list">{filtered.map((article) => <div className={`article-list-edit-row ${article.id === selected?.id ? "active" : ""}`} key={article.id}><button type="button" className={article.id === selected?.id ? "active" : ""} onClick={() => { if (editMode && !window.confirm("저장하지 않은 편집 내용을 버리고 다른 문서로 이동할까요?")) return; navigateToArticle(article.id); cancelEdit(); }}><DocumentListTitle title={article.title} /></button></div>)}{filtered.length === 0 && <p className="empty-hint">{t("wiki.noDocuments")}</p>}</div>
      </aside>
      <article className="wiki-editor" data-link-scope={selected ? `wiki:${selected.id}` : "wiki:none"}>
        {selected ? <>
          <div className={`wiki-navigation-bar ${editMode ? "editing" : "reading"}`}>
            <button type="button" onClick={goBack} disabled={backStack.length === 0} title="이전 문서">← 뒤로</button>
            <button type="button" onClick={goForward} disabled={forwardStack.length === 0} title="다음 문서">앞으로 →</button>
          </div>
          <div className="wiki-calendar-context">
            {(() => {
              const timeline = (displayProject.maps.find((item) => item.id === displayProject.activeMapId) ?? displayProject.maps[0])?.timeline ?? { minimumYear: 0, maximumYear: 0, currentYear: 0, currentDayOfYear: 0, currentMinuteOfDay: 0, precision: "year" as const, isPlaying: false, playbackIntervalMs: 1000 };
              return <><strong>{formatTimelineMoment(displayProject, timeline)}</strong><strong>{timeline.currentYear}년</strong></>;
            })()}
          </div>
          <div className="wiki-document-title-row">
            {editMode
              ? <input className="wiki-title-input" data-no-smart="true" value={selected.title} onChange={(event) => updateArticle({ title: event.target.value })} />
              : <h1 data-user-authored="true">{selected.title}</h1>}
            <div className="editor-save-row">
              {editMode ? <>
                <button type="button" className="primary-button" onClick={saveEdit}>편집 완료</button>
                <button type="button" className="secondary-button" onClick={cancelEdit}>취소</button>
                {!selected.autoGenerated && <button type="button" className="danger-button wiki-delete-button" onClick={deleteSelected}>문서 삭제</button>}
              </> : <button type="button" className="secondary-button wiki-edit-entry-button" onClick={beginEdit}>편집</button>}
            </div>
          </div>
          {editMode && <div className="draft-edit-banner">입력 내용은 아직 초안입니다. <strong>편집 완료</strong>를 눌러야 저장됩니다.</div>}
          {editMode && <div className="wiki-edit-controls">
            <label>카테고리<select value={articleCategoryId(selected) ?? ""} onChange={(event) => {
              const categoryId = event.target.value || null;
              const category = (displayProject.wikiCategories.find((item) => item.id === categoryId)?.templateKey ?? displayProject.wikiCategories.find((item) => item.id === categoryId)?.systemKey ?? "other") as WikiCategory;
              updateArticle({ categoryId, category });
            }}><option value="">미지정</option>{selected.categoryId && childCategoryIds.has(selected.categoryId) && <option data-user-authored="true" value={selected.categoryId} hidden>{categoryPath(selected.categoryId)}</option>}{leafCategoryOptions.map((category) => <option data-user-authored="true" key={category.id} value={category.id}>{categoryPath(category.id)}</option>)}</select></label>
            <label>태그<input value={selected.tags.join(", ")} onChange={(event) => updateArticle({ tags: event.target.value.split(",").map((tag) => tag.trim()).filter(Boolean) })} /></label>
          </div>}
          {selected.autoGenerated && editMode && <div className="auto-wiki-banner"><strong>자동 동기화 문서</strong><span>지도와 연표의 변경 사항은 자동 반영되며 추가 본문과 카테고리는 직접 관리할 수 있습니다.</span></div>}
          <div className={`wiki-document-columns${usesRightInfoColumn ? " split" : ""}`}>
            <main className="wiki-document-main">
              {editMode
                ? <label>요약<input value={selected.summary} onChange={(event) => updateArticle({ summary: event.target.value })} /></label>
                : <p className="wiki-document-summary">{selected.summary
                  ? <WikiLinkedText project={displayProject} text={selected.summary} onOpenArticle={(id) => navigateToArticle(id)} />
                  : (language === "ko" ? "요약 없음" : "No summary")}</p>}
              <WikiDocumentBody project={displayProject} article={selected} editMode={editMode} onChange={updateArticle} onOpenArticle={(id) => navigateToArticle(id)} />
            </main>
            {usesRightInfoColumn && <aside className="wiki-document-info">
              {profilePanel}
              {rpgPanel}
              {linkedHistory}
            </aside>}
          </div>
          <footer className="document-meta">마지막 수정: {new Date(selected.lastModifiedDate).toLocaleString(language === "ko" ? "ko-KR" : "en-US")}</footer>
        </> : <div className="empty-document"><strong>{categoryName} 문서가 없습니다.</strong><p>새 문서를 만들거나 지도 요소를 추가하세요.</p><button type="button" className="primary-button" onClick={addArticle}>문서 만들기</button></div>}
      </article>
    </section>
  </>;
}
