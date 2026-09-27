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

export const STORAGE_KEY = 'tandemonium_slingshot';

export const UPGRADES = [
  { id: 'sling',   name: 'Slingshot',       desc: 'Thicker bands, faster launch',       max: 10, base: 40, icon: '🎯' },
  { id: 'wheels',  name: 'Wheels',          desc: 'Smoother tyres, less rolling drag',  max: 10, base: 35, icon: '🛞' },
  { id: 'aero',    name: 'Aero frame',      desc: 'Less wind drag at speed',            max: 10, base: 50, icon: '💨' },
  { id: 'magnet',  name: 'Coin multiplier', desc: 'Every run pays more Chaos Coins',    max: 8,  base: 60, icon: '🪙' },
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
    launchMax: 14 + L('sling') * 2,                   // m/s at a full pull
    crr: 0.03 * Math.pow(0.86, L('wheels')),          // rolling resistance (× g)
    drag: 0.004 * Math.pow(0.87, L('aero')),          // aero drag (× v²)
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
export const SLING_MAX_AIM = 0.35;     // radians (~20°) off the road's line

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
 * d: road distance of the bike's centre; lateral: metres right of the centre
 * line (it follows the finger); angle: heading offset in radians, +right. Like
 * a real slingshot it flies back through the forks, so pulled left → aims right.
 */
export function aimPose(pull, side) {
  const p = clamp(pull || 0, 0, 1);
  const s = clamp(side || 0, -1, 1);
  return {
    d: SLING_REST_D - p * SLING_PULL_BACK,
    lateral: s * SLING_MAX_LATERAL * p,
    angle: -s * SLING_MAX_AIM,
  };
}

/** Metres flown from the slingshot, given the bike's distanceTraveled. */
export function runDistance(distanceTraveled) {
  return Math.max(0, (distanceTraveled || 0) - SLING_REST_D);
}

export function launchSpeed(stats, pull) {
  return stats.launchMax * clamp(pull || 0, 0, 1);
}

/** Deceleration (m/s²) while rolling at v. `onStrip` is the packed centre line. */
export function coastDecel(stats, v, onStrip = false) {
  const crr = stats.crr * (onStrip ? 0.6 : 1);
  return 9.8 * crr + stats.drag * v * v;
}

// ---- Stages (Car Evolve's distance goals) --------------------

const STAGE_GOALS = [300, 600, 900, 1200, 1800, 2400, 3600];

/** Distance goal for stage n (1-based). Past the table, +1200 m per stage. */
export function stageGoal(stage) {
  const n = Math.max(1, Math.floor(stage || 1));
  if (n <= STAGE_GOALS.length) return STAGE_GOALS[n - 1];
  return STAGE_GOALS[STAGE_GOALS.length - 1] + (n - STAGE_GOALS.length) * 1200;
}

export function stageBonus(stage) {
  return 50 * Math.max(1, Math.floor(stage || 1));
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

// ---- Scoring ------------------------------------------------

export const PAY = {
  metresPerCoin: 5,     // 1 Chaos Coin per 5 m
  perCoin: 5,
  recordDivisor: 4,     // 1 coin per 4 m beyond the old best
};

/**
 * One run's payout.
 * run:  { distance, coins, stageCleared }   (distance from the slingshot)
 * save: { best, runs, stage, lv }
 */
export function scoreRun(run, save) {
  const distance = Math.max(0, Math.floor(run.distance || 0));
  const best = save.best || 0;
  const stats = slingStats(save.lv);
  const distPay = Math.floor(distance / PAY.metresPerCoin);
  const coinPay = (run.coins || 0) * PAY.perCoin;
  const isRecord = distance > best;
  // No record bonus for the very first run: every distance "beats" zero.
  const recordPay = isRecord && (save.runs || 0) > 0
    ? Math.floor((distance - best) / PAY.recordDivisor) : 0;
  const stagePay = run.stageCleared ? stageBonus(save.stage) : 0;
  const subtotal = distPay + coinPay + recordPay + stagePay;
  const total = Math.floor(subtotal * stats.coinMult);
  return { distance, distPay, coinPay, recordPay, stagePay, subtotal,
           multiplier: stats.coinMult, total, isRecord };
}

// ---- Save ---------------------------------------------------

export function emptySave() {
  return { coins: 0, best: 0, runs: 0, stage: 1, lv: {} };
}

function sanitize(o) {
  const s = emptySave();
  if (!o || typeof o !== 'object') return s;
  const num = (v, d) => (Number.isFinite(v) && v >= 0 ? v : d);
  s.coins = Math.floor(num(o.coins, 0));
  s.best = Math.floor(num(o.best, 0));
  s.runs = Math.floor(num(o.runs, 0));
  s.stage = Math.max(1, Math.floor(num(o.stage, 1)));
  if (o.lv && typeof o.lv === 'object') {
    for (const u of UPGRADES) {
      const v = Math.floor(num(o.lv[u.id], 0));
      if (v > 0) s.lv[u.id] = Math.min(u.max, v);
    }
  }
  return s;
}

export function loadSave(store) {
  try {
    const raw = store.get(STORAGE_KEY);
    return sanitize(raw ? JSON.parse(raw) : null);
  } catch (e) {
    return emptySave();
  }
}

export function writeSave(store, save) {
  try { store.set(STORAGE_KEY, JSON.stringify(save)); } catch (e) { /* storage full / blocked */ }
}

/** Bank a scored run. Returns a NEW save; `score` comes from scoreRun. */
export function applyRun(save, run, score) {
  const next = { ...save, lv: { ...save.lv } };
  next.coins += score.total;
  next.runs += 1;
  if (score.isRecord) next.best = score.distance;
  if (run.stageCleared) next.stage += 1;
  return next;
}

/** Buy one level of an upgrade. Returns { ok, save, reason }. */
export function buyUpgrade(save, id) {
  const u = getUpgrade(id);
  if (!u) return { ok: false, save, reason: 'unknown' };
  const level = save.lv[id] || 0;
  if (level >= u.max) return { ok: false, save, reason: 'maxed' };
  const price = upgradeCost(u, level);
  if (save.coins < price) return { ok: false, save, reason: 'poor' };
  const next = { ...save, coins: save.coins - price, lv: { ...save.lv, [id]: level + 1 } };
  return { ok: true, save: next, reason: null };
}

/** Guarded localStorage, same shape as daily-ride.js browserStore(). */
export function browserStore() {
  return {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } },
  };
}
