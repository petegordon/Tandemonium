// Analytics API: events must never be lost because their session row is
// missing. The TV playtest of 2026-11-06 lost a whole session: the session
// create got 429 (seat churn had used up the per-IP session budget with
// controller updates), and every event batch after it failed with 500 on the
// events → sessions foreign key. D1 enforces foreign keys; so does this test.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import worker from '../../worker/leaderboard.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** The real schema + migrations in an in-memory SQLite, foreign keys ON (as D1). */
function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
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

/** Just enough of the D1 binding: prepare().bind().run/first/all, batch() in a transaction. */
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

const limiter = (allow) => ({ limit: async () => ({ success: allow() }) });
function envFor(db, extra = {}) {
  return { DB: d1(db), CORS_ORIGIN: '*', ...extra };
}
const post = (env, p, body, method = 'POST') => worker.fetch(new Request('https://api.test' + p, {
  method, headers: { 'Content-Type': 'text/plain', 'CF-Connecting-IP': '1.2.3.4' }, body: JSON.stringify(body),
}), env, { waitUntil() {} });

const SID = '11111111-2222-4333-8444-555555555555';
const ev = (type, extra = {}) => ({ session_id: SID, event_type: type, event_data: { x: 1 }, created_at: '2026-11-06T14:29:15.000Z', ...extra });

test('events for a session that was never created are stored, not a 500', async () => {
  const db = freshDb();
  const res = await post(envFor(db), '/api/analytics/event/batch', { events: [ev('page_view'), ev('js_error')] });
  assert.equal(res.status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM events WHERE session_id = ?').get(SID).n, 2);
  assert.equal(db.prepare('SELECT started_at FROM sessions WHERE id = ?').get(SID).started_at, '2026-11-06T14:29:15.000Z');
});

test('events with no session id are dropped instead of failing the batch', async () => {
  const db = freshDb();
  const res = await post(envFor(db), '/api/analytics/event/batch', { events: [ev('early', { session_id: null }), ev('page_view')] });
  assert.equal(res.status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM events').get().n, 1);
});

test('a late session create fills in the placeholder its events made', async () => {
  const db = freshDb();
  const env = envFor(db);
  await post(env, '/api/analytics/event/batch', { events: [ev('page_view')] });
  const res = await post(env, '/api/analytics/session', { id: SID, started_at: '2026-11-06T14:29:13.000Z', platform: 'steam', user_agent: 'Electron', device_id: 'dev-1', screen_width: 1920 });
  assert.equal(res.status, 200);
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(SID);
  assert.equal(row.platform, 'steam');
  assert.equal(row.user_agent, 'Electron');
  assert.equal(row.device_id, 'dev-1');
  assert.equal(row.screen_width, 1920);
  assert.equal(row.started_at, '2026-11-06T14:29:13.000Z', 'keeps the earlier start');
});

test('rides and conversions for a missing session are stored too', async () => {
  const db = freshDb();
  const env = envFor(db);
  const ride = await post(env, '/api/analytics/ride', { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', session_id: SID, level: 'grandma' });
  assert.equal(ride.status, 200);
  const conv = await post(env, '/api/analytics/conversion', { session_id: SID, action: 'wishlist_click', context: 'end' });
  assert.equal(conv.status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM rides').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM conversions').get().n, 1);
});

test('session updates have their own rate limit and cannot use up session creates', async () => {
  const db = freshDb();
  // The per-player limit counts each kind of write in its own bucket.
  const counts = new Map();
  const env = envFor(db, {
    PLAYER_LIMITER: { limit: async ({ key }) => { counts.set(key, (counts.get(key) || 0) + 1); return { success: counts.get(key) <= 30 }; } },
  });
  for (let i = 0; i < 20; i++) {
    const r = await post(env, `/api/analytics/session/${SID}`, { controller_name: 'Steam Controller ' + i }, 'PUT');
    assert.equal(r.status, 200);
  }
  const res = await post(env, '/api/analytics/session', { id: SID, started_at: '2026-11-06T14:29:13.000Z' });
  assert.equal(res.status, 200, 'the create still has its budget');
});
