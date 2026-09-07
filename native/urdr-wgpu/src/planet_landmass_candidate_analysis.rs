//! Candidate-only measurements. Stage 2 metrics remain unchanged.
use super::*;

pub(super) fn divide(a: f64, b: f64) -> Option<f64> {
    (b > 0.0).then(|| a / b).filter(|x| x.is_finite())
}
fn percentile(values: &[f64], q: f64) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    let mut values = values.to_vec();
    values.sort_by(f64::total_cmp);
    Some(values[((values.len() - 1) as f64 * q) as usize])
}
fn distribution(values: &[f64]) -> Value {
    json!({"count":values.len(),"mean":divide(values.iter().sum(),values.len() as f64),"p05":percentile(values,0.05),"p50":percentile(values,0.5),"p95":percentile(values,0.95),"p99":percentile(values,0.99),"max":values.iter().copied().reduce(f64::max)})
}
fn next_float(value: f32, up: bool) -> f32 {
    if value == 0.0 {
        return if up {
            f32::from_bits(1)
        } else {
            -f32::from_bits(1)
        };
    }
    let bits = value.to_bits();
    f32::from_bits(if (value > 0.0) == up {
        bits + 1
    } else {
        bits - 1
    })
}

// Smallest positive relative H that rounds to a land cell. This captures the
// existing f32 pow/round rule instead of silently switching to a raw-H mask.
fn first_land_relative(config: &PlanetGenerationConfig) -> f32 {
    let (mut lo, mut hi) = (0_u32, 1.0_f32.to_bits());
    while lo < hi {
        let mid = lo + (hi - lo) / 2;
        if stored_elevation(f32::from_bits(mid), 0.0, config) > 0 {
            hi = mid;
        } else {
            lo = mid + 1;
        }
    }
    f32::from_bits(lo)
}

fn first_water_threshold(raw: f32, relative: f32) -> f32 {
    let midpoint = (relative as f64 + next_float(relative, false) as f64) * 0.5;
    let mut threshold = (raw as f64 - midpoint) as f32;
    for _ in 0..8 {
        if raw - threshold >= relative {
            threshold = next_float(threshold, true);
            continue;
        }
        let before = next_float(threshold, false);
        if raw - before < relative {
            threshold = before;
            continue;
        }
        return threshold;
    }
    panic!("could not bracket rounded water transition");
}

pub(super) fn area_threshold(
    raw: &[f32],
    grid: &Grid,
    config: &PlanetGenerationConfig,
    target: f64,
) -> (f32, f64) {
    let relative = first_land_relative(config);
    let mut switches = raw[..grid.count()]
        .iter()
        .enumerate()
        .map(|(i, &h)| (first_water_threshold(h, relative), i))
        .collect::<Vec<_>>();
    switches.par_sort_unstable_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
    let total: f64 = grid.area.iter().sum();
    let target_area = target * total;
    let mut accumulated = 0.0;
    let mut index = 0;
    while index < switches.len() {
        let threshold = switches[index].0;
        let previous = accumulated;
        while index < switches.len() && switches[index].0 == threshold {
            accumulated += grid.area[switches[index].1];
            index += 1;
        }
        if accumulated >= target_area {
            let selected = if (target_area - previous).abs() < (accumulated - target_area).abs() {
                next_float(threshold, false)
            } else {
                threshold
            };
            return (selected, (accumulated - previous) / total);
        }
    }
    (switches.last().unwrap().0, 0.0)
}

pub(super) fn water_area(grid: &Grid, mask: &[bool]) -> f64 {
    let total: f64 = grid.area.iter().sum();
    grid.area
        .iter()
        .zip(mask)
        .filter(|(_, land)| !**land)
        .map(|(a, _)| a)
        .sum::<f64>()
        / total
}

