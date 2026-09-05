use std::time::{SystemTime, UNIX_EPOCH};

use eframe::egui::{
    self, Align, Color32, CornerRadius, Margin, Pos2, Rect, RichText, Sense, Stroke, Vec2,
};

use crate::{
    ipa::{self, IpaUiState},
    model::{
        CharacterChart, CharacterChartAxis, CharacterChartCell, CharacterFolder,
        CharacterGlyphSlot, DictionaryVoiceProfile, GeneratedGlyph, Language,
    },
    speech::ImsToucanState,
    theme,
};

pub const CANVAS_SIZE: usize = 128;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DrawTool {
    Pen,
    Eraser,
}

pub struct ScriptWorkspaceState {
    pub selected_folder_id: Option<String>,
    pub selected_glyph_id: Option<String>,
    pub name: String,
    pub ipa_pronunciation: String,
    pub alphabet_pronunciation: String,
    pub meaning: String,
    pub folder_name: String,
    pub tool: DrawTool,
    pub stroke_width: f32,
    pub pixels: Vec<u8>,
    undo: Vec<Vec<u8>>,
    redo: Vec<Vec<u8>>,
    last_pointer: Option<(f32, f32)>,
    stroke_open: bool,
    pub status: String,
}

impl Default for ScriptWorkspaceState {
    fn default() -> Self {
        Self {
            selected_folder_id: None,
            selected_glyph_id: None,
            name: String::new(),
            ipa_pronunciation: String::new(),
            alphabet_pronunciation: String::new(),
            meaning: String::new(),
            folder_name: String::new(),
            tool: DrawTool::Pen,
            stroke_width: 5.0,
            pixels: vec![0; CANVAS_SIZE * CANVAS_SIZE],
            undo: Vec::new(),
            redo: Vec::new(),
            last_pointer: None,
            stroke_open: false,
            status: String::new(),
        }
    }
}

#[derive(Default)]
pub struct CharacterChartUiState {
    pub selected_chart_id: Option<String>,
    pub selected_cell: Option<(String, String)>,
    pub advanced: bool,
}

pub fn ensure_default_folder(
    language: Language,
    folders: &mut Vec<CharacterFolder>,
    state: &mut ScriptWorkspaceState,
) {
    if folders.is_empty() {
        folders.push(CharacterFolder {
            id: next_id("glyph-folder"),
            name: tr(language, "기본 문자", "Default Glyphs").to_owned(),
            order: 0,
            writing_system_article_id: None,
        });
    }
    if state
        .selected_folder_id
        .as_ref()
        .is_none_or(|id| !folders.iter().any(|folder| &folder.id == id))
    {
        state.selected_folder_id = folders.first().map(|folder| folder.id.clone());
    }
}

