# URDR Shared Schema Change Log

이 문서는 두 개발 track 사이의 shared persistent model / runtime contract
변경을 기록한다.

현재 병렬개발 문서 생성 자체는 schema 변경이 아니므로 change entry를 만들지 않는다.
아래는 향후 실제 변경에 사용할 template이며, 변경 기록이 아니다.

## Rules

- final global schema version은 integration에서 결정한다.
- 다른 track의 field를 삭제하지 않는다.
- 다른 track의 field를 rename하지 않는다.
- 다른 track의 field 의미를 임의로 바꾸지 않는다.
- new persisted field에는 `serde(default)` 또는 explicit migration이 필요하다.
- 기존 사용자 데이터를 보존한다.
- runtime compatibility view를 duplicate persisted authority로 만들지 않는다.

Compatibility-sensitive structures include:

- `LoadedWorld`
- `PlanetState`
- `NativeMap`
- `RiverGraph`
- `URDR4` archive data

## Entry Template

### [Procedural / Non-Procedural]

Track:

File:

Struct / Contract:

Change:

Reason:

Persistence impact:

- yes / no

Migration required:

- yes / no

Compatibility impact:

Integration note:

Related commit:

Status:

- proposed
- implemented
- integrated
