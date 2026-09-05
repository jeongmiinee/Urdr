import { useEffect, useRef, useState, type PointerEvent } from "react";
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
  rpgRules: "◇",
  settings: "⚙",
  heraldry: "◆",
};

export function TabBar({ tabs, activeTabId, onSelect, onClose }: Props) {
  const barRef = useRef<HTMLElement>(null);
  const dragRef = useRef({ pointerId: -1, startX: 0, startScrollLeft: 0, moved: false });
  const suppressClickRef = useRef(false);
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const update = () => {
      const next = bar.scrollWidth > bar.clientWidth + 1;
      setOverflowing(next);
      if (!next) {
        dragRef.current = { pointerId: -1, startX: 0, startScrollLeft: 0, moved: false };
        suppressClickRef.current = false;
        bar.classList.remove("dragging");
        bar.scrollLeft = 0;
      }
    };
    const observer = new ResizeObserver(update);
    observer.observe(bar);
    update();
    return () => observer.disconnect();
  }, [tabs]);

  const startDrag = (event: PointerEvent<HTMLElement>) => {
    if (!overflowing || event.button !== 0 || (event.target as Element).closest(".tab-close")) return;
    const bar = barRef.current;
    if (!bar) return;
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startScrollLeft: bar.scrollLeft, moved: false };
  };
  const moveDrag = (event: PointerEvent<HTMLElement>) => {
    const bar = barRef.current;
    const drag = dragRef.current;
    if (!bar || drag.pointerId !== event.pointerId) return;
    const distance = event.clientX - drag.startX;
    if (!drag.moved && Math.abs(distance) > 6) {
      drag.moved = true;
      bar.setPointerCapture(event.pointerId);
      bar.classList.add("dragging");
    }
    if (drag.moved) {
      event.preventDefault();
      bar.scrollLeft = drag.startScrollLeft - distance;
    }
  };
  const finishDrag = (event: PointerEvent<HTMLElement>) => {
    const bar = barRef.current;
    const drag = dragRef.current;
    if (!bar || drag.pointerId !== event.pointerId) return;
    suppressClickRef.current = drag.moved;
    if (drag.moved) window.setTimeout(() => { suppressClickRef.current = false; }, 0);
    dragRef.current.pointerId = -1;
    bar.classList.remove("dragging");
    if (bar.hasPointerCapture(event.pointerId)) bar.releasePointerCapture(event.pointerId);
  };
  const abandonPendingDrag = (event: PointerEvent<HTMLElement>) => {
    if (dragRef.current.pointerId === event.pointerId && !dragRef.current.moved)
      dragRef.current = { pointerId: -1, startX: 0, startScrollLeft: 0, moved: false };
  };

  return (
    <nav
      ref={barRef}
      className={`tab-bar ${overflowing ? "overflowing" : ""}`}
      onPointerDown={startDrag}
      onPointerMove={moveDrag}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
      onPointerLeave={abandonPendingDrag}
      onLostPointerCapture={finishDrag}
      onClickCapture={(event) => {
        if (!suppressClickRef.current) return;
        event.preventDefault();
        event.stopPropagation();
        suppressClickRef.current = false;
      }}
    >
      {tabs.map((tab) => (
        <div className={`workspace-tab tab-type-${tab.type} ${tab.id === activeTabId ? "active" : ""}`} key={tab.id}>
          <button type="button" className="tab-main" onClick={() => onSelect(tab.id)}>
            <span>{icons[tab.type]}</span><span data-user-authored={tab.type === "map" || tab.type === "wiki" ? "true" : undefined}>{tab.title}</span>
          </button>
          <button type="button" className="tab-close" aria-label={`${tab.title} 탭 닫기`} onClick={() => onClose(tab.id)}>×</button>
        </div>
      ))}
    </nav>
  );
}
