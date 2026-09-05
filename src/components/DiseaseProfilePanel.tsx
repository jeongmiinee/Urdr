import type { DiseaseDebuffRule, DiseaseProfile, WikiArticle, WorldProject } from "../model/world";
import { useLocalization } from "../localization";
import { StructuredInfoPanel, StructuredInfoRow } from "./StructuredInfoPanel";

function articlesFor(project: WorldProject, category: string, excludedId?: string): WikiArticle[] {
  return project.wikiArticles.filter((article) => article.id !== excludedId && article.category === category);
}

function splitList(value: string): string[] {
  return value.split(/[,\n]/).map((entry) => entry.trim()).filter(Boolean);
}

function debuffSummary(debuff: DiseaseDebuffRule, language: "ko" | "en"): string {
  if (!debuff.target) return debuff.condition || "-";
  const operator = { add: "+", subtract: "−", multiply: "×", set: "=" }[debuff.operation];
  const unit = debuff.unit === "percent" ? "%" : debuff.unit === "multiplier" ? "×" : "";
  const details = [
    debuff.duration && `${language === "ko" ? "기간" : "duration"}: ${debuff.duration}`,
    debuff.condition && `${language === "ko" ? "조건" : "condition"}: ${debuff.condition}`,
    debuff.stacking !== "replace" && (debuff.stacking === "stack"
      ? (language === "ko" ? "누적" : "stack")
      : (language === "ko" ? "최대값" : "strongest")),
  ].filter(Boolean);
  return `${debuff.target} ${operator}${debuff.value}${unit}${details.length > 0 ? ` (${details.join(", ")})` : ""}`;
}

