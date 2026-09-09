//! Stage 4A OBSERVED / PROVISIONAL / DIAGNOSTIC ONLY.
//! Nested in the cfg(test) evaluator solely to reuse frozen field/metric helpers.
//! No solver, accepted topology, runtime authority, or persistent model.
use super::*;
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::sync::OnceLock;
use std::time::Instant;

const REVISION: &str = "stage4a-observer-v1";
const SCOPE: &str = "OBSERVED / PROVISIONAL / DIAGNOSTIC ONLY";
const FRAG: &str = "fragmented_continent_intent_990500051_draft";
const LOW: &str = "low_fragmentation_intent_42_draft";
const CHANNELS: [&str; 8] = [
    "K_prime",
    "B_prime",
    "convergence",
    "divergence",
    "signed_shear",
    "absolute_shear",
    "C",
    "weighted_C",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
enum Status {
    Observed,
    Unknown,
    InfeasibleInObservedMask,
    Conflict,
    CalibrationRequired,
}

#[derive(Clone, Debug, Serialize)]
struct Anchor {
    provenance: &'static str,
    id: String,
    kind: &'static str,
    plate_id: String,
    source_index: usize,
    position: [f64; 3],
    reference_component: usize,
    province_phase_area_km2: f64,
    interior_distance_km: f64,
    clearance_m: Option<f64>,
    geology: Value,
    major_adequacy: Status,
}

// The same typed domain is used for observations and synthetic requests.
// Local passage/outlet identity is distinct from global ocean connectivity.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
enum Domain {
    Land,
    SublevelOcean,
    Passage,
    Outlet,
}

#[derive(Clone, Debug, Serialize)]
struct Relation {
    provenance: &'static str,
    id: String,
    domain: Domain,
    endpoints: [String; 2],
    locality_id: Option<String>,
    observed_connected: Option<bool>,
    status: Status,
}

fn relation(
    domain: Domain,
    a: &str,
    b: &str,
    locality: Option<&str>,
    connected: Option<bool>,
) -> Relation {
    let mut endpoints = [a.to_owned(), b.to_owned()];
    endpoints.sort();
    Relation {
        provenance: SCOPE,
        id: format!(
            "{domain:?}:{}:{}:{}",
            endpoints[0],
            endpoints[1],
            locality.unwrap_or("GLOBAL")
        ),
        domain,
        endpoints,
        locality_id: locality.map(str::to_owned),
        observed_connected: connected,
        status: if connected.is_some() {
            Status::Observed
        } else {
            Status::Unknown
        },
    }
}

fn validate(relation: &Relation, requested: &[bool], policy_calibrated: bool) -> Status {
    if requested.contains(&true) && requested.contains(&false) {
        return Status::Conflict;
    }
    let Some(actual) = relation.observed_connected else {
        return Status::Unknown;
    };
    if requested.iter().any(|&r| r != actual) {
        return Status::InfeasibleInObservedMask;
    }
    if !policy_calibrated {
        return Status::CalibrationRequired;
    }
    Status::Observed
}

fn connected(labels: &[usize], a: usize, b: usize) -> Option<bool> {
    if a >= labels.len() || b >= labels.len() || labels[a] == usize::MAX || labels[b] == usize::MAX
    {
        None
    } else {
        Some(labels[a] == labels[b])
    }
}

// Read-only path witness in an already observed mask. No costs or topology edits.
fn witness_path(
    grid: &Grid,
    mask: &[bool],
    a: usize,
    b: usize,
    corridor: Option<&[bool]>,
) -> Option<Vec<usize>> {
    let allowed = |i: usize| {
        mask.get(i).copied().unwrap_or(false)
            && corridor.is_none_or(|c| c.get(i).copied().unwrap_or(false))
    };
    if !allowed(a) || !allowed(b) {
        return None;
    }
    let mut parent = vec![usize::MAX; mask.len()];
    let mut queue = VecDeque::from([a]);
    parent[a] = a;
    while let Some(i) = queue.pop_front() {
        if i == b {
            let mut path = vec![b];
            while *path.last().unwrap() != a {
                path.push(parent[*path.last().unwrap()]);
            }
            path.reverse();
            return Some(path);
        }
        let mut neighbors = grid
            .neighbors(i)
            .iter()
            .map(|&(j, _)| j)
            .collect::<Vec<_>>();
        neighbors.sort_unstable();
        for j in neighbors {
            if allowed(j) && parent[j] == usize::MAX {
                parent[j] = i;
                queue.push_back(j);
            }
        }
    }
    None
}

fn evidence_channels(legacy: &Components, sample: &CandidateSample) -> [f64; 8] {
    [
        sample.k,
        sample.b,
        sample.normal_response.max(0.0),
        (-sample.normal_response).max(0.0),
        sample.shear_response,
        sample.shear_response.abs(),
        legacy.c,
        legacy.c * 0.72,
    ]
}

fn evidence(
    grid: &Grid,
    legacy: &[Components],
    samples: &[CandidateSample],
    mask: &[bool],
    indices: &[usize],
    area_weighted: bool,
) -> Value {
    // Canonical source order fixes summation regardless of discovery/worker order.
    let mut indices = indices.to_vec();
    indices.sort_unstable();
    indices.dedup();
    let mut total = 0.0;
    let mut land = 0.0;
    let mut sums = [0.0; 8];
    let mut land_sums = [0.0; 8];
    let mut conditional = [[0.0; 2]; 2];
    for &i in &indices {
        let weight = if area_weighted { grid.area[i] } else { 1.0 };
        total += weight;
        let values = evidence_channels(&legacy[i], &samples[i]);
        for k in 0..8 {
            sums[k] += weight * values[k];
        }
        if mask[i] {
            land += weight;
            for k in 0..8 {
                land_sums[k] += weight * values[k];
            }
        }
        let category = if legacy[i].crust == 0.58 {
            Some(0)
        } else if legacy[i].crust == -0.52 {
            Some(1)
        } else {
            None
        };
        if let Some(c) = category {
            conditional[c][0] += weight;
            if mask[i] {
                conditional[c][1] += weight;
            }
        }
    }
    let means = |s: [f64; 8], denominator: f64| {
        CHANNELS
            .iter()
            .enumerate()
            .map(|(i, &name)| (name, divide(s[i], denominator)))
            .collect::<BTreeMap<_, _>>()
    };
    json!({"provenance":SCOPE,"weighting":if area_weighted {"SPHERICAL_AREA"} else {"UNWEIGHTED_UNIQUE_PATH_OR_ANCHOR_SAMPLES"},
        "sample_count":indices.len(),"weight_sum":total,"land_weight":land,"land_fraction":divide(land,total),
        "land_given_continental":divide(conditional[0][1],conditional[0][0]),"land_given_oceanic":divide(conditional[1][1],conditional[1][0]),
        "mean":means(sums,total),"land_mean":means(land_sums,land),"combined_score":null,"compatibility":Status::CalibrationRequired})
}

struct Input {
    fixture: CandidateFixture,
    geo: CausalGeologyModel,
    grid: Grid,
    legacy: Vec<Components>,
    samples: Vec<CandidateSample>,
    raw: Vec<f32>,
    reference: Vec<bool>,
    surface: PlanetSurface,
    fidelity: Value,
}

fn oracle() -> Value {
    serde_json::from_str(include_str!(
        "../tests/fixtures/planet_stage4a_evidence.json"
    ))
    .unwrap()
}

fn load_input(id: &str) -> Input {
    let fixture = candidate_fixtures()
        .into_iter()
        .find(|f| f.id == id)
        .unwrap();
    let expected = oracle();
    assert_eq!(
        serde_json::to_value(&fixture).unwrap(),
        expected["fixtures"][id]["fixture"],
        "full config changed"
    );
    let config = &fixture.config;
    let geo = geology_for(config);
    let surface = PlanetSurface::generate(config, &geo);
    let (w, h) = PlanetSurface::dimensions_for_quality(config.quality);
    let grid = Grid::new(w as usize, h as usize, config.physical.radius_m / 1000.0);
    let legacy = observe(config, &geo);
    let field = CandidateField::new(config, &geo);
    let samples = legacy
        .par_iter()
        .map(|s| field.sample(s.position, s.boundary))
        .collect::<Vec<_>>();
    let raw = raw_variant("continuous_K_kinematic_B", &legacy, &samples, config, false);
    let h_hash = checksum(raw.iter().flat_map(|v| v.to_le_bytes()));
    let channels_hash = checksum(legacy.iter().zip(&samples).flat_map(|(s, c)| {
        let [_, _, k, b] = s.weighted(config);
        [
            s.c,
            s.d,
            k,
            c.k,
            b,
            c.b,
            c.normal_response,
            c.shear_response,
            c.k_gradient_per_rad,
        ]
        .into_iter()
        .flat_map(f64::to_le_bytes)
    }));
    assert_eq!(h_hash, expected["fixtures"][id]["H_fnv"]);
    assert_eq!(channels_hash, expected["fixtures"][id]["channels_fnv"]);
    let original = raw_variant("Legacy", &legacy, &samples, config, false);
    let threshold = quantile(
        &original[..grid.count()],
        config.hydrosphere.target_ocean_coverage.unwrap(),
    );
    check_legacy(&fixture, &surface, &original[..grid.count()], threshold);
    let reference = make_mask(&original, threshold, config);
    Input {
        fixture,
        geo,
        grid,
        legacy,
        samples,
        raw,
        reference,
        surface,
        fidelity: json!({"H_fnv":h_hash,"channels_fnv":channels_hash,"Stage3_field_bytes":"EXACT_MATCH","legacy_frozen_snapshot":"PASS"}),
    }
}

fn extract_anchors(
    input: &Input,
    family: &str,
    phase: &[bool],
    land: bool,
    clearance: Option<&[i16]>,
    discovery: &[usize],
) -> Vec<Anchor> {
    let grid = &input.grid;
    let distance = grid.coast_distances(phase);
    let (labels, _) = grid.components(phase, false);
    let config_hash = checksum(serde_json::to_vec(&input.fixture.config).unwrap());
    let kind = if land { "land-core" } else { "sublevel-port" };
    let land_mask = phase
        .iter()
        .map(|&p| if land { p } else { !p })
        .collect::<Vec<_>>();
    let mut anchors = Vec::new();
    for &owner in discovery {
        let indices = (0..grid.count())
            .filter(|&i| phase[i] && input.legacy[i].owner == owner)
            .collect::<Vec<_>>();
        let Some(index) = indices.iter().copied().max_by(|&a, &b| {
            let k = |i: usize| {
                if land {
                    input.samples[i].k
                } else {
                    -input.samples[i].k
                }
            };
            let margin = |i: usize| clearance.map_or(0.0, |e| f64::from(e[i]).abs());
            distance[a]
                .total_cmp(&distance[b])
                .then(k(a).total_cmp(&k(b)))
                .then(margin(a).total_cmp(&margin(b)))
                .then(b.cmp(&a))
        }) else {
            continue;
        };
        let plate_id = input.geo.plates[owner].id.clone();
        anchors.push(Anchor {
            provenance: SCOPE,
            id: format!("{REVISION}:{config_hash}:{family}:{plate_id}:{kind}"),
            kind,
            plate_id,
            source_index: index,
            position: grid.points[index].components(),
            reference_component: labels[index],
            province_phase_area_km2: indices.iter().map(|&i| grid.area[i]).sum(),
            interior_distance_km: distance[index],
            clearance_m: clearance.map(|e| f64::from(e[index]).abs()),
            geology: evidence(
                grid,
                &input.legacy,
                &input.samples,
                &land_mask,
                &[index],
                false,
            ),
            major_adequacy: Status::CalibrationRequired,
        });
    }
    anchors.sort_by(|a, b| a.id.cmp(&b.id));
    anchors.dedup_by(|a, b| a.id == b.id);
    anchors
}

fn pairs(anchors: &[Anchor], labels: &[usize], domain: Domain) -> Vec<Relation> {
    let mut result = Vec::new();
    for (i, a) in anchors.iter().enumerate() {
        for b in &anchors[i + 1..] {
            result.push(relation(
                domain,
                &a.id,
                &b.id,
                None,
                connected(labels, a.source_index, b.source_index),
            ));
        }
    }
    result.sort_by(|a, b| a.id.cmp(&b.id));
    result
}

fn route(
    input: &Input,
    mask: &[bool],
    anchors: &[Anchor],
    relation: &Relation,
    elevations: Option<&[i16]>,
    next: Option<&[bool]>,
) -> Value {
    let endpoints = relation
        .endpoints
        .each_ref()
        .map(|id| anchors.iter().find(|a| &a.id == id).unwrap().source_index);
    let path = witness_path(&input.grid, mask, endpoints[0], endpoints[1], None).unwrap();
    let distances = input.grid.coast_distances(mask);
    let minimum = path
        .iter()
        .copied()
        .min_by(|&a, &b| distances[a].total_cmp(&distances[b]).then(a.cmp(&b)))
        .unwrap();
    let width = 2.0 * distances[minimum];
    let local_spacing = input
        .grid
        .neighbors(minimum)
        .iter()
        .map(|&(_, d)| d)
        .fold(0.0, f64::max);
    let length: f64 = path
        .windows(2)
        .map(|p| {
            input.grid.points[p[0]].angular_distance_rad(input.grid.points[p[1]])
                * input.grid.radius_km
        })
        .sum();
    let lost = path
        .iter()
        .copied()
        .filter(|&i| next.is_some_and(|m| !m[i]))
        .collect::<Vec<_>>();
    json!({"provenance":SCOPE,"relation":relation,"source_indices":path,"path_length_km":length,
        "endpoint_geodesic_km":input.grid.points[endpoints[0]].angular_distance_rad(input.grid.points[endpoints[1]])*input.grid.radius_km,
        "width_proxy_km":width,"width_bottleneck_index":minimum,"local_spacing_km":local_spacing,
        "width_status":if width < 2.0*local_spacing {"UNRESOLVED_AT_RESOLUTION"} else {"APPROXIMATE"},
        "minimum_clearance_m":elevations.map(|e|path.iter().map(|&i|f64::from(e[i]).abs()).fold(f64::INFINITY,f64::min)),
        "clearance_status":if elevations.is_some(){"OBSERVED_STORED_METERS"}else{"UNKNOWN"},
        "lost_path_cells_at_next_q":lost,"lost_cells_are_unique_cut_certificate":false,
        "geology":evidence(&input.grid,&input.legacy,&input.samples,mask,&path,false)})
}

fn geology_decomposition(input: &Input, mask: &[bool]) -> Value {
    let mut provinces = BTreeMap::new();
    for (owner, p) in input.geo.plates.iter().enumerate() {
        let indices = (0..input.grid.count())
            .filter(|&i| input.legacy[i].owner == owner)
            .collect::<Vec<_>>();
        provinces.insert(p.id.clone(),json!({"owner_crust":format!("{:?}",p.crust),"evidence":evidence(&input.grid,&input.legacy,&input.samples,mask,&indices,true)}));
    }
    json!({"global":evidence(&input.grid,&input.legacy,&input.samples,mask,&(0..input.grid.count()).collect::<Vec<_>>(),true),"provinces":provinces})
}

fn compare_metrics(actual: &Value, expected: &Value) {
    for (key, value) in expected.as_object().unwrap() {
        let tolerance = if key.contains("km") { 1e-5 } else { 1e-10 };
        if let Some(n) = value.as_u64() {
            assert_eq!(actual[key].as_u64(), Some(n), "{key}");
        } else {
            assert!(
                (actual[key].as_f64().unwrap() - value.as_f64().unwrap()).abs() <= tolerance,
                "metric fidelity: {key}: {} != {value}",
                actual[key]
            );
        }
    }
}

fn compact_metrics(metrics: &Value) -> Value {
    [
        "land_area_km2",
        "ocean_spherical",
        "land_components",
        "largest_land_fraction",
        "coast_crossing_mixed_crust_fraction",
        "land_given_continental",
        "land_given_oceanic",
    ]
    .into_iter()
    .map(|k| (k.to_owned(), metrics[k].clone()))
    .collect()
}

fn consumer_poles(input: &Input) -> Value {
    let mut observations = Vec::new();
    for latitude in [90.0, -90.0] {
        let p = PlanetPosition::from_latitude_longitude_deg(latitude, 0.0);
        let direct = input.surface.sample(p);
        let interpolated = input.surface.sample_interpolated(p);
        for longitude in [-180.0, -73.0, 0.0, 49.0, 180.0] {
            let point = PlanetPosition::from_latitude_longitude_deg(latitude, longitude);
            assert_eq!(input.surface.sample(point), direct);
            assert_eq!(input.surface.sample_interpolated(point), interpolated);
        }
        let pole = input.grid.count() + usize::from(latitude < 0.0);
        observations.push(json!({"latitude":latitude,"consumer_elevation_m":direct.elevation_m,
            "consumer_water_threshold_flag":direct.water,"historical_legacy_field_probe_land":input.reference[pole],
            "historical_and_consumer_classification_differ":input.reference[pole] == direct.water,
            "historical_probe_is_consumer_authority":false}));
    }
    for latitude in [-89.9, -30.0, 0.0, 55.0, 89.9] {
        let a = input
            .surface
            .sample_interpolated(PlanetPosition::from_latitude_longitude_deg(
                latitude, -180.0,
            ));
        let b = input
            .surface
            .sample_interpolated(PlanetPosition::from_latitude_longitude_deg(latitude, 180.0));
        assert!((a.elevation_m - b.elevation_m).abs() < 1e-4);
        assert_eq!(a.water, b.water);
    }
    json!({"fixed_consumer_api":"PASS","seam":"PASS","poles":observations})
}

fn coast_first_mask() -> Vec<bool> {
    let data = oracle();
    let cf = &data["coast_first"];
    let mut mask = vec![false; cf["length"].as_u64().unwrap() as usize];
    for run in cf["land_runs"].as_array().unwrap() {
        let start = run[0].as_u64().unwrap() as usize;
        let count = run[1].as_u64().unwrap() as usize;
        for cell in &mut mask[start..start + count] {
            assert!(!*cell);
            *cell = true;
        }
    }
    assert_eq!(checksum(mask.iter().map(|&m| u8::from(m))), cf["mask_fnv"]);
    mask
}

fn observe_fixture(id: &str, reverse_discovery: bool) -> (Value, Value) {
    let start = Instant::now();
    let input = load_input(id);
    let field_seconds = start.elapsed().as_secs_f64();
    let stage = Instant::now();
    let grid = &input.grid;
    let config = &input.fixture.config;
    let q = config.hydrosphere.target_ocean_coverage.unwrap();
    let thresholds =
        [-0.02, -0.01, 0.0, 0.01, 0.02].map(|d| quantile(&input.raw[..grid.count()], q + d));
    let masks = thresholds.map(|t| make_mask(&input.raw, t, config));
    let elevations = thresholds.map(|t| {
        input
            .raw
            .iter()
            .map(|&v| stored_elevation(v, t, config))
            .collect::<Vec<_>>()
    });
    let mut discovery = (0..input.geo.plates.len()).collect::<Vec<_>>();
    if reverse_discovery {
        discovery.reverse();
    }
    let anchors = extract_anchors(
        &input,
        "height_first",
        &masks[0],
        true,
        Some(&elevations[0]),
        &discovery,
    );
    let water = masks[0].iter().map(|&v| !v).collect::<Vec<_>>();
    let ports = extract_anchors(
        &input,
        "height_first",
        &water,
        false,
        Some(&elevations[0]),
        &discovery,
    );
    let expected = oracle();
    let controls = &expected["fixtures"][id];
    let mut probes = Vec::new();
    let mut all_relations = Vec::new();
    for (j, mask) in masks.iter().enumerate() {
        let t = topology(grid, mask, &masks[2]);
        let old = &controls["q_controls"][j];
        assert_eq!(
            thresholds[j].to_bits() as u64,
            old["threshold_bits"].as_u64().unwrap()
        );
        for key in ["ocean_spherical", "components", "a1_land"] {
            assert!(
                (t[key].as_f64().unwrap() - old[key].as_f64().unwrap()).abs() < 1e-10,
                "q control {key}"
            );
        }
        let (labels, _) = grid.components(mask, false);
        let relations = pairs(&anchors, &labels, Domain::Land);
        let sublevel = mask.iter().map(|&v| !v).collect::<Vec<_>>();
        let (water_labels, _) = grid.components(&sublevel, false);
        probes.push(json!({"q":old["q"],"threshold_bits":thresholds[j].to_bits(),"control":t,
            "land_relations":relations,"sublevel_port_relations":pairs(&ports,&water_labels,Domain::SublevelOcean),
            "actual_flooded_relations":Status::Unknown,"local_passage_identity":Status::Unknown}));
        all_relations.push(relations);
    }
    let mut splits = Vec::new();
    for j in 0..4 {
        let changed = all_relations[j]
            .iter()
            .zip(&all_relations[j + 1])
            .filter(|(a, b)| a.observed_connected != b.observed_connected)
            .collect::<Vec<_>>();
        let split = changed.iter().find(|(a, b)| {
            a.observed_connected == Some(true) && b.observed_connected == Some(false)
        });
        splits.push(json!({"from_q":controls["q_controls"][j]["q"],"to_q":controls["q_controls"][j+1]["q"],
            "changes":changed.iter().map(|(a,b)|json!({"id":a.id,"endpoints":a.endpoints,"before":a.observed_connected,"after":b.observed_connected})).collect::<Vec<_>>(),
            "witness":split.map(|(a,_)|route(&input,&masks[j],&anchors,a,Some(&elevations[j]),Some(&masks[j+1])))}));
    }
    let topology_seconds = stage.elapsed().as_secs_f64();
    let stage = Instant::now();
    let cell = measure(grid, &masks[2], &input.reference, &input.legacy).0;
    compare_metrics(&cell, &controls["cell_metrics"]);
    let (area_threshold, _) =
        area_threshold(&input.raw, grid, config, water_area(grid, &input.reference));
    let area_mask = make_mask(&input.raw, area_threshold, config);
    let area = measure(grid, &area_mask, &input.reference, &input.legacy).0;
    compare_metrics(&area, &controls["area_metrics"]);
    let mut cf = Value::Null;
    if id == expected["coast_first"]["fixture"].as_str().unwrap() {
        let mask = coast_first_mask();
        let metrics = measure(grid, &mask, &input.reference, &input.legacy).0;
        compare_metrics(&metrics, &expected["coast_first"]["metrics"]);
        let cores = extract_anchors(
            &input,
            "coast_first_imported",
            &mask,
            true,
            None,
            &discovery,
        );
        let (labels, _) = grid.components(&mask, false);
        let relations = pairs(&cores, &labels, Domain::Land);
        let routes = relations
            .iter()
            .filter(|r| r.observed_connected == Some(true))
            .map(|r| route(&input, &mask, &cores, r, None, None))
            .collect::<Vec<_>>();
        cf = json!({"source":"IMPORTED_EXISTING_COAST_FIRST_MASK_NO_GENERATOR_RUN","mask_fnv":expected["coast_first"]["mask_fnv"],
            "metrics":compact_metrics(&metrics),"geology":geology_decomposition(&input,&mask),"land_cores":cores,"land_relations":relations,"routes":routes});
    }
    let geology = geology_decomposition(&input, &masks[2]);
    let measurement_seconds = stage.elapsed().as_secs_f64();
    let stage = Instant::now();
    let poles = consumer_poles(&input);
    let after = PlanetSurface::generate(config, &input.geo);
    assert_eq!(input.surface, after, "observer changed PlanetSurface");
    let before_bytes = serde_json::to_vec(&input.surface).unwrap();
    assert_eq!(before_bytes, serde_json::to_vec(&after).unwrap());
    let after_field = CandidateField::new(config, &input.geo);
    let after_samples = input
        .legacy
        .par_iter()
        .map(|s| after_field.sample(s.position, s.boundary))
        .collect::<Vec<_>>();
    assert_eq!(
        input.raw,
        raw_variant(
            "continuous_K_kinematic_B",
            &input.legacy,
            &after_samples,
            config,
            false
        )
    );
    let production_seconds = stage.elapsed().as_secs_f64();
    let mut data = json!({"revision":REVISION,"provenance":SCOPE,"fixture":input.fixture,"field_fidelity":input.fidelity,
        "control_fidelity":"PASS","cell_metrics":compact_metrics(&cell),"area_matched_metrics":compact_metrics(&area),
        "land_cores":anchors,"sublevel_ports":ports,"q_probes":probes,"semantic_transitions":splits,
        "height_first_geology":geology,"coast_first":cf,"consumer_sampling":poles,
        "production_preservation":{"surface_and_serialization":"EXACT_MATCH","surface_fnv":checksum(before_bytes),"candidate_output":"EXACT_MATCH","persistent_authority":"NONE"},
        "water_semantics":{"sublevel":"OBSERVED_STORED_ELEVATION_LE_ZERO","actual_ocean_connected_flooded":"UNRESOLVED_NO_OCEAN_SOURCE_PROVENANCE","isolated_dry_basin":"UNRESOLVED_NO_RESERVOIR_PROVENANCE","auto_filled_closed_basin":false},
        "provisional_major_topology_constraint":{"provenance":SCOPE,"relations":"q_probes / semantic_transitions","accepted":false,"minimum_width_km":null,"minimum_clearance_m":null,"major_hierarchy":null,"geology_weights":null,"status":Status::CalibrationRequired}});
    let fingerprint = checksum(serde_json::to_vec(&data).unwrap());
    data["fingerprint"] = json!(fingerprint);
    let timing = json!({"field_and_production_before_seconds":field_seconds,"topology_and_split_routes_seconds":topology_seconds,
        "metrics_and_geology_seconds":measurement_seconds,"preservation_and_sampling_seconds":production_seconds,"total_seconds":start.elapsed().as_secs_f64(),
        "rayon_worker_count":rayon::current_num_threads(),
        "peak_memory":"UNMEASURED","memory_note":"No dedicated profiler; no peak estimate substituted for measurement."});
    (data, timing)
}

fn critical() -> &'static [(Value, Value); 2] {
    static RESULTS: OnceLock<[(Value, Value); 2]> = OnceLock::new();
    RESULTS.get_or_init(|| {
        rayon::ThreadPoolBuilder::new()
            .num_threads(3)
            .build()
            .unwrap()
            .install(|| [observe_fixture(FRAG, false), observe_fixture(LOW, false)])
    })
}

