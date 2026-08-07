# WGS84 ellipsoid math: placing geographic terrain tiles on a Three.js globe

Ticket: https://github.com/adityanandanx/nightcall/issues/3
Researched by: /research subagent, using the reearth-terrain viewer, the
`@navaramap/*` (Navara) npm packages (0.0.5), CesiumJS source, and live
`layer.json` probes against `terrain.reearth.land`.

## TL;DR

1. A globe renderer draws the planet as the **WGS84 ellipsoid**. Every terrain
   vertex is converted from **geodetic (lon, lat, ellipsoidal height)** to
   **ECEF cartesian (x, y, z) in meters**, and those ECEF positions are used
   directly as Three.js world positions. There is no projected plane anywhere
   in the globe path.
2. Quantized-mesh tiles from `terrain.reearth.land` use a **Geographic/TMS
   tiling scheme in EPSG:4326**: z=0 is 2×1 tiles, z=N has 2^(N+1)×2^N tiles,
   y is **bottom-up** (y=0 is the southernmost row). The tile's lon/lat bounds
   follow directly from x/y/z (formula below).
3. The three datums are: `ellipsoid` = DEM + EGM2008 geoid undulation
   (height above the WGS84 ellipsoid — **what a globe renders by default**),
   `elevation` = orthometric height (above mean sea level), `geoid` = the
   undulation alone. `ellipsoid = elevation + geoid`.
4. Scene scale is **real meters**: ECEF coordinates are in meters and the
   camera lives at ellipsoid height in meters (min zoom ≈ b ≈ 6.36e6 m, max
   zoom ≈ 10b). Do not rescale to "unit sphere" coordinates unless you apply
   the same scale to every position, normal, and camera.
5. Seamless tiling at every zoom falls out of three invariants: identical
   geodetic grid math on shared edges, a single shared height datum, and
   **skirts** (downward strips along the ellipsoid normal) that hide any
   residual T-junction cracks.

## 1. The WGS84 ellipsoid

```js
const A = 6378137.0;               // semi-major axis (equatorial radius), m
const F = 1 / 298.257223563;       // flattening
const B = A * (1 - F);             // semi-minor axis (polar radius), m
// B === 6356752.3142451793
const E2 = 1 - (B * B) / (A * A);  // first eccentricity squared ≈ 6.69437999014e-3
```

Cesium hardcodes exactly these radii
(`Ellipsoid.WGS84 = Object.freeze(new Ellipsoid(6378137.0, 6378137.0, 6356752.3142451793))`),
and Navara's engine constants (`WGS84_B_64` ≈ 6,356,752 m) match the same
values — see sources at the end.

## 2. Geodetic → ECEF (the one function you need)

Height `h` is **along the geodetic surface normal** (perpendicular to the
ellipsoid surface at the point), not radial. This is what makes the globe
"work": 0 m height lands exactly on the ellipsoid, and positive heights
(terrain, buildings, satellites) sit correctly above it.

Cesium's `Ellipsoid.cartographicToCartesian` vector form
(`packages/engine/Source/Core/Ellipsoid.js`):

```js
// lon, lat in RADIANS; h in meters above the ellipsoid
function geodeticToECEF(lon, lat, h) {
  const cosLat = Math.cos(lat), sinLat = Math.sin(lat);
  // geodetic surface normal (unit vector; cosLat*cosLon, cosLat*sinLon, sinLat
  // is already unit length, Cesium normalizes it anyway)
  const nx = cosLat * Math.cos(lon);
  const ny = cosLat * Math.sin(lon);
  const nz = sinLat;

  // k = radiiSquared * n  (component-wise)
  const kx = A * A * nx;
  const ky = A * A * ny;
  const kz = B * B * nz;

  const gamma = Math.sqrt(nx * kx + ny * ky + nz * kz);
  const sx = kx / gamma, sy = ky / gamma, sz = kz / gamma; // surface point

  return { x: sx + h * nx, y: sy + h * ny, z: sz + h * nz };
}
```

Equivalent classic closed form (standard geodesy; `N` = prime-vertical radius
of curvature):

