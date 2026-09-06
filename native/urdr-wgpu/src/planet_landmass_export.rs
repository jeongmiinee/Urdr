//! Explicit ignored exporter. All files are diagnostic artifacts, never saved-world fields.
use super::metrics::{Grid, covariance, measure};
use super::*;
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::Path;

const LAND: [u8; 3] = [199, 190, 148];
const WATER: [u8; 3] = [20, 43, 65];

fn write_json(path: impl AsRef<Path>, value: &impl Serialize) {
    serde_json::to_writer_pretty(BufWriter::new(File::create(path).unwrap()), value).unwrap();
}

fn write_png(path: impl AsRef<Path>, w: usize, h: usize, rgb: &[u8]) {
    let mut encoder = png::Encoder::new(
        BufWriter::new(File::create(path).unwrap()),
        w as u32,
        h as u32,
    );
    encoder.set_color(png::ColorType::Rgb);
    encoder.set_depth(png::BitDepth::Eight);
    encoder
        .write_header()
        .unwrap()
        .write_image_data(rgb)
        .unwrap();
}

fn color(id: usize) -> [u8; 3] {
    if id == usize::MAX {
        return WATER;
    }
    let hash = (id as u32 + 1).wrapping_mul(0x9e3779b9);
    [
        70 + (hash & 127) as u8,
        70 + ((hash >> 8) & 127) as u8,
        70 + ((hash >> 16) & 127) as u8,
    ]
}

fn signed(value: f64, scale: f64) -> [u8; 3] {
    let t = (value / scale).clamp(-1.0, 1.0);
    let base = [224.0, 222.0, 211.0];
    let end = if t >= 0.0 {
        [158.0, 48.0, 39.0]
    } else {
        [28.0, 70.0, 151.0]
    };
    std::array::from_fn(|i| (base[i] + (end[i] - base[i]) * t.abs()).round() as u8)
}

fn image_layer(grid: &Grid, path: impl AsRef<Path>, pixel: impl Fn(usize) -> [u8; 3]) {
    let rgb = (0..grid.count()).flat_map(pixel).collect::<Vec<_>>();
    write_png(path, grid.width, grid.height, &rgb);
}

fn write_components(
    path: &Path,
    config: &PlanetGenerationConfig,
    geology: &CausalGeologyModel,
    samples: &[Components],
    threshold: f32,
) {
    let (w, h) = PlanetSurface::dimensions_for_quality(config.quality);
    let mut out = BufWriter::new(File::create(path.join("components.csv")).unwrap());
    writeln!(out,"index,lat_deg,lon_deg,x,y,z,C,D,weighted_C,weighted_D,owner_plate_id,crust_type,raw_crust,weighted_K,B,weighted_B,raw_H,sea_threshold,relative_H,elevation_pre_round_m,elevation_stored_m,terrain,water_stored,water_raw,nearest_plate_id,second_plate_id,boundary_record_id,boundary_kind,boundary_metadata_used_in_H,owner_motion_used_in_H,boundary_distance_km").unwrap();
    for (i, s) in samples[..(w * h) as usize].iter().enumerate() {
        let (lat, lon) = s.position.latitude_longitude_deg();
        let [x, y, z] = s.position.components();
        let [c, d, k, b] = s.weighted(config);
        let raw = s.raw_h(config);
        let elevation = physical_elevation(raw, threshold, config);
        let stored = stored_elevation(raw, threshold, config);
        let first = &geology.plates[s.owner];
        let second = &geology.plates[s.second];
        let boundary = geology.boundaries.iter().find(|b| {
            (b.left_plate_id == first.id && b.right_plate_id == second.id)
                || (b.left_plate_id == second.id && b.right_plate_id == first.id)
        });
        let kind = boundary
            .map(|b| format!("{:?}", b.kind))
            .unwrap_or_default();
        writeln!(out,"{i},{lat},{lon},{x},{y},{z},{},{},{c},{d},{},{:?},{},{k},{},{b},{raw},{threshold},{},{elevation},{stored},{},{},{},{},{},{},{kind},false,false,{}",
            s.c,s.d,first.id,first.crust,s.crust,s.boundary,raw-threshold,replay_terrain(i,elevation,config),
            stored<=0,raw<=threshold,first.id,second.id,boundary.map(|b|b.id.as_str()).unwrap_or(""),s.boundary_distance_rad*config.physical.radius_m/1000.0).unwrap();
    }
    out.flush().unwrap();
}

