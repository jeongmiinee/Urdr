import type { LocationType } from "../../model/world";

const ROOTS = [
  "아르", "벨", "카르", "도렌", "엘름", "페른", "가람", "하린",
  "이솔", "제른", "칼렌", "루메", "마레", "노르", "오르", "프라",
  "퀼", "로엔", "세라", "테른", "우르", "베일", "웨른", "유란",
];

const SUFFIXES: Record<Extract<LocationType, "village" | "town" | "city" | "capital">, string[]> = {
  village: ["리", "촌", "골", "들", "샘"],
  town: ["진", "읍", "포", "역", "장"],
  city: ["시", "성", "부", "항", "도"],
  capital: ["경", "황도", "왕도", "대성", "중경"],
};

function hash(seed: number, ownerIndex: number, sequence: number): number {
  let value = Math.imul(seed ^ 0x6d2b79f5, 0x45d9f3b);
  value ^= Math.imul(ownerIndex + 17, 0x119de1f3);
  value ^= Math.imul(sequence + 31, 0x3449f3);
  value ^= value >>> 16;
  return value >>> 0;
}

export function generatedSettlementName(
  seed: number,
  ownerIndex: number,
  sequence: number,
  type: Extract<LocationType, "village" | "town" | "city" | "capital">,
  used: Set<string>,
): string {
  const value = hash(seed, ownerIndex, sequence);
  const suffixes = SUFFIXES[type];
  for (let attempt = 0; attempt < ROOTS.length * suffixes.length; attempt += 1) {
    const root = ROOTS[(value + attempt * 7) % ROOTS.length];
    const suffix = suffixes[(Math.floor(value / ROOTS.length) + attempt * 3) % suffixes.length];
    const name = `${root}${suffix}`;
    if (!used.has(name)) {
      used.add(name);
      return name;
    }
  }
  const fallback = `${ROOTS[value % ROOTS.length]} ${sequence + 1}`;
  used.add(fallback);
  return fallback;
}
