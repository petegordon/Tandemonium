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

test('couch co-op: the ride saves for Player 1 and, by their own sign-in, Player 2 (#612 item 5)', async () => {
  const db = freshDb();
  const env = { ...envFor(db), SCORE_LIMITER: allow };
  const restore = mockFetch(DISCORD_PETE);
  try {
    const p1 = await (await call(env, '/auth/steam', { method: 'POST', body: { steamId: '76561190000000001', personaName: 'pete_steam', ticket: 't' } })).json();
    const p2 = await deviceSignIn(env);   // Sam's own Discord sign-in on the Wardrobe card
    db.prepare("INSERT INTO users (provider, provider_id, display_name) VALUES ('discord', 'stranger', 'Stranger')").run();
    const stranger = db.prepare("SELECT id FROM users WHERE provider_id = 'stranger'").get().id;
    const ride = {
      levelId: 'grandma', distance: 1200, timeMs: 200000, mode: 'local',
      contributions: { captain: { overallPct: 55, userId: stranger }, stoker: { overallPct: 45, userId: stranger, guestDeviceId: 'x' } },
      newAchievements: ['first_finish'],
      seats: [{ role: 'stoker', token: p2.token, newAchievements: ['first_finish', 'first_pedal'] }],
    };
    const res = await call(env, '/score', { method: 'POST', body: ride, token: p1.token });
    assert.equal(res.status, 200, await res.clone().text());
    const rows = db.prepare('SELECT user_id, mode FROM scores ORDER BY id').all().map((r) => [r.user_id, r.mode]);
    assert.deepEqual(rows, [[p1.user.id, 'captain'], [p2.user.id, 'stoker']]);
    const contrib = Object.fromEntries(db.prepare('SELECT role, player_user_id FROM score_contributions').all().map((r) => [r.role, r.player_user_id]));
    assert.deepEqual(contrib, { captain: p1.user.id, stoker: p2.user.id }, 'ids come from the sign-ins, never the body');
    const ach = db.prepare('SELECT user_id, achievement_id FROM user_achievements ORDER BY user_id, achievement_id').all().map((r) => `${r.user_id}:${r.achievement_id}`);
    assert.deepEqual(ach, [`${p1.user.id}:first_finish`, `${p2.user.id}:first_finish`, `${p2.user.id}:first_pedal`]);
    const pair = db.prepare('SELECT user_lo, user_hi, rides FROM pairs').all();
    assert.equal(pair.length, 1);
    assert.deepEqual([pair[0].user_lo, pair[0].user_hi].sort(), [String(p1.user.id), String(p2.user.id)].sort());
    assert.equal(db.prepare('SELECT COUNT(*) n FROM scores WHERE user_id = ?').get(stranger).n, 0);

    // A forged seat token (not signed by us) is ignored; Player 1's ride still saves.
    const forged = { ...ride, seats: [{ role: 'stoker', token: p2.token.slice(0, -4) + 'AAAA' }] };
    await new Promise((r) => setTimeout(r, 10));
    db.prepare("UPDATE scores SET created_at = datetime('now', '-1 minute')").run();
    const res2 = await call(env, '/score', { method: 'POST', body: forged, token: p1.token });
    assert.equal(res2.status, 200);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM scores WHERE user_id = ?').get(p2.user.id).n, 1, 'no second ride for P2 from a forged token');
  } finally { restore(); }
});

