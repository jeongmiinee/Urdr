#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app;
mod calendar;
mod contour;
mod diagnostics;
mod dictionary;
mod document_schema;
mod environment;
mod generator;
mod geology;
mod heraldry;
mod ipa;
mod linguistics;
mod map_camera;
mod map_debug;
mod map_projection;
mod map_render_cache;
mod map_runtime;
mod model;
mod multiresolution_physics;
mod pass7_diagnostics;
mod pass8_diagnostics;
mod pipeline_diagnostics;
mod planet_config;
mod procedural;
mod projection;
mod reference_data;
mod regional_refinement;
mod render;
mod resources;
mod river_graph;
mod scripts;
mod shoreline;
mod spatial;
mod speech;
mod storage_v4;
mod subcell_hydrology;
mod surface_refinement;
mod terrain_diagnostics;
mod terrain_renderer;
mod theme;
mod u_fields;
mod wiki;

use app::UrdrApp;
use eframe::egui;
use map_render_cache::MapRenderCache;
use model::{Language, LoadedWorld};
use single_instance::SingleInstance;
use winit::{
    application::ApplicationHandler,
    event::{DeviceEvent, DeviceId, StartCause, WindowEvent},
    event_loop::{ActiveEventLoop, EventLoop},
    window::WindowId,
};

fn reconnect_showcase_map(mut world: LoadedWorld, mut generated: model::NativeMap) -> LoadedWorld {
    let previous = world.map.clone();
    generated.source_id = previous.source_id.clone();
    generated.title = previous.title.clone();
    generated.current_year = previous.current_year;

    let position_count = previous.locations.len()
        + previous.place_names.len()
        + previous.events.len()
        + previous.environment_pins.len();
    let generated_positions = distributed_showcase_positions(&generated, position_count);
    let mut positions = generated_positions.into_iter();
    if !previous.locations.is_empty() {
        generated.locations = previous
            .locations
            .iter()
            .map(|location| {
                let mut location = location.clone();
                if let Some(position) = positions.next() {
                    for state in &mut location.states {
                        state.position = position;
                    }
                }
                location.water_position_warning = false;
                location
            })
            .collect();
    }

    let generated_faction_ids = generated
        .factions
        .iter()
        .map(|faction| faction.id.clone())
        .collect::<Vec<_>>();
    if !previous.factions.is_empty() {
        for territory in &mut generated.territories {
            for state in &mut territory.states {
                let Some(owner) = state.owner_faction_id.as_ref() else {
                    continue;
                };
                let Some(index) = generated_faction_ids.iter().position(|id| id == owner) else {
                    continue;
                };
                state.owner_faction_id = Some(
                    previous.factions[index % previous.factions.len()]
                        .id
                        .clone(),
                );
            }
        }
        for owner in &mut generated.territory_owners {
            if *owner >= 0 {
                *owner = (*owner as usize % previous.factions.len()) as i32;
            }
        }
        for history in &mut generated.territory_history {
            for owner in &mut history.owners {
                if *owner >= 0 {
                    *owner = (*owner as usize % previous.factions.len()) as i32;
                }
            }
        }
        generated.factions = previous.factions.clone();
    }

    if !previous.place_names.is_empty() {
        generated.place_names = previous
            .place_names
            .iter()
            .map(|name| {
                let mut name = name.clone();
                if let Some(position) = positions.next() {
                    let delta_x = position.x - name.position.x;
                    let delta_y = position.y - name.position.y;
                    name.position = position;
                    for point in &mut name.path {
                        point.x = (point.x + delta_x).clamp(0.0, generated.width);
                        point.y = (point.y + delta_y).clamp(0.0, generated.height);
                    }
                }
                name
            })
            .collect();
    }
    generated.events = previous
        .events
        .iter()
        .map(|event| {
            let mut event = event.clone();
            if let Some(position) = positions.next() {
                event.location = Some(position);
            }
            event.water_position_warning = false;
            event
        })
        .collect();
    generated.environment_pins = previous
        .environment_pins
        .iter()
        .map(|pin| {
            let mut pin = pin.clone();
            if let Some(position) = positions.next() {
                pin.point = position;
            }
            pin
        })
        .collect();
    generated.rebuild_territory_owners(generated.current_year);
    world.map = generated.clone();
    world.maps.clear();
    world.factions = world.map.factions.clone();
    world.events = world.map.events.clone();
    world
}

