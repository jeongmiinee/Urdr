import { useEffect, useMemo, useState } from "react";
import type { WikiArticle, WorldProject } from "../model/world";
import { useLocalization } from "../localization";

type SmartLinkField = HTMLInputElement | HTMLTextAreaElement;

type OverlayState = {
  field: SmartLinkField;
  rect: DOMRect;
  query: string;
  queryStart: number;
  queryEnd: number;
  hasClosingBrackets: boolean;
};

export type ActiveWikiToken = Pick<OverlayState, "query" | "queryStart" | "queryEnd" | "hasClosingBrackets">;

function eligibleField(target: EventTarget | null): target is SmartLinkField {
  if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return false;
  if (target instanceof HTMLInputElement && !["text", "search", "url", "email", ""].includes(target.type)) return false;
  if (target.disabled || target.readOnly || target.dataset.noSmart === "true") return false;
  if (target.matches(".wiki-title-input") || target.closest(".wiki-search, .game-home-screen, .category-editor-dialog")) return false;
  return Boolean(target.closest(".wiki-editor, .event-editor, .settings-card, .inspector-panel, .inspector, .map-editor-window, .calendar-editor-panel, .genealogy-panel"));
}

export function findActiveWikiToken(value: string, caret: number | null): ActiveWikiToken | null {
  if (caret === null) return null;
  const opening = value.lastIndexOf("[[", caret);
  if (opening < 0) return null;
  const lastClosing = value.lastIndexOf("]]", caret - 1);
  if (lastClosing > opening) return null;
  const closing = value.indexOf("]]", opening + 2);
  if (closing >= 0 && caret > closing) return null;
  const queryStart = opening + 2;
  const queryEnd = closing >= 0 ? closing : caret;
  const query = value.slice(queryStart, caret);
  if (query.includes("\n") || query.includes("[[")) return null;
  return { query, queryStart, queryEnd, hasClosingBrackets: closing >= 0 };
}

export function completeWikiToken(value: string, token: ActiveWikiToken, title: string): { value: string; caret: number } {
  const before = value.slice(0, token.queryStart);
  const after = value.slice(token.queryEnd);
  const closing = token.hasClosingBrackets ? "" : "]]";
  return { value: `${before}${title}${closing}${after}`, caret: token.queryStart + title.length + 2 };
}

function setNativeValue(field: SmartLinkField, value: string): void {
  const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  setter?.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

export function SmartLinkOverlay({ project }: { project: WorldProject }) {
  const { language, t } = useLocalization();
  const [overlay, setOverlay] = useState<OverlayState | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const results = useMemo(() => {
    const query = overlay?.query.trim().toLocaleLowerCase(language === "ko" ? "ko-KR" : "en-US") ?? "";
    if (!query) return [];
    return project.wikiArticles
      .filter((article) => article.title.toLocaleLowerCase(language === "ko" ? "ko-KR" : "en-US").includes(query))
      .sort((a, b) => Number(b.title.toLocaleLowerCase().startsWith(query)) - Number(a.title.toLocaleLowerCase().startsWith(query)) || a.title.localeCompare(b.title, language))
      .slice(0, 8);
  }, [language, overlay?.query, project.wikiArticles]);

  useEffect(() => {
    const refresh = (target: EventTarget | null) => {
      if (!eligibleField(target)) { setOverlay(null); return; }
      const token = findActiveWikiToken(target.value, target.selectionStart);
      setOverlay(token ? { field: target, rect: target.getBoundingClientRect(), ...token } : null);
    };
    const refreshFromEvent = (event: Event) => {
      if (event instanceof InputEvent && event.isComposing) return;
      refresh(event.target);
    };
    const updatePosition = () => setOverlay((current) => current ? { ...current, rect: current.field.getBoundingClientRect() } : current);
    const blur = (event: FocusEvent) => {
      if (!eligibleField(event.target)) return;
      window.setTimeout(() => setOverlay((current) => current?.field === event.target ? null : current), 140);
    };
    const compositionStart = () => setOverlay(null);
    document.addEventListener("focusin", refreshFromEvent);
    document.addEventListener("input", refreshFromEvent);
    document.addEventListener("keyup", refreshFromEvent);
    document.addEventListener("click", refreshFromEvent);
    document.addEventListener("compositionstart", compositionStart);
    document.addEventListener("compositionend", refreshFromEvent);
    document.addEventListener("focusout", blur);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      document.removeEventListener("focusin", refreshFromEvent);
      document.removeEventListener("input", refreshFromEvent);
      document.removeEventListener("keyup", refreshFromEvent);
      document.removeEventListener("click", refreshFromEvent);
      document.removeEventListener("compositionstart", compositionStart);
      document.removeEventListener("compositionend", refreshFromEvent);
      document.removeEventListener("focusout", blur);
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, []);

  const choose = (article: WikiArticle) => {
    if (!overlay) return;
    const completed = completeWikiToken(overlay.field.value, overlay, article.title);
    const { value, caret } = completed;
    setNativeValue(overlay.field, value);
    requestAnimationFrame(() => {
      overlay.field.focus();
      overlay.field.setSelectionRange(caret, caret);
    });
    setOverlay(null);
  };

  useEffect(() => setActiveIndex(0), [overlay?.query]);
  useEffect(() => {
    if (!overlay) return;
    overlay.field.setAttribute("aria-controls", "smart-link-listbox");
    overlay.field.setAttribute("aria-expanded", "true");
    const keydown = (event: KeyboardEvent) => {
      if (event.target !== overlay.field) return;
      if (event.key === "Escape") { setOverlay(null); return; }
      if (results.length === 0) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const direction = event.key === "ArrowDown" ? 1 : -1;
        setActiveIndex((current) => (current + direction + results.length) % results.length);
      } else if (event.key === "Enter") {
        event.preventDefault();
        choose(results[Math.min(activeIndex, results.length - 1)]);
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      overlay.field.removeAttribute("aria-controls");
      overlay.field.removeAttribute("aria-expanded");
    };
  }, [activeIndex, overlay, results]);

  if (!overlay || !overlay.query.trim()) return null;
  return (
    <div id="smart-link-listbox" className="smart-link-popover" role="listbox" aria-label={t("wiki.linkSuggestions")} style={{ left: overlay.rect.left, top: overlay.rect.bottom + 6, width: Math.max(260, overlay.rect.width) }} onMouseDown={(event) => event.preventDefault()}>
      {results.map((article, index) => <button type="button" role="option" aria-selected={index === activeIndex} className={`smart-link-result${index === activeIndex ? " active" : ""}`} key={article.id} onMouseEnter={() => setActiveIndex(index)} onClick={() => choose(article)}><strong data-user-authored="true">{article.title}</strong><span>{project.wikiCategories.find((category) => category.id === article.categoryId)?.name ?? article.category}</span><small data-user-authored="true">{article.summary || t("wiki.noDescription")}</small></button>)}
      {results.length === 0 && <p>{t("wiki.linkNoResults")}</p>}
    </div>
  );
}
