use std::f64::consts::{FRAC_PI_2, FRAC_PI_4, PI};

use serde::{Deserialize, Serialize};

use crate::spatial::PlanetPosition;

const EPSILON: f64 = 1.0e-12;

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectedMetricPoint {
    pub east_m: f64,
    pub north_m: f64,
}

impl ProjectedMetricPoint {
    pub fn rotate(self, degrees: f64) -> Self {
        let angle = degrees.to_radians();
        let (sin, cos) = angle.sin_cos();
        Self {
            east_m: self.east_m * cos - self.north_m * sin,
            north_m: self.east_m * sin + self.north_m * cos,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProjectionKind {
    LocalTangent,
    AzimuthalEquidistant,
    LambertConformalConic,
    PolarStereographic,
    Equirectangular,
    LegacyPlanar,
}

impl Default for ProjectionKind {
    fn default() -> Self {
        Self::LocalTangent
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectionDefinition {
    pub kind: ProjectionKind,
    pub center: PlanetPosition,
    pub standard_parallel_1_deg: f64,
    pub standard_parallel_2_deg: f64,
    pub central_meridian_deg: f64,
    pub latitude_of_origin_deg: f64,
    pub version: u16,
}

impl ProjectionDefinition {
    pub fn local_tangent(center: PlanetPosition) -> Self {
        let (latitude, longitude) = center.latitude_longitude_deg();
        Self {
            kind: ProjectionKind::LocalTangent,
            center,
            standard_parallel_1_deg: latitude,
            standard_parallel_2_deg: latitude,
            central_meridian_deg: longitude,
            latitude_of_origin_deg: latitude,
            version: 1,
        }
    }

    pub fn legacy_planar() -> Self {
        Self {
            kind: ProjectionKind::LegacyPlanar,
            center: PlanetPosition::from_latitude_longitude_deg(0.0, 0.0),
            standard_parallel_1_deg: 0.0,
            standard_parallel_2_deg: 0.0,
            central_meridian_deg: 0.0,
            latitude_of_origin_deg: 0.0,
            version: 1,
        }
    }

    pub fn project(
        &self,
        position: PlanetPosition,
        radius_m: f64,
    ) -> Result<ProjectedMetricPoint, ProjectionError> {
        if self.kind == ProjectionKind::LegacyPlanar {
            return Err(ProjectionError::LegacyPlanarHasNoSphericalTransform);
        }
        validate_radius(radius_m)?;
        let (latitude, longitude) = position.latitude_longitude_rad();
        let (origin_latitude, origin_longitude) = self.origin_radians();
        match self.kind {
            ProjectionKind::LocalTangent => project_gnomonic(
                latitude,
                longitude,
                origin_latitude,
                origin_longitude,
                radius_m,
            ),
            ProjectionKind::AzimuthalEquidistant => project_azimuthal_equidistant(
                latitude,
                longitude,
                origin_latitude,
                origin_longitude,
                radius_m,
            ),
            ProjectionKind::LambertConformalConic => self.project_lambert(
                latitude,
                longitude,
                origin_latitude,
                origin_longitude,
                radius_m,
            ),
            ProjectionKind::PolarStereographic => project_stereographic(
                latitude,
                longitude,
                origin_latitude,
                origin_longitude,
                radius_m,
            ),
            ProjectionKind::Equirectangular => Ok(ProjectedMetricPoint {
                east_m: radius_m
                    * wrap_longitude(longitude - origin_longitude)
                    * origin_latitude.cos().abs().max(EPSILON),
                north_m: radius_m * (latitude - origin_latitude),
            }),
            ProjectionKind::LegacyPlanar => unreachable!(),
        }
    }

    pub fn unproject(
        &self,
        point: ProjectedMetricPoint,
        radius_m: f64,
    ) -> Result<PlanetPosition, ProjectionError> {
        if !point.east_m.is_finite() || !point.north_m.is_finite() {
            return Err(ProjectionError::NonFiniteInput);
        }
        if self.kind == ProjectionKind::LegacyPlanar {
            return Err(ProjectionError::LegacyPlanarHasNoSphericalTransform);
        }
        validate_radius(radius_m)?;
        let (origin_latitude, origin_longitude) = self.origin_radians();
        let (latitude, longitude) = match self.kind {
            ProjectionKind::LocalTangent => {
                inverse_gnomonic(point, origin_latitude, origin_longitude, radius_m)?
            }
            ProjectionKind::AzimuthalEquidistant => {
                inverse_azimuthal(point, origin_latitude, origin_longitude, radius_m, false)?
            }
            ProjectionKind::LambertConformalConic => {
                self.inverse_lambert(point, origin_latitude, origin_longitude, radius_m)?
            }
            ProjectionKind::PolarStereographic => {
                inverse_azimuthal(point, origin_latitude, origin_longitude, radius_m, true)?
            }
            ProjectionKind::Equirectangular => (
                origin_latitude + point.north_m / radius_m,
                origin_longitude
                    + point.east_m / (radius_m * origin_latitude.cos().abs().max(EPSILON)),
            ),
            ProjectionKind::LegacyPlanar => unreachable!(),
        };
        if !latitude.is_finite()
            || !longitude.is_finite()
            || latitude < -FRAC_PI_2 - 1.0e-9
            || latitude > FRAC_PI_2 + 1.0e-9
        {
            return Err(ProjectionError::OutsideDomain);
        }
        Ok(PlanetPosition::from_latitude_longitude_rad(
            latitude.clamp(-FRAC_PI_2, FRAC_PI_2),
            wrap_longitude(longitude),
        ))
    }

    pub fn project_batch(
        &self,
        positions: &[PlanetPosition],
        radius_m: f64,
    ) -> Vec<Result<ProjectedMetricPoint, ProjectionError>> {
        positions
            .iter()
            .map(|position| self.project(*position, radius_m))
            .collect()
    }

    pub fn unproject_batch(
        &self,
        points: &[ProjectedMetricPoint],
        radius_m: f64,
    ) -> Vec<Result<PlanetPosition, ProjectionError>> {
        points
            .iter()
            .map(|point| self.unproject(*point, radius_m))
            .collect()
    }

    pub fn local_metrics(
        &self,
        position: PlanetPosition,
        radius_m: f64,
    ) -> Result<ProjectionMetrics, ProjectionError> {
        let step_m = 1.0_f64.max(radius_m * 1.0e-8);
        let angular_step = step_m / radius_m;
        let (latitude, longitude) = position.latitude_longitude_rad();
        let east = PlanetPosition::from_latitude_longitude_rad(
            latitude,
            longitude + angular_step / latitude.cos().abs().max(1.0e-7),
        );
        let north = PlanetPosition::from_latitude_longitude_rad(
            (latitude + angular_step).min(FRAC_PI_2 - 1.0e-9),
            longitude,
        );
        let center = self.project(position, radius_m)?;
        let east = self.project(east, radius_m)?;
        let north = self.project(north, radius_m)?;
        let east_vector = (east.east_m - center.east_m, east.north_m - center.north_m);
        let north_vector = (north.east_m - center.east_m, north.north_m - center.north_m);
        let east_scale = vector_length(east_vector) / step_m;
        let north_scale = vector_length(north_vector) / step_m;
        let dot = east_vector.0 * north_vector.0 + east_vector.1 * north_vector.1;
        let angle = (dot / (vector_length(east_vector) * vector_length(north_vector)).max(EPSILON))
            .clamp(-1.0, 1.0)
            .acos()
            .to_degrees();
        Ok(ProjectionMetrics {
            east_scale,
            north_scale,
            area_scale: east_scale * north_scale * angle.to_radians().sin().abs(),
            angular_deformation_deg: (90.0 - angle).abs(),
        })
    }

    fn origin_radians(&self) -> (f64, f64) {
        (
            self.latitude_of_origin_deg.to_radians(),
            self.central_meridian_deg.to_radians(),
        )
    }

    fn lambert_constants(&self, radius_m: f64) -> Result<(f64, f64), ProjectionError> {
        let first = self.standard_parallel_1_deg.to_radians();
        let second = self.standard_parallel_2_deg.to_radians();
        if first.abs() >= FRAC_PI_2 || second.abs() >= FRAC_PI_2 {
            return Err(ProjectionError::InvalidParameters);
        }
        let n = if (first - second).abs() < 1.0e-10 {
            first.sin()
        } else {
            (first.cos() / second.cos()).ln() / (tan_half_pi(second) / tan_half_pi(first)).ln()
        };
        if !n.is_finite() || n.abs() < EPSILON {
            return Err(ProjectionError::InvalidParameters);
        }
        let f = first.cos() * tan_half_pi(first).powf(n) / n;
        if !f.is_finite() {
            return Err(ProjectionError::InvalidParameters);
        }
        Ok((n, radius_m * f))
    }

    fn project_lambert(
        &self,
        latitude: f64,
        longitude: f64,
        origin_latitude: f64,
        origin_longitude: f64,
        radius_m: f64,
    ) -> Result<ProjectedMetricPoint, ProjectionError> {
        let (n, rf) = self.lambert_constants(radius_m)?;
        let rho = rf / tan_half_pi(latitude).powf(n);
        let rho0 = rf / tan_half_pi(origin_latitude).powf(n);
        let theta = n * wrap_longitude(longitude - origin_longitude);
        if !rho.is_finite() || !rho0.is_finite() {
            return Err(ProjectionError::OutsideDomain);
        }
        Ok(ProjectedMetricPoint {
            east_m: rho * theta.sin(),
            north_m: rho0 - rho * theta.cos(),
        })
    }

    fn inverse_lambert(
        &self,
        point: ProjectedMetricPoint,
        origin_latitude: f64,
        origin_longitude: f64,
        radius_m: f64,
    ) -> Result<(f64, f64), ProjectionError> {
        let (n, rf) = self.lambert_constants(radius_m)?;
        let rho0 = rf / tan_half_pi(origin_latitude).powf(n);
        let mut rho = point.east_m.hypot(rho0 - point.north_m);
        if n < 0.0 {
            rho = -rho;
        }
        if rho.abs() < EPSILON {
            return Ok((n.signum() * FRAC_PI_2, origin_longitude));
        }
        let theta = point.east_m.atan2(rho0 - point.north_m);
        let latitude = 2.0 * (rf / rho).powf(1.0 / n).atan() - FRAC_PI_2;
        let longitude = origin_longitude + theta / n;
        Ok((latitude, longitude))
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ProjectionMetrics {
    pub east_scale: f64,
    pub north_scale: f64,
    pub area_scale: f64,
    pub angular_deformation_deg: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProjectionError {
    NonFiniteInput,
    InvalidRadius,
    InvalidParameters,
    OutsideDomain,
    Antipode,
    LegacyPlanarHasNoSphericalTransform,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ProjectionSelectionInput {
    pub center: PlanetPosition,
    pub width_m: f64,
    pub height_m: f64,
    pub includes_north_pole: bool,
    pub includes_south_pole: bool,
    pub full_planet: bool,
}

pub struct ProjectionSelector;

impl ProjectionSelector {
    pub fn select(input: ProjectionSelectionInput, radius_m: f64) -> ProjectionDefinition {
        let (latitude, longitude) = input.center.latitude_longitude_deg();
        let maximum_extent = input.width_m.max(input.height_m);
        let circumference = 2.0 * PI * radius_m;
        let kind = if input.full_planet || maximum_extent > circumference * 0.42 {
            ProjectionKind::Equirectangular
        } else if input.includes_north_pole || input.includes_south_pole || latitude.abs() >= 72.0 {
            ProjectionKind::PolarStereographic
        } else if maximum_extent <= radius_m * 0.12 {
            ProjectionKind::LocalTangent
        } else if input.width_m / input.height_m.max(1.0) >= 1.35 && latitude.abs() >= 18.0 {
            ProjectionKind::LambertConformalConic
        } else {
            ProjectionKind::AzimuthalEquidistant
        };
        let parallel_delta = (input.height_m / radius_m).to_degrees() * 0.22;
        ProjectionDefinition {
            kind,
            center: input.center,
            standard_parallel_1_deg: (latitude - parallel_delta).clamp(-80.0, 80.0),
            standard_parallel_2_deg: (latitude + parallel_delta).clamp(-80.0, 80.0),
            central_meridian_deg: longitude,
            latitude_of_origin_deg: match kind {
                ProjectionKind::PolarStereographic => latitude.signum() * 90.0,
                _ => latitude,
            },
            version: 1,
        }
    }
}

fn project_gnomonic(
    latitude: f64,
    longitude: f64,
    origin_latitude: f64,
    origin_longitude: f64,
    radius_m: f64,
) -> Result<ProjectedMetricPoint, ProjectionError> {
    let delta = wrap_longitude(longitude - origin_longitude);
    let cos_c = origin_latitude.sin() * latitude.sin()
        + origin_latitude.cos() * latitude.cos() * delta.cos();
    if cos_c <= 1.0e-9 {
        return Err(ProjectionError::OutsideDomain);
    }
    Ok(ProjectedMetricPoint {
        east_m: radius_m * latitude.cos() * delta.sin() / cos_c,
        north_m: radius_m
            * (origin_latitude.cos() * latitude.sin()
                - origin_latitude.sin() * latitude.cos() * delta.cos())
            / cos_c,
    })
}

fn inverse_gnomonic(
    point: ProjectedMetricPoint,
    origin_latitude: f64,
    origin_longitude: f64,
    radius_m: f64,
) -> Result<(f64, f64), ProjectionError> {
    let rho = point.east_m.hypot(point.north_m);
    if rho < EPSILON {
        return Ok((origin_latitude, origin_longitude));
    }
    let c = (rho / radius_m).atan();
    Ok(inverse_azimuthal_with_c(
        point,
        origin_latitude,
        origin_longitude,
        rho,
        c,
    ))
}

fn project_azimuthal_equidistant(
    latitude: f64,
    longitude: f64,
    origin_latitude: f64,
    origin_longitude: f64,
    radius_m: f64,
) -> Result<ProjectedMetricPoint, ProjectionError> {
    let delta = wrap_longitude(longitude - origin_longitude);
    let cos_c = (origin_latitude.sin() * latitude.sin()
        + origin_latitude.cos() * latitude.cos() * delta.cos())
    .clamp(-1.0, 1.0);
    let c = cos_c.acos();
    if (PI - c).abs() < 1.0e-9 {
        return Err(ProjectionError::Antipode);
    }
    let k = if c < EPSILON { 1.0 } else { c / c.sin() };
    Ok(ProjectedMetricPoint {
        east_m: radius_m * k * latitude.cos() * delta.sin(),
        north_m: radius_m
            * k
            * (origin_latitude.cos() * latitude.sin()
                - origin_latitude.sin() * latitude.cos() * delta.cos()),
    })
}

fn project_stereographic(
    latitude: f64,
    longitude: f64,
    origin_latitude: f64,
    origin_longitude: f64,
    radius_m: f64,
) -> Result<ProjectedMetricPoint, ProjectionError> {
    let delta = wrap_longitude(longitude - origin_longitude);
    let denominator = 1.0
        + origin_latitude.sin() * latitude.sin()
        + origin_latitude.cos() * latitude.cos() * delta.cos();
    if denominator <= 1.0e-12 {
        return Err(ProjectionError::Antipode);
    }
    let k = 2.0 / denominator;
    Ok(ProjectedMetricPoint {
        east_m: radius_m * k * latitude.cos() * delta.sin(),
        north_m: radius_m
            * k
            * (origin_latitude.cos() * latitude.sin()
                - origin_latitude.sin() * latitude.cos() * delta.cos()),
    })
}

fn inverse_azimuthal(
    point: ProjectedMetricPoint,
    origin_latitude: f64,
    origin_longitude: f64,
    radius_m: f64,
    stereographic: bool,
) -> Result<(f64, f64), ProjectionError> {
    let rho = point.east_m.hypot(point.north_m);
    if rho < EPSILON {
        return Ok((origin_latitude, origin_longitude));
    }
    let c = if stereographic {
        2.0 * (rho / (2.0 * radius_m)).atan()
    } else {
        rho / radius_m
    };
    if c > PI + 1.0e-9 {
        return Err(ProjectionError::OutsideDomain);
    }
    Ok(inverse_azimuthal_with_c(
        point,
        origin_latitude,
        origin_longitude,
        rho,
        c,
    ))
}

fn inverse_azimuthal_with_c(
    point: ProjectedMetricPoint,
    origin_latitude: f64,
    origin_longitude: f64,
    rho: f64,
    c: f64,
) -> (f64, f64) {
    let (sin_c, cos_c) = c.sin_cos();
    let latitude = (cos_c * origin_latitude.sin()
        + point.north_m * sin_c * origin_latitude.cos() / rho)
        .clamp(-1.0, 1.0)
        .asin();
    let longitude = origin_longitude
        + (point.east_m * sin_c).atan2(
            rho * origin_latitude.cos() * cos_c - point.north_m * origin_latitude.sin() * sin_c,
        );
    (latitude, longitude)
}

fn validate_radius(radius_m: f64) -> Result<(), ProjectionError> {
    if !radius_m.is_finite() || radius_m <= 0.0 {
        Err(ProjectionError::InvalidRadius)
    } else {
        Ok(())
    }
}

fn tan_half_pi(latitude: f64) -> f64 {
    (FRAC_PI_4 + latitude * 0.5).tan()
}

fn wrap_longitude(longitude: f64) -> f64 {
    (longitude + PI).rem_euclid(2.0 * PI) - PI
}

fn vector_length(vector: (f64, f64)) -> f64 {
    vector.0.hypot(vector.1)
}

#[cfg(test)]
mod tests {
    use super::*;

    const RADIUS: f64 = 6_371_000.0;

    fn assert_round_trip(
        definition: ProjectionDefinition,
        samples: &[(f64, f64)],
        tolerance_m: f64,
    ) {
        for &(latitude, longitude) in samples {
            let source = PlanetPosition::from_latitude_longitude_deg(latitude, longitude);
            let projected = definition.project(source, RADIUS).expect("project");
            let restored = definition.unproject(projected, RADIUS).expect("unproject");
            assert!(
                source.great_circle_distance_m(restored, RADIUS) <= tolerance_m,
                "{:?} failed at ({latitude}, {longitude})",
                definition.kind
            );
        }
    }

    #[test]
    fn supported_projections_round_trip() {
        let center = PlanetPosition::from_latitude_longitude_deg(37.5, 127.0);
        let samples = [(37.5, 127.0), (36.0, 124.0), (40.0, 130.0)];
        for kind in [
            ProjectionKind::LocalTangent,
            ProjectionKind::AzimuthalEquidistant,
            ProjectionKind::LambertConformalConic,
            ProjectionKind::Equirectangular,
        ] {
            let mut definition = ProjectionDefinition::local_tangent(center);
            definition.kind = kind;
            definition.standard_parallel_1_deg = 33.0;
            definition.standard_parallel_2_deg = 42.0;
            assert_round_trip(definition, &samples, 0.02);
        }
        let mut polar = ProjectionDefinition::local_tangent(
            PlanetPosition::from_latitude_longitude_deg(90.0, 0.0),
        );
        polar.kind = ProjectionKind::PolarStereographic;
        polar.latitude_of_origin_deg = 90.0;
        assert_round_trip(polar, &[(89.9, 0.0), (82.0, 90.0), (75.0, -150.0)], 0.02);
    }

    #[test]
    fn antimeridian_is_continuous_for_centered_views() {
        let center = PlanetPosition::from_latitude_longitude_deg(10.0, 179.0);
        let mut definition = ProjectionDefinition::local_tangent(center);
        definition.kind = ProjectionKind::AzimuthalEquidistant;
        let left = definition
            .project(
                PlanetPosition::from_latitude_longitude_deg(10.0, 179.8),
                RADIUS,
            )
            .unwrap();
        let right = definition
            .project(
                PlanetPosition::from_latitude_longitude_deg(10.0, -179.8),
                RADIUS,
            )
            .unwrap();
        assert!((right.east_m - left.east_m).abs() < 100_000.0);
    }

    #[test]
    fn selector_keeps_view_rotation_out_of_projection_choice() {
        let input = ProjectionSelectionInput {
            center: PlanetPosition::from_latitude_longitude_deg(45.0, 10.0),
            width_m: 2_000_000.0,
            height_m: 800_000.0,
            includes_north_pole: false,
            includes_south_pole: false,
            full_planet: false,
        };
        assert_eq!(
            ProjectionSelector::select(input, RADIUS).kind,
            ProjectionKind::LambertConformalConic
        );
    }
}
