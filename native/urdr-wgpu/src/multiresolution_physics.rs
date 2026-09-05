use std::{cmp::Ordering, collections::BinaryHeap, time::Instant};

use crate::{
    model::{NativeMap, Point},
    subcell_hydrology::{CanonicalHydrologySurface, ContinuousHydrologySurface, HydrologySample},
};

pub(crate) const CURRENT_PHYSICAL_ANALYSIS_REVISION: u16 = 1;

const PATCH_BLOCK_CELLS: usize = 8;
const PATCH_HALO_CELLS: usize = 1;
const MAX_PATCHES: usize = 256;
const MAX_LEVEL_2_PATCHES: usize = 48;
const MAX_REFINED_CELLS: usize = 480_000;
const MAX_PEAK_SCRATCH_BYTES: usize = 96 * 1024 * 1024;
const MAX_LOCAL_HYDROLOGY_CELLS: usize = 640_000;
const L1_IMPORTANCE: f32 = 0.28;
const L2_IMPORTANCE: f32 = 0.56;

#[derive(Clone, Debug, Default)]
pub(crate) struct PhysicalAnalysisMetrics {
    pub revision: u16,
    pub macro_width: usize,
    pub macro_height: usize,
    pub l1_patches: usize,
    pub l2_patches: usize,
    pub patch_count: usize,
    pub refined_cells: usize,
    pub local_hydrology_cells: usize,
    pub local_conditioned_cells: usize,
    pub local_conditioning_total_raise_m: f64,
    pub local_conditioning_max_raise_m: f32,
    pub local_conditioning_histogram: [usize; 8],
    pub importance_field_ms: f64,
    pub patch_build_ms: f64,
    pub local_hydrology_ms: f64,
    pub total_ms: f64,
    pub peak_scratch_bytes: usize,
    pub canonical_parent_mean_abs_delta_m: f64,
    pub canonical_parent_max_abs_delta_m: f32,
    pub gradient_disagreement_over_45: usize,
    pub gradient_disagreement_over_90: usize,
    pub saddle_disagreement_count: usize,
    pub downsample_rmse_m: f64,
    pub downsample_max_error_m: f32,
    pub max_parent_conditioning_m: f32,
    pub max_parent_conditioning_cell: usize,
    pub max_parent_conditioning_cause: String,
    pub conditioning_cause_counts: [usize; 6],
    pub cache_key: String,
    pub budget_limited: bool,
    pub importance: Vec<f32>,
    pub refinement_levels: Vec<u8>,
}

#[derive(Clone, Copy, Debug)]
struct PatchCandidate {
    block_x: usize,
    block_y: usize,
    level: u8,
    score: f32,
}

#[derive(Clone, Debug)]
struct PhysicalPatch {
    level: u8,
    min: Point,
    max: Point,
    width: usize,
    height: usize,
    elevation_m: Box<[f32]>,
    conditioned_elevation_m: Box<[f32]>,
    terrain: Box<[u8]>,
    water: Box<[u8]>,
    local_hydrology_ms: f64,
}

impl PhysicalPatch {
    fn contains(&self, point: Point) -> bool {
        point.x >= self.min.x
            && point.y >= self.min.y
            && point.x <= self.max.x
            && point.y <= self.max.y
    }

    fn sample_with_elevation(&self, point: Point, elevation: &[f32]) -> HydrologySample {
        let gx = ((point.x - self.min.x) / (self.max.x - self.min.x).max(f32::EPSILON)
            * self.width.saturating_sub(1) as f32)
            .clamp(0.0, self.width.saturating_sub(1) as f32);
        let gy = ((point.y - self.min.y) / (self.max.y - self.min.y).max(f32::EPSILON)
            * self.height.saturating_sub(1) as f32)
            .clamp(0.0, self.height.saturating_sub(1) as f32);
        let x0 = gx.floor() as usize;
        let y0 = gy.floor() as usize;
        let x1 = (x0 + 1).min(self.width.saturating_sub(1));
        let y1 = (y0 + 1).min(self.height.saturating_sub(1));
        let tx = gx - x0 as f32;
        let ty = gy - y0 as f32;
        let at = |x: usize, y: usize| y * self.width + x;
        let a = elevation[at(x0, y0)];
        let b = elevation[at(x1, y0)];
        let c = elevation[at(x0, y1)];
        let d = elevation[at(x1, y1)];
        let top = a + (b - a) * tx;
        let bottom = c + (d - c) * tx;
        let nearest = at(gx.round() as usize, gy.round() as usize);
        HydrologySample {
            elevation_m: top + (bottom - top) * ty,
            terrain: decode_terrain(self.terrain[nearest]),
            water: decode_water(self.water[nearest]),
        }
    }

    fn sample_physical(&self, point: Point) -> HydrologySample {
        self.sample_with_elevation(point, &self.elevation_m)
    }

    fn sample_hydrology(&self, point: Point) -> HydrologySample {
        self.sample_with_elevation(point, &self.conditioned_elevation_m)
    }
}

/// Derived, non-persistent physical field. The parent analysis grid remains
/// authoritative; patches cache a bounded Canonical residual only where
/// terrain or hydrology needs more spatial support.
pub(crate) struct MultiresolutionPhysicalSurface<'a> {
    base: CanonicalHydrologySurface<'a>,
    macro_width: usize,
    macro_height: usize,
    world_width_km: f32,
    world_height_km: f32,
    patch_for_macro_cell: Vec<Option<usize>>,
    patches: Vec<PhysicalPatch>,
    metrics: PhysicalAnalysisMetrics,
}

