use std::path::PathBuf;

use eframe::egui::{
    self, Color32, CornerRadius, FontData, FontDefinitions, FontFamily, FontId, Margin, Stroke,
    Vec2,
};

pub struct Metrics;

impl Metrics {
    pub const TOP_BAR_HEIGHT: f32 = 44.0;
    pub const TAB_BAR_HEIGHT: f32 = 35.0;
    pub const EXPLORER_WIDTH: f32 = 224.0;
    pub const DOCUMENT_LIST_WIDTH: f32 = 196.0;
    pub const GENERATOR_CONTROLS_WIDTH: f32 = 410.0;
    pub const ENVIRONMENT_CONTROLS_WIDTH: f32 = 286.0;
    pub const TIMELINE_HEIGHT: f32 = 148.0;
    pub const TIMELINE_COLLAPSED_HEIGHT: f32 = 42.0;
    pub const STATUS_BAR_HEIGHT: f32 = 24.0;
    pub const CONTROL_HEIGHT: f32 = 30.0;
    pub const MAP_OVERLAY_WIDTH: f32 = 304.0;
    pub const MAP_OVERLAY_ICON_SIZE: f32 = 34.0;
    pub const MAP_EDGE_INSET: f32 = 16.0;
    pub const MAP_SCALE_WIDTH: f32 = 180.0;
    pub const MAP_SCALE_HEIGHT: f32 = 48.0;
    pub const HOME_PANEL_WIDTH: f32 = 620.0;
    pub const HOME_PANEL_HEIGHT: f32 = 504.0;
    pub const SETTINGS_WIDTH: f32 = 998.0;
    pub const SETTINGS_HEIGHT: f32 = 797.0;
}

#[derive(Clone, Copy)]
pub struct Palette {
    pub background: Color32,
    pub panel: Color32,
    pub panel_alt: Color32,
    pub surface: Color32,
    pub surface_soft: Color32,
    pub border: Color32,
    pub text: Color32,
    pub muted: Color32,
    pub title: Color32,
    pub accent: Color32,
    pub hover: Color32,
    pub selected: Color32,
    pub danger: Color32,
    pub success: Color32,
    pub map_background: Color32,
}

pub const DARK: Palette = Palette {
    background: Color32::from_rgb(8, 13, 22),
    panel: Color32::from_rgb(16, 24, 36),
    panel_alt: Color32::from_rgb(17, 26, 40),
    surface: Color32::from_rgb(23, 36, 55),
    surface_soft: Color32::from_rgb(13, 23, 37),
    border: Color32::from_rgb(43, 59, 80),
    text: Color32::from_rgb(230, 237, 245),
    muted: Color32::from_rgb(145, 163, 181),
    title: Color32::from_rgb(245, 248, 251),
    accent: Color32::from_rgb(65, 180, 228),
    hover: Color32::from_rgb(33, 50, 73),
    selected: Color32::from_rgb(18, 59, 82),
    danger: Color32::from_rgb(255, 176, 186),
    success: Color32::from_rgb(78, 177, 126),
    map_background: Color32::from_rgb(7, 16, 26),
};

pub const LIGHT: Palette = Palette {
    background: Color32::from_rgb(237, 242, 246),
    panel: Color32::from_rgb(247, 249, 251),
    panel_alt: Color32::WHITE,
    surface: Color32::from_rgb(233, 240, 245),
    surface_soft: Color32::from_rgb(245, 248, 250),
    border: Color32::from_rgb(185, 200, 211),
    text: Color32::from_rgb(35, 57, 74),
    muted: Color32::from_rgb(97, 119, 138),
    title: Color32::from_rgb(20, 43, 60),
    accent: Color32::from_rgb(8, 123, 168),
    hover: Color32::from_rgb(223, 234, 240),
    selected: Color32::from_rgb(220, 238, 246),
    danger: Color32::from_rgb(162, 38, 54),
    success: Color32::from_rgb(37, 126, 77),
    map_background: Color32::from_rgb(220, 230, 236),
};

