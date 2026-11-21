// ============================================================
// BOT RACE — VERSUS BOTS' choices (#644; Pete, 2026-11-21: "like couch versus, a real race")
// ============================================================
//
// VERSUS BOTS is the couch Versus race, split screen: you (and a bot on your back seat, or nobody) against a tandem
// ridden by the other two player bots. They ride a real bike (js/versus/bot-pace.js), paced to the tier's medal time
// for the ride's difficulty: Easy = bronze, Medium = silver, Hard = gold.
//
// The result is an ordinary versus result (js/achievement-defs.js versusResult). Every tier earns the versus
// achievements, except that an Easy win does not count toward House Champion's ten.
//
// Pure: no DOM, no three.js.

import { getMedals } from './race-config.js';
import { BOT_IDS, BOTS, NO_BOT } from './player-bots.js';

/** The stored race choice, in order. 'off' = none picked yet (VERSUS BOTS opens on Easy). */
export const RACE_CHOICES = Object.freeze(['off', 'easy', 'medium', 'hard']);

/** Each tier and the medal time its bots finish on. */
export const RACE_TIERS = Object.freeze({
  easy: Object.freeze({ id: 'easy', name: 'Easy', medal: 'bronze' }),
  medium: Object.freeze({ id: 'medium', name: 'Medium', medal: 'silver' }),
  hard: Object.freeze({ id: 'hard', name: 'Hard', medal: 'gold' }),
});

export const RACE_CHOICE_KEY = 'tandemonium_bot_race';

/** The back seat left empty (a 1v2 race: Underdog). */
export const SEAT_EMPTY = NO_BOT;

export function normalizeRaceChoice(c) {
  return RACE_CHOICES.includes(c) ? c : 'off';
}

function read(store, key) {
  try { return store ? store.getItem(key) : null; } catch { return null; }
}

export function loadRaceChoice(store) {
  return normalizeRaceChoice(read(store, RACE_CHOICE_KEY));
}

export function saveRaceChoice(store, choice) {
  const c = normalizeRaceChoice(choice);
  try { if (store) store.setItem(RACE_CHOICE_KEY, c); } catch { /* private window: this session only */ }
  return c;
}

/** Can this level be raced? Grandma's and the Daily Ride (not the tutorial, Tourist or Slingshot). */
export function raceableLevel(level) {
  return !!level && !level.isTutorial && !level.isTourist && level.timerEnabled !== false && level.distance > 0
    && (level.id === 'grandma' || level.id === 'daily');
}

/** The rival tandem's two bots: [captain, stoker], the two not on your back seat. An empty seat: the first two. */
export function botTeamFor(seatBot) {
  const others = BOT_IDS.filter(id => id !== seatBot);
  return [others[0], others[1]];
}

/** "Rivet & Sprocket" */
export function botTeamName(team) {
  return team.map(id => (BOTS[id] ? BOTS[id].name : id)).join(' & ');
}

/** The time the bots finish on, in ms: the tier's medal time for this level and difficulty. */
export function botTargetMs(levelId, difficulty, tier) {
  const t = RACE_TIERS[tier];
  const medals = getMedals(levelId, difficulty);
  if (!t || !medals || !(medals[t.medal] > 0)) return 0;
  return medals[t.medal];
}
