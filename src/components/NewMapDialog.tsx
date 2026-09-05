import { useMemo, useState } from "react";
import {
  MAP_SCALE_RANGES,
  clampMapPhysicalWidth,
  type MapScaleMode,
  type SimulationMode,
} from "../model/world";
import { useLocalization } from "../localization";
import { formatNumber } from "../formatting";

type Props = {
  suggestedName: string;
  onCancel: () => void;
  onCreate: (
    title: string,
    generationMode: SimulationMode,
    scaleMode: MapScaleMode,
    physicalWidthKm: number,
  ) => void;
};

const VISIBLE_MAP_SCALES: MapScaleMode[] = ["local", "regional"];

export function NewMapDialog({ suggestedName, onCancel, onCreate }: Props) {
  const { language, t } = useLocalization();
  const [title, setTitle] = useState(suggestedName);
  const [scaleMode, setScaleMode] = useState<MapScaleMode>("regional");
  const [physicalWidthKm, setPhysicalWidthKm] = useState(
    MAP_SCALE_RANGES.regional.defaultWidth,
  );
  const range = useMemo(() => MAP_SCALE_RANGES[scaleMode], [scaleMode]);
  const changeScaleMode = (next: MapScaleMode) => {
    setScaleMode(next);
    setPhysicalWidthKm(MAP_SCALE_RANGES[next].defaultWidth);
  };
  return (
    <div className="modal-backdrop">
      <section className="modal-card new-map-dialog">
        <header>
          <div>
            <h2>{t("newMap.title")}</h2>
          </div>
          <button type="button" className="icon-button" onClick={onCancel}>
            ×
          </button>
        </header>
        <label>
          {t("newMap.name")}
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            autoFocus
          />
        </label>
        <div className="new-map-scale-layout">
          <fieldset className="map-scale-picker">
            <legend>{t("newMap.scale")}</legend>
            {VISIBLE_MAP_SCALES.map((mode) => {
              const item = MAP_SCALE_RANGES[mode];
              return (
                <button type="button" key={mode} className={scaleMode === mode ? "active" : ""} aria-pressed={scaleMode === mode} onClick={() => changeScaleMode(mode)}>
                  <strong>{t(mode === "local" ? "mapGenerator.local" : "mapGenerator.regional")}</strong>
                  <span>
                    {formatNumber(item.min, language)}–{formatNumber(item.max, language)}km ·{" "}
                    {t(mode === "local" ? "newMap.localDescription" : "newMap.regionalDescription")}
                  </span>
                </button>
              );
            })}
          </fieldset>
          <label className="map-width-control">
            <strong>{t("newMap.width")}</strong>
            <input
              type="range"
              min={range.min}
              max={range.max}
              step={scaleMode === "local" ? 1 : 10}
              value={physicalWidthKm}
              onChange={(event) => setPhysicalWidthKm(Number(event.target.value))}
            />
            <div className="map-width-input">
              <input
                type="number"
                min={range.min}
                max={range.max}
                step={scaleMode === "local" ? 1 : 10}
                value={physicalWidthKm}
                onChange={(event) => setPhysicalWidthKm(Number(event.target.value))}
              />
              <span>km</span>
            </div>
            <small>
              {t("newMap.allowedRange", { scope: t(scaleMode === "local" ? "mapGenerator.local" : "mapGenerator.regional") })}: {formatNumber(range.min, language)}–
              {formatNumber(range.max, language)}km
            </small>
          </label>
        </div>
        <footer>
          <button type="button" className="secondary-button" onClick={onCancel}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={!title.trim()}
            onClick={() =>
              onCreate(
                title.trim(),
                "realistic",
                scaleMode,
                clampMapPhysicalWidth(scaleMode, physicalWidthKm),
              )
            }
          >
            {t("newMap.create")}
          </button>
        </footer>
      </section>
    </div>
  );
}
