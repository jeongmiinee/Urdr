use eframe::egui::{self, RichText, Stroke};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{model::Language, theme};

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LinguisticSystem {
    #[serde(default = "schema_version")]
    pub schema_version: u32,
    #[serde(default)]
    pub modules: Vec<LinguisticModule>,
    #[serde(default)]
    pub comparisons: Vec<ComparisonRow>,
    #[serde(default)]
    pub paradigms: Vec<Paradigm>,
    #[serde(default)]
    pub examples: Vec<LinguisticExample>,
    #[serde(default)]
    pub focused: LanguageFocusedStructure,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LanguageFocusedStructure {
    #[serde(default)]
    pub word_order: WordOrderProfile,
    #[serde(default)]
    pub parts_of_speech: Vec<PartOfSpeechProfile>,
    #[serde(default)]
    pub constituents: Vec<ConstituentProfile>,
    #[serde(default)]
    pub clause_patterns: Vec<ClausePattern>,
    #[serde(default)]
    pub migration_notes: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WordOrderProfile {
    #[serde(default)]
    pub dominant_order: String,
    #[serde(default)]
    pub flexibility: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub rules: Vec<OrderRule>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OrderRule {
    pub relation: String,
    #[serde(default)]
    pub dominant_order: String,
    #[serde(default)]
    pub alternatives: String,
    #[serde(default)]
    pub markedness: String,
    #[serde(default)]
    pub conditions: String,
    #[serde(default)]
    pub explanation: String,
    #[serde(default)]
    pub examples: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PartOfSpeechProfile {
    pub name: String,
    #[serde(default)]
    pub abbreviation: String,
    #[serde(default)]
    pub class_type: String,
    #[serde(default)]
    pub definition: String,
    #[serde(default)]
    pub morphology: String,
    #[serde(default)]
    pub inflection: String,
    #[serde(default)]
    pub syntax: String,
    #[serde(default)]
    pub functions: String,
    #[serde(default)]
    pub subtypes: String,
    #[serde(default)]
    pub diagnostics: String,
    #[serde(default)]
    pub examples: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub dictionary_links: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConstituentProfile {
    pub name: String,
    #[serde(default)]
    pub abbreviation: String,
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub realization: String,
    #[serde(default)]
    pub requirement: String,
    #[serde(default)]
    pub multiplicity: String,
    #[serde(default)]
    pub marking: String,
    #[serde(default)]
    pub agreement: String,
    #[serde(default)]
    pub omission: String,
    #[serde(default)]
    pub position: String,
    #[serde(default)]
    pub constraints: String,
    #[serde(default)]
    pub predicates: String,
    #[serde(default)]
    pub subtypes: String,
    #[serde(default)]
    pub examples: String,
    #[serde(default)]
    pub notes: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClausePattern {
    pub name: String,
    #[serde(default)]
    pub slots: Vec<String>,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub gloss: String,
    #[serde(default)]
    pub translation: String,
    #[serde(default)]
    pub notes: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LinguisticModule {
    pub id: String,
    pub title: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub overview: String,
    #[serde(default)]
    pub entries: Vec<LinguisticEntry>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LinguisticEntry {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub form: String,
    #[serde(default)]
    pub value: String,
    #[serde(default)]
    pub context: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default = "default_certainty")]
    pub certainty: String,
    #[serde(default)]
    pub reconstructed: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ComparisonRow {
    #[serde(default)]
    pub concept: String,
    #[serde(default)]
    pub forms: Vec<String>,
    #[serde(default)]
    pub correspondence: String,
    #[serde(default = "default_certainty")]
    pub certainty: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Paradigm {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub columns: Vec<String>,
    #[serde(default)]
    pub rows: Vec<Vec<String>>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LinguisticExample {
    #[serde(default)]
    pub original: String,
    #[serde(default)]
    pub transliteration: String,
    #[serde(default)]
    pub gloss: String,
    #[serde(default)]
    pub translation: String,
    #[serde(default)]
    pub notes: String,
}

fn schema_version() -> u32 {
    2
}
fn default_true() -> bool {
    true
}
fn default_certainty() -> String {
    "certain".to_owned()
}

fn tr<'a>(language: Language, korean: &'a str, english: &'a str) -> &'a str {
    match language {
        Language::Korean => korean,
        Language::English => english,
    }
}

fn module_specs(category: &str, language: Language) -> Vec<(&'static str, &'static str)> {
    let korean = match category {
        "language_family" => vec![
            ("proto", "조어 개요"),
            ("phonology", "조어 음운론"),
            ("morphology", "조어 형태론"),
            ("syntax", "조어 통사론"),
            ("comparative", "비교 음운 대응"),
            ("divergence", "분화 계통"),
            ("reconstruction", "재구형과 확실성"),
        ],
        "language_branch" => vec![
            ("parentComparison", "상위 어족 비교"),
            ("innovations", "공통 혁신"),
            ("retentions", "공통 보존"),
            ("proto", "조어파"),
            ("divergence", "하위 어군 분화"),
        ],
        "language_group" => vec![
            ("proto", "조어군"),
            ("parentComparison", "상위 어파 비교"),
            ("languageComparison", "하위 언어 비교"),
            ("divergence", "언어 분화"),
            ("intelligibility", "상호 이해도·방언 연속체"),
            ("contact", "언어 접촉"),
        ],
        "dialect" => vec![
            ("inheritance", "상위 언어 상속·재정의"),
            ("phonology", "음운 차이"),
            ("morphology", "형태 차이"),
            ("syntax", "통사 차이"),
            ("lexicon", "어휘 차이"),
            ("semantics", "의미·화용 차이"),
            ("orthography", "표기 차이"),
            ("intelligibility", "상호 이해도·연속체"),
            ("contact", "접촉과 변화"),
        ],
        "writing_system" => vec![
            ("overview", "개요·문자 유형"),
            ("graphemes", "문자 목록·자소 체계"),
            ("soundMapping", "자소와 음가"),
            ("combinations", "결합·합자·부호·위치형"),
            ("ordering", "배열·정렬·표기 방향"),
            ("orthography", "정서법"),
            ("punctuation", "구두점"),
            ("numerals", "숫자"),
            ("usage", "사용 언어"),
            ("history", "문자 계통·역사·개혁"),
            ("derived", "파생 문자"),
            ("styles", "서체·시대·지역 변형"),
            ("modern", "현대적 사용"),
        ],
        _ => vec![
            ("phonology", "음운론·이형태·음운 규칙"),
            ("morphology", "형태론·형태소"),
            ("partsOfSpeech", "품사"),
            ("noun", "명사·대명사·형용사·수사"),
            ("verb", "동사"),
            ("syntax", "통사론·절 유형"),
            ("wordFormation", "조어법"),
            ("semantics", "의미론·화용론"),
            ("history", "역사적 변화"),
            ("orthography", "문자·정서법"),
            ("varieties", "표준어·방언·사용역·접촉"),
        ],
    };
    if language == Language::Korean {
        return korean;
    }
    korean
        .into_iter()
        .map(|(id, _)| (id, english_module_title(id)))
        .collect()
}

fn english_module_title(id: &str) -> &'static str {
    match id {
        "proto" => "Proto-Language",
        "phonology" => "Phonology",
        "morphology" => "Morphology",
        "syntax" => "Syntax",
        "comparative" => "Comparative Evidence",
        "divergence" => "Divergence",
        "reconstruction" => "Reconstructions & Certainty",
        "parentComparison" => "Parent Comparison",
        "innovations" => "Shared Innovations",
        "retentions" => "Shared Retentions",
        "languageComparison" => "Child Language Comparison",
        "intelligibility" => "Intelligibility & Continuum",
        "contact" => "Language Contact",
        "inheritance" => "Inheritance & Overrides",
        "lexicon" => "Lexicon",
        "semantics" => "Semantics & Pragmatics",
        "orthography" => "Orthography",
        "overview" => "Overview & Type",
        "graphemes" => "Grapheme Inventory",
        "soundMapping" => "Grapheme-Sound Mapping",
        "combinations" => "Combinations, Ligatures & Forms",
        "ordering" => "Order, Sorting & Direction",
        "punctuation" => "Punctuation",
        "numerals" => "Numerals",
        "usage" => "Language Usage",
        "history" => "Genealogy, History & Reforms",
        "derived" => "Derived Scripts",
        "styles" => "Styles & Variants",
        "modern" => "Modern Use",
        "partsOfSpeech" => "Parts of Speech",
        "noun" => "Nominals",
        "verb" => "Verbs",
        "wordFormation" => "Word Formation",
        "varieties" => "Varieties, Register & Contact",
        _ => "Linguistic Module",
    }
}

fn default_focused_structure(language: Language) -> LanguageFocusedStructure {
    let relation = |ko, en| tr(language, ko, en).to_owned();
    let rules = [
        ("타동절 핵심 어순", "Transitive clause order"),
        ("자동사 주어 / 동사", "Intransitive subject / verb"),
        ("목적어 / 동사", "Object / verb"),
        ("조동사 / 동사", "Auxiliary / verb"),
        ("부정사 / 동사", "Negator / verb"),
        ("사격어 / 목적어 / 동사", "Oblique / object / verb"),
        ("부치사 / 명사구", "Adposition / noun phrase"),
        ("형용사 / 명사", "Adjective / noun"),
        ("속격어 / 명사", "Genitive / noun"),
        ("지시사 / 명사", "Demonstrative / noun"),
        ("수사 / 명사", "Numeral / noun"),
        ("관계절 / 명사", "Relative clause / noun"),
        ("부사 / 동사", "Adverb / verb"),
        ("의문 요소 위치", "Interrogative position"),
    ]
    .into_iter()
    .map(|(ko, en)| OrderRule {
        relation: relation(ko, en),
        ..Default::default()
    })
    .collect();
    let parts_of_speech = [
        ("명사", "Noun", "N"),
        ("동사", "Verb", "V"),
        ("형용사", "Adjective", "ADJ"),
        ("부사", "Adverb", "ADV"),
        ("대명사", "Pronoun", "PRON"),
        ("부치사", "Adposition", "ADP"),
        ("한정사", "Determiner", "DET"),
        ("조동사", "Auxiliary", "AUX"),
    ]
    .into_iter()
    .map(|(ko, en, abbreviation)| PartOfSpeechProfile {
        name: relation(ko, en),
        abbreviation: abbreviation.to_owned(),
        ..Default::default()
    })
    .collect();
    let constituents = [
        ("서술어", "Predicate"),
        ("핵심 논항", "Core argument"),
        ("주어·행위자형 논항", "Subject / agent-like argument"),
        ("목적어·피행위자형 논항", "Object / patient-like argument"),
        ("보어", "Complement"),
        ("사격어·부사어", "Oblique / adverbial"),
        ("수식어", "Modifier"),
        ("한정어", "Determiner"),
        ("접속 요소", "Coordination"),
        ("절 연결 요소", "Clause linkage"),
        ("화제·초점", "Topic / focus"),
        ("호격어", "Vocative"),
        ("독립 요소", "Independent element"),
    ]
    .into_iter()
    .map(|(ko, en)| ConstituentProfile {
        name: relation(ko, en),
        ..Default::default()
    })
    .collect();
    LanguageFocusedStructure {
        word_order: WordOrderProfile {
            rules,
            ..Default::default()
        },
        parts_of_speech,
        constituents,
        ..Default::default()
    }
}

fn migrate_focused_structure(system: &mut LinguisticSystem, language: Language) {
    if system.schema_version >= schema_version() {
        return;
    }
    system.focused = default_focused_structure(language);
    if let Some(module) = system
        .modules
        .iter_mut()
        .find(|module| module.id == "syntax")
    {
        if !module.overview.trim().is_empty() {
            system.focused.word_order.notes = std::mem::take(&mut module.overview);
        }
    }
    if let Some(module) = system
        .modules
        .iter_mut()
        .find(|module| module.id == "partsOfSpeech")
    {
        if !module.overview.trim().is_empty() {
            system.focused.migration_notes = std::mem::take(&mut module.overview);
        }
    }
    system.schema_version = schema_version();
}

pub fn load(profile: Option<&Value>, category: &str, language: Language) -> LinguisticSystem {
    if let Some(value) = profile.and_then(|profile| profile.get("linguistics")) {
        if let Ok(mut system) = serde_json::from_value::<LinguisticSystem>(value.clone()) {
            ensure_modules(&mut system, category, language);
            if category == "language" {
                migrate_focused_structure(&mut system, language);
            }
            return system;
        }
    }
    let mut system = LinguisticSystem {
        schema_version: schema_version(),
        ..Default::default()
    };
    ensure_modules(&mut system, category, language);
    if category == "language" {
        system.focused = default_focused_structure(language);
    }
    if let Some(profile) = profile {
        for module in &mut system.modules {
            if let Some(value) = profile.get(&module.id).and_then(Value::as_str) {
                module.overview = value.to_owned();
            }
        }
    }
    system
}

fn ensure_modules(system: &mut LinguisticSystem, category: &str, language: Language) {
    for (id, title) in module_specs(category, language) {
        if let Some(module) = system.modules.iter_mut().find(|module| module.id == id) {
            if module.title.trim().is_empty() {
                module.title = title.to_owned();
            }
        } else {
            system.modules.push(LinguisticModule {
                id: id.to_owned(),
                title: title.to_owned(),
                enabled: true,
                overview: String::new(),
                entries: Vec::new(),
            });
        }
    }
}

pub fn save(profile: &mut serde_json::Map<String, Value>, system: &LinguisticSystem) {
    if let Ok(value) = serde_json::to_value(system) {
        profile.insert("linguistics".to_owned(), value);
    }
}

pub fn panel(
    ui: &mut egui::Ui,
    dark: bool,
    language: Language,
    category: &str,
    profile: Option<&Value>,
) {
    let colors = theme::palette(dark);
    let system = load(profile, category, language);
    if category == "language" {
        focused_panel(ui, dark, language, &system.focused);
    }
    theme::surface_frame(dark).show(ui, |ui| {
        ui.label(
            RichText::new(structure_title(language, category, false))
                .size(13.0)
                .strong()
                .color(colors.title),
        );
        ui.separator();
        for module in system.modules.iter().filter(|module| {
            module.enabled && (!module.overview.trim().is_empty() || !module.entries.is_empty())
        }) {
            egui::CollapsingHeader::new(RichText::new(&module.title).strong())
                .default_open(false)
                .show(ui, |ui| {
                    if !module.overview.trim().is_empty() {
                        ui.label(&module.overview);
                    }
                    for entry in &module.entries {
                        ui.horizontal_wrapped(|ui| {
                            ui.label(
                                RichText::new(if entry.reconstructed {
                                    format!("*{}", entry.form)
                                } else {
                                    entry.form.clone()
                                })
                                .strong()
                                .color(colors.title),
                            );
                            if !entry.name.is_empty() {
                                ui.label(&entry.name);
                            }
                            if !entry.value.is_empty() {
                                ui.label(RichText::new(&entry.value).color(colors.accent));
                            }
                            if !entry.context.is_empty() {
                                ui.label(
                                    RichText::new(format!("/ {}", entry.context))
                                        .color(colors.muted),
                                );
                            }
                            ui.label(
                                RichText::new(certainty_label(language, &entry.certainty))
                                    .size(8.5)
                                    .color(colors.muted),
                            );
                        });
                        if !entry.notes.is_empty() {
                            ui.label(RichText::new(&entry.notes).size(9.0).color(colors.muted));
                        }
                    }
                });
        }
        if system
            .modules
            .iter()
            .all(|module| module.overview.trim().is_empty() && module.entries.is_empty())
        {
            ui.label(
                RichText::new(tr(
                    language,
                    "기록된 구조가 없습니다.",
                    "No structured data recorded.",
                ))
                .color(colors.muted),
            );
        }
    });
    if !system.comparisons.is_empty() {
        comparison_panel(ui, dark, language, &system.comparisons);
    }
    if !system.paradigms.is_empty() {
        paradigm_panel(ui, dark, language, &system.paradigms);
    }
    if !system.examples.is_empty() {
        examples_panel(ui, dark, language, &system.examples);
    }
}

pub fn editor(
    ui: &mut egui::Ui,
    dark: bool,
    language: Language,
    category: &str,
    profile: &mut serde_json::Map<String, Value>,
) {
    let colors = theme::palette(dark);
    let mut system = load(Some(&Value::Object(profile.clone())), category, language);
    if category == "language" {
        focused_editor(ui, dark, language, &mut system.focused);
    }
    theme::surface_frame(dark).show(ui, |ui| {
        ui.label(
            RichText::new(structure_title(language, category, true))
                .size(13.0)
                .strong()
                .color(colors.title),
        );
        ui.separator();
        for module in &mut system.modules {
            egui::CollapsingHeader::new(&module.title)
                .default_open(false)
                .show(ui, |ui| {
                    ui.checkbox(
                        &mut module.enabled,
                        tr(language, "문서에 표시", "Show in document"),
                    );
                    ui.add_sized(
                        [ui.available_width(), 58.0],
                        egui::TextEdit::multiline(&mut module.overview)
                            .hint_text(tr(language, "개요", "Overview")),
                    );
                    let mut remove = None;
                    for (index, entry) in module.entries.iter_mut().enumerate() {
                        egui::Frame::new()
                            .fill(colors.surface_soft)
                            .stroke(Stroke::new(1.0, colors.border))
                            .corner_radius(4.0)
                            .inner_margin(6.0)
                            .show(ui, |ui| {
                                ui.horizontal(|ui| {
                                    ui.text_edit_singleline(&mut entry.name);
                                    ui.text_edit_singleline(&mut entry.form);
                                    ui.text_edit_singleline(&mut entry.value);
                                    if ui.small_button("×").clicked() {
                                        remove = Some(index);
                                    }
                                });
                                ui.horizontal(|ui| {
                                    ui.text_edit_singleline(&mut entry.context);
                                    ui.checkbox(
                                        &mut entry.reconstructed,
                                        tr(language, "재구형", "Reconstructed"),
                                    );
                                    egui::ComboBox::from_id_salt(("certainty", &module.id, index))
                                        .selected_text(certainty_label(language, &entry.certainty))
                                        .show_ui(ui, |ui| {
                                            for certainty in
                                                ["certain", "probable", "possible", "uncertain"]
                                            {
                                                ui.selectable_value(
                                                    &mut entry.certainty,
                                                    certainty.to_owned(),
                                                    certainty_label(language, certainty),
                                                );
                                            }
                                        });
                                });
                                ui.add_sized(
                                    [ui.available_width(), 42.0],
                                    egui::TextEdit::multiline(&mut entry.notes)
                                        .hint_text(tr(language, "설명", "Notes")),
                                );
                            });
                    }
                    if let Some(index) = remove {
                        module.entries.remove(index);
                    }
                    if ui
                        .button(tr(language, "+ 구조 항목", "+ Structure Entry"))
                        .clicked()
                    {
                        module.entries.push(LinguisticEntry {
                            certainty: default_certainty(),
                            ..Default::default()
                        });
                    }
                });
        }
    });
    structured_tables_editor(ui, dark, language, &mut system);
    save(profile, &system);
}

fn focused_tab(ui: &mut egui::Ui, key: &'static str, language: Language) -> usize {
    let id = ui.id().with(key);
    let mut selected = ui
        .data_mut(|data| data.get_temp::<usize>(id).unwrap_or(0))
        .min(2);
    ui.horizontal(|ui| {
        for (index, label) in [
            tr(language, "어순", "Word Order"),
            tr(language, "품사", "Parts of Speech"),
            tr(language, "문장성분", "Sentence Constituents"),
        ]
        .into_iter()
        .enumerate()
        {
            if ui
                .selectable_label(selected == index, RichText::new(label).strong())
                .clicked()
            {
                selected = index;
            }
        }
    });
    ui.data_mut(|data| data.insert_temp(id, selected));
    selected
}

fn focused_panel(
    ui: &mut egui::Ui,
    dark: bool,
    language: Language,
    focused: &LanguageFocusedStructure,
) {
    let colors = theme::palette(dark);
    theme::surface_frame(dark).show(ui, |ui| {
        let selected = focused_tab(ui, "focused-language-view", language);
        ui.separator();
        match selected {
            0 => {
                if !focused.word_order.dominant_order.is_empty() {
                    info_line(
                        ui,
                        tr(language, "주요 어순", "Dominant order"),
                        &focused.word_order.dominant_order,
                        colors,
                    );
                }
                if !focused.word_order.flexibility.is_empty() {
                    info_line(
                        ui,
                        tr(language, "고정성", "Rigidity / flexibility"),
                        &focused.word_order.flexibility,
                        colors,
                    );
                }
                if !focused.word_order.notes.is_empty() {
                    ui.label(&focused.word_order.notes);
                }
                for rule in focused.word_order.rules.iter().filter(|rule| {
                    !rule.dominant_order.trim().is_empty() || !rule.explanation.trim().is_empty()
                }) {
                    egui::CollapsingHeader::new(RichText::new(&rule.relation).strong()).show(
                        ui,
                        |ui| {
                            info_line(
                                ui,
                                tr(language, "우세 순서", "Dominant order"),
                                &rule.dominant_order,
                                colors,
                            );
                            info_line(
                                ui,
                                tr(language, "허용 대안", "Alternatives"),
                                &rule.alternatives,
                                colors,
                            );
                            info_line(
                                ui,
                                tr(language, "빈도·유표성", "Frequency / markedness"),
                                &rule.markedness,
                                colors,
                            );
                            info_line(
                                ui,
                                tr(language, "조건", "Conditions"),
                                &rule.conditions,
                                colors,
                            );
                            if !rule.explanation.is_empty() {
                                ui.label(&rule.explanation);
                            }
                            if !rule.examples.is_empty() {
                                ui.label(RichText::new(&rule.examples).color(colors.muted));
                            }
                        },
                    );
                }
            }
            1 => {
                for part in focused
                    .parts_of_speech
                    .iter()
                    .filter(|part| !part.name.trim().is_empty())
                {
                    egui::CollapsingHeader::new(
                        RichText::new(format!("{}  {}", part.name, part.abbreviation)).strong(),
                    )
                    .show(ui, |ui| {
                        info_line(ui, tr(language, "부류", "Class"), &part.class_type, colors);
                        info_line(
                            ui,
                            tr(language, "정의", "Definition"),
                            &part.definition,
                            colors,
                        );
                        info_line(
                            ui,
                            tr(language, "형태론", "Morphology"),
                            &part.morphology,
                            colors,
                        );
                        info_line(
                            ui,
                            tr(language, "굴절 범주", "Inflection"),
                            &part.inflection,
                            colors,
                        );
                        info_line(
                            ui,
                            tr(language, "통사 분포", "Syntactic distribution"),
                            &part.syntax,
                            colors,
                        );
                        info_line(
                            ui,
                            tr(language, "문장 기능", "Sentence functions"),
                            &part.functions,
                            colors,
                        );
                        info_line(
                            ui,
                            tr(language, "하위 유형", "Subtypes"),
                            &part.subtypes,
                            colors,
                        );
                        info_line(
                            ui,
                            tr(language, "판별 기준", "Diagnostics"),
                            &part.diagnostics,
                            colors,
                        );
                        info_line(
                            ui,
                            tr(language, "사전 연결", "Dictionary links"),
                            &part.dictionary_links,
                            colors,
                        );
                        if !part.examples.is_empty() {
                            ui.label(&part.examples);
                        }
                        if !part.notes.is_empty() {
                            ui.label(RichText::new(&part.notes).color(colors.muted));
                        }
                    });
                }
            }
            _ => {
                for constituent in focused
                    .constituents
                    .iter()
                    .filter(|entry| !entry.name.trim().is_empty())
                {
                    egui::CollapsingHeader::new(
                        RichText::new(format!(
                            "{}  {}",
                            constituent.name, constituent.abbreviation
                        ))
                        .strong(),
                    )
                    .show(ui, |ui| {
                        info_line(ui, tr(language, "역할", "Role"), &constituent.role, colors);
                        info_line(
                            ui,
                            tr(language, "실현 형식", "Realization"),
                            &constituent.realization,
                            colors,
                        );
                        info_line(
                            ui,
                            tr(language, "필수성", "Requirement"),
                            &constituent.requirement,
                            colors,
                        );
                        info_line(
                            ui,
                            tr(language, "표지", "Case / adposition marking"),
                            &constituent.marking,
                            colors,
                        );
                        info_line(
                            ui,
                            tr(language, "일치·통제", "Agreement / control"),
                            &constituent.agreement,
                            colors,
                        );
                        info_line(
                            ui,
                            tr(language, "생략 조건", "Omission"),
                            &constituent.omission,
                            colors,
                        );
                        info_line(
                            ui,
                            tr(language, "기본 위치", "Canonical position"),
                            &constituent.position,
                            colors,
                        );
                        info_line(
                            ui,
                            tr(language, "이동·어순 제약", "Movement / order constraints"),
                            &constituent.constraints,
                            colors,
                        );
                        if !constituent.examples.is_empty() {
                            ui.label(&constituent.examples);
                        }
                        if !constituent.notes.is_empty() {
                            ui.label(RichText::new(&constituent.notes).color(colors.muted));
                        }
                    });
                }
                if !focused.clause_patterns.is_empty() {
                    ui.separator();
                    ui.label(RichText::new(tr(language, "절 패턴", "Clause Patterns")).strong());
                    for pattern in &focused.clause_patterns {
                        ui.label(
                            RichText::new(format!(
                                "{}  {}",
                                pattern.name,
                                pattern.slots.join(" · ")
                            ))
                            .strong(),
                        );
                        if !pattern.source.is_empty() {
                            ui.label(&pattern.source);
                        }
                        if !pattern.gloss.is_empty() {
                            ui.label(RichText::new(&pattern.gloss).color(colors.accent));
                        }
                        if !pattern.translation.is_empty() {
                            ui.label(&pattern.translation);
                        }
                    }
                }
            }
        }
        if !focused.migration_notes.trim().is_empty() {
            ui.separator();
            ui.label(
                RichText::new(tr(
                    language,
                    "이전 구조에서 보존된 기록",
                    "Preserved migration notes",
                ))
                .strong(),
            );
            ui.label(&focused.migration_notes);
        }
    });
}

fn info_line(ui: &mut egui::Ui, label: &str, value: &str, colors: theme::Palette) {
    if value.trim().is_empty() {
        return;
    }
    ui.horizontal_wrapped(|ui| {
        ui.label(RichText::new(label).size(9.0).color(colors.muted));
        ui.label(value);
    });
}

fn focus_text(ui: &mut egui::Ui, label: &str, value: &mut String) {
    ui.label(RichText::new(label).size(9.0));
    ui.add_sized(
        [ui.available_width(), 26.0],
        egui::TextEdit::singleline(value),
    );
}

fn focus_multiline(ui: &mut egui::Ui, label: &str, value: &mut String) {
    ui.label(RichText::new(label).size(9.0));
    ui.add_sized(
        [ui.available_width(), 48.0],
        egui::TextEdit::multiline(value),
    );
}

fn row_controls(ui: &mut egui::Ui, index: usize, count: usize) -> Option<i32> {
    let mut action = None;
    if ui.add_enabled(index > 0, egui::Button::new("↑")).clicked() {
        action = Some(-1);
    }
    if ui
        .add_enabled(index + 1 < count, egui::Button::new("↓"))
        .clicked()
    {
        action = Some(1);
    }
    if ui.button("×").clicked() {
        action = Some(0);
    }
    action
}

fn apply_row_action<T>(rows: &mut Vec<T>, action: Option<(usize, i32)>) {
    let Some((index, direction)) = action else {
        return;
    };
    match direction {
        -1 if index > 0 => rows.swap(index, index - 1),
        1 if index + 1 < rows.len() => rows.swap(index, index + 1),
        0 if index < rows.len() => {
            rows.remove(index);
        }
        _ => {}
    }
}

fn focused_editor(
    ui: &mut egui::Ui,
    dark: bool,
    language: Language,
    focused: &mut LanguageFocusedStructure,
) {
    let colors = theme::palette(dark);
    theme::surface_frame(dark).show(ui, |ui| {
        let selected = focused_tab(ui, "focused-language-edit", language);
        ui.separator();
        match selected {
            0 => word_order_editor(ui, language, &mut focused.word_order),
            1 => parts_of_speech_editor(ui, language, &mut focused.parts_of_speech),
            _ => constituents_editor(
                ui,
                language,
                &mut focused.constituents,
                &mut focused.clause_patterns,
            ),
        }
        ui.separator();
        focus_multiline(
            ui,
            tr(
                language,
                "이전 구조에서 보존된 기록",
                "Preserved migration notes",
            ),
            &mut focused.migration_notes,
        );
        ui.label(
            RichText::new(tr(
                language,
                "언어학 구조는 아래의 별도 편집 영역에 보존됩니다.",
                "The broader Linguistic Structure remains in the editor below.",
            ))
            .size(8.5)
            .color(colors.muted),
        );
    });
}

fn word_order_editor(ui: &mut egui::Ui, language: Language, profile: &mut WordOrderProfile) {
    ui.horizontal(|ui| {
        ui.label(tr(
            language,
            "주요 타동절 어순",
            "Dominant transitive order",
        ));
        egui::ComboBox::from_id_salt("dominant-transitive-order")
            .selected_text(if profile.dominant_order.is_empty() {
                tr(language, "미지정", "Unspecified")
            } else {
                &profile.dominant_order
            })
            .show_ui(ui, |ui| {
                for value in [
                    "SOV",
                    "SVO",
                    "VSO",
                    "VOS",
                    "OVS",
                    "OSV",
                    "Two dominant orders",
                    "Flexible / no dominant order",
                ] {
                    ui.selectable_value(&mut profile.dominant_order, value.to_owned(), value);
                }
            });
    });
    focus_text(
        ui,
        tr(language, "고정성·유연성", "Rigidity / flexibility"),
        &mut profile.flexibility,
    );
    focus_multiline(
        ui,
        tr(language, "조건 및 설명", "Conditions and notes"),
        &mut profile.notes,
    );
    let mut action = None;
    let count = profile.rules.len();
    for (index, rule) in profile.rules.iter_mut().enumerate() {
        egui::CollapsingHeader::new(if rule.relation.is_empty() {
            tr(language, "새 어순 규칙", "New order rule")
        } else {
            &rule.relation
        })
        .show(ui, |ui| {
            ui.horizontal(|ui| {
                ui.add_sized(
                    [(ui.available_width() - 100.0).max(90.0), 26.0],
                    egui::TextEdit::singleline(&mut rule.relation),
                );
                if let Some(value) = row_controls(ui, index, count) {
                    action = Some((index, value));
                }
            });
            focus_text(
                ui,
                tr(language, "우세 순서", "Dominant order"),
                &mut rule.dominant_order,
            );
            focus_text(
                ui,
                tr(language, "허용 대안", "Alternatives"),
                &mut rule.alternatives,
            );
            focus_text(
                ui,
                tr(language, "빈도·유표성", "Frequency / markedness"),
                &mut rule.markedness,
            );
            focus_multiline(
                ui,
                tr(
                    language,
                    "문법·화용 조건",
                    "Grammatical / pragmatic conditions",
                ),
                &mut rule.conditions,
            );
            focus_multiline(
                ui,
                tr(language, "설명", "Explanation"),
                &mut rule.explanation,
            );
            focus_multiline(
                ui,
                tr(
                    language,
                    "예문·형태소 분석·번역",
                    "Source, gloss and translation",
                ),
                &mut rule.examples,
            );
        });
    }
    apply_row_action(&mut profile.rules, action);
    if ui
        .button(tr(language, "+ 어순 규칙", "+ Order Rule"))
        .clicked()
    {
        profile.rules.push(OrderRule::default());
    }
}

fn parts_of_speech_editor(
    ui: &mut egui::Ui,
    language: Language,
    rows: &mut Vec<PartOfSpeechProfile>,
) {
    let mut action = None;
    let count = rows.len();
    for (index, row) in rows.iter_mut().enumerate() {
        egui::CollapsingHeader::new(if row.name.is_empty() {
            tr(language, "새 품사", "New part of speech")
        } else {
            &row.name
        })
        .show(ui, |ui| {
            ui.horizontal(|ui| {
                ui.add_sized(
                    [(ui.available_width() - 190.0).max(80.0), 26.0],
                    egui::TextEdit::singleline(&mut row.name),
                );
                ui.add_sized(
                    [72.0, 26.0],
                    egui::TextEdit::singleline(&mut row.abbreviation),
                );
                if let Some(value) = row_controls(ui, index, count) {
                    action = Some((index, value));
                }
            });
            focus_text(
                ui,
                tr(
                    language,
                    "개방·폐쇄·기타 부류",
                    "Open / closed / other class",
                ),
                &mut row.class_type,
            );
            focus_multiline(ui, tr(language, "정의", "Definition"), &mut row.definition);
            focus_multiline(
                ui,
                tr(language, "형태적 행동", "Morphological behavior"),
                &mut row.morphology,
            );
            focus_text(
                ui,
                tr(language, "굴절 범주", "Inflectional categories"),
                &mut row.inflection,
            );
            focus_multiline(
                ui,
                tr(language, "통사 분포", "Syntactic distribution"),
                &mut row.syntax,
            );
            focus_text(
                ui,
                tr(language, "가능한 문장 기능", "Possible sentence functions"),
                &mut row.functions,
            );
            focus_text(ui, tr(language, "하위 유형", "Subtypes"), &mut row.subtypes);
            focus_multiline(
                ui,
                tr(language, "판별 기준", "Diagnostics"),
                &mut row.diagnostics,
            );
            focus_multiline(ui, tr(language, "예문", "Examples"), &mut row.examples);
            focus_text(
                ui,
                tr(language, "사전 항목 링크", "Dictionary entry links"),
                &mut row.dictionary_links,
            );
            focus_multiline(ui, tr(language, "비고", "Notes"), &mut row.notes);
        });
    }
    apply_row_action(rows, action);
    if ui
        .button(tr(language, "+ 품사", "+ Part of Speech"))
        .clicked()
    {
        rows.push(PartOfSpeechProfile::default());
    }
}

fn constituents_editor(
    ui: &mut egui::Ui,
    language: Language,
    rows: &mut Vec<ConstituentProfile>,
    patterns: &mut Vec<ClausePattern>,
) {
    let mut action = None;
    let count = rows.len();
    for (index, row) in rows.iter_mut().enumerate() {
        egui::CollapsingHeader::new(if row.name.is_empty() {
            tr(language, "새 문장성분", "New constituent")
        } else {
            &row.name
        })
        .show(ui, |ui| {
            ui.horizontal(|ui| {
                ui.add_sized(
                    [(ui.available_width() - 190.0).max(80.0), 26.0],
                    egui::TextEdit::singleline(&mut row.name),
                );
                ui.add_sized(
                    [72.0, 26.0],
                    egui::TextEdit::singleline(&mut row.abbreviation),
                );
                if let Some(value) = row_controls(ui, index, count) {
                    action = Some((index, value));
                }
            });
            for (label, value) in [
                (
                    tr(language, "통사·의미 역할", "Syntactic / semantic role"),
                    &mut row.role,
                ),
                (
                    tr(
                        language,
                        "실현 구·품사",
                        "Realizing phrase / part of speech",
                    ),
                    &mut row.realization,
                ),
                (
                    tr(language, "필수·선택", "Required / optional"),
                    &mut row.requirement,
                ),
                (
                    tr(language, "중복 가능성", "Multiplicity"),
                    &mut row.multiplicity,
                ),
                (
                    tr(language, "격·부치사 표지", "Case / adposition marking"),
                    &mut row.marking,
                ),
                (
                    tr(language, "일치·통제", "Agreement / control"),
                    &mut row.agreement,
                ),
                (
                    tr(language, "생략 조건", "Omission conditions"),
                    &mut row.omission,
                ),
                (
                    tr(language, "기본 위치", "Canonical position"),
                    &mut row.position,
                ),
                (
                    tr(language, "이동·어순 제약", "Movement / order constraints"),
                    &mut row.constraints,
                ),
                (
                    tr(language, "호환 서술어", "Compatible predicates"),
                    &mut row.predicates,
                ),
                (tr(language, "하위 유형", "Subtypes"), &mut row.subtypes),
            ] {
                focus_text(ui, label, value);
            }
            focus_multiline(ui, tr(language, "예문", "Examples"), &mut row.examples);
            focus_multiline(ui, tr(language, "비고", "Notes"), &mut row.notes);
        });
    }
    apply_row_action(rows, action);
    if ui
        .button(tr(language, "+ 문장성분", "+ Constituent"))
        .clicked()
    {
        rows.push(ConstituentProfile::default());
    }
    ui.separator();
    ui.label(RichText::new(tr(language, "절 패턴", "Clause Patterns")).strong());
    let mut remove = None;
    for (index, pattern) in patterns.iter_mut().enumerate() {
        egui::CollapsingHeader::new(if pattern.name.is_empty() {
            tr(language, "새 절 패턴", "New clause pattern")
        } else {
            &pattern.name
        })
        .show(ui, |ui| {
            focus_text(ui, tr(language, "이름", "Name"), &mut pattern.name);
            let mut slots = pattern.slots.join(" | ");
            focus_text(
                ui,
                tr(
                    language,
                    "성분 순서 (|로 구분)",
                    "Ordered slots (separate with |)",
                ),
                &mut slots,
            );
            pattern.slots = slots
                .split('|')
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
                .collect();
            focus_text(ui, tr(language, "원문", "Source"), &mut pattern.source);
            focus_text(ui, tr(language, "형태소 분석", "Gloss"), &mut pattern.gloss);
            focus_text(
                ui,
                tr(language, "번역", "Translation"),
                &mut pattern.translation,
            );
            focus_multiline(ui, tr(language, "비고", "Notes"), &mut pattern.notes);
            if ui.button("×").clicked() {
                remove = Some(index);
            }
        });
    }
    if let Some(index) = remove {
        patterns.remove(index);
    }
    if ui
        .button(tr(language, "+ 절 패턴", "+ Clause Pattern"))
        .clicked()
    {
        patterns.push(ClausePattern::default());
    }
}

fn structured_tables_editor(
    ui: &mut egui::Ui,
    dark: bool,
    language: Language,
    system: &mut LinguisticSystem,
) {
    let colors = theme::palette(dark);
    theme::surface_frame(dark).show(ui, |ui| {
        ui.label(
            RichText::new(tr(
                language,
                "비교·패러다임·예문",
                "Comparisons, Paradigms & Examples",
            ))
            .size(12.0)
            .strong()
            .color(colors.title),
        );
        let mut remove = None;
        for (index, row) in system.comparisons.iter_mut().enumerate() {
            ui.horizontal(|ui| {
                ui.text_edit_singleline(&mut row.concept);
                let mut forms = row.forms.join(" | ");
                if ui.text_edit_singleline(&mut forms).changed() {
                    row.forms = forms
                        .split('|')
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(str::to_owned)
                        .collect();
                }
                ui.text_edit_singleline(&mut row.correspondence);
                if ui.small_button("×").clicked() {
                    remove = Some(index);
                }
            });
        }
        if let Some(index) = remove {
            system.comparisons.remove(index);
        }
        if ui
            .button(tr(language, "+ 비교 행", "+ Comparison Row"))
            .clicked()
        {
            system.comparisons.push(ComparisonRow {
                certainty: default_certainty(),
                ..Default::default()
            });
        }
        ui.separator();
        let mut remove_example = None;
        for (index, example) in system.examples.iter_mut().enumerate() {
            ui.horizontal(|ui| {
                ui.text_edit_singleline(&mut example.original);
                ui.text_edit_singleline(&mut example.transliteration);
                if ui.small_button("×").clicked() {
                    remove_example = Some(index);
                }
            });
            ui.horizontal(|ui| {
                ui.text_edit_singleline(&mut example.gloss);
                ui.text_edit_singleline(&mut example.translation);
            });
        }
        if let Some(index) = remove_example {
            system.examples.remove(index);
        }
        if ui
            .button(tr(
                language,
                "+ 표기·문장 예시",
                "+ Writing / Sentence Example",
            ))
            .clicked()
        {
            system.examples.push(LinguisticExample::default());
        }
        ui.separator();
        if ui
            .button(tr(language, "+ 굴절·활용표", "+ Paradigm"))
            .clicked()
        {
            system.paradigms.push(Paradigm {
                title: tr(language, "새 패러다임", "New Paradigm").to_owned(),
                columns: vec![tr(language, "형태", "Form").to_owned()],
                rows: vec![vec![String::new()]],
            });
        }
        for paradigm in &mut system.paradigms {
            ui.text_edit_singleline(&mut paradigm.title);
            for row in &mut paradigm.rows {
                ui.horizontal(|ui| {
                    for cell in row {
                        ui.text_edit_singleline(cell);
                    }
                });
            }
        }
    });
}

fn comparison_panel(ui: &mut egui::Ui, dark: bool, language: Language, rows: &[ComparisonRow]) {
    let colors = theme::palette(dark);
    theme::surface_frame(dark).show(ui, |ui| {
        ui.label(
            RichText::new(tr(language, "비교 자료", "Comparative Data"))
                .size(12.0)
                .strong()
                .color(colors.title),
        );
        egui::Grid::new("linguistic-comparison")
            .striped(true)
            .show(ui, |ui| {
                for row in rows {
                    ui.label(&row.concept);
                    ui.label(row.forms.join(" · "));
                    ui.label(&row.correspondence);
                    ui.end_row();
                }
            });
    });
}

fn paradigm_panel(ui: &mut egui::Ui, dark: bool, language: Language, paradigms: &[Paradigm]) {
    let colors = theme::palette(dark);
    theme::surface_frame(dark).show(ui, |ui| {
        ui.label(
            RichText::new(tr(language, "굴절·활용표", "Paradigms"))
                .size(12.0)
                .strong()
                .color(colors.title),
        );
        for paradigm in paradigms {
            ui.label(RichText::new(&paradigm.title).strong());
            for row in &paradigm.rows {
                ui.horizontal(|ui| {
                    for cell in row {
                        ui.label(cell);
                    }
                });
            }
        }
    });
}

fn examples_panel(
    ui: &mut egui::Ui,
    dark: bool,
    language: Language,
    examples: &[LinguisticExample],
) {
    let colors = theme::palette(dark);
    theme::surface_frame(dark).show(ui, |ui| {
        ui.label(
            RichText::new(tr(
                language,
                "표기·문장 예시",
                "Writing & Sentence Examples",
            ))
            .size(12.0)
            .strong()
            .color(colors.title),
        );
        for example in examples {
            ui.label(RichText::new(&example.original).strong());
            if !example.transliteration.is_empty() {
                ui.label(RichText::new(&example.transliteration).color(colors.accent));
            }
            if !example.gloss.is_empty() {
                ui.label(RichText::new(&example.gloss).color(colors.muted));
            }
            if !example.translation.is_empty() {
                ui.label(&example.translation);
            }
            ui.separator();
        }
    });
}

fn certainty_label<'a>(language: Language, certainty: &'a str) -> &'a str {
    match (language, certainty) {
        (Language::Korean, "certain") => "확실",
        (Language::Korean, "probable") => "유력",
        (Language::Korean, "possible") => "가능",
        (Language::Korean, "uncertain") => "불확실",
        (Language::English, "certain") => "Certain",
        (Language::English, "probable") => "Probable",
        (Language::English, "possible") => "Possible",
        (Language::English, "uncertain") => "Uncertain",
        _ => certainty,
    }
}

fn structure_title(language: Language, category: &str, editing: bool) -> &'static str {
    match (language, category == "writing_system", editing) {
        (Language::Korean, true, false) => "문자 구조",
        (Language::English, true, false) => "Writing System Structure",
        (Language::Korean, true, true) => "문자 구조 편집",
        (Language::English, true, true) => "Edit Writing System Structure",
        (Language::Korean, false, false) => "언어학 구조",
        (Language::English, false, false) => "Linguistic Structure",
        (Language::Korean, false, true) => "언어학 구조 편집",
        (Language::English, false, true) => "Edit Linguistic Structure",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_language_document_kind_receives_distinct_modules() {
        for category in [
            "language_family",
            "language_branch",
            "language_group",
            "language",
            "dialect",
            "writing_system",
        ] {
            let system = load(None, category, Language::Korean);
            assert!(!system.modules.is_empty(), "{category}");
        }
        assert!(
            load(None, "writing_system", Language::English)
                .modules
                .iter()
                .any(|module| module.id == "graphemes")
        );
        assert!(
            load(None, "dialect", Language::English)
                .modules
                .iter()
                .any(|module| module.id == "inheritance")
        );
    }

    #[test]
    fn legacy_flat_fields_are_migrated_without_data_loss() {
        let profile = serde_json::json!({ "phonology": "legacy phonology" });
        let system = load(Some(&profile), "language", Language::English);
        assert_eq!(
            system
                .modules
                .iter()
                .find(|module| module.id == "phonology")
                .unwrap()
                .overview,
            "legacy phonology"
        );
    }

    #[test]
    fn language_documents_seed_focused_grammar_without_removing_broader_structure() {
        let system = load(None, "language", Language::Korean);
        assert_eq!(system.schema_version, 2);
        assert!(
            system
                .focused
                .word_order
                .rules
                .iter()
                .any(|rule| rule.relation == "타동절 핵심 어순")
        );
        assert!(
            system
                .focused
                .parts_of_speech
                .iter()
                .any(|part| part.abbreviation == "N")
        );
        assert!(
            system
                .focused
                .constituents
                .iter()
                .any(|entry| entry.name == "서술어")
        );
        assert!(system.modules.iter().any(|module| module.id == "phonology"));
    }

    #[test]
    fn legacy_syntax_overview_moves_once_into_word_order_notes() {
        let legacy = serde_json::json!({
            "linguistics": {
                "schemaVersion": 1,
                "modules": [{ "id": "syntax", "title": "통사론", "enabled": true, "overview": "SOV가 우세하다.", "entries": [] }]
            }
        });
        let system = load(Some(&legacy), "language", Language::Korean);
        assert_eq!(system.focused.word_order.notes, "SOV가 우세하다.");
        assert_eq!(
            system
                .modules
                .iter()
                .find(|module| module.id == "syntax")
                .unwrap()
                .overview,
            ""
        );
    }
}
