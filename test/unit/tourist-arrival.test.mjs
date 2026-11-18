// #802 · arriving somewhere in Map Tourist: from the finish swing's pose in front of the bike, the
// camera rises into the sky while it pans round the place (Pete, 2026-11-18).
import test from 'node:test';
import assert from 'node:assert/strict';
import { ARRIVAL, arrivalPose, ArrivalOrbit } from '../../js/tourist-arrival.js';

/** A camera stand-in: a position, and where it was last told to look. */
function camera(x, y, z) {
  return {
    position: { x, y, z, set(a, b, c) { this.x = a; this.y = b; this.z = c; } },
    looked: null,
    lookAt(a, b, c) { this.looked = { x: a, y: b, z: c }; },
  };
}

test('the path starts at the pose it was given and ends high over the place', () => {
  const start = { angle: 0.4, radius: 12, height: 1.5, dir: 1 };
  const a = arrivalPose(0, start), b = arrivalPose(1, start);
  assert.deepEqual([a.angle, a.radius, a.height, a.look], [0.4, 12, 1.5, 0]);
  assert.ok(Math.abs(b.angle - (0.4 + ARRIVAL.sweep)) < 1e-9, 'panned the whole sweep');
  assert.equal(b.radius, ARRIVAL.endRadius);
  assert.equal(b.height, ARRIVAL.endHeight);
  assert.equal(b.look, 1);
  assert.equal(arrivalPose(-1, start).height, 1.5, 'before the start is the start');
  assert.equal(arrivalPose(2, start).height, ARRIVAL.endHeight, 'after the end is the end');
});

test('it only ever goes up and out, and climbs before it widens', () => {
  const start = { angle: 0, radius: 10, height: 2, dir: -1 };
  let prev = arrivalPose(0, start);
  for (let i = 1; i <= 100; i++) {
    const p = arrivalPose(i / 100, start);
    assert.ok(p.height >= prev.height - 1e-9 && p.radius >= prev.radius - 1e-9, `step ${i}`);
    assert.ok(p.angle <= prev.angle + 1e-9, 'dir -1 pans the other way');
    prev = p;
  }
  const mid = arrivalPose(0.3, start);
  const up = (mid.height - 2) / (ARRIVAL.endHeight - 2), out = (mid.radius - 10) / (ARRIVAL.endRadius - 10);
  assert.ok(up > out + 0.2, `at 30% it is ${Math.round(up * 100)}% up and ${Math.round(out * 100)}% out`);
  // by the time it is looking at the place, it is looking at nothing else
  assert.equal(arrivalPose(ARRIVAL.lookBlend, start).look, 1);
});

test('a camera already further out or higher than the end never comes back in or down', () => {
  const p = arrivalPose(1, { angle: 0, radius: 300, height: 200, dir: 1 });
  assert.equal(p.radius, 300);
  assert.equal(p.height, 200);
});

test('the orbit takes the camera from in front of the bike to a view of the place', () => {
  const place = { x: 0, y: -150, z: 100 };
  const bike = { x: 0, y: -149.6, z: 86 };                 // 14 m short of the place
  const cam = camera(2, -148.4, 92);                       // in front of the bike, low
  const orbit = new ArrivalOrbit(cam, place, bike);
  let done = false, steps = 0, maxJump = 0, prev = { ...cam.position };
  while (!done && steps < 2000) {
    done = orbit.update(1 / 60);
    steps++;
    maxJump = Math.max(maxJump, Math.hypot(cam.position.x - prev.x, cam.position.y - prev.y, cam.position.z - prev.z));
    prev = { x: cam.position.x, y: cam.position.y, z: cam.position.z };
  }
  assert.ok(done, 'it ends');
  assert.ok(Math.abs(steps / 60 - ARRIVAL.riseS) < 0.1, `in ${ARRIVAL.riseS} s (${(steps / 60).toFixed(1)})`);
  assert.ok(maxJump < 2, `no jump in the path (largest step ${maxJump.toFixed(2)} m)`);
  assert.ok(Math.abs((cam.position.y - place.y) - ARRIVAL.endHeight) < 0.01, 'at the end height above the place');
  assert.ok(Math.abs(Math.hypot(cam.position.x - place.x, cam.position.z - place.z) - ARRIVAL.endRadius) < 0.5, 'at the end distance');
  assert.deepEqual(cam.looked, { x: place.x, y: place.y + ARRIVAL.lookHeight, z: place.z }, 'looking at the place');
});

test('the first frame looks at the bike, from where the camera already was', () => {
  const place = { x: 50, y: 0, z: 50 };
  const bike = { x: 40, y: 0.4, z: 44 };
  const cam = camera(43, 1.6, 48);
  const orbit = new ArrivalOrbit(cam, place, bike);
  orbit.update(0.001);
  assert.ok(Math.hypot(cam.position.x - 43, cam.position.y - 1.6, cam.position.z - 48) < 0.2, 'no snap away from the swing pose');
  assert.ok(Math.hypot(cam.looked.x - bike.x, cam.looked.z - bike.z) < 0.2, 'still on the bike');
});

test('a building in the way keeps the camera on the near side of it', () => {
  const place = { x: 0, y: 0, z: 0 };
  const cam = camera(0, 2, 10);
  // everything further than 40 m from the place, on the level, is wall
  const clear = (from, to) => {
    const full = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
    const flat = Math.hypot(to.x - from.x, to.z - from.z);
    return flat > 40 ? full * 40 / flat : null;
  };
  const orbit = new ArrivalOrbit(cam, place, { x: 0, y: 0.4, z: 6 }, { clear });
  let far = 0;
  for (let i = 0; i < 600; i++) { orbit.update(1 / 60); far = Math.max(far, Math.hypot(cam.position.x, cam.position.z)); }
  assert.ok(far <= 40, `never past the wall (furthest ${far.toFixed(1)} m)`);
  assert.ok(far > 25, 'but it did move out toward it');
  assert.ok(Math.abs(cam.position.y - ARRIVAL.endHeight) < 0.01, 'and it still rose');
});
