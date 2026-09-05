import { useMemo, useState } from "react";
import {
  activeCalendarYearFromWorldYear,
  createId,
  formatCalendarYear,
  worldYearFromActiveCalendarYear,
  type FamilyProfile,
  type FamilyTreeMember,
  type GovernmentProfile,
  type ItemOwnershipPeriod,
  type OwnershipTargetType,
  type PersonProfile,
  type ReligionProfile,
  type WikiArticle,
  type WorldProject,
} from "../model/world";
import { HeraldryDisplay, HeraldryEditorFields } from "./HeraldryStudio";
import { sortSelectionOptions } from "../model/selectionSort";
import { StructuredInfoPanel, StructuredInfoRow } from "./StructuredInfoPanel";
import { NestedProfileSections } from "./NestedProfileSections";
import {
  assignPersonFamilyInProject,
  familyForPerson,
  familyLineageForPerson,
  hasPrivateLineage,
  normalizeFamilyMembers,
  synchronizeFamilyProfileInProject,
} from "../model/genealogy";

function systemArticles(project: WorldProject, key: string): WikiArticle[] {
  const ids = new Set(project.wikiCategories.filter((category) => (category.templateKey ?? category.systemKey) === key).map((category) => category.id));
  const items = project.wikiArticles.filter((article) => article.category === key || (article.categoryId ? ids.has(article.categoryId) : false));
  const order = sortSelectionOptions(items.map((item) => ({ id: item.id, label: item.title })));
  const rank = new Map(order.map((item, index) => [item.id, index]));
  return items.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
}
function personArticles(project: WorldProject): WikiArticle[] { return systemArticles(project, "person"); }
function articleTitle(project: WorldProject, id?: string): string { return id ? project.wikiArticles.find((article) => article.id === id)?.title ?? "삭제된 인물" : "미지정"; }
function displayedCalendar(project: WorldProject): WikiArticle | undefined { return project.wikiArticles.find((article) => article.id === project.timelineCalendarArticleId && article.calendarProfile); }
function yearLabel(project: WorldProject, year?: number): string {
  if (year === undefined) return "?";
  const calendar = displayedCalendar(project);
  return calendar ? formatCalendarYear(project, calendar, year) : `${year}년`;
}

function ActiveYearInput({ project, value, onChange, placeholder }: { project: WorldProject; value?: number | null; onChange: (value: number | undefined) => void; placeholder?: string }) {
  const displayed = value === undefined || value === null ? "" : activeCalendarYearFromWorldYear(project, value);
  return <input type="number" value={displayed} placeholder={placeholder} onChange={(event) => onChange(event.target.value === "" ? undefined : worldYearFromActiveCalendarYear(project, Number(event.target.value)))} />;
}
function lifeSpan(project: WorldProject, birth?: number, death?: number): string {
  if (birth === undefined && death === undefined) return "생몰년 미상";
  return `${yearLabel(project, birth)} - ${death === undefined ? "현재" : yearLabel(project, death)}`;
}

