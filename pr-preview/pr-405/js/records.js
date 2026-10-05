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
 * @param {string} levelId  'grandma' | 'daily' | …
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
 * @param {object} run      { timeMs, splits?: number[], collectibles?, crashes?, date?,
 *                            medal?: the medal this run keeps (helped: capped at bronze) }
 * @param {object} [opts]   { medalOf(rec) } — the medal an older record's time earns,
 *                          for records saved before bestMedal existed
 * @returns {{ isNewBest: boolean, faster: boolean, delta: number|null, best: object }}
 *          `delta` is this run minus the previous best, in ms (negative = faster).
 *          `faster`: quicker than the previous best (or the first) — what NEW BEST pays for (M3).
 */
export function recordRun(store, k, run, opts = {}) {
  if (!store || !k || !run || typeof run.timeMs !== 'number' || !(run.timeMs > 0)) {
    return { isNewBest: false, delta: null, best: getBest(store, k) };
  }
  // #403 · a run with the Royal Shortcut taken did not ride the whole road:
  // it can finish, but it never becomes a best.
  if (run.skipped) {
    const best = getBest(store, k);
    return { isNewBest: false, faster: false, delta: best ? Math.round(run.timeMs) - best.timeMs : null, best };
  }
  const previous = getBest(store, k);
  // M3 · the best medal EVER on this key (helped capped at bronze by the
  // caller). It survives the time it was won with being replaced, so a slower
  // unaided finish can never take away what a Slingshot gate already read.
  const prevMedal = previous ? betterMedal(validMedal(previous.bestMedal),
    typeof opts.medalOf === 'function' ? validMedal(opts.medalOf(previous)) : null) : null;
  const bestMedal = betterMedal(prevMedal, validMedal(run.medal));
  const keep = (rec) => { if (bestMedal) rec.bestMedal = bestMedal; return rec; };
  const entry = {
    timeMs: Math.round(run.timeMs),
    splits: Array.isArray(run.splits) ? run.splits.map(n => Math.round(n)) : [],
    collectibles: run.collectibles ?? 0,
    crashes: run.crashes ?? 0,
    date: run.date || new Date().toISOString()
  };
  // #403 · a helped (🛟) best is kept and flagged, but never replaces an
  // unassisted one; and the first unassisted finish always replaces a 🛟 best.
  if (run.helped) entry.helped = true;

  if (!previous) {
    store[k] = keep(entry);
    trim(store);
    return { isNewBest: true, faster: true, delta: null, best: entry };
  }

  const delta = entry.timeMs - previous.timeMs;
  const faster = delta < 0;
  if (entry.helped && !previous.helped) {
    keep(previous);
    return { isNewBest: false, faster: false, delta, best: previous };
  }
  if (!entry.helped && previous.helped) {
    store[k] = keep(entry);
    trim(store);
    return { isNewBest: true, faster, delta, best: entry, replacedHelped: true };
  }
  if (faster) {
    store[k] = keep(entry);
    trim(store);
    return { isNewBest: true, faster, delta, best: entry };
  }
  keep(previous);
  // A slower run still teaches us something when the old best has no splits.
  if (previous.splits.length === 0 && entry.splits.length > 0) {
    previous.splits = entry.splits;
  }
  return { isNewBest: false, faster: false, delta, best: previous };
}

const MEDAL_RANK = { bronze: 1, silver: 2, gold: 3 };
const validMedal = m => (MEDAL_RANK[m] ? m : null);

/** The better of two medals ('gold' | 'silver' | 'bronze' | null). */
export function betterMedal(a, b) {
  return (MEDAL_RANK[b] || 0) > (MEDAL_RANK[a] || 0) ? b : validMedal(a);
}

/**
 * Drop the oldest entries when the store grows past MAX_KEYS — Today's Road
 * keys only (m20). Each day adds one `daily:<day>|…` key, while the level
 * records are few and permanent (the Slingshot stage gates read them), so the
 * dailies go first, oldest first, and a level record is never dropped.
 */
export function trim(store) {
  const keys = Object.keys(store);

  // The D-4 ghost (removed in #400) stored a ~10-25 KB ride track on each
  // best. Old stores may still carry them: drop them, keep the times.
  for (const k of keys) {
    if (store[k] && store[k].track !== undefined) delete store[k].track;
  }

  if (keys.length <= MAX_KEYS) return store;
  keys
    .filter(k => k.startsWith('daily:'))
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

/** #403 · the mark on a medal or best earned with the helping hand. */
export const HELPED_ICON = '🛟';

/**
 * #403 · the medal a run actually keeps. A helped run (any helping-hand tier,
 * or ASSIST, at any point) is capped at bronze; a run with a skipped
 * checkpoint earns none.
 * @param {'gold'|'silver'|'bronze'|null} medal  what the time alone earns
 * @param {{ helped?: boolean, skipped?: boolean }} [flags]
 */
export function capMedal(medal, flags = {}) {
  if (!medal) return null;
  if (flags.skipped) return null;
  if (flags.helped) return 'bronze';
  return medal;
}

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
