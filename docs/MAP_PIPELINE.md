# Planet, Region, Map, Terrain, and Hydrology Pipeline

## Mental Model

URDR no longer creates independent random maps. It creates a Planet first, then
selects a spherical area and resolves that same area into a detailed Region and
map representation.

```text
PlanetGenerationConfig
  -> PlanetState / global PlanetSurface
  -> RegionSelection
  -> Region preflight and provenance
  -> macro Regional Analysis
  -> sparse physical refinement
  -> locally reconciled hydrology
  -> Canonical Surface and RiverGraph
  -> render LODs and overlays
```

## 1. Planet Generation

`planet_config.rs`, `spatial.rs`, `geology.rs`, and `procedural.rs` validate and
derive the Planet's physical, atmospheric, hydrospheric, tectonic, and quality
settings. Typed stage sub-seeds keep results independent of UI order and worker
completion order. `PlanetState` persists the result and revisions.

The Planet surface is spherical and continuous across longitude. Axial tilt and
azimuth are represented in a shared reference frame used by rendering and
environment analysis.

## 2. Region Selection and Preflight

The user selects a footprint on the Planet. The selection becomes a
`RegionDefinition`; shared detail provenance is stored through
`DetailedRegion` and Planet detail patch references. Preflight estimates output
cells, analysis cost, and peak memory before mutating shared state.

The same spherical position must produce the same parent data regardless of:

- Region name or map ID;
- Region creation order;
- overlap with another Region;
- requested display resolution;
- camera, zoom, or projection rotation.

## 3. Macro Regional Analysis

The current locked diagnostic fixture uses a 192 x 120 macro grid for a
500 x 312.5 km Region. Macro analysis provides broad elevation, climate,
drainage context, basin hierarchy, runoff, flow accumulation, and channel
topology. It is an analysis representation, not the final pixel grid.

Increasing the entire macro grid to the Canonical resolution is explicitly
avoided because full Priority-Flood, routing, erosion, and climate costs grow
too quickly.

## 4. Pass 6 Parent-Constrained Terrain

Pass 6 made Planet/Region terrain consistent:

```text
Physical terrain = Planet/macro parent + bounded physical residual
Display detail    = physical terrain + sub-resolution detail
```

The geological guide uses continuous normalized influences instead of hard
nearest-site boundaries. Region residuals are bounded and approximately
zero-centered so downsampling recovers the parent and major coastlines do not
move arbitrarily.

## 5. Pass 8 Sparse Physical Refinement

`multiresolution_physics.rs` builds a deterministic importance field from slope,
curvature, roughness, channel/flow signals, coast/outlet proximity, saddle and
gradient disagreement, and Pass 7 conditioning evidence.

Selected 8 x 8 macro-cell blocks receive haloed patches:

- L0: macro authority for the whole Region;
- L1: roughly 500 m to 1 km physical analysis;
- L2: roughly 100 m to 500 m where justified.

Current safety budgets are 256 patches, about 480,000 refined cells, and 96 MiB
physical scratch. Patches use structure-of-arrays buffers. Their key contains
world/revision/spherical patch/physical recipe identity, never map or camera
identity.

Each patch samples a bounded physical residual and runs boundary-seeded local
Priority-Flood. Terrain sampling uses raw refined elevation; local hydrology
uses conditioned refined elevation. Coarse fill is not written back as an
authoritative terrain edit.

## 6. Hydrology Topology and Geometry

`generator.rs` computes macro flow and channel context. `river_graph.rs` stores
stable nodes/reaches, contributing area, discharge, Strahler/Shreve order,
width, depth, and velocity. `subcell_hydrology.rs` then resolves each allowed
reach through the shared continuous physical field.

Pass 7 replaced cell-center, eight-axis-looking lines with weighted subcell
entry/exit anchors and deterministic corridor search. Pass 8 improves the
terrain that this geometry sees.

Important rules:

- major basin and outlet identity remains macro-authoritative;
- minor centerlines may adapt to refined terrain;
- confluences use shared graph nodes;
- width never shrinks downstream;
- map boundaries are not coastlines;
- freshwater and ocean cells do not receive a river line on top of water;
- deep closed-depression connections become lacustrine candidates rather than
  visually climbing hundreds of metres.

Local profile conditioning is routing support and a diagnostic, not terrain
editing. The current Pass 8 locked fixture reduced meaningful conditioned
channel cells from 38.333% to 27.285% and maximum river-profile correction from
660.234 m to 68.898 m. Persistent closed-basin water bodies remain incomplete.

## 7. Canonical Surface

`NativeMap` records a physical `surface_cell_m`, currently 100 m for normal
detailed maps. A 500 x 312.5 km map therefore has a logical 5000 x 3125 surface.
The application does not allocate every logical cell as a rich object.

`CanonicalSurface` stores optional fixed-size chunks and a deterministic recipe.
Untouched cells can be regenerated; edited chunks are owned and revisioned. The
surface stores compact elevation, terrain, and water channels. Analysis and
render blocks sample it through bounded APIs.

## 8. Shoreline, Contours, and Terrain Display

- Water identity comes from explicit water kinds.
- Shorelines and contours use interpolated Marching Squares.
- Ambiguous saddle cases are deterministic.
- Map edges do not gain coastlines merely because data ends there.
- Narrow channels and isolated lakes have dedicated regressions.
- Terrain display refinement changes visual boundary coverage without changing
  macro classification authority.

At farther zoom, geometry is simplified and terrain is aggregated by block
majority. This is display LOD only.

## 9. Rendering and Interaction

`terrain_renderer.rs` creates asynchronous visible tiles and a progressive
overview. `map_render_cache.rs` keys data by source/revision and quantized LOD.
Cold tiles keep a fallback visible; stale job results are rejected. The map,
labels, markers, paths, territory, rivers, shoreline, and contours share one
camera transform so they move together.

Zoom changes view scale and cache buckets only. It must not regenerate the map,
rerun Region refinement, or mutate physical fields.

## 10. Editing

Brush strokes reset continuity on pointer release and resample by distance/time
instead of raw mouse event count. Elevation edits update Canonical Surface
chunks and revisions. Ocean flooding uses connectivity to existing saltwater;
isolated below-sea-level land remains land. Derived shoreline, contour, road,
and river caches must be invalidated by the affected source revision and halo.

Human geography is time-dependent. Territories, place/event positions, roads,
and labels are separate from terrain, and changes apply at their timeline state.

## Regression Fixtures

The Pass 8 diagnostic fixture is:

```text
seed:              990500051
extent:            500 x 312.5 km
macro analysis:    192 x 120
canonical surface: 5000 x 3125 at 100 m
```

Required tests include Planet/Region overlap/order/extent invariance, parent
downsample recovery, patch seams, coast/basin preservation, analytic saddles and
curved valleys, flat/mountain residual bounds, render-LOD independence, and Pass
6/7 regression suites.

## Forbidden Shortcuts

- Dense whole-Region 100 m hydrology.
- Final terrain blur to hide patch seams.
- Visual river wobble unrelated to terrain.
- Raising thresholds to hide conditioning failures.
- Coupling physical refinement to camera zoom.
- Rerolling Planet data from map ID.
- Persisting render caches as world authority.
