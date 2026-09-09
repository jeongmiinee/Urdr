# Stage 4A topology observations

`planet_stage4a_diagnostics.rs` is an owning module under the existing `cfg(test)`
landmass evaluator. It observes the two existing Draft counterexamples,
`fragmented_continent_intent_990500051_draft` and
`low_fragmentation_intent_42_draft`. It does not implement a topology solver,
generator, accepted graph, or persistent constraint.

The observer reuses CandidateField K′/B′, quantile/stored elevation and spherical
Grid metrics. Its compact regression fixture contains the full existing configs,
frozen Stage 3 controls and a lossless run-length encoding of the existing Low42
Coast-first mask. That mask is imported evidence; no Coast-first generator runs.
Raw outputs, timings, manifests and research reports remain outside Git.

## Locked observer revision

`stage4a-observer-v1` is a diagnostic revision only. At configured q−.02, select
one provisional land anchor and one sublevel port per owner province with
positive-area phase cells. Rank by phase interior distance, K′ support (higher
for land/lower for sublevel), absolute stored clearance, then source index.
Sort IDs made from revision, full-config fingerprint, source family, plate ID
and kind. Freeze them across the five existing q offsets. Component labels are
observations rather than identities. No major threshold or score weight is fitted.

Record all changed land relations and one deterministic existing-path witness
per consecutive split transition, including cells lost at the next q. BFS only
queries the frozen graph. Path length and twice minimum coast distance are
empirical proxies; below two local spacings width is unresolved. They provide
no certified saddle, minimum corridor width, or topology protection.

K′, B′, convergence, divergence, signed/absolute shear and macro C remain separate.
Global/province evidence uses spherical area; core and route evidence uses
unweighted unique samples. Major adequacy, combined geology scores and feasibility
caps remain `CALIBRATION_REQUIRED`. Opposite same-relation requests yield
`CONFLICT`; missing evidence yields `UNKNOWN`; unsatisfied connectivity can only
be `INFEASIBLE_IN_OBSERVED_MASK`, never a global feasibility conclusion.

Sublevel ports are not established flooded-ocean identities. Actual ocean sources,
reservoir state and named passage/outlet corridors are absent from these inputs.
They remain unresolved; closed low basins are not filled. A connected global
sublevel component does not validate a local strait. Historical field pole probes
are retained for metric fidelity, explicitly distinct from consumer queries through
the fixed `PlanetSurface::sample` and `sample_interpolated` APIs.

## Verification and export

From `native/urdr-wgpu`, run `cargo test --locked planet_stage4a`. The normal tests
cover two-fixture fidelity/preservation, replay with changed worker/discovery order,
spherical geometry and relabeling, land/ocean locality, contradictions, geology
decomposition, the two semantic counterexamples and pole/seam compatibility.

The explicit ignored `planet_stage4a_export` requires `URDR_STAGE4A_OUTPUT` to
name an external directory containing a prelocked `CALIBRATION_MANIFEST.md`.
It refuses to overwrite any of its three JSON outputs. Run only this exporter,
not all ignored tests. Full required Cargo checks still apply.

Stage 4B remains separately gated. These observations do not establish cross-level
safety, resolution-independent identities, natural coasts, or production readiness.
