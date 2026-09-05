# Contributing to URDR

Thank you for helping with URDR. The project is in active architectural
development, so correctness and deterministic world identity take precedence
over feature count.

## Before You Start

Read the architecture and the pipeline document that owns your change. For map
work, include the physical data path in your issue or pull request. For document
or UI work, identify the schema and persistence fields affected.

The active application is the Rust crate under `native/urdr-wgpu`. Electron 2.5
is retained to compare UI behavior and migrate older data. Unity experiments are
historical and must not become a runtime dependency.

## Development Setup

```powershell
cd native/urdr-wgpu
cargo run
```

The debug build uses demo resources under `public`. To test a packaged resource
tree, set `URDR_RESOURCE_ROOT` to the expanded portable directory.

## Pull Request Scope

- Keep one behavior change per pull request when practical.
- Do not combine generated artifact churn with source changes.
- Avoid unrelated formatting or large moves.
- Preserve old save compatibility unless the pull request contains a reviewed
  migration and fixture.
- State whether the change affects Planet authority, Region refinement,
  Canonical Surface data, RiverGraph topology, display caches, or UI only.

## Code Style

- Run `cargo fmt` and follow existing Rust naming and ownership patterns.
- Prefer deterministic ordered collections when iteration order affects output.
- Keep rich per-cell objects out of high-resolution physical fields; use bounded
  SoA buffers, chunks, and sparse patch registries.
- Keep expensive computation off the UI thread.
- Treat IDs and revisions as data contracts, not incidental strings.
- Add comments only where an invariant or non-obvious numerical choice needs an
  explanation.

## Tests

Required before review:

```powershell
cd native/urdr-wgpu
cargo fmt --all -- --check
cargo check --locked
cargo test --locked
```

Run `cargo build --release --locked` for changes to packaging, resources,
threading, WGPU, startup, shutdown, or performance-sensitive code.

Map algorithm changes also need deterministic before/after diagnostics. Record
the seed, map ID, extent, physical cell size, macro dimensions, revisions,
camera/zoom where applicable, and actual timings.

## Pull Request Description

Include:

1. Problem and visible symptom.
2. Root cause and authoritative data source.
3. Implementation summary.
4. Compatibility and migration impact.
5. Test commands and results.
6. Screenshots/diagnostics for visual or physical changes.
7. Remaining limitations.

## Licensing and Large Assets

URDR is currently marked proprietary. Do not assume that source availability
grants redistribution rights. Contributions must contain code and assets you
are allowed to submit. Do not commit speech models, embedded Python runtimes,
generated demos from restricted sources, or third-party assets without their
license and provenance.

See `docs/GITHUB_PUBLISHING.md` before publishing or cloning release resources.
