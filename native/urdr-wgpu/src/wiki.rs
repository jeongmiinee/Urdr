use crate::model::Article;

const MAX_REDIRECT_DEPTH: usize = 16;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WikiLink<'a> {
    pub target: &'a str,
    pub label: &'a str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResolveResult {
    Found(String),
    Broken,
    Ambiguous,
    Cycle,
}

pub fn parse_link(value: &str) -> WikiLink<'_> {
    let mut parts = value.splitn(2, '|');
    let target = parts.next().unwrap_or_default().trim();
    let label = parts
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(target);
    WikiLink { target, label }
}

pub fn normalize_key(value: &str) -> String {
    value
        .trim()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

pub fn resolve(articles: &[Article], target: &str) -> ResolveResult {
    let key = normalize_key(target);
    if key.is_empty() {
        return ResolveResult::Broken;
    }
    let mut matches = articles
        .iter()
        .filter(|article| {
            normalize_key(&article.id) == key
                || normalize_key(&article.title) == key
                || article
                    .wiki_aliases
                    .iter()
                    .any(|alias| normalize_key(alias) == key)
        })
        .map(|article| article.id.clone())
        .collect::<Vec<_>>();
    matches.sort();
    matches.dedup();
    if matches.len() > 1 {
        return ResolveResult::Ambiguous;
    }
    let Some(mut id) = matches.pop() else {
        return ResolveResult::Broken;
    };
    let mut visited = Vec::new();
    for _ in 0..MAX_REDIRECT_DEPTH {
        if visited.contains(&id) {
            return ResolveResult::Cycle;
        }
        visited.push(id.clone());
        let Some(article) = articles.iter().find(|article| article.id == id) else {
            return ResolveResult::Broken;
        };
        let Some(next) = article
            .redirect_target_article_id
            .as_ref()
            .filter(|next| !next.trim().is_empty())
        else {
            return ResolveResult::Found(id);
        };
        if next == &id {
            return ResolveResult::Cycle;
        }
        id = next.clone();
    }
    ResolveResult::Cycle
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::ArticleProfiles;

    fn article(id: &str, title: &str) -> Article {
        Article {
            id: id.to_owned(),
            title: title.to_owned(),
            wiki_aliases: Vec::new(),
            redirect_target_article_id: None,
            category: "other".to_owned(),
            category_id: None,
            summary: String::new(),
            content: String::new(),
            calendar_profile: None,
            document_sections: Vec::new(),
            tags: Vec::new(),
            linked_map_entity_ids: Vec::new(),
            source_map_id: None,
            source_entity_id: None,
            profiles: ArticleProfiles::default(),
        }
    }

    #[test]
    fn parses_optional_display_label() {
        assert_eq!(
            parse_link(" target | label "),
            WikiLink {
                target: "target",
                label: "label"
            }
        );
        assert_eq!(
            parse_link("target"),
            WikiLink {
                target: "target",
                label: "target"
            }
        );
    }

    #[test]
    fn resolves_aliases_and_redirect_chains_by_stable_id() {
        let target = article("target-id", "대상 문서");
        let mut redirect = article("redirect-id", "옛 문서");
        redirect.wiki_aliases.push("Legacy Name".to_owned());
        redirect.redirect_target_article_id = Some(target.id.clone());
        assert_eq!(
            resolve(&[target, redirect], " legacy   name "),
            ResolveResult::Found("target-id".to_owned())
        );
    }

    #[test]
    fn rejects_ambiguous_and_cyclic_links() {
        let mut left = article("left", "같은 이름");
        let mut right = article("right", "같은 이름");
        assert_eq!(
            resolve(&[left.clone(), right.clone()], "같은 이름"),
            ResolveResult::Ambiguous
        );
        left.redirect_target_article_id = Some("right".to_owned());
        right.redirect_target_article_id = Some("left".to_owned());
        assert_eq!(resolve(&[left, right], "left"), ResolveResult::Cycle);
    }
}
