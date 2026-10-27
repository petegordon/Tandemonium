// ============================================================
// FIT MEASURE — contact distances of the goose tandem assembly (three.js)
// ============================================================
//
// #505 · measures a live GooseRiders assembly (the bike GLB with the geese seated on its sockets,
// exactly what BikeModel draws) in BIKE space: the bike model's own local metres, whatever scale
// and tilt the game gives the group. Landmarks are the things ride_fit.py (tandemonium-claude-3d)
// fitted: hip joints HIP_UP above the saddle socket, the ball of each foot on its PedalPin, the hand
// joints a handshake grip from the Grip sockets. Skinned vertices are evaluated through
// SkinnedMesh.getVertexPosition, so the posed clothes count, not the bind pose.
// fit-rules.js (pure) judges the numbers.

import * as THREE from 'three';
import { SEATS } from '../goose-rider-clips.js';

const BIKE_GROUPS = ['Wheel_F', 'Wheel_R', 'Crank_F', 'Crank_R', 'Steer', 'Bike_root'];
const WHEEL_GROUPS = new Set(['Wheel_F', 'Wheel_R']);
const CRANK = { Captain: 'F', Stoker: 'R' };
const GRIP = { Captain: 'C', Stoker: 'S' };
/** Goose meshes that sit on the saddle (clothes hanging beside it, like coat tails, are not the seat). */
const PROBE_MESH = /^(body|breeches|skirt|dress|petticoat|trousers|plus|bloomers|knickers|pants|robe)/i;
const SADDLE_MESH = /^seat/;

const _v = new THREE.Vector3(), _m = new THREE.Matrix4(), _inv = new THREE.Matrix4();

/** The bike's group bone an object belongs to ('Wheel_R', 'Bike_root', …), or null above them. */
export function bikeGroupOf(obj) {
  for (let o = obj; o; o = o.parent) if (BIKE_GROUPS.includes(o.name)) return o.name;
  return null;
}

/** The seat a goose object belongs to, or null for bike parts. */
export function gooseSeatOf(obj) {
  for (let o = obj; o; o = o.parent) if (o.userData && o.userData.gooseSeat) return o.userData.gooseSeat;
  return null;
}

/** Every mesh of the assembly, tagged: {mesh, group, seat}. */
export function listMeshes(model) {
  const out = [];
  model.traverse((o) => { if (o.isMesh) out.push({ mesh: o, group: bikeGroupOf(o), seat: gooseSeatOf(o) }); });
  return out;
}

/** World → bike-space matrix (the bike model's local metres). Call after updateMatrixWorld. */
function bikeInverse(model) {
  return _inv.copy(model.matrixWorld).invert();
}

/** Bike-space position of an object (socket, bone). */
export function bikePos(model, obj, out = new THREE.Vector3()) {
  obj.getWorldPosition(out);
  return out.applyMatrix4(bikeInverse(model));
}

/** Visit every posed vertex of a mesh in bike space: fn(v) with v reused. */
function eachVertex(model, mesh, fn) {
  const pos = mesh.geometry.attributes.position;
  if (!pos) return;
  const toBike = _m.multiplyMatrices(bikeInverse(model), mesh.matrixWorld);
  for (let i = 0; i < pos.count; i++) {
    mesh.getVertexPosition(i, _v);   // skinning applied for SkinnedMesh
    fn(_v.applyMatrix4(toBike), i);
  }
}

/** Rest (bind) position of a goose bone in its rig space, from the skin's bind matrices. */
function restBonePos(root, boneName, out = new THREE.Vector3()) {
  let found = null;
  root.traverse((o) => {
    if (found || !o.isSkinnedMesh) return;
    const i = o.skeleton.bones.findIndex(b => b.name === boneName);
    if (i < 0) return;
    found = _m.copy(o.skeleton.boneInverses[i]).invert().premultiply(o.bindMatrix);
  });
  return found ? out.set(0, 0, 0).applyMatrix4(found) : null;
}

