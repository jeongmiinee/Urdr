use crate::{
    model::{NativeMap, Point},
    surface_refinement::{RefinementWindow, zero_crossing_t},
};

#[derive(Clone, Copy, Debug)]
pub struct ShorelineSegment {
    pub start: Point,
    pub end: Point,
}

/// Extracts the zero contour of the derived coast field with Marching Squares.
///
/// Each canonical cell keeps its authoritative land/water sign. Only the
/// crossing between neighbouring cell centres is interpolated, so this cannot
/// turn a land cell into water or reinterpret the outside of the map as sea.
pub fn build_shoreline_chunk(map: &NativeMap, chunk_x: u32, chunk_y: u32) -> Vec<ShorelineSegment> {
    let Some(surface) = map.canonical_surface.as_ref() else {
        return Vec::new();
    };
    let (chunks_x, chunks_y) = surface.chunk_grid_dimensions();
    if chunk_x >= chunks_x || chunk_y >= chunks_y || surface.width < 2 || surface.height < 2 {
        return Vec::new();
    }

    let chunk_size = crate::model::CanonicalSurface::CHUNK_SIZE as usize;
    let start_x = chunk_x as usize * chunk_size;
    let start_y = chunk_y as usize * chunk_size;
    let end_x = (start_x + chunk_size).min(surface.width as usize - 1);
    let end_y = (start_y + chunk_size).min(surface.height as usize - 1);
    if start_x >= end_x || start_y >= end_y {
        return Vec::new();
    }

    // Two cells are enough for interpolation plus the one-cell slope stencil
    // used by the deterministic refinement field at either side of a seam.
    let Some(window) = RefinementWindow::new(
        surface,
        start_x as i32 - 2,
        start_y as i32 - 2,
        end_x as i32 + 2,
        end_y as i32 + 2,
        map.environment_seed,
        map.sea_level,
    ) else {
        return Vec::new();
    };
    let cell_width = map.width / surface.width as f32;
    let cell_height = map.height / surface.height as f32;
    let mut segments = Vec::new();

    // A square is owned by the chunk containing its north-west canonical
    // centre. Neighbouring chunks therefore meet without duplicate segments.
    for y in start_y..end_y {
        for x in start_x..end_x {
            let values = [
                window.cell(x as i32, y as i32).coast_value,
                window.cell(x as i32 + 1, y as i32).coast_value,
                window.cell(x as i32 + 1, y as i32 + 1).coast_value,
                window.cell(x as i32, y as i32 + 1).coast_value,
            ];
            let origin = Point {
                x: (x as f32 + 0.5) * cell_width,
                y: (y as f32 + 0.5) * cell_height,
            };
            append_marching_square(&mut segments, values, origin, cell_width, cell_height);
        }
    }
    segments
}

fn append_marching_square(
    output: &mut Vec<ShorelineSegment>,
    values: [f32; 4],
    origin: Point,
    width: f32,
    height: f32,
) {
    // Corner order: north-west, north-east, south-east, south-west.
    let edges = [
        (0, 1, Point { x: 0.0, y: 0.0 }, Point { x: width, y: 0.0 }),
        (
            1,
            2,
            Point { x: width, y: 0.0 },
            Point {
                x: width,
                y: height,
            },
        ),
        (
            3,
            2,
            Point { x: 0.0, y: height },
            Point {
                x: width,
                y: height,
            },
        ),
        (0, 3, Point { x: 0.0, y: 0.0 }, Point { x: 0.0, y: height }),
    ];
    let mut crossings = [None; 4];
    let mut crossing_count = 0_usize;
    for (edge_index, (left, right, start, end)) in edges.into_iter().enumerate() {
        if (values[left] < 0.0) == (values[right] < 0.0) {
            continue;
        }
        let t = zero_crossing_t(values[left], values[right]);
        crossings[edge_index] = Some(Point {
            x: origin.x + start.x + (end.x - start.x) * t,
            y: origin.y + start.y + (end.y - start.y) * t,
        });
        crossing_count += 1;
    }

    match crossing_count {
        2 => {
            let mut points = crossings.into_iter().flatten();
            output.push(ShorelineSegment {
                start: points.next().expect("two coast crossings"),
                end: points.next().expect("two coast crossings"),
            });
        }
        4 => {
            // Cases 5 and 10 are topologically ambiguous. The bilinear centre
            // sign chooses which same-sign corners stay connected.
            let water_mask = values
                .iter()
                .enumerate()
                .fold(0_u8, |mask, (index, value)| {
                    mask | ((*value < 0.0) as u8) << index
                });
            let centre_is_water = values.iter().sum::<f32>() < 0.0;
            let connect_top_right = match water_mask {
                0b0101 => centre_is_water,
                0b1010 => !centre_is_water,
                _ => false,
            };
            let top = crossings[0].expect("ambiguous top crossing");
            let right = crossings[1].expect("ambiguous right crossing");
            let bottom = crossings[2].expect("ambiguous bottom crossing");
            let left = crossings[3].expect("ambiguous left crossing");
            let pairs = if connect_top_right {
                [(top, right), (bottom, left)]
            } else {
                [(top, left), (right, bottom)]
            };
            output.extend(
                pairs
                    .into_iter()
                    .map(|(start, end)| ShorelineSegment { start, end }),
            );
        }
        _ => {}
    }
}

