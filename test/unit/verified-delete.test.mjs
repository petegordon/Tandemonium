// Confirmed delete (housetandem.com/account-delete, worker/accounts/data-delete.js): records are
// deleted on what Steam and Discord confirm, never on a Steam ID someone types. An account with
// both a Steam and a Discord sign-in needs both confirmed. A sign-in link sent by someone else
// can't attach your account to their delete.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import worker from '../../worker/leaderboard.js';

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
    _sql: sql, _args: args,
    run: async () => { const r = db.prepare(sql).run(...args); return { success: true, meta: { last_row_id: Number(r.lastInsertRowid) } }; },
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
  DB: d1(db), CORS_ORIGIN: 'https://housetandem.com', JWT_SECRET: 'test-secret',
  DISCORD_CLIENT_ID: 'cid', DISCORD_CLIENT_SECRET: 'csecret', STEAM_WEB_API_KEY: 'steamkey', RELAY_SECRET: 'relay-secret',
  AUTH_LIMITER: allow, READ_LIMITER: allow,
});
const call = (env, p, { method = 'GET', body, token } = {}) => {
  const headers = { 'CF-Connecting-IP': '1.2.3.4', Origin: 'https://housetandem.com' };
  if (token) headers.Authorization = 'Bearer ' + token;
  return worker.fetch(new Request('https://api.test' + p, {
    method, headers: body ? { ...headers, 'Content-Type': 'application/json' } : headers,
    body: body ? JSON.stringify(body) : undefined, redirect: 'manual',
  }), env, { waitUntil() {} });
};
const post = async (env, p, body) => {
  const res = await call(env, p, { method: 'POST', body });
  return { status: res.status, body: await res.json() };
};

const PAGE = 'https://housetandem.com/account-delete';
const STEAM_A = '76561190000000001';
const STEAM_B = '76561190000000002';

/** Steam and Discord answered from fixtures. `discordUser` is who Discord says signed in. */
function mockProviders(state) {
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const u = String(input && input.url ? input.url : input);
    if (u === 'https://steamcommunity.com/openid/login') return new Response('ns:http://specs.openid.net/auth/2.0\nis_valid:true\n');
    if (u.includes('GetPlayerSummaries')) return Response.json({ response: { players: [{ personaname: 'steam name', avatarmedium: 'https://avatars.steamstatic.com/x_medium.jpg' }] } });
    if (u.includes('discord.com/api/oauth2/token')) return Response.json({ access_token: 'at', token_type: 'Bearer' });
    if (u.includes('discord.com/api/users/@me')) return Response.json(state.discordUser);
    throw new Error('unexpected fetch ' + u + ' ' + (init && init.method));
  };
  return () => { globalThis.fetch = real; };
}

/** An account made straight in the tables, with the given sign-ins. → user id */
function account(db, name, logins) {
  const id = Number(db.prepare("INSERT INTO users (provider, provider_id, display_name) VALUES ('account', ?, ?)").run('t-' + name, name).lastInsertRowid);
  for (const [provider, providerId] of logins) {
    db.prepare('INSERT INTO user_logins (user_id, provider, provider_id, display_name) VALUES (?, ?, ?, ?)').run(id, provider, providerId, `${name} (${provider})`);
  }
  return id;
}
const loginOf = (db, userId) => db.prepare('SELECT login_id FROM user_logins WHERE user_id = ? ORDER BY login_id LIMIT 1').get(userId).login_id;
const ride = (db, userId) => db.prepare("INSERT INTO scores (user_id, login_id, level_id, distance, time_ms, mode) VALUES (?, ?, 'grandma', 100, 1000, 'solo')").run(userId, loginOf(db, userId));
function session(db, id, { steamId = null, device = null, ip = '9.9.9.9', account = null } = {}) {
  db.prepare("INSERT INTO sessions (id, started_at, platform, steam_id, device_id, ip_address, google_uid) VALUES (?, '2026-11-26T20:00:00Z', 'steam', ?, ?, ?, ?)")
    .run(id, steamId, device, ip, account === null ? null : String(account));
}
const n = (db, sql, ...a) => db.prepare(sql).get(...a).n;

/** The page: start a delete. → { id, secret } */
async function start(env) {
  const r = await post(env, '/erase/start', { return_to: PAGE });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { id: r.body.id, secret: r.body.secret };
}

