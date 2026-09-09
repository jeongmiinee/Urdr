# URDR Engine 4.4 Changelog

## Planet Stage 4A Topology Diagnostics

- Added a test-only observer for the existing Frag990 and Low42 Draft counterexamples, with frozen core/port identities, q split path witnesses, explicit relation contradictions and decomposed geology evidence.
- Reused existing K′/B′ and spherical metrics; imported compact historical Coast-first mask evidence without rerunning its generator. Major authority, flooded-water provenance and uncalibrated feasibility policy remain provisional or unresolved.
- Added fidelity, preservation, determinism, geometry and semantic regression checks. Production generation, sampling, schema/migration and other tracks are unchanged; Stage 4B is not started. See `docs/PLANET_STAGE4A_DIAGNOSTICS.md`.

## Planet Pole Sampler Maintenance

- Reconstructed each missing exact pole from the longitude-invariant mean of its outer latitude ring. Both nearest and interpolated sampling now return one value for the same physical pole.
- Limited continuous ring-to-pole blending to the interpolated sampler's last half-cell band; preserved ordinary latitude calculations, the periodic seam, and near-pole nearest selection.
- Added pole/convergence regressions, historical south-pole seeds 47/253, and pre-fix generated-payload/nonpolar sample fingerprints. Retained the historical raw-ring witness with corrected sampler assertions.
- Generated/stored PlanetSurface arrays, landmass semantics, recipes/schema and Region algorithms remain unchanged. This independent maintenance does not start Stage 4 GCDG / Stage 4A.

## Planet Axial Orientation Diagnostics

- Added a test-only 258-seed plate/noise rotation factorial exporter with equal-area cap controls, spherical latitude statistics, rigid-geometry checks and production elevation replay.
- Documented weak detected XYZ cap bias, separate plate/noise contributions, and the existing longitude-dependent pole sampler. Production generation and sampling semantics remain unchanged.
- See `docs/PLANET_AXIAL_BIAS_DIAGNOSTICS.md`; generated ensemble data and the full report stay outside Git.

## Planet Landmass Candidate 1 Evaluation (Stage 3)

- Added test-only all-plate continuous crust and relative-Euler-motion boundary candidates; kept production Planet generation, recipes, persistent schema and other development tracks unchanged.
- Added 32 full config fixtures with pre-candidate legacy snapshots, eight variants, separate fixed/cell-quantile/spherical-area threshold comparisons, and q topology persistence including neck/strait proxies.
- Added field continuity/contrast, kinematic sign/amplitude, attribution, deterministic replay and legacy preservation checks. The explicit ignored exporter writes reproducible component/mask/overlay evidence outside Git.
- See `docs/PLANET_LANDMASS_CANDIDATE_EVALUATION.md` for methods, results, limitations and the experimental-only boundary.

## Planet Landmass Diagnostics

- Added a test-only Planet observer with frozen six-seed legacy output checksums and full EarthLike config fixtures.
- Added an explicit ignored component/ablation exporter with spherical area, connectivity, coast, width-proxy and plate-correlation metrics; fixed-threshold and re-quantile results are separate.
- Kept production generation formulas, Planet/Region sampling, persistent schema and Non-Procedural modules unchanged. See `docs/PLANET_LANDMASS_DIAGNOSTICS.md` for metric definitions and resolution limits.

## Terrain Pipeline Pass 6

- Established a versioned Planet-to-Region terrain contract: old saves retain recipe revision 1 while newly generated maps persist recipe revision 2 and their parent world seed, selection bearing, and planet radius.
- Replaced hard nearest/second-nearest geological guide selection with a normalized continuous Gaussian influence field for revision 2 maps.
- Derived compression, divergence, shear, and vorticity from the gradient of the blended plate-velocity field instead of site-pair discontinuities.
- Converted Region procedural terrain into a bounded, zero-centered meso/local residual over the authoritative parent surface instead of generating a second competing macro terrain.
- Kept major land/water identity constrained by the parent surface so Region detail cannot silently relocate a Planet coastline.
- Made parent terrain sampling independent from requested display resolution and stable across overlapping Regions, generation order, and Region extent.
- Preserved natural variation inside dry and tropical-wet climate presets with continuous micro-drainage fields instead of allowing a whole Region to collapse into one terrain category.
- Added A/B/C guide ablation images, broad before/after terrain images, parent/residual correlation metrics, hydrology baseline notes, and performance measurements.
- Canonical terrain sampling improved from about 13,375 to 38,992 samples per second in the pass-6 fixture. Continuous guide sampling is about 30% slower per isolated guide sample but removes the former hard boundary jumps.
- Kept the 192 x 120 analysis-grid terraces, 8-neighbour hydrology, and climate-conditioned erosion as explicit later-pass work rather than silently changing their behavior here.