```js
function geodeticToECEF(lon, lat, h) {
  const N = A / Math.sqrt(1 - E2 * Math.sin(lat) ** 2);
  return {
    x: (N + h) * Math.cos(lat) * Math.cos(lon),
    y: (N + h) * Math.cos(lat) * Math.sin(lon),
    z: (N * (B * B) / (A * A) + h) * Math.sin(lat),
  };
}
```

Both are identical. Result is in meters; |xyz| ranges from b ≈ 6,356,752 m
(poles) to a ≈ 6,378,137 m (equator) for h=0. **Use this function for every
vertex** — do not place tiles by "radius × unit direction" using a single
sphere radius, or the ellipsoid's flattening (~21 km pole dip) vanishes and
adjacent latitude rows stop matching the shared edges.

## 3. Tile bounds from TMS x/y/z

Confirmed by the live layer.json
(https://terrain.reearth.land/cesium-mesh/ellipsoid/layer.json → `scheme: tms`,
`projection: EPSG:4326`, `format: quantized-mesh-1.0`, maxzoom 14, `available`
= full 2^(z+1)×2^z rectangles per level) and by the worker that serves it,
`reearth-terrain/src/cesium.ts`:

```js
function geodeticTileBounds(z, x, y) {
  const lonStep = 360 / 2 ** (z + 1);   // deg
  const latStep = 180 / 2 ** z;         // deg
  const west = -180 + x * lonStep;
  const south = -90 + y * latStep;
  return { west, east: west + lonStep, south, north: south + latStep };
}
```

Notes:
- z=0: lonStep=180, latStep=180 → two tiles: [−180..0] and [0..180], each the
  full [−90..90] latitude band.
- `y` is **TMS (bottom-up)**. xyz tile URLs are `/{z}/{x}/{y}.terrain` with
  this same y. Web-Mercator XYZ y is inverted — do not reuse XYZ y here.
- The tiles do **not** follow a power-of-two-per-axis square: longitude has
  twice as many tiles as latitude at every level.

Corner positions on the ellipsoid (the "tile footprint" you would render if
you only had the bounds):

```js
function tileCornersECEF(z, x, y, h = 0) {
  const b = geodeticTileBounds(z, x, y);
  const d2r = Math.PI / 180;
  const c = (lon, lat) => geodeticToECEF(lon * d2r, lat * d2r, h);
  return {
    sw: c(b.west, b.south), se: c(b.east, b.south),
    nw: c(b.west, b.north), ne: c(b.east, b.north),
  };
}
```

## 4. Placing a decoded quantized-mesh tile

A quantized-mesh tile carries, per vertex, a quantized height (0..32767) plus
per-tile `minimumHeight`/`maximumHeight` (meters above the ellipsoid), and
normalized grid coordinates. Decode, then push through `geodeticToECEF`:

```js
// per-tile header values from the .terrain buffer
const { minimumHeight, maximumHeight, west, south, east, north } = tileHeader;
const hSpan = maximumHeight - minimumHeight;

for (let i = 0; i < vertexCount; i++) {
  const u = uBuffer[i] / 32767;            // 0 = west edge, 1 = east edge
  const v = vBuffer[i] / 32767;            // 0 = south edge, 1 = north edge
  const h = minimumHeight + (hBuffer[i] / 32767) * hSpan; // meters above ellipsoid

  const lon = (west + u * (east - west)) * DEG2RAD;
  const lat = (south + v * (north - south)) * DEG2RAD;
  const p = geodeticToECEF(lon, lat, h);

  positions[i * 3 + 0] = p.x;              // direct Three.js world coordinates
  positions[i * 3 + 1] = p.y;
  positions[i * 3 + 2] = p.z;
}
const geometry = new THREE.BufferGeometry();
geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
geometry.setIndex(indices);
// geometry.computeVertexNormals() if the tile has no oct-encoded normals
```

Because every vertex on a shared edge is produced by the *same* formula from
the *same* lon/lat values, neighboring tiles agree exactly at their seams —
this is the entire crack-free story, and it holds at every zoom.

