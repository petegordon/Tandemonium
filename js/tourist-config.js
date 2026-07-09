// ============================================================
// TOURIST CONFIG — Tourist Mode (#333) settings
//
// Tourist Mode rides the existing tandem through real-world
// locations streamed from Google Photorealistic 3D Tiles.
// This module centralizes: how the API key is resolved, the
// chosen location, and tuning constants shared across the
// tourist world + road-path shims.
// ============================================================

/**
 * Is Tourist Mode requested? Activated with `?mode=tourist` (matches the
 * existing URL-param convention used for ?quality, ?notrees, ?noclip).
 */
export function isTouristMode() {
  return new URLSearchParams(window.location.search).get('mode') === 'tourist';
}

/**
 * Resolve the Google Map Tiles API key WITHOUT committing it. Resolution order:
 *   1. window.__TOURIST_MAPS_KEY__  — set by gitignored js/tourist-key.local.js
 *      (generated from .env via `npm run gen-tourist-key`)
 *   2. ?key=...                     — URL param, handy for quick testing
 *   3. localStorage 'tourist_maps_key' — persisted manual entry
 * Returns null if none is available.
 */
export function getMapsApiKey() {
  if (typeof window !== 'undefined' && window.__TOURIST_MAPS_KEY__) {
    return window.__TOURIST_MAPS_KEY__;
  }
  const param = new URLSearchParams(window.location.search).get('key');
  if (param) return param;
  try {
    const stored = localStorage.getItem('tourist_maps_key');
    if (stored) return stored;
  } catch (_) { /* localStorage may be unavailable */ }
  return null;
}

/**
 * Starting location for v1: Scioto Mile / Bicentennial Park on the downtown
 * Columbus riverfront — a real bike promenade with skyline scenery and dense
 * Photorealistic 3D Tiles coverage. lat/lon in DEGREES here for readability;
 * the tiles ReorientationPlugin wants RADIANS (see tourist-world.js).
 */
export const TOURIST_ORIGIN = {
  name: 'Scioto Mile · Columbus, OH',
  lat: 39.9576,
  lon: -83.0007,
  // Metres above the WGS84 ellipsoid for the orientation anchor. Tuned so the
  // bike starts near street level; ground-following (Step 4) takes over once
  // tiles load. Refined empirically against the streamed terrain.
  height: 230,
  // Initial bike heading (radians, 0 = +Z). 0 is fine for free-ride v1.
  heading: 0,
};

/** Shared tuning for the tourist world. */
export const TOURIST_TUNE = {
  // Wheel contact offset: how far above a downward ray hit the bike origin sits.
  wheelOffset: 0.4,
  // Max downward ray length when probing for ground (metres). Generous so the
  // probe still finds the surface when the spawn height guess is off.
  rayLength: 2000,
  // How high above the bike to begin each downward ground probe (metres).
  spawnProbeHeight: 300,
  // Ground-follow vertical smoothing (higher = snappier). Eased to avoid pops
  // when tiles stream in/out and a frame has no ray hit.
  groundLerp: 8,

  // Camera far plane (metres). Real hills/skyline run far, so desktop opens it
  // wide; mobile pulls it in to bound how much terrain streams at once.
  cameraFar: 6000,

  // --- Mobile tile budget (iOS web view especially) --------------------------
  // Photorealistic 3D Tiles are memory-hungry. The library defaults to a 0.4 GB
  // tile cache and 10 concurrent downloads — on a mobile browser with a tight
  // per-tab memory ceiling that alone can exhaust the heap and starve OTHER
  // allocations (notably the bike GLB's Draco decode, so the geese never
  // appear). These caps trade some visual detail for headroom on mobile;
  // desktop keeps the library defaults. Applied in tourist-world.js.
  mobile: {
    cameraFar: 3000,       // shorter view distance → less streamed at once
    errorTarget: 24,       // coarser LOD (default 6) → far fewer/lighter tiles
    maxDepth: 12,          // cap subdivision so one view can't balloon
    downloadJobs: 4,       // fewer concurrent downloads (library default 10)
    cacheMinBytes: 64 * 1024 * 1024,   // evict down toward ~64 MB (default 0.3 GB)
    cacheMaxBytes: 96 * 1024 * 1024,   // hard cap ~96 MB   (default 0.4 GB)
    cacheMinTiles: 400,    // item-count floor  (default 6000)
    cacheMaxTiles: 600,    // item-count ceiling (default 8000)
  },

  // Fix #1 (ordering): on mobile, hold off opening the tile firehose until the
  // small bike GLB has finished decoding, so the two don't race for memory.
  // Safety cap (seconds) so tiles still start even if the bike load stalls.
  tileStartMaxWait: 8,
};
