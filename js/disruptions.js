// ============================================================
// DISRUPTIONS (pure) — the road does something to the pair
// ============================================================
//
// E-2. Overcooked's kitchens split in half mid-service, and that is when the
// players start shouting. A co-op ride with a steady rhythm and nothing to
// interrupt it gives two people nothing to coordinate about after the first
// minute: they find the beat, and then they hold it in silence.
//
// So the road throws two or three things at them per ride:
//
//   GUST     a crosswind shoves the lean for two seconds. Both riders have to
//            correct, and their corrections average, so they have to agree.
//   GOOSE    one crosses the road: no pedalling for 1.5 s or you clip it. A
//            coast is the hardest thing to do together, because doing nothing
//            in time is still doing something in time.
//   COBBLES  the beat window tightens from 250 ms to 150 ms for four seconds.
//            The rhythm they have is suddenly not good enough.
//
// Everything is SEEDED from the road, so both clients schedule the identical
// events with no network traffic at all, and every event is telegraphed three
// seconds ahead — a disruption you could not see coming is not a challenge,
// it is noise.

import { deriveSeed, SALT } from './daily-seed.js';

export const KIND = { GUST: 'gust', GOOSE: 'goose', COBBLES: 'cobbles' };

/** How long each kind lasts once it starts, in seconds. */
export const DURATION = { gust: 2.0, goose: 1.5, cobbles: 4.0 };

/** How much warning the rider gets. */
export const TELEGRAPH_S = 3.0;

/** The tightened beat window during cobbles. */
export const COBBLES_WINDOW_S = 0.15;

/**
 * Sideways push during a gust, in lean units per second.
 *
 * This was 0.55, which simulated out to a peak lean of about 6 degrees — under
 * 8% of the crash threshold, and roughly the size of the tilt deadzone on a
 * phone. The banner said HOLD IT and there was nothing to hold. At 3.5 the same
 * two seconds reach about 26 degrees on adventurous: you have to correct, and
 * you have time to.
 */
export const GUST_FORCE = 3.5;

/**
 * The gust's shape over its own duration, as fractions of it.
 *
 * A step function reads as the bike being teleported sideways. Ramping in over
 * the first fifth and out over the last third makes it a shove that arrives and
 * passes, which is both fairer to correct against and what wind does.
 */
export const GUST_ATTACK = 0.18;
export const GUST_RELEASE = 0.30;

/** Gust strength at `progress` (0..1) through the event. Pure — tested. */
export function gustEnvelope(progress) {
  const p = Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0;
  if (p < GUST_ATTACK) return p / GUST_ATTACK;
  if (p > 1 - GUST_RELEASE) return Math.max(0, (1 - p) / GUST_RELEASE);
  return 1;
}

/** How many events each difficulty gets. Chill gets none: it is the preset
 *  that promises nothing will happen to you. */
export const COUNT_BY_DIFFICULTY = { tutorial: 0, chill: 0, adventurous: 2, daredevil: 3 };

/** No event in the first N metres, or within N metres of a checkpoint. */
export const START_CLEARANCE_M = 60;
export const CHECKPOINT_CLEARANCE_M = 40;

function makeRng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Plan a ride's disruptions.
 *
 * Positions are in metres along the ride, not seconds, so the schedule is the
 * same however fast the pair rides it — a slow pair and a fast pair meet the
 * same gust at the same tree.
 *
 * @param {object} opts
 *   seed         the road seed (B-4)
 *   distance     ride length in metres
 *   difficulty   'chill' | 'adventurous' | …
 *   checkpoints  [m] positions to stay clear of
 * @returns {Array<{kind, atM, telegraphM, duration}>} sorted by position
 */
