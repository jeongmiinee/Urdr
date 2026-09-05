use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::planet_config::{GeologicalConfig, TectonicConfig};
use crate::spatial::PlanetPosition;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CrustType {
    Continental,
    Oceanic,
    Transitional,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PlateBoundaryKind {
    Convergent,
    Divergent,
    Transform,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GeologicalFeatureKind {
    Orogen,
    TrenchArc,
    RiftRidge,
    TransformZone,
    PassiveMargin,
    HotspotTrack,
    SedimentaryBasin,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TectonicPlate {
    pub id: String,
    pub center: PlanetPosition,
    pub euler_pole: PlanetPosition,
    pub angular_speed_deg_per_myr: f64,
    pub crust: CrustType,
    pub crust_age_myr: f64,
    pub crust_thickness_km: f64,
    pub density_kg_m3: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlateBoundary {
    pub id: String,
    pub left_plate_id: String,
    pub right_plate_id: String,
    pub kind: PlateBoundaryKind,
    pub convergence_mm_per_year: f64,
    pub maturity: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeologicalEvent {
    pub id: String,
    pub cause_ids: Vec<String>,
    pub age_myr: f64,
    pub intensity: f64,
    pub active: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeologicalFeature {
    pub id: String,
    pub kind: GeologicalFeatureKind,
    pub origin_event_id: String,
    pub plate_ids: Vec<String>,
    pub age_myr: f64,
    pub activity: f64,
    pub maturity: f64,
    pub erosion_maturity: f64,
    pub confidence: f64,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CausalGeologyModel {
    pub revision: u16,
    pub seed: u64,
    pub plates: Vec<TectonicPlate>,
    pub boundaries: Vec<PlateBoundary>,
    pub events: Vec<GeologicalEvent>,
    pub features: Vec<GeologicalFeature>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GeologySurfaceSample {
    pub plate_index: usize,
    pub crust: CrustType,
    pub boundary_kind: Option<PlateBoundaryKind>,
    pub boundary_influence: f64,
    pub base_elevation_bias_m: f64,
    pub erodibility: f64,
    pub permeability: f64,
    pub sediment_fraction: f64,
}

impl CausalGeologyModel {
    pub fn synthesize(seed: u64, requested_plate_count: usize) -> Self {
        let tectonics = TectonicConfig {
            plate_count: requested_plate_count.clamp(6, 32) as u8,
            ..TectonicConfig::default()
        };
        Self::synthesize_with_controls(seed, &tectonics, &GeologicalConfig::default())
    }

    pub fn synthesize_with_controls(
        seed: u64,
        tectonics: &TectonicConfig,
        geology: &GeologicalConfig,
    ) -> Self {
        let plate_count = usize::from(tectonics.plate_count.clamp(6, 32));
        let mut plates = Vec::with_capacity(plate_count);
        let golden_angle = std::f64::consts::PI * (3.0 - 5.0_f64.sqrt());
        for index in 0..plate_count {
            let y = 1.0 - 2.0 * (index as f64 + 0.5) / plate_count as f64;
            let radius = (1.0 - y * y).sqrt();
            let angle = golden_angle * index as f64 + signed_hash(seed, index as u64) * 0.22;
            let center = PlanetPosition::new(radius * angle.cos(), radius * angle.sin(), y)
                .expect("fibonacci plate centre");
            let pole_latitude = signed_hash(seed ^ 0x9e37_79b9, index as u64 * 3) * 72.0;
            let pole_longitude = signed_hash(seed ^ 0x85eb_ca6b, index as u64 * 3 + 1) * 180.0;
            let continental = unit_hash(seed ^ 0xc2b2_ae35, index as u64)
                < tectonics.continental_crust_fraction.clamp(0.0, 1.0);
            let crust = if continental {
                CrustType::Continental
            } else {
                CrustType::Oceanic
            };
            let crust_age_myr = 8.0 + unit_hash(seed ^ 0x27d4_eb2f, index as u64) * 242.0;
            plates.push(TectonicPlate {
                id: format!("plate-{index:03}"),
                center,
                euler_pole: PlanetPosition::from_latitude_longitude_deg(
                    pole_latitude,
                    pole_longitude,
                ),
                angular_speed_deg_per_myr: (0.04
                    + unit_hash(seed ^ 0x1656_67b1, index as u64) * 1.56)
                    * (0.35 + tectonics.activity.clamp(0.0, 1.0) * 1.3),
                crust,
                crust_age_myr,
                crust_thickness_km: if continental {
                    28.0 + unit_hash(seed ^ 0xd3a2_646c, index as u64) * 24.0
                } else {
                    5.5 + unit_hash(seed ^ 0xfd70_46c5, index as u64) * 4.0
                },
                density_kg_m3: if continental { 2_720.0 } else { 2_940.0 },
            });
        }

        let mut pairs = HashSet::new();
        for left in 0..plates.len() {
            let mut neighbours = (0..plates.len())
                .filter(|right| *right != left)
                .map(|right| {
                    (
                        right,
                        plates[left]
                            .center
                            .great_circle_distance_m(plates[right].center, 1.0),
                    )
                })
                .collect::<Vec<_>>();
            neighbours.sort_by(|left, right| left.1.total_cmp(&right.1));
            for &(right, _) in neighbours.iter().take(3) {
                pairs.insert((left.min(right), left.max(right)));
            }
        }
        let mut pairs = pairs.into_iter().collect::<Vec<_>>();
        pairs.sort_unstable();
        let mut boundaries = Vec::with_capacity(pairs.len());
        let mut events = Vec::with_capacity(pairs.len());
        let mut features = Vec::with_capacity(pairs.len());
        for (index, (left, right)) in pairs.into_iter().enumerate() {
            let selector = unit_hash(seed ^ 0x94d0_49bb, index as u64);
            let convergent_threshold = (0.28 + tectonics.orogenic_activity * 0.25).clamp(0.2, 0.62);
            let divergent_threshold =
                (convergent_threshold + 0.16 + tectonics.rift_activity * 0.18)
                    .clamp(convergent_threshold + 0.08, 0.88);
            let kind = if selector < convergent_threshold {
                PlateBoundaryKind::Convergent
            } else if selector < divergent_threshold {
                PlateBoundaryKind::Divergent
            } else {
                PlateBoundaryKind::Transform
            };
            let rate = match kind {
                PlateBoundaryKind::Convergent => 12.0 + selector * 88.0,
                PlateBoundaryKind::Divergent => -(8.0 + selector * 56.0),
                PlateBoundaryKind::Transform => signed_hash(seed, index as u64) * 68.0,
            };
            let boundary_id = format!("boundary-{index:03}");
            let event_id = format!("event-{index:03}");
            boundaries.push(PlateBoundary {
                id: boundary_id,
                left_plate_id: plates[left].id.clone(),
                right_plate_id: plates[right].id.clone(),
                kind,
                convergence_mm_per_year: rate,
                maturity: (0.3 + unit_hash(seed ^ 0x6a09_e667, index as u64) * 0.7),
            });
            let age_ceiling = 45.0 + geology.maturity.clamp(0.0, 1.0) * 260.0;
            let age_myr = 2.0 + unit_hash(seed ^ 0xbb67_ae85, index as u64) * age_ceiling;
            events.push(GeologicalEvent {
                id: event_id.clone(),
                cause_ids: Vec::new(),
                age_myr,
                intensity: (rate.abs() / 100.0).clamp(0.05, 1.0),
                active: age_myr < 35.0 + tectonics.activity.clamp(0.0, 1.0) * 95.0,
            });
            features.push(GeologicalFeature {
                id: format!("feature-{index:03}"),
                kind: match kind {
                    PlateBoundaryKind::Convergent => {
                        if plates[left].crust == CrustType::Oceanic
                            || plates[right].crust == CrustType::Oceanic
                        {
                            GeologicalFeatureKind::TrenchArc
                        } else {
                            GeologicalFeatureKind::Orogen
                        }
                    }
                    PlateBoundaryKind::Divergent => GeologicalFeatureKind::RiftRidge,
                    PlateBoundaryKind::Transform => GeologicalFeatureKind::TransformZone,
                },
                origin_event_id: event_id,
                plate_ids: vec![plates[left].id.clone(), plates[right].id.clone()],
                age_myr,
                activity: ((1.0 - age_myr / 260.0) * (0.45 + tectonics.activity.clamp(0.0, 1.0)))
                    .clamp(0.0, 1.0),
                maturity: (age_myr / (55.0 + geology.maturity * 90.0)).clamp(0.05, 1.0),
                erosion_maturity: (age_myr / (220.0 - geology.maturity * 80.0)).clamp(0.0, 1.0),
                confidence: 1.0,
            });
        }
        Self {
            revision: 1,
            seed,
            plates,
            boundaries,
            events,
            features,
        }
    }

    pub fn ensure_synthesized(&mut self, seed: u64) {
        if self.plates.is_empty() {
            *self = Self::synthesize(seed, 12);
        }
    }

    pub fn sample(&self, position: PlanetPosition) -> GeologySurfaceSample {
        if self.plates.is_empty() {
            return GeologySurfaceSample {
                plate_index: 0,
                crust: CrustType::Transitional,
                boundary_kind: None,
                boundary_influence: 0.0,
                base_elevation_bias_m: 0.0,
                erodibility: 0.5,
                permeability: 0.5,
                sediment_fraction: 0.5,
            };
        }
        let [px, py, pz] = position.components();
        let mut nearest = (usize::MAX, f64::NEG_INFINITY);
        let mut second = (usize::MAX, f64::NEG_INFINITY);
        for (index, plate) in self.plates.iter().enumerate() {
            let [cx, cy, cz] = plate.center.components();
            let dot = (px * cx + py * cy + pz * cz).clamp(-1.0, 1.0);
            if dot > nearest.1 {
                second = nearest;
                nearest = (index, dot);
            } else if dot > second.1 {
                second = (index, dot);
            }
        }
        let plate_index = nearest.0;
        let second_index = if second.0 == usize::MAX {
            plate_index
        } else {
            second.0
        };
        let boundary_influence = if second.0 == usize::MAX {
            0.0
        } else {
            let nearest_distance = nearest.1.acos();
            let second_distance = second.1.acos();
            (-(second_distance - nearest_distance).abs() / 0.085).exp()
        };
        let pair = (
            self.plates[plate_index].id.as_str(),
            self.plates[second_index].id.as_str(),
        );
        let boundary = self.boundaries.iter().find(|boundary| {
            (boundary.left_plate_id == pair.0 && boundary.right_plate_id == pair.1)
                || (boundary.left_plate_id == pair.1 && boundary.right_plate_id == pair.0)
        });
        let plate = &self.plates[plate_index];
        let crust_bias = match plate.crust {
            CrustType::Continental => 520.0 + (plate.crust_thickness_km - 35.0) * 42.0,
            CrustType::Oceanic => -2_400.0 - plate.crust_age_myr.sqrt() * 62.0,
            CrustType::Transitional => -350.0,
        };
        let boundary_bias = boundary.map_or(0.0, |boundary| {
            let intensity = boundary.convergence_mm_per_year.abs().clamp(0.0, 100.0) / 100.0;
            match boundary.kind {
                PlateBoundaryKind::Convergent => 2_800.0 * intensity * boundary.maturity,
                PlateBoundaryKind::Divergent => -850.0 * intensity,
                PlateBoundaryKind::Transform => 180.0 * intensity,
            }
        }) * boundary_influence;
        let erosion_maturity = boundary
            .and_then(|boundary| {
                self.features.iter().find(|feature| {
                    feature.plate_ids.contains(&boundary.left_plate_id)
                        && feature.plate_ids.contains(&boundary.right_plate_id)
                })
            })
            .map_or(0.4, |feature| feature.erosion_maturity);
        GeologySurfaceSample {
            plate_index,
            crust: plate.crust,
            boundary_kind: boundary.map(|boundary| boundary.kind),
            boundary_influence,
            base_elevation_bias_m: crust_bias + boundary_bias * (1.0 - erosion_maturity * 0.55),
            erodibility: (0.35 + erosion_maturity * 0.5).clamp(0.0, 1.0),
            permeability: match plate.crust {
                CrustType::Continental => 0.46,
                CrustType::Oceanic => 0.28,
                CrustType::Transitional => 0.6,
            },
            sediment_fraction: (0.18 + erosion_maturity * 0.68).clamp(0.0, 1.0),
        }
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.plates.is_empty() {
            return Err("causal geology has no plates".to_owned());
        }
        let plate_ids = self
            .plates
            .iter()
            .map(|plate| plate.id.as_str())
            .collect::<HashSet<_>>();
        if plate_ids.len() != self.plates.len() {
            return Err("duplicate tectonic plate IDs".to_owned());
        }
        let event_ages = self
            .events
            .iter()
            .map(|event| (event.id.as_str(), event.age_myr))
            .collect::<HashMap<_, _>>();
        for boundary in &self.boundaries {
            if !plate_ids.contains(boundary.left_plate_id.as_str())
                || !plate_ids.contains(boundary.right_plate_id.as_str())
                || boundary.left_plate_id == boundary.right_plate_id
            {
                return Err(format!("invalid plate boundary: {}", boundary.id));
            }
        }
        for event in &self.events {
            for cause in &event.cause_ids {
                let Some(cause_age) = event_ages.get(cause.as_str()) else {
                    return Err(format!("missing geological cause: {cause}"));
                };
                if *cause_age < event.age_myr {
                    return Err(format!(
                        "geological event age order is invalid: {}",
                        event.id
                    ));
                }
            }
        }
        for feature in &self.features {
            if !event_ages.contains_key(feature.origin_event_id.as_str()) {
                return Err(format!("feature has no causal event: {}", feature.id));
            }
        }
        Ok(())
    }
}

fn unit_hash(seed: u64, index: u64) -> f64 {
    let mut value = seed ^ index.wrapping_mul(0x9e37_79b9_7f4a_7c15);
    value ^= value >> 30;
    value = value.wrapping_mul(0xbf58_476d_1ce4_e5b9);
    value ^= value >> 27;
    value = value.wrapping_mul(0x94d0_49bb_1331_11eb);
    value ^= value >> 31;
    (value >> 11) as f64 / ((1_u64 << 53) - 1) as f64
}

fn signed_hash(seed: u64, index: u64) -> f64 {
    unit_hash(seed, index) * 2.0 - 1.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn synthesis_is_deterministic_and_causally_valid() {
        let left = CausalGeologyModel::synthesize(42, 12);
        let right = CausalGeologyModel::synthesize(42, 12);
        assert_eq!(left, right);
        left.validate().unwrap();
        assert!(left.features.iter().all(|feature| {
            left.events
                .iter()
                .any(|event| event.id == feature.origin_event_id)
        }));
    }

    #[test]
    fn tectonic_activity_changes_physical_plate_motion() {
        let mut quiet = TectonicConfig::default();
        quiet.activity = 0.1;
        let mut active = quiet.clone();
        active.activity = 0.95;
        let geology = GeologicalConfig::default();
        let quiet_world = CausalGeologyModel::synthesize_with_controls(44, &quiet, &geology);
        let active_world = CausalGeologyModel::synthesize_with_controls(44, &active, &geology);
        let mean_speed = |model: &CausalGeologyModel| {
            model
                .plates
                .iter()
                .map(|plate| plate.angular_speed_deg_per_myr)
                .sum::<f64>()
                / model.plates.len() as f64
        };
        assert!(mean_speed(&active_world) > mean_speed(&quiet_world) * 1.8);
    }

    #[test]
    fn boundary_samples_change_relief_without_unbounded_noise() {
        let model = CausalGeologyModel::synthesize(8, 10);
        let sample = model.sample(model.plates[0].center);
        assert!(sample.base_elevation_bias_m.is_finite());
        assert!(sample.base_elevation_bias_m.abs() < 10_000.0);
        assert!((0.0..=1.0).contains(&sample.erodibility));
    }
}
