// ============================================================
// ACCOUNT STATS — the lifetime stats on the House Tandem account (housetandem-web #37)
// ============================================================
//
// Pure and DOM-free (the unit tests import it). js/achievements.js does the
// storage and the network.
//
// The lifetime stats (js/achievement-defs.js · emptyStats) used to live only
// on the device. Signed in, they're also kept on the account as game
// 'tandemonium' (worker/games.js · game_stats), merged per stat:
//   counters  add     — the device sends what it counted since its last sync
//   bests     max     — the highest anywhere
//   flags     or      — true anywhere
//   sets      union   — golds, partners, bikes, modes, launch days
//   day list  recent  — the newest 60 days ridden
//   streaks   latest  — the Daily Ride run, moved on the newest day
//   bests map maxmap  — best-so-far per achievement, with where and when
// rideCoins is the ride in progress, so it stays on the device.
//
// "Synced baseline": the device remembers, for each counter, how much of it
// the account already has (base.add). What it sends is L - base, once; after
// the server answers, base = the account's totals and L = those totals plus
// anything counted while the request was out. base.user says whose account
// the baseline belongs to: null = counted signed out (the next sign-in claims
// it), another account = the device's stats aren't this player's (reset).

import { emptyStats, migrateStats, STATS_VERSION } from './achievement-defs.js';

export const ACCOUNT_GAME = 'tandemonium';

export const ADD_KEYS = Object.freeze([
  'cumulativeDistance', 'rides', 'tutorialDone', 'tutorialClean', 'finishes',
  'crashes', 'boosts', 'pickups', 'personalBests', 'gusts', 'weathered', 'falseStarts', 'soCloses',
  'coinsEarned', 'coinsSpent', 'upgrades', 'slingLaunches', 'bigAirs', 'jackpots', 'doubleDowns', 'fullTrails',
  'straightShots', 'medalKeys', 'dailyPractice', 'shares',
  'coopFinishes', 'versusRaces', 'versusWins', 'versus2v2Wins', 'versusClose', 'versusComebacks',
  'versus1v2Wins', 'versusClean', 'touristDistance',
]);
/**
 * Highest wins. `days` is a max, not a counter: the same day ridden on two
 * devices is one day (each device starts from the account's count, and the
 * merged day list fills in the rest).
 */
export const MAX_KEYS = Object.freeze(['days', 'rebuilds', 'bestRideCoins', 'slingBest', 'slingStage', 'slingTopSpeed', 'dailyDayBest']);
export const OR_KEYS = Object.freeze(['pedalled', 'maxedAny', 'maxedAll']);
export const UNION_KEYS = Object.freeze(['golds', 'launchDays', 'partners', 'grandmaGoldBikes', 'modesFinished']);
export const RECENT_KEYS = Object.freeze(['dayList']);
export const DEVICE_KEYS = Object.freeze(['rideCoins']);

const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const num = (v) => (fin(v) && v > 0 ? v : 0);

/** An empty baseline: nothing counted on this device has reached an account. */
export function emptyBase(user = null) {
  return { user: user == null ? null : String(user), add: {} };
}

/** A stored baseline (or junk) → a clean one. */
export function cleanBase(raw) {
  if (!raw || typeof raw !== 'object') return emptyBase();
  const b = emptyBase(raw.user == null ? null : raw.user);
  if (raw.add && typeof raw.add === 'object') for (const k of ADD_KEYS) if (num(raw.add[k])) b.add[k] = raw.add[k];
  return b;
}

/** The parts every delta carries in full (they merge idempotently). */
function settledParts(L) {
  const d = { max: { v: STATS_VERSION }, or: {}, union: {}, recent: {}, latest: {}, maxmap: { bests: {} } };
  for (const k of MAX_KEYS) if (num(L[k])) d.max[k] = L[k];
  for (const k of OR_KEYS) if (L[k] === true) d.or[k] = 1;
  for (const k of UNION_KEYS) if (Array.isArray(L[k]) && L[k].length) d.union[k] = L[k];
  for (const k of RECENT_KEYS) if (Array.isArray(L[k]) && L[k].length) d.recent[k] = L[k];
  if (typeof L.lastDailyDay === 'string') d.latest.dailyRun = [L.lastDailyDay, num(L.dailyDayRun)];
  if (typeof L.lastDay === 'string') d.latest.lastDay = [L.lastDay, null];
  for (const [id, v] of Object.entries(L.bests || {})) {
    if (!num(v)) continue;
    const at = L.bestsAt && L.bestsAt[id];
    d.maxmap.bests[id] = at ? [v, typeof at.level === 'string' ? at.level : null, fin(at.at) ? at.at : null] : [v];
  }
  for (const op of Object.keys(d)) if (op !== 'maxmap' && !Object.keys(d[op]).length) delete d[op];
  if (!Object.keys(d.maxmap.bests).length) delete d.maxmap;
  return d;
}

