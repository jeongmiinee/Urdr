import type { RpgModifier, RpgModifierOperator, RpgScalarValue } from "./schema";

export type RpgEffectiveBreakdown = {
  base: number;
  value: number;
  modifiers: RpgModifier[];
};

function activeAtYear(modifier: RpgModifier, year?: number): boolean {
  if (modifier.active === false) return false;
  if (year === undefined) return true;
  return (modifier.startYear === undefined || modifier.startYear <= year)
    && (modifier.endYear === undefined || modifier.endYear === null || modifier.endYear >= year);
}

export function calculateEffectiveValue(
  baseValue: RpgScalarValue | undefined,
  modifiers: RpgModifier[],
  order: RpgModifierOperator[],
  year?: number,
): RpgEffectiveBreakdown | undefined {
  if (typeof baseValue !== "number" && modifiers.length === 0) return undefined;
  const base = typeof baseValue === "number" ? baseValue : 0;
  let value = base;
  const active = modifiers.filter((modifier) => activeAtYear(modifier, year)).sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  for (const operator of order) {
    const entries = active.filter((modifier) => modifier.operator === operator);
    if (operator === "flat_add") value += entries.reduce((sum, modifier) => sum + modifier.value, 0);
    else if (operator === "percent_add") value *= 1 + entries.reduce((sum, modifier) => sum + modifier.value, 0) / 100;
    else if (operator === "multiply") for (const modifier of entries) value *= modifier.value;
    else if (operator === "minimum") for (const modifier of entries) value = Math.max(value, modifier.value);
    else if (operator === "maximum") for (const modifier of entries) value = Math.min(value, modifier.value);
    else if (operator === "override" && entries.length) value = entries[entries.length - 1].value;
  }
  return { base, value, modifiers: active };
}

export function modifiersForStat(modifiers: RpgModifier[], statId: string): RpgModifier[] {
  const seen = new Set<string>();
  return modifiers.filter((modifier) => {
    const key = `${modifier.sourceArticleId ?? ""}:${modifier.sourceTraitId ?? ""}:${modifier.id}`;
    if (modifier.statId !== statId || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
