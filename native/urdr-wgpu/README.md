# URDR Native Engine

This crate is the active URDR 4.4 desktop application. It uses Rust, `eframe`,
WGPU, Winit, Rayon, and a single native process. The repository-root
[`README.md`](../../README.md) is the canonical project entry point.

## Run

```powershell
cargo run --release --locked
```

## Verify

```powershell
cargo fmt --all -- --check
cargo check --locked
cargo test --locked
cargo build --release --locked
```

The IMS-Toucan runtime and model weights are optional local distribution
assets. Set `URDR_REQUIRE_SPEECH_BUNDLE=1` only when validating a complete
portable speech package.

## Start Reading

1. [`../../AGENTS.md`](../../AGENTS.md) for the contributor and AI contract.
2. [`../../docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) for ownership and modules.
3. [`../../docs/MAP_PIPELINE.md`](../../docs/MAP_PIPELINE.md) before changing map generation.
4. [`../../docs/SAVE_FORMAT.md`](../../docs/SAVE_FORMAT.md) before changing persistence.
5. [`../../docs/DIAGNOSTICS.md`](../../docs/DIAGNOSTICS.md) for logs and reproducible evidence.

`app.rs` is still oversized. New domain logic should live in focused modules;
keep `app.rs` responsible for orchestration and UI state only when practical.