function RelationPicker({ label, values, options, onChange }: { label: string; values: string[]; options: WikiArticle[]; onChange: (values: string[]) => void }) {
  const [candidate, setCandidate] = useState("");
  const sorted = sortSelectionOptions(options.filter((item) => !values.includes(item.id)).map((item) => ({ id: item.id, label: item.title })));
  return <div className="relation-picker"><div className="inline-control"><select aria-label={label} value={candidate} onChange={(event) => setCandidate(event.target.value)}><option value="">미정</option><option value="__none__">없음</option><option value="__custom__" disabled>직접 입력</option>{sorted.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select><button type="button" onClick={() => { if (candidate && candidate !== "__none__") { onChange([...values, candidate]); setCandidate(""); } else if (candidate === "__none__") { onChange([]); setCandidate(""); } }}>추가</button></div><div className="relation-chips">{values.map((id) => <button type="button" key={id} onClick={() => onChange(values.filter((value) => value !== id))}>{options.find((item) => item.id === id)?.title ?? "삭제된 인물"} ×</button>)}</div></div>;
}

export function PersonProfilePanel({ project, article, editMode, onChange, onProjectChange, onOpenArticle }: { project: WorldProject; article: WikiArticle; editMode: boolean; onChange: (profile: PersonProfile) => void; onProjectChange?: (project: WorldProject) => void; onOpenArticle?: (id: string) => void }) {
  const options = personArticles(project).filter((item) => item.id !== article.id);
  const families = systemArticles(project, "family");
  const countries = systemArticles(project, "country");
  const organizations = systemArticles(project, "organization");
  const factions = systemArticles(project, "faction");
  const religions = systemArticles(project, "religion");
  const languages = [...systemArticles(project, "language"), ...systemArticles(project, "dialect")];
  const ideologies = systemArticles(project, "ideology");
  const affiliations = [...organizations, ...factions];
  const profile: PersonProfile = article.personProfile ?? { organizationArticleIds: [], factionArticleIds: [], spouseArticleIds: [], childArticleIds: [], notes: "" };
  const nationalityArticleIds = profile.nationalityArticleIds ?? (profile.countryArticleId ? [profile.countryArticleId] : []);
  const affiliationArticleIds = profile.affiliationArticleIds ?? [...new Set([profile.primaryAffiliationArticleId, ...profile.organizationArticleIds, ...profile.factionArticleIds].filter((id): id is string => Boolean(id)))];
  const religionArticleIds = profile.religionArticleIds ?? (profile.religionArticleId ? [profile.religionArticleId] : []);
  const languageArticleIds = profile.languageArticleIds ?? [];
  const ideologyArticleIds = profile.ideologyArticleIds ?? [];
  const assignedFamily = familyForPerson(project, profile);
  const lineageMembers = assignedFamily?.familyProfile
    ? familyLineageForPerson(assignedFamily.familyProfile, article.id)
    : normalizeFamilyMembers(profile.privateLineage?.members ?? []);
  const hasFamilyRelationships = lineageMembers.length > 1;
  const update = (patch: Partial<PersonProfile>) => onChange({ ...profile, ...patch });
  const updatePrivateMembers = (members: FamilyTreeMember[]) => update({ privateLineage: { members: normalizeFamilyMembers(members) } });
  const assignFamily = (familyArticleId?: string) => {
    if (familyArticleId && familyArticleId !== profile.familyArticleId && hasPrivateLineage(profile)
      && !window.confirm("가문을 배정하면 이 인물의 개인 가계도는 삭제됩니다. 계속할까요?")) return;
    if (onProjectChange) onProjectChange(assignPersonFamilyInProject(project, article.id, familyArticleId));
    else onChange({ ...profile, familyArticleId, ...(familyArticleId ? { privateLineage: undefined, fatherArticleId: undefined, motherArticleId: undefined, spouseArticleIds: [], childArticleIds: [] } : {}) });
  };
  const linkedValues = (ids: string[]) => ids.length ? <p>{ids.map((id, index) => <span key={id}>{index > 0 && ", "}<button type="button" className="wiki-inline-button" onClick={() => onOpenArticle?.(id)}>{articleTitle(project, id)}</button></span>)}</p> : <span>-</span>;
  return <>
    <StructuredInfoPanel title="인물 정보" className="person-profile-panel">
      <StructuredInfoRow label="출생 연도">{editMode ? <ActiveYearInput project={project} value={profile.birthYear} onChange={(birthYear) => update({ birthYear })} /> : <strong>{yearLabel(project, profile.birthYear)}</strong>}</StructuredInfoRow>
      <StructuredInfoRow label="사망 연도">{editMode ? <ActiveYearInput project={project} value={profile.deathYear} placeholder="미지정" onChange={(deathYear) => update({ deathYear })} /> : <span>{profile.deathYear === undefined ? "-" : yearLabel(project, profile.deathYear)}</span>}</StructuredInfoRow>
      <StructuredInfoRow label="국적">{editMode ? <RelationPicker label="국적" values={nationalityArticleIds} options={countries} onChange={(values) => update({ nationalityArticleIds: values, countryArticleId: values[0] })} /> : linkedValues(nationalityArticleIds)}</StructuredInfoRow>
      <StructuredInfoRow label="소속">{editMode ? <RelationPicker label="소속" values={affiliationArticleIds} options={affiliations} onChange={(values) => { const organizationIds = new Set(organizations.map((item) => item.id)); const factionIds = new Set(factions.map((item) => item.id)); update({ affiliationArticleIds: values, primaryAffiliationArticleId: values.includes(profile.primaryAffiliationArticleId ?? "") ? profile.primaryAffiliationArticleId : values[0], organizationArticleIds: values.filter((id) => organizationIds.has(id)), factionArticleIds: values.filter((id) => factionIds.has(id)) }); }} /> : linkedValues(affiliationArticleIds)}</StructuredInfoRow>
      <StructuredInfoRow label="종교">{editMode ? <RelationPicker label="종교" values={religionArticleIds} options={religions} onChange={(values) => update({ religionArticleIds: values, religionArticleId: values[0] })} /> : linkedValues(religionArticleIds)}</StructuredInfoRow>
      <StructuredInfoRow label="언어">{editMode ? <RelationPicker label="언어" values={languageArticleIds} options={languages} onChange={(values) => update({ languageArticleIds: values })} /> : linkedValues(languageArticleIds)}</StructuredInfoRow>
      <StructuredInfoRow label="사상">{editMode ? <RelationPicker label="사상" values={ideologyArticleIds} options={ideologies} onChange={(values) => update({ ideologyArticleIds: values })} /> : linkedValues(ideologyArticleIds)}</StructuredInfoRow>
    </StructuredInfoPanel>
    {(editMode || hasFamilyRelationships) && <section className="structured-wiki-panel person-genealogy-panel">
      <div className="section-heading-row"><div><h3>{assignedFamily ? `${assignedFamily.title} 직계 가계도` : "개인 가계도"}</h3><small>{assignedFamily ? "가문 문서에서 편집되는 읽기 전용 가계도" : "가문이 없을 때만 이 문서에서 편집할 수 있습니다."}</small></div>{editMode && <div className="family-tree-actions"><select aria-label="가문 배정" value={profile.familyArticleId ?? ""} onChange={(event) => assignFamily(event.target.value || undefined)}><option value="">미지정 · 개인 가계도</option>{families.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select>{!assignedFamily && lineageMembers.length === 0 && <button type="button" onClick={() => updatePrivateMembers([{ id: createId("private-family-member"), articleId: article.id, name: article.title, birthYear: profile.birthYear, deathYear: profile.deathYear, parentIds: [], partnerIds: [], important: true, summary: "" }])}>＋ 개인 가계도 생성</button>}</div>}</div>
      {lineageMembers.length > 0 ? <EditableLineageTree project={project} members={lineageMembers} people={[article, ...options]} focusArticleId={article.id} editMode={editMode && !assignedFamily} onChange={updatePrivateMembers} onOpenArticle={onOpenArticle} /> : <p className="empty-hint">표시할 가족 관계가 없습니다.</p>}
    </section>}
  </>;
}

function LineageRelationSelect({ label, member, members, relation, onChange }: { label: string; member: FamilyTreeMember; members: FamilyTreeMember[]; relation: "parentIds" | "partnerIds"; onChange: (ids: string[]) => void }) {
  return <label className="genealogy-relation-editor"><span>{label}</span><select multiple value={member[relation]} onChange={(event) => onChange([...event.currentTarget.selectedOptions].map((option) => option.value))}>{members.filter((candidate) => candidate.id !== member.id).map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name || candidate.articleId || "미지정"}</option>)}</select></label>;
}

