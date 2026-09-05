import type { TechnologyProfile, WikiArticle } from "../model/world";
import { NestedProfileSections } from "./NestedProfileSections";
import { StructuredInfoPanel, StructuredInfoRow } from "./StructuredInfoPanel";

export function isTechnologyCategory(category?: string): boolean {
  return category === "technology" || Boolean(category?.startsWith("technology_"));
}

export function TechnologyProfilePanel({ article, editMode, onChange }: { article: WikiArticle; editMode: boolean; onChange: (profile: TechnologyProfile) => void }) {
  const profile = article.technologyProfile ?? { creator: "", creationPeriod: "", characteristicSections: [] };
  const update = (patch: Partial<TechnologyProfile>) => onChange({ ...profile, ...patch });
  return <>
    <StructuredInfoPanel title="기술 정보" className="technology-profile-panel">
      <StructuredInfoRow label="제작자">{editMode ? <input value={profile.creator} onChange={(event) => update({ creator: event.target.value })} /> : <span>{profile.creator || "-"}</span>}</StructuredInfoRow>
      <StructuredInfoRow label="제작 시기">{editMode ? <input value={profile.creationPeriod} onChange={(event) => update({ creationPeriod: event.target.value })} /> : <span>{profile.creationPeriod || "-"}</span>}</StructuredInfoRow>
    </StructuredInfoPanel>
    <NestedProfileSections title="특징" sections={profile.characteristicSections} editMode={editMode} onChange={(characteristicSections) => update({ characteristicSections })} />
  </>;
}
