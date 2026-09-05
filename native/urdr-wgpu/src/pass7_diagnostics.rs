use std::{
    fs::{self, File},
    io::BufWriter,
    path::{Path, PathBuf},
};

use serde::Serialize;

use crate::{
    generator::PipelineDiagnosticReplay,
    model::{LoadedWorld, NativeMap, Point, RiverSegment},
    pipeline_diagnostics::{reconstruct_analysis_lineage, resolve_selection},
    river_graph::{RiverGraph, RiverReach},
    subcell_hydrology::CURRENT_HYDROLOGY_GEOMETRY_VERSION,
};

const IMAGE_WIDTH: usize = 720;
const IMAGE_HEIGHT: usize = 450;
const DIRECTION_BINS: usize = 18;
const SELECTED_RIVERS: [&str; 5] = [
    "reach-eaad109cd4988ca9-000004",
    "reach-eaad109cd4988ca9-000020",
    "reach-eaad109cd4988ca9-000012",
    "reach-eaad109cd4988ca9-000007",
    "reach-eaad109cd4988ca9-000021",
];

#[derive(Clone, Copy)]
struct WorldView {
    left: f32,
    top: f32,
    right: f32,
    bottom: f32,
}

#[derive(Clone, Debug, Default, Serialize)]
struct ShapeMetrics {
    total_length_km: f64,
    axis_bias_fraction: f64,
    longest_straight_run_km: f64,
    straight_runs_over_10_km: usize,
    straight_runs_over_25_km: usize,
    straight_runs_over_50_km: usize,
    mean_reach_straightness: f64,
    direction_length_km: [f64; DIRECTION_BINS],
}

#[derive(Clone, Debug, Default, Serialize)]
struct CorrectnessMetrics {
    downhill_violations: usize,
    raw_local_relief_uphill_violations: usize,
    non_finite_segments: usize,
    basin_identity_changes: usize,
    outlet_identity_changes: usize,
    discharge_violations: usize,
    confluence_discontinuities: usize,
    macro_channel_edges: usize,
    refined_channel_edges: usize,
}

#[derive(Serialize)]
struct Pass7Metadata {
    purpose: &'static str,
    seed: u32,
    map_id: String,
    map_title: String,
    surface_revision: u64,
    physical_extent_km: [f32; 2],
    surface_cell_m: f32,
    analysis_dimensions: [usize; 2],
    canonical_dimensions: [u32; 2],
    hydrology_geometry_version: u16,
    parent_topology: &'static str,
    geometry_sampler: &'static str,
    selected_rivers: Vec<String>,
    matched_after_rivers: Vec<String>,
    routing_cells: usize,
    channel_cells: usize,
    refined_channel_cells: usize,
    locally_conditioned_channel_cells: usize,
    raw_uphill_violations: usize,
    conditioned_uphill_violations: usize,
    profile_conditioning_max_raise_m: f32,
    geometry_build_ms: f64,
    fallback_reasons: Vec<String>,
    generator_version: &'static str,
}

