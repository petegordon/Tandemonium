// Where is the rider? — the closest-point search that answers it.
//
// The road is a CLOSED 1200 m loop and a ride is the first 500 m of it, so the
// closure spline comes back past the start line and, on some seeds, runs within
// ~27 m of the road the rider is on. getClosestRoadInfo therefore has two
// plausible answers near the start, and picking the wrong one is not a cosmetic
// error: bike-model derives distanceTraveled from it, so the ride's progress
// collapses, the checkpoint the rider just rode under never registers, and the
// segment timer runs out on a rider who was doing everything right.
//
// The old coarse search measured its window from `bestD`, which it reassigned
// as it went — so the window walked down the incoming leg instead of scanning
// around the hint. 16 of 30 consecutive daily roads broke inside the ride.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoadPath } from '../../js/road-path.js';
import { dailyKey, seedFromKey, deriveSeed, SALT } from '../../js/daily-seed.js';

/** Ride the centreline and report the first place tracking jumps branch. */
function firstBranchJump(path, { lateral = 0, rideDistance = 500 } = {}) {
  let hint = 0;
  for (let d = 0; d <= rideDistance; d += 0.5) {
    const p = path.getPointAtDistance(d);
    const rx = Math.cos(p.heading), rz = -Math.sin(p.heading);
    const info = path.getClosestRoadInfo(p.x + rx * lateral, p.z + rz * lateral, hint);
    let err = info.d - d;
    if (err > 600) err -= 1200;
    if (err < -600) err += 1200;
    if (Math.abs(err) > 5) return { d, err };
    hint = info.d;
  }
  return null;
}

test('tracking survives the loop seam on every daily road for two months', () => {
  const start = Date.UTC(2026, 8, 10);
  const broken = [];
  for (let i = 0; i < 60; i++) {
    const key = dailyKey(new Date(start + i * 86400000));
    const path = new RoadPath(deriveSeed(seedFromKey(key), SALT.road));
    const jump = firstBranchJump(path);
    if (jump) broken.push(`${key} at ${jump.d}m (off by ${jump.err.toFixed(0)}m)`);
  }
  assert.deepEqual(broken, [], 'these roads put the rider on the wrong leg of the loop');
});

test('tracking survives it from anywhere across the road, not just the centre', () => {
  // A rider steers by leaning and is almost never on the centreline.
  const path = new RoadPath(deriveSeed(seedFromKey('2026-09-10'), SALT.road));
  for (const lateral of [-2.5, -1, 0, 1, 2.5]) {
    assert.equal(firstBranchJump(path, { lateral }), null,
      `lost the rider at ${lateral} m off centre`);
  }
});

test('the search window is centred on the hint, not dragged along by it', () => {
  // The direct statement of the bug: ask about a point on the road, from a hint
  // 20 m behind it, and the answer must be that point — never one 90 m away.
  const path = new RoadPath(deriveSeed(seedFromKey('2026-09-10'), SALT.road));
  for (let d = 5; d <= 120; d += 5) {
    const p = path.getPointAtDistance(d);
    const info = path.getClosestRoadInfo(p.x, p.z, Math.max(0, d - 20));
    assert.ok(Math.abs(info.d - d) < 1,
      `at ${d} m the search answered ${info.d.toFixed(1)} m`);
  }
});

test('lateral offset is measured against the leg the rider is actually on', () => {
  const path = new RoadPath(deriveSeed(seedFromKey('2026-09-10'), SALT.road));
  for (let d = 5; d <= 120; d += 5) {
    const p = path.getPointAtDistance(d);
    const rx = Math.cos(p.heading), rz = -Math.sin(p.heading);
    const info = path.getClosestRoadInfo(p.x + rx * 2, p.z + rz * 2, d);
    assert.ok(Math.abs(info.lateralOffset - 2) < 0.35,
      `at ${d} m a 2 m offset read as ${info.lateralOffset.toFixed(2)} m`);
  }
});
