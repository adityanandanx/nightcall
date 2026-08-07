import { useEffect, useRef, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { TerrainLOD } from "./LOD";
import { GlobeControls } from "./GlobeControls";
import { IMAGERY_SOURCES } from "./imagery";
import { geodeticToECEF } from "./terrain";

// Start looking at Mt Fuji.
const HOME_LON = 138.7274;
const HOME_LAT = 35.36;
// Earth surface radius at home (approx, for altitude readout)
const HOME_TARGET: [number, number, number] = geodeticToECEF(HOME_LON, HOME_LAT, 0);
const EARTH_R = 6378137;

export default function App() {
  const [showEllipsoid, setShowEllipsoid] = useState(false);
  const [skirt, setSkirt] = useState(true);
  const [imagery, setImagery] = useState(true);
  const [imageryKey, setImageryKey] = useState<keyof typeof IMAGERY_SOURCES>("esriSatellite");
  const [stats, setStats] = useState({ selected: 0, settled: 0, bytes: 0, textures: 0 });
  const [camDist, setCamDist] = useState<number>(1500);
  const [camCount, setCamCount] = useState(0);

  useEffect(() => {
    // (re)mount the TerrainLOD when base layer changes to reset tex cache cleanly
    setCamCount((c) => c + 1);
  }, [imageryKey]);

  return (
    <div style={{ position: "relative", height: "100%" }}>
      <Canvas
        key={imageryKey}
        camera={{ position: geodeticToECEF(HOME_LON, HOME_LAT, 250_000), far: 3e8, near: 1 }}
        gl={{ logarithmicDepthBuffer: true }}
        dpr={[1, 2]}
      >
        <ambientLight intensity={0.9} />
        <hemisphereLight args={["#ffffff", "#3a3a4a", 0.7]} />
        <directionalLight position={[1e7, 2e7, 3e7]} intensity={1.9} />
        <directionalLight position={[-2e7, -1e7, -1.5e7]} intensity={0.25} />

        {showEllipsoid && (
          <mesh>
            <sphereGeometry args={[6378137, 48, 24]} />
            <meshBasicMaterial color="#0d1420" wireframe transparent opacity={0.3} />
          </mesh>
        )}

        <TerrainLOD
          skirtHeight={skirt ? 300 : 0}
          settings={{ maxLevel: 14, maxSSE: 10 }}
          imagery={imagery}
          imagerySource={IMAGERY_SOURCES[imageryKey]}
          onStats={(s) => setStats(s)}
        />
        <GlobeControls
          initialTarget={HOME_TARGET}
          minDistance={1000}
          maxDistance={1e8}
          onDistanceChange={(d) => setCamDist(d)}
        />
      </Canvas>

      <div className="panel">
        <h1>nightcall — terrain globe</h1>
        <div className="sub">SSE quadtree · terrain.reearth.land · basemap drape</div>
        <div className="row"><label>Selected tiles</label><span className="val">{stats.selected}</span></div>
        <div className="row"><label>Settled (decoded)</label><span className="val">{stats.settled}</span></div>
        <div className="row"><label>Textures</label><span className="val">{stats.textures}</span></div>
        <div className="row"><label>Alt</label><span className="val">{((camDist) / 1000).toFixed(1)} km</span></div>
        <label className="row"><span>Imagery </span>
          <select value={imageryKey} onChange={(e) => setImageryKey(e.target.value)}>
            <option value="">off</option>
            <option value="esriSatellite">Esri Satellite</option>
            <option value="esriStreets">Esri Streets</option>
            <option value="osm">OpenStreetMap</option>
            <option value="cartoVoyager">Carto</option>
          </select>
        </label>
        <label className="row"><span>Skirts</span>
          <input type="checkbox" checked={skirt} onChange={(e) => setSkirt(e.target.checked)} />
        </label>
        <div className="hint">
          Drag: rotate · right-drag: pan the globe (no fixed origin) · scroll: zoom toward cursor · tilt & fly anywhere
        </div>
      </div>
    </div>
  );
}