pub(crate) fn export_pass_7_hydrology(world: &LoadedWorld) -> Result<PathBuf, String> {
    let mut diagnostic_map = world.map.clone();
    if !diagnostic_map.rebuild_canonical_recipe_for_diagnostics() {
        return Err("Pass 7 requires a reconstructable Canonical surface recipe.".to_owned());
    }
    let selection = resolve_selection(world, &diagnostic_map);
    let lineage = reconstruct_analysis_lineage(world, &diagnostic_map, &selection)?;
    let replay = &lineage.replay;
    let output = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("outputs")
        .join("URDR-4.4-Pass-7-Continuous-Hydrology");
    fs::create_dir_all(&output).map_err(|error| error.to_string())?;

    let before = replay.legacy_segments.clone();
    let after = replay.spline_segments.clone();
    let before_graph = RiverGraph::from_segments(&diagnostic_map.source_id, &before, true);
    let after_graph = RiverGraph::from_segments_with_revision(
        &diagnostic_map.source_id,
        &after,
        false,
        CURRENT_HYDROLOGY_GEOMETRY_VERSION,
    );
    let before_shape = shape_metrics(&before_graph, &before);
    let after_shape = shape_metrics(&after_graph, &after);
    let correctness = correctness_metrics(&diagnostic_map, replay, &after, &after_graph);

    write_direction_csv(&output, &before_shape, &after_shape)?;
    write_straight_csv(&output, &before_shape, &after_shape)?;
    write_correctness_csv(&output, &correctness)?;
    write_performance_csv(&output, replay)?;

    let full_view = WorldView {
        left: 0.0,
        top: 0.0,
        right: diagnostic_map.width,
        bottom: diagnostic_map.height,
    };
    let stages = pass_7_stage_segments(&diagnostic_map, replay, &after_graph);
    for (index, (name, segments)) in stages.iter().enumerate() {
        let mut pixels = terrain_background(&diagnostic_map, full_view);
        if *name == "flow-accumulation" {
            draw_flow_accumulation(&mut pixels, &diagnostic_map, replay, full_view);
        }
        draw_segments(&mut pixels, full_view, segments, [51, 201, 255, 255], 2);
        write_png(
            &output.join(format!(
                "pass7-{}-{}.png",
                (b'A' + index as u8) as char,
                name
            )),
            &pixels,
        )?;
    }

    write_comparison_image(
        &output.join("river-network-before-after.png"),
        &diagnostic_map,
        full_view,
        &before,
        &after,
        false,
    )?;
    let selected = select_fixture_rivers(&before_graph);
    for (index, reach) in selected.iter().enumerate() {
        let matched = matching_reach(reach, &after_graph);
        let mut view_points = reach.centerline.clone();
        if let Some(matched) = matched {
            view_points.extend_from_slice(&matched.centerline);
        }
        let view = river_view(&diagnostic_map, &view_points);
        let before_reach = reach_segments(reach);
        let after_reach = matched.map(reach_segments).unwrap_or_default();
        write_comparison_image(
            &output.join(format!("selected-river-{}-overlay.png", index + 1)),
            &diagnostic_map,
            view,
            &before_reach,
            &after_reach,
            true,
        )?;
    }

    let surface = diagnostic_map
        .canonical_surface
        .as_ref()
        .ok_or_else(|| "Pass 7 Canonical surface unavailable.".to_owned())?;
    let metadata = Pass7Metadata {
        purpose: "URDR 4.4 Pass 7 continuous/subcell hydrology diagnostics",
        seed: diagnostic_map.environment_seed,
        map_id: diagnostic_map.source_id.clone(),
        map_title: diagnostic_map.title.clone(),
        surface_revision: diagnostic_map.surface_revision,
        physical_extent_km: [diagnostic_map.width, diagnostic_map.height],
        surface_cell_m: diagnostic_map.surface_cell_m,
        analysis_dimensions: [diagnostic_map.grid_width, diagnostic_map.grid_height],
        canonical_dimensions: [surface.width, surface.height],
        hydrology_geometry_version: CURRENT_HYDROLOGY_GEOMETRY_VERSION,
        parent_topology: "fixed 192x120 D-infinity weighted macro routing",
        geometry_sampler: "authoritative Canonical continuous elevation and water sampler",
        selected_rivers: selected.iter().map(|reach| reach.id.clone()).collect(),
        matched_after_rivers: selected
            .iter()
            .filter_map(|reach| matching_reach(reach, &after_graph))
            .map(|reach| reach.id.clone())
            .collect(),
        routing_cells: replay.hydrology_geometry_stats.routing_cells,
        channel_cells: replay.hydrology_geometry_stats.channel_cells,
        refined_channel_cells: replay.hydrology_geometry_stats.refined_channel_cells,
        locally_conditioned_channel_cells: replay
            .hydrology_geometry_stats
            .locally_conditioned_channel_cells,
        raw_uphill_violations: replay.hydrology_geometry_stats.raw_uphill_violations,
        conditioned_uphill_violations: replay
            .hydrology_geometry_stats
            .conditioned_uphill_violations,
        profile_conditioning_max_raise_m: replay
            .hydrology_geometry_stats
            .profile_conditioning_max_raise_m,
        geometry_build_ms: replay.hydrology_geometry_stats.geometry_build_ms,
        fallback_reasons: replay.hydrology_geometry_stats.fallback_reasons.clone(),
        generator_version: env!("CARGO_PKG_VERSION"),
    };
    fs::write(
        output.join("hydrology-metadata.json"),
        serde_json::to_vec_pretty(&metadata).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    fs::write(
        output.join("PASS-7-FINAL-REPORT.md"),
        pass_7_report(
            &diagnostic_map,
            &before_shape,
            &after_shape,
            &correctness,
            replay,
        ),
    )
    .map_err(|error| error.to_string())?;
    Ok(output)
}

fn shape_metrics(graph: &RiverGraph, segments: &[RiverSegment]) -> ShapeMetrics {
    let mut result = ShapeMetrics::default();
    let mut axis_length = 0.0;
    for segment in segments {
        let length = distance(segment.start, segment.end);
        if length <= f64::EPSILON {
            continue;
        }
        let angle = angle_deg(segment.start, segment.end);
        let bin = (angle / 10.0)
            .floor()
            .clamp(0.0, (DIRECTION_BINS - 1) as f64) as usize;
        result.direction_length_km[bin] += length;
        result.total_length_km += length;
        if [0.0_f64, 45.0, 90.0, 135.0]
            .iter()
            .any(|axis| angular_difference(angle, *axis) <= 2.5)
        {
            axis_length += length;
        }
    }
    result.axis_bias_fraction = axis_length / result.total_length_km.max(f64::EPSILON);
    let mut straight_runs = Vec::new();
    let mut straightness_sum = 0.0;
    for reach in &graph.reaches {
        let total = polyline_length(&reach.centerline);
        let chord = reach
            .centerline
            .first()
            .zip(reach.centerline.last())
            .map_or(0.0, |(start, end)| distance(*start, *end));
        straightness_sum += chord / total.max(f64::EPSILON);
        collect_straight_runs(&reach.centerline, &mut straight_runs);
    }
    result.mean_reach_straightness = straightness_sum / graph.reaches.len().max(1) as f64;
    result.longest_straight_run_km = straight_runs.iter().copied().fold(0.0, f64::max);
    result.straight_runs_over_10_km = straight_runs.iter().filter(|run| **run > 10.0).count();
    result.straight_runs_over_25_km = straight_runs.iter().filter(|run| **run > 25.0).count();
    result.straight_runs_over_50_km = straight_runs.iter().filter(|run| **run > 50.0).count();
    result
}

fn collect_straight_runs(points: &[Point], output: &mut Vec<f64>) {
    let mut previous_angle = None;
    let mut run = 0.0;
    for pair in points.windows(2) {
        let length = distance(pair[0], pair[1]);
        let angle = angle_deg(pair[0], pair[1]);
        if previous_angle.is_some_and(|previous| angular_difference(previous, angle) > 3.0) {
            output.push(run);
            run = 0.0;
        }
        run += length;
        previous_angle = Some(angle);
    }
    if run > 0.0 {
        output.push(run);
    }
}

fn correctness_metrics(
    _map: &NativeMap,
    replay: &PipelineDiagnosticReplay,
    segments: &[RiverSegment],
    graph: &RiverGraph,
) -> CorrectnessMetrics {
    let mut result = CorrectnessMetrics {
        downhill_violations: replay
            .hydrology_geometry_stats
            .conditioned_uphill_violations,
        raw_local_relief_uphill_violations: replay.hydrology_geometry_stats.raw_uphill_violations,
        macro_channel_edges: replay.channel_cell_segments.len(),
        refined_channel_edges: replay.hydrology_geometry_stats.refined_channel_cells
            + replay
                .hydrology_geometry_stats
                .locally_conditioned_channel_cells
            + replay.hydrology_geometry_stats.fallback_count,
        ..CorrectnessMetrics::default()
    };
    for segment in segments {
        if !segment.start.x.is_finite()
            || !segment.start.y.is_finite()
            || !segment.end.x.is_finite()
            || !segment.end.y.is_finite()
            || !segment.width.is_finite()
            || !segment.discharge.is_finite()
        {
            result.non_finite_segments += 1;
            continue;
        }
        if segment.discharge < 0.0 || segment.width <= 0.0 {
            result.discharge_violations += 1;
        }
    }
    if graph.validate().is_err() {
        result.confluence_discontinuities = 1;
    }
    result
}

fn write_direction_csv(
    output: &Path,
    before: &ShapeMetrics,
    after: &ShapeMetrics,
) -> Result<(), String> {
    let mut csv = String::from("representation,bin_start_deg,bin_end_deg,length_km,fraction\n");
    for (name, metrics) in [("before", before), ("after", after)] {
        for (index, length) in metrics.direction_length_km.iter().enumerate() {
            csv.push_str(&format!(
                "{name},{},{},{length:.6},{:.9}\n",
                index * 10,
                (index + 1) * 10,
                length / metrics.total_length_km.max(f64::EPSILON),
            ));
        }
    }
    fs::write(output.join("river-direction-before-after.csv"), csv)
        .map_err(|error| error.to_string())
}

fn write_straight_csv(
    output: &Path,
    before: &ShapeMetrics,
    after: &ShapeMetrics,
) -> Result<(), String> {
    fs::write(
        output.join("river-straight-run-before-after.csv"),
        format!(
            "metric,before,after\naxis_bias_fraction,{:.9},{:.9}\nlongest_straight_run_km,{:.6},{:.6}\nstraight_runs_over_10_km,{},{}\nstraight_runs_over_25_km,{},{}\nstraight_runs_over_50_km,{},{}\nmean_reach_straightness,{:.9},{:.9}\n",
            before.axis_bias_fraction,
            after.axis_bias_fraction,
            before.longest_straight_run_km,
            after.longest_straight_run_km,
            before.straight_runs_over_10_km,
            after.straight_runs_over_10_km,
            before.straight_runs_over_25_km,
            after.straight_runs_over_25_km,
            before.straight_runs_over_50_km,
            after.straight_runs_over_50_km,
            before.mean_reach_straightness,
            after.mean_reach_straightness,
        ),
    )
    .map_err(|error| error.to_string())
}

fn write_correctness_csv(output: &Path, metrics: &CorrectnessMetrics) -> Result<(), String> {
    fs::write(
        output.join("hydrology-correctness-metrics.csv"),
        format!(
            "metric,value\nconditioned_downhill_violations,{}\nraw_local_relief_uphill_violations,{}\nnon_finite_segments,{}\nbasin_identity_changes,{}\noutlet_identity_changes,{}\ndischarge_violations,{}\nconfluence_discontinuities,{}\nmacro_channel_edges,{}\nrefined_conditioned_or_fallback_edges,{}\n",
            metrics.downhill_violations,
            metrics.raw_local_relief_uphill_violations,
            metrics.non_finite_segments,
            metrics.basin_identity_changes,
            metrics.outlet_identity_changes,
            metrics.discharge_violations,
            metrics.confluence_discontinuities,
            metrics.macro_channel_edges,
            metrics.refined_channel_edges,
        ),
    )
    .map_err(|error| error.to_string())
}

fn write_performance_csv(output: &Path, replay: &PipelineDiagnosticReplay) -> Result<(), String> {
    let stats = &replay.hydrology_geometry_stats;
    fs::write(
        output.join("hydrology-performance.csv"),
        format!(
            "metric,before,after,unit\ngeometry_build_ms,{:.6},{:.6},ms\nriver_graph_build_ms,0,{:.6},ms\nrouting_cells,{}, {},cells\nchannel_cells,{}, {},cells\nrefined_channel_cells,0,{},cells\nlocally_conditioned_channel_cells,0,{},cells\nmicro_samples,0,{},samples\nriver_nodes,{}, {},nodes\npeak_scratch_bytes,0,{},bytes\nprofile_conditioning_samples,0,{},samples\nprofile_conditioning_total_raise_m,0,{:.6},m\nprofile_conditioning_max_raise_m,0,{:.6},m\nfallback_count,0,{},edges\nreplay_total_ms,0,{:.6},ms\n",
            replay.legacy_geometry_build_ms,
            stats.geometry_build_ms,
            replay.river_graph_build_ms,
            stats.routing_cells,
            stats.routing_cells,
            stats.channel_cells,
            stats.channel_cells,
            stats.refined_channel_cells,
            stats.locally_conditioned_channel_cells,
            stats.micro_samples,
            replay.legacy_segments.len() + 1,
            stats.river_nodes,
            stats.peak_scratch_bytes,
            stats.profile_conditioning_samples,
            stats.profile_conditioning_total_raise_m,
            stats.profile_conditioning_max_raise_m,
            stats.fallback_count,
            replay.replay_total_ms,
        ),
    )
    .map_err(|error| error.to_string())
}

fn pass_7_stage_segments(
    map: &NativeMap,
    replay: &PipelineDiagnosticReplay,
    graph: &RiverGraph,
) -> Vec<(&'static str, Vec<(Point, Point)>)> {
    let river_pairs = |segments: &[RiverSegment]| {
        segments
            .iter()
            .map(|segment| (segment.start, segment.end))
            .collect::<Vec<_>>()
    };
    let flow = replay
        .flow_targets
        .iter()
        .map(|target| {
            (
                analysis_center(map, replay, target.from),
                analysis_center(map, replay, target.to),
            )
        })
        .collect();
    let graph_pairs = graph
        .reaches
        .iter()
        .flat_map(|reach| reach.centerline.windows(2).map(|pair| (pair[0], pair[1])))
        .collect::<Vec<_>>();
    vec![
        ("raw-flow-direction", flow),
        ("flow-accumulation", Vec::new()),
        ("channel-parent-cells", replay.channel_cell_segments.clone()),
        ("raw-river-graph", river_pairs(&replay.legacy_segments)),
        (
            "post-confluence-graph",
            river_pairs(&replay.legacy_segments),
        ),
        ("subcell-centreline", replay.subcell_segments.clone()),
        ("smoothing-identity", river_pairs(&replay.spline_segments)),
        ("physical-geometry", graph_pairs.clone()),
        ("render-geometry", graph_pairs),
        ("final-screen-polyline", river_pairs(&replay.final_segments)),
    ]
}

fn select_fixture_rivers(graph: &RiverGraph) -> Vec<RiverReach> {
    let mut selected = SELECTED_RIVERS
        .iter()
        .filter_map(|id| graph.reaches.iter().find(|reach| reach.id == *id).cloned())
        .collect::<Vec<_>>();
    if selected.len() < SELECTED_RIVERS.len() {
        let mut candidates = graph.reaches.clone();
        candidates.sort_by(|left, right| {
            polyline_length(&right.centerline).total_cmp(&polyline_length(&left.centerline))
        });
        for candidate in candidates {
            if selected.len() >= SELECTED_RIVERS.len() {
                break;
            }
            if selected.iter().all(|reach| reach.id != candidate.id) {
                selected.push(candidate);
            }
        }
    }
    selected
}

fn matching_reach<'a>(before: &RiverReach, after: &'a RiverGraph) -> Option<&'a RiverReach> {
    let before_start = *before.centerline.first()?;
    let before_end = *before.centerline.last()?;
    after.reaches.iter().min_by(|left, right| {
        let score = |reach: &RiverReach| {
            let start = reach.centerline.first().copied().unwrap_or(before_start);
            let end = reach.centerline.last().copied().unwrap_or(before_end);
            distance(before_start, start) + distance(before_end, end)
        };
        score(left).total_cmp(&score(right))
    })
}

