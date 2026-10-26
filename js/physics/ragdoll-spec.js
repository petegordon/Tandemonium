// ============================================================
// RAGDOLL SPEC (pure) — the goose rag doll's bodies and the crash throw (#484)
// ============================================================
//
// Each segment is one Rapier capsule that drives ONE bone (its first): the
// bones between two driven bones (Spine1/Spine2, Neck1, Neck3, hands, feet)
// keep their seated local pose and ride along. A segment runs from its bone's
// head to the `end` bone's head; `parent` is the segment its joint hangs off.
// Radii are fractions of the goose's own hip-to-head length, so the rag doll
// fits any outfit or body shape.
//
// The long neck is the joke: two loose segments and a head on free ball
// joints, with little damping.

export const SEGMENTS = Object.freeze([
  { id: 'pelvis', bone: 'Hips',         end: 'Spine',        parent: null,     r: 0.20,  damp: 1.2 },
  { id: 'chest',  bone: 'Spine',        end: 'Neck',         parent: 'pelvis', r: 0.19,  damp: 1.2 },
  { id: 'neckLo', bone: 'Neck',         end: 'Neck2',        parent: 'chest',  r: 0.045, damp: 0.35 },
  { id: 'neckHi', bone: 'Neck2',        end: 'Head',         parent: 'neckLo', r: 0.04,  damp: 0.35 },
  { id: 'head',   bone: 'Head',         end: 'HatSocket',    parent: 'neckHi', r: 0.07,  damp: 0.5 },
  { id: 'armL',   bone: 'LeftArm',      end: 'LeftForeArm',  parent: 'chest',  r: 0.05,  damp: 1.0 },
  { id: 'foreL',  bone: 'LeftForeArm',  end: 'LeftHand',     parent: 'armL',   r: 0.04,  damp: 1.0 },
  { id: 'armR',   bone: 'RightArm',     end: 'RightForeArm', parent: 'chest',  r: 0.05,  damp: 1.0 },
  { id: 'foreR',  bone: 'RightForeArm', end: 'RightHand',    parent: 'armR',   r: 0.04,  damp: 1.0 },
  { id: 'thighL', bone: 'LeftUpLeg',    end: 'LeftLeg',      parent: 'pelvis', r: 0.07,  damp: 1.2 },
  { id: 'shinL',  bone: 'LeftLeg',      end: 'LeftFoot',     parent: 'thighL', r: 0.045, damp: 1.2 },
  { id: 'thighR', bone: 'RightUpLeg',   end: 'RightLeg',     parent: 'pelvis', r: 0.07,  damp: 1.2 },
  { id: 'shinR',  bone: 'RightLeg',     end: 'RightFoot',    parent: 'thighR', r: 0.045, damp: 1.2 },
]);

/** Low budget: the body and the neck only (the limbs keep their seated pose). */
export const LITE = Object.freeze(['pelvis', 'chest', 'neckLo', 'neckHi', 'head']);

/** The segments for a budget: 'full' (13 per goose) or 'lite' (5). */
export function segmentsFor(budget = 'full') {
  return budget === 'lite' ? SEGMENTS.filter(s => LITE.includes(s.id)) : SEGMENTS.slice();
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
