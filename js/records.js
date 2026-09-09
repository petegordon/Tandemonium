// ============================================================
// RECORDS (pure) — personal bests, splits and medals
// ============================================================
//
// B-3. Before this the game had no memory of how you did. Every ride was
// scored against nothing, so there was nothing to beat and no reason for a
// second attempt at the same road — the game implemented completion, not
// mastery. A best time, a split delta at each checkpoint and a medal to chase
// are the cheapest possible mastery surface, and they work offline, signed out,
// on the first ride of a session.
//
// This module is storage-shaped but storage-agnostic: every function takes a
// plain `store` object, so it can be unit tested without localStorage. The thin
// localStorage wrapper is at the bottom.

export const STORAGE_KEY = 'tandemonium_records';

/** Keep the store small enough to never be the reason a save fails. */
export const MAX_KEYS = 200;

/**
 * Record key. Modes are kept apart because they are not comparable rides:
 * one person steering is a different game from two.
 * @param {string} levelId  'grandma' | 'castle' | …
 * @param {string} difficulty 'chill' | 'adventurous' | …
 * @param {'solo'|'coop'|'versus'} mode
 */
export function key(levelId, difficulty, mode = 'solo') {
  return `${levelId}|${difficulty}|${mode}`;
}

/** The best run for a key, or null. */
export function getBest(store, k) {
  const rec = store && store[k];
  if (!rec || typeof rec.timeMs !== 'number') return null;
  return rec;
}

/**
 * Record a finished run.
 *
 * @param {object} store    mutated in place (and returned) — the caller saves it
 * @param {string} k        key()
 * @param {object} run      { timeMs, splits?: number[], collectibles?, crashes?, date? }
 * @returns {{ isNewBest: boolean, delta: number|null, best: object }}
 *          `delta` is this run minus the previous best, in ms (negative = faster).
 */
export function recordRun(store, k, run) {
  if (!store || !k || !run || typeof run.timeMs !== 'number' || !(run.timeMs > 0)) {
    return { isNewBest: false, delta: null, best: getBest(store, k) };
  }
  const previous = getBest(store, k);
  const entry = {
    timeMs: Math.round(run.timeMs),
    splits: Array.isArray(run.splits) ? run.splits.map(n => Math.round(n)) : [],
    collectibles: run.collectibles ?? 0,
    crashes: run.crashes ?? 0,
    date: run.date || new Date().toISOString()
  };

  if (!previous) {
    store[k] = entry;
    trim(store);
    return { isNewBest: true, delta: null, best: entry };
  }

  const delta = entry.timeMs - previous.timeMs;
  if (delta < 0) {
    store[k] = entry;
    trim(store);
    return { isNewBest: true, delta, best: entry };
  }
  // A slower run still teaches us something when the old best has no splits.
  if (previous.splits.length === 0 && entry.splits.length > 0) {
    previous.splits = entry.splits;
  }
  return { isNewBest: false, delta, best: previous };
}

/** Drop the oldest entries when the store grows past MAX_KEYS. */
export function trim(store) {
  const keys = Object.keys(store);
  if (keys.length <= MAX_KEYS) return store;
  keys
    .sort((a, b) => String(store[a].date).localeCompare(String(store[b].date)))
    .slice(0, keys.length - MAX_KEYS)
    .forEach(k => { delete store[k]; });
  return store;
}

/**
 * Split delta against the best, in ms, or null when there is nothing to
 * compare to. `index` is the checkpoint number (0-based).
 */
export function splitDelta(best, index, elapsedMs) {
  if (!best || !Array.isArray(best.splits)) return null;
  const target = best.splits[index];
  if (typeof target !== 'number') return null;
  return Math.round(elapsedMs - target);
}

/** "+1.3" / "−0.8" — the sign is the point, so it is always shown. */
export function formatDelta(deltaMs) {
  if (deltaMs === null || deltaMs === undefined) return '';
  const secs = deltaMs / 1000;
  const sign = secs > 0 ? '+' : '−';        // real minus sign
  return sign + Math.abs(secs).toFixed(1);
}

/** "2:41" from milliseconds. */
export function formatTime(ms) {
  if (typeof ms !== 'number' || !isFinite(ms)) return '—';
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Which medal a time earns. `thresholds` is { gold, silver, bronze } in ms;
 * missing thresholds mean the level has no medals yet.
 * @returns {'gold'|'silver'|'bronze'|null}
 */
export function medalFor(timeMs, thresholds) {
  if (!thresholds || typeof timeMs !== 'number') return null;
  if (typeof thresholds.gold === 'number' && timeMs <= thresholds.gold) return 'gold';
  if (typeof thresholds.silver === 'number' && timeMs <= thresholds.silver) return 'silver';
  if (typeof thresholds.bronze === 'number' && timeMs <= thresholds.bronze) return 'bronze';
  return null;
}

export const MEDAL_ICON = { gold: '🥇', silver: '🥈', bronze: '🥉' };

/** The next medal up from `medal`, or null when there is nothing better. */
export function nextMedal(medal) {
  if (medal === 'gold') return null;
  if (medal === 'silver') return 'gold';
  if (medal === 'bronze') return 'silver';
  return 'bronze';
}

// ── localStorage wrapper ──────────────────────────────────────────────────
// Every read and write is guarded: a browser with site data blocked must lose
// its records, not its ride.

export function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function save(store) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    return true;
  } catch {
    return false;
  }
}