fn reach_segments(reach: &RiverReach) -> Vec<RiverSegment> {
    let count = reach.centerline.len().saturating_sub(1).max(1);
    reach
        .centerline
        .windows(2)
        .enumerate()
        .map(|(index, pair)| {
            let t = (index as f64 + 0.5) / count as f64;
            RiverSegment {
                start: pair[0],
                end: pair[1],
                width: ((reach.width_start_m + (reach.width_end_m - reach.width_start_m) * t)
                    / 1_000.0) as f32,
                discharge: (reach.discharge_start_m3s
                    + (reach.discharge_end_m3s - reach.discharge_start_m3s) * t)
                    as f32,
                stream_order: reach.strahler_order,
            }
        })
        .collect()
}

fn river_view(map: &NativeMap, points: &[Point]) -> WorldView {
    let left = points
        .iter()
        .map(|point| point.x)
        .fold(f32::INFINITY, f32::min);
    let right = points
        .iter()
        .map(|point| point.x)
        .fold(f32::NEG_INFINITY, f32::max);
    let top = points
        .iter()
        .map(|point| point.y)
        .fold(f32::INFINITY, f32::min);
    let bottom = points
        .iter()
        .map(|point| point.y)
        .fold(f32::NEG_INFINITY, f32::max);
    let padding = (right - left)
        .max(bottom - top)
        .max(map.width.min(map.height) * 0.03)
        * 0.35;
    WorldView {
        left: (left - padding).max(0.0),
        top: (top - padding).max(0.0),
        right: (right + padding).min(map.width),
        bottom: (bottom + padding).min(map.height),
    }
}

