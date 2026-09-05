use eframe::egui::{
    self, Color32, CornerRadius, FontFamily, FontId, Margin, RichText, Stroke, TextFormat, Vec2,
    text::LayoutJob,
};

use crate::{
    model::{DictionaryVoiceProfile, Language},
    speech::ImsToucanState,
    theme,
};

#[derive(Clone, Copy)]
pub struct IpaSymbol {
    pub symbol: &'static str,
    pub group: &'static str,
    pub korean: &'static str,
    pub english: &'static str,
    pub detail_ko: &'static str,
    pub detail_en: &'static str,
    pub synthesis_supported: bool,
}

#[derive(Default)]
pub struct IpaUiState {
    pub open: bool,
    pub tab: usize,
    pub composition: String,
    pub active_target: Option<String>,
    pub caret: usize,
    pub recent: Vec<String>,
}

impl IpaUiState {
    pub fn focus(&mut self, target: impl Into<String>, caret: usize) {
        self.active_target = Some(target.into());
        self.caret = caret;
    }

    pub fn clear_focus(&mut self) {
        self.active_target = None;
    }
}

pub fn normalize(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    for character in value.chars() {
        if character == '\u{0303}' {
            if let Some(previous) = output.pop() {
                if let Some(composed) = compose_tilde(previous) {
                    output.push(composed);
                    continue;
                }
                output.push(previous);
            }
        }
        output.push(character);
    }
    output
}

pub fn unsupported_symbols(value: &str) -> Vec<String> {
    let normalized = normalize(value);
    let mut unsupported = Vec::new();
    for character in normalized.chars() {
        if character.is_whitespace()
            || matches!(character, '/' | '[' | ']' | '(' | ')' | '.' | '-' | '‿')
            || all_symbols()
                .iter()
                .any(|symbol| symbol.symbol.chars().any(|item| item == character))
        {
            continue;
        }
        let symbol = character.to_string();
        if !unsupported.contains(&symbol) {
            unsupported.push(symbol);
        }
    }
    unsupported
}

pub fn insert_at_char(value: &mut String, caret: usize, symbol: &str) -> usize {
    let mut chars = value.chars().collect::<Vec<_>>();
    let index = caret.min(chars.len());
    chars.splice(index..index, symbol.chars());
    *value = normalize(&chars.into_iter().collect::<String>());
    index + symbol.chars().count()
}

fn compose_tilde(value: char) -> Option<char> {
    Some(match value {
        'a' => 'ã',
        'A' => 'Ã',
        'e' => 'ẽ',
        'E' => 'Ẽ',
        'i' => 'ĩ',
        'I' => 'Ĩ',
        'n' => 'ñ',
        'N' => 'Ñ',
        'o' => 'õ',
        'O' => 'Õ',
        'u' => 'ũ',
        'U' => 'Ũ',
        _ => return None,
    })
}