pub fn explorer(
    root: &mut egui::Ui,
    dark: bool,
    language: Language,
    folders: &mut Vec<CharacterFolder>,
    glyphs: &mut Vec<GeneratedGlyph>,
    state: &mut ScriptWorkspaceState,
) -> Option<String> {
    ensure_default_folder(language, folders, state);
    let colors = theme::palette(dark);
    let mut load_glyph = None;
    let mut delete_folder = None;
    let mut new_glyph = false;
    let mut duplicate_glyph = false;
    let mut delete_glyph = false;
    let mut move_glyph = 0_i32;
    let mut open_article = None;
    egui::Panel::left("script_library")
        .exact_size(theme::Metrics::EXPLORER_WIDTH)
        .resizable(false)
        .frame(
            egui::Frame::new()
                .fill(colors.panel)
                .stroke(Stroke::new(1.0, colors.border))
                .inner_margin(Margin::symmetric(10, 12)),
        )
        .show(root, |ui| {
            ui.label(
                RichText::new(tr(language, "문자 목록", "SCRIPT LIBRARY"))
                    .size(10.0)
                    .strong()
                    .color(colors.muted),
            );
            ui.add_space(5.0);
            ui.horizontal(|ui| {
                ui.add_sized(
                    [ui.available_width() - 34.0, 27.0],
                    egui::TextEdit::singleline(&mut state.folder_name).hint_text(tr(
                        language,
                        "새 폴더 이름",
                        "New folder name",
                    )),
                );
                if ui
                    .add_sized([30.0, 27.0], egui::Button::new("+"))
                    .on_hover_text(tr(language, "폴더 추가", "Add folder"))
                    .clicked()
                {
                    let name = state.folder_name.trim();
                    if !name.is_empty() {
                        let id = next_id("glyph-folder");
                        folders.push(CharacterFolder {
                            id: id.clone(),
                            name: name.to_owned(),
                            order: folders.len() as i32,
                            writing_system_article_id: None,
                        });
                        state.selected_folder_id = Some(id);
                        state.folder_name.clear();
                    }
                }
            });
            ui.add_space(5.0);
            for folder in folders.iter_mut() {
                ui.horizontal(|ui| {
                    let selected = state.selected_folder_id.as_deref() == Some(folder.id.as_str());
                    let linked = folder.writing_system_article_id.is_some();
                    let reserved = if linked { 68.0 } else { 34.0 };
                    let response = if selected {
                        ui.add_sized(
                            [ui.available_width() - reserved, 29.0],
                            egui::TextEdit::singleline(&mut folder.name),
                        )
                    } else {
                        ui.add_sized(
                            [ui.available_width() - reserved, 29.0],
                            egui::Button::selectable(false, &folder.name),
                        )
                    };
                    if !selected && response.clicked() {
                        state.selected_folder_id = Some(folder.id.clone());
                        state.selected_glyph_id = None;
                    }
                    if linked
                        && ui
                            .add_sized([30.0, 29.0], egui::Button::new("↗"))
                            .on_hover_text(tr(language, "연결 문서 열기", "Open linked document"))
                            .clicked()
                    {
                        open_article = folder.writing_system_article_id.clone();
                    }
                    if selected
                        && ui
                            .add_sized([30.0, 29.0], egui::Button::new("×"))
                            .on_hover_text(tr(language, "폴더 삭제", "Delete folder"))
                            .clicked()
                    {
                        delete_folder = Some(folder.id.clone());
                    }
                });
            }
            ui.separator();
            ui.horizontal(|ui| {
                let width = (ui.available_width() - 16.0) / 5.0;
                new_glyph = ui
                    .add_sized([width, 28.0], egui::Button::new("+"))
                    .on_hover_text(tr(language, "새 문자", "New glyph"))
                    .clicked();
                duplicate_glyph = ui
                    .add_enabled(state.selected_glyph_id.is_some(), egui::Button::new("⧉"))
                    .on_hover_text(tr(language, "복제", "Duplicate"))
                    .clicked();
                delete_glyph = ui
                    .add_enabled(state.selected_glyph_id.is_some(), egui::Button::new("×"))
                    .on_hover_text(tr(language, "삭제", "Delete"))
                    .clicked();
                if ui
                    .add_enabled(state.selected_glyph_id.is_some(), egui::Button::new("↑"))
                    .on_hover_text(tr(language, "위로", "Move up"))
                    .clicked()
                {
                    move_glyph = -1;
                }
                if ui
                    .add_enabled(state.selected_glyph_id.is_some(), egui::Button::new("↓"))
                    .on_hover_text(tr(language, "아래로", "Move down"))
                    .clicked()
                {
                    move_glyph = 1;
                }
            });
            egui::ScrollArea::vertical()
                .scroll_bar_visibility(egui::scroll_area::ScrollBarVisibility::AlwaysHidden)
                .show(ui, |ui| {
                    let selected_folder = state.selected_folder_id.as_deref();
                    let mut visible = glyphs
                        .iter()
                        .filter(|glyph| Some(glyph.folder_id.as_str()) == selected_folder)
                        .collect::<Vec<_>>();
                    visible.sort_by_key(|glyph| glyph.order);
                    for glyph in visible {
                        let selected =
                            state.selected_glyph_id.as_deref() == Some(glyph.id.as_str());
                        let response = glyph_library_row(ui, glyph, selected, colors);
                        if response.clicked() {
                            load_glyph = Some(glyph.id.clone());
                        }
                    }
                });
        });
    if let Some(folder_id) = delete_folder {
        if glyphs.iter().any(|glyph| glyph.folder_id == folder_id) {
            state.status = tr(
                language,
                "문자가 든 폴더는 삭제할 수 없습니다.",
                "A non-empty folder cannot be deleted.",
            )
            .to_owned();
        } else if folders.len() <= 1 {
            state.status = tr(
                language,
                "마지막 폴더는 삭제할 수 없습니다.",
                "The final folder cannot be deleted.",
            )
            .to_owned();
        } else {
            folders.retain(|folder| folder.id != folder_id);
            state.selected_folder_id = folders.first().map(|folder| folder.id.clone());
        }
    }
    if new_glyph {
        reset_editor(state);
    }
    if duplicate_glyph
        && let Some(selected_id) = state.selected_glyph_id.clone()
        && let Some(source) = glyphs.iter().find(|glyph| glyph.id == selected_id).cloned()
    {
        let now = now_seconds();
        let mut clone = source;
        clone.id = next_id("glyph");
        clone.name = format!("{} {}", clone.name, tr(language, "복사본", "Copy"));
        clone.order = glyphs
            .iter()
            .filter(|glyph| glyph.folder_id == clone.folder_id)
            .count() as i32;
        clone.created_at = now;
        clone.updated_at = now;
        load_glyph = Some(clone.id.clone());
        glyphs.push(clone);
    }
    if delete_glyph && let Some(selected_id) = state.selected_glyph_id.take() {
        glyphs.retain(|glyph| glyph.id != selected_id);
        reset_editor(state);
    }
    if move_glyph != 0
        && let Some(selected_id) = state.selected_glyph_id.as_deref()
        && let Some(index) = glyphs.iter().position(|glyph| glyph.id == selected_id)
    {
        let folder_id = glyphs[index].folder_id.clone();
        let mut siblings = glyphs
            .iter()
            .enumerate()
            .filter(|(_, glyph)| glyph.folder_id == folder_id)
            .map(|(index, glyph)| (index, glyph.order))
            .collect::<Vec<_>>();
        siblings.sort_by_key(|(_, order)| *order);
        if let Some(position) = siblings
            .iter()
            .position(|(candidate, _)| *candidate == index)
        {
            let target = if move_glyph < 0 {
                position.checked_sub(1)
            } else if position + 1 < siblings.len() {
                Some(position + 1)
            } else {
                None
            };
            if let Some(target) = target {
                let other = siblings[target].0;
                let order = glyphs[index].order;
                glyphs[index].order = glyphs[other].order;
                glyphs[other].order = order;
            }
        }
    }
    if let Some(id) = load_glyph {
        if let Some(glyph) = glyphs.iter().find(|glyph| glyph.id == id) {
            state.selected_glyph_id = Some(glyph.id.clone());
            state.selected_folder_id = Some(glyph.folder_id.clone());
            state.name = glyph.name.clone();
            state.ipa_pronunciation = glyph.pronunciation.clone();
            state.alphabet_pronunciation = if glyph.alphabet_pronunciation.trim().is_empty() {
                crate::dictionary::ipa_to_alphabet(
                    &glyph.pronunciation,
                    &DictionaryVoiceProfile::default(),
                )
            } else {
                glyph.alphabet_pronunciation.clone()
            };
            state.meaning = glyph.meaning.clone();
            state.pixels = decode_runs(
                &glyph.alpha_runs,
                glyph.width as usize * glyph.height as usize,
            );
            resize_canvas(
                &mut state.pixels,
                glyph.width as usize,
                glyph.height as usize,
            );
            state.undo.clear();
            state.redo.clear();
        }
    }
    open_article
}

