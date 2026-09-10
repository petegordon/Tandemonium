#!/usr/bin/env node
// ============================================================
// check-dashboard-sql.mjs — run the C-1 dashboard SQL for real
// ============================================================
//
// The dashboard queries cannot be deployed from here (wrangler is not logged
// in on this machine), and a SQL typo in a Worker is invisible until someone
// opens the dashboard. So: build the real schema in an in-memory SQLite,
// insert a small fixture whose answers are known by hand, run the exact
// queries from worker/leaderboard.js, and check the numbers.
//
// D1 uses SQLite, so the dialect matches — including json_extract() and the
// window function in the first-ride query.
//
//   node scripts/check-dashboard-sql.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const db = new DatabaseSync(':memory:');

// ── schema ────────────────────────────────────────────────────────────────
const sql = fs.readFileSync(path.join(ROOT, 'worker/schema.sql'), 'utf8');
db.exec(sql);
const migrations = fs.readdirSync(path.join(ROOT, 'worker/migrations')).sort();
for (const m of migrations) {
  const text = fs.readFileSync(path.join(ROOT, 'worker/migrations', m), 'utf8')
    .split('\n')
    .filter(line => !line.trim().startsWith('--'))   // strip comment lines first
    .join('\n');
  for (const stmt of text.split(';')) {
    const s = stmt.trim();
    if (!s) continue;
    try { db.exec(s); } catch (e) {
      // Migrations may re-add columns the base schema already has; that is
      // exactly what happens against the live DB too.
      if (!/duplicate column|already exists/i.test(e.message)) {
        console.error(`migration ${m}: ${e.message}\n  ${s.slice(0, 120)}`);
      }
    }
  }
}

// ── fixture ───────────────────────────────────────────────────────────────
// Three devices. A rides on day 1 and day 2 (a D1 return). B rides on day 1
// and day 8 (a D7 return but not D1). C rides once and never comes back.
const day = (n) => new Date(Date.UTC(2026, 7, n, 12, 0, 0)).toISOString();
const sessions = [
  ['s1', day(1), 'dev-A'], ['s2', day(2), 'dev-A'],
  ['s3', day(1), 'dev-B'], ['s4', day(8), 'dev-B'],
  ['s5', day(1), 'dev-C'],
  ['s6', day(1), null]          // pre-migration session: must be excluded
];
for (const [id, started, device] of sessions) {
  db.prepare(`INSERT INTO sessions (id, started_at, device_id, platform) VALUES (?, ?, ?, 'browser')`)
    .run(id, started, device);
}

// Rides: two first-rides completed, one abandoned at 45 s having passed 1 cp.
db.prepare(`INSERT INTO rides (id, session_id, level, role, difficulty, input_method, started_at, completed, duration_ms, distance, checkpoints_passed, abandon_reason)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
  .run('r1', 's1', 'grandma', 'solo', 'chill', 'keyboard', day(1), 1, 160000, 250, 4, null);
db.prepare(`INSERT INTO rides (id, session_id, level, role, difficulty, input_method, started_at, completed, duration_ms, distance, checkpoints_passed, abandon_reason)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
  .run('r2', 's3', 'grandma', 'solo', 'chill', 'keyboard', day(1), 1, 175000, 250, 4, null);
db.prepare(`INSERT INTO rides (id, session_id, level, role, difficulty, input_method, started_at, completed, duration_ms, distance, checkpoints_passed, abandon_reason)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
  .run('r3', 's5', 'castle', 'solo', 'adventurous', 'gamepad', day(1), 0, 45000, 120, 1, 'lobby_button');

// crash_recover events (B-2's promise, measured)
for (const ms of [2100, 2400, 2600]) {
  db.prepare(`INSERT INTO events (session_id, event_type, event_data, created_at) VALUES (?, 'crash_recover', ?, ?)`)
    .run('s1', JSON.stringify({ ms, cause: 'balance' }), day(1));
}

// A pair (users 1 and 2) that rode together twice, plus a solo score.
db.prepare(`INSERT INTO users (id, provider, provider_id, display_name) VALUES (1, 'google', 'u1', 'Sam')`).run();
db.prepare(`INSERT INTO users (id, provider, provider_id, display_name) VALUES (2, 'google', 'u2', 'Jo')`).run();
for (const [scoreId, when] of [[1, day(1)], [2, day(5)]]) {
  db.prepare(`INSERT INTO scores (id, user_id, level_id, distance, time_ms, mode, difficulty, created_at)
              VALUES (?, 1, 'grandma', 250, 160000, 'captain', 'chill', ?)`)
    .run(scoreId, when);
  db.prepare(`INSERT INTO score_contributions (score_id, role, player_user_id) VALUES (?, 'captain', 1)`).run(scoreId);
  db.prepare(`INSERT INTO score_contributions (score_id, role, player_user_id) VALUES (?, 'stoker', 2)`).run(scoreId);
}

// ── the queries, copied from worker/leaderboard.js ─────────────────────────
const since = day(0);
const fail = [];
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? '✔' : '✖'} ${label}: ${JSON.stringify(actual)}${ok ? '' : ` (expected ${JSON.stringify(expected)})`}`);
  if (!ok) fail.push(label);
};

