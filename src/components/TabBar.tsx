import type { WorkspaceTab } from "../model/world";

type Props = {
  tabs: WorkspaceTab[];
  activeTabId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
};

const icons: Record<WorkspaceTab["type"], string> = {
  map: "▧",
  wiki: "▤",
  timeline: "◷",
  generator: "✦",
  simulation: "◉",
  home: "⌂",
  settings: "⚙",
};

export function TabBar({ tabs, activeTabId, onSelect, onClose }: Props) {
  return (
    <nav className="tab-bar">
      {tabs.map((tab) => (
        <div className={`workspace-tab ${tab.id === activeTabId ? "active" : ""}`} key={tab.id}>
          <button type="button" className="tab-main" onClick={() => onSelect(tab.id)}>
            <span>{icons[tab.type]}</span>{tab.title}
          </button>
          <button type="button" className="tab-close" onClick={() => onClose(tab.id)}>×</button>
        </div>
      ))}
    </nav>
  );
}
