//! Stage 3 evaluator, nested in the existing test-only exporter for PNG helpers.
use super::super::candidate::*;
use super::*;

#[path = "planet_landmass_candidate_analysis.rs"]
mod analysis;
use analysis::*;

#[path = "planet_stage4a_diagnostics.rs"]
mod stage4a;

const VARIANTS: [&str; 8] = [
    "Legacy",
    "continuous_K",
    "kinematic_B",
    "continuous_K_kinematic_B",
    "no_K",
    "no_B",
    "no_K_no_B",
    "continuous_K_no_B",
];
const MAIN_VARIANTS: [&str; 4] = [
    "Legacy",
    "continuous_K",
    "kinematic_B",
    "continuous_K_kinematic_B",
];

fn contributions(
    name: &str,
    legacy: &Components,
    candidate: &CandidateSample,
    config: &PlanetGenerationConfig,
) -> (f64, f64) {
    let [_, _, k, b] = legacy.weighted(config);
    match name {
        "Legacy" => (k, b),
        "continuous_K" => (candidate.k, b),
        "kinematic_B" => (k, candidate.b),
        "continuous_K_kinematic_B" => (candidate.k, candidate.b),
        "no_K" => (0.0, b),
        "no_B" => (k, 0.0),
        "no_K_no_B" => (0.0, 0.0),
        "continuous_K_no_B" => (candidate.k, 0.0),
        _ => unreachable!(),
    }
}

fn raw_variant(
    name: &str,
    legacy: &[Components],
    candidate: &[CandidateSample],
    config: &PlanetGenerationConfig,
    without_b: bool,
) -> Vec<f32> {
    legacy
        .iter()
        .zip(candidate)
        .map(|(s, candidate)| {
            let [c, d, _, _] = s.weighted(config);
            let (k, b) = contributions(name, s, candidate, config);
            (c + d + k + if without_b { 0.0 } else { b }) as f32
        })
        .collect()
}

fn make_mask(raw: &[f32], sea: f32, config: &PlanetGenerationConfig) -> Vec<bool> {
    raw.iter()
        .map(|&v| stored_elevation(v, sea, config) > 0)
        .collect()
}

fn export_fields(
    path: &Path,
    grid: &Grid,
    legacy: &[Components],
    candidate: &[CandidateSample],
    config: &PlanetGenerationConfig,
) {
    let mut out = BufWriter::new(File::create(path.join("components.f64le")).unwrap());
    let mut owners = BufWriter::new(File::create(path.join("owner_second.u8")).unwrap());
    for (s, candidate) in legacy.iter().zip(candidate) {
        let [_, _, k, b] = s.weighted(config);
        for value in [
            s.c,
            s.d,
            k,
            candidate.k,
            b,
            candidate.b,
            candidate.normal_response,
            candidate.shear_response,
            candidate.k_gradient_per_rad,
        ] {
            out.write_all(&value.to_le_bytes()).unwrap();
        }
        owners.write_all(&[s.owner as u8, s.second as u8]).unwrap();
    }
    out.flush().unwrap();
    owners.flush().unwrap();
    for (name, layer) in [
        ("legacy_K", 0),
        ("continuous_K", 1),
        ("legacy_B", 2),
        ("kinematic_B", 3),
    ] {
        image_layer(grid, path.join(format!("{name}_field.png")), |i| {
            signed(
                match layer {
                    0 => legacy[i].crust * 0.28,
                    1 => candidate[i].k,
                    2 => legacy[i].weighted(config)[3],
                    _ => candidate[i].b,
                },
                0.2,
            )
        });
    }
    image_layer(grid, path.join("C.png"), |i| signed(legacy[i].c, 1.0));
    image_layer(grid, path.join("D.png"), |i| signed(legacy[i].d, 1.0));
}