const cohorts = db.prepare(
  `WITH d AS (
     SELECT device_id, DATE(started_at) AS day
     FROM sessions s
     WHERE started_at >= ? AND device_id IS NOT NULL
     GROUP BY device_id, day
   ),
   first_seen AS (
     SELECT device_id, MIN(day) AS cohort FROM d GROUP BY device_id
   )
   SELECT f.cohort AS day,
          COUNT(DISTINCT f.device_id) AS n,
          COUNT(DISTINCT CASE WHEN julianday(d.day) - julianday(f.cohort) = 1
                              THEN f.device_id END) AS d1,
          COUNT(DISTINCT CASE WHEN julianday(d.day) - julianday(f.cohort) BETWEEN 1 AND 7
                              THEN f.device_id END) AS d7
   FROM first_seen f
   LEFT JOIN d ON d.device_id = f.device_id
   GROUP BY f.cohort
   ORDER BY f.cohort DESC`
).all(since);
// Three devices first seen on day 1: A returns on day 2 (D1 and D7), B returns
// on day 8 (7 days later — inside BETWEEN 1 AND 7), C never returns.
check('retention cohort', cohorts, [{ day: '2026-08-01', n: 3, d1: 1, d7: 2 }]);

const coverage = db.prepare(
  `SELECT COUNT(*) AS total, COUNT(CASE WHEN device_id IS NOT NULL THEN 1 END) AS with_device
   FROM sessions s WHERE started_at >= ?`
).get(since);
check('device id coverage', coverage, { total: 6, with_device: 5 });

const firstRide = db.prepare(
  `WITH firsts AS (
     SELECT id, session_id, completed, duration_ms,
            ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY started_at) AS rn
     FROM rides WHERE started_at >= ?
   )
   SELECT COUNT(*) AS n, SUM(completed) AS completed, CAST(AVG(duration_ms) AS INTEGER) AS avg_ms
   FROM firsts WHERE rn = 1`
).get(since);
check('first ride of a session', firstRide, { n: 3, completed: 2, avg_ms: 126666 });

const recover = db.prepare(
  `SELECT COUNT(*) AS n,
          CAST(AVG(CAST(json_extract(event_data, '$.ms') AS INTEGER)) AS INTEGER) AS avg_ms
   FROM events WHERE created_at >= ? AND event_type = 'crash_recover'`
).get(since);
check('crash recovery', recover, { n: 3, avg_ms: 2366 });

const buckets = db.prepare(
  `SELECT (duration_ms / 30000) AS bucket_30s, COUNT(*) AS n
   FROM rides WHERE started_at >= ? AND completed = 0 AND duration_ms IS NOT NULL
   GROUP BY bucket_30s ORDER BY bucket_30s`
).all(since);
check('abandoned duration buckets', buckets, [{ bucket_30s: 1, n: 1 }]);

