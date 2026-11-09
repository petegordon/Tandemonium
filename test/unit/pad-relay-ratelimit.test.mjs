// DB-04 · the pad relay's rate limits: the same two rules as the API
// (wrangler-pad.toml): 30 connects a minute per seat of a room, 300 a minute
// per IP. Drives the Worker's own fetch handler (worker/pad-relay.js) with
// counting stand-ins for the bindings and a stand-in Durable Object namespace
// that counts what reaches it.
import test from 'node:test';
import assert from 'node:assert/strict';
import relay from '../../worker/pad-relay.js';

/** A fixed-window limiter like Cloudflare's: `limit` per key until reset(). */
function countingLimiter(limit = 30) {
  const seen = new Map();
  return {
    async limit({ key }) { const n = (seen.get(key) || 0) + 1; seen.set(key, n); return { success: n <= limit }; },
    reset() { seen.clear(); },
  };
}

/** PAD_ROOM stand-in: counts requests that got past the limiter. */
function roomNamespace() {
  const ns = { reached: 0, codes: new Set() };
  ns.idFromName = (code) => code;
  ns.get = (id) => ({ fetch: async () => { ns.reached++; ns.codes.add(id); return new Response('room', { status: 200 }); } });
  return ns;
}

let codeN = 0;
const freshCode = () => {
  // Valid pad codes: the relay's own alphabet check decides; derive codes from a
  // known-good one by cycling its letters.
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let n = codeN++, s = '';
  for (let i = 0; i < 6; i++) { s += A[n % A.length]; n = Math.floor(n / A.length); }
  return s;
};
const padReq = (ip, code = freshCode(), role = 'host') => new Request(`https://relay.test/pad?code=${code}&role=${role}`, {
  headers: ip ? { 'CF-Connecting-IP': ip } : {},
});

const envFor = (ip = countingLimiter(300), player = countingLimiter(30)) => ({ PAD_IP_LIMITER: ip, PAD_PLAYER_LIMITER: player, PAD_ROOM: roomNamespace() });

test('a script opening rooms from one IP is cut off after 300 a minute; nothing past it reaches a room', async () => {
  const env = envFor();
  const statuses = [];
  for (let i = 0; i < 320; i++) statuses.push((await relay.fetch(padReq('203.0.113.7'), env)).status);
  assert.equal(statuses.filter((s) => s === 200).length, 300, 'exactly the IP limit gets through');
  assert.ok(statuses.slice(300).every((s) => s === 429), 'the rest of the flood is refused with 429');
  assert.equal(env.PAD_ROOM.reached, 300, 'a refused request never touches the Durable Object (no DO request or storage)');
});

test('a venue: 20 games and 60 phones on one IP, each connecting a few times, all get in', async () => {
  const env = envFor();
  const statuses = [];
  for (let g = 0; g < 20; g++) {
    const code = freshCode();
    for (let k = 0; k < 3; k++) statuses.push((await relay.fetch(padReq('192.0.2.50', code, 'host'), env)).status);
    for (const seat of ['pad-2', 'pad-3', 'pad-4']) for (let k = 0; k < 3; k++) statuses.push((await relay.fetch(padReq('192.0.2.50', code, seat), env)).status);
  }
  assert.equal(statuses.length, 240);
  assert.ok(statuses.every((s) => s === 200), 'nobody refused');
});

test("one seat redialling in a loop is cut off after 30 a minute; the room's other seats are not", async () => {
  const env = envFor();
  const code = freshCode();
  const statuses = [];
  for (let i = 0; i < 31; i++) statuses.push((await relay.fetch(padReq('192.0.2.10', code, 'pad-2'), env)).status);
  assert.equal(statuses.filter((s) => s === 429).length, 1, 'the 31st redial is refused');
  assert.equal((await relay.fetch(padReq('192.0.2.10', code, 'host'), env)).status, 200, 'the game in the same room still connects');
});

test('the flood does not lock out anyone else', async () => {
  const env = envFor();
  for (let i = 0; i < 310; i++) await relay.fetch(padReq('203.0.113.7'), env);
  assert.equal((await relay.fetch(padReq('198.51.100.2'), env)).status, 200, 'a player on another IP still gets a room');
});

test('after the window resets, the same IP is let in again', async () => {
  const ip = countingLimiter(300);
  const env = envFor(ip);
  for (let i = 0; i < 305; i++) await relay.fetch(padReq('203.0.113.9'), env);
  assert.equal((await relay.fetch(padReq('203.0.113.9'), env)).status, 429);
  ip.reset();   // the minute is up
  assert.equal((await relay.fetch(padReq('203.0.113.9'), env)).status, 200);
});

test('a bad code is refused before the limiters count it', async () => {
  let counted = 0;
  const counter = { limit: async () => { counted++; return { success: true }; } };
  const env = { PAD_IP_LIMITER: counter, PAD_PLAYER_LIMITER: counter, PAD_ROOM: roomNamespace() };
  const res = await relay.fetch(new Request('https://relay.test/pad?code=!!&role=host', { headers: { 'CF-Connecting-IP': '203.0.113.7' } }), env);
  assert.equal(res.status, 400);
  assert.equal(counted, 0);
});
