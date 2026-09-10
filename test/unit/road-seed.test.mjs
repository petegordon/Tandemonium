// B-4 · the legacy world must not move, and a new seed must build a new world.
//
// road-path.js imports three, which needs no DOM but is a large module; it
// loads fine under node. This test is the regression lock the reseed work
// hangs on: if these numbers change, every player's memory of Grandma's is
// wrong and every stored best is against a road that no longer exists.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoadPath } from '../../js/road-path.js';
import { deriveSeed, SALT } from '../../js/daily-seed.js';

// Captured from main before any seed plumbing existed.
const GOLDEN_42 = [
  { d: 0,    x: 0,       y: 0,      z: 0,        heading: 0 },
  { d: 500,  x: 177.983, y: 1.341,  z: 29.348,   heading: 2.5481 },
  { d: 900,  x: 341.07,  y: -0.004, z: -298.714, heading: 3.6164 },
  { d: 1199, x: 0.01,    y: 0,      z: -0.763,   heading: -0.0265 }
];

// `+0` and `-0` are the same road; JSON round-tripping is what makes them
// differ, so normalise before comparing.
const r = (n, places) => { const v = +n.toFixed(places); return v === 0 ? 0 : v; };
const at = (path, d) => {
  const pt = path.getPointAtDistance(d);
  return { d, x: r(pt.x, 3), y: r(pt.y, 3), z: r(pt.z, 3), heading: r(pt.heading, 4) };
};

test('the legacy road (seed 42) is exactly where it has always been', () => {
  const path = new RoadPath(42);
  for (const g of GOLDEN_42) assert.deepEqual(at(path, g.d), g);
});

test('the loop still closes on itself', () => {
  const path = new RoadPath(42);
  const start = path.getPointAtDistance(0);
  const end = path.getPointAtDistance(path.loopLength - 1);
  assert.ok(Math.hypot(end.x - start.x, end.z - start.z) < 2,
    'the road must return to the start line');
});

test('a different seed is a different road', () => {
  const a = new RoadPath(42);
  const b = new RoadPath(deriveSeed(seedOfDay(), SALT.road));
  const pa = a.getPointAtDistance(500);
  const pb = b.getPointAtDistance(500);
  assert.ok(Math.hypot(pa.x - pb.x, pa.z - pb.z) > 5, 'seeds must actually diverge');
});

test('the same seed twice is the same road', () => {
  const s = deriveSeed(seedOfDay(), SALT.road);
  const a = new RoadPath(s);
  const b = new RoadPath(s);
  for (const d of [0, 137, 640, 1100]) assert.deepEqual(at(a, d), at(b, d));
});

test('every seeded road still closes its loop', () => {
  for (const key of ['2026-09-08', '2026-12-25', '2027-02-14']) {
    const path = new RoadPath(deriveSeed(hash(key), SALT.road));
    const start = path.getPointAtDistance(0);
    const end = path.getPointAtDistance(path.loopLength - 1);
    assert.ok(Math.hypot(end.x - start.x, end.z - start.z) < 2, `${key} does not close`);
  }
});

function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0) || 1;
}
function seedOfDay() { return hash('2026-09-08'); }
