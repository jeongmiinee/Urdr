use eframe::egui::{Pos2, Rect, Vec2};

use crate::map_runtime::RuntimeCamera;

#[derive(Clone, Copy, Debug)]
pub(crate) struct ScaleBar {
    pub distance_km: f32,
    pub pixel_width: f32,
}

pub(crate) fn fitted_scene_content_rect(viewport: Rect, visible_world: Rect) -> Rect {
    if !viewport.is_positive() || !visible_world.is_positive() {
        return viewport;
    }
    let scale =
        (viewport.width() / visible_world.width()).min(viewport.height() / visible_world.height());
    Rect::from_center_size(viewport.center(), visible_world.size() * scale).intersect(viewport)
}

pub(crate) fn world_to_screen_scale(viewport: Rect, visible_world: Rect) -> f32 {
    if !viewport.is_positive() || !visible_world.is_positive() {
        return 1.0;
    }
    (viewport.width() / visible_world.width())
        .min(viewport.height() / visible_world.height())
        .max(0.000_001)
}

pub(crate) fn visible_scale_bar(
    visible_km: f32,
    viewport_pixels: f32,
    maximum_pixels: f32,
) -> ScaleBar {
    let km_per_pixel = visible_km.max(0.001) / viewport_pixels.max(1.0);
    let maximum_distance = (km_per_pixel * maximum_pixels).max(0.000_001);
    let power = 10.0_f32.powf(maximum_distance.log10().floor());
    let normalized = maximum_distance / power;
    let nice = if normalized >= 5.0 {
        5.0
    } else if normalized >= 2.0 {
        2.0
    } else {
        1.0
    };
    let distance_km = nice * power;
    ScaleBar {
        distance_km,
        pixel_width: (distance_km / km_per_pixel).clamp(1.0, maximum_pixels),
    }
}

pub(crate) fn viewport_aligned_scene_rect(scene_rect: Rect, viewport_size: Vec2) -> Rect {
    if !scene_rect.is_positive() || viewport_size.x <= 0.0 || viewport_size.y <= 0.0 {
        return scene_rect;
    }
    let viewport_aspect = viewport_size.x / viewport_size.y;
    let scene_aspect = scene_rect.width() / scene_rect.height();
    let size = if scene_aspect < viewport_aspect {
        Vec2::new(scene_rect.height() * viewport_aspect, scene_rect.height())
    } else {
        Vec2::new(scene_rect.width(), scene_rect.width() / viewport_aspect)
    };
    Rect::from_center_size(scene_rect.center(), size)
}

pub(crate) fn map_relative_zoom_range(
    map_size: Vec2,
    viewport_size: Vec2,
) -> std::ops::RangeInclusive<f32> {
    if map_size.x <= 0.0 || map_size.y <= 0.0 || viewport_size.x <= 0.0 || viewport_size.y <= 0.0 {
        return 0.45..=24.0;
    }
    let map_rect =
        viewport_aligned_scene_rect(Rect::from_min_size(Pos2::ZERO, map_size), viewport_size);
    let fit_scale = (viewport_size.x / map_rect.width())
        .min(viewport_size.y / map_rect.height())
        .max(0.000_001);
    fit_scale * 0.9..=fit_scale * 24.0
}

pub(crate) fn cursor_centered_scene_zoom(
    scene_rect: Rect,
    viewport_rect: Rect,
    pointer: Pos2,
    wheel_delta: f32,
    zoom_range: std::ops::RangeInclusive<f32>,
) -> Rect {
    if !viewport_rect.is_positive() || !scene_rect.is_positive() {
        return scene_rect;
    }
    let aligned = viewport_aligned_scene_rect(scene_rect, viewport_rect.size());
    let cursor_fraction = Vec2::new(
        ((pointer.x - viewport_rect.left()) / viewport_rect.width()).clamp(0.0, 1.0),
        ((pointer.y - viewport_rect.top()) / viewport_rect.height()).clamp(0.0, 1.0),
    );
    let current_scale = world_to_screen_scale(viewport_rect, aligned);
    let wheel_factor = (wheel_delta * 0.0025).exp().clamp(0.5, 2.0);
    let next_scale = (current_scale * wheel_factor).clamp(*zoom_range.start(), *zoom_range.end());
    let next_size = viewport_rect.size() / next_scale;
    let anchor = aligned.min + aligned.size() * cursor_fraction;
    Rect::from_min_size(anchor - next_size * cursor_fraction, next_size)
}

pub(crate) fn runtime_camera_from_scene_rect(scene_rect: Rect) -> RuntimeCamera {
    RuntimeCamera {
        center_x: scene_rect.center().x,
        center_y: scene_rect.center().y,
        half_height: scene_rect.height().max(0.001) * 0.5,
    }
}

pub(crate) fn scene_rect_from_runtime_camera(
    camera: RuntimeCamera,
    viewport_size: Vec2,
    map_size: Vec2,
) -> Rect {
    let fallback_aspect = map_size.x.max(1.0) / map_size.y.max(1.0);
    let aspect = if viewport_size.x > 0.0 && viewport_size.y > 0.0 {
        viewport_size.x / viewport_size.y
    } else {
        fallback_aspect
    };
    let half_height = camera.half_height.max(0.001);
    Rect::from_center_size(
        Pos2::new(camera.center_x, camera.center_y),
        Vec2::new(half_height * 2.0 * aspect, half_height * 2.0),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn world_to_screen_scale_uses_the_limiting_axis() {
        let viewport = Rect::from_min_size(Pos2::ZERO, Vec2::new(1_000.0, 500.0));
        let world = Rect::from_min_size(Pos2::ZERO, Vec2::new(500.0, 400.0));
        assert_eq!(world_to_screen_scale(viewport, world), 1.25);
    }

    #[test]
    fn map_size_does_not_change_relative_zoom_range() {
        let viewport = Vec2::new(1_000.0, 600.0);
        let small = map_relative_zoom_range(Vec2::new(20.0, 12.0), viewport);
        let large = map_relative_zoom_range(Vec2::new(500.0, 300.0), viewport);
        let small_ratio = *small.end() / *small.start();
        let large_ratio = *large.end() / *large.start();
        assert!((small_ratio - large_ratio).abs() < 0.001);
    }
}
