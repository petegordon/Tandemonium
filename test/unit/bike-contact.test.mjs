// #837 / #839 · versus bikes: one contact shape, and bots that keep to their team's side.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bikeContact, BIKE_CONTACT_RADIUS } from '../../js/versus/bike-contact.js';
import { botLean } from '../../js/versus/bot-pace.js';

const bike = (x, z, heading = 0, contactLength = 4.4) => ({ position: { x, z }, heading, contactLength });

test('side by side: bikes touch only when their widths meet', () => {
  assert.equal(bikeContact(bike(0, 0), bike(2.2, 0)).touching, false, 'the two starting lanes are clear');
  assert.equal(bikeContact(bike(0, 0), bike(BIKE_CONTACT_RADIUS * 2 + 0.01, 0)).touching, false);
  const c = bikeContact(bike(0, 0), bike(0.5, 0));
  assert.equal(c.touching, true);
  assert.ok(Math.abs(c.overlap - 0.4) < 1e-9);
  assert.ok(Math.abs(c.nx + 1) < 1e-9, 'pushes the first bike away from the second');
});

test('nose to tail follows each bike\'s real length', () => {
  assert.equal(bikeContact(bike(0, 0), bike(0, 4.5)).touching, false, 'two 4.4 m tandems');
  assert.equal(bikeContact(bike(0, 0, 0, 5.63), bike(0, 4.5, 0, 5.63)).touching, true, 'two 5.63 m Solo Flights');
});

test('a bike across another touches anywhere along its length, up to its nose', () => {
  for (const z of [0, 0.7, 1.0, 1.75, 2.6]) assert.equal(bikeContact(bike(0, 0), bike(0, z, Math.PI / 2)).touching, true, `at ${z} m`);
  assert.equal(bikeContact(bike(0, 0), bike(0, 2.7, Math.PI / 2)).touching, false);
});

test('the same result whichever bike is first', () => {
  const p = bike(0.2, 1.1, 0.3), q = bike(0.5, -0.8, -0.2, 5.63);
  const a = bikeContact(p, q), b = bikeContact(q, p);
  assert.equal(a.touching, b.touching);
  assert.ok(Math.abs(a.overlap - b.overlap) < 1e-9);
  assert.ok(Math.abs(a.nx + b.nx) < 1e-9 && Math.abs(a.nz + b.nz) < 1e-9);
});

test('a bot steers toward its team\'s lane, not the road centre', () => {
  const rider = (lateral) => ({ speed: 8, roadD: 10, heading: 0, lean: 0, leanVelocity: 0, distanceTraveled: 10,
    _lateralOffset: lateral, position: { x: lateral, z: 10 }, roadPath: { getPointAtDistance: () => ({ heading: 0 }) } });
  const tune = { turnRate: 0.5, leanForce: 8 };
  assert.ok(Math.abs(botLean(rider(1.1), tune, [], 1.1)) < 1e-9, 'on its lane: no steering');
  assert.notEqual(botLean(rider(1.1), tune, [], 0), 0, 'the same spot is off the centre line');
  assert.ok(botLean(rider(0), tune, [], 1.1) * botLean(rider(2), tune, [], 1.1) < 0, 'steers back from either side');
});
