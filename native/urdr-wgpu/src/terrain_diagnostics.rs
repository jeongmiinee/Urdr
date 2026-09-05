use std::{cmp::Ordering, collections::BTreeMap, path::PathBuf};

use crate::{
    model::{NativeMap, Point},
    surface_refinement::RefinementWindow,
};

const ORIENTATION_BIN_DEGREES: f64 = 5.0;
const ORIENTATION_BIN_COUNT: usize = 36;

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct AngularitySummary {
    pub sample_width: usize,
    pub sample_height: usize,
    pub hard_boundary_gradient_ratio: f64,
    pub boundary_slope_jump_ratio: f64,
    pub boundary_laplacian_ratio: f64,
    pub canonical_analysis_orientation_similarity: f64,
    pub canonical_geology_orientation_similarity: f64,
    pub terrain_analysis_orientation_similarity: f64,
    pub water_analysis_orientation_similarity: f64,
    pub canonical_grid_axis_fraction: f64,
    pub terrain_grid_axis_fraction: f64,
    pub refined_terrain_grid_axis_fraction: f64,
    pub water_grid_axis_fraction: f64,
    pub shoreline_grid_axis_fraction: f64,
    pub contour_grid_axis_fraction: f64,
}

struct ProbeGrid {
    width: usize,
    height: usize,
    cell_width_km: f64,
    cell_height_km: f64,
    analysis_x: Vec<f64>,
    analysis_y: Vec<f64>,
    analysis: Vec<f64>,
    procedural: Vec<f64>,
    canonical: Vec<f64>,
    residual: Vec<f64>,
    geology: Vec<f64>,
    water: Vec<u8>,
    terrain: Vec<u8>,
    canonical_x: Vec<usize>,
    canonical_y: Vec<usize>,
}

#[derive(Clone, Copy, Default)]
struct DerivativeSample {
    gradient_x: f64,
    gradient_y: f64,
    magnitude: f64,
    laplacian: f64,
}

#[derive(Default)]
struct BoundaryMetrics {
    boundary_gradient_mean: f64,
    away_gradient_mean: f64,
    hard_gradient_ratio: f64,
    boundary_slope_jump_mean: f64,
    away_slope_jump_mean: f64,
    slope_jump_ratio: f64,
    boundary_laplacian_mean: f64,
    away_laplacian_mean: f64,
    laplacian_ratio: f64,
    rows: String,
}

