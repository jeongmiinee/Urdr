use std::collections::HashMap;

use crate::{
    model::{NativeMap, Point},
    shoreline::is_water_kind,
};

#[derive(Clone, Debug)]
pub struct ContourLine {
    pub elevation: f32,
    pub major: bool,
    pub points: Vec<Point>,
}

#[derive(Clone, Copy)]
struct Segment(Point, Point);

#[cfg(test)]
pub fn build(map: &NativeMap) -> Vec<ContourLine> {
    build_for_bounds(
        map,
        0,
        Point { x: 0.0, y: 0.0 },
        Point {
            x: map.width,
            y: map.height,
        },
    )
}

pub fn build_for_bounds(
    map: &NativeMap,
    lod: u8,
    minimum_point: Point,
    maximum_point: Point,
) -> Vec<ContourLine> {
    let Some(grid) = CanonicalContourGrid::from_map(map, lod, minimum_point, maximum_point) else {
        return Vec::new();
    };
    let Some((minimum, maximum, interval)) = elevation_range_and_interval(map) else {
        return Vec::new();
    };
    let first = (minimum / interval).ceil() * interval;
    let mut output = Vec::new();
    let mut level = first;
    let mut level_index = (first / interval).round() as i32;
    while level < maximum && output.len() < 1_500 {
        let segments = marching_segments(&grid, level);
        let major = level_index.rem_euclid(5) == 0;
        output.extend(
            stitch(segments)
                .into_iter()
                .filter(|points| points.len() >= 2)
                .map(|points| ContourLine {
                    elevation: level,
                    major,
                    points,
                }),
        );
        level += interval;
        level_index += 1;
    }
    output
}

pub fn interval(map: &NativeMap) -> f32 {
    elevation_range_and_interval(map)
        .map(|(_, _, interval)| interval)
        .unwrap_or(1.0)
}

fn elevation_range_and_interval(map: &NativeMap) -> Option<(f32, f32, f32)> {
    let land_values = map
        .elevation
        .iter()
        .enumerate()
        .filter_map(|(index, value)| {
            map.water
                .get(index)
                .is_none_or(|water| !is_water_kind(water))
                .then_some(*value)
        })
        .collect::<Vec<_>>();
    let minimum = land_values
        .iter()
        .copied()
        .fold(f32::INFINITY, f32::min)
        .max(map.sea_level);
    let maximum = land_values
        .iter()
        .copied()
        .fold(f32::NEG_INFINITY, f32::max);
    if !minimum.is_finite() || !maximum.is_finite() || maximum <= minimum {
        return None;
    }
    let interval = nice_interval((maximum - minimum) / 18.0);
    Some((minimum, maximum, interval))
}

const MAX_CONTOUR_SAMPLES_PER_AXIS: usize = 640;

struct CanonicalContourGrid {
    width: usize,
    height: usize,
    positions: Vec<Point>,
    elevation: Vec<f32>,
    water: Vec<bool>,
}

impl CanonicalContourGrid {
    fn from_map(map: &NativeMap, lod: u8, minimum: Point, maximum: Point) -> Option<Self> {
        if map.width <= 0.0 || map.height <= 0.0 {
            return None;
        }
        let (surface_width, surface_height) = map.canonical_cell_dimensions();
        if surface_width < 2 || surface_height < 2 {
            return None;
        }
        let to_x = |value: f32| {
            ((value / map.width) * surface_width as f32)
                .floor()
                .clamp(0.0, surface_width.saturating_sub(1) as f32) as usize
        };
        let to_y = |value: f32| {
            ((value / map.height) * surface_height as f32)
                .floor()
                .clamp(0.0, surface_height.saturating_sub(1) as f32) as usize
        };
        let raw_x0 = to_x(minimum.x.min(maximum.x)).saturating_sub(1);
        let raw_y0 = to_y(minimum.y.min(maximum.y)).saturating_sub(1);
        let raw_x1 = to_x(minimum.x.max(maximum.x))
            .saturating_add(1)
            .min(surface_width - 1);
        let raw_y1 = to_y(minimum.y.max(maximum.y))
            .saturating_add(1)
            .min(surface_height - 1);
        let base_stride = 1_usize << lod.min(8);
        let span_x = raw_x1.saturating_sub(raw_x0).max(1);
        let span_y = raw_y1.saturating_sub(raw_y0).max(1);
        let adaptive_stride = span_x
            .max(span_y)
            .div_ceil(MAX_CONTOUR_SAMPLES_PER_AXIS.saturating_sub(1));
        let stride = base_stride.max(adaptive_stride).max(1);
        let x0 = raw_x0 / stride * stride;
        let y0 = raw_y0 / stride * stride;
        let x1 = raw_x1
            .div_ceil(stride)
            .saturating_mul(stride)
            .min(surface_width - 1);
        let y1 = raw_y1
            .div_ceil(stride)
            .saturating_mul(stride)
            .min(surface_height - 1);
        let width = (x1.saturating_sub(x0) / stride).saturating_add(1);
        let height = (y1.saturating_sub(y0) / stride).saturating_add(1);
        if width < 2 || height < 2 {
            return None;
        }

        let mut positions = Vec::with_capacity(width.saturating_mul(height));
        let mut elevation = Vec::with_capacity(width.saturating_mul(height));
        let mut water = Vec::with_capacity(width.saturating_mul(height));
        for row in 0..height {
            let sy = (y0 + row * stride).min(surface_height - 1);
            for column in 0..width {
                let sx = (x0 + column * stride).min(surface_width - 1);
                let point = Point {
                    x: (sx as f32 + 0.5) * map.width / surface_width as f32,
                    y: (sy as f32 + 0.5) * map.height / surface_height as f32,
                };
                let sample = map.surface_sample_at_world(point);
                positions.push(point);
                elevation.push(sample.elevation_m);
                water.push(is_water_kind(sample.water));
            }
        }
        Some(Self {
            width,
            height,
            positions,
            elevation,
            water,
        })
    }
}

