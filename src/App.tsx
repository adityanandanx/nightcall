import { useEffect, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { TerrainLOD } from "./LOD";
import { geodeticToECEF } from "./terrain";

// Start looking at Mt Fuji (lon 138.7274, lat 35.36) from space, zooming in over the run.
const HOME_LON = 138.7274;
const HOME_LAT = 35.36;

export default function App() {
  const [showEllipsoid, setShowEllipsoid] = useState(true);
  const [skirt, setSkirt] = useState(true);
  const [stats, setStats] = useState({ selected: 0, settled: 0, bytes: 0 });
  const [camDist, setCamDist] = useState<number>(15_000_000);

  return (
    <div style={{ position: "relative", height: "100%" }}>
      <Canvas
        camera={{ position: geodeticToECEF(HOME_LON, HOME_LAT, 300_000), far: 3e8, near: 1 }}
        gl={{ logarithmicDepthBuffer: true }}
        dpr={[1, 2]}
        onCreated={({ camera }) => setCamDist(camera.position.length())}
      >
        <ambientLight intensity={0.5} />
        <directionalLight position={[1e7, 2e7, 3e7]} intensity={1.6} />

        {showEllipsoid && (
          <mesh>
            <sphereGeometry args={[6378137, 48, 24]} />
            <meshBasicMaterial color="#0d1420" wireframe transparent opacity={0.3} />
          </mesh>
        )}

        <TerrainLOD
          skirtHeight={skirt ? 300 : 0}
          settings={{ maxLevel: 12, maxSSE: 12 }}
          onStats={(s) => setStats(s)}
        />
        <OrbitControls enableDamping dampingFactor={0.15} />
      </Canvas>

      <div className="panel">
        <h1>nightcall — zoom-driven LOD (ticket #6)</h1>
        <div className="sub">SSE quadtree over TMS 4326 · terrain.reearth.land</div>
        <div className="row"><label>Selected tiles</label><span className="val">{stats.selected}</span></div>
        <div className="row"><label>Settled (decoded)</label><span className="val">{stats.settled}</span></div>
        <div className="row"><label>Cache bytes</label><span className="val">{(stats.bytes / 1e6).toFixed(1)} MB</span></div>
        <div className="row"><label>Camera alt</label><span className="val">{(camDist / 1e6).toFixed(1)} Mm</span></div>
        <label className="row"><span>Ellipsoid wireframe</span>
          <input type="checkbox" checked={showEllipsoid} onChange={(e) => setShowEllipsoid(e.target.checked)} />
        </label>
        <label className="row"><span>Skirts (crack hide)</span>
          <input type="checkbox" checked={skirt} onChange={(e) => setSkirt(e.target.checked)} />
        </label>
        <div className="hint">Orbit-zoom: scroll to refine terrain — wait a moment for tiles to stream.</div>
      </div>
    </div>
  );
}
