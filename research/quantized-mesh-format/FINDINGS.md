# Quantized-Mesh-1.0 wire format: decoding `terrain.reearth.land` tiles

**Research ticket:** https://github.com/adityanandanx/nightcall/issues/2
**Date:** fetched live from `https://terrain.reearth.land/cesium-mesh/ellipsoid/` on this research run.

## TL;DR

A `.terrain` file from this endpoint is a little-endian binary blob: an **88-byte header** (not 86 —
the task brief had the wrong size), then **vertex data**, **triangle indices**, **edge indices**, and
optionally **extension blocks** (oct-encoded normals, water mask) that are **only included if the
client asks for them via the `Accept` header**. Tiles are served **uncompressed** (no gzip) by this
server, contrary to what the spec says about typical servers. There is no 3D position in the file —
positions are reconstructed by linearly interpolating `u`/`v`/`height` (each 0..32767) across the
tile's geographic bounds and the header's min/max heights, then converting lon/lat/height to ECEF.

## 1. layer.json at the endpoint (primary source)

Fetched from https://terrain.reearth.land/cesium-mesh/ellipsoid/layer.json (HTTP 200, `application/json`):

```json
{
  "tilejson": "2.1.0",
  "format": "quantized-mesh-1.0",
  "version": "5",
  "name": "mapterhorn-egm08 / cesium-mesh / ellipsoid",
  "description": "Mapterhorn-merged global DEM blended with EGM2008 geoid undulations.",
  "scheme": "tms",
  "projection": "EPSG:4326",
  "tiles": ["{z}/{x}/{y}.terrain"],
  "minzoom": 0,
  "maxzoom": 14,
  "bounds": [-180, -90, 180, 90],
  "attribution": "Re:Earth Terrain, Mapterhorn, EGM2008 (NGA), Protomaps, OpenStreetMap",
  "extensions": ["octvertexnormals", "watermask"],
  "available": [ {startX:0, startY:0, endX:1, endY:0}, ..., {startX:0, startY:0, endX:32767, endY:16383} ]
}
```

Key facts:

