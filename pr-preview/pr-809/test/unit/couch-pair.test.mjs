// #609 · local co-op identities: a signed-in couch Player 2 is a real pair
// (their own key, server pair stats); an unsigned Player 2 stays 'local:p2'.
import test from 'node:test';
import assert from 'node:assert/strict';
import { couchPair, guestCaptainSubmit, pairStatsForFinish } from '../../js/couch-pair.js';
import { SeatAccounts } from '../../js/seat-accounts.js';

const SAM = { token: 'tok-sam', user: { id: 42, name: 'Sam' } };

test('who submits and who the pair is with', () => {
  assert.deepEqual(couchPair({ mode: 'local', seatAccount: SAM, p1ServerId: 7, deviceId: 'dev1' }),
    { submitAs: 'p1', withKey: '42', name: 'Sam', p2Id: '42' }, 'P1 signed in: P1 asks about Sam');
  assert.deepEqual(couchPair({ mode: 'local', seatAccount: SAM, p1ServerId: null, deviceId: 'dev1' }),
    { submitAs: 'p2', withKey: 'guest:dev1', name: 'Sam', p2Id: '42' }, "P1 signed out: Sam asks about this device's guest");
  assert.equal(couchPair({ mode: 'local', seatAccount: null, p1ServerId: 7, deviceId: 'dev1' }), null, 'unsigned P2: no server pair');
  assert.equal(couchPair({ mode: 'local', seatAccount: SAM, p1ServerId: 42, deviceId: 'dev1' }), null, 'same account on both seats');
  assert.equal(couchPair({ mode: 'local', seatAccount: SAM, p1ServerId: null, deviceId: null }), null, 'no device id, no guest key');
  for (const mode of ['solo', 'captain', 'stoker', 'versus']) {
    assert.equal(couchPair({ mode, seatAccount: SAM, p1ServerId: 7, deviceId: 'd' }), null, mode);
  }
});

test("P1 signed out: the ride goes up as Sam's stoker ride with P1 as this device's guest", () => {
  const data = { levelId: 'grandma', distance: 1200, timeMs: 200000, seats: [{ token: 'x' }] };
  const pair = couchPair({ mode: 'local', seatAccount: SAM, deviceId: 'dev1' });
  const body = guestCaptainSubmit(data, { captain: { overallPct: 55, userId: 99 }, stoker: { overallPct: 45 } }, pair, 'dev1', ['first_finish']);
  assert.equal(body.mode, 'stoker');
  assert.equal(body.seats, undefined);
  assert.deepEqual(body.newAchievements, ['first_finish']);
  assert.deepEqual(body.contributions, {
    captain: { overallPct: 55, userId: null, guestDeviceId: 'dev1' },
    stoker: { overallPct: 45, userId: 42 },
  });
  assert.equal(data.mode, undefined, 'the input is not changed');
});

test('finish numbers: the pair before this ride, plus this ride when it posts', () => {
  assert.equal(pairStatsForFinish(null, { willPost: true, distanceM: 1200 }), null);
  assert.deepEqual(pairStatsForFinish({ rides: 9, distance: 3800 }, { willPost: true, distanceM: 1200 }), { pairRides: 10, pairDistanceKm: 5 });
  assert.deepEqual(pairStatsForFinish({ rides: 9, distance: 3800 }, { willPost: false, distanceM: 1200 }), { pairRides: 9, pairDistanceKm: 3.8 });
  assert.deepEqual(pairStatsForFinish({}, { willPost: true, distanceM: 500 }), { pairRides: 1, pairDistanceKm: 0.5 });
});

test("a seat's own session asks /pair and posts /score; signed out does nothing", async () => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const tok = `${b64({ alg: 'HS256' })}.${b64({ sub: 42, exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    const p = new URL(url).pathname;
    if (p === '/pair') return Response.json({ rides: 3, distance: 2400 });
    if (p === '/score') return Response.json({ scoreId: 5 });
    return Response.json({}, { status: 404 });
  };
  const seats = new SeatAccounts({ fetchImpl, apiBase: 'https://api.test' });
  assert.equal(await seats.fetchPair(2, 'guest:dev1'), null, 'nobody on seat 2 yet');
  assert.equal(calls.length, 0);
  seats.bindSeat(2, 'pad:a');
  seats._byPad.set('pad:a', { token: tok, user: { id: 42, name: 'Sam' } });
  assert.deepEqual(await seats.fetchPair(2, 'guest:dev1'), { rides: 3, distance: 2400 });
  assert.equal(calls[0].url, 'https://api.test/pair?with=guest%3Adev1');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer ' + tok);
  assert.deepEqual(await seats.submitScore(2, { mode: 'stoker' }), { scoreId: 5 });
  assert.equal(calls[1].init.method, 'POST');
  assert.equal(calls[1].init.headers.Authorization, 'Bearer ' + tok);
  assert.deepEqual(JSON.parse(calls[1].init.body), { mode: 'stoker' });
});