fn export_mask(path: &Path, name: &str, grid: &Grid, mask: &[bool], samples: &[Components]) {
    image_layer(grid, path.join(format!("{name}_mask.png")), |i| {
        if mask[i] { LAND } else { WATER }
    });
    fs::write(
        path.join(format!("{name}_mask.u8")),
        mask.iter().map(|&v| u8::from(v)).collect::<Vec<_>>(),
    )
    .unwrap();
    let mut boundary = vec![false; grid.count()];
    let mut mixed = vec![false; grid.count()];
    let mut coast = vec![false; grid.count()];
    for &(i, j, _) in &grid.arcs {
        if samples[i].owner != samples[j].owner {
            boundary[i] = true;
            boundary[j] = true;
        }
        if samples[i].crust != samples[j].crust {
            mixed[i] = true;
            mixed[j] = true;
        }
        if mask[i] != mask[j] {
            coast[i] = true;
            coast[j] = true;
        }
    }
    image_layer(grid, path.join(format!("{name}_overlay.png")), |i| {
        if coast[i] && mixed[i] {
            [255, 203, 32]
        } else if coast[i] {
            [250, 245, 215]
        } else if mixed[i] {
            [214, 102, 205]
        } else if boundary[i] {
            [0, 185, 205]
        } else if mask[i] {
            [95, 100, 74]
        } else {
            WATER
        }
    });
}

#[test]
fn planet_candidate_worker_rotation_quality_and_diagnostic_reproducibility() {
    let fixture = &candidate_fixtures()[0];
    let config = &fixture.config;
    let geo = geology_for(config);
    let field = CandidateField::new(config, &geo);
    let mut outputs = Vec::new();
    for threads in [1, 2] {
        outputs.push(
            rayon::ThreadPoolBuilder::new()
                .num_threads(threads)
                .build()
                .unwrap()
                .install(|| {
                    (0..4098)
                        .into_par_iter()
                        .map(|i| {
                            let p = grid_position(i, 128, 32);
                            let s = field.sample(p, fast_geology_influence(&geo, p).1);
                            [s.k.to_bits(), s.b.to_bits()]
                        })
                        .collect::<Vec<_>>()
                }),
        );
    }
    assert_eq!(outputs[0], outputs[1]);
    let mut normal_config = config.clone();
    normal_config.quality = GenerationQuality::Normal;
    let normal = CandidateField::new(&normal_config, &geo);
    let axis = unit([1.0, 2.0, 3.0]);
    let angle = 0.713_f64;
    let rotate = |v: [f64; 3]| {
        let c = cross(axis, v);
        std::array::from_fn::<_, 3, _>(|i| {
            v[i] * angle.cos() + c[i] * angle.sin() + axis[i] * dot(axis, v) * (1.0 - angle.cos())
        })
    };
    let mut rotated = geo.clone();
    for plate in &mut rotated.plates {
        let c = rotate(plate.center.components());
        plate.center = PlanetPosition::new(c[0], c[1], c[2]).unwrap();
        let c = rotate(plate.euler_pole.components());
        plate.euler_pole = PlanetPosition::new(c[0], c[1], c[2]).unwrap();
    }
    let rigid = CandidateField::new(config, &rotated);
    for i in 0..256 {
        let p = grid_position(i, 32, 8);
        let b = fast_geology_influence(&geo, p).1;
        let s = field.sample(p, b);
        let n = normal.sample(p, b);
        assert_eq!(s.k.to_bits(), n.k.to_bits());
        assert_eq!(s.b.to_bits(), n.b.to_bits());
        let c = rotate(p.components());
        let q = PlanetPosition::new(c[0], c[1], c[2]).unwrap();
        let r = rigid.sample(q, fast_geology_influence(&rotated, q).1);
        assert!((s.k - r.k).abs() < 1e-12);
        assert!((s.b - r.b).abs() < 1e-12);
    }
    let grid = Grid::new(32, 16, 6371.0);
    let legacy = (0..grid.count() + 2)
        .map(|i| observe_point(config, &geo, grid.points[i]))
        .collect::<Vec<_>>();
    let candidates = legacy
        .iter()
        .map(|s| field.sample(s.position, s.boundary))
        .collect::<Vec<_>>();
    let first = field_statistics(&grid, &legacy, &candidates, &field, config);
    let second = field_statistics(&grid, &legacy, &candidates, &field, config);
    assert_eq!(
        serde_json::to_vec(&first).unwrap(),
        serde_json::to_vec(&second).unwrap()
    );
}

