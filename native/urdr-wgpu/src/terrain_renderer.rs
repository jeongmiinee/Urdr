use eframe::egui::{
    Color32, ColorImage, Context, Pos2, Rect, TextureHandle, TextureId, TextureOptions,
};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    panic::{AssertUnwindSafe, catch_unwind},
    sync::{
        Arc, Mutex,
        mpsc::{self, Receiver, SyncSender, TryRecvError, TrySendError},
    },
    thread,
    time::{Duration, Instant},
};

use crate::{
    model::{
        CanonicalSampleTrace, CanonicalSurface, NativeMap, begin_canonical_sample_trace,
        finish_canonical_sample_trace,
    },
    render::surface_color,
    surface_refinement::{RefinementWindow, chunk_halo_revision_hash},
};

const MAX_VISIBLE_CHUNKS: u64 = 768;
const MAX_CACHED_TILES: usize = 1_024;
const MAX_CACHED_TILE_BYTES: usize = 192 * 1024 * 1024;
const MAX_TILE_UPLOADS_PER_FRAME: usize = 12;
const MAX_TILE_APPLY_BYTES_PER_FRAME: usize = 8 * 1024 * 1024;
const MAX_TILE_APPLY_TIME: Duration = Duration::from_millis(2);
const MAX_PENDING_TILE_JOBS: usize = 64;
const MAX_COMPLETED_TILE_RESULTS: usize = 16;
const MAX_COMPLETED_PAYLOAD_BYTES: usize = 16 * 1024 * 1024;
const MAX_PREFETCH_TILES_PER_FRAME: usize = 4;
const TILE_WORKER_COUNT: usize = 2;
const OVERVIEW_MAXIMUM_AXIS: usize = 1_024;
const OVERVIEW_PREVIEW_AXIS: usize = 128;
const OVERVIEW_BLOCK_AXIS: usize = 128;
const MAX_OVERVIEW_BLOCKS_QUEUED_PER_FRAME: usize = 8;

