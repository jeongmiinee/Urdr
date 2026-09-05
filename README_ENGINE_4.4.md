# URDR Engine 4.4

URDR Engine 4.4 is a native Rust/WGPU worldbuilding workspace for Windows. This release focuses on map-generation responsiveness, shutdown stability, and diagnostics that identify exactly where a load or generation session stopped.

## Run

Extract the entire portable ZIP into one folder and run `URDR.exe`. Keep `Data`, `Graphics`, `Localization`, and `Licenses` beside the executable. No command launcher is included.

Projects are stored under `%LOCALAPPDATA%\URDR\Projects`.

## Logs

Normal runs create two files under `Logs` beside `URDR.exe`:

- `urdr-session-*.log`: concise text suitable for direct inspection.
- `map-performance-*.jsonl`: one JSON object per stage for timing analysis and tooling.

If the portable folder is not writable, logs are placed in `%LOCALAPPDATA%\URDR\Logs`. The latest 12 files of each type are retained automatically.

For a generation problem, inspect the final `phase` in the JSONL file. The stages distinguish Region preflight, map generation, preview render-cache finalization, hydrology rebuild, project archive decode, canonical surface restoration, and spatial reconciliation.

## Performance Changes

- New maps without countries no longer scan the entire 100 m canonical surface to build an empty territory overlay.
- Canonical territory rendering has a fixed LOD work ceiling instead of scaling without limit to the physical map cell count.
- Unowned territory samples skip procedural terrain evaluation.
- Window close requests cancel generation before the UI can begin expensive result finalization.

The procedural terrain and climate equations were intentionally left unchanged so existing seeds retain their generation semantics.