#[test]
fn planet_stage4a_production_preservation_and_control_fidelity() {
    for (data, _) in critical() {
        assert_eq!(data["control_fidelity"], "PASS");
        assert_eq!(
            data["production_preservation"]["surface_and_serialization"],
            "EXACT_MATCH"
        );
        assert_eq!(
            data["production_preservation"]["candidate_output"],
            "EXACT_MATCH"
        );
    }
}

#[test]
fn planet_stage4a_deterministic_workers_and_discovery() {
    // Both existing fixtures; changed worker count, execution and owner discovery order.
    for id in [LOW, FRAG] {
        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(1)
            .build()
            .unwrap();
        let replay = pool.install(|| observe_fixture(id, true)).0;
        let expected = &critical()
            .iter()
            .find(|(v, _)| v["fixture"]["id"] == id)
            .unwrap()
            .0;
        assert_eq!(&replay, expected);
    }
}

#[test]
fn planet_stage4a_spherical_geometry_rotation_and_relabel() {
    let grid = Grid::new(16, 8, 6371.0);
    let total: f64 = grid.area.iter().sum();
    let north: f64 = grid.area[..grid.count() / 2].iter().sum();
    assert!((total / (4.0 * PI * grid.radius_km.powi(2)) - 1.0).abs() < 1e-10);
    assert!((north / total - 0.5).abs() < 1e-10);
    let rotate = |p: PlanetPosition| {
        let [x, y, z] = p.components();
        PlanetPosition::new(z, x, y).unwrap()
    };
    let x = PlanetPosition::new(1.0, 0.0, 0.0).unwrap();
    let y = PlanetPosition::new(0.0, 1.0, 0.0).unwrap();
    assert!((x.angular_distance_rad(y) - FRAC_PI_2).abs() < 1e-10);
    for i in 0..grid.points.len() {
        for &(j, d) in grid.neighbors(i) {
            let rotated = rotate(grid.points[i]).angular_distance_rad(rotate(grid.points[j]))
                * grid.radius_km;
            assert!((rotated - d).abs() < 1e-5);
        }
    }
    let mask = (0..grid.points.len())
        .map(|i| i < grid.count() / 2 || i == grid.count())
        .collect::<Vec<_>>();
    let (labels, groups) = grid.components(&mask, false);
    assert_eq!(groups.len(), 1);
    let shift = |i: usize| {
        if i < grid.count() {
            (grid.height - 1 - i / grid.width) * grid.width + (i % grid.width + 3) % grid.width
        } else {
            grid.count() + 1 - (i - grid.count())
        }
    };
    let mut relabeled = vec![false; mask.len()];
    for i in 0..mask.len() {
        relabeled[shift(i)] = mask[i];
        assert!((grid.area[i] - grid.area[shift(i)]).abs() < 1e-5);
    }
    let (other, other_groups) = grid.components(&relabeled, false);
    assert_eq!(groups.len(), other_groups.len());
    for a in 0..mask.len() {
        for b in 0..mask.len() {
            assert_eq!(
                connected(&labels, a, b),
                connected(&other, shift(a), shift(b))
            );
        }
    }
}

