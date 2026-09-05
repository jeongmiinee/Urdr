import { createId, type WikiProfileSection } from "../model/world";
import type { ReactNode } from "react";

type Props = {
  title: string;
  sections: WikiProfileSection[];
  editMode: boolean;
  onChange: (sections: WikiProfileSection[]) => void;
};

export function NestedProfileSections({ title, sections, editMode, onChange }: Props) {
  const childrenOf = (parentId: string | null) => sections
    .filter((section) => section.parentId === parentId)
    .sort((a, b) => a.order - b.order);
  const updateSection = (id: string, patch: Partial<WikiProfileSection>) => onChange(
    sections.map((section) => section.id === id ? { ...section, ...patch } : section),
  );
  const addSection = (parentId: string | null) => onChange([
    ...sections,
    { id: createId("profile-section"), title: "새 항목", content: "", parentId, order: childrenOf(parentId).length },
  ]);
  const removeSection = (id: string) => {
    const removed = new Set([id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const section of sections) if (section.parentId && removed.has(section.parentId) && !removed.has(section.id)) {
        removed.add(section.id);
        changed = true;
      }
    }
    onChange(sections.filter((section) => !removed.has(section.id)));
  };
  const moveSection = (id: string, direction: -1 | 1) => {
    const section = sections.find((entry) => entry.id === id);
    if (!section) return;
    const siblings = childrenOf(section.parentId);
    const index = siblings.findIndex((entry) => entry.id === id);
    const target = siblings[index + direction];
    if (!target) return;
    onChange(sections.map((entry) => entry.id === section.id
      ? { ...entry, order: target.order }
      : entry.id === target.id ? { ...entry, order: section.order } : entry));
  };
  const renderTree = (parentId: string | null, depth: number): ReactNode => childrenOf(parentId).map((section, index, siblings) => <div className="religion-doctrine-node" data-depth={depth} key={section.id}>
    {editMode ? <>
      <div className="religion-doctrine-heading">
        <input value={section.title} aria-label={`${title} 항목 제목`} onChange={(event) => updateSection(section.id, { title: event.target.value })} />
        <button type="button" className="icon-button" aria-label="하위 항목 추가" title="하위 항목 추가" onClick={() => addSection(section.id)}>＋</button>
        <button type="button" className="icon-button" aria-label="위로 이동" title="위로 이동" disabled={index === 0} onClick={() => moveSection(section.id, -1)}>↑</button>
        <button type="button" className="icon-button" aria-label="아래로 이동" title="아래로 이동" disabled={index + 1 === siblings.length} onClick={() => moveSection(section.id, 1)}>↓</button>
        <button type="button" className="icon-button danger-ghost" aria-label="삭제" title="삭제" onClick={() => removeSection(section.id)}>×</button>
      </div>
      <textarea rows={3} value={section.content} aria-label={`${title} 항목 내용`} onChange={(event) => updateSection(section.id, { content: event.target.value })} />
    </> : <><h4>{section.title || "-"}</h4>{section.content && <p>{section.content}</p>}</>}
    {renderTree(section.id, depth + 1)}
  </div>);
  return <section className="structured-wiki-panel religion-doctrine-panel">
    <div className="ownership-section-heading"><h4>{title}</h4>{editMode && <button type="button" className="secondary-button" onClick={() => addSection(null)}>＋ 최상위 항목</button>}</div>
    {sections.length > 0 ? renderTree(null, 0) : <p className="empty-hint">-</p>}
  </section>;
}
