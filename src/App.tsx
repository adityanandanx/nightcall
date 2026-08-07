import { useEffect, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { TerrainTileMesh } from "./TerrainTile";
import { fetchTerrainTile, geodeticToECEF, WGS84_A, DecodedTile } from "./terrain";

// Start looking at Mt Fuji (lon 138.7274, lat 35.36) from space.
const HOME_LON = 138.7274;
const HOME_LAT = 35.36;
const CAM_DISTANCE = 5_000_000; // ~0.8 Earth radii
// Tile containing Mt Fuji at z=2: x=7 (lon 135..180), y=2 (lat 0..45)
const TILE = { z: 2, x: 7, y: 2 };

export default function App() {
  const [tile, setTile] = useState<DecodedTile | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  const [error, setError] = useState("");
  const [showEllipsoid, setShowEllipsoid] = useState(true);
  const [key, setKey] = useState(0); // remount scene on reload

  const load = async () => {
    setState("loading"); setError(""); setTile(null);
    try {
      const t = await fetchTerrainTile(TILE.z, TILE.x, TILE.y);
      setTile(t); setState("ok");
    } catch (e: any) {
      setState("error"); setError(String(e?.message || e));
    }
  };

  useEffect(() => { load(); }, []);

  return (
    <div style={{ position: "relative", height: "100%" }}>
      <Canvas
        key={key}
        camera={{ position: geodeticToECEF(HOME_LON, HOME_LAT, CAM_DISTANCE), far: 1e9, near: 1 }}
        gl={{ logarithmicDepthBuffer: true }}
        dpr={[1, 2]}
      >
        <ambientLight intensity={0.5} />
        <directionalLight position={[1e7, 2e7, 3e7]} intensity={1.6} />
        {tile && <TerrainTileMesh tile={tile} z={TILE.z} x={TILE.x} y={TILE.y} />}
        {showEllipsoid && (
          <mesh>
            <sphereGeometry args={[WGS84_A, 48, 24]} />
            <meshBasicMaterial color="#0d1420" wireframe transparent opacity={0.35} />
          </mesh>
        )}
        <OrbitControls enableDamping />
      </Canvas>

      <div className="panel">
        <h1>nightcall — single-tile prototype</h1>
        <div className="sub">One quantized-mesh tile on the WGS84 ellipsoid (ticket #5)</div>
        <div className="row"><label>Tile</label><span className="val">{TILE.z}/{TILE.x}/{TILE.y}</span></div>
        <div className="row"><label>Vertices</label><span className="val">{tile?.vertexCount ?? "—"}</span></div>
        <div className="row"><label>Triangles</label><span className="val">{tile?.triangleCount ?? "—"}</span></div>
        <div className="row"><label>Status</label><span className="val">{state}</span></div>
        <label className="row"><span>Ellipsoid wireframe</span>
          <input type="checkbox" checked={showEllipsoid} onChange={(e) => setShowEllipsoid(e.target.checked)} />
        </label>
        {state === "error" && <div style={{ color: "#ff7d7d" }}>{error}</div>}
        <button onClick={load}>Reload tile</button>
      </div>
    </div>
  );
}
