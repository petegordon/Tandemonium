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

/**
 * LAST-RESORT anchor height (metres above the WGS84 ellipsoid) when ?lat/?lon is
 * given but the elevation lookup failed and no ?h was supplied. It is a blind
 * guess, so it forces the wide TOURIST_TUNE.customProbe window.
 *
 * Prefer resolveTouristOrigin() — see the long note there for why a *roughly*
 * correct anchor matters far more than it looks.
 */
export const TOURIST_CUSTOM_HEIGHT = 1500;

/**
 * How far ABOVE the looked-up ground elevation to place the anchor, in metres.
 *
 * Sized to swallow two errors at once:
 *   - Geoid separation. The elevation service returns height above mean sea
 *     level, but the anchor wants height above the WGS84 *ellipsoid*. The two
 *     differ by the geoid undulation, which ranges about -107 m to +85 m
 *     worldwide. 150 > 85, so the anchor stays above ground everywhere.
 *   - Surface vs terrain. The service reports bare terrain; the tiles are
 *     photogrammetry, so the rideable surface includes buildings and bridge
 *     decks that sit above it.
 *
 * Being above ground is the ONLY property that has to hold — the first ground
 * raycast removes the offset. Being below it spawns the rider inside the
 * terrain, which renders as open sky through the back faces.
 */
export const ANCHOR_MARGIN = 150;

// --- Elevation sources -------------------------------------------------------
// Google's ElevationService is primary: same key, same vendor and same billing
// account as the tiles themselves, so there is no extra third-party dependency
// on the boot path. It must be the *Maps JavaScript API* service, not the
// Elevation web service (maps.googleapis.com/maps/api/elevation/json) — that one
// sends no CORS headers and cannot be called from a browser, and it ignores HTTP
// referrer restrictions, which is exactly how this key is locked down.
//
// REQUIRES on the Google Cloud key: "Maps JavaScript API" and "Elevation API"
// both enabled AND both added to the key's API restrictions (it was previously
// restricted to the Map Tiles API alone, which rejects these calls).
const MAPS_JS_URL = 'https://maps.googleapis.com/maps/api/js';
/** Keyless CORS fallback, used only when Google's lookup fails. */
const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/elevation';
const ELEVATION_TIMEOUT_MS = 6000;

let _mapsJsPromise = null;

/** Inject the Maps JavaScript API once; resolves when its callback fires. */
function loadMapsJs(apiKey) {
  if (_mapsJsPromise) return _mapsJsPromise;
  _mapsJsPromise = new Promise((resolve, reject) => {
    const CB = '__touristMapsReady';
    window[CB] = () => { delete window[CB]; resolve(); };
    const script = document.createElement('script');
    script.async = true;
    script.src = `${MAPS_JS_URL}?key=${encodeURIComponent(apiKey)}` +
      `&loading=async&libraries=elevation&callback=${CB}`;
    script.onerror = () => reject(new Error('Maps JS API script failed to load'));
    document.head.appendChild(script);
  });
  return _mapsJsPromise;
}

/** Ground elevation in metres above sea level, via the Maps JS ElevationService. */
async function elevationFromGoogle(lat, lon, apiKey) {
  if (!apiKey) throw new Error('no Maps API key available');
  await loadMapsJs(apiKey);
  const { ElevationService } = await google.maps.importLibrary('elevation');
  const { results } = await new ElevationService()
    .getElevationForLocations({ locations: [{ lat, lng: lon }] });
  const elevation = results?.[0]?.elevation;
  if (!Number.isFinite(elevation)) throw new Error('empty ElevationService result');
  return elevation;
}

