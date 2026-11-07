// #456 · a checkpoint's cloud arch drawn as one mesh instead of 16 sprites.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildArchPuffs, archTime } from '../../js/arch-puffs.js';

test('16 puffs, one mesh: a camera-facing quad per puff along the arch', () => {
  const tex = new THREE.Texture();
  const m = buildArchPuffs(tex, { random: () => 0.5 });
  const g = m.geometry;
  assert.equal(g.attributes.position.count, 16 * 4);
  assert.equal(g.index.count, 16 * 6);
  // every quad's four corners sit on its puff's centre (the shader spreads them)
  const p = g.attributes.position;
  for (let i = 0; i < 16; i++) {
    for (let k = 1; k < 4; k++) assert.equal(p.getX(i * 4 + k), p.getX(i * 4));
  }
  // the arch: right end, top, left end
  assert.ok(Math.abs(p.getX(0) - 2.8) < 1e-6 && Math.abs(p.getY(0) - 0.2) < 1e-6);
  assert.ok(Math.abs(p.getX(15 * 4) + 2.8) < 1e-6);
  assert.ok(Math.max(...Array.from({ length: 16 }, (_, i) => p.getY(i * 4))) > 2.9);
  // sizes as the sprites had them: 1.6 + random * 0.8
  assert.equal(g.attributes.puff.getX(0), 2.0);
});

test('looks like the sprites: same texture, tint, opacity, fog, blending', () => {
  const tex = new THREE.Texture();
  const m = buildArchPuffs(tex, { color: 0xffd700, opacity: 0.6 });
  const mat = /** @type {THREE.ShaderMaterial} */ (m.material);
  assert.equal(mat.uniforms.map.value, tex, 'the shared texture, not a copy');
  assert.ok(mat.uniforms.diffuse.value.equals(new THREE.Color(0xffd700)));
  assert.equal(mat.uniforms.opacity.value, 0.6);
  assert.ok(mat.transparent && !mat.depthWrite && mat.fog);
  assert.ok('fogColor' in mat.uniforms);
});

test('every arch bobs on one shared clock', () => {
  const a = buildArchPuffs(new THREE.Texture());
  const b = buildArchPuffs(new THREE.Texture());
  assert.equal(a.material.uniforms.time, archTime);
  assert.equal(b.material.uniforms.time, archTime);
});

test('the bounds cover the quads, so the arch is not culled while a puff is on screen', () => {
  const m = buildArchPuffs(new THREE.Texture(), { random: () => 1 });
  const s = m.geometry.boundingSphere;
  // the far corner of the top puff: centre (0, 3.0) plus half its 2.4 size
  const corner = new THREE.Vector3(1.2, 0.2 + 2.8 + 1.2, 0.3);
  assert.ok(s.center.distanceTo(corner) <= s.radius);
});
