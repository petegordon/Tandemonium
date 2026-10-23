// #400 · Map Tourist: one address is an open-world ride around it; a second
// address makes it a route that starts at the first and faces the second.
import test from 'node:test';
import assert from 'node:assert/strict';
import { planExplore, planRoute, shortPlace, headingForBearing } from '../../js/tourist-route.js';
import { RoomProtocol } from '../../js/lobby/room-protocol.js';

const HOME = { lat: 39.9451, lon: -82.7905, label: '7958 Norman St, Pickerington, OH 43147, USA' };
const CBUS = { lat: 39.9612, lon: -82.9988, label: 'Columbus, OH, USA' };

test('one address plans an open-world ride around it, with no destination', () => {
  const p = planExplore(HOME);
  assert.equal(p.explore, true);
  assert.equal(p.from, HOME);
  assert.equal(p.to, null);
  assert.equal(p.route.ridableM, 0);
  assert.equal(p.headline, 'Exploring 7958 Norman St');
});

test('a short place name is the first part of the address', () => {
  assert.equal(shortPlace('Columbus, OH, USA'), 'Columbus');
  assert.equal(shortPlace(''), 'here');
  assert.equal(shortPlace(undefined), 'here');
});

test('a route starts at the FIRST address and is not an explore plan', () => {
  const p = planRoute(HOME, CBUS);
  assert.equal(p.from, HOME);
  assert.ok(!p.explore);
  assert.ok(p.realM > 15000 && p.realM < 20000, `~17 km, got ${p.realM}`);
});

test('bearing → bike heading in the tiles frame (+Z north, +X west, forward = (sin h, cos h))', () => {
  const fwd = (deg) => { const h = headingForBearing(deg); return { x: Math.sin(h), z: Math.cos(h) }; };
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  const north = fwd(0), east = fwd(90), south = fwd(180), west = fwd(270);
  assert.ok(near(north.z, 1) && near(north.x, 0), 'north is +Z');
  assert.ok(near(east.x, -1) && near(east.z, 0), 'east is -X');
  assert.ok(near(south.z, -1), 'south is -Z');
  assert.ok(near(west.x, 1), 'west is +X');
  // Columbus is due-ish WEST of Pickerington: the bike should face +X.
  assert.ok(fwd(planRoute(HOME, CBUS).bearing).x > 0.9);
});

test('co-op: an open-world plan travels with to = null and rebuilds the same', () => {
  const wire = JSON.parse(JSON.stringify(RoomProtocol.touristPlan(HOME, null)));
  assert.equal(wire.to, null);
  const theirs = planExplore(wire.from);
  assert.equal(theirs.headline, planExplore(HOME).headline);
});