const byCheckpoint = db.prepare(
  `SELECT checkpoints_passed, COUNT(*) AS n
   FROM rides WHERE started_at >= ? AND completed = 0
   GROUP BY checkpoints_passed ORDER BY checkpoints_passed`
).all(since);
check('abandoned by checkpoint', byCheckpoint, [{ checkpoints_passed: 1, n: 1 }]);

const byLevel = db.prepare(
  `SELECT level, difficulty, completed, COALESCE(abandon_reason, '-') AS abandon_reason,
          COUNT(*) AS n, CAST(AVG(duration_ms) AS INTEGER) AS avg_ms,
          CAST(AVG(distance) AS INTEGER) AS avg_distance
   FROM rides WHERE started_at >= ?
   GROUP BY level, difficulty, completed, abandon_reason ORDER BY n DESC`
).all(since);
check('rides by level', byLevel.length, 2);

const pairs = db.prepare(
  `WITH pairs AS (
     SELECT MIN(a.player_user_id) AS lo, MAX(a.player_user_id) AS hi, a.score_id, s.created_at
     FROM score_contributions a
     JOIN scores s ON s.id = a.score_id
     WHERE a.player_user_id IS NOT NULL AND s.created_at >= ?
     GROUP BY a.score_id
     HAVING COUNT(DISTINCT a.player_user_id) = 2
   )
   SELECT lo, hi, COUNT(*) AS rides, MIN(created_at) AS first_ride, MAX(created_at) AS last_ride
   FROM pairs GROUP BY lo, hi ORDER BY rides DESC`
).all(since);
check('pairs', pairs.map(p => ({ lo: p.lo, hi: p.hi, rides: p.rides })), [{ lo: 1, hi: 2, rides: 2 }]);

if (fail.length) {
  console.error(`\n✖ ${fail.length} query/queries wrong: ${fail.join(', ')}`);
  process.exit(1);
}
console.log('\n✔ every C-1 dashboard query runs and returns the hand-computed answer');

// ============================================================
// D-6 / D-7 / D-9 · pairs and the partners board
// ============================================================
//
// Same idea as above: these endpoints cannot be deployed from here, so the
// exact statements from worker/leaderboard.js run against the real schema with
// a fixture whose answers are known.

const pairKey = (a, b) => (String(a) < String(b) ? [String(a), String(b)] : [String(b), String(a)]);

function upsertPair(lo, hi, { distance = 0, best = {}, streak = 0, bestStreak = 0, lastKey = null } = {}) {
  db.prepare(
    `INSERT INTO pairs (user_lo, user_hi, rides, distance, best_json, last_ride,
                        daily_streak, daily_best_streak, daily_last_key)
     VALUES (?, ?, 1, ?, ?, datetime('now'), ?, ?, ?)
     ON CONFLICT(user_lo, user_hi) DO UPDATE SET
       rides = rides + 1,
       distance = distance + excluded.distance,
       best_json = excluded.best_json,
       last_ride = excluded.last_ride,
       daily_streak = excluded.daily_streak,
       daily_best_streak = excluded.daily_best_streak,
       daily_last_key = excluded.daily_last_key`
  ).run(lo, hi, distance, JSON.stringify(best), streak, bestStreak, lastKey);
}

// Sam (1) and Jo (2) ride twice; the second is faster.
{
  const [lo, hi] = pairKey(1, 2);
  upsertPair(lo, hi, { distance: 250, best: { grandma: 170000 } });
  upsertPair(lo, hi, { distance: 250, best: { grandma: 161000 } });
  const row = db.prepare('SELECT * FROM pairs WHERE user_lo = ? AND user_hi = ?').get(lo, hi);
  check('pair rides accumulate', { rides: row.rides, distance: row.distance }, { rides: 2, distance: 500 });
  check('pair keeps the better time', JSON.parse(row.best_json), { grandma: 161000 });
}

// Captain order must not create a second row.
{
  const [lo, hi] = pairKey(2, 1);
  upsertPair(lo, hi, { distance: 100, best: { grandma: 161000 } });
  const rows = db.prepare('SELECT COUNT(*) AS n FROM pairs').get();
  check('a pair is unordered', rows, { n: 1 });
}

