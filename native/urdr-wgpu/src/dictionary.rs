use eframe::egui::{
    self, Align, Color32, CornerRadius, Layout, Margin, RichText, Sense, Stroke, Vec2,
};

use crate::{
    ipa::{self, IpaUiState},
    model::{
        DictionaryBook, DictionaryConversation, DictionaryConversationLine, DictionarySentence,
        DictionaryWord, GeneratedGlyph, Language,
    },
    speech::ImsToucanState,
    theme,
};

#[derive(Default)]
pub struct DictionaryUiState {
    selected_id: Option<String>,
    editing: bool,
    draft: Option<DictionaryDraft>,
}

enum DictionaryDraft {
    Word(DictionaryWord),
    Sentence(DictionarySentence),
    Conversation(DictionaryConversation),
}

enum EntryAction {
    Select(String),
    Edit(DictionaryDraft),
    Save,
    Cancel,
    Delete(String),
}

#[allow(clippy::too_many_arguments)]
pub fn workspace(
    ui: &mut egui::Ui,
    dark: bool,
    language: Language,
    language_title: &str,
    tab: &mut usize,
    search: &mut String,
    state: &mut DictionaryUiState,
    book: &mut DictionaryBook,
    glyphs: &[GeneratedGlyph],
    ipa_state: &mut IpaUiState,
    speech: &mut ImsToucanState,
) {
    speech.ensure_initialized(language);
    speech.poll(language);
    let colors = theme::palette(dark);
    ui.horizontal(|ui| {
        ui.label(
            RichText::new(tr(language, "사전", "Dictionary"))
                .size(22.0)
                .strong()
                .color(colors.title),
        );
        ui.label(
            RichText::new(language_title)
                .size(12.0)
                .color(colors.accent),
        );
    });
    ui.add_space(8.0);
    ui.horizontal(|ui| {
        if ui
            .add_sized(
                [112.0, 32.0],
                egui::Button::new(tr(language, "IPA 조합", "IPA Composer")),
            )
            .clicked()
        {
            ipa_state.open = true;
        }
        for (index, (ko, en)) in [
            ("어휘", "Words"),
            ("문장", "Sentences"),
            ("회화", "Conversations"),
        ]
        .into_iter()
        .enumerate()
        {
            if ui
                .add_sized(
                    [116.0, 32.0],
                    egui::Button::selectable(*tab == index, tr(language, ko, en)),
                )
                .clicked()
            {
                *tab = index;
                state.selected_id = None;
                state.editing = false;
                state.draft = None;
            }
        }
        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
            ui.add_sized(
                [260.0_f32.min(ui.available_width()), 30.0],
                egui::TextEdit::singleline(search).hint_text(tr(
                    language,
                    "사전 검색",
                    "Search dictionary",
                )),
            );
        });
    });
    voice_profile_editor(ui, language, book, speech);
    ui.separator();
    egui::ScrollArea::vertical()
        .id_salt("dictionary-body")
        .show(ui, |ui| match *tab {
            0 => words_workspace(
                ui, dark, language, search, state, book, glyphs, ipa_state, speech,
            ),
            1 => sentences_workspace(
                ui, dark, language, search, state, book, glyphs, ipa_state, speech,
            ),
            _ => conversations_workspace(
                ui, dark, language, search, state, book, glyphs, ipa_state, speech,
            ),
        });
    if let Some(symbol) = ipa::modal(
        ui.ctx(),
        dark,
        language,
        ipa_state,
        speech,
        &book.voice_profile,
    ) {
        apply_ipa_insert(book, state, ipa_state, &symbol);
    }
}

#[allow(clippy::too_many_arguments)]
fn words_workspace(
    ui: &mut egui::Ui,
    dark: bool,
    language: Language,
    search: &str,
    state: &mut DictionaryUiState,
    book: &mut DictionaryBook,
    glyphs: &[GeneratedGlyph],
    ipa_state: &mut IpaUiState,
    speech: &mut ImsToucanState,
) {
    let query = search.trim().to_lowercase();
    let voice_profile = book.voice_profile.clone();
    let mut action = None;
    for word in &book.words {
        if !matches_word(word, &query) {
            continue;
        }
        let selected = state.selected_id.as_deref() == Some(word.id.as_str());
        entry_frame(ui, dark, |ui| {
            if preview_button(
                ui,
                selected,
                display_or(&word.term, tr(language, "새 어휘", "New word")),
                &format!(
                    "{}  ·  {}",
                    display_or(&word.alphabet_pronunciation, "-"),
                    one_line(&word.meaning)
                ),
            )
            .clicked()
            {
                action = Some(EntryAction::Select(word.id.clone()));
            }
            if selected {
                ui.separator();
                if state.editing {
                    if let Some(DictionaryDraft::Word(draft)) = state.draft.as_mut() {
                        word_edit_form(
                            ui,
                            language,
                            draft,
                            glyphs,
                            ipa_state,
                            speech,
                            &voice_profile,
                        );
                        editor_actions(ui, language, &mut action, &word.id);
                    }
                } else {
                    word_read_view(ui, language, word, glyphs, speech, &voice_profile);
                    reader_actions(
                        ui,
                        language,
                        &mut action,
                        DictionaryDraft::Word(word.clone()),
                        &word.id,
                    );
                }
            }
        });
        ui.add_space(7.0);
    }
    apply_word_action(action, state, book);
    if ui
        .button(tr(language, "+ 어휘 추가", "+ Add word"))
        .clicked()
    {
        let word = DictionaryWord {
            id: next_id("word", book.words.iter().map(|word| word.id.as_str())),
            ..DictionaryWord::default()
        };
        state.selected_id = Some(word.id.clone());
        state.editing = true;
        state.draft = Some(DictionaryDraft::Word(word.clone()));
        book.words.push(word);
    }
}

