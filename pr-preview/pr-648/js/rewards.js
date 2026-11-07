// ============================================================
// REWARDS — what achievement milestones unlock (#611 / #610, pure, no DOM)
// ============================================================
//
// Pete, 2026-11-07 (#611): the unlock ladder.
//   Solo Flight bike  -> "player bots"  : any 80 of the 81 SOLO achievements (all solo but one)
//   Time Warp bike    -> time warp mode : any 90 of the 95 non-calendar achievements
//   Gold Standard bike                  : all 100
// The robot outfit (the Canada Goose bot's suit) comes with the player-bots reward.
//
// Groups are read from the definitions, so the counts follow the achievement swap (#608) on their own:
//   calendar    -- needs real days: a `unit: 'days'` counter (days_3, days_7, launch_week, ...) or a Daily Ride
//                  day streak (daily_streak_*)
//   multiplayer -- needs another rider: the "Riding together" and "Versus" sections, plus Full House
//   solo        -- everything else

import { ACHIEVEMENTS } from './achievement-defs.js';

export const MULTIPLAYER_SECTIONS = Object.freeze(['together', 'versus']);
export const MULTIPLAYER_IDS = Object.freeze(['full_house']);

/** Needs real days to pass (time warp mode skips these). */
export function isCalendarAchievement(def) {
  return !!def && (def.unit === 'days' || /^daily_streak_/.test(def.id));
}

/** Needs another rider (player bots stand in for them). */
export function isMultiplayerAchievement(def) {
  return !!def && (MULTIPLAYER_SECTIONS.includes(def.section) || MULTIPLAYER_IDS.includes(def.id));
}

/** Earnable alone, with no waiting for days. */
export function isSoloAchievement(def) {
  return !!def && !isCalendarAchievement(def) && !isMultiplayerAchievement(def);
}

/** Ids of the solo achievements. */
export function soloAchievementIds(defs = ACHIEVEMENTS) {
  return defs.filter(isSoloAchievement).map(d => d.id);
}

/**
 * #611 · progress toward the player-bots reward: all solo achievements but one.
 * @param {Iterable<string>} earnedIds
 * @returns {{have: number, need: number, total: number, unlocked: boolean}}
 */
export function playerBotsProgress(earnedIds, defs = ACHIEVEMENTS) {
  const solo = new Set(soloAchievementIds(defs));
  let have = 0;
  for (const id of new Set(earnedIds || [])) if (solo.has(id)) have++;
  const total = solo.size;
  const need = Math.max(0, total - 1);
  return { have, need, total, unlocked: have >= need };
}

/**
 * Outfits a player has not unlocked yet (the Dressing Room / Settings hook, #574). Today only the
 * reward outfits: `reward: 'playerBots'` in js/goose-outfits.js.
 * @param {Record<string, {reward?: string}>} outfits GOOSE_OUTFITS
 * @param {Iterable<string>} earnedIds
 */
export function lockedOutfits(outfits, earnedIds, defs = ACHIEVEMENTS) {
  const locked = new Set();
  let bots = null;
  for (const [key, o] of Object.entries(outfits)) {
    if (o.reward === 'playerBots') {
      bots = bots || playerBotsProgress(earnedIds, defs);
      if (!bots.unlocked) locked.add(key);
    }
  }
  return locked;
}

/** The line a locked reward outfit shows ("Player Bots reward: 63 of 79 solo achievements"). */
export function outfitLockHint(outfit, earnedIds, defs = ACHIEVEMENTS) {
  if (!outfit || outfit.reward !== 'playerBots') return 'Coming to the store';
  const p = playerBotsProgress(earnedIds, defs);
  return `Player Bots reward: ${p.have} of ${p.need} solo achievements`;
}
