use std::{collections::HashMap, time::Instant};

use crate::{
    model::{CanonicalSurface, Point},
    spatial::{PlanetPosition, regional_metric_position_rotated},
};

pub(crate) const CURRENT_HYDROLOGY_GEOMETRY_VERSION: u16 = 3;

const ANCHOR_SAMPLES: usize = 4;
const BASE_LATERAL_SAMPLES: usize = 9;
const MAX_LATERAL_SAMPLES: usize = 17;
const MAX_PATH_SECTIONS: usize = 36;
const MAX_GEOMETRY_NODES_PER_EDGE: usize = 64;
const UPHILL_TOLERANCE_M: f32 = 8.0;
const STRICT_UPHILL_TOLERANCE_M: f32 = 0.25;
const DEEP_DEPRESSION_CONNECTOR_M: f32 = 100.0;

#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct ContinuousFlowTarget {
    pub index: usize,
    pub weight: f64,
}

#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct ContinuousFlowRoute {
    pub targets: [Option<ContinuousFlowTarget>; 2],
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct HydrologyWorldIdentity {
    pub parent_seed: u64,
    pub region_center: PlanetPosition,
    pub selection_bearing_deg: f64,
    pub planet_radius_m: f64,
}

#[derive(Clone, Debug)]
pub(crate) struct ChannelGeometryPath {
    pub from_cell: usize,
    pub to_cell: usize,
    pub points: Vec<Point>,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct HydrologyGeometryStats {
    pub routing_cells: usize,
    pub channel_cells: usize,
    pub refined_channel_cells: usize,
    pub micro_samples: usize,
    pub river_nodes: usize,
    pub fallback_count: usize,
    pub locally_conditioned_channel_cells: usize,
    pub numerically_conditioned_channel_cells: usize,
    pub relaxed_corridor_cells: usize,
    pub raw_uphill_violations: usize,
    pub conditioned_uphill_violations: usize,
    pub profile_conditioning_samples: usize,
    pub profile_conditioning_total_raise_m: f64,
    pub profile_conditioning_max_raise_m: f32,
    pub profile_conditioning_histogram: [usize; 8],
    pub top_conditioning_corridors: Vec<ConditioningCorridorDiagnostic>,
    pub lacustrine_connector_cells: usize,
    pub lacustrine_maximum_depth_m: f32,
    pub geometry_build_ms: f64,
    pub peak_scratch_bytes: usize,
    pub fallback_reasons: Vec<String>,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct ConditioningCorridorDiagnostic {
    pub from_cell: usize,
    pub to_cell: usize,
    pub raw_uphill_violations: usize,
    pub total_raise_m: f64,
    pub maximum_raise_m: f32,
    pub maximum_raise_point: Option<Point>,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct SubcellHydrologyGeometry {
    pub paths: Vec<ChannelGeometryPath>,
    pub cell_anchors: Vec<Option<Point>>,
    pub stats: HydrologyGeometryStats,
}

#[derive(Clone, Copy)]
pub(crate) struct HydrologySample {
    pub elevation_m: f32,
    pub terrain: &'static str,
    pub water: &'static str,
}

type CorridorCandidate = Option<(Point, HydrologySample, f32)>;

pub(crate) trait ContinuousHydrologySurface {
    fn sample(&self, point: Point) -> HydrologySample;

    fn refinement_level(&self, _point: Point) -> u8 {
        0
    }
}

pub(crate) struct CanonicalHydrologySurface<'a> {
    surface: &'a CanonicalSurface,
    world_width_km: f32,
    world_height_km: f32,
}

impl<'a> CanonicalHydrologySurface<'a> {
    pub(crate) fn new(
        surface: &'a CanonicalSurface,
        world_width_km: f32,
        world_height_km: f32,
    ) -> Self {
        Self {
            surface,
            world_width_km,
            world_height_km,
        }
    }
}

impl ContinuousHydrologySurface for CanonicalHydrologySurface<'_> {
    fn sample(&self, point: Point) -> HydrologySample {
        let sample = self.surface.hydrology_sample_at_world(
            point,
            self.world_width_km,
            self.world_height_km,
        );
        HydrologySample {
            elevation_m: sample.elevation_m,
            terrain: sample.terrain,
            water: sample.water,
        }
    }
}

pub(crate) struct AnalysisHydrologySurface<'a> {
    width: usize,
    height: usize,
    world_width_km: f32,
    world_height_km: f32,
    elevation: &'a [f32],
    terrain: &'a [String],
    water: &'a [String],
}

impl<'a> AnalysisHydrologySurface<'a> {
    pub(crate) fn new(
        width: usize,
        height: usize,
        world_width_km: f32,
        world_height_km: f32,
        elevation: &'a [f32],
        terrain: &'a [String],
        water: &'a [String],
    ) -> Self {
        Self {
            width,
            height,
            world_width_km,
            world_height_km,
            elevation,
            terrain,
            water,
        }
    }
}

impl ContinuousHydrologySurface for AnalysisHydrologySurface<'_> {
    fn sample(&self, point: Point) -> HydrologySample {
        let gx = (point.x / self.world_width_km.max(f32::EPSILON) * self.width as f32 - 0.5)
            .clamp(0.0, self.width.saturating_sub(1) as f32);
        let gy = (point.y / self.world_height_km.max(f32::EPSILON) * self.height as f32 - 0.5)
            .clamp(0.0, self.height.saturating_sub(1) as f32);
        let x0 = gx.floor() as usize;
        let y0 = gy.floor() as usize;
        let x1 = (x0 + 1).min(self.width.saturating_sub(1));
        let y1 = (y0 + 1).min(self.height.saturating_sub(1));
        let tx = gx - x0 as f32;
        let ty = gy - y0 as f32;
        let at = |x: usize, y: usize| y * self.width + x;
        let a = self.elevation.get(at(x0, y0)).copied().unwrap_or(0.0);
        let b = self.elevation.get(at(x1, y0)).copied().unwrap_or(a);
        let c = self.elevation.get(at(x0, y1)).copied().unwrap_or(a);
        let d = self.elevation.get(at(x1, y1)).copied().unwrap_or(a);
        let nearest = at(gx.round() as usize, gy.round() as usize);
        HydrologySample {
            elevation_m: (a + (b - a) * tx) + ((c + (d - c) * tx) - (a + (b - a) * tx)) * ty,
            terrain: static_terrain(
                self.terrain
                    .get(nearest)
                    .map(String::as_str)
                    .unwrap_or("plain"),
            ),
            water: static_water(
                self.water
                    .get(nearest)
                    .map(String::as_str)
                    .unwrap_or("land"),
            ),
        }
    }
}

