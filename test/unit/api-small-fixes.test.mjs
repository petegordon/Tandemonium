// Small API and lobby fixes: the cached leaderboard and CORS, HTML escaping, the day key
// on a score post, the Steam name on a ticket sign-in, the ticket's identity, and what a
// rate-limit metric records.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import worker, { limitKind, cleanPlayerName, STEAM_TICKET_IDENTITY } from '../../worker/leaderboard.js';
import { escapeHtml } from '../../js/escape-html.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SITE = 'https://tandemonium.housetandem.com';
const OLD_SITE = 'https://tandemonium.jimandi.love';

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(ROOT, 'worker/schema.sql'), 'utf8'));
  for (const m of fs.readdirSync(path.join(ROOT, 'worker/migrations')).sort()) {
    const text = fs.readFileSync(path.join(ROOT, 'worker/migrations', m), 'utf8')
      .split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    for (const stmt of text.split(';')) {
      const s = stmt.trim();
      if (!s) continue;
      try { db.exec(s); } catch (e) { if (!/duplicate column|already exists|no such table/i.test(e.message)) throw e; }
    }
  }
  return db;
}
function d1(db) {
  const bound = (sql, args) => ({
    _sql: sql, _args: args,
    run: async () => { const r = db.prepare(sql).run(...args); return { success: true, meta: { last_row_id: Number(r.lastInsertRowid), changes: Number(r.changes) } }; },
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
  });
  return {
    prepare: (sql) => ({ bind: (...args) => bound(sql, args.map((a) => (a === undefined ? null : a))), ...bound(sql, []) }),
    batch: async (stmts) => {
      db.exec('BEGIN');
      try { for (const s of stmts) db.prepare(s._sql).run(...s._args); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
      return stmts.map(() => ({ success: true }));
    },
  };
}
const envFor = (db, extra = {}) => ({
  DB: d1(db), CORS_ORIGIN: SITE + ',' + OLD_SITE, JWT_SECRET: 'test-secret', RELAY_SECRET: 'r', STEAM_WEB_API_KEY: 'k', ...extra,
});
const call = (env, p, { method = 'GET', origin = SITE, body, token: tok } = {}) => worker.fetch(new Request('https://api.test' + p, {
  method,
  headers: { 'CF-Connecting-IP': '203.0.113.9', Origin: origin, ...(tok ? { Authorization: 'Bearer ' + tok } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
  body: body ? JSON.stringify(body) : undefined,
}), env, { waitUntil() {} });
async function token(payload) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const data = `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc({ ...payload, iat: now, exp: now + 3600 })}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('test-secret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return `${data}.${Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))).toString('base64url')}`;
}
function onePlayer(db) {
  db.prepare("INSERT INTO users (id, provider, provider_id, display_name) VALUES (7, 'account', 'a', 'Ann')").run();
  db.prepare("INSERT INTO user_logins (login_id, user_id, provider, provider_id) VALUES (1, 7, 'discord', 'a')").run();
}

/** A stand-in for the Workers cache: keeps what was put, by URL. → restore() */
function fakeCache() {
  const real = globalThis.caches;
  const store = new Map();
  globalThis.caches = { default: {
    match: async (req) => { const hit = store.get(req.url); return hit ? hit.clone() : undefined; },
    put: async (req, res) => { store.set(req.url, res.clone()); },
  } };
  return { store, restore: () => { globalThis.caches = real; } };
}

test('a cached leaderboard answer carries the CORS origin of the caller it is given to', async () => {
  const db = freshDb();
  const env = envFor(db);
  onePlayer(db);
  db.prepare("INSERT INTO scores (user_id, login_id, level_id, distance, time_ms, mode) VALUES (7, 1, 'grandma', 1200, 200000, 'solo')").run();
  const cache = fakeCache();
  try {
    const first = await call(env, '/leaderboard?level=grandma', { origin: SITE });
    assert.equal(first.headers.get('Access-Control-Allow-Origin'), SITE);
    const body = await first.text();
    assert.equal(cache.store.size, 1);
    const kept = [...cache.store.values()][0];
    assert.equal(kept.headers.get('Access-Control-Allow-Origin'), null, 'the cached copy has no caller on it');

    // Served from the cache (the row added since is not in it), to the other allowed site.
    db.prepare("INSERT INTO scores (user_id, login_id, level_id, distance, time_ms, mode) VALUES (7, 1, 'grandma', 1200, 190000, 'solo')").run();
    const second = await call(env, '/leaderboard?level=grandma', { origin: OLD_SITE });
    assert.equal(second.headers.get('Access-Control-Allow-Origin'), OLD_SITE);
    assert.equal(second.headers.get('Content-Type'), 'application/json');
    assert.equal(await second.text(), body);
    // A site that is not on the list gets the primary address, as on any other route.
    const other = await call(env, '/leaderboard?level=grandma', { origin: 'https://elsewhere.example' });
    assert.equal(other.headers.get('Access-Control-Allow-Origin'), SITE);
  } finally { cache.restore(); }
});

test('escapeHtml escapes both quotes, so the text is safe inside an attribute', () => {
  assert.equal(escapeHtml(`a "b" 'c' <d> & e`), 'a &quot;b&quot; &#39;c&#39; &lt;d&gt; &amp; e');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(12), '12');
  const lobby = fs.readFileSync(path.join(ROOT, 'js/lobby.js'), 'utf8');
  assert.match(lobby, /_escapeHtml\(str\) \{\s+return escapeHtml\(str\);\s+\}/, 'the lobby uses it');
});

test('a score post checks its day key the way POST /daily does', async () => {
  const db = freshDb();
  const env = envFor(db);
  onePlayer(db);
  const tok = await token({ sub: 7, lid: 1 });
  const ride = { levelId: 'grandma', distance: 1200, timeMs: 200000, mode: 'solo' };
  const post = (dailyKey, extra = {}) => call(env, '/score', { method: 'POST', token: tok, body: { ...ride, dailyKey, ...extra } });
  const today = new Date(Date.now() - 9 * 3600 * 1000).toISOString().slice(0, 10);
  const ahead = new Date(Date.now() - 9 * 3600 * 1000 + 3 * 86400000).toISOString().slice(0, 10);

  for (const bad of ['today', '2026-1-1', 20261122, { $gt: '' }, '2026-11-22; DROP']) {
    const r = await post(bad);
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.equal((await r.json()).error, 'Bad day key');
  }
  for (const stale of ['2020-01-01', ahead]) {
    const r = await post(stale);
    assert.equal(r.status, 400, stale);
    assert.equal((await r.json()).error, 'Stale day key');
  }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM scores').get().n, 0, 'nothing was stored');
  assert.equal((await post(today)).status, 200);
  db.prepare("UPDATE scores SET created_at = datetime('now', '-1 minute')").run();
  assert.equal((await post(ahead, { warp: true })).status, 200, 'a time-warp ride may be a few days ahead, as on /daily');
  db.prepare("UPDATE scores SET created_at = datetime('now', '-1 minute')").run();
  assert.equal((await post(undefined)).status, 200, 'most rides carry no day key');
});

/** Steam answers the ticket check; the profile request is answered by `summary` (or fails). */
function fakeSteam(summary) {
  const real = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (input) => {
    const u = String(input && input.url ? input.url : input);
    seen.push(u);
    if (u.includes('AuthenticateUserTicket')) return Response.json({ response: { params: { steamid: '76561190000000001' } } });
    if (u.includes('GetPlayerSummaries')) { if (!summary) throw new Error('Steam is down'); return Response.json(summary); }
    throw new Error('unexpected fetch ' + u);
  };
  return { seen, restore: () => { globalThis.fetch = real; } };
}
const steamSignIn = (env, personaName) => call(env, '/auth/steam', {
  method: 'POST', body: { steamId: '76561190000000001', personaName, ticket: 'a1b2c3d4e5f60718' },
}).then((r) => r.json());

test('a Steam ticket sign-in takes the player name from Steam, not from the game', async () => {
  const db = freshDb();
  const env = envFor(db);
  const steam = fakeSteam({ response: { players: [{ personaname: 'Real Steam Name', avatarmedium: 'https://avatars.steamstatic.com/x_medium.jpg' }] } });
  try {
    const out = await steamSignIn(env, 'Someone Else');
    assert.equal(out.user.name, 'Real Steam Name');
    assert.equal(out.user.avatar, 'https://avatars.steamstatic.com/x_medium.jpg');
    assert.equal(db.prepare("SELECT display_name FROM user_logins WHERE provider = 'steam'").get().display_name, 'Real Steam Name');
    assert.equal(steam.seen.filter((u) => u.includes('GetPlayerSummaries')).length, 1, 'one profile request, as before');
  } finally { steam.restore(); }
});

test('when Steam does not answer, the name the game sent is used: one line, at most 64 characters', async () => {
  const db = freshDb();
  const env = envFor(db);
  const steam = fakeSteam(null);
  try {
    const out = await steamSignIn(env, '  Pete\n\tthe   Goose \u0007' + 'x'.repeat(100));
    assert.equal(out.user.name.length, 64);
    assert.ok(out.user.name.startsWith('Pete the Goose x'));
    assert.equal((await steamSignIn(env, { toString: 1 })).user.name, 'Steam Player');
  } finally { steam.restore(); }
  assert.equal(cleanPlayerName('  a\u0000b  '), 'a b');
  assert.equal(cleanPlayerName(''), null);
  assert.equal(cleanPlayerName(5), null);
});

test('the ticket is checked for the identity the desktop game asks Steam for it with', async () => {
  const main = fs.readFileSync(path.join(ROOT, 'electron/main.js'), 'utf8');
  const asked = main.match(/getAuthTicketForWebApi\(\{\s*identity:\s*'([^']+)'\s*\}\)/);
  assert.ok(asked, 'the game asks for its ticket with an identity');
  assert.equal(asked[1], STEAM_TICKET_IDENTITY);
  const db = freshDb();
  const steam = fakeSteam({ response: { players: [] } });
  try {
    await steamSignIn(envFor(db), 'Pete');
    const checks = steam.seen.filter((u) => u.includes('AuthenticateUserTicket'));
    assert.ok(checks.length >= 1);
    for (const u of checks) assert.equal(new URL(u).searchParams.get('identity'), STEAM_TICKET_IDENTITY);
  } finally { steam.restore(); }
});

test('a rate-limit metric records the kind of limit, never the address or the account', async () => {
  assert.equal(limitKind('ip:203.0.113.9'), 'ip');
  assert.equal(limitKind('ip:2001:db8::1'), 'ip');
  assert.equal(limitKind('signin:203.0.113.9'), 'signin');
  assert.equal(limitKind('score:user:26'), 'score:user');
  assert.equal(limitKind('daily:ip:2001:db8::1'), 'daily:ip');
  assert.equal(limitKind('user:26'), 'user');
  assert.equal(limitKind('203.0.113.9'), 'other');

  const points = [];
  const refuse = { limit: async () => ({ success: false }) };
  const allow = { limit: async () => ({ success: true }) };
  const stmt = { bind: () => stmt, run: async () => ({ success: true, meta: {} }), first: async () => null, all: async () => ({ results: [] }) };
  const base = { DB: { prepare: () => stmt, batch: async (l) => l.map(() => ({ success: true })) }, CORS_ORIGIN: SITE, JWT_SECRET: 'test-secret',
    ANALYTICS: { writeDataPoint: (p) => points.push(p) } };
  assert.equal((await call({ ...base, IP_LIMITER: refuse }, '/leaderboard')).status, 429);
  assert.equal((await call({ ...base, IP_LIMITER: allow, SIGNIN_LIMITER: refuse }, '/auth/steam', { method: 'POST', body: {} })).status, 429);
  assert.equal((await call({ ...base, IP_LIMITER: allow, PLAYER_LIMITER: refuse }, '/score', { method: 'POST', body: {} })).status, 429);
  assert.deepEqual(points.map((p) => p.blobs), [['rate_limit_hit', 'ip'], ['rate_limit_hit', 'signin'], ['rate_limit_hit', 'score:ip']]);
  assert.ok(!JSON.stringify(points).includes('203.0.113.9'));
});
