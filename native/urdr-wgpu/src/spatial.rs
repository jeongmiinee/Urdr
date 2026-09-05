use std::sync::Arc;

use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::time::Instant;

use crate::geology::{CausalGeologyModel, CrustType};
use crate::planet_config::{GenerationQuality, PlanetGenerationConfig};
use crate::projection::{
    ProjectedMetricPoint, ProjectionDefinition, ProjectionError, ProjectionSelectionInput,
    ProjectionSelector,
};

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanetPosition {
    x: f64,
    y: f64,
    z: f64,
}

impl PlanetPosition {
    pub fn new(x: f64, y: f64, z: f64) -> Result<Self, PlanetPositionError> {
        if !x.is_finite() || !y.is_finite() || !z.is_finite() {
            return Err(PlanetPositionError::NonFinite);
        }
        let length = (x * x + y * y + z * z).sqrt();
        if length <= 1.0e-15 {
            return Err(PlanetPositionError::ZeroLength);
        }
        Ok(Self {
            x: x / length,
            y: y / length,
            z: z / length,
        })
    }

    pub fn from_latitude_longitude_deg(latitude_deg: f64, longitude_deg: f64) -> Self {
        Self::from_latitude_longitude_rad(latitude_deg.to_radians(), longitude_deg.to_radians())
    }

    pub fn from_latitude_longitude_rad(latitude: f64, longitude: f64) -> Self {
        let latitude = latitude.clamp(-std::f64::consts::FRAC_PI_2, std::f64::consts::FRAC_PI_2);
        let (sin_latitude, cos_latitude) = latitude.sin_cos();
        let (sin_longitude, cos_longitude) = longitude.sin_cos();
        Self {
            x: cos_latitude * cos_longitude,
            y: cos_latitude * sin_longitude,
            z: sin_latitude,
        }
    }

    pub fn components(self) -> [f64; 3] {
        [self.x, self.y, self.z]
    }

    pub fn latitude_longitude_rad(self) -> (f64, f64) {
        (self.z.clamp(-1.0, 1.0).asin(), self.y.atan2(self.x))
    }

    pub fn latitude_longitude_deg(self) -> (f64, f64) {
        let (latitude, longitude) = self.latitude_longitude_rad();
        (latitude.to_degrees(), longitude.to_degrees())
    }

    pub fn great_circle_distance_m(self, other: Self, radius_m: f64) -> f64 {
        radius_m * self.angular_distance_rad(other)
    }

    pub fn angular_distance_rad(self, other: Self) -> f64 {
        let dot = (self.x * other.x + self.y * other.y + self.z * other.z).clamp(-1.0, 1.0);
        dot.acos()
    }

    pub fn is_valid_unit(self) -> bool {
        let length_squared = self.x * self.x + self.y * self.y + self.z * self.z;
        self.x.is_finite()
            && self.y.is_finite()
            && self.z.is_finite()
            && (length_squared - 1.0).abs() <= 1.0e-9
    }

    pub fn slerp(self, other: Self, fraction: f64) -> Option<Self> {
        if !self.is_valid_unit() || !other.is_valid_unit() || !fraction.is_finite() {
            return None;
        }
        let fraction = fraction.clamp(0.0, 1.0);
        let dot = (self.x * other.x + self.y * other.y + self.z * other.z).clamp(-1.0, 1.0);
        if dot > 0.999_999 {
            return Self::new(
                self.x + (other.x - self.x) * fraction,
                self.y + (other.y - self.y) * fraction,
                self.z + (other.z - self.z) * fraction,
            )
            .ok();
        }
        if dot < -0.999_999 {
            return None;
        }
        let angle = dot.acos();
        let sin_angle = angle.sin();
        if sin_angle.abs() <= 1.0e-12 {
            return None;
        }
        let start_weight = ((1.0 - fraction) * angle).sin() / sin_angle;
        let end_weight = (fraction * angle).sin() / sin_angle;
        Self::new(
            self.x * start_weight + other.x * end_weight,
            self.y * start_weight + other.y * end_weight,
            self.z * start_weight + other.z * end_weight,
        )
        .ok()
    }
}