pub fn modal(
    context: &egui::Context,
    dark: bool,
    language: Language,
    state: &mut IpaUiState,
    speech: &mut ImsToucanState,
    voice_profile: &DictionaryVoiceProfile,
) -> Option<String> {
    if !state.open {
        return None;
    }
    let colors = theme::palette(dark);
    let screen = context.content_rect();
    let modal_size = Vec2::new(
        (screen.width() - 72.0).min(980.0),
        (screen.height() - 72.0).min(720.0),
    );
    let modal_rect = egui::Rect::from_center_size(screen.center(), modal_size);
    let mut clicked_symbol = None;
    let mut apply_composition = false;
    egui::Area::new("ipa-reference-modal".into())
        .order(egui::Order::Foreground)
        .fixed_pos(screen.min)
        .show(context, |ui| {
            ui.set_min_size(screen.size());
            let backdrop = ui.allocate_rect(screen, egui::Sense::click());
            ui.painter().rect_filled(screen, 0.0, Color32::from_black_alpha(176));
            if backdrop.clicked() {
                state.open = false;
            }
            ui.scope_builder(egui::UiBuilder::new().max_rect(modal_rect), |ui| {
                egui::Frame::new()
                    .fill(colors.panel_alt)
                    .stroke(Stroke::new(1.0, colors.border))
                    .corner_radius(CornerRadius::same(7))
                    .inner_margin(Margin::same(18))
                    .show(ui, |ui| {
                        ui.set_min_size(modal_size - Vec2::splat(36.0));
                        ui.horizontal(|ui| {
                            ui.label(RichText::new(tr(language, "IPA 조합", "IPA Composer")).size(20.0).strong().color(colors.title));
                            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                                if ui.add_sized([32.0, 32.0], egui::Button::new("×")).clicked() {
                                    state.open = false;
                                }
                            });
                        });
                        ui.label(
                            RichText::new(if state.active_target.is_some() {
                                tr(language, "기호를 조합한 뒤 적용하면 선택한 IPA 발음 칸에 삽입됩니다.", "Compose symbols, then apply them to the active IPA pronunciation field.")
                            } else {
                                tr(language, "기호를 눌러 조합 버퍼에서 발음을 구성할 수 있습니다.", "Select symbols to build a pronunciation in the composition buffer.")
                            })
                            .size(9.5)
                            .color(colors.muted),
                        );
                        ui.add_space(6.0);
                        let tabs = [
                            ("pulmonic", tr(language, "폐기류 자음", "Pulmonic")),
                            ("other", tr(language, "기타 자음", "Other Consonants")),
                            ("vowels", tr(language, "모음", "Vowels")),
                            ("suprasegmental", tr(language, "초분절·성조", "Suprasegmentals")),
                            ("diacritic", tr(language, "발음 구별 기호", "Diacritics")),
                        ];
                        ui.horizontal_wrapped(|ui| {
                            for (index, (_, label)) in tabs.iter().enumerate() {
                                if ui.add(egui::Button::selectable(state.tab == index, *label)).clicked() {
                                    state.tab = index;
                                }
                            }
                        });
                        ui.separator();
                        egui::ScrollArea::vertical()
                            .id_salt("ipa-symbol-scroll")
                            .show(ui, |ui| {
                                let group = tabs[state.tab].0;
                                ui.horizontal_wrapped(|ui| {
                                    for symbol in all_symbols().iter().filter(|symbol| symbol.group == group) {
                                        let button = ui.add_sized(
                                            [82.0, 72.0],
                                            egui::Button::new(ipa_tile_text(symbol, colors)),
                                        );
                                        let unicode = symbol.symbol.chars().map(|value| format!("U+{:04X}", value as u32)).collect::<Vec<_>>().join(" ");
                                        let detail = if language == Language::Korean {
                                            format!("{}\n{}\n{}", symbol.korean, symbol.detail_ko, unicode)
                                        } else {
                                            format!("{}\n{}\n{}", symbol.english, symbol.detail_en, unicode)
                                        };
                                        let button = button.on_hover_text(if symbol.synthesis_supported {
                                            detail
                                        } else {
                                            format!("{}\n{}", detail, tr(language, "선택된 IMS-Toucan 모델에서 미지원", "Unsupported by selected IMS-Toucan model"))
                                        });
                                        if button.clicked() {
                                            clicked_symbol = Some(symbol.symbol.to_owned());
                                        }
                                    }
                                });
                            });
                        ui.separator();
                        ui.horizontal(|ui| {
                            ui.label(RichText::new(tr(language, "조합 버퍼", "Composition")).size(9.5).color(colors.muted));
                            ui.add_sized([ui.available_width() - 150.0, 30.0], egui::TextEdit::singleline(&mut state.composition));
                            let playing = speech.is_playing(&state.composition, voice_profile);
                            if ui.add_enabled(
                                !state.composition.trim().is_empty(),
                                egui::Button::new(if playing { "■" } else { "▶" }),
                            ).on_hover_text(if playing {
                                tr(language, "발음 중지", "Stop pronunciation")
                            } else {
                                tr(language, "조합한 IPA 발음 듣기", "Play composed IPA")
                            }).clicked() {
                                let _ = speech.request(language, &state.composition, voice_profile);
                            }
                            if ui.add_enabled(
                                !state.composition.is_empty(),
                                egui::Button::new(tr(language, "지우기", "Clear")),
                            ).clicked() {
                                state.composition.clear();
                            }
                            if ui.add_enabled(
                                state.active_target.is_some() && !state.composition.is_empty(),
                                egui::Button::new(tr(language, "적용", "Apply")),
                            ).clicked() {
                                apply_composition = true;
                            }
                        });
                        if !state.recent.is_empty() {
                            ui.horizontal(|ui| {
                                ui.label(RichText::new(tr(language, "최근", "Recent")).size(9.0).color(colors.muted));
                                for symbol in state.recent.clone() {
                                    if ui.small_button(&symbol).clicked() { clicked_symbol = Some(symbol); }
                                }
                            });
                        }
                    });
            });
        });
    if let Some(symbol) = &clicked_symbol {
        state.recent.retain(|value| value != symbol);
        state.recent.insert(0, symbol.clone());
        state.recent.truncate(12);
        let caret = state.composition.chars().count();
        insert_at_char(&mut state.composition, caret, symbol);
    }
    if apply_composition {
        let composition = std::mem::take(&mut state.composition);
        state.open = false;
        Some(composition)
    } else {
        None
    }
}

