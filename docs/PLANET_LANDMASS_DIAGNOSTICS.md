# Planet landmass observation and ablation

This workflow observes the existing Planet generator. It does not introduce a
new recipe, change saved-world fields, or change Planet/Region sampling.
`spatial.rs` declares a `cfg(test)` child module so the observer can read private
surface arrays and call the original noise/geology helpers. There is no module
declaration in `main.rs`, production instrumentation, dependency, or runtime cost.

## Run

From `native/urdr-wgpu`:

```powershell
cargo test --locked planet_landmass_ -- --nocapture
$env:URDR_LANDMASS_OUTPUT = 'C:\path\to\a\new\experiment-directory'
cargo test --locked planet_landmass_export -- --ignored --nocapture
```

Without the environment variable, the exporter uses
`outputs/URDR-4.4-Planet-Landmass` at the repository root. It refuses an existing
output directory to preserve prior evidence. Only the named ignored exporter
writes images/CSV. Normal tests do not export data. Do not commit exports.

## Frozen baseline and preservation gate

The test input `native/urdr-wgpu/tests/fixtures/planet_landmass_earthlike.json`
contains six **complete** configs: seeds 0, 1, 42, 44, 990500051, 20260906,
Draft 512 x 256, EarthLike settings, q=0.71. Axial azimuth is explicitly held at
the original default value across seeds, as are all other non-seed fields.
`presetSource` is provenance; this test does not assume preset expansion exists.

The companion `planet_landmass_legacy_checksums.json` was captured from
`9573df2e0ca4c51f55e3ac73a8bc71402f856fcd`, **before repository instrumentation**,
using an isolated `git archive` copy. A test-only tap wrote the original H and
threshold buffers immediately after quantile selection; an ignored capture test
serialized the original generated surface. No formulas changed in that copy.
The capture environment was Windows x86_64 MSVC, rustc 1.98.1 / cargo 1.98.1.
Baseline fmt/check/test/release-build all passed first (280 passed, 7 ignored).

Checksums use FNV-1a 64 with offset `cbf29ce484222325`, prime `100000001b3`;
H uses little-endian f32, elevation little-endian i16, terrain u8, water u8 with
1=water. Threshold is its u32 bit pattern. These are regression fixtures, not
bulk generated exports. Do not refresh them to make a failing test pass.
Bitwise transcendental results on other compiler/architecture combinations are
not promised; investigate a mismatch rather than weakening the gate.

`preservation()` runs before any ablation. It compares original checksums,
replayed elevation/terrain/water with every production cell, and production
surfaces generated before and after observation. The independent worker test
compares 1 and 2 Rayon workers. Production functions themselves remain unchanged.

## Experiment matrix

For every seed: ALL, C only, D only, K only, K+B, no K, no B, no D;
F={0,.25,.55,.75,1}; crust fraction={0,.2,.43,.7,1}; and fixed-H
q={.5,.6,.71,.8,.9}. There are 23 variants x 2 modes x 6 seeds = 276 records.

`fixed` keeps the original baseline threshold. `requantile` reselects the
existing **unweighted** cell quantile, normally q=.71; q-sweep variants use their
specified q. Fixed-mode q-sweep records are intentionally identical controls.
The modes must not be pooled. Removing K removes the entire categorical crust
bias, not just its mathematical discontinuity; it is not a test of smooth K.
Crust fraction resynthesizes geology using the same seed and asserts identical
plate centers/IDs and B. C/D are reused. F only changes D's coefficient.

The legacy quantile is `floor((N-1)*clamp(q,.02,.98))`, sorted by f32 total order.
Ties are retained, without randomized tie breaking. K-only can miss the requested
coverage badly. Metrics retain target error, tie count, raw water coverage, and
positive H rounded to stored 0 m. All principal masks use stored elevation > 0
for land. Two exact pole probes are excluded from quantile and have zero area.

## Spherical metrics and resolution limits

- Cell area is `R² Δlongitude (sin(north)-sin(south))`, in km². Cell-count ocean
  coverage is reported separately. Polar cap fractions select cells by center
  latitude, so the nominal 60/75 degree boundary has raster precision.
