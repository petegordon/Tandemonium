// #612 · one account, several sign-ins: Discord sign-in (device code for the
// TV / Steam build, redirect for the web), Steam + Discord on one account, and
// the merge when a linked sign-in already had its own account.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import worker from '../../worker/leaderboard.js';
import { allowedReturnTo, discordAvatarUrl } from '../../worker/identity.js';

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
  return { prepare: (sql) => ({ bind: (...args) => bound(sql, args.map((a) => (a === undefined ? null : a))), ...bound(sql, []) }) };
}

const allow = { limit: async () => ({ success: true }) };
function envFor(db) {
  return {
    DB: d1(db), CORS_ORIGIN: 'https://tandemonium.housetandem.com', JWT_SECRET: 'test-secret',
    DISCORD_CLIENT_ID: 'cid', DISCORD_CLIENT_SECRET: 'csecret', STEAM_WEB_API_KEY: 'steamkey',
    AUTH_LIMITER: allow, READ_LIMITER: allow,
  };
}
const call = (env, p, { method = 'GET', body, form, token } = {}) => {
  const headers = { 'CF-Connecting-IP': '1.2.3.4', Origin: 'https://tandemonium.housetandem.com' };
  if (token) headers.Authorization = 'Bearer ' + token;
  let payload;
  if (form) { payload = new URLSearchParams(form); headers['Content-Type'] = 'application/x-www-form-urlencoded'; }
  else if (body) { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
  return worker.fetch(new Request('https://api.test' + p, { method, headers, body: payload, redirect: 'manual' }), env, { waitUntil() {} });
};

/** Discord + Steam answered from fixtures instead of the network. */
function mockFetch(discordUser) {
  const real = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const u = String(input && input.url ? input.url : input);
    if (u.includes('discord.com/api/oauth2/token')) return Response.json({ access_token: 'at', token_type: 'Bearer' });
    if (u.includes('discord.com/api/users/@me')) return Response.json(discordUser);
    if (u.includes('AuthenticateUserTicket')) return Response.json({ response: { params: { steamid: '76561190000000001' } } });
    if (u.includes('GetPlayerSummaries')) return Response.json({ response: { players: [{ avatarmedium: 'https://avatars.steamstatic.com/x_medium.jpg' }] } });
    throw new Error('unexpected fetch ' + u);
  };
  return () => { globalThis.fetch = real; };
}
const DISCORD_PETE = { id: '80351110224678912', username: 'pete', global_name: 'Pete', avatar: 'abc123' };

/** Run a device-code sign-in to the end; returns the poll result. */
async function deviceSignIn(env, token = null) {
  const begin = await (await call(env, '/auth/discord/begin', { method: 'POST', body: { mode: 'device' }, token })).json();
  assert.match(begin.code, /^[A-HJ-NP-Z2-9]{4}$/);
  const go = await call(env, '/auth/discord/go?r=' + encodeURIComponent(begin.id));
  assert.equal(go.status, 302);
  const auth = new URL(go.headers.get('Location'));
  assert.equal(auth.host, 'discord.com');
  assert.equal(auth.searchParams.get('scope'), 'identify');
  const state = auth.searchParams.get('state');

  let poll = await (await call(env, '/auth/poll', { method: 'POST', body: { id: begin.id, secret: begin.secret } })).json();
  assert.equal(poll.status, 'pending');

  const cb = await call(env, `/auth/discord/callback?code=c0de&state=${encodeURIComponent(state)}`);
  const html = await cb.text();
  assert.equal(cb.status, 200);
  assert.ok(html.includes(begin.code), 'the confirm page shows the code from the screen');
  poll = await (await call(env, '/auth/poll', { method: 'POST', body: { id: begin.id, secret: begin.secret } })).json();
  assert.equal(poll.status, 'confirming', 'no session until the player confirms the code');

  const k = html.match(/name="k" value="([^"]+)"/)[1];
  const ok = await call(env, '/auth/discord/confirm', { method: 'POST', form: { r: begin.id, k, ok: '1' } });
  assert.equal(ok.status, 200);
  return (await call(env, '/auth/poll', { method: 'POST', body: { id: begin.id, secret: begin.secret } })).json();
}

