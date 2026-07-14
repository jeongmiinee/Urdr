import { TERRAIN_TYPES, type EditorTool, type Faction, type MapEditorMode, type TerrainType } from "../model/world";

const tools: Array<{ id: EditorTool; label: string; key: string; symbol: string }> = [
  { id: "select", label: "선택", key: "V", symbol: "⌖" },
  { id: "terrain", label: "지형", key: "T", symbol: "▦" },
  { id: "elevation", label: "고도", key: "C", symbol: "≋" },
  { id: "territory", label: "영토", key: "G", symbol: "◇" },
  { id: "location", label: "장소", key: "P", symbol: "●" },
  { id: "label", label: "지명", key: "L", symbol: "Aa" },
  { id: "road", label: "길", key: "R", symbol: "╱" },
  { id: "river", label: "강", key: "W", symbol: "〰" },
  { id: "event", label: "사건", key: "E", symbol: "★" },
];

const terrainLabels: Record<TerrainType, string> = {
  mountain: "산악", forest: "숲", desert: "사막", snow: "설원",
  grassland: "초원", plain: "평원", farmland: "농경지", jungle: "열대림",
  wetland: "습지", rock: "암석", bedrock: "암반",
};

type Props = {
  editorMode: Exclude<MapEditorMode, "view">;
  activeTool: EditorTool;
  onChange: (tool: EditorTool) => void;
  selectedTerrain: TerrainType;
  onTerrainChange: (terrain: TerrainType) => void;
  brushRadius: number;
  onBrushRadiusChange: (radius: number) => void;
  elevationDelta: number;
  onElevationDeltaChange: (delta: number) => void;
  seaLevel: number;
  onSeaLevelChange: (level: number) => void;
  factions: Faction[];
  territoryFactionId: string;
  onTerritoryFactionChange: (id: string) => void;
  drawingCount: number;
  curveMode: boolean;
  onCurveModeChange: (enabled: boolean) => void;
  onFinishDrawing: () => void;
  onCancelDrawing: () => void;
};

export function Toolbar({ editorMode, activeTool, onChange, selectedTerrain, onTerrainChange, brushRadius, onBrushRadiusChange, elevationDelta, onElevationDeltaChange, seaLevel, onSeaLevelChange, factions, territoryFactionId, onTerritoryFactionChange, drawingCount, curveMode, onCurveModeChange, onFinishDrawing, onCancelDrawing }: Props) {
  const availableTools = editorMode === "civilization"
    ? tools.filter((tool) => ["select", "territory", "location", "label", "road", "event"].includes(tool.id))
    : tools.filter((tool) => ["select", "terrain", "elevation", "river"].includes(tool.id));
  const drawingTool = activeTool === "road" || activeTool === "river" || activeTool === "label";
  const brushTool = activeTool === "terrain" || activeTool === "elevation" || activeTool === "territory";
  const radiusInput = <label>붓 반경<input type="range" min={1} max={20} value={brushRadius} onChange={(event) => onBrushRadiusChange(Number(event.target.value))} /><output>{brushRadius}</output></label>;
  return (
    <aside className="map-toolbar">
      <h2>편집 도구</h2>
      <div className="tool-list">
        {availableTools.map((tool) => (
          <button type="button" className={`tool-button ${activeTool === tool.id ? "active" : ""}`} key={tool.id} onClick={() => onChange(tool.id)}>
            <span className="tool-symbol">{tool.symbol}</span><span>{tool.label}</span><kbd>{tool.key}</kbd>
          </button>
        ))}
      </div>
      {activeTool === "terrain" && <div className="tool-options"><label>칠할 지형<select value={selectedTerrain} onChange={(event) => onTerrainChange(event.target.value as TerrainType)}>{TERRAIN_TYPES.map((type) => <option key={type} value={type}>{terrainLabels[type]}</option>)}</select></label>{radiusInput}</div>}
      {activeTool === "elevation" && <div className="tool-options">{radiusInput}<label>고도 변화<input type="range" min={-1200} max={1200} step={100} value={elevationDelta} onChange={(event) => onElevationDeltaChange(Number(event.target.value))} /><output>{elevationDelta > 0 ? `+${elevationDelta}` : elevationDelta}m</output></label><label>해수면<input type="range" min={-1500} max={1500} step={50} value={seaLevel} onChange={(event) => onSeaLevelChange(Number(event.target.value))} /><output>{seaLevel}m</output></label></div>}
      {activeTool === "territory" && <div className="tool-options"><label>소유 국가·세력<select value={territoryFactionId} onChange={(event) => onTerritoryFactionChange(event.target.value)}><option value="">소유 없음</option>{factions.map((faction) => <option key={faction.id} value={faction.id}>{faction.name}</option>)}</select></label>{radiusInput}<p className="tool-note">지도 위를 눌러 끌어 영토를 칠합니다. 비해양 세력은 해안선을 넘지 않습니다.</p></div>}
      {(activeTool === "road" || activeTool === "river" || activeTool === "label") && <div className="tool-options"><label className="checkbox-row"><input type="checkbox" checked={curveMode} onChange={(event) => onCurveModeChange(event.target.checked)} /> 곡선 모드</label><p className="tool-note">세 번째 제어점부터 앞선 두 점의 기울기를 이어 부드러운 곡선을 만듭니다.</p></div>}
      {drawingTool && <div className="drawing-tool-card"><strong>제어점 {drawingCount}개</strong><p>{activeTool === "label" ? "한 점이면 일반 지명, 두 점 이상이면 선을 따르는 지명이 됩니다." : "지도를 차례로 클릭해 선을 만드세요."}</p><div><button type="button" className="primary-button" disabled={drawingCount < (activeTool === "label" ? 1 : 2)} onClick={onFinishDrawing}>{activeTool === "label" ? "지명 확정" : "완료"}</button><button type="button" className="secondary-button" onClick={onCancelDrawing}>취소</button></div></div>}
      
      {brushTool && <div className="tool-help"><p>클릭 후 드래그: 붓 계속 사용</p><p>휠: 확대·축소</p></div>}
      {!brushTool && <div className="tool-help"><p>빈 공간 드래그: 지도 이동</p><p>휠: 확대·축소</p></div>}
      <div className="tool-help"><p>모든 편집은 현재 연도부터 기록됩니다.</p></div>
    </aside>
  );
}
