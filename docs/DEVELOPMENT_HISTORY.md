# Development History and Decisions

This document summarizes the architectural path that produced the current
source. Individual historical changelogs remain in the repository for detail.

## Phase 1: Electron Worldbuilding Workspace

The first product line evolved through the 0.x, 1.x, and 2.x releases. It
established the product language and most user-facing workflows:

- map, worldbuilding wiki, and environment workspaces;
- timeline/calendar conversion and time-dependent world states;
- category-specific document schemas, TOC/body/information layout;
- genealogy, chronicles, population/economy records, U-input/date fields;
- RPG attributes/proficiencies/effects;
- heraldry, dictionary, IPA, and writing-system tools;
- Korean/English UI and separate demos.

Electron 2.5 is the reference baseline for layout and behavior. Performance and
map editing limits motivated the native engine.

## Phase 2: Native Rust/WGPU Reimplementation

Engine 0.1 through 3.x rebuilt the shell and tools with `egui` and WGPU while
preserving the Electron design. UI parity was implemented incrementally rather
than replacing the product with a new visual language.

Important decisions:

- one native process instead of a browser shell plus renderer process;
- WGPU for map rendering and bounded caches;
- direct native save/archive support;
- structured editor tools and shared timeline;
- single-instance startup and explicit shutdown cancellation.

## Abandoned Unity Integration

Unity was evaluated for map rendering and briefly used as an external map
runtime. Window synchronization, duplicate loading, resolution switching,
process lifetime, text quality, and crash behavior made the split architecture
unacceptable. The integration was removed. Current URDR must remain an
integrated Rust/WGPU process unless a future architecture review explicitly
reopens that decision.

## Engine 3.8: Planet Configuration and Streaming

- Versioned Planet generation configuration and deterministic stage sub-seeds.
- Causal geology controls and a permanent Planet workspace.
- Bounded multi-LOD terrain tile cache and incremental uploads.
- Single-copy active map persistence.

## Engine 3.9: Planet-First Creation

- New-world creation split into World then Planet stages.
- Authoritative spherical Planet surface and interactive 3D/flat views.
- Region footprint selection replaced independent random map creation.
- Globe pole geometry and antimeridian overlays were made robust.

## Engine 4.0: Planet Authority

- Planet-owned shared detail store and spherical tile provenance.
- Map-ID-independent Region generation.
- Explicit Region selection controls and Planet environment analysis.
- Direct portable `URDR.exe` startup without a command launcher.

## Engine 4.1: DetailedRegion

- Persisted `Planet -> DetailedRegion -> MapView` ownership.
- Shared patch references for overlapping maps.
- Region-only override records that do not mutate Planet authority.
- Migration of older Region/view saves.

## Engine 4.2: Region Safety and Document Integration

- Region preflight memory/cell estimates and structured errors.
- Shared Planet reference frame and constrained Planet UI.
- Project Home adopted standard TOC/body behavior.
- Genealogy, population/economy, and character-chart editing matured.

## Engine 4.3: Performance Refactor

- Revision-keyed Planet texture cache and larger zoom range.
- Four times more Planet surface cells through doubled linear quality.
- Rayon parallel physical fields and shared immutable `Arc` buffers.
- Cached Region analysis samples, bounded flow selection, cancellation, and
  preview/render cache reuse.

## Engine 4.4 Pass 1-5: Diagnosis and Rendering Stability

The map pipeline was instrumented rather than tuned blindly. Work included:

- wheel/LOD event measurement;
- Canonical tile work moved off the UI thread;
- duplicate sampling removal;
- continuous coast and terrain display refinement;
- deterministic visual exports and raw/debug layers;
- tracking large triangular elevation artifacts to their first causal stage.

## Engine 4.4 Pass 6: Planet/Region Terrain Contract

Pass 6 established the current terrain invariant:

- same spherical position, same parent terrain;
- continuous geological influence instead of hard nearest-site boundaries;
- bounded, zero-centered Region residual over Planet authority;
- parent-preserving water sign and major coastline;
- overlap/order/extent/resolution/projection regression tests.

This removed competing Planet and Region macro worlds. It deliberately retained
the 192 x 120 hydrology parent and documented remaining rectangular terraces.

## Engine 4.4 Pass 7: Continuous/Subcell Hydrology

Pass 7 retained basin/outlet/DAG/discharge identity while replacing axis-bound
cell-centre river graphics with continuous, terrain-aware centreline geometry.
It added shared confluence anchors, width/order attributes, correction
histograms, longest-run and direction metrics, and deterministic fixtures.

The result improved geometry but exposed a deeper mismatch: 1,426 of 3,720
channel cells still needed meaningful local profile conditioning, with a
660.234 m maximum.

## Engine 4.4 Pass 8: Multiresolution Physical Analysis

Pass 8 introduced a sparse shared physical field:

- deterministic refinement importance field;
- bounded L1/L2 patches with halos and SoA buffers;
- parent-constrained physical residuals;
- boundary-seeded local Priority-Flood;
- refined terrain and hydrology sampling the same world;
- diagnostics for gradients, saddles, parent deltas, correction severity,
  rectangular terraces, geometry, memory, and timing.

Locked fixture results:

| Metric | Pass 7 | Pass 8 |
|---|---:|---:|
| Conditioned channel fraction | 38.333% | 27.285% |
| Maximum profile correction | 660.234 m | 68.898 m |
| Raw uphill samples | 5,110 | 340 |
| Parent-grid curvature ratio | 17,820.770913 | 1.054744 |
| River axis bias | 0.469514 | 0.228574 |
| Longest straight run | 26.701 km | 22.097 km |

The implementation uses 145 patches and 479,649 refined cells for the locked
fixture rather than a dense 15.6-million-cell hydrology solve. Natural
hydrology remains partial because 75 deep closed-depression connections still
need persistent lake/endorheic representation.

## Current Direction

The next physical phase should be climate-conditioned geomorphology and
persistent closed-basin water systems, not another visual post-process. Long
term, the deterministic sparse physical field can become Planet-owned and
persist selected refinements for reuse across overlapping Regions.
