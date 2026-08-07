// R3F terrain LOD layer: per-frame quadtree selection -> decode via LRU cache -> render meshes.
// Per research #4: lod-selector (pure) -> tile-cache -> geometry-builder -> R3F meshes.
import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { selectTiles, LODSettings } from "./lod";
import { TileCache } from "./TileCache";
import { DecodedTile } from "./terrain";
import { TerrainTileMesh } from "./TerrainTile";

export interface TerrainLODProps {
  settings?: Partial<LODSettings>;
  skirtHeight?: number;
  color?: string;
  onStats?: (s: { selected: number; settled: number; bytes: number }) => void;
}

const cache = new TileCache(512 * 1024 * 1024);

export function TerrainLOD({ settings = {}, skirtHeight = 300, color, onStats }: TerrainLODProps) {
  const { camera, gl } = useThree();
  const cam = camera as THREE.PerspectiveCamera;
  const [settled, setSettled] = useState<Map<string, DecodedTile>>(new Map());
  const settledRef = useRef(settled);
  settledRef.current = settled;

  const merged: LODSettings = useMemo(() => {
    const vh = settings?.viewportHeight || gl.domElement.height || 800;
    const fov = (cam.fov ?? 50) as number;
    return {
      maxLevel: settings?.maxLevel ?? 14,
      maxSSE: settings?.maxSSE ?? 12,
      viewportHeight: vh,
      levelZeroError: settings?.levelZeroError ?? (6378137 * 2 * Math.PI * 2) / (65 * 2),
      sseDenominator: 2 * Math.tan((fov * Math.PI) / 360),
    };
  }, [settings, gl.domElement.height, cam.fov]);

  // free GPU buffers when the cache evicts a decoded tile
  useEffect(() => {
    cache.onEvict = (key) => {
      setSettled((prev) => {
        if (!prev.has(key)) return prev;
        const n = new Map(prev); n.delete(key); return n;
      });
    };
    return () => { cache.onEvict = null; };
  }, []);

  const publish = useCallback(() => {
    // sync settled state from cache for all tiles we currently render
    setSettled((prev) => {
      let changed = false;
      const next = new Map<string, DecodedTile>();
      for (const key of cache.keys()) {
        const t = cache.get(key);
        if (t) next.set(key, t);
      }
      // drop tiles no longer in cache
      if (next.size !== prev.size) changed = true;
      return changed ? next : prev;
    });
  }, []);

  useFrame(() => {
    camera.updateMatrixWorld();
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    const sel = selectTiles(camera.position, dir, merged);

    // ensure each selected tile is loaded
    let anyNew = false;
    for (const [key, ref] of sel) {
      if (cache.has(key)) continue;
      cache.ensure(key, ref.z, ref.x, ref.y).then(() => { anyNew = true; publish(); });
    }
    if (anyNew) publish();

    onStats?.({ selected: sel.size, settled: cache.settledCount(), bytes: cache.bytes });
  });

  // render settled tiles that are in the current selection window (approx: all settled, keyed stable)
  return (
    <group>
      {[...settled.entries()].map(([key, tile]) => {
        const [z, x, y] = key.split("/").map(Number);
        return (
          <TerrainTileMesh key={key} tile={tile} z={z} x={x} y={y}
            color={color} skirtHeight={skirtHeight} dispose={() => {}} />
        );
      })}
    </group>
  );
}
