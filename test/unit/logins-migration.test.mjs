// #783 · migration 0021 on a database shaped like production before it: accounts with one
// and two sign-ins, guests in pair records (old raw device ids and guest keys), rides,
// badges, Daily results, the other games' rows. After it every row carries a login (the
// account's earliest), each account's totals are what they were, and the worker reads them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import worker from '../../worker/leaderboard.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIG = path.join(ROOT, 'worker/migrations');

function runFile(db, file) {
  const text = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => !l.trim().startsWith('--')).join('\n');
  for (const stmt of text.split(';')) {
    const s = stmt.trim();
    if (!s) continue;
    try { db.exec(s); } catch (e) { if (!/duplicate column|already exists|no such table/i.test(e.message)) throw e; }
  }
}

/** The schema as it was before 0021. */
function legacyDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  runFile(db, path.join(ROOT, 'worker/schema.sql'));
  for (const m of fs.readdirSync(MIG).filter((f) => f.endsWith('.sql') && f < '0021').sort()) runFile(db, path.join(MIG, m));
  return db;
}

function d1(db) {
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => { const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
  });
  return { prepare: (sql) => stmt(sql), batch: async (list) => { const out = []; for (const s of list) out.push(await s.run()); return out; } };
}

async function token(payload) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const data = `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc({ ...payload, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 })}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('test-secret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return `${data}.${Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))).toString('base64url')}`;
}

function seed(db) {
  const run = (sql, ...a) => db.prepare(sql).run(...a);
  // Pete (1): Discord first, then Steam linked. Sam (2): Steam only. Kim (3): Google only.
  run("INSERT INTO users (id, provider, provider_id, display_name) VALUES (1, 'discord', 'd-pete', 'Pete'), (2, 'steam', 's-sam', 'Sam'), (3, 'google', 'g-kim', 'Kim')");
  run("INSERT INTO user_identities (id, user_id, provider, provider_id, display_name, email, scopes, said_hello_at) VALUES (11, 1, 'discord', 'd-pete', 'Pete', 'p@example.com', 'identify email', 1700), (12, 1, 'steam', 's-pete', 'pete_steam', NULL, NULL, NULL), (13, 2, 'steam', 's-sam', 'Sam', NULL, NULL, NULL), (14, 3, 'google', 'g-kim', 'Kim', NULL, NULL, NULL)");
  run("INSERT INTO scores (id, user_id, level_id, distance, time_ms, mode) VALUES (1, 1, 'grandma', 1200, 200000, 'captain'), (2, 2, 'grandma', 1200, 200000, 'stoker'), (3, 1, 'grandma', 900, 150000, 'solo')");
  run("INSERT INTO score_contributions (score_id, role, player_user_id) VALUES (1, 'captain', 1), (1, 'stoker', 2), (2, 'captain', 1), (2, 'stoker', 2), (3, 'solo', 1), (3, 'stoker', NULL)");
  run("INSERT INTO user_achievements (user_id, achievement_id, score_id) VALUES (1, 'first_finish', 1), (1, 'first_pedal', NULL), (2, 'first_finish', 2)");
  run("INSERT INTO daily_results (user_id, day_key, mode, time_ms, partner_user_id) VALUES (1, '2026-11-10', 'pair', 100000, 2), (2, '2026-11-10', 'pair', 100000, 1), (1, '2026-11-10', 'solo', 120000, NULL)");
  run("INSERT INTO friends (user_id, friend_id) VALUES (1, 2)");
  run("INSERT INTO pairs (user_lo, user_hi, rides, distance, best_json, last_ride, daily_best_streak) VALUES ('1', '2', 4, 4800, '{\"grandma\":190000}', '2026-11-10 10:00:00', 2)");
  run("INSERT INTO pairs (user_lo, user_hi, rides, distance) VALUES ('1', 'guest:dev-raw-1', 2, 2000), ('2', 'guest:h_aaaaaaaaaaaaaaaaaaaaaa', 3, 3000), ('guest:dev-raw-1', 'guest:h_aaaaaaaaaaaaaaaaaaaaaa', 1, 500), ('3', '999', 1, 100)");
  run("INSERT INTO game_achievements (user_id, game, achievement_id) VALUES (1, 'dice', 'roll'), (2, 'coins', 'jackpot')");
  run("INSERT INTO game_stats (user_id, game, stats_json) VALUES (1, 'tandemonium', '{\"rides\":7}'), (2, 'dice', '{\"rolls\":3}')");
  run("INSERT INTO game_playtime (user_id, game, seconds, sessions) VALUES (1, 'tandemonium', 600, 3), (2, 'dice', 90, 1)");
  run("INSERT INTO discord_posts (user_id, day_key, share_id, posted_at) VALUES (1, '2026-11-10', 'sh1', 5)");
  run("INSERT INTO sessions (id, started_at, google_uid) VALUES ('sess-1', '2026-11-10', '1')");
  run("INSERT INTO rides (id, session_id, level, input_method, started_at) VALUES ('ride-1', 'sess-1', 'grandma', 'k', '2026-11-10')");
  run("INSERT INTO ride_seats (ride_id, seat, user_id) VALUES ('ride-1', 1, 1), ('ride-1', 2, NULL)");
  run("INSERT INTO account_events (user_id, kind, provider, provider_id, undo_json, created_at, undo_until) VALUES (1, 'combine', 'steam', 's-pete', '{}', 100, 999999999999), (1, 'link', 'steam', 's-pete', NULL, 100, 999999999999)");
}

/** Per-account totals that must not change. */
function totals(db, logins) {
  const q = (sql) => db.prepare(sql).all().map((r) => ({ ...r }));
  return JSON.stringify({
    rides: q('SELECT user_id, COUNT(*) n, SUM(distance) d FROM scores GROUP BY user_id ORDER BY user_id'),
    contributions: q('SELECT player_user_id u, COUNT(*) n FROM score_contributions GROUP BY player_user_id ORDER BY player_user_id'),
    badges: q('SELECT user_id, COUNT(*) n FROM user_achievements GROUP BY user_id ORDER BY user_id'),
    daily: q('SELECT user_id, day_key, mode, time_ms, partner_user_id FROM daily_results ORDER BY user_id, day_key, mode'),
    games: q('SELECT user_id, game, achievement_id FROM game_achievements ORDER BY user_id, game'),
    stats: q('SELECT user_id, game, stats_json FROM game_stats ORDER BY user_id, game'),
    time: q('SELECT user_id, game, seconds, sessions FROM game_playtime ORDER BY user_id, game'),
    posts: q('SELECT user_id, day_key FROM discord_posts ORDER BY user_id'),
    logins: q(`SELECT user_id, provider, provider_id, email, scopes, said_hello_at FROM ${logins} WHERE provider != 'device' ORDER BY provider, provider_id`),
  });
}

test('0021 keeps every account’s totals, credits old rows to the earliest login, and turns guests into device logins', async () => {
  const db = legacyDb();
  seed(db);
  const before = totals(db, 'user_identities');
  runFile(db, path.join(MIG, '0021_logins.sql'));
  assert.equal(totals(db, 'user_logins'), before, 'no account gained or lost anything');

  // Old rows belong to the account's earliest login (Pete: his Discord, 11).
  const one = (sql, ...a) => ({ ...db.prepare(sql).get(...a) });
  assert.deepEqual(db.prepare('SELECT id, login_id FROM scores ORDER BY id').all().map((r) => r.login_id), [11, 13, 11]);
  assert.deepEqual(db.prepare('SELECT player_login_id l FROM score_contributions ORDER BY id').all().map((r) => r.l), [11, 13, 11, 13, 11, null]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM user_achievements WHERE login_id IS NULL').get().n, 0);
  assert.deepEqual(one("SELECT login_id, partner_login_id FROM daily_results WHERE user_id = 1 AND mode = 'pair'"), { login_id: 11, partner_login_id: 13 });
  assert.deepEqual(one('SELECT login_id, friend_login_id, user_id, friend_user_id FROM friends'), { login_id: 11, friend_login_id: 13, user_id: 1, friend_user_id: 2 });
  assert.deepEqual(db.prepare('SELECT seat, login_id FROM ride_seats ORDER BY seat').all().map((r) => r.login_id), [11, null]);
  assert.equal(one("SELECT login_id FROM game_stats WHERE game = 'tandemonium'").login_id, 11);
  assert.equal(one('SELECT login_id FROM discord_posts').login_id, 11);

  // Guests are device logins with small accounts of their own; their pair rows carried over.
  const guests = db.prepare("SELECT login_id, user_id, provider_id FROM user_logins WHERE provider = 'device' ORDER BY provider_id").all().map((r) => ({ ...r }));
  assert.deepEqual(guests.map((g) => g.provider_id), ['dev-raw-1', 'h_aaaaaaaaaaaaaaaaaaaaaa']);
  assert.equal(db.prepare("SELECT display_name FROM users WHERE id = ?").get(guests[0].user_id).display_name, 'Guest');
  const pairs = db.prepare('SELECT login_lo, login_hi, user_lo, user_hi, rides FROM pairs ORDER BY rides DESC').all().map((r) => ({ ...r }));
  assert.equal(pairs.length, 4, 'the row naming an account that no longer exists (999) is dropped');
  assert.deepEqual(pairs[0], { login_lo: 11, login_hi: 13, user_lo: 1, user_hi: 2, rides: 4 });
  for (const p of pairs) assert.ok(p.login_lo < p.login_hi);
  assert.equal(db.prepare('SELECT SUM(rides) n FROM pairs').get().n, 4 + 2 + 3 + 1);

  // An old-style combine can't be separated by the new code: its window is closed. A link's stays.
  assert.deepEqual(db.prepare('SELECT kind, undo_until > 1000 AS open FROM account_events ORDER BY id').all().map((r) => [r.kind, r.open]), [['combine', 0], ['link', 1]]);

  // The worker reads the migrated data: Pete's token from before (no lid) still works, and
  // new activity is recorded under the login the session names.
  const env = { DB: d1(db), CORS_ORIGIN: 'https://tandemonium.housetandem.com', JWT_SECRET: 'test-secret', RELAY_SECRET: 'r' };
  const call = (p, { method = 'GET', body, tok } = {}) => worker.fetch(new Request('https://api.test' + p, {
    method, headers: { 'CF-Connecting-IP': '1.2.3.4', Origin: 'https://tandemonium.housetandem.com', ...(tok ? { Authorization: 'Bearer ' + tok } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }), env, { waitUntil() {} });
  const old = await token({ sub: 1 });
  const me = await (await call('/me', { tok: old })).json();
  assert.equal(me.user.id, 1);
  assert.deepEqual(Object.keys(me.user.identities).sort(), ['discord', 'steam']);
  assert.equal(me.achievements.length, 2);
  assert.equal((await (await call('/pair?with=2', { tok: old })).json()).rides, 4);
  assert.equal((await (await call('/pair?with=guest%3Adev-raw-1', { tok: old })).json()).rides, 2);
  const board = await (await call('/daily?key=2026-11-10', { tok: old })).json();
  // Riders are named by public id; only Pete's own rows keep his account number.
  assert.deepEqual(board.results.map((r) => [r.pid === me.user.pid ? 'me' : 'partner', r.user_id ?? null, r.mode]).sort(),
    [['me', 1, 'pair'], ['me', 1, 'solo'], ['partner', null, 'pair']]);

  // A session names its login by id. A token from before login ids (even one that carries
  // `via`) is the account's first sign-in.
  const post = async (claims) => {
    db.prepare("UPDATE scores SET created_at = datetime('now', '-1 minute')").run();
    const res = await call('/score', { method: 'POST', tok: await token(claims), body: { levelId: 'grandma', distance: 1200, timeMs: 180000, mode: 'solo' } });
    assert.equal(res.status, 200, await res.clone().text());
    return one('SELECT user_id, login_id FROM scores ORDER BY id DESC LIMIT 1');
  };
  assert.deepEqual(await post({ sub: 1, lid: 12 }), { user_id: 1, login_id: 12 }, 'recorded under the login the session names');
  assert.deepEqual(await post({ sub: 1, via: 'steam:s-pete' }), { user_id: 1, login_id: 11 }, '`via` alone names no login: the first sign-in');
});

test('0021 on an empty database, and applied to the schema twice over, does not fail', () => {
  const db = legacyDb();
  runFile(db, path.join(MIG, '0021_logins.sql'));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM user_logins').get().n, 0);
  assert.ok(db.prepare("SELECT 1 FROM pragma_table_info('pairs') WHERE name = 'login_lo'").get());
});
