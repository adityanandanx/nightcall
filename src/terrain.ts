// Quantized-Mesh-1.0 decoder for terrain.reearth.land tiles.
// Spec: https://github.com/CesiumGS/quantized-mesh
// See research/quantized-mesh-format/FINDINGS.md for the full byte-level map.

export interface DecodedTile {
  vertexCount: number;
  triangleCount: number;
  // decoded u/v/height in [0..32767]
  u: Uint16Array;
  v: Uint16Array;
  height: Uint16Array;
  // triangle indices (already high-water-mark decoded), length = triangleCount*3
  indices: Uint32Array;
  // edge vertex index lists
  westIndices: Uint32Array;
  southIndices: Uint32Array;
  eastIndices: Uint32Array;
  northIndices: Uint32Array;
  header: {
    center: [number, number, number];
    minHeight: number;
    maxHeight: number;
    boundingSphereCenter: [number, number, number];
    boundingSphereRadius: number;
    horizonOcclusionPoint: [number, number, number];
  };
  // optional extensions
  octNormals?: Uint8Array; // length 2*vertexCount
  waterMask?: Uint8Array; // 1 byte or 65536 bytes
}

function zigZagDecode(value: number): number {
  return (value >> 1) ^ -(value & 1);
}

export function decodeTerrain(buffer: ArrayBuffer): DecodedTile {
  const dv = new DataView(buffer);
  let offset = 0;

  const rd = (size: number) => {
    const v = dv.getFloat64(offset, true);
    offset += size;
    return v;
  };

  // 88-byte header
  const center = [rd(8), rd(8), rd(8)] as [number, number, number];
  const minHeight = dv.getFloat32(offset, true); offset += 4;
  const maxHeight = dv.getFloat32(offset, true); offset += 4;
  const bSphereCenter = [rd(8), rd(8), rd(8)] as [number, number, number];
  const boundingSphereRadius = rd(8);
  const horizonOcclusionPoint = [rd(8), rd(8), rd(8)] as [number, number, number];

  const vertexCount = dv.getUint32(offset, true); offset += 4;
  const u16 = new Uint16Array(vertexCount);
  const v16 = new Uint16Array(vertexCount);
  const h16 = new Uint16Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) u16[i] = dv.getUint16(offset + i * 2, true);
  offset += vertexCount * 2;
  for (let i = 0; i < vertexCount; i++) v16[i] = dv.getUint16(offset + i * 2, true);
  offset += vertexCount * 2;
  for (let i = 0; i < vertexCount; i++) h16[i] = dv.getUint16(offset + i * 2, true);
  offset += vertexCount * 2;

  // zig-zag decode cumulative
  let u = 0, v = 0, h = 0;
  for (let i = 0; i < vertexCount; i++) {
    u += zigZagDecode(u16[i]); v += zigZagDecode(v16[i]); h += zigZagDecode(h16[i]);
    u16[i] = u; v16[i] = v; h16[i] = h;
  }

  // index data; byte-align to 2 (16-bit) or 4 (32-bit)
  const is32 = vertexCount > 65536;
  const align = is32 ? 4 : 2;
  const pad = (((offset + align - 1) & ~(align - 1)) - offset);
  offset += pad;
  const indexWidth = is32 ? 4 : 2;
  const triangleCount = dv.getUint32(offset, true); offset += 4;
  const rawCount = triangleCount * 3;
  const raw = is32 ? new Uint32Array(rawCount) : new Uint16Array(rawCount);
  for (let i = 0; i < rawCount; i++) {
    raw[i] = is32 ? dv.getUint32(offset, true) : dv.getUint16(offset, true);
    offset += indexWidth;
  }
  // high-water-mark decode
  const indices = new Uint32Array(rawCount);
  let highest = 0;
  for (let i = 0; i < rawCount; i++) {
    const code = raw[i];
    indices[i] = highest - code;
    if (code === 0) highest++;
  }

  // edge lists
  const readEdge = (): Uint32Array => {
    const n = dv.getUint32(offset, true); offset += 4;
    const arr = new Uint32Array(n);
    for (let i = 0; i < n; i++) { arr[i] = is32 ? dv.getUint32(offset, true) : dv.getUint16(offset, true); offset += indexWidth; }
    return arr;
  };
  const westIndices = readEdge();
  const southIndices = readEdge();
  const eastIndices = readEdge();
  const northIndices = readEdge();

  // extensions
  let octNormals: Uint8Array | undefined;
  let waterMask: Uint8Array | undefined;
  while (offset + 5 <= buffer.byteLength) {
    const extId = dv.getUint8(offset); offset += 1;
    const extLen = dv.getUint32(offset, true); offset += 4;
    if (offset + extLen > buffer.byteLength) break;
    if (extId === 1) {
      octNormals = new Uint8Array(buffer, offset, extLen);
    } else if (extId === 2) {
      waterMask = new Uint8Array(buffer, offset, extLen);
    }
    offset += extLen;
  }

  return {
    vertexCount, triangleCount, u: u16, v: v16, height: h16, indices,
    westIndices, southIndices, eastIndices, northIndices,
    header: { center, minHeight, maxHeight, boundingSphereCenter: bSphereCenter, boundingSphereRadius, horizonOcclusionPoint },
    octNormals, waterMask,
  };
}

// --- WGS84 geodetic -> ECEF (research/ellipsoid-math/FINDINGS.md) ---
export const WGS84_A = 6378137.0;
export const WGS84_B = 6356752.3142451793;
const E2 = 1 - (WGS84_B * WGS84_B) / (WGS84_A * WGS84_A);

export function geodeticToECEF(lonDeg: number, latDeg: number, h: number): [number, number, number] {
  const lon = (lonDeg * Math.PI) / 180;
  const lat = (latDeg * Math.PI) / 180;
  const N = WGS84_A / Math.sqrt(1 - E2 * Math.sin(lat) ** 2);
  return [
    (N + h) * Math.cos(lat) * Math.cos(lon),
    (N + h) * Math.cos(lat) * Math.sin(lon),
    (N * (WGS84_B * WGS84_B) / (WGS84_A * WGS84_A) + h) * Math.sin(lat),
  ];
}

// Tile bounds from TMS x/y/z (EPSG:4326, y bottom-up).
// Verified layer.json: z=0 is 2x1 tiles -> lonStep=360/2^(z+1), latStep=180/2^z.
export function geodeticTileBounds(z: number, x: number, y: number) {
  const lonStep = 360 / 2 ** (z + 1);
  const latStep = 180 / 2 ** z;
  const west = -180 + x * lonStep;
  const east = -180 + (x + 1) * lonStep;
  const south = -90 + y * latStep;
  const north = -90 + (y + 1) * latStep;
  return { west, east, south, north };
}

export const TILE_URL = (z: number, x: number, y: number, datum = "ellipsoid") =>
  `https://terrain.reearth.land/cesium-mesh/${datum}/${z}/${x}/${y}.terrain`;

export const TILE_ACCEPT = "application/vnd.quantized-mesh;extensions=octvertexnormals-watermask";

export async function fetchTerrainTile(z: number, x: number, y: number, datum = "ellipsoid") {
  const res = await fetch(TILE_URL(z, x, y, datum), { headers: { Accept: TILE_ACCEPT } });
  if (!res.ok) throw new Error(`tile ${z}/${x}/${y}: HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  return decodeTerrain(buf);
}
