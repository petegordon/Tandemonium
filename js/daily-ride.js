// ============================================================
// DAILY RIDE (pure) — the road everyone rides today
// ============================================================
//
// C-2 / #641. One 500 m road, generated from today's day key, identical for
// every player in the world until 09:00 UTC.
//
// #641 (Pete, 2026-11-07) — one rule for both editions: there is no practice /
// ranked split. Every ride on the road counts, and your BEST unaided time of
// the day is the one that goes on the board. The full game rides it as often
// as it likes; the demo gets three rides a day (edition.js · dailyRideCap).
// A ride counts when it starts, so this module keeps:
//
//   started   rides begun today (a restart is a new ride, a checkpoint retry
//             is not — the caller decides, see game.js · _startCountdown)
//   practice  rides FINISHED today (the field keeps its old name so saves from
//             before #641 still read as finishes for streaks and the card)
//   best      the fastest unaided finish today (a 🛟 finish counts as a finish
//             but is not a best — #403)
//   first     the first ride's result, for the share strip's "first try"
//
// DOM-free and storage-agnostic so it can be tested: the store is any object
// with get(key)/set(key, value).

import { dailyKey, dailySeed } from './daily-seed.js';

export const STORAGE_KEY = 'tandemonium_daily';

/** Entries older than this are dropped on write. */
export const KEEP_DAYS = 60;

/**
 * A copy of the base level with today's identity attached. The entry in LEVELS
 * stays constant — resolving here means the level object never carries a stale
 * date from whenever the page was loaded.
 */
export function resolveDailyLevel(baseLevel, { key, seed } = {}) {
  const k = key || dailyKey();
  return {
    ...baseLevel,
    key: k,
    seed: typeof seed === 'number' ? seed : dailySeed(),
    dateLabel: formatDayLabel(k)
  };
}

/** "Mon, Sep 8" from a 'YYYY-MM-DD' key. Locale-independent on purpose. */
export function formatDayLabel(key) {
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
  if (!m) return '';
  const [, y, mo, d] = m;
  const date = new Date(Date.UTC(+y, +mo - 1, +d));
  return `${DAYS[date.getUTCDay()]}, ${MONTHS[+mo - 1]} ${+d}`;
}

/** What has this player done on the given day's road? */
export function dailyStatus(store, key) {
  const entry = readAll(store)[key];
  return {
    started: (entry && entry.started) || 0,
    finished: (entry && entry.practice) || 0,
    best: bestOf(entry),
    first: firstTryOf(entry)
  };
}

/**
 * Rides started on the given day's road that the demo's cap counts: every
 * start except the ones ridden as a guest in a full-game host's room (#666 ·
 * `guest`), which the host's edition allows as often as it likes.
 */
export function ridesStarted(store, key) {
  const entry = readAll(store)[key];
  return Math.max(0, ((entry && entry.started) || 0) - ((entry && entry.guest) || 0));
}

/**
 * #512 · has this device finished the given day's road? Read BEFORE recording
 * a finish to know whether it is the day's first, which pays the daily habit
 * bonus (js/economy.js · dailyBonus).
 */
export function finishedToday(store, key) {
  return hasFinish(readAll(store)[key]);
}

/**
 * #641 · a ride on the road has started. Returns this ride's number today
 * (1 = the first try), which the caller hands back to recordDailyFinish.
 * `guest` (#666): ridden under a full host's rules, so the demo's cap skips it.
 */
export function recordRideStart(store, key, { guest = false } = {}) {
  const all = readAll(store);
  const entry = all[key] || { practice: 0, best: null };
  entry.started = (entry.started || 0) + 1;
  // #666 · a demo guest in a full host's room: counted as a ride, not against the cap.
  if (guest) entry.guest = (entry.guest || 0) + 1;
  all[key] = entry;
  writeAll(store, prune(all, key));
  return entry.started;
}

/**
 * Count one finished ride, keeping the day's best unaided time. `rideNo` is
 * recordRideStart's number for this ride: ride 1's result is the first try.
 * @param {{timeMs?:number, helped?:boolean, skipped?:boolean, rideNo?:number}} run
 */
