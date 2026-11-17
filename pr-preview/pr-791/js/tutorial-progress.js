// ============================================================
// TUTORIAL PROGRESS (pure) — has this player been through the tutorial?
// ============================================================
//
// D6 (#400) / #399: playtesters went straight to Today's Road, never saw the
// tutorial, and found everything too sensitive. So the first SOLO a player
// chooses goes into the tutorial, until they finish it or press SKIP.
//
// A returning player is not forced back in. That's anyone who calibrated in an
// earlier build (saved motion tuning, 'tandemonium_motion_tuning…') and — m12,
// PR #397 review — anyone who has plainly played before on keyboard or stick:
// a personal record, an earned achievement, a wallet or Slingshot save with
// progress, or a Today's Road entry.
//
// DOM-free so it can be tested: the store is any object with get(key),
// set(key, value) and keys().

export const TUTORIAL_DONE_KEY = 'tandemonium_tutorial_done';
export const MOTION_TUNING_PREFIX = 'tandemonium_motion_tuning';
// The save keys that show earlier play. Literals (not imported) so this module
// stays dependency-free; they match js/records.js, js/achievements.js,
// js/wallet.js, js/slingshot.js and js/daily-ride.js.
export const PLAYED_BEFORE_KEYS = {
  records: 'tandemonium_records',
  achievements: 'tandemonium_achievements',
  wallet: 'tandemonium_wallet',
  slingshot: 'tandemonium_slingshot',
  daily: 'tandemonium_daily',
};

const parse = (store, k) => {
  try { const raw = store.get(k); return raw ? JSON.parse(raw) : null; } catch { return null; }
};
const pos = (v) => Number.isFinite(v) && v > 0;
const nonEmptyObject = (o) => !!o && typeof o === 'object' && Object.keys(o).length > 0;

/** True if the store holds progress from earlier play (m12). */
export function hasPlayedBefore(store) {
  const K = PLAYED_BEFORE_KEYS;
  const recs = parse(store, K.records);
  if (nonEmptyObject(recs) && !Array.isArray(recs)) return true;
  const ach = parse(store, K.achievements);
  if (Array.isArray(ach) && ach.length > 0) return true;
  const w = parse(store, K.wallet);
  if (w && typeof w === 'object' && (pos(w.coins) || pos(w.earned) || pos(w.rebuilds) ||
      (w.lv && typeof w.lv === 'object' && Object.values(w.lv).some(pos)))) return true;
  const s = parse(store, K.slingshot);
  if (s && typeof s === 'object' && (pos(s.runs) || pos(s.best) || s.stage > 1 || pos(s.coins))) return true;
  const daily = parse(store, K.daily);
  if (nonEmptyObject(daily) && !Array.isArray(daily)) return true;
  return false;
}

/** Finished or skipped the tutorial, calibrated in an earlier build, or has played before. */
export function isTutorialDone(store) {
  try {
    if (store.get(TUTORIAL_DONE_KEY)) return true;
    const keys = store.keys ? store.keys() : [];
    if (keys.some(k => typeof k === 'string' && k.startsWith(MOTION_TUNING_PREFIX))) return true;
    return hasPlayedBefore(store);
  } catch {
    // Storage blocked: never trap someone in a tutorial loop.
    return true;
  }
}

/** @param {'complete'|'skip'} how */
export function markTutorialDone(store, how = 'complete') {
  try { store.set(TUTORIAL_DONE_KEY, how); } catch { /* private mode */ }
}

/** The localStorage-backed store the game uses. */
export function tutorialStore() {
  return {
    get: (k) => localStorage.getItem(k),
    set: (k, v) => localStorage.setItem(k, v),
    keys: () => {
      const out = [];
      for (let i = 0; i < localStorage.length; i++) out.push(localStorage.key(i));
      return out;
    }
  };
}
