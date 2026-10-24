// @ts-check
// ============================================================
// QUALITY TIERS — High / Medium / Low, plus Auto
// ============================================================
//
// High   — full quality (the default on a capable desktop).
// Medium — what "Low" used to be: half resolution, no shadows, no
//          anti-aliasing, coarser ground, no physics effects.
// Low    — Medium plus everything a TV-class device can't afford: the
//          goose riders default off (Show Riders still wins if set), no
//          rider-cam picture-in-picture, the scene behind the lobby and
//          the pause menu redrawn only a few times a second, trees drawn
//          in one batch and only so far ahead, and a closer fog.
//
// Auto starts from hardware detection (a "low" GPU starts at Medium) and
// then watches the real frame rate during rides, stepping down a tier
// when a ride stays slow (AutoTierWatcher). The step down is remembered.
// ============================================================

/** @typedef {'low'|'medium'|'high'} QualityTier */

export const QUALITY_TIERS = /** @type {const} */ (['low', 'medium', 'high']);
const PREF_KEY = 'tandemonium_quality';
const PREF_VERSION_KEY = 'tandemonium_quality_v';
const AUTO_TIER_KEY = 'tandemonium_auto_tier';
const AUTO_TIER_DAYS = 7;

/** @param {any} v @returns {v is QualityTier} */
export const isTier = (v) => QUALITY_TIERS.includes(v);

/** One step down (Low stays Low). @param {QualityTier} t @returns {QualityTier} */
export const tierBelow = (t) => (t === 'high' ? 'medium' : 'low');

/**
 * The lowest tier Auto steps down to. Low turns the riders off by default,
 * so on a desktop it stays a manual choice; phones and TVs already ride
 * without riders and get everything Low saves.
 * @param {boolean} mobile @returns {QualityTier}
 */
export const autoFloorTier = (mobile) => (mobile ? 'low' : 'medium');

/** Low 0, Medium 1, High 2. @param {QualityTier} t */
export const tierRank = (t) => ({ low: 0, medium: 1, high: 2 })[t] ?? 2;

/**
 * Before three tiers, "Low" meant what Medium means now. A saved "low" from
 * then is moved to "medium", once, so nobody's game gets uglier on update.
 * @param {Storage} [store]
 */
export function migrateQualityPref(store = globalThis.localStorage) {
  try {
    if (store.getItem(PREF_VERSION_KEY) === '3') return;
    if (store.getItem(PREF_KEY) === 'low') store.setItem(PREF_KEY, 'medium');
    store.setItem(PREF_VERSION_KEY, '3');
  } catch { /* storage unavailable */ }
}

/** The saved Options choice: a tier, or 'auto'. @param {Storage} [store] */
export function getQualityPref(store = globalThis.localStorage) {
  try {
    const v = store.getItem(PREF_KEY);
    if (isTier(v)) return v;
  } catch { /* storage unavailable */ }
  return 'auto';
}

/** @param {QualityTier|'auto'} pref @param {Storage} [store] */
export function setQualityPref(pref, store = globalThis.localStorage) {
  try {
    store.setItem(PREF_KEY, pref);
    store.setItem(PREF_VERSION_KEY, '3');
    if (pref === 'auto') store.removeItem(AUTO_TIER_KEY);   // re-learn from scratch
  } catch { /* storage unavailable */ }
}

/** The tier Auto learned from slow rides, if still fresh. @param {Storage} [store] @returns {QualityTier|null} */
export function getLearnedAutoTier(store = globalThis.localStorage, now = Date.now()) {
  try {
    const raw = store.getItem(AUTO_TIER_KEY);
    if (!raw) return null;
    const { tier, at } = JSON.parse(raw);
    if (!isTier(tier) || now - at > AUTO_TIER_DAYS * 86400000) return null;
    return tier;
  } catch { return null; }
}

/** @param {QualityTier} tier @param {Storage} [store] */
export function saveLearnedAutoTier(tier, store = globalThis.localStorage, now = Date.now()) {
  try { store.setItem(AUTO_TIER_KEY, JSON.stringify({ tier, at: now })); } catch { /* storage unavailable */ }
}

/**
 * The tier to run at. URL ?quality= wins, then the Options choice, then
 * Auto: what slow rides taught it, else hardware detection.
 * @param {{ param?: string|null, pref?: string, learned?: QualityTier|null, hwTier?: string|null, floor?: QualityTier }} o
 * @returns {{ tier: QualityTier, auto: boolean }}
 */
export function resolveQualityTier({ param = null, pref = 'auto', learned = null, hwTier = null, floor = 'low' }) {
  if (isTier(param)) return { tier: param, auto: false };
  if (isTier(pref)) return { tier: pref, auto: false };
  // A learned tier below what Auto may pick here (one saved before the
  // desktop floor existed) comes back up to the floor.
  if (learned) return { tier: tierRank(learned) < tierRank(floor) ? floor : learned, auto: true };
  return { tier: hwTier === 'low' ? 'medium' : 'high', auto: true };
}

// ── The current tier, shared with modules that build their own renderers ──

/** @type {QualityTier} */
// ── Keeping the drawing buffer (#456) ──
// preserveDrawingBuffer keeps each frame's buffer for the next one, which on
// TV / phone GPUs costs a full-screen copy every frame. Only clip recording
// wants it, and it's a context-creation flag, so it's decided once at boot.

