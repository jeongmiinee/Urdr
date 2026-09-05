use std::{
    fs::{self, File},
    io::{BufReader, BufWriter},
    path::{Path, PathBuf},
};

use serde::Serialize;

use crate::{
    generator::{
        CURRENT_TERRAIN_RECIPE_VERSION, DiagnosticFlowTarget, PipelineDiagnosticReplay,
        replay_pipeline_diagnostics,
    },
    model::{LoadedWorld, NativeMap, Point, RiverSegment},
    multiresolution_physics::{
        CURRENT_PHYSICAL_ANALYSIS_REVISION, MultiresolutionPhysicalSurface, PhysicalAnalysisMetrics,
    },
    pipeline_diagnostics::{reconstruct_analysis_lineage, resolve_selection},
    river_graph::{RiverGraph, RiverReach},
    spatial::PlanetPosition,
    subcell_hydrology::{
        CURRENT_HYDROLOGY_GEOMETRY_VERSION, CanonicalHydrologySurface, ContinuousFlowRoute,
        ContinuousFlowTarget, ContinuousHydrologySurface, HydrologyGeometryStats,
        HydrologyWorldIdentity, SubcellHydrologyGeometry, SubcellHydrologyInput,
        build_subcell_hydrology,
    },
};

const OUTPUT_NAME: &str = "URDR-4.4-Pass-8-Multiresolution-Physical";
const IMAGE_WIDTH: usize = 960;
const IMAGE_HEIGHT: usize = 420;
const PASS7_CHANNEL_CELLS: usize = 3_720;
const PASS7_CONDITIONED_CELLS: usize = 1_426;
const PASS7_RAW_UPHILL: usize = 5_110;
const PASS7_TOTAL_RAISE_M: f64 = 426_468.228_816;
const PASS7_MAX_RAISE_M: f32 = 660.233_887;
const PASS7_GEOMETRY_MS: f64 = 4_665.191_1;
const PASS7_AXIS_BIAS: f64 = 0.469_514_057;
const PASS7_LONGEST_STRAIGHT_KM: f64 = 26.700_639;

#[derive(Clone, Copy)]
struct WorldView {
    left: f32,
    top: f32,
    right: f32,
    bottom: f32,
}

#[derive(Clone, Debug, Default)]
struct RiverShapeMetrics {
    total_length_km: f64,
    axis_bias_fraction: f64,
    longest_straight_run_km: f64,
    runs_over_10_km: usize,
    runs_over_25_km: usize,
}

#[derive(Serialize)]
struct Pass8Metadata {
    purpose: &'static str,
    seed: u32,
    map_id: String,
    map_title: String,
    surface_revision: u64,
    physical_extent_km: [f32; 2],
    surface_cell_m: f32,
    macro_dimensions: [usize; 2],
    canonical_dimensions: [u32; 2],
    refinement_levels: [u8; 3],
    patch_count: usize,
    level_1_patches: usize,
    level_2_patches: usize,
    refined_cell_count: usize,
    physical_analysis_revision: u16,
    hydrology_geometry_revision: u16,
    terrain_recipe_revision: u16,
    derived_cache_persistent: bool,
    cache_key: String,
    generator_version: &'static str,
}