#[test]
fn planet_stage4a_land_connectivity_and_status_separation() {
    let grid = Grid::new(8, 4, 1.0);
    let mut mask = vec![false; grid.count() + 2];
    for i in [8, 9, 12] {
        mask[i] = true;
    }
    let (labels, _) = grid.components(&mask, false);
    let r = relation(
        Domain::Land,
        "core-b",
        "core-a",
        None,
        connected(&labels, 8, 9),
    );
    assert_eq!(validate(&r, &[true], true), Status::Observed);
    assert_eq!(validate(&r, &[true], false), Status::CalibrationRequired);
    let separated = relation(Domain::Land, "a", "c", None, connected(&labels, 8, 12));
    assert_eq!(
        validate(&separated, &[true], true),
        Status::InfeasibleInObservedMask
    );
    assert_eq!(
        validate(
            &relation(Domain::Land, "a", "missing", None, connected(&labels, 8, 0)),
            &[true],
            true
        ),
        Status::Unknown
    );
    assert_eq!(
        r.id,
        relation(Domain::Land, "core-a", "core-b", None, Some(true)).id
    );
    assert_eq!(witness_path(&grid, &mask, 8, 9, None), Some(vec![8, 9]));
}

#[test]
fn planet_stage4a_ocean_locality_and_source_provenance() {
    let grid = Grid::new(8, 4, 1.0);
    let mut sublevel = vec![false; grid.count() + 2];
    for i in [8, 9, 10, 12] {
        sublevel[i] = true;
    }
    let (labels, _) = grid.components(&sublevel, false);
    assert_eq!(connected(&labels, 8, 10), Some(true));
    let mut corridor = sublevel.clone();
    corridor[9] = false;
    assert!(witness_path(&grid, &sublevel, 8, 10, None).is_some());
    assert!(witness_path(&grid, &sublevel, 8, 10, Some(&corridor)).is_none());
    let global = relation(Domain::SublevelOcean, "a", "b", None, Some(true));
    let local = relation(Domain::Passage, "a", "b", Some("named-corridor"), None);
    assert_ne!(global.id, local.id);
    assert_eq!(validate(&local, &[true], false), Status::Unknown);
    // Explicit synthetic source only: read component membership, do not fill water.
    let source = 8;
    assert_eq!(connected(&labels, source, 10), Some(true));
    assert_eq!(connected(&labels, source, 12), Some(false));
    assert!(sublevel[12]); // Isolated sublevel is never automatically flooded.
    let outlet = relation(Domain::Outlet, "basin", "sea", Some("outlet-1"), None);
    assert_eq!(outlet.status, Status::Unknown);
}