export function recordDailyFinish(store, key, run = {}) {
  const all = readAll(store);
  const entry = all[key] || { practice: 0, best: null };
  entry.practice = (entry.practice || 0) + 1;
  const clean = !run.helped && !run.skipped;
  const t = run.timeMs;
  if (clean && typeof t === 'number' && t > 0 && (!entry.best || t < entry.best)) {
    entry.best = Math.round(t);
  }
  if (run.rideNo === 1 && !entry.first) {
    entry.first = run.skipped ? { skipped: true }
      : { timeMs: typeof t === 'number' && t > 0 ? Math.round(t) : null, helped: !!run.helped };
  }
  all[key] = entry;
  writeAll(store, prune(all, key));
  return entry;
}

/** The first ride's result: {timeMs, helped} · {skipped} · {dnf} · null (not ridden / still riding). */
export function firstTry(store, key) {
  return firstTryOf(readAll(store)[key]);
}

function firstTryOf(entry) {
  if (!entry) return null;
  if (entry.first) return entry.first;
  // The first ride ended without a finish once a second one has started.
  return (entry.started || 0) >= 2 ? { dnf: true } : null;
}

/** Best time in an entry (a pre-#641 ranked finish already wrote its time here). */
function bestOf(entry) {
  if (!entry) return null;
  return entry.best || null;
}

/** Drop days older than KEEP_DAYS relative to `todayKey`. */
export function prune(all, todayKey) {
  const cutoff = Date.parse(todayKey + 'T00:00:00Z') - KEEP_DAYS * 86400000;
  const out = {};
  for (const [k, v] of Object.entries(all)) {
    const t = Date.parse(k + 'T00:00:00Z');
    if (!Number.isFinite(t) || t >= cutoff) out[k] = v;
  }
  return out;
}

/**
 * The line under the card's name. Says what the player has done today, and —
 * because a daily road is worthless if you don't know it is daily — when the
 * next one arrives.
 */
export function dailyDescription(status, key) {
  const label = formatDayLabel(key);
  const bits = [label];
  if (status && status.finished) {
    bits.push(status.finished === 1 ? 'finished once' : `finished ×${status.finished}`);
    if (status.best) bits.push(`best ${formatClock(status.best)}`);
  } else if (status && status.started) {
    bits.push(status.started === 1 ? 'ridden once' : `ridden ×${status.started}`);
  }
  if (bits.length === 1) return `${label} · not ridden yet`;
  return bits.join(' · ');
}

/** Fixed subtitle explaining the rules, shown under the description. */
export const DAILY_RULES_LINE = 'Same road for everyone today · your best time counts · new road at 09:00 UTC (05:00 ET)';

// ── storage helpers ───────────────────────────────────────────────────────

function readAll(store) {
  try {
    const raw = store && store.get ? store.get(STORAGE_KEY) : null;
    if (!raw) return {};
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeAll(store, all) {
  try {
    if (store && store.set) store.set(STORAGE_KEY, JSON.stringify(all));
  } catch { /* private mode: the road still rides, it just isn't remembered */ }
}

/** The localStorage-backed store the game uses. */
export function browserStore() {
  return {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } }
  };
}
// ============================================================
// D-5 · Streaks
// ============================================================
//
// A streak is a promise that the game will be here tomorrow, and a reason to
// keep it. It is also the easiest mechanic in games to make cruel, so:
//
//   - the personal streak counts DAYS with any finish on Today's Road, and up
//     to MAX_BRIDGED_GAPS missed days are bridged rather than breaking it.
//     Duolingo's streak freeze cut churn 21%, and the reason is not subtle:
//     the day someone breaks a long streak is the day they stop opening the
//     app. Note what this is NOT: there is no freeze balance to spend, hoard
//     or buy. The streak is recomputed from the ride history every time it is
//     read, and at most two one-day gaps inside the run you are currently
//     holding are forgiven. That is simpler than a currency, it cannot drift
//     out of step with the rides that actually happened, and it cannot
//     resurrect a streak that has been dead for a fortnight;
//   - the pair streak counts WEEKS, not days, in which two people rode together
//     at least once. Two adults with jobs do not ride a tandem every evening.
//     C-1's median-days-between-a-pair's-rides exists to check this choice
//     against reality.

/**
 * How many one-day gaps are forgiven inside the streak you are currently
 * holding. Two: enough to cover a bad week without making the streak
 * meaningless.
 */
