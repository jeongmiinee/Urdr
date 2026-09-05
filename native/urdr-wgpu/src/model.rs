use std::{
    cell::Cell,
    collections::BTreeSet,
    io::{Read, Write},
    sync::Arc,
};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct CanonicalSampleTrace {
    pub cells_requested: u64,
    pub materialized_cells: u64,
    pub virtual_cells_synthesized: u64,
    pub analysis_samples: u64,
    pub procedural_samples: u64,
    pub geology_samples: u64,
}

#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct CanonicalDiagnosticSample {
    pub analysis_elevation_m: f32,
    pub procedural_elevation_m: f32,
    pub geology_bias_m: f32,
    pub final_elevation_m: f32,
    pub residual_m: f32,
    pub water_code: u8,
}

thread_local! {
    static CANONICAL_SAMPLE_TRACE: Cell<Option<CanonicalSampleTrace>> = const { Cell::new(None) };
}

pub(crate) fn begin_canonical_sample_trace() {
    CANONICAL_SAMPLE_TRACE.with(|trace| trace.set(Some(CanonicalSampleTrace::default())));
}

pub(crate) fn finish_canonical_sample_trace() -> CanonicalSampleTrace {
    CANONICAL_SAMPLE_TRACE.with(|trace| trace.replace(None).unwrap_or_default())
}

fn update_canonical_sample_trace(update: impl FnOnce(&mut CanonicalSampleTrace)) {
    CANONICAL_SAMPLE_TRACE.with(|slot| {
        if let Some(mut trace) = slot.get() {
            update(&mut trace);
            slot.set(Some(trace));
        }
    });
}

use flate2::{
    Compression,
    read::{GzDecoder, ZlibDecoder},
    write::ZlibEncoder,
};
use serde::{Deserialize, Deserializer, Serialize, Serializer, de::Error as _};
use serde_json::Value;

