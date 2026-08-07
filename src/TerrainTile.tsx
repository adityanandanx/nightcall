// R3F component: render one decoded terrain tile as a mesh on the WGS84 ellipsoid.
import { useMemo, useRef } from "react";
import * as THREE from "three";
import {
  DecodedTile, geodeticToECEF, geodeticTileBounds,
} from "./terrain";

// exponent used for logarithmic depth; see ellipsoid-math FINDINGS
const LOG_DEPTH_BUFFER_BITS = 22;

function buildGeometry(tile: DecodedTile, z: number, x: number, y: number): THREE.BufferGeometry {
  const b = geodeticTileBounds(z, x, y);
  const { u, v, height, indices, vertexCount, triangleCount } = tile;
  const { minHeight, maxHeight } = tile.header;

  const pos = new Float64Array(vertexCount * 3);
  for (let i = 0; i < vertexCount; i++) {
    const lon = b.west + (u[i] / 32767) * (b.east - b.west);
    const lat = b.south + (v[i] / 32767) * (b.north - b.south);
    const h = minHeight + (height[i] / 32767) * (maxHeight - minHeight);
    const [x0, y0, z0] = geodeticToECEF(lon, lat, h);
    pos[i * 3] = x0; pos[i * 3 + 1] = y0; pos[i * 3 + 2] = z0;
  }

  const geom = new THREE.BufferGeometry();
  // use Float32BufferAttribute on a Float64Array-backed copy; three needs Float32 for position on most backends
  geom.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(pos), 3));
  geom.setIndex(new THREE.BufferAttribute(tile.indices, 1));
  geom.computeVertexNormals();
  geom.computeBoundingSphere();
  return geom;
}

export function TerrainTileMesh({ tile, z, x, y, color = "#c8b28a" }: {
  tile: DecodedTile; z: number; x: number; y: number; color?: string;
}) {
  const geometry = useMemo(() => buildGeometry(tile, z, x, y), [tile, z, x, y]);
  return (
    <mesh geometry={geometry}>
      <meshStandardMaterial color={color} side={THREE.DoubleSide} vertexColors={false} />
    </mesh>
  );
}
