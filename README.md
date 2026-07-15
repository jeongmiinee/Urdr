# World Archive v1.0

가상 세계 지도·연표·세계관 통합 편집기입니다.

## v1.0 핵심 변경

- 해안 2셀 완충구역의 숲·열대림 제외와 도시권 자연림 밀도 조정
- 드래그 완료 시점에만 전역 상태를 반영하는 저지연 타임라인
- 중복 정점·퇴화 링·잘못된 홀 분류를 차단하는 벡터 지형 스키마 4
- 라이트 모드 카테고리 문서 도구 및 4초 자동 닫힘 알림
- 래스터 환경 분석과 확대 가능한 벡터 지형 렌더링 분리

## VS Code 실행

```bash
npm install
npm run dev
```

프로덕션 빌드: `npm run build`

검사: `npm run typecheck`, `npm run smoke`, `npm run worker:smoke`