// D-9: a guest pair exists alongside, and merges into the account.
{
  const [lo, hi] = pairKey(1, 'guest:dev-A');
  upsertPair(lo, hi, { distance: 300, best: { castle: 200000 } });
  check('a guest pair is its own row', db.prepare('SELECT COUNT(*) AS n FROM pairs').get(), { n: 2 });

  // The guest signs in as user 3: their row becomes (1,3).
  const guestRows = db.prepare('SELECT * FROM pairs WHERE user_lo = ? OR user_hi = ?')
    .all('guest:dev-A', 'guest:dev-A');
  for (const row of guestRows) {
    const other = row.user_lo === 'guest:dev-A' ? row.user_hi : row.user_lo;
    const [nlo, nhi] = pairKey('3', other);
    db.prepare(
      `INSERT INTO pairs (user_lo, user_hi, rides, distance, best_json, last_ride,
                          daily_streak, daily_best_streak, daily_last_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(nlo, nhi, row.rides, row.distance, row.best_json, row.last_ride,
          row.daily_streak, row.daily_best_streak, row.daily_last_key);
    db.prepare('DELETE FROM pairs WHERE user_lo = ? AND user_hi = ?').run(row.user_lo, row.user_hi);
  }
  const merged = db.prepare("SELECT * FROM pairs WHERE user_lo = '1' AND user_hi = '3'").get();
  check('the guest history follows them to their account',
    { rides: merged.rides, distance: merged.distance }, { rides: 1, distance: 300 });
  check('no guest rows are left',
    db.prepare("SELECT COUNT(*) AS n FROM pairs WHERE user_lo LIKE 'guest:%' OR user_hi LIKE 'guest:%'").get(),
    { n: 0 });
}

// D-6: one ranked run per user per day per mode.
{
  // User 3 became Sam's partner in the D-9 merge above, so the stranger here
  // has to be somebody else entirely — user 4, who has ridden with nobody.
  db.prepare(`INSERT INTO users (id, provider, provider_id, display_name) VALUES (3, 'google', 'u3', 'Alex')`).run();
  db.prepare(`INSERT INTO users (id, provider, provider_id, display_name) VALUES (4, 'google', 'u4', 'Stranger')`).run();
  const insert = (uid, key, mode, ms) => db.prepare(
    `INSERT INTO daily_results (user_id, day_key, mode, time_ms, dnf, distance) VALUES (?, ?, ?, ?, 0, 500)`
  ).run(uid, key, mode, ms);

  insert(1, '2026-09-08', 'solo', 161000);
  let rejected = false;
  try { insert(1, '2026-09-08', 'solo', 120000); } catch (e) { rejected = /UNIQUE/i.test(e.message); }
  check('a second ranked run on the same day is refused', rejected, true);

  insert(1, '2026-09-08', 'pair', 150000);   // the pair run is independent
  insert(2, '2026-09-08', 'solo', 158000);   // Jo, who has ridden with Sam
  insert(3, '2026-09-08', 'solo', 140000);   // Alex, now a partner via the merge
  insert(4, '2026-09-08', 'solo', 100000);   // a stranger: fastest, and invisible

  const me = '1';
  const board = db.prepare(
    `SELECT d.user_id, d.mode, d.time_ms
     FROM daily_results d
     JOIN users u ON u.id = d.user_id
     WHERE d.day_key = ?
       AND (
         d.user_id = ?
         OR EXISTS (
           SELECT 1 FROM pairs p
           WHERE (p.user_lo = ? AND p.user_hi = CAST(d.user_id AS TEXT))
              OR (p.user_hi = ? AND p.user_lo = CAST(d.user_id AS TEXT))
         )
       )
     ORDER BY d.dnf ASC, d.time_ms ASC`
  ).all('2026-09-08', 1, me, me);

  check('the board shows me and my partners, ordered by time',
    board.map(r => [r.user_id, r.mode]),
    [[3, 'solo'], [1, 'pair'], [2, 'solo'], [1, 'solo']]);
  check('a stranger never appears on it, however fast they were',
    board.some(r => r.user_id === 4), false);
}
