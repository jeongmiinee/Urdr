use crate::model::{CalendarProfile, Language};

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TimelineMoment {
    pub world_year: i32,
    pub day_fraction: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CalendarCoordinates {
    pub year: i32,
    pub year_fraction: f64,
}

impl TimelineMoment {
    pub fn new(world_year: i32, day_fraction: f64) -> Self {
        Self {
            world_year,
            day_fraction: day_fraction.clamp(0.0, 1.0 - f64::EPSILON),
        }
    }
}

pub fn calendar_year(profile: &CalendarProfile, world_year: i32) -> i32 {
    world_year.saturating_sub(profile.epoch_world_year)
}

pub fn absolute_day(moment: TimelineMoment, orbital_period_days: f64) -> f64 {
    let orbital_period_days = orbital_period_days.max(1.0);
    moment.world_year as f64 * orbital_period_days
        + moment.day_fraction.clamp(0.0, 1.0 - f64::EPSILON) * orbital_period_days
}

pub fn timeline_moment_from_absolute_day(
    absolute_day: f64,
    orbital_period_days: f64,
) -> TimelineMoment {
    let orbital_period_days = orbital_period_days.max(1.0);
    let world_year = (absolute_day / orbital_period_days).floor() as i32;
    let day_fraction =
        (absolute_day - world_year as f64 * orbital_period_days) / orbital_period_days;
    TimelineMoment::new(world_year, day_fraction)
}

pub fn calendar_coordinates(
    profile: &CalendarProfile,
    moment: TimelineMoment,
    orbital_period_days: f64,
) -> CalendarCoordinates {
    let orbital_period_days = orbital_period_days.max(1.0);
    let epoch_day = profile
        .epoch_absolute_day
        .unwrap_or(profile.epoch_world_year as f64 * orbital_period_days);
    let year_days = year_length_days(profile) as f64;
    let delta = absolute_day(moment, orbital_period_days) - epoch_day;
    let year = (delta / year_days).floor() as i32;
    let year_fraction = (delta - year as f64 * year_days) / year_days;
    CalendarCoordinates {
        year,
        year_fraction: year_fraction.clamp(0.0, 1.0 - f64::EPSILON),
    }
}

pub fn timeline_moment_from_calendar(
    profile: &CalendarProfile,
    calendar_year: i32,
    date_values: &[u32],
    time_values: &[u32],
    orbital_period_days: f64,
) -> TimelineMoment {
    let orbital_period_days = orbital_period_days.max(1.0);
    let epoch_day = profile
        .epoch_absolute_day
        .unwrap_or(profile.epoch_world_year as f64 * orbital_period_days);
    let year_fraction = fraction_from_units(profile, date_values, time_values);
    let absolute =
        epoch_day + (calendar_year as f64 + year_fraction) * year_length_days(profile) as f64;
    timeline_moment_from_absolute_day(absolute, orbital_period_days)
}

pub fn year_length_days(profile: &CalendarProfile) -> u64 {
    profile
        .date_units
        .iter()
        .skip(1)
        .fold(1_u64, |total, unit| {
            total.saturating_mul(unit.units_per_parent.max(1) as u64)
        })
        .max(1)
}

pub fn day_units(profile: &CalendarProfile, fraction: f64) -> Vec<u32> {
    let mut remainder =
        (fraction.clamp(0.0, 1.0 - f64::EPSILON) * year_length_days(profile) as f64).floor() as u64;
    let mut values = Vec::with_capacity(profile.date_units.len().saturating_sub(1));
    for index in 1..profile.date_units.len() {
        let divisor = profile
            .date_units
            .iter()
            .skip(index + 1)
            .fold(1_u64, |total, unit| {
                total.saturating_mul(unit.units_per_parent.max(1) as u64)
            })
            .max(1);
        let maximum = profile.date_units[index].units_per_parent.max(1) as u64;
        values.push(((remainder / divisor) % maximum) as u32 + 1);
        remainder %= divisor.saturating_mul(maximum).max(1);
    }
    values
}

pub fn time_units(profile: &CalendarProfile, fraction: f64) -> Vec<u32> {
    let year_days = year_length_days(profile) as f64;
    let day_fraction = (fraction.clamp(0.0, 1.0 - f64::EPSILON) * year_days).fract();
    let total_ticks = profile
        .time_units
        .iter()
        .fold(1_u64, |total, unit| {
            total.saturating_mul(unit.units_per_parent.max(1) as u64)
        })
        .max(1);
    let mut remainder = (day_fraction * total_ticks as f64).floor() as u64;
    let mut values = Vec::with_capacity(profile.time_units.len());
    for (index, unit) in profile.time_units.iter().enumerate() {
        let divisor = profile
            .time_units
            .iter()
            .skip(index + 1)
            .fold(1_u64, |total, child| {
                total.saturating_mul(child.units_per_parent.max(1) as u64)
            })
            .max(1);
        values.push(((remainder / divisor) % unit.units_per_parent.max(1) as u64) as u32);
        remainder %= divisor
            .saturating_mul(unit.units_per_parent.max(1) as u64)
            .max(1);
    }
    values
}

pub fn fraction_from_units(
    profile: &CalendarProfile,
    date_values: &[u32],
    time_values: &[u32],
) -> f64 {
    let mut day_index = 0_u64;
    for (index, unit) in profile.date_units.iter().skip(1).enumerate() {
        let value = date_values
            .get(index)
            .copied()
            .unwrap_or(1)
            .clamp(1, unit.units_per_parent.max(1));
        day_index = day_index
            .saturating_mul(unit.units_per_parent.max(1) as u64)
            .saturating_add((value - 1) as u64);
    }
    let mut tick_index = 0_u64;
    let mut tick_count = 1_u64;
    for (index, unit) in profile.time_units.iter().enumerate() {
        let base = unit.units_per_parent.max(1) as u64;
        tick_index = tick_index.saturating_mul(base).saturating_add(
            time_values
                .get(index)
                .copied()
                .unwrap_or(0)
                .min(base as u32 - 1) as u64,
        );
        tick_count = tick_count.saturating_mul(base);
    }
    let day_fraction = tick_index as f64 / tick_count.max(1) as f64;
    ((day_index as f64 + day_fraction) / year_length_days(profile) as f64)
        .clamp(0.0, 1.0 - f64::EPSILON)
}

pub fn climate_month(profile: &CalendarProfile, fraction: f64) -> usize {
    if profile.date_units.len() >= 3 {
        let values = day_units(profile, fraction);
        let months = profile.date_units[1].units_per_parent.max(1) as usize;
        let month = values.first().copied().unwrap_or(1).saturating_sub(1) as usize;
        ((month as f64 / months as f64) * 12.0)
            .floor()
            .clamp(0.0, 11.0) as usize
    } else {
        (fraction.clamp(0.0, 1.0 - f64::EPSILON) * 12.0).floor() as usize
    }
}

pub fn format_moment(
    profile: &CalendarProfile,
    language: Language,
    moment: TimelineMoment,
) -> String {
    format_moment_precision(
        profile,
        language,
        moment,
        profile.date_units.len().saturating_sub(1) + profile.time_units.len(),
    )
}

pub fn format_absolute_moment(
    profile: &CalendarProfile,
    language: Language,
    moment: TimelineMoment,
    orbital_period_days: f64,
) -> String {
    format_absolute_moment_precision(
        profile,
        language,
        moment,
        orbital_period_days,
        profile.date_units.len().saturating_sub(1) + profile.time_units.len(),
    )
}

pub fn format_absolute_moment_precision(
    profile: &CalendarProfile,
    language: Language,
    moment: TimelineMoment,
    orbital_period_days: f64,
    precision: usize,
) -> String {
    let coordinates = calendar_coordinates(profile, moment, orbital_period_days);
    format_profile_coordinates(
        profile,
        language,
        coordinates.year,
        coordinates.year_fraction,
        precision,
    )
}

pub fn format_moment_precision(
    profile: &CalendarProfile,
    language: Language,
    moment: TimelineMoment,
    precision: usize,
) -> String {
    format_profile_coordinates(
        profile,
        language,
        calendar_year(profile, moment.world_year),
        moment.day_fraction,
        precision,
    )
}

fn format_profile_coordinates(
    profile: &CalendarProfile,
    language: Language,
    year: i32,
    year_fraction: f64,
    precision: usize,
) -> String {
    let date_values = day_units(profile, year_fraction);
    let time_values = time_units(profile, year_fraction);
    let mut parts = Vec::new();
    let year_unit = profile
        .date_units
        .first()
        .map(|unit| unit.short_name.as_str())
        .unwrap_or(match language {
            Language::Korean => "년",
            Language::English => "yr",
        });
    if profile.display_mode == "era" {
        let (era, display_year) = if year < 0 {
            (&profile.before_era_short_name, year.saturating_abs())
        } else {
            (&profile.after_era_short_name, year)
        };
        parts.push(format!("{era} {display_year}{year_unit}"));
    } else {
        parts.push(format!("{year}{year_unit}"));
    }
    let date_precision = precision.min(profile.date_units.len().saturating_sub(1));
    for (unit, value) in profile
        .date_units
        .iter()
        .skip(1)
        .zip(date_values)
        .take(date_precision)
    {
        parts.push(format!("{value}{}", unit.short_name));
    }
    let time_precision = precision
        .saturating_sub(date_precision)
        .min(profile.time_units.len());
    if time_precision > 0 {
        let time = profile
            .time_units
            .iter()
            .zip(time_values)
            .take(time_precision)
            .map(|(unit, value)| format!("{value}{}", unit.short_name))
            .collect::<Vec<_>>()
            .join(" ");
        parts.push(time);
    }
    parts.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::CalendarUnit;

    fn profile() -> CalendarProfile {
        CalendarProfile {
            calendar_name: "Test".to_owned(),
            creator: String::new(),
            creator_article_id: None,
            created_at_year: None,
            created_at_absolute_day: None,
            user_faction_ids: Vec::new(),
            mechanism: String::new(),
            display_mode: "era".to_owned(),
            epoch_world_year: 0,
            epoch_absolute_day: Some(0.0),
            before_era_name: "BE".to_owned(),
            after_era_name: "CE".to_owned(),
            before_era_short_name: "BE".to_owned(),
            after_era_short_name: "CE".to_owned(),
            date_units: vec![
                CalendarUnit {
                    id: "y".into(),
                    name: "Year".into(),
                    short_name: "Y".into(),
                    units_per_parent: 1,
                },
                CalendarUnit {
                    id: "m".into(),
                    name: "Month".into(),
                    short_name: "M".into(),
                    units_per_parent: 10,
                },
                CalendarUnit {
                    id: "d".into(),
                    name: "Day".into(),
                    short_name: "D".into(),
                    units_per_parent: 36,
                },
            ],
            time_units: vec![
                CalendarUnit {
                    id: "h".into(),
                    name: "Hour".into(),
                    short_name: "H".into(),
                    units_per_parent: 20,
                },
                CalendarUnit {
                    id: "t".into(),
                    name: "Tick".into(),
                    short_name: "T".into(),
                    units_per_parent: 100,
                },
            ],
        }
    }

    #[test]
    fn units_round_trip_to_same_fraction() {
        let calendar = profile();
        let fraction = 0.54321;
        let dates = day_units(&calendar, fraction);
        let times = time_units(&calendar, fraction);
        let rebuilt = fraction_from_units(&calendar, &dates, &times);
        assert!((fraction - rebuilt).abs() < 0.001);
    }

    #[test]
    fn precision_cycles_from_year_through_all_units() {
        let calendar = profile();
        let moment = TimelineMoment::new(3, 0.54321);
        assert_eq!(
            format_moment_precision(&calendar, Language::English, moment, 0),
            "CE 3Y"
        );
        assert!(format_moment_precision(&calendar, Language::English, moment, 1).contains('M'));
        assert!(!format_moment_precision(&calendar, Language::English, moment, 1).contains('D'));
        assert!(format_moment_precision(&calendar, Language::English, moment, 4).contains('T'));
    }

    #[test]
    fn different_year_lengths_share_the_same_absolute_day() {
        let mut short = profile();
        short.date_units[1].units_per_parent = 9;
        let source = TimelineMoment::new(2, 0.5);
        let coordinates = calendar_coordinates(&short, source, 365.0);
        let rebuilt = timeline_moment_from_calendar(
            &short,
            coordinates.year,
            &day_units(&short, coordinates.year_fraction),
            &time_units(&short, coordinates.year_fraction),
            365.0,
        );
        assert!((absolute_day(source, 365.0) - absolute_day(rebuilt, 365.0)).abs() < 0.01);
    }
}