pub(crate) struct SubcellHydrologyInput<'a> {
    pub width: usize,
    pub height: usize,
    pub world_width_km: f32,
    pub world_height_km: f32,
    pub identity: HydrologyWorldIdentity,
    pub water: &'a [String],
    pub filled_elevation: &'a [f64],
    pub terrain: &'a [String],
    pub flow: &'a [f64],
    pub downstream: &'a [Option<usize>],
    pub channels: &'a [bool],
    pub routing: &'a [ContinuousFlowRoute],
    pub surface: &'a dyn ContinuousHydrologySurface,
    pub apply_parent_conditioning: bool,
    pub reconcile_local_topology: bool,
}

struct SamplingContext<'a> {
    input: &'a SubcellHydrologyInput<'a>,
    cache: HashMap<(i32, i32), HydrologySample>,
    cell_conditioning_offsets: Vec<Option<f32>>,
    samples: usize,
}

impl<'a> SamplingContext<'a> {
    fn new(input: &'a SubcellHydrologyInput<'a>) -> Self {
        Self {
            input,
            cache: HashMap::new(),
            cell_conditioning_offsets: vec![None; input.width.saturating_mul(input.height)],
            samples: 0,
        }
    }

    fn sample(&mut self, point: Point) -> HydrologySample {
        let key = (
            (point.x * 10_000.0).round() as i32,
            (point.y * 10_000.0).round() as i32,
        );
        if let Some(sample) = self.cache.get(&key).copied() {
            return sample;
        }
        let base = self.input.surface.sample(point);
        let fill_correction = if self.input.apply_parent_conditioning {
            self.continuous_conditioning_offset(point)
        } else {
            0.0
        };
        let sample = HydrologySample {
            elevation_m: base.elevation_m + fill_correction.max(0.0),
            ..base
        };
        self.cache.insert(key, sample);
        self.samples += 1;
        sample
    }

    fn continuous_conditioning_offset(&mut self, point: Point) -> f32 {
        if self.input.filled_elevation.len() < self.input.width.saturating_mul(self.input.height) {
            return 0.0;
        }
        let gx = (point.x / self.input.world_width_km.max(f32::EPSILON) * self.input.width as f32
            - 0.5)
            .clamp(0.0, self.input.width.saturating_sub(1) as f32);
        let gy = (point.y / self.input.world_height_km.max(f32::EPSILON)
            * self.input.height as f32
            - 0.5)
            .clamp(0.0, self.input.height.saturating_sub(1) as f32);
        let x0 = gx.floor() as usize;
        let y0 = gy.floor() as usize;
        let x1 = (x0 + 1).min(self.input.width.saturating_sub(1));
        let y1 = (y0 + 1).min(self.input.height.saturating_sub(1));
        let tx = gx - x0 as f32;
        let ty = gy - y0 as f32;
        let a = self.cell_conditioning_offset(y0 * self.input.width + x0);
        let b = self.cell_conditioning_offset(y0 * self.input.width + x1);
        let c = self.cell_conditioning_offset(y1 * self.input.width + x0);
        let d = self.cell_conditioning_offset(y1 * self.input.width + x1);
        let top = a + (b - a) * tx;
        let bottom = c + (d - c) * tx;
        top + (bottom - top) * ty
    }

    fn cell_conditioning_offset(&mut self, index: usize) -> f32 {
        if let Some(value) = self.cell_conditioning_offsets.get(index).copied().flatten() {
            return value;
        }
        let center = cell_center(self.input, index);
        let canonical = self.input.surface.sample(center).elevation_m;
        let conditioned = self
            .input
            .filled_elevation
            .get(index)
            .copied()
            .unwrap_or(f64::from(canonical)) as f32;
        let value = conditioned - canonical;
        if let Some(slot) = self.cell_conditioning_offsets.get_mut(index) {
            *slot = Some(value);
        }
        self.samples += 1;
        value
    }
}