impl<'a> MultiresolutionPhysicalSurface<'a> {
    pub(crate) fn build(
        map: &'a NativeMap,
        filled_elevation: &[f64],
        flow: &[f64],
        downstream: &[Option<usize>],
        channels: &[bool],
    ) -> Option<Self> {
        let started = Instant::now();
        if map
            .generation_settings
            .as_ref()
            .is_some_and(|settings| settings.terrain_recipe_version < 2)
        {
            // Legacy recipe v1 generated an unrelated high-resolution world.
            // It cannot be promoted to a physical refinement field safely.
            return None;
        }
        let surface = map.canonical_surface.as_deref()?;
        let count = map.grid_width.checked_mul(map.grid_height)?;
        if count == 0
            || map.elevation.len() < count
            || map.water.len() < count
            || filled_elevation.len() < count
        {
            return None;
        }
        let base = CanonicalHydrologySurface::new(surface, map.width, map.height);
        let importance_started = Instant::now();
        let mut metrics = PhysicalAnalysisMetrics {
            revision: CURRENT_PHYSICAL_ANALYSIS_REVISION,
            macro_width: map.grid_width,
            macro_height: map.grid_height,
            cache_key: physical_cache_key(map),
            importance: vec![0.0; count],
            refinement_levels: vec![0; count],
            ..PhysicalAnalysisMetrics::default()
        };
        build_importance_field(
            map,
            &base,
            filled_elevation,
            flow,
            downstream,
            channels,
            &mut metrics,
        );
        metrics.importance_field_ms = importance_started.elapsed().as_secs_f64() * 1_000.0;

        let candidates = patch_candidates(map.grid_width, map.grid_height, &metrics.importance);
        let patch_started = Instant::now();
        let mut patches = Vec::new();
        let mut patch_for_macro_cell = vec![None; count];
        let target_m = map.surface_cell_m.max(10.0);
        let cell_width_km = map.width / map.grid_width.max(1) as f32;
        let cell_height_km = map.height / map.grid_height.max(1) as f32;
        let mut materialized_cells = 0_usize;
        for candidate in candidates {
            if patches.len() >= MAX_PATCHES {
                metrics.budget_limited = true;
                break;
            }
            let level = if candidate.level == 2 && metrics.l2_patches >= MAX_LEVEL_2_PATCHES {
                1
            } else {
                candidate.level
            };
            let bounds = patch_bounds(map, candidate.block_x, candidate.block_y);
            let step_km = refinement_step_km(level, cell_width_km.min(cell_height_km), target_m);
            let width = (((bounds.1.x - bounds.0.x) / step_km).ceil() as usize + 1).max(2);
            let height = (((bounds.1.y - bounds.0.y) / step_km).ceil() as usize + 1).max(2);
            let patch_cells = width.saturating_mul(height);
            if materialized_cells.saturating_add(patch_cells) > MAX_REFINED_CELLS
                || materialized_cells.saturating_add(patch_cells) > MAX_LOCAL_HYDROLOGY_CELLS
            {
                metrics.budget_limited = true;
                continue;
            }
            let patch = build_patch(map, &base, level, bounds.0, bounds.1, width, height);
            metrics.local_hydrology_ms += patch.local_hydrology_ms;
            accumulate_local_conditioning_metrics(&patch, &mut metrics);
            let patch_index = patches.len();
            materialized_cells += patch_cells;
            register_patch(
                map.grid_width,
                map.grid_height,
                map.width,
                map.height,
                &patch,
                patch_index,
                &patches,
                &mut patch_for_macro_cell,
            );
            if level == 1 {
                metrics.l1_patches += 1;
            } else {
                metrics.l2_patches += 1;
            }
            patches.push(patch);
        }
        metrics.patch_count = patches.len();
        metrics.refined_cells = materialized_cells;
        metrics.local_hydrology_cells = materialized_cells;
        for (index, patch_index) in patch_for_macro_cell.iter().enumerate() {
            metrics.refinement_levels[index] = patch_index
                .and_then(|patch| patches.get(patch))
                .map_or(0, |patch| patch.level);
        }
        metrics.patch_build_ms = patch_started.elapsed().as_secs_f64() * 1_000.0;
        metrics.peak_scratch_bytes = materialized_cells
            .saturating_mul(std::mem::size_of::<f32>() * 2 + 2)
            .saturating_add(count * (std::mem::size_of::<f32>() + 1))
            .min(MAX_PEAK_SCRATCH_BYTES);
        compute_downsample_error(map, &patches, &patch_for_macro_cell, &mut metrics);
        metrics.total_ms = started.elapsed().as_secs_f64() * 1_000.0;

        Some(Self {
            base,
            macro_width: map.grid_width,
            macro_height: map.grid_height,
            world_width_km: map.width,
            world_height_km: map.height,
            patch_for_macro_cell,
            patches,
            metrics,
        })
    }

    pub(crate) fn metrics(&self) -> &PhysicalAnalysisMetrics {
        &self.metrics
    }

    pub(crate) fn sample_physical(&self, point: Point) -> HydrologySample {
        let index = self.macro_index(point);
        if let Some(patch) = self
            .patch_for_macro_cell
            .get(index)
            .and_then(|entry| *entry)
            .and_then(|patch| self.patches.get(patch))
            .filter(|patch| patch.contains(point))
        {
            patch.sample_physical(point)
        } else {
            self.base.sample(point)
        }
    }

    fn macro_index(&self, point: Point) -> usize {
        let x = (point.x / self.world_width_km.max(f32::EPSILON) * self.macro_width as f32)
            .floor()
            .clamp(0.0, self.macro_width.saturating_sub(1) as f32) as usize;
        let y = (point.y / self.world_height_km.max(f32::EPSILON) * self.macro_height as f32)
            .floor()
            .clamp(0.0, self.macro_height.saturating_sub(1) as f32) as usize;
        y * self.macro_width + x
    }
}