/** The rear tyre as a torus in bike space: {centre, R, rin, half, ring, tube, meshes}. */
export function rearTyre(model) {
  const hub = model.getObjectByName('Wheel_R');
  if (!hub) return null;
  model.updateMatrixWorld(true);
  const centre = bikePos(model, hub);
  let tyre = null, extent = 0;
  const meshes = listMeshes(model).filter(x => x.group === 'Wheel_R').map(x => x.mesh);
  for (const mesh of meshes) {
    let lo = Infinity, hi = -Infinity;
    eachVertex(model, mesh, (v) => { lo = Math.min(lo, v.y); hi = Math.max(hi, v.y); });
    if (hi - lo > extent) { extent = hi - lo; tyre = mesh; }
  }
  if (!tyre) return null;
  let R = 0, rin = Infinity, half = 0;
  eachVertex(model, tyre, (v) => {
    const r = Math.hypot(v.y - centre.y, v.z - centre.z);
    R = Math.max(R, r); rin = Math.min(rin, r); half = Math.max(half, Math.abs(v.x - centre.x));
  });
  return { centre, R, rin, half, ring: (R + rin) / 2, tube: (R - rin) / 2, mesh: tyre.name, meshes };
}

/** Signed distance of a bike-space point from the tyre's solid (box-torus); < 0 = inside. */
function tyreDistance(t, v) {
  const r = Math.hypot(v.y - t.centre.y, v.z - t.centre.z);
  return Math.max(Math.abs(r - t.ring) - t.tube, Math.abs(v.x - t.centre.x) - t.half);
}

/** Bike parts against the rear tyre: vertices inside the tread band, the nearest part, per-mesh depths. */
export function measureRearWheel(model, tyre = rearTyre(model)) {
  if (!tyre) return null;
  let inside = 0, clearance = Infinity, nearest = null;
  const penetrating = [];
  for (const { mesh, group, seat } of listMeshes(model)) {
    if (seat || WHEEL_GROUPS.has(group) || !mesh.visible) continue;
    let n = 0, depth = 0, near = Infinity;
    eachVertex(model, mesh, (v) => {
      const d = tyreDistance(tyre, v);
      near = Math.min(near, d);
      if (d < 0) { n++; depth = Math.max(depth, -d); }
    });
    if (near < clearance) { clearance = near; nearest = mesh.name; }
    if (n) { inside += n; penetrating.push({ mesh: mesh.name, inside: n, depth }); }
  }
  penetrating.sort((a, b) => b.depth - a.depth);
  return { inside, clearance, nearest, penetrating, tyre: { R: tyre.R, rin: tyre.rin, half: tyre.half, centre: tyre.centre.toArray() } };
}

/** The saddle mesh under a socket and its top: {mesh, top, socketAboveMesh, box}. */
export function measureSaddle(model, seat) {
  const socket = model.getObjectByName('Seat_' + seat);
  if (!socket) return null;
  model.updateMatrixWorld(true);
  const s = bikePos(model, socket);
  let best = null;
  for (const { mesh, seat: gs } of listMeshes(model)) {
    if (gs || !SADDLE_MESH.test(mesh.name)) continue;
    const box = new THREE.Box3();
    let top = -Infinity;
    eachVertex(model, mesh, (v) => {
      box.expandByPoint(v);
      if (Math.hypot(v.x - s.x, v.z - s.z) < 0.03) top = Math.max(top, v.y);
    });
    if (box.min.x - 0.01 <= s.x && s.x <= box.max.x + 0.01 && box.min.z - 0.02 <= s.z && s.z <= box.max.z + 0.02) {
      if (!best || top > best.top) best = { mesh: mesh.name, top, box, socket: s.clone() };
    }
  }
  if (!best) return null;
  if (!Number.isFinite(best.top)) best.top = best.box.max.y;
  best.socketAboveMesh = s.y - best.top;
  return best;
}

