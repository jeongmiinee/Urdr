use std::{
    collections::BTreeMap,
    fs::{self, File},
    io::BufWriter,
    path::{Path, PathBuf},
    time::Instant,
};

use serde::Serialize;

use crate::{
    generator::{PipelineDiagnosticReplay, replay_pipeline_diagnostics},
    model::{LoadedWorld, NativeMap, Point, RiverSegment},
    procedural::{
        GeologicGuideMesh, GeologyTermMask, TerrainFieldConfig, sample_terrain_field,
        sample_terrain_field_with_terms,
    },
    spatial::{PlanetPosition, RegionSelection, regional_metric_position_rotated},
};

const PROBE_POINTS: [(&str, usize, usize); 3] =
    [("A", 1_125, 542), ("B", 2_333, 1_042), ("C", 4_167, 1_146)];
const IMAGE_WIDTH: usize = 512;
const IMAGE_HEIGHT: usize = 384;
const TOPOLOGY_WIDTH: usize = 960;
const ORIENTATION_BINS: usize = 36;

pub(crate) struct AnalysisLineage {
    pub(crate) width: usize,
    pub(crate) height: usize,
    pub(crate) planet_raw: Vec<f32>,
    pub(crate) regional_sample: Vec<f32>,
    pub(crate) regional_base: Vec<f32>,
    pub(crate) broad: Vec<f32>,
    pub(crate) medium: Vec<f32>,
    pub(crate) fine: Vec<f32>,
    pub(crate) combined: Vec<f32>,
    pub(crate) replay: PipelineDiagnosticReplay,
}

#[derive(Serialize)]
struct DiagnosticManifest {
    purpose: &'static str,
    seed: u32,
    map_id: String,
    map_title: String,
    surface_revision: u64,
    physical_extent_km: [f32; 2],
    canonical_dimensions: [u32; 2],
    analysis_dimensions: [usize; 2],
    surface_cell_m: f32,
    interpolation_planet_to_region: &'static str,
    interpolation_analysis_to_canonical: &'static str,
    explicit_triangle_interpolation: bool,
    region_ports_present: bool,
    render_geometry_simplification_present: bool,
    generator_version: &'static str,
    probes: Vec<ProbeManifest>,
    rivers: Vec<RiverManifest>,
}

#[derive(Serialize)]
struct ProbeManifest {
    id: &'static str,
    canonical: [usize; 2],
    world_km: [f32; 2],
    canonical_bounds: [usize; 4],
}

#[derive(Clone, Serialize)]
struct RiverManifest {
    river_id: String,
    screen_px: [f32; 2],
    world_km: [f32; 2],
    canonical: [usize; 2],
    total_length_km: f64,
    chord_length_km: f64,
    straightness: f64,
    dominant_direction_deg: f64,
}

#[derive(Clone, Copy)]
struct Window {
    left: usize,
    top: usize,
    right: usize,
    bottom: usize,
}

pub(crate) fn export_pipeline_lineage(world: &LoadedWorld) -> Result<PathBuf, String> {
    // Persisted demos can carry a fully materialized surface without its
    // virtual recipe. Rebuild only this diagnostic clone so component lineage
    // sampling is available without touching the loaded project.
    let mut diagnostic_map = world.map.clone();
    if !diagnostic_map.rebuild_canonical_recipe_for_diagnostics() {
        return Err("The diagnostic Canonical recipe could not be rebuilt.".to_owned());
    }
    let map = &diagnostic_map;
    let surface = map
        .canonical_surface
        .as_ref()
        .ok_or_else(|| "The active map has no CanonicalSurface.".to_owned())?;
    let selection = resolve_selection(world, map);
    let lineage = reconstruct_analysis_lineage(world, map, &selection)?;
    let output = crate::diagnostics::create_debug_package("map-pass-5-lineage")?;

    let global_scale = absolute_scale(map, &lineage);
    let stages = elevation_stages(map, &lineage);
    let mut probe_manifest = Vec::new();
    for &(id, x, y) in &PROBE_POINTS {
        let x = x.min(surface.width.saturating_sub(1) as usize);
        let y = y.min(surface.height.saturating_sub(1) as usize);
        let window = probe_window(map, x, y);
        let world_x = (x as f32 + 0.5) / surface.width.max(1) as f32 * map.width;
        let world_y = (y as f32 + 0.5) / surface.height.max(1) as f32 * map.height;
        probe_manifest.push(ProbeManifest {
            id,
            canonical: [x, y],
            world_km: [world_x, world_y],
            canonical_bounds: [window.left, window.top, window.right, window.bottom],
        });
        for (stage_index, (stage_name, field)) in stages.iter().enumerate() {
            let values = sample_stage_window(map, &lineage, field, window)?;
            let local_scale = finite_range(&values).unwrap_or(global_scale);
            let code = format!("{:02}", stage_index + 1);
            write_heatmap(
                &output.join(format!(
                    "elevation-{id}-{code}-{stage_name}-independent.png"
                )),
                IMAGE_WIDTH,
                IMAGE_HEIGHT,
                &values,
                local_scale,
            )?;
            write_heatmap(
                &output.join(format!("elevation-{id}-{code}-{stage_name}-absolute.png")),
                IMAGE_WIDTH,
                IMAGE_HEIGHT,
                &values,
                global_scale,
            )?;
        }
        let guide_disabled = sample_procedural_window(map, window, false);
        let guide_enabled = sample_procedural_window(map, window, true);
        write_heatmap(
            &output.join(format!(
                "elevation-{id}-procedural-guide-disabled-independent.png"
            )),
            IMAGE_WIDTH,
            IMAGE_HEIGHT,
            &guide_disabled,
            finite_range(&guide_disabled).unwrap_or(global_scale),
        )?;
        write_heatmap(
            &output.join(format!(
                "elevation-{id}-procedural-guide-enabled-independent.png"
            )),
            IMAGE_WIDTH,
            IMAGE_HEIGHT,
            &guide_enabled,
            finite_range(&guide_enabled).unwrap_or(global_scale),
        )?;
        let guide_delta = guide_enabled
            .iter()
            .zip(&guide_disabled)
            .map(|(enabled, disabled)| enabled - disabled)
            .collect::<Vec<_>>();
        write_heatmap(
            &output.join(format!(
                "elevation-{id}-procedural-guide-delta-independent.png"
            )),
            IMAGE_WIDTH,
            IMAGE_HEIGHT,
            &guide_delta,
            finite_range(&guide_delta).unwrap_or((-1.0, 1.0)),
        )?;
    }

    let topology = export_topology_overlays(&output, world, map, &selection)?;
    let correlation_report =
        export_edge_and_correlation_metrics(&output, map, &lineage, &topology)?;
    let rivers = select_diagnostic_rivers(map, 5);
    export_river_lineage(&output, map, &lineage.replay, &rivers)?;

    let manifest = DiagnosticManifest {
        purpose: "URDR 4.4 pass 5 elevation and river first-occurrence diagnosis",
        seed: map.environment_seed,
        map_id: map.source_id.clone(),
        map_title: map.title.clone(),
        surface_revision: map.surface_revision,
        physical_extent_km: [map.width, map.height],
        canonical_dimensions: [surface.width, surface.height],
        analysis_dimensions: [lineage.width, lineage.height],
        surface_cell_m: map.surface_cell_m,
        interpolation_planet_to_region: "equirectangular PlanetSurface raster bilinear interpolation, followed by spherical fBm detail sampling",
        interpolation_analysis_to_canonical: "tensor-product quintic smoothstep interpolation over four rectangular analysis cells",
        explicit_triangle_interpolation: false,
        region_ports_present: false,
        render_geometry_simplification_present: false,
        generator_version: env!("CARGO_PKG_VERSION"),
        probes: probe_manifest,
        rivers: rivers.clone(),
    };
    fs::write(
        output.join("metadata.json"),
        serde_json::to_vec_pretty(&manifest).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    fs::write(
        output.join("interpolation-audit.txt"),
        interpolation_audit(map, &lineage),
    )
    .map_err(|error| error.to_string())?;
    fs::write(output.join("correlation-summary.txt"), correlation_report)
        .map_err(|error| error.to_string())?;
    fs::write(
        output.join("README.txt"),
        package_readme(map, &lineage, &rivers),
    )
    .map_err(|error| error.to_string())?;
    crate::diagnostics::event(
        "map_pipeline_diagnostics",
        "pass_5_lineage",
        "exported",
        &[
            ("map_id", map.source_id.clone()),
            ("seed", map.environment_seed.to_string()),
            ("path", output.display().to_string()),
        ],
    );
    Ok(output)
}

pub(crate) fn resolve_selection(world: &LoadedWorld, map: &NativeMap) -> RegionSelection {
    map.region_id
        .as_deref()
        .and_then(|id| world.regions.iter().find(|region| region.id == id))
        .map(|region| region.selection.clone())
        .unwrap_or_else(|| RegionSelection::LocalRectangle {
            center: PlanetPosition::from_latitude_longitude_deg(
                map.generation_settings
                    .as_ref()
                    .map_or(0.0, |settings| settings.center_latitude_deg),
                map.generation_settings
                    .as_ref()
                    .map_or(0.0, |settings| settings.center_longitude_deg),
            ),
            width_m: f64::from(map.width) * 1_000.0,
            height_m: f64::from(map.height) * 1_000.0,
            selection_bearing_deg: 0.0,
        })
}

pub(crate) fn reconstruct_analysis_lineage(
    world: &LoadedWorld,
    map: &NativeMap,
    selection: &RegionSelection,
) -> Result<AnalysisLineage, String> {
    let count = map.grid_width.saturating_mul(map.grid_height);
    if count == 0 || map.elevation.len() != count {
        return Err("The active map analysis grid is incomplete.".to_owned());
    }
    let (center, _, _, bearing) = selection
        .metric_bounds()
        .ok_or_else(|| "The active map region does not expose a metric selection.".to_owned())?;
    let planet = &world.planet;
    let radius = planet.physical.radius_m.max(1.0);
    let resolution = f64::from(map.surface_cell_m.max(10.0));
    let resolution_scale = (100.0 / resolution.clamp(10.0, 10_000.0))
        .sqrt()
        .clamp(0.25, 2.5) as f32;
    let mut planet_raw = Vec::with_capacity(count);
    let mut regional_sample = Vec::with_capacity(count);
    let mut broad = Vec::with_capacity(count);
    let mut medium = Vec::with_capacity(count);
    let mut fine = Vec::with_capacity(count);
    for index in 0..count {
        let x = index % map.grid_width;
        let y = index / map.grid_width;
        let x_km = (x as f32 + 0.5) / map.grid_width.max(1) as f32 * map.width;
        let y_km = (y as f32 + 0.5) / map.grid_height.max(1) as f32 * map.height;
        let position = regional_metric_position_rotated(
            center,
            f64::from(x_km - map.width * 0.5) * 1_000.0,
            f64::from(map.height * 0.5 - y_km) * 1_000.0,
            bearing,
            radius,
        );
        let base = planet.surface.sample_interpolated(position);
        let coastal_scale = (base.elevation_m.abs() / 300.0).clamp(0.18, 1.0);
        let broad_value = planet.detail_noise(position, "elevation-broad", 96.0, 4) as f32
            * 135.0
            * coastal_scale;
        let medium_value = planet.detail_noise(position, "elevation-medium", 384.0, 3) as f32
            * 42.0
            * coastal_scale;
        let fine_value = planet.detail_noise(position, "elevation-fine", 1_536.0, 2) as f32
            * 12.0
            * resolution_scale
            * coastal_scale;
        planet_raw.push(base.elevation_m);
        broad.push(broad_value);
        medium.push(medium_value);
        fine.push(fine_value);
        regional_sample.push(base.elevation_m + broad_value + medium_value + fine_value);
    }
    let regional_base = regional_sample.clone();
    let combined = regional_sample.clone();
    let replay = replay_pipeline_diagnostics(map, &combined)?;
    Ok(AnalysisLineage {
        width: map.grid_width,
        height: map.grid_height,
        planet_raw,
        regional_sample,
        regional_base,
        broad,
        medium,
        fine,
        combined,
        replay,
    })
}

enum StageField<'a> {
    Analysis(&'a [f32]),
    Canonical(CanonicalField),
}

#[derive(Clone, Copy)]
enum CanonicalField {
    Analysis,
    Procedural,
    Geology,
    Final,
}

fn elevation_stages<'a>(
    map: &'a NativeMap,
    lineage: &'a AnalysisLineage,
) -> Vec<(&'static str, StageField<'a>)> {
    vec![
        ("planet-raw", StageField::Analysis(&lineage.planet_raw)),
        (
            "regional-sample",
            StageField::Analysis(&lineage.regional_sample),
        ),
        (
            "regional-base",
            StageField::Analysis(&lineage.regional_base),
        ),
        ("broad-detail", StageField::Analysis(&lineage.broad)),
        ("mid-detail", StageField::Analysis(&lineage.medium)),
        ("fine-detail", StageField::Analysis(&lineage.fine)),
        (
            "combined-preconditioning",
            StageField::Analysis(&lineage.combined),
        ),
        (
            "priority-flood",
            StageField::Analysis(&lineage.replay.priority_flood_elevation),
        ),
        (
            "pre-erosion",
            StageField::Analysis(&lineage.replay.pre_erosion_elevation),
        ),
        (
            "post-river-erosion",
            StageField::Analysis(&lineage.replay.post_erosion_elevation),
        ),
        (
            "final-regional-analysis",
            StageField::Analysis(&map.elevation),
        ),
        (
            "canonical-analysis",
            StageField::Canonical(CanonicalField::Analysis),
        ),
        (
            "canonical-procedural",
            StageField::Canonical(CanonicalField::Procedural),
        ),
        (
            "canonical-geology",
            StageField::Canonical(CanonicalField::Geology),
        ),
        (
            "canonical-final",
            StageField::Canonical(CanonicalField::Final),
        ),
    ]
}