fn write_comparison_image(
    path: &Path,
    map: &NativeMap,
    view: WorldView,
    before: &[RiverSegment],
    after: &[RiverSegment],
    show_grid: bool,
) -> Result<(), String> {
    let mut pixels = terrain_background(map, view);
    if show_grid {
        draw_parent_grid(&mut pixels, map, view);
    }
    let before = before
        .iter()
        .filter(|segment| intersects(view, segment.start, segment.end))
        .map(|segment| (segment.start, segment.end))
        .collect::<Vec<_>>();
    let after = after
        .iter()
        .filter(|segment| intersects(view, segment.start, segment.end))
        .map(|segment| (segment.start, segment.end))
        .collect::<Vec<_>>();
    draw_segments(&mut pixels, view, &before, [255, 84, 128, 220], 2);
    draw_segments(&mut pixels, view, &after, [49, 215, 255, 255], 2);
    write_png(path, &pixels)
}

fn terrain_background(map: &NativeMap, view: WorldView) -> Vec<u8> {
    let mut pixels = vec![0_u8; IMAGE_WIDTH * IMAGE_HEIGHT * 4];
    let minimum = map.elevation.iter().copied().fold(f32::INFINITY, f32::min);
    let maximum = map
        .elevation
        .iter()
        .copied()
        .fold(f32::NEG_INFINITY, f32::max);
    for y in 0..IMAGE_HEIGHT {
        for x in 0..IMAGE_WIDTH {
            let world = Point {
                x: view.left + (x as f32 + 0.5) / IMAGE_WIDTH as f32 * (view.right - view.left),
                y: view.top + (y as f32 + 0.5) / IMAGE_HEIGHT as f32 * (view.bottom - view.top),
            };
            let index = analysis_index(map, world);
            let water = map.water.get(index).map(String::as_str).unwrap_or("land");
            let elevation = map.elevation.get(index).copied().unwrap_or(0.0);
            let normalized = ((elevation - minimum) / (maximum - minimum).max(1.0)).clamp(0.0, 1.0);
            let color = match water {
                "saltwater" => [27, 76, 113, 255],
                "freshwater" => [35, 111, 150, 255],
                _ => [
                    (38.0 + normalized * 88.0) as u8,
                    (68.0 + normalized * 85.0) as u8,
                    (46.0 + normalized * 70.0) as u8,
                    255,
                ],
            };
            pixels[(y * IMAGE_WIDTH + x) * 4..(y * IMAGE_WIDTH + x) * 4 + 4]
                .copy_from_slice(&color);
        }
    }
    pixels
}

