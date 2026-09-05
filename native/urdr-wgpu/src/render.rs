use std::{collections::HashMap, sync::Arc};

use eframe::egui::{
    self, Align2, Color32, Mesh, Pos2, Rect, Shape, Stroke, Vec2,
    epaint::{TextShape, Vertex},
};

use crate::{map_render_cache::CountryLabelAnchor, model::NativeMap};

const MAX_CANONICAL_TERRITORY_SAMPLES: usize = 262_144;

pub fn surface_color(surface: &str) -> Color32 {
    match surface {
        "mountain" => Color32::from_rgb(119, 100, 90),
        "forest" => Color32::from_rgb(45, 106, 79),
        "desert" => Color32::from_rgb(212, 167, 44),
        "snow" => Color32::from_rgb(233, 241, 247),
        "grassland" => Color32::from_rgb(124, 179, 66),
        "plain" => Color32::from_rgb(167, 201, 87),
        "farmland" => Color32::from_rgb(180, 166, 82),
        "jungle" => Color32::from_rgb(27, 94, 32),
        "wetland" => Color32::from_rgb(73, 105, 91),
        "rock" | "bedrock" => Color32::from_rgb(132, 111, 92),
        "freshwater" => Color32::from_rgb(71, 145, 197),
        "saltwater" => Color32::from_rgb(47, 108, 154),
        _ => Color32::from_rgb(110, 125, 132),
    }
}

fn add_quad(mesh: &mut Mesh, left: f32, top: f32, right: f32, bottom: f32, color: Color32) {
    let base = mesh.vertices.len() as u32;
    for position in [
        Pos2::new(left, top),
        Pos2::new(right, top),
        Pos2::new(right, bottom),
        Pos2::new(left, bottom),
    ] {
        mesh.vertices.push(Vertex {
            pos: position,
            uv: Pos2::ZERO,
            color,
        });
    }
    mesh.indices
        .extend_from_slice(&[base, base + 1, base + 2, base, base + 2, base + 3]);
}

pub fn build_cell_overlay_mesh(
    map: &NativeMap,
    cells: &HashMap<usize, Color32>,
    canonical_cells: bool,
) -> Arc<Mesh> {
    let mut mesh = Mesh::default();
    let (grid_width, grid_height) = if canonical_cells {
        map.canonical_cell_dimensions()
    } else {
        (map.grid_width, map.grid_height)
    };
    let cell_width = map.width / grid_width.max(1) as f32;
    let cell_height = map.height / grid_height.max(1) as f32;
    for (&index, &color) in cells {
        let x = index % grid_width.max(1);
        let y = index / grid_width.max(1);
        let left = x as f32 * cell_width;
        let top = y as f32 * cell_height;
        let right = left + cell_width;
        let bottom = top + cell_height;
        add_quad(&mut mesh, left, top, right, bottom, color);
    }
    Arc::new(mesh)
}

pub fn build_territory_mesh_with_opacity(map: &NativeMap, opacity: f32) -> Arc<Mesh> {
    let has_visible_owner = !map.factions.is_empty()
        && map
            .territory_owners
            .iter()
            .any(|owner| *owner >= 0 && (*owner as usize) < map.factions.len());
    if opacity <= f32::EPSILON || !has_visible_owner {
        return Arc::new(Mesh::default());
    }
    if let Some(surface) = map.canonical_surface.as_ref() {
        return build_canonical_territory_mesh(map, surface, opacity);
    }
    build_grid_territory_mesh(map, opacity)
}

fn build_grid_territory_mesh(map: &NativeMap, opacity: f32) -> Arc<Mesh> {
    let mut mesh = Mesh::default();
    let cell_width = map.width / map.grid_width.max(1) as f32;
    let cell_height = map.height / map.grid_height.max(1) as f32;
    for y in 0..map.grid_height {
        let mut x = 0;
        while x < map.grid_width {
            let index = y * map.grid_width + x;
            let owner = map.territory_owners.get(index).copied().unwrap_or(-1);
            if owner < 0 || map.water.get(index).is_some_and(|water| water != "land") {
                x += 1;
                continue;
            }
            let mut end_x = x + 1;
            while end_x < map.grid_width {
                let next = y * map.grid_width + end_x;
                if map.territory_owners.get(next).copied().unwrap_or(-1) != owner
                    || map.water.get(next).is_some_and(|water| water != "land")
                {
                    break;
                }
                end_x += 1;
            }
            let color = map
                .factions
                .get(owner as usize)
                .map(|faction| parse_hex_color(&faction.color))
                .unwrap_or(Color32::from_rgb(205, 78, 92));
            let alpha = (128.0 * opacity.clamp(0.0, 1.0)).round() as u8;
            add_quad(
                &mut mesh,
                x as f32 * cell_width,
                y as f32 * cell_height,
                end_x as f32 * cell_width,
                (y + 1) as f32 * cell_height,
                Color32::from_rgba_unmultiplied(color.r(), color.g(), color.b(), alpha),
            );
            x = end_x;
        }
    }
    Arc::new(mesh)
}

