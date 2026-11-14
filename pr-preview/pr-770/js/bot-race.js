// ============================================================
// BOT RACE — race a bot ghost team on Solo Flight (#644 step 2)
// ============================================================
//
// Pete, 2026-11-07 (#644, round 2):
//   "Versus with player bots: on Solo Flight you can race a bot ghost team: a recorded bot tandem built from real
//    ride ghosts, like the personal-best (PB) ghost. Beating it counts as a versus race. There's no live AI steering.
//    This makes all 14 multiplayer achievements reachable with bots, so Time Warp (90 of 95) is reachable solo."
//
// How it works:
//   - The opponent is ONE ghost tandem ridden by the two bots who are not on your back seat (you ride with Bolt:
//     Rivet captains it and Sprocket stokes). With the back seat empty, Bolt and Rivet ride it.
//   - It follows a shipped recording of a real ride on that road (js/bot-ghost-runs.js, recorded by
//     scripts/record-bot-ghosts.mjs with the game's own ghost recorder, js/ghost.js), stretched in time so it
//     finishes on the tier's medal time for the ride's difficulty: Easy = bronze, Medium = silver, Hard = gold.
//     So the ghost is as hard as the game's own medals, on every road and difficulty, and never free.
//   - It is a ghost: no collisions, no physics. You win by finishing before it.
//   - The result goes through the same versus result as a couch race (js/achievement-defs.js versusResult), with
//     your team = you (+ your bot) and the ghost team = two bots. So the versus achievements read it unchanged:
//       Rivals          finish a race (Medium or Hard; win or lose, as a couch race)
//       Crown the Goose win one                     House Champion  win 10
//       Royal Court     win with a bot on your back seat (2v2: you + bot vs the two-bot ghost tandem)
//       Underdog        win with the back seat empty (1v2: you alone vs the two-bot ghost tandem)
//       Comeback Geese  win after the ghost led when the leader crossed halfway
//       Clean Sweep     win without a crash
//       Full House      its versus mode (any counted race)
//   - Easy is a warm-up: it is a Solo Flight ride like any other (the bot partner still counts), but the race
//     counts nothing toward the versus achievements. Medium and Hard count.
//
// Pure: no DOM, no three.js.

import { GhostPlayer } from './ghost.js';
import { getMedals } from './race-config.js';
import { BOT_IDS, BOTS, NO_BOT } from './player-bots.js';
import { versusResult } from './achievement-defs.js';

/** The race picker on the Solo Flight card, in order. 'off' = no race. */
export const RACE_CHOICES = Object.freeze(['off', 'easy', 'medium', 'hard']);

/** Each tier: the medal time the ghost finishes on, and whether a race on it counts as a versus race. */
export const RACE_TIERS = Object.freeze({
  easy: Object.freeze({ id: 'easy', name: 'Easy', medal: 'bronze', counts: false, run: 0 }),
  medium: Object.freeze({ id: 'medium', name: 'Medium', medal: 'silver', counts: true, run: 1 }),
  hard: Object.freeze({ id: 'hard', name: 'Hard', medal: 'gold', counts: true, run: 2 }),
});

export const RACE_CHOICE_KEY = 'tandemonium_bot_race';

/** The back seat left empty (a 1v2 race: Underdog). The Solo Flight card's "Nobody" chip. */
export const SEAT_EMPTY = NO_BOT;

/** How far right of the road's centre the ghost rides, in metres (the road is 5 m wide), so it doesn't sit in you. */
export const GHOST_LANE = 1.1;
/** How much of the recorded weave the ghost keeps around its lane. */
export const GHOST_WEAVE = 0.45;
const ROAD_EDGE = 2.2;

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

/**
 * The ghost tandem's two bots: [captain, stoker], the two who are not on your back seat (in picker order).
 * An empty back seat (SEAT_EMPTY): the first two.
 */
export function ghostTeamFor(seatBot) {
  const others = BOT_IDS.filter(id => id !== seatBot);
  return [others[0], others[1]];
}

/** "Rivet & Sprocket" */
export function ghostTeamName(team) {
  return team.map(id => (BOTS[id] ? BOTS[id].name : id)).join(' & ');
}

/** The time the ghost finishes on, in ms: the tier's medal time for this level and difficulty. */
export function ghostTargetMs(levelId, difficulty, tier) {
  const t = RACE_TIERS[tier];
  const medals = getMedals(levelId, difficulty);
  if (!t || !medals || !(medals[t.medal] > 0)) return 0;
  return medals[t.medal];
}

/** The recorded run a tier replays on a level (runs: js/bot-ghost-runs.js shape). The Daily Ride's road changes
 *  every day: its runs come from one recorded Daily road, and only the road distance along it is replayed exactly. */
export function ghostRunFor(runs, levelId, tier) {
  const list = (runs && (runs[levelId] || runs.grandma)) || [];
  if (!list.length) return null;
  const t = RACE_TIERS[tier];
  return list[Math.min(list.length - 1, t ? t.run : 0)];
}

