import type {
  FamilyProfile,
  FamilyTreeMember,
  PersonProfile,
  PrivateLineageProfile,
  WikiArticle,
  WorldProject,
} from "./world";

function uniqueIds(values: string[], allowed: Set<string>, selfId: string): string[] {
  return [...new Set(values)].filter((id) => id !== selfId && allowed.has(id));
}

function wouldCreateParentCycle(
  childId: string,
  parentId: string,
  parentsById: Map<string, string[]>,
): boolean {
  const pending = [parentId];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === childId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    pending.push(...(parentsById.get(current) ?? []));
  }
  return false;
}

/** Cleans dangling links, prevents ancestry cycles, and makes partner links reciprocal. */
export function normalizeFamilyMembers(members: FamilyTreeMember[]): FamilyTreeMember[] {
  const copied = members.map((member) => ({
    ...member,
    parentIds: [...member.parentIds],
    partnerIds: [...member.partnerIds],
  }));
  const allowed = new Set(copied.map((member) => member.id));
  const parentsById = new Map<string, string[]>();
  for (const member of copied) {
    const candidates = uniqueIds(member.parentIds, allowed, member.id);
    const accepted: string[] = [];
    parentsById.set(member.id, accepted);
    for (const parentId of candidates) {
      if (!wouldCreateParentCycle(member.id, parentId, parentsById)) accepted.push(parentId);
    }
    member.parentIds = accepted;
  }
  const partnerMap = new Map(copied.map((member) => [member.id, new Set(uniqueIds(member.partnerIds, allowed, member.id))]));
  for (const [memberId, partners] of partnerMap) {
    for (const partnerId of partners) partnerMap.get(partnerId)?.add(memberId);
  }
  for (const member of copied) member.partnerIds = [...(partnerMap.get(member.id) ?? [])];
  return copied;
}

export function privateLineageFromLegacy(
  profile: Pick<PersonProfile, "fatherArticleId" | "motherArticleId" | "spouseArticleIds" | "childArticleIds">,
  focusArticleId: string,
  focusName: string,
): PrivateLineageProfile | undefined {
  const parents = [...new Set([profile.fatherArticleId, profile.motherArticleId].filter((id): id is string => Boolean(id)))];
  const spouses = [...new Set(profile.spouseArticleIds ?? [])].filter((id) => id !== focusArticleId);
  const children = [...new Set(profile.childArticleIds ?? [])].filter((id) => id !== focusArticleId);
  if (parents.length + spouses.length + children.length === 0) return undefined;
  const focusId = `private-member-${focusArticleId}`;
  const memberId = (articleId: string) => `private-member-${articleId}`;
  const members: FamilyTreeMember[] = [
    { id: focusId, articleId: focusArticleId, name: focusName, parentIds: parents.map(memberId), partnerIds: spouses.map(memberId), important: true, summary: "" },
    ...parents.map((articleId) => ({ id: memberId(articleId), articleId, name: "", parentIds: [], partnerIds: [], important: false, summary: "" })),
    ...spouses.map((articleId) => ({ id: memberId(articleId), articleId, name: "", parentIds: [], partnerIds: [focusId], important: false, summary: "" })),
    ...children.map((articleId) => ({ id: memberId(articleId), articleId, name: "", parentIds: [focusId], partnerIds: [], important: false, summary: "" })),
  ];
  return { members: normalizeFamilyMembers(members) };
}

export function hasPrivateLineage(profile: PersonProfile): boolean {
  return Boolean(profile.privateLineage?.members.length);
}

export function clearPrivateLineage(profile: PersonProfile): PersonProfile {
  const next = { ...profile, privateLineage: undefined };
  delete next.fatherArticleId;
  delete next.motherArticleId;
  next.spouseArticleIds = [];
  next.childArticleIds = [];
  return next;
}

export function familyContainingPerson(project: WorldProject, personArticleId: string): WikiArticle | undefined {
  return project.wikiArticles.find((article) => article.familyProfile?.members.some((member) => member.articleId === personArticleId));
}

export function familyForPerson(project: WorldProject, profile: PersonProfile): WikiArticle | undefined {
  return profile.familyArticleId
    ? project.wikiArticles.find((article) => article.id === profile.familyArticleId && article.familyProfile)
    : undefined;
}

