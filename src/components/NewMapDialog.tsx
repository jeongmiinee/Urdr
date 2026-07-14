import { useMemo, useState } from "react";
import {
  MAP_SCALE_RANGES,
  clampMapPhysicalWidth,
  type MapScaleMode,
  type SimulationMode,
} from "../model/world";

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

const SCALE_DESCRIPTIONS: Record<MapScaleMode, string> = {
  local: "도시권·군·소규모 지방의 세부 지형과 장소를 표현합니다.",
  regional: "여러 지방과 광역권을 함께 다루는 중간 규모 지도입니다.",
  continent: "단일 또는 소수 대륙과 대양을 생성하는 지도입니다.",
  world: "여러 대륙과 대양을 하나의 세계 규모로 생성합니다.",
};

export function NewMapDialog({ suggestedName, onCancel, onCreate }: Props) {
  const [title, setTitle] = useState(suggestedName);
  const [generationMode, setGenerationMode] =
    useState<SimulationMode>("realistic");
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
            <p className="eyebrow">NEW MAP</p>
            <h2>새 지도 만들기</h2>
          </div>
          <button type="button" className="icon-button" onClick={onCancel}>
            ×
          </button>
        </header>
        <label>
          지도 이름
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            autoFocus
          />
        </label>
        <fieldset className="simulation-mode-picker">
          <legend>생성 엔진</legend>
          <label className={generationMode === "free" ? "active" : ""}>
            <input
              type="radio"
              checked={generationMode === "free"}
              onChange={() => setGenerationMode("free")}
            />
            <strong>자유 모드 · Mapgen4</strong>
            <span>
              지질학 시뮬레이션 없이 산·계곡·바다를 직접 칠하고 강우와 하천을
              즉시 계산합니다.
            </span>
          </label>
          <label className={generationMode === "realistic" ? "active" : ""}>
            <input
              type="radio"
              checked={generationMode === "realistic"}
              onChange={() => setGenerationMode("realistic")}
            />
            <strong>현실 모드</strong>
            <span>
              기존 판 활동·침식·기후·수계 알고리즘으로 지형을 생성합니다.
            </span>
          </label>
        </fieldset>
        <fieldset className="map-scale-picker">
          <legend>지도 규모</legend>
          {(Object.keys(MAP_SCALE_RANGES) as MapScaleMode[]).map((mode) => {
            const item = MAP_SCALE_RANGES[mode];
            return (
              <label key={mode} className={scaleMode === mode ? "active" : ""}>
                <input
                  type="radio"
                  checked={scaleMode === mode}
                  onChange={() => changeScaleMode(mode)}
                />
                <strong>{item.label}</strong>
                <span>
                  {item.min.toLocaleString()}–{item.max.toLocaleString()}km ·{" "}
                  {SCALE_DESCRIPTIONS[mode]}
                </span>
              </label>
            );
          })}
        </fieldset>
        <label>
          실제 지도 가로 폭
          <div className="map-width-input">
            <input
              type="number"
              min={range.min}
              max={range.max}
              step={
                scaleMode === "local" ? 1 : scaleMode === "regional" ? 10 : 100
              }
              value={physicalWidthKm}
              onChange={(event) =>
                setPhysicalWidthKm(Number(event.target.value))
              }
            />
            <span>km</span>
          </div>
          <small>
            {range.label} 허용 범위: {range.min.toLocaleString()}–
            {range.max.toLocaleString()}km
          </small>
        </label>
        <footer>
          <button type="button" className="secondary-button" onClick={onCancel}>
            취소
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={!title.trim()}
            onClick={() =>
              onCreate(
                title.trim(),
                generationMode,
                scaleMode,
                clampMapPhysicalWidth(scaleMode, physicalWidthKm),
              )
            }
          >
            지도 만들기
          </button>
        </footer>
      </section>
    </div>
  );
}