fn absolute_scale(map: &NativeMap, lineage: &AnalysisLineage) -> (f32, f32) {
    let mut minimum = f32::INFINITY;
    let mut maximum = f32::NEG_INFINITY;
    for field in [
        lineage.planet_raw.as_slice(),
        lineage.regional_sample.as_slice(),
        lineage.replay.pre_erosion_elevation.as_slice(),
        lineage.replay.priority_flood_elevation.as_slice(),
        lineage.replay.post_erosion_elevation.as_slice(),
        map.elevation.as_slice(),
    ] {
        if let Some((low, high)) = finite_range(field) {
            minimum = minimum.min(low);
            maximum = maximum.max(high);
        }
    }
    if minimum.is_finite() && maximum > minimum {
        (minimum, maximum)
    } else {
        (-1_000.0, 5_000.0)
    }
}

fn probe_window(map: &NativeMap, x: usize, y: usize) -> Window {
    let surface = map.canonical_surface.as_ref().expect("validated surface");
    let width = (surface.width as usize / 7).clamp(320, 900);
    let height =
        ((width as f32 * map.height / map.width.max(0.1)).round() as usize).clamp(220, 700);
    let left = x
        .saturating_sub(width / 2)
        .min(surface.width.saturating_sub(width as u32) as usize);
    let top = y
        .saturating_sub(height / 2)
        .min(surface.height.saturating_sub(height as u32) as usize);
    Window {
        left,
        top,
        right: (left + width).min(surface.width as usize),
        bottom: (top + height).min(surface.height as usize),
    }
}

fn sample_stage_window(
    map: &NativeMap,
    lineage: &AnalysisLineage,
    field: &StageField<'_>,
    window: Window,
) -> Result<Vec<f32>, String> {
    let surface = map.canonical_surface.as_ref().expect("validated surface");
    let mut output = Vec::with_capacity(IMAGE_WIDTH * IMAGE_HEIGHT);
    for py in 0..IMAGE_HEIGHT {
        let canonical_y = window.top as f64
            + (py as f64 + 0.5) / IMAGE_HEIGHT as f64 * (window.bottom - window.top) as f64;
        for px in 0..IMAGE_WIDTH {
            let canonical_x = window.left as f64
                + (px as f64 + 0.5) / IMAGE_WIDTH as f64 * (window.right - window.left) as f64;
            let value = match field {
                StageField::Analysis(values) => sample_analysis_quintic(
                    values,
                    lineage.width,
                    lineage.height,
                    canonical_x,
                    canonical_y,
                    surface.width,
                    surface.height,
                ),
                StageField::Canonical(kind) => {
                    let x = canonical_x
                        .floor()
                        .clamp(0.0, surface.width.saturating_sub(1) as f64)
                        as usize;
                    let y = canonical_y
                        .floor()
                        .clamp(0.0, surface.height.saturating_sub(1) as f64)
                        as usize;
                    let sample = surface
                        .diagnostic_sample(x, y)
                        .ok_or_else(|| "Canonical diagnostic sampling failed.".to_owned())?;
                    match kind {
                        CanonicalField::Analysis => sample.analysis_elevation_m,
                        CanonicalField::Procedural => sample.procedural_elevation_m,
                        CanonicalField::Geology => sample.geology_bias_m,
                        CanonicalField::Final => sample.final_elevation_m,
                    }
                }
            };
            output.push(value);
        }
    }
    Ok(output)
}

fn sample_analysis_quintic(
    field: &[f32],
    width: usize,
    height: usize,
    canonical_x: f64,
    canonical_y: f64,
    canonical_width: u32,
    canonical_height: u32,
) -> f32 {
    if width == 0 || height == 0 || field.is_empty() {
        return 0.0;
    }
    let gx = (canonical_x * width as f64 / canonical_width.max(1) as f64 - 0.5)
        .clamp(0.0, width.saturating_sub(1) as f64);
    let gy = (canonical_y * height as f64 / canonical_height.max(1) as f64 - 0.5)
        .clamp(0.0, height.saturating_sub(1) as f64);
    let x0 = gx.floor() as usize;
    let y0 = gy.floor() as usize;
    let x1 = (x0 + 1).min(width - 1);
    let y1 = (y0 + 1).min(height - 1);
    let smooth = |value: f64| {
        let value = value.clamp(0.0, 1.0);
        (value * value * value * (value * (value * 6.0 - 15.0) + 10.0)) as f32
    };
    let tx = smooth(gx - x0 as f64);
    let ty = smooth(gy - y0 as f64);
    let v00 = field[y0 * width + x0];
    let v10 = field[y0 * width + x1];
    let v01 = field[y1 * width + x0];
    let v11 = field[y1 * width + x1];
    let top = v00 + (v10 - v00) * tx;
    let bottom = v01 + (v11 - v01) * tx;
    top + (bottom - top) * ty
}

fn sample_procedural_window(map: &NativeMap, window: Window, guide_enabled: bool) -> Vec<f32> {
    let surface = map.canonical_surface.as_ref().expect("validated surface");
    let settings = map.generation_settings.as_ref();
    let config = TerrainFieldConfig {
        seed: map.environment_seed,
        width_km: map.width,
        height_km: map.height,
        region_type: settings.map_or(crate::generator::RegionType::Coast, |value| {
            value.region_type
        }),
        maximum_elevation_m: settings
            .map_or(4_800.0, |value| value.maximum_elevation_m as f32)
            .max(map.sea_level + 50.0),
        elevation_span_m: settings
            .map_or(5_600.0, |value| value.elevation_span_m as f32)
            .clamp(0.0, 20_000.0),
        elevation_noise: settings
            .map_or(0.58, |value| value.elevation_noise_percent as f32 / 100.0)
            .clamp(0.0, 1.0),
    };
    let guide = guide_enabled
        .then_some(map.geologic_guide.as_ref())
        .flatten();
    let mut values = Vec::with_capacity(IMAGE_WIDTH * IMAGE_HEIGHT);
    for py in 0..IMAGE_HEIGHT {
        let canonical_y = window.top as f32
            + (py as f32 + 0.5) / IMAGE_HEIGHT as f32 * (window.bottom - window.top) as f32;
        for px in 0..IMAGE_WIDTH {
            let canonical_x = window.left as f32
                + (px as f32 + 0.5) / IMAGE_WIDTH as f32 * (window.right - window.left) as f32;
            let x_km = canonical_x / surface.width.max(1) as f32 * map.width;
            let y_km = canonical_y / surface.height.max(1) as f32 * map.height;
            values.push(sample_terrain_field(config, guide, x_km, y_km).elevation_m);
        }
    }
    values
}

fn finite_range(values: &[f32]) -> Option<(f32, f32)> {
    let mut minimum = f32::INFINITY;
    let mut maximum = f32::NEG_INFINITY;
    for &value in values {
        if value.is_finite() {
            minimum = minimum.min(value);
            maximum = maximum.max(value);
        }
    }
    if minimum.is_finite() && maximum.is_finite() {
        if (maximum - minimum).abs() < f32::EPSILON {
            Some((minimum - 1.0, maximum + 1.0))
        } else {
            Some((minimum, maximum))
        }
    } else {
        None
    }
}

fn write_heatmap(
    path: &Path,
    width: usize,
    height: usize,
    values: &[f32],
    range: (f32, f32),
) -> Result<(), String> {
    let mut pixels = vec![0_u8; width * height * 4];
    for (index, &value) in values.iter().enumerate().take(width * height) {
        let normalized =
            ((value - range.0) / (range.1 - range.0).max(f32::EPSILON)).clamp(0.0, 1.0);
        let color = elevation_color(normalized);
        pixels[index * 4..index * 4 + 4].copy_from_slice(&color);
    }
    write_png(path, width, height, &pixels)
}