export const MAX_BRIDGED_GAPS = 2;


/** Whole days between two 'YYYY-MM-DD' keys. */
export function daysBetween(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}

/** The ISO week a day key belongs to, as 'YYYY-Www'. */
export function isoWeek(key) {
  const d = new Date(key + 'T00:00:00Z');
  if (isNaN(d)) return '';
  const day = (d.getUTCDay() + 6) % 7;            // Monday = 0
  d.setUTCDate(d.getUTCDate() - day + 3);         // the week's Thursday
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const fday = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - fday + 3);
  const week = 1 + Math.round((d - firstThursday) / (7 * 86400000));
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * Personal streak: consecutive days ending today (or yesterday — a streak stays
 * alive until the end of today) with any finish. A one-day gap is bridged by a
 * freeze when the month has one left.
 *
 * @returns {{ current, best, freezesLeft, usedFreeze }}
 */
export function computeStreak(store, todayKey, opts = {}) {
  const all = readAll(store);
  const ridden = Object.keys(all)
    .filter(k => !k.startsWith('__') && hasFinish(all[k]))
    .sort()
    .reverse();
  const granted = opts.freezes ?? MAX_BRIDGED_GAPS;
  if (ridden.length === 0) {
    return { current: 0, best: 0, freezesLeft: granted, usedFreeze: false };
  }

  // Pure: this is read on every card render, so it must never write anything.
  let freezesLeft = granted;
  let usedFreeze = false;

  const gapToNewest = daysBetween(ridden[0], todayKey);
  if (gapToNewest > 1) {
    if (gapToNewest === 2 && freezesLeft > 0) { freezesLeft--; usedFreeze = true; }
    else return { current: 0, best: longestRun(ridden), freezesLeft, usedFreeze: false };
  }

  let current = 1;
  for (let i = 1; i < ridden.length; i++) {
    const gap = daysBetween(ridden[i], ridden[i - 1]);
    if (gap === 1) { current++; continue; }
    if (gap === 2 && freezesLeft > 0) { freezesLeft--; usedFreeze = true; current++; continue; }
    break;
  }
  return { current, best: Math.max(current, longestRun(ridden)), freezesLeft, usedFreeze };
}

/** Pair streak: consecutive ISO weeks with at least one ride together. */
export function computePairStreak(store, partnerKey, todayKey) {
  const all = readAll(store);
  const weeks = new Set();
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith('__')) continue;
    const partners = (v && v.partners) || [];
    if (partners.includes(partnerKey)) weeks.add(isoWeek(k));
  }
  if (weeks.size === 0) return { current: 0, best: 0 };

  const sorted = [...weeks].sort().reverse();
  const thisWeek = isoWeek(todayKey);
  const lastWeek = isoWeek(shiftKey(todayKey, -7));
  if (sorted[0] !== thisWeek && sorted[0] !== lastWeek) {
    return { current: 0, best: longestWeekRun(sorted) };
  }

  let current = 1;
  for (let i = 1; i < sorted.length; i++) {
    if (weekGap(sorted[i], sorted[i - 1]) === 1) current++;
    else break;
  }
  return { current, best: Math.max(current, longestWeekRun(sorted)) };
}

/** Note that the ride on `key` was shared with `partnerKey`. */
export function recordPartner(store, key, partnerKey) {
  if (!partnerKey) return;
  const all = readAll(store);
  const entry = all[key] || { practice: 0, best: null };
  entry.partners = entry.partners || [];
  if (!entry.partners.includes(partnerKey)) entry.partners.push(partnerKey);
  all[key] = entry;
  writeAll(store, prune(all, key));
}

function hasFinish(entry) {
  if (!entry) return false;
  if (entry.practice > 0) return true;
  // A pre-#641 save: the day's ranked run, if it finished.
  return Object.values(entry.ranked || {}).some(r => r && !r.dnf);
}

function longestRun(keysDesc) {
  if (keysDesc.length === 0) return 0;
  let best = 1, run = 1;
  for (let i = 1; i < keysDesc.length; i++) {
    if (daysBetween(keysDesc[i], keysDesc[i - 1]) === 1) { run++; best = Math.max(best, run); }
    else run = 1;
  }
  return best;
}

