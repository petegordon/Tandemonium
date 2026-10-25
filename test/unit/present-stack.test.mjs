// #478 · the present pile at Grandma's: a neat stepped pyramid that holds a
// ride's whole haul, and presents that fly in one after another and land.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { pyramidBase, pileSlots, flightAt, stackDuration, PresentStack, STACK } from '../../js/present-stack.js';

test('pyramidBase: smallest k whose pyramid holds n', () => {
  assert.equal(pyramidBase(1), 1);
  assert.equal(pyramidBase(2), 2);
  assert.equal(pyramidBase(5), 2);
  assert.equal(pyramidBase(6), 3);
  assert.equal(pyramidBase(14), 3);
  assert.equal(pyramidBase(15), 4);
  assert.equal(pyramidBase(27), 4);   // Today's Road on Daredevil, at most
});

test('pileSlots: one slot per present, capped, none for zero', () => {
  assert.deepEqual(pileSlots(0), []);
  assert.deepEqual(pileSlots(-3), []);
  for (const n of [1, 4, 5, 8, 13, 17, 27]) assert.equal(pileSlots(n).length, n);
  assert.equal(pileSlots(500).length, STACK.max);
});

test('pileSlots: bottom layer fills first, every upper present sits on four below', () => {
  for (const n of [5, 9, 14, 20, 27]) {
    const s = pileSlots(n);
    const layers = Math.max(...s.map((p) => p.layer)) + 1;
    const k = pyramidBase(n);
    // all full layers below the top one
    for (let L = 0; L < layers - 1; L++) assert.equal(s.filter((p) => p.layer === L).length, (k - L) ** 2, `n=${n} layer ${L} full`);
    // supported: every present above layer 0 has four presents under its corners
    const step = Math.abs(s.filter((p) => p.layer === 0).map((p) => p.x).sort((a, b) => a - b).find((x, i, a) => i && x - a[i - 1] > 0.1) - Math.min(...s.filter((p) => p.layer === 0).map((p) => p.x)));
    for (const p of s.filter((q) => q.layer > 0)) {
      const under = s.filter((q) => q.layer === p.layer - 1 && Math.abs(q.x - p.x) < step * 0.6 && Math.abs(q.z - p.z) < step * 0.6);
      assert.equal(under.length, 4, `n=${n}: a present on layer ${p.layer} rests on four`);
    }
    // nothing overlaps within a layer
    for (const a of s) for (const b of s) {
      if (a === b || a.layer !== b.layer) continue;
      assert.ok(Math.hypot(a.x - b.x, a.z - b.z) > step * 0.8, 'no two presents in one spot');
    }
  }
});

test('pileSlots: layers stack upwards and the pile is centred', () => {
  const s = pileSlots(14);
  const y0 = s.filter((p) => p.layer === 0)[0].y;
  assert.ok(y0 > 0, 'bottom presents rest on the ground (centre above it)');
  for (const p of s) assert.ok(Math.abs(p.y - (y0 + p.layer * (2 * y0))) < 1e-9, 'one present-height per layer');
  const cx = s.filter((p) => p.layer === 0).reduce((a, p) => a + p.x, 0) / 9;
  assert.ok(Math.abs(cx) < 0.05, 'centred on its origin');
});

test('flightAt: waits its turn, arcs above both ends, lands and settles', () => {
  const from = { x: 0, y: 2, z: 10 }, to = { x: 1, y: 0.3, z: 0 };
  const i = 3, t0 = i * STACK.stagger;
  const before = flightAt(i, t0 - 0.01, from, to);
  assert.equal(before.visible, false, 'hidden before its turn');
  const mid = flightAt(i, t0 + STACK.flight / 2, from, to);
  assert.ok(mid.visible && !mid.landed);
  assert.ok(mid.y > Math.max(from.y, to.y) + STACK.arc * 0.9, `arc peak ${mid.y.toFixed(2)}`);
  const start = flightAt(i, t0 + 1e-6, from, to);
  assert.ok(Math.abs(start.y - from.y) < 0.01 && Math.abs(start.z - from.z) < 0.01, 'leaves from the bike');
  const landed = flightAt(i, t0 + STACK.flight + 0.001, from, to);
  assert.ok(landed.landed && landed.x === to.x && landed.y === to.y && landed.z === to.z, 'lands in its slot');
  const settled = flightAt(i, t0 + STACK.flight + STACK.settle + 0.5, from, to);
  assert.ok(Math.abs(settled.s - 1) < 1e-9, 'squash is over');
});

test('stackDuration: the last present has landed by then', () => {
  assert.equal(stackDuration(0), 0);
  for (const n of [1, 8, 27]) {
    const d = stackDuration(n);
    const f = flightAt(n - 1, d, { x: 0, y: 2, z: 5 }, { x: 0, y: 0.2, z: 0 });
    assert.ok(f.landed, `n=${n} landed at ${d.toFixed(2)} s`);
  }
  // a 27-present haul is delivered well within the ~4.7 s finish cinematic
  assert.ok(stackDuration(27) < 4.0, stackDuration(27).toFixed(2));
});

test('PresentStack: flies n presents in, all land, instances match', () => {
  const st = new PresentStack();
  st.group.position.set(5, 0, 0);
  st.start(0, { x: 0, y: 0, z: 0 });
  assert.equal(st.mesh.count, 0, 'nothing for an empty haul');
  st.start(9, new THREE.Vector3(0, 0, 8));
  assert.equal(st.count, 9);
  assert.equal(st.mesh.count, 0, 'none in the air at t=0');
  for (let t = 0; t < 3; t += 1 / 60) st.update(1 / 60);
  assert.equal(st.landedCount(), 9);
  assert.equal(st.mesh.count, 9);
  assert.equal(st.running, false, 'stops updating once settled');
  st.dispose();
});