fn elevation_color(value: f32) -> [u8; 4] {
    let stops = [
        (0.00, [23, 42, 87]),
        (0.20, [38, 104, 156]),
        (0.40, [73, 166, 156]),
        (0.50, [238, 235, 190]),
        (0.65, [191, 166, 92]),
        (0.82, [122, 91, 76]),
        (1.00, [246, 246, 246]),
    ];
    for pair in stops.windows(2) {
        if value <= pair[1].0 {
            let amount = ((value - pair[0].0) / (pair[1].0 - pair[0].0)).clamp(0.0, 1.0);
            return [
                (pair[0].1[0] as f32 + (pair[1].1[0] as f32 - pair[0].1[0] as f32) * amount).round()
                    as u8,
                (pair[0].1[1] as f32 + (pair[1].1[1] as f32 - pair[0].1[1] as f32) * amount).round()
                    as u8,
                (pair[0].1[2] as f32 + (pair[1].1[2] as f32 - pair[0].1[2] as f32) * amount).round()
                    as u8,
                255,
            ];
        }
    }
    [246, 246, 246, 255]
}

struct TopologyFields {
    width: usize,
    height: usize,
    planet_raw: Vec<f32>,
    analysis: Vec<f32>,
    canonical: Vec<f32>,
    canonical_procedural: Vec<f32>,
    plate_boundary: Vec<f32>,
    guide_boundary: Vec<f32>,
    planet_cell_boundary: Vec<f32>,
    analysis_grid: Vec<f32>,
}

fn export_topology_overlays(
    output: &Path,
    world: &LoadedWorld,
    map: &NativeMap,
    selection: &RegionSelection,
) -> Result<TopologyFields, String> {
    let aspect = map.width / map.height.max(0.1);
    let height = (TOPOLOGY_WIDTH as f32 / aspect).round().clamp(320.0, 800.0) as usize;
    let width = TOPOLOGY_WIDTH;
    let mut plate_ids = vec![0_usize; width * height];
    let mut guide_ids = vec![0_usize; width * height];
    let mut planet_cell_ids = vec![0_u64; width * height];
    let mut planet_raw = vec![0.0_f32; width * height];
    let mut analysis = vec![0.0_f32; width * height];
    let mut canonical = vec![0.0_f32; width * height];
    let mut canonical_procedural = vec![0.0_f32; width * height];
    let (center, _, _, bearing) = selection
        .metric_bounds()
        .ok_or_else(|| "The active map region does not expose a metric selection.".to_owned())?;
    let surface = map.canonical_surface.as_ref().expect("validated surface");
    let radius = world.planet.physical.radius_m.max(1.0);
    let planet_width = world.planet.surface.width.max(1);
    let planet_height = world.planet.surface.height.max(1);
    for y in 0..height {
        for x in 0..width {
            let index = y * width + x;
            let world_x = (x as f32 + 0.5) / width as f32 * map.width;
            let world_y = (y as f32 + 0.5) / height as f32 * map.height;
            let position = regional_metric_position_rotated(
                center,
                f64::from(world_x - map.width * 0.5) * 1_000.0,
                f64::from(map.height * 0.5 - world_y) * 1_000.0,
                bearing,
                radius,
            );
            plate_ids[index] = map.causal_geology.sample(position).plate_index;
            guide_ids[index] = nearest_guide_site(map, world_x, world_y);
            let (latitude, longitude) = position.latitude_longitude_rad();
            let px = (((longitude + std::f64::consts::PI) / std::f64::consts::TAU
                * f64::from(planet_width))
            .floor() as i64)
                .rem_euclid(i64::from(planet_width)) as u64;
            let py = (((std::f64::consts::FRAC_PI_2 - latitude) / std::f64::consts::PI
                * f64::from(planet_height))
            .floor() as i64)
                .clamp(0, i64::from(planet_height) - 1) as u64;
            planet_cell_ids[index] = py * u64::from(planet_width) + px;
            planet_raw[index] = world
                .planet
                .surface
                .sample_interpolated(position)
                .elevation_m;
            let canonical_x = (world_x / map.width.max(0.1) * surface.width as f32) as f64;
            let canonical_y = (world_y / map.height.max(0.1) * surface.height as f32) as f64;
            analysis[index] = sample_analysis_quintic(
                &map.elevation,
                map.grid_width,
                map.grid_height,
                canonical_x,
                canonical_y,
                surface.width,
                surface.height,
            );
            let sx = canonical_x
                .floor()
                .clamp(0.0, surface.width.saturating_sub(1) as f64) as usize;
            let sy = canonical_y
                .floor()
                .clamp(0.0, surface.height.saturating_sub(1) as f64) as usize;
            if let Some(sample) = surface.diagnostic_sample(sx, sy) {
                canonical[index] = sample.final_elevation_m;
                canonical_procedural[index] = sample.procedural_elevation_m;
            } else {
                canonical[index] = analysis[index];
                canonical_procedural[index] = analysis[index];
            }
        }
    }
    let plate_boundary = categorical_boundary(&plate_ids, width, height);
    let guide_boundary = categorical_boundary(&guide_ids, width, height);
    let planet_cell_boundary = categorical_boundary(&planet_cell_ids, width, height);
    let analysis_grid = rectangular_grid_mask(width, height, map.grid_width, map.grid_height);

    write_category_map(
        &output.join("topology-plate-ids-and-boundaries.png"),
        width,
        height,
        &plate_ids,
        &plate_boundary,
    )?;
    write_category_map(
        &output.join("topology-geologic-guide-cells.png"),
        width,
        height,
        &guide_ids,
        &guide_boundary,
    )?;
    let mut guide_edges = vec![18_u8; width * height * 4];
    for pixel in guide_edges.chunks_exact_mut(4) {
        pixel.copy_from_slice(&[15, 24, 36, 255]);
    }
    if let Some(guide) = &map.geologic_guide {
        for (index, site) in guide.sites.iter().enumerate() {
            for &neighbor in &site.neighbors {
                if usize::from(neighbor) <= index || usize::from(neighbor) >= guide.sites.len() {
                    continue;
                }
                let other = &guide.sites[usize::from(neighbor)];
                draw_line(
                    &mut guide_edges,
                    width,
                    height,
                    site.x_km / map.width.max(0.1) * width as f32,
                    site.y_km / map.height.max(0.1) * height as f32,
                    other.x_km / map.width.max(0.1) * width as f32,
                    other.y_km / map.height.max(0.1) * height as f32,
                    [76, 195, 236, 255],
                    2,
                );
            }
        }
    }
    write_png(
        &output.join("topology-geologic-guide-edges.png"),
        width,
        height,
        &guide_edges,
    )?;
    write_mask(
        &output.join("topology-planet-surface-cell-grid.png"),
        width,
        height,
        &planet_cell_boundary,
        [234, 186, 72, 255],
    )?;
    write_mask(
        &output.join("topology-regional-analysis-grid.png"),
        width,
        height,
        &analysis_grid,
        [244, 91, 150, 255],
    )?;
    fs::write(
        output.join("topology-simulation-triangles.txt"),
        "No simulation triangle mesh or barycentric interpolation exists in the traced PlanetSurface -> regional -> Canonical elevation path. Planet geology and guide topology are nearest-site/Voronoi-like; both elevation interpolation stages use rectangular raster cells.\n",
    )
    .map_err(|error| error.to_string())?;
    fs::write(
        output.join("topology-detail-lattice.txt"),
        "The broad/medium/fine detail fields are continuous spherical fBm domains at frequencies 96/384/1536. They do not expose a finite detail lattice. Their scalar contributions are exported as elevation stages 04/05/06.\n",
    )
    .map_err(|error| error.to_string())?;

    Ok(TopologyFields {
        width,
        height,
        planet_raw,
        analysis,
        canonical,
        canonical_procedural,
        plate_boundary,
        guide_boundary,
        planet_cell_boundary,
        analysis_grid,
    })
}

fn nearest_guide_site(map: &NativeMap, x: f32, y: f32) -> usize {
    map.geologic_guide
        .as_ref()
        .and_then(|guide| {
            guide
                .sites
                .iter()
                .enumerate()
                .min_by(|(_, left), (_, right)| {
                    (left.x_km - x)
                        .hypot(left.y_km - y)
                        .total_cmp(&(right.x_km - x).hypot(right.y_km - y))
                })
                .map(|(index, _)| index)
        })
        .unwrap_or(0)
}

fn categorical_boundary<T: PartialEq>(values: &[T], width: usize, height: usize) -> Vec<f32> {
    let mut output = vec![0.0; width * height];
    for y in 0..height {
        for x in 0..width {
            let index = y * width + x;
            if (x + 1 < width && values[index] != values[index + 1])
                || (y + 1 < height && values[index] != values[index + width])
            {
                output[index] = 1.0;
            }
        }
    }
    output
}

fn rectangular_grid_mask(width: usize, height: usize, cells_x: usize, cells_y: usize) -> Vec<f32> {
    let mut output = vec![0.0; width * height];
    for y in 0..height {
        for x in 0..width {
            let cell_x = x * cells_x.max(1) / width.max(1);
            let cell_y = y * cells_y.max(1) / height.max(1);
            let east = (x + 1).min(width - 1) * cells_x.max(1) / width.max(1);
            let south = (y + 1).min(height - 1) * cells_y.max(1) / height.max(1);
            if cell_x != east || cell_y != south {
                output[y * width + x] = 1.0;
            }
        }
    }
    output
}

fn write_category_map(
    path: &Path,
    width: usize,
    height: usize,
    categories: &[usize],
    boundary: &[f32],
) -> Result<(), String> {
    let mut pixels = vec![0_u8; width * height * 4];
    for index in 0..width * height {
        let id = categories[index] as u64;
        let color = if boundary[index] > 0.0 {
            [252, 252, 252, 255]
        } else {
            [
                44 + ((id.wrapping_mul(73) + 31) % 150) as u8,
                44 + ((id.wrapping_mul(109) + 79) % 150) as u8,
                44 + ((id.wrapping_mul(151) + 17) % 150) as u8,
                255,
            ]
        };
        pixels[index * 4..index * 4 + 4].copy_from_slice(&color);
    }
    write_png(path, width, height, &pixels)
}