pub fn palette(dark: bool) -> Palette {
    if dark { DARK } else { LIGHT }
}

pub fn install_fonts(context: &egui::Context) {
    let windows_fonts = std::env::var_os("WINDIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"))
        .join("Fonts");
    let portable_fonts = std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(|root| root.join("fonts")));
    let regular = [
        Some(windows_fonts.join("malgun.ttf")),
        portable_fonts
            .as_ref()
            .map(|root| root.join("NotoSansKR-Regular.ttf")),
        Some(windows_fonts.join("NotoSansKR-Regular.ttf")),
    ]
    .into_iter()
    .flatten()
    .find_map(|path| std::fs::read(path).ok());
    let Some(regular) = regular else { return };
    let bold = [
        Some(windows_fonts.join("malgunbd.ttf")),
        portable_fonts
            .as_ref()
            .map(|root| root.join("NotoSansKR-Bold.ttf")),
        Some(windows_fonts.join("NotoSansKR-Bold.ttf")),
    ]
    .into_iter()
    .flatten()
    .find_map(|path| std::fs::read(path).ok())
    .unwrap_or_else(|| regular.clone());

    let mut fonts = FontDefinitions::default();
    fonts.font_data.insert(
        "urdr-malgun-gothic".to_owned(),
        FontData::from_owned(regular).into(),
    );
    fonts.font_data.insert(
        "urdr-malgun-gothic-bold".to_owned(),
        FontData::from_owned(bold).into(),
    );
    let symbol_fallback = [
        windows_fonts.join("arial.ttf"),
        windows_fonts.join("seguisym.ttf"),
    ]
    .into_iter()
    .find_map(|path| std::fs::read(path).ok());
    if let Some(symbol_fallback) = symbol_fallback {
        fonts.font_data.insert(
            "urdr-symbol-fallback".to_owned(),
            FontData::from_owned(symbol_fallback).into(),
        );
    }
    let has_symbol_fallback = fonts.font_data.contains_key("urdr-symbol-fallback");
    for family in [FontFamily::Proportional, FontFamily::Monospace] {
        let family_fonts = fonts.families.entry(family).or_default();
        family_fonts.insert(0, "urdr-malgun-gothic".to_owned());
        if has_symbol_fallback {
            family_fonts.insert(1, "urdr-symbol-fallback".to_owned());
        }
    }
    for family in ["urdr-sans-bold", "urdr-document-title"] {
        fonts
            .families
            .entry(FontFamily::Name(family.into()))
            .or_default()
            .insert(
                0,
                if family == "urdr-sans-bold" {
                    "urdr-malgun-gothic-bold"
                } else {
                    "urdr-malgun-gothic"
                }
                .to_owned(),
            );
    }
    context.set_fonts(fonts);
}

#[cfg(target_os = "windows")]
pub fn enable_per_monitor_v2_dpi() {
    #[link(name = "user32")]
    unsafe extern "system" {
        fn SetProcessDpiAwarenessContext(value: isize) -> i32;
    }
    const DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2: isize = -4;
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
}

#[cfg(not(target_os = "windows"))]
pub fn enable_per_monitor_v2_dpi() {}

