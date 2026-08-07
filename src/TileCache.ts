// Tile cache: LRU keyed by "z/x/y", byte budget + per-frame liveness stamps.
// Per research #4 (Cesium TileReplacementQueue / Navara cacheBytes): keep a bounded
// decoded-tile cache, evict least-recently-used entries when over budget.
import { DecodedTile, fetchTerrainTile } from "./terrain";

interface CacheEntry {
  tile?: DecodedTile;
  bytes: number;
  lastUsed: number; // frame stamp
  loading: boolean;
  promise: Promise<DecodedTile>;
}

export class TileCache {
  private map = new Map<string, CacheEntry>();
  private budgetBytes: number;
  private used = 0;
  private stamp = 0;
  /** called with the tile key when a settled entry is evicted (R3F layer frees GPU buffers) */
  onEvict: ((key: string) => void) | null = null;

  constructor(budgetBytes = 512 * 1024 * 1024) {
    this.budgetBytes = budgetBytes;
  }

  private static sizeOf(t: DecodedTile): number {
    return (t.u.byteLength + t.v.byteLength + t.height.byteLength + t.indices.byteLength
      + t.westIndices.byteLength + t.southIndices.byteLength + t.eastIndices.byteLength
      + t.northIndices.byteLength + (t.octNormals ? t.octNormals.byteLength : 0)
      + (t.waterMask ? t.waterMask.byteLength : 0));
  }

  has(key: string): boolean { return this.map.has(key); }

  get(key: string): DecodedTile | undefined {
    const e = this.map.get(key);
    if (e && !e.loading) { e.lastUsed = this.stamp; return e.tile; }
    return undefined;
  }

  /** Mark a frame stamp for LRU ordering. */
  frame() { this.stamp++; }

  /**
   * Ensure the tile is present (or being fetched); returns a promise resolving to it.
   * Dedups in-flight fetches; errors reject.
   */
  ensure(key: string, z: number, x: number, y: number): Promise<DecodedTile> {
    const hit = this.map.get(key);
    if (hit) { if (!hit.loading) hit.lastUsed = this.stamp; return hit.promise; }
    const entry: CacheEntry = {
      bytes: 0, lastUsed: this.stamp, loading: true,
      promise: fetchTerrainTile(z, x, y)
        .then((tile) => {
          entry.tile = tile;
          entry.bytes = TileCache.sizeOf(tile);
          entry.loading = false;
          this.used += entry.bytes;
          this.map.set(key, entry);
          this.evict();
          return tile;
        })
        .catch((err) => {
          this.map.delete(key);
          throw err;
        }),
    };
    this.map.set(key, entry);
    return entry.promise;
  }

  /** snapshot of keys with settled tiles */
  keys(): string[] { return [...this.map.entries()].filter(([, e]) => !e.loading).map(([k]) => k); }
  settledCount(): number { return [...this.map.values()].filter((e) => !e.loading).length; }
  get size(): number { return this.map.size; }
  get bytes(): number { return this.used; }

  private evict() {
    if (this.used <= this.budgetBytes) return;
    const settled = [...this.map.entries()]
      .filter(([, e]) => !e.loading)
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [key, e] of settled) {
      if (this.used <= this.budgetBytes) break;
      this.used -= e.bytes;
      this.map.delete(key);
      this.onEvict?.(key);
    }
  }
}