use crate::{
    geology::CausalGeologyModel,
    heraldry::{HeraldryDesign, HeraldryLayer, HeraldryShape, LayerArtwork},
    procedural::{
        ClimateFieldConfig, GenerationDiagnostics, GeologicGuideMesh, TerrainFieldConfig,
        TerrainResidualContext, sample_climate_field, sample_parent_constrained_residual,
        sample_terrain_field, terrain_climate_bias,
    },
    resources,
    river_graph::{RiverGraph, RiverNodeKind},
    spatial::{
        DetailedRegion, MapViewDefinition, PlanetState, RegionDefinition,
        generated_region_and_view, legacy_region_and_view, regional_metric_position,
        regional_metric_position_rotated,
    },
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Language {
    Korean,
    English,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoadedWorld {
    pub title: String,
    pub description: String,
    #[serde(default)]
    pub project_sections: Vec<DocumentSection>,
    pub map: NativeMap,
    #[serde(default)]
    pub maps: Vec<NativeMap>,
    #[serde(default)]
    pub planet: PlanetState,
    #[serde(default)]
    pub regions: Vec<RegionDefinition>,
    #[serde(default)]
    pub detailed_regions: Vec<DetailedRegion>,
    #[serde(default)]
    pub map_views: Vec<MapViewDefinition>,
    pub articles: Vec<Article>,
    pub categories: Vec<WikiCategory>,
    pub factions: Vec<Faction>,
    pub events: Vec<Event>,
    #[serde(default)]
    pub heraldic_assets: Vec<HeraldicAsset>,
    #[serde(default)]
    pub dictionaries: Vec<DictionaryBook>,
    #[serde(default)]
    pub character_folders: Vec<CharacterFolder>,
    #[serde(default)]
    pub generated_glyphs: Vec<GeneratedGlyph>,
    #[serde(default)]
    pub character_charts: Vec<CharacterChart>,
    #[serde(default)]
    pub speech_assets: Vec<EmbeddedSpeechAsset>,
    #[serde(default)]
    pub timeline_calendar_article_id: Option<String>,
    #[serde(default = "default_true")]
    pub rpg_enabled: bool,
    pub magic_enabled: bool,
    #[serde(default = "default_latitude")]
    pub latitude_deg: f32,
    #[serde(default = "default_axial_tilt")]
    pub axial_tilt_deg: f32,
    #[serde(default = "default_day_length")]
    pub day_length_hours: f32,
    #[serde(default = "default_gravity")]
    pub gravity_ms2: f32,
    #[serde(default = "default_orbital_period")]
    pub orbital_period_days: f32,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DictionaryBook {
    pub language_article_id: String,
    #[serde(default)]
    pub voice_profile: DictionaryVoiceProfile,
    #[serde(default)]
    pub words: Vec<DictionaryWord>,
    #[serde(default)]
    pub sentences: Vec<DictionarySentence>,
    #[serde(default)]
    pub conversations: Vec<DictionaryConversation>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DictionaryWord {
    pub id: String,
    #[serde(default)]
    pub term: String,
    #[serde(default)]
    pub pronunciation: String,
    #[serde(default)]
    pub alphabet_pronunciation: String,
    #[serde(default)]
    pub meaning: String,
    #[serde(default)]
    pub part_of_speech: String,
    #[serde(default)]
    pub etymology: String,
    #[serde(default)]
    pub usage_note: String,
    #[serde(default)]
    pub related_terms: Vec<String>,
    #[serde(default)]
    pub script_glyph_ids: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DictionarySentence {
    pub id: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub pronunciation: String,
    #[serde(default)]
    pub translation: String,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub script_glyph_ids: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DictionaryConversation {
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub situation: String,
    #[serde(default)]
    pub lines: Vec<DictionaryConversationLine>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DictionaryConversationLine {
    #[serde(default)]
    pub speaker: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub pronunciation: String,
    #[serde(default)]
    pub translation: String,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub script_glyph_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DictionaryVoiceProfile {
    #[serde(default = "default_voice_id")]
    pub voice_id: String,
    #[serde(default = "default_voice_speed")]
    pub speed: f32,
    #[serde(default = "default_voice_pitch")]
    pub pitch: f32,
    #[serde(default = "default_voice_volume")]
    pub volume: f32,
    #[serde(default)]
    pub grapheme_rules: Vec<GraphemeRule>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedSpeechAsset {
    pub cache_key: String,
    pub wav_base64: String,
    pub duration_millis: u64,
}

impl Default for DictionaryVoiceProfile {
    fn default() -> Self {
        Self {
            voice_id: default_voice_id(),
            speed: default_voice_speed(),
            pitch: default_voice_pitch(),
            volume: default_voice_volume(),
            grapheme_rules: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GraphemeRule {
    pub grapheme: String,
    pub ipa: String,
}

fn default_voice_id() -> String {
    "ims-toucan-multilingual".to_owned()
}
fn default_voice_speed() -> f32 {
    1.0
}
fn default_voice_pitch() -> f32 {
    1.0
}
fn default_voice_volume() -> f32 {
    0.85
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CharacterFolder {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub order: i32,
    #[serde(default)]
    pub writing_system_article_id: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedGlyph {
    pub id: String,
    pub folder_id: String,
    pub name: String,
    #[serde(default)]
    pub pronunciation: String,
    #[serde(default)]
    pub alphabet_pronunciation: String,
    #[serde(default)]
    pub meaning: String,
    #[serde(default = "default_glyph_dimension")]
    pub width: u16,
    #[serde(default = "default_glyph_dimension")]
    pub height: u16,
    /// Alternating transparent/opaque run lengths, beginning with transparent.
    #[serde(default)]
    pub alpha_runs: Vec<u32>,
    #[serde(default)]
    pub order: i32,
    #[serde(default)]
    pub created_at: u64,
    #[serde(default)]
    pub updated_at: u64,
}

fn default_glyph_dimension() -> u16 {
    128
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CharacterChart {
    pub id: String,
    pub writing_system_article_id: String,
    pub title: String,
    #[serde(default)]
    pub order: i32,
    #[serde(default)]
    pub rows: Vec<CharacterChartAxis>,
    #[serde(default)]
    pub columns: Vec<CharacterChartAxis>,
    #[serde(default)]
    pub cells: Vec<CharacterChartCell>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CharacterChartAxis {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub order: i32,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CharacterChartCell {
    pub row_id: String,
    pub column_id: String,
    #[serde(default)]
    pub sound_value: String,
    #[serde(default)]
    pub representative_name: String,
    #[serde(default)]
    pub glyphs: Vec<CharacterGlyphSlot>,
    #[serde(default)]
    pub variants: Vec<CharacterGlyphVariant>,
    #[serde(default)]
    pub combinations: Vec<CharacterCombinationForm>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CharacterGlyphSlot {
    pub id: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub source_glyph_id: Option<String>,
    #[serde(default = "default_glyph_dimension")]
    pub width: u16,
    #[serde(default = "default_glyph_dimension")]
    pub height: u16,
    #[serde(default)]
    pub alpha_runs: Vec<u32>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CharacterGlyphVariant {
    pub id: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub glyph: CharacterGlyphSlot,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CharacterCombinationForm {
    pub id: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub condition: String,
    #[serde(default)]
    pub glyph: CharacterGlyphSlot,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HeraldicAsset {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub design: HeraldryDesign,
}

impl HeraldicAsset {
    pub fn is_emblem(&self) -> bool {
        self.kind == "coatOfArms" || self.kind == "emblem"
    }
}

fn default_true() -> bool {
    true
}
fn default_latitude() -> f32 {
    37.5
}
fn default_axial_tilt() -> f32 {
    23.4
}
fn default_day_length() -> f32 {
    24.0
}
fn default_gravity() -> f32 {
    9.81
}
fn default_orbital_period() -> f32 {
    365.0
}
fn default_surface_cell_m() -> f32 {
    NativeMap::SURFACE_CELL_METERS as f32
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NativeMap {
    #[serde(default)]
    pub source_id: String,
    #[serde(default)]
    pub region_id: Option<String>,
    #[serde(default)]
    pub map_view_id: Option<String>,
    pub title: String,
    pub width: f32,
    pub height: f32,
    #[serde(default)]
    pub logical_pixel_width: u32,
    #[serde(default)]
    pub logical_pixel_height: u32,
    #[serde(default = "default_surface_cell_m")]
    pub surface_cell_m: f32,
    pub grid_width: usize,
    pub grid_height: usize,
    pub sea_level: f32,
    pub climate_model: u8,
    pub environment_seed: u32,
    #[serde(default)]
    pub generation_settings: Option<crate::generator::MapGenerationSettings>,
    #[serde(default)]
    pub geologic_guide: Option<GeologicGuideMesh>,
    #[serde(default)]
    pub causal_geology: CausalGeologyModel,
    #[serde(default)]
    pub generation_diagnostics: GenerationDiagnostics,
    pub elevation: Vec<f32>,
    pub terrain: Vec<String>,
    pub water: Vec<String>,
    pub temperature: Vec<f32>,
    pub precipitation: Vec<f32>,
    pub moisture: Vec<f32>,
    pub humidity: Vec<f32>,
    pub runoff: Vec<f32>,
    pub wind_x: Vec<f32>,
    pub wind_y: Vec<f32>,
    #[serde(default)]
    pub solar_hours: Vec<f32>,
    #[serde(default)]
    pub solar_irradiance: Vec<f32>,
    #[serde(default)]
    pub snowfall: Vec<f32>,
    #[serde(default)]
    pub snow_cover: Vec<f32>,
    #[serde(default)]
    pub evapotranspiration: Vec<f32>,
    #[serde(default)]
    pub flow_accumulation: Vec<f32>,
    #[serde(default)]
    pub river_order: Vec<f32>,
    pub roads: Vec<PathLine>,
    #[serde(default)]
    pub place_names: Vec<PlaceName>,
    /// Runtime compatibility view derived from `river_graph` in Engine 3.7.
    /// Legacy files may still deserialize this field, but new saves avoid
    /// duplicating every reach centerline.
    #[serde(default, skip_serializing)]
    pub rivers: Vec<RiverSegment>,
    #[serde(default)]
    pub river_graph: RiverGraph,
    #[serde(default)]
    pub drainage_outlets: Vec<DrainageOutlet>,
    pub locations: Vec<Location>,
    #[serde(default)]
    pub factions: Vec<Faction>,
    #[serde(default)]
    pub territories: Vec<Territory>,
    #[serde(default)]
    pub territory_owners: Vec<i32>,
    #[serde(default)]
    pub territory_history: Vec<TerritoryGridState>,
    #[serde(default)]
    pub events: Vec<Event>,
    #[serde(default)]
    pub environment_pins: Vec<EnvironmentPin>,
    pub current_year: i32,
    /// Authoritative source cells at `surface_cell_m`. Analysis grids and render LODs derive from it.
    #[serde(default, with = "canonical_surface_serde")]
    pub canonical_surface: Option<Arc<CanonicalSurface>>,
    /// Changes whenever canonical elevation, terrain, or water data changes.
    #[serde(default)]
    pub surface_revision: u64,
}

#[derive(Debug, Clone)]
pub struct CanonicalSurface {
    pub width: u32,
    pub height: u32,
    chunks_x: u32,
    chunks_y: u32,
    chunks: Vec<Option<Arc<SurfaceChunk>>>,
    recipe: Option<CanonicalSurfaceRecipe>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CanonicalSurfaceRecipe {
    environment_seed: u32,
    map_width_km: f32,
    map_height_km: f32,
    sea_level: f32,
    grid_width: usize,
    grid_height: usize,
    elevation: Vec<f32>,
    temperature: Vec<f32>,
    moisture: Vec<f32>,
    precipitation: Vec<f32>,
    water: Vec<String>,
    generation_settings: Option<crate::generator::MapGenerationSettings>,
    geologic_guide: Option<GeologicGuideMesh>,
    #[serde(default, skip)]
    causal_geology: CausalGeologyModel,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    causal_geology_seed: Option<u64>,
    #[serde(default)]
    causal_geology_plate_count: u16,
}

#[derive(Debug, Clone)]
struct SurfaceChunk {
    width: u16,
    height: u16,
    revision: u64,
    elevation_m: Box<[i16]>,
    terrain: Box<[u8]>,
    water: Box<[u8]>,
}

#[derive(Debug, Clone, Copy)]
pub struct SurfaceSample {
    pub elevation_m: f32,
    pub terrain: &'static str,
    pub water: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct SurfaceRenderSample {
    pub elevation_m: f32,
    pub surface_name: &'static str,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnvironmentPin {
    pub id: String,
    pub name: String,
    pub point: Point,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Article {
    #[serde(default)]
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub wiki_aliases: Vec<String>,
    #[serde(default)]
    pub redirect_target_article_id: Option<String>,
    pub category: String,
    pub category_id: Option<String>,
    pub summary: String,
    pub content: String,
    pub calendar_profile: Option<CalendarProfile>,
    #[serde(default)]
    pub document_sections: Vec<DocumentSection>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub linked_map_entity_ids: Vec<String>,
    #[serde(default)]
    pub source_map_id: Option<String>,
    #[serde(default)]
    pub source_entity_id: Option<String>,
    #[serde(default)]
    pub profiles: ArticleProfiles,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ArticleProfiles {
    #[serde(default)]
    pub person: Option<Value>,
    #[serde(default)]
    pub family: Option<Value>,
    #[serde(default)]
    pub item: Option<Value>,
    #[serde(default)]
    pub religion: Option<Value>,
    #[serde(default)]
    pub culture: Option<Value>,
    #[serde(default)]
    pub technology: Option<Value>,
    #[serde(default)]
    pub disease: Option<Value>,
    #[serde(default)]
    pub government: Option<Value>,
    #[serde(default)]
    pub event: Option<Value>,
    #[serde(default)]
    pub faction: Option<Value>,
    #[serde(default)]
    pub rpg: Option<Value>,
    #[serde(default)]
    pub nature: Option<Value>,
    #[serde(default)]
    pub place: Option<Value>,
    #[serde(default)]
    pub ideology: Option<Value>,
    #[serde(default)]
    pub language: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentSection {
    pub id: String,
    pub title: String,
    pub content: String,
    pub parent_id: Option<String>,
    #[serde(default = "default_section_level")]
    pub level: u8,
}

fn default_section_level() -> u8 {
    1
}

fn project_sections_from_legacy_description(description: &str) -> Vec<DocumentSection> {
    let mut sections = Vec::<DocumentSection>::new();
    let mut current: Option<DocumentSection> = None;
    for line in description.lines() {
        let heading_level = line
            .chars()
            .take_while(|character| *character == '#')
            .count();
        if heading_level > 0 && heading_level <= 4 {
            if let Some(section) = current.take() {
                sections.push(section);
            }
            let title = line[heading_level..].trim();
            if !title.is_empty() {
                let parent_id = sections
                    .iter()
                    .rev()
                    .find(|section| section.level < heading_level as u8)
                    .map(|section| section.id.clone());
                current = Some(DocumentSection {
                    id: format!("project-section-{}", sections.len() + 1),
                    title: title.to_owned(),
                    content: String::new(),
                    parent_id,
                    level: heading_level as u8,
                });
            }
        } else if !line.trim().is_empty() {
            let section = current.get_or_insert_with(|| DocumentSection {
                id: "project-section-1".to_owned(),
                title: String::new(),
                content: String::new(),
                parent_id: None,
                level: 1,
            });
            if !section.content.is_empty() {
                section.content.push('\n');
            }
            section.content.push_str(line);
        }
    }
    if let Some(section) = current {
        sections.push(section);
    }
    sections
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WikiCategory {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    #[serde(default)]
    pub system_key: Option<String>,
    #[serde(default)]
    pub template_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CalendarUnit {
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub short_name: String,
    pub units_per_parent: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CalendarProfile {
    pub calendar_name: String,
    pub creator: String,
    #[serde(default)]
    pub creator_article_id: Option<String>,
    #[serde(default)]
    pub created_at_year: Option<i32>,
    #[serde(default)]
    pub created_at_absolute_day: Option<f64>,
    #[serde(default)]
    pub user_faction_ids: Vec<String>,
    #[serde(default)]
    pub mechanism: String,
    #[serde(default = "default_calendar_display_mode")]
    pub display_mode: String,
    pub epoch_world_year: i32,
    /// Absolute world day represented by calendar year zero. Legacy projects
    /// derive this from `epoch_world_year` and the world's orbital period.
    #[serde(default)]
    pub epoch_absolute_day: Option<f64>,
    pub before_era_name: String,
    pub after_era_name: String,
    pub before_era_short_name: String,
    pub after_era_short_name: String,
    pub date_units: Vec<CalendarUnit>,
    pub time_units: Vec<CalendarUnit>,
}

fn default_calendar_display_mode() -> String {
    "era".to_owned()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Faction {
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub color: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub has_territory: bool,
    #[serde(default)]
    pub flag_asset_id: Option<String>,
    #[serde(default)]
    pub emblem_asset_id: Option<String>,
    #[serde(default)]
    pub profile: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Event {
    #[serde(default)]
    pub id: String,
    pub title: String,
    pub start_year: i32,
    pub end_year: Option<i32>,
    #[serde(default)]
    pub location: Option<Point>,
    #[serde(default)]
    pub location_history: Vec<TemporalMapPoint>,
    #[serde(default)]
    pub article_id: Option<String>,
    #[serde(default)]
    pub water_position_warning: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TemporalMapPoint {
    pub start_year: i32,
    pub end_year: Option<i32>,
    pub position: Point,
}

impl Event {
    pub fn position_at(&self, year: i32) -> Option<Point> {
        self.location_history
            .iter()
            .rev()
            .find(|state| state.start_year <= year && state.end_year.is_none_or(|end| year <= end))
            .map(|state| state.position)
            .or(self.location)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlaceName {
    pub id: String,
    #[serde(default)]
    pub article_id: Option<String>,
    pub name: String,
    pub position: Point,
    #[serde(default)]
    pub path: Vec<Point>,
    pub start_year: i32,
    pub end_year: Option<i32>,
    #[serde(default = "default_place_name_font_size")]
    pub font_size: f32,
    #[serde(default)]
    pub letter_spacing: f32,
    #[serde(default)]
    pub bold: bool,
    #[serde(default)]
    pub italic: bool,
}

fn default_place_name_font_size() -> f32 {
    13.0
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Location {
    #[serde(default)]
    pub id: String,
    pub states: Vec<LocationTemporalState>,
    #[serde(default)]
    pub article_id: Option<String>,
    #[serde(default)]
    pub water_position_warning: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocationTemporalState {
    pub start_year: i32,
    pub end_year: Option<i32>,
    pub name: String,
    pub position: Point,
    #[serde(default)]
    pub population: Option<f64>,
    #[serde(default)]
    pub economy: Option<f64>,
    #[serde(default)]
    pub location_type: String,
    #[serde(default)]
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Territory {
    pub id: String,
    pub name: String,
    pub states: Vec<TerritoryTemporalState>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerritoryTemporalState {
    pub start_year: i32,
    pub end_year: Option<i32>,
    pub owner_faction_id: Option<String>,
    #[serde(default)]
    pub parts: Vec<TerritoryPart>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerritoryPart {
    #[serde(default)]
    pub polygon: Vec<Point>,
    #[serde(default)]
    pub holes: Vec<Vec<Point>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerritoryGridState {
    pub start_year: i32,
    pub owners: Vec<i32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Point {
    pub x: f32,
    pub y: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PathLine {
    pub nodes: Vec<Point>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RiverSegment {
    pub start: Point,
    pub end: Point,
    pub width: f32,
    #[serde(default)]
    pub discharge: f32,
    #[serde(default)]
    pub stream_order: u8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DrainageOutletKind {
    OceanOutlet,
    LakeOutlet,
    BorderContinuation,
    ClosedBasin,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct DrainageOutlet {
    pub analysis_index: usize,
    pub kind: DrainageOutletKind,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectFile {
    title: String,
    #[serde(default)]
    description: String,
    maps: Vec<MapFile>,
    #[serde(default)]
    wiki_articles: Vec<ArticleFile>,
    #[serde(default)]
    wiki_categories: Vec<CategoryFile>,
    #[serde(default)]
    rpg_settings: Option<RpgSettingsFile>,
    #[serde(default)]
    world_settings: Option<WorldSettingsFile>,
    #[serde(default)]
    timeline_calendar_article_id: Option<String>,
    #[serde(default)]
    active_map_id: Option<String>,
    #[serde(default)]
    heraldic_assets: Vec<HeraldicAssetFile>,
    #[serde(default)]
    dictionaries: Vec<DictionaryBook>,
    #[serde(default)]
    character_folders: Vec<CharacterFolder>,
    #[serde(default)]
    generated_glyphs: Vec<GeneratedGlyph>,
    #[serde(default)]
    character_charts: Vec<CharacterChart>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HeraldicAssetFile {
    id: String,
    kind: String,
    name: String,
    shape: String,
    #[serde(default)]
    pattern: String,
    #[serde(default)]
    symbol: String,
    #[serde(default)]
    background_color: String,
    #[serde(default)]
    pattern_color: String,
    #[serde(default)]
    symbol_color: String,
    #[serde(default)]
    pattern_scale: Option<f32>,
    #[serde(default)]
    symbol_scale: Option<f32>,
    #[serde(default)]
    symbol_offset_x: Option<f32>,
    #[serde(default)]
    symbol_offset_y: Option<f32>,
    #[serde(default)]
    layers: Vec<HeraldicLayerFile>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HeraldicLayerFile {
    #[serde(default)]
    kind: String,
    #[serde(default)]
    pattern: Option<String>,
    #[serde(default)]
    symbol: Option<String>,
    #[serde(default)]
    visible: bool,
    #[serde(default)]
    locked: bool,
    #[serde(default)]
    color: String,
    #[serde(default)]
    secondary_color: Option<String>,
    #[serde(default)]
    offset_x: f32,
    #[serde(default)]
    offset_y: f32,
    #[serde(default = "default_layer_scale")]
    scale_x: f32,
    #[serde(default = "default_layer_scale")]
    scale_y: f32,
    #[serde(default)]
    rotation: f32,
    #[serde(default)]
    flip_x: bool,
    #[serde(default)]
    flip_y: bool,
    #[serde(default = "default_layer_opacity")]
    opacity: f32,
}

fn default_layer_scale() -> f32 {
    1.0
}
fn default_layer_opacity() -> f32 {
    1.0
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct WorldSettingsFile {
    #[serde(default = "default_latitude")]
    latitude_deg: f32,
    #[serde(default = "default_axial_tilt")]
    axial_tilt_deg: f32,
    #[serde(default = "default_day_length")]
    day_length_hours: f32,
    #[serde(default = "default_gravity")]
    gravity_ms2: f32,
    #[serde(default = "default_orbital_period")]
    orbital_period_days: f32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CategoryFile {
    id: String,
    name: String,
    parent_id: Option<String>,
    #[serde(default)]
    system_key: Option<String>,
    #[serde(default)]
    template_key: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct RpgSettingsFile {
    #[serde(default)]
    magic_enabled: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MapFile {
    #[serde(default)]
    id: String,
    title: String,
    width: f32,
    height: f32,
    timeline: TimelineFile,
    generated_states: Vec<TemporalGeneratedFile>,
    #[serde(default)]
    roads: Vec<PathLineFile>,
    #[serde(default)]
    place_names: Vec<PlaceNameFile>,
    #[serde(default)]
    locations: Vec<LocationFile>,
    #[serde(default)]
    factions: Vec<FactionFile>,
    #[serde(default)]
    territories: Vec<TerritoryFile>,
    #[serde(default)]
    events: Vec<EventFile>,
    #[serde(default)]
    environment_pins: Vec<EnvironmentPinFile>,
    #[serde(default)]
    generator_seed_history: Vec<GeneratorSeedFile>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EnvironmentPinFile {
    id: String,
    name: String,
    position: Point,
}

#[derive(Deserialize)]
struct GeneratorSeedFile {
    seed: u32,
    #[serde(default)]
    settings: GeneratorSeedSettingsFile,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct GeneratorSeedSettingsFile {
    #[serde(default)]
    climate_preset: String,
    #[serde(default)]
    map_scale_km: Option<f32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TimelineFile {
    current_year: i32,
}

#[derive(Deserialize)]
struct TemporalGeneratedFile {
    value: GeneratedFile,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GeneratedFile {
    grid_width: usize,
    grid_height: usize,
    world_width: f32,
    world_height: f32,
    sea_level: f32,
    elevation_map: Vec<f32>,
    terrain_map: Vec<String>,
    water_type_map: Vec<String>,
    #[serde(default)]
    temperature_map: Vec<f32>,
    #[serde(default)]
    precipitation_map: Vec<f32>,
    #[serde(default)]
    moisture_map: Vec<f32>,
    #[serde(default)]
    relative_humidity_map: Vec<f32>,
    #[serde(default)]
    runoff_map: Vec<f32>,
    #[serde(default)]
    wind_x_map: Vec<f32>,
    #[serde(default)]
    wind_y_map: Vec<f32>,
    #[serde(default)]
    solar_hours_map: Vec<f32>,
    #[serde(default)]
    solar_irradiance_map: Vec<f32>,
    #[serde(default)]
    snowfall_map: Vec<f32>,
    #[serde(default)]
    snow_cover_map: Vec<f32>,
    #[serde(default)]
    evapotranspiration_map: Vec<f32>,
    #[serde(default)]
    flow_accumulation_map: Vec<f32>,
    #[serde(default)]
    river_order_map: Vec<f32>,
    #[serde(default)]
    rivers: Vec<RiverFile>,
}

#[derive(Deserialize)]
struct PathLineFile {
    #[serde(default)]
    nodes: Vec<Point>,
}

#[derive(Deserialize)]
struct RiverFile {
    start: Point,
    end: Point,
    #[serde(default = "default_river_width")]
    width: f32,
    #[serde(default)]
    flow: f32,
    #[serde(default)]
    order: u8,
}

fn default_river_width() -> f32 {
    0.02
}

#[derive(Deserialize)]
struct LocationFile {
    #[serde(default)]
    id: String,
    #[serde(default)]
    states: Vec<LocationStateFile>,
    #[serde(default)]
    article_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocationStateFile {
    start_year: i32,
    end_year: Option<i32>,
    value: LocationValueFile,
}

#[derive(Deserialize)]
struct LocationValueFile {
    name: String,
    position: Point,
    #[serde(default)]
    population: Option<f64>,
    #[serde(default)]
    economy: Option<f64>,
    #[serde(default)]
    location_type: String,
    #[serde(default)]
    description: String,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct FactionFile {
    #[serde(default)]
    id: String,
    name: String,
    #[serde(default)]
    color: String,
    #[serde(default)]
    kind: String,
    #[serde(default)]
    has_territory: bool,
    #[serde(default)]
    flag_asset_id: Option<String>,
    #[serde(default)]
    coat_of_arms_asset_id: Option<String>,
    #[serde(default)]
    country_profile: Option<Value>,
    #[serde(default)]
    group_profile: Option<Value>,
}

#[derive(Deserialize)]
struct TerritoryFile {
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    states: Vec<TerritoryStateFile>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerritoryStateFile {
    start_year: i32,
    end_year: Option<i32>,
    value: TerritoryValueFile,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerritoryValueFile {
    #[serde(default)]
    owner_faction_id: Option<String>,
    #[serde(default)]
    polygon: Vec<Point>,
    #[serde(default)]
    holes: Vec<Vec<Point>>,
    #[serde(default)]
    parts: Vec<TerritoryPartFile>,
}

#[derive(Deserialize)]
struct TerritoryPartFile {
    #[serde(default)]
    polygon: Vec<Point>,
    #[serde(default)]
    holes: Vec<Vec<Point>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EventFile {
    #[serde(default)]
    id: String,
    title: String,
    start_year: i32,
    end_year: Option<i32>,
    #[serde(default)]
    location: Option<Point>,
    #[serde(default)]
    article_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlaceNameFile {
    #[serde(default)]
    id: String,
    #[serde(default)]
    article_id: Option<String>,
    name: String,
    position: Point,
    #[serde(default)]
    path: Vec<Point>,
    start_year: i32,
    end_year: Option<i32>,
    #[serde(default = "default_place_name_font_size")]
    font_size: f32,
    #[serde(default)]
    letter_spacing: f32,
    #[serde(default)]
    bold: bool,
    #[serde(default)]
    italic: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArticleFile {
    #[serde(default)]
    id: String,
    title: String,
    #[serde(default)]
    wiki_aliases: Vec<String>,
    #[serde(default)]
    redirect_target_article_id: Option<String>,
    category: String,
    #[serde(default)]
    category_id: Option<String>,
    #[serde(default)]
    summary: String,
    #[serde(default)]
    content: String,
    #[serde(default)]
    calendar_profile: Option<CalendarProfileFile>,
    #[serde(default)]
    document_sections: Vec<DocumentSectionFile>,
    #[serde(default)]
    tags: Vec<Option<String>>,
    #[serde(default)]
    linked_map_entity_ids: Vec<String>,
    #[serde(default)]
    source_map_id: Option<String>,
    #[serde(default)]
    source_entity_id: Option<String>,
    #[serde(default)]
    person_profile: Option<Value>,
    #[serde(default)]
    family_profile: Option<Value>,
    #[serde(default)]
    item_profile: Option<Value>,
    #[serde(default)]
    religion_profile: Option<Value>,
    #[serde(default)]
    culture_profile: Option<Value>,
    #[serde(default)]
    technology_profile: Option<Value>,
    #[serde(default)]
    disease_profile: Option<Value>,
    #[serde(default)]
    government_profile: Option<Value>,
    #[serde(default)]
    event_profile: Option<Value>,
    #[serde(default)]
    faction_profile: Option<Value>,
    #[serde(default)]
    rpg_data: Option<Value>,
    #[serde(default)]
    nature_profile: Option<Value>,
    #[serde(default)]
    place_profile: Option<Value>,
    #[serde(default)]
    ideology_profile: Option<Value>,
    #[serde(default)]
    language_profile: Option<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DocumentSectionFile {
    id: String,
    title: String,
    #[serde(default)]
    content: String,
    #[serde(default)]
    parent_id: Option<String>,
    #[serde(default = "default_section_level")]
    level: u8,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CalendarProfileFile {
    #[serde(default)]
    calendar_name: String,
    #[serde(default)]
    creator: String,
    #[serde(default)]
    creator_article_id: Option<String>,
    #[serde(default)]
    created_at_year: Option<i32>,
    #[serde(default)]
    created_at_absolute_day: Option<f64>,
    #[serde(default)]
    user_faction_ids: Vec<String>,
    #[serde(default)]
    mechanism: String,
    #[serde(default = "default_calendar_display_mode")]
    display_mode: String,
    #[serde(default)]
    epoch_world_year: i32,
    #[serde(default)]
    epoch_absolute_day: Option<f64>,
    #[serde(default)]
    before_era_name: String,
    #[serde(default)]
    after_era_name: String,
    #[serde(default)]
    before_era_short_name: String,
    #[serde(default)]
    after_era_short_name: String,
    #[serde(default)]
    date_units: Vec<CalendarUnitFile>,
    #[serde(default)]
    time_units: Vec<CalendarUnitFile>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CalendarUnitFile {
    #[serde(default)]
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    short_name: String,
    #[serde(default = "default_units_per_parent")]
    units_per_parent: u32,
}

fn default_units_per_parent() -> u32 {
    1
}

fn convert_calendar_profile(profile: CalendarProfileFile) -> CalendarProfile {
    CalendarProfile {
        calendar_name: profile.calendar_name,
        creator: profile.creator,
        creator_article_id: profile.creator_article_id,
        created_at_year: profile.created_at_year,
        created_at_absolute_day: profile.created_at_absolute_day,
        user_faction_ids: profile.user_faction_ids,
        mechanism: profile.mechanism,
        display_mode: profile.display_mode,
        epoch_world_year: profile.epoch_world_year,
        epoch_absolute_day: profile.epoch_absolute_day,
        before_era_name: profile.before_era_name,
        after_era_name: profile.after_era_name,
        before_era_short_name: profile.before_era_short_name,
        after_era_short_name: profile.after_era_short_name,
        date_units: profile
            .date_units
            .into_iter()
            .map(|unit| CalendarUnit {
                id: unit.id,
                name: unit.name,
                short_name: unit.short_name,
                units_per_parent: unit.units_per_parent.max(1),
            })
            .collect(),
        time_units: profile
            .time_units
            .into_iter()
            .map(|unit| CalendarUnit {
                id: unit.id,
                name: unit.name,
                short_name: unit.short_name,
                units_per_parent: unit.units_per_parent.max(1),
            })
            .collect(),
    }
}

fn convert_heraldic_asset(asset: HeraldicAssetFile) -> HeraldicAsset {
    let emblem = asset.kind == "coatOfArms" || asset.kind == "emblem";
    let shape = heraldry_shape(&asset.shape, emblem);
    let mut layers = asset
        .layers
        .into_iter()
        .filter_map(convert_heraldic_layer)
        .collect::<Vec<_>>();
    if layers.is_empty() {
        layers.push(HeraldryLayer::new(
            LayerArtwork::Solid,
            parse_hex_color(&asset.background_color, [39, 88, 126, 255]),
        ));
        if !asset.pattern.is_empty() && asset.pattern != "solid" {
            let mut layer = HeraldryLayer::new(
                heraldry_pattern(&asset.pattern),
                parse_hex_color(&asset.pattern_color, [228, 207, 112, 255]),
            );
            layer.scale = normalize_percent(asset.pattern_scale.unwrap_or(1.0));
            layers.push(layer);
        }
        if !asset.symbol.is_empty() && asset.symbol != "none" {
            let mut layer = HeraldryLayer::new(
                heraldry_symbol(&asset.symbol),
                parse_hex_color(&asset.symbol_color, [246, 248, 250, 255]),
            );
            layer.scale = normalize_percent(asset.symbol_scale.unwrap_or(0.62));
            layer.x = normalize_offset(asset.symbol_offset_x.unwrap_or(0.0));
            layer.y = normalize_offset(asset.symbol_offset_y.unwrap_or(0.0));
            layers.push(layer);
        }
    }
    HeraldicAsset {
        id: asset.id,
        kind: asset.kind,
        name: asset.name,
        design: HeraldryDesign { shape, layers },
    }
}

fn convert_heraldic_layer(layer: HeraldicLayerFile) -> Option<HeraldryLayer> {
    let artwork = match layer.kind.as_str() {
        "pattern" => heraldry_pattern(layer.pattern.as_deref().unwrap_or("solid")),
        "symbol" => heraldry_symbol(layer.symbol.as_deref().unwrap_or("none")),
        _ => return None,
    };
    let mut converted =
        HeraldryLayer::new(artwork, parse_hex_color(&layer.color, [245, 247, 250, 255]));
    converted.visible = layer.visible;
    converted.locked = layer.locked;
    converted.secondary_color = parse_hex_color(
        layer.secondary_color.as_deref().unwrap_or(""),
        [229, 207, 108, 255],
    );
    converted.scale = normalize_percent((layer.scale_x.abs() + layer.scale_y.abs()) * 0.5);
    converted.opacity = normalize_percent(layer.opacity);
    converted.x = normalize_offset(layer.offset_x);
    converted.y = normalize_offset(layer.offset_y);
    converted.angle = layer.rotation;
    converted.flip_x = layer.flip_x;
    converted.flip_y = layer.flip_y;
    Some(converted)
}

fn heraldry_shape(shape: &str, emblem: bool) -> HeraldryShape {
    match shape {
        "rectangle_swallowtail" => HeraldryShape::SwallowtailRectangle,
        "square" => HeraldryShape::Square,
        "square_swallowtail" => HeraldryShape::SwallowtailSquare,
        "triangle" => HeraldryShape::Triangle,
        "shield" => HeraldryShape::Shield,
        "circle" => HeraldryShape::Circle,
        "diamond" => HeraldryShape::Diamond,
        _ if emblem => HeraldryShape::Shield,
        _ => HeraldryShape::Rectangle,
    }
}

fn heraldry_pattern(pattern: &str) -> LayerArtwork {
    match pattern {
        "per_pale" | "pale" | "paly" | "stripes" => LayerArtwork::Vertical,
        "per_fess" | "fess" | "barry" => LayerArtwork::Horizontal,
        "per_bend" | "per_bend_sinister" | "bend" | "bend_sinister" | "bendy" => {
            LayerArtwork::Diagonal
        }
        "per_chevron" | "chevron" => LayerArtwork::Chevron,
        "cross" | "saltire" | "per_saltire" => LayerArtwork::Cross,
        "checkered" | "grid" | "quarterly" | "lozengy" => LayerArtwork::Checkered,
        _ => LayerArtwork::Solid,
    }
}

fn heraldry_symbol(symbol: &str) -> LayerArtwork {
    match symbol {
        "circle" | "roundel" => LayerArtwork::Circle,
        "square" => LayerArtwork::Square,
        "triangle" => LayerArtwork::Triangle,
        "star" => LayerArtwork::Star,
        "diamond" | "lozenge" => LayerArtwork::Diamond,
        "shield" | "spade" => LayerArtwork::Shield,
        "castle" | "tower" | "fortress_wall" => LayerArtwork::Tower,
        "crown" | "palm" => LayerArtwork::Crown,
        "fleur_de_lis" => LayerArtwork::FleurDeLis,
        "lion" => LayerArtwork::Lion,
        "eagle" => LayerArtwork::Eagle,
        "sword" => LayerArtwork::Sword,
        "key" => LayerArtwork::Key,
        "oak_leaf" | "leaf" => LayerArtwork::OakLeaf,
        "sun" => LayerArtwork::Sun,
        "heart" => LayerArtwork::Heart,
        "cross" => LayerArtwork::Cross,
        "iron_cross" => LayerArtwork::IronCross,
        "gear" => LayerArtwork::Gear,
        "book" => LayerArtwork::Book,
        "ring" | "annulet" => LayerArtwork::Ring,
        "hollow_square" => LayerArtwork::HollowSquare,
        "hollow_triangle" => LayerArtwork::HollowTriangle,
        "hollow_star" => LayerArtwork::HollowStar,
        "mascle" => LayerArtwork::HollowDiamond,
        "hollow_shield" => LayerArtwork::HollowShield,
        "crescent_star" | "crescent" => LayerArtwork::CrescentStar,
        "interwoven_knot" => LayerArtwork::UrdrKnot,
        _ => LayerArtwork::Diamond,
    }
}

fn parse_hex_color(value: &str, fallback: [u8; 4]) -> [u8; 4] {
    let value = value.trim().trim_start_matches('#');
    if value.len() != 6 && value.len() != 8 {
        return fallback;
    }
    let parsed = u32::from_str_radix(value, 16).ok();
    match (parsed, value.len()) {
        (Some(color), 6) => [
            ((color >> 16) & 0xff) as u8,
            ((color >> 8) & 0xff) as u8,
            (color & 0xff) as u8,
            255,
        ],
        (Some(color), 8) => [
            ((color >> 24) & 0xff) as u8,
            ((color >> 16) & 0xff) as u8,
            ((color >> 8) & 0xff) as u8,
            (color & 0xff) as u8,
        ],
        _ => fallback,
    }
}

fn normalize_percent(value: f32) -> f32 {
    if value.abs() <= 2.0 {
        value.abs() * 100.0
    } else {
        value.abs()
    }
    .clamp(1.0, 200.0)
}

fn normalize_offset(value: f32) -> f32 {
    if value.abs() <= 2.0 {
        value * 100.0
    } else {
        value
    }
    .clamp(-100.0, 100.0)
}

fn contains_hangul(value: &str) -> bool {
    value.chars().any(
        |character| matches!(character as u32, 0x1100..=0x11ff | 0x3130..=0x318f | 0xac00..=0xd7af),
    )
}

fn normalize_religion_profile(value: Option<Value>) -> Option<Value> {
    let mut profile = value?.as_object()?.clone();
    let has_sections = profile
        .get("doctrineSections")
        .and_then(Value::as_array)
        .is_some_and(|sections| !sections.is_empty());
    if !has_sections {
        let labels = [
            ("cosmology", "우주관"),
            ("divinity", "신관"),
            ("revelation", "계시"),
            ("ethics", "윤리"),
            ("ritual", "의례"),
            ("afterlife", "사후관"),
            ("clergy", "성직 체계"),
            ("sacredTexts", "경전"),
            ("prohibitions", "금기"),
            ("organization", "조직"),
        ];
        let sections = profile
            .get("doctrine")
            .and_then(Value::as_object)
            .map(|doctrine| {
                labels
                    .iter()
                    .enumerate()
                    .filter_map(|(order, (key, title))| {
                        let content = doctrine.get(*key)?.as_str()?.trim();
                        (!content.is_empty()).then(|| {
                            serde_json::json!({
                                "id": format!("legacy-doctrine-{order}"),
                                "title": title,
                                "content": content,
                                "parentId": Value::Null,
                                "order": order,
                            })
                        })
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        profile.insert("doctrineSections".to_owned(), Value::Array(sections));
    }
    if !profile.contains_key("foundingPeriod") {
        let value = profile
            .get("foundingYear")
            .map(|year| Value::String(year.to_string()))
            .unwrap_or_else(|| Value::String(String::new()));
        profile.insert("foundingPeriod".to_owned(), value);
    }
    if !profile.contains_key("religiousInstitutions") {
        let value = profile
            .get("relatedOrganizationIds")
            .cloned()
            .unwrap_or_else(|| Value::Array(Vec::new()));
        profile.insert("religiousInstitutions".to_owned(), value);
    }
    for key in [
        "traditionLineage",
        "founder",
        "holyCity",
        "adherentPopulation",
    ] {
        profile
            .entry(key.to_owned())
            .or_insert_with(|| Value::String(String::new()));
    }
    for key in ["distributionRegions", "scriptures", "majorDenominations"] {
        profile
            .entry(key.to_owned())
            .or_insert_with(|| Value::Array(Vec::new()));
    }
    profile.remove("doctrine");
    Some(Value::Object(profile))
}

fn normalize_person_profile(value: Option<Value>) -> Option<Value> {
    let mut value = value?;
    let object = value.as_object_mut()?;
    let strings = |value: Option<&Value>| -> Vec<String> {
        match value {
            Some(Value::String(id)) if !id.is_empty() => vec![id.clone()],
            Some(Value::Array(ids)) => ids
                .iter()
                .filter_map(Value::as_str)
                .filter(|id| !id.is_empty())
                .map(str::to_owned)
                .collect(),
            _ => Vec::new(),
        }
    };
    if !object.contains_key("nationalityArticleIds") {
        object.insert(
            "nationalityArticleIds".to_owned(),
            Value::Array(
                strings(object.get("countryArticleId"))
                    .into_iter()
                    .map(Value::String)
                    .collect(),
            ),
        );
    }
    if !object.contains_key("affiliationArticleIds") {
        let mut ids = strings(object.get("primaryAffiliationArticleId"));
        ids.extend(strings(object.get("organizationArticleIds")));
        ids.extend(strings(object.get("factionArticleIds")));
        ids.sort();
        ids.dedup();
        object.insert(
            "affiliationArticleIds".to_owned(),
            Value::Array(ids.into_iter().map(Value::String).collect()),
        );
    }
    if !object.contains_key("religionArticleIds") {
        object.insert(
            "religionArticleIds".to_owned(),
            Value::Array(
                strings(object.get("religionArticleId"))
                    .into_iter()
                    .map(Value::String)
                    .collect(),
            ),
        );
    }
    for key in ["languageArticleIds", "ideologyArticleIds"] {
        object
            .entry(key.to_owned())
            .or_insert_with(|| Value::Array(Vec::new()));
    }
    Some(value)
}

fn normalize_faction_profile(value: Option<Value>) -> Option<Value> {
    let mut value = value?;
    let object = value.as_object_mut()?;
    if object.get("kind").and_then(Value::as_str) == Some("country") {
        let country = object
            .entry("countryProfile".to_owned())
            .or_insert_with(|| serde_json::json!({}))
            .as_object_mut()?;
        for key in [
            "locationIds",
            "predecessorArticleIds",
            "successorArticleIds",
        ] {
            country
                .entry(key.to_owned())
                .or_insert_with(|| Value::Array(Vec::new()));
        }
        if !country.contains_key("capitalPeriods") {
            let periods = country
                .get("capitalLocationId")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .map(|id| vec![serde_json::json!({ "id": "legacy-capital", "locationId": id })])
                .unwrap_or_default();
            country.insert("capitalPeriods".to_owned(), Value::Array(periods));
        }
        if !country.contains_key("religionArticleIds") {
            let religions = country
                .get("stateReligionArticleId")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .map(|id| vec![Value::String(id.to_owned())])
                .unwrap_or_default();
            country.insert("religionArticleIds".to_owned(), Value::Array(religions));
        }
    } else {
        let group = object
            .entry("groupProfile".to_owned())
            .or_insert_with(|| serde_json::json!({}))
            .as_object_mut()?;
        group
            .entry("scale".to_owned())
            .or_insert_with(|| Value::String(String::new()));
        if !group.contains_key("purpose") {
            let purpose = group
                .get("goals")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            group.insert("purpose".to_owned(), Value::String(purpose));
        }
    }
    Some(value)
}

fn normalize_event_profile(value: Option<Value>) -> Option<Value> {
    let mut profile = value?.as_object()?.clone();
    if let Some(participants) = profile
        .get_mut("participants")
        .and_then(Value::as_array_mut)
    {
        for participant in participants {
            let Some(participant) = participant.as_object_mut() else {
                continue;
            };
            if !participant.contains_key("representativeLeaderName") {
                participant.insert(
                    "representativeLeaderName".to_owned(),
                    participant
                        .get("keyFigures")
                        .cloned()
                        .unwrap_or_else(|| Value::String(String::new())),
                );
            }
            if !participant.contains_key("participationScale") {
                participant.insert(
                    "participationScale".to_owned(),
                    participant
                        .get("scale")
                        .cloned()
                        .unwrap_or_else(|| Value::String(String::new())),
                );
            }
            for key in ["otherLeaderArticleIds", "otherLeaderNames"] {
                participant
                    .entry(key.to_owned())
                    .or_insert_with(|| Value::Array(Vec::new()));
            }
        }
    }
    Some(Value::Object(profile))
}

impl LoadedWorld {
    pub fn load_demo(language: Language) -> Result<Self, String> {
        if let Some(bytes) = resources::read_native_demo(language)? {
            let mut decoder = GzDecoder::new(bytes.as_slice());
            let mut json = String::new();
            decoder
                .read_to_string(&mut json)
                .map_err(|error| error.to_string())?;
            let mut world: Self = serde_json::from_str(&json).map_err(|error| error.to_string())?;
            world.map.rebuild_canonical_surface();
            if world.maps.is_empty() {
                world.maps.push(world.map.clone());
            }
            for map in &mut world.maps {
                map.rebuild_canonical_surface();
            }
            world.reconcile_spatial_architecture();
            return Ok(world);
        }
        Self::load_legacy_demo(language)
    }

    pub(crate) fn load_legacy_demo(language: Language) -> Result<Self, String> {
        let bytes = resources::read_demo(language)?;
        let mut decoder = GzDecoder::new(bytes.as_slice());
        let mut json = String::new();
        decoder
            .read_to_string(&mut json)
            .map_err(|error| error.to_string())?;
        let project: ProjectFile =
            serde_json::from_str(&json).map_err(|error| error.to_string())?;
        Self::from_project(project)
    }

    fn from_project(project: ProjectFile) -> Result<Self, String> {
        let dictionaries = project.dictionaries;
        let character_folders = project.character_folders;
        let generated_glyphs = project.generated_glyphs;
        let character_charts = project.character_charts;
        let heraldic_assets = project
            .heraldic_assets
            .into_iter()
            .map(convert_heraldic_asset)
            .collect::<Vec<_>>();
        let rpg_enabled = project.rpg_settings.is_some();
        let magic_enabled = project
            .rpg_settings
            .as_ref()
            .is_some_and(|settings| settings.magic_enabled);
        let world_settings = project.world_settings.unwrap_or_default();
        let active_map_id = project.active_map_id.clone();
        let maps = project
            .maps
            .into_iter()
            .map(Self::convert_map)
            .collect::<Result<Vec<_>, _>>()?;
        if maps.is_empty() {
            return Err("The demo has no map.".to_owned());
        }
        let active_index = active_map_id
            .as_deref()
            .and_then(|id| maps.iter().position(|map| map.source_id == id))
            .unwrap_or(0);
        let map = maps[active_index].clone();
        let factions = map.factions.clone();
        let events = map.events.clone();
        let articles = project
            .wiki_articles
            .into_iter()
            .map(|article| {
                let article_id = article.id;
                let mut sections = article
                    .document_sections
                    .into_iter()
                    .map(|section| DocumentSection {
                        id: section.id,
                        title: section.title,
                        content: section.content,
                        parent_id: section.parent_id,
                        level: section.level.clamp(1, 4),
                    })
                    .collect::<Vec<_>>();
                if sections.is_empty() {
                    let korean = contains_hangul(&article.title)
                        || contains_hangul(&article.summary)
                        || contains_hangul(&article.content);
                    if !article.summary.trim().is_empty() {
                        sections.push(DocumentSection {
                            id: format!("legacy-{article_id}-summary"),
                            title: if korean { "개요" } else { "Overview" }.to_owned(),
                            content: article.summary.clone(),
                            parent_id: None,
                            level: 1,
                        });
                    }
                    if !article.content.trim().is_empty() {
                        sections.push(DocumentSection {
                            id: format!("legacy-{article_id}-content"),
                            title: if korean { "기록" } else { "Record" }.to_owned(),
                            content: article.content.clone(),
                            parent_id: None,
                            level: 1,
                        });
                    }
                }
                Article {
                    id: article_id,
                    title: article.title,
                    wiki_aliases: article.wiki_aliases,
                    redirect_target_article_id: article.redirect_target_article_id,
                    category: article.category,
                    category_id: article.category_id,
                    summary: String::new(),
                    content: String::new(),
                    calendar_profile: article.calendar_profile.map(convert_calendar_profile),
                    document_sections: sections,
                    tags: article.tags.into_iter().flatten().collect(),
                    linked_map_entity_ids: article.linked_map_entity_ids,
                    source_map_id: article.source_map_id,
                    source_entity_id: article.source_entity_id,
                    profiles: ArticleProfiles {
                        person: normalize_person_profile(article.person_profile),
                        family: article.family_profile,
                        item: article.item_profile,
                        religion: normalize_religion_profile(article.religion_profile),
                        culture: article.culture_profile,
                        technology: article.technology_profile,
                        disease: article.disease_profile,
                        government: article.government_profile,
                        event: normalize_event_profile(article.event_profile),
                        faction: normalize_faction_profile(article.faction_profile),
                        rpg: article.rpg_data,
                        nature: article.nature_profile,
                        place: article.place_profile,
                        ideology: article.ideology_profile,
                        language: article.language_profile,
                    },
                }
            })
            .collect();
        let project_description = project.description;
        let project_sections = project_sections_from_legacy_description(&project_description);
        let mut world = Self {
            title: project.title,
            description: project_description,
            project_sections,
            map,
            maps,
            planet: PlanetState::default(),
            regions: Vec::new(),
            detailed_regions: Vec::new(),
            map_views: Vec::new(),
            articles,
            categories: project
                .wiki_categories
                .into_iter()
                .map(|category| WikiCategory {
                    id: category.id,
                    name: category.name,
                    parent_id: category.parent_id,
                    system_key: category.system_key,
                    template_key: category.template_key,
                })
                .collect(),
            factions,
            events,
            heraldic_assets,
            dictionaries,
            character_folders,
            generated_glyphs,
            character_charts,
            speech_assets: Vec::new(),
            timeline_calendar_article_id: project.timeline_calendar_article_id,
            rpg_enabled,
            magic_enabled,
            latitude_deg: world_settings.latitude_deg,
            axial_tilt_deg: world_settings.axial_tilt_deg,
            day_length_hours: world_settings.day_length_hours,
            gravity_ms2: world_settings.gravity_ms2,
            orbital_period_days: world_settings.orbital_period_days,
        };
        world.migrate_language_document_data();
        world.reconcile_spatial_architecture();
        Ok(world)
    }

    fn convert_map(map: MapFile) -> Result<NativeMap, String> {
        let environment_seed = map
            .generator_seed_history
            .last()
            .map(|entry| entry.seed)
            .unwrap_or(4_271_991);
        let climate_model = map
            .generator_seed_history
            .last()
            .map(|entry| entry.settings.climate_preset.as_str())
            .map(|preset| match preset {
                "Dfb" | "Dfc" => 1,
                "Af" | "Am" | "Aw" => 2,
                "BWh" | "BWk" | "BSh" | "BSk" => 3,
                "ET" | "EF" => 4,
                _ => 0,
            })
            .unwrap_or(0);
        let generated = map
            .generated_states
            .into_iter()
            .last()
            .ok_or("A map has no generated terrain.")?
            .value;
        let source_width = generated.world_width.max(map.width).max(1.0);
        let source_height = generated.world_height.max(map.height).max(1.0);
        let physical_width = map
            .generator_seed_history
            .last()
            .and_then(|entry| entry.settings.map_scale_km)
            .filter(|value| value.is_finite() && *value > 0.0)
            .unwrap_or(source_width);
        let coordinate_scale = physical_width / source_width;
        let physical_height = source_height * coordinate_scale;
        let scale_point = |point: Point| Point {
            x: point.x * coordinate_scale,
            y: point.y * coordinate_scale,
        };
        let factions = map
            .factions
            .into_iter()
            .map(|faction| Faction {
                id: faction.id,
                name: faction.name,
                color: faction.color,
                kind: faction.kind,
                has_territory: faction.has_territory,
                flag_asset_id: faction.flag_asset_id,
                emblem_asset_id: faction.coat_of_arms_asset_id,
                profile: faction.country_profile.or(faction.group_profile),
            })
            .collect::<Vec<_>>();
        let territories = map
            .territories
            .into_iter()
            .map(|territory| Territory {
                id: territory.id,
                name: territory.name,
                states: territory
                    .states
                    .into_iter()
                    .map(|state| {
                        let mut parts = state
                            .value
                            .parts
                            .into_iter()
                            .map(|part| TerritoryPart {
                                polygon: part.polygon.into_iter().map(scale_point).collect(),
                                holes: part
                                    .holes
                                    .into_iter()
                                    .map(|hole| hole.into_iter().map(scale_point).collect())
                                    .collect(),
                            })
                            .collect::<Vec<_>>();
                        if parts.is_empty() && !state.value.polygon.is_empty() {
                            parts.push(TerritoryPart {
                                polygon: state.value.polygon.into_iter().map(scale_point).collect(),
                                holes: state
                                    .value
                                    .holes
                                    .into_iter()
                                    .map(|hole| hole.into_iter().map(scale_point).collect())
                                    .collect(),
                            });
                        }
                        TerritoryTemporalState {
                            start_year: state.start_year,
                            end_year: state.end_year,
                            owner_faction_id: state.value.owner_faction_id,
                            parts,
                        }
                    })
                    .collect(),
            })
            .collect::<Vec<_>>();
        let mut generation_settings = crate::generator::MapGenerationSettings::default();
        generation_settings.map_size_km = physical_width as f64;
        generation_settings.map_height_km = physical_height as f64;
        generation_settings.map_size_mode = crate::generator::MapSizeMode::Independent;
        generation_settings.seed = environment_seed;
        generation_settings.maximum_elevation_m = generated
            .elevation_map
            .iter()
            .copied()
            .fold(50.0_f32, f32::max) as f64;
        generation_settings.elevation_span_m = (generation_settings.maximum_elevation_m
            - generated
                .elevation_map
                .iter()
                .copied()
                .fold(0.0_f32, f32::min) as f64)
            .clamp(0.0, 20_000.0);
        let mut native = NativeMap {
            source_id: map.id,
            region_id: None,
            map_view_id: None,
            title: map.title,
            width: physical_width,
            height: physical_height,
            logical_pixel_width: (physical_width * NativeMap::LOGICAL_PIXELS_PER_KM)
                .round()
                .max(1.0) as u32,
            logical_pixel_height: (physical_height * NativeMap::LOGICAL_PIXELS_PER_KM)
                .round()
                .max(1.0) as u32,
            surface_cell_m: NativeMap::SURFACE_CELL_METERS as f32,
            grid_width: generated.grid_width,
            grid_height: generated.grid_height,
            sea_level: generated.sea_level,
            climate_model,
            environment_seed,
            generation_settings: Some(generation_settings),
            geologic_guide: None,
            causal_geology: CausalGeologyModel::default(),
            generation_diagnostics: GenerationDiagnostics::default(),
            elevation: generated.elevation_map,
            terrain: generated.terrain_map,
            water: generated.water_type_map,
            temperature: generated.temperature_map,
            precipitation: generated.precipitation_map,
            moisture: generated.moisture_map,
            humidity: generated.relative_humidity_map,
            runoff: generated.runoff_map,
            wind_x: generated.wind_x_map,
            wind_y: generated.wind_y_map,
            solar_hours: generated.solar_hours_map,
            solar_irradiance: generated.solar_irradiance_map,
            snowfall: generated.snowfall_map,
            snow_cover: generated.snow_cover_map,
            evapotranspiration: generated.evapotranspiration_map,
            flow_accumulation: generated.flow_accumulation_map,
            river_order: generated.river_order_map,
            roads: map
                .roads
                .into_iter()
                .map(|road| PathLine {
                    nodes: road.nodes.into_iter().map(scale_point).collect(),
                })
                .collect(),
            place_names: map
                .place_names
                .into_iter()
                .map(|place| PlaceName {
                    id: place.id,
                    article_id: place.article_id,
                    name: place.name,
                    position: scale_point(place.position),
                    path: place.path.into_iter().map(scale_point).collect(),
                    start_year: place.start_year,
                    end_year: place.end_year,
                    font_size: place.font_size,
                    letter_spacing: place.letter_spacing,
                    bold: place.bold,
                    italic: place.italic,
                })
                .collect(),
            rivers: generated
                .rivers
                .into_iter()
                .map(|river| RiverSegment {
                    start: scale_point(river.start),
                    end: scale_point(river.end),
                    width: river.width * coordinate_scale,
                    discharge: river.flow,
                    stream_order: river.order,
                })
                .collect(),
            river_graph: RiverGraph::default(),
            drainage_outlets: Vec::new(),
            locations: map
                .locations
                .into_iter()
                .map(|location| Location {
                    id: location.id,
                    article_id: location.article_id,
                    water_position_warning: false,
                    states: location
                        .states
                        .into_iter()
                        .map(|state| LocationTemporalState {
                            start_year: state.start_year,
                            end_year: state.end_year,
                            name: state.value.name,
                            position: scale_point(state.value.position),
                            population: state.value.population,
                            economy: state.value.economy,
                            location_type: state.value.location_type,
                            description: state.value.description,
                        })
                        .collect(),
                })
                .collect(),
            factions,
            territories,
            territory_owners: Vec::new(),
            territory_history: Vec::new(),
            events: map
                .events
                .into_iter()
                .map(|event| Event {
                    id: event.id,
                    title: event.title,
                    start_year: event.start_year,
                    end_year: event.end_year,
                    location: event.location.map(scale_point),
                    location_history: Vec::new(),
                    article_id: event.article_id,
                    water_position_warning: false,
                })
                .collect(),
            environment_pins: map
                .environment_pins
                .into_iter()
                .map(|pin| EnvironmentPin {
                    id: pin.id,
                    name: pin.name,
                    point: scale_point(pin.position),
                })
                .collect(),
            current_year: map.timeline.current_year,
            canonical_surface: None,
            surface_revision: 0,
        };
        native.rebuild_territory_owners(native.current_year);
        crate::generator::regenerate_hydrology_and_roads(&mut native);
        Ok(native)
    }

    pub fn migrate_language_document_data(&mut self) {
        let mut migrated_words = Vec::<(String, Vec<DictionaryWord>)>::new();
        for article in &mut self.articles {
            let Some(profile) = article
                .profiles
                .language
                .as_mut()
                .and_then(Value::as_object_mut)
            else {
                continue;
            };

            for legacy_key in ["classification", "languageClassification"] {
                let Some(legacy) = profile
                    .remove(legacy_key)
                    .and_then(|value| value.as_object().cloned())
                else {
                    continue;
                };
                for (key, value) in legacy {
                    profile.entry(key).or_insert(value);
                }
            }

            let vocabulary = profile.remove("vocabulary");
            if matches!(
                article.category.as_str(),
                "language_family" | "language_branch" | "language_group"
            ) {
                continue;
            }
            if article.category != "language" {
                if let Some(vocabulary) = vocabulary {
                    profile.insert("vocabulary".to_owned(), vocabulary);
                }
                continue;
            }
            let words = vocabulary
                .and_then(|value| value.as_array().cloned())
                .unwrap_or_default()
                .into_iter()
                .enumerate()
                .filter_map(|(index, value)| dictionary_word_from_legacy(&article.id, index, value))
                .collect::<Vec<_>>();
            if !words.is_empty() {
                migrated_words.push((article.id.clone(), words));
            }
        }

        for (language_article_id, words) in migrated_words {
            let book = self.dictionary_book_mut(&language_article_id);
            for word in words {
                if !book.words.iter().any(|existing| existing.id == word.id) {
                    book.words.push(word);
                }
            }
        }
    }

    pub fn dictionary_book_mut(&mut self, language_article_id: &str) -> &mut DictionaryBook {
        if let Some(index) = self
            .dictionaries
            .iter()
            .position(|book| book.language_article_id == language_article_id)
        {
            return &mut self.dictionaries[index];
        }
        self.dictionaries.push(DictionaryBook {
            language_article_id: language_article_id.to_owned(),
            ..DictionaryBook::default()
        });
        self.dictionaries
            .last_mut()
            .expect("new dictionary book must exist")
    }

    pub fn year_bounds(&self) -> (i32, i32) {
        let years = self.planet_timeline_years();
        let minimum = years.first().copied().unwrap_or(self.map.current_year);
        let maximum = years.last().copied().unwrap_or(self.map.current_year);
        (minimum, maximum.max(minimum + 1))
    }

    pub fn planet_timeline_years(&self) -> Vec<i32> {
        let mut years = BTreeSet::new();
        years.insert(self.map.current_year);
        for map in &self.maps {
            collect_map_timeline_years(map, &mut years);
        }
        for article in &self.articles {
            for profile in [&article.profiles.event, &article.profiles.place]
                .into_iter()
                .flatten()
            {
                collect_value_timeline_years(profile, &mut years);
            }
        }
        years.into_iter().collect()
    }

    pub fn region_active_at(&self, region_id: &str, year: i32) -> bool {
        let maps = self
            .maps
            .iter()
            .filter(|map| map.region_id.as_deref() == Some(region_id))
            .collect::<Vec<_>>();
        if maps.is_empty() {
            return true;
        }
        maps.into_iter().any(|map| {
            map_timeline_bounds(map, &self.articles)
                .is_none_or(|(start, end)| start <= year && year <= end)
        })
    }
}

fn collect_map_timeline_years(map: &NativeMap, years: &mut BTreeSet<i32>) {
    for event in &map.events {
        years.insert(event.start_year);
        years.insert(event.end_year.unwrap_or(event.start_year));
        for state in &event.location_history {
            years.insert(state.start_year);
            years.insert(state.end_year.unwrap_or(state.start_year));
        }
    }
    for location in &map.locations {
        for state in &location.states {
            years.insert(state.start_year);
            years.insert(state.end_year.unwrap_or(state.start_year));
        }
    }
    for place_name in &map.place_names {
        years.insert(place_name.start_year);
        years.insert(place_name.end_year.unwrap_or(place_name.start_year));
    }
    for territory in &map.territories {
        for state in &territory.states {
            years.insert(state.start_year);
            years.insert(state.end_year.unwrap_or(state.start_year));
        }
    }
    for state in &map.territory_history {
        years.insert(state.start_year);
    }
}

fn map_timeline_bounds(map: &NativeMap, articles: &[Article]) -> Option<(i32, i32)> {
    let mut years = BTreeSet::new();
    collect_map_timeline_years(map, &mut years);
    for article in articles
        .iter()
        .filter(|article| article.source_map_id.as_deref() == Some(map.source_id.as_str()))
    {
        for profile in [&article.profiles.event, &article.profiles.place]
            .into_iter()
            .flatten()
        {
            collect_value_timeline_years(profile, &mut years);
        }
    }
    Some((*years.first()?, *years.last()?))
}

fn collect_value_timeline_years(value: &Value, years: &mut BTreeSet<i32>) {
    match value {
        Value::Object(object) => {
            for (key, value) in object {
                if matches!(
                    key.as_str(),
                    "year" | "worldYear" | "startYear" | "endYear" | "formationYear"
                ) {
                    if let Some(year) = value
                        .as_i64()
                        .or_else(|| value.as_f64().map(|value| value.round() as i64))
                        .and_then(|value| i32::try_from(value).ok())
                    {
                        years.insert(year);
                    }
                }
                collect_value_timeline_years(value, years);
            }
        }
        Value::Array(values) => {
            for value in values {
                collect_value_timeline_years(value, years);
            }
        }
        _ => {}
    }
}

fn dictionary_word_from_legacy(
    language_article_id: &str,
    index: usize,
    value: Value,
) -> Option<DictionaryWord> {
    let object = value.as_object()?;
    let text = |key: &str| {
        object
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    let term = text("term");
    if term.trim().is_empty() && text("meaning").trim().is_empty() {
        return None;
    }
    let related_terms = match object.get("relatedTerms") {
        Some(Value::Array(values)) => values
            .iter()
            .filter_map(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .collect(),
        Some(Value::String(value)) => value
            .split([',', '|'])
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .collect(),
        _ => Vec::new(),
    };
    Some(DictionaryWord {
        id: object
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| format!("{language_article_id}-word-{}", index + 1)),
        term,
        pronunciation: text("pronunciation"),
        alphabet_pronunciation: text("alphabetPronunciation"),
        meaning: text("meaning"),
        part_of_speech: text("partOfSpeech"),
        etymology: text("etymology"),
        usage_note: text("usageNote"),
        related_terms,
        script_glyph_ids: Vec::new(),
    })
}

impl LoadedWorld {
    /// Reconciles the Engine 3.7 Planet -> Region -> MapView metadata without
    /// guessing where pre-3.7 planar maps belong on the globe.
    pub fn reconcile_spatial_architecture(&mut self) {
        self.migrate_project_document_sections();
        if self.planet.seed == 0 {
            self.planet.seed = u64::from(self.map.environment_seed);
        }
        if self.planet.generator_version < 2 {
            self.planet.physical.gravity_ms2 = f64::from(self.gravity_ms2);
            self.planet.physical.axial_tilt_deg = f64::from(self.axial_tilt_deg);
            self.planet.physical.day_length_hours = f64::from(self.day_length_hours);
            self.planet.physical.orbital_period_days = f64::from(self.orbital_period_days);
            let mut legacy_config = crate::planet_config::PlanetGenerationConfig::default();
            legacy_config.generator_version = self.planet.generator_version;
            legacy_config.seed = self.planet.seed;
            legacy_config.preset_source = None;
            legacy_config.physical.radius_m = self.planet.physical.radius_m;
            legacy_config.physical.mass_kg = self.planet.physical.gravity_ms2
                * self.planet.physical.radius_m.powi(2)
                / 6.674_30e-11;
            legacy_config.physical.axial_tilt_deg = self.planet.physical.axial_tilt_deg;
            legacy_config.physical.axial_azimuth_deg = self.planet.physical.axial_azimuth_deg;
            legacy_config.physical.rotation_period_hours = self.planet.physical.day_length_hours;
            legacy_config.physical.orbital_period_days = self.planet.physical.orbital_period_days;
            self.planet.generation_config = legacy_config;
        } else {
            let derived = self.planet.generation_config.derived_summary();
            self.planet.seed = self.planet.generation_config.seed;
            self.planet.physical.radius_m = self.planet.generation_config.physical.radius_m;
            self.planet.physical.gravity_ms2 = derived.surface_gravity_ms2;
            self.planet.physical.axial_tilt_deg =
                self.planet.generation_config.physical.axial_tilt_deg;
            self.planet.physical.axial_azimuth_deg =
                self.planet.generation_config.physical.axial_azimuth_deg;
            self.planet.physical.day_length_hours =
                self.planet.generation_config.physical.rotation_period_hours;
            self.planet.physical.orbital_period_days =
                self.planet.generation_config.physical.orbital_period_days;
            self.gravity_ms2 = self.planet.physical.gravity_ms2 as f32;
            self.axial_tilt_deg = self.planet.physical.axial_tilt_deg as f32;
            self.day_length_hours = self.planet.physical.day_length_hours as f32;
            self.orbital_period_days = self.planet.physical.orbital_period_days as f32;
        }
        if self.planet.geology.plates.is_empty() && self.planet.generator_version >= 2 {
            self.planet.geology = CausalGeologyModel::synthesize_with_controls(
                self.planet.generation_config.stable_subseed("geology"),
                &self.planet.generation_config.tectonics,
                &self.planet.generation_config.geology,
            );
        } else {
            self.planet.geology.ensure_synthesized(self.planet.seed);
        }
        if self.planet.surface.is_empty() && self.planet.generator_version >= 2 {
            self.planet.surface = crate::spatial::PlanetSurface::generate(
                &self.planet.generation_config,
                &self.planet.geology,
            );
        }
        if self.map.causal_geology.plates.is_empty() {
            self.map.causal_geology = self.planet.geology.clone();
        }
        if self.map.river_graph.reaches.is_empty() && !self.map.rivers.is_empty() {
            self.map.rebuild_river_graph(true);
        } else if self.map.rivers.is_empty() && !self.map.river_graph.reaches.is_empty() {
            self.map.rivers = self.map.river_graph.to_segments();
        }
        if self.maps.is_empty() && self.map.source_id == "__planet_only__" {
            self.regions.clear();
            self.detailed_regions.clear();
            self.map_views.clear();
            return;
        }
        if self.maps.is_empty() {
            self.maps.push(self.map.clone());
        }

        for map in &mut self.maps {
            if map.causal_geology.plates.is_empty() {
                map.causal_geology = self.planet.geology.clone();
            }
            if map.river_graph.reaches.is_empty() && !map.rivers.is_empty() {
                map.rebuild_river_graph(true);
            } else if map.rivers.is_empty() && !map.river_graph.reaches.is_empty() {
                map.rivers = map.river_graph.to_segments();
            }
            let source_id = if map.source_id.trim().is_empty() {
                format!("legacy-map-{}", self.regions.len() + 1)
            } else {
                map.source_id.clone()
            };
            map.source_id = source_id.clone();
            let explicitly_placed = map.region_id.is_some() && map.map_view_id.is_some();
            let (region, view) = if explicitly_placed {
                let settings = map.generation_settings.as_ref();
                generated_region_and_view(
                    &self.planet,
                    &source_id,
                    &map.title,
                    settings
                        .map(|settings| settings.center_latitude_deg)
                        .unwrap_or(f64::from(self.latitude_deg)),
                    f64::from(map.width),
                    f64::from(map.height),
                    map.logical_pixel_width.max(1),
                    map.logical_pixel_height.max(1),
                )
            } else {
                legacy_region_and_view(
                    &self.planet,
                    &source_id,
                    &map.title,
                    f64::from(map.width),
                    f64::from(map.height),
                    map.logical_pixel_width.max(1),
                    map.logical_pixel_height.max(1),
                )
            };
            let region_id = map.region_id.clone().unwrap_or_else(|| region.id.clone());
            let view_id = map.map_view_id.clone().unwrap_or_else(|| view.id.clone());
            map.region_id = Some(region_id.clone());
            map.map_view_id = Some(view_id.clone());

            if !self.regions.iter().any(|value| value.id == region_id) {
                let mut region = region;
                region.id = region_id;
                self.regions.push(region);
            }
            if !self.map_views.iter().any(|value| value.id == view_id) {
                let mut view = view;
                view.id = view_id;
                view.region_id = map.region_id.clone().unwrap_or(view.region_id);
                self.map_views.push(view);
            }
        }

        if let Some(stored) = self
            .maps
            .iter()
            .find(|map| map.source_id == self.map.source_id)
        {
            self.map.region_id = stored.region_id.clone();
            self.map.map_view_id = stored.map_view_id.clone();
        } else {
            self.maps.push(self.map.clone());
            self.reconcile_spatial_architecture();
        }

        self.detailed_regions.retain(|detail| {
            self.regions
                .iter()
                .any(|region| region.id == detail.region_id)
        });
        for region in &self.regions {
            if self
                .detailed_regions
                .iter()
                .any(|detail| detail.region_id == region.id)
            {
                continue;
            }
            let Some((_, width_m, height_m, _)) = region.selection.metric_bounds() else {
                continue;
            };
            let (output_width_cells, output_height_cells) = region
                .generation_config
                .requested_cell_dimensions(width_m, height_m);
            self.detailed_regions.push(DetailedRegion {
                id: format!("detail-{}", region.id),
                region_id: region.id.clone(),
                planet_id: region.planet_id.clone(),
                patch_refs: region.patch_refs.clone(),
                output_width_cells,
                output_height_cells,
                constraints_checksum: region.selection.stable_checksum(),
                config: region.generation_config.clone(),
                revision: region.revision,
            });
        }
    }

    pub fn migrate_project_document_sections(&mut self) {
        if self.project_sections.is_empty() {
            self.project_sections = project_sections_from_legacy_description(&self.description);
        }
    }

    pub fn active_region(&self) -> Option<&RegionDefinition> {
        self.map
            .region_id
            .as_deref()
            .and_then(|id| self.regions.iter().find(|region| region.id == id))
    }

    pub fn active_map_view(&self) -> Option<&MapViewDefinition> {
        self.map
            .map_view_id
            .as_deref()
            .and_then(|id| self.map_views.iter().find(|view| view.id == id))
    }

    pub fn active_point_to_planet(
        &self,
        point: Point,
    ) -> Result<crate::spatial::PlanetPosition, crate::projection::ProjectionError> {
        let view = self
            .active_map_view()
            .ok_or(crate::projection::ProjectionError::InvalidParameters)?;
        let pixel = crate::spatial::MapPixelPoint {
            x: f64::from(point.x / self.map.width.max(f32::EPSILON))
                * f64::from(view.output_width_px),
            y: f64::from(point.y / self.map.height.max(f32::EPSILON))
                * f64::from(view.output_height_px),
        };
        view.pixel_to_planet(pixel, self.planet.physical.radius_m)
    }

    pub fn planet_to_active_point(
        &self,
        position: crate::spatial::PlanetPosition,
    ) -> Result<Point, crate::projection::ProjectionError> {
        let view = self
            .active_map_view()
            .ok_or(crate::projection::ProjectionError::InvalidParameters)?;
        let pixel = view.planet_to_pixel(position, self.planet.physical.radius_m)?;
        Ok(Point {
            x: (pixel.x / f64::from(view.output_width_px.max(1)) * f64::from(self.map.width))
                as f32,
            y: (pixel.y / f64::from(view.output_height_px.max(1)) * f64::from(self.map.height))
                as f32,
        })
    }

    pub fn display_calendar(&self, language: Language) -> CalendarProfile {
        if self.timeline_calendar_article_id.as_deref() == Some("__standard_orbital__") {
            return standard_orbital_calendar(language);
        }
        let mut profile = self
            .articles
            .iter()
            .find(|article| {
                self.timeline_calendar_article_id.as_deref() == Some(article.id.as_str())
            })
            .and_then(|article| article.calendar_profile.clone())
            .or_else(|| {
                self.articles
                    .iter()
                    .find_map(|article| article.calendar_profile.clone())
            })
            .unwrap_or_else(|| CalendarProfile {
                calendar_name: match language {
                    Language::Korean => "기본 역법".to_owned(),
                    Language::English => "Default Calendar".to_owned(),
                },
                creator: "-".to_owned(),
                creator_article_id: None,
                created_at_year: None,
                created_at_absolute_day: None,
                user_faction_ids: Vec::new(),
                mechanism: String::new(),
                display_mode: "era".to_owned(),
                epoch_world_year: 0,
                epoch_absolute_day: Some(0.0),
                before_era_name: match language {
                    Language::Korean => "기원전".to_owned(),
                    Language::English => "Before Era".to_owned(),
                },
                after_era_name: match language {
                    Language::Korean => "기원후".to_owned(),
                    Language::English => "Current Era".to_owned(),
                },
                before_era_short_name: "BE".to_owned(),
                after_era_short_name: "CE".to_owned(),
                date_units: vec![
                    CalendarUnit {
                        id: "year".to_owned(),
                        name: "년".to_owned(),
                        short_name: "년".to_owned(),
                        units_per_parent: 1,
                    },
                    CalendarUnit {
                        id: "month".to_owned(),
                        name: "월".to_owned(),
                        short_name: "월".to_owned(),
                        units_per_parent: 12,
                    },
                    CalendarUnit {
                        id: "day".to_owned(),
                        name: "일".to_owned(),
                        short_name: "일".to_owned(),
                        units_per_parent: 30,
                    },
                ],
                time_units: vec![
                    CalendarUnit {
                        id: "hour".to_owned(),
                        name: "시".to_owned(),
                        short_name: "시".to_owned(),
                        units_per_parent: 24,
                    },
                    CalendarUnit {
                        id: "minute".to_owned(),
                        name: "분".to_owned(),
                        short_name: "분".to_owned(),
                        units_per_parent: 60,
                    },
                    CalendarUnit {
                        id: "second".to_owned(),
                        name: "초".to_owned(),
                        short_name: "초".to_owned(),
                        units_per_parent: 60,
                    },
                ],
            });
        if language == Language::English {
            let date_names = [("Year", "yr"), ("Month", "mo"), ("Day", "day")];
            let time_names = [("Hour", "h"), ("Minute", "min"), ("Second", "s")];
            for (unit, (name, short)) in profile.date_units.iter_mut().zip(date_names) {
                unit.name = name.to_owned();
                unit.short_name = short.to_owned();
            }
            for (unit, (name, short)) in profile.time_units.iter_mut().zip(time_names) {
                unit.name = name.to_owned();
                unit.short_name = short.to_owned();
            }
        }
        profile
    }
}

pub fn standard_orbital_calendar(language: Language) -> CalendarProfile {
    let (name, year_name, year_short) = match language {
        Language::Korean => ("표준 공전 주기", "공전년", "공전년"),
        Language::English => ("Standard Orbital Period", "Orbital Year", "orbital yr"),
    };
    CalendarProfile {
        calendar_name: name.to_owned(),
        creator: "URDR".to_owned(),
        creator_article_id: None,
        created_at_year: None,
        created_at_absolute_day: None,
        user_faction_ids: Vec::new(),
        mechanism: String::new(),
        display_mode: "plain".to_owned(),
        epoch_world_year: 0,
        epoch_absolute_day: Some(0.0),
        before_era_name: String::new(),
        after_era_name: String::new(),
        before_era_short_name: String::new(),
        after_era_short_name: String::new(),
        date_units: vec![CalendarUnit {
            id: "orbital_year".to_owned(),
            name: year_name.to_owned(),
            short_name: year_short.to_owned(),
            units_per_parent: 1,
        }],
        time_units: Vec::new(),
    }
}

impl Location {
    pub fn state_at(&self, year: i32) -> Option<&LocationTemporalState> {
        self.states
            .iter()
            .rev()
            .find(|state| {
                state.start_year <= year && state.end_year.is_none_or(|end_year| year <= end_year)
            })
            .or_else(|| self.states.last())
    }
}

fn classify_river_terminal(
    surface: Option<&CanonicalSurface>,
    map_width_km: f32,
    map_height_km: f32,
    point: Point,
) -> RiverNodeKind {
    let Some(surface) = surface else {
        return RiverNodeKind::ClosedTerminal;
    };
    let sample_water = |sample_point: Point| {
        let x = (sample_point.x / map_width_km.max(f32::EPSILON) * surface.width as f32)
            .floor()
            .clamp(0.0, surface.width.saturating_sub(1) as f32) as usize;
        let y = (sample_point.y / map_height_km.max(f32::EPSILON) * surface.height as f32)
            .floor()
            .clamp(0.0, surface.height.saturating_sub(1) as f32) as usize;
        surface.sample(x, y).water
    };
    let mut freshwater = false;
    for radius_km in [0.0_f32, 0.1, 0.2, 0.4] {
        for (dx, dy) in [
            (0.0, 0.0),
            (1.0, 0.0),
            (-1.0, 0.0),
            (0.0, 1.0),
            (0.0, -1.0),
            (0.707, 0.707),
            (-0.707, 0.707),
            (0.707, -0.707),
            (-0.707, -0.707),
        ] {
            match sample_water(Point {
                x: (point.x + dx * radius_km).clamp(0.0, map_width_km),
                y: (point.y + dy * radius_km).clamp(0.0, map_height_km),
            }) {
                "saltwater" => return RiverNodeKind::OceanMouth,
                "freshwater" => freshwater = true,
                _ => {}
            }
        }
    }
    if freshwater {
        RiverNodeKind::LakeInlet
    } else if point.x <= 0.1
        || point.y <= 0.1
        || point.x >= map_width_km - 0.1
        || point.y >= map_height_km - 0.1
    {
        RiverNodeKind::BorderContinuation
    } else {
        RiverNodeKind::ClosedTerminal
    }
}

impl NativeMap {
    pub const SURFACE_CELL_METERS: u32 = 100;
    pub const LOGICAL_PIXELS_PER_KM: f32 = 1_000.0 / Self::SURFACE_CELL_METERS as f32;
    /// Retained only as the safety bound for decoding old fully materialized
    /// URS2 payloads. Engine 3.7 no longer eagerly bakes new surfaces.
    pub const MAX_MATERIALIZED_SURFACE_CELLS: u64 = 32_000_000;

    pub fn rebuild_river_graph(&mut self, legacy_derived: bool) {
        self.rebuild_river_graph_with_revision(legacy_derived, 1);
    }

    pub fn rebuild_river_graph_with_revision(
        &mut self,
        legacy_derived: bool,
        geometry_revision: u16,
    ) {
        let mut graph = RiverGraph::from_segments_with_revision(
            &self.source_id,
            &self.rivers,
            legacy_derived,
            geometry_revision,
        );
        let surface = self.canonical_surface.clone();
        let width = self.width;
        let height = self.height;
        graph.classify_terminals(|point| {
            classify_river_terminal(surface.as_deref(), width, height, point)
        });
        self.rivers = graph.to_segments();
        self.river_graph = graph;
    }

    pub fn logical_pixel_dimensions(&self) -> (u32, u32) {
        let pixels_per_km = 1_000.0 / self.surface_cell_m.clamp(10.0, 10_000.0);
        (
            (self.width * pixels_per_km).round().max(1.0) as u32,
            (self.height * pixels_per_km).round().max(1.0) as u32,
        )
    }

    pub fn rebuild_canonical_surface(&mut self) -> bool {
        if self.canonical_surface.is_some() {
            return false;
        }
        let (width, height) = self.logical_pixel_dimensions();
        self.logical_pixel_width = width;
        self.logical_pixel_height = height;
        if width == 0 || height == 0 || self.grid_width == 0 || self.grid_height == 0 {
            self.canonical_surface = None;
            return false;
        }

        let surface = CanonicalSurface::virtual_from_map(self, width, height);
        self.canonical_surface = Some(Arc::new(surface));
        self.surface_revision = self.surface_revision.wrapping_add(1).max(1);
        self.refresh_all_analysis_from_canonical();
        true
    }

    /// Installs a virtual Canonical recipe on a diagnostic clone without
    /// feeding the reconstructed surface back into the authoritative analysis
    /// arrays. Persisted fully materialized surfaces intentionally omit this
    /// recipe, while lineage diagnostics need it to expose component fields.
    pub(crate) fn rebuild_canonical_recipe_for_diagnostics(&mut self) -> bool {
        let (width, height) = self.logical_pixel_dimensions();
        if width == 0 || height == 0 || self.grid_width == 0 || self.grid_height == 0 {
            return false;
        }
        self.logical_pixel_width = width;
        self.logical_pixel_height = height;
        self.canonical_surface = Some(Arc::new(CanonicalSurface::virtual_from_map(
            self, width, height,
        )));
        true
    }

    pub fn canonical_cell_dimensions(&self) -> (usize, usize) {
        self.canonical_surface
            .as_ref()
            .map(|surface| (surface.width as usize, surface.height as usize))
            .unwrap_or_else(|| {
                let (width, height) = self.logical_pixel_dimensions();
                (width as usize, height as usize)
            })
    }

    pub fn canonical_cell_at_world(&self, point: Point) -> (usize, usize) {
        let (width, height) = self.canonical_cell_dimensions();
        let x = ((point.x / self.width.max(f32::EPSILON)) * width as f32)
            .floor()
            .clamp(0.0, width.saturating_sub(1) as f32) as usize;
        let y = ((point.y / self.height.max(f32::EPSILON)) * height as f32)
            .floor()
            .clamp(0.0, height.saturating_sub(1) as f32) as usize;
        (x, y)
    }

    pub fn canonical_sample(&self, x: usize, y: usize) -> SurfaceSample {
        self.canonical_surface
            .as_ref()
            .map(|surface| surface.sample(x, y))
            .unwrap_or(SurfaceSample {
                elevation_m: self.sea_level,
                terrain: "plain",
                water: "land",
            })
    }

    pub fn edit_canonical_cell(
        &mut self,
        x: usize,
        y: usize,
        elevation_m: Option<f32>,
        terrain_name: Option<&str>,
        water_name: Option<&str>,
    ) -> bool {
        let Some(surface_arc) = self.canonical_surface.as_mut() else {
            return false;
        };
        let surface = Arc::make_mut(surface_arc);
        let sample = surface.sample(x, y);
        let changed = surface.set_encoded(
            x as u32,
            y as u32,
            elevation_m
                .unwrap_or(sample.elevation_m)
                .round()
                .clamp(i16::MIN as f32, i16::MAX as f32) as i16,
            terrain_name
                .map(terrain_code)
                .unwrap_or_else(|| surface.encoded(x, y).map(|cell| cell.1).unwrap_or_default()),
            water_name
                .map(water_code)
                .unwrap_or_else(|| surface.encoded(x, y).map(|cell| cell.2).unwrap_or_default()),
        );
        if changed {
            self.surface_revision = self.surface_revision.wrapping_add(1).max(1);
        }
        changed
    }

    pub fn refresh_all_analysis_from_canonical(&mut self) {
        let Some(surface) = self.canonical_surface.as_ref() else {
            return;
        };
        if self.grid_width == 0 || self.grid_height == 0 {
            return;
        }
        let cells = self.grid_width.saturating_mul(self.grid_height);
        self.elevation.resize(cells, self.sea_level);
        self.terrain.resize(cells, "plain".to_owned());
        self.water.resize(cells, "land".to_owned());
        for gy in 0..self.grid_height {
            for gx in 0..self.grid_width {
                let index = gy * self.grid_width + gx;
                let sx = ((gx as f32 + 0.5) * surface.width as f32 / self.grid_width as f32)
                    .floor()
                    .clamp(0.0, surface.width.saturating_sub(1) as f32)
                    as usize;
                let sy = ((gy as f32 + 0.5) * surface.height as f32 / self.grid_height as f32)
                    .floor()
                    .clamp(0.0, surface.height.saturating_sub(1) as f32)
                    as usize;
                let sample = surface.sample(sx, sy);
                self.elevation[index] = sample.elevation_m;
                self.terrain[index] = sample.terrain.to_owned();
                self.water[index] = sample.water.to_owned();
            }
        }
    }

    pub fn refresh_analysis_from_canonical(&mut self, canonical_indices: &[usize]) {
        let Some(surface) = self.canonical_surface.as_ref() else {
            return;
        };
        if canonical_indices.is_empty() || self.grid_width == 0 || self.grid_height == 0 {
            return;
        }
        let surface_width = surface.width as usize;
        let mut analysis_indices = std::collections::HashSet::new();
        for &index in canonical_indices {
            let x = index % surface_width.max(1);
            let y = index / surface_width.max(1);
            let gx = x.saturating_mul(self.grid_width) / surface.width.max(1) as usize;
            let gy = y.saturating_mul(self.grid_height) / surface.height.max(1) as usize;
            analysis_indices.insert(
                gy.min(self.grid_height - 1) * self.grid_width + gx.min(self.grid_width - 1),
            );
        }
        for index in analysis_indices {
            let gx = index % self.grid_width;
            let gy = index / self.grid_width;
            let sx = ((gx as f32 + 0.5) * surface.width as f32 / self.grid_width as f32)
                .floor()
                .clamp(0.0, surface.width.saturating_sub(1) as f32) as usize;
            let sy = ((gy as f32 + 0.5) * surface.height as f32 / self.grid_height as f32)
                .floor()
                .clamp(0.0, surface.height.saturating_sub(1) as f32) as usize;
            let sample = surface.sample(sx, sy);
            if let Some(value) = self.elevation.get_mut(index) {
                *value = sample.elevation_m;
            }
            if let Some(value) = self.terrain.get_mut(index) {
                *value = sample.terrain.to_owned();
            }
            if let Some(value) = self.water.get_mut(index) {
                *value = sample.water.to_owned();
            }
        }
    }

    pub fn surface_sample_at_world(&self, point: Point) -> SurfaceSample {
        if let Some(surface) = &self.canonical_surface {
            let (x, y) = self.canonical_cell_at_world(point);
            return surface.sample(x, y);
        }
        let x = ((point.x / self.width.max(f32::EPSILON)) * self.grid_width as f32)
            .floor()
            .clamp(0.0, self.grid_width.saturating_sub(1) as f32) as usize;
        let y = ((point.y / self.height.max(f32::EPSILON)) * self.grid_height as f32)
            .floor()
            .clamp(0.0, self.grid_height.saturating_sub(1) as f32) as usize;
        let index = y * self.grid_width + x;
        SurfaceSample {
            elevation_m: self.elevation.get(index).copied().unwrap_or(self.sea_level),
            terrain: self
                .terrain
                .get(index)
                .map(String::as_str)
                .map(terrain_static_name)
                .unwrap_or("plain"),
            water: self
                .water
                .get(index)
                .map(String::as_str)
                .map(water_static_name)
                .unwrap_or("land"),
        }
    }

    pub fn territory_owner_at(&self, point: Point, year: i32) -> Option<usize> {
        if point.x < 0.0 || point.y < 0.0 || point.x > self.width || point.y > self.height {
            return None;
        }
        let grid_x = ((point.x / self.width.max(1.0)) * self.grid_width as f32)
            .floor()
            .clamp(0.0, self.grid_width.saturating_sub(1) as f32) as usize;
        let grid_y = ((point.y / self.height.max(1.0)) * self.grid_height as f32)
            .floor()
            .clamp(0.0, self.grid_height.saturating_sub(1) as f32) as usize;
        let index = grid_y * self.grid_width + grid_x;
        if self.surface_sample_at_world(point).water != "land" {
            return None;
        }
        if let Some(state) = self
            .territory_history
            .iter()
            .filter(|state| state.start_year <= year)
            .max_by_key(|state| state.start_year)
        {
            return state
                .owners
                .get(index)
                .copied()
                .and_then(|owner| usize::try_from(owner).ok())
                .filter(|owner| *owner < self.factions.len());
        }
        let mut has_active_temporal_territory = false;
        for territory in self.territories.iter().rev() {
            let Some(state) = territory.states.iter().rev().find(|state| {
                state.start_year <= year && state.end_year.is_none_or(|end| year <= end)
            }) else {
                continue;
            };
            has_active_temporal_territory = true;
            let contains = state.parts.iter().any(|part| {
                point_in_polygon(point, &part.polygon)
                    && !part.holes.iter().any(|hole| point_in_polygon(point, hole))
            });
            if contains {
                return state.owner_faction_id.as_deref().and_then(|owner_id| {
                    self.factions
                        .iter()
                        .position(|faction| faction.id == owner_id)
                });
            }
        }
        if has_active_temporal_territory {
            None
        } else {
            self.territory_owners
                .get(index)
                .copied()
                .and_then(|owner| usize::try_from(owner).ok())
                .filter(|owner| *owner < self.factions.len())
        }
    }

    pub fn rebuild_territory_owners(&mut self, year: i32) {
        let cells = self.grid_width.saturating_mul(self.grid_height);
        let land_mask = self.coarse_canonical_land_mask();
        if let Some(state) = self
            .territory_history
            .iter()
            .filter(|state| state.start_year <= year)
            .max_by_key(|state| state.start_year)
        {
            self.territory_owners = state.owners.clone();
            self.territory_owners.resize(cells, -1);
            for index in 0..cells {
                if !land_mask.get(index).copied().unwrap_or(false) {
                    self.territory_owners[index] = -1;
                }
            }
            return;
        }
        self.territory_owners = vec![-1; cells];
        if cells == 0 {
            return;
        }
        let cell_width = self.width / self.grid_width.max(1) as f32;
        let cell_height = self.height / self.grid_height.max(1) as f32;
        for territory in &self.territories {
            let Some(state) = territory.states.iter().rev().find(|state| {
                state.start_year <= year && state.end_year.is_none_or(|end| year <= end)
            }) else {
                continue;
            };
            let Some(owner_id) = state.owner_faction_id.as_deref() else {
                continue;
            };
            let Some(owner_index) = self
                .factions
                .iter()
                .position(|faction| faction.id == owner_id)
            else {
                continue;
            };
            for part in &state.parts {
                if part.polygon.len() < 3 {
                    continue;
                }
                let min_x = part
                    .polygon
                    .iter()
                    .map(|point| point.x)
                    .fold(f32::INFINITY, f32::min);
                let max_x = part
                    .polygon
                    .iter()
                    .map(|point| point.x)
                    .fold(f32::NEG_INFINITY, f32::max);
                let min_y = part
                    .polygon
                    .iter()
                    .map(|point| point.y)
                    .fold(f32::INFINITY, f32::min);
                let max_y = part
                    .polygon
                    .iter()
                    .map(|point| point.y)
                    .fold(f32::NEG_INFINITY, f32::max);
                let x0 = (min_x / cell_width).floor().max(0.0) as usize;
                let x1 = (max_x / cell_width).ceil().min(self.grid_width as f32) as usize;
                let y0 = (min_y / cell_height).floor().max(0.0) as usize;
                let y1 = (max_y / cell_height).ceil().min(self.grid_height as f32) as usize;
                for y in y0..y1 {
                    for x in x0..x1 {
                        let index = y * self.grid_width + x;
                        if !land_mask.get(index).copied().unwrap_or(false) {
                            continue;
                        }
                        let point = Point {
                            x: (x as f32 + 0.5) * cell_width,
                            y: (y as f32 + 0.5) * cell_height,
                        };
                        if point_in_polygon(point, &part.polygon)
                            && !part.holes.iter().any(|hole| point_in_polygon(point, hole))
                        {
                            self.territory_owners[index] = owner_index as i32;
                        }
                    }
                }
            }
        }
    }

    pub fn record_territory_snapshot(&mut self, year: i32) {
        let cells = self.grid_width.saturating_mul(self.grid_height);
        let land_mask = self.coarse_canonical_land_mask();
        let mut owners = self.territory_owners.clone();
        owners.resize(cells, -1);
        for index in 0..cells {
            if !land_mask.get(index).copied().unwrap_or(false) {
                owners[index] = -1;
            }
        }
        if let Some(state) = self
            .territory_history
            .iter_mut()
            .find(|state| state.start_year == year)
        {
            state.owners = owners;
        } else {
            self.territory_history.push(TerritoryGridState {
                start_year: year,
                owners,
            });
            self.territory_history.sort_by_key(|state| state.start_year);
        }
    }

    fn coarse_canonical_land_mask(&self) -> Vec<bool> {
        let width = self.grid_width.max(1);
        let height = self.grid_height.max(1);
        (0..width.saturating_mul(height))
            .map(|index| {
                let point = Point {
                    x: (index % width) as f32 * self.width / width as f32
                        + self.width / width as f32 * 0.5,
                    y: (index / width) as f32 * self.height / height as f32
                        + self.height / height as f32 * 0.5,
                };
                self.surface_sample_at_world(point).water == "land"
            })
            .collect()
    }

    pub fn rebuild_river_discharge_widths(&mut self) {
        if self.rivers.is_empty() {
            return;
        }
        type Node = (i32, i32);
        let key = |point: Point| -> Node {
            (
                (point.x * 1_000.0).round() as i32,
                (point.y * 1_000.0).round() as i32,
            )
        };
        let mut incoming = std::collections::HashMap::<Node, usize>::new();
        let mut outgoing = std::collections::HashMap::<Node, Vec<usize>>::new();
        for (index, river) in self.rivers.iter().enumerate() {
            *incoming.entry(key(river.end)).or_default() += 1;
            outgoing.entry(key(river.start)).or_default().push(index);
        }
        if self.rivers.iter().any(|river| river.discharge > 0.0) {
            let mut canonical = std::collections::HashMap::<Node, Point>::new();
            for river in &self.rivers {
                canonical.entry(key(river.start)).or_insert(river.start);
                canonical.entry(key(river.end)).or_insert(river.end);
            }
            for river in &mut self.rivers {
                if let Some(point) = canonical.get(&key(river.start)) {
                    river.start = *point;
                }
                if let Some(point) = canonical.get(&key(river.end)) {
                    river.end = *point;
                }
                river.width = river.width.max(0.0025);
            }
            self.rivers.retain(|river| {
                (river.start.x - river.end.x).abs() > 0.000_01
                    || (river.start.y - river.end.y).abs() > 0.000_01
            });
            return;
        }
        let mut queue = std::collections::VecDeque::new();
        for node in outgoing.keys() {
            if incoming.get(node).copied().unwrap_or_default() == 0 {
                queue.push_back(*node);
            }
        }
        let mut flow = std::collections::HashMap::<Node, f32>::new();
        let mut processed = vec![false; self.rivers.len()];
        let map_scale = (self.width.max(self.height) / 500.0).sqrt().clamp(0.6, 2.8);
        while let Some(node) = queue.pop_front() {
            let node_flow = flow.get(&node).copied().unwrap_or(1.0).max(1.0);
            let Some(edges) = outgoing.get(&node) else {
                continue;
            };
            let divided = node_flow / edges.len().max(1) as f32;
            for &edge in edges {
                let end = key(self.rivers[edge].end);
                let discharge = (divided + 1.0).max(1.0);
                self.rivers[edge].width =
                    (0.050 * discharge.powf(0.65)).clamp(0.050, 10.0) * map_scale;
                processed[edge] = true;
                *flow.entry(end).or_default() += discharge;
                if let Some(remaining) = incoming.get_mut(&end) {
                    *remaining = remaining.saturating_sub(1);
                    if *remaining == 0 {
                        queue.push_back(end);
                    }
                }
            }
        }
        for (index, river) in self.rivers.iter_mut().enumerate() {
            if !processed[index] {
                river.width = river.width.max(0.050 * map_scale);
            }
        }
        let mut canonical = std::collections::HashMap::<Node, Point>::new();
        for river in &self.rivers {
            canonical.entry(key(river.start)).or_insert(river.start);
            canonical.entry(key(river.end)).or_insert(river.end);
        }
        for river in &mut self.rivers {
            if let Some(point) = canonical.get(&key(river.start)) {
                river.start = *point;
            }
            if let Some(point) = canonical.get(&key(river.end)) {
                river.end = *point;
            }
        }
        self.rivers.retain(|river| {
            (river.start.x - river.end.x).abs() > 0.000_01
                || (river.start.y - river.end.y).abs() > 0.000_01
        });
    }
}

impl CanonicalSurface {
    pub const CHUNK_SIZE: u32 = 256;

    pub(crate) fn to_streamed_binary(&self) -> Result<Vec<u8>, String> {
        canonical_surface_serde::encode_streamed_raw(self)
    }

    pub(crate) fn from_streamed_binary(bytes: &[u8]) -> Result<Arc<Self>, String> {
        canonical_surface_serde::decode_streamed_raw(bytes)
    }

    fn virtual_from_map(map: &NativeMap, width: u32, height: u32) -> Self {
        let chunks_x = width.div_ceil(Self::CHUNK_SIZE);
        let chunks_y = height.div_ceil(Self::CHUNK_SIZE);
        Self {
            width,
            height,
            chunks_x,
            chunks_y,
            chunks: vec![None; (chunks_x * chunks_y) as usize],
            recipe: Some(CanonicalSurfaceRecipe::from_map(map)),
        }
    }

    pub(crate) fn generate(
        width: u32,
        height: u32,
        mut cell: impl FnMut(u32, u32) -> (i16, u8, u8),
    ) -> Self {
        let chunks_x = width.div_ceil(Self::CHUNK_SIZE);
        let chunks_y = height.div_ceil(Self::CHUNK_SIZE);
        let mut chunks = Vec::with_capacity((chunks_x * chunks_y) as usize);
        for chunk_y in 0..chunks_y {
            for chunk_x in 0..chunks_x {
                let origin_x = chunk_x * Self::CHUNK_SIZE;
                let origin_y = chunk_y * Self::CHUNK_SIZE;
                let chunk_width = (width - origin_x).min(Self::CHUNK_SIZE) as u16;
                let chunk_height = (height - origin_y).min(Self::CHUNK_SIZE) as u16;
                let count = chunk_width as usize * chunk_height as usize;
                let mut elevation_m = Vec::with_capacity(count);
                let mut terrain = Vec::with_capacity(count);
                let mut water = Vec::with_capacity(count);
                for local_y in 0..u32::from(chunk_height) {
                    for local_x in 0..u32::from(chunk_width) {
                        let (elevation, terrain_code, water_code) =
                            cell(origin_x + local_x, origin_y + local_y);
                        elevation_m.push(elevation);
                        terrain.push(terrain_code);
                        water.push(water_code);
                    }
                }
                chunks.push(Some(Arc::new(SurfaceChunk {
                    width: chunk_width,
                    height: chunk_height,
                    revision: 0,
                    elevation_m: elevation_m.into_boxed_slice(),
                    terrain: terrain.into_boxed_slice(),
                    water: water.into_boxed_slice(),
                })));
            }
        }
        Self {
            width,
            height,
            chunks_x,
            chunks_y,
            chunks,
            recipe: None,
        }
    }

    fn chunk_and_local_index(&self, x: usize, y: usize) -> Option<(usize, usize)> {
        if x >= self.width as usize || y >= self.height as usize {
            return None;
        }
        let chunk_x = x as u32 / Self::CHUNK_SIZE;
        let chunk_y = y as u32 / Self::CHUNK_SIZE;
        let chunk_index = (chunk_y * self.chunks_x + chunk_x) as usize;
        self.chunks.get(chunk_index)?;
        let local_x = x as u32 % Self::CHUNK_SIZE;
        let local_y = y as u32 % Self::CHUNK_SIZE;
        let chunk_width = (self.width - chunk_x * Self::CHUNK_SIZE).min(Self::CHUNK_SIZE);
        Some((
            chunk_index,
            local_y as usize * chunk_width as usize + local_x as usize,
        ))
    }

    pub fn chunk_grid_dimensions(&self) -> (u32, u32) {
        (self.chunks_x, self.chunks_y)
    }

    pub fn chunk_revision(&self, chunk_x: u32, chunk_y: u32) -> Option<u64> {
        (chunk_x < self.chunks_x && chunk_y < self.chunks_y)
            .then_some((chunk_y * self.chunks_x + chunk_x) as usize)
            .and_then(|index| self.chunks.get(index))
            .map(|chunk| chunk.as_ref().map_or(0, |chunk| chunk.revision))
    }

    pub fn chunk_dimensions(&self, chunk_x: u32, chunk_y: u32) -> Option<(usize, usize)> {
        let index = (chunk_y < self.chunks_y && chunk_x < self.chunks_x)
            .then_some((chunk_y * self.chunks_x + chunk_x) as usize)?;
        if let Some(chunk) = self.chunks.get(index)?.as_ref() {
            return Some((chunk.width as usize, chunk.height as usize));
        }
        let origin_x = chunk_x * Self::CHUNK_SIZE;
        let origin_y = chunk_y * Self::CHUNK_SIZE;
        Some((
            (self.width - origin_x).min(Self::CHUNK_SIZE) as usize,
            (self.height - origin_y).min(Self::CHUNK_SIZE) as usize,
        ))
    }

    pub fn encoded(&self, x: usize, y: usize) -> Option<(i16, u8, u8)> {
        update_canonical_sample_trace(|trace| {
            trace.cells_requested = trace.cells_requested.saturating_add(1);
        });
        let (chunk_index, local_index) = self.chunk_and_local_index(x, y)?;
        if let Some(chunk) = self.chunks.get(chunk_index)?.as_ref() {
            update_canonical_sample_trace(|trace| {
                trace.materialized_cells = trace.materialized_cells.saturating_add(1);
            });
            return Some((
                *chunk.elevation_m.get(local_index)?,
                *chunk.terrain.get(local_index)?,
                *chunk.water.get(local_index)?,
            ));
        }
        update_canonical_sample_trace(|trace| {
            trace.virtual_cells_synthesized = trace.virtual_cells_synthesized.saturating_add(1);
        });
        self.recipe.as_ref().map(|recipe| {
            encoded_surface_cell_from_source(recipe, x as u32, y as u32, self.width, self.height)
        })
    }

    /// Continuous authoritative sample for physical hydrology. This bypasses
    /// climate and display-terrain classification, which are irrelevant to a
    /// channel path and would otherwise multiply every corridor probe by the
    /// full render-cell workload.
    pub(crate) fn hydrology_sample_at_world(
        &self,
        point: Point,
        world_width_km: f32,
        world_height_km: f32,
    ) -> SurfaceSample {
        let Some(recipe) = self.recipe.as_ref() else {
            let x = (point.x / world_width_km.max(f32::EPSILON) * self.width as f32)
                .floor()
                .clamp(0.0, self.width.saturating_sub(1) as f32) as usize;
            let y = (point.y / world_height_km.max(f32::EPSILON) * self.height as f32)
                .floor()
                .clamp(0.0, self.height.saturating_sub(1) as f32) as usize;
            return self.sample(x, y);
        };
        let settings = recipe.generation_settings();
        let maximum_elevation = settings
            .map(|value| value.maximum_elevation_m as f32)
            .unwrap_or(4_800.0)
            .max(recipe.sea_level() + 50.0);
        let elevation_span = settings
            .map(|value| value.elevation_span_m as f32)
            .unwrap_or(5_600.0)
            .clamp(0.0, 20_000.0);
        let elevation_noise = settings
            .map(|value| value.elevation_noise_percent as f32 / 100.0)
            .unwrap_or(0.58)
            .clamp(0.0, 1.0);
        let region_type = settings
            .map(|value| value.region_type)
            .unwrap_or(crate::generator::RegionType::Coast);
        let x = f64::from(point.x / world_width_km.max(f32::EPSILON)) * f64::from(self.width);
        let y = f64::from(point.y / world_height_km.max(f32::EPSILON)) * f64::from(self.height);
        let fields = canonical_continuous_fields(
            recipe,
            x,
            y,
            self.width,
            self.height,
            region_type,
            maximum_elevation,
            elevation_span,
            elevation_noise,
        );
        let lake = (!fields.ocean)
            .then(|| {
                canonical_freshwater_guidance(
                    recipe,
                    x,
                    y,
                    self.width,
                    self.height,
                    canonical_world_seed_u32(recipe),
                )
            })
            .flatten()
            .filter(|_| fields.land_signal > 0.035);
        SurfaceSample {
            elevation_m: lake.unwrap_or(fields.elevation_m),
            terrain: "plain",
            water: if fields.ocean {
                "saltwater"
            } else if lake.is_some() {
                "freshwater"
            } else {
                "land"
            },
        }
    }

    pub fn chunk_surface_names_lod(
        &self,
        chunk_x: u32,
        chunk_y: u32,
        lod: u8,
    ) -> Option<(usize, usize, Vec<&'static str>)> {
        let (width, height, samples) = self.chunk_render_samples_lod(chunk_x, chunk_y, lod)?;
        Some((
            width,
            height,
            samples
                .into_iter()
                .map(|sample| sample.surface_name)
                .collect(),
        ))
    }

    pub(crate) fn chunk_render_samples_lod(
        &self,
        chunk_x: u32,
        chunk_y: u32,
        lod: u8,
    ) -> Option<(usize, usize, Vec<SurfaceRenderSample>)> {
        let (chunk_width, chunk_height) = self.chunk_dimensions(chunk_x, chunk_y)?;
        let factor = 1_usize << lod.min(6);
        let output_width = chunk_width.div_ceil(factor);
        let output_height = chunk_height.div_ceil(factor);
        let origin_x = chunk_x as usize * Self::CHUNK_SIZE as usize;
        let origin_y = chunk_y as usize * Self::CHUNK_SIZE as usize;
        let mut samples = Vec::with_capacity(output_width * output_height);
        for output_y in 0..output_height {
            for output_x in 0..output_width {
                let start_x = output_x * factor;
                let start_y = output_y * factor;
                let end_x = (start_x + factor).min(chunk_width);
                let end_y = (start_y + factor).min(chunk_height);
                let center_x = (start_x + (end_x - start_x) / 2).min(end_x - 1);
                let center_y = (start_y + (end_y - start_y) / 2).min(end_y - 1);
                let mut center_elevation = 0_i16;
                let mut center_terrain = terrain_code("plain");
                let mut center_water = 0_u8;
                let mut terrain_counts = [0_u32; 11];
                let mut water_counts = [0_u32; 3];
                for local_y in start_y..end_y {
                    for local_x in start_x..end_x {
                        let (elevation, terrain, water) = self
                            .encoded(origin_x + local_x, origin_y + local_y)
                            .unwrap_or((0, terrain_code("plain"), 0));
                        if local_x == center_x && local_y == center_y {
                            center_elevation = elevation;
                            center_terrain = terrain.min(10);
                            center_water = water.min(2);
                        }
                        let terrain = terrain.min(10) as usize;
                        let water = water.min(2) as usize;
                        terrain_counts[terrain] += 1;
                        water_counts[water] += 1;
                    }
                }
                let water = dominant_encoded_value(&water_counts, center_water);
                let terrain = dominant_encoded_value(&terrain_counts, center_terrain);
                samples.push(SurfaceRenderSample {
                    elevation_m: f32::from(center_elevation),
                    surface_name: if water == 0 {
                        terrain_name(terrain)
                    } else {
                        water_name(water)
                    },
                });
            }
        }
        Some((output_width, output_height, samples))
    }

    pub(crate) fn sample(&self, x: usize, y: usize) -> SurfaceSample {
        let x = x.min(self.width.saturating_sub(1) as usize);
        let y = y.min(self.height.saturating_sub(1) as usize);
        let Some((elevation, terrain, water)) = self.encoded(x, y) else {
            return SurfaceSample {
                elevation_m: 0.0,
                terrain: "plain",
                water: "land",
            };
        };
        SurfaceSample {
            elevation_m: elevation as f32,
            terrain: terrain_name(terrain),
            water: water_name(water),
        }
    }

    pub(crate) fn diagnostic_sample(
        &self,
        x: usize,
        y: usize,
    ) -> Option<CanonicalDiagnosticSample> {
        let recipe = self.recipe.as_ref()?;
        let x = x.min(self.width.saturating_sub(1) as usize);
        let y = y.min(self.height.saturating_sub(1) as usize);
        let settings = recipe.generation_settings();
        let maximum_elevation = settings
            .map(|value| value.maximum_elevation_m as f32)
            .unwrap_or(4_800.0)
            .max(recipe.sea_level() + 50.0);
        let elevation_span = settings
            .map(|value| value.elevation_span_m as f32)
            .unwrap_or(5_600.0)
            .clamp(0.0, 20_000.0);
        let elevation_noise = settings
            .map(|value| value.elevation_noise_percent as f32 / 100.0)
            .unwrap_or(0.58)
            .clamp(0.0, 1.0);
        let region_type = settings
            .map(|value| value.region_type)
            .unwrap_or(crate::generator::RegionType::Coast);
        let fields = canonical_continuous_fields(
            recipe,
            x as f64 + 0.5,
            y as f64 + 0.5,
            self.width,
            self.height,
            region_type,
            maximum_elevation,
            elevation_span,
            elevation_noise,
        );
        let (final_elevation, _, water_code) = self.encoded(x, y)?;
        let final_elevation_m = f32::from(final_elevation);
        Some(CanonicalDiagnosticSample {
            analysis_elevation_m: fields.analysis_elevation_m,
            procedural_elevation_m: fields.procedural_elevation_m,
            geology_bias_m: fields.geology_bias_m,
            final_elevation_m,
            residual_m: final_elevation_m - fields.analysis_elevation_m,
            water_code,
        })
    }

    fn set_encoded(&mut self, x: u32, y: u32, elevation: i16, terrain: u8, water: u8) -> bool {
        let Some((chunk_index, local_index)) = self.chunk_and_local_index(x as usize, y as usize)
        else {
            return false;
        };
        if self.chunks[chunk_index].is_none() {
            let chunk_x = x / Self::CHUNK_SIZE;
            let chunk_y = y / Self::CHUNK_SIZE;
            let origin_x = chunk_x * Self::CHUNK_SIZE;
            let origin_y = chunk_y * Self::CHUNK_SIZE;
            let chunk_width = (self.width - origin_x).min(Self::CHUNK_SIZE) as u16;
            let chunk_height = (self.height - origin_y).min(Self::CHUNK_SIZE) as u16;
            let mut elevation_m = Vec::with_capacity(chunk_width as usize * chunk_height as usize);
            let mut terrain_values = Vec::with_capacity(elevation_m.capacity());
            let mut water_values = Vec::with_capacity(elevation_m.capacity());
            for local_y in 0..u32::from(chunk_height) {
                for local_x in 0..u32::from(chunk_width) {
                    let encoded = self
                        .recipe
                        .as_ref()
                        .map(|recipe| {
                            encoded_surface_cell_from_source(
                                recipe,
                                origin_x + local_x,
                                origin_y + local_y,
                                self.width,
                                self.height,
                            )
                        })
                        .unwrap_or((0, terrain_code("plain"), 0));
                    elevation_m.push(encoded.0);
                    terrain_values.push(encoded.1);
                    water_values.push(encoded.2);
                }
            }
            self.chunks[chunk_index] = Some(Arc::new(SurfaceChunk {
                width: chunk_width,
                height: chunk_height,
                revision: 0,
                elevation_m: elevation_m.into_boxed_slice(),
                terrain: terrain_values.into_boxed_slice(),
                water: water_values.into_boxed_slice(),
            }));
        }
        let chunk = Arc::make_mut(
            self.chunks[chunk_index]
                .as_mut()
                .expect("materialized canonical chunk"),
        );
        if chunk.elevation_m[local_index] == elevation
            && chunk.terrain[local_index] == terrain
            && chunk.water[local_index] == water
        {
            return false;
        }
        chunk.elevation_m[local_index] = elevation;
        chunk.terrain[local_index] = terrain;
        chunk.water[local_index] = water;
        chunk.revision = chunk.revision.wrapping_add(1);
        true
    }
}

fn dominant_encoded_value<const N: usize>(counts: &[u32; N], preferred: u8) -> u8 {
    let maximum = counts.iter().copied().max().unwrap_or_default();
    if counts.get(preferred as usize).copied() == Some(maximum) {
        return preferred;
    }
    counts
        .iter()
        .position(|count| *count == maximum)
        .unwrap_or_default() as u8
}

mod canonical_surface_serde {
    use super::*;

    const LEGACY_MAGIC: &[u8; 4] = b"URS2";
    const STREAMED_MAGIC: &[u8; 4] = b"URS3";

    pub(super) fn encode_streamed_raw(surface: &CanonicalSurface) -> Result<Vec<u8>, String> {
        let recipe = serde_json::to_vec(&surface.recipe).map_err(|error| error.to_string())?;
        let materialized = surface
            .chunks
            .iter()
            .enumerate()
            .filter_map(|(index, chunk)| chunk.as_ref().map(|chunk| (index, chunk)))
            .collect::<Vec<_>>();
        let mut raw = Vec::with_capacity(20 + recipe.len() + materialized.len() * 16);
        raw.extend_from_slice(STREAMED_MAGIC);
        raw.extend_from_slice(&surface.width.to_le_bytes());
        raw.extend_from_slice(&surface.height.to_le_bytes());
        raw.extend_from_slice(&(recipe.len() as u32).to_le_bytes());
        raw.extend_from_slice(&recipe);
        raw.extend_from_slice(&(materialized.len() as u32).to_le_bytes());
        for (index, chunk) in materialized {
            raw.extend_from_slice(&(index as u32).to_le_bytes());
            raw.extend_from_slice(&chunk.revision.to_le_bytes());
            for local_index in 0..chunk.elevation_m.len() {
                raw.extend_from_slice(&chunk.elevation_m[local_index].to_le_bytes());
                raw.push(chunk.terrain[local_index]);
                raw.push(chunk.water[local_index]);
            }
        }
        Ok(raw)
    }

    pub(super) fn decode_streamed_raw(raw: &[u8]) -> Result<Arc<CanonicalSurface>, String> {
        if raw.len() < 12 || &raw[..4] != STREAMED_MAGIC {
            return Err("invalid streamed canonical surface header".to_owned());
        }
        let width = u32::from_le_bytes(raw[4..8].try_into().unwrap_or_default());
        let height = u32::from_le_bytes(raw[8..12].try_into().unwrap_or_default());
        if width == 0 || height == 0 {
            return Err("invalid canonical surface dimensions".to_owned());
        }
        let mut cursor = 12_usize;
        let recipe_len = read_u32(raw, &mut cursor)? as usize;
        let recipe_end = cursor
            .checked_add(recipe_len)
            .filter(|end| *end <= raw.len())
            .ok_or_else(|| "invalid canonical recipe length".to_owned())?;
        let mut recipe =
            serde_json::from_slice::<Option<CanonicalSurfaceRecipe>>(&raw[cursor..recipe_end])
                .map_err(|error| error.to_string())?;
        if let Some(recipe) = &mut recipe {
            recipe.restore_derived_fields();
        }
        cursor = recipe_end;
        let materialized_count = read_u32(raw, &mut cursor)? as usize;
        let chunks_x = width.div_ceil(CanonicalSurface::CHUNK_SIZE);
        let chunks_y = height.div_ceil(CanonicalSurface::CHUNK_SIZE);
        let mut chunks = vec![None; (chunks_x * chunks_y) as usize];
        for _ in 0..materialized_count {
            let index = read_u32(raw, &mut cursor)? as usize;
            let revision = read_u64(raw, &mut cursor)?;
            if index >= chunks.len() || chunks[index].is_some() {
                return Err("invalid canonical chunk index".to_owned());
            }
            let chunk_x = index as u32 % chunks_x;
            let chunk_y = index as u32 / chunks_x;
            let chunk_width = (width - chunk_x * CanonicalSurface::CHUNK_SIZE)
                .min(CanonicalSurface::CHUNK_SIZE) as u16;
            let chunk_height = (height - chunk_y * CanonicalSurface::CHUNK_SIZE)
                .min(CanonicalSurface::CHUNK_SIZE) as u16;
            let count = chunk_width as usize * chunk_height as usize;
            let byte_count = count
                .checked_mul(4)
                .ok_or_else(|| "canonical chunk is too large".to_owned())?;
            if cursor + byte_count > raw.len() {
                return Err("truncated canonical chunk".to_owned());
            }
            let mut elevation_m = Vec::with_capacity(count);
            let mut terrain = Vec::with_capacity(count);
            let mut water = Vec::with_capacity(count);
            for _ in 0..count {
                elevation_m.push(i16::from_le_bytes([raw[cursor], raw[cursor + 1]]));
                terrain.push(raw[cursor + 2]);
                water.push(raw[cursor + 3]);
                cursor += 4;
            }
            chunks[index] = Some(Arc::new(SurfaceChunk {
                width: chunk_width,
                height: chunk_height,
                revision,
                elevation_m: elevation_m.into_boxed_slice(),
                terrain: terrain.into_boxed_slice(),
                water: water.into_boxed_slice(),
            }));
        }
        if cursor != raw.len() || (recipe.is_none() && chunks.iter().any(Option::is_none)) {
            return Err("incomplete canonical surface payload".to_owned());
        }
        Ok(Arc::new(CanonicalSurface {
            width,
            height,
            chunks_x,
            chunks_y,
            chunks,
            recipe,
        }))
    }

    pub fn serialize<S>(
        value: &Option<Arc<CanonicalSurface>>,
        serializer: S,
    ) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let Some(surface) = value else {
            return serializer.serialize_none();
        };
        let raw = encode_streamed_raw(surface).map_err(serde::ser::Error::custom)?;
        let mut encoder = ZlibEncoder::new(Vec::new(), Compression::fast());
        encoder.write_all(&raw).map_err(serde::ser::Error::custom)?;
        let compressed = encoder.finish().map_err(serde::ser::Error::custom)?;
        serializer.serialize_some(&format!("z3:{}", encode_hex(&compressed)))
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<Option<Arc<CanonicalSurface>>, D::Error>
    where
        D: Deserializer<'de>,
    {
        let Some(encoded) = Option::<String>::deserialize(deserializer)? else {
            return Ok(None);
        };
        let (payload, streamed) = if let Some(payload) = encoded.strip_prefix("z3:") {
            (payload, true)
        } else if let Some(payload) = encoded.strip_prefix("z2:") {
            (payload, false)
        } else {
            return Err(D::Error::custom("unsupported canonical surface encoding"));
        };
        let compressed = decode_hex(payload).map_err(D::Error::custom)?;
        let mut decoder = ZlibDecoder::new(compressed.as_slice());
        let mut raw = Vec::new();
        decoder.read_to_end(&mut raw).map_err(D::Error::custom)?;
        if raw.len() < 12
            || (streamed && &raw[..4] != STREAMED_MAGIC)
            || (!streamed && &raw[..4] != LEGACY_MAGIC)
        {
            return Err(D::Error::custom("invalid canonical surface header"));
        }
        let width = u32::from_le_bytes(raw[4..8].try_into().unwrap_or_default());
        let height = u32::from_le_bytes(raw[8..12].try_into().unwrap_or_default());
        let cell_count = u64::from(width).saturating_mul(u64::from(height));
        if width == 0 || height == 0 {
            return Err(D::Error::custom("invalid canonical surface dimensions"));
        }
        if streamed {
            return decode_streamed_raw(&raw)
                .map(Some)
                .map_err(D::Error::custom);
        }
        if cell_count > NativeMap::MAX_MATERIALIZED_SURFACE_CELLS
            || raw.len() != 12 + cell_count as usize * 4
        {
            return Err(D::Error::custom(
                "invalid legacy canonical surface dimensions",
            ));
        }
        let surface = CanonicalSurface::generate(width, height, |x, y| {
            // The wire format is global row-major while the in-memory surface is
            // assembled chunk-major. Resolve every cell by its global coordinate
            // instead of consuming the payload sequentially across chunks.
            let cursor = 12 + (y as usize * width as usize + x as usize) * 4;
            let elevation = i16::from_le_bytes([raw[cursor], raw[cursor + 1]]);
            let terrain = raw[cursor + 2];
            let water = raw[cursor + 3];
            (elevation, terrain, water)
        });
        Ok(Some(Arc::new(surface)))
    }

    fn read_u32(raw: &[u8], cursor: &mut usize) -> Result<u32, &'static str> {
        let end = (*cursor)
            .checked_add(4)
            .ok_or("canonical cursor overflow")?;
        let bytes = raw.get(*cursor..end).ok_or("truncated canonical payload")?;
        *cursor = end;
        Ok(u32::from_le_bytes(bytes.try_into().unwrap_or_default()))
    }

    fn read_u64(raw: &[u8], cursor: &mut usize) -> Result<u64, &'static str> {
        let end = (*cursor)
            .checked_add(8)
            .ok_or("canonical cursor overflow")?;
        let bytes = raw.get(*cursor..end).ok_or("truncated canonical payload")?;
        *cursor = end;
        Ok(u64::from_le_bytes(bytes.try_into().unwrap_or_default()))
    }

    fn encode_hex(bytes: &[u8]) -> String {
        const DIGITS: &[u8; 16] = b"0123456789abcdef";
        let mut output = String::with_capacity(bytes.len() * 2);
        for &byte in bytes {
            output.push(DIGITS[(byte >> 4) as usize] as char);
            output.push(DIGITS[(byte & 0x0f) as usize] as char);
        }
        output
    }

    fn decode_hex(value: &str) -> Result<Vec<u8>, &'static str> {
        if !value.len().is_multiple_of(2) {
            return Err("canonical surface hex payload has an odd length");
        }
        value
            .as_bytes()
            .chunks_exact(2)
            .map(|pair| {
                let high = decode_nibble(pair[0])?;
                let low = decode_nibble(pair[1])?;
                Ok((high << 4) | low)
            })
            .collect()
    }

    fn decode_nibble(value: u8) -> Result<u8, &'static str> {
        match value {
            b'0'..=b'9' => Ok(value - b'0'),
            b'a'..=b'f' => Ok(value - b'a' + 10),
            b'A'..=b'F' => Ok(value - b'A' + 10),
            _ => Err("canonical surface contains invalid hex"),
        }
    }
}

fn terrain_code(value: &str) -> u8 {
    match value {
        "mountain" => 1,
        "forest" => 2,
        "desert" => 3,
        "snow" => 4,
        "grassland" => 5,
        "farmland" => 6,
        "jungle" => 7,
        "wetland" => 8,
        "rock" | "bedrock" => 9,
        _ => 0,
    }
}

fn terrain_name(value: u8) -> &'static str {
    match value {
        1 => "mountain",
        2 => "forest",
        3 => "desert",
        4 => "snow",
        5 => "grassland",
        6 => "farmland",
        7 => "jungle",
        8 => "wetland",
        9 | 10 => "rock",
        _ => "plain",
    }
}

fn terrain_static_name(value: &str) -> &'static str {
    terrain_name(terrain_code(value))
}

fn water_name(value: u8) -> &'static str {
    match value {
        1 => "saltwater",
        2 => "freshwater",
        _ => "land",
    }
}

fn water_code(value: &str) -> u8 {
    if matches!(value, "freshwater" | "lake") {
        2
    } else if matches!(value, "saltwater" | "ocean" | "sea") {
        1
    } else {
        0
    }
}

fn water_static_name(value: &str) -> &'static str {
    if matches!(value, "freshwater" | "lake") {
        "freshwater"
    } else if matches!(value, "saltwater" | "ocean" | "sea") {
        "saltwater"
    } else {
        "land"
    }
}

trait CanonicalFieldSource {
    fn environment_seed(&self) -> u32;
    fn physical_width_km(&self) -> f32;
    fn physical_height_km(&self) -> f32;
    fn sea_level(&self) -> f32;
    fn grid_width(&self) -> usize;
    fn grid_height(&self) -> usize;
    fn elevation(&self) -> &[f32];
    fn temperature(&self) -> &[f32];
    fn moisture(&self) -> &[f32];
    fn precipitation(&self) -> &[f32];
    fn water(&self) -> &[String];
    fn generation_settings(&self) -> Option<&crate::generator::MapGenerationSettings>;
    fn geologic_guide(&self) -> Option<&GeologicGuideMesh>;
    fn causal_geology(&self) -> &CausalGeologyModel;
}

impl CanonicalFieldSource for NativeMap {
    fn environment_seed(&self) -> u32 {
        self.environment_seed
    }
    fn physical_width_km(&self) -> f32 {
        self.width
    }
    fn physical_height_km(&self) -> f32 {
        self.height
    }
    fn sea_level(&self) -> f32 {
        self.sea_level
    }
    fn grid_width(&self) -> usize {
        self.grid_width
    }
    fn grid_height(&self) -> usize {
        self.grid_height
    }
    fn elevation(&self) -> &[f32] {
        &self.elevation
    }
    fn temperature(&self) -> &[f32] {
        &self.temperature
    }
    fn moisture(&self) -> &[f32] {
        &self.moisture
    }
    fn precipitation(&self) -> &[f32] {
        &self.precipitation
    }
    fn water(&self) -> &[String] {
        &self.water
    }
    fn generation_settings(&self) -> Option<&crate::generator::MapGenerationSettings> {
        self.generation_settings.as_ref()
    }
    fn geologic_guide(&self) -> Option<&GeologicGuideMesh> {
        self.geologic_guide.as_ref()
    }
    fn causal_geology(&self) -> &CausalGeologyModel {
        &self.causal_geology
    }
}

impl CanonicalFieldSource for CanonicalSurfaceRecipe {
    fn environment_seed(&self) -> u32 {
        self.environment_seed
    }
    fn physical_width_km(&self) -> f32 {
        self.map_width_km
    }
    fn physical_height_km(&self) -> f32 {
        self.map_height_km
    }
    fn sea_level(&self) -> f32 {
        self.sea_level
    }
    fn grid_width(&self) -> usize {
        self.grid_width
    }
    fn grid_height(&self) -> usize {
        self.grid_height
    }
    fn elevation(&self) -> &[f32] {
        &self.elevation
    }
    fn temperature(&self) -> &[f32] {
        &self.temperature
    }
    fn moisture(&self) -> &[f32] {
        &self.moisture
    }
    fn precipitation(&self) -> &[f32] {
        &self.precipitation
    }
    fn water(&self) -> &[String] {
        &self.water
    }
    fn generation_settings(&self) -> Option<&crate::generator::MapGenerationSettings> {
        self.generation_settings.as_ref()
    }
    fn geologic_guide(&self) -> Option<&GeologicGuideMesh> {
        self.geologic_guide.as_ref()
    }
    fn causal_geology(&self) -> &CausalGeologyModel {
        &self.causal_geology
    }
}

impl CanonicalSurfaceRecipe {
    fn restore_derived_fields(&mut self) {
        if self.causal_geology.plates.is_empty()
            && let Some(seed) = self.causal_geology_seed
        {
            self.causal_geology = CausalGeologyModel::synthesize(
                seed,
                usize::from(self.causal_geology_plate_count.max(6)),
            );
        }
    }

    fn from_map(map: &NativeMap) -> Self {
        Self {
            environment_seed: map.environment_seed,
            map_width_km: map.width,
            map_height_km: map.height,
            sea_level: map.sea_level,
            grid_width: map.grid_width,
            grid_height: map.grid_height,
            elevation: map.elevation.clone(),
            temperature: map.temperature.clone(),
            moisture: map.moisture.clone(),
            precipitation: map.precipitation.clone(),
            water: map.water.clone(),
            generation_settings: map.generation_settings.clone(),
            geologic_guide: map.geologic_guide.clone(),
            causal_geology: map.causal_geology.clone(),
            causal_geology_seed: (!map.causal_geology.plates.is_empty())
                .then_some(map.causal_geology.seed),
            causal_geology_plate_count: map.causal_geology.plates.len().min(u16::MAX as usize)
                as u16,
        }
    }
}

fn encoded_surface_cell_from_source(
    map: &impl CanonicalFieldSource,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
) -> (i16, u8, u8) {
    let settings = map.generation_settings();
    let canonical_seed = canonical_world_seed_u32(map);
    let maximum_elevation = settings
        .map(|value| value.maximum_elevation_m as f32)
        .unwrap_or(4_800.0)
        .max(map.sea_level() + 50.0);
    let elevation_span = settings
        .map(|value| value.elevation_span_m as f32)
        .unwrap_or(5_600.0)
        .clamp(0.0, 20_000.0);
    let elevation_noise = settings
        .map(|value| value.elevation_noise_percent as f32 / 100.0)
        .unwrap_or(0.58)
        .clamp(0.0, 1.0);
    let terrain_noise = settings
        .map(|value| value.terrain_noise_percent as f32 / 100.0)
        .unwrap_or(0.72)
        .clamp(0.0, 1.0);
    let region_type = settings
        .map(|value| value.region_type)
        .unwrap_or(crate::generator::RegionType::Coast);
    let fields = canonical_continuous_fields(
        map,
        x as f64 + 0.5,
        y as f64 + 0.5,
        width,
        height,
        region_type,
        maximum_elevation,
        elevation_span,
        elevation_noise,
    );
    let mut elevation = fields.elevation_m;
    let mut water = if fields.ocean { 1 } else { 0 };

    let climate_x = x as f64 + 0.5 + fields.warp_x * 0.42;
    let climate_y = y as f64 + 0.5 + fields.warp_y * 0.42;
    let lake_level = (water == 0)
        .then(|| {
            canonical_freshwater_guidance(
                map,
                climate_x + fields.warp_x * 0.35,
                climate_y + fields.warp_y * 0.35,
                width,
                height,
                canonical_seed,
            )
        })
        .flatten()
        .filter(|_| fields.land_signal > 0.035);
    if let Some(lake_level) = lake_level {
        water = 2;
        elevation = lake_level;
    }

    let (temperature, moisture, precipitation, aridity, saturation, climate_preset) =
        if let Some(settings) = settings {
            let x_km = (x as f32 + 0.5) / width.max(1) as f32 * map.physical_width_km();
            let y_km = (y as f32 + 0.5) / height.max(1) as f32 * map.physical_height_km();
            let coast = (-fields.land_signal.abs() * 12.0).exp();
            let climate = sample_climate_field(
                ClimateFieldConfig {
                    seed: canonical_seed,
                    width_km: map.physical_width_km(),
                    height_km: map.physical_height_km(),
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
                },
                x_km,
                y_km,
                elevation,
                coast,
                fields.basin,
                f32::from(lake_level.is_some()),
                0.0,
            );
            (
                climate.temperature_c,
                climate.soil_moisture,
                climate.precipitation_mm,
                climate.aridity_index,
                climate.hydrologic_saturation,
                settings.koppen_climate,
            )
        } else {
            let temperature = sample_analysis_field(
                map,
                map.temperature(),
                climate_x,
                climate_y,
                width,
                height,
                15.0,
            );
            let moisture = sample_analysis_field(
                map,
                map.moisture(),
                climate_x,
                climate_y,
                width,
                height,
                0.5,
            )
            .clamp(0.0, 1.0);
            let precipitation = sample_analysis_field(
                map,
                map.precipitation(),
                climate_x,
                climate_y,
                width,
                height,
                800.0,
            );
            (
                temperature,
                moisture,
                precipitation,
                precipitation / ((temperature + 8.0).max(0.0) * 18.0).max(35.0),
                f32::from(lake_level.is_some()),
                crate::generator::KoppenClimate::Cfb,
            )
        };

    let terrain = if water == 0 {
        let landform = canonical_landform_metrics(
            map,
            climate_x,
            climate_y,
            width,
            height,
            fields.ridge,
            fields.roughness,
        );
        classify_canonical_terrain(
            canonical_seed,
            x as f64 + 0.5,
            y as f64 + 0.5,
            temperature,
            moisture,
            precipitation,
            aridity,
            saturation,
            climate_preset,
            landform,
            terrain_noise,
        )
    } else {
        terrain_code("plain")
    };
    (
        elevation.round().clamp(i16::MIN as f32, i16::MAX as f32) as i16,
        terrain,
        water,
    )
}

#[derive(Clone, Copy, Debug)]
struct CanonicalContinuousFields {
    elevation_m: f32,
    analysis_elevation_m: f32,
    procedural_elevation_m: f32,
    geology_bias_m: f32,
    land_signal: f32,
    ocean: bool,
    ridge: f32,
    roughness: f32,
    basin: f32,
    warp_x: f64,
    warp_y: f64,
}

#[allow(clippy::too_many_arguments)]
fn canonical_continuous_fields(
    map: &impl CanonicalFieldSource,
    x: f64,
    y: f64,
    width: u32,
    height: u32,
    region_type: crate::generator::RegionType,
    maximum_elevation: f32,
    elevation_span: f32,
    elevation_noise: f32,
) -> CanonicalContinuousFields {
    if canonical_recipe_version(map) >= 2 {
        canonical_continuous_fields_v2(map, x, y, width, height, elevation_span, elevation_noise)
    } else {
        canonical_continuous_fields_v1(
            map,
            x,
            y,
            width,
            height,
            region_type,
            maximum_elevation,
            elevation_span,
            elevation_noise,
        )
    }
}

fn canonical_recipe_version(map: &impl CanonicalFieldSource) -> u16 {
    map.generation_settings()
        .map(|settings| settings.terrain_recipe_version)
        .unwrap_or(1)
}

fn canonical_world_seed(map: &impl CanonicalFieldSource) -> u64 {
    map.generation_settings()
        .map(|settings| settings.parent_world_seed)
        .filter(|seed| *seed != 0)
        .unwrap_or_else(|| u64::from(map.environment_seed()))
}

fn canonical_world_seed_u32(map: &impl CanonicalFieldSource) -> u32 {
    let seed = canonical_world_seed(map);
    (seed ^ (seed >> 32)) as u32
}

fn canonical_world_position(
    map: &impl CanonicalFieldSource,
    x_km: f32,
    y_km: f32,
) -> crate::spatial::PlanetPosition {
    let settings = map.generation_settings();
    let center = crate::spatial::PlanetPosition::from_latitude_longitude_deg(
        settings.map_or(0.0, |value| value.center_latitude_deg),
        settings.map_or(0.0, |value| value.center_longitude_deg),
    );
    regional_metric_position_rotated(
        center,
        f64::from(x_km - map.physical_width_km() * 0.5) * 1_000.0,
        f64::from(map.physical_height_km() * 0.5 - y_km) * 1_000.0,
        settings.map_or(0.0, |value| value.selection_bearing_deg),
        settings
            .map_or(6_371_000.0, |value| value.parent_planet_radius_m)
            .max(1.0),
    )
}

#[allow(clippy::too_many_arguments)]
fn canonical_continuous_fields_v2(
    map: &impl CanonicalFieldSource,
    x: f64,
    y: f64,
    width: u32,
    height: u32,
    elevation_span: f32,
    elevation_noise: f32,
) -> CanonicalContinuousFields {
    update_canonical_sample_trace(|trace| {
        trace.procedural_samples = trace.procedural_samples.saturating_add(1);
    });
    let x_km = x as f32 / width.max(1) as f32 * map.physical_width_km();
    let y_km = y as f32 / height.max(1) as f32 * map.physical_height_km();
    let analysis_elevation =
        sample_analysis_field(map, map.elevation(), x, y, width, height, map.sea_level());
    let sample_offset_x = (width.max(1) as f64 / map.physical_width_km().max(0.1) as f64).max(1.0);
    let sample_offset_y =
        (height.max(1) as f64 / map.physical_height_km().max(0.1) as f64).max(1.0);
    let east = sample_analysis_field(
        map,
        map.elevation(),
        x + sample_offset_x,
        y,
        width,
        height,
        analysis_elevation,
    );
    let west = sample_analysis_field(
        map,
        map.elevation(),
        x - sample_offset_x,
        y,
        width,
        height,
        analysis_elevation,
    );
    let south = sample_analysis_field(
        map,
        map.elevation(),
        x,
        y + sample_offset_y,
        width,
        height,
        analysis_elevation,
    );
    let north = sample_analysis_field(
        map,
        map.elevation(),
        x,
        y - sample_offset_y,
        width,
        height,
        analysis_elevation,
    );
    let slope_m_per_km = ((east - west) * 0.5).hypot((south - north) * 0.5);
    let position = canonical_world_position(map, x_km, y_km);
    let geology = if map.causal_geology().plates.is_empty() {
        None
    } else {
        update_canonical_sample_trace(|trace| {
            trace.geology_samples = trace.geology_samples.saturating_add(1);
        });
        Some(map.causal_geology().sample(position))
    };
    let residual = sample_parent_constrained_residual(
        canonical_world_seed(map),
        TerrainResidualContext {
            position,
            parent_elevation_m: analysis_elevation,
            slope_m_per_km,
            geology_boundary: geology
                .map(|value| value.boundary_influence as f32)
                .unwrap_or(0.0),
            erodibility: geology.map(|value| value.erodibility as f32).unwrap_or(0.5),
            temperature_c: 0.0,
            precipitation_mm: 0.0,
            aridity: 0.0,
            cryosphere: 0.0,
            coastal_distance_km: analysis_elevation.abs() / 80.0,
            hydrology_context: 0.0,
        },
        elevation_noise,
    );
    let ocean = analysis_elevation <= map.sea_level();
    let elevation_m = if ocean {
        (analysis_elevation + residual.elevation_m).min(map.sea_level() - 2.0)
    } else {
        (analysis_elevation + residual.elevation_m).max(map.sea_level() + 1.0)
    };
    let land_scale = (elevation_span * 0.08).max(40.0);
    let signed_land = ((analysis_elevation - map.sea_level()) / land_scale).clamp(-1.0, 1.0);
    let land_signal = if ocean {
        signed_land.min(-0.01)
    } else {
        signed_land.max(0.01)
    };
    let curvature = ((east + west + south + north) * 0.25 - analysis_elevation) / 180.0;
    CanonicalContinuousFields {
        elevation_m,
        analysis_elevation_m: analysis_elevation,
        procedural_elevation_m: residual.elevation_m,
        geology_bias_m: 0.0,
        land_signal,
        ocean,
        ridge: (residual.ridge
            + geology
                .map(|value| value.boundary_influence as f32 * 0.28)
                .unwrap_or(0.0))
        .clamp(0.0, 1.0),
        roughness: (residual.roughness
            + geology
                .map(|value| value.erodibility as f32 * 0.08)
                .unwrap_or(0.0))
        .clamp(0.0, 1.0),
        basin: (0.35 + curvature).clamp(0.0, 1.0),
        warp_x: 0.0,
        warp_y: 0.0,
    }
}

#[allow(clippy::too_many_arguments)]
fn canonical_continuous_fields_v1(
    map: &impl CanonicalFieldSource,
    x: f64,
    y: f64,
    width: u32,
    height: u32,
    region_type: crate::generator::RegionType,
    maximum_elevation: f32,
    elevation_span: f32,
    elevation_noise: f32,
) -> CanonicalContinuousFields {
    update_canonical_sample_trace(|trace| {
        trace.procedural_samples = trace.procedural_samples.saturating_add(1);
    });
    let x_km = x as f32 / width.max(1) as f32 * map.physical_width_km();
    let y_km = y as f32 / height.max(1) as f32 * map.physical_height_km();
    let mut sample = sample_terrain_field(
        TerrainFieldConfig {
            seed: map.environment_seed(),
            width_km: map.physical_width_km(),
            height_km: map.physical_height_km(),
            region_type,
            maximum_elevation_m: maximum_elevation,
            elevation_span_m: elevation_span,
            elevation_noise,
        },
        map.geologic_guide(),
        x_km,
        y_km,
    );
    let procedural_elevation_m = sample.elevation_m;
    let analysis_elevation = sample_analysis_field(
        map,
        map.elevation(),
        x,
        y,
        width,
        height,
        sample.elevation_m,
    );
    sample.elevation_m = analysis_elevation * 0.84 + sample.elevation_m * 0.16;
    sample.ocean = analysis_elevation <= map.sea_level();
    sample.elevation_m = if sample.ocean {
        sample.elevation_m.min(-2.0)
    } else {
        sample.elevation_m.max(1.0)
    };
    sample.land_signal = if sample.ocean {
        -sample.land_signal.abs().max(0.01)
    } else {
        sample.land_signal.abs().max(0.01)
    };
    let mut geology_bias_m = 0.0;
    if !map.causal_geology().plates.is_empty() {
        update_canonical_sample_trace(|trace| {
            trace.geology_samples = trace.geology_samples.saturating_add(1);
        });
        let (center_latitude, center_longitude) = map
            .generation_settings()
            .map(|settings| (settings.center_latitude_deg, settings.center_longitude_deg))
            .unwrap_or((0.0, 0.0));
        let region_center = crate::spatial::PlanetPosition::from_latitude_longitude_deg(
            center_latitude,
            center_longitude,
        );
        let geology = map.causal_geology().sample(regional_metric_position(
            region_center,
            f64::from(x_km - map.physical_width_km() * 0.5) * 1_000.0,
            f64::from(map.physical_height_km() * 0.5 - y_km) * 1_000.0,
            6_371_000.0,
        ));
        let geology_bias = (geology.base_elevation_bias_m as f32 * 0.24).clamp(-1_800.0, 2_500.0);
        geology_bias_m = geology_bias;
        sample.elevation_m = if sample.ocean {
            (sample.elevation_m + geology_bias).min(-2.0)
        } else {
            (sample.elevation_m + geology_bias).max(1.0)
        };
        sample.ridge = (sample.ridge + geology.boundary_influence as f32 * 0.35).clamp(0.0, 1.0);
        sample.roughness = (sample.roughness + geology.erodibility as f32 * 0.12).clamp(0.0, 1.0);
    }
    let pixels_per_km_x = width.max(1) as f64 / map.physical_width_km().max(0.1) as f64;
    let pixels_per_km_y = height.max(1) as f64 / map.physical_height_km().max(0.1) as f64;
    CanonicalContinuousFields {
        elevation_m: sample.elevation_m,
        analysis_elevation_m: analysis_elevation,
        procedural_elevation_m,
        geology_bias_m,
        land_signal: sample.land_signal,
        ocean: sample.ocean,
        ridge: sample.ridge,
        roughness: sample.roughness,
        basin: sample.basin,
        warp_x: sample.warp_x_km as f64 * pixels_per_km_x,
        warp_y: sample.warp_y_km as f64 * pixels_per_km_y,
    }
}

fn sample_analysis_field(
    map: &impl CanonicalFieldSource,
    field: &[f32],
    x: f64,
    y: f64,
    width: u32,
    height: u32,
    fallback: f32,
) -> f32 {
    update_canonical_sample_trace(|trace| {
        trace.analysis_samples = trace.analysis_samples.saturating_add(1);
    });
    if map.grid_width() == 0 || map.grid_height() == 0 || field.is_empty() {
        return fallback;
    }
    let gy = (y * map.grid_height() as f64 / height.max(1) as f64 - 0.5)
        .clamp(0.0, map.grid_height().saturating_sub(1) as f64);
    let gx = (x * map.grid_width() as f64 / width.max(1) as f64 - 0.5)
        .clamp(0.0, map.grid_width().saturating_sub(1) as f64);
    let x0 = gx.floor() as usize;
    let x1 = (x0 + 1).min(map.grid_width().saturating_sub(1));
    let y0 = gy.floor() as usize;
    let y1 = (y0 + 1).min(map.grid_height().saturating_sub(1));
    // Quintic interpolation preserves the broad climate guidance while making
    // the derivative continuous at analysis-cell boundaries.
    let smooth = |value: f64| {
        let value = value.clamp(0.0, 1.0);
        (value * value * value * (value * (value * 6.0 - 15.0) + 10.0)) as f32
    };
    let tx = smooth(gx - x0 as f64);
    let ty = smooth(gy - y0 as f64);
    let indices = [
        y0 * map.grid_width() + x0,
        y0 * map.grid_width() + x1,
        y1 * map.grid_width() + x0,
        y1 * map.grid_width() + x1,
    ];
    let v00 = field.get(indices[0]).copied().unwrap_or(fallback);
    let v10 = field.get(indices[1]).copied().unwrap_or(v00);
    let v01 = field.get(indices[2]).copied().unwrap_or(v00);
    let v11 = field.get(indices[3]).copied().unwrap_or(v01);
    let top = v00 + (v10 - v00) * tx;
    let bottom = v01 + (v11 - v01) * tx;
    top + (bottom - top) * ty
}

fn canonical_freshwater_guidance(
    map: &impl CanonicalFieldSource,
    x: f64,
    y: f64,
    width: u32,
    height: u32,
    seed: u32,
) -> Option<f32> {
    if map.grid_width() == 0 || map.grid_height() == 0 {
        return None;
    }
    let gx = (x * map.grid_width() as f64 / width.max(1) as f64 - 0.5)
        .clamp(0.0, map.grid_width().saturating_sub(1) as f64);
    let gy = (y * map.grid_height() as f64 / height.max(1) as f64 - 0.5)
        .clamp(0.0, map.grid_height().saturating_sub(1) as f64);
    let x0 = gx.floor() as usize;
    let y0 = gy.floor() as usize;
    let x1 = (x0 + 1).min(map.grid_width() - 1);
    let y1 = (y0 + 1).min(map.grid_height() - 1);
    let tx = (gx - x0 as f64) as f32;
    let ty = (gy - y0 as f64) as f32;
    let weights = [
        (1.0 - tx) * (1.0 - ty),
        tx * (1.0 - ty),
        (1.0 - tx) * ty,
        tx * ty,
    ];
    let indices = [
        y0 * map.grid_width() + x0,
        y0 * map.grid_width() + x1,
        y1 * map.grid_width() + x0,
        y1 * map.grid_width() + x1,
    ];
    let mut influence = 0.0_f32;
    let mut level_sum = 0.0_f32;
    for (index, weight) in indices.into_iter().zip(weights) {
        if map
            .water()
            .get(index)
            .is_some_and(|water| matches!(water.as_str(), "freshwater" | "lake"))
        {
            influence += weight;
            level_sum += map.elevation().get(index).copied().unwrap_or(0.0) * weight;
        }
    }
    let boundary = (continuous_fbm(seed ^ 0xf135_7aea, x, y, 72.0, 3) - 0.5) as f32 * 0.34;
    (influence + boundary > 0.56 && influence > 0.08)
        .then_some(level_sum / influence.max(f32::EPSILON))
}

#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct LandformMetrics {
    pub slope_m_per_km: f32,
    pub local_relief_m: f32,
    pub prominence_m: f32,
    pub curvature_m: f32,
    pub ridge: f32,
    pub roughness: f32,
}

pub(crate) fn classify_landform(
    metrics: LandformMetrics,
    geology: f32,
    moisture: f32,
) -> Option<&'static str> {
    let exposed = geology > 0.44 || moisture < 0.38;
    if metrics.slope_m_per_km >= 330.0
        && metrics.local_relief_m >= 560.0
        && exposed
        && (metrics.curvature_m >= 25.0 || metrics.roughness >= 0.58)
    {
        return Some("rock");
    }
    if (metrics.slope_m_per_km >= 210.0 && metrics.local_relief_m >= 330.0)
        || metrics.local_relief_m >= 720.0
        || (metrics.prominence_m >= 300.0
            && metrics.ridge >= 0.62
            && metrics.local_relief_m >= 260.0)
    {
        return Some("mountain");
    }
    None
}

fn canonical_landform_metrics(
    map: &impl CanonicalFieldSource,
    x: f64,
    y: f64,
    width: u32,
    height: u32,
    ridge: f32,
    roughness: f32,
) -> LandformMetrics {
    let pixels_per_km_x = width as f64 / map.physical_width_km().max(0.1) as f64;
    let pixels_per_km_y = height as f64 / map.physical_height_km().max(0.1) as f64;
    let local_km = 0.8_f64;
    let broad_km = 3.2_f64;
    let local_x = local_km * pixels_per_km_x;
    let local_y = local_km * pixels_per_km_y;
    let broad_x = broad_km * pixels_per_km_x;
    let broad_y = broad_km * pixels_per_km_y;
    let direct_config = map
        .generation_settings()
        .map(|settings| TerrainFieldConfig {
            seed: map.environment_seed(),
            width_km: map.physical_width_km(),
            height_km: map.physical_height_km(),
            region_type: settings.region_type,
            maximum_elevation_m: settings.maximum_elevation_m as f32,
            elevation_span_m: settings.elevation_span_m as f32,
            elevation_noise: settings.elevation_noise_percent as f32 / 100.0,
        });
    let sample = |sample_x: f64, sample_y: f64| {
        if canonical_recipe_version(map) >= 2 {
            canonical_v2_landform_elevation(map, sample_x, sample_y, width, height)
        } else if let Some(config) = direct_config {
            let x_km = sample_x as f32 / width.max(1) as f32 * map.physical_width_km();
            let y_km = sample_y as f32 / height.max(1) as f32 * map.physical_height_km();
            sample_terrain_field(config, map.geologic_guide(), x_km, y_km).elevation_m
        } else {
            sample_analysis_field(
                map,
                map.elevation(),
                sample_x,
                sample_y,
                width,
                height,
                map.sea_level(),
            )
        }
    };
    let center = sample(x, y);
    let east = sample(x + local_x, y);
    let west = sample(x - local_x, y);
    let south = sample(x, y + local_y);
    let north = sample(x, y - local_y);
    let broad = [
        sample(x + broad_x, y),
        sample(x - broad_x, y),
        sample(x, y + broad_y),
        sample(x, y - broad_y),
    ];
    let local = [center, east, west, south, north];
    let local_min = local.into_iter().fold(f32::INFINITY, f32::min);
    let local_max = local.into_iter().fold(f32::NEG_INFINITY, f32::max);
    let broad_mean = broad.into_iter().sum::<f32>() / broad.len() as f32;
    let slope_x = (east - west) / (local_km as f32 * 2.0);
    let slope_y = (south - north) / (local_km as f32 * 2.0);
    LandformMetrics {
        slope_m_per_km: slope_x.hypot(slope_y),
        local_relief_m: local_max - local_min,
        prominence_m: center - broad_mean,
        curvature_m: center - (east + west + south + north) * 0.25,
        ridge,
        roughness,
    }
}

fn canonical_v2_landform_elevation(
    map: &impl CanonicalFieldSource,
    x: f64,
    y: f64,
    width: u32,
    height: u32,
) -> f32 {
    let parent = sample_analysis_field(map, map.elevation(), x, y, width, height, map.sea_level());
    let x_km = x as f32 / width.max(1) as f32 * map.physical_width_km();
    let y_km = y as f32 / height.max(1) as f32 * map.physical_height_km();
    let position = canonical_world_position(map, x_km, y_km);
    let geology =
        (!map.causal_geology().plates.is_empty()).then(|| map.causal_geology().sample(position));
    let residual = sample_parent_constrained_residual(
        canonical_world_seed(map),
        TerrainResidualContext {
            position,
            parent_elevation_m: parent,
            slope_m_per_km: 0.0,
            geology_boundary: geology
                .map(|value| value.boundary_influence as f32)
                .unwrap_or(0.0),
            erodibility: geology.map(|value| value.erodibility as f32).unwrap_or(0.5),
            temperature_c: 0.0,
            precipitation_mm: 0.0,
            aridity: 0.0,
            cryosphere: 0.0,
            coastal_distance_km: parent.abs() / 80.0,
            hydrology_context: 0.0,
        },
        map.generation_settings()
            .map(|value| value.elevation_noise_percent as f32 / 100.0)
            .unwrap_or(0.58),
    );
    if parent <= map.sea_level() {
        (parent + residual.elevation_m).min(map.sea_level() - 2.0)
    } else {
        (parent + residual.elevation_m).max(map.sea_level() + 1.0)
    }
}

#[allow(clippy::too_many_arguments)]
fn classify_canonical_terrain(
    seed: u32,
    x: f64,
    y: f64,
    temperature: f32,
    moisture: f32,
    precipitation: f32,
    aridity_index: f32,
    hydrologic_saturation: f32,
    climate: crate::generator::KoppenClimate,
    landform: LandformMetrics,
    noise_strength: f32,
) -> u8 {
    let geology = continuous_fbm(seed ^ 0xa54f_f53a, x, y, 470.0, 4) as f32;
    let patch = continuous_fbm(seed ^ 0x3c6e_f372, x, y, 150.0, 4) as f32;
    let local = continuous_fbm(seed ^ 0x510e_527f, x, y, 42.0, 3) as f32;
    let micro_drainage = continuous_fbm(seed ^ 0x1b87_3593, x, y, 24.0, 3) as f32;
    if let Some(terrain) = classify_landform(landform, geology, moisture) {
        return terrain_code(terrain);
    }
    if temperature < -5.0 {
        return terrain_code("snow");
    }
    if aridity_index < 0.24 && moisture < 0.30 {
        // Even a desert macro-climate contains small continuously shaped runoff
        // refugia. Keeping this selector independent from the climate preset
        // prevents an entire region from collapsing into one terrain category.
        return if micro_drainage > 0.70 && patch > 0.38 {
            terrain_code("grassland")
        } else {
            terrain_code("desert")
        };
    }
    if hydrologic_saturation > 0.62
        && moisture > 0.55
        && landform.local_relief_m < 260.0
        && micro_drainage > 0.56
    {
        return terrain_code("wetland");
    }
    let tropical_wet_macro = matches!(
        climate,
        crate::generator::KoppenClimate::Af | crate::generator::KoppenClimate::Am
    ) && moisture > 0.55;
    if (moisture > 0.78 || tropical_wet_macro) && temperature > 20.0 {
        return if micro_drainage > 0.50 {
            terrain_code("jungle")
        } else {
            terrain_code("forest")
        };
    }

    let rain_factor = (precipitation / 1_200.0).clamp(0.0, 1.5);
    let dryness = (1.0 - aridity_index.clamp(0.0, 1.0)) * 0.74 + (1.0 - moisture) * 0.26;
    let terrain_warp = ((patch - 0.5) * 0.70 + (local - 0.5) * 0.30) * noise_strength;
    let scores = [
        (
            "desert",
            dryness + terrain_warp * 0.22 + terrain_climate_bias(climate, "desert"),
        ),
        (
            "jungle",
            moisture * 0.62
                + rain_factor.min(1.0) * 0.24
                + (temperature / 35.0) * 0.24
                + terrain_warp * 0.18
                + terrain_climate_bias(climate, "jungle"),
        ),
        (
            "wetland",
            moisture * 0.28 + hydrologic_saturation * 0.82 + rain_factor.min(1.0) * 0.08
                - (landform.local_relief_m / 900.0).clamp(0.0, 1.0) * 0.55
                + terrain_warp * 0.10
                + terrain_climate_bias(climate, "wetland")
                - if hydrologic_saturation < 0.44 {
                    0.80
                } else {
                    0.0
                },
        ),
        (
            "forest",
            moisture * 0.70 + rain_factor.min(1.0) * 0.18 + patch * 0.18 - dryness * 0.22
                + terrain_climate_bias(climate, "forest"),
        ),
        (
            "grassland",
            0.50 + (0.58 - (moisture - 0.48).abs()) * 0.44
                + terrain_warp * 0.16
                + terrain_climate_bias(climate, "grassland"),
        ),
        (
            "farmland",
            0.30 + (0.62 - (moisture - 0.54).abs()) * 0.38 - landform.roughness * 0.32
                + local * 0.12
                + terrain_climate_bias(climate, "farmland"),
        ),
        (
            "plain",
            0.54 - landform.roughness * 0.24 - terrain_warp * 0.10
                + terrain_climate_bias(climate, "plain"),
        ),
    ];
    scores
        .into_iter()
        .max_by(|left, right| left.1.total_cmp(&right.1))
        .map(|(terrain, _)| terrain_code(terrain))
        .unwrap_or_else(|| terrain_code("plain"))
}

fn continuous_fbm(seed: u32, x: f64, y: f64, wavelength: f64, octaves: usize) -> f64 {
    let mut value = 0.0;
    let mut amplitude = 1.0;
    let mut amplitude_sum = 0.0;
    let mut wavelength = wavelength.max(1.0);
    for octave in 0..octaves.max(1) {
        value += continuous_value_noise(
            seed.wrapping_add((octave as u32).wrapping_mul(0x9e37_79b9)),
            x,
            y,
            wavelength,
        ) * amplitude;
        amplitude_sum += amplitude;
        amplitude *= 0.52;
        wavelength /= 2.03;
    }
    value / amplitude_sum.max(f64::EPSILON)
}

fn continuous_value_noise(seed: u32, x: f64, y: f64, wavelength: f64) -> f64 {
    let gx = x / wavelength.max(1.0);
    let gy = y / wavelength.max(1.0);
    let x0 = gx.floor() as i64;
    let y0 = gy.floor() as i64;
    let smooth = |value: f64| value * value * value * (value * (value * 6.0 - 15.0) + 10.0);
    let tx = smooth(gx - x0 as f64);
    let ty = smooth(gy - y0 as f64);
    let n00 = continuous_hash(seed, x0, y0);
    let n10 = continuous_hash(seed, x0 + 1, y0);
    let n01 = continuous_hash(seed, x0, y0 + 1);
    let n11 = continuous_hash(seed, x0 + 1, y0 + 1);
    let top = n00 + (n10 - n00) * tx;
    let bottom = n01 + (n11 - n01) * tx;
    top + (bottom - top) * ty
}

fn continuous_hash(seed: u32, x: i64, y: i64) -> f64 {
    let x = (x as u64) ^ ((x >> 32) as u64);
    let y = (y as u64) ^ ((y >> 32) as u64);
    let mut value = seed
        ^ (x as u32).wrapping_mul(0x9e37_79b9)
        ^ (y as u32).wrapping_mul(0x85eb_ca6b)
        ^ (x as u32).rotate_left(13)
        ^ (y as u32).rotate_right(7);
    value ^= value >> 16;
    value = value.wrapping_mul(0x7feb_352d);
    value ^= value >> 15;
    value = value.wrapping_mul(0x846c_a68b);
    value ^= value >> 16;
    value as f64 / u32::MAX as f64
}

fn point_in_polygon(point: Point, polygon: &[Point]) -> bool {
    if polygon.len() < 3 {
        return false;
    }
    let mut inside = false;
    let mut previous = polygon.len() - 1;
    for current in 0..polygon.len() {
        let a = polygon[current];
        let b = polygon[previous];
        if ((a.y > point.y) != (b.y > point.y))
            && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x
        {
            inside = !inside;
        }
        previous = current;
    }
    inside
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pass_6_test_map() -> NativeMap {
        let settings = crate::generator::MapGenerationSettings {
            map_size_km: 12.0,
            map_height_km: 8.0,
            map_size_mode: crate::generator::MapSizeMode::Independent,
            target_resolution_m: 100.0,
            center_latitude_deg: 37.5,
            center_longitude_deg: 128.0,
            ..crate::generator::MapGenerationSettings::default()
        };
        crate::generator::generate_map(
            &settings,
            "Pass 6".to_owned(),
            "pass-6-test".to_owned(),
            0,
            Language::English,
        )
        .expect("pass 6 test map")
    }

    fn pass_6_fields(
        map: &NativeMap,
        nx: f64,
        ny: f64,
        width: u32,
        height: u32,
    ) -> CanonicalContinuousFields {
        let settings = map
            .generation_settings
            .as_ref()
            .expect("generation settings");
        canonical_continuous_fields(
            map,
            nx * width as f64,
            ny * height as f64,
            width,
            height,
            settings.region_type,
            settings.maximum_elevation_m as f32,
            settings.elevation_span_m as f32,
            settings.elevation_noise_percent as f32 / 100.0,
        )
    }

    #[test]
    fn planet_timeline_unions_maps_and_limits_region_visibility() {
        let mut world = LoadedWorld::load_demo(Language::English).expect("demo world");
        let mut historical_map = world.map.clone();
        historical_map.source_id = "timeline-map".to_owned();
        historical_map.region_id = Some("timeline-region".to_owned());
        historical_map.current_year = 150;
        historical_map.locations.clear();
        historical_map.place_names.clear();
        historical_map.territories.clear();
        historical_map.territory_history.clear();
        historical_map.events = vec![Event {
            id: "event-timeline".to_owned(),
            title: "Timeline event".to_owned(),
            start_year: 100,
            end_year: Some(200),
            location: None,
            location_history: Vec::new(),
            article_id: None,
            water_position_warning: false,
        }];
        world.map = historical_map.clone();
        world.maps = vec![historical_map];
        world.articles.clear();

        assert_eq!(world.planet_timeline_years(), vec![100, 150, 200]);
        assert!(!world.region_active_at("timeline-region", 99));
        assert!(world.region_active_at("timeline-region", 150));
        assert!(!world.region_active_at("timeline-region", 201));
    }

    #[test]
    fn exposed_rock_uses_local_relief_instead_of_absolute_altitude() {
        let flat_plateau = LandformMetrics {
            slope_m_per_km: 18.0,
            local_relief_m: 55.0,
            prominence_m: 30.0,
            curvature_m: 4.0,
            ridge: 0.18,
            roughness: 0.12,
        };
        let abrupt_escarpment = LandformMetrics {
            slope_m_per_km: 610.0,
            local_relief_m: 1_120.0,
            prominence_m: 430.0,
            curvature_m: 110.0,
            ridge: 0.82,
            roughness: 0.76,
        };
        assert_eq!(classify_landform(flat_plateau, 0.95, 0.12), None);
        assert_eq!(
            classify_landform(abrupt_escarpment, 0.72, 0.31),
            Some("rock")
        );
    }

    #[test]
    fn canonical_resolution_does_not_change_macroterrain() {
        let map = pass_6_test_map();
        for (nx, ny) in [(0.17, 0.23), (0.5, 0.5), (0.81, 0.64)] {
            let fine = pass_6_fields(&map, nx, ny, 1_200, 800);
            let coarse = pass_6_fields(&map, nx, ny, 120, 80);
            assert!((fine.analysis_elevation_m - coarse.analysis_elevation_m).abs() < 0.001);
            assert!((fine.procedural_elevation_m - coarse.procedural_elevation_m).abs() < 0.001);
            assert!((fine.elevation_m - coarse.elevation_m).abs() < 0.001);
            assert_eq!(fine.ocean, coarse.ocean);
        }
    }

    #[test]
    fn canonical_downsample_recovers_parent_terrain() {
        let map = pass_6_test_map();
        let mut residual_sum = 0.0_f64;
        let mut residual_sq = 0.0_f64;
        let mut count = 0.0_f64;
        for y in 0..32 {
            for x in 0..48 {
                let fields = pass_6_fields(
                    &map,
                    (x as f64 + 0.5) / 48.0,
                    (y as f64 + 0.5) / 32.0,
                    1_200,
                    800,
                );
                let residual = f64::from(fields.procedural_elevation_m);
                residual_sum += residual;
                residual_sq += residual * residual;
                count += 1.0;
            }
        }
        let mean = residual_sum / count;
        let rms = (residual_sq / count).sqrt();
        assert!(mean.abs() < 20.0, "residual mean was {mean:.3} m");
        assert!(rms > 2.0 && rms < 90.0, "residual RMS was {rms:.3} m");
    }

    #[test]
    fn canonical_residual_is_not_near_duplicate_of_parent_analysis() {
        let map = pass_6_test_map();
        let mut parent = Vec::new();
        let mut residual = Vec::new();
        for y in 0..24 {
            for x in 0..36 {
                let fields = pass_6_fields(
                    &map,
                    (x as f64 + 0.5) / 36.0,
                    (y as f64 + 0.5) / 24.0,
                    1_200,
                    800,
                );
                parent.push(fields.analysis_elevation_m);
                residual.push(fields.procedural_elevation_m);
            }
        }
        let correlation = test_pearson(&parent, &residual);
        assert!(
            correlation.abs() < 0.92,
            "parent/residual correlation was {correlation:.6}"
        );
    }

    #[test]
    fn canonical_residual_has_low_macro_frequency_power() {
        const WIDTH: usize = 96;
        const HEIGHT: usize = 64;
        const BLOCK: usize = 8;
        let map = pass_6_test_map();
        let mut residuals = vec![0.0_f64; WIDTH * HEIGHT];
        for y in 0..HEIGHT {
            for x in 0..WIDTH {
                residuals[y * WIDTH + x] = f64::from(
                    pass_6_fields(
                        &map,
                        (x as f64 + 0.5) / WIDTH as f64,
                        (y as f64 + 0.5) / HEIGHT as f64,
                        1_200,
                        800,
                    )
                    .procedural_elevation_m,
                );
            }
        }
        let total_rms = (residuals.iter().map(|value| value * value).sum::<f64>()
            / residuals.len() as f64)
            .sqrt();
        let mut block_means = Vec::new();
        for block_y in (0..HEIGHT).step_by(BLOCK) {
            for block_x in (0..WIDTH).step_by(BLOCK) {
                let mut sum = 0.0;
                for y in block_y..block_y + BLOCK {
                    for x in block_x..block_x + BLOCK {
                        sum += residuals[y * WIDTH + x];
                    }
                }
                block_means.push(sum / (BLOCK * BLOCK) as f64);
            }
        }
        let macro_rms = (block_means.iter().map(|value| value * value).sum::<f64>()
            / block_means.len() as f64)
            .sqrt();
        assert!(
            macro_rms < total_rms * 0.82,
            "macro RMS {macro_rms:.3} was too close to total RMS {total_rms:.3}"
        );
    }

    #[test]
    fn canonical_residual_is_continuous_across_chunk_boundaries() {
        let map = pass_6_test_map();
        let settings = map
            .generation_settings
            .as_ref()
            .expect("generation settings");
        let sample = |x: f64| {
            canonical_continuous_fields(
                &map,
                x,
                400.0,
                1_200,
                800,
                settings.region_type,
                settings.maximum_elevation_m as f32,
                settings.elevation_span_m as f32,
                settings.elevation_noise_percent as f32 / 100.0,
            )
        };
        for boundary in [256.0, 512.0, 768.0, 1_024.0] {
            let left = sample(boundary - 0.001);
            let right = sample(boundary + 0.001);
            assert!(
                (left.procedural_elevation_m - right.procedural_elevation_m).abs() < 0.05,
                "residual seam at {boundary}: {} vs {}",
                left.procedural_elevation_m,
                right.procedural_elevation_m
            );
        }
    }

    fn test_pearson(left: &[f32], right: &[f32]) -> f64 {
        let mean_left = left.iter().map(|value| f64::from(*value)).sum::<f64>() / left.len() as f64;
        let mean_right =
            right.iter().map(|value| f64::from(*value)).sum::<f64>() / right.len() as f64;
        let mut numerator = 0.0;
        let mut left_sq = 0.0;
        let mut right_sq = 0.0;
        for (&left, &right) in left.iter().zip(right) {
            let dl = f64::from(left) - mean_left;
            let dr = f64::from(right) - mean_right;
            numerator += dl * dr;
            left_sq += dl * dl;
            right_sq += dr * dr;
        }
        numerator / (left_sq * right_sq).sqrt().max(f64::EPSILON)
    }

    #[test]
    fn canonical_surface_round_trips_and_edits_copy_only_owned_chunks() {
        let settings = crate::generator::MapGenerationSettings {
            map_size_km: 30.0,
            map_height_km: 27.0,
            map_size_mode: crate::generator::MapSizeMode::Independent,
            ..crate::generator::MapGenerationSettings::default()
        };
        let mut map = crate::generator::generate_map(
            &settings,
            "Surface".to_owned(),
            "surface-test".to_owned(),
            0,
            Language::English,
        )
        .expect("surface map");
        let original = map.clone();
        assert_eq!(map.canonical_cell_dimensions(), (300, 270));
        let old = map.canonical_sample(7, 9);
        assert!(map.edit_canonical_cell(7, 9, Some(old.elevation_m + 321.0), None, None));
        assert_eq!(original.canonical_sample(7, 9).elevation_m, old.elevation_m);
        assert_eq!(
            map.canonical_sample(7, 9).elevation_m,
            old.elevation_m + 321.0
        );

        let encoded = serde_json::to_vec(&map).expect("serialize canonical surface");
        let mut decoded: NativeMap =
            serde_json::from_slice(&encoded).expect("deserialize canonical surface");
        decoded.rebuild_canonical_surface();
        assert_eq!(decoded.canonical_cell_dimensions(), (300, 270));
        assert_eq!(
            decoded.canonical_sample(7, 9).elevation_m,
            old.elevation_m + 321.0
        );
        for (x, y) in [(0, 0), (255, 255), (256, 0), (0, 256), (299, 269)] {
            assert_eq!(
                decoded
                    .canonical_surface
                    .as_ref()
                    .and_then(|surface| surface.encoded(x, y)),
                map.canonical_surface
                    .as_ref()
                    .and_then(|surface| surface.encoded(x, y)),
                "canonical cell changed across serialization at ({x}, {y})"
            );
        }
    }

    #[test]
    fn canonical_edits_increment_the_serialized_surface_revision() {
        let settings = crate::generator::MapGenerationSettings {
            map_size_km: 2.0,
            map_height_km: 2.0,
            map_size_mode: crate::generator::MapSizeMode::Independent,
            ..crate::generator::MapGenerationSettings::default()
        };
        let mut map = crate::generator::generate_map(
            &settings,
            "Revision".to_owned(),
            "revision-test".to_owned(),
            0,
            Language::English,
        )
        .expect("revision map");
        let before = map.surface_revision;
        let sample = map.canonical_sample(0, 0);
        assert!(map.edit_canonical_cell(0, 0, Some(sample.elevation_m + 1.0), None, None,));
        assert!(map.surface_revision > before);
        let encoded = serde_json::to_vec(&map).expect("serialize map");
        let decoded: NativeMap = serde_json::from_slice(&encoded).expect("deserialize map");
        assert_eq!(decoded.surface_revision, map.surface_revision);
    }

    #[test]
    fn terrain_lod_uses_block_majority_instead_of_a_single_center_cell() {
        let surface = CanonicalSurface::generate(4, 4, |x, y| {
            let terrain = if x == 2 && y == 2 { 0 } else { 2 };
            (100, terrain, 0)
        });
        let (_, _, names) = surface.chunk_surface_names_lod(0, 0, 2).expect("lod block");
        assert_eq!(names, vec!["forest"]);
    }

    #[test]
    fn lod0_render_sampling_does_not_repeat_identical_cell_reads() {
        let surface = CanonicalSurface::generate(256, 256, |x, y| {
            (
                (x as i32 - y as i32).clamp(i16::MIN as i32, i16::MAX as i32) as i16,
                2,
                0,
            )
        });
        begin_canonical_sample_trace();
        let (width, height, samples) = surface
            .chunk_render_samples_lod(0, 0, 0)
            .expect("lod0 render block");
        let trace = finish_canonical_sample_trace();
        assert_eq!((width, height), (256, 256));
        assert_eq!(samples.len(), 256 * 256);
        assert_eq!(trace.cells_requested, (256 * 256) as u64);
    }

    #[test]
    fn render_block_sampling_preserves_majority_semantics() {
        let surface = CanonicalSurface::generate(4, 4, |x, y| {
            let terrain = if x == 2 && y == 2 { 0 } else { 2 };
            let water = if x == 0 && y == 0 { 1 } else { 0 };
            ((y * 10 + x) as i16, terrain, water)
        });
        let (_, _, render_samples) = surface
            .chunk_render_samples_lod(0, 0, 2)
            .expect("render block");
        assert_eq!(render_samples.len(), 1);
        assert_eq!(render_samples[0].surface_name, "forest");
        assert_eq!(render_samples[0].elevation_m, 22.0);
    }

    #[test]
    fn canonical_terrain_is_not_copied_from_the_nearest_analysis_category() {
        let settings = crate::generator::MapGenerationSettings {
            map_size_km: 20.0,
            map_height_km: 12.0,
            map_size_mode: crate::generator::MapSizeMode::Independent,
            region_type: crate::generator::RegionType::Inland,
            ..crate::generator::MapGenerationSettings::default()
        };
        let mut map = crate::generator::generate_map(
            &settings,
            "Direct terrain".to_owned(),
            "direct-terrain".to_owned(),
            0,
            Language::English,
        )
        .expect("direct terrain map");
        map.terrain.fill("desert".to_owned());
        map.moisture.fill(0.82);
        map.precipitation.fill(1_700.0);
        map.temperature.fill(24.0);
        map.canonical_surface = None;
        map.rebuild_canonical_surface();
        let (width, height) = map.canonical_cell_dimensions();
        let non_desert = (0..height)
            .flat_map(|y| (0..width).map(move |x| (x, y)))
            .filter(|(x, y)| {
                let sample = map.canonical_sample(*x, *y);
                sample.water == "land" && sample.terrain != "desert"
            })
            .count();
        assert!(non_desert > width * height / 3);
    }

    #[test]
    fn macro_climate_guides_but_does_not_hard_partition_terrain() {
        let dry_settings = crate::generator::MapGenerationSettings {
            map_size_km: 18.0,
            map_height_km: 12.0,
            map_size_mode: crate::generator::MapSizeMode::Independent,
            region_type: crate::generator::RegionType::Inland,
            maximum_elevation_m: 900.0,
            elevation_span_m: 850.0,
            koppen_climate: crate::generator::KoppenClimate::BWh,
            reference_temperature_c: 27.0,
            reference_humidity_percent: 25.0,
            base_precipitation_mm: 130.0,
            ..crate::generator::MapGenerationSettings::default()
        };
        let dry = crate::generator::generate_map(
            &dry_settings,
            "Dry".to_owned(),
            "dry-guidance".to_owned(),
            0,
            Language::English,
        )
        .expect("dry map");
        let wet_settings = crate::generator::MapGenerationSettings {
            koppen_climate: crate::generator::KoppenClimate::Af,
            reference_temperature_c: 27.0,
            reference_humidity_percent: 88.0,
            base_precipitation_mm: 2_400.0,
            ..dry_settings
        };
        let wet = crate::generator::generate_map(
            &wet_settings,
            "Wet".to_owned(),
            "wet-guidance".to_owned(),
            0,
            Language::English,
        )
        .expect("wet map");
        let terrain_counts = |map: &NativeMap| {
            let (width, height) = map.canonical_cell_dimensions();
            let mut desert = 0;
            let mut wet_family = 0;
            let mut distinct = std::collections::HashSet::new();
            for y in 0..height {
                for x in 0..width {
                    let sample = map.canonical_sample(x, y);
                    if sample.water != "land" {
                        continue;
                    }
                    distinct.insert(sample.terrain);
                    desert += usize::from(sample.terrain == "desert");
                    wet_family +=
                        usize::from(matches!(sample.terrain, "forest" | "jungle" | "wetland"));
                }
            }
            (desert, wet_family, distinct.len())
        };
        let dry_counts = terrain_counts(&dry);
        let wet_counts = terrain_counts(&wet);
        assert!(dry_counts.0 > wet_counts.0);
        assert!(wet_counts.1 > dry_counts.1);
        assert!(
            dry_counts.2 > 1 && wet_counts.2 > 1,
            "dry={dry_counts:?}, wet={wet_counts:?}"
        );
    }

    #[test]
    fn territory_ownership_uses_the_requested_year_and_grid_fallback() {
        let mut world = LoadedWorld::load_demo(Language::Korean).expect("demo");
        assert!(world.map.factions.len() >= 2);
        let index = world
            .map
            .water
            .iter()
            .position(|water| water == "land")
            .expect("land cell");
        world.map.territory_owners.fill(-1);
        world.map.territory_owners[index] = 0;
        let x = index % world.map.grid_width;
        let y = index / world.map.grid_width;
        let cell_width = world.map.width / world.map.grid_width as f32;
        let cell_height = world.map.height / world.map.grid_height as f32;
        let center = Point {
            x: (x as f32 + 0.5) * cell_width,
            y: (y as f32 + 0.5) * cell_height,
        };
        let half_x = cell_width * 0.45;
        let half_y = cell_height * 0.45;
        world.map.territories = vec![Territory {
            id: "temporal-test".to_owned(),
            name: "Temporal".to_owned(),
            states: vec![TerritoryTemporalState {
                start_year: 10,
                end_year: Some(20),
                owner_faction_id: Some(world.map.factions[1].id.clone()),
                parts: vec![TerritoryPart {
                    polygon: vec![
                        Point {
                            x: center.x - half_x,
                            y: center.y - half_y,
                        },
                        Point {
                            x: center.x + half_x,
                            y: center.y - half_y,
                        },
                        Point {
                            x: center.x + half_x,
                            y: center.y + half_y,
                        },
                        Point {
                            x: center.x - half_x,
                            y: center.y + half_y,
                        },
                    ],
                    holes: Vec::new(),
                }],
            }],
        }];

        assert_eq!(world.map.territory_owner_at(center, 15), Some(1));
        assert_eq!(world.map.territory_owner_at(center, 30), Some(0));
    }

    #[test]
    fn territory_grid_snapshots_preserve_before_and_after_ownership() {
        let mut world = LoadedWorld::load_demo(Language::Korean).expect("demo");
        let index = world
            .map
            .water
            .iter()
            .position(|water| water == "land")
            .expect("land");
        world.map.territories.clear();
        world.map.territory_history.clear();
        world.map.territory_owners.fill(-1);
        world.map.territory_owners[index] = 0;
        world.map.record_territory_snapshot(599);
        world.map.territory_owners[index] = 1;
        world.map.record_territory_snapshot(600);
        let x = index % world.map.grid_width;
        let y = index / world.map.grid_width;
        let point = Point {
            x: (x as f32 + 0.5) * world.map.width / world.map.grid_width as f32,
            y: (y as f32 + 0.5) * world.map.height / world.map.grid_height as f32,
        };
        assert_eq!(world.map.territory_owner_at(point, 599), Some(0));
        assert_eq!(world.map.territory_owner_at(point, 600), Some(1));
        assert_eq!(world.map.territory_owner_at(point, 601), Some(1));
    }

    #[test]
    fn extreme_maps_stream_virtual_chunks_and_round_trip_only_materialized_edits() {
        let settings = crate::generator::MapGenerationSettings {
            map_size_km: 4_000.0,
            map_height_km: 1_000.0,
            map_size_mode: crate::generator::MapSizeMode::Independent,
            ..crate::generator::MapGenerationSettings::default()
        };
        let mut map = crate::generator::generate_map(
            &settings,
            "Streamed".to_owned(),
            "streamed-map".to_owned(),
            0,
            Language::English,
        )
        .expect("streamed map");
        let surface = map.canonical_surface.as_ref().expect("surface");
        assert_eq!((surface.width, surface.height), (40_000, 10_000));
        assert!(surface.recipe.is_some());
        assert!(surface.chunks.iter().all(Option::is_none));

        let before = map.canonical_sample(20_000, 5_000);
        assert!(map.edit_canonical_cell(
            20_000,
            5_000,
            Some(before.elevation_m + 125.0),
            None,
            None,
        ));
        let surface = map.canonical_surface.as_ref().expect("edited surface");
        assert_eq!(
            surface
                .chunks
                .iter()
                .filter(|chunk| chunk.is_some())
                .count(),
            1
        );

        let bytes = serde_json::to_vec(&map).expect("serialize streamed map");
        assert!(bytes.len() < 8_000_000, "serialized {} bytes", bytes.len());
        let decoded: NativeMap = serde_json::from_slice(&bytes).expect("deserialize streamed map");
        assert_eq!(
            decoded.canonical_sample(20_000, 5_000).elevation_m,
            before.elevation_m + 125.0
        );
        assert_eq!(
            decoded
                .canonical_surface
                .as_ref()
                .expect("decoded surface")
                .chunks
                .iter()
                .filter(|chunk| chunk.is_some())
                .count(),
            1
        );
    }
}
