# Tourist Mode (#333) — ride real-world terrain via Google Photorealistic 3D Tiles

Tourist Mode rides the existing 3D tandem through **real-world locations** streamed
from **Google Photorealistic 3D Tiles**. It reuses the bike, POV/follow camera,
free-form movement, and main loop unchanged — only the *world source* swaps. The
v1 goal is **ride feel**: the bike hugs real ground and pitches with real hills.

Activate with the URL param **`?mode=tourist`** (e.g. `index.html?mode=tourist`).

Default location: **Scioto Mile / Bicentennial Park, downtown Columbus, OH**
(`39.9576, -83.0007`) — a real riverfront bike promenade with skyline scenery and
dense Photorealistic 3D Tiles coverage. Change the default in `js/tourist-config.js`
(`TOURIST_ORIGIN`).

## Riding somewhere else

Point Tourist Mode at any coordinates with **`?lat=` / `?lon=`**:

```
?mode=tourist&lat=39.9576&lon=-83.0007
```

| Param  | Required | Meaning |
| ------ | -------- | ------- |
| `lat`  | with `lon` | Latitude in degrees. Out-of-range values fall back to the default. |
| `lon`  | with `lat` | Longitude in degrees. |
| `h`    | no       | Anchor height (m above the WGS84 ellipsoid). Rarely needed — see below. |
| `name` | no       | Label for the console line; cosmetic. |

**You do not need to know the elevation** — `resolveTouristOrigin()` looks it up at
boot and anchors `ANCHOR_MARGIN` (150 m) above it. Pass `?h=` only to override that.

### Elevation lookup and the extra key permissions

Primary source is **Google's `ElevationService`**, from the Maps JavaScript API —
same key, vendor and billing account as the tiles, so there is no third-party
dependency on the boot path. A keyless service is kept only as a fallback.

It must be the *Maps JavaScript* service. The Elevation **web service**
(`maps.googleapis.com/maps/api/elevation/json`) is not usable here: it sends no CORS
headers, so a browser cannot call it, and it ignores HTTP-referrer restrictions —
which is precisely how this key is locked down.

⚠️ **This needs key permissions the Map Tiles setup did not.** In Google Cloud
Console, on the same key:

1. Enable **Maps JavaScript API**.
2. Enable **Elevation API**.
3. Under the key's **API restrictions**, add both alongside Map Tiles API. A key
   restricted to Map Tiles alone will reject the lookup.

Referrer restrictions and billing are unchanged. If the lookup is rejected you get a
console warning naming this step, the fallback source takes over, and the ride still
works — so a missed step degrades quietly rather than breaking. Watch the boot line
to see which source won:

```
[Tourist] riding 39.70850, -104.81000 — anchor 1819m (Google ElevationService)
```

In Electron the same key needs a matching `Referer` on `maps.googleapis.com` as well
as `tile.googleapis.com`; `electron/main.js` covers both.

### Why the anchor height actually matters

It is tempting to think any anchor works, since the bike spawns at local `y≈0` and a
downward raycast finds the real ground anyway. That reasoning has a hole, and it cost
a debugging session:

Google's tileset is **rooted at the whole globe**, so the first geometry to stream is
an extremely coarse approximation. A triangle spanning hundreds of km chords straight
through the ellipsoid and sags *kilometres* below the true surface. Probe against that
and you get a ground height wildly too low. The bike descends to it — and because the
probe starts a fixed distance above the bike, the real ground is now *above* the ray
origin, where a downward ray can never find it. `hits=0` forever, rider frozen
kilometres underground looking at open sky through the terrain's back faces.

Observed at Aurora, CO with a blind 1500 m anchor: first hit at local `-4831`
(ellipsoid ≈ −3331 m, a ~400 km tile sagging ~3.3 km), then `hits=0` permanently.

Two defences, both in place:

1. **A roughly-correct anchor keeps the probe window tight.** With the ground reliably
   ~150–250 m below the anchor, `TOURIST_TUNE.spawnProbeHeight`/`rayLength` (300 m up,
   2 km reach) put those coarse root-tile hits **out of range**, so they are never
   accepted. Only a blind-guess anchor falls back to the wide `customProbe` window.
2. **The probe origin is clamped to the anchor plane** (`Math.max(bikePos.y + probeUp,
   probeUp)`). Without this the probe is a one-way trapdoor; with it, the bike can
   always climb back out of a bad hit.

The accuracy of the elevation is irrelevant — only that it is **above** the ground.
`ANCHOR_MARGIN` is sized to cover geoid undulation (−107 m to +85 m worldwide; the
service returns height above sea level, the anchor wants height above the WGS84
ellipsoid) plus the gap between bare terrain and the photogrammetry surface, which
includes buildings and bridge decks.

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

---

## Ride the distance between you (E-6 … E-8)

The v1 above is free-roam around one anchor. The plan's headline feature is the
pair version: **two addresses become a ride from one to the other**.

Lobby → **📍 RIDE THE DISTANCE BETWEEN YOU** → two addresses → the game
geocodes both, shows the real distance ("Ride the distance between you:
1,873 km"), and rides it.

- The route is a **straight great-circle line**, not road-routed. The bike flies
  over photogrammetry, so real roads do not matter — and a straight line keeps
  tile usage predictable, which is a billing property, not an aesthetic one.
- **Under 5 km:** the whole distance is the ride.
- **Over 5 km:** you ride the **first 2.5 km and the last 2.5 km** with the
  middle skipped ("✂️ 1,865 km skipped"). You leave your street and you arrive
  at theirs, which is the part that means anything. The HUD keeps saying the
  **real** distance throughout — that number is the entire feature.
- The pair's last route is remembered, so the second ride is one button.
- Route maths lives in `js/tourist-route.js`, is pure, and is unit tested
  against known real-world distances.

### Extra key permission

Geocoding uses the **Maps JavaScript Geocoder**, so the key needs the
**Geocoding API** enabled and allowed under API restrictions, alongside Map
Tiles, Maps JavaScript and Elevation. Same reason as the elevation lookup: the
Geocoding *web service* sends no CORS headers and ignores referrer
restrictions, which is exactly how this key is locked down.

## Billing bound (E-5)

Photorealistic 3D Tiles are **metered per request**. A rider heading in a
straight line forever streams new tiles for as long as they keep going, so:

- `TOURIST_MAX_RADIUS_M` (3 km, `js/tourist-config.js`) is a hard limit on how
  far from the anchor a free-roam ride may go. At the edge the bike is turned
  around with an on-screen message rather than being allowed to stream the
  planet.
- A **planned route** sets its own budget: its ridable length plus 500 m. Since
  the route is itself capped at 5 km, a single ride can never bill for more
  than that.

**Before turning the Options entry on for the public**, set a budget alert in
Google Cloud for the Map Tiles / Maps JavaScript / Geocoding APIs. The code
bounds how much *one ride* can request; only a budget alert bounds how much
*everyone* can.

## Where the entry points are

| Entry | Where | Notes |
|---|---|---|
| `?mode=tourist` | URL | free-roam at the default origin |
| **Explore (beta)** | Options panel | same thing, one click |
| **📍 Ride the distance between you** | lobby mode screen | the two-address ride |

All three are **hidden unless a Maps key is present**. Without a key the mode
can only disappoint, and an entry point that fails is worse than no entry point
— that is the lesson of #350.