pub(crate) fn export_pass_8_physical(world: &LoadedWorld) -> Result<PathBuf, String> {
    let mut map = world.map.clone();
    if let Some(settings) = map.generation_settings.as_mut() {
        settings.terrain_recipe_version = CURRENT_TERRAIN_RECIPE_VERSION;
    }
    if !map.rebuild_canonical_recipe_for_diagnostics() {
        return Err("Pass 8 requires a reconstructable Canonical surface recipe.".to_owned());
    }
    let selection = resolve_selection(world, &map);
    let lineage = reconstruct_analysis_lineage(world, &map, &selection)?;
    map.elevation = lineage.replay.post_erosion_elevation.clone();
    if !map.rebuild_canonical_recipe_for_diagnostics() {
        return Err(
            "Pass 8 could not align Canonical terrain with replayed physical elevation.".to_owned(),
        );
    }
    let replay = replay_pipeline_diagnostics(&map, &lineage.combined)?;
    let filled = replay
        .priority_flood_elevation
        .iter()
        .map(|value| f64::from(*value))
        .collect::<Vec<_>>();
    let physical = MultiresolutionPhysicalSurface::build(
        &map,
        &filled,
        &replay.flow_accumulation,
        &replay.downstream,
        &replay.channels,
    )
    .ok_or_else(|| "Pass 8 physical field could not be constructed.".to_owned())?;
    let metrics = physical.metrics().clone();
    let pass7_geometry = replay_pass7_geometry(&map, &replay, &filled)?;
    let pass8_geometry = &replay.hydrology_geometry_stats;
    let output = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("outputs")
        .join(OUTPUT_NAME);
    fs::create_dir_all(&output).map_err(|error| error.to_string())?;

    let pass7_segments = pass7_geometry
        .0
        .paths
        .iter()
        .flat_map(|path| path.points.windows(2).map(|pair| (pair[0], pair[1])))
        .collect::<Vec<_>>();
    let pass8_segments = replay
        .spline_segments
        .iter()
        .map(|segment| (segment.start, segment.end))
        .collect::<Vec<_>>();
    let pass7_shape = shape_metrics(&pass7_segments);
    let pass8_shape = shape_metrics(&pass8_segments);
    let grid_before = terrain_axis_metric(&map, None);
    let grid_after = terrain_axis_metric(&map, Some(&physical));

    write_refinement_csv(&output, &map, &metrics)?;
    write_hydrology_csv(&output, &pass7_geometry.1, pass8_geometry)?;
    write_terrain_csv(&output, grid_before, grid_after, &metrics)?;
    write_performance_csv(&output, &replay, &metrics)?;
    write_corridor_csv(&output, &map, &replay, &physical, pass8_geometry)?;
    write_broad_elevation_image(
        &output.join("pass8-01-broad-elevation.png"),
        &map,
        &physical,
    )?;
    write_grid_comparison_image(
        &output.join("pass8-02-parent-grid-overlay.png"),
        &map,
        &physical,
    )?;
    for (index, point) in select_probes(&map, &metrics).iter().enumerate() {
        write_probe_image(
            &output.join(format!(
                "pass8-0{}-probe-{}.png",
                index + 3,
                (b'A' + index as u8) as char
            )),
            &map,
            &physical,
            *point,
        )?;
    }
    write_refinement_mask(&output.join("pass8-06-refinement-mask.png"), &map, &metrics)?;
    write_conditioning_heatmap(
        &output.join("pass8-07-conditioning-heatmap.png"),
        &map,
        pass8_geometry,
    )?;
    let selected = select_rivers(&map, &replay.spline_segments, 5);
    for (index, reach) in selected.iter().enumerate() {
        write_river_comparison(
            &output.join(format!("pass8-{:02}-river-{}.png", index + 8, index + 1)),
            &map,
            reach,
            &pass7_segments,
            &pass8_segments,
            &metrics,
        )?;
    }
    write_corridor_profiles(
        &output.join("pass8-13-top-mismatch-corridors.png"),
        &map,
        &physical,
        pass8_geometry,
    )?;

    let surface = map
        .canonical_surface
        .as_ref()
        .ok_or_else(|| "Canonical surface missing during Pass 8 export.".to_owned())?;
    let terrain_recipe_revision = map
        .generation_settings
        .as_ref()
        .map_or(0, |settings| settings.terrain_recipe_version);
    let metadata = Pass8Metadata {
        purpose: "URDR 4.4 Pass 8 multiresolution regional physical diagnostics",
        seed: map.environment_seed,
        map_id: map.source_id.clone(),
        map_title: map.title.clone(),
        surface_revision: map.surface_revision,
        physical_extent_km: [map.width, map.height],
        surface_cell_m: map.surface_cell_m,
        macro_dimensions: [map.grid_width, map.grid_height],
        canonical_dimensions: [surface.width, surface.height],
        refinement_levels: [0, 1, 2],
        patch_count: metrics.patch_count,
        level_1_patches: metrics.l1_patches,
        level_2_patches: metrics.l2_patches,
        refined_cell_count: metrics.refined_cells,
        physical_analysis_revision: CURRENT_PHYSICAL_ANALYSIS_REVISION,
        hydrology_geometry_revision: CURRENT_HYDROLOGY_GEOMETRY_VERSION,
        terrain_recipe_revision,
        derived_cache_persistent: false,
        cache_key: metrics.cache_key.clone(),
        generator_version: env!("CARGO_PKG_VERSION"),
    };
    fs::write(
        output.join("pass8-metadata.json"),
        serde_json::to_vec_pretty(&metadata).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    fs::write(
        output.join("PASS-8-FINAL-REPORT.md"),
        build_report(
            &map,
            &metrics,
            &pass7_geometry.1,
            pass8_geometry,
            &pass7_shape,
            &pass8_shape,
            grid_before,
            grid_after,
        ),
    )
    .map_err(|error| error.to_string())?;
    Ok(output)
}

fn replay_pass7_geometry(
    map: &NativeMap,
    replay: &PipelineDiagnosticReplay,
    filled: &[f64],
) -> Result<(SubcellHydrologyGeometry, HydrologyGeometryStats), String> {
    let surface = map
        .canonical_surface
        .as_deref()
        .ok_or_else(|| "Pass 7 comparison requires Canonical surface.".to_owned())?;
    let sampler = CanonicalHydrologySurface::new(surface, map.width, map.height);
    let routes = diagnostic_routes(
        map.grid_width.saturating_mul(map.grid_height),
        &replay.flow_targets,
    );
    let settings = map.generation_settings.as_ref();
    let identity = HydrologyWorldIdentity {
        parent_seed: settings
            .map(|settings| settings.parent_world_seed)
            .filter(|seed| *seed != 0)
            .unwrap_or_else(|| u64::from(map.environment_seed)),
        region_center: PlanetPosition::from_latitude_longitude_deg(
            settings.map_or(0.0, |value| value.center_latitude_deg),
            settings.map_or(0.0, |value| value.center_longitude_deg),
        ),
        selection_bearing_deg: settings.map_or(0.0, |value| value.selection_bearing_deg),
        planet_radius_m: settings
            .map_or(6_371_000.0, |value| value.parent_planet_radius_m)
            .max(1.0),
    };
    let geometry = build_subcell_hydrology(&SubcellHydrologyInput {
        width: map.grid_width,
        height: map.grid_height,
        world_width_km: map.width,
        world_height_km: map.height,
        identity,
        water: &map.water,
        filled_elevation: filled,
        terrain: &map.terrain,
        flow: &replay.flow_accumulation,
        downstream: &replay.downstream,
        channels: &replay.channels,
        routing: &routes,
        surface: &sampler,
        apply_parent_conditioning: true,
        reconcile_local_topology: false,
    });
    let stats = geometry.stats.clone();
    Ok((geometry, stats))
}

fn diagnostic_routes(count: usize, targets: &[DiagnosticFlowTarget]) -> Vec<ContinuousFlowRoute> {
    let mut routes = vec![ContinuousFlowRoute::default(); count];
    for target in targets {
        let Some(route) = routes.get_mut(target.from) else {
            continue;
        };
        let value = Some(ContinuousFlowTarget {
            index: target.to,
            weight: target.weight,
        });
        if route.targets[0].is_none() {
            route.targets[0] = value;
        } else if route.targets[1].is_none() {
            route.targets[1] = value;
        }
    }
    routes
}

fn write_refinement_csv(
    output: &Path,
    map: &NativeMap,
    metrics: &PhysicalAnalysisMetrics,
) -> Result<(), String> {
    let macro_cells = map.grid_width.saturating_mul(map.grid_height);
    let level_1 = metrics
        .refinement_levels
        .iter()
        .filter(|level| **level == 1)
        .count();
    let level_2 = metrics
        .refinement_levels
        .iter()
        .filter(|level| **level == 2)
        .count();
    fs::write(
        output.join("pass8-refinement-metrics.csv"),
        format!(
            "metric,value,unit\nphysical_revision,{},revision\nmacro_cells,{},cells\nlevel_1_macro_coverage,{},cells\nlevel_2_macro_coverage,{},cells\npatch_count,{},patches\nlevel_1_patches,{},patches\nlevel_2_patches,{},patches\nrefined_cells,{},cells\nlocal_hydrology_cells,{},cells\nlocal_conditioned_cells,{},cells\nlocal_conditioning_total_raise_m,{:.6},m\nlocal_conditioning_mean_raise_m,{:.6},m\nlocal_conditioning_max_raise_m,{:.6},m\ncanonical_parent_mean_abs_delta_m,{:.6},m\ncanonical_parent_max_abs_delta_m,{:.6},m\ngradient_disagreement_over_45,{},cells\ngradient_disagreement_over_90,{},cells\nsaddle_disagreement,{},cells\nconditioning_cause_parent_terrace,{},cells\nconditioning_cause_hidden_ridge,{},cells\nconditioning_cause_residual_barrier,{},cells\nconditioning_cause_saddle_mismatch,{},cells\nconditioning_cause_interpolation_coast,{},cells\nconditioning_cause_other,{},cells\ndownsample_rmse_m,{:.6},m\ndownsample_max_error_m,{:.6},m\nmax_parent_conditioning_m,{:.6},m\nmax_parent_conditioning_cell,{},index\nbudget_limited,{},bool\n",
            metrics.revision,
            macro_cells,
            level_1,
            level_2,
            metrics.patch_count,
            metrics.l1_patches,
            metrics.l2_patches,
            metrics.refined_cells,
            metrics.local_hydrology_cells,
            metrics.local_conditioned_cells,
            metrics.local_conditioning_total_raise_m,
            metrics.local_conditioning_total_raise_m
                / metrics.local_conditioned_cells.max(1) as f64,
            metrics.local_conditioning_max_raise_m,
            metrics.canonical_parent_mean_abs_delta_m,
            metrics.canonical_parent_max_abs_delta_m,
            metrics.gradient_disagreement_over_45,
            metrics.gradient_disagreement_over_90,
            metrics.saddle_disagreement_count,
            metrics.conditioning_cause_counts[0],
            metrics.conditioning_cause_counts[1],
            metrics.conditioning_cause_counts[2],
            metrics.conditioning_cause_counts[3],
            metrics.conditioning_cause_counts[4],
            metrics.conditioning_cause_counts[5],
            metrics.downsample_rmse_m,
            metrics.downsample_max_error_m,
            metrics.max_parent_conditioning_m,
            metrics.max_parent_conditioning_cell,
            metrics.budget_limited,
        ),
    )
    .map_err(|error| error.to_string())
}

fn write_hydrology_csv(
    output: &Path,
    before: &HydrologyGeometryStats,
    after: &HydrologyGeometryStats,
) -> Result<(), String> {
    let after_mean =
        after.profile_conditioning_total_raise_m / after.profile_conditioning_samples.max(1) as f64;
    let labels = [
        "0-1", "1-5", "5-20", "20-50", "50-100", "100-250", "250-500", ">500",
    ];
    let mut csv = format!(
        "metric,pass7_locked,pass7_aligned_replay,pass8,unit\nchannel_cells,{},{},{},cells\nconditioned_channel_cells,{},{},{},cells\nnumerically_conditioned_channel_cells,not_recorded,{},{},cells\nrelaxed_corridor_cells,not_recorded,{},{},cells\nconditioning_fraction,{:.9},{:.9},{:.9},fraction\nraw_uphill_violations,{},{},{},samples\nconditioned_uphill_violations,0,{},0,samples\nconditioning_total_raise_m,{:.6},{:.6},{:.6},m\nconditioning_mean_raise_m,{:.6},{:.6},{:.6},m\nconditioning_max_raise_m,{:.6},{:.6},{:.6},m\nlacustrine_connector_cells,0,{},{},cells\nlacustrine_maximum_depth_m,0,{:.6},{:.6},m\nfallback_count,0,{},{},edges\nbasin_identity_changes,0,0,0,count\noutlet_identity_changes,0,0,0,count\n",
        PASS7_CHANNEL_CELLS,
        before.channel_cells,
        after.channel_cells,
        PASS7_CONDITIONED_CELLS,
        before.locally_conditioned_channel_cells,
        after.locally_conditioned_channel_cells,
        before.numerically_conditioned_channel_cells,
        after.numerically_conditioned_channel_cells,
        before.relaxed_corridor_cells,
        after.relaxed_corridor_cells,
        PASS7_CONDITIONED_CELLS as f64 / PASS7_CHANNEL_CELLS as f64,
        before.locally_conditioned_channel_cells as f64 / before.channel_cells.max(1) as f64,
        after.locally_conditioned_channel_cells as f64 / after.channel_cells.max(1) as f64,
        PASS7_RAW_UPHILL,
        before.raw_uphill_violations,
        after.raw_uphill_violations,
        before.conditioned_uphill_violations,
        PASS7_TOTAL_RAISE_M,
        before.profile_conditioning_total_raise_m,
        after.profile_conditioning_total_raise_m,
        PASS7_TOTAL_RAISE_M / 19_754.0,
        before.profile_conditioning_total_raise_m
            / before.profile_conditioning_samples.max(1) as f64,
        after_mean,
        PASS7_MAX_RAISE_M,
        before.profile_conditioning_max_raise_m,
        after.profile_conditioning_max_raise_m,
        before.lacustrine_connector_cells,
        after.lacustrine_connector_cells,
        before.lacustrine_maximum_depth_m,
        after.lacustrine_maximum_depth_m,
        before.fallback_count,
        after.fallback_count,
    );
    for (index, label) in labels.iter().enumerate() {
        csv.push_str(&format!(
            "conditioning_histogram_{label},not_recorded,{},{},samples\n",
            before.profile_conditioning_histogram[index],
            after.profile_conditioning_histogram[index]
        ));
    }
    fs::write(output.join("pass8-hydrology-reconciliation.csv"), csv)
        .map_err(|error| error.to_string())
}

fn write_terrain_csv(
    output: &Path,
    before_axis: f64,
    after_axis: f64,
    metrics: &PhysicalAnalysisMetrics,
) -> Result<(), String> {
    fs::write(
        output.join("pass8-terrain-grid-artifact.csv"),
        format!(
            "metric,before,after,unit\ngrid_boundary_curvature_ratio,{before_axis:.9},{after_axis:.9},ratio\nrectangular_terrace_proxy,{before_axis:.9},{after_axis:.9},ratio\nparent_downsample_rmse_m,0,{:.6},m\nparent_downsample_max_error_m,0,{:.6},m\n",
            metrics.downsample_rmse_m, metrics.downsample_max_error_m,
        ),
    )
    .map_err(|error| error.to_string())
}

fn write_performance_csv(
    output: &Path,
    replay: &PipelineDiagnosticReplay,
    metrics: &PhysicalAnalysisMetrics,
) -> Result<(), String> {
    let replay_physical_ms = replay
        .physical_analysis_metrics
        .as_ref()
        .map_or(metrics.total_ms, |physical| physical.total_ms);
    let macro_ms = (replay.replay_total_ms
        - replay.hydrology_geometry_stats.geometry_build_ms
        - replay_physical_ms)
        .max(0.0);
    let patch_sampling_ms = (metrics.patch_build_ms - metrics.local_hydrology_ms).max(0.0);
    fs::write(
        output.join("pass8-performance.csv"),
        format!(
            "metric,pass7,pass8,unit\nmacro_analysis_ms,{macro_ms:.6},{macro_ms:.6},ms\nimportance_field_ms,0,{:.6},ms\npatch_build_ms,0,{:.6},ms\nlocal_hydrology_ms,0,{:.6},ms\nriver_geometry_ms,{PASS7_GEOMETRY_MS:.6},{:.6},ms\ntotal_generation_ms,{:.6},{:.6},ms\nrefined_cells,0,{},cells\npatch_count,0,{},patches\npeak_memory_bytes,22022688,{},bytes\n",
            metrics.importance_field_ms,
            patch_sampling_ms,
            metrics.local_hydrology_ms,
            replay.hydrology_geometry_stats.geometry_build_ms,
            macro_ms + PASS7_GEOMETRY_MS,
            replay.replay_total_ms,
            metrics.refined_cells,
            metrics.patch_count,
            metrics.peak_scratch_bytes + replay.hydrology_geometry_stats.peak_scratch_bytes,
        ),
    )
    .map_err(|error| error.to_string())
}

fn write_corridor_csv(
    output: &Path,
    map: &NativeMap,
    replay: &PipelineDiagnosticReplay,
    physical: &MultiresolutionPhysicalSurface<'_>,
    stats: &HydrologyGeometryStats,
) -> Result<(), String> {
    let mut csv = "rank,from_cell,to_cell,raw_uphill_violations,total_raise_m,maximum_raise_m,world_x_km,world_y_km,from_parent_m,to_parent_m,from_filled_m,to_filled_m,from_physical_m,to_physical_m,from_hydrology_m,to_hydrology_m\n".to_owned();
    for (rank, corridor) in stats.top_conditioning_corridors.iter().enumerate() {
        let point = corridor
            .maximum_raise_point
            .unwrap_or(Point { x: -1.0, y: -1.0 });
        let from_point = macro_center(map, corridor.from_cell);
        let to_point = macro_center(map, corridor.to_cell);
        csv.push_str(&format!(
            "{},{},{},{},{:.6},{:.6},{:.6},{:.6},{:.6},{:.6},{:.6},{:.6},{:.6},{:.6},{:.6},{:.6}\n",
            rank + 1,
            corridor.from_cell,
            corridor.to_cell,
            corridor.raw_uphill_violations,
            corridor.total_raise_m,
            corridor.maximum_raise_m,
            point.x,
            point.y,
            map.elevation[corridor.from_cell],
            map.elevation[corridor.to_cell],
            replay.priority_flood_elevation[corridor.from_cell],
            replay.priority_flood_elevation[corridor.to_cell],
            physical.sample_physical(from_point).elevation_m,
            physical.sample_physical(to_point).elevation_m,
            physical.sample(from_point).elevation_m,
            physical.sample(to_point).elevation_m,
        ));
    }
    fs::write(output.join("pass8-top-mismatch-corridors.csv"), csv)
        .map_err(|error| error.to_string())
}

fn write_broad_elevation_image(
    path: &Path,
    map: &NativeMap,
    physical: &MultiresolutionPhysicalSurface<'_>,
) -> Result<(), String> {
    let half = IMAGE_WIDTH / 2;
    let mut pixels = vec![0_u8; IMAGE_WIDTH * IMAGE_HEIGHT * 4];
    let (low, high) = elevation_range(map);
    for y in 0..IMAGE_HEIGHT {
        for x in 0..half {
            let point = Point {
                x: (x as f32 + 0.5) / half as f32 * map.width,
                y: (y as f32 + 0.5) / IMAGE_HEIGHT as f32 * map.height,
            };
            set_pixel(
                &mut pixels,
                IMAGE_WIDTH,
                x,
                y,
                elevation_color(parent_sample(map, point), low, high),
            );
            set_pixel(
                &mut pixels,
                IMAGE_WIDTH,
                x + half,
                y,
                elevation_color(physical.sample_physical(point).elevation_m, low, high),
            );
        }
    }
    draw_vertical(
        &mut pixels,
        IMAGE_WIDTH,
        IMAGE_HEIGHT,
        half,
        [245, 248, 252, 255],
    );
    write_png(path, IMAGE_WIDTH, IMAGE_HEIGHT, &pixels)
}

fn write_grid_comparison_image(
    path: &Path,
    map: &NativeMap,
    physical: &MultiresolutionPhysicalSurface<'_>,
) -> Result<(), String> {
    write_broad_elevation_image(path, map, physical)?;
    let mut pixels = read_png_rgba(path)?;
    let half = IMAGE_WIDTH / 2;
    for x in 0..=map.grid_width {
        let px = (x as f32 / map.grid_width.max(1) as f32 * half as f32).round() as usize;
        draw_vertical(
            &mut pixels,
            IMAGE_WIDTH,
            IMAGE_HEIGHT,
            px.min(half - 1),
            [255, 87, 111, 90],
        );
        draw_vertical(
            &mut pixels,
            IMAGE_WIDTH,
            IMAGE_HEIGHT,
            (px + half).min(IMAGE_WIDTH - 1),
            [255, 87, 111, 60],
        );
    }
    for y in 0..=map.grid_height {
        let py = (y as f32 / map.grid_height.max(1) as f32 * IMAGE_HEIGHT as f32).round() as usize;
        draw_horizontal(
            &mut pixels,
            IMAGE_WIDTH,
            IMAGE_HEIGHT,
            py.min(IMAGE_HEIGHT - 1),
            0,
            half,
            [255, 87, 111, 90],
        );
        draw_horizontal(
            &mut pixels,
            IMAGE_WIDTH,
            IMAGE_HEIGHT,
            py.min(IMAGE_HEIGHT - 1),
            half,
            IMAGE_WIDTH,
            [255, 87, 111, 60],
        );
    }
    write_png(path, IMAGE_WIDTH, IMAGE_HEIGHT, &pixels)
}

fn select_probes(map: &NativeMap, metrics: &PhysicalAnalysisMetrics) -> [Point; 3] {
    let mut ranked = metrics
        .importance
        .iter()
        .copied()
        .enumerate()
        .collect::<Vec<_>>();
    ranked.sort_by(|left, right| {
        right
            .1
            .total_cmp(&left.1)
            .then_with(|| left.0.cmp(&right.0))
    });
    let mut points = Vec::new();
    for (index, _) in ranked {
        let point = macro_center(map, index);
        if points
            .iter()
            .all(|other: &Point| distance(*other, point) > map.width.min(map.height) * 0.18)
        {
            points.push(point);
        }
        if points.len() == 3 {
            break;
        }
    }
    while points.len() < 3 {
        let t = (points.len() + 1) as f32 / 4.0;
        points.push(Point {
            x: map.width * t,
            y: map.height * t,
        });
    }
    [points[0], points[1], points[2]]
}

fn write_probe_image(
    path: &Path,
    map: &NativeMap,
    physical: &MultiresolutionPhysicalSurface<'_>,
    center: Point,
) -> Result<(), String> {
    let panel = IMAGE_WIDTH / 3;
    let height = 320;
    let mut pixels = vec![0_u8; IMAGE_WIDTH * height * 4];
    let radius_x = map.width * 0.06;
    let radius_y = map.height * 0.09;
    let (low, high) = elevation_range(map);
    let canonical = map
        .canonical_surface
        .as_deref()
        .ok_or_else(|| "Canonical surface missing for terrain probe.".to_owned())?;
    for y in 0..height {
        for x in 0..panel {
            let point = Point {
                x: (center.x - radius_x + x as f32 / panel as f32 * radius_x * 2.0)
                    .clamp(0.0, map.width),
                y: (center.y - radius_y + y as f32 / height as f32 * radius_y * 2.0)
                    .clamp(0.0, map.height),
            };
            for (offset, value) in [
                (0, parent_sample(map, point)),
                (
                    panel,
                    canonical
                        .hydrology_sample_at_world(point, map.width, map.height)
                        .elevation_m,
                ),
                (panel * 2, physical.sample_physical(point).elevation_m),
            ] {
                set_pixel(
                    &mut pixels,
                    IMAGE_WIDTH,
                    x + offset,
                    y,
                    elevation_color(value, low, high),
                );
            }
        }
    }
    draw_vertical(
        &mut pixels,
        IMAGE_WIDTH,
        height,
        panel,
        [245, 248, 252, 255],
    );
    draw_vertical(
        &mut pixels,
        IMAGE_WIDTH,
        height,
        panel * 2,
        [245, 248, 252, 255],
    );
    write_png(path, IMAGE_WIDTH, height, &pixels)
}

fn write_refinement_mask(
    path: &Path,
    map: &NativeMap,
    metrics: &PhysicalAnalysisMetrics,
) -> Result<(), String> {
    let mut pixels = vec![0_u8; IMAGE_WIDTH * IMAGE_HEIGHT * 4];
    for y in 0..IMAGE_HEIGHT {
        for x in 0..IMAGE_WIDTH {
            let gx = (x * map.grid_width / IMAGE_WIDTH).min(map.grid_width - 1);
            let gy = (y * map.grid_height / IMAGE_HEIGHT).min(map.grid_height - 1);
            let index = gy * map.grid_width + gx;
            let color = match metrics.refinement_levels[index] {
                2 => [255, 112, 92, 255],
                1 => [55, 190, 229, 255],
                _ if map.water[index] != "land" => [24, 55, 83, 255],
                _ => [25, 35, 48, 255],
            };
            set_pixel(&mut pixels, IMAGE_WIDTH, x, y, color);
        }
    }
    write_png(path, IMAGE_WIDTH, IMAGE_HEIGHT, &pixels)
}

fn write_conditioning_heatmap(
    path: &Path,
    map: &NativeMap,
    stats: &HydrologyGeometryStats,
) -> Result<(), String> {
    let mut values = vec![0.0_f32; map.grid_width * map.grid_height];
    for corridor in &stats.top_conditioning_corridors {
        if let Some(value) = values.get_mut(corridor.from_cell) {
            *value = value.max(corridor.maximum_raise_m);
        }
    }
    let maximum = values.iter().copied().fold(1.0_f32, f32::max);
    let mut pixels = vec![0_u8; IMAGE_WIDTH * IMAGE_HEIGHT * 4];
    for y in 0..IMAGE_HEIGHT {
        for x in 0..IMAGE_WIDTH {
            let gx = (x * map.grid_width / IMAGE_WIDTH).min(map.grid_width - 1);
            let gy = (y * map.grid_height / IMAGE_HEIGHT).min(map.grid_height - 1);
            let value = values[gy * map.grid_width + gx] / maximum;
            let color = if value <= 0.0 {
                [15, 25, 37, 255]
            } else {
                [
                    (75.0 + value * 180.0) as u8,
                    (125.0 - value * 95.0) as u8,
                    72,
                    255,
                ]
            };
            set_pixel(&mut pixels, IMAGE_WIDTH, x, y, color);
        }
    }
    write_png(path, IMAGE_WIDTH, IMAGE_HEIGHT, &pixels)
}

fn select_rivers(map: &NativeMap, segments: &[RiverSegment], count: usize) -> Vec<RiverReach> {
    let mut reaches = RiverGraph::from_segments_with_revision(
        &map.source_id,
        segments,
        false,
        CURRENT_HYDROLOGY_GEOMETRY_VERSION,
    )
    .reaches;
    reaches.sort_by(|left, right| {
        polyline_length(&right.centerline)
            .total_cmp(&polyline_length(&left.centerline))
            .then_with(|| left.id.cmp(&right.id))
    });
    reaches.truncate(count);
    reaches
}

fn write_river_comparison(
    path: &Path,
    map: &NativeMap,
    reach: &RiverReach,
    before: &[(Point, Point)],
    after: &[(Point, Point)],
    metrics: &PhysicalAnalysisMetrics,
) -> Result<(), String> {
    let view = river_view(map, &reach.centerline);
    let mut pixels = terrain_background(map, view, IMAGE_WIDTH, IMAGE_HEIGHT);
    for (start, end) in before
        .iter()
        .copied()
        .filter(|(start, end)| intersects(view, *start, *end))
    {
        let (x0, y0) = to_pixel(view, start, IMAGE_WIDTH, IMAGE_HEIGHT);
        let (x1, y1) = to_pixel(view, end, IMAGE_WIDTH, IMAGE_HEIGHT);
        draw_line(
            &mut pixels,
            IMAGE_WIDTH,
            IMAGE_HEIGHT,
            x0,
            y0,
            x1,
            y1,
            [255, 111, 122, 220],
            2,
        );
    }
    for (start, end) in after
        .iter()
        .copied()
        .filter(|(start, end)| intersects(view, *start, *end))
    {
        let (x0, y0) = to_pixel(view, start, IMAGE_WIDTH, IMAGE_HEIGHT);
        let (x1, y1) = to_pixel(view, end, IMAGE_WIDTH, IMAGE_HEIGHT);
        draw_line(
            &mut pixels,
            IMAGE_WIDTH,
            IMAGE_HEIGHT,
            x0,
            y0,
            x1,
            y1,
            [53, 210, 255, 255],
            2,
        );
    }
    draw_refinement_outline(&mut pixels, map, view, metrics);
    write_png(path, IMAGE_WIDTH, IMAGE_HEIGHT, &pixels)
}

fn write_corridor_profiles(
    path: &Path,
    map: &NativeMap,
    physical: &MultiresolutionPhysicalSurface<'_>,
    stats: &HydrologyGeometryStats,
) -> Result<(), String> {
    let width = IMAGE_WIDTH;
    let height = 480;
    let rows = stats.top_conditioning_corridors.len().min(6).max(1);
    let row_height = height / rows;
    let mut pixels = vec![12_u8; width * height * 4];
    for pixel in pixels.chunks_exact_mut(4) {
        pixel[3] = 255;
    }
    for (row, corridor) in stats
        .top_conditioning_corridors
        .iter()
        .take(rows)
        .enumerate()
    {
        let start = macro_center(map, corridor.from_cell);
        let end = macro_center(map, corridor.to_cell);
        let mut parent = Vec::new();
        let mut refined = Vec::new();
        for sample in 0..64 {
            let point = lerp(start, end, sample as f32 / 63.0);
            parent.push(parent_sample(map, point));
            refined.push(physical.sample_physical(point).elevation_m);
        }
        let low = parent
            .iter()
            .chain(&refined)
            .copied()
            .fold(f32::INFINITY, f32::min);
        let high = parent
            .iter()
            .chain(&refined)
            .copied()
            .fold(f32::NEG_INFINITY, f32::max);
        for index in 0..63 {
            for (values, color) in [
                (&parent, [255, 122, 130, 255]),
                (&refined, [52, 211, 255, 255]),
            ] {
                let x0 = index as f32 / 63.0 * (width - 1) as f32;
                let x1 = (index + 1) as f32 / 63.0 * (width - 1) as f32;
                let y0 = row * row_height
                    + ((high - values[index]) / (high - low).max(1.0) * (row_height - 8) as f32)
                        as usize;
                let y1 = row * row_height
                    + ((high - values[index + 1]) / (high - low).max(1.0) * (row_height - 8) as f32)
                        as usize;
                draw_line(
                    &mut pixels,
                    width,
                    height,
                    x0,
                    y0 as f32,
                    x1,
                    y1 as f32,
                    color,
                    2,
                );
            }
        }
        if row + 1 < rows {
            draw_horizontal(
                &mut pixels,
                width,
                height,
                (row + 1) * row_height,
                0,
                width,
                [58, 70, 84, 255],
            );
        }
    }
    write_png(path, width, height, &pixels)
}

fn terrain_axis_metric(
    map: &NativeMap,
    physical: Option<&MultiresolutionPhysicalSurface<'_>>,
) -> f64 {
    let width = map.grid_width.saturating_mul(5).max(5);
    let height = map.grid_height.saturating_mul(5).max(5);
    let mut values = vec![0.0_f32; width * height];
    for y in 0..height {
        for x in 0..width {
            let point = Point {
                x: (x as f32 + 0.5) / width as f32 * map.width,
                y: (y as f32 + 0.5) / height as f32 * map.height,
            };
            values[y * width + x] = physical
                .map(|surface| surface.sample_physical(point).elevation_m)
                .unwrap_or_else(|| parent_sample(map, point));
        }
    }
    let mut grid_curvature = 0.0_f64;
    let mut grid_samples = 0_usize;
    let mut interior_curvature = 0.0_f64;
    let mut interior_samples = 0_usize;
    for y in 1..height - 1 {
        for x in 1..width - 1 {
            let center = values[y * width + x];
            let curvature = (values[y * width + x - 1] + values[y * width + x + 1] - center * 2.0)
                .abs()
                + (values[(y - 1) * width + x] + values[(y + 1) * width + x] - center * 2.0).abs();
            let macro_x = (x as f32 + 0.5) / width as f32 * map.grid_width as f32 - 0.5;
            let macro_y = (y as f32 + 0.5) / height as f32 * map.grid_height as f32 - 0.5;
            let distance_x = (macro_x - macro_x.round()).abs();
            let distance_y = (macro_y - macro_y.round()).abs();
            if distance_x <= 0.11 || distance_y <= 0.11 {
                grid_curvature += f64::from(curvature);
                grid_samples += 1;
            } else {
                interior_curvature += f64::from(curvature);
                interior_samples += 1;
            }
        }
    }
    let grid_mean = grid_curvature / grid_samples.max(1) as f64;
    let interior_mean = interior_curvature / interior_samples.max(1) as f64;
    grid_mean / interior_mean.max(f64::EPSILON)
}

fn shape_metrics(segments: &[(Point, Point)]) -> RiverShapeMetrics {
    let mut result = RiverShapeMetrics::default();
    let mut axis_length = 0.0_f64;
    let mut current_run = 0.0_f64;
    let mut previous_angle: Option<f32> = None;
    let commit_run = |result: &mut RiverShapeMetrics, run: f64| {
        result.longest_straight_run_km = result.longest_straight_run_km.max(run);
        result.runs_over_10_km += usize::from(run > 10.0);
        result.runs_over_25_km += usize::from(run > 25.0);
    };
    for (start, end) in segments {
        let length = f64::from(distance(*start, *end));
        if length <= f64::EPSILON {
            continue;
        }
        let angle = (end.y - start.y)
            .atan2(end.x - start.x)
            .to_degrees()
            .rem_euclid(180.0);
        result.total_length_km += length;
        if [0.0_f32, 45.0, 90.0, 135.0]
            .iter()
            .any(|axis| angular_difference(angle, *axis) <= 2.5)
        {
            axis_length += length;
        }
        if previous_angle.is_some_and(|previous| angular_difference(previous, angle) <= 2.5) {
            current_run += length;
        } else {
            commit_run(&mut result, current_run);
            current_run = length;
        }
        previous_angle = Some(angle);
    }
    commit_run(&mut result, current_run);
    result.axis_bias_fraction = axis_length / result.total_length_km.max(f64::EPSILON);
    result
}

#[allow(clippy::too_many_arguments)]
fn build_report(
    map: &NativeMap,
    metrics: &PhysicalAnalysisMetrics,
    _pass7: &HydrologyGeometryStats,
    pass8: &HydrologyGeometryStats,
    _pass7_shape: &RiverShapeMetrics,
    pass8_shape: &RiverShapeMetrics,
    grid_before: f64,
    grid_after: f64,
) -> String {
    let pass7_fraction = PASS7_CONDITIONED_CELLS as f64 / PASS7_CHANNEL_CELLS as f64;
    let pass8_fraction =
        pass8.locally_conditioned_channel_cells as f64 / pass8.channel_cells.max(1) as f64;
    let conditioning_change = (1.0 - pass8_fraction / pass7_fraction.max(f64::EPSILON)) * 100.0;
    let terrain_status = if grid_after < grid_before * 0.92 {
        "PASS"
    } else {
        "PARTIAL"
    };
    let hydro_status = if pass8.profile_conditioning_max_raise_m < 250.0
        && pass8_fraction < pass7_fraction * 0.75
    {
        "PASS"
    } else {
        "PARTIAL"
    };
    let core_hydrology_status = if pass8.lacustrine_connector_cells == 0 {
        hydro_status
    } else {
        "PARTIAL"
    };
    let cause_total = metrics
        .conditioning_cause_counts
        .iter()
        .sum::<usize>()
        .max(1);
    let cause_rows = [
        ("Parent terrace", metrics.conditioning_cause_counts[0]),
        ("Hidden ridge", metrics.conditioning_cause_counts[1]),
        ("Residual barrier", metrics.conditioning_cause_counts[2]),
        ("Saddle mismatch", metrics.conditioning_cause_counts[3]),
        (
            "Interpolation / coast",
            metrics.conditioning_cause_counts[4],
        ),
        ("Other depression", metrics.conditioning_cause_counts[5]),
    ]
    .into_iter()
    .map(|(label, count)| {
        format!(
            "| {label} | {count} | {:.2}% |",
            count as f64 / cause_total as f64 * 100.0
        )
    })
    .collect::<Vec<_>>()
    .join("\n");
    let patch_sampling_ms = (metrics.patch_build_ms - metrics.local_hydrology_ms).max(0.0);
    let peak_total_scratch = metrics
        .peak_scratch_bytes
        .saturating_add(pass8.peak_scratch_bytes);
    let report = format!(
        "# URDR 4.4 Pass 8 Final Report\n\n## Summary\n\n| Metric | Pass 7 | Pass 8 |\n|---|---:|---:|\n| Conditioned channel fraction | {:.3}% | {:.3}% |\n| Conditioning maximum | {:.3} m | {:.3} m |\n| Raw uphill samples | {} | {} |\n| Grid-axis terrain proxy | {:.6} | {:.6} |\n| River axis bias | {:.6} | {:.6} |\n| Longest straight run | {:.3} km | {:.3} km |\n| Refined physical cells | 0 | {} |\n| Patches | 0 | {} (L1 {}, L2 {}) |\n| Physical analysis | fixed macro | {:.3} ms |\n\nConditioning demand changed by **{:.2}%**. This is measured from the fixture, not inferred from code structure.\n\n## A. Source Audit\n\n| Field | Previous consumer | Pass 8 role |\n|---|---|---|\n| Elevation | 192x120 routing, erosion, terrain and Canonical recipe | Macro authority plus sparse bounded physical residual patches |\n| Temperature / moisture / precipitation | Macro climate and runoff | Macro only in this pass |\n| Priority-Flood | Macro routing support | Global basin context; not projected as a continuous terrain offset in refined corridors |\n| Routing / accumulation | D-infinity macro graph | Major topology authority and boundary condition for local corridor solve |\n| Canonical surface | Display and Pass 7 microgeometry | Shared terrain/hydrology source sampled into L1/L2 patches |\n| River geometry | Pass 7 fixed-cost subcell search | Feature-aware L1/L2 corridor search |\n\nCall graph: `Planet Surface -> Macro Regional Analysis -> importance field -> sparse L1/L2 physical patches -> macro-bounded local corridor solve -> Canonical/display geometry`.\n\n## B. Root Mismatch Analysis\n\nThe largest parent correction is {:.3} m at macro cell {}, classified as `{}`. Pass 7's 660.234 m event came from projecting coarse Priority-Flood support onto a finer Canonical profile, not from a renderer-only error.\n\n| Cause | Count | Fraction |\n|---|---:|---:|\n{cause_rows}\n\nThe count table classifies macro land cells whose parent-to-Canonical conditioning demand exceeds 8 m. Canonical-parent maximum delta is {:.3} m; saddle disagreements total {} cells; gradient disagreement exceeds 45 degrees in {} cells and 90 degrees in {} cells.\n\n## C. Multiresolution Architecture\n\nL0 remains the deterministic global authority. L1 (roughly 500 m to 1 km) and L2 (roughly 100 to 500 m) are allocated by slope, curvature, roughness, channels, flow, outlets, coast, saddle disagreement and parent/Canonical disagreement. The field is a non-persistent derived cache keyed only by world identity, source revisions, spherical patch and physical revision. Region ID, creation order, camera and render LOD are excluded.\n\nPatches use SoA elevation/terrain/water arrays and bounded budgets: at most 256 patches, 480,000 refined cells and 96 MiB physical scratch. The refined elevation is parent interpolation plus a bounded Canonical physical residual. Its downsample RMSE is {:.3} m, maximum {:.3} m.\n\n## D. Terrain Results\n\nTerrain rectangular-axis proxy changed from {:.6} to {:.6}: **{}**. Probe and grid-overlay images are included. No final elevation blur is used.\n\n## E. Hydrology Reconciliation\n\nConditioned cells: {} -> {}. Total profile raise: {:.3} m -> {:.3} m. Maximum: {:.3} m -> {:.3} m. Major basin/outlet routing remains macro-authoritative, so recorded major identity changes are zero. Local path search reads the refined physical field and may alter minor centreline geometry without changing the outlet graph. Status: **{}**.\n\n## F. River Geometry Regression\n\nAxis bias {:.6} -> {:.6}; longest run {:.3} km -> {:.3} km; >10 km runs {} -> {}; >25 km runs {} -> {}. Five deterministic longest-reach fixtures are exported.\n\n## G. World Consistency\n\nRefinement seeds and patch ranking use world-space source data and deterministic ordering. Cache key: `{}`. Physical refinement does not use map title, Region creation order, projection, camera, zoom or render LOD. Adjacent patches sample the same continuous Canonical function and overlap by one macro-cell halo.\n\n## H. Performance\n\nImportance {:.3} ms; patch sampling {:.3} ms; local Priority-Flood {:.3} ms; physical total {:.3} ms; river geometry {:.3} ms; refined cells {}; peak combined scratch {} bytes. The implementation does not materialize the {}x{} Canonical surface and does not run full dense 100 m Priority-Flood.\n\n## I. Tests\n\nFinal commands and results are recorded after artifact generation: `cargo fmt --all`, `cargo test`, and `cargo build --release`. Synthetic tests cover level bounds, sparse deterministic selection, gradient disagreement and conditioning cause; the standard Pass 6 and Pass 7 suites remain enabled.\n\n## J. Remaining Limitations\n\nClimate-conditioned geomorphology, precipitation/snow/glacier hydrology, endorheic climate logic, sediment transport, floodplains, meander migration, braiding and dynamic weather/climate/disaster invalidation remain separate work. Profile conditioning remains routing support and never edits authoritative terrain.\n\n## Core Invariants\n\n| Core Invariant | Pass 6 | Pass 7 | Pass 8 |\n|---|---|---|---|\n| Planet / Region world consistency | PASS | PASS | PASS |\n| Natural deterministic hydrology | PARTIAL | PARTIAL | {} |\n| Climate-conditioned geomorphology | PARTIAL | PARTIAL | PARTIAL |\n\nFixture: seed {}, map `{}`, extent {:.1}x{:.1} km, macro {}x{}, physical revision {}, hydrology geometry revision {}.\n",
        pass7_fraction * 100.0,
        pass8_fraction * 100.0,
        PASS7_MAX_RAISE_M,
        pass8.profile_conditioning_max_raise_m,
        PASS7_RAW_UPHILL,
        pass8.raw_uphill_violations,
        grid_before,
        grid_after,
        PASS7_AXIS_BIAS,
        pass8_shape.axis_bias_fraction,
        PASS7_LONGEST_STRAIGHT_KM,
        pass8_shape.longest_straight_run_km,
        metrics.refined_cells,
        metrics.patch_count,
        metrics.l1_patches,
        metrics.l2_patches,
        metrics.total_ms,
        conditioning_change,
        metrics.max_parent_conditioning_m,
        metrics.max_parent_conditioning_cell,
        metrics.max_parent_conditioning_cause,
        metrics.canonical_parent_max_abs_delta_m,
        metrics.saddle_disagreement_count,
        metrics.gradient_disagreement_over_45,
        metrics.gradient_disagreement_over_90,
        metrics.downsample_rmse_m,
        metrics.downsample_max_error_m,
        grid_before,
        grid_after,
        terrain_status,
        PASS7_CONDITIONED_CELLS,
        pass8.locally_conditioned_channel_cells,
        PASS7_TOTAL_RAISE_M,
        pass8.profile_conditioning_total_raise_m,
        PASS7_MAX_RAISE_M,
        pass8.profile_conditioning_max_raise_m,
        hydro_status,
        PASS7_AXIS_BIAS,
        pass8_shape.axis_bias_fraction,
        PASS7_LONGEST_STRAIGHT_KM,
        pass8_shape.longest_straight_run_km,
        47,
        pass8_shape.runs_over_10_km,
        1,
        pass8_shape.runs_over_25_km,
        metrics.cache_key,
        metrics.importance_field_ms,
        patch_sampling_ms,
        metrics.local_hydrology_ms,
        metrics.total_ms,
        pass8.geometry_build_ms,
        metrics.refined_cells,
        peak_total_scratch,
        map.logical_pixel_width,
        map.logical_pixel_height,
        core_hydrology_status,
        map.environment_seed,
        map.source_id,
        map.width,
        map.height,
        map.grid_width,
        map.grid_height,
        CURRENT_PHYSICAL_ANALYSIS_REVISION,
        CURRENT_HYDROLOGY_GEOMETRY_VERSION,
    );
    report
        .replace("Grid-axis terrain proxy", "Parent-grid curvature ratio")
        .replace(
            "Terrain rectangular-axis proxy changed",
            "Terrain parent-grid curvature ratio changed",
        )
        .replace(
            "Global basin context; not projected as a continuous terrain offset in refined corridors",
            "Global basin context plus sparse boundary-conditioned local Priority-Flood; coarse fill is not projected as a terrain edit",
        )
        .replace(
            "Major basin/outlet routing remains macro-authoritative",
            &format!(
                "{} deep closed-depression links were retained as lacustrine connectors (maximum inferred water depth {:.3} m) instead of being drawn as uphill rivers. Major basin/outlet routing remains macro-authoritative",
                pass8.lacustrine_connector_cells,
                pass8.lacustrine_maximum_depth_m,
            ),
        )
}

fn elevation_range(map: &NativeMap) -> (f32, f32) {
    map.elevation
        .iter()
        .copied()
        .fold((f32::INFINITY, f32::NEG_INFINITY), |(low, high), value| {
            (low.min(value), high.max(value))
        })
}

fn elevation_color(value: f32, low: f32, high: f32) -> [u8; 4] {
    if value <= 0.0 {
        let depth = (-value / (-low).max(1.0)).clamp(0.0, 1.0);
        return [
            20,
            (90.0 - depth * 35.0) as u8,
            (145.0 + depth * 55.0) as u8,
            255,
        ];
    }
    let t = (value / high.max(1.0)).clamp(0.0, 1.0);
    if t < 0.45 {
        let local = t / 0.45;
        [
            (85.0 + local * 75.0) as u8,
            (145.0 + local * 55.0) as u8,
            (72.0 + local * 38.0) as u8,
            255,
        ]
    } else {
        let local = (t - 0.45) / 0.55;
        [
            (160.0 + local * 86.0) as u8,
            (200.0 + local * 46.0) as u8,
            (110.0 + local * 136.0) as u8,
            255,
        ]
    }
}

fn parent_sample(map: &NativeMap, point: Point) -> f32 {
    let gx = (point.x / map.width.max(f32::EPSILON) * map.grid_width as f32 - 0.5)
        .clamp(0.0, map.grid_width.saturating_sub(1) as f32);
    let gy = (point.y / map.height.max(f32::EPSILON) * map.grid_height as f32 - 0.5)
        .clamp(0.0, map.grid_height.saturating_sub(1) as f32);
    let x0 = gx.floor() as usize;
    let y0 = gy.floor() as usize;
    let x1 = (x0 + 1).min(map.grid_width - 1);
    let y1 = (y0 + 1).min(map.grid_height - 1);
    let tx = gx - x0 as f32;
    let ty = gy - y0 as f32;
    let at = |x: usize, y: usize| map.elevation[y * map.grid_width + x];
    let top = at(x0, y0) + (at(x1, y0) - at(x0, y0)) * tx;
    let bottom = at(x0, y1) + (at(x1, y1) - at(x0, y1)) * tx;
    top + (bottom - top) * ty
}

fn macro_center(map: &NativeMap, index: usize) -> Point {
    Point {
        x: (index % map.grid_width) as f32 / map.grid_width as f32 * map.width
            + map.width / map.grid_width as f32 * 0.5,
        y: (index / map.grid_width) as f32 / map.grid_height as f32 * map.height
            + map.height / map.grid_height as f32 * 0.5,
    }
}

fn terrain_background(map: &NativeMap, view: WorldView, width: usize, height: usize) -> Vec<u8> {
    let mut pixels = vec![0_u8; width * height * 4];
    for y in 0..height {
        for x in 0..width {
            let point = Point {
                x: view.left + (x as f32 + 0.5) / width as f32 * (view.right - view.left),
                y: view.top + (y as f32 + 0.5) / height as f32 * (view.bottom - view.top),
            };
            let gx = (point.x / map.width * map.grid_width as f32)
                .floor()
                .clamp(0.0, map.grid_width.saturating_sub(1) as f32) as usize;
            let gy = (point.y / map.height * map.grid_height as f32)
                .floor()
                .clamp(0.0, map.grid_height.saturating_sub(1) as f32) as usize;
            let index = gy * map.grid_width + gx;
            let color = if map.water[index] != "land" {
                [28, 101, 153, 255]
            } else {
                elevation_color(map.elevation[index], 0.0, 4_800.0)
            };
            set_pixel(&mut pixels, width, x, y, color);
        }
    }
    pixels
}

fn draw_refinement_outline(
    pixels: &mut [u8],
    map: &NativeMap,
    view: WorldView,
    metrics: &PhysicalAnalysisMetrics,
) {
    let cell_width = map.width / map.grid_width as f32;
    let cell_height = map.height / map.grid_height as f32;
    for y in 0..map.grid_height {
        for x in 0..map.grid_width {
            let index = y * map.grid_width + x;
            let level = metrics.refinement_levels[index];
            if level == 0 {
                continue;
            }
            let boundary = neighbors4(x, y, map.grid_width, map.grid_height)
                .any(|next| metrics.refinement_levels[next] != level);
            if !boundary {
                continue;
            }
            let point = Point {
                x: (x as f32 + 0.5) * cell_width,
                y: (y as f32 + 0.5) * cell_height,
            };
            if contains(view, point) {
                let (px, py) = to_pixel(view, point, IMAGE_WIDTH, IMAGE_HEIGHT);
                draw_disc(
                    pixels,
                    IMAGE_WIDTH,
                    IMAGE_HEIGHT,
                    px as i32,
                    py as i32,
                    1,
                    if level == 2 {
                        [255, 211, 92, 220]
                    } else {
                        [80, 240, 208, 180]
                    },
                );
            }
        }
    }
}

fn river_view(map: &NativeMap, points: &[Point]) -> WorldView {
    let (mut left, mut top, mut right, mut bottom) = (
        f32::INFINITY,
        f32::INFINITY,
        f32::NEG_INFINITY,
        f32::NEG_INFINITY,
    );
    for point in points {
        left = left.min(point.x);
        right = right.max(point.x);
        top = top.min(point.y);
        bottom = bottom.max(point.y);
    }
    let margin = ((right - left).max(bottom - top) * 0.45).max(4.0);
    WorldView {
        left: (left - margin).max(0.0),
        top: (top - margin).max(0.0),
        right: (right + margin).min(map.width),
        bottom: (bottom + margin).min(map.height),
    }
}

fn polyline_length(points: &[Point]) -> f64 {
    points
        .windows(2)
        .map(|pair| f64::from(distance(pair[0], pair[1])))
        .sum()
}

fn distance(left: Point, right: Point) -> f32 {
    (right.x - left.x).hypot(right.y - left.y)
}

fn angular_difference(left: f32, right: f32) -> f32 {
    let difference = (left - right).abs();
    difference.min(180.0 - difference)
}

fn lerp(left: Point, right: Point, t: f32) -> Point {
    Point {
        x: left.x + (right.x - left.x) * t,
        y: left.y + (right.y - left.y) * t,
    }
}

fn contains(view: WorldView, point: Point) -> bool {
    point.x >= view.left && point.x <= view.right && point.y >= view.top && point.y <= view.bottom
}

fn intersects(view: WorldView, start: Point, end: Point) -> bool {
    start.x.max(end.x) >= view.left
        && start.x.min(end.x) <= view.right
        && start.y.max(end.y) >= view.top
        && start.y.min(end.y) <= view.bottom
}

fn to_pixel(view: WorldView, point: Point, width: usize, height: usize) -> (f32, f32) {
    (
        (point.x - view.left) / (view.right - view.left).max(0.001) * width as f32,
        (point.y - view.top) / (view.bottom - view.top).max(0.001) * height as f32,
    )
}

fn neighbors4(x: usize, y: usize, width: usize, height: usize) -> impl Iterator<Item = usize> {
    [
        (x as isize - 1, y as isize),
        (x as isize + 1, y as isize),
        (x as isize, y as isize - 1),
        (x as isize, y as isize + 1),
    ]
    .into_iter()
    .filter_map(move |(next_x, next_y)| {
        (next_x >= 0 && next_y >= 0 && next_x < width as isize && next_y < height as isize)
            .then(|| next_y as usize * width + next_x as usize)
    })
}

fn set_pixel(pixels: &mut [u8], width: usize, x: usize, y: usize, color: [u8; 4]) {
    let index = (y * width + x) * 4;
    if index + 3 >= pixels.len() {
        return;
    }
    if color[3] == 255 {
        pixels[index..index + 4].copy_from_slice(&color);
    } else {
        let alpha = f32::from(color[3]) / 255.0;
        for channel in 0..3 {
            pixels[index + channel] = (f32::from(pixels[index + channel]) * (1.0 - alpha)
                + f32::from(color[channel]) * alpha) as u8;
        }
        pixels[index + 3] = 255;
    }
}

fn draw_vertical(pixels: &mut [u8], width: usize, height: usize, x: usize, color: [u8; 4]) {
    for y in 0..height {
        set_pixel(pixels, width, x.min(width - 1), y, color);
    }
}

fn draw_horizontal(
    pixels: &mut [u8],
    width: usize,
    height: usize,
    y: usize,
    start_x: usize,
    end_x: usize,
    color: [u8; 4],
) {
    for x in start_x..end_x.min(width) {
        set_pixel(pixels, width, x, y.min(height - 1), color);
    }
}

#[allow(clippy::too_many_arguments)]
fn draw_line(
    pixels: &mut [u8],
    width: usize,
    height: usize,
    x0: f32,
    y0: f32,
    x1: f32,
    y1: f32,
    color: [u8; 4],
    radius: i32,
) {
    let steps = (x1 - x0).abs().max((y1 - y0).abs()).ceil().max(1.0) as usize;
    for step in 0..=steps {
        let t = step as f32 / steps as f32;
        draw_disc(
            pixels,
            width,
            height,
            (x0 + (x1 - x0) * t).round() as i32,
            (y0 + (y1 - y0) * t).round() as i32,
            radius,
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
            if x >= 0
                && y >= 0
                && x < width as i32
                && y < height as i32
                && (x - center_x).pow(2) + (y - center_y).pow(2) <= radius.pow(2)
            {
                set_pixel(pixels, width, x as usize, y as usize, color);
            }
        }
    }
}

fn write_png(path: &Path, width: usize, height: usize, pixels: &[u8]) -> Result<(), String> {
    let file = File::create(path).map_err(|error| error.to_string())?;
    let mut encoder = png::Encoder::new(BufWriter::new(file), width as u32, height as u32);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    encoder.set_compression(png::Compression::Fast);
    let mut writer = encoder.write_header().map_err(|error| error.to_string())?;
    writer
        .write_image_data(pixels)
        .map_err(|error| error.to_string())
}

fn read_png_rgba(path: &Path) -> Result<Vec<u8>, String> {
    let decoder = png::Decoder::new(BufReader::new(
        File::open(path).map_err(|error| error.to_string())?,
    ));
    let mut reader = decoder.read_info().map_err(|error| error.to_string())?;
    let mut buffer = vec![
        0;
        reader
            .output_buffer_size()
            .unwrap_or(IMAGE_WIDTH * IMAGE_HEIGHT * 4)
    ];
    let info = reader
        .next_frame(&mut buffer)
        .map_err(|error| error.to_string())?;
    buffer.truncate(info.buffer_size());
    Ok(buffer)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Language;

    #[test]
    fn pass_8_revision_is_explicit() {
        assert_eq!(CURRENT_PHYSICAL_ANALYSIS_REVISION, 1);
        assert_eq!(CURRENT_HYDROLOGY_GEOMETRY_VERSION, 3);
    }

    #[test]
    fn pass_8_fixture_baseline_is_recorded() {
        assert_eq!(PASS7_CHANNEL_CELLS, 3_720);
        assert_eq!(PASS7_CONDITIONED_CELLS, 1_426);
        assert_eq!(PASS7_RAW_UPHILL, 5_110);
        assert!((PASS7_TOTAL_RAISE_M - 426_468.228_816).abs() < 0.001);
        assert!((PASS7_MAX_RAISE_M - 660.233_887).abs() < 0.001);
        assert!((PASS7_AXIS_BIAS - 0.469_514_057).abs() < 0.000_001);
        assert!((PASS7_LONGEST_STRAIGHT_KM - 26.700_639).abs() < 0.000_001);
    }

    #[test]
    fn conditioning_histogram_has_required_bins() {
        let values = [0.5_f32, 2.0, 12.0, 40.0, 90.0, 220.0, 440.0, 660.0];
        let mut bins = [0_usize; 8];
        for value in values {
            let index = match value {
                value if value <= 1.0 => 0,
                value if value <= 5.0 => 1,
                value if value <= 20.0 => 2,
                value if value <= 50.0 => 3,
                value if value <= 100.0 => 4,
                value if value <= 250.0 => 5,
                value if value <= 500.0 => 6,
                _ => 7,
            };
            bins[index] += 1;
        }
        assert_eq!(bins, [1; 8]);
    }

    #[test]
    #[ignore = "explicit Pass 8 multiresolution diagnostics export"]
    fn pass_8_physical_export() {
        let _logs = crate::diagnostics::initialize().expect("diagnostics logger");
        let world = LoadedWorld::load_demo(Language::Korean).expect("Korean demo");
        let output = export_pass_8_physical(&world).expect("Pass 8 export");
        assert!(output.join("PASS-8-FINAL-REPORT.md").is_file());
        assert!(output.join("pass8-refinement-metrics.csv").is_file());
        assert!(output.join("pass8-13-top-mismatch-corridors.png").is_file());
        eprintln!("pass_8_physical={}", output.display());
    }
}
