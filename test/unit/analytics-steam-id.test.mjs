// #889 · the Steam build records the player's SteamID64 with the analytics session, signed in
// or not. Analytics only: the worker keeps a well-formed id and nothing else, works before the
// migration adds the column, never changes an id once set, and an account delete clears it.
// The client sends it only when the Electron preload (window.steam) has one.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import worker, { analyticsSteamId } from '../../worker/leaderboard.js';
import { signToken } from '../../worker/room-proof.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIGRATION = '0025_session_steam_id.sql';

/** The real schema + migrations in an in-memory SQLite, foreign keys ON (as D1). `skip`: leave one out. */
function freshDb({ skip = null } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(fs.readFileSync(path.join(ROOT, 'worker/schema.sql'), 'utf8'));
  for (const m of fs.readdirSync(path.join(ROOT, 'worker/migrations')).sort()) {
    if (m === skip) continue;
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

const SECRET = 'steam-id-secret';
const envFor = (db) => ({ DB: d1(db), CORS_ORIGIN: '*', JWT_SECRET: SECRET });
const send = (env, p, body, method = 'POST', headers = {}) => worker.fetch(new Request('https://api.test' + p, {
  method, headers: { 'Content-Type': 'text/plain', 'CF-Connecting-IP': '1.2.3.4', ...headers }, body: JSON.stringify(body),
}), env, { waitUntil() {} });

const SID = '11111111-2222-4333-8444-555555555555';
const STEAM = '76561197960287930';     // Valve's documented example id, not a player
const STEAM2 = '76561198000000001';
const created = (extra = {}) => ({ id: SID, started_at: '2026-11-27T10:00:00.000Z', platform: 'steam', user_agent: 'Electron', device_id: 'dev-1', ...extra });
const steamOf = (db, id = SID) => db.prepare('SELECT steam_id FROM sessions WHERE id = ?').get(id)?.steam_id;

test('only a SteamID64 string is accepted', () => {
  assert.equal(analyticsSteamId(STEAM), STEAM);
  assert.equal(analyticsSteamId(' ' + STEAM + ' '), STEAM);
  for (const bad of [null, undefined, '', '0', '123', 76561197960287930, '7656119796028793', '765611979602879300',
    '86561197960287930', '7656119796028793x', { id: STEAM }, [STEAM]]) {
    assert.equal(analyticsSteamId(bad), null, String(bad));
  }
});

test('a session create stores the Steam ID', async () => {
  const db = freshDb();
  const res = await send(envFor(db), '/api/analytics/session', created({ steam_id: STEAM }));
  assert.equal(res.status, 200);
  assert.equal(steamOf(db), STEAM);
});

test('anything that is not a SteamID64 is dropped and the session is still stored', async () => {
  const db = freshDb();
  for (const [i, bad] of ['0', '12345', '<b>76561197960287930</b>', 76561197960287930].entries()) {
    const id = SID.slice(0, -1) + i;
    assert.equal((await send(envFor(db), '/api/analytics/session', created({ id, steam_id: bad }))).status, 200);
    assert.equal(db.prepare('SELECT platform FROM sessions WHERE id = ?').get(id).platform, 'steam');
    assert.equal(steamOf(db, id), null);
  }
});

test('a browser session without one is unchanged', async () => {
  const db = freshDb();
  assert.equal((await send(envFor(db), '/api/analytics/session', created({ platform: 'browser' }))).status, 200);
  assert.equal(steamOf(db), null);
});

test('a late Steam ID arrives on the session update', async () => {
  const db = freshDb();
  const env = envFor(db);
  await send(env, '/api/analytics/session', created());
  assert.equal(steamOf(db), null);
  assert.equal((await send(env, `/api/analytics/session/${SID}`, { steam_id: STEAM }, 'PUT')).status, 200);
  assert.equal(steamOf(db), STEAM);
});

test('an update that beats its create keeps the Steam ID through the create', async () => {
  const db = freshDb();
  const env = envFor(db);
  assert.equal((await send(env, `/api/analytics/session/${SID}`, { steam_id: STEAM }, 'PUT')).status, 200);
  await send(env, '/api/analytics/session', created());
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(SID);
  assert.equal(row.steam_id, STEAM);
  assert.equal(row.user_agent, 'Electron', 'the create filled the placeholder in');
});

test('a session never changes its Steam ID', async () => {
  const db = freshDb();
  const env = envFor(db);
  await send(env, '/api/analytics/session', created({ steam_id: STEAM }));
  await send(env, `/api/analytics/session/${SID}`, { steam_id: STEAM2 }, 'PUT');
  await send(env, '/api/analytics/session', created({ steam_id: STEAM2 }));
  assert.equal(steamOf(db), STEAM);
});

test('before migration 0025 the worker stores the session without it', async () => {
  const db = freshDb({ skip: MIGRATION });
  const env = envFor(db);
  assert.ok(!db.prepare('PRAGMA table_info(sessions)').all().some((c) => c.name === 'steam_id'));
  assert.equal((await send(env, '/api/analytics/session', created({ steam_id: STEAM }))).status, 200);
  assert.equal(db.prepare('SELECT user_agent FROM sessions WHERE id = ?').get(SID).user_agent, 'Electron');
  assert.equal((await send(env, `/api/analytics/session/${SID}`, { steam_id: STEAM, ended_at: '2026-11-27T11:00:00.000Z' }, 'PUT')).status, 200);
  assert.equal(db.prepare('SELECT ended_at FROM sessions WHERE id = ?').get(SID).ended_at, '2026-11-27T11:00:00.000Z');
});

test('the migration adds a nullable, indexed column', () => {
  const db = freshDb();
  const col = db.prepare('PRAGMA table_info(sessions)').all().find((c) => c.name === 'steam_id');
  assert.ok(col);
  assert.equal(col.notnull, 0);
  assert.ok(db.prepare('PRAGMA index_list(sessions)').all().some((i) => i.name === 'idx_sessions_steam_id'));
});

test('an account delete clears the Steam ID on its sessions and on its Steam login\'s sessions', async () => {
  const db = freshDb();
  db.exec('PRAGMA foreign_keys = OFF;');
  const ME = 77;
  db.prepare("INSERT INTO users (id, provider, provider_id, display_name) VALUES (?, 'steam', ?, 'Me')").run(ME, STEAM);
  db.prepare("INSERT INTO user_logins (login_id, user_id, provider, provider_id, display_name) VALUES (501, ?, 'steam', ?, 'Me')").run(ME, STEAM);
  const put = db.prepare('INSERT INTO sessions (id, started_at, google_uid, login_id, device_id, user_agent, platform, steam_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  put.run('s-signed', '2026-11-01', String(ME), 501, 'dev-a', 'ua', 'steam', STEAM);
  put.run('s-guest', '2026-11-01', null, null, 'dev-a', 'ua', 'steam', STEAM);       // signed out, same Steam account
  put.run('s-other', '2026-11-01', null, null, 'dev-b', 'ua', 'steam', STEAM2);      // someone else
  const token = await signToken({ sub: ME, lid: 501, auth_time: Math.floor(Date.now() / 1000) }, SECRET, 3600);
  const res = await worker.fetch(new Request('https://api.test/me/delete', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, 'CF-Connecting-IP': '1.2.3.4' },
    body: JSON.stringify({ confirm: 'DELETE' }),
  }), envFor(db), { waitUntil() {} });
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(steamOf(db, 's-signed'), null);
  assert.equal(steamOf(db, 's-guest'), null);
  assert.equal(steamOf(db, 's-other'), STEAM2);

  // An open tab writing after the delete can't put it back on the account's old session.
  db.exec('PRAGMA foreign_keys = ON;');
  db.prepare("UPDATE sessions SET id = ? WHERE id = 's-signed'").run(SID);
  await send(envFor(db), `/api/analytics/session/${SID}`, { steam_id: STEAM }, 'PUT');
  assert.equal(steamOf(db), null);
});

// ---- the client (js/analytics.js) ----

globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
let fresh = 0;
/** A fresh copy of the module (its state is per launch), with fetch recorded. */
async function client(steam) {
  const calls = [];
  globalThis.fetch = async (url, opts) => { calls.push({ url, method: opts.method, body: JSON.parse(opts.body) }); return { ok: true, status: 200, headers: { get: () => null } }; };
  // (the module listens for page close on window and document at import)
  globalThis.window = { addEventListener() {}, removeEventListener() {}, ...(steam === undefined ? {} : { steam }) };
  globalThis.document = globalThis.document || { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' };
  const mod = await import('../../js/analytics.js?steam=' + (++fresh));
  return { mod, calls };
}
const tick = () => new Promise((r) => setTimeout(r, 10));
const stop = (mod) => mod.setAnalyticsAllowed(false);

test('the Steam build sends the Steam ID with the session create', async () => {
  const { mod, calls } = await client({ getSteamId: async () => STEAM });
  mod.initSession({ platform: 'steam' });
  await tick();
  mod.setAnalyticsAllowed(true);
  await tick();
  const create = calls.find((c) => c.method === 'POST' && /\/session$/.test(c.url));
  assert.equal(create.body.steam_id, STEAM);
  assert.ok(!calls.some((c) => c.method === 'PUT'), 'no extra update');
  stop(mod);
});

test('a Steam ID that comes after the create goes on a session update', async () => {
  let answer;
  const { mod, calls } = await client({ getSteamId: () => new Promise((r) => { answer = r; }) });
  mod.setAnalyticsAllowed(true);
  const sid = mod.initSession({ platform: 'steam' });
  await tick();
  assert.equal(calls.find((c) => c.method === 'POST').body.steam_id, undefined);
  answer(STEAM);
  await tick();
  const put = calls.find((c) => c.method === 'PUT');
  assert.ok(put.url.includes('/session/' + sid));
  assert.deepEqual(put.body, { steam_id: STEAM });
  stop(mod);
});

test('no window.steam (browser, phone, TV) sends no Steam ID', async () => {
  const { mod, calls } = await client(undefined);
  mod.setAnalyticsAllowed(true);
  mod.initSession({ platform: 'browser' });
  await tick();
  assert.equal(calls.length, 1);
  assert.equal('steam_id' in calls[0].body, false);
  stop(mod);
});

test('Steam with no user, or a malformed id, sends nothing', async () => {
  for (const id of [null, '0', '1234', 76561197960287930]) {
    const { mod, calls } = await client({ getSteamId: async () => id });
    mod.setAnalyticsAllowed(true);
    mod.initSession({ platform: 'steam' });
    await tick();
    assert.ok(calls.every((c) => !('steam_id' in c.body)), String(id));
    stop(mod);
  }
});

test('a no to analytics sends nothing, Steam ID included', async () => {
  const { mod, calls } = await client({ getSteamId: async () => STEAM });
  mod.initSession({ platform: 'steam' });
  mod.setAnalyticsAllowed(false);
  await tick();
  assert.equal(calls.length, 0);
});