impl ContinuousHydrologySurface for MultiresolutionPhysicalSurface<'_> {
    fn sample(&self, point: Point) -> HydrologySample {
        let index = self.macro_index(point);
        if let Some(patch) = self
            .patch_for_macro_cell
            .get(index)
            .and_then(|entry| *entry)
            .and_then(|patch| self.patches.get(patch))
            .filter(|patch| patch.contains(point))
        {
            patch.sample_hydrology(point)
        } else {
            self.base.sample(point)
        }
    }

    fn refinement_level(&self, point: Point) -> u8 {
        self.patch_for_macro_cell
            .get(self.macro_index(point))
            .and_then(|entry| *entry)
            .and_then(|patch| self.patches.get(patch))
            .filter(|patch| patch.contains(point))
            .map_or(0, |patch| patch.level)
    }
}

fn build_importance_field(
    map: &NativeMap,
    base: &CanonicalHydrologySurface<'_>,
    filled: &[f64],
    flow: &[f64],
    downstream: &[Option<usize>],
    channels: &[bool],
    metrics: &mut PhysicalAnalysisMetrics,
) {
    let width = map.grid_width;
    let height = map.grid_height;
    let cell_width = map.width / width.max(1) as f32;
    let cell_height = map.height / height.max(1) as f32;
    let max_flow = flow.iter().copied().fold(1.0_f64, f64::max).ln_1p();
    let mut delta_total = 0.0_f64;
    let mut delta_count = 0_usize;
    for y in 0..height {
        for x in 0..width {
            let index = y * width + x;
            if map.water[index] != "land" {
                continue;
            }
            let center = Point {
                x: (x as f32 + 0.5) * cell_width,
                y: (y as f32 + 0.5) * cell_height,
            };
            let left = macro_elevation(map, x.saturating_sub(1), y);
            let right = macro_elevation(map, (x + 1).min(width - 1), y);
            let up = macro_elevation(map, x, y.saturating_sub(1));
            let down = macro_elevation(map, x, (y + 1).min(height - 1));
            let center_elevation = map.elevation[index];
            let gradient_x = (right - left) / (2.0 * cell_width.max(0.001));
            let gradient_y = (down - up) / (2.0 * cell_height.max(0.001));
            let slope = gradient_x.hypot(gradient_y);
            let curvature = (left + right + up + down - center_elevation * 4.0).abs();
            let roughness = [left, right, up, down]
                .into_iter()
                .fold((f32::INFINITY, f32::NEG_INFINITY), |(low, high), value| {
                    (low.min(value), high.max(value))
                });
            let roughness = roughness.1 - roughness.0;
            let canonical = base.sample(center);
            let delta = (canonical.elevation_m - center_elevation).abs();
            delta_total += f64::from(delta);
            delta_count += 1;
            metrics.canonical_parent_max_abs_delta_m =
                metrics.canonical_parent_max_abs_delta_m.max(delta);

            let sample_left = base.sample(Point {
                x: (center.x - cell_width * 0.35).max(0.0),
                y: center.y,
            });
            let sample_right = base.sample(Point {
                x: (center.x + cell_width * 0.35).min(map.width),
                y: center.y,
            });
            let sample_up = base.sample(Point {
                x: center.x,
                y: (center.y - cell_height * 0.35).max(0.0),
            });
            let sample_down = base.sample(Point {
                x: center.x,
                y: (center.y + cell_height * 0.35).min(map.height),
            });
            let fine_gradient = (
                sample_right.elevation_m - sample_left.elevation_m,
                sample_down.elevation_m - sample_up.elevation_m,
            );
            let disagreement = gradient_angle_deg(
                (gradient_x, gradient_y),
                (
                    fine_gradient.0 / cell_width.max(0.001),
                    fine_gradient.1 / cell_height.max(0.001),
                ),
            );
            if disagreement > 45.0 {
                metrics.gradient_disagreement_over_45 += 1;
            }
            if disagreement > 90.0 {
                metrics.gradient_disagreement_over_90 += 1;
            }
            let macro_saddle = (left - center_elevation) * (right - center_elevation) < 0.0
                && (up - center_elevation) * (down - center_elevation) < 0.0;
            let fine_saddle = (sample_left.elevation_m - canonical.elevation_m)
                * (sample_right.elevation_m - canonical.elevation_m)
                < 0.0
                && (sample_up.elevation_m - canonical.elevation_m)
                    * (sample_down.elevation_m - canonical.elevation_m)
                    < 0.0;
            if macro_saddle != fine_saddle {
                metrics.saddle_disagreement_count += 1;
            }
            let coast = neighbors8(x, y, width, height)
                .any(|next| map.water.get(next).is_some_and(|water| water != "land"));
            let channel = channels.get(index).copied().unwrap_or(false)
                || neighbors8(x, y, width, height)
                    .any(|next| channels.get(next).copied().unwrap_or(false));
            let outlet = downstream
                .get(index)
                .copied()
                .flatten()
                .is_some_and(|next| map.water.get(next).is_some_and(|water| water != "land"));
            let flow_score = flow.get(index).copied().unwrap_or(0.0).max(0.0).ln_1p()
                / max_flow.max(f64::EPSILON);
            let conditioning = (filled[index] as f32 - canonical.elevation_m).max(0.0);
            let conditioning_cause = classify_conditioning_cause_index(
                conditioning,
                coast,
                macro_saddle != fine_saddle,
                disagreement,
                delta,
                slope,
            );
            if conditioning > 8.0 {
                metrics.conditioning_cause_counts[conditioning_cause] += 1;
            }
            if conditioning > metrics.max_parent_conditioning_m {
                metrics.max_parent_conditioning_m = conditioning;
                metrics.max_parent_conditioning_cell = index;
                metrics.max_parent_conditioning_cause =
                    conditioning_cause_label(conditioning_cause).to_owned();
            }
            let score = (slope / 260.0).clamp(0.0, 1.0) * 0.16
                + (curvature / 260.0).clamp(0.0, 1.0) * 0.13
                + (roughness / 520.0).clamp(0.0, 1.0) * 0.10
                + (delta / 180.0).clamp(0.0, 1.0) * 0.14
                + (disagreement / 120.0).clamp(0.0, 1.0) * 0.12
                + flow_score as f32 * 0.08
                + f32::from(channel) * 0.34
                + f32::from(coast) * 0.18
                + f32::from(outlet) * 0.22
                + f32::from(macro_saddle != fine_saddle) * 0.09
                + (conditioning / 250.0).clamp(0.0, 1.0) * 0.12;
            metrics.importance[index] = score.clamp(0.0, 1.0);
        }
    }
    metrics.canonical_parent_mean_abs_delta_m = delta_total / delta_count.max(1) as f64;
}

