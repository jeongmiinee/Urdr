use std::collections::HashSet;

use eframe::egui::{self, RichText};

use crate::{
    calendar::{self, TimelineMoment},
    model::{Article, CalendarProfile, Language},
};

pub const FIELD_LABEL_WIDTH: f32 = 112.0;
pub const FIELD_HEIGHT: f32 = 27.0;

fn field_label(ui: &mut egui::Ui, label: &str) {
    ui.add_sized(
        [FIELD_LABEL_WIDTH, FIELD_HEIGHT],
        egui::Label::new(RichText::new(label).size(9.5)).truncate(),
    );
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UReferenceOption {
    pub id: String,
    pub title: String,
    pub category: String,
    pub aliases: Vec<String>,
    pub legacy_ids: Vec<String>,
}

pub fn reference_options(articles: &[Article]) -> Vec<UReferenceOption> {
    let mut seen = HashSet::new();
    articles
        .iter()
        .filter(|article| seen.insert(article.id.clone()))
        .map(|article| UReferenceOption {
            id: article.id.clone(),
            title: article.title.clone(),
            category: article.category.clone(),
            aliases: article.wiki_aliases.clone(),
            legacy_ids: article.source_entity_id.iter().cloned().collect(),
        })
        .collect()
}

pub fn option_matches_category(option: &UReferenceOption, categories: &[&str]) -> bool {
    categories.is_empty()
        || categories.iter().any(|category| {
            option.category.eq_ignore_ascii_case(category)
                || option
                    .category
                    .to_lowercase()
                    .contains(&category.to_lowercase())
        })
}

pub fn canonical_reference_id<'a>(value: &str, options: &'a [UReferenceOption]) -> Option<&'a str> {
    options
        .iter()
        .find(|option| option.id == value || option.legacy_ids.iter().any(|legacy| legacy == value))
        .map(|option| option.id.as_str())
}

fn option_for_value<'a>(
    value: &str,
    options: &'a [UReferenceOption],
) -> Option<&'a UReferenceOption> {
    let id = canonical_reference_id(value, options)?;
    options.iter().find(|option| option.id == id)
}

fn normalize_search(value: &str) -> String {
    value.trim().to_lowercase()
}

fn search_rank(option: &UReferenceOption, query: &str) -> Option<(u8, usize, String)> {
    let title = normalize_search(&option.title);
    let aliases = option
        .aliases
        .iter()
        .map(|alias| normalize_search(alias))
        .collect::<Vec<_>>();
    if title == query || aliases.iter().any(|alias| alias == query) {
        return Some((0, title.len(), title));
    }
    if title.starts_with(query) || aliases.iter().any(|alias| alias.starts_with(query)) {
        return Some((1, title.len(), title));
    }
    if title.contains(query) || aliases.iter().any(|alias| alias.contains(query)) {
        return Some((2, title.len(), title));
    }
    None
}

pub fn matching_options<'a>(
    query: &str,
    options: &'a [UReferenceOption],
    categories: &[&str],
    limit: usize,
) -> Vec<&'a UReferenceOption> {
    let query = normalize_search(query);
    if query.is_empty() {
        return Vec::new();
    }
    let mut matches = options
        .iter()
        .filter(|option| option_matches_category(option, categories))
        .filter_map(|option| search_rank(option, &query).map(|rank| (rank, option)))
        .collect::<Vec<_>>();
    matches.sort_by(|(left_rank, left), (right_rank, right)| {
        left_rank
            .cmp(right_rank)
            .then_with(|| left.title.cmp(&right.title))
            .then_with(|| left.id.cmp(&right.id))
    });
    matches
        .into_iter()
        .map(|(_, option)| option)
        .take(limit)
        .collect()
}

fn localized(language: Language, korean: &'static str, english: &'static str) -> &'static str {
    match language {
        Language::Korean => korean,
        Language::English => english,
    }
}

fn single_display_value(
    object: &serde_json::Map<String, serde_json::Value>,
    reference_key: &str,
    custom_key: Option<&str>,
    options: &[UReferenceOption],
) -> (String, Option<String>) {
    let stored = object
        .get(reference_key)
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    if let Some(option) = option_for_value(stored, options) {
        return (option.title.clone(), Some(option.id.clone()));
    }
    let custom = custom_key
        .and_then(|key| object.get(key))
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(stored);
    (custom.to_owned(), None)
}

