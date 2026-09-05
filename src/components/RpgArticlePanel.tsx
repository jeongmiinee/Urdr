import { createId, type WikiArticle, type WikiCategory, type WorldProject } from "../model/world";
import { useLocalization } from "../localization";
import { calculateEffectiveValue, modifiersForStat } from "../rpg/calculation";
import { inheritedFamilyModifiers } from "../rpg/inheritance";
import { createEmptyRpgArticleData, type RpgArticleData, type RpgModifier, type RpgScalarValue, type RpgTrait } from "../rpg/schema";
import { validateDiceExpression } from "../rpg/expression";
import { useEffect, useRef } from "react";

type Props = {
  project: WorldProject;
  article: WikiArticle;
  category: WikiCategory;
  editMode: boolean;
  onArticleChange: (data: RpgArticleData | undefined) => void;
  onProjectChange: (project: WorldProject) => void;
  onOpenArticle?: (id: string) => void;
};

const OPT_IN_CATEGORIES = new Set(["country", "faction", "organization", "religion", "culture", "language", "ideology", "technology"]);
const METHOD_LABELS = { thrust: "찌르기", slash: "베기", blunt: "때리기", arrow: "화살", bullet: "탄환", magic: "마법" } as const;
const ATTRIBUTE_LABELS = { normal: "일반", fire: "화염", poison: "독", explosion: "폭발", cold: "냉기", contamination: "오염", electricity: "전류" } as const;
const STAT_TARGET_LABELS: Partial<Record<WikiCategory, { ko: string; en: string }>> = {
  person: { ko: "인물", en: "Character" }, family: { ko: "가문", en: "Family" }, item: { ko: "물건", en: "Item" },
  animal: { ko: "동물", en: "Animal" }, plant: { ko: "식물", en: "Plant" }, country: { ko: "국가", en: "Country" },
  faction: { ko: "세력", en: "Faction" }, organization: { ko: "단체", en: "Organization" }, religion: { ko: "종교", en: "Religion" },
  culture: { ko: "문화", en: "Culture" }, language: { ko: "언어", en: "Language" }, ideology: { ko: "사상", en: "Ideology" },
  technology: { ko: "기술", en: "Technology" },
};

type AppliedEffectEntry = {
  id: string;
  name: string;
  description?: string;
  sourceArticleId?: string;
  modifiers: RpgModifier[];
};

function statSectionTitle(category: WikiCategory, language: "ko" | "en"): string {
  if (category === "family") return language === "ko" ? "가문 특성" : "Family Traits";
  if (category === "person") return language === "ko" ? "인물 고유 수치 및 숙련도" : "Character Attributes and Professions";
  if (category === "item") return language === "ko" ? "물건 고유 수치" : "Item Attributes";
  const target = STAT_TARGET_LABELS[category]?.[language] ?? (language === "ko" ? "문서" : "Document");
  return language === "ko" ? `${target} 수치` : `${target} Stats`;
}

function modifierText(project: WorldProject, modifier: RpgModifier, language: "ko" | "en"): string {
  const stat = project.rpgSettings.definitions.find((definition) => definition.id === modifier.statId)?.label[language] ?? modifier.statId;
  const value = Number.isInteger(modifier.value) ? modifier.value : Number(modifier.value.toFixed(2));
  const expression = modifier.operator === "flat_add" ? `${value >= 0 ? "+" : ""}${value}`
    : modifier.operator === "percent_add" ? `${value >= 0 ? "+" : ""}${value}%`
      : modifier.operator === "multiply" ? `×${value}`
        : modifier.operator === "minimum" ? `≥${value}`
          : modifier.operator === "maximum" ? `≤${value}`
            : `=${value}`;
  return `${stat} ${expression}`;
}