impl Default for PlanetPosition {
    fn default() -> Self {
        Self::from_latitude_longitude_deg(0.0, 0.0)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlanetPositionError {
    NonFinite,
    ZeroLength,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanetPhysicalDefinition {
    pub radius_m: f64,
    pub gravity_ms2: f64,
    pub axial_tilt_deg: f64,
    #[serde(default)]
    pub axial_azimuth_deg: f64,
    pub day_length_hours: f64,
    pub orbital_period_days: f64,
}

impl Default for PlanetPhysicalDefinition {
    fn default() -> Self {
        Self {
            radius_m: 6_371_000.0,
            gravity_ms2: 9.81,
            axial_tilt_deg: 23.4,
            axial_azimuth_deg: 0.0,
            day_length_hours: 24.0,
            orbital_period_days: 365.0,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PlanetReferenceFrame {
    pub orbital_normal_world: [f64; 3],
    pub obliquity_rad: f64,
    pub azimuth_rad: f64,
    pub rotation_axis_world: [f64; 3],
}

impl PlanetReferenceFrame {
    pub fn from_physical(physical: &PlanetPhysicalDefinition) -> Self {
        let obliquity_rad = physical.axial_tilt_deg.to_radians();
        let azimuth_rad = physical.axial_azimuth_deg.to_radians();
        let (sin_tilt, cos_tilt) = obliquity_rad.sin_cos();
        let (sin_azimuth, cos_azimuth) = azimuth_rad.sin_cos();
        Self {
            orbital_normal_world: [0.0, 0.0, 1.0],
            obliquity_rad,
            azimuth_rad,
            rotation_axis_world: [sin_tilt * cos_azimuth, sin_tilt * sin_azimuth, cos_tilt],
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanetRevisions {
    pub surface: u64,
    pub geology: u64,
    pub water: u64,
    pub climate: u64,
    pub hydrology: u64,
    pub biosphere: u64,
    pub human_geography: u64,
    pub timeline: u64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct PlanetSurfaceSample {
    pub elevation_m: f32,
    pub temperature_c: f32,
    pub moisture: f32,
    pub terrain: u8,
    pub water: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanetSurface {
    pub width: u32,
    pub height: u32,
    pub sea_level_m: f32,
    #[serde(default)]
    elevation_m: Arc<Vec<i16>>,
    #[serde(default)]
    temperature_tenths_c: Arc<Vec<i16>>,
    #[serde(default)]
    moisture: Arc<Vec<u8>>,
    #[serde(default)]
    terrain: Arc<Vec<u8>>,
}

impl PlanetSurface {
    pub const TERRAIN_DEEP_OCEAN: u8 = 0;
    pub const TERRAIN_OCEAN: u8 = 1;
    pub const TERRAIN_SHALLOW_WATER: u8 = 2;
    pub const TERRAIN_ICE: u8 = 3;
    pub const TERRAIN_TUNDRA: u8 = 4;
    pub const TERRAIN_DESERT: u8 = 5;
    pub const TERRAIN_GRASSLAND: u8 = 6;
    pub const TERRAIN_FOREST: u8 = 7;
    pub const TERRAIN_RAINFOREST: u8 = 8;
    pub const TERRAIN_HIGHLAND: u8 = 9;
    pub const TERRAIN_MOUNTAIN: u8 = 10;

    pub fn is_empty(&self) -> bool {
        self.width == 0
            || self.height == 0
            || self.elevation_m.len() != self.width as usize * self.height as usize
    }

    pub const fn dimensions_for_quality(quality: GenerationQuality) -> (u32, u32) {
        match quality {
            GenerationQuality::Draft => (512, 256),
            GenerationQuality::Normal => (1_024, 512),
            GenerationQuality::High => (1_536, 768),
            GenerationQuality::Ultra => (2_048, 1_024),
        }
    }

    pub fn generate(config: &PlanetGenerationConfig, geology: &CausalGeologyModel) -> Self {
        let total_started = Instant::now();
        let (width, height) = Self::dimensions_for_quality(config.quality);
        let cell_count = width as usize * height as usize;
        let continent_seed = config.stable_subseed("planet-continent");
        let detail_seed = config.stable_subseed("planet-surface-detail");
        let fragmentation = config.tectonics.continental_fragmentation.clamp(0.0, 1.0);
        let orogeny = config.tectonics.orogenic_activity.clamp(0.0, 1.0);
        let height_field_started = Instant::now();
        let height_field = (0..cell_count)
            .into_par_iter()
            .map(|index| {
                let y = index as u32 / width;
                let x = index as u32 % width;
                let latitude = std::f64::consts::FRAC_PI_2
                    - (f64::from(y) + 0.5) / f64::from(height) * std::f64::consts::PI;
                let longitude = (f64::from(x) + 0.5) / f64::from(width) * std::f64::consts::TAU
                    - std::f64::consts::PI;
                let position = PlanetPosition::from_latitude_longitude_rad(latitude, longitude);
                let [px, py, pz] = position.components();
                let continental = spherical_fbm(continent_seed, px, py, pz, 1.15, 5);
                let detail = spherical_fbm(detail_seed, px, py, pz, 3.8, 4);
                let (crust_bias, boundary) = fast_geology_influence(geology, position);
                (continental * 0.72
                    + detail * (0.10 + fragmentation * 0.20)
                    + crust_bias * 0.28
                    + boundary * (0.05 + orogeny * 0.20)) as f32
            })
            .collect::<Vec<_>>();
        crate::diagnostics::event(
            "planet_generation",
            "surface_height_field",
            "completed",
            &[
                ("dimensions", format!("{width}x{height}")),
                ("cells", cell_count.to_string()),
                ("plates", geology.plates.len().to_string()),
                (
                    "elapsed_ms",
                    height_field_started.elapsed().as_millis().to_string(),
                ),
            ],
        );

        let ocean_coverage = config
            .hydrosphere
            .target_ocean_coverage
            .unwrap_or_else(|| config.derived_summary().estimated_ocean_coverage)
            .clamp(0.02, 0.98);
        let sea_level_started = Instant::now();
        let mut ordered = height_field.clone();
        ordered.par_sort_unstable_by(f32::total_cmp);
        let sea_index = ((ordered.len().saturating_sub(1)) as f64 * ocean_coverage) as usize;
        let sea_threshold = ordered[sea_index.min(ordered.len().saturating_sub(1))];
        crate::diagnostics::event(
            "planet_generation",
            "sea_level_quantile",
            "completed",
            &[
                ("target_ocean_coverage", format!("{ocean_coverage:.4}")),
                ("sea_threshold", format!("{sea_threshold:.6}")),
                (
                    "elapsed_ms",
                    sea_level_started.elapsed().as_millis().to_string(),
                ),
            ],
        );
        let mean_temperature = config.derived_summary().mean_surface_temperature_c as f32;
        let moisture_bias = config.surface.moisture_bias as f32;
        let climate_seed = config.stable_subseed("planet-climate");
        let max_land_m = (4_500.0 + config.tectonics.orogenic_activity as f32 * 5_000.0)
            .clamp(2_500.0, 10_000.0);
        let max_ocean_m = 8_500.0_f32;
        let climate_cells_started = Instant::now();
        let cells = (0..cell_count)
            .into_par_iter()
            .map(|index| {
                let y = index as u32 / width;
                let x = index as u32 % width;
                let latitude = 90.0 - (y as f32 + 0.5) / height as f32 * 180.0;
                let longitude = (f64::from(x) + 0.5) / f64::from(width) * std::f64::consts::TAU
                    - std::f64::consts::PI;
                let position = PlanetPosition::from_latitude_longitude_deg(
                    f64::from(latitude),
                    longitude.to_degrees(),
                );
                let [px, py, pz] = position.components();
                let relative = height_field[index] - sea_threshold;
                let elevation = if relative >= 0.0 {
                    (relative / (0.42 + relative.abs())).powf(1.18) * max_land_m
                } else {
                    -(relative.abs() / (0.38 + relative.abs())).powf(1.12) * max_ocean_m
                };
                let climate_noise = spherical_fbm(climate_seed, px, py, pz, 2.4, 4) as f32;
                let temperature =
                    mean_temperature - latitude.abs() * 0.34 - elevation.max(0.0) * 0.0062
                        + climate_noise * 5.5;
                let wetness = (moisture_bias
                    + climate_noise * 0.24
                    + if elevation < 0.0 { 0.35 } else { 0.0 }
                    - latitude.abs() / 90.0 * 0.10)
                    .clamp(0.0, 1.0);
                (
                    elevation.round().clamp(-12_000.0, 12_000.0) as i16,
                    (temperature * 10.0).round().clamp(-1_000.0, 1_000.0) as i16,
                    (wetness * 255.0).round() as u8,
                    classify_planet_terrain(elevation, temperature, wetness),
                )
            })
            .collect::<Vec<_>>();
        crate::diagnostics::event(
            "planet_generation",
            "elevation_climate_classification",
            "completed",
            &[
                ("cells", cell_count.to_string()),
                (
                    "elapsed_ms",
                    climate_cells_started.elapsed().as_millis().to_string(),
                ),
            ],
        );
        let pack_started = Instant::now();
        let mut elevation_m = Vec::with_capacity(cell_count);
        let mut temperature_tenths_c = Vec::with_capacity(cell_count);
        let mut moisture = Vec::with_capacity(cell_count);
        let mut terrain = Vec::with_capacity(cell_count);
        for (elevation, temperature, wetness, terrain_class) in cells {
            elevation_m.push(elevation);
            temperature_tenths_c.push(temperature);
            moisture.push(wetness);
            terrain.push(terrain_class);
        }

        crate::diagnostics::event(
            "planet_generation",
            "surface_pack",
            "completed",
            &[
                ("elapsed_ms", pack_started.elapsed().as_millis().to_string()),
                ("total_ms", total_started.elapsed().as_millis().to_string()),
            ],
        );

        Self {
            width,
            height,
            sea_level_m: 0.0,
            elevation_m: Arc::new(elevation_m),
            temperature_tenths_c: Arc::new(temperature_tenths_c),
            moisture: Arc::new(moisture),
            terrain: Arc::new(terrain),
        }
    }

    pub fn sample(&self, position: PlanetPosition) -> PlanetSurfaceSample {
        if self.is_empty() {
            return PlanetSurfaceSample::default();
        }
        let (latitude, longitude) = position.latitude_longitude_rad();
        let normalized_x = (longitude + std::f64::consts::PI) / std::f64::consts::TAU;
        let normalized_y = (std::f64::consts::FRAC_PI_2 - latitude) / std::f64::consts::PI;
        let x = (normalized_x * f64::from(self.width)).floor() as i64;
        let y = (normalized_y * f64::from(self.height)).floor() as i64;
        self.sample_xy(
            x.rem_euclid(i64::from(self.width)) as u32,
            y.clamp(0, i64::from(self.height) - 1) as u32,
        )
    }

    pub fn sample_interpolated(&self, position: PlanetPosition) -> PlanetSurfaceSample {
        if self.is_empty() {
            return PlanetSurfaceSample::default();
        }
        let (latitude, longitude) = position.latitude_longitude_rad();
        let x = (longitude + std::f64::consts::PI) / std::f64::consts::TAU * f64::from(self.width)
            - 0.5;
        let y = (std::f64::consts::FRAC_PI_2 - latitude) / std::f64::consts::PI
            * f64::from(self.height)
            - 0.5;
        let x0 = x.floor() as i64;
        let y0 = y.floor() as i64;
        let tx = (x - x.floor()) as f32;
        let ty = (y - y.floor()) as f32;
        let sample = |offset_x: i64, offset_y: i64| {
            self.sample_xy(
                (x0 + offset_x).rem_euclid(i64::from(self.width)) as u32,
                (y0 + offset_y).clamp(0, i64::from(self.height) - 1) as u32,
            )
        };
        let top_left = sample(0, 0);
        let top_right = sample(1, 0);
        let bottom_left = sample(0, 1);
        let bottom_right = sample(1, 1);
        let bilinear = |top_left: f32, top_right: f32, bottom_left: f32, bottom_right: f32| {
            let top = top_left + (top_right - top_left) * tx;
            let bottom = bottom_left + (bottom_right - bottom_left) * tx;
            top + (bottom - top) * ty
        };
        let elevation_m = bilinear(
            top_left.elevation_m,
            top_right.elevation_m,
            bottom_left.elevation_m,
            bottom_right.elevation_m,
        );
        let temperature_c = bilinear(
            top_left.temperature_c,
            top_right.temperature_c,
            bottom_left.temperature_c,
            bottom_right.temperature_c,
        );
        let moisture = bilinear(
            top_left.moisture,
            top_right.moisture,
            bottom_left.moisture,
            bottom_right.moisture,
        )
        .clamp(0.0, 1.0);
        PlanetSurfaceSample {
            elevation_m,
            temperature_c,
            moisture,
            terrain: classify_planet_terrain(elevation_m, temperature_c, moisture),
            water: elevation_m <= self.sea_level_m,
        }
    }

    pub fn sample_xy(&self, x: u32, y: u32) -> PlanetSurfaceSample {
        if self.is_empty() {
            return PlanetSurfaceSample::default();
        }
        let index = (y.min(self.height - 1) * self.width + x % self.width) as usize;
        let elevation_m = f32::from(self.elevation_m[index]);
        PlanetSurfaceSample {
            elevation_m,
            temperature_c: f32::from(self.temperature_tenths_c[index]) / 10.0,
            moisture: f32::from(self.moisture[index]) / 255.0,
            terrain: self.terrain[index],
            water: elevation_m <= self.sea_level_m,
        }
    }

    pub fn ocean_coverage(&self) -> f32 {
        if self.is_empty() {
            return 0.0;
        }
        self.elevation_m
            .iter()
            .filter(|value| f32::from(**value) <= self.sea_level_m)
            .count() as f32
            / self.elevation_m.len() as f32
    }
}

fn classify_planet_terrain(elevation: f32, temperature: f32, moisture: f32) -> u8 {
    if elevation <= -2_500.0 {
        PlanetSurface::TERRAIN_DEEP_OCEAN
    } else if elevation <= -220.0 {
        PlanetSurface::TERRAIN_OCEAN
    } else if elevation <= 0.0 {
        PlanetSurface::TERRAIN_SHALLOW_WATER
    } else if temperature < -7.0 {
        PlanetSurface::TERRAIN_ICE
    } else if elevation > 3_300.0 {
        PlanetSurface::TERRAIN_MOUNTAIN
    } else if elevation > 1_700.0 {
        PlanetSurface::TERRAIN_HIGHLAND
    } else if temperature < 1.0 {
        PlanetSurface::TERRAIN_TUNDRA
    } else if moisture < 0.25 {
        PlanetSurface::TERRAIN_DESERT
    } else if moisture < 0.52 {
        PlanetSurface::TERRAIN_GRASSLAND
    } else if moisture < 0.78 {
        PlanetSurface::TERRAIN_FOREST
    } else {
        PlanetSurface::TERRAIN_RAINFOREST
    }
}

fn fast_geology_influence(geology: &CausalGeologyModel, position: PlanetPosition) -> (f64, f64) {
    let [px, py, pz] = position.components();
    let mut nearest = (f64::NEG_INFINITY, 0_usize);
    let mut second = f64::NEG_INFINITY;
    for (index, plate) in geology.plates.iter().enumerate() {
        let [cx, cy, cz] = plate.center.components();
        let dot = px * cx + py * cy + pz * cz;
        if dot > nearest.0 {
            second = nearest.0;
            nearest = (dot, index);
        } else if dot > second {
            second = dot;
        }
    }
    let crust_bias = geology
        .plates
        .get(nearest.1)
        .map(|plate| match plate.crust {
            CrustType::Continental => 0.58,
            CrustType::Oceanic => -0.52,
            CrustType::Transitional => 0.05,
        })
        .unwrap_or(0.0);
    let boundary = if second.is_finite() {
        (1.0 - (nearest.0 - second).abs() * 7.5).clamp(0.0, 1.0)
    } else {
        0.0
    };
    (crust_bias, boundary)
}

pub(crate) fn spherical_fbm(seed: u64, x: f64, y: f64, z: f64, frequency: f64, octaves: u8) -> f64 {
    let mut value = 0.0;
    let mut amplitude = 1.0;
    let mut total = 0.0;
    let mut scale = frequency;
    for octave in 0..octaves {
        value += value_noise_3d(
            seed.wrapping_add(u64::from(octave) * 0x9e37_79b9),
            x * scale,
            y * scale,
            z * scale,
        ) * amplitude;
        total += amplitude;
        amplitude *= 0.5;
        scale *= 2.03;
    }
    value / total.max(f64::EPSILON)
}

fn value_noise_3d(seed: u64, x: f64, y: f64, z: f64) -> f64 {
    let x0 = x.floor() as i64;
    let y0 = y.floor() as i64;
    let z0 = z.floor() as i64;
    let tx = smoothstep(x - x.floor());
    let ty = smoothstep(y - y.floor());
    let tz = smoothstep(z - z.floor());
    let mut layer = [[0.0_f64; 2]; 2];
    for dz in 0..2 {
        for dy in 0..2 {
            let left = hash_noise(seed, x0, y0 + dy as i64, z0 + dz as i64);
            let right = hash_noise(seed, x0 + 1, y0 + dy as i64, z0 + dz as i64);
            layer[dz][dy] = left + (right - left) * tx;
        }
    }
    let lower = layer[0][0] + (layer[0][1] - layer[0][0]) * ty;
    let upper = layer[1][0] + (layer[1][1] - layer[1][0]) * ty;
    lower + (upper - lower) * tz
}

fn hash_noise(seed: u64, x: i64, y: i64, z: i64) -> f64 {
    let mut value = seed
        ^ (x as u64).wrapping_mul(0x9e37_79b9_7f4a_7c15)
        ^ (y as u64).wrapping_mul(0xbf58_476d_1ce4_e5b9)
        ^ (z as u64).wrapping_mul(0x94d0_49bb_1331_11eb);
    value ^= value >> 30;
    value = value.wrapping_mul(0xbf58_476d_1ce4_e5b9);
    value ^= value >> 27;
    value = value.wrapping_mul(0x94d0_49bb_1331_11eb);
    value ^= value >> 31;
    (value as f64 / u64::MAX as f64) * 2.0 - 1.0
}

fn smoothstep(value: f64) -> f64 {
    value * value * (3.0 - 2.0 * value)
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RegionDetailLevel {
    Regional,
    #[default]
    Detailed,
    Local,
    Custom,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RefinementLevel {
    Off,
    Low,
    #[default]
    Normal,
    High,
    Ultra,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RegionCachePolicy {
    #[default]
    ReuseExisting,
    RefreshMissing,
    RebuildAll,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ContextMode {
    #[default]
    Auto,
    Fixed,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegionContextConfig {
    pub mode: ContextMode,
    pub minimum_margin_m: f64,
    pub proportional_margin: f32,
    pub extend_for_hydrology: bool,
    pub extend_for_orogens: bool,
    pub extend_for_coast: bool,
    pub extend_for_climate: bool,
}

impl Default for RegionContextConfig {
    fn default() -> Self {
        Self {
            mode: ContextMode::Auto,
            minimum_margin_m: 100_000.0,
            proportional_margin: 0.15,
            extend_for_hydrology: true,
            extend_for_orogens: true,
            extend_for_coast: true,
            extend_for_climate: true,
        }
    }
}

impl RegionContextConfig {
    pub fn margin_m(&self, width_m: f64, height_m: f64) -> f64 {
        match self.mode {
            ContextMode::Auto => self
                .minimum_margin_m
                .max(width_m.max(height_m) * f64::from(self.proportional_margin.max(0.0))),
            ContextMode::Fixed => self.minimum_margin_m.max(0.0),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerrainRefinementConfig {
    pub level: RefinementLevel,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeologicalRefinementConfig {
    pub level: RefinementLevel,
    pub resolve_lithology: bool,
    pub resolve_minor_faults: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HydrologyRefinementConfig {
    pub level: RefinementLevel,
    pub resolve_small_tributaries: bool,
    pub refine_channel_geometry: bool,
    pub resolve_floodplains: bool,
    pub resolve_small_lakes: bool,
    pub resolve_wetlands: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClimateRefinementConfig {
    pub level: RefinementLevel,
    pub refine_temperature: bool,
    pub refine_precipitation: bool,
    pub refine_orographic_effects: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoastRefinementConfig {
    pub level: RefinementLevel,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CryosphereRefinementConfig {
    pub level: RefinementLevel,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EcologyRefinementConfig {
    pub level: RefinementLevel,
    pub resolve_soil: bool,
    pub resolve_vegetation: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegionGenerationConfig {
    pub target_resolution_m: f64,
    pub detail_level: RegionDetailLevel,
    pub quality: GenerationQuality,
    pub terrain: TerrainRefinementConfig,
    pub geology: GeologicalRefinementConfig,
    pub hydrology: HydrologyRefinementConfig,
    pub climate: ClimateRefinementConfig,
    pub coast: CoastRefinementConfig,
    pub cryosphere: CryosphereRefinementConfig,
    pub ecology: EcologyRefinementConfig,
    pub context: RegionContextConfig,
    pub cache_policy: RegionCachePolicy,
}

impl Default for RegionGenerationConfig {
    fn default() -> Self {
        let mut value = Self {
            target_resolution_m: 100.0,
            detail_level: RegionDetailLevel::Detailed,
            quality: GenerationQuality::High,
            terrain: TerrainRefinementConfig {
                level: RefinementLevel::High,
            },
            geology: GeologicalRefinementConfig {
                level: RefinementLevel::High,
                resolve_lithology: true,
                resolve_minor_faults: true,
            },
            hydrology: HydrologyRefinementConfig {
                level: RefinementLevel::High,
                resolve_small_tributaries: true,
                refine_channel_geometry: true,
                resolve_floodplains: true,
                resolve_small_lakes: true,
                resolve_wetlands: true,
            },
            climate: ClimateRefinementConfig {
                level: RefinementLevel::Normal,
                refine_temperature: true,
                refine_precipitation: true,
                refine_orographic_effects: true,
            },
            coast: CoastRefinementConfig {
                level: RefinementLevel::High,
            },
            cryosphere: CryosphereRefinementConfig {
                level: RefinementLevel::Normal,
            },
            ecology: EcologyRefinementConfig {
                level: RefinementLevel::High,
                resolve_soil: true,
                resolve_vegetation: true,
            },
            context: RegionContextConfig::default(),
            cache_policy: RegionCachePolicy::ReuseExisting,
        };
        value.apply_detail_preset();
        value
    }
}

impl RegionGenerationConfig {
    pub fn apply_detail_preset(&mut self) {
        let (terrain, geology, hydrology, climate, coast, ecology) = match self.detail_level {
            RegionDetailLevel::Regional => (
                RefinementLevel::Normal,
                RefinementLevel::Normal,
                RefinementLevel::Normal,
                RefinementLevel::Low,
                RefinementLevel::Normal,
                RefinementLevel::Low,
            ),
            RegionDetailLevel::Detailed => (
                RefinementLevel::High,
                RefinementLevel::High,
                RefinementLevel::High,
                RefinementLevel::Normal,
                RefinementLevel::High,
                RefinementLevel::High,
            ),
            RegionDetailLevel::Local => (
                RefinementLevel::Ultra,
                RefinementLevel::Ultra,
                RefinementLevel::Ultra,
                RefinementLevel::High,
                RefinementLevel::Ultra,
                RefinementLevel::Ultra,
            ),
            RegionDetailLevel::Custom => return,
        };
        self.terrain.level = terrain;
        self.geology.level = geology;
        self.hydrology.level = hydrology;
        self.climate.level = climate;
        self.coast.level = coast;
        self.ecology.level = ecology;
        self.hydrology.resolve_small_tributaries = hydrology >= RefinementLevel::High;
        self.hydrology.resolve_floodplains = hydrology >= RefinementLevel::High;
        self.hydrology.resolve_small_lakes = hydrology >= RefinementLevel::High;
        self.hydrology.resolve_wetlands = hydrology >= RefinementLevel::High;
        self.ecology.resolve_soil = ecology >= RefinementLevel::High;
        self.ecology.resolve_vegetation = ecology >= RefinementLevel::Normal;
    }

    pub fn validate(&self, width_m: f64, height_m: f64) -> Result<(), String> {
        if !(10.0..=10_000.0).contains(&self.target_resolution_m) {
            return Err("regional target resolution must be between 10 and 10,000 metres".into());
        }
        if !(1_000.0..=4_000_000.0).contains(&width_m)
            || !(1_000.0..=4_000_000.0).contains(&height_m)
        {
            return Err("regional physical sides must be between 1 and 4,000 kilometres".into());
        }
        Ok(())
    }

    pub fn requested_cell_dimensions(&self, width_m: f64, height_m: f64) -> (u64, u64) {
        (
            (width_m / self.target_resolution_m).ceil().max(1.0) as u64,
            (height_m / self.target_resolution_m).ceil().max(1.0) as u64,
        )
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanetDetailTileKey {
    pub latitude_band: i16,
    pub longitude_band: i16,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanetDetailTile {
    pub key: PlanetDetailTileKey,
    pub surface_revision: u64,
    pub generator_version: u32,
    pub detail_seed: u64,
    #[serde(default)]
    pub lods: Vec<PlanetDetailLod>,
    #[serde(default)]
    pub committed_overrides: Vec<RegionalOverride>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanetDetailLod {
    pub resolution_m: f64,
    pub parent_resolution_m: Option<f64>,
    pub field_revision: u64,
    pub sample_count: u64,
    pub checksum: u64,
    pub fields: PlanetDetailFields,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanetDetailFields {
    pub terrain: bool,
    pub geology: bool,
    pub hydrology: bool,
    pub climate: bool,
    pub ecology: bool,
}

impl Default for PlanetDetailFields {
    fn default() -> Self {
        Self {
            terrain: true,
            geology: true,
            hydrology: true,
            climate: true,
            ecology: true,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RegionalOverrideScope {
    #[default]
    RegionOnly,
    Planet,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RegionalOverrideKind {
    ElevationOffsetM(f32),
    ElevationSetM(f32),
    TerrainEdit { terrain: String },
    RiverEdit { feature_id: String },
    CoastEdit,
    TemperatureOffsetC(f32),
    PrecipitationMultiplier(f32),
    VegetationEdit { terrain: String },
    LakeEdit { feature_id: String },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegionalOverride {
    pub id: String,
    pub scope: RegionalOverrideScope,
    pub center: PlanetPosition,
    pub radius_m: f64,
    pub revision: u64,
    pub kind: RegionalOverrideKind,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanetDetailPatchRef {
    pub key: PlanetDetailTileKey,
    pub resolution_m: f64,
    pub surface_revision: u64,
    pub generator_version: u32,
    pub checksum: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegionDetailCoverage {
    pub patch_refs: Vec<PlanetDetailPatchRef>,
    pub existing_patch_count: usize,
    pub generated_patch_count: usize,
    pub requested_cell_count: u64,
    pub estimated_working_set_bytes: u64,
    pub context_margin_m: f64,
}

impl RegionDetailCoverage {
    pub fn existing_percent(&self) -> f64 {
        let total = self.existing_patch_count + self.generated_patch_count;
        if total == 0 {
            0.0
        } else {
            self.existing_patch_count as f64 / total as f64 * 100.0
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanetDetailStore {
    pub schema_version: u32,
    pub tile_span_deg: f64,
    #[serde(default)]
    pub tiles: Vec<PlanetDetailTile>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanetEnvironmentPin {
    pub id: String,
    pub name: String,
    pub position: PlanetPosition,
}

impl Default for PlanetDetailStore {
    fn default() -> Self {
        Self {
            schema_version: 2,
            tile_span_deg: 5.0,
            tiles: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanetState {
    pub id: String,
    pub seed: u64,
    pub generator_version: u32,
    pub physical: PlanetPhysicalDefinition,
    pub revisions: PlanetRevisions,
    #[serde(default)]
    pub generation_config: PlanetGenerationConfig,
    #[serde(default)]
    pub geology: CausalGeologyModel,
    #[serde(default)]
    pub surface: PlanetSurface,
    #[serde(default)]
    pub detail_store: PlanetDetailStore,
    #[serde(default)]
    pub environment_pins: Vec<PlanetEnvironmentPin>,
}

impl Default for PlanetState {
    fn default() -> Self {
        let generation_config = PlanetGenerationConfig::default();
        let derived = generation_config.derived_summary();
        Self {
            id: "planet-primary".to_owned(),
            seed: generation_config.seed,
            generator_version: generation_config.generator_version,
            physical: PlanetPhysicalDefinition {
                radius_m: generation_config.physical.radius_m,
                gravity_ms2: derived.surface_gravity_ms2,
                axial_tilt_deg: generation_config.physical.axial_tilt_deg,
                axial_azimuth_deg: generation_config.physical.axial_azimuth_deg,
                day_length_hours: generation_config.physical.rotation_period_hours,
                orbital_period_days: generation_config.physical.orbital_period_days,
            },
            revisions: PlanetRevisions::default(),
            generation_config,
            geology: CausalGeologyModel::default(),
            surface: PlanetSurface::default(),
            detail_store: PlanetDetailStore::default(),
            environment_pins: Vec::new(),
        }
    }
}

impl PlanetState {
    pub fn apply_generation_config(
        &mut self,
        config: PlanetGenerationConfig,
    ) -> Result<(), String> {
        let total_started = Instant::now();
        config.validate()?;
        let derived = config.derived_summary();
        self.seed = config.seed;
        self.generator_version = config.generator_version;
        self.physical = PlanetPhysicalDefinition {
            radius_m: config.physical.radius_m,
            gravity_ms2: derived.surface_gravity_ms2,
            axial_tilt_deg: config.physical.axial_tilt_deg,
            axial_azimuth_deg: config.physical.axial_azimuth_deg,
            day_length_hours: config.physical.rotation_period_hours,
            orbital_period_days: config.physical.orbital_period_days,
        };
        let geology_started = Instant::now();
        self.geology = CausalGeologyModel::synthesize_with_controls(
            config.stable_subseed("geology"),
            &config.tectonics,
            &config.geology,
        );
        crate::diagnostics::event(
            "planet_generation",
            "plate_synthesis",
            "completed",
            &[
                ("plates", self.geology.plates.len().to_string()),
                ("boundaries", self.geology.boundaries.len().to_string()),
                (
                    "elapsed_ms",
                    geology_started.elapsed().as_millis().to_string(),
                ),
            ],
        );
        let surface_started = Instant::now();
        self.surface = PlanetSurface::generate(&config, &self.geology);
        crate::diagnostics::event(
            "planet_generation",
            "surface_generation",
            "completed",
            &[
                (
                    "dimensions",
                    format!("{}x{}", self.surface.width, self.surface.height),
                ),
                (
                    "elapsed_ms",
                    surface_started.elapsed().as_millis().to_string(),
                ),
                ("total_ms", total_started.elapsed().as_millis().to_string()),
            ],
        );
        self.detail_store = PlanetDetailStore::default();
        self.generation_config = config;
        self.revisions.geology = self.revisions.geology.saturating_add(1);
        self.revisions.climate = self.revisions.climate.saturating_add(1);
        self.revisions.surface = self.revisions.surface.saturating_add(1);
        Ok(())
    }

    pub fn sample_detail(&self, position: PlanetPosition) -> PlanetSurfaceSample {
        self.sample_detail_at_resolution(position, 100.0)
    }

    pub fn sample_detail_at_resolution(
        &self,
        position: PlanetPosition,
        _resolution_m: f64,
    ) -> PlanetSurfaceSample {
        let base = self.surface.sample_interpolated(position);
        if self.surface.is_empty() {
            return base;
        }
        let broad = self.detail_noise(position, "elevation-broad", 96.0, 4) as f32;
        let medium = self.detail_noise(position, "elevation-medium", 384.0, 3) as f32;
        let fine = self.detail_noise(position, "elevation-fine", 1_536.0, 2) as f32;
        let coastal_scale = (base.elevation_m.abs() / 300.0).clamp(0.18, 1.0);
        let elevation_m =
            base.elevation_m + (broad * 135.0 + medium * 42.0 + fine * 12.0) * coastal_scale;
        let temperature_c = base.temperature_c
            + self.detail_noise(position, "temperature", 80.0, 3) as f32 * 1.2
            - (elevation_m - base.elevation_m).max(0.0) * 0.0035;
        let moisture = (base.moisture
            + self.detail_noise(position, "moisture", 72.0, 4) as f32 * 0.075)
            .clamp(0.0, 1.0);
        PlanetSurfaceSample {
            elevation_m,
            temperature_c,
            moisture,
            terrain: classify_planet_terrain(elevation_m, temperature_c, moisture),
            water: elevation_m <= self.surface.sea_level_m,
        }
    }

    pub fn detail_noise(
        &self,
        position: PlanetPosition,
        domain: &str,
        frequency: f64,
        octaves: u8,
    ) -> f64 {
        let [x, y, z] = position.components();
        spherical_fbm(
            self.generation_config
                .stable_subseed(&format!("planet-detail-{domain}")),
            x,
            y,
            z,
            frequency,
            octaves,
        )
    }

    pub fn ensure_region_detail_tiles(
        &mut self,
        center: PlanetPosition,
        width_m: f64,
        height_m: f64,
    ) -> usize {
        let selection = RegionSelection::LocalRectangle {
            center,
            width_m,
            height_m,
            selection_bearing_deg: 0.0,
        };
        self.ensure_region_detail_coverage(&selection, &RegionGenerationConfig::default())
            .generated_patch_count
    }

    pub fn ensure_region_detail_coverage(
        &mut self,
        selection: &RegionSelection,
        config: &RegionGenerationConfig,
    ) -> RegionDetailCoverage {
        let Some((center, width_m, height_m, bearing_deg)) = selection.metric_bounds() else {
            return RegionDetailCoverage::default();
        };
        if config.validate(width_m, height_m).is_err() {
            return RegionDetailCoverage::default();
        }
        let context_margin_m = config.context.margin_m(width_m, height_m);
        let covered_width_m = width_m + context_margin_m * 2.0;
        let covered_height_m = height_m + context_margin_m * 2.0;
        let tile_span = self.detail_store.tile_span_deg.clamp(1.0, 30.0);
        let radius = self.physical.radius_m.max(1.0);
        let longitude_steps =
            ((covered_width_m / radius).to_degrees() / tile_span).ceil() as usize + 2;
        let latitude_steps =
            ((covered_height_m / radius).to_degrees() / tile_span).ceil() as usize + 2;
        let longitude_steps = longitude_steps.clamp(2, 144);
        let latitude_steps = latitude_steps.clamp(2, 72);
        let mut keys = Vec::with_capacity((longitude_steps + 1) * (latitude_steps + 1));
        for y in 0..=latitude_steps {
            let north_m = covered_height_m * (0.5 - y as f64 / latitude_steps as f64);
            for x in 0..=longitude_steps {
                let east_m = covered_width_m * (x as f64 / longitude_steps as f64 - 0.5);
                let position =
                    regional_metric_position_rotated(center, east_m, north_m, bearing_deg, radius);
                let (latitude, longitude) = position.latitude_longitude_deg();
                let key = PlanetDetailTileKey {
                    latitude_band: ((latitude + 90.0) / tile_span).floor() as i16,
                    longitude_band: ((longitude.rem_euclid(360.0)) / tile_span).floor() as i16,
                };
                if !keys.contains(&key) {
                    keys.push(key);
                }
            }
        }
        let requested_resolution = quantized_resolution_m(config.target_resolution_m);
        let surface_revision = self.revisions.surface;
        let generator_version = self.generator_version;
        let generation_seed = self.generation_config.seed;
        let mut existing_patch_count = 0;
        let mut generated_patch_count = 0;
        let mut patch_refs = Vec::with_capacity(keys.len());
        for key in keys {
            let tile_index = self
                .detail_store
                .tiles
                .iter()
                .position(|tile| tile.key == key && tile.surface_revision == surface_revision);
            let tile_index = if let Some(index) = tile_index {
                index
            } else {
                let detail_seed = self.generation_config.stable_subseed(&format!(
                    "detail-tile-{surface_revision}-{}-{}",
                    key.latitude_band, key.longitude_band
                ));
                self.detail_store.tiles.push(PlanetDetailTile {
                    key,
                    surface_revision,
                    generator_version,
                    detail_seed,
                    lods: Vec::new(),
                    committed_overrides: Vec::new(),
                });
                self.detail_store.tiles.len() - 1
            };
            let tile = &mut self.detail_store.tiles[tile_index];
            let matching_lod = tile.lods.iter().position(|lod| {
                lod.resolution_m == requested_resolution && lod.field_revision == surface_revision
            });
            let should_rebuild = config.cache_policy == RegionCachePolicy::RebuildAll;
            let lod_index = if let Some(index) = matching_lod.filter(|_| !should_rebuild) {
                existing_patch_count += 1;
                index
            } else {
                if let Some(index) = matching_lod {
                    tile.lods.remove(index);
                }
                let checksum = detail_patch_checksum(
                    generation_seed,
                    key,
                    requested_resolution,
                    surface_revision,
                    config,
                );
                let tile_span_m = radius * tile_span.to_radians();
                let side_cells = (tile_span_m / requested_resolution).ceil().max(1.0) as u64;
                tile.lods.push(PlanetDetailLod {
                    resolution_m: requested_resolution,
                    parent_resolution_m: Some(
                        (requested_resolution * 4.0)
                            .min(tile_span_m)
                            .max(requested_resolution),
                    ),
                    field_revision: surface_revision,
                    sample_count: side_cells.saturating_mul(side_cells),
                    checksum,
                    fields: PlanetDetailFields {
                        terrain: config.terrain.level != RefinementLevel::Off,
                        geology: config.geology.level != RefinementLevel::Off,
                        hydrology: config.hydrology.level != RefinementLevel::Off,
                        climate: config.climate.level != RefinementLevel::Off,
                        ecology: config.ecology.level != RefinementLevel::Off,
                    },
                });
                generated_patch_count += 1;
                tile.lods.len() - 1
            };
            let lod = &tile.lods[lod_index];
            patch_refs.push(PlanetDetailPatchRef {
                key,
                resolution_m: lod.resolution_m,
                surface_revision: tile.surface_revision,
                generator_version: tile.generator_version,
                checksum: lod.checksum,
            });
        }
        self.detail_store.tiles.sort_by_key(|tile| tile.key);
        patch_refs.sort_by_key(|patch| patch.key);
        let (width_cells, height_cells) = config.requested_cell_dimensions(width_m, height_m);
        let requested_cell_count = width_cells.saturating_mul(height_cells);
        RegionDetailCoverage {
            patch_refs,
            existing_patch_count,
            generated_patch_count,
            requested_cell_count,
            estimated_working_set_bytes: requested_cell_count.saturating_mul(32),
            context_margin_m,
        }
    }

    pub fn commit_regional_override(&mut self, value: RegionalOverride) -> usize {
        let tile_span = self.detail_store.tile_span_deg.clamp(1.0, 30.0);
        let (latitude, longitude) = value.center.latitude_longitude_deg();
        let latitude_radius_deg = (value.radius_m / self.physical.radius_m.max(1.0)).to_degrees();
        let longitude_radius_deg = latitude_radius_deg / latitude.to_radians().cos().abs().max(0.1);
        let min_latitude_band =
            ((latitude - latitude_radius_deg + 90.0) / tile_span).floor() as i16;
        let max_latitude_band =
            ((latitude + latitude_radius_deg + 90.0) / tile_span).floor() as i16;
        let min_longitude_band =
            ((longitude - longitude_radius_deg).rem_euclid(360.0) / tile_span).floor() as i16;
        let max_longitude_band =
            ((longitude + longitude_radius_deg).rem_euclid(360.0) / tile_span).floor() as i16;
        let mut changed = 0;
        for tile in &mut self.detail_store.tiles {
            let latitude_matches =
                (min_latitude_band..=max_latitude_band).contains(&tile.key.latitude_band);
            let longitude_matches = if min_longitude_band <= max_longitude_band {
                (min_longitude_band..=max_longitude_band).contains(&tile.key.longitude_band)
            } else {
                tile.key.longitude_band >= min_longitude_band
                    || tile.key.longitude_band <= max_longitude_band
            };
            if latitude_matches && longitude_matches {
                tile.committed_overrides
                    .retain(|entry| entry.id != value.id);
                tile.committed_overrides.push(value.clone());
                changed += 1;
            }
        }
        changed
    }
}

fn quantized_resolution_m(value: f64) -> f64 {
    (value.clamp(10.0, 10_000.0) * 10.0).round() / 10.0
}

fn detail_patch_checksum(
    seed: u64,
    key: PlanetDetailTileKey,
    resolution_m: f64,
    surface_revision: u64,
    config: &RegionGenerationConfig,
) -> u64 {
    let mut value = seed
        ^ (key.latitude_band as i64 as u64).rotate_left(9)
        ^ (key.longitude_band as i64 as u64).rotate_left(23)
        ^ resolution_m.to_bits()
        ^ surface_revision.rotate_left(37);
    value ^= (config.terrain.level as u64) << 3;
    value ^= (config.geology.level as u64) << 7;
    value ^= (config.hydrology.level as u64) << 11;
    value ^= (config.climate.level as u64) << 15;
    value ^= (config.coast.level as u64) << 19;
    value ^= (config.ecology.level as u64) << 23;
    value ^= value >> 30;
    value = value.wrapping_mul(0xbf58_476d_1ce4_e5b9);
    value ^= value >> 27;
    value = value.wrapping_mul(0x94d0_49bb_1331_11eb);
    value ^ (value >> 31)
}

pub fn regional_metric_position(
    center: PlanetPosition,
    east_m: f64,
    north_m: f64,
    radius_m: f64,
) -> PlanetPosition {
    let (center_latitude, center_longitude) = center.latitude_longitude_rad();
    let latitude = (center_latitude + north_m / radius_m)
        .clamp(-std::f64::consts::FRAC_PI_2, std::f64::consts::FRAC_PI_2);
    let mean_latitude = (center_latitude + latitude) * 0.5;
    let longitude = center_longitude + east_m / (radius_m * mean_latitude.cos().abs().max(1.0e-8));
    PlanetPosition::from_latitude_longitude_rad(latitude, longitude)
}

pub fn regional_metric_position_rotated(
    center: PlanetPosition,
    east_m: f64,
    north_m: f64,
    bearing_deg: f64,
    radius_m: f64,
) -> PlanetPosition {
    let (sin_bearing, cos_bearing) = bearing_deg.to_radians().sin_cos();
    regional_metric_position(
        center,
        east_m * cos_bearing - north_m * sin_bearing,
        east_m * sin_bearing + north_m * cos_bearing,
        radius_m,
    )
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RegionSelection {
    LocalRectangle {
        center: PlanetPosition,
        width_m: f64,
        height_m: f64,
        selection_bearing_deg: f64,
    },
    Radius {
        center: PlanetPosition,
        radius_m: f64,
    },
    SphericalPolygon {
        vertices: Vec<PlanetPosition>,
    },
    DrainageBasin {
        basin_id: String,
    },
    FeatureEnvelope {
        feature_ids: Vec<String>,
        padding_m: f64,
    },
    FullPlanet,
    UnplacedLegacy {
        width_m: f64,
        height_m: f64,
    },
}

impl Default for RegionSelection {
    fn default() -> Self {
        Self::UnplacedLegacy {
            width_m: 1.0,
            height_m: 1.0,
        }
    }
}

impl RegionSelection {
    pub fn metric_bounds(&self) -> Option<(PlanetPosition, f64, f64, f64)> {
        match self {
            Self::LocalRectangle {
                center,
                width_m,
                height_m,
                selection_bearing_deg,
            } => Some((*center, *width_m, *height_m, *selection_bearing_deg)),
            Self::Radius { center, radius_m } => {
                Some((*center, radius_m * 2.0, radius_m * 2.0, 0.0))
            }
            Self::SphericalPolygon { vertices } if !vertices.is_empty() => {
                let center = spherical_centroid(vertices)?;
                let radius_m = vertices
                    .iter()
                    .map(|point| center.angular_distance_rad(*point))
                    .fold(0.0_f64, f64::max);
                Some((center, radius_m * 2.0, radius_m * 2.0, 0.0))
            }
            Self::UnplacedLegacy { width_m, height_m } => {
                Some((PlanetPosition::default(), *width_m, *height_m, 0.0))
            }
            Self::DrainageBasin { .. } | Self::FeatureEnvelope { .. } | Self::FullPlanet => None,
            Self::SphericalPolygon { .. } => None,
        }
    }

    pub fn stable_checksum(&self) -> u64 {
        let json = serde_json::to_vec(self).unwrap_or_default();
        json.into_iter().fold(0xcbf2_9ce4_8422_2325, |hash, byte| {
            (hash ^ u64::from(byte)).wrapping_mul(0x100_0000_01b3)
        })
    }
}

fn spherical_centroid(vertices: &[PlanetPosition]) -> Option<PlanetPosition> {
    let mut x = 0.0;
    let mut y = 0.0;
    let mut z = 0.0;
    for vertex in vertices {
        let components = vertex.components();
        x += components[0];
        y += components[1];
        z += components[2];
    }
    PlanetPosition::new(x, y, z).ok()
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegionProvenance {
    pub source_planet_id: String,
    pub source_planet_revision: u64,
    pub generator_version: u32,
    pub selection_checksum: u64,
    pub target_resolution_m: f64,
    pub context_margin_m: f64,
    #[serde(default)]
    pub parent_patch_checksums: Vec<u64>,
    pub refinement_revision: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetailedRegion {
    pub id: String,
    pub region_id: String,
    pub planet_id: String,
    #[serde(default)]
    pub patch_refs: Vec<PlanetDetailPatchRef>,
    pub output_width_cells: u64,
    pub output_height_cells: u64,
    pub constraints_checksum: u64,
    #[serde(default)]
    pub config: RegionGenerationConfig,
    pub revision: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegionDefinition {
    pub id: String,
    pub planet_id: String,
    pub name: String,
    pub selection: RegionSelection,
    pub detail_level: u8,
    pub revision: u64,
    #[serde(default)]
    pub generation_config: RegionGenerationConfig,
    #[serde(default)]
    pub provenance: Option<RegionProvenance>,
    #[serde(default)]
    pub patch_refs: Vec<PlanetDetailPatchRef>,
    #[serde(default)]
    pub regional_overrides: Vec<RegionalOverride>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectedBounds {
    pub left_m: f64,
    pub bottom_m: f64,
    pub right_m: f64,
    pub top_m: f64,
}

impl ProjectedBounds {
    pub fn width_m(self) -> f64 {
        self.right_m - self.left_m
    }

    pub fn height_m(self) -> f64 {
        self.top_m - self.bottom_m
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MapViewDefinition {
    pub id: String,
    pub region_id: String,
    pub name: String,
    pub projection: ProjectionDefinition,
    pub view_rotation_deg: f64,
    pub projected_bounds: ProjectedBounds,
    pub output_width_px: u32,
    pub output_height_px: u32,
    pub projection_revision: u64,
}

impl MapViewDefinition {
    pub fn projected_to_pixel(&self, point: ProjectedMetricPoint) -> Option<MapPixelPoint> {
        let point = point.rotate(self.view_rotation_deg);
        let width = self.projected_bounds.width_m();
        let height = self.projected_bounds.height_m();
        if width <= 0.0 || height <= 0.0 {
            return None;
        }
        Some(MapPixelPoint {
            x: (point.east_m - self.projected_bounds.left_m) / width
                * f64::from(self.output_width_px),
            y: (self.projected_bounds.top_m - point.north_m) / height
                * f64::from(self.output_height_px),
        })
    }

    pub fn pixel_to_projected(&self, pixel: MapPixelPoint) -> Option<ProjectedMetricPoint> {
        if self.output_width_px == 0 || self.output_height_px == 0 {
            return None;
        }
        let point = ProjectedMetricPoint {
            east_m: self.projected_bounds.left_m
                + (pixel.x + 0.5) / f64::from(self.output_width_px)
                    * self.projected_bounds.width_m(),
            north_m: self.projected_bounds.top_m
                - (pixel.y + 0.5) / f64::from(self.output_height_px)
                    * self.projected_bounds.height_m(),
        };
        Some(point.rotate(-self.view_rotation_deg))
    }

    pub fn planet_to_pixel(
        &self,
        position: PlanetPosition,
        radius_m: f64,
    ) -> Result<MapPixelPoint, ProjectionError> {
        let projected = self.projection.project(position, radius_m)?;
        self.projected_to_pixel(projected)
            .ok_or(ProjectionError::InvalidParameters)
    }

    pub fn pixel_to_planet(
        &self,
        pixel: MapPixelPoint,
        radius_m: f64,
    ) -> Result<PlanetPosition, ProjectionError> {
        let projected = self
            .pixel_to_projected(pixel)
            .ok_or(ProjectionError::InvalidParameters)?;
        self.projection.unproject(projected, radius_m)
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MapPixelPoint {
    pub x: f64,
    pub y: f64,
}

pub fn generated_region_and_view(
    planet: &PlanetState,
    source_id: &str,
    name: &str,
    center_latitude_deg: f64,
    width_km: f64,
    height_km: f64,
    output_width_px: u32,
    output_height_px: u32,
) -> (RegionDefinition, MapViewDefinition) {
    generated_region_and_view_at(
        planet,
        source_id,
        name,
        PlanetPosition::from_latitude_longitude_deg(center_latitude_deg, 0.0),
        width_km,
        height_km,
        output_width_px,
        output_height_px,
    )
}

pub fn generated_region_and_view_at(
    planet: &PlanetState,
    source_id: &str,
    name: &str,
    center: PlanetPosition,
    width_km: f64,
    height_km: f64,
    output_width_px: u32,
    output_height_px: u32,
) -> (RegionDefinition, MapViewDefinition) {
    let region_id = format!("region-{source_id}");
    let width_m = width_km * 1_000.0;
    let height_m = height_km * 1_000.0;
    let half_latitude_span_deg = (height_m / (2.0 * planet.physical.radius_m)).to_degrees();
    let (center_latitude_deg, _) = center.latitude_longitude_deg();
    let selection = RegionSelection::LocalRectangle {
        center,
        width_m,
        height_m,
        selection_bearing_deg: 0.0,
    };
    let projection = ProjectionSelector::select(
        ProjectionSelectionInput {
            center,
            width_m,
            height_m,
            includes_north_pole: center_latitude_deg + half_latitude_span_deg >= 90.0,
            includes_south_pole: center_latitude_deg - half_latitude_span_deg <= -90.0,
            full_planet: width_m >= 2.0 * std::f64::consts::PI * planet.physical.radius_m * 0.98,
        },
        planet.physical.radius_m,
    );
    let region = RegionDefinition {
        id: region_id.clone(),
        planet_id: planet.id.clone(),
        name: name.to_owned(),
        selection,
        detail_level: 0,
        revision: 0,
        generation_config: RegionGenerationConfig::default(),
        provenance: None,
        patch_refs: Vec::new(),
        regional_overrides: Vec::new(),
    };
    let view = MapViewDefinition {
        id: format!("view-{source_id}"),
        region_id,
        name: name.to_owned(),
        projection,
        view_rotation_deg: 0.0,
        projected_bounds: ProjectedBounds {
            left_m: -width_m * 0.5,
            bottom_m: -height_m * 0.5,
            right_m: width_m * 0.5,
            top_m: height_m * 0.5,
        },
        output_width_px,
        output_height_px,
        projection_revision: 0,
    };
    (region, view)
}

pub fn legacy_region_and_view(
    planet: &PlanetState,
    source_id: &str,
    name: &str,
    width_km: f64,
    height_km: f64,
    output_width_px: u32,
    output_height_px: u32,
) -> (RegionDefinition, MapViewDefinition) {
    let region_id = format!("legacy-region-{source_id}");
    (
        RegionDefinition {
            id: region_id.clone(),
            planet_id: planet.id.clone(),
            name: name.to_owned(),
            selection: RegionSelection::UnplacedLegacy {
                width_m: width_km * 1_000.0,
                height_m: height_km * 1_000.0,
            },
            detail_level: 0,
            revision: 0,
            generation_config: RegionGenerationConfig::default(),
            provenance: None,
            patch_refs: Vec::new(),
            regional_overrides: Vec::new(),
        },
        MapViewDefinition {
            id: format!("legacy-view-{source_id}"),
            region_id,
            name: name.to_owned(),
            projection: ProjectionDefinition::legacy_planar(),
            view_rotation_deg: 0.0,
            projected_bounds: ProjectedBounds {
                left_m: 0.0,
                bottom_m: 0.0,
                right_m: width_km * 1_000.0,
                top_m: height_km * 1_000.0,
            },
            output_width_px,
            output_height_px,
            projection_revision: 0,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn planet_positions_are_normalized_and_finite() {
        let point = PlanetPosition::new(4.0, -2.0, 8.0).unwrap();
        let [x, y, z] = point.components();
        assert!(((x * x + y * y + z * z).sqrt() - 1.0).abs() < 1.0e-12);
        assert!(PlanetPosition::new(f64::NAN, 0.0, 0.0).is_err());
        assert!(PlanetPosition::new(0.0, 0.0, 0.0).is_err());
    }

    #[test]
    fn planet_reference_frame_uses_obliquity_and_azimuth() {
        let upright = PlanetPhysicalDefinition {
            axial_tilt_deg: 0.0,
            axial_azimuth_deg: 217.0,
            ..PlanetPhysicalDefinition::default()
        };
        let frame = PlanetReferenceFrame::from_physical(&upright);
        assert!((frame.rotation_axis_world[0]).abs() < 1.0e-12);
        assert!((frame.rotation_axis_world[1]).abs() < 1.0e-12);
        assert!((frame.rotation_axis_world[2] - 1.0).abs() < 1.0e-12);

        let quarter_turn = PlanetPhysicalDefinition {
            axial_tilt_deg: 90.0,
            axial_azimuth_deg: 90.0,
            ..PlanetPhysicalDefinition::default()
        };
        let frame = PlanetReferenceFrame::from_physical(&quarter_turn);
        assert!((frame.rotation_axis_world[0]).abs() < 1.0e-12);
        assert!((frame.rotation_axis_world[1] - 1.0).abs() < 1.0e-12);
        assert!((frame.rotation_axis_world[2]).abs() < 1.0e-12);
    }

    #[test]
    fn view_rotation_changes_pixels_without_moving_the_region() {
        let planet = PlanetState::default();
        let (_, mut view) =
            generated_region_and_view(&planet, "map-a", "A", 37.5, 500.0, 300.0, 5_000, 3_000);
        let target = PlanetPosition::from_latitude_longitude_deg(37.5, 1.0);
        let original = view
            .planet_to_pixel(target, planet.physical.radius_m)
            .unwrap();
        view.view_rotation_deg = 90.0;
        let rotated = view
            .planet_to_pixel(target, planet.physical.radius_m)
            .unwrap();
        assert!((original.x - rotated.x).abs() > 10.0);
        let restored = view
            .pixel_to_planet(rotated, planet.physical.radius_m)
            .unwrap();
        assert!(target.great_circle_distance_m(restored, planet.physical.radius_m) < 200.0);
    }

    #[test]
    fn legacy_views_refuse_to_invent_spherical_coordinates() {
        let planet = PlanetState::default();
        let (_, view) = legacy_region_and_view(&planet, "old", "Old", 500.0, 300.0, 5_000, 3_000);
        assert_eq!(
            view.pixel_to_planet(MapPixelPoint { x: 10.0, y: 10.0 }, planet.physical.radius_m),
            Err(ProjectionError::LegacyPlanarHasNoSphericalTransform)
        );
    }

    #[test]
    fn missing_generation_config_migrates_to_a_stable_default() {
        let planet = PlanetState::default();
        let mut value = serde_json::to_value(&planet).expect("serialize planet");
        value
            .as_object_mut()
            .expect("planet object")
            .remove("generationConfig");
        let migrated: PlanetState = serde_json::from_value(value).expect("migrate old planet");
        assert_eq!(migrated.generation_config.schema_version, 1);
        assert_eq!(migrated.generation_config.seed, 990_500_051);
    }

    #[test]
    fn applying_the_same_planet_config_is_deterministic() {
        let mut config = PlanetGenerationConfig::default();
        config.quality = GenerationQuality::Draft;
        let mut first = PlanetState::default();
        let mut second = PlanetState::default();
        first
            .apply_generation_config(config.clone())
            .expect("first config");
        second
            .apply_generation_config(config)
            .expect("second config");
        assert_eq!(first.geology, second.geology);
        assert_eq!(first.physical, second.physical);
        assert_eq!(first.surface, second.surface);
        assert!((first.surface.ocean_coverage() - 0.71).abs() < 0.02);
    }

    #[test]
    fn planet_surface_quality_uses_double_linear_resolution() {
        assert_eq!(
            PlanetSurface::dimensions_for_quality(GenerationQuality::Draft),
            (512, 256)
        );
        assert_eq!(
            PlanetSurface::dimensions_for_quality(GenerationQuality::Normal),
            (1_024, 512)
        );
        assert_eq!(
            PlanetSurface::dimensions_for_quality(GenerationQuality::High),
            (1_536, 768)
        );
        assert_eq!(
            PlanetSurface::dimensions_for_quality(GenerationQuality::Ultra),
            (2_048, 1_024)
        );
    }

    #[test]
    fn planet_surface_wraps_without_a_longitude_seam() {
        let mut config = PlanetGenerationConfig::default();
        config.quality = GenerationQuality::Draft;
        let geology = CausalGeologyModel::synthesize_with_controls(
            config.stable_subseed("geology"),
            &config.tectonics,
            &config.geology,
        );
        let surface = PlanetSurface::generate(&config, &geology);
        assert_eq!(
            surface.sample(PlanetPosition::from_latitude_longitude_deg(24.0, -180.0)),
            surface.sample(PlanetPosition::from_latitude_longitude_deg(24.0, 180.0))
        );
    }

    #[test]
    fn planet_detail_samples_are_spatially_stable_and_persist_tile_provenance() {
        let mut config = PlanetGenerationConfig::default();
        config.quality = GenerationQuality::Draft;
        let mut planet = PlanetState::default();
        planet
            .apply_generation_config(config)
            .expect("planet generation");
        let center = PlanetPosition::from_latitude_longitude_deg(34.5, 127.0);
        let first = planet.sample_detail(center);
        let second = planet.sample_detail(center);
        assert_eq!(first, second);

        let added = planet.ensure_region_detail_tiles(center, 600_000.0, 360_000.0);
        assert!(added > 0);
        let stored = planet.detail_store.tiles.clone();
        let reused = planet.ensure_region_detail_tiles(center, 600_000.0, 360_000.0);
        assert_eq!(reused, 0);
        assert_eq!(planet.detail_store.tiles, stored);

        let json = serde_json::to_vec(&planet).expect("serialize planet detail store");
        let restored: PlanetState = serde_json::from_slice(&json).expect("restore planet");
        assert_eq!(restored.detail_store, planet.detail_store);
        assert_eq!(restored.sample_detail(center), first);
    }

    #[test]
    fn same_spherical_position_has_same_parent_terrain_at_every_resolution() {
        let mut config = PlanetGenerationConfig::default();
        config.quality = GenerationQuality::Draft;
        let mut planet = PlanetState::default();
        planet
            .apply_generation_config(config)
            .expect("planet generation");
        for position in [
            PlanetPosition::from_latitude_longitude_deg(37.5, 128.0),
            PlanetPosition::from_latitude_longitude_deg(-12.0, 174.0),
            PlanetPosition::from_latitude_longitude_deg(68.0, -32.0),
        ] {
            let fine = planet.sample_detail_at_resolution(position, 100.0);
            let medium = planet.sample_detail_at_resolution(position, 500.0);
            let coarse = planet.sample_detail_at_resolution(position, 1_000.0);
            assert_eq!(fine, medium);
            assert_eq!(fine, coarse);
        }
    }
}
