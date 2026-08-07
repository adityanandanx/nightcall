// R3F terrain LOD layer: per-frame quadtree selection -> decode via LRU cache -> render meshes.
// Also builds a per-tile imagery texture (WebMercator basemap draped over TMS 4326 terrain),
// throttled through a small concurrent queue so we never spam the browser with hundreds of fetches.
import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { selectTiles, LODSettings, tileCenterOnEllipsoid } from "./lod";
import { TileCache } from "./TileCache";
import { DecodedTile, geodeticTileBounds } from "./terrain";
import { TerrainTileMesh } from "./TerrainTile";
import { ImagerySource, buildImageryCanvas } from "./imagery";

export interface TerrainLODProps {
  settings?: Partial<LODSettings>;
  skirtHeight?: number;
  color?: string;
  imagery?: boolean;
  imagerySource?: ImagerySource;
  onStats?: (s: { selected: number; settled: number; bytes: number; textures: number }) => void;
}

const cache = new TileCache(768 * 1024 * 1024);
// texture cache keyed by tile key
const texCache = new Map<string, THREE.CanvasTexture>();
const texCanvasCache = new Map<string, HTMLCanvasElement>();

function tileImageryZoom(z: number, source: ImagerySource): number {
  return Math.min(z + 1, source.maxNativeZoom);
}

const MAX_CONCURRENT_TEX = 12;

export function TerrainLOD({ settings = {}, skirtHeight = 300, color, imagery = false, imagerySource, onStats }: TerrainLODProps) {
  const { camera, gl } = useThree();
  const cam = camera as THREE.PerspectiveCamera;
  const [settled, setSettled] = useState<Map<string, DecodedTile>>(new Map());
  const [textures, setTextures] = useState<Map<string, THREE.CanvasTexture>>(new Map());

  const inflight = useRef(new Set<string>());
  const queue = useRef<string[]>([]);
  const queued = useRef(new Set<string>());
  const drainScheduled = useRef(false);
  const lastSelRef = useRef<Map<string, {z:number;x:number;y:number}>>(new Map());

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
      const tc = texCache.get(key);
      if (tc) { tc.dispose(); texCache.delete(key); texCanvasCache.delete(key); }
      setTextures((prev) => { if (!prev.has(key)) return prev; const n = new Map(prev); n.delete(key); return n; });
    };
    return () => { cache.onEvict = null; };
  }, []);

  const publish = useCallback(() => {
    setSettled((prev) => {
      const next = new Map<string, DecodedTile>();
      for (const key of cache.keys()) {
        const t = cache.get(key);
        if (t) next.set(key, t);
      }
      return next.size === prev.size ? prev : next;
    });
  }, []);

  // --- throttled texture pipeline ---
  const buildOne = useCallback(async (key: string) => {
    const [z, x, y] = key.split("/").map(Number);
    try {
      if (!imagerySource) return;
      const b = geodeticTileBounds(z, x, y);
      const canvas = await buildImageryCanvas(b.west, b.east, b.south, b.north, imagerySource, tileImageryZoom(z, imagerySource));
      if (!canvas) return;
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      tex.flipY = false; // canvas y=0 = north; UV v=0 = north
      texCache.set(key, tex);
      texCanvasCache.set(key, canvas);
      setTextures((prev) => { const n = new Map(prev); n.set(key, tex); return n; });
    } catch (e) {
      console.warn("imagery failed", key, e);
    } finally {
      inflight.current.delete(key);
      drainScheduled.current = false;
      drainQueue();
    }
  }, [imagerySource]);

  const drainQueue = useCallback(() => {
    if (!imagery || !imagerySource) return;
    if (drainScheduled.current) return;
    drainScheduled.current = true;
    setTimeout(() => {
      drainScheduled.current = false;
      while (queue.current.length > 0 && inflight.current.size < MAX_CONCURRENT_TEX) {
        const key = queue.current.shift()!;
        queued.current.delete(key);
        inflight.current.add(key);
        void buildOne(key);
      }
    }, 0);
  }, [imagery, imagerySource, buildOne]);

  // per-frame: enqueue texture builds for the CURRENTLY SELECTED tiles first (coarse first),
  // then any other cached tiles. This keeps the camera-facing imagery streaming in ahead of
  // off-screen tiles that the LRU cache may still hold.
  useFrame(() => {
    if (!imagery || !imagerySource) return;
    camera.updateMatrixWorld();
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    const sel = selectTiles(camera.position, dir, merged);
    const ordered: { key: string; sse: number }[] = [];
    for (const [key, ref] of sel) {
      if (!texCache.has(key) && !inflight.current.has(key) && !queued.current.has(key)) {
        ordered.push({ key, sse: ref.sse });
      }
    }
    // prioritize by screen-space error DESC: tiles covering the most screen area first.
    ordered.sort((a, b) => b.sse - a.sse);
    let added = 0;
    for (const { key } of ordered) {
      if (added >= 12) break;
      queued.current.add(key);
      queue.current.push(key);
      added++;
    }
    if (added > 0) drainQueue();
  });

  useFrame(() => {
    camera.updateMatrixWorld();
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    const sel = selectTiles(camera.position, dir, merged);
    lastSelRef.current = sel;

    let anyNew = false;
    for (const [key, ref] of sel) {
      if (cache.has(key)) continue;
      cache.ensure(key, ref.z, ref.x, ref.y).then(() => { anyNew = true; publish(); });
    }
    if (anyNew) publish();

    onStats?.({ selected: sel.size, settled: cache.settledCount(), bytes: cache.bytes, textures: texCache.size });
  });

  return (
    <group>
      {[...settled.entries()].map(([key, tile]) => {
        const [z, x, y] = key.split("/").map(Number);
        return (
          <TerrainTileMesh key={key} tile={tile} z={z} x={x} y={y}
            color={color} skirtHeight={skirtHeight}
            texture={textures.get(key) ?? null} />
        );
      })}
    </group>
  );
}
