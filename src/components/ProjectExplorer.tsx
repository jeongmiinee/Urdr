import { useMemo, useState, type ReactNode } from "react";
import {
  createId,
  EVENT_CATEGORIES,
  EVENT_CATEGORY_LABELS,
  generatedAtYear,
  type EventCategory,
  type WikiCategory,
  type WikiCategoryDefinition,
  type WorldProject,
  type WorkspaceTabType,
} from "../model/world";
import { WIKI_TEMPLATE_REGISTRY, templateDefinition } from "../model/templateRegistry";

type Props = {
  project: WorldProject;
  onOpen: (type: WorkspaceTabType, mapId?: string, wikiCategoryId?: string | null, wikiEventCategory?: EventCategory | "all", wikiArticleId?: string) => void;
  onAddMap: () => void;
  onChange: (project: WorldProject) => void;
};

export function ProjectExplorer({ project, onOpen, onAddMap, onChange }: Props) {
  const [editingCategories, setEditingCategories] = useState(false);
  const [showNewCategory, setShowNewCategory] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState("새 카테고리");
  const [newCategoryParentId, setNewCategoryParentId] = useState<string>("");
  const [newCategoryTemplate, setNewCategoryTemplate] = useState<WikiCategory>("other");
  const [categoryNotice, setCategoryNotice] = useState("");
  const [projectSection, setProjectSection] = useState<"map" | "world" | "environment">("map");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(project.wikiCategories.map((category) => category.id)));
  const uncategorizedCount = project.wikiArticles.filter((article) => !article.categoryId || !project.wikiCategories.some((category) => category.id === article.categoryId)).length;
  const childrenByParent = useMemo(() => {
    const map = new Map<string | null, WikiCategoryDefinition[]>();
    for (const category of project.wikiCategories) {
      const key = category.parentId && project.wikiCategories.some((item) => item.id === category.parentId) ? category.parentId : null;
      map.set(key, [...(map.get(key) ?? []), category]);
    }
    return map;
  }, [project.wikiCategories]);

  const descendantIds = (categoryId: string): string[] => {
    const ids = [categoryId];
    for (const child of childrenByParent.get(categoryId) ?? []) ids.push(...descendantIds(child.id));
    return ids;
  };
  const countFor = (categoryId: string) => {
    const ids = new Set(descendantIds(categoryId));
    return project.wikiArticles.filter((article) => article.categoryId && ids.has(article.categoryId)).length;
  };
  const toggle = (id: string) => setExpanded((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const eventCategoriesFor = (systemKey?: string): EventCategory[] => {
    if (systemKey === "accident") return EVENT_CATEGORIES.filter((item) => ["accident", "natural_disaster"].includes(item));
    if (systemKey === "event") return EVENT_CATEGORIES.filter((item) => !["accident", "natural_disaster", "war", "battle"].includes(item));
    return [];
  };
  const openLeafCategory = (category: WikiCategoryDefinition, eventCategory: EventCategory | "all" = "all") => {
    const fixedEventCategory = category.systemKey === "war" ? "war" : category.systemKey === "battle" ? "battle" : eventCategory;
    onOpen("wiki", undefined, category.id, fixedEventCategory);
  };

  const hasAggregateAll = (category: WikiCategoryDefinition): boolean => {
    const childKeys = new Set((childrenByParent.get(category.id) ?? []).map((child) => child.systemKey));
    return childKeys.has("war") && childKeys.has("battle")
      || childKeys.has("organization") && childKeys.has("order")
      || childKeys.has("city") && childKeys.has("location");
  };

  const addCategory = () => {
    const name = newCategoryName.trim();
    if (!name) { setCategoryNotice("카테고리 이름을 입력하세요."); return; }
    const category: WikiCategoryDefinition = {
      id: createId("wiki-category"),
      name,
      parentId: newCategoryParentId || null,
      templateKey: newCategoryTemplate,
      createdDate: new Date().toISOString(),
    };
    onChange({ ...project, wikiCategories: [...project.wikiCategories, category] });
    setExpanded((current) => new Set([...current, category.id, ...(category.parentId ? [category.parentId] : [])]));
    setNewCategoryName("새 카테고리");
    setNewCategoryParentId("");
    setNewCategoryTemplate("other");
    setShowNewCategory(false);
    setCategoryNotice(`${name} 카테고리를 만들었습니다.`);
  };

  const deleteCategory = (category: WikiCategoryDefinition) => {
    const children = childrenByParent.get(category.id) ?? [];
    if (children.length > 0) {
      setCategoryNotice(`“${category.name}”의 하위 카테고리를 먼저 삭제해야 합니다.`);
      return;
    }
    const assigned = project.wikiArticles.filter((article) => article.categoryId === category.id).length;
    if (!window.confirm(assigned > 0
      ? `“${category.name}”을 삭제하면 문서 ${assigned}개가 미지정으로 이동합니다. 계속할까요?`
      : `“${category.name}” 카테고리를 삭제할까요?`)) return;
    onChange({
      ...project,
      wikiCategories: project.wikiCategories.filter((item) => item.id !== category.id),
      wikiArticles: project.wikiArticles.map((article) => article.categoryId === category.id ? { ...article, categoryId: null } : article),
    });
    setCategoryNotice(`${category.name} 카테고리를 삭제했습니다.`);
  };

  const renderVirtualEventLeaves = (category: WikiCategoryDefinition, depth: number): ReactNode => {
    const options = eventCategoriesFor(category.systemKey);
    if (!options.length || !expanded.has(category.id)) return null;
    const total = countFor(category.id);
    return (
      <div className={`category-text-children depth-${Math.min(depth, 3)}`}>
        <button type="button" className="category-text-item category-all-item" onClick={() => openLeafCategory(category, "all")}><span>전체</span><small>{total}</small></button>
        {options.map((eventCategory) => {
          const count = project.wikiArticles.filter((article) => article.categoryId === category.id && article.eventCategory === eventCategory).length;
          return <button type="button" className="category-text-item" key={eventCategory} onClick={() => openLeafCategory(category, eventCategory)}><span>{EVENT_CATEGORY_LABELS[eventCategory]}</span><small>{count}</small></button>;
        })}
      </div>
    );
  };

  const renderCategory = (category: WikiCategoryDefinition, depth = 0): ReactNode => {
    const children = childrenByParent.get(category.id) ?? [];
    const hasVirtualChildren = eventCategoriesFor(category.systemKey).length > 0;
    const hasChildren = children.length > 0 || hasVirtualChildren;
    const isExpanded = expanded.has(category.id);
    const count = countFor(category.id);
    const className = depth === 0 ? "category-root-button" : depth === 1 ? "category-primary-button" : "category-text-item";
    const button = <button type="button" className={className} onClick={() => hasChildren ? toggle(category.id) : openLeafCategory(category)}>
      <span className="category-node-label"><b aria-hidden="true">{hasChildren ? (isExpanded ? "▾" : "▸") : depth < 2 ? "▤" : ""}</b>{category.name}</span>
      <small>{count}</small>
    </button>;
    return (
      <div className={`category-hierarchy-node depth-${Math.min(depth, 3)}`} key={category.id}>
        {editingCategories ? <div className="category-inline-edit-row">{button}<button type="button" className="category-delete-button" title={`${category.name} 삭제`} onClick={() => deleteCategory(category)}>×</button></div> : button}
        {hasChildren && isExpanded && (
          <div className={`category-child-list depth-${Math.min(depth + 1, 3)}`}>
            {hasAggregateAll(category) && <button type="button" className="category-text-item category-all-item" onClick={() => onOpen("wiki", undefined, category.id, "all")}><span>전체</span><small>{count}</small></button>}
            {children.map((child) => renderCategory(child, depth + 1))}
            {renderVirtualEventLeaves(category, depth + 1)}
          </div>
        )}
      </div>
    );
  };

  return (
    <aside className="project-explorer">
      <div className="explorer-title"><span>프로젝트</span><strong>{project.title}</strong></div>
      <nav className="project-section-tabs" aria-label="프로젝트 영역">
        <button type="button" className={projectSection === "map" ? "active" : ""} onClick={() => setProjectSection("map")}>지도</button>
        <button type="button" className={projectSection === "world" ? "active" : ""} onClick={() => setProjectSection("world")}>세계관</button>
        <button type="button" className={projectSection === "environment" ? "active" : ""} onClick={() => setProjectSection("environment")}>환경</button>
      </nav>

      {projectSection === "map" && <section className="tree-section explorer-section-pane">
        <div className="tree-heading-row"><h3>지도</h3><small>{project.maps.length}개</small></div>
        {project.maps.map((map) => <button type="button" className="tree-item" key={map.id} onClick={() => onOpen("map", map.id)}><span>▧</span><span>{map.title}</span><small>{generatedAtYear(map) ? "현재 연도 생성됨" : "현재 연도 빈 지도"}</small></button>)}
        <button type="button" className="tree-action" onClick={onAddMap}>＋ 새 지도</button>
      </section>}

      {projectSection === "world" && <section className="tree-section world-tree-section explorer-section-pane">
        <div className="tree-heading-row"><h3>세계관</h3><button type="button" className={`category-edit-button ${editingCategories ? "active" : ""}`} onClick={() => { setEditingCategories((value) => !value); setShowNewCategory(false); setCategoryNotice(""); }}>{editingCategories ? "완료" : "편집"}</button></div>
        {editingCategories && <div className="category-inline-editor">
          <button type="button" className="primary-button full" onClick={() => setShowNewCategory((value) => !value)}>＋ 새 카테고리</button>
          {showNewCategory && <div className="new-category-panel">
            <label>카테고리 이름<input value={newCategoryName} onChange={(event) => setNewCategoryName(event.target.value)} /></label>
            <label>상위 카테고리<select value={newCategoryParentId} onChange={(event) => setNewCategoryParentId(event.target.value)}><option value="">최상위</option>{project.wikiCategories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
            <label>문서 템플릿<select value={newCategoryTemplate} onChange={(event) => setNewCategoryTemplate(event.target.value as WikiCategory)}>{WIKI_TEMPLATE_REGISTRY.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}</select><small>{templateDefinition(newCategoryTemplate).description}</small></label>
            <div className="inline-editor-actions"><button type="button" onClick={() => setShowNewCategory(false)}>취소</button><button type="button" className="primary-button" onClick={addCategory}>생성</button></div>
          </div>}
          {categoryNotice && <p className="category-editor-notice">{categoryNotice}</p>}
        </div>}
        <button type="button" className="tree-item timeline-tree-item" onClick={() => onOpen("timeline", project.activeMapId ?? undefined)}><span>◷</span><span>연표</span><small>{project.maps.reduce((sum, map) => sum + map.events.length, 0)}</small></button>
        <div className="category-tree-list single-column">{(childrenByParent.get(null) ?? []).map((category) => renderCategory(category))}<button type="button" className="tree-item uncategorized-tree-item" onClick={() => onOpen("wiki", undefined, null)}><span>□</span><span>미지정</span><small>{uncategorizedCount}</small></button></div>
      </section>}

      {projectSection === "environment" && <section className="tree-section environment-tree-section explorer-section-pane">
        <div className="tree-heading-row"><h3>환경</h3><small>선택 지점 분석</small></div>
        <p className="explorer-section-description">지도에서 지점을 선택해 날짜별 기후와 시각별 날씨, 농축산 적합도를 확인합니다.</p>
        {project.maps.map((map) => <button type="button" className="tree-item environment-tree-item" key={map.id} onClick={() => onOpen("simulation", map.id)}><span>◉</span><span>{map.title}</span><small>{map.environmentPins.length}개 핀</small></button>)}
      </section>}
    </aside>
  );
}
