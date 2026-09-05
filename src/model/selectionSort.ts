export type SelectLikeOption = { id: string; label: string; disabled?: boolean };

const numberPattern = /^[0-9]/;
const hangulPattern = /^[가-힣ㄱ-ㅎㅏ-ㅣ]/;
const englishPattern = /^[A-Za-z]/;
const numericCollator = new Intl.Collator("ko-KR", { numeric: true, sensitivity: "base" });
const koreanCollator = new Intl.Collator("ko-KR", { numeric: true, sensitivity: "base" });
const englishCollator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

function group(label: string): number {
  const value = label.trim();
  if (numberPattern.test(value)) return 0;
  if (hangulPattern.test(value)) return 1;
  if (englishPattern.test(value)) return 2;
  return 3;
}

export function compareSelectionLabels(a: string, b: string): number {
  const groupA = group(a);
  const groupB = group(b);
  if (groupA !== groupB) return groupA - groupB;
  if (groupA === 0) return numericCollator.compare(a, b);
  if (groupA === 1) return koreanCollator.compare(a, b);
  if (groupA === 2) return englishCollator.compare(a, b);
  return koreanCollator.compare(a, b);
}

export function sortSelectionOptions<T extends SelectLikeOption>(options: readonly T[]): T[] {
  return [...options].sort((a, b) => {
    if (Boolean(a.disabled) !== Boolean(b.disabled)) return a.disabled ? 1 : -1;
    const labelOrder = compareSelectionLabels(a.label, b.label);
    return labelOrder || a.id.localeCompare(b.id);
  });
}
