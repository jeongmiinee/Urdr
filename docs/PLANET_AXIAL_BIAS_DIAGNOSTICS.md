# Planet axial orientation diagnostics

This test-only observer audits the **production Legacy** PlanetSurface field,
not Stage 3 Candidate 1 or the external Coast-first prototype. It preserves the
production generator, schema, recipe, versions, and Region/Pass 6–8 code.

From `native/urdr-wgpu`, set `URDR_AXIAL_OUTPUT` to a fresh directory outside the
repository and run:

```powershell
cargo test --locked planet_axial_export -- --ignored --nocapture --test-threads=1
```

`URDR_AXIAL_WORKERS` defaults to 8. Existing seed output directories are never
overwritten; do not rerun the exporter into a completed output directory.

The exporter uses 258 seeds (0..255, 20260906, 990500051), all with the complete
default EarthLike config except seed and Draft quality. Config, independent
seed-derived plate/noise quaternions, original/rotated geology, four native
512×256 masks, exact-field pole probes, sampler probes, and metrics are saved.
All 258 original elevation arrays must equal production output. Plate rotation
changes only centers and Euler poles; metadata and rigid geometry are checked.

The factorial treatments are original, plates rotated, noise frame rotated,
and both rotated. Production cell-count quantiles and rounded elevation water
semantics remain in each treatment. Spherical land area is reported separately.
Latitude/cap integrals clip raster rows by exact spherical area. Random cap
controls use 16 uniform axes and their antipodes (32 orientations), matched at
30°, 15°, and 5° angular radii. Each cap has 2048 equal-solid-angle quadrature
samples of the same frozen raster; six designated seeds also use 8192 samples
for measurement convergence. All controls of one seed share the same cap axes.

The 2026-09-08 external analysis bootstraps whole seeds, preserving all paired
treatments and caps. Its 258-seed run contains 1032 metric records. Nine primary
comparisons use 99.5% intervals, alongside descriptive 95% intervals. Effects
below 3, from 3 to 8, and at least 8 percentage points are labelled weak,
moderate, and strong only when the primary interval excludes zero.

Observed results, not production fixes:

- No real Earth geography dependency or explicit north-ocean/south-land rule
  occurs in the audited H call path. Tilt/azimuth changes preserve the complete
  generated surface. Latitude affects climate classification after elevation.
- Production plate-center Z coordinates are fixed by the Fibonacci index;
  seed variation jitters longitude. Noise interpolates a fixed cubic XYZ grid.
- Original pooled Z-cap and north-south effects are not detected under the
  conservative primary rule. The original 15° XYZ-cap excess is +2.53 pp
  (99.5% interval +0.18..+4.90 pp): a weak detected axis effect.
- Plate rotation has a paired +6.84 pp main effect on 5° Z-cap excess; noise
  rotation has a -4.40 pp main effect on 5° XYZ-cap excess. Both mechanisms
  contribute; neither is established as a universal dominant cause.
- Pole sampling has a longitude-dependent raster limit. All original worlds
  show pole elevation variation; two south-pole worlds also change water state.
  This sampler defect is separate from an explicit polar land-generation rule.

These findings apply to this config, seed ensemble, and Draft sampling. A
non-detected mean does not prove isotropy. Keep rotation consistency and pole
identity as review requirements before Stage 4; this task does not design or
implement a Hybrid generator.

The full A–T report, bootstrap outputs, plots, and raw artifacts are external:
`C:\Users\user\Documents\udrd\urdr44-axial-bias-diagnostic-2026-09-07`.

Focused tests cover rigid geometry/metadata and covariant point evaluation,
cap quadrature and clipped area, production replay/tilt independence, and an
explicit diagnostic witness of the existing pole sampler behavior. No existing
test is deleted or ignored.