/** Bike-space landmarks of the assembly at its current pose (for markers and readouts). */
export function landmarks(riders) {
  const model = riders.model;
  model.updateMatrixWorld(true);
  const at = (name) => { const o = model.getObjectByName(name); return o ? bikePos(model, o) : null; };
  const out = { bike: { sockets: {}, pins: {}, grips: {} }, riders: {} };
  for (const seat of SEATS) {
    out.bike.sockets[seat] = at('Seat_' + seat);
    for (const side of ['L', 'R']) {
      out.bike.pins[seat + side] = at(`PedalPin_${CRANK[seat]}${side}`);
      out.bike.grips[seat + side] = at(`Grip_${GRIP[seat]}_${side}`);
    }
  }
  for (const [seat, r] of Object.entries(riders.riders)) {
    const root = r.root;
    const bone = (n) => { const b = root.getObjectByName(n); return b ? bikePos(model, b) : null; };
    const hl = bone('LeftUpLeg'), hr = bone('RightUpLeg');
    const lm = {
      hipMid: hl && hr ? hl.clone().add(hr).multiplyScalar(0.5) : null,
      hips: { L: hl, R: hr },
      toe: { L: bone('LeftToeBase'), R: bone('RightToeBase') },
      hand: { L: bone('LeftHand'), R: bone('RightHand') },
      soleUp: 0,
      expectedBall: {},
    };
    // ride_fit: the ball of the foot sits its rest height above the rig origin (sole plane) over the pin
    const rest = restBonePos(root, 'LeftToeBase');
    if (rest) lm.soleUp = rest.y * (root.scale.y || 1);
    for (const side of ['L', 'R']) {
      const pin = out.bike.pins[seat + side];
      lm.expectedBall[side] = pin ? pin.clone().add(new THREE.Vector3(0, lm.soleUp, 0)) : null;
    }
    out.riders[seat] = lm;
  }
  return out;
}

/**
 * The full fit report at the current pose. Skinned vertices are evaluated, so call after
 * riders.update() (the pose) — this function updates the matrices itself.
 * @param {import('../goose-riders.js').GooseRiders} riders
 * @param {{wheel?: boolean, tyre?: object}} [opts] wheel: false skips the bike-vs-tyre scan (static; do it once)
 */
