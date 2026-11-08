// ============================================================
// TIME WARP MODE (#611 / #644) — ride tomorrow's road today
// ============================================================
//
// Pete, 2026-11-07: once the Time Warp reward is earned (any 90 of the 95
// non-calendar achievements, js/rewards.js · timeWarpProgress), the Daily Ride
// card gets a "Warp to tomorrow" button. One day per press, up to
// MAX_WARP_DAYS ahead of the real date, on any bike.
//
// The road is procedural from the day key (js/daily-seed.js · seedFromKey), so
// a warped day rides EXACTLY the road everyone gets on that real day: the key
// is the real day key shifted by whole days, and everything else (seed, road,
// trees, pylons, presents, geese, tokens, the Daily Launch course) derives
// from the key alone.
//
// While warped, the warped day IS the day for the game: the Daily Ride's ride
// counters and demo cap, the calendar achievements (days ridden, the Daily
// streak, Launch Week), the Daily Launch, and the board post (flagged warp).
//
// Leaving warp (the rule, kept simple):
//   - "Back to today" on the card;
//   - restarting / reloading the app (the warp lives in memory only, never
//     in a save);
//   - joining an online room (the partner's game is on the real date).
// Finishing a ride and coming back to the lobby keeps the warp, so the next
// press goes one more day.
//
// The real date catching up: the warp is held as a TARGET day, not an offset,
// so when the road rolls over at 09:00 UTC the target stays put and the warp
// shrinks by one; once the real date reaches the target, the warp ends.

import { dailyKey } from './daily-seed.js';

/** How far ahead of the real date a warp may go (Pete: 7 days). */
export const MAX_WARP_DAYS = 7;

/** A day key moved by whole days ('2026-11-07', 3 → '2026-11-10'). */
export function shiftDayKey(key, days) {
  const t = Date.parse(key + 'T00:00:00Z');
  if (!Number.isFinite(t)) return key;
  return new Date(t + Math.round(days) * 86400000).toISOString().slice(0, 10);
}

/** Whole days from day key `a` to day key `b`. */
export function dayKeyGap(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}

/**
 * The day key `days` ahead of the real day at `now` — the road that day will
 * have. Pure: dailyKey(now + days) === warpedDayKey(days, now) for any time of
 * day, because the rollover is a fixed UTC hour.
 */
export function warpedDayKey(days, now = new Date()) {
  return shiftDayKey(dailyKey(now), Math.max(0, Math.min(MAX_WARP_DAYS, Math.floor(days || 0))));
}

// ── session state (memory only: an app restart is back on the real date) ──

let target = null;   // 'YYYY-MM-DD' or null

/** Days the game is warped ahead of the real date at `now` (0 = not warped). */
export function warpDays(now = new Date()) {
  if (!target) return 0;
  const real = dailyKey(now);
  const d = dayKeyGap(real, target);
  if (!(d > 0)) { target = null; return 0; }          // the real date caught up
  if (d > MAX_WARP_DAYS) { target = shiftDayKey(real, MAX_WARP_DAYS); return MAX_WARP_DAYS; }   // a clock moved back
  return d;
}

/** The day the game is on: the warped day, or the real day key. */
export function playDayKey(now = new Date()) {
  return shiftDayKey(dailyKey(now), warpDays(now));
}

/** Can the warp go one more day? */
export function canWarpForward(now = new Date()) {
  return warpDays(now) < MAX_WARP_DAYS;
}

/** One press of "Warp to tomorrow". Returns the warp in days after the press. */
export function warpForward(now = new Date()) {
  const d = warpDays(now);
  if (d >= MAX_WARP_DAYS) return d;
  target = shiftDayKey(dailyKey(now), d + 1);
  return d + 1;
}

/** "Back to today" (and joining an online room). */
export function leaveWarp() {
  target = null;
}

/** "Tuesday, November 10" from a day key. Locale-independent on purpose. */
export function longDayLabel(key) {
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
  if (!m) return '';
  const date = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return `${DAYS[date.getUTCDay()]}, ${MONTHS[+m[2] - 1]} ${+m[3]}`;
}

/** The card's warp line: "⏳ Tuesday, November 10 · warped +3". */
export function warpLine(key, days) {
  return `⏳ ${longDayLabel(key)} · warped +${days}`;
}

/** The card's rule line while warped (in place of the Daily Ride's). */
export const WARP_RULES_LINE = 'Time warp · the road everyone gets that day · counts for that day';