pub(crate) fn build_subcell_hydrology(
    input: &SubcellHydrologyInput<'_>,
) -> SubcellHydrologyGeometry {
    let started = Instant::now();
    let count = input.width.saturating_mul(input.height);
    let mut stats = HydrologyGeometryStats {
        routing_cells: input
            .routing
            .iter()
            .filter(|route| route.targets[0].is_some())
            .count(),
        channel_cells: input.channels.iter().filter(|channel| **channel).count(),
        ..HydrologyGeometryStats::default()
    };
    if count == 0
        || input.water.len() < count
        || input.downstream.len() < count
        || input.routing.len() < count
    {
        stats.fallback_count = 1;
        stats
            .fallback_reasons
            .push("invalid-input-dimensions".to_owned());
        return SubcellHydrologyGeometry {
            stats,
            ..SubcellHydrologyGeometry::default()
        };
    }

    let basin_ids = drainage_basin_ids(input.downstream, input.water);
    let mut sampling = SamplingContext::new(input);
    let mut anchors = vec![None; count];
    let mut anchor_order = (0..count)
        .filter(|index| {
            input.channels.get(*index).copied().unwrap_or(false) && input.water[*index] == "land"
        })
        .collect::<Vec<_>>();
    anchor_order.sort_by(|left, right| {
        let ordering = if input.reconcile_local_topology {
            input
                .filled_elevation
                .get(*left)
                .copied()
                .unwrap_or(0.0)
                .total_cmp(&input.filled_elevation.get(*right).copied().unwrap_or(0.0))
        } else {
            input
                .filled_elevation
                .get(*right)
                .copied()
                .unwrap_or(0.0)
                .total_cmp(&input.filled_elevation.get(*left).copied().unwrap_or(0.0))
        };
        ordering.then_with(|| left.cmp(right))
    });
    let primary_upstream = (!input.reconcile_local_topology).then(|| primary_upstream_cells(input));
    for index in anchor_order {
        let related_anchor = if input.reconcile_local_topology {
            input.downstream[index].and_then(|downstream| {
                anchors.get(downstream).copied().flatten().or_else(|| {
                    (input.water[downstream] != "land").then(|| cell_center(input, downstream))
                })
            })
        } else {
            primary_upstream
                .as_ref()
                .and_then(|primary| primary[index])
                .and_then(|upstream| anchors.get(upstream).copied().flatten())
        };
        anchors[index] = choose_cell_anchor(
            input,
            &mut sampling,
            index,
            related_anchor,
            input.reconcile_local_topology,
            basin_ids[index],
            &basin_ids,
        );
    }

    let mut paths = Vec::with_capacity(stats.channel_cells);
    for from in 0..count {
        if !input.channels.get(from).copied().unwrap_or(false) || input.water[from] != "land" {
            continue;
        }
        let Some(to) = input.downstream[from] else {
            continue;
        };
        if to >= count || to == from {
            stats.fallback_count += 1;
            stats
                .fallback_reasons
                .push(format!("cell-{from}:invalid-downstream"));
            continue;
        }
        let start = anchors[from].unwrap_or_else(|| cell_center(input, from));
        let target = if input.water[to] == "land" {
            anchors[to].unwrap_or_else(|| cell_center(input, to))
        } else {
            refine_water_boundary(&mut sampling, start, cell_center(input, to))
        };
        let local_start_elevation = sampling.sample(start).elevation_m;
        let parent_water_level = input
            .filled_elevation
            .get(from)
            .copied()
            .unwrap_or(f64::from(local_start_elevation)) as f32;
        let depression_depth = (parent_water_level - local_start_elevation).max(0.0);
        let outlet_rise = (sampling.sample(target).elevation_m - local_start_elevation).max(0.0);
        if !input.apply_parent_conditioning
            && depression_depth.max(outlet_rise) > DEEP_DEPRESSION_CONNECTOR_M
        {
            stats.lacustrine_connector_cells += 1;
            stats.lacustrine_maximum_depth_m = stats
                .lacustrine_maximum_depth_m
                .max(depression_depth.max(outlet_rise));
            continue;
        }
        let macro_direction = continuous_route_direction(input, from)
            .unwrap_or_else(|| normalized(sub(target, start)));
        let (mut points, refined, locally_conditioned) = refine_channel_edge(
            input,
            &mut sampling,
            start,
            target,
            macro_direction,
            basin_ids[from],
            &basin_ids,
            input.water[to] != "land",
        );
        if !refined && !locally_conditioned {
            stats.fallback_count += 1;
            stats
                .fallback_reasons
                .push(format!("cell-{from}:no-downhill-corridor"));
        }
        insert_cell_boundary_crossings(input, from, to, &mut points);
        points.dedup_by(|left, right| distance(*left, *right) <= 0.000_01);
        if points.len() > MAX_GEOMETRY_NODES_PER_EDGE {
            points = downsample_path(&points, MAX_GEOMETRY_NODES_PER_EDGE);
        }
        let profile = condition_longitudinal_profile(&mut sampling, &points);
        if locally_conditioned {
            stats.relaxed_corridor_cells += 1;
        }
        if profile.maximum_raise_m > UPHILL_TOLERANCE_M {
            stats.locally_conditioned_channel_cells += 1;
        } else if profile.maximum_raise_m > STRICT_UPHILL_TOLERANCE_M {
            stats.numerically_conditioned_channel_cells += 1;
        } else if refined {
            stats.refined_channel_cells += 1;
        }
        stats.raw_uphill_violations += profile.raw_uphill_violations;
        stats.conditioned_uphill_violations += profile.conditioned_uphill_violations;
        stats.profile_conditioning_samples += profile.samples;
        stats.profile_conditioning_total_raise_m += profile.total_raise_m;
        stats.profile_conditioning_max_raise_m = stats
            .profile_conditioning_max_raise_m
            .max(profile.maximum_raise_m);
        for (target, value) in stats
            .profile_conditioning_histogram
            .iter_mut()
            .zip(profile.raise_histogram)
        {
            *target += value;
        }
        if profile.maximum_raise_m > 0.0 {
            stats
                .top_conditioning_corridors
                .push(ConditioningCorridorDiagnostic {
                    from_cell: from,
                    to_cell: to,
                    raw_uphill_violations: profile.raw_uphill_violations,
                    total_raise_m: profile.total_raise_m,
                    maximum_raise_m: profile.maximum_raise_m,
                    maximum_raise_point: profile.maximum_raise_point,
                });
        }
        stats.river_nodes += points.len();
        paths.push(ChannelGeometryPath {
            from_cell: from,
            to_cell: to,
            points,
        });
    }
    stats.micro_samples = sampling.samples;
    stats.top_conditioning_corridors.sort_by(|left, right| {
        right
            .maximum_raise_m
            .total_cmp(&left.maximum_raise_m)
            .then_with(|| left.from_cell.cmp(&right.from_cell))
    });
    stats.top_conditioning_corridors.truncate(24);
    stats.peak_scratch_bytes = sampling.cache.capacity()
        * (std::mem::size_of::<(i32, i32)>() + std::mem::size_of::<HydrologySample>())
        + MAX_PATH_SECTIONS
            * MAX_LATERAL_SAMPLES
            * (std::mem::size_of::<f32>() * 2 + usize::BITS as usize / 8);
    stats.geometry_build_ms = started.elapsed().as_secs_f64() * 1_000.0;
    SubcellHydrologyGeometry {
        paths,
        cell_anchors: anchors,
        stats,
    }
}

fn choose_cell_anchor(
    input: &SubcellHydrologyInput<'_>,
    sampling: &mut SamplingContext<'_>,
    index: usize,
    related_anchor: Option<Point>,
    related_is_downstream: bool,
    basin: usize,
    basin_ids: &[usize],
) -> Option<Point> {
    let center = cell_center(input, index);
    let outgoing = continuous_route_direction(input, index).unwrap_or(Point { x: 1.0, y: 0.0 });
    let related_direction = related_anchor
        .map(|point| {
            if related_is_downstream {
                normalized(sub(point, center))
            } else {
                normalized(sub(center, point))
            }
        })
        .unwrap_or(outgoing);
    let axis = normalized(add(outgoing, related_direction));
    let downstream_elevation = related_is_downstream
        .then(|| related_anchor.map(|point| sampling.sample(point).elevation_m))
        .flatten();
    let cell_width = input.world_width_km / input.width.max(1) as f32;
    let cell_height = input.world_height_km / input.height.max(1) as f32;
    let mut best: Option<(f32, Point)> = None;
    for sample_y in 0..ANCHOR_SAMPLES {
        for sample_x in 0..ANCHOR_SAMPLES {
            let point = Point {
                x: (index % input.width) as f32 * cell_width
                    + (sample_x as f32 + 0.5) / ANCHOR_SAMPLES as f32 * cell_width,
                y: (index / input.width) as f32 * cell_height
                    + (sample_y as f32 + 0.5) / ANCHOR_SAMPLES as f32 * cell_height,
            };
            let sample = sampling.sample(point);
            if sample.water != "land"
                || analysis_cell_at(input, point)
                    .is_none_or(|cell| basin_ids.get(cell).copied() != Some(basin))
            {
                continue;
            }
            let offset = sub(point, center);
            let along = dot(offset, axis);
            let lateral = sub(offset, scale(axis, along));
            let center_distance = distance(point, center) / cell_width.min(cell_height).max(0.001);
            let line_distance = length(lateral) / cell_width.min(cell_height).max(0.001);
            let connection_turn = related_anchor.map_or(0.0, |related| {
                let connection = if related_is_downstream {
                    normalized(sub(related, point))
                } else {
                    normalized(sub(point, related))
                };
                (1.0 - dot(connection, axis).clamp(-1.0, 1.0)) * 3.2
            });
            let downstream_inversion = downstream_elevation.map_or(0.0, |downstream| {
                (downstream - sample.elevation_m - UPHILL_TOLERANCE_M).max(0.0)
            });
            let micro = deterministic_micro_value(input, point);
            let score = sample.elevation_m * 0.012
                + line_distance * 8.0
                + center_distance * 1.8
                + connection_turn
                + downstream_inversion * downstream_inversion * 0.35
                + terrain_resistance(sample.terrain) * 2.0
                + terrain_resistance(
                    input
                        .terrain
                        .get(index)
                        .map(String::as_str)
                        .unwrap_or("plain"),
                ) * 0.35
                + micro * 0.7;
            if best.is_none_or(|current| score < current.0) {
                best = Some((score, point));
            }
        }
    }
    best.map(|(_, point)| point).or(Some(center))
}

