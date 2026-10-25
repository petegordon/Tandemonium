// #475 · Grandma at the finish: when she waves, how her borrowed clips are
// fitted, and that the props build.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { shouldWave, retargetClip, buildWoodpile, buildOuthouse, buildTimberTree, buildGrandmaFinish, LAYOUT } from '../../js/grandma-finish.js';

test('shouldWave: idle far off, wave on the final approach and just past her', () => {
  const L = 1000;
  assert.equal(shouldWave(100, 300, L), false, '200 ahead: still idling');
  assert.equal(shouldWave(250, 300, L), true, '50 ahead: waving');
  assert.equal(shouldWave(305, 300, L), true, 'just past her: still waving');
  assert.equal(shouldWave(330, 300, L), false, 'well past: back to idle');
  assert.equal(shouldWave(980, 20, L), true, 'across the loop seam');
});

test('retargetClip keeps rotations for her bones, drops positions and unknown bones', () => {
  const clip = new THREE.AnimationClip('wave', 2.1, [
    new THREE.QuaternionKeyframeTrack('RightArm.quaternion', [0, 1], [0, 0, 0, 1, 0, 0, 0.5, 0.866]),
    new THREE.VectorKeyframeTrack('Hips.position', [0, 1], [0, 1, 0, 0, 1.1, 0]),
    new THREE.QuaternionKeyframeTrack('Wing_extra.quaternion', [0, 1], [0, 0, 0, 1, 0, 0, 0, 1]),
  ]);
  const out = retargetClip(clip, new Set(['RightArm', 'Hips']));
  assert.deepEqual(out.tracks.map((t) => t.name), ['RightArm.quaternion']);
  assert.equal(out.duration, 2.1);
});

test('the three props build into meshes on the ground', () => {
  for (const build of [buildWoodpile, buildOuthouse, buildTimberTree]) {
    const g = build();
    const box = new THREE.Box3().setFromObject(g);
    assert.ok(box.max.y > 1, `${g.name} has height`);
    assert.ok(box.min.y > -0.05, `${g.name} sits on the ground (${box.min.y.toFixed(2)})`);
  }
});

test('the set: four markers at the finish on the house side, off the road', () => {
  const roadPath = { loopLength: 1000, getPointAtDistance: (d) => ({ x: 0, y: 0, z: d, heading: 0 }) };
  const { markers, grandmaD } = buildGrandmaFinish(roadPath, 500);
  assert.equal(markers.length, 4);
  assert.equal(grandmaD, 500 + LAYOUT.grandma.along);
  for (const m of markers) {
    assert.ok(Math.abs(m.mesh.position.x) > 2.5, `${m.mesh.name} is off the 5-unit road`);
    assert.ok(Math.abs(m.roadD - 500) < 20, `${m.mesh.name} is near the finish`);
  }
});
