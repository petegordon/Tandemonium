// #890 · the open ride row and the session's end are saved when the game goes away: the
// desktop app's quit (whose keepalive requests used to be dropped as the app exited), a
// browser tab closing (pagehide + sendBeacon), and a phone hiding the page (a provisional
// save the ride's real end overwrites).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import worker, { analyticsWriteMethod } from '../../worker/leaderboard.js';

const require = createRequire(import.meta.url);
const { createExitFlush } = require('../../electron/exit-flush.js');
const read = (p) => readFileSync(new URL('../../' + p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

// ---- the analytics client ----

let loads = 0;
/** A fresh analytics module in a stand-in page: a phone browser, or the desktop app. */
async function page({ electron = false, beacon = true } = {}) {
  const calls = [];
  const handlers = {};
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ via: 'fetch', url: String(url), method: init.method, body: JSON.parse(init.body) });
    return { ok: true, status: 200, headers: { get: () => null } };
  };
  const nav = { userAgent: electron ? 'Mozilla/5.0 Electron/33.2.1' : 'Mozilla/5.0 (iPhone) Mobile Safari' };
  if (beacon) nav.sendBeacon = (url, body) => { calls.push({ via: 'beacon', url: String(url), method: 'POST', body: JSON.parse(body) }); return true; };
  Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true });
  globalThis.sessionStorage = { getItem: () => null, setItem: () => {} };
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  globalThis.setInterval = () => 0;
  globalThis.document = { visibilityState: 'visible' };
  let quitHook = null;
  globalThis.window = {
    addEventListener: (type, fn) => { (handlers[type] ||= []).push(fn); },
    electronApp: electron ? { onFlushBeforeQuit: (cb) => { quitHook = cb; } } : undefined,
  };
  const a = await import(`../../js/analytics.js?page=${++loads}`);
  a.initSession({ device_type: electron ? 'desktop' : 'phone' });
  a.setAnalyticsAllowed(true);
  const fire = (type, e = {}) => { for (const fn of handlers[type] || []) fn(e); };
  const writes = () => calls.filter((c) => !(c.method === 'POST' && /\/session$/.test(c.url)));
  return { a, calls, writes, fire, quitHook: () => quitHook };
}

const snapshot = (reason) => ({ completed: false, abandon_reason: reason, distance: 412.5, crash_count: 2, pedal_taps: 300 });

test('a tab closing mid-ride: the ride closes with what it knows and the session ends, by beacon, once', async () => {
  const { a, writes, fire } = await page();
  a.setRideSnapshot(snapshot);
  const rid = a.startRide({ level: 'grandma' });
  a.trackRideEvent('crash', 100);
  const before = writes().length;

  fire('pagehide');
  fire('pagehide');   // a second close (or beforeunload, or the app's quit) sends nothing more
  const sent = writes().slice(before);
  assert.ok(sent.every((c) => c.via === 'beacon'), 'all by sendBeacon');
  const ride = sent.find((c) => c.url.endsWith(`/ride/${rid}`));
  assert.equal(ride.method, 'POST', 'sendBeacon can only POST');
  assert.equal(ride.body.abandon_reason, 'page_close');
  assert.equal(ride.body.completed, false);
  assert.equal(ride.body.distance, 412.5);
  assert.equal(ride.body.crash_count, 2);
  assert.ok(ride.body.ended_at);
  assert.equal(typeof ride.body.duration_ms, 'number');
  assert.equal(ride.body.provisional, undefined);
  assert.ok(sent.find((c) => c.url.endsWith(`/ride/${rid}/events`)), 'the ride events go too');
  assert.equal(sent.filter((c) => /\/session\/[^/]+$/.test(c.url)).length, 1);
  assert.ok(sent.find((c) => /\/session\/[^/]+$/.test(c.url)).body.ended_at);
  assert.equal(sent.filter((c) => c.url.endsWith(`/ride/${rid}`)).length, 1);
  assert.equal(a.getCurrentRideId(), null);
});

