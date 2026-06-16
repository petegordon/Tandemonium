# Tourist Mode (#333) — ride real-world terrain via Google Photorealistic 3D Tiles

Tourist Mode rides the existing 3D tandem through **real-world locations** streamed
from **Google Photorealistic 3D Tiles**. It reuses the bike, POV/follow camera,
free-form movement, and main loop unchanged — only the *world source* swaps. The
v1 goal is **ride feel**: the bike hugs real ground and pitches with real hills.

Activate with the URL param **`?mode=tourist`** (e.g. `index.html?mode=tourist`).

Starting location (v1): **Scioto Mile / Bicentennial Park, downtown Columbus, OH**
(`39.9576, -83.0007`) — a real riverfront bike promenade with skyline scenery and
dense Photorealistic 3D Tiles coverage. Change it in `js/tourist-config.js`
(`TOURIST_ORIGIN`).

## Prerequisites (Google Cloud)

1. Create / pick a Google Cloud project.
2. Enable the **Map Tiles API**.
3. Create an **API key** and **restrict it** (HTTP referrers for web; restrict to
   the Map Tiles API). Photorealistic 3D Tiles are **metered/billed**.
4. **Set a billing budget alert** — tile streaming is metered by usage. Bound the
   explorable area while testing.

## Providing the key (never committed)

The key is resolved at runtime in this order (`js/tourist-config.js`):

1. `window.__TOURIST_MAPS_KEY__` — set by the gitignored `js/tourist-key.local.js`
2. `?key=YOUR_KEY` URL param (quick testing)
3. `localStorage['tourist_maps_key']`

**Recommended:** put the key in `.env` (already gitignored) as:

```
GOOGLE_MAPS_API_KEY=AIza...
```

then generate the gitignored browser module:

```
npm run gen-tourist-key
```

This writes `js/tourist-key.local.js` (gitignored). `index.html` loads it before
the game; a 404 there is harmless when it hasn't been generated.

## How it fits the codebase (the seams)

- **World swap** — `game.js` branches on `?mode=tourist`: `this.world = new TouristWorld(...)`
  instead of `new World(...)`. `TouristWorld` mirrors the slice of `World`'s
  interface the loop uses (`update()`, `.roadPath`, plus no-op stubs for
  race markers / tree collision / balloon color, which are deferred in v1).
- **Bike** — reused unchanged. `bike.roadPath = null` so the procedural slope /
  off-road-drag physics are skipped; `TouristWorld` owns vertical placement.
- **Ground-following (Step 4)** — each frame `TouristWorld.update()` (which runs
  after `bike.update()` and before `chaseCamera.update()`) raycasts straight down
  onto the loaded tile meshes, clamps the bike's Y to the hit + wheel offset, and
  pitches the bike to the ground normal. No-hit frames (tiles still streaming)
  hold the last height to avoid pops.
- **Camera** — `ChaseCamera` calls `roadPath.getHeightAtWorld()`; the
  `TouristRoadPath` shim returns the current ground height so the camera clips
  above terrain.
- **Coordinates** — `ReorientationPlugin` anchors the chosen lat/lon/height at the
  three.js origin with +Y up, so the bike's abstract X/Z world is local
  east/north metres (≈1 unit = 1 m, matching the game's convention).

## Dependency note (three version)

The game pins **three @ 0.161.0** (CDN import map). The current `3d-tiles-renderer`
(0.4.x) requires three ≥ 0.167, so Tourist Mode pins **`3d-tiles-renderer@0.3.46`**
(the last release supporting three ≥ 0.123). It's loaded via **esm.sh with three
kept external** (`?external=three`) so there's a **single three instance** shared
with the game — essential for tile meshes to interop with the game scene.

Import map entries (`index.html`):

```
"three/examples/jsm/": ".../three@0.161.0/examples/jsm/",
"3d-tiles-renderer":         "https://esm.sh/3d-tiles-renderer@0.3.46?external=three",
"3d-tiles-renderer/plugins": "https://esm.sh/3d-tiles-renderer@0.3.46/plugins?external=three"
```

**Future upgrade path:** bumping the game to three ≥ 0.167 would allow
`3d-tiles-renderer@0.4.x` (newer plugins, BatchedTilesPlugin). Deferred to avoid
destabilizing the existing game's rendering.

## Deferred (post-v1)

Horizontal building collision, OpenStreetMap road awareness / speed field,
presents & cones & Grandma's house on real streets, multiplayer tourist rides.
See issue #333.