fn build_canonical_territory_mesh(
    map: &NativeMap,
    surface: &crate::model::CanonicalSurface,
    opacity: f32,
) -> Arc<Mesh> {
    let (sample_width, sample_height) = bounded_territory_sample_dimensions(surface);
    if sample_width != surface.width as usize || sample_height != surface.height as usize {
        crate::diagnostics::event(
            "map_render",
            "territory_mesh",
            "canonical_lod_selected",
            &[
                (
                    "canonical_dimensions",
                    format!("{}x{}", surface.width, surface.height),
                ),
                (
                    "sample_dimensions",
                    format!("{sample_width}x{sample_height}"),
                ),
            ],
        );
    }
    let mut mesh = Mesh::default();
    let cell_width = map.width / sample_width.max(1) as f32;
    let cell_height = map.height / sample_height.max(1) as f32;
    let owner_at = |sample_x: usize, sample_y: usize| {
        let x = ((sample_x * surface.width as usize + sample_width / 2) / sample_width)
            .min(surface.width.saturating_sub(1) as usize);
        let y = ((sample_y * surface.height as usize + sample_height / 2) / sample_height)
            .min(surface.height.saturating_sub(1) as usize);
        let grid_x = (x * map.grid_width.max(1) / surface.width.max(1) as usize)
            .min(map.grid_width.saturating_sub(1));
        let grid_y = (y * map.grid_height.max(1) / surface.height.max(1) as usize)
            .min(map.grid_height.saturating_sub(1));
        let owner = map
            .territory_owners
            .get(grid_y * map.grid_width.max(1) + grid_x)
            .copied()
            .unwrap_or(-1);
        if owner < 0 || surface.encoded(x, y).is_none_or(|(_, _, water)| water != 0) {
            return -1;
        }
        owner
    };
    let alpha = (128.0 * opacity.clamp(0.0, 1.0)).round() as u8;
    for y in 0..sample_height {
        let mut x = 0_usize;
        while x < sample_width {
            let owner = owner_at(x, y);
            if owner < 0 {
                x += 1;
                continue;
            }
            let mut end_x = x + 1;
            while end_x < sample_width && owner_at(end_x, y) == owner {
                end_x += 1;
            }
            let color = map
                .factions
                .get(owner as usize)
                .map(|faction| parse_hex_color(&faction.color))
                .unwrap_or(Color32::from_rgb(205, 78, 92));
            add_quad(
                &mut mesh,
                x as f32 * cell_width,
                y as f32 * cell_height,
                end_x as f32 * cell_width,
                (y + 1) as f32 * cell_height,
                Color32::from_rgba_unmultiplied(color.r(), color.g(), color.b(), alpha),
            );
            x = end_x;
        }
    }
    Arc::new(mesh)
}

fn bounded_territory_sample_dimensions(surface: &crate::model::CanonicalSurface) -> (usize, usize) {
    let width = surface.width.max(1) as usize;
    let height = surface.height.max(1) as usize;
    if width.saturating_mul(height) <= MAX_CANONICAL_TERRITORY_SAMPLES {
        return (width, height);
    }
    let aspect = width as f64 / height as f64;
    let sample_width = ((MAX_CANONICAL_TERRITORY_SAMPLES as f64 * aspect)
        .sqrt()
        .round() as usize)
        .clamp(1, width);
    let sample_height = (MAX_CANONICAL_TERRITORY_SAMPLES / sample_width)
        .max(1)
        .min(height);
    (sample_width, sample_height)
}