fn export_edge_and_correlation_metrics(
    output: &Path,
    map: &NativeMap,
    lineage: &AnalysisLineage,
    topology: &TopologyFields,
) -> Result<String, String> {
    let raw_edges = gradient_magnitude(&topology.planet_raw, topology.width, topology.height);
    let analysis_edges = gradient_magnitude(&topology.analysis, topology.width, topology.height);
    let canonical_edges = gradient_magnitude(&topology.canonical, topology.width, topology.height);
    let procedural_edges = gradient_magnitude(
        &topology.canonical_procedural,
        topology.width,
        topology.height,
    );
    let fields = [
        ("planet_raw", topology.planet_raw.as_slice()),
        ("regional_analysis", topology.analysis.as_slice()),
        ("canonical_final", topology.canonical.as_slice()),
        (
            "canonical_procedural",
            topology.canonical_procedural.as_slice(),
        ),
        ("plate_boundary", topology.plate_boundary.as_slice()),
        ("guide_boundary", topology.guide_boundary.as_slice()),
        (
            "planet_cell_boundary",
            topology.planet_cell_boundary.as_slice(),
        ),
        ("analysis_grid", topology.analysis_grid.as_slice()),
    ];
    let mut histograms = BTreeMap::new();
    for (name, field) in fields {
        histograms.insert(
            name,
            orientation_histogram(field, topology.width, topology.height),
        );
    }
    let mut histogram_csv = String::from("source,bin_start_deg,normalized_weight\n");
    for (name, histogram) in &histograms {
        for (bin, value) in histogram.iter().enumerate() {
            histogram_csv.push_str(&format!(
                "{name},{:.1},{value:.9}\n",
                bin as f64 * 180.0 / ORIENTATION_BINS as f64
            ));
        }
    }
    fs::write(
        output.join("edge-orientation-histograms.csv"),
        histogram_csv,
    )
    .map_err(|error| error.to_string())?;

    let mut overlap_csv =
        String::from("elevation_source,topology_source,orientation_cosine,strong_edge_overlap\n");
    let elevation_sources = [
        ("planet_raw", raw_edges.as_slice()),
        ("regional_analysis", analysis_edges.as_slice()),
        ("canonical_final", canonical_edges.as_slice()),
        ("canonical_procedural", procedural_edges.as_slice()),
    ];
    let topology_sources = [
        ("plate_boundary", topology.plate_boundary.as_slice()),
        ("guide_boundary", topology.guide_boundary.as_slice()),
        (
            "planet_cell_boundary",
            topology.planet_cell_boundary.as_slice(),
        ),
        ("analysis_grid", topology.analysis_grid.as_slice()),
    ];
    let mut report = String::new();
    for (elevation_name, edges) in elevation_sources {
        let elevation_histogram = &histograms[elevation_name];
        for (topology_name, mask) in topology_sources {
            let cosine = cosine_similarity(elevation_histogram, &histograms[topology_name]);
            let overlap = strong_edge_overlap(edges, mask);
            overlap_csv.push_str(&format!(
                "{elevation_name},{topology_name},{cosine:.9},{overlap:.9}\n"
            ));
            report.push_str(&format!(
                "{elevation_name} vs {topology_name}: orientation_cosine={cosine:.6}, strong_edge_overlap={overlap:.6}\n"
            ));
        }
    }
    fs::write(output.join("edge-topology-correlation.csv"), overlap_csv)
        .map_err(|error| error.to_string())?;

    let analysis_procedural = pearson(&map.elevation, &lineage_to_analysis_procedural(map)?);
    let analysis_low = box_blur(&map.elevation, map.grid_width, map.grid_height, 4);
    let procedural_values = lineage_to_analysis_procedural(map)?;
    let procedural_low = box_blur(&procedural_values, map.grid_width, map.grid_height, 4);
    let low_frequency = pearson(&analysis_low, &procedural_low);
    let replay_error = max_abs_difference(
        &lineage.replay.final_analysis_elevation,
        &lineage.replay.post_erosion_elevation,
    );
    let regional_sampling_error = max_abs_difference(&lineage.regional_sample, &lineage.combined);
    let correlation_csv = format!(
        "metric,value\nanalysis_vs_procedural,{analysis_procedural:.9}\nanalysis_vs_procedural_low_frequency,{low_frequency:.9}\nreplay_final_vs_reconstructed_post_erosion_max_abs_m,{replay_error:.9}\nregional_sample_vs_component_sum_max_abs_m,{regional_sampling_error:.9}\n"
    );
    fs::write(
        output.join("procedural-analysis-correlation.csv"),
        correlation_csv,
    )
    .map_err(|error| error.to_string())?;
    report.push_str(&format!(
        "\nanalysis vs Canonical procedural Pearson={analysis_procedural:.6}\nanalysis vs Canonical procedural low-frequency Pearson={low_frequency:.6}\nreplay final-vs-post-erosion max_abs={replay_error:.6} m\nregional sampled-vs-components max_abs={regional_sampling_error:.6} m\n"
    ));
    Ok(report)
}

fn lineage_to_analysis_procedural(map: &NativeMap) -> Result<Vec<f32>, String> {
    let surface = map
        .canonical_surface
        .as_ref()
        .ok_or_else(|| "CanonicalSurface unavailable".to_owned())?;
    let mut values = Vec::with_capacity(map.grid_width * map.grid_height);
    for y in 0..map.grid_height {
        for x in 0..map.grid_width {
            let canonical_x =
                ((x as f64 + 0.5) / map.grid_width.max(1) as f64 * surface.width as f64)
                    .floor()
                    .clamp(0.0, surface.width.saturating_sub(1) as f64) as usize;
            let canonical_y =
                ((y as f64 + 0.5) / map.grid_height.max(1) as f64 * surface.height as f64)
                    .floor()
                    .clamp(0.0, surface.height.saturating_sub(1) as f64) as usize;
            values.push(
                surface
                    .diagnostic_sample(canonical_x, canonical_y)
                    .map_or(0.0, |sample| sample.procedural_elevation_m),
            );
        }
    }
    Ok(values)
}

fn gradient_magnitude(values: &[f32], width: usize, height: usize) -> Vec<f32> {
    let mut output = vec![0.0; width * height];
    for y in 1..height.saturating_sub(1) {
        for x in 1..width.saturating_sub(1) {
            let gx = values[y * width + x + 1] - values[y * width + x - 1];
            let gy = values[(y + 1) * width + x] - values[(y - 1) * width + x];
            output[y * width + x] = gx.hypot(gy);
        }
    }
    output
}

fn orientation_histogram(values: &[f32], width: usize, height: usize) -> [f64; ORIENTATION_BINS] {
    let mut output = [0.0; ORIENTATION_BINS];
    for y in 1..height.saturating_sub(1) {
        for x in 1..width.saturating_sub(1) {
            let gx = f64::from(values[y * width + x + 1] - values[y * width + x - 1]);
            let gy = f64::from(values[(y + 1) * width + x] - values[(y - 1) * width + x]);
            let magnitude = gx.hypot(gy);
            if magnitude <= f64::EPSILON {
                continue;
            }
            let angle = gy.atan2(gx).to_degrees().rem_euclid(180.0);
            let bin = ((angle / 180.0 * ORIENTATION_BINS as f64).floor() as usize)
                .min(ORIENTATION_BINS - 1);
            output[bin] += magnitude;
        }
    }
    let total = output.iter().sum::<f64>();
    if total > 0.0 {
        for value in &mut output {
            *value /= total;
        }
    }
    output
}

fn cosine_similarity(left: &[f64], right: &[f64]) -> f64 {
    let dot = left.iter().zip(right).map(|(a, b)| a * b).sum::<f64>();
    let left_length = left.iter().map(|value| value * value).sum::<f64>().sqrt();
    let right_length = right.iter().map(|value| value * value).sum::<f64>().sqrt();
    dot / (left_length * right_length).max(f64::EPSILON)
}

fn strong_edge_overlap(edges: &[f32], topology: &[f32]) -> f64 {
    let mut finite = edges
        .iter()
        .copied()
        .filter(|value| value.is_finite())
        .collect::<Vec<_>>();
    if finite.is_empty() {
        return 0.0;
    }
    finite.sort_by(f32::total_cmp);
    let threshold = finite[((finite.len() as f32 * 0.90) as usize).min(finite.len() - 1)];
    let mut strong = 0_usize;
    let mut overlap = 0_usize;
    for (&edge, &mask) in edges.iter().zip(topology) {
        if edge >= threshold {
            strong += 1;
            if mask > 0.0 {
                overlap += 1;
            }
        }
    }
    overlap as f64 / strong.max(1) as f64
}

fn pearson(left: &[f32], right: &[f32]) -> f64 {
    let count = left.len().min(right.len());
    if count == 0 {
        return 0.0;
    }
    let left_mean = left
        .iter()
        .take(count)
        .map(|value| f64::from(*value))
        .sum::<f64>()
        / count as f64;
    let right_mean = right
        .iter()
        .take(count)
        .map(|value| f64::from(*value))
        .sum::<f64>()
        / count as f64;
    let mut numerator = 0.0;
    let mut left_sum = 0.0;
    let mut right_sum = 0.0;
    for index in 0..count {
        let a = f64::from(left[index]) - left_mean;
        let b = f64::from(right[index]) - right_mean;
        numerator += a * b;
        left_sum += a * a;
        right_sum += b * b;
    }
    numerator / (left_sum * right_sum).sqrt().max(f64::EPSILON)
}

fn box_blur(values: &[f32], width: usize, height: usize, radius: usize) -> Vec<f32> {
    let mut output = vec![0.0; values.len()];
    for y in 0..height {
        for x in 0..width {
            let mut sum = 0.0;
            let mut count = 0_usize;
            for sy in y.saturating_sub(radius)..=(y + radius).min(height - 1) {
                for sx in x.saturating_sub(radius)..=(x + radius).min(width - 1) {
                    sum += values[sy * width + sx];
                    count += 1;
                }
            }
            output[y * width + x] = sum / count.max(1) as f32;
        }
    }
    output
}

fn max_abs_difference(left: &[f32], right: &[f32]) -> f32 {
    left.iter()
        .zip(right)
        .map(|(a, b)| (a - b).abs())
        .fold(0.0, f32::max)
}

fn select_diagnostic_rivers(map: &NativeMap, maximum: usize) -> Vec<RiverManifest> {
    let Some(surface) = map.canonical_surface.as_ref() else {
        return Vec::new();
    };
    let mut candidates = map
        .river_graph
        .reaches
        .iter()
        .filter_map(|reach| {
            let first = *reach.centerline.first()?;
            let last = *reach.centerline.last()?;
            let total = polyline_length(&reach.centerline);
            let chord = point_distance(first, last);
            if total <= 0.0 {
                return None;
            }
            let straightness = chord / total;
            let angle = f64::from(last.y - first.y)
                .atan2(f64::from(last.x - first.x))
                .to_degrees()
                .rem_euclid(180.0);
            let axis_distance = [0.0_f64, 45.0, 90.0, 135.0]
                .into_iter()
                .map(|axis| (angle - axis).abs().min(180.0 - (angle - axis).abs()))
                .fold(f64::INFINITY, f64::min);
            let score =
                total * straightness.powi(3) * (1.0 + (22.5 - axis_distance).max(0.0) / 22.5);
            let midpoint = reach.centerline[reach.centerline.len() / 2];
            Some((score, reach, total, chord, straightness, angle, midpoint))
        })
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| right.0.total_cmp(&left.0));
    candidates
        .into_iter()
        .take(maximum)
        .map(
            |(_, reach, total, chord, straightness, angle, midpoint)| RiverManifest {
                river_id: reach.id.clone(),
                screen_px: [
                    midpoint.x / map.width.max(0.1) * TOPOLOGY_WIDTH as f32,
                    midpoint.y / map.height.max(0.1)
                        * (TOPOLOGY_WIDTH as f32 * map.height / map.width.max(0.1)),
                ],
                world_km: [midpoint.x, midpoint.y],
                canonical: [
                    (midpoint.x / map.width.max(0.1) * surface.width as f32)
                        .round()
                        .clamp(0.0, surface.width.saturating_sub(1) as f32)
                        as usize,
                    (midpoint.y / map.height.max(0.1) * surface.height as f32)
                        .round()
                        .clamp(0.0, surface.height.saturating_sub(1) as f32)
                        as usize,
                ],
                total_length_km: total,
                chord_length_km: chord,
                straightness,
                dominant_direction_deg: angle,
            },
        )
        .collect()
}