fn distributed_showcase_positions(map: &model::NativeMap, count: usize) -> Vec<model::Point> {
    if count == 0 || map.grid_width == 0 || map.grid_height == 0 {
        return Vec::new();
    }
    let candidates = map
        .water
        .iter()
        .enumerate()
        .filter_map(|(index, water)| {
            if water != "land" {
                return None;
            }
            let point = model::Point {
                x: (index % map.grid_width) as f32 / map.grid_width as f32 * map.width
                    + map.width / map.grid_width as f32 * 0.5,
                y: (index / map.grid_width) as f32 / map.grid_height as f32 * map.height
                    + map.height / map.grid_height as f32 * 0.5,
            };
            (map.surface_sample_at_world(point).water == "land").then_some(point)
        })
        .collect::<Vec<_>>();
    if candidates.is_empty() {
        return Vec::new();
    }
    let desired = count.min(candidates.len());
    let mut minimum_distance = vec![f32::INFINITY; candidates.len()];
    let mut selected = vec![false; candidates.len()];
    let first = (map.environment_seed as usize).wrapping_mul(2_654_435_761) % candidates.len();
    let mut result = Vec::with_capacity(desired);
    let mut selected_index = first;
    for _ in 0..desired {
        selected[selected_index] = true;
        let point = candidates[selected_index];
        result.push(point);
        for (index, candidate) in candidates.iter().enumerate() {
            if selected[index] {
                continue;
            }
            let distance =
                ((candidate.x - point.x).powi(2) + (candidate.y - point.y).powi(2)).sqrt();
            minimum_distance[index] = minimum_distance[index].min(distance);
        }
        let mut next = None;
        for (index, candidate) in candidates.iter().enumerate() {
            if selected[index] {
                continue;
            }
            let edge = candidate
                .x
                .min(map.width - candidate.x)
                .min(candidate.y.min(map.height - candidate.y));
            let edge_weight =
                0.82 + 0.18 * (edge / map.width.min(map.height).max(0.1) * 4.0).clamp(0.0, 1.0);
            let score = minimum_distance[index] * edge_weight;
            if next.is_none_or(|(_, best): (usize, f32)| score > best) {
                next = Some((index, score));
            }
        }
        let Some((index, _)) = next else { break };
        selected_index = index;
    }
    result
}

fn write_native_demo(path: &std::path::Path, world: &LoadedWorld) -> Result<(), String> {
    use flate2::{Compression, write::GzEncoder};
    use std::io::Write;

    let file = std::fs::File::create(path).map_err(|error| error.to_string())?;
    let mut encoder = GzEncoder::new(file, Compression::best());
    serde_json::to_writer(&mut encoder, world).map_err(|error| error.to_string())?;
    encoder.flush().map_err(|error| error.to_string())?;
    encoder.finish().map_err(|error| error.to_string())?;
    Ok(())
}

fn regenerate_native_demos(output_root: &std::path::Path) -> Result<(), String> {
    std::fs::create_dir_all(output_root).map_err(|error| error.to_string())?;
    for (language, filename) in [
        (Language::Korean, "demoNativeWorld.json.gz"),
        (Language::English, "demoNativeWorld.en.json.gz"),
    ] {
        let legacy = LoadedWorld::load_legacy_demo(language)?;
        let settings = generator::MapGenerationSettings::default();
        let map = generator::generate_map(
            &settings,
            legacy.map.title.clone(),
            legacy.map.source_id.clone(),
            legacy.map.current_year,
            language,
        )?;
        let world = reconnect_showcase_map(legacy, map);
        let path = output_root.join(filename);
        write_native_demo(&path, &world)?;
        println!(
            "{}: seed={} physical={}x{}km canonical={}x{} cells categories={} articles={}",
            path.display(),
            world.map.environment_seed,
            world.map.width,
            world.map.height,
            world.map.logical_pixel_width,
            world.map.logical_pixel_height,
            world.categories.len(),
            world.articles.len(),
        );
    }
    Ok(())
}

fn diagnose_demo() {
    let started = std::time::Instant::now();
    let world = LoadedWorld::load_demo(Language::Korean).expect("bundled Korean demo must load");
    let loaded = started.elapsed();
    let mesh_started = std::time::Instant::now();
    let mut cache = MapRenderCache::build(&world.map, 0.72);
    let mesh_build = mesh_started.elapsed();
    let river_started = std::time::Instant::now();
    let fit_scale = (1_600.0_f32 / world.map.width)
        .min(800.0_f32 / world.map.height)
        .max(0.000_001);
    cache.ensure_river_mesh(&world.map, fit_scale);
    let river_build = river_started.elapsed();
    let cached_started = std::time::Instant::now();
    for _ in 0..10_000 {
        cache.ensure_river_mesh(&world.map, fit_scale);
    }
    let cached_checks = cached_started.elapsed();
    println!(
        "load_ms={} cache_ms={} river_ms={} cached_checks_us={} surface_cells={} territory_vertices={} territory_indices={} river_vertices={} river_indices={} static_rebuilds={} river_rebuilds={}",
        loaded.as_millis(),
        mesh_build.as_millis(),
        river_build.as_millis(),
        cached_checks.as_micros(),
        world.map.logical_pixel_dimensions().0 as u64
            * world.map.logical_pixel_dimensions().1 as u64,
        cache.territory_mesh.vertices.len(),
        cache.territory_mesh.indices.len(),
        cache.river_mesh.vertices.len(),
        cache.river_mesh.indices.len(),
        cache.stats().static_rebuilds,
        cache.stats().river_rebuilds,
    );
}

