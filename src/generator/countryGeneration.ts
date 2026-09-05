import type { GeneratorSettings } from "../model/world";

export type CountryTypeCounts = {
  agricultural: number;
  coastal: number;
  nomadic: number;
  mountain: number;
  commercial: number;
};

export type CountryArchetype = "maritime" | "mountain" | "nomadic" | "agrarian" | "commercial";

export const MAX_GENERATED_COUNTRIES = 24;
export const CALIBRATED_NATURAL_BOUNDARY_WEIGHT = 0.72;

function count(value: unknown): number {
  return Math.max(0, Math.min(MAX_GENERATED_COUNTRIES, Math.trunc(Number(value) || 0)));
}

export function countryTypeCounts(
  settings: Partial<GeneratorSettings>,
): CountryTypeCounts {
  const hasTypedCounts = [
    settings.agriculturalCountryCount,
    settings.coastalCountryCount,
    settings.nomadicCountryCount,
    settings.mountainCountryCount,
    settings.commercialCountryCount,
  ].some((value) => Number.isFinite(value));

  if (hasTypedCounts) {
    let remaining = MAX_GENERATED_COUNTRIES;
    const take = (value: unknown) => {
      const accepted = Math.min(remaining, count(value));
      remaining -= accepted;
      return accepted;
    };
    return {
      agricultural: take(settings.agriculturalCountryCount),
      coastal: take(settings.coastalCountryCount),
      nomadic: take(settings.nomadicCountryCount),
      mountain: take(settings.mountainCountryCount),
      commercial: take(settings.commercialCountryCount),
    };
  }

  const total = Math.max(0, Math.min(MAX_GENERATED_COUNTRIES, Math.round(Number(settings.countryCount) || 0)));
  const coastal = Math.min(total, Math.round(total * Math.max(0, Number(settings.maritimeCountryRatio) || 0)));
  const mountain = Math.min(total - coastal, Math.round(total * Math.max(0, Number(settings.mountainCountryRatio) || 0)));
  const nomadic = Math.min(total - coastal - mountain, Math.round(total * Math.max(0, Number(settings.nomadicCountryRatio) || 0)));
  return { agricultural: total - coastal - mountain - nomadic, coastal, nomadic, mountain, commercial: 0 };
}

export function countryCountSettings(
  settings: Partial<GeneratorSettings>,
): Pick<GeneratorSettings, "agriculturalCountryCount" | "coastalCountryCount" | "nomadicCountryCount" | "mountainCountryCount" | "commercialCountryCount"> {
  const counts = countryTypeCounts(settings);
  return {
    agriculturalCountryCount: counts.agricultural,
    coastalCountryCount: counts.coastal,
    nomadicCountryCount: counts.nomadic,
    mountainCountryCount: counts.mountain,
    commercialCountryCount: counts.commercial,
  };
}

export function totalCountryCount(settings: Partial<GeneratorSettings>): number {
  const counts = countryTypeCounts(settings);
  return Math.min(
    MAX_GENERATED_COUNTRIES,
    counts.agricultural + counts.coastal + counts.nomadic + counts.mountain + counts.commercial,
  );
}
