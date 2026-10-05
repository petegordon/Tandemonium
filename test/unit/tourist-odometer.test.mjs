// Review B3 · the Map Tourist odometer: a route counts progress along its
// bearing (furthest reached, never negative); open world counts distance
// ridden; a jump over TELEPORT_M is not riding; an outside reset re-bases.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TouristOdometer, TELEPORT_M, OPEN_WORLD_PAY_CAP_M } from '../../js/tourist-odometer.js';
import { headingForBearing, planRoute } from '../../js/tourist-route.js';

const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

/** Ride from (x0,z0) toward heading h at `speed` m/s for `secs`, 60 fps. */
function ride(odo, pos, h, speed, secs, distRef) {
  const dt = 1 / 60;
  for (let t = 0; t < secs; t += dt) {
    pos.x += Math.sin(h) * speed * dt;
    pos.z += Math.cos(h) * speed * dt;
    distRef.d = odo.update(pos.x, pos.z, distRef.d);
  }
  return distRef.d;
}

test('route: riding along the bearing counts every metre', () => {
  const h = headingForBearing(270);      // due west → +X in the tiles frame
  const odo = new TouristOdometer({ heading: h });
  const pos = { x: 0, z: 0 }, ref = { d: 0 };
  odo.update(0, 0, 0);
  const d = ride(odo, pos, h, 8, 10, ref);   // 80 m
  assert.ok(near(d, 80, 0.2), `80 m, got ${d}`);
  assert.ok(pos.x > 79, 'west is +X');
});

test('route: sideways counts nothing, backwards never subtracts, and it never goes negative', () => {
  const h = headingForBearing(0);        // north = +Z
  const odo = new TouristOdometer({ heading: h });
  const pos = { x: 0, z: 0 }, ref = { d: 0 };
  odo.update(0, 0, 0);
  ride(odo, pos, Math.PI, 5, 4, ref);    // 20 m south first
  assert.equal(ref.d, 0, 'riding away from them is not negative progress');
  ride(odo, pos, h, 5, 12, ref);         // back to start and 40 m on
  assert.ok(near(ref.d, 40, 0.2), `max projection 40, got ${ref.d}`);
  const before = ref.d;
  ride(odo, pos, Math.PI / 2, 5, 10, ref);   // 50 m sideways (+X)
  assert.ok(near(ref.d, before, 1e-9), 'sideways adds nothing');
  ride(odo, pos, Math.PI, 5, 4, ref);    // 20 m back
  assert.ok(near(ref.d, before, 1e-9), 'backwards keeps the furthest reached');
});

test('route: arrival — the odometer reaches ridableM, which is the pseudo-level finish', () => {
  const HOME = { lat: 39.9451, lon: -82.7905, label: 'A' };
  const NEAR = { lat: 39.9460, lon: -82.7930, label: 'B' };
  const plan = planRoute(HOME, NEAR);
  const h = headingForBearing(plan.bearing);
  const odo = new TouristOdometer({ heading: h });
  const pos = { x: 0, z: 0 }, ref = { d: 0 };
  odo.update(0, 0, 0);
  const finish = Math.max(50, Math.round(plan.route.ridableM));
  ride(odo, pos, h, 10, finish / 10 + 1, ref);
  assert.ok(ref.d >= finish, `${ref.d} ≥ ${finish}`);
});

test('open world: counts distance ridden in any direction, including circles', () => {
  const odo = new TouristOdometer();
  const pos = { x: 0, z: 0 }, ref = { d: 0 };
  odo.update(0, 0, 0);
  ride(odo, pos, 0, 6, 5, ref);              // 30 m north
  ride(odo, pos, Math.PI, 6, 5, ref);        // 30 m back south
  assert.ok(near(ref.d, 60, 0.5), `60 m ridden, got ${ref.d}`);
});

test('a single-frame jump over TELEPORT_M is not counted, either mode', () => {
  for (const heading of [null, 0]) {
    const odo = new TouristOdometer({ heading });
    let d = odo.update(0, 0, 0);
    d = odo.update(0, 5, d);
    assert.ok(near(d, 5));
    d = odo.update(0, 5 + TELEPORT_M + 1, d);   // teleport
    assert.ok(near(d, 5), `teleport ignored (${heading}), got ${d}`);
    d = odo.update(0, 5 + TELEPORT_M + 3, d);   // riding resumes from there
    assert.ok(near(d, 7), `counts again after, got ${d}`);
  }
});

test('an outside reset of bike.distanceTraveled re-bases the odometer', () => {
  const odo = new TouristOdometer();
  let d = odo.update(0, 0, 0);
  for (let z = 1; z <= 15; z++) d = odo.update(0, z, d);
  assert.ok(near(d, 15));
  // fullReset: position back to the anchor, distance back to 0.
  d = odo.update(0, 0, 0);
  assert.equal(d, 0);
  d = odo.update(0, 3, d);
  assert.ok(near(d, 3));
});

test('bad positions are ignored; the open-world pay cap is 10 km', () => {
  const odo = new TouristOdometer();
  let d = odo.update(0, 0, 0);
  d = odo.update(NaN, 4, d);
  assert.equal(d, 0);
  assert.equal(OPEN_WORLD_PAY_CAP_M, 10000);
});