## Map Generation And Loading

- Removed a critical post-generation stall that scanned every canonical surface cell even when a newly generated map had no territory owners.
- Territory mesh construction now exits immediately for zero opacity, no factions, or no valid owner cells.
- Large canonical territory masks use a bounded 262,144-sample LOD while preserving the physical map extent and coastline water mask.
- Territory ownership is checked before the more expensive canonical terrain sample, avoiding unnecessary procedural evaluation outside owned cells.
- Startup reuses the prepared map cache until a generator preview exists, removing one redundant UI-thread cache rebuild.
- Existing procedural noise equations and seed semantics remain unchanged.

## Diagnostics

- Added session logs under `Logs` beside `URDR.exe`, with `%LOCALAPPDATA%\URDR\Logs` as a write-permission fallback.
- Added human-readable `urdr-session-*.log` files and machine-readable `map-performance-*.jsonl` files.
- Logged startup, project archive reading and decoding, canonical surface restoration, spatial reconciliation, render-cache construction, Region generation, preflight estimates, and hydrology rebuild/application.
- Added process ID, thread, elapsed time, map identity, dimensions, revisions, and error details to structured records.
- Retains the latest 12 files of each log type and flushes every major stage so a stalled or terminated session still has a useful final record.

## Shutdown Stability

- The native close request is observed before frame logic starts.
- URDR now owns the Winit event loop and explicitly exits it after eframe has processed a window-close request, preventing an invisible residual process.
- Active Region generation receives cooperative cancellation, and pending load, preview, hydrology receiver, and runtime state are detached before shutdown.
- Closing URDR during map work no longer allows completed heavy post-processing to start on the UI thread.

## Hydrology Pipeline Pass 7

- Preserved the macro-authoritative basin, outlet, routing DAG, discharge, and stream-order identities.
- Replaced cell-centre, axis-bound river segments with deterministic subcell entry/exit anchors and weighted continuous headings.
- Added bounded terrain-constrained corridor search against the authoritative Canonical sampler.
- Applied strict downhill routing first; unresolved local corridors use a bounded longitudinal Priority-Flood support profile without editing authoritative terrain.
- Added deterministic river-shape, uphill, conditioning, lake-connector, and performance diagnostics.

## Physical Analysis Pipeline Pass 8

- Added deterministic sparse L1/L2 physical refinement driven by slope, curvature, roughness, channel importance, coasts, saddles, and Canonical disagreement.
- Kept L0 macro analysis as global authority while sampling bounded Canonical physical residuals into local structure-of-arrays patches.
- Reconciled local river geometry against the same refined physical field used by terrain analysis without changing major basin or outlet identity.
- Added hard budgets of 256 patches, 480,000 refined cells, and 96 MiB physical scratch instead of materializing a dense 100 m Region surface.
- Excluded Region creation order, camera, zoom, and render LOD from physical cache identity so overlapping Regions remain deterministic.
- Added machine-readable refinement, terrain-grid, hydrology, river-shape, and performance reports plus compact PNG/PDF visual evidence.
- Retained climate-conditioned geomorphology, sediment transport, floodplains, meander migration, braiding, and dynamic climate invalidation as explicit future work.

## Compatibility

- Native save marker is now `urdr-native-4.4`.
- Earlier `urdr-native-*` saves remain accepted.
- Distribution copies omit Python caches and C/C++ static/import libraries that are not used by the bundled IMS inference runtime; executable modules, models, and offline synthesis remain included.
- No new third-party package or license was introduced; the event-loop adapter directly uses the Winit version already bundled by eframe.
