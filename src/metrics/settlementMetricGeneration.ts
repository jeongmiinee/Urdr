import type { EventCategory, WorldEvent } from "../model/world";

export type GeneratedSettlementMetricPoint = {
  year: number;
  population: number;
  economy: number;
};

const SHOCK_CATEGORIES = new Set<EventCategory>(["war", "battle", "accident", "natural_disaster", "incident"]);

function hasLinkedShock(locationId: string, startYear: number, endYear: number, events: WorldEvent[]): boolean {
  return events.some((event) => {
    if (!SHOCK_CATEGORIES.has(event.category) || !event.relatedLocationIds.includes(locationId)) return false;
    const eventStart = event.startDateTime?.year ?? event.startYear;
    const eventEnd = event.endDateTime?.year ?? event.endYear ?? eventStart;
    return eventStart <= endYear && eventEnd >= startYear;
  });
}

function constrainValue(
  previous: number,
  requested: number,
  years: number,
  annualGrowth: number,
  annualDecline: number,
  linkedShock: boolean,
): number {
  if (previous <= 0) return Math.max(0, requested);
  const upperShockFactor = linkedShock ? 1.8 : 1;
  const lowerShockFactor = linkedShock ? 0.35 : 1;
  const upper = previous * Math.pow(1 + annualGrowth, Math.max(1, years)) * upperShockFactor;
  const lower = previous * Math.pow(1 - annualDecline, Math.max(1, years)) * lowerShockFactor;
  return Math.max(lower, Math.min(upper, requested));
}

/**
 * Applies conservative continuity only to automatically generated records.
 * Authored metrics remain untouched, while explicitly linked disruptive events
 * permit a wider interval without inferring shocks from titles or prose.
 */
export function constrainGeneratedSettlementMetrics(
  locationId: string,
  points: GeneratedSettlementMetricPoint[],
  events: WorldEvent[],
): GeneratedSettlementMetricPoint[] {
  const ordered = [...points]
    .filter((point) => Number.isFinite(point.year))
    .sort((a, b) => a.year - b.year)
    .filter((point, index, rows) => rows.findIndex((candidate) => candidate.year === point.year) === index);
  if (ordered.length < 2) return ordered;

  const result: GeneratedSettlementMetricPoint[] = [{
    ...ordered[0],
    population: Math.max(0, Math.round(ordered[0].population)),
    economy: Math.max(0, Math.round(ordered[0].economy)),
  }];
  for (let index = 1; index < ordered.length; index += 1) {
    const point = ordered[index];
    const previous = result[index - 1];
    const years = Math.max(1, point.year - previous.year);
    const linkedShock = hasLinkedShock(locationId, previous.year, point.year, events);
    result.push({
      year: point.year,
      population: Math.max(0, Math.round(constrainValue(previous.population, point.population, years, 0.012, 0.008, linkedShock))),
      economy: Math.max(0, Math.round(constrainValue(previous.economy, point.economy, years, 0.02, 0.015, linkedShock))),
    });
  }
  return result;
}