function EditableLineageTree({ project, members, people, focusArticleId, editMode, onChange, onOpenArticle }: { project: WorldProject; members: FamilyTreeMember[]; people: WikiArticle[]; focusArticleId?: string; editMode: boolean; onChange: (members: FamilyTreeMember[]) => void; onOpenArticle?: (id: string) => void }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const normalized = useMemo(() => normalizeFamilyMembers(members), [members]);
  const children = useMemo(() => { const map = new Map<string, FamilyTreeMember[]>(); for (const member of normalized) for (const parentId of member.parentIds) map.set(parentId, [...(map.get(parentId) ?? []), member]); return map; }, [normalized]);
  const membersById = useMemo(() => new Map(normalized.map((member) => [member.id, member])), [normalized]);
  const visibleIds = useMemo(() => new Set(normalized.map((member) => member.id)), [normalized]);
  const roots = normalized.filter((member) => !member.parentIds.some((parentId) => visibleIds.has(parentId)));
  const commit = (next: FamilyTreeMember[]) => onChange(normalizeFamilyMembers(next));
  const addChild = (parentId: string) => commit([...normalized, { id: createId("family-member"), name: "미지정", parentIds: [parentId], partnerIds: [], important: false, summary: "" }]);
  const replace = (memberId: string, articleId?: string) => commit(normalized.map((member) => member.id === memberId ? { ...member, articleId, name: articleId ? articleTitle(project, articleId) : "미지정" } : member));
  const remove = (memberId: string) => commit(normalized.filter((item) => item.id !== memberId).map((item) => ({ ...item, parentIds: item.parentIds.filter((id) => id !== memberId), partnerIds: item.partnerIds.filter((id) => id !== memberId) })));
  return <>
    <div className="family-tree-canvas">{roots.length > 0 ? <ul className="family-tree-root">{roots.map((member) => <FamilyNode key={member.id} project={project} member={member} children={children} membersById={membersById} people={people} visibleIds={visibleIds} collapsed={editMode ? new Set<string>() : collapsed} focusArticleId={focusArticleId} editMode={editMode} onToggle={(id) => setCollapsed((previous) => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; })} onAddChild={addChild} onReplace={replace} onDelete={remove} onOpenArticle={onOpenArticle} />)}</ul> : <p className="empty-hint">가계도 구성원이 없습니다.</p>}</div>
    {editMode && <div className="family-member-editor-list">{normalized.map((member) => <div className="family-member-edit-row genealogy-integrity-row" key={member.id}><input aria-label="표시 이름" value={member.name} onChange={(event) => commit(normalized.map((item) => item.id === member.id ? { ...item, name: event.target.value } : item))} /><LineageRelationSelect label="부모" member={member} members={normalized} relation="parentIds" onChange={(parentIds) => commit(normalized.map((item) => item.id === member.id ? { ...item, parentIds } : item))} /><LineageRelationSelect label="배우자/동반자" member={member} members={normalized} relation="partnerIds" onChange={(partnerIds) => commit(normalized.map((item) => item.id === member.id ? { ...item, partnerIds } : item))} /><button type="button" className="danger-ghost" disabled={member.articleId === focusArticleId} onClick={() => remove(member.id)}>삭제</button></div>)}</div>}
  </>;
}

