use serde_json::Value;

use crate::{
    calendar::{self, TimelineMoment},
    model::{Article, Language, LoadedWorld},
};

#[derive(Clone, Copy)]
pub struct FieldDefinition {
    pub key: &'static str,
    pub korean: &'static str,
    pub english: &'static str,
}

const PERSON: &[FieldDefinition] = &[
    field("birthYear", "출생 연도", "Birth Year"),
    field("deathYear", "사망 연도", "Death Year"),
    field("nationalityArticleIds", "국적", "Nationalities"),
    field("affiliationArticleIds", "소속", "Affiliations"),
    field("religionArticleIds", "종교", "Religions"),
    field("languageArticleIds", "언어", "Languages"),
    field("ideologyArticleIds", "사상", "Ideologies"),
    field("familyArticleId", "소속 가문", "Family"),
];
const WORLD: &[FieldDefinition] = &[
    field("rpgEnabled", "RPG 규칙 여부", "RPG Rules Enabled"),
    field("magicEnabled", "마법 여부", "Magic Exists"),
];
const ITEM: &[FieldDefinition] = &[
    field("itemType", "종류", "Type"),
    field("origin", "기원", "Origin"),
    field("purpose", "용도", "Purpose"),
    field("productionPeriod", "제작 시기", "Production Period"),
    field("lifecycleStatus", "현재 상태", "Status"),
];
const DISEASE: &[FieldDefinition] = &[
    field("aliases", "이명", "Aliases"),
    field("cause", "발병 원인", "Cause"),
    field("incubationPeriod", "잠복 기간", "Incubation"),
    field("relatedDiseaseArticleIds", "관련 질병", "Related Diseases"),
];
const RELIGION: &[FieldDefinition] = &[
    field("traditionLineage", "계통", "Tradition / Lineage"),
    field("founder", "창시자", "Founder"),
    field("foundingPeriod", "창시 시기", "Founding Period"),
    field("holyCity", "성도", "Holy City"),
    field("distributionRegions", "분포 지역", "Distribution Regions"),
    field("adherentPopulation", "신도 규모", "Adherent Population"),
    field(
        "religiousInstitutions",
        "종교 기관",
        "Religious Institutions",
    ),
    field("scriptures", "경전", "Scriptures"),
    field("majorDenominations", "주요 종파", "Major Denominations"),
];
const FAMILY: &[FieldDefinition] = &[
    field("formationPeriod", "형성 시기", "Formation Period"),
    field(
        "dissolutionPeriod",
        "몰락/해체 시기",
        "Fall / Dissolution Period",
    ),
];
const EVENT: &[FieldDefinition] = &[
    field("description", "개요", "Overview"),
    field("location", "위치", "Location"),
    field("period", "기간", "Period"),
    field("cause", "원인", "Cause"),
    field("result", "결과", "Result"),
    field("impact", "영향", "Impact"),
];
const BATTLE: &[FieldDefinition] = &[
    field("description", "개요", "Overview"),
    field("location", "위치", "Location"),
    field("period", "기간", "Period"),
    field("result", "결과", "Result"),
    field("impact", "영향", "Impact"),
];
const CALENDAR: &[FieldDefinition] = &[
    field("calendarName", "역법명", "Calendar Name"),
    field("creator", "제작자", "Creator"),
    field("createdAtYear", "제정 연도", "Created"),
    field("mechanism", "작동 원리", "Mechanism"),
    field("epochWorldYear", "기준 연도", "Epoch"),
    field("displayMode", "연도 표시", "Year Display"),
];
const GOVERNMENT: &[FieldDefinition] = &[
    field("founder", "창시자", "Founder"),
    field("formationPeriod", "형성 시기", "Formation Period"),
    field("pursuedValues", "추구 가치", "Pursued Values"),
];
const MATERIAL: &[FieldDefinition] = &[
    field("classification", "분류", "Classification"),
    field("composition", "구성", "Composition"),
    field("uses", "사용처", "Uses"),
];
const ORGANIZATION: &[FieldDefinition] = &[
    field("foundedYear", "창설 연도", "Founded"),
    field("dissolvedYear", "해산 연도", "Dissolved"),
    field("leaderArticleId", "지도자", "Leader"),
    field("scale", "규모", "Scale"),
    field("headquartersLocationId", "본부", "Headquarters"),
    field("purpose", "목적", "Purpose"),
    field("alignment", "성향", "Alignment"),
    field("ideologyArticleId", "사상", "Ideology"),
];
const COUNTRY: &[FieldDefinition] = &[
    field("foundedYear", "건국 시기", "Founding Period"),
    field("dissolvedYear", "멸망 시기", "Fall Period"),
    field("locationIds", "위치", "Location"),
    field("capitalPeriods", "수도", "Capitals"),
    field("politicalSystemArticleId", "정치 체제", "Political System"),
    field("headOfStateArticleId", "국가원수", "Head of State"),
    field("leaderArticleId", "현 지도자", "Current Leader"),
    field("languageArticleIds", "언어", "Languages"),
    field("religionArticleIds", "종교", "Religions"),
];
const PLACE: &[FieldDefinition] = &[
    field("country", "국가", "Country"),
    field("region", "지역", "Region"),
    field("coordinates", "좌표", "Coordinates"),
];
const CULTURE: &[FieldDefinition] = &[
    field("distributionRegions", "분포 지역", "Distribution Regions"),
    field(
        "relatedLanguageArticleIds",
        "관련 언어",
        "Related Languages",
    ),
    field(
        "relatedReligionArticleIds",
        "관련 종교",
        "Related Religions",
    ),
];
const TECHNOLOGY: &[FieldDefinition] = &[
    field("creator", "제작자", "Creator"),
    field("creationPeriod", "제작 시기", "Creation Period"),
];
const NATURE: &[FieldDefinition] = &[
    field("habitat", "서식지", "Habitat"),
    field("distribution", "분포", "Distribution"),
    field("traits", "특징", "Traits"),
    field("uses", "용도", "Uses"),
    field("risk", "위험도", "Risk"),
];
const MINERAL: &[FieldDefinition] = &[
    field("distributionAreas", "분포지", "Distribution Areas"),
    field("meltingPoint", "녹는점", "Melting Point"),
    field("hardness", "강도", "Hardness / Strength"),
    field("traits", "특징", "Traits"),
    field("uses", "용도", "Uses"),
    field("risk", "위험도", "Risk"),
];
const ROCK: &[FieldDefinition] = &[
    field("distributionAreas", "분포지", "Distribution Areas"),
    field("hardness", "강도", "Hardness / Strength"),
    field("traits", "특징", "Traits"),
    field("uses", "용도", "Uses"),
    field("risk", "위험도", "Risk"),
];
const IDEOLOGY: &[FieldDefinition] = &[
    field("founder", "창시자", "Founder"),
    field("formationPeriod", "형성 시기", "Formation Period"),
    field("pursuedValues", "추구 가치", "Pursued Values"),
];
const LANGUAGE_FAMILY: &[FieldDefinition] = &[
    field("nativeName", "원어명", "Native Name"),
    field("protoLanguage", "조어", "Proto-Language"),
    field("homeland", "발상지", "Homeland"),
    field("formationPeriod", "형성 시기", "Formation Period"),
    field("majorDistribution", "주요 분포", "Major Distribution"),
    field("majorLanguageArticleIds", "주요 언어", "Major Languages"),
];
const LANGUAGE_BRANCH: &[FieldDefinition] = &[
    field("nativeName", "원어명", "Native Name"),
    field("protoLanguage", "조어", "Proto-Language"),
    field("familyArticleId", "소속 어족", "Language Family"),
    field("homeland", "발상지", "Homeland"),
    field("divergencePeriod", "분화 시기", "Divergence Period"),
    field("majorDistribution", "주요 분포", "Major Distribution"),
    field("majorLanguageArticleIds", "주요 언어", "Major Languages"),
];
const LANGUAGE_GROUP: &[FieldDefinition] = &[
    field("nativeName", "원어명", "Native Name"),
    field("protoLanguage", "조어", "Proto-Language"),
    field("branchArticleId", "소속 어파", "Language Branch"),
    field("homeland", "발상지", "Homeland"),
    field("divergencePeriod", "분화 시기", "Divergence Period"),
    field("majorDistribution", "주요 분포", "Major Distribution"),
    field("majorLanguageArticleIds", "주요 언어", "Major Languages"),
];
const LANGUAGE: &[FieldDefinition] = &[
    field("nativeName", "원어명", "Native Name"),
    field("protoLanguage", "조어", "Proto-Language"),
    field("groupArticleId", "소속 어군", "Language Group"),
    field("homeland", "발상지", "Homeland"),
    field("formationPeriod", "형성 시기", "Formation Period"),
    field("majorDistribution", "주요 분포", "Major Distribution"),
    field("languageType", "언어 유형", "Language Type"),
    field("writingSystemArticleIds", "사용 문자", "Writing Systems"),
];
const DIALECT: &[FieldDefinition] = &[
    field("selfName", "자칭 명칭", "Self-Name"),
    field("formationPeriod", "형성 시기", "Formation Period"),
    field("parentLanguageArticleId", "소속 언어", "Language"),
    field("usageRegion", "사용 지역", "Usage Region"),
];
const WRITING_SYSTEM: &[FieldDefinition] = &[
    field("nativeName", "원어명", "Native Name"),
    field("origin", "발상지", "Origin"),
    field("formationPeriod", "형성 시기", "Formation Period"),
    field("usageRegions", "사용 지역", "Usage Regions"),
    field("scriptType", "문자 유형", "Script Type"),
];
const GENERIC: &[FieldDefinition] = &[
    field("category", "분류", "Category"),
    field("recorded", "기록 시점", "Recorded"),
];

