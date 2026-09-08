//! Test-only audit of the production Legacy Planet field. No physical authority.
use super::*;
use metrics::Grid;
use std::fs;
use std::path::Path;
use std::time::Instant;

const MODES: [&str; 4] = [
    "original",
    "plates_rotated",
    "noise_rotated",
    "both_rotated",
];
const CAP_LAT: [f64; 3] = [60.0, 75.0, 85.0];
const REPRESENTATIVES: [u64; 4] = [0, 42, 990_500_051, 20_260_906];

#[derive(Clone, Copy, Debug)]
struct Rotation([f64; 4]);
impl Rotation {
    fn from_seed(seed: u64, tag: u64) -> Self {
        let mut state = seed ^ tag;
        let u = std::array::from_fn::<_, 3, _>(|_| uniform(&mut state));
        Self([
            (1.0 - u[0]).sqrt() * (TAU * u[1]).sin(),
            (1.0 - u[0]).sqrt() * (TAU * u[1]).cos(),
            u[0].sqrt() * (TAU * u[2]).sin(),
            u[0].sqrt() * (TAU * u[2]).cos(),
        ])
    }
    fn inverse(self) -> Self {
        Self([-self.0[0], -self.0[1], -self.0[2], self.0[3]])
    }
    fn apply(self, p: [f64; 3]) -> [f64; 3] {
        let q = [self.0[0], self.0[1], self.0[2]];
        let t = cross(q, p).map(|x| x * 2.0);
        let c = cross(q, t);
        std::array::from_fn(|j| p[j] + self.0[3] * t[j] + c[j])
    }
    fn position(self, p: PlanetPosition) -> PlanetPosition {
        let v = self.apply(p.components());
        PlanetPosition::new(v[0], v[1], v[2]).unwrap()
    }
}
fn uniform(state: &mut u64) -> f64 {
    *state = state.wrapping_add(0x9e37_79b9_7f4a_7c15);
    let mut x = *state;
    x = (x ^ (x >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    x = (x ^ (x >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    ((x ^ (x >> 31)) >> 11) as f64 / (1_u64 << 53) as f64
}
fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}
fn rotated(geo: &CausalGeologyModel, r: Rotation) -> (CausalGeologyModel, f64) {
    let mut result = geo.clone();
    for p in &mut result.plates {
        p.center = r.position(p.center);
        p.euler_pole = r.position(p.euler_pole);
    }
    let mut error = 0.0_f64;
    for (i, a) in geo.plates.iter().enumerate() {
        for (j, b) in geo.plates.iter().enumerate() {
            for (x, y, u, v) in [
                (
                    a.center,
                    b.center,
                    result.plates[i].center,
                    result.plates[j].center,
                ),
                (
                    a.euler_pole,
                    b.euler_pole,
                    result.plates[i].euler_pole,
                    result.plates[j].euler_pole,
                ),
                (
                    a.center,
                    b.euler_pole,
                    result.plates[i].center,
                    result.plates[j].euler_pole,
                ),
            ] {
                error = error.max(
                    (dot(x.components(), y.components()) - dot(u.components(), v.components()))
                        .abs(),
                );
            }
        }
    }
    let mut unchanged = result.clone();
    for (p, original) in unchanged.plates.iter_mut().zip(&geo.plates) {
        p.center = original.center;
        p.euler_pole = original.euler_pole;
    }
    assert_eq!(&unchanged, geo);
    assert!(error < 3e-14);
    (result, error)
}
fn config_for(seed: u64) -> PlanetGenerationConfig {
    PlanetGenerationConfig {
        seed,
        quality: GenerationQuality::Draft,
        ..PlanetGenerationConfig::default()
    }
}
fn noise(config: &PlanetGenerationConfig, p: [f64; 3]) -> [f64; 2] {
    [
        spherical_fbm(
            config.stable_subseed("planet-continent"),
            p[0],
            p[1],
            p[2],
            1.15,
            5,
        ),
        spherical_fbm(
            config.stable_subseed("planet-surface-detail"),
            p[0],
            p[1],
            p[2],
            3.8,
            4,
        ),
    ]
}
fn height(config: &PlanetGenerationConfig, n: [f64; 2], g: (f64, f64)) -> f32 {
    (n[0] * 0.72
        + n[1] * (0.10 + config.tectonics.continental_fragmentation.clamp(0.0, 1.0) * 0.20)
        + g.0 * 0.28
        + g.1 * (0.05 + config.tectonics.orogenic_activity.clamp(0.0, 1.0) * 0.20)) as f32
}
fn owner(geo: &CausalGeologyModel, p: PlanetPosition) -> usize {
    let mut best = (f64::NEG_INFINITY, 0);
    for (i, plate) in geo.plates.iter().enumerate() {
        let d = dot(p.components(), plate.center.components());
        if d > best.0 {
            best = (d, i);
        }
    }
    best.1
}
fn write_json(path: impl AsRef<Path>, value: &Value) {
    fs::write(path, serde_json::to_vec_pretty(value).unwrap()).unwrap();
}
fn raster_index(p: [f64; 3], w: usize, h: usize) -> usize {
    let x =
        (((p[1].atan2(p[0]) + PI) / TAU * w as f64).floor() as i64).rem_euclid(w as i64) as usize;
    let y = (((FRAC_PI_2 - p[2].clamp(-1.0, 1.0).asin()) / PI * h as f64).floor() as i64)
        .clamp(0, h as i64 - 1) as usize;
    y * w + x
}
fn cap_axes(seed: u64) -> Vec<[f64; 3]> {
    let mut state = seed ^ 0x6178_6961_6c63_6170;
    let mut axes = Vec::new();
    for _ in 0..16 {
        let z = 2.0 * uniform(&mut state) - 1.0;
        let a = TAU * uniform(&mut state);
        let r = (1.0 - z * z).sqrt();
        let p = [r * a.cos(), r * a.sin(), z];
        axes.push(p);
        axes.push(p.map(|x| -x));
    }
    axes.extend([
        [1., 0., 0.],
        [-1., 0., 0.],
        [0., 1., 0.],
        [0., -1., 0.],
        [0., 0., 1.],
        [0., 0., -1.],
    ]);
    axes
}
fn cap_indices(axis: [f64; 3], latitude: f64, samples: usize, w: usize, h: usize) -> Vec<usize> {
    let helper = if axis[2].abs() < 0.9 {
        [0., 0., 1.]
    } else {
        [1., 0., 0.]
    };
    let t = cross(helper, axis);
    let norm = dot(t, t).sqrt();
    let t = t.map(|x| x / norm);
    let u = cross(axis, t);
    let min_cos = latitude.to_radians().sin();
    let golden = PI * (3.0 - 5.0_f64.sqrt());
    (0..samples)
        .map(|i| {
            let z = 1.0 - (1.0 - min_cos) * (i as f64 + 0.5) / samples as f64;
            let radius = (1.0 - z * z).sqrt();
            let a = golden * i as f64;
            raster_index(
                std::array::from_fn(|j| z * axis[j] + radius * (a.cos() * t[j] + a.sin() * u[j])),
                w,
                h,
            )
        })
        .collect()
}
// Exact latitude clipping integrates a piecewise-constant production raster.
fn band_land(grid: &Grid, mask: &[bool], low: f64, high: f64) -> f64 {
    let (mut land, mut total) = (0.0, 0.0);
    for y in 0..grid.height {
        let n = (90.0 - y as f64 / grid.height as f64 * 180.0).min(high);
        let s = (90.0 - (y + 1) as f64 / grid.height as f64 * 180.0).max(low);
        if n <= s {
            continue;
        }
        let a = n.to_radians().sin() - s.to_radians().sin();
        total += a * grid.width as f64;
        land += a
            * (y * grid.width..(y + 1) * grid.width)
                .filter(|&i| mask[i])
                .count() as f64;
    }
    land / total
}
fn pole_sampler(surface: &PlanetSurface, exact: [i16; 2]) -> Value {
    let poles=[90.0,-90.0].map(|lat| {
        let mut nearest=Vec::new(); let mut interpolated=Vec::new();
        let mut near=Vec::new();
        for i in 0..32 {
            let lon=-180.0+i as f64/32.0*360.0;
            let p=PlanetPosition::from_latitude_longitude_deg(lat,lon);
            nearest.push(surface.sample(p).elevation_m);
            interpolated.push(surface.sample_interpolated(p).elevation_m);
            near.push(surface.sample_interpolated(PlanetPosition::from_latitude_longitude_deg(lat*0.999999,lon)).elevation_m);
        }
        let stats=|v:&[f32]| json!({"min_m":v.iter().copied().fold(f32::INFINITY,f32::min),"max_m":v.iter().copied().fold(f32::NEG_INFINITY,f32::max),"land_states":v.iter().filter(|&&x|x>0.0).count()});
        let canonical=PlanetPosition::new(0.,0.,if lat>0. {1.} else {-1.}).unwrap();
        let row=if lat>0. {0} else {surface.height-1};
        let row_values=(0..surface.width).map(|x|surface.sample_xy(x,row).elevation_m).collect::<Vec<_>>();
        json!({"latitude":lat,"canonical_sample_m":surface.sample(canonical).elevation_m,"canonical_interpolated_m":surface.sample_interpolated(canonical).elevation_m,
            "exact_field_m":exact[if lat>0. {0}else{1}],"longitude_nearest":stats(&nearest),"longitude_interpolated":stats(&interpolated),"near_pole_interpolated":stats(&near),"raster_row":stats(&row_values)})
    });
    json!(poles)
}
fn metric(grid: &Grid, mask: &[bool], geo: &CausalGeologyModel, owners: &[usize]) -> Value {
    let area_total = grid.area.iter().sum::<f64>();
    let land = grid
        .area
        .iter()
        .zip(mask)
        .filter(|(_, m)| **m)
        .map(|(a, _)| a)
        .sum::<f64>();
    let (_, groups) = grid.components(mask, false);
    let mut components=groups.iter().filter_map(|group| {
        let area=group.iter().map(|&i|grid.area[i]).sum::<f64>();
        if area<=0. {return None;}
        let v=std::array::from_fn::<_,3,_>(|j| group.iter().map(|&i|grid.area[i]*grid.points[i].components()[j]).sum::<f64>());
        let norm=dot(v,v).sqrt();
        let latitude=if norm/area<1e-9 {None} else {Some((v[2]/norm).clamp(-1.,1.).asin().to_degrees())};
        Some(json!({"area_km2":area,"land_fraction":area/land,"centroid_latitude_deg":latitude,"centroid_resultant":norm/area}))
    }).collect::<Vec<_>>();
    components.sort_by(|a, b| {
        b["area_km2"]
            .as_f64()
            .unwrap()
            .total_cmp(&a["area_km2"].as_f64().unwrap())
    });
    let mut coast = [0.0; 18];
    let (mut total_coast, mut mixed) = (0.0, 0.0);
    for &(i, j, length) in &grid.arcs {
        if mask[i] == mask[j] {
            continue;
        }
        let a = grid.points[i].components()[2].asin().to_degrees();
        let b = grid.points[j].components()[2].asin().to_degrees();
        let band = (((a + b) * 0.5 + 90.0) / 10.0).floor().clamp(0., 17.) as usize;
        coast[band] += length;
        total_coast += length;
        if geo.plates[owners[i]].crust != geo.plates[owners[j]].crust {
            mixed += length;
        }
    }
    json!({"land_spherical":land/area_total,"land_unweighted":mask[..grid.count()].iter().filter(|&&v|v).count() as f64/grid.count() as f64,
        "north_pole_land":mask[grid.count()],"south_pole_land":mask[grid.count()+1],
        "north_caps":CAP_LAT.map(|lat|band_land(grid,mask,lat,90.)),"south_caps":CAP_LAT.map(|lat|band_land(grid,mask,-90.,-lat)),
        "north_hemisphere":band_land(grid,mask,0.,90.),"south_hemisphere":band_land(grid,mask,-90.,0.),
        "equatorial_bands":[band_land(grid,mask,-15.,15.),band_land(grid,mask,-30.,30.)],
        "latitude_land":(0..18).map(|i|band_land(grid,mask,-90.+i as f64*10.,-80.+i as f64*10.)).collect::<Vec<_>>(),
        "coast_length_latitude_km":coast,"coast_km":total_coast,"mixed_crust_coast":mixed/total_coast,
        "land_components":components.len(),"largest_centroid_latitude":components.first().map(|x|x["centroid_latitude_deg"].clone()),"components":components})
}
fn run_seed(root: &Path, grid: &Grid, seed: u64) -> Value {
    let started = Instant::now();
    let folder = root.join("worlds").join(seed.to_string());
    assert!(!folder.exists(), "preserve completed seed outputs");
    fs::create_dir_all(&folder).unwrap();
    let config = config_for(seed);
    let geo = geology_for(&config);
    let plate_rotation = Rotation::from_seed(seed, 0x706c_6174_6572_6f74);
    let noise_rotation = Rotation::from_seed(seed, 0x6e6f_6973_6572_6f74);
    let (rotated_geo, geometry_error) = rotated(&geo, plate_rotation);
    let geos = [&geo, &rotated_geo];
    let sample_start = Instant::now();
    let data = grid
        .points
        .par_iter()
        .map(|&p| {
            let n0 = noise(&config, p.components());
            let n1 = noise(&config, noise_rotation.apply(p.components()));
            let g0 = fast_geology_influence(&geo, p);
            let g1 = fast_geology_influence(&rotated_geo, p);
            (
                [
                    height(&config, n0, g0),
                    height(&config, n0, g1),
                    height(&config, n1, g0),
                    height(&config, n1, g1),
                ],
                [owner(&geo, p), owner(&rotated_geo, p)],
            )
        })
        .collect::<Vec<_>>();
    let sample_seconds = sample_start.elapsed().as_secs_f64();
    let control_surface = PlanetSurface::generate(&config, &geo);
    let mut results = Vec::new();
    let mut masks = Vec::new();
    for (mode, name) in MODES.iter().enumerate() {
        let raw = data.iter().map(|d| d.0[mode]).collect::<Vec<_>>();
        let threshold = quantile(
            &raw[..grid.count()],
            config.hydrosphere.target_ocean_coverage.unwrap(),
        );
        let elevation = raw
            .iter()
            .map(|&h| stored_elevation(h, threshold, &config))
            .collect::<Vec<_>>();
        let mask = elevation.iter().map(|&v| v > 0).collect::<Vec<_>>();
        if mode == 0 {
            assert_eq!(elevation[..grid.count()], control_surface.elevation_m[..]);
        }
        let owners = data.iter().map(|d| d.1[mode % 2]).collect::<Vec<_>>();
        let mut m = metric(grid, &mask, geos[mode % 2], &owners);
        m["seed"] = json!(seed);
        m["mode"] = json!(name);
        m["threshold"] = json!(threshold);
        m["threshold_bits"] = json!(threshold.to_bits());
        m["mask_checksum"] = json!(checksum(mask.iter().map(|&x| x as u8)));
        m["elevation_checksum"] = json!(checksum(elevation.iter().flat_map(|x| x.to_le_bytes())));
        if mode == 0 {
            m["pole_sampler"] = pole_sampler(
                &control_surface,
                [elevation[grid.count()], elevation[grid.count() + 1]],
            );
        }
        fs::write(
            folder.join(format!("{name}_mask.u8")),
            mask.iter().map(|&v| v as u8).collect::<Vec<_>>(),
        )
        .unwrap();
        if REPRESENTATIVES.contains(&seed) {
            fs::write(
                folder.join(format!("{name}_H.f32le")),
                raw.iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<_>>(),
            )
            .unwrap();
        }
        masks.push(mask);
        results.push(m);
    }
    let axes = cap_axes(seed);
    let sampling_counts = if SEEDS.contains(&seed) {
        vec![2048, 8192]
    } else {
        vec![2048]
    };
    let mut cap_data = Vec::new();
    for count in sampling_counts {
        for lat in CAP_LAT {
            let fractions = axes
                .par_iter()
                .map(|&axis| {
                    let indices = cap_indices(axis, lat, count, grid.width, grid.height);
                    std::array::from_fn::<_, 4, _>(|mode| {
                        indices.iter().filter(|&&i| masks[mode][i]).count() as f64 / count as f64
                    })
                })
                .collect::<Vec<_>>();
            cap_data.push(json!({"latitude_equivalent":lat,"samples":count,"fractions_by_axis_mode":fractions}));
        }
    }
    let metadata = json!({"seed":seed,"plate_quaternion_xyzw":plate_rotation.0,"noise_quaternion_xyzw":noise_rotation.0,
        "maximum_rigid_geometry_dot_error":geometry_error,"all_nonpositional_geology_fields_preserved":true,
        "production_elevation_all_cells_equal":true,"cap_axes":axes,"sample_seconds":sample_seconds,"elapsed_seconds":started.elapsed().as_secs_f64(),
        "production_elevation_checksum":checksum(control_surface.elevation_m.iter().flat_map(|v|v.to_le_bytes()))});
    write_json(folder.join("config.json"), &json!(config));
    write_json(folder.join("geology_original.json"), &json!(geo));
    write_json(folder.join("geology_rotated.json"), &json!(rotated_geo));
    write_json(folder.join("metrics.json"), &json!(results));
    write_json(folder.join("caps.json"), &json!(cap_data));
    write_json(folder.join("metadata.json"), &metadata);
    println!(
        "axial seed {seed} complete {:.2}s",
        started.elapsed().as_secs_f64()
    );
    metadata
}

#[test]
fn planet_axial_rotation_preserves_geometry_metadata_and_field_covariance() {
    let cfg = config_for(42);
    let geo = geology_for(&cfg);
    let r = Rotation::from_seed(42, 12345);
    let (g, error) = rotated(&geo, r);
    assert!(error < 3e-14);
    for i in 0..512 {
        let p = grid_position(i, 32, 16);
        let q = r.position(p);
        let before = height(
            &cfg,
            noise(&cfg, p.components()),
            fast_geology_influence(&geo, p),
        );
        let after = height(
            &cfg,
            noise(&cfg, r.inverse().apply(q.components())),
            fast_geology_influence(&g, q),
        );
        assert!((before - after).abs() < 2e-6);
    }
}
#[test]
fn planet_axial_cap_quadrature_and_clipped_area_are_consistent() {
    let grid = Grid::new(512, 256, 6371.);
    let mask = grid
        .points
        .iter()
        .map(|p| p.components()[2] > 0.)
        .collect::<Vec<_>>();
    assert!((band_land(&grid, &mask, -90., 90.) - 0.5).abs() < 1e-12);
    for lat in CAP_LAT {
        assert_eq!(band_land(&grid, &mask, lat, 90.), 1.);
        assert_eq!(band_land(&grid, &mask, -90., -lat), 0.);
        for (axis, expected) in [([0., 0., 1.], 1.), ([0., 0., -1.], 0.), ([1., 0., 0.], 0.5)] {
            let indices = cap_indices(axis, lat, 8192, grid.width, grid.height);
            let actual = indices.iter().filter(|&&i| mask[i]).count() as f64 / indices.len() as f64;
            assert!((actual - expected).abs() < 0.003);
        }
    }
}
#[test]
fn planet_axial_observer_replays_production_and_axis_config_is_not_a_land_prior() {
    let cfg = config_for(42);
    let geo = geology_for(&cfg);
    let before = PlanetSurface::generate(&cfg, &geo);
    let raw = (0..before.elevation_m.len())
        .into_par_iter()
        .map(|i| {
            let p = grid_position(i, before.width as usize, before.height as usize);
            height(
                &cfg,
                noise(&cfg, p.components()),
                fast_geology_influence(&geo, p),
            )
        })
        .collect::<Vec<_>>();
    let sea = quantile(&raw, 0.71);
    assert_eq!(
        raw.iter()
            .map(|&v| stored_elevation(v, sea, &cfg))
            .collect::<Vec<_>>(),
        *before.elevation_m
    );
    let mut tilted = cfg.clone();
    tilted.physical.axial_tilt_deg = 87.;
    tilted.physical.axial_azimuth_deg = 271.;
    assert_eq!(geology_for(&tilted), geo);
    assert_eq!(PlanetSurface::generate(&tilted, &geo), before);
}
#[test]
fn planet_axial_pole_sampler_preserves_historical_ring_witness_and_unique_limit() {
    let s = PlanetSurface {
        width: 4,
        height: 2,
        sea_level_m: 0.,
        elevation_m: Arc::new(vec![100, -100, 200, -200, 100, -100, 200, -200]),
        temperature_tenths_c: Arc::new(vec![0; 8]),
        moisture: Arc::new(vec![0; 8]),
        terrain: Arc::new(vec![0; 8]),
    };
    let a = PlanetPosition::from_latitude_longitude_deg(90., -135.);
    let b = PlanetPosition::from_latitude_longitude_deg(90., -45.);
    assert!(a.angular_distance_rad(b) < 1e-12);
    // The stored ring still witnesses the old clamped-column classification
    // flip. Reconstructing the missing pole must not change those raw cells.
    assert_ne!(s.sample_xy(0, 0).water, s.sample_xy(1, 0).water);
    assert_eq!(s.sample(a), s.sample(b));
    assert_eq!(s.sample_interpolated(a), s.sample_interpolated(b));
    assert_eq!(s.sample(a).elevation_m, 0.);
}
#[test]
#[ignore = "258-seed native Draft axial orientation exporter; explicit external output required"]
fn planet_axial_export() {
    let root =
        std::env::var_os("URDR_AXIAL_OUTPUT").expect("set an external fresh output directory");
    let root = Path::new(&root);
    assert!(
        !root.join("run.json").exists(),
        "do not overwrite completed export"
    );
    fs::create_dir_all(root).unwrap();
    let mut seeds = (0..256_u64).collect::<Vec<_>>();
    seeds.extend(SEEDS);
    seeds.sort_unstable();
    seeds.dedup();
    let workers = std::env::var("URDR_AXIAL_WORKERS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(8);
    let grid = Grid::new(512, 256, 6371.);
    let start = Instant::now();
    write_json(
        root.join("config.json"),
        &json!({"template":config_for(0),"varying_fields":["seed"],"seeds":seeds,"modes":MODES,"workers":workers,"width":512,"height":256}),
    );
    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(workers)
        .build()
        .unwrap();
    let results = pool.install(|| {
        seeds
            .par_iter()
            .map(|&seed| run_seed(root, &grid, seed))
            .collect::<Vec<_>>()
    });
    write_json(
        root.join("run.json"),
        &json!({"fixtures":results,"seeds":seeds.len(),"metric_records":seeds.len()*4,"elapsed_seconds":start.elapsed().as_secs_f64(),"workers":workers}),
    );
}
