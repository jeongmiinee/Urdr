import { useMemo, useRef, useState } from "react";
import { enMessages } from "../localization/locales/en";
import { koMessages, type MessageKey } from "../localization/locales/ko";
import {
  exportLocaleOverrides,
  getLocaleOverride,
  importLocaleOverrides,
  resetLocaleOverrides,
  setLocaleOverride,
  type LocaleOverridePack,
} from "../localization/localeOverrides";
import { uiPhraseCatalog } from "../localization/locales/uiCatalog";
import { useLocalization } from "../localization";

type CatalogEntry = {
  id: string;
  domain: string;
  source: string;
  target: string;
};

const catalog: CatalogEntry[] = [
  ...(Object.keys(koMessages) as MessageKey[]).map((key) => ({
    id: `message:${key}`,
    domain: key.split(".")[0],
    source: koMessages[key],
    target: enMessages[key],
  })),
  ...Object.entries(uiPhraseCatalog).map(([source, target]) => ({
    id: `text:${source}`,
    domain: "legacy-ui",
    source,
    target,
  })),
];

function downloadJson(value: unknown, fileName: string): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function LocalizationWorkspace() {
  const { language } = useLocalization();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [domain, setDomain] = useState("all");
  const [selectedId, setSelectedId] = useState(catalog[0]?.id ?? "");
  const [revision, setRevision] = useState(0);
  const [previewTheme, setPreviewTheme] = useState<"light" | "dark">("light");
  const [previewWidth, setPreviewWidth] = useState<"desktop" | "narrow">("desktop");
  const [notice, setNotice] = useState("");
  const domains = useMemo(() => [...new Set(catalog.map((entry) => entry.domain))].sort(), []);
  const visible = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return catalog.filter((entry) =>
      (domain === "all" || entry.domain === domain)
      && (!normalized || `${entry.id} ${entry.source} ${entry.target}`.toLocaleLowerCase().includes(normalized)),
    );
  }, [domain, query, revision]);
  const selected = catalog.find((entry) => entry.id === selectedId) ?? visible[0] ?? catalog[0];
  const override = selected ? getLocaleOverride("en", selected.id) : undefined;
  const translatedCount = catalog.filter((entry) => Boolean(getLocaleOverride("en", entry.id) ?? entry.target.trim())).length;

  const update = (value: string) => {
    if (!selected) return;
    setLocaleOverride("en", selected.id, value === selected.target ? "" : value);
    setRevision((current) => current + 1);
  };

  const importPack = async (file: File | undefined) => {
    if (!file) return;
    try {
      const pack = JSON.parse(await file.text()) as LocaleOverridePack;
      importLocaleOverrides(pack);
      setRevision((current) => current + 1);
      setNotice(language === "ko" ? "언어 팩을 적용했습니다." : "Language pack applied.");
    } catch (error) {
      setNotice(`${language === "ko" ? "가져오기 실패" : "Import failed"}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return <section className="localization-workspace">
    <header>
      <div><h2>{language === "ko" ? "영어 UI 번역" : "English UI Translation"}</h2><p>{translatedCount.toLocaleString()} / {catalog.length.toLocaleString()}</p></div>
      <div className="localization-actions">
        <button type="button" onClick={() => downloadJson(exportLocaleOverrides("en"), "world-archive-en.language-pack.json")}>{language === "ko" ? "내보내기" : "Export"}</button>
        <button type="button" onClick={() => inputRef.current?.click()}>{language === "ko" ? "가져오기" : "Import"}</button>
        <button type="button" onClick={() => { if (!window.confirm(language === "ko" ? "사용자 영어 번역을 모두 초기화할까요?" : "Reset every custom English translation?")) return; resetLocaleOverrides("en"); setRevision((current) => current + 1); setNotice(language === "ko" ? "사용자 수정을 초기화했습니다." : "Custom translations reset."); }}>{language === "ko" ? "사용자 수정 초기화" : "Reset Overrides"}</button>
        <input ref={inputRef} type="file" accept="application/json,.json" hidden onChange={(event) => { void importPack(event.target.files?.[0]); event.target.value = ""; }} />
      </div>
    </header>
    <div className="localization-filters">
      <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={language === "ko" ? "키·한국어·영어 검색" : "Search key, Korean, or English"} />
      <select value="en" aria-label={language === "ko" ? "대상 언어" : "Target language"}><option value="en">English</option></select>
      <select value={domain} onChange={(event) => setDomain(event.target.value)}>
        <option value="all">{language === "ko" ? "모든 영역" : "All domains"}</option>
        {domains.map((value) => <option key={value} value={value}>{value}</option>)}
      </select>
    </div>
    {notice && <p className="localization-notice" role="status">{notice}</p>}
    <div className="localization-editor">
      <nav aria-label={language === "ko" ? "번역 항목" : "Translation entries"}>
        {visible.map((entry) => <button type="button" className={selected?.id === entry.id ? "active" : ""} key={entry.id} onClick={() => setSelectedId(entry.id)}>
          <small>{entry.domain}</small><span>{entry.source}</span>
        </button>)}
        {visible.length === 0 && <p>{language === "ko" ? "검색 결과가 없습니다." : "No matching entries."}</p>}
      </nav>
      {selected && <div className="localization-fields">
        <label><span>{language === "ko" ? "안정 키" : "Stable key"}</span><input readOnly value={selected.id} /></label>
        <label><span>{language === "ko" ? "한국어 원문" : "Korean source"}</span><textarea readOnly value={selected.source} /></label>
        <label><span>{language === "ko" ? "영어 번역" : "English translation"}</span><textarea value={override ?? selected.target} onChange={(event) => update(event.target.value)} /></label>
        <div className="localization-preview-controls">
          <span>{language === "ko" ? "미리보기" : "Preview"}</span>
          <div role="group" aria-label={language === "ko" ? "미리보기 테마" : "Preview theme"}>
            <button type="button" className={previewTheme === "light" ? "active" : ""} onClick={() => setPreviewTheme("light")}>{language === "ko" ? "밝게" : "Light"}</button>
            <button type="button" className={previewTheme === "dark" ? "active" : ""} onClick={() => setPreviewTheme("dark")}>{language === "ko" ? "어둡게" : "Dark"}</button>
          </div>
          <div role="group" aria-label={language === "ko" ? "미리보기 너비" : "Preview width"}>
            <button type="button" className={previewWidth === "desktop" ? "active" : ""} onClick={() => setPreviewWidth("desktop")}>{language === "ko" ? "넓게" : "Desktop"}</button>
            <button type="button" className={previewWidth === "narrow" ? "active" : ""} onClick={() => setPreviewWidth("narrow")}>{language === "ko" ? "좁게" : "Narrow"}</button>
          </div>
        </div>
        <div className={`localization-preview ${previewTheme} ${previewWidth}`}><span>{language === "ko" ? "실시간 미리보기" : "Live preview"}</span><strong>{(override ?? selected.target) || "—"}</strong><small>{!((override ?? selected.target).trim()) ? (language === "ko" ? "미번역" : "Untranslated") : override ? (language === "ko" ? "사용자 수정" : "Overridden") : selected.source === selected.target ? (language === "ko" ? "공통 표기" : "Intentionally shared") : (language === "ko" ? "번역 완료" : "Translated")}</small></div>
      </div>}
    </div>
  </section>;
}
