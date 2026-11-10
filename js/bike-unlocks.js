// ============================================================
// BIKE UNLOCKS — which bikes a player can ride, and which are new (#736, pure, no DOM)
// ============================================================
//
// Pete, 2026-11-09 (#736): the bike ladder.
//   Demo                Grandma's Classic, Marmalade Express (js/edition.js DEMO_RULES.bikes)
//   Full game start     + Berry Blaster, Cherry Bomb
//   35 achievements     Jungle Cruiser   -> Christmas Cruiser (finish Grandma's on Jungle + Cherry)
//   50 achievements     Banana Delivery  -> New Year Rider    (finish Grandma's on Banana + Grandma's Classic)
//   65 achievements     Ocean Breeze     -> Birthday Express  (all five of its colours)
//   Solo Flight, Time Warp, Gold Standard: their own counts (js/rewards.js)
// A colour bike the player has already finished Grandma's on stays theirs (it was free before #736).
//
// Every bike that unlocks is celebrated once (js/bike-celebration.js). The state of what has been
// celebrated is a small record kept per browser: { bikes, edition, count }.

import { ACHIEVEMENTS } from './achievement-defs.js';
import { bikeAllowed } from './edition.js';
import { rewardProgress } from './rewards.js';
import { SPECIAL_BIKES, isSpecialBike } from './special-bikes.js';

/** Every bike, in the chooser's order. */
export const BIKE_ORDER = Object.freeze([
  'default', 'bike_orange', 'bike_magenta', 'bike_red', 'bike_blue', 'bike_green', 'bike_yellow',
  'bike_newyears', 'bike_christmas', 'bike_birthday', 'solo_flight', 'time_warp', 'gold_standard',
]);

/** Colour bikes earned by how many achievements the player has (any of the 100). */
export const COUNT_BIKES = Object.freeze({ bike_green: 35, bike_yellow: 50, bike_blue: 65 });

/** Each paint bike's "finish Grandma's on it" achievement. */
export const BIKE_ACHIEVEMENT_MAP = Object.freeze({
  default: 'grandma_default',
  bike_red: 'grandma_red',
  bike_blue: 'grandma_blue',
  bike_green: 'grandma_green',
  bike_yellow: 'grandma_yellow',
  bike_orange: 'grandma_orange',
  bike_magenta: 'grandma_magenta',
});

/** Holiday bikes: finish Grandma's on each of these bikes. */
export const HOLIDAY_BIKES = Object.freeze({
  bike_christmas: Object.freeze({ requires: Object.freeze(['bike_green', 'bike_red']) }),
  bike_newyears: Object.freeze({ requires: Object.freeze(['bike_yellow', 'default']) }),
  bike_birthday: Object.freeze({ requires: Object.freeze(['bike_red', 'bike_blue', 'bike_yellow', 'bike_green', 'default']) }),
});

export const BIKE_NAMES = Object.freeze({
  default: "Grandma's Classic",
  bike_orange: 'Marmalade Express',
  bike_magenta: 'Berry Blaster',
  bike_red: 'Cherry Bomb',
  bike_blue: 'Ocean Breeze',
  bike_green: 'Jungle Cruiser',
  bike_yellow: 'Banana Delivery',
  bike_christmas: 'Christmas Cruiser',
  bike_newyears: 'New Year Rider',
  bike_birthday: 'Birthday Express',
  solo_flight: 'Solo Flight',
  time_warp: 'Time Warp',
  gold_standard: 'Gold Standard',
});

/** How many of the 100 the player has (ids not in the list don't count). */
export function achievementCount(earnedIds, defs = ACHIEVEMENTS) {
  const all = new Set(defs.map(d => d.id));
  let n = 0;
  for (const id of new Set(earnedIds || [])) if (all.has(id)) n++;
  return n;
}

/**
 * Progress toward a count bike, or null for any other bike.
 * @returns {{have: number, need: number, unlocked: boolean, kept: boolean} | null}
 */
export function countBikeProgress(key, earnedIds, defs = ACHIEVEMENTS) {
  const need = COUNT_BIKES[key];
  if (!need) return null;
  const have = achievementCount(earnedIds, defs);
  const kept = new Set(earnedIds || []).has(BIKE_ACHIEVEMENT_MAP[key]);
  return { have, need, kept, unlocked: kept || have >= need };
}

/** Is holiday bike `key` unlocked (every bike it needs finished at Grandma's)? true for any other bike. */
export function holidayUnlocked(key, earnedIds) {
  const def = HOLIDAY_BIKES[key];
  if (!def) return true;
  const earned = new Set(earnedIds || []);
  return def.requires.every(k => earned.has(BIKE_ACHIEVEMENT_MAP[k]));
}