pub fn workspace(
    root: &mut egui::Ui,
    dark: bool,
    language: Language,
    folders: &[CharacterFolder],
    glyphs: &mut Vec<GeneratedGlyph>,
    state: &mut ScriptWorkspaceState,
    ipa_state: &mut IpaUiState,
    speech: &mut ImsToucanState,
    voice_profile: &DictionaryVoiceProfile,
) {
    speech.ensure_initialized(language);
    speech.poll(language);
    let colors = theme::palette(dark);
    if root.input_mut(|input| input.consume_key(egui::Modifiers::CTRL, egui::Key::Z)) {
        undo(state);
    }
    let redo_modifiers = egui::Modifiers {
        ctrl: true,
        shift: true,
        ..Default::default()
    };
    if root.input_mut(|input| input.consume_key(egui::Modifiers::CTRL, egui::Key::Y))
        || root.input_mut(|input| input.consume_key(redo_modifiers, egui::Key::Z))
    {
        redo(state);
    }
    egui::CentralPanel::default()
        .frame(
            egui::Frame::new()
                .fill(colors.background)
                .inner_margin(Margin::symmetric(24, 18)),
        )
        .show(root, |ui| {
            ui.horizontal(|ui| {
                ui.label(
                    RichText::new(tr(language, "문자 생성기", "Glyph Generator"))
                        .size(22.0)
                        .strong()
                        .color(colors.title),
                );
                ui.with_layout(egui::Layout::right_to_left(Align::Center), |ui| {
                    if ui
                        .add_sized(
                            [92.0, 32.0],
                            egui::Button::new(tr(language, "저장", "Save")),
                        )
                        .clicked()
                    {
                        save_glyph(language, folders, glyphs, state);
                    }
                    if ui
                        .add_sized(
                            [92.0, 32.0],
                            egui::Button::new(tr(language, "새 문자", "New")),
                        )
                        .clicked()
                    {
                        reset_editor(state);
                    }
                    if ui
                        .add_sized(
                            [92.0, 32.0],
                            egui::Button::new(tr(language, "IPA 조합", "IPA Composer")),
                        )
                        .clicked()
                    {
                        ipa_state.focus(
                            "script-glyph-pronunciation",
                            state.ipa_pronunciation.chars().count(),
                        );
                        ipa_state.composition.clear();
                        ipa_state.open = true;
                    }
                });
            });
            ui.separator();
            ui.horizontal(|ui| {
                ui.vertical(|ui| {
                    ui.set_width(180.0);
                    ui.label(
                        RichText::new(tr(language, "도구", "Tools"))
                            .size(10.0)
                            .strong()
                            .color(colors.muted),
                    );
                    if ui
                        .add_sized(
                            [180.0, 32.0],
                            egui::Button::selectable(
                                state.tool == DrawTool::Pen,
                                tr(language, "펜", "Pen"),
                            ),
                        )
                        .clicked()
                    {
                        state.tool = DrawTool::Pen;
                    }
                    if ui
                        .add_sized(
                            [180.0, 32.0],
                            egui::Button::selectable(
                                state.tool == DrawTool::Eraser,
                                tr(language, "지우개", "Eraser"),
                            ),
                        )
                        .clicked()
                    {
                        state.tool = DrawTool::Eraser;
                    }
                    ui.add(egui::Slider::new(&mut state.stroke_width, 1.0..=24.0))
                        .on_hover_text(tr(language, "선 굵기", "Stroke width"));
                    ui.horizontal(|ui| {
                        if history_icon_button(
                            ui,
                            true,
                            !state.undo.is_empty(),
                            tr(language, "실행 취소", "Undo"),
                            colors,
                        ) {
                            undo(state);
                        }
                        if history_icon_button(
                            ui,
                            false,
                            !state.redo.is_empty(),
                            tr(language, "다시 실행", "Redo"),
                            colors,
                        ) {
                            redo(state);
                        }
                        if ui
                            .button("×")
                            .on_hover_text(tr(language, "모두 지우기", "Clear all"))
                            .clicked()
                        {
                            push_undo(state);
                            state.pixels.fill(0);
                        }
                    });
                    ui.add_space(12.0);
                    ui.label(
                        RichText::new(tr(language, "문자 이름", "Glyph name"))
                            .size(9.0)
                            .color(colors.muted),
                    );
                    ui.add_sized([180.0, 28.0], egui::TextEdit::singleline(&mut state.name));
                    state.alphabet_pronunciation =
                        crate::dictionary::ipa_to_alphabet(&state.ipa_pronunciation, voice_profile);
                    ui.label(
                        RichText::new(tr(language, "발음 (알파벳)", "Pronunciation (Alphabet)"))
                            .size(9.0)
                            .color(colors.muted),
                    );
                    ui.add_enabled(
                        false,
                        egui::TextEdit::singleline(&mut state.alphabet_pronunciation)
                            .desired_width(180.0),
                    );
                    ui.label(
                        RichText::new(tr(language, "발음 (IPA)", "Pronunciation (IPA)"))
                            .size(9.0)
                            .color(colors.muted),
                    );
                    let pronunciation = ui.add_sized(
                        [180.0, 28.0],
                        egui::TextEdit::singleline(&mut state.ipa_pronunciation),
                    );
                    if pronunciation.has_focus() {
                        ipa_state.focus(
                            "script-glyph-pronunciation",
                            state.ipa_pronunciation.chars().count(),
                        );
                    }
                    ui.label(
                        RichText::new(tr(language, "의미", "Meaning"))
                            .size(9.0)
                            .color(colors.muted),
                    );
                    ui.add_sized(
                        [180.0, 48.0],
                        egui::TextEdit::multiline(&mut state.meaning).desired_rows(2),
                    );
                    ui.label(
                        RichText::new(tr(language, "폴더", "Folder"))
                            .size(9.0)
                            .color(colors.muted),
                    );
                    egui::ComboBox::from_id_salt("glyph-folder-select")
                        .selected_text(
                            folders
                                .iter()
                                .find(|folder| {
                                    Some(folder.id.as_str()) == state.selected_folder_id.as_deref()
                                })
                                .map(|folder| folder.name.as_str())
                                .unwrap_or("-"),
                        )
                        .width(176.0)
                        .show_ui(ui, |ui| {
                            for folder in folders {
                                ui.selectable_value(
                                    &mut state.selected_folder_id,
                                    Some(folder.id.clone()),
                                    &folder.name,
                                );
                            }
                        });
                    if !state.status.is_empty() {
                        ui.label(RichText::new(&state.status).size(9.0).color(colors.danger));
                    }
                });
                ui.separator();
                ui.vertical_centered(|ui| {
                    ui.label(
                        RichText::new(format!("{} × {} px", CANVAS_SIZE, CANVAS_SIZE))
                            .size(9.0)
                            .color(colors.muted),
                    );
                    draw_canvas(ui, state, colors);
                });
            });
        });
    if let Some(symbol) = ipa::modal(root.ctx(), dark, language, ipa_state, speech, voice_profile)
        && ipa_state.active_target.as_deref() == Some("script-glyph-pronunciation")
    {
        ipa_state.caret =
            ipa::insert_at_char(&mut state.ipa_pronunciation, ipa_state.caret, &symbol);
    }
}