test('#609 couch pairs: both signed in → one pair both can read; P1 signed out → Sam with this device\'s guest', async () => {
  const db = freshDb();
  const env = { ...envFor(db), SCORE_LIMITER: allow };
  const restore = mockFetch(DISCORD_PETE);
  try {
    const p1 = await (await call(env, '/auth/steam', { method: 'POST', body: { steamId: '76561190000000001', personaName: 'pete_steam', ticket: 't' } })).json();
    const p2 = await deviceSignIn(env);
    const base = { levelId: 'grandma', distance: 1200, timeMs: 200000 };
    const contributions = { captain: { overallPct: 55 }, stoker: { overallPct: 45 } };
    // Two couch rides with both signed in (the submit P1's game sends today).
    for (let i = 0; i < 2; i++) {
      db.prepare("UPDATE scores SET created_at = datetime('now', '-1 minute')").run();
      const res = await call(env, '/score', { method: 'POST', token: p1.token, body: {
        ...base, mode: 'local', contributions: { captain: { ...contributions.captain, userId: p1.user.id }, stoker: { ...contributions.stoker, userId: null } },
        seats: [{ role: 'stoker', token: p2.token, newAchievements: [] }] } });
      assert.equal(res.status, 200);
    }
    const fromP1 = await (await call(env, '/pair?with=' + p2.user.id, { token: p1.token })).json();
    const fromP2 = await (await call(env, '/pair?with=' + p1.user.id, { token: p2.token })).json();
    assert.equal(fromP1.rides, 2);
    assert.equal(fromP1.distance, 2400);
    assert.deepEqual(fromP2, fromP1, 'the same record from either seat');

    // P1 signed out: Sam's own session posts the ride as the stoker, P1 = this device's guest.
    db.prepare("UPDATE scores SET created_at = datetime('now', '-1 minute')").run();
    const res = await call(env, '/score', { method: 'POST', token: p2.token, body: {
      ...base, mode: 'stoker', newAchievements: ['first_finish'],
      contributions: { captain: { ...contributions.captain, userId: null, guestDeviceId: 'dev1' }, stoker: { ...contributions.stoker, userId: p2.user.id } } } });
    assert.equal(res.status, 200);
    const guest = await (await call(env, '/pair?with=guest%3Adev1', { token: p2.token })).json();
    assert.equal(guest.rides, 1);
    const again = await (await call(env, '/pair?with=' + p2.user.id, { token: p1.token })).json();
    assert.equal(again.rides, 2, "P1's account pair is untouched");
    assert.equal(db.prepare("SELECT COUNT(*) n FROM user_achievements WHERE user_id = ? AND achievement_id = 'first_finish'").get(p2.user.id).n, 1);
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

// ── Steam on the web: "Sign in through Steam" (OpenID 2.0) ──

/** Steam's OpenID answers from a fixture: check_authentication says `valid`. */
function mockSteamOpenId(valid = true) {
  const restoreDiscord = mockFetch(DISCORD_PETE);
  const inner = globalThis.fetch;
  const checks = [];
  globalThis.fetch = async (input, init) => {
    const u = String(input && input.url ? input.url : input);
    if (u === 'https://steamcommunity.com/openid/login') {
      checks.push(new URLSearchParams(init.body));
      return new Response(`ns:http://specs.openid.net/auth/2.0\nis_valid:${valid}\n`);
    }
    return inner(input, init);
  };
  return { checks, restore: () => { globalThis.fetch = inner; restoreDiscord(); } };
}
const jwtSub = (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub;

/** Begin → go → Steam → callback. `tamper(params)` edits Steam's answer first. */
async function steamWebSignIn(env, { token, steamId = '76561190000000001', tamper } = {}) {
  const begin = await (await call(env, '/auth/steam/begin', { method: 'POST', body: { return_to: 'https://tandemonium.housetandem.com/account' }, token })).json();
  const go = await call(env, '/auth/steam/go?r=' + encodeURIComponent(begin.id));
  assert.equal(go.status, 302);
  const login = new URL(go.headers.get('Location'));
  assert.equal(login.origin + login.pathname, 'https://steamcommunity.com/openid/login');
  assert.equal(login.searchParams.get('openid.realm'), 'https://api.test');
  const returnTo = new URL(login.searchParams.get('openid.return_to'));
  const claimed = 'https://steamcommunity.com/openid/id/' + steamId;
  const p = {
    'openid.ns': 'http://specs.openid.net/auth/2.0', 'openid.mode': 'id_res',
    'openid.op_endpoint': 'https://steamcommunity.com/openid/login',
    'openid.claimed_id': claimed, 'openid.identity': claimed,
    'openid.return_to': returnTo.toString(), 'openid.response_nonce': '2026-11-07T00:00:00Zabc',
    'openid.assoc_handle': '1234567890', 'openid.signed': 'signed,op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle',
    'openid.sig': 'c2ln',
  };
  if (tamper) tamper(p);
  for (const [k, v] of Object.entries(p)) returnTo.searchParams.set(k, v);
  return call(env, returnTo.pathname + returnTo.search);
}

test('Steam sign-in on the web finds the account the Steam game made; linking from Discord merges', async () => {
  const db = freshDb();
  const env = envFor(db);
  const { checks, restore } = mockSteamOpenId(true);
  try {
    // The Steam build signed in by ticket first.
    const game = await (await call(env, '/auth/steam', { method: 'POST', body: { steamId: '76561190000000001', personaName: 'pete_steam', ticket: 't' } })).json();
    const cb = await steamWebSignIn(env);
    assert.equal(cb.status, 302);
    const loc = cb.headers.get('Location');
    assert.ok(loc.startsWith('https://tandemonium.housetandem.com/account#ht_auth='), loc);
    assert.equal(jwtSub(decodeURIComponent(loc.split('#ht_auth=')[1])), game.user.id, 'same account as the game');
    assert.equal(checks.length, 1);
    assert.equal(checks[0].get('openid.mode'), 'check_authentication', 'Steam itself confirms the answer');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n, 1);

    // Someone signed in with Discord on the web links Steam: the game account merges in.
    const discord = await deviceSignIn(env);
    assert.notEqual(discord.user.id, game.user.id);
    const link = await steamWebSignIn(env, { token: discord.token });
    assert.equal(link.status, 302);
    const after = await (await call(env, '/me', { token: discord.token })).json();
    assert.deepEqual(Object.keys(after.user.identities).sort(), ['discord', 'steam']);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n, 1);
  } finally { restore(); }
});

test('Steam web sign-in refuses forged, replayed or foreign answers', async () => {
  const db = freshDb();
  const env = envFor(db);
  const steam = mockSteamOpenId(true);
  try {
    // Return URL elsewhere.
    assert.equal((await call(env, '/auth/steam/begin', { method: 'POST', body: { return_to: 'https://evil.example/' } })).status, 400);
    // An answer meant for another request, a non-Steam id, an unsigned field.
    for (const tamper of [
      (p) => { p['openid.return_to'] = 'https://api.test/auth/steam/callback?r=someoneelse'; },
      (p) => { p['openid.claimed_id'] = p['openid.identity'] = 'https://evil.example/openid/id/76561190000000001'; },
      (p) => { p['openid.op_endpoint'] = 'https://evil.example/openid/login'; },
      (p) => { p['openid.signed'] = 'signed,op_endpoint,return_to'; },
    ]) {
      const r = await steamWebSignIn(env, { tamper });
      assert.equal(r.status, 401);
    }
    assert.equal(steam.checks.length, 0, 'rejected before asking Steam');
  } finally { steam.restore(); }

  const bad = mockSteamOpenId(false);
  try {
    const r = await steamWebSignIn(env);
    assert.equal(r.status, 401, 'Steam says not valid');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n, 0);
  } finally { bad.restore(); }

  // A used request can't be replayed.
  const ok = mockSteamOpenId(true);
  try {
    const begin = await (await call(env, '/auth/steam/begin', { method: 'POST', body: { return_to: 'https://tandemonium.housetandem.com/' } })).json();
    const claimed = 'https://steamcommunity.com/openid/id/76561190000000001';
    const q = new URLSearchParams({
      r: begin.id, 'openid.mode': 'id_res', 'openid.op_endpoint': 'https://steamcommunity.com/openid/login',
      'openid.claimed_id': claimed, 'openid.identity': claimed,
      'openid.return_to': 'https://api.test/auth/steam/callback?r=' + begin.id,
      'openid.response_nonce': 'n', 'openid.assoc_handle': 'a',
      'openid.signed': 'signed,op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle', 'openid.sig': 's',
    });
    assert.equal((await call(env, '/auth/steam/callback?' + q)).status, 302);
    assert.equal((await call(env, '/auth/steam/callback?' + q)).status, 410);
  } finally { ok.restore(); }
});

test('deleting an account removes every record on it; the partner keeps their own ride', async () => {
  const db = freshDb();
  const env = { ...envFor(db), SCORE_LIMITER: allow };
  const restore = mockFetch(DISCORD_PETE);
  try {
    const p1 = await (await call(env, '/auth/steam', { method: 'POST', body: { steamId: '76561190000000001', personaName: 'pete_steam', ticket: 't' } })).json();
    await deviceSignIn(env, p1.token);   // Pete links Discord: two sign-ins on one account
    // Sam, the couch partner, has their own account.
    db.prepare("INSERT INTO users (provider, provider_id, display_name) VALUES ('discord', 'sam', 'Sam')").run();
    const sam = db.prepare("SELECT id FROM users WHERE provider_id = 'sam'").get().id;

    // A couch ride: Pete (P1) and Sam (P2) both credited; plus daily, friends, pairs.
    db.prepare("INSERT INTO scores (user_id, level_id, distance, time_ms, mode) VALUES (?, 'grandma', 1200, 200000, 'captain')").run(p1.user.id);
    const s1 = db.prepare('SELECT id FROM scores WHERE user_id = ?').get(p1.user.id).id;
    db.prepare("INSERT INTO scores (user_id, level_id, distance, time_ms, mode) VALUES (?, 'grandma', 1200, 200000, 'stoker')").run(sam);
    const s2 = db.prepare('SELECT id FROM scores WHERE user_id = ?').get(sam).id;
    for (const s of [s1, s2]) {
      db.prepare("INSERT INTO score_contributions (score_id, role, player_user_id) VALUES (?, 'captain', ?)").run(s, p1.user.id);
      db.prepare("INSERT INTO score_contributions (score_id, role, player_user_id) VALUES (?, 'stoker', ?)").run(s, sam);
    }
    db.prepare("INSERT INTO user_achievements (user_id, achievement_id, score_id) VALUES (?, 'first_finish', ?)").run(p1.user.id, s1);
    db.prepare("INSERT INTO user_achievements (user_id, achievement_id, score_id) VALUES (?, 'first_finish', ?)").run(sam, s2);
    db.prepare("INSERT INTO daily_results (user_id, day_key, mode, partner_user_id) VALUES (?, '2026-11-07', 'pair', ?)").run(p1.user.id, sam);
    db.prepare("INSERT INTO daily_results (user_id, day_key, mode, partner_user_id) VALUES (?, '2026-11-07', 'pair', ?)").run(sam, p1.user.id);
    db.prepare('INSERT INTO friends (user_id, friend_id) VALUES (?, ?)').run(sam, p1.user.id);
    db.prepare('INSERT INTO pairs (user_lo, user_hi, rides) VALUES (?, ?, 1)').run(String(Math.min(p1.user.id, sam)), String(Math.max(p1.user.id, sam)));

    // Without the typed confirmation, nothing happens.
    assert.equal((await call(env, '/me/delete', { method: 'POST', body: {}, token: p1.token })).status, 400);
    assert.equal((await call(env, '/me/delete', { method: 'POST', body: { confirm: 'delete' } , token: p1.token })).status, 400);
    assert.equal((await call(env, '/me/delete', { method: 'POST', body: { confirm: 'DELETE' } })).status, 401);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM users WHERE id = ?').get(p1.user.id).n, 1);

    const res = await call(env, '/me/delete', { method: 'POST', body: { confirm: 'DELETE' }, token: p1.token });
    assert.equal(res.status, 200, await res.clone().text());
    const out = await res.json();
    assert.equal(out.deleted, true);
    assert.equal(out.rides, 1);
    const id = p1.user.id;
    const n = (sql, ...a) => db.prepare(sql).get(...a).n;
    assert.equal(n('SELECT COUNT(*) n FROM users WHERE id = ?', id), 0);
    assert.equal(n('SELECT COUNT(*) n FROM user_identities WHERE user_id = ?', id), 0);
    assert.equal(n('SELECT COUNT(*) n FROM scores WHERE user_id = ?', id), 0);
    assert.equal(n('SELECT COUNT(*) n FROM score_contributions WHERE player_user_id = ?', id), 0);
    assert.equal(n('SELECT COUNT(*) n FROM user_achievements WHERE user_id = ?', id), 0);
    assert.equal(n('SELECT COUNT(*) n FROM daily_results WHERE user_id = ? OR partner_user_id = ?', id, id), 0);
    assert.equal(n('SELECT COUNT(*) n FROM friends WHERE user_id = ? OR friend_id = ?', id, id), 0);
    assert.equal(n('SELECT COUNT(*) n FROM pairs WHERE user_lo = ? OR user_hi = ?', String(id), String(id)), 0);
    // Sam keeps their own ride, achievement and daily result, with Pete taken off.
    assert.equal(n('SELECT COUNT(*) n FROM scores WHERE user_id = ?', sam), 1);
    assert.equal(n('SELECT COUNT(*) n FROM user_achievements WHERE user_id = ?', sam), 1);
    assert.equal(n('SELECT COUNT(*) n FROM daily_results WHERE user_id = ? AND partner_user_id IS NULL', sam), 1);
    assert.equal(n('SELECT COUNT(*) n FROM score_contributions WHERE score_id = ? AND player_user_id IS NULL', s2), 1);

    // The old session is refused with a code the game understands; Steam sign-in starts fresh.
    const me = await call(env, '/me', { token: p1.token });
    assert.equal(me.status, 401);
    assert.equal((await me.json()).code, 'account_gone');
    const again = await (await call(env, '/auth/steam', { method: 'POST', body: { steamId: '76561190000000001', personaName: 'pete_steam', ticket: 't' } })).json();
    assert.notEqual(again.user.id, id);
    assert.deepEqual(Object.keys(again.user.identities), ['steam'], 'a fresh account: Discord is not brought back');
  } finally { restore(); }
});

test('House Tandem Discord membership: member, not a member (with the invite), unknown, no Discord', async () => {
  const db = freshDb();
  const env = { ...envFor(db), DISCORD_GUILD_ID: 'G1', DISCORD_INVITE_URL: 'https://discord.gg/abc' };
  const restore = mockFetch(DISCORD_PETE);
  const inner = globalThis.fetch;
  let answer = 200;
  const asked = [];
  globalThis.fetch = async (input, init) => {
    const u = String(input && input.url ? input.url : input);
    if (u.includes('/guilds/')) { asked.push({ u, auth: init.headers.Authorization }); return new Response('{}', { status: answer }); }
    return inner(input, init);
  };
  try {
    const steam = await (await call(env, '/auth/steam', { method: 'POST', body: { steamId: '76561190000000001', personaName: 'p', ticket: 't' } })).json();
    let r = await (await call(env, '/me/discord', { token: steam.token })).json();
    assert.deepEqual(r, { linked: false, member: null, invite: 'https://discord.gg/abc' }, 'no Discord linked');

    const d = await deviceSignIn(env, steam.token);
    r = await (await call(env, '/me/discord', { token: d.token })).json();
    assert.equal(r.member, null, 'no bot token: unknown');
    assert.equal(asked.length, 0);

    env.DISCORD_BOT_TOKEN = 'bot-token';
    r = await (await call(env, '/me/discord', { token: d.token })).json();
    assert.equal(r.member, true);
    assert.equal(asked[0].u, `https://discord.com/api/v10/guilds/G1/members/${DISCORD_PETE.id}`);
    assert.equal(asked[0].auth, 'Bot bot-token');
    answer = 404;
    r = await (await call(env, '/me/discord', { token: d.token })).json();
    assert.equal(r.member, false);
    assert.equal(r.invite, 'https://discord.gg/abc');
    answer = 503;
    r = await (await call(env, '/me/discord', { token: d.token })).json();
    assert.equal(r.member, null, 'Discord down: unknown, not "not a member"');
    assert.equal((await call(env, '/me/discord')).status, 401);
  } finally { globalThis.fetch = inner; restore(); }
});

// ── House Tandem games: achievements + stats for dice and later games ──
import { houseTandemGames } from '../../worker/leaderboard.js';
import { mergeStats } from '../../worker/games.js';

test('game stats merge: add, max, or, union (capped), junk ignored', () => {
  let s = mergeStats({}, { add: { rolls: 1 }, max: { bestStreak: 3 }, or: { doubles: 0b1 }, union: { partners: ['7'] } });
  s = mergeStats(s, { add: { rolls: 2, bad: 'x' }, max: { bestStreak: 2 }, or: { doubles: 0b100000 }, union: { partners: ['7', '9'] } });
  assert.deepEqual(s, { rolls: 3, bestStreak: 3, doubles: 0b100001, partners: ['7', '9'] });
  assert.equal(mergeStats({}, { add: { 'bad key!': 1 } })['bad key!'], undefined);
  const many = mergeStats({}, { union: { p: Array.from({ length: 300 }, (_, i) => String(i)) } });
  assert.equal(many.p.length, 200);
});

test('a dice player from Discord gets an account; achievements and stats land once; profile and /me/games show them', async () => {
  const db = freshDb();
  const env = envFor(db);
  const restore = mockFetch(DISCORD_PETE);
  try {
    const a = await houseTandemGames.resolveDiscord(env, { discordId: DISCORD_PETE.id, name: 'Pete', avatar: 'https://evil.example/x.png' });
    assert.ok(a.userId);
    assert.match(a.avatar, /^https:\/\/cdn\.discordapp\.com\//, 'only Discord CDN pictures');
    // Signing in with Discord later lands on the same account.
    const web = await deviceSignIn(env);
    assert.equal(web.user.id, a.userId);
    assert.equal((await houseTandemGames.resolveDiscord(env, { discordId: DISCORD_PETE.id, name: 'Pete' })).userId, a.userId);
    await assert.rejects(houseTandemGames.resolveDiscord(env, { discordId: 'nope' }));

    let r = await houseTandemGames.recordGame(env, a.userId, 'dice', { add: { rolls: 1 } }, ['first_roll', 'snake_eyes', 'BAD ID']);
    assert.deepEqual(r.newlyEarned, ['first_roll', 'snake_eyes']);
    r = await houseTandemGames.recordGame(env, a.userId, 'dice', { add: { rolls: 1 } }, ['first_roll', 'boxcars']);
    assert.deepEqual(r.newlyEarned, ['boxcars'], 'never twice');
    const p = await houseTandemGames.gameProfile(env, a.userId, 'dice');
    assert.deepEqual(p.earned.sort(), ['boxcars', 'first_roll', 'snake_eyes']);
    assert.equal(p.stats.rolls, 2);
    await assert.rejects(houseTandemGames.recordGame(env, a.userId, 'Bad Game', {}, []));
    await assert.rejects(houseTandemGames.recordGame(env, 99999, 'dice', {}, ['first_roll']));

    const me = await (await call(env, '/me/games', { token: web.token })).json();
    assert.deepEqual(me.games.dice.earned.map((e) => e.id).sort(), ['boxcars', 'first_roll', 'snake_eyes']);
    assert.equal(me.games.dice.stats.rolls, 2);

    // verifySession: the website's session, with the Discord picture.
    const v = await houseTandemGames.verifySession(env, web.token);
    assert.equal(v.userId, a.userId);
    assert.equal(await houseTandemGames.verifySession(env, web.token.slice(0, -3) + 'abc'), null);

    // Deleting the account takes the game records too.
    assert.equal((await call(env, '/me/delete', { method: 'POST', body: { confirm: 'DELETE' }, token: web.token })).status, 200);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM game_achievements').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM game_stats').get().n, 0);
    assert.equal(await houseTandemGames.verifySession(env, web.token), null);
  } finally { restore(); }
});