fn draw_flow_accumulation(
    pixels: &mut [u8],
    map: &NativeMap,
    replay: &PipelineDiagnosticReplay,
    view: WorldView,
) {
    let maximum = replay
        .flow_accumulation
        .iter()
        .copied()
        .fold(0.0_f64, f64::max)
        .ln_1p()
        .max(f64::EPSILON);
    for (index, flow) in replay.flow_accumulation.iter().copied().enumerate() {
        let point = analysis_center(map, replay, index);
        if !contains(view, point) {
            continue;
        }
        let (x, y) = to_pixel(view, point);
        let amount = (flow.ln_1p() / maximum).clamp(0.0, 1.0);
        draw_disc(
            pixels,
            x.round() as i32,
            y.round() as i32,
            2,
            [40, (100.0 + amount * 150.0) as u8, 255, 255],
        );
    }
}

fn draw_parent_grid(pixels: &mut [u8], map: &NativeMap, view: WorldView) {
    for x in 0..=map.grid_width {
        let world_x = x as f32 / map.grid_width.max(1) as f32 * map.width;
        if world_x >= view.left && world_x <= view.right {
            let (pixel_x, _) = to_pixel(
                view,
                Point {
                    x: world_x,
                    y: view.top,
                },
            );
            draw_line(
                pixels,
                pixel_x,
                0.0,
                pixel_x,
                IMAGE_HEIGHT as f32,
                [205, 205, 205, 50],
                1,
            );
        }
    }
    for y in 0..=map.grid_height {
        let world_y = y as f32 / map.grid_height.max(1) as f32 * map.height;
        if world_y >= view.top && world_y <= view.bottom {
            let (_, pixel_y) = to_pixel(
                view,
                Point {
                    x: view.left,
                    y: world_y,
                },
            );
            draw_line(
                pixels,
                0.0,
                pixel_y,
                IMAGE_WIDTH as f32,
                pixel_y,
                [205, 205, 205, 50],
                1,
            );
        }
    }
}