test('device sign-in with Discord creates an account; the poll needs the secret and is read once', async () => {
  const db = freshDb();
  const env = envFor(db);
  const restore = mockFetch(DISCORD_PETE);
  try {
    const begin = await (await call(env, '/auth/discord/begin', { method: 'POST', body: { mode: 'device' } })).json();
    const wrong = await call(env, '/auth/poll', { method: 'POST', body: { id: begin.id, secret: 'nope' } });
    assert.equal(wrong.status, 404);

    const done = await deviceSignIn(env);
    assert.equal(done.status, 'done');
    assert.ok(done.token);
    assert.equal(done.user.name, 'Pete');
    assert.deepEqual(Object.keys(done.user.identities), ['discord']);
    assert.equal(done.user.identities.discord.avatar, 'https://cdn.discordapp.com/avatars/80351110224678912/abc123.png?size=128');

    const meRes = await call(env, '/me', { token: done.token });
    const me = await meRes.json();
    assert.equal(meRes.status, 200, JSON.stringify(me));
    assert.equal(me.user.identities.discord.name, 'Pete');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n, 1);
  } finally { restore(); }
});

test('cancelling on the confirm page hands the game an error, not a session', async () => {
  const db = freshDb();
  const env = envFor(db);
  const restore = mockFetch(DISCORD_PETE);
  try {
    const begin = await (await call(env, '/auth/discord/begin', { method: 'POST', body: { mode: 'device' } })).json();
    await call(env, '/auth/discord/go?r=' + begin.id);
    const html = await (await call(env, `/auth/discord/callback?code=c&state=${begin.id}`)).text();
    const k = html.match(/name="k" value="([^"]+)"/)[1];
    await call(env, '/auth/discord/confirm', { method: 'POST', form: { r: begin.id, k, ok: '0' } });
    const poll = await (await call(env, '/auth/poll', { method: 'POST', body: { id: begin.id, secret: begin.secret } })).json();
    assert.equal(poll.status, 'error');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n, 0);
  } finally { restore(); }
});

test('redirect sign-in goes back to the game with the session in the fragment; foreign return URLs are refused', async () => {
  const db = freshDb();
  const env = envFor(db);
  const restore = mockFetch(DISCORD_PETE);
  try {
    const bad = await call(env, '/auth/discord/begin', { method: 'POST', body: { mode: 'redirect', return_to: 'https://evil.example/' } });
    assert.equal(bad.status, 400);
    const begin = await (await call(env, '/auth/discord/begin', { method: 'POST', body: { mode: 'redirect', return_to: 'https://tandemonium.housetandem.com/?x=1#old' } })).json();
    assert.equal(begin.code, null);
    const cb = await call(env, `/auth/discord/callback?code=c&state=${begin.id}`);
    assert.equal(cb.status, 302);
    const loc = cb.headers.get('Location');
    assert.ok(loc.startsWith('https://tandemonium.housetandem.com/?x=1#ht_auth='), loc);
  } finally { restore(); }
});