fn ipa_tile_text(symbol: &IpaSymbol, colors: theme::Palette) -> LayoutJob {
    let (example, highlighted) = ipa_example(symbol.symbol);
    let mut job = LayoutJob {
        halign: egui::Align::Center,
        ..LayoutJob::default()
    };
    job.append(
        symbol.symbol,
        0.0,
        TextFormat {
            font_id: FontId::new(27.0, FontFamily::Proportional),
            color: if symbol.synthesis_supported {
                colors.title
            } else {
                colors.danger
            },
            ..TextFormat::default()
        },
    );
    job.append(
        "\n",
        0.0,
        TextFormat {
            font_id: FontId::new(7.5, FontFamily::Proportional),
            color: colors.muted,
            ..TextFormat::default()
        },
    );
    let start = highlighted.start.min(example.len());
    let end = highlighted.end.min(example.len()).max(start);
    for (text, emphasized) in [
        (&example[..start], false),
        (&example[start..end], true),
        (&example[end..], false),
    ] {
        job.append(
            text,
            0.0,
            TextFormat {
                font_id: FontId::new(12.0, FontFamily::Proportional),
                color: if emphasized {
                    colors.accent
                } else {
                    colors.muted
                },
                ..TextFormat::default()
            },
        );
    }
    job
}

fn ipa_example(symbol: &str) -> (String, std::ops::Range<usize>) {
    let (word, start, length) = match symbol {
        "p" => ("spin", 1, 1),
        "b" => ("bat", 0, 1),
        "t" => ("stop", 1, 1),
        "d" => ("dog", 0, 1),
        "k" => ("skin", 1, 1),
        "g" => ("go", 0, 1),
        "f" => ("fine", 0, 1),
        "v" => ("vine", 0, 1),
        "s" => ("see", 0, 1),
        "z" => ("zoo", 0, 1),
        "h" => ("hat", 0, 1),
        "m" => ("man", 0, 1),
        "n" => ("no", 0, 1),
        "l" => ("low", 0, 1),
        "r" => ("red", 0, 1),
        "w" => ("we", 0, 1),
        "j" => ("yes", 0, 1),
        "i" => ("fleece", 2, 2),
        "ɪ" => ("kit", 1, 1),
        "e" => ("cafe", 3, 1),
        "ɛ" => ("dress", 2, 1),
        "æ" => ("apple", 0, 1),
        "ɑ" => ("father", 1, 1),
        "ɒ" => ("lot", 1, 1),
        "ɔ" => ("thought", 2, 3),
        "ʊ" => ("foot", 1, 2),
        "u" => ("goose", 1, 2),
        "ʌ" => ("strut", 3, 1),
        "ə" => ("about", 0, 1),
        "ɜ" => ("nurse", 1, 2),
        "θ" => ("thin", 0, 2),
        "ð" => ("this", 0, 2),
        "ʃ" => ("ship", 0, 2),
        "ʒ" => ("vision", 2, 2),
        "tʃ" => ("church", 0, 2),
        "dʒ" => ("judge", 0, 1),
        "ŋ" => ("sing", 2, 2),
        _ => return (symbol.to_owned(), 0..symbol.len()),
    };
    (word.to_owned(), start..start + length)
}

