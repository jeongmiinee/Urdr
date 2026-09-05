import { useMemo, useState } from "react";
import { sortSelectionOptions } from "../model/selectionSort";
import type { WorldProject } from "../model/world";

export function WikiLinkedText({ project, text, onOpenArticle }: { project: WorldProject; text: string; onOpenArticle: (id: string) => void }) {
  const parts: Array<string | { title: string; id: string }> = [];
  const pattern = /\[\[([^\]]+)\]\]/g;
  let cursor = 0; let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    if (match.index > cursor) parts.push(text.slice(cursor, match.index));
    const title = match[1].trim();
    const article = project.wikiArticles.find((item) => item.title === title);
    parts.push(article ? { title, id: article.id } : `[[${title}]]`);
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts.map((part, index) => typeof part === "string" ? <span data-user-authored="true" key={index}>{part}</span> : <a data-user-authored="true" key={index} href={`#wiki-${part.id}`} className="wiki-inline-link" onClick={(event) => { event.preventDefault(); onOpenArticle(part.id); }}>{part.title}</a>)}</>;
}

export function WikiInlineLink({ project, articleId, fallback, onOpenArticle }: { project: WorldProject; articleId?: string; fallback?: string; onOpenArticle: (id: string) => void }) {
  const linked = articleId ? project.wikiArticles.find((item) => item.id === articleId) : undefined;
  return linked ? <a data-user-authored="true" href={`#wiki-${linked.id}`} className="wiki-inline-link" onClick={(event) => { event.preventDefault(); onOpenArticle(linked.id); }}>{linked.title}</a> : <>{fallback || "미정"}</>;
}

export type ReferenceOption = { id: string; label: string };
export function ReferencePicker({ label, options, articleId, customText, allowNone = true, embedded = false, onChange }: { label: string; options: ReferenceOption[]; articleId?: string; customText?: string; allowNone?: boolean; embedded?: boolean; onChange: (value: { articleId?: string; customText?: string; mode: "selected" | "custom" | "undecided" | "none" }) => void }) {
  const [forcedCustom, setForcedCustom] = useState(false);
  const sortedOptions = useMemo(() => sortSelectionOptions(options), [options]);
  const customMode = !articleId && (forcedCustom || (Boolean(customText) && customText !== "없음"));
  const modeValue = articleId ?? (customText === "없음" ? "__none__" : customMode ? "__custom__" : "");
  const controls = <>
    <span className={`reference-picker-row${customMode ? " custom" : ""}`}>
      <select aria-label={label} value={modeValue} onChange={(event) => {
        const value = event.target.value;
        if (!value) { setForcedCustom(false); onChange({ mode: "undecided" }); }
        else if (value === "__none__") { setForcedCustom(false); onChange({ customText: "없음", mode: "none" }); }
        else if (value === "__custom__") { setForcedCustom(true); onChange({ customText: customMode ? customText : "", mode: "custom" }); }
        else { setForcedCustom(false); onChange({ articleId: value, mode: "selected" }); }
      }}>
        <option value="">미정</option>
        {allowNone && <option value="__none__">없음</option>}
        <option value="__custom__">직접 입력</option>
        {sortedOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
      </select>
      {customMode && <input autoFocus value={customText ?? ""} placeholder="직접 입력" onChange={(event) => onChange({ customText: event.target.value, mode: "custom" })} />}
    </span>
    <small>문서를 선택하면 문서 ID가 저장되어 열람 화면에서 하이퍼링크로 표시됩니다.</small>
  </>;
  return embedded
    ? <div className="reference-picker smart-reference-field embedded">{controls}</div>
    : <label className="reference-picker smart-reference-field">{label}{controls}</label>;
}
