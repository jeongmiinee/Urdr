import type { AppLanguage } from "./types";
import { getLocaleOverride, LOCALIZATION_OVERRIDE_EVENT } from "./localeOverrides";

import { uiPhraseCatalog } from "./locales/uiCatalog";


const patterns: Array<[RegExp, (...values: string[]) => string]> = [
  [/^(-?\d+)년$/, (year) => `Year ${year}`],
  [/^(-?\d+)년 이후$/, (year) => `Since Year ${year}`],
  [/^(\d+)개 문서$/, (count) => `${count} documents`],
  [/^(\d+)개 선택$/, (count) => `${count} selected`],
  [/^제어점 (\d+)개$/, (count) => `${count} control points`],
  [/^총 (\d+)개 국가/, (count) => `${count} countries total`],
  [/^(.+) 도구를 선택했습니다\.$/, (tool) => `${translateUiText(tool, "en")} tool selected.`],
  [/^(-?\d+)년: (.+)$/, (year, message) => `Year ${year}: ${translateUiText(message, "en")}`],
  [/^(.+) 검색$/, (target) => `Search ${translateUiText(target, "en")}`],
  [/^새 (.+) (\d+)$/, (kind, count) => `New ${translateUiText(kind, "en")} ${count}`],
  [/^(\d+)개월$/, (count) => `${count} months`],
  [/^(\d+)개 핀$/, (count) => `${count} pins`],
  [/^(\d+)월$/, (month) => `Month ${month}`],
  [/^(\d+)월 평균$/, (month) => `Month ${month} Average`],
  [/^(-?[\d.]+)시간$/, (hours) => `${hours} hours`],
  [/^(-?[\d.]+)일$/, (days) => `${days} days`],
  [/^(연|월|주|일) 평균 (온도|습도|풍속|강수량|적설량|증발산량|토양수분|일조량|일조시간)$/, (period, metric) => `${translateUiText(period, "en")} Average ${translateUiText(metric, "en")}`],
  [/^(연|월|주|일) (강수량|적설량|증발산량)$/, (period, metric) => `${translateUiText(period, "en")} ${translateUiText(metric, "en")}`],
  [/^현재 (온도|습도|풍속|강수량|적설량|증발산량|토양수분|일조량|일조시간)$/, (metric) => `Current ${translateUiText(metric, "en")}`],
  [/^X ([\d.-]+) · Y ([\d.-]+) · (.+) · 해발 (-?[\d,]+) m · (-?[\d.]+)℃$/, (x, y, surface, elevation, temperature) => `X ${x} · Y ${y} · ${translateUiText(surface, "en")} · Elevation ${elevation} m · ${temperature}℃`],
  [/^(동|동남동|남동|남남동|남|남남서|남서|서남서|서|서북서|북서|북북서|북|북북동|북동|동북동) ([\d.]+m\/s)$/, (direction, speed) => `${translateUiText(direction, "en")} ${speed}`],
  [/^비교 지점 (\d+)$/, (count) => `Comparison Point ${count}`],
  [/^지점 (\d+)$/, (count) => `Point ${count}`],
  [/^(.+) 중추 경로$/, (label) => `${translateUiText(label, "en")} Guide Path`],
  [/^(.+) 환경 적합도$/, (label) => `${translateUiText(label, "en")} Suitability`],
  [/^(.+) 적합도는 기온 ([\d.-]+℃), 강수 ([\d.-]+mm), 습도 ([\d.-]+%), 일조 ([\d.-]+)시간을 기준으로 계산되었습니다\.$/, (name, temperature, precipitation, humidity, solar) => `${translateUiText(name, "en")} suitability is calculated from temperature ${temperature}, precipitation ${precipitation}, humidity ${humidity}, and ${solar} hours of sunlight.`],
  [/^(.+) 적합도는 평균 기온 ([\d.-]+℃), 강수 ([\d.-]+mm), 상대습도 ([\d.-]+%)를 기준으로 계산되었습니다\.$/, (name, temperature, precipitation, humidity) => `${translateUiText(name, "en")} suitability is calculated from mean temperature ${temperature}, precipitation ${precipitation}, and relative humidity ${humidity}.`],
  [/^(.+) 기준$/, (label) => `Based on ${translateUiText(label, "en")}`],
  [/^(.+) 기준으로 자동 계산됩니다\.$/, (date) => `Calculated automatically for ${date}.`],
  [/^(.+)부터 장소 제거$/, (date) => `Remove Location from ${date}`],
  [/^(.+)년에 확정된 생성 결과입니다\.$/, (year) => `Generated result confirmed in year ${year}.`],
  [/^(.+)년 지도 미리보기를 준비합니다\.$/, (year) => `Preparing the map preview for year ${year}.`],
];