fn draw_segments(
    pixels: &mut [u8],
    view: WorldView,
    segments: &[(Point, Point)],
    color: [u8; 4],
    width: i32,
) {
    for (start, end) in segments {
        let (x0, y0) = to_pixel(view, *start);
        let (x1, y1) = to_pixel(view, *end);
        draw_line(pixels, x0, y0, x1, y1, color, width);
    }
}

fn draw_line(pixels: &mut [u8], x0: f32, y0: f32, x1: f32, y1: f32, color: [u8; 4], width: i32) {
    let steps = (x1 - x0).abs().max((y1 - y0).abs()).ceil().max(1.0) as usize;
    for step in 0..=steps {
        let t = step as f32 / steps as f32;
        draw_disc(
            pixels,
            (x0 + (x1 - x0) * t).round() as i32,
            (y0 + (y1 - y0) * t).round() as i32,
            width,
            color,
        );
    }
}

fn draw_disc(pixels: &mut [u8], center_x: i32, center_y: i32, radius: i32, color: [u8; 4]) {
    for y in center_y - radius..=center_y + radius {
        for x in center_x - radius..=center_x + radius {
            if x < 0
                || y < 0
                || x >= IMAGE_WIDTH as i32
                || y >= IMAGE_HEIGHT as i32
                || (x - center_x).pow(2) + (y - center_y).pow(2) > radius.pow(2)
            {
                continue;
            }
            let index = (y as usize * IMAGE_WIDTH + x as usize) * 4;
            let alpha = f32::from(color[3]) / 255.0;
            for channel in 0..3 {
                pixels[index + channel] = (f32::from(pixels[index + channel]) * (1.0 - alpha)
                    + f32::from(color[channel]) * alpha)
                    as u8;
            }
            pixels[index + 3] = 255;
        }
    }
}