fn baseline_images(
    path: &Path,
    grid: &Grid,
    samples: &[Components],
    config: &PlanetGenerationConfig,
    mask: &[bool],
    labels: &[usize],
) {
    image_layer(grid, path.join("baseline_landmask.png"), |i| {
        if mask[i] { LAND } else { WATER }
    });
    image_layer(grid, path.join("raw_H.png"), |i| {
        signed(samples[i].raw_h(config) as f64, 1.0)
    });
    image_layer(grid, path.join("C.png"), |i| signed(samples[i].c, 1.0));
    image_layer(grid, path.join("D.png"), |i| signed(samples[i].d, 1.0));
    image_layer(grid, path.join("crust_owner.png"), |i| {
        color(samples[i].owner)
    });
    image_layer(grid, path.join("K.png"), |i| {
        signed(samples[i].crust * 0.28, 0.2)
    });
    image_layer(grid, path.join("B.png"), |i| {
        signed(samples[i].boundary, 1.0)
    });
    image_layer(grid, path.join("component_ID.png"), |i| color(labels[i]));
    let mut boundaries = vec![false; grid.count()];
    let mut coasts = vec![false; grid.count()];
    for &(i, j, _) in &grid.arcs {
        if samples[i].owner != samples[j].owner {
            boundaries[i] = true;
            boundaries[j] = true;
        }
        if mask[i] != mask[j] {
            coasts[i] = true;
            coasts[j] = true;
        }
    }
    image_layer(grid, path.join("plate_boundary_overlay.png"), |i| {
        if coasts[i] {
            [250, 245, 215]
        } else if boundaries[i] {
            [0, 210, 210]
        } else if mask[i] {
            [95, 100, 74]
        } else {
            WATER
        }
    });
    image_layer(grid, path.join("coast_to_boundary_overlay.png"), |i| {
        if coasts[i] {
            let t = (samples[i].boundary_distance_rad * grid.radius_km / 1000.0).clamp(0.0, 1.0);
            [(250.0 * t) as u8, (240.0 * (1.0 - t)) as u8, 40]
        } else if boundaries[i] {
            [80, 130, 155]
        } else if mask[i] {
            [60, 63, 55]
        } else {
            [16, 27, 39]
        }
    });
    // Orthographic polar views of the same raster, no re-evaluation/rescaling.
    for north in [true, false] {
        let size = 512;
        let rgb = (0..size * size)
            .flat_map(|i| {
                let px = 2.0 * (i % size) as f64 / (size - 1) as f64 - 1.0;
                let py = 2.0 * (i / size) as f64 / (size - 1) as f64 - 1.0;
                let rho = (px * px + py * py).sqrt();
                if rho > 1.0 {
                    return [10, 16, 24];
                }
                let lat = (1.0 - rho * rho).sqrt().asin() * if north { 1.0 } else { -1.0 };
                let lon = py.atan2(px);
                let x = ((lon + PI) / TAU * grid.width as f64).floor() as usize % grid.width;
                let y = ((FRAC_PI_2 - lat) / PI * grid.height as f64)
                    .floor()
                    .min((grid.height - 1) as f64) as usize;
                if mask[y * grid.width + x] {
                    LAND
                } else {
                    WATER
                }
            })
            .collect::<Vec<_>>();
        write_png(
            path.join(if north {
                "north_polar.png"
            } else {
                "south_polar.png"
            }),
            size,
            size,
            &rgb,
        );
    }
}

struct Variant {
    name: String,
    config: PlanetGenerationConfig,
    samples: Vec<Components>,
    raw: Vec<f32>,
    target: f64,
}