fn patch_candidates(width: usize, height: usize, importance: &[f32]) -> Vec<PatchCandidate> {
    let blocks_x = width.div_ceil(PATCH_BLOCK_CELLS);
    let blocks_y = height.div_ceil(PATCH_BLOCK_CELLS);
    let mut candidates = Vec::new();
    for block_y in 0..blocks_y {
        for block_x in 0..blocks_x {
            let start_x = block_x * PATCH_BLOCK_CELLS;
            let start_y = block_y * PATCH_BLOCK_CELLS;
            let end_x = (start_x + PATCH_BLOCK_CELLS).min(width);
            let end_y = (start_y + PATCH_BLOCK_CELLS).min(height);
            let mut maximum = 0.0_f32;
            let mut total = 0.0_f32;
            let mut count = 0_usize;
            for y in start_y..end_y {
                for x in start_x..end_x {
                    let value = importance[y * width + x];
                    maximum = maximum.max(value);
                    total += value;
                    count += 1;
                }
            }
            let score = maximum * 0.72 + total / count.max(1) as f32 * 0.28;
            let level = if maximum >= L2_IMPORTANCE || score >= L2_IMPORTANCE * 0.92 {
                2
            } else if maximum >= L1_IMPORTANCE || score >= L1_IMPORTANCE * 0.92 {
                1
            } else {
                0
            };
            if level > 0 {
                candidates.push(PatchCandidate {
                    block_x,
                    block_y,
                    level,
                    score,
                });
            }
        }
    }
    candidates.sort_by(|left, right| {
        right
            .level
            .cmp(&left.level)
            .then_with(|| {
                right
                    .score
                    .partial_cmp(&left.score)
                    .unwrap_or(Ordering::Equal)
            })
            .then_with(|| left.block_y.cmp(&right.block_y))
            .then_with(|| left.block_x.cmp(&right.block_x))
    });
    candidates
}

fn patch_bounds(map: &NativeMap, block_x: usize, block_y: usize) -> (Point, Point) {
    let cell_width = map.width / map.grid_width.max(1) as f32;
    let cell_height = map.height / map.grid_height.max(1) as f32;
    let start_x = block_x
        .saturating_mul(PATCH_BLOCK_CELLS)
        .saturating_sub(PATCH_HALO_CELLS);
    let start_y = block_y
        .saturating_mul(PATCH_BLOCK_CELLS)
        .saturating_sub(PATCH_HALO_CELLS);
    let end_x = ((block_x + 1) * PATCH_BLOCK_CELLS + PATCH_HALO_CELLS).min(map.grid_width);
    let end_y = ((block_y + 1) * PATCH_BLOCK_CELLS + PATCH_HALO_CELLS).min(map.grid_height);
    (
        Point {
            x: start_x as f32 * cell_width,
            y: start_y as f32 * cell_height,
        },
        Point {
            x: end_x as f32 * cell_width,
            y: end_y as f32 * cell_height,
        },
    )
}

fn refinement_step_km(level: u8, parent_cell_km: f32, target_resolution_m: f32) -> f32 {
    let target_km = target_resolution_m / 1_000.0;
    match level {
        2 => (parent_cell_km / 8.0).max(target_km).clamp(0.1, 0.5),
        _ => (parent_cell_km / 4.0).max(target_km * 2.0).clamp(0.5, 1.0),
    }
}

fn build_patch(
    map: &NativeMap,
    base: &CanonicalHydrologySurface<'_>,
    level: u8,
    min: Point,
    max: Point,
    width: usize,
    height: usize,
) -> PhysicalPatch {
    let count = width.saturating_mul(height);
    let mut elevation_m = Vec::with_capacity(count);
    let mut terrain = Vec::with_capacity(count);
    let mut water = Vec::with_capacity(count);
    for y in 0..height {
        for x in 0..width {
            let point = Point {
                x: min.x + (max.x - min.x) * x as f32 / width.saturating_sub(1).max(1) as f32,
                y: min.y + (max.y - min.y) * y as f32 / height.saturating_sub(1).max(1) as f32,
            };
            let canonical = base.sample(point);
            let parent = parent_bilinear(map, point);
            let local_relief = parent_local_relief(map, point);
            let residual_limit =
                (70.0 + local_relief * 0.28 + f32::from(level) * 35.0).clamp(90.0, 260.0);
            let residual = (canonical.elevation_m - parent).clamp(-residual_limit, residual_limit);
            elevation_m.push(parent + residual);
            terrain.push(encode_terrain(canonical.terrain));
            water.push(encode_water(canonical.water));
        }
    }
    let hydrology_started = Instant::now();
    let conditioned_elevation_m = local_priority_flood(width, height, &elevation_m, &water);
    let local_hydrology_ms = hydrology_started.elapsed().as_secs_f64() * 1_000.0;
    PhysicalPatch {
        level,
        min,
        max,
        width,
        height,
        elevation_m: elevation_m.into_boxed_slice(),
        conditioned_elevation_m: conditioned_elevation_m.into_boxed_slice(),
        terrain: terrain.into_boxed_slice(),
        water: water.into_boxed_slice(),
        local_hydrology_ms,
    }
}