export function planDisruptions({ seed, distance, difficulty, checkpoints = [] }) {
  const count = COUNT_BY_DIFFICULTY[difficulty] ?? COUNT_BY_DIFFICULTY.adventurous;
  if (!count || !(distance > 0)) return [];

  const rng = makeRng(deriveSeed(seed || 1, SALT.disruptions));
  const kinds = [KIND.GUST, KIND.GOOSE, KIND.COBBLES];

  // Space the events evenly through the ride and jitter within each slot, so
  // they never bunch and never all land in the same place every time.
  const usable = distance - START_CLEARANCE_M;
  if (usable <= 0) return [];
  const slot = usable / count;

  const events = [];
  for (let i = 0; i < count; i++) {
    const kind = kinds[Math.floor(rng() * kinds.length)];
    let atM = START_CLEARANCE_M + slot * i + slot * (0.2 + rng() * 0.6);
    atM = nudgeClearOfCheckpoints(atM, checkpoints, distance);
    if (atM === null) continue;
    events.push({
      kind,
      atM: Math.round(atM * 10) / 10,
      telegraphM: Math.round((atM - TELEGRAPH_S * 8) * 10) / 10,  // ~3 s at 8 m/s
      duration: DURATION[kind]
    });
  }
  return events.sort((a, b) => a.atM - b.atM);
}

/**
 * Push an event away from a checkpoint, or drop it if there is nowhere to go.
 *
 * The clearance adapts to how close together the checkpoints actually are.
 * A flat 40 m is wider than half the gap on a short course — Grandma's Cottage
 * is 250 m with a checkpoint every 62 m — so EVERY position clashed, every
 * event was dropped, and that level silently had no disruptions at all on any
 * seed. Never claim more than a third of the gap.
 */
function clearanceFor(checkpoints) {
  if (checkpoints.length < 2) return CHECKPOINT_CLEARANCE_M;
  let minGap = Infinity;
  for (let i = 1; i < checkpoints.length; i++) {
    minGap = Math.min(minGap, Math.abs(checkpoints[i] - checkpoints[i - 1]));
  }
  if (!Number.isFinite(minGap)) return CHECKPOINT_CLEARANCE_M;
  return Math.min(CHECKPOINT_CLEARANCE_M, minGap / 3);
}

function nudgeClearOfCheckpoints(atM, checkpoints, distance) {
  const clearance = clearanceFor(checkpoints);
  for (let attempt = 0; attempt < 4; attempt++) {
    const clash = checkpoints.find(cp => Math.abs(cp - atM) < clearance);
    if (!clash) return atM;
    atM = clash + clearance + 5;
    if (atM > distance - 20) return null;
  }
  return null;
}

/**
 * Which event, if any, is active or telegraphing at this distance.
 * @returns {{event, phase:'telegraph'|'active', progress:number}|null}
 */
export function disruptionAt(events, distanceM, activeUntilM) {
  for (const e of events) {
    if (distanceM >= e.telegraphM && distanceM < e.atM) {
      return { event: e, phase: 'telegraph', progress: (distanceM - e.telegraphM) / Math.max(1, e.atM - e.telegraphM) };
    }
    const endsAt = activeUntilM ? activeUntilM(e) : e.atM + 10;
    if (distanceM >= e.atM && distanceM < endsAt) {
      return { event: e, phase: 'active', progress: (distanceM - e.atM) / Math.max(1, endsAt - e.atM) };
    }
  }
  return null;
}

/** The banner text for a telegraphed event. */
/** The banner text for a telegraphed event. */
export function telegraphText(kind) {
  return {
    [KIND.GUST]: '💨 GUST AHEAD',
    [KIND.GOOSE]: '🦢 GOOSE CROSSING — COAST!',
    [KIND.COBBLES]: '🪨 COBBLES — TIGHTEN UP'
  }[kind] || '';
}

/** The beat window to use while `active` is running (A-2's window otherwise). */
export function beatWindowFor(active, defaultWindow) {
  if (active && active.phase === 'active' && active.event.kind === KIND.COBBLES) {
    return COBBLES_WINDOW_S;
  }
  return defaultWindow;
}
