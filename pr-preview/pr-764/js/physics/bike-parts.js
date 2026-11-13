// ============================================================
// BIKE PARTS — which piece of the goose tandem flies off in a crash (#484 step 3)
// ============================================================
//
// The goose tandem (tandem-3d/goose/goose_tandem.glb) is 69 small meshes hung
// off a rig: Wheel_F under Steer, Wheel_R and the cranks under Bike_root, the
// saddles and the stoker's bars straight on Bike_root. In a crash the wheels,
// the front bars (with the fork), both saddles and the stoker's bars come off
// as their own bodies; everything else (frame, cranks, chain) stays on the
// frame, which keeps tumbling as the bike's own body.
//
// The classifier is by NAME (nodes the rig and the GLB give us), so it is
// pure and testable. Models without the rig (the plain bike, the fused riders
// model) have no detachable parts and keep the one-piece tumble.

import * as THREE from 'three';

/** Parts that leave the frame, with the mass each counts as (kg: the versus wobble). */
export const PARTS = Object.freeze({
  wheelF: { kind: 'wheel', mass: 2.5 },
  wheelR: { kind: 'wheel', mass: 2.5 },
  bars: { kind: 'box', mass: 1.6 },
  stokerBars: { kind: 'box', mass: 1.0 },
  saddleC: { kind: 'box', mass: 0.8 },
  saddleS: { kind: 'box', mass: 0.8 },
});

/** three.js drops the dots from GLB node names ("seat.001" -> "seat001"); compare without them. */
const norm = (n) => String(n || '').toLowerCase().replace(/\./g, '');

const BY_NAME = {
  seat_cycle_0: 'saddleC',
  seat001_cycle_0: 'saddleS',
  cylinder019_cycle_0: 'stokerBars',
  nurbspath009_cycle_0: 'stokerBars',
  goosefit_stoker_stem_cycle_0: 'stokerBars',
};
const BY_BONE = { wheel_f: 'wheelF', wheel_r: 'wheelR', steer: 'bars' };

/**
 * The part a mesh belongs to: its own name first (the parts on Bike_root), then the nearest rig bone
 * above it (Wheel_F before Steer: the front wheel hangs under the steering). 'frame' = stays on.
 * @param {{name?: string, parent?: object, userData?: object}} o
 */
export function partOf(o) {
  if (o && o.userData && o.userData.bikePart) return o.userData.bikePart;   // a merged mesh (bike-batch split)
  const own = BY_NAME[norm(o && o.name)];
  if (own) return own;
  for (let p = o; p; p = p.parent) {
    const b = BY_BONE[norm(p.name)];
    if (b) return b;
    if (norm(p.name) === 'bike_root') break;
  }
  return 'frame';
}

/** rebatch's split: the Bike_root parts each merge on their own (the wheels and bars have their own bones). */
export function batchSplit(o) {
  const p = BY_NAME[norm(o && o.name)];
  return p || '';
}

/** Does this bike model have the rig the parts come off? */
export function hasParts(model) {
  let f = false, r = false;
  model.traverse((o) => { const n = norm(o.name); if (n === 'wheel_f') f = true; if (n === 'wheel_r') r = true; });
  return f && r;
}

/**
 * The bike's drawn meshes by part, for the crash: { part: Mesh[] } of VISIBLE meshes only (merged meshes
 * and the unmerged ones), never the geese.
 */
export function visibleMeshesByPart(model) {
  const out = { frame: [] };
  for (const k of Object.keys(PARTS)) out[k] = [];
  const walk = (o) => {
    if (o.userData && o.userData.gooseSeat) return;
    if (!o.visible) return;
    if (o.isMesh && !o.isSkinnedMesh) out[partOf(o)].push(o);
    for (const c of o.children) walk(c);
  };
  walk(model);
  return out;
}

const _box = new THREE.Box3(), _v = new THREE.Vector3(), _inv = new THREE.Matrix4(), _m = new THREE.Matrix4();

/**
 * Bounds of `meshes` in the frame `frameWorld` (a Matrix4: the bike group's world matrix), by their vertices.
 * @returns {THREE.Box3|null}
 */
export function boundsIn(meshes, frameWorld) {
  if (!meshes.length) return null;
  _inv.copy(frameWorld).invert();
  const box = new THREE.Box3();
  for (const m of meshes) {
    const pos = m.geometry && m.geometry.attributes.position;
    if (!pos) continue;
    m.updateWorldMatrix(true, false);
    _m.multiplyMatrices(_inv, m.matrixWorld);
    const step = Math.max(1, Math.floor(pos.count / 400));   // a few hundred points is plenty for a box
    for (let i = 0; i < pos.count; i += step) box.expandByPoint(_v.fromBufferAttribute(pos, i).applyMatrix4(_m));
  }
  return box.isEmpty() ? null : box;
}

/**
 * The launch for a part leaving the bike: the frame's velocity at that point plus a pop.
 * Pure numbers (no Rapier): {x,y,z} vectors in world space.
 * @param {object} o
 * @param {string} o.part
 * @param {'head-on'|'lean'} o.how
 * @param {number} o.speed  bike speed at impact (m/s)
 * @param {{x:number,z:number}} o.fwd  unit forward
 * @param {number} o.side  +1 / -1: the side the bike falls to (bike-local +x is `right`)
 * @param {{x:number,z:number}} o.right  unit right
 * @param {number} [o.radius]  wheel radius (m): its roll spin
 * @param {() => number} [o.rand]
 */
export function partLaunch({ part, how, speed, fwd, side, right, radius = 0.6, rand = Math.random }) {
  const r = () => rand() - 0.5;
  const v = { x: 0, y: 0, z: 0 }, w = { x: 0, y: 0, z: 0 };
  const add = (k, s) => { v.x += fwd.x * k + right.x * s; v.z += fwd.z * k + right.z * s; };
  if (PARTS[part] && PARTS[part].kind === 'wheel') {
    // The wheels ROLL away: forward along the road with a spin to match, a hop, a little lean off to a side.
    // Head-on, the front wheel takes the hit and carries on alone (the signature shot); the rear one follows.
    const fwdK = how === 'head-on' ? (part === 'wheelF' ? 0.62 : 0.42) : (part === 'wheelF' ? 0.5 : 0.38);
    const k = speed * fwdK;
    add(k, side * (0.6 + rand() * 0.9) + (part === 'wheelR' ? -side * 0.8 : 0));
    v.y = 1.0 + rand() * 1.2;
    const spin = k / Math.max(0.2, radius);   // rolling: about the axle (bike right), top forward
    w.x = right.x * spin; w.z = right.z * spin;
    w.y = r() * 1.2;
  } else {
    // bars and saddles: up and forward, tumbling
    const k = speed * (how === 'head-on' ? 0.55 : 0.35);
    add(k * (0.7 + rand() * 0.5), side * (0.4 + rand() * 1.2) + r() * 1.5);
    v.y = 2.4 + rand() * 1.8;
    w.x = r() * 14; w.y = r() * 10; w.z = r() * 14;
  }
  return { linvel: v, angvel: w };
}