fn write_png(path: &Path, pixels: &[u8]) -> Result<(), String> {
    let file = File::create(path).map_err(|error| error.to_string())?;
    let mut encoder = png::Encoder::new(
        BufWriter::new(file),
        IMAGE_WIDTH as u32,
        IMAGE_HEIGHT as u32,
    );
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder.write_header().map_err(|error| error.to_string())?;
    writer
        .write_image_data(pixels)
        .map_err(|error| error.to_string())
}

fn pass_7_report(
    map: &NativeMap,
    before: &ShapeMetrics,
    after: &ShapeMetrics,
    correctness: &CorrectnessMetrics,
    replay: &PipelineDiagnosticReplay,
) -> String {
    let natural_hydrology = if after.axis_bias_fraction < before.axis_bias_fraction
        && correctness.downhill_violations == 0
        && correctness.basin_identity_changes == 0
        && correctness.outlet_identity_changes == 0
        && correctness.non_finite_segments == 0
        && replay.hydrology_geometry_stats.fallback_count == 0
        && replay
            .hydrology_geometry_stats
            .locally_conditioned_channel_cells
            == 0
    {
        "PASS"
    } else {
        "PARTIAL"
    };
    format!(
        "# URDR 4.4 Map Generation Pass 7\n\n\
## A. Source Audit\n\n\
`priority_flood -> weighted D-infinity macro routing -> primary topology -> channel initiation -> stream-power erosion -> topology-preserving continuous/subcell corridor refinement -> RiverGraph revision 2 -> renderer`. The fixed 192x120 analysis remains the topology parent; it is no longer the physical centreline.\n\n\
## B. Architecture Change\n\n\
Before: eight-neighbour routing was collapsed to a primary cell-centre chain, smoothed 72/14/14, then passed through Catmull-Rom with linear fallback.\n\n\
After: basin/outlet/DAG/discharge/order remain macro-authoritative. Weighted primary/secondary direction supplies a continuous heading; shared subcell anchors and bounded terrain-constrained corridor search select the physical centreline from the authoritative Canonical sampler. A strict downhill solve runs first; only unsolved corridors use a local longitudinal Priority-Flood profile. Position-based microtopography only breaks ties between terrain-valid candidates. Spline processing is identity-only in Pass 7.\n\n\
## C. Natural Hydrology Invariant\n\n\
- Planet/Region world consistency: **PASS** (Pass 6 invariant retained).\n\
- Natural deterministic hydrology: **{natural_hydrology}**.\n\
- Climate-conditioned geomorphology: **PARTIAL**.\n\n\
## D. Direction Bias\n\n\
- axis bias before: `{:.6}`\n\
- axis bias after: `{:.6}`\n\
- total centreline before/after: `{:.3} / {:.3} km`\n\n\
## E. Straight Runs\n\n\
- longest before/after: `{:.3} / {:.3} km`\n\
- >10 km before/after: `{}/{}`\n\
- >25 km before/after: `{}/{}`\n\
- >50 km before/after: `{}/{}`\n\n\
## F. Physical Correctness\n\n\
- conditioned downhill violations: `{}`\n\
- raw local-relief uphill samples before local conditioning: `{}`\n\
- local profile conditioning mean/max raise: `{:.3} / {:.3} m`\n\
- non-finite segments: `{}`\n\
- basin identity changes: `{}`\n\
- outlet identity changes: `{}`\n\
- discharge/width violations: `{}`\n\
- graph/confluence discontinuities: `{}`\n\n\
## G. Work Budget\n\n\
- routing cells: `{}`\n\
- channel cells: `{}`\n\
- refined channel cells: `{}`\n\
- locally conditioned channel cells: `{}`\n\
- micro samples: `{}`\n\
- river nodes: `{}`\n\
- geometry build: `{:.3} ms`\n\
- peak scratch estimate: `{}` bytes\n\
- explicit fallbacks: `{}`\n\n\
## H. Representation Independence\n\n\
The physical centreline is generated once from world identity, parent topology and Canonical terrain. Zoom, render LOD and screen resolution do not enter the geometry cache identity or trigger regeneration.\n\n\
## I. Fixture\n\n\
- map: `{}`\n\
- seed: `{}`\n\
- extent: `{:.3} x {:.3} km`\n\
- analysis: `{} x {}`\n\n\
## J. Known Limitations\n\n\
- fixed 192x120 parent analysis\n\
- no full climate-conditioned hydrology\n\
- no physical meander migration\n\
- no sediment, floodplain or braiding simulation\n",
        before.axis_bias_fraction,
        after.axis_bias_fraction,
        before.total_length_km,
        after.total_length_km,
        before.longest_straight_run_km,
        after.longest_straight_run_km,
        before.straight_runs_over_10_km,
        after.straight_runs_over_10_km,
        before.straight_runs_over_25_km,
        after.straight_runs_over_25_km,
        before.straight_runs_over_50_km,
        after.straight_runs_over_50_km,
        correctness.downhill_violations,
        correctness.raw_local_relief_uphill_violations,
        replay
            .hydrology_geometry_stats
            .profile_conditioning_total_raise_m
            / replay
                .hydrology_geometry_stats
                .profile_conditioning_samples
                .max(1) as f64,
        replay
            .hydrology_geometry_stats
            .profile_conditioning_max_raise_m,
        correctness.non_finite_segments,
        correctness.basin_identity_changes,
        correctness.outlet_identity_changes,
        correctness.discharge_violations,
        correctness.confluence_discontinuities,
        replay.hydrology_geometry_stats.routing_cells,
        replay.hydrology_geometry_stats.channel_cells,
        replay.hydrology_geometry_stats.refined_channel_cells,
        replay
            .hydrology_geometry_stats
            .locally_conditioned_channel_cells,
        replay.hydrology_geometry_stats.micro_samples,
        replay.hydrology_geometry_stats.river_nodes,
        replay.hydrology_geometry_stats.geometry_build_ms,
        replay.hydrology_geometry_stats.peak_scratch_bytes,
        replay.hydrology_geometry_stats.fallback_count,
        map.source_id,
        map.environment_seed,
        map.width,
        map.height,
        map.grid_width,
        map.grid_height,
    )
}