/** Same units (metres above sea level), so ANCHOR_MARGIN reasoning is unchanged. */
async function elevationFromOpenMeteo(lat, lon) {
  const res = await fetch(`${OPEN_METEO_URL}?latitude=${lat}&longitude=${lon}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const elevation = Array.isArray(data?.elevation) ? Number(data.elevation[0]) : NaN;
  if (!Number.isFinite(elevation)) throw new Error('empty elevation response');
  return elevation;
}

/** Bound a lookup so a hung network never stalls boot behind ELEVATION_TIMEOUT_MS. */
function withTimeout(promise, label) {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), ELEVATION_TIMEOUT_MS);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

/** Filled in by resolveTouristOrigin(); read back by getTouristOrigin(). */
let _resolvedOrigin = null;

/** Parse ?lat/?lon/?h/?name, or null when this isn't a custom-location ride. */
function parseOriginParams() {
  const q = new URLSearchParams(window.location.search);
  const lat = Number.parseFloat(q.get('lat'));
  const lon = Number.parseFloat(q.get('lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    console.warn(`[Tourist] ignoring out-of-range lat/lon (${lat}, ${lon}); using ${TOURIST_ORIGIN.name}`);
    return null;
  }
  return {
    lat,
    lon,
    h: Number.parseFloat(q.get('h')),
    name: q.get('name') || `${lat.toFixed(5)}, ${lon.toFixed(5)}`,
  };
}

/**
 * Resolve the anchor height for a ?lat/?lon ride BEFORE the world is built, by
 * looking up the ground elevation. Await this once at boot; getTouristOrigin()
 * then returns the result synchronously. No-op for the default location.
 *
 * WHY THIS EXISTS (it is not cosmetic — it was a real bug):
 * The anchor only defines the local ENU frame, so it seems like any value would
 * do: the bike spawns at local y≈0 and a downward raycast finds the true ground.
 * That reasoning has a hole. Google's tileset is rooted at the whole globe, so
 * the FIRST geometry to stream is an extremely coarse approximation — a triangle
 * spanning hundreds of km chords through the ellipsoid and sags kilometres below
 * the real surface. Probing against that returns a ground height that is wildly
 * too low, and once the bike descends to it the probe (which starts a fixed
 * distance above the bike) can no longer see back up to the real ground. The
 * rider ends up frozen kilometres underground with hits=0 forever.
 *
 * A roughly-correct anchor fixes this structurally: it lets the probe window be
 * TIGHT (TOURIST_TUNE.spawnProbeHeight/rayLength), which puts those coarse
 * root-tile hits out of range entirely, so they are never accepted in the first
 * place. The elevation does not need to be accurate — only close enough to keep
 * the real ground inside a narrow window, and biased high (see ANCHOR_MARGIN).
 */
export async function resolveTouristOrigin() {
  const p = parseOriginParams();
  if (!p) return;

  const base = { name: p.name, lat: p.lat, lon: p.lon, heading: 0, custom: true };

  // An explicit ?h is a deliberate choice — trust it, and treat it as anchored
  // so the tight probe window applies.
  if (Number.isFinite(p.h)) {
    _resolvedOrigin = { ...base, height: p.h, anchored: true };
    return;
  }

  let elevation = NaN;
  let source = null;
  try {
    elevation = await withTimeout(
      elevationFromGoogle(p.lat, p.lon, getMapsApiKey()), 'Google ElevationService');
    source = 'Google ElevationService';
  } catch (err) {
    console.warn(`[Tourist] Google ElevationService unavailable (${err.message}). ` +
      'Check the Cloud key has BOTH "Maps JavaScript API" and "Elevation API" enabled ' +
      'and allowed in its API restrictions. Trying the fallback source.');
    try {
      elevation = await withTimeout(
        elevationFromOpenMeteo(p.lat, p.lon), 'fallback elevation lookup');
      source = 'open-meteo fallback';
    } catch (err2) {
      // Non-fatal: getTouristOrigin() falls back to the blind guess + wide probe.
      console.warn(`[Tourist] elevation lookup failed (${err2.message}); ` +
        `falling back to a ${TOURIST_CUSTOM_HEIGHT}m anchor and a wide ground probe. ` +
        'Pass ?h=<metres above the ellipsoid> to set it explicitly.');
    }
  }

  if (Number.isFinite(elevation)) {
    _resolvedOrigin = { ...base, height: elevation + ANCHOR_MARGIN, anchored: true, elevation, source };
  }
}

/**
 * Resolve the ride location. Defaults to TOURIST_ORIGIN (Scioto Mile), and can
 * be pointed at any address via URL params — this is what makes Tourist Mode
 * testable on a phone against unfamiliar streets:
 *
 *   ?mode=tourist&lat=39.9576&lon=-83.0007
 *   ...&h=230         optional explicit anchor height; skips the elevation lookup
 *   ...&name=Broad+St optional label
 *
 * `anchored: true` means the height came from a lookup or an explicit ?h and is
 * trustworthy enough for the tight probe window. Invalid values fall back to the
 * default location rather than dropping the rider into the void.
 */
export function getTouristOrigin() {
  if (_resolvedOrigin) return _resolvedOrigin;
  const p = parseOriginParams();
  if (!p) return TOURIST_ORIGIN;
  return {
    name: p.name,
    lat: p.lat,
    lon: p.lon,
    height: Number.isFinite(p.h) ? p.h : TOURIST_CUSTOM_HEIGHT,
    heading: 0,
    custom: true,
    // Blind guess — the world widens its ground probe to compensate.
    anchored: Number.isFinite(p.h),
  };
}

/** Shared tuning for the tourist world. */
export const TOURIST_TUNE = {
  // Wheel contact offset: how far above a downward ray hit the bike origin sits.
  wheelOffset: 0.4,
  // Max downward ray length when probing for ground (metres). Generous so the
  // probe still finds the surface when the spawn height guess is off.
  rayLength: 2000,
  // How high above the bike to begin each downward ground probe (metres).
  spawnProbeHeight: 300,

  // Probe window for a custom ?lat/?lon ride, where the anchor height is a
  // guess (TOURIST_CUSTOM_HEIGHT) rather than a value tuned against the terrain.
  // The bike starts at local y≈0 and real ground sits at (groundEllipsoidH −
  // anchorH), so the probe must reach far DOWN for a high guess and still start
  // above the bike for a low one. These bounds cover ground from below sea level
  // up past any rideable elevation on Earth.
  customProbe: {
    spawnProbeHeight: 2000,
    rayLength: 14000,
  },
  // Ground-follow vertical smoothing (higher = snappier). Eased to avoid pops
  // when tiles stream in/out and a frame has no ray hit.
  groundLerp: 8,

  // Seconds of sustained "no ground found" (after tiles start streaming) before
  // telling the rider this location has no photogrammetry coverage. Long enough
  // that ordinary streaming gaps — or a slow first load — never trip it.
  noCoverageAfter: 12,

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
    // errorTarget raises the allowed screen-space error so the renderer stops
    // refining sooner — fewer/lighter tiles in view (default 6). Keep it modest
    // so buildings still read clearly; the cache byte cap is the real ceiling.
    // NOTE: do NOT cap maxDepth here — Google's tileset is rooted at the whole
    // globe and street-level geometry sits dozens of levels down, so a depth cap
    // halts refinement before any buildings load (they vanish). errorTarget +
    // the cache caps bound memory without that failure mode.
    errorTarget: 12,       // 2× desktop → lighter, still legible
    downloadJobs: 4,       // fewer concurrent downloads (library default 10)
    cacheMinBytes: 96 * 1024 * 1024,   // evict down toward ~96 MB  (default 0.3 GB)
    cacheMaxBytes: 128 * 1024 * 1024,  // hard cap ~128 MB          (default 0.4 GB)
    cacheMinTiles: 400,    // item-count floor  (default 6000)
    cacheMaxTiles: 600,    // item-count ceiling (default 8000)
  },

  // Fix #1 (ordering): on mobile, hold off opening the tile firehose until the
  // small bike GLB has finished decoding, so the two don't race for memory.
  // Safety cap (seconds) so tiles still start even if the bike load stalls.
  tileStartMaxWait: 8,
};
