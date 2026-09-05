use crate::model::Language;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy)]
pub struct CategoryRow {
    pub key: Option<&'static str>,
    pub korean: &'static str,
    pub english: &'static str,
    pub depth: usize,
}

impl CategoryRow {
    pub fn label(self, language: Language) -> &'static str {
        match language {
            Language::Korean => self.korean,
            Language::English => self.english,
        }
    }
}

pub const WORLD_CATEGORIES: &[CategoryRow] = &[
    CategoryRow {
        key: None,
        korean: "지역·장소",
        english: "Regions & Places",
        depth: 0,
    },
    CategoryRow {
        key: None,
        korean: "지역",
        english: "Regions",
        depth: 1,
    },
    CategoryRow {
        key: Some("continent"),
        korean: "대륙",
        english: "Continents",
        depth: 2,
    },
    CategoryRow {
        key: Some("sea"),
        korean: "바다",
        english: "Seas",
        depth: 2,
    },
    CategoryRow {
        key: Some("island"),
        korean: "섬",
        english: "Islands",
        depth: 2,
    },
    CategoryRow {
        key: Some("peninsula"),
        korean: "반도",
        english: "Peninsulas",
        depth: 2,
    },
    CategoryRow {
        key: Some("river_region"),
        korean: "강",
        english: "Rivers",
        depth: 2,
    },
    CategoryRow {
        key: Some("lake_region"),
        korean: "호수",
        english: "Lakes",
        depth: 2,
    },
    CategoryRow {
        key: Some("desert"),
        korean: "사막",
        english: "Deserts",
        depth: 2,
    },
    CategoryRow {
        key: Some("cave"),
        korean: "동굴",
        english: "Caves",
        depth: 2,
    },
    CategoryRow {
        key: Some("terrain_region"),
        korean: "기타 지형",
        english: "Other Terrain",
        depth: 2,
    },
    CategoryRow {
        key: None,
        korean: "장소",
        english: "Places",
        depth: 1,
    },
    CategoryRow {
        key: Some("city"),
        korean: "도시",
        english: "Cities",
        depth: 2,
    },
    CategoryRow {
        key: Some("village"),
        korean: "마을",
        english: "Villages",
        depth: 2,
    },
    CategoryRow {
        key: Some("fortress"),
        korean: "요새",
        english: "Fortresses",
        depth: 2,
    },
    CategoryRow {
        key: Some("base"),
        korean: "거점",
        english: "Bases",
        depth: 2,
    },
    CategoryRow {
        key: Some("location"),
        korean: "기타 장소",
        english: "Other Places",
        depth: 2,
    },
    CategoryRow {
        key: None,
        korean: "인물·세력",
        english: "People & Powers",
        depth: 0,
    },
    CategoryRow {
        key: Some("country"),
        korean: "국가",
        english: "Countries",
        depth: 1,
    },
    CategoryRow {
        key: Some("faction"),
        korean: "세력",
        english: "Factions",
        depth: 1,
    },
    CategoryRow {
        key: None,
        korean: "단체",
        english: "Organizations",
        depth: 1,
    },
    CategoryRow {
        key: Some("organization"),
        korean: "일반 단체",
        english: "General Organizations",
        depth: 2,
    },
    CategoryRow {
        key: Some("order"),
        korean: "교단",
        english: "Orders",
        depth: 2,
    },
    CategoryRow {
        key: Some("merchant_guild"),
        korean: "상단",
        english: "Merchant Guilds",
        depth: 2,
    },
    CategoryRow {
        key: Some("mercenary_company"),
        korean: "용병단",
        english: "Mercenary Companies",
        depth: 2,
    },
    CategoryRow {
        key: Some("assassin_guild"),
        korean: "암살단",
        english: "Assassin Guilds",
        depth: 2,
    },
    CategoryRow {
        key: Some("knight_order"),
        korean: "기사단",
        english: "Knightly Orders",
        depth: 2,
    },
    CategoryRow {
        key: Some("family"),
        korean: "가문",
        english: "Families",
        depth: 1,
    },
    CategoryRow {
        key: Some("person"),
        korean: "인물",
        english: "People",
        depth: 1,
    },
    CategoryRow {
        key: None,
        korean: "사건·사고",
        english: "Events & Incidents",
        depth: 0,
    },
    CategoryRow {
        key: Some("event"),
        korean: "사건",
        english: "Events",
        depth: 1,
    },
    CategoryRow {
        key: Some("accident"),
        korean: "사고",
        english: "Accidents",
        depth: 1,
    },
    CategoryRow {
        key: None,
        korean: "전쟁·전투",
        english: "Wars & Battles",
        depth: 1,
    },
    CategoryRow {
        key: Some("war"),
        korean: "전쟁",
        english: "Wars",
        depth: 2,
    },
    CategoryRow {
        key: Some("battle"),
        korean: "전투",
        english: "Battles",
        depth: 2,
    },
    CategoryRow {
        key: None,
        korean: "문명·문화",
        english: "Civilization & Culture",
        depth: 0,
    },
    CategoryRow {
        key: None,
        korean: "학문",
        english: "Disciplines",
        depth: 1,
    },
    CategoryRow {
        key: Some("discipline_natural_science"),
        korean: "자연과학",
        english: "Natural Sciences",
        depth: 2,
    },
    CategoryRow {
        key: Some("discipline_formal_science"),
        korean: "형식과학",
        english: "Formal Sciences",
        depth: 2,
    },
    CategoryRow {
        key: Some("discipline_applied_science"),
        korean: "응용과학",
        english: "Applied Sciences",
        depth: 2,
    },
    CategoryRow {
        key: Some("discipline_social_science"),
        korean: "사회과학",
        english: "Social Sciences",
        depth: 2,
    },
    CategoryRow {
        key: Some("discipline_humanities"),
        korean: "인문학",
        english: "Humanities",
        depth: 2,
    },
    CategoryRow {
        key: Some("discipline_other"),
        korean: "기타",
        english: "Other Disciplines",
        depth: 2,
    },
    CategoryRow {
        key: Some("calendar"),
        korean: "역법",
        english: "Calendars",
        depth: 1,
    },
    CategoryRow {
        key: None,
        korean: "문화",
        english: "Cultures",
        depth: 1,
    },
    CategoryRow {
        key: Some("culture_sphere"),
        korean: "문화권",
        english: "Culture Spheres",
        depth: 2,
    },
    CategoryRow {
        key: Some("culture"),
        korean: "문화",
        english: "Cultures",
        depth: 2,
    },
    CategoryRow {
        key: Some("religion"),
        korean: "종교",
        english: "Religions",
        depth: 1,
    },
    CategoryRow {
        key: None,
        korean: "언어",
        english: "Languages",
        depth: 1,
    },
    CategoryRow {
        key: Some("language_family"),
        korean: "어족",
        english: "Language Families",
        depth: 2,
    },
    CategoryRow {
        key: Some("language_branch"),
        korean: "어파",
        english: "Language Branches",
        depth: 2,
    },
    CategoryRow {
        key: Some("language_group"),
        korean: "어군",
        english: "Language Groups",
        depth: 2,
    },
    CategoryRow {
        key: Some("language"),
        korean: "언어",
        english: "Languages",
        depth: 2,
    },
    CategoryRow {
        key: Some("dialect"),
        korean: "방언",
        english: "Dialects",
        depth: 2,
    },
    CategoryRow {
        key: Some("writing_system"),
        korean: "문자",
        english: "Writing Systems",
        depth: 2,
    },
    CategoryRow {
        key: Some("ideology"),
        korean: "사상",
        english: "Ideologies",
        depth: 1,
    },
    CategoryRow {
        key: Some("government"),
        korean: "체제",
        english: "Governments",
        depth: 1,
    },
    CategoryRow {
        key: None,
        korean: "물건·자재",
        english: "Items & Materials",
        depth: 0,
    },
    CategoryRow {
        key: None,
        korean: "보편 물건",
        english: "Common Items",
        depth: 1,
    },
    CategoryRow {
        key: Some("weapon"),
        korean: "무기",
        english: "Weapons",
        depth: 2,
    },
    CategoryRow {
        key: Some("armor"),
        korean: "방어구",
        english: "Armor",
        depth: 2,
    },
    CategoryRow {
        key: Some("accessory"),
        korean: "장신구",
        english: "Accessories",
        depth: 2,
    },
    CategoryRow {
        key: Some("item"),
        korean: "물건",
        english: "General Items",
        depth: 2,
    },
    CategoryRow {
        key: None,
        korean: "고유 물건",
        english: "Unique Objects",
        depth: 1,
    },
    CategoryRow {
        key: Some("weapon_unique"),
        korean: "무기",
        english: "Weapons",
        depth: 2,
    },
    CategoryRow {
        key: Some("armor_unique"),
        korean: "방어구",
        english: "Armor",
        depth: 2,
    },
    CategoryRow {
        key: Some("accessory_unique"),
        korean: "장신구",
        english: "Accessories",
        depth: 2,
    },
    CategoryRow {
        key: Some("item_unique"),
        korean: "물건",
        english: "General Items",
        depth: 2,
    },
    CategoryRow {
        key: Some("material"),
        korean: "재료",
        english: "Materials",
        depth: 1,
    },
    CategoryRow {
        key: Some("resource"),
        korean: "자재",
        english: "Resources",
        depth: 1,
    },
    CategoryRow {
        key: None,
        korean: "자연·생태",
        english: "Nature & Ecology",
        depth: 0,
    },
    CategoryRow {
        key: Some("animal"),
        korean: "동물",
        english: "Animals",
        depth: 1,
    },
    CategoryRow {
        key: Some("plant"),
        korean: "식물",
        english: "Plants",
        depth: 1,
    },
    CategoryRow {
        key: Some("tree"),
        korean: "나무",
        english: "Trees",
        depth: 1,
    },
    CategoryRow {
        key: Some("rock"),
        korean: "암석",
        english: "Rocks",
        depth: 1,
    },
    CategoryRow {
        key: Some("mineral"),
        korean: "광물",
        english: "Minerals",
        depth: 1,
    },
    CategoryRow {
        key: Some("disease"),
        korean: "질병",
        english: "Diseases",
        depth: 1,
    },
    CategoryRow {
        key: Some("other"),
        korean: "기타",
        english: "Other Records",
        depth: 0,
    },
];

