import { useState } from "react";
import { useLocalization } from "../localization";
import type { NewProjectOptions } from "../model/world";

type Props = {
  onCancel: () => void;
  onCreate: (projectTitle: string, options: NewProjectOptions) => void;
};

function NumericDraftInput({ label, value, onChange, minimum, maximum, step, unit }: { label: string; value: string; onChange: (value: string) => void; minimum: number; maximum?: number; step: number; unit?: string }) {
  const parsed = value.trim() === "" ? Number.NaN : Number(value);
  const valid = Number.isFinite(parsed) && parsed >= minimum && (maximum === undefined || parsed <= maximum);
  return <label>{label}{unit ? ` (${unit})` : ""}<input
    type="text"
    inputMode="decimal"
    role="spinbutton"
    value={value}
    aria-invalid={!valid}
    aria-valuemin={minimum}
    aria-valuemax={maximum}
    aria-valuenow={valid ? parsed : undefined}
    data-step={step}
    onChange={(event) => {
      const next = event.target.value.replace(",", ".");
      if (/^-?\d*(?:\.\d*)?$/.test(next)) onChange(next);
    }}
    onKeyDown={(event) => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      event.preventDefault();
      const current = Number.isFinite(parsed) ? parsed : minimum;
      const direction = event.key === "ArrowUp" ? 1 : -1;
      const next = Math.max(minimum, Math.min(maximum ?? Number.POSITIVE_INFINITY, current + direction * step));
      onChange(String(Number(next.toFixed(8))));
    }}
    onBlur={() => {
      if (!Number.isFinite(parsed)) return;
      const bounded = Math.max(minimum, Math.min(maximum ?? Number.POSITIVE_INFINITY, parsed));
      onChange(String(Number(bounded.toFixed(8))));
    }}
  /></label>;
}

export function NewProjectDialog({ onCancel, onCreate }: Props) {
  const { t } = useLocalization();
  const [projectTitle, setProjectTitle] = useState(() => t("newProject.defaultTitle"));
  const [rpgEnabled, setRpgEnabled] = useState(false);
  const [magicEnabled, setMagicEnabled] = useState(false);
  const [latitudeDeg, setLatitudeDeg] = useState("38");
  const [axialTiltDeg, setAxialTiltDeg] = useState("23.44");
  const [dayLengthHours, setDayLengthHours] = useState("24");
  const [gravityMs2, setGravityMs2] = useState("9.80665");
  const [orbitalPeriodDays, setOrbitalPeriodDays] = useState("365");
  const worldValues = {
    latitudeDeg: Number(latitudeDeg),
    axialTiltDeg: Number(axialTiltDeg),
    dayLengthHours: Number(dayLengthHours),
    gravityMs2: Number(gravityMs2),
    orbitalPeriodDays: Number(orbitalPeriodDays),
  };
  const worldValuesValid = Number.isFinite(worldValues.latitudeDeg) && worldValues.latitudeDeg >= -89 && worldValues.latitudeDeg <= 89
    && Number.isFinite(worldValues.axialTiltDeg) && worldValues.axialTiltDeg >= 0 && worldValues.axialTiltDeg <= 90
    && Number.isFinite(worldValues.dayLengthHours) && worldValues.dayLengthHours >= 1
    && Number.isFinite(worldValues.gravityMs2) && worldValues.gravityMs2 >= 0.1
    && Number.isFinite(worldValues.orbitalPeriodDays) && worldValues.orbitalPeriodDays >= 1;
  return (
    <div className="modal-backdrop">
      <section className="modal-card new-project-dialog">
        <header>
          <div>
            <h2>{t("newProject.title")}</h2>
          </div>
          <button type="button" className="icon-button" onClick={onCancel}>
            ×
          </button>
        </header>
        <label>
          {t("newProject.name")}
          <input
            value={projectTitle}
            onChange={(event) => setProjectTitle(event.target.value)}
            autoFocus
          />
        </label>
        <div className="new-project-mode-buttons" role="group" aria-label={t("newProject.rpgMode")}>
          <button type="button" className={rpgEnabled ? "active" : ""} aria-pressed={rpgEnabled} onClick={() => {
            setRpgEnabled((enabled) => {
              if (enabled) setMagicEnabled(false);
              return !enabled;
            });
          }}>{t("newProject.rpgMode")}</button>
          <button type="button" disabled={!rpgEnabled} className={magicEnabled ? "active" : ""} aria-pressed={magicEnabled} onClick={() => setMagicEnabled((enabled) => !enabled)}>{t("newProject.magicEnabled")}</button>
        </div>
        <fieldset className="new-project-world-settings">
          <legend>{t("newProject.worldPhysics")}</legend>
          <div className="form-grid two">
            <NumericDraftInput label={t("newProject.latitude")} value={latitudeDeg} onChange={setLatitudeDeg} minimum={-89} maximum={89} step={0.1} unit="°" />
            <NumericDraftInput label={t("newProject.axialTilt")} value={axialTiltDeg} onChange={setAxialTiltDeg} minimum={0} maximum={90} step={0.01} unit="°" />
            <NumericDraftInput label={t("newProject.dayLength")} value={dayLengthHours} onChange={setDayLengthHours} minimum={1} step={0.1} unit="h" />
            <NumericDraftInput label={t("newProject.gravity")} value={gravityMs2} onChange={setGravityMs2} minimum={0.1} step={0.01} unit="m/s²" />
          </div>
          <NumericDraftInput label={t("newProject.orbitalPeriod")} value={orbitalPeriodDays} onChange={setOrbitalPeriodDays} minimum={1} step={1} unit={t("newProject.days")} />
        </fieldset>
        <p className="dialog-hint">
          {t("newProject.hint")}
        </p>
        <footer>
          <button type="button" className="secondary-button" onClick={onCancel}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={!projectTitle.trim() || !worldValuesValid}
            onClick={() => onCreate(projectTitle.trim(), {
              rpgEnabled,
              magicEnabled,
              ...worldValues,
            })}
          >
            {t("newProject.create")}
          </button>
        </footer>
      </section>
    </div>
  );
}