#[allow(clippy::too_many_arguments)]
fn sentences_workspace(
    ui: &mut egui::Ui,
    dark: bool,
    language: Language,
    search: &str,
    state: &mut DictionaryUiState,
    book: &mut DictionaryBook,
    glyphs: &[GeneratedGlyph],
    ipa_state: &mut IpaUiState,
    speech: &mut ImsToucanState,
) {
    let query = search.trim().to_lowercase();
    let voice_profile = book.voice_profile.clone();
    let mut action = None;
    for (index, sentence) in book.sentences.iter().enumerate() {
        if !matches_sentence(sentence, &query) {
            continue;
        }
        let selected = state.selected_id.as_deref() == Some(sentence.id.as_str());
        entry_frame(ui, dark, |ui| {
            if preview_button(
                ui,
                selected,
                display_or(
                    &sentence.text,
                    &format!("{} {}", tr(language, "문장", "Sentence"), index + 1),
                ),
                &one_line(&sentence.translation),
            )
            .clicked()
            {
                action = Some(EntryAction::Select(sentence.id.clone()));
            }
            if selected {
                ui.separator();
                if state.editing {
                    if let Some(DictionaryDraft::Sentence(draft)) = state.draft.as_mut() {
                        sentence_edit_form(
                            ui,
                            language,
                            draft,
                            glyphs,
                            ipa_state,
                            speech,
                            &voice_profile,
                        );
                        editor_actions(ui, language, &mut action, &sentence.id);
                    }
                } else {
                    sentence_read_view(ui, language, sentence, glyphs, speech, &voice_profile);
                    reader_actions(
                        ui,
                        language,
                        &mut action,
                        DictionaryDraft::Sentence(sentence.clone()),
                        &sentence.id,
                    );
                }
            }
        });
        ui.add_space(7.0);
    }
    apply_sentence_action(action, state, book);
    if ui
        .button(tr(language, "+ 문장 추가", "+ Add sentence"))
        .clicked()
    {
        let sentence = DictionarySentence {
            id: next_id(
                "sentence",
                book.sentences.iter().map(|sentence| sentence.id.as_str()),
            ),
            ..DictionarySentence::default()
        };
        state.selected_id = Some(sentence.id.clone());
        state.editing = true;
        state.draft = Some(DictionaryDraft::Sentence(sentence.clone()));
        book.sentences.push(sentence);
    }
}

#[allow(clippy::too_many_arguments)]
fn conversations_workspace(
    ui: &mut egui::Ui,
    dark: bool,
    language: Language,
    search: &str,
    state: &mut DictionaryUiState,
    book: &mut DictionaryBook,
    glyphs: &[GeneratedGlyph],
    ipa_state: &mut IpaUiState,
    speech: &mut ImsToucanState,
) {
    let query = search.trim().to_lowercase();
    let voice_profile = book.voice_profile.clone();
    let mut action = None;
    for (index, conversation) in book.conversations.iter().enumerate() {
        if !matches_conversation(conversation, &query) {
            continue;
        }
        let selected = state.selected_id.as_deref() == Some(conversation.id.as_str());
        entry_frame(ui, dark, |ui| {
            if preview_button(
                ui,
                selected,
                display_or(
                    &conversation.title,
                    &format!("{} {}", tr(language, "회화", "Conversation"), index + 1),
                ),
                &format!(
                    "{} · {} {}",
                    one_line(&conversation.situation),
                    conversation.lines.len(),
                    tr(language, "줄", "lines")
                ),
            )
            .clicked()
            {
                action = Some(EntryAction::Select(conversation.id.clone()));
            }
            if selected {
                ui.separator();
                if state.editing {
                    if let Some(DictionaryDraft::Conversation(draft)) = state.draft.as_mut() {
                        conversation_edit_form(
                            ui,
                            language,
                            draft,
                            glyphs,
                            ipa_state,
                            speech,
                            &voice_profile,
                        );
                        editor_actions(ui, language, &mut action, &conversation.id);
                    }
                } else {
                    conversation_read_view(
                        ui,
                        language,
                        conversation,
                        glyphs,
                        speech,
                        &voice_profile,
                    );
                    reader_actions(
                        ui,
                        language,
                        &mut action,
                        DictionaryDraft::Conversation(conversation.clone()),
                        &conversation.id,
                    );
                }
            }
        });
        ui.add_space(7.0);
    }
    apply_conversation_action(action, state, book);
    if ui
        .button(tr(language, "+ 회화 추가", "+ Add conversation"))
        .clicked()
    {
        let conversation = DictionaryConversation {
            id: next_id(
                "conversation",
                book.conversations
                    .iter()
                    .map(|conversation| conversation.id.as_str()),
            ),
            ..DictionaryConversation::default()
        };
        state.selected_id = Some(conversation.id.clone());
        state.editing = true;
        state.draft = Some(DictionaryDraft::Conversation(conversation.clone()));
        book.conversations.push(conversation);
    }
}