pub fn u_input_single(
    ui: &mut egui::Ui,
    language: Language,
    id_salt: impl std::hash::Hash + std::fmt::Debug,
    label: &str,
    object: &mut serde_json::Map<String, serde_json::Value>,
    reference_key: &str,
    custom_key: Option<&str>,
    options: &[UReferenceOption],
    categories: &[&str],
) {
    let (mut input, selected_id) = single_display_value(object, reference_key, custom_key, options);
    let field_id = ui.make_persistent_id(("u-input-single", id_salt));
    let response = ui
        .horizontal(|ui| {
            field_label(ui, label);
            ui.add_sized(
                [ui.available_width().max(100.0), FIELD_HEIGHT],
                egui::TextEdit::singleline(&mut input)
                    .id(field_id)
                    .hint_text(localized(
                        language,
                        "문서 검색 또는 직접 입력",
                        "Search documents or enter text",
                    )),
            )
        })
        .inner;

    let mut next_selected = selected_id;
    if response.changed() {
        next_selected = None;
    }
    let query_matches = matching_options(&input, options, categories, 8);
    let popup_id = field_id.with("results");
    let should_open = response.has_focus() && !input.trim().is_empty();
    let mut picked = None;
    egui::Popup::from_response(&response)
        .id(popup_id)
        .open(should_open)
        .close_behavior(egui::PopupCloseBehavior::CloseOnClickOutside)
        .width(response.rect.width().max(220.0))
        .show(|ui| {
            ui.set_min_width(response.rect.width().max(220.0));
            if query_matches.is_empty() {
                ui.label(
                    RichText::new(localized(
                        language,
                        "일치하는 문서가 없습니다. 입력값은 그대로 사용할 수 있습니다.",
                        "No matching document. The text can still be used as entered.",
                    ))
                    .size(9.0)
                    .color(ui.visuals().weak_text_color()),
                );
            } else {
                for option in &query_matches {
                    let alias_note = option
                        .aliases
                        .iter()
                        .find(|alias| normalize_search(alias).contains(&normalize_search(&input)))
                        .filter(|alias| !alias.eq_ignore_ascii_case(&option.title));
                    let text = alias_note.map_or_else(
                        || option.title.clone(),
                        |alias| format!("{} · {}", option.title, alias),
                    );
                    if ui
                        .add_sized([ui.available_width(), 26.0], egui::Button::new(text))
                        .clicked()
                    {
                        picked = Some((option.id.clone(), option.title.clone()));
                        ui.close();
                    }
                }
            }
        });

    if let Some((id, title)) = picked {
        next_selected = Some(id);
        input = title;
    }
    let mode_key = format!("{reference_key}Mode");
    if let Some(id) = next_selected {
        object.insert(reference_key.to_owned(), serde_json::Value::String(id));
        if let Some(custom_key) = custom_key {
            object.insert(
                custom_key.to_owned(),
                serde_json::Value::String(format!("[[{input}]]")),
            );
        }
        object.insert(mode_key, serde_json::Value::String("reference".to_owned()));
    } else {
        let value = input.trim().to_owned();
        if let Some(custom_key) = custom_key {
            object.remove(reference_key);
            if value.is_empty() {
                object.remove(custom_key);
                object.insert(
                    mode_key,
                    serde_json::Value::String("unspecified".to_owned()),
                );
            } else {
                object.insert(custom_key.to_owned(), serde_json::Value::String(value));
                object.insert(mode_key, serde_json::Value::String("custom".to_owned()));
            }
        } else if value.is_empty() {
            object.remove(reference_key);
            object.insert(
                mode_key,
                serde_json::Value::String("unspecified".to_owned()),
            );
        } else {
            object.insert(reference_key.to_owned(), serde_json::Value::String(value));
            object.insert(mode_key, serde_json::Value::String("custom".to_owned()));
        }
    }
}