function FamilyNode({ project, member, children, membersById, people, visibleIds, collapsed, focusArticleId, editMode, onToggle, onAddChild, onReplace, onDelete, onOpenArticle }: { project: WorldProject; member: FamilyTreeMember; children: Map<string, FamilyTreeMember[]>; membersById: Map<string, FamilyTreeMember>; people: WikiArticle[]; visibleIds: Set<string>; collapsed: Set<string>; focusArticleId?: string; editMode: boolean; onToggle: (id: string) => void; onAddChild: (parentId: string) => void; onReplace: (memberId: string, articleId?: string) => void; onDelete: (memberId: string) => void; onOpenArticle?: (id: string) => void }) {
  const childMembers = (children.get(member.id) ?? []).filter((item) => visibleIds.has(item.id));
  const isCollapsed = collapsed.has(member.id);
  const linked = member.articleId ? people.find((person) => person.id === member.articleId) : undefined;
  const birth = linked?.personProfile?.birthYear ?? member.birthYear;
  const death = linked?.personProfile?.deathYear ?? member.deathYear;
  const partnerNames = member.partnerIds.map((id) => { const partnerMember = membersById.get(id); return partnerMember?.articleId ? people.find((person) => person.id === partnerMember.articleId)?.title ?? partnerMember.name : partnerMember?.name ?? ""; }).filter(Boolean);
  return <li className={`family-tree-node ${isCollapsed ? "collapsed" : ""}`}><div className={`family-tree-card ${member.important ? "important" : ""} ${member.articleId === focusArticleId ? "focus" : ""}`}>{childMembers.length > 0 && <button type="button" className="branch-toggle" disabled={editMode} onClick={() => onToggle(member.id)}>{isCollapsed ? "+" : "−"}</button>}{linked && onOpenArticle ? <button type="button" className="genealogy-link-button" onClick={() => onOpenArticle(linked.id)}><strong>{linked.title}</strong></button> : <strong>{(linked?.title ?? member.name) || (editMode ? "미지정" : "?")}</strong>}<span>{linked || editMode ? lifeSpan(project, birth, death) : "?"}</span>{partnerNames.length > 0 && <small>배우자/동반자 · {partnerNames.join(", ")}</small>}{member.summary && <small>{member.summary}</small>}{editMode && <><select className="tree-slot-picker" value={member.articleId ?? ""} onChange={(event) => onReplace(member.id, event.target.value || undefined)}><option value="">미지정</option>{people.map((person) => <option key={person.id} value={person.id}>{person.title}</option>)}</select><button type="button" className="tree-add-child" onClick={() => onAddChild(member.id)}>＋</button><button type="button" className="danger-ghost family-node-delete" title="칸 삭제" disabled={member.articleId === focusArticleId} onClick={() => onDelete(member.id)}>−</button></>}</div>{!isCollapsed && childMembers.length > 0 && <ul>{childMembers.map((child) => <FamilyNode key={child.id} project={project} member={child} children={children} membersById={membersById} people={people} visibleIds={visibleIds} collapsed={editMode ? new Set<string>() : collapsed} focusArticleId={focusArticleId} editMode={editMode} onToggle={onToggle} onAddChild={onAddChild} onReplace={onReplace} onDelete={onDelete} onOpenArticle={onOpenArticle} />)}</ul>}</li>;
}

