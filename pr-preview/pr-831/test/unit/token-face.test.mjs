// Tandem Token faces (Pete, 2026-11-07): one token in every mode, stamped
// with the House Tandem controller on heads and a star on tails, with the
// Slingshot's halo and twinkling stars.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { drawTokenFace, tokenMaterials, buildTokenGeometry, TOKEN } from '../../js/token-face.js';

// A 2D context that records what was drawn.
function mockCanvas() {
  const calls = [];
  const g = new Proxy({}, {
    get: (o, k) => (k in o ? o[k] : (...a) => calls.push([k, ...a])),
    set: (o, k, v) => { o[k] = v; calls.push(['set:' + String(k), v]); return true; },
  });
  return { width: 0, height: 0, calls, getContext: () => g };
}

test('heads draws the controller mark, tails the star, both a quarter-turn back', () => {
  for (const design of ['controller', 'star']) {
    const c = mockCanvas();
    drawTokenFace(c.getContext('2d'), 512, design, false);
    const rot = c.calls.find(([k]) => k === 'rotate');
    assert.equal(rot[1], -Math.PI / 2, `${design} turned back for the cylinder cap UVs`);
    const rounds = c.calls.filter(([k]) => k === 'roundRect').length;
    const lines = c.calls.filter(([k]) => k === 'lineTo').length;
    if (design === 'controller') assert.equal(rounds, 2, 'controller body + bumper');
    else { assert.equal(rounds, 0); assert.equal(lines, 10, 'a five-point star'); }
  }
});

test('the bump map is white on black, the colour map white with engraving', () => {
  const col = mockCanvas(); drawTokenFace(col.getContext('2d'), 512, 'star', false);
  const bmp = mockCanvas(); drawTokenFace(bmp.getContext('2d'), 512, 'star', true);
  const first = (c, k) => c.calls.find(([n]) => n === k)[1];
  assert.equal(first(col, 'set:fillStyle'), '#fff');
  assert.equal(first(bmp, 'set:fillStyle'), '#000');
});

test('materials: [edge, heads, tails], gold Phong, shared, faces mapped', () => {
  const mats = tokenMaterials(() => mockCanvas());
  assert.equal(mats.length, 3);
  assert.equal(buildTokenGeometry().groups.length, 3, 'one material per cylinder group');
  for (const m of mats) {
    assert.ok(m instanceof THREE.MeshPhongMaterial, 'Phong: reads in the lean lighting (no env map)');
    assert.equal(m.color.getHex(), TOKEN.COLOR);
  }
  assert.ok(!mats[0].map, 'the edge is plain gold');
  for (const m of mats.slice(1)) {
    assert.ok(m.map && m.bumpMap && m.emissiveMap === m.map);
    assert.equal(m.map.colorSpace, THREE.SRGBColorSpace);
    assert.equal(m.map.anisotropy, 4);
  }
  assert.notEqual(mats[1].map, mats[2].map, 'heads and tails differ');
  assert.equal(tokenMaterials(), mats, 'built once and shared');
});

test('glow + sparkle: one halo quad and three star quads, one instanced draw', async () => {
  const { buildTokenFxGeometry, tokenFxMaterial } = await import('../../js/token-face.js');
  const g = buildTokenFxGeometry();
  assert.equal(g.attributes.position.count, 4 * 6, 'four quads');
  const kinds = Array.from(g.attributes.aKind.array);
  assert.equal(kinds.filter((k) => k === 0).length, 6, 'one halo');
  assert.equal(kinds.filter((k) => k === 1).length, 18, 'three stars');
  const m = tokenFxMaterial({ value: 0 });
  assert.equal(m.blending, THREE.AdditiveBlending);
  assert.equal(m.depthWrite, false);
});
