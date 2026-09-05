use std::{
    collections::{HashMap, VecDeque, hash_map::DefaultHasher},
    hash::{Hash, Hasher},
    sync::Arc,
};

use eframe::egui::{Color32, Mesh, Pos2, Vec2, epaint::Vertex};

use crate::{
    contour::{self, ContourLine},
    model::{
        CanonicalSurface, NativeMap, Point, begin_canonical_sample_trace,
        finish_canonical_sample_trace,
    },
    render::build_territory_mesh_with_opacity,
    shoreline::build_shoreline_chunk,
    surface_refinement::{DISPLAY_FIELD_VERSION, chunk_halo_revision_hash},
};

const MIN_RIVER_SCREEN_WIDTH: f32 = 1.25;
const RIVER_SCALE_STEPS_PER_OCTAVE: f32 = 8.0;
const MAX_DERIVED_CHUNK_MESHES: usize = 1_024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum EnvironmentLayer {
    Temperature,
    Humidity,
    WindSpeed,
    Precipitation,
    Snowfall,
    Evapotranspiration,
    SoilMoisture,
    SolarIrradiance,
    SolarHours,
}

impl EnvironmentLayer {
    pub(crate) const ALL: [Self; 9] = [
        Self::Temperature,
        Self::Humidity,
        Self::WindSpeed,
        Self::Precipitation,
        Self::Snowfall,
        Self::Evapotranspiration,
        Self::SoilMoisture,
        Self::SolarIrradiance,
        Self::SolarHours,
    ];
}

#[derive(Clone, Debug)]
pub(crate) struct CountryLabelAnchor {
    pub name: String,
    pub position: Point,
}

#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct RenderCacheStats {
    pub static_rebuilds: u64,
    pub river_rebuilds: u64,
    pub environment_rebuilds: u64,
    pub shoreline_chunk_builds: u64,
    pub contour_chunk_builds: u64,
    pub shoreline_chunks_cached: usize,
    pub contour_chunks_cached: usize,
    pub last_river_build_micros: u64,
    pub last_shoreline_build_micros: u64,
    pub last_contour_build_micros: u64,
    pub last_river_cache_hit: bool,
    pub last_contour_cache_hit: bool,
    pub last_shoreline_cache_hit: bool,
    pub last_river_bucket_before: u32,
    pub last_river_bucket_after: u32,
    pub last_river_segments_input: usize,
    pub last_river_vertices_output: usize,
    pub last_contour_lod: u8,
    pub last_contour_canonical_samples: u64,
    pub last_contour_vertices_output: usize,
    pub last_shoreline_canonical_samples: u64,
    pub last_shoreline_vertices_output: usize,
}

impl PartialEq for RenderCacheStats {
    fn eq(&self, other: &Self) -> bool {
        self.static_rebuilds == other.static_rebuilds
            && self.river_rebuilds == other.river_rebuilds
            && self.environment_rebuilds == other.environment_rebuilds
            && self.shoreline_chunk_builds == other.shoreline_chunk_builds
            && self.contour_chunk_builds == other.contour_chunk_builds
            && self.shoreline_chunks_cached == other.shoreline_chunks_cached
            && self.contour_chunks_cached == other.contour_chunks_cached
    }
}

