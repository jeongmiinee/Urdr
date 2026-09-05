# Third-Party Notices: URDR Engine 4.4

URDR Engine 4.4 is distributed with third-party components. Their license texts and notices are included under `Licenses` in the portable package.

Major runtime components include:

- Rust standard library and Cargo dependencies listed in `native/urdr-wgpu/Cargo.lock`
- eframe, egui, and WGPU ecosystem crates
- Rayon and Rayon Core for deterministic data-parallel CPU passes, Apache-2.0 OR MIT
- flate2 for compressed URDR4 and canonical-surface persistence
- IMS-Toucan inference source and model runtime, Apache-2.0
- Python and CPU inference dependencies bundled for offline IPA speech

## Research And Implementation Provenance

The Planet configuration, spherical surface, multi-LOD detail store, projection, causal geology, DetailedRegion refinement, Region preflight, whole-planet climate aggregation, URDR4 archive, render caches, river graph, shutdown coordination, and structured diagnostics implementations are original clean-room Rust code. User-supplied papers, articles, repositories, and technical digests informed architecture, terminology, validation criteria, and published algorithm families. No third-party source code was copied or translated into URDR.

Referenced projects and publications remain governed by their own licenses. They are not vendored by this release unless separately listed in the bundled license directory. URDR's source license remains the value declared in `native/urdr-wgpu/Cargo.toml`.
