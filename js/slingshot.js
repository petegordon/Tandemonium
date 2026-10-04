// ============================================================
// SLINGSHOT — launch-for-distance mode: economy, upgrades, scoring
// ============================================================
//
// A giant slingshot holds the bike on the start line. Touch (or click) and
// drag back to stretch the bands; drag left/right to shift the bike in the
// pouch and swing its aim; let go and it flies toward the gap between the
// forks. After that the riders only steer — no pedaling in this mode — and
// the bike coasts until it rolls to a stop, crashes or reaches the stage goal.
// There are no checkpoints; a reset puts the bike back in the slingshot. Every
// run pays Chaos Coins: distance, coins picked up on the road, a record bonus
// and a stage-goal bonus, all times the coin multiplier. Coins buy garage
// upgrades, which make the next launch go further. (After Car Evolve and the
// Tandem Launch prototype.)
//
// Pure and DOM-free like records.js / daily-ride.js: the save lives behind an
// injectable {get,set} store so the tests run in Node. game.js only glues it in.

import { seedFromKey, deriveSeed } from './daily-seed.js';

export const STORAGE_KEY = 'tandemonium_slingshot';

/**
 * Normal-ride systems that stay off in this mode (see Game._rideSystemOn):
 * no achievements for being flung, no ghost/disruptions/assist built for a
 * pedalled race, no coach card, no cruise control (it would never stall), and
 * launch/result events instead of a ride per launch in analytics.
 */
export const SLING_SYSTEMS_OFF = new Set(['achievements', 'ghost', 'disruptions', 'dda', 'coach', 'cruise', 'rideAnalytics']);

// The garage (#400 D5). The upgrades live in the shared wallet (js/wallet.js)
// and every mode's payout uses the Coin multiplier, but Slingshot and Tyres &
// frame only ever change Slingshot physics — never a race. Aero was folded into
// Tyres & frame: on its own it was a trap pick (+7 m for 50 coins at level 1).
// Prices are first guesses pending playtest, tuned by the progression sim in
// test/unit/slingshot.test.mjs.
export const UPGRADES = [
  { id: 'sling',   name: 'Slingshot',       desc: 'Thicker bands, faster launch',        max: 10, base: 40, icon: '🎯' },
  { id: 'wheels',  name: 'Tyres & frame',   desc: 'Less rolling drag and less wind drag', max: 10, base: 70, icon: '🛞' },
  { id: 'magnet',  name: 'Coin multiplier', desc: 'Every ride, every mode pays more',    max: 8,  base: 60, icon: '🪙' },
];

export function getUpgrade(id) {
  return UPGRADES.find(u => u.id === id) || null;
}

/** Price of the NEXT level of an upgrade currently at `level`. */
export function upgradeCost(upgrade, level) {
  return Math.round(upgrade.base * Math.pow(1.55, level) / 5) * 5;
}

/** Physics + payout numbers for a set of upgrade levels. */
export function slingStats(lv = {}) {
  const L = id => lv[id] || 0;
  return {
    launchMax: 14 + L('sling') * 1.2,                 // m/s at a full pull
    crr: 0.02 * Math.pow(0.93, L('wheels')),          // rolling resistance (× g) on dirt
    drag: 0.001 * Math.pow(0.93, L('wheels')),        // air drag (× v²) — Tyres & frame does both
    coinMult: 1 + L('magnet') * 0.25,                 // payout multiplier
  };
}

// ---- The slingshot ------------------------------------------

// The fork stands at SLING_POST_D; the bike rests with its rear wheel in the
// pouch at SLING_REST_D. Dragging back draws it up to SLING_PULL_BACK metres
// behind that and up to SLING_MAX_LATERAL to either side. Distance is scored
// from the rest point, so the pull itself never counts.
export const SLING_POST_D = 3;
export const SLING_REST_D = 5.2;       // post + half the 4.4 m bike
export const SLING_PULL_BACK = 3.5;
export const SLING_MAX_LATERAL = 1.4;  // metres the pouch can be pulled aside
// A nudge, not a swerve: at full pull and full side the bike crosses to the
// far lane about 40 m out and stays on the road beyond that (steering does the
// rest). 20° sent it into the grass within 11 m.
export const SLING_MAX_AIM = 0.07;     // radians (~4°) off the road's line
export const ROAD_HALF_WIDTH = 2.5;

