// E-2 · cobbles is a piece of road, so there has to be a piece of road. In solo
// the tightened beat window has no partner to apply to, which made the banner a
// promise the game never kept — the stones ARE the mechanic there.
import test from 'node:test';
import assert from 'node:assert/strict';

// The texture is drawn on a canvas; give the module the minimum to build one.
const ctxStub = new Proxy({}, { get: () => () => {} });
globalThis.document = {
  createElement: () => ({
    width: 0, height: 0,
    getContext: () => ctxStub
  })
};

const { CobblesVisual } = await import('../../js/cobbles-visual.js');
const { COBBLES_LENGTH_M } = await import('../../js/disruptions.js');

const fakeScene = () => ({ children: [], add(o) { this.children.push(o); }, remove(o) {
  const i = this.children.indexOf(o); if (i >= 0) this.children.splice(i, 1);
} });

// A straight road down +z, so the maths is checkable by hand.
const straightRoad = { getPointAtDistance: (d) => ({ x: 0, y: 0, z: d, heading: 0 }) };

test('a cobbled stretch puts a mesh on the road', () => {
  const scene = fakeScene();
  const cv = new CobblesVisual(scene);
  cv.build(straightRoad, [{ startD: 100, endD: 100 + COBBLES_LENGTH_M }]);
  assert.equal(cv.meshes.length, 1);
  assert.equal(scene.children.length, 1);
});

test('the stones span exactly the stretch, and the width of the road', () => {
  const cv = new CobblesVisual(fakeScene());
  cv.build(straightRoad, [{ startD: 100, endD: 132 }]);
  const pos = cv.meshes[0].geometry.attributes.position.array;

  let minZ = Infinity, maxZ = -Infinity, minX = Infinity, maxX = -Infinity;
  for (let i = 0; i < pos.length; i += 3) {
    minX = Math.min(minX, pos[i]); maxX = Math.max(maxX, pos[i]);
    minZ = Math.min(minZ, pos[i + 2]); maxZ = Math.max(maxZ, pos[i + 2]);
  }
  assert.ok(Math.abs(minZ - 100) < 0.01, `starts at 100, got ${minZ}`);
  assert.ok(Math.abs(maxZ - 132) < 0.01, `ends at 132, got ${maxZ}`);
  // Road half width is 2.5 either side of the centre line.
  assert.ok(Math.abs(minX + 2.5) < 0.01 && Math.abs(maxX - 2.5) < 0.01,
    `spans the road, got ${minX}..${maxX}`);
});

test('the stones sit above the road so they cannot z-fight', () => {
  const cv = new CobblesVisual(fakeScene());
  cv.build(straightRoad, [{ startD: 0, endD: 32 }]);
  const pos = cv.meshes[0].geometry.attributes.position.array;
  for (let i = 1; i < pos.length; i += 3) assert.ok(pos[i] > 0, 'lifted off the road surface');
});

test('it follows a curving road rather than cutting the corner', () => {
  // A road that turns: heading changes with distance.
  const curved = { getPointAtDistance: (d) => ({
    x: Math.sin(d / 40) * 40, y: 0, z: Math.cos(d / 40) * 40, heading: -d / 40
  }) };
  const cv = new CobblesVisual(fakeScene());
  cv.build(curved, [{ startD: 0, endD: 32 }]);
  const pos = cv.meshes[0].geometry.attributes.position.array;
  // Every rung should still be ~5 m wide even though the road is turning.
  for (let i = 0; i < pos.length; i += 6) {
    const w = Math.hypot(pos[i] - pos[i + 3], pos[i + 2] - pos[i + 5]);
    assert.ok(Math.abs(w - 5) < 0.05, `rung width ${w.toFixed(3)} should be 5`);
  }
});

test('several stretches in one ride each get their own mesh', () => {
  const scene = fakeScene();
  const cv = new CobblesVisual(scene);
  cv.build(straightRoad, [
    { startD: 100, endD: 132 },
    { startD: 300, endD: 332 },
    { startD: 420, endD: 452 }
  ]);
  assert.equal(cv.meshes.length, 3);
  assert.equal(scene.children.length, 3);
});

test('rebuilding replaces rather than accumulates', () => {
  const scene = fakeScene();
  const cv = new CobblesVisual(scene);
  cv.build(straightRoad, [{ startD: 100, endD: 132 }]);
  cv.build(straightRoad, [{ startD: 200, endD: 232 }]);
  assert.equal(cv.meshes.length, 1, 'the old ride left nothing behind');
  assert.equal(scene.children.length, 1);
});

test('clear takes the stones off the road', () => {
  const scene = fakeScene();
  const cv = new CobblesVisual(scene);
  cv.build(straightRoad, [{ startD: 100, endD: 132 }]);
  cv.clear();
  assert.equal(cv.meshes.length, 0);
  assert.equal(scene.children.length, 0);
});

test('a ride with no cobbles lays nothing, and does not throw', () => {
  const scene = fakeScene();
  const cv = new CobblesVisual(scene);
  assert.doesNotThrow(() => {
    cv.build(straightRoad, []);
    cv.build(null, [{ startD: 0, endD: 32 }]);
    cv.build(straightRoad, [{ startD: 100, endD: 100 }]);   // zero length
    cv.build(straightRoad, [{ startD: 100, endD: 50 }]);    // backwards
  });
  assert.equal(scene.children.length, 0);
});

test('the stones face UP, not down into the ground', () => {
  // Winding decides this: get it backwards and the ribbon is back-face culled
  // AND computeVertexNormals lights it from underneath. It renders as nothing
  // at all, which is exactly how this shipped the first time.
  const cv = new CobblesVisual(fakeScene());
  cv.build(straightRoad, [{ startD: 0, endD: 32 }]);
  const normals = cv.meshes[0].geometry.attributes.normal.array;
  for (let i = 1; i < normals.length; i += 3) {
    assert.ok(normals[i] > 0.9, `normal ${i / 3} points down (y=${normals[i]})`);
  }
});
