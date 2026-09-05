import type { WorldProject } from "../model/world";
import type { RpgModifier, RpgTrait } from "./schema";

type FamilyGraph = {
  articleIds: Set<string>;
  parents: Map<string, Set<string>>;
  partners: Map<string, Set<string>>;
};

function graphForFamily(project: WorldProject, familyArticleId: string): FamilyGraph | undefined {
  const family = project.wikiArticles.find((article) => article.id === familyArticleId)?.familyProfile;
  if (!family) return undefined;
  const memberToArticle = new Map(family.members.filter((member) => member.articleId).map((member) => [member.id, member.articleId!]));
  const parents = new Map<string, Set<string>>();
  const partners = new Map<string, Set<string>>();
  for (const member of family.members) {
    const articleId = member.articleId;
    if (!articleId) continue;
    parents.set(articleId, new Set(member.parentIds.map((id) => memberToArticle.get(id)).filter((id): id is string => Boolean(id))));
    partners.set(articleId, new Set(member.partnerIds.map((id) => memberToArticle.get(id)).filter((id): id is string => Boolean(id))));
  }
  return { articleIds: new Set(memberToArticle.values()), parents, partners };
}

function ancestors(graph: FamilyGraph, start: string): Set<string> {
  const result = new Set<string>();
  const queue = [...(graph.parents.get(start) ?? [])];
  while (queue.length) {
    const articleId = queue.shift()!;
    if (result.has(articleId)) continue;
    result.add(articleId);
    queue.push(...(graph.parents.get(articleId) ?? []));
  }
  return result;
}

function descendants(graph: FamilyGraph, start: string): Set<string> {
  const result = new Set<string>();
  const queue = [start];
  while (queue.length) {
    const parent = queue.shift()!;
    for (const [articleId, parentIds] of graph.parents) {
      if (!parentIds.has(parent) || result.has(articleId)) continue;
      result.add(articleId);
      queue.push(articleId);
    }
  }
  result.delete(start);
  return result;
}

function kinshipDistance(graph: FamilyGraph, start: string, target: string, includeSpouses: boolean): number {
  if (start === target) return 0;
  const queue: Array<[string, number]> = [[start, 0]];
  const seen = new Set([start]);
  while (queue.length) {
    const [current, distance] = queue.shift()!;
    const neighbors = new Set<string>([...(graph.parents.get(current) ?? [])]);
    for (const [child, parentIds] of graph.parents) if (parentIds.has(current)) neighbors.add(child);
    if (includeSpouses) for (const partner of graph.partners.get(current) ?? []) neighbors.add(partner);
    for (const next of neighbors) {
      if (next === target) return distance + 1;
      if (!seen.has(next)) { seen.add(next); queue.push([next, distance + 1]); }
    }
  }
  return Number.POSITIVE_INFINITY;
}

export function traitAppliesToPerson(project: WorldProject, trait: RpgTrait, personArticleId: string): boolean {
  if (!trait.familyArticleId) return trait.scope === "selected_members" && trait.selectedArticleIds.includes(personArticleId);
  const graph = graphForFamily(project, trait.familyArticleId);
  if (!graph || !graph.articleIds.has(personArticleId)) return false;
  let applies = false;
  if (trait.scope === "all_members") applies = true;
  else if (trait.scope === "selected_members") applies = trait.selectedArticleIds.includes(personArticleId);
  else if (trait.anchorArticleId) {
    const directLine = new Set([trait.anchorArticleId, ...ancestors(graph, trait.anchorArticleId), ...descendants(graph, trait.anchorArticleId)]);
    if (trait.scope === "lineal") applies = directLine.has(personArticleId);
    else {
      const anchorAncestors = ancestors(graph, trait.anchorArticleId);
      const personAncestors = ancestors(graph, personArticleId);
      applies = !directLine.has(personArticleId) && [...anchorAncestors].some((ancestor) => personAncestors.has(ancestor));
    }
  }
  if (!applies || trait.maximumKinshipDegree === undefined || !trait.anchorArticleId) return applies;
  return kinshipDistance(graph, trait.anchorArticleId, personArticleId, trait.includeSpouses) <= trait.maximumKinshipDegree;
}

export function inheritedFamilyModifiers(project: WorldProject, personArticleId: string): RpgModifier[] {
  const result: RpgModifier[] = [];
  const seen = new Set<string>();
  for (const trait of project.rpgSettings.traits) {
    if (!traitAppliesToPerson(project, trait, personArticleId)) continue;
    for (const modifier of trait.modifiers) {
      const key = `${trait.id}:${modifier.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({
        ...modifier,
        sourceKind: "family",
        sourceArticleId: trait.familyArticleId,
        sourceTraitId: trait.id,
      });
    }
  }
  return result;
}
