import type { SettlementVectorPlan } from "../model/world";

function points(points: Array<{ x: number; y: number }>): string {
  return points.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
}

export function SettlementPlanView({ plan }: { plan: SettlementVectorPlan }) {
  return (
    <section className="settlement-plan-section">
      <h3>정착지 상세도</h3>
      <div className="settlement-plan-frame">
        <svg
          className="settlement-plan-svg"
          viewBox={`0 0 ${plan.widthM} ${plan.heightM}`}
          role="img"
          aria-label="정착지의 구역과 도로를 표시한 벡터 상세도"
        >
          <defs>
            <clipPath id={`settlement-footprint-${plan.seed}`}>
              <polygon points={points(plan.footprint)} />
            </clipPath>
          </defs>
          <polygon className="settlement-plan-ground" points={points(plan.footprint)} />
          <g clipPath={`url(#settlement-footprint-${plan.seed})`}>
            {plan.districts.map((district) => (
              <polygon
                key={district.id}
                className="settlement-plan-district"
                points={points(district.polygon)}
                fill={district.color}
              >
                <title>{district.name}</title>
              </polygon>
            ))}
            {plan.streets.map((street) => (
              <polyline
                key={street.id}
                className={`settlement-plan-street ${street.kind}`}
                points={points(street.points)}
                strokeWidth={street.widthM}
              />
            ))}
          </g>
          <polygon className="settlement-plan-outline" points={points(plan.footprint)} />
        </svg>
      </div>
      <div className="settlement-plan-legend">
        {plan.districts.map((district) => (
          <span key={district.id}><i style={{ backgroundColor: district.color }} />{district.name}</span>
        ))}
      </div>
    </section>
  );
}
