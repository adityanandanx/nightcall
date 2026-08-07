// R3F component: render one decoded terrain tile as a mesh on the WGS84 ellipsoid.
// Per-tile imagery draping (research #4): the mesh carries UVs in WebMercator space so a
// basemap texture (imagery.ts) lays on even though terrain tiles are TMS 4326 geodetic.
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import {
  DecodedTile, geodeticToECEF, geodeticTileBounds,
} from "./terrain";
import { mercUV } from "./imagery";

export interface TileMeshProps {
  tile: DecodedTile;
  z: number; x: number; y: number;
  color?: string;
  skirtHeight?: number;
  wireframe?: boolean;
  texture?: THREE.Texture | null; // imagery drape (owned by parent cache)
}

/**
 * Build positions (ECEF, absolute) + optional skirt geometry + UVs for a decoded tile.
 * Returns { geometry, center } — callers offset the mesh to `center` for RTC rendering.
 */
export function buildTileGeometry(
  tile: DecodedTile, z: number, x: number, y: number, skirtHeight = 0,
): { geometry: THREE.BufferGeometry; center: THREE.Vector3 } {
  const b = geodeticTileBounds(z, x, y);
  const { u, v, height, indices, vertexCount, triangleCount, westIndices, southIndices, eastIndices, northIndices } = tile;
  const { minHeight, maxHeight } = tile.header;

  // per-vertex lon/lat + ECEF
  const lapse = new Float64Array(vertexCount);
  const latA = new Float64Array(vertexCount);
  const ecef = new Float64Array(vertexCount * 3);
  for (let i = 0; i < vertexCount; i++) {
    const lon = b.west + (u[i] / 32767) * (b.east - b.west);
    const lat = b.south + (v[i] / 32767) * (b.north - b.south);
    const h = minHeight + (height[i] / 32767) * (maxHeight - minHeight);
    lapse[i] = lon; latA[i] = lat;
    const [px, py, pz] = geodeticToECEF(lon, lat, h);
    ecef[i * 3] = px; ecef[i * 3 + 1] = py; ecef[i * 3 + 2] = pz;
  }

  // RTC center
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
  // UVs in WebMercator space (v=0 north)
  let uv = new Float32Array(vertexCount * 2);
  for (let i = 0; i < vertexCount; i++) {
    const [U, V] = mercUV(lapse[i], latA[i], b.west, b.east, b.south, b.north);
    uv[i * 2] = U; uv[i * 2 + 1] = V;
  }

  let posAttr = new THREE.BufferAttribute(local, 3);
  let index = tile.indices;

  if (skirtHeight > 0) {
    const boundary = new Set<number>([
      ...westIndices as any, ...southIndices as any, ...eastIndices as any, ...northIndices as any,
    ]);
    const skirtVerts = new Float32Array(boundary.size * 3);
    const skirtUV = new Float32Array(boundary.size * 2);
    const skirtMap = new Map<number, number>();
    let k = 0;
    for (const vi of boundary) {
      const lx = local[vi * 3] + center.x, ly = local[vi * 3 + 1] + center.y, lz = local[vi * 3 + 2] + center.z;
      const len = Math.sqrt(lx * lx + ly * ly + lz * lz) || 1;
      const scale = (len - skirtHeight) / len;
      skirtVerts[k * 3] = lx * scale - center.x;
      skirtVerts[k * 3 + 1] = ly * scale - center.y;
      skirtVerts[k * 3 + 2] = lz * scale - center.z;
      skirtUV[k * 2] = uv[vi * 2]; skirtUV[k * 2 + 1] = uv[vi * 2 + 1];
      skirtMap.set(vi, vertexCount + k);
      k++;
    }
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
    const strip = [...quad(westIndices), ...quad(southIndices), ...quad(eastIndices), ...quad(northIndices)];
    const newPos = new Float32Array(local.length + skirtVerts.length);
    newPos.set(local); newPos.set(skirtVerts, local.length);
    const newIdx = new Uint32Array(indices.length + strip.length);
    newIdx.set(indices); newIdx.set(strip, indices.length);
    const newUV = new Float32Array(uv.length + skirtUV.length);
    newUV.set(uv); newUV.set(skirtUV, uv.length);
    posAttr = new THREE.BufferAttribute(newPos, 3);
    index = newIdx as any;
    uv = newUV;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", posAttr);
  if (uv) geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return { geometry, center };
}

export function TerrainTileMesh({ tile, z, x, y, color = "#c8b28a", skirtHeight = 0, wireframe = false, texture }: TileMeshProps) {
  const built = useMemo(() => buildTileGeometry(tile, z, x, y, skirtHeight), [tile, z, x, y, skirtHeight]);
  return (
    <mesh geometry={built.geometry} position={[built.center.x, built.center.y, built.center.z]}>
      <meshStandardMaterial
        map={texture ?? undefined}
        color={texture ? "#ffffff" : color}
        side={THREE.DoubleSide}
        wireframe={wireframe}
      />
    </mesh>
  );
}