fn variants(config: &PlanetGenerationConfig, samples: &[Components]) -> Vec<Variant> {
    let mut variants = Vec::new();
    for name in [
        "ALL", "C_only", "D_only", "K_only", "K_plus_B", "no_K", "no_B", "no_D",
    ] {
        let raw = samples
            .iter()
            .map(|&s| {
                let [c, d, k, b] = s.weighted(config);
                (match name {
                    "ALL" => c + d + k + b,
                    "C_only" => c,
                    "D_only" => d,
                    "K_only" => k,
                    "K_plus_B" => k + b,
                    "no_K" => c + d + b,
                    "no_B" => c + d + k,
                    "no_D" => c + k + b,
                    _ => unreachable!(),
                }) as f32
            })
            .collect();
        variants.push(Variant {
            name: name.into(),
            config: config.clone(),
            samples: samples.to_vec(),
            raw,
            target: 0.71,
        });
    }
    for f in [0.0, 0.25, 0.55, 0.75, 1.0] {
        let mut changed = config.clone();
        changed.tectonics.continental_fragmentation = f;
        let raw = samples.iter().map(|s| s.raw_h(&changed)).collect();
        variants.push(Variant {
            name: format!("F_{f:.2}"),
            config: changed,
            samples: samples.to_vec(),
            raw,
            target: 0.71,
        });
    }
    let original_geology = geology_for(config);
    for fraction in [0.0, 0.2, 0.43, 0.7, 1.0] {
        let mut changed = config.clone();
        changed.tectonics.continental_crust_fraction = fraction;
        let geology = geology_for(&changed);
        for (a, b) in geology.plates.iter().zip(&original_geology.plates) {
            assert_eq!(a.center, b.center);
            assert_eq!(a.id, b.id);
        }
        let observed = samples
            .iter()
            .map(|s| {
                let (crust, boundary) = fast_geology_influence(&geology, s.position);
                assert_eq!(boundary, s.boundary);
                Components {
                    crust,
                    boundary,
                    ..*s
                }
            })
            .collect::<Vec<_>>();
        let raw = observed.iter().map(|s| s.raw_h(&changed)).collect();
        variants.push(Variant {
            name: format!("crust_fraction_{fraction:.2}"),
            config: changed,
            samples: observed,
            raw,
            target: 0.71,
        });
    }
    for q in [0.5, 0.6, 0.71, 0.8, 0.9] {
        let mut changed = config.clone();
        changed.hydrosphere.target_ocean_coverage = Some(q);
        variants.push(Variant {
            name: format!("q_{q:.2}"),
            config: changed,
            samples: samples.to_vec(),
            raw: samples.iter().map(|s| s.raw_h(config)).collect(),
            target: q,
        });
    }
    variants
}

fn sampling_diagnostics(
    config: &PlanetGenerationConfig,
    geology: &CausalGeologyModel,
    surface: &PlanetSurface,
) -> Value {
    let mut seam_max = 0.0_f64;
    let mut sample_seam_max = 0.0_f64;
    for y in 0..256 {
        let lat = 90.0 - (y as f64 + 0.5) / 256.0 * 180.0;
        let a = PlanetPosition::from_latitude_longitude_deg(lat, -180.0);
        let b = PlanetPosition::from_latitude_longitude_deg(lat, 180.0);
        seam_max = seam_max.max(
            (observe_point(config, geology, a).raw_h(config) as f64
                - observe_point(config, geology, b).raw_h(config) as f64)
                .abs(),
        );
        sample_seam_max = sample_seam_max.max(
            (surface.sample_interpolated(a).elevation_m
                - surface.sample_interpolated(b).elevation_m)
                .abs() as f64,
        );
    }
    let mut poles = Vec::new();
    for lat in [90.0, 89.999, 89.9, -89.9, -89.999, -90.0] {
        let mut raw_min = f64::INFINITY;
        let mut raw_max = f64::NEG_INFINITY;
        let mut sample_min = f32::INFINITY;
        let mut sample_max = f32::NEG_INFINITY;
        for x in 0..360 {
            let p = PlanetPosition::from_latitude_longitude_deg(lat, x as f64 - 180.0);
            let raw = observe_point(config, geology, p).raw_h(config) as f64;
            let sample = surface.sample_interpolated(p).elevation_m;
            raw_min = raw_min.min(raw);
            raw_max = raw_max.max(raw);
            sample_min = sample_min.min(sample);
            sample_max = sample_max.max(sample);
        }
        poles.push(json!({"latitude_deg":lat,"raw_H_longitude_range":raw_max-raw_min,"sample_interpolated_elevation_range_m":sample_max-sample_min}));
    }
    json!({"same_position_seam_raw_H_max_delta":seam_max,"same_position_seam_sample_elevation_max_delta_m":sample_seam_max,"poles":poles})
}

