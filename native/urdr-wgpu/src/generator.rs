use std::{
    cmp::Ordering,
    collections::{BinaryHeap, HashSet, VecDeque},
    sync::atomic::{AtomicBool, Ordering as AtomicOrdering},
    time::Instant,
};

use rayon::prelude::*;
use serde::{Deserialize, Serialize};

use crate::geology::CausalGeologyModel;
use crate::model::{
    DrainageOutlet, DrainageOutletKind, Faction, LandformMetrics, Language, Location, NativeMap,
    PathLine, Point, RiverSegment, Territory, TerritoryGridState, classify_landform,
};
use crate::multiresolution_physics::{MultiresolutionPhysicalSurface, PhysicalAnalysisMetrics};
use crate::procedural::{
    ClimateFieldConfig, GenerationCheck, GenerationDiagnostics, GenerationStageDiagnostic,
    GeologicGuideMesh, TerrainFieldConfig, sample_climate_field, sample_terrain_field,
    terrain_climate_bias,
};
use crate::river_graph::RiverGraph;
use crate::spatial::{
    PlanetPosition, PlanetState, PlanetSurfaceSample, RegionGenerationConfig, RegionSelection,
    regional_metric_position_rotated,
};
use crate::subcell_hydrology::{
    AnalysisHydrologySurface, CURRENT_HYDROLOGY_GEOMETRY_VERSION, CanonicalHydrologySurface,
    ContinuousFlowRoute, ContinuousFlowTarget, HydrologyGeometryStats, HydrologyWorldIdentity,
    SubcellHydrologyGeometry, SubcellHydrologyInput, build_subcell_hydrology,
};

#[derive(Clone, Copy)]
struct RegionalCellBase {
    position: PlanetPosition,
    planetary: Option<PlanetSurfaceSample>,
    basin: f32,
    elevation_m: f32,
    ocean: bool,
}

