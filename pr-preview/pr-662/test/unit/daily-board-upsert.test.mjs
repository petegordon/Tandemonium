// #641 · POST /daily keeps each account's BEST time of the day per mode.
// Runs the Worker's real SQL against an in-memory SQLite with the 0009 table.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { dailyUpsertSql } from '../../worker/leaderboard.js';

function db() {
  const d = new DatabaseSync(':memory:');
  d.exec(`CREATE TABLE daily_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL, day_key TEXT NOT NULL, mode TEXT NOT NULL,
    time_ms INTEGER, dnf INTEGER NOT NULL DEFAULT 0, distance REAL DEFAULT 0,
    collectibles INTEGER DEFAULT 0, crashes INTEGER DEFAULT 0, safety_used INTEGER DEFAULT 0,
    sync_pct INTEGER, partner_user_id INTEGER, created_at TEXT DEFAULT (datetime('now')),
    UNIQUE (user_id, day_key, mode))`);
  return d;
}

/** Submit like handleDailySubmit does; returns rows changed. */
function submit(d, { user = 1, day = '2026-11-07', mode = 'solo', timeMs = null, dnf = false, crashes = 0 }) {
  const r = d.prepare(dailyUpsertSql(dnf)).run(
    user, day, mode, dnf ? null : timeMs, dnf ? 1 : 0, 500, 0, crashes, 0, null, null);
  return Number(r.changes);
}
const row = (d, user = 1, mode = 'solo') =>
  d.prepare('SELECT time_ms, dnf, crashes FROM daily_results WHERE user_id = ? AND mode = ?').get(user, mode);

test('a faster finish replaces the row; a slower one changes nothing', () => {
  const d = db();
  assert.equal(submit(d, { timeMs: 90000, crashes: 2 }), 1);
  assert.equal(submit(d, { timeMs: 80000, crashes: 0 }), 1, 'improved');
  assert.deepEqual({ ...row(d) }, { time_ms: 80000, dnf: 0, crashes: 0 });
  assert.equal(submit(d, { timeMs: 85000, crashes: 5 }), 0, 'slower: not improved');
  assert.deepEqual({ ...row(d) }, { time_ms: 80000, dnf: 0, crashes: 0 });
  assert.equal(d.prepare('SELECT COUNT(*) AS n FROM daily_results').get().n, 1, 'still one row');
});

test('a finish replaces a DNF; a DNF never replaces a finish', () => {
  const d = db();
  submit(d, { dnf: true });
  assert.equal(row(d).dnf, 1);
  submit(d, { timeMs: 99000 });
  assert.deepEqual({ ...row(d) }, { time_ms: 99000, dnf: 0, crashes: 0 });
  assert.equal(submit(d, { dnf: true }), 0);
  assert.equal(row(d).time_ms, 99000);
});

test('solo and pair, and each day, are separate rows', () => {
  const d = db();
  submit(d, { timeMs: 90000 });
  submit(d, { timeMs: 95000, mode: 'pair' });
  submit(d, { timeMs: 70000, day: '2026-11-08' });
  assert.equal(row(d).time_ms, 90000);
  assert.equal(row(d, 1, 'pair').time_ms, 95000);
  assert.equal(d.prepare('SELECT COUNT(*) AS n FROM daily_results').get().n, 3);
});
