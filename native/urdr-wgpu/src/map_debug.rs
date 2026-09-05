use std::{
    fs::{self, File},
    io::BufWriter,
    path::{Path, PathBuf},
    sync::Arc,
};

use eframe::egui::{Color32, Mesh, Pos2, Rect, epaint::Vertex};
use serde::Serialize;

use crate::{
    model::{NativeMap, Point, SurfaceSample},
    render::surface_color,
    shoreline::{ShorelineSegment, build_shoreline_chunk},
    surface_refinement::{DISPLAY_FIELD_VERSION, RefinedSurfaceSample, RefinementWindow},
    terrain_renderer::{diagnostic_surface_lod, mix_color, surface_display_color_at},
};

const DEBUG_SAMPLE_COLUMNS: usize = 120;
const DEBUG_SAMPLE_ROWS: usize = 80;
const EXPORT_LONG_AXIS: usize = 1_200;
const EXPORT_BLOCK_AXIS: usize = 96;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct MapDebugLayers {
    pub canonical_cell_grid: bool,
    pub raw_water_mask: bool,
    pub coast_scalar: bool,
    pub refined_shoreline: bool,
    pub raw_terrain_category: bool,
    pub refined_terrain_coverage: bool,
}

impl MapDebugLayers {
    pub(crate) fn any(self) -> bool {
        self.bits() != 0
    }

    fn needs_refinement(self) -> bool {
        self.coast_scalar || self.refined_terrain_coverage
    }

    fn bits(self) -> u8 {
        u8::from(self.canonical_cell_grid)
            | (u8::from(self.raw_water_mask) << 1)
            | (u8::from(self.coast_scalar) << 2)
            | (u8::from(self.refined_shoreline) << 3)
            | (u8::from(self.raw_terrain_category) << 4)
            | (u8::from(self.refined_terrain_coverage) << 5)
    }
}

#[derive(Clone, Debug, Default)]
pub(crate) struct MapDebugDraw {
    pub fill_meshes: Vec<Arc<Mesh>>,
    pub canonical_grid: Arc<Vec<[Point; 2]>>,
    pub refined_shoreline: Arc<Vec<[Point; 2]>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct MapDebugCacheKey {
    map_id: String,
    surface_identity: usize,
    surface_revision: u64,
    view_bits: [u32; 4],
    screen_scale_bits: u32,
    layer_bits: u8,
}

#[derive(Default)]
pub(crate) struct MapDebugRenderCache {
    key: Option<MapDebugCacheKey>,
    draw: MapDebugDraw,
}

impl MapDebugRenderCache {
    pub(crate) fn clear(&mut self) {
        self.key = None;
        self.draw = MapDebugDraw::default();
    }

