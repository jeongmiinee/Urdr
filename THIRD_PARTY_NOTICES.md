# Third-Party Notices — World Archive v0.99j

이 배포본은 상업적 이용이 허용되는 다음 오픈소스 패키지를 사용합니다. 전체 라이선스 문구는 애플리케이션의 `설정 > 오픈소스 라이선스`에서 확인할 수 있습니다.

## Runtime dependencies

- React 19.2.7 — MIT License — Copyright Meta Platforms, Inc. and affiliates.
- React DOM 19.2.7 — MIT License — Copyright Meta Platforms, Inc. and affiliates.
- PixiJS 8.19.0 — MIT License — Copyright Mathew Groves, Chad Engler and contributors.
- D3 Delaunay 6.0.4 — ISC License — Copyright Observable, Inc. and Mapbox.

## Optional desktop shell

- Electron 43.1.0 — MIT License — Copyright Electron contributors and GitHub Inc.

Electron은 `npm run desktop` 또는 `npm run desktop:dev`에서 사용하는 선택형 데스크톱 셸입니다. 소스 ZIP에는 Electron 바이너리와 `node_modules`를 포함하지 않으며 설치 시 패키지 관리자가 내려받습니다.

## Build dependencies

- Vite 8.1.4 — MIT License — Copyright VoidZero Inc. and Vite contributors.
- @vitejs/plugin-react 6.0.3 — MIT License — Copyright Vite contributors.
- TypeScript 7.0.2 — Apache License 2.0 — Copyright Microsoft Corporation.

## 독자 구현된 기능

다음 기능은 이 프로젝트를 위해 작성한 자체 구현입니다.

- 대륙 핵·거리장·도메인 워핑·Random Walk 보조 생성
- 연속형 고도장과 해안선 후처리
- 유역·유량·하천 차수 계산과 강의 해상 횡단 방지
- 기온·강수·습도·일조·일사량 경량 환경 계산
- 농축산 적합도 기본 계산
- 자연경계 기반 국가 영토 및 영토 윤곽 도구

Grid Sage Games, Noveltech, 네이버 블로그 게시물의 코드·문장·이미지는 포함하지 않았습니다. WindNinja, WRF, ICON, pvlib과 실제 기후·농축산 원천 데이터도 이 배포본에 포함하지 않았습니다.

상업 배포 전에는 고정한 패키지 버전과 모든 하위 의존성, 에셋, 외부 데이터의 라이선스를 다시 감사해야 합니다.

## Red Blob Games Mapgen4
- Project: Red Blob Games Mapgen4
- Copyright: 2018, 2025 Red Blob Games <redblobgames@gmail.com>
- License: Apache License 2.0
- Included files: `vendor/mapgen4`, production bundles under `public/mapgen4`
- The Mapgen4 engine runs independently in World Archive free mode.