/** Can the player ride bike `key` under these edition rules? */
export function bikeUnlocked(key, earnedIds, rules, defs = ACHIEVEMENTS) {
  if (isSpecialBike(key)) {
    const def = SPECIAL_BIKES[key];
    const p = rewardProgress(def.reward, earnedIds, defs);
    return !!def.rideable && !!p && p.unlocked;
  }
  if (!bikeAllowed(rules, key)) return false;
  const c = countBikeProgress(key, earnedIds, defs);
  if (c) return c.unlocked;
  return holidayUnlocked(key, earnedIds);
}

/** Every bike the player can ride, in chooser order. */
export function unlockedBikes(earnedIds, rules, defs = ACHIEVEMENTS) {
  return BIKE_ORDER.filter(k => bikeUnlocked(k, earnedIds, rules, defs));
}

/**
 * The next count bike or special bike to earn, for "N more achievements to <bike>".
 * Holiday bikes are not counted goals (they come from rides), so they're skipped.
 * @returns {{key: string, name: string, left: number, unit: string} | null}
 */
export function nextBikeGoal(earnedIds, rules, defs = ACHIEVEMENTS) {
  if (rules && rules.isDemo) return null;
  const goals = [];
  for (const [key, need] of Object.entries(COUNT_BIKES)) {
    const p = countBikeProgress(key, earnedIds, defs);
    if (!p.unlocked) goals.push({ key, name: BIKE_NAMES[key], left: need - p.have, unit: 'achievements' });
  }
  for (const [key, def] of Object.entries(SPECIAL_BIKES)) {
    const p = rewardProgress(def.reward, earnedIds, defs);
    if (p && !p.unlocked) goals.push({ key, name: def.name, left: p.need - p.have, unit: def.unit });
  }
  goals.sort((a, b) => a.left - b.left || BIKE_ORDER.indexOf(a.key) - BIKE_ORDER.indexOf(b.key));
  return goals[0] || null;
}

/** The short line for the goal ("12 more achievements to Jungle Cruiser"). */
export function nextBikeGoalText(goal) {
  if (!goal) return '';
  const unit = goal.left === 1 ? goal.unit.replace(/s$/, '') : goal.unit;
  return `${goal.left} more ${unit} to ${goal.name}`;
}

/**
 * What to celebrate now. `state` is what was celebrated before (null the first time).
 *  - The first time (no state), everything the player already has is taken as seen: an existing
 *    player isn't shown bikes they already ride, and a new buyer starts with their four.
 *  - Bikes unlocked since then are new.
 *  - Coming from the demo into the full game, or a sign-in that brought in more than one achievement,
 *    is a welcome: "Your demo riding earned you N achievements and M new bikes."
 * @param {{bikes: string[], edition: 'demo'|'full', count: number} | null} state
 * @param {string[]} earnedIds
 * @param {object} rules js/edition.js rules
 * @param {{signIn?: boolean}} [opts]
 * @returns {{bikes: string[], welcome: null | {kind: 'demo'|'signin', achievements: number}, next: {bikes: string[], edition: 'demo'|'full', count: number}}}
 */
export function pendingBikeCelebration(state, earnedIds, rules, opts = {}, defs = ACHIEVEMENTS) {
  const have = unlockedBikes(earnedIds, rules, defs);
  const edition = rules && rules.isDemo ? 'demo' : 'full';
  const count = achievementCount(earnedIds, defs);
  const seen = state && Array.isArray(state.bikes) ? state.bikes : null;
  const next = { bikes: [...new Set([...(seen || []), ...have])], edition, count };
  if (!seen) return { bikes: [], welcome: null, next };
  const bikes = have.filter(k => !seen.includes(k));
  const gained = Math.max(0, count - (Number(state.count) || 0));
  let welcome = null;
  if (state.edition === 'demo' && edition === 'full') welcome = { kind: 'demo', achievements: gained };
  else if (opts.signIn && gained > 1) welcome = { kind: 'signin', achievements: gained };
  return { bikes, welcome, next };
}

/** The welcome line for a jump. */
export function welcomeText(welcome, bikeCount) {
  if (!welcome) return '';
  const from = welcome.kind === 'demo' ? 'Your demo riding' : 'Your saved riding';
  const a = `${welcome.achievements} achievement${welcome.achievements === 1 ? '' : 's'}`;
  if (!bikeCount) return `${from} earned you ${a}.`;
  return `${from} earned you ${a} and ${bikeCount} new bike${bikeCount === 1 ? '' : 's'}.`;
}

/** How a bike was earned (the line under its name on the celebration). */
export function earnedLine(key) {
  if (COUNT_BIKES[key]) return `${COUNT_BIKES[key]} achievements`;
  if (HOLIDAY_BIKES[key]) return 'Finished Grandma\'s on ' + HOLIDAY_BIKES[key].requires.map(k => BIKE_NAMES[k]).join(', ');
  if (key === 'solo_flight') return 'Any 80 of the 81 solo achievements. Player bots are yours too';
  if (key === 'time_warp') return "Any 90 of the 95 achievements that don't need real days";
  if (key === 'gold_standard') return 'All 100 achievements';
  if (key === 'bike_magenta' || key === 'bike_red') return 'Comes with the full game';
  return '';
}