fn word_read_view(
    ui: &mut egui::Ui,
    language: Language,
    word: &DictionaryWord,
    glyphs: &[GeneratedGlyph],
    speech: &mut ImsToucanState,
    profile: &crate::model::DictionaryVoiceProfile,
) {
    glyph_sequence(ui, language, &word.script_glyph_ids, glyphs);
    ui.columns(2, |columns| {
        read_value(
            &mut columns[0],
            tr(language, "발음 (알파벳)", "Pronunciation (Alphabet)"),
            &word.alphabet_pronunciation,
        );
        ipa_read_value(
            &mut columns[1],
            language,
            &word.pronunciation,
            speech,
            profile,
        );
        read_value(
            &mut columns[0],
            tr(language, "품사", "Part of speech"),
            &word.part_of_speech,
        );
        read_value(
            &mut columns[1],
            tr(language, "어원", "Etymology"),
            &word.etymology,
        );
    });
    read_value(ui, tr(language, "의미", "Meaning"), &word.meaning);
    read_value(
        ui,
        tr(language, "관련어", "Related terms"),
        &word.related_terms.join(", "),
    );
    read_value(
        ui,
        tr(language, "용례 및 비고", "Usage notes"),
        &word.usage_note,
    );
}

#[allow(clippy::too_many_arguments)]
fn word_edit_form(
    ui: &mut egui::Ui,
    language: Language,
    word: &mut DictionaryWord,
    glyphs: &[GeneratedGlyph],
    ipa_state: &mut IpaUiState,
    speech: &mut ImsToucanState,
    profile: &crate::model::DictionaryVoiceProfile,
) {
    labeled_text(ui, tr(language, "표제어", "Headword"), &mut word.term);
    glyph_sequence_editor(ui, language, &mut word.script_glyph_ids, glyphs);
    word.alphabet_pronunciation = ipa_to_alphabet(&word.pronunciation, profile);
    ui.columns(2, |columns| {
        labeled_readonly(
            &mut columns[0],
            tr(language, "발음 (알파벳)", "Pronunciation (Alphabet)"),
            &word.alphabet_pronunciation,
        );
        ipa_field(
            &mut columns[1],
            tr(language, "발음 (IPA)", "Pronunciation (IPA)"),
            &mut word.pronunciation,
            format!("word:{}", word.id),
            ipa_state,
            speech,
            profile,
            language,
        );
        labeled_text(
            &mut columns[0],
            tr(language, "품사", "Part of speech"),
            &mut word.part_of_speech,
        );
        labeled_text(
            &mut columns[1],
            tr(language, "어원", "Etymology"),
            &mut word.etymology,
        );
        labeled_text(
            &mut columns[0],
            tr(language, "의미", "Meaning"),
            &mut word.meaning,
        );
        let mut related = word.related_terms.join(", ");
        labeled_text(
            &mut columns[1],
            tr(language, "관련어", "Related terms"),
            &mut related,
        );
        word.related_terms = split_terms(&related);
    });
    labeled_multiline(
        ui,
        tr(language, "용례 및 비고", "Usage notes"),
        &mut word.usage_note,
        3,
    );
}

fn sentence_read_view(
    ui: &mut egui::Ui,
    language: Language,
    sentence: &DictionarySentence,
    glyphs: &[GeneratedGlyph],
    speech: &mut ImsToucanState,
    profile: &crate::model::DictionaryVoiceProfile,
) {
    glyph_sequence(ui, language, &sentence.script_glyph_ids, glyphs);
    read_value(ui, tr(language, "문장", "Sentence"), &sentence.text);
    ipa_read_value(ui, language, &sentence.pronunciation, speech, profile);
    read_value(
        ui,
        tr(language, "번역", "Translation"),
        &sentence.translation,
    );
    read_value(ui, tr(language, "비고", "Notes"), &sentence.note);
}

#[allow(clippy::too_many_arguments)]
fn sentence_edit_form(
    ui: &mut egui::Ui,
    language: Language,
    sentence: &mut DictionarySentence,
    glyphs: &[GeneratedGlyph],
    ipa_state: &mut IpaUiState,
    speech: &mut ImsToucanState,
    profile: &crate::model::DictionaryVoiceProfile,
) {
    labeled_multiline(ui, tr(language, "문장", "Sentence"), &mut sentence.text, 2);
    glyph_sequence_editor(ui, language, &mut sentence.script_glyph_ids, glyphs);
    ui.columns(2, |columns| {
        ipa_field(
            &mut columns[0],
            tr(language, "발음 (IPA)", "Pronunciation (IPA)"),
            &mut sentence.pronunciation,
            format!("sentence:{}", sentence.id),
            ipa_state,
            speech,
            profile,
            language,
        );
        labeled_text(
            &mut columns[1],
            tr(language, "번역", "Translation"),
            &mut sentence.translation,
        );
    });
    labeled_multiline(ui, tr(language, "비고", "Notes"), &mut sentence.note, 2);
}

