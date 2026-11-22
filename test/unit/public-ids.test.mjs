// Boards and profiles name a player by public id (pid), not by account number. The pid is
// made on the server from the account number, the same every time; users.public_id
// (migration 0024) keeps it so a profile can be found by it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import worker from '../../worker/leaderboard.js';
import { publicPlayerId, isPublicPlayerId, userIdForPublicId } from '../../worker/accounts/public-id.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SITE = 'https://tandemonium.housetandem.com';
globalThis.caches ??= { default: { match: async () => undefined, put: async () => {} } };

/** The schema with every migration, or only those before `before` (a file name prefix). */
function freshDb(before = null) {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(ROOT, 'worker/schema.sql'), 'utf8'));
  for (const m of fs.readdirSync(path.join(ROOT, 'worker/migrations')).sort()) {
    if (before && m >= before) continue;
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

const allow = { limit: async () => ({ success: true }) };
const envFor = (db) => ({
  DB: d1(db), CORS_ORIGIN: SITE, JWT_SECRET: 'test-secret', RELAY_SECRET: 'r', STEAM_WEB_API_KEY: 'k',
  AUTH_LIMITER: allow, READ_LIMITER: allow,
});
const call = (env, p, { token: tok } = {}) => worker.fetch(new Request('https://api.test' + p, {
  headers: { 'CF-Connecting-IP': '1.2.3.4', Origin: SITE, ...(tok ? { Authorization: 'Bearer ' + tok } : {}) },
}), env, { waitUntil() {} });

async function token(payload) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const data = `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc({ ...payload, iat: now, exp: now + 3600 })}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('test-secret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return `${data}.${Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))).toString('base64url')}`;
}

/** Ann (7) and Bea (8) rode together once (Ann's ride row), and Ann rode solo. */
function seed(db) {
  const add = (sql, ...a) => db.prepare(sql).run(...a);
  add("INSERT INTO users (id, provider, provider_id, display_name) VALUES (7, 'account', 'a', 'Ann'), (8, 'account', 'b', 'Bea')");
  add("INSERT INTO user_logins (login_id, user_id, provider, provider_id) VALUES (1, 7, 'discord', 'a'), (2, 8, 'steam', 'b')");
  add("INSERT INTO scores (id, user_id, login_id, level_id, distance, time_ms, mode) VALUES (1, 7, 1, 'grandma', 1200, 200000, 'captain'), (2, 7, 1, 'grandma', 1200, 210000, 'solo'), (3, 8, 2, 'grandma', 1200, 220000, 'solo')");
  add("INSERT INTO score_contributions (score_id, role, player_user_id, player_login_id) VALUES (1, 'captain', 7, 1), (1, 'stoker', 8, 2)");
  add("INSERT INTO user_achievements (user_id, login_id, achievement_id, score_id) VALUES (7, 1, 'first_finish', 1)");
}

test('a public id is 16 hex characters, the same every time, and different per account and per secret', async () => {
  const env = { JWT_SECRET: 'test-secret' };
  const a = await publicPlayerId(env, 7);
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.ok(isPublicPlayerId(a));
  assert.equal(await publicPlayerId(env, 7), a);
  assert.equal(await publicPlayerId(env, '7'), a, 'the account number as text is the same account');
  assert.notEqual(await publicPlayerId(env, 8), a);
  assert.notEqual(await publicPlayerId({ JWT_SECRET: 'another' }, 7), a);
  assert.equal(await publicPlayerId(env, null), null);
  assert.equal(await publicPlayerId({}, 7), null);
  for (const bad of ['7', '', 'ABCDEF0123456789', a + '0', a.slice(1), null, 7]) assert.equal(isPublicPlayerId(bad), false, String(bad));
});

test('the leaderboard names riders by public id and carries no account number', async () => {
  const db = freshDb();
  const env = envFor(db);
  seed(db);
  const res = await call(env, '/leaderboard?level=grandma');
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(!/user_id/.test(text), 'no user_id or player_user_id field');
  const { entries } = JSON.parse(text);
  assert.equal(entries.length, 3);
  const ann = await publicPlayerId(env, 7);
  const bea = await publicPlayerId(env, 8);
  assert.deepEqual(entries.map((e) => e.pid), [ann, ann, bea]);
  assert.deepEqual(entries[0].contributions.map((c) => [c.role, c.player_pid]).sort(), [['captain', ann], ['stoker', bea]]);
  assert.deepEqual(entries[0].achievements, [{ achievement_id: 'first_finish', score_id: 1 }]);
  // Seen in a public answer: each account's pid is now stored for lookups.
  assert.deepEqual(db.prepare('SELECT id, public_id FROM users ORDER BY id').all().map((r) => [r.id, r.public_id]), [[7, ann], [8, bea]]);
});

test('a profile is found by public id; an account number, an unknown id and a malformed one find nobody', async () => {
  const db = freshDb();
  const env = envFor(db);
  seed(db);
  const ann = await publicPlayerId(env, 7);
  assert.equal((await call(env, '/player/' + ann)).status, 404, 'not stored until the account is seen');
  await call(env, '/leaderboard?level=grandma');
  const res = await call(env, '/player/' + ann);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.user.pid, ann);
  assert.equal(body.user.display_name, 'Ann');
  assert.equal(body.user.id, undefined);
  assert.equal(body.bestScores[0].rides, 2);
  assert.equal(body.achievements.length, 1);
  assert.equal((await call(env, '/player/7')).status, 400);
  assert.equal((await call(env, '/player/' + ann.toUpperCase())).status, 400);
  assert.equal((await call(env, '/player/' + 'f'.repeat(16))).status, 404);
  // A stored value that is not the account's own id is never followed.
  db.prepare('UPDATE users SET public_id = ? WHERE id = 8').run('f'.repeat(16));
  assert.equal(await userIdForPublicId(env, 'f'.repeat(16)), null);
});

test('the signed-in player is told their own public id: it matches their board rows', async () => {
  const db = freshDb();
  const env = envFor(db);
  seed(db);
  const ann = await publicPlayerId(env, 7);
  const me = await (await call(env, '/me', { token: await token({ sub: 7, lid: 1 }) })).json();
  assert.equal(me.user.pid, ann);
  assert.equal(me.user.id, 7, 'their own account number stays in their own answer');
  assert.equal(db.prepare('SELECT public_id FROM users WHERE id = 7').get().public_id, ann, 'stored at first sight');
  const { entries } = await (await call(env, '/leaderboard?level=grandma&user_id=me', { token: await token({ sub: 7, lid: 1 }) })).json();
  assert.equal(entries.length, 2);
  assert.ok(entries.every((e) => e.pid === ann && e.user_id === undefined));
});

test('a Steam sign-in answers with the public id', async () => {
  const db = freshDb();
  const env = envFor(db);
  const real = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const u = String(input && input.url ? input.url : input);
    if (u.includes('AuthenticateUserTicket')) return Response.json({ response: { params: { steamid: '76561190000000001' } } });
    if (u.includes('GetPlayerSummaries')) return Response.json({ response: { players: [{ personaname: 'Pete', avatarmedium: 'https://avatars.steamstatic.com/x_medium.jpg' }] } });
    throw new Error('unexpected fetch ' + u);
  };
  try {
    const res = await worker.fetch(new Request('https://api.test/auth/steam', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '1.2.3.4', Origin: SITE },
      body: JSON.stringify({ steamId: '76561190000000001', personaName: 'Pete', ticket: 'a1b2c3d4e5f60718' }),
    }), env, { waitUntil() {} });
    const out = await res.json();
    assert.equal(out.user.pid, await publicPlayerId(env, out.user.id));
    assert.equal(db.prepare('SELECT public_id FROM users WHERE id = ?').get(out.user.id).public_id, out.user.pid);
  } finally { globalThis.fetch = real; }
});

test('the Daily board names riders by public id; only the caller\'s own rows keep their account number', async () => {
  const db = freshDb();
  const env = envFor(db);
  seed(db);
  const add = (sql, ...a) => db.prepare(sql).run(...a);
  add("INSERT INTO daily_results (user_id, login_id, day_key, mode, time_ms) VALUES (7, 1, '2026-11-10', 'solo', 100000), (8, 2, '2026-11-10', 'solo', 90000)");
  add('INSERT INTO pairs (login_lo, login_hi, user_lo, user_hi, rides, distance) VALUES (1, 2, 7, 8, 1, 100)');
  const board = await (await call(env, '/daily?key=2026-11-10', { token: await token({ sub: 7, lid: 1 }) })).json();
  const ann = await publicPlayerId(env, 7);
  const bea = await publicPlayerId(env, 8);
  assert.deepEqual(board.results.map((r) => [r.pid, r.user_id]), [[bea, undefined], [ann, 7]]);
});

test('before migration 0024: boards and sign-in answers still carry public ids, and a profile lookup finds nobody', async () => {
  const db = freshDb('0024');
  assert.ok(!db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'public_id'));
  const env = envFor(db);
  seed(db);
  const ann = await publicPlayerId(env, 7);
  const { entries } = await (await call(env, '/leaderboard?level=grandma')).json();
  assert.equal(entries[0].pid, ann);
  const me = await (await call(env, '/me', { token: await token({ sub: 7, lid: 1 }) })).json();
  assert.equal(me.user.pid, ann);
  assert.equal((await call(env, '/player/' + ann)).status, 404);
  assert.equal((await call(env, '/player/7')).status, 400);
});

test('migration 0024 adds users.public_id with an index, and follows the migration file conventions', () => {
  const db = freshDb();
  assert.ok(db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'public_id'));
  assert.ok(db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'index' AND name = 'idx_users_public_id'").get());
  const text = fs.readFileSync(path.join(ROOT, 'worker/migrations/0024_public_ids.sql'), 'utf8');
  assert.match(text, /Apply with:\r?\n--\s+npx wrangler d1 execute tandemonium-leaderboard --remote --file worker\/migrations\/0024_public_ids\.sql/);
  const comments = text.split(/\r?\n/).filter((l) => l.trim().startsWith('--')).join('\n');
  assert.ok(!comments.replace(/No semicolons inside statements or comments below: the test loader splits on them\./, '').includes(';'), 'no semicolon in a comment');
});
