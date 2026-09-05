import { useEffect } from "react";
import { createPortal } from "react-dom";
import { UPDATE_HISTORY } from "../updateHistory";

export function UpdateHistoryDialog({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const previousPadding = document.body.style.paddingRight;
    const scrollbar = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.overflow = "hidden";
    if (scrollbar > 0) document.body.style.paddingRight = `${scrollbar}px`;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.body.style.paddingRight = previousPadding;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return createPortal(
    <div
      className="update-history-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="update-history-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="update-history-title"
      >
        <div className="load-project-heading">
          <button
            type="button"
            onClick={onClose}
            aria-label="업데이트 내역 닫기"
          >
            ×
          </button>
          <div>
            <h2 id="update-history-title">업데이트 내역</h2>
            <p>기능·편집·성능·호환성 변경을 버전별로 확인합니다.</p>
          </div>
        </div>
        <div className="update-history-list">
          {UPDATE_HISTORY.map((entry, index) => (
            <details key={entry.version} open={index === 0}>
              <summary>
                <strong>v{entry.version}</strong>
                <span>
                  {index === 0 ? "현재 버전" : `${entry.changes.length}개 변경`}
                </span>
              </summary>
              <ul>
                {entry.changes.map((change) => (
                  <li key={change}>{change}</li>
                ))}
              </ul>
            </details>
          ))}
        </div>
      </section>
    </div>,
    document.body,
  );
}
