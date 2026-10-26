// ============================================================
// CRASH WOBBLE (pure) — a flying bike part hits the other team (#484 step 4)
// ============================================================
//
// Local split-screen versus only. When one team crashes its tandem comes
// apart, and a part that hits the OTHER team's tandem sends it into a wobble:
// a sideways shove (a kick to its lean velocity) and a short shake that dies
// away. It is a disturbance, not a crash: an upright bike rides it out, but a
// team that is already leaning hard, or over-corrects, can still go down.
// Heavier and faster parts hit harder (a wheel more than a saddle), and each
// team takes at most one wobble per opposing crash.
//
// Everything else a crash does is visual (js/physics); this is the one piece of
// gameplay, and it never runs in online modes.

export const WOBBLE = Object.freeze({
  perKgMs: 0.03,     // lean-velocity kick (rad/s) per kg·m/s of the part's momentum relative to the bike
  maxKick: 0.85,     // rad/s: a wheel at full tilt (an upright bike rides it out; one near the edge doesn't)
  minKick: 0.12,     // below this it isn't felt: no wobble (a saddle tumbling past at walking pace)
  shakePerKick: 5,   // the shake's amplitude (rad/s², a lean force like the danger wobble) per rad/s of kick
  shakeTau: 0.5,     // s: the shake dies away
  shakeHz: 3.2,
  shakeFor: 1.6,     // s: then it's gone
});

/**
 * How hard a part hits: the kick and the shake. 0 = not felt.
 * @param {number} mass kg
 * @param {number} relSpeed m/s, the part's speed relative to the bike it hits
 */
export function hitWobble(mass, relSpeed, w = WOBBLE) {
  const m = Math.max(0, mass || 0), s = Math.max(0, relSpeed || 0);
  const kick = Math.min(w.maxKick, m * s * w.perKgMs);
  if (!(kick >= w.minKick)) return { kick: 0, shake: 0 };
  return { kick, shake: kick * w.shakePerKick };
}

/** The shake's lean force `t` seconds after the hit (rad/s²). */
export function shakeAt(amp, t, w = WOBBLE) {
  if (!(amp > 0) || !(t >= 0) || t > w.shakeFor) return 0;
  return amp * Math.exp(-t / w.shakeTau) * Math.sin(t * w.shakeHz * 2 * Math.PI);
}

/**
 * Is a point (in the other bike's own frame: +z forward, +y up, origin on the road under its middle) on the
 * tandem or its riders? `pad` = the part's own size.
 */
export function onBike(local, pad = 0.3) {
  return Math.abs(local.x) < 0.45 + pad && local.y > -pad && local.y < 1.9 + pad && Math.abs(local.z) < 1.6 + pad;
}

/**
 * Which way the hit shoves the bike's lean: a part arriving from the bike's +x side pushes its top toward -x.
 * (Lean > 0 tips the bike toward -x: physics-fx rolls it about +forward with the lean's sign.)
 */
export function kickSign(localX) {
  return localX >= 0 ? 1 : -1;
}

/**
 * A launch that lands on a moving target after `T` simulated seconds: the target is where the other bike
 * will be (its velocity × the REAL seconds that pass meanwhile: the crashing view runs slow, the other team
 * doesn't). Returns {x,y,z} or null when the throw would be implausibly hard.
 * @param {{x,y,z}} from  @param {{x,y,z}} target  @param {{x,z}} targetVel m/s
 * @param {number} T sim seconds of flight  @param {number} realT real seconds over that flight
 */
export function aimAt(from, target, targetVel, T, realT, { g = 9.81, maxSpeed = 22 } = {}) {
  if (!(T > 0)) return null;
  const tx = target.x + targetVel.x * realT, tz = target.z + targetVel.z * realT;
  const vx = (tx - from.x) / T, vz = (tz - from.z) / T;
  const vy = (target.y - from.y) / T + 0.5 * g * T;
  if (Math.hypot(vx, vz) > maxSpeed) return null;
  return { x: vx, y: vy, z: vz };
}
