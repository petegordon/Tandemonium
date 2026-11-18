// #612 item 5 · players 2–4 sign in from the Wardrobe: per-seat sessions,
// remembered by controller serial on Steam, session-only otherwise; and the
// achievements a signed-in seat earns from a shared ride.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SeatAccounts, rememberable } from '../../js/seat-accounts.js';
import { SeatAchievements } from '../../js/seat-achievements.js';

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (sub, ttl = 3600) => `${b64({ alg: 'HS256' })}.${b64({ sub, exp: Math.floor(Date.now() / 1000) + ttl })}.sig`;
function memStore(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m };
}

/** A fake API: begin hands out a code; poll answers pending, then done as `user`. */
function fakeApi(user, { pendingPolls = 1 } = {}) {
  let polls = 0;
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init });
    const path = new URL(url).pathname;
    if (path === '/auth/discord/begin') return Response.json({ id: 'r1', secret: 's1', code: 'K7QF', url: 'https://api.test/auth/discord/go?r=r1', expires_in: 600 });
    if (path === '/auth/poll') {
      polls++;
      if (polls <= pendingPolls) return Response.json({ status: 'pending' });
      return Response.json({ status: 'done', token: jwt(user.id), user });
    }
    return Response.json({}, { status: 404 });
  };
  f.calls = calls;
  return f;
}
const SAM = { id: 42, name: 'Sam', avatar: 'https://cdn.discordapp.com/a.png', identities: { discord: { name: 'Sam', avatar: 'https://cdn.discordapp.com/a.png' } } };

async function signInFully(seats, n, t) {
  const dev = await seats.startSignIn(n);
  assert.equal(dev.code, 'K7QF');
  assert.ok(seats.pending(n));
  for (let i = 0; i < 4 && !seats.get(n); i++) t.mock.timers.tick(2000), await new Promise((r) => setImmediate(r)), await new Promise((r) => setImmediate(r));
}

test('a seat signs in with a device code; Player 1 is never touched; the begin is never a link', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const api = fakeApi(SAM);
  const seats = new SeatAccounts({ store: memStore(), fetchImpl: api, apiBase: 'https://api.test' });
  const changes = [];
  seats.onChange((n) => changes.push(n));
  seats.bindSeat(2, 'serial:AA:BB');
  await signInFully(seats, 2, t);
  assert.equal(seats.get(2).user.name, 'Sam');
  assert.equal(seats.pending(2), null);
  assert.ok(changes.includes(2));
  const begin = api.calls.find((c) => c.url.endsWith('/auth/discord/begin'));
  assert.equal(begin.init.headers.Authorization, undefined, 'a seat sign-in carries no session, so it can never link into Player 1');
  assert.deepEqual(Object.keys(seats.tokens([2, 3])), ['2']);
});

test('remembered by controller serial across launches; a browser pad key lasts the session', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const store = memStore();
  const a = new SeatAccounts({ store, fetchImpl: fakeApi(SAM), apiBase: 'https://api.test' });
  a.bindSeat(2, 'serial:AA:BB');
  await signInFully(a, 2, t);
  a.bindSeat(3, 'pad:054c:0ce6:P3');
  await signInFully(a, 3, t);   // the same person on seat 3 moves there
  assert.equal(a.get(3).user.name, 'Sam');
  assert.equal(a.get(2), null, 'one account on one seat');

  const b = new SeatAccounts({ store, fetchImpl: fakeApi(SAM), apiBase: 'https://api.test' });
  b.bindSeat(3, 'pad:054c:0ce6:P3');
  assert.equal(b.get(3), null, 'a vendor:product key is not remembered');

  const c = new SeatAccounts({ store, fetchImpl: fakeApi(SAM), apiBase: 'https://api.test' });
  c.bindSeat(2, 'serial:AA:BB');
  await signInFully(c, 2, t);
  const d = new SeatAccounts({ store, fetchImpl: fakeApi(SAM), apiBase: 'https://api.test' });
  d.bindSeat(4, 'serial:AA:BB');
  assert.equal(d.get(4).user.name, 'Sam', 'the DualSense remembers Sam, whichever seat it sits in');
  d.signOut(4);
  const e = new SeatAccounts({ store, fetchImpl: fakeApi(SAM), apiBase: 'https://api.test' });
  e.bindSeat(2, 'serial:AA:BB');
  assert.equal(e.get(2), null, 'Not me forgets it for good');
  assert.ok(rememberable('serial:x') && !rememberable('pad:054c:0ce6:P2') && !rememberable('keyboard'));
});

test('an expired token is dropped; cancel stops the poll', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const store = memStore({ tandemonium_seat_accounts: JSON.stringify({ 'serial:OLD': { token: jwt(9, -10), user: { id: 9, name: 'Old' } } }) });
  const seats = new SeatAccounts({ store, fetchImpl: fakeApi(SAM, { pendingPolls: 99 }), apiBase: 'https://api.test' });
  seats.bindSeat(2, 'serial:OLD');
  assert.equal(seats.get(2), null);
  await seats.startSignIn(2);
  seats.cancel(2);
  assert.equal(seats.pending(2), null);
});

test('a signed-in seat earns its own achievements from a ride, once', () => {
  const store = memStore();
  const sa = new SeatAchievements({ store });
  const ride = { finishedLevel: 'grandma', distance: 1200, raceDistance: 1200, crashes: 1, isCoop: true, isMultiplayer: true, partnerKey: '7', timeMs: 200000 };
  const first = sa.finish(42, ride, { today: '2026-11-06' }).map((a) => a.id);
  assert.ok(first.includes('first_finish'), first.join());
  assert.ok(first.includes('first_pedal'));
  assert.ok(first.includes('first_crash'));
  const again = sa.finish(42, ride, { today: '2026-11-06' }).map((a) => a.id);
  assert.ok(!again.includes('first_finish'), 'never twice');
  // What the account already has on the server is not awarded again on a new device.
  const other = new SeatAchievements({ store: memStore() });
  other.mergeEarned(42, ['first_finish', 'first_pedal']);
  const fresh = other.finish(42, ride, { today: '2026-11-06' }).map((a) => a.id);
  assert.ok(!fresh.includes('first_finish') && !fresh.includes('first_pedal'));
  // Each account keeps its own.
  assert.ok(sa.finish(77, ride, { today: '2026-11-06' }).some((a) => a.id === 'first_finish'));
});