export function RpgArticlePanel({ project, article, category, editMode, onArticleChange, onProjectChange, onOpenArticle }: Props) {
  const { language } = useLocalization();
  if (!project.rpgSettings.enabled) return null;
  const data = article.rpgData;
  if (!data?.enabled) {
    if (!editMode) return null;
    return <section className="rpg-article-panel rpg-opt-in"><button type="button" className="secondary-button" onClick={() => onArticleChange(createEmptyRpgArticleData())}>＋ {statSectionTitle(category, language)} 추가</button>{OPT_IN_CATEGORIES.has(category) && <span>이 문서에는 수치가 자동 부여되지 않습니다.</span>}</section>;
  }

  const appliedEffects = category === "person" ? appliedEffectEntriesForPerson(project, article) : [];
  const inherited = appliedEffects.flatMap((effect) => effect.modifiers);
  const ownModifiers = category === "item" ? data.modifiers.filter((modifier) => modifier.sourceKind !== "equipment") : data.modifiers;
  const allModifiers = [...ownModifiers, ...inherited];
  const sheetDefinitions = new Set(data.sheetIds.flatMap((sheetId) => project.rpgSettings.sheets.find((sheet) => sheet.id === sheetId)?.statIds ?? []));
  if (category === "item") for (const definition of project.rpgSettings.definitions)
    if (definition.categoryId === "equipment-attributes" && definition.kind !== "profession") sheetDefinitions.add(definition.id);
  const definitions = project.rpgSettings.definitions
    .filter((definition) => sheetDefinitions.has(definition.id) || Object.hasOwn(data.values, definition.id))
    .filter((definition) => !definition.archived)
    .filter((definition) => category === "person" || definition.kind !== "profession")
    .filter((definition) => project.rpgSettings.magicEnabled || !definition.magicOnly)
    .filter((definition) => definition.id !== "faith" && definition.id !== "loyalty")
    .sort((a, b) => a.order - b.order);
  const visibleDefinitionIds = new Set(definitions.map((definition) => definition.id));
  const groups = project.rpgSettings.groups
    .filter((group) => !group.archived)
    .filter((group) => definitions.some((definition) => definition.groupId === group.id))
    .sort((a, b) => a.order - b.order);
  const statLines = groups.map((group) => [{ group, definitions: definitions.filter((definition) => definition.groupId === group.id && visibleDefinitionIds.has(definition.id)) }]);

  const update = (patch: Partial<RpgArticleData>) => onArticleChange({ ...data, ...patch });
  const updateValue = (statId: string, value: RpgScalarValue | undefined) => {
    const values = { ...data.values };
    if (value === undefined || value === "") delete values[statId]; else values[statId] = value;
    update({ values });
  };
  const addModifier = () => {
    const statId = definitions[0]?.id ?? project.rpgSettings.definitions[0]?.id;
    if (!statId) return;
    update({ modifiers: [...data.modifiers, { id: createId("rpg-modifier"), statId, operator: "flat_add", value: 0, sourceKind: category === "item" ? "equipment" : OPT_IN_CATEGORIES.has(category) ? "affiliation" : "personal", sourceArticleId: article.id, note: "새 특성", description: "", priority: 100, active: true }] });
  };
  const updateModifier = (id: string, patch: Partial<RpgModifier>) => update({ modifiers: data.modifiers.map((modifier) => modifier.id === id ? { ...modifier, ...patch } : modifier) });
  const attachSheet = (sheetId: string) => update({ sheetIds: [...new Set([...data.sheetIds, sheetId])] });

  const addFamilyTrait = () => {
    const traitId = createId("rpg-trait");
    onProjectChange({
      ...project,
      rpgSettings: {
        ...project.rpgSettings,
        traits: [...project.rpgSettings.traits, { id: traitId, name: "새 가문 특성", description: "", tags: [], modifiers: [], familyArticleId: article.id, scope: "all_members", selectedArticleIds: [], includeSpouses: false, includeAdopted: false }],
      },
      wikiArticles: project.wikiArticles.map((candidate) => candidate.id === article.id ? { ...candidate, rpgData: { ...data, traitIds: [...data.traitIds, traitId] } } : candidate),
    });
  };
  const familyTraits = category === "family"
    ? project.rpgSettings.traits.filter((trait) => data.traitIds.includes(trait.id))
    : [];

  return <section className={`rpg-article-panel ${category === "item" ? "item-rpg-panel" : ""}`}>
    <div className="rpg-article-heading"><h3>{statSectionTitle(category, language)}</h3>{editMode && <button type="button" className="icon-button" title={`${statSectionTitle(category, language)} 숨기기`} onClick={() => update({ enabled: false })}>×</button>}</div>
    {editMode && <div className="rpg-sheet-picker"><select defaultValue="" onChange={(event) => { if (event.target.value) attachSheet(event.target.value); event.target.value = ""; }}><option value="">시트 추가</option>{project.rpgSettings.sheets.filter((sheet) => !data.sheetIds.includes(sheet.id)).map((sheet) => <option key={sheet.id} value={sheet.id}>{sheet.label[language]}</option>)}</select>{data.sheetIds.map((id) => <button type="button" key={id} onClick={() => update({ sheetIds: data.sheetIds.filter((entry) => entry !== id) })}>{project.rpgSettings.sheets.find((sheet) => sheet.id === id)?.label[language] ?? id} ×</button>)}</div>}
    <div className={category === "item" ? "rpg-item-stat-layout" : undefined}><div className="rpg-stat-lines">
      {category === "person" && definitions.some((definition) => definition.kind !== "profession") && <div className="rpg-stat-kind-divider first"><span>{language === "ko" ? "인물 고유 수치" : "Character Attributes"}</span></div>}
      {statLines.map((line, lineIndex) => <div className="rpg-stat-section-row" key={`stat-line-${lineIndex}`}>
        {line[0]?.group.kind === "profession" && statLines[lineIndex - 1]?.[0]?.group.kind !== "profession" && <div className="rpg-stat-kind-divider"><span>{language === "ko" ? "인물 숙련도" : "Character Professions"}</span></div>}
        <div className="rpg-stat-line">
        {line.map(({ group, definitions: groupDefinitions }, groupIndex) => <div className="rpg-stat-group" key={group!.id}>
          <span className="rpg-stat-group-label">{group!.label[language]}</span>
          <div className="rpg-stat-boxes">
            {groupDefinitions.map((definition) => {
              const value = data.values[definition.id];
              const effective = calculateEffectiveValue(value, modifiersForStat(allModifiers, definition.id), project.rpgSettings.modifierOrder);
              const shownValue = effective?.value ?? value;
              const suffix = definition.unit ?? (definition.valueKind === "percentage" ? "%" : "");
              return <div className="rpg-stat-box" key={definition.id}>
                <span>{definition.label[language]}</span>
                <div className="rpg-stat-value">{editMode ? (
                  definition.valueKind === "boolean" ? <input type="checkbox" checked={Boolean(value)} onChange={(event) => updateValue(definition.id, event.target.checked)} />
                  : definition.valueKind === "choice" ? <select value={String(value ?? "")} onChange={(event) => updateValue(definition.id, event.target.value)}><option value="">미지정</option>{definition.choices?.map((choice) => <option key={choice.id} value={choice.id}>{choice.label[language]}</option>)}</select>
                  : definition.valueKind === "text" || definition.valueKind === "dice" ? <input value={String(value ?? "")} aria-invalid={definition.valueKind === "dice" && Boolean(value) && !validateDiceExpression(String(value)).valid} onChange={(event) => updateValue(definition.id, event.target.value)} />
                  : <input type="number" min={definition.minimum} max={definition.maximum} step={definition.step ?? (definition.valueKind === "integer" ? 1 : 0.1)} value={typeof value === "number" ? value : ""} onChange={(event) => updateValue(definition.id, event.target.value === "" ? undefined : Number(event.target.value))} />
                ) : <strong>{shownValue === undefined ? "-" : String(typeof shownValue === "number" && Number.isFinite(shownValue) ? Number(shownValue.toFixed(2)) : shownValue)}{shownValue === undefined ? "" : suffix}</strong>}</div>
                {editMode && effective && effective.value !== value && <small>적용 {Number(effective.value.toFixed(2))}{suffix}</small>}
              </div>;
            })}
          </div>
          {groupIndex < line.length - 1 && <span className="rpg-stat-group-divider" aria-hidden="true" />}
        </div>)}
        </div>
      </div>)}
      {definitions.length === 0 && <p className="empty-hint">연결된 시트에 표시할 수치가 없습니다.</p>}
    </div>{category === "item" && <RpgItemProfiles data={data} editMode={editMode} update={update} />}</div>
    {editMode ? <div className="rpg-modifier-editor"><div className="rpg-definition-toolbar"><strong>{category === "item" || OPT_IN_CATEGORIES.has(category) ? "특성" : "직접 효과"}</strong><button type="button" className="secondary-button" onClick={addModifier}>＋ 특성</button></div>{data.modifiers.map((modifier) => <div className="rpg-feature-editor-card" key={modifier.id}><div className="form-grid two"><label>효과명<input value={modifier.note ?? ""} onChange={(event) => updateModifier(modifier.id, { note: event.target.value })} /></label><label>설명<input value={modifier.description ?? ""} onChange={(event) => updateModifier(modifier.id, { description: event.target.value })} /></label></div><div className="rpg-modifier-row"><select value={modifier.statId} onChange={(event) => updateModifier(modifier.id, { statId: event.target.value })}>{project.rpgSettings.definitions.map((definition) => <option key={definition.id} value={definition.id}>{definition.label[language]}</option>)}</select><select value={modifier.operator} onChange={(event) => updateModifier(modifier.id, { operator: event.target.value as RpgModifier["operator"] })}><option value="flat_add">고정 가산</option><option value="percent_add">백분율 가산</option><option value="multiply">배율</option><option value="minimum">최솟값</option><option value="maximum">최댓값</option><option value="override">덮어쓰기</option></select><input type="number" value={modifier.value} onChange={(event) => updateModifier(modifier.id, { value: Number(event.target.value) })} /><select aria-label="효과 활성 조건" value={modifier.activationMode ?? "always"} onChange={(event) => updateModifier(modifier.id, { activationMode: event.target.value as NonNullable<RpgModifier["activationMode"]> })}><option value="always">항상</option><option value="equipped">장착</option><option value="carried">소지</option><option value="worn">착용</option><option value="wielded">사용</option><option value="consumed">소비</option><option value="manual">수동</option></select><button type="button" className="icon-button danger-ghost" aria-label="효과 삭제" onClick={() => update({ modifiers: data.modifiers.filter((entry) => entry.id !== modifier.id) })}>×</button></div></div>)}</div>
      : data.modifiers.length > 0 && <EffectSummaryList title={category === "item" || OPT_IN_CATEGORIES.has(category) ? "특성" : "직접 효과"} entries={data.modifiers.map((modifier) => ({ id: modifier.id, name: modifier.note || "특성", description: modifier.description, modifiers: [modifier] }))} project={project} language={language} />}
    {category === "person" && article.personProfile && <PersonRelationshipStats project={project} profile={article.personProfile} data={data} modifiers={allModifiers} editMode={editMode} language={language} onOpenArticle={onOpenArticle} onChange={(personProfile) => onProjectChange({ ...project, wikiArticles: project.wikiArticles.map((candidate) => candidate.id === article.id ? { ...candidate, personProfile } : candidate) })} />}
    {appliedEffects.length > 0 && <EffectSummaryList title="적용 중인 효과" entries={appliedEffects} project={project} language={language} onOpenArticle={onOpenArticle} />}
    {category === "family" && (editMode || familyTraits.length > 0) && <div className="rpg-family-traits">{editMode && <div className="rpg-family-trait-actions"><button type="button" className="secondary-button" onClick={addFamilyTrait}>＋ 특성</button></div>}{editMode ? familyTraits.map((trait) => <FamilyTraitEditor key={trait.id} project={project} trait={trait} editMode={editMode} language={language} onChange={(nextTrait) => onProjectChange({ ...project, rpgSettings: { ...project.rpgSettings, traits: project.rpgSettings.traits.map((entry) => entry.id === trait.id ? nextTrait : entry) } })} />) : <EffectSummaryList entries={familyTraits.map((trait) => ({ id: trait.id, name: trait.name, description: trait.description, modifiers: trait.modifiers }))} project={project} language={language} />}</div>}
    {OPT_IN_CATEGORIES.has(category) && <GrantedEffectsEditor project={project} data={data} editMode={editMode} update={update} language={language} />}
  </section>;
}

