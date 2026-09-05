import type { CultureProfile, WikiArticle, WorldProject } from "../model/world";
import { NestedProfileSections } from "./NestedProfileSections";
import { StructuredInfoPanel, StructuredInfoRow } from "./StructuredInfoPanel";

export function isCultureCategory(category?: string): boolean {
  return category === "culture" || category === "culture_sphere";
}

function articleOptions(project: WorldProject, keys: string[]): WikiArticle[] {
  const categoryIds = new Set(project.wikiCategories
    .filter((category) => keys.includes(category.systemKey ?? category.templateKey ?? ""))
    .map((category) => category.id));
  return project.wikiArticles
    .filter((article) => keys.includes(article.category) || Boolean(article.categoryId && categoryIds.has(article.categoryId)))
    .sort((a, b) => a.title.localeCompare(b.title));
}

function TextList({ values, editMode, onChange }: { values: string[]; editMode: boolean; onChange: (values: string[]) => void }) {
  if (!editMode) return <span>{values.length > 0 ? values.join(", ") : "-"}</span>;
  return <div className="religion-text-list">
    {values.map((value, index) => <div className="religion-text-list-row" key={`${index}-${value}`}><input value={value} onChange={(event) => onChange(values.map((entry, candidate) => candidate === index ? event.target.value : entry))} /><button type="button" className="icon-button danger-ghost" aria-label="삭제" title="삭제" onClick={() => onChange(values.filter((_, candidate) => candidate !== index))}>×</button></div>)}
    <button type="button" className="secondary-button" onClick={() => onChange([...values, ""])}>＋ 항목</button>
  </div>;
}

export function CultureProfilePanel({ project, article, editMode, onChange }: { project: WorldProject; article: WikiArticle; editMode: boolean; onChange: (profile: CultureProfile) => void }) {
  const profile = article.cultureProfile ?? { distributionRegions: [], relatedLanguageArticleIds: [], relatedReligionArticleIds: [], characteristicSections: [] };
  const update = (patch: Partial<CultureProfile>) => onChange({ ...profile, ...patch });
  const languages = articleOptions(project, ["language", "dialect"]);
  const religions = articleOptions(project, ["religion"]);
  const linkedTitles = (ids: string[]) => ids.map((id) => project.wikiArticles.find((candidate) => candidate.id === id)?.title ?? id).join(", ") || "-";
  return <>
    <StructuredInfoPanel title="문화 정보" className="culture-profile-panel">
      <StructuredInfoRow label="분포 지역"><TextList values={profile.distributionRegions} editMode={editMode} onChange={(distributionRegions) => update({ distributionRegions })} /></StructuredInfoRow>
      <StructuredInfoRow label="관련 언어">{editMode ? <select multiple value={profile.relatedLanguageArticleIds} onChange={(event) => update({ relatedLanguageArticleIds: [...event.target.selectedOptions].map((option) => option.value) })}>{languages.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.title}</option>)}</select> : <span>{linkedTitles(profile.relatedLanguageArticleIds)}</span>}</StructuredInfoRow>
      <StructuredInfoRow label="관련 종교">{editMode ? <select multiple value={profile.relatedReligionArticleIds} onChange={(event) => update({ relatedReligionArticleIds: [...event.target.selectedOptions].map((option) => option.value) })}>{religions.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.title}</option>)}</select> : <span>{linkedTitles(profile.relatedReligionArticleIds)}</span>}</StructuredInfoRow>
    </StructuredInfoPanel>
    <NestedProfileSections title="특징" sections={profile.characteristicSections} editMode={editMode} onChange={(characteristicSections) => update({ characteristicSections })} />
  </>;
}
