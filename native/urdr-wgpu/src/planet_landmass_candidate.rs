//! Stage 3 experimental fields. This module is a child of the test-only observer.
//! No production generator, saved recipe, or Region consumer calls these fields.
use super::*;

pub(super) const TRANSITION_FRACTION: f64 = 0.20;

pub(super) fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}
pub(super) fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    std::array::from_fn(|i| a[i] - b[i])
}
pub(super) fn mul(a: [f64; 3], b: f64) -> [f64; 3] {
    a.map(|v| v * b)
}
pub(super) fn norm(a: [f64; 3]) -> f64 {
    dot(a, a).sqrt()
}
pub(super) fn unit(a: [f64; 3]) -> [f64; 3] {
    mul(a, 1.0 / norm(a))
}
pub(super) fn crust_value(crust: CrustType) -> f64 {
    match crust {
        CrustType::Continental => 0.58,
        CrustType::Oceanic => -0.52,
        CrustType::Transitional => 0.05,
    }
}

#[derive(Clone, Copy, Debug)]
pub(super) struct CandidateSample {
    pub(super) k: f64,
    pub(super) b: f64,
    pub(super) normal_response: f64,
    pub(super) shear_response: f64,
    pub(super) k_gradient_per_rad: f64,
}

pub(super) struct CandidateField {
    pub(super) kappa: f64,
    pub(super) spacing_rad: f64,
    pub(super) omega_scale: f64,
    pub(super) centers: Vec<[f64; 3]>,
    pub(super) omega: Vec<[f64; 3]>,
    crust: Vec<f64>,
    boundary_amplitude: f64,
}

impl CandidateField {
    pub(super) fn new(config: &PlanetGenerationConfig, geology: &CausalGeologyModel) -> Self {
        assert!(geology.plates.len() >= 2);
        let centers = geology
            .plates
            .iter()
            .map(|p| p.center.components())
            .collect::<Vec<_>>();
        let omega = geology
            .plates
            .iter()
            .map(|p| {
                mul(
                    p.euler_pole.components(),
                    p.angular_speed_deg_per_myr.to_radians(),
                )
            })
            .collect::<Vec<_>>();
        let mut nearest = (0..centers.len())
            .map(|i| {
                (0..centers.len())
                    .filter(|&j| i != j)
                    .map(|j| dot(centers[i], centers[j]).clamp(-1.0, 1.0).acos())
                    .fold(f64::INFINITY, f64::min)
            })
            .collect::<Vec<_>>();
        nearest.sort_by(f64::total_cmp);
        let spacing_rad = nearest[nearest.len() / 2];
        assert!(
            spacing_rad > 1e-8,
            "coincident plate centers are outside these fixtures"
        );
        // For a two-site boundary, w_i = logistic(2*kappa*sin(d/2)*sin(delta)).
        // Lock its 10–90 width to 20% of median nearest-site spacing, before export.
        let kappa = 9.0_f64.ln()
            / (2.0 * (spacing_rad * 0.5).sin() * (TRANSITION_FRACTION * spacing_rad * 0.5).sin());
        let mut omega_scale = 0.0_f64;
        for i in 0..omega.len() {
            for j in i + 1..omega.len() {
                omega_scale = omega_scale.max(norm(sub(omega[i], omega[j])));
            }
        }
        Self {
            kappa,
            spacing_rad,
            omega_scale,
            centers,
            omega,
            crust: geology
                .plates
                .iter()
                .map(|p| 0.28 * crust_value(p.crust))
                .collect(),
            boundary_amplitude: 0.05 + 0.20 * config.tectonics.orogenic_activity.clamp(0.0, 1.0),
        }
    }