export function FamilyProfilePanel({ project, article, editMode, onChange, onProjectAndProfileChange, onOpenArticle }: { project: WorldProject; article: WikiArticle; editMode: boolean; onChange: (profile: FamilyProfile) => void; onProjectChange?: (project: WorldProject) => void; onProjectAndProfileChange?: (project: WorldProject, profile: FamilyProfile) => void; onOpenArticle?: (id: string) => void }) {
  const profile: FamilyProfile = { ...(article.familyProfile ?? { displayMode: "all", members: [], displayFlag: false, displayCoatOfArms: false }), members: normalizeFamilyMembers(article.familyProfile?.members ?? []) };
  const people = personArticles(project);
  const commit = (candidate: FamilyProfile) => {
    const next = { ...candidate, members: normalizeFamilyMembers(candidate.members) };
    const before = new Set(profile.members.flatMap((member) => member.articleId ? [member.articleId] : []));
    const added = next.members.flatMap((member) => member.articleId && !before.has(member.articleId) ? [member.articleId] : []);
    const destructive = added.map((id) => project.wikiArticles.find((item) => item.id === id)?.personProfile).filter((person): person is PersonProfile => Boolean(person)).some((person) => hasPrivateLineage(person) || Boolean(person.familyArticleId && person.familyArticleId !== article.id));
    if (destructive && !window.confirm("선택한 인물을 이 가문으로 옮기면 기존 개인 가계도 또는 다른 가문 배정이 해제됩니다. 계속할까요?")) return;
    const nextProject = synchronizeFamilyProfileInProject(project, article.id, next);
    if (onProjectAndProfileChange) onProjectAndProfileChange(nextProject, next);
    else onChange(next);
  };
  const shownMembers = useMemo(() => {
    if (profile.displayMode === "all") return profile.members;
    const byId = new Map(profile.members.map((member) => [member.id, member]));
    const visible = new Set(profile.members.filter((member) => member.important).map((member) => member.id));
    const pending = [...visible];
    while (pending.length > 0) {
      const member = byId.get(pending.pop()!);
      for (const id of [...(member?.parentIds ?? []), ...(member?.partnerIds ?? [])]) {
        if (!visible.has(id)) { visible.add(id); pending.push(id); }
      }
    }
    return profile.members.filter((member) => visible.has(member.id));
  }, [profile.displayMode, profile.members]);
  return <>
  <StructuredInfoPanel title="가문 정보" className="family-information-panel">
    <StructuredInfoRow label="형성 시기">{editMode ? <input value={profile.formationPeriod ?? ""} onChange={(event) => commit({ ...profile, formationPeriod: event.target.value })} /> : <span>{profile.formationPeriod || "-"}</span>}</StructuredInfoRow>
    <StructuredInfoRow label="몰락/해체 시기">{editMode ? <input value={profile.dissolutionPeriod ?? ""} onChange={(event) => commit({ ...profile, dissolutionPeriod: event.target.value })} /> : <span>{profile.dissolutionPeriod || "-"}</span>}</StructuredInfoRow>
  </StructuredInfoPanel>
  <section className="structured-wiki-panel family-profile-panel">
    <div className="section-heading-row"><div><h3>{article.title} 가계도</h3><small>가문 구성원의 가족 관계를 관리하는 단일 원본</small></div>{editMode && <div className="family-tree-actions"><select value={profile.displayMode} onChange={(event) => commit({ ...profile, displayMode: event.target.value as FamilyProfile["displayMode"] })}><option value="all">전체 가계도</option><option value="key">주요 인물 중심</option></select><button type="button" onClick={() => commit({ ...profile, members: [...profile.members, { id: createId("family-member"), name: "미지정", parentIds: [], partnerIds: [], important: true, summary: "" }] })}>＋ 시조 슬롯</button></div>}</div>
    {!editMode && <HeraldryDisplay project={project} showFlag={profile.displayFlag} showCoat={profile.displayCoatOfArms} flagAssetId={profile.flagAssetId} coatAssetId={profile.coatOfArmsAssetId} />}
    {editMode && <HeraldryEditorFields project={project} displayFlag={profile.displayFlag} displayCoat={profile.displayCoatOfArms} flagAssetId={profile.flagAssetId} coatAssetId={profile.coatOfArmsAssetId} onChange={(patch) => commit({ ...profile, ...(Object.prototype.hasOwnProperty.call(patch, "displayFlag") ? { displayFlag: patch.displayFlag } : {}), ...(Object.prototype.hasOwnProperty.call(patch, "displayCoatOfArms") ? { displayCoatOfArms: patch.displayCoatOfArms } : {}), ...(Object.prototype.hasOwnProperty.call(patch, "flagAssetId") ? { flagAssetId: patch.flagAssetId } : {}), ...(Object.prototype.hasOwnProperty.call(patch, "coatOfArmsAssetId") ? { coatOfArmsAssetId: patch.coatOfArmsAssetId } : {}) })} />}
    <EditableLineageTree project={project} members={editMode ? profile.members : shownMembers} people={people} editMode={editMode} onChange={(members) => commit({ ...profile, members })} onOpenArticle={onOpenArticle} />
  </section></>;
}