/** A drag of this fraction of the screen height is a full pull… */
export const DRAG_FULL_FRACTION = 0.3;
/** …and this fraction of the screen width is a full swing to one side. */
export const DRAG_SIDE_FRACTION = 0.25;
/** Below this pull, letting go is a cancel, not a launch. */
export const MIN_LAUNCH_PULL = 0.15;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * A drag (pixels from where the finger went down, +y = toward the player)
 * → { pull 0..1, side -1..1 }. `side` is where the finger went: -1 left.
 */
export function dragToAim(dx, dy, screenW, screenH) {
  const pull = clamp((dy || 0) / Math.max(1, (screenH || 800) * DRAG_FULL_FRACTION), 0, 1);
  const side = clamp((dx || 0) / Math.max(1, (screenW || 1280) * DRAG_SIDE_FRACTION), -1, 1);
  return { pull, side };
}

/**
 * Where the bike sits in the drawn slingshot and where it will fly.
 * d: road distance of the bike's centre; lateral: metres to the rider's right
 * (it follows the finger); angle: heading offset in radians toward the rider's
 * right. Like a real slingshot it flies back through the forks, so pulled
 * left → aims right. Both grow with the pull: a lazy pull is a straight shot.
 */
export function aimPose(pull, side) {
  const p = clamp(pull || 0, 0, 1);
  const s = clamp(side || 0, -1, 1);
  return {
    d: SLING_REST_D - p * SLING_PULL_BACK,
    lateral: s * SLING_MAX_LATERAL * p,
    angle: -s * SLING_MAX_AIM * p,
  };
}

/**
 * Metres of straight flight before a bike starting `lateral` from the centre
 * line on heading offset `angle` leaves the road (Infinity if it never does).
 * The first 80 m of the road are straight, which is all the aim reaches.
 */
export function roadExitDistance(lateral, angle, halfWidth = ROAD_HALF_WIDTH) {
  const slope = Math.tan(angle || 0);
  if (Math.abs(lateral) >= halfWidth) return 0;
  if (Math.abs(slope) < 1e-9) return Infinity;
  const edge = slope > 0 ? halfWidth : -halfWidth;
  return (edge - lateral) / slope;
}

/** Metres flown from the slingshot, given the bike's distanceTraveled. */
export function runDistance(distanceTraveled) {
  return Math.max(0, (distanceTraveled || 0) - SLING_REST_D);
}

export function launchSpeed(stats, pull) {
  return stats.launchMax * clamp(pull || 0, 0, 1);
}

// ---- Rolling ------------------------------------------------

/**
 * Rolling resistance by surface, relative to dirt. Additive, not a speed
 * multiplier: the normal ride's edge/grass drag shaved a share of the speed
 * every second, so any line off the centre threw most of a run away and
 * "never steer" was the only strategy. Now steering costs a little, not all.
 */
export const SURFACE_RR = { strip: 0.6, dirt: 1, edge: 1.5, grass: 4 };

/** Surface under the bike from its distance to the centre line (metres). */
export function surfaceAt(centerDist) {
  const c = Math.abs(centerDist || 0);
  if (c < 0.5) return 'strip';
  if (c < 2.0) return 'dirt';
  if (c <= ROAD_HALF_WIDTH) return 'edge';
  return 'grass';
}

/** Deceleration (m/s²) while rolling at v on a surface — or flying (air drag only). */
export function coastDecel(stats, v, surface = 'dirt', airborne = false) {
  if (airborne) return stats.drag * v * v;
  const rr = SURFACE_RR[surface] != null ? SURFACE_RR[surface] : 1;
  return 9.8 * stats.crr * rr + stats.drag * v * v;
}

/** Metres a launch at `pull` rolls on one surface before stopping. */
export function predictCoast(stats, pull, surface = 'dirt') {
  let v = launchSpeed(stats, pull), d = 0;
  const dt = 1 / 30;
  for (let i = 0; i < 30 * 600 && v > 0.3; i++) {
    v = Math.max(0, v - coastDecel(stats, v, surface) * dt);
    d += v * dt;
  }
  return d;
}

// ---- Stages (Car Evolve's distance goals) --------------------