fn ensure_not_cancelled(cancel: Option<&AtomicBool>) -> Result<(), String> {
    if cancel.is_some_and(|flag| flag.load(AtomicOrdering::Relaxed)) {
        Err("map generation cancelled".to_owned())
    } else {
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RegionType {
    Inland,
    #[default]
    Coast,
    Island,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MapSizeMode {
    #[default]
    WidthAndAspect,
    Independent,
}

impl MapSizeMode {
    pub const ALL: [Self; 2] = [Self::WidthAndAspect, Self::Independent];
}

impl RegionType {
    pub const ALL: [Self; 3] = [Self::Inland, Self::Coast, Self::Island];
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum KoppenClimate {
    Af,
    Am,
    Aw,
    BWh,
    BSh,
    Csa,
    Cfa,
    #[default]
    Cfb,
    Dfa,
    Dfb,
    ET,
    EF,
}

impl KoppenClimate {
    pub const ALL: [Self; 12] = [
        Self::Af,
        Self::Am,
        Self::Aw,
        Self::BWh,
        Self::BSh,
        Self::Csa,
        Self::Cfa,
        Self::Cfb,
        Self::Dfa,
        Self::Dfb,
        Self::ET,
        Self::EF,
    ];

    pub const fn code(self) -> &'static str {
        match self {
            Self::Af => "Af",
            Self::Am => "Am",
            Self::Aw => "Aw",
            Self::BWh => "BWh",
            Self::BSh => "BSh",
            Self::Csa => "Csa",
            Self::Cfa => "Cfa",
            Self::Cfb => "Cfb",
            Self::Dfa => "Dfa",
            Self::Dfb => "Dfb",
            Self::ET => "ET",
            Self::EF => "EF",
        }
    }

    pub const fn climate_model_id(self) -> u8 {
        match self {
            Self::Af | Self::Am | Self::Aw => 2,
            Self::BWh | Self::BSh => 3,
            Self::Csa | Self::Cfa | Self::Cfb => 0,
            Self::Dfa | Self::Dfb => 1,
            Self::ET | Self::EF => 4,
        }
    }

    pub const fn baseline(self) -> ClimateBaseline {
        match self {
            Self::Af => ClimateBaseline::new(26.0, 2_400.0, 86.0, 3.4),
            Self::Am => ClimateBaseline::new(25.5, 1_950.0, 82.0, 3.8),
            Self::Aw => ClimateBaseline::new(24.0, 1_050.0, 70.0, 4.1),
            Self::BWh => ClimateBaseline::new(25.0, 130.0, 25.0, 6.4),
            Self::BSh => ClimateBaseline::new(21.0, 370.0, 36.0, 5.9),
            Self::Csa => ClimateBaseline::new(16.5, 610.0, 55.0, 4.8),
            Self::Cfa => ClimateBaseline::new(15.5, 1_180.0, 69.0, 4.5),
            Self::Cfb => ClimateBaseline::new(12.5, 980.0, 72.0, 5.0),
            Self::Dfa => ClimateBaseline::new(8.5, 720.0, 58.0, 5.4),
            Self::Dfb => ClimateBaseline::new(5.5, 650.0, 61.0, 5.7),
            Self::ET => ClimateBaseline::new(-5.0, 300.0, 70.0, 7.2),
            Self::EF => ClimateBaseline::new(-18.0, 160.0, 66.0, 8.0),
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct ClimateBaseline {
    pub temperature_c: f64,
    pub precipitation_mm: f64,
    pub humidity_percent: f64,
    pub wind_mps: f64,
}

impl ClimateBaseline {
    const fn new(
        temperature_c: f64,
        precipitation_mm: f64,
        humidity_percent: f64,
        wind_mps: f64,
    ) -> Self {
        Self {
            temperature_c,
            precipitation_mm,
            humidity_percent,
            wind_mps,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MapGenerationSettings {
    /// Physical map width in kilometres. Retains the legacy serialized key.
    pub map_size_km: f64,
    #[serde(default = "default_map_height_km")]
    pub map_height_km: f64,
    #[serde(default)]
    pub map_size_mode: MapSizeMode,
    #[serde(default = "default_map_aspect_ratio")]
    pub map_aspect_ratio: f64,
    #[serde(default = "default_target_resolution_m")]
    pub target_resolution_m: f64,
    pub region_type: RegionType,
    pub seed: u32,
    pub maximum_elevation_m: f64,
    pub elevation_span_m: f64,
    pub terrain_noise_percent: f64,
    pub elevation_noise_percent: f64,
    pub koppen_climate: KoppenClimate,
    pub center_latitude_deg: f64,
    #[serde(default)]
    pub center_longitude_deg: f64,
    pub reference_temperature_c: f64,
    pub reference_humidity_percent: f64,
    pub base_precipitation_mm: f64,
    pub base_wind_mps: f64,
    pub climate_temperature_correction_c: f64,
    pub climate_humidity_correction_points: f64,
    pub climate_persistence_percent: f64,
    pub extreme_event_frequency_percent: f64,
    /// Semantic version for reconstructing derived terrain from a saved
    /// virtual CanonicalSurface recipe. Missing values are legacy revision 1.
    #[serde(default = "legacy_terrain_recipe_version")]
    pub terrain_recipe_version: u16,
    /// Stable world seed used by position-based detail. Region IDs and
    /// creation order must never participate in this seed.
    #[serde(default)]
    pub parent_world_seed: u64,
    #[serde(default)]
    pub selection_bearing_deg: f64,
    #[serde(default = "default_parent_planet_radius_m")]
    pub parent_planet_radius_m: f64,
}

pub const CURRENT_TERRAIN_RECIPE_VERSION: u16 = 2;

const fn legacy_terrain_recipe_version() -> u16 {
    1
}

const fn default_parent_planet_radius_m() -> f64 {
    6_371_000.0
}

const fn default_map_height_km() -> f64 {
    312.5
}

const fn default_map_aspect_ratio() -> f64 {
    1.6
}

const fn default_target_resolution_m() -> f64 {
    100.0
}

impl Default for MapGenerationSettings {
    fn default() -> Self {
        let climate = KoppenClimate::Cfb;
        let baseline = climate.baseline();
        Self {
            map_size_km: 500.0,
            map_height_km: default_map_height_km(),
            map_size_mode: MapSizeMode::WidthAndAspect,
            map_aspect_ratio: default_map_aspect_ratio(),
            target_resolution_m: default_target_resolution_m(),
            region_type: RegionType::Coast,
            seed: 990_500_051,
            maximum_elevation_m: 4_800.0,
            elevation_span_m: 5_600.0,
            terrain_noise_percent: 72.0,
            elevation_noise_percent: 58.0,
            koppen_climate: climate,
            center_latitude_deg: 37.5,
            center_longitude_deg: 0.0,
            reference_temperature_c: baseline.temperature_c,
            reference_humidity_percent: baseline.humidity_percent,
            base_precipitation_mm: baseline.precipitation_mm,
            base_wind_mps: baseline.wind_mps,
            climate_temperature_correction_c: 0.0,
            climate_humidity_correction_points: 0.0,
            climate_persistence_percent: 65.0,
            extreme_event_frequency_percent: 8.0,
            terrain_recipe_version: CURRENT_TERRAIN_RECIPE_VERSION,
            parent_world_seed: 0,
            selection_bearing_deg: 0.0,
            parent_planet_radius_m: default_parent_planet_radius_m(),
        }
    }
}

impl MapGenerationSettings {
    pub fn physical_dimensions_km(&self) -> (f64, f64) {
        let width = self.map_size_km;
        let height = match self.map_size_mode {
            MapSizeMode::WidthAndAspect => width / self.map_aspect_ratio.clamp(0.25, 4.0),
            MapSizeMode::Independent => self.map_height_km,
        };
        (width, height)
    }

    pub fn canonical_cell_dimensions(&self) -> (u32, u32) {
        let (width, height) = self.physical_dimensions_km();
        let cells_per_km = 1_000.0 / self.target_resolution_m.clamp(10.0, 10_000.0);
        (
            (width * cells_per_km).round().max(1.0) as u32,
            (height * cells_per_km).round().max(1.0) as u32,
        )
    }

    pub fn validate(&self) -> Result<(), String> {
        if !(1.0..=4_000.0).contains(&self.map_size_km) {
            return Err("map width must be between 1 and 4,000 km".to_owned());
        }
        if self.map_size_mode == MapSizeMode::Independent
            && !(1.0..=4_000.0).contains(&self.map_height_km)
        {
            return Err("map height must be between 1 and 4,000 km".to_owned());
        }
        if !(0.25..=4.0).contains(&self.map_aspect_ratio) {
            return Err("map aspect ratio must be between 1:4 and 4:1".to_owned());
        }
        if !(10.0..=10_000.0).contains(&self.target_resolution_m) {
            return Err("target resolution must be between 10 and 10,000 m".to_owned());
        }
        if !(50.0..=10_000.0).contains(&self.maximum_elevation_m) {
            return Err("maximum elevation must be between 50 and 10,000 m".to_owned());
        }
        if !(0.0..=9_000.0).contains(&self.elevation_span_m) {
            return Err("elevation span must be between 0 and 9,000 m".to_owned());
        }
        for (name, value) in [
            ("terrain noise", self.terrain_noise_percent),
            ("elevation noise", self.elevation_noise_percent),
            ("climate persistence", self.climate_persistence_percent),
            (
                "extreme event frequency",
                self.extreme_event_frequency_percent,
            ),
        ] {
            if !(0.0..=100.0).contains(&value) {
                return Err(format!("{name} must be between 0 and 100 percent"));
            }
        }
        if !(-90.0..=90.0).contains(&self.center_latitude_deg) {
            return Err("center latitude must be between -90 and 90 degrees".to_owned());
        }
        if !(-180.0..=180.0).contains(&self.center_longitude_deg) {
            return Err("center longitude must be between -180 and 180 degrees".to_owned());
        }
        if !(0.0..=100.0).contains(&self.reference_humidity_percent) {
            return Err("reference humidity must be between 0 and 100 percent".to_owned());
        }
        if self.base_precipitation_mm < 0.0 || self.base_wind_mps < 0.0 {
            return Err("precipitation and wind cannot be negative".to_owned());
        }
        Ok(())
    }
}

pub fn random_seed(seed: u32) -> u32 {
    let mut value = seed.wrapping_add(0x9e37_79b9);
    value ^= value >> 16;
    value = value.wrapping_mul(0x85eb_ca6b);
    value ^= value >> 13;
    value = value.wrapping_mul(0xc2b2_ae35);
    value ^ (value >> 16)
}

pub fn generate_map(
    settings: &MapGenerationSettings,
    title: String,
    source_id: String,
    current_year: i32,
    language: Language,
) -> Result<NativeMap, String> {
    let causal_geology = CausalGeologyModel::synthesize(
        u64::from(settings.seed),
        (8.0 + settings.map_size_km.max(settings.map_height_km).ln_1p() * 0.8).round() as usize,
    );
    generate_map_with_geology(
        settings,
        title,
        source_id,
        current_year,
        language,
        causal_geology,
        None,
        PlanetPosition::from_latitude_longitude_deg(
            settings.center_latitude_deg,
            settings.center_longitude_deg,
        ),
        0.0,
        settings.target_resolution_m,
        6_371_000.0,
        None,
    )
}

pub fn generate_map_on_planet(
    settings: &MapGenerationSettings,
    title: String,
    source_id: String,
    current_year: i32,
    language: Language,
    planet: &PlanetState,
) -> Result<NativeMap, String> {
    generate_map_for_region(
        settings,
        title,
        source_id,
        current_year,
        language,
        planet,
        PlanetPosition::from_latitude_longitude_deg(
            settings.center_latitude_deg,
            settings.center_longitude_deg,
        ),
    )
}

pub fn generate_map_for_region(
    settings: &MapGenerationSettings,
    title: String,
    source_id: String,
    current_year: i32,
    language: Language,
    planet: &PlanetState,
    region_center: PlanetPosition,
) -> Result<NativeMap, String> {
    let mut causal_geology = planet.geology.clone();
    causal_geology.ensure_synthesized(planet.seed);
    generate_map_with_geology(
        settings,
        title,
        source_id,
        current_year,
        language,
        causal_geology,
        Some(planet),
        region_center,
        0.0,
        settings.target_resolution_m,
        planet.physical.radius_m,
        None,
    )
}

pub fn generate_map_for_detailed_region(
    settings: &MapGenerationSettings,
    title: String,
    source_id: String,
    current_year: i32,
    language: Language,
    planet: &PlanetState,
    selection: &RegionSelection,
    config: &RegionGenerationConfig,
) -> Result<NativeMap, String> {
    generate_map_for_detailed_region_cancellable(
        settings,
        title,
        source_id,
        current_year,
        language,
        planet,
        selection,
        config,
        None,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn generate_map_for_detailed_region_cancellable(
    settings: &MapGenerationSettings,
    title: String,
    source_id: String,
    current_year: i32,
    language: Language,
    planet: &PlanetState,
    selection: &RegionSelection,
    config: &RegionGenerationConfig,
    cancel: Option<&AtomicBool>,
) -> Result<NativeMap, String> {
    let Some((center, _, _, bearing_deg)) = selection.metric_bounds() else {
        return Err("The selected planetary region cannot be resolved to a metric extent.".into());
    };
    let mut settings = settings.clone();
    settings.target_resolution_m = config.target_resolution_m;
    let mut causal_geology = planet.geology.clone();
    causal_geology.ensure_synthesized(planet.seed);
    generate_map_with_geology(
        &settings,
        title,
        source_id,
        current_year,
        language,
        causal_geology,
        Some(planet),
        center,
        bearing_deg,
        config.target_resolution_m,
        planet.physical.radius_m,
        cancel,
    )
}

fn generate_map_with_geology(
    settings: &MapGenerationSettings,
    title: String,
    source_id: String,
    current_year: i32,
    _language: Language,
    causal_geology: CausalGeologyModel,
    planet: Option<&PlanetState>,
    region_center: PlanetPosition,
    selection_bearing_deg: f64,
    target_resolution_m: f64,
    planet_radius_m: f64,
    cancel: Option<&AtomicBool>,
) -> Result<NativeMap, String> {
    crate::diagnostics::mark_map_generation_call();
    ensure_not_cancelled(cancel)?;
    let mut effective_settings = settings.clone();
    effective_settings.terrain_recipe_version = CURRENT_TERRAIN_RECIPE_VERSION;
    effective_settings.parent_world_seed = planet
        .map(|value| value.seed)
        .unwrap_or_else(|| u64::from(settings.seed));
    effective_settings.selection_bearing_deg = selection_bearing_deg;
    effective_settings.parent_planet_radius_m = planet_radius_m.max(1.0);
    effective_settings.target_resolution_m = target_resolution_m;
    let (center_latitude, center_longitude) = region_center.latitude_longitude_deg();
    effective_settings.center_latitude_deg = center_latitude;
    effective_settings.center_longitude_deg = center_longitude;
    let settings = &effective_settings;
    settings.validate()?;
    let (physical_width_km, physical_height_km) = settings.physical_dimensions_km();
    let (grid_width, grid_height) = derived_grid_size(physical_width_km, physical_height_km);
    crate::diagnostics::event(
        "map_generation",
        "analysis_grid_config",
        "resolved",
        &[
            ("map_id", source_id.clone()),
            ("physical_width_km", format!("{physical_width_km:.6}")),
            ("physical_height_km", format!("{physical_height_km:.6}")),
            (
                "target_resolution_m",
                format!("{:.3}", settings.target_resolution_m),
            ),
            ("analysis_width", grid_width.to_string()),
            ("analysis_height", grid_height.to_string()),
            (
                "analysis_cell_size_km_x",
                format!("{:.9}", physical_width_km / grid_width.max(1) as f64),
            ),
            (
                "analysis_cell_size_km_y",
                format!("{:.9}", physical_height_km / grid_height.max(1) as f64),
            ),
            (
                "target_resolution_semantics",
                "representation+procedural_detail_scale+cache_identity;not_analysis_grid"
                    .to_owned(),
            ),
        ],
    );
    let cell_count = grid_width * grid_height;
    let world_width = physical_width_km as f32;
    let world_height = physical_height_km as f32;
    let mut elevation = vec![0.0_f32; cell_count];
    let mut water = vec!["land".to_owned(); cell_count];
    let mut terrain = vec!["plain".to_owned(); cell_count];
    let mut terrain_basin = vec![0.0_f32; cell_count];
    let generation_started = Instant::now();
    let mut diagnostics = GenerationDiagnostics {
        pipeline_revision: 5,
        peak_materialized_cells: cell_count as u64,
        ..GenerationDiagnostics::default()
    };
    let geologic_guide = GeologicGuideMesh::generate(settings.seed, world_width, world_height);
    let terrain_config = TerrainFieldConfig {
        seed: settings.seed,
        width_km: world_width,
        height_km: world_height,
        region_type: settings.region_type,
        maximum_elevation_m: settings.maximum_elevation_m as f32,
        elevation_span_m: settings.elevation_span_m as f32,
        elevation_noise: settings.elevation_noise_percent as f32 / 100.0,
    };
    let stage_started = Instant::now();

    let base_cells = (0..cell_count)
        .into_par_iter()
        .map(|index| -> Result<RegionalCellBase, String> {
            if index % grid_width.max(1) == 0 {
                ensure_not_cancelled(cancel)?;
            }
            let y = index / grid_width;
            let x = index % grid_width;
            let x_km = (x as f32 + 0.5) / grid_width as f32 * world_width;
            let y_km = (y as f32 + 0.5) / grid_height as f32 * world_height;
            let sample = sample_terrain_field(terrain_config, Some(&geologic_guide), x_km, y_km);
            let planet_position = regional_metric_position_rotated(
                region_center,
                f64::from(x_km - world_width * 0.5) * 1_000.0,
                f64::from(world_height * 0.5 - y_km) * 1_000.0,
                selection_bearing_deg,
                planet_radius_m,
            );
            let geology = causal_geology.sample(planet_position);
            let planetary = planet
                .filter(|planet| !planet.surface.is_empty())
                .map(|planet| planet.sample_detail(planet_position));
            let basin = planet.map_or(sample.basin, |planet| {
                ((planet.detail_noise(planet_position, "terrain-basin", 54.0, 4) + 1.0) * 0.5)
                    as f32
            });
            let ocean = planetary.map_or(sample.ocean, |value| value.water);
            let elevation_m = if let Some(value) = planetary {
                value.elevation_m
            } else if ocean {
                (sample.elevation_m + geology.base_elevation_bias_m as f32 * 0.04).min(-2.0)
            } else {
                (sample.elevation_m + geology.base_elevation_bias_m as f32 * 0.04).max(1.0)
            };
            Ok(RegionalCellBase {
                position: planet_position,
                planetary,
                basin,
                elevation_m,
                ocean,
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    for (index, cell) in base_cells.iter().enumerate() {
        terrain_basin[index] = cell.basin;
        elevation[index] = cell.elevation_m;
        if cell.ocean {
            water[index] = "saltwater".to_owned();
        }
    }
    diagnostics.stages.push(GenerationStageDiagnostic {
        name: "continuous-terrain-field".to_owned(),
        elapsed_micros: stage_started.elapsed().as_micros() as u64,
        stage_seed: settings.seed,
    });
    ensure_not_cancelled(cancel)?;

    let stage_started = Instant::now();
    if planet.is_none() {
        add_lakes(
            settings,
            grid_width,
            grid_height,
            &mut elevation,
            &mut water,
        );
    }
    let lake_outlets = build_lake_outlet_routes(grid_width, grid_height, &mut elevation, &water);
    let ocean_distance = water_distances(grid_width, grid_height, &water, "saltwater");
    let provisional_filled = priority_flood(grid_width, grid_height, &elevation, &water);
    let provisional_downstream = build_downstream(
        settings.seed,
        grid_width,
        grid_height,
        &provisional_filled,
        &water,
        &lake_outlets,
    );
    let provisional_flow = accumulate_flow(&water, &provisional_downstream);
    diagnostics.stages.push(GenerationStageDiagnostic {
        name: "hydrologic-conditioning".to_owned(),
        elapsed_micros: stage_started.elapsed().as_micros() as u64,
        stage_seed: settings.seed ^ 0x7f4a_7c15,
    });

    let mut temperature = vec![0.0_f32; cell_count];
    let mut precipitation = vec![0.0_f32; cell_count];
    let mut moisture = vec![0.0_f32; cell_count];
    let mut humidity = vec![0.0_f32; cell_count];
    let mut runoff = vec![0.0_f32; cell_count];
    let mut wind_x = vec![0.0_f32; cell_count];
    let mut wind_y = vec![0.0_f32; cell_count];
    let mut solar_hours = vec![0.0_f32; cell_count];
    let mut solar_irradiance = vec![0.0_f32; cell_count];
    let mut snowfall = vec![0.0_f32; cell_count];
    let mut snow_cover = vec![0.0_f32; cell_count];
    let mut evapotranspiration = vec![0.0_f32; cell_count];
    let terrain_noise = settings.terrain_noise_percent / 100.0;
    let climate_config = ClimateFieldConfig {
        seed: settings.seed,
        width_km: world_width,
        height_km: world_height,
        center_latitude_deg: settings.center_latitude_deg as f32,
        climate: settings.koppen_climate,
        reference_temperature_c: settings.reference_temperature_c as f32,
        reference_humidity_percent: settings.reference_humidity_percent as f32,
        base_precipitation_mm: settings.base_precipitation_mm as f32,
        base_wind_mps: settings.base_wind_mps as f32,
        temperature_correction_c: settings.climate_temperature_correction_c as f32,
        humidity_correction_points: settings.climate_humidity_correction_points as f32,
        persistence: settings.climate_persistence_percent as f32 / 100.0,
        extreme_frequency: settings.extreme_event_frequency_percent as f32 / 100.0,
    };
    let stage_started = Instant::now();

    for y in 0..grid_height {
        for x in 0..grid_width {
            let index = y * grid_width + x;
            let ux = x as f64 / grid_width.saturating_sub(1).max(1) as f64;
            let uy = y as f64 / grid_height.saturating_sub(1).max(1) as f64;
            let x_km = (x as f32 + 0.5) / grid_width as f32 * world_width;
            let y_km = (y as f32 + 0.5) / grid_height as f32 * world_height;
            let planet_position = base_cells[index].position;
            let planetary = base_cells[index].planetary;
            let cell_km = (world_width / grid_width as f32).max(world_height / grid_height as f32);
            let coast = (-(ocean_distance[index] as f32 * cell_km) / 42.0).exp();
            let flow_influence = (provisional_flow[index].ln_1p() as f32 / 12.0).clamp(0.0, 1.0);
            let climate = sample_climate_field(
                climate_config,
                x_km,
                y_km,
                elevation[index],
                coast,
                terrain_basin[index],
                f32::from(water[index] == "freshwater"),
                flow_influence,
            );
            let global_climate_noise = planet.map_or(0.0, |planet| {
                planet.detail_noise(planet_position, "regional-climate", 46.0, 4)
            });
            let temp = planetary.map_or(climate.temperature_c as f64, |value| {
                f64::from(value.temperature_c)
            });
            let wetness = planetary.map_or(climate.soil_moisture as f64, |value| {
                f64::from(value.moisture)
            });
            let rain = planetary.map_or(climate.precipitation_mm as f64, |_| {
                (35.0 + wetness.powf(1.42) * 2_150.0)
                    * (0.86 + global_climate_noise * 0.18).clamp(0.55, 1.25)
            });
            let humid = planetary.map_or(climate.relative_humidity_percent as f64, |_| {
                (18.0 + wetness * 78.0).clamp(5.0, 100.0)
            });
            let wind_angle = if let Some(planet) = planet {
                let (_, longitude) = planet_position.latitude_longitude_deg();
                (longitude * 0.35
                    + 220.0
                    + planet.detail_noise(planet_position, "wind-direction", 24.0, 3) * 48.0)
                    .to_radians()
            } else {
                (235.0
                    + (fractal_noise(settings.seed ^ 0x1656_67b1, ux * 4.0, uy * 4.0, 3) - 0.5)
                        * 55.0)
                    .to_radians()
            };
            let wind = planetary.map_or(climate.wind_mps as f64, |_| {
                (settings.base_wind_mps * (0.82 + global_climate_noise.abs() * 0.42))
                    .clamp(0.1, 70.0)
            });
            let latitude = planet_position
                .latitude_longitude_deg()
                .0
                .clamp(-89.0, 89.0);
            let day_length = annual_mean_day_length(latitude);
            let cloud = (rain / (rain + climate.potential_evapotranspiration_mm as f64).max(1.0)
                * 0.78
                + wetness * 0.22)
                .clamp(0.04, 0.9);
            let sunshine = (day_length * (1.0 - cloud * 0.68)).clamp(0.0, day_length);
            let snow = if temp < 1.5 {
                rain * ((1.5 - temp) / 10.0).clamp(0.0, 1.0)
            } else {
                0.0
            };
            let et = climate.potential_evapotranspiration_mm as f64;
            temperature[index] = temp as f32;
            precipitation[index] = rain as f32;
            moisture[index] = wetness as f32;
            humidity[index] = humid as f32;
            runoff[index] = (rain - et * 0.55).max(0.0) as f32;
            wind_x[index] = (wind_angle.sin() * wind) as f32;
            wind_y[index] = (-wind_angle.cos() * wind) as f32;
            solar_hours[index] = sunshine as f32;
            solar_irradiance[index] =
                (1_361.0 * latitude.to_radians().cos().abs().max(0.08) * sunshine / 24.0
                    * (1.0 - cloud * 0.66)) as f32;
            snowfall[index] = snow as f32;
            snow_cover[index] = (snow * 0.72 - temp.max(0.0) * 18.0).max(0.0) as f32;
            evapotranspiration[index] = et as f32;

            if water[index] != "land" {
                terrain[index] = "plain".to_owned();
                continue;
            }
            let biome_noise = fractal_noise(
                settings.seed ^ 0xa511_e9b3,
                ux * (3.0 + terrain_noise * 9.0),
                uy * (3.0 + terrain_noise * 9.0),
                4,
            );
            let landform = grid_landform_metrics(
                x,
                y,
                grid_width,
                grid_height,
                world_width,
                world_height,
                &elevation,
            );
            terrain[index] = if let Some(value) = planetary {
                regional_terrain_from_planet(value.terrain, landform).to_owned()
            } else {
                classify_terrain(
                    temp,
                    rain,
                    wetness,
                    climate.aridity_index as f64,
                    climate.hydrologic_saturation as f64,
                    settings.koppen_climate,
                    biome_noise,
                    ocean_distance[index],
                    landform,
                )
                .to_owned()
            };
        }
    }
    diagnostics.stages.push(GenerationStageDiagnostic {
        name: "absolute-climate-and-biomes".to_owned(),
        elapsed_micros: stage_started.elapsed().as_micros() as u64,
        stage_seed: settings.seed ^ 0x94d0_49bb,
    });
    ensure_not_cancelled(cancel)?;

    let stage_started = Instant::now();
    let local_discharge = local_runoff_discharge(
        grid_width,
        grid_height,
        world_width,
        world_height,
        &water,
        &elevation,
        &terrain,
        &precipitation,
        &runoff,
        &moisture,
    );
    let mut filled = priority_flood(grid_width, grid_height, &elevation, &water);
    ensure_not_cancelled(cancel)?;
    let mut routing = build_d_infinity_routing(
        settings.seed,
        grid_width,
        grid_height,
        world_width,
        world_height,
        &filled,
        &water,
        &lake_outlets,
    );
    let mut flow = accumulate_weighted_flow(&water, &local_discharge, &routing);
    ensure_not_cancelled(cancel)?;
    let mut downstream = primary_downstream(&routing);
    let mut channels = initiate_channels(
        grid_width,
        grid_height,
        world_width,
        world_height,
        &water,
        &elevation,
        &terrain,
        &runoff,
        &moisture,
        &flow,
        &downstream,
        &lake_outlets,
    );
    let mut geometry_routing = routing.clone();
    channelize_routing(&mut routing, &channels);
    flow = accumulate_weighted_flow(&water, &local_discharge, &routing);
    let eroded_cells = apply_stream_power_erosion(
        grid_width,
        grid_height,
        world_width,
        world_height,
        &water,
        &filled,
        &downstream,
        &flow,
        &channels,
        &mut elevation,
    );
    diagnostics.stages.push(GenerationStageDiagnostic {
        name: "climate-weighted-runoff".to_owned(),
        elapsed_micros: stage_started.elapsed().as_micros() as u64,
        stage_seed: settings.seed ^ 0x3c6e_f372,
    });

    let stage_started = Instant::now();
    if eroded_cells > 0 {
        ensure_not_cancelled(cancel)?;
        filled = priority_flood(grid_width, grid_height, &elevation, &water);
        routing = build_d_infinity_routing(
            settings.seed,
            grid_width,
            grid_height,
            world_width,
            world_height,
            &filled,
            &water,
            &lake_outlets,
        );
        flow = accumulate_weighted_flow(&water, &local_discharge, &routing);
        downstream = primary_downstream(&routing);
        channels = initiate_channels(
            grid_width,
            grid_height,
            world_width,
            world_height,
            &water,
            &elevation,
            &terrain,
            &runoff,
            &moisture,
            &flow,
            &downstream,
            &lake_outlets,
        );
        geometry_routing = routing.clone();
        channelize_routing(&mut routing, &channels);
        flow = accumulate_weighted_flow(&water, &local_discharge, &routing);
    }
    let (stream_order, shreve_magnitude) = channel_orders(&channels, &downstream, &filled);
    let drainage_outlets = classify_drainage_outlets(grid_width, grid_height, &water, &downstream);
    let river_graph = RiverGraph::default();
    let rivers = Vec::new();
    // New maps contain only physical and environmental data. Civilizations,
    // Places, and transport are authored later in their dedicated editors.
    let locations: Vec<Location> = Vec::new();
    let roads: Vec<PathLine> = Vec::new();
    let factions: Vec<Faction> = Vec::new();
    let territories: Vec<Territory> = Vec::new();
    let territory_owners = vec![-1; cell_count];
    let territory_history: Vec<TerritoryGridState> = Vec::new();
    diagnostics.stages.push(GenerationStageDiagnostic {
        name: "stream-power-adjustment-and-river-network".to_owned(),
        elapsed_micros: stage_started.elapsed().as_micros() as u64,
        stage_seed: settings.seed ^ 0x6a09_e667,
    });

    let (canonical_width, canonical_height) = settings.canonical_cell_dimensions();
    diagnostics.checks.extend([
        GenerationCheck {
            name: "legacy-bedrock-removed".to_owned(),
            passed: terrain.iter().all(|value| value != "bedrock"),
            detail: "Exposed geology is represented by rock or mountain terrain.".to_owned(),
        },
        GenerationCheck {
            name: "human-geography-deferred".to_owned(),
            passed: locations.is_empty()
                && roads.is_empty()
                && factions.is_empty()
                && territories.is_empty(),
            detail: "New maps contain physical and environmental data only.".to_owned(),
        },
    ]);
    let mut map = NativeMap {
        region_id: Some(format!("region-{source_id}")),
        map_view_id: Some(format!("view-{source_id}")),
        source_id,
        title,
        width: world_width,
        height: world_height,
        logical_pixel_width: canonical_width,
        logical_pixel_height: canonical_height,
        surface_cell_m: settings.target_resolution_m as f32,
        grid_width,
        grid_height,
        sea_level: 0.0,
        climate_model: settings.koppen_climate.climate_model_id(),
        environment_seed: settings.seed,
        generation_settings: Some(settings.clone()),
        geologic_guide: Some(geologic_guide),
        causal_geology,
        generation_diagnostics: diagnostics,
        elevation,
        terrain,
        water,
        temperature,
        precipitation,
        moisture,
        humidity,
        runoff,
        wind_x,
        wind_y,
        solar_hours,
        solar_irradiance,
        snowfall,
        snow_cover,
        evapotranspiration,
        flow_accumulation: flow.iter().map(|value| *value as f32).collect(),
        river_order: stream_order.iter().map(|value| f32::from(*value)).collect(),
        roads,
        place_names: Vec::new(),
        rivers,
        river_graph,
        drainage_outlets,
        locations,
        factions,
        territories,
        territory_owners,
        territory_history,
        events: Vec::new(),
        environment_pins: Vec::new(),
        current_year,
        canonical_surface: None,
        surface_revision: 0,
    };
    let canonical_started = Instant::now();
    map.rebuild_canonical_surface();
    let geometry_started = Instant::now();
    let (river_segments, hydrology_stats, physical_metrics) = build_current_river_geometry(
        &map,
        &filled,
        &flow,
        &downstream,
        &channels,
        &stream_order,
        &shreve_magnitude,
        &geometry_routing,
        &lake_outlets,
        region_center,
    );
    map.rivers = river_segments;
    if let Some(metrics) = physical_metrics {
        map.generation_diagnostics.physical_analysis_revision = metrics.revision;
        map.generation_diagnostics.physical_refinement_patches = metrics.patch_count as u32;
        map.generation_diagnostics.physical_refined_cells = metrics.refined_cells as u64;
        map.generation_diagnostics.physical_peak_scratch_bytes = metrics.peak_scratch_bytes as u64;
        map.generation_diagnostics
            .stages
            .push(GenerationStageDiagnostic {
                name: "multiresolution-physical-analysis".to_owned(),
                elapsed_micros: (metrics.total_ms * 1_000.0).round() as u64,
                stage_seed: settings.seed ^ 0x7068_7973,
            });
        map.generation_diagnostics.checks.push(GenerationCheck {
            name: "multiresolution-physical-budget".to_owned(),
            passed: metrics.refined_cells <= 480_000
                && metrics.peak_scratch_bytes <= 96 * 1024 * 1024,
            detail: physical_metrics_detail(&metrics),
        });
    }
    enforce_canonical_land_eligibility(&mut map, true);
    map.rebuild_river_graph_with_revision(false, CURRENT_HYDROLOGY_GEOMETRY_VERSION);
    map.generation_diagnostics
        .stages
        .push(GenerationStageDiagnostic {
            name: "canonical-surface-virtualization".to_owned(),
            elapsed_micros: canonical_started.elapsed().as_micros() as u64,
            stage_seed: settings.seed,
        });
    map.generation_diagnostics
        .stages
        .push(GenerationStageDiagnostic {
            name: "continuous-subcell-hydrology".to_owned(),
            elapsed_micros: geometry_started.elapsed().as_micros() as u64,
            stage_seed: settings.seed ^ 0x6879_6472,
        });
    map.generation_diagnostics.checks.push(GenerationCheck {
        name: "subcell-hydrology-work-budget".to_owned(),
        passed: hydrology_stats.fallback_count <= hydrology_stats.channel_cells / 3 + 1,
        detail: hydrology_stats_detail(&hydrology_stats),
    });
    map.generation_diagnostics
        .stages
        .push(GenerationStageDiagnostic {
            name: "complete-generation".to_owned(),
            elapsed_micros: generation_started.elapsed().as_micros() as u64,
            stage_seed: settings.seed,
        });
    map.generation_diagnostics.checks.push(GenerationCheck {
        name: "analysis-to-canonical-scale".to_owned(),
        passed: canonical_width >= grid_width as u32 && canonical_height >= grid_height as u32,
        detail: format!(
            "analysis={}x{}, canonical={}x{}, target_resolution_m={:.1}",
            grid_width,
            grid_height,
            canonical_width,
            canonical_height,
            settings.target_resolution_m,
        ),
    });
    let wetland_cells = map
        .terrain
        .iter()
        .filter(|value| value.as_str() == "wetland")
        .count();
    let land_cells = map
        .water
        .iter()
        .filter(|value| value.as_str() == "land")
        .count();
    map.generation_diagnostics.checks.push(GenerationCheck {
        name: "hot-desert-wetland-cap".to_owned(),
        passed: settings.koppen_climate != KoppenClimate::BWh
            || wetland_cells * 20 <= land_cells.max(1),
        detail: format!(
            "wetland={wetland_cells}, land={land_cells}, climate={}",
            settings.koppen_climate.code()
        ),
    });
    Ok(map)
}

pub fn regenerate_hydrology_and_roads(map: &mut NativeMap) {
    let cells = map.grid_width.saturating_mul(map.grid_height);
    if cells == 0 || map.elevation.len() < cells || map.water.len() < cells {
        return;
    }
    let lake_outlets = build_lake_outlet_routes(
        map.grid_width,
        map.grid_height,
        &mut map.elevation,
        &map.water,
    );
    let filled = priority_flood(map.grid_width, map.grid_height, &map.elevation, &map.water);
    let mut routing = build_d_infinity_routing(
        map.environment_seed,
        map.grid_width,
        map.grid_height,
        map.width,
        map.height,
        &filled,
        &map.water,
        &lake_outlets,
    );
    let geometry_routing = routing.clone();
    let downstream = primary_downstream(&routing);
    map.drainage_outlets =
        classify_drainage_outlets(map.grid_width, map.grid_height, &map.water, &downstream);
    let local_discharge = local_runoff_discharge(
        map.grid_width,
        map.grid_height,
        map.width,
        map.height,
        &map.water,
        &map.elevation,
        &map.terrain,
        &map.precipitation,
        &map.runoff,
        &map.moisture,
    );
    let mut flow = accumulate_weighted_flow(&map.water, &local_discharge, &routing);
    let channels = initiate_channels(
        map.grid_width,
        map.grid_height,
        map.width,
        map.height,
        &map.water,
        &map.elevation,
        &map.terrain,
        &map.runoff,
        &map.moisture,
        &flow,
        &downstream,
        &lake_outlets,
    );
    channelize_routing(&mut routing, &channels);
    flow = accumulate_weighted_flow(&map.water, &local_discharge, &routing);
    let (stream_order, shreve_magnitude) = channel_orders(&channels, &downstream, &filled);
    let region_center = map
        .generation_settings
        .as_ref()
        .map(|settings| {
            PlanetPosition::from_latitude_longitude_deg(
                settings.center_latitude_deg,
                settings.center_longitude_deg,
            )
        })
        .unwrap_or_else(|| PlanetPosition::from_latitude_longitude_deg(0.0, 0.0));
    let (rivers, stats, _) = build_current_river_geometry(
        map,
        &filled,
        &flow,
        &downstream,
        &channels,
        &stream_order,
        &shreve_magnitude,
        &geometry_routing,
        &lake_outlets,
        region_center,
    );
    map.rivers = rivers;
    map.rebuild_river_discharge_widths();
    map.flow_accumulation = flow.iter().map(|value| *value as f32).collect();
    map.river_order = stream_order.iter().map(|value| f32::from(*value)).collect();

    if !map.roads.is_empty() {
        map.roads = generate_roads(
            map.grid_width,
            map.grid_height,
            map.width,
            map.height,
            &map.water,
            &map.elevation,
            &map.locations,
        );
    }
    enforce_canonical_land_eligibility(map, false);
    map.rebuild_river_graph_with_revision(false, CURRENT_HYDROLOGY_GEOMETRY_VERSION);
    map.generation_diagnostics.checks.push(GenerationCheck {
        name: "subcell-hydrology-regeneration".to_owned(),
        passed: stats.fallback_count <= stats.channel_cells / 3 + 1,
        detail: hydrology_stats_detail(&stats),
    });
}

fn enforce_canonical_land_eligibility(map: &mut NativeMap, remove_generated_locations: bool) {
    let Some(surface) = map.canonical_surface.as_ref().cloned() else {
        return;
    };
    let width = map.width;
    let height = map.height;
    let is_land = |point: Point| canonical_land_at(&surface, width, height, point);

    if remove_generated_locations {
        map.locations.retain(|location| {
            !location.id.starts_with("generated-place-")
                || location.states.iter().all(|state| is_land(state.position))
        });
    }
    for location in &mut map.locations {
        location.water_position_warning =
            location.states.iter().any(|state| !is_land(state.position));
    }

    map.roads = map
        .roads
        .iter()
        .flat_map(|road| clip_path_to_canonical_land(road, &is_land))
        .collect();
    map.rivers = map
        .rivers
        .iter()
        .filter_map(|river| clip_river_to_canonical_land(river, &is_land))
        .collect();
    map.place_names
        .retain(|label| is_land(label.position) && label.path.iter().copied().all(&is_land));
    for event in &mut map.events {
        if event.location.is_some_and(|point| !is_land(point)) {
            event.location = None;
        }
    }

    let grid_width = map.grid_width.max(1);
    let grid_height = map.grid_height.max(1);
    for (index, owner) in map.territory_owners.iter_mut().enumerate() {
        let point = Point {
            x: (index % grid_width) as f32 * width / grid_width as f32
                + width / grid_width as f32 * 0.5,
            y: (index / grid_width) as f32 * height / grid_height as f32
                + height / grid_height as f32 * 0.5,
        };
        if !is_land(point) {
            *owner = -1;
        }
    }
    for state in &mut map.territory_history {
        state.owners.resize(grid_width * grid_height, -1);
        for (index, owner) in state.owners.iter_mut().enumerate() {
            let point = Point {
                x: (index % grid_width) as f32 * width / grid_width as f32
                    + width / grid_width as f32 * 0.5,
                y: (index / grid_width) as f32 * height / grid_height as f32
                    + height / grid_height as f32 * 0.5,
            };
            if !is_land(point) {
                *owner = -1;
            }
        }
    }
}

fn canonical_land_at(
    surface: &crate::model::CanonicalSurface,
    world_width: f32,
    world_height: f32,
    point: Point,
) -> bool {
    if !point.x.is_finite()
        || !point.y.is_finite()
        || point.x < 0.0
        || point.y < 0.0
        || point.x >= world_width
        || point.y >= world_height
    {
        return false;
    }
    let x = (point.x / world_width.max(f32::EPSILON) * surface.width as f32)
        .floor()
        .clamp(0.0, surface.width.saturating_sub(1) as f32) as usize;
    let y = (point.y / world_height.max(f32::EPSILON) * surface.height as f32)
        .floor()
        .clamp(0.0, surface.height.saturating_sub(1) as f32) as usize;
    surface.sample(x, y).water == "land"
}

fn clip_path_to_canonical_land(path: &PathLine, is_land: &impl Fn(Point) -> bool) -> Vec<PathLine> {
    if path.nodes.len() < 2 {
        return Vec::new();
    }
    let mut output = Vec::new();
    let mut current = Vec::<Point>::new();
    for segment in path.nodes.windows(2) {
        for (start, end) in land_intervals(segment[0], segment[1], 0.05, is_land) {
            if current
                .last()
                .is_none_or(|point| point_distance(*point, start) > 0.000_1)
            {
                if current.len() >= 2 {
                    output.push(PathLine {
                        nodes: std::mem::take(&mut current),
                    });
                } else {
                    current.clear();
                }
                current.push(start);
            }
            current.push(end);
        }
    }
    if current.len() >= 2 {
        output.push(PathLine { nodes: current });
    }
    output
}

fn clip_river_to_canonical_land(
    river: &RiverSegment,
    is_land: &impl Fn(Point) -> bool,
) -> Option<RiverSegment> {
    if point_distance(river.start, river.end) <= 0.000_01 {
        return None;
    }
    // Clip the river centre-line, not both banks. Requiring half-width land
    // clearance shortened wide rivers before the coast and produced visible
    // gaps. The renderer draws the shoreline after the river, cleanly capping
    // the physical-width mesh at this exact shared boundary.
    let interval = land_intervals(
        river.start,
        river.end,
        1.0 / NativeMap::LOGICAL_PIXELS_PER_KM,
        is_land,
    )
    .into_iter()
    .max_by(|left, right| {
        point_distance(left.0, left.1).total_cmp(&point_distance(right.0, right.1))
    })?;
    (point_distance(interval.0, interval.1) > 0.000_1).then(|| RiverSegment {
        start: interval.0,
        end: interval.1,
        width: river.width,
        discharge: river.discharge,
        stream_order: river.stream_order,
    })
}

fn land_intervals(
    start: Point,
    end: Point,
    maximum_step_km: f32,
    is_land: &impl Fn(Point) -> bool,
) -> Vec<(Point, Point)> {
    let length = point_distance(start, end);
    let steps = (length / maximum_step_km.max(0.001)).ceil().max(1.0) as usize;
    let point_at = |ratio: f32| Point {
        x: start.x + (end.x - start.x) * ratio,
        y: start.y + (end.y - start.y) * ratio,
    };
    let mut output = Vec::new();
    let mut run_start = is_land(start).then_some(0.0_f32);
    let mut previous_ratio = 0.0_f32;
    let mut previous_land = run_start.is_some();
    for step in 1..=steps {
        let ratio = step as f32 / steps as f32;
        let land = is_land(point_at(ratio));
        if land != previous_land {
            let boundary =
                refine_land_boundary(previous_ratio, ratio, previous_land, &point_at, is_land);
            if previous_land {
                if let Some(start_ratio) = run_start.take() {
                    output.push((point_at(start_ratio), point_at(boundary)));
                }
            } else {
                run_start = Some(boundary);
            }
        }
        previous_ratio = ratio;
        previous_land = land;
    }
    if previous_land && let Some(start_ratio) = run_start {
        output.push((point_at(start_ratio), end));
    }
    output
}

fn refine_land_boundary(
    mut left: f32,
    mut right: f32,
    left_is_land: bool,
    point_at: &impl Fn(f32) -> Point,
    is_land: &impl Fn(Point) -> bool,
) -> f32 {
    for _ in 0..10 {
        let middle = (left + right) * 0.5;
        if is_land(point_at(middle)) == left_is_land {
            left = middle;
        } else {
            right = middle;
        }
    }
    if left_is_land { left } else { right }
}

fn point_distance(left: Point, right: Point) -> f32 {
    ((right.x - left.x).powi(2) + (right.y - left.y).powi(2)).sqrt()
}

fn derived_grid_size(width_km: f64, height_km: f64) -> (usize, usize) {
    let scale = ((width_km * height_km) / (500.0 * 312.5))
        .sqrt()
        .sqrt()
        .clamp(0.65, 1.6);
    let width = ((192.0 * scale).round() as usize).clamp(128, 320);
    let width = width.div_ceil(8) * 8;
    let height = ((width as f64 * height_km / width_km.max(0.01)).round() as usize).clamp(64, 320);
    (width, height)
}

fn add_lakes(
    settings: &MapGenerationSettings,
    width: usize,
    height: usize,
    elevation: &mut [f32],
    water: &mut [String],
) {
    if width < 3 || height < 3 {
        return;
    }
    let ocean_distance = water_distances(width, height, water, "saltwater");
    let (world_width, world_height) = settings.physical_dimensions_km();
    let cell_width = world_width as f32 / width as f32;
    let cell_height = world_height as f32 / height as f32;
    let climate_factor = match settings.koppen_climate {
        KoppenClimate::BWh => 0.35,
        KoppenClimate::BSh => 0.55,
        KoppenClimate::Af | KoppenClimate::Am => 1.30,
        _ => 1.0,
    };
    let target_count = (((world_width * world_height).sqrt() / 72.0) * climate_factor)
        .round()
        .clamp(1.0, 14.0) as usize;
    let mut candidates = Vec::new();
    for y in 1..height.saturating_sub(1) {
        for x in 1..width.saturating_sub(1) {
            let index = y * width + x;
            if water[index] != "land" || ocean_distance[index] < 5 {
                continue;
            }
            let x_km = (x as f64 + 0.5) / width as f64 * world_width;
            let y_km = (y as f64 + 0.5) / height as f64 * world_height;
            let basin = 1.0
                - fractal_noise(
                    settings.seed ^ 0x6a09_e667,
                    x_km / (world_width.max(world_height) * 0.075).max(2.0),
                    y_km / (world_width.max(world_height) * 0.075).max(2.0),
                    4,
                );
            let local = fractal_noise(
                settings.seed ^ 0x7f4a_7c15,
                x_km / 3.7 + 31.0,
                y_km / 3.7 - 47.0,
                3,
            );
            let local_minimum = neighbors8(x, y, width, height)
                .into_iter()
                .all(|next| elevation[index] <= elevation[next] + 18.0);
            let altitude =
                (elevation[index] / settings.maximum_elevation_m.max(50.0) as f32).clamp(0.0, 1.0);
            let score = basin * 0.64 + local * 0.28 + (1.0 - altitude as f64) * 0.08;
            if local_minimum && score > 0.53 {
                candidates.push((
                    score,
                    hash(settings.seed ^ 0xa54f_f53a, index as u32),
                    index,
                ));
            }
        }
    }
    candidates.sort_by(|left, right| {
        right
            .0
            .total_cmp(&left.0)
            .then_with(|| left.1.cmp(&right.1))
    });

    let mut centers = Vec::<(f32, f32, f32)>::new();
    for (_, variation_key, index) in candidates {
        if centers.len() >= target_count {
            break;
        }
        let x = index % width;
        let y = index / width;
        let center_x = (x as f32 + 0.5) * cell_width;
        let center_y = (y as f32 + 0.5) * cell_height;
        let variation = variation_key as f32 / u32::MAX as f32;
        let radius_km = ((world_width.min(world_height) as f32 * 0.012).clamp(0.45, 10.0)
            * (0.32 + variation * 1.92))
            .max(cell_width.max(cell_height) * 1.35);
        if centers.iter().any(|(other_x, other_y, other_radius)| {
            (center_x - *other_x).hypot(center_y - *other_y)
                < radius_km + *other_radius + cell_width.max(cell_height) * 2.0
        }) {
            continue;
        }
        let aspect = 0.48 + unit_noise(settings.seed ^ 0x243f_6a88, index) as f32 * 0.50;
        let angle = unit_noise(settings.seed ^ 0x85a3_08d3, index) as f32 * std::f32::consts::TAU;
        let cos = angle.cos();
        let sin = angle.sin();
        let radius_x = radius_km;
        let radius_y = radius_km * aspect;
        let bounds_x = (radius_x / cell_width).ceil() as isize + 2;
        let bounds_y = (radius_x / cell_height).ceil() as isize + 2;
        let lake_level = elevation[index].max(1.0);
        let mut lake_cells = Vec::new();
        for candidate_y in y as isize - bounds_y..=y as isize + bounds_y {
            for candidate_x in x as isize - bounds_x..=x as isize + bounds_x {
                if candidate_x <= 0
                    || candidate_y <= 0
                    || candidate_x + 1 >= width as isize
                    || candidate_y + 1 >= height as isize
                {
                    continue;
                }
                let candidate_index = candidate_y as usize * width + candidate_x as usize;
                if water[candidate_index] != "land" || ocean_distance[candidate_index] < 4 {
                    continue;
                }
                let dx = (candidate_x as f32 - x as f32) * cell_width;
                let dy = (candidate_y as f32 - y as f32) * cell_height;
                let rotated_x = dx * cos + dy * sin;
                let rotated_y = -dx * sin + dy * cos;
                let radial =
                    ((rotated_x / radius_x).powi(2) + (rotated_y / radius_y).powi(2)).sqrt();
                let boundary = (fractal_noise(
                    settings.seed ^ variation_key ^ 0x1319_8a2e,
                    center_x as f64 / 2.3 + candidate_x as f64 * 0.21,
                    center_y as f64 / 2.3 + candidate_y as f64 * 0.21,
                    4,
                ) - 0.5) as f32
                    * (0.26 + variation * 0.34);
                let admissible_rise = 55.0 + radius_km * 18.0;
                if radial <= 1.0 + boundary
                    && elevation[candidate_index] <= lake_level + admissible_rise
                {
                    lake_cells.push(candidate_index);
                }
            }
        }
        if !lake_cells.contains(&index) {
            lake_cells.push(index);
        }
        if lake_cells.len() < 3 {
            continue;
        }
        for lake_index in lake_cells {
            water[lake_index] = "freshwater".to_owned();
            elevation[lake_index] = lake_level;
        }
        centers.push((center_x, center_y, radius_km));
    }
}

fn water_distances(width: usize, height: usize, water: &[String], target: &str) -> Vec<usize> {
    let mut distance = vec![usize::MAX; width * height];
    let mut queue = VecDeque::new();
    for (index, value) in water.iter().enumerate() {
        if value == target {
            distance[index] = 0;
            queue.push_back(index);
        }
    }
    if queue.is_empty() {
        distance.fill(width.max(height));
        return distance;
    }
    while let Some(index) = queue.pop_front() {
        let x = index % width;
        let y = index / width;
        for next in orthogonal_neighbors(x, y, width, height) {
            if distance[next] == usize::MAX {
                distance[next] = distance[index] + 1;
                queue.push_back(next);
            }
        }
    }
    distance
}

#[derive(Clone, Debug)]
struct LakeOutletRoute {
    lake_index: usize,
    /// Land cells followed by the terminal saltwater cell.
    cells: Vec<usize>,
}

#[derive(Clone, Copy, Debug)]
struct RouteCell {
    cost: f64,
    index: usize,
}

impl PartialEq for RouteCell {
    fn eq(&self, other: &Self) -> bool {
        self.cost == other.cost && self.index == other.index
    }
}

impl Eq for RouteCell {}

impl PartialOrd for RouteCell {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for RouteCell {
    fn cmp(&self, other: &Self) -> Ordering {
        other
            .cost
            .total_cmp(&self.cost)
            .then_with(|| other.index.cmp(&self.index))
    }
}

/// Gives every elevated freshwater component one explicit, land-routed outlet
/// when an ocean exists. The rectangular map boundary is never a substitute
/// for saltwater.
fn build_lake_outlet_routes(
    width: usize,
    height: usize,
    elevation: &mut [f32],
    water: &[String],
) -> Vec<LakeOutletRoute> {
    if width == 0
        || height == 0
        || water.len() < width.saturating_mul(height)
        || !water.iter().any(|value| value == "saltwater")
    {
        return Vec::new();
    }
    let mut visited = vec![false; water.len()];
    let mut routes = Vec::new();
    for seed in 0..water.len() {
        if visited[seed] || water[seed] != "freshwater" {
            continue;
        }
        let mut component = Vec::new();
        let mut queue = VecDeque::from([seed]);
        visited[seed] = true;
        while let Some(index) = queue.pop_front() {
            component.push(index);
            let x = index % width;
            let y = index / width;
            for next in orthogonal_neighbors(x, y, width, height) {
                if !visited[next] && water[next] == "freshwater" {
                    visited[next] = true;
                    queue.push_back(next);
                }
            }
        }
        let lake_level = component
            .iter()
            .filter_map(|index| elevation.get(*index).copied())
            .fold(f32::NEG_INFINITY, f32::max);
        if !lake_level.is_finite() || lake_level <= 0.0 {
            continue;
        }
        if let Some(route) =
            least_cost_lake_outlet(width, height, elevation, water, &component, lake_level)
        {
            let land_count = route.cells.len().saturating_sub(1).max(1);
            for (step, &index) in route.cells.iter().take(land_count).enumerate() {
                let progress = (step + 1) as f32 / (land_count + 1) as f32;
                let channel_height = (lake_level * (1.0 - progress)).max(1.0);
                if let Some(value) = elevation.get_mut(index) {
                    *value = value.min(channel_height);
                }
            }
            routes.push(route);
        }
    }
    routes
}

fn least_cost_lake_outlet(
    width: usize,
    height: usize,
    elevation: &[f32],
    water: &[String],
    lake: &[usize],
    lake_level: f32,
) -> Option<LakeOutletRoute> {
    let cell_count = width.saturating_mul(height);
    let mut costs = vec![f64::INFINITY; cell_count];
    let mut parents = vec![usize::MAX; cell_count];
    let mut sources = vec![usize::MAX; cell_count];
    let mut heap = BinaryHeap::new();
    let lake_set = lake.iter().copied().collect::<HashSet<_>>();
    for &lake_index in lake {
        let x = lake_index % width;
        let y = lake_index / width;
        for next in neighbors8(x, y, width, height) {
            if water[next] != "land" {
                continue;
            }
            let rise = (elevation[next] - lake_level).max(0.0) as f64;
            let cost = 1.0 + rise * 0.035;
            if cost < costs[next] {
                costs[next] = cost;
                parents[next] = usize::MAX;
                sources[next] = lake_index;
                heap.push(RouteCell { cost, index: next });
            }
        }
    }
    while let Some(RouteCell { cost, index }) = heap.pop() {
        if cost > costs[index] {
            continue;
        }
        let x = index % width;
        let y = index / width;
        for next in neighbors8(x, y, width, height) {
            if water[next] == "saltwater" {
                let mut cells = vec![next, index];
                let mut cursor = index;
                while parents[cursor] != usize::MAX {
                    cursor = parents[cursor];
                    cells.push(cursor);
                }
                cells.reverse();
                return Some(LakeOutletRoute {
                    lake_index: sources[index],
                    cells,
                });
            }
            if water[next] != "land" || lake_set.contains(&next) {
                continue;
            }
            let uphill = (elevation[next] - elevation[index]).max(0.0) as f64;
            let above_lake = (elevation[next] - lake_level).max(0.0) as f64;
            let diagonal = if next % width != x && next / width != y {
                std::f64::consts::SQRT_2
            } else {
                1.0
            };
            let next_cost = cost + diagonal + uphill * 0.055 + above_lake * 0.004;
            if next_cost < costs[next] {
                costs[next] = next_cost;
                parents[next] = index;
                sources[next] = sources[index];
                heap.push(RouteCell {
                    cost: next_cost,
                    index: next,
                });
            }
        }
    }
    None
}

#[derive(Clone, Copy, Debug)]
struct HeapCell {
    elevation: f64,
    index: usize,
}

impl PartialEq for HeapCell {
    fn eq(&self, other: &Self) -> bool {
        self.elevation == other.elevation && self.index == other.index
    }
}

impl Eq for HeapCell {}

impl PartialOrd for HeapCell {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for HeapCell {
    fn cmp(&self, other: &Self) -> Ordering {
        other
            .elevation
            .total_cmp(&self.elevation)
            .then_with(|| other.index.cmp(&self.index))
    }
}

fn priority_flood(width: usize, height: usize, elevation: &[f32], water: &[String]) -> Vec<f64> {
    let mut filled = elevation
        .iter()
        .map(|value| *value as f64)
        .collect::<Vec<_>>();
    let mut visited = vec![false; width * height];
    let mut heap = BinaryHeap::new();
    for (index, kind) in water.iter().enumerate() {
        if kind != "land" {
            visited[index] = true;
            heap.push(HeapCell {
                elevation: filled[index],
                index,
            });
        }
    }
    // The rectangular extent is only a window into the world, not an ocean.
    // Fully inland maps drain into their lowest endorheic basin instead.
    if heap.is_empty()
        && let Some((index, &lowest)) = elevation
            .iter()
            .enumerate()
            .min_by(|left, right| left.1.total_cmp(right.1))
    {
        visited[index] = true;
        heap.push(HeapCell {
            elevation: lowest as f64,
            index,
        });
    }
    while let Some(cell) = heap.pop() {
        let x = cell.index % width;
        let y = cell.index / width;
        for next in orthogonal_neighbors(x, y, width, height) {
            if visited[next] {
                continue;
            }
            visited[next] = true;
            filled[next] = filled[next].max(cell.elevation + 0.001);
            heap.push(HeapCell {
                elevation: filled[next],
                index: next,
            });
        }
    }
    filled
}

fn build_downstream(
    seed: u32,
    width: usize,
    height: usize,
    filled: &[f64],
    water: &[String],
    lake_outlets: &[LakeOutletRoute],
) -> Vec<Option<usize>> {
    let mut downstream = vec![None; width * height];
    for y in 0..height {
        for x in 0..width {
            let index = y * width + x;
            if water[index] != "land" {
                continue;
            }
            let mut candidates = neighbors8(x, y, width, height);
            candidates.sort_by(|a, b| {
                filled[*a]
                    .total_cmp(&filled[*b])
                    .then_with(|| hash(seed, *a as u32).cmp(&hash(seed, *b as u32)))
            });
            downstream[index] = candidates
                .into_iter()
                .find(|next| water[*next] != "land" || filled[*next] < filled[index]);
        }
    }
    for route in lake_outlets {
        for pair in route.cells.windows(2) {
            if water.get(pair[0]).is_some_and(|kind| kind == "land") {
                downstream[pair[0]] = Some(pair[1]);
            }
        }
    }
    downstream
}

fn classify_drainage_outlets(
    width: usize,
    height: usize,
    water: &[String],
    downstream: &[Option<usize>],
) -> Vec<DrainageOutlet> {
    let mut seen = HashSet::new();
    let mut outlets = Vec::new();
    for index in 0..water.len().min(downstream.len()) {
        if water[index] != "land" {
            continue;
        }
        let outlet = match downstream[index] {
            Some(next) if water.get(next).is_some_and(|kind| kind == "saltwater") => {
                Some((next, DrainageOutletKind::OceanOutlet))
            }
            Some(next) if water.get(next).is_some_and(|kind| kind == "freshwater") => {
                Some((next, DrainageOutletKind::LakeOutlet))
            }
            Some(_) => None,
            None => {
                let x = index % width.max(1);
                let y = index / width.max(1);
                let kind = if x == 0 || y == 0 || x + 1 == width || y + 1 == height {
                    DrainageOutletKind::BorderContinuation
                } else {
                    DrainageOutletKind::ClosedBasin
                };
                Some((index, kind))
            }
        };
        if let Some((analysis_index, kind)) = outlet
            && seen.insert((analysis_index, kind))
        {
            outlets.push(DrainageOutlet {
                analysis_index,
                kind,
            });
        }
    }
    outlets.sort_by_key(|outlet| {
        let kind = match outlet.kind {
            DrainageOutletKind::OceanOutlet => 0_u8,
            DrainageOutletKind::LakeOutlet => 1,
            DrainageOutletKind::BorderContinuation => 2,
            DrainageOutletKind::ClosedBasin => 3,
        };
        (outlet.analysis_index, kind)
    });
    outlets
}

fn accumulate_flow(water: &[String], downstream: &[Option<usize>]) -> Vec<f64> {
    let mut incoming = vec![0_usize; water.len()];
    for (index, next) in downstream.iter().copied().enumerate() {
        if water.get(index).is_some_and(|kind| kind == "land")
            && let Some(next) = next
            && next < incoming.len()
        {
            incoming[next] += 1;
        }
    }
    let mut flow = water
        .iter()
        .map(|kind| f64::from(kind == "land"))
        .collect::<Vec<_>>();
    let mut queue = (0..water.len())
        .filter(|index| water[*index] == "land" && incoming[*index] == 0)
        .collect::<VecDeque<_>>();
    while let Some(index) = queue.pop_front() {
        let Some(next) = downstream.get(index).copied().flatten() else {
            continue;
        };
        if next >= flow.len() {
            continue;
        }
        flow[next] += flow[index];
        incoming[next] = incoming[next].saturating_sub(1);
        if water[next] == "land" && incoming[next] == 0 {
            queue.push_back(next);
        }
    }
    flow
}

#[derive(Clone, Copy, Debug)]
struct FlowTarget {
    index: usize,
    weight: f64,
}

#[derive(Clone, Copy, Debug, Default)]
struct FlowRoute {
    targets: [Option<FlowTarget>; 2],
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct DiagnosticFlowTarget {
    pub from: usize,
    pub to: usize,
    pub weight: f64,
}

#[derive(Clone, Debug)]
pub(crate) struct PipelineDiagnosticReplay {
    pub width: usize,
    pub height: usize,
    pub pre_erosion_elevation: Vec<f32>,
    pub priority_flood_elevation: Vec<f32>,
    pub post_erosion_elevation: Vec<f32>,
    pub final_analysis_elevation: Vec<f32>,
    pub flow_targets: Vec<DiagnosticFlowTarget>,
    pub flow_accumulation: Vec<f64>,
    pub downstream: Vec<Option<usize>>,
    pub channels: Vec<bool>,
    pub channel_cell_segments: Vec<(Point, Point)>,
    pub subcell_segments: Vec<(Point, Point)>,
    pub legacy_segments: Vec<RiverSegment>,
    pub spline_segments: Vec<RiverSegment>,
    pub graph_segments: Vec<RiverSegment>,
    pub final_segments: Vec<RiverSegment>,
    pub eroded_cells: usize,
    pub lake_outlet_count: usize,
    pub hydrology_geometry_stats: HydrologyGeometryStats,
    pub physical_analysis_metrics: Option<PhysicalAnalysisMetrics>,
    pub legacy_geometry_build_ms: f64,
    pub river_graph_build_ms: f64,
    pub replay_total_ms: f64,
}

impl FlowRoute {
    fn primary(self) -> Option<usize> {
        self.targets[0].map(|target| target.index)
    }
}

#[allow(clippy::too_many_arguments)]
fn build_d_infinity_routing(
    seed: u32,
    width: usize,
    height: usize,
    world_width: f32,
    world_height: f32,
    filled: &[f64],
    water: &[String],
    lake_outlets: &[LakeOutletRoute],
) -> Vec<FlowRoute> {
    let mut routing = vec![FlowRoute::default(); width * height];
    let cell_width = f64::from(world_width) / width.max(1) as f64;
    let cell_height = f64::from(world_height) / height.max(1) as f64;
    for y in 0..height {
        for x in 0..width {
            let index = y * width + x;
            if water[index] != "land" {
                continue;
            }
            let sample = |sample_x: isize, sample_y: isize| {
                let sample_x = sample_x.clamp(0, width.saturating_sub(1) as isize) as usize;
                let sample_y = sample_y.clamp(0, height.saturating_sub(1) as isize) as usize;
                filled[sample_y * width + sample_x]
            };
            let downhill_x = (sample(x as isize - 1, y as isize)
                - sample(x as isize + 1, y as isize))
                / (cell_width * 2.0).max(0.001);
            let downhill_y = (sample(x as isize, y as isize - 1)
                - sample(x as isize, y as isize + 1))
                / (cell_height * 2.0).max(0.001);
            let desired_angle = downhill_y.atan2(downhill_x);
            let gradient_length = downhill_x.hypot(downhill_y);
            let mut primary: Option<(usize, f64, f64)> = None;
            for next in neighbors8(x, y, width, height) {
                let next_x = next % width;
                let next_y = next / width;
                let dx = next_x as isize - x as isize;
                let dy = next_y as isize - y as isize;
                let distance = ((dx as f64 * cell_width).powi(2)
                    + (dy as f64 * cell_height).powi(2))
                .sqrt()
                .max(0.001);
                let water_target = water[next] != "land";
                let drop = filled[index] - filled[next];
                if !water_target && drop <= 0.0 {
                    continue;
                }
                let angle = (dy as f64 * cell_height).atan2(dx as f64 * cell_width);
                let alignment = if gradient_length > 0.000_001 {
                    (desired_angle - angle).cos().max(0.0)
                } else {
                    1.0
                };
                let slope = if water_target {
                    drop.max(0.25) / distance
                } else {
                    drop / distance
                };
                let tie_break = f64::from(hash(seed ^ 0x517c_c1b7, next as u32) & 0xffff)
                    / f64::from(u16::MAX)
                    * 0.000_001;
                let score = slope.max(0.000_001) * (0.18 + alignment * 0.82) + tie_break;
                let candidate = (next, score, angle);
                if primary.is_none_or(|current| {
                    candidate.1 > current.1
                        || (candidate.1.total_cmp(&current.1) == Ordering::Equal
                            && candidate.0 < current.0)
                }) {
                    primary = Some(candidate);
                }
            }
            let Some(primary) = primary else {
                continue;
            };
            let mut secondary: Option<(usize, f64, f64)> = None;
            for next in neighbors8(x, y, width, height) {
                if next == primary.0 {
                    continue;
                }
                let next_x = next % width;
                let next_y = next / width;
                let dx = next_x as isize - x as isize;
                let dy = next_y as isize - y as isize;
                let distance = ((dx as f64 * cell_width).powi(2)
                    + (dy as f64 * cell_height).powi(2))
                .sqrt()
                .max(0.001);
                let water_target = water[next] != "land";
                let drop = filled[index] - filled[next];
                if !water_target && drop <= 0.0 {
                    continue;
                }
                let angle = (dy as f64 * cell_height).atan2(dx as f64 * cell_width);
                let mut difference = (angle - primary.2).abs();
                if difference > std::f64::consts::PI {
                    difference = std::f64::consts::TAU - difference;
                }
                if difference > std::f64::consts::FRAC_PI_2 + 0.000_001 {
                    continue;
                }
                let alignment = if gradient_length > 0.000_001 {
                    (desired_angle - angle).cos().max(0.0)
                } else {
                    1.0
                };
                let slope = if water_target {
                    drop.max(0.25) / distance
                } else {
                    drop / distance
                };
                let tie_break = f64::from(hash(seed ^ 0x517c_c1b7, next as u32) & 0xffff)
                    / f64::from(u16::MAX)
                    * 0.000_001;
                let candidate = (
                    next,
                    slope.max(0.000_001) * (0.18 + alignment * 0.82) + tie_break,
                    angle,
                );
                if secondary.is_none_or(|current| {
                    candidate.1 > current.1
                        || (candidate.1.total_cmp(&current.1) == Ordering::Equal
                            && candidate.0 < current.0)
                }) {
                    secondary = Some(candidate);
                }
            }
            let total = primary.1 + secondary.map_or(0.0, |candidate| candidate.1);
            routing[index].targets[0] = Some(FlowTarget {
                index: primary.0,
                weight: if secondary.is_some() {
                    primary.1 / total.max(f64::EPSILON)
                } else {
                    1.0
                },
            });
            if let Some(secondary) = secondary {
                routing[index].targets[1] = Some(FlowTarget {
                    index: secondary.0,
                    weight: secondary.1 / total.max(f64::EPSILON),
                });
            }
        }
    }
    for route in lake_outlets {
        for pair in route.cells.windows(2) {
            if water.get(pair[0]).is_some_and(|kind| kind == "land") {
                routing[pair[0]] = FlowRoute {
                    targets: [
                        Some(FlowTarget {
                            index: pair[1],
                            weight: 1.0,
                        }),
                        None,
                    ],
                };
            }
        }
    }
    routing
}

fn primary_downstream(routing: &[FlowRoute]) -> Vec<Option<usize>> {
    routing.iter().map(|route| route.primary()).collect()
}

fn channelize_routing(routing: &mut [FlowRoute], channels: &[bool]) {
    for (index, route) in routing.iter_mut().enumerate() {
        if !channels.get(index).copied().unwrap_or(false) {
            continue;
        }
        let Some(primary) = route.targets[0] else {
            continue;
        };
        *route = FlowRoute {
            targets: [
                Some(FlowTarget {
                    index: primary.index,
                    weight: 1.0,
                }),
                None,
            ],
        };
    }
}

fn accumulate_weighted_flow(
    water: &[String],
    local_discharge: &[f64],
    routing: &[FlowRoute],
) -> Vec<f64> {
    let count = water.len().min(routing.len()).min(local_discharge.len());
    let mut incoming = vec![0_usize; count];
    for (index, route) in routing.iter().take(count).enumerate() {
        if water[index] != "land" {
            continue;
        }
        for target in route.targets.into_iter().flatten() {
            if target.index < count && water[target.index] == "land" {
                incoming[target.index] += 1;
            }
        }
    }
    let mut discharge = local_discharge[..count].to_vec();
    let mut queue = (0..count)
        .filter(|index| water[*index] == "land" && incoming[*index] == 0)
        .collect::<VecDeque<_>>();
    while let Some(index) = queue.pop_front() {
        for target in routing[index].targets.into_iter().flatten() {
            if target.index >= count {
                continue;
            }
            discharge[target.index] += discharge[index] * target.weight;
            if water[target.index] == "land" {
                incoming[target.index] = incoming[target.index].saturating_sub(1);
                if incoming[target.index] == 0 {
                    queue.push_back(target.index);
                }
            }
        }
    }
    discharge
}

#[allow(clippy::too_many_arguments)]
fn local_runoff_discharge(
    width: usize,
    height: usize,
    world_width: f32,
    world_height: f32,
    water: &[String],
    elevation: &[f32],
    terrain: &[String],
    precipitation: &[f32],
    runoff: &[f32],
    moisture: &[f32],
) -> Vec<f64> {
    const SECONDS_PER_YEAR: f64 = 31_557_600.0;
    let cell_area_km2 = f64::from(world_width) / width.max(1) as f64
        * (f64::from(world_height) / height.max(1) as f64);
    (0..width.saturating_mul(height))
        .map(|index| {
            if water.get(index).is_none_or(|kind| kind != "land") {
                return 0.0;
            }
            let x = index % width;
            let y = index / width;
            let landform =
                grid_landform_metrics(x, y, width, height, world_width, world_height, elevation);
            let infiltration = match terrain.get(index).map(String::as_str) {
                Some("forest" | "jungle") => 0.58,
                Some("grassland" | "farmland") => 0.46,
                Some("desert") => 0.68,
                Some("rock" | "mountain") => 0.22,
                Some("wetland") => 0.08,
                _ => 0.40,
            };
            let wetness = moisture.get(index).copied().unwrap_or(0.0).clamp(0.0, 1.0);
            let slope_runoff = (landform.slope_m_per_km / 700.0).clamp(0.0, 0.32);
            let baseflow_fraction = 0.018 + wetness as f64 * 0.065;
            let annual_mm = f64::from(runoff.get(index).copied().unwrap_or(0.0).max(0.0))
                + f64::from(precipitation.get(index).copied().unwrap_or(0.0).max(0.0))
                    * baseflow_fraction;
            let runoff_coefficient =
                (1.0 - infiltration + f64::from(slope_runoff)).clamp(0.12, 0.96);
            annual_mm * runoff_coefficient * cell_area_km2 * 1_000.0 / SECONDS_PER_YEAR
        })
        .collect()
}

#[allow(clippy::too_many_arguments)]
fn initiate_channels(
    width: usize,
    height: usize,
    world_width: f32,
    world_height: f32,
    water: &[String],
    elevation: &[f32],
    terrain: &[String],
    runoff: &[f32],
    moisture: &[f32],
    discharge: &[f64],
    downstream: &[Option<usize>],
    lake_outlets: &[LakeOutletRoute],
) -> Vec<bool> {
    let count = width.saturating_mul(height);
    let cell_area_km2 = f64::from(world_width) / width.max(1) as f64
        * (f64::from(world_height) / height.max(1) as f64);
    let source_cell_target = (count as f64 * 0.0015).clamp(12.0, 96.0);
    let minimum_basin_discharge =
        180.0 * cell_area_km2 * source_cell_target * 1_000.0 / 31_557_600.0;
    let forced = lake_outlets
        .iter()
        .flat_map(|route| route.cells.iter().copied())
        .collect::<HashSet<_>>();
    let mut seeds = Vec::new();
    for index in 0..count {
        if water.get(index).is_none_or(|kind| kind != "land") || downstream[index].is_none() {
            continue;
        }
        let x = index % width;
        let y = index / width;
        let slope =
            grid_landform_metrics(x, y, width, height, world_width, world_height, elevation)
                .slope_m_per_km;
        let dryness = (1.0 - runoff.get(index).copied().unwrap_or(0.0) / 620.0).clamp(0.0, 1.0);
        let wetness = moisture.get(index).copied().unwrap_or(0.0).clamp(0.0, 1.0);
        let permeability = match terrain.get(index).map(String::as_str) {
            Some("desert") => 0.26,
            Some("forest" | "jungle") => 0.18,
            Some("grassland" | "farmland") => 0.10,
            Some("wetland") => -0.18,
            Some("rock" | "mountain") => -0.12,
            _ => 0.04,
        };
        let slope_factor = (slope / 220.0).clamp(0.0, 0.35);
        let threshold = (0.07 + f64::from(dryness) * 0.34 + permeability
            - f64::from(wetness) * 0.10
            - f64::from(slope_factor))
        .clamp(0.025, 0.75)
        .max(minimum_basin_discharge);
        if forced.contains(&index) || discharge.get(index).copied().unwrap_or(0.0) >= threshold {
            seeds.push(index);
        }
    }
    let mut channels = vec![false; count];
    for seed in seeds {
        let mut current = seed;
        let mut steps = 0;
        while current < count && water[current] == "land" && steps < count {
            channels[current] = true;
            let Some(next) = downstream[current] else {
                break;
            };
            if next == current {
                break;
            }
            current = next;
            steps += 1;
        }
    }
    channels
}

fn channel_orders(
    channels: &[bool],
    downstream: &[Option<usize>],
    filled: &[f64],
) -> (Vec<u8>, Vec<u32>) {
    let count = channels.len().min(downstream.len()).min(filled.len());
    let mut indices = (0..count)
        .filter(|index| channels[*index])
        .collect::<Vec<_>>();
    indices.sort_by(|left, right| {
        filled[*right]
            .total_cmp(&filled[*left])
            .then_with(|| left.cmp(right))
    });
    let mut maximum_upstream_order = vec![0_u8; count];
    let mut maximum_order_count = vec![0_u8; count];
    let mut shreve = vec![0_u32; count];
    let mut strahler = vec![0_u8; count];
    for index in indices {
        let order = if maximum_upstream_order[index] == 0 {
            1
        } else if maximum_order_count[index] >= 2 {
            maximum_upstream_order[index].saturating_add(1)
        } else {
            maximum_upstream_order[index]
        };
        strahler[index] = order;
        shreve[index] = shreve[index].max(1);
        let Some(next) = downstream[index] else {
            continue;
        };
        if next >= count || !channels[next] {
            continue;
        }
        shreve[next] = shreve[next].saturating_add(shreve[index]);
        if order > maximum_upstream_order[next] {
            maximum_upstream_order[next] = order;
            maximum_order_count[next] = 1;
        } else if order == maximum_upstream_order[next] {
            maximum_order_count[next] = maximum_order_count[next].saturating_add(1);
        }
    }
    (strahler, shreve)
}

#[allow(clippy::too_many_arguments)]
fn apply_stream_power_erosion(
    width: usize,
    height: usize,
    world_width: f32,
    world_height: f32,
    water: &[String],
    filled: &[f64],
    downstream: &[Option<usize>],
    discharge: &[f64],
    channels: &[bool],
    elevation: &mut [f32],
) -> usize {
    let cell_width = f64::from(world_width) / width.max(1) as f64;
    let cell_height = f64::from(world_height) / height.max(1) as f64;
    let mut updates = Vec::new();
    for index in 0..channels.len().min(elevation.len()) {
        if !channels[index] || water[index] != "land" {
            continue;
        }
        let Some(next) = downstream[index] else {
            continue;
        };
        if next >= elevation.len() {
            continue;
        }
        let dx = (index % width).abs_diff(next % width) as f64 * cell_width;
        let dy = (index / width).abs_diff(next / width) as f64 * cell_height;
        let distance = dx.hypot(dy).max(0.001);
        let slope = ((filled[index] - filled[next]) / distance).max(0.0);
        if slope <= 0.0 {
            continue;
        }
        let q = discharge.get(index).copied().unwrap_or(0.0).max(0.000_1);
        let incision_m = (0.34 * q.powf(0.42) * slope.powf(0.48)).clamp(0.0, 18.0) as f32;
        let floor = if water[next] == "land" {
            elevation[next] + 0.02
        } else {
            elevation[next]
        };
        let lowered = (elevation[index] - incision_m).max(floor);
        if lowered + 0.001 < elevation[index] {
            updates.push((index, lowered));
        }
    }
    for (index, value) in &updates {
        elevation[*index] = *value;
    }
    updates.len()
}

fn hydraulic_width_km(discharge_m3s: f64, stream_order: u8, shreve: u32) -> f32 {
    let order_bonus = f64::from(stream_order.saturating_sub(1)) * 4.0;
    let magnitude_bonus = f64::from(shreve.max(1)).ln_1p() * 1.8;
    ((22.0 * discharge_m3s.max(0.000_1).powf(0.47) + order_bonus + magnitude_bonus)
        .clamp(50.0, 10_000.0)
        / 1_000.0) as f32
}

#[allow(clippy::too_many_arguments)]
fn build_current_river_geometry(
    map: &NativeMap,
    filled: &[f64],
    flow: &[f64],
    downstream: &[Option<usize>],
    channels: &[bool],
    stream_order: &[u8],
    shreve_magnitude: &[u32],
    routing: &[FlowRoute],
    lake_outlets: &[LakeOutletRoute],
    region_center: PlanetPosition,
) -> (
    Vec<RiverSegment>,
    HydrologyGeometryStats,
    Option<PhysicalAnalysisMetrics>,
) {
    let routes = routing
        .iter()
        .map(|route| ContinuousFlowRoute {
            targets: route.targets.map(|target| {
                target.map(|target| ContinuousFlowTarget {
                    index: target.index,
                    weight: target.weight,
                })
            }),
        })
        .collect::<Vec<_>>();
    let settings = map.generation_settings.as_ref();
    let identity = HydrologyWorldIdentity {
        parent_seed: settings
            .map(|settings| settings.parent_world_seed)
            .filter(|seed| *seed != 0)
            .unwrap_or_else(|| u64::from(map.environment_seed)),
        region_center,
        selection_bearing_deg: settings.map_or(0.0, |settings| settings.selection_bearing_deg),
        planet_radius_m: settings
            .map_or(6_371_000.0, |settings| settings.parent_planet_radius_m)
            .max(1.0),
    };
    let (geometry, physical_metrics) = if map.canonical_surface.is_some() {
        if let Some(sampler) =
            MultiresolutionPhysicalSurface::build(map, filled, flow, downstream, channels)
        {
            let metrics = sampler.metrics().clone();
            (
                build_subcell_hydrology(&SubcellHydrologyInput {
                    width: map.grid_width,
                    height: map.grid_height,
                    world_width_km: map.width,
                    world_height_km: map.height,
                    identity,
                    water: &map.water,
                    filled_elevation: filled,
                    terrain: &map.terrain,
                    flow,
                    downstream,
                    channels,
                    routing: &routes,
                    surface: &sampler,
                    apply_parent_conditioning: false,
                    reconcile_local_topology: false,
                }),
                Some(metrics),
            )
        } else {
            let surface = map.canonical_surface.as_deref().expect("surface checked");
            let sampler = CanonicalHydrologySurface::new(surface, map.width, map.height);
            (
                build_subcell_hydrology(&SubcellHydrologyInput {
                    width: map.grid_width,
                    height: map.grid_height,
                    world_width_km: map.width,
                    world_height_km: map.height,
                    identity,
                    water: &map.water,
                    filled_elevation: filled,
                    terrain: &map.terrain,
                    flow,
                    downstream,
                    channels,
                    routing: &routes,
                    surface: &sampler,
                    apply_parent_conditioning: true,
                    reconcile_local_topology: false,
                }),
                None,
            )
        }
    } else {
        let sampler = AnalysisHydrologySurface::new(
            map.grid_width,
            map.grid_height,
            map.width,
            map.height,
            &map.elevation,
            &map.terrain,
            &map.water,
        );
        (
            build_subcell_hydrology(&SubcellHydrologyInput {
                width: map.grid_width,
                height: map.grid_height,
                world_width_km: map.width,
                world_height_km: map.height,
                identity,
                water: &map.water,
                filled_elevation: filled,
                terrain: &map.terrain,
                flow,
                downstream,
                channels,
                routing: &routes,
                surface: &sampler,
                apply_parent_conditioning: true,
                reconcile_local_topology: false,
            }),
            None,
        )
    };
    let mut rivers = river_segments_from_subcell(&geometry, flow, stream_order, shreve_magnitude);
    append_lake_outlet_segments(
        map,
        lake_outlets,
        &geometry,
        flow,
        stream_order,
        shreve_magnitude,
        &mut rivers,
    );
    (rivers, geometry.stats, physical_metrics)
}

fn physical_metrics_detail(metrics: &PhysicalAnalysisMetrics) -> String {
    format!(
        "revision={}, patches={} (L1={}, L2={}), refined_cells={}, local_hydrology_cells={}, importance_ms={:.3}, patch_ms={:.3}, total_ms={:.3}, peak_scratch_bytes={}, parent_delta_mean_m={:.3}, parent_delta_max_m={:.3}, gradient_gt45={}, gradient_gt90={}, saddle_disagreement={}, downsample_rmse_m={:.3}, downsample_max_m={:.3}, max_parent_conditioning_m={:.3}, max_parent_conditioning_cell={}, cause={}, budget_limited={}, cache_key={}",
        metrics.revision,
        metrics.patch_count,
        metrics.l1_patches,
        metrics.l2_patches,
        metrics.refined_cells,
        metrics.local_hydrology_cells,
        metrics.importance_field_ms,
        metrics.patch_build_ms,
        metrics.total_ms,
        metrics.peak_scratch_bytes,
        metrics.canonical_parent_mean_abs_delta_m,
        metrics.canonical_parent_max_abs_delta_m,
        metrics.gradient_disagreement_over_45,
        metrics.gradient_disagreement_over_90,
        metrics.saddle_disagreement_count,
        metrics.downsample_rmse_m,
        metrics.downsample_max_error_m,
        metrics.max_parent_conditioning_m,
        metrics.max_parent_conditioning_cell,
        metrics.max_parent_conditioning_cause,
        metrics.budget_limited,
        metrics.cache_key,
    )
}

fn river_segments_from_subcell(
    geometry: &SubcellHydrologyGeometry,
    flow: &[f64],
    stream_order: &[u8],
    shreve_magnitude: &[u32],
) -> Vec<RiverSegment> {
    let mut rivers = Vec::new();
    for path in &geometry.paths {
        if path.points.len() < 2 {
            continue;
        }
        let current_discharge = flow
            .get(path.from_cell)
            .copied()
            .unwrap_or(0.000_1)
            .max(0.000_1);
        let next_discharge = flow
            .get(path.to_cell)
            .copied()
            .unwrap_or(current_discharge)
            .max(current_discharge);
        let current_order = stream_order
            .get(path.from_cell)
            .copied()
            .unwrap_or(1)
            .max(1);
        let next_order = stream_order
            .get(path.to_cell)
            .copied()
            .unwrap_or(current_order)
            .max(current_order);
        let current_shreve = shreve_magnitude
            .get(path.from_cell)
            .copied()
            .unwrap_or(1)
            .max(1);
        let next_shreve = shreve_magnitude
            .get(path.to_cell)
            .copied()
            .unwrap_or(current_shreve)
            .max(current_shreve);
        let count = path.points.len().saturating_sub(1).max(1);
        for (index, pair) in path.points.windows(2).enumerate() {
            let t = (index as f32 + 0.5) / count as f32;
            let discharge = current_discharge + (next_discharge - current_discharge) * f64::from(t);
            let order = if t < 0.5 { current_order } else { next_order };
            let shreve = if t < 0.5 { current_shreve } else { next_shreve };
            rivers.push(RiverSegment {
                start: pair[0],
                end: pair[1],
                width: hydraulic_width_km(discharge, order, shreve),
                discharge: discharge as f32,
                stream_order: order,
            });
        }
    }
    rivers
}

fn append_lake_outlet_segments(
    map: &NativeMap,
    lake_outlets: &[LakeOutletRoute],
    geometry: &SubcellHydrologyGeometry,
    flow: &[f64],
    stream_order: &[u8],
    shreve_magnitude: &[u32],
    rivers: &mut Vec<RiverSegment>,
) {
    let Some(surface) = map.canonical_surface.as_deref() else {
        return;
    };
    let cell_width = map.width / map.grid_width.max(1) as f32;
    let cell_height = map.height / map.grid_height.max(1) as f32;
    let center = |index: usize| Point {
        x: (index % map.grid_width) as f32 * cell_width + cell_width * 0.5,
        y: (index / map.grid_width) as f32 * cell_height + cell_height * 0.5,
    };
    let is_land = |point: Point| canonical_land_at(surface, map.width, map.height, point);
    for route in lake_outlets {
        let Some(&first_land) = route.cells.first() else {
            continue;
        };
        if map
            .water
            .get(first_land)
            .is_none_or(|water| water != "land")
        {
            continue;
        }
        let land_anchor = geometry
            .cell_anchors
            .get(first_land)
            .copied()
            .flatten()
            .unwrap_or_else(|| center(first_land));
        let lake_center = center(route.lake_index);
        let Some((land_start, shoreline)) = land_intervals(
            land_anchor,
            lake_center,
            1.0 / NativeMap::LOGICAL_PIXELS_PER_KM,
            &is_land,
        )
        .into_iter()
        .next() else {
            continue;
        };
        let discharge = flow.get(first_land).copied().unwrap_or(0.1).max(0.000_1);
        let order = stream_order.get(first_land).copied().unwrap_or(1).max(1);
        let shreve = shreve_magnitude
            .get(first_land)
            .copied()
            .unwrap_or(1)
            .max(1);
        rivers.push(RiverSegment {
            start: shoreline,
            end: land_start,
            width: hydraulic_width_km(discharge, order, shreve),
            discharge: discharge as f32,
            stream_order: order,
        });
    }
}

fn hydrology_stats_detail(stats: &HydrologyGeometryStats) -> String {
    format!(
        "routing_cells={}, channel_cells={}, refined_channel_cells={}, locally_conditioned_channel_cells={}, raw_uphill_violations={}, conditioned_uphill_violations={}, profile_conditioning_max_raise_m={:.3}, micro_samples={}, river_nodes={}, geometry_build_ms={:.3}, peak_scratch_bytes={}, fallbacks={}",
        stats.routing_cells,
        stats.channel_cells,
        stats.refined_channel_cells,
        stats.locally_conditioned_channel_cells,
        stats.raw_uphill_violations,
        stats.conditioned_uphill_violations,
        stats.profile_conditioning_max_raise_m,
        stats.micro_samples,
        stats.river_nodes,
        stats.geometry_build_ms,
        stats.peak_scratch_bytes,
        stats.fallback_count,
    )
}

#[allow(clippy::too_many_arguments)]
fn build_legacy_rivers(
    width: usize,
    height: usize,
    world_width: f32,
    world_height: f32,
    water: &[String],
    elevation: &[f32],
    flow: &[f64],
    downstream: &[Option<usize>],
    channels: &[bool],
    stream_order: &[u8],
    shreve_magnitude: &[u32],
    lake_outlets: &[LakeOutletRoute],
) -> Vec<RiverSegment> {
    let forced_cells = lake_outlets
        .iter()
        .flat_map(|route| route.cells.iter().copied())
        .filter(|index| water.get(*index).is_some_and(|kind| kind == "land"))
        .collect::<HashSet<_>>();
    let cell_width = world_width / width as f32;
    let cell_height = world_height / height as f32;
    let center = |index: usize| Point {
        x: (index % width) as f32 * cell_width + cell_width * 0.5,
        y: (index / width) as f32 * cell_height + cell_height * 0.5,
    };
    let mut primary_upstream = vec![None; water.len()];
    for (upstream, next) in downstream.iter().copied().enumerate() {
        let Some(next) = next else { continue };
        if channels.get(upstream).copied().unwrap_or(false)
            && channels.get(next).copied().unwrap_or(false)
            && primary_upstream[next].is_none_or(|current| flow[upstream] > flow[current])
        {
            primary_upstream[next] = Some(upstream);
        }
    }
    let mut river_nodes = vec![None; water.len()];
    for index in 0..water.len() {
        let Some(next) = downstream[index] else {
            continue;
        };
        if water[index] != "land" || !channels.get(index).copied().unwrap_or(false) {
            continue;
        }
        let base = center(index);
        let target = center(next);
        let upstream = primary_upstream[index].map(center).unwrap_or(Point {
            x: base.x - (target.x - base.x),
            y: base.y - (target.y - base.y),
        });
        let smoothed = Point {
            x: (base.x * 0.72 + (upstream.x + target.x) * 0.14).clamp(0.0, world_width),
            y: (base.y * 0.72 + (upstream.y + target.y) * 0.14).clamp(0.0, world_height),
        };
        river_nodes[index] = Some(
            if river_point_allowed(
                smoothed,
                index,
                next,
                width,
                height,
                world_width,
                world_height,
                water,
                elevation,
            ) {
                smoothed
            } else {
                base
            },
        );
    }
    let mut rivers = Vec::new();
    for index in 0..water.len() {
        let Some(next) = downstream[index] else {
            continue;
        };
        if water[index] != "land"
            || (!channels.get(index).copied().unwrap_or(false) && !forced_cells.contains(&index))
        {
            continue;
        }
        let current_discharge = flow[index].max(0.000_1);
        let next_discharge = flow[next].max(current_discharge);
        let current_order = stream_order.get(index).copied().unwrap_or(1).max(1);
        let next_order = stream_order
            .get(next)
            .copied()
            .unwrap_or(current_order)
            .max(current_order);
        let current_shreve = shreve_magnitude.get(index).copied().unwrap_or(1).max(1);
        let next_shreve = shreve_magnitude
            .get(next)
            .copied()
            .unwrap_or(current_shreve)
            .max(current_shreve);
        let p1 = river_nodes[index].unwrap_or_else(|| center(index));
        let p2 = river_nodes[next].unwrap_or_else(|| center(next));
        let p0 = primary_upstream[index]
            .map(|upstream| river_nodes[upstream].unwrap_or_else(|| center(upstream)))
            .unwrap_or_else(|| Point {
                x: p1.x - (p2.x - p1.x),
                y: p1.y - (p2.y - p1.y),
            });
        let p3 = downstream[next]
            .map(|downstream| river_nodes[downstream].unwrap_or_else(|| center(downstream)))
            .unwrap_or_else(|| Point {
                x: p2.x + (p2.x - p1.x),
                y: p2.y + (p2.y - p1.y),
            });
        let distance = ((p2.x - p1.x).powi(2) + (p2.y - p1.y).powi(2)).sqrt();
        let target_step = (cell_width.min(cell_height) * 0.22).clamp(0.05, 2.5);
        let subdivisions = (distance / target_step).ceil().clamp(3.0, 18.0) as usize;
        let points = (0..=subdivisions)
            .map(|step| {
                let t = step as f32 / subdivisions as f32;
                if step == 0 {
                    return p1;
                }
                if step == subdivisions {
                    return p2;
                }
                let base = catmull_rom(p0, p1, p2, p3, t);
                if river_point_allowed(
                    base,
                    index,
                    next,
                    width,
                    height,
                    world_width,
                    world_height,
                    water,
                    elevation,
                ) {
                    base
                } else {
                    Point {
                        x: p1.x + (p2.x - p1.x) * t,
                        y: p1.y + (p2.y - p1.y) * t,
                    }
                }
            })
            .collect::<Vec<_>>();
        for (segment_index, points) in points.windows(2).enumerate() {
            let t = (segment_index as f32 + 0.5) / subdivisions as f32;
            let discharge = current_discharge + (next_discharge - current_discharge) * t as f64;
            let order = if t < 0.5 { current_order } else { next_order };
            let shreve = if t < 0.5 { current_shreve } else { next_shreve };
            rivers.push(RiverSegment {
                start: points[0],
                end: points[1],
                width: hydraulic_width_km(discharge, order, shreve),
                discharge: discharge as f32,
                stream_order: order,
            });
        }
    }
    for route in lake_outlets {
        let Some(&first_land) = route.cells.first() else {
            continue;
        };
        if water.get(first_land).is_none_or(|kind| kind != "land") {
            continue;
        }
        let lake_center = center(route.lake_index);
        let land_center = river_nodes[first_land].unwrap_or_else(|| center(first_land));
        let boundary = Point {
            x: (lake_center.x + center(first_land).x) * 0.5,
            y: (lake_center.y + center(first_land).y) * 0.5,
        };
        rivers.push(RiverSegment {
            start: boundary,
            end: land_center,
            width: hydraulic_width_km(
                flow.get(first_land).copied().unwrap_or(0.1),
                stream_order.get(first_land).copied().unwrap_or(1).max(1),
                shreve_magnitude
                    .get(first_land)
                    .copied()
                    .unwrap_or(1)
                    .max(1),
            ),
            discharge: flow.get(first_land).copied().unwrap_or(0.1) as f32,
            stream_order: stream_order.get(first_land).copied().unwrap_or(1).max(1),
        });
    }
    rivers
}

#[allow(clippy::too_many_arguments)]
fn river_point_allowed(
    point: Point,
    from: usize,
    to: usize,
    width: usize,
    height: usize,
    world_width: f32,
    world_height: f32,
    water: &[String],
    elevation: &[f32],
) -> bool {
    if !point.x.is_finite()
        || !point.y.is_finite()
        || point.x < 0.0
        || point.y < 0.0
        || point.x > world_width
        || point.y > world_height
    {
        return false;
    }
    let x = (point.x / world_width.max(f32::EPSILON) * width as f32)
        .floor()
        .clamp(0.0, width.saturating_sub(1) as f32) as usize;
    let y = (point.y / world_height.max(f32::EPSILON) * height as f32)
        .floor()
        .clamp(0.0, height.saturating_sub(1) as f32) as usize;
    let index = y * width + x;
    if water
        .get(index)
        .is_some_and(|kind| kind != "land" && index != to)
    {
        return false;
    }
    let upper = elevation[from].max(elevation[to]) + 90.0;
    elevation.get(index).is_some_and(|value| *value <= upper)
}

/// Replays the hydrology and river geometry stages without mutating the map.
/// This is deliberately diagnostic-only: it calls the same stage functions and
/// preserves every production parameter so exported lineage data can be
/// compared with the authoritative stored result.
pub(crate) fn replay_pipeline_diagnostics(
    map: &NativeMap,
    combined_preconditioning_elevation: &[f32],
) -> Result<PipelineDiagnosticReplay, String> {
    let replay_started = Instant::now();
    let width = map.grid_width;
    let height = map.grid_height;
    let count = width.saturating_mul(height);
    if count == 0
        || combined_preconditioning_elevation.len() != count
        || map.water.len() != count
        || map.terrain.len() != count
    {
        return Err("diagnostic replay inputs do not match the analysis grid".to_owned());
    }

    let mut pre_erosion_elevation = combined_preconditioning_elevation.to_vec();
    let lake_outlets =
        build_lake_outlet_routes(width, height, &mut pre_erosion_elevation, &map.water);
    let mut filled = priority_flood(width, height, &pre_erosion_elevation, &map.water);
    let priority_flood_elevation = filled.iter().map(|value| *value as f32).collect::<Vec<_>>();
    let local_discharge = local_runoff_discharge(
        width,
        height,
        map.width,
        map.height,
        &map.water,
        &pre_erosion_elevation,
        &map.terrain,
        &map.precipitation,
        &map.runoff,
        &map.moisture,
    );
    let seed = map.environment_seed;
    let mut routing = build_d_infinity_routing(
        seed,
        width,
        height,
        map.width,
        map.height,
        &filled,
        &map.water,
        &lake_outlets,
    );
    let mut flow = accumulate_weighted_flow(&map.water, &local_discharge, &routing);
    let mut downstream = primary_downstream(&routing);
    let mut channels = initiate_channels(
        width,
        height,
        map.width,
        map.height,
        &map.water,
        &pre_erosion_elevation,
        &map.terrain,
        &map.runoff,
        &map.moisture,
        &flow,
        &downstream,
        &lake_outlets,
    );
    let mut geometry_routing = routing.clone();
    channelize_routing(&mut routing, &channels);
    flow = accumulate_weighted_flow(&map.water, &local_discharge, &routing);

    let mut post_erosion_elevation = pre_erosion_elevation.clone();
    let eroded_cells = apply_stream_power_erosion(
        width,
        height,
        map.width,
        map.height,
        &map.water,
        &filled,
        &downstream,
        &flow,
        &channels,
        &mut post_erosion_elevation,
    );
    if eroded_cells > 0 {
        filled = priority_flood(width, height, &post_erosion_elevation, &map.water);
        routing = build_d_infinity_routing(
            seed,
            width,
            height,
            map.width,
            map.height,
            &filled,
            &map.water,
            &lake_outlets,
        );
        flow = accumulate_weighted_flow(&map.water, &local_discharge, &routing);
        downstream = primary_downstream(&routing);
        channels = initiate_channels(
            width,
            height,
            map.width,
            map.height,
            &map.water,
            &post_erosion_elevation,
            &map.terrain,
            &map.runoff,
            &map.moisture,
            &flow,
            &downstream,
            &lake_outlets,
        );
        geometry_routing = routing.clone();
        channelize_routing(&mut routing, &channels);
        flow = accumulate_weighted_flow(&map.water, &local_discharge, &routing);
    }

    let (stream_order, shreve_magnitude) = channel_orders(&channels, &downstream, &filled);
    let legacy_started = Instant::now();
    let legacy_segments = build_legacy_rivers(
        width,
        height,
        map.width,
        map.height,
        &map.water,
        &post_erosion_elevation,
        &flow,
        &downstream,
        &channels,
        &stream_order,
        &shreve_magnitude,
        &lake_outlets,
    );
    let legacy_geometry_build_ms = legacy_started.elapsed().as_secs_f64() * 1_000.0;
    let region_center = map
        .generation_settings
        .as_ref()
        .map(|settings| {
            PlanetPosition::from_latitude_longitude_deg(
                settings.center_latitude_deg,
                settings.center_longitude_deg,
            )
        })
        .unwrap_or_else(|| PlanetPosition::from_latitude_longitude_deg(0.0, 0.0));
    let (spline_segments, hydrology_geometry_stats, physical_analysis_metrics) =
        build_current_river_geometry(
            map,
            &filled,
            &flow,
            &downstream,
            &channels,
            &stream_order,
            &shreve_magnitude,
            &geometry_routing,
            &lake_outlets,
            region_center,
        );
    let graph_started = Instant::now();
    let graph_segments = RiverGraph::from_segments_with_revision(
        &map.source_id,
        &spline_segments,
        false,
        CURRENT_HYDROLOGY_GEOMETRY_VERSION,
    )
    .to_segments();
    let river_graph_build_ms = graph_started.elapsed().as_secs_f64() * 1_000.0;
    let final_segments = if map.rivers.is_empty() {
        map.river_graph.to_segments()
    } else {
        map.rivers.clone()
    };
    let flow_targets = routing
        .iter()
        .enumerate()
        .flat_map(|(from, route)| {
            route
                .targets
                .into_iter()
                .flatten()
                .map(move |target| DiagnosticFlowTarget {
                    from,
                    to: target.index,
                    weight: target.weight,
                })
        })
        .collect::<Vec<_>>();
    let cell_width = map.width / width.max(1) as f32;
    let cell_height = map.height / height.max(1) as f32;
    let center = |index: usize| Point {
        x: (index % width) as f32 * cell_width + cell_width * 0.5,
        y: (index / width) as f32 * cell_height + cell_height * 0.5,
    };
    let channel_cell_segments = downstream
        .iter()
        .copied()
        .enumerate()
        .filter_map(|(from, to)| {
            let to = to?;
            channels
                .get(from)
                .copied()
                .unwrap_or(false)
                .then_some((center(from), center(to)))
        })
        .collect::<Vec<_>>();
    let subcell_segments = spline_segments
        .iter()
        .map(|segment| (segment.start, segment.end))
        .collect();
    Ok(PipelineDiagnosticReplay {
        width,
        height,
        pre_erosion_elevation,
        priority_flood_elevation,
        post_erosion_elevation: post_erosion_elevation.clone(),
        final_analysis_elevation: map.elevation.clone(),
        flow_targets,
        flow_accumulation: flow,
        downstream,
        channels,
        channel_cell_segments,
        subcell_segments,
        legacy_segments,
        spline_segments,
        graph_segments,
        final_segments,
        eroded_cells,
        lake_outlet_count: lake_outlets.len(),
        hydrology_geometry_stats,
        physical_analysis_metrics,
        legacy_geometry_build_ms,
        river_graph_build_ms,
        replay_total_ms: replay_started.elapsed().as_secs_f64() * 1_000.0,
    })
}

fn catmull_rom(p0: Point, p1: Point, p2: Point, p3: Point, t: f32) -> Point {
    let t2 = t * t;
    let t3 = t2 * t;
    let coordinate = |a: f32, b: f32, c: f32, d: f32| {
        0.5 * ((2.0 * b)
            + (-a + c) * t
            + (2.0 * a - 5.0 * b + 4.0 * c - d) * t2
            + (-a + 3.0 * b - 3.0 * c + d) * t3)
    };
    Point {
        x: coordinate(p0.x, p1.x, p2.x, p3.x),
        y: coordinate(p0.y, p1.y, p2.y, p3.y),
    }
}

fn generate_roads(
    width: usize,
    height: usize,
    world_width: f32,
    world_height: f32,
    water: &[String],
    elevation: &[f32],
    locations: &[Location],
) -> Vec<PathLine> {
    if locations.len() < 2 {
        return Vec::new();
    }
    let cells = locations
        .iter()
        .filter_map(|location| location.states.first())
        .map(|state| {
            let x = (state.position.x / world_width * width as f32)
                .floor()
                .clamp(0.0, width.saturating_sub(1) as f32) as usize;
            let y = (state.position.y / world_height * height as f32)
                .floor()
                .clamp(0.0, height.saturating_sub(1) as f32) as usize;
            y * width + x
        })
        .collect::<Vec<_>>();
    let mut edges = Vec::new();
    let mut connected = vec![false; cells.len()];
    connected[0] = true;
    while connected.iter().any(|value| !*value) {
        let mut next = None;
        for (from_index, &from) in cells.iter().enumerate() {
            if !connected[from_index] {
                continue;
            }
            for (to_index, &to) in cells.iter().enumerate() {
                if connected[to_index] {
                    continue;
                }
                let candidate = (
                    grid_distance_squared(from, to, width),
                    from_index,
                    to_index,
                    from,
                    to,
                );
                if next.is_none_or(|current: (usize, usize, usize, usize, usize)| {
                    candidate.0 < current.0
                }) {
                    next = Some(candidate);
                }
            }
        }
        let Some((_, _, to_index, from, to)) = next else {
            break;
        };
        connected[to_index] = true;
        edges.push((from, to));
    }
    for (index, &from) in cells.iter().enumerate() {
        if let Some(&to) = cells
            .iter()
            .enumerate()
            .filter(|(other, _)| *other != index)
            .min_by_key(|(_, candidate)| grid_distance_squared(from, **candidate, width))
            .map(|(_, value)| value)
        {
            let pair = if from < to { (from, to) } else { (to, from) };
            if !edges.iter().any(|&(left, right)| {
                let edge = if left < right {
                    (left, right)
                } else {
                    (right, left)
                };
                edge == pair
            }) {
                edges.push(pair);
            }
        }
    }
    edges
        .into_iter()
        .filter_map(|(start, goal)| {
            shortest_land_path(width, height, water, elevation, start, goal)
        })
        .map(|path| {
            let raw = path
                .into_iter()
                .map(|index| Point {
                    x: (index % width) as f32 * world_width / width as f32
                        + world_width / width as f32 * 0.5,
                    y: (index / width) as f32 * world_height / height as f32
                        + world_height / height as f32 * 0.5,
                })
                .collect::<Vec<_>>();
            PathLine {
                nodes: smooth_generated_road(&raw, width, height, world_width, world_height, water),
            }
        })
        .collect()
}

fn smooth_generated_road(
    raw: &[Point],
    width: usize,
    height: usize,
    world_width: f32,
    world_height: f32,
    water: &[String],
) -> Vec<Point> {
    if raw.len() < 3 {
        return raw.to_vec();
    }
    let mut simplified = vec![raw[0]];
    for points in raw.windows(3) {
        let ab = (points[1].x - points[0].x, points[1].y - points[0].y);
        let bc = (points[2].x - points[1].x, points[2].y - points[1].y);
        let cross = ab.0 * bc.1 - ab.1 * bc.0;
        if cross.abs() > 0.000_1 {
            simplified.push(points[1]);
        }
    }
    simplified.push(*raw.last().unwrap_or(&raw[0]));
    let mut smoothed = simplified;
    for _ in 0..2 {
        if smoothed.len() < 3 {
            break;
        }
        let mut next = Vec::with_capacity(smoothed.len() * 2);
        next.push(smoothed[0]);
        for segment in smoothed.windows(2) {
            next.push(Point {
                x: segment[0].x * 0.75 + segment[1].x * 0.25,
                y: segment[0].y * 0.75 + segment[1].y * 0.25,
            });
            next.push(Point {
                x: segment[0].x * 0.25 + segment[1].x * 0.75,
                y: segment[0].y * 0.25 + segment[1].y * 0.75,
            });
        }
        next.push(*smoothed.last().unwrap_or(&smoothed[0]));
        smoothed = next;
    }
    if smoothed.windows(2).all(|segment| {
        (0..=4).all(|step| {
            let t = step as f32 / 4.0;
            let point = Point {
                x: segment[0].x + (segment[1].x - segment[0].x) * t,
                y: segment[0].y + (segment[1].y - segment[0].y) * t,
            };
            let x = (point.x / world_width * width as f32)
                .floor()
                .clamp(0.0, width.saturating_sub(1) as f32) as usize;
            let y = (point.y / world_height * height as f32)
                .floor()
                .clamp(0.0, height.saturating_sub(1) as f32) as usize;
            water
                .get(y * width + x)
                .is_some_and(|value| value == "land")
        })
    }) {
        smoothed
    } else {
        raw.to_vec()
    }
}

fn shortest_land_path(
    width: usize,
    height: usize,
    water: &[String],
    elevation: &[f32],
    start: usize,
    goal: usize,
) -> Option<Vec<usize>> {
    let mut distance = vec![f64::INFINITY; width * height];
    let mut previous = vec![None; width * height];
    let mut heap = BinaryHeap::new();
    distance[start] = 0.0;
    heap.push(HeapCell {
        elevation: 0.0,
        index: start,
    });
    while let Some(cell) = heap.pop() {
        let cost = cell.elevation;
        if cell.index == goal {
            break;
        }
        if cost > distance[cell.index] + f64::EPSILON {
            continue;
        }
        let x = cell.index % width;
        let y = cell.index / width;
        for next in neighbors8(x, y, width, height) {
            if water[next] != "land" {
                continue;
            }
            let slope = (elevation[next] - elevation[cell.index]).abs() as f64 / 1_000.0;
            let nx = next % width;
            let ny = next / width;
            let step_distance = if nx != x && ny != y {
                std::f64::consts::SQRT_2
            } else {
                1.0
            };
            let candidate = cost + step_distance + slope * 3.5;
            if candidate < distance[next] {
                distance[next] = candidate;
                previous[next] = Some(cell.index);
                heap.push(HeapCell {
                    elevation: candidate,
                    index: next,
                });
            }
        }
    }
    if !distance[goal].is_finite() {
        return None;
    }
    let mut path = vec![goal];
    let mut cursor = goal;
    while cursor != start {
        cursor = previous[cursor]?;
        path.push(cursor);
    }
    path.reverse();
    Some(path)
}

fn regional_terrain_from_planet(terrain: u8, landform: LandformMetrics) -> &'static str {
    use crate::spatial::PlanetSurface;

    if landform.slope_m_per_km > 520.0 || landform.local_relief_m > 1_100.0 {
        return "mountain";
    }
    if landform.slope_m_per_km > 320.0 || landform.local_relief_m > 620.0 {
        return "rock";
    }
    match terrain {
        PlanetSurface::TERRAIN_ICE => "snow",
        PlanetSurface::TERRAIN_TUNDRA => "tundra",
        PlanetSurface::TERRAIN_DESERT => "desert",
        PlanetSurface::TERRAIN_GRASSLAND => "grassland",
        PlanetSurface::TERRAIN_FOREST => "forest",
        PlanetSurface::TERRAIN_RAINFOREST => "jungle",
        PlanetSurface::TERRAIN_HIGHLAND => "rock",
        PlanetSurface::TERRAIN_MOUNTAIN => "mountain",
        _ => "plain",
    }
}

fn classify_terrain(
    temperature: f64,
    precipitation: f64,
    moisture: f64,
    aridity_index: f64,
    hydrologic_saturation: f64,
    climate: KoppenClimate,
    noise: f64,
    ocean_distance: usize,
    landform: LandformMetrics,
) -> &'static str {
    if let Some(terrain) = classify_landform(landform, noise as f32, moisture as f32) {
        return terrain;
    }
    if temperature < -5.0 {
        return "snow";
    }
    if (precipitation < 260.0 || aridity_index < 0.24) && moisture < 0.34 {
        return "desert";
    }
    if hydrologic_saturation > 0.62
        && moisture > 0.55
        && landform.local_relief_m < 160.0
        && ocean_distance > 1
    {
        return "wetland";
    }
    if temperature > 22.0 && moisture > 0.68 && noise > 0.45 {
        return "jungle";
    }
    if moisture + terrain_climate_bias(climate, "forest") as f64 > 0.55
        && noise > 0.42
        && ocean_distance > 2
    {
        return "forest";
    }
    if landform.local_relief_m < 180.0 && moisture > 0.42 && noise > 0.63 {
        return "farmland";
    }
    if moisture < 0.48 {
        "grassland"
    } else {
        "plain"
    }
}

fn grid_landform_metrics(
    x: usize,
    y: usize,
    width: usize,
    height: usize,
    world_width: f32,
    world_height: f32,
    elevation: &[f32],
) -> LandformMetrics {
    let sample = |offset_x: isize, offset_y: isize| {
        let sample_x = (x as isize + offset_x).clamp(0, width.saturating_sub(1) as isize) as usize;
        let sample_y = (y as isize + offset_y).clamp(0, height.saturating_sub(1) as isize) as usize;
        elevation
            .get(sample_y * width.max(1) + sample_x)
            .copied()
            .unwrap_or(0.0)
    };
    let center = sample(0, 0);
    let east = sample(1, 0);
    let west = sample(-1, 0);
    let south = sample(0, 1);
    let north = sample(0, -1);
    let cell_width_km = world_width / width.max(1) as f32;
    let cell_height_km = world_height / height.max(1) as f32;
    let slope_x = (east - west) / (cell_width_km * 2.0).max(0.1);
    let slope_y = (south - north) / (cell_height_km * 2.0).max(0.1);
    let mut local_min = center;
    let mut local_max = center;
    for offset_y in -1..=1 {
        for offset_x in -1..=1 {
            let value = sample(offset_x, offset_y);
            local_min = local_min.min(value);
            local_max = local_max.max(value);
        }
    }
    let broad = [sample(3, 0), sample(-3, 0), sample(0, 3), sample(0, -3)];
    let broad_mean = broad.into_iter().sum::<f32>() / broad.len() as f32;
    let local_relief = local_max - local_min;
    let curvature = center - (east + west + south + north) * 0.25;
    LandformMetrics {
        slope_m_per_km: slope_x.hypot(slope_y),
        local_relief_m: local_relief,
        prominence_m: center - broad_mean,
        curvature_m: curvature,
        ridge: (curvature.max(0.0) / local_relief.max(1.0)).clamp(0.0, 1.0),
        roughness: (local_relief / 900.0).clamp(0.0, 1.0),
    }
}

fn orthogonal_neighbors(x: usize, y: usize, width: usize, height: usize) -> Vec<usize> {
    let mut values = Vec::with_capacity(4);
    if x > 0 {
        values.push(y * width + x - 1);
    }
    if x + 1 < width {
        values.push(y * width + x + 1);
    }
    if y > 0 {
        values.push((y - 1) * width + x);
    }
    if y + 1 < height {
        values.push((y + 1) * width + x);
    }
    values
}

fn neighbors8(x: usize, y: usize, width: usize, height: usize) -> Vec<usize> {
    let mut values = Vec::with_capacity(8);
    for dy in -1_i32..=1 {
        for dx in -1_i32..=1 {
            if dx == 0 && dy == 0 {
                continue;
            }
            let nx = x as i32 + dx;
            let ny = y as i32 + dy;
            if nx >= 0 && ny >= 0 && nx < width as i32 && ny < height as i32 {
                values.push(ny as usize * width + nx as usize);
            }
        }
    }
    values
}

fn grid_distance_squared(left: usize, right: usize, width: usize) -> usize {
    let lx = left % width;
    let ly = left / width;
    let rx = right % width;
    let ry = right / width;
    lx.abs_diff(rx).pow(2) + ly.abs_diff(ry).pow(2)
}

fn fractal_noise(seed: u32, x: f64, y: f64, octaves: usize) -> f64 {
    let mut value = 0.0;
    let mut amplitude = 0.5;
    let mut frequency = 1.0;
    let mut total = 0.0;
    for octave in 0..octaves {
        value += value_noise(
            seed.wrapping_add((octave as u32).wrapping_mul(0x9e37_79b9)),
            x * frequency,
            y * frequency,
        ) * amplitude;
        total += amplitude;
        amplitude *= 0.52;
        frequency *= 2.03;
    }
    value / total.max(f64::EPSILON)
}

fn value_noise(seed: u32, x: f64, y: f64) -> f64 {
    let x0 = x.floor() as i32;
    let y0 = y.floor() as i32;
    let tx = smooth(x - x0 as f64);
    let ty = smooth(y - y0 as f64);
    let sample = |px: i32, py: i32| {
        hash(
            seed,
            (px as u32).wrapping_mul(0x85eb_ca6b) ^ (py as u32).wrapping_mul(0xc2b2_ae35),
        ) as f64
            / u32::MAX as f64
    };
    let top = sample(x0, y0) * (1.0 - tx) + sample(x0 + 1, y0) * tx;
    let bottom = sample(x0, y0 + 1) * (1.0 - tx) + sample(x0 + 1, y0 + 1) * tx;
    top * (1.0 - ty) + bottom * ty
}

fn smooth(value: f64) -> f64 {
    value * value * (3.0 - 2.0 * value)
}

fn hash(seed: u32, index: u32) -> u32 {
    let mut value = seed ^ index.wrapping_mul(0x45d9_f3b);
    value ^= value >> 16;
    value = value.wrapping_mul(0x45d9_f3b);
    value ^= value >> 16;
    value
}

fn unit_noise(seed: u32, index: usize) -> f64 {
    hash(seed, index as u32) as f64 / u32::MAX as f64
}

fn annual_mean_day_length(latitude: f64) -> f64 {
    let latitude = latitude.to_radians().clamp(-1.553, 1.553);
    let declination = 23.44_f64.to_radians();
    let summer = (-latitude.tan() * declination.tan())
        .clamp(-1.0, 1.0)
        .acos()
        * 24.0
        / std::f64::consts::PI;
    let winter = (-latitude.tan() * (-declination).tan())
        .clamp(-1.0, 1.0)
        .acos()
        * 24.0
        / std::f64::consts::PI;
    (summer + winter) * 0.5
}

#[cfg(test)]
mod tests {
    use super::*;

    fn compact_test_settings() -> MapGenerationSettings {
        MapGenerationSettings {
            map_size_km: 100.0,
            map_height_km: 62.5,
            ..MapGenerationSettings::default()
        }
    }

    #[test]
    fn analysis_grid_is_independent_of_target_resolution() {
        let physical = (500.0, 312.5);
        let expected = derived_grid_size(physical.0, physical.1);
        assert_eq!(expected, (192, 120));
        for target_resolution_m in [100.0, 500.0, 1_000.0, 5_000.0] {
            let settings = MapGenerationSettings {
                map_size_km: physical.0,
                map_height_km: physical.1,
                map_size_mode: MapSizeMode::Independent,
                target_resolution_m,
                ..MapGenerationSettings::default()
            };
            let (width, height) = settings.physical_dimensions_km();
            assert_eq!(derived_grid_size(width, height), expected);
        }
    }

    #[test]
    fn canonical_dimensions_follow_target_resolution() {
        let base = MapGenerationSettings {
            map_size_km: 500.0,
            map_height_km: 312.5,
            map_size_mode: MapSizeMode::Independent,
            ..MapGenerationSettings::default()
        };
        for (resolution, expected) in [
            (100.0, (5_000, 3_125)),
            (500.0, (1_000, 625)),
            (1_000.0, (500, 313)),
            (5_000.0, (100, 63)),
        ] {
            let settings = MapGenerationSettings {
                target_resolution_m: resolution,
                ..base.clone()
            };
            assert_eq!(settings.canonical_cell_dimensions(), expected);
        }
    }

    #[test]
    fn missing_recipe_version_deserializes_as_legacy_semantics() {
        let mut value = serde_json::to_value(MapGenerationSettings::default()).expect("settings");
        let object = value.as_object_mut().expect("settings object");
        object.remove("terrainRecipeVersion");
        object.remove("parentWorldSeed");
        object.remove("selectionBearingDeg");
        object.remove("parentPlanetRadiusM");
        let restored: MapGenerationSettings =
            serde_json::from_value(value).expect("legacy settings");
        assert_eq!(restored.terrain_recipe_version, 1);
        assert_eq!(restored.parent_world_seed, 0);
    }

    #[test]
    fn new_generation_persists_current_recipe_semantics() {
        let mut settings = compact_test_settings();
        settings.map_size_km = 8.0;
        settings.map_height_km = 6.0;
        let map = generate_map(
            &settings,
            "Version".to_owned(),
            "version-test".to_owned(),
            0,
            Language::English,
        )
        .expect("generated map");
        let stored = map.generation_settings.expect("stored settings");
        assert_eq!(
            stored.terrain_recipe_version,
            CURRENT_TERRAIN_RECIPE_VERSION
        );
        assert_eq!(stored.parent_world_seed, u64::from(settings.seed));
        assert_eq!(map.generation_diagnostics.pipeline_revision, 5);
    }

    #[test]
    fn generation_is_deterministic_and_respects_water_territory_invariant() {
        let settings = compact_test_settings();
        let first = generate_map(
            &settings,
            "Test".to_owned(),
            "map-a".to_owned(),
            0,
            Language::English,
        )
        .expect("first map");
        let second = generate_map(
            &settings,
            "Test".to_owned(),
            "map-b".to_owned(),
            0,
            Language::English,
        )
        .expect("second map");
        assert_eq!(first.elevation, second.elevation);
        assert_eq!(first.terrain, second.terrain);
        assert_eq!(first.water, second.water);
        assert_eq!(first.rivers.len(), second.rivers.len());
        assert!(!first.rivers.is_empty());
        assert_eq!(
            first.logical_pixel_dimensions(),
            (
                (first.width * NativeMap::LOGICAL_PIXELS_PER_KM).round() as u32,
                (first.height * NativeMap::LOGICAL_PIXELS_PER_KM).round() as u32,
            )
        );
        let surface = first
            .canonical_surface
            .as_ref()
            .expect("generated map must own a 100 m source surface");
        assert_eq!((surface.width, surface.height), (1_000, 625));
        assert!(surface.width as usize > first.grid_width);
        assert!(surface.height as usize > first.grid_height);
        assert!(
            first
                .water
                .iter()
                .enumerate()
                .all(|(index, water)| { water == "land" || first.territory_owners[index] < 0 })
        );
        assert!(first.locations.iter().all(|location| {
            location
                .states
                .iter()
                .all(|state| first.surface_sample_at_world(state.position).water == "land")
        }));
        assert!(first.roads.iter().all(|road| {
            road.nodes
                .windows(2)
                .all(|pair| segment_is_canonical_land(&first, pair[0], pair[1], 0.0))
        }));
        assert!(first.rivers.iter().all(|river| segment_is_canonical_land(
            &first,
            river.start,
            river.end,
            0.0,
        )));
    }

    fn segment_is_canonical_land(map: &NativeMap, start: Point, end: Point, radius: f32) -> bool {
        let dx = end.x - start.x;
        let dy = end.y - start.y;
        let length = (dx * dx + dy * dy).sqrt();
        let steps = (length / 0.025).ceil().max(1.0) as usize;
        let normal = if length > f32::EPSILON {
            Point {
                x: -dy / length,
                y: dx / length,
            }
        } else {
            Point { x: 0.0, y: 0.0 }
        };
        (0..=steps).all(|step| {
            let t = step as f32 / steps as f32;
            let center = Point {
                x: start.x + dx * t,
                y: start.y + dy * t,
            };
            [-1.0_f32, 0.0, 1.0].into_iter().all(|side| {
                map.surface_sample_at_world(Point {
                    x: center.x + normal.x * radius * side,
                    y: center.y + normal.y * radius * side,
                })
                .water
                    == "land"
            })
        })
    }

    #[test]
    fn disabled_stages_create_no_random_records() {
        let settings = MapGenerationSettings {
            map_size_km: 40.0,
            map_height_km: 25.0,
            ..MapGenerationSettings::default()
        };
        let map = generate_map(
            &settings,
            "Empty".to_owned(),
            "map-empty".to_owned(),
            0,
            Language::English,
        )
        .expect("map");
        assert!(map.locations.is_empty());
        assert!(map.roads.is_empty());
        assert!(map.factions.is_empty());
        assert!(map.territory_owners.iter().all(|owner| *owner < 0));
    }

    #[test]
    fn regional_generation_does_not_reroll_planet_data_for_a_new_map_id() {
        let mut config = crate::planet_config::PlanetGenerationConfig::default();
        config.quality = crate::planet_config::GenerationQuality::Draft;
        let mut planet = PlanetState::default();
        planet
            .apply_generation_config(config)
            .expect("planet generation");
        let center = PlanetPosition::from_latitude_longitude_deg(34.0, 126.0);
        let mut settings = MapGenerationSettings {
            map_size_km: 40.0,
            map_height_km: 25.0,
            map_size_mode: MapSizeMode::Independent,
            ..MapGenerationSettings::default()
        };
        settings.seed = planet
            .generation_config
            .stable_subseed("planet-regional-refinement") as u32;
        let first = generate_map_for_region(
            &settings,
            "First".to_owned(),
            "map-first".to_owned(),
            0,
            Language::English,
            &planet,
            center,
        )
        .expect("first region");
        let second = generate_map_for_region(
            &settings,
            "Second".to_owned(),
            "map-second".to_owned(),
            0,
            Language::English,
            &planet,
            center,
        )
        .expect("second region");
        assert_eq!(first.elevation, second.elevation);
        assert_eq!(first.water, second.water);
        assert_eq!(first.terrain, second.terrain);
        assert_eq!(first.temperature, second.temperature);
        assert_eq!(first.precipitation, second.precipitation);
    }

    #[test]
    fn settings_validate_documented_ranges() {
        let mut settings = MapGenerationSettings::default();
        settings.maximum_elevation_m = 10_001.0;
        assert!(settings.validate().is_err());
        settings.maximum_elevation_m = 10_000.0;
        settings.elevation_span_m = 0.0;
        assert!(settings.validate().is_ok());
        settings.elevation_span_m = 9_001.0;
        assert!(settings.validate().is_err());
        settings.elevation_span_m = 9_000.0;
        assert!(settings.validate().is_ok());
        settings.map_size_km = 4_000.0;
        settings.map_height_km = 4_000.0;
        settings.map_size_mode = MapSizeMode::Independent;
        assert!(settings.validate().is_ok());
        settings.map_size_km = 4_000.1;
        assert!(settings.validate().is_err());
    }

    #[test]
    fn drainage_outlets_distinguish_water_edges_and_closed_basins() {
        let water = vec![
            "saltwater".to_owned(),
            "land".to_owned(),
            "freshwater".to_owned(),
            "land".to_owned(),
            "land".to_owned(),
            "land".to_owned(),
            "land".to_owned(),
            "land".to_owned(),
            "land".to_owned(),
        ];
        let downstream = vec![
            None,
            Some(0),
            None,
            None,
            None,
            Some(2),
            None,
            Some(4),
            Some(7),
        ];
        let outlets = classify_drainage_outlets(3, 3, &water, &downstream);
        assert!(outlets.iter().any(|outlet| {
            outlet.analysis_index == 0 && outlet.kind == DrainageOutletKind::OceanOutlet
        }));
        assert!(outlets.iter().any(|outlet| {
            outlet.analysis_index == 2 && outlet.kind == DrainageOutletKind::LakeOutlet
        }));
        assert!(outlets.iter().any(|outlet| {
            outlet.analysis_index == 3 && outlet.kind == DrainageOutletKind::BorderContinuation
        }));
        assert!(outlets.iter().any(|outlet| {
            outlet.analysis_index == 4 && outlet.kind == DrainageOutletKind::ClosedBasin
        }));
    }

    #[test]
    fn elevated_freshwater_component_receives_a_land_route_to_real_ocean() {
        let width = 9;
        let height = 7;
        let mut elevation = vec![45.0_f32; width * height];
        let mut water = vec!["land".to_owned(); width * height];
        for y in 0..height {
            water[y * width + width - 1] = "saltwater".to_owned();
            elevation[y * width + width - 1] = -20.0;
        }
        let lake = 3 * width + 2;
        water[lake] = "freshwater".to_owned();
        elevation[lake] = 80.0;
        let routes = build_lake_outlet_routes(width, height, &mut elevation, &water);
        assert_eq!(routes.len(), 1);
        let route = &routes[0];
        assert_eq!(route.lake_index, lake);
        assert!(route.cells.len() >= 2);
        assert_eq!(water[*route.cells.last().expect("terminal")], "saltwater");
        assert!(
            route
                .cells
                .iter()
                .take(route.cells.len() - 1)
                .all(|index| water[*index] == "land")
        );
        assert!(
            route
                .cells
                .windows(2)
                .take(route.cells.len().saturating_sub(2))
                .all(|pair| elevation[pair[1]] <= elevation[pair[0]] + f32::EPSILON)
        );
    }

    #[test]
    fn physical_extent_resolves_to_exact_one_hundred_metre_cells() {
        let default = MapGenerationSettings::default();
        assert_eq!(default.physical_dimensions_km(), (500.0, 312.5));
        assert_eq!(default.canonical_cell_dimensions(), (5_000, 3_125));

        let hundred_square = MapGenerationSettings {
            map_size_km: 100.0,
            map_height_km: 100.0,
            map_size_mode: MapSizeMode::Independent,
            ..MapGenerationSettings::default()
        };
        let five_hundred_square = MapGenerationSettings {
            map_size_km: 500.0,
            map_height_km: 500.0,
            map_size_mode: MapSizeMode::Independent,
            ..MapGenerationSettings::default()
        };
        assert_eq!(hundred_square.canonical_cell_dimensions(), (1_000, 1_000));
        assert_eq!(
            five_hundred_square.canonical_cell_dimensions(),
            (5_000, 5_000)
        );
    }

    #[test]
    fn generated_river_widths_do_not_shrink_downstream() {
        let map = generate_map(
            &compact_test_settings(),
            "River".to_owned(),
            "river-map".to_owned(),
            0,
            Language::English,
        )
        .expect("map");
        let key = |point: Point| {
            (
                (point.x * 1_000.0).round() as i32,
                (point.y * 1_000.0).round() as i32,
            )
        };
        let starts = map
            .rivers
            .iter()
            .map(|river| (key(river.start), river))
            .collect::<std::collections::HashMap<_, _>>();
        for river in &map.rivers {
            assert!(river.width >= 0.050);
            assert!(river.width <= 10.0);
            if let Some(next) = starts.get(&key(river.end)) {
                assert!(
                    next.discharge + f32::EPSILON >= river.discharge,
                    "river discharge shrank from {} to {} at {:?}",
                    river.discharge,
                    next.discharge,
                    river.end
                );
                assert!(next.width + f32::EPSILON >= river.width);
            }
        }
    }

    #[test]
    fn newly_generated_maps_defer_all_human_geography() {
        let map = generate_map(
            &compact_test_settings(),
            "Physical only".to_owned(),
            "physical-only-map".to_owned(),
            0,
            Language::English,
        )
        .expect("map");
        assert!(map.locations.is_empty());
        assert!(map.roads.is_empty());
        assert!(map.factions.is_empty());
        assert!(map.territories.is_empty());
        assert!(map.territory_owners.iter().all(|owner| *owner < 0));
    }

    #[test]
    fn d_infinity_routing_is_deterministic_and_conserves_runoff() {
        let filled = vec![4.0, 3.0, 2.0, 3.0, 2.0, 1.0, 2.0, 1.0, 0.0];
        let water = vec!["land".to_owned(); 9];
        let first = build_d_infinity_routing(17, 3, 3, 3.0, 3.0, &filled, &water, &[]);
        let second = build_d_infinity_routing(17, 3, 3, 3.0, 3.0, &filled, &water, &[]);
        let first_targets = first[4].targets.into_iter().flatten().collect::<Vec<_>>();
        let second_targets = second[4].targets.into_iter().flatten().collect::<Vec<_>>();
        assert_eq!(first_targets.len(), second_targets.len());
        assert!(
            (first_targets
                .iter()
                .map(|target| target.weight)
                .sum::<f64>()
                - 1.0)
                .abs()
                < 1e-9
        );
        for (left, right) in first_targets.iter().zip(second_targets.iter()) {
            assert_eq!(left.index, right.index);
            assert_eq!(left.weight, right.weight);
            assert!(filled[left.index] < filled[4]);
        }
    }

    #[test]
    fn channel_orders_use_strahler_and_shreve_confluences() {
        let channels = vec![true, true, true, true];
        let downstream = vec![Some(2), Some(2), Some(3), None];
        let filled = vec![4.0, 4.0, 3.0, 2.0];
        let (strahler, shreve) = channel_orders(&channels, &downstream, &filled);
        assert_eq!(strahler, vec![1, 1, 2, 2]);
        assert_eq!(shreve, vec![1, 1, 2, 2]);
        assert!(hydraulic_width_km(100.0, 3, 5) > hydraulic_width_km(1.0, 1, 1));
    }
}
