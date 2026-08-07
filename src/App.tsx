import { useEffect, useRef, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls, OrbitControls as OrbitControlsImpl } from "@react-three/drei";
import type { OrbitControls as OC } from "three-stdlib";
import { TerrainLOD } from "./LOD";
import { geodeticToECEF } from "./terrain";

// Start looking at Mt Fuji (lon 138.7274, lat 35.36).
const HOME_LON = 138.7274;
const HOME_LAT = 35.36;
// Orbit target: a point ~4 km above the ellipsoid at the home location — above Fuji's
// 3.78 km summit — so the camera orbits around the mountain, never through the planet core.
const HOME_TARGET: [number, number, number] = geodeticToECEF(HOME_LON, HOME_LAT, 4000);
const EARTH_R = 6378137;
// radius of the ellipsoid surface directly below the home target (accounts for flattening),
// so the altitude readout is true height above local ground, not distance from the equator radius.
const HOME_SURF: [number, number, number] = geodeticToECEF(HOME_LON, HOME_LAT, 0);
const ELLIPSE_R_AT_HOME = Math.hypot(HOME_SURF[0], HOME_SURF[1], HOME_SURF[2]);

export default function App() {
  const [showEllipsoid, setShowEllipsoid] = useState(true);
  const [skirt, setSkirt] = useState(true);
  const [stats, setStats] = useState({ selected: 0, settled: 0, bytes: 0 });
  const [camDist, setCamDist] = useState<number>(300_000);
  const controlsRef = useRef<OC>(null);
  useEffect(() => {
    (window as any).__getCam = () => {
      const c = controlsRef.current;
      if (!c) return null;
      const p = c.object.position;
      return { x: p.x, y: p.y, z: p.z, r: Math.hypot(p.x, p.y, p.z), alt: Math.hypot(p.x, p.y, p.z) - EARTH_R,
               minD: c.minDistance, maxD: c.maxDistance, target: Array.from((c as any).target) };
    };
  }, []);

  return (
    <div style={{ position: "relative", height: "100%" }}>
      <Canvas
        camera={{ position: geodeticToECEF(HOME_LON, HOME_LAT, 2_500_000), far: 3e8, near: 1 }}
        gl={{ logarithmicDepthBuffer: true }}
        dpr={[1, 2]}
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
        <OrbitControls
          ref={controlsRef}
          target={HOME_TARGET}
          onEnd={() => setCamDist(controlsRef.current?.object.position.length() ?? 0)}
          onStart={() => setCamDist(controlsRef.current?.object.position.length() ?? 0)}
          minDistance={1000}     // camera stays >= ~3 km above the target point -> no clipping into Fuji
          maxDistance={1e8}      // far enough to see the whole globe
          enablePan={false}      // orbit, don't drag the target off the globe
          maxPolarAngle={Math.PI / 2}  // never flip under the globe
          enableDamping
          dampingFactor={0.15}
          zoomSpeed={1.2}        // finer wheel control near the surface
        />
      </Canvas>

      <div className="panel">
        <h1>nightcall — zoom-driven LOD (ticket #6)</h1>
        <div className="sub">SSE quadtree over TMS 4326 · terrain.reearth.land</div>
        <div className="row"><label>Selected tiles</label><span className="val">{stats.selected}</span></div>
        <div className="row"><label>Settled (decoded)</label><span className="val">{stats.settled}</span></div>
        <div className="row"><label>Cache bytes</label><span className="val">{(stats.bytes / 1e6).toFixed(1)} MB</span></div>
        <div className="row"><label>Camera alt</label><span className="val">{((camDist - ELLIPSE_R_AT_HOME) / 1000).toFixed(1)} km</span></div>
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