export function DiseaseProfilePanel({
  project,
  article,
  editMode,
  onChange,
  onOpenArticle,
}: {
  project: WorldProject;
  article: WikiArticle;
  editMode: boolean;
  onChange: (profile: DiseaseProfile) => void;
  onOpenArticle?: (id: string) => void;
}) {
  const { language } = useLocalization();
  const profile = article.diseaseProfile ?? {
    aliases: "",
    cause: "",
    incubationPeriod: "",
    symptomArticleIds: [],
    symptomNotes: "",
    relatedDiseaseArticleIds: [],
    symptoms: [],
    aftereffects: [],
    debuffs: [],
  };
  const symptoms = profile.symptoms ?? splitList(profile.symptomNotes);
  const aftereffects = profile.aftereffects ?? profile.disabilities ?? [];
  const debuffs = profile.debuffs ?? [];
  const diseases = articlesFor(project, "disease", article.id);
  const labels = language === "ko" ? {
    infoTitle: "질병 정보", symptomTitle: "증상", aliases: "이명", cause: "발병 원인", incubation: "잠복 기간",
    symptoms: "증상", aftereffects: "후유증", debuffs: "디버프", related: "관련 질병", none: "없음",
    target: "대상", operation: "연산", value: "수치", unit: "단위", duration: "기간", stacking: "중첩", condition: "조건",
    addDebuff: "+ 디버프 추가", rpgDisabled: "RPG 규칙을 사용하는 세계에서 편집할 수 있습니다. 저장된 디버프는 유지됩니다.",
  } : {
    infoTitle: "Disease Information", symptomTitle: "Symptoms", aliases: "Aliases", cause: "Cause", incubation: "Incubation period",
    symptoms: "Symptoms", aftereffects: "Aftereffects", debuffs: "Debuffs", related: "Related diseases", none: "None",
    target: "Target", operation: "Operation", value: "Value", unit: "Unit", duration: "Duration", stacking: "Stacking", condition: "Condition",
    addDebuff: "+ Add Debuff", rpgDisabled: "Debuffs can be edited in worlds using RPG rules. Saved debuffs are preserved.",
  };
  const update = (patch: Partial<DiseaseProfile>) => onChange({ ...profile, ...patch });
  const linkedList = (ids: string[]) => ids.length > 0
    ? ids.map((id, index) => {
        const target = project.wikiArticles.find((candidate) => candidate.id === id);
        return <span key={id}>{index > 0 && ", "}{target && onOpenArticle
          ? <button type="button" className="wiki-inline-button" onClick={() => onOpenArticle(id)}>{target.title}</button>
          : target?.title ?? id}</span>;
      })
    : labels.none;
  const rpgTargets = project.rpgSettings.definitions
    .filter((definition) => !definition.archived && (project.rpgSettings.magicEnabled || !definition.magicOnly))
    .map((definition) => definition.label[language]);
  const updateDebuff = (index: number, patch: Partial<DiseaseDebuffRule>) => update({
    debuffs: debuffs.map((debuff, candidate) => candidate === index ? { ...debuff, ...patch } : debuff),
  });

  return <>
    <StructuredInfoPanel title={labels.infoTitle} className="disease-profile-panel">
      <StructuredInfoRow label={labels.aliases}>{editMode
        ? <input value={profile.aliases} onChange={(event) => update({ aliases: event.target.value })} />
        : <span>{profile.aliases || labels.none}</span>}</StructuredInfoRow>
      <StructuredInfoRow label={labels.cause}>{editMode
        ? <textarea value={profile.cause} onChange={(event) => update({ cause: event.target.value })} />
        : <p>{profile.cause || labels.none}</p>}</StructuredInfoRow>
      <StructuredInfoRow label={labels.incubation}>{editMode
        ? <input value={profile.incubationPeriod} onChange={(event) => update({ incubationPeriod: event.target.value })} />
        : <span>{profile.incubationPeriod || labels.none}</span>}</StructuredInfoRow>
      <StructuredInfoRow label={labels.related}>{editMode
        ? <select multiple value={profile.relatedDiseaseArticleIds} onChange={(event) => update({ relatedDiseaseArticleIds: [...event.target.selectedOptions].map((option) => option.value) })}>
            {diseases.map((disease) => <option key={disease.id} value={disease.id}>{disease.title}</option>)}
          </select>
        : <p>{linkedList(profile.relatedDiseaseArticleIds)}</p>}</StructuredInfoRow>
    </StructuredInfoPanel>
    <StructuredInfoPanel title={labels.symptomTitle} className="disease-effects-panel">
      <StructuredInfoRow label={labels.symptoms}>{editMode
        ? <textarea value={symptoms.join(", ")} onChange={(event) => update({ symptoms: splitList(event.target.value) })} />
        : <span>{symptoms.join(", ") || labels.none}</span>}</StructuredInfoRow>
      <StructuredInfoRow label={labels.aftereffects}>{editMode
        ? <textarea value={aftereffects.join(", ")} onChange={(event) => update({ aftereffects: splitList(event.target.value) })} />
        : <span>{aftereffects.join(", ") || labels.none}</span>}</StructuredInfoRow>
      <StructuredInfoRow label={labels.debuffs}>{editMode ? project.rpgSettings.enabled ? <div className="rpg-modifier-editor">
        {debuffs.map((debuff, index) => <div className="rpg-feature-editor-card" key={`${debuff.target}-${index}`}>
          <div className="rpg-modifier-row">
            <select aria-label={labels.target} value={debuff.target} onChange={(event) => updateDebuff(index, { target: event.target.value })}>
              <option value="">{labels.target}</option>
              {rpgTargets.map((target) => <option key={target} value={target}>{target}</option>)}
            </select>
            <select aria-label={labels.operation} value={debuff.operation} onChange={(event) => updateDebuff(index, { operation: event.target.value as DiseaseDebuffRule["operation"] })}>
              <option value="add">+</option><option value="subtract">−</option><option value="multiply">×</option><option value="set">=</option>
            </select>
            <input aria-label={labels.value} type="number" min={0} value={debuff.value} onChange={(event) => updateDebuff(index, { value: Math.max(0, Number(event.target.value)) })} />
            <select aria-label={labels.unit} value={debuff.unit} onChange={(event) => updateDebuff(index, { unit: event.target.value as DiseaseDebuffRule["unit"] })}>
              <option value="point">pt</option><option value="percent">%</option><option value="multiplier">×</option>
            </select>
            <button type="button" className="icon-button danger-ghost" aria-label="Delete" onClick={() => update({ debuffs: debuffs.filter((_, candidate) => candidate !== index) })}>×</button>
          </div>
          <div className="form-grid three">
            <label>{labels.duration}<input value={debuff.duration} onChange={(event) => updateDebuff(index, { duration: event.target.value })} /></label>
            <label>{labels.stacking}<select value={debuff.stacking} onChange={(event) => updateDebuff(index, { stacking: event.target.value as DiseaseDebuffRule["stacking"] })}><option value="replace">Replace</option><option value="stack">Stack</option><option value="strongest">Strongest</option></select></label>
            <label>{labels.condition}<input value={debuff.condition} onChange={(event) => updateDebuff(index, { condition: event.target.value })} /></label>
          </div>
        </div>)}
        <button type="button" className="secondary-button" disabled={rpgTargets.length === 0} onClick={() => update({ debuffs: [...debuffs, { target: rpgTargets[0] ?? "", operation: "subtract", value: 0, unit: "percent", duration: "", stacking: "replace", condition: "" }] })}>{labels.addDebuff}</button>
      </div> : <span>{labels.rpgDisabled}</span>
        : <span>{debuffs.map((debuff) => debuffSummary(debuff, language)).join(", ") || labels.none}</span>}</StructuredInfoRow>
    </StructuredInfoPanel>
  </>;
}