function appliedEffectEntriesForPerson(project: WorldProject, person: WikiArticle): AppliedEffectEntry[] {
  const year = (project.maps.find((map) => map.id === project.activeMapId) ?? project.maps[0])?.timeline.currentYear ?? 0;
  const profile = person.personProfile;
  if (!profile) return [];
  const nationalityIds = profile.nationalityArticleIds ?? (profile.countryArticleId ? [profile.countryArticleId] : []);
  const affiliationIds = profile.affiliationArticleIds ?? [...profile.organizationArticleIds, ...profile.factionArticleIds];
  const affiliations = new Set([...nationalityIds, ...affiliationIds]);
  const result: AppliedEffectEntry[] = [];
  const familyModifiers = inheritedFamilyModifiers(project, person.id);
  for (const traitId of new Set(familyModifiers.map((modifier) => modifier.sourceTraitId).filter((id): id is string => Boolean(id)))) {
    const trait = project.rpgSettings.traits.find((candidate) => candidate.id === traitId);
    const modifiers = familyModifiers.filter((modifier) => modifier.sourceTraitId === traitId);
    result.push({
      id: `family-${traitId}`,
      name: trait?.name ?? "가문 특성",
      description: trait?.description,
      sourceArticleId: trait?.familyArticleId,
      modifiers,
    });
  }
  for (const source of project.wikiArticles) {
    for (const grant of source.rpgData?.grantedEffects ?? []) {
      if (!grant.active || (grant.startYear !== undefined && grant.startYear > year) || (grant.endYear !== undefined && grant.endYear !== null && grant.endYear < year)) continue;
      const relationshipMatch = grant.targetType === "selected"
        ? grant.targetArticleIds.includes(person.id)
        : grant.targetType === "citizens"
          ? nationalityIds.includes(source.id)
          : grant.targetType === "members"
            ? affiliations.has(source.id)
            : grant.targetType === "leaders"
              ? source.factionProfile?.leaderArticleId === person.id
              : grant.targetArticleIds.includes(person.id);
      if (!relationshipMatch) continue;
      result.push({
        id: `${source.id}-${grant.id}`,
        name: grant.name?.trim() || source.title,
        description: grant.description?.trim() || source.summary,
        sourceArticleId: source.id,
        modifiers: grant.modifiers.map((modifier) => ({ ...modifier, sourceKind: "affiliation" as const, sourceArticleId: source.id })),
      });
    }
    if (source.category !== "item" || !source.itemProfile || !source.rpgData) continue;
    const owned = source.itemProfile.ownershipHistory.some((period) => period.ownerType === "person" && period.ownerId === person.id && period.startYear <= year && (period.endYear === null || period.endYear >= year));
    if (!owned) continue;
    const modifiers = source.rpgData.modifiers.filter((modifier) => modifier.sourceKind === "equipment" && modifier.active !== false).map((modifier) => ({ ...modifier, sourceArticleId: source.id }));
    if (modifiers.length > 0) result.push({ id: `item-${source.id}`, name: source.title, description: source.summary, sourceArticleId: source.id, modifiers });
  }
  return result;
}