pub(super) fn topology(grid: &Grid, mask: &[bool], reference: &[bool]) -> Value {
    let (labels, groups) = grid.components(mask, false);
    let mut areas = groups
        .iter()
        .map(|g| g.iter().map(|&i| grid.area[i]).sum::<f64>())
        .filter(|&a| a > 0.0)
        .collect::<Vec<_>>();
    areas.sort_by(|a, b| b.total_cmp(a));
    let land: f64 = areas.iter().sum();
    let total: f64 = grid.area.iter().sum();
    let mut overlaps = vec![0.0; groups.len()];
    let mut reference_area = 0.0;
    let (_, ref_groups) = grid.components(reference, false);
    if let Some(group) = ref_groups.iter().max_by(|a, b| {
        a.iter()
            .map(|&i| grid.area[i])
            .sum::<f64>()
            .total_cmp(&b.iter().map(|&i| grid.area[i]).sum::<f64>())
    }) {
        for &i in group {
            reference_area += grid.area[i];
            if mask[i] {
                overlaps[labels[i]] += grid.area[i];
            }
        }
    }
    let micro: f64 = groups
        .iter()
        .filter(|g| g.iter().filter(|&&i| i < grid.count()).count() <= 3)
        .flat_map(|g| g.iter())
        .map(|&i| grid.area[i])
        .sum();
    let water = mask.iter().map(|v| !v).collect::<Vec<_>>();
    json!({"components":areas.len(),"a1_land":areas.first().and_then(|&a|divide(a,land)),"a2_land":areas.get(1).and_then(|&a|divide(a,land)),
        "neck_320km":grid.morphology(mask,&[320.0]),"strait_320km":grid.morphology(&water,&[320.0]),
        "ocean_spherical":1.0-land/total,"micro_island_fraction_land":divide(micro,land),
        "largest_reference_component_retained_in_one_component":divide(overlaps.into_iter().fold(0.0,f64::max),reference_area),
        "mask_flip_planet_area":grid.area.iter().enumerate().filter(|(i,_)|mask[*i]!=reference[*i]).map(|(_,a)|a).sum::<f64>()/total})
}

pub(super) fn thin_attribution(grid: &Grid, mask: &[bool], without_b: &[bool]) -> Value {
    let distances = grid.coast_distances(mask);
    let total: f64 = grid.area.iter().sum();
    let mut supported = 0.0;
    let mut suppressed = 0.0;
    let mut thin = 0.0;
    for i in 0..grid.count() {
        if mask[i] && !without_b[i] {
            supported += grid.area[i];
            if distances[i] < 160.0 {
                thin += grid.area[i];
            }
        }
        if !mask[i] && without_b[i] {
            suppressed += grid.area[i];
        }
    }
    let water = mask.iter().map(|v| !v).collect::<Vec<_>>();
    let (_, groups) = grid.components(&water, false);
    let mut areas = groups
        .iter()
        .map(|g| g.iter().map(|&i| grid.area[i]).sum::<f64>())
        .filter(|&a| a > 0.0)
        .collect::<Vec<_>>();
    areas.sort_by(|a, b| b.total_cmp(a));
    json!({"counterfactual":"B contribution set to zero at this variant's SAME threshold; no re-quantile",
        "land_supported_by_B_planet_fraction":supported/total,"land_suppressed_by_B_planet_fraction":suppressed/total,
        "thin_land_supported_by_B_width_below_320km_planet_fraction":thin/total,
        "secondary_water_components_ring_proxy":areas.len().saturating_sub(1),
        "secondary_water_area_planet_fraction":areas.iter().skip(1).sum::<f64>()/total})
}

