use crate::{
    generator::{KoppenClimate, MapGenerationSettings, MapSizeMode, RegionType},
    spatial::{
        DetailedRegion, PlanetDetailPatchRef, PlanetPosition, PlanetState, RegionDefinition,
        RegionDetailCoverage, RegionDetailLevel, RegionGenerationConfig, RegionProvenance,
        RegionSelection, regional_metric_position_rotated,
    },
};
use std::{fmt, time::Instant};

const MAX_REQUESTED_REGION_CELLS: u64 = 2_000_000_000;
const MAX_ESTIMATED_CPU_BYTES: u64 = 8 * 1024 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RegionPreflightRisk {
    Safe,
    Warning,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RegionPreflightReport {
    pub width_cells: u64,
    pub height_cells: u64,
    pub requested_cells: u64,
    pub analysis_cells: u64,
    pub estimated_cpu_peak_bytes: u64,
    pub estimated_gpu_peak_bytes: u64,
    pub estimated_temp_bytes: u64,
    pub risk: RegionPreflightRisk,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RegionGenerationError {
    InvalidSelection,
    InvalidConfiguration(String),
    ArithmeticOverflow(&'static str),
    CellBudgetExceeded { requested: u64, limit: u64 },
    MemoryBudgetExceeded { estimated: u64, limit: u64 },
}

impl fmt::Display for RegionGenerationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidSelection => formatter
                .write_str("The selected planetary region has no resolvable metric extent."),
            Self::InvalidConfiguration(message) => formatter.write_str(message),
            Self::ArithmeticOverflow(stage) => {
                write!(formatter, "Regional preflight arithmetic overflow: {stage}")
            }
            Self::CellBudgetExceeded { requested, limit } => write!(
                formatter,
                "Regional request contains {requested} cells, above the preflight limit of {limit}. Increase target resolution or reduce the selected area."
            ),
            Self::MemoryBudgetExceeded { estimated, limit } => write!(
                formatter,
                "Regional request is estimated to require {estimated} bytes, above the preflight limit of {limit}."
            ),
        }
    }
}

impl std::error::Error for RegionGenerationError {}

