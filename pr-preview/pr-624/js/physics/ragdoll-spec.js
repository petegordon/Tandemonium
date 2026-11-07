// ============================================================
// RAGDOLL SPEC (pure) — the goose rag doll's bodies, joints and the crash throw (#484, #507)
// ============================================================
//
// Each segment is one Rapier capsule that drives ONE bone (its first): the
// bones between two driven bones (Spine1/Spine2, Neck1, Neck3, hands, feet)
// keep their seated local pose and ride along. A segment runs from its bone's
// head to the `end` bone's head; `parent` is the segment its joint hangs off.
// Radii are fractions of the goose's own hip-to-head length, so the rag doll
// fits any outfit or body shape.
//
// #507 (Pete: "more weight and less rubbery"):
//   mass   each segment's share of GOOSE_MASS, a goose in a tweed coat: the body
//          carries most of it, so the body leads the fall and the limbs trail;
//   damp   angular damping: high on the limbs so they settle instead of wobbling;
//   tone   muscle tone on the joint to its parent (crash-scene applies it every
//          substep): joint FRICTION first, the relative spin between the two
//          bodies relaxing with time constant `fr` (s), which is what stops the
//          limbs flailing like rubber; then a pull back toward the seated angle
//          that closes the gap with time constant `tc` (s), tightening to
//          LIMIT_TC past `limit` (rad) so nothing folds the wrong way. Both are
//          velocity-level (the relative spin is SET, not pushed), so they are
//          stable at any stiffness. The neck stays the loosest: the long neck is the joke.
// Rapier's spherical joint has no limits or motors in the build we ship, so the
// tone does both jobs; it works on any joint kind.

export const GOOSE_MASS = 7;        // kg-ish, the versus wobble's scale (a wheel is 2.5)
export const LIMIT_TC = 0.015;      // past a joint's limit: the overshoot closes this fast (s)
export const MAX_RATE = 6;          // rad/s: a joint returns to its seated angle no faster than this (a muscle, not a snap)
export const LIMIT_RATE = 8;        // rad/s: but past its limit it comes back at most this fast
export const LINEAR_DAMPING = 0.04; // air only: a goose falls like a sack, not through water
export const RESTITUTION = 0.0;     // a goose does not bounce
export const FRICTION = 1.0;        // and slides to a stop quickly

export const SEGMENTS = Object.freeze([
  { id: 'pelvis', bone: 'Hips',         end: 'Spine',        parent: null,     r: 0.20,  mass: 0.30, damp: 2.0,  tone: null },
  { id: 'chest',  bone: 'Spine',        end: 'Neck',         parent: 'pelvis', r: 0.19,  mass: 0.28, damp: 2.0,  tone: { fr: 0.02, tc: 0.03, limit: 0.5 } },
  { id: 'neckLo', bone: 'Neck',         end: 'Neck2',        parent: 'chest',  r: 0.045, mass: 0.03, damp: 0.8,  tone: { fr: 0.15, tc: 0.25, limit: 1.2 } },
  { id: 'neckHi', bone: 'Neck2',        end: 'Head',         parent: 'neckLo', r: 0.04,  mass: 0.03, damp: 0.8,  tone: { fr: 0.15, tc: 0.25, limit: 1.2 } },
  { id: 'head',   bone: 'Head',         end: 'HatSocket',    parent: 'neckHi', r: 0.07,  mass: 0.07, damp: 1.2,  tone: { fr: 0.1, tc: 0.15, limit: 1.0 } },
  { id: 'armL',   bone: 'LeftArm',      end: 'LeftForeArm',  parent: 'chest',  r: 0.05,  mass: 0.04, damp: 2.5,  tone: { fr: 0.03, tc: 0.06, limit: 1.4 } },
  { id: 'foreL',  bone: 'LeftForeArm',  end: 'LeftHand',     parent: 'armL',   r: 0.04,  mass: 0.025, damp: 2.5, tone: { fr: 0.03, tc: 0.05, limit: 0.9 } },
  { id: 'armR',   bone: 'RightArm',     end: 'RightForeArm', parent: 'chest',  r: 0.05,  mass: 0.04, damp: 2.5,  tone: { fr: 0.03, tc: 0.06, limit: 1.4 } },
  { id: 'foreR',  bone: 'RightForeArm', end: 'RightHand',    parent: 'armR',   r: 0.04,  mass: 0.025, damp: 2.5, tone: { fr: 0.03, tc: 0.05, limit: 0.9 } },
  { id: 'thighL', bone: 'LeftUpLeg',    end: 'LeftLeg',      parent: 'pelvis', r: 0.07,  mass: 0.06, damp: 2.5,  tone: { fr: 0.03, tc: 0.06, limit: 1.2 } },
  { id: 'shinL',  bone: 'LeftLeg',      end: 'LeftFoot',     parent: 'thighL', r: 0.045, mass: 0.03, damp: 2.5,  tone: { fr: 0.03, tc: 0.05, limit: 0.9 } },
  { id: 'thighR', bone: 'RightUpLeg',   end: 'RightLeg',     parent: 'pelvis', r: 0.07,  mass: 0.06, damp: 2.5,  tone: { fr: 0.03, tc: 0.06, limit: 1.2 } },
  { id: 'shinR',  bone: 'RightLeg',     end: 'RightFoot',    parent: 'thighR', r: 0.045, mass: 0.03, damp: 2.5,  tone: { fr: 0.03, tc: 0.05, limit: 0.9 } },
]);