fn nice_interval(raw: f32) -> f32 {
    let raw = raw.max(1.0);
    let power = 10.0_f32.powf(raw.log10().floor());
    let normalized = raw / power;
    let nice = if normalized <= 1.0 {
        1.0
    } else if normalized <= 2.0 {
        2.0
    } else if normalized <= 5.0 {
        5.0
    } else {
        10.0
    };
    nice * power
}

fn marching_segments(grid: &CanonicalContourGrid, level: f32) -> Vec<Segment> {
    let mut segments = Vec::new();
    for y in 0..grid.height - 1 {
        for x in 0..grid.width - 1 {
            let indices = [
                y * grid.width + x,
                y * grid.width + x + 1,
                (y + 1) * grid.width + x + 1,
                (y + 1) * grid.width + x,
            ];
            if indices
                .iter()
                .any(|index| grid.water.get(*index).copied().unwrap_or(true))
            {
                continue;
            }
            let values = indices.map(|index| grid.elevation[index]);
            let mut case_index = 0_u8;
            for (bit, value) in values.iter().enumerate() {
                if *value >= level {
                    case_index |= 1 << bit;
                }
            }
            if case_index == 0 || case_index == 15 {
                continue;
            }
            let positions = indices.map(|index| grid.positions[index]);
            let edges = [
                interpolate(positions[0], positions[1], values[0], values[1], level),
                interpolate(positions[1], positions[2], values[1], values[2], level),
                interpolate(positions[3], positions[2], values[3], values[2], level),
                interpolate(positions[0], positions[3], values[0], values[3], level),
            ];
            let center_high = values.iter().sum::<f32>() * 0.25 >= level;
            let pairs: &[(usize, usize)] = match case_index {
                1 | 14 => &[(3, 0)],
                2 | 13 => &[(0, 1)],
                3 | 12 => &[(3, 1)],
                4 | 11 => &[(1, 2)],
                6 | 9 => &[(0, 2)],
                7 | 8 => &[(3, 2)],
                5 if center_high => &[(3, 2), (0, 1)],
                5 => &[(3, 0), (1, 2)],
                10 if center_high => &[(3, 0), (1, 2)],
                10 => &[(0, 1), (2, 3)],
                _ => &[],
            };
            segments.extend(pairs.iter().map(|(a, b)| Segment(edges[*a], edges[*b])));
        }
    }
    segments
}

fn interpolate(a: Point, b: Point, av: f32, bv: f32, level: f32) -> Point {
    let ratio = if (bv - av).abs() < f32::EPSILON {
        0.5
    } else {
        ((level - av) / (bv - av)).clamp(0.0, 1.0)
    };
    Point {
        x: a.x + (b.x - a.x) * ratio,
        y: a.y + (b.y - a.y) * ratio,
    }
}

fn point_key(point: Point) -> (i32, i32) {
    (
        (point.x * 10_000.0).round() as i32,
        (point.y * 10_000.0).round() as i32,
    )
}

