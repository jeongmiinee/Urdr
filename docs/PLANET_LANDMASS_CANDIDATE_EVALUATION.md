# Planet landmass Candidate 1 evaluation (Stage 3)

Candidate 1 exists only below the `cfg(test)` Planet observer. It does not
replace `PlanetSurface::generate`, change C/D/F/q within a fixture, introduce a
recipe or schema, or affect Region, hydrology, UI, or Non-Procedural code.
The Stage 2 [measurement definitions](PLANET_LANDMASS_DIAGNOSTICS.md) still apply.

## Recovery and preservation

Stage 3 starts at `30b6f3d2a1b36d87f2895cd3179da37b27bda0ad` on
`feature/procedural`. Its clean baseline passed fmt/check/test/release build;
tests were 286 passed, 0 failed, 8 ignored. Work resumed from the existing
uncommitted candidate implementation; its fields and fixtures were retained.

The 32 full configs in `planet_landmass_candidate_profiles.json` have companion
frozen `planet_landmass_candidate_legacy_checksums.json` expectations captured
before candidate implementation from an isolated archive of that start commit.
The capture used original H, threshold, elevation, terrain, and water arrays.
Hashes follow Stage 2 FNV-1a 64 / fixed little-endian rules. Both the original
six-seed Stage 2 gate and expanded gate remain enabled. Never refresh snapshots
to accommodate a candidate failure. Capture and comparison used Windows x86_64
MSVC, rustc/cargo 1.98.1; cross-platform floating-point identity is unverified.

## Continuous crust K'

Let p and plate centers c_i be unit vectors. All plates participate:

    w_i = exp(kappa * (dot(c_i,p) - max_j dot(c_j,p))) / sum_j exp(...)
    K' = sum_i w_i * (0.28 * crust_i)

Crust source values remain continental .58, oceanic -.52, transitional .05.
Thus K' is a bounded convex combination, with no owner-switch branch. Owner ID
remains provenance. Nearest-two blending can jump when its selected set changes;
all-plate weights avoid that switch. No final raster blur is applied.

Let d be the upper median of each center's nearest-center angular distance.
The locked transition fraction is .20, chosen before examining experiment
images. The two-plate logistic 10–90 width is .20d:

    kappa = ln(9) / (2 sin(d/2) sin(.20d/2))

This is a geometric scale choice, not a fitted visual score. Multiple plates
can alter actual transition widths. The exporter measures monotone mixed-crust
normal transects bracketing 10% and 90%; unresolved junction transects are counted
separately. Continental/oceanic conditional means, interior means (distance
from a boundary >= .10d), variance and contrast retention expose attenuation.
Mean and variance are measured, not forcibly restored by a gain/offset.

Boundary probes project owner-changing grid arcs to an active spherical
Voronoi bisector. They compare values at half-spans 100 km, 1 km, 10 m, .1 m.
Reported crossing gradients are delta divided by full distance. The .2 m
crossing delta is a finite probe, not a mathematical discontinuity. Analytic
K' tangent gradient is also exported. Percentiles are unweighted samples;
coast fractions/distances use perimeter weights; field means use spherical area.

## Kinematic boundary B'

Euler motion is the authority. Stored hash boundary kinds are compared for
disagreement, but never choose the response. With omega in radians/Myr:

    v_i = (omega_i - omega_0) cross p
    cbar = sum_i w_i c_i; vbar = sum_i w_i v_i
    t_i = tangent_projection(c_i - cbar)
    n = -sum_i w_i dot(t_i, v_i - vbar)
    s = sum_i w_i dot(cross(t_i, v_i - vbar), p)
    g = sum_i w_i |t_i|^2
    a = sum_(i<j) w_i w_j
    W = max_(i<j) |omega_i - omega_j|
    normal_response = n / (W sqrt(g a))
    shear_response = s / (W sqrt(g a))
    B' = (.05 + .20 O) * legacy_boundary_proximity * normal_response

The denominator follows the Cauchy covariance bound and the pairwise velocity
variance bound W²a. It does not normalize away local slow slip. A common rigid
angular velocity cancels. Ratios are clamped to [-1,1] for rounding; denominator
<=1e-20 produces zero. Convergence is positive, divergence negative; ideal pure
shear has zero relief. This is a signed tendency, not a tectonic simulation.
Legacy proximity `clamp(1-7.5 abs(dot1-dot2),0,1)` and the original amplitude
ceiling (.166 in these fixtures) are retained to isolate the response change.
The envelope is continuous but has derivative kinks. No shear uplift is added.

The conservative global normalization reduces amplitude as well as changing
sign. Relief reduction cannot be attributed solely to kinematic typing.
Amplitude distributions, area-weighted RMS/absolute means, and zero-B controls
make this confound visible. No amplitude was tuned against images.

