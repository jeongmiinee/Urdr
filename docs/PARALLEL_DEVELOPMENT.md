# URDR 4.4 Parallel Development

## Purpose

URDR 4.4를 하나의 공통 기준점에서 Procedural Track과 Non-Procedural Track으로
분리해 병렬 개발한다. 활성 엔진은 `native/urdr-wgpu`이며,
저장소 루트의 `AGENTS.md` 규칙을 따른다.

핵심 원칙은 같은 파일을 피하는 것보다 같은 데이터와 시스템의 권위를 서로
다르게 정의하지 않는 것이다.

두 feature branch는 서로 직접 merge하지 않는다. 최종 통합은 별도의
`integration/v4.5`에서 수행한다.

## Base

| 항목 | 값 |
|---|---|
| Source branch | `v4.4` |
| Source commit before governance setup | `15570aa3bcfb257bdfc10a719fed0691fa1f73b5` |
| Procedural branch | `feature/procedural` |
| Non-Procedural branch | `feature/nonprocedural` |

두 feature branch는 이 문서와 `SHARED_SCHEMA_CHANGES.md`가 포함된 동일한
governance commit에서 분기한다. 정확한 branch point SHA는 Git history를
권위로 한다. 문서에 자기 자신의 commit SHA를 넣기 위해 추가 commit을 만들지 않는다.

## Procedural Track

담당:

- Planet
- Region
- DetailedRegion
- Map
- terrain generation
- elevation
- geology
- climate physical calculation
- hydrology
- river routing
- shoreline physical generation
- surface refinement
- regional refinement
- CanonicalSurface
- map projection
- procedural terrain rendering
- procedural diagnostics

대표 소유 영역 (`native/urdr-wgpu/src` 기준):

- `generator.rs`
- `procedural.rs`
- `geology.rs`
- `planet_config.rs`
- `regional_refinement.rs`
- `surface_refinement.rs`
- `multiresolution_physics.rs`
- `subcell_hydrology.rs`
- `river_graph.rs`
- `shoreline.rs`
- `contour.rs`
- `terrain_renderer.rs`
- `map_camera.rs`
- `map_debug.rs`
- `map_projection.rs`
- `map_render_cache.rs`
- `map_runtime.rs`
- `projection.rs`
- `terrain_diagnostics.rs`
- `pipeline_diagnostics.rs`
- `pass7_diagnostics.rs`
- `pass8_diagnostics.rs`

현재 첫 Procedural 작업은 Planet-scale natural landmass generation diagnostics
and improvement다. 실제 landmass generator 의미를 바꾸기 전에 diagnostic과
ablation을 먼저 수행한다. 이 governance 설정 자체는 해당 구현을 시작하지 않는다.

## Non-Procedural Track

담당:

- Home
- general Settings
- Explorer
- Wiki / Documents
- Categories
- Person
- Family
- Genealogy
- Country / Faction / Organization
- Event / Accident / War / Battle
- Place metadata / article
- Timeline / Calendar UI
- Heraldry / Flags / Emblems
- Linguistics
- Language hierarchy
- Writing System
- Glyph Editor
- Character Charts
- Dictionary
- Sentences
- Conversations
- IPA
- Speech UI
- RPG
- Items / Materials / Resources
- Disease / Nature records
- general UI consistency
- responsive layout
- alignment
- overflow / clipping
- document references

대표 소유 영역 (`native/urdr-wgpu/src` 기준):

- `dictionary.rs`
- `linguistics.rs`
- `scripts.rs`
- `ipa.rs`
- `speech.rs`
- `heraldry.rs`
- `wiki.rs`
- `document_schema.rs`
- `u_fields.rs`
- `reference_data.rs`
- `theme.rs`

`theme.rs`의 변경에는 아래 Shared Integration Surface 규칙도 적용한다.

## Shared Integration Surface

다음은 공용 구조다. Rust 파일과 Cargo 파일은 활성 native crate를 기준으로 한다.

- `app.rs`
- `model.rs`
- `storage_v4.rs`
- `theme.rs`
- `main.rs`
- `Cargo.toml`
- `Cargo.lock`
- README / architecture documents

공용 파일 규칙:

- 필요한 최소 범위만 수정한다.
- unrelated cleanup을 하지 않는다.
- mass rename을 하지 않는다.
- 대규모 함수 순서 재배치를 하지 않는다.
- whitespace-only massive diff를 만들지 않는다.
- 병렬개발 중 `app.rs`를 대규모로 분해하지 않는다.
- 상대 track의 field를 삭제하지 않는다.
- 상대 track의 field를 rename하지 않는다.
- 상대 track의 field 의미를 재해석하지 않는다.
- conflict를 ours/theirs 전체 선택으로 해결하지 않는다.
- semantic reconciliation을 우선한다.

## Boundary Areas

### Environment

Procedural:

- climate/weather calculation
- physical value calculation
- authoritative environment data

Non-Procedural:

- display
- formatting
- Point Weather / Point Climate UI

### Place

Procedural:

- spatial position
- terrain context
- generated physical environment reference

Non-Procedural:

- article
- population
- economy
- chronology
- ownership
- organization relations
- document UI

### Calendar / Time

Procedural:

- physical calculation에 필요한 absolute time conversion

Non-Procedural:

- date/timeline UI
- life dates
- event dates
- ownership-period presentation

## Persistence and Schema

두 track은 독립적으로 최종 global schema version을 확정하지 않는다.
persistent shared contract 변경은 저장소 루트의 `SHARED_SCHEMA_CHANGES.md`에
기록한다.

- 기존 사용자 데이터를 보존한다.
- 새 field는 가능한 backward-compatible default를 가진다.
- 필요 시 `serde(default)` 또는 explicit migration을 사용한다.
- 상대 track의 field와 metadata를 보존한다.
- 기존 자유서술 데이터를 자동 해석하여 소실시키지 않는다.

## Commit Policy

commit은 기능 단위로 작게 유지한다.

예:

```text
planet: add landmass diagnostics
planet: add landmass recipe revision
hydrology: add closed-basin regression
```

unrelated UI/schema/refactor/cleanup을 한 commit에 섞지 않는다.

## Dry Merge

약 30%, 60%, 90% 진행 시점에 임시 integration branch에서 다음을 확인한다.

- text conflict
- schema conflict
- API mismatch
- Cargo dependency mismatch
- save/load incompatibility
- semantic authority conflict

## Integration

`feature/procedural`과 `feature/nonprocedural`은 서로 직접 merge하지 않는다.
최종적으로 `integration/v4.5`에서 병합한다.

대략적인 순서:

```text
merge procedural
  → shared model/storage reconciliation
  → merge nonprocedural
  → UI/document reconciliation
  → full regression
  → release candidate
```

공용 파일의 충돌은 양쪽 데이터와 시스템의 의미를 보존하는 방식으로 해결한다.

## Required Verification

`native/urdr-wgpu`에서 각 branch의 최소 검증을 수행한다.

```powershell
cargo fmt --all -- --check
cargo check --locked
cargo test --locked
cargo build --release --locked
```

## Core Rule

텍스트 conflict보다 authority, persistence semantics, field meaning,
migration semantics가 충돌하는 것이 더 위험하다.