pub(crate) fn is_water_kind(kind: &str) -> bool {
    matches!(kind, "saltwater" | "ocean" | "sea" | "freshwater" | "lake")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{CanonicalSurface, Language, LoadedWorld};
    use std::sync::Arc;

    fn test_map(width: u32, height: u32, cell: impl Fn(u32, u32) -> (i16, u8, u8)) -> NativeMap {
        let mut map = LoadedWorld::load_demo(Language::English).expect("demo").map;
        map.width = width as f32 * 0.1;
        map.height = height as f32 * 0.1;
        map.logical_pixel_width = width;
        map.logical_pixel_height = height;
        map.surface_cell_m = 100.0;
        map.canonical_surface = Some(Arc::new(CanonicalSurface::generate(width, height, cell)));
        map
    }

    #[test]
    fn interpolated_crossing_is_not_locked_to_half_cell() {
        let mut segments = Vec::new();
        append_marching_square(
            &mut segments,
            [0.6, -1.4, -1.4, 0.6],
            Point { x: 0.0, y: 0.0 },
            10.0,
            10.0,
        );
        assert_eq!(segments.len(), 1);
        assert!((segments[0].start.x - 3.0).abs() < 0.001);
        assert!((segments[0].end.x - 3.0).abs() < 0.001);
    }

    #[test]
    fn isolated_water_corner_preserves_a_closed_side() {
        let mut segments = Vec::new();
        append_marching_square(
            &mut segments,
            [-1.0, 1.0, 1.0, 1.0],
            Point { x: 0.0, y: 0.0 },
            10.0,
            10.0,
        );
        assert_eq!(segments.len(), 1);
        let segment = segments[0];
        assert!((segment.start.x - 5.0).abs() < 0.001);
        assert!((segment.end.y - 5.0).abs() < 0.001);
    }

    #[test]
    fn ambiguous_diagonal_is_deterministic() {
        let mut first = Vec::new();
        let mut second = Vec::new();
        let values = [-1.2, 0.7, -0.8, 1.1];
        append_marching_square(&mut first, values, Point { x: 4.0, y: 6.0 }, 10.0, 12.0);
        append_marching_square(&mut second, values, Point { x: 4.0, y: 6.0 }, 10.0, 12.0);
        assert_eq!(first.len(), 2);
        assert_eq!(
            first
                .iter()
                .map(|segment| (
                    segment.start.x,
                    segment.start.y,
                    segment.end.x,
                    segment.end.y
                ))
                .collect::<Vec<_>>(),
            second
                .iter()
                .map(|segment| (
                    segment.start.x,
                    segment.start.y,
                    segment.end.x,
                    segment.end.y
                ))
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn uniform_field_has_no_internal_coastline() {
        for values in [[1.0; 4], [-1.0; 4]] {
            let mut segments = Vec::new();
            append_marching_square(&mut segments, values, Point { x: 0.0, y: 0.0 }, 10.0, 10.0);
            assert!(segments.is_empty());
        }
    }

    #[test]
    fn only_explicit_water_kinds_are_classified_as_water() {
        for kind in ["saltwater", "ocean", "sea", "freshwater", "lake"] {
            assert!(is_water_kind(kind));
        }
        for kind in ["land", "none", "", "plain"] {
            assert!(!is_water_kind(kind));
        }
    }

    #[test]
    fn isolated_lake_survives_refined_shoreline() {
        let map = test_map(12, 12, |x, y| {
            let lake = (4..=7).contains(&x) && (4..=7).contains(&y);
            (if lake { -20 } else { 120 }, 0, if lake { 2 } else { 0 })
        });
        let segments = build_shoreline_chunk(&map, 0, 0);
        assert!(!segments.is_empty());
        assert!(segments.iter().all(|segment| {
            [segment.start, segment.end]
                .into_iter()
                .all(|point| (0.3..0.9).contains(&point.x) && (0.3..0.9).contains(&point.y))
        }));
    }

    #[test]
    fn one_cell_narrow_channel_keeps_both_banks() {
        let map = test_map(12, 12, |x, _| {
            let channel = x == 6;
            (
                if channel { -12 } else { 80 },
                0,
                if channel { 2 } else { 0 },
            )
        });
        let segments = build_shoreline_chunk(&map, 0, 0);
        let left_bank = segments
            .iter()
            .filter(|segment| segment.start.x < 0.65 && segment.end.x < 0.65)
            .count();
        let right_bank = segments
            .iter()
            .filter(|segment| segment.start.x > 0.65 && segment.end.x > 0.65)
            .count();
        assert!(left_bank > 0 && right_bank > 0);
    }

    #[test]
    fn uniform_land_does_not_gain_a_map_edge_coast() {
        let map = test_map(12, 12, |_, _| (120, 0, 0));
        assert!(build_shoreline_chunk(&map, 0, 0).is_empty());
    }
}