// Every goal fits inside one lap of the 1200 m loop road (the finish past the
// rest point must not wrap round into the slingshot). Tuned by the progression
// simulation in test/unit/slingshot.test.mjs: 2–4 launches per stage.
export const STAGE_GOALS = [300, 420, 540, 660, 780, 900, 1050];

/** Distance goal for stage n (1-based). The last goal repeats past the table. */
export function stageGoal(stage) {
  const n = Math.max(1, Math.floor(stage || 1));
  return STAGE_GOALS[Math.min(n, STAGE_GOALS.length) - 1];
}

export function stageBonus(stage) {
  return 50 * Math.max(1, Math.floor(stage || 1));
}

// ---- Stage gates (#400 D11a) --------------------------------

/**
 * Some stages need something from the rest of the game before they can be
 * launched: going back to a regular ride is how you progress here. Keyed by
 * the stage that is LOCKED. Edit freely — each row is one of:
 *   { level, medal }  a medal of at least `medal` on `level` (any mode/difficulty)
 *   { daily: true }   any finished Today's Road
 * First guesses (Pete, 2026-10-04), pending playtest.
 */
export const STAGE_GATES = {
  4: { level: 'grandma', medal: 'bronze', label: "Win a 🥉 bronze on Grandma's" },
  6: { daily: true, level: 'daily', label: "Finish a Today's Road" },
  7: { level: 'grandma', medal: 'gold', label: "Win a 🥇 gold on Grandma's" },
};

const MEDAL_RANK = { bronze: 1, silver: 2, gold: 3 };

/**
 * Why stage `stage` can't be launched yet, or null when it can.
 * progress: { medals: { [levelId]: 'gold'|'silver'|'bronze' }, dailyFinished }
 * (js/economy.js · gateProgress builds it from the records and Today's Road).
 * maxStage: the edition's cap (js/edition.js) — past it, it's the demo's end.
 * @returns {null | { kind: 'demo'|'medal'|'daily', label, level? }}
 */
export function stageLock(stage, progress = {}, { maxStage = null } = {}) {
  const n = Math.max(1, Math.floor(stage || 1));
  if (maxStage != null && n > maxStage) {
    return { kind: 'demo', label: "That's the demo — get the full game for more stages" };
  }
  const gate = STAGE_GATES[n];
  if (!gate) return null;
  if (gate.daily) {
    return progress.dailyFinished ? null : { kind: 'daily', label: gate.label, level: gate.level };
  }
  const have = MEDAL_RANK[(progress.medals || {})[gate.level]] || 0;
  return have >= MEDAL_RANK[gate.medal] ? null : { kind: 'medal', label: gate.label, level: gate.level };
}

// ---- Course -------------------------------------------------

export const COINS_PER_TRAIL = 5;
const TRAIL_STEP = 3;          // metres between coins in a trail

function lcg(seed) {
  let s = (Math.abs(Math.floor(seed)) % 233280) || 1;
  return () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
}

/**
 * Chaos-coin trails along [start, distance): lines of COINS_PER_TRAIL coins,
 * each trail at one lateral offset, so a rider has to commit to a line to
 * sweep it. Returns [{d, offset}] for CollectibleManager.replaceItems().
 */
export function planCoinTrails(distance, seed = 1, { start = 60, halfWidth = 1.8 } = {}) {
  const rng = lcg(seed);
  const out = [];
  let d = start;
  while (d + COINS_PER_TRAIL * TRAIL_STEP < distance) {
    const trailLen = (COINS_PER_TRAIL - 1) * TRAIL_STEP;
    const offset = (rng() * 2 - 1) * halfWidth;
    for (let i = 0; i < COINS_PER_TRAIL; i++) out.push({ d: d + i * TRAIL_STEP, offset });
    d += trailLen + 45 + rng() * 45;
  }
  return out;
}

/** Three lanes, in the road's own lateral convention (the collectibles'). */
export const LANES = [-1.6, 0, 1.6];

/**
 * The stage's fixed layout — the same every launch, so a stage is something
 * you learn. Distances are road distances (rest point included).
 *  - Gate 1 (~45 m, where the aim can reach any lane): one lane of coins, one
 *    hay bale, one clear lane.
 *  - Gate 2 (~110 m, reached by steering): coins, hay, and from stage 2 the
 *    JACKPOT billboard — hit it and the run ends at double pay.
 *  - Then coin trails all the way to the goal.
 */