fn export_river_lineage(
    output: &Path,
    map: &NativeMap,
    replay: &PipelineDiagnosticReplay,
    rivers: &[RiverManifest],
) -> Result<(), String> {
    let mut selected_csv = String::from(
        "river_id,screen_x,screen_y,world_x_km,world_y_km,canonical_x,canonical_y,total_length_km,chord_length_km,straightness,dominant_direction_deg\n",
    );
    let mut stage_csv =
        String::from("river_id,stage,longest_single_segment_km,direction_deg,geometry_note\n");
    for river in rivers {
        selected_csv.push_str(&format!(
            "{},{:.3},{:.3},{:.6},{:.6},{},{},{:.6},{:.6},{:.9},{:.6}\n",
            river.river_id,
            river.screen_px[0],
            river.screen_px[1],
            river.world_km[0],
            river.world_km[1],
            river.canonical[0],
            river.canonical[1],
            river.total_length_km,
            river.chord_length_km,
            river.straightness,
            river.dominant_direction_deg,
        ));
        let reach = map
            .river_graph
            .reaches
            .iter()
            .find(|reach| reach.id == river.river_id)
            .ok_or_else(|| format!("diagnostic river {} disappeared", river.river_id))?;
        let view = river_view(map, &reach.centerline);
        let stages = river_stage_segments(map, replay, reach, view);
        for (index, (name, segments, note)) in stages.iter().enumerate() {
            let image = river_stage_image(map, replay, view, name, segments);
            write_png(
                &output.join(format!(
                    "river-{}-{}-{}.png",
                    sanitize(&river.river_id),
                    (b'A' + index as u8) as char,
                    name
                )),
                IMAGE_WIDTH,
                IMAGE_HEIGHT,
                &image,
            )?;
            let (length, direction) = longest_segment(segments);
            stage_csv.push_str(&format!(
                "{},{name},{length:.6},{direction:.6},{note}\n",
                river.river_id
            ));
        }
    }
    fs::write(output.join("river-selected.csv"), selected_csv)
        .map_err(|error| error.to_string())?;
    fs::write(output.join("river-stage-first-straight.csv"), stage_csv)
        .map_err(|error| error.to_string())?;
    fs::write(
        output.join("river-direction-histogram.csv"),
        river_direction_histogram(map),
    )
    .map_err(|error| error.to_string())?;
    fs::write(
        output.join("river-port-and-render-audit.txt"),
        "RegionRiverPort: no corresponding type or generation stage is present in the traced pipeline. Rivers are generated wholly inside NativeMap; border terminals are classification metadata only.\n\nRegion clipping: no river geometry clipping stage is present between RiverGraph and rendering.\n\nRender simplification: MapRenderCache::build_river_mesh consumes every stored RiverSegment. LOD/quantized river scale changes width, not centerline geometry. Therefore raw graph, LOD0, LOD1, and LOD2 centerlines are identical.\n",
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

#[derive(Clone, Copy)]
struct WorldView {
    left: f32,
    top: f32,
    right: f32,
    bottom: f32,
}

fn river_view(map: &NativeMap, points: &[Point]) -> WorldView {
    let mut left = f32::INFINITY;
    let mut top = f32::INFINITY;
    let mut right = f32::NEG_INFINITY;
    let mut bottom = f32::NEG_INFINITY;
    for point in points {
        left = left.min(point.x);
        top = top.min(point.y);
        right = right.max(point.x);
        bottom = bottom.max(point.y);
    }
    let width = (right - left).max(map.width * 0.025);
    let height = (bottom - top).max(map.height * 0.025);
    let padding = width.max(height) * 0.45;
    WorldView {
        left: (left - padding).max(0.0),
        top: (top - padding).max(0.0),
        right: (right + padding).min(map.width),
        bottom: (bottom + padding).min(map.height),
    }
}

type NamedSegments = (&'static str, Vec<(Point, Point)>, &'static str);

fn river_stage_segments(
    map: &NativeMap,
    replay: &PipelineDiagnosticReplay,
    reach: &crate::river_graph::RiverReach,
    view: WorldView,
) -> Vec<NamedSegments> {
    let within = |start: Point, end: Point| segment_intersects_view(start, end, view);
    let filter_pairs = |pairs: &[(Point, Point)]| {
        pairs
            .iter()
            .copied()
            .filter(|(start, end)| within(*start, *end))
            .collect::<Vec<_>>()
    };
    let filter_rivers = |segments: &[RiverSegment]| {
        segments
            .iter()
            .filter(|segment| within(segment.start, segment.end))
            .map(|segment| (segment.start, segment.end))
            .collect::<Vec<_>>()
    };
    let reach_segments = reach
        .centerline
        .windows(2)
        .map(|pair| (pair[0], pair[1]))
        .collect::<Vec<_>>();
    let flow_segments = replay
        .flow_targets
        .iter()
        .filter_map(|target| {
            let start = analysis_center(replay, target.from, map);
            let end = analysis_center(replay, target.to, map);
            within(start, end).then_some((start, end))
        })
        .collect::<Vec<_>>();
    let replay_graph = filter_rivers(&replay.graph_segments);
    let final_geometry = filter_rivers(&replay.final_segments);
    vec![
        (
            "raw-flow-direction",
            flow_segments,
            "D-infinity targets; two targets may exist before channelization",
        ),
        (
            "flow-accumulation",
            Vec::new(),
            "scalar accumulation raster; geometry column intentionally empty",
        ),
        (
            "channel-cells",
            filter_pairs(&replay.channel_cell_segments),
            "primary downstream links between analysis-cell centres",
        ),
        (
            "raw-river-graph",
            replay_graph.clone(),
            "RiverGraph stores the spline output without geometric simplification",
        ),
        (
            "post-confluence-graph",
            replay_graph,
            "confluence grouping changes reach ownership, not centerline coordinates",
        ),
        (
            "subcell-centreline",
            filter_pairs(&replay.subcell_segments),
            "72/14/14 node smoothing before Catmull-Rom",
        ),
        (
            "catmull-rom",
            filter_rivers(&replay.spline_segments),
            "Catmull-Rom result with linear fallback for rejected samples",
        ),
        (
            "region-clip",
            reach_segments.clone(),
            "no region clipping stage exists; identical to graph geometry",
        ),
        (
            "render-simplification",
            reach_segments.clone(),
            "no RDP or screen-space centerline simplification exists",
        ),
        (
            "final-screen-polyline",
            if final_geometry.is_empty() {
                reach_segments
            } else {
                final_geometry
            },
            "renderer consumes every stored centerline segment",
        ),
    ]
}

fn analysis_center(replay: &PipelineDiagnosticReplay, index: usize, map: &NativeMap) -> Point {
    Point {
        x: (index % replay.width) as f32 / replay.width.max(1) as f32 * map.width
            + map.width / replay.width.max(1) as f32 * 0.5,
        y: (index / replay.width) as f32 / replay.height.max(1) as f32 * map.height
            + map.height / replay.height.max(1) as f32 * 0.5,
    }
}

fn segment_intersects_view(start: Point, end: Point, view: WorldView) -> bool {
    let left = start.x.min(end.x);
    let right = start.x.max(end.x);
    let top = start.y.min(end.y);
    let bottom = start.y.max(end.y);
    right >= view.left && left <= view.right && bottom >= view.top && top <= view.bottom
}

fn river_stage_image(
    map: &NativeMap,
    replay: &PipelineDiagnosticReplay,
    view: WorldView,
    name: &str,
    segments: &[(Point, Point)],
) -> Vec<u8> {
    let mut pixels = vec![0_u8; IMAGE_WIDTH * IMAGE_HEIGHT * 4];
    for pixel in pixels.chunks_exact_mut(4) {
        pixel.copy_from_slice(&[12, 21, 31, 255]);
    }
    if name == "flow-accumulation" {
        let maximum = replay
            .flow_accumulation
            .iter()
            .copied()
            .fold(0.0_f64, f64::max)
            .ln_1p()
            .max(f64::EPSILON);
        for (index, &flow) in replay.flow_accumulation.iter().enumerate() {
            let point = analysis_center(replay, index, map);
            if point.x < view.left
                || point.x > view.right
                || point.y < view.top
                || point.y > view.bottom
            {
                continue;
            }
            let (x, y) = view_to_pixel(view, point);
            let amount = (flow.ln_1p() / maximum).clamp(0.0, 1.0) as f32;
            draw_disc(
                &mut pixels,
                IMAGE_WIDTH,
                IMAGE_HEIGHT,
                x.round() as i32,
                y.round() as i32,
                2,
                [
                    (30.0 + amount * 220.0) as u8,
                    (70.0 + amount * 150.0) as u8,
                    (120.0 + amount * 100.0) as u8,
                    255,
                ],
            );
        }
    }
    for &(start, end) in segments {
        let (start_x, start_y) = view_to_pixel(view, start);
        let (end_x, end_y) = view_to_pixel(view, end);
        draw_line(
            &mut pixels,
            IMAGE_WIDTH,
            IMAGE_HEIGHT,
            start_x,
            start_y,
            end_x,
            end_y,
            [66, 198, 255, 255],
            2,
        );
    }
    pixels
}

fn view_to_pixel(view: WorldView, point: Point) -> (f32, f32) {
    (
        (point.x - view.left) / (view.right - view.left).max(0.001) * IMAGE_WIDTH as f32,
        (point.y - view.top) / (view.bottom - view.top).max(0.001) * IMAGE_HEIGHT as f32,
    )
}

fn longest_segment(segments: &[(Point, Point)]) -> (f64, f64) {
    segments
        .iter()
        .map(|(start, end)| {
            (
                point_distance(*start, *end),
                f64::from(end.y - start.y)
                    .atan2(f64::from(end.x - start.x))
                    .to_degrees()
                    .rem_euclid(180.0),
            )
        })
        .max_by(|left, right| left.0.total_cmp(&right.0))
        .unwrap_or((0.0, 0.0))
}

fn river_direction_histogram(map: &NativeMap) -> String {
    let mut bins = [0.0_f64; 4];
    let axes = [0.0_f64, 45.0, 90.0, 135.0];
    let segments = if map.rivers.is_empty() {
        map.river_graph.to_segments()
    } else {
        map.rivers.clone()
    };
    let mut total = 0.0;
    for segment in segments {
        let length = point_distance(segment.start, segment.end);
        if length <= 0.0 {
            continue;
        }
        let angle = f64::from(segment.end.y - segment.start.y)
            .atan2(f64::from(segment.end.x - segment.start.x))
            .to_degrees()
            .rem_euclid(180.0);
        let (index, _) = axes
            .iter()
            .enumerate()
            .map(|(index, axis)| {
                let difference = (angle - axis).abs();
                (index, difference.min(180.0 - difference))
            })
            .min_by(|left, right| left.1.total_cmp(&right.1))
            .unwrap();
        bins[index] += length;
        total += length;
    }
    let mut output = String::from("direction_deg,length_km,fraction\n");
    for (index, axis) in axes.iter().enumerate() {
        output.push_str(&format!(
            "{axis:.0},{:.6},{:.9}\n",
            bins[index],
            bins[index] / total.max(f64::EPSILON)
        ));
    }
    output
}

fn polyline_length(points: &[Point]) -> f64 {
    points
        .windows(2)
        .map(|pair| point_distance(pair[0], pair[1]))
        .sum()
}

fn point_distance(left: Point, right: Point) -> f64 {
    f64::from((right.x - left.x).hypot(right.y - left.y))
}

fn sanitize(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '-'
            }
        })
        .collect()
}