#[test]
fn planet_stage4a_land_contradiction_is_explicit_conflict() {
    let r = relation(Domain::Land, "a", "b", None, Some(true));
    assert_eq!(validate(&r, &[true, false], false), Status::Conflict);
    assert_eq!(validate(&r, &[false, true], true), Status::Conflict);
}

#[test]
fn planet_stage4a_ocean_contradiction_is_explicit_conflict() {
    for domain in [Domain::Passage, Domain::Outlet] {
        let r = relation(domain, "port-a", "port-b", Some("passage-1"), None);
        assert_eq!(validate(&r, &[true, false], false), Status::Conflict);
    }
}

#[test]
fn planet_stage4a_geology_channels_keep_candidate_definitions() {
    let config = candidate_fixtures()
        .into_iter()
        .find(|f| f.id == LOW)
        .unwrap()
        .config;
    let geo = geology_for(&config);
    let field = CandidateField::new(&config, &geo);
    let grid = Grid::new(16, 8, config.physical.radius_m / 1000.0);
    let mut signs = BTreeSet::new();
    for p in grid.points {
        let legacy = observe_point(&config, &geo, p);
        let sample = field.sample(p, legacy.boundary);
        let values = evidence_channels(&legacy, &sample);
        assert!((values[2] - values[3] - sample.normal_response).abs() < 1e-14);
        assert_eq!(values[5], values[4].abs());
        assert!(sample.k >= -0.1456 - 1e-14 && sample.k <= 0.1624 + 1e-14);
        let b = (0.05 + 0.20 * config.tectonics.orogenic_activity.clamp(0.0, 1.0))
            * legacy.boundary
            * (values[2] - values[3]);
        assert!((b - sample.b).abs() < 1e-14);
        signs.insert(sample.normal_response > 0.0);
    }
    assert_eq!(signs.len(), 2);
}