/** The last clip GPU probe said clips are too slow here ('1' / '0'), saved for the next boot. */
export const CLIP_SLOW_KEY = 'tandemonium_clip_gpu_slow';

/**
 * Will clip recording be off this session, as far as the game can tell before
 * the WebGL canvas exists? ?noclip, no way to record here, or the GPU probe
 * failed last time. (A probe that passes this time still records fine without
 * the kept buffer: the recorder copies the canvas right after each render, in
 * the same task, the way the probe itself does.)
 * @param {{ search?: string, canRecord?: boolean, store?: Storage }} [o]
 */
export function clipsOffAtBoot({ search = '', canRecord = true, store = globalThis.localStorage } = {}) {
  if (new URLSearchParams(search).has('noclip') || !canRecord) return true;
  try { return store.getItem(CLIP_SLOW_KEY) === '1'; } catch { return false; }
}

/** Keep the drawing buffer? Only Low gives it up, and only when clips are off. @param {QualityTier} tier @param {boolean} clipsOff */
export const keepDrawingBuffer = (tier, clipsOff) => !(tier === 'low' && clipsOff);

let _current = 'high';
export const getCurrentTier = () => _current;
/** @param {QualityTier} t */
export const setCurrentTier = (t) => { _current = t; };

/**
 * Watches ride frame rate for Auto. Feed it every frame while a ride is on
 * screen; it says 'down' once a full window averages under MIN_FPS.
 * Long gaps (a tab switch, a load hitch) are skipped, and after a change it
 * waits a grace period for the new settings to settle.
 */
export class AutoTierWatcher {
  constructor({ minFps = 24, windowSec = 8, graceSec = 6 } = {}) {
    this.minFps = minFps;
    this.windowSec = windowSec;
    this.graceSec = graceSec;
    this.reset();   // the first seconds of a ride warm up shaders
  }

  /** @param {number} [grace] seconds to wait before judging */
  reset(grace = this.graceSec) {
    this._grace = grace;
    this._time = 0;
    this._frames = 0;
  }

  /**
   * @param {number} dt seconds since the last frame (unclamped)
   * @returns {'down'|null}
   */
  sample(dt) {
    if (!(dt > 0) || dt > 1) return null;       // a pause, not a frame
    if (this._grace > 0) { this._grace -= dt; return null; }
    this._time += dt;
    this._frames++;
    if (this._time < this.windowSec) return null;
    const fps = this._frames / this._time;
    this._time = 0;
    this._frames = 0;
    if (fps < this.minFps) { this.reset(); return 'down'; }
    return null;
  }
}

// ── Display testing (Options → Display Testing, or ?lines= / ?aa= / ?debug=perf) ──
// For tuning weak screens like a TV: render lines, edge smoothing and an
// on-screen perf readout. Saved settings apply on load; the page reloads
// when one changes (edge smoothing can only be set when the renderer is made).

const DISPLAY_TEST_KEY = 'tandemonium_display_test';
export const DISPLAY_TEST_LINES = [0, 540, 720, 1080];   // 0 = the tier's own

/**
 * @typedef {{ lines: number, aa: 'tier'|'on'|'off', perf: boolean }} DisplayTest
 */

/** @param {any} n @returns {number} 0, or a line count in 180..2160 */
const cleanLines = (n) => { const v = parseInt(n, 10); return v >= 180 && v <= 2160 ? v : 0; };

/** @returns {DisplayTest} */
export function getDisplayTest(store = globalThis.localStorage) {
  let s = null;
  try { s = JSON.parse(store.getItem(DISPLAY_TEST_KEY) || 'null'); } catch { /* bad / no storage */ }
  return {
    lines: cleanLines(s && s.lines),
    aa: s && (s.aa === 'on' || s.aa === 'off') ? s.aa : 'tier',
    perf: !!(s && s.perf),
  };
}

/** @param {Partial<DisplayTest>} patch @returns {DisplayTest} */
export function setDisplayTest(patch, store = globalThis.localStorage) {
  const next = { ...getDisplayTest(store), ...patch };
  next.lines = cleanLines(next.lines);
  try { store.setItem(DISPLAY_TEST_KEY, JSON.stringify(next)); } catch { /* storage unavailable */ }
  return next;
}

/**
 * The display test in effect: URL switches win over the saved settings.
 * @param {URLSearchParams} params @param {DisplayTest} saved @returns {DisplayTest}
 */
export function resolveDisplayTest(params, saved) {
  const aa = params.get('aa');
  return {
    lines: cleanLines(params.get('lines')) || saved.lines,
    aa: aa === '1' ? 'on' : aa === '0' ? 'off' : saved.aa,
    perf: params.get('debug') === 'perf' || saved.perf,
  };
}

/** Reload without the URL switches (so saved settings apply) and past the HTML cache. */
export function reloadForDisplayTest(loc = globalThis.location) {
  const url = new URL(loc.href);
  for (const k of ['lines', 'aa', 'debug', '_r']) url.searchParams.delete(k);
  url.searchParams.set('_r', String(Date.now()));
  loc.replace(url.toString());
}

/** Back to the tier's own settings (Options → Display Testing → Reset). */
export function clearDisplayTest(store = globalThis.localStorage) {
  try { store.removeItem(DISPLAY_TEST_KEY); } catch { /* storage unavailable */ }
}

/** @param {DisplayTest} t */
export const displayTestActive = (t) => !!(t.lines || t.aa !== 'tier' || t.perf);