Classification uses nearest-pair relative velocity projected onto its local
boundary normal and tangent. |normal| >= |shear| selects convergent/divergent;
otherwise it is shear-dominant (`transform`), with stationary <1e-14 rad/Myr.
The active measurement band is legacy proximity >.1. Counts and sample
percentiles are unweighted; sign fractions and class means are area-weighted.
Radians/Myr multiplied by radius in km equals mm/year. All-plate blended B'
can differ in sign from nearest-pair classification near junctions; CSV probes
and class means must be interpreted with this distinction.

## Fixed matrix and threshold modes

Each profile has Draft 512×256 seeds 0, 1, 42, 44, 990500051, 20260906 and
Normal 1024×512 seeds 0, 990500051: 32 fixtures total. Full configs, including
physical/atmospheric settings and axial azimuth, are stored explicitly.
Non-EarthLike profiles have null preset provenance and are diagnostic intents.

| Profile | Plates | Continental fraction | F | Rift | q |
|---|---:|---:|---:|---:|---:|
| earthlike | 12 | .43 | .55 | .45 | .71 |
| low_fragmentation_intent | 12 | .43 | .10 | .10 | .71 |
| fragmented_continent_intent | 16 | .43 | .90 | .75 | .71 |
| archipelago_intent | 24 | .30 | .90 | .65 | .85 |

Eight variants keep their names: `Legacy`, `continuous_K`, `kinematic_B`,
`continuous_K_kinematic_B`, `no_K`, `no_B`, `no_K_no_B`, `continuous_K_no_B`.
Only K/B contributions differ within each fixture. Legacy f64 component sums
cast to f32 in the original order; physical land uses stored i16 elevation >0.

Each variant has three separate modes (768 records):

1. `fixed`: original legacy threshold.
2. `cell_requantile`: original unweighted cell-count quantile at configured q.
3. `area_matched`: closest attainable spherical water area to that fixture's
   **legacy physical water area**, not necessarily configured q. The solver
   finds exact f32 threshold transitions under existing elevation rounding,
   groups ties and reports its discrete area-step error bound. Evaluation only.

The first four variants also have q offsets -.02, -.01, 0, .01, .02 (640 rows),
using their unchanged H. Persistence measures component count, A1/A2, micro
area, mask flip relative to each variant's center-q mask, retained reference
largest-component area, and the Stage 2 land-neck/water-strait erosion/opening
metrics at a 320 km width bound. Main records retain all 160/320/640 km bounds.

B attribution removes B at the same variant threshold without requantiling.
Supported/suppressed area and supported thin land (<160 km from coast) are
reported. Thin land is not automatically a bridge. Secondary water components
are a ring proxy, not proof of an enclosing tectonic ridge.

## Run and artifacts

From `native/urdr-wgpu`:

```powershell
cargo test --locked planet_candidate_ -- --nocapture
$env:URDR_CANDIDATE_OUTPUT = 'C:\path\to\a\new\candidate-directory'
cargo test --locked planet_candidate_export -- --ignored --nocapture
```

The exporter refuses existing output directories. Default output is
`outputs/URDR-4.4-Planet-Candidate-1`. Generated files/logs/binaries stay out of
Git. Expect roughly 1 GB and tens of minutes in a debug test build. Run only
the named ignored exporter, not all ignored tests.

Each fixture includes full config/geology/metadata, field/boundary statistics,
CSV transects, seam/pole checks, nine-column f64 component samples, owner/second
indices, eight f32 H arrays and three masks/metrics/overlays per variant.
Binary arrays include row-major cell centers plus two exact pole probes.
`metadata.json` specifies layout, dimensions, units and palette. Images use
the same north-up equirectangular projection and signed K/B scale [-.2,.2].
Coast is off-white, plate edges cyan, mixed-crust edges magenta, intersections
yellow. Contact boards must preserve each fixture's scale and palette.

Focused gates cover crust jump/interior contrast, convergence/divergence/pure
shear/common rigid motion, seam/poles, deterministic replay, 1/2 workers,
coordinate rotation, same-point Draft/Normal equality, exact area matching,
repeat serialized statistics, and all frozen legacy arrays. The export checks
preservation again for every fixture. Production tests remain enabled.

After experiments run fmt/check/test/release-build as listed in AGENTS.md.
Compare the complete old test names/statuses, not just total counts.

## Interpretation limits

Assess all requested criteria together: hard-coast reduction, crust contrast,
signed relief, bridges/necks/rings, macro geometry, island count, q stability,
seam/poles, repeated seeds/profiles and Normal direction. Better images alone
do not establish success. Separate threshold modes and paired resolutions.

Spherical area is exact per cell, but the rectangular 4-neighbor graph and
axis-aligned perimeter are sampling approximations. Triangle connectivity is
a sensitivity check. Widths use erosion/opening proxies, not skeletons.
Pole vertices have zero area; existing production pole interpolation residuals
are unchanged. High-resolution convergence, cross-platform bit identity,
runtime integration and full tectonic realism are unverified. Candidate 2,
C octave changes and production promotion require a later task.