/**
 * Stretch a recorded track so it ends at `raceDistance` exactly, `targetMs` after the start. The shape of the ride
 * (the start, the slow bits, the weave and lean) is kept; only its pace changes.
 * @returns {{hz: number, count: number, data: number[]}|null}
 */
export function scaleTrack(track, targetMs, raceDistance) {
  if (!track || !(track.count > 1) || !(targetMs > 0)) return null;
  const data = Array.from(track.data, Number);
  const n = track.count;
  const last = data[(n - 1) * 3];
  const k = last > 0 && raceDistance > 0 ? raceDistance / last : 1;
  for (let i = 0; i < n; i++) data[i * 3] *= k;
  return { hz: (n - 1) / (targetMs / 1000), count: n, data };
}

/** Where the ghost rides across the road: its lane plus some of the recorded weave, kept on the road. */
export function ghostLateral(recorded) {
  return Math.max(-ROAD_EDGE, Math.min(ROAD_EDGE, GHOST_LANE + GHOST_WEAVE * (recorded || 0)));
}

/**
 * One race against the ghost team.
 *   opts: { level: {id, distance}, difficulty, tier, seatBot (a bot id or SEAT_EMPTY), runs }
 * Feed it the race clock and the player's distance each frame (frame), read the ghost (at), and at the finish ask
 * for the result.
 */
export class BotRace {
  constructor({ level, difficulty, tier, seatBot, runs }) {
    this.levelId = level.id;
    this.raceDistance = level.distance;
    this.tier = RACE_TIERS[tier] ? tier : 'medium';
    this.seatBot = seatBot || SEAT_EMPTY;
    this.team = ghostTeamFor(this.seatBot);
    this.targetMs = ghostTargetMs(level.id, difficulty, this.tier);
    const run = ghostRunFor(runs, level.id, this.tier);
    const track = scaleTrack(run, this.targetMs, this.raceDistance);
    this.player = track ? new GhostPlayer(track) : null;
    this.halfLeader = null;
  }

  get ok() { return !!this.player; }
  get counts() { return RACE_TIERS[this.tier].counts; }
  get solo() { return this.seatBot === SEAT_EMPTY || !BOT_IDS.includes(this.seatBot); }
  get teamName() { return ghostTeamName(this.team); }

  /** The ghost at `seconds` into the race: {roadD, lateral (the ghost's lane), lean, speed, finished}. */
  at(seconds) {
    if (!this.player) return null;
    const s = Math.max(0, seconds || 0);
    const a = this.player.at(s);
    const b = this.player.at(s + 0.2);
    return { roadD: a.roadD, lateral: ghostLateral(a.lateral), lean: a.lean,
      speed: Math.max(0, (b.roadD - a.roadD) / 0.2), finished: a.finished };
  }

  /** Each frame: who leads when the leader crosses halfway (Comeback Geese). Returns the gap in metres (+ = you ahead). */
  frame(seconds, playerD) {
    const g = this.at(seconds);
    if (!g) return 0;
    const pd = Math.max(0, playerD || 0);
    if (!this.halfLeader && Math.max(pd, g.roadD) >= this.raceDistance / 2) {
      this.halfLeader = pd >= g.roadD ? 'you' : 'ghost';
    }
    return pd - g.roadD;
  }

  /** Has the ghost crossed the line by `seconds`? */
  ghostFinished(seconds) {
    return this.targetMs > 0 && (seconds || 0) * 1000 >= this.targetMs;
  }

  /**
   * The race's result when the player finishes (the ghost has always finished by the time a slower player does).
   *   { timeMs: the player's time, crashes, speed: the player's speed at the line }
   * Returns the versusResult detail (js/achievement-defs.js) plus {won, marginMs, counts}.
   */
  result({ timeMs, crashes = 0, speed = 0 }) {
    const won = timeMs > 0 && timeMs < this.targetMs;
    const you = { id: 'you', members: this.solo ? [{ type: 'human' }] : [{ type: 'human' }, { type: 'bot' }],
      crashes, distance: this.raceDistance, speed };
    const g = this.at(Math.min(timeMs, this.targetMs) / 1000);
    const ghost = { id: 'ghost', members: [{ type: 'bot' }, { type: 'bot' }], crashes: 0,
      distance: won ? (g ? g.roadD : 0) : this.raceDistance, speed: g ? g.speed : 0 };
    // a loss: the ghost team won (versusResult's win = a team with a human won, so nothing past Rivals counts)
    const res = won
      ? versusResult({ winner: you, loser: ghost, raceDistance: this.raceDistance, halfLeader: this.halfLeader })
      : versusResult({ winner: ghost, loser: you, raceDistance: this.raceDistance, halfLeader: this.halfLeader });
    return { ...res, won, marginMs: Math.round(Math.abs(this.targetMs - timeMs)), counts: this.counts, tier: this.tier };
  }
}
