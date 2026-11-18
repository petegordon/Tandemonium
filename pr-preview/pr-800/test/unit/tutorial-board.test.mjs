// #503 · the tutorial's 3D start / end boards: placement, glint, budget.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { boardPose, glintAt, buildTutorialBoard, boardTriangles, BOARD_PLACES, BOARD } from '../../js/tutorial-board.js';

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

test("#546 · the pot-of-gold sign: half size, over the lane, nothing in the riders' way", () => {
  const g = buildTutorialBoard('pot', { textureLoader: stubLoader, scale: 0.5, bottom: 2.7, overhead: true });
  assert.equal(g.scale.x, 0.5);
  g.updateMatrixWorld(true);
  const [structure, face] = g.children;
  const fb = new THREE.Box3().setFromObject(face);
  assert.ok(Math.abs(fb.min.y - 2.7) < 0.05, `face bottom at ${fb.min.y.toFixed(2)} m`);
  assert.ok(Math.abs((fb.max.x - fb.min.x) - BOARD.W / 2) < 0.1, `face ${(fb.max.x - fb.min.x).toFixed(2)} m wide, half the tutorial board`);
  // The tandem (0.45 m half-width, ~2.2 m tall) rides under it: no structure
  // in that box, so the brace moved up under the face.
  // Triangle by triangle (a box has vertices only at its corners), as world AABBs.
  const tris = (mesh) => {
    const p = mesh.geometry.attributes.position, out = [];
    for (let i = 0; i < p.count; i += 3) {
      const box = new THREE.Box3();
      for (let k = 0; k < 3; k++) box.expandByPoint(new THREE.Vector3().fromBufferAttribute(p, i + k).applyMatrix4(mesh.matrixWorld));
      out.push(box);
    }
    return out;
  };
  const riders = new THREE.Box3(new THREE.Vector3(-0.5, 0.01, -5), new THREE.Vector3(0.5, 2.4, 5));
  const inWay = tris(structure).filter(t => t.intersectsBox(riders));
  assert.equal(inWay.length, 0, `${inWay.length} structure triangles in the riders' way`);
  // The full-size tutorial board keeps its low brace.
  const end = buildTutorialBoard('end', { textureLoader: stubLoader });
  end.updateMatrixWorld(true);
  assert.ok(tris(end.children[0]).some(t => t.intersectsBox(riders)), 'the tutorial board still has its brace below the face');
});