test('handoff: a signed-in link opens another site signed in, once, within a minute', async () => {
  const db = freshDb();
  const env = envFor(db);
  const restore = mockFetch(DISCORD_PETE);
  try {
    const web = await deviceSignIn(env);
    assert.equal((await call(env, '/auth/handoff', { method: 'POST' })).status, 401);
    const { code, expires_in } = await (await call(env, '/auth/handoff', { method: 'POST', token: web.token })).json();
    assert.equal(expires_in, 60);
    const bad = await call(env, '/auth/handoff/redeem', { method: 'POST', body: { code: code.split('.')[0] + '.wrong' } });
    assert.equal(bad.status, 410);
    // A wrong guess burns the code.
    assert.equal((await call(env, '/auth/handoff/redeem', { method: 'POST', body: { code } })).status, 410);

    const fresh = await (await call(env, '/auth/handoff', { method: 'POST', token: web.token })).json();
    const ok = await call(env, '/auth/handoff/redeem', { method: 'POST', body: { code: fresh.code } });
    assert.equal(ok.status, 200);
    const out = await ok.json();
    assert.equal(out.user.id, web.user.id);
    assert.equal(jwtSub(out.token), web.user.id);
    assert.ok(out.user.identities.discord);
    assert.equal((await call(env, '/auth/handoff/redeem', { method: 'POST', body: { code: fresh.code } })).status, 410, 'single use');

    const old = await (await call(env, '/auth/handoff', { method: 'POST', token: web.token })).json();
    db.prepare('UPDATE auth_requests SET created_at = created_at - 61').run();
    assert.equal((await call(env, '/auth/handoff/redeem', { method: 'POST', body: { code: old.code } })).status, 410, 'expired');
  } finally { restore(); }
});
