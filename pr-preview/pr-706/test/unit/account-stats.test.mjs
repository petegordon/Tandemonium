// housetandem-web #37 · lifetime stats and time in game on the House Tandem
// account: the merge rules, the synced baseline, the worker endpoint, and the
// original bug (signed out, the next ride re-awarded the device's badges to
// whoever signed in next).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import worker from '../../worker/leaderboard.js';
import { mergeStats, cleanClientDelta, capPlaySeconds, recordPlay, MAX_PLAY_REPORT_S, mergeGameAccounts } from '../../worker/games.js';
import {
  toAccountDelta, fromAccount, mergeAfterSync, baseFromAccount, baseAfterSend, emptyBase, hasCounters, tokenUser,
  ADD_KEYS, MAX_KEYS, OR_KEYS, UNION_KEYS, RECENT_KEYS, DEVICE_KEYS,
} from '../../js/account-stats.js';
import { emptyStats, applyEvent } from '../../js/achievement-defs.js';
import { createPlaytime } from '../../js/playtime.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SECRET = 'test-secret';

// ── a worker on an in-memory D1 ──────────────────────────────────

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
const envFor = (db) => ({ DB: d1(db), CORS_ORIGIN: '*', JWT_SECRET: SECRET, AUTH_LIMITER: allow, READ_LIMITER: allow });
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function jwt(sub) {
  const h = b64u({ alg: 'HS256', typ: 'JWT' });
  const p = b64u({ sub, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 });
  const sig = crypto.createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${sig}`;
}
function addUser(db, name) {
  const r = db.prepare("INSERT INTO users (provider, provider_id, display_name) VALUES ('discord', ?, ?)").run(name + Math.random(), name);
  return Number(r.lastInsertRowid);
}
const call = (env, p, { method = 'GET', body, token, text } = {}) => {
  const headers = { 'CF-Connecting-IP': '1.2.3.4', Origin: 'https://tandemonium.housetandem.com' };
  if (token) headers.Authorization = 'Bearer ' + token;
  let payload;
  if (text !== undefined) { payload = text; headers['Content-Type'] = 'text/plain'; }
  else if (body) { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
  return worker.fetch(new Request('https://api.test' + p, { method, headers, body: payload }), env, { waitUntil() {} });
};

// ── the rules ────────────────────────────────────────────────────

test('every lifetime stat has exactly one merge rule', () => {
  const ruled = [...ADD_KEYS, ...MAX_KEYS, ...OR_KEYS, ...UNION_KEYS, ...RECENT_KEYS, ...DEVICE_KEYS];
  assert.equal(new Set(ruled).size, ruled.length, 'a stat with two rules');
  const L = emptyStats();
  const handledElsewhere = new Set(['v', 'bests', 'bestsAt', 'lastDay', 'lastDailyDay', 'dailyDayRun']);
  for (const k of Object.keys(L)) if (!handledElsewhere.has(k)) assert.ok(ruled.includes(k), `${k} has no merge rule`);
});

test('a delta carries counters since the baseline; bests, sets and flags in full', () => {
  let L = emptyStats();
  L = applyEvent(L, 'ride', { newRide: true, metres: 400, mode: 'grandma' }, '2026-11-07');
  L = applyEvent(L, 'crash', {}, '2026-11-07');
  L = applyEvent(L, 'finish', { finishedLevel: 'daily', medal: 'gold' }, '2026-11-07');
  L = { ...L, pedalled: true, slingBest: 120, bests: { top_speed: 12.5 }, bestsAt: { top_speed: { level: 'grandma', at: 5 } } };
  const d = toAccountDelta(L, emptyBase());
  assert.deepEqual(d.add, { cumulativeDistance: 400, rides: 1, crashes: 1, finishes: 1 });
  assert.equal(d.max.days, 1);
  assert.equal(d.max.slingBest, 120);
  assert.deepEqual(d.or, { pedalled: 1 });
  assert.deepEqual(d.union.golds, ['daily']);
  assert.deepEqual(d.recent.dayList, ['2026-11-07']);
  assert.deepEqual(d.latest.dailyRun, ['2026-11-07', 1]);
  assert.deepEqual(d.maxmap.bests.top_speed, [12.5, 'grandma', 5]);
  // Synced: the counters aren't sent again.
  const again = toAccountDelta(L, baseFromAccount(L, '7'));
  assert.equal(hasCounters(again), false);
  assert.ok(cleanClientDelta(d), 'the server takes it');
});

test('two devices on one account: counters add, days are one per day, bests are the best', () => {
  const day = (L, k) => applyEvent(L, 'ride', { newRide: true, metres: 100, mode: 'grandma' }, k);
  let A = day(day(emptyStats(), '2026-11-01'), '2026-11-02');
  let B = day(emptyStats(), '2026-11-02');
  B = { ...B, bests: { top_speed: 20 } };
  A = { ...A, bests: { top_speed: 15 } };
  let T = {};
  T = mergeStats(T, toAccountDelta(A, emptyBase()));
  T = mergeStats(T, toAccountDelta(B, emptyBase()));
  const acct = fromAccount(T);
  assert.equal(acct.rides, 3);
  assert.equal(acct.cumulativeDistance, 300);
  assert.deepEqual(acct.dayList, ['2026-11-01', '2026-11-02']);
  assert.equal(acct.days, 2, 'the same day on two devices is one day');
  assert.equal(acct.bests.top_speed, 20);
  // A syncs again with no new rides: nothing is added twice.
  const baseA = baseFromAccount(T, '1');
  const A2 = mergeAfterSync(T, A, A);
  T = mergeStats(T, toAccountDelta(A2, baseA));
  assert.equal(fromAccount(T).rides, 3);
});

test('counts made while a sync is out are kept for the next one', () => {
  const S = applyEvent(emptyStats(), 'crash', {});
  const T = mergeStats({}, toAccountDelta(S, emptyBase()));
  const Lnow = applyEvent(applyEvent(S, 'crash', {}), 'boost', {});
  const R = mergeAfterSync(T, Lnow, S);
  assert.equal(R.crashes, 2);
  assert.equal(R.boosts, 1);
  const next = toAccountDelta(R, baseFromAccount(T, '1'));
  assert.deepEqual(next.add, { crashes: 1, boosts: 1, pickups: 1 });
});

test('a beacon counts as sent: lost, it loses a little; it never counts twice', () => {
  const L = applyEvent(emptyStats(), 'crash', {});
  const b = baseAfterSend(emptyBase('3'), L);
  assert.equal(hasCounters(toAccountDelta(L, b)), false);
  assert.equal(b.user, '3');
});

test('the client merge agrees with the worker merge for every non-counter', () => {
  const L = { ...emptyStats(), days: 4, dayList: ['2026-11-05', '2026-11-06'], golds: ['grandma'], pedalled: true,
    lastDailyDay: '2026-11-06', dailyDayRun: 2, lastDay: '2026-11-06', bests: { a_b: 3 }, bestsAt: {} };
  const T = { days: 5, dayList: ['2026-11-01'], golds: ['daily'], dailyRun: ['2026-11-04', 5], lastDay: ['2026-11-04', null], bests: { a_b: [2] } };
  const client = mergeAfterSync(T, L, L);
  const server = fromAccount(mergeStats(T, toAccountDelta(L, baseFromAccount(T, '1'))));
  for (const k of [...MAX_KEYS, ...OR_KEYS, 'dayList', 'lastDailyDay', 'dailyDayRun', 'lastDay']) assert.deepEqual(client[k], server[k], k);
  assert.deepEqual([...client.golds].sort(), [...server.golds].sort());
  assert.equal(client.bests.a_b, server.bests.a_b);
});

test('the worker keeps the newest 60 days, the newest daily run, and refuses junk deltas', () => {
  const days = Array.from({ length: 80 }, (_, i) => `2026-0${1 + Math.floor(i / 28)}-${String(1 + (i % 28)).padStart(2, '0')}`);
  const T = mergeStats({}, { recent: { dayList: days } });
  assert.equal(T.dayList.length, 60);
  assert.equal(T.dayList[59], days[79]);
  const U = mergeStats({ dailyRun: ['2026-11-06', 4] }, { latest: { dailyRun: ['2026-11-05', 9] } });
  assert.deepEqual(U.dailyRun, ['2026-11-06', 4]);
  assert.equal(cleanClientDelta([]), null);
  assert.deepEqual(cleanClientDelta({ add: { rides: -5, crashes: 1e12, ok: 2 } }), { add: { ok: 2 } });
});

// ── time in game ─────────────────────────────────────────────────

test('time in game: deltas capped to real time; sessions after a 30-minute gap', async () => {
  assert.equal(capPlaySeconds(60, null, 0), 60);
  assert.equal(capPlaySeconds(5000, null, 0), MAX_PLAY_REPORT_S);
  assert.equal(capPlaySeconds(60, 1_000_000, 1_000_000 + 30_000), 35, '30 s since the last report + 5 s slack');
  assert.equal(capPlaySeconds(-4, null, 0), 0);
  const db = freshDb();
  const env = envFor(db);
  const u = addUser(db, 'Pat');
  const t0 = Date.parse('2026-11-08T12:00:00Z');
  let p = await recordPlay(env, u, 'dice', 60, t0);
  assert.deepEqual([p.seconds, p.sessions, p.added], [60, 1, 60]);
  p = await recordPlay(env, u, 'dice', 60, t0 + 60_000);
  assert.deepEqual([p.seconds, p.sessions], [120, 1]);
  // A second device reporting the same minute: only the real time since the last report counts.
  p = await recordPlay(env, u, 'dice', 60, t0 + 61_000);
  assert.equal(p.added, 6);
  p = await recordPlay(env, u, 'dice', 60, t0 + 3_600_000);
  assert.deepEqual([p.seconds, p.sessions], [186, 2]);
  await assert.rejects(recordPlay(env, u, 'nope', 10, t0));
});

test('POST /games/:game/sync: time for any House Tandem game, stats for Tandemonium only; /me/games shows both', async () => {
  const db = freshDb();
  const env = envFor(db);
  const u = addUser(db, 'Pat');
  const token = jwt(u);
  assert.equal((await call(env, '/games/dice/sync', { method: 'POST', body: { seconds: 30 } })).status, 401);
  let r = await call(env, '/games/dice/sync', { method: 'POST', body: { seconds: 30 }, token });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).playtime.seconds, 30);
  // sendBeacon: the token in a text/plain body.
  r = await call(env, '/games/tandemonium/sync', { method: 'POST', text: JSON.stringify({ token, seconds: 20, delta: { add: { rides: 2 }, max: { slingBest: 50 } } }) });
  const body = await r.json();
  assert.equal(r.status, 200);
  assert.equal(body.stats.rides, 2);
  assert.equal(body.playtime.seconds, 20);
  // Another game's stats can't be written from a client.
  r = await call(env, '/games/dice/sync', { method: 'POST', body: { delta: { add: { wins: 99 } } }, token });
  assert.equal((await r.json()).stats, undefined);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM game_stats WHERE game = 'dice'").get().n, 0);
  assert.equal((await call(env, '/games/notagame/sync', { method: 'POST', body: {}, token })).status, 404);
  db.prepare("INSERT INTO user_achievements (user_id, achievement_id) VALUES (?, 'first_500m')").run(u);
  const me = await (await call(env, '/me/games', { token })).json();
  assert.equal(me.games.tandemonium.stats.rides, 2);
  assert.equal(me.games.tandemonium.playtime.seconds, 20);
  assert.deepEqual(me.games.tandemonium.earned.map((e) => e.id), ['first_500m']);
  assert.equal(me.games.dice.playtime.seconds, 30);
  // Deleting the account takes the time with it.
  r = await call(env, '/me/delete', { method: 'POST', body: { confirm: 'DELETE' }, token });
  assert.equal(r.status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM game_playtime').get().n, 0);
});

test('an account merge moves the games\' rows (achievements join, time adds up)', async () => {
  const db = freshDb();
  const env = envFor(db);
  const a = addUser(db, 'A'), b = addUser(db, 'B');
  const t0 = Date.parse('2026-11-08T12:00:00Z');
  await recordPlay(env, a, 'dice', 100, t0);
  await recordPlay(env, b, 'dice', 50, t0);
  await recordPlay(env, b, 'coins', 40, t0);
  db.prepare("INSERT INTO game_achievements (user_id, game, achievement_id) VALUES (?, 'dice', 'x')").run(b);
  db.prepare("INSERT INTO game_stats (user_id, game, stats_json) VALUES (?, 'coins', '{\"games\":3}')").run(b);
  await mergeGameAccounts(env, b, a);
  db.prepare('DELETE FROM users WHERE id = ?').run(b);   // what mergeAccounts does next: no rows left to block it
  const rows = db.prepare('SELECT game, seconds FROM game_playtime WHERE user_id = ? ORDER BY game').all(a);
  assert.deepEqual(rows.map((r) => [r.game, r.seconds]), [['coins', 40], ['dice', 150]]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM game_achievements WHERE user_id = ?').get(a).n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM game_stats WHERE user_id = ?').get(a).n, 1);
});

test('the playtime helper counts visible, non-idle time and reports whole seconds', async () => {
  let t = 0;
  const doc = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };
  const sent = [];
  const pt = createPlaytime({ game: 'dice', send: (s, info) => { sent.push([s, info.final]); return true; }, idleMs: 60_000, reportMs: 60_000, now: () => t, doc, win: {} });
  pt.start();
  for (let i = 0; i < 12; i++) { t += 5000; pt._tick(); }
  assert.deepEqual(sent, [[60, false]]);
  // Idle (no input for over a minute): nothing more counts.
  for (let i = 0; i < 24; i++) { t += 5000; pt._tick(); }
  assert.ok(pt.pending <= 1, `idle time counted: ${pt.pending}`);
  pt.noteActivity();
  doc.visibilityState = 'hidden';
  for (let i = 0; i < 12; i++) { t += 5000; pt._tick(); }
  assert.ok(pt.pending <= 1, 'hidden time counted');
  doc.visibilityState = 'visible';
  pt.noteActivity();
  t += 5000; pt._tick(); t += 5000; pt._tick();
  pt.stop();
  assert.equal(sent.reduce((a, x) => a + x[0], 0), 70, 'one minute, then ten seconds after coming back');
  assert.equal(sent.at(-1)[1], true, 'the rest goes on stop / page hide');
  // Signed out: nothing counts.
  const none = [];
  const off = createPlaytime({ game: 'dice', send: (s) => { none.push(s); return true; }, signedIn: () => false, now: () => t, doc, win: {} });
  off.start(); for (let i = 0; i < 20; i++) { t += 5000; off._tick(); } off.stop();
  assert.deepEqual(none, []);
});

test('tokenUser reads the account id from a session token', () => {
  assert.equal(tokenUser(jwt(42)), '42');
  assert.equal(tokenUser('junk'), null);
});

// ── the manager against the worker: the original bug ─────────────

function fakeStorage(seed = {}) {
  const m = new Map(Object.entries(seed));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m };
}

test('sign out → a ride doesn\'t re-award to the next account; sign back in → the progress returns', async () => {
  const db = freshDb();
  const env = envFor(db);
  const pat = addUser(db, 'Pat'), sam = addUser(db, 'Sam');
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const u = new URL(String(input && input.url ? input.url : input));
    return worker.fetch(new Request('https://api.test' + u.pathname, { ...init, headers: { ...(init && init.headers), 'CF-Connecting-IP': '1.2.3.4' } }), env, { waitUntil() {} });
  };
  globalThis.localStorage = fakeStorage({});
  try {
    const { AchievementManager } = await import('../../js/achievements.js');
    let token = jwt(pat);
    const m = new AchievementManager().setIdentity({ getToken: () => token });
    const toasts = [];
    m.onEarned = (a) => toasts.push(a.id);
    // Pat rides 600 m: First 500m, toasted once.
    m.record('ride', { newRide: true, metres: 600, mode: 'grandma' });
    assert.ok(m.getEarnedIds().includes('first_500m'));
    let r = await m.syncStats();
    assert.equal(r.ok, true);
    await m.syncToServer();
    assert.equal(fromAccount(JSON.parse(db.prepare("SELECT stats_json s FROM game_stats WHERE user_id = ?").get(pat).s)).cumulativeDistance, 600);

    // Sign out (lobby's handler): push, clear, reset.
    await m.syncStats();
    m.clear();
    m.resetStats();
    token = null;
    assert.equal(m.getStats().cumulativeDistance, 0);
    // A new manager on this device (a reload) doesn't re-seed old numbers either.
    const reloaded = new AchievementManager();
    assert.equal(reloaded.getStats().cumulativeDistance, 0);

    // A short ride signed out: no badge comes back from Pat's numbers.
    m.record('ride', { newRide: true, metres: 100, mode: 'grandma' });
    assert.ok(!m.getEarnedIds().includes('first_500m'), 'Pat\'s 600 m re-awarded First 500m after sign-out');

    // Sam signs in: Sam gets the 100 m ridden signed out, not Pat's 600.
    token = jwt(sam);
    r = await m.syncStats();
    assert.equal(r.ok, true);
    assert.equal(m.getStats().cumulativeDistance, 100);
    assert.ok(!m.getEarnedIds().includes('first_500m'));
    // ...and a second sync adds nothing twice.
    await m.syncStats();
    assert.equal(fromAccount(JSON.parse(db.prepare("SELECT stats_json s FROM game_stats WHERE user_id = ?").get(sam).s)).cumulativeDistance, 100);

    // Sam signs out; Pat signs back in: Pat's 600 m come back, and the badge they earn comes quietly.
    await m.syncStats(); m.clear(); m.resetStats(); token = null;
    toasts.length = 0;
    token = jwt(pat);
    r = await m.syncStats();
    assert.equal(m.getStats().cumulativeDistance, 600);
    assert.ok(r.newlyEarned.some((a) => a.id === 'first_500m'));
    assert.deepEqual(toasts, [], 'a sign-in merge toasts nothing; the lobby shows one note');

    // Another account signs in on top without a sign-out (no lobby handler ran): its numbers aren't added to Sam.
    token = jwt(sam);
    await m.syncStats();
    assert.equal(fromAccount(JSON.parse(db.prepare("SELECT stats_json s FROM game_stats WHERE user_id = ?").get(sam).s)).cumulativeDistance, 100);
    assert.equal(m.getStats().cumulativeDistance, 100);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a page-hide beacon while a sync is out never sends the same counts twice', async () => {
  const db = freshDb();
  const env = envFor(db);
  const pat = addUser(db, 'Pat');
  const realFetch = globalThis.fetch;
  const realNav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let release;
  const gate = new Promise((r) => { release = r; });
  const toWorker = async (input, init) => {
    const u = new URL(String(input && input.url ? input.url : input));
    return worker.fetch(new Request('https://api.test' + u.pathname, { ...init, headers: { ...(init && init.headers), 'CF-Connecting-IP': '1.2.3.4' } }), env, { waitUntil() {} });
  };
  const beacons = [];
  globalThis.fetch = async (input, init) => { await gate; return toWorker(input, init); };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { sendBeacon: (url, blob) => { beacons.push(blob.text().then((t) => toWorker(url, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: t }))); return true; } } });
  globalThis.localStorage = fakeStorage({});
  try {
    const { AchievementManager } = await import('../../js/achievements.js');
    const token = jwt(pat);
    const m = new AchievementManager().setIdentity({ getToken: () => token });
    m.record('crash', {});
    const syncing = m.syncStats();          // out, held at the gate
    m.record('crash', {});                  // one more while it's out
    assert.equal(m.flushStatsBeacon(), true);
    await Promise.all(beacons);             // the beacon lands first
    release();
    await syncing;
    await m.syncStats();
    const acct = fromAccount(JSON.parse(db.prepare('SELECT stats_json s FROM game_stats WHERE user_id = ?').get(pat).s));
    assert.equal(acct.crashes, 2, 'each crash counted once');
    assert.equal(m.getStats().crashes, 2);
  } finally {
    globalThis.fetch = realFetch;
    if (realNav) Object.defineProperty(globalThis, 'navigator', realNav); else delete globalThis.navigator;
  }
});