pub(super) fn field_statistics(
    grid: &Grid,
    samples: &[Components],
    candidate: &[CandidateSample],
    field: &CandidateField,
    config: &PlanetGenerationConfig,
) -> Value {
    let total: f64 = grid.area.iter().sum();
    let mut mean = [0.0; 2];
    let mut second = [0.0; 2];
    let mut conditional = [[0.0; 3]; 2];
    let mut core = [[0.0; 3]; 2];
    let mut sign_flip = 0.0;
    let mut absolute_delta = 0.0;
    let mut positive_area = [0.0; 2];
    let mut transition_area = 0.0;
    let mut signs = [[0.0; 3]; 2];
    let mut by_kind = [[0.0; 5]; 4];
    let mut kind_counts = [0_usize; 4];
    let mut amplitude: [Vec<f64>; 2] = std::array::from_fn(|_| Vec::new());
    let mut amplitude_moments = [[0.0; 2]; 2];
    let mut gradient = Vec::new();
    for i in 0..grid.count() {
        let area = grid.area[i];
        let values = [samples[i].crust * 0.28, candidate[i].k];
        for j in 0..2 {
            mean[j] += area * values[j] / total;
            second[j] += area * values[j] * values[j] / total;
            if values[j] > 0.0 {
                positive_area[j] += area / total;
            }
        }
        if (values[0] > 0.0) != (values[1] > 0.0) {
            sign_flip += area / total;
        }
        absolute_delta += area * (values[1] - values[0]).abs() / total;
        let fraction = (candidate[i].k - (-0.52 * 0.28)) / (0.308);
        if (0.1..0.9).contains(&fraction) {
            transition_area += area / total;
        }
        let category = if samples[i].crust == 0.58 {
            Some(0)
        } else if samples[i].crust == -0.52 {
            Some(1)
        } else {
            None
        };
        if let Some(c) = category {
            conditional[c][0] += area;
            conditional[c][1] += area * values[0];
            conditional[c][2] += area * values[1];
            if samples[i].boundary_distance_rad >= field.spacing_rad * TRANSITION_FRACTION * 0.5 {
                core[c][0] += area;
                core[c][1] += area * values[0];
                core[c][2] += area * values[1];
            }
        }
        if samples[i].boundary > 0.1 {
            gradient.push(candidate[i].k_gradient_per_rad / grid.radius_km);
            let (normal, shear) =
                field.pair_motion(samples[i].position, samples[i].owner, samples[i].second);
            let kind = match motion_kind(normal, shear) {
                "convergent" => 0,
                "divergent" => 1,
                "transform" => 2,
                _ => 3,
            };
            let legacy = samples[i].weighted(config)[3];
            kind_counts[kind] += 1;
            by_kind[kind][0] += area;
            by_kind[kind][1] += area * legacy;
            by_kind[kind][2] += area * candidate[i].b;
            by_kind[kind][3] += area * normal * grid.radius_km;
            by_kind[kind][4] += area * shear.abs() * grid.radius_km;
            for (j, v) in [legacy, candidate[i].b].into_iter().enumerate() {
                amplitude[j].push(v);
                amplitude_moments[j][0] += area * v.abs();
                amplitude_moments[j][1] += area * v * v;
                signs[j][if v > 1e-10 {
                    2
                } else if v < -1e-10 {
                    0
                } else {
                    1
                }] += area;
            }
        }
    }
    let conditional=(0..2).map(|i|json!({"owner_crust":if i==0{"continental"}else{"oceanic"},"area_fraction":conditional[i][0]/total,
        "legacy_mean":divide(conditional[i][1],conditional[i][0]),"candidate_mean":divide(conditional[i][2],conditional[i][0]),
        "core_legacy_mean":divide(core[i][1],core[i][0]),"core_candidate_mean":divide(core[i][2],core[i][0])})).collect::<Vec<_>>();
    let contrast = conditional[0]["candidate_mean"]
        .as_f64()
        .zip(conditional[1]["candidate_mean"].as_f64())
        .map(|(a, b)| (a - b) / 0.308);
    let core_contrast = conditional[0]["core_candidate_mean"]
        .as_f64()
        .zip(conditional[1]["core_candidate_mean"].as_f64())
        .map(|(a, b)| (a - b) / 0.308);
    let by_kind=(0..4).map(|i|json!({"kind":(["convergent","divergent","transform","stationary"][i]),"sample_count":kind_counts[i],"active_area_fraction_planet":by_kind[i][0]/total,
        "legacy_mean_relief":divide(by_kind[i][1],by_kind[i][0]),"candidate_mean_relief":divide(by_kind[i][2],by_kind[i][0]),
        "mean_normal_mm_per_year":divide(by_kind[i][3],by_kind[i][0]),"mean_abs_shear_mm_per_year":divide(by_kind[i][4],by_kind[i][0])})).collect::<Vec<_>>();
    let active: f64 = signs[0].iter().sum();
    let amplitude = (0..2).map(|i| json!({"field":if i==0{"legacy"}else{"candidate"},
        "signed_sample_distribution":distribution(&amplitude[i]),
        "absolute_sample_distribution":distribution(&amplitude[i].iter().map(|v|v.abs()).collect::<Vec<_>>()),
        "area_weighted_mean_absolute":divide(amplitude_moments[i][0],active),
        "area_weighted_rms":divide(amplitude_moments[i][1],active).map(f64::sqrt)})).collect::<Vec<_>>();
    json!({"K":{"legacy_mean":mean[0],"candidate_mean":mean[1],"legacy_variance":second[0]-mean[0]*mean[0],"candidate_variance":second[1]-mean[1]*mean[1],
        "conditional":conditional,"contrast_retention":contrast,"core_contrast_retention":core_contrast,
        "positive_area_fraction":positive_area,"sign_flip_area_fraction":sign_flip,"mean_absolute_delta":absolute_delta,
        "intermediate_10_90_area_fraction":transition_area,"boundary_band_analytic_gradient_per_km":distribution(&gradient)},
        "B":{"active_band":"legacy proximity > 0.1","sign_order":["negative","zero","positive"],
            "sample_count":kind_counts.iter().sum::<usize>(),"amplitude":amplitude,
            "legacy_sign_area_fractions":signs[0].map(|v|divide(v,active)),"candidate_sign_area_fractions":signs[1].map(|v|divide(v,active)),"by_nearest_pair_motion_kind":by_kind}})
}