pub fn all_symbols() -> &'static [IpaSymbol] {
    &SYMBOLS
}

const SYMBOLS: [IpaSymbol; 75] = [
    ipa(
        "p",
        "pulmonic",
        "무성 양순 파열음",
        "Voiceless bilabial plosive",
        "입술·파열",
        "bilabial plosive",
        true,
    ),
    ipa(
        "b",
        "pulmonic",
        "유성 양순 파열음",
        "Voiced bilabial plosive",
        "입술·파열",
        "bilabial plosive",
        true,
    ),
    ipa(
        "t",
        "pulmonic",
        "무성 치경 파열음",
        "Voiceless alveolar plosive",
        "치경·파열",
        "alveolar plosive",
        true,
    ),
    ipa(
        "d",
        "pulmonic",
        "유성 치경 파열음",
        "Voiced alveolar plosive",
        "치경·파열",
        "alveolar plosive",
        true,
    ),
    ipa(
        "ʈ",
        "pulmonic",
        "무성 권설 파열음",
        "Voiceless retroflex plosive",
        "권설·파열",
        "retroflex plosive",
        false,
    ),
    ipa(
        "ɖ",
        "pulmonic",
        "유성 권설 파열음",
        "Voiced retroflex plosive",
        "권설·파열",
        "retroflex plosive",
        false,
    ),
    ipa(
        "c",
        "pulmonic",
        "무성 경구개 파열음",
        "Voiceless palatal plosive",
        "경구개·파열",
        "palatal plosive",
        true,
    ),
    ipa(
        "ɟ",
        "pulmonic",
        "유성 경구개 파열음",
        "Voiced palatal plosive",
        "경구개·파열",
        "palatal plosive",
        false,
    ),
    ipa(
        "k",
        "pulmonic",
        "무성 연구개 파열음",
        "Voiceless velar plosive",
        "연구개·파열",
        "velar plosive",
        true,
    ),
    ipa(
        "g",
        "pulmonic",
        "유성 연구개 파열음",
        "Voiced velar plosive",
        "연구개·파열",
        "velar plosive",
        true,
    ),
    ipa(
        "q",
        "pulmonic",
        "무성 구개수 파열음",
        "Voiceless uvular plosive",
        "구개수·파열",
        "uvular plosive",
        false,
    ),
    ipa(
        "ʔ",
        "pulmonic",
        "성문 파열음",
        "Glottal stop",
        "성문·파열",
        "glottal stop",
        true,
    ),
    ipa(
        "m",
        "pulmonic",
        "양순 비음",
        "Bilabial nasal",
        "입술·비음",
        "bilabial nasal",
        true,
    ),
    ipa(
        "n",
        "pulmonic",
        "치경 비음",
        "Alveolar nasal",
        "치경·비음",
        "alveolar nasal",
        true,
    ),
    ipa(
        "ɲ",
        "pulmonic",
        "경구개 비음",
        "Palatal nasal",
        "경구개·비음",
        "palatal nasal",
        true,
    ),
    ipa(
        "ŋ",
        "pulmonic",
        "연구개 비음",
        "Velar nasal",
        "연구개·비음",
        "velar nasal",
        true,
    ),
    ipa(
        "f",
        "pulmonic",
        "무성 순치 마찰음",
        "Voiceless labiodental fricative",
        "순치·마찰",
        "labiodental fricative",
        true,
    ),
    ipa(
        "v",
        "pulmonic",
        "유성 순치 마찰음",
        "Voiced labiodental fricative",
        "순치·마찰",
        "labiodental fricative",
        true,
    ),
    ipa(
        "θ",
        "pulmonic",
        "무성 치 마찰음",
        "Voiceless dental fricative",
        "치·마찰",
        "dental fricative",
        true,
    ),
    ipa(
        "ð",
        "pulmonic",
        "유성 치 마찰음",
        "Voiced dental fricative",
        "치·마찰",
        "dental fricative",
        true,
    ),
    ipa(
        "s",
        "pulmonic",
        "무성 치경 마찰음",
        "Voiceless alveolar fricative",
        "치경·마찰",
        "alveolar fricative",
        true,
    ),
    ipa(
        "z",
        "pulmonic",
        "유성 치경 마찰음",
        "Voiced alveolar fricative",
        "치경·마찰",
        "alveolar fricative",
        true,
    ),
    ipa(
        "ʃ",
        "pulmonic",
        "무성 후치경 마찰음",
        "Voiceless postalveolar fricative",
        "후치경·마찰",
        "postalveolar fricative",
        true,
    ),
    ipa(
        "ʒ",
        "pulmonic",
        "유성 후치경 마찰음",
        "Voiced postalveolar fricative",
        "후치경·마찰",
        "postalveolar fricative",
        true,
    ),
    ipa(
        "ç",
        "pulmonic",
        "무성 경구개 마찰음",
        "Voiceless palatal fricative",
        "경구개·마찰",
        "palatal fricative",
        false,
    ),
    ipa(
        "x",
        "pulmonic",
        "무성 연구개 마찰음",
        "Voiceless velar fricative",
        "연구개·마찰",
        "velar fricative",
        true,
    ),
    ipa(
        "ɣ",
        "pulmonic",
        "유성 연구개 마찰음",
        "Voiced velar fricative",
        "연구개·마찰",
        "velar fricative",
        false,
    ),
    ipa(
        "h",
        "pulmonic",
        "무성 성문 마찰음",
        "Voiceless glottal fricative",
        "성문·마찰",
        "glottal fricative",
        true,
    ),
    ipa(
        "l",
        "pulmonic",
        "치경 설측 접근음",
        "Alveolar lateral approximant",
        "치경·설측",
        "alveolar lateral",
        true,
    ),
    ipa(
        "r",
        "pulmonic",
        "치경 전동음",
        "Alveolar trill",
        "치경·전동",
        "alveolar trill",
        true,
    ),
    ipa(
        "ɾ",
        "pulmonic",
        "치경 탄음",
        "Alveolar tap",
        "치경·탄음",
        "alveolar tap",
        true,
    ),
    ipa(
        "j",
        "pulmonic",
        "경구개 접근음",
        "Palatal approximant",
        "경구개·접근",
        "palatal approximant",
        true,
    ),
    ipa(
        "w",
        "pulmonic",
        "양순 연구개 접근음",
        "Labial-velar approximant",
        "동시 조음",
        "co-articulated approximant",
        true,
    ),
    ipa(
        "i",
        "vowels",
        "전설 고모음",
        "Close front unrounded vowel",
        "고·전설·평순",
        "close front unrounded",
        true,
    ),
    ipa(
        "y",
        "vowels",
        "전설 원순 고모음",
        "Close front rounded vowel",
        "고·전설·원순",
        "close front rounded",
        true,
    ),
    ipa(
        "ɨ",
        "vowels",
        "중설 평순 고모음",
        "Close central unrounded vowel",
        "고·중설·평순",
        "close central unrounded",
        true,
    ),
    ipa(
        "u",
        "vowels",
        "후설 원순 고모음",
        "Close back rounded vowel",
        "고·후설·원순",
        "close back rounded",
        true,
    ),
    ipa(
        "ɪ",
        "vowels",
        "근전설 근고모음",
        "Near-close near-front vowel",
        "근고·근전설",
        "near-close near-front",
        true,
    ),
    ipa(
        "ʊ",
        "vowels",
        "근후설 근고모음",
        "Near-close near-back vowel",
        "근고·근후설",
        "near-close near-back",
        true,
    ),
    ipa(
        "e",
        "vowels",
        "전설 중고모음",
        "Close-mid front vowel",
        "중고·전설",
        "close-mid front",
        true,
    ),
    ipa(
        "ø",
        "vowels",
        "전설 원순 중고모음",
        "Close-mid front rounded vowel",
        "중고·전설·원순",
        "close-mid front rounded",
        false,
    ),
    ipa(
        "ə",
        "vowels",
        "중설 중모음",
        "Mid central vowel",
        "중·중설",
        "mid central",
        true,
    ),
    ipa(
        "o",
        "vowels",
        "후설 원순 중고모음",
        "Close-mid back rounded vowel",
        "중고·후설·원순",
        "close-mid back rounded",
        true,
    ),
    ipa(
        "ɛ",
        "vowels",
        "전설 중저모음",
        "Open-mid front vowel",
        "중저·전설",
        "open-mid front",
        true,
    ),
    ipa(
        "ʌ",
        "vowels",
        "후설 평순 중저모음",
        "Open-mid back unrounded vowel",
        "중저·후설",
        "open-mid back unrounded",
        true,
    ),
    ipa(
        "ɔ",
        "vowels",
        "후설 원순 중저모음",
        "Open-mid back rounded vowel",
        "중저·후설·원순",
        "open-mid back rounded",
        true,
    ),
    ipa(
        "æ",
        "vowels",
        "근전설 근저모음",
        "Near-open front vowel",
        "근저·전설",
        "near-open front",
        true,
    ),
    ipa(
        "a",
        "vowels",
        "전설 평순 저모음",
        "Open front unrounded vowel",
        "저·전설",
        "open front unrounded",
        true,
    ),
    ipa(
        "ɑ",
        "vowels",
        "후설 평순 저모음",
        "Open back unrounded vowel",
        "저·후설",
        "open back unrounded",
        true,
    ),
    ipa(
        "ɓ",
        "other",
        "유성 양순 내파음",
        "Voiced bilabial implosive",
        "내파음",
        "implosive",
        false,
    ),
    ipa(
        "ɗ",
        "other",
        "유성 치경 내파음",
        "Voiced alveolar implosive",
        "내파음",
        "implosive",
        false,
    ),
    ipa(
        "ǀ",
        "other",
        "치 흡착음",
        "Dental click",
        "흡착음",
        "click",
        false,
    ),
    ipa(
        "ǃ",
        "other",
        "후치경 흡착음",
        "Postalveolar click",
        "흡착음",
        "click",
        false,
    ),
    ipa(
        "t͡s",
        "other",
        "치경 파찰음",
        "Alveolar affricate",
        "파열+마찰",
        "affricate",
        true,
    ),
    ipa(
        "t͡ʃ",
        "other",
        "후치경 파찰음",
        "Postalveolar affricate",
        "파열+마찰",
        "affricate",
        true,
    ),
    ipa(
        "d͡ʒ",
        "other",
        "유성 후치경 파찰음",
        "Voiced postalveolar affricate",
        "파열+마찰",
        "affricate",
        true,
    ),
    ipa(
        "ɥ",
        "other",
        "양순 경구개 접근음",
        "Labial-palatal approximant",
        "동시 조음",
        "co-articulated",
        false,
    ),
    ipa(
        "ɫ",
        "other",
        "연구개화 설측 접근음",
        "Velarized lateral approximant",
        "이차 조음",
        "secondary articulation",
        true,
    ),
    ipa(
        "ˈ",
        "suprasegmental",
        "제1강세",
        "Primary stress",
        "다음 음절에 주강세",
        "primary stress",
        true,
    ),
    ipa(
        "ˌ",
        "suprasegmental",
        "제2강세",
        "Secondary stress",
        "다음 음절에 부강세",
        "secondary stress",
        true,
    ),
    ipa(
        "ː",
        "suprasegmental",
        "장음",
        "Long",
        "앞 분절을 길게",
        "length mark",
        true,
    ),
    ipa(
        "ˑ",
        "suprasegmental",
        "반장음",
        "Half-long",
        "앞 분절을 다소 길게",
        "half length",
        false,
    ),
    ipa(
        ".",
        "suprasegmental",
        "음절 경계",
        "Syllable break",
        "음절 구분",
        "syllable boundary",
        true,
    ),
    ipa(
        "↗",
        "suprasegmental",
        "전체 상승",
        "Global rise",
        "상승 억양",
        "global rise",
        false,
    ),
    ipa(
        "↘",
        "suprasegmental",
        "전체 하강",
        "Global fall",
        "하강 억양",
        "global fall",
        false,
    ),
    ipa(
        "˥",
        "suprasegmental",
        "초고 성조",
        "Extra-high tone",
        "5단계 성조",
        "tone level 5",
        true,
    ),
    ipa(
        "˧",
        "suprasegmental",
        "중간 성조",
        "Mid tone",
        "5단계 성조",
        "tone level 3",
        true,
    ),
    ipa(
        "˩",
        "suprasegmental",
        "초저 성조",
        "Extra-low tone",
        "5단계 성조",
        "tone level 1",
        true,
    ),
    ipa(
        "̥",
        "diacritic",
        "무성음화",
        "Voiceless",
        "결합 부호",
        "combining diacritic",
        true,
    ),
    ipa(
        "̬",
        "diacritic",
        "유성음화",
        "Voiced",
        "결합 부호",
        "combining diacritic",
        false,
    ),
    ipa(
        "ʰ",
        "diacritic",
        "유기음",
        "Aspirated",
        "기식 방출",
        "aspiration",
        true,
    ),
    ipa(
        "ʷ",
        "diacritic",
        "원순화",
        "Labialized",
        "이차 조음",
        "secondary articulation",
        false,
    ),
    ipa(
        "ʲ",
        "diacritic",
        "경구개화",
        "Palatalized",
        "이차 조음",
        "secondary articulation",
        false,
    ),
    ipa(
        "̃",
        "diacritic",
        "비음화",
        "Nasalized",
        "결합 부호",
        "combining diacritic",
        true,
    ),
    ipa(
        "̩",
        "diacritic",
        "음절 자음",
        "Syllabic",
        "결합 부호",
        "combining diacritic",
        false,
    ),
];

const fn ipa(
    symbol: &'static str,
    group: &'static str,
    korean: &'static str,
    english: &'static str,
    detail_ko: &'static str,
    detail_en: &'static str,
    synthesis_supported: bool,
) -> IpaSymbol {
    IpaSymbol {
        symbol,
        group,
        korean,
        english,
        detail_ko,
        detail_en,
        synthesis_supported,
    }
}

fn tr<'a>(language: Language, korean: &'a str, english: &'a str) -> &'a str {
    match language {
        Language::Korean => korean,
        Language::English => english,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalization_composes_combining_marks() {
        assert_eq!(normalize("a\u{303}"), "ã");
    }

    #[test]
    fn inserts_without_replacing_surrounding_ipa() {
        let mut value = "pat".to_owned();
        let caret = insert_at_char(&mut value, 1, "ʰ");
        assert_eq!(value, "pʰat");
        assert_eq!(caret, 2);
    }

    #[test]
    fn unsupported_symbols_are_reported_once() {
        assert_eq!(unsupported_symbols("pa★★"), vec!["★"]);
    }
}
