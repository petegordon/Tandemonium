// ============================================================
// ECONOMY — what a regular ride pays, and what Slingshot's gates read
// ============================================================
//
// #400 D4: every ride rewards you. Solo levels (tutorial included), Today's
// Road (practice and ranked), co-op (each device pays its own wallet for the
// shared ride), local versus (once per race) and Tourist all pay through
// scoreRide() into the one wallet (js/wallet.js). Slingshot keeps its own
// scoreRun (js/slingshot.js) and pays into the same wallet.
//
// Pure and DOM-free. The Game glue is js/economy-mode.js.

import { medalFor, capMedal, betterMedal } from './records.js';
import { getMedals } from './race-config.js';

/**
 * First guesses (Pete's starting numbers, 2026-10-04), pending playtest. The
 * question they answer: how many regular rides buy the first Slingshot level?
 * Target 1 — a Grandma's finish pays ~100 before any medal.
 */
export const RIDE_PAY = Object.freeze({
  metresPerCoin: 5,                     // 1 Chaos Coin per 5 m ridden
  perPickup: 5,                         // each present / gem
  finish: 25,                           // reaching the finish (Tourist: arriving)
  medal: Object.freeze({ bronze: 25, silver: 50, gold: 100 }),
  newBest: 50,                          // beating your previous best on that road
});

/**
 * One payout for a regular ride.
 *
 * result: {
 *   distance        metres reached this ride (furthest point)
 *   paidDistance    metres an earlier payout of the same ride already paid for
 *                   (a game-over then a restart from a checkpoint is one ride)
 *   pickups         collectibles to pay for (only the ones not paid yet)
 *   finished        reached the finish
 *   medal           'bronze' | 'silver' | 'gold' | null
 *   newBest         beat a previous best
 *   multiplier      the wallet's coinMultiplier()
 * }
 * A crashed, failed or abandoned ride still pays for its distance.
 */
export function scoreRide(result = {}) {
  const distance = Math.max(0, Math.floor(result.distance || 0));
  const paid = Math.max(0, Math.floor(result.paidDistance || 0));
  const metres = Math.max(0, distance - paid);
  const distPay = Math.max(0, Math.floor(distance / RIDE_PAY.metresPerCoin) - Math.floor(paid / RIDE_PAY.metresPerCoin));
  const pickups = Math.max(0, Math.floor(result.pickups || 0));
  const pickupPay = pickups * RIDE_PAY.perPickup;
  const finishPay = result.finished ? RIDE_PAY.finish : 0;
  const medalPay = (result.finished && RIDE_PAY.medal[result.medal]) || 0;
  const bestPay = result.finished && result.newBest ? RIDE_PAY.newBest : 0;
  const subtotal = distPay + pickupPay + finishPay + medalPay + bestPay;
  const multiplier = Number.isFinite(result.multiplier) && result.multiplier > 0 ? result.multiplier : 1;
  const total = Math.floor(subtotal * multiplier);
  return { metres, distPay, pickups, pickupPay, finishPay, medal: medalPay ? result.medal : null,
           medalPay, bestPay, subtotal, multiplier, total };
}

// ---- One ride, several payouts -------------------------------------------
//
// A ride can reach more than one end screen: a game-over, RESTART from the
// last checkpoint, then the finish. The ledger remembers what was already paid
// so each payout pays only what is new — the furthest metres and the most
// pickups seen so far — and the finish bonuses at most once.

export function newLedger(id = null) {
  return { id, distance: 0, pickups: 0, finished: false };
}

/**
 * What this payout should pay for, and the ledger after it.
 * now: { distance, pickups, finished }
 */
export function ledgerStep(ledger, now) {
  const distance = Math.max(ledger.distance, Math.floor(now.distance || 0));
  const pickupsSeen = Math.max(ledger.pickups, Math.floor(now.pickups || 0));
  const finished = !!now.finished && !ledger.finished;
  return {
    pay: { distance, paidDistance: ledger.distance, pickups: pickupsSeen - ledger.pickups, finished },
    ledger: { ...ledger, distance, pickups: pickupsSeen, finished: ledger.finished || !!now.finished },
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
