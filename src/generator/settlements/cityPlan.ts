import type {
  LocationType,
  Point,
  SettlementDistrictKind,
  SettlementVectorPlan,
} from "../../model/world";
import { mulberry32 } from "../random";

const DISTRICTS: Array<{ kind: SettlementDistrictKind; name: string; color: string }> = [
  { kind: "administrative", name: "행정 지구", color: "#c4a86b" },
  { kind: "market", name: "시장 지구", color: "#d4b95f" },
  { kind: "residential", name: "주거 지구", color: "#9fb884" },
  { kind: "artisan", name: "공방 지구", color: "#b98d72" },
  { kind: "military", name: "군사 지구", color: "#9b8f8a" },
  { kind: "religious", name: "종교 지구", color: "#a999bd" },
  { kind: "harbor", name: "항만 지구", color: "#78aeb4" },
  { kind: "agricultural_edge", name: "근교 농업 지구", color: "#a9bd68" },
];

function polar(center: Point, radius: number, angle: number): Point {
  return { x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius };
}

export function generateSettlementVectorPlan(
  seed: number,
  population: number,
  type: Extract<LocationType, "village" | "town" | "city" | "capital">,
  coastal: boolean,
): SettlementVectorPlan {
  const random = mulberry32(seed ^ Math.trunc(population));
  const diameter = Math.max(420, Math.min(8_000, 360 + Math.sqrt(Math.max(1, population)) * 19));
  const widthM = Math.round(diameter * (0.92 + random() * 0.28));
  const heightM = Math.round(diameter * (0.82 + random() * 0.34));
  const center = { x: widthM / 2, y: heightM / 2 };
  const footprint: Point[] = [];
  const footprintVertices = type === "village" ? 14 : type === "town" ? 18 : 24;
  const phase = random() * Math.PI * 2;
  for (let index = 0; index < footprintVertices; index += 1) {
    const angle = phase + index / footprintVertices * Math.PI * 2;
    const variation = 0.78 + random() * 0.23 + Math.sin(angle * 3 + phase) * 0.055;
    footprint.push({
      x: center.x + Math.cos(angle) * widthM * 0.44 * variation,
      y: center.y + Math.sin(angle) * heightM * 0.44 * variation,
    });
  }

  const districtCount = type === "village" ? 3 : type === "town" ? 5 : type === "city" ? 7 : 8;
  const districts = Array.from({ length: districtCount }, (_, index) => {
    const definition = coastal && index === districtCount - 1
      ? DISTRICTS.find((entry) => entry.kind === "harbor")!
      : DISTRICTS[index % (DISTRICTS.length - 2)];
    const a0 = phase + index / districtCount * Math.PI * 2;
    const a1 = phase + (index + 1) / districtCount * Math.PI * 2;
    const middle = (a0 + a1) / 2;
    const inner = diameter * (index < 2 ? 0.035 : 0.08);
    const outerX = widthM * (0.34 + random() * 0.08);
    const outerY = heightM * (0.34 + random() * 0.08);
    return {
      id: `district-${index + 1}`,
      kind: definition.kind,
      name: definition.name,
      color: definition.color,
      polygon: [
        polar(center, inner, middle),
        { x: center.x + Math.cos(a0) * outerX, y: center.y + Math.sin(a0) * outerY },
        { x: center.x + Math.cos(middle) * outerX * 1.08, y: center.y + Math.sin(middle) * outerY * 1.08 },
        { x: center.x + Math.cos(a1) * outerX, y: center.y + Math.sin(a1) * outerY },
      ],
    };
  });

  const radialCount = type === "village" ? 3 : type === "town" ? 5 : 7;
  const streets: SettlementVectorPlan["streets"] = [];
  for (let index = 0; index < radialCount; index += 1) {
    const angle = phase + index / radialCount * Math.PI * 2 + (random() - 0.5) * 0.18;
    const end = polar(center, diameter * (0.35 + random() * 0.07), angle);
    const bend = polar(center, diameter * 0.18, angle + (random() - 0.5) * 0.22);
    streets.push({
      id: `primary-${index + 1}`,
      kind: "primary",
      widthM: type === "village" ? 5 : type === "capital" ? 16 : 10,
      points: [end, bend, center],
    });
  }
  const ringSegments = Math.max(12, districtCount * 3);
  streets.push({
    id: "secondary-ring",
    kind: "secondary",
    widthM: type === "village" ? 3 : 6,
    points: Array.from({ length: ringSegments + 1 }, (_, index) => {
      const angle = phase + index / ringSegments * Math.PI * 2;
      return polar(center, diameter * (0.17 + Math.sin(angle * 2 + phase) * 0.015), angle);
    }),
  });

  return { version: 1, seed, widthM, heightM, footprint, streets, districts };
}
