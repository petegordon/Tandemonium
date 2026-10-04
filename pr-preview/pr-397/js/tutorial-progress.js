// ============================================================
// TUTORIAL PROGRESS (pure) — has this player been through the tutorial?
// ============================================================
//
// D6 (#400) / #399: playtesters went straight to Today's Road, never saw the
// tutorial, and found everything too sensitive. So the first SOLO a player
// chooses goes into the tutorial, until they finish it or press SKIP.
//
// A player who calibrated in an earlier build already has saved motion tuning
// ('tandemonium_motion_tuning…'); they have been through it, so they count as
// done and are not forced back in.
//
// DOM-free so it can be tested: the store is any object with get(key),
// set(key, value) and keys().

export const TUTORIAL_DONE_KEY = 'tandemonium_tutorial_done';
export const MOTION_TUNING_PREFIX = 'tandemonium_motion_tuning';

/** Finished or skipped the tutorial, or calibrated in an earlier build. */
export function isTutorialDone(store) {
  try {
    if (store.get(TUTORIAL_DONE_KEY)) return true;
    const keys = store.keys ? store.keys() : [];
    return keys.some(k => typeof k === 'string' && k.startsWith(MOTION_TUNING_PREFIX));
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
