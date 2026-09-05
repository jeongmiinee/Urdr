import type { ReactNode } from "react";

export function StructuredInfoPanel({
  title,
  actions,
  className = "",
  children,
}: {
  title: string;
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return <section className={`structured-info-panel ${className}`.trim()}>
    <div className="structured-info-heading"><h3>{title}</h3>{actions}</div>
    <div className="structured-info-rows">{children}</div>
  </section>;
}

export function StructuredInfoRow({ label, children }: { label: string; children: ReactNode }) {
  return <div className="structured-info-row">
    <span>{label}</span>
    <div>{children}</div>
  </div>;
}