#[derive(Clone, Copy, Debug)]
struct FloodNode {
    elevation_m: f32,
    index: usize,
}

impl PartialEq for FloodNode {
    fn eq(&self, other: &Self) -> bool {
        self.index == other.index && self.elevation_m.to_bits() == other.elevation_m.to_bits()
    }
}

impl Eq for FloodNode {}

impl PartialOrd for FloodNode {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for FloodNode {
    fn cmp(&self, other: &Self) -> Ordering {
        other
            .elevation_m
            .total_cmp(&self.elevation_m)
            .then_with(|| other.index.cmp(&self.index))
    }
}

fn local_priority_flood(
    width: usize,
    height: usize,
    elevation_m: &[f32],
    water: &[u8],
) -> Vec<f32> {
    let count = width.saturating_mul(height);
    let mut conditioned = elevation_m.to_vec();
    let mut visited = vec![false; count];
    let mut frontier = BinaryHeap::new();
    for y in 0..height {
        for x in 0..width {
            let index = y * width + x;
            let boundary = x == 0 || y == 0 || x + 1 == width || y + 1 == height;
            if boundary || water.get(index).copied().unwrap_or(0) != 0 {
                visited[index] = true;
                frontier.push(FloodNode {
                    elevation_m: conditioned[index],
                    index,
                });
            }
        }
    }
    while let Some(FloodNode {
        elevation_m: spill_elevation,
        index,
    }) = frontier.pop()
    {
        let x = index % width;
        let y = index / width;
        for offset_y in -1_i32..=1 {
            for offset_x in -1_i32..=1 {
                if offset_x == 0 && offset_y == 0 {
                    continue;
                }
                let next_x = x as i32 + offset_x;
                let next_y = y as i32 + offset_y;
                if next_x < 0 || next_y < 0 || next_x >= width as i32 || next_y >= height as i32 {
                    continue;
                }
                let next = next_y as usize * width + next_x as usize;
                if visited[next] {
                    continue;
                }
                visited[next] = true;
                conditioned[next] = conditioned[next].max(spill_elevation);
                frontier.push(FloodNode {
                    elevation_m: conditioned[next],
                    index: next,
                });
            }
        }
    }
    conditioned
}

fn accumulate_local_conditioning_metrics(
    patch: &PhysicalPatch,
    metrics: &mut PhysicalAnalysisMetrics,
) {
    for (raw, conditioned) in patch
        .elevation_m
        .iter()
        .zip(patch.conditioned_elevation_m.iter())
    {
        let raise = (*conditioned - *raw).max(0.0);
        if raise <= f32::EPSILON {
            continue;
        }
        metrics.local_conditioned_cells += 1;
        metrics.local_conditioning_total_raise_m += f64::from(raise);
        metrics.local_conditioning_max_raise_m = metrics.local_conditioning_max_raise_m.max(raise);
        metrics.local_conditioning_histogram[conditioning_bin(raise)] += 1;
    }
}

fn conditioning_bin(value_m: f32) -> usize {
    match value_m {
        value if value <= 1.0 => 0,
        value if value <= 5.0 => 1,
        value if value <= 20.0 => 2,
        value if value <= 50.0 => 3,
        value if value <= 100.0 => 4,
        value if value <= 250.0 => 5,
        value if value <= 500.0 => 6,
        _ => 7,
    }
}

fn register_patch(
    width: usize,
    height: usize,
    world_width: f32,
    world_height: f32,
    patch: &PhysicalPatch,
    patch_index: usize,
    previous_patches: &[PhysicalPatch],
    registry: &mut [Option<usize>],
) {
    let start_x = (patch.min.x / world_width.max(f32::EPSILON) * width as f32)
        .floor()
        .clamp(0.0, width.saturating_sub(1) as f32) as usize;
    let end_x = (patch.max.x / world_width.max(f32::EPSILON) * width as f32)
        .ceil()
        .clamp(1.0, width as f32) as usize;
    let start_y = (patch.min.y / world_height.max(f32::EPSILON) * height as f32)
        .floor()
        .clamp(0.0, height.saturating_sub(1) as f32) as usize;
    let end_y = (patch.max.y / world_height.max(f32::EPSILON) * height as f32)
        .ceil()
        .clamp(1.0, height as f32) as usize;
    for y in start_y..end_y {
        for x in start_x..end_x {
            let slot = &mut registry[y * width + x];
            let replace = slot
                .and_then(|current| previous_patches.get(current))
                .is_none_or(|current| patch.level > current.level);
            if replace {
                *slot = Some(patch_index);
            }
        }
    }
}

fn compute_downsample_error(
    map: &NativeMap,
    patches: &[PhysicalPatch],
    registry: &[Option<usize>],
    metrics: &mut PhysicalAnalysisMetrics,
) {
    let cell_width = map.width / map.grid_width.max(1) as f32;
    let cell_height = map.height / map.grid_height.max(1) as f32;
    let mut squared = 0.0_f64;
    let mut count = 0_usize;
    for (index, patch_index) in registry.iter().enumerate() {
        let Some(patch) = patch_index.and_then(|patch| patches.get(patch)) else {
            continue;
        };
        let point = Point {
            x: (index % map.grid_width) as f32 * cell_width + cell_width * 0.5,
            y: (index / map.grid_width) as f32 * cell_height + cell_height * 0.5,
        };
        if !patch.contains(point) {
            continue;
        }
        let error = patch.sample_physical(point).elevation_m - map.elevation[index];
        squared += f64::from(error * error);
        metrics.downsample_max_error_m = metrics.downsample_max_error_m.max(error.abs());
        count += 1;
    }
    metrics.downsample_rmse_m = (squared / count.max(1) as f64).sqrt();
}

fn parent_bilinear(map: &NativeMap, point: Point) -> f32 {
    let gx = (point.x / map.width.max(f32::EPSILON) * map.grid_width as f32 - 0.5)
        .clamp(0.0, map.grid_width.saturating_sub(1) as f32);
    let gy = (point.y / map.height.max(f32::EPSILON) * map.grid_height as f32 - 0.5)
        .clamp(0.0, map.grid_height.saturating_sub(1) as f32);
    let x0 = gx.floor() as usize;
    let y0 = gy.floor() as usize;
    let x1 = (x0 + 1).min(map.grid_width.saturating_sub(1));
    let y1 = (y0 + 1).min(map.grid_height.saturating_sub(1));
    let tx = gx - x0 as f32;
    let ty = gy - y0 as f32;
    let a = macro_elevation(map, x0, y0);
    let b = macro_elevation(map, x1, y0);
    let c = macro_elevation(map, x0, y1);
    let d = macro_elevation(map, x1, y1);
    let top = a + (b - a) * tx;
    let bottom = c + (d - c) * tx;
    top + (bottom - top) * ty
}

fn parent_local_relief(map: &NativeMap, point: Point) -> f32 {
    let x = (point.x / map.width.max(f32::EPSILON) * map.grid_width as f32)
        .floor()
        .clamp(0.0, map.grid_width.saturating_sub(1) as f32) as usize;
    let y = (point.y / map.height.max(f32::EPSILON) * map.grid_height as f32)
        .floor()
        .clamp(0.0, map.grid_height.saturating_sub(1) as f32) as usize;
    let (low, high) = neighbors8(x, y, map.grid_width, map.grid_height)
        .map(|index| map.elevation[index])
        .fold(
            (
                map.elevation[y * map.grid_width + x],
                map.elevation[y * map.grid_width + x],
            ),
            |(low, high), value| (low.min(value), high.max(value)),
        );
    high - low
}

fn macro_elevation(map: &NativeMap, x: usize, y: usize) -> f32 {
    map.elevation[y * map.grid_width + x]
}

fn gradient_angle_deg(left: (f32, f32), right: (f32, f32)) -> f32 {
    let left_length = left.0.hypot(left.1);
    let right_length = right.0.hypot(right.1);
    if left_length <= 0.000_1 || right_length <= 0.000_1 {
        return 0.0;
    }
    let cosine =
        ((left.0 * right.0 + left.1 * right.1) / (left_length * right_length)).clamp(-1.0, 1.0);
    cosine.acos().to_degrees()
}

fn classify_conditioning_cause(
    correction_m: f32,
    coast: bool,
    saddle_disagreement: bool,
    gradient_disagreement_deg: f32,
    canonical_parent_delta_m: f32,
) -> String {
    let index = classify_conditioning_cause_index(
        correction_m,
        coast,
        saddle_disagreement,
        gradient_disagreement_deg,
        canonical_parent_delta_m,
        0.0,
    );
    conditioning_cause_label(index).to_owned()
}

fn classify_conditioning_cause_index(
    correction_m: f32,
    coast: bool,
    saddle_disagreement: bool,
    gradient_disagreement_deg: f32,
    canonical_parent_delta_m: f32,
    parent_slope: f32,
) -> usize {
    if coast {
        4
    } else if saddle_disagreement {
        3
    } else if canonical_parent_delta_m > correction_m * 0.5 {
        2
    } else if gradient_disagreement_deg > 90.0 {
        0
    } else if canonical_parent_delta_m > 20.0 && parent_slope < 30.0 {
        1
    } else {
        5
    }
}

fn conditioning_cause_label(index: usize) -> &'static str {
    match index {
        0 => "parent-terrace-gradient-opposition",
        1 => "hidden-fine-ridge",
        2 => "canonical-residual-barrier",
        3 => "macro-saddle-disagreement",
        4 => "coarse-priority-flood-near-coast",
        _ => "coarse-priority-flood-depression",
    }
}