    pub(super) fn sample(&self, p: PlanetPosition, legacy_boundary: f64) -> CandidateSample {
        let p = p.components();
        let maximum = self
            .centers
            .iter()
            .map(|&c| dot(c, p))
            .fold(f64::NEG_INFINITY, f64::max);
        let unnormalized = self
            .centers
            .iter()
            .map(|&c| (self.kappa * (dot(c, p) - maximum)).exp())
            .collect::<Vec<_>>();
        let sum: f64 = unnormalized.iter().sum();
        let weights = unnormalized.iter().map(|v| v / sum).collect::<Vec<_>>();
        let mut cbar = [0.0; 3];
        let mut vbar = [0.0; 3];
        let mut k = 0.0;
        // Removing a common rigid angular velocity makes the origin arbitrary;
        // it cannot create strain or change the normalization speed.
        let velocities = self
            .omega
            .iter()
            .map(|&w| cross(sub(w, self.omega[0]), p))
            .collect::<Vec<_>>();
        for i in 0..weights.len() {
            k += weights[i] * self.crust[i];
            for j in 0..3 {
                cbar[j] += weights[i] * self.centers[i][j];
                vbar[j] += weights[i] * velocities[i][j];
            }
        }
        let mut normal = 0.0;
        let mut shear = 0.0;
        let mut gradient = [0.0; 3];
        let mut geometric_variance = 0.0;
        for i in 0..weights.len() {
            let dc = sub(self.centers[i], cbar);
            let tangent = sub(dc, mul(p, dot(dc, p)));
            let dv = sub(velocities[i], vbar);
            normal -= weights[i] * dot(tangent, dv);
            shear += weights[i] * dot(cross(tangent, dv), p);
            geometric_variance += weights[i] * dot(tangent, tangent);
            for j in 0..3 {
                gradient[j] += self.kappa * weights[i] * (self.crust[i] - k) * tangent[j];
            }
        }
        // Cauchy bound: velocity variance <= max|delta omega|² * sum(i<j) wi wj.
        // Unlike normalization by local slip, this does not amplify slow motion.
        let mut pair_weight = 0.0;
        let mut prefix_weight = 0.0;
        for &wi in &weights {
            pair_weight += wi * prefix_weight;
            prefix_weight += wi;
        }
        let denominator = self.omega_scale * (geometric_variance * pair_weight).sqrt();
        let (normal_response, shear_response) = if denominator > 1e-20 {
            (
                (normal / denominator).clamp(-1.0, 1.0),
                (shear / denominator).clamp(-1.0, 1.0),
            )
        } else {
            (0.0, 0.0)
        };
        CandidateSample {
            k,
            b: self.boundary_amplitude * legacy_boundary * normal_response,
            normal_response,
            shear_response,
            k_gradient_per_rad: norm(gradient),
        }
    }

    pub(super) fn pair_motion(&self, p: PlanetPosition, i: usize, j: usize) -> (f64, f64) {
        let p = p.components();
        let delta = sub(self.centers[i], self.centers[j]);
        let normal = unit(sub(delta, mul(p, dot(delta, p))));
        let tangent = cross(p, normal);
        let velocity = cross(sub(self.omega[i], self.omega[j]), p);
        (-dot(velocity, normal), dot(velocity, tangent))
    }
}

pub(super) fn motion_kind(normal: f64, shear: f64) -> &'static str {
    if normal.abs() + shear.abs() < 1e-14 {
        "stationary"
    } else if normal.abs() >= shear.abs() {
        if normal > 0.0 {
            "convergent"
        } else {
            "divergent"
        }
    } else {
        "transform"
    }
}

#[derive(Deserialize, Serialize, Clone)]
pub(super) struct CandidateFixture {
    pub(super) id: String,
    pub(super) profile: String,
    pub(super) config: PlanetGenerationConfig,
}

pub(super) fn candidate_fixtures() -> Vec<CandidateFixture> {
    serde_json::from_str(include_str!(
        "../tests/fixtures/planet_landmass_candidate_profiles.json"
    ))
    .unwrap()
}

pub(super) fn check_legacy(
    fixture: &CandidateFixture,
    surface: &PlanetSurface,
    raw: &[f32],
    threshold: f32,
) {
    let expected: Value = serde_json::from_str(include_str!(
        "../tests/fixtures/planet_landmass_candidate_legacy_checksums.json"
    ))
    .unwrap();
    let actual = json!({"threshold_bits":threshold.to_bits(),"raw_h":checksum(raw.iter().flat_map(|v|v.to_le_bytes())),
        "elevation":checksum(surface.elevation_m.iter().flat_map(|v|v.to_le_bytes())),
        "terrain":checksum(surface.terrain.iter().copied()),"water":checksum(surface.elevation_m.iter().map(|&v|u8::from(v<=0)))});
    assert_eq!(
        actual, expected[&fixture.id],
        "expanded legacy snapshot mismatch {}",
        fixture.id
    );
}

fn pair_fixture() -> (PlanetGenerationConfig, CausalGeologyModel) {
    let config = fixtures()[0].clone();
    let mut geo = geology_for(&config);
    geo.plates.truncate(2);
    geo.plates[0].center = PlanetPosition::new(-1.0, 0.0, 0.0).unwrap();
    geo.plates[0].crust = CrustType::Continental;
    geo.plates[1].center = PlanetPosition::new(1.0, 0.0, 0.0).unwrap();
    geo.plates[1].crust = CrustType::Oceanic;
    (config, geo)
}