export function translateUiText(source: string, language: AppLanguage): string {
  if (language === "ko" || !/[가-힣]/.test(source)) return source;
  const leading = source.match(/^\s*/)?.[0] ?? "";
  const trailing = source.match(/\s*$/)?.[0] ?? "";
  const value = source.trim();
  const direct = getLocaleOverride(language, `text:${value}`) ?? uiPhraseCatalog[value];
  if (direct) return `${leading}${direct}${trailing}`;
  for (const [pattern, format] of patterns) {
    const match = value.match(pattern);
    if (match) return `${leading}${format(...match.slice(1))}${trailing}`;
  }
  const parts = value.split(/(\s*[·:|/]\s*)/);
  if (parts.length > 1) {
    const translated = parts.map((part) => /[가-힣]/.test(part) ? (getLocaleOverride(language, `text:${part.trim()}`) ?? uiPhraseCatalog[part.trim()] ?? part) : part).join("");
    if (translated !== value) return `${leading}${translated}${trailing}`;
  }
  return source;
}

const originalText = new WeakMap<Text, string>();
const originalAttributes = new WeakMap<Element, Map<string, string>>();
const translatableAttributes = ["aria-label", "title", "placeholder"];

function eligibleTextNode(node: Text): boolean {
  const parent = node.parentElement;
  if (!parent || parent.closest("script, style, [data-user-authored='true']")) return false;
  return Boolean(parent.closest("button, label, option, th, dt, h1, h2, h3, h4, legend, .status-bar, .map-editor-notice, .empty-hint, .tool-note, .tool-help, .reference-badge, .dialog-actions, .window-heading, .settings-card, .inspector, .chart-crosshair, .structured-read-grid, .linked-current-card, .summary-list, .history-table, .namuwiki-infobox, .timeline-panel, .project-explorer, .generator-controls, .simulation-window, .toolbar, .layer-panel, .calendar-profile-panel, .project-settings-window, .project-home-window, .wiki-sidebar, .wiki-document-toc, .wiki-section-editor, .history-window, .rpg-article-panel, .rpg-rules-panel, .settlement-plan-section, .heraldry-studio, .item-profile-panel"));
}

function localizeNode(root: Node, language: AppLanguage): void {
  const documentRoot = root.nodeType === Node.DOCUMENT_NODE ? (root as Document).documentElement : root;
  const textNodes: Text[] = root.nodeType === Node.TEXT_NODE ? [root as Text] : [];
  if (root.nodeType !== Node.TEXT_NODE) {
    const walker = document.createTreeWalker(documentRoot, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) textNodes.push(walker.currentNode as Text);
  }
  for (const node of textNodes) {
    if (!eligibleTextNode(node)) continue;
    if (language === "ko") {
      const source = originalText.get(node);
      if (source !== undefined && node.data !== source) node.data = source;
      continue;
    }
    if (/[가-힣]/.test(node.data)) originalText.set(node, node.data);
    const source = originalText.get(node) ?? node.data;
    const translated = translateUiText(source, language);
    if (translated !== node.data) node.data = translated;
  }

  const elements = documentRoot instanceof Element
    ? [documentRoot, ...documentRoot.querySelectorAll("*")]
    : [];
  for (const element of elements) {
    if (element.closest("[data-user-authored='true']")) continue;
    for (const attribute of translatableAttributes) {
      const current = element.getAttribute(attribute);
      if (current === null) continue;
      let originals = originalAttributes.get(element);
      if (!originals) { originals = new Map(); originalAttributes.set(element, originals); }
      if (language === "ko") {
        const source = originals.get(attribute);
        if (source !== undefined) element.setAttribute(attribute, source);
      } else {
        if (/[가-힣]/.test(current)) originals.set(attribute, current);
        const source = originals.get(attribute) ?? current;
        element.setAttribute(attribute, translateUiText(source, language));
      }
    }
  }
}

export function installUiLocalization(language: AppLanguage): () => void {
  let applying = false;
  const apply = (root: Node = document) => {
    if (applying) return;
    applying = true;
    try { localizeNode(root, language); } finally { applying = false; }
  };
  apply();
  const observer = new MutationObserver((records) => {
    if (applying) return;
    for (const record of records) {
      if (record.type === "characterData") apply(record.target);
      for (const node of record.addedNodes) apply(node);
    }
  });
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: translatableAttributes,
  });
  const refresh = () => apply();
  window.addEventListener(LOCALIZATION_OVERRIDE_EVENT, refresh);
  return () => {
    observer.disconnect();
    window.removeEventListener(LOCALIZATION_OVERRIDE_EVENT, refresh);
  };
}
