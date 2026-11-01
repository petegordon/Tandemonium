// ============================================================
// CRASH SLOW-MO (pure) — the time scale of a crashing view (#484)
// ============================================================
//
// The crash beat: impact, then a short slow-motion moment while the geese,
// hats and bike are in the air, then real time while they skid and flop, then
// the cut to the checkpoint. Only the crashing view slows (in split-screen
// versus the other team races on in real time), and the race clock is held
// while it does, so the slow-mo never costs the player time.
//
//   real s   0 ......... HOLD ..... HOLD+RAMP ............ DOWN_REAL
//   scale    SCALE ...... SCALE ->1  1 ........................ (cut)
//
// The bike's fallTimer counts SIMULATED seconds (it is stepped with the scaled
// dt), so a crash that should last DOWN_REAL real seconds sets it to
// simSecondsFor(DOWN_REAL).

export const SLOWMO = Object.freeze({
  hold: 0.8,        // real seconds at the slow scale, from impact
  scale: 0.25,      // the slow scale
  ramp: 0.15,       // real seconds easing back to 1
  downReal: 2.0,    // real seconds from impact to the cut to the checkpoint
});

/** Time scale `realElapsed` seconds after impact. */
export function crashTimeScale(realElapsed, s = SLOWMO) {
  const t = Number.isFinite(realElapsed) ? realElapsed : Infinity;
  if (t < 0) return 1;
  if (t < s.hold) return s.scale;
  if (t < s.hold + s.ramp) return s.scale + (1 - s.scale) * ((t - s.hold) / s.ramp);
  return 1;
}

/** Simulated seconds that pass in the first `realSeconds` after impact. */
export function simSecondsFor(realSeconds, s = SLOWMO) {
  const r = Math.max(0, realSeconds);
  let sim = Math.min(r, s.hold) * s.scale;
  if (r > s.hold) {
    const b = Math.min(r - s.hold, s.ramp);
    // the linear ramp from scale to 1: the area under it so far
    sim += b * s.scale + (1 - s.scale) * (b * b) / (2 * s.ramp);
  }
  if (r > s.hold + s.ramp) sim += r - s.hold - s.ramp;
  return sim;
}

/** The race clock is held while the view is slowed. */
export function clockHeld(realElapsed, s = SLOWMO) {
  return Number.isFinite(realElapsed) && realElapsed >= 0 && realElapsed < s.hold + s.ramp;
}

/** The inverse of simSecondsFor: real seconds until `simSeconds` have been simulated (bisection; monotone). */
export function realSecondsFor(simSeconds, s = SLOWMO) {
  const target = Math.max(0, simSeconds);
  let lo = 0, hi = target / s.scale + s.hold + s.ramp + 1;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (simSecondsFor(mid, s) < target) lo = mid; else hi = mid;
  }
  return hi;
}