/** Sign in with Steam for this delete, to the end. → the ticket in the address it came back to */
async function steamConfirm(env, flow, steamId) {
  const r = await post(env, '/erase/signin', { ...flow, provider: 'steam' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const go = await call(env, new URL(r.body.url).pathname + new URL(r.body.url).search);
  assert.equal(go.status, 302);
  const login = new URL(go.headers.get('Location'));
  const back = new URL(login.searchParams.get('openid.return_to'));
  const claimed = 'https://steamcommunity.com/openid/id/' + steamId;
  for (const [k, v] of Object.entries({
    'openid.ns': 'http://specs.openid.net/auth/2.0', 'openid.mode': 'id_res',
    'openid.op_endpoint': 'https://steamcommunity.com/openid/login',
    'openid.claimed_id': claimed, 'openid.identity': claimed,
    'openid.return_to': back.toString(), 'openid.response_nonce': '2026-11-27T00:00:00Zabc',
    'openid.assoc_handle': '1234567890', 'openid.signed': 'signed,op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle',
    'openid.sig': 'c2ln',
  })) back.searchParams.set(k, v);
  const cb = await call(env, back.pathname + back.search);
  assert.equal(cb.status, 302);
  const loc = cb.headers.get('Location');
  assert.ok(loc.startsWith(PAGE + '#ht_erase='), loc);
  return decodeURIComponent(loc.split('#ht_erase=')[1]);
}

/** Sign in with Discord for this delete, to the end. → the ticket */
async function discordConfirm(env, flow) {
  const r = await post(env, '/erase/signin', { ...flow, provider: 'discord' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const auth = new URL(r.body.url);
  assert.equal(auth.host, 'discord.com');
  assert.equal(auth.searchParams.get('scope'), 'identify', 'a delete asks Discord for nothing but who it is');
  const cb = await call(env, `/auth/discord/callback?code=c0de&state=${encodeURIComponent(auth.searchParams.get('state'))}`);
  assert.equal(cb.status, 302);
  const loc = cb.headers.get('Location');
  assert.ok(loc.startsWith(PAGE + '#ht_erase='), loc);
  return decodeURIComponent(loc.split('#ht_erase=')[1]);
}

test('a Steam-only account: Steam confirms it, the player confirms, every record and Steam session goes', async () => {
  const db = freshDb();
  const env = envFor(db);
  const restore = mockProviders({});
  try {
    const pete = account(db, 'Pete', [['steam', STEAM_A]]);
    ride(db, pete); ride(db, pete);
    session(db, 's1', { steamId: STEAM_A, device: 'dev-a', account: pete });
    session(db, 's2', { steamId: STEAM_A, device: 'dev-a' });        // played without signing in
    session(db, 's3', { device: 'dev-a' });                           // same computer, before the Steam ID was kept
    session(db, 'other', { steamId: STEAM_B, device: 'dev-b' });      // someone else
    // Couch rides as a guest on that computer: its guest login and small account (provider 'device').
    const guest = account(db, 'Guest A', [['device', 'dev-a']]);
    const otherGuest = account(db, 'Guest B', [['device', 'dev-b']]);
    const users = n(db, 'SELECT COUNT(*) n FROM users');

    const flow = await start(env);
    const ticket = await steamConfirm(env, flow, STEAM_A);
    assert.equal(n(db, 'SELECT COUNT(*) n FROM users'), users, 'confirming makes no account');
    const st = await post(env, '/erase/attach', { ...flow, ticket });
    assert.equal(st.status, 200, JSON.stringify(st.body));
    assert.equal(st.body.ready, true);
    assert.equal(st.body.accounts.length, 1);
    assert.equal(st.body.accounts[0].rides, 2);
    assert.equal(st.body.sessions, 2);
    assert.deepEqual(st.body.needed, []);
    assert.ok(!JSON.stringify(st.body).includes(STEAM_A), 'the page is never sent provider ids');

    // The ticket works once.
    assert.equal((await post(env, '/erase/attach', { ...flow, ticket })).status, 410);
    // Both the box and the typed word.
    assert.equal((await post(env, '/erase/confirm', { ...flow, confirm: 'DELETE' })).status, 400);
    assert.equal((await post(env, '/erase/confirm', { ...flow, confirm: 'delete', understood: true })).status, 400);
    assert.equal(n(db, 'SELECT COUNT(*) n FROM users WHERE id = ?', pete), 1);

    const done = await post(env, '/erase/confirm', { ...flow, confirm: 'DELETE', understood: true });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.deleted, true);
    assert.equal(done.body.rides, 2);
    assert.equal(n(db, 'SELECT COUNT(*) n FROM users WHERE id = ?', pete), 0);
    assert.equal(n(db, 'SELECT COUNT(*) n FROM user_logins WHERE user_id = ?', pete), 0);
    assert.equal(n(db, 'SELECT COUNT(*) n FROM scores WHERE user_id = ?', pete), 0);
    assert.equal(n(db, 'SELECT COUNT(*) n FROM sessions WHERE steam_id = ?', STEAM_A), 0);
    assert.equal(n(db, "SELECT COUNT(*) n FROM sessions WHERE device_id = 'dev-a' OR ip_address IS NOT NULL AND id != 'other'"), 0,
      'their sessions stay only as anonymous counts');
    assert.equal(n(db, 'SELECT COUNT(*) n FROM sessions'), 4);
    assert.equal(n(db, 'SELECT COUNT(*) n FROM users WHERE id = ?', guest), 0, 'the guest records from their own computer go too');
    assert.equal(n(db, 'SELECT COUNT(*) n FROM users WHERE id = ?', otherGuest), 1);
    assert.equal(n(db, "SELECT COUNT(*) n FROM sessions WHERE id = 'other' AND steam_id = ? AND device_id = 'dev-b'", STEAM_B), 1, "someone else's are untouched");
    // Single use.
    assert.equal((await post(env, '/erase/confirm', { ...flow, confirm: 'DELETE', understood: true })).status, 410);
  } finally { restore(); }
});

test('an account with Steam and Discord: nothing can be deleted until both are confirmed', async () => {
  const db = freshDb();
  const env = envFor(db);
  const state = { discordUser: { id: '111', username: 'someone', global_name: 'Someone Else', avatar: null } };
  const restore = mockProviders(state);
  try {
    const pete = account(db, 'Pete', [['steam', STEAM_A], ['discord', '222']]);
    ride(db, pete);
    const flow = await start(env);
    let st = await post(env, '/erase/attach', { ...flow, ticket: await steamConfirm(env, flow, STEAM_A) });
    assert.equal(st.body.ready, false);
    assert.deepEqual(st.body.needed.map((l) => l.provider), ['discord']);
    assert.equal(st.body.needed[0].name, 'Pete (discord)', 'the page can say which Discord to sign in with');
    assert.equal((await post(env, '/erase/confirm', { ...flow, confirm: 'DELETE', understood: true })).status, 409);

    // Signing in with a different Discord doesn't count.
    st = await post(env, '/erase/attach', { ...flow, ticket: await discordConfirm(env, flow) });
    assert.equal(st.body.matched, false);
    assert.equal(st.body.ready, false);
    assert.equal((await post(env, '/erase/confirm', { ...flow, confirm: 'DELETE', understood: true })).status, 409);
    assert.equal(n(db, 'SELECT COUNT(*) n FROM users WHERE id = ?', pete), 1);

    state.discordUser = { id: '222', username: 'pete', global_name: 'Pete', avatar: null };
    st = await post(env, '/erase/attach', { ...flow, ticket: await discordConfirm(env, flow) });
    assert.equal(st.body.matched, true);
    assert.equal(st.body.ready, true);
    assert.ok(st.body.accounts[0].logins.every((l) => l.confirmed));
    const done = await post(env, '/erase/confirm', { ...flow, confirm: 'DELETE', understood: true });
    assert.equal(done.status, 200);
    assert.equal(n(db, 'SELECT COUNT(*) n FROM users WHERE id = ?', pete), 0);
  } finally { restore(); }
});

test('starting with Discord asks for Steam too', async () => {
  const db = freshDb();
  const env = envFor(db);
  const restore = mockProviders({ discordUser: { id: '222', username: 'pete', global_name: 'Pete', avatar: null } });
  try {
    const pete = account(db, 'Pete', [['discord', '222'], ['steam', STEAM_A]]);
    const flow = await start(env);
    const st = await post(env, '/erase/attach', { ...flow, ticket: await discordConfirm(env, flow) });
    assert.deepEqual(st.body.needed.map((l) => l.provider), ['steam']);
    assert.equal(n(db, 'SELECT COUNT(*) n FROM users WHERE id = ?', pete), 1);
  } finally { restore(); }
});

test("a confirmation made from someone else's link can't be used by them", async () => {
  const db = freshDb();
  const env = envFor(db);
  const restore = mockProviders({});
  try {
    const victim = account(db, 'Victim', [['steam', STEAM_A]]);
    // The attacker starts a delete and sends the victim its Steam sign-in link. The victim signs in:
    // the ticket comes back in the VICTIM's browser, which has no secret for that delete.
    const attacker = await start(env);
    const ticket = await steamConfirm(env, attacker, STEAM_A);
    // The victim's page (no secret) can't use it, and a different delete can't either.
    assert.equal((await post(env, '/erase/attach', { id: attacker.id, secret: 'wrong', ticket })).status, 410);
    const other = await start(env);
    assert.equal((await post(env, '/erase/attach', { ...other, ticket })).status, 410, 'a ticket is bound to its delete');
    // Without the ticket the attacker has confirmed nothing.
    const st = await post(env, '/erase/status', attacker);
    assert.equal(st.body.ready, false);
    assert.deepEqual(st.body.confirmed, []);
    assert.equal((await post(env, '/erase/confirm', { ...attacker, confirm: 'DELETE', understood: true })).status, 409);
    assert.equal(n(db, 'SELECT COUNT(*) n FROM users WHERE id = ?', victim), 1);
  } finally { restore(); }
});

test('a Steam ID with no account: its sessions go; a computer shared with another Steam account keeps theirs', async () => {
  const db = freshDb();
  const env = envFor(db);
  const restore = mockProviders({});
  try {
    session(db, 'a1', { steamId: STEAM_A, device: 'own' });
    session(db, 'a2', { steamId: STEAM_A, device: 'family' });
    session(db, 'b1', { steamId: STEAM_B, device: 'family' });
    session(db, 'f1', { device: 'family' });
    const flow = await start(env);
    const st = await post(env, '/erase/attach', { ...flow, ticket: await steamConfirm(env, flow, STEAM_A) });
    assert.equal(st.body.accounts.length, 0);
    assert.equal(st.body.sessions, 2);
    assert.equal(st.body.ready, true);
    assert.equal((await post(env, '/erase/confirm', { ...flow, confirm: 'DELETE', understood: true })).status, 200);
    assert.equal(n(db, 'SELECT COUNT(*) n FROM sessions WHERE steam_id = ?', STEAM_A), 0);
    assert.equal(n(db, "SELECT COUNT(*) n FROM sessions WHERE device_id = 'own'"), 0);
    assert.equal(n(db, "SELECT COUNT(*) n FROM sessions WHERE id IN ('b1', 'f1') AND device_id = 'family'"), 2, 'the family computer is not only theirs');
  } finally { restore(); }
});

test('nothing stored: the page says so and there is nothing to confirm', async () => {
  const db = freshDb();
  const env = envFor(db);
  const restore = mockProviders({});
  try {
    const flow = await start(env);
    const st = await post(env, '/erase/attach', { ...flow, ticket: await steamConfirm(env, flow, STEAM_B) });
    assert.equal(st.body.nothing, true);
    assert.equal(st.body.ready, false);
    assert.equal((await post(env, '/erase/confirm', { ...flow, confirm: 'DELETE', understood: true })).status, 409);
  } finally { restore(); }
});

test('a delete expires, can be cancelled, and only returns to a House Tandem page', async () => {
  const db = freshDb();
  const env = envFor(db);
  assert.equal((await post(env, '/erase/start', { return_to: 'https://evil.example/account-delete' })).status, 400);
  const flow = await start(env);
  assert.equal((await post(env, '/erase/status', { id: flow.id, secret: flow.secret + 'x' })).status, 410);
  db.prepare('UPDATE auth_requests SET created_at = created_at - 901 WHERE id = ?').run(flow.id);
  assert.equal((await post(env, '/erase/status', flow)).status, 410);
  const again = await start(env);
  assert.equal((await post(env, '/erase/cancel', again)).status, 200);
  assert.equal((await post(env, '/erase/status', again)).status, 410);
  assert.equal((await post(env, '/erase/signin', { ...again, provider: 'steam' })).status, 410);
});