    pub(crate) fn draw_for_view(
        &mut self,
        map: &NativeMap,
        view: Rect,
        screen_scale: f32,
        layers: MapDebugLayers,
    ) -> MapDebugDraw {
        if !layers.any() || !view.is_positive() {
            return MapDebugDraw::default();
        }
        let key = MapDebugCacheKey {
            map_id: map.source_id.clone(),
            surface_identity: map
                .canonical_surface
                .as_ref()
                .map_or(0, |surface| Arc::as_ptr(surface) as usize),
            surface_revision: map.surface_revision,
            view_bits: [
                view.min.x.to_bits(),
                view.min.y.to_bits(),
                view.max.x.to_bits(),
                view.max.y.to_bits(),
            ],
            screen_scale_bits: screen_scale.to_bits(),
            layer_bits: layers.bits(),
        };
        if self.key.as_ref() != Some(&key) {
            self.draw = build_debug_draw(map, view, screen_scale, layers);
            self.key = Some(key);
        }
        self.draw.clone()
    }
}

fn build_debug_draw(
    map: &NativeMap,
    view: Rect,
    screen_scale: f32,
    layers: MapDebugLayers,
) -> MapDebugDraw {
    let Some(surface) = map.canonical_surface.as_ref() else {
        return MapDebugDraw::default();
    };
    let clipped = view.intersect(Rect::from_min_max(
        Pos2::ZERO,
        Pos2::new(map.width, map.height),
    ));
    if !clipped.is_positive() {
        return MapDebugDraw::default();
    }
    let columns = DEBUG_SAMPLE_COLUMNS;
    let rows = ((columns as f32 * clipped.height() / clipped.width().max(0.001)).round() as usize)
        .clamp(8, DEBUG_SAMPLE_ROWS);
    let sample_width = clipped.width() / columns as f32;
    let sample_height = clipped.height() / rows as f32;
    let mut water_mesh = layers.raw_water_mask.then(Mesh::default);
    let mut coast_mesh = layers.coast_scalar.then(Mesh::default);
    let mut terrain_mesh = layers.raw_terrain_category.then(Mesh::default);
    let mut refined_mesh = layers.refined_terrain_coverage.then(Mesh::default);

    for row in 0..rows {
        for column in 0..columns {
            let left = clipped.left() + column as f32 * sample_width;
            let top = clipped.top() + row as f32 * sample_height;
            let right = if column + 1 == columns {
                clipped.right()
            } else {
                left + sample_width
            };
            let bottom = if row + 1 == rows {
                clipped.bottom()
            } else {
                top + sample_height
            };
            let world_x = (left + right) * 0.5;
            let world_y = (top + bottom) * 0.5;
            let canonical_x = world_x / map.width.max(0.001) * surface.width as f32;
            let canonical_y = world_y / map.height.max(0.001) * surface.height as f32;
            let source_x = canonical_x
                .floor()
                .clamp(0.0, surface.width.saturating_sub(1) as f32)
                as usize;
            let source_y = canonical_y
                .floor()
                .clamp(0.0, surface.height.saturating_sub(1) as f32)
                as usize;
            let raw = surface.sample(source_x, source_y);
            let refined = layers.needs_refinement().then(|| {
                local_refined_sample(
                    surface,
                    canonical_x,
                    canonical_y,
                    map.environment_seed,
                    map.sea_level,
                )
            });

            if let Some(mesh) = &mut water_mesh {
                add_quad(
                    mesh,
                    Rect::from_min_max(Pos2::new(left, top), Pos2::new(right, bottom)),
                    raw_water_color(raw.water),
                );
            }
            if let (Some(mesh), Some(refined)) = (&mut coast_mesh, refined) {
                add_quad(
                    mesh,
                    Rect::from_min_max(Pos2::new(left, top), Pos2::new(right, bottom)),
                    coast_scalar_color(refined.coast_value, 214),
                );
            }
            if let Some(mesh) = &mut terrain_mesh {
                let name = if raw.water == "land" {
                    raw.terrain
                } else {
                    raw.water
                };
                add_quad(
                    mesh,
                    Rect::from_min_max(Pos2::new(left, top), Pos2::new(right, bottom)),
                    alpha(surface_color(name), 218),
                );
            }
            if let (Some(mesh), Some(refined)) = (&mut refined_mesh, refined) {
                add_quad(
                    mesh,
                    Rect::from_min_max(Pos2::new(left, top), Pos2::new(right, bottom)),
                    alpha(refined_coverage_color(refined), 218),
                );
            }
        }
    }

    let fill_meshes = [water_mesh, coast_mesh, terrain_mesh, refined_mesh]
        .into_iter()
        .flatten()
        .map(Arc::new)
        .collect();
    let canonical_grid = if layers.canonical_cell_grid {
        Arc::new(canonical_grid_lines(map, clipped, screen_scale))
    } else {
        Arc::new(Vec::new())
    };
    let refined_shoreline = if layers.refined_shoreline {
        Arc::new(
            shoreline_segments_for_view(map, clipped)
                .into_iter()
                .map(|segment| [segment.start, segment.end])
                .collect(),
        )
    } else {
        Arc::new(Vec::new())
    };
    MapDebugDraw {
        fill_meshes,
        canonical_grid,
        refined_shoreline,
    }
}

fn local_refined_sample(
    surface: &crate::model::CanonicalSurface,
    canonical_x: f32,
    canonical_y: f32,
    seed: u32,
    sea_level: f32,
) -> RefinedSurfaceSample {
    let x = canonical_x.floor() as i32;
    let y = canonical_y.floor() as i32;
    RefinementWindow::new(surface, x - 2, y - 2, x + 4, y + 4, seed, sea_level)
        .map(|window| window.sample(canonical_x, canonical_y))
        .unwrap_or(RefinedSurfaceSample {
            elevation_m: 0.0,
            surface_name: "plain",
            secondary_surface_name: None,
            secondary_mix: 0.0,
            coast_value: 1.0,
        })
}

fn canonical_grid_lines(map: &NativeMap, view: Rect, screen_scale: f32) -> Vec<[Point; 2]> {
    let Some(surface) = map.canonical_surface.as_ref() else {
        return Vec::new();
    };
    let cell_width = map.width / surface.width.max(1) as f32;
    let cell_height = map.height / surface.height.max(1) as f32;
    let stride_x = (5.0 / (cell_width * screen_scale).max(0.001))
        .ceil()
        .max(1.0) as usize;
    let stride_y = (5.0 / (cell_height * screen_scale).max(0.001))
        .ceil()
        .max(1.0) as usize;
    let first_x = (view.left() / cell_width).floor().max(0.0) as usize;
    let last_x = (view.right() / cell_width).ceil().min(surface.width as f32) as usize;
    let first_y = (view.top() / cell_height).floor().max(0.0) as usize;
    let last_y = (view.bottom() / cell_height)
        .ceil()
        .min(surface.height as f32) as usize;
    let mut lines = Vec::new();
    let aligned_x = first_x.div_ceil(stride_x) * stride_x;
    for x in (aligned_x..=last_x).step_by(stride_x) {
        let world_x = x as f32 * cell_width;
        lines.push([
            Point {
                x: world_x,
                y: view.top(),
            },
            Point {
                x: world_x,
                y: view.bottom(),
            },
        ]);
    }
    let aligned_y = first_y.div_ceil(stride_y) * stride_y;
    for y in (aligned_y..=last_y).step_by(stride_y) {
        let world_y = y as f32 * cell_height;
        lines.push([
            Point {
                x: view.left(),
                y: world_y,
            },
            Point {
                x: view.right(),
                y: world_y,
            },
        ]);
    }
    lines
}

fn shoreline_segments_for_view(map: &NativeMap, view: Rect) -> Vec<ShorelineSegment> {
    let Some(surface) = map.canonical_surface.as_ref() else {
        return Vec::new();
    };
    let cell_width = map.width / surface.width.max(1) as f32;
    let cell_height = map.height / surface.height.max(1) as f32;
    let chunk_size = crate::model::CanonicalSurface::CHUNK_SIZE as f32;
    let (chunks_x, chunks_y) = surface.chunk_grid_dimensions();
    let first_x = ((view.left() / cell_width / chunk_size).floor() as i32)
        .clamp(0, chunks_x.saturating_sub(1) as i32) as u32;
    let last_x = ((view.right() / cell_width / chunk_size).ceil() as i32)
        .clamp(0, chunks_x.saturating_sub(1) as i32) as u32;
    let first_y = ((view.top() / cell_height / chunk_size).floor() as i32)
        .clamp(0, chunks_y.saturating_sub(1) as i32) as u32;
    let last_y = ((view.bottom() / cell_height / chunk_size).ceil() as i32)
        .clamp(0, chunks_y.saturating_sub(1) as i32) as u32;
    let mut output = Vec::new();
    for chunk_y in first_y..=last_y {
        for chunk_x in first_x..=last_x {
            output.extend(
                build_shoreline_chunk(map, chunk_x, chunk_y)
                    .into_iter()
                    .filter(|segment| segment_intersects_view(*segment, view)),
            );
        }
    }
    output
}

fn segment_intersects_view(segment: ShorelineSegment, view: Rect) -> bool {
    let minimum_x = segment.start.x.min(segment.end.x);
    let maximum_x = segment.start.x.max(segment.end.x);
    let minimum_y = segment.start.y.min(segment.end.y);
    let maximum_y = segment.start.y.max(segment.end.y);
    maximum_x >= view.left()
        && minimum_x <= view.right()
        && maximum_y >= view.top()
        && minimum_y <= view.bottom()
}

fn add_quad(mesh: &mut Mesh, rect: Rect, color: Color32) {
    let base = mesh.vertices.len() as u32;
    for position in [
        rect.left_top(),
        rect.right_top(),
        rect.right_bottom(),
        rect.left_bottom(),
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

fn raw_water_color(water: &str) -> Color32 {
    match water {
        "saltwater" | "ocean" | "sea" => Color32::from_rgba_unmultiplied(33, 98, 168, 218),
        "freshwater" | "lake" => Color32::from_rgba_unmultiplied(55, 181, 222, 230),
        _ => Color32::from_rgba_unmultiplied(236, 239, 231, 205),
    }
}

fn coast_scalar_color(value: f32, opacity: u8) -> Color32 {
    let strength = (value.abs() / 3.8).clamp(0.0, 1.0).sqrt();
    let target = if value < 0.0 {
        Color32::from_rgb(32, 95, 196)
    } else {
        Color32::from_rgb(208, 67, 54)
    };
    alpha(
        mix_color(Color32::from_rgb(245, 245, 238), target, strength),
        opacity,
    )
}

fn refined_coverage_color(sample: RefinedSurfaceSample) -> Color32 {
    let primary = surface_color(sample.surface_name);
    sample.secondary_surface_name.map_or(primary, |secondary| {
        mix_color(primary, surface_color(secondary), sample.secondary_mix)
    })
}

fn alpha(color: Color32, opacity: u8) -> Color32 {
    Color32::from_rgba_unmultiplied(color.r(), color.g(), color.b(), opacity)
}

#[derive(Clone, Copy)]
struct VisualPixel {
    source_x: usize,
    source_y: usize,
    raw: SurfaceSample,
    refined: RefinedSurfaceSample,
}

struct VisualFrame {
    width: usize,
    height: usize,
    camera: Rect,
    pixels: Vec<VisualPixel>,
}

#[derive(Clone, Copy)]
struct ExportScale {
    name: &'static str,
    camera: Rect,
}

#[derive(Serialize)]
struct VisualValidationManifest {
    purpose: &'static str,
    before_definition: &'static str,
    seed: u32,
    map_id: String,
    map_title: String,
    surface_revision: u64,
    physical_extent_km: [f32; 2],
    surface_dimensions: [u32; 2],
    surface_cell_m: f32,
    generator_version: &'static str,
    display_version: u64,
    screenshots: Vec<ScreenshotMetadata>,
}

#[derive(Serialize)]
struct ScreenshotMetadata {
    file: String,
    scale: &'static str,
    layer: &'static str,
    camera_world_km: [f32; 4],
    canonical_bounds: [u32; 4],
    viewport_pixels: [usize; 2],
    zoom: f32,
    screen_pixels_per_km: f32,
    lod: u8,
    canonical_grid_stride: usize,
}

pub(crate) fn export_visual_validation(map: &NativeMap) -> Result<PathBuf, String> {
    let surface = map
        .canonical_surface
        .as_ref()
        .ok_or_else(|| "The active map has no CanonicalSurface.".to_owned())?;
    if surface.width < 2 || surface.height < 2 {
        return Err("The CanonicalSurface is too small for visual validation.".to_owned());
    }
    let output = crate::diagnostics::create_debug_package("map-visual-validation")?;
    let (output_width, output_height) = export_dimensions(map);
    let focus = coastline_focus(map);
    let scales = [
        ExportScale {
            name: "broad",
            camera: camera_for_scale(map, focus, 1.0),
        },
        ExportScale {
            name: "medium",
            camera: camera_for_scale(map, focus, 0.35),
        },
        ExportScale {
            name: "near",
            camera: camera_for_scale(map, focus, 0.08),
        },
    ];
    let mut manifest = VisualValidationManifest {
        purpose: "URDR 4.4 pass 4.5 visual-only verification",
        before_definition: "The previous renderer was not retained. Before images use authoritative raw category cells and their shared-edge boundary.",
        seed: map.environment_seed,
        map_id: map.source_id.clone(),
        map_title: map.title.clone(),
        surface_revision: map.surface_revision,
        physical_extent_km: [map.width, map.height],
        surface_dimensions: [surface.width, surface.height],
        surface_cell_m: map.surface_cell_m,
        generator_version: env!("CARGO_PKG_VERSION"),
        display_version: DISPLAY_FIELD_VERSION,
        screenshots: Vec::new(),
    };

    for scale in scales {
        let frame = sample_visual_frame(map, scale.camera, output_width, output_height)?;
        let segments = shoreline_segments_for_view(map, scale.camera);
        let raw_terrain = raw_terrain_image(map, &frame);
        let refined_terrain = refined_terrain_image(map, &frame);
        let raw_water = raw_water_image(&frame);
        let coast_scalar = coast_scalar_image(&frame);
        let canonical_elevation = canonical_elevation_image(map, &frame);
        let mut final_map = refined_terrain.clone();
        draw_shoreline(
            &mut final_map,
            frame.width,
            frame.height,
            frame.camera,
            &segments,
            [226, 239, 244, 255],
            1,
        );
        draw_human_and_river_overlays(map, &frame, &mut final_map);
        let mut shoreline_only = raw_water.clone();
        dim_image(&mut shoreline_only, 0.46);
        draw_shoreline(
            &mut shoreline_only,
            frame.width,
            frame.height,
            frame.camera,
            &segments,
            [255, 226, 84, 255],
            2,
        );
        let grid_stride = canonical_grid_stride(map, &frame);
        let mut grid_overlay = refined_terrain.clone();
        draw_canonical_grid_raster(map, &frame, &mut grid_overlay, grid_stride);
        draw_shoreline(
            &mut grid_overlay,
            frame.width,
            frame.height,
            frame.camera,
            &segments,
            [255, 70, 185, 255],
            2,
        );

        let layers = [
            ("A-final", "final_map", final_map),
            ("B-raw-water", "authoritative_raw_water_mask", raw_water),
            ("C-coast-scalar", "continuous_coast_scalar", coast_scalar),
            ("D-refined-shoreline", "refined_shoreline", shoreline_only),
            (
                "E-raw-terrain",
                "raw_terrain_categories",
                raw_terrain.clone(),
            ),
            (
                "F-refined-terrain",
                "refined_terrain_display",
                refined_terrain.clone(),
            ),
            (
                "G-canonical-elevation",
                "canonical_elevation",
                canonical_elevation,
            ),
            (
                "H-grid-shoreline",
                "shoreline_plus_canonical_grid",
                grid_overlay,
            ),
        ];
        for (code, layer, pixels) in layers {
            let file_name = format!("{}-{code}.png", scale.name);
            write_png(&output.join(&file_name), frame.width, frame.height, &pixels)?;
            manifest.screenshots.push(screenshot_metadata(
                map,
                &frame,
                scale.name,
                layer,
                file_name,
                grid_stride,
            ));
        }

        let mut before_shoreline = raw_terrain.clone();
        draw_raw_water_boundary(&frame, &mut before_shoreline, [38, 38, 38, 255]);
        let mut after_shoreline = refined_terrain.clone();
        draw_shoreline(
            &mut after_shoreline,
            frame.width,
            frame.height,
            frame.camera,
            &segments,
            [226, 239, 244, 255],
            1,
        );
        let shoreline_comparison = side_by_side(
            &before_shoreline,
            &after_shoreline,
            frame.width,
            frame.height,
        );
        let shoreline_name = format!("{}-compare-shoreline.png", scale.name);
        write_png(
            &output.join(&shoreline_name),
            frame.width * 2 + 8,
            frame.height,
            &shoreline_comparison,
        )?;
        manifest.screenshots.push(screenshot_metadata(
            map,
            &frame,
            scale.name,
            "before_after_shoreline_side_by_side",
            shoreline_name,
            grid_stride,
        ));

        let terrain_comparison =
            side_by_side(&raw_terrain, &refined_terrain, frame.width, frame.height);
        let terrain_name = format!("{}-compare-terrain.png", scale.name);
        write_png(
            &output.join(&terrain_name),
            frame.width * 2 + 8,
            frame.height,
            &terrain_comparison,
        )?;
        manifest.screenshots.push(screenshot_metadata(
            map,
            &frame,
            scale.name,
            "before_after_terrain_side_by_side",
            terrain_name,
            grid_stride,
        ));
    }

    let metadata = serde_json::to_vec_pretty(&manifest).map_err(|error| error.to_string())?;
    fs::write(output.join("metadata.json"), metadata).map_err(|error| error.to_string())?;
    fs::write(
        output.join("README.txt"),
        b"URDR 4.4 pass 4.5 visual verification\n\nAll layers within one scale share the same seed, map, camera, zoom, and viewport.\nThe left side of compare images is the authoritative raw representation used as Before; the right side is the current refined display used as After.\nNo generation, coast, terrain-score, LOD, worker, or overview parameter is changed by this exporter.\n",
    )
    .map_err(|error| error.to_string())?;
    crate::diagnostics::event(
        "map_visual_validation",
        "export",
        "completed",
        &[
            ("map_id", map.source_id.clone()),
            ("seed", map.environment_seed.to_string()),
            ("surface_revision", map.surface_revision.to_string()),
            ("path", output.display().to_string()),
        ],
    );
    Ok(output)
}

fn export_dimensions(map: &NativeMap) -> (usize, usize) {
    let aspect = map.width.max(0.1) / map.height.max(0.1);
    if aspect >= 1.0 {
        (
            EXPORT_LONG_AXIS,
            (EXPORT_LONG_AXIS as f32 / aspect).round().max(240.0) as usize,
        )
    } else {
        (
            (EXPORT_LONG_AXIS as f32 * aspect).round().max(240.0) as usize,
            EXPORT_LONG_AXIS,
        )
    }
}

fn coastline_focus(map: &NativeMap) -> Point {
    let Some(surface) = map.canonical_surface.as_ref() else {
        return Point {
            x: map.width * 0.5,
            y: map.height * 0.5,
        };
    };
    let probe_width = 192_usize;
    let probe_height =
        ((probe_width as f32 * map.height / map.width.max(0.1)).round() as usize).clamp(32, 192);
    let source_step_x = (surface.width as usize / probe_width).max(1);
    let source_step_y = (surface.height as usize / probe_height).max(1);
    let mut best: Option<(f32, usize, usize)> = None;
    for probe_y in 1..probe_height.saturating_sub(1) {
        for probe_x in 1..probe_width.saturating_sub(1) {
            let source_x = probe_x * surface.width as usize / probe_width;
            let source_y = probe_y * surface.height as usize / probe_height;
            let current = surface.sample(source_x, source_y).water != "land";
            let east = surface
                .sample(
                    (source_x + source_step_x).min(surface.width as usize - 1),
                    source_y,
                )
                .water
                != "land";
            let south = surface
                .sample(
                    source_x,
                    (source_y + source_step_y).min(surface.height as usize - 1),
                )
                .water
                != "land";
            if current == east && current == south {
                continue;
            }
            let normalized_x = probe_x as f32 / probe_width as f32;
            let normalized_y = probe_y as f32 / probe_height as f32;
            let centre_distance = (normalized_x - 0.5).hypot(normalized_y - 0.5);
            let edge_penalty = if !(0.08..=0.92).contains(&normalized_x)
                || !(0.08..=0.92).contains(&normalized_y)
            {
                1.0
            } else {
                0.0
            };
            let score = centre_distance + edge_penalty;
            if best.is_none_or(|(best_score, _, _)| score < best_score) {
                best = Some((score, source_x, source_y));
            }
        }
    }
    best.map_or(
        Point {
            x: map.width * 0.5,
            y: map.height * 0.5,
        },
        |(_, x, y)| Point {
            x: (x as f32 + 0.5) / surface.width as f32 * map.width,
            y: (y as f32 + 0.5) / surface.height as f32 * map.height,
        },
    )
}

fn camera_for_scale(map: &NativeMap, focus: Point, fraction: f32) -> Rect {
    let width = (map.width * fraction).clamp(map.surface_cell_m / 1_000.0 * 8.0, map.width);
    let height = (map.height * fraction).clamp(map.surface_cell_m / 1_000.0 * 8.0, map.height);
    let left = (focus.x - width * 0.5).clamp(0.0, (map.width - width).max(0.0));
    let top = (focus.y - height * 0.5).clamp(0.0, (map.height - height).max(0.0));
    Rect::from_min_size(Pos2::new(left, top), eframe::egui::Vec2::new(width, height))
}

fn sample_visual_frame(
    map: &NativeMap,
    camera: Rect,
    width: usize,
    height: usize,
) -> Result<VisualFrame, String> {
    let surface = map
        .canonical_surface
        .as_ref()
        .ok_or_else(|| "The active map has no CanonicalSurface.".to_owned())?;
    let fallback_raw = surface.sample(0, 0);
    let fallback_refined =
        local_refined_sample(surface, 0.5, 0.5, map.environment_seed, map.sea_level);
    let mut pixels = vec![
        VisualPixel {
            source_x: 0,
            source_y: 0,
            raw: fallback_raw,
            refined: fallback_refined,
        };
        width.saturating_mul(height)
    ];
    for block_y in (0..height).step_by(EXPORT_BLOCK_AXIS) {
        let block_height = EXPORT_BLOCK_AXIS.min(height - block_y);
        for block_x in (0..width).step_by(EXPORT_BLOCK_AXIS) {
            let block_width = EXPORT_BLOCK_AXIS.min(width - block_x);
            let first_x = canonical_x_for_pixel(map, surface, camera, block_x, width);
            let last_x = canonical_x_for_pixel(
                map,
                surface,
                camera,
                block_x + block_width.saturating_sub(1),
                width,
            );
            let first_y = canonical_y_for_pixel(map, surface, camera, block_y, height);
            let last_y = canonical_y_for_pixel(
                map,
                surface,
                camera,
                block_y + block_height.saturating_sub(1),
                height,
            );
            let window = RefinementWindow::new(
                surface,
                first_x.min(last_x).floor() as i32 - 3,
                first_y.min(last_y).floor() as i32 - 3,
                first_x.max(last_x).ceil() as i32 + 4,
                first_y.max(last_y).ceil() as i32 + 4,
                map.environment_seed,
                map.sea_level,
            )
            .ok_or_else(|| "Failed to build a refinement window for visual export.".to_owned())?;
            for output_y in block_y..block_y + block_height {
                let canonical_y = canonical_y_for_pixel(map, surface, camera, output_y, height);
                let source_y = canonical_y
                    .floor()
                    .clamp(0.0, surface.height.saturating_sub(1) as f32)
                    as usize;
                for output_x in block_x..block_x + block_width {
                    let canonical_x = canonical_x_for_pixel(map, surface, camera, output_x, width);
                    let source_x = canonical_x
                        .floor()
                        .clamp(0.0, surface.width.saturating_sub(1) as f32)
                        as usize;
                    pixels[output_y * width + output_x] = VisualPixel {
                        source_x,
                        source_y,
                        raw: surface.sample(source_x, source_y),
                        refined: window.sample(canonical_x, canonical_y),
                    };
                }
            }
        }
    }
    Ok(VisualFrame {
        width,
        height,
        camera,
        pixels,
    })
}

fn canonical_x_for_pixel(
    map: &NativeMap,
    surface: &crate::model::CanonicalSurface,
    camera: Rect,
    pixel_x: usize,
    width: usize,
) -> f32 {
    let world_x = camera.left() + (pixel_x as f32 + 0.5) / width.max(1) as f32 * camera.width();
    (world_x / map.width.max(0.001) * surface.width as f32).clamp(0.0, surface.width as f32 - 0.001)
}

fn canonical_y_for_pixel(
    map: &NativeMap,
    surface: &crate::model::CanonicalSurface,
    camera: Rect,
    pixel_y: usize,
    height: usize,
) -> f32 {
    let world_y = camera.top() + (pixel_y as f32 + 0.5) / height.max(1) as f32 * camera.height();
    (world_y / map.height.max(0.001) * surface.height as f32)
        .clamp(0.0, surface.height as f32 - 0.001)
}

fn raw_terrain_image(map: &NativeMap, frame: &VisualFrame) -> Vec<u8> {
    frame
        .pixels
        .iter()
        .flat_map(|pixel| {
            let name = if pixel.raw.water == "land" {
                pixel.raw.terrain
            } else {
                pixel.raw.water
            };
            rgba(surface_display_color_at(
                name,
                pixel.raw.elevation_m,
                map.environment_seed,
                pixel.source_x,
                pixel.source_y,
                true,
            ))
        })
        .collect()
}

fn refined_terrain_image(map: &NativeMap, frame: &VisualFrame) -> Vec<u8> {
    frame
        .pixels
        .iter()
        .flat_map(|pixel| {
            let primary = surface_display_color_at(
                pixel.refined.surface_name,
                pixel.refined.elevation_m,
                map.environment_seed,
                pixel.source_x,
                pixel.source_y,
                true,
            );
            let color = pixel
                .refined
                .secondary_surface_name
                .map_or(primary, |secondary| {
                    mix_color(
                        primary,
                        surface_display_color_at(
                            secondary,
                            pixel.refined.elevation_m,
                            map.environment_seed,
                            pixel.source_x,
                            pixel.source_y,
                            true,
                        ),
                        pixel.refined.secondary_mix,
                    )
                });
            rgba(color)
        })
        .collect()
}

fn raw_water_image(frame: &VisualFrame) -> Vec<u8> {
    frame
        .pixels
        .iter()
        .flat_map(|pixel| rgba(raw_water_color(pixel.raw.water)))
        .collect()
}

fn coast_scalar_image(frame: &VisualFrame) -> Vec<u8> {
    frame
        .pixels
        .iter()
        .flat_map(|pixel| rgba(coast_scalar_color(pixel.refined.coast_value, 255)))
        .collect()
}

fn canonical_elevation_image(map: &NativeMap, frame: &VisualFrame) -> Vec<u8> {
    let minimum = frame
        .pixels
        .iter()
        .map(|pixel| pixel.raw.elevation_m)
        .fold(f32::INFINITY, f32::min);
    let maximum = frame
        .pixels
        .iter()
        .map(|pixel| pixel.raw.elevation_m)
        .fold(f32::NEG_INFINITY, f32::max);
    frame
        .pixels
        .iter()
        .flat_map(|pixel| {
            let color = if pixel.raw.elevation_m < map.sea_level {
                let depth = ((map.sea_level - pixel.raw.elevation_m)
                    / (map.sea_level - minimum).max(1.0))
                .clamp(0.0, 1.0);
                mix_color(
                    Color32::from_rgb(92, 173, 210),
                    Color32::from_rgb(14, 40, 82),
                    depth.sqrt(),
                )
            } else {
                let height = ((pixel.raw.elevation_m - map.sea_level)
                    / (maximum - map.sea_level).max(1.0))
                .clamp(0.0, 1.0);
                mix_color(
                    Color32::from_rgb(38, 46, 43),
                    Color32::from_rgb(245, 245, 240),
                    height.sqrt(),
                )
            };
            rgba(color)
        })
        .collect()
}

fn draw_human_and_river_overlays(map: &NativeMap, frame: &VisualFrame, image: &mut [u8]) {
    let scale = frame.width as f32 / frame.camera.width().max(0.001);
    for river in &map.rivers {
        let width = (river.width * scale).round().clamp(1.0, 12.0) as i32;
        draw_world_line(
            image,
            frame,
            river.start,
            river.end,
            [52, 153, 226, 255],
            width,
        );
    }
    for road in &map.roads {
        for pair in road.nodes.windows(2) {
            draw_world_line(image, frame, pair[0], pair[1], [93, 60, 45, 255], 2);
        }
    }
    for location in &map.locations {
        let state = location
            .states
            .iter()
            .filter(|state| {
                state.start_year <= map.current_year
                    && state.end_year.is_none_or(|end| end >= map.current_year)
            })
            .max_by_key(|state| state.start_year);
        if let Some(state) = state
            && frame
                .camera
                .contains(Pos2::new(state.position.x, state.position.y))
        {
            let (x, y) = world_to_pixel(frame, state.position);
            draw_disc(
                image,
                frame.width,
                frame.height,
                x.round() as i32,
                y.round() as i32,
                3,
                [246, 249, 250, 255],
            );
        }
    }
}

fn draw_shoreline(
    image: &mut [u8],
    width: usize,
    height: usize,
    camera: Rect,
    segments: &[ShorelineSegment],
    color: [u8; 4],
    thickness: i32,
) {
    let frame = VisualFrame {
        width,
        height,
        camera,
        pixels: Vec::new(),
    };
    for segment in segments {
        draw_world_line(image, &frame, segment.start, segment.end, color, thickness);
    }
}

fn draw_world_line(
    image: &mut [u8],
    frame: &VisualFrame,
    start: Point,
    end: Point,
    color: [u8; 4],
    thickness: i32,
) {
    let (start_x, start_y) = world_to_pixel(frame, start);
    let (end_x, end_y) = world_to_pixel(frame, end);
    draw_line(
        image,
        frame.width,
        frame.height,
        start_x,
        start_y,
        end_x,
        end_y,
        color,
        thickness,
    );
}

fn world_to_pixel(frame: &VisualFrame, point: Point) -> (f32, f32) {
    (
        (point.x - frame.camera.left()) / frame.camera.width().max(0.001) * frame.width as f32,
        (point.y - frame.camera.top()) / frame.camera.height().max(0.001) * frame.height as f32,
    )
}

#[allow(clippy::too_many_arguments)]
fn draw_line(
    image: &mut [u8],
    width: usize,
    height: usize,
    start_x: f32,
    start_y: f32,
    end_x: f32,
    end_y: f32,
    color: [u8; 4],
    thickness: i32,
) {
    let dx = end_x - start_x;
    let dy = end_y - start_y;
    let steps = dx.abs().max(dy.abs()).ceil().max(1.0) as usize;
    for step in 0..=steps {
        let amount = step as f32 / steps as f32;
        let x = (start_x + dx * amount).round() as i32;
        let y = (start_y + dy * amount).round() as i32;
        draw_disc(image, width, height, x, y, thickness.max(1) / 2, color);
    }
}

fn draw_disc(
    image: &mut [u8],
    width: usize,
    height: usize,
    center_x: i32,
    center_y: i32,
    radius: i32,
    color: [u8; 4],
) {
    for y in center_y - radius..=center_y + radius {
        for x in center_x - radius..=center_x + radius {
            if (x - center_x).pow(2) + (y - center_y).pow(2) <= radius.pow(2) {
                set_pixel(image, width, height, x, y, color);
            }
        }
    }
}

fn set_pixel(image: &mut [u8], width: usize, height: usize, x: i32, y: i32, color: [u8; 4]) {
    if x < 0 || y < 0 || x >= width as i32 || y >= height as i32 {
        return;
    }
    let index = (y as usize * width + x as usize) * 4;
    image[index..index + 4].copy_from_slice(&color);
}

fn draw_raw_water_boundary(frame: &VisualFrame, image: &mut [u8], color: [u8; 4]) {
    for y in 0..frame.height {
        for x in 0..frame.width {
            let water = frame.pixels[y * frame.width + x].raw.water != "land";
            let east_changed = x + 1 < frame.width
                && water != (frame.pixels[y * frame.width + x + 1].raw.water != "land");
            let south_changed = y + 1 < frame.height
                && water != (frame.pixels[(y + 1) * frame.width + x].raw.water != "land");
            if east_changed || south_changed {
                set_pixel(image, frame.width, frame.height, x as i32, y as i32, color);
            }
        }
    }
}

fn canonical_grid_stride(map: &NativeMap, frame: &VisualFrame) -> usize {
    let Some(surface) = map.canonical_surface.as_ref() else {
        return 1;
    };
    let cell_pixels = map.width / surface.width.max(1) as f32 * frame.width as f32
        / frame.camera.width().max(0.001);
    (6.0 / cell_pixels.max(0.001)).ceil().max(1.0) as usize
}

fn draw_canonical_grid_raster(
    map: &NativeMap,
    frame: &VisualFrame,
    image: &mut [u8],
    stride: usize,
) {
    let Some(surface) = map.canonical_surface.as_ref() else {
        return;
    };
    let cell_width = map.width / surface.width.max(1) as f32;
    let cell_height = map.height / surface.height.max(1) as f32;
    let first_x = (frame.camera.left() / cell_width).floor().max(0.0) as usize;
    let last_x = (frame.camera.right() / cell_width)
        .ceil()
        .min(surface.width as f32) as usize;
    let first_y = (frame.camera.top() / cell_height).floor().max(0.0) as usize;
    let last_y = (frame.camera.bottom() / cell_height)
        .ceil()
        .min(surface.height as f32) as usize;
    let x_stride = stride.max(1);
    let y_stride = stride.max(1);
    let start_x = first_x.div_ceil(x_stride) * x_stride;
    for x in (start_x..=last_x).step_by(x_stride) {
        let world_x = x as f32 * cell_width;
        draw_world_line(
            image,
            frame,
            Point {
                x: world_x,
                y: frame.camera.top(),
            },
            Point {
                x: world_x,
                y: frame.camera.bottom(),
            },
            [255, 208, 64, 180],
            1,
        );
    }
    let start_y = first_y.div_ceil(y_stride) * y_stride;
    for y in (start_y..=last_y).step_by(y_stride) {
        let world_y = y as f32 * cell_height;
        draw_world_line(
            image,
            frame,
            Point {
                x: frame.camera.left(),
                y: world_y,
            },
            Point {
                x: frame.camera.right(),
                y: world_y,
            },
            [255, 208, 64, 180],
            1,
        );
    }
}

fn dim_image(image: &mut [u8], factor: f32) {
    for pixel in image.chunks_exact_mut(4) {
        pixel[0] = (pixel[0] as f32 * factor).round() as u8;
        pixel[1] = (pixel[1] as f32 * factor).round() as u8;
        pixel[2] = (pixel[2] as f32 * factor).round() as u8;
    }
}

fn side_by_side(left: &[u8], right: &[u8], width: usize, height: usize) -> Vec<u8> {
    let output_width = width * 2 + 8;
    let mut output = vec![0_u8; output_width * height * 4];
    for y in 0..height {
        let left_source = &left[y * width * 4..(y + 1) * width * 4];
        let right_source = &right[y * width * 4..(y + 1) * width * 4];
        let row = &mut output[y * output_width * 4..(y + 1) * output_width * 4];
        row[..width * 4].copy_from_slice(left_source);
        for pixel in row[width * 4..(width + 8) * 4].chunks_exact_mut(4) {
            pixel.copy_from_slice(&[14, 20, 28, 255]);
        }
        row[(width + 8) * 4..].copy_from_slice(right_source);
    }
    for x in 0..width {
        for y in 0..6.min(height) {
            set_pixel(
                &mut output,
                output_width,
                height,
                x as i32,
                y as i32,
                [224, 157, 48, 255],
            );
            set_pixel(
                &mut output,
                output_width,
                height,
                (width + 8 + x) as i32,
                y as i32,
                [52, 188, 224, 255],
            );
        }
    }
    output
}

fn screenshot_metadata(
    map: &NativeMap,
    frame: &VisualFrame,
    scale: &'static str,
    layer: &'static str,
    file: String,
    canonical_grid_stride: usize,
) -> ScreenshotMetadata {
    let surface = map.canonical_surface.as_ref().expect("validated surface");
    let screen_pixels_per_km = frame.width as f32 / frame.camera.width().max(0.001);
    let canonical_bounds = [
        (frame.camera.left() / map.width.max(0.001) * surface.width as f32)
            .floor()
            .max(0.0) as u32,
        (frame.camera.top() / map.height.max(0.001) * surface.height as f32)
            .floor()
            .max(0.0) as u32,
        (frame.camera.right() / map.width.max(0.001) * surface.width as f32)
            .ceil()
            .min(surface.width as f32) as u32,
        (frame.camera.bottom() / map.height.max(0.001) * surface.height as f32)
            .ceil()
            .min(surface.height as f32) as u32,
    ];
    ScreenshotMetadata {
        file,
        scale,
        layer,
        camera_world_km: [
            frame.camera.left(),
            frame.camera.top(),
            frame.camera.width(),
            frame.camera.height(),
        ],
        canonical_bounds,
        viewport_pixels: [frame.width, frame.height],
        zoom: map.width / frame.camera.width().max(0.001),
        screen_pixels_per_km,
        lod: diagnostic_surface_lod(screen_pixels_per_km, map.surface_cell_m),
        canonical_grid_stride,
    }
}

fn rgba(color: Color32) -> [u8; 4] {
    [color.r(), color.g(), color.b(), 255]
}

fn write_png(path: &Path, width: usize, height: usize, pixels: &[u8]) -> Result<(), String> {
    let file = File::create(path).map_err(|error| error.to_string())?;
    let writer = BufWriter::new(file);
    let mut encoder = png::Encoder::new(writer, width as u32, height as u32);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder.write_header().map_err(|error| error.to_string())?;
    writer
        .write_image_data(pixels)
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{CanonicalSurface, Language, LoadedWorld};

    #[test]
    fn debug_layer_bits_are_stable_and_independent() {
        let mut values = Vec::new();
        for index in 0..6 {
            let layers = MapDebugLayers {
                canonical_cell_grid: index == 0,
                raw_water_mask: index == 1,
                coast_scalar: index == 2,
                refined_shoreline: index == 3,
                raw_terrain_category: index == 4,
                refined_terrain_coverage: index == 5,
            };
            values.push(layers.bits());
        }
        assert_eq!(values, [1, 2, 4, 8, 16, 32]);
    }

    #[test]
    fn all_visual_layers_share_the_same_camera_metadata() {
        let mut map = LoadedWorld::load_demo(Language::English).expect("demo").map;
        map.width = 6.4;
        map.height = 3.2;
        map.surface_cell_m = 100.0;
        map.canonical_surface = Some(Arc::new(CanonicalSurface::generate(64, 32, |x, y| {
            let water = u8::from(x > 40 + (y % 5));
            (if water == 0 { 120 } else { -90 }, (x % 4) as u8, water)
        })));
        let focus = coastline_focus(&map);
        let camera = camera_for_scale(&map, focus, 0.35);
        let frame = sample_visual_frame(&map, camera, 320, 160).expect("visual frame");
        let first = screenshot_metadata(&map, &frame, "medium", "raw", "raw.png".to_owned(), 1);
        let second = screenshot_metadata(
            &map,
            &frame,
            "medium",
            "refined",
            "refined.png".to_owned(),
            1,
        );
        assert_eq!(first.camera_world_km, second.camera_world_km);
        assert_eq!(first.viewport_pixels, second.viewport_pixels);
        assert_eq!(first.lod, second.lod);
    }

    #[test]
    #[ignore = "explicit three-scale visual validation export"]
    fn visual_validation_exports_three_scales() {
        let log_directory = crate::diagnostics::initialize().expect("diagnostics logger");
        let mut map = LoadedWorld::load_demo(Language::Korean)
            .expect("Korean demo")
            .map;
        if map.canonical_surface.is_none() {
            assert!(map.rebuild_canonical_surface());
        }
        let output = export_visual_validation(&map).expect("visual validation export");
        for scale in ["broad", "medium", "near"] {
            for layer in [
                "A-final",
                "B-raw-water",
                "C-coast-scalar",
                "D-refined-shoreline",
                "E-raw-terrain",
                "F-refined-terrain",
                "G-canonical-elevation",
                "H-grid-shoreline",
            ] {
                assert!(output.join(format!("{scale}-{layer}.png")).is_file());
            }
            assert!(
                output
                    .join(format!("{scale}-compare-shoreline.png"))
                    .is_file()
            );
            assert!(
                output
                    .join(format!("{scale}-compare-terrain.png"))
                    .is_file()
            );
        }
        assert!(output.join("metadata.json").is_file());
        assert!(output.join("README.txt").is_file());
        eprintln!("diagnostics={}", log_directory.display());
        eprintln!("visual_validation={}", output.display());
    }
}
