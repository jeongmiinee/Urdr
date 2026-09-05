use crate::model::{CanonicalSurface, SurfaceSample};

pub(crate) const DISPLAY_FIELD_VERSION: u64 = 1;

pub(crate) fn chunk_halo_revision_hash(
    surface: &CanonicalSurface,
    chunk_x: u32,
    chunk_y: u32,
    radius: u32,
) -> u64 {
    let (chunks_x, chunks_y) = surface.chunk_grid_dimensions();
    if chunks_x == 0 || chunks_y == 0 || chunk_x >= chunks_x || chunk_y >= chunks_y {
        return 0;
    }
    let mut hash = 0xcbf2_9ce4_8422_2325_u64 ^ DISPLAY_FIELD_VERSION;
    let minimum_x = chunk_x.saturating_sub(radius);
    let minimum_y = chunk_y.saturating_sub(radius);
    let maximum_x = chunk_x.saturating_add(radius).min(chunks_x - 1);
    let maximum_y = chunk_y.saturating_add(radius).min(chunks_y - 1);
    for y in minimum_y..=maximum_y {
        for x in minimum_x..=maximum_x {
            hash ^= surface.chunk_revision(x, y).unwrap_or_default();
            hash = hash.wrapping_mul(0x100_0000_01b3);
            hash ^= (u64::from(y) << 32) | u64::from(x);
            hash = hash.wrapping_mul(0x100_0000_01b3);
        }
    }
    hash
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct RefinementCell {
    pub elevation_m: f32,
    pub terrain: &'static str,
    pub water: &'static str,
    pub coast_value: f32,
    category_confidence: f32,
}

impl RefinementCell {
    fn is_water(self) -> bool {
        self.water != "land"
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct RefinedSurfaceSample {
    pub elevation_m: f32,
    pub surface_name: &'static str,
    pub secondary_surface_name: Option<&'static str>,
    pub secondary_mix: f32,
    pub coast_value: f32,
}

/// A small derived window over the authoritative CanonicalSurface.
///
/// Cell labels remain authoritative. The continuous values only move the
/// displayed boundary between opposite labels inside the space between their
/// centres. This keeps edits, serialization, and water topology independent
/// from display refinement.
pub(crate) struct RefinementWindow {
    origin_x: usize,
    origin_y: usize,
    width: usize,
    height: usize,
    surface_width: usize,
    surface_height: usize,
    cells: Vec<RefinementCell>,
}

impl RefinementWindow {
    pub(crate) fn new(
        surface: &CanonicalSurface,
        minimum_x: i32,
        minimum_y: i32,
        maximum_x_exclusive: i32,
        maximum_y_exclusive: i32,
        seed: u32,
        sea_level_m: f32,
    ) -> Option<Self> {
        let surface_width = surface.width as usize;
        let surface_height = surface.height as usize;
        if surface_width == 0 || surface_height == 0 {
            return None;
        }
        let origin_x = minimum_x.clamp(0, surface_width.saturating_sub(1) as i32) as usize;
        let origin_y = minimum_y.clamp(0, surface_height.saturating_sub(1) as i32) as usize;
        let end_x = maximum_x_exclusive
            .clamp(origin_x.saturating_add(1) as i32, surface_width as i32)
            as usize;
        let end_y = maximum_y_exclusive
            .clamp(origin_y.saturating_add(1) as i32, surface_height as i32)
            as usize;
        let width = end_x - origin_x;
        let height = end_y - origin_y;
        let mut source = Vec::with_capacity(width.saturating_mul(height));
        for y in origin_y..end_y {
            for x in origin_x..end_x {
                source.push(surface.sample(x, y));
            }
        }
        let source_at = |x: i32, y: i32| {
            let x = x.clamp(origin_x as i32, end_x.saturating_sub(1) as i32) as usize;
            let y = y.clamp(origin_y as i32, end_y.saturating_sub(1) as i32) as usize;
            source[(y - origin_y) * width + (x - origin_x)]
        };
        let mut cells = Vec::with_capacity(source.len());
        for y in origin_y..end_y {
            for x in origin_x..end_x {
                let sample = source_at(x as i32, y as i32);
                let west = source_at(x as i32 - 1, y as i32).elevation_m;
                let east = source_at(x as i32 + 1, y as i32).elevation_m;
                let north = source_at(x as i32, y as i32 - 1).elevation_m;
                let south = source_at(x as i32, y as i32 + 1).elevation_m;
                let slope = ((east - west).hypot(south - north) / 1_200.0).clamp(0.0, 1.0);
                cells.push(refinement_cell(sample, seed, x, y, sea_level_m, slope));
            }
        }
        Some(Self {
            origin_x,
            origin_y,
            width,
            height,
            surface_width,
            surface_height,
            cells,
        })
    }

    pub(crate) fn cell(&self, x: i32, y: i32) -> RefinementCell {
        let x = x.clamp(0, self.surface_width.saturating_sub(1) as i32) as usize;
        let y = y.clamp(0, self.surface_height.saturating_sub(1) as i32) as usize;
        let local_x = x.clamp(self.origin_x, self.origin_x + self.width - 1) - self.origin_x;
        let local_y = y.clamp(self.origin_y, self.origin_y + self.height - 1) - self.origin_y;
        self.cells[local_y * self.width + local_x]
    }

    /// Samples the derived display field in canonical cell-edge coordinates.
    /// Canonical cell centres are therefore `(x + 0.5, y + 0.5)`.
    pub(crate) fn sample(&self, x: f32, y: f32) -> RefinedSurfaceSample {
        let grid_x = x - 0.5;
        let grid_y = y - 0.5;
        let x0 = grid_x.floor() as i32;
        let y0 = grid_y.floor() as i32;
        let tx = smooth_unit(grid_x - x0 as f32);
        let ty = smooth_unit(grid_y - y0 as f32);
        let cells = [
            self.cell(x0, y0),
            self.cell(x0 + 1, y0),
            self.cell(x0, y0 + 1),
            self.cell(x0 + 1, y0 + 1),
        ];
        let weights = [
            (1.0 - tx) * (1.0 - ty),
            tx * (1.0 - ty),
            (1.0 - tx) * ty,
            tx * ty,
        ];
        let coast_value = cells
            .iter()
            .zip(weights)
            .map(|(cell, weight)| cell.coast_value * weight)
            .sum::<f32>();
        let wants_water = coast_value < 0.0;
        let (surface_name, secondary_surface_name, secondary_mix) =
            ranked_surface_names(cells, weights, wants_water);
        let elevation_m = cells
            .iter()
            .zip(weights)
            .map(|(cell, weight)| cell.elevation_m * weight)
            .sum();
        RefinedSurfaceSample {
            elevation_m,
            surface_name,
            secondary_surface_name,
            secondary_mix,
            coast_value,
        }
    }
}

fn refinement_cell(
    sample: SurfaceSample,
    seed: u32,
    x: usize,
    y: usize,
    sea_level_m: f32,
    slope: f32,
) -> RefinementCell {
    let meso = signed_value_noise(seed ^ 0xc05a_57e1, x as f64, y as f64, 29.0);
    let fine = signed_value_noise(seed ^ 0x51b7_0a91, x as f64, y as f64, 7.0);
    let micro = (lattice_value(seed ^ 0xd134_2543, x as i64, y as i64) * 2.0 - 1.0) as f32;
    let elevation_confidence = ((sample.elevation_m - sea_level_m).abs() / 900.0).clamp(0.0, 1.0);
    // The sign is authoritative topology. The wider, continuous magnitude
    // range only moves the zero crossing between opposite cell centres. A
    // short wavelength prevents long coast runs from collapsing back onto
    // the four grid directions while remaining deterministic across chunks.
    let log_magnitude =
        meso * 0.72 + fine * 0.48 + micro * 0.34 + elevation_confidence * 0.26 + slope * 0.18
            - 0.18;
    let magnitude = 2.0_f32.powf(log_magnitude * 1.35).clamp(0.22, 3.8);
    let sign = if sample.water == "land" { 1.0 } else { -1.0 };
    let category_seed = seed
        ^ stable_name_hash(if sample.water == "land" {
            sample.terrain
        } else {
            sample.water
        });
    let category_noise = continuous_value_noise(category_seed, x as f64, y as f64, 23.0) as f32;
    RefinementCell {
        elevation_m: sample.elevation_m,
        terrain: sample.terrain,
        water: sample.water,
        coast_value: sign * magnitude,
        category_confidence: 0.88 + category_noise * 0.20 + elevation_confidence * 0.04,
    }
}

fn ranked_surface_names(
    cells: [RefinementCell; 4],
    weights: [f32; 4],
    wants_water: bool,
) -> (&'static str, Option<&'static str>, f32) {
    let mut names = [""; 4];
    let mut scores = [0.0_f32; 4];
    let mut count = 0_usize;
    for (cell, weight) in cells.into_iter().zip(weights) {
        if cell.is_water() != wants_water {
            continue;
        }
        let name = if wants_water {
            cell.water
        } else {
            cell.terrain
        };
        if let Some(index) = names[..count]
            .iter()
            .position(|candidate| *candidate == name)
        {
            scores[index] += weight * cell.category_confidence;
        } else {
            names[count] = name;
            scores[count] = weight * cell.category_confidence;
            count += 1;
        }
    }
    if count == 0 {
        return (if wants_water { "saltwater" } else { "plain" }, None, 0.0);
    }
    let mut order = (0..count).collect::<Vec<_>>();
    order.sort_by(|left, right| {
        scores[*left]
            .total_cmp(&scores[*right])
            .then_with(|| names[*right].cmp(names[*left]))
            .reverse()
    });
    let primary = order[0];
    let Some(&secondary) = order.get(1) else {
        return (names[primary], None, 0.0);
    };
    let total = (scores[primary] + scores[secondary]).max(f32::EPSILON);
    let secondary_fraction = scores[secondary] / total;
    // Coverage AA is deliberately confined to the score-intersection zone.
    // It does not alter either canonical category outside rendering.
    let secondary_mix = ((secondary_fraction - 0.08) / 0.42 * 0.5).clamp(0.0, 0.5);
    (
        names[primary],
        (secondary_mix > 0.0).then_some(names[secondary]),
        secondary_mix,
    )
}

pub(crate) fn zero_crossing_t(left: f32, right: f32) -> f32 {
    let denominator = left - right;
    if !denominator.is_finite() || denominator.abs() <= f32::EPSILON {
        return 0.5;
    }
    (left / denominator).clamp(0.02, 0.98)
}

fn smooth_unit(value: f32) -> f32 {
    let value = value.clamp(0.0, 1.0);
    value * value * (3.0 - 2.0 * value)
}

fn continuous_value_noise(seed: u32, x: f64, y: f64, wavelength: f64) -> f64 {
    let wavelength = wavelength.max(1.0);
    let gx = x / wavelength;
    let gy = y / wavelength;
    let x0 = gx.floor() as i64;
    let y0 = gy.floor() as i64;
    let tx = smooth_unit((gx - x0 as f64) as f32) as f64;
    let ty = smooth_unit((gy - y0 as f64) as f32) as f64;
    let v00 = lattice_value(seed, x0, y0);
    let v10 = lattice_value(seed, x0 + 1, y0);
    let v01 = lattice_value(seed, x0, y0 + 1);
    let v11 = lattice_value(seed, x0 + 1, y0 + 1);
    let top = v00 + (v10 - v00) * tx;
    let bottom = v01 + (v11 - v01) * tx;
    top + (bottom - top) * ty
}

fn signed_value_noise(seed: u32, x: f64, y: f64, wavelength: f64) -> f32 {
    (continuous_value_noise(seed, x, y, wavelength) * 2.0 - 1.0) as f32
}

fn lattice_value(seed: u32, x: i64, y: i64) -> f64 {
    let mut value = u64::from(seed)
        ^ (x as u64).wrapping_mul(0x9e37_79b9_7f4a_7c15)
        ^ (y as u64).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    value ^= value >> 30;
    value = value.wrapping_mul(0xbf58_476d_1ce4_e5b9);
    value ^= value >> 27;
    value = value.wrapping_mul(0x94d0_49bb_1331_11eb);
    value ^= value >> 31;
    (value >> 11) as f64 / ((1_u64 << 53) - 1) as f64
}

fn stable_name_hash(value: &str) -> u32 {
    value.bytes().fold(0x811c_9dc5_u32, |hash, byte| {
        (hash ^ u32::from(byte)).wrapping_mul(0x0100_0193)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn continuous_coast_field_preserves_macro_water_labels() {
        let surface =
            CanonicalSurface::generate(3, 1, |x, _| if x == 1 { (0, 0, 1) } else { (100, 0, 0) });
        let window = RefinementWindow::new(&surface, 0, 0, 3, 1, 17, 0.0).unwrap();
        assert!(window.cell(0, 0).coast_value > 0.0);
        assert!(window.cell(1, 0).coast_value < 0.0);
        assert!(window.cell(2, 0).coast_value > 0.0);
    }

    #[test]
    fn terrain_transition_is_deterministic() {
        let surface = CanonicalSurface::generate(4, 4, |x, y| {
            let terrain = if x + y < 4 { 2 } else { 3 };
            ((x * 10 + y) as i16, terrain, 0)
        });
        let first = RefinementWindow::new(&surface, 0, 0, 4, 4, 91, 0.0).unwrap();
        let second = RefinementWindow::new(&surface, 0, 0, 4, 4, 91, 0.0).unwrap();
        assert_eq!(first.sample(2.25, 1.75), second.sample(2.25, 1.75));
    }

    #[test]
    fn shoreline_crossing_is_not_forced_to_the_midpoint() {
        let crossing = zero_crossing_t(0.8, -1.2);
        assert!((0.0..1.0).contains(&crossing));
        assert!((crossing - 0.5).abs() > 0.05);
    }

    #[test]
    fn neighboring_chunk_windows_share_the_same_boundary_samples() {
        let surface = CanonicalSurface::generate(512, 8, |x, y| {
            let water = u8::from((x + y) % 7 == 0);
            ((x as i32 - y as i32) as i16, (x % 5) as u8, water)
        });
        let left = RefinementWindow::new(&surface, 0, 0, 258, 8, 55, 0.0).unwrap();
        let right = RefinementWindow::new(&surface, 254, 0, 512, 8, 55, 0.0).unwrap();
        for y in [0.5, 2.25, 5.75, 7.5] {
            assert_eq!(left.sample(256.0, y), right.sample(256.0, y));
        }
    }

    #[test]
    fn terrain_boundary_is_not_forced_to_the_authoritative_cell_edge() {
        let surface = CanonicalSurface::generate(4, 2, |x, _| (100, if x < 2 { 2 } else { 3 }, 0));
        let window = RefinementWindow::new(&surface, 0, 0, 4, 2, 991, 0.0).unwrap();
        let left_confidence = window.cell(1, 0).category_confidence;
        let right_confidence = window.cell(2, 0).category_confidence;
        assert!((left_confidence - right_confidence).abs() > f32::EPSILON);
        assert_ne!(
            window.sample(1.5, 0.75).surface_name,
            window.sample(2.5, 0.75).surface_name
        );
        assert_eq!(surface.sample(1, 0).terrain, "forest");
        assert_eq!(surface.sample(2, 0).terrain, "desert");
    }
}