export function measureFit(riders, opts = {}) {
  const model = riders.model;
  model.updateMatrixWorld(true);
  const tyre = opts.tyre || rearTyre(model);
  const report = { bike: { saddles: {} }, riders: {} };
  if (opts.wheel !== false) report.bike.rearWheel = measureRearWheel(model, tyre);
  const lm = landmarks(riders);
  const saddles = {};
  for (const seat of SEATS) {
    const s = measureSaddle(model, seat);
    if (s) { saddles[seat] = s; report.bike.saddles[seat] = { mesh: s.mesh, top: s.top, socketAboveMesh: s.socketAboveMesh }; }
  }
  for (const [seat, r] of Object.entries(riders.riders)) {
    if (!r.root.visible) continue;
    const l = lm.riders[seat], socket = lm.bike.sockets[seat], saddle = saddles[seat];
    const rep = { hipAboveSaddle: l.hipMid && socket ? l.hipMid.y - socket.y : undefined, foot: {}, hand: {}, soleUp: l.soleUp };
    for (const side of ['L', 'R']) {
      if (l.toe[side] && l.expectedBall[side]) rep.foot[side] = { err: l.toe[side].distanceTo(l.expectedBall[side]), dy: l.toe[side].y - l.expectedBall[side].y };
      if (l.hand[side] && lm.bike.grips[seat + side]) rep.hand[side] = { dist: l.hand[side].distanceTo(lm.bike.grips[seat + side]) };
    }
    // seat probe: the lowest posed body point over the sit-bone band of the saddle (the rear, where the
    // socket is: 6 cm behind to 2 cm in front of it), against the saddle top — what the bottom does.
    // nose probe: the same over the nose (2 to 10 cm in front): the thighs wrap the nose, so it sinks
    // much deeper into the breeches than the bottom does; reported apart so the two aren't confused.
    if (saddle && socket) {
      let low = Infinity, lowMesh = null, nose = Infinity, noseMesh = null;
      let cloth = 0, clothMesh = null, clothMax = 0;
      r.root.traverse((mesh) => {
        if (!mesh.isMesh || !mesh.visible) return;
        const probe = PROBE_MESH.test(mesh.name);
        let n = 0;
        eachVertex(model, mesh, (v) => {
          // (a lifted skirt leaves nothing within 5 cm over the saddle: then there is no seat to measure)
          if (probe && Math.abs(v.x - socket.x) < 0.04 && v.y > socket.y - 0.14 && v.y < socket.y + 0.05) {
            if (v.z > socket.z - 0.06 && v.z < socket.z + 0.02 && v.y < low) { low = v.y; lowMesh = mesh.name; }
            else if (v.z >= socket.z + 0.02 && v.z < socket.z + 0.10 && v.y < nose) { nose = v.y; noseMesh = mesh.name; }
          }
          if (tyre && Math.abs(v.x - tyre.centre.x) < tyre.half + 0.01 && Math.hypot(v.y - tyre.centre.y, v.z - tyre.centre.z) < tyre.R) n++;
        });
        if (n) { cloth += n; if (n > clothMax) { clothMax = n; clothMesh = mesh.name; } }
      });
      if (Number.isFinite(low)) { rep.seatProbe = low - saddle.top; rep.seatProbeMesh = lowMesh; }
      if (Number.isFinite(nose)) { rep.noseProbe = nose - saddle.top; rep.noseProbeMesh = noseMesh; }
      rep.clothInWheel = cloth;
      rep.clothInWheelMesh = clothMesh;
    }
    report.riders[seat] = rep;
  }
  return report;
}

/**
 * Worst case over one crank turn: feet at every step, the seat probe and cloth-in-wheel too.
 * Leaves the crank where it was. Returns a measureFit-shaped report.
 */
export function sweepCrank(riders, steps = 12, opts = {}) {
  const crank0 = riders._crank;
  const tyre = opts.tyre || rearTyre(riders.model);
  let worst = null;
  for (let k = 0; k < steps; k++) {
    const angle = (2 * Math.PI * k) / steps;
    riders.setCrank(angle);
    riders.update();
    const rep = measureFit(riders, { wheel: k === 0 && opts.wheel !== false, tyre });
    if (!worst) { worst = rep; worst.steps = steps; for (const r of Object.values(rep.riders)) for (const f of Object.values(r.foot)) f.crank = 0; continue; }
    for (const [seat, r] of Object.entries(rep.riders)) {
      const w = worst.riders[seat];
      if (!w) { worst.riders[seat] = r; continue; }
      for (const side of ['L', 'R']) {
        if (r.foot[side] && (!w.foot[side] || r.foot[side].err > w.foot[side].err)) w.foot[side] = { ...r.foot[side], crank: Math.round(angle * 180 / Math.PI) };
      }
      if (r.seatProbe !== undefined && (w.seatProbe === undefined || r.seatProbe < w.seatProbe)) { w.seatProbe = r.seatProbe; w.seatProbeMesh = r.seatProbeMesh; w.seatProbeCrank = Math.round(angle * 180 / Math.PI); }
      if (r.noseProbe !== undefined && (w.noseProbe === undefined || r.noseProbe < w.noseProbe)) { w.noseProbe = r.noseProbe; w.noseProbeMesh = r.noseProbeMesh; }
      if (r.clothInWheel > (w.clothInWheel || 0)) { w.clothInWheel = r.clothInWheel; w.clothInWheelMesh = r.clothInWheelMesh; }
    }
  }
  riders.setCrank(crank0);
  riders.update();
  return worst;
}