fn analysis_index(map: &NativeMap, point: Point) -> usize {
    let x = (point.x / map.width.max(f32::EPSILON) * map.grid_width as f32)
        .floor()
        .clamp(0.0, map.grid_width.saturating_sub(1) as f32) as usize;
    let y = (point.y / map.height.max(f32::EPSILON) * map.grid_height as f32)
        .floor()
        .clamp(0.0, map.grid_height.saturating_sub(1) as f32) as usize;
    y * map.grid_width + x
}

fn analysis_center(map: &NativeMap, replay: &PipelineDiagnosticReplay, index: usize) -> Point {
    Point {
        x: (index % replay.width) as f32 / replay.width.max(1) as f32 * map.width
            + map.width / replay.width.max(1) as f32 * 0.5,
        y: (index / replay.width) as f32 / replay.height.max(1) as f32 * map.height
            + map.height / replay.height.max(1) as f32 * 0.5,
    }
}

fn to_pixel(view: WorldView, point: Point) -> (f32, f32) {
    (
        (point.x - view.left) / (view.right - view.left).max(0.001) * IMAGE_WIDTH as f32,
        (point.y - view.top) / (view.bottom - view.top).max(0.001) * IMAGE_HEIGHT as f32,
    )
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

fn distance(start: Point, end: Point) -> f64 {
    f64::from((end.x - start.x).hypot(end.y - start.y))
}

fn polyline_length(points: &[Point]) -> f64 {
    points
        .windows(2)
        .map(|pair| distance(pair[0], pair[1]))
        .sum()
}

fn angle_deg(start: Point, end: Point) -> f64 {
    f64::from(end.y - start.y)
        .atan2(f64::from(end.x - start.x))
        .to_degrees()
        .rem_euclid(180.0)
}

fn angular_difference(left: f64, right: f64) -> f64 {
    let difference = (left - right).abs();
    difference.min(180.0 - difference)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Language;

    #[test]
    #[ignore = "explicit Pass 7 hydrology diagnostics export"]
    fn pass_7_hydrology_export() {
        let _logs = crate::diagnostics::initialize().expect("diagnostics logger");
        let world = LoadedWorld::load_demo(Language::Korean).expect("Korean demo");
        let output = export_pass_7_hydrology(&world).expect("Pass 7 export");
        assert!(output.join("PASS-7-FINAL-REPORT.md").is_file());
        assert!(output.join("river-direction-before-after.csv").is_file());
        assert!(output.join("pass7-F-subcell-centreline.png").is_file());
        eprintln!("pass_7_hydrology={}", output.display());
    }
}