fn refine_channel_edge(
    input: &SubcellHydrologyInput<'_>,
    sampling: &mut SamplingContext<'_>,
    start: Point,
    end: Point,
    macro_direction: Point,
    basin: usize,
    basin_ids: &[usize],
    endpoint_is_water: bool,
) -> (Vec<Point>, bool, bool) {
    let chord = sub(end, start);
    let distance_km = length(chord);
    if distance_km <= 0.000_01 {
        return (vec![start, end], false, false);
    }
    let cell_width = input.world_width_km / input.width.max(1) as f32;
    let cell_height = input.world_height_km / input.height.max(1) as f32;
    let refinement_level = input
        .surface
        .refinement_level(start)
        .max(input.surface.refinement_level(lerp(start, end, 0.5)))
        .max(input.surface.refinement_level(end));
    let refinement_multiplier = match refinement_level {
        2 => 2.0,
        1 => 1.45,
        _ => 1.0,
    };
    let target_step =
        (cell_width.min(cell_height) / (7.0 * refinement_multiplier)).clamp(0.08, 0.75);
    let sections = (distance_km / target_step)
        .ceil()
        .clamp(4.0, MAX_PATH_SECTIONS as f32) as usize;
    let start_elevation = sampling.sample(start).elevation_m;
    let end_elevation = sampling.sample(end).elevation_m;
    let slope_m_per_km = ((start_elevation - end_elevation) / distance_km.max(0.001)).max(0.0);
    let lowland_freedom = (1.0 - slope_m_per_km / 160.0).clamp(0.08, 1.0);
    let corridor_half_width = cell_width.min(cell_height)
        * (0.06 + lowland_freedom * (0.24 + f32::from(refinement_level) * 0.035));
    let lateral_samples = match refinement_level {
        2 => 17,
        1 => 13,
        _ => BASE_LATERAL_SAMPLES,
    };
    let normal = normalized(Point {
        x: -chord.y,
        y: chord.x,
    });
    let mut candidates = Vec::<Vec<CorridorCandidate>>::with_capacity(sections + 1);
    for section in 0..=sections {
        if section == 0 {
            candidates.push(vec![Some((start, sampling.sample(start), 0.0))]);
            continue;
        }
        if section == sections {
            candidates.push(vec![Some((end, sampling.sample(end), 0.0))]);
            continue;
        }
        let t = section as f32 / sections as f32;
        let base = add(start, scale(chord, t));
        let mut layer = Vec::with_capacity(lateral_samples);
        for lateral_index in 0..lateral_samples {
            let unit = lateral_index as f32 / (lateral_samples - 1) as f32 * 2.0 - 1.0;
            let point = add(base, scale(normal, unit * corridor_half_width));
            let sample = sampling.sample(point);
            let allowed = point.x >= 0.0
                && point.y >= 0.0
                && point.x <= input.world_width_km
                && point.y <= input.world_height_km
                && sample.water == "land"
                && analysis_cell_at(input, point)
                    .is_some_and(|cell| basin_ids.get(cell).copied() == Some(basin));
            layer.push(allowed.then_some((point, sample, unit)));
        }
        candidates.push(layer);
    }

    let (indices, strictly_downhill, locally_conditioned) = if let Some(indices) = solve_corridor(
        input,
        &candidates,
        macro_direction,
        lowland_freedom,
        endpoint_is_water,
        false,
    ) {
        (indices, true, false)
    } else if let Some(indices) = solve_corridor(
        input,
        &candidates,
        macro_direction,
        lowland_freedom,
        endpoint_is_water,
        true,
    ) {
        (indices, false, true)
    } else {
        let fallback = terrain_constrained_fallback(input, sampling, start, end, basin, basin_ids);
        let locally_conditioned = fallback.len() > 2;
        return (fallback, false, locally_conditioned);
    };
    let mut points = (0..=sections)
        .filter_map(|section| candidates[section][indices[section]].map(|value| value.0))
        .collect::<Vec<_>>();
    simplify_near_collinear(&mut points);
    (points, strictly_downhill, locally_conditioned)
}

