// ============================================================
// RAPIER RUNTIME — lazy, fail-open access to the physics sidecar
// ============================================================
//
// Rapier is NOT a dependency of the ride loop and must never become one. The
// balance model in bike-model.js is a hand-tuned inverted pendulum on a spline;
// a solver has nothing to add to it and everything to fight it. What Rapier is
// here for is the transient debris nobody wants to hand-animate: the crash
// tumble, a struck pylon, a goose that didn't get out of the way.
//
// Three rules this module exists to enforce (see issue #388):
//
//   1. LAZY. @dimforge/rapier3d-compat is ~1.06 MB gzipped with the WASM
//      inlined as base64. Loading that at boot to pay for an effect most rides
//      never trigger would be indefensible, so nothing is fetched until the
//      first effect actually fires. Import this module freely — it costs
//      nothing until ensureRapier() is awaited.
//   2. FAIL OPEN. Offline, a blocked CDN, an Electron build that forgot to
//      vendor the file: every one of those resolves to null and every caller
//      no-ops back to today's behaviour. A crash still crashes, a pylon still
//      stops you. The failure is cached, because a game that retries a 1 MB
//      fetch on every crash is worse than one with no ragdolls.
//   3. SINGLE INIT. RAPIER.init() compiles the WASM module. Concurrent callers
//      share one promise; it is never run twice.
// ============================================================

// Pinned deliberately. Rapier's JS surface moves between minors (0.12 renamed
// half the collider builders), and a game that loads "latest" from a CDN is one
// upstream release away from crashing on a player's machine with no code change
// on our side.
const RAPIER_VERSION = '0.20.0';
const RAPIER_CDN = `https://cdn.jsdelivr.net/npm/@dimforge/rapier3d-compat@${RAPIER_VERSION}/dist/rapier.mjs`;

// Electron ships offline: scripts/download-vendors.js mirrors the same file
// into vendor/. Desktop tries local first (no network round trip, works on a
// plane); web tries the CDN first and falls back to vendor/ if the repo happens
// to carry it. Either way both are attempted before giving up.
const RAPIER_VENDOR = '../../vendor/rapier.mjs';

const isElectron = typeof navigator !== 'undefined'
  && navigator.userAgent.includes('Electron');

let _promise = null;

/**
 * Resolve the Rapier namespace, or null if it can't be had.
 *
 * Always await this — never import Rapier directly at a call site, or the
 * lazy-load guarantee is gone and every player pays the megabyte.
 *
 * @returns {Promise<object|null>} initialised RAPIER, or null on any failure
 */
export function ensureRapier() {
  if (_promise) return _promise;
  _promise = _load().catch((err) => {
    // Cached as a resolved null, not a rejection: callers treat "no physics"
    // as ordinary, and an unhandled rejection in a game loop is noise.
    console.warn('[physics] Rapier unavailable — effects disabled:', err && err.message);
    return null;
  });
  return _promise;
}

async function _load() {
  const sources = isElectron
    ? [RAPIER_VENDOR, RAPIER_CDN]
    : [RAPIER_CDN, RAPIER_VENDOR];

  let lastErr = null;
  for (const src of sources) {
    try {
      const mod = await import(/* @vite-ignore */ src);
      const RAPIER = mod.default || mod;
      if (!RAPIER || typeof RAPIER.init !== 'function') {
        throw new Error(`no init() export from ${src}`);
      }
      await RAPIER.init();
      return RAPIER;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('no Rapier source reachable');
}

/**
 * Kick off the download without blocking, so the first crash of a session
 * doesn't pay for the fetch mid-tumble. Call it somewhere idle (we use the
 * countdown). Safe to call repeatedly; safe never to call at all.
 */
export function warmRapier() {
  ensureRapier();
}
