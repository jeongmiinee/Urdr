use crate::{
    projection::ProjectionError,
    spatial::{MapPixelPoint, MapViewDefinition, PlanetPosition},
};

/// Inverse projection avoids holes and keeps raster overlays on the exact
/// projection used for vector geometry.
pub fn inverse_project_raster<T>(
    view: &MapViewDefinition,
    radius_m: f64,
    mut sample: impl FnMut(PlanetPosition) -> T,
) -> Result<Vec<T>, ProjectionError> {
    let capacity = usize::try_from(view.output_width_px)
        .ok()
        .and_then(|width| {
            usize::try_from(view.output_height_px)
                .ok()
                .and_then(|height| width.checked_mul(height))
        })
        .ok_or(ProjectionError::InvalidParameters)?;
    let mut output = Vec::with_capacity(capacity);
    for y in 0..view.output_height_px {
        for x in 0..view.output_width_px {
            let position = view.pixel_to_planet(
                MapPixelPoint {
                    x: f64::from(x),
                    y: f64::from(y),
                },
                radius_m,
            )?;
            output.push(sample(position));
        }
    }
    Ok(output)
}

/// Densifies long spherical segments until their screen-space projection is
/// smooth. View rotation remains a presentation concern of MapViewDefinition.
pub fn project_geodesic_polyline(
    view: &MapViewDefinition,
    radius_m: f64,
    positions: &[PlanetPosition],
    tolerance_px: f64,
) -> Result<Vec<MapPixelPoint>, ProjectionError> {
    if positions.is_empty() {
        return Ok(Vec::new());
    }
    let mut output = vec![view.planet_to_pixel(positions[0], radius_m)?];
    for pair in positions.windows(2) {
        append_projected_arc(
            view,
            radius_m,
            pair[0],
            pair[1],
            tolerance_px.clamp(0.05, 64.0),
            0,
            &mut output,
        )?;
    }
    Ok(output)
}

#[allow(clippy::too_many_arguments)]
fn append_projected_arc(
    view: &MapViewDefinition,
    radius_m: f64,
    start: PlanetPosition,
    end: PlanetPosition,
    tolerance_px: f64,
    depth: u8,
    output: &mut Vec<MapPixelPoint>,
) -> Result<(), ProjectionError> {
    let projected_start = view.planet_to_pixel(start, radius_m)?;
    let projected_end = view.planet_to_pixel(end, radius_m)?;
    let Some(midpoint) = great_circle_midpoint(start, end) else {
        output.push(projected_end);
        return Ok(());
    };
    let projected_midpoint = view.planet_to_pixel(midpoint, radius_m)?;
    let chord_midpoint = MapPixelPoint {
        x: (projected_start.x + projected_end.x) * 0.5,
        y: (projected_start.y + projected_end.y) * 0.5,
    };
    let error = ((projected_midpoint.x - chord_midpoint.x).powi(2)
        + (projected_midpoint.y - chord_midpoint.y).powi(2))
    .sqrt();
    let projected_length = ((projected_end.x - projected_start.x).powi(2)
        + (projected_end.y - projected_start.y).powi(2))
    .sqrt();
    if depth < 16 && (error > tolerance_px || projected_length > 192.0) {
        append_projected_arc(
            view,
            radius_m,
            start,
            midpoint,
            tolerance_px,
            depth + 1,
            output,
        )?;
        append_projected_arc(
            view,
            radius_m,
            midpoint,
            end,
            tolerance_px,
            depth + 1,
            output,
        )?;
    } else {
        output.push(projected_end);
    }
    Ok(())
}

fn great_circle_midpoint(start: PlanetPosition, end: PlanetPosition) -> Option<PlanetPosition> {
    let start = start.components();
    let end = end.components();
    PlanetPosition::new(start[0] + end[0], start[1] + end[1], start[2] + end[2]).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::spatial::{PlanetState, generated_region_and_view};

    #[test]
    fn inverse_raster_samples_every_output_pixel() {
        let planet = PlanetState::default();
        let (_, view) =
            generated_region_and_view(&planet, "test", "test", 35.0, 600.0, 400.0, 16, 8);
        let raster = inverse_project_raster(&view, planet.physical.radius_m, |position| {
            position.latitude_longitude_deg().0
        })
        .expect("inverse raster");
        assert_eq!(raster.len(), 128);
        assert!(raster.iter().all(|value| value.is_finite()));
    }

    #[test]
    fn geodesic_projection_adds_points_for_curved_long_segments() {
        let planet = PlanetState::default();
        let (_, view) =
            generated_region_and_view(&planet, "test", "test", 55.0, 2_400.0, 1_400.0, 1_200, 700);
        let points = project_geodesic_polyline(
            &view,
            planet.physical.radius_m,
            &[
                PlanetPosition::from_latitude_longitude_deg(52.0, -8.0),
                PlanetPosition::from_latitude_longitude_deg(58.0, 10.0),
            ],
            0.5,
        )
        .expect("projected line");
        assert!(points.len() > 2);
    }
}