function EffectSummaryList({ title, entries, project, language, onOpenArticle }: { title?: string; entries: AppliedEffectEntry[]; project: WorldProject; language: "ko" | "en"; onOpenArticle?: (id: string) => void }) {
  return <div className={`rpg-effect-summary${title ? "" : " ungrouped"}`}>{title && <strong>{title}</strong>}<ul>{entries.map((entry) => {
    const content = <><strong>{entry.name}</strong><span>- {entry.modifiers.length > 0 ? entry.modifiers.map((modifier) => modifierText(project, modifier, language)).join(", ") : "효과 없음"}</span></>;
    const canOpen = Boolean(entry.sourceArticleId && onOpenArticle);
    return <li key={entry.id}>
      {canOpen
        ? <button type="button" onClick={() => onOpenArticle?.(entry.sourceArticleId!)}>{content}</button>
        : <div className="rpg-effect-label">{content}</div>}
      {entry.description && <p>{entry.description}</p>}
    </li>;
  })}</ul></div>;
}

function PersonRelationshipStats({ project, profile, data, modifiers, editMode, language, onChange, onOpenArticle }: {
  project: WorldProject;
  profile: NonNullable<WikiArticle["personProfile"]>;
  data: RpgArticleData;
  modifiers: RpgModifier[];
  editMode: boolean;
  language: "ko" | "en";
  onChange: (profile: NonNullable<WikiArticle["personProfile"]>) => void;
  onOpenArticle?: (id: string) => void;
}) {
  const affiliations = [...new Set([
    ...(profile.nationalityArticleIds ?? (profile.countryArticleId ? [profile.countryArticleId] : [])),
    ...(profile.affiliationArticleIds ?? [...profile.organizationArticleIds, ...profile.factionArticleIds]),
  ])];
  const religions = profile.religionArticleIds ?? (profile.religionArticleId ? [profile.religionArticleId] : []);
  const relationships = [
    ...affiliations.map((sourceId) => ({ kind: "loyalty" as const, sourceId })),
    ...religions.map((sourceId) => ({ kind: "faith" as const, sourceId })),
  ];
  if (relationships.length === 0) return null;
  const setValue = (kind: "loyalty" | "faith", sourceId: string, value: number | undefined) => {
    const key = kind === "loyalty" ? "loyaltyByAffiliation" : "faithByReligion";
    const current = { ...(profile[key] ?? {}) };
    if (value === undefined) delete current[sourceId]; else current[sourceId] = value;
    onChange({ ...profile, [key]: current });
  };
  return <section className="rpg-relationship-stats">
    <strong>{language === "ko" ? "관계 수치" : "Relationship Stats"}</strong>
    <div className="rpg-relationship-grid">{relationships.map(({ kind, sourceId }) => {
      const definition = project.rpgSettings.definitions.find((candidate) => candidate.id === kind);
      const stored = kind === "loyalty" ? profile.loyaltyByAffiliation?.[sourceId] : profile.faithByReligion?.[sourceId];
      const legacy = typeof data.values[kind] === "number" ? data.values[kind] as number : undefined;
      const value = stored ?? legacy;
      const sourceModifiers = modifiersForStat(modifiers, kind).filter((modifier) => modifier.sourceKind !== "affiliation" || !modifier.sourceArticleId || modifier.sourceArticleId === sourceId);
      const effective = calculateEffectiveValue(value, sourceModifiers, project.rpgSettings.modifierOrder);
      const shown = effective?.value ?? value;
      const source = project.wikiArticles.find((candidate) => candidate.id === sourceId);
      const title = source?.title ?? (language === "ko" ? "연결된 대상" : "Linked target");
      return <div className="rpg-relationship-card" key={`${kind}-${sourceId}`}>
        <span>{definition?.label[language] ?? (kind === "loyalty" ? (language === "ko" ? "충성심" : "Loyalty") : (language === "ko" ? "신앙심" : "Faith"))}</span>
        <div className="rpg-relationship-source">
          {onOpenArticle && source ? <button type="button" data-user-authored="true" onClick={() => onOpenArticle(sourceId)}>{title}</button> : <strong data-user-authored="true">{title}</strong>}
          {kind === "loyalty" && editMode && <label title="주 소속"><input type="radio" name={`primary-affiliation-${profile.nationalityArticleIds?.[0] ?? profile.countryArticleId ?? "person"}`} checked={profile.primaryAffiliationArticleId === sourceId} onChange={() => onChange({ ...profile, primaryAffiliationArticleId: sourceId })} /><span>{language === "ko" ? "주 소속" : "Primary"}</span></label>}
          {kind === "loyalty" && !editMode && profile.primaryAffiliationArticleId === sourceId && <small>{language === "ko" ? "주 소속" : "Primary"}</small>}
        </div>
        <div className="rpg-relationship-value">{editMode
          ? <input type="number" aria-label={`${title} ${definition?.label[language] ?? kind}`} value={value ?? ""} onChange={(event) => setValue(kind, sourceId, event.target.value === "" ? undefined : Number(event.target.value))} />
          : <strong>{shown === undefined ? (language === "ko" ? "미지정" : "Unspecified") : Number(shown.toFixed(2))}</strong>}
          {editMode && effective && effective.value !== value && <small>{language === "ko" ? "적용" : "Effective"} {Number(effective.value.toFixed(2))}</small>}
        </div>
      </div>;
    })}</div>
  </section>;
}

