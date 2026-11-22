// Gameplay analytics are kept for 24 months: older records are deleted once a day, and
// nothing that is not analytics is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import worker from '../../worker/leaderboard.js';
import { pruneAnalytics, retentionCutoff, ANALYTICS_RETENTION_MONTHS } from '../../worker/retention.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

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
function d1(db) {
  const bound = (sql, args) => ({
    run: async () => { const r = db.prepare(sql).run(...args); return { success: true, meta: { changes: Number(r.changes) } }; },
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
  });
  return { prepare: (sql) => ({ bind: (...args) => bound(sql, args), ...bound(sql, []) }) };
}

const NOW = Date.parse('2026-11-22T12:00:00.000Z');
const OLD = '2024-10-01T00:00:00.000Z';     // more than 24 months before NOW
const EDGE = '2024-11-23T00:00:00.000Z';    // just inside 24 months
const NEW = '2026-11-01T00:00:00.000Z';

/** One session with an event, a ride (with an event and a seat), a room and a conversion, all at `at`. */
function seed(db, tag, at) {
  const sid = `session-${tag}`;
  const rid = `ride-${tag}`;
  db.prepare('INSERT INTO sessions (id, started_at) VALUES (?, ?)').run(sid, at);
  db.prepare('INSERT INTO events (session_id, event_type, created_at) VALUES (?, ?, ?)').run(sid, 'page_view', at);
  db.prepare("INSERT INTO rides (id, session_id, level, input_method, started_at) VALUES (?, ?, 'meadow', 'keyboard', ?)").run(rid, sid, at);
  db.prepare('INSERT INTO ride_events (ride_id, event_type, created_at) VALUES (?, ?, ?)').run(rid, 'crash', at);
  db.prepare('INSERT INTO ride_seats (ride_id, seat) VALUES (?, 1)').run(rid);
  db.prepare('INSERT INTO rooms (code, captain_session_id, created_at) VALUES (?, ?, ?)').run(`TNDM-${tag}`, sid, at);
  db.prepare("INSERT INTO conversions (session_id, action, created_at) VALUES (?, 'wishlist_click', ?)").run(sid, at);
}
const TABLES = ['sessions', 'events', 'rides', 'ride_events', 'ride_seats', 'rooms', 'conversions'];
const counts = (db) => Object.fromEntries(TABLES.map((t) => [t, db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n]));

test('the cutoff is 24 months back', () => {
  assert.equal(ANALYTICS_RETENTION_MONTHS, 24);
  assert.equal(retentionCutoff(NOW), '2024-11-22T12:00:00.000Z');
});

test('records older than 24 months go, with everything that hangs off them; newer ones stay', async () => {
  const db = freshDb();
  seed(db, 'OLD1', OLD);
  seed(db, 'EDGE', EDGE);
  seed(db, 'NEW1', NEW);
  const out = await pruneAnalytics({ DB: d1(db) }, { now: NOW });
  assert.deepEqual(out.errors, []);
  assert.deepEqual(out.removed, Object.fromEntries(TABLES.map((t) => [t, 1])));
  assert.deepEqual(counts(db), Object.fromEntries(TABLES.map((t) => [t, 2])));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sessions WHERE id = 'session-OLD1'").get().n, 0);
  // again: nothing more to do
  const again = await pruneAnalytics({ DB: d1(db) }, { now: NOW });
  assert.deepEqual(Object.values(again.removed), TABLES.map(() => 0));
});

test('an old session that newer records still point at is kept until they are old too', async () => {
  const db = freshDb();
  db.prepare('INSERT INTO sessions (id, started_at) VALUES (?, ?)').run('long-session', OLD);
  db.prepare('INSERT INTO events (session_id, event_type, created_at) VALUES (?, ?, ?)').run('long-session', 'old', OLD);
  db.prepare('INSERT INTO events (session_id, event_type, created_at) VALUES (?, ?, ?)').run('long-session', 'new', NEW);
  const out = await pruneAnalytics({ DB: d1(db) }, { now: NOW });
  assert.deepEqual(out.errors, []);
  assert.equal(counts(db).sessions, 1);
  assert.deepEqual(db.prepare('SELECT event_type FROM events').all().map((r) => r.event_type), ['new']);
});

test('a run removes a bounded number of rows; the next run carries on', async () => {
  const db = freshDb();
  db.prepare('INSERT INTO sessions (id, started_at) VALUES (?, ?)').run('s', OLD);
  for (let i = 0; i < 5; i++) db.prepare('INSERT INTO events (session_id, event_type, created_at) VALUES (?, ?, ?)').run('s', 'e' + i, OLD);
  await pruneAnalytics({ DB: d1(db) }, { now: NOW, batch: 2 });
  assert.equal(counts(db).events, 3);
  assert.equal(counts(db).sessions, 1, 'still pointed at');
  await pruneAnalytics({ DB: d1(db) }, { now: NOW, batch: 2 });
  await pruneAnalytics({ DB: d1(db) }, { now: NOW, batch: 2 });
  assert.deepEqual(counts(db), Object.fromEntries(TABLES.map((t) => [t, 0])));
});

test('only analytics are touched: accounts, scores and consent answers of any age stay', async () => {
  const db = freshDb();
  const userId = Number(db.prepare("INSERT INTO users (provider, provider_id, display_name, created_at) VALUES ('account', 'u1', 'Greta', '2020-01-01 00:00:00')").run().lastInsertRowid);
  db.prepare("INSERT INTO consents (id, choice, policy_version, user_id, created_at, updated_at) VALUES ('c1', 'accept', 'v', ?, 1, 1)").run(userId);
  seed(db, 'OLD1', OLD);
  await pruneAnalytics({ DB: d1(db) }, { now: NOW });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM consents').get().n, 1);
});

test('the Worker runs it on its daily trigger, and a failure there is caught', async () => {
  const db = freshDb();
  seed(db, 'OLD1', '2020-01-01T00:00:00.000Z');
  let waited = null;
  await worker.scheduled({}, { DB: d1(db) }, { waitUntil(p) { waited = p; } });
  await waited;
  assert.deepEqual(counts(db), Object.fromEntries(TABLES.map((t) => [t, 0])));
  await worker.scheduled({}, { DB: { prepare() { throw new Error('no database'); } } }, { waitUntil() {} });
  const toml = fs.readFileSync(path.join(ROOT, 'worker/wrangler-api.toml'), 'utf8');
  assert.match(toml, /\[triggers\]\s*\r?\ncrons = \["[^"]+"\]/, 'production has the daily trigger');
});