pub fn apply(context: &egui::Context, dark: bool, scale: f32) {
    let colors = palette(dark);
    let mut visuals = if dark {
        egui::Visuals::dark()
    } else {
        egui::Visuals::light()
    };
    visuals.panel_fill = colors.panel;
    visuals.window_fill = colors.panel_alt;
    visuals.extreme_bg_color = colors.surface_soft;
    visuals.faint_bg_color = colors.surface_soft;
    visuals.weak_text_color = Some(colors.muted);
    visuals.override_text_color = Some(colors.text);
    visuals.hyperlink_color = colors.accent;
    visuals.error_fg_color = colors.danger;
    visuals.warn_fg_color = Color32::from_rgb(214, 166, 74);
    visuals.window_corner_radius = CornerRadius::same(8);
    visuals.menu_corner_radius = CornerRadius::same(6);
    visuals.button_frame = true;
    visuals.slider_trailing_fill = true;
    visuals.interact_cursor = Some(egui::CursorIcon::PointingHand);
    visuals.selection.bg_fill = colors.accent;
    visuals.selection.stroke = Stroke::new(1.0, colors.title);
    visuals.widgets.noninteractive.bg_fill = colors.panel;
    visuals.widgets.noninteractive.weak_bg_fill = colors.panel;
    visuals.widgets.noninteractive.bg_stroke = Stroke::new(1.0, colors.border);
    visuals.widgets.noninteractive.corner_radius = CornerRadius::same(6);
    visuals.widgets.noninteractive.fg_stroke = Stroke::new(1.0, colors.text);
    visuals.widgets.inactive.bg_fill = colors.surface_soft;
    visuals.widgets.inactive.weak_bg_fill = colors.surface_soft;
    visuals.widgets.inactive.bg_stroke = Stroke::new(1.0, colors.border);
    visuals.widgets.inactive.corner_radius = CornerRadius::same(6);
    visuals.widgets.inactive.fg_stroke = Stroke::new(1.0, colors.text);
    visuals.widgets.hovered.bg_fill = colors.hover;
    visuals.widgets.hovered.weak_bg_fill = colors.hover;
    visuals.widgets.hovered.bg_stroke = Stroke::new(1.0, colors.accent);
    visuals.widgets.hovered.corner_radius = CornerRadius::same(6);
    visuals.widgets.hovered.fg_stroke = Stroke::new(1.0, colors.title);
    visuals.widgets.active.bg_fill = colors.surface;
    visuals.widgets.active.weak_bg_fill = colors.surface;
    visuals.widgets.active.bg_stroke = Stroke::new(1.0, colors.accent);
    visuals.widgets.active.corner_radius = CornerRadius::same(6);
    visuals.widgets.active.fg_stroke = Stroke::new(1.0, colors.title);
    visuals.widgets.open = visuals.widgets.active;
    visuals.window_stroke = Stroke::new(1.0, colors.border);
    context.set_visuals(visuals);

    context.all_styles_mut(|style| {
        style.spacing.item_spacing = Vec2::new(6.0, 5.0);
        style.spacing.button_padding = Vec2::new(8.0, 5.0);
        style.spacing.window_margin = Margin::same(14);
        style.spacing.menu_margin = Margin::same(5);
        style.spacing.interact_size = Vec2::new(30.0, Metrics::CONTROL_HEIGHT);
        style.spacing.slider_width = 148.0;
        style.spacing.slider_rail_height = 4.0;
        style.spacing.combo_width = 120.0;
        style.spacing.text_edit_width = 180.0;
        style.spacing.icon_width = 16.0;
        style.spacing.icon_width_inner = 10.0;
        style.spacing.icon_spacing = 6.0;
        style
            .text_styles
            .insert(egui::TextStyle::Small, FontId::proportional(10.0 * scale));
        style
            .text_styles
            .insert(egui::TextStyle::Body, FontId::proportional(12.5 * scale));
        style
            .text_styles
            .insert(egui::TextStyle::Button, FontId::proportional(11.5 * scale));
        style
            .text_styles
            .insert(egui::TextStyle::Heading, FontId::proportional(17.0 * scale));
    });
}

pub fn surface_frame(dark: bool) -> egui::Frame {
    let colors = palette(dark);
    egui::Frame::new()
        .fill(colors.surface_soft)
        .stroke(Stroke::new(1.0, colors.border))
        .corner_radius(CornerRadius::same(6))
        .inner_margin(Margin::same(10))
}

pub fn inset_frame(dark: bool, margin: i8) -> egui::Frame {
    let colors = palette(dark);
    egui::Frame::new()
        .fill(colors.surface)
        .stroke(Stroke::new(1.0, colors.border))
        .corner_radius(CornerRadius::same(6))
        .inner_margin(Margin::same(margin))
}
