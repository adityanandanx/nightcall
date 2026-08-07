# nightcall

Re:Earth Terrain's globe, drawn with **React Three Fiber**.

Streams quantized-mesh terrain from `https://terrain.reearth.land` onto the WGS84 ellipsoid, with zoom-driven LOD: coarse tiles from space, finer terrain as you zoom in — crack-free, on our own R3F terrain engine (no Navara dependency).

Planned (later maps): react-three-rapier physics, full viewer UI, deployment.

## Wayfinding

This effort is charted as a `/wayfinder` map on the issue tracker:

- **Map:** [Wayfinder map: R3F globe with zoom-driven terrain LOD](https://github.com/adityanandanx/nightcall/issues/1)
- Tickets are child issues labelled `wayfinder:*`; the frontier is the open, unblocked, unclaimed ones.

## Status

Charting in progress — research subagents resolving the first frontier tickets.