fn export_demo_bmp(path: &std::path::Path) -> Result<(), String> {
    use std::io::Write;

    let mut world = LoadedWorld::load_demo(Language::Korean)?;
    world.map.rebuild_canonical_surface();
    let surface = world
        .map
        .canonical_surface
        .as_ref()
        .ok_or_else(|| "canonical demo surface is unavailable".to_owned())?;
    let width = surface.width.min(1_600);
    let height =
        ((width as u64 * surface.height as u64 / surface.width.max(1) as u64) as u32).max(1);
    let row_bytes = (width * 3).div_ceil(4) * 4;
    let pixel_bytes = row_bytes as u64 * height as u64;
    let file_size = 54_u64 + pixel_bytes;
    let mut file = std::fs::File::create(path).map_err(|error| error.to_string())?;
    file.write_all(b"BM").map_err(|error| error.to_string())?;
    file.write_all(&(file_size as u32).to_le_bytes())
        .map_err(|error| error.to_string())?;
    file.write_all(&[0; 4]).map_err(|error| error.to_string())?;
    file.write_all(&54_u32.to_le_bytes())
        .map_err(|error| error.to_string())?;
    file.write_all(&40_u32.to_le_bytes())
        .map_err(|error| error.to_string())?;
    file.write_all(&(width as i32).to_le_bytes())
        .map_err(|error| error.to_string())?;
    file.write_all(&(height as i32).to_le_bytes())
        .map_err(|error| error.to_string())?;
    file.write_all(&1_u16.to_le_bytes())
        .map_err(|error| error.to_string())?;
    file.write_all(&24_u16.to_le_bytes())
        .map_err(|error| error.to_string())?;
    file.write_all(&0_u32.to_le_bytes())
        .map_err(|error| error.to_string())?;
    file.write_all(&(pixel_bytes as u32).to_le_bytes())
        .map_err(|error| error.to_string())?;
    file.write_all(&[0; 16])
        .map_err(|error| error.to_string())?;
    let padding = vec![0_u8; (row_bytes - width * 3) as usize];
    let mut row = Vec::with_capacity((width * 3) as usize);
    for y in (0..height as usize).rev() {
        row.clear();
        for x in 0..width as usize {
            let source_x = ((x as u64 * surface.width as u64) / width as u64) as usize;
            let source_y = ((y as u64 * surface.height as u64) / height as u64) as usize;
            let (_, terrain, water) = surface
                .encoded(source_x, source_y)
                .ok_or_else(|| "canonical surface cell is missing".to_owned())?;
            let name = if water == 1 {
                "saltwater"
            } else if water == 2 {
                "freshwater"
            } else {
                match terrain {
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
            };
            let color = render::surface_color(name);
            row.extend_from_slice(&[color.b(), color.g(), color.r()]);
        }
        file.write_all(&row).map_err(|error| error.to_string())?;
        file.write_all(&padding)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

struct UrdrEventLoopApp<'a> {
    inner: eframe::EframeWinitApplication<'a>,
}

impl ApplicationHandler<eframe::UserEvent> for UrdrEventLoopApp<'_> {
    fn new_events(&mut self, event_loop: &ActiveEventLoop, cause: StartCause) {
        self.inner.new_events(event_loop, cause);
    }

    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        self.inner.resumed(event_loop);
    }

    fn user_event(&mut self, event_loop: &ActiveEventLoop, event: eframe::UserEvent) {
        self.inner.user_event(event_loop, event);
    }

    fn window_event(
        &mut self,
        event_loop: &ActiveEventLoop,
        window_id: WindowId,
        event: WindowEvent,
    ) {
        let close_requested = matches!(event, WindowEvent::CloseRequested);
        self.inner.window_event(event_loop, window_id, event);
        if close_requested {
            diagnostics::event("application", "event_loop", "close_requested", &[]);
            event_loop.exit();
        }
    }

    fn device_event(
        &mut self,
        event_loop: &ActiveEventLoop,
        device_id: DeviceId,
        event: DeviceEvent,
    ) {
        self.inner.device_event(event_loop, device_id, event);
    }

    fn about_to_wait(&mut self, event_loop: &ActiveEventLoop) {
        self.inner.about_to_wait(event_loop);
    }

    fn suspended(&mut self, event_loop: &ActiveEventLoop) {
        self.inner.suspended(event_loop);
    }

    fn exiting(&mut self, event_loop: &ActiveEventLoop) {
        diagnostics::event("application", "event_loop", "exiting", &[]);
        self.inner.exiting(event_loop);
    }

    fn memory_warning(&mut self, event_loop: &ActiveEventLoop) {
        diagnostics::warning("application", "event_loop", "memory_warning", &[]);
        self.inner.memory_warning(event_loop);
    }
}