fn string_array(object: &serde_json::Map<String, serde_json::Value>, key: &str) -> Vec<String> {
    object
        .get(key)
        .and_then(serde_json::Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(serde_json::Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn value_array(values: Vec<String>) -> serde_json::Value {
    serde_json::Value::Array(values.into_iter().map(serde_json::Value::String).collect())
}

pub fn u_input_multi(
    ui: &mut egui::Ui,
    language: Language,
    id_salt: impl std::hash::Hash + std::fmt::Debug,
    label: &str,
    object: &mut serde_json::Map<String, serde_json::Value>,
    reference_key: &str,
    custom_key: &str,
    options: &[UReferenceOption],
    categories: &[&str],
) {
    let custom_values_key = format!("{custom_key}Values");
    let mut selected = string_array(object, reference_key)
        .into_iter()
        .filter_map(|value| canonical_reference_id(&value, options).map(str::to_owned))
        .collect::<Vec<_>>();
    selected.sort();
    selected.dedup();
    let mut custom = string_array(object, &custom_values_key);
    if custom.is_empty() {
        if let Some(value) = object
            .get(custom_key)
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.trim().is_empty())
        {
            custom.extend(
                value
                    .split(',')
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_owned),
            );
        }
    }

    let field_id = ui.make_persistent_id(("u-input-multi", id_salt));
    let mut input = ui
        .ctx()
        .data_mut(|data| data.get_temp::<String>(field_id).unwrap_or_default());
    let response = ui
        .horizontal(|ui| {
            field_label(ui, label);
            let add_width = 30.0;
            let response = ui.add_sized(
                [
                    (ui.available_width() - add_width - 4.0).max(100.0),
                    FIELD_HEIGHT,
                ],
                egui::TextEdit::singleline(&mut input)
                    .id(field_id.with("edit"))
                    .hint_text(localized(
                        language,
                        "문서 검색 또는 직접 입력",
                        "Search documents or enter text",
                    )),
            );
            let add = ui
                .add_enabled(
                    !input.trim().is_empty(),
                    egui::Button::new("＋").min_size(egui::vec2(add_width, FIELD_HEIGHT)),
                )
                .on_hover_text(localized(language, "입력값 추가", "Add entered value"));
            (response, add.clicked())
        })
        .inner;
    let text_response = response.0;
    let enter = text_response.has_focus() && ui.input(|input| input.key_pressed(egui::Key::Enter));
    let mut add_custom = response.1 || enter;
    let matches = matching_options(&input, options, categories, 8);
    let mut picked = None;
    egui::Popup::from_response(&text_response)
        .id(field_id.with("results"))
        .open(text_response.has_focus() && !input.trim().is_empty())
        .close_behavior(egui::PopupCloseBehavior::CloseOnClickOutside)
        .width(text_response.rect.width().max(220.0))
        .show(|ui| {
            if matches.is_empty() {
                ui.label(
                    RichText::new(localized(
                        language,
                        "Enter 또는 +로 고유 입력값을 추가합니다.",
                        "Press Enter or + to add a custom value.",
                    ))
                    .size(9.0)
                    .color(ui.visuals().weak_text_color()),
                );
            } else {
                for option in &matches {
                    if ui
                        .add_sized(
                            [ui.available_width(), 26.0],
                            egui::Button::new(&option.title),
                        )
                        .clicked()
                    {
                        picked = Some(option.id.clone());
                        ui.close();
                    }
                }
            }
        });
    if add_custom {
        if let Some(exact) = matches.iter().find(|option| {
            option.title.eq_ignore_ascii_case(input.trim())
                || option
                    .aliases
                    .iter()
                    .any(|alias| alias.eq_ignore_ascii_case(input.trim()))
        }) {
            picked = Some(exact.id.clone());
            add_custom = false;
        }
    }
    if let Some(id) = picked {
        if !selected.contains(&id) {
            selected.push(id);
        }
        input.clear();
    } else if add_custom {
        let value = input.trim();
        if !value.is_empty() && !custom.iter().any(|entry| entry.eq_ignore_ascii_case(value)) {
            custom.push(value.to_owned());
        }
        input.clear();
    }
    ui.ctx().data_mut(|data| data.insert_temp(field_id, input));

    let mut remove_reference = None;
    let mut remove_custom = None;
    ui.horizontal_wrapped(|ui| {
        for (index, id) in selected.iter().enumerate() {
            let title = option_for_value(id, options)
                .map(|option| option.title.as_str())
                .unwrap_or(id);
            ui.group(|ui| {
                ui.horizontal(|ui| {
                    ui.label(RichText::new(title).color(ui.visuals().hyperlink_color));
                    if ui.small_button("×").clicked() {
                        remove_reference = Some(index);
                    }
                });
            });
        }
        for (index, value) in custom.iter().enumerate() {
            ui.group(|ui| {
                ui.horizontal(|ui| {
                    ui.label(value);
                    if ui.small_button("×").clicked() {
                        remove_custom = Some(index);
                    }
                });
            });
        }
    });
    if let Some(index) = remove_reference {
        selected.remove(index);
    }
    if let Some(index) = remove_custom {
        custom.remove(index);
    }
    object.insert(reference_key.to_owned(), value_array(selected));
    object.insert(custom_values_key, value_array(custom.clone()));
    if custom.is_empty() {
        object.remove(custom_key);
    } else {
        object.insert(
            custom_key.to_owned(),
            serde_json::Value::String(custom.join(", ")),
        );
    }
}

pub fn u_date_json(
    ui: &mut egui::Ui,
    language: Language,
    id_salt: impl std::hash::Hash + std::fmt::Debug,
    label: &str,
    object: &mut serde_json::Map<String, serde_json::Value>,
    key: &str,
    display_calendar: &CalendarProfile,
    orbital_period_days: f64,
    calendar_options: &[(String, CalendarProfile)],
) {
    let absolute_key = format!("{key}AbsoluteDay");
    let calendar_key = format!("{key}CalendarId");
    let show_time_key = format!("{key}ShowTime");
    let stored_year = object.get(key).and_then(json_year);
    let mut absolute = object
        .get(&absolute_key)
        .and_then(serde_json::Value::as_f64)
        .or_else(|| {
            stored_year.map(|year| {
                calendar::absolute_day(TimelineMoment::new(year, 0.0), orbital_period_days)
            })
        });
    let mut selected_id = object
        .get(&calendar_key)
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let mut show_time = object
        .get(&show_time_key)
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let selected_calendar = calendar_options
        .iter()
        .find(|(id, _)| id == &selected_id)
        .map(|(_, profile)| profile)
        .unwrap_or(display_calendar);
    let precision = selected_calendar.date_units.len().saturating_sub(1)
        + if show_time {
            selected_calendar.time_units.len()
        } else {
            0
        };
    let button_text = absolute
        .map(|day| {
            calendar::format_absolute_moment_precision(
                selected_calendar,
                language,
                calendar::timeline_moment_from_absolute_day(day, orbital_period_days),
                orbital_period_days,
                precision,
            )
        })
        .unwrap_or_else(|| "-".to_owned());
    let button = ui
        .horizontal(|ui| {
            field_label(ui, label);
            ui.add_sized(
                [ui.available_width().max(120.0), FIELD_HEIGHT],
                egui::Button::new(button_text),
            )
        })
        .inner;

    let popup_id = ui.make_persistent_id(("u-date", id_salt));
    let mut changed = false;
    let mut cleared = false;
    egui::Popup::from_toggle_button_response(&button)
        .id(popup_id)
        .close_behavior(egui::PopupCloseBehavior::CloseOnClickOutside)
        .width(button.rect.width().max(330.0))
        .show(|ui| {
            ui.set_min_width(button.rect.width().max(330.0));
            ui.label(
                RichText::new(localized(language, "표시 역법", "Calendar"))
                    .size(9.0)
                    .color(ui.visuals().weak_text_color()),
            );
            let selected_name = calendar_options
                .iter()
                .find(|(id, _)| id == &selected_id)
                .map(|(_, profile)| profile.calendar_name.as_str())
                .unwrap_or(&display_calendar.calendar_name);
            egui::ComboBox::from_id_salt(("u-date-calendar", key))
                .selected_text(selected_name)
                .width(ui.available_width())
                .show_ui(ui, |ui| {
                    if calendar_options.is_empty() {
                        ui.label(&display_calendar.calendar_name);
                    }
                    for (id, profile) in calendar_options {
                        if ui
                            .selectable_value(&mut selected_id, id.clone(), &profile.calendar_name)
                            .changed()
                        {
                            changed = true;
                        }
                    }
                });

            let active_calendar = calendar_options
                .iter()
                .find(|(id, _)| id == &selected_id)
                .map(|(_, profile)| profile)
                .unwrap_or(display_calendar);
            let moment = absolute
                .map(|day| calendar::timeline_moment_from_absolute_day(day, orbital_period_days));
            let coordinates = moment
                .map(|moment| {
                    calendar::calendar_coordinates(active_calendar, moment, orbital_period_days)
                })
                .unwrap_or(calendar::CalendarCoordinates {
                    year: 0,
                    year_fraction: 0.0,
                });
            let mut year = coordinates.year;
            let mut date_values = calendar::day_units(active_calendar, coordinates.year_fraction);
            let mut time_values = calendar::time_units(active_calendar, coordinates.year_fraction);
            ui.separator();
            ui.horizontal_wrapped(|ui| {
                let year_unit = active_calendar
                    .date_units
                    .first()
                    .map(|unit| unit.short_name.as_str())
                    .unwrap_or(localized(language, "년", "yr"));
                ui.label(year_unit);
                changed |= ui.add(egui::DragValue::new(&mut year).speed(1)).changed();
                for (index, unit) in active_calendar.date_units.iter().skip(1).enumerate() {
                    ui.label(&unit.short_name);
                    if let Some(value) = date_values.get_mut(index) {
                        changed |= ui
                            .add(
                                egui::DragValue::new(value).range(1..=unit.units_per_parent.max(1)),
                            )
                            .changed();
                    }
                }
            });
            if ui
                .checkbox(
                    &mut show_time,
                    localized(language, "시간 표시", "Show Time"),
                )
                .changed()
            {
                object.insert(show_time_key.clone(), serde_json::Value::Bool(show_time));
            }
            if show_time {
                ui.horizontal_wrapped(|ui| {
                    for (index, unit) in active_calendar.time_units.iter().enumerate() {
                        ui.label(&unit.short_name);
                        if let Some(value) = time_values.get_mut(index) {
                            changed |= ui
                                .add(
                                    egui::DragValue::new(value)
                                        .range(0..=unit.units_per_parent.saturating_sub(1)),
                                )
                                .changed();
                        }
                    }
                });
            }
            ui.separator();
            if ui
                .add_sized(
                    [ui.available_width(), 27.0],
                    egui::Button::new(localized(language, "날짜 비우기", "Clear Date")),
                )
                .clicked()
            {
                cleared = true;
            }

            if changed {
                let converted = calendar::timeline_moment_from_calendar(
                    active_calendar,
                    year,
                    &date_values,
                    &time_values,
                    orbital_period_days,
                );
                absolute = Some(calendar::absolute_day(converted, orbital_period_days));
            }
        });

    if cleared {
        object.remove(key);
        object.remove(&absolute_key);
        object.remove(&calendar_key);
        object.remove(&show_time_key);
    } else {
        if let Some(day) = absolute {
            let moment = calendar::timeline_moment_from_absolute_day(day, orbital_period_days);
            object.insert(key.to_owned(), serde_json::json!(moment.world_year));
            object.insert(absolute_key, serde_json::json!(day));
        }
        if !selected_id.is_empty() {
            object.insert(calendar_key, serde_json::Value::String(selected_id));
        }
        object.insert(show_time_key, serde_json::Value::Bool(show_time));
    }
}

fn json_year(value: &serde_json::Value) -> Option<i32> {
    if let Some(year) = value.as_i64() {
        return Some(year as i32);
    }
    if let Some(year) = value.as_f64() {
        return Some(year as i32);
    }
    if let Some(year) = value.get("year").and_then(serde_json::Value::as_i64) {
        return Some(year as i32);
    }
    let text = value.as_str()?.trim();
    let mut number = String::new();
    for (index, character) in text.chars().enumerate() {
        if character.is_ascii_digit() || (character == '-' && index == 0) {
            number.push(character);
        } else if !number.is_empty() {
            break;
        }
    }
    number.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::ArticleProfiles;

    fn article(id: &str, title: &str, aliases: &[&str], source: Option<&str>) -> Article {
        Article {
            id: id.to_owned(),
            title: title.to_owned(),
            wiki_aliases: aliases.iter().map(|alias| (*alias).to_owned()).collect(),
            redirect_target_article_id: None,
            category: "city".to_owned(),
            category_id: None,
            summary: String::new(),
            content: String::new(),
            calendar_profile: None,
            document_sections: Vec::new(),
            tags: Vec::new(),
            linked_map_entity_ids: Vec::new(),
            source_map_id: None,
            source_entity_id: source.map(str::to_owned),
            profiles: ArticleProfiles::default(),
        }
    }

    #[test]
    fn reference_options_do_not_duplicate_map_entities() {
        let articles = vec![article("article-city", "은빛항", &[], Some("map-city"))];
        let options = reference_options(&articles);
        assert_eq!(options.len(), 1);
        assert_eq!(
            canonical_reference_id("map-city", &options),
            Some("article-city")
        );
    }

    #[test]
    fn search_prefers_exact_titles_and_supports_aliases() {
        let articles = vec![
            article("a", "에테리아", &["Aetheria"], None),
            article("b", "에테리아 항구", &[], None),
        ];
        let options = reference_options(&articles);
        assert_eq!(matching_options("Aetheria", &options, &[], 8)[0].id, "a");
        assert_eq!(matching_options("에테리아", &options, &[], 8)[0].id, "a");
    }

    #[test]
    fn legacy_date_values_keep_their_year() {
        assert_eq!(json_year(&serde_json::json!("1301년")), Some(1301));
        assert_eq!(json_year(&serde_json::json!(-42)), Some(-42));
        assert_eq!(json_year(&serde_json::json!({ "year": 88 })), Some(88));
    }
}
