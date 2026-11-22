// Analytics bodies have a size limit, checked before anything parses them. The limit must
// leave room for everything the game really sends, including a long ride's single batch.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { ANALYTICS_BODY_MAX, ANALYTICS_RIDE_EVENTS_MAX, analyticsBodyLimit, readBodyLimited } from '../../worker/leaderboard.js';

const SID = '11111111-2222-4333-8444-555555555555';
const RID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const noDb = {
  prepare: () => { const s = { bind: () => s, run: async () => ({}), first: async () => null, all: async () => ({ results: [] }) }; return s; },
  batch: async () => [],
};
const env = () => ({ DB: noDb, CORS_ORIGIN: '*' });
const send = (p, body, method = 'POST') => worker.fetch(new Request('https://api.test' + p, {
  method, headers: { 'Content-Type': 'text/plain', 'CF-Connecting-IP': '1.2.3.4' }, body,
}), env(), { waitUntil() {} });

/** A body with no declared length, arriving in pieces. */
function streamed(size) {
  const piece = new Uint8Array(1024).fill(0x20);
  let left = size;
  const stream = new ReadableStream({
    pull(c) {
      if (left <= 0) { c.close(); return; }
      c.enqueue(piece.slice(0, Math.min(left, 1024)));
      left -= 1024;
    },
  });
  return new Request('https://api.test/api/analytics/session', { method: 'POST', body: stream, duplex: 'half' });
}

test('a body over the limit is refused with 413', async () => {
  const big = JSON.stringify({ id: SID, referrer: 'x'.repeat(ANALYTICS_BODY_MAX) });
  assert.equal((await send('/api/analytics/session', big)).status, 413);
  assert.equal((await send(`/api/analytics/session/${SID}`, big, 'PUT')).status, 413);
  const huge = JSON.stringify({ events: [{ session_id: SID, event_type: 'x', event_data: 'x'.repeat(ANALYTICS_RIDE_EVENTS_MAX) }] });
  assert.equal((await send('/api/analytics/event/batch', huge)).status, 413);
  assert.equal((await send(`/api/analytics/ride/${RID}/events`, huge)).status, 413);
});

test('the size is counted as it is read, whatever length was declared', async () => {
  assert.equal(await readBodyLimited(streamed(ANALYTICS_BODY_MAX + 1), ANALYTICS_BODY_MAX), null);
  const ok = await readBodyLimited(streamed(ANALYTICS_BODY_MAX), ANALYTICS_BODY_MAX);
  assert.equal(ok.length, ANALYTICS_BODY_MAX);
  const lying = new Request('https://api.test/x', { method: 'POST', body: 'y'.repeat(100), headers: { 'Content-Length': '5' } });
  assert.equal(await readBodyLimited(lying, 50), null);
  const declared = new Request('https://api.test/x', { method: 'POST', body: 'y', headers: { 'Content-Length': '999' } });
  assert.equal(await readBodyLimited(declared, 50), null);
});

test('a body that is not a JSON object gets 400, not a server error', async () => {
  for (const body of ['not json', 'null', '7']) {
    assert.equal((await send('/api/analytics/session', body)).status, 400, body);
  }
});

test('the largest batches the game sends fit', async () => {
  // A UI batch: a busy five seconds, with a long error message in it.
  const uiEvent = { session_id: SID, event_type: 'controller_connect', event_data: { name: 'Steam Controller (2026) Wireless', connection: 'bluetooth' }, page: 'lobby', input_method: 'gamepad_gyro', created_at: '2026-11-22T12:00:00.000Z' };
  const errEvent = { ...uiEvent, event_type: 'js_error', event_data: { message: 'e'.repeat(2000), source: 'game.js', line: 12345, col: 67 } };
  const ui = JSON.stringify({ events: [...Array(40).fill(uiEvent), errEvent] });
  assert.ok(ui.length < ANALYTICS_BODY_MAX, `UI batch ${ui.length}`);
  assert.equal((await send('/api/analytics/event/batch', ui)).status, 200);

  // A burst of achievements in one five-second batch: the server's limit of 200 events.
  const earned = { session_id: SID, event_type: 'achievement_earned', event_data: { achievement_id: 'some_long_achievement_id', ride_id: RID }, page: 'victory', input_method: 'gamepad_gyro', created_at: '2026-11-22T12:00:00.000Z' };
  const burst = JSON.stringify({ events: Array(200).fill(earned) });
  assert.ok(burst.length > ANALYTICS_BODY_MAX && burst.length < ANALYTICS_RIDE_EVENTS_MAX, `burst ${burst.length}`);
  assert.equal((await send('/api/analytics/event/batch', burst)).status, 200);

  // A long ride: the server's limit of 200 events, all sent together when it ends.
  const rideEvent = { event_type: 'collectible', distance: 12345.678901234567, event_data: { type: 'token', value: 10, total: 123, combo: 4 }, created_at: '2026-11-22T12:00:00.000Z' };
  const ride = JSON.stringify({ events: Array(200).fill(rideEvent) });
  assert.ok(ride.length > ANALYTICS_BODY_MAX, 'this batch is why rides have their own limit');
  assert.ok(ride.length < ANALYTICS_RIDE_EVENTS_MAX, `ride batch ${ride.length}`);
  assert.equal(analyticsBodyLimit(`/api/analytics/ride/${RID}/events`), ANALYTICS_RIDE_EVENTS_MAX);
  assert.equal((await send(`/api/analytics/ride/${RID}/events`, ride)).status, 200);

  // A ride's start with four signed-in seats (each carries its own token).
  const token = 'a'.repeat(600);
  const start = JSON.stringify({
    id: RID, session_id: SID, level: 'grandma', role: 'captain', difficulty: 'adventurous',
    seats: [1, 2, 3, 4].map((seat) => ({ seat, role: 'captain', team: 'A', input_type: 'gamepad', controller: 'Steam Controller', account_token: token })),
  });
  assert.ok(start.length < ANALYTICS_BODY_MAX, `ride start ${start.length}`);
});

test('only the two event batches get the larger limit', () => {
  assert.equal(analyticsBodyLimit('/api/analytics/session'), ANALYTICS_BODY_MAX);
  assert.equal(analyticsBodyLimit('/api/analytics/event/batch'), ANALYTICS_RIDE_EVENTS_MAX);
  assert.equal(analyticsBodyLimit('/api/analytics/conversion'), ANALYTICS_BODY_MAX);
  assert.equal(analyticsBodyLimit(`/api/analytics/ride/${RID}`), ANALYTICS_BODY_MAX);
});
