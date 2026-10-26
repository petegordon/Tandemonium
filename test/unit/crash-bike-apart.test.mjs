// #484 steps 3–4 · the tandem comes apart in a crash, and in versus a flying part wobbles the other team.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { PARTS, partOf, batchSplit, hasParts, visibleMeshesByPart, boundsIn, partLaunch } from '../../js/physics/bike-parts.js';
import { rebatch } from '../../js/bike-batch.js';
import { WOBBLE, hitWobble, shakeAt, onBike, kickSign, aimAt } from '../../js/crash-wobble.js';
import { simSecondsFor, realSecondsFor } from '../../js/crash-slowmo.js';

/** A small goose-tandem-shaped rig: the bone and mesh names of tandem-3d/goose/goose_tandem.glb (as three names them). */
function rig() {
  const root = new THREE.Group();
  const bike = new THREE.Bone(); bike.name = 'Bike_root'; root.add(bike);
  const steer = new THREE.Bone(); steer.name = 'Steer'; steer.position.set(0, 0.66, 0.69); bike.add(steer);
  const wf = new THREE.Bone(); wf.name = 'Wheel_F'; wf.position.set(0, -0.36, 0.04); steer.add(wf);
  const wr = new THREE.Bone(); wr.name = 'Wheel_R'; wr.position.set(0, 0.33, -0.85); bike.add(wr);
  const crank = new THREE.Bone(); crank.name = 'Crank_F'; bike.add(crank);
  const mat = new THREE.MeshStandardMaterial({ color: 0x333333 });
  const mesh = (name, parent, g = new THREE.BoxGeometry(0.1, 0.1, 0.1)) => {
    const m = new THREE.Mesh(g, mat); m.name = name; parent.add(m); return m;
  };
  const M = {
    tyreF: mesh('tyre_rear_low_cycle_0', wf, new THREE.CylinderGeometry(0.33, 0.33, 0.04)),
    spokeF: mesh('Cylinder035_cycle_0', wf),
    tyreR: mesh('Cylinder008_cycle_0', wr, new THREE.CylinderGeometry(0.33, 0.33, 0.04)),
    fork: mesh('NurbsPath001_cycle_0', steer),
    bar: mesh('NurbsPath_cycle_0', steer),
    seatC: mesh('seat_cycle_0', bike),
    seatS: mesh('seat001_cycle_0', bike),
    stokerBar: mesh('Cylinder019_cycle_0', bike),
    stem: mesh('goosefit_stoker_stem_cycle_0', bike),
    tube1: mesh('Cylinder_cycle_0', bike),
    tube2: mesh('NurbsPath002_cycle_0', bike),
    chain: mesh('chain_rod_low_cycle_0', crank),
  };
  const goose = new THREE.Group(); goose.userData.gooseSeat = 'Captain';
  const gm = new THREE.Mesh(new THREE.BoxGeometry(), mat); gm.name = 'seat_cycle_0'; goose.add(gm);   // a rider's mesh: never a part
  bike.add(goose);
  return { root, M, gm };
}

test('every mesh goes to the right part', () => {
  const { M } = rig();
  const want = { tyreF: 'wheelF', spokeF: 'wheelF', tyreR: 'wheelR', fork: 'bars', bar: 'bars', seatC: 'saddleC',
    seatS: 'saddleS', stokerBar: 'stokerBars', stem: 'stokerBars', tube1: 'frame', tube2: 'frame', chain: 'frame' };
  for (const [k, part] of Object.entries(want)) assert.equal(partOf(M[k]), part, k);
});

test('the GLB names with their dots (as Blender wrote them) classify the same', () => {
  assert.equal(partOf({ name: 'seat.001_cycle_0' }), 'saddleS');
  assert.equal(partOf({ name: 'NurbsPath.009_cycle_0' }), 'stokerBars');
});

test('only the goose tandem rig has parts', () => {
  assert.equal(hasParts(rig().root), true);
  const plain = new THREE.Group(); plain.add(new THREE.Mesh(new THREE.BoxGeometry()));
  assert.equal(hasParts(plain), false);
});

test('batching keeps each flying part out of the frame merge, and tags the merge', () => {
  const { root } = rig();
  rebatch(root, { split: batchSplit });
  const byPart = visibleMeshesByPart(root);
  // the frame's two tubes merge into one; saddles and the stoker bars are not in it
  const frame = byPart.frame.filter(m => m.userData.bikeBatch);
  assert.equal(frame.length, 1);
  assert.equal(byPart.saddleC.length, 1);
  assert.equal(byPart.saddleS.length, 1);
  assert.equal(byPart.stokerBars.length, 1, 'the stoker bar and stem merge with each other');
  assert.equal(byPart.stokerBars[0].userData.bikePart, 'stokerBars');
  // nothing drawn twice, no rider mesh among the parts
  const all = Object.values(byPart).flat();
  assert.equal(new Set(all).size, all.length);
  for (const m of all) { let p = m; while (p) { assert.ok(!(p.userData && p.userData.gooseSeat)); p = p.parent; } }
});