struct AngularityProbe {
    grid: ProbeGrid,
    analysis_derivatives: Vec<DerivativeSample>,
    canonical_derivatives: Vec<DerivativeSample>,
    geology_derivatives: Vec<DerivativeSample>,
    boundary: BoundaryMetrics,
    histograms: Vec<(&'static str, [f64; ORIENTATION_BIN_COUNT])>,
    straight_segments: String,
    summary: AngularitySummary,
}

pub(crate) fn export_angularity_probe(
    map: &NativeMap,
) -> Result<(PathBuf, AngularitySummary), String> {
    let probe = analyze_angularity(map, 256)?;
    let sample_csv = probe.sample_csv();
    let histogram_csv = probe.histogram_csv();
    let summary_text = probe.summary_text();
    let boundary_csv = probe.boundary.rows.clone();
    let summary = probe.summary.clone();
    let directory = crate::diagnostics::write_debug_package(
        "terrain-angularity-probe",
        &[
            ("samples.csv", sample_csv.into_bytes()),
            ("slope-jump.csv", boundary_csv.into_bytes()),
            ("orientation-histograms.csv", histogram_csv.into_bytes()),
            (
                "straight-segments.csv",
                probe.straight_segments.into_bytes(),
            ),
            ("summary.txt", summary_text.into_bytes()),
        ],
    )?;
    crate::diagnostics::event(
        "terrain_diagnostics",
        "angularity_probe",
        "exported",
        &[
            ("map_id", map.source_id.clone()),
            (
                "sample_dimensions",
                format!("{}x{}", summary.sample_width, summary.sample_height),
            ),
            (
                "hard_boundary_gradient_ratio",
                format!("{:.6}", summary.hard_boundary_gradient_ratio),
            ),
            (
                "boundary_slope_jump_ratio",
                format!("{:.6}", summary.boundary_slope_jump_ratio),
            ),
            (
                "canonical_analysis_orientation_similarity",
                format!("{:.6}", summary.canonical_analysis_orientation_similarity),
            ),
            (
                "shoreline_grid_axis_fraction",
                format!("{:.6}", summary.shoreline_grid_axis_fraction),
            ),
            ("path", directory.display().to_string()),
        ],
    );
    Ok((directory, summary))
}

fn analyze_angularity(map: &NativeMap, maximum_axis: usize) -> Result<AngularityProbe, String> {
    let surface = map
        .canonical_surface
        .as_ref()
        .ok_or_else(|| "The active map has no CanonicalSurface.".to_owned())?;
    let width = (surface.width as usize).min(maximum_axis).max(8);
    let aspect = map.height.max(0.1) / map.width.max(0.1);
    let height = ((width as f32 * aspect).round() as usize)
        .clamp(8, maximum_axis)
        .min(surface.height.max(8) as usize);
    let mut grid = ProbeGrid {
        width,
        height,
        cell_width_km: map.width.max(0.1) as f64 / width as f64,
        cell_height_km: map.height.max(0.1) as f64 / height as f64,
        analysis_x: Vec::with_capacity(width * height),
        analysis_y: Vec::with_capacity(width * height),
        analysis: Vec::with_capacity(width * height),
        procedural: Vec::with_capacity(width * height),
        canonical: Vec::with_capacity(width * height),
        residual: Vec::with_capacity(width * height),
        geology: Vec::with_capacity(width * height),
        water: Vec::with_capacity(width * height),
        terrain: Vec::with_capacity(width * height),
        canonical_x: Vec::with_capacity(width * height),
        canonical_y: Vec::with_capacity(width * height),
    };
    for sample_y in 0..height {
        let canonical_y = ((sample_y as f64 + 0.5) * surface.height as f64 / height as f64)
            .floor()
            .clamp(0.0, surface.height.saturating_sub(1) as f64) as usize;
        for sample_x in 0..width {
            let canonical_x = ((sample_x as f64 + 0.5) * surface.width as f64 / width as f64)
                .floor()
                .clamp(0.0, surface.width.saturating_sub(1) as f64)
                as usize;
            let sample = surface
                .diagnostic_sample(canonical_x, canonical_y)
                .ok_or_else(|| "Canonical diagnostic sampling failed.".to_owned())?;
            let (_, terrain, water) = surface
                .encoded(canonical_x, canonical_y)
                .ok_or_else(|| "Canonical category sampling failed.".to_owned())?;
            grid.analysis_x.push(
                (canonical_x as f64 + 0.5) * map.grid_width.max(1) as f64
                    / surface.width.max(1) as f64
                    - 0.5,
            );
            grid.analysis_y.push(
                (canonical_y as f64 + 0.5) * map.grid_height.max(1) as f64
                    / surface.height.max(1) as f64
                    - 0.5,
            );
            grid.analysis.push(f64::from(sample.analysis_elevation_m));
            grid.procedural
                .push(f64::from(sample.procedural_elevation_m));
            grid.canonical.push(f64::from(sample.final_elevation_m));
            grid.residual.push(f64::from(sample.residual_m));
            grid.geology.push(f64::from(sample.geology_bias_m));
            debug_assert_eq!(sample.water_code, water);
            grid.water.push(sample.water_code);
            grid.terrain.push(terrain);
            grid.canonical_x.push(canonical_x);
            grid.canonical_y.push(canonical_y);
        }
    }
    let analysis_derivatives = derivatives(
        &grid.analysis,
        width,
        height,
        grid.cell_width_km,
        grid.cell_height_km,
    );
    let canonical_derivatives = derivatives(
        &grid.canonical,
        width,
        height,
        grid.cell_width_km,
        grid.cell_height_km,
    );
    let geology_derivatives = derivatives(
        &grid.geology,
        width,
        height,
        grid.cell_width_km,
        grid.cell_height_km,
    );
    let boundary = boundary_metrics(&grid, &canonical_derivatives);
    let analysis_hist = scalar_orientation_histogram(&analysis_derivatives);
    let canonical_hist = scalar_orientation_histogram(&canonical_derivatives);
    let geology_hist = scalar_orientation_histogram(&geology_derivatives);
    let water_hist = category_boundary_histogram(&grid.water, width, height);
    let terrain_hist = category_boundary_histogram(&grid.terrain, width, height);
    let refined_terrain_hist = refined_terrain_orientation_histogram(map, &grid);
    let (shoreline_hist, shoreline_segments) = shoreline_orientation_probe(map);
    let contour_hist = contour_orientation_histogram(map, surface.width, surface.height);
    let histograms = vec![
        ("analysis_gradient", analysis_hist),
        ("canonical_gradient", canonical_hist),
        ("geology_gradient", geology_hist),
        ("water_boundary", water_hist),
        ("terrain_boundary", terrain_hist),
        ("refined_terrain_boundary", refined_terrain_hist),
        ("shoreline_vector", shoreline_hist),
        ("contour_vector", contour_hist),
    ];
    let summary = AngularitySummary {
        sample_width: width,
        sample_height: height,
        hard_boundary_gradient_ratio: boundary.hard_gradient_ratio,
        boundary_slope_jump_ratio: boundary.slope_jump_ratio,
        boundary_laplacian_ratio: boundary.laplacian_ratio,
        canonical_analysis_orientation_similarity: cosine_similarity(
            &canonical_hist,
            &analysis_hist,
        ),
        canonical_geology_orientation_similarity: cosine_similarity(&canonical_hist, &geology_hist),
        terrain_analysis_orientation_similarity: cosine_similarity(&terrain_hist, &analysis_hist),
        water_analysis_orientation_similarity: cosine_similarity(&water_hist, &analysis_hist),
        canonical_grid_axis_fraction: grid_axis_fraction(&canonical_hist),
        terrain_grid_axis_fraction: grid_axis_fraction(&terrain_hist),
        refined_terrain_grid_axis_fraction: grid_axis_fraction(&refined_terrain_hist),
        water_grid_axis_fraction: grid_axis_fraction(&water_hist),
        shoreline_grid_axis_fraction: grid_axis_fraction(&shoreline_hist),
        contour_grid_axis_fraction: grid_axis_fraction(&contour_hist),
    };
    let mut straight_segments = straight_segment_csv(&grid, map);
    straight_segments.push_str(&shoreline_segments);
    Ok(AngularityProbe {
        grid,
        analysis_derivatives,
        canonical_derivatives,
        geology_derivatives,
        boundary,
        histograms,
        straight_segments,
        summary,
    })
}

impl AngularityProbe {
    fn sample_csv(&self) -> String {
        let mut output = String::from(
            "sample_x,sample_y,canonical_x,canonical_y,analysis_elevation_m,procedural_elevation_m,canonical_elevation_m,canonical_minus_analysis_m,geology_bias_m,water_code,terrain_code,analysis_gradient_m_per_km,canonical_gradient_m_per_km,geology_gradient_m_per_km,canonical_gradient_direction_deg,canonical_laplacian_m_per_km2\n",
        );
        for y in 0..self.grid.height {
            for x in 0..self.grid.width {
                let index = y * self.grid.width + x;
                let canonical = self.canonical_derivatives[index];
                output.push_str(&format!(
                    "{x},{y},{},{},{:.6},{:.6},{:.6},{:.6},{:.6},{},{},{:.6},{:.6},{:.6},{:.6},{:.6}\n",
                    self.grid.canonical_x[index],
                    self.grid.canonical_y[index],
                    self.grid.analysis[index],
                    self.grid.procedural[index],
                    self.grid.canonical[index],
                    self.grid.residual[index],
                    self.grid.geology[index],
                    self.grid.water[index],
                    self.grid.terrain[index],
                    self.analysis_derivatives[index].magnitude,
                    canonical.magnitude,
                    self.geology_derivatives[index].magnitude,
                    orientation_degrees(canonical.gradient_x, canonical.gradient_y),
                    canonical.laplacian,
                ));
            }
        }
        output
    }

