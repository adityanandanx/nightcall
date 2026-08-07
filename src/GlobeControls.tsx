// Google-Earth-style camera controller (no fixed origin).
// - Left-drag: rotate the view (orbit the current surface point)
// - Right-drag (or ctrl/cmd-drag): pan — the target moves ACROSS the globe surface;
//   the controller re-projects the target onto the WGS84 ellipsoid so it never lifts off.
// - Wheel: zoom toward the cursor (zoomToCursor), clamped by min/max distance.
// - The camera is free: there is no fixed origin; you can fly to any point on Earth.
import { useRef, useCallback } from "react";
import { useThree, useFrame } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { WGS84_A, WGS84_B } from "./terrain";

interface GlobeControlsProps {
  initialTarget: [number, number, number];
  minDistance?: number;
  maxDistance?: number;
  onDistanceChange?: (dist: number) => void;
}

// point on the WGS84 ellipsoid along unit direction d
function projectToEllipsoid(d: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  const dx = d.x, dy = d.y, dz = d.z;
  const t = 1 / Math.sqrt((dx * dx + dy * dy) / (WGS84_A * WGS84_A) + (dz * dz) / (WGS84_B * WGS84_B));
  return { x: dx * t, y: dy * t, z: dz * t };
}

export function GlobeControls({ initialTarget, minDistance = 1000, maxDistance = 1e8, onDistanceChange }: GlobeControlsProps) {
  const controlsRef = useRef<OrbitControlsImpl>(null);
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  const initialTargetRef = useRef(initialTarget);

  // Keep the target on the ellipsoid: after any controls change, snap target to surface.
  const snapTarget = useCallback(() => {
    const c = controlsRef.current;
    if (!c) return;
    const t = c.target;
    const len = Math.hypot(t.x, t.y, t.z);
    if (len < 1) return;
    const p = projectToEllipsoid({ x: t.x / len, y: t.y / len, z: t.z / len });
    t.set(p.x, p.y, p.z);
    onDistanceChange?.(camera.position.distanceTo(t));
  }, [camera, onDistanceChange]);

  useFrame(() => {
    controlsRef.current?.update();
    // cheap per-frame distance readout
    if (onDistanceChange) {
      const c = controlsRef.current;
      if (c && (c as any)._spherical) {
        onDistanceChange((c as any)._spherical.radius);
      }
    }
  });

  return (
    <OrbitControls
      ref={controlsRef}
      makeDefault
      camera={camera}
      domElement={gl.domElement}
      target={initialTargetRef.current}
      enableDamping
      dampingFactor={0.12}
      // rotation: left-drag orbits the current surface point
      rotateSpeed={0.6}
      // zoom: wheel toward cursor (Google-Earth like)
      zoomToCursor
      zoomSpeed={1.4}
      minDistance={minDistance}
      maxDistance={maxDistance}
      // pan: right-drag moves target across the globe; we re-project it onto the ellipsoid
      enablePan
      screenSpacePanning={false}
      panSpeed={0.8}
      // tilt: keep the horizon below the camera
      maxPolarAngle={Math.PI / 2 - 0.02}
      minPolarAngle={0.05}
      onChange={snapTarget}
    />
  );
}