pub(crate) fn parse_hex_color(value: &str) -> Color32 {
    let value = value.trim_start_matches('#');
    if value.len() == 6
        && let Ok(rgb) = u32::from_str_radix(value, 16)
    {
        return Color32::from_rgb((rgb >> 16) as u8, (rgb >> 8) as u8, rgb as u8);
    }
    Color32::from_rgb(205, 78, 92)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Language, LoadedWorld};

    #[test]
    fn empty_territory_skips_canonical_surface_work() {
        let mut world = LoadedWorld::load_demo(Language::English).expect("demo");
        world.map.rebuild_canonical_surface();
        world.map.factions.clear();
        world.map.territory_owners.fill(-1);

        let mesh = build_territory_mesh_with_opacity(&world.map, 0.72);

        assert!(mesh.vertices.is_empty());
        assert!(mesh.indices.is_empty());
    }

    #[test]
    fn canonical_territory_sampling_has_a_fixed_work_ceiling() {
        let mut world = LoadedWorld::load_demo(Language::English).expect("demo");
        world.map.rebuild_canonical_surface();
        let surface = world.map.canonical_surface.as_ref().expect("surface");

        let (width, height) = bounded_territory_sample_dimensions(surface);

        assert!(width.saturating_mul(height) <= MAX_CANONICAL_TERRITORY_SAMPLES);
        assert!(width <= surface.width as usize);
        assert!(height <= surface.height as usize);
        let source_aspect = surface.width as f64 / surface.height as f64;
        let sample_aspect = width as f64 / height as f64;
        assert!((source_aspect - sample_aspect).abs() < 0.02);
    }
}