- **Tiling scheme:** TMS (y=0 at the **south**), global-geodetic **EPSG:4326**.
  - Tile `{z}/{x}/{y}`: x from west, y from south. Per the spec's README, `0/0/0` covers
    `(-180°, -90°)–(0°, 90°)` (the SW quadrant) — verified: its header center is ECEF ≈
    `(0, -6,380,477, 0)` = lon −90°, lat 0°. (Refs: https://github.com/CesiumGS/quantized-mesh#readme,
    layer.json `scheme`/`projection` fields per
    https://github.com/CesiumGS/quantized-mesh/blob/main/SPECIFICATION.md)
  - EPSG:4326 ⇒ 2 root tiles (2×1) at z=0; zoom 0..14 with `available` ranges confirming a full
    quadtree: z=14 → x∈[0,32767], y∈[0,16383] (32768×16384).
- **Zoom range:** minzoom 0, maxzoom 14 (layer.json; maxzoom is the only required field per SPECIFICATION.md).
- **Extensions advertised:** `octvertexnormals` (id 1) and `watermask` (id 2).
- **URL template:** `https://terrain.reearth.land/cesium-mesh/ellipsoid/{z}/{x}/{y}.terrain`.

## 2. Byte-level field map (primary source: https://github.com/CesiumGS/quantized-mesh#readme)

All little-endian. "Double" = IEEE-754 float64, "Float" = float32, "uint" = unsigned integer.

### 2.1 Header — 88 bytes (offsets 0..87)

The spec's C++ struct is: `Center` (3 doubles), `MinimumHeight`/`MaximumHeight` (2 floats),
`BoundingSphereCenter` (3 doubles), `BoundingSphereRadius` (double), `HorizonOcclusionPoint` (3 doubles).
Note the field order: **min/max height sits between Center and BoundingSphere**.

| Offset | Size | Type | Field | Meaning |
|---|---|---|---|---|
| 0 | 24 | double ×3 | `CenterX/Y/Z` | Tile center in **Earth-Centered Fixed (ECEF)** coordinates, meters |
| 24 | 8 | float ×2 | `MinimumHeight`, `MaximumHeight` | Height range of tile in meters (may be wider than any vertex's height, e.g. after mesh simplification) |
| 32 | 24 | double ×3 | `BoundingSphereCenterX/Y/Z` | Bounding sphere center, ECEF, meters |
| 56 | 8 | double | `BoundingSphereRadius` | Bounding sphere radius, meters |
| 64 | 24 | double ×3 | `HorizonOcclusionPointX/Y/Z` | Horizon occlusion point in the **ellipsoid-scaled** ECEF frame (for horizon culling; `http://cesiumjs.org/2013/04/25/Horizon-culling/`) |

Total: **88 bytes**. (The task brief said 86 — that is wrong for this spec version; 24+8+24+8+24 = 88.)

Measured root tile `0/0/0` (75,134 bytes): center ≈ (3.9e-10, −6,380,477.58, 0.0) → lon −90°, lat 0°;
minH −65.06 m, maxH 4746.23 m; bounding sphere radius 9,025,059 m (covers the hemisphere tile).

### 2.2 Vertex data (offset 88 …)

```
uint32 vertexCount;
uint16 u[vertexCount];     // delta + zig-zag encoded
uint16 v[vertexCount];     // delta + zig-zag encoded
uint16 height[vertexCount];// delta + zig-zag encoded
```

Decode (verbatim from spec):

```js
let u = 0, v = 0, height = 0;
function zigZagDecode(value) { return (value >> 1) ^ (-(value & 1)); }
for (i = 0; i < vertexCount; ++i) {
    u += zigZagDecode(uBuffer[i]);
    v += zigZagDecode(vBuffer[i]);
    height += zigZagDecode(heightBuffer[i]);
    uBuffer[i] = u; vBuffer[i] = v; heightBuffer[i] = height;
}
```

Meaning of decoded values (each 0..32767):

- `u = 0` → west edge, `u = 32767` → east edge; longitude is linear interpolation between tile's west/east edge longitudes.
- `v = 0` → south edge, `v = 32767` → north edge; latitude is linear interpolation between south/north edge latitudes.
- `height = 0` → `MinimumHeight`, `height = 32767` → `MaximumHeight`; linear interpolation in between.

Verified on `0/0/0` (vertexCount 4225 = 65×65): decoded u/v/h ranges are exactly 0..32767, and a vertex with
u=16384 maps to lon ≈ −89.9973°, lat ≈ 0.0027° (west=−180 + 16384/32767·180).

### 2.3 Index data (after vertex data)

Byte-alignment padding: the spec says padding is added before `IndexData` to ensure 2-byte alignment for
`IndexData16` and 4-byte alignment for `IndexData32`. (In practice on this server, vertex data ends
4-byte aligned naturally: 4 + 6·vertexCount is divisible by 4 when vertexCount is even, and observed counts
were even.)

```
IndexData16: uint32 triangleCount; uint16 indices[triangleCount*3];   // when vertexCount <= 65536
IndexData32: uint32 triangleCount; uint32 indices[triangleCount*3];   // when vertexCount > 65536
```

Indices use **high-water-mark encoding** (from webgl-loader), decode:

```js
let highest = 0;
for (let i = 0; i < indices.length; ++i) {
    const code = indices[i];
    indices[i] = highest - code;
    if (code === 0) ++highest;
}
```

Each triplet = one triangle in **counter-clockwise winding order** (as seen from outside).
Verified on root tile: triangleCount 8192 (= 64×64×2), decoded indices in range 0..4224 (< vertexCount 4225).

### 2.4 Edge indices (after triangle indices)

```
uint32 westVertexCount;  uint16|uint32 westIndices[westVertexCount];
uint32 southVertexCount; uint16|uint32 southIndices[southVertexCount];
uint32 eastVertexCount;  uint16|uint32 eastIndices[eastVertexCount];
uint32 northVertexCount; uint16|uint32 northIndices[northVertexCount];
```

Same element width as the triangle indices. These list which vertices lie on each tile edge — used to add
skirts to hide cracks between adjacent LODs. Verified on root tile: 4 × 65 entries (each edge is a full 65-vertex row).

### 2.5 Extensions (only present when requested; after edge indices)

Extension blocks are appended in server-chosen order. Each block:

```
uint8  extensionId;
uint32 extensionLength;   // length of the extension DATA that follows (excludes this 5-byte header)
<extensionLength bytes of data>
```

| id | Name | Requested via Accept header | Data |
|---|---|---|---|
| 1 | Oct-encoded per-vertex normals | `extensions=octvertexnormals` (legacy name `vertexnormals` is deprecated) | `uint8 xy[vertexCount*2]` |
| 2 | Water mask | `extensions=watermask` | 1 byte if tile is all-land/all-water, else `uint8[65536]` (256×256) |
| 4 | Metadata | `extensions=metadata` | `uint32 jsonLength; char json[jsonLength]` |

Multiple extensions: `Accept: application/vnd.quantized-mesh;extensions=octvertexnormals-watermask`.

**Oct normal decode** — each normal is 2 bytes (unsigned), decoded with the signed octahedral encoding
(Cesium `AttributeCompression.octDecode` = `octDecodeInRange(x, y, 255, result)`):

```js
// fromSNorm(n, 255) = n/255*2 - 1
x = fromSNorm(b0, 255); y = fromSNorm(b1, 255);
z = 1.0 - (Math.abs(x) + Math.abs(y));
if (z < 0.0) {                       // reproject out-of-octahedron points
    const ox = x;
    x = (1.0 - Math.abs(y)) * (ox >= 0 ? 1 : -1);
    y = (1.0 - Math.abs(ox)) * (y >= 0 ? 1 : -1);
    z = 1.0 - (Math.abs(x) + Math.abs(y));
}
normalize(x, y, z);
```

Source: https://github.com/CesiumGS/cesium/blob/main/packages/engine/Source/Core/AttributeCompression.js
(`octDecode` → `octDecodeInRange`), normal-encoding reference: Cigolle et al., "A Survey of Efficient
Representations of Independent Unit Vectors", JCGT 2014, http://jcgt.org/published/0003/02/01/.

**Water mask**: values 0 = land, 255 = water, others allowed for coastline anti-aliasing. Order is
**north-to-south, west-to-east**; first byte = northwest corner. Pitfall: this is the opposite V
orientation of typical image/texture upload conventions — Cesium historically flips the mask vertically
when uploading (see https://github.com/CesiumGS/cesium/blob/main/packages/engine/Source/Core/QuantizedMeshTerrainData.js).

## 3. Live measurements from terrain.reearth.land (all fetched during this research)

Tile used for measurements: `https://terrain.reearth.land/cesium-mesh/ellipsoid/2/2/1.terrain` (vertexCount 4139).

| Request | Result |
|---|---|
| `Accept: application/vnd.quantized-mesh,application/octet-stream;q=0.9` | 73,590 bytes, **no extensions** |
| `Accept: application/vnd.quantized-mesh;extensions=octvertexnormals` | 81,873 bytes = +8,278 (4139×2 normals); ext header `[id=1, len=8278]` |
| `Accept: application/vnd.quantized-mesh;extensions=watermask` | 139,131 bytes = +65,536; ext header `[id=2, len=65536]` (mixed tile → 256×256 mask; unique values {0,255}) |
| `Accept: application/vnd.quantized-mesh;extensions=octvertexnormals-watermask` | 147,414 bytes; two blocks `[id=1,len=8278]` then `[id=2,len=65536]` |
| `?requestVertexNormals=true&requestWaterMask=true` (URL params) | **Same bytes as plain** — this server ignores query params; use the Accept header |
| Any tile, `Content-Encoding` | **None**; magic bytes are NOT `1f 8b` — tiles are served **uncompressed** (gzip optional client-side via Accept-Encoding, but the server does not gzip by default) |

Root tile `0/0/0`: 75,134 bytes, vertexCount 4225, triangleCount 8192, 4×65 edge indices, no extensions.
Ocean tile `8/100/50`: 1,110 bytes, vertexCount 61, triangleCount 96 — small tiles are fine to decode with the same code path.

## 4. Reconstructing 3D positions

For tile `{z,x,y}` with TMS/EPSG:4326, the geographic bounds are:

```js
const n = 2 ** z;
const west  = -180 + (x / n) * 360;
const east  = -180 + ((x + 1) / n) * 360;
const south =  -90 + (y / n) * 180;
const north =  -90 + ((y + 1) / n) * 180;

lon    = west  + (u / 32767) * (east - west);
lat    = south + (v / 32767) * (north - south);
height = minHeight + (h / 32767) * (maxHeight - minHeight);
```

Then geodetic→ECEF with WGS84 (a=6378137, f=1/298.257223563) — the header `Center`/`BoundingSphereCenter`
are in the same ECEF frame, so you can use the bounding sphere for culling and the center for the
ellipsoid-relative math. Verified: reconstructed vertex near the root tile center lands within ~2.4 km of
the header `Center` (expected — header center is a fitted value, not necessarily a mesh vertex; use it for
culling, not as a vertex anchor).

Recommended pipeline for our engine:

1. `fetch(url, { headers: { Accept: "application/vnd.quantized-mesh;extensions=octvertexnormals-watermask" } })`
   (drop `extensions=` if we don't need them; the plain Accept with `application/octet-stream;q=0.9` fallback is the safest baseline).
2. Read with a `DataView` (little-endian) over the `ArrayBuffer` (or `Uint8Array`). **Do not gzip-decompress** for this server.
3. Parse header (88 bytes) → vertexCount → zigzag-decode u/v/height → high-water-mark-decode indices → edge lists → extensions.
4. Optionally validate: max decoded index < vertexCount, and the file offset after the last extension == byteLength.

## 5. Recommended decode approach: hand-rolled reader vs npm decoder

**Recommendation: hand-rolled `DataView` reader (~120–150 lines) rather than pulling in Cesium just for decoding.**

- Cesium's decoder lives in `QuantizedMeshTerrainData` (https://github.com/CesiumGS/cesium/blob/main/packages/engine/Source/Core/QuantizedMeshTerrainData.js)
  but it is tightly coupled to Cesium's `TerrainData`/`TerrainProvider`/`EllipsoidTerrainProvider` machinery,
  `Credit` objects, and `CesiumMath`/`AttributeCompression` imports — importing it standalone drags in a
  large dependency graph and its constructor expects a `TerrainProvider`-shaped options object, not a raw byte array.
  There is no official standalone quantized-mesh decoder npm package.
- Community decoders exist but are thin, often stale, and historically copy the Cesium code verbatim
  (e.g. the algorithm in https://github.com/visgl/loaders.gl/blob/main/modules/terrain/src/lib/parse-quantized-mesh.js).
  Using them saves little over writing the ~5 small decode loops above, and you'd still own the buffer-
  handling glue. The whole format is: 5 decode loops + 1 ECEF conversion. Hand-rolling gives us exact
  control over typed-array output (positions `Float32Array` ECEF, `Uint16Array`/`Uint32Array` indices,
  normals, water mask) and zero dependency risk.
- If we ever adopt Cesium as a rendering dependency anyway, then use its `QuantizedMeshTerrainData` +
  `CesiumTerrainProvider` directly and skip the hand-rolled reader.

## 6. Surprises / pitfalls (summary)

1. **Header is 88 bytes, not 86** (common mis-citation; min/max height floats come *before* the bounding sphere).
2. **This server does not gzip** tiles (no `Content-Encoding`); don't assume the spec's "tiles are served gzipped".
3. **Extensions are opt-in via `Accept` header** (`application/vnd.quantized-mesh;extensions=...`); URL query
   params `requestVertexNormals`/`requestWaterMask` do nothing on this server. Extension id is 1 byte, length
   is 4 bytes (5-byte header), data length excludes the header.
4. **Index data is high-water-mark encoded** (not raw indices) and the count field is `triangleCount`, so the
   array is `triangleCount*3` entries — a common off-by-3 bug.
5. **u/v are 0..32767** (not normalized floats); heights interpolate between header min/max, which may be wider
   than any real vertex (mesh simplification) — good for culling, not exact per-vertex ground truth.
6. **Water mask is north-to-south, west-to-east** — first byte is the NW corner; flip V when uploading as a texture.
7. **Oct normals may appear mirrored** in some engines (TMS-vs-WebGL orientation); if lighting looks inverted,
   negate the decoded Y (verify empirically per-tile).
8. Mid/large tiles are big (root = 75 KB, watermask tile = 139 KB); fetch lazily per LOD and cache decoded meshes.

## Sources

- Quantized-mesh-1.0 spec (header, vertex, index, edge, extension layout): https://github.com/CesiumGS/quantized-mesh#readme
- layer.json format/schema: https://github.com/CesiumGS/quantized-mesh/blob/main/SPECIFICATION.md (+ schema/layer.schema.json in same repo)
- Live layer.json: https://terrain.reearth.land/cesium-mesh/ellipsoid/layer.json
- Live tiles: https://terrain.reearth.land/cesium-mesh/ellipsoid/{z}/{x}/{y}.terrain
- Cesium oct normal decode: https://github.com/CesiumGS/cesium/blob/main/packages/engine/Source/Core/AttributeCompression.js
- Cesium terrain data consumer: https://github.com/CesiumGS/cesium/blob/main/packages/engine/Source/Core/QuantizedMeshTerrainData.js
- Oct encoding paper: Cigolle et al., JCGT 2014, http://jcgt.org/published/0003/02/01/
- Horizon culling: http://cesiumjs.org/2013/04/25/Horizon-culling/