#[derive(Clone, Copy)]
pub struct RpgGroup {
    pub tab: usize,
    pub korean: &'static str,
    pub english: &'static str,
    pub magic_only: bool,
    pub entries: &'static [(&'static str, &'static str)],
}

const CAPABILITIES: &[(&str, &str)] = &[
    ("체력", "Health"),
    ("근력", "Strength"),
    ("민첩성", "Agility"),
    ("인지력", "Perception"),
    ("지능", "Intelligence"),
    ("매력", "Charm"),
    ("운", "Luck"),
];
const DISPOSITION: &[(&str, &str)] = &[
    ("의지력", "Willpower"),
    ("사회성", "Social Ability"),
    ("도덕성", "Morality"),
    ("호기심", "Curiosity"),
    ("신앙심", "Faith"),
    ("충성심", "Loyalty"),
];
const MAGIC: &[(&str, &str)] = &[
    ("마법력", "Magic Power"),
    ("마법 회복력", "Magic Regeneration"),
    ("마법 방어력", "Magic Defense"),
    ("마법 전개력", "Magic Projection"),
];
const EQUIPMENT_COMMON: &[(&str, &str)] = &[
    ("내구도", "Durability"),
    ("무게", "Weight"),
    ("가치", "Value"),
];
const WEAPON: &[(&str, &str)] = &[
    ("피해량", "Damage"),
    ("피해 수단", "Damage Method"),
    ("피해 속성", "Damage Attribute"),
];
const ARMOR: &[(&str, &str)] = &[
    ("방어력", "Defense"),
    ("방어 가능 여부", "Block Capability"),
    ("방어 속성", "Defense Attribute"),
];
const ACCESSORY: &[(&str, &str)] = &[("효과", "Effect"), ("발동 조건", "Activation")];
const GENERAL_ITEM: &[(&str, &str)] = &[("용도", "Purpose"), ("희귀도", "Rarity")];
const WEAPON_SKILLS: &[(&str, &str)] = &[
    ("단검", "Dagger"),
    ("검", "Sword"),
    ("도끼", "Axe"),
    ("창", "Spear"),
    ("둔기", "Blunt Weapon"),
    ("활", "Bow"),
    ("쇠뇌", "Crossbow"),
    ("총", "Firearm"),
];
const MAGIC_SKILLS: &[(&str, &str)] = &[
    ("파괴류", "Destruction"),
    ("조종류", "Control"),
    ("치유류", "Healing"),
    ("변형류", "Transformation"),
];
const SOCIAL_SKILLS: &[(&str, &str)] = &[
    ("흥정", "Bargaining"),
    ("소통", "Communication"),
    ("통솔", "Leadership"),
    ("전술", "Tactics"),
    ("전략", "Strategy"),
];
const ACTIVITY_SKILLS: &[(&str, &str)] = &[
    ("승마", "Riding"),
    ("은신", "Stealth"),
    ("항법", "Navigation"),
    ("생존", "Survival"),
    ("추적", "Tracking"),
    ("탐색", "Searching"),
    ("공예", "Crafting"),
    ("요리", "Cooking"),
    ("원예", "Gardening"),
    ("손재주", "Dexterity"),
    ("응급처치", "First Aid"),
];
const EMPTY: &[(&str, &str)] = &[];

