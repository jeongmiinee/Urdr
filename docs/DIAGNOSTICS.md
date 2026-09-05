# Diagnostics and Performance Workflow

## Principle

Do not tune map algorithms from a screenshot alone. First establish the
authoritative data path, add stage timing and raw layers, and reproduce the
problem with one locked seed/map/camera/revision tuple.

## Runtime Logs

The native application writes:

- `urdr-session-*.log`: startup, load, save, shutdown, and human-readable stage
  events;
- `map-performance-*.jsonl`: structured map generation, refinement, cache, and
  rendering timing.

The preferred location is `Logs` beside `URDR.exe`. If that directory is not
writable, `%LOCALAPPDATA%\URDR\Logs` is used. Each type retains the latest 12
files.

Useful fields include process/thread, elapsed time, map/source IDs, dimensions,
surface and recipe revisions, stage start/end, duration, cancellation, and
errors.

## Investigation Order

1. Reproduce with exact seed, Planet/Region IDs, extent, cell size, revisions,
   camera, viewport, and zoom.
2. Confirm whether the symptom is generation, persistence, physical sampling,
   cache invalidation, render LOD, or overlay transform.
3. Trace inputs from Planet through Region, macro analysis, Canonical Surface,
   and the renderer.
4. Add timings around the first suspected stage, not the outer UI action only.
5. Export the raw authoritative field and every transformation after it.
6. Compare numeric metrics before changing parameters.
7. Change one causal stage, rerun identical diagnostics, then inspect visuals.

## Standard Map Layers

Depending on the problem, export:

- parent and Canonical elevation;
- raw water mask, coast scalar, and refined shoreline;
- raw and refined terrain categories;
- macro cell and Canonical cell grids;
- refinement importance, L1/L2 mask, and patch halos;
- parent/Canonical gradient and saddle disagreement;
- flow direction, accumulation, basin/outlet IDs;
- RiverGraph nodes/reaches and subcell centreline;
- profile-conditioning heatmap and top mismatch corridors;
- cache key, LOD, and source revision.

Never use a debug display field as new physical authority.

## Pass 8 Export

```powershell
cd native/urdr-wgpu
cargo test pass_8_physical_export -- --ignored --nocapture
```

The exporter writes CSV, metadata, and deterministic PNGs to
`outputs/URDR-4.4-Pass-8-Multiresolution-Physical`. The compact PDF builder is:

```powershell
python tools/build_pass8_pdf.py ..\..\outputs\URDR-4.4-Pass-8-Multiresolution-Physical
```

The locked fixture uses seed `990500051`, 500 x 312.5 km, a 192 x 120 macro
grid, and a 5000 x 3125 logical 100 m surface.

## Required Before/After Metrics

Terrain:

- parent-grid boundary/curvature concentration;
- downsample RMSE and maximum error;
- coastline movement and water-sign changes;
- patch seams and category checkerboarding.

Hydrology:

- conditioned channel count/fraction;
- raw and conditioned uphill violations;
- correction total/mean/maximum and histogram;
- basin/outlet identity changes;
- axis-direction bias and straight-run lengths;
- lacustrine/closed-terminal count.

Performance:

- macro analysis;
- importance field;
- patch sampling;
- local hydrology;
- river geometry;
- total generation;
- refined cells, patches, peak scratch memory;
- main-thread frame/interaction time;
- tile queue length, stale results, cache hit rate.

## UI/Render Performance Rules

- Wheel events change camera scale immediately and enqueue at most bounded tile
  work.
- Tiny wheel changes stay in the same quantized LOD bucket.
- Cold tiles display a fallback until the worker result arrives.
- A result with an old source revision is discarded.
- Pan/zoom never clones the world or rebuilds the map.
- Labels, icons, paths, and terrain share the same camera matrix.
- Editing invalidates only intersecting chunks plus the algorithm's required
  halo.

## Visual Report Metadata

Every diagnostic image/report should include:

```text
seed
planet_id / region_id / map_id
surface_revision
physical_extent
surface_cell_m
macro and canonical dimensions
camera / viewport / zoom / pixels_per_km
physical LOD and render LOD
generator, terrain recipe, hydrology, and display revisions
```

## Pass/Partial Policy

Use `PASS` only when the causal invariant is satisfied, not when the final image
looks acceptable. Use `PARTIAL` when a fallback or unpersisted physical concept
remains. Record known limitations in the report instead of hiding them by
raising thresholds.
