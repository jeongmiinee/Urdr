# URDR Engine 4.4 Test Report

## Automated Verification

- `cargo fmt --all -- --check`
- `cargo check --locked`
- `cargo test --locked`: 280 passed, 0 failed, 7 ignored (manual visual, performance, and diagnostic exporters)
- `cargo build --release --locked`: passed
- portable resource-manifest validation
- Korean and English demo diagnostics
- IMS-Toucan model checksum and offline synthesis diagnostic
- direct `URDR.exe` launch, post-startup close-request, exit-code, log-flush, and leftover-process checks
- portable and source ZIP SHA-256 generation

## Added Regression Coverage

- maps with no valid territory owner return an empty territory mesh without canonical surface traversal
- large canonical territory meshes keep a fixed sample-count ceiling and preserve aspect ratio
- old map settings without recipe metadata deserialize as terrain recipe revision 1
- new maps persist terrain recipe revision 2 and a stable parent-world identity
- guide influence remains finite and continuous across former nearest-site boundaries
- the same spherical position returns identical parent terrain at 100 m, 500 m, and 1,000 m requests
- overlapping Regions, reversed generation order, and changed Region extent preserve shared macro terrain
- canonical downsampling recovers the parent surface while the local residual remains zero-centered and decorrelated from it
- canonical residuals remain continuous across chunk boundaries
- dry and tropical-wet macro climates guide terrain without collapsing a Region into one category
- subcell river geometry remains deterministic, finite, continuous at confluences, and independent from eight fixed axes
- sparse L1/L2 physical patches are deterministic across projection, Region order, overlap, and render LOD
- physical refinement preserves parent coastline, macro relief, major basin identity, and expected outlets
- local hydrology samples refined terrain while requiring less profile conditioning than the Pass 7 baseline
- tile streaming keeps UI-thread work bounded, deduplicates jobs, rejects stale revisions, and preserves fallback visibility

## Pass 7 And Pass 8 Result

- macro basin, outlet, routing DAG, discharge, and stream-order identity remain authoritative
- river centrelines use subcell anchors and bounded terrain-constrained corridor search
- L0 remains global authority; sparse L1/L2 refinement is a deterministic derived cache
- physical refinement is capped at 256 patches, 480,000 cells, and 96 MiB scratch memory
- full dense 100 m Priority-Flood and full Canonical materialization are not performed
- climate-conditioned geomorphology, sediment transport, floodplains, meander migration, braiding, and persistent endorheic storage remain future work

## Pass 6 Diagnostic Result

- parent versus old full procedural correlation: `0.999910874`
- parent versus new residual correlation: `0.000418811`
- residual mean: `0.049 m`
- residual RMS: `16.229 m`
- canonical samples per second: `13,375.493 -> 38,991.827`
- isolated guide samples per second: `476,782.481 -> 331,781.151`
- final result: Planet/Region consistency passed; hydrology and climate-conditioned geomorphology remain partial by design

## Live Profile Finding Addressed

- the blocked Engine 4.3 process spent its active thread in procedural trigonometric terrain sampling
- the caller was canonical territory finalization after Region generation, not the generation worker itself
- a maximum-size 4,000 km square map exposed 1.6 billion virtual 100 m cells to that accidental full scan
- Engine 4.4 removes the empty scan, bounds populated territory sampling, and records the duration of each finalization stage
- live Engine 4.4 startup reduced the 5,000 x 3,125 canonical territory surface to a 648 x 404 render sample and completed the prepared render cache in 2-3 ms
- the verified shutdown log recorded `close_requested`, `exiting`, job cancellation, eframe exit, and `stopped` in order; the process returned exit code 0