export function planCourse(stage, distance, { seed = null } = {}) {
  // A seed (Today's Launch) replaces the stage's fixed layout with the day's.
  const rng = lcg(seed != null ? seed : 7919 * Math.max(1, Math.floor(stage || 1)) + 13);
  const pickLanes = () => {
    const l = LANES.slice();
    for (let i = l.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [l[i], l[j]] = [l[j], l[i]]; }
    return l;
  };
  const coins = [], hay = [], ramps = [];
  let jackpot = null;
  const fan = (d, offset) => { for (let i = 0; i < COINS_PER_TRAIL; i++) coins.push({ d: d - 6 + i * TRAIL_STEP, offset }); };

  const g1 = SLING_REST_D + 45, [c1, h1] = pickLanes();
  fan(g1, c1);
  hay.push({ d: g1, offset: h1 });

  const g2 = SLING_REST_D + 110, [c2, h2, j2] = pickLanes();
  fan(g2, c2);
  hay.push({ d: g2, offset: h2 });
  if (stage >= 2) jackpot = { d: g2 + 8, offset: j2 };

  // Ramps: one 7 m short of gate 2's hay bale, in its lane — fast enough
  // (~12 m/s) and you sail over it, too slow and you land in it — then one
  // every 110–170 m down the road, each in a random lane.
  ramps.push({ d: g2 - 7, offset: h2 });
  for (let d = g2 + 90; d < distance - 40; d += 110 + rng() * 60) ramps.push({ d, offset: LANES[Math.floor(rng() * 3)] });

  coins.push(...planCoinTrails(distance, seed != null ? Math.floor(rng() * 233280) + 1 : 31 * stage + 7, { start: g2 + 40 }));
  // No coin trail sits on a ramp.
  const clear = coins.filter(c => !ramps.some(r => Math.abs(c.d - r.d) < 4 && Math.abs(c.offset - r.offset) < 1.2));
  return { coins: clear, hay, ramps, jackpot };
}

// ---- Air ----------------------------------------------------

/** Vertical speed off a ramp: faster bikes fly higher, within reason. */
export function rampLaunch(speed) {
  return Math.min(8, 2 + 0.3 * Math.max(0, speed || 0));
}

/** Seconds in the air for a launch at vy on flat ground. */
export function airTime(vy) {
  return (2 * Math.max(0, vy)) / 9.8;
}

/** A landing after this long in the air is Big Air, and pays. */
export const BIG_AIR_S = 0.8;
export const BIG_AIR_PAY = 10;
/** Clear this height and you sail over a hay bale instead of into it. */
export const HAY_CLEAR_H = 1.2;

// ---- Scoring ------------------------------------------------

// First guesses pending playtest. Slingshot pays faster per metre than a
// regular ride (js/economy.js · RIDE_PAY, 1 per 5 m) because a launch is a
// few seconds long and the metres are the whole game here.
export const PAY = {
  metresPerCoin: 2,     // 1 Chaos Coin per 2 m
  perCoin: 5,
  recordDivisor: 4,     // 1 coin per 4 m beyond the old best
};

/** The jackpot billboard: a flat bonus, then the whole run pays double. */
export function jackpotBonus(stage) {
  return 100 + 50 * Math.max(1, Math.floor(stage || 1));
}

/**
 * One run's payout.
 * run:  { distance, coins, stageCleared, jackpot, bigAirs }   (distance from the slingshot)
 * save: { best, runs, stage }  — for Today's Launch, the day's best and runs
 * coinMult: the wallet's multiplier (js/wallet.js · coinMultiplier). Defaults
 *   to what save.lv would give, for callers that still pass upgrade levels.
 */
export function scoreRun(run, save, coinMult = slingStats(save.lv).coinMult) {
  const distance = Math.max(0, Math.floor(run.distance || 0));
  const best = save.best || 0;
  const distPay = Math.floor(distance / PAY.metresPerCoin);
  const coinPay = (run.coins || 0) * PAY.perCoin;
  const isRecord = distance > best;
  // No record bonus for the very first run: every distance "beats" zero.
  const recordPay = isRecord && (save.runs || 0) > 0
    ? Math.floor((distance - best) / PAY.recordDivisor) : 0;
  const stagePay = run.stageCleared ? stageBonus(save.stage) : 0;
  const jackpotPay = run.jackpot ? jackpotBonus(save.stage) : 0;
  const airPay = (run.bigAirs || 0) * BIG_AIR_PAY;
  const subtotal = distPay + coinPay + recordPay + stagePay + jackpotPay + airPay;
  const multiplier = coinMult * (run.jackpot ? 2 : 1);
  const total = Math.floor(subtotal * multiplier);
  return { distance, distPay, coinPay, recordPay, stagePay, jackpotPay, airPay, subtotal,
           multiplier, total, isRecord };
}

