#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClimateModel {
    Temperate,
    Continental,
    Tropical,
    Arid,
    Polar,
}

impl ClimateModel {
    pub fn code(self) -> &'static str {
        match self {
            Self::Temperate => "Cfb",
            Self::Continental => "Dfb",
            Self::Tropical => "Af",
            Self::Arid => "BSh",
            Self::Polar => "ET",
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct MonthClimate {
    pub temperature: f32,
    pub precipitation: f32,
    pub humidity: f32,
    pub wind: f32,
    pub solar_hours: f32,
    pub solar_irradiance: f32,
    pub snowfall: f32,
    pub snow_cover: f32,
    pub evapotranspiration: f32,
    pub soil_moisture: f32,
    pub runoff: f32,
}

#[derive(Clone, Debug)]
pub struct PointEnvironment {
    pub point: Point,
    pub grid_x: usize,
    pub grid_y: usize,
    pub latitude: f32,
    pub elevation: f32,
    pub terrain: String,
    pub water: String,
    pub climate: ClimateModel,
    pub months: [MonthClimate; 12],
    pub soil_moisture: f32,
    pub water_access: f32,
    pub wind_direction: f32,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct PlanetEnvironmentSummary {
    pub mean_temperature_c: f32,
    pub minimum_temperature_c: f32,
    pub maximum_temperature_c: f32,
    pub mean_moisture_percent: f32,
    pub ocean_area_percent: f32,
    pub land_area_percent: f32,
    pub sampled_area_weight: f64,
}

#[derive(Clone, Debug)]
pub struct PlanetPointEnvironment {
    pub position: PlanetPosition,
    pub latitude_deg: f32,
    pub longitude_deg: f32,
    pub elevation_m: f32,
    pub temperature_c: f32,
    pub moisture_percent: f32,
    pub terrain: u8,
    pub water: bool,
    pub climate: ClimateModel,
    pub months: [MonthClimate; 12],
}

pub fn analyze_planet(planet: &PlanetState) -> PlanetEnvironmentSummary {
    if planet.surface.is_empty() {
        return PlanetEnvironmentSummary::default();
    }
    let mut temperature_sum = 0.0_f64;
    let mut moisture_sum = 0.0_f64;
    let mut ocean_weight = 0.0_f64;
    let mut total_weight = 0.0_f64;
    let mut minimum_temperature = f32::INFINITY;
    let mut maximum_temperature = f32::NEG_INFINITY;
    for y in 0..planet.surface.height {
        let latitude = std::f64::consts::FRAC_PI_2
            - (f64::from(y) + 0.5) / f64::from(planet.surface.height) * std::f64::consts::PI;
        let weight = latitude.cos().abs().max(1.0e-8);
        for x in 0..planet.surface.width {
            let sample = planet.surface.sample_xy(x, y);
            temperature_sum += f64::from(sample.temperature_c) * weight;
            moisture_sum += f64::from(sample.moisture) * weight;
            if sample.water {
                ocean_weight += weight;
            }
            minimum_temperature = minimum_temperature.min(sample.temperature_c);
            maximum_temperature = maximum_temperature.max(sample.temperature_c);
            total_weight += weight;
        }
    }
    PlanetEnvironmentSummary {
        mean_temperature_c: (temperature_sum / total_weight.max(f64::EPSILON)) as f32,
        minimum_temperature_c: minimum_temperature,
        maximum_temperature_c: maximum_temperature,
        mean_moisture_percent: (moisture_sum / total_weight.max(f64::EPSILON) * 100.0) as f32,
        ocean_area_percent: (ocean_weight / total_weight.max(f64::EPSILON) * 100.0) as f32,
        land_area_percent: ((total_weight - ocean_weight) / total_weight.max(f64::EPSILON) * 100.0)
            as f32,
        sampled_area_weight: total_weight,
    }
}

pub fn analyze_planet_point(
    planet: &PlanetState,
    position: PlanetPosition,
    year: i32,
) -> PlanetPointEnvironment {
    let sample = planet.sample_detail(position);
    let (latitude, longitude) = position.latitude_longitude_deg();
    let climate = if sample.water {
        if latitude.abs() > 66.0 {
            ClimateModel::Polar
        } else {
            ClimateModel::Temperate
        }
    } else if sample.terrain == PlanetSurface::TERRAIN_DESERT {
        ClimateModel::Arid
    } else if sample.terrain == PlanetSurface::TERRAIN_RAINFOREST || latitude.abs() < 23.5 {
        ClimateModel::Tropical
    } else if latitude.abs() > 48.0 || sample.elevation_m > 1_800.0 {
        ClimateModel::Continental
    } else {
        ClimateModel::Temperate
    };
    let [x, y, z] = position.components();
    let point_seed = planet
        .generation_config
        .stable_subseed(&format!("planet-weather-{:.6}-{:.6}-{:.6}", x, y, z))
        as u32;
    let mut months = simulate_year(climate, year, latitude as f32, point_seed);
    let simulated_mean = annual_temperature_mean(&months);
    let altitude_cooling = sample.elevation_m.max(0.0) / 1_000.0 * 6.0;
    let moisture_bias = (sample.moisture - 0.5) * 24.0;
    for month in &mut months {
        month.temperature += sample.temperature_c - simulated_mean - altitude_cooling * 0.18;
        month.humidity = (month.humidity + moisture_bias).clamp(2.0, 100.0);
        month.precipitation *= (0.45 + sample.moisture * 1.1).clamp(0.2, 1.7);
        month.soil_moisture = (month.soil_moisture + sample.moisture * 34.0).clamp(0.0, 100.0);
    }
    PlanetPointEnvironment {
        position,
        latitude_deg: latitude as f32,
        longitude_deg: longitude as f32,
        elevation_m: sample.elevation_m,
        temperature_c: sample.temperature_c,
        moisture_percent: sample.moisture * 100.0,
        terrain: sample.terrain,
        water: sample.water,
        climate,
        months,
    }
}

fn annual_temperature_mean(months: &[MonthClimate; 12]) -> f32 {
    months.iter().map(|month| month.temperature).sum::<f32>() / 12.0
}

pub fn populate_spatial_fields(map: &mut NativeMap, climate: ClimateModel, seed: u32) {
    let width = map.grid_width;
    let height = map.grid_height;
    let size = width.saturating_mul(height);
    if width == 0 || height == 0 || map.elevation.len() < size {
        return;
    }

    let (base_temperature, base_precipitation, configured_humidity, base_wind) = match climate {
        ClimateModel::Temperate => (13.0, 1_050.0, 0.67, 5.0),
        ClimateModel::Continental => (7.0, 720.0, 0.58, 5.6),
        ClimateModel::Tropical => (25.0, 2_100.0, 0.82, 3.8),
        ClimateModel::Arid => (22.0, 260.0, 0.31, 6.1),
        ClimateModel::Polar => (-7.0, 310.0, 0.69, 7.3),
    };
    let ocean_distance = ocean_distances(map);
    let cell_km = map.width.max(map.height) / width.max(height).max(1) as f32;
    let mut gradient_x = vec![0.0; size];
    let mut gradient_y = vec![0.0; size];
    let mut temperature = vec![0.0; size];
    let mut wind_x = vec![0.0; size];
    let mut wind_y = vec![0.0; size];
    let latitude_span = (map.height / 111.0).clamp(0.0, 170.0);

    for y in 0..height {
        for x in 0..width {
            let index = y * width + x;
            let left = map.elevation[y * width + x.saturating_sub(1)];
            let right = map.elevation[y * width + (x + 1).min(width - 1)];
            let up = map.elevation[y.saturating_sub(1) * width + x];
            let down = map.elevation[(y + 1).min(height - 1) * width + x];
            let meters = (cell_km * 2_000.0).max(1.0);
            gradient_x[index] = (right - left) / meters;
            gradient_y[index] = (down - up) / meters;

            let nx = x as f32 / width.saturating_sub(1).max(1) as f32;
            let ny = y as f32 / height.saturating_sub(1).max(1) as f32;
            let latitude = (37.5 + (0.5 - ny) * latitude_span).clamp(-89.0, 89.0);
            let elevation = map.elevation[index];
            let relief = ((elevation - map.sea_level).max(0.0) / 4_500.0).clamp(0.0, 1.0);
            let prevailing = (245.0_f32
                + (fractal_noise(seed ^ 0x2f6e_2b1d, nx * 5.0, ny * 5.0, 3) - 0.5) * 42.0)
                .to_radians();
            let base_x = prevailing.sin() * base_wind;
            let base_y = -prevailing.cos() * base_wind;
            let cross = base_x * gradient_y[index] - base_y * gradient_x[index];
            let turn = (cross * 8.0).clamp(-0.7, 0.7)
                + (fractal_noise(seed ^ 0x7f4a_7c15, nx * 7.0, ny * 7.0, 3) - 0.5) * 0.34;
            let shelter = 1.0 - relief * 0.3;
            wind_x[index] = (base_x * turn.cos() - base_y * turn.sin()) * shelter;
            wind_y[index] = (base_x * turn.sin() + base_y * turn.cos()) * shelter;

            let coastal =
                (-ocean_distance[index] / (width.min(height).max(1) as f32 * 0.16).max(3.0)).exp();
            let latitude_effect = -(latitude.abs() - 37.5) * 0.48;
            let lapse = ((elevation - map.sea_level).max(0.0) / 1_000.0) * 6.2;
            let aspect = (-gradient_y[index] * 1.4).clamp(-2.2, 2.2);
            let regional = (fractal_noise(seed ^ 0x94d0_49bb, nx * 8.0, ny * 8.0, 4) - 0.5) * 2.1;
            temperature[index] =
                base_temperature + latitude_effect - lapse + coastal * 2.5 + aspect + regional;
        }
    }

    temperature = smooth_field(&temperature, width, height, 1);
    let mut vapor = vec![0.0; size];
    let mut accumulated_rain = vec![0.0; size];
    for index in 0..size {
        let ocean = map.water.get(index).is_some_and(|water| water != "land");
        let coastal =
            (-ocean_distance[index] / (width.min(height).max(1) as f32 * 0.16).max(3.0)).exp();
        vapor[index] = if ocean {
            1.15
        } else {
            configured_humidity * 0.18 + coastal * 0.22
        };
    }

    let iterations = ((size as f32).sqrt() / 34.0).round().clamp(6.0, 12.0) as usize;
    for _ in 0..iterations {
        let mut next = vec![0.0; size];
        for y in 0..height {
            for x in 0..width {
                let index = y * width + x;
                let speed = wind_x[index].hypot(wind_y[index]).max(0.15);
                let step = 0.9 + (speed / 9.0).min(1.4);
                let upstream_x = x as f32 - wind_x[index] / speed * step;
                let upstream_y = y as f32 - wind_y[index] / speed * step;
                let upstream_vapor = sample_bilinear(&vapor, width, height, upstream_x, upstream_y);
                let upstream_elevation =
                    sample_bilinear(&map.elevation, width, height, upstream_x, upstream_y);
                let coastal = (-ocean_distance[index]
                    / (width.min(height).max(1) as f32 * 0.18).max(4.0))
                .exp();
                let ocean = map.water.get(index).is_some_and(|water| water != "land");
                let source = if ocean { 0.3 } else { coastal * 0.025 };
                let available = (upstream_vapor * 0.992 + source).min(1.6);
                let uplift = (map.elevation[index] - upstream_elevation).max(0.0) / 1_000.0;
                let descent = (upstream_elevation - map.elevation[index]).max(0.0) / 1_000.0;
                let cold = (7.0 - temperature[index]).max(0.0) / 120.0;
                let condensation = (0.035 + uplift * 0.24 + cold).clamp(0.018, 0.58);
                let rain = available * condensation * (-descent * 0.72).exp();
                accumulated_rain[index] += rain;
                let recycling = if ocean {
                    0.0
                } else {
                    (accumulated_rain[index] * 0.003).min(0.025)
                };
                next[index] = (available - rain + recycling).max(0.012);
            }
        }
        vapor = next;
    }

    let mut precipitation = vec![0.0; size];
    let mut moisture = vec![0.0; size];
    let mut runoff = vec![0.0; size];
    for y in 0..height {
        for x in 0..width {
            let index = y * width + x;
            let normalized_latitude =
                (y as f32 / height.saturating_sub(1).max(1) as f32 * 2.0 - 1.0).abs();
            let equatorial_wet = (-(normalized_latitude * normalized_latitude) / 0.055).exp();
            let subtropical_dry = (-((normalized_latitude - 0.33).powi(2)) / 0.018).exp();
            let temperate_wet = (-((normalized_latitude - 0.58).powi(2)) / 0.04).exp();
            let circulation = (0.82 + equatorial_wet * 0.24 - subtropical_dry * 0.28
                + temperate_wet * 0.1)
                .clamp(0.55, 1.28);
            let interior = (1.0 - ocean_distance[index] / width.max(height).max(1) as f32 * 0.72)
                .clamp(0.48, 1.0);
            let noise =
                0.9 + fractal_noise(seed ^ 0x56a3_70d9, x as f32 / 36.0, y as f32 / 36.0, 4) * 0.2;
            let coastal =
                (-ocean_distance[index] / (width.min(height).max(1) as f32 * 0.18).max(4.0)).exp();
            let rain_signal = accumulated_rain[index] / iterations.max(1) as f32;
            let value = (base_precipitation
                * (0.42 + rain_signal * 1.48 + coastal * 0.12)
                * circulation
                * interior
                * noise)
                .max(4.0);
            let ocean = map.water.get(index).is_some_and(|water| water != "land");
            precipitation[index] = if ocean {
                value.max(base_precipitation * 0.72)
            } else {
                value
            };
            moisture[index] = (precipitation[index] / (base_precipitation * 1.35).max(300.0)
                * 0.76
                + vapor[index] * 0.24)
                .clamp(0.0, 1.0);
            let potential_et = (17.0 * (temperature[index] + 7.0).max(0.0)).max(60.0);
            let slope = gradient_x[index].hypot(gradient_y[index]);
            let infiltration =
                precipitation[index] * (0.12 + (0.18 - slope * 0.3).clamp(0.0, 0.18));
            runoff[index] = if ocean {
                0.0
            } else {
                (precipitation[index] - potential_et * 0.58 - infiltration).max(0.0)
            };
        }
    }

    map.temperature = temperature;
    map.precipitation = smooth_field(&precipitation, width, height, 2);
    map.moisture = smooth_field(&moisture, width, height, 2)
        .into_iter()
        .map(|value| value.clamp(0.0, 1.0))
        .collect();
    map.runoff = smooth_field(&runoff, width, height, 1);
    map.wind_x = wind_x;
    map.wind_y = wind_y;
    map.humidity = vec![0.0; size];
    map.solar_hours = vec![0.0; size];
    map.solar_irradiance = vec![0.0; size];
    map.snowfall = vec![0.0; size];
    map.snow_cover = vec![0.0; size];
    map.evapotranspiration = vec![0.0; size];
    map.flow_accumulation = vec![0.0; size];
    map.river_order = vec![0.0; size];
    for index in 0..size {
        let y = index / width;
        let latitude = (37.5
            + (0.5 - y as f32 / height.saturating_sub(1).max(1) as f32) * latitude_span)
            .clamp(-89.0, 89.0);
        let day_length = annual_mean_day_length(latitude);
        let humidity = (0.14
            + (map.moisture[index] * 0.58
                + (map.precipitation[index] / 1_800.0).min(1.0) * 0.22
                + configured_humidity * 0.2)
                * 0.82)
            .clamp(8.0, 99.0);
        let cloud = (map.precipitation[index] / (base_precipitation * 1.7).max(450.0) * 0.58
            + map.moisture[index] * 0.25)
            .clamp(0.05, 0.88);
        let sunshine = (day_length * (1.0 - cloud * 0.72)).clamp(0.0, day_length);
        let irradiance = (1_361.0 * latitude.to_radians().cos().abs().max(0.08) * sunshine / 24.0
            * (1.0 - cloud * 0.68))
            .max(0.0);
        let snowfall = if map.temperature[index] < 1.5 {
            map.precipitation[index] * ((1.5 - map.temperature[index]) / 10.0).clamp(0.0, 1.0)
        } else {
            0.0
        };
        map.humidity[index] = humidity;
        map.solar_hours[index] = sunshine;
        map.solar_irradiance[index] = irradiance;
        map.snowfall[index] = snowfall;
        map.snow_cover[index] = (snowfall * 0.7 - map.temperature[index].max(0.0) * 18.0).max(0.0);
        map.evapotranspiration[index] =
            ((map.temperature[index] + 5.0).max(0.0) * (1.0 - humidity / 130.0) * sunshine * 3.1)
                .max(0.0);
        map.flow_accumulation[index] =
            map.runoff[index] * (1.0 + map.elevation[index].max(0.0) / 8_000.0);
        map.river_order[index] = if map.runoff[index] > map.precipitation[index] * 0.2 {
            2.0
        } else {
            0.0
        };
    }
}

fn ocean_distances(map: &NativeMap) -> Vec<f32> {
    let size = map.grid_width.saturating_mul(map.grid_height);
    let mut distance = vec![f32::INFINITY; size];
    let mut queue = VecDeque::with_capacity(size);
    for index in 0..size {
        if map.water.get(index).is_some_and(|water| water != "land") {
            distance[index] = 0.0;
            queue.push_back(index);
        }
    }
    while let Some(index) = queue.pop_front() {
        let x = index % map.grid_width;
        let y = index / map.grid_width;
        for (nx, ny) in [
            (x.wrapping_sub(1), y),
            (x + 1, y),
            (x, y.wrapping_sub(1)),
            (x, y + 1),
        ] {
            if nx >= map.grid_width || ny >= map.grid_height {
                continue;
            }
            let next = ny * map.grid_width + nx;
            if distance[next] > distance[index] + 1.0 {
                distance[next] = distance[index] + 1.0;
                queue.push_back(next);
            }
        }
    }
    distance
}

fn sample_bilinear(values: &[f32], width: usize, height: usize, x: f32, y: f32) -> f32 {
    let x = x.clamp(0.0, width.saturating_sub(1) as f32);
    let y = y.clamp(0.0, height.saturating_sub(1) as f32);
    let x0 = x.floor() as usize;
    let y0 = y.floor() as usize;
    let x1 = (x0 + 1).min(width - 1);
    let y1 = (y0 + 1).min(height - 1);
    let tx = x - x0 as f32;
    let ty = y - y0 as f32;
    let top = values[y0 * width + x0] * (1.0 - tx) + values[y0 * width + x1] * tx;
    let bottom = values[y1 * width + x0] * (1.0 - tx) + values[y1 * width + x1] * tx;
    top * (1.0 - ty) + bottom * ty
}

fn smooth_field(values: &[f32], width: usize, height: usize, passes: usize) -> Vec<f32> {
    let mut current = values.to_vec();
    for _ in 0..passes {
        let mut next = current.clone();
        for y in 1..height.saturating_sub(1) {
            for x in 1..width.saturating_sub(1) {
                let mut sum = current[y * width + x] * 4.0;
                let mut weight = 4.0;
                for offset_y in -1_i32..=1 {
                    for offset_x in -1_i32..=1 {
                        if offset_x == 0 && offset_y == 0 {
                            continue;
                        }
                        sum += current[(y as i32 + offset_y) as usize * width
                            + (x as i32 + offset_x) as usize];
                        weight += 1.0;
                    }
                }
                next[y * width + x] = sum / weight;
            }
        }
        current = next;
    }
    current
}

fn fractal_noise(seed: u32, x: f32, y: f32, octaves: usize) -> f32 {
    let mut value = 0.0;
    let mut amplitude = 0.5;
    let mut frequency = 1.0;
    let mut total = 0.0;
    for octave in 0..octaves {
        value += value_noise(
            seed.wrapping_add((octave as u32).wrapping_mul(0x9e37_79b9)),
            x * frequency,
            y * frequency,
        ) * amplitude;
        total += amplitude;
        amplitude *= 0.52;
        frequency *= 2.03;
    }
    value / total.max(0.001)
}

fn value_noise(seed: u32, x: f32, y: f32) -> f32 {
    let x0 = x.floor() as i32;
    let y0 = y.floor() as i32;
    let tx = x - x0 as f32;
    let ty = y - y0 as f32;
    let smooth = |value: f32| value * value * (3.0 - 2.0 * value);
    let hash = |px: i32, py: i32| {
        let index = (px as u32).wrapping_mul(0x85eb_ca6b) ^ (py as u32).wrapping_mul(0xc2b2_ae35);
        (signed_noise(seed, index) + 1.0) * 0.5
    };
    let top = hash(x0, y0) * (1.0 - smooth(tx)) + hash(x0 + 1, y0) * smooth(tx);
    let bottom = hash(x0, y0 + 1) * (1.0 - smooth(tx)) + hash(x0 + 1, y0 + 1) * smooth(tx);
    top * (1.0 - smooth(ty)) + bottom * smooth(ty)
}

fn annual_mean_day_length(latitude: f32) -> f32 {
    let latitude = latitude.to_radians().clamp(-1.553, 1.553);
    let declination = 23.44_f32.to_radians();
    let summer = (-latitude.tan() * declination.tan())
        .clamp(-1.0, 1.0)
        .acos()
        * 24.0
        / std::f32::consts::PI;
    let winter = (-latitude.tan() * (-declination).tan())
        .clamp(-1.0, 1.0)
        .acos()
        * 24.0
        / std::f32::consts::PI;
    (summer + winter) * 0.5
}

pub fn analyze_point(
    map: &NativeMap,
    point: Point,
    year: i32,
    base_model: ClimateModel,
    seed: u32,
) -> PointEnvironment {
    let grid_x = ((point.x / map.width.max(1.0)) * map.grid_width as f32)
        .floor()
        .clamp(0.0, map.grid_width.saturating_sub(1) as f32) as usize;
    let grid_y = ((point.y / map.height.max(1.0)) * map.grid_height as f32)
        .floor()
        .clamp(0.0, map.grid_height.saturating_sub(1) as f32) as usize;
    let index = grid_y * map.grid_width + grid_x;
    let latitude = 90.0 - point.y / map.height.max(1.0) * 180.0;
    let elevation = map.elevation.get(index).copied().unwrap_or(map.sea_level);
    let terrain = map
        .terrain
        .get(index)
        .cloned()
        .unwrap_or_else(|| "plain".to_owned());
    let water = map
        .water
        .get(index)
        .cloned()
        .unwrap_or_else(|| "land".to_owned());
    let climate = if water != "land" {
        if latitude.abs() > 66.0 {
            ClimateModel::Polar
        } else {
            ClimateModel::Temperate
        }
    } else if latitude.abs() > 68.0 || elevation > 4_200.0 {
        ClimateModel::Polar
    } else if terrain == "desert" || terrain == "rock" {
        ClimateModel::Arid
    } else if latitude.abs() < 23.5 && terrain != "mountain" {
        ClimateModel::Tropical
    } else if latitude.abs() > 46.0 || elevation > 1_800.0 {
        ClimateModel::Continental
    } else {
        base_model
    };
    let point_seed = seed
        ^ (grid_x as u32).wrapping_mul(0x9e37_79b9)
        ^ (grid_y as u32).wrapping_mul(0x85eb_ca6b);
    let mut months = simulate_year(climate, year, latitude, point_seed);
    let altitude_cooling = ((elevation - map.sea_level).max(0.0) / 1_000.0) * 6.0;
    let coastal_moisture = if water != "land" { 13.0 } else { 0.0 };
    for month in &mut months {
        month.temperature -= altitude_cooling;
        month.humidity = (month.humidity + coastal_moisture).clamp(5.0, 99.0);
        if terrain == "forest" || terrain == "wetland" {
            month.precipitation *= 1.15;
            month.humidity = (month.humidity + 7.0).min(99.0);
        }
        month.snowfall = if month.temperature <= 1.5 {
            month.precipitation * ((1.5 - month.temperature) / 8.0).clamp(0.0, 1.0)
        } else {
            0.0
        };
        month.snow_cover = (month.snowfall * 0.72 - month.temperature.max(0.0) * 2.4).max(0.0);
        month.evapotranspiration = ((month.temperature + 5.0).max(0.0)
            * (1.0 - month.humidity / 130.0)
            * (month.solar_hours / 12.0)
            * 4.6)
            .max(0.0);
        month.soil_moisture = (month.precipitation * 0.42 - month.evapotranspiration * 0.28
            + if terrain == "wetland" {
                28.0
            } else if terrain == "forest" {
                12.0
            } else {
                0.0
            })
        .clamp(0.0, 100.0);
        month.runoff = (month.precipitation * (0.12 + elevation.max(0.0) / 24_000.0)
            + month.snow_cover * 0.08)
            .max(0.0);
    }
    if let Some(spatial_temperature) = map.temperature.get(index).copied() {
        let simulated_mean = months.iter().map(|month| month.temperature).sum::<f32>() / 12.0;
        let correction = spatial_temperature - simulated_mean;
        for month in &mut months {
            month.temperature += correction;
        }
    }
    if let Some(spatial_precipitation) = map.precipitation.get(index).copied() {
        let simulated_total = months
            .iter()
            .map(|month| month.precipitation)
            .sum::<f32>()
            .max(0.001);
        let scale = (spatial_precipitation.max(0.0) / simulated_total).clamp(0.08, 12.0);
        for month in &mut months {
            month.precipitation *= scale;
        }
    }
    if let Some(spatial_humidity) = map.humidity.get(index).copied() {
        let simulated_mean = months.iter().map(|month| month.humidity).sum::<f32>() / 12.0;
        let correction = spatial_humidity - simulated_mean;
        for month in &mut months {
            month.humidity = (month.humidity + correction).clamp(5.0, 99.0);
        }
    }
    let annual_rain = months.iter().map(|month| month.precipitation).sum::<f32>();
    let soil_moisture = map
        .moisture
        .get(index)
        .copied()
        .map(|value| if value <= 1.0 { value * 100.0 } else { value })
        .unwrap_or_else(|| {
            annual_rain / 18.0
                + if terrain == "forest" { 12.0 } else { 0.0 }
                + if terrain == "wetland" { 28.0 } else { 0.0 }
        })
        .clamp(4.0, 100.0);
    let wind_direction = match (
        map.wind_x.get(index).copied(),
        map.wind_y.get(index).copied(),
    ) {
        (Some(x), Some(y)) => x.atan2(y).to_degrees().rem_euclid(360.0),
        _ => (point_seed % 360) as f32,
    };
    let is_water = water != "land";
    PointEnvironment {
        point,
        grid_x,
        grid_y,
        latitude,
        elevation,
        terrain,
        water,
        climate,
        months,
        soil_moisture,
        water_access: (soil_moisture * 0.72 + if is_water { 28.0 } else { 8.0 }).clamp(0.0, 100.0),
        wind_direction,
    }
}

pub fn weather_at(
    analysis: &PointEnvironment,
    month: usize,
    day: u32,
    hour: u32,
    year: i32,
    seed: u32,
) -> MonthClimate {
    let monthly = analysis.months[month.min(11)];
    let temporal_index = (year as u32)
        .wrapping_mul(372)
        .wrapping_add(month.min(11) as u32 * 31)
        .wrapping_add(day.clamp(1, 31));
    let daily = signed_noise(seed ^ analysis.grid_x as u32, temporal_index);
    let rain_noise = signed_noise(seed ^ 0xa511_e9b3 ^ analysis.grid_y as u32, temporal_index);
    let hour = hour.min(23) as f32;
    let diurnal = ((hour - 14.0) / 24.0 * std::f32::consts::TAU).cos();
    MonthClimate {
        temperature: monthly.temperature + daily * 2.2 + diurnal * 3.4,
        precipitation: (monthly.precipitation / 30.0 * (1.0 + rain_noise * 1.65).max(0.0)).max(0.0),
        humidity: (monthly.humidity + rain_noise * 11.0 - diurnal * 5.0).clamp(5.0, 99.0),
        wind: (monthly.wind + daily.abs() * 2.1 + rain_noise.abs()).max(0.2),
        solar_hours: (monthly.solar_hours - monthly.precipitation / 90.0 + diurnal.max(0.0))
            .clamp(0.0, 24.0),
        solar_irradiance: (monthly.solar_irradiance * (1.0 - monthly.humidity / 260.0)
            + diurnal.max(0.0) * 35.0)
            .max(0.0),
        snowfall: monthly.snowfall / 30.0,
        snow_cover: monthly.snow_cover,
        evapotranspiration: monthly.evapotranspiration / 30.0,
        soil_moisture: monthly.soil_moisture,
        runoff: monthly.runoff / 30.0,
    }
}

pub fn simulate_year(
    model: ClimateModel,
    year: i32,
    latitude: f32,
    seed: u32,
) -> [MonthClimate; 12] {
    let (mean, amplitude, rain, humidity, wind) = match model {
        ClimateModel::Temperate => (11.0, 12.0, 78.0, 67.0, 4.8),
        ClimateModel::Continental => (6.0, 22.0, 54.0, 58.0, 5.4),
        ClimateModel::Tropical => (25.0, 3.5, 178.0, 82.0, 3.7),
        ClimateModel::Arid => (22.0, 15.0, 17.0, 31.0, 5.9),
        ClimateModel::Polar => (-8.0, 17.0, 24.0, 69.0, 7.2),
    };
    std::array::from_fn(|month| {
        let phase = (month as f32 / 12.0 * std::f32::consts::TAU) - 1.7;
        let hemisphere = if latitude < 0.0 { -1.0 } else { 1.0 };
        let noise = signed_noise(seed ^ year as u32, month as u32);
        let rain_noise = signed_noise(
            seed.wrapping_add(0x9e37_79b9),
            (year as u32).wrapping_mul(17) + month as u32,
        );
        let seasonal_rain = match model {
            ClimateModel::Tropical => 1.0 + 0.48 * (phase + 0.8).sin(),
            ClimateModel::Arid => 1.0 + 0.7 * (phase - 0.4).sin(),
            _ => 1.0 + 0.22 * phase.cos(),
        };
        MonthClimate {
            temperature: mean + amplitude * phase.sin() * hemisphere + noise * 1.4,
            precipitation: (rain * seasonal_rain + rain_noise * rain * 0.18).max(0.0),
            humidity: (humidity + rain_noise * 7.0 + phase.cos() * 4.0).clamp(10.0, 99.0),
            wind: (wind + noise.abs() * 2.2 + phase.sin().abs()).max(0.3),
            solar_hours: (12.0 + phase.sin() * hemisphere * 4.2 - latitude.abs() / 90.0 * 1.2)
                .clamp(0.0, 24.0),
            solar_irradiance: (205.0 + phase.sin() * hemisphere * 95.0 - latitude.abs() * 1.1)
                .max(12.0),
            snowfall: 0.0,
            snow_cover: 0.0,
            evapotranspiration: 0.0,
            soil_moisture: 0.0,
            runoff: 0.0,
        }
    })
}

pub fn suitability(model: ClimateModel) -> [(&'static str, f32); 6] {
    match model {
        ClimateModel::Temperate => [
            ("wheat", 0.88),
            ("rice", 0.56),
            ("barley", 0.84),
            ("cattle", 0.82),
            ("sheep", 0.79),
            ("horse", 0.72),
        ],
        ClimateModel::Continental => [
            ("wheat", 0.72),
            ("rice", 0.28),
            ("barley", 0.77),
            ("cattle", 0.66),
            ("sheep", 0.71),
            ("horse", 0.81),
        ],
        ClimateModel::Tropical => [
            ("wheat", 0.23),
            ("rice", 0.94),
            ("barley", 0.18),
            ("cattle", 0.49),
            ("sheep", 0.31),
            ("horse", 0.38),
        ],
        ClimateModel::Arid => [
            ("wheat", 0.35),
            ("rice", 0.08),
            ("barley", 0.42),
            ("cattle", 0.29),
            ("sheep", 0.63),
            ("horse", 0.55),
        ],
        ClimateModel::Polar => [
            ("wheat", 0.08),
            ("rice", 0.02),
            ("barley", 0.12),
            ("cattle", 0.17),
            ("sheep", 0.31),
            ("horse", 0.19),
        ],
    }
}

fn signed_noise(seed: u32, index: u32) -> f32 {
    let mut value = seed ^ index.wrapping_mul(0x45d9_f3b);
    value ^= value >> 16;
    value = value.wrapping_mul(0x45d9_f3b);
    value ^= value >> 16;
    value as f32 / u32::MAX as f32 * 2.0 - 1.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn simulation_is_deterministic_and_bounded() {
        let first = simulate_year(ClimateModel::Temperate, 240, 37.5, 11);
        let second = simulate_year(ClimateModel::Temperate, 240, 37.5, 11);
        for (a, b) in first.iter().zip(second) {
            assert_eq!(a.temperature, b.temperature);
            assert!((0.0..=99.0).contains(&a.humidity));
            assert!(a.precipitation >= 0.0);
        }
    }

    #[test]
    fn whole_planet_analysis_is_area_weighted_and_point_stable() {
        let mut config = crate::planet_config::PlanetGenerationConfig::default();
        config.quality = crate::planet_config::GenerationQuality::Draft;
        let mut planet = PlanetState::default();
        planet
            .apply_generation_config(config)
            .expect("planet generation");
        let summary = analyze_planet(&planet);
        assert!(summary.sampled_area_weight > 0.0);
        assert!((0.0..=100.0).contains(&summary.ocean_area_percent));
        assert!((0.0..=100.0).contains(&summary.mean_moisture_percent));
        assert!(summary.minimum_temperature_c <= summary.mean_temperature_c);
        assert!(summary.maximum_temperature_c >= summary.mean_temperature_c);

        let position = PlanetPosition::from_latitude_longitude_deg(38.0, 128.0);
        let first = analyze_planet_point(&planet, position, 1200);
        let second = analyze_planet_point(&planet, position, 1200);
        assert_eq!(first.months[3].temperature, second.months[3].temperature);
        assert_eq!(first.elevation_m, second.elevation_m);
    }

    #[test]
    fn point_analysis_uses_spatial_surface_and_stays_deterministic() {
        let map = NativeMap {
            source_id: "test".to_owned(),
            region_id: None,
            map_view_id: None,
            title: "Test".to_owned(),
            width: 20.0,
            height: 10.0,
            logical_pixel_width: 200,
            logical_pixel_height: 100,
            surface_cell_m: NativeMap::SURFACE_CELL_METERS as f32,
            grid_width: 2,
            grid_height: 2,
            sea_level: 0.0,
            climate_model: 0,
            environment_seed: 99,
            generation_settings: None,
            geologic_guide: None,
            causal_geology: Default::default(),
            generation_diagnostics: Default::default(),
            elevation: vec![-20.0, 120.0, 2_400.0, 80.0],
            terrain: vec![
                "plain".to_owned(),
                "forest".to_owned(),
                "mountain".to_owned(),
                "desert".to_owned(),
            ],
            water: vec![
                "ocean".to_owned(),
                "land".to_owned(),
                "land".to_owned(),
                "land".to_owned(),
            ],
            temperature: Vec::new(),
            precipitation: Vec::new(),
            moisture: Vec::new(),
            humidity: Vec::new(),
            runoff: Vec::new(),
            wind_x: Vec::new(),
            wind_y: Vec::new(),
            solar_hours: Vec::new(),
            solar_irradiance: Vec::new(),
            snowfall: Vec::new(),
            snow_cover: Vec::new(),
            evapotranspiration: Vec::new(),
            flow_accumulation: Vec::new(),
            river_order: Vec::new(),
            roads: Vec::new(),
            place_names: Vec::new(),
            rivers: Vec::new(),
            river_graph: Default::default(),
            drainage_outlets: Vec::new(),
            locations: Vec::new(),
            factions: Vec::new(),
            territories: Vec::new(),
            territory_owners: vec![-1; 4],
            territory_history: Vec::new(),
            events: Vec::new(),
            environment_pins: Vec::new(),
            current_year: 10,
            canonical_surface: None,
            surface_revision: 0,
        };
        let point = Point { x: 15.0, y: 2.0 };
        let first = analyze_point(&map, point, 10, ClimateModel::Temperate, 99);
        let second = analyze_point(&map, point, 10, ClimateModel::Temperate, 99);
        assert_eq!(first.grid_x, 1);
        assert_eq!(first.grid_y, 0);
        assert_eq!(first.terrain, "forest");
        assert_eq!(first.months[4].temperature, second.months[4].temperature);
        assert!((0.0..=100.0).contains(&first.water_access));
        let weather = weather_at(&first, 4, 12, 15, 10, 99);
        let repeated = weather_at(&first, 4, 12, 15, 10, 99);
        assert_eq!(weather.temperature, repeated.temperature);
        assert!(weather.precipitation >= 0.0);

        let mut generated = map.clone();
        populate_spatial_fields(&mut generated, ClimateModel::Temperate, 99);
        assert_eq!(generated.temperature.len(), 4);
        assert_eq!(generated.precipitation.len(), 4);
        assert_eq!(generated.humidity.len(), 4);
        assert!(generated.temperature.iter().all(|value| value.is_finite()));
        assert!(
            generated
                .precipitation
                .iter()
                .all(|value| value.is_finite() && *value >= 0.0)
        );
        assert!(
            generated
                .humidity
                .iter()
                .all(|value| (8.0..=99.0).contains(value))
        );
    }
}
use std::collections::VecDeque;

use crate::{
    model::{NativeMap, Point},
    spatial::{PlanetPosition, PlanetState, PlanetSurface},
};