function longestWeekRun(weeksDesc) {
  if (weeksDesc.length === 0) return 0;
  let best = 1, run = 1;
  for (let i = 1; i < weeksDesc.length; i++) {
    if (weekGap(weeksDesc[i], weeksDesc[i - 1]) === 1) { run++; best = Math.max(best, run); }
    else run = 1;
  }
  return best;
}

function weekGap(earlier, later) {
  const parse = (w) => {
    const [y, n] = w.split('-W').map(Number);
    return y * 53 + n;
  };
  return parse(later) - parse(earlier);
}

function shiftKey(key, days) {
  return new Date(Date.parse(key + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);
}

// ============================================================
// D-3 · The shareable result
// ============================================================
//
// Wordle's grid works because it says how it went without saying what the
// answer was. A daily road has exactly the same property to protect: the strip
// must never leak where the obstacles are, or sharing it spoils the day for the
// person you sent it to. Nothing below encodes a position on the road except
// how far the rider got.

/**
 * Build the share strip. Pure, and exactly formatted — this is the artefact
 * that leaves the game and gets pasted somewhere, so its format is tested.
 *
 * @param {object} r    { key, mode, timeMs, dnf, distance, raceDistance, medal,
 *                        collectibles, collectiblesTotal, crashes, sync, safety,
 *                        streak, partnerName, bestMs, first, rides }
 *   #641: bestMs = today's best unaided time (shown instead of this ride's
 *   when it is faster); first = firstTry() — shown as "1st try" once the day
 *   has more than one ride (rides = rides started today).
 * @param {object} opts { origin }
 */
export function buildShareStrip(r, opts = {}) {
  const origin = opts.origin || 'https://tandemonium.housetandem.com';
  const MEDALS = { gold: '🥇', silver: '🥈', bronze: '🥉' };

  // Line 1 — what, when, and who with.
  let line1 = `Tandemonium · Daily Ride · ${shortDate(r.key)}`;
  if (r.partnerName) line1 += ` with ${r.partnerName}`;

  // Line 2 — how it went.
  const parts = [];
  // The pair marker rides on the time rather than standing as its own field —
  // "👥 2:41" reads as "two of us, 2:41"; "👥 · 2:41" reads as a missing value.
  const best = r.bestMs > 0 && (r.dnf || !(r.timeMs > 0) || r.bestMs < r.timeMs) ? r.bestMs : null;
  const time = best ? formatClock(best)
    : r.dnf ? `DNF @ ${Math.round(r.distance || 0)}m` : formatClock(r.timeMs);
  parts.push(r.mode === 'pair' ? `👥 ${time}` : time);
  if (r.medal && MEDALS[r.medal]) parts.push(MEDALS[r.medal]);
  if (r.collectiblesTotal) parts.push(`🎁 ${r.collectibles || 0}/${r.collectiblesTotal}`);
  if (r.crashes) parts.push(`💥 ${r.crashes}`);
  if (r.mode === 'pair' && typeof r.sync === 'number') parts.push(`🔗 ${Math.round(r.sync)}%`);
  if (r.safety) parts.push('🛡️');
  // #641 · the first try, next to the day's best — the one-shot number.
  if (r.first && (r.rides || 0) > 1) {
    const f = r.first;
    parts.push('1st try ' + (f.dnf ? 'DNF' : f.skipped ? '👑' : formatClock(f.timeMs) + (f.helped ? '🛟' : '')));
  }
  if (r.streak >= 2) parts.push(`🔥 ${r.streak}`);
  const line2 = parts.join(' · ');

  // Line 3 — the shape of the ride, with nothing in it about the road.
  const total = r.raceDistance || 500;
  const filled = Math.max(0, Math.min(12, Math.round(12 * (r.distance || 0) / total)));
  const line3 = '▰'.repeat(filled) + '▱'.repeat(12 - filled) + ` ${total}m`;

  // Line 4 — the invitation.
  const line4 = `${origin}/?daily=${r.key}`;

  return [line1, line2, line3, line4].join('\n');
}

/** 'Sep 8' from a day key. */
export function shortDate(key) {
  const label = formatDayLabel(key);
  return label ? label.split(', ')[1] : '';
}

/** '2:41' from milliseconds. */
export function formatClock(ms) {
  if (typeof ms !== 'number' || !isFinite(ms) || ms <= 0) return '—';
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