- The primary connectivity graph wraps longitude, links four adjacent cells,
  and has one exact vertex per pole. A pole connects only same-phase adjacent
  cells when the **evaluated pole** has that phase; a top row is never merged
  unconditionally. Pole-only components have no area and are excluded from the
  landmass count. A consistent diagonal per quad plus the same polar fan gives
  a triangulation sensitivity count. Differences flag unresolved sampling/saddles.
- Perimeter sums exposed spherical latitude/meridian cell-edge arcs once, with
  zero-length pole boundaries. It is a rectilinear raster perimeter, **not an
  interpolated contour perimeter**. Compare only matching resolution/projection;
  axis bias remains. Compactness is `(4πA-A²/R²)/P²`, per component.
- Every positive-area component is exported, sorted by area, including its
  land/planet fractions, perimeter, compactness and elongation. Area bins cover
  islands and larger landmasses without inventing a continent cutoff. Micro-islands
  have 1–3 cells; their exact spherical area and land-area fraction are separate.
- Elongation is the square root of the ratio of the largest two eigenvalues of
  area-weighted 3D chordal covariance. It avoids longitude wrapping artifacts but
  is not a geodesic skeleton or a reliable single-axis model of globe-spanning
  or strongly curved components. Degenerate values are null.
- A geodesic graph distance transform seeds opposite-phase edge midpoints.
  Erosion radii 80/160/320 km give width bounds 160/320/640 km. Within each original
  component, surviving eroded core count minus one is the neck split excess;
  the same calculation on water is the strait diagnostic. A disappearing island
  is reported as a parent without a core, not a neck. Counts can be nonmonotone
  when cores vanish; they are not counts of distinct anatomical necks and do not
  detect every cycle. The three levels are width bounds, not fitted exact widths.
- A long thin peninsula **proxy** is an opening residual attached to a surviving
  core whose reach beyond the opening is at least 3 times twice its maximum
  coast distance. Areas/reach/width estimates are exported. This is a morphological
  proxy, not skeleton branch extraction or an assertion of visual naturalness.
- Draft equatorial cell spacing is about 78 km. One-cell channels, metric
  behavior below two cells, and polar graph distance anisotropy need finer-grid
  confirmation. Grid resolution is physical quality here, not render LOD.
- Coast-to-plate distance is measured against the owner's spherical Voronoi
  supporting bisectors, testing all competing plate centers. Coast-edge values
  average the adjacent center distances and are weighted by edge length; they
  approximate contour-to-boundary distance at this raster resolution. Mixed-crust
  coast fraction counts edges crossing a categorical crust change.
- Conditional land/crust probabilities and covariance/correlation of weighted
  C,D,K,B,H use spherical area. Mask flip fraction uses total planet area; Jaccard
  uses the land union. Null means undefined, not zero.

Synthetic regressions cover 4π sphere area, 2π hemisphere perimeter, seam
connectivity, conditional pole connectivity, and a narrow bridge retained after
longitude rotation. Original sampler seam/pole longitude ranges are exported
separately; the diagnostic pole graph does not repair the production sampler.

## Files and visual convention

Each seed exports full config, geology/motion metadata, per-point CSV, covariance,
sampling checks, and metadata. Each variant exports its full config, raw H as
f32 little-endian, and both masks as u8 **1=land** (different from the frozen
water checksum convention), including two pole samples. The CSV contains raster
rows only. Metadata explains layout and exact threshold bits.

Images use north-up equirectangular 512 x 256, identical colors and fixed ranges
across all seeds: C/D/H [-1,1], K [-.2,.2], B [0,1]. Positive scalar is red,
negative blue, zero off-white. Land is tan, water dark blue. Plate/component IDs
use a stable categorical palette. The boundary overlay uses cyan for plate edges
and off-white for coasts. Coast-distance colors run green at 0 km to red at
1000 km and clamp above that. No per-image auto normalization is applied.
Polar PNGs are orthographic resamplings of the same baseline raster.

These diagnostics cannot establish that a smoother crust field is sufficient,
that hierarchical cratons/terranes/rifts are necessary, or that a screenshot's
remaining artifact is caused by the generator. They provide controlled evidence
for a later design decision. Candidate 2 and generator semantics require a
separate implementation decision.