#[test]
fn planet_candidate_continuous_crust_has_no_owner_step_and_keeps_interiors() {
    let (config, geo) = pair_fixture();
    let field = CandidateField::new(&config, &geo);
    for i in 0..2 {
        assert!(
            (field.sample(geo.plates[i].center, 0.0).k - 0.28 * crust_value(geo.plates[i].crust))
                .abs()
                < 0.001
        );
    }
    let a = PlanetPosition::new(-1e-10, 1.0, 0.0).unwrap();
    let b = PlanetPosition::new(1e-10, 1.0, 0.0).unwrap();
    assert!((field.sample(a, 1.0).k - field.sample(b, 1.0).k).abs() < 1e-9);
    assert!(
        (0.28 * (fast_geology_influence(&geo, a).0 - fast_geology_influence(&geo, b).0) - 0.308)
            .abs()
            < 1e-12
    );
    let delta = field.spacing_rad * TRANSITION_FRACTION * 0.5;
    let low = field
        .sample(
            PlanetPosition::new(delta.sin(), delta.cos(), 0.0).unwrap(),
            1.0,
        )
        .k;
    let high = field
        .sample(
            PlanetPosition::new(-delta.sin(), delta.cos(), 0.0).unwrap(),
            1.0,
        )
        .k;
    assert!(((high - low) / 0.308 - 0.8).abs() < 1e-12);
}

#[test]
fn planet_candidate_relative_motion_sign_shear_and_rigid_rotation() {
    let (config, mut geo) = pair_fixture();
    let p = PlanetPosition::new(0.0, 1.0, 0.0).unwrap();
    for plate in &mut geo.plates {
        plate.angular_speed_deg_per_myr = 1.0;
    }
    for sign in [1.0, -1.0] {
        geo.plates[0].euler_pole = PlanetPosition::new(0.0, 0.0, -sign).unwrap();
        geo.plates[1].euler_pole = PlanetPosition::new(0.0, 0.0, sign).unwrap();
        let s = CandidateField::new(&config, &geo).sample(p, 1.0);
        assert!((s.normal_response - sign).abs() < 1e-12);
        assert!(s.shear_response.abs() < 1e-12);
        assert_eq!(s.b.signum(), sign);
    }
    geo.plates[0].euler_pole = PlanetPosition::new(1.0, 0.0, 0.0).unwrap();
    geo.plates[1].euler_pole = PlanetPosition::new(-1.0, 0.0, 0.0).unwrap();
    let field = CandidateField::new(&config, &geo);
    let s = field.sample(p, 1.0);
    assert!(s.b.abs() < 1e-12);
    assert!((s.shear_response.abs() - 1.0).abs() < 1e-12);
    geo.plates[1].euler_pole = geo.plates[0].euler_pole;
    assert_eq!(CandidateField::new(&config, &geo).sample(p, 1.0).b, 0.0);
}

#[test]
fn planet_candidate_seam_poles_determinism_and_legacy_preservation() {
    preservation();
    for fixture in candidate_fixtures() {
        let config = &fixture.config;
        let geo = geology_for(config);
        let field = CandidateField::new(config, &geo);
        for latitude in [-90.0, -89.999, -45.0, 0.0, 45.0, 89.999, 90.0] {
            let a = PlanetPosition::from_latitude_longitude_deg(latitude, -180.0);
            let b = PlanetPosition::from_latitude_longitude_deg(latitude, 180.0);
            let sa = field.sample(a, fast_geology_influence(&geo, a).1);
            let sb = field.sample(b, fast_geology_influence(&geo, b).1);
            assert!((sa.k - sb.k).abs() < 1e-12);
            assert!((sa.b - sb.b).abs() < 1e-12);
            let again = field.sample(a, fast_geology_influence(&geo, a).1);
            assert_eq!(sa.k.to_bits(), again.k.to_bits());
            assert_eq!(sa.b.to_bits(), again.b.to_bits());
        }
        for latitude in [-90.0, 90.0] {
            let origin = PlanetPosition::from_latitude_longitude_deg(latitude, 0.0);
            let ref_s = field.sample(origin, fast_geology_influence(&geo, origin).1);
            for longitude in [-179.0, -90.0, 45.0, 90.0, 179.0] {
                let p = PlanetPosition::from_latitude_longitude_deg(latitude, longitude);
                let s = field.sample(p, fast_geology_influence(&geo, p).1);
                assert!((s.k - ref_s.k).abs() < 1e-12);
                assert!((s.b - ref_s.b).abs() < 1e-12);
            }
        }
    }
}

#[test]
fn planet_candidate_expanded_legacy_buffers_unchanged() {
    for fixture in candidate_fixtures() {
        let config = &fixture.config;
        let geo = geology_for(config);
        let before = PlanetSurface::generate(config, &geo);
        let samples = observe(config, &geo);
        let count = before.width as usize * before.height as usize;
        let raw = samples[..count]
            .iter()
            .map(|s| s.raw_h(config))
            .collect::<Vec<_>>();
        let threshold = quantile(&raw, config.hydrosphere.target_ocean_coverage.unwrap());
        check_legacy(&fixture, &before, &raw, threshold);
        let field = CandidateField::new(config, &geo);
        for s in samples.iter().step_by(127) {
            assert!(field.sample(s.position, s.boundary).k.is_finite());
        }
        let after = PlanetSurface::generate(config, &geo);
        assert_eq!(before, after);
    }
}