## Measured Draft results (24 fixtures)

These are equal-fixture means within **area_matched** mode, Legacy → K'+B'.
They do not pool threshold modes or treat repeated geology/Normal samples as
independent planets.

| Metric | Legacy | K'+B' |
|---|---:|---:|
| Coast crossing mixed-crust edge | 25.906% | 1.990% |
| Land erosion split excess, 320 km bound | 15.708 | 8.208 |
| Water erosion split excess, 320 km bound | 5.167 | 5.458 |
| B-supported thin land / planet area | 3.079% | .678% |
| Land components | 23.792 | 18.125 |
| Secondary water components (ring proxy) | 8.042 | 6.125 |
| Largest component / land area | 72.097% | 59.413% |

K' retains 88.34–92.90% of owner-conditional continental/oceanic contrast and
98.24–99.08% in the measured interiors. The maximum .2 m boundary crossing
difference is 1.505e-7, versus legacy's .308 step. Measured per-fixture median
10–90 widths are 727–1105 km; unresolved transects are reported separately.
Active-band B' has mean negative/positive area fractions 49.61%/50.39%, compared
with legacy's 100% positive. Mean RMS falls .10417 → .02892: attenuation is a
material part of the intervention.

The q gate is not uniformly satisfied. For fragmented_continent_intent seed
990500051 Draft, q=.69/.70/.71/.72/.73 gives candidate A1/land
93.273%/86.163%/51.175%/36.363%/36.806%. Its range is 56.91 percentage points;
legacy's is 6.82 points. The changed field moves critical connections; better
coast statistics alone cannot override this failure of uniform q stability.

## Normal completion and separate verdicts

All 32 fixtures / 768 main records / 640 q rows completed. All legacy snapshots
passed. In eight Normal fixtures, area-matched means change as follows:
mixed-crust coast 23.46% → .98%, neck320 20.125 → 12.375, strait320
11.125 → 7.000, land components 24.625 → 23.750. Comparing the same eight
profile/seed pairs at Draft gives mixed coast 23.70% → 2.01% and neck320
17.375 → 12.125. Thus the coast improvement survives increased resolution.

The critical fragmented seed also fails q stability at Normal: candidate
A1/land is 93.44% at q=.70 and 35.74% at q=.71. At Normal, cell_requantile
ocean 67.94% gives A1=35.74%, while area_matched ocean 67.31% gives A1=86.51%.
This is not dismissed as a Draft artifact and threshold modes are not pooled.

| Area | Verdict |
|---|---|
| Hard crust coast | PASS: categorical step removed; coast coincidence reduced |
| Broad crust contrast | PASS within the measured conditional/interior ranges |
| All-positive B semantics | PASS: signed kinematics; pure-shear test has zero relief |
| Bridge/ring/neck | PARTIAL: means improve; individual increases and attenuation confound remain |
| Strait behavior | MIXED: Draft mean rises; per-fixture exceptions remain |
| Component explosion | No ensemble explosion; 7/24 Draft and 3/8 Normal counts increase |
| Micro islands | Means improve; 2/24 Draft and 2/8 Normal counts increase |
| q topology stability | FAIL: large A1 jumps survive Normal |
| Draft/Normal consistency | PARTIAL: coast direction stable, critical connections resolution-sensitive |
| Profile differentiation | INCOMPLETE: low-F and EarthLike macro organization remains similar |
| Macro continent hierarchy | INCOMPLETE: no explicit major-component/strait contract |

Case B is the next research direction: explicit structural control remains
missing after artifact reduction. This is not a production promotion or a
claim that Candidate 2 would automatically fix the q gate. C remains important
(weighted SD .126–.175 versus K' .123–.144), but no isolated evidence establishes
C octave structure as the new sole dominant limitation (Case C).

Final fmt/check/test/release-build all passed after the complete experiment.
Tests: 292 passed, 0 failed, 9 ignored, compared with baseline 286/0/8.
The six added normal tests and one explicit ignored exporter account for the
difference; every original test name/status is preserved, including Pass 6/7/8.
Existing warning counts remain 218 for check/release and 17 for tests.
Independent artifact verification matched 192 frozen SHA256 files, reconstructed
all 256 H arrays from exported unchanged C/D and selected K/B terms, and checked
768 mask PNGs and 128 field PNGs against their raw arrays. No production source,
Cargo dependency, generator/recipe/schema version or migration changed.

Detailed A–AD report, per-fixture tables, worst cases, logs and contact boards
are retained outside Git at `../urdr44-landmass-stage3-2026-09-07/` relative to
the repository. Source/fixtures/docs are committed locally only. Any requested
Height-first/Coast-first side experiment begins after this Stage 3 commit and
clean-tree gate, and remains outside the production repository.