test('Steam player links Discord: one account, both pictures; a Discord-only account is merged in', async () => {
  const db = freshDb();
  const env = envFor(db);
  const restore = mockFetch(DISCORD_PETE);
  try {
    // Pete signed in with Discord on the web first and earned an achievement there.
    const web = await deviceSignIn(env);
    const webId = web.user.id;
    db.prepare("INSERT INTO user_achievements (user_id, achievement_id) VALUES (?, 'first_ride')").run(webId);
    db.prepare("INSERT INTO pairs (user_lo, user_hi, rides) VALUES (?, 'guest:abc', 3)").run(String(webId));

    // Then the Steam build signs in by ticket: a separate account so far.
    const steam = await (await call(env, '/auth/steam', { method: 'POST', body: { steamId: '76561190000000001', personaName: 'pete_steam', ticket: 't' } })).json();
    assert.notEqual(steam.user.id, webId);
    assert.deepEqual(Object.keys(steam.user.identities), ['steam']);

    // Linking Discord from the Steam build merges the web account into the Steam one.
    const linked = await deviceSignIn(env, steam.token);
    assert.equal(linked.status, 'done');
    assert.equal(linked.linked, true);
    assert.equal(linked.merged, true);
    assert.equal(linked.user.id, steam.user.id);
    assert.deepEqual(Object.keys(linked.user.identities).sort(), ['discord', 'steam']);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM users WHERE id = ?').get(webId).n, 0);
    assert.equal(db.prepare("SELECT user_id FROM user_achievements WHERE achievement_id = 'first_ride'").get().user_id, steam.user.id);
    assert.equal(db.prepare("SELECT rides FROM pairs WHERE user_hi = 'guest:abc'").get().rides, 3);
    assert.equal(db.prepare("SELECT user_lo FROM pairs WHERE user_hi = 'guest:abc'").get().user_lo, String(steam.user.id));

    // Next launch: the Steam ticket alone brings Discord along.
    const again = await (await call(env, '/auth/steam', { method: 'POST', body: { steamId: '76561190000000001', personaName: 'pete_steam', ticket: 't' } })).json();
    assert.equal(again.user.id, steam.user.id);
    assert.equal(again.user.identities.discord.name, 'Pete');
    // And a Discord sign-in on the web lands on the same account.
    const web2 = await deviceSignIn(env);
    assert.equal(web2.user.id, steam.user.id);
  } finally { restore(); }
});

test('a Steam user created by the old code after the backfill keeps their account', async () => {
  const db = freshDb();
  const env = envFor(db);
  const restore = mockFetch(DISCORD_PETE);
  try {
    db.prepare("INSERT INTO users (provider, provider_id, display_name) VALUES ('steam', '76561190000000001', 'old')").run();
    const before = db.prepare('SELECT id FROM users').get().id;
    const res = await (await call(env, '/auth/steam', { method: 'POST', body: { steamId: '76561190000000001', personaName: 'pete_steam', ticket: 't' } })).json();
    assert.equal(res.user.id, before);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n, 1);
    assert.deepEqual(Object.keys(res.user.identities), ['steam']);
  } finally { restore(); }
});

test('existing users keep their sign-in after the migration', () => {
  const db = freshDb();
  db.prepare("INSERT INTO users (provider, provider_id, display_name) VALUES ('google', 'g1', 'Old')").run();
  // Re-running the backfill (as the migration does) picks up rows created before it.
  db.exec(`INSERT OR IGNORE INTO user_identities (user_id, provider, provider_id, display_name, avatar_url, linked_at)
           SELECT id, provider, provider_id, display_name, avatar_url, created_at FROM users`);
  assert.equal(db.prepare("SELECT provider FROM user_identities WHERE provider_id = 'g1'").get().provider, 'google');
});

test('helpers: return URLs and default Discord avatars', () => {
  const cors = 'https://tandemonium.housetandem.com,https://tandemonium.jimandi.love';
  assert.equal(allowedReturnTo('https://tandemonium.jimandi.love/play#x', cors), 'https://tandemonium.jimandi.love/play');
  assert.equal(allowedReturnTo('http://localhost:8080/', cors), 'http://localhost:8080/');
  assert.equal(allowedReturnTo('javascript:alert(1)', cors), null);
  assert.equal(allowedReturnTo('https://tandemonium.housetandem.com.evil.example/', cors), null);
  assert.match(discordAvatarUrl({ id: '80351110224678912', avatar: null }), /embed\/avatars\/[0-5]\.png$/);
});