pub(super) fn boundary_probes(
    path: &Path,
    grid: &Grid,
    samples: &[Components],
    field: &CandidateField,
    geo: &CausalGeologyModel,
) -> Value {
    let mut csv = BufWriter::new(File::create(path.join("boundary_probes.csv")).unwrap());
    writeln!(csv,"x,y,z,left_plate,right_plate,mixed_crust,motion_kind,metadata_kind,normal_mm_yr,shear_mm_yr,K_jump_0_1m,Kprime_delta_0_1m,Bprime_delta_0_1m,width_10_90_km").unwrap();
    let mut deltas: [Vec<f64>; 4] = std::array::from_fn(|_| Vec::new());
    let mut legacy_jump = Vec::new();
    let mut b_delta = Vec::new();
    let mut widths = Vec::new();
    let mut metadata_present = 0;
    let mut metadata_mismatch = 0;
    let mut edges = 0;
    let mut mixed = 0;
    for &(a, b, _) in &grid.arcs {
        let (i, j) = (samples[a].owner, samples[b].owner);
        if i == j {
            continue;
        }
        let normal = unit(sub(field.centers[i], field.centers[j]));
        let mid = unit(std::array::from_fn(|k| {
            grid.points[a].components()[k] + grid.points[b].components()[k]
        }));
        let q = unit(sub(mid, mul(normal, dot(mid, normal))));
        let active = dot(q, field.centers[i]);
        if field.centers.iter().any(|&c| dot(q, c) > active + 1e-10) {
            continue;
        }
        edges += 1;
        let p = PlanetPosition::new(q[0], q[1], q[2]).unwrap();
        let (vnormal, vshear) = field.pair_motion(p, i, j);
        let kind = motion_kind(vnormal, vshear);
        let meta = geo.boundaries.iter().find(|m| {
            (m.left_plate_id == geo.plates[i].id && m.right_plate_id == geo.plates[j].id)
                || (m.left_plate_id == geo.plates[j].id && m.right_plate_id == geo.plates[i].id)
        });
        let meta_kind = meta
            .map(|m| match m.kind {
                crate::geology::PlateBoundaryKind::Convergent => "convergent",
                crate::geology::PlateBoundaryKind::Divergent => "divergent",
                crate::geology::PlateBoundaryKind::Transform => "transform",
            })
            .unwrap_or("");
        if meta.is_some() {
            metadata_present += 1;
            if meta_kind != kind {
                metadata_mismatch += 1;
            }
        }
        let is_mixed = matches!(
            (geo.plates[i].crust, geo.plates[j].crust),
            (CrustType::Continental, CrustType::Oceanic)
                | (CrustType::Oceanic, CrustType::Continental)
        );
        let point = |angle: f64| {
            let p =
                std::array::from_fn::<_, 3, _>(|k| q[k] * angle.cos() + normal[k] * angle.sin());
            PlanetPosition::new(p[0], p[1], p[2]).unwrap()
        };
        let tiny = 0.1 / (grid.radius_km * 1000.0);
        let left = point(-tiny);
        let right = point(tiny);
        let left = field.sample(left, fast_geology_influence(geo, left).1);
        let right = field.sample(right, fast_geology_influence(geo, right).1);
        let mut last_k = (left.k - right.k).abs();
        let mut last_b = (left.b - right.b).abs();
        let mut jump = 0.0;
        let mut width = None;
        b_delta.push(last_b);
        if is_mixed {
            mixed += 1;
            for (index, metres) in [100_000.0, 1_000.0, 10.0, 0.1].into_iter().enumerate() {
                let angle = metres / (grid.radius_km * 1000.0);
                let left = point(-angle);
                let right = point(angle);
                let gl = fast_geology_influence(geo, left);
                let gr = fast_geology_influence(geo, right);
                let cl = field.sample(left, gl.1);
                let cr = field.sample(right, gr.1);
                last_k = (cl.k - cr.k).abs();
                last_b = (cl.b - cr.b).abs();
                deltas[index].push(last_k);
                if index == 3 {
                    jump = 0.28 * (gl.0 - gr.0).abs();
                    legacy_jump.push(jump);
                }
            }
            let direction = if geo.plates[i].crust == CrustType::Continental {
                1.0
            } else {
                -1.0
            };
            let extent = dot(field.centers[i], field.centers[j])
                .clamp(-1.0, 1.0)
                .acos()
                * 0.5;
            let fraction = |t: f64| {
                let p = point(t * direction);
                (field.sample(p, 0.0).k + 0.52 * 0.28) / 0.308
            };
            let transect = (0..17)
                .map(|i| fraction(-extent + 2.0 * extent * i as f64 / 16.0))
                .collect::<Vec<_>>();
            if transect[0] <= 0.1
                && transect[16] >= 0.9
                && transect.windows(2).all(|w| w[1] >= w[0] - 1e-10)
            {
                let solve = |target: f64| {
                    let (mut lo, mut hi) = (-extent, extent);
                    for _ in 0..32 {
                        let mid = (lo + hi) * 0.5;
                        if fraction(mid) < target {
                            lo = mid
                        } else {
                            hi = mid
                        }
                    }
                    (lo + hi) * 0.5
                };
                let measured = (solve(0.9) - solve(0.1)) * grid.radius_km;
                width = Some(measured);
                widths.push(measured);
            }
        }
        writeln!(
            csv,
            "{},{},{},{},{},{},{kind},{meta_kind},{},{},{jump},{last_k},{last_b},{}",
            q[0],
            q[1],
            q[2],
            geo.plates[i].id,
            geo.plates[j].id,
            is_mixed,
            vnormal * grid.radius_km,
            vshear * grid.radius_km,
            width.map(|v| v.to_string()).unwrap_or_default()
        )
        .unwrap();
    }
    csv.flush().unwrap();
    let crossing_deltas = [100_000.0,1_000.0,10.0,0.1].iter().enumerate().map(|(i,metres)|json!({"half_span_m":metres,"delta":distribution(&deltas[i]),"gradient_per_km":distribution(&deltas[i].iter().map(|d|d/(2.0*metres/1000.0)).collect::<Vec<_>>())})).collect::<Vec<_>>();
    json!({"boundary_samples":edges,"mixed_boundary_samples":mixed,"metadata_present":metadata_present,"metadata_motion_mismatch_fraction":divide(metadata_mismatch as f64,metadata_present as f64),
        "legacy_K_delta_across_0_2m":distribution(&legacy_jump),"candidate_B_delta_across_0_2m":distribution(&b_delta),
        "candidate_K_crossing_deltas":crossing_deltas,
        "measured_K_transition_10_90_width_km":distribution(&widths),"width_unresolved_mixed_samples":mixed-widths.len(),
        "width_method":"mixed-boundary normal transect; measure only when both endpoints bracket 10/90%; junctions and other plates can remain unresolved"})
}