#[test]
#[ignore = "Stage 3: 32 fixtures, 8 variants, 3 threshold modes, diagnostic files only"]
fn planet_candidate_export() {
    preservation();
    let root = std::env::var_os("URDR_CANDIDATE_OUTPUT")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../outputs/URDR-4.4-Planet-Candidate-1")
        });
    assert!(
        !root.exists(),
        "choose a new output directory to preserve prior experiments"
    );
    fs::create_dir_all(&root).unwrap();
    let started = Instant::now();
    let mut records = Vec::new();
    let mut preserved = Vec::new();
    let fixtures = candidate_fixtures();
    assert_eq!(fixtures.len(), 32);
    for fixture in fixtures {
        let fixture_started = Instant::now();
        let config = &fixture.config;
        config.validate().unwrap();
        let path = root.join(&fixture.id);
        fs::create_dir_all(&path).unwrap();
        let geo = geology_for(config);
        let surface = PlanetSurface::generate(config, &geo);
        let legacy = observe(config, &geo);
        let (w, h) = PlanetSurface::dimensions_for_quality(config.quality);
        let grid = Grid::new(w as usize, h as usize, config.physical.radius_m / 1000.0);
        let raw = legacy.iter().map(|s| s.raw_h(config)).collect::<Vec<_>>();
        let q = config.hydrosphere.target_ocean_coverage.unwrap();
        let sea = quantile(&raw[..grid.count()], q);
        check_legacy(&fixture, &surface, &raw[..grid.count()], sea);
        preserved.push(fixture.id.clone());
        let reference = make_mask(&raw, sea, config);
        let target_area = water_area(&grid, &reference);
        let field = CandidateField::new(config, &geo);
        let candidate = legacy
            .par_iter()
            .map(|s| field.sample(s.position, s.boundary))
            .collect::<Vec<_>>();
        for (s, expected) in legacy.iter().zip(&candidate).step_by(127) {
            let again = field.sample(s.position, s.boundary);
            assert_eq!(again.k.to_bits(), expected.k.to_bits());
            assert_eq!(again.b.to_bits(), expected.b.to_bits());
        }
        assert_eq!(surface, PlanetSurface::generate(config, &geo));
        write_json(path.join("fixture.json"), &fixture);
        write_json(path.join("geology.json"), &geo);
        write_json(
            path.join("field_statistics.json"),
            &field_statistics(&grid, &legacy, &candidate, &field, config),
        );
        write_json(
            path.join("boundary_statistics.json"),
            &boundary_probes(&path, &grid, &legacy, &field, &geo),
        );
        write_json(
            path.join("sampling_checks.json"),
            &sampling_checks(&field, &geo),
        );
        export_fields(&path, &grid, &legacy, &candidate, config);
        write_json(
            path.join("metadata.json"),
            &json!({
                "id":fixture.id,"profile":fixture.profile,"width":w,"height":h,"radius_km":grid.radius_km,
                "projection":"equirectangular north-up cell centers; two exact poles appended to binary arrays",
                "components_f64le_columns":["C","D","legacy_weighted_K","continuous_weighted_K","legacy_weighted_B","kinematic_weighted_B","normal_response","signed_shear_response","Kprime_gradient_per_rad"],
                "owner_second_u8":"two u8 per point, indices into geology.plates; row-major plus north/south poles",
                "H_format":"f32 little endian; row-major plus north/south poles","mask_format":"u8 1=land rounded i16 > 0",
                "color_ranges":{"C_D_H":[-1,1],"K_Kprime_B_Bprime":[-0.2,0.2]},
                "overlay_colors":{"plate_edge":"cyan","mixed_crust_edge":"magenta","coast":"off-white","coast_and_mixed_edge":"yellow"},
                "K_design":"all-plate normalized exp(kappa*dot(center,position)); source field, not raster blur",
                "kappa":field.kappa,"median_nearest_site_spacing_rad":field.spacing_rad,"nominal_two_plate_10_90_width_km":TRANSITION_FRACTION*field.spacing_rad*grid.radius_km,
                "transition_fraction":TRANSITION_FRACTION,"omega_normalization_rad_per_myr":field.omega_scale,
                "B_design":"signed relative-motion normal projection blended over continuous partition; legacy B envelope and amplitude upper bound retained",
                "metadata_kind_authority":false,"amplitude_upper_bound":0.05+0.2*config.tectonics.orogenic_activity,
                "legacy_threshold_bits":sea.to_bits(),"configured_cell_ocean_target":q,"legacy_spherical_ocean_area_target":target_area,
                "production_modified":false,"legacy_snapshot":"30b6f3d2a1b36d87f2895cd3179da37b27bda0ad",
            }),
        );
        for name in VARIANTS {
            let variant_path = path.join(name);
            fs::create_dir_all(&variant_path).unwrap();
            let raw = raw_variant(name, &legacy, &candidate, config, false);
            let without_b = raw_variant(name, &legacy, &candidate, config, true);
            if name == "Legacy" {
                check_legacy(&fixture, &surface, &raw[..grid.count()], sea);
            }
            fs::write(
                variant_path.join("H.f32le"),
                raw.iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<_>>(),
            )
            .unwrap();
            let (matched, area_step) = area_threshold(&raw, &grid, config, target_area);
            for mode in ["fixed", "cell_requantile", "area_matched"] {
                let threshold = match mode {
                    "fixed" => sea,
                    "cell_requantile" => quantile(&raw[..grid.count()], q),
                    _ => matched,
                };
                let mask = make_mask(&raw, threshold, config);
                let without_b = make_mask(&without_b, threshold, config);
                let actual_area = water_area(&grid, &mask);
                if mode == "area_matched" {
                    assert!((actual_area - target_area).abs() <= area_step + 1e-10);
                    if name == "Legacy" {
                        assert_eq!(mask, reference);
                    }
                }
                let (metrics, _) = measure(&grid, &mask, &reference, &legacy);
                let attribution = thin_attribution(&grid, &mask, &without_b);
                export_mask(&variant_path, mode, &grid, &mask, &legacy);
                let record = json!({"fixture":fixture.id,"profile":fixture.profile,"seed":config.seed,"quality":config.quality,"variant":name,"mode":mode,
                    "threshold":threshold,"threshold_bits":threshold.to_bits(),"configured_cell_target":q,"legacy_spherical_target":target_area,
                    "spherical_target_error":actual_area-target_area,"area_match_discrete_step_bound":if mode=="area_matched"{Some(area_step)}else{None},
                    "raw_H_checksum":checksum(raw[..grid.count()].iter().flat_map(|v|v.to_le_bytes())),
                    "metrics":metrics,"B_attribution":attribution});
                write_json(variant_path.join(format!("{mode}_metrics.json")), &record);
                records.push(record);
            }
            if MAIN_VARIANTS.contains(&name) {
                let center_mask = make_mask(&raw, quantile(&raw[..grid.count()], q), config);
                let mut persistence = Vec::new();
                for offset in [-0.02, -0.01, 0.0, 0.01, 0.02] {
                    let target = q + offset;
                    let threshold = quantile(&raw[..grid.count()], target);
                    let mask = make_mask(&raw, threshold, config);
                    persistence.push(json!({"q":target,"offset":offset,"threshold_bits":threshold.to_bits(),"topology":topology(&grid,&mask,&center_mask)}));
                }
                write_json(variant_path.join("q_persistence.json"), &persistence);
            }
        }
        println!(
            "Candidate fixture {} complete: {:.2}s",
            fixture.id,
            fixture_started.elapsed().as_secs_f64()
        );
    }
    write_json(root.join("metrics.json"), &records);
    write_json(
        root.join("run.json"),
        &json!({"fixtures":32,"variants":VARIANTS,"modes":["fixed","cell_requantile","area_matched"],"records":records.len(),
        "legacy_preservation":"PASS","preserved_fixtures":preserved,"elapsed_seconds":started.elapsed().as_secs_f64(),"workers":rayon::current_num_threads()}),
    );
    println!("Candidate 1 evaluation complete: {}", root.display());
}