fn stitch(segments: Vec<Segment>) -> Vec<Vec<Point>> {
    let mut adjacency = HashMap::<(i32, i32), Vec<usize>>::new();
    for (index, segment) in segments.iter().enumerate() {
        adjacency
            .entry(point_key(segment.0))
            .or_default()
            .push(index);
        adjacency
            .entry(point_key(segment.1))
            .or_default()
            .push(index);
    }
    let mut used = vec![false; segments.len()];
    let mut lines = Vec::new();
    for start in 0..segments.len() {
        if used[start] {
            continue;
        }
        used[start] = true;
        let mut line = vec![segments[start].0, segments[start].1];
        extend_line(&mut line, &segments, &adjacency, &mut used, false);
        extend_line(&mut line, &segments, &adjacency, &mut used, true);
        lines.push(line);
    }
    lines
}

fn extend_line(
    line: &mut Vec<Point>,
    segments: &[Segment],
    adjacency: &HashMap<(i32, i32), Vec<usize>>,
    used: &mut [bool],
    at_front: bool,
) {
    loop {
        let endpoint = if at_front {
            line[0]
        } else {
            *line.last().expect("line")
        };
        let Some(next) = adjacency
            .get(&point_key(endpoint))
            .and_then(|candidates| candidates.iter().copied().find(|index| !used[*index]))
        else {
            break;
        };
        used[next] = true;
        let segment = segments[next];
        let other = if point_key(segment.0) == point_key(endpoint) {
            segment.1
        } else {
            segment.0
        };
        if at_front {
            line.insert(0, other);
        } else {
            line.push(other);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    use crate::model::CanonicalSurface;

    fn map() -> NativeMap {
        NativeMap {
            source_id: "test".into(),
            region_id: None,
            map_view_id: None,
            title: "test".into(),
            width: 3.0,
            height: 3.0,
            logical_pixel_width: 30,
            logical_pixel_height: 30,
            surface_cell_m: NativeMap::SURFACE_CELL_METERS as f32,
            grid_width: 3,
            grid_height: 3,
            sea_level: 0.0,
            climate_model: 0,
            environment_seed: 0,
            generation_settings: None,
            geologic_guide: None,
            causal_geology: Default::default(),
            generation_diagnostics: Default::default(),
            elevation: vec![0.0, 100.0, 200.0, 0.0, 100.0, 200.0, 0.0, 100.0, 200.0],
            terrain: vec!["plain".into(); 9],
            water: vec!["land".into(); 9],
            temperature: vec![],
            precipitation: vec![],
            moisture: vec![],
            humidity: vec![],
            runoff: vec![],
            wind_x: vec![],
            wind_y: vec![],
            solar_hours: vec![],
            solar_irradiance: vec![],
            snowfall: vec![],
            snow_cover: vec![],
            evapotranspiration: vec![],
            flow_accumulation: vec![],
            river_order: vec![],
            roads: vec![],
            place_names: vec![],
            rivers: vec![],
            river_graph: Default::default(),
            drainage_outlets: vec![],
            locations: vec![],
            factions: vec![],
            territories: vec![],
            territory_owners: vec![],
            territory_history: vec![],
            events: vec![],
            environment_pins: vec![],
            current_year: 0,
            canonical_surface: None,
            surface_revision: 0,
        }
    }

    #[test]
    fn marching_squares_interpolates_smooth_vertical_contours() {
        let lines = build(&map());
        assert!(!lines.is_empty());
        assert!(lines.iter().all(|line| line.points.len() >= 2));
        assert!(
            lines
                .iter()
                .flat_map(|line| &line.points)
                .any(|point| point.x.fract() != 0.0)
        );
    }

    #[test]
    fn contours_are_clipped_out_of_water_cells() {
        let mut map = map();
        map.water.fill("sea".into());
        assert!(build(&map).is_empty());
    }

    #[test]
    fn contour_geometry_uses_canonical_elevation_instead_of_analysis_grid() {
        let mut map = map();
        map.canonical_surface = Some(Arc::new(CanonicalSurface::generate(30, 30, |x, _| {
            ((x as i16) * 10, 0, 0)
        })));
        map.surface_revision = 7;
        let lines = build(&map);
        assert!(!lines.is_empty());
        assert!(lines.iter().all(|line| {
            let min_x = line
                .points
                .iter()
                .map(|point| point.x)
                .fold(f32::INFINITY, f32::min);
            let max_x = line
                .points
                .iter()
                .map(|point| point.x)
                .fold(f32::NEG_INFINITY, f32::max);
            max_x - min_x < 0.2
        }));
    }
}