/** What this device sends: counters since the baseline, everything else in full. */
export function toAccountDelta(L, base) {
  const b = cleanBase(base);
  const d = settledParts(L);
  const add = {};
  for (const k of ADD_KEYS) {
    const diff = num(L[k]) - num(b.add[k]);
    if (diff > 1e-9) add[k] = diff;
  }
  if (Object.keys(add).length) d.add = add;
  return d;
}

/** Does the delta carry counters (anything that isn't safe to send twice)? */
export function hasCounters(delta) {
  return !!(delta && delta.add && Object.keys(delta.add).length);
}

/** The account's stored stats (worker game_stats 'tandemonium') → a clean v2 stats object. */
export function fromAccount(T) {
  const t = T && typeof T === 'object' ? T : {};
  const raw = emptyStats();
  for (const k of [...ADD_KEYS, ...MAX_KEYS]) raw[k] = num(t[k]);
  for (const k of OR_KEYS) raw[k] = num(t[k]) > 0;
  for (const k of [...UNION_KEYS, ...RECENT_KEYS]) raw[k] = Array.isArray(t[k]) ? t[k] : [];
  if (Array.isArray(t.dailyRun) && typeof t.dailyRun[0] === 'string') {
    raw.lastDailyDay = t.dailyRun[0];
    raw.dailyDayRun = num(t.dailyRun[1]);
  }
  if (Array.isArray(t.lastDay) && typeof t.lastDay[0] === 'string') raw.lastDay = t.lastDay[0];
  if (t.bests && typeof t.bests === 'object') {
    for (const [id, e] of Object.entries(t.bests)) {
      if (!Array.isArray(e) || !num(e[0])) continue;
      raw.bests[id] = e[0];
      if (fin(e[2])) raw.bestsAt[id] = { level: typeof e[1] === 'string' ? e[1] : null, at: e[2] };
    }
  }
  return migrateStats(raw);
}

/** The baseline after the server answered with the account's totals T. */
export function baseFromAccount(T, user) {
  const b = emptyBase(user);
  const t = T && typeof T === 'object' ? T : {};
  for (const k of ADD_KEYS) if (num(t[k])) b.add[k] = t[k];
  return b;
}

/**
 * The device's stats after a sync. T: the account's stats as the server
 * returned them (this device's delta already in). Lnow: the device's stats
 * now. sent: the stats the delta was taken from (so counts made while the
 * request was out aren't lost). Non-counters merge both ways.
 */
export function mergeAfterSync(T, Lnow, sent) {
  const account = fromAccount(T);
  const mine = migrateStats(Lnow);
  const S = sent ? migrateStats(sent) : mine;
  const R = { ...account, bests: { ...account.bests }, bestsAt: { ...account.bestsAt } };
  for (const k of ADD_KEYS) R[k] = account[k] + Math.max(0, num(mine[k]) - num(S[k]));
  for (const k of MAX_KEYS) R[k] = Math.max(account[k], num(mine[k]));
  for (const k of OR_KEYS) R[k] = account[k] || mine[k] === true;
  for (const k of UNION_KEYS) R[k] = [...new Set([...account[k], ...mine[k]])];
  for (const k of RECENT_KEYS) R[k] = [...new Set([...account[k], ...mine[k]])].sort().slice(-60);
  if (mine.lastDailyDay && (!R.lastDailyDay || mine.lastDailyDay > R.lastDailyDay
      || (mine.lastDailyDay === R.lastDailyDay && mine.dailyDayRun > R.dailyDayRun))) {
    R.lastDailyDay = mine.lastDailyDay;
    R.dailyDayRun = mine.dailyDayRun;
  }
  if (mine.lastDay && (!R.lastDay || mine.lastDay > R.lastDay)) R.lastDay = mine.lastDay;
  for (const [id, v] of Object.entries(mine.bests)) {
    if (v > (R.bests[id] || 0)) {
      R.bests[id] = v;
      if (mine.bestsAt[id]) R.bestsAt[id] = mine.bestsAt[id]; else delete R.bestsAt[id];
    }
  }
  for (const k of DEVICE_KEYS) R[k] = num(mine[k]);
  R.days = Math.max(R.days, R.dayList.length);
  return R;
}

/** The baseline after a delta went out without an answer (a beacon at page hide): assume it landed. */
export function baseAfterSend(base, sent) {
  const b = cleanBase(base);
  for (const k of ADD_KEYS) if (num(sent[k]) > num(b.add[k])) b.add[k] = sent[k];
  return b;
}

/** The account id in a session token (JWT `sub`), or null. */
export function tokenUser(token) {
  if (typeof token !== 'string') return null;
  try {
    const part = token.split('.')[1];
    const json = typeof atob === 'function'
      ? atob(part.replace(/-/g, '+').replace(/_/g, '/'))
      : Buffer.from(part, 'base64url').toString('utf8');
    const sub = JSON.parse(json).sub;
    return sub == null ? null : String(sub);
  } catch (e) {
    return null;
  }
}
