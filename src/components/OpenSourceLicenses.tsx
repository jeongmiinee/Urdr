import { OPEN_SOURCE_LICENSES } from "../licenses";

export function OpenSourceLicenses() {
  return (
    <section className="license-panel">
      <div className="window-heading compact">
        <h2>오픈소스 라이선스</h2>
        <p>이 프로그램에 직접 포함된 주요 오픈소스 패키지와 라이선스 원문입니다.</p>
      </div>
      <div className="license-list">
        {OPEN_SOURCE_LICENSES.map((entry) => (
          <details key={entry.packageName} className="license-entry">
            <summary>
              <span><strong>{entry.name}</strong><small>{entry.packageName}@{entry.version}</small></span>
              <b>{entry.license}</b>
            </summary>
            <pre>{entry.text}</pre>
          </details>
        ))}
      </div>
    </section>
  );
}