// ---- Today's Launch (#400 D11b) ----------------------------

/**
 * One seeded course a day, the same for everyone, on the day key Today's Road
 * uses (js/daily-seed.js). No stage goal: the run ends when the bike stalls or
 * crashes, and the day's best distance is the thing to beat.
 */
export const TODAYS_LAUNCH_SALT = 101;          // private to this mode: not in daily-seed's SALT table
export const TODAYS_LAUNCH_LENGTH = 1150;       // past every stage goal, inside one 1200 m lap
const TODAYS_LAUNCH_LAYOUT_STAGE = 7;           // jackpot billboard on, like a late stage

export function todaysLaunchSeed(key) {
  return deriveSeed(seedFromKey(key), TODAYS_LAUNCH_SALT);
}

/** The day's course: deterministic per key, different from day to day. */
export function todaysLaunchCourse(key) {
  return planCourse(TODAYS_LAUNCH_LAYOUT_STAGE, TODAYS_LAUNCH_LENGTH + SLING_REST_D, { seed: todaysLaunchSeed(key) });
}

/** The save's record for `key` (a fresh one when the stored day is another day). */
export function todaysLaunchStatus(save, key) {
  const d = save && save.daily;
  return d && d.key === key ? { key, best: d.best || 0, runs: d.runs || 0 } : { key, best: 0, runs: 0 };
}

/** Bank a Today's Launch run on the save. Returns a NEW save. */
export function applyTodaysLaunch(save, key, score) {
  const cur = todaysLaunchStatus(save, key);
  return { ...save, daily: { key, best: Math.max(cur.best, score.distance), runs: cur.runs + 1 } };
}

// ---- Save ---------------------------------------------------
//
// v3 (#400): Chaos Coins and the upgrade levels moved to the one wallet every
// mode shares (js/wallet.js). This save keeps only Slingshot's own progress.
// A v1/v2 save still carries `coins` and `lv`; takeLegacyWallet() hands them
// over exactly once (the wallet migration calls it).

export const SAVE_VERSION = 3;

export function emptySave() {
  return { v: SAVE_VERSION, best: 0, runs: 0, stage: 1, daily: null };
}

/**
 * Upgrades that existed in earlier builds and were removed (pedaling and the
 * checkpoint gates left the mode; Aero folded into Tyres & frame). Their base
 * prices, so a save that bought them gets every coin back instead of silently
 * losing it.
 */
export const RETIRED_UPGRADES = { legs: 45, stamina: 40, gate: 45, aero: 50 };

/** Coins spent taking an upgrade with this base price from 0 to `level`. */
export function spentOn(base, level) {
  let total = 0;
  for (let l = 0; l < level; l++) total += upgradeCost({ base }, l);
  return total;
}

const num = (v, d) => (Number.isFinite(v) && v >= 0 ? v : d);

/**
 * Live upgrade levels from any object, clamped, plus the coins refunded for
 * retired ones. Shared by the legacy hand-over and the wallet's own sanitize.
 */
export function sanitizeLevels(rawLv) {
  const lv = {};
  let refund = 0;
  if (rawLv && typeof rawLv === 'object') {
    for (const u of UPGRADES) {
      const v = Math.floor(num(rawLv[u.id], 0));
      if (v > 0) lv[u.id] = Math.min(u.max, v);
    }
    for (const [id, base] of Object.entries(RETIRED_UPGRADES)) {
      const v = Math.floor(num(rawLv[id], 0));
      if (v > 0) refund += spentOn(base, Math.min(10, v));
    }
  }
  return { lv, refund };
}