pub fn charts_panel(
    ui: &mut egui::Ui,
    dark: bool,
    language: Language,
    article_id: &str,
    charts: &[CharacterChart],
    glyphs: &[GeneratedGlyph],
) {
    let colors = theme::palette(dark);
    for chart in ordered_charts(article_id, charts) {
        theme::surface_frame(dark).show(ui, |ui| {
            ui.label(
                RichText::new(&chart.title)
                    .size(13.0)
                    .strong()
                    .color(colors.title),
            );
            egui::ScrollArea::horizontal()
                .scroll_bar_visibility(egui::scroll_area::ScrollBarVisibility::AlwaysHidden)
                .show(ui, |ui| {
                    egui::Grid::new(("character-chart-view", &chart.id))
                        .min_col_width(78.0)
                        .spacing(Vec2::new(4.0, 4.0))
                        .show(ui, |ui| {
                            ui.label("");
                            for column in ordered_axes(&chart.columns) {
                                ui.label(RichText::new(&column.name).size(9.0).strong());
                            }
                            ui.end_row();
                            for row in ordered_axes(&chart.rows) {
                                ui.label(RichText::new(&row.name).size(9.0).strong());
                                for column in ordered_axes(&chart.columns) {
                                    if let Some(cell) = chart.cells.iter().find(|cell| {
                                        cell.row_id == row.id && cell.column_id == column.id
                                    }) {
                                        let response =
                                            character_chart_cell(ui, cell, glyphs, colors);
                                        let glyph_names = cell
                                            .glyphs
                                            .iter()
                                            .filter_map(|slot| slot.source_glyph_id.as_ref())
                                            .filter_map(|id| {
                                                glyphs.iter().find(|glyph| &glyph.id == id)
                                            })
                                            .map(|glyph| {
                                                let mut metadata = vec![glyph.name.clone()];
                                                if !glyph.pronunciation.trim().is_empty() {
                                                    metadata.push(glyph.pronunciation.clone());
                                                }
                                                if !glyph.meaning.trim().is_empty() {
                                                    metadata.push(glyph.meaning.clone());
                                                }
                                                metadata.join(" · ")
                                            })
                                            .collect::<Vec<_>>()
                                            .join("\n");
                                        response.on_hover_text(format!(
                                            "{}\n{}\n{}",
                                            cell.sound_value,
                                            glyph_names,
                                            tr(
                                                language,
                                                "선택하면 변형·결합형을 확인할 수 있습니다.",
                                                "Select to inspect variants and combinations."
                                            )
                                        ));
                                    } else {
                                        ui.add_sized([78.0, 62.0], egui::Button::new("-"));
                                    }
                                }
                                ui.end_row();
                            }
                        });
                });
        });
        ui.add_space(8.0);
    }
    if ordered_charts(article_id, charts).is_empty() {
        theme::surface_frame(dark).show(ui, |ui| {
            ui.label(
                RichText::new(tr(
                    language,
                    "등록된 문자표가 없습니다.",
                    "No character chart has been created.",
                ))
                .color(colors.muted),
            );
        });
    }
}