test('a phone hiding the page saves the ride provisionally and keeps riding', async () => {
  const { a, writes, fire } = await page();
  a.setRideSnapshot(snapshot);
  const rid = a.startRide({ level: 'grandma' });
  const before = writes().length;

  globalThis.document.visibilityState = 'hidden';
  fire('visibilitychange');
  let sent = writes().slice(before);
  const ride = sent.find((c) => c.url.endsWith(`/ride/${rid}`));
  assert.equal(ride.body.abandon_reason, 'page_hidden');
  assert.equal(ride.body.provisional, true, 'not counted as a ride end');
  assert.equal(ride.body.distance, 412.5);
  assert.ok(ride.body.ended_at);
  assert.ok(sent.find((c) => /\/session\/[^/]+$/.test(c.url)).body.ended_at);
  assert.equal(a.getCurrentRideId(), rid, 'the ride carries on');

  // Back, and the ride ends for real: its end overwrites the provisional one.
  globalThis.document.visibilityState = 'visible';
  fire('visibilitychange');
  const mark = writes().length;
  a.endRide({ completed: true, duration_ms: 90000 });
  sent = writes().slice(mark);
  const end = sent.find((c) => c.url.endsWith(`/ride/${rid}`));
  assert.equal(end.method, 'PUT');
  assert.equal(end.body.completed, true);
  assert.equal(end.body.provisional, undefined);

  // Hidden again with no ride: only the session's end.
  const mark2 = writes().length;
  globalThis.document.visibilityState = 'hidden';
  fire('visibilitychange');
  sent = writes().slice(mark2);
  assert.ok(sent.every((c) => !/\/ride\//.test(c.url)));
  assert.equal(sent.filter((c) => /\/session\/[^/]+$/.test(c.url)).length, 1);
});

test('no sendBeacon (or a refused one): the same writes go by fetch keepalive', async () => {
  const { a, writes, fire } = await page({ beacon: false });
  const rid = a.startRide({ level: 'grandma' });
  const before = writes().length;
  fire('pagehide');
  const ride = writes().slice(before).find((c) => c.url.endsWith(`/ride/${rid}`));
  assert.equal(ride.via, 'fetch');
  assert.equal(ride.method, 'PUT');
  assert.equal(ride.body.abandon_reason, 'page_close', 'no snapshot: still closed with its reason');
});

test('the desktop app: its quit hook saves by fetch, waits for the replies, and the window close after it sends nothing', async () => {
  const { a, writes, fire, quitHook } = await page({ electron: true });
  assert.equal(typeof quitHook(), 'function', 'registered with the preload');
  a.setRideSnapshot(snapshot);
  const rid = a.startRide({ level: 'grandma' });
  a.trackEvent('app_quit', { from: 'lobby' });
  const before = writes().length;

  const done = quitHook()('app_quit');
  assert.ok(done && typeof done.then === 'function', 'main waits on it');
  await done;
  const sent = writes().slice(before);
  assert.ok(sent.every((c) => c.via === 'fetch'));
  const ride = sent.find((c) => c.url.endsWith(`/ride/${rid}`));
  assert.equal(ride.method, 'PUT');
  assert.equal(ride.body.abandon_reason, 'app_quit');
  assert.equal(ride.body.distance, 412.5);
  assert.ok(sent.find((c) => c.url.endsWith('/event/batch')).body.events.some((e) => e.event_type === 'app_quit'));
  assert.ok(sent.find((c) => /\/session\/[^/]+$/.test(c.url)).body.ended_at);

  const after = writes().length;
  globalThis.document.visibilityState = 'hidden';
  fire('visibilitychange');
  fire('pagehide');
  assert.equal(writes().length, after, 'already saved');
});

test('a hung network does not hold the quit: the hook settles within a second', async () => {
  const { a, quitHook } = await page({ electron: true });
  a.startRide({ level: 'grandma' });
  globalThis.fetch = () => new Promise(() => {});   // never answers
  const t0 = Date.now();
  await quitHook()('window_close');
  const took = Date.now() - t0;
  assert.ok(took >= 900 && took < 1150, `took ${took} ms`);
});

// ---- the desktop app's quit wait (electron/exit-flush.js) ----

function fakeTimers() {
  const pending = new Map();
  let id = 0;
  return {
    setTimer: (fn, ms) => { pending.set(++id, { fn, ms }); return id; },
    clearTimer: (t) => pending.delete(t),
    fire: () => { for (const [k, t] of [...pending]) { pending.delete(k); t.fn(); } },
    pending,
  };
}

test('the close is held once while the page saves, then goes on when it answers', () => {
  const timers = fakeTimers();
  const asked = [];
  let closes = 0;
  const f = createExitFlush({ ask: (r) => { asked.push(r); return true; }, finish: () => { closes++; }, ...timers });
  assert.equal(f.begin('app_quit'), false, 'held');
  assert.deepEqual(asked, ['app_quit']);
  assert.equal([...timers.pending.values()][0].ms, 1200);
  assert.equal(f.begin('window_close'), false, 'a second close while saving: still held, not asked again');
  assert.equal(asked.length, 1);
  f.answered();
  assert.equal(closes, 1);
  assert.equal(timers.pending.size, 0, 'the timeout is cleared');
  assert.equal(f.begin('window_close'), true, 'the close it makes goes through');
  f.answered();
  assert.equal(closes, 1);
});

test('a page that never answers: the close goes on after the timeout', () => {
  const timers = fakeTimers();
  let closes = 0;
  const logs = [];
  const f = createExitFlush({ ask: () => true, finish: () => { closes++; }, log: (m) => logs.push(m), timeoutMs: 1200, ...timers });
  assert.equal(f.begin('window_close'), false);
  timers.fire();
  assert.equal(closes, 1);
  assert.match(logs.join('\n'), /timed out/);
  f.answered();   // a late answer changes nothing
  assert.equal(closes, 1);
  assert.equal(f.begin('window_close'), true);
});

test('no page to ask (crashed or gone): the close is never held', () => {
  let closes = 0;
  const f = createExitFlush({ ask: () => false, finish: () => { closes++; } });
  assert.equal(f.begin('window_close'), true);
  assert.equal(closes, 0);
  const g = createExitFlush({ ask: () => { throw new Error('destroyed'); }, finish: () => { closes++; } });
  assert.equal(g.begin('window_close'), true);
});

test('main holds the window close, preload always answers, analytics registers', () => {
  const main = read('electron/main.js');
  assert.match(main, /require\('\.\/exit-flush'\)/);
  assert.match(main, /win\.on\('close', \(event\) => \{\n\s+if \(!exitFlush\.begin\(_exitReason \|\| 'window_close'\)\) event\.preventDefault\(\);/);
  assert.match(main, /ipcMain\.on\('app:flushedBeforeQuit'/);
  assert.match(main, /win\.on\('session-end'/);
  assert.match(main, /ipcMain\.on\('app:quit', \(\) => \{[^\n]*_exitReason = 'app_quit'; app\.quit\(\);/);
  const preload = read('electron/preload.js');
  assert.match(preload, /ipcRenderer\.on\('app:flushBeforeQuit'/);
  assert.match(preload, /onFlushBeforeQuit:/);
  // The answer is sent after the hooks whatever they do (no early return before it).
  const handler = preload.slice(preload.indexOf("ipcRenderer.on('app:flushBeforeQuit'"));
  assert.match(handler.slice(0, handler.indexOf('\n});')), /\} catch \(e\) \{\}\n  ipcRenderer\.send\('app:flushedBeforeQuit'\);/);
  const game = read('js/game.js');
  assert.match(game, /analytics\.setRideSnapshot\(\(reason\) => this\._rideAnalyticsRow\(reason\)\)/);
  assert.doesNotMatch(read('js/analytics.js'), /addEventListener\('beforeunload'/);
});

// ---- the API takes the beacon ----

test('a POST to a session or ride address is its update (sendBeacon); other routes keep their method', () => {
  assert.equal(analyticsWriteMethod('/api/analytics/session/abc', 'POST'), 'PUT');
  assert.equal(analyticsWriteMethod('/api/analytics/ride/abc', 'POST'), 'PUT');
  assert.equal(analyticsWriteMethod('/api/analytics/ride/abc', 'PUT'), 'PUT');
  assert.equal(analyticsWriteMethod('/api/analytics/session', 'POST'), 'POST');
  assert.equal(analyticsWriteMethod('/api/analytics/ride', 'POST'), 'POST');
  assert.equal(analyticsWriteMethod('/api/analytics/ride/abc/events', 'POST'), 'POST');
  assert.equal(analyticsWriteMethod('/api/analytics/room/ABCD', 'POST'), 'POST');
});

test('the worker saves a beacon POST like the PUT, and a provisional save is not a ride end metric', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const fs = await import('node:fs');
  const root = new URL('../../', import.meta.url);
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(fs.readFileSync(new URL('worker/schema.sql', root), 'utf8'));
  const migDir = new URL('worker/migrations/', root);
  for (const m of fs.readdirSync(migDir).sort()) {
    const text = fs.readFileSync(new URL(m, migDir), 'utf8').split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    for (const stmt of text.split(';')) {
      const s = stmt.trim();
      if (!s) continue;
      try { db.exec(s); } catch (e) { if (!/duplicate column|already exists|no such table/i.test(e.message)) throw e; }
    }
  }
  const bound = (sql, args) => ({
    _sql: sql, _args: args,
    run: async () => { db.prepare(sql).run(...args); return { success: true }; },
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
  });
  const metrics = [];
  const env = {
    CORS_ORIGIN: '*',
    ANALYTICS: { writeDataPoint: (p) => metrics.push(p) },
    DB: {
      prepare: (sql) => ({ bind: (...args) => bound(sql, args.map((x) => (x === undefined ? null : x))), ...bound(sql, []) }),
      batch: async (stmts) => { for (const s of stmts) db.prepare(s._sql).run(...s._args); return stmts.map(() => ({ success: true })); },
    },
  };
  // sendBeacon's request: POST, text/plain;charset=UTF-8.
  const send = (p, body, method = 'POST') => worker.fetch(new Request('https://api.test' + p, {
    method, headers: { 'Content-Type': 'text/plain;charset=UTF-8', 'CF-Connecting-IP': '1.2.3.4' }, body: JSON.stringify(body),
  }), env, { waitUntil() {} });

  const SID = '11111111-2222-4333-8444-555555555555';
  const RID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  assert.equal((await send('/api/analytics/session', { id: SID, device_type: 'phone' })).status, 200);
  assert.equal((await send('/api/analytics/ride', { id: RID, session_id: SID, level: 'grandma' })).status, 200);

  const rideEnds = () => metrics.filter((m) => JSON.stringify(m).includes('analytics_ride_end')).length;
  const m0 = rideEnds();
  assert.equal((await send(`/api/analytics/ride/${RID}`, { completed: false, abandon_reason: 'page_hidden', distance: 50, ended_at: '2026-11-27T10:00:00.000Z', provisional: true })).status, 200);
  assert.equal(db.prepare('SELECT abandon_reason r, distance d FROM rides WHERE id = ?').get(RID).r, 'page_hidden');
  assert.equal(rideEnds(), m0, 'a provisional save is not a ride end');

  assert.equal((await send(`/api/analytics/ride/${RID}`, { completed: false, abandon_reason: 'page_close', distance: 120.5, duration_ms: 61000, ended_at: '2026-11-27T10:01:00.000Z' })).status, 200);
  const ride = db.prepare('SELECT * FROM rides WHERE id = ?').get(RID);
  assert.equal(ride.abandon_reason, 'page_close');
  assert.equal(ride.distance, 120.5);
  assert.equal(ride.duration_ms, 61000);
  assert.equal(ride.ended_at, '2026-11-27T10:01:00.000Z');

  assert.equal((await send(`/api/analytics/session/${SID}`, { ended_at: '2026-11-27T10:01:01.000Z' })).status, 200);
  assert.equal(db.prepare('SELECT ended_at FROM sessions WHERE id = ?').get(SID).ended_at, '2026-11-27T10:01:01.000Z');

  // The PUT installed builds send still works.
  assert.equal((await send(`/api/analytics/session/${SID}`, { ended_at: '2026-11-27T10:02:00.000Z' }, 'PUT')).status, 200);
  assert.equal(db.prepare('SELECT ended_at FROM sessions WHERE id = ?').get(SID).ended_at, '2026-11-27T10:02:00.000Z');
});
