// Zoom-driven LOD: quadtree tile selection over TMS x/y/z (EPSG:4326, y bottom-up).
// Per research #4: the Cesium SSE metric drives refinement — one numeric metric + a
// traversal decides which tiles render. Children split a tile into 4 sub-quadrants.
import * as THREE from "three";
import { geodeticTileBounds } from "./terrain";

export interface LODSettings {
  maxLevel: number;       // highest z we will load (service serves up to ~14)
  sseDenominator: number; // 2*tan(fovY/2), matches Cesium camera.sseDenominator
  maxSSE: number;         // screen-space error (px) above which a tile refines
  viewportHeight: number; // drawing buffer height in px (drives SSE)
  levelZeroError: number; // level-0 max geometric error, halved each level
}

export interface TileRef {
  z: number; x: number; y: number;
  center: THREE.Vector3; // ECEF center on ellipsoid
  radius: number;        // conservative bounding radius (m)
  sse: number;           // screen-space error at selection time
}

// TMS child mapping: children of (z,x,y) are (z+1, 2x, 2y), (z+1, 2x+1, 2y),
// (z+1, 2x, 2y+1), (z+1, 2x+1, 2y+1) — each splits the parent quadrant in half per axis.
export const TMS_NX = (z: number) => 2 ** (z + 1); // longitude tiles at level z
export const TMS_NY = (z: number) => 2 ** z;       // latitude tiles at level z

// Cesium level-zero geometric error estimate for a heightmap: a*2*PI*2/(tileWidth*tilesAtZero)
export const FALLBACK_LEVEL_ZERO_ERROR = (6378137 * 2 * Math.PI * 2) / (65 * 2);

export function levelError(z: number, settings: LODSettings): number {
  return settings.levelZeroError / 2 ** z;
}

export function tileCenterOnEllipsoid(z: number, x: number, y: number): THREE.Vector3 {
  const b = geodeticTileBounds(z, x, y);
  const lon = (b.west + b.east) / 2;
  const lat = (b.south + b.north) / 2;
  const lonR = (lon * Math.PI) / 180, latR = (lat * Math.PI) / 180;
  const A = 6378137, B = 6356752.3142451793;
  const N = A / Math.sqrt(1 - (1 - (B * B) / (A * A)) * Math.sin(latR) ** 2);
  return new THREE.Vector3(
    N * Math.cos(latR) * Math.cos(lonR),
    N * Math.cos(latR) * Math.sin(lonR),
    (N * B * B / (A * A)) * Math.sin(latR),
  );
}

// Conservative tile bounding radius: half-diagonal of the tile's lon/lat span at the ellipsoid.
export function tileRadius(z: number): number {
  const lonStep = 360 / TMS_NX(z);
  const latStep = 180 / TMS_NY(z);
  const halfLon = (lonStep / 2) * (Math.PI / 180);
  const halfLat = (latStep / 2) * (Math.PI / 180);
  // chord distance between center and a corner of the spherical quad, on max radius
  const r = 6378137;
  return r * Math.sqrt(halfLon * halfLon + halfLat * halfLat) * 1.01;
}

/**
 * Cesium screen-space error for a tile: maxGeometricError[level] * viewportHeight / (distance * sseDenominator)
 */
export function screenSpaceError(
  levelZ: number, distanceToTile: number, viewportHeight: number, settings: LODSettings
): number {
  if (distanceToTile < 1) return Number.POSITIVE_INFINITY;
  return (levelError(levelZ, settings) * viewportHeight) / (distanceToTile * settings.sseDenominator);
}

/**
 * Select render tiles via quadtree traversal with quad-lock (4-to-1 rule).
 *
 * Cracks come from neighbors at different LODs. To keep the seam problem bounded to ≤1 level
 * (research #4), we refine whole quads: a tile is replaced by its 4 children ONLY if ALL of its
 * children would refine (SSE above threshold). A node therefore either renders as-is or is fully
 * replaced by its quad — adjacent visible tiles differ by at most one level.
 */
export function selectTiles(
  cameraPos: THREE.Vector3,
  cameraDir: THREE.Vector3,
  settings: LODSettings,
): Map<string, TileRef> {
  const out = new Map<string, TileRef>();

  // shouldRefine: SSE for the tile's level at its distance to the camera
  const shouldRefine = (z: number, x: number, y: number): { refine: boolean; sse: number; dist: number } => {
    const center = tileCenterOnEllipsoid(z, x, y);
    const toCenter = center.clone().sub(cameraPos);
    const dist = toCenter.length();
    // cheap back-face cull: tile fully behind the camera's tangent plane
    const dot = toCenter.normalize().dot(cameraDir);
    if (dot < -0.05) return { refine: false, sse: 0, dist };
    const sse = screenSpaceError(z, dist, settings.viewportHeight, settings);
    return { refine: sse > settings.maxSSE && z < settings.maxLevel, sse, dist };
  };

  // Visit a node: if it (and its whole quad) wants refinement, descend; else emit.
  const visit = (z: number, x: number, y: number) => {
    const { refine, sse, dist } = shouldRefine(z, x, y);
    if (!refine) {
      const center = tileCenterOnEllipsoid(z, x, y);
      out.set(`${z}/${x}/${y}`, { z, x, y, center, radius: tileRadius(z), sse });
      return;
    }
    // quad-lock: all 4 children must exist and all want refinement too (SSE monotone in z,
    // so if the parent refines, children usually refine; check anyway for edge tiles)
    const cxs = [2 * x, 2 * x + 1];
    const cys = [2 * y, 2 * y + 1];
    const nx = TMS_NX(z + 1), ny = TMS_NY(z + 1);
    const children: { z: number; x: number; y: number }[] = [];
    for (const cy of cys) for (const cx of cxs) {
      if (cx >= 0 && cx < nx && cy >= 0 && cy < ny) children.push({ z: z + 1, x: cx, y: cy });
    }
    if (children.length < 4) {
      // edge of the TMS grid (shouldn't happen except at poles); render the parent
      const center = tileCenterOnEllipsoid(z, x, y);
      out.set(`${z}/${x}/${y}`, { z, x, y, center, radius: tileRadius(z), sse });
      return;
    }
    // require every child to independently pass the SSE test, else keep this tile
    for (const c of children) {
      if (!shouldRefine(c.z, c.x, c.y).refine) {
        const center = tileCenterOnEllipsoid(z, x, y);
        out.set(`${z}/${x}/${y}`, { z, x, y, center, radius: tileRadius(z), sse });
        return;
      }
    }
    for (const c of children) visit(c.z, c.x, c.y);
  };

  // roots: (0,0,0) covers lon -180..0 and (0,1,0) covers lon 0..180 (TMS_NX(0)=2)
  for (let x = 0; x < TMS_NX(0); x++) visit(0, x, 0);
  return out;
}
