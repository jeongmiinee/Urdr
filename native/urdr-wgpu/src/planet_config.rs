use serde::{Deserialize, Serialize};

const GRAVITATIONAL_CONSTANT: f64 = 6.674_30e-11;
const STEFAN_BOLTZMANN_CONSTANT: f64 = 5.670_374_419e-8;
const EARTH_WATER_MASS_KG: f64 = 1.386e21;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PlanetPreset {
    EarthLike,
    Supercontinent,
    FragmentedContinents,
    Archipelago,
    YoungActive,
    AncientStable,
    Dry,
    Wet,
    WaterWorld,
    IceWorld,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GenerationQuality {
    Draft,
    Normal,
    High,
    Ultra,
}

impl Default for GenerationQuality {
    fn default() -> Self {
        Self::Normal
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BiosphereStrength {
    None,
    Primitive,
    Sparse,
    EarthLike,
    Dense,
}

impl Default for BiosphereStrength {
    fn default() -> Self {
        Self::EarthLike
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhysicalConfig {
    pub radius_m: f64,
    pub mass_kg: f64,
    pub rotation_period_hours: f64,
    pub axial_tilt_deg: f64,
    #[serde(default)]
    pub axial_azimuth_deg: f64,
    pub orbital_period_days: f64,
    pub stellar_flux_w_m2: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AtmosphereComposition {
    pub nitrogen: f64,
    pub oxygen: f64,
    pub carbon_dioxide: f64,
    pub methane: f64,
    pub other: f64,
}

impl AtmosphereComposition {
    pub fn total(&self) -> f64 {
        self.nitrogen + self.oxygen + self.carbon_dioxide + self.methane + self.other
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AtmosphereConfig {
    pub atmospheric_mass_kg: f64,
    pub composition: AtmosphereComposition,
    pub greenhouse_strength: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HydrosphereConfig {
    pub water_inventory_kg: f64,
    pub target_ocean_coverage: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TectonicConfig {
    pub plate_count: u8,
    pub activity: f64,
    pub continental_crust_fraction: f64,
    pub continental_fragmentation: f64,
    pub craton_stability: f64,
    pub orogenic_activity: f64,
    pub rift_activity: f64,
    pub volcanic_activity: f64,
}

impl Default for TectonicConfig {
    fn default() -> Self {
        Self {
            plate_count: 12,
            activity: 0.55,
            continental_crust_fraction: 0.43,
            continental_fragmentation: 0.55,
            craton_stability: 0.62,
            orogenic_activity: 0.58,
            rift_activity: 0.45,
            volcanic_activity: 0.48,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeologicalConfig {
    pub maturity: f64,
    pub lithological_diversity: f64,
}

impl Default for GeologicalConfig {
    fn default() -> Self {
        Self {
            maturity: 0.58,
            lithological_diversity: 0.65,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalSurfaceConfig {
    pub erosion_strength: f64,
    pub sediment_mobility: f64,
    pub moisture_bias: f64,
    pub cryosphere_tendency: f64,
}

impl Default for GlobalSurfaceConfig {
    fn default() -> Self {
        Self {
            erosion_strength: 0.62,
            sediment_mobility: 0.55,
            moisture_bias: 0.58,
            cryosphere_tendency: 0.24,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BiosphereConfig {
    pub strength: BiosphereStrength,
}

impl Default for BiosphereConfig {
    fn default() -> Self {
        Self {
            strength: BiosphereStrength::EarthLike,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanetGenerationConfig {
    pub schema_version: u16,
    pub generator_version: u32,
    pub calibration_version: u16,
    pub seed: u64,
    pub preset_source: Option<PlanetPreset>,
    pub physical: PhysicalConfig,
    pub atmosphere: AtmosphereConfig,
    pub hydrosphere: HydrosphereConfig,
    pub tectonics: TectonicConfig,
    pub geology: GeologicalConfig,
    pub surface: GlobalSurfaceConfig,
    pub biosphere: BiosphereConfig,
    pub quality: GenerationQuality,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PlanetDerivedSummary {
    pub surface_gravity_ms2: f64,
    pub mean_surface_pressure_pa: f64,
    pub mean_surface_temperature_c: f64,
    pub estimated_ocean_coverage: f64,
    pub generation_cost_units: u32,
}

impl Default for PlanetGenerationConfig {
    fn default() -> Self {
        Self {
            schema_version: 1,
            generator_version: 2,
            calibration_version: 1,
            seed: 990_500_051,
            preset_source: Some(PlanetPreset::EarthLike),
            physical: PhysicalConfig {
                radius_m: 6_371_000.0,
                mass_kg: 5.972_2e24,
                rotation_period_hours: 24.0,
                axial_tilt_deg: 23.4,
                axial_azimuth_deg: deterministic_axial_azimuth_deg(990_500_051, 2),
                orbital_period_days: 365.0,
                stellar_flux_w_m2: 1_361.0,
            },
            atmosphere: AtmosphereConfig {
                atmospheric_mass_kg: 5.148e18,
                composition: AtmosphereComposition {
                    nitrogen: 0.780_84,
                    oxygen: 0.209_46,
                    carbon_dioxide: 0.000_42,
                    methane: 0.000_002,
                    other: 0.009_278,
                },
                greenhouse_strength: 0.62,
            },
            hydrosphere: HydrosphereConfig {
                water_inventory_kg: EARTH_WATER_MASS_KG,
                target_ocean_coverage: Some(0.71),
            },
            tectonics: TectonicConfig::default(),
            geology: GeologicalConfig::default(),
            surface: GlobalSurfaceConfig::default(),
            biosphere: BiosphereConfig::default(),
            quality: GenerationQuality::Normal,
        }
    }
}

impl PlanetGenerationConfig {
    pub fn validate(&self) -> Result<Vec<String>, String> {
        let finite_positive = [
            ("planet radius", self.physical.radius_m),
            ("planet mass", self.physical.mass_kg),
            ("rotation period", self.physical.rotation_period_hours),
            ("orbital period", self.physical.orbital_period_days),
            ("stellar flux", self.physical.stellar_flux_w_m2),
            ("atmospheric mass", self.atmosphere.atmospheric_mass_kg),
        ];
        for (name, value) in finite_positive {
            if !value.is_finite() || value <= 0.0 {
                return Err(format!("{name} must be finite and positive"));
            }
        }
        if !self.hydrosphere.water_inventory_kg.is_finite()
            || self.hydrosphere.water_inventory_kg < 0.0
        {
            return Err("water inventory must be finite and non-negative".to_owned());
        }
        if !(0.0..=90.0).contains(&self.physical.axial_tilt_deg) {
            return Err("axial tilt must be between 0 and 90 degrees".to_owned());
        }
        if !self.physical.axial_azimuth_deg.is_finite()
            || !(0.0..360.0).contains(&self.physical.axial_azimuth_deg)
        {
            return Err("axial azimuth must be between 0 and 360 degrees".to_owned());
        }
        if !(6..=32).contains(&self.tectonics.plate_count) {
            return Err("major plate count must be between 6 and 32".to_owned());
        }
        for (name, value) in self.normalized_controls() {
            if !value.is_finite() || !(0.0..=1.0).contains(&value) {
                return Err(format!("{name} must be between 0 and 1"));
            }
        }
        let composition_total = self.atmosphere.composition.total();
        if !composition_total.is_finite() || (composition_total - 1.0).abs() > 0.001 {
            return Err("atmosphere composition fractions must sum to 1".to_owned());
        }
        if let Some(target) = self.hydrosphere.target_ocean_coverage
            && (!target.is_finite() || !(0.0..=1.0).contains(&target))
        {
            return Err("target ocean coverage must be between 0 and 1".to_owned());
        }

        let mut warnings = Vec::new();
        if let Some(target) = self.hydrosphere.target_ocean_coverage {
            let inventory_ratio = self.hydrosphere.water_inventory_kg / EARTH_WATER_MASS_KG;
            if target > 0.8 && inventory_ratio < 0.25 {
                warnings.push(
                    "Ocean target is high for the authoritative water inventory; water inventory wins."
                        .to_owned(),
                );
            }
        }
        Ok(warnings)
    }

    pub fn derived_summary(&self) -> PlanetDerivedSummary {
        let gravity =
            GRAVITATIONAL_CONSTANT * self.physical.mass_kg / self.physical.radius_m.powi(2);
        let area = 4.0 * std::f64::consts::PI * self.physical.radius_m.powi(2);
        let pressure = self.atmosphere.atmospheric_mass_kg * gravity / area;
        let equilibrium_k =
            (self.physical.stellar_flux_w_m2 * 0.7 / (4.0 * STEFAN_BOLTZMANN_CONSTANT)).powf(0.25);
        let greenhouse_delta_c = self.atmosphere.greenhouse_strength * 53.0;
        let mean_temperature_c = equilibrium_k - 273.15 + greenhouse_delta_c;
        let inventory_ratio = (self.hydrosphere.water_inventory_kg / EARTH_WATER_MASS_KG).max(0.0);
        let physical_coverage = 1.0 - (-1.24 * inventory_ratio).exp();
        let estimated_ocean_coverage = self
            .hydrosphere
            .target_ocean_coverage
            .map_or(physical_coverage, |target| {
                physical_coverage * 0.72 + target * 0.28
            })
            .clamp(0.0, 0.995);
        let quality_multiplier = match self.quality {
            GenerationQuality::Draft => 1,
            GenerationQuality::Normal => 2,
            GenerationQuality::High => 4,
            GenerationQuality::Ultra => 8,
        };
        PlanetDerivedSummary {
            surface_gravity_ms2: gravity,
            mean_surface_pressure_pa: pressure,
            mean_surface_temperature_c: mean_temperature_c,
            estimated_ocean_coverage,
            generation_cost_units: u32::from(self.tectonics.plate_count) * quality_multiplier,
        }
    }

    pub fn stable_subseed(&self, stage_key: &str) -> u64 {
        let mut hash = self.seed ^ 0xcbf2_9ce4_8422_2325;
        for byte in stage_key.bytes() {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
        hash
    }

    pub fn deterministic_axial_azimuth_deg(&self) -> f64 {
        deterministic_axial_azimuth_deg(self.seed, self.generator_version)
    }

    fn normalized_controls(&self) -> [(&'static str, f64); 17] {
        [
            ("greenhouse strength", self.atmosphere.greenhouse_strength),
            ("tectonic activity", self.tectonics.activity),
            (
                "continental crust fraction",
                self.tectonics.continental_crust_fraction,
            ),
            (
                "continental fragmentation",
                self.tectonics.continental_fragmentation,
            ),
            ("craton stability", self.tectonics.craton_stability),
            ("orogenic activity", self.tectonics.orogenic_activity),
            ("rift activity", self.tectonics.rift_activity),
            ("volcanic activity", self.tectonics.volcanic_activity),
            ("geological maturity", self.geology.maturity),
            (
                "lithological diversity",
                self.geology.lithological_diversity,
            ),
            ("erosion strength", self.surface.erosion_strength),
            ("sediment mobility", self.surface.sediment_mobility),
            ("moisture bias", self.surface.moisture_bias),
            ("cryosphere tendency", self.surface.cryosphere_tendency),
            ("nitrogen fraction", self.atmosphere.composition.nitrogen),
            ("oxygen fraction", self.atmosphere.composition.oxygen),
            (
                "other atmosphere fraction",
                self.atmosphere.composition.other,
            ),
        ]
    }
}

fn deterministic_axial_azimuth_deg(seed: u64, generator_version: u32) -> f64 {
    let mut hash = seed ^ u64::from(generator_version).rotate_left(17) ^ 0x726f_7461_7469_6f6e;
    for byte in b"rotation-axis-azimuth" {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    (hash as f64 / u64::MAX as f64 * 360.0).rem_euclid(360.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn earth_like_defaults_are_physically_coherent() {
        let config = PlanetGenerationConfig::default();
        assert!(config.validate().is_ok());
        let derived = config.derived_summary();
        assert!((derived.surface_gravity_ms2 - 9.82).abs() < 0.05);
        assert!((derived.mean_surface_pressure_pa - 99_000.0).abs() < 2_000.0);
        assert!((derived.mean_surface_temperature_c - 15.0).abs() < 3.0);
    }

    #[test]
    fn stage_subseeds_are_order_independent() {
        let config = PlanetGenerationConfig::default();
        assert_eq!(
            config.stable_subseed("geology"),
            config.stable_subseed("geology")
        );
        assert_ne!(
            config.stable_subseed("geology"),
            config.stable_subseed("climate")
        );
    }

    #[test]
    fn invalid_composition_is_rejected() {
        let mut config = PlanetGenerationConfig::default();
        config.atmosphere.composition.oxygen = 0.8;
        assert!(config.validate().is_err());
    }
}
