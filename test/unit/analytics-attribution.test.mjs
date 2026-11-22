// A session's account comes only from a verified sign-in token. What the body says about the
// account is ignored, and a repeated create leaves a described session as it was.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import worker from '../../worker/leaderboard.js';
import { signToken } from '../../worker/room-proof.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SECRET = 'attribution-secret';
const SID = '11111111-2222-4333-8444-555555555555';

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(fs.readFileSync(path.join(ROOT, 'worker/schema.sql'), 'utf8'));
  for (const m of fs.readdirSync(path.join(ROOT, 'worker/migrations')).sort()) {
    const text = fs.readFileSync(path.join(ROOT, 'worker/migrations', m), 'utf8').split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
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
    run: async () => { db.prepare(sql).run(...args); return { success: true }; },
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
const send = (env, p, body, method = 'POST', ip = '1.2.3.4') => worker.fetch(new Request('https://api.test' + p, {
  method, headers: { 'Content-Type': 'text/plain', 'CF-Connecting-IP': ip }, body: JSON.stringify(body),
}), env, { waitUntil() {} });
const row = (db) => ({ ...db.prepare('SELECT * FROM sessions WHERE id = ?').get(SID) });

function setup() {
  const db = freshDb();
  const cols = db.prepare('PRAGMA table_info(users)').all();
  const insertUser = (id) => {
    const required = cols.filter((c) => c.notnull && c.dflt_value === null && !c.pk);
    const names = ['id', ...required.map((c) => c.name)];
    const vals = [id, ...required.map((c) => (/INT/i.test(c.type) ? 0 : 'u' + id))];
    db.prepare(`INSERT INTO users (${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`).run(...vals);
  };
  insertUser(42); insertUser(43);
  const lid = (u) => Number(db.prepare("INSERT INTO user_logins (user_id, provider, provider_id) VALUES (?, 'discord', ?)").run(u, 'd' + u).lastInsertRowid);
  return { db, env: { DB: d1(db), CORS_ORIGIN: '*', JWT_SECRET: SECRET }, ann: lid(42), bea: lid(43) };
}

test('a body naming an account does not set it, on create or through the upsert', async () => {
  const { db, env } = setup();
  await send(env, '/api/analytics/session', { id: SID, google_uid: 42, user_agent: 'ua', platform: 'browser' });
  assert.equal(row(db).google_uid, null);
  await send(env, '/api/analytics/session', { id: SID, google_uid: '42', user_agent: 'ua' });
  assert.equal(row(db).google_uid, null, 'a repeat changes nothing');
  await send(env, `/api/analytics/session/${SID}`, { google_uid: 42, ended_at: '2026-11-22T00:00:00Z' }, 'PUT');
  assert.equal(row(db).google_uid, null, 'nor does an update');
});

test('a placeholder session takes no account from a create body either', async () => {
  const { db, env } = setup();
  await send(env, '/api/analytics/event/batch', { events: [{ session_id: SID, event_type: 'page_view' }] });
  await send(env, '/api/analytics/session', { id: SID, google_uid: 42, user_agent: 'ua', platform: 'steam' });
  const r = row(db);
  assert.equal(r.google_uid, null);
  assert.equal(r.platform, 'steam', 'the late create still fills the placeholder in');
});

test('a verified token on the create sets the account and login', async () => {
  const { db, env, ann } = setup();
  const token = await signToken({ sub: 42, lid: ann }, SECRET, 3600);
  await send(env, '/api/analytics/session', { id: SID, google_uid: 43, account_token: token, user_agent: 'ua' });
  const r = row(db);
  assert.equal(r.google_uid, '42', 'the token decides, not the body');
  assert.equal(r.login_id, ann);
});

test('a token signed with another key attaches nothing', async () => {
  const { db, env, ann } = setup();
  const token = await signToken({ sub: 42, lid: ann }, 'another-secret', 3600);
  await send(env, '/api/analytics/session', { id: SID, account_token: token, user_agent: 'ua' });
  assert.equal(row(db).google_uid, null);
});

test('the Steam flow still attaches after launch: token on the update, create either side', async () => {
  const { db, env, ann } = setup();
  const token = await signToken({ sub: 42, lid: ann }, SECRET, 3600);
  await send(env, `/api/analytics/session/${SID}`, { account_token: token }, 'PUT');
  assert.equal(row(db).google_uid, '42', 'attached to a placeholder');
  await send(env, '/api/analytics/session', { id: SID, user_agent: 'Electron', platform: 'steam', device_id: 'device-0001' });
  const r = row(db);
  assert.equal(r.google_uid, '42', 'the late create keeps the account');
  assert.equal(r.platform, 'steam', 'and fills in the platform');
});

test('a repeated create cannot change a described session', async () => {
  const { db, env, ann } = setup();
  const token = await signToken({ sub: 42, lid: ann }, SECRET, 3600);
  await send(env, '/api/analytics/session', { id: SID, account_token: token, user_agent: 'Electron', platform: 'steam', device_id: 'device-0001', started_at: '2026-11-22T10:00:00.000Z', screen_width: 1920 });
  const before = row(db);
  await send(env, '/api/analytics/session', { id: SID, user_agent: 'other', platform: 'browser', device_id: 'device-9999', started_at: '2020-01-01T00:00:00.000Z', screen_width: 1, is_stoker: true }, 'POST', '9.9.9.9');
  assert.deepEqual(row(db), before);
});

test('an account on a session is never moved to another', async () => {
  const { db, env, ann, bea } = setup();
  await send(env, '/api/analytics/session', { id: SID, account_token: await signToken({ sub: 42, lid: ann }, SECRET, 3600), user_agent: 'ua' });
  await send(env, `/api/analytics/session/${SID}`, { account_token: await signToken({ sub: 43, lid: bea }, SECRET, 3600) }, 'PUT');
  assert.equal(row(db).google_uid, '42');
});

test('the game sends its token, not an account number, when a session starts', () => {
  const game = fs.readFileSync(path.join(ROOT, 'js/game.js'), 'utf8');
  const init = game.slice(game.indexOf('analytics.initSession({'), game.indexOf("analytics.setPage('landing')"));
  assert.ok(init.includes('account_token'));
  assert.ok(!init.includes('google_uid'));
});