const fn field(key: &'static str, korean: &'static str, english: &'static str) -> FieldDefinition {
    FieldDefinition {
        key,
        korean,
        english,
    }
}

pub fn definitions(category: &str) -> &'static [FieldDefinition] {
    match category {
        "world" => WORLD,
        "person" => PERSON,
        "family" => FAMILY,
        "item" | "weapon" | "armor" | "accessory" | "item_unique" | "weapon_unique"
        | "armor_unique" | "accessory_unique" => ITEM,
        "disease" => DISEASE,
        "religion" => RELIGION,
        "calendar" => CALENDAR,
        "government" => GOVERNMENT,
        "material" | "resource" => MATERIAL,
        "event" | "accident" | "war" => EVENT,
        "battle" => BATTLE,
        "country" => COUNTRY,
        "faction" | "organization" | "order" | "merchant_guild" | "mercenary_company"
        | "assassin_guild" | "knight_order" => ORGANIZATION,
        "city" | "village" | "fortress" | "base" | "location" => PLACE,
        "ideology" => IDEOLOGY,
        "language_family" => LANGUAGE_FAMILY,
        "language_branch" => LANGUAGE_BRANCH,
        "language_group" => LANGUAGE_GROUP,
        "language" => LANGUAGE,
        "dialect" => DIALECT,
        "writing_system" => WRITING_SYSTEM,
        "culture" | "culture_sphere" => CULTURE,
        "technology"
        | "technology_engineering"
        | "technology_mathematics"
        | "technology_science"
        | "technology_chemistry"
        | "technology_medicine"
        | "technology_physics"
        | "discipline_natural_science"
        | "discipline_formal_science"
        | "discipline_applied_science"
        | "discipline_social_science"
        | "discipline_humanities"
        | "discipline_other" => TECHNOLOGY,
        "mineral" => MINERAL,
        "rock" => ROCK,
        "animal" | "plant" | "tree" => NATURE,
        _ => GENERIC,
    }
}

