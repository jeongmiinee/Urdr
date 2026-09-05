# URDR Architecture

## System Boundary

URDR Engine 4.4 is a single native Windows process. `winit` owns the event loop,
`eframe`/`egui` owns application UI, and WGPU renders the map and supporting
visuals. Background workers build Region previews, Canonical Surface tiles,
render LODs, and hydrology results. Completed work is accepted only when its
source IDs and revisions still match the active world.

```text
Windows process
  winit event loop
    eframe/egui application state
      LoadedWorld
      UI workspaces and editors
      render/generation job queues
    WGPU renderer
      bounded tile cache
      overview cache
      shoreline/contour/river meshes
```

Unity is not embedded and no companion map process exists. Electron 2.5 is a
historical UI/data reference only.

## Domain Ownership

```text
LoadedWorld
  PlanetState
    PlanetGenerationConfig
    causal geology
    global PlanetSurface
    PlanetDetailStore
  RegionDefinition[]
  DetailedRegion[]
  MapViewDefinition[]
  NativeMap + maps[]
    macro physical fields
    CanonicalSurface
    RiverGraph
    human geography and timeline states
  wiki/articles/categories
  heraldry/dictionaries/scripts/RPG rules
```

`LoadedWorld` is the root persisted model. `PlanetState` owns global physical
identity. A `RegionDefinition` describes a selected spherical footprint and its
generation settings. A `DetailedRegion` records shared detail patch provenance.
A `MapViewDefinition` projects that Region into a user-facing map. `NativeMap`
contains the map-level macro fields, Canonical Surface recipe/edits, rivers, and
human geography.

## Authoritative vs Derived Data

| Data | Authority | Persisted | Notes |
|---|---|---:|---|
| Planet physical definition and surface | `PlanetState` | Yes | Global source of world identity |
| Region selection and provenance | `RegionDefinition` | Yes | References Planet coordinates |
| Shared detail patch references | `DetailedRegion` / Planet detail store | Yes | Reused by overlap |
| Map macro arrays | `NativeMap` | Yes | Analysis representation |
| Canonical physical chunks/recipe | `CanonicalSurface` | Yes | Chunked 100 m source and edits |
| River topology and attributes | `RiverGraph` | Yes | Stable nodes/reaches/IDs |
| `NativeMap.rivers` compatibility list | Derived | No | Rebuilt from `RiverGraph` |
| Render textures and meshes | Derived | No | Revision-keyed bounded cache |
| Pass 8 L1/L2 physical patches | Derived | No | Deterministic sparse cache |
| Diagnostic PNG/CSV/PDF | Derived | No | Test artifacts only |

Do not promote a convenience cache or UI representation into a second source
of truth.

## Module Guide

| Module | Responsibility |
|---|---|
| `main.rs` | Process startup, single-instance guard, event loop, shutdown |
| `app.rs` | Workspace/editor orchestration and most current UI |
| `model.rs` | Root world/map models and Canonical Surface storage |
| `spatial.rs` | Planet state, spherical positions, Regions, detail store, map views |
| `planet_config.rs` | Validated Planet generation inputs and derived values |
| `geology.rs`, `procedural.rs` | Causal geology and deterministic physical fields |
| `regional_refinement.rs` | Region preflight, shared Planet detail, provenance |
| `generator.rs` | Region analysis, terrain/climate/hydrology generation pipeline |
| `multiresolution_physics.rs` | Pass 8 sparse L1/L2 physical analysis and local conditioning |
| `river_graph.rs` | Stable hydrology topology and reach attributes |
| `subcell_hydrology.rs` | Pass 7 continuous centreline geometry and diagnostics |
| `surface_refinement.rs` | Continuous coast/terrain display refinement |
| `shoreline.rs`, `contour.rs` | Marching Squares geometry from authoritative samples |
| `terrain_renderer.rs` | Asynchronous terrain tile and overview generation |
| `map_render_cache.rs`, `render.rs` | Mesh/texture keys, render LOD, overlay caches |
| `map_camera.rs`, `map_projection.rs`, `projection.rs` | View transform and projection math |
| `environment.rs` | Point, map, and Planet environment analysis |
| `storage_v4.rs` | Checksummed compressed `URDR4` archive container |
| `document_schema.rs`, `u_fields.rs`, `wiki.rs` | Wiki schemas, U-fields, links |
| `dictionary.rs`, `ipa.rs`, `speech.rs` | Dictionary, IPA composition, optional TTS |
| `linguistics.rs`, `scripts.rs` | Language structures and writing systems |
| `heraldry.rs` | Flag/emblem geometry and layer data |
| `diagnostics.rs`, `map_debug.rs`, `terrain_diagnostics.rs` | Logs and visual diagnostics |
| `pipeline_diagnostics.rs`, `pass7_diagnostics.rs`, `pass8_diagnostics.rs` | Deterministic algorithm reports |
| `resources.rs` | Development/portable resource resolution |
| `theme.rs` | Shared typography, color, and UI metrics |

`app.rs` remains a large legacy concentration point. New non-UI logic should go
to its owning module and expose a narrow API to `app.rs`.

## Concurrency and Revision Rules

- UI state is owned by the event-loop thread.
- Heavy generation and tile work runs in bounded background jobs.
- Job inputs are immutable snapshots or shared immutable buffers.
- Results carry source IDs/revisions and are rejected when stale.
- Tiny wheel deltas reuse quantized render LOD buckets.
- Zoom never launches physical generation or Region refinement.
- Shutdown sends cancellation, detaches pending receivers, flushes logs, and
  exits the single process.

## UI Architecture

The top navigation selects major workspaces: Project Home, Map, Worldbuilding,
Environment, RPG rules, Heraldry, Script generator, and Dictionary. Only the
worldbuilding wiki uses document tabs. Other workspaces consume the full center
area. The map uses one integrated canvas with floating mode/tools, pointer
information, layers/map information, scale, and the shared timeline.

Reusable UI behavior should be extracted from `app.rs` when it has a stable
domain boundary. Visual parity should use the Electron 2.5 screenshots and
behavior as reference, but data flow must follow the native architecture.

## Compatibility Strategy

- Native save markers are versioned (`urdr-native-*`).
- New persisted fields use defaults or explicit migration.
- Historical map recipes retain their recorded semantics.
- New maps use current recipe revisions.
- Stable IDs, not localized labels or titles, connect records.
- Active map data is serialized once; compatibility fields are reconstructed.

## Known Architectural Debt

- `app.rs` should be split by workspace and editor over time.
- Climate-conditioned geomorphology is not yet part of terrain formation.
- Persistent endorheic lakes and closed-basin water budgets are not complete.
- Pass 8 physical patches are deterministic derived caches, not a persisted
  Planet-owned multiresolution field yet.
- Some historical root files remain until the source publication is curated.
