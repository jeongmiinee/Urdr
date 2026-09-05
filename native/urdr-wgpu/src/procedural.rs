use serde::{Deserialize, Serialize};

use crate::generator::{KoppenClimate, RegionType};
use crate::spatial::{PlanetPosition, spherical_fbm};

const TAU: f64 = std::f64::consts::TAU;

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub enum CrustKind {
    #[default]
    Continental,
    Oceanic,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct GeologicSite {
    pub x_km: f32,
    pub y_km: f32,
    pub velocity_x: f32,
    pub velocity_y: f32,
    pub crust: CrustKind,
    pub age: f32,
    pub resistance: f32,
    pub hotspot: f32,
    pub neighbors: Vec<u16>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct GeologicGuideMesh {
    pub revision: u8,
    pub seed: u32,
    pub width_km: f32,
    pub height_km: f32,
    pub sites: Vec<GeologicSite>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct GenerationDiagnostics {
    pub pipeline_revision: u8,
    pub stages: Vec<GenerationStageDiagnostic>,
    pub checks: Vec<GenerationCheck>,
    pub peak_materialized_cells: u64,
    #[serde(default)]
    pub physical_analysis_revision: u16,
    #[serde(default)]
    pub physical_refinement_patches: u32,
    #[serde(default)]
    pub physical_refined_cells: u64,
    #[serde(default)]
    pub physical_peak_scratch_bytes: u64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct GenerationStageDiagnostic {
    pub name: String,
    pub elapsed_micros: u64,
    pub stage_seed: u32,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct GenerationCheck {
    pub name: String,
    pub passed: bool,
    pub detail: String,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct GeologySample {
    pub uplift: f32,
    pub rift: f32,
    pub transform: f32,
    pub hotspot: f32,
    pub rock_resistance: f32,
    pub feature_age: f32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GeologyTermMask {
    pub motion: bool,
    pub resistance_age: bool,
    pub hotspot: bool,
}

impl GeologyTermMask {
    pub const ALL: Self = Self {
        motion: true,
        resistance_age: true,
        hotspot: true,
    };

    pub const MOTION_ONLY: Self = Self {
        motion: true,
        resistance_age: false,
        hotspot: false,
    };

    pub const HOTSPOT_ONLY: Self = Self {
        motion: false,
        resistance_age: false,
        hotspot: true,
    };

    pub const NONE: Self = Self {
        motion: false,
        resistance_age: false,
        hotspot: false,
    };
}

#[derive(Clone, Copy, Debug)]
pub struct TerrainFieldConfig {
    pub seed: u32,
    pub width_km: f32,
    pub height_km: f32,
    pub region_type: RegionType,
    pub maximum_elevation_m: f32,
    pub elevation_span_m: f32,
    pub elevation_noise: f32,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct TerrainFieldSample {
    pub elevation_m: f32,
    pub land_signal: f32,
    pub ocean: bool,
    pub ridge: f32,
    pub roughness: f32,
    pub basin: f32,
    pub warp_x_km: f32,
    pub warp_y_km: f32,
}

/// Inputs reserved for deterministic detail processes. Climate and hydrology
/// fields are present now so later geomorphology can extend this layer without
/// changing its world-position or seed contract.
#[derive(Clone, Copy, Debug)]
pub struct TerrainResidualContext {
    pub position: PlanetPosition,
    pub parent_elevation_m: f32,
    pub slope_m_per_km: f32,
    pub geology_boundary: f32,
    pub erodibility: f32,
    pub temperature_c: f32,
    pub precipitation_mm: f32,
    pub aridity: f32,
    pub cryosphere: f32,
    pub coastal_distance_km: f32,
    pub hydrology_context: f32,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct TerrainResidualSample {
    pub elevation_m: f32,
    pub ridge: f32,
    pub roughness: f32,
}

pub fn sample_parent_constrained_residual(
    parent_world_seed: u64,
    context: TerrainResidualContext,
    elevation_noise: f32,
) -> TerrainResidualSample {
    let [x, y, z] = context.position.components();
    let noise = elevation_noise.clamp(0.0, 1.0);

    // Planet and regional analysis own all macro relief. These bands begin at
    // meso/local wavelengths and are sampled in spherical coordinates, so the
    // same world point is independent of Region extent, resolution and order.
    let broad = spherical_fbm(
        parent_world_seed ^ 0x4d45_534f_5245_4c49,
        x,
        y,
        z,
        6_144.0,
        3,
    );
    let medium = spherical_fbm(
        parent_world_seed ^ 0x4c4f_4341_4c52_454c,
        x,
        y,
        z,
        16_384.0,
        3,
    );
    let fine = spherical_fbm(
        parent_world_seed ^ 0x5355_5246_4143_4521,
        x,
        y,
        z,
        49_152.0,
        2,
    );

    let relief = (context.slope_m_per_km / 450.0).clamp(0.0, 1.0);
    let geology = context.geology_boundary.clamp(0.0, 1.0);
    let resistance = (1.0 - context.erodibility.clamp(0.0, 1.0)) * 0.18;
    let coastal_damping = if context.parent_elevation_m.abs() < 24.0 {
        0.45
    } else {
        1.0
    };
    let process_amplitude = f64::from(
        (0.72 + relief * 0.26 + geology * 0.20 + resistance)
            * (0.62 + noise * 0.76)
            * coastal_damping,
    );
    let elevation_m = ((broad * 72.0 + medium * 34.0 + fine * 12.0) * process_amplitude)
        .clamp(-140.0, 140.0) as f32;
    let ridge = (1.0 - (medium * 3.1).abs()).clamp(0.0, 1.0) as f32;
    let roughness =
        ((medium.abs() * 1.8 + fine.abs() * 2.8) * process_amplitude).clamp(0.0, 1.0) as f32;

    // These values intentionally do not affect revision 2 yet. Keeping them
    // explicit prevents a later climate/erosion pass from breaking the stable
    // world-coordinate residual API.
    let _future_process_inputs = (
        context.temperature_c,
        context.precipitation_mm,
        context.aridity,
        context.cryosphere,
        context.coastal_distance_km,
        context.hydrology_context,
    );
    TerrainResidualSample {
        elevation_m,
        ridge,
        roughness,
    }
}

#[derive(Clone, Copy, Debug)]
pub struct ClimateFieldConfig {
    pub seed: u32,
    pub width_km: f32,
    pub height_km: f32,
    pub center_latitude_deg: f32,
    pub climate: KoppenClimate,
    pub reference_temperature_c: f32,
    pub reference_humidity_percent: f32,
    pub base_precipitation_mm: f32,
    pub base_wind_mps: f32,
    pub temperature_correction_c: f32,
    pub humidity_correction_points: f32,
    pub persistence: f32,
    pub extreme_frequency: f32,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct ClimateFieldSample {
    pub temperature_c: f32,
    pub precipitation_mm: f32,
    pub potential_evapotranspiration_mm: f32,
    pub aridity_index: f32,
    pub soil_moisture: f32,
    pub relative_humidity_percent: f32,
    pub wind_mps: f32,
    pub hydrologic_saturation: f32,
}

impl GeologicGuideMesh {
    pub fn generate(seed: u32, width_km: f32, height_km: f32) -> Self {
        let width_km = width_km.max(0.1);
        let height_km = height_km.max(0.1);
        let area = width_km * height_km;
        let target = ((area.sqrt() / 170.0).round() as usize + 8).clamp(8, 18);
        let mut positions = Vec::<(f32, f32)>::with_capacity(target);
        positions.push((
            unit_hash(seed ^ 0x243f_6a88, 0) as f32 * width_km,
            unit_hash(seed ^ 0x85a3_08d3, 1) as f32 * height_km,
        ));
        while positions.len() < target {
            let serial = positions.len() as u32;
            let mut best = (0.0_f32, 0.0_f32, -1.0_f32);
            for candidate in 0..64_u32 {
                let key = serial.wrapping_mul(67).wrapping_add(candidate);
                let x = unit_hash(seed ^ 0x1319_8a2e, key) as f32 * width_km;
                let y = unit_hash(seed ^ 0x0370_7344, key) as f32 * height_km;
                let nearest = positions
                    .iter()
                    .map(|&(px, py)| normalized_distance(x, y, px, py, width_km, height_km))
                    .fold(f32::INFINITY, f32::min);
                if nearest > best.2 {
                    best = (x, y, nearest);
                }
            }
            positions.push((best.0, best.1));
        }

        let mut sites = positions
            .iter()
            .enumerate()
            .map(|(index, &(x, y))| {
                let angle = unit_hash(seed ^ 0xa409_3822, index as u32) * TAU;
                let speed = 0.25 + unit_hash(seed ^ 0x299f_31d0, index as u32) * 0.75;
                GeologicSite {
                    x_km: x,
                    y_km: y,
                    velocity_x: (angle.cos() * speed) as f32,
                    velocity_y: (angle.sin() * speed) as f32,
                    crust: if unit_hash(seed ^ 0x082e_fa98, index as u32) < 0.22 {
                        CrustKind::Oceanic
                    } else {
                        CrustKind::Continental
                    },
                    age: unit_hash(seed ^ 0xec4e_6c89, index as u32) as f32,
                    resistance: (0.28 + unit_hash(seed ^ 0x4528_21e6, index as u32) as f32 * 0.72),
                    hotspot: unit_hash(seed ^ 0x38d0_1377, index as u32) as f32,
                    neighbors: Vec::new(),
                }
            })
            .collect::<Vec<_>>();
        for index in 0..sites.len() {
            let mut nearest = (0..sites.len())
                .filter(|candidate| *candidate != index)
                .map(|candidate| {
                    (
                        candidate,
                        normalized_distance(
                            sites[index].x_km,
                            sites[index].y_km,
                            sites[candidate].x_km,
                            sites[candidate].y_km,
                            width_km,
                            height_km,
                        ),
                    )
                })
                .collect::<Vec<_>>();
            nearest.sort_by(|left, right| left.1.total_cmp(&right.1));
            sites[index].neighbors = nearest
                .into_iter()
                .take(3)
                .map(|(neighbor, _)| neighbor as u16)
                .collect();
        }
        Self {
            revision: 2,
            seed,
            width_km,
            height_km,
            sites,
        }
    }

    pub fn sample(&self, x_km: f32, y_km: f32) -> GeologySample {
        self.sample_with_terms(x_km, y_km, GeologyTermMask::ALL)
    }

    pub(crate) fn sample_with_terms(
        &self,
        x_km: f32,
        y_km: f32,
        terms: GeologyTermMask,
    ) -> GeologySample {
        if self.revision <= 1 {
            self.sample_legacy_with_terms(x_km, y_km, terms)
        } else {
            self.sample_continuous_with_terms(x_km, y_km, terms)
        }
    }

    pub(crate) fn sample_legacy_with_terms(
        &self,
        x_km: f32,
        y_km: f32,
        terms: GeologyTermMask,
    ) -> GeologySample {
        if self.sites.len() < 2 {
            return safe_geology_default(terms);
        }
        let mut nearest = self
            .sites
            .iter()
            .enumerate()
            .map(|(index, site)| {
                (
                    index,
                    normalized_distance(
                        x_km,
                        y_km,
                        site.x_km,
                        site.y_km,
                        self.width_km,
                        self.height_km,
                    ),
                )
            })
            .collect::<Vec<_>>();
        nearest.sort_by(|left, right| left.1.total_cmp(&right.1));
        let (first_index, first_distance) = nearest[0];
        let (second_index, second_distance) = nearest[1];
        let first = &self.sites[first_index];
        let second = &self.sites[second_index];
        let dx = (second.x_km - first.x_km) / self.width_km.max(0.1);
        let dy = (second.y_km - first.y_km) / self.height_km.max(0.1);
        let length = dx.hypot(dy).max(0.000_1);
        let nx = dx / length;
        let ny = dy / length;
        let relative_x = second.velocity_x - first.velocity_x;
        let relative_y = second.velocity_y - first.velocity_y;
        let normal_motion = relative_x * nx + relative_y * ny;
        let tangent_motion = relative_x * -ny + relative_y * nx;
        let boundary_distance = (second_distance - first_distance).abs();
        let boundary = (-(boundary_distance * boundary_distance) / 0.0018).exp();
        let irregular = isotropic_fbm(
            self.seed ^ 0xbe54_66cf,
            x_km as f64,
            y_km as f64,
            self.width_km.max(self.height_km) as f64 * 0.09,
            3,
        ) as f32;
        let boundary = (boundary * (0.72 + irregular * 0.42)).clamp(0.0, 1.0);
        let convergence = if terms.motion {
            (-normal_motion).max(0.0) * boundary
        } else {
            0.0
        };
        let divergence = if terms.motion {
            normal_motion.max(0.0) * boundary
        } else {
            0.0
        };
        let transform = if terms.motion {
            tangent_motion.abs() * boundary
        } else {
            0.0
        };
        let hotspot_radius = (self.width_km.min(self.height_km) * 0.12).max(6.0);
        let hotspot_distance = ((x_km - first.x_km).powi(2) + (y_km - first.y_km).powi(2)).sqrt();
        let hotspot = if terms.hotspot {
            first.hotspot.powi(5) * (-(hotspot_distance / hotspot_radius).powi(2)).exp()
        } else {
            0.0
        };
        GeologySample {
            uplift: (convergence * 0.88 + transform * 0.18 + hotspot * 0.55).clamp(0.0, 1.0),
            rift: (divergence * 0.82).clamp(0.0, 1.0),
            transform: transform.clamp(0.0, 1.0),
            hotspot: hotspot.clamp(0.0, 1.0),
            rock_resistance: if terms.resistance_age {
                (first.resistance + second.resistance) * 0.5
            } else {
                0.5
            },
            feature_age: if terms.resistance_age {
                (first.age + second.age) * 0.5
            } else {
                0.5
            },
        }
    }

    pub(crate) fn sample_continuous_with_terms(
        &self,
        x_km: f32,
        y_km: f32,
        terms: GeologyTermMask,
    ) -> GeologySample {
        if self.sites.is_empty()
            || !x_km.is_finite()
            || !y_km.is_finite()
            || !self.width_km.is_finite()
            || !self.height_km.is_finite()
        {
            return safe_geology_default(terms);
        }

        // A normalized Gaussian partition of unity keeps both the physical
        // values and their first spatial derivatives continuous. Guide cells
        // remain useful topology, but no ownership boundary becomes terrain.
        let sigma = (0.78 / (self.sites.len() as f64).sqrt()).clamp(0.12, 0.32);
        let sigma_sq = sigma * sigma;
        let width = f64::from(self.width_km.max(0.1));
        let height = f64::from(self.height_km.max(0.1));
        let px = f64::from(x_km) / width;
        let py = f64::from(y_km) / height;
        let mut raw = Vec::with_capacity(self.sites.len());
        let mut total = 0.0_f64;
        for site in &self.sites {
            if !site.x_km.is_finite()
                || !site.y_km.is_finite()
                || !site.velocity_x.is_finite()
                || !site.velocity_y.is_finite()
            {
                continue;
            }
            let dx = f64::from(site.x_km) / width - px;
            let dy = f64::from(site.y_km) / height - py;
            let weight = (-0.5 * (dx * dx + dy * dy) / sigma_sq).exp();
            if weight.is_finite() {
                raw.push((site, dx, dy, weight));
                total += weight;
            }
        }
        if raw.is_empty() || !total.is_finite() || total <= f64::EPSILON {
            return safe_geology_default(terms);
        }

        let mut resistance = 0.0_f64;
        let mut age = 0.0_f64;
        let mut mean_gx = 0.0_f64;
        let mut mean_gy = 0.0_f64;
        for (site, dx, dy, weight) in &raw {
            let normalized = *weight / total;
            resistance += normalized * f64::from(site.resistance);
            age += normalized * f64::from(site.age);
            mean_gx += normalized * *dx / sigma_sq;
            mean_gy += normalized * *dy / sigma_sq;
        }

        let mut dvx_dx = 0.0_f64;
        let mut dvx_dy = 0.0_f64;
        let mut dvy_dx = 0.0_f64;
        let mut dvy_dy = 0.0_f64;
        let mut hotspot = 0.0_f64;
        let hotspot_radius = f64::from((self.width_km.min(self.height_km) * 0.12).max(6.0));
        for (site, dx, dy, weight) in raw {
            let normalized = weight / total;
            let dw_dx = normalized * (dx / sigma_sq - mean_gx);
            let dw_dy = normalized * (dy / sigma_sq - mean_gy);
            dvx_dx += dw_dx * f64::from(site.velocity_x);
            dvx_dy += dw_dy * f64::from(site.velocity_x);
            dvy_dx += dw_dx * f64::from(site.velocity_y);
            dvy_dy += dw_dy * f64::from(site.velocity_y);
            if terms.hotspot {
                let distance_km = ((f64::from(x_km - site.x_km)).powi(2)
                    + (f64::from(y_km - site.y_km)).powi(2))
                .sqrt();
                hotspot += f64::from(site.hotspot).powi(5)
                    * (-(distance_km / hotspot_radius).powi(2)).exp();
            }
        }

        let deformation_scale = sigma * 0.72;
        let divergence = (dvx_dx + dvy_dy) * deformation_scale;
        let shear = 0.5 * (dvx_dy + dvy_dx) * deformation_scale;
        let vorticity = 0.5 * (dvy_dx - dvx_dy) * deformation_scale;
        let irregular = isotropic_fbm(
            self.seed ^ 0xbe54_66cf,
            x_km as f64,
            y_km as f64,
            self.width_km.max(self.height_km) as f64 * 0.09,
            3,
        );
        let modulation = 0.78 + irregular * 0.34;
        let convergence = if terms.motion {
            (-divergence).max(0.0) * modulation
        } else {
            0.0
        };
        let extension = if terms.motion {
            divergence.max(0.0) * modulation
        } else {
            0.0
        };
        let transform = if terms.motion {
            (shear.abs() * 0.78 + vorticity.abs() * 0.22) * modulation
        } else {
            0.0
        };
        let hotspot = hotspot.clamp(0.0, 1.0);
        GeologySample {
            uplift: (convergence * 0.88 + transform * 0.18 + hotspot * 0.55).clamp(0.0, 1.0) as f32,
            rift: (extension * 0.82).clamp(0.0, 1.0) as f32,
            transform: transform.clamp(0.0, 1.0) as f32,
            hotspot: hotspot as f32,
            rock_resistance: if terms.resistance_age {
                resistance.clamp(0.0, 1.0) as f32
            } else {
                0.5
            },
            feature_age: if terms.resistance_age {
                age.clamp(0.0, 1.0) as f32
            } else {
                0.5
            },
        }
    }
}

fn safe_geology_default(_terms: GeologyTermMask) -> GeologySample {
    GeologySample {
        rock_resistance: 0.5,
        feature_age: 0.5,
        ..GeologySample::default()
    }
}

pub fn sample_terrain_field(
    config: TerrainFieldConfig,
    guide: Option<&GeologicGuideMesh>,
    x_km: f32,
    y_km: f32,
) -> TerrainFieldSample {
    sample_terrain_field_with_terms(config, guide, x_km, y_km, GeologyTermMask::ALL)
}

pub(crate) fn sample_terrain_field_with_terms(
    config: TerrainFieldConfig,
    guide: Option<&GeologicGuideMesh>,
    x_km: f32,
    y_km: f32,
    terms: GeologyTermMask,
) -> TerrainFieldSample {
    let width = config.width_km.max(0.1);
    let height = config.height_km.max(0.1);
    let longest = width.max(height);
    let macro_wave = (longest * 0.42).clamp(9.0, 920.0) as f64;
    let regional_wave = (longest * 0.13).clamp(2.4, 240.0) as f64;
    let warp_wave = (longest * 0.24).clamp(5.0, 520.0) as f64;
    let warp_amplitude = (longest * 0.045).clamp(0.8, 110.0);
    let warp_x = (isotropic_fbm(
        config.seed ^ 0x52dc_e729,
        x_km as f64,
        y_km as f64,
        warp_wave,
        4,
    ) - 0.5)
        * warp_amplitude as f64;
    let warp_y = (isotropic_fbm(
        config.seed ^ 0x6a09_e667,
        x_km as f64 + 913.0,
        y_km as f64 - 617.0,
        warp_wave,
        4,
    ) - 0.5)
        * warp_amplitude as f64;
    let wx = x_km as f64 + warp_x;
    let wy = y_km as f64 + warp_y;
    let macro_noise = isotropic_fbm(config.seed, wx, wy, macro_wave, 5);
    let regional = isotropic_fbm(config.seed ^ 0xc2b2_ae35, wx, wy, regional_wave, 4);
    let coastal = isotropic_fbm(
        config.seed ^ 0x510e_527f,
        wx,
        wy,
        (regional_wave * 0.38).max(0.9),
        3,
    );
    let nx = wx / width as f64 - 0.5;
    let ny = wy / height as f64 - 0.5;
    let size_complexity = ((longest.log10() - 0.7) / 2.9).clamp(0.0, 1.0) as f64;
    let land_signal = match config.region_type {
        RegionType::Inland => 0.72 + (macro_noise - 0.5) * 0.20,
        RegionType::Coast => {
            0.56 - (ny + 0.5)
                + (macro_noise - 0.5) * (0.62 + size_complexity * 0.18)
                + (regional - 0.5) * (0.16 + size_complexity * 0.18)
                + (coastal - 0.5) * size_complexity * 0.10
        }
        RegionType::Island => {
            0.66 - (nx * nx * 0.92 + ny * ny * 1.42).sqrt()
                + (macro_noise - 0.5) * (0.48 + size_complexity * 0.12)
                + (regional - 0.5) * (0.16 + size_complexity * 0.14)
                + (coastal - 0.5) * size_complexity * 0.08
        }
    } as f32;
    let ocean = config.region_type != RegionType::Inland && land_signal <= 0.0;
    let geology = guide.map_or_else(
        || GeologySample {
            rock_resistance: 0.5,
            feature_age: 0.5,
            ..GeologySample::default()
        },
        |value| value.sample_with_terms(x_km, y_km, terms),
    );
    let ridge_noise = isotropic_fbm(
        config.seed ^ 0x85eb_ca6b,
        wx + 181.0,
        wy - 233.0,
        (regional_wave * 0.55).max(1.2),
        5,
    );
    let ridge = (1.0 - (ridge_noise * 2.0 - 1.0).abs()).powf(1.62) as f32;
    let broad = isotropic_fbm(
        config.seed ^ 0x9e37_79b9,
        wx - 509.0,
        wy + 337.0,
        (macro_wave * 0.48).max(4.0),
        4,
    ) as f32;
    let local = isotropic_fbm(config.seed ^ 0x1656_67b1, wx, wy, 11.5, 4) as f32;
    let fine = isotropic_fbm(config.seed ^ 0xd3a2_646c, wx, wy, 1.7, 3) as f32;
    let basin_noise = isotropic_fbm(config.seed ^ 0x3c6e_f372, wx, wy, 7.5, 3) as f32;
    let noise = config.elevation_noise.clamp(0.0, 1.0);
    let normalized_relief = (broad * (0.70 - noise * 0.20)
        + ridge * (0.14 + noise * 0.30)
        + geology.uplift * (0.12 + noise * 0.18)
        + geology.hotspot * 0.055
        + (geology.rock_resistance - 0.5) * geology.uplift * 0.09
        - geology.rift * 0.12
        - geology.feature_age * geology.uplift * 0.035
        + local * (0.04 + noise * 0.08)
        + (fine - 0.5) * noise * 0.035)
        .clamp(0.0, 1.0);
    let minimum_land = (config.maximum_elevation_m - config.elevation_span_m).max(1.0);
    let land_ramp = (land_signal * 3.2).clamp(0.035, 1.0);
    let elevation_m = if ocean {
        (land_signal * config.elevation_span_m.max(180.0) * 0.20).min(-1.0)
    } else {
        let inland_target = minimum_land
            + normalized_relief * (config.maximum_elevation_m - minimum_land) * land_ramp.sqrt();
        if config.region_type == RegionType::Inland {
            inland_target.clamp(1.0, config.maximum_elevation_m)
        } else {
            // Ordinary coasts rise from sea level over a broad cross-shore
            // profile. Only young, strongly uplifted ridges can retain a
            // cliff-like profile at the waterline.
            let t = (land_signal / 0.22).clamp(0.0, 1.0);
            let gradual = t * t * (3.0 - 2.0 * t);
            let cliff = ((geology.uplift - 0.78) / 0.22).clamp(0.0, 1.0)
                * ((ridge - 0.72) / 0.28).clamp(0.0, 1.0)
                * (1.0 - geology.feature_age).clamp(0.0, 1.0);
            let coastal_rise = gradual * (1.0 - cliff) + t.sqrt() * cliff;
            (1.0 + (inland_target - 1.0) * coastal_rise).clamp(1.0, config.maximum_elevation_m)
        }
    };
    TerrainFieldSample {
        elevation_m,
        land_signal,
        ocean,
        ridge,
        roughness: ((ridge * 0.46
            + local * 0.22
            + geology.uplift * 0.24
            + geology.transform * 0.08
            + geology.hotspot * 0.06
            + geology.rock_resistance * 0.04)
            * land_ramp)
            .clamp(0.0, 1.0),
        basin: ((1.0 - basin_noise) * 0.62 + geology.rift * 0.38).clamp(0.0, 1.0),
        warp_x_km: warp_x as f32,
        warp_y_km: warp_y as f32,
    }
}

pub fn sample_climate_field(
    config: ClimateFieldConfig,
    x_km: f32,
    y_km: f32,
    elevation_m: f32,
    coast_influence: f32,
    terrain_basin: f32,
    freshwater_influence: f32,
    flow_influence: f32,
) -> ClimateFieldSample {
    let width = config.width_km.max(0.1);
    let height = config.height_km.max(0.1);
    let latitude_span = (height / 111.0).min(170.0);
    let latitude =
        (config.center_latitude_deg + (0.5 - y_km / height) * latitude_span).clamp(-89.0, 89.0);
    let longest = width.max(height);
    let persistence = config.persistence.clamp(0.0, 1.0);
    let broad = isotropic_fbm(
        config.seed ^ 0x94d0_49bb,
        x_km as f64,
        y_km as f64,
        (longest * 0.20).clamp(5.0, 360.0) as f64,
        4,
    ) as f32;
    let rain_noise = isotropic_fbm(
        config.seed ^ 0x27d4_eb2d,
        x_km as f64 + 13.0,
        y_km as f64 - 31.0,
        (longest * 0.075).clamp(2.0, 140.0) as f64,
        4,
    ) as f32;
    // Extreme-weather regions must be spatially coherent without leaking the
    // old 18 km square hash cells into climate-driven terrain boundaries.
    let storm = isotropic_fbm(
        config.seed ^ 0x510e_527f,
        x_km as f64 + 73.0,
        y_km as f64 - 109.0,
        (longest * 0.055).clamp(9.0, 96.0) as f64,
        3,
    ) as f32;
    let frequency = config.extreme_frequency.clamp(0.0, 1.0);
    let storm_edge = ((frequency - storm) / 0.16 + 0.5).clamp(0.0, 1.0);
    let storm_intensity = storm_edge * storm_edge * (3.0 - 2.0 * storm_edge);
    let extreme = 1.0 + storm_intensity * 0.45;
    let climate_variation = (broad - 0.5) * (1.0 - persistence) * 10.0;
    let temperature = config.reference_temperature_c + config.temperature_correction_c
        - (latitude.abs() - config.center_latitude_deg.abs()) * 0.38
        - elevation_m.max(0.0) / 1_000.0 * 6.2
        + coast_influence.clamp(0.0, 1.0) * 1.6
        + climate_variation;
    let rain_factor = (0.36
        + rain_noise * 0.86
        + coast_influence.clamp(0.0, 1.0) * 0.16
        + flow_influence.clamp(0.0, 1.0) * 0.05)
        .clamp(0.08, 1.48);
    let precipitation = (config.base_precipitation_mm * rain_factor * extreme).max(0.0);
    let wind = config.base_wind_mps
        * (0.78
            + isotropic_fbm(config.seed ^ 0xd3a2_646c, x_km as f64, y_km as f64, 24.0, 3) as f32
                * 0.44);
    let climate_evaporation = match config.climate {
        KoppenClimate::BWh => 1.24,
        KoppenClimate::BSh | KoppenClimate::Csa => 1.10,
        KoppenClimate::Af | KoppenClimate::Am => 0.86,
        KoppenClimate::ET | KoppenClimate::EF => 0.42,
        _ => 1.0,
    };
    let potential_et = ((temperature + 8.0).max(0.0)
        * (18.0 + wind * 0.9)
        * (1.04 - coast_influence.clamp(0.0, 1.0) * 0.08)
        * climate_evaporation)
        .max(35.0);
    let aridity_index = precipitation / potential_et.max(1.0);
    let water_balance = precipitation / (precipitation + potential_et).max(1.0);
    let saturation_cause = (freshwater_influence.clamp(0.0, 1.0) * 0.58
        + flow_influence.clamp(0.0, 1.0) * 0.25
        + terrain_basin.clamp(0.0, 1.0) * 0.17)
        .clamp(0.0, 1.0);
    let humidity_reference =
        ((config.reference_humidity_percent + config.humidity_correction_points) / 100.0)
            .clamp(0.0, 1.0);
    let soil_moisture =
        (water_balance * 0.68 + humidity_reference * 0.16 + saturation_cause * 0.22)
            .clamp(0.0, 1.0);
    let relative_humidity = (config.reference_humidity_percent
        + config.humidity_correction_points
        + (soil_moisture - 0.35) * 36.0
        + coast_influence * 8.0)
        .clamp(0.0, 100.0);
    ClimateFieldSample {
        temperature_c: temperature,
        precipitation_mm: precipitation,
        potential_evapotranspiration_mm: potential_et,
        aridity_index,
        soil_moisture,
        relative_humidity_percent: relative_humidity,
        wind_mps: wind,
        hydrologic_saturation: saturation_cause,
    }
}

pub fn terrain_climate_bias(climate: KoppenClimate, terrain: &str) -> f32 {
    match (climate, terrain) {
        (KoppenClimate::BWh, "desert") => 0.42,
        (KoppenClimate::BWh, "rock") => 0.18,
        (KoppenClimate::BWh, "plain") => -0.08,
        (KoppenClimate::BWh, "wetland" | "forest" | "jungle" | "farmland") => -0.45,
        (KoppenClimate::BSh, "desert") => 0.16,
        (KoppenClimate::BSh, "grassland") => 0.20,
        (KoppenClimate::Af | KoppenClimate::Am, "forest" | "jungle") => 0.22,
        (KoppenClimate::ET | KoppenClimate::EF, "snow") => 0.30,
        _ => 0.0,
    }
}

pub fn isotropic_fbm(seed: u32, x: f64, y: f64, wavelength: f64, octaves: usize) -> f64 {
    let wavelength = wavelength.max(0.2);
    let mut frequency = 1.0 / wavelength;
    let mut amplitude = 1.0;
    let mut total = 0.0;
    let mut weight = 0.0;
    for octave in 0..octaves.max(1) {
        let angle = 0.618_033_988_75 * octave as f64 + 0.173_205_080_75;
        let cosine = angle.cos();
        let sine = angle.sin();
        let rx = x * cosine - y * sine;
        let ry = x * sine + y * cosine;
        let value = gradient_noise(
            seed ^ (octave as u32).wrapping_mul(0x9e37_79b9),
            rx * frequency,
            ry * frequency,
        );
        total += value * amplitude;
        weight += amplitude;
        amplitude *= 0.51;
        frequency *= 2.03;
    }
    (total / weight.max(f64::EPSILON) * 0.5 + 0.5).clamp(0.0, 1.0)
}

fn gradient_noise(seed: u32, x: f64, y: f64) -> f64 {
    let x0 = x.floor() as i32;
    let y0 = y.floor() as i32;
    let tx = x - x0 as f64;
    let ty = y - y0 as f64;
    let fade = |value: f64| value * value * value * (value * (value * 6.0 - 15.0) + 10.0);
    let dot = |ix: i32, iy: i32| {
        let hash = mix(seed
            ^ (ix as u32).wrapping_mul(0x1f12_3bb5)
            ^ (iy as u32).wrapping_mul(0x5f35_6495));
        let angle = hash as f64 / u32::MAX as f64 * TAU;
        let dx = x - ix as f64;
        let dy = y - iy as f64;
        angle.cos() * dx + angle.sin() * dy
    };
    let top = lerp(dot(x0, y0), dot(x0 + 1, y0), fade(tx));
    let bottom = lerp(dot(x0, y0 + 1), dot(x0 + 1, y0 + 1), fade(tx));
    (lerp(top, bottom, fade(ty)) * 0.707_106_781_18).clamp(-1.0, 1.0)
}

fn normalized_distance(x: f32, y: f32, other_x: f32, other_y: f32, width: f32, height: f32) -> f32 {
    ((x - other_x) / width.max(0.1)).hypot((y - other_y) / height.max(0.1))
}

fn unit_hash(seed: u32, value: u32) -> f64 {
    mix(seed ^ value.wrapping_mul(0x9e37_79b9)) as f64 / u32::MAX as f64
}

fn mix(mut value: u32) -> u32 {
    value ^= value >> 16;
    value = value.wrapping_mul(0x7feb_352d);
    value ^= value >> 15;
    value = value.wrapping_mul(0x846c_a68b);
    value ^ (value >> 16)
}

fn lerp(left: f64, right: f64, t: f64) -> f64 {
    left + (right - left) * t
}

#[cfg(test)]
mod tests {
    use super::*;

    fn diamond_square_reference(seed: u32, size: usize, roughness: f32) -> Vec<f32> {
        assert!(size >= 3 && (size - 1).is_power_of_two());
        let mut field = vec![0.0_f32; size * size];
        let last = size - 1;
        for (serial, index) in [0, last, last * size, last * size + last]
            .into_iter()
            .enumerate()
        {
            field[index] = unit_hash(seed, serial as u32) as f32;
        }
        let mut step = last;
        let mut amplitude = roughness;
        let mut serial = 4_u32;
        while step > 1 {
            let half = step / 2;
            for y in (half..last).step_by(step) {
                for x in (half..last).step_by(step) {
                    let average = (field[(y - half) * size + x - half]
                        + field[(y - half) * size + x + half]
                        + field[(y + half) * size + x - half]
                        + field[(y + half) * size + x + half])
                        * 0.25;
                    field[y * size + x] =
                        average + (unit_hash(seed ^ 0xd1a4_5a7e, serial) as f32 - 0.5) * amplitude;
                    serial = serial.wrapping_add(1);
                }
            }
            for y in (0..size).step_by(half) {
                let offset = if (y / half).is_multiple_of(2) {
                    half
                } else {
                    0
                };
                for x in (offset..size).step_by(step) {
                    let mut sum = 0.0;
                    let mut count = 0.0;
                    for (dx, dy) in [
                        (-(half as isize), 0),
                        (half as isize, 0),
                        (0, -(half as isize)),
                        (0, half as isize),
                    ] {
                        let nx = x as isize + dx;
                        let ny = y as isize + dy;
                        if nx >= 0 && ny >= 0 && nx < size as isize && ny < size as isize {
                            sum += field[ny as usize * size + nx as usize];
                            count += 1.0;
                        }
                    }
                    field[y * size + x] = sum / count
                        + (unit_hash(seed ^ 0x5a82_7999, serial) as f32 - 0.5) * amplitude;
                    serial = serial.wrapping_add(1);
                }
            }
            step = half;
            amplitude *= 0.52;
        }
        field
    }

    fn terrain_config(region_type: RegionType) -> TerrainFieldConfig {
        TerrainFieldConfig {
            seed: 990_500_051,
            width_km: 500.0,
            height_km: 313.0,
            region_type,
            maximum_elevation_m: 4_800.0,
            elevation_span_m: 5_600.0,
            elevation_noise: 0.62,
        }
    }

    #[test]
    fn physical_fields_are_deterministic_and_chunk_independent() {
        let config = terrain_config(RegionType::Coast);
        let guide = GeologicGuideMesh::generate(config.seed, config.width_km, config.height_km);
        let first = sample_terrain_field(config, Some(&guide), 128.35, 72.95);
        let second = sample_terrain_field(config, Some(&guide), 128.35, 72.95);
        assert_eq!(first.elevation_m, second.elevation_m);
        assert_eq!(first.land_signal, second.land_signal);
        assert_eq!(first.warp_x_km, second.warp_x_km);
    }

    #[test]
    fn hot_desert_uses_absolute_aridity_instead_of_preset_relative_rain() {
        let baseline = KoppenClimate::BWh.baseline();
        let sample = sample_climate_field(
            ClimateFieldConfig {
                seed: 7,
                width_km: 100.0,
                height_km: 80.0,
                center_latitude_deg: 24.0,
                climate: KoppenClimate::BWh,
                reference_temperature_c: baseline.temperature_c as f32,
                reference_humidity_percent: baseline.humidity_percent as f32,
                base_precipitation_mm: baseline.precipitation_mm as f32,
                base_wind_mps: baseline.wind_mps as f32,
                temperature_correction_c: 0.0,
                humidity_correction_points: 0.0,
                persistence: 0.7,
                extreme_frequency: 0.0,
            },
            50.0,
            40.0,
            120.0,
            0.0,
            0.2,
            0.0,
            0.0,
        );
        assert!(sample.precipitation_mm < 260.0, "{sample:?}");
        assert!(sample.aridity_index < 0.35, "{sample:?}");
        assert!(sample.soil_moisture < 0.30, "{sample:?}");
    }

    #[test]
    fn climate_extremes_are_continuous_across_former_square_cell_edges() {
        let baseline = KoppenClimate::Cfb.baseline();
        let config = ClimateFieldConfig {
            seed: 41,
            width_km: 180.0,
            height_km: 120.0,
            center_latitude_deg: 37.5,
            climate: KoppenClimate::Cfb,
            reference_temperature_c: baseline.temperature_c as f32,
            reference_humidity_percent: baseline.humidity_percent as f32,
            base_precipitation_mm: baseline.precipitation_mm as f32,
            base_wind_mps: baseline.wind_mps as f32,
            temperature_correction_c: 0.0,
            humidity_correction_points: 0.0,
            persistence: 0.65,
            extreme_frequency: 0.5,
        };
        let left = sample_climate_field(config, 17.999, 54.0, 120.0, 0.2, 0.2, 0.0, 0.0);
        let right = sample_climate_field(config, 18.001, 54.0, 120.0, 0.2, 0.2, 0.0, 0.0);
        assert!((left.precipitation_mm - right.precipitation_mm).abs() < 0.25);
        assert!((left.temperature_c - right.temperature_c).abs() < 0.02);
    }

    #[test]
    fn ordinary_coast_samples_begin_with_a_gradual_elevation_profile() {
        let config = terrain_config(RegionType::Coast);
        let guide = GeologicGuideMesh::generate(config.seed, config.width_km, config.height_km);
        let mut first_land = Vec::new();
        for column in 0..24 {
            let x = (column as f32 + 0.5) / 24.0 * config.width_km;
            let mut previous = sample_terrain_field(config, Some(&guide), x, 0.0);
            for step in 1..640 {
                let y = step as f32 / 639.0 * config.height_km;
                let sample = sample_terrain_field(config, Some(&guide), x, y);
                if previous.ocean != sample.ocean {
                    first_land.push(if sample.ocean {
                        previous.elevation_m
                    } else {
                        sample.elevation_m
                    });
                    break;
                }
                previous = sample;
            }
        }
        first_land.sort_by(f32::total_cmp);
        assert!(first_land.len() >= 8);
        let median = first_land[first_land.len() / 2];
        assert!(median < 350.0, "median first-land elevation was {median} m");
    }

    #[test]
    fn geologic_guide_has_stable_sparse_adjacency() {
        let first = GeologicGuideMesh::generate(42, 900.0, 400.0);
        let second = GeologicGuideMesh::generate(42, 900.0, 400.0);
        assert_eq!(first.sites.len(), second.sites.len());
        assert!((8..=18).contains(&first.sites.len()));
        assert!(first.sites.iter().all(|site| site.neighbors.len() == 3));
        assert_eq!(first.sites[0].x_km, second.sites[0].x_km);
    }

    fn geology_signature(sample: GeologySample) -> f32 {
        sample.uplift - sample.rift * 0.7
            + sample.transform * 0.2
            + sample.hotspot * 0.4
            + (sample.rock_resistance - 0.5) * 0.15
            - (sample.feature_age - 0.5) * 0.08
    }

    #[test]
    fn continuous_guide_has_no_hard_site_pair_boundary_jump() {
        let guide = GeologicGuideMesh::generate(990_500_051, 500.0, 312.5);
        let mut legacy_max = 0.0_f32;
        let mut continuous_max = 0.0_f32;
        let width = 240;
        let height = 150;
        for y in 0..height {
            let y_km = (y as f32 + 0.5) / height as f32 * guide.height_km;
            let mut previous_legacy: Option<f32> = None;
            let mut previous_continuous: Option<f32> = None;
            for x in 0..width {
                let x_km = (x as f32 + 0.5) / width as f32 * guide.width_km;
                let legacy = geology_signature(guide.sample_legacy_with_terms(
                    x_km,
                    y_km,
                    GeologyTermMask::ALL,
                ));
                let continuous = geology_signature(guide.sample_continuous_with_terms(
                    x_km,
                    y_km,
                    GeologyTermMask::ALL,
                ));
                if let Some(previous) = previous_legacy {
                    legacy_max = legacy_max.max((legacy - previous).abs());
                }
                if let Some(previous) = previous_continuous {
                    continuous_max = continuous_max.max((continuous - previous).abs());
                }
                previous_legacy = Some(legacy);
                previous_continuous = Some(continuous);
            }
        }
        assert!(legacy_max > 0.08, "legacy max jump was {legacy_max}");
        assert!(
            continuous_max < legacy_max * 0.55,
            "continuous {continuous_max}, legacy {legacy_max}"
        );
    }

    #[test]
    fn continuous_guide_preserves_geological_variance_and_determinism() {
        let guide = GeologicGuideMesh::generate(42, 900.0, 400.0);
        let values = (0..256)
            .map(|index| {
                let x = (index % 32) as f32 / 31.0 * guide.width_km;
                let y = (index / 32) as f32 / 7.0 * guide.height_km;
                let first = guide.sample_continuous_with_terms(x, y, GeologyTermMask::ALL);
                let second = guide.sample_continuous_with_terms(x, y, GeologyTermMask::ALL);
                assert_eq!(first.uplift, second.uplift);
                assert_eq!(first.rock_resistance, second.rock_resistance);
                geology_signature(first)
            })
            .collect::<Vec<_>>();
        let mean = values.iter().copied().sum::<f32>() / values.len() as f32;
        let variance = values
            .iter()
            .map(|value| (value - mean).powi(2))
            .sum::<f32>()
            / values.len() as f32;
        assert!(variance > 0.002, "guide variance was {variance}");
    }

    #[test]
    fn guide_sampling_is_chunk_boundary_continuous() {
        let guide = GeologicGuideMesh::generate(990_500_051, 500.0, 312.5);
        for x_km in [128.0_f32, 256.0, 384.0] {
            for y_km in [42.0_f32, 156.25, 271.0] {
                let left =
                    guide.sample_continuous_with_terms(x_km - 0.001, y_km, GeologyTermMask::ALL);
                let right =
                    guide.sample_continuous_with_terms(x_km + 0.001, y_km, GeologyTermMask::ALL);
                let delta = (geology_signature(left) - geology_signature(right)).abs();
                assert!(delta < 0.01, "guide seam at ({x_km}, {y_km}): {delta}");
            }
        }
    }

    #[test]
    fn parent_constrained_residual_is_position_deterministic() {
        let context = TerrainResidualContext {
            position: PlanetPosition::from_latitude_longitude_deg(37.5, 128.0),
            parent_elevation_m: 840.0,
            slope_m_per_km: 115.0,
            geology_boundary: 0.42,
            erodibility: 0.35,
            temperature_c: 11.0,
            precipitation_mm: 920.0,
            aridity: 0.7,
            cryosphere: 0.0,
            coastal_distance_km: 70.0,
            hydrology_context: 0.2,
        };
        let first = sample_parent_constrained_residual(91, context, 0.58);
        let second = sample_parent_constrained_residual(91, context, 0.58);
        let other = sample_parent_constrained_residual(92, context, 0.58);
        assert_eq!(first.elevation_m, second.elevation_m);
        assert_ne!(first.elevation_m, other.elevation_m);
        assert!(first.elevation_m.abs() <= 140.0);
    }

    #[test]
    fn diamond_square_remains_an_isolated_macro_reference() {
        let first = diamond_square_reference(41, 33, 0.8);
        let second = diamond_square_reference(41, 33, 0.8);
        assert_eq!(first, second);
        assert_eq!(first.len(), 33 * 33);
        assert!(first.iter().all(|value| value.is_finite()));
    }
}