#[test]
fn planet_stage4a_frag990_stable_core_split_witness() {
    let data = &critical()[0].0;
    let ids = data["land_cores"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["id"].as_str().unwrap())
        .collect::<BTreeSet<_>>();
    let mut splits = 0;
    for transition in data["semantic_transitions"].as_array().unwrap() {
        if !transition["witness"].is_null() {
            splits += 1;
            let w = &transition["witness"];
            assert!(
                !w["lost_path_cells_at_next_q"]
                    .as_array()
                    .unwrap()
                    .is_empty()
            );
            for id in w["relation"]["endpoints"].as_array().unwrap() {
                assert!(ids.contains(id.as_str().unwrap()));
            }
            assert!(
                transition["changes"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|c| c["before"] == true && c["after"] == false)
            );
        }
    }
    assert!(
        splits > 0,
        "no semantic split witness: Stage 4A cannot proceed"
    );
}

#[test]
fn planet_stage4a_low42_inversion_is_decomposed() {
    let cf = &critical()[1].0["coast_first"];
    let global = &cf["geology"]["global"];
    assert!(
        global["land_given_continental"].as_f64().unwrap()
            < global["land_given_oceanic"].as_f64().unwrap()
    );
    let provinces = cf["geology"]["provinces"].as_object().unwrap();
    for key in ["land_given_continental", "land_given_oceanic"] {
        assert!(
            (global[key].as_f64().unwrap() - cf["metrics"][key].as_f64().unwrap()).abs() < 1e-10
        );
    }
    // Local evidence must reconstruct the global result without hiding any province.
    for key in CHANNELS {
        let weighted: f64 = provinces
            .values()
            .map(|p| {
                let e = &p["evidence"];
                e["mean"][key].as_f64().unwrap() * e["weight_sum"].as_f64().unwrap()
            })
            .sum();
        assert!(
            (weighted / global["weight_sum"].as_f64().unwrap()
                - global["mean"][key].as_f64().unwrap())
            .abs()
                < 1e-10
        );
    }
    assert!(
        provinces.values().any(|p| p["owner_crust"] == "Oceanic"
            && p["evidence"]["land_fraction"].as_f64().unwrap() > 0.0)
    );
    assert!(
        cf["land_cores"]
            .as_array()
            .unwrap()
            .iter()
            .any(|a| a["geology"]["mean"]["K_prime"].as_f64().unwrap() < 0.0)
    );
    assert!(
        cf["routes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["geology"]["mean"]["K_prime"].as_f64().unwrap() < 0.0)
    );
}

#[test]
fn planet_stage4a_pole_seam_and_no_production_authority() {
    for (data, _) in critical() {
        assert_eq!(data["consumer_sampling"]["fixed_consumer_api"], "PASS");
        assert_eq!(data["consumer_sampling"]["seam"], "PASS");
        assert_eq!(
            data["provisional_major_topology_constraint"]["accepted"],
            false
        );
        assert_eq!(
            data["provisional_major_topology_constraint"]["status"],
            "CALIBRATION_REQUIRED"
        );
        assert_eq!(data["water_semantics"]["auto_filled_closed_basin"], false);
    }
}

#[test]
#[ignore = "exports only the two authorized Stage 4A critical fixtures; needs URDR_STAGE4A_OUTPUT"]
fn planet_stage4a_export() {
    let root =
        std::env::var("URDR_STAGE4A_OUTPUT").expect("explicit external output directory required");
    let root = Path::new(&root);
    assert!(
        root.join("CALIBRATION_MANIFEST.md").is_file(),
        "lock calibration manifest before observation"
    );
    let names = [
        "critical-frag990.json",
        "critical-low42.json",
        "stage4a-summary.json",
    ];
    for name in names {
        assert!(
            !root.join(name).exists(),
            "never overwrite an earlier observation"
        );
    }
    let data = critical();
    for (i, name) in names[..2].iter().enumerate() {
        write_json(&root.join(name), &data[i].0);
    }
    let conflict = |domain| {
        let r = relation(domain, "a", "b", Some("synthetic"), None);
        json!({"relation":r,"requested_open_or_connected":[true,false],"status":validate(&r,&[true,false],false)})
    };
    write_json(
        &root.join(names[2]),
        &json!({"revision":REVISION,"provenance":SCOPE,"fixtures":data.iter().map(|(d,t)|json!({"id":d["fixture"]["id"],"fingerprint":d["fingerprint"],"timing":t})).collect::<Vec<_>>(),
        "synthetic_land_conflict":conflict(Domain::Land),"synthetic_ocean_conflict":conflict(Domain::Passage),
        "calibration_required":["major hierarchy/core adequacy","geology weights and caps","certified width/clearance","real ocean source/reservoir provenance","semantic passage/outlet identity","cross-resolution/cross-level safety"],
        "topology_solver":"NOT IMPLEMENTED","production_semantics":"UNCHANGED","schema_migration":"UNCHANGED","Stage4B":"NOT STARTED"}),
    );
}