fn solve_corridor(
    input: &SubcellHydrologyInput<'_>,
    candidates: &[Vec<CorridorCandidate>],
    macro_direction: Point,
    lowland_freedom: f32,
    endpoint_is_water: bool,
    allow_conditioning: bool,
) -> Option<Vec<usize>> {
    let sections = candidates.len().checked_sub(1)?;
    let mut costs = candidates
        .iter()
        .map(|layer| vec![f32::INFINITY; layer.len()])
        .collect::<Vec<_>>();
    let mut parents = candidates
        .iter()
        .map(|layer| vec![usize::MAX; layer.len()])
        .collect::<Vec<_>>();
    costs[0][0] = 0.0;
    for section in 1..=sections {
        for current_index in 0..candidates[section].len() {
            let Some((current_point, current_sample, current_offset)) =
                candidates[section][current_index]
            else {
                continue;
            };
            for previous_index in 0..candidates[section - 1].len() {
                let Some((previous_point, previous_sample, previous_offset)) =
                    candidates[section - 1][previous_index]
                else {
                    continue;
                };
                let previous_cost = costs[section - 1][previous_index];
                if !previous_cost.is_finite() {
                    continue;
                }
                let rise = current_sample.elevation_m - previous_sample.elevation_m;
                let water_endpoint = endpoint_is_water && section == sections;
                if !allow_conditioning && rise > STRICT_UPHILL_TOLERANCE_M && !water_endpoint {
                    continue;
                }
                let step = sub(current_point, previous_point);
                let step_length = length(step).max(0.000_1);
                let direction = normalized(step);
                let alignment = dot(direction, macro_direction).clamp(-1.0, 1.0);
                let uphill = if water_endpoint {
                    0.0
                } else {
                    (rise - STRICT_UPHILL_TOLERANCE_M).max(0.0)
                };
                let total = previous_cost
                    + step_length
                    + uphill * uphill * 18.0
                    + (1.0 - alignment) * step_length * 7.0
                    + (current_offset - previous_offset).abs()
                        * (1.6 + (1.0 - lowland_freedom) * 4.0)
                    + terrain_resistance(current_sample.terrain) * step_length * 2.5
                    + current_offset.abs() * (1.0 - lowland_freedom) * 0.8
                    + deterministic_micro_value(input, current_point) * lowland_freedom * 0.85;
                if total < costs[section][current_index] {
                    costs[section][current_index] = total;
                    parents[section][current_index] = previous_index;
                }
            }
        }
    }
    if !costs[sections][0].is_finite() {
        return None;
    }
    let mut indices = vec![0_usize; sections + 1];
    for section in (1..=sections).rev() {
        let parent = parents[section][indices[section]];
        if parent == usize::MAX {
            return None;
        }
        indices[section - 1] = parent;
    }
    Some(indices)
}

#[derive(Clone, Copy, Debug, Default)]
struct LongitudinalProfileStats {
    raw_uphill_violations: usize,
    conditioned_uphill_violations: usize,
    samples: usize,
    total_raise_m: f64,
    maximum_raise_m: f32,
    maximum_raise_point: Option<Point>,
    raise_histogram: [usize; 8],
}

fn condition_longitudinal_profile(
    sampling: &mut SamplingContext<'_>,
    points: &[Point],
) -> LongitudinalProfileStats {
    let mut elevations = points
        .iter()
        .map(|point| sampling.sample(*point).elevation_m)
        .collect::<Vec<_>>();
    let raw_uphill_violations = elevations
        .windows(2)
        .filter(|pair| pair[1] > pair[0] + UPHILL_TOLERANCE_M)
        .count();
    let mut total_raise_m = 0.0_f64;
    let mut maximum_raise_m = 0.0_f32;
    let mut maximum_raise_point = None;
    let mut raise_histogram = [0_usize; 8];
    for index in (0..elevations.len().saturating_sub(1)).rev() {
        if elevations[index] < elevations[index + 1] {
            let raise = elevations[index + 1] - elevations[index];
            elevations[index] = elevations[index + 1];
            total_raise_m += f64::from(raise);
            raise_histogram[conditioning_histogram_bin(raise)] += 1;
            if raise > maximum_raise_m {
                maximum_raise_m = raise;
                maximum_raise_point = points.get(index).copied();
            }
        }
    }
    let conditioned_uphill_violations = elevations
        .windows(2)
        .filter(|pair| pair[1] > pair[0] + f32::EPSILON)
        .count();
    LongitudinalProfileStats {
        raw_uphill_violations,
        conditioned_uphill_violations,
        samples: elevations.len(),
        total_raise_m,
        maximum_raise_m,
        maximum_raise_point,
        raise_histogram,
    }
}

