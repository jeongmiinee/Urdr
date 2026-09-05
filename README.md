# URDR

URDR is a native desktop workspace for building fictional worlds. It combines a
Planet-to-Region map system, timelines and calendars, a structured wiki,
environment analysis, heraldry, constructed-language tools, dictionaries, and
optional RPG rules in one project file.

The active application is **URDR Engine 4.4**, implemented in Rust with
`eframe`/`egui` and WGPU. The Electron 2.5 source remains in this repository as
a UI and data-migration reference. Unity is no longer part of the runtime.

> The project metadata currently declares the source as proprietary. Reading
> this repository does not grant an open-source license. Review
> [Third-party and publication notes](docs/GITHUB_PUBLISHING.md) before making
> a public release.

## Current Status

- Native Windows desktop application with one process and one WGPU renderer.
- Planet-owned physical state with deterministic Region extraction.
- Sparse L1/L2 physical refinement instead of dense whole-map 100 m analysis.
- Continuous/subcell rivers backed by a stable river graph.
- Chunked 100 m Canonical Surface with render LODs and asynchronous tile jobs.
- Checksummed `URDR4` project archives with independent binary blobs.
- Korean and English UI, wiki templates, dictionaries, scripts, heraldry, and
  an optional IMS-Toucan IPA speech runtime.

The current physical pipeline preserves Planet/Region identity. Natural
hydrology is still marked `PARTIAL`: deep closed depressions are identified as
lacustrine connectors, but persistent endorheic lake storage remains future
work.

## Quick Start

Requirements:

- Windows 10 or later
- Rust stable toolchain with the MSVC target
- Visual Studio Build Tools with the C++ desktop workload

```powershell
cd native/urdr-wgpu
cargo run
```

Development builds resolve demo assets from the repository root. A packaged
build instead expects `Data/manifest.json`, `Graphics`, `Localization`, and
other runtime folders beside `URDR.exe`. `URDR_RESOURCE_ROOT` can override the
resource root while debugging.

## Verification

```powershell
cd native/urdr-wgpu
cargo fmt --all -- --check
cargo check --locked
cargo test --locked
cargo build --release --locked
```

Pass 8 diagnostic export is intentionally ignored during normal tests:

```powershell
cargo test pass_8_physical_export -- --ignored --nocapture
```

The latest verified baseline is 280 passing tests, 0 failures, and 7 explicit
diagnostic/export tests ignored.

## Repository Map

| Path | Role | Status |
|---|---|---|
| `native/urdr-wgpu` | Rust/WGPU application and authoritative engine | Active |
| `runtime-resources` | Portable resource staging, optional speech runtime | Packaging input |
| `public` | Development demos and shared source assets | Active |
| `scripts/package-engine-4.4.ps1` | Native portable packaging entry point | Active |
| `docs` | Architecture, pipelines, history, and contribution guides | Active |
| `src`, `desktop`, `package.json` | Electron 2.5 reference implementation | Reference only |
| `unity` | Abandoned Unity integration experiments | Historical only |
| `outputs`, `dist`, `diagnostics`, `tmp` | Generated artifacts | Never source |

The root contains historical changelogs and build reports from the long
prototype period. Start with the active Rust crate, not the historical files.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Planet, Region, map, terrain, and hydrology pipeline](docs/MAP_PIPELINE.md)
- [Project archive and persistent data](docs/SAVE_FORMAT.md)
- [Development history and major decisions](docs/DEVELOPMENT_HISTORY.md)
- [Diagnostics and performance workflow](docs/DIAGNOSTICS.md)
- [Contributing](CONTRIBUTING.md)
- [AI contributor handoff](AGENTS.md)
- [Publishing this source on GitHub](docs/GITHUB_PUBLISHING.md)

## Design Invariants

1. A Region adds detail to a Planet; it does not generate a second world.
2. Physical refinement is independent of map ID, creation order, camera, and
   render LOD.
3. The Canonical Surface is authoritative at its physical cell scale; macro
   analysis and display textures are derived representations.
4. Major river basin and outlet identity remains deterministic. Fine geometry
   may change only within the allowed local topology policy.
5. Terrain edits, render caches, diagnostics, and compatibility views must not
   silently overwrite authoritative Planet data.
6. New maps are append-only records and never replace an existing map merely
   because a preview or selection was reused.

## License

URDR source is currently marked `Proprietary` in `Cargo.toml`. Third-party
components retain their own licenses; see `THIRD_PARTY_NOTICES_ENGINE_4.4.md`
and the notices distributed with runtime resources.