function GrantedEffectsEditor({ project, data, editMode, update, language }: { project: WorldProject; data: RpgArticleData; editMode: boolean; update: (patch: Partial<RpgArticleData>) => void; language: "ko" | "en" }) {
  type GrantedEffect = RpgArticleData["grantedEffects"][number];
  const updateEffect = (id: string, patch: Partial<GrantedEffect>) => update({ grantedEffects: data.grantedEffects.map((entry) => entry.id === id ? { ...entry, ...patch } : entry) });
  const addEffect = () => update({ grantedEffects: [...data.grantedEffects, { id: createId("rpg-grant"), name: "새 특성", description: "", modifiers: [], targetType: "selected", targetArticleIds: [], activationMode: "always", active: true }] });
  const addModifier = (effect: GrantedEffect) => {
    const statId = project.rpgSettings.definitions[0]?.id;
    if (!statId) return;
    updateEffect(effect.id, { modifiers: [...effect.modifiers, { id: createId("rpg-grant-modifier"), statId, operator: "flat_add", value: 0, sourceKind: "affiliation", priority: 100, active: true }] });
  };
  if (!editMode) return data.grantedEffects.length > 0
    ? <EffectSummaryList title={language === "ko" ? "특성" : "Traits"} entries={data.grantedEffects.map((effect) => ({ id: effect.id, name: effect.name || (language === "ko" ? "특성" : "Trait"), description: effect.description, modifiers: effect.modifiers }))} project={project} language={language} />
    : null;
  return <div className="rpg-granted-effects"><div className="rpg-definition-toolbar"><strong>특성</strong><button type="button" className="secondary-button" onClick={addEffect}>＋ 특성</button></div>{data.grantedEffects.map((effect) => <div className="rpg-granted-effect-card" key={effect.id}>
    <div className="form-grid two"><label>특성명<input value={effect.name ?? ""} onChange={(event) => updateEffect(effect.id, { name: event.target.value })} /></label><label>설명<input value={effect.description ?? ""} onChange={(event) => updateEffect(effect.id, { description: event.target.value })} /></label></div>
    <div className="rpg-granted-effect-row"><select value={effect.targetType} onChange={(event) => updateEffect(effect.id, { targetType: event.target.value as typeof effect.targetType })}><option value="citizens">시민</option><option value="members">구성원</option><option value="leaders">지도자</option><option value="locations">통제 장소</option><option value="adherents">신도</option><option value="organizations">종교 단체</option><option value="selected">선택 문서</option></select><select multiple value={effect.targetArticleIds} onChange={(event) => updateEffect(effect.id, { targetArticleIds: [...event.target.selectedOptions].map((option) => option.value) })}>{project.wikiArticles.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.title}</option>)}</select><label><input type="checkbox" checked={effect.active} onChange={(event) => updateEffect(effect.id, { active: event.target.checked })} /> 활성</label><button type="button" className="danger-ghost" onClick={() => update({ grantedEffects: data.grantedEffects.filter((entry) => entry.id !== effect.id) })}>삭제</button></div>
    <div className="rpg-definition-toolbar"><strong>실질적 효과</strong><button type="button" className="secondary-button" onClick={() => addModifier(effect)}>＋ 효과</button></div>
    {effect.modifiers.map((modifier) => <div className="rpg-modifier-row compact" key={modifier.id}><select value={modifier.statId} onChange={(event) => updateEffect(effect.id, { modifiers: effect.modifiers.map((entry) => entry.id === modifier.id ? { ...entry, statId: event.target.value } : entry) })}>{project.rpgSettings.definitions.map((definition) => <option key={definition.id} value={definition.id}>{definition.label.ko}</option>)}</select><select value={modifier.operator} onChange={(event) => updateEffect(effect.id, { modifiers: effect.modifiers.map((entry) => entry.id === modifier.id ? { ...entry, operator: event.target.value as RpgModifier["operator"] } : entry) })}><option value="flat_add">고정 가산</option><option value="percent_add">백분율 가산</option><option value="multiply">배율</option><option value="minimum">최솟값</option><option value="maximum">최댓값</option><option value="override">덮어쓰기</option></select><input type="number" value={modifier.value} onChange={(event) => updateEffect(effect.id, { modifiers: effect.modifiers.map((entry) => entry.id === modifier.id ? { ...entry, value: Number(event.target.value) } : entry) })} /><button type="button" className="icon-button danger-ghost" onClick={() => updateEffect(effect.id, { modifiers: effect.modifiers.filter((entry) => entry.id !== modifier.id) })}>×</button></div>)}
  </div>)}</div>;
}

