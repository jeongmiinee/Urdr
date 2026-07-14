# World Archive 기후–지형 아틀라스 연구 데이터

v0.99v의 실행 파일에는 실제 지구 좌표나 원본 래스터를 넣지 않고, 31개 쾨펜 기후대별 지형 사전확률만 압축해 포함합니다.

## 입력 표본 형식

`samples/*.jsonl`에 한 줄당 하나의 정규화 표본을 둡니다.

```json
{"climate":"Cfb","terrain":"forest","elevationM":240,"slopeDeg":4.2,"temperatureC":11.8,"precipitationMm":1260,"soilMoisture":0.61,"distanceToCoastKm":18,"distanceToRiverKm":2.4,"weight":1}
```

지원 지형: `mountain`, `forest`, `desert`, `snow`, `grassland`, `plain`, `farmland`, `jungle`, `wetland`, `rock`, `bedrock`

## 권장 원자료

- Köppen–Geiger
- CHELSA 또는 WorldClim
- ESA WorldCover
- Copernicus DEM
- SoilGrids
- HydroSHEDS
- GLWD

원자료의 라이선스와 인용 조건은 내려받는 사용자가 각각 확인해야 합니다. 원본 자료를 이 저장소에 재배포하지 않습니다.

## 집계

```bash
npm run terrain:atlas
```

표본이 있으면 쾨펜 기후별 가중 확률을 `research-data/generated-terrain-atlas.json`으로 출력합니다. 표본이 없으면 현재 런타임 아틀라스의 구조와 메타데이터를 검증한 스냅샷을 출력합니다.
