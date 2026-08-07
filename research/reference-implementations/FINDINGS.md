# Crack-free quadtree terrain LOD on a globe — reference implementations

Part of work for [nightcall #1](https://github.com/adityanandanx/nightcall/issues/1) · [research ticket #4](https://github.com/adityanandanx/nightcall/issues/4).
Scope: how mature WEBGL/three.js/react-three-fiber/Cesium engines do **crack-free quadtree
terrain LOD on a globe**, and what that implies for our engine's architecture
(decode → tile cache → LOD selector → geometry builder → R3F meshes).

Nightcall draws a React-three-fiber globe that streams **quantized-mesh-1.0** terrain tiles from
the [reearth/reearth-terrain](https://github.com/reearth/reearth-terrain) service. So the
references below are biased toward quantized-mesh / Cesium-style tiling, not raw WebMercator
heightmap demos.

---

## Shortlist

### 1. CesiumJS — the canonical algorithm everyone else copies
- `GlobeSurfaceTileProvider.js`: https://github.com/CesiumGS/cesium/blob/main/packages/engine/Source/Scene/GlobeSurfaceTileProvider.js
- `QuadtreePrimitive.js`: https://github.com/CesiumGS/cesium/blob/main/packages/engine/Source/Scene/QuadtreePrimitive.js
- `GlobeSurfaceTile.js`: https://github.com/CesiumGS/cesium/blob/main/packages/engine/Source/Scene/GlobeSurfaceTile.js
- `EllipsoidalOccluder.js`: https://github.com/CesiumGS/cesium/blob/main/packages/engine/Source/Core/EllipsoidalOccluder.js
- geometric-error helpers: `TerrainProvider.js` / `EllipsoidTerrainProvider.js` in `packages/engine/Source/Core/`
  (cited directly by Navara's `geometric_error.rs`).

**Lesson.** Cesium is the reference you should *read, not reimplement wholesale*: it is a single
massive monolith (provider + quadtree + tile + imagery are deeply interwoven), but it owns the
four load-bearing ideas. (a) **SSE metric** — the per-level screen-space error is the exact,
reproducible formula
`error = (maxGeometricError[level] * drawingBufferHeight) / (distanceToTile * sseDenominator)`,
minus `fog(distance,density)*fog.sse`, then `/pixelRatio`
(`screenSpaceError()` in `QuadtreePrimitive.js`). `maxGeometricError[level] =
getLevelMaximumGeometricError(level)`, i.e. level-0 error halved per level. (b) **Three-stage
visibility** — `computeTileVisibility()` orders checks as: distance+fog → bounding volume
(tile bounding region / sphere) against the culling volume → horizon occlusion via
`EllipsoidalOccluder` (because for a globe, frustum culling alone lets you stream
terrain that's around the far side). (c) **Tile lifecycle + queues** — `loadTile()` /
`beginUpdate()`/`endUpdate()`, a high/medium/low **load queue**, and a
`TileReplacementQueue` trimmed to `tileCacheSize`. (d) **Load priority** in
`computeTileLoadPriority()` = `(1 - dot(tileDir, cameraDir)) * distance`, so near, screen-centred
tiles win. It also renders tiles grouped by `readyTextureCount` to de-prioritize imagery
draping, letting geometry appear before any texture loads.

**Crack-free mechanism:** terrain meshes are children **up-sampled from the parent tile's
mesh**, not simply decoded at higher resolution, so each child reuses the exact shared interior-
parent vertices that already lie on the parent's boundary — guaranteeing matched edges.

---

### 2. Navara / `@navaramap/three` (Re:Earth) — the closest R3F/WASM pilot for our stack
- npm package: https://www.npmjs.com/package/@navaramap/three (0.0.5, MIT/Apache-2.0); repo
  directory `web/navara_three` of https://github.com/reearth/navara — the published tarball
  ships full `src/` TS + the Rust-compiled WASM core.
- Rust terrain core (the "don't reinvent" source of truth):
  - `crates/navara_core/src/terrain/geometric_error.rs` — ports the Cesium level-zero geodetic formula; scheme-aware (#root tiles for GEO vs WM).
  - `crates/navara_tile/src/tile/traverse.rs` — full terrain traversal (frustum + horizon cull, SSE, swap, prefetch).
  - `crates/navara_geometry/src/terrain/skirt.rs` — separate skirt geometry.
  - `crates/navara_geometry/src/terrain/upsample/mod.rs` + `upsample/clip.rs` — crack-free child up-sampling.
- TS-side tiles / draping: `src/tasks/constructTerrainMesh.ts`, `src/tasks/upsampleTerrainMesh.ts`,
  `src/event/tile.ts`, `src/event/tileHandler.ts`, `src/mesh/tile/{raster,vector,}DrapeResolver.ts`.

**Lesson.** Navarra is the closest analog to what we want and it is the single most transferable
read for Nightcall because it is *the Re:Earth terrain stack* already in our ecosystem: it renders
exactly the tiles `reearth-terrain` serves. Its decomposition is worth stealing: a **Rust WASM
crate (`@navaramap/core`) owns the heavy math** (tiling scheme, quadtree traversal + SSE,
geometric-error, skirt, upsampling, watermask, geometry construction) and the **TypeScript layer
owns the renderer-facing lifecycle** (tile handlers, mesh material, imagery draping, texture
compositing). Geometry construction runs on a **worker** (`queueTask("constructTerrainMesh", …)`)
and returns typed arrays by transfer.

Three specifics worth copying directly:
- `geometric_error.rs` ports Cesium's `get_estimated_level_zero_geometric_error_for_a_heightmap`
  and is copy-paste-ready; note the GEO-vs-WM root-count correction.
- `upsample/mod.rs` implements Cesium's child-from-parent up-sampling by **2D triangle clipping**
  against the child's U/V thresholds (0.5/0.5), then re-`construct_polygon`, merging coincident
  split-edge vertices via a `ClippedCoordMap` so the child reuses the parent's edge vertices —
  that vertex canonicity is what makes it crack-free, not skirts.
- `skirt.rs` generates skirts as **separate geometry** (boundary edges found by counting
  undirected edges that appear in exactly one triangle), dropped along a per-vertex geocentric
  "down" vector by `skirt_height`, sharing the boundary vertices' UVs/normals. Keeping skirts
  separate lets them be excluded from e.g. shadow passes and normals.

Its traversal in `traverse.rs` also shows modern frontier blood — an explicit
`MAX_LEVELS_WITHOUT_RENDERABLE_ANCESTOR` bound to keep a renderable ancestor within N levels
**(prevents the classic pop when a faster-deep subtree's ancestors are still loading)**, a
two-stage **prefetch** of horizon-occluded tiles (fetch DEM low-priority, then build an *inactive*
mesh so swap only climbs to a PREPARED ancestor), `visited_at` frame stamps as the cache liveness
signal, and a `cacheBytes`-style memory budget (`cacheBytes` in `@navaramap/three` types mirrors
Cesium tileset cache bytes).

**What to avoid:** it's a full ECS (Bevy) engine, not an R3F component — don't adopt its systems;
adopt the four algorithms and the WASM-worker split.

---

### 3. `3DTilesRendererJS` by NASA-AMMOS (three.js + Babylon + official r3f wrapper)
Repo: https://github.com/NASA-AMMOS/3DTilesRendererJS (2413★, "Renderer for 3D Tiles in
Javascript using three.js, Babylon.js, and r3f").
- `src/core/renderer/tiles/traverseFunctions.js`
- `src/core/renderer/tiles/TilesRendererBase.js`, `src/three/renderer/tiles/TilesRenderer.js`
- `src/r3f/` — official React Three Fiber wrapper.

**Lesson.** This is the best *three.js-native* traversal to read for R3F because it is the
only widely-used one that already speaks our object language (it powers several three.js
planet/3D-Tiles stacks and ships an official `src/r3f` binding). Its Cesium-like traversal is
just three functions in `traverseFunctions.js`: `canTraverse(tile)` refuses to refine further
when `tile.traversal.error <= renderer.errorTarget` (plus `maxDepth` and
children-not-yet-processed early-outs); `markUsedTiles` / `markVisibleTiles` recursively mark
which tiles are live this frame; and `toggleTiles` group-switches meshes on/off. Its
`TilesRendererBase` owns the fetch→dispose lifecycle, tile marking, and the `errorTarget` knob,
and it keeps a Cesium-style tile-replacement trim policy. Reusable as *reference* for our R3F
group-based tile toggling and cache trim; **must-own (not copy)** the Tiles-specific asset
pipeline (b3dm, glTF, i3dm …) — it drags in far more than the terrain quadtree we need.

---

### 4. Takram `@takram/three-geospatial` (three.js + R3F geospatial core)
Repo: https://github.com/takram-design-engineering/three-geospatial (1587★).
Packages: `packages/core/src/{Ellipsoid.ts, EllipsoidGeometry.ts, Geodetic.ts, TileCoordinate.ts,
TilingScheme.ts, Rectangle.ts}`; r3f snaps in `packages/core/src/r3f/{EllipsoidMesh.tsx,
EastNorthUpFrame.tsx}`.

**Lesson.** When we drape tiles on a WGS84 ellipsoid we inevitably re-derive half a geospatial
core (ellipsoid geodesics, `TileCoordinate`, `TilingScheme`, an `EastNorthUpFrame`). Takram
provides a clean, small, MIT reference to mirror our types on rather
than re-inventing. It is not a terrain LOD engine per se (that's `3DTilesRenderer`
on top), so use it as the **foundation reference for the geometry-builder's ellipsoid plumbing**,
not for LOD selection. Also shows how to expose geospatial maths as R3F components.

---

### 5. heremaps/quantized-mesh-viewer — reference decoder & Cesium/three debugger
Repo: https://github.com/heremaps/quantized-mesh-viewer (render + debug quantized mesh tiles in CesiumJS / THREE debugger).
`example-tiles/*.terrain` present in-tree.

**Lesson.** Nightcall's geometry builder *is* a quantized-mesh-1.0 decoder, so a dedicated
decoder+viewer is a legit read for the byte-level format (header, uvs, indices, skirt, extension
blocks: `watermask`, `metadata`, `vao`). Its value is **as a cross-check harness** for our
`decode` module: pair it against our own decoder on identical tiles to catch bit-level bugs that
the LOD/normal-sampler layer would otherwise smear into "the seams look slightly wrong". Reusable
as a test oracle for the `decode` stage; not an architecture reference.

---

### What to *avoid* (not crack-free globe-terrain LOD)
- **three-globe / react-globe.gl** — https://github.com/vasturiano/three-globe ·
  https://github.com/vasturiano/react-globe.gl. Solid for points/arcs/POIs + a *texture-look*,
  but no view-dependent terrain elevation and no quadtree; it can't be a LOD reference — only its
  atmosphere/globe-mesh wiring is worth a glance.
- **glify** — https://github.com/visgl/glify. Vector-tile layer management for a flat/globe map in
  three, not terrain elevation LOD.
- **Generic "three.js quadtree heightmap terrain" tutorials** (flat square-gridded, planar
  WebMercator tiles) — they usually "solve" cracks by adding skirts rather than by edge-matched
  upsampling, and don't handle horizon culling or the ellipsoid mapping. Useful for the *LOD
  dispatch loop* only.

---

## Recommended architecture for Nightcall's engine

**Guiding principles from the shortlist**
1. **Crack-freedom comes from edge-matched upsampling, not from skirts.** A child tile that is a
   *clipped, interpolated subset of its parent* shares the parent's boundary vertices exactly
   (merge split-edge vertices through one index cache). Skirts only hide remaining T-joints at
   tile eviction T-junctions (they cover vertical cracks, not lateral discontinuities) — keep them as separate
   geometry.
2. **LOD is a single numeric metric + a traversal.** SSE = `maxGeometricError[level] *
   viewportHeight / (distance * sseDenominator)`, with fog distance relaxation and a
   per-level geometric error halving. Everything else (culls, horizons, priorities) feeds that
   one metric.
3. **Four culling/selection gates, in order:** fog/distance → tile bounding volume → horizon
   occlusion (ellipsoid) → SSE (refine only when children are available).
4. **Lifecycle is queue-based with an ancestor-priority bound** to dodge low-res-parent flash;
   a `replacement/trim` budget caps GPU memory; old frames' unused tiles are reclaimed.

**Proposed module split** (`src/terrain/`):
```
decode/            # quantized-mesh-1.0 parser → { positions, uvs, indices, bounds, watermask }, on a Worker
tile-cache/        # LRU + per-frame visited stamp; byte budget (cacheBytes); keyed by {scheme,z,x,y}
lod-selector/      # pure function over camera: visibility passes + SSE + refine/load/skip decisions;
                   # produces a render list + a high/medium/low load-priority queue
geometry-builder/  # ellipsoid → ECEF meshes, per-tile RTC offset (center), upsampling to merge edges,
                   # separate skirt geometry, normals (CPU or Martini RTIN), watermask
drape/             # per-tile raster + optional vector texture atlas; deferred until geometry exists
threeLayer/        # R3F: <Terrain> maps tile cache → <mesh>; pooled BufferAttribute, dispose on evict
```
Ownership/reuse guidance:
- Copy: **SSE formula + geometric-error estimation** (`navara geometric_error.rs`, Cesium
  `screenSpaceError`), **upsample-clip algorithm**, **separate-skirt builder** — these are
  compact and battle-tested.
- Read-and-reuse mechanics: **Cesium tile lifecycle + load queue + replacement queue**,
  **Navara's traversal (`MAX_LEVELS_WITHOUT_RENDERABLE_ANCESTOR`, occluded prefetch)**.
- **Tiling scheme / ellipsoid ECEF plumbing**: mirror `@takram/three-geospatial`'s `core` types.
- **Decoder**: own it, but verify against `heremaps/quantized-mesh-viewer`.
- **Do NOT**: pull in a full 3D-Tiles /glTF loader asset pipeline, or make the DOM/mesh layer
  also do LOD math — everything must flow through the single metric.

Imagery draping:  
Drape imagery lazily. Do it like Navara's `rasterDrapeResolver`/`vectorDrapeResolver` +
Cesium's `readyTextureCount` grouping: request imagery only for tiles that have a *rendered
mesh*, allow geometry to render before texture (one LOD level LODed), and stop refining once the
raster zoom would exceed the tile's resolution (Navara's `calc_meters_per_texel` / `wm_zoom_for_lng_span`).

---

Primary sources checked: CesiumJS repo (main), reearth/navara (`crates/*`, `web/` + npm
`@navaramap/three@0.0.5` tarball), NASA-AMMOS/3DTilesRendererJS, takram-design-engineering/three-geospatial,
heremaps/quantized-mesh-viewer, reearth/reearth-terrain.
