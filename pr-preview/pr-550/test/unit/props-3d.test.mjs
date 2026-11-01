// #478 · the 3D present, death cone and Grandma's house: they build, sit
// where the game expects them, and stay inside the issue's budget.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  buildPresentGeometry, buildPresentFxGeometry, buildConeGeometry, buildGrandmaHouse,
  triCount, PRESENT, CONE, CONE_COLLIDER, HOUSE,
} from '../../js/props-3d.js';

const bounds = (geo) => { geo.computeBoundingBox(); return geo.boundingBox; };

test('present: ≤300 triangles, centred on its origin, coloured', () => {
  const g = buildPresentGeometry();
  assert.ok(triCount(g) <= 300, `${triCount(g)} tris`);
  const b = bounds(g);
  assert.ok(Math.abs(b.min.y + PRESENT.H / 2) < 0.03, `box bottom at -H/2 (${b.min.y.toFixed(3)})`);
  assert.ok(b.max.y > PRESENT.H / 2 + 0.1, 'the bow stands above the box');
  assert.ok(Math.abs(b.max.x - b.min.x - PRESENT.W) < 0.4, 'about a present wide');
  assert.ok(g.attributes.color, 'vertex colours');
  assert.ok(g.attributes.normal, 'normals');
});

test('present fx: ring, rays and twinkle tagged for the shader', () => {
  const g = buildPresentFxGeometry();
  const kinds = new Set(g.attributes.aKind.array);
  assert.deepEqual([...kinds].sort(), [0, 1, 2]);
  assert.ok(triCount(g) <= 120, `${triCount(g)} tris`);
  const noRing = buildPresentFxGeometry({ ring: false });
  assert.ok(!new Set(noRing.attributes.aKind.array).has(0), 'the house sparkle has no ring');
});

test('cone: ≤250 triangles, standing on its origin, mostly orange', () => {
  const g = buildConeGeometry();
  assert.ok(triCount(g) <= 250, `${triCount(g)} tris`);
  const b = bounds(g);
  assert.ok(Math.abs(b.min.y) < 1e-6, 'base on the ground');
  assert.ok(Math.abs(b.max.y - CONE.H) < 0.02, `height ${b.max.y.toFixed(2)}`);
  assert.ok(b.max.x - b.min.x <= CONE.BASE + 0.01, 'no wider than its base');
  // the collider the knocked cone tumbles as matches the model
  assert.equal(CONE_COLLIDER.halfExtents.y * 2, CONE.H);
  assert.equal(CONE_COLLIDER.colliderOffset.y, CONE.H / 2);
  // orange dominates the vertex colours (stripes are white, decals white)
  const c = g.attributes.color.array;
  let orange = 0, n = c.length / 3;
  for (let i = 0; i < c.length; i += 3) if (c[i] > 0.8 && c[i + 1] < 0.5 && c[i + 2] < 0.2) orange++;
  assert.ok(orange / n > 0.4, `orange share ${(orange / n).toFixed(2)}`);
  assert.ok(g.attributes.uv, 'uvs into the skull atlas');
});

test("Grandma's house: ≤6000 triangles in ≤3 draws, on the ground, door to +z", () => {
  const house = buildGrandmaHouse();
  const meshes = [];
  house.traverse((o) => { if (o.isMesh) meshes.push(o); });
  assert.ok(meshes.length <= 3, `${meshes.length} meshes`);
  assert.equal(house.userData.draws, meshes.length);
  assert.ok(house.userData.tris <= 6000, `${house.userData.tris} tris`);
  const b = new THREE.Box3().setFromObject(house.children[0]);   // the cabin
  assert.ok(Math.abs(b.min.y) < 0.01, `on the ground (${b.min.y.toFixed(3)})`);
  assert.ok(b.max.y > HOUSE.WALL + HOUSE.RISE, 'roof and bow above the walls');
  assert.ok(b.max.z > HOUSE.D / 2 + 0.5 && b.max.z > -b.min.z, 'porch and fence on the +z (door) side');
  assert.equal(typeof house.userData.update, 'function');
});

test('builders are deterministic (same model every ride)', () => {
  const a = buildGrandmaHouse().children[0].geometry.attributes.position.array;
  const b = buildGrandmaHouse().children[0].geometry.attributes.position.array;
  assert.equal(a.length, b.length);
  assert.deepEqual(Array.from(a.slice(0, 600)), Array.from(b.slice(0, 600)));
});