#[derive(Clone, Copy)]
pub(crate) struct SurfaceTextureDraw {
    pub texture_id: TextureId,
    pub world_rect: Rect,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct SurfaceTextureCacheStats {
    pub tile_count: usize,
    pub cached_bytes: usize,
    pub active_lod: u8,
    pub visible_tile_count: usize,
    pub using_overview: bool,
    pub last_ensure_micros: u64,
    pub last_overview_build_micros: u64,
    pub last_tile_build_micros: u64,
    pub last_upload_count: usize,
    pub last_lod_selection_micros: u64,
    pub last_visible_chunk_query_micros: u64,
    pub last_cache_lookup_micros: u64,
    pub last_tile_cpu_synthesis_micros: u64,
    pub last_texture_encode_micros: u64,
    pub last_texture_submission_micros: u64,
    pub last_visible_chunk_count: u64,
    pub last_tiles_requested: usize,
    pub last_tile_cache_hits: usize,
    pub last_tile_cache_misses: usize,
    pub last_tiles_built: usize,
    pub last_canonical_cells_requested: u64,
    pub last_canonical_cells_materialized: u64,
    pub last_canonical_cells_virtual: u64,
    pub last_analysis_samples: u64,
    pub last_procedural_samples: u64,
    pub last_geology_samples: u64,
    pub last_overview_width: usize,
    pub last_overview_height: usize,
    pub pending_tile_jobs: usize,
    pub in_flight_tile_jobs: usize,
    pub ready_tile_jobs: usize,
    pub last_tile_jobs_queued: usize,
    pub last_tile_jobs_completed: usize,
    pub last_tile_jobs_deduplicated: usize,
    pub last_tile_jobs_stale: usize,
    pub last_tile_jobs_cancelled: usize,
    pub last_worker_cpu_micros: u64,
    pub last_main_apply_micros: u64,
    pub last_completed_payload_bytes: usize,
}

struct SurfaceTextureTile {
    revision: u64,
    texture: TextureHandle,
    world_rect: Rect,
    image_width: usize,
    image_height: usize,
    byte_size: usize,
    last_used_frame: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
struct SurfaceTileKey {
    lod: u8,
    index: usize,
    terrain_visible: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct SurfaceTileJobKey {
    map_key: String,
    surface_revision: u64,
    chunk_revision: u64,
    render_variant: u64,
    tile: SurfaceTileKey,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
struct OverviewBuildSpec {
    target_width: usize,
    target_height: usize,
    pixel_x: usize,
    pixel_y: usize,
    pixel_width: usize,
    pixel_height: usize,
}

#[derive(Clone)]
struct TileBuildMetadata {
    key: SurfaceTileJobKey,
    chunk_x: u32,
    chunk_y: u32,
    environment_seed: u32,
    sea_level_m: f32,
    world_rect: [f32; 4],
    zoom_event_id: Option<u64>,
    priority: u8,
    requested_frame: u64,
    kind: SurfaceBuildKind,
    overview: Option<OverviewBuildSpec>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SurfaceBuildKind {
    Tile,
    OverviewPreview,
    OverviewBlock,
}

struct TileBuildRequest {
    metadata: TileBuildMetadata,
    surface: Arc<CanonicalSurface>,
}

struct PendingTileJob {
    request: TileBuildRequest,
}

struct TileCpuPayload {
    image_width: usize,
    image_height: usize,
    pixels: Vec<Color32>,
    samples: CanonicalSampleTrace,
    sample_us: u64,
    color_us: u64,
    worker_cpu_us: u64,
    worker_thread: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TileBuildError {
    InvalidTile,
    WorkerPanicked,
}

struct TileBuildResult {
    metadata: TileBuildMetadata,
    outcome: Result<TileCpuPayload, TileBuildError>,
}

struct TileWorkerPool {
    requests: SyncSender<TileBuildRequest>,
    results: Receiver<TileBuildResult>,
}

impl TileWorkerPool {
    fn new() -> Self {
        let (request_sender, request_receiver) =
            mpsc::sync_channel::<TileBuildRequest>(TILE_WORKER_COUNT);
        let request_receiver = Arc::new(Mutex::new(request_receiver));
        let (result_sender, result_receiver) =
            mpsc::sync_channel::<TileBuildResult>(MAX_COMPLETED_TILE_RESULTS);
        for worker_index in 0..TILE_WORKER_COUNT {
            let request_receiver = Arc::clone(&request_receiver);
            let result_sender = result_sender.clone();
            let _ = thread::Builder::new()
                .name(format!("urdr-tile-worker-{worker_index}"))
                .spawn(move || tile_worker_loop(request_receiver, result_sender));
        }
        Self {
            requests: request_sender,
            results: result_receiver,
        }
    }
}

#[derive(Default)]
pub(crate) struct SurfaceTextureCache {
    map_key: String,
    width: u32,
    height: u32,
    chunks_x: u32,
    chunks_y: u32,
    lod: u8,
    terrain_visible: bool,
    tiles: HashMap<SurfaceTileKey, SurfaceTextureTile>,
    visible_keys: Vec<SurfaceTileKey>,
    cached_tile_bytes: usize,
    frame: u64,
    overview: Option<SurfaceTextureTile>,
    overview_blocks: HashMap<SurfaceTileKey, SurfaceTextureTile>,
    overview_target_width: usize,
    overview_target_height: usize,
    overview_revision: u64,
    overview_terrain_visible: bool,
    overview_active: bool,
    fallback: Option<SurfaceTextureTile>,
    fallback_terrain_visible: bool,
    worker_pool: Option<TileWorkerPool>,
    pending_jobs: HashMap<SurfaceTileJobKey, PendingTileJob>,
    active_job_keys: HashSet<SurfaceTileJobKey>,
    in_flight_job_keys: HashSet<SurfaceTileJobKey>,
    ready_results: VecDeque<TileBuildResult>,
    ready_payload_bytes: usize,
    last_ensure_micros: u64,
    last_overview_build_micros: u64,
    last_tile_build_micros: u64,
    last_upload_count: usize,
    last_lod_selection_micros: u64,
    last_visible_chunk_query_micros: u64,
    last_cache_lookup_micros: u64,
    last_tile_cpu_synthesis_micros: u64,
    last_texture_encode_micros: u64,
    last_texture_submission_micros: u64,
    last_visible_chunk_count: u64,
    last_tiles_requested: usize,
    last_tile_cache_hits: usize,
    last_tile_cache_misses: usize,
    last_tiles_built: usize,
    last_canonical_cells_requested: u64,
    last_canonical_cells_materialized: u64,
    last_canonical_cells_virtual: u64,
    last_analysis_samples: u64,
    last_procedural_samples: u64,
    last_geology_samples: u64,
    last_overview_width: usize,
    last_overview_height: usize,
    last_tile_jobs_queued: usize,
    last_tile_jobs_completed: usize,
    last_tile_jobs_deduplicated: usize,
    last_tile_jobs_stale: usize,
    last_tile_jobs_cancelled: usize,
    last_worker_cpu_micros: u64,
    last_main_apply_micros: u64,
    last_completed_payload_bytes: usize,
}

impl SurfaceTextureCache {
    pub(crate) fn clear(&mut self) {
        *self = Self::default();
    }

    pub(crate) fn visible_ready(&self) -> bool {
        (self.overview_active && self.overview.is_some())
            || (!self.overview_active
                && !self.visible_keys.is_empty()
                && self
                    .visible_keys
                    .iter()
                    .all(|key| self.tiles.contains_key(key)))
    }

    pub(crate) fn stats(&self) -> SurfaceTextureCacheStats {
        SurfaceTextureCacheStats {
            tile_count: self.tiles.len(),
            cached_bytes: self.cached_tile_bytes,
            active_lod: self.lod,
            visible_tile_count: self.visible_keys.len(),
            using_overview: self.overview_active,
            last_ensure_micros: self.last_ensure_micros,
            last_overview_build_micros: self.last_overview_build_micros,
            last_tile_build_micros: self.last_tile_build_micros,
            last_upload_count: self.last_upload_count,
            last_lod_selection_micros: self.last_lod_selection_micros,
            last_visible_chunk_query_micros: self.last_visible_chunk_query_micros,
            last_cache_lookup_micros: self.last_cache_lookup_micros,
            last_tile_cpu_synthesis_micros: self.last_tile_cpu_synthesis_micros,
            last_texture_encode_micros: self.last_texture_encode_micros,
            last_texture_submission_micros: self.last_texture_submission_micros,
            last_visible_chunk_count: self.last_visible_chunk_count,
            last_tiles_requested: self.last_tiles_requested,
            last_tile_cache_hits: self.last_tile_cache_hits,
            last_tile_cache_misses: self.last_tile_cache_misses,
            last_tiles_built: self.last_tiles_built,
            last_canonical_cells_requested: self.last_canonical_cells_requested,
            last_canonical_cells_materialized: self.last_canonical_cells_materialized,
            last_canonical_cells_virtual: self.last_canonical_cells_virtual,
            last_analysis_samples: self.last_analysis_samples,
            last_procedural_samples: self.last_procedural_samples,
            last_geology_samples: self.last_geology_samples,
            last_overview_width: self.last_overview_width,
            last_overview_height: self.last_overview_height,
            pending_tile_jobs: self.pending_jobs.len(),
            in_flight_tile_jobs: self.in_flight_job_keys.len(),
            ready_tile_jobs: self.ready_results.len(),
            last_tile_jobs_queued: self.last_tile_jobs_queued,
            last_tile_jobs_completed: self.last_tile_jobs_completed,
            last_tile_jobs_deduplicated: self.last_tile_jobs_deduplicated,
            last_tile_jobs_stale: self.last_tile_jobs_stale,
            last_tile_jobs_cancelled: self.last_tile_jobs_cancelled,
            last_worker_cpu_micros: self.last_worker_cpu_micros,
            last_main_apply_micros: self.last_main_apply_micros,
            last_completed_payload_bytes: self.last_completed_payload_bytes,
        }
    }

    pub(crate) fn ensure(
        &mut self,
        context: &Context,
        map: &NativeMap,
        screen_scale: f32,
        visible_world: Rect,
        terrain_visible: bool,
    ) {
        self.ensure_traced(
            context,
            map,
            screen_scale,
            visible_world,
            terrain_visible,
            None,
        );
    }

    pub(crate) fn ensure_traced(
        &mut self,
        context: &Context,
        map: &NativeMap,
        screen_scale: f32,
        visible_world: Rect,
        terrain_visible: bool,
        zoom_event_id: Option<u64>,
    ) {
        let ensure_started = std::time::Instant::now();
        let lod_before = self.lod;
        self.last_overview_build_micros = 0;
        self.last_tile_build_micros = 0;
        self.last_upload_count = 0;
        self.last_lod_selection_micros = 0;
        self.last_visible_chunk_query_micros = 0;
        self.last_cache_lookup_micros = 0;
        self.last_tile_cpu_synthesis_micros = 0;
        self.last_texture_encode_micros = 0;
        self.last_texture_submission_micros = 0;
        self.last_visible_chunk_count = 0;
        self.last_tiles_requested = 0;
        self.last_tile_cache_hits = 0;
        self.last_tile_cache_misses = 0;
        self.last_tiles_built = 0;
        self.last_canonical_cells_requested = 0;
        self.last_canonical_cells_materialized = 0;
        self.last_canonical_cells_virtual = 0;
        self.last_analysis_samples = 0;
        self.last_procedural_samples = 0;
        self.last_geology_samples = 0;
        self.last_overview_width = 0;
        self.last_overview_height = 0;
        self.last_tile_jobs_queued = 0;
        self.last_tile_jobs_completed = 0;
        self.last_tile_jobs_deduplicated = 0;
        self.last_tile_jobs_stale = 0;
        self.last_tile_jobs_cancelled = 0;
        self.last_worker_cpu_micros = 0;
        self.last_main_apply_micros = 0;
        self.last_completed_payload_bytes = 0;
        let Some(surface) = map.canonical_surface.as_ref() else {
            self.clear();
            return;
        };
        let (chunks_x, chunks_y) = surface.chunk_grid_dimensions();
        let lod_started = std::time::Instant::now();
        // Map scene coordinates are physical kilometres, so screen_scale is
        // screen pixels per kilometre. Convert the map's actual cell size to km.
        let pixels_per_source_cell =
            pixels_per_surface_cell(screen_scale, map.surface_cell_m).max(0.000_1);
        let lod = surface_lod(pixels_per_source_cell, Some(self.lod));
        self.last_lod_selection_micros = lod_started.elapsed().as_micros() as u64;
        if let Some(zoom_event_id) = zoom_event_id {
            crate::diagnostics::event(
                "terrain_lod",
                "select",
                "completed",
                &[
                    ("zoom_event_id", zoom_event_id.to_string()),
                    ("screen_scale_raw", format!("{screen_scale:.9}")),
                    (
                        "screen_scale_unit_description",
                        "screen_pixels_per_km".to_owned(),
                    ),
                    ("screen_pixels_per_km", format!("{screen_scale:.9}")),
                    ("surface_cell_m", format!("{:.3}", map.surface_cell_m)),
                    (
                        "logical_pixels_per_km",
                        format!("{:.3}", NativeMap::LOGICAL_PIXELS_PER_KM),
                    ),
                    (
                        "computed_pixels_per_source_cell",
                        format!("{pixels_per_source_cell:.9}"),
                    ),
                    ("lod_before", lod_before.to_string()),
                    ("selected_lod", lod.to_string()),
                    (
                        "lod_selection_us",
                        self.last_lod_selection_micros.to_string(),
                    ),
                ],
            );
        }
        let map_key = format!("{}:{}:{}", map.source_id, surface.width, surface.height);
        if self.map_key != map_key
            || self.width != surface.width
            || self.height != surface.height
            || self.chunks_x != chunks_x
            || self.chunks_y != chunks_y
        {
            self.map_key = map_key;
            self.width = surface.width;
            self.height = surface.height;
            self.chunks_x = chunks_x;
            self.chunks_y = chunks_y;
            self.lod = lod;
            self.terrain_visible = terrain_visible;
            self.tiles.clear();
            self.visible_keys.clear();
            self.cached_tile_bytes = 0;
            self.overview = None;
            self.overview_blocks.clear();
            self.overview_target_width = 0;
            self.overview_target_height = 0;
            self.overview_revision = 0;
            self.overview_active = false;
            self.fallback = None;
            self.worker_pool = None;
            self.pending_jobs.clear();
            self.active_job_keys.clear();
            self.in_flight_job_keys.clear();
            self.ready_results.clear();
            self.ready_payload_bytes = 0;
        } else {
            // A camera zoom only changes the active LOD. Keeping the neighbouring
            // levels avoids throwing away GPU resources while the wheel is moving.
            self.lod = lod;
            self.terrain_visible = terrain_visible;
        }
        self.frame = self.frame.wrapping_add(1).max(1);

        self.ensure_analysis_fallback(context, map, terrain_visible);
        self.collect_worker_results();
        self.apply_ready_results(context, map);

        let map_rect = Rect::from_min_max(
            Pos2::ZERO,
            Pos2::new(map.width.max(0.1), map.height.max(0.1)),
        );
        let visible_world = visible_world.intersect(map_rect);
        if !visible_world.is_positive() {
            self.visible_keys.clear();
            self.last_ensure_micros = ensure_started.elapsed().as_micros() as u64;
            return;
        }
        let visible_query_started = std::time::Instant::now();
        let source_left = visible_world.left() / map.width.max(0.1) * surface.width as f32;
        let source_top = visible_world.top() / map.height.max(0.1) * surface.height as f32;
        let source_right = visible_world.right() / map.width.max(0.1) * surface.width as f32;
        let source_bottom = visible_world.bottom() / map.height.max(0.1) * surface.height as f32;
        let min_chunk_x = ((source_left.max(0.0) as u32)
            / crate::model::CanonicalSurface::CHUNK_SIZE)
            .min(chunks_x.saturating_sub(1));
        let min_chunk_y = ((source_top.max(0.0) as u32)
            / crate::model::CanonicalSurface::CHUNK_SIZE)
            .min(chunks_y.saturating_sub(1));
        let max_chunk_x = ((source_right.ceil().max(1.0) as u32 - 1)
            / crate::model::CanonicalSurface::CHUNK_SIZE)
            .min(chunks_x.saturating_sub(1));
        let max_chunk_y = ((source_bottom.ceil().max(1.0) as u32 - 1)
            / crate::model::CanonicalSurface::CHUNK_SIZE)
            .min(chunks_y.saturating_sub(1));
        let visible_chunk_count =
            u64::from(max_chunk_x - min_chunk_x + 1) * u64::from(max_chunk_y - min_chunk_y + 1);
        self.last_visible_chunk_count = visible_chunk_count;
        self.last_visible_chunk_query_micros = visible_query_started.elapsed().as_micros() as u64;
        if visible_chunk_count > MAX_VISIBLE_CHUNKS {
            self.visible_keys.clear();
            self.overview_active = true;
            let (target_width, target_height) = overview_target_resolution(map, screen_scale);
            let overview_layout_matches = self.overview_terrain_visible == terrain_visible
                && self.overview_target_width == target_width
                && self.overview_target_height == target_height;
            if !overview_layout_matches {
                self.reset_overview_generation(
                    map.surface_revision,
                    terrain_visible,
                    target_width,
                    target_height,
                );
            } else if self.overview_revision != map.surface_revision {
                self.advance_overview_revision(map.surface_revision);
            }
            let expected_blocks = target_width.div_ceil(OVERVIEW_BLOCK_AXIS)
                * target_height.div_ceil(OVERVIEW_BLOCK_AXIS);
            let overview_cache_hit = self.overview.is_some()
                && self.overview_blocks.len() == expected_blocks
                && overview_blocks_match_surface(
                    surface,
                    &self.overview_blocks,
                    terrain_visible,
                    target_width,
                    target_height,
                );
            if self.overview.is_none() {
                self.queue_overview_preview_job(
                    map,
                    Arc::clone(surface),
                    terrain_visible,
                    target_width,
                    target_height,
                    zoom_event_id,
                );
            } else if let Some(overview) = &mut self.overview {
                overview.last_used_frame = self.frame;
            }
            self.queue_overview_block_jobs(
                map,
                Arc::clone(surface),
                terrain_visible,
                target_width,
                target_height,
                zoom_event_id,
            );
            self.last_overview_width = target_width;
            self.last_overview_height = target_height;
            self.prune_pending_jobs();
            self.dispatch_pending_jobs();
            self.last_tile_build_micros = self.last_worker_cpu_micros;
            if !self.pending_jobs.is_empty()
                || !self.in_flight_job_keys.is_empty()
                || !self.ready_results.is_empty()
            {
                context.request_repaint_after(Duration::from_millis(1));
            }
            self.last_ensure_micros = ensure_started.elapsed().as_micros() as u64;
            if let Some(zoom_event_id) = zoom_event_id {
                crate::diagnostics::event(
                    "overview_build",
                    "surface_overview",
                    "completed",
                    &[
                        ("zoom_event_id", zoom_event_id.to_string()),
                        ("visible_chunks", visible_chunk_count.to_string()),
                        ("overview_width", self.last_overview_width.to_string()),
                        ("overview_height", self.last_overview_height.to_string()),
                        (
                            "overview_pixels",
                            self.last_overview_width
                                .saturating_mul(self.last_overview_height)
                                .to_string(),
                        ),
                        (
                            "canonical_samples",
                            self.last_canonical_cells_requested.to_string(),
                        ),
                        ("cache_hit", overview_cache_hit.to_string()),
                        ("build_us", self.last_overview_build_micros.to_string()),
                    ],
                );
                self.log_ensure_trace(
                    zoom_event_id,
                    map,
                    screen_scale,
                    pixels_per_source_cell,
                    lod_before,
                );
            }
            return;
        }

        self.overview_active = false;
        self.visible_keys.clear();
        let mut visible_coords = Vec::with_capacity(visible_chunk_count as usize);
        for chunk_y in min_chunk_y..=max_chunk_y {
            for chunk_x in min_chunk_x..=max_chunk_x {
                let index = (chunk_y * chunks_x + chunk_x) as usize;
                let key = SurfaceTileKey {
                    lod,
                    index,
                    terrain_visible,
                };
                self.visible_keys.push(key);
                visible_coords.push((chunk_x, chunk_y));
                self.last_tiles_requested = self.last_tiles_requested.saturating_add(1);
                let revision = render_chunk_revision(surface, chunk_x, chunk_y, lod);
                let lookup_started = std::time::Instant::now();
                let cache_hit = self
                    .tiles
                    .get_mut(&key)
                    .filter(|tile| tile.revision == revision)
                    .map(|tile| {
                        tile.last_used_frame = self.frame;
                    })
                    .is_some();
                self.last_cache_lookup_micros = self
                    .last_cache_lookup_micros
                    .saturating_add(lookup_started.elapsed().as_micros() as u64);
                if cache_hit {
                    self.last_tile_cache_hits = self.last_tile_cache_hits.saturating_add(1);
                    continue;
                }
                if let Some(stale) = self.tiles.remove(&key) {
                    self.cached_tile_bytes = self.cached_tile_bytes.saturating_sub(stale.byte_size);
                }
                self.last_tile_cache_misses = self.last_tile_cache_misses.saturating_add(1);
                self.queue_tile_job(
                    map,
                    Arc::clone(surface),
                    chunk_x,
                    chunk_y,
                    lod,
                    terrain_visible,
                    0,
                    zoom_event_id,
                );
            }
        }

        self.queue_near_visible_halo(
            map,
            Arc::clone(surface),
            min_chunk_x,
            min_chunk_y,
            max_chunk_x,
            max_chunk_y,
            lod,
            terrain_visible,
            zoom_event_id,
        );
        self.queue_adjacent_lod_prefetch(
            map,
            Arc::clone(surface),
            &visible_coords,
            lod,
            lod_before,
            terrain_visible,
            zoom_event_id,
        );
        self.prune_pending_jobs();
        self.dispatch_pending_jobs();
        self.last_tile_build_micros = self.last_worker_cpu_micros;
        if !self.pending_jobs.is_empty()
            || !self.in_flight_job_keys.is_empty()
            || !self.ready_results.is_empty()
        {
            context.request_repaint_after(Duration::from_millis(1));
        }
        self.evict_cold_tiles();
        self.last_ensure_micros = ensure_started.elapsed().as_micros() as u64;
        if let Some(zoom_event_id) = zoom_event_id {
            crate::diagnostics::event(
                "gpu_upload",
                "texture_delta",
                "completed",
                &[
                    ("zoom_event_id", zoom_event_id.to_string()),
                    (
                        "tiles_synthesized_this_frame",
                        self.last_tiles_built.to_string(),
                    ),
                    (
                        "tiles_uploaded_this_frame",
                        self.last_upload_count.to_string(),
                    ),
                    (
                        "texture_payload_build_us",
                        self.last_texture_encode_micros.to_string(),
                    ),
                    (
                        "queue_write_us",
                        self.last_texture_submission_micros.to_string(),
                    ),
                    ("gpu_completion_measured", "false".to_owned()),
                ],
            );
            self.log_ensure_trace(
                zoom_event_id,
                map,
                screen_scale,
                pixels_per_source_cell,
                lod_before,
            );
        }
    }

    fn ensure_analysis_fallback(
        &mut self,
        context: &Context,
        map: &NativeMap,
        terrain_visible: bool,
    ) {
        let fallback_valid = self.fallback.as_ref().is_some_and(|fallback| {
            fallback.revision == map.surface_revision
                && self.fallback_terrain_visible == terrain_visible
        });
        if fallback_valid {
            if let Some(fallback) = &mut self.fallback {
                fallback.last_used_frame = self.frame;
            }
            return;
        }
        let (image_width, image_height, pixels) = analysis_fallback_pixels(map, terrain_visible);
        let image = ColorImage::new([image_width, image_height], pixels);
        let texture_name = format!(
            "urdr-surface-fallback-{}-{}",
            self.map_key, terrain_visible as u8
        );
        let texture = if let Some(fallback) = &mut self.fallback {
            fallback.texture.set(image, TextureOptions::NEAREST);
            fallback.texture.clone()
        } else {
            context.load_texture(texture_name, image, TextureOptions::NEAREST)
        };
        self.fallback = Some(SurfaceTextureTile {
            revision: map.surface_revision,
            texture,
            world_rect: Rect::from_min_size(
                Pos2::ZERO,
                eframe::egui::Vec2::new(map.width.max(0.1), map.height.max(0.1)),
            ),
            image_width,
            image_height,
            byte_size: image_width.saturating_mul(image_height).saturating_mul(4),
            last_used_frame: self.frame,
        });
        self.fallback_terrain_visible = terrain_visible;
    }

    fn collect_worker_results(&mut self) {
        loop {
            let result = match self
                .worker_pool
                .as_ref()
                .map(|pool| pool.results.try_recv())
            {
                Some(Ok(result)) => result,
                Some(Err(TryRecvError::Empty)) | None => break,
                Some(Err(TryRecvError::Disconnected)) => {
                    self.worker_pool = None;
                    for key in self.in_flight_job_keys.drain() {
                        self.active_job_keys.remove(&key);
                        self.last_tile_jobs_cancelled =
                            self.last_tile_jobs_cancelled.saturating_add(1);
                    }
                    break;
                }
            };
            self.in_flight_job_keys.remove(&result.metadata.key);
            let payload_bytes = tile_result_payload_bytes(&result);
            if self.ready_payload_bytes.saturating_add(payload_bytes) > MAX_COMPLETED_PAYLOAD_BYTES
            {
                self.active_job_keys.remove(&result.metadata.key);
                self.last_tile_jobs_cancelled = self.last_tile_jobs_cancelled.saturating_add(1);
                continue;
            }
            self.ready_payload_bytes = self.ready_payload_bytes.saturating_add(payload_bytes);
            self.ready_results.push_back(result);
        }
    }

    fn overview_result_matches(&self, metadata: &TileBuildMetadata) -> bool {
        if metadata.key.tile.terrain_visible != self.overview_terrain_visible {
            return false;
        }
        let Some(spec) = metadata.overview else {
            return false;
        };
        match metadata.kind {
            SurfaceBuildKind::OverviewBlock => {
                spec.target_width == self.overview_target_width
                    && spec.target_height == self.overview_target_height
            }
            SurfaceBuildKind::OverviewPreview => {
                if metadata.key.surface_revision != self.overview_revision {
                    return false;
                }
                let (width, height) = overview_dimensions(
                    self.overview_target_width as f32,
                    self.overview_target_height as f32,
                    OVERVIEW_PREVIEW_AXIS
                        .min(self.overview_target_width.max(self.overview_target_height)),
                );
                spec.target_width == width && spec.target_height == height
            }
            SurfaceBuildKind::Tile => true,
        }
    }

    fn apply_ready_results(&mut self, context: &Context, map: &NativeMap) {
        let apply_started = Instant::now();
        let mut applied = 0_usize;
        let mut applied_bytes = 0_usize;
        while applied < MAX_TILE_UPLOADS_PER_FRAME
            && applied_bytes < MAX_TILE_APPLY_BYTES_PER_FRAME
            && apply_started.elapsed() < MAX_TILE_APPLY_TIME
        {
            let Some(result) = self.ready_results.pop_front() else {
                break;
            };
            let payload_bytes = tile_result_payload_bytes(&result);
            self.ready_payload_bytes = self.ready_payload_bytes.saturating_sub(payload_bytes);
            self.active_job_keys.remove(&result.metadata.key);
            let current_chunk_revision = (result.metadata.kind == SurfaceBuildKind::Tile)
                .then(|| {
                    map.canonical_surface.as_ref().and_then(|surface| {
                        surface
                            .chunk_dimensions(result.metadata.chunk_x, result.metadata.chunk_y)
                            .map(|_| {
                                render_chunk_revision(
                                    surface,
                                    result.metadata.chunk_x,
                                    result.metadata.chunk_y,
                                    result.metadata.key.tile.lod,
                                )
                            })
                    })
                })
                .flatten();
            let current_overview_block_revision = (result.metadata.kind
                == SurfaceBuildKind::OverviewBlock)
                .then(|| {
                    result.metadata.overview.and_then(|spec| {
                        map.canonical_surface
                            .as_ref()
                            .map(|surface| overview_block_revision(surface, spec))
                    })
                })
                .flatten();
            let stale = result.metadata.key.map_key != self.map_key
                || match result.metadata.kind {
                    SurfaceBuildKind::Tile => {
                        result.metadata.key.surface_revision != map.surface_revision
                            || current_chunk_revision != Some(result.metadata.key.chunk_revision)
                    }
                    SurfaceBuildKind::OverviewPreview => {
                        result.metadata.key.surface_revision != map.surface_revision
                            || !self.overview_result_matches(&result.metadata)
                    }
                    SurfaceBuildKind::OverviewBlock => {
                        current_overview_block_revision != Some(result.metadata.key.chunk_revision)
                            || !self.overview_result_matches(&result.metadata)
                    }
                };
            if stale {
                self.last_tile_jobs_stale = self.last_tile_jobs_stale.saturating_add(1);
                crate::diagnostics::event(
                    "tile_stream",
                    "result",
                    "stale",
                    &[
                        (
                            "zoom_event_id",
                            result
                                .metadata
                                .zoom_event_id
                                .unwrap_or_default()
                                .to_string(),
                        ),
                        (
                            "tile_id",
                            format!(
                                "{}:{}",
                                result.metadata.key.tile.lod, result.metadata.key.tile.index
                            ),
                        ),
                        (
                            "result_surface_revision",
                            result.metadata.key.surface_revision.to_string(),
                        ),
                        ("current_surface_revision", map.surface_revision.to_string()),
                    ],
                );
                continue;
            }
            let payload = match result.outcome {
                Ok(payload) => payload,
                Err(error) => {
                    self.last_tile_jobs_cancelled = self.last_tile_jobs_cancelled.saturating_add(1);
                    crate::diagnostics::warning(
                        "tile_stream",
                        "worker",
                        "failed",
                        &[
                            (
                                "zoom_event_id",
                                result
                                    .metadata
                                    .zoom_event_id
                                    .unwrap_or_default()
                                    .to_string(),
                            ),
                            ("error", format!("{error:?}")),
                        ],
                    );
                    continue;
                }
            };
            let TileCpuPayload {
                image_width,
                image_height,
                pixels,
                samples,
                sample_us,
                color_us,
                worker_cpu_us,
                worker_thread,
            } = payload;
            let submission_started = Instant::now();
            let image = ColorImage::new([image_width, image_height], pixels);
            let tile_key = result.metadata.key.tile;
            let texture = match result.metadata.kind {
                SurfaceBuildKind::OverviewPreview => {
                    let texture_name = format!(
                        "urdr-surface-overview-preview-{}-{}-{}x{}",
                        self.map_key, tile_key.terrain_visible as u8, image_width, image_height,
                    );
                    if let Some(overview) = self.overview.as_mut() {
                        overview.texture.set(image, TextureOptions::NEAREST);
                        overview.texture.clone()
                    } else {
                        context.load_texture(texture_name, image, TextureOptions::NEAREST)
                    }
                }
                SurfaceBuildKind::OverviewBlock => {
                    let texture_name = format!(
                        "urdr-surface-overview-block-{}-{}-{}-{}x{}",
                        self.map_key,
                        tile_key.terrain_visible as u8,
                        tile_key.index,
                        self.overview_target_width,
                        self.overview_target_height,
                    );
                    if let Some(block) = self.overview_blocks.get_mut(&tile_key) {
                        block.texture.set(image, TextureOptions::NEAREST);
                        block.texture.clone()
                    } else {
                        context.load_texture(texture_name, image, TextureOptions::NEAREST)
                    }
                }
                SurfaceBuildKind::Tile => {
                    let texture_name = format!(
                        "urdr-surface-{}-{}-{}-{}-{}",
                        self.map_key,
                        tile_key.lod,
                        tile_key.terrain_visible as u8,
                        result.metadata.chunk_x,
                        result.metadata.chunk_y
                    );
                    if let Some(tile) = self.tiles.get_mut(&tile_key) {
                        self.cached_tile_bytes =
                            self.cached_tile_bytes.saturating_sub(tile.byte_size);
                        tile.texture.set(image, TextureOptions::NEAREST);
                        tile.texture.clone()
                    } else {
                        context.load_texture(texture_name, image, TextureOptions::NEAREST)
                    }
                }
            };
            let submission_us = submission_started.elapsed().as_micros() as u64;
            let byte_size = image_width.saturating_mul(image_height).saturating_mul(4);
            let uploaded = SurfaceTextureTile {
                revision: if result.metadata.kind == SurfaceBuildKind::Tile {
                    result.metadata.key.chunk_revision
                } else if result.metadata.kind == SurfaceBuildKind::OverviewBlock {
                    result.metadata.key.chunk_revision
                } else {
                    result.metadata.key.surface_revision
                },
                texture,
                world_rect: rect_from_array(result.metadata.world_rect),
                image_width,
                image_height,
                byte_size,
                last_used_frame: self.frame,
            };
            match result.metadata.kind {
                SurfaceBuildKind::OverviewPreview => {
                    self.overview = Some(uploaded);
                    self.overview_terrain_visible = tile_key.terrain_visible;
                    self.last_overview_build_micros = worker_cpu_us;
                }
                SurfaceBuildKind::OverviewBlock => {
                    self.overview_blocks.insert(tile_key, uploaded);
                    self.last_overview_build_micros = self
                        .last_overview_build_micros
                        .saturating_add(worker_cpu_us);
                }
                SurfaceBuildKind::Tile => {
                    self.cached_tile_bytes = self.cached_tile_bytes.saturating_add(byte_size);
                    self.tiles.insert(tile_key, uploaded);
                    self.last_tiles_built = self.last_tiles_built.saturating_add(1);
                }
            }
            self.add_canonical_trace(samples);
            self.last_tile_jobs_completed = self.last_tile_jobs_completed.saturating_add(1);
            self.last_upload_count = self.last_upload_count.saturating_add(1);
            self.last_worker_cpu_micros = self.last_worker_cpu_micros.saturating_add(worker_cpu_us);
            self.last_texture_encode_micros =
                self.last_texture_encode_micros.saturating_add(color_us);
            self.last_texture_submission_micros = self
                .last_texture_submission_micros
                .saturating_add(submission_us);
            self.last_completed_payload_bytes =
                self.last_completed_payload_bytes.saturating_add(byte_size);
            applied = applied.saturating_add(1);
            applied_bytes = applied_bytes.saturating_add(byte_size);
            crate::diagnostics::event(
                "tile_stream",
                "result_apply",
                "completed",
                &[
                    (
                        "zoom_event_id",
                        result
                            .metadata
                            .zoom_event_id
                            .unwrap_or_default()
                            .to_string(),
                    ),
                    ("kind", format!("{:?}", result.metadata.kind)),
                    ("lod", tile_key.lod.to_string()),
                    (
                        "chunk_coord",
                        format!("{},{}", result.metadata.chunk_x, result.metadata.chunk_y),
                    ),
                    ("worker_cpu_us", worker_cpu_us.to_string()),
                    ("worker_thread", worker_thread),
                    ("sample_us", sample_us.to_string()),
                    ("texture_payload_us", color_us.to_string()),
                    ("main_apply_us", submission_us.to_string()),
                    ("completed_payload_bytes", byte_size.to_string()),
                ],
            );
        }
        self.last_main_apply_micros = apply_started.elapsed().as_micros() as u64;
    }

    #[allow(clippy::too_many_arguments)]
    fn queue_tile_job(
        &mut self,
        map: &NativeMap,
        surface: Arc<CanonicalSurface>,
        chunk_x: u32,
        chunk_y: u32,
        lod: u8,
        terrain_visible: bool,
        priority: u8,
        zoom_event_id: Option<u64>,
    ) {
        let Some((chunk_width, chunk_height)) = surface.chunk_dimensions(chunk_x, chunk_y) else {
            return;
        };
        let (chunks_x, _) = surface.chunk_grid_dimensions();
        let tile = SurfaceTileKey {
            lod,
            index: (chunk_y * chunks_x + chunk_x) as usize,
            terrain_visible,
        };
        let chunk_revision = render_chunk_revision(&surface, chunk_x, chunk_y, lod);
        if self
            .tiles
            .get(&tile)
            .is_some_and(|cached| cached.revision == chunk_revision)
        {
            return;
        }
        let key = SurfaceTileJobKey {
            map_key: self.map_key.clone(),
            surface_revision: map.surface_revision,
            chunk_revision,
            render_variant: 0,
            tile,
        };
        let origin_x = chunk_x * CanonicalSurface::CHUNK_SIZE;
        let origin_y = chunk_y * CanonicalSurface::CHUNK_SIZE;
        let end_x = origin_x + chunk_width as u32;
        let end_y = origin_y + chunk_height as u32;
        let metadata = TileBuildMetadata {
            key: key.clone(),
            chunk_x,
            chunk_y,
            environment_seed: map.environment_seed,
            sea_level_m: map.sea_level,
            world_rect: [
                origin_x as f32 * map.width / surface.width as f32,
                origin_y as f32 * map.height / surface.height as f32,
                end_x as f32 * map.width / surface.width as f32,
                end_y as f32 * map.height / surface.height as f32,
            ],
            zoom_event_id,
            priority,
            requested_frame: self.frame,
            kind: SurfaceBuildKind::Tile,
            overview: None,
        };
        self.enqueue_request(TileBuildRequest { metadata, surface });
    }

    fn reset_overview_generation(
        &mut self,
        revision: u64,
        terrain_visible: bool,
        target_width: usize,
        target_height: usize,
    ) {
        self.overview = None;
        self.overview_blocks.clear();
        self.overview_revision = revision;
        self.overview_terrain_visible = terrain_visible;
        self.overview_target_width = target_width;
        self.overview_target_height = target_height;
        let obsolete = self
            .pending_jobs
            .keys()
            .filter(|key| key.tile.lod == u8::MAX)
            .cloned()
            .collect::<Vec<_>>();
        for key in obsolete {
            self.pending_jobs.remove(&key);
            self.active_job_keys.remove(&key);
            self.last_tile_jobs_cancelled = self.last_tile_jobs_cancelled.saturating_add(1);
        }
    }

    fn advance_overview_revision(&mut self, revision: u64) {
        self.overview = None;
        self.overview_revision = revision;
        let obsolete = self
            .pending_jobs
            .keys()
            .filter(|key| key.tile.lod == u8::MAX)
            .cloned()
            .collect::<Vec<_>>();
        for key in obsolete {
            self.pending_jobs.remove(&key);
            self.active_job_keys.remove(&key);
            self.last_tile_jobs_cancelled = self.last_tile_jobs_cancelled.saturating_add(1);
        }
    }

    fn queue_overview_preview_job(
        &mut self,
        map: &NativeMap,
        surface: Arc<CanonicalSurface>,
        terrain_visible: bool,
        target_width: usize,
        target_height: usize,
        zoom_event_id: Option<u64>,
    ) {
        let (preview_width, preview_height) = overview_dimensions(
            map.width,
            map.height,
            OVERVIEW_PREVIEW_AXIS.min(target_width.max(target_height)),
        );
        let spec = OverviewBuildSpec {
            target_width: preview_width,
            target_height: preview_height,
            pixel_x: 0,
            pixel_y: 0,
            pixel_width: preview_width,
            pixel_height: preview_height,
        };
        let tile = SurfaceTileKey {
            lod: u8::MAX,
            index: usize::MAX,
            terrain_visible,
        };
        let key = SurfaceTileJobKey {
            map_key: self.map_key.clone(),
            surface_revision: map.surface_revision,
            chunk_revision: 0,
            render_variant: overview_variant(spec, SurfaceBuildKind::OverviewPreview),
            tile,
        };
        let metadata = TileBuildMetadata {
            key,
            chunk_x: 0,
            chunk_y: 0,
            environment_seed: map.environment_seed,
            sea_level_m: map.sea_level,
            world_rect: [0.0, 0.0, map.width.max(0.1), map.height.max(0.1)],
            zoom_event_id,
            priority: 3,
            requested_frame: self.frame,
            kind: SurfaceBuildKind::OverviewPreview,
            overview: Some(spec),
        };
        self.enqueue_request(TileBuildRequest { metadata, surface });
    }

    fn queue_overview_block_jobs(
        &mut self,
        map: &NativeMap,
        surface: Arc<CanonicalSurface>,
        terrain_visible: bool,
        target_width: usize,
        target_height: usize,
        zoom_event_id: Option<u64>,
    ) {
        let blocks_x = target_width.div_ceil(OVERVIEW_BLOCK_AXIS);
        let blocks_y = target_height.div_ceil(OVERVIEW_BLOCK_AXIS);
        let mut queued = 0_usize;
        for block_y in 0..blocks_y {
            for block_x in 0..blocks_x {
                if queued >= MAX_OVERVIEW_BLOCKS_QUEUED_PER_FRAME {
                    return;
                }
                let index = block_y * blocks_x + block_x;
                let tile = SurfaceTileKey {
                    lod: u8::MAX,
                    index,
                    terrain_visible,
                };
                let pixel_x = block_x * OVERVIEW_BLOCK_AXIS;
                let pixel_y = block_y * OVERVIEW_BLOCK_AXIS;
                let pixel_width = OVERVIEW_BLOCK_AXIS.min(target_width - pixel_x);
                let pixel_height = OVERVIEW_BLOCK_AXIS.min(target_height - pixel_y);
                let spec = OverviewBuildSpec {
                    target_width,
                    target_height,
                    pixel_x,
                    pixel_y,
                    pixel_width,
                    pixel_height,
                };
                let block_revision = overview_block_revision(&surface, spec);
                if self
                    .overview_blocks
                    .get(&tile)
                    .is_some_and(|block| block.revision == block_revision)
                {
                    continue;
                }
                let key = SurfaceTileJobKey {
                    map_key: self.map_key.clone(),
                    surface_revision: map.surface_revision,
                    chunk_revision: block_revision,
                    render_variant: overview_variant(spec, SurfaceBuildKind::OverviewBlock),
                    tile,
                };
                let world_left = pixel_x as f32 / target_width as f32 * map.width.max(0.1);
                let world_top = pixel_y as f32 / target_height as f32 * map.height.max(0.1);
                let world_right =
                    (pixel_x + pixel_width) as f32 / target_width as f32 * map.width.max(0.1);
                let world_bottom =
                    (pixel_y + pixel_height) as f32 / target_height as f32 * map.height.max(0.1);
                let metadata = TileBuildMetadata {
                    key,
                    chunk_x: block_x as u32,
                    chunk_y: block_y as u32,
                    environment_seed: map.environment_seed,
                    sea_level_m: map.sea_level,
                    world_rect: [world_left, world_top, world_right, world_bottom],
                    zoom_event_id,
                    priority: 3,
                    requested_frame: self.frame,
                    kind: SurfaceBuildKind::OverviewBlock,
                    overview: Some(spec),
                };
                let before = self.active_job_keys.len();
                self.enqueue_request(TileBuildRequest {
                    metadata,
                    surface: Arc::clone(&surface),
                });
                if self.active_job_keys.len() > before {
                    queued += 1;
                }
            }
        }
    }

    fn enqueue_request(&mut self, request: TileBuildRequest) {
        let key = request.metadata.key.clone();
        let priority = request.metadata.priority;
        if let Some(pending) = self.pending_jobs.get_mut(&key) {
            pending.request.metadata.priority = pending.request.metadata.priority.min(priority);
            pending.request.metadata.requested_frame = self.frame;
            pending.request.metadata.zoom_event_id = request
                .metadata
                .zoom_event_id
                .or(pending.request.metadata.zoom_event_id);
            self.last_tile_jobs_deduplicated = self.last_tile_jobs_deduplicated.saturating_add(1);
            return;
        }
        if self.active_job_keys.contains(&key) {
            self.last_tile_jobs_deduplicated = self.last_tile_jobs_deduplicated.saturating_add(1);
            return;
        }
        if self.pending_jobs.len() >= MAX_PENDING_TILE_JOBS {
            let worst = self
                .pending_jobs
                .iter()
                .max_by_key(|(_, job)| {
                    (
                        job.request.metadata.priority,
                        u64::MAX.saturating_sub(job.request.metadata.requested_frame),
                    )
                })
                .map(|(key, job)| (key.clone(), job.request.metadata.priority));
            let Some((worst_key, worst_priority)) = worst else {
                return;
            };
            if worst_priority < priority {
                self.last_tile_jobs_cancelled = self.last_tile_jobs_cancelled.saturating_add(1);
                return;
            }
            self.pending_jobs.remove(&worst_key);
            self.active_job_keys.remove(&worst_key);
            self.last_tile_jobs_cancelled = self.last_tile_jobs_cancelled.saturating_add(1);
        }
        crate::diagnostics::event(
            "tile_stream",
            "request",
            "queued",
            &[
                (
                    "zoom_event_id",
                    request
                        .metadata
                        .zoom_event_id
                        .unwrap_or_default()
                        .to_string(),
                ),
                ("kind", format!("{:?}", request.metadata.kind)),
                (
                    "tile_id",
                    format!(
                        "{}:{}",
                        request.metadata.key.tile.lod, request.metadata.key.tile.index
                    ),
                ),
                ("priority", priority.to_string()),
                (
                    "surface_revision",
                    request.metadata.key.surface_revision.to_string(),
                ),
            ],
        );
        self.active_job_keys.insert(key.clone());
        self.pending_jobs.insert(key, PendingTileJob { request });
        self.last_tile_jobs_queued = self.last_tile_jobs_queued.saturating_add(1);
    }

    #[allow(clippy::too_many_arguments)]
    fn queue_near_visible_halo(
        &mut self,
        map: &NativeMap,
        surface: Arc<CanonicalSurface>,
        min_chunk_x: u32,
        min_chunk_y: u32,
        max_chunk_x: u32,
        max_chunk_y: u32,
        lod: u8,
        terrain_visible: bool,
        zoom_event_id: Option<u64>,
    ) {
        let (chunks_x, chunks_y) = surface.chunk_grid_dimensions();
        let halo_min_x = min_chunk_x.saturating_sub(1);
        let halo_min_y = min_chunk_y.saturating_sub(1);
        let halo_max_x = max_chunk_x
            .saturating_add(1)
            .min(chunks_x.saturating_sub(1));
        let halo_max_y = max_chunk_y
            .saturating_add(1)
            .min(chunks_y.saturating_sub(1));
        for chunk_y in halo_min_y..=halo_max_y {
            for chunk_x in halo_min_x..=halo_max_x {
                if (min_chunk_x..=max_chunk_x).contains(&chunk_x)
                    && (min_chunk_y..=max_chunk_y).contains(&chunk_y)
                {
                    continue;
                }
                self.queue_tile_job(
                    map,
                    Arc::clone(&surface),
                    chunk_x,
                    chunk_y,
                    lod,
                    terrain_visible,
                    1,
                    zoom_event_id,
                );
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn queue_adjacent_lod_prefetch(
        &mut self,
        map: &NativeMap,
        surface: Arc<CanonicalSurface>,
        visible_coords: &[(u32, u32)],
        lod: u8,
        lod_before: u8,
        terrain_visible: bool,
        zoom_event_id: Option<u64>,
    ) {
        let adjacent_lod = if lod < lod_before {
            lod.checked_sub(1)
        } else if lod > lod_before {
            (lod < 6).then_some(lod + 1)
        } else {
            None
        };
        let Some(adjacent_lod) = adjacent_lod else {
            return;
        };
        let center = visible_coords.iter().fold((0_u64, 0_u64), |sum, point| {
            (sum.0 + u64::from(point.0), sum.1 + u64::from(point.1))
        });
        let count = visible_coords.len().max(1) as u64;
        let center = (center.0 / count, center.1 / count);
        let mut ordered = visible_coords.to_vec();
        ordered.sort_by_key(|point| {
            (i64::from(point.0) - center.0 as i64).unsigned_abs()
                + (i64::from(point.1) - center.1 as i64).unsigned_abs()
        });
        for (chunk_x, chunk_y) in ordered.into_iter().take(MAX_PREFETCH_TILES_PER_FRAME) {
            self.queue_tile_job(
                map,
                Arc::clone(&surface),
                chunk_x,
                chunk_y,
                adjacent_lod,
                terrain_visible,
                2,
                zoom_event_id,
            );
        }
    }

    fn prune_pending_jobs(&mut self) {
        let minimum_frame = self.frame.saturating_sub(3);
        let obsolete = self
            .pending_jobs
            .iter()
            .filter(|(_, job)| job.request.metadata.requested_frame < minimum_frame)
            .map(|(key, _)| key.clone())
            .collect::<Vec<_>>();
        for key in obsolete {
            self.pending_jobs.remove(&key);
            self.active_job_keys.remove(&key);
            self.last_tile_jobs_cancelled = self.last_tile_jobs_cancelled.saturating_add(1);
        }
    }

    fn dispatch_pending_jobs(&mut self) {
        if self.worker_pool.is_none() {
            self.worker_pool = Some(TileWorkerPool::new());
        }
        while self.in_flight_job_keys.len() < TILE_WORKER_COUNT {
            let overview_in_flight = self
                .in_flight_job_keys
                .iter()
                .any(|key| key.tile.lod == u8::MAX);
            let next_key = self
                .pending_jobs
                .iter()
                .filter(|(_, job)| {
                    !overview_in_flight || job.request.metadata.kind == SurfaceBuildKind::Tile
                })
                .min_by_key(|(_, job)| {
                    (
                        job.request.metadata.priority,
                        std::cmp::Reverse(job.request.metadata.requested_frame),
                    )
                })
                .map(|(key, _)| key.clone());
            let Some(next_key) = next_key else {
                break;
            };
            let Some(job) = self.pending_jobs.remove(&next_key) else {
                continue;
            };
            let sender = self
                .worker_pool
                .as_ref()
                .expect("worker pool initialized")
                .requests
                .clone();
            match sender.try_send(job.request) {
                Ok(()) => {
                    self.in_flight_job_keys.insert(next_key);
                }
                Err(TrySendError::Full(request)) => {
                    self.pending_jobs
                        .insert(next_key, PendingTileJob { request });
                    break;
                }
                Err(TrySendError::Disconnected(_)) => {
                    self.active_job_keys.remove(&next_key);
                    self.last_tile_jobs_cancelled = self.last_tile_jobs_cancelled.saturating_add(1);
                    self.worker_pool = None;
                    break;
                }
            }
        }
    }

    fn add_canonical_trace(&mut self, samples: CanonicalSampleTrace) {
        self.last_canonical_cells_requested = self
            .last_canonical_cells_requested
            .saturating_add(samples.cells_requested);
        self.last_canonical_cells_materialized = self
            .last_canonical_cells_materialized
            .saturating_add(samples.materialized_cells);
        self.last_canonical_cells_virtual = self
            .last_canonical_cells_virtual
            .saturating_add(samples.virtual_cells_synthesized);
        self.last_analysis_samples = self
            .last_analysis_samples
            .saturating_add(samples.analysis_samples);
        self.last_procedural_samples = self
            .last_procedural_samples
            .saturating_add(samples.procedural_samples);
        self.last_geology_samples = self
            .last_geology_samples
            .saturating_add(samples.geology_samples);
    }

    fn log_ensure_trace(
        &self,
        zoom_event_id: u64,
        map: &NativeMap,
        screen_scale: f32,
        pixels_per_source_cell: f32,
        lod_before: u8,
    ) {
        crate::diagnostics::event(
            "surface_texture_ensure",
            "ensure",
            "completed",
            &[
                ("zoom_event_id", zoom_event_id.to_string()),
                (
                    "surface_texture_ensure_total_us",
                    self.last_ensure_micros.to_string(),
                ),
                (
                    "lod_selection_us",
                    self.last_lod_selection_micros.to_string(),
                ),
                (
                    "visible_chunk_query_us",
                    self.last_visible_chunk_query_micros.to_string(),
                ),
                ("cache_lookup_us", self.last_cache_lookup_micros.to_string()),
                (
                    "tile_cpu_synthesis_us",
                    self.last_tile_cpu_synthesis_micros.to_string(),
                ),
                (
                    "texture_encode_us",
                    self.last_texture_encode_micros.to_string(),
                ),
                (
                    "gpu_upload_submission_us",
                    self.last_texture_submission_micros.to_string(),
                ),
                (
                    "overview_build_us",
                    self.last_overview_build_micros.to_string(),
                ),
                ("screen_pixels_per_km", format!("{screen_scale:.9}")),
                ("surface_cell_m", format!("{:.3}", map.surface_cell_m)),
                (
                    "pixels_per_source_cell",
                    format!("{pixels_per_source_cell:.9}"),
                ),
                ("lod_before", lod_before.to_string()),
                ("lod_after", self.lod.to_string()),
                ("visible_chunks", self.last_visible_chunk_count.to_string()),
                ("tiles_requested", self.last_tiles_requested.to_string()),
                ("tile_cache_hits", self.last_tile_cache_hits.to_string()),
                ("tile_cache_misses", self.last_tile_cache_misses.to_string()),
                ("tiles_built", self.last_tiles_built.to_string()),
                ("tiles_uploaded", self.last_upload_count.to_string()),
                (
                    "canonical_cells_requested",
                    self.last_canonical_cells_requested.to_string(),
                ),
                (
                    "canonical_cells_virtual_synthesized",
                    self.last_canonical_cells_virtual.to_string(),
                ),
                ("tile_jobs_queued", self.last_tile_jobs_queued.to_string()),
                (
                    "tile_jobs_in_flight",
                    self.in_flight_job_keys.len().to_string(),
                ),
                ("tile_jobs_pending", self.pending_jobs.len().to_string()),
                ("tile_jobs_ready_cpu", self.ready_results.len().to_string()),
                (
                    "tile_jobs_completed",
                    self.last_tile_jobs_completed.to_string(),
                ),
                (
                    "tile_jobs_deduplicated",
                    self.last_tile_jobs_deduplicated.to_string(),
                ),
                ("tile_jobs_stale", self.last_tile_jobs_stale.to_string()),
                (
                    "tile_jobs_cancelled",
                    self.last_tile_jobs_cancelled.to_string(),
                ),
                ("worker_cpu_us", self.last_worker_cpu_micros.to_string()),
                ("main_apply_us", self.last_main_apply_micros.to_string()),
                (
                    "completed_payload_bytes",
                    self.last_completed_payload_bytes.to_string(),
                ),
            ],
        );
    }

    pub(crate) fn draw_commands(&self, visible_world: Rect) -> Vec<SurfaceTextureDraw> {
        let mut commands = Vec::with_capacity(
            self.visible_keys
                .len()
                .saturating_add(self.overview_blocks.len())
                .saturating_add(2),
        );
        if let Some(fallback) = &self.fallback {
            commands.push(SurfaceTextureDraw {
                texture_id: fallback.texture.id(),
                world_rect: fallback.world_rect,
            });
        }
        if self.overview_active {
            if let Some(overview) = self
                .overview
                .as_ref()
                .filter(|_| self.overview_terrain_visible == self.terrain_visible)
            {
                commands.push(SurfaceTextureDraw {
                    texture_id: overview.texture.id(),
                    world_rect: overview.world_rect,
                });
            }
            let mut blocks = self.overview_blocks.iter().collect::<Vec<_>>();
            blocks.sort_by_key(|(key, _)| key.index);
            commands.extend(blocks.into_iter().map(|(_, block)| SurfaceTextureDraw {
                texture_id: block.texture.id(),
                world_rect: block.world_rect,
            }));
            return commands;
        }
        for key in &self.visible_keys {
            let tile = self.tiles.get(key).or_else(|| {
                self.tiles
                    .iter()
                    .filter(|(candidate, tile)| {
                        candidate.index == key.index
                            && candidate.terrain_visible == key.terrain_visible
                            && tile.world_rect.intersects(visible_world)
                    })
                    .min_by_key(|(candidate, _)| candidate.lod.abs_diff(key.lod))
                    .map(|(_, tile)| tile)
            });
            let Some(tile) = tile.filter(|tile| tile.world_rect.intersects(visible_world)) else {
                continue;
            };
            commands.push(SurfaceTextureDraw {
                texture_id: tile.texture.id(),
                world_rect: tile.world_rect,
            });
        }
        commands
    }

    fn evict_cold_tiles(&mut self) {
        if self.tiles.len() <= MAX_CACHED_TILES && self.cached_tile_bytes <= MAX_CACHED_TILE_BYTES {
            return;
        }
        let visible = self.visible_keys.iter().copied().collect::<HashSet<_>>();
        while self.tiles.len() > MAX_CACHED_TILES || self.cached_tile_bytes > MAX_CACHED_TILE_BYTES
        {
            let Some(key) = self
                .tiles
                .iter()
                .filter(|(key, _)| !visible.contains(key))
                .min_by_key(|(_, tile)| tile.last_used_frame)
                .map(|(key, _)| *key)
            else {
                break;
            };
            if let Some(tile) = self.tiles.remove(&key) {
                self.cached_tile_bytes = self.cached_tile_bytes.saturating_sub(tile.byte_size);
            }
        }
    }
}

fn tile_worker_loop(
    requests: Arc<Mutex<Receiver<TileBuildRequest>>>,
    results: SyncSender<TileBuildResult>,
) {
    loop {
        let request = {
            let Ok(receiver) = requests.lock() else {
                break;
            };
            match receiver.recv() {
                Ok(request) => request,
                Err(_) => break,
            }
        };
        let metadata = request.metadata.clone();
        let outcome = catch_unwind(AssertUnwindSafe(|| build_tile_cpu(&request)))
            .unwrap_or(Err(TileBuildError::WorkerPanicked));
        match &outcome {
            Ok(payload) => crate::diagnostics::event(
                "canonical_tile_build",
                "tile_cpu",
                "completed",
                &[
                    (
                        "zoom_event_id",
                        metadata.zoom_event_id.unwrap_or_default().to_string(),
                    ),
                    ("kind", format!("{:?}", metadata.kind)),
                    (
                        "tile_id",
                        format!("{}:{}", metadata.key.tile.lod, metadata.key.tile.index),
                    ),
                    ("lod", metadata.key.tile.lod.to_string()),
                    (
                        "chunk_coord",
                        format!("{},{}", metadata.chunk_x, metadata.chunk_y),
                    ),
                    (
                        "tile_dimensions",
                        format!("{}x{}", payload.image_width, payload.image_height),
                    ),
                    (
                        "canonical_cells_requested",
                        payload.samples.cells_requested.to_string(),
                    ),
                    (
                        "canonical_cells_materialized",
                        payload.samples.materialized_cells.to_string(),
                    ),
                    (
                        "canonical_cells_virtual_synthesized",
                        payload.samples.virtual_cells_synthesized.to_string(),
                    ),
                    (
                        "analysis_samples",
                        payload.samples.analysis_samples.to_string(),
                    ),
                    (
                        "procedural_samples",
                        payload.samples.procedural_samples.to_string(),
                    ),
                    (
                        "geology_samples",
                        payload.samples.geology_samples.to_string(),
                    ),
                    ("surface_samples_us", payload.sample_us.to_string()),
                    ("texture_payload_us", payload.color_us.to_string()),
                    ("worker_cpu_us", payload.worker_cpu_us.to_string()),
                    ("priority", metadata.priority.to_string()),
                    (
                        "surface_revision",
                        metadata.key.surface_revision.to_string(),
                    ),
                ],
            ),
            Err(error) => crate::diagnostics::warning(
                "canonical_tile_build",
                "tile_cpu",
                "failed",
                &[
                    (
                        "zoom_event_id",
                        metadata.zoom_event_id.unwrap_or_default().to_string(),
                    ),
                    (
                        "tile_id",
                        format!("{}:{}", metadata.key.tile.lod, metadata.key.tile.index),
                    ),
                    ("error", format!("{error:?}")),
                ],
            ),
        }
        if results.send(TileBuildResult { metadata, outcome }).is_err() {
            break;
        }
    }
}

fn build_tile_cpu(request: &TileBuildRequest) -> Result<TileCpuPayload, TileBuildError> {
    match request.metadata.kind {
        SurfaceBuildKind::Tile => build_chunk_tile_cpu(request),
        SurfaceBuildKind::OverviewPreview | SurfaceBuildKind::OverviewBlock => {
            build_overview_cpu(request)
        }
    }
}

fn build_chunk_tile_cpu(request: &TileBuildRequest) -> Result<TileCpuPayload, TileBuildError> {
    if request.metadata.key.tile.lod == 0 {
        return build_refined_chunk_tile_cpu(request);
    }
    let started = Instant::now();
    begin_canonical_sample_trace();
    let sample_started = Instant::now();
    let samples_result = request.surface.chunk_render_samples_lod(
        request.metadata.chunk_x,
        request.metadata.chunk_y,
        request.metadata.key.tile.lod,
    );
    let sample_us = sample_started.elapsed().as_micros() as u64;
    let Some((image_width, image_height, render_samples)) = samples_result else {
        let _ = finish_canonical_sample_trace();
        return Err(TileBuildError::InvalidTile);
    };
    let trace = finish_canonical_sample_trace();
    let factor = 1_usize << request.metadata.key.tile.lod.min(6);
    let origin_x = request.metadata.chunk_x as usize * CanonicalSurface::CHUNK_SIZE as usize;
    let origin_y = request.metadata.chunk_y as usize * CanonicalSurface::CHUNK_SIZE as usize;
    let color_started = Instant::now();
    let pixels = render_samples
        .into_iter()
        .enumerate()
        .map(|(index, sample)| {
            let output_x = index % image_width;
            let output_y = index / image_width;
            let source_x = (origin_x + output_x * factor + factor / 2)
                .min(request.surface.width.saturating_sub(1) as usize);
            let source_y = (origin_y + output_y * factor + factor / 2)
                .min(request.surface.height.saturating_sub(1) as usize);
            surface_display_color_at(
                sample.surface_name,
                sample.elevation_m,
                request.metadata.environment_seed,
                source_x,
                source_y,
                request.metadata.key.tile.terrain_visible,
            )
        })
        .collect::<Vec<_>>();
    let color_us = color_started.elapsed().as_micros() as u64;
    Ok(TileCpuPayload {
        image_width,
        image_height,
        pixels,
        samples: trace,
        sample_us,
        color_us,
        worker_cpu_us: started.elapsed().as_micros() as u64,
        worker_thread: thread::current().name().unwrap_or("unnamed").to_owned(),
    })
}

fn build_refined_chunk_tile_cpu(
    request: &TileBuildRequest,
) -> Result<TileCpuPayload, TileBuildError> {
    let started = Instant::now();
    let Some((chunk_width, chunk_height)) = request
        .surface
        .chunk_dimensions(request.metadata.chunk_x, request.metadata.chunk_y)
    else {
        return Err(TileBuildError::InvalidTile);
    };
    let origin_x = request.metadata.chunk_x as usize * CanonicalSurface::CHUNK_SIZE as usize;
    let origin_y = request.metadata.chunk_y as usize * CanonicalSurface::CHUNK_SIZE as usize;
    let end_x = origin_x + chunk_width;
    let end_y = origin_y + chunk_height;

    begin_canonical_sample_trace();
    let sample_started = Instant::now();
    let Some(window) = RefinementWindow::new(
        &request.surface,
        origin_x as i32 - 2,
        origin_y as i32 - 2,
        end_x as i32 + 2,
        end_y as i32 + 2,
        request.metadata.environment_seed,
        request.metadata.sea_level_m,
    ) else {
        let _ = finish_canonical_sample_trace();
        return Err(TileBuildError::InvalidTile);
    };
    let sample_us = sample_started.elapsed().as_micros() as u64;
    let trace = finish_canonical_sample_trace();

    const SUBCELL_SCALE: usize = 2;
    let image_width = chunk_width * SUBCELL_SCALE;
    let image_height = chunk_height * SUBCELL_SCALE;
    let color_started = Instant::now();
    let variations = (0..chunk_height)
        .flat_map(|local_y| {
            (0..chunk_width).map(move |local_x| {
                crate::procedural::isotropic_fbm(
                    request.metadata.environment_seed ^ 0x8f1b_bcdc,
                    (origin_x + local_x) as f64 * 0.1,
                    (origin_y + local_y) as f64 * 0.1,
                    5.5,
                    3,
                ) as f32
            })
        })
        .collect::<Vec<_>>();
    let mut pixels = Vec::with_capacity(image_width.saturating_mul(image_height));
    for output_y in 0..image_height {
        let sample_y = origin_y as f32 + (output_y as f32 + 0.5) / SUBCELL_SCALE as f32;
        for output_x in 0..image_width {
            let sample_x = origin_x as f32 + (output_x as f32 + 0.5) / SUBCELL_SCALE as f32;
            let sample = window.sample(sample_x, sample_y);
            let source_x = sample_x
                .floor()
                .clamp(0.0, request.surface.width.saturating_sub(1) as f32)
                as usize;
            let source_y = sample_y
                .floor()
                .clamp(0.0, request.surface.height.saturating_sub(1) as f32)
                as usize;
            let variation = variations[(source_y - origin_y) * chunk_width + source_x - origin_x];
            let primary = surface_display_color_with_variation(
                sample.surface_name,
                sample.elevation_m,
                variation,
                request.metadata.key.tile.terrain_visible,
            );
            let color = sample.secondary_surface_name.map_or(primary, |secondary| {
                mix_color(
                    primary,
                    surface_display_color_with_variation(
                        secondary,
                        sample.elevation_m,
                        variation,
                        request.metadata.key.tile.terrain_visible,
                    ),
                    sample.secondary_mix,
                )
            });
            pixels.push(color);
        }
    }
    let color_us = color_started.elapsed().as_micros() as u64;
    Ok(TileCpuPayload {
        image_width,
        image_height,
        pixels,
        samples: trace,
        sample_us,
        color_us,
        worker_cpu_us: started.elapsed().as_micros() as u64,
        worker_thread: thread::current().name().unwrap_or("unnamed").to_owned(),
    })
}

fn render_chunk_revision(surface: &CanonicalSurface, chunk_x: u32, chunk_y: u32, lod: u8) -> u64 {
    if lod == 0 {
        chunk_halo_revision_hash(surface, chunk_x, chunk_y, 1)
    } else {
        surface.chunk_revision(chunk_x, chunk_y).unwrap_or_default()
    }
}

fn overview_block_revision(surface: &CanonicalSurface, spec: OverviewBuildSpec) -> u64 {
    if surface.width == 0
        || surface.height == 0
        || spec.target_width == 0
        || spec.target_height == 0
        || spec.pixel_width == 0
        || spec.pixel_height == 0
    {
        return 0;
    }
    let source_left = spec.pixel_x.saturating_mul(surface.width as usize) / spec.target_width;
    let source_top = spec.pixel_y.saturating_mul(surface.height as usize) / spec.target_height;
    let source_right = (spec.pixel_x + spec.pixel_width)
        .saturating_mul(surface.width as usize)
        .div_ceil(spec.target_width)
        .min(surface.width as usize);
    let source_bottom = (spec.pixel_y + spec.pixel_height)
        .saturating_mul(surface.height as usize)
        .div_ceil(spec.target_height)
        .min(surface.height as usize);
    let first_chunk_x = source_left as u32 / CanonicalSurface::CHUNK_SIZE;
    let first_chunk_y = source_top as u32 / CanonicalSurface::CHUNK_SIZE;
    let last_chunk_x = source_right.saturating_sub(1) as u32 / CanonicalSurface::CHUNK_SIZE;
    let last_chunk_y = source_bottom.saturating_sub(1) as u32 / CanonicalSurface::CHUNK_SIZE;
    let mut hash = 0xcbf2_9ce4_8422_2325_u64;
    for value in [
        spec.target_width as u64,
        spec.target_height as u64,
        spec.pixel_x as u64,
        spec.pixel_y as u64,
        spec.pixel_width as u64,
        spec.pixel_height as u64,
    ] {
        hash ^= value;
        hash = hash.wrapping_mul(0x100_0000_01b3);
    }
    for chunk_y in first_chunk_y..=last_chunk_y {
        for chunk_x in first_chunk_x..=last_chunk_x {
            hash ^= surface.chunk_revision(chunk_x, chunk_y).unwrap_or_default();
            hash = hash.wrapping_mul(0x100_0000_01b3);
            hash ^= (u64::from(chunk_y) << 32) | u64::from(chunk_x);
            hash = hash.wrapping_mul(0x100_0000_01b3);
        }
    }
    hash
}

fn overview_blocks_match_surface(
    surface: &CanonicalSurface,
    blocks: &HashMap<SurfaceTileKey, SurfaceTextureTile>,
    terrain_visible: bool,
    target_width: usize,
    target_height: usize,
) -> bool {
    let blocks_x = target_width.div_ceil(OVERVIEW_BLOCK_AXIS);
    let blocks_y = target_height.div_ceil(OVERVIEW_BLOCK_AXIS);
    for block_y in 0..blocks_y {
        for block_x in 0..blocks_x {
            let pixel_x = block_x * OVERVIEW_BLOCK_AXIS;
            let pixel_y = block_y * OVERVIEW_BLOCK_AXIS;
            let spec = OverviewBuildSpec {
                target_width,
                target_height,
                pixel_x,
                pixel_y,
                pixel_width: OVERVIEW_BLOCK_AXIS.min(target_width - pixel_x),
                pixel_height: OVERVIEW_BLOCK_AXIS.min(target_height - pixel_y),
            };
            let key = SurfaceTileKey {
                lod: u8::MAX,
                index: block_y * blocks_x + block_x,
                terrain_visible,
            };
            if !blocks
                .get(&key)
                .is_some_and(|block| block.revision == overview_block_revision(surface, spec))
            {
                return false;
            }
        }
    }
    true
}

fn overview_target_resolution(map: &NativeMap, screen_scale: f32) -> (usize, usize) {
    let required_axis = (map.width.max(map.height) * screen_scale.max(0.000_1) * 1.10)
        .ceil()
        .max(1.0) as usize;
    let maximum_axis = match required_axis {
        0..=256 => 256,
        257..=512 => 512,
        513..=768 => 768,
        _ => OVERVIEW_MAXIMUM_AXIS,
    };
    overview_dimensions(map.width, map.height, maximum_axis)
}

fn overview_dimensions(world_width: f32, world_height: f32, maximum_axis: usize) -> (usize, usize) {
    let maximum_axis = maximum_axis.max(1);
    let aspect = world_width.max(0.1) / world_height.max(0.1);
    if aspect >= 1.0 {
        (
            maximum_axis,
            (maximum_axis as f32 / aspect).round().max(1.0) as usize,
        )
    } else {
        (
            (maximum_axis as f32 * aspect).round().max(1.0) as usize,
            maximum_axis,
        )
    }
}

fn overview_variant(spec: OverviewBuildSpec, kind: SurfaceBuildKind) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325_u64;
    for value in [
        spec.target_width as u64,
        spec.target_height as u64,
        spec.pixel_x as u64,
        spec.pixel_y as u64,
        spec.pixel_width as u64,
        spec.pixel_height as u64,
        match kind {
            SurfaceBuildKind::Tile => 0,
            SurfaceBuildKind::OverviewPreview => 1,
            SurfaceBuildKind::OverviewBlock => 2,
        },
    ] {
        hash ^= value;
        hash = hash.wrapping_mul(0x100_0000_01b3);
    }
    hash
}

fn build_overview_cpu(request: &TileBuildRequest) -> Result<TileCpuPayload, TileBuildError> {
    let started = Instant::now();
    let Some(spec) = request.metadata.overview else {
        return Err(TileBuildError::InvalidTile);
    };
    if spec.target_width == 0
        || spec.target_height == 0
        || spec.pixel_width == 0
        || spec.pixel_height == 0
        || spec.pixel_x.saturating_add(spec.pixel_width) > spec.target_width
        || spec.pixel_y.saturating_add(spec.pixel_height) > spec.target_height
    {
        return Err(TileBuildError::InvalidTile);
    }
    let image_width = spec.pixel_width;
    let image_height = spec.pixel_height;
    begin_canonical_sample_trace();
    let sample_started = Instant::now();
    let mut pixels = Vec::with_capacity(image_width.saturating_mul(image_height));
    for output_y in 0..image_height {
        for output_x in 0..image_width {
            let global_x = spec.pixel_x + output_x;
            let global_y = spec.pixel_y + output_y;
            let source_x = ((global_x as f64 + 0.5) * request.surface.width as f64
                / spec.target_width as f64)
                .floor()
                .clamp(0.0, request.surface.width.saturating_sub(1) as f64)
                as usize;
            let source_y = ((global_y as f64 + 0.5) * request.surface.height as f64
                / spec.target_height as f64)
                .floor()
                .clamp(0.0, request.surface.height.saturating_sub(1) as f64)
                as usize;
            let sample = request.surface.sample(source_x, source_y);
            let surface_name = if sample.water == "land" {
                sample.terrain
            } else {
                sample.water
            };
            pixels.push(surface_display_color_at(
                surface_name,
                sample.elevation_m,
                request.metadata.environment_seed,
                source_x,
                source_y,
                request.metadata.key.tile.terrain_visible,
            ));
        }
    }
    let sample_us = sample_started.elapsed().as_micros() as u64;
    let trace = finish_canonical_sample_trace();
    Ok(TileCpuPayload {
        image_width,
        image_height,
        pixels,
        samples: trace,
        sample_us,
        color_us: 0,
        worker_cpu_us: started.elapsed().as_micros() as u64,
        worker_thread: thread::current().name().unwrap_or("unnamed").to_owned(),
    })
}

fn tile_result_payload_bytes(result: &TileBuildResult) -> usize {
    result.outcome.as_ref().map_or(0, |payload| {
        payload
            .image_width
            .saturating_mul(payload.image_height)
            .saturating_mul(4)
    })
}

fn rect_from_array(value: [f32; 4]) -> Rect {
    Rect::from_min_max(Pos2::new(value[0], value[1]), Pos2::new(value[2], value[3]))
}

fn analysis_fallback_pixels(
    map: &NativeMap,
    terrain_visible: bool,
) -> (usize, usize, Vec<Color32>) {
    let width = map.grid_width.max(1);
    let height = map.grid_height.max(1);
    let mut pixels = Vec::with_capacity(width.saturating_mul(height));
    for y in 0..height {
        for x in 0..width {
            let index = y.saturating_mul(width).saturating_add(x);
            let terrain = map
                .terrain
                .get(index)
                .map(String::as_str)
                .unwrap_or("plain");
            let water = map.water.get(index).map(String::as_str).unwrap_or("land");
            let name = if water == "land" { terrain } else { water };
            let elevation_m = map.elevation.get(index).copied().unwrap_or(map.sea_level);
            pixels.push(surface_display_color_at(
                name,
                elevation_m,
                map.environment_seed,
                x,
                y,
                terrain_visible,
            ));
        }
    }
    (width, height, pixels)
}

#[cfg(test)]
fn coverage_surface_name(samples: [&'static str; 5]) -> &'static str {
    if samples.contains(&"freshwater") {
        return "freshwater";
    }
    if samples.iter().filter(|name| **name == "saltwater").count() >= 2 {
        return "saltwater";
    }
    let mut best = samples[0];
    let mut best_count = 0;
    for candidate in samples {
        if matches!(candidate, "saltwater" | "freshwater") {
            continue;
        }
        let count = samples.iter().filter(|name| **name == candidate).count();
        if count > best_count {
            best = candidate;
            best_count = count;
        }
    }
    best
}

fn pixels_per_surface_cell(screen_pixels_per_km: f32, surface_cell_m: f32) -> f32 {
    screen_pixels_per_km.max(0.0) * surface_cell_m.max(0.001) / 1_000.0
}

fn surface_lod(pixels_per_source_cell: f32, current: Option<u8>) -> u8 {
    let pixels = pixels_per_source_cell.max(0.000_1);
    let desired = ((1.0 / pixels).log2().round() as i32).clamp(0, 4) as u8;
    let Some(current) = current else {
        return desired;
    };
    if desired > current {
        let boundary = 2.0_f32.powf(-(current as f32 + 0.5)) * 0.88;
        if pixels > boundary {
            return current;
        }
    } else if desired < current {
        let boundary = 2.0_f32.powf(-(current as f32 - 0.5)) * 1.12;
        if pixels < boundary {
            return current;
        }
    }
    desired
}

pub(crate) fn paint_surface_textures(
    painter: &eframe::egui::Painter,
    map: &NativeMap,
    tiles: &[SurfaceTextureDraw],
    _show_terrain: bool,
) {
    painter.rect_filled(
        Rect::from_min_size(Pos2::ZERO, eframe::egui::Vec2::new(map.width, map.height)),
        0.0,
        surface_color("saltwater"),
    );
    let uv = Rect::from_min_max(Pos2::ZERO, Pos2::new(1.0, 1.0));
    for tile in tiles {
        painter.image(tile.texture_id, tile.world_rect, uv, Color32::WHITE);
    }
}

fn surface_display_color(name: &str, terrain_visible: bool) -> Color32 {
    if !terrain_visible && !matches!(name, "saltwater" | "freshwater") {
        Color32::WHITE
    } else {
        surface_color(name)
    }
}

pub(crate) fn surface_display_color_at(
    name: &str,
    elevation_m: f32,
    seed: u32,
    source_x: usize,
    source_y: usize,
    terrain_visible: bool,
) -> Color32 {
    let variation = crate::procedural::isotropic_fbm(
        seed ^ 0x8f1b_bcdc,
        source_x as f64 * 0.1,
        source_y as f64 * 0.1,
        5.5,
        3,
    ) as f32;
    surface_display_color_with_variation(name, elevation_m, variation, terrain_visible)
}

pub(crate) fn surface_display_color_with_variation(
    name: &str,
    elevation_m: f32,
    variation: f32,
    terrain_visible: bool,
) -> Color32 {
    let base = surface_display_color(name, terrain_visible);
    if !terrain_visible && !matches!(name, "saltwater" | "freshwater") {
        return base;
    }
    if name == "saltwater" {
        let depth = (-elevation_m / 5_500.0).clamp(0.0, 1.0).sqrt();
        return mix_color(base, Color32::from_rgb(18, 54, 96), depth * 0.76);
    }
    let elevation_tint = (elevation_m.max(0.0) / 10_000.0).clamp(0.0, 1.0) * 0.08;
    let brightness = (0.955 + variation * 0.09 - elevation_tint).clamp(0.82, 1.06);
    Color32::from_rgb(
        (base.r() as f32 * brightness).round().clamp(0.0, 255.0) as u8,
        (base.g() as f32 * brightness).round().clamp(0.0, 255.0) as u8,
        (base.b() as f32 * brightness).round().clamp(0.0, 255.0) as u8,
    )
}

pub(crate) fn mix_color(left: Color32, right: Color32, amount: f32) -> Color32 {
    let amount = amount.clamp(0.0, 1.0);
    let channel = |left: u8, right: u8| {
        (left as f32 + (right as f32 - left as f32) * amount)
            .round()
            .clamp(0.0, 255.0) as u8
    };
    Color32::from_rgb(
        channel(left.r(), right.r()),
        channel(left.g(), right.g()),
        channel(left.b(), right.b()),
    )
}

pub(crate) fn diagnostic_surface_lod(screen_pixels_per_km: f32, surface_cell_m: f32) -> u8 {
    surface_lod(
        pixels_per_surface_cell(screen_pixels_per_km, surface_cell_m),
        None,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_surface(width: u32, height: u32) -> Arc<CanonicalSurface> {
        Arc::new(CanonicalSurface::generate(width, height, |x, y| {
            let terrain = if (x + y) % 5 == 0 { 2 } else { 0 };
            let water = if y == height.saturating_sub(1) { 1 } else { 0 };
            (
                ((x as i32 * 3 - y as i32 * 2) % 3_000) as i16,
                terrain,
                water,
            )
        }))
    }

    fn test_map(surface: Arc<CanonicalSurface>) -> NativeMap {
        let width = surface.width as f32 * 0.1;
        let height = surface.height as f32 * 0.1;
        NativeMap {
            source_id: "async-tile-test".to_owned(),
            region_id: None,
            map_view_id: None,
            title: "Async Tile Test".to_owned(),
            width,
            height,
            logical_pixel_width: surface.width,
            logical_pixel_height: surface.height,
            surface_cell_m: 100.0,
            grid_width: 1,
            grid_height: 1,
            sea_level: 0.0,
            climate_model: 0,
            environment_seed: 71,
            generation_settings: None,
            geologic_guide: None,
            causal_geology: crate::geology::CausalGeologyModel::default(),
            generation_diagnostics: crate::procedural::GenerationDiagnostics::default(),
            elevation: vec![100.0],
            terrain: vec!["plain".to_owned()],
            water: vec!["land".to_owned()],
            temperature: vec![15.0],
            precipitation: vec![50.0],
            moisture: vec![0.5],
            humidity: vec![50.0],
            runoff: vec![0.0],
            wind_x: vec![0.0],
            wind_y: vec![0.0],
            solar_hours: vec![12.0],
            solar_irradiance: vec![1.0],
            snowfall: vec![0.0],
            snow_cover: vec![0.0],
            evapotranspiration: vec![0.0],
            flow_accumulation: vec![0.0],
            river_order: vec![0.0],
            roads: Vec::new(),
            place_names: Vec::new(),
            rivers: Vec::new(),
            river_graph: crate::river_graph::RiverGraph::default(),
            drainage_outlets: Vec::new(),
            locations: Vec::new(),
            factions: Vec::new(),
            territories: Vec::new(),
            territory_owners: Vec::new(),
            territory_history: Vec::new(),
            events: Vec::new(),
            environment_pins: Vec::new(),
            current_year: 0,
            canonical_surface: Some(surface),
            surface_revision: 7,
        }
    }

    fn test_request(map: &NativeMap, chunk_x: u32, chunk_y: u32, lod: u8) -> TileBuildRequest {
        let surface = Arc::clone(map.canonical_surface.as_ref().expect("surface"));
        let (chunks_x, _) = surface.chunk_grid_dimensions();
        let chunk_revision = render_chunk_revision(&surface, chunk_x, chunk_y, lod);
        TileBuildRequest {
            metadata: TileBuildMetadata {
                key: SurfaceTileJobKey {
                    map_key: format!("{}:{}:{}", map.source_id, surface.width, surface.height),
                    surface_revision: map.surface_revision,
                    chunk_revision,
                    render_variant: 0,
                    tile: SurfaceTileKey {
                        lod,
                        index: (chunk_y * chunks_x + chunk_x) as usize,
                        terrain_visible: true,
                    },
                },
                chunk_x,
                chunk_y,
                environment_seed: map.environment_seed,
                sea_level_m: map.sea_level,
                world_rect: [0.0, 0.0, map.width, map.height],
                zoom_event_id: Some(1),
                priority: 0,
                requested_frame: 1,
                kind: SurfaceBuildKind::Tile,
                overview: None,
            },
            surface,
        }
    }

    fn overview_request(map: &NativeMap, maximum_axis: usize) -> TileBuildRequest {
        let surface = Arc::clone(map.canonical_surface.as_ref().expect("surface"));
        let (target_width, target_height) =
            overview_dimensions(map.width, map.height, maximum_axis);
        let spec = OverviewBuildSpec {
            target_width,
            target_height,
            pixel_x: 0,
            pixel_y: 0,
            pixel_width: target_width,
            pixel_height: target_height,
        };
        TileBuildRequest {
            metadata: TileBuildMetadata {
                key: SurfaceTileJobKey {
                    map_key: format!("{}:{}:{}", map.source_id, surface.width, surface.height),
                    surface_revision: map.surface_revision,
                    chunk_revision: 0,
                    render_variant: overview_variant(spec, SurfaceBuildKind::OverviewPreview),
                    tile: SurfaceTileKey {
                        lod: u8::MAX,
                        index: usize::MAX,
                        terrain_visible: true,
                    },
                },
                chunk_x: 0,
                chunk_y: 0,
                environment_seed: map.environment_seed,
                sea_level_m: map.sea_level,
                world_rect: [0.0, 0.0, map.width, map.height],
                zoom_event_id: Some(1),
                priority: 0,
                requested_frame: 1,
                kind: SurfaceBuildKind::OverviewPreview,
                overview: Some(spec),
            },
            surface,
        }
    }

    #[test]
    fn hidden_terrain_keeps_water_and_whitens_land() {
        assert_eq!(surface_display_color("plain", false), Color32::WHITE);
        assert_eq!(
            surface_display_color("saltwater", false),
            surface_color("saltwater")
        );
        assert_eq!(
            surface_display_color("freshwater", false),
            surface_color("freshwater")
        );
        assert_eq!(
            surface_display_color("forest", true),
            surface_color("forest")
        );
    }

    #[test]
    fn terrain_lod_hysteresis_prevents_boundary_flapping() {
        let boundary = 2.0_f32.powf(-0.5);
        assert_eq!(surface_lod(boundary * 0.95, Some(0)), 0);
        assert_eq!(surface_lod(boundary * 0.80, Some(0)), 1);
        assert_eq!(surface_lod(boundary * 1.05, Some(1)), 1);
        assert_eq!(surface_lod(boundary * 1.20, Some(1)), 0);
    }

    #[test]
    fn surface_lod_uses_actual_cell_size() {
        let scale = 4.0;
        let one_hundred_m = pixels_per_surface_cell(scale, 100.0);
        let five_hundred_m = pixels_per_surface_cell(scale, 500.0);
        assert!((one_hundred_m - 0.4).abs() < 0.000_1);
        assert!((five_hundred_m - 2.0).abs() < 0.000_1);
        assert_eq!(surface_lod(one_hundred_m, None), 1);
        assert_eq!(surface_lod(five_hundred_m, None), 0);
    }

    #[test]
    fn equal_physical_scale_respects_cell_size_ratio() {
        let scale = 7.25;
        let one_hundred_m = pixels_per_surface_cell(scale, 100.0);
        let five_hundred_m = pixels_per_surface_cell(scale, 500.0);
        assert!((five_hundred_m / one_hundred_m - 5.0).abs() < 0.000_1);
    }

    #[test]
    fn saltwater_darkens_monotonically_with_depth() {
        let shallow = surface_display_color_at("saltwater", -20.0, 7, 10, 20, true);
        let deep = surface_display_color_at("saltwater", -4_000.0, 7, 10, 20, true);
        assert!(
            u16::from(deep.r()) + u16::from(deep.g()) + u16::from(deep.b())
                < u16::from(shallow.r()) + u16::from(shallow.g()) + u16::from(shallow.b())
        );
    }

    #[test]
    fn overview_filter_preserves_freshwater_and_majority_coast_coverage() {
        assert_eq!(
            coverage_surface_name(["plain", "plain", "plain", "plain", "freshwater"]),
            "freshwater"
        );
        assert_eq!(
            coverage_surface_name(["plain", "saltwater", "plain", "saltwater", "forest"]),
            "saltwater"
        );
        assert_eq!(
            coverage_surface_name(["forest", "plain", "forest", "forest", "saltwater"]),
            "forest"
        );
    }

    #[test]
    fn overview_preview_uses_one_representative_read_per_output_pixel() {
        let surface = test_surface(512, 320);
        let map = test_map(surface);
        let payload = build_overview_cpu(&overview_request(&map, 128)).expect("overview payload");
        assert_eq!((payload.image_width, payload.image_height), (128, 80));
        assert_eq!(
            payload.samples.cells_requested,
            (payload.image_width * payload.image_height) as u64
        );
    }

    #[test]
    fn overview_result_uses_global_surface_revision() {
        let surface = test_surface(256, 128);
        let map = test_map(surface);
        let request = overview_request(&map, 64);
        let payload = build_overview_cpu(&request).expect("overview payload");
        let payload_bytes = payload.image_width * payload.image_height * 4;
        let spec = request.metadata.overview.expect("overview spec");
        let mut cache = SurfaceTextureCache {
            map_key: request.metadata.key.map_key.clone(),
            frame: 1,
            ready_payload_bytes: payload_bytes,
            overview_active: true,
            terrain_visible: true,
            overview_revision: map.surface_revision,
            overview_terrain_visible: true,
            overview_target_width: spec.target_width,
            overview_target_height: spec.target_height,
            ..SurfaceTextureCache::default()
        };
        cache.active_job_keys.insert(request.metadata.key.clone());
        cache.ready_results.push_back(TileBuildResult {
            metadata: request.metadata,
            outcome: Ok(payload),
        });
        cache.apply_ready_results(&Context::default(), &map);
        assert!(cache.overview.is_some());
        assert_eq!(cache.last_tile_jobs_stale, 0);
        assert_eq!(cache.last_tile_jobs_completed, 1);
    }

    #[test]
    fn overview_job_deduplicates_same_revision() {
        let surface = test_surface(256, 128);
        let map = test_map(Arc::clone(&surface));
        let mut cache = SurfaceTextureCache {
            map_key: format!("{}:{}:{}", map.source_id, surface.width, surface.height),
            frame: 1,
            ..SurfaceTextureCache::default()
        };
        cache.queue_overview_preview_job(&map, Arc::clone(&surface), true, 512, 256, Some(1));
        cache.queue_overview_preview_job(&map, surface, true, 512, 256, Some(2));
        assert_eq!(cache.pending_jobs.len(), 1);
        assert_eq!(cache.last_tile_jobs_deduplicated, 1);
    }

    #[test]
    fn overview_resolution_tracks_viewport_scale_in_quantized_steps() {
        let map = test_map(test_surface(512, 320));
        assert_eq!(overview_target_resolution(&map, 1.0), (256, 160));
        assert_eq!(overview_target_resolution(&map, 5.0), (512, 320));
        assert_eq!(overview_target_resolution(&map, 10.0), (768, 480));
        assert_eq!(overview_target_resolution(&map, 50.0), (1024, 640));
    }

    #[test]
    fn overview_cache_invalidates_on_surface_revision() {
        let mut cache = SurfaceTextureCache {
            overview_revision: 7,
            overview_target_width: 512,
            overview_target_height: 256,
            overview_terrain_visible: true,
            ..SurfaceTextureCache::default()
        };
        cache.reset_overview_generation(8, true, 512, 256);
        assert_eq!(cache.overview_revision, 8);
        assert!(cache.overview.is_none());
        assert!(cache.overview_blocks.is_empty());
    }

    #[test]
    fn overview_block_revision_invalidates_only_the_edited_area() {
        let mut map = test_map(test_surface(512, 256));
        let left = OverviewBuildSpec {
            target_width: 256,
            target_height: 128,
            pixel_x: 0,
            pixel_y: 0,
            pixel_width: 128,
            pixel_height: 128,
        };
        let right = OverviewBuildSpec {
            pixel_x: 128,
            ..left
        };
        let left_before = overview_block_revision(map.canonical_surface.as_ref().unwrap(), left);
        let right_before = overview_block_revision(map.canonical_surface.as_ref().unwrap(), right);
        let old = map.canonical_sample(400, 100);
        assert!(map.edit_canonical_cell(400, 100, Some(old.elevation_m + 10.0), None, None));
        let left_after = overview_block_revision(map.canonical_surface.as_ref().unwrap(), left);
        let right_after = overview_block_revision(map.canonical_surface.as_ref().unwrap(), right);
        assert_eq!(left_before, left_after);
        assert_ne!(right_before, right_after);
    }

    #[test]
    fn overview_build_is_progressive_and_bounded() {
        let surface = test_surface(512, 512);
        let map = test_map(Arc::clone(&surface));
        let mut cache = SurfaceTextureCache {
            map_key: format!("{}:{}:{}", map.source_id, surface.width, surface.height),
            frame: 1,
            overview_revision: map.surface_revision,
            overview_target_width: 1024,
            overview_target_height: 1024,
            overview_terrain_visible: true,
            ..SurfaceTextureCache::default()
        };
        cache.queue_overview_preview_job(&map, Arc::clone(&surface), true, 1024, 1024, None);
        cache.queue_overview_block_jobs(&map, surface, true, 1024, 1024, None);
        let preview_count = cache
            .pending_jobs
            .values()
            .filter(|job| job.request.metadata.kind == SurfaceBuildKind::OverviewPreview)
            .count();
        let block_count = cache
            .pending_jobs
            .values()
            .filter(|job| job.request.metadata.kind == SurfaceBuildKind::OverviewBlock)
            .count();
        assert_eq!(preview_count, 1);
        assert_eq!(block_count, MAX_OVERVIEW_BLOCKS_QUEUED_PER_FRAME);
        assert!(cache.pending_jobs.len() <= MAX_PENDING_TILE_JOBS);
    }

    #[test]
    fn overview_jobs_do_not_starve_visible_tiles() {
        let surface = test_surface(256, 256);
        let map = test_map(Arc::clone(&surface));
        let mut cache = SurfaceTextureCache {
            map_key: format!("{}:{}:{}", map.source_id, surface.width, surface.height),
            frame: 1,
            ..SurfaceTextureCache::default()
        };
        cache.queue_overview_preview_job(&map, Arc::clone(&surface), true, 512, 512, None);
        cache.queue_tile_job(&map, surface, 0, 0, 1, true, 0, None);
        cache.dispatch_pending_jobs();
        assert!(
            cache
                .in_flight_job_keys
                .iter()
                .any(|key| key.tile.lod != u8::MAX)
        );
        assert!(
            cache
                .in_flight_job_keys
                .iter()
                .filter(|key| key.tile.lod == u8::MAX)
                .count()
                <= 1
        );
    }

    #[test]
    fn overview_output_preserves_sampled_water_kind() {
        let surface = Arc::new(CanonicalSurface::generate(2, 1, |x, _| {
            if x == 0 { (-20, 0, 2) } else { (-200, 0, 1) }
        }));
        let map = test_map(surface);
        let request = overview_request(&map, 2);
        let payload = build_overview_cpu(&request).expect("overview payload");
        assert_eq!((payload.image_width, payload.image_height), (2, 1));
        assert_eq!(
            payload.pixels[0],
            surface_display_color_at("freshwater", -20.0, map.environment_seed, 0, 0, true)
        );
        assert_eq!(
            payload.pixels[1],
            surface_display_color_at("saltwater", -200.0, map.environment_seed, 1, 0, true)
        );
    }

    #[test]
    fn neighboring_surface_edit_invalidates_lod0_halo() {
        let mut map = test_map(test_surface(512, 4));
        let before = render_chunk_revision(map.canonical_surface.as_ref().unwrap(), 0, 0, 0);
        assert!(map.edit_canonical_cell(300, 1, None, Some("forest"), None));
        let after = render_chunk_revision(map.canonical_surface.as_ref().unwrap(), 0, 0, 0);
        assert_ne!(before, after);
    }

    #[test]
    #[ignore = "explicit large-map overview performance probe"]
    fn large_overview_worker_benchmark_exercises_more_than_768_chunks() {
        let mut map = test_map(test_surface(1, 1));
        map.width = 700.0;
        map.height = 700.0;
        map.canonical_surface = None;
        assert!(map.rebuild_canonical_surface());
        let surface = map.canonical_surface.as_ref().expect("virtual surface");
        let (chunks_x, chunks_y) = surface.chunk_grid_dimensions();
        assert!(u64::from(chunks_x) * u64::from(chunks_y) > MAX_VISIBLE_CHUNKS);
        let payload = build_overview_cpu(&overview_request(&map, OVERVIEW_PREVIEW_AXIS))
            .expect("large overview preview payload");
        eprintln!(
            "large_overview chunks={} output={}x{} canonical_requests={} worker_cpu_us={}",
            u64::from(chunks_x) * u64::from(chunks_y),
            payload.image_width,
            payload.image_height,
            payload.samples.cells_requested,
            payload.worker_cpu_us,
        );
        assert_eq!(
            payload.samples.cells_requested,
            (payload.image_width * payload.image_height) as u64
        );
        assert!(payload.worker_cpu_us < 1_000_000);
    }

    #[test]
    #[ignore = "explicit cold/warm streaming performance probe"]
    fn cold_and_warm_streaming_benchmark_separates_ui_and_detail_latency() {
        let surface = test_surface(1_024, 768);
        let map = test_map(surface);
        let context = Context::default();
        let visible_world =
            Rect::from_min_size(Pos2::ZERO, eframe::egui::Vec2::new(map.width, map.height));
        let mut cache = SurfaceTextureCache::default();
        let cold_started = Instant::now();
        cache.ensure_traced(&context, &map, 10.0, visible_world, true, Some(10_001));
        let cold_main_us = cold_started.elapsed().as_micros() as u64;
        assert_eq!(cache.last_tile_cpu_synthesis_micros, 0);
        assert!(!cache.visible_ready());

        let detail_started = Instant::now();
        for _ in 0..1_000 {
            thread::sleep(Duration::from_millis(2));
            cache.ensure(&context, &map, 10.0, visible_world, true);
            if cache.visible_ready() {
                break;
            }
        }
        let detail_ready_us = detail_started.elapsed().as_micros() as u64;
        assert!(cache.visible_ready());

        let warm_started = Instant::now();
        cache.ensure_traced(&context, &map, 10.0, visible_world, true, Some(10_002));
        let warm_main_us = warm_started.elapsed().as_micros() as u64;
        eprintln!(
            "streaming_benchmark cold_main_us={} detail_ready_us={} warm_main_us={} tiles={} pending={} in_flight={}",
            cold_main_us,
            detail_ready_us,
            warm_main_us,
            cache.tiles.len(),
            cache.pending_jobs.len(),
            cache.in_flight_job_keys.len(),
        );
        assert_eq!(cache.last_tile_cpu_synthesis_micros, 0);
        assert!(cache.pending_jobs.len() <= MAX_PENDING_TILE_JOBS);
    }

    #[test]
    fn tile_job_deduplicates_same_key() {
        let surface = test_surface(256, 256);
        let map = test_map(Arc::clone(&surface));
        let mut cache = SurfaceTextureCache {
            map_key: format!("{}:{}:{}", map.source_id, surface.width, surface.height),
            frame: 1,
            ..SurfaceTextureCache::default()
        };
        cache.queue_tile_job(&map, Arc::clone(&surface), 0, 0, 0, true, 0, Some(1));
        cache.queue_tile_job(&map, Arc::clone(&surface), 0, 0, 0, true, 0, Some(2));
        assert_eq!(cache.pending_jobs.len(), 1);
        assert_eq!(cache.active_job_keys.len(), 1);
        assert_eq!(cache.last_tile_jobs_deduplicated, 1);
    }

    #[test]
    fn tile_worker_result_rejects_stale_surface_revision() {
        let surface = test_surface(256, 256);
        let map = test_map(Arc::clone(&surface));
        let mut request = test_request(&map, 0, 0, 0);
        request.metadata.key.surface_revision = map.surface_revision.saturating_sub(1);
        let payload = build_tile_cpu(&request).expect("payload");
        let payload_bytes = payload
            .image_width
            .saturating_mul(payload.image_height)
            .saturating_mul(4);
        let key = request.metadata.key.clone();
        let mut cache = SurfaceTextureCache {
            map_key: format!("{}:{}:{}", map.source_id, surface.width, surface.height),
            frame: 1,
            ready_payload_bytes: payload_bytes,
            ..SurfaceTextureCache::default()
        };
        cache.active_job_keys.insert(key);
        cache.ready_results.push_back(TileBuildResult {
            metadata: request.metadata,
            outcome: Ok(payload),
        });
        cache.apply_ready_results(&Context::default(), &map);
        assert_eq!(cache.last_tile_jobs_stale, 1);
        assert!(cache.tiles.is_empty());
    }

    #[test]
    fn cold_tile_build_does_not_run_on_main_thread() {
        let surface = test_surface(256, 256);
        let map = test_map(surface);
        let pool = TileWorkerPool::new();
        pool.requests
            .send(test_request(&map, 0, 0, 0))
            .expect("queue");
        let result = pool
            .results
            .recv_timeout(Duration::from_secs(5))
            .expect("worker result");
        let payload = result.outcome.expect("tile payload");
        assert!(payload.worker_thread.starts_with("urdr-tile-worker-"));
        assert_ne!(payload.worker_thread, "main");
    }

    #[test]
    fn warm_tile_hit_does_not_enqueue_job() {
        let surface = test_surface(256, 256);
        let map = test_map(Arc::clone(&surface));
        let context = Context::default();
        let texture = context.load_texture(
            "warm-hit",
            ColorImage::new([1, 1], vec![Color32::WHITE]),
            TextureOptions::NEAREST,
        );
        let map_key = format!("{}:{}:{}", map.source_id, surface.width, surface.height);
        let key = SurfaceTileKey {
            lod: 0,
            index: 0,
            terrain_visible: true,
        };
        let mut cache = SurfaceTextureCache {
            map_key,
            frame: 1,
            ..SurfaceTextureCache::default()
        };
        cache.tiles.insert(
            key,
            SurfaceTextureTile {
                revision: render_chunk_revision(&surface, 0, 0, 0),
                texture,
                world_rect: Rect::from_min_size(
                    Pos2::ZERO,
                    eframe::egui::Vec2::new(map.width, map.height),
                ),
                image_width: 1,
                image_height: 1,
                byte_size: 4,
                last_used_frame: 1,
            },
        );
        cache.queue_tile_job(&map, surface, 0, 0, 0, true, 0, Some(1));
        assert!(cache.pending_jobs.is_empty());
        assert!(cache.active_job_keys.is_empty());
    }

    #[test]
    fn rapid_zoom_keeps_tile_queue_bounded() {
        let surface = test_surface(1_024, 1_024);
        let map = test_map(Arc::clone(&surface));
        let mut cache = SurfaceTextureCache {
            map_key: format!("{}:{}:{}", map.source_id, surface.width, surface.height),
            frame: 1,
            ..SurfaceTextureCache::default()
        };
        for event in 0..500_u64 {
            cache.frame = event + 1;
            let chunk_x = (event % 4) as u32;
            let chunk_y = ((event / 4) % 4) as u32;
            let lod = (event % 7) as u8;
            let terrain_visible = event % 2 == 0;
            cache.queue_tile_job(
                &map,
                Arc::clone(&surface),
                chunk_x,
                chunk_y,
                lod,
                terrain_visible,
                (event % 3) as u8,
                Some(event),
            );
        }
        assert!(cache.pending_jobs.len() <= MAX_PENDING_TILE_JOBS);
        assert!(cache.active_job_keys.len() <= MAX_PENDING_TILE_JOBS);
    }

    #[test]
    fn async_tile_build_preserves_rendered_cell_values() {
        let surface = test_surface(256, 256);
        let map = test_map(surface);
        let request = test_request(&map, 0, 0, 0);
        let direct = build_tile_cpu(&request).expect("direct payload");
        eprintln!(
            "lod0_direct_tile canonical_requests={} worker_cpu_us={} sample_us={} color_us={}",
            direct.samples.cells_requested, direct.worker_cpu_us, direct.sample_us, direct.color_us,
        );
        let pool = TileWorkerPool::new();
        pool.requests.send(request).expect("queue");
        let asynchronous = pool
            .results
            .recv_timeout(Duration::from_secs(5))
            .expect("worker result")
            .outcome
            .expect("async payload");
        assert_eq!(direct.pixels, asynchronous.pixels);
        assert_eq!(
            direct.samples.cells_requested,
            asynchronous.samples.cells_requested
        );
        assert_eq!(direct.samples.cells_requested, 256 * 256);
    }

    #[test]
    fn async_tile_build_preserves_world_serialization() {
        let surface = test_surface(256, 256);
        let map = test_map(surface);
        let before = serde_json::to_vec(&map).expect("serialize before");
        let pool = TileWorkerPool::new();
        pool.requests
            .send(test_request(&map, 0, 0, 0))
            .expect("queue");
        let _ = pool
            .results
            .recv_timeout(Duration::from_secs(5))
            .expect("worker result");
        let after = serde_json::to_vec(&map).expect("serialize after");
        assert_eq!(before, after);
    }

    #[test]
    fn fallback_lod_remains_visible_while_tile_builds() {
        let surface = test_surface(256, 256);
        let map = test_map(surface);
        let mut cache = SurfaceTextureCache {
            map_key: "fallback-test".to_owned(),
            frame: 1,
            visible_keys: vec![SurfaceTileKey {
                lod: 0,
                index: 0,
                terrain_visible: true,
            }],
            ..SurfaceTextureCache::default()
        };
        cache.ensure_analysis_fallback(&Context::default(), &map, true);
        let draws = cache.draw_commands(Rect::from_min_size(
            Pos2::ZERO,
            eframe::egui::Vec2::new(map.width, map.height),
        ));
        assert_eq!(draws.len(), 1);
        assert_eq!(draws[0].world_rect.width(), map.width);
    }
}
