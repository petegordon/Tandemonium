// #503 · the tutorial's 3D start / end boards: placement, glint, budget.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { boardPose, glintAt, buildTutorialBoard, boardTriangles, BOARD_PLACES } from '../../js/tutorial-board.js';

const stubLoader = { load: () => new THREE.Texture() };

for (const heading of [0, 0.7, -2.1, Math.PI]) {
  for (const lateral of [5.4, -4.6]) {
    test(`boardPose: heading ${heading}, lateral ${lateral} faces the oncoming riders and leans in to the road`, () => {
      const pt = { x: 10, z: -3, heading };
      const p = boardPose(pt, lateral, 0.45);
      const fx = Math.sin(heading), fz = Math.cos(heading), rx = fz, rz = -fx;
      // sits `lateral` metres to the side
      assert.ok(Math.abs((p.x - pt.x) * rx + (p.z - pt.z) * rz - lateral) < 1e-9);
      // face points back down the road (riders approach from behind the board's front)
      assert.ok(p.face.x * fx + p.face.z * fz < -0.8);
      // and turns in towards the road (away from its own side)
      assert.ok((p.face.x * rx + p.face.z * rz) * Math.sign(lateral) < -0.3);
      // rotY turns local +Z onto the face direction
      assert.ok(Math.abs(Math.sin(p.rotY) - p.face.x) < 1e-9 && Math.abs(Math.cos(p.rotY) - p.face.z) < 1e-9);
    });
  }
}

test('glintAt: idle before, rises and falls over its sweep, idle after', () => {
  assert.equal(glintAt(5, -1), 0);
  assert.equal(glintAt(4.9, 5), 0);
  assert.ok(glintAt(5.7, 5) > 0.95);
  assert.equal(glintAt(6.5, 5), 0);
});

test('places: start where the Your Home sign stood, end just past the finish on the other side', () => {
  assert.equal(BOARD_PLACES.start.d, 15);
  assert.ok(BOARD_PLACES.start.lateral < 0 && BOARD_PLACES.end.lateral > 0 && BOARD_PLACES.end.dAfter > 0);
});

for (const kind of ['start', 'end']) {
  test(`buildTutorialBoard(${kind}): three meshes (draw calls), under 3k triangles`, () => {
    const g = buildTutorialBoard(kind, { textureLoader: stubLoader });
    const meshes = [];
    g.traverse(o => { if (o.isMesh) meshes.push(o); });
    assert.equal(meshes.length, 3);
    const tris = boardTriangles(g);
    assert.ok(tris < 3000, `triangles ${tris}`);
    assert.ok(g.userData.board && typeof g.userData.board.update === 'function');
  });
}

test('the glint fires once as the bike passes, and re-arms after a retry rewinds', () => {
  const g = buildTutorialBoard('end', { textureLoader: stubLoader });
  const b = g.userData.board;
  const face = g.children[1];
  let glint = () => 0;
  // reach into the face material's uniforms via onBeforeCompile's closure: drive update and read back through a fake shader
  const sh = { uniforms: {}, vertexShader: '#include <common>\n#include <begin_vertex>', fragmentShader: '#include <common>\n#include <emissivemap_fragment>' };
  face.material.onBeforeCompile(sh);
  glint = () => sh.uniforms.uGlint.value;
  b.update(1, 100, 200); assert.equal(glint(), 0);
  b.update(2, 200, 200); assert.equal(glint(), 0);              // the sweep starts now
  b.update(2.7, 205, 200); assert.ok(glint() > 0.9);
  b.update(4.0, 210, 200); assert.equal(glint(), 0);
  b.update(5.0, 150, 200);                                       // retry: rewound
  b.update(6.0, 201, 200); b.update(6.7, 203, 200); assert.ok(glint() > 0.9);
});