fn run_desktop() -> Result<(), String> {
    let mut wgpu_options = eframe::WgpuConfiguration::default();
    if let eframe::egui_wgpu::WgpuSetup::CreateNew(setup) = &mut wgpu_options.wgpu_setup {
        setup.instance_descriptor.backends =
            eframe::wgpu::Backends::VULKAN | eframe::wgpu::Backends::GL;
    }
    let options = eframe::NativeOptions {
        renderer: eframe::Renderer::Wgpu,
        wgpu_options,
        viewport: egui::ViewportBuilder::default()
            .with_title("URDR")
            .with_inner_size([1440.0, 900.0])
            .with_min_inner_size([1100.0, 680.0]),
        centered: true,
        ..Default::default()
    };
    let event_loop = EventLoop::<eframe::UserEvent>::with_user_event()
        .build()
        .map_err(|error| error.to_string())?;
    let inner = eframe::create_native(
        "URDR",
        options,
        Box::new(|context| Ok(Box::new(UrdrApp::new(context)))),
        &event_loop,
    );
    let mut application = UrdrEventLoopApp { inner };
    event_loop
        .run_app(&mut application)
        .map_err(|error| error.to_string())
}

fn main() {
    theme::enable_per_monitor_v2_dpi();
    let arguments = std::env::args().collect::<Vec<_>>();
    if let Some(index) = arguments
        .iter()
        .position(|argument| argument == "--regenerate-native-demos")
    {
        let output_root = arguments
            .get(index + 1)
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| {
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../..")
                    .join("public")
            });
        if let Err(error) = regenerate_native_demos(&output_root) {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return;
    }
    if let Some(index) = arguments
        .iter()
        .position(|argument| argument == "--export-demo-bmp")
    {
        let path = arguments
            .get(index + 1)
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| std::env::temp_dir().join("urdr-demo-surface.bmp"));
        if let Err(error) = export_demo_bmp(&path) {
            eprintln!("{error}");
            std::process::exit(1);
        }
        println!("{}", path.display());
        return;
    }
    if std::env::args().any(|argument| argument == "--diagnose-demo") {
        diagnose_demo();
        return;
    }
    let allow_multiple =
        cfg!(debug_assertions) || std::env::args().any(|argument| argument == "--allow-multiple");
    let instance = (!allow_multiple).then(|| {
        SingleInstance::new("Local\\URDR-native-wgpu-single-instance")
            .expect("single-instance lock must initialize")
    });
    if instance
        .as_ref()
        .is_some_and(|instance| !instance.is_single())
    {
        return;
    }
    let _ = diagnostics::initialize();
    diagnostics::event(
        "application",
        "desktop",
        "starting",
        &[("version", env!("CARGO_PKG_VERSION").to_owned())],
    );
    if let Err(error) = run_desktop() {
        diagnostics::error(
            "application",
            "desktop",
            "failed",
            &[("error", error.clone())],
        );
        let _ = std::fs::write(std::env::temp_dir().join("urdr-startup-error.log"), error);
    }
    diagnostics::event("application", "desktop", "stopped", &[]);
    diagnostics::shutdown();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn showcase_entities_receive_distinct_well_spaced_land_positions() {
        let world = LoadedWorld::load_demo(Language::English).expect("demo");
        let positions = distributed_showcase_positions(&world.map, 80);
        assert_eq!(positions.len(), 80);
        let unique = positions
            .iter()
            .map(|point| {
                (
                    (point.x * 10.0).round() as i32,
                    (point.y * 10.0).round() as i32,
                )
            })
            .collect::<std::collections::HashSet<_>>();
        assert_eq!(unique.len(), positions.len());
        let minimum = positions
            .iter()
            .enumerate()
            .flat_map(|(index, left)| {
                positions.iter().skip(index + 1).map(move |right| {
                    ((right.x - left.x).powi(2) + (right.y - left.y).powi(2)).sqrt()
                })
            })
            .fold(f32::INFINITY, f32::min);
        assert!(minimum > world.map.width.min(world.map.height) * 0.012);
        assert!(
            positions
                .iter()
                .all(|point| { world.map.surface_sample_at_world(*point).water == "land" })
        );
    }
}