/** Low budget: the body and the neck only (the limbs keep their seated pose). */
export const LITE = Object.freeze(['pelvis', 'chest', 'neckLo', 'neckHi', 'head']);

/** The segments for a budget: 'full' (13 per goose) or 'lite' (5). */
export function segmentsFor(budget = 'full') {
  return budget === 'lite' ? SEGMENTS.filter(s => LITE.includes(s.id)) : SEGMENTS.slice();
}

/** A segment's mass (kg-ish): its share of the goose, so a lite doll's body weighs the same as a full one's. */
export function segmentMass(seg, goose = GOOSE_MASS) {
  return Math.max(0.01, (seg.mass || 0) * goose);
}

/** Moment of inertia of a capsule-ish rod about its joint end (kg m²): mass, length, radius. */
export function rodInertia(mass, len, rad) {
  return Math.max(1e-6, mass * (len * len / 3 + rad * rad / 2));
}

/**
 * Joint friction: the fraction of the relative spin between two bodies that one substep of `h` seconds
 * takes out, for a relaxation time `fr` (0 = none).
 */
export function frictionFraction(h, fr) {
  return fr > 0 && h > 0 ? 1 - Math.exp(-h / fr) : 0;
}

/**
 * The relative spin (rad/s, along the error axis) the tone sets for a joint turned `angle` rad from its
 * seated pose, so that the error closes geometrically: a fraction (1 − e^(−h/tc)) of it per substep of `h`
 * seconds, and (1 − e^(−h/LIMIT_TC)) of the part beyond `limit`; capped at MAX_RATE (LIMIT_RATE past the
 * limit) so a joint thrown far from its pose comes back like a muscle, not a snap. 0 when the joint has no tone.
 */
export function toneRate(angle, h, tone) {
  if (!tone || !(h > 0) || !(angle > 0)) return 0;
  const tc = Math.max(1e-4, tone.tc || 0), limit = Math.max(0, tone.limit || 0);
  let r = Math.max(-MAX_RATE, -(1 - Math.exp(-h / tc)) * angle / h);
  if (angle > limit) r = Math.max(-LIMIT_RATE, r - (1 - Math.exp(-h / LIMIT_TC)) * (angle - limit) / h);
  return r;
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/**
 * World-space launch for one rider: a linear velocity and a spin, given to every body of its rag doll
 * (plus the spin's w x r, so it leaves as one piece).
 *
 * Head-on (a pylon or a tree): the captain goes OVER THE BARS (forward, up, pitching forward); the stoker
 * is thrown off the back to one side. A lean-out (balance): both go to the side the bike fell, rolling.
 * Faster crashes throw further.
 *
 * Axes (three.js, Y up): forward f = (sin h, 0, cos h); the rider's right r = (-cos h, 0, sin h), the side
 * a positive lean falls to.
 *
 * @param {{seat:string, cause?:string, speed:number, heading:number, lean:number, rand?:()=>number}} o
 * @returns {{linvel:{x:number,y:number,z:number}, angvel:{x:number,y:number,z:number}}}
 */
export function throwFor(o) {
  const rand = o.rand || Math.random;
  const v = clamp(Number(o.speed) || 0, 2.5, 14);
  const fx = Math.sin(o.heading || 0), fz = Math.cos(o.heading || 0);
  const rx = -fz, rz = fx;                         // the rider's right
  const side = (o.lean || 0) >= 0 ? 1 : -1;        // the side it fell to
  const headOn = o.cause === 'obstacle' || o.cause === 'tree';
  const cap = o.seat === 'Captain';
  const jit = (a) => (rand() - 0.5) * 2 * a;
  let fwd, lat, up, pitch, roll;
  if (headOn && cap) {
    fwd = v * 0.9; lat = jit(0.8); up = 2.3 + v * 0.17; pitch = 5 + v * 0.35; roll = jit(2);
  } else if (headOn) {
    const s = rand() < 0.5 ? -1 : 1;               // off either side of the back
    fwd = v * 0.7; lat = s * (2.2 + v * 0.12); up = 2.2 + v * 0.12; pitch = 2.5; roll = s * (3 + v * 0.2);
  } else {
    // a lean-out: to the side it fell, the captain a little further
    const k = cap ? 1.15 : 0.9;
    // The bike is already nearly flat when the balance gives out, so they need a real fling to get airborne,
    // and they CARTWHEEL toward that side (spin -side about f: head up and over, feet land further out).
    // Rolling the same way the bike fell would drive their heads into the road.
    fwd = v * 0.75; lat = side * (2.6 + v * 0.25) * k; up = 3.0 + v * 0.15; pitch = 1.5 + jit(1); roll = -side * (4 + v * 0.25) * k;
  }
  return {
    linvel: { x: fx * fwd + rx * lat, y: up, z: fz * fwd + rz * lat },
    // pitching forward is a spin about -r; rolling to the right is a spin about +f
    angvel: { x: -rx * pitch + fx * roll, y: jit(1.5), z: -rz * pitch + fz * roll },
  };
}

/** A hat leaves the head: most of the head's velocity, a hop and a hard spin. */
export function hatThrow(headVel, rand = Math.random) {
  const j = (a) => (rand() - 0.5) * 2 * a;
  return {
    linvel: { x: headVel.x * 0.8 + j(1.5), y: Math.max(headVel.y, 0) + 3.2 + rand() * 1.2, z: headVel.z * 0.8 + j(1.5) },
    angvel: { x: j(14), y: j(10), z: j(14) },
  };
}