#[allow(clippy::too_many_arguments)]
pub fn paint_map_overlays(
    ui: &mut egui::Ui,
    map: &NativeMap,
    year: i32,
    overlay_mesh: Arc<Mesh>,
    territory_mesh: Arc<Mesh>,
    shoreline_mesh: Arc<Mesh>,
    river_mesh: Arc<Mesh>,
    road_mesh: Arc<Mesh>,
    show_territories: bool,
    show_coastline: bool,
    show_rivers: bool,
    show_roads: bool,
    show_locations: bool,
    show_location_labels: bool,
    show_place_names: bool,
    show_event_icons: bool,
) {
    let painter = ui.painter();
    if show_territories {
        painter.add(Shape::Mesh(territory_mesh));
    }
    painter.add(Shape::Mesh(overlay_mesh));

    if show_rivers {
        painter.add(Shape::Mesh(river_mesh));
    }
    if show_roads {
        painter.add(Shape::Mesh(road_mesh));
    }
    // Shorelines cap river mouths so their centre-lines meet the shared water
    // boundary without drawing over the sea or leaving a visible gap.
    if show_coastline {
        painter.add(Shape::Mesh(shoreline_mesh));
    }
    if show_locations {
        for location in &map.locations {
            let Some(state) = location.state_at(year) else {
                continue;
            };
            let position = Pos2::new(state.position.x, state.position.y);
            painter.circle_filled(position, 0.48, Color32::WHITE);
            painter.circle_stroke(
                position,
                0.48,
                Stroke::new(0.15, Color32::from_rgb(12, 24, 36)),
            );
            if show_location_labels {
                painter.text(
                    position + Vec2::new(0.75, -0.55),
                    egui::Align2::LEFT_BOTTOM,
                    &state.name,
                    egui::FontId::proportional(1.55),
                    Color32::WHITE,
                );
            }
        }
    }
    if show_event_icons {
        for event in &map.events {
            if event.start_year > year || event.end_year.is_some_and(|end| end < year) {
                continue;
            }
            let Some(point) = event.position_at(year) else {
                continue;
            };
            let position = Pos2::new(point.x, point.y);
            painter.circle_filled(position, 0.52, Color32::from_rgb(238, 96, 81));
            painter.circle_stroke(position, 0.52, Stroke::new(0.12, Color32::WHITE));
        }
    }
    if show_place_names {
        for place in &map.place_names {
            if place.start_year > year || place.end_year.is_some_and(|end| end < year) {
                continue;
            }
            let (position, angle) = if place.path.len() >= 2 {
                let first = place.path.first().copied().unwrap_or(place.position);
                let last = place.path.last().copied().unwrap_or(place.position);
                (place.position, (last.y - first.y).atan2(last.x - first.x))
            } else {
                (place.position, 0.0)
            };
            let font = egui::FontId::proportional(1.8);
            let galley = painter.layout_no_wrap(place.name.clone(), font, Color32::WHITE);
            let origin = Pos2::new(position.x, position.y) - galley.rect.center().to_vec2();
            painter.add(Shape::Text(
                TextShape::new(origin, galley, Color32::WHITE)
                    .with_angle_and_anchor(angle, Align2::CENTER_CENTER),
            ));
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub fn paint_map_labels_screen(
    painter: &egui::Painter,
    viewport: egui::Rect,
    visible_world: egui::Rect,
    map: &NativeMap,
    year: i32,
    show_location_icons: bool,
    show_location_labels: bool,
    show_country_names: bool,
    show_place_names: bool,
    country_anchors: &[CountryLabelAnchor],
) {
    if !viewport.is_positive() || !visible_world.is_positive() {
        return;
    }
    let scale =
        (viewport.width() / visible_world.width()).min(viewport.height() / visible_world.height());
    let content_rect =
        egui::Rect::from_center_size(viewport.center(), visible_world.size() * scale)
            .intersect(viewport);
    let painter = painter.with_clip_rect(content_rect);
    let visible_margin =
        visible_world.expand(visible_world.width().max(visible_world.height()) * 0.03);
    let world_visible =
        |point: crate::model::Point| visible_margin.contains(Pos2::new(point.x, point.y));
    let to_screen = |point: crate::model::Point| {
        Pos2::new(
            content_rect.left() + (point.x - visible_world.left()) * scale,
            content_rect.top() + (point.y - visible_world.top()) * scale,
        )
    };

    if show_location_icons {
        let mut locations = map
            .locations
            .iter()
            .filter_map(|location| {
                location
                    .state_at(year)
                    .filter(|state| world_visible(state.position))
                    .map(|state| (location.id.as_str(), state))
            })
            .collect::<Vec<_>>();
        locations.sort_by(|left, right| left.0.cmp(right.0));
        let icons = locations
            .iter()
            .map(|(_, state)| {
                let center = to_screen(state.position);
                (center, Rect::from_center_size(center, Vec2::splat(10.0)))
            })
            .collect::<Vec<_>>();
        for (center, _) in &icons {
            painter.circle_filled(*center, 4.0, Color32::WHITE);
            painter.circle_stroke(
                *center,
                4.0,
                Stroke::new(1.25, Color32::from_rgb(12, 24, 36)),
            );
        }
        if show_location_labels {
            let mut accepted = Vec::<Rect>::new();
            for (index, (_, state)) in locations.iter().enumerate() {
                let galley = painter.layout_no_wrap(
                    state.name.clone(),
                    egui::FontId::proportional(12.0),
                    Color32::WHITE,
                );
                let size = galley.size() + Vec2::new(2.0, 2.0);
                let center = icons[index].0;
                let candidates = [
                    Rect::from_min_size(center + Vec2::new(7.0, -size.y * 0.5), size),
                    Rect::from_min_size(center + Vec2::new(-7.0 - size.x, -size.y * 0.5), size),
                    Rect::from_min_size(center + Vec2::new(-size.x * 0.5, -8.0 - size.y), size),
                    Rect::from_min_size(center + Vec2::new(-size.x * 0.5, 8.0), size),
                ];
                let candidate = candidates.into_iter().find(|candidate| {
                    content_rect.contains(candidate.min)
                        && content_rect.contains(candidate.max)
                        && !accepted.iter().any(|placed| placed.intersects(*candidate))
                        && !icons
                            .iter()
                            .enumerate()
                            .any(|(other, (_, icon))| other != index && icon.intersects(*candidate))
                });
                if let Some(candidate) = candidate {
                    accepted.push(candidate);
                    paint_outlined_text(
                        &painter,
                        candidate.left_center(),
                        Align2::LEFT_CENTER,
                        &state.name,
                        egui::FontId::proportional(12.0),
                    );
                }
            }
        }
    }

    if show_country_names {
        for anchor in country_anchors
            .iter()
            .filter(|anchor| world_visible(anchor.position))
        {
            paint_outlined_text(
                &painter,
                to_screen(anchor.position),
                Align2::CENTER_CENTER,
                &anchor.name,
                egui::FontId::proportional(15.0),
            );
        }
    }

    if show_place_names {
        for place in &map.place_names {
            if place.start_year > year || place.end_year.is_some_and(|end| end < year) {
                continue;
            }
            if !world_visible(place.position) && !place.path.iter().copied().any(world_visible) {
                continue;
            }
            if place.path.len() >= 2 {
                paint_text_along_path(
                    &painter,
                    &place.name,
                    &place
                        .path
                        .iter()
                        .copied()
                        .map(to_screen)
                        .collect::<Vec<_>>(),
                    place.font_size.clamp(7.0, 42.0),
                    place.letter_spacing.clamp(-2.0, 24.0),
                    place.bold,
                    place.italic,
                );
            } else {
                paint_outlined_text(
                    &painter,
                    to_screen(place.position),
                    Align2::CENTER_CENTER,
                    &place.name,
                    egui::FontId::proportional(place.font_size.clamp(7.0, 42.0)),
                );
            }
        }
    }
}

fn paint_text_along_path(
    painter: &egui::Painter,
    text: &str,
    path: &[Pos2],
    font_size: f32,
    letter_spacing: f32,
    bold: bool,
    italic: bool,
) {
    if text.trim().is_empty() || path.len() < 2 {
        return;
    }
    let lengths = path
        .windows(2)
        .map(|points| points[0].distance(points[1]))
        .collect::<Vec<_>>();
    let total = lengths.iter().sum::<f32>();
    let chars = text.chars().collect::<Vec<_>>();
    let advance = font_size * 0.62 + letter_spacing;
    let text_length = advance * chars.len().saturating_sub(1) as f32;
    if total <= text_length.max(1.0) {
        return;
    }
    let start = (total - text_length) * 0.5;
    for (index, character) in chars.into_iter().enumerate() {
        let distance = start + index as f32 * advance;
        let (position, mut angle) = sample_screen_path(path, &lengths, distance);
        if angle.cos() < 0.0 {
            angle += std::f32::consts::PI;
        }
        let font = egui::FontId::proportional(font_size + if bold { 0.7 } else { 0.0 });
        let galley = painter.layout_no_wrap(character.to_string(), font, Color32::WHITE);
        let mut origin = position - galley.rect.center().to_vec2();
        if italic {
            origin.x += angle.sin() * 0.8;
        }
        for offset in [
            Vec2::new(-1.0, 0.0),
            Vec2::new(1.0, 0.0),
            Vec2::new(0.0, -1.0),
            Vec2::new(0.0, 1.0),
        ] {
            painter.add(Shape::Text(
                TextShape::new(
                    origin + offset,
                    galley.clone(),
                    Color32::from_rgb(8, 17, 25),
                )
                .with_angle_and_anchor(angle, Align2::CENTER_CENTER),
            ));
        }
        painter.add(Shape::Text(
            TextShape::new(origin, galley, Color32::WHITE)
                .with_angle_and_anchor(angle, Align2::CENTER_CENTER),
        ));
    }
}

fn sample_screen_path(path: &[Pos2], lengths: &[f32], mut distance: f32) -> (Pos2, f32) {
    for (index, length) in lengths.iter().copied().enumerate() {
        if distance <= length || index + 1 == lengths.len() {
            let ratio = if length <= f32::EPSILON {
                0.0
            } else {
                (distance / length).clamp(0.0, 1.0)
            };
            let start = path[index];
            let end = path[index + 1];
            return (
                start.lerp(end, ratio),
                (end.y - start.y).atan2(end.x - start.x),
            );
        }
        distance -= length;
    }
    (*path.last().unwrap_or(&Pos2::ZERO), 0.0)
}

fn paint_outlined_text(
    painter: &egui::Painter,
    position: Pos2,
    anchor: Align2,
    text: &str,
    font: egui::FontId,
) {
    for offset in [
        Vec2::new(-1.0, 0.0),
        Vec2::new(1.0, 0.0),
        Vec2::new(0.0, -1.0),
        Vec2::new(0.0, 1.0),
    ] {
        painter.text(
            position + offset,
            anchor,
            text,
            font.clone(),
            Color32::from_rgb(8, 17, 25),
        );
    }
    painter.text(position, anchor, text, font, Color32::WHITE);
}
