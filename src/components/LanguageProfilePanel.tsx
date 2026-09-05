import { createId, type LanguageProfile, type WikiArticle, type WikiCategory, type WorldProject } from "../model/world";
import { useLocalization } from "../localization";
import { StructuredInfoPanel, StructuredInfoRow } from "./StructuredInfoPanel";

const LANGUAGE_CATEGORIES = new Set<WikiCategory>([
  "language_family", "language_branch", "language_group", "language", "dialect", "writing_system",
]);

export function isLanguageCategory(category: WikiCategory): boolean {
  return LANGUAGE_CATEGORIES.has(category);
}

const emptyProfile = (): LanguageProfile => ({
  writingSystemArticleIds: [], phonology: "", phonotactics: "", morphology: "", syntax: "",
  wordOrder: "", grammaticalCategories: "", writingSystem: "", numerals: "", registers: "",
  historicalDevelopment: "", dialects: "", vocabulary: [],
});

function articleSystemKey(project: WorldProject, article: WikiArticle): WikiCategory {
  const category = project.wikiCategories.find((candidate) => candidate.id === article.categoryId);
  return (category?.templateKey ?? category?.systemKey ?? article.category) as WikiCategory;
}

export function LanguageProfilePanel({
  project, article, editMode, onChange, onOpenArticle,
}: {
  project: WorldProject;
  article: WikiArticle;
  editMode: boolean;
  onChange: (profile: LanguageProfile) => void;
  onOpenArticle?: (id: string) => void;
}) {
  const { language } = useLocalization();
  const profile = article.languageProfile ?? emptyProfile();
  const labels = language === "ko" ? {
    classification: "언어 분류", structure: "언어 구조", vocabulary: "어휘", none: "미지정",
    family: "어족", branch: "어파", group: "어군", parent: "상위 언어", scripts: "문자",
    add: "+ 어휘 추가", term: "낱말", pronunciation: "발음", meaning: "뜻", part: "품사",
    etymology: "어원", usage: "용례", related: "관련어", remove: "삭제",
  } : {
    classification: "Language Classification", structure: "Language Structure", vocabulary: "Vocabulary", none: "Unspecified",
    family: "Language Family", branch: "Branch", group: "Group", parent: "Parent Language", scripts: "Writing Systems",
    add: "+ Add Vocabulary", term: "Term", pronunciation: "Pronunciation", meaning: "Meaning", part: "Part of Speech",
    etymology: "Etymology", usage: "Usage Note", related: "Related Terms", remove: "Delete",
  };
  const references = project.wikiArticles.filter((candidate) => candidate.id !== article.id && isLanguageCategory(articleSystemKey(project, candidate)));
  const options = (category: WikiCategory) => references.filter((candidate) => articleSystemKey(project, candidate) === category);
  const title = (id?: string) => project.wikiArticles.find((candidate) => candidate.id === id)?.title ?? labels.none;
  const update = (patch: Partial<LanguageProfile>) => onChange({ ...profile, ...patch });
  const referenceRow = (label: string, key: "familyArticleId" | "branchArticleId" | "groupArticleId" | "parentLanguageArticleId", category: WikiCategory) =>
    <StructuredInfoRow label={label}>{editMode
      ? <select value={profile[key] ?? ""} onChange={(event) => update({ [key]: event.target.value || undefined })}><option value="">{labels.none}</option>{options(category).map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.title}</option>)}</select>
      : profile[key] && onOpenArticle ? <button type="button" className="wiki-inline-button" onClick={() => onOpenArticle(profile[key]!)}>{title(profile[key])}</button> : <span>{title(profile[key])}</span>}
    </StructuredInfoRow>;
  const structureFields: Array<[keyof Pick<LanguageProfile, "phonology" | "phonotactics" | "morphology" | "syntax" | "wordOrder" | "grammaticalCategories" | "writingSystem" | "numerals" | "registers" | "historicalDevelopment" | "dialects">, string, string]> = [
    ["phonology", "음운론", "Phonology"], ["phonotactics", "음소 배열", "Phonotactics"],
    ["morphology", "형태론", "Morphology"], ["syntax", "통사론", "Syntax"],
    ["wordOrder", "어순", "Word Order"], ["grammaticalCategories", "문법 범주", "Grammatical Categories"],
    ["writingSystem", "문자 체계", "Writing System"], ["numerals", "수 체계", "Numerals"],
    ["registers", "사용역", "Registers"], ["historicalDevelopment", "역사적 발달", "Historical Development"],
    ["dialects", "방언", "Dialects"],
  ];
  return <>
    <StructuredInfoPanel title={labels.classification}>
      {referenceRow(labels.family, "familyArticleId", "language_family")}
      {referenceRow(labels.branch, "branchArticleId", "language_branch")}
      {referenceRow(labels.group, "groupArticleId", "language_group")}
      {referenceRow(labels.parent, "parentLanguageArticleId", "language")}
      <StructuredInfoRow label={labels.scripts}>{editMode
        ? <select multiple value={profile.writingSystemArticleIds} onChange={(event) => update({ writingSystemArticleIds: [...event.target.selectedOptions].map((option) => option.value) })}>{options("writing_system").map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.title}</option>)}</select>
        : <span>{profile.writingSystemArticleIds.map(title).join(", ") || labels.none}</span>}</StructuredInfoRow>
    </StructuredInfoPanel>
    <StructuredInfoPanel title={labels.structure}>{structureFields.map(([key, ko, en]) => <StructuredInfoRow key={key} label={language === "ko" ? ko : en}>{editMode
      ? <textarea value={profile[key]} onChange={(event) => update({ [key]: event.target.value })} />
      : <span>{profile[key] || "-"}</span>}</StructuredInfoRow>)}</StructuredInfoPanel>
    <StructuredInfoPanel title={labels.vocabulary}>{editMode ? <div className="language-vocabulary-editor">
      {profile.vocabulary.map((entry) => <div className="rpg-feature-editor-card" key={entry.id}>
        <div className="form-grid two"><label>{labels.term}<input value={entry.term} onChange={(event) => update({ vocabulary: profile.vocabulary.map((candidate) => candidate.id === entry.id ? { ...candidate, term: event.target.value } : candidate) })} /></label><label>{labels.pronunciation}<input value={entry.pronunciation} onChange={(event) => update({ vocabulary: profile.vocabulary.map((candidate) => candidate.id === entry.id ? { ...candidate, pronunciation: event.target.value } : candidate) })} /></label><label>{labels.meaning}<input value={entry.meaning} onChange={(event) => update({ vocabulary: profile.vocabulary.map((candidate) => candidate.id === entry.id ? { ...candidate, meaning: event.target.value } : candidate) })} /></label><label>{labels.part}<input value={entry.partOfSpeech} onChange={(event) => update({ vocabulary: profile.vocabulary.map((candidate) => candidate.id === entry.id ? { ...candidate, partOfSpeech: event.target.value } : candidate) })} /></label><label>{labels.etymology}<input value={entry.etymology} onChange={(event) => update({ vocabulary: profile.vocabulary.map((candidate) => candidate.id === entry.id ? { ...candidate, etymology: event.target.value } : candidate) })} /></label><label>{labels.usage}<input value={entry.usageNote} onChange={(event) => update({ vocabulary: profile.vocabulary.map((candidate) => candidate.id === entry.id ? { ...candidate, usageNote: event.target.value } : candidate) })} /></label><label>{labels.related}<input value={entry.relatedTerms.join(", ")} onChange={(event) => update({ vocabulary: profile.vocabulary.map((candidate) => candidate.id === entry.id ? { ...candidate, relatedTerms: event.target.value.split(",").map((value) => value.trim()).filter(Boolean) } : candidate) })} /></label></div>
        <button type="button" className="danger-ghost" onClick={() => update({ vocabulary: profile.vocabulary.filter((candidate) => candidate.id !== entry.id) })}>{labels.remove}</button>
      </div>)}
      <button type="button" className="secondary-button" onClick={() => update({ vocabulary: [...profile.vocabulary, { id: createId("vocabulary"), term: "", pronunciation: "", meaning: "", partOfSpeech: "", etymology: "", usageNote: "", relatedTerms: [] }] })}>{labels.add}</button>
    </div> : <div className="language-vocabulary-list">{profile.vocabulary.map((entry) => <div key={entry.id}><strong>{entry.term}</strong> <span>[{entry.pronunciation}] · {entry.partOfSpeech}</span><p>{entry.meaning}</p><small>{entry.etymology}{entry.usageNote ? ` · ${entry.usageNote}` : ""}{entry.relatedTerms.length ? ` · ${labels.related}: ${entry.relatedTerms.join(", ")}` : ""}</small></div>)}{profile.vocabulary.length === 0 && <span>-</span>}</div>}</StructuredInfoPanel>
  </>;
}
