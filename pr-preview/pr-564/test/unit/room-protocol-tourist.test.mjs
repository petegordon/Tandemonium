// #400 · co-op Tourist: only the two end points travel, and the stoker's
// rebuilt route is the captain's route.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomProtocol, ROOM_MSG } from '../../js/lobby/room-protocol.js';
import { planRoute } from '../../js/tourist-route.js';

const from = { lat: 39.9612, lon: -82.9988, label: 'Columbus, OH', extra: 'not sent' };
const to = { lat: 39.7392, lon: -104.9903, label: 'Denver, CO' };

test('touristPlan carries only lat/lon/label for each end', () => {
  const m = RoomProtocol.touristPlan(from, to);
  assert.equal(m.type, ROOM_MSG.TOURIST_PLAN);
  assert.deepEqual(m.from, { lat: 39.9612, lon: -82.9988, label: 'Columbus, OH' });
  assert.deepEqual(m.to, { lat: 39.7392, lon: -104.9903, label: 'Denver, CO' });
});

test('the stoker rebuilds the same plan from the wire message', () => {
  const wire = JSON.parse(JSON.stringify(RoomProtocol.touristPlan(from, to)));
  const mine = planRoute(from, to);
  const theirs = planRoute(wire.from, wire.to);
  assert.equal(theirs.headline, mine.headline);
  assert.equal(theirs.route.ridableM, mine.route.ridableM);
  assert.equal(theirs.realM, mine.realM);
});

test('startRide is flagged only for a Tourist ride; ordinary starts are unchanged', () => {
  assert.deepEqual(RoomProtocol.startRide(7, null), { type: ROOM_MSG.START_RIDE, placementSalt: 7, worldSeed: null });
  assert.equal(RoomProtocol.startRide(7, null, true).tourist, true);
});

test('touristReady is a boolean either way', () => {
  assert.deepEqual(RoomProtocol.touristReady(1), { type: ROOM_MSG.TOURIST_READY, ok: true });
  assert.deepEqual(RoomProtocol.touristReady(undefined), { type: ROOM_MSG.TOURIST_READY, ok: false });
});
