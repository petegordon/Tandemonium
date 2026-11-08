// ============================================================
// ECONOMY — what a regular ride pays, and what Slingshot's gates read
// ============================================================
//
// #400 D4: every ride rewards you. Solo levels (tutorial included), Today's
// Road (every ride counts, #641), co-op (each device pays its own wallet for the
// shared ride), local versus (once per race) and Tourist all pay through
// scoreRide() into the one wallet (js/wallet.js). Slingshot keeps its own
// scoreRun (js/slingshot.js) and pays into the same wallet.
//
// #512 · Tandem Tokens: the tokens on the road (js/token-runs.js) pay their
// pickup value through here, distance pays less so collecting matters more
// than surviving, and the first Daily Ride finished each day pays a habit
// bonus plus a streak bonus. The garage's Token multiplier no longer touches a
// regular ride — it multiplies Slingshot pay only (js/wallet.js).
//
// Pure and DOM-free. The Game glue is js/economy-mode.js.

import { medalFor, capMedal, betterMedal } from './records.js';
import { getMedals } from './race-config.js';

/**
 * The pay table (Pete, #512, 2026-11-04; the #400 numbers before it in the
 * comments). What it answers now: how many rides buy an outfit (#574)?
 * A Daily Ride pays about 200-300, Grandma's about 120-200.
 */
export const RIDE_PAY = Object.freeze({
  metresPerCoin: 10,                    // 1 Tandem Token per 10 m ridden (was 5)
  perPickup: 5,                         // each present / gem (unchanged)
  token: 5,                             // a token on the road (the late run pays double; js/token-runs.js)
  finish: 25,                           // reaching the finish (Tourist: arriving)
  medal: Object.freeze({ bronze: 25, silver: 50, gold: 100 }),
  newBest: 50,                          // beating your previous best on that road
  dailyFirst: 50,                       // the first Daily Ride finished each day
  streakPerDay: 10,                     // + per day of the streak beyond the first…
  streakCap: 100,                       // …up to this
});

/**
 * The daily habit bonus (#512), paid with the FIRST Daily Ride finished each
 * day. `streak` is the day streak with today counted (js/daily-ride.js ·
 * computeStreak, after the finish is recorded): day 1 pays dailyFirst alone,
 * day 2 adds +10, day 11 and beyond +100.
 */
export function dailyBonus({ firstToday = false, streak = 0 } = {}) {
  if (!firstToday) return { first: 0, streakDays: 0, streakPay: 0 };
  const days = Math.max(0, Math.floor(streak || 0));
  return {
    first: RIDE_PAY.dailyFirst,
    streakDays: days,
    streakPay: Math.min(RIDE_PAY.streakCap, RIDE_PAY.streakPerDay * Math.max(0, days - 1)),
  };
}

/**
 * One payout for a regular ride.
 *
 * result: {
 *   distance        metres reached this ride (furthest point)
 *   paidDistance    metres an earlier payout of the same ride already paid for
 *                   (a game-over then a restart from a checkpoint is one ride)
 *   pickups         collectibles to pay for (only the ones not paid yet)
 *   tokenValue      what the tokens not paid yet are worth (5 each, 10 on the late run)
 *   tokens          tokens taken this ride so far, for the "n/N" line
 *   tokensTotal     tokens on the road
 *   finished        reached the finish
 *   medal           'bronze' | 'silver' | 'gold' | null
 *   newBest         beat a previous best
 *   dailyBonus      { firstToday, streak } for a finished Daily Ride, else null
 * }
 * A crashed, failed or abandoned ride still pays for its distance. The garage
 * multiplier is NOT applied here (#512): it is Slingshot's.
 */
