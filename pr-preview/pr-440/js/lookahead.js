// ============================================================
// LOOK-AHEAD (pure) — what the stoker can see and the captain cannot
// ============================================================
//
// E-1. Every co-op game worth copying runs on asymmetric information: one
// player knows something the other needs. Keep Talking and Nobody Explodes is
// nothing but that. Tandemonium had none of it — both riders looked at the
// same screen and pressed the same rhythm, so after the first minute there was
// nothing to say to each other beyond "faster".
//
// So: the stoker's HUD shows the road further ahead than the captain can see.
// The back seat's job stops being "pedal in time" and becomes CALLING THE ROAD.
// "Pothole left" is a sentence a stoker can only say if they know first.
//
// This module turns a list of world items into a small lane map. No DOM, no
// three, no manager objects — just the projection, so it can be tested.

/** How far past the captain's view the stoker can see, in metres. */
export const LOOKAHEAD_M = 40;

/** Lanes across the road: left, centre, right. */
export const LANES = 3;

/** Lateral offset (metres) at which an item stops counting as centre. */
export const LANE_EDGE = 0.9;

/**
 * Which lane an item sits in. The road is about 5 m wide, and the centre strip
 * (the fast line, B-4) is the middle fifth of it, so the lane boundaries are
 * deliberately narrow: "centre" means "on the line you want to be on".
 * @returns {0|1|2} 0 = left, 1 = centre, 2 = right
 */
export function laneOf(lateralOffset) {
  if (lateralOffset < -LANE_EDGE) return 0;
  if (lateralOffset > LANE_EDGE) return 2;
  return 1;
}

/**
 * Build the strip the stoker reads.
 *
 * @param {object} sources  { obstacles: [], collectibles: [], geese: [] } —
 *        each an array of `{ absoluteD, lateralOffset, collected? }`, exactly
 *        as the managers already hold them.
 * @param {number} fromD    where the captain's view ends (bike distance + camera range)
 * @param {number} spanM    how far beyond that the stoker sees
 * @returns {Array<{kind, lane, distance, urgency}>} sorted nearest first.
 *          `distance` is metres from `fromD`; `urgency` is 1 at the near edge
 *          of the window falling to 0 at the far edge, so the HUD can fade
 *          things in rather than pop them.
 */
export function buildLookahead(sources, fromD, spanM = LOOKAHEAD_M) {
  const out = [];
  const toD = fromD + spanM;

  const push = (kind, list) => {
    for (const item of list || []) {
      if (item.collected || item.disrupted) continue;
      const d = item.absoluteD;
      if (typeof d !== 'number' || d < fromD || d > toD) continue;
      const distance = d - fromD;
      out.push({
        kind,
        lane: laneOf(item.lateralOffset || 0),
        distance: Math.round(distance * 10) / 10,
        urgency: Math.max(0, Math.min(1, 1 - distance / spanM))
      });
    }
  };

  push('obstacle', sources.obstacles);
  push('present', sources.collectibles);
  push('goose', sources.geese);

  out.sort((a, b) => a.distance - b.distance);
  return out;
}

/**
 * How much warning the stoker's call actually buys, in seconds, at a given
 * speed. Used by the acceptance test: the panel is worthless if a hazard
 * appears in it half a second before it hits.
 */
export function warningSeconds(spanM, speed) {
  if (!(speed > 0)) return Infinity;
  return spanM / speed;
}

/**
 * The captain's visible range, from the chase camera's look-ahead. Kept here
 * so the one number that defines the asymmetry lives with the code that uses
 * it rather than being guessed at two places.
 */
export const CAPTAIN_VIEW_M = 45;

/** Whether this seat is the one that gets the panel. */
export function seatSeesLookahead(mode) {
  // Online co-op only. Local co-op shares one screen and one camera, so there
  // is no asymmetry to be had: showing the panel there would just be showing
  // the captain the answer too.
  return mode === 'stoker';
}