pub fn charts_editor(
    ui: &mut egui::Ui,
    dark: bool,
    language: Language,
    article_id: &str,
    charts: &mut Vec<CharacterChart>,
    glyphs: &[GeneratedGlyph],
    state: &mut CharacterChartUiState,
) {
    let colors = theme::palette(dark);
    let mut duplicate_chart = false;
    let mut delete_chart = false;
    let mut move_chart = 0_i32;
    let relevant = charts
        .iter()
        .filter(|chart| chart.writing_system_article_id == article_id)
        .map(|chart| chart.id.clone())
        .collect::<Vec<_>>();
    if state
        .selected_chart_id
        .as_ref()
        .is_none_or(|id| !relevant.contains(id))
    {
        state.selected_chart_id = relevant.first().cloned();
    }
    theme::surface_frame(dark).show(ui, |ui| {
        ui.horizontal(|ui| {
            ui.label(
                RichText::new(tr(language, "문자표 편집", "Edit Character Charts"))
                    .size(13.0)
                    .strong()
                    .color(colors.title),
            );
            ui.with_layout(egui::Layout::right_to_left(Align::Center), |ui| {
                if ui
                    .button("+")
                    .on_hover_text(tr(language, "문자표 추가", "Add chart"))
                    .clicked()
                {
                    let id = next_id("character-chart");
                    charts.push(default_chart(
                        id.clone(),
                        article_id,
                        language,
                        relevant.len() as i32,
                    ));
                    state.selected_chart_id = Some(id);
                }
            });
        });
        ui.horizontal_wrapped(|ui| {
            for id in &relevant {
                if let Some(chart) = charts.iter().find(|chart| &chart.id == id) {
                    if ui
                        .add(egui::Button::selectable(
                            state.selected_chart_id.as_ref() == Some(id),
                            &chart.title,
                        ))
                        .clicked()
                    {
                        state.selected_chart_id = Some(id.clone());
                    }
                }
            }
        });
    });
    let Some(selected_id) = state.selected_chart_id.clone() else {
        return;
    };
    let Some(chart) = charts.iter_mut().find(|chart| chart.id == selected_id) else {
        return;
    };
    theme::surface_frame(dark).show(ui, |ui| {
        ui.horizontal(|ui| {
            ui.add_sized(
                [ui.available_width() - 78.0, 28.0],
                egui::TextEdit::singleline(&mut chart.title),
            );
            duplicate_chart = ui
                .button("⧉")
                .on_hover_text(tr(language, "문자표 복제", "Duplicate chart"))
                .clicked();
            delete_chart = ui
                .button("×")
                .on_hover_text(tr(language, "문자표 삭제", "Delete chart"))
                .clicked();
            if ui
                .button("↑")
                .on_hover_text(tr(language, "위로", "Move up"))
                .clicked()
            {
                move_chart = -1;
            }
            if ui
                .button("↓")
                .on_hover_text(tr(language, "아래로", "Move down"))
                .clicked()
            {
                move_chart = 1;
            }
        });
        let removed_row = axis_editor(ui, language, tr(language, "행", "Rows"), &mut chart.rows);
        let removed_column = axis_editor(
            ui,
            language,
            tr(language, "열", "Columns"),
            &mut chart.columns,
        );
        if removed_row.is_some() || removed_column.is_some() {
            chart.cells.retain(|cell| {
                removed_row.as_ref().is_none_or(|id| &cell.row_id != id)
                    && removed_column
                        .as_ref()
                        .is_none_or(|id| &cell.column_id != id)
            });
            if state
                .selected_cell
                .as_ref()
                .is_some_and(|(row_id, column_id)| {
                    removed_row.as_ref() == Some(row_id)
                        || removed_column.as_ref() == Some(column_id)
                })
            {
                state.selected_cell = None;
            }
        }
        ui.separator();
        egui::ScrollArea::horizontal()
            .scroll_bar_visibility(egui::scroll_area::ScrollBarVisibility::AlwaysHidden)
            .show(ui, |ui| {
                egui::Grid::new(("character-chart-edit", &chart.id)).show(ui, |ui| {
                    ui.label("");
                    for column in ordered_axes(&chart.columns) {
                        ui.label(&column.name);
                    }
                    ui.end_row();
                    for row in ordered_axes(&chart.rows) {
                        ui.label(&row.name);
                        for column in ordered_axes(&chart.columns) {
                            let key = (row.id.clone(), column.id.clone());
                            let selected = state.selected_cell.as_ref() == Some(&key);
                            if ui
                                .add_sized(
                                    [72.0, 42.0],
                                    egui::Button::selectable(
                                        selected,
                                        cell_label(chart, &row.id, &column.id),
                                    ),
                                )
                                .clicked()
                            {
                                state.selected_cell = Some(key);
                            }
                        }
                        ui.end_row();
                    }
                });
            });
        if let Some((row_id, column_id)) = state.selected_cell.clone() {
            let rows = ordered_axes(&chart.rows)
                .into_iter()
                .map(|axis| axis.id.clone())
                .collect::<Vec<_>>();
            let columns = ordered_axes(&chart.columns)
                .into_iter()
                .map(|axis| axis.id.clone())
                .collect::<Vec<_>>();
            if let (Some(row), Some(column)) = (
                rows.iter().position(|id| id == &row_id),
                columns.iter().position(|id| id == &column_id),
            ) {
                let mut target = (row, column);
                ui.input(|input| {
                    if input.key_pressed(egui::Key::ArrowUp) {
                        target.0 = target.0.saturating_sub(1);
                    } else if input.key_pressed(egui::Key::ArrowDown) {
                        target.0 = (target.0 + 1).min(rows.len().saturating_sub(1));
                    }
                    if input.key_pressed(egui::Key::ArrowLeft) {
                        target.1 = target.1.saturating_sub(1);
                    } else if input.key_pressed(egui::Key::ArrowRight) {
                        target.1 = (target.1 + 1).min(columns.len().saturating_sub(1));
                    }
                });
                if target != (row, column) {
                    state.selected_cell = Some((rows[target.0].clone(), columns[target.1].clone()));
                }
            }
        }
        if let Some((row_id, column_id)) = state.selected_cell.clone() {
            let chart_id = chart.id.clone();
            let cell = ensure_cell(chart, &row_id, &column_id);
            ui.separator();
            ui.columns(2, |columns| {
                columns[0].label(tr(language, "문자명", "Character name"));
                columns[0].text_edit_singleline(&mut cell.representative_name);
                columns[1].label(tr(language, "음가", "Sound value"));
                columns[1].text_edit_singleline(&mut cell.sound_value);
            });
            let mut slot_action = None;
            for (slot_index, slot) in cell.glyphs.iter_mut().enumerate() {
                ui.horizontal(|ui| {
                    ui.add_sized(
                        [120.0, 25.0],
                        egui::TextEdit::singleline(&mut slot.label).hint_text(tr(
                            language,
                            "글리프 라벨",
                            "Glyph label",
                        )),
                    );
                    if ui.small_button("↑").clicked() {
                        slot_action = Some((slot_index, -1));
                    }
                    if ui.small_button("↓").clicked() {
                        slot_action = Some((slot_index, 1));
                    }
                    if ui.small_button("×").clicked() {
                        slot_action = Some((slot_index, 0));
                    }
                });
            }
            if let Some((index, direction)) = slot_action {
                if direction == 0 {
                    cell.glyphs.remove(index);
                } else {
                    let target = if direction < 0 {
                        index.checked_sub(1)
                    } else if index + 1 < cell.glyphs.len() {
                        Some(index + 1)
                    } else {
                        None
                    };
                    if let Some(target) = target {
                        cell.glyphs.swap(index, target);
                    }
                }
            }
            ui.horizontal_wrapped(|ui| {
                if cell.glyphs.len() < 3 {
                    egui::ComboBox::from_id_salt(("cell-glyph", &chart_id, &row_id, &column_id))
                        .selected_text(tr(language, "+ 글리프 스냅샷", "+ Glyph snapshot"))
                        .show_ui(ui, |ui| {
                            for glyph in glyphs {
                                if ui.button(&glyph.name).clicked() {
                                    cell.glyphs.push(snapshot_slot(glyph));
                                    if cell.representative_name.trim().is_empty() {
                                        cell.representative_name = glyph.name.clone();
                                    }
                                    if cell.sound_value.trim().is_empty() {
                                        cell.sound_value = glyph.pronunciation.clone();
                                    }
                                    ui.close();
                                }
                            }
                        });
                }
            });
            ui.checkbox(
                &mut state.advanced,
                tr(
                    language,
                    "변형·결합형 고급 편집",
                    "Advanced variants and combinations",
                ),
            );
            if state.advanced {
                ui.label(RichText::new(tr(language, "변형", "Variants")).strong());
                for variant in &mut cell.variants {
                    ui.text_edit_singleline(&mut variant.label);
                }
                egui::ComboBox::from_id_salt(("variant-glyph", &chart_id, &row_id, &column_id))
                    .selected_text(tr(language, "+ 변형", "+ Variant"))
                    .show_ui(ui, |ui| {
                        for glyph in glyphs {
                            if ui.button(&glyph.name).clicked() {
                                cell.variants.push(crate::model::CharacterGlyphVariant {
                                    id: next_id("glyph-variant"),
                                    label: glyph.name.clone(),
                                    glyph: snapshot_slot(glyph),
                                });
                                ui.close();
                            }
                        }
                    });
                ui.label(RichText::new(tr(language, "결합형", "Combination forms")).strong());
                for combination in &mut cell.combinations {
                    ui.horizontal(|ui| {
                        ui.text_edit_singleline(&mut combination.label);
                        ui.text_edit_singleline(&mut combination.condition);
                    });
                }
                egui::ComboBox::from_id_salt(("combination-glyph", &chart_id, &row_id, &column_id))
                    .selected_text(tr(language, "+ 결합형", "+ Combination"))
                    .show_ui(ui, |ui| {
                        for glyph in glyphs {
                            if ui.button(&glyph.name).clicked() {
                                cell.combinations
                                    .push(crate::model::CharacterCombinationForm {
                                        id: next_id("glyph-combination"),
                                        label: glyph.name.clone(),
                                        condition: String::new(),
                                        glyph: snapshot_slot(glyph),
                                    });
                                ui.close();
                            }
                        }
                    });
            }
        }
    });
    if duplicate_chart
        && let Some(source) = charts.iter().find(|chart| chart.id == selected_id).cloned()
    {
        let mut clone = source;
        clone.id = next_id("character-chart");
        clone.title = format!("{} {}", clone.title, tr(language, "복사본", "Copy"));
        clone.order = charts
            .iter()
            .filter(|chart| chart.writing_system_article_id == article_id)
            .count() as i32;
        state.selected_chart_id = Some(clone.id.clone());
        charts.push(clone);
    }
    if delete_chart {
        charts.retain(|chart| chart.id != selected_id);
        state.selected_chart_id = charts
            .iter()
            .filter(|chart| chart.writing_system_article_id == article_id)
            .min_by_key(|chart| chart.order)
            .map(|chart| chart.id.clone());
        state.selected_cell = None;
    }
    if move_chart != 0
        && let Some(index) = charts.iter().position(|chart| chart.id == selected_id)
    {
        let mut siblings = charts
            .iter()
            .enumerate()
            .filter(|(_, chart)| chart.writing_system_article_id == article_id)
            .map(|(index, chart)| (index, chart.order))
            .collect::<Vec<_>>();
        siblings.sort_by_key(|(_, order)| *order);
        if let Some(position) = siblings
            .iter()
            .position(|(candidate, _)| *candidate == index)
        {
            let target = if move_chart < 0 {
                position.checked_sub(1)
            } else if position + 1 < siblings.len() {
                Some(position + 1)
            } else {
                None
            };
            if let Some(target) = target {
                let other = siblings[target].0;
                let order = charts[index].order;
                charts[index].order = charts[other].order;
                charts[other].order = order;
            }
        }
    }
}

