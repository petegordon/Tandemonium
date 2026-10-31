// DB-04 · the pad relay's IP rate limit refuses a scripted room flood.
// Drives the Worker's own fetch handler (worker/pad-relay.js) with a counting
// stand-in for the PAD_LIMITER binding (wrangler-pad.toml: 30 a minute per IP)
// and a stand-in Durable Object namespace that counts what reaches it.
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
const padReq = (ip, code = freshCode()) => new Request(`https://relay.test/pad?code=${code}&role=host`, {
  headers: ip ? { 'CF-Connecting-IP': ip } : {},
});

test('a script opening rooms from one IP is cut off after the limit; nothing past it reaches a room', async () => {
  const env = { PAD_LIMITER: countingLimiter(30), PAD_ROOM: roomNamespace() };
  const statuses = [];
  for (let i = 0; i < 45; i++) statuses.push((await relay.fetch(padReq('203.0.113.7'), env)).status);
  const ok = statuses.filter((s) => s === 200).length;
  const refused = statuses.filter((s) => s === 429).length;
  assert.ok(ok > 0, 'the codes are valid: the first requests reach rooms');
  assert.equal(ok, 30, 'exactly the limit gets through');
  assert.equal(refused, 15, 'the rest of the flood is refused with 429');
  assert.equal(env.PAD_ROOM.reached, 30, 'a refused request never touches the Durable Object (no DO request or storage)');
  assert.ok(statuses.slice(30).every((s) => s === 429), 'once over, every further request is refused');
});

test('the flood does not lock out anyone else', async () => {
  const env = { PAD_LIMITER: countingLimiter(30), PAD_ROOM: roomNamespace() };
  for (let i = 0; i < 40; i++) await relay.fetch(padReq('203.0.113.7'), env);
  const other = await relay.fetch(padReq('198.51.100.2'), env);
  assert.equal(other.status, 200, 'a player on another IP still gets a room');
});

test('normal play stays far below the limit: a game and a phone redialling a few times', async () => {
  const env = { PAD_LIMITER: countingLimiter(30), PAD_ROOM: roomNamespace() };
  const code = freshCode();
  const statuses = [];
  for (let i = 0; i < 6; i++) statuses.push((await relay.fetch(padReq('192.0.2.10', code), env)).status);
  assert.ok(statuses.every((s) => s === 200), JSON.stringify(statuses));
});

test('after the window resets, the same IP is let in again', async () => {
  const lim = countingLimiter(30);
  const env = { PAD_LIMITER: lim, PAD_ROOM: roomNamespace() };
  for (let i = 0; i < 35; i++) await relay.fetch(padReq('203.0.113.9'), env);
  assert.equal((await relay.fetch(padReq('203.0.113.9'), env)).status, 429);
  lim.reset();   // the minute is up
  assert.equal((await relay.fetch(padReq('203.0.113.9'), env)).status, 200);
});

test('a bad code is refused before the limiter counts it', async () => {
  const lim = countingLimiter(30);
  let counted = 0;
  const env = { PAD_LIMITER: { limit: async (a) => { counted++; return lim.limit(a); } }, PAD_ROOM: roomNamespace() };
  const res = await relay.fetch(new Request('https://relay.test/pad?code=!!&role=host', { headers: { 'CF-Connecting-IP': '203.0.113.7' } }), env);
  assert.equal(res.status, 400);
  assert.equal(counted, 0);
});