fn interpolation_audit(map: &NativeMap, lineage: &AnalysisLineage) -> String {
    format!(
        "URDR 4.4 pass 5 interpolation audit\n\n\
PlanetSurface -> regional sample\n\
- PlanetSurface::sample_interpolated resolves four equirectangular raster cells and applies bilinear interpolation.\n\
- PlanetState::sample_detail_at_resolution adds continuous spherical fBm at broad/medium/fine frequencies.\n\
- No nearest-only, barycentric, triangle-face, or planar triangle interpolation is used.\n\n\
Regional analysis -> Canonical\n\
- canonical_continuous_fields calls sample_analysis_field.\n\
- sample_analysis_field resolves four rectangular analysis cells and applies a tensor-product quintic smoothstep interpolation.\n\
- No triangle mesh or barycentric interpolation is used.\n\n\
Canonical composition\n\
- analysis contribution = 84%\n\
- procedural contribution = 16%\n\
- causal geology bias is added afterward and clamped to [-1800, 2500] m after a 0.24 multiplier.\n\n\
Diagnostic replay\n\
- analysis dimensions: {}x{}\n\
- eroded cells: {}\n\
- lake outlet routes: {}\n\
- stored final vs replayed post-erosion max absolute difference: {:.6} m\n",
        lineage.width,
        lineage.height,
        lineage.replay.eroded_cells,
        lineage.replay.lake_outlet_count,
        max_abs_difference(&map.elevation, &lineage.replay.post_erosion_elevation),
    )
}

fn package_readme(map: &NativeMap, lineage: &AnalysisLineage, rivers: &[RiverManifest]) -> String {
    let mean_route_weight = lineage
        .replay
        .flow_targets
        .iter()
        .map(|target| target.weight)
        .sum::<f64>()
        / lineage.replay.flow_targets.len().max(1) as f64;
    let routed_cells = lineage
        .replay
        .downstream
        .iter()
        .filter(|target| target.is_some())
        .count();
    let channel_cells = lineage
        .replay
        .channels
        .iter()
        .filter(|value| **value)
        .count();
    format!(
        "URDR 4.4 pass 5 pipeline lineage diagnostics\n\n\
This package changes no generation, hydrology, geology, Canonical blend, LOD, cache, worker, or renderer parameter.\n\n\
Elevation\n\
- A/B/C each contain 15 stages in independent and shared absolute normalization.\n\
- topology-*.png provides plate, guide, PlanetSurface cell, and analysis-grid overlays.\n\
- edge-orientation-histograms.csv and edge-topology-correlation.csv quantify alignment.\n\
- procedural-analysis-correlation.csv separates full-band and low-frequency correlation.\n\n\
River\n\
- {} long/straight reaches were selected from the authoritative RiverGraph.\n\
- Each river has A-J exports for routing through final display geometry.\n\
- There is no RegionRiverPort geometry stage, no region clipping stage, and no centerline RDP/screen-space simplification in the traced code.\n\n\
Exact call graph\n\
Elevation: PlanetSurface::sample_interpolated -> PlanetState::sample_detail_at_resolution -> RegionalCellBase.elevation_m -> build_lake_outlet_routes -> priority_flood -> apply_stream_power_erosion -> NativeMap.elevation -> CanonicalSurface::rebuild -> canonical_continuous_fields -> sample_analysis_field(84%) + sample_terrain_field(16%) + CausalGeologyModel::sample bias.\n\n\
River: priority_flood -> build_d_infinity_routing -> accumulate_weighted_flow -> primary_downstream -> initiate_channels -> channelize_routing -> apply_stream_power_erosion -> reroute -> build_rivers(72/14/14 subcell nodes -> Catmull-Rom or linear fallback) -> RiverGraph::from_segments -> RiverGraph::to_segments -> MapRenderCache::build_river_mesh.\n\n\
Map: {} / seed {} / analysis {}x{}\n\
Replay routing: {} routed cells / {} channel cells / mean target weight {:.6}\n",
        rivers.len(),
        map.source_id,
        map.environment_seed,
        lineage.width,
        lineage.height,
        routed_cells,
        channel_cells,
        mean_route_weight,
    )
}

fn draw_line(
    pixels: &mut [u8],
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
        draw_disc(
            pixels,
            width,
            height,
            (start_x + dx * amount).round() as i32,
            (start_y + dy * amount).round() as i32,
            thickness.max(1) / 2,
            color,
        );
    }
}

fn draw_disc(
    pixels: &mut [u8],
    width: usize,
    height: usize,
    center_x: i32,
    center_y: i32,
    radius: i32,
    color: [u8; 4],
) {
    for y in center_y - radius..=center_y + radius {
        for x in center_x - radius..=center_x + radius {
            if x < 0 || y < 0 || x >= width as i32 || y >= height as i32 {
                continue;
            }
            if (x - center_x).pow(2) + (y - center_y).pow(2) > radius.pow(2) {
                continue;
            }
            let index = (y as usize * width + x as usize) * 4;
            pixels[index..index + 4].copy_from_slice(&color);
        }
    }
}

fn write_png(path: &Path, width: usize, height: usize, pixels: &[u8]) -> Result<(), String> {
    let file = File::create(path).map_err(|error| error.to_string())?;
    let mut encoder = png::Encoder::new(BufWriter::new(file), width as u32, height as u32);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder.write_header().map_err(|error| error.to_string())?;
    writer
        .write_image_data(pixels)
        .map_err(|error| error.to_string())
}

const PASS_6_PROBE_WIDTH: usize = 320;
const PASS_6_PROBE_HEIGHT: usize = 240;
const PASS_6_BROAD_WIDTH: usize = 400;
const PASS_6_BROAD_HEIGHT: usize = 250;

#[derive(Clone, Copy)]
enum Pass6CanonicalField {
    Parent,
    Procedural,
    Final,
}