    fn histogram_csv(&self) -> String {
        let mut output = String::from("layer,angle_start_deg,angle_end_deg,normalized_count\n");
        for (name, histogram) in &self.histograms {
            for (index, value) in histogram.iter().enumerate() {
                let start = index as f64 * ORIENTATION_BIN_DEGREES;
                output.push_str(&format!(
                    "{name},{start:.1},{:.1},{value:.9}\n",
                    start + ORIENTATION_BIN_DEGREES
                ));
            }
        }
        output
    }

    fn summary_text(&self) -> String {
        format!(
            "URDR terrain angularity diagnostic\n\nSample grid: {}x{}\nPhysical sample cell: {:.6}km x {:.6}km\n\nHard gradients\nBoundary mean: {:.6}m\nAway mean: {:.6}m\nRatio: {:.6}\n\nSlope discontinuity\nBoundary mean: {:.6}m/km\nAway mean: {:.6}m/km\nRatio: {:.6}\n\nLaplacian discontinuity\nBoundary mean: {:.6}m/km2\nAway mean: {:.6}m/km2\nRatio: {:.6}\n\nOrientation cosine similarity\nCanonical vs analysis: {:.6}\nCanonical vs geology: {:.6}\nTerrain boundary vs analysis: {:.6}\nWater boundary vs analysis: {:.6}\n\nGrid-axis fractions (0/45/90/135 degrees +/- 5 degrees)\nCanonical elevation: {:.6}\nRaw terrain category: {:.6}\nRefined terrain display: {:.6}\nRaw water mask: {:.6}\nRefined shoreline vectors: {:.6}\nContour vectors: {:.6}\n\nInterpretation rules\n- A hard-gradient ratio near or below 1 does not support a direct elevation step at analysis-cell boundaries.\n- A slope-jump or Laplacian ratio materially above 1 supports derivative leakage even when heights remain continuous.\n- High canonical/analysis orientation similarity supports coarse-analysis shape inheritance, but is not by itself proof of an artifact.\n- Raw water and terrain category boundaries remain authoritative raster labels, so strong 0/90-degree peaks there are expected.\n- Refined terrain measures subcell coverage gradients used only by LOD0 display.\n- Refined shoreline measures the interpolated Marching Squares mesh, not shared categorical cell edges.\n",
            self.grid.width,
            self.grid.height,
            self.grid.cell_width_km,
            self.grid.cell_height_km,
            self.boundary.boundary_gradient_mean,
            self.boundary.away_gradient_mean,
            self.summary.hard_boundary_gradient_ratio,
            self.boundary.boundary_slope_jump_mean,
            self.boundary.away_slope_jump_mean,
            self.summary.boundary_slope_jump_ratio,
            self.boundary.boundary_laplacian_mean,
            self.boundary.away_laplacian_mean,
            self.summary.boundary_laplacian_ratio,
            self.summary.canonical_analysis_orientation_similarity,
            self.summary.canonical_geology_orientation_similarity,
            self.summary.terrain_analysis_orientation_similarity,
            self.summary.water_analysis_orientation_similarity,
            self.summary.canonical_grid_axis_fraction,
            self.summary.terrain_grid_axis_fraction,
            self.summary.refined_terrain_grid_axis_fraction,
            self.summary.water_grid_axis_fraction,
            self.summary.shoreline_grid_axis_fraction,
            self.summary.contour_grid_axis_fraction,
        )
    }
}

fn derivatives(
    values: &[f64],
    width: usize,
    height: usize,
    cell_width: f64,
    cell_height: f64,
) -> Vec<DerivativeSample> {
    let mut output = vec![DerivativeSample::default(); width * height];
    let value = |x: usize, y: usize| values[y * width + x];
    for y in 0..height {
        for x in 0..width {
            let left = value(x.saturating_sub(1), y);
            let right = value((x + 1).min(width - 1), y);
            let top = value(x, y.saturating_sub(1));
            let bottom = value(x, (y + 1).min(height - 1));
            let center = value(x, y);
            let x_span = if x == 0 || x + 1 == width { 1.0 } else { 2.0 };
            let y_span = if y == 0 || y + 1 == height { 1.0 } else { 2.0 };
            let gradient_x = (right - left) / (cell_width * x_span).max(f64::EPSILON);
            let gradient_y = (bottom - top) / (cell_height * y_span).max(f64::EPSILON);
            output[y * width + x] = DerivativeSample {
                gradient_x,
                gradient_y,
                magnitude: gradient_x.hypot(gradient_y),
                laplacian: (right - 2.0 * center + left) / cell_width.powi(2).max(f64::EPSILON)
                    + (bottom - 2.0 * center + top) / cell_height.powi(2).max(f64::EPSILON),
            };
        }
    }
    output
}

fn boundary_metrics(grid: &ProbeGrid, derivative: &[DerivativeSample]) -> BoundaryMetrics {
    let mut boundary_gradient = Vec::new();
    let mut away_gradient = Vec::new();
    let mut boundary_slope = Vec::new();
    let mut away_slope = Vec::new();
    let mut boundary_laplacian = Vec::new();
    let mut away_laplacian = Vec::new();
    let mut rows = String::from(
        "axis,left_x,left_y,right_x,right_y,crosses_analysis_boundary,height_difference_m,slope_jump_m_per_km,laplacian_difference_m_per_km2\n",
    );
    let mut compare = |left: usize,
                       right: usize,
                       axis: &str,
                       left_x: usize,
                       left_y: usize,
                       right_x: usize,
                       right_y: usize,
                       crosses: bool| {
        let height = (grid.canonical[right] - grid.canonical[left]).abs();
        let slope = (derivative[right].gradient_x - derivative[left].gradient_x)
            .hypot(derivative[right].gradient_y - derivative[left].gradient_y);
        let laplacian = (derivative[right].laplacian - derivative[left].laplacian).abs();
        if crosses {
            boundary_gradient.push(height);
            boundary_slope.push(slope);
            boundary_laplacian.push(laplacian);
        } else {
            away_gradient.push(height);
            away_slope.push(slope);
            away_laplacian.push(laplacian);
        }
        rows.push_str(&format!(
            "{axis},{left_x},{left_y},{right_x},{right_y},{crosses},{height:.6},{slope:.6},{laplacian:.6}\n"
        ));
    };
    for y in 0..grid.height {
        for x in 1..grid.width {
            let left = y * grid.width + x - 1;
            let right = y * grid.width + x;
            compare(
                left,
                right,
                "x",
                x - 1,
                y,
                x,
                y,
                grid.analysis_x[left].floor() != grid.analysis_x[right].floor(),
            );
        }
    }
    for y in 1..grid.height {
        for x in 0..grid.width {
            let top = (y - 1) * grid.width + x;
            let bottom = y * grid.width + x;
            compare(
                top,
                bottom,
                "y",
                x,
                y - 1,
                x,
                y,
                grid.analysis_y[top].floor() != grid.analysis_y[bottom].floor(),
            );
        }
    }
    let boundary_gradient_mean = mean(&boundary_gradient);
    let away_gradient_mean = mean(&away_gradient);
    let boundary_slope_jump_mean = mean(&boundary_slope);
    let away_slope_jump_mean = mean(&away_slope);
    let boundary_laplacian_mean = mean(&boundary_laplacian);
    let away_laplacian_mean = mean(&away_laplacian);
    BoundaryMetrics {
        boundary_gradient_mean,
        away_gradient_mean,
        hard_gradient_ratio: boundary_gradient_mean / away_gradient_mean.max(f64::EPSILON),
        boundary_slope_jump_mean,
        away_slope_jump_mean,
        slope_jump_ratio: boundary_slope_jump_mean / away_slope_jump_mean.max(f64::EPSILON),
        boundary_laplacian_mean,
        away_laplacian_mean,
        laplacian_ratio: boundary_laplacian_mean / away_laplacian_mean.max(f64::EPSILON),
        rows,
    }
}

fn scalar_orientation_histogram(derivatives: &[DerivativeSample]) -> [f64; ORIENTATION_BIN_COUNT] {
    let mut magnitudes = derivatives
        .iter()
        .map(|sample| sample.magnitude)
        .filter(|value| value.is_finite() && *value > 0.0)
        .collect::<Vec<_>>();
    magnitudes.sort_by(|left, right| left.partial_cmp(right).unwrap_or(Ordering::Equal));
    let threshold = magnitudes
        .get(
            ((magnitudes.len() as f64 * 0.85).floor() as usize)
                .min(magnitudes.len().saturating_sub(1)),
        )
        .copied()
        .unwrap_or(f64::INFINITY);
    let mut histogram = [0.0; ORIENTATION_BIN_COUNT];
    for sample in derivatives
        .iter()
        .filter(|sample| sample.magnitude >= threshold)
    {
        add_orientation(
            &mut histogram,
            orientation_degrees(sample.gradient_x, sample.gradient_y),
        );
    }
    normalize_histogram(histogram)
}

fn category_boundary_histogram(
    values: &[u8],
    width: usize,
    height: usize,
) -> [f64; ORIENTATION_BIN_COUNT] {
    let mut histogram = [0.0; ORIENTATION_BIN_COUNT];
    for y in 0..height {
        for x in 1..width {
            if values[y * width + x - 1] != values[y * width + x] {
                add_orientation(&mut histogram, 90.0);
            }
        }
    }
    for y in 1..height {
        for x in 0..width {
            if values[(y - 1) * width + x] != values[y * width + x] {
                add_orientation(&mut histogram, 0.0);
            }
        }
    }
    normalize_histogram(histogram)
}

fn refined_terrain_orientation_histogram(
    map: &NativeMap,
    probe: &ProbeGrid,
) -> [f64; ORIENTATION_BIN_COUNT] {
    let Some(surface) = map.canonical_surface.as_ref() else {
        return [0.0; ORIENTATION_BIN_COUNT];
    };
    if surface.width < 2 || surface.height < 2 {
        return [0.0; ORIENTATION_BIN_COUNT];
    }
    fn push_candidate(
        candidates: &mut Vec<(usize, usize)>,
        probe: &ProbeGrid,
        left: usize,
        right: usize,
    ) {
        if probe.water[left] != 0
            || probe.water[right] != 0
            || probe.terrain[left] == probe.terrain[right]
        {
            return;
        }
        let candidate = (
            (probe.canonical_x[left] + probe.canonical_x[right]) / 2,
            (probe.canonical_y[left] + probe.canonical_y[right]) / 2,
        );
        if candidates.iter().all(|existing| {
            existing.0.abs_diff(candidate.0) + existing.1.abs_diff(candidate.1) >= 12
        }) {
            candidates.push(candidate);
        }
    }
    let mut candidates = Vec::<(usize, usize)>::new();
    for y in 0..probe.height {
        for x in 1..probe.width {
            push_candidate(
                &mut candidates,
                probe,
                y * probe.width + x - 1,
                y * probe.width + x,
            );
            if candidates.len() >= 24 {
                break;
            }
        }
        if candidates.len() >= 24 {
            break;
        }
    }
    if candidates.len() < 24 {
        for y in 1..probe.height {
            for x in 0..probe.width {
                push_candidate(
                    &mut candidates,
                    probe,
                    (y - 1) * probe.width + x,
                    y * probe.width + x,
                );
                if candidates.len() >= 24 {
                    break;
                }
            }
            if candidates.len() >= 24 {
                break;
            }
        }
    }

    let mut histogram = [0.0; ORIENTATION_BIN_COUNT];
    const RADIUS: usize = 5;
    const SUBCELL_SCALE: usize = 4;
    for (center_x, center_y) in candidates {
        let start_x = center_x.saturating_sub(RADIUS);
        let start_y = center_y.saturating_sub(RADIUS);
        let end_x = (center_x + RADIUS + 1).min(surface.width as usize);
        let end_y = (center_y + RADIUS + 1).min(surface.height as usize);
        let Some(window) = RefinementWindow::new(
            surface,
            start_x as i32 - 2,
            start_y as i32 - 2,
            end_x as i32 + 2,
            end_y as i32 + 2,
            map.environment_seed,
            map.sea_level,
        ) else {
            continue;
        };
        let width = (end_x - start_x) * SUBCELL_SCALE;
        let height = (end_y - start_y) * SUBCELL_SCALE;
        let mut coverage = Vec::with_capacity(width * height);
        for y in 0..height {
            for x in 0..width {
                let sample = window.sample(
                    start_x as f32 + (x as f32 + 0.5) / SUBCELL_SCALE as f32,
                    start_y as f32 + (y as f32 + 0.5) / SUBCELL_SCALE as f32,
                );
                coverage.push(if sample.coast_value >= 0.0 {
                    f64::from(sample.secondary_mix)
                } else {
                    0.0
                });
            }
        }
        for sample in derivatives(&coverage, width, height, 1.0, 1.0)
            .into_iter()
            .filter(|sample| sample.magnitude > 0.000_01)
        {
            add_orientation(
                &mut histogram,
                orientation_degrees(sample.gradient_x, sample.gradient_y),
            );
        }
    }
    normalize_histogram(histogram)
}

fn shoreline_orientation_probe(map: &NativeMap) -> ([f64; ORIENTATION_BIN_COUNT], String) {
    let Some(surface) = map.canonical_surface.as_ref() else {
        return ([0.0; ORIENTATION_BIN_COUNT], String::new());
    };
    let (chunks_x, chunks_y) = surface.chunk_grid_dimensions();
    let chunk_count = u64::from(chunks_x).saturating_mul(u64::from(chunks_y));
    let stride = ((chunk_count as f64 / 64.0).sqrt().ceil() as usize).max(1);
    let mut histogram = [0.0; ORIENTATION_BIN_COUNT];
    let mut sampled_segments = Vec::new();
    for chunk_y in (0..chunks_y as usize).step_by(stride) {
        for chunk_x in (0..chunks_x as usize).step_by(stride) {
            let segments =
                crate::shoreline::build_shoreline_chunk(map, chunk_x as u32, chunk_y as u32);
            for segment in &segments {
                let dx = f64::from(segment.end.x - segment.start.x);
                let dy = f64::from(segment.end.y - segment.start.y);
                let length = dx.hypot(dy);
                if length <= f64::EPSILON {
                    continue;
                }
                let orientation = orientation_degrees(dx, dy);
                add_orientation(&mut histogram, orientation);
            }
            sampled_segments.extend(segments);
        }
    }
    (
        normalize_histogram(histogram),
        shoreline_straight_run_rows(&sampled_segments),
    )
}

fn shoreline_straight_run_rows(segments: &[crate::shoreline::ShorelineSegment]) -> String {
    type PointKey = (i64, i64);
    const POINTS_PER_KM: f64 = 1_000.0;
    let key = |point: Point| {
        (
            (f64::from(point.x) * POINTS_PER_KM).round() as i64,
            (f64::from(point.y) * POINTS_PER_KM).round() as i64,
        )
    };
    let mut adjacency = BTreeMap::<PointKey, Vec<usize>>::new();
    let mut points = BTreeMap::<PointKey, Point>::new();
    for (index, segment) in segments.iter().enumerate() {
        for point in [segment.start, segment.end] {
            adjacency.entry(key(point)).or_default().push(index);
            points.entry(key(point)).or_insert(point);
        }
    }
    let mut visited = vec![false; segments.len()];
    let mut polylines = Vec::new();
    let trace = |start: PointKey, visited: &mut [bool]| {
        let mut line = vec![points[&start]];
        let mut current = start;
        loop {
            let Some(segment_index) = adjacency
                .get(&current)
                .and_then(|incident| incident.iter().copied().find(|index| !visited[*index]))
            else {
                break;
            };
            visited[segment_index] = true;
            let segment = segments[segment_index];
            let next = if key(segment.start) == current {
                key(segment.end)
            } else {
                key(segment.start)
            };
            line.push(points[&next]);
            current = next;
            if current == start {
                break;
            }
        }
        line
    };
    for (&point, incident) in &adjacency {
        if incident.len() == 2 {
            continue;
        }
        while incident.iter().any(|index| !visited[*index]) {
            let line = trace(point, &mut visited);
            if line.len() >= 2 {
                polylines.push(line);
            }
        }
    }
    for segment_index in 0..segments.len() {
        if visited[segment_index] {
            continue;
        }
        let line = trace(key(segments[segment_index].start), &mut visited);
        if line.len() >= 2 {
            polylines.push(line);
        }
    }

    let mut rows = String::new();
    for line in polylines {
        let mut run_orientation: Option<f64> = None;
        let mut run_length = 0.0;
        for pair in line.windows(2) {
            let dx = f64::from(pair[1].x - pair[0].x);
            let dy = f64::from(pair[1].y - pair[0].y);
            let orientation = orientation_degrees(dx, dy);
            let length = dx.hypot(dy);
            if run_orientation.is_some_and(|value| angular_distance(value, orientation) <= 5.0) {
                run_length += length;
            } else {
                if let Some(value) = run_orientation {
                    rows.push_str(&format!("shoreline_refined,{value:.3},{run_length:.6}\n"));
                }
                run_orientation = Some(orientation);
                run_length = length;
            }
        }
        if let Some(value) = run_orientation {
            rows.push_str(&format!("shoreline_refined,{value:.3},{run_length:.6}\n"));
        }
    }
    rows
}

fn contour_orientation_histogram(
    map: &NativeMap,
    surface_width: u32,
    surface_height: u32,
) -> [f64; ORIENTATION_BIN_COUNT] {
    let maximum = surface_width.max(surface_height).max(1) as f64;
    let lod = (maximum / 256.0).log2().ceil().clamp(0.0, 6.0) as u8;
    let lines = crate::contour::build_for_bounds(
        map,
        lod,
        Point { x: 0.0, y: 0.0 },
        Point {
            x: map.width,
            y: map.height,
        },
    );
    let mut histogram = [0.0; ORIENTATION_BIN_COUNT];
    for line in lines {
        for pair in line.points.windows(2) {
            let dx = f64::from(pair[1].x - pair[0].x);
            let dy = f64::from(pair[1].y - pair[0].y);
            if dx != 0.0 || dy != 0.0 {
                add_orientation(&mut histogram, orientation_degrees(dx, dy));
            }
        }
    }
    normalize_histogram(histogram)
}

fn straight_segment_csv(grid: &ProbeGrid, map: &NativeMap) -> String {
    let mut output = String::from("layer,orientation_deg,length_km\n");
    append_category_runs(
        &mut output,
        "water_boundary",
        &grid.water,
        grid.width,
        grid.height,
        grid.cell_width_km,
        grid.cell_height_km,
    );
    append_category_runs(
        &mut output,
        "terrain_boundary",
        &grid.terrain,
        grid.width,
        grid.height,
        grid.cell_width_km,
        grid.cell_height_km,
    );
    let maximum = map
        .canonical_surface
        .as_ref()
        .map(|surface| surface.width.max(surface.height))
        .unwrap_or(1) as f64;
    let lod = (maximum / 256.0).log2().ceil().clamp(0.0, 6.0) as u8;
    for line in crate::contour::build_for_bounds(
        map,
        lod,
        Point { x: 0.0, y: 0.0 },
        Point {
            x: map.width,
            y: map.height,
        },
    ) {
        let mut run_orientation: Option<f64> = None;
        let mut run_length = 0.0;
        for pair in line.points.windows(2) {
            let dx = f64::from(pair[1].x - pair[0].x);
            let dy = f64::from(pair[1].y - pair[0].y);
            let length = dx.hypot(dy);
            let orientation = orientation_degrees(dx, dy);
            if run_orientation.is_some_and(|value| angular_distance(value, orientation) <= 5.0) {
                run_length += length;
            } else {
                if let Some(value) = run_orientation {
                    output.push_str(&format!("contour,{value:.3},{run_length:.6}\n"));
                }
                run_orientation = Some(orientation);
                run_length = length;
            }
        }
        if let Some(value) = run_orientation {
            output.push_str(&format!("contour,{value:.3},{run_length:.6}\n"));
        }
    }
    output
}

fn append_category_runs(
    output: &mut String,
    layer: &str,
    values: &[u8],
    width: usize,
    height: usize,
    cell_width_km: f64,
    cell_height_km: f64,
) {
    for x in 1..width {
        let mut y = 0;
        while y < height {
            if values[y * width + x - 1] == values[y * width + x] {
                y += 1;
                continue;
            }
            let start = y;
            while y < height && values[y * width + x - 1] != values[y * width + x] {
                y += 1;
            }
            output.push_str(&format!(
                "{layer},90.000,{:.6}\n",
                (y - start) as f64 * cell_height_km
            ));
        }
    }
    for y in 1..height {
        let mut x = 0;
        while x < width {
            if values[(y - 1) * width + x] == values[y * width + x] {
                x += 1;
                continue;
            }
            let start = x;
            while x < width && values[(y - 1) * width + x] != values[y * width + x] {
                x += 1;
            }
            output.push_str(&format!(
                "{layer},0.000,{:.6}\n",
                (x - start) as f64 * cell_width_km
            ));
        }
    }
}

fn orientation_degrees(x: f64, y: f64) -> f64 {
    y.atan2(x).to_degrees().rem_euclid(180.0)
}

fn add_orientation(histogram: &mut [f64; ORIENTATION_BIN_COUNT], angle: f64) {
    let index = ((angle.rem_euclid(180.0) / ORIENTATION_BIN_DEGREES).floor() as usize)
        .min(ORIENTATION_BIN_COUNT - 1);
    histogram[index] += 1.0;
}

fn normalize_histogram(
    mut histogram: [f64; ORIENTATION_BIN_COUNT],
) -> [f64; ORIENTATION_BIN_COUNT] {
    let total = histogram.iter().sum::<f64>();
    if total > 0.0 {
        for value in &mut histogram {
            *value /= total;
        }
    }
    histogram
}

fn cosine_similarity(
    left: &[f64; ORIENTATION_BIN_COUNT],
    right: &[f64; ORIENTATION_BIN_COUNT],
) -> f64 {
    let dot = left.iter().zip(right).map(|(a, b)| a * b).sum::<f64>();
    let left_norm = left.iter().map(|value| value * value).sum::<f64>().sqrt();
    let right_norm = right.iter().map(|value| value * value).sum::<f64>().sqrt();
    dot / (left_norm * right_norm).max(f64::EPSILON)
}

fn grid_axis_fraction(histogram: &[f64; ORIENTATION_BIN_COUNT]) -> f64 {
    histogram
        .iter()
        .enumerate()
        .filter(|(index, _)| {
            let center = (*index as f64 + 0.5) * ORIENTATION_BIN_DEGREES;
            [0.0, 45.0, 90.0, 135.0, 180.0]
                .iter()
                .any(|axis| angular_distance(center, *axis) <= 5.0)
        })
        .map(|(_, value)| *value)
        .sum()
}

fn angular_distance(left: f64, right: f64) -> f64 {
    let difference = (left - right).abs().rem_euclid(180.0);
    difference.min(180.0 - difference)
}

fn mean(values: &[f64]) -> f64 {
    values.iter().sum::<f64>() / values.len().max(1) as f64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{CanonicalSurface, Language, LoadedWorld};
    use std::sync::Arc;

    #[test]
    fn analysis_boundary_slope_jump_probe_is_deterministic() {
        let width = 12;
        let height = 8;
        let mut canonical = Vec::with_capacity(width * height);
        let mut analysis_x = Vec::with_capacity(width * height);
        let mut analysis_y = Vec::with_capacity(width * height);
        for y in 0..height {
            for x in 0..width {
                canonical.push((x * x + y * 3) as f64);
                analysis_x.push(x as f64 / 3.0);
                analysis_y.push(y as f64 / 2.0);
            }
        }
        let grid = ProbeGrid {
            width,
            height,
            cell_width_km: 1.0,
            cell_height_km: 1.0,
            analysis_x,
            analysis_y,
            analysis: canonical.clone(),
            procedural: canonical.clone(),
            canonical: canonical.clone(),
            residual: vec![0.0; width * height],
            geology: vec![0.0; width * height],
            water: vec![0; width * height],
            terrain: vec![0; width * height],
            canonical_x: (0..width * height).map(|index| index % width).collect(),
            canonical_y: (0..width * height).map(|index| index / width).collect(),
        };
        let derivative = derivatives(&canonical, width, height, 1.0, 1.0);
        let first = boundary_metrics(&grid, &derivative);
        let second = boundary_metrics(&grid, &derivative);
        assert_eq!(first.slope_jump_ratio, second.slope_jump_ratio);
        assert_eq!(first.laplacian_ratio, second.laplacian_ratio);
        assert!(first.slope_jump_ratio.is_finite());
    }

    #[test]
    fn edge_orientation_histogram_is_deterministic() {
        let width = 16;
        let height = 12;
        let values = (0..width * height)
            .map(|index| {
                let x = (index % width) as f64;
                let y = (index / width) as f64;
                x * 4.0 + y * y * 0.25
            })
            .collect::<Vec<_>>();
        let derivative = derivatives(&values, width, height, 1.0, 1.0);
        let first = scalar_orientation_histogram(&derivative);
        let second = scalar_orientation_histogram(&derivative);
        assert_eq!(first, second);
        assert!((first.iter().sum::<f64>() - 1.0).abs() < 0.000_001);
    }

    #[test]
    fn refined_shoreline_histogram_is_deterministic() {
        let map = LoadedWorld::load_demo(Language::English).expect("demo").map;
        let first = shoreline_orientation_probe(&map).0;
        let second = shoreline_orientation_probe(&map).0;
        assert_eq!(first, second);
        let total = first.iter().sum::<f64>();
        assert!(total == 0.0 || (total - 1.0).abs() < 0.000_001);
    }

    #[test]
    fn refined_shoreline_reduces_grid_axis_bias() {
        let mut map = LoadedWorld::load_demo(Language::English).expect("demo").map;
        map.width = 25.6;
        map.height = 12.8;
        map.canonical_surface = Some(Arc::new(CanonicalSurface::generate(256, 128, |x, y| {
            let coast = 112.0 + (y as f32 * 0.073).sin() * 31.0 + (y as f32 * 0.19).sin() * 9.0;
            let water = u8::from(x as f32 >= coast);
            (if water == 0 { 90 } else { -70 }, 0, water)
        })));
        let surface = map.canonical_surface.as_ref().unwrap();
        let raw = (0..surface.height as usize)
            .flat_map(|y| {
                (0..surface.width as usize).map(move |x| surface.encoded(x, y).unwrap().2)
            })
            .collect::<Vec<_>>();
        let raw_hist =
            category_boundary_histogram(&raw, surface.width as usize, surface.height as usize);
        let refined_hist = shoreline_orientation_probe(&map).0;
        let refined_axis_fraction = grid_axis_fraction(&refined_hist);
        assert_eq!(grid_axis_fraction(&raw_hist), 1.0);
        assert!(
            refined_axis_fraction < 0.95,
            "refined shoreline axis fraction was {refined_axis_fraction:.6}"
        );
    }

    #[test]
    fn refined_shoreline_run_export_stitches_adjacent_segments() {
        let segments = (0..3)
            .map(|x| crate::shoreline::ShorelineSegment {
                start: Point {
                    x: x as f32,
                    y: 2.0,
                },
                end: Point {
                    x: x as f32 + 1.0,
                    y: 2.0,
                },
            })
            .collect::<Vec<_>>();
        let rows = shoreline_straight_run_rows(&segments);
        assert_eq!(rows.lines().count(), 1);
        assert!(rows.ends_with(",3.000000\n"));
    }

    #[test]
    fn refined_shoreline_run_export_tolerates_submetre_endpoint_drift() {
        let segments = vec![
            crate::shoreline::ShorelineSegment {
                start: Point { x: 0.0, y: 2.0 },
                end: Point { x: 1.0, y: 2.0 },
            },
            crate::shoreline::ShorelineSegment {
                start: Point {
                    x: 1.000_2,
                    y: 2.000_2,
                },
                end: Point { x: 2.0, y: 2.0 },
            },
        ];
        let rows = shoreline_straight_run_rows(&segments);
        let lengths = rows
            .lines()
            .filter_map(|row| row.rsplit(',').next())
            .filter_map(|value| value.parse::<f64>().ok())
            .collect::<Vec<_>>();
        assert_eq!(lengths.len(), 1);
        assert!(lengths[0] > 1.9);
    }
}
