import { useEffect, useMemo, useState } from "react";
import type { WikiArticle, WorldProject } from "../model/world";

type OverlayState = {
  input: HTMLInputElement;
  fieldKey: string;
  rect: DOMRect;
  query: string;
};

function eligibleInput(target: EventTarget | null): target is HTMLInputElement {
  if (!(target instanceof HTMLInputElement)) return false;
  if (!["text", "search", "url", "email", ""].includes(target.type)) return false;
  if (target.disabled || target.readOnly || target.dataset.noSmart === "true") return false;
  if (target.closest(".wiki-search, .game-home-screen, .category-editor-dialog")) return false;
  return Boolean(target.closest(".wiki-editor, .event-editor, .settings-card, .inspector-panel, .inspector, .map-editor-window, .calendar-editor-panel, .genealogy-panel"));
}

function fieldKeyFor(input: HTMLInputElement): string {
  const scopeElement = input.closest<HTMLElement>("[data-link-scope]");
  const scope = scopeElement?.dataset.linkScope ?? input.closest(".wiki-editor")?.className ?? "workspace";
  const label = input.closest("label")?.childNodes[0]?.textContent?.trim() || input.getAttribute("aria-label") || input.placeholder || "입력";
  const container = scopeElement ?? input.closest("form, article, section, aside") ?? input.parentElement;
  const inputs = container ? Array.from(container.querySelectorAll<HTMLInputElement>('input[type="text"], input:not([type])')) : [input];
  const index = Math.max(0, inputs.indexOf(input));
  return `${scope}:${label}:${index}`;
}

function setNativeValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

export function SmartLinkOverlay({ project, onChange }: { project: WorldProject; onChange: (project: WorldProject) => void }) {
  const [overlay, setOverlay] = useState<OverlayState | null>(null);
  const linkedArticle = overlay ? project.wikiArticles.find((article) => article.id === project.linkedTextFields[overlay.fieldKey]) : undefined;
  const results = useMemo(() => {
    const query = overlay?.query.trim().toLocaleLowerCase("ko-KR") ?? "";
    if (!query) return [];
    return project.wikiArticles
      .filter((article) => article.title.toLocaleLowerCase("ko-KR").includes(query) || article.summary.toLocaleLowerCase("ko-KR").includes(query))
      .sort((a, b) => Number(b.title.toLocaleLowerCase("ko-KR").startsWith(query)) - Number(a.title.toLocaleLowerCase("ko-KR").startsWith(query)))
      .slice(0, 8);
  }, [overlay?.query, project.wikiArticles]);

  useEffect(() => {
    const updatePosition = () => setOverlay((current) => current ? { ...current, rect: current.input.getBoundingClientRect() } : current);
    const focus = (event: FocusEvent) => {
      if (!eligibleInput(event.target)) return;
      const input = event.target;
      const fieldKey = fieldKeyFor(input);
      input.dataset.smartFieldKey = fieldKey;
      setOverlay({ input, fieldKey, rect: input.getBoundingClientRect(), query: input.value });
    };
    const inputHandler = (event: Event) => {
      if (!eligibleInput(event.target)) return;
      const input = event.target;
      const fieldKey = input.dataset.smartFieldKey || fieldKeyFor(input);
      if (project.linkedTextFields[fieldKey]) {
        const nextLinks = { ...project.linkedTextFields };
        delete nextLinks[fieldKey];
        onChange({ ...project, linkedTextFields: nextLinks });
      }
      setOverlay({ input, fieldKey, rect: input.getBoundingClientRect(), query: input.value });
    };
    const blur = (event: FocusEvent) => {
      if (!eligibleInput(event.target)) return;
      window.setTimeout(() => setOverlay((current) => current?.input === event.target ? null : current), 140);
    };
    const keydown = (event: KeyboardEvent) => { if (event.key === "Escape") setOverlay(null); };
    document.addEventListener("focusin", focus);
    document.addEventListener("input", inputHandler);
    document.addEventListener("focusout", blur);
    document.addEventListener("keydown", keydown);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      document.removeEventListener("focusin", focus);
      document.removeEventListener("input", inputHandler);
      document.removeEventListener("focusout", blur);
      document.removeEventListener("keydown", keydown);
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [project, onChange]);

  const choose = (article: WikiArticle) => {
    if (!overlay) return;
    setNativeValue(overlay.input, article.title);
    onChange({ ...project, linkedTextFields: { ...project.linkedTextFields, [overlay.fieldKey]: article.id } });
    setOverlay({ ...overlay, query: article.title });
  };

  const unlink = () => {
    if (!overlay) return;
    const next = { ...project.linkedTextFields };
    delete next[overlay.fieldKey];
    onChange({ ...project, linkedTextFields: next });
  };

  if (!overlay || (!overlay.query.trim() && !linkedArticle)) return null;
  return (
    <div className="smart-link-popover" style={{ left: overlay.rect.left, top: overlay.rect.bottom + 6, width: Math.max(260, overlay.rect.width) }} onMouseDown={(event) => event.preventDefault()}>
      {linkedArticle && <div className="smart-link-current"><span>↗ {linkedArticle.title}<small>{project.wikiCategories.find((category) => category.id === linkedArticle.categoryId)?.name ?? linkedArticle.category}</small></span><button type="button" onClick={unlink}>연결 해제</button></div>}
      {!linkedArticle && results.map((article) => <button type="button" className="smart-link-result" key={article.id} onClick={() => choose(article)}><strong>{article.title}</strong><span>{project.wikiCategories.find((category) => category.id === article.categoryId)?.name ?? article.category}</span><small>{article.summary || "설명 없음"}</small></button>)}
      {!linkedArticle && results.length === 0 && <p>일치하는 문서가 없습니다. 일반 텍스트로 저장됩니다.</p>}
    </div>
  );
}