pub(crate) fn export_pass_6_terrain(world: &LoadedWorld) -> Result<PathBuf, String> {
    let output = crate::diagnostics::create_debug_package("map-pass-6-terrain")?;
    let before = pass_6_revision_map(&world.map, 1, 1)?;
    let after = pass_6_revision_map(&world.map, 2, 2)?;
    let before_surface = before
        .canonical_surface
        .as_ref()
        .ok_or_else(|| "legacy diagnostic surface is unavailable".to_owned())?;
    let after_surface = after
        .canonical_surface
        .as_ref()
        .ok_or_else(|| "revision 2 diagnostic surface is unavailable".to_owned())?;

    let mut ablation_csv = String::from(
        "probe,term,legacy_rms_m,continuous_rms_m,legacy_max_gradient_m,continuous_max_gradient_m\n",
    );
    for &(id, x, y) in &PROBE_POINTS {
        let window = probe_window(
            &after,
            x.min(after_surface.width.saturating_sub(1) as usize),
            y.min(after_surface.height.saturating_sub(1) as usize),
        );
        let before_final = sample_pass_6_canonical_window(
            before_surface,
            window,
            PASS_6_PROBE_WIDTH,
            PASS_6_PROBE_HEIGHT,
            Pass6CanonicalField::Final,
        )?;
        let after_final = sample_pass_6_canonical_window(
            after_surface,
            window,
            PASS_6_PROBE_WIDTH,
            PASS_6_PROBE_HEIGHT,
            Pass6CanonicalField::Final,
        )?;
        let merged = merged_range(&before_final, &after_final).unwrap_or((-1.0, 1.0));
        write_heatmap(
            &output.join(format!("probe-{id}-before-final.png")),
            PASS_6_PROBE_WIDTH,
            PASS_6_PROBE_HEIGHT,
            &before_final,
            merged,
        )?;
        write_heatmap(
            &output.join(format!("probe-{id}-after-final.png")),
            PASS_6_PROBE_WIDTH,
            PASS_6_PROBE_HEIGHT,
            &after_final,
            merged,
        )?;
        let final_delta = difference(&after_final, &before_final);
        write_symmetric_heatmap(
            &output.join(format!("probe-{id}-final-delta.png")),
            PASS_6_PROBE_WIDTH,
            PASS_6_PROBE_HEIGHT,
            &final_delta,
        )?;

        let before_procedural = sample_pass_6_canonical_window(
            before_surface,
            window,
            PASS_6_PROBE_WIDTH,
            PASS_6_PROBE_HEIGHT,
            Pass6CanonicalField::Procedural,
        )?;
        let after_residual = sample_pass_6_canonical_window(
            after_surface,
            window,
            PASS_6_PROBE_WIDTH,
            PASS_6_PROBE_HEIGHT,
            Pass6CanonicalField::Procedural,
        )?;
        write_heatmap(
            &output.join(format!("probe-{id}-before-procedural-full.png")),
            PASS_6_PROBE_WIDTH,
            PASS_6_PROBE_HEIGHT,
            &before_procedural,
            finite_range(&before_procedural).unwrap_or((-1.0, 1.0)),
        )?;
        write_symmetric_heatmap(
            &output.join(format!("probe-{id}-after-residual.png")),
            PASS_6_PROBE_WIDTH,
            PASS_6_PROBE_HEIGHT,
            &after_residual,
        )?;

        let terms = [
            (
                "motion",
                GeologyTermMask::MOTION_ONLY,
                GeologyTermMask::NONE,
            ),
            (
                "resistance-age",
                GeologyTermMask::ALL,
                GeologyTermMask {
                    motion: true,
                    resistance_age: false,
                    hotspot: true,
                },
            ),
            (
                "hotspot",
                GeologyTermMask::HOTSPOT_ONLY,
                GeologyTermMask::NONE,
            ),
            ("all", GeologyTermMask::ALL, GeologyTermMask::NONE),
        ];
        for (term_name, enabled_terms, baseline_terms) in terms {
            let legacy = sample_pass_6_ablation_window(
                &before,
                window,
                PASS_6_PROBE_WIDTH,
                PASS_6_PROBE_HEIGHT,
                1,
                enabled_terms,
            )?;
            let continuous = sample_pass_6_ablation_window(
                &after,
                window,
                PASS_6_PROBE_WIDTH,
                PASS_6_PROBE_HEIGHT,
                2,
                enabled_terms,
            )?;
            let legacy_none = sample_pass_6_ablation_window(
                &before,
                window,
                PASS_6_PROBE_WIDTH,
                PASS_6_PROBE_HEIGHT,
                1,
                baseline_terms,
            )?;
            let continuous_none = sample_pass_6_ablation_window(
                &after,
                window,
                PASS_6_PROBE_WIDTH,
                PASS_6_PROBE_HEIGHT,
                2,
                baseline_terms,
            )?;
            let legacy_contribution = difference(&legacy, &legacy_none);
            let continuous_contribution = difference(&continuous, &continuous_none);
            write_symmetric_heatmap(
                &output.join(format!("probe-{id}-{term_name}-before-contribution.png")),
                PASS_6_PROBE_WIDTH,
                PASS_6_PROBE_HEIGHT,
                &legacy_contribution,
            )?;
            write_symmetric_heatmap(
                &output.join(format!("probe-{id}-{term_name}-after-contribution.png")),
                PASS_6_PROBE_WIDTH,
                PASS_6_PROBE_HEIGHT,
                &continuous_contribution,
            )?;
            ablation_csv.push_str(&format!(
                "{id},{term_name},{:.6},{:.6},{:.6},{:.6}\n",
                rms(&legacy_contribution),
                rms(&continuous_contribution),
                max_neighbor_delta(
                    &legacy_contribution,
                    PASS_6_PROBE_WIDTH,
                    PASS_6_PROBE_HEIGHT
                ),
                max_neighbor_delta(
                    &continuous_contribution,
                    PASS_6_PROBE_WIDTH,
                    PASS_6_PROBE_HEIGHT
                ),
            ));
        }
    }
    fs::write(output.join("guide-subterm-ablation.csv"), ablation_csv)
        .map_err(|error| error.to_string())?;

    let full_window = Window {
        left: 0,
        top: 0,
        right: after_surface.width as usize,
        bottom: after_surface.height as usize,
    };
    let broad_parent = sample_pass_6_canonical_window(
        after_surface,
        full_window,
        PASS_6_BROAD_WIDTH,
        PASS_6_BROAD_HEIGHT,
        Pass6CanonicalField::Parent,
    )?;
    let broad_before_procedural = sample_pass_6_canonical_window(
        before_surface,
        full_window,
        PASS_6_BROAD_WIDTH,
        PASS_6_BROAD_HEIGHT,
        Pass6CanonicalField::Procedural,
    )?;
    let broad_residual = sample_pass_6_canonical_window(
        after_surface,
        full_window,
        PASS_6_BROAD_WIDTH,
        PASS_6_BROAD_HEIGHT,
        Pass6CanonicalField::Procedural,
    )?;
    let broad_before = sample_pass_6_canonical_window(
        before_surface,
        full_window,
        PASS_6_BROAD_WIDTH,
        PASS_6_BROAD_HEIGHT,
        Pass6CanonicalField::Final,
    )?;
    let broad_after = sample_pass_6_canonical_window(
        after_surface,
        full_window,
        PASS_6_BROAD_WIDTH,
        PASS_6_BROAD_HEIGHT,
        Pass6CanonicalField::Final,
    )?;
    let broad_range = merged_range(&broad_before, &broad_after).unwrap_or((-1.0, 1.0));
    write_heatmap(
        &output.join("broad-before-final.png"),
        PASS_6_BROAD_WIDTH,
        PASS_6_BROAD_HEIGHT,
        &broad_before,
        broad_range,
    )?;
    write_heatmap(
        &output.join("broad-after-final.png"),
        PASS_6_BROAD_WIDTH,
        PASS_6_BROAD_HEIGHT,
        &broad_after,
        broad_range,
    )?;
    write_heatmap(
        &output.join("broad-parent-analysis.png"),
        PASS_6_BROAD_WIDTH,
        PASS_6_BROAD_HEIGHT,
        &broad_parent,
        broad_range,
    )?;
    write_symmetric_heatmap(
        &output.join("broad-new-residual.png"),
        PASS_6_BROAD_WIDTH,
        PASS_6_BROAD_HEIGHT,
        &broad_residual,
    )?;
    write_guide_overlay(
        &output.join("broad-after-guide-overlay.png"),
        &after,
        &broad_after,
        broad_range,
    )?;

    let before_correlation = pearson(&broad_parent, &broad_before_procedural);
    let after_correlation = pearson(&broad_parent, &broad_residual);
    let residual_mean = broad_residual.iter().copied().sum::<f32>() / broad_residual.len() as f32;
    let residual_rms = rms(&broad_residual);
    let performance = pass_6_performance(&before, &after)?;
    fs::write(
        output.join("parent-residual-metrics.csv"),
        format!(
            "metric,value\nbefore_parent_procedural_correlation,{before_correlation:.9}\nafter_parent_residual_correlation,{after_correlation:.9}\nresidual_mean_m,{residual_mean:.6}\nresidual_rms_m,{residual_rms:.6}\n"
        ),
    )
    .map_err(|error| error.to_string())?;
    fs::write(output.join("performance.csv"), &performance).map_err(|error| error.to_string())?;
    fs::write(
        output.join("hydrology-known-baseline.txt"),
        river_direction_histogram(&after),
    )
    .map_err(|error| error.to_string())?;
    fs::write(
        output.join("metadata.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "purpose": "URDR 4.4 pass 6 continuous guide and parent-constrained residual",
            "seed": after.environment_seed,
            "map_id": after.source_id,
            "physical_extent_km": [after.width, after.height],
            "canonical_dimensions": [after_surface.width, after_surface.height],
            "analysis_dimensions": [after.grid_width, after.grid_height],
            "surface_cell_m": after.surface_cell_m,
            "before_recipe": 1,
            "after_recipe": 2,
            "guide_weight": "normalized Gaussian partition; sigma=clamp(0.78/sqrt(site_count),0.12,0.32)",
            "residual_bands": [6144.0, 16384.0, 49152.0],
            "generator_version": env!("CARGO_PKG_VERSION"),
        }))
        .map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    fs::write(
        output.join("PASS-6-FINAL-REPORT.md"),
        pass_6_report(
            &after,
            before_correlation,
            after_correlation,
            residual_mean,
            residual_rms,
            &performance,
        ),
    )
    .map_err(|error| error.to_string())?;
    Ok(output)
}

fn pass_6_revision_map(
    source: &NativeMap,
    recipe_version: u16,
    guide_revision: u8,
) -> Result<NativeMap, String> {
    let mut map = source.clone();
    let settings = map
        .generation_settings
        .get_or_insert_with(crate::generator::MapGenerationSettings::default);
    settings.terrain_recipe_version = recipe_version;
    if settings.parent_world_seed == 0 {
        settings.parent_world_seed = u64::from(map.environment_seed);
    }
    let guide = map.geologic_guide.get_or_insert_with(|| {
        GeologicGuideMesh::generate(map.environment_seed, map.width, map.height)
    });
    guide.revision = guide_revision;
    if !map.rebuild_canonical_recipe_for_diagnostics() {
        return Err("unable to build pass 6 Canonical recipe".to_owned());
    }
    Ok(map)
}

fn sample_pass_6_canonical_window(
    surface: &crate::model::CanonicalSurface,
    window: Window,
    output_width: usize,
    output_height: usize,
    field: Pass6CanonicalField,
) -> Result<Vec<f32>, String> {
    let mut values = Vec::with_capacity(output_width * output_height);
    for y in 0..output_height {
        let canonical_y = window.top
            + (((y as f64 + 0.5) / output_height as f64)
                * window.bottom.saturating_sub(window.top).max(1) as f64)
                .floor() as usize;
        for x in 0..output_width {
            let canonical_x = window.left
                + (((x as f64 + 0.5) / output_width as f64)
                    * window.right.saturating_sub(window.left).max(1) as f64)
                    .floor() as usize;
            let sample = surface
                .diagnostic_sample(canonical_x, canonical_y)
                .ok_or_else(|| "Canonical diagnostic sample is unavailable".to_owned())?;
            values.push(match field {
                Pass6CanonicalField::Parent => sample.analysis_elevation_m,
                Pass6CanonicalField::Procedural => sample.procedural_elevation_m,
                Pass6CanonicalField::Final => sample.final_elevation_m,
            });
        }
    }
    Ok(values)
}

fn sample_pass_6_ablation_window(
    map: &NativeMap,
    window: Window,
    output_width: usize,
    output_height: usize,
    guide_revision: u8,
    terms: GeologyTermMask,
) -> Result<Vec<f32>, String> {
    let settings = map
        .generation_settings
        .as_ref()
        .ok_or_else(|| "generation settings are unavailable".to_owned())?;
    let mut guide = map.geologic_guide.clone().unwrap_or_else(|| {
        GeologicGuideMesh::generate(map.environment_seed, map.width, map.height)
    });
    guide.revision = guide_revision;
    let config = TerrainFieldConfig {
        seed: map.environment_seed,
        width_km: map.width,
        height_km: map.height,
        region_type: settings.region_type,
        maximum_elevation_m: settings.maximum_elevation_m as f32,
        elevation_span_m: settings.elevation_span_m as f32,
        elevation_noise: settings.elevation_noise_percent as f32 / 100.0,
    };
    let (canonical_width, canonical_height) = map.canonical_cell_dimensions();
    let mut values = Vec::with_capacity(output_width * output_height);
    for y in 0..output_height {
        let canonical_y = window.top as f64
            + (y as f64 + 0.5) / output_height as f64
                * window.bottom.saturating_sub(window.top).max(1) as f64;
        for x in 0..output_width {
            let canonical_x = window.left as f64
                + (x as f64 + 0.5) / output_width as f64
                    * window.right.saturating_sub(window.left).max(1) as f64;
            let x_km = canonical_x as f32 / canonical_width.max(1) as f32 * map.width;
            let y_km = canonical_y as f32 / canonical_height.max(1) as f32 * map.height;
            values.push(
                sample_terrain_field_with_terms(config, Some(&guide), x_km, y_km, terms)
                    .elevation_m,
            );
        }
    }
    Ok(values)
}

