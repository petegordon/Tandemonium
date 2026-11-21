// ============================================================
// TOURIST LIMITS (pure) — how much of Google a player may use (#824)
// ============================================================
//
// Pete, 2026-11-21: 5 new typed addresses a week and 5 Google tile sessions a day, per player, per game.
//   - Only a real paid root request counts as a session; a kept root never does.
//   - A live session always rides, and a ride in progress is never stopped by these limits.
//   - The counts live on this device and, signed in, on the account (game_stats, 'latest' pairs). When the
//     two differ the higher wins, so signing in or out cannot refill a limit.
//   - These limits are for honest players: the Maps key ships in the client, so Google Cloud quotas are the
//     only hard stop.
//
// Nothing here touches the network, the DOM or storage.

import { NEW_PLACE_LIMIT, periodStart, periodEnd, resetDayName } from './tourist-places.js';

/** One number to change. */
export const TILE_SESSION_LIMIT = Object.freeze({ count: 5, days: 1 });

/** Where the device keeps its counts (it survives a sign-out, unlike the account's stats). */
export const TOURIST_USAGE_KEY = 'tandemonium_tourist_usage';

/** { day: 'YYYY-MM-DD', sessions: n, week: Monday's 'YYYY-MM-DD', addresses: n } */
export function emptyUsage() {
  return { day: '', sessions: 0, week: '', addresses: 0 };
}

const count = (v) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
const key = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '');

/** A stored value back into shape (anything odd becomes empty). */
export function readUsage(raw) {
  let v = null;
  try { v = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { v = null; }
  if (!v || typeof v !== 'object') return emptyUsage();
  return { day: key(v.day), sessions: count(v.sessions), week: key(v.week), addresses: count(v.addresses) };
}

const newer = (ka, na, kb, nb) => (ka > kb ? [ka, na] : kb > ka ? [kb, nb] : [ka, Math.max(na, nb)]);

/** Two records of the same player: the newer period, and in the same period the higher count. */
export function mergeUsage(a, b) {
  const x = readUsage(a), y = readUsage(b);
  const [day, sessions] = newer(x.day, x.sessions, y.day, y.sessions);
  const [week, addresses] = newer(x.week, x.addresses, y.week, y.addresses);
  return { day, sessions, week, addresses };
}

/** Where the player stands on today's sessions. `live`: a kept session can serve the next ride for free. */
export function sessionGate(usage, now = Date.now(), live = false, limit = TILE_SESSION_LIMIT) {
  const u = readUsage(usage);
  const used = u.day === periodStart(now, limit.days) ? Math.min(limit.count, u.sessions) : 0;
  const left = Math.max(0, limit.count - used);
  return { limit: limit.count, used, left, live: !!live, allowed: !!live || left > 0, resetsAt: periodEnd(now, limit.days) };
}

/** One real paid root request. → the new usage */
export function countSession(usage, now = Date.now(), limit = TILE_SESSION_LIMIT) {
  const u = readUsage(usage);
  const day = periodStart(now, limit.days);
  return { ...u, day, sessions: (u.day === day ? u.sessions : 0) + 1 };
}

/** The week's address count, as the places store has it. → the new usage */
export function noteAddresses(usage, week, used) {
  return mergeUsage(usage, { week, addresses: used });
}

/** The places store with the account's count for this week, when that is higher. */
export function storeWithUsage(store, usage, now = Date.now(), limit = NEW_PLACE_LIMIT) {
  const u = readUsage(usage);
  const week = periodStart(now, limit.days);
  if (u.week !== week) return store;
  const mine = store.week === week ? store.used || 0 : 0;
  return u.addresses > mine ? { ...store, week, used: Math.min(limit.count, u.addresses) } : store;
}

/** The player's line about today's sessions. */
export function sessionText(gate, now = Date.now(), locale = undefined) {
  if (gate.live) return `Map sessions today: ${gate.left} of ${gate.limit} left · this one is still open`;
  if (gate.left > 0) return `Map sessions today: ${gate.left} of ${gate.limit} left`;
  return `You have used today’s ${gate.limit} map sessions. More ${resetDayName(gate.resetsAt, now, locale)}.`;
}