#[allow(dead_code)]
pub fn article_fields(
    world: &LoadedWorld,
    article: &Article,
    language: Language,
) -> Vec<(String, String)> {
    article_fields_at(world, article, language, world.map.current_year)
}

pub fn article_fields_at(
    world: &LoadedWorld,
    article: &Article,
    language: Language,
    year: i32,
) -> Vec<(String, String)> {
    let category = article.category.as_str();
    let profile = profile_for(article, category);
    definitions(category)
        .iter()
        .map(|definition| {
            let label = match language {
                Language::Korean => definition.korean,
                Language::English => definition.english,
            };
            let value = if category == "world" {
                match (definition.key, language) {
                    ("rpgEnabled", Language::Korean) => if world.rpg_enabled {
                        "사용"
                    } else {
                        "미사용"
                    }
                    .to_owned(),
                    ("rpgEnabled", Language::English) => if world.rpg_enabled {
                        "Enabled"
                    } else {
                        "Disabled"
                    }
                    .to_owned(),
                    ("magicEnabled", Language::Korean) => if world.magic_enabled {
                        "존재"
                    } else {
                        "없음"
                    }
                    .to_owned(),
                    ("magicEnabled", Language::English) => if world.magic_enabled {
                        "Exists"
                    } else {
                        "None"
                    }
                    .to_owned(),
                    _ => String::new(),
                }
            } else if definition.key == "category" {
                article.category.clone()
            } else if definition.key == "summary" {
                article.summary.clone()
            } else if category == "calendar" {
                calendar_value(article, definition.key)
            } else if matches!(category, "event" | "accident" | "war" | "battle") {
                event_value(world, article, definition.key, language)
            } else if category == "country" {
                country_value(world, article, definition.key, language)
            } else if matches!(
                category,
                "city" | "village" | "fortress" | "base" | "location"
            ) {
                place_value(world, article, definition.key, year, profile, language)
            } else if matches!(
                category,
                "faction"
                    | "organization"
                    | "order"
                    | "merchant_guild"
                    | "mercenary_company"
                    | "assassin_guild"
                    | "knight_order"
            ) {
                organization_value(world, article, definition.key)
            } else {
                profile
                    .and_then(|value| {
                        value.get(definition.key).or_else(|| {
                            (matches!(category, "mineral" | "rock")
                                && definition.key == "distributionAreas")
                                .then(|| value.get("distribution"))
                                .flatten()
                        })
                    })
                    .map(|value| display_value(world, value, definition.key))
                    .unwrap_or_default()
            };
            let value = match (definition.key, language, value.as_str()) {
                ("lifecycleStatus", Language::Korean, "active") => "현역".to_owned(),
                ("lifecycleStatus", Language::Korean, "retired") => "퇴역".to_owned(),
                ("lifecycleStatus", Language::English, "active") => "Active".to_owned(),
                ("lifecycleStatus", Language::English, "retired") => "Retired".to_owned(),
                ("scriptType", Language::Korean, "pictographic") => "상형문자".to_owned(),
                ("scriptType", Language::Korean, "ideographic") => "표의문자".to_owned(),
                ("scriptType", Language::Korean, "logographic") => "표어문자".to_owned(),
                ("scriptType", Language::Korean, "segmental") => "표음-분절문자".to_owned(),
                ("scriptType", Language::Korean, "syllabic") => "표음-음절문자".to_owned(),
                ("scriptType", Language::English, "pictographic") => "Pictographic".to_owned(),
                ("scriptType", Language::English, "ideographic") => "Ideographic".to_owned(),
                ("scriptType", Language::English, "logographic") => "Logographic".to_owned(),
                ("scriptType", Language::English, "segmental") => {
                    "Phonographic - Segmental".to_owned()
                }
                ("scriptType", Language::English, "syllabic") => {
                    "Phonographic - Syllabic".to_owned()
                }
                _ => value,
            };
            (label.to_owned(), dash(value))
        })
        .collect()
}

