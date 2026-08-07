// Imagery draping: build a canvas texture per terrain tile from WebMercator XYZ basemap tiles.
// Terrain uses TMS 4326 (geodetic); basemaps use WebMercator. We reproject: a vertex's lon ->
// mercator x-fraction, lat -> mercator y-fraction; the overlapping mercator tiles are drawn into
// one canvas positioned in mercator space, then used as that tile's texture.
// Mirrors Navara/Cesium raster draping (research #4).

export type ImagerySource = {
  name: string;
  url: (z: number, x: number, y: number) => string;
  maxNativeZoom: number;
};

export const IMAGERY_SOURCES: Record<string, ImagerySource> = {
  esriSatellite: {
    name: 'Esri World Imagery',
    url: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
    maxNativeZoom: 20,
  },
  esriStreets: {
    name: 'Esri World Street Map',
    url: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/${z}/${x}/${y}`,
    maxNativeZoom: 20,
  },
  osm: {
    name: 'OpenStreetMap',
    url: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`,
    maxNativeZoom: 19,
  },
  cartoVoyager: {
    name: 'Carto Voyager',
    url: (z, x, y) => `https://a.basemaps.cartocdn.com/rastertiles/voyager/${z}/${x}/${y}.png`,
    maxNativeZoom: 20,
  },
};

// web-mercator y (0=north .. 1=south) for a latitude in degrees.
// Web Mercator is only defined within ~±85.05 deg; clamp so poles never produce NaN/inf.
const MAX_MERC_LAT = 85.05112878;
export function wmY(latDeg: number): number {
  const lat = Math.max(-MAX_MERC_LAT, Math.min(MAX_MERC_LAT, latDeg));
  const r = (lat * Math.PI) / 180;
  return (1 - Math.log(Math.tan(Math.PI / 4 + r / 2)) / Math.PI) / 2;
}
// web-mercator x in [0,1] for a longitude in degrees
export function wmX(lonDeg: number): number {
  return (lonDeg + 180) / 360;
}

interface TileRect { u0: number; u1: number; v0: number; v1: number; bitmap: ImageBitmap; }

// --- global basemap-tile cache: one fetch per unique XYZ tile, shared across all terrain tiles ---
const bitmapCache = new Map<string, Promise<ImageBitmap>>();
let inflightFetches = 0;
const MAX_GLOBAL_FETCHES = 20;
const fetchWaiters: (() => void)[] = [];

async function withFetchPermit<T>(fn: () => Promise<T>): Promise<T> {
  if (inflightFetches >= MAX_GLOBAL_FETCHES) {
    await new Promise<void>((res) => fetchWaiters.push(res));
  }
  inflightFetches++;
  try {
    return await fn();
  } finally {
    inflightFetches--;
    const next = fetchWaiters.shift();
    if (next) next();
  }
}

function cachedBitmap(url: string): Promise<ImageBitmap> {
  let p = bitmapCache.get(url);
  if (!p) {
    p = withFetchPermit(async () => {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error("basemap " + resp.status);
      return createImageBitmap(await resp.blob());
    }).catch((e) => {
      bitmapCache.delete(url); // allow retry later
      throw e;
    });
    bitmapCache.set(url, p);
  }
  return p;
}

/**
 * Build a canvas texture covering a terrain tile's [west,east]x[south,north] bounds.
 * Fetches overlapping WebMercator tiles at zoom `zi` and mosaics them in mercator space.
 * Canvas y=0 = north; caller maps per-vertex lon/lat with mercUV().
 */
export async function buildImageryCanvas(
  west: number, east: number, south: number, north: number,
  source: ImagerySource, zi: number,
): Promise<HTMLCanvasElement | null> {
  const ziClamped = Math.min(zi, source.maxNativeZoom);
  const n = 2 ** ziClamped;
  // merc tiles covering our lon span; y rows cover mercator [vN..vS]
  const u0 = wmX(west), u1 = wmX(east);
  const vN = wmY(north), vS = wmY(south);
  const x0 = Math.max(0, Math.floor(u0 * n));
  const x1 = Math.min(n - 1, Math.floor(u1 * n));
  const yN = Math.max(0, Math.floor(vN * n));
  const yS = Math.min(n - 1, Math.floor(vS * n));
  if (x1 < x0 || yS < yN) return null;
  const du = u1 - u0, dv = vS - vN;
  const px = 512;
  const W = Math.max(16, Math.round(px));
  const H = Math.max(16, Math.round(px * (dv / du)));
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const g = canvas.getContext('2d');
  if (!g) return null;
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';

  const rects: TileRect[] = [];
  try {
    const tasks: Promise<void>[] = [];
    for (let y = yN; y <= yS; y++) {
      for (let x = x0; x <= x1; x++) {
        const url = source.url(ziClamped, x, y);
        tasks.push(cachedBitmap(url).then((bmp) => {
          const duu = 1 / n;
          rects.push({ u0: x * duu, u1: (x + 1) * duu, v0: y * duu, v1: (y + 1) * duu, bitmap: bmp });
        }).catch(() => { /* missing tile: leave blank */ }));
      }
    }
    await Promise.all(tasks);
  } catch { /* network errors: leave the canvas as-is */ }

  for (const r of rects) {
    // mercator x->canvas x, mercator y(0=north)->canvas y(0=north)
    const x = ((r.u0 - u0) / du) * W;
    const w = ((r.u1 - r.u0) / du) * W;
    const y = ((r.v0 - vN) / dv) * H;
    const h = ((r.v1 - r.v0) / dv) * H;
    g.drawImage(r.bitmap, 0, 0, r.bitmap.width, r.bitmap.height, x, y, w, h);
  }
  return canvas;
}

/** per-vertex UV for a lon/lat within this tile bounds. v=0 north, v=1 south (matches canvas y=0=north). */
export function mercUV(
  lon: number, lat: number, west: number, east: number, south: number, north: number,
): [number, number] {
  const du = wmX(east) - wmX(west);
  const dv = wmY(south) - wmY(north);
  return [
    (wmX(lon) - wmX(west)) / (du || 1e-9),
    (wmY(lat) - wmY(north)) / (dv || 1e-9),
  ];
}
