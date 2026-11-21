// #802 · arriving somewhere in Map Tourist: from the finish swing's pose in front of the bike, the
// camera rises into the sky while it pans round the place (Pete, 2026-11-18).
import test from 'node:test';
import assert from 'node:assert/strict';
import { ARRIVAL, arrivalPose, ArrivalOrbit, chooseArrivalEnd, openFraction, arrivalEndFromView } from '../../js/tourist-arrival.js';

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

// Pete, 2026-11-18: "If the camera is too close need to modify its positioning relative to the end."
test('with nothing in the way the rise ends where it always did', () => {
  const end = chooseArrivalEnd({ x: 0, y: 0, z: 0 }, { angle: 0.3, radius: 8, height: 2, dir: 1 }, () => null);
  assert.deepEqual([end.dir, end.sweep, end.endHeight, end.open], [1, ARRIVAL.sweeps[0], ARRIVAL.heights[0], 1]);
  assert.equal(chooseArrivalEnd({ x: 0, y: 0, z: 0 }, { angle: 0, radius: 8, height: 2, dir: -1 }, null).dir, -1);
});

test('a tower where the rise would end sends the camera to an open side instead', () => {
  const place = { x: 0, y: 0, z: 0 };
  const start = { angle: 0, radius: 8, height: 2, dir: 1 };
  // a tall wall across the usual end: everything at angles within 0.9 rad of it is blocked 15 m out
  const usual = start.angle + ARRIVAL.sweeps[0];
  const clear = (from, to) => {
    const a = Math.atan2(to.x - from.x, to.z - from.z);
    const off = Math.abs(Math.atan2(Math.sin(a - usual), Math.cos(a - usual)));
    return off < 0.9 ? 15 : null;
  };
  assert.ok(openFraction(place, { angle: usual, radius: ARRIVAL.endRadius, height: 80 }, clear) < 0.15, "the usual end is too close");
  const end = chooseArrivalEnd(place, start, clear);
  assert.ok(end.open > 0.9, "an open end was found (" + end.open.toFixed(2) + ")");
  const cam = camera(0, 2, 8);
  const orbit = new ArrivalOrbit(cam, place, { x: 0, y: 0.4, z: 4 }, { clear });
  for (let i = 0; i < 600; i++) orbit.update(1 / 60);
  assert.ok(Math.hypot(cam.position.x, cam.position.z) > ARRIVAL.endRadius - 1, "and the camera ends at its full distance (" + Math.hypot(cam.position.x, cam.position.z).toFixed(0) + " m)");
});

test('when every side is blocked low down, it ends higher', () => {
  const place = { x: 0, y: 0, z: 0 };
  // a canyon: the view is blocked 20 m out unless the camera is over 100 m up
  const clear = (from, to) => (to.y - place.y > 100 ? null : 20);
  const end = chooseArrivalEnd(place, { angle: 0, radius: 8, height: 2, dir: 1 }, clear);
  assert.equal(end.endHeight, ARRIVAL.heights[1]);
  assert.equal(end.open, 1);
});

test('a slightly better view is not worth leaving the usual end for', () => {
  const usualAngle = ARRIVAL.sweeps[0];
  const clear = (from, to) => { const a = Math.atan2(to.x - from.x, to.z - from.z); const full = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z); return Math.abs(Math.atan2(Math.sin(a - usualAngle), Math.cos(a - usualAngle))) < 0.2 ? full * 0.95 : null; };
  const end = chooseArrivalEnd({ x: 0, y: 0, z: 0 }, { angle: 0, radius: 8, height: 2, dir: 1 }, clear);
  assert.equal(end.sweep, ARRIVAL.sweeps[0]);
});

test('an end with cables right beside the camera loses to one in clear air', () => {
  const place = { x: 0, y: 0, z: 0 };
  const start = { angle: 0, radius: 8, height: 2, dir: 1 };
  const usual = start.angle + ARRIVAL.sweeps[0];
  const usualAt = { x: Math.sin(usual) * ARRIVAL.endRadius, z: Math.cos(usual) * ARRIVAL.endRadius };
  // the place can be seen from everywhere, but near the usual end there is something 3 m from the camera
  const clear = (from) => (Math.hypot(from.x - usualAt.x, from.z - usualAt.z) < 40 ? 3 : null);
  const end = chooseArrivalEnd(place, start, clear);
  const at = { x: Math.sin(start.angle + end.dir * end.sweep) * ARRIVAL.endRadius, z: Math.cos(start.angle + end.dir * end.sweep) * ARRIVAL.endRadius };
  assert.ok(Math.hypot(at.x - usualAt.x, at.z - usualAt.z) >= 40, "it ends somewhere else");
  assert.equal(end.open, 1);
});

test('a place with a view of its own sends the camera there, whatever is in the way', () => {
  const place = { x: 0, y: 0, z: 0 };
  const view = { bearing: 90, radius: 260, height: 70, look: 40 };       // due east of the place
  const cam = camera(1, 2, 8);
  const orbit = new ArrivalOrbit(cam, place, { x: 0, y: 0.4, z: 4 }, { clear: () => 5, view });
  for (let i = 0; i < 600; i++) orbit.update(1 / 60);
  // +x is WEST in the tiles' frame, so east of the place is -x
  assert.ok(Math.abs(cam.position.x + 260) < 1 && Math.abs(cam.position.z) < 1, "due east, 260 m out (" + cam.position.x.toFixed(0) + ", " + cam.position.z.toFixed(0) + ")");
  assert.ok(Math.abs(cam.position.y - 70) < 0.01);
  assert.deepEqual(cam.looked, { x: 0, y: 40, z: 0 });
});

test('a view right beside where the camera starts is reached the long way round, not with no pan at all', () => {
  const end = arrivalEndFromView({ bearing: -10 }, { angle: 0, radius: 8, height: 2, dir: 1 });
  assert.ok(end.sweep > Math.PI * 1.5, "sweep " + end.sweep.toFixed(2));
  assert.equal(arrivalEndFromView(null, { angle: 0 }), null);
  assert.equal(arrivalEndFromView({ radius: 5 }, { angle: 0 }), null);
});