test('a part\'s bounds are in the bike frame', () => {
  const { root, M } = rig();
  root.position.set(10, 0, 5);
  root.updateMatrixWorld(true);
  const b = boundsIn([M.tyreR], root.matrixWorld);
  const c = b.getCenter(new THREE.Vector3());
  assert.ok(Math.abs(c.z + 0.85) < 1e-6 && Math.abs(c.y - 0.33) < 1e-6);
});

test('wheels roll away forward, spinning about the axle; the rest pops up', () => {
  const fwd = { x: 0, z: 1 }, right = { x: 1, z: 0 }, rand = () => 0.5;
  const f = partLaunch({ part: 'wheelF', how: 'head-on', speed: 10, fwd, side: 1, right, radius: 0.6, rand });
  const r = partLaunch({ part: 'wheelR', how: 'head-on', speed: 10, fwd, side: 1, right, radius: 0.6, rand });
  assert.ok(f.linvel.z > r.linvel.z && r.linvel.z > 0, 'the front wheel carries on furthest');
  assert.ok(Math.abs(f.angvel.x - f.linvel.z / 0.6) < 1e-9, 'rolling, not skidding');
  const s = partLaunch({ part: 'saddleC', how: 'lean', speed: 10, fwd, side: 1, right, rand });
  assert.ok(s.linvel.y > 2);
  for (const k of Object.keys(PARTS)) {
    const L = partLaunch({ part: k, how: 'lean', speed: 0, fwd, side: -1, right, rand: Math.random });
    for (const v of [L.linvel, L.angvel]) for (const x of Object.values(v)) assert.ok(Number.isFinite(x));
  }
});

test('a wheel hits harder than a saddle; a slow brush is not felt; kicks are capped', () => {
  const wheel = hitWobble(PARTS.wheelR.mass, 8), saddle = hitWobble(PARTS.saddleC.mass, 8);
  assert.ok(wheel.kick > saddle.kick && saddle.kick > 0);
  assert.equal(hitWobble(PARTS.saddleC.mass, 1).kick, 0);
  assert.equal(hitWobble(PARTS.wheelR.mass, 100).kick, WOBBLE.maxKick);
  assert.deepEqual(hitWobble(NaN, 5), { kick: 0, shake: 0 });
});

test('the shake dies away', () => {
  assert.equal(shakeAt(3, -1), 0);
  assert.equal(shakeAt(3, WOBBLE.shakeFor + 0.01), 0);
  let early = 0, late = 0;
  for (let t = 0; t < 0.4; t += 0.01) early = Math.max(early, Math.abs(shakeAt(3, t)));
  for (let t = 1.0; t < 1.4; t += 0.01) late = Math.max(late, Math.abs(shakeAt(3, t)));
  assert.ok(late < early * 0.4);
});

test('on the bike: the tandem and its riders, not the road beside it', () => {
  assert.ok(onBike({ x: 0, y: 1, z: 0 }));
  assert.ok(onBike({ x: 0.6, y: 0.5, z: 1.5 }, 0.3));
  assert.ok(!onBike({ x: 2, y: 1, z: 0 }));
  assert.ok(!onBike({ x: 0, y: 3, z: 0 }));
  assert.ok(!onBike({ x: 0, y: 1, z: 3 }));
  assert.equal(kickSign(0.3), 1);
  assert.equal(kickSign(-0.3), -1);
});

test('a throw at a moving team lands where it will be', () => {
  const from = { x: 0, y: 1, z: 0 }, target = { x: 3, y: 1, z: 6 }, tv = { x: 0, z: 4 }, g = 9.81;
  const T = 0.8, realT = realSecondsFor(T);
  const v = aimAt(from, target, tv, T, realT, { g });
  // fly it
  const x = from.x + v.x * T, z = from.z + v.z * T, y = from.y + v.y * T - 0.5 * g * T * T;
  assert.ok(Math.abs(x - target.x) < 1e-9 && Math.abs(y - target.y) < 1e-9);
  assert.ok(Math.abs(z - (target.z + tv.z * realT)) < 1e-9, 'it allows for the other team riding on in real time');
  assert.equal(aimAt(from, { x: 0, y: 1, z: 200 }, tv, 0.5, 0.5), null, 'no rocket throws');
});

test('real seconds for simulated seconds: the inverse of the slow-mo', () => {
  for (const r of [0, 0.3, 0.8, 0.9, 1.5, 3]) assert.ok(Math.abs(realSecondsFor(simSecondsFor(r)) - r) < 1e-6, String(r));
});