fn character_chart_cell(
    ui: &mut egui::Ui,
    cell: &CharacterChartCell,
    glyphs: &[GeneratedGlyph],
    colors: theme::Palette,
) -> egui::Response {
    let (rect, response) = ui.allocate_exact_size(Vec2::new(88.0, 82.0), Sense::click());
    ui.painter().rect(
        rect,
        CornerRadius::same(3),
        if response.hovered() {
            colors.hover
        } else {
            colors.surface_soft
        },
        Stroke::new(1.0, colors.border),
        egui::StrokeKind::Inside,
    );
    let source_glyph = cell
        .glyphs
        .first()
        .and_then(|slot| slot.source_glyph_id.as_ref())
        .and_then(|id| glyphs.iter().find(|glyph| &glyph.id == id));
    if let Some(slot) = cell.glyphs.first() {
        let glyph_rect = Rect::from_center_size(
            Pos2::new(rect.center().x, rect.top() + 27.0),
            Vec2::splat(42.0),
        );
        paint_alpha_runs(
            ui.painter(),
            glyph_rect,
            slot.width.max(1) as usize,
            slot.height.max(1) as usize,
            &slot.alpha_runs,
            colors.title,
        );
    } else {
        ui.painter().text(
            Pos2::new(rect.center().x, rect.top() + 27.0),
            egui::Align2::CENTER_CENTER,
            "-",
            egui::FontId::proportional(13.0),
            colors.muted,
        );
    }
    let korean = if cell.representative_name.trim().is_empty() {
        source_glyph.map_or("-", |glyph| glyph.name.as_str())
    } else {
        cell.representative_name.as_str()
    };
    let ipa = if cell.sound_value.trim().is_empty() {
        source_glyph.map_or("-", |glyph| glyph.pronunciation.as_str())
    } else {
        cell.sound_value.as_str()
    };
    ui.painter().text(
        Pos2::new(rect.center().x, rect.bottom() - 22.0),
        egui::Align2::CENTER_CENTER,
        korean,
        egui::FontId::proportional(9.0),
        colors.text,
    );
    ui.painter().text(
        Pos2::new(rect.center().x, rect.bottom() - 9.0),
        egui::Align2::CENTER_CENTER,
        ipa,
        egui::FontId::proportional(8.0),
        colors.muted,
    );
    response
}

fn draw_canvas(ui: &mut egui::Ui, state: &mut ScriptWorkspaceState, colors: theme::Palette) {
    let side = ui
        .available_width()
        .min(ui.available_height().max(360.0))
        .clamp(320.0, 620.0);
    let (rect, response) = ui.allocate_exact_size(Vec2::splat(side), Sense::click_and_drag());
    ui.painter().rect(
        rect,
        CornerRadius::same(3),
        Color32::WHITE,
        Stroke::new(1.0, colors.border),
        egui::StrokeKind::Inside,
    );
    paint_alpha_runs(
        ui.painter(),
        rect,
        CANVAS_SIZE,
        CANVAS_SIZE,
        &encode_runs(&state.pixels),
        Color32::BLACK,
    );
    if response.drag_started() {
        push_undo(state);
        state.stroke_open = true;
        state.last_pointer = None;
    }
    if (response.dragged() || response.clicked())
        && let Some(pointer) = response.interact_pointer_pos()
    {
        let point = (
            ((pointer.x - rect.left()) / rect.width() * CANVAS_SIZE as f32)
                .clamp(0.0, CANVAS_SIZE as f32 - 1.0),
            ((pointer.y - rect.top()) / rect.height() * CANVAS_SIZE as f32)
                .clamp(0.0, CANVAS_SIZE as f32 - 1.0),
        );
        if response.clicked() && !state.stroke_open {
            push_undo(state);
        }
        draw_segment(
            &mut state.pixels,
            state.last_pointer.unwrap_or(point),
            point,
            state.stroke_width,
            state.tool == DrawTool::Eraser,
        );
        state.last_pointer = Some(point);
    }
    if response.drag_stopped() {
        state.stroke_open = false;
        state.last_pointer = None;
    }
}

pub(crate) fn paint_alpha_runs(
    painter: &egui::Painter,
    rect: Rect,
    width: usize,
    height: usize,
    runs: &[u32],
    color: Color32,
) {
    let pixels = decode_runs(runs, width * height);
    let sx = rect.width() / width.max(1) as f32;
    let sy = rect.height() / height.max(1) as f32;
    for y in 0..height {
        let mut x = 0;
        while x < width {
            if pixels[y * width + x] == 0 {
                x += 1;
                continue;
            }
            let start = x;
            while x < width && pixels[y * width + x] != 0 {
                x += 1;
            }
            painter.rect_filled(
                Rect::from_min_max(
                    Pos2::new(rect.left() + start as f32 * sx, rect.top() + y as f32 * sy),
                    Pos2::new(
                        rect.left() + x as f32 * sx,
                        rect.top() + (y + 1) as f32 * sy,
                    ),
                ),
                0.0,
                color,
            );
        }
    }
}

fn glyph_library_row(
    ui: &mut egui::Ui,
    glyph: &GeneratedGlyph,
    selected: bool,
    colors: theme::Palette,
) -> egui::Response {
    let (rect, response) =
        ui.allocate_exact_size(Vec2::new(ui.available_width(), 52.0), Sense::click());
    ui.painter().rect(
        rect,
        CornerRadius::same(4),
        if selected {
            colors.selected
        } else if response.hovered() {
            colors.hover
        } else {
            Color32::TRANSPARENT
        },
        Stroke::new(
            1.0,
            if selected {
                colors.accent
            } else {
                colors.border
            },
        ),
        egui::StrokeKind::Inside,
    );
    let preview = Rect::from_min_size(rect.min + Vec2::splat(5.0), Vec2::splat(42.0));
    ui.painter().rect_filled(preview, 2.0, Color32::WHITE);
    paint_alpha_runs(
        ui.painter(),
        preview.shrink(4.0),
        glyph.width as usize,
        glyph.height as usize,
        &glyph.alpha_runs,
        Color32::BLACK,
    );
    ui.painter().text(
        Pos2::new(preview.right() + 8.0, rect.center().y - 7.0),
        egui::Align2::LEFT_CENTER,
        &glyph.name,
        egui::FontId::proportional(11.0),
        colors.title,
    );
    if !glyph.pronunciation.trim().is_empty() {
        ui.painter().text(
            Pos2::new(preview.right() + 8.0, rect.center().y + 9.0),
            egui::Align2::LEFT_CENTER,
            &glyph.pronunciation,
            egui::FontId::proportional(9.0),
            colors.muted,
        );
    }
    if glyph.meaning.trim().is_empty() {
        response
    } else {
        response.on_hover_text(&glyph.meaning)
    }
}