function FamilyTraitEditor({ project, trait, editMode, onChange, language }: { project: WorldProject; trait: RpgTrait; editMode: boolean; language: "ko" | "en"; onChange: (trait: RpgTrait) => void }) {
  const family = project.wikiArticles.find((article) => article.id === trait.familyArticleId)?.familyProfile;
  const people = (family?.members ?? []).filter((member) => member.articleId).map((member) => ({ id: member.articleId!, label: project.wikiArticles.find((article) => article.id === member.articleId)?.title ?? member.name }));
  if (!editMode) return <div className="rpg-family-trait-row"><strong>{trait.name}</strong><span>{trait.description || "설명 없음"}</span><small>{trait.scope === "all_members" ? "전체 구성원" : trait.scope === "lineal" ? "직계 일가" : trait.scope === "collateral" ? "방계 일가" : "선택 구성원"}</small><div className="rpg-trait-effect-text">{trait.modifiers.length > 0 ? trait.modifiers.map((modifier) => modifierText(project, modifier, language)).join(", ") : "효과 없음"}</div></div>;
  const addModifier = () => {
    const statId = project.rpgSettings.definitions[0]?.id;
    if (!statId) return;
    onChange({ ...trait, modifiers: [...trait.modifiers, { id: createId("rpg-trait-modifier"), statId, operator: "flat_add", value: 0, sourceKind: "family", sourceArticleId: trait.familyArticleId, sourceTraitId: trait.id, priority: 100, active: true }] });
  };
  return <div className="rpg-family-trait-editor">
    <div className="form-grid two"><label>특성명<input value={trait.name} onChange={(event) => onChange({ ...trait, name: event.target.value })} /></label><label>적용 범위<select value={trait.scope} onChange={(event) => onChange({ ...trait, scope: event.target.value as RpgTrait["scope"] })}><option value="all_members">전체 구성원</option><option value="lineal">직계 일가</option><option value="collateral">방계 일가</option><option value="selected_members">일부 구성원</option></select></label></div>
    <label>설명<textarea value={trait.description} onChange={(event) => onChange({ ...trait, description: event.target.value })} /></label>
    {(trait.scope === "lineal" || trait.scope === "collateral") && <div className="form-grid two"><label>기준 인물<select value={trait.anchorArticleId ?? ""} onChange={(event) => onChange({ ...trait, anchorArticleId: event.target.value || undefined })}><option value="">미지정</option>{people.map((person) => <option key={person.id} value={person.id}>{person.label}</option>)}</select></label><label>최대 친족 촌수<input type="number" min={1} value={trait.maximumKinshipDegree ?? ""} onChange={(event) => onChange({ ...trait, maximumKinshipDegree: event.target.value === "" ? undefined : Number(event.target.value) })} /></label></div>}
    {trait.scope === "selected_members" && <label>적용 인물<select multiple value={trait.selectedArticleIds} onChange={(event) => onChange({ ...trait, selectedArticleIds: [...event.target.selectedOptions].map((option) => option.value) })}>{people.map((person) => <option key={person.id} value={person.id}>{person.label}</option>)}</select></label>}
    <div className="rpg-trait-options"><label><input type="checkbox" checked={trait.includeSpouses} onChange={(event) => onChange({ ...trait, includeSpouses: event.target.checked })} /> 배우자 포함</label><label><input type="checkbox" checked={trait.includeAdopted} onChange={(event) => onChange({ ...trait, includeAdopted: event.target.checked })} /> 입양 관계 포함</label></div>
    <div className="rpg-definition-toolbar"><strong>특성 효과</strong><button type="button" className="secondary-button" onClick={addModifier}>＋ 효과</button></div>
    {trait.modifiers.map((modifier) => <div className="rpg-modifier-row" key={modifier.id}><select value={modifier.statId} onChange={(event) => onChange({ ...trait, modifiers: trait.modifiers.map((entry) => entry.id === modifier.id ? { ...entry, statId: event.target.value } : entry) })}>{project.rpgSettings.definitions.map((definition) => <option key={definition.id} value={definition.id}>{definition.label.ko}</option>)}</select><select value={modifier.operator} onChange={(event) => onChange({ ...trait, modifiers: trait.modifiers.map((entry) => entry.id === modifier.id ? { ...entry, operator: event.target.value as RpgModifier["operator"] } : entry) })}><option value="flat_add">고정 가산</option><option value="percent_add">백분율 가산</option><option value="multiply">배율</option><option value="minimum">최솟값</option><option value="maximum">최댓값</option><option value="override">덮어쓰기</option></select><input type="number" value={modifier.value} onChange={(event) => onChange({ ...trait, modifiers: trait.modifiers.map((entry) => entry.id === modifier.id ? { ...entry, value: Number(event.target.value) } : entry) })} /><button type="button" className="icon-button danger-ghost" onClick={() => onChange({ ...trait, modifiers: trait.modifiers.filter((entry) => entry.id !== modifier.id) })}>×</button></div>)}
  </div>;
}

