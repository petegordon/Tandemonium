// ============================================================
// DAILY SEED (pure) — one integer describes a whole world
// ============================================================
//
// B-4 / D-0. Everything the world builds from randomness — the road, the trees,
// the clouds, the balloons, the obstacles, the presents, the geese — draws from
// a seed. Today they are four hard-coded literals, so every player rides one
// unchanging strip of road forever, and "Today's Road" (a road everyone shares
// for one day) cannot exist.
//
// This module owns two things and nothing else:
//   1. what day it is, for the purposes of a shared road;
//   2. how one seed derives the several seeds a world needs.
//
// Nothing else in the codebase may compute a day key. It is easy to write
// `new Date().toISOString().slice(0,10)` and be wrong by nine hours for half
// the players.

// The shared road rolls over at 09:00 UTC (plan §3 decision 6), which is
// 05:00 ET / 02:00 PT — the small hours in the Americas, morning in Europe.
// Midnight UTC would have flipped the road at 8pm ET, in the middle of the
// evening when people actually ride together.
export const ROLLOVER_HOUR_UTC = 9;

/**
 * Which day's road is current at `date`.
 * @returns {string} 'YYYY-MM-DD'
 */
export function dailyKey(date = new Date()) {
  const shifted = new Date(date.getTime() - ROLLOVER_HOUR_UTC * 3600 * 1000);
  return shifted.toISOString().slice(0, 10);
}

/**
 * A stable 32-bit seed from a day key (FNV-1a). Never returns 0, because 0 is
 * a legitimate-looking seed that produces a degenerate sequence in the LCGs
 * the world uses.
 */
export function seedFromKey(key) {
  let h = 0x811c9dc5;
  const s = String(key);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) || 1;
}

/** The seed for the road everyone shares on the given day. */
export function dailySeed(date = new Date()) {
  return seedFromKey(dailyKey(date));
}

// Salt table — one per thing the world seeds. Keep these stable: changing a
// salt silently changes every existing daily road.
export const SALT = {
  road: 1,
  trees: 2,
  clouds: 3,
  balloons: 4,
  ground: 5,
  obstacles: 6,
  collectibles: 7,
  geese: 8,
  disruptions: 9      // reserved for E-2
};

/**
 * Derive a distinct seed from a base seed and a salt, so the trees changing
 * does not move the road.
 */
export function deriveSeed(base, salt) {
  const b = (base >>> 0) || 1;
  return ((b ^ Math.imul(salt >>> 0, 2654435761)) >>> 0) || 1;
}

/**
 * Placement salt for a single run (B-4): the same road, different item
 * placement, so a second lap of Grandma's is not the identical pylon at 88 m.
 * The captain picks it and sends it to the stoker before the countdown.
 */
export function makePlacementSalt(now = Date.now()) {
  return now % 1000000;
}

/**
 * The seed an item manager (obstacles, presents, geese) should use.
 *
 * Three cases, in order:
 *   - a seeded level (Today's Road): derive from the level's seed;
 *   - an unseeded level with a placement salt: keep the legacy seed but move
 *     the items, so the same road plays differently run to run;
 *   - neither: exactly the legacy seed, so existing levels are unchanged.
 *
 * @param {object} level        the level definition (may carry `seed`)
 * @param {number} salt         SALT.obstacles | SALT.collectibles | SALT.geese
 * @param {number} [placementSalt] per-run salt from makePlacementSalt()
 * @param {number} legacySeed   what this manager used before B-4
 */
export function itemSeed(level, salt, placementSalt, legacySeed) {
  const base = level && typeof level.seed === 'number'
    ? deriveSeed(level.seed, salt)
    : legacySeed;
  if (!placementSalt) return base;
  return deriveSeed(base, salt + (placementSalt >>> 0));
}