#[test]
fn planet_landmass_worker_count_and_ablation_controls() {
    let config = &fixtures()[2];
    let geology = geology_for(config);
    let mut outputs = Vec::new();
    for threads in [1, 2] {
        outputs.push(
            rayon::ThreadPoolBuilder::new()
                .num_threads(threads)
                .build()
                .unwrap()
                .install(|| PlanetSurface::generate(config, &geology)),
        );
    }
    assert_eq!(outputs[0], outputs[1]);
    let samples = (0..202)
        .map(|i| observe_point(config, &geology, grid_position(i, 20, 10)))
        .collect::<Vec<_>>();
    let variants = variants(config, &samples);
    let original = &variants[0].raw;
    for variant in &variants {
        if variant.name.starts_with("q_")
            || ["F_0.55", "crust_fraction_0.43"].contains(&variant.name.as_str())
        {
            assert_eq!(&variant.raw, original);
        }
    }
}

#[test]
#[ignore = "writes full six-seed Planet landmass diagnostics; run explicitly"]
fn planet_landmass_export() {
    // Fail closed BEFORE evaluating any ablation or writing experiment results.
    let preserved = preservation();
    let root = std::env::var_os("URDR_LANDMASS_OUTPUT")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../outputs/URDR-4.4-Planet-Landmass")
        });
    assert!(
        !root.exists(),
        "export path already exists; choose a new URDR_LANDMASS_OUTPUT to preserve prior evidence"
    );
    fs::create_dir_all(&root).unwrap();
    write_json(root.join("preservation.json"), &preserved);
    let started = Instant::now();
    let configs = fixtures();
    assert_eq!(configs.iter().map(|c| c.seed).collect::<Vec<_>>(), SEEDS);
    let mut all_metrics = Vec::new();
    for config in configs {
        let seed_started = Instant::now();
        let path = root.join(format!("EarthLike_{}", config.seed));
        fs::create_dir_all(&path).unwrap();
        let geology = geology_for(&config);
        let surface = PlanetSurface::generate(&config, &geology);
        let samples = observe(&config, &geology);
        let grid = Grid::new(
            surface.width as usize,
            surface.height as usize,
            config.physical.radius_m / 1000.0,
        );
        let raw = samples.iter().map(|s| s.raw_h(&config)).collect::<Vec<_>>();
        let threshold = quantile(&raw[..grid.count()], 0.71);
        let mask = raw
            .iter()
            .map(|&v| stored_elevation(v, threshold, &config) > 0)
            .collect::<Vec<_>>();
        write_components(&path, &config, &geology, &samples, threshold);
        write_json(path.join("config.json"), &config);
        write_json(path.join("geology.json"), &geology);
        write_json(
            path.join("covariance.json"),
            &covariance(&grid, &samples, &config),
        );
        write_json(
            path.join("sampling.json"),
            &sampling_diagnostics(&config, &geology, &surface),
        );
        write_json(
            path.join("metadata.json"),
            &json!({
                "profile":"EarthLike full fixed config; preset_source is provenance only",
                "width":grid.width,"height":grid.height,"radius_km":grid.radius_km,"projection":"equirectangular cell centers; north-up",
                "raw_layout":"little-endian f32 row-major H then north/south exact pole probes; quantile excludes poles",
                "mask_layout":"u8 1=land stored elevation > 0; row-major plus two poles",
                "components_csv":"N raster rows; f64/f32 shortest round-trip decimal; plate motion in geology.json joined by ID",
                "threshold_bits":threshold.to_bits(),"threshold":threshold,
                "quantile":"floor((N-1)*clamp(q,.02,.98)); all ties retained; water uses rounded i16 <= 0",
                "subseeds":{"continent":config.stable_subseed("planet-continent"),"detail":config.stable_subseed("planet-surface-detail"),"geology":config.stable_subseed("geology"),"climate":config.stable_subseed("planet-climate")},
                "color_ranges":{"C":[-1,1],"D":[-1,1],"raw_H":[-1,1],"K":[-0.2,0.2],"B":[0,1],"coast_to_boundary_km":[0,1000]},
                "boundary_metadata_used_in_H":false,"plate_motion_used_in_H":false,
                "morphology":"4-neighbor sphere graph with exact pole probes; deterministic triangle diagonal count also reported; rectilinear spherical arc perimeter",
                "widths_km":[160,320,640],"peninsula":"opening residual reach/width proxy, not skeleton extraction",
                "scope":"diagnostic-only, not a new recipe or persisted schema",
            }),
        );
        for variant in variants(&config, &samples) {
            let vpath = path.join(&variant.name);
            fs::create_dir_all(&vpath).unwrap();
            fs::write(
                vpath.join("raw_H.f32le"),
                variant
                    .raw
                    .iter()
                    .flat_map(|v| v.to_le_bytes())
                    .collect::<Vec<_>>(),
            )
            .unwrap();
            write_json(vpath.join("config.json"), &variant.config);
            for mode in ["fixed", "requantile"] {
                let sea = if mode == "fixed" {
                    threshold
                } else {
                    quantile(&variant.raw[..grid.count()], variant.target)
                };
                let variant_mask = variant
                    .raw
                    .iter()
                    .map(|&v| stored_elevation(v, sea, &variant.config) > 0)
                    .collect::<Vec<_>>();
                let (metrics, labels) = measure(&grid, &variant_mask, &mask, &variant.samples);
                if variant.name == "ALL" && mode == "fixed" {
                    baseline_images(&path, &grid, &samples, &config, &mask, &labels);
                }
                image_layer(&grid, vpath.join(format!("{mode}_landmask.png")), |i| {
                    if variant_mask[i] { LAND } else { WATER }
                });
                fs::write(
                    vpath.join(format!("{mode}_landmask.u8")),
                    variant_mask
                        .iter()
                        .map(|&v| u8::from(v))
                        .collect::<Vec<_>>(),
                )
                .unwrap();
                let record = json!({"seed":config.seed,"profile":"EarthLike","variant":variant.name,"mode":mode,
                    "requested_quantile":variant.target,"threshold":sea,"threshold_bits":sea.to_bits(),
                    "raw_H_checksum":checksum(variant.raw[..grid.count()].iter().flat_map(|v|v.to_le_bytes())),
                    "raw_ocean_cell_fraction":variant.raw[..grid.count()].iter().filter(|&&v|v<=sea).count() as f64/grid.count() as f64,
                    "threshold_tie_cells":variant.raw[..grid.count()].iter().filter(|&&v|v==sea).count(),
                    "rounded_zero_from_positive_cells":variant.raw[..grid.count()].iter().filter(|&&v|v>sea&&stored_elevation(v,sea,&variant.config)==0).count(),
                    "target_cell_coverage_error":metrics["ocean_unweighted"].as_f64().unwrap()-variant.target,
                    "metrics":metrics});
                write_json(vpath.join(format!("{mode}_metrics.json")), &record);
                all_metrics.push(record);
            }
        }
        println!(
            "Planet diagnostics seed {} complete: {:.2}s",
            config.seed,
            seed_started.elapsed().as_secs_f64()
        );
    }
    write_json(root.join("metrics.json"), &all_metrics);
    write_json(
        root.join("run.json"),
        &json!({"seeds":SEEDS,"profile":"EarthLike","records":all_metrics.len(),"elapsed_seconds":started.elapsed().as_secs_f64(),"rayon_workers":rayon::current_num_threads(),"source_baseline":"9573df2e0ca4c51f55e3ac73a8bc71402f856fcd","output_preservation":"PASS"}),
    );
    println!("Planet diagnostics complete: {}", root.display());
}
