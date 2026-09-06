//! Observation/replay of the legacy Planet field, compiled only by `cargo test`.
//! Never use this module as physical authority. See docs/PLANET_LANDMASS_DIAGNOSTICS.md.

use super::*;
use serde_json::{Value, json};
use std::f64::consts::{FRAC_PI_2, PI, TAU};

#[path = "planet_landmass_export.rs"]
mod export;
#[path = "planet_landmass_metrics.rs"]
mod metrics;

const SEEDS: [u64; 6] = [0, 1, 42, 44, 990_500_051, 20_260_906];

#[derive(Clone, Copy)]
struct Components {
    position: PlanetPosition,
    c: f64,
    d: f64,
    crust: f64,
    boundary: f64,
    owner: usize,
    second: usize,
    boundary_distance_rad: f64,
}

impl Components {
    fn weighted(self, config: &PlanetGenerationConfig) -> [f64; 4] {
        [
            self.c * 0.72,
            self.d * (0.10 + config.tectonics.continental_fragmentation.clamp(0.0, 1.0) * 0.20),
            self.crust * 0.28,
            self.boundary * (0.05 + config.tectonics.orogenic_activity.clamp(0.0, 1.0) * 0.20),
        ]
    }

    fn raw_h(self, config: &PlanetGenerationConfig) -> f32 {
        let [c, d, k, b] = self.weighted(config);
        (c + d + k + b) as f32
    }
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn observe_point(
    config: &PlanetGenerationConfig,
    geology: &CausalGeologyModel,
    position: PlanetPosition,
) -> Components {
    assert!(
        geology.plates.len() >= 2,
        "diagnostics require at least two plates"
    );
    let [x, y, z] = position.components();
    let mut order = (0..geology.plates.len()).collect::<Vec<_>>();
    order.sort_by(|&a, &b| {
        dot(position.components(), geology.plates[b].center.components())
            .total_cmp(&dot(
                position.components(),
                geology.plates[a].center.components(),
            ))
            .then(a.cmp(&b))
    });
    let owner = order[0];
    let center = geology.plates[owner].center.components();
    // Spherical distance to the nearest supporting bisector of the owner's
    // convex spherical Voronoi cell. All competitors, not just the runner-up.
    let boundary_distance_rad = order[1..]
        .iter()
        .map(|&j| {
            let other = geology.plates[j].center.components();
            let normal = [
                center[0] - other[0],
                center[1] - other[1],
                center[2] - other[2],
            ];
            (dot(position.components(), normal).abs() / dot(normal, normal).sqrt())
                .clamp(0.0, 1.0)
                .asin()
        })
        .fold(f64::INFINITY, f64::min);
    let (crust, boundary) = fast_geology_influence(geology, position);
    Components {
        position,
        c: spherical_fbm(config.stable_subseed("planet-continent"), x, y, z, 1.15, 5),
        d: spherical_fbm(
            config.stable_subseed("planet-surface-detail"),
            x,
            y,
            z,
            3.8,
            4,
        ),
        crust,
        boundary,
        owner,
        second: order[1],
        boundary_distance_rad,
    }
}

fn grid_position(index: usize, width: usize, height: usize) -> PlanetPosition {
    if index >= width * height {
        return PlanetPosition::new(0.0, 0.0, if index == width * height { 1.0 } else { -1.0 })
            .unwrap();
    }
    // Use exactly the production arithmetic grouping for both coordinates.
    let latitude = FRAC_PI_2 - ((index / width) as f64 + 0.5) / height as f64 * PI;
    let longitude = ((index % width) as f64 + 0.5) / width as f64 * TAU - PI;
    PlanetPosition::from_latitude_longitude_rad(latitude, longitude)
}

fn observe(config: &PlanetGenerationConfig, geology: &CausalGeologyModel) -> Vec<Components> {
    let (w, h) = PlanetSurface::dimensions_for_quality(config.quality);
    (0..w as usize * h as usize + 2)
        .into_par_iter()
        .map(|i| observe_point(config, geology, grid_position(i, w as usize, h as usize)))
        .collect()
}

fn geology_for(config: &PlanetGenerationConfig) -> CausalGeologyModel {
    CausalGeologyModel::synthesize_with_controls(
        config.stable_subseed("geology"),
        &config.tectonics,
        &config.geology,
    )
}

fn quantile(raw: &[f32], coverage: f64) -> f32 {
    let mut sorted = raw.to_vec();
    sorted.par_sort_unstable_by(f32::total_cmp);
    sorted[((sorted.len() - 1) as f64 * coverage.clamp(0.02, 0.98)) as usize]
}

fn physical_elevation(raw: f32, threshold: f32, config: &PlanetGenerationConfig) -> f32 {
    let relative = raw - threshold;
    let max_land =
        (4_500.0 + config.tectonics.orogenic_activity as f32 * 5_000.0).clamp(2_500.0, 10_000.0);
    if relative >= 0.0 {
        (relative / (0.42 + relative.abs())).powf(1.18) * max_land
    } else {
        -(relative.abs() / (0.38 + relative.abs())).powf(1.12) * 8_500.0
    }
}

fn stored_elevation(raw: f32, threshold: f32, config: &PlanetGenerationConfig) -> i16 {
    physical_elevation(raw, threshold, config)
        .round()
        .clamp(-12_000.0, 12_000.0) as i16
}

fn replay_terrain(index: usize, elevation: f32, config: &PlanetGenerationConfig) -> u8 {
    let (width, height) = PlanetSurface::dimensions_for_quality(config.quality);
    let latitude = 90.0 - ((index as u32 / width) as f32 + 0.5) / height as f32 * 180.0;
    let longitude = (f64::from(index as u32 % width) + 0.5) / f64::from(width) * TAU - PI;
    let [x, y, z] =
        PlanetPosition::from_latitude_longitude_deg(f64::from(latitude), longitude.to_degrees())
            .components();
    let climate = spherical_fbm(config.stable_subseed("planet-climate"), x, y, z, 2.4, 4) as f32;
    let temperature = config.derived_summary().mean_surface_temperature_c as f32
        - latitude.abs() * 0.34
        - elevation.max(0.0) * 0.0062
        + climate * 5.5;
    let wetness = (config.surface.moisture_bias as f32
        + climate * 0.24
        + if elevation < 0.0 { 0.35 } else { 0.0 }
        - latitude.abs() / 90.0 * 0.10)
        .clamp(0.0, 1.0);
    classify_planet_terrain(elevation, temperature, wetness)
}

// Fixed FNV-1a byte order, not Rust's unspecified DefaultHasher.
fn checksum(bytes: impl IntoIterator<Item = u8>) -> String {
    let hash = bytes
        .into_iter()
        .fold(0xcbf2_9ce4_8422_2325_u64, |hash, byte| {
            (hash ^ u64::from(byte)).wrapping_mul(0x100_0000_01b3)
        });
    format!("{hash:016x}")
}

fn fixtures() -> Vec<PlanetGenerationConfig> {
    serde_json::from_str(include_str!(
        "../tests/fixtures/planet_landmass_earthlike.json"
    ))
    .unwrap()
}

fn expected() -> Value {
    serde_json::from_str(include_str!(
        "../tests/fixtures/planet_landmass_legacy_checksums.json"
    ))
    .unwrap()
}

fn preservation() -> Value {
    let expected = expected();
    let mut results = Vec::new();
    for config in fixtures() {
        let geology = geology_for(&config);
        let before = PlanetSurface::generate(&config, &geology);
        let samples = observe(&config, &geology);
        let count = before.width as usize * before.height as usize;
        let raw = samples[..count]
            .iter()
            .map(|s| s.raw_h(&config))
            .collect::<Vec<_>>();
        let threshold = quantile(&raw, config.hydrosphere.target_ocean_coverage.unwrap());
        let after = PlanetSurface::generate(&config, &geology);
        assert_eq!(
            before, after,
            "observer mutated production, seed {}",
            config.seed
        );
        for (i, &raw) in raw.iter().enumerate() {
            let elevation = physical_elevation(raw, threshold, &config);
            assert_eq!(
                stored_elevation(raw, threshold, &config),
                before.elevation_m[i]
            );
            assert_eq!(replay_terrain(i, elevation, &config), before.terrain[i]);
            assert_eq!(
                before
                    .sample_xy(i as u32 % before.width, i as u32 / before.width)
                    .water,
                stored_elevation(raw, threshold, &config) <= 0
            );
        }
        let actual = json!({
            "seed": config.seed,
            "threshold_bits": threshold.to_bits(),
            "raw_h": checksum(raw.iter().flat_map(|v| v.to_le_bytes())),
            "elevation": checksum(before.elevation_m.iter().flat_map(|v| v.to_le_bytes())),
            "terrain": checksum(before.terrain.iter().copied()),
            "water": checksum(before.elevation_m.iter().map(|v| u8::from(*v <= 0))),
        });
        assert_eq!(
            actual,
            expected[config.seed.to_string()],
            "legacy mismatch seed {}",
            config.seed
        );
        results.push(actual);
    }
    json!({"status":"PASS", "original_commit":"9573df2e0ca4c51f55e3ac73a8bc71402f856fcd", "fixtures":results})
}

#[test]
fn planet_landmass_output_preservation() {
    preservation();
}

#[test]
fn planet_landmass_legacy_quantile_keeps_ties_and_rounding() {
    assert_eq!(quantile(&[-1.0, -1.0, 1.0, 1.0], 0.71), 1.0);
    let config = &fixtures()[0];
    assert!(physical_elevation(0.00001, 0.0, config) > 0.0);
    assert_eq!(stored_elevation(0.00001, 0.0, config), 0);
}

#[test]
fn planet_landmass_components_ignore_boundary_metadata() {
    let config = &fixtures()[2];
    let geology = geology_for(config);
    let mut changed = geology.clone();
    for boundary in &mut changed.boundaries {
        boundary.kind = crate::geology::PlateBoundaryKind::Transform;
        boundary.convergence_mm_per_year = -99.0;
        boundary.maturity = 0.0;
    }
    for plate in &mut changed.plates {
        plate.angular_speed_deg_per_myr *= -10.0;
        plate.crust_thickness_km *= 3.0;
    }
    for i in 0..200 {
        let point = grid_position(i, 20, 10);
        let a = observe_point(config, &geology, point);
        let b = observe_point(config, &changed, point);
        assert_eq!(a.raw_h(config).to_bits(), b.raw_h(config).to_bits());
        assert!((0.0..=1.0).contains(&a.boundary));
    }
    // Approach an actual mixed-crust Voronoi boundary from both sides.
    // Continuous C/D/B tend to the same value, but the production fast helper's
    // categorical K retains its jump.
    let mut pair = geology.clone();
    pair.plates.truncate(2);
    pair.plates[0].center = PlanetPosition::new(-1.0, 0.0, 0.0).unwrap();
    pair.plates[0].crust = CrustType::Continental;
    pair.plates[1].center = PlanetPosition::new(1.0, 0.0, 0.0).unwrap();
    pair.plates[1].crust = CrustType::Oceanic;
    let left = observe_point(
        config,
        &pair,
        PlanetPosition::new(-1e-10, 1.0, 0.0).unwrap(),
    );
    let right = observe_point(config, &pair, PlanetPosition::new(1e-10, 1.0, 0.0).unwrap());
    assert!((left.raw_h(config) as f64 - right.raw_h(config) as f64 - 0.308).abs() < 1e-6);
}
