// The API's rate limits (Pete 2026-11-09): the same two rules for every route.
//   1. per player: 30 a minute for each kind of write (account, else session/device/ride id)
//   2. per IP: 300 a minute across every route (a venue shares one IP)
// plus 30 a minute per IP to start a sign-in. A counting stand-in for each
// Cloudflare ratelimit binding, at the limits wrangler-api.toml sets.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import worker, { PLAYER_LIMIT, IP_LIMIT } from '../../worker/leaderboard.js';

function counting(limit) {
  const n = new Map();
  return { limit: async ({ key }) => { n.set(key, (n.get(key) || 0) + 1); return { success: n.get(key) <= limit }; } };
}
// A database that accepts everything: only the limits are under test here.
const stmt = { bind: () => stmt, run: async () => ({ success: true, meta: {} }), first: async () => null, all: async () => ({ results: [] }) };
const noDb = { prepare: () => stmt, batch: async (l) => l.map(() => ({ success: true })) };
globalThis.caches ??= { default: { match: async () => undefined, put: async () => {} } };
function envFor() {
  return {
    DB: noDb, CORS_ORIGIN: '*', JWT_SECRET: 'test-secret',
    PLAYER_LIMITER: counting(30), IP_LIMITER: counting(300), SIGNIN_LIMITER: counting(30),
  };
}
// "not 429" is what each check reads.
async function send(env, path, { ip = '1.2.3.4', body = {}, method = 'POST' } = {}) {
  const res = await worker.fetch(new Request('https://api.test' + path, {
    method, headers: { 'Content-Type': 'text/plain', 'CF-Connecting-IP': ip }, body: method === 'GET' ? undefined : JSON.stringify(body),
  }), env, { waitUntil() {} });
  return res.status;
}
const sid = (i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;

test('the limits match the toml', () => {
  const toml = fs.readFileSync(new URL('../../worker/wrangler-api.toml', import.meta.url), 'utf8');
  const limitOf = (name) => Number((toml.match(new RegExp('name = "' + name + '"[\\s\\S]*?limit = (\\d+)')) || [])[1]);
  assert.equal(limitOf('PLAYER_LIMITER'), PLAYER_LIMIT);
  assert.equal(limitOf('IP_LIMITER'), IP_LIMIT);
  assert.equal(limitOf('SIGNIN_LIMITER'), 30);
  assert.ok(!/AUTH_LIMITER|READ_LIMITER|SCORE_LIMITER|ANALYTICS_\w*LIMITER/.test(toml), 'the old per-route limits are gone');
});

test('a venue: 18 machines on one IP, each sending a riding minute (~16), all get through', async () => {
  const env = envFor();
  let refused = 0;
  for (let m = 0; m < 18; m++) {
    for (let k = 0; k < 12; k++) if (await send(env, '/api/analytics/event/batch', { body: { events: [{ session_id: sid(m) }] } }) === 429) refused++;
    for (let k = 0; k < 4; k++) if (await send(env, `/api/analytics/session/${sid(m)}`, { method: 'PUT' }) === 429) refused++;
  }
  assert.equal(refused, 0, '288 requests from one IP fit the 300 ceiling');
});

test('a flood from one IP is refused past 300 a minute, whatever ids it makes up', async () => {
  const env = envFor();
  const statuses = [];
  for (let i = 0; i < 320; i++) statuses.push(await send(env, '/api/analytics/event/batch', { body: { events: [{ session_id: sid(i) }] } }));
  assert.equal(statuses.slice(0, 300).filter((s) => s === 429).length, 0);
  assert.equal(statuses.slice(300).filter((s) => s === 429).length, 20);
  assert.equal(await send(env, '/leaderboard', { method: 'GET' }), 429, 'reads share the same ceiling');
  assert.notEqual(await send(env, '/leaderboard', { method: 'GET', ip: '5.6.7.8' }), 429, 'another IP is unaffected');
});

test('one player: 30 a minute per kind of write; other kinds and other players are separate', async () => {
  const env = envFor();
  const statuses = [];
  for (let i = 0; i < 31; i++) statuses.push(await send(env, '/api/analytics/event/batch', { body: { events: [{ session_id: sid(1) }] } }));
  assert.equal(statuses.filter((s) => s === 429).length, 1, 'the 31st event batch is refused');
  assert.notEqual(await send(env, `/api/analytics/session/${sid(1)}`, { method: 'PUT' }), 429, 'session updates have their own bucket');
  assert.notEqual(await send(env, '/api/analytics/event/batch', { body: { events: [{ session_id: sid(2) }] } }), 429, 'another player on the same IP is fine');
});

test('starting a sign-in: 30 a minute per IP', async () => {
  const env = envFor();
  const statuses = [];
  for (let i = 0; i < 31; i++) statuses.push(await send(env, '/auth/steam', { body: { steamId: 'x', ticket: 't' } }));
  assert.equal(statuses.filter((s) => s === 429).length, 1);
  assert.notEqual(await send(env, '/auth/steam', { ip: '5.6.7.8', body: {} }), 429);
});
