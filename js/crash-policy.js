// ============================================================
// CRASH POLICY (pure) — when does a crash stop the ride?
// ============================================================
//
// B-2. A crash used to cost 6-9 seconds: two on the ground, a modal to read
// and dismiss, then a full three-count. For a game whose comedy is the falling
// over, that is a penalty screen attached to the best moment in the ride.
//
// The rule now: get back on. The modal is reserved for the cases where the
// player genuinely needs a decision, not a restart.
//
// Pure so the policy can be tested without a bike, a HUD or a browser.

/** Crashes in the same segment before the game stops and offers help. */
export const STUCK_AFTER_CRASHES = 3;

/**
 * @param {object} ctx
 * @param {number} ctx.crashesThisSegment  including the one that just happened
 * @param {boolean} [ctx.rankedRun]        a Phase D ranked attempt
 * @param {boolean} [ctx.rideOver]         time-up, or the player pressed END RIDE
 * @returns {{ action: 'resume'|'modal', reason: string }}
 */
export function decideAfterCrash(ctx) {
  const crashes = ctx.crashesThisSegment || 0;
  if (ctx.rideOver) return { action: 'modal', reason: 'ride-over' };
  if (ctx.rankedRun) return { action: 'modal', reason: 'ranked' };
  if (crashes >= STUCK_AFTER_CRASHES) return { action: 'modal', reason: 'stuck' };
  return { action: 'resume', reason: 'beat' };
}

/**
 * Count crashes per segment. `segmentKey` is the number of checkpoints passed,
 * so crossing a checkpoint starts the count again — being stuck is about the
 * stretch of road in front of you, not the whole ride.
 */
export function countCrash(state, segmentKey) {
  if (state.segmentKey !== segmentKey) return { segmentKey, crashes: 1 };
  return { segmentKey, crashes: (state.crashes || 0) + 1 };
}