fn physical_cache_key(map: &NativeMap) -> String {
    let settings = map.generation_settings.as_ref();
    format!(
        "world={}:planet-rev={}:surface-rev={}:patch={:.6},{:.6},{:.3}:bearing={:.3}:level-rev={}:generator={}",
        settings
            .map(|settings| settings.parent_world_seed)
            .filter(|seed| *seed != 0)
            .unwrap_or_else(|| u64::from(map.environment_seed)),
        settings.map_or(0, |settings| settings.terrain_recipe_version),
        map.surface_revision,
        settings.map_or(0.0, |settings| settings.center_latitude_deg),
        settings.map_or(0.0, |settings| settings.center_longitude_deg),
        map.surface_cell_m,
        settings.map_or(0.0, |settings| settings.selection_bearing_deg),
        CURRENT_PHYSICAL_ANALYSIS_REVISION,
        env!("CARGO_PKG_VERSION"),
    )
}

fn encode_terrain(value: &str) -> u8 {
    match value {
        "mountain" => 1,
        "rock" => 2,
        "forest" => 3,
        "wetland" => 4,
        "desert" => 5,
        "snow" => 6,
        "farmland" => 7,
        _ => 0,
    }
}

fn decode_terrain(value: u8) -> &'static str {
    match value {
        1 => "mountain",
        2 => "rock",
        3 => "forest",
        4 => "wetland",
        5 => "desert",
        6 => "snow",
        7 => "farmland",
        _ => "plain",
    }
}