impl Eq for RenderCacheStats {}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct EnvironmentCacheKey {
    layer: EnvironmentLayer,
    opacity: u8,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ShorelineCacheKey {
    first_x: u32,
    last_x: u32,
    first_y: u32,
    last_y: u32,
    revision_hash: u64,
    lod: u8,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
struct ShorelineChunkCacheKey {
    map_hash: u64,
    surface_revision: u64,
    chunk_x: u32,
    chunk_y: u32,
    lod: u8,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ContourCacheKey {
    map_hash: u64,
    surface_revision: u64,
    sea_level_bits: u32,
    interval_bits: u32,
    lod: u8,
    first_chunk_x: u32,
    last_chunk_x: u32,
    first_chunk_y: u32,
    last_chunk_y: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
struct ContourChunkCacheKey {
    map_hash: u64,
    surface_revision: u64,
    sea_level_bits: u32,
    interval_bits: u32,
    lod: u8,
    chunk_x: u32,
    chunk_y: u32,
}

#[derive(Clone)]
pub(crate) struct MapRenderCache {
    pub territory_mesh: Arc<Mesh>,
    pub shoreline_mesh: Arc<Mesh>,
    pub river_mesh: Arc<Mesh>,
    pub road_mesh: Arc<Mesh>,
    pub contour_mesh: Arc<Mesh>,
    pub country_anchors: Arc<Vec<CountryLabelAnchor>>,
    contour_cache_key: Option<ContourCacheKey>,
    contour_scale_key: Option<u8>,
    river_scale_key: Option<u32>,
    river_scale_floor: f32,
    shoreline_cache_key: Option<ShorelineCacheKey>,
    shoreline_chunks: HashMap<ShorelineChunkCacheKey, Arc<Mesh>>,
    shoreline_chunk_order: VecDeque<ShorelineChunkCacheKey>,
    contour_chunks: HashMap<ContourChunkCacheKey, Arc<Mesh>>,
    contour_chunk_order: VecDeque<ContourChunkCacheKey>,
    environment_cache: Option<(EnvironmentCacheKey, Arc<Mesh>)>,
    stats: RenderCacheStats,
}

impl MapRenderCache {
    pub(crate) fn build(map: &NativeMap, territory_opacity: f32) -> Self {
        let started = std::time::Instant::now();
        let canonical_dimensions = map
            .canonical_surface
            .as_ref()
            .map(|surface| format!("{}x{}", surface.width, surface.height))
            .unwrap_or_else(|| "none".to_owned());
        crate::diagnostics::event(
            "map_render",
            "cache_build",
            "started",
            &[
                ("map_id", map.source_id.clone()),
                ("map_title", map.title.clone()),
                (
                    "analysis_grid",
                    format!("{}x{}", map.grid_width, map.grid_height),
                ),
                ("canonical_surface", canonical_dimensions.clone()),
                ("factions", map.factions.len().to_string()),
                ("territory_cells", map.territory_owners.len().to_string()),
            ],
        );
        let territory_mesh = build_territory_mesh_with_opacity(map, territory_opacity);
        let cache = Self {
            territory_mesh,
            shoreline_mesh: Arc::new(Mesh::default()),
            river_mesh: Arc::new(Mesh::default()),
            road_mesh: Arc::new(build_road_mesh(map)),
            contour_mesh: Arc::new(Mesh::default()),
            country_anchors: Arc::new(build_country_anchors(map)),
            contour_cache_key: None,
            contour_scale_key: None,
            river_scale_key: None,
            river_scale_floor: river_scale_floor(map),
            shoreline_cache_key: None,
            shoreline_chunks: HashMap::new(),
            shoreline_chunk_order: VecDeque::new(),
            contour_chunks: HashMap::new(),
            contour_chunk_order: VecDeque::new(),
            environment_cache: None,
            stats: RenderCacheStats {
                static_rebuilds: 1,
                ..Default::default()
            },
        };
        crate::diagnostics::event(
            "map_render",
            "cache_build",
            "completed",
            &[
                ("map_id", map.source_id.clone()),
                ("canonical_surface", canonical_dimensions),
                ("elapsed_ms", started.elapsed().as_millis().to_string()),
                (
                    "territory_vertices",
                    cache.territory_mesh.vertices.len().to_string(),
                ),
                ("road_vertices", cache.road_mesh.vertices.len().to_string()),
            ],
        );
        cache
    }

    pub(crate) fn rebuild_all(&mut self, map: &NativeMap, territory_opacity: f32) {
        self.territory_mesh = build_territory_mesh_with_opacity(map, territory_opacity);
        self.rebuild_derived(map);
    }

    pub(crate) fn rebuild_derived(&mut self, map: &NativeMap) {
        self.shoreline_mesh = Arc::new(Mesh::default());
        self.shoreline_cache_key = None;
        self.shoreline_chunks.clear();
        self.shoreline_chunk_order.clear();
        self.stats.shoreline_chunks_cached = 0;
        self.road_mesh = Arc::new(build_road_mesh(map));
        self.contour_mesh = Arc::new(Mesh::default());
        self.contour_cache_key = None;
        self.contour_scale_key = None;
        self.contour_chunks.clear();
        self.contour_chunk_order.clear();
        self.stats.contour_chunks_cached = 0;
        self.country_anchors = Arc::new(build_country_anchors(map));
        self.river_scale_key = None;
        self.river_scale_floor = river_scale_floor(map);
        self.river_mesh = Arc::new(Mesh::default());
        self.environment_cache = None;
        self.stats.static_rebuilds = self.stats.static_rebuilds.saturating_add(1);
    }

    pub(crate) fn rebuild_territory(&mut self, map: &NativeMap, opacity: f32) {
        self.territory_mesh = build_territory_mesh_with_opacity(map, opacity);
        self.country_anchors = Arc::new(build_country_anchors(map));
        self.stats.static_rebuilds = self.stats.static_rebuilds.saturating_add(1);
    }

    pub(crate) fn rebuild_transport(&mut self, map: &NativeMap) {
        self.road_mesh = Arc::new(build_road_mesh(map));
        self.river_scale_key = None;
        self.river_scale_floor = river_scale_floor(map);
        self.river_mesh = Arc::new(Mesh::default());
        self.stats.static_rebuilds = self.stats.static_rebuilds.saturating_add(1);
    }

    pub(crate) fn ensure_river_mesh(&mut self, map: &NativeMap, screen_scale: f32) {
        self.ensure_river_mesh_traced(map, screen_scale, None);
    }

    pub(crate) fn ensure_river_mesh_traced(
        &mut self,
        map: &NativeMap,
        screen_scale: f32,
        zoom_event_id: Option<u64>,
    ) {
        self.stats.last_river_build_micros = 0;
        let screen_scale = screen_scale.max(0.000_001);
        let floor = self.river_scale_floor;
        let key = river_scale_key(screen_scale, floor);
        self.stats.last_river_bucket_before = self.river_scale_key.unwrap_or(u32::MAX);
        self.stats.last_river_bucket_after = key;
        self.stats.last_river_segments_input = map.rivers.len();
        if self.river_scale_key == Some(key) {
            self.stats.last_river_cache_hit = true;
            self.log_river_trace(zoom_event_id);
            return;
        }
        self.stats.last_river_cache_hit = false;
        let started = std::time::Instant::now();
        let mesh_scale = quantized_river_screen_scale(key, floor);
        self.river_mesh = Arc::new(build_river_mesh(map, mesh_scale, floor));
        self.river_scale_key = Some(key);
        self.stats.river_rebuilds = self.stats.river_rebuilds.saturating_add(1);
        self.stats.last_river_build_micros = started.elapsed().as_micros() as u64;
        self.stats.last_river_vertices_output = self.river_mesh.vertices.len();
        self.log_river_trace(zoom_event_id);
    }

    fn log_river_trace(&self, zoom_event_id: Option<u64>) {
        let Some(zoom_event_id) = zoom_event_id else {
            return;
        };
        crate::diagnostics::event(
            "river_mesh",
            "ensure",
            "completed",
            &[
                ("zoom_event_id", zoom_event_id.to_string()),
                (
                    "river_cache_hit",
                    self.stats.last_river_cache_hit.to_string(),
                ),
                (
                    "river_bucket_before",
                    self.stats.last_river_bucket_before.to_string(),
                ),
                (
                    "river_bucket_after",
                    self.stats.last_river_bucket_after.to_string(),
                ),
                (
                    "river_segments_input",
                    self.stats.last_river_segments_input.to_string(),
                ),
                (
                    "river_vertices_output",
                    self.stats.last_river_vertices_output.to_string(),
                ),
                (
                    "river_mesh_us",
                    self.stats.last_river_build_micros.to_string(),
                ),
            ],
        );
    }

    pub(crate) fn ensure_contour_mesh(
        &mut self,
        map: &NativeMap,
        screen_scale: f32,
        view: eframe::egui::Rect,
    ) {
        self.ensure_contour_mesh_traced(map, screen_scale, view, None);
    }

    pub(crate) fn ensure_contour_mesh_traced(
        &mut self,
        map: &NativeMap,
        screen_scale: f32,
        view: eframe::egui::Rect,
        zoom_event_id: Option<u64>,
    ) {
        self.stats.last_contour_build_micros = 0;
        let lod = contour_lod_key_hysteretic(screen_scale, self.contour_scale_key);
        self.stats.last_contour_lod = lod;
        self.stats.last_contour_canonical_samples = 0;
        let Some(key) = contour_cache_key(map, lod, view) else {
            self.contour_mesh = Arc::new(Mesh::default());
            self.contour_cache_key = None;
            self.contour_scale_key = Some(lod);
            self.stats.last_contour_cache_hit = false;
            self.log_contour_trace(zoom_event_id);
            return;
        };
        if self.contour_cache_key == Some(key) {
            self.stats.last_contour_cache_hit = true;
            self.log_contour_trace(zoom_event_id);
            return;
        }
        self.stats.last_contour_cache_hit = false;
        let started = std::time::Instant::now();
        begin_canonical_sample_trace();
        self.contour_mesh =
            Arc::new(self.build_contour_mesh_for_bounds_cached(map, key, screen_scale));
        let samples = finish_canonical_sample_trace();
        self.contour_cache_key = Some(key);
        self.contour_scale_key = Some(lod);
        self.stats.last_contour_build_micros = started.elapsed().as_micros() as u64;
        self.stats.last_contour_canonical_samples = samples.cells_requested;
        self.stats.last_contour_vertices_output = self.contour_mesh.vertices.len();
        self.log_contour_trace(zoom_event_id);
    }

    fn log_contour_trace(&self, zoom_event_id: Option<u64>) {
        let Some(zoom_event_id) = zoom_event_id else {
            return;
        };
        crate::diagnostics::event(
            "contour_mesh",
            "ensure",
            "completed",
            &[
                ("zoom_event_id", zoom_event_id.to_string()),
                (
                    "contour_cache_hit",
                    self.stats.last_contour_cache_hit.to_string(),
                ),
                ("contour_lod", self.stats.last_contour_lod.to_string()),
                (
                    "canonical_cells_sampled",
                    self.stats.last_contour_canonical_samples.to_string(),
                ),
                (
                    "contour_vertices_output",
                    self.stats.last_contour_vertices_output.to_string(),
                ),
                (
                    "contour_mesh_us",
                    self.stats.last_contour_build_micros.to_string(),
                ),
            ],
        );
    }

    pub(crate) fn shoreline_mesh_for_view(
        &mut self,
        map: &NativeMap,
        view: eframe::egui::Rect,
    ) -> Arc<Mesh> {
        self.shoreline_mesh_for_view_traced(map, view, 1.0, None)
    }

    pub(crate) fn shoreline_mesh_for_view_traced(
        &mut self,
        map: &NativeMap,
        view: eframe::egui::Rect,
        screen_scale: f32,
        zoom_event_id: Option<u64>,
    ) -> Arc<Mesh> {
        self.stats.last_shoreline_build_micros = 0;
        self.stats.last_shoreline_canonical_samples = 0;
        let Some(key) = shoreline_cache_key(map, view, shoreline_lod_key(screen_scale)) else {
            self.stats.last_shoreline_cache_hit = false;
            self.log_shoreline_trace(zoom_event_id);
            return Arc::new(Mesh::default());
        };
        if self.shoreline_cache_key == Some(key) {
            self.stats.last_shoreline_cache_hit = true;
            self.log_shoreline_trace(zoom_event_id);
            return Arc::clone(&self.shoreline_mesh);
        }
        self.stats.last_shoreline_cache_hit = false;
        let started = std::time::Instant::now();
        begin_canonical_sample_trace();
        self.shoreline_mesh = Arc::new(self.build_shoreline_mesh_for_bounds_cached(map, key));
        let samples = finish_canonical_sample_trace();
        self.shoreline_cache_key = Some(key);
        self.stats.last_shoreline_build_micros = started.elapsed().as_micros() as u64;
        self.stats.last_shoreline_canonical_samples = samples.cells_requested;
        self.stats.last_shoreline_vertices_output = self.shoreline_mesh.vertices.len();
        self.log_shoreline_trace(zoom_event_id);
        Arc::clone(&self.shoreline_mesh)
    }

    fn log_shoreline_trace(&self, zoom_event_id: Option<u64>) {
        let Some(zoom_event_id) = zoom_event_id else {
            return;
        };
        crate::diagnostics::event(
            "shoreline_mesh",
            "ensure",
            "completed",
            &[
                ("zoom_event_id", zoom_event_id.to_string()),
                (
                    "shoreline_cache_hit",
                    self.stats.last_shoreline_cache_hit.to_string(),
                ),
                (
                    "canonical_cells_sampled",
                    self.stats.last_shoreline_canonical_samples.to_string(),
                ),
                (
                    "shoreline_vertices_output",
                    self.stats.last_shoreline_vertices_output.to_string(),
                ),
                (
                    "shoreline_mesh_us",
                    self.stats.last_shoreline_build_micros.to_string(),
                ),
            ],
        );
    }

    fn build_shoreline_mesh_for_bounds_cached(
        &mut self,
        map: &NativeMap,
        bounds: ShorelineCacheKey,
    ) -> Mesh {
        let mut combined = Mesh::default();
        let map_hash = stable_map_hash(map);
        for chunk_y in bounds.first_y..bounds.last_y {
            for chunk_x in bounds.first_x..bounds.last_x {
                let key = ShorelineChunkCacheKey {
                    map_hash,
                    surface_revision: map
                        .canonical_surface
                        .as_ref()
                        .map(|surface| chunk_halo_revision_hash(surface, chunk_x, chunk_y, 1))
                        .unwrap_or(map.surface_revision),
                    chunk_x,
                    chunk_y,
                    lod: bounds.lod,
                };
                let mesh = if let Some(mesh) = self.shoreline_chunks.get(&key) {
                    Arc::clone(mesh)
                } else {
                    let mesh = Arc::new(build_shoreline_chunk_mesh(
                        map, chunk_x, chunk_y, bounds.lod,
                    ));
                    self.insert_shoreline_chunk(key, Arc::clone(&mesh));
                    mesh
                };
                append_mesh(&mut combined, &mesh);
            }
        }
        combined
    }

    fn build_contour_mesh_for_bounds_cached(
        &mut self,
        map: &NativeMap,
        bounds: ContourCacheKey,
        screen_scale: f32,
    ) -> Mesh {
        let mut combined = Mesh::default();
        for chunk_y in bounds.first_chunk_y..bounds.last_chunk_y {
            for chunk_x in bounds.first_chunk_x..bounds.last_chunk_x {
                let key = ContourChunkCacheKey {
                    map_hash: bounds.map_hash,
                    surface_revision: map
                        .canonical_surface
                        .as_ref()
                        .and_then(|surface| surface.chunk_revision(chunk_x, chunk_y))
                        .unwrap_or(bounds.surface_revision),
                    sea_level_bits: bounds.sea_level_bits,
                    interval_bits: bounds.interval_bits,
                    lod: bounds.lod,
                    chunk_x,
                    chunk_y,
                };
                let mesh = if let Some(mesh) = self.contour_chunks.get(&key) {
                    Arc::clone(mesh)
                } else {
                    let (minimum, maximum) = contour_chunk_world_bounds(map, chunk_x, chunk_y);
                    let contours = contour::build_for_bounds(map, bounds.lod, minimum, maximum);
                    let mesh =
                        Arc::new(build_contour_mesh(map, &contours, screen_scale, bounds.lod));
                    self.insert_contour_chunk(key, Arc::clone(&mesh));
                    mesh
                };
                append_mesh(&mut combined, &mesh);
            }
        }
        combined
    }

    fn insert_shoreline_chunk(&mut self, key: ShorelineChunkCacheKey, mesh: Arc<Mesh>) {
        while self.shoreline_chunks.len() >= MAX_DERIVED_CHUNK_MESHES {
            let Some(expired) = self.shoreline_chunk_order.pop_front() else {
                break;
            };
            self.shoreline_chunks.remove(&expired);
        }
        self.shoreline_chunks.insert(key, mesh);
        self.shoreline_chunk_order.push_back(key);
        self.stats.shoreline_chunk_builds = self.stats.shoreline_chunk_builds.saturating_add(1);
        self.stats.shoreline_chunks_cached = self.shoreline_chunks.len();
    }

    fn insert_contour_chunk(&mut self, key: ContourChunkCacheKey, mesh: Arc<Mesh>) {
        while self.contour_chunks.len() >= MAX_DERIVED_CHUNK_MESHES {
            let Some(expired) = self.contour_chunk_order.pop_front() else {
                break;
            };
            self.contour_chunks.remove(&expired);
        }
        self.contour_chunks.insert(key, mesh);
        self.contour_chunk_order.push_back(key);
        self.stats.contour_chunk_builds = self.stats.contour_chunk_builds.saturating_add(1);
        self.stats.contour_chunks_cached = self.contour_chunks.len();
    }

    pub(crate) fn environment_mesh(
        &mut self,
        map: &NativeMap,
        layer: EnvironmentLayer,
        opacity: f32,
    ) -> Arc<Mesh> {
        let key = EnvironmentCacheKey {
            layer,
            opacity: (opacity.clamp(0.0, 1.0) * 255.0).round() as u8,
        };
        if let Some((cached_key, mesh)) = &self.environment_cache
            && *cached_key == key
        {
            return Arc::clone(mesh);
        }
        let mesh = Arc::new(build_environment_mesh(map, layer, key.opacity));
        self.environment_cache = Some((key, Arc::clone(&mesh)));
        self.stats.environment_rebuilds = self.stats.environment_rebuilds.saturating_add(1);
        mesh
    }

    pub(crate) fn invalidate_environment(&mut self) {
        self.environment_cache = None;
    }

    pub(crate) fn stats(&self) -> RenderCacheStats {
        self.stats
    }
}

fn river_scale_key(screen_scale: f32, floor: f32) -> u32 {
    if screen_scale >= floor {
        u32::MAX
    } else {
        let octave_step = ((screen_scale.max(0.000_001) / floor.max(0.000_001)).log2()
            * RIVER_SCALE_STEPS_PER_OCTAVE)
            .round() as i32;
        (octave_step + 4_096).clamp(0, 8_191) as u32
    }
}

fn quantized_river_screen_scale(key: u32, floor: f32) -> f32 {
    if key == u32::MAX {
        floor
    } else {
        let octave_step = key as i32 - 4_096;
        floor * 2.0_f32.powf(octave_step as f32 / RIVER_SCALE_STEPS_PER_OCTAVE)
    }
}

pub(crate) fn river_scale_floor(map: &NativeMap) -> f32 {
    let minimum = map
        .rivers
        .iter()
        .map(|river| river.width)
        .filter(|width| width.is_finite() && *width > 0.0)
        .fold(f32::INFINITY, f32::min);
    if minimum.is_finite() {
        MIN_RIVER_SCREEN_WIDTH / minimum
    } else {
        1.0
    }
}

#[cfg(test)]
pub(crate) fn displayed_river_width(
    physical_width: f32,
    screen_scale: f32,
    scale_floor: f32,
) -> f32 {
    physical_width.max(0.000_1) * screen_scale.max(scale_floor)
}

fn build_river_mesh(map: &NativeMap, screen_scale: f32, floor: f32) -> Mesh {
    use std::collections::HashMap;

    let mut mesh = Mesh::default();
    let effective_scale = screen_scale.max(floor);
    let world_multiplier = effective_scale / screen_scale.max(0.000_001);
    let color = Color32::from_rgb(75, 173, 230);
    let node_key = |point: Point| {
        (
            (point.x * 10_000.0).round() as i64,
            (point.y * 10_000.0).round() as i64,
        )
    };
    let mut joins = HashMap::<(i64, i64), (Pos2, f32)>::new();
    for river in &map.rivers {
        let width = river.width.max(0.000_1) * world_multiplier;
        add_segment(&mut mesh, river.start, river.end, width, color, false);
        for point in [river.start, river.end] {
            joins
                .entry(node_key(point))
                .and_modify(|(_, radius)| *radius = radius.max(width * 0.5))
                .or_insert((Pos2::new(point.x, point.y), width * 0.5));
        }
    }
    for (_, (center, radius)) in joins {
        add_disc(&mut mesh, center, radius, color);
    }
    mesh
}

fn build_road_mesh(map: &NativeMap) -> Mesh {
    let mut mesh = Mesh::default();
    let width = (map.width.max(map.height) / 1_050.0).clamp(0.08, 1.2);
    let color = Color32::from_rgb(92, 58, 43);
    for road in &map.roads {
        for points in road.nodes.windows(2) {
            add_segment(&mut mesh, points[0], points[1], width, color, true);
        }
    }
    mesh
}

fn contour_cache_key(
    map: &NativeMap,
    lod: u8,
    view: eframe::egui::Rect,
) -> Option<ContourCacheKey> {
    let (surface_width, surface_height) = map.canonical_cell_dimensions();
    if surface_width < 2 || surface_height < 2 || map.width <= 0.0 || map.height <= 0.0 {
        return None;
    }
    let chunks_x = (surface_width as u32).div_ceil(CanonicalSurface::CHUNK_SIZE);
    let chunks_y = (surface_height as u32).div_ceil(CanonicalSurface::CHUNK_SIZE);
    let chunk_world_width = CanonicalSurface::CHUNK_SIZE as f32 * map.width / surface_width as f32;
    let chunk_world_height =
        CanonicalSurface::CHUNK_SIZE as f32 * map.height / surface_height as f32;
    let first_chunk_x = (view.left() / chunk_world_width)
        .floor()
        .clamp(0.0, chunks_x.saturating_sub(1) as f32) as u32;
    let first_chunk_y = (view.top() / chunk_world_height)
        .floor()
        .clamp(0.0, chunks_y.saturating_sub(1) as f32) as u32;
    let last_chunk_x = (view.right() / chunk_world_width)
        .ceil()
        .clamp((first_chunk_x + 1) as f32, chunks_x as f32) as u32;
    let last_chunk_y = (view.bottom() / chunk_world_height)
        .ceil()
        .clamp((first_chunk_y + 1) as f32, chunks_y as f32) as u32;
    let mut hasher = DefaultHasher::new();
    map.source_id.hash(&mut hasher);
    Some(ContourCacheKey {
        map_hash: hasher.finish(),
        surface_revision: map.surface_revision,
        sea_level_bits: map.sea_level.to_bits(),
        interval_bits: contour::interval(map).to_bits(),
        lod,
        first_chunk_x: first_chunk_x.saturating_sub(1),
        last_chunk_x: last_chunk_x.saturating_add(1).min(chunks_x),
        first_chunk_y: first_chunk_y.saturating_sub(1),
        last_chunk_y: last_chunk_y.saturating_add(1).min(chunks_y),
    })
}

fn stable_map_hash(map: &NativeMap) -> u64 {
    let mut hasher = DefaultHasher::new();
    map.source_id.hash(&mut hasher);
    map.environment_seed.hash(&mut hasher);
    map.sea_level.to_bits().hash(&mut hasher);
    DISPLAY_FIELD_VERSION.hash(&mut hasher);
    hasher.finish()
}

fn contour_chunk_world_bounds(map: &NativeMap, chunk_x: u32, chunk_y: u32) -> (Point, Point) {
    let (surface_width, surface_height) = map.canonical_cell_dimensions();
    let cell_world_width = map.width / surface_width.max(1) as f32;
    let cell_world_height = map.height / surface_height.max(1) as f32;
    let minimum = Point {
        x: chunk_x as f32 * CanonicalSurface::CHUNK_SIZE as f32 * cell_world_width,
        y: chunk_y as f32 * CanonicalSurface::CHUNK_SIZE as f32 * cell_world_height,
    };
    let maximum = Point {
        x: ((chunk_x + 1) as f32 * CanonicalSurface::CHUNK_SIZE as f32 * cell_world_width)
            .min(map.width),
        y: ((chunk_y + 1) as f32 * CanonicalSurface::CHUNK_SIZE as f32 * cell_world_height)
            .min(map.height),
    };
    (minimum, maximum)
}

fn shoreline_cache_key(
    map: &NativeMap,
    view: eframe::egui::Rect,
    lod: u8,
) -> Option<ShorelineCacheKey> {
    let surface = map.canonical_surface.as_ref()?;
    let (chunks_x, chunks_y) = surface.chunk_grid_dimensions();
    if chunks_x == 0 || chunks_y == 0 {
        return None;
    }
    let chunk_world_width =
        crate::model::CanonicalSurface::CHUNK_SIZE as f32 * map.width / surface.width as f32;
    let chunk_world_height =
        crate::model::CanonicalSurface::CHUNK_SIZE as f32 * map.height / surface.height as f32;
    let first_x = (view.left() / chunk_world_width)
        .floor()
        .clamp(0.0, chunks_x.saturating_sub(1) as f32) as u32;
    let last_x = (view.right() / chunk_world_width)
        .ceil()
        .clamp((first_x + 1) as f32, chunks_x as f32) as u32;
    let first_y = (view.top() / chunk_world_height)
        .floor()
        .clamp(0.0, chunks_y.saturating_sub(1) as f32) as u32;
    let last_y = (view.bottom() / chunk_world_height)
        .ceil()
        .clamp((first_y + 1) as f32, chunks_y as f32) as u32;
    let first_x = first_x.saturating_sub(1);
    let first_y = first_y.saturating_sub(1);
    let last_x = last_x.saturating_add(1).min(chunks_x);
    let last_y = last_y.saturating_add(1).min(chunks_y);
    let mut revision_hash = 0xcbf2_9ce4_8422_2325_u64
        ^ DISPLAY_FIELD_VERSION
        ^ u64::from(map.environment_seed)
        ^ u64::from(map.sea_level.to_bits());
    for chunk_y in first_y..last_y {
        for chunk_x in first_x..last_x {
            revision_hash ^= chunk_halo_revision_hash(surface, chunk_x, chunk_y, 1);
            revision_hash = revision_hash.wrapping_mul(0x100_0000_01b3);
            revision_hash ^= ((chunk_y as u64) << 32) | chunk_x as u64;
        }
    }
    Some(ShorelineCacheKey {
        first_x,
        last_x,
        first_y,
        last_y,
        revision_hash,
        lod,
    })
}

fn build_shoreline_chunk_mesh(map: &NativeMap, chunk_x: u32, chunk_y: u32, lod: u8) -> Mesh {
    let mut mesh = Mesh::default();
    let width = (map.width.max(map.height) / 1_650.0).clamp(0.04, 0.8);
    let color = Color32::from_rgb(226, 239, 244);
    let segments = build_shoreline_chunk(map, chunk_x, chunk_y);
    let cell_size = map
        .canonical_surface
        .as_ref()
        .map(|surface| {
            (map.width / surface.width.max(1) as f32).max(map.height / surface.height.max(1) as f32)
        })
        .unwrap_or(0.1);
    let tolerance = cell_size * [0.0, 0.28, 0.62, 1.15][lod.min(3) as usize];
    for polyline in stitch_shoreline_segments(&segments) {
        let points = simplify_polyline(&polyline, tolerance);
        for pair in points.windows(2) {
            add_segment(&mut mesh, pair[0], pair[1], width, color, false);
        }
    }
    mesh
}

fn shoreline_lod_key(screen_scale: f32) -> u8 {
    match screen_scale.max(0.0) {
        scale if scale >= 5.0 => 0,
        scale if scale >= 2.0 => 1,
        scale if scale >= 0.8 => 2,
        _ => 3,
    }
}

fn stitch_shoreline_segments(segments: &[crate::shoreline::ShorelineSegment]) -> Vec<Vec<Point>> {
    type PointKey = (u32, u32);
    let key = |point: Point| (point.x.to_bits(), point.y.to_bits());
    let mut adjacency = HashMap::<PointKey, Vec<usize>>::new();
    let mut points = HashMap::<PointKey, Point>::new();
    for (index, segment) in segments.iter().enumerate() {
        for point in [segment.start, segment.end] {
            adjacency.entry(key(point)).or_default().push(index);
            points.entry(key(point)).or_insert(point);
        }
    }
    let mut visited = vec![false; segments.len()];
    let mut polylines = Vec::new();

    let trace = |start: PointKey, visited: &mut [bool]| {
        let mut line = vec![points[&start]];
        let mut current = start;
        loop {
            let Some(segment_index) = adjacency
                .get(&current)
                .and_then(|incident| incident.iter().copied().find(|index| !visited[*index]))
            else {
                break;
            };
            visited[segment_index] = true;
            let segment = segments[segment_index];
            let next = if key(segment.start) == current {
                key(segment.end)
            } else {
                key(segment.start)
            };
            line.push(points[&next]);
            current = next;
            if current == start {
                break;
            }
        }
        line
    };

    for (&point, incident) in &adjacency {
        if incident.len() == 2 {
            continue;
        }
        while incident.iter().any(|index| !visited[*index]) {
            let line = trace(point, &mut visited);
            if line.len() >= 2 {
                polylines.push(line);
            }
        }
    }
    for segment_index in 0..segments.len() {
        if visited[segment_index] {
            continue;
        }
        let line = trace(key(segments[segment_index].start), &mut visited);
        if line.len() >= 2 {
            polylines.push(line);
        }
    }
    polylines
}

fn append_mesh(target: &mut Mesh, source: &Mesh) {
    if source.vertices.is_empty() || source.indices.is_empty() {
        return;
    }
    let base = target.vertices.len() as u32;
    target.vertices.extend_from_slice(&source.vertices);
    target
        .indices
        .extend(source.indices.iter().map(|index| base + *index));
}

fn contour_lod_key(screen_scale: f32) -> u8 {
    match screen_scale.max(0.0) {
        scale if scale >= 5.0 => 0,
        scale if scale >= 2.0 => 1,
        scale if scale >= 0.8 => 2,
        _ => 3,
    }
}

fn contour_lod_key_hysteretic(screen_scale: f32, current: Option<u8>) -> u8 {
    let desired = contour_lod_key(screen_scale);
    let Some(current) = current else {
        return desired;
    };
    if desired > current {
        let lower_boundary = [5.0, 2.0, 0.8][current.min(2) as usize] * 0.90;
        if screen_scale > lower_boundary {
            return current;
        }
    } else if desired < current {
        let upper_boundary = [5.0, 2.0, 0.8][desired.min(2) as usize] * 1.10;
        if screen_scale < upper_boundary {
            return current;
        }
    }
    desired
}

fn contour_interval(contours: &[ContourLine]) -> f32 {
    let mut elevations = contours
        .iter()
        .map(|line| line.elevation)
        .filter(|value| value.is_finite())
        .collect::<Vec<_>>();
    elevations.sort_by(f32::total_cmp);
    elevations.dedup_by(|left, right| (*left - *right).abs() < 0.001);
    elevations
        .windows(2)
        .map(|values| values[1] - values[0])
        .filter(|value| *value > 0.001)
        .fold(f32::INFINITY, f32::min)
        .is_finite()
        .then(|| {
            elevations
                .windows(2)
                .map(|values| values[1] - values[0])
                .filter(|value| *value > 0.001)
                .fold(f32::INFINITY, f32::min)
        })
        .unwrap_or(1.0)
}

fn contour_visible_at_lod(line: &ContourLine, interval: f32, lod: u8) -> bool {
    let ordinal = (line.elevation / interval.max(0.001)).round() as i32;
    match lod {
        0 => true,
        1 => line.major || ordinal.rem_euclid(2) == 0,
        2 => line.major,
        _ => line.major && ordinal.rem_euclid(10) == 0,
    }
}

fn simplify_polyline(points: &[Point], tolerance: f32) -> Vec<Point> {
    if points.len() <= 2 || tolerance <= 0.0 {
        return points.to_vec();
    }
    let mut keep = vec![false; points.len()];
    keep[0] = true;
    keep[points.len() - 1] = true;
    let mut ranges = vec![(0_usize, points.len() - 1)];
    let tolerance_squared = tolerance * tolerance;
    while let Some((start, end)) = ranges.pop() {
        if end <= start + 1 {
            continue;
        }
        let a = points[start];
        let b = points[end];
        let delta_x = b.x - a.x;
        let delta_y = b.y - a.y;
        let length_squared = delta_x * delta_x + delta_y * delta_y;
        let mut farthest = None;
        let mut farthest_distance = tolerance_squared;
        for (index, point) in points.iter().enumerate().take(end).skip(start + 1) {
            let ratio = if length_squared <= f32::EPSILON {
                0.0
            } else {
                (((point.x - a.x) * delta_x + (point.y - a.y) * delta_y) / length_squared)
                    .clamp(0.0, 1.0)
            };
            let projected_x = a.x + delta_x * ratio;
            let projected_y = a.y + delta_y * ratio;
            let distance = (point.x - projected_x).powi(2) + (point.y - projected_y).powi(2);
            if distance > farthest_distance {
                farthest_distance = distance;
                farthest = Some(index);
            }
        }
        if let Some(index) = farthest {
            keep[index] = true;
            ranges.push((start, index));
            ranges.push((index, end));
        }
    }
    points
        .iter()
        .copied()
        .zip(keep)
        .filter_map(|(point, keep)| keep.then_some(point))
        .collect()
}

fn build_contour_mesh(
    map: &NativeMap,
    contours: &[ContourLine],
    screen_scale: f32,
    lod: u8,
) -> Mesh {
    let mut mesh = Mesh::default();
    let basis = (map.width.max(map.height) / 3_400.0).clamp(0.018, 0.35);
    let interval = contour_interval(contours);
    let screen_tolerance = [0.18, 0.55, 0.9, 1.35][lod.min(3) as usize];
    let world_tolerance = screen_tolerance / screen_scale.max(0.05);
    for line in contours
        .iter()
        .filter(|line| contour_visible_at_lod(line, interval, lod))
    {
        let relief_weight = (line.elevation.abs() / 8_000.0).clamp(0.0, 1.0);
        let (width, color) = if line.major {
            (
                basis * (1.45 + relief_weight * 0.2),
                Color32::from_rgba_unmultiplied(38, 52, 42, 145),
            )
        } else {
            (
                basis * (0.8 + relief_weight * 0.1),
                Color32::from_rgba_unmultiplied(45, 59, 48, 102),
            )
        };
        let simplified = simplify_polyline(&line.points, world_tolerance);
        for points in simplified.windows(2) {
            add_segment(&mut mesh, points[0], points[1], width, color, false);
        }
    }
    mesh
}

fn build_country_anchors(map: &NativeMap) -> Vec<CountryLabelAnchor> {
    let mut totals = vec![(0.0_f32, 0.0_f32, 0_u32); map.factions.len()];
    let cell_width = map.width / map.grid_width.max(1) as f32;
    let cell_height = map.height / map.grid_height.max(1) as f32;
    for (index, owner) in map.territory_owners.iter().copied().enumerate() {
        let Some(total) = usize::try_from(owner)
            .ok()
            .and_then(|owner| totals.get_mut(owner))
        else {
            continue;
        };
        let x = index % map.grid_width.max(1);
        let y = index / map.grid_width.max(1);
        total.0 += (x as f32 + 0.5) * cell_width;
        total.1 += (y as f32 + 0.5) * cell_height;
        total.2 += 1;
    }
    map.factions
        .iter()
        .zip(totals)
        .filter_map(|(faction, (x, y, count))| {
            (count > 0).then(|| CountryLabelAnchor {
                name: faction.name.clone(),
                position: Point {
                    x: x / count as f32,
                    y: y / count as f32,
                },
            })
        })
        .collect()
}

fn build_environment_mesh(map: &NativeMap, layer: EnvironmentLayer, alpha: u8) -> Mesh {
    let columns = map.grid_width.min(160).max(2);
    let rows = map.grid_height.min(96).max(2);
    let mut mesh = Mesh::default();
    for row in 0..=rows {
        let source_y = ((row as f32 / rows as f32) * map.grid_height.saturating_sub(1) as f32)
            .round() as usize;
        for column in 0..=columns {
            let source_x = ((column as f32 / columns as f32)
                * map.grid_width.saturating_sub(1) as f32)
                .round() as usize;
            let index = source_y * map.grid_width + source_x;
            mesh.vertices.push(Vertex {
                pos: Pos2::new(
                    column as f32 / columns as f32 * map.width,
                    row as f32 / rows as f32 * map.height,
                ),
                uv: eframe::egui::epaint::WHITE_UV,
                color: environment_value_color(
                    environment_layer_value(map, index, source_y, layer),
                    alpha,
                ),
            });
        }
    }
    let stride = columns + 1;
    for row in 0..rows {
        for column in 0..columns {
            let top_left = (row * stride + column) as u32;
            let top_right = top_left + 1;
            let bottom_left = top_left + stride as u32;
            let bottom_right = bottom_left + 1;
            mesh.indices.extend_from_slice(&[
                top_left,
                top_right,
                bottom_right,
                top_left,
                bottom_right,
                bottom_left,
            ]);
        }
    }
    mesh
}

fn environment_layer_value(
    map: &NativeMap,
    index: usize,
    y: usize,
    layer: EnvironmentLayer,
) -> f32 {
    let latitude = (1.0 - y as f32 / map.grid_height.max(1) as f32 * 2.0).abs();
    let elevation = map.elevation.get(index).copied().unwrap_or(map.sea_level);
    let (value, minimum, maximum) = match layer {
        EnvironmentLayer::Temperature => (
            map.temperature
                .get(index)
                .copied()
                .unwrap_or(28.0 - latitude * 44.0 - elevation.max(0.0) / 1_000.0 * 6.0),
            -35.0,
            42.0,
        ),
        EnvironmentLayer::Humidity => {
            (map.humidity.get(index).copied().unwrap_or(55.0), 0.0, 100.0)
        }
        EnvironmentLayer::WindSpeed => {
            let x = map.wind_x.get(index).copied().unwrap_or(3.0);
            let y = map.wind_y.get(index).copied().unwrap_or(2.0);
            ((x * x + y * y).sqrt(), 0.0, 22.0)
        }
        EnvironmentLayer::Precipitation => (
            map.precipitation.get(index).copied().unwrap_or(720.0),
            0.0,
            2_400.0,
        ),
        EnvironmentLayer::Snowfall => (map.snowfall.get(index).copied().unwrap_or(0.0), 0.0, 800.0),
        EnvironmentLayer::Evapotranspiration => (
            map.evapotranspiration.get(index).copied().unwrap_or(480.0),
            0.0,
            1_600.0,
        ),
        EnvironmentLayer::SoilMoisture => {
            let value = map.moisture.get(index).copied().unwrap_or(0.5);
            (if value <= 1.0 { value * 100.0 } else { value }, 0.0, 100.0)
        }
        EnvironmentLayer::SolarIrradiance => (
            map.solar_irradiance.get(index).copied().unwrap_or(185.0),
            0.0,
            360.0,
        ),
        EnvironmentLayer::SolarHours => (
            map.solar_hours.get(index).copied().unwrap_or(12.0),
            0.0,
            24.0,
        ),
    };
    ((value - minimum) / (maximum - minimum)).clamp(0.0, 1.0)
}

pub(crate) fn environment_value_color(value: f32, alpha: u8) -> Color32 {
    let stops = [
        (31.0, 82.0, 149.0),
        (47.0, 145.0, 178.0),
        (75.0, 170.0, 116.0),
        (219.0, 190.0, 77.0),
        (190.0, 63.0, 54.0),
    ];
    let scaled = value.clamp(0.0, 1.0) * (stops.len() - 1) as f32;
    let left = scaled.floor() as usize;
    let right = (left + 1).min(stops.len() - 1);
    let mix = scaled - left as f32;
    let red = (stops[left].0 * (1.0 - mix) + stops[right].0 * mix) as u8;
    let green = (stops[left].1 * (1.0 - mix) + stops[right].1 * mix) as u8;
    let blue = (stops[left].2 * (1.0 - mix) + stops[right].2 * mix) as u8;
    Color32::from_rgba_unmultiplied(red, green, blue, alpha)
}

fn add_segment(
    mesh: &mut Mesh,
    start: Point,
    end: Point,
    width: f32,
    color: Color32,
    round_caps: bool,
) {
    let delta = Vec2::new(end.x - start.x, end.y - start.y);
    let length = delta.length();
    if !length.is_finite() || length <= 0.000_001 || !width.is_finite() || width <= 0.0 {
        return;
    }
    let normal = Vec2::new(-delta.y / length, delta.x / length) * (width * 0.5);
    let start = Pos2::new(start.x, start.y);
    let end = Pos2::new(end.x, end.y);
    let base = mesh.vertices.len() as u32;
    for position in [start + normal, end + normal, end - normal, start - normal] {
        mesh.vertices.push(Vertex {
            pos: position,
            uv: eframe::egui::epaint::WHITE_UV,
            color,
        });
    }
    mesh.indices
        .extend_from_slice(&[base, base + 1, base + 2, base, base + 2, base + 3]);
    if round_caps {
        add_disc(mesh, start, width * 0.5, color);
        add_disc(mesh, end, width * 0.5, color);
    }
}

fn add_disc(mesh: &mut Mesh, center: Pos2, radius: f32, color: Color32) {
    const STEPS: usize = 8;
    let base = mesh.vertices.len() as u32;
    mesh.vertices.push(Vertex {
        pos: center,
        uv: eframe::egui::epaint::WHITE_UV,
        color,
    });
    for step in 0..STEPS {
        let angle = step as f32 / STEPS as f32 * std::f32::consts::TAU;
        mesh.vertices.push(Vertex {
            pos: center + Vec2::angled(angle) * radius,
            uv: eframe::egui::epaint::WHITE_UV,
            color,
        });
    }
    for step in 0..STEPS {
        let next = (step + 1) % STEPS;
        mesh.indices
            .extend_from_slice(&[base, base + 1 + step as u32, base + 1 + next as u32]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Language, LoadedWorld};

    #[test]
    fn zoom_floor_preserves_width_ratios() {
        let floor = 20.0;
        let thin = displayed_river_width(0.05, 2.0, floor);
        let thick = displayed_river_width(0.15, 2.0, floor);
        assert!((thin - 1.0).abs() < 0.0001);
        assert!((thick / thin - 3.0).abs() < 0.0001);
    }

    #[test]
    fn zooming_farther_out_stops_shrinking_every_segment() {
        let floor = 18.0;
        for width in [0.02, 0.05, 0.12] {
            let first = displayed_river_width(width, 2.0, floor);
            let farther = displayed_river_width(width, 0.2, floor);
            assert!((first - farther).abs() < 0.0001);
        }
    }

    #[test]
    fn widths_resume_scaling_above_the_floor() {
        let floor = 10.0;
        let at_floor = displayed_river_width(0.1, floor, floor);
        let zoomed = displayed_river_width(0.1, 25.0, floor);
        assert!((at_floor - 1.0).abs() < 0.0001);
        assert!((zoomed - 2.5).abs() < 0.0001);
    }

    #[test]
    fn contour_lod_reduces_detail_as_the_map_shrinks() {
        assert_eq!(contour_lod_key(8.0), 0);
        assert_eq!(contour_lod_key(3.0), 1);
        assert_eq!(contour_lod_key(1.0), 2);
        assert_eq!(contour_lod_key(0.3), 3);
        let minor = ContourLine {
            elevation: 100.0,
            major: false,
            points: vec![],
        };
        assert!(contour_visible_at_lod(&minor, 100.0, 0));
        assert!(!contour_visible_at_lod(&minor, 100.0, 2));
        assert_eq!(contour_lod_key_hysteretic(4.8, Some(0)), 0);
        assert_eq!(contour_lod_key_hysteretic(4.4, Some(0)), 1);
        assert_eq!(contour_lod_key_hysteretic(5.2, Some(1)), 1);
        assert_eq!(contour_lod_key_hysteretic(5.6, Some(1)), 0);
    }

    #[test]
    fn screen_space_simplification_keeps_endpoints() {
        let points = vec![
            Point { x: 0.0, y: 0.0 },
            Point { x: 1.0, y: 0.01 },
            Point { x: 2.0, y: -0.01 },
            Point { x: 3.0, y: 0.0 },
        ];
        let simplified = simplify_polyline(&points, 0.1);
        assert_eq!(simplified.len(), 2);
        assert_eq!((simplified[0].x, simplified[0].y), (0.0, 0.0));
        assert_eq!((simplified[1].x, simplified[1].y), (3.0, 0.0));
    }

    #[test]
    fn shoreline_lod_changes_only_at_quantized_thresholds() {
        assert_eq!(shoreline_lod_key(8.0), 0);
        assert_eq!(shoreline_lod_key(3.0), 1);
        assert_eq!(shoreline_lod_key(1.0), 2);
        assert_eq!(shoreline_lod_key(0.3), 3);
        assert_eq!(shoreline_lod_key(2.01), shoreline_lod_key(4.99));
    }

    #[test]
    fn neighboring_surface_edit_invalidates_visible_shoreline_key() {
        let mut map = LoadedWorld::load_demo(Language::English).expect("demo").map;
        map.width = 51.2;
        map.height = 0.8;
        map.canonical_surface = Some(Arc::new(CanonicalSurface::generate(512, 8, |x, y| {
            let water = u8::from(y < 4 + (x % 5 == 0) as u32);
            (if water == 0 { 120 } else { -80 }, 0, water)
        })));
        let view = eframe::egui::Rect::from_min_max(
            eframe::egui::Pos2::ZERO,
            eframe::egui::Pos2::new(25.5, map.height),
        );
        let before = shoreline_cache_key(&map, view, 0).expect("shoreline key");
        let old = map.canonical_sample(300, 3);
        assert!(map.edit_canonical_cell(
            300,
            3,
            Some(old.elevation_m),
            None,
            Some(if old.water == "land" {
                "saltwater"
            } else {
                "land"
            }),
        ));
        let after = shoreline_cache_key(&map, view, 0).expect("updated shoreline key");
        assert_ne!(before.revision_hash, after.revision_hash);
    }

    #[test]
    fn tiny_wheel_deltas_share_a_river_mesh_bucket() {
        let floor = 10.0;
        assert_eq!(river_scale_key(4.0, floor), river_scale_key(4.02, floor));
        assert_eq!(
            quantized_river_screen_scale(river_scale_key(4.0, floor), floor),
            quantized_river_screen_scale(river_scale_key(4.02, floor), floor)
        );
    }

    #[test]
    fn meaningful_zoom_changes_cross_river_mesh_buckets() {
        let floor = 10.0;
        assert_ne!(river_scale_key(4.0, floor), river_scale_key(5.0, floor));
        assert_eq!(river_scale_key(10.0, floor), u32::MAX);
        assert_eq!(river_scale_key(20.0, floor), u32::MAX);
    }

    #[test]
    fn cold_and_warm_render_paths_preserve_same_world_state() {
        let mut map = LoadedWorld::load_demo(Language::English).expect("demo").map;
        map.width = 6.4;
        map.height = 4.8;
        map.logical_pixel_width = 64;
        map.logical_pixel_height = 48;
        map.surface_cell_m = 100.0;
        map.canonical_surface = Some(Arc::new(CanonicalSurface::generate(64, 48, |x, y| {
            let water = if x < 16 { 1 } else { 0 };
            let elevation = if water == 1 { -200 } else { 40 + y as i16 * 3 };
            (elevation, 0, water)
        })));
        let world_before = serde_json::to_vec(&map).expect("serialize map before render");
        let view = eframe::egui::Rect::from_min_max(
            eframe::egui::Pos2::ZERO,
            eframe::egui::Pos2::new(map.width, map.height),
        );
        let mut cache = MapRenderCache::build(&map, 0.5);

        cache.ensure_river_mesh(&map, 4.0);
        cache.ensure_contour_mesh(&map, 4.0, view);
        let _ = cache.shoreline_mesh_for_view(&map, view);
        let cold = cache.stats();
        assert!(!cold.last_river_cache_hit);
        assert!(!cold.last_contour_cache_hit);
        assert!(!cold.last_shoreline_cache_hit);

        cache.ensure_river_mesh(&map, 4.0);
        cache.ensure_contour_mesh(&map, 4.0, view);
        let _ = cache.shoreline_mesh_for_view(&map, view);
        let warm = cache.stats();
        assert!(warm.last_river_cache_hit);
        assert!(warm.last_contour_cache_hit);
        assert!(warm.last_shoreline_cache_hit);

        let world_after = serde_json::to_vec(&map).expect("serialize map after render");
        assert_eq!(world_before, world_after);
    }
}