function sanitize(o) {
  const s = emptySave();
  if (!o || typeof o !== 'object') return s;
  s.best = Math.floor(num(o.best, 0));
  s.runs = Math.floor(num(o.runs, 0));
  s.stage = Math.max(1, Math.floor(num(o.stage, 1)));
  const d = o.daily;
  if (d && typeof d === 'object' && typeof d.key === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.key)) {
    s.daily = { key: d.key, best: Math.floor(num(d.best, 0)), runs: Math.floor(num(d.runs, 0)) };
  }
  return s;
}

function readRaw(store) {
  try {
    const raw = store.get(STORAGE_KEY);
    const o = raw ? JSON.parse(raw) : null;
    return o && typeof o === 'object' ? o : null;
  } catch (e) {
    return null;
  }
}

export function loadSave(store) {
  return sanitize(readRaw(store));
}

export function writeSave(store, save) {
  try { store.set(STORAGE_KEY, JSON.stringify(sanitize(save))); } catch (e) { /* storage full / blocked */ }
}

/**
 * The coins and upgrade levels an old (v1/v2) save still holds, with retired
 * upgrades refunded as coins — and the save rewritten without them, so they
 * can only ever be handed over once. Returns null when there is nothing.
 */
export function takeLegacyWallet(store) {
  const o = readRaw(store);
  if (!o || (o.coins == null && o.lv == null)) return null;
  const { lv, refund } = sanitizeLevels(o.lv);
  const coins = Math.floor(num(o.coins, 0)) + refund;
  writeSave(store, o);   // sanitize drops coins + lv
  return { coins, lv };
}

/** Bank a scored stage run. Returns a NEW save; `score` comes from scoreRun. Coins go to the wallet. */
export function applyRun(save, run, score) {
  const next = { ...save };
  next.runs += 1;
  if (score.isRecord) next.best = score.distance;
  if (run.stageCleared) next.stage += 1;
  return next;
}

/**
 * Buy one level of an upgrade from a wallet ({ coins, lv, … }).
 * Returns { ok, save, reason } — `save` is the new wallet.
 */
export function buyUpgrade(save, id) {
  const u = getUpgrade(id);
  if (!u) return { ok: false, save, reason: 'unknown' };
  const level = (save.lv || {})[id] || 0;
  if (level >= u.max) return { ok: false, save, reason: 'maxed' };
  const price = upgradeCost(u, level);
  if (save.coins < price) return { ok: false, save, reason: 'poor' };
  const next = { ...save, coins: save.coins - price, lv: { ...save.lv, [id]: level + 1 } };
  return { ok: true, save: next, reason: null, price };
}

/** Metres a full pull gains from the next level of `id` (0 for the Coin multiplier). */
export function upgradeGain(lv, id) {
  const u = getUpgrade(id);
  const level = (lv || {})[id] || 0;
  if (!u || level >= u.max) return 0;
  const now = predictCoast(slingStats(lv), 1, 'dirt');
  const next = predictCoast(slingStats({ ...lv, [id]: level + 1 }), 1, 'dirt');
  return Math.max(0, next - now);
}

/** Guarded localStorage, same shape as daily-ride.js browserStore(). */
export function browserStore() {
  return {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } },
  };
}

// ---- Stick let-go (left stick as the pouch) -------------------------------
//
// Pull the left stick back (down) to draw, sideways to aim, and let go. No
// timing: the shot is the strongest pull reached, with the aim held there
// (aiming while holding near full draw updates it), and it flies when the
// stick is back home — however fast or slow it gets there. To shoot softer,
// pull back less.

export const STICK = {
  HOME_BELOW: 0.12,        // pull under this = the stick is back at centre
  NEAR_PEAK: 0.1,          // aiming within this of the strongest pull still counts
};

/** A fresh tracker for one pull. */
export function stickTracker() {
  return { peak: 0, side: 0 };
}

/**
 * Feed this frame's stick pull/aim. Returns the shot {pull, side} on the
 * frame the stick comes home after a real pull, else null. The tracker resets
 * once the stick is home, so a pull can only fire once.
 */
export function stickUpdate(tracker, pull, side) {
  if (pull >= STICK.HOME_BELOW) {
    if (pull > tracker.peak) tracker.peak = pull;
    if (pull >= tracker.peak - STICK.NEAR_PEAK) tracker.side = side;
    return null;
  }
  const shot = tracker.peak >= MIN_LAUNCH_PULL ? { pull: tracker.peak, side: tracker.side } : null;
  tracker.peak = 0;
  tracker.side = 0;
  return shot;
}