fn conditioning_histogram_bin(value_m: f32) -> usize {
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

fn terrain_constrained_fallback(
    input: &SubcellHydrologyInput<'_>,
    sampling: &mut SamplingContext<'_>,
    start: Point,
    end: Point,
    basin: usize,
    basin_ids: &[usize],
) -> Vec<Point> {
    let chord = sub(end, start);
    let normal = normalized(Point {
        x: -chord.y,
        y: chord.x,
    });
    let cell_width = input.world_width_km / input.width.max(1) as f32;
    let cell_height = input.world_height_km / input.height.max(1) as f32;
    let mut points = vec![start];
    let mut previous = sampling.sample(start).elevation_m;
    for step in 1..4 {
        let t = step as f32 / 4.0;
        let base = add(start, scale(chord, t));
        let mut best: Option<(f32, Point, f32)> = None;
        for offset in [-0.12_f32, -0.06, 0.0, 0.06, 0.12] {
            let point = add(base, scale(normal, offset * cell_width.min(cell_height)));
            let sample = sampling.sample(point);
            if sample.water != "land"
                || analysis_cell_at(input, point)
                    .is_none_or(|cell| basin_ids.get(cell).copied() != Some(basin))
            {
                continue;
            }
            let rise = (sample.elevation_m - previous - UPHILL_TOLERANCE_M).max(0.0);
            let score = sample.elevation_m
                + rise * rise * 18.0
                + offset.abs() * 20.0
                + deterministic_micro_value(input, point);
            if best.is_none_or(|current| score < current.0) {
                best = Some((score, point, sample.elevation_m));
            }
        }
        if let Some((_, point, elevation)) = best {
            points.push(point);
            previous = elevation;
        }
    }
    points.push(end);
    points
}

fn refine_water_boundary(sampling: &mut SamplingContext<'_>, land: Point, water: Point) -> Point {
    let mut low = 0.0_f32;
    let mut high = 1.0_f32;
    for _ in 0..18 {
        let mid = (low + high) * 0.5;
        let point = lerp(land, water, mid);
        if sampling.sample(point).water == "land" {
            low = mid;
        } else {
            high = mid;
        }
    }
    let inset = (0.05 / distance(land, water).max(0.05)).min(0.08);
    lerp(land, water, (low - inset).max(0.0))
}

fn insert_cell_boundary_crossings(
    input: &SubcellHydrologyInput<'_>,
    from: usize,
    to: usize,
    points: &mut Vec<Point>,
) {
    if points.len() < 2 || input.water.get(to).is_some_and(|water| water != "land") {
        return;
    }
    let mut insertion = None;
    for (index, pair) in points.windows(2).enumerate() {
        let left = analysis_cell_at(input, pair[0]);
        let right = analysis_cell_at(input, pair[1]);
        if left == Some(from) && right != Some(from) {
            insertion = shared_cell_boundary(input, from, to, pair[0], pair[1])
                .map(|point| (index + 1, point));
            break;
        }
    }
    if let Some((index, point)) = insertion
        && distance(points[index - 1], point) > 0.000_01
        && distance(point, points[index]) > 0.000_01
    {
        points.insert(index, point);
    }
}

fn shared_cell_boundary(
    input: &SubcellHydrologyInput<'_>,
    from: usize,
    to: usize,
    start: Point,
    end: Point,
) -> Option<Point> {
    let from_x = from % input.width;
    let from_y = from / input.width;
    let to_x = to % input.width;
    let to_y = to / input.width;
    if from_x.abs_diff(to_x) > 1 || from_y.abs_diff(to_y) > 1 {
        return None;
    }
    let cell_width = input.world_width_km / input.width.max(1) as f32;
    let cell_height = input.world_height_km / input.height.max(1) as f32;
    let mut candidates = Vec::new();
    if from_x != to_x {
        let x = from_x.max(to_x) as f32 * cell_width;
        if (end.x - start.x).abs() > f32::EPSILON {
            let t = (x - start.x) / (end.x - start.x);
            if (0.0..=1.0).contains(&t) {
                candidates.push((t, lerp(start, end, t)));
            }
        }
    }
    if from_y != to_y {
        let y = from_y.max(to_y) as f32 * cell_height;
        if (end.y - start.y).abs() > f32::EPSILON {
            let t = (y - start.y) / (end.y - start.y);
            if (0.0..=1.0).contains(&t) {
                candidates.push((t, lerp(start, end, t)));
            }
        }
    }
    candidates
        .into_iter()
        .min_by(|left, right| (left.0 - 0.5).abs().total_cmp(&(right.0 - 0.5).abs()))
        .map(|(_, point)| point)
}

fn continuous_route_direction(input: &SubcellHydrologyInput<'_>, index: usize) -> Option<Point> {
    let origin = cell_center(input, index);
    let mut direction = Point { x: 0.0, y: 0.0 };
    let mut total = 0.0_f32;
    for target in input.routing.get(index)?.targets.into_iter().flatten() {
        if target.index >= input.width.saturating_mul(input.height) {
            continue;
        }
        let candidate = normalized(sub(cell_center(input, target.index), origin));
        let weight = target.weight.clamp(0.0, 1.0) as f32;
        direction = add(direction, scale(candidate, weight));
        total += weight;
    }
    (total > f32::EPSILON && length(direction) > f32::EPSILON).then(|| normalized(direction))
}

fn primary_upstream_cells(input: &SubcellHydrologyInput<'_>) -> Vec<Option<usize>> {
    let count = input.width.saturating_mul(input.height);
    let mut upstream = vec![None; count];
    for (from, target) in input.downstream.iter().copied().enumerate().take(count) {
        let Some(to) = target else { continue };
        if to >= count || !input.channels.get(from).copied().unwrap_or(false) {
            continue;
        }
        if upstream[to].is_none_or(|current| {
            input.flow.get(from).copied().unwrap_or(0.0)
                > input.flow.get(current).copied().unwrap_or(0.0)
        }) {
            upstream[to] = Some(from);
        }
    }
    upstream
}

fn drainage_basin_ids(downstream: &[Option<usize>], water: &[String]) -> Vec<usize> {
    let count = downstream.len().min(water.len());
    let mut basins = vec![usize::MAX; count];
    for start in 0..count {
        if basins[start] != usize::MAX {
            continue;
        }
        let mut path = Vec::new();
        let mut current = start;
        let terminal = loop {
            if current >= count {
                break start;
            }
            if basins[current] != usize::MAX {
                break basins[current];
            }
            if path.contains(&current) || path.len() >= count {
                break current;
            }
            path.push(current);
            let Some(next) = downstream[current] else {
                break current;
            };
            if next >= count || water[next] != "land" {
                break next.min(count.saturating_sub(1));
            }
            current = next;
        };
        for cell in path {
            basins[cell] = terminal;
        }
    }
    basins
}

fn analysis_cell_at(input: &SubcellHydrologyInput<'_>, point: Point) -> Option<usize> {
    if !point.x.is_finite()
        || !point.y.is_finite()
        || point.x < 0.0
        || point.y < 0.0
        || point.x > input.world_width_km
        || point.y > input.world_height_km
    {
        return None;
    }
    let x = (point.x / input.world_width_km.max(f32::EPSILON) * input.width as f32)
        .floor()
        .clamp(0.0, input.width.saturating_sub(1) as f32) as usize;
    let y = (point.y / input.world_height_km.max(f32::EPSILON) * input.height as f32)
        .floor()
        .clamp(0.0, input.height.saturating_sub(1) as f32) as usize;
    Some(y * input.width + x)
}

fn cell_center(input: &SubcellHydrologyInput<'_>, index: usize) -> Point {
    let cell_width = input.world_width_km / input.width.max(1) as f32;
    let cell_height = input.world_height_km / input.height.max(1) as f32;
    Point {
        x: (index % input.width) as f32 * cell_width + cell_width * 0.5,
        y: (index / input.width) as f32 * cell_height + cell_height * 0.5,
    }
}

fn deterministic_micro_value(input: &SubcellHydrologyInput<'_>, point: Point) -> f32 {
    let position = regional_metric_position_rotated(
        input.identity.region_center,
        (f64::from(point.x) - f64::from(input.world_width_km) * 0.5) * 1_000.0,
        (f64::from(input.world_height_km) * 0.5 - f64::from(point.y)) * 1_000.0,
        input.identity.selection_bearing_deg,
        input.identity.planet_radius_m.max(1.0),
    );
    let mut value = input.identity.parent_seed ^ 0x6879_6472_6f6d_6963;
    for component in position.components() {
        value = mix64(value ^ (component * 1_000_000_000.0).round() as i64 as u64);
    }
    (value >> 40) as f32 / (1_u32 << 24) as f32
}

fn terrain_resistance(terrain: &str) -> f32 {
    match terrain {
        "rock" | "mountain" => 1.35,
        "desert" => 0.95,
        "forest" | "jungle" => 0.62,
        "grassland" | "farmland" | "plain" => 0.42,
        "wetland" => 0.12,
        _ => 0.55,
    }
}

fn static_terrain(value: &str) -> &'static str {
    match value {
        "forest" => "forest",
        "jungle" => "jungle",
        "grassland" => "grassland",
        "farmland" => "farmland",
        "desert" => "desert",
        "rock" => "rock",
        "mountain" => "mountain",
        "wetland" => "wetland",
        _ => "plain",
    }
}

fn static_water(value: &str) -> &'static str {
    match value {
        "saltwater" => "saltwater",
        "freshwater" => "freshwater",
        _ => "land",
    }
}