function EditableTechniqueName({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current && document.activeElement !== ref.current && ref.current.textContent !== value) ref.current.textContent = value;
  }, [value]);
  return <div ref={ref} className="rpg-technique-name-field" contentEditable suppressContentEditableWarning role="textbox" aria-label="기술명" data-placeholder="기술명" onInput={(event) => onChange(event.currentTarget.textContent ?? "")} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } }} />;
}

function RpgItemProfiles({ data, editMode, update }: { data: RpgArticleData; editMode: boolean; update: (patch: Partial<RpgArticleData>) => void }) {
  const addAttack = () => update({ attackProfiles: [...data.attackProfiles, { id: createId("attack"), name: "기본 공격", damage: "1d4", methods: ["slash"], attributes: ["normal"] }] });
  const armor = data.armorProfile;
  const updateAttack = (id: string, patch: Partial<RpgArticleData["attackProfiles"][number]>) => update({ attackProfiles: data.attackProfiles.map((profile) => profile.id === id ? { ...profile, ...patch } : profile) });
  const methodSelect = (profile: RpgArticleData["attackProfiles"][number]) => <select multiple aria-label="피해 수단" value={profile.methods} onChange={(event) => updateAttack(profile.id, { methods: [...event.target.selectedOptions].map((option) => option.value as typeof profile.methods[number]) })}>{Object.entries(METHOD_LABELS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select>;
  const attributeSelect = (profile: RpgArticleData["attackProfiles"][number]) => <select multiple aria-label="피해 속성" value={profile.attributes} onChange={(event) => updateAttack(profile.id, { attributes: [...event.target.selectedOptions].map((option) => option.value as typeof profile.attributes[number]) })}>{Object.entries(ATTRIBUTE_LABELS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select>;
  const hasAttack = data.attackProfiles.length > 0;
  if (!editMode && !hasAttack && !armor) return null;
  return <div className={`rpg-item-profiles${!hasAttack && !armor ? " create-only" : ""}`}>
    {(editMode || hasAttack) && <div className="rpg-definition-toolbar"><strong>{hasAttack ? "공격 방식" : "공격 방식 추가"}</strong>{editMode && <button type="button" className="secondary-button" onClick={addAttack}>＋ 공격</button>}</div>}
    {hasAttack && <div className="rpg-technique-table">{data.attackProfiles.map((profile) => <div className="rpg-technique-row" key={profile.id}><div className="rpg-technique-name">{editMode ? <EditableTechniqueName value={profile.name} onChange={(name) => updateAttack(profile.id, { name })} /> : <strong>{profile.name}</strong>}</div><div className="rpg-technique-values"><label><span>피해량</span>{editMode ? <input value={profile.damage} aria-invalid={typeof profile.damage === "string" && !validateDiceExpression(profile.damage).valid} onChange={(event) => updateAttack(profile.id, { damage: event.target.value })} /> : <strong>{profile.damage}</strong>}</label><label><span>피해 수단</span>{editMode ? methodSelect(profile) : <strong>{profile.methods.map((id) => METHOD_LABELS[id]).join(", ") || "없음"}</strong>}</label><label><span>피해 속성</span>{editMode ? attributeSelect(profile) : <strong>{profile.attributes.map((id) => ATTRIBUTE_LABELS[id]).join(", ") || "없음"}</strong>}</label>{editMode && <button type="button" className="danger-ghost" onClick={() => update({ attackProfiles: data.attackProfiles.filter((entry) => entry.id !== profile.id) })}>삭제</button>}</div></div>)}</div>}
    {(editMode || armor) && <div className="rpg-definition-toolbar"><strong>{armor ? "방어 방식" : "방어 방식 추가"}</strong>{editMode && !armor && <button type="button" className="secondary-button" onClick={() => update({ armorProfile: { defense: Number(data.values.defense ?? 0), durability: Number(data.values.durability ?? 100), methodDefense: { thrust: false, slash: false, blunt: false, arrow: false, bullet: false, magic: false }, attributes: [] } })}>＋ 방어 방식</button>}</div>}
    {armor && <div className="rpg-technique-table"><div className="rpg-technique-row"><div className="rpg-technique-name"><strong>방어</strong></div><div className="rpg-technique-values"><label><span>방어 수단</span>{editMode ? <select multiple value={Object.keys(armor.methodDefense).filter((id) => armor.methodDefense[id as keyof typeof armor.methodDefense])} onChange={(event) => { const selected = new Set([...event.target.selectedOptions].map((option) => option.value)); update({ armorProfile: { ...armor, methodDefense: Object.fromEntries(Object.keys(METHOD_LABELS).map((id) => [id, selected.has(id)])) as typeof armor.methodDefense } }); }}>{Object.entries(METHOD_LABELS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select> : <strong>{Object.entries(armor.methodDefense).filter(([,enabled]) => enabled).map(([id]) => METHOD_LABELS[id as keyof typeof METHOD_LABELS]).join(", ") || "없음"}</strong>}</label><label><span>방어 속성</span>{editMode ? <select multiple value={armor.attributes} onChange={(event) => update({ armorProfile: { ...armor, attributes: [...event.target.selectedOptions].map((option) => option.value as typeof armor.attributes[number]) } })}>{Object.entries(ATTRIBUTE_LABELS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select> : <strong>{armor.attributes.map((id) => ATTRIBUTE_LABELS[id]).join(", ") || "없음"}</strong>}</label>{editMode && <button type="button" className="danger-ghost" onClick={() => update({ armorProfile: undefined })}>제거</button>}</div></div></div>}
  </div>;
}