fn merged_range(left: &[f32], right: &[f32]) -> Option<(f32, f32)> {
    let left = finite_range(left)?;
    let right = finite_range(right)?;
    Some((left.0.min(right.0), left.1.max(right.1)))
}

fn difference(left: &[f32], right: &[f32]) -> Vec<f32> {
    left.iter()
        .zip(right)
        .map(|(left, right)| left - right)
        .collect()
}

fn rms(values: &[f32]) -> f64 {
    (values
        .iter()
        .map(|value| f64::from(*value).powi(2))
        .sum::<f64>()
        / values.len().max(1) as f64)
        .sqrt()
}

fn max_neighbor_delta(values: &[f32], width: usize, height: usize) -> f32 {
    let mut maximum = 0.0_f32;
    for y in 0..height {
        for x in 0..width {
            let index = y * width + x;
            if x + 1 < width {
                maximum = maximum.max((values[index] - values[index + 1]).abs());
            }
            if y + 1 < height {
                maximum = maximum.max((values[index] - values[index + width]).abs());
            }
        }
    }
    maximum
}

fn write_symmetric_heatmap(
    path: &Path,
    width: usize,
    height: usize,
    values: &[f32],
) -> Result<(), String> {
    let maximum = values
        .iter()
        .map(|value| value.abs())
        .fold(0.0_f32, f32::max)
        .max(1.0);
    write_heatmap(path, width, height, values, (-maximum, maximum))
}

fn write_guide_overlay(
    path: &Path,
    map: &NativeMap,
    values: &[f32],
    range: (f32, f32),
) -> Result<(), String> {
    let mut pixels = vec![0_u8; PASS_6_BROAD_WIDTH * PASS_6_BROAD_HEIGHT * 4];
    for (index, value) in values.iter().enumerate() {
        let normalized =
            ((*value - range.0) / (range.1 - range.0).max(f32::EPSILON)).clamp(0.0, 1.0);
        pixels[index * 4..index * 4 + 4].copy_from_slice(&elevation_color(normalized));
    }
    if let Some(guide) = &map.geologic_guide {
        for (index, site) in guide.sites.iter().enumerate() {
            for &neighbor in &site.neighbors {
                if usize::from(neighbor) <= index {
                    continue;
                }
                let other = &guide.sites[usize::from(neighbor)];
                draw_line(
                    &mut pixels,
                    PASS_6_BROAD_WIDTH,
                    PASS_6_BROAD_HEIGHT,
                    site.x_km / map.width.max(0.1) * PASS_6_BROAD_WIDTH as f32,
                    site.y_km / map.height.max(0.1) * PASS_6_BROAD_HEIGHT as f32,
                    other.x_km / map.width.max(0.1) * PASS_6_BROAD_WIDTH as f32,
                    other.y_km / map.height.max(0.1) * PASS_6_BROAD_HEIGHT as f32,
                    [255, 74, 120, 220],
                    2,
                );
            }
        }
    }
    write_png(path, PASS_6_BROAD_WIDTH, PASS_6_BROAD_HEIGHT, &pixels)
}

fn pass_6_performance(before: &NativeMap, after: &NativeMap) -> Result<String, String> {
    let mut csv = String::from("metric,before,after,unit\n");
    let guide_rate = |map: &NativeMap, revision: u8| {
        let mut guide = map.geologic_guide.clone().unwrap_or_else(|| {
            GeologicGuideMesh::generate(map.environment_seed, map.width, map.height)
        });
        guide.revision = revision;
        let started = Instant::now();
        let mut checksum = 0.0_f64;
        let count = 40_000;
        for index in 0..count {
            let x = ((index * 97) % 10_003) as f32 / 10_002.0 * map.width;
            let y = ((index * 193) % 10_007) as f32 / 10_006.0 * map.height;
            checksum += f64::from(guide.sample(x, y).uplift);
        }
        let elapsed = started.elapsed().as_secs_f64().max(f64::EPSILON);
        std::hint::black_box(checksum);
        count as f64 / elapsed
    };
    let before_guide = guide_rate(before, 1);
    let after_guide = guide_rate(after, 2);
    csv.push_str(&format!(
        "guide_samples_per_second,{before_guide:.3},{after_guide:.3},samples/s\n"
    ));

    let canonical_rate = |map: &NativeMap| -> Result<f64, String> {
        let surface = map
            .canonical_surface
            .as_ref()
            .ok_or_else(|| "performance surface unavailable".to_owned())?;
        let started = Instant::now();
        let mut checksum = 0.0_f64;
        let count = 2_000;
        for index in 0..count {
            let x = (index * 97) % surface.width as usize;
            let y = (index * 193) % surface.height as usize;
            checksum += f64::from(
                surface
                    .diagnostic_sample(x, y)
                    .ok_or_else(|| "performance sample unavailable".to_owned())?
                    .final_elevation_m,
            );
        }
        let elapsed = started.elapsed().as_secs_f64().max(f64::EPSILON);
        std::hint::black_box(checksum);
        Ok(count as f64 / elapsed)
    };
    let before_canonical = canonical_rate(before)?;
    let after_canonical = canonical_rate(after)?;
    csv.push_str(&format!(
        "canonical_samples_per_second,{before_canonical:.3},{after_canonical:.3},samples/s\n"
    ));
    Ok(csv)
}

fn pass_6_report(
    map: &NativeMap,
    before_correlation: f64,
    after_correlation: f64,
    residual_mean: f32,
    residual_rms: f64,
    performance: &str,
) -> String {
    format!(
        "# URDR 4.4 Map Generation Pass 6\n\n\
## A. Source audit\n\n\
Before: Planet parent -> 192x120 analysis/hydrology -> 84% analysis + 16% full `sample_terrain_field` -> hard nearest/second-nearest guide -> large causal geology bias.\n\n\
After: authoritative parent analysis -> spherical-position deterministic meso/local residual -> parent-preserving water sign. New guide samples a normalized Gaussian partition and derives deformation from the continuous weighted velocity gradient.\n\n\
## B. Core invariants\n\n\
- Planet/Region world consistency: **PASS** for stable parent coordinate, overlap cache, generation order, region extent, and Canonical resolution tests.\n\
- Natural hydrology: **PARTIAL**. Determinism is retained; 8-neighbour direction quantization remains the recorded pass-7 limitation.\n\
- Climate-conditioned geomorphology: **PARTIAL**. The residual context accepts future climate/hydrology fields, but this pass does not apply them.\n\n\
## C. Guide root fix\n\n\
The old hard pair is retained only for recipe/guide revision 1. Revision 2 uses `exp(-0.5*d^2/sigma^2)` normalized over finite sites, with `sigma=clamp(0.78/sqrt(n),0.12,0.32)`. Resistance and age are scalar blends; hotspot is a continuous radial sum; motion comes from the derivative of the blended velocity field.\n\n\
## D. Procedural to residual\n\n\
- Before parent/procedural correlation: `{before_correlation:.9}`\n\
- After parent/residual correlation: `{after_correlation:.9}`\n\
- Residual mean: `{residual_mean:.3} m`\n\
- Residual RMS: `{residual_rms:.3} m`\n\n\
## E. Save/version policy\n\n\
Missing terrain recipe metadata deserializes as revision 1. New maps persist revision 2, parent world seed, selected bearing and planet radius. There is no silent reinterpretation of old virtual recipes.\n\n\
## F. Performance\n\n```csv\n{performance}```\n\n\
## G. Map fixture\n\n\
- map: `{}`\n\
- seed: `{}`\n\
- physical extent: `{:.3} x {:.3} km`\n\
- analysis: `{} x {}`\n\n\
## H. Remaining known limitations\n\n\
- 192x120 rectangular regional terraces are unchanged.\n\
- 8-neighbour hydrology and straight river chains are unchanged.\n\
- Climate-conditioned weathering/erosion/sedimentation is not implemented in pass 6.\n",
        map.source_id, map.environment_seed, map.width, map.height, map.grid_width, map.grid_height,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Language;

    #[test]
    fn quintic_analysis_sampling_preserves_cell_values_at_centres() {
        let field = vec![1.0, 2.0, 3.0, 4.0];
        assert_eq!(sample_analysis_quintic(&field, 2, 2, 0.5, 0.5, 2, 2), 1.0);
        assert_eq!(sample_analysis_quintic(&field, 2, 2, 1.5, 1.5, 2, 2), 4.0);
    }

    #[test]
    #[ignore = "explicit pass-5 lineage diagnostic export"]
    fn pass_5_lineage_export() {
        let logs = crate::diagnostics::initialize().expect("diagnostics logger");
        let mut world = LoadedWorld::load_demo(Language::Korean).expect("Korean demo");
        if world.map.canonical_surface.is_none() {
            assert!(world.map.rebuild_canonical_surface());
        }
        let output = export_pipeline_lineage(&world).expect("pass 5 export");
        assert!(output.join("metadata.json").is_file());
        assert!(
            output
                .join("elevation-A-15-canonical-final-absolute.png")
                .is_file()
        );
        assert!(output.join("edge-topology-correlation.csv").is_file());
        assert!(output.join("river-selected.csv").is_file());
        eprintln!("diagnostics={}", logs.display());
        eprintln!("pass_5_lineage={}", output.display());
    }

    #[test]
    #[ignore = "explicit pass-6 terrain implementation export"]
    fn pass_6_terrain_export() {
        let logs = crate::diagnostics::initialize().expect("diagnostics logger");
        let world = LoadedWorld::load_demo(Language::Korean).expect("Korean demo");
        let output = export_pass_6_terrain(&world).expect("pass 6 export");
        assert!(output.join("PASS-6-FINAL-REPORT.md").is_file());
        assert!(output.join("probe-A-before-final.png").is_file());
        assert!(output.join("probe-A-after-final.png").is_file());
        assert!(output.join("broad-after-guide-overlay.png").is_file());
        assert!(output.join("guide-subterm-ablation.csv").is_file());
        eprintln!("diagnostics={}", logs.display());
        eprintln!("pass_6_terrain={}", output.display());
    }
}

fn write_mask(
    path: &Path,
    width: usize,
    height: usize,
    mask: &[f32],
    color: [u8; 4],
) -> Result<(), String> {
    let mut pixels = vec![0_u8; width * height * 4];
    for index in 0..width * height {
        let base = if mask[index] > 0.0 {
            color
        } else {
            [14, 22, 32, 255]
        };
        pixels[index * 4..index * 4 + 4].copy_from_slice(&base);
    }
    write_png(path, width, height, &pixels)
}