fn conversation_read_view(
    ui: &mut egui::Ui,
    language: Language,
    conversation: &DictionaryConversation,
    glyphs: &[GeneratedGlyph],
    speech: &mut ImsToucanState,
    profile: &crate::model::DictionaryVoiceProfile,
) {
    read_value(
        ui,
        tr(language, "상황", "Situation"),
        &conversation.situation,
    );
    for line in &conversation.lines {
        ui.separator();
        ui.horizontal(|ui| {
            ui.label(RichText::new(display_or(&line.speaker, "-")).strong());
            ui.label(display_or(&line.text, "-"));
        });
        glyph_sequence(ui, language, &line.script_glyph_ids, glyphs);
        ipa_read_value(ui, language, &line.pronunciation, speech, profile);
        read_value(ui, tr(language, "번역", "Translation"), &line.translation);
        if !line.note.trim().is_empty() {
            read_value(ui, tr(language, "비고", "Notes"), &line.note);
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn conversation_edit_form(
    ui: &mut egui::Ui,
    language: Language,
    conversation: &mut DictionaryConversation,
    glyphs: &[GeneratedGlyph],
    ipa_state: &mut IpaUiState,
    speech: &mut ImsToucanState,
    profile: &crate::model::DictionaryVoiceProfile,
) {
    labeled_text(
        ui,
        tr(language, "회화 제목", "Conversation title"),
        &mut conversation.title,
    );
    labeled_text(
        ui,
        tr(language, "상황", "Situation"),
        &mut conversation.situation,
    );
    let mut remove_line = None;
    for (index, line) in conversation.lines.iter_mut().enumerate() {
        ui.separator();
        ui.horizontal(|ui| {
            ui.add_sized(
                [120.0, 26.0],
                egui::TextEdit::singleline(&mut line.speaker)
                    .hint_text(tr(language, "화자", "Speaker")),
            );
            ui.add_sized(
                [ui.available_width() - 34.0, 26.0],
                egui::TextEdit::singleline(&mut line.text).hint_text(tr(language, "대사", "Line")),
            );
            if ui.small_button("X").clicked() {
                remove_line = Some(index);
            }
        });
        glyph_sequence_editor(ui, language, &mut line.script_glyph_ids, glyphs);
        ui.columns(2, |columns| {
            ipa_field(
                &mut columns[0],
                tr(language, "발음 (IPA)", "Pronunciation (IPA)"),
                &mut line.pronunciation,
                format!("conversation:{}:{index}", conversation.id),
                ipa_state,
                speech,
                profile,
                language,
            );
            labeled_text(
                &mut columns[1],
                tr(language, "번역", "Translation"),
                &mut line.translation,
            );
        });
        labeled_text(ui, tr(language, "비고", "Note"), &mut line.note);
    }
    if let Some(index) = remove_line {
        conversation.lines.remove(index);
    }
    if ui
        .button(tr(language, "+ 대사 추가", "+ Add line"))
        .clicked()
    {
        conversation
            .lines
            .push(DictionaryConversationLine::default());
    }
}

fn reader_actions(
    ui: &mut egui::Ui,
    language: Language,
    action: &mut Option<EntryAction>,
    draft: DictionaryDraft,
    id: &str,
) {
    ui.add_space(6.0);
    ui.horizontal(|ui| {
        if ui.button(tr(language, "편집", "Edit")).clicked() {
            *action = Some(EntryAction::Edit(draft));
        }
        if ui
            .button("X")
            .on_hover_text(tr(language, "삭제", "Delete"))
            .clicked()
        {
            *action = Some(EntryAction::Delete(id.to_owned()));
        }
    });
}

fn editor_actions(
    ui: &mut egui::Ui,
    language: Language,
    action: &mut Option<EntryAction>,
    id: &str,
) {
    ui.add_space(6.0);
    ui.horizontal(|ui| {
        if ui.button(tr(language, "완료", "Done")).clicked() {
            *action = Some(EntryAction::Save);
        }
        if ui.button(tr(language, "취소", "Cancel")).clicked() {
            *action = Some(EntryAction::Cancel);
        }
        if ui
            .button("X")
            .on_hover_text(tr(language, "삭제", "Delete"))
            .clicked()
        {
            *action = Some(EntryAction::Delete(id.to_owned()));
        }
    });
}

fn apply_word_action(
    action: Option<EntryAction>,
    state: &mut DictionaryUiState,
    book: &mut DictionaryBook,
) {
    match action {
        Some(EntryAction::Select(id)) => select_entry(state, id),
        Some(EntryAction::Edit(draft)) => begin_edit(state, draft),
        Some(EntryAction::Save) => {
            if let Some(DictionaryDraft::Word(draft)) = state.draft.take()
                && let Some(word) = book.words.iter_mut().find(|word| word.id == draft.id)
            {
                *word = draft;
            }
            state.editing = false;
        }
        Some(EntryAction::Cancel) => cancel_edit(state),
        Some(EntryAction::Delete(id)) => {
            book.words.retain(|word| word.id != id);
            clear_selection(state);
        }
        _ => {}
    }
}

fn apply_sentence_action(
    action: Option<EntryAction>,
    state: &mut DictionaryUiState,
    book: &mut DictionaryBook,
) {
    match action {
        Some(EntryAction::Select(id)) => select_entry(state, id),
        Some(EntryAction::Edit(draft)) => begin_edit(state, draft),
        Some(EntryAction::Save) => {
            if let Some(DictionaryDraft::Sentence(draft)) = state.draft.take()
                && let Some(sentence) = book
                    .sentences
                    .iter_mut()
                    .find(|sentence| sentence.id == draft.id)
            {
                *sentence = draft;
            }
            state.editing = false;
        }
        Some(EntryAction::Cancel) => cancel_edit(state),
        Some(EntryAction::Delete(id)) => {
            book.sentences.retain(|sentence| sentence.id != id);
            clear_selection(state);
        }
        _ => {}
    }
}

fn apply_conversation_action(
    action: Option<EntryAction>,
    state: &mut DictionaryUiState,
    book: &mut DictionaryBook,
) {
    match action {
        Some(EntryAction::Select(id)) => select_entry(state, id),
        Some(EntryAction::Edit(draft)) => begin_edit(state, draft),
        Some(EntryAction::Save) => {
            if let Some(DictionaryDraft::Conversation(draft)) = state.draft.take()
                && let Some(conversation) = book
                    .conversations
                    .iter_mut()
                    .find(|conversation| conversation.id == draft.id)
            {
                *conversation = draft;
            }
            state.editing = false;
        }
        Some(EntryAction::Cancel) => cancel_edit(state),
        Some(EntryAction::Delete(id)) => {
            book.conversations
                .retain(|conversation| conversation.id != id);
            clear_selection(state);
        }
        _ => {}
    }
}

fn select_entry(state: &mut DictionaryUiState, id: String) {
    if state.selected_id.as_deref() == Some(id.as_str()) {
        clear_selection(state);
    } else {
        state.selected_id = Some(id);
        state.editing = false;
        state.draft = None;
    }
}

fn begin_edit(state: &mut DictionaryUiState, draft: DictionaryDraft) {
    state.editing = true;
    state.draft = Some(draft);
}

fn cancel_edit(state: &mut DictionaryUiState) {
    state.editing = false;
    state.draft = None;
}

fn clear_selection(state: &mut DictionaryUiState) {
    state.selected_id = None;
    cancel_edit(state);
}

fn preview_button(ui: &mut egui::Ui, selected: bool, title: &str, summary: &str) -> egui::Response {
    let colors = theme::palette(ui.visuals().dark_mode);
    let (rect, response) =
        ui.allocate_exact_size(Vec2::new(ui.available_width(), 48.0), Sense::click());
    if response.hovered() || selected {
        ui.painter().rect_filled(
            rect,
            3.0,
            if selected {
                colors.selected
            } else {
                colors.hover
            },
        );
    }
    ui.painter().text(
        rect.left_center() + Vec2::new(7.0, -8.0),
        egui::Align2::LEFT_CENTER,
        title,
        egui::FontId::proportional(13.0),
        colors.title,
    );
    ui.painter().text(
        rect.left_center() + Vec2::new(7.0, 10.0),
        egui::Align2::LEFT_CENTER,
        summary,
        egui::FontId::proportional(9.5),
        colors.muted,
    );
    response
}

fn glyph_sequence(
    ui: &mut egui::Ui,
    language: Language,
    glyph_ids: &[String],
    glyphs: &[GeneratedGlyph],
) {
    ui.label(
        RichText::new(tr(language, "생성 문자", "Generated script"))
            .size(8.5)
            .color(ui.visuals().weak_text_color()),
    );
    ui.horizontal_wrapped(|ui| {
        let mut found = false;
        for id in glyph_ids {
            if let Some(glyph) = glyphs.iter().find(|glyph| glyph.id == *id) {
                found = true;
                glyph_preview(ui, glyph, 38.0, false);
            }
        }
        if !found {
            ui.label("-");
        }
    });
}

fn glyph_sequence_editor(
    ui: &mut egui::Ui,
    language: Language,
    glyph_ids: &mut Vec<String>,
    glyphs: &[GeneratedGlyph],
) {
    ui.label(
        RichText::new(tr(language, "생성 문자", "Generated script"))
            .size(8.5)
            .color(ui.visuals().weak_text_color()),
    );
    let mut remove = None;
    ui.horizontal_wrapped(|ui| {
        for (index, id) in glyph_ids.iter().enumerate() {
            if let Some(glyph) = glyphs.iter().find(|glyph| glyph.id == *id) {
                if glyph_preview(ui, glyph, 42.0, true)
                    .on_hover_text(tr(language, "클릭하여 제거", "Click to remove"))
                    .clicked()
                {
                    remove = Some(index);
                }
            }
        }
        if glyph_ids.is_empty() {
            ui.label(RichText::new("-").color(ui.visuals().weak_text_color()));
        }
    });
    if let Some(index) = remove {
        glyph_ids.remove(index);
    }
    egui::CollapsingHeader::new(tr(
        language,
        "문자 생성기 글리프 추가",
        "Add Character Generator glyph",
    ))
    .default_open(false)
    .show(ui, |ui| {
        ui.horizontal_wrapped(|ui| {
            for glyph in glyphs {
                if glyph_preview(ui, glyph, 46.0, true)
                    .on_hover_text(format!("{}\n{}", glyph.name, glyph.meaning))
                    .clicked()
                {
                    glyph_ids.push(glyph.id.clone());
                }
            }
        });
        if glyphs.is_empty() {
            ui.label(tr(
                language,
                "문자 생성기에서 먼저 문자를 제작하세요.",
                "Create characters in the Character Generator first.",
            ));
        }
    });
}

fn glyph_preview(
    ui: &mut egui::Ui,
    glyph: &GeneratedGlyph,
    side: f32,
    interactive: bool,
) -> egui::Response {
    let sense = if interactive {
        Sense::click()
    } else {
        Sense::hover()
    };
    let (rect, response) = ui.allocate_exact_size(Vec2::splat(side), sense);
    ui.painter().rect(
        rect,
        CornerRadius::same(3),
        Color32::WHITE,
        Stroke::new(1.0, ui.visuals().widgets.noninteractive.bg_stroke.color),
        egui::StrokeKind::Inside,
    );
    crate::scripts::paint_alpha_runs(
        ui.painter(),
        rect.shrink(4.0),
        glyph.width as usize,
        glyph.height as usize,
        &glyph.alpha_runs,
        Color32::BLACK,
    );
    response
}

fn ipa_read_value(
    ui: &mut egui::Ui,
    language: Language,
    value: &str,
    speech: &mut ImsToucanState,
    profile: &crate::model::DictionaryVoiceProfile,
) {
    ui.label(
        RichText::new(tr(language, "발음 (IPA)", "Pronunciation (IPA)"))
            .size(8.5)
            .color(ui.visuals().weak_text_color()),
    );
    ui.horizontal(|ui| {
        ui.label(display_or(value, "-"));
        if ui
            .add_enabled(!value.trim().is_empty(), egui::Button::new("▶"))
            .on_hover_text(tr(language, "발음 듣기", "Play pronunciation"))
            .clicked()
        {
            let _ = speech.request(language, value, profile);
        }
        if speech.is_generating(value, profile) {
            ui.label(
                RichText::new(tr(language, "발음 생성 중", "Generating pronunciation"))
                    .size(8.5)
                    .color(theme::palette(ui.visuals().dark_mode).accent),
            );
        }
    });
}

fn read_value(ui: &mut egui::Ui, label: &str, value: &str) {
    ui.label(
        RichText::new(label)
            .size(8.5)
            .color(ui.visuals().weak_text_color()),
    );
    ui.label(display_or(value, "-"));
    ui.add_space(4.0);
}

fn voice_profile_editor(
    ui: &mut egui::Ui,
    language: Language,
    book: &mut DictionaryBook,
    speech: &mut ImsToucanState,
) {
    egui::CollapsingHeader::new(tr(
        language,
        "IMS-Toucan 음성 설정",
        "IMS-Toucan Voice Profile",
    ))
    .default_open(false)
    .show(ui, |ui| {
        let before = book.voice_profile.clone();
        ui.horizontal_wrapped(|ui| {
            egui::ComboBox::from_id_salt("dictionary-voice-id")
                .selected_text(&book.voice_profile.voice_id)
                .show_ui(ui, |ui| {
                    for voice in speech.available_voice_ids() {
                        ui.selectable_value(&mut book.voice_profile.voice_id, voice.clone(), voice);
                    }
                });
            ui.add(
                egui::Slider::new(&mut book.voice_profile.speed, 0.5..=2.0)
                    .text(tr(language, "속도", "Speed")),
            );
            ui.add(
                egui::Slider::new(&mut book.voice_profile.pitch, 0.7..=1.4)
                    .text(tr(language, "높이", "Pitch")),
            );
            ui.add(
                egui::Slider::new(&mut book.voice_profile.volume, 0.0..=1.0)
                    .text(tr(language, "음량", "Volume")),
            );
        });
        if before != book.voice_profile {
            speech.invalidate_profile(&before);
        }
        if let Some(summary) = speech.engine_summary() {
            ui.label(
                RichText::new(summary)
                    .size(8.5)
                    .color(ui.visuals().weak_text_color()),
            );
        }
        if !speech.status.is_empty() {
            ui.label(
                RichText::new(&speech.status)
                    .size(9.0)
                    .color(ui.visuals().weak_text_color()),
            );
        }
    });
}

#[allow(clippy::too_many_arguments)]
fn ipa_field(
    ui: &mut egui::Ui,
    label: &str,
    value: &mut String,
    target: String,
    ipa_state: &mut IpaUiState,
    speech: &mut ImsToucanState,
    profile: &crate::model::DictionaryVoiceProfile,
    language: Language,
) {
    ui.label(
        RichText::new(label)
            .size(8.5)
            .color(ui.visuals().weak_text_color()),
    );
    ui.horizontal(|ui| {
        let response = ui.add_sized(
            [ui.available_width() - 34.0, 26.0],
            egui::TextEdit::singleline(value),
        );
        if response.has_focus() {
            ipa_state.focus(target, value.chars().count());
        }
        if ui
            .add_enabled(!value.trim().is_empty(), egui::Button::new("▶"))
            .on_hover_text(tr(language, "IPA 발음 듣기", "Play IPA pronunciation"))
            .clicked()
        {
            let _ = speech.request(language, value, profile);
        }
        if speech.is_generating(value, profile) {
            ui.label(
                RichText::new(tr(language, "발음 생성 중", "Generating"))
                    .size(8.5)
                    .color(theme::palette(ui.visuals().dark_mode).accent),
            );
        }
    });
    let unsupported = ipa::unsupported_symbols(value);
    if !unsupported.is_empty() {
        ui.label(
            RichText::new(format!(
                "{}: {}",
                tr(
                    language,
                    "지원되지 않거나 모호한 IPA",
                    "Unsupported or ambiguous IPA"
                ),
                unsupported.join(" ")
            ))
            .size(8.5)
            .color(theme::palette(ui.visuals().dark_mode).danger),
        );
    }
}

fn apply_ipa_insert(
    book: &mut DictionaryBook,
    ui_state: &mut DictionaryUiState,
    state: &mut IpaUiState,
    symbol: &str,
) {
    let Some(target) = state.active_target.clone() else {
        return;
    };
    let inserted = match ui_state.draft.as_mut() {
        Some(DictionaryDraft::Word(entry)) => insert_word_ipa(entry, &target, state, symbol),
        Some(DictionaryDraft::Sentence(entry)) => {
            insert_sentence_ipa(entry, &target, state, symbol)
        }
        Some(DictionaryDraft::Conversation(entry)) => {
            insert_conversation_ipa(entry, &target, state, symbol)
        }
        None => false,
    } || book
        .words
        .iter_mut()
        .any(|entry| insert_word_ipa(entry, &target, state, symbol))
        || book
            .sentences
            .iter_mut()
            .any(|entry| insert_sentence_ipa(entry, &target, state, symbol))
        || book
            .conversations
            .iter_mut()
            .any(|entry| insert_conversation_ipa(entry, &target, state, symbol));
    if !inserted {
        state.clear_focus();
    }
}

fn insert_word_ipa(
    entry: &mut DictionaryWord,
    target: &str,
    state: &mut IpaUiState,
    symbol: &str,
) -> bool {
    let Some(id) = target.strip_prefix("word:") else {
        return false;
    };
    if entry.id != id {
        return false;
    }
    state.caret = ipa::insert_at_char(&mut entry.pronunciation, state.caret, symbol);
    true
}

fn insert_sentence_ipa(
    entry: &mut DictionarySentence,
    target: &str,
    state: &mut IpaUiState,
    symbol: &str,
) -> bool {
    let Some(id) = target.strip_prefix("sentence:") else {
        return false;
    };
    if entry.id != id {
        return false;
    }
    state.caret = ipa::insert_at_char(&mut entry.pronunciation, state.caret, symbol);
    true
}

fn insert_conversation_ipa(
    entry: &mut DictionaryConversation,
    target: &str,
    state: &mut IpaUiState,
    symbol: &str,
) -> bool {
    let Some(rest) = target.strip_prefix("conversation:") else {
        return false;
    };
    let Some((conversation_id, line_index)) = rest.rsplit_once(':') else {
        return false;
    };
    let Ok(line_index) = line_index.parse::<usize>() else {
        return false;
    };
    if entry.id != conversation_id {
        return false;
    }
    let Some(line) = entry.lines.get_mut(line_index) else {
        return false;
    };
    state.caret = ipa::insert_at_char(&mut line.pronunciation, state.caret, symbol);
    true
}

fn entry_frame(ui: &mut egui::Ui, dark: bool, add_contents: impl FnOnce(&mut egui::Ui)) {
    let colors = theme::palette(dark);
    egui::Frame::new()
        .fill(colors.surface_soft)
        .stroke(Stroke::new(1.0, colors.border))
        .corner_radius(CornerRadius::same(5))
        .inner_margin(Margin::same(9))
        .show(ui, add_contents);
}

fn labeled_text(ui: &mut egui::Ui, label: &str, value: &mut String) {
    ui.vertical(|ui| {
        ui.label(
            RichText::new(label)
                .size(8.5)
                .color(ui.visuals().weak_text_color()),
        );
        ui.add_sized(
            [ui.available_width(), 26.0],
            egui::TextEdit::singleline(value),
        );
    });
}

fn labeled_readonly(ui: &mut egui::Ui, label: &str, value: &str) {
    ui.vertical(|ui| {
        ui.label(
            RichText::new(label)
                .size(8.5)
                .color(ui.visuals().weak_text_color()),
        );
        let mut display = value.to_owned();
        ui.add_enabled(
            false,
            egui::TextEdit::singleline(&mut display).desired_width(ui.available_width()),
        );
    });
}

pub fn ipa_to_alphabet(ipa_value: &str, profile: &crate::model::DictionaryVoiceProfile) -> String {
    let mut value = ipa::normalize(ipa_value)
        .trim_matches(|character: char| {
            character.is_whitespace() || matches!(character, '/' | '[' | ']')
        })
        .to_owned();
    let mut rules = profile.grapheme_rules.iter().collect::<Vec<_>>();
    rules.sort_by_key(|rule| std::cmp::Reverse(rule.ipa.chars().count()));
    for rule in rules {
        if !rule.ipa.is_empty() && !rule.grapheme.is_empty() {
            value = value.replace(&rule.ipa, &rule.grapheme);
        }
    }
    for (source, target) in [
        ("tʃ", "ch"),
        ("dʒ", "j"),
        ("ʃ", "sh"),
        ("ʒ", "zh"),
        ("θ", "th"),
        ("ð", "dh"),
        ("ŋ", "ng"),
        ("ɲ", "ny"),
        ("ɹ", "r"),
        ("ɾ", "r"),
        ("ʎ", "lh"),
        ("ʔ", "'"),
        ("ɑ", "a"),
        ("ɐ", "a"),
        ("æ", "ae"),
        ("ə", "e"),
        ("ɛ", "e"),
        ("ɪ", "i"),
        ("ɨ", "i"),
        ("ɔ", "o"),
        ("ʊ", "u"),
        ("ɯ", "u"),
        ("ʌ", "eo"),
        ("œ", "oe"),
        ("y", "u"),
        ("ː", ""),
        ("ˈ", ""),
        ("ˌ", ""),
    ] {
        value = value.replace(source, target);
    }
    value
}

fn labeled_multiline(ui: &mut egui::Ui, label: &str, value: &mut String, rows: usize) {
    ui.label(
        RichText::new(label)
            .size(8.5)
            .color(ui.visuals().weak_text_color()),
    );
    ui.add_sized(
        [ui.available_width(), rows as f32 * 24.0],
        egui::TextEdit::multiline(value).desired_rows(rows),
    );
}

fn matches_word(word: &DictionaryWord, query: &str) -> bool {
    query.is_empty()
        || [
            word.term.as_str(),
            word.pronunciation.as_str(),
            word.alphabet_pronunciation.as_str(),
            word.meaning.as_str(),
            word.part_of_speech.as_str(),
            word.etymology.as_str(),
        ]
        .iter()
        .any(|value| value.to_lowercase().contains(query))
}

fn matches_sentence(sentence: &DictionarySentence, query: &str) -> bool {
    query.is_empty()
        || [
            sentence.text.as_str(),
            sentence.translation.as_str(),
            sentence.note.as_str(),
        ]
        .iter()
        .any(|value| value.to_lowercase().contains(query))
}

fn matches_conversation(conversation: &DictionaryConversation, query: &str) -> bool {
    query.is_empty()
        || conversation.title.to_lowercase().contains(query)
        || conversation.situation.to_lowercase().contains(query)
        || conversation.lines.iter().any(|line| {
            line.speaker.to_lowercase().contains(query)
                || line.text.to_lowercase().contains(query)
                || line.translation.to_lowercase().contains(query)
        })
}

fn split_terms(value: &str) -> Vec<String> {
    value
        .split([',', '|'])
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .collect()
}

fn display_or<'a>(value: &'a str, fallback: &'a str) -> &'a str {
    if value.trim().is_empty() {
        fallback
    } else {
        value
    }
}

fn one_line(value: &str) -> String {
    let text = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.is_empty() {
        "-".to_owned()
    } else {
        text
    }
}

fn next_id<'a>(prefix: &str, ids: impl Iterator<Item = &'a str>) -> String {
    let existing = ids.collect::<std::collections::HashSet<_>>();
    let mut serial = existing.len() + 1;
    loop {
        let candidate = format!("{prefix}-{serial}");
        if !existing.contains(candidate.as_str()) {
            return candidate;
        }
        serial += 1;
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
    use crate::model::{DictionaryVoiceProfile, GraphemeRule};

    #[test]
    fn alphabet_pronunciation_uses_language_rules_before_fallbacks() {
        let mut profile = DictionaryVoiceProfile::default();
        profile.grapheme_rules.push(GraphemeRule {
            grapheme: "x".to_owned(),
            ipa: "ʃ".to_owned(),
        });
        assert_eq!(ipa_to_alphabet("/taʃ/", &profile), "tax");
        assert_eq!(
            ipa_to_alphabet("tʃaŋ", &DictionaryVoiceProfile::default()),
            "chang"
        );
    }

    #[test]
    fn generated_script_fields_round_trip() {
        let word = DictionaryWord {
            script_glyph_ids: vec!["glyph-1".to_owned(), "glyph-2".to_owned()],
            ..DictionaryWord::default()
        };
        let json = serde_json::to_string(&word).expect("serialize dictionary word");
        let decoded: DictionaryWord = serde_json::from_str(&json).expect("deserialize word");
        assert_eq!(decoded.script_glyph_ids, word.script_glyph_ids);
    }
}
