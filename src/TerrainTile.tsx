// R3F component: render one decoded terrain tile as a mesh on the WGS84 ellipsoid,
// with an optional skirt (crack mitigation for the LOD prototype; research #4).
import { useMemo } from "react";
import * as THREE from "three";
import {
  DecodedTile, geodeticToECEF, geodeticTileBounds,
} from "./terrain";

export interface TileMeshProps {
  tile: DecodedTile;
  z: number; x: number; y: number;
  color?: string;
  skirtHeight?: number; // metres; 0 = no skirt
  wireframe?: boolean;
  dispose: () => void; // called when this tile's GPU geometry is freed
}

/**
 * Build positions (ECEF, absolute) + optional skirt geometry for a decoded tile.
 * Returns { geometry, center } — callers may offset the mesh to `center` for RTC rendering.
 */
export function buildTileGeometry(
  tile: DecodedTile, z: number, x: number, y: number, skirtHeight = 0,
): { geometry: THREE.BufferGeometry; center: THREE.Vector3 } {
  const b = geodeticTileBounds(z, x, y);
  const { u, v, height, indices, vertexCount, triangleCount, westIndices, southIndices, eastIndices, northIndices } = tile;
  const { minHeight, maxHeight } = tile.header;

  // --- vertex positions in ECEF ---
  const ecef = new Float64Array(vertexCount * 3);
  for (let i = 0; i < vertexCount; i++) {
    const lon = b.west + (u[i] / 32767) * (b.east - b.west);
    const lat = b.south + (v[i] / 32767) * (b.north - b.south);
    const h = minHeight + (height[i] / 32767) * (maxHeight - minHeight);
    const [px, py, pz] = geodeticToECEF(lon, lat, h);
    ecef[i * 3] = px; ecef[i * 3 + 1] = py; ecef[i * 3 + 2] = pz;
  }

  // --- RTC center (research #3: float64/RTC for globe math) ---
  const center = new THREE.Vector3();
  for (let i = 0; i < vertexCount; i++) {
    center.x += ecef[i * 3]; center.y += ecef[i * 3 + 1]; center.z += ecef[i * 3 + 2];
  }
  center.multiplyScalar(1 / vertexCount);
  const local = new Float32Array(vertexCount * 3);
  for (let i = 0; i < vertexCount; i++) {
    local[i * 3] = ecef[i * 3] - center.x;
    local[i * 3 + 1] = ecef[i * 3 + 1] - center.y;
    local[i * 3 + 2] = ecef[i * 3 + 2] - center.z;
  }

  let posAttr = new THREE.BufferAttribute(local, 3);
  let index = tile.indices;

  // --- skirt: duplicate boundary vertices pulled toward the ellipsoid center by skirtHeight ---
  if (skirtHeight > 0) {
    const boundary = new Set<number>([
      ...westIndices as any, ...southIndices as any, ...eastIndices as any, ...northIndices as any,
    ]);
    const skirtVerts = new Float32Array(boundary.size * 3);
    const skirtMap = new Map<number, number>();
    let k = 0;
    // pull each boundary vertex toward the earth center (geocentric "down")
    for (const vi of boundary) {
      const lx = local[vi * 3] + center.x, ly = local[vi * 3 + 1] + center.y, lz = local[vi * 3 + 2] + center.z;
      const len = Math.sqrt(lx * lx + ly * ly + lz * lz) || 1;
      const scale = (len - skirtHeight) / len;
      skirtVerts[k * 3] = lx * scale - center.x;
      skirtVerts[k * 3 + 1] = ly * scale - center.y;
      skirtVerts[k * 3 + 2] = lz * scale - center.z;
      skirtMap.set(vi, vertexCount + k);
      k++;
    }
    // build quad strips along each edge (boundary vertex i -> i+1, and their skirt twins)
    const quad = (edge: Uint32Array) => {
      const n = edge.length;
      const extra: number[] = [];
      for (let i = 0; i < n; i++) {
        const a = edge[i], an = edge[(i + 1) % n];
        const sa = skirtMap.get(a)!, san = skirtMap.get(an)!;
        extra.push(a, sa, an, sa, san, an);
      }
      return extra;
    };
    const strip = [
      ...quad(westIndices), ...quad(southIndices), ...quad(eastIndices), ...quad(northIndices),
    ];
    const newPos = new Float32Array(local.length + skirtVerts.length);
    newPos.set(local); newPos.set(skirtVerts, local.length);
    const newIdx = new Uint32Array(indices.length + strip.length);
    newIdx.set(indices); newIdx.set(strip, indices.length);
    posAttr = new THREE.BufferAttribute(newPos, 3);
    index = newIdx as any;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", posAttr);
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return { geometry, center };
}

export function TerrainTileMesh({ tile, z, x, y, color = "#c8b28a", skirtHeight = 0, wireframe = false, dispose }: TileMeshProps) {
  const built = useMemo(() => buildTileGeometry(tile, z, x, y, skirtHeight), [tile, z, x, y, skirtHeight]);
  const mesh = (
    <mesh geometry={built.geometry} position={[built.center.x, built.center.y, built.center.z]}>
      <meshStandardMaterial color={color} side={THREE.DoubleSide} wireframe={wireframe} />
    </mesh>
  );
  return mesh;
}