pub(super) fn sampling_checks(field: &CandidateField, geo: &CausalGeologyModel) -> Value {
    let mut seam = [0.0_f64; 2];
    let mut poles = [0.0_f64; 2];
    let mut near_poles = [0.0_f64; 2];
    for latitude in (-90..=90).map(|v| v as f64) {
        let a = PlanetPosition::from_latitude_longitude_deg(latitude, -180.0);
        let b = PlanetPosition::from_latitude_longitude_deg(latitude, 180.0);
        let a = field.sample(a, fast_geology_influence(geo, a).1);
        let b = field.sample(b, fast_geology_influence(geo, b).1);
        seam[0] = seam[0].max((a.k - b.k).abs());
        seam[1] = seam[1].max((a.b - b.b).abs());
    }
    for north in [true, false] {
        let sign = if north { 1.0 } else { -1.0 };
        let p = PlanetPosition::from_latitude_longitude_deg(sign * 90.0, 0.0);
        let reference = field.sample(p, fast_geology_influence(geo, p).1);
        for lon in -180..=180 {
            for (lat, output) in [(90.0, &mut poles), (89.999, &mut near_poles)] {
                let p = PlanetPosition::from_latitude_longitude_deg(sign * lat, lon as f64);
                let value = field.sample(p, fast_geology_influence(geo, p).1);
                output[0] = output[0].max((value.k - reference.k).abs());
                output[1] = output[1].max((value.b - reference.b).abs());
            }
        }
    }
    json!({"fields":["Kprime","Bprime"],"seam_max_delta":seam,"exact_pole_longitude_max_delta":poles,"near_pole_89_999_max_delta_from_pole":near_poles})
}

#[test]
fn planet_candidate_area_match_respects_rounded_water_and_ties() {
    let config = &candidate_fixtures()[0].config;
    let grid = Grid::new(32, 16, 6371.0);
    let raw = (0..grid.count() + 2)
        .map(|i| ((i * 53 % 111) as f32 - 55.0) * 0.001)
        .collect::<Vec<_>>();
    let target = 0.71;
    let (threshold, bound) = area_threshold(&raw, &grid, config, target);
    let mask = raw
        .iter()
        .map(|&h| stored_elevation(h, threshold, config) > 0)
        .collect::<Vec<_>>();
    assert!((water_area(&grid, &mask) - target).abs() <= bound + 1e-12);
    let relative = first_land_relative(config);
    for raw in [
        -1.0,
        -0.1,
        0.0,
        relative,
        next_float(relative, true),
        0.1,
        1.0,
    ] {
        let threshold = first_water_threshold(raw, relative);
        assert_eq!(stored_elevation(raw, threshold, config), 0);
        assert!(stored_elevation(raw, next_float(threshold, false), config) > 0);
    }
}