If you prefer RTC (relative-to-center), the convention used by
Cesium/Navara in the real engine: subtract the tile-center ECEF position from
every vertex, position the mesh at the center, and (for large tiles) orient it
with a quaternion from the center's ECEF frame to the local east-north-up
frame. For a first Three.js implementation, absolute ECEF positions are
simpler and numerically fine for f64 `Float64Array` (avoid f32 positions —
float32 loses mm precision at 6.4e6 m range; see pitfalls).

### Skirts

Cesium adds a downward "skirt" strip around each tile (vertices duplicated at
`h - skirtHeight` along the geodetic normal, i.e. `geodeticToECEF(lon, lat,
h - skirt)`), so even when adjacent tiles tessellate differently at a shared
edge, the gap is hidden below the surface instead of showing as a crack. If a
decoder gives you skirts (reearth-terrain's worker emits skirt vertices —
Navara's `TileMesh.createSkirtMesh` consumes `mesh.skirt_vertices` /
`skirt_indices`), keep them. Otherwise add them yourself.

## 5. The three datums and the globe default

From the reearth-terrain README
(https://github.com/adityanandanx/reearth-terrain, "Data types" table) and its
`layer.json` descriptions ("Mapterhorn-merged global DEM blended with EGM2008
geoid undulations"):

| data_type | value = | use for |
|---|---|---|
| `ellipsoid` | orthometric DEM + geoid undulation = height above the WGS84 ellipsoid | **globe terrain (Cesium / Navara / Three.js globe) — default** |
| `elevation` | orthometric DEM height (above mean sea level) | MapLibre / MapboxGL, contours, anything assuming MSL |
| `geoid` | EGM2008 geoid undulation only | coordinate conversion, geoid visualization |

Relationships (heights.json example: elevation 12.3, geoid 39.5, ellipsoid
51.8):

```
h_ellipsoid = h_orthometric + N_geoid
```

So on a globe the correct URL is
`https://terrain.reearth.land/cesium-mesh/ellipsoid/{z}/{x}/{y}.terrain` —
which is exactly what the reearth-terrain viewer uses by default: its datum
`<select>` defaults to `ellipsoid` and both the Cesium and Navara renderers
point at `/cesium-mesh/${dt}/` with `dt = "ellipsoid"`. If you render
`elevation` heights on a globe, every point sinks below the ellipsoid by the
(±100 m) undulation; if you render `geoid` alone you get a smooth bumpy
"potato" surface, not terrain. Rendering `ellipsoid` on a globe is the only
choice where the geoid's +N/−N map sits exactly on the ellipsoid and the
average ocean surface lands at the correct radius.

The reearth-terrain worker computes `ellipsoid = DEM + geoid` at tile build
time (`src/cesium.ts` — "Values are in meters above the WGS84 ellipsoid
(orthometric + geoid)"), so the client never does datum math: it just feeds
whatever heights arrive into `geodeticToECEF` with the ellipsoid datum
assumed.

## 6. Scene scale and camera conventions

- **Units are meters.** Cesium and Navara both run the entire scene in ECEF
  meters: tile vertex positions are ECEF meters, the globe center is the
  origin, and the camera flies at ellipsoid height in meters. Navara's camera
  clamps `minimumZoomDistance` to `WGS84_B_64` (≈6,356,752 m, touching the
  surface) and `maximumZoomDistance` to `WGS84_B_64 * 10` (≈63,567,523 m)
  (`@navaramap/engine` wasm d.ts, `Camera` options).
- Three.js has no problem with these magnitudes in f64, but: use
  `Float64Array`/f64 positions (f32 has ~0.5 m error at 6.4e6 m), set the
  camera `near`/`far` to cover ~1 m → ~1e8 m (e.g. near=1, far=2e8 or
  logarithmic depth buffer), and beware depth precision far from the origin
  (logarithmic depth buffer or RTC-style relative rendering helps).
- A "unit sphere" scaled scene (radius 6371 → 1 unit) is only fine if you
  apply the same scale to every coordinate, height, normal, and the camera;
  mixing unit-sphere positions with meter heights is a common bug.
- If your globe mesh only needs a smooth ellipsoid (before/behind terrain),
  generate it from `geodeticToECEF(lon, lat, 0)` at any resolution — don't
  use a sphere of radius `a` or `b`; the flattening matters visually at
  high zoom in high latitudes and for seam matching.

## 7. How Cesium/Navara lay the ellipsoid out (the seamless-tiling recipe)

1. **Tiling**: Geographic/TMS grid in lon/lat (section 3). No Mercator.
2. **Vertex placement**: every vertex decoded to (lon, lat, ellipsoidal
   height) and converted with the identical `geodeticToECEF` — shared edge
   vertices coincide exactly, at every zoom (section 2/4).
3. **Heights in one datum**: a tileset serves one height reference
   (`ellipsoid` for the globe) so the same physical surface point has the
   same height in every tile it appears in.
4. **Skirts** hide T-junction cracks from unequal edge tessellation.
5. **LOD**: z drives tile size; the renderer subdivides by screen-space error
   (Navara `Globe.maxSse` default 2.0, Cesium `maximumScreenSpaceError`),
   and quantized-mesh's `childTileMask` allows upsampling a parent when
   children aren't available.
6. **RTC + local orientation** (optional, used by the production engines):
   big tiles store local vertex offsets plus an ECEF `rtc_translation` (the
   tile center) and a quaternion, so f32 GPU buffers stay numerically sane.
   The math is identical — RTC only changes *where you subtract the center*.

Concretely, in the reearth-terrain viewer the Navara quantized-mesh source is:

```js
navaraView.addSource({
  type: "quantized-mesh",
  url: `https://terrain.reearth.land/cesium-mesh/${dt}/{z}/{x}/{y}.terrain`,
  maxZoom: 18,
  requestVertexNormals: true, // oct-encoded normals
  requestWaterMask: true,
});
```

and Cesium uses `CesiumTerrainProvider.fromUrl(
"https://terrain.reearth.land/cesium-mesh/ellipsoid", { requestVertexNormals,
requestWaterMask })` — both renderers stream the same tiles and lay them on
the same WGS84 ellipsoid.

## Sources

- Ticket: https://github.com/adityanandanx/nightcall/issues/3
- reearth-terrain viewer (Navara + Cesium renderers, datum selector defaulting
  to Ellipsoid): /home/aditya/dev/reearth-terrain/viewer/index.html
  (repo: https://github.com/adityanandanx/reearth-terrain)
- reearth-terrain worker — tiling scheme + datum definitions:
  /home/aditya/dev/reearth-terrain/src/cesium.ts
  (`geodeticTileBounds`, `SampleDataType`, "meters above the WGS84 ellipsoid
  (orthometric + geoid)")
- reearth-terrain README — data-type table (ellipsoid/elevation/geoid) and
  layer.json example: https://github.com/adityanandanx/reearth-terrain#readme
- Live layer.json (ellipsoid; identical tiling for elevation/geoid):
  https://terrain.reearth.land/cesium-mesh/ellipsoid/layer.json
  (format `quantized-mesh-1.0`, scheme `tms`, projection `EPSG:4326`,
  maxzoom 14, extensions `octvertexnormals` + `watermask`)
- Tile URL template:
  https://terrain.reearth.land/cesium-mesh/ellipsoid/{z}/{x}/{y}.terrain
- Cesium `Ellipsoid` — WGS84 radii, `cartographicToCartesian`,
  `geodeticSurfaceNormalCartographic`:
  https://github.com/CesiumGS/cesium/blob/main/packages/engine/Source/Core/Ellipsoid.js
- Cesium `QuantizedMeshTerrainData` — height/vertex decoding contract:
  https://github.com/CesiumGS/cesium/blob/main/packages/engine/Source/Core/QuantizedMeshTerrainData.js
- Navara packages (npm, v0.0.5) — `@navaramap/engine` (wasm; WGS84 constants,
  ECEF camera, EllipsoidGeodesic, RTC `rtc_translation` on terrain meshes),
  `@navaramap/three` (`TileMesh`, `setTransform`):
  https://www.npmjs.com/package/@navaramap/engine
  https://www.npmjs.com/package/@navaramap/three
- WGS84 standard (a, f): NGA, https://earth-info.nga.mil/
- EGM2008 geoid: NGA, https://earth-info.nga.mil/index.php/4_didyouknow2e.html
  (undulation sign: N = h_ellipsoid − H_orthometric, i.e. ellipsoid = elevation + geoid)
