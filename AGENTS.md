# AGENTS.md

This file is the handoff contract for AI coding agents working on URDR.

## Read First

Before editing code, read:

1. `README.md`
2. `docs/ARCHITECTURE.md`
3. `docs/MAP_PIPELINE.md` for map, Planet, Region, terrain, or hydrology work
4. `docs/SAVE_FORMAT.md` for persistence or migration work
5. `docs/DIAGNOSTICS.md` for performance or visual artifact work

The active engine is `native/urdr-wgpu`. The root Electron 2.5 project is a
reference implementation, not the production runtime. Do not revive Unity or
split the renderer into a second process.

## Product Workflow

- Improvement requests are accumulated until the project owner explicitly asks
  for a new version or implementation pass.
- When implementation is authorized, complete one requested item before moving
  to the next item unless the owner explicitly changes the order.
- Preserve user-authored project data and unrelated working-tree changes.
- Do not silently rewrite demo data, project archives, or compatibility fields.

## Core Invariants

- Same Planet position means the same parent physical world in every Region.
- Region refinement adds bounded detail; it never rerolls the Planet.
- Physical refinement keys exclude Region ID, map ID, creation order, camera,
  zoom, and render LOD.
- Major basin/outlet identity is deterministic and stable.
- Render LOD never changes physical data.
- A new map is append-only and must not overwrite an existing map record.
- Ocean expansion uses connectivity to existing ocean water. An isolated cell
  below sea level remains land until connected to the ocean.
- Roads, territories, places, events, and labels are human geography. They are
  not terrain and must not replace or recolor authoritative surface data.
- The active runtime remains one native process. Shutdown must cancel pending
  work and leave no residual process.

## Change Procedure

1. Locate the authoritative source and every derived consumer.
2. State whether the change affects persisted data, physical caches, render
   caches, diagnostics, or compatibility views.
3. Add the smallest regression test that would fail before the change.
4. Implement within the owning module. Avoid expanding `app.rs` unless the code
   is genuinely UI orchestration.
5. Run focused tests, then the complete required verification set.
6. For map changes, export deterministic diagnostic layers before judging the
   result by eye.
7. Update the relevant document and changelog when an invariant, file format,
   algorithm, or public workflow changes.

## Required Verification

From `native/urdr-wgpu`:

```powershell
cargo fmt --all -- --check
cargo check --locked
cargo test --locked
cargo build --release --locked
```

Use ignored diagnostic exporters only when their artifacts are required. Never
enable every ignored performance/export test in normal CI.

## Map and Hydrology Guardrails

- Do not solve performance problems by lowering authoritative resolution,
  increasing correction thresholds, hiding artifacts with blur, or coupling
  physical LOD to screen zoom.
- Do not materialize the entire 100 m Canonical Surface for a large Region.
- Do not force rivers to map edges. A map edge is not an ocean shoreline.
- Do not draw deep closed-depression links as uphill rivers. Preserve them as
  lake/endorheic candidates until persistent water-body support exists.
- Do not add visual polyline wobble to fake natural rivers. Geometry must derive
  from the shared physical field.
- Keep Pass 6 Planet/Region consistency, Pass 7 subcell geometry, and Pass 8
  sparse physical refinement regression tests enabled.

## Persistence Guardrails

- `LoadedWorld`, `PlanetState`, `NativeMap`, `RiverGraph`, and `URDR4` archive
  data are compatibility-sensitive.
- New fields require `serde(default)` or an explicit migration.
- Runtime compatibility views must not become duplicate persisted authority.
- Stable IDs survive renames. UI labels are never identity keys.
- Archive blob names must remain normalized and path-safe.

## Generated and External Data

- Never commit `target`, `outputs`, `dist`, `tmp`, logs, diagnostic exports, or
  packaged binaries.
- IMS-Toucan models and the embedded Python runtime are optional release assets,
  not ordinary Git source. Follow `docs/GITHUB_PUBLISHING.md`.
- Preserve all third-party notices when packaging or replacing external assets.

## Reporting

At the end of a task report:

- changed modules and behavior;
- tests and build commands actually run;
- generated artifacts and their paths;
- known limitations or invariants still marked `PARTIAL`;
- any migration, license, or optional-resource impact.