function ownerOptions(project: WorldProject): Array<{ id: string; type: OwnershipTargetType; label: string }> {
  const result: Array<{ id: string; type: OwnershipTargetType; label: string }> = [];
  for (const article of systemArticles(project, "person")) result.push({ id: article.id, type: "person", label: `인물 · ${article.title}` });
  for (const article of systemArticles(project, "family")) result.push({ id: article.id, type: "family", label: `가문 · ${article.title}` });
  for (const map of project.maps) for (const faction of map.factions) result.push({ id: faction.id, type: faction.kind, label: `${faction.kind === "country" ? "국가" : faction.kind === "organization" ? "단체" : "세력"} · ${faction.name}` });
  return result;
}
function ownerLabel(project: WorldProject, period: ItemOwnershipPeriod): string { const label = ownerOptions(project).find((item) => item.id === period.ownerId && item.type === period.ownerType)?.label ?? "삭제된 소유자"; return label.includes(" · ") ? label.split(" · ").slice(1).join(" · ") : label; }
function ownershipOverlapIds(periods: ItemOwnershipPeriod[]): Set<string> {
  const invalid = new Set(periods.filter((period) => !period.ownerId || (period.endYear !== null && period.endYear < period.startYear)).map((period) => period.id));
  const ordered = [...periods].sort((left, right) => left.startYear - right.startYear);
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (previous.endYear === null || previous.endYear >= current.startYear) {
      invalid.add(previous.id);
      invalid.add(current.id);
    }
  }
  return invalid;
}
export function ItemProfilePanel({ project, article, editMode, onChange }: { project: WorldProject; article: WikiArticle; editMode: boolean; onChange: (profile: NonNullable<WikiArticle["itemProfile"]>) => void }) {
  const profile: NonNullable<WikiArticle["itemProfile"]> = article.itemProfile ?? {
    subtype: "item", itemType: "", origin: "", purpose: "", productionPeriod: "", lifecycleStatus: "active",
    isUnique: false, condition: "", ownershipHistory: [],
  };
  const options = ownerOptions(project);
  const [readOwnershipOpen, setReadOwnershipOpen] = useState(true);
  const [editOwnershipOpen, setEditOwnershipOpen] = useState(true);
  const ownershipOpen = editMode ? editOwnershipOpen : readOwnershipOpen;
  const setOwnershipOpen = editMode ? setEditOwnershipOpen : setReadOwnershipOpen;
  const updatePeriod = (id: string, patch: Partial<ItemOwnershipPeriod>) => onChange({ ...profile, ownershipHistory: profile.ownershipHistory.map((period) => period.id === id ? { ...period, ...patch } : period) });
  const ordered = profile.ownershipHistory;
  const invalidOwnershipIds = ownershipOverlapIds(ordered);
  const movePeriod = (index: number, offset: -1 | 1) => {
    const destination = index + offset;
    if (destination < 0 || destination >= ordered.length) return;
    const next = [...ordered];
    [next[index], next[destination]] = [next[destination], next[index]];
    onChange({ ...profile, ownershipHistory: next });
  };
  return <>
    <StructuredInfoPanel title="물건 정보" className="item-profile-panel">
      <StructuredInfoRow label="종류">{editMode ? <input value={profile.itemType} onChange={(event) => onChange({ ...profile, itemType: event.target.value })} /> : <strong>{profile.itemType || "미정"}</strong>}</StructuredInfoRow>
      <StructuredInfoRow label="기원">{editMode ? <input value={profile.origin} onChange={(event) => onChange({ ...profile, origin: event.target.value })} /> : <strong>{profile.origin || "미정"}</strong>}</StructuredInfoRow>
      <StructuredInfoRow label="용도">{editMode ? <input value={profile.purpose} onChange={(event) => onChange({ ...profile, purpose: event.target.value })} /> : <strong>{profile.purpose || "미정"}</strong>}</StructuredInfoRow>
      <StructuredInfoRow label="제작 시기">{editMode ? <input value={profile.productionPeriod ?? ""} onChange={(event) => onChange({ ...profile, productionPeriod: event.target.value })} /> : <strong>{profile.productionPeriod || "미정"}</strong>}</StructuredInfoRow>
      <StructuredInfoRow label="현재 상태">{editMode ? <select value={profile.lifecycleStatus} onChange={(event) => onChange({ ...profile, lifecycleStatus: event.target.value as typeof profile.lifecycleStatus })}><option value="active">현역</option><option value="retired">퇴역</option></select> : <strong>{profile.lifecycleStatus === "retired" ? "퇴역" : "현역"}</strong>}</StructuredInfoRow>
      <StructuredInfoRow label="고유 여부">{editMode ? <label className="checkbox-row"><input type="checkbox" checked={profile.isUnique} onChange={(event) => onChange({ ...profile, isUnique: event.target.checked })} /> 고유 물품</label> : <strong>{profile.isUnique ? "O" : "X"}</strong>}</StructuredInfoRow>
    </StructuredInfoPanel>
    {profile.isUnique && <section className="structured-wiki-panel ownership-profile-panel"><div className="ownership-section-heading"><h4>소유권 기록</h4><button type="button" className="secondary-button" aria-expanded={ownershipOpen} onClick={() => setOwnershipOpen(!ownershipOpen)}>{ownershipOpen ? "접기" : "펼치기"}</button></div>
    {ownershipOpen && <>
      <div className="ownership-timeline">{ordered.map((period) => <div className="ownership-node" key={period.id}><span className="ownership-dot" /><strong>{ownerLabel(project, period)}</strong><time>{yearLabel(project, period.startYear)}–{period.endYear === null ? "현재" : yearLabel(project, period.endYear)}</time>{period.note && <small>{period.note}</small>}</div>)}{ordered.length === 0 && <p className="empty-hint">소유권 기록이 없습니다.</p>}</div>
      {editMode && <div className="ownership-editor"><button type="button" onClick={() => onChange({ ...profile, ownershipHistory: [...profile.ownershipHistory, { id: createId("ownership"), ownerType: "person", ownerId: options.find((item) => item.type === "person")?.id ?? "", startYear: 0, endYear: null, note: "" }] })}>＋ 소유권 기록</button>{ordered.map((period, index) => <div className={`ownership-edit-row ${invalidOwnershipIds.has(period.id) ? "invalid" : ""}`} key={period.id}><select value={`${period.ownerType}:${period.ownerId}`} onChange={(event) => { const [ownerType, ...rest] = event.target.value.split(":"); updatePeriod(period.id, { ownerType: ownerType as OwnershipTargetType, ownerId: rest.join(":") }); }}>{options.map((item) => <option key={`${item.type}:${item.id}`} value={`${item.type}:${item.id}`}>{item.label}</option>)}</select><ActiveYearInput project={project} value={period.startYear} onChange={(startYear) => updatePeriod(period.id, { startYear: startYear ?? 0 })} /><ActiveYearInput project={project} value={period.endYear} placeholder="종료" onChange={(endYear) => updatePeriod(period.id, { endYear: endYear ?? null })} /><input placeholder="비고" value={period.note} onChange={(event) => updatePeriod(period.id, { note: event.target.value })} /><button type="button" disabled={index === 0} onClick={() => movePeriod(index, -1)}>↑</button><button type="button" disabled={index + 1 === ordered.length} onClick={() => movePeriod(index, 1)}>↓</button><button type="button" className="danger-ghost" onClick={() => onChange({ ...profile, ownershipHistory: profile.ownershipHistory.filter((item) => item.id !== period.id) })}>삭제</button>{invalidOwnershipIds.has(period.id) && <small className="field-error">기간이 역전되었거나 다른 소유권 기록과 겹칩니다.</small>}</div>)}</div>}
    </>}</section>}
  </>;
}

