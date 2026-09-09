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