/** Direct ancestors and descendants are recursive; siblings share at least one direct parent. */
export function familyLineageForPerson(family: FamilyProfile, personArticleId: string): FamilyTreeMember[] {
  const members = normalizeFamilyMembers(family.members);
  const focus = members.find((member) => member.articleId === personArticleId);
  if (!focus) return [];
  const byId = new Map(members.map((member) => [member.id, member]));
  const children = new Map<string, string[]>();
  for (const member of members) {
    for (const parentId of member.parentIds) children.set(parentId, [...(children.get(parentId) ?? []), member.id]);
  }
  const visible = new Set<string>([focus.id]);
  const collect = (initial: string[], next: (id: string) => string[]) => {
    const pending = [...initial];
    while (pending.length > 0) {
      const id = pending.pop()!;
      if (visible.has(id)) continue;
      visible.add(id);
      pending.push(...next(id));
    }
  };
  collect(focus.parentIds, (id) => byId.get(id)?.parentIds ?? []);
  collect(children.get(focus.id) ?? [], (id) => children.get(id) ?? []);
  const focusParents = new Set(focus.parentIds);
  for (const member of members) {
    if (member.id !== focus.id && member.parentIds.some((id) => focusParents.has(id))) visible.add(member.id);
  }
  for (const id of [...visible]) for (const partnerId of byId.get(id)?.partnerIds ?? []) visible.add(partnerId);
  return members.filter((member) => visible.has(member.id));
}

export function assignPersonToFamily(profile: PersonProfile, familyArticleId?: string): PersonProfile {
  return familyArticleId
    ? { ...clearPrivateLineage(profile), familyArticleId }
    : { ...profile, familyArticleId: undefined };
}

function withoutPerson(profile: FamilyProfile, personArticleId: string): FamilyProfile {
  const removed = new Set(profile.members.filter((member) => member.articleId === personArticleId).map((member) => member.id));
  return {
    ...profile,
    members: normalizeFamilyMembers(profile.members
      .filter((member) => !removed.has(member.id))
      .map((member) => ({
        ...member,
        parentIds: member.parentIds.filter((id) => !removed.has(id)),
        partnerIds: member.partnerIds.filter((id) => !removed.has(id)),
      }))),
  };
}

export function assignPersonFamilyInProject(
  project: WorldProject,
  personArticleId: string,
  familyArticleId?: string,
): WorldProject {
  const person = project.wikiArticles.find((article) => article.id === personArticleId && article.personProfile);
  if (!person?.personProfile) return project;
  const now = new Date().toISOString();
  const articles = project.wikiArticles.map((article) => {
    if (!article.familyProfile) return article;
    let familyProfile = withoutPerson(article.familyProfile, personArticleId);
    if (article.id === familyArticleId) {
      familyProfile = {
        ...familyProfile,
        members: normalizeFamilyMembers([...familyProfile.members, {
          id: createStableMemberId(personArticleId, familyProfile.members),
          articleId: personArticleId,
          name: person.title,
          birthYear: person.personProfile?.birthYear,
          deathYear: person.personProfile?.deathYear,
          parentIds: [],
          partnerIds: [],
          important: true,
          summary: "",
        }]),
      };
    }
    return familyProfile === article.familyProfile ? article : { ...article, familyProfile, lastModifiedDate: now };
  });
  return {
    ...project,
    wikiArticles: articles.map((article) => article.id === personArticleId
      ? { ...article, personProfile: assignPersonToFamily(person.personProfile!, familyArticleId), lastModifiedDate: now }
      : article),
    lastModifiedDate: now,
  };
}

function createStableMemberId(personArticleId: string, members: FamilyTreeMember[]): string {
  const base = `family-member-${personArticleId}`;
  if (!members.some((member) => member.id === base)) return base;
  let index = 2;
  while (members.some((member) => member.id === `${base}-${index}`)) index += 1;
  return `${base}-${index}`;
}

/** Applies a Family-document graph and synchronizes every linked Person ownership field. */
export function synchronizeFamilyProfileInProject(
  project: WorldProject,
  familyArticleId: string,
  input: FamilyProfile,
): WorldProject {
  const familyProfile = { ...input, members: normalizeFamilyMembers(input.members) };
  const assignedPersonIds = new Set(familyProfile.members.flatMap((member) => member.articleId ? [member.articleId] : []));
  const now = new Date().toISOString();
  let articles = project.wikiArticles.map((article) => article.id === familyArticleId
    ? { ...article, familyProfile, lastModifiedDate: now }
    : article);
  articles = articles.map((article) => {
    if (!article.personProfile) return article;
    if (assignedPersonIds.has(article.id)) {
      return { ...article, personProfile: assignPersonToFamily(article.personProfile, familyArticleId), lastModifiedDate: now };
    }
    if (article.personProfile.familyArticleId === familyArticleId) {
      return { ...article, personProfile: assignPersonToFamily(article.personProfile, undefined), lastModifiedDate: now };
    }
    return article;
  });
  for (const personId of assignedPersonIds) {
    articles = articles.map((article) => article.id !== familyArticleId && article.familyProfile
      ? { ...article, familyProfile: withoutPerson(article.familyProfile, personId) }
      : article);
  }
  return { ...project, wikiArticles: articles, lastModifiedDate: now };
}