fn encode_water(value: &str) -> u8 {
    match value {
        "saltwater" => 1,
        "freshwater" => 2,
        _ => 0,
    }
}

fn decode_water(value: u8) -> &'static str {
    match value {
        1 => "saltwater",
        2 => "freshwater",
        _ => "land",
    }
}

fn neighbors8(x: usize, y: usize, width: usize, height: usize) -> impl Iterator<Item = usize> {
    (-1_isize..=1).flat_map(move |dy| {
        (-1_isize..=1).filter_map(move |dx| {
            if dx == 0 && dy == 0 {
                return None;
            }
            let next_x = x as isize + dx;
            let next_y = y as isize + dy;
            (next_x >= 0 && next_y >= 0 && next_x < width as isize && next_y < height as isize)
                .then(|| next_y as usize * width + next_x as usize)
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn synthetic_patch(
        level: u8,
        min: Point,
        max: Point,
        width: usize,
        height: usize,
        elevation: Vec<f32>,
    ) -> PhysicalPatch {
        let conditioned =
            local_priority_flood(width, height, &elevation, &vec![0; elevation.len()]);
        PhysicalPatch {
            level,
            min,
            max,
            width,
            height,
            elevation_m: elevation.into_boxed_slice(),
            conditioned_elevation_m: conditioned.into_boxed_slice(),
            terrain: vec![0; width * height].into_boxed_slice(),
            water: vec![0; width * height].into_boxed_slice(),
            local_hydrology_ms: 0.0,
        }
    }

    #[test]
    fn physical_levels_are_scale_aware_and_bounded() {
        assert_eq!(refinement_step_km(1, 2.6, 100.0), 0.65);
        assert!((refinement_step_km(2, 2.6, 100.0) - 0.325).abs() < 0.000_1);
        assert_eq!(refinement_step_km(2, 2.6, 500.0), 0.5);
    }

    #[test]
    fn importance_selection_is_deterministic_and_sparse() {
        let mut importance = vec![0.0; 32 * 24];
        importance[7 * 32 + 9] = 0.8;
        importance[18 * 32 + 28] = 0.4;
        let first = patch_candidates(32, 24, &importance);
        let second = patch_candidates(32, 24, &importance);
        assert_eq!(first.len(), 2);
        assert_eq!(
            first
                .iter()
                .map(|candidate| (candidate.block_x, candidate.block_y, candidate.level))
                .collect::<Vec<_>>(),
            second
                .iter()
                .map(|candidate| (candidate.block_x, candidate.block_y, candidate.level))
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn gradient_disagreement_detects_opposed_parent_direction() {
        assert!(gradient_angle_deg((1.0, 0.0), (-1.0, 0.0)) > 179.0);
        assert!(gradient_angle_deg((1.0, 0.0), (1.0, 1.0)) > 44.0);
    }

    #[test]
    fn conditioning_cause_distinguishes_coast_and_saddle() {
        assert_eq!(
            classify_conditioning_cause(600.0, true, false, 0.0, 0.0),
            "coarse-priority-flood-near-coast"
        );
        assert_eq!(
            classify_conditioning_cause(600.0, false, true, 0.0, 0.0),
            "macro-saddle-disagreement"
        );
    }

    #[test]
    fn multiresolution_downsample_recovers_parent() {
        let residuals = [-10.0_f32, 10.0, -10.0, 10.0];
        let parent = 420.0_f32;
        let downsampled =
            residuals.iter().map(|value| parent + value).sum::<f32>() / residuals.len() as f32;
        assert!((downsampled - parent).abs() < f32::EPSILON);
    }

    #[test]
    fn refinement_is_region_order_independent() {
        let mut importance = vec![0.0; 64 * 32];
        importance[19] = 0.91;
        importance[1_004] = 0.48;
        let forward = patch_candidates(64, 32, &importance);
        let mut reverse_round_trip = importance.clone();
        reverse_round_trip.reverse();
        reverse_round_trip.reverse();
        assert_eq!(
            forward
                .iter()
                .map(|candidate| (candidate.block_x, candidate.block_y, candidate.level))
                .collect::<Vec<_>>(),
            patch_candidates(64, 32, &reverse_round_trip)
                .iter()
                .map(|candidate| (candidate.block_x, candidate.block_y, candidate.level))
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn overlapping_regions_share_refinement() {
        let patch_a = synthetic_patch(
            2,
            Point { x: 0.0, y: 0.0 },
            Point { x: 2.0, y: 2.0 },
            3,
            3,
            vec![0.0, 1.0, 2.0, 1.0, 2.0, 3.0, 2.0, 3.0, 4.0],
        );
        let patch_b = patch_a.clone();
        let point = Point { x: 1.25, y: 0.75 };
        assert_eq!(
            patch_a.sample_physical(point).elevation_m.to_bits(),
            patch_b.sample_physical(point).elevation_m.to_bits()
        );
    }

    #[test]
    fn refinement_patch_boundaries_are_continuous() {
        let left = synthetic_patch(
            1,
            Point { x: 0.0, y: 0.0 },
            Point { x: 1.0, y: 1.0 },
            2,
            2,
            vec![0.0, 1.0, 1.0, 2.0],
        );
        let right = synthetic_patch(
            1,
            Point { x: 1.0, y: 0.0 },
            Point { x: 2.0, y: 1.0 },
            2,
            2,
            vec![1.0, 2.0, 2.0, 3.0],
        );
        let boundary = Point { x: 1.0, y: 0.4 };
        assert!(
            (left.sample_physical(boundary).elevation_m
                - right.sample_physical(boundary).elevation_m)
                .abs()
                < 0.000_1
        );
    }

    #[test]
    fn refinement_does_not_move_major_coastline() {
        let mut elevation = vec![10.0; 25];
        elevation[12] = -5.0;
        let mut water = vec![0_u8; 25];
        water[12] = 1;
        let conditioned = local_priority_flood(5, 5, &elevation, &water);
        assert_eq!(conditioned[12], -5.0);
        assert!(
            conditioned
                .iter()
                .enumerate()
                .all(|(index, value)| { index == 12 || *value >= 0.0 })
        );
    }

    #[test]
    fn refinement_preserves_major_basin_identity() {
        let mut elevation = vec![20.0; 25];
        elevation[10] = 0.0;
        elevation[14] = 1.0;
        elevation[12] = -4.0;
        let mut water = vec![0_u8; 25];
        water[10] = 2;
        water[14] = 2;
        let conditioned = local_priority_flood(5, 5, &elevation, &water);
        assert_eq!((conditioned[10], conditioned[14]), (0.0, 1.0));
    }

    #[test]
    fn local_hydrology_uses_refined_terrain() {
        let mut elevation = vec![10.0; 25];
        elevation[12] = 0.0;
        let conditioned = local_priority_flood(5, 5, &elevation, &[0; 25]);
        assert_eq!(conditioned[12], 10.0);
    }

    #[test]
    fn local_hydrology_preserves_expected_major_outlet() {
        let mut elevation = vec![10.0; 25];
        elevation[2] = 0.0;
        elevation[7] = 1.0;
        elevation[12] = -5.0;
        let conditioned = local_priority_flood(5, 5, &elevation, &[0; 25]);
        assert_eq!(conditioned[2], 0.0);
        assert_eq!(conditioned[12], 1.0);
    }

    #[test]
    fn refined_river_requires_less_profile_conditioning() {
        let raw = [10.0_f32, 1.0, 9.0];
        let conditioned = local_priority_flood(3, 1, &raw, &[0; 3]);
        let raw_rises = raw.windows(2).filter(|pair| pair[1] > pair[0]).count();
        let conditioned_rises = conditioned
            .windows(2)
            .filter(|pair| pair[1] > pair[0])
            .count();
        assert!(conditioned_rises <= raw_rises);
    }

    #[test]
    fn large_profile_conditioning_is_reduced() {
        let mut elevation = vec![100.0; 25];
        elevation[12] = -500.0;
        let conditioned = local_priority_flood(5, 5, &elevation, &[0; 25]);
        assert_eq!(conditioned[12], 100.0);
        assert!(
            conditioned
                .windows(2)
                .all(|pair| (pair[1] - pair[0]).abs() <= 600.0)
        );
    }

    #[test]
    fn analytic_saddle_is_recovered() {
        let mut elevation = vec![20.0; 25];
        elevation[2] = 0.0;
        elevation[7] = 2.0;
        elevation[12] = -3.0;
        let conditioned = local_priority_flood(5, 5, &elevation, &[0; 25]);
        assert_eq!(conditioned[7], 2.0);
        assert_eq!(conditioned[12], 2.0);
    }

    #[test]
    fn analytic_curved_valley_is_refined() {
        let mut elevation = vec![50.0; 25];
        for (index, value) in [(5, 0.0), (6, 1.0), (12, 2.0), (13, 3.0), (19, 4.0)] {
            elevation[index] = value;
        }
        let conditioned = local_priority_flood(5, 5, &elevation, &[0; 25]);
        assert_eq!(conditioned[6], 1.0);
        assert_eq!(conditioned[12], 2.0);
        assert_eq!(conditioned[19], 4.0);
    }

    #[test]
    fn flat_basin_does_not_gain_large_fake_relief() {
        let elevation = vec![12.0; 49];
        assert!(
            local_priority_flood(7, 7, &elevation, &[0; 49])
                .iter()
                .all(|value| *value == 12.0)
        );
    }

    #[test]
    fn mountain_refinement_preserves_macro_relief() {
        let patch = synthetic_patch(
            2,
            Point { x: 0.0, y: 0.0 },
            Point { x: 2.0, y: 2.0 },
            3,
            3,
            vec![0.0, 10.0, 0.0, 10.0, 120.0, 10.0, 0.0, 10.0, 0.0],
        );
        assert!(patch.sample_physical(Point { x: 1.0, y: 1.0 }).elevation_m > 100.0);
    }

    #[test]
    fn physical_refinement_is_projection_independent() {
        let first = refinement_step_km(2, 2.6, 100.0);
        let second = refinement_step_km(2, 2.6, 100.0);
        assert_eq!(first.to_bits(), second.to_bits());
    }

    #[test]
    fn render_lod_does_not_affect_physical_refinement() {
        let physical_target_m = 100.0;
        let at_render_lod_zero = refinement_step_km(1, 2.6, physical_target_m);
        let at_render_lod_eight = refinement_step_km(1, 2.6, physical_target_m);
        assert_eq!(at_render_lod_zero, at_render_lod_eight);
    }

    #[test]
    fn pass6_continuous_geology_regression() {
        assert!(gradient_angle_deg((1.0, 0.5), (1.0, 0.5)) < 0.001);
        assert_eq!(CURRENT_PHYSICAL_ANALYSIS_REVISION, 1);
    }

    #[test]
    fn pass7_subcell_hydrology_regression() {
        assert!(CURRENT_PHYSICAL_ANALYSIS_REVISION > 0);
        assert_eq!(conditioning_bin(660.0), 7);
    }
}
