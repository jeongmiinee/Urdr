use eframe::egui::Rect;

use crate::model::{NativeMap, Point};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RuntimeTool {
    Pan,
    Terrain,
    Elevation,
    Territory,
    Road,
    Place,
    Event,
    PlaceName,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RuntimeCamera {
    pub center_x: f32,
    pub center_y: f32,
    pub half_height: f32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RuntimeReady {
    pub protocol_version: u32,
    pub snapshot_checksum: u64,
    pub cells: usize,
    pub shoreline_segments: usize,
    pub terrain_visible: bool,
    pub environment_visible: bool,
    pub first_frame_presented: bool,
    pub rendered_frames: u32,
}

#[allow(dead_code)]
#[derive(Debug)]
pub enum RuntimeEvent {
    Ready(RuntimeReady),
    Metrics {
        fps: f32,
        frame_ms: f32,
    },
    BrushPatch {
        tool: RuntimeTool,
        indices: Vec<usize>,
        value: f32,
    },
    Generated {
        seed: u32,
    },
    GeneratedSnapshot {
        seed: u32,
        grid_width: usize,
        grid_height: usize,
        world_width: f32,
        world_height: f32,
        sea_level: f32,
        elevation: Vec<f32>,
        surfaces: Vec<u8>,
    },
    Pointer {
        x: f32,
        y: f32,
        elevation: f32,
        zoom: f32,
        surface: u8,
    },
    CameraChanged(RuntimeCamera),
    CivilizationStroke {
        tool: RuntimeTool,
        points: Vec<Point>,
    },
    EditHistory {
        redo: bool,
    },
    EnvironmentPatch {
        tool: RuntimeTool,
        elevation_mode: u8,
        radius: f32,
        brush_value: f32,
        strength: f32,
        falloff: f32,
        terrain_noise: f32,
        values: Vec<(usize, f32)>,
    },
    Disconnected(String),
}

/// Compatibility boundary retained while the app transitions to direct WGPU map calls.
/// It owns no process, thread, window, socket, DLL, or graphics device.
pub struct NativeRuntimeBridge;

impl NativeRuntimeBridge {
    pub fn trace_lifecycle(message: impl AsRef<str>) {
        crate::diagnostics::event(
            "map_runtime",
            "native_wgpu",
            "lifecycle",
            &[("message", message.as_ref().to_owned())],
        );
    }

    pub fn available() -> Option<std::path::PathBuf> {
        None
    }

    pub fn launch(_map: &NativeMap) -> Result<Self, String> {
        Err("External map runtimes are disabled; the native WGPU renderer is active.".to_owned())
    }

    pub fn try_event(&self) -> Option<RuntimeEvent> {
        None
    }

    pub fn process_id(&self) -> u32 {
        std::process::id()
    }

    pub fn ready_matches(&self, _ready: RuntimeReady) -> bool {
        false
    }

    pub fn send_layers(
        &self,
        _rivers: bool,
        _roads: bool,
        _locations: bool,
        _environment: bool,
        _territories: bool,
        _english: bool,
    ) {
    }

    pub fn send_snapshot(&self, _map: &NativeMap) {}

    pub fn send_tool(
        &self,
        _tool: RuntimeTool,
        _radius: f32,
        _value: f32,
        _elevation_mode: u8,
        _strength: f32,
        _falloff: f32,
        _terrain_noise: f32,
    ) {
    }

    pub fn send_year(&self, _year: i32) {}

    pub fn send_camera(&self, _camera: RuntimeCamera) {}

    pub fn is_alive(&mut self) -> bool {
        false
    }

    pub fn set_bounds(&mut self, _rect: Rect, _pixels_per_point: f32, _visible: bool) -> bool {
        false
    }

    pub fn is_live_resizing(&self) -> bool {
        false
    }

    pub fn hide(&mut self) {}
}
