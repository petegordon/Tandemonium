// ============================================================
// TODAY'S ROAD (pure) — the road everyone rides today
// ============================================================
//
// C-2 (the practice-only form of plan item D-1). One 500 m road, generated from
// today's day key, identical for every player in the world until 09:00 UTC.
//
// In the demo this is practice only: unlimited runs, normal rules, personal
// bests from B-3. Ranked runs, streaks, the share strip and the partners board
// are Phase D, on the web build after the demo cut — a fest visitor plays once
// for about fourteen minutes, so retention machinery would be shipped to nobody.
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
  const all = readAll(store);
  const entry = all[key];
  return {
    practiced: (entry && entry.practice) || 0,
    best: (entry && entry.best) || null
  };
}

/** Count one finished practice run, keeping the day's best time. */
export function recordPractice(store, key, timeMs) {
  const all = readAll(store);
  const entry = all[key] || { practice: 0, best: null };
  entry.practice += 1;
  if (typeof timeMs === 'number' && timeMs > 0 && (!entry.best || timeMs < entry.best)) {
    entry.best = Math.round(timeMs);
  }
  all[key] = entry;
  writeAll(store, prune(all, key));
  return entry;
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
  if (!status || !status.practiced) return `${label} · not ridden yet`;
  const runs = status.practiced === 1 ? 'ridden once' : `ridden ×${status.practiced}`;
  if (status.best) {
    const total = Math.round(status.best / 1000);
    const t = `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
    return `${label} · ${runs} · best ${t}`;
  }
  return `${label} · ${runs}`;
}

/** Fixed subtitle explaining the rules, shown under the description. */
export const DAILY_RULES_LINE = 'Same road for everyone today · new road at 09:00 UTC (05:00 ET)';

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
// D-2 · Ranked runs
// ============================================================
//
// On Today's Road a player chooses Practice (unlimited, normal rules) or a
// Ranked run — ONE per day per mode. The rules, decided in plan §3 decision 8
// and stated once here:
//
//   - solo and pair are independent: riding alone at lunch does not use up the
//     evening ride with your partner;
//   - checkpoint rewinds and restarts are allowed, and cost time, as they do in
//     every other ride. The one-attempt purity of a Spelunky daily is a bad fit
//     for a game two people play together on a phone;
//   - END RIDE consumes the run as a DNF, so a bad start cannot be abandoned
//     for a re-roll. A crash does not consume it;
//   - Safety mode stays available. It is recorded and flagged rather than
//     forbidden — this game's audience includes people who cannot ride without
//     it, and locking them out of the ranked run locks out the persona.
//
// Gated to the web build by the caller: a fest visitor plays once for about
// fourteen minutes, so a daily ranked run in the demo ships to nobody.

export const MODES = ['solo', 'pair'];

/** Has this player used their ranked run for this day and mode? */
export function rankedDone(store, key, mode) {
  const all = readAll(store);
  const entry = all[key];
  return !!(entry && entry.ranked && entry.ranked[mode]);
}

/** The stored ranked result for a day and mode, or null. */
export function rankedResult(store, key, mode) {
  const all = readAll(store);
  const entry = all[key];
  return (entry && entry.ranked && entry.ranked[mode]) || null;
}

/**
 * Record a ranked run. Refuses to overwrite an existing one — that refusal is
 * the whole of "one run per day".
 * @returns {{ recorded: boolean, result: object|null }}
 */
export function recordRanked(store, key, mode, run) {
  if (!MODES.includes(mode)) return { recorded: false, result: null };
  const all = readAll(store);
  const entry = all[key] || { practice: 0, best: null };
  entry.ranked = entry.ranked || {};
  if (entry.ranked[mode]) return { recorded: false, result: entry.ranked[mode] };

  entry.ranked[mode] = {
    timeMs: run.dnf ? null : Math.round(run.timeMs || 0),
    dnf: !!run.dnf,
    distance: Math.round(run.distance || 0),
    collectibles: run.collectibles ?? 0,
    collectiblesTotal: run.collectiblesTotal ?? 0,
    crashes: run.crashes ?? 0,
    safety: !!run.safety,
    sync: typeof run.sync === 'number' ? Math.round(run.sync * 100) : null,
    partner: run.partner || null,
    at: run.at || new Date().toISOString()
  };
  if (!run.dnf && run.timeMs > 0 && (!entry.best || run.timeMs < entry.best)) {
    entry.best = Math.round(run.timeMs);
  }
  all[key] = entry;
  writeAll(store, prune(all, key));
  return { recorded: true, result: entry.ranked[mode] };
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

/** @deprecated the old name, kept so nothing breaks mid-refactor. */
export const FREEZES_PER_MONTH = MAX_BRIDGED_GAPS;

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
  return !!(entry.ranked && Object.keys(entry.ranked).length > 0);
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
 *                        practice, streak, partnerName }
 * @param {object} opts { origin }
 */
export function buildShareStrip(r, opts = {}) {
  const origin = opts.origin || 'https://tandemonium.jimandi.love';
  const MEDALS = { gold: '🥇', silver: '🥈', bronze: '🥉' };

  // Line 1 — what, when, and who with.
  let line1 = `Tandemonium · Today's Road · ${shortDate(r.key)}`;
  if (r.partnerName) line1 += ` with ${r.partnerName}`;

  // Line 2 — how it went.
  const parts = [];
  // The pair marker rides on the time rather than standing as its own field —
  // "👥 2:41" reads as "two of us, 2:41"; "👥 · 2:41" reads as a missing value.
  const time = r.dnf ? `DNF @ ${Math.round(r.distance || 0)}m` : formatClock(r.timeMs);
  parts.push(r.mode === 'pair' ? `👥 ${time}` : time);
  if (r.medal && MEDALS[r.medal]) parts.push(MEDALS[r.medal]);
  if (r.collectiblesTotal) parts.push(`🎁 ${r.collectibles || 0}/${r.collectiblesTotal}`);
  if (r.crashes) parts.push(`💥 ${r.crashes}`);
  if (r.mode === 'pair' && typeof r.sync === 'number') parts.push(`🔗 ${Math.round(r.sync)}%`);
  if (r.safety) parts.push('🛡️');
  if (r.practice) parts.push('🏋️');
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
