// #475 · Grandma at the finish: when she waves, how her borrowed clips are
// fitted, and that the props build.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { grandmaCue, retargetClip, buildWoodpile, buildOuthouse, buildTimberTree, buildGrandmaFinish, LAYOUT, WALK } from '../../js/grandma-finish.js';

test('grandmaCue: idle far off, wave on the final approach, leave once they pass', () => {
  const L = 1000;
  assert.equal(grandmaCue(100, 300, L), 'idle', '200 ahead: still idling');
  assert.equal(grandmaCue(250, 300, L), 'wave', '50 ahead: waving');
  assert.equal(grandmaCue(300, 300, L), 'wave', 'level with her: still waving');
  assert.equal(grandmaCue(300.5, 300, L), 'leave', 'just past her: off she goes');
  assert.equal(grandmaCue(980, 20, L), 'wave', 'across the loop seam');
  assert.equal(grandmaCue(25, 20, L), 'leave', 'past her across the seam');
});

/** A straight road up a 6% grade along +z (heading 0), so the house side (+lateral) is +x. */
const straightRoad = { loopLength: 10000, getPointAtDistance: (d) => ({ x: 0, y: 0.06 * d, z: d, heading: 0 }) };

/** Step the walk at 60 fps for `secs` with the bike at `bikeD`. */
function run(set, bikeD, secs) { for (let i = 0; i < secs * 60; i++) set.update(bikeD, 1 / 60); }

test('once the riders pass, Grandma turns round and walks to the finish line', () => {
  const destD = 500;
  const set = buildGrandmaFinish(straightRoad, destD);
  const g = set.grandma.group, marker = set.markers[0];
  assert.equal(g.position.z, destD + LAYOUT.grandma.along, 'starts at her spot');
  assert.ok(Math.abs(g.rotation.y - Math.PI) < 1e-9, 'facing the oncoming riders');

  run(set, destD - 40, 1);
  assert.equal(set.route.mode, 'home', 'waits while they approach');

  // The bike passes her and crosses the finish.
  run(set, destD - 3, WALK.turnTime / 2);
  assert.equal(set.route.mode, 'turn');
  assert.ok(Math.abs(g.rotation.y - 1.5 * Math.PI) < 0.05, 'half-way round she faces the road (−lateral side)');
  assert.ok(Math.abs(g.position.z - (destD + LAYOUT.grandma.along)) < 1e-9, 'turns on the spot');

  run(set, destD + 2, WALK.turnTime / 2 + 0.5);
  assert.equal(set.route.mode, 'walk');
  assert.ok(Math.cos(g.rotation.y) > 0.8, 'walking toward the finish (angled a little out toward her house)');
  assert.ok(g.position.z > destD + LAYOUT.grandma.along + 1, 'and getting closer');
  assert.ok(g.position.x > 2.5 && g.position.x >= Math.min(LAYOUT.grandma.lateral, WALK.toLateral) - 1e-9 && g.position.x <= Math.max(LAYOUT.grandma.lateral, WALK.toLateral) + 1e-9, 'along the shoulder, off the road');
  assert.equal(marker.roadD, g.position.z, 'her marker moves with her, so World grounds her on the slope');

  run(set, destD + 2, 10);
  assert.equal(set.route.mode, 'arrived');
  assert.ok(Math.abs(g.position.z - (destD + WALK.toAlong)) < 1e-9 && Math.abs(g.position.x - WALK.toLateral) < 1e-9, 'stops beside the bike, between the road and her house (#481)');
  assert.ok(WALK.toLateral > 2.5 && WALK.toLateral < 4.6, 'off the 5-unit road and in front of the house front (lateral 4.6)');
});

test('she gets there within the finish cinematic, even after a fast finish', () => {
  // Fastest case: the bike is at top speed (16 u/s) from her spot to the line,
  // then the cinematic runs 4.7 s of real time (her clock).
  const walkTime = WALK.turnTime + (WALK.toAlong - LAYOUT.grandma.along) / WALK.speed;
  assert.ok(walkTime <= -LAYOUT.grandma.along / 16 + 4.7, `walk takes ${walkTime.toFixed(2)} s`);
});

test('a reset that puts the bike back before her sends her home', () => {
  const destD = 500;
  const set = buildGrandmaFinish(straightRoad, destD);
  run(set, destD + 1, 3);
  assert.notEqual(set.route.mode, 'home');
  run(set, destD - 30, 0.1);
  assert.equal(set.route.mode, 'home');
  assert.equal(set.grandma.group.position.z, destD + LAYOUT.grandma.along);
  assert.equal(set.markers[0].roadD, destD + LAYOUT.grandma.along);
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

test('the set: five markers at the finish on the house side, off the road', () => {
  const roadPath = { loopLength: 1000, getPointAtDistance: (d) => ({ x: 0, y: 0, z: d, heading: 0 }) };
  const { markers, grandmaD, stack } = buildGrandmaFinish(roadPath, 500);
  // Grandma, woodpile, outhouse, tree, and (#478) the present pile
  assert.equal(markers.length, 5);
  assert.deepEqual(markers.map((m) => m.type), ['grandma-prop', 'grandma-prop', 'grandma-prop', 'grandma-prop', 'present-stack']);
  assert.ok(stack && markers[4].mesh === stack.group, 'the pile is the last marker');
  assert.equal(grandmaD, 500 + LAYOUT.grandma.along);
  for (const m of markers) {
    assert.ok(Math.abs(m.mesh.position.x) > 2.5, `${m.mesh.name} is off the 5-unit road`);
    assert.ok(Math.abs(m.roadD - 500) < 20, `${m.mesh.name} is near the finish`);
  }
});