fn simplify_near_collinear(points: &mut Vec<Point>) {
    if points.len() < 3 {
        return;
    }
    let mut output = vec![points[0]];
    for index in 1..points.len() - 1 {
        let previous = *output.last().expect("path start");
        let current = points[index];
        let next = points[index + 1];
        let left = normalized(sub(current, previous));
        let right = normalized(sub(next, current));
        if dot(left, right) < 0.9995 || distance(previous, current) > 1.5 {
            output.push(current);
        }
    }
    output.push(*points.last().expect("path end"));
    *points = output;
}

fn downsample_path(points: &[Point], maximum: usize) -> Vec<Point> {
    if points.len() <= maximum {
        return points.to_vec();
    }
    (0..maximum)
        .map(|index| {
            let source = (index * (points.len() - 1) + (maximum - 1) / 2) / (maximum - 1);
            points[source]
        })
        .collect()
}

fn mix64(mut value: u64) -> u64 {
    value ^= value >> 30;
    value = value.wrapping_mul(0xbf58_476d_1ce4_e5b9);
    value ^= value >> 27;
    value = value.wrapping_mul(0x94d0_49bb_1331_11eb);
    value ^ (value >> 31)
}

fn add(left: Point, right: Point) -> Point {
    Point {
        x: left.x + right.x,
        y: left.y + right.y,
    }
}

fn sub(left: Point, right: Point) -> Point {
    Point {
        x: left.x - right.x,
        y: left.y - right.y,
    }
}

fn scale(point: Point, amount: f32) -> Point {
    Point {
        x: point.x * amount,
        y: point.y * amount,
    }
}

fn dot(left: Point, right: Point) -> f32 {
    left.x * right.x + left.y * right.y
}

fn length(point: Point) -> f32 {
    point.x.hypot(point.y)
}

fn normalized(point: Point) -> Point {
    let length = length(point);
    if length <= f32::EPSILON {
        Point { x: 1.0, y: 0.0 }
    } else {
        scale(point, 1.0 / length)
    }
}

fn distance(left: Point, right: Point) -> f32 {
    length(sub(left, right))
}

