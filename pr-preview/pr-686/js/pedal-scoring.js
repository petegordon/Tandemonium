// ============================================================
// PEDAL SCORING (pure) — the beat-window co-op rule
// ============================================================
//
// The old rule scored a tap "perfect" when its foot differed from the
// PARTNER'S LAST FOOT. Two people genuinely alternating (C:L, S:R, C:R, S:L…)
// therefore scored every second tap as "in phase" (a penalty), so a real pair
// capped at ~50% perfect while one person pedalling alone scored 100%. The
// achievement `perfect_sync` was only reachable by a carry.
//
// The rule now is the one the HUD can actually say out loud:
//
//   "Match your partner's beat with the opposite foot."
//
// A tap is PERFECT when the partner tapped the OPPOSITE foot within the beat
// window (default 250 ms). Both taps of that pair are perfect — the earlier one
// is credited retroactively, which is what makes a steady interleaved pair score
// 100% instead of 50%. Same foot inside the window is a CRANK FIGHT. No partner
// tap in the window is a SOLO stroke: it still drives the bike, it just earns no
// offset bonus.
//
// This module imports nothing (no three, no DOM) so it can be unit tested:
//   node --test "test/unit/pedal-scoring.test.mjs"
// ============================================================

/** Default beat window, seconds. Plan §3 decision 2. */
export const BEAT_WINDOW_S = 0.25;

/**
 * Fresh scoring state. `openBeat` is the most recent tap that has not yet been
 * paired; it is cleared when a pair forms or a fight is called so a third tap
 * inside the window cannot double-pair.
 */
export function createScoringState() {
  return {
    captainLastFoot: null,
    captainLastTime: 0,
    stokerLastFoot: null,
    stokerLastTime: 0,
    openBeat: null
  };
}

function lastFootOf(state, source) {
  return source === 'captain' ? state.captainLastFoot : state.stokerLastFoot;
}

/**
 * Classify one tap. Pure: does not mutate `state`.
 *
 * @param {object} state  see createScoringState()
 * @param {{source:'captain'|'stoker', foot:string, time:number}} tap
 * @param {number} windowS beat window in seconds
 * @returns {{kind:'wrong'|'perfect'|'solo'|'fight', pair?:object}}
 *          `pair` is the partner tap this one paired with (perfect / fight).
 */
export function classifyTap(state, tap, windowS = BEAT_WINDOW_S) {
  // 1. Same foot as my own last foot — you have to alternate your own feet.
  if (lastFootOf(state, tap.source) === tap.foot) {
    return { kind: 'wrong' };
  }

  const open = state.openBeat;
  const partnerBeatIsOpen =
    open &&
    open.source !== tap.source &&
    tap.time - open.time <= windowS &&
    tap.time - open.time >= 0;

  if (partnerBeatIsOpen) {
    // 2. Opposite foot inside the window — the pair is on the beat.
    if (open.foot !== tap.foot) return { kind: 'perfect', pair: open };
    // 3. Same foot inside the window — both riders shoving the same crank arm.
    return { kind: 'fight', pair: open };
  }

  // 4. Nobody to match: a solo stroke. Still moves the bike.
  return { kind: 'solo' };
}

/**
 * Advance the state after a tap has been classified. Pure: returns a new state.
 */
export function applyTap(state, tap, kind) {
  const next = { ...state };
  if (tap.source === 'captain') {
    next.captainLastFoot = tap.foot;
    next.captainLastTime = tap.time;
  } else {
    next.stokerLastFoot = tap.foot;
    next.stokerLastTime = tap.time;
  }
  // A pair (or a fight) consumes the open beat; anything else becomes the beat
  // the partner can answer. A `wrong` tap does not open a beat — you cannot
  // pair with a mistake.
  if (kind === 'perfect' || kind === 'fight') next.openBeat = null;
  else if (kind === 'wrong') next.openBeat = state.openBeat;
  else next.openBeat = { source: tap.source, foot: tap.foot, time: tap.time };
  return next;
}

/**
 * Score a whole sequence of taps, applying the retroactive upgrade: when a pair
 * forms, the earlier tap of the pair is perfect too. Used by the tests and by
 * analysis tooling; the live controller does the same thing incrementally.
 *
 * @returns {Array<'wrong'|'perfect'|'solo'|'fight'>} one kind per input tap
 */
export function scoreSequence(taps, windowS = BEAT_WINDOW_S) {
  let state = createScoringState();
  const kinds = [];
  const indexOfTap = new Map();

  taps.forEach((tap, i) => {
    const { kind, pair } = classifyTap(state, tap, windowS);
    kinds.push(kind);
    if (kind === 'perfect' && pair && indexOfTap.has(pair)) {
      kinds[indexOfTap.get(pair)] = 'perfect';   // retroactive credit
    }
    const prevOpen = state.openBeat;
    state = applyTap(state, tap, kind);
    if (state.openBeat && state.openBeat !== prevOpen) indexOfTap.set(state.openBeat, i);
  });

  return kinds;
}

/**
 * Share of taps that ended up on the beat. Handy for tests and for the
 * post-ride contribution numbers.
 */
export function perfectShare(kinds) {
  if (!kinds.length) return 0;
  return kinds.filter(k => k === 'perfect').length / kinds.length;
}