export function scoreRide(result = {}) {
  const distance = Math.max(0, Math.floor(result.distance || 0));
  const paid = Math.max(0, Math.floor(result.paidDistance || 0));
  const metres = Math.max(0, distance - paid);
  const distPay = Math.max(0, Math.floor(distance / RIDE_PAY.metresPerCoin) - Math.floor(paid / RIDE_PAY.metresPerCoin));
  const pickups = Math.max(0, Math.floor(result.pickups || 0));
  const pickupPay = pickups * RIDE_PAY.perPickup;
  const tokenPay = Math.max(0, Math.floor(result.tokenValue || 0));
  const tokens = Math.max(0, Math.floor(result.tokens || 0));
  const tokensTotal = Math.max(0, Math.floor(result.tokensTotal || 0));
  const finishPay = result.finished ? RIDE_PAY.finish : 0;
  const medalPay = (result.finished && RIDE_PAY.medal[result.medal]) || 0;
  const bestPay = result.finished && result.newBest ? RIDE_PAY.newBest : 0;
  const daily = result.finished && result.dailyBonus ? dailyBonus(result.dailyBonus) : dailyBonus();
  const subtotal = distPay + pickupPay + tokenPay + finishPay + medalPay + bestPay + daily.first + daily.streakPay;
  return { metres, distPay, pickups, pickupPay, tokens, tokensTotal, tokenPay, finishPay,
           medal: medalPay ? result.medal : null, medalPay, bestPay,
           dailyPay: daily.first, streakDays: daily.streakDays, streakPay: daily.streakPay,
           subtotal, total: subtotal };
}

// ---- One ride, several payouts -------------------------------------------
//
// A ride can reach more than one end screen: a game-over, RESTART from the
// last checkpoint, then the finish. The ledger remembers what was already paid
// so each payout pays only what is new — the furthest metres, the most
// pickups and the most token value seen so far — and the finish bonuses at
// most once.

export function newLedger(id = null) {
  return { id, distance: 0, pickups: 0, tokenValue: 0, finished: false };
}

/**
 * What this payout should pay for, and the ledger after it.
 * now: { distance, pickups, tokenValue, finished }
 */
export function ledgerStep(ledger, now) {
  const distance = Math.max(ledger.distance, Math.floor(now.distance || 0));
  const pickupsSeen = Math.max(ledger.pickups, Math.floor(now.pickups || 0));
  const tokenSeen = Math.max(ledger.tokenValue || 0, Math.floor(now.tokenValue || 0));
  const finished = !!now.finished && !ledger.finished;
  return {
    pay: { distance, paidDistance: ledger.distance, pickups: pickupsSeen - ledger.pickups,
           tokenValue: tokenSeen - (ledger.tokenValue || 0), finished },
    ledger: { ...ledger, distance, pickups: pickupsSeen, tokenValue: tokenSeen, finished: ledger.finished || !!now.finished },
  };
}

// ---- What Slingshot's stage gates read ------------------------------------

const RANK = { bronze: 1, silver: 2, gold: 3 };

/**
 * { medals: { levelId: best medal }, dailyFinished } from the records store
 * (js/records.js, any mode and difficulty) and Today's Road's store
 * (js/daily-ride.js, raw object of day → entry).
 */
export function gateProgress(recordsStore, dailyAll) {
  const medals = {};
  let dailyFinished = false;
  for (const [k, rec] of Object.entries(recordsStore || {})) {
    if (!rec || typeof rec.timeMs !== 'number') continue;
    const [levelId, difficulty] = k.split('|');
    if (levelId.startsWith('daily:')) { dailyFinished = true; continue; }
    // #403: a 🛟 best (helping hand or ASSIST) counts as bronze at most.
    // M3: and the best medal ever won on that key, which a slower finish never takes away.
    const m = betterMedal(capMedal(medalFor(rec.timeMs, getMedals(levelId, difficulty)), { helped: !!rec.helped }),
                          capMedal(rec.bestMedal, { helped: false }));
    if (m && (RANK[m] || 0) > (RANK[medals[levelId]] || 0)) medals[levelId] = m;
  }
  for (const entry of Object.values(dailyAll || {})) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.practice > 0) dailyFinished = true;
    for (const r of Object.values(entry.ranked || {})) if (r && !r.dnf) dailyFinished = true;
  }
  return { medals, dailyFinished };
}