function ReligionTextList({ values, editMode, onChange }: { values: string[]; editMode: boolean; onChange: (values: string[]) => void }) {
  if (!editMode) return <span>{values.length > 0 ? values.join(", ") : "-"}</span>;
  return <div className="religion-text-list">
    {values.map((value, index) => <div className="religion-text-list-row" key={`${index}-${value}`}>
      <input value={value} onChange={(event) => onChange(values.map((entry, candidate) => candidate === index ? event.target.value : entry))} />
      <button type="button" className="icon-button danger-ghost" aria-label="삭제" title="삭제" onClick={() => onChange(values.filter((_, candidate) => candidate !== index))}>×</button>
    </div>)}
    <button type="button" className="secondary-button" onClick={() => onChange([...values, ""])}>＋ 항목</button>
  </div>;
}

const emptyReligionProfile = (): ReligionProfile => ({
  traditionLineage: "", founder: "", foundingPeriod: "", holyCity: "",
  distributionRegions: [], adherentPopulation: "", religiousInstitutions: [],
  scriptures: [], majorDenominations: [], doctrineSections: [],
});

export function ReligionProfilePanel({ project: _project, article, editMode, onChange }: { project: WorldProject; article: WikiArticle; editMode: boolean; onChange: (profile: ReligionProfile) => void }) {
  const profile = article.religionProfile ?? emptyReligionProfile();
  const update = (patch: Partial<ReligionProfile>) => onChange({ ...profile, ...patch });
  return <>
    <StructuredInfoPanel title="종교 정보" className="religion-profile-panel">
      <StructuredInfoRow label="계통">{editMode ? <input value={profile.traditionLineage} onChange={(event) => update({ traditionLineage: event.target.value })} /> : <span>{profile.traditionLineage || "-"}</span>}</StructuredInfoRow>
      <StructuredInfoRow label="창시자">{editMode ? <input value={profile.founder} onChange={(event) => update({ founder: event.target.value })} /> : <span>{profile.founder || "-"}</span>}</StructuredInfoRow>
      <StructuredInfoRow label="창시 시기">{editMode ? <input value={profile.foundingPeriod} onChange={(event) => update({ foundingPeriod: event.target.value })} /> : <span>{profile.foundingPeriod || "-"}</span>}</StructuredInfoRow>
      <StructuredInfoRow label="성도">{editMode ? <input value={profile.holyCity} onChange={(event) => update({ holyCity: event.target.value })} /> : <span>{profile.holyCity || "-"}</span>}</StructuredInfoRow>
      <StructuredInfoRow label="분포 지역"><ReligionTextList values={profile.distributionRegions} editMode={editMode} onChange={(distributionRegions) => update({ distributionRegions })} /></StructuredInfoRow>
      <StructuredInfoRow label="신도 규모">{editMode ? <input value={profile.adherentPopulation} onChange={(event) => update({ adherentPopulation: event.target.value })} /> : <span>{profile.adherentPopulation || "-"}</span>}</StructuredInfoRow>
      <StructuredInfoRow label="종교 기관"><ReligionTextList values={profile.religiousInstitutions} editMode={editMode} onChange={(religiousInstitutions) => update({ religiousInstitutions })} /></StructuredInfoRow>
      <StructuredInfoRow label="경전"><ReligionTextList values={profile.scriptures} editMode={editMode} onChange={(scriptures) => update({ scriptures })} /></StructuredInfoRow>
      <StructuredInfoRow label="주요 종파"><ReligionTextList values={profile.majorDenominations} editMode={editMode} onChange={(majorDenominations) => update({ majorDenominations })} /></StructuredInfoRow>
    </StructuredInfoPanel>
    <NestedProfileSections title="교리" sections={profile.doctrineSections} editMode={editMode} onChange={(doctrineSections) => update({ doctrineSections })} />
  </>;
}


export function GovernmentProfilePanel({ article, editMode, onChange }: { article: WikiArticle; editMode: boolean; onChange: (profile: GovernmentProfile) => void }) {
  const profile = article.governmentProfile ?? { countryNameSuffix: "" };
  return <StructuredInfoPanel title="체제 정보" className="government-profile-panel">
    <StructuredInfoRow label="국명 접미 명칭">{editMode ? <div><input value={profile.countryNameSuffix} placeholder="예: 왕국, 공화국, 제국" onChange={(event) => onChange({ countryNameSuffix: event.target.value.trimStart() })} /><small>국가 고유명 뒤에 자동으로 붙습니다.</small></div> : <strong>{profile.countryNameSuffix || "미설정"}</strong>}</StructuredInfoRow>
  </StructuredInfoPanel>;
}