#[derive(Clone, Debug)]
pub struct RegionalRefinementPlan {
    pub region: RegionDefinition,
    pub detailed_region: DetailedRegion,
    pub settings: MapGenerationSettings,
    pub coverage: RegionDetailCoverage,
    pub preflight: RegionPreflightReport,
    pub timings: RegionRefinementTimings,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RegionRefinementTimings {
    pub validation_micros: u64,
    pub preflight_micros: u64,
    pub detail_coverage_micros: u64,
    pub provenance_micros: u64,
    pub inherited_settings_micros: u64,
    pub total_micros: u64,
}

pub struct RegionalRefinementPipeline;

impl RegionalRefinementPipeline {
    pub fn prepare(
        planet: &mut PlanetState,
        source_id: &str,
        name: &str,
        selection: RegionSelection,
        mut config: RegionGenerationConfig,
    ) -> Result<RegionalRefinementPlan, RegionGenerationError> {
        crate::diagnostics::mark_regional_refinement_call();
        let total_started = Instant::now();
        let Some((center, width_m, height_m, bearing_deg)) = selection.metric_bounds() else {
            return Err(RegionGenerationError::InvalidSelection);
        };
        let validation_started = Instant::now();
        config
            .validate(width_m, height_m)
            .map_err(RegionGenerationError::InvalidConfiguration)?;
        if config.detail_level != RegionDetailLevel::Custom {
            config.apply_detail_preset();
        }
        let validation_micros = validation_started.elapsed().as_micros() as u64;
        let preflight_started = Instant::now();
        let preflight = region_preflight(width_m, height_m, &config)?;
        let preflight_micros = preflight_started.elapsed().as_micros() as u64;
        let detail_coverage_started = Instant::now();
        let coverage = planet.ensure_region_detail_coverage(&selection, &config);
        let detail_coverage_micros = detail_coverage_started.elapsed().as_micros() as u64;
        let provenance_started = Instant::now();
        let selection_checksum = selection.stable_checksum();
        let parent_patch_checksums = coverage
            .patch_refs
            .iter()
            .map(|patch| patch.checksum)
            .collect::<Vec<_>>();
        let provenance = RegionProvenance {
            source_planet_id: planet.id.clone(),
            source_planet_revision: planet.revisions.surface,
            generator_version: planet.generator_version,
            selection_checksum,
            target_resolution_m: config.target_resolution_m,
            context_margin_m: coverage.context_margin_m,
            parent_patch_checksums,
            refinement_revision: 1,
        };
        let region_id = format!("region-{source_id}");
        let region = RegionDefinition {
            id: region_id.clone(),
            planet_id: planet.id.clone(),
            name: name.to_owned(),
            selection: selection.clone(),
            detail_level: detail_level_code(config.detail_level),
            revision: 1,
            generation_config: config.clone(),
            provenance: Some(provenance),
            patch_refs: coverage.patch_refs.clone(),
            regional_overrides: Vec::new(),
        };
        let (output_width_cells, output_height_cells) =
            config.requested_cell_dimensions(width_m, height_m);
        let constraints_checksum = constraints_checksum(selection_checksum, &coverage.patch_refs);
        let detailed_region = DetailedRegion {
            id: format!("detail-{source_id}"),
            region_id,
            planet_id: planet.id.clone(),
            patch_refs: coverage.patch_refs.clone(),
            output_width_cells,
            output_height_cells,
            constraints_checksum,
            config: config.clone(),
            revision: 1,
        };
        let provenance_micros = provenance_started.elapsed().as_micros() as u64;
        let inherited_settings_started = Instant::now();
        let settings = inherited_map_settings(
            planet,
            center,
            width_m,
            height_m,
            bearing_deg,
            selection_checksum,
            &config,
        );
        let inherited_settings_micros = inherited_settings_started.elapsed().as_micros() as u64;
        let timings = RegionRefinementTimings {
            validation_micros,
            preflight_micros,
            detail_coverage_micros,
            provenance_micros,
            inherited_settings_micros,
            total_micros: total_started.elapsed().as_micros() as u64,
        };
        Ok(RegionalRefinementPlan {
            region,
            detailed_region,
            settings,
            coverage,
            preflight,
            timings,
        })
    }
}

pub fn region_preflight(
    width_m: f64,
    height_m: f64,
    config: &RegionGenerationConfig,
) -> Result<RegionPreflightReport, RegionGenerationError> {
    config
        .validate(width_m, height_m)
        .map_err(RegionGenerationError::InvalidConfiguration)?;
    let checked_dimension = |length_m: f64| {
        let cells = (length_m / config.target_resolution_m).ceil();
        if !cells.is_finite() || cells < 1.0 || cells > u64::MAX as f64 {
            Err(RegionGenerationError::ArithmeticOverflow("cell dimensions"))
        } else {
            Ok(cells as u64)
        }
    };
    let width_cells = checked_dimension(width_m)?;
    let height_cells = checked_dimension(height_m)?;
    let requested_cells = width_cells
        .checked_mul(height_cells)
        .ok_or(RegionGenerationError::ArithmeticOverflow("cell count"))?;
    if requested_cells > MAX_REQUESTED_REGION_CELLS {
        return Err(RegionGenerationError::CellBudgetExceeded {
            requested: requested_cells,
            limit: MAX_REQUESTED_REGION_CELLS,
        });
    }

    // The current Stage-A solver materializes at most a 320 x 320 analysis grid.
    // Canonical 100 m cells remain chunked and virtual until viewed or edited.
    let analysis_cells = requested_cells.min(320 * 320);
    let estimated_cpu_peak_bytes = analysis_cells
        .checked_mul(112)
        .and_then(|value| value.checked_add(requested_cells.div_ceil(65_536) * 4_096))
        .ok_or(RegionGenerationError::ArithmeticOverflow(
            "CPU byte estimate",
        ))?;
    if estimated_cpu_peak_bytes > MAX_ESTIMATED_CPU_BYTES {
        return Err(RegionGenerationError::MemoryBudgetExceeded {
            estimated: estimated_cpu_peak_bytes,
            limit: MAX_ESTIMATED_CPU_BYTES,
        });
    }
    let estimated_gpu_peak_bytes =
        analysis_cells
            .checked_mul(24)
            .ok_or(RegionGenerationError::ArithmeticOverflow(
                "GPU byte estimate",
            ))?;
    let estimated_temp_bytes =
        analysis_cells
            .checked_mul(48)
            .ok_or(RegionGenerationError::ArithmeticOverflow(
                "temporary byte estimate",
            ))?;
    let risk = if requested_cells > MAX_REQUESTED_REGION_CELLS / 2
        || estimated_cpu_peak_bytes > MAX_ESTIMATED_CPU_BYTES / 2
    {
        RegionPreflightRisk::Warning
    } else {
        RegionPreflightRisk::Safe
    };
    Ok(RegionPreflightReport {
        width_cells,
        height_cells,
        requested_cells,
        analysis_cells,
        estimated_cpu_peak_bytes,
        estimated_gpu_peak_bytes,
        estimated_temp_bytes,
        risk,
    })
}

fn inherited_map_settings(
    planet: &PlanetState,
    center: PlanetPosition,
    width_m: f64,
    height_m: f64,
    bearing_deg: f64,
    _selection_checksum: u64,
    config: &RegionGenerationConfig,
) -> MapGenerationSettings {
    let samples = regional_constraint_samples(planet, center, width_m, height_m, bearing_deg);
    let center_sample = planet.sample_detail(center);
    let water_count = samples.iter().filter(|sample| sample.water).count();
    let region_type = if water_count == 0 {
        RegionType::Inland
    } else if water_count == samples.len() {
        RegionType::Island
    } else {
        RegionType::Coast
    };
    let maximum_elevation_m = samples
        .iter()
        .map(|sample| f64::from(sample.elevation_m))
        .fold(50.0, f64::max)
        .clamp(50.0, 10_000.0);
    let minimum_elevation_m = samples
        .iter()
        .map(|sample| f64::from(sample.elevation_m))
        .fold(0.0, f64::min);
    let precipitation = 80.0 + f64::from(center_sample.moisture).powf(1.35) * 2_200.0;
    let koppen_climate = inherited_koppen(center_sample.temperature_c, center_sample.moisture);
    MapGenerationSettings {
        map_size_km: width_m / 1_000.0,
        map_height_km: height_m / 1_000.0,
        map_size_mode: MapSizeMode::Independent,
        map_aspect_ratio: width_m / height_m.max(1.0),
        target_resolution_m: config.target_resolution_m,
        region_type,
        seed: spatial_seed(planet.seed, 0),
        maximum_elevation_m,
        elevation_span_m: (maximum_elevation_m - minimum_elevation_m).clamp(0.0, 9_000.0),
        terrain_noise_percent: refinement_percent(config.terrain.level),
        elevation_noise_percent: refinement_percent(config.geology.level),
        koppen_climate,
        center_latitude_deg: center.latitude_longitude_deg().0,
        center_longitude_deg: center.latitude_longitude_deg().1,
        reference_temperature_c: f64::from(center_sample.temperature_c),
        reference_humidity_percent: f64::from(center_sample.moisture) * 100.0,
        base_precipitation_mm: precipitation,
        base_wind_mps: inherited_wind_speed(planet, center),
        climate_temperature_correction_c: 0.0,
        climate_humidity_correction_points: 0.0,
        climate_persistence_percent: 78.0,
        extreme_event_frequency_percent: 5.0,
        terrain_recipe_version: crate::generator::CURRENT_TERRAIN_RECIPE_VERSION,
        parent_world_seed: planet.seed,
        selection_bearing_deg: bearing_deg,
        parent_planet_radius_m: planet.physical.radius_m,
    }
}

fn regional_constraint_samples(
    planet: &PlanetState,
    center: PlanetPosition,
    width_m: f64,
    height_m: f64,
    bearing_deg: f64,
) -> Vec<crate::spatial::PlanetSurfaceSample> {
    let mut values = Vec::with_capacity(25);
    for y in 0..5 {
        for x in 0..5 {
            let east_m = width_m * (x as f64 / 4.0 - 0.5);
            let north_m = height_m * (0.5 - y as f64 / 4.0);
            let position = regional_metric_position_rotated(
                center,
                east_m,
                north_m,
                bearing_deg,
                planet.physical.radius_m,
            );
            values.push(planet.sample_detail(position));
        }
    }
    values
}

fn inherited_koppen(temperature_c: f32, moisture: f32) -> KoppenClimate {
    match (temperature_c, moisture) {
        (temperature, _) if temperature < -10.0 => KoppenClimate::EF,
        (temperature, _) if temperature < 0.0 => KoppenClimate::ET,
        (temperature, moisture) if temperature > 23.0 && moisture > 0.72 => KoppenClimate::Af,
        (temperature, moisture) if temperature > 20.0 && moisture < 0.22 => KoppenClimate::BWh,
        (_, moisture) if moisture < 0.32 => KoppenClimate::BSh,
        (temperature, moisture) if temperature > 18.0 && moisture > 0.62 => KoppenClimate::Cfa,
        (temperature, _) if temperature < 8.0 => KoppenClimate::Dfb,
        _ => KoppenClimate::Cfb,
    }
}

fn inherited_wind_speed(planet: &PlanetState, position: PlanetPosition) -> f64 {
    let latitude = position.latitude_longitude_deg().0.abs() / 90.0;
    let rotation = (24.0 / planet.physical.day_length_hours.max(1.0)).sqrt();
    (2.8 + latitude * 4.2) * rotation
}

fn refinement_percent(level: crate::spatial::RefinementLevel) -> f64 {
    match level {
        crate::spatial::RefinementLevel::Off => 0.0,
        crate::spatial::RefinementLevel::Low => 30.0,
        crate::spatial::RefinementLevel::Normal => 52.0,
        crate::spatial::RefinementLevel::High => 74.0,
        crate::spatial::RefinementLevel::Ultra => 92.0,
    }
}

fn detail_level_code(level: RegionDetailLevel) -> u8 {
    match level {
        RegionDetailLevel::Regional => 1,
        RegionDetailLevel::Detailed => 2,
        RegionDetailLevel::Local => 3,
        RegionDetailLevel::Custom => 4,
    }
}

fn spatial_seed(planet_seed: u64, selection_checksum: u64) -> u32 {
    let mixed = planet_seed ^ selection_checksum.rotate_left(29);
    (mixed ^ (mixed >> 32)) as u32
}

fn constraints_checksum(selection_checksum: u64, patches: &[PlanetDetailPatchRef]) -> u64 {
    patches.iter().fold(selection_checksum, |checksum, patch| {
        checksum.rotate_left(7) ^ patch.checksum
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refinement_is_spatially_stable_and_reuses_detail_patches() {
        let mut planet = PlanetState::default();
        let selection = RegionSelection::LocalRectangle {
            center: PlanetPosition::from_latitude_longitude_deg(37.5, 128.0),
            width_m: 120_000.0,
            height_m: 80_000.0,
            selection_bearing_deg: 15.0,
        };
        let config = RegionGenerationConfig {
            target_resolution_m: 500.0,
            ..RegionGenerationConfig::default()
        };
        let first = RegionalRefinementPipeline::prepare(
            &mut planet,
            "one",
            "One",
            selection.clone(),
            config.clone(),
        )
        .expect("first plan");
        let second =
            RegionalRefinementPipeline::prepare(&mut planet, "two", "Two", selection, config)
                .expect("second plan");
        assert_eq!(first.settings.seed, second.settings.seed);
        assert_eq!(
            first.detailed_region.constraints_checksum,
            second.detailed_region.constraints_checksum
        );
        assert_eq!(second.coverage.generated_patch_count, 0);
        assert!(second.coverage.existing_patch_count > 0);
    }

    #[test]
    fn preflight_rejects_pathological_requests_before_detail_cache_mutation() {
        let config = RegionGenerationConfig {
            target_resolution_m: 10.0,
            ..RegionGenerationConfig::default()
        };
        let error = region_preflight(4_000_000.0, 4_000_000.0, &config)
            .expect_err("160 billion requested cells must be rejected");
        assert!(matches!(
            error,
            RegionGenerationError::CellBudgetExceeded { .. }
        ));
    }

    #[test]
    fn preflight_reports_bounded_stage_a_memory() {
        let config = RegionGenerationConfig {
            target_resolution_m: 100.0,
            ..RegionGenerationConfig::default()
        };
        let report = region_preflight(100_000.0, 80_000.0, &config).expect("safe request");
        assert_eq!(report.requested_cells, 800_000);
        assert_eq!(report.analysis_cells, 102_400);
        assert!(report.estimated_cpu_peak_bytes < 64 * 1024 * 1024);
    }

    fn overlapping_selections() -> (RegionSelection, RegionSelection) {
        (
            RegionSelection::LocalRectangle {
                center: PlanetPosition::from_latitude_longitude_deg(37.5, 128.0),
                width_m: 180_000.0,
                height_m: 120_000.0,
                selection_bearing_deg: 8.0,
            },
            RegionSelection::LocalRectangle {
                center: PlanetPosition::from_latitude_longitude_deg(37.7, 128.45),
                width_m: 180_000.0,
                height_m: 120_000.0,
                selection_bearing_deg: 8.0,
            },
        )
    }

    #[test]
    fn overlapping_regions_generate_identical_shared_macroterrain() {
        let planet = PlanetState::default();
        let config = RegionGenerationConfig::default();
        let shared = PlanetPosition::from_latitude_longitude_deg(37.62, 128.24);
        let expected = planet.sample_detail(shared);
        let first = inherited_map_settings(
            &planet,
            PlanetPosition::from_latitude_longitude_deg(37.5, 128.0),
            180_000.0,
            120_000.0,
            8.0,
            11,
            &config,
        );
        let second = inherited_map_settings(
            &planet,
            PlanetPosition::from_latitude_longitude_deg(37.7, 128.45),
            180_000.0,
            120_000.0,
            8.0,
            29,
            &config,
        );
        assert_eq!(first.parent_world_seed, planet.seed);
        assert_eq!(second.parent_world_seed, planet.seed);
        assert_eq!(first.seed, second.seed);
        assert_eq!(planet.sample_detail(shared), expected);
    }

    #[test]
    fn region_generation_order_does_not_change_shared_terrain() {
        let (first_selection, second_selection) = overlapping_selections();
        let config = RegionGenerationConfig {
            target_resolution_m: 1_000.0,
            ..RegionGenerationConfig::default()
        };
        let mut forward = PlanetState::default();
        RegionalRefinementPipeline::prepare(
            &mut forward,
            "a",
            "A",
            first_selection.clone(),
            config.clone(),
        )
        .expect("forward A");
        RegionalRefinementPipeline::prepare(
            &mut forward,
            "b",
            "B",
            second_selection.clone(),
            config.clone(),
        )
        .expect("forward B");

        let mut reverse = PlanetState::default();
        RegionalRefinementPipeline::prepare(
            &mut reverse,
            "b",
            "B",
            second_selection,
            config.clone(),
        )
        .expect("reverse B");
        RegionalRefinementPipeline::prepare(&mut reverse, "a", "A", first_selection, config)
            .expect("reverse A");

        let summarize = |planet: &PlanetState| {
            planet
                .detail_store
                .tiles
                .iter()
                .flat_map(|tile| {
                    tile.lods
                        .iter()
                        .map(move |lod| ((tile.key, lod.resolution_m.to_bits()), lod.checksum))
                })
                .collect::<std::collections::BTreeMap<_, _>>()
        };
        assert_eq!(summarize(&forward), summarize(&reverse));
    }

    #[test]
    fn region_extent_does_not_change_central_world_identity() {
        let planet = PlanetState::default();
        let center = PlanetPosition::from_latitude_longitude_deg(37.5, 128.0);
        let config = RegionGenerationConfig::default();
        let small = inherited_map_settings(&planet, center, 50_000.0, 50_000.0, 0.0, 1, &config);
        let large = inherited_map_settings(&planet, center, 500_000.0, 312_500.0, 0.0, 2, &config);
        assert_eq!(small.seed, large.seed);
        assert_eq!(small.parent_world_seed, large.parent_world_seed);
        assert_eq!(small.center_latitude_deg, large.center_latitude_deg);
        assert_eq!(small.center_longitude_deg, large.center_longitude_deg);
        assert_eq!(planet.sample_detail(center), planet.sample_detail(center));
    }
}
