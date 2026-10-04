// ============================================================
// WALLET — one Chaos Coin wallet + one garage for every mode (#400 D4)
// ============================================================
//
// Every ride in every mode pays into this wallet (js/economy.js scores a
// regular ride, js/slingshot.js scores a launch), and the garage spends it.
// The garage's upgrade levels live here too, so there is one save for "what I
// own": coins, upgrades, prestige rebuilds. Slingshot's own progress (stage,
// best, Today's Launch) stays in its save (js/slingshot.js).
//
// Only the Coin multiplier reaches beyond the Slingshot: it (times the
// prestige bonus) multiplies every payout in every mode. The physics upgrades
// never touch a race — fairness in versus and ranked, and nobody has designed
// that.
//
// Pure and DOM-free like slingshot.js: an injectable {get,set} store.

import {
  UPGRADES, slingStats, sanitizeLevels, takeLegacyWallet, browserStore as slingBrowserStore,
} from './slingshot.js';

export const WALLET_KEY = 'tandemonium_wallet';
/** v1: coins, lifetime earned, upgrade levels, prestige rebuilds. */
export const WALLET_VERSION = 1;

/** Prestige: each rebuild adds this to a permanent coin bonus (first guess, pending playtest). */
export const REBUILD_BONUS = 0.10;

export function emptyWallet() {
  return { v: WALLET_VERSION, coins: 0, earned: 0, lv: {}, rebuilds: 0 };
}

const num = (v, d) => (Number.isFinite(v) && v >= 0 ? v : d);

export function sanitizeWallet(o) {
  const w = emptyWallet();
  if (!o || typeof o !== 'object') return w;
  const { lv, refund } = sanitizeLevels(o.lv);
  w.coins = Math.floor(num(o.coins, 0)) + refund;
  w.earned = Math.floor(num(o.earned, 0));
  w.lv = lv;
  w.rebuilds = Math.floor(num(o.rebuilds, 0));
  return w;
}

function readRaw(store) {
  try {
    const raw = store.get(WALLET_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

export function writeWallet(store, w) {
  try { store.set(WALLET_KEY, JSON.stringify(sanitizeWallet(w))); } catch (e) { /* storage full / blocked */ }
}

/**
 * Fold an old Slingshot save's coins and upgrade levels into the wallet.
 * Coins add up; levels keep the higher of the two (an upgrade is never bought
 * twice). Runs on every load and is idempotent: the Slingshot save is
 * rewritten without them, so an old build (the PR preview shares this
 * origin) that banks more coins there just has them carried over next time.
 */
export function migrateFromSlingshot(store, wallet) {
  const legacy = takeLegacyWallet(store);
  if (!legacy) return { wallet, migrated: false };
  const lv = { ...wallet.lv };
  for (const [id, v] of Object.entries(legacy.lv)) lv[id] = Math.max(lv[id] || 0, v);
  return { wallet: { ...wallet, coins: wallet.coins + legacy.coins, lv }, migrated: true };
}

/** The wallet, migrated. Always run this before touching the Slingshot save. */
export function loadWallet(store) {
  let w = sanitizeWallet(readRaw(store));
  const m = migrateFromSlingshot(store, w);
  if (m.migrated) { w = m.wallet; writeWallet(store, w); }
  return w;
}

/** Bank a payout. Returns a NEW wallet. */
export function deposit(w, amount) {
  const n = Math.max(0, Math.floor(amount || 0));
  return { ...w, coins: w.coins + n, earned: (w.earned || 0) + n };
}

/** The permanent prestige bonus: 1.0, 1.1, 1.2, … */
export function prestigeBonus(w) {
  return 1 + REBUILD_BONUS * ((w && w.rebuilds) || 0);
}

/** What every payout in every mode is multiplied by: the Coin multiplier × the prestige bonus. */
export function coinMultiplier(w) {
  return slingStats((w && w.lv) || {}).coinMult * prestigeBonus(w);
}

/** Prestige is offered only once every upgrade is maxed. */
export function canRebuild(w) {
  return UPGRADES.every(u => ((w.lv || {})[u.id] || 0) >= u.max);
}

/**
 * "Rebuild the bike": upgrade levels back to 0, coins and Slingshot progress
 * kept, one more permanent +10% on every payout. Returns { ok, wallet }.
 */
export function rebuild(w) {
  if (!canRebuild(w)) return { ok: false, wallet: w };
  return { ok: true, wallet: { ...w, lv: {}, rebuilds: (w.rebuilds || 0) + 1 } };
}

/** Guarded localStorage (same shape as every other store here). */
export const browserStore = slingBrowserStore;