pub const RPG_GROUPS: &[RpgGroup] = &[
    RpgGroup {
        tab: 0,
        korean: "역량",
        english: "Capabilities",
        magic_only: false,
        entries: CAPABILITIES,
    },
    RpgGroup {
        tab: 0,
        korean: "성향",
        english: "Disposition",
        magic_only: false,
        entries: DISPOSITION,
    },
    RpgGroup {
        tab: 0,
        korean: "마법력",
        english: "Magic Power",
        magic_only: true,
        entries: MAGIC,
    },
    RpgGroup {
        tab: 1,
        korean: "장비 공통",
        english: "Equipment Common",
        magic_only: false,
        entries: EQUIPMENT_COMMON,
    },
    RpgGroup {
        tab: 1,
        korean: "무기",
        english: "Weapons",
        magic_only: false,
        entries: WEAPON,
    },
    RpgGroup {
        tab: 1,
        korean: "방어구",
        english: "Armor",
        magic_only: false,
        entries: ARMOR,
    },
    RpgGroup {
        tab: 1,
        korean: "장신구",
        english: "Accessories",
        magic_only: false,
        entries: ACCESSORY,
    },
    RpgGroup {
        tab: 1,
        korean: "일반 물건",
        english: "General Items",
        magic_only: false,
        entries: GENERAL_ITEM,
    },
    RpgGroup {
        tab: 2,
        korean: "무기 스킬",
        english: "Weapon Skills",
        magic_only: false,
        entries: WEAPON_SKILLS,
    },
    RpgGroup {
        tab: 2,
        korean: "마법 스킬",
        english: "Magic Skills",
        magic_only: true,
        entries: MAGIC_SKILLS,
    },
    RpgGroup {
        tab: 2,
        korean: "사회 활동",
        english: "Social Skill",
        magic_only: false,
        entries: SOCIAL_SKILLS,
    },
    RpgGroup {
        tab: 2,
        korean: "활동 스킬",
        english: "Activity Skills",
        magic_only: false,
        entries: ACTIVITY_SKILLS,
    },
    RpgGroup {
        tab: 2,
        korean: "직업 스킬",
        english: "Job Skills",
        magic_only: false,
        entries: EMPTY,
    },
];

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RpgValueKind {
    #[default]
    Integer,
    Percent,
    Text,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RpgRuleDefinition {
    pub id: String,
    pub korean: String,
    pub english: String,
    #[serde(default)]
    pub value_kind: RpgValueKind,
    #[serde(default)]
    pub builtin: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RpgRuleGroup {
    pub id: String,
    pub parent_id: String,
    pub korean: String,
    pub english: String,
    #[serde(default)]
    pub magic_only: bool,
    #[serde(default)]
    pub builtin: bool,
    #[serde(default)]
    pub definitions: Vec<RpgRuleDefinition>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RpgRuleCategory {
    pub id: String,
    pub korean: String,
    pub english: String,
    #[serde(default)]
    pub builtin: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RpgRuleSet {
    #[serde(default)]
    pub categories: Vec<RpgRuleCategory>,
    #[serde(default)]
    pub groups: Vec<RpgRuleGroup>,
}

impl RpgRuleCategory {
    pub fn label(&self, language: Language) -> &str {
        match language {
            Language::Korean => &self.korean,
            Language::English => &self.english,
        }
    }
}

impl RpgRuleGroup {
    pub fn label(&self, language: Language) -> &str {
        match language {
            Language::Korean => &self.korean,
            Language::English => &self.english,
        }
    }
}

impl RpgRuleDefinition {
    pub fn label(&self, language: Language) -> &str {
        match language {
            Language::Korean => &self.korean,
            Language::English => &self.english,
        }
    }
}

pub fn default_rpg_rule_set() -> RpgRuleSet {
    let categories = [
        (
            "character_attributes",
            "인물 고유 수치",
            "Character Attributes",
        ),
        (
            "equipment_attributes",
            "장비 고유 수치",
            "Equipment Attributes",
        ),
        (
            "character_proficiencies",
            "인물 숙련도",
            "Character Proficiencies",
        ),
    ]
    .into_iter()
    .map(|(id, korean, english)| RpgRuleCategory {
        id: id.to_owned(),
        korean: korean.to_owned(),
        english: english.to_owned(),
        builtin: true,
    })
    .collect::<Vec<_>>();
    let mut groups = Vec::new();
    for (group_index, group) in RPG_GROUPS.iter().enumerate() {
        let parent_id = categories[group.tab].id.clone();
        let group_id = match (group.tab, group_index) {
            (0, 0) => "capabilities",
            (0, 1) => "disposition",
            (0, 2) => "magic",
            (1, 3) => "equipment_common",
            (1, 4) => "weapon",
            (1, 5) => "armor",
            (1, 6) => "accessory",
            (1, 7) => "general_item",
            (2, 8) => "weapon_skills",
            (2, 9) => "magic_skills",
            (2, 10) => "social_skills",
            (2, 11) => "activity_skills",
            (2, 12) => "job_skills",
            _ => "rpg_group",
        };
        let definitions = group
            .entries
            .iter()
            .enumerate()
            .map(|(index, (korean, english))| RpgRuleDefinition {
                id: format!("{group_id}-{}", index + 1),
                korean: (*korean).to_owned(),
                english: (*english).to_owned(),
                value_kind: RpgValueKind::Integer,
                builtin: true,
            })
            .collect();
        groups.push(RpgRuleGroup {
            id: group_id.to_owned(),
            parent_id,
            korean: group.korean.to_owned(),
            english: group.english.to_owned(),
            magic_only: group.magic_only,
            builtin: true,
            definitions,
        });
    }
    RpgRuleSet { categories, groups }
}

pub const OPEN_SOURCE_LICENSES: &[(&str, &str, &str)] = &[
    ("Rust", "MIT / Apache-2.0", "https://www.rust-lang.org"),
    (
        "egui / eframe",
        "MIT / Apache-2.0",
        "https://github.com/emilk/egui",
    ),
    ("wgpu", "MIT / Apache-2.0", "https://github.com/gfx-rs/wgpu"),
    (
        "serde",
        "MIT / Apache-2.0",
        "https://github.com/serde-rs/serde",
    ),
    (
        "flate2",
        "MIT / Apache-2.0",
        "https://github.com/rust-lang/flate2-rs",
    ),
    (
        "Noto Sans KR",
        "SIL Open Font License 1.1",
        "https://fonts.google.com/noto",
    ),
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_rules_split_social_and_activity_skills_in_stable_order() {
        let rules = default_rpg_rule_set();
        let social = rules
            .groups
            .iter()
            .find(|group| group.id == "social_skills")
            .unwrap();
        let activity = rules
            .groups
            .iter()
            .find(|group| group.id == "activity_skills")
            .unwrap();
        assert_eq!(social.korean, "사회 활동");
        assert_eq!(social.english, "Social Skill");
        assert_eq!(
            activity
                .definitions
                .iter()
                .map(|item| item.korean.as_str())
                .collect::<Vec<_>>(),
            [
                "승마",
                "은신",
                "항법",
                "생존",
                "추적",
                "탐색",
                "공예",
                "요리",
                "원예",
                "손재주",
                "응급처치",
            ]
        );
    }

    #[test]
    fn rpg_rule_value_kind_round_trips() {
        let mut rules = default_rpg_rule_set();
        rules.groups[0].definitions[0].value_kind = RpgValueKind::Percent;
        let encoded = serde_json::to_string(&rules).unwrap();
        let decoded: RpgRuleSet = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded, rules);
    }
}