fn lerp(left: Point, right: Point, amount: f32) -> Point {
    add(left, scale(sub(right, left), amount))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct AnalyticSurface {
        slope_angle_deg: f32,
        curved_valley: bool,
    }

    impl ContinuousHydrologySurface for AnalyticSurface {
        fn sample(&self, point: Point) -> HydrologySample {
            let angle = self.slope_angle_deg.to_radians();
            let downhill = point.x * angle.cos() + point.y * angle.sin();
            let valley = if self.curved_valley {
                let center = 2.0 + (point.x * 0.42).sin() * 0.8;
                (point.y - center).powi(2) * 18.0
            } else {
                0.0
            };
            HydrologySample {
                elevation_m: 500.0 - downhill * 25.0 + valley,
                terrain: "plain",
                water: "land",
            }
        }
    }

    fn synthetic_input<'a>(
        surface: &'a dyn ContinuousHydrologySurface,
        routing: &'a [ContinuousFlowRoute],
        downstream: &'a [Option<usize>],
        channels: &'a [bool],
        water: &'a [String],
        terrain: &'a [String],
        flow: &'a [f64],
    ) -> SubcellHydrologyInput<'a> {
        SubcellHydrologyInput {
            width: 4,
            height: 2,
            world_width_km: 8.0,
            world_height_km: 4.0,
            identity: HydrologyWorldIdentity {
                parent_seed: 17,
                region_center: PlanetPosition::from_latitude_longitude_deg(12.0, 24.0),
                selection_bearing_deg: 0.0,
                planet_radius_m: 6_371_000.0,
            },
            water,
            filled_elevation: &[],
            terrain,
            flow,
            downstream,
            channels,
            routing,
            surface,
            apply_parent_conditioning: true,
            reconcile_local_topology: false,
        }
    }

    #[test]
    fn continuous_flow_direction_is_not_limited_to_eight_axes() {
        let route = ContinuousFlowRoute {
            targets: [
                Some(ContinuousFlowTarget {
                    index: 1,
                    weight: 0.68,
                }),
                Some(ContinuousFlowTarget {
                    index: 5,
                    weight: 0.32,
                }),
            ],
        };
        let routes = vec![route; 8];
        let downstream = vec![Some(1), Some(2), Some(3), None, None, None, None, None];
        let channels = vec![true, true, true, false, false, false, false, false];
        let water = vec!["land".to_owned(); 8];
        let terrain = vec!["plain".to_owned(); 8];
        let flow = vec![1.0; 8];
        let surface = AnalyticSurface {
            slope_angle_deg: 17.0,
            curved_valley: false,
        };
        let input = synthetic_input(
            &surface,
            &routes,
            &downstream,
            &channels,
            &water,
            &terrain,
            &flow,
        );
        let direction = continuous_route_direction(&input, 0).expect("direction");
        let degrees = direction
            .y
            .atan2(direction.x)
            .to_degrees()
            .rem_euclid(180.0);
        assert!(
            (degrees - 17.0).abs() < 8.0,
            "continuous direction was {degrees}"
        );
        assert!(
            [0.0_f32, 45.0, 90.0, 135.0]
                .iter()
                .all(|axis| (degrees - *axis).abs() > 2.0)
        );
    }

    #[test]
    fn channel_geometry_uses_subcell_entry_exit_points_and_is_deterministic() {
        let routes = (0..8)
            .map(|index| ContinuousFlowRoute {
                targets: [
                    (index + 1 < 4).then_some(ContinuousFlowTarget {
                        index: index + 1,
                        weight: 0.7,
                    }),
                    (index + 5 < 8).then_some(ContinuousFlowTarget {
                        index: index + 5,
                        weight: 0.3,
                    }),
                ],
            })
            .collect::<Vec<_>>();
        let downstream = vec![Some(1), Some(2), Some(3), None, None, None, None, None];
        let channels = vec![true, true, true, false, false, false, false, false];
        let water = vec!["land".to_owned(); 8];
        let terrain = vec!["plain".to_owned(); 8];
        let flow = vec![1.0, 2.0, 3.0, 4.0, 1.0, 1.0, 1.0, 1.0];
        let surface = AnalyticSurface {
            slope_angle_deg: 17.0,
            curved_valley: true,
        };
        let input = synthetic_input(
            &surface,
            &routes,
            &downstream,
            &channels,
            &water,
            &terrain,
            &flow,
        );
        let first = build_subcell_hydrology(&input);
        let second = build_subcell_hydrology(&input);
        assert_eq!(first.paths.len(), second.paths.len());
        assert_eq!(
            first
                .paths
                .iter()
                .map(|path| &path.points)
                .collect::<Vec<_>>(),
            second
                .paths
                .iter()
                .map(|path| &path.points)
                .collect::<Vec<_>>()
        );
        assert!(
            first
                .cell_anchors
                .iter()
                .flatten()
                .enumerate()
                .any(|(index, point)| distance(*point, cell_center(&input, index)) > 0.05)
        );
        assert!(first.paths.iter().all(|path| {
            path.points
                .iter()
                .all(|point| point.x.is_finite() && point.y.is_finite())
        }));
    }

    #[test]
    fn microgeometry_is_position_deterministic_and_seed_isolated() {
        let routes = vec![ContinuousFlowRoute::default(); 8];
        let downstream = vec![None; 8];
        let channels = vec![false; 8];
        let water = vec!["land".to_owned(); 8];
        let terrain = vec!["plain".to_owned(); 8];
        let flow = vec![1.0; 8];
        let surface = AnalyticSurface {
            slope_angle_deg: 17.0,
            curved_valley: false,
        };
        let mut input = synthetic_input(
            &surface,
            &routes,
            &downstream,
            &channels,
            &water,
            &terrain,
            &flow,
        );
        let point = Point { x: 2.5, y: 1.25 };
        let first = deterministic_micro_value(&input, point);
        assert_eq!(first, deterministic_micro_value(&input, point));
        input.identity.parent_seed += 1;
        assert_ne!(first, deterministic_micro_value(&input, point));
    }

    #[test]
    fn subcell_channel_is_downhill_after_local_conditioning() {
        let routes = (0..8)
            .map(|index| ContinuousFlowRoute {
                targets: [
                    (index + 1 < 4).then_some(ContinuousFlowTarget {
                        index: index + 1,
                        weight: 0.72,
                    }),
                    (index + 5 < 8).then_some(ContinuousFlowTarget {
                        index: index + 5,
                        weight: 0.28,
                    }),
                ],
            })
            .collect::<Vec<_>>();
        let downstream = vec![Some(1), Some(2), Some(3), None, None, None, None, None];
        let channels = vec![true, true, true, false, false, false, false, false];
        let water = vec!["land".to_owned(); 8];
        let terrain = vec!["plain".to_owned(); 8];
        let flow = vec![1.0; 8];
        let surface = AnalyticSurface {
            slope_angle_deg: 17.0,
            curved_valley: true,
        };
        let input = synthetic_input(
            &surface,
            &routes,
            &downstream,
            &channels,
            &water,
            &terrain,
            &flow,
        );
        let geometry = build_subcell_hydrology(&input);
        assert_eq!(geometry.stats.conditioned_uphill_violations, 0);
        assert_eq!(geometry.stats.fallback_count, 0);
    }

    #[test]
    fn subcell_channel_preserves_parent_basin() {
        let routes = (0..8)
            .map(|index| ContinuousFlowRoute {
                targets: [
                    (index + 1 < 4).then_some(ContinuousFlowTarget {
                        index: index + 1,
                        weight: 1.0,
                    }),
                    None,
                ],
            })
            .collect::<Vec<_>>();
        let downstream = vec![Some(1), Some(2), Some(3), None, None, None, None, None];
        let channels = vec![true, true, true, false, false, false, false, false];
        let water = vec!["land".to_owned(); 8];
        let terrain = vec!["plain".to_owned(); 8];
        let flow = vec![1.0; 8];
        let surface = AnalyticSurface {
            slope_angle_deg: 17.0,
            curved_valley: false,
        };
        let input = synthetic_input(
            &surface,
            &routes,
            &downstream,
            &channels,
            &water,
            &terrain,
            &flow,
        );
        let basins = drainage_basin_ids(&downstream, &water);
        let geometry = build_subcell_hydrology(&input);
        for path in &geometry.paths {
            let expected = basins[path.from_cell];
            assert!(path.points.iter().all(|point| {
                analysis_cell_at(&input, *point).is_some_and(|cell| basins[cell] == expected)
            }));
        }
    }

    #[test]
    fn confluence_geometry_is_continuous() {
        let mut routes = vec![ContinuousFlowRoute::default(); 8];
        for (from, to) in [(0, 1), (4, 1), (1, 2)] {
            routes[from].targets[0] = Some(ContinuousFlowTarget {
                index: to,
                weight: 1.0,
            });
        }
        let downstream = vec![Some(1), Some(2), None, None, Some(1), None, None, None];
        let channels = vec![true, true, false, false, true, false, false, false];
        let water = vec!["land".to_owned(); 8];
        let terrain = vec!["plain".to_owned(); 8];
        let flow = vec![1.0, 3.0, 3.0, 1.0, 2.0, 1.0, 1.0, 1.0];
        let surface = AnalyticSurface {
            slope_angle_deg: 0.0,
            curved_valley: false,
        };
        let input = synthetic_input(
            &surface,
            &routes,
            &downstream,
            &channels,
            &water,
            &terrain,
            &flow,
        );
        let geometry = build_subcell_hydrology(&input);
        let downstream_start = geometry
            .paths
            .iter()
            .find(|path| path.from_cell == 1)
            .and_then(|path| path.points.first())
            .copied()
            .expect("downstream confluence anchor");
        for upstream in [0, 4] {
            let end = geometry
                .paths
                .iter()
                .find(|path| path.from_cell == upstream)
                .and_then(|path| path.points.last())
                .copied()
                .expect("upstream confluence anchor");
            assert!(distance(end, downstream_start) <= 0.000_01);
        }
    }

    #[test]
    fn river_geometry_contains_no_nan_or_inf() {
        let routes = vec![ContinuousFlowRoute::default(); 8];
        let downstream = vec![Some(1), Some(2), None, None, None, None, None, None];
        let channels = vec![true, true, false, false, false, false, false, false];
        let water = vec!["land".to_owned(); 8];
        let terrain = vec!["plain".to_owned(); 8];
        let flow = vec![1.0; 8];
        let surface = AnalyticSurface {
            slope_angle_deg: 17.0,
            curved_valley: true,
        };
        let input = synthetic_input(
            &surface,
            &routes,
            &downstream,
            &channels,
            &water,
            &terrain,
            &flow,
        );
        let geometry = build_subcell_hydrology(&input);
        assert!(geometry.paths.iter().all(|path| {
            path.points
                .iter()
                .all(|point| point.x.is_finite() && point.y.is_finite())
        }));
    }
}
