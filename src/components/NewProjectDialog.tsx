import { useState } from "react";

type Props = {
  onCancel: () => void;
  onCreate: (projectTitle: string) => void;
};

export function NewProjectDialog({ onCancel, onCreate }: Props) {
  const [projectTitle, setProjectTitle] = useState("새로운 세계");
  return (
    <div className="modal-backdrop">
      <section className="modal-card new-project-dialog">
        <header>
          <div>
            <p className="eyebrow">NEW PROJECT</p>
            <h2>새 세계 만들기</h2>
          </div>
          <button type="button" className="icon-button" onClick={onCancel}>
            ×
          </button>
        </header>
        <label>
          프로젝트 이름
          <input
            value={projectTitle}
            onChange={(event) => setProjectTitle(event.target.value)}
            autoFocus
          />
        </label>
        <p className="dialog-hint">
          프로젝트는 자유·현실 모드를 구분하지 않습니다. 프로젝트를 만든 뒤 ‘새
          지도’에서 지도마다 생성 엔진과 규모를 선택합니다.
        </p>
        <footer>
          <button type="button" className="secondary-button" onClick={onCancel}>
            취소
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={!projectTitle.trim()}
            onClick={() => onCreate(projectTitle.trim())}
          >
            프로젝트 만들기
          </button>
        </footer>
      </section>
    </div>
  );
}