fn history_icon_button(
    ui: &mut egui::Ui,
    undo_direction: bool,
    enabled: bool,
    label: &str,
    colors: theme::Palette,
) -> bool {
    let (rect, response) = ui.allocate_exact_size(Vec2::splat(30.0), Sense::click());
    let response = response.on_hover_text(label);
    let clicked = enabled && response.clicked();
    let fill = if response.is_pointer_button_down_on() {
        colors.selected
    } else if response.hovered() {
        colors.hover
    } else {
        colors.surface_soft
    };
    ui.painter().rect(
        rect,
        CornerRadius::same(4),
        fill,
        Stroke::new(1.0, colors.border),
        egui::StrokeKind::Inside,
    );
    let color = if enabled {
        colors.title
    } else {
        colors.muted.gamma_multiply(0.55)
    };
    let mirror = |x: f32| {
        if undo_direction {
            rect.left() + x
        } else {
            rect.right() - x
        }
    };
    let y = |value: f32| rect.top() + value;
    ui.painter().add(egui::Shape::line(
        vec![
            Pos2::new(mirror(23.0), y(22.0)),
            Pos2::new(mirror(23.0), y(16.0)),
            Pos2::new(mirror(21.0), y(11.0)),
            Pos2::new(mirror(17.0), y(8.0)),
            Pos2::new(mirror(12.0), y(8.0)),
            Pos2::new(mirror(7.0), y(13.0)),
        ],
        Stroke::new(1.8, color),
    ));
    ui.painter().line_segment(
        [
            Pos2::new(mirror(7.0), y(13.0)),
            Pos2::new(mirror(12.0), y(13.0)),
        ],
        Stroke::new(1.8, color),
    );
    ui.painter().line_segment(
        [
            Pos2::new(mirror(7.0), y(13.0)),
            Pos2::new(mirror(9.0), y(18.0)),
        ],
        Stroke::new(1.8, color),
    );
    clicked
}

fn draw_segment(pixels: &mut [u8], start: (f32, f32), end: (f32, f32), width: f32, erase: bool) {
    let distance = ((end.0 - start.0).powi(2) + (end.1 - start.1).powi(2)).sqrt();
    let steps = distance.ceil().max(1.0) as usize;
    for step in 0..=steps {
        let t = step as f32 / steps as f32;
        stamp(
            pixels,
            start.0 + (end.0 - start.0) * t,
            start.1 + (end.1 - start.1) * t,
            width * 0.5,
            erase,
        );
    }
}

fn stamp(pixels: &mut [u8], x: f32, y: f32, radius: f32, erase: bool) {
    let radius = radius.max(0.5);
    for py in ((y - radius).floor() as isize).max(0)
        ..=((y + radius).ceil() as isize).min(CANVAS_SIZE as isize - 1)
    {
        for px in ((x - radius).floor() as isize).max(0)
            ..=((x + radius).ceil() as isize).min(CANVAS_SIZE as isize - 1)
        {
            if (px as f32 - x).powi(2) + (py as f32 - y).powi(2) <= radius * radius {
                pixels[py as usize * CANVAS_SIZE + px as usize] = if erase { 0 } else { 255 };
            }
        }
    }
}

fn save_glyph(
    language: Language,
    folders: &[CharacterFolder],
    glyphs: &mut Vec<GeneratedGlyph>,
    state: &mut ScriptWorkspaceState,
) {
    let Some(folder_id) = state
        .selected_folder_id
        .clone()
        .filter(|id| folders.iter().any(|folder| &folder.id == id))
    else {
        state.status = tr(language, "폴더를 선택하세요.", "Select a folder.").to_owned();
        return;
    };
    let name = state.name.trim().to_owned();
    if name.is_empty() {
        state.status = tr(
            language,
            "문자 이름을 입력하세요.",
            "Enter a character name.",
        )
        .to_owned();
        return;
    }
    let now = now_seconds();
    if let Some(glyph) = state
        .selected_glyph_id
        .as_ref()
        .and_then(|id| glyphs.iter_mut().find(|glyph| &glyph.id == id))
    {
        glyph.name = name;
        glyph.pronunciation = state.ipa_pronunciation.trim().to_owned();
        glyph.alphabet_pronunciation = state.alphabet_pronunciation.trim().to_owned();
        glyph.meaning = state.meaning.trim().to_owned();
        glyph.folder_id = folder_id;
        glyph.alpha_runs = encode_runs(&state.pixels);
        glyph.updated_at = now;
    } else {
        let id = next_id("glyph");
        glyphs.push(GeneratedGlyph {
            id: id.clone(),
            folder_id,
            name,
            pronunciation: state.ipa_pronunciation.trim().to_owned(),
            alphabet_pronunciation: state.alphabet_pronunciation.trim().to_owned(),
            meaning: state.meaning.trim().to_owned(),
            width: CANVAS_SIZE as u16,
            height: CANVAS_SIZE as u16,
            alpha_runs: encode_runs(&state.pixels),
            order: glyphs.len() as i32,
            created_at: now,
            updated_at: now,
        });
        state.selected_glyph_id = Some(id);
    }
    state.status = tr(language, "문자를 저장했습니다.", "Glyph saved.").to_owned();
}

fn reset_editor(state: &mut ScriptWorkspaceState) {
    state.selected_glyph_id = None;
    state.name.clear();
    state.ipa_pronunciation.clear();
    state.alphabet_pronunciation.clear();
    state.meaning.clear();
    state.pixels.fill(0);
    state.undo.clear();
    state.redo.clear();
    state.status.clear();
}

fn push_undo(state: &mut ScriptWorkspaceState) {
    state.undo.push(state.pixels.clone());
    state.undo.truncate(64);
    state.redo.clear();
}
fn undo(state: &mut ScriptWorkspaceState) {
    if let Some(previous) = state.undo.pop() {
        state
            .redo
            .push(std::mem::replace(&mut state.pixels, previous));
    }
}
fn redo(state: &mut ScriptWorkspaceState) {
    if let Some(next) = state.redo.pop() {
        state.undo.push(std::mem::replace(&mut state.pixels, next));
    }
}

pub fn encode_runs(pixels: &[u8]) -> Vec<u32> {
    let mut result = Vec::new();
    let mut opaque = false;
    let mut count = 0_u32;
    for pixel in pixels {
        let value = *pixel >= 128;
        if value == opaque {
            count += 1;
        } else {
            result.push(count);
            count = 1;
            opaque = value;
        }
    }
    result.push(count);
    result
}