fn place_value(
    world: &LoadedWorld,
    article: &Article,
    key: &str,
    year: i32,
    profile: Option<&Value>,
    language: Language,
) -> String {
    let manual_country = profile
        .and_then(|value| value.get("manualCountry"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let manual_coordinates = profile
        .and_then(|value| value.get("manualCoordinates"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if key == "region" {
        return profile
            .and_then(|value| value.get("region"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
    }
    if key == "country" && manual_country {
        return profile
            .and_then(|value| value.get("country"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
    }
    if key == "coordinates" && manual_coordinates {
        return profile
            .and_then(|value| value.get("coordinates"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
    }
    let Some(entity_id) = article.source_entity_id.as_deref() else {
        return String::new();
    };
    let Some(location) = world
        .map
        .locations
        .iter()
        .find(|location| location.id == entity_id)
    else {
        return String::new();
    };
    let Some(state) = location.state_at(year) else {
        return String::new();
    };
    match key {
        "coordinates" => format!("X {:.2}, Y {:.2}", state.position.x, state.position.y),
        "country" => world
            .map
            .territory_owner_at(state.position, year)
            .and_then(|index| world.map.factions.get(index))
            .map(|faction| faction.name.clone())
            .unwrap_or_else(|| match language {
                Language::Korean => "무소속".to_owned(),
                Language::English => "Independent".to_owned(),
            }),
        _ => String::new(),
    }
}

fn organization_value(world: &LoadedWorld, article: &Article, key: &str) -> String {
    let Some(profile) = article.profiles.faction.as_ref() else {
        return String::new();
    };
    if matches!(key, "foundedYear" | "dissolvedYear" | "leaderArticleId") {
        return profile
            .get(key)
            .map(|value| display_value(world, value, key))
            .unwrap_or_default();
    }
    let Some(group) = profile.get("groupProfile") else {
        return String::new();
    };
    match key {
        "headquartersLocationId" => {
            let id = group.get(key).and_then(Value::as_str).unwrap_or_default();
            world
                .articles
                .iter()
                .find(|candidate| {
                    candidate.source_entity_id.as_deref() == Some(id) || candidate.id == id
                })
                .map(|candidate| candidate.title.clone())
                .or_else(|| {
                    group
                        .get("headquartersCustom")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                })
                .unwrap_or_default()
        }
        "purpose" => group
            .get("purpose")
            .or_else(|| group.get("goals"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        "scale" | "alignment" | "ideologyArticleId" => group
            .get(key)
            .map(|value| display_value(world, value, key))
            .unwrap_or_default(),
        _ => String::new(),
    }
}

fn country_value(world: &LoadedWorld, article: &Article, key: &str, language: Language) -> String {
    let Some(profile) = article.profiles.faction.as_ref() else {
        return String::new();
    };
    if matches!(key, "foundedYear" | "dissolvedYear") {
        let calendar_profile = world.display_calendar(language);
        let absolute_key = format!("{key}AbsoluteDay");
        let moment = profile
            .get(&absolute_key)
            .and_then(Value::as_f64)
            .map(|day| {
                calendar::timeline_moment_from_absolute_day(day, world.orbital_period_days as f64)
            })
            .or_else(|| {
                profile
                    .get(key)
                    .and_then(Value::as_i64)
                    .map(|year| TimelineMoment::new(year as i32, 0.0))
            });
        return moment
            .map(|moment| {
                calendar::format_absolute_moment_precision(
                    &calendar_profile,
                    language,
                    moment,
                    world.orbital_period_days as f64,
                    calendar_profile.date_units.len().saturating_sub(1),
                )
            })
            .unwrap_or_default();
    }
    if key == "leaderArticleId" {
        return profile
            .get(key)
            .map(|value| display_value(world, value, key))
            .unwrap_or_default();
    }
    let Some(country) = profile.get("countryProfile") else {
        return String::new();
    };
    let linked_title = |id: &str| {
        world
            .articles
            .iter()
            .find(|candidate| {
                candidate.id == id || candidate.source_entity_id.as_deref() == Some(id)
            })
            .map(|candidate| candidate.title.clone())
            .unwrap_or_else(|| id.to_owned())
    };
    match key {
        "locationIds" => {
            let ids = country
                .get(key)
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let result = ids
                .iter()
                .filter_map(Value::as_str)
                .map(linked_title)
                .collect::<Vec<_>>()
                .join(", ");
            if result.is_empty() {
                country
                    .get("locationCustom")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned()
            } else {
                result
            }
        }
        "capitalPeriods" => {
            let calendar_profile = world.display_calendar(language);
            country
                .get(key)
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(|entry| {
                    let name = entry
                        .get("locationId")
                        .and_then(Value::as_str)
                        .map(linked_title)
                        .or_else(|| {
                            entry
                                .get("customName")
                                .and_then(Value::as_str)
                                .map(str::to_owned)
                        })
                        .unwrap_or_else(|| "-".to_owned());
                    let start_moment = entry
                        .get("startYearAbsoluteDay")
                        .and_then(Value::as_f64)
                        .map(|day| {
                            calendar::timeline_moment_from_absolute_day(
                                day,
                                world.orbital_period_days as f64,
                            )
                        })
                        .or_else(|| {
                            entry
                                .get("startYear")
                                .and_then(Value::as_i64)
                                .map(|year| TimelineMoment::new(year as i32, 0.0))
                        });
                    let start = start_moment
                        .map(|moment| {
                            calendar::format_absolute_moment_precision(
                                &calendar_profile,
                                language,
                                moment,
                                world.orbital_period_days as f64,
                                calendar_profile.date_units.len().saturating_sub(1),
                            )
                        })
                        .unwrap_or_else(|| "?".to_owned());
                    let end_moment = entry
                        .get("endYearAbsoluteDay")
                        .and_then(Value::as_f64)
                        .map(|day| {
                            calendar::timeline_moment_from_absolute_day(
                                day,
                                world.orbital_period_days as f64,
                            )
                        })
                        .or_else(|| {
                            entry
                                .get("endYear")
                                .and_then(Value::as_i64)
                                .map(|year| TimelineMoment::new(year as i32, 0.0))
                        });
                    let end = end_moment
                        .map(|moment| {
                            calendar::format_absolute_moment_precision(
                                &calendar_profile,
                                language,
                                moment,
                                world.orbital_period_days as f64,
                                calendar_profile.date_units.len().saturating_sub(1),
                            )
                        })
                        .unwrap_or_else(|| match language {
                            Language::Korean => "현재".to_owned(),
                            Language::English => "Present".to_owned(),
                        });
                    format!("{name} ({start} ~ {end})")
                })
                .collect::<Vec<_>>()
                .join("\n")
        }
        "politicalSystemArticleId" => country
            .get(key)
            .map(|value| display_value(world, value, key))
            .filter(|value| !value.is_empty())
            .or_else(|| {
                country
                    .get("politicalSystem")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .unwrap_or_default(),
        "headOfStateArticleId" => country
            .get(key)
            .map(|value| display_value(world, value, key))
            .filter(|value| !value.is_empty())
            .or_else(|| {
                country
                    .get("headOfStateCustom")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .unwrap_or_default(),
        "languageArticleIds" => country
            .get(key)
            .map(|value| display_value(world, value, key))
            .filter(|value| !value.is_empty())
            .or_else(|| {
                country
                    .get("languageCustom")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .unwrap_or_default(),
        "religionArticleIds" => country
            .get(key)
            .map(|value| display_value(world, value, key))
            .filter(|value| !value.is_empty())
            .or_else(|| {
                country
                    .get("stateReligionCustom")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .unwrap_or_default(),
        _ => String::new(),
    }
}

fn profile_for<'a>(article: &'a Article, category: &str) -> Option<&'a Value> {
    match category {
        "person" => article.profiles.person.as_ref(),
        "family" => article.profiles.family.as_ref(),
        "item" | "weapon" | "armor" | "accessory" | "item_unique" | "weapon_unique"
        | "armor_unique" | "accessory_unique" => article.profiles.item.as_ref(),
        "religion" => article.profiles.religion.as_ref(),
        "disease" => article.profiles.disease.as_ref(),
        "government" => article.profiles.government.as_ref(),
        "material" | "resource" => article.profiles.item.as_ref(),
        "event" | "accident" | "war" | "battle" => article.profiles.event.as_ref(),
        "country" | "faction" | "organization" | "order" | "merchant_guild"
        | "mercenary_company" | "assassin_guild" | "knight_order" => {
            article.profiles.faction.as_ref()
        }
        "animal" | "plant" | "tree" | "rock" | "mineral" => article.profiles.nature.as_ref(),
        "ideology" => article.profiles.ideology.as_ref(),
        "language" | "language_family" | "language_branch" | "language_group" | "dialect"
        | "writing_system" => article.profiles.language.as_ref(),
        "culture" | "culture_sphere" => article.profiles.culture.as_ref(),
        "technology"
        | "technology_engineering"
        | "technology_mathematics"
        | "technology_science"
        | "technology_chemistry"
        | "technology_medicine"
        | "technology_physics"
        | "discipline_natural_science"
        | "discipline_formal_science"
        | "discipline_applied_science"
        | "discipline_social_science"
        | "discipline_humanities"
        | "discipline_other" => article.profiles.technology.as_ref(),
        _ => None,
    }
}

fn calendar_value(article: &Article, key: &str) -> String {
    let Some(profile) = &article.calendar_profile else {
        return String::new();
    };
    match key {
        "calendarName" => profile.calendar_name.clone(),
        "creator" => profile.creator.clone(),
        "createdAtYear" => profile
            .created_at_year
            .map(|value| value.to_string())
            .unwrap_or_default(),
        "mechanism" => profile.mechanism.clone(),
        "epochWorldYear" => profile.epoch_world_year.to_string(),
        "displayMode" => profile.display_mode.clone(),
        _ => String::new(),
    }
}

fn event_value(world: &LoadedWorld, article: &Article, key: &str, language: Language) -> String {
    let Some(profile) = article.profiles.event.as_ref() else {
        return String::new();
    };
    match key {
        "description" | "cause" | "result" | "impact" => profile
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        "location" => {
            if profile.get("locationMode").and_then(Value::as_str) == Some("coordinate") {
                let x = profile
                    .get("location")
                    .and_then(|value| value.get("x"))
                    .and_then(Value::as_f64);
                let y = profile
                    .get("location")
                    .and_then(|value| value.get("y"))
                    .and_then(Value::as_f64);
                match (x, y) {
                    (Some(x), Some(y)) => format!("{x:.1}, {y:.1}"),
                    _ => String::new(),
                }
            } else {
                profile
                    .get("locationText")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned()
            }
        }
        "period" => {
            let calendar_profile = world.display_calendar(language);
            let moment = |date_key: &str, fraction_key: &str| {
                let year = profile
                    .get(date_key)
                    .and_then(|value| value.get("year"))
                    .and_then(Value::as_i64)
                    .unwrap_or_default() as i32;
                let fraction = profile
                    .get(fraction_key)
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0);
                calendar::format_absolute_moment(
                    &calendar_profile,
                    language,
                    TimelineMoment::new(year, fraction),
                    world.orbital_period_days as f64,
                )
            };
            let start = if profile
                .get("startTimeUnknown")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                "?".to_owned()
            } else {
                moment("startDateTime", "startDayFraction")
            };
            let end = if profile
                .get("endTimeUnknown")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                "?".to_owned()
            } else {
                moment("endDateTime", "endDayFraction")
            };
            format!("{start}\n~\n{end}")
        }
        _ => String::new(),
    }
}

fn display_value(world: &LoadedWorld, value: &Value, key: &str) -> String {
    match value {
        Value::Null => String::new(),
        Value::Bool(value) => {
            if *value {
                "O".to_owned()
            } else {
                "X".to_owned()
            }
        }
        Value::Number(value) => value.to_string(),
        Value::String(value) => {
            if key.ends_with("ArticleId") || key.ends_with("ArticleIds") {
                world
                    .articles
                    .iter()
                    .find(|article| article.id == *value)
                    .map(|article| format!("[[{}]]", article.title))
                    .unwrap_or_else(|| value.clone())
            } else {
                value.clone()
            }
        }
        Value::Array(values) => {
            if key == "members" {
                format!("{}", values.len())
            } else {
                values
                    .iter()
                    .map(|value| display_value(world, value, key))
                    .filter(|value| !value.is_empty())
                    .collect::<Vec<_>>()
                    .join(", ")
            }
        }
        Value::Object(_) => String::new(),
    }
}

fn dash(value: String) -> String {
    if value.trim().is_empty() {
        "-".to_owned()
    } else {
        value
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_electron_category_has_a_schema() {
        for category in [
            "world",
            "calendar",
            "country",
            "faction",
            "organization",
            "order",
            "merchant_guild",
            "mercenary_company",
            "assassin_guild",
            "knight_order",
            "city",
            "village",
            "fortress",
            "base",
            "location",
            "person",
            "family",
            "item",
            "weapon",
            "armor",
            "accessory",
            "technology",
            "technology_engineering",
            "technology_mathematics",
            "technology_science",
            "technology_chemistry",
            "technology_medicine",
            "technology_physics",
            "culture_sphere",
            "culture",
            "religion",
            "language_family",
            "language_branch",
            "language_group",
            "language",
            "dialect",
            "writing_system",
            "ideology",
            "government",
            "event",
            "accident",
            "war",
            "battle",
            "animal",
            "plant",
            "tree",
            "rock",
            "mineral",
            "disease",
            "other",
        ] {
            assert!(
                !definitions(category).is_empty(),
                "missing schema for {category}"
            );
        }
    }

    #[test]
    fn world_schema_reads_immutable_project_creation_flags() {
        assert_eq!(
            definitions("world")
                .iter()
                .map(|field| field.key)
                .collect::<Vec<_>>(),
            vec!["rpgEnabled", "magicEnabled"]
        );
        let world = LoadedWorld::load_demo(Language::Korean).expect("Korean demo must load");
        let article = world
            .articles
            .iter()
            .find(|article| article.category == "world")
            .expect("world document");
        assert_eq!(
            article_fields(&world, article, Language::Korean),
            vec![
                ("RPG 규칙 여부".to_owned(), "사용".to_owned()),
                ("마법 여부".to_owned(), "존재".to_owned())
            ]
        );
        assert_eq!(
            article_fields(&world, article, Language::English),
            vec![
                ("RPG Rules Enabled".to_owned(), "Enabled".to_owned()),
                ("Magic Exists".to_owned(), "Exists".to_owned())
            ]
        );
    }

    #[test]
    fn mineral_schema_uses_geological_fields_without_habitat() {
        let fields = definitions("mineral");
        assert!(!fields.iter().any(|field| field.key == "habitat"));
        assert!(
            fields
                .iter()
                .any(|field| field.key == "distributionAreas" && field.korean == "분포지")
        );
        assert!(fields.iter().any(|field| field.key == "meltingPoint"));
        assert!(fields.iter().any(|field| field.key == "hardness"));
    }

    #[test]
    fn rock_schema_uses_distribution_and_strength_without_habitat() {
        let fields = definitions("rock");
        assert!(
            !fields
                .iter()
                .any(|field| field.key == "habitat" || field.key == "meltingPoint")
        );
        assert!(
            fields
                .iter()
                .any(|field| field.key == "distributionAreas" && field.korean == "분포지")
        );
        assert!(
            fields
                .iter()
                .any(|field| field.key == "hardness" && field.english == "Hardness / Strength")
        );
    }

    #[test]
    fn item_schema_has_the_requested_information_order() {
        assert_eq!(
            definitions("item")
                .iter()
                .map(|field| field.key)
                .collect::<Vec<_>>(),
            vec![
                "itemType",
                "origin",
                "purpose",
                "productionPeriod",
                "lifecycleStatus"
            ]
        );
    }

    #[test]
    fn person_schema_has_only_the_requested_relationship_fields_in_order() {
        assert_eq!(
            definitions("person")
                .iter()
                .map(|field| field.key)
                .collect::<Vec<_>>(),
            vec![
                "birthYear",
                "deathYear",
                "nationalityArticleIds",
                "affiliationArticleIds",
                "religionArticleIds",
                "languageArticleIds",
                "ideologyArticleIds",
                "familyArticleId"
            ]
        );
        let world = LoadedWorld::load_demo(Language::Korean).expect("Korean demo must load");
        let empty_person = Article {
            id: "empty-person".into(),
            title: "Empty".into(),
            wiki_aliases: Vec::new(),
            redirect_target_article_id: None,
            category: "person".into(),
            category_id: None,
            summary: String::new(),
            content: String::new(),
            calendar_profile: None,
            document_sections: Vec::new(),
            tags: Vec::new(),
            linked_map_entity_ids: Vec::new(),
            source_map_id: None,
            source_entity_id: None,
            profiles: crate::model::ArticleProfiles {
                person: Some(serde_json::json!({})),
                ..Default::default()
            },
        };
        let values = article_fields(&world, &empty_person, Language::Korean);
        assert_eq!(values.len(), 8);
        assert!(values.into_iter().all(|(_, value)| value == "-"));
    }

    #[test]
    fn family_schema_has_formation_and_dissolution_only() {
        assert_eq!(
            definitions("family")
                .iter()
                .map(|field| field.key)
                .collect::<Vec<_>>(),
            vec!["formationPeriod", "dissolutionPeriod"]
        );
    }

    #[test]
    fn faction_and_organization_share_the_requested_information_order() {
        let expected = vec![
            "foundedYear",
            "dissolvedYear",
            "leaderArticleId",
            "scale",
            "headquartersLocationId",
            "purpose",
            "alignment",
            "ideologyArticleId",
        ];
        for category in [
            "faction",
            "organization",
            "order",
            "merchant_guild",
            "mercenary_company",
            "assassin_guild",
            "knight_order",
        ] {
            assert_eq!(
                definitions(category)
                    .iter()
                    .map(|field| field.key)
                    .collect::<Vec<_>>(),
                expected,
                "{category}"
            );
        }
    }

    #[test]
    fn country_schema_has_dated_capitals_and_requested_information_order() {
        assert_eq!(
            definitions("country")
                .iter()
                .map(|field| field.key)
                .collect::<Vec<_>>(),
            vec![
                "foundedYear",
                "dissolvedYear",
                "locationIds",
                "capitalPeriods",
                "politicalSystemArticleId",
                "headOfStateArticleId",
                "leaderArticleId",
                "languageArticleIds",
                "religionArticleIds"
            ]
        );
    }

    #[test]
    fn bundled_country_demo_contains_multiple_capitals_and_transitions() {
        let world = LoadedWorld::load_demo(Language::Korean).expect("Korean demo must load");
        let countries = world
            .articles
            .iter()
            .filter(|article| article.category == "country")
            .collect::<Vec<_>>();
        assert!(!countries.is_empty());
        assert!(countries.iter().all(|article| {
            article
                .profiles
                .faction
                .as_ref()
                .and_then(|profile| profile.get("countryProfile"))
                .and_then(|country| country.get("capitalPeriods"))
                .and_then(Value::as_array)
                .is_some_and(|periods| periods.len() >= 2)
        }));
        assert!(countries.iter().any(|article| {
            let country = article
                .profiles
                .faction
                .as_ref()
                .and_then(|profile| profile.get("countryProfile"));
            !json_ids(country.and_then(|value| value.get("predecessorArticleIds"))).is_empty()
                && !json_ids(country.and_then(|value| value.get("successorArticleIds"))).is_empty()
        }));
    }

    fn json_ids(value: Option<&Value>) -> Vec<&str> {
        value
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect()
    }

    #[test]
    fn ideology_schema_has_only_the_requested_fields_in_order() {
        assert_eq!(
            definitions("ideology")
                .iter()
                .map(|field| field.key)
                .collect::<Vec<_>>(),
            vec!["founder", "formationPeriod", "pursuedValues"]
        );
    }

    #[test]
    fn language_schemas_expose_each_requested_classification_shape() {
        assert_eq!(
            definitions("dialect")
                .iter()
                .map(|field| field.key)
                .collect::<Vec<_>>(),
            vec![
                "selfName",
                "formationPeriod",
                "parentLanguageArticleId",
                "usageRegion"
            ]
        );
        assert_eq!(
            definitions("writing_system")
                .iter()
                .map(|field| field.key)
                .collect::<Vec<_>>(),
            vec![
                "nativeName",
                "origin",
                "formationPeriod",
                "usageRegions",
                "scriptType"
            ]
        );
        assert_eq!(definitions("language_family").len(), 6);
        assert_eq!(definitions("language_branch").len(), 7);
        assert_eq!(definitions("language_group").len(), 7);
        assert_eq!(definitions("language").len(), 8);
    }

    #[test]
    fn religion_schema_has_the_requested_information_order() {
        assert_eq!(
            definitions("religion")
                .iter()
                .map(|field| field.key)
                .collect::<Vec<_>>(),
            vec![
                "traditionLineage",
                "founder",
                "foundingPeriod",
                "holyCity",
                "distributionRegions",
                "adherentPopulation",
                "religiousInstitutions",
                "scriptures",
                "majorDenominations",
            ]
        );
        assert!(
            !definitions("religion")
                .iter()
                .any(|field| field.key == "doctrine")
        );
    }

    #[test]
    fn culture_schema_has_the_requested_information_fields() {
        let expected = vec![
            "distributionRegions",
            "relatedLanguageArticleIds",
            "relatedReligionArticleIds",
        ];
        assert_eq!(
            definitions("culture")
                .iter()
                .map(|field| field.key)
                .collect::<Vec<_>>(),
            expected
        );
        assert_eq!(
            definitions("culture_sphere")
                .iter()
                .map(|field| field.key)
                .collect::<Vec<_>>(),
            expected
        );
    }

    #[test]
    fn technology_subcategories_share_creator_and_creation_period() {
        let expected = vec!["creator", "creationPeriod"];
        for category in [
            "discipline_natural_science",
            "discipline_formal_science",
            "discipline_applied_science",
            "discipline_social_science",
            "discipline_humanities",
            "discipline_other",
        ] {
            assert_eq!(
                definitions(category)
                    .iter()
                    .map(|field| field.key)
                    .collect::<Vec<_>>(),
                expected
            );
        }
    }

    #[test]
    fn war_and_battle_information_schemas_differ_only_by_cause() {
        assert_eq!(
            definitions("war")
                .iter()
                .map(|field| field.key)
                .collect::<Vec<_>>(),
            vec![
                "description",
                "location",
                "period",
                "cause",
                "result",
                "impact"
            ]
        );
        assert_eq!(
            definitions("battle")
                .iter()
                .map(|field| field.key)
                .collect::<Vec<_>>(),
            vec!["description", "location", "period", "result", "impact"]
        );
    }
}
