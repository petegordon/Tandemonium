// The achievement count ignores retired achievements, and the gold sparkles stay off the spinning parts.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ACHIEVEMENTS } from '../../js/achievement-defs.js';
import { addBikeSparkle, isSpinningPart } from '../../js/bike-sparkle.js';

const storage = (seed = {}) => {
  const m = new Map(Object.entries(seed));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
};

test('retired achievements stay saved but are not counted', async () => {
  const ids = [...ACHIEVEMENTS.slice(0, 99).map((a) => a.id), 'perfect_5k', 'royal', 'sling_500'];
  globalThis.localStorage = storage({ tandemonium_achievements: JSON.stringify(ids.map((id) => ({ id, earnedAt: 1 }))) });
  const { AchievementManager } = await import('../../js/achievements.js');
  const m = new AchievementManager();
  assert.equal(m.earnedCount(), 99);
  assert.ok(m.getEarnedIds().includes('royal'), 'still saved');
});

function part(root, name) {
  const group = new THREE.Group();
  group.name = name;
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ metalness: 1 }));
  mesh.name = 'GS_' + name;
  group.add(mesh);
  root.add(group);
  return group;
}

test('the wheels, cranks and pedals are spinning parts; the frame and steering are not', () => {
  const root = new THREE.Group();
  for (const name of ['Wheel_F', 'Wheel_R', 'Crank_F', 'Pedal_FL', 'PedalPin_FR']) {
    const g = part(root, name);
    assert.equal(isSpinningPart(g.children[0], root), true, name);
  }
  for (const name of ['Bike_root', 'Steer', 'GS_frame']) {
    const g = part(root, name);
    assert.equal(isSpinningPart(g.children[0], root), false, name);
  }
});

test('every sparkle lands on a part that does not spin', () => {
  const root = new THREE.Group();
  for (const name of ['Wheel_F', 'Wheel_R', 'Crank_R', 'Bike_root', 'Steer']) part(root, name);
  const { meshes } = addBikeSparkle(root, { count: 60 });
  assert.ok(meshes.length > 0);
  assert.deepEqual(meshes.map((m) => m.parent.name).sort(), ['Bike_root', 'Steer']);
  const stars = meshes.reduce((n, m) => n + m.geometry.attributes.position.count / 6, 0);
  assert.equal(stars, 60, 'the same number of sparkles, all on the frame');
});