pub fn decode_runs(runs: &[u32], length: usize) -> Vec<u8> {
    let mut result = Vec::with_capacity(length);
    let mut opaque = false;
    for count in runs {
        result.extend(std::iter::repeat_n(
            if opaque { 255 } else { 0 },
            *count as usize,
        ));
        opaque = !opaque;
        if result.len() >= length {
            break;
        }
    }
    result.resize(length, 0);
    result.truncate(length);
    result
}

fn resize_canvas(pixels: &mut Vec<u8>, width: usize, height: usize) {
    if width == CANVAS_SIZE && height == CANVAS_SIZE {
        pixels.resize(CANVAS_SIZE * CANVAS_SIZE, 0);
        return;
    }
    let source = pixels.clone();
    pixels.clear();
    pixels.resize(CANVAS_SIZE * CANVAS_SIZE, 0);
    for y in 0..CANVAS_SIZE {
        for x in 0..CANVAS_SIZE {
            let sx = x * width.max(1) / CANVAS_SIZE;
            let sy = y * height.max(1) / CANVAS_SIZE;
            pixels[y * CANVAS_SIZE + x] = source.get(sy * width.max(1) + sx).copied().unwrap_or(0);
        }
    }
}

fn axis_editor(
    ui: &mut egui::Ui,
    language: Language,
    title: &str,
    axes: &mut Vec<CharacterChartAxis>,
) -> Option<String> {
    let mut removed_id = None;
    ui.horizontal_wrapped(|ui| {
        ui.label(RichText::new(title).strong());
        let mut action = None;
        for (index, axis) in axes.iter_mut().enumerate() {
            ui.add_sized([92.0, 25.0], egui::TextEdit::singleline(&mut axis.name));
            if ui
                .small_button("↑")
                .on_hover_text(tr(language, "위로", "Move up"))
                .clicked()
            {
                action = Some((index, -1_i8));
            }
            if ui
                .small_button("↓")
                .on_hover_text(tr(language, "아래로", "Move down"))
                .clicked()
            {
                action = Some((index, 1_i8));
            }
            if ui.small_button("×").clicked() {
                action = Some((index, 0_i8));
            }
        }
        if ui
            .small_button("+")
            .on_hover_text(tr(language, "축 추가", "Add axis"))
            .clicked()
        {
            axes.push(CharacterChartAxis {
                id: next_id("chart-axis"),
                name: String::new(),
                order: axes.len() as i32,
            });
        }
        if let Some((index, direction)) = action {
            if direction == 0 {
                removed_id = Some(axes.remove(index).id);
            } else {
                let target = if direction < 0 {
                    index.checked_sub(1)
                } else if index + 1 < axes.len() {
                    Some(index + 1)
                } else {
                    None
                };
                if let Some(target) = target {
                    axes.swap(index, target);
                }
            }
            for (order, axis) in axes.iter_mut().enumerate() {
                axis.order = order as i32;
            }
        }
    });
    removed_id
}

fn default_chart(id: String, article_id: &str, language: Language, order: i32) -> CharacterChart {
    CharacterChart {
        id,
        writing_system_article_id: article_id.to_owned(),
        title: tr(language, "새 문자표", "New Character Chart").to_owned(),
        order,
        rows: vec![CharacterChartAxis {
            id: next_id("chart-row"),
            name: tr(language, "기본", "Default").to_owned(),
            order: 0,
        }],
        columns: vec![CharacterChartAxis {
            id: next_id("chart-column"),
            name: tr(language, "문자", "Glyph").to_owned(),
            order: 0,
        }],
        cells: Vec::new(),
    }
}

fn snapshot_slot(glyph: &GeneratedGlyph) -> CharacterGlyphSlot {
    CharacterGlyphSlot {
        id: next_id("glyph-slot"),
        label: glyph.name.clone(),
        source_glyph_id: Some(glyph.id.clone()),
        width: glyph.width,
        height: glyph.height,
        alpha_runs: glyph.alpha_runs.clone(),
    }
}
fn ensure_cell<'a>(
    chart: &'a mut CharacterChart,
    row_id: &str,
    column_id: &str,
) -> &'a mut CharacterChartCell {
    if let Some(index) = chart
        .cells
        .iter()
        .position(|cell| cell.row_id == row_id && cell.column_id == column_id)
    {
        return &mut chart.cells[index];
    }
    chart.cells.push(CharacterChartCell {
        row_id: row_id.to_owned(),
        column_id: column_id.to_owned(),
        ..Default::default()
    });
    chart.cells.last_mut().unwrap()
}
fn cell_label<'a>(chart: &'a CharacterChart, row_id: &str, column_id: &str) -> &'a str {
    chart
        .cells
        .iter()
        .find(|cell| cell.row_id == row_id && cell.column_id == column_id)
        .map(|cell| {
            if cell.representative_name.is_empty() {
                "-"
            } else {
                cell.representative_name.as_str()
            }
        })
        .unwrap_or("-")
}
fn ordered_axes(axes: &[CharacterChartAxis]) -> Vec<&CharacterChartAxis> {
    let mut values = axes.iter().collect::<Vec<_>>();
    values.sort_by_key(|axis| axis.order);
    values
}
fn ordered_charts<'a>(article_id: &str, charts: &'a [CharacterChart]) -> Vec<&'a CharacterChart> {
    let mut values = charts
        .iter()
        .filter(|chart| chart.writing_system_article_id == article_id)
        .collect::<Vec<_>>();
    values.sort_by_key(|chart| chart.order);
    values
}
fn next_id(prefix: &str) -> String {
    format!("{prefix}-{}", now_micros())
}
fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn now_micros() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_micros()
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
    fn alpha_runs_round_trip() {
        let source = vec![0, 0, 255, 255, 0, 255];
        assert_eq!(decode_runs(&encode_runs(&source), source.len()), source);
    }

    #[test]
    fn chart_cells_survive_axis_reordering_by_id() {
        let mut chart = default_chart("chart".to_owned(), "writing", Language::English, 0);
        chart.columns.push(CharacterChartAxis {
            id: "second".to_owned(),
            name: "B".to_owned(),
            order: 1,
        });
        let row = chart.rows[0].id.clone();
        ensure_cell(&mut chart, &row, "second").representative_name = "Ka".to_owned();
        chart.columns.reverse();
        assert_eq!(cell_label(&chart, &row, "second"), "Ka");
    }

    #[test]
    fn glyph_slot_limit_is_three() {
        let mut cell = CharacterChartCell::default();
        for index in 0..5 {
            if cell.glyphs.len() < 3 {
                cell.glyphs.push(CharacterGlyphSlot {
                    id: index.to_string(),
                    ..Default::default()
                });
            }
        }
        assert_eq!(cell.glyphs.len(), 3);
    }
}
