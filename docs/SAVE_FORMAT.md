# Project Archive and Persistent Data

## Overview

Current projects use the `URDR4` archive container implemented in
`native/urdr-wgpu/src/storage_v4.rs`. The container separates a compressed root
JSON document from independent compressed binary blobs.

```text
magic:          URDR4\0\r\n
format version: u16
entry count:    u32
root lengths/checksum
blob headers
compressed root JSON
compressed blobs
```

Every root/blob payload has a deterministic 64-bit checksum. Entry names are
validated, sorted, deduplicated, and prevented from escaping the archive path.
Writes use a temporary file followed by replacement.

## Root Model

The root JSON serializes `LoadedWorld`, which includes:

- project metadata and Project Home sections;
- active map plus additional maps;
- Planet state, Regions, DetailedRegions, and map views;
- wiki articles and category tree;
- factions, events, heraldic assets;
- dictionaries and voice profiles;
- generated glyphs and character charts;
- embedded speech cache entries;
- timeline calendar selection;
- immutable world-creation flags and environment constants.

## Map Data

`NativeMap` persists:

- stable source/Region/view IDs and physical extent;
- logical and macro dimensions, physical cell size, sea level, seed;
- generation settings, geological guide, causal geology, diagnostics;
- macro elevation, terrain, water, climate, runoff, wind, and solar arrays;
- `RiverGraph` and drainage outlets;
- roads, places, labels, factions, territories, events, and environment pins;
- timeline year and territory history;
- Canonical Surface recipe/owned chunks and `surface_revision`.

`NativeMap.rivers` is a runtime compatibility view and is skipped during new
serialization. It is derived from `RiverGraph` to avoid storing every
centreline twice.

## Canonical Surface Blobs

The Canonical Surface represents physical cells without creating a rich object
per cell. It stores:

- logical width/height;
- optional chunk ownership;
- compact `i16` elevation and byte terrain/water channels;
- per-chunk revision;
- a deterministic generation recipe for untouched chunks.

Archive blobs allow large or independently reusable binary data to remain
separate from the root JSON. Do not inline large surface, audio, or future tile
payloads into the root document.

## Identity and Revisions

- IDs survive title/name changes.
- Titles and localized labels are presentation, never foreign keys.
- `surface_revision` invalidates physical/render consumers after edits.
- Planet revisions and detail patch checksums define shared world provenance.
- River graph revision defines centreline/topology compatibility.
- Recipe revisions preserve old generation semantics.

## Migration Rules

1. Add `serde(default)` for compatible optional data.
2. Use an explicit migration when a default cannot preserve meaning.
3. Never regenerate legacy geology or terrain merely because a new field is
   absent.
4. Reconstruct compatibility views instead of persisting duplicate authority.
5. Test old fixture load, new save, reload, and stable ID/revision behavior.
6. Keep native save-marker acceptance broad enough for previous native engines.

## External Tooling

The container is intentionally simple enough for external tools to parse, but
the schema is not yet a stable public API. Game integrations should:

- identify entities by stable ID;
- tolerate unknown JSON fields;
- use archive checksums;
- treat Planet/Region physical coordinates as authoritative;
- avoid editing derived fields;
- preserve unrecognized blobs during a round trip.

Before declaring a public SDK, add a machine-readable schema version for the
root model, stable blob media types, migration fixtures, and an explicit
compatibility policy.

## Security Limits

The reader rejects excessive entry counts, names, payload lengths, duplicate
names, checksums, malformed UTF-8, path traversal, unsupported versions, and
trailing bytes. Keep these bounds when changing compression or adding blobs.
