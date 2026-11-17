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
import { allowedReturnTo, discordAvatarUrl } from '../../worker/accounts/identity.js';

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

// #783 · rows carry the login that recorded them and the account they count for.
/** An account's first login id. */
const loginOf = (db, userId) => db.prepare('SELECT login_id FROM user_logins WHERE user_id = ? ORDER BY login_id LIMIT 1').get(userId).login_id;
const badge = (db, userId, id, scoreId = null) => db.prepare('INSERT INTO user_achievements (user_id, login_id, achievement_id, score_id) VALUES (?, ?, ?, ?)').run(userId, loginOf(db, userId), id, scoreId);
const gameBadge = (db, userId, game, id) => db.prepare('INSERT INTO game_achievements (user_id, login_id, game, achievement_id) VALUES (?, ?, ?, ?)').run(userId, loginOf(db, userId), game, id);
const ride = (db, userId, mode = 'solo', distance = 10, timeMs = 1000) => db.prepare("INSERT INTO scores (user_id, login_id, level_id, distance, time_ms, mode) VALUES (?, ?, 'grandma', ?, ?, ?)").run(userId, loginOf(db, userId), distance, timeMs, mode).lastInsertRowid;
/** The owner of a badge, as accounts (a badge row per login that earned it). */
/** A guest device's login (provider 'device'), with its small account: made if new. */
function guestLogin(db, key) {
  let row = db.prepare("SELECT login_id, user_id FROM user_logins WHERE provider = 'device' AND provider_id = ?").get(key);
  if (!row) {
    const userId = db.prepare("INSERT INTO users (provider, provider_id, display_name) VALUES ('account', ?, 'Guest')").run('guest-' + key).lastInsertRowid;
    db.prepare("INSERT INTO user_logins (user_id, provider, provider_id, display_name) VALUES (?, 'device', ?, 'Guest')").run(userId, key);
    row = db.prepare("SELECT login_id, user_id FROM user_logins WHERE provider = 'device' AND provider_id = ?").get(key);
  }
  return { userId: row.user_id, loginId: row.login_id };
}
/** An account with one Discord login, made straight in the tables. → its id, as a string */
function account(db, key, name) {
  const userId = db.prepare("INSERT INTO users (provider, provider_id, display_name) VALUES ('account', ?, ?)").run('test-' + key, name).lastInsertRowid;
  db.prepare("INSERT INTO user_logins (user_id, provider, provider_id, display_name) VALUES (?, 'discord', ?, ?)").run(userId, key, name);
  return String(userId);
}
const badgeOwners = (db, id) => db.prepare('SELECT DISTINCT user_id FROM user_achievements WHERE achievement_id = ? ORDER BY user_id').all(id).map((r) => r.user_id);
function envFor(db) {
  return {
    DB: d1(db), CORS_ORIGIN: 'https://tandemonium.housetandem.com', JWT_SECRET: 'test-secret',
    DISCORD_CLIENT_ID: 'cid', DISCORD_CLIENT_SECRET: 'csecret', STEAM_WEB_API_KEY: 'steamkey', RELAY_SECRET: 'relay-secret',
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
async function deviceSignIn(env, token = null, extra = {}) {
  const begin = await (await call(env, '/auth/discord/begin', { method: 'POST', body: { mode: 'device', ...extra }, token })).json();
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
  assert.ok(!html.includes(begin.code), 'the phone never shows the code: the player types what the screen shows (#612)');
  assert.ok(html.includes('name="code"'));
  poll = await (await call(env, '/auth/poll', { method: 'POST', body: { id: begin.id, secret: begin.secret } })).json();
  assert.equal(poll.status, 'confirming', 'no session until the player types the code');

  const k = html.match(/name="k" value="([^"]+)"/)[1];
  const ok = await call(env, '/auth/discord/confirm', { method: 'POST', form: { r: begin.id, k, code: begin.code.toLowerCase(), ok: '1' } });
  assert.equal(ok.status, 200);
  extra.onConfirmed && extra.onConfirmed(await ok.text());
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

const steamTicket = (env) => call(env, '/auth/steam', { method: 'POST', body: { steamId: '76561190000000001', personaName: 'pete_steam', ticket: 't' } }).then((r) => r.json());

test('Steam player links a new Discord from the TV: one account, both pictures, a notice', async () => {
  const db = freshDb();
  const env = envFor(db);
  const restore = mockFetch(DISCORD_PETE);
  try {
    const steam = await steamTicket(env);
    assert.deepEqual(Object.keys(steam.user.identities), ['steam']);
    let phone = '';
    const linked = await deviceSignIn(env, steam.token, { onConfirmed: (h) => { phone = h; } });
    assert.equal(linked.status, 'done');
    assert.equal(linked.linked, true);
    assert.equal(linked.user.id, steam.user.id);
    assert.deepEqual(Object.keys(linked.user.identities).sort(), ['discord', 'steam']);
    assert.match(phone, /Discord is linked/);

    const notices = (await (await call(env, '/me/notices', { token: linked.token })).json()).notices;
    assert.equal(notices.length, 1);
    assert.equal(notices[0].kind, 'link');
    assert.equal(notices[0].provider, 'discord');
    assert.equal(notices[0].login_name, 'Pete');
    assert.ok(notices[0].undo_until > notices[0].created_at + 6 * 86400);

    // Next launch: the Steam ticket alone brings Discord along; a Discord sign-in lands here too.
    const again = await steamTicket(env);
    assert.equal(again.user.identities.discord.name, 'Pete');
    assert.equal((await deviceSignIn(env)).user.id, steam.user.id);
  } finally { restore(); }
});

/** A Steam TV links a Discord that has its own account: the phone types the code and lands on the Combine page. */
async function phoneToCombine(env, db) {
  const web = await deviceSignIn(env);   // Pete's Discord account, with a badge here and in Carnival Dozer
  badge(db, web.user.id, 'first_ride');
  gameBadge(db, web.user.id, 'coins', 'jackpot');
  const steam = await steamTicket(env);
  const begin = await (await call(env, '/auth/discord/begin', { method: 'POST', body: { mode: 'device' }, token: steam.token })).json();
  const html = await (await call(env, `/auth/discord/callback?code=c&state=${begin.id}`)).text();
  const k = html.match(/name="k" value="([^"]+)"/)[1];
  const page = await (await call(env, '/auth/discord/confirm', { method: 'POST', form: { r: begin.id, k, code: begin.code, ok: '1' } })).text();
  const poll = () => call(env, '/auth/poll', { method: 'POST', body: { id: begin.id, secret: begin.secret } }).then((r) => r.json());
  const choose = (ok) => call(env, '/auth/discord/confirm', { method: 'POST', form: { r: begin.id, k, step: 'combine', ok } }).then((r) => r.text());
  return { web, steam, begin, k, page, poll, choose };
}

test('#612 · TV combine: after the typed code the phone shows both accounts (every game) and nothing moves yet', async () => {
  const db = freshDb();
  const env = envFor(db);
  const restore = mockFetch(DISCORD_PETE);
  try {
    const { web, page, poll } = await phoneToCombine(env, db);
    assert.match(page, /Combine your accounts\?/);
    assert.match(page, /already has its own House Tandem account/);
    assert.match(page, /pete_steam/, 'names the account on the screen');
    assert.match(page, /0 rides · 1 badge in Tandemonium/);
    assert.match(page, /Also: Carnival Dozer \(1 badge\)/, 'a combine moves every game, so the page says so');
    assert.match(page, /name="step" value="combine"/);
    assert.equal((await poll()).status, 'confirming', 'the TV keeps waiting while the phone decides');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n, 2, 'nothing combined before the choice');
    assert.equal(db.prepare("SELECT user_id FROM user_achievements WHERE achievement_id = 'first_ride'").get().user_id, web.user.id);
  } finally { restore(); }
});

test('#612 · TV combine: Combine folds the Discord account into the Steam one, with a notice and full undo', async () => {
  const db = freshDb();
  const env = envFor(db);
  const restore = mockFetch(DISCORD_PETE);
  try {
    const { web, steam, choose, poll } = await phoneToCombine(env, db);
    assert.match(await choose('1'), /now part of <b>pete_steam<\/b>/);
    const done = await poll();
    assert.equal(done.status, 'done');
    assert.equal(done.linked, true);
    assert.equal(done.merged, true, 'the TV pulls the combined progress');
    assert.equal(done.user.id, steam.user.id, 'the account on the screen is kept');
    assert.deepEqual(Object.keys(done.user.identities).sort(), ['discord', 'steam']);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n, 1);
    assert.equal(db.prepare("SELECT user_id FROM user_achievements WHERE achievement_id = 'first_ride'").get().user_id, steam.user.id);
    assert.equal(db.prepare("SELECT user_id FROM game_achievements WHERE achievement_id = 'jackpot'").get().user_id, steam.user.id);

    const notices = (await (await call(env, '/me/notices', { token: done.token })).json()).notices;
    assert.equal(notices[0].kind, 'combine');
    assert.equal(notices[0].provider, 'discord');
    const undo = await (await call(env, '/me/notices/undo', { method: 'POST', token: done.token, body: { id: notices[0].id } })).json();
    assert.equal(undo.undone, true);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n, 2, 'separated again');
    assert.equal(db.prepare("SELECT user_id FROM user_achievements WHERE achievement_id = 'first_ride'").get().user_id, web.user.id);
    assert.equal(db.prepare("SELECT user_id FROM game_achievements WHERE achievement_id = 'jackpot'").get().user_id, web.user.id);
  } finally { restore(); }
});

test('#612 · TV combine: Cancel changes nothing; Combine is refused without the typed code first', async () => {
  const db = freshDb();
  const env = envFor(db);
  const restore = mockFetch(DISCORD_PETE);
  try {
    const { web, choose, poll } = await phoneToCombine(env, db);
    assert.match(await choose('0'), /keeps its own account/);
    const res = await poll();
    assert.equal(res.status, 'error');
    assert.equal(res.error, 'cancelled');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n, 2);
    assert.equal(db.prepare("SELECT user_id FROM user_achievements WHERE achievement_id = 'first_ride'").get().user_id, web.user.id);

    // A new request: posting the Combine step straight away (no code typed) does nothing.
    const steam = await steamTicket(env);
    const begin = await (await call(env, '/auth/discord/begin', { method: 'POST', body: { mode: 'device' }, token: steam.token })).json();
    const html = await (await call(env, `/auth/discord/callback?code=c&state=${begin.id}`)).text();
    const k = html.match(/name="k" value="([^"]+)"/)[1];
    const forced = await call(env, '/auth/discord/confirm', { method: 'POST', form: { r: begin.id, k, step: 'combine', ok: '1' } });
    assert.equal(forced.status, 400);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n, 2, 'still two accounts');
  } finally { restore(); }
});

test('#612 · the phone must type the TV\'s code: wrong codes are refused, three strikes cancel', async () => {
  const db = freshDb();
  const env = envFor(db);
  const restore = mockFetch(DISCORD_PETE);
  try {
    const begin = await (await call(env, '/auth/discord/begin', { method: 'POST', body: { mode: 'device' } })).json();
    const html = await (await call(env, `/auth/discord/callback?code=c&state=${begin.id}`)).text();
    const k = html.match(/name="k" value="([^"]+)"/)[1];
    const wrong = begin.code === 'ZZZZ' ? 'YYYY' : 'ZZZZ';
    for (let i = 0; i < 2; i++) {
      const page = await (await call(env, '/auth/discord/confirm', { method: 'POST', form: { r: begin.id, k, code: wrong, ok: '1' } })).text();
      assert.match(page, /isn&#39;t the code on the screen|isn't the code on the screen/);
    }
    const third = await (await call(env, '/auth/discord/confirm', { method: 'POST', form: { r: begin.id, k, code: wrong, ok: '1' } })).text();
    assert.match(third, /didn&#39;t match|didn't match/);
    // Even the right code is too late now.
    const late = await call(env, '/auth/discord/confirm', { method: 'POST', form: { r: begin.id, k, code: begin.code, ok: '1' } });
    assert.equal(late.status, 410);
    const poll = await (await call(env, '/auth/poll', { method: 'POST', body: { id: begin.id, secret: begin.secret } })).json();
    assert.equal(poll.status, 'error');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n, 0);
  } finally { restore(); }
});

test('#783 · an account that had no login row gets one from the migration, and keeps its number', async () => {
  // (Before logins, a sign-in could exist only as the users row's own provider columns.)
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(fs.readFileSync(path.join(ROOT, 'worker/schema.sql'), 'utf8'));
  const run = (m) => {
    const text = fs.readFileSync(path.join(ROOT, 'worker/migrations', m), 'utf8').split(/\r?\n/).filter((l) => !l.trim().startsWith('--')).join(String.fromCharCode(10));
    for (const stmt of text.split(';')) { const q = stmt.trim(); if (!q) continue; try { db.exec(q); } catch (e) { if (!/duplicate column|already exists|no such table/i.test(e.message)) throw e; } }
  };
  const all = fs.readdirSync(path.join(ROOT, 'worker/migrations')).filter((m) => m.endsWith('.sql')).sort();
  for (const m of all.filter((m) => m < '0021')) run(m);
  db.prepare("INSERT INTO users (provider, provider_id, display_name) VALUES ('steam', '76561190000000001', 'old')").run();
  const before = db.prepare('SELECT id FROM users').get().id;
  db.prepare('DELETE FROM user_identities').run();
  run('0021_logins.sql');
  const env = envFor(db);
  const restore = mockFetch(DISCORD_PETE);
  try {
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
    assert.deepEqual([pair[0].user_lo, pair[0].user_hi].sort(), [p1.user.id, p2.user.id].sort());
    // #783 · each row says which login recorded it
    const logins = db.prepare('SELECT user_id, login_id FROM scores ORDER BY id').all();
    assert.deepEqual(logins.map((r) => r.login_id), [loginOf(db, p1.user.id), loginOf(db, p2.user.id)]);
    assert.deepEqual(db.prepare('SELECT player_login_id FROM score_contributions ORDER BY id').all().map((r) => r.player_login_id).sort(),
      [loginOf(db, p1.user.id), loginOf(db, p2.user.id)].sort());
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
      ...base, mode: 'stoker', couchGuest: true, newAchievements: ['first_finish'],
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
  db.exec(`INSERT OR IGNORE INTO user_logins (user_id, provider, provider_id, display_name, avatar_url, linked_at)
           SELECT id, provider, provider_id, display_name, avatar_url, created_at FROM users`);
  assert.equal(db.prepare("SELECT provider FROM user_logins WHERE provider_id = 'g1'").get().provider, 'google');
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
  const res = await call(env, returnTo.pathname + returnTo.search);
  res.begin = begin;
  return res;
}

/** The #ht_link=<id>.<code> a link callback sent the browser back with. */
function heldLink(res) {
  const loc = res.headers.get('Location') || '';
  const m = loc.match(/#ht_link=([^&]+)/);
  assert.ok(m, 'back with a one-time link code: ' + loc);
  const [id, code] = decodeURIComponent(m[1]).split('.');
  return { id, code };
}
const complete = (env, token, body) => call(env, '/auth/link/complete', { method: 'POST', token, body });
const combine = (env, token, body) => call(env, '/auth/link/combine', { method: 'POST', token, body });

test('#612 · linking Steam on the website: back with a code, finished only by the tab that began it, combine only on yes, undo separates', async () => {
  const db = freshDb();
  const env = envFor(db);
  const { restore } = mockSteamOpenId(true);
  try {
    // The Steam game made its own account and rode on it.
    const game = await steamTicket(env);
    badge(db, game.user.id, 'first_ride');
    ride(db, game.user.id);
    putPair(db, game.user.id, 'guest:abc', { rides: 3, distance: 30 });
    // Pete signs in with Discord on the website and links Steam.
    const web = await deviceSignIn(env);
    putPair(db, web.user.id, 'guest:abc', { rides: 2, distance: 20 });
    const withGuest = async (token) => (await (await call(env, '/pair?with=guest%3Aabc', { token })).json()).rides;
    const cb = await steamWebSignIn(env, { token: web.token });
    assert.equal(cb.status, 302);
    assert.ok(!cb.headers.get('Location').includes('ht_auth='), 'a link brings back no session');
    const { id, code } = heldLink(cb);
    const secret = cb.begin.secret;
    assert.equal(db.prepare("SELECT COUNT(DISTINCT user_id) n FROM user_logins WHERE provider != 'device'").get().n, 2, 'nothing linked by the callback itself');

    // Another browser (no secret, or someone else's session) can't finish it.
    assert.equal((await complete(env, null, { id, code, secret })).status, 410);
    assert.equal((await complete(env, game.token, { id, code, secret })).status, 410);
    assert.equal((await complete(env, web.token, { id, code, secret: 'guess' })).status, 410);
    assert.equal((await complete(env, web.token, { id, code: 'guess', secret })).status, 410);

    // The tab that began it: the Steam account has its own progress, so it asks first.
    const asked = await (await complete(env, web.token, { id, code, secret })).json();
    assert.equal(asked.status, 'combine');
    assert.equal(asked.provider, 'steam');
    assert.equal(asked.other.name, 'pete_steam');
    assert.equal(asked.other.rides, 1);
    assert.equal(asked.other.badges, 1);
    assert.equal(asked.into.name, 'Pete');
    assert.equal(db.prepare("SELECT COUNT(DISTINCT user_id) n FROM user_logins WHERE provider != 'device'").get().n, 2, 'still two until they say yes');
    assert.equal((await complete(env, web.token, { id, code, secret })).status, 410, 'the code is single use');

    const done = await (await combine(env, web.token, { id, secret, ok: true })).json();
    assert.equal(done.status, 'combined');
    assert.equal(done.user.id, web.user.id);
    assert.deepEqual(Object.keys(done.user.identities).sort(), ['discord', 'steam']);
    assert.equal(db.prepare("SELECT COUNT(DISTINCT user_id) n FROM user_logins WHERE provider != 'device'").get().n, 1);
    assert.equal(db.prepare("SELECT user_id FROM user_achievements WHERE achievement_id = 'first_ride'").get().user_id, web.user.id);
    assert.equal(await withGuest(done.token), 5, 'the pairs add up');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM pairs').get().n, 2, 'as two rows still: one per login');
    assert.equal((await combine(env, web.token, { id, secret, ok: true })).status, 410, 'single use');

    // The Steam game now lands on the combined account and sees the notice.
    const later = await steamTicket(env);
    assert.equal(later.user.id, web.user.id);
    const notices = (await (await call(env, '/me/notices', { token: later.token })).json()).notices;
    assert.equal(notices.length, 1);
    assert.equal(notices[0].kind, 'combine');
    assert.equal(notices[0].from_name, 'pete_steam');

    // "Separate them": the Steam account comes back as it was, and this Steam session ends.
    const undo = await (await call(env, '/me/notices/undo', { method: 'POST', token: later.token, body: { id: notices[0].id } })).json();
    assert.equal(undo.undone, true);
    assert.equal(undo.signed_out, true, 'the session came in through Steam, which left');
    assert.equal(db.prepare("SELECT COUNT(DISTINCT user_id) n FROM user_logins WHERE provider != 'device'").get().n, 2);
    assert.equal(db.prepare("SELECT user_id FROM user_achievements WHERE achievement_id = 'first_ride'").get().user_id, game.user.id);
    assert.equal(db.prepare('SELECT user_id FROM scores').get().user_id, game.user.id);
    assert.equal(await withGuest(web.token), 2, 'each account has its own record with the guest again');
    assert.equal(await withGuest((await steamTicket(env)).token), 3);
    assert.equal((await steamTicket(env)).user.id, game.user.id, 'Steam signs in to its own account again');
    assert.equal((await call(env, '/me/notices/undo', { method: 'POST', token: web.token, body: { id: notices[0].id } })).status, 410, 'once');
    assert.equal((await (await call(env, '/me/notices', { token: web.token })).json()).notices.length, 0);
  } finally { restore(); }
});

test('#612 · a link is finished only by the browser that began it, with that account signed in', async () => {
  const db = freshDb();
  const env = envFor(db);
  const { restore } = mockSteamOpenId(true);
  try {
    // Sam has a Steam account with progress and is signed in in their own browser.
    const sam = await steamTicket(env);
    badge(db, sam.user.id, 'first_ride');
    // Another account begins a link; Sam finishes the Steam step in Sam's browser.
    const other = await deviceSignIn(env);
    const cb = await steamWebSignIn(env, { token: other.token });
    const { id, code } = heldLink(cb);
    // Sam's browser has the code but Sam's own session and no secret.
    assert.equal((await complete(env, sam.token, { id, code, secret: 'unknown' })).status, 410);
    assert.equal((await complete(env, sam.token, { id, code, secret: cb.begin.secret })).status, 410);
    // The tab that began it has the secret but not the code.
    assert.equal((await complete(env, other.token, { id, code: 'x', secret: cb.begin.secret })).status, 410);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n, 2);
    assert.equal(db.prepare("SELECT user_id FROM user_logins WHERE provider = 'steam'").get().user_id, sam.user.id);
  } finally { restore(); }
});

test('#612 · linking needs a sign-in from the last 10 minutes', async () => {
  const db = freshDb();
  const env = envFor(db);
  const { restore } = mockSteamOpenId(true);
  try {
    const web = await deviceSignIn(env);
    // The same session, signed 11 minutes ago.
    const claims = JSON.parse(Buffer.from(web.token.split('.')[1], 'base64url').toString());
    const old = await makeToken({ ...claims, iat: claims.iat - 660 });
    for (const [p, body] of [['/auth/steam/begin', { return_to: 'https://tandemonium.housetandem.com/account' }],
                             ['/auth/discord/begin', { mode: 'redirect', return_to: 'https://tandemonium.housetandem.com/account' }],
                             ['/auth/discord/begin', { mode: 'device' }]]) {
      const res = await call(env, p, { method: 'POST', token: old, body });
      assert.equal(res.status, 401, p);
      assert.equal((await res.json()).code, 'fresh_signin');
    }
    // Signed out, the same buttons are plain sign-ins.
    assert.equal((await call(env, '/auth/steam/begin', { method: 'POST', body: { return_to: 'https://tandemonium.housetandem.com/account' } })).status, 200);
  } finally { restore(); }
});

/** A session token signed like the worker's, with chosen claims. */
async function makeToken(payload) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const data = `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc(payload)}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('test-secret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))).toString('base64url');
  return `${data}.${sig}`;
}

test('Steam sign-in on the web finds the account the Steam game made; linking from Discord asks to combine', async () => {
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

    // Someone signed in with Discord on the web links Steam: the game account combines in once they say yes.
    const discord = await deviceSignIn(env);
    assert.notEqual(discord.user.id, game.user.id);
    const link = await steamWebSignIn(env, { token: discord.token });
    assert.equal(link.status, 302);
    const { id, code } = heldLink(link);
    assert.equal((await (await complete(env, discord.token, { id, code, secret: link.begin.secret })).json()).status, 'combine');
    assert.equal((await (await combine(env, discord.token, { id, secret: link.begin.secret, ok: true })).json()).status, 'combined');
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
    const sam = Number(account(db, 'sam', 'Sam'));
    const L1 = loginOf(db, p1.user.id), LS = loginOf(db, sam);

    // A couch ride: Pete (P1) and Sam (P2) both credited; plus daily, friends, pairs.
    const s1 = ride(db, p1.user.id, 'captain', 1200, 200000);
    const s2 = ride(db, sam, 'stoker', 1200, 200000);
    for (const sc of [s1, s2]) {
      db.prepare("INSERT INTO score_contributions (score_id, role, player_user_id, player_login_id) VALUES (?, 'captain', ?, ?)").run(sc, p1.user.id, L1);
      db.prepare("INSERT INTO score_contributions (score_id, role, player_user_id, player_login_id) VALUES (?, 'stoker', ?, ?)").run(sc, sam, LS);
    }
    badge(db, p1.user.id, 'first_finish', s1);
    badge(db, sam, 'first_finish', s2);
    db.prepare("INSERT INTO daily_results (user_id, login_id, day_key, mode, partner_user_id, partner_login_id) VALUES (?, ?, '2026-11-07', 'pair', ?, ?)").run(p1.user.id, L1, sam, LS);
    db.prepare("INSERT INTO daily_results (user_id, login_id, day_key, mode, partner_user_id, partner_login_id) VALUES (?, ?, '2026-11-07', 'pair', ?, ?)").run(sam, LS, p1.user.id, L1);
    db.prepare('INSERT INTO friends (user_id, login_id, friend_user_id, friend_login_id) VALUES (?, ?, ?, ?)').run(sam, LS, p1.user.id, L1);
    putPair(db, p1.user.id, sam, { rides: 1, distance: 1200 });

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
    assert.equal(n('SELECT COUNT(*) n FROM user_logins WHERE user_id = ?', id), 0);
    assert.equal(n('SELECT COUNT(*) n FROM scores WHERE user_id = ?', id), 0);
    assert.equal(n('SELECT COUNT(*) n FROM score_contributions WHERE player_user_id = ?', id), 0);
    assert.equal(n('SELECT COUNT(*) n FROM user_achievements WHERE user_id = ?', id), 0);
    assert.equal(n('SELECT COUNT(*) n FROM daily_results WHERE user_id = ? OR partner_user_id = ?', id, id), 0);
    assert.equal(n('SELECT COUNT(*) n FROM friends WHERE user_id = ? OR friend_user_id = ?', id, id), 0);
    assert.equal(n('SELECT COUNT(*) n FROM pairs WHERE user_lo = ? OR user_hi = ?', id, id), 0);
    assert.equal(out.pairs, 1, 'one person ridden with');
    // Sam keeps their own ride, achievement and daily result, with Pete taken off.
    assert.equal(n('SELECT COUNT(*) n FROM scores WHERE user_id = ?', sam), 1);
    assert.equal(n('SELECT COUNT(*) n FROM user_achievements WHERE user_id = ?', sam), 1);
    assert.equal(n('SELECT COUNT(*) n FROM daily_results WHERE user_id = ? AND partner_user_id IS NULL AND partner_login_id IS NULL', sam), 1);
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
    assert.deepEqual(r, { linked: false, member: null, said_hello: null, invite: 'https://discord.gg/abc', server_url: 'https://discord.com/channels/G1' }, 'no Discord linked');

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

test('website sign-in with join_server: Discord link on the button, guilds.join, the player is added and the page is told', async () => {
  const db = freshDb();
  const env = { ...envFor(db), CORS_ORIGIN: 'https://housetandem.com', DISCORD_GUILD_ID: 'G1', DISCORD_BOT_TOKEN: 'bot-token' };
  const restore = mockFetch(DISCORD_PETE);
  const inner = globalThis.fetch;
  let answer = 201;
  const joins = [];
  globalThis.fetch = async (input, init) => {
    const u = String(input && input.url ? input.url : input);
    if (u.includes('/guilds/')) { joins.push({ u, method: init.method, auth: init.headers.Authorization, body: JSON.parse(init.body) }); return new Response(null, { status: answer }); }
    return inner(input, init);
  };
  const signIn = async (body) => {
    const begin = await (await call(env, '/auth/discord/begin', { method: 'POST', body: { mode: 'redirect', return_to: 'https://housetandem.com/account.html', ...body } })).json();
    const auth = new URL(begin.authorize_url);
    const go = new URL((await call(env, '/auth/discord/go?r=' + begin.id)).headers.get('Location'));
    assert.equal(go.toString(), auth.toString(), 'the button link and the redirect are the same consent screen');
    const cb = await call(env, `/auth/discord/callback?code=c&state=${auth.searchParams.get('state')}`);
    return { scope: auth.searchParams.get('scope'), loc: cb.headers.get('Location') };
  };
  try {
    let r = await signIn({ join_server: true });
    assert.equal(r.scope, 'identify guilds.join');
    assert.match(r.loc, /^https:\/\/housetandem\.com\/account\.html#ht_auth=[^&]+&ht_server=added$/);
    assert.deepEqual(joins[0], { u: `https://discord.com/api/v10/guilds/G1/members/${DISCORD_PETE.id}`, method: 'PUT', auth: 'Bot bot-token', body: { access_token: 'at' } });

    answer = 204;
    r = await signIn({ join_server: true });
    assert.match(r.loc, /&ht_server=already$/);

    answer = 403;   // the bot is missing Create Invite: still signed in
    r = await signIn({ join_server: true });
    assert.match(r.loc, /#ht_auth=[^&]+&ht_server=failed$/);

    const before = joins.length;
    r = await signIn({});
    assert.equal(r.scope, 'identify', 'the game asks for nothing more');
    assert.doesNotMatch(r.loc, /ht_server/);
    assert.equal(joins.length, before);

    delete env.DISCORD_BOT_TOKEN;
    r = await signIn({ join_server: true });
    assert.equal(r.scope, 'identify', 'no bot: no guilds.join on the consent screen');
    assert.doesNotMatch(r.loc, /ht_server/);
  } finally { globalThis.fetch = inner; restore(); }
});

test('Join checklist permissions: email kept while granted, a verified Steam connection links a Steam with no account (never combines one), unticked = asked for less', async () => {
  const db = freshDb();
  const env = { ...envFor(db), CORS_ORIGIN: 'https://housetandem.com', DISCORD_GUILD_ID: 'G1', DISCORD_BOT_TOKEN: 'bot-token' };
  const STEAM_ID = '76561190000000001';
  const restore = mockFetch({ ...DISCORD_PETE, email: 'pete@example.com', verified: true });
  const inner = globalThis.fetch;
  let conns = [{ type: 'steam', id: STEAM_ID, name: 'petesteam', verified: true }, { type: 'twitch', id: 'x', verified: true }];
  globalThis.fetch = async (input, init) => {
    const u = String(input && input.url ? input.url : input);
    if (u.includes('/guilds/')) return new Response(null, { status: 201 });
    if (u.includes('/users/@me/connections')) return Response.json(conns);
    return inner(input, init);
  };
  const signIn = async (scopes) => {
    const begin = await (await call(env, '/auth/discord/begin', { method: 'POST', body: { mode: 'redirect', return_to: 'https://housetandem.com/account.html', scopes } })).json();
    const auth = new URL(begin.authorize_url);
    const cb = await call(env, `/auth/discord/callback?code=c&state=${auth.searchParams.get('state')}`);
    const loc = cb.headers.get('Location');
    const token = decodeURIComponent(loc.match(/ht_auth=([^&]+)/)[1]);
    return { scope: auth.searchParams.get('scope'), token, loc };
  };
  const discordRow = () => db.prepare("SELECT user_id, scopes, email FROM user_logins WHERE provider = 'discord'").get();
  try {
    // The Steam game made its own account first, with a ride on it.
    const steam = await (await call(env, '/auth/steam', { method: 'POST', body: { steamId: STEAM_ID, personaName: 'p', ticket: 't' } })).json();
    const steamUser = db.prepare("SELECT user_id FROM user_logins WHERE provider = 'steam'").get().user_id;

    let r = await signIn(['guilds.join', 'email', 'connections', 'bogus']);
    assert.equal(r.scope, 'identify guilds.join email connections', 'junk scopes are dropped');
    let row = discordRow();
    assert.equal(row.email, 'pete@example.com');
    assert.equal(row.scopes, 'identify guilds.join email connections');
    const me = await (await call(env, '/me', { token: r.token })).json();
    assert.ok(!me.user.identities.steam, 'a Steam with its own account is left on it (#612)');
    assert.ok(me.user.identities.discord);
    assert.match(r.loc, /ht_steam=has_account/, 'the page is told, so it can offer Link Steam (and the combine screen)');
    assert.equal(db.prepare("SELECT user_id FROM user_logins WHERE provider = 'steam'").get().user_id, steamUser);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM users WHERE id = ?').get(steamUser).n, 1, 'the Steam account is still its own');
    assert.ok(steam.token);

    // A verified Steam with no account of its own is linked, with a notice.
    const db3 = freshDb();
    const env3 = { ...env, DB: d1(db3) };
    const b3 = await (await call(env3, '/auth/discord/begin', { method: 'POST', body: { mode: 'redirect', return_to: 'https://housetandem.com/account.html', scopes: ['connections'] } })).json();
    const cb3 = await call(env3, `/auth/discord/callback?code=c&state=${b3.id}`);
    const t3 = decodeURIComponent(cb3.headers.get('Location').match(/ht_auth=([^&]+)/)[1]);
    const me3 = await (await call(env3, '/me', { token: t3 })).json();
    assert.ok(me3.user.identities.steam, 'the Steam account Discord verified is linked');
    assert.equal((await (await call(env3, '/me/notices', { token: t3 })).json()).notices[0].provider, 'steam');

    // Email unticked next time: forgotten. Connections unticked: not fetched.
    conns = [];
    r = await signIn(['guilds.join']);
    assert.equal(r.scope, 'identify guilds.join');
    row = discordRow();
    assert.equal(row.email, null, 'email dropped when news is turned off');
    assert.equal(row.scopes, 'identify guilds.join');

    // An unverified Steam connection is never linked.
    const db2 = freshDb();
    const env2 = { ...env, DB: d1(db2) };
    conns = [{ type: 'steam', id: STEAM_ID, verified: false }];
    const begin = await (await call(env2, '/auth/discord/begin', { method: 'POST', body: { mode: 'redirect', return_to: 'https://housetandem.com/account.html', scopes: ['connections'] } })).json();
    await call(env2, `/auth/discord/callback?code=c&state=${begin.id}`);
    assert.equal(db2.prepare("SELECT COUNT(*) n FROM user_logins WHERE provider = 'steam'").get().n, 0);
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

// ── #678 · a guest's pairs move to the account when that device signs in ──

const STEAM_PETE = { steamId: '76561190000000001', personaName: 'pete_steam', ticket: 't' };
const pairRows = (db) => db.prepare('SELECT login_lo, login_hi, user_lo, user_hi, rides, distance, best_json, last_ride FROM pairs ORDER BY login_lo, login_hi').all();
/** #783 · one side of a pair: an account id (its first login), or 'guest:<device key>' (a device login). */
const pairSide = (db, x) => (typeof x === 'string' && x.startsWith('guest:')
  ? guestLogin(db, x.slice(6)) : { userId: Number(x), loginId: loginOf(db, Number(x)) });
function putPair(db, a, b, { rides, distance, best = {}, lastRide, bestStreak = 0 }) {
  const A = pairSide(db, a), B = pairSide(db, b);
  const [lo, hi] = A.loginId < B.loginId ? [A, B] : [B, A];
  db.prepare(`INSERT INTO pairs (login_lo, login_hi, user_lo, user_hi, rides, distance, best_json, last_ride, daily_streak, daily_best_streak, daily_last_key)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL)`).run(lo.loginId, hi.loginId, lo.userId, hi.userId, rides, distance, JSON.stringify(best), lastRide ?? null, bestStreak);
}
/** Pair rows that still belong to an unclaimed guest device. */
const guestPairRows = (db) => db.prepare(
  `SELECT COUNT(*) n FROM pairs p WHERE EXISTS (SELECT 1 FROM user_logins l WHERE l.login_id IN (p.login_lo, p.login_hi)
     AND l.provider = 'device' AND l.provider_id NOT LIKE '%:claimed:%')`).get().n;

test('#678 guest pair → this device signs in (Steam) → the pair is under the account and readable; a second sign-in adds nothing', async () => {
  const db = freshDb();
  const env = { ...envFor(db), SCORE_LIMITER: allow };
  const restore = mockFetch(DISCORD_PETE);
  try {
    const sam = await deviceSignIn(env);   // Sam's own sign-in, no device id: nothing to claim
    // Pete rode on device 'devA' signed out; Sam posted the ride, Pete = guest:devA.
    const res = await call(env, '/score', { method: 'POST', token: sam.token, body: {
      levelId: 'grandma', distance: 1200, timeMs: 200000, mode: 'stoker', couchGuest: true,
      contributions: { captain: { overallPct: 55, userId: null, guestDeviceId: 'devA' }, stoker: { overallPct: 45, userId: sam.user.id } } } });
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal((await (await call(env, '/pair?with=guest%3AdevA', { token: sam.token })).json()).rides, 1);

    const pete = await (await call(env, '/auth/steam', { method: 'POST', body: { ...STEAM_PETE, device_id: 'devA' } })).json();
    const fromPete = await (await call(env, '/pair?with=' + sam.user.id, { token: pete.token })).json();
    assert.equal(fromPete.rides, 1);
    assert.equal(fromPete.distance, 1200);
    assert.deepEqual(fromPete.best, { grandma: 200000 });
    const fromSam = await (await call(env, '/pair?with=' + pete.user.id, { token: sam.token })).json();
    assert.deepEqual(fromSam, fromPete, 'Sam sees the same record');
    assert.equal(guestPairRows(db), 0, 'no guest row left');

    // Signing in again (the Steam build does on every token refresh) counts nothing twice.
    await call(env, '/auth/steam', { method: 'POST', body: { ...STEAM_PETE, device_id: 'devA' } });
    assert.equal((await (await call(env, '/pair?with=' + sam.user.id, { token: pete.token })).json()).rides, 1);
    assert.equal(pairRows(db).length, 1);

    // An old build (no device_id) and junk ids still sign in fine.
    assert.equal((await call(env, '/auth/steam', { method: 'POST', body: STEAM_PETE })).status, 200);
    assert.equal((await call(env, '/auth/steam', { method: 'POST', body: { ...STEAM_PETE, device_id: { x: 1 } } })).status, 200);
  } finally { restore(); }
});

test('#678 collision: rides and distance add, the better time per level and the later last ride win; a pair with yourself is dropped', async () => {
  const db = freshDb();
  const env = envFor(db);
  const restore = mockFetch(DISCORD_PETE);
  try {
    const pete = await (await call(env, '/auth/steam', { method: 'POST', body: STEAM_PETE })).json();
    const P = String(pete.user.id);
    const S = account(db, 'sam', 'Sam');
    const K = account(db, 'kim', 'Kim');

    putPair(db, P, S, { rides: 2, distance: 2400, best: { grandma: 200000, forest: 300000 }, lastRide: '2026-11-01 10:00:00', bestStreak: 3 });
    putPair(db, 'guest:devA', S, { rides: 3, distance: 3000, best: { grandma: 180000, river: 250000 }, lastRide: '2026-11-05 10:00:00', bestStreak: 1 });
    putPair(db, 'guest:devA', K, { rides: 1, distance: 900, best: { grandma: 210000 }, lastRide: '2026-11-04 10:00:00' });
    putPair(db, 'guest:devA', P, { rides: 4, distance: 4000, lastRide: '2026-11-06 10:00:00' });   // Pete's own device, Pete signed in as P2
    putPair(db, 'guest:devB', S, { rides: 7, distance: 7000, lastRide: '2026-11-06 10:00:00' });   // another device: untouched

    // Pete signs in with Discord on the TV (device code), linking to his account.
    const linked = await deviceSignIn(env, pete.token, { device_id: 'devA' });
    assert.equal(linked.status, 'done');
    assert.equal(linked.user.id, pete.user.id);

    const withSam = await (await call(env, '/pair?with=' + S, { token: pete.token })).json();
    assert.equal(withSam.rides, 5);
    assert.equal(withSam.distance, 5400);
    assert.deepEqual(withSam.best, { grandma: 180000, forest: 300000, river: 250000 });
    assert.equal(withSam.last_ride, '2026-11-05 10:00:00');
    assert.equal(withSam.daily_best_streak, 3);
    const withKim = await (await call(env, '/pair?with=' + K, { token: pete.token })).json();
    assert.equal(withKim.rides, 1);
    assert.deepEqual(withKim.best, { grandma: 210000 });

    // #783 · nothing was merged row by row: devA's login joined Pete's account, and the two
    // people's record is read from all their logins' rows. devB is still a guest.
    assert.equal(guestPairRows(db), 1, 'devB untouched');
    assert.equal((await (await call(env, '/pair?with=' + P, { token: pete.token })).json()).rides, 0, 'a pair with yourself is not a pair');
    assert.equal((await (await call(env, '/me/delete', { method: 'POST', token: pete.token, body: { confirm: 'no' } })).status), 400);

    // Again, by Discord redirect this time: nothing moves twice.
    const begin = await (await call(env, '/auth/discord/begin', { method: 'POST', body: { mode: 'redirect', return_to: 'https://tandemonium.housetandem.com/', device_id: 'devA' } })).json();
    const cb = await call(env, `/auth/discord/callback?code=c&state=${begin.id}`);
    assert.equal(cb.status, 302);
    assert.equal((await (await call(env, '/pair?with=' + S, { token: pete.token })).json()).rides, 5);
  } finally { restore(); }
});

test('#678 Discord redirect and Steam on the web claim the device too; a seat sign-in (no device id) does not', async () => {
  const db = freshDb();
  const env = envFor(db);
  const { restore } = mockSteamOpenId(true);
  try {
    const S = account(db, 'sam', 'Sam');
    putPair(db, 'guest:devR', S, { rides: 2, distance: 2000, lastRide: '2026-11-05 10:00:00' });
    putPair(db, 'guest:devW', S, { rides: 6, distance: 6000, lastRide: '2026-11-05 10:00:00' });

    // A seat sign-in on devR sends no device id: devR's guest stays put.
    const seat = await deviceSignIn(env);
    assert.equal(guestPairRows(db), 2, 'devR and devW are still guests');

    // Player 1 on devR signs in by redirect.
    const begin = await (await call(env, '/auth/discord/begin', { method: 'POST', body: { mode: 'redirect', return_to: 'https://tandemonium.housetandem.com/', device_id: 'devR' } })).json();
    const loc = (await call(env, `/auth/discord/callback?code=c&state=${begin.id}`)).headers.get('Location');
    const token = decodeURIComponent(loc.split('#ht_auth=')[1]);
    assert.equal(jwtSub(token), seat.user.id, 'same Discord account as the seat sign-in');
    assert.equal((await (await call(env, '/pair?with=' + S, { token })).json()).rides, 2);

    // Steam on the web from devW.
    const wb = await (await call(env, '/auth/steam/begin', { method: 'POST', body: { return_to: 'https://tandemonium.housetandem.com/account', device_id: 'devW' } })).json();
    const login = new URL((await call(env, '/auth/steam/go?r=' + encodeURIComponent(wb.id))).headers.get('Location'));
    const returnTo = new URL(login.searchParams.get('openid.return_to'));
    const claimed = 'https://steamcommunity.com/openid/id/76561190000000002';
    for (const [k, v] of Object.entries({
      'openid.ns': 'http://specs.openid.net/auth/2.0', 'openid.mode': 'id_res',
      'openid.op_endpoint': 'https://steamcommunity.com/openid/login',
      'openid.claimed_id': claimed, 'openid.identity': claimed,
      'openid.return_to': returnTo.toString(), 'openid.response_nonce': '2026-11-07T00:00:00Zabc',
      'openid.assoc_handle': '1', 'openid.signed': 'signed,op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle',
      'openid.sig': 'c2ln',
    })) returnTo.searchParams.set(k, v);
    const steamLoc = (await call(env, returnTo.pathname + returnTo.search)).headers.get('Location');
    const steamToken = decodeURIComponent(steamLoc.split('#ht_auth=')[1]);
    assert.equal((await (await call(env, '/pair?with=' + S, { token: steamToken })).json()).rides, 6);
    assert.equal(guestPairRows(db), 0);
  } finally { restore(); }
});

test('the Steam sign-in attaches its analytics session to the account, before or after the create', async () => {
  const db = freshDb();
  const env = envFor(db);
  const restore = mockFetch(DISCORD_PETE);
  try {
    const early = '44444444-5555-4666-8777-888888888888';   // sign-in lands first
    const late = '55555555-6666-4777-8888-999999999999';    // session row already there
    db.prepare("INSERT INTO sessions (id, started_at, platform) VALUES (?, '2026-11-09T10:00:00.000Z', 'steam')").run(late);
    const a = await (await call(env, '/auth/steam', { method: 'POST', body: { steamId: '76561190000000001', personaName: 'wolf', ticket: 't', session_id: early } })).json();
    await call(env, '/auth/steam', { method: 'POST', body: { steamId: '76561190000000001', personaName: 'wolf', ticket: 't', session_id: late } });
    const uid = (id) => db.prepare('SELECT google_uid FROM sessions WHERE id = ?').get(id).google_uid;
    assert.equal(uid(early), String(a.user.id));
    assert.equal(uid(late), String(a.user.id));
    // A bad session id never fails the sign-in.
    const bad = await call(env, '/auth/steam', { method: 'POST', body: { steamId: '76561190000000001', personaName: 'wolf', ticket: 't', session_id: 'nope' } });
    assert.equal(bad.status, 200);
  } finally { restore(); }
});

test('Join checklist "say hello": a post in the hello channel since joining counts, is remembered, and Discord trouble is unknown', async () => {
  const db = freshDb();
  const env = { ...envFor(db), DISCORD_GUILD_ID: 'G1', DISCORD_BOT_TOKEN: 'bot-token', DISCORD_HELLO_CHANNEL_IDS: ' 111, nope ' };
  const restore = mockFetch(DISCORD_PETE);
  const inner = globalThis.fetch;
  const joined = '2026-11-10T00:00:00.000Z';
  const msg = (id, author, ts) => ({ id: String(id), author: { id: author }, timestamp: ts });
  const others = (n, from, ts) => Array.from({ length: n }, (_, i) => msg(from - i, 'someone', ts));
  let pages = [[msg(9, 'someone', '2026-11-12T00:00:00Z')]];
  let channelStatus = 200;
  const asked = [];
  globalThis.fetch = async (input, init) => {
    const u = String(input && input.url ? input.url : input);
    if (u.includes('/guilds/')) return Response.json({ joined_at: joined });
    if (u.includes('/channels/')) {
      asked.push(u);
      if (channelStatus !== 200) return new Response('{}', { status: channelStatus });
      const before = new URL(u).searchParams.get('before');
      const i = before ? pages.findIndex((p) => p.length && p[0].id === String(Number(before) - 1)) : 0;
      return Response.json(i >= 0 ? pages[i] || [] : []);
    }
    return inner(input, init);
  };
  const hello = async (token) => (await (await call(env, '/me/discord', { token })).json()).said_hello;
  try {
    const steam = await (await call(env, '/auth/steam', { method: 'POST', body: { steamId: '76561190000000001', personaName: 'p', ticket: 't' } })).json();
    const d = await deviceSignIn(env, steam.token);
    assert.equal(await hello(d.token), false, 'no post yet');
    pages = [[{ ...msg(10, DISCORD_PETE.id, '2026-11-12T00:00:00Z'), type: 7 }]];
    assert.equal(await hello(d.token), false, "Discord's join notice in #welcome isn't a hello");
    pages = [[{ ...msg(11, DISCORD_PETE.id, '2026-11-12T00:00:00Z'), type: 19 }]];
    assert.equal(await hello(d.token), true, 'a reply is');
    db.prepare('UPDATE user_logins SET said_hello_at = NULL').run();
    assert.ok(asked[0].endsWith('/v10/channels/111/messages?limit=100'));
    asked.length = 0;

    // Two full pages: the hello is on the second, still after joining.
    pages = [others(100, 300, '2026-11-12T00:00:00Z'), [...others(99, 200, '2026-11-11T00:00:00Z'), msg(101, DISCORD_PETE.id, '2026-11-11T00:00:00Z')]];
    asked.length = 0;
    assert.equal(await hello(d.token), true);
    assert.equal(asked.length, 2);
    assert.ok(asked[1].includes('before=201'));
    assert.ok(db.prepare("SELECT said_hello_at FROM user_logins WHERE provider = 'discord'").get().said_hello_at > 0);

    // Remembered: Discord isn't asked again.
    asked.length = 0;
    pages = [[]];
    assert.equal(await hello(d.token), true);
    assert.equal(asked.length, 0);

    // Paging stops at the join time; a channel the bot can't read is unknown.
    db.prepare('UPDATE user_logins SET said_hello_at = NULL').run();
    pages = [others(100, 300, '2026-11-01T00:00:00Z'), [msg(101, DISCORD_PETE.id, '2026-10-01T00:00:00Z')]];
    asked.length = 0;
    assert.equal(await hello(d.token), false, 'older than joining: not looked at');
    assert.equal(asked.length, 1);
    channelStatus = 403;
    assert.equal(await hello(d.token), null);
  } finally { globalThis.fetch = inner; restore(); }
});

// ── #612 · combine records, separate restores ──
import { combineAccounts, separateAccount } from '../../worker/accounts/combine.js';

test('#783 · combine then separate: every row goes back to the login that recorded it, rides made in between too', async () => {
  const db = freshDb();
  const env = { ...envFor(db), SCORE_LIMITER: allow };
  const add = (sql, ...a) => db.prepare(sql).run(...a);
  // Ann (10, Discord login 1), Bea (20, Steam login 2), Cat (30, Discord login 3).
  add("INSERT INTO users (id, provider, provider_id, display_name) VALUES (10, 'account', 'a', 'Ann'), (20, 'account', 'b', 'Bea'), (30, 'account', 'c', 'Cat')");
  add("INSERT INTO user_logins (login_id, user_id, provider, provider_id) VALUES (1, 10, 'discord', 'a'), (2, 20, 'steam', 'b'), (3, 30, 'discord', 'c')");
  add("INSERT INTO scores (user_id, login_id, level_id, distance, time_ms, mode) VALUES (10, 1, 'grandma', 10, 1000, 'solo'), (20, 2, 'grandma', 20, 900, 'solo')");
  add("INSERT INTO score_contributions (score_id, role, player_user_id, player_login_id) VALUES (1, 'solo', 10, 1), (2, 'solo', 20, 2)");
  add("INSERT INTO user_achievements (user_id, login_id, achievement_id, earned_at) VALUES (10, 1, 'shared', '2026-11-02'), (20, 2, 'shared', '2026-11-01'), (20, 2, 'bea_only', '2026-11-03')");
  add("INSERT INTO daily_results (user_id, login_id, day_key, mode, time_ms) VALUES (10, 1, '2026-11-10', 'solo', 100000), (20, 2, '2026-11-10', 'solo', 90000), (20, 2, '2026-11-11', 'solo', 80000)");
  add("INSERT INTO daily_results (user_id, login_id, day_key, mode, time_ms, partner_user_id, partner_login_id) VALUES (30, 3, '2026-11-12', 'pair', 70000, 20, 2)");
  add('INSERT INTO friends (user_id, login_id, friend_user_id, friend_login_id) VALUES (20, 2, 30, 3), (10, 1, 30, 3)');
  add('INSERT INTO pairs (login_lo, login_hi, user_lo, user_hi, rides, distance) VALUES (1, 3, 10, 30, 2, 200), (2, 3, 20, 30, 5, 500)');
  add("INSERT INTO game_achievements (user_id, login_id, game, achievement_id) VALUES (10, 1, 'dice', 'roll'), (20, 2, 'dice', 'roll'), (20, 2, 'dice', 'six')");
  add('INSERT INTO game_stats (user_id, login_id, game, stats_json, ops_json) VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)',
    10, 1, 'dice', '{"rolls":4,"best":9}', '{"rolls":"add","best":"max"}', 20, 2, 'dice', '{"rolls":6,"best":7}', '{"rolls":"add","best":"max"}', 20, 2, 'coins', '{"c":3}', '{"c":"add"}');
  add("INSERT INTO game_playtime (user_id, login_id, game, seconds, sessions) VALUES (10, 1, 'dice', 100, 1), (20, 2, 'dice', 50, 2), (20, 2, 'coins', 40, 1)");
  add("INSERT INTO sessions (id, started_at, google_uid, login_id) VALUES ('s-ann', '2026-11-01', '10', 1), ('s-bea', '2026-11-01', '20', 2)");
  const snap = () => JSON.stringify({
    scores: db.prepare('SELECT id, user_id, login_id FROM scores ORDER BY id').all(),
    contrib: db.prepare('SELECT score_id, player_user_id, player_login_id FROM score_contributions ORDER BY id').all(),
    ach: db.prepare('SELECT user_id, login_id, achievement_id FROM user_achievements ORDER BY login_id, achievement_id').all(),
    daily: db.prepare('SELECT id, user_id, login_id, day_key, time_ms, partner_user_id, partner_login_id FROM daily_results ORDER BY id').all(),
    friends: db.prepare('SELECT user_id, login_id, friend_user_id, friend_login_id FROM friends ORDER BY login_id').all(),
    pairs: db.prepare('SELECT login_lo, login_hi, user_lo, user_hi, rides FROM pairs ORDER BY login_lo').all(),
    gach: db.prepare('SELECT user_id, login_id, game, achievement_id FROM game_achievements ORDER BY login_id, game, achievement_id').all(),
    gstats: db.prepare('SELECT user_id, login_id, game, stats_json FROM game_stats ORDER BY login_id, game').all(),
    gtime: db.prepare('SELECT user_id, login_id, game, seconds, sessions FROM game_playtime ORDER BY login_id, game').all(),
    sessions: db.prepare('SELECT id, google_uid, login_id FROM sessions ORDER BY id').all(),
    logins: db.prepare('SELECT login_id, user_id, provider, provider_id FROM user_logins ORDER BY login_id').all(),
    users: db.prepare('SELECT id, provider, provider_id, display_name FROM users ORDER BY id').all(),
  });
  const before = snap();

  // Bea's account folds into Ann's.
  const moved = JSON.parse(JSON.stringify(await combineAccounts(env, 20, 10)));   // stored as JSON
  assert.deepEqual(moved.logins, [2]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM users WHERE id = 20').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM scores WHERE user_id = 10').get().n, 2);

  // Read as ONE account: a shared badge once (the earlier date), time added, stats by rule,
  // the day's better Daily, and one record with Cat from both logins' rides.
  const { gameProfile } = await import('../../worker/games.js');
  const dice = await gameProfile(env, 10, 'dice');
  assert.deepEqual(dice.earned.sort(), ['roll', 'six']);
  assert.deepEqual(dice.stats, { rolls: 10, best: 9 });
  assert.equal(dice.playtime.seconds, 150);
  const annToken = await makeToken({ sub: 10, lid: 1 });
  const me = await (await call(env, '/me', { token: annToken })).json();
  assert.deepEqual(me.achievements.map((a) => [a.achievement_id, a.earned_at]).sort(), [['bea_only', '2026-11-03'], ['shared', '2026-11-01']]);
  const board = await (await call(env, '/daily?key=2026-11-10', { token: annToken })).json();
  assert.deepEqual(board.results.map((r) => [r.user_id, r.time_ms]), [[10, 90000]], 'the better of the two logins\u2019 times');
  assert.equal((await (await call(env, '/pair?with=30', { token: annToken })).json()).rides, 7);

  // A session that came in through Bea's Steam login is now Ann's account, and what it
  // records is recorded under that login.
  const beaToken = await makeToken({ sub: 20, lid: 2 });
  assert.equal((await (await call(env, '/me', { token: beaToken })).json()).user.id, 10, 'the session follows its login');
  freshScoreClock(db);
  const posted = await call(env, '/score', { method: 'POST', token: beaToken, body: { levelId: 'grandma', distance: 1200, timeMs: 200000, mode: 'solo', newAchievements: ['after_combine', 'shared'] } });
  assert.equal(posted.status, 200, await posted.clone().text());
  assert.deepEqual({ ...db.prepare('SELECT user_id, login_id FROM scores ORDER BY id DESC LIMIT 1').get() }, { user_id: 10, login_id: 2 });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM user_achievements WHERE achievement_id = 'shared'").get().n, 2, 'a badge the account already has is not recorded again');

  // Separate: Bea is account 20 again, with everything her login recorded, before and after.
  const back = await separateAccount(env, moved, 10);
  assert.deepEqual(back, { userId: 20, logins: [2] });
  assert.deepEqual({ ...db.prepare('SELECT user_id, login_id FROM scores ORDER BY id DESC LIMIT 1').get() }, { user_id: 20, login_id: 2 }, 'the ride made in between goes with the login that made it');
  assert.equal(db.prepare("SELECT user_id FROM user_achievements WHERE achievement_id = 'after_combine'").get().user_id, 20);
  assert.equal((await (await call(env, '/me', { token: beaToken })).json()).user.id, 20);
  db.prepare('DELETE FROM score_contributions WHERE score_id = (SELECT MAX(id) FROM scores)').run();
  db.prepare("DELETE FROM user_achievements WHERE achievement_id = 'after_combine'").run();
  db.prepare('DELETE FROM scores WHERE id = (SELECT MAX(id) FROM scores)').run();
  assert.equal(snap(), before, 'everything else is back exactly where it was');
  assert.equal(await separateAccount(env, moved, 10), null, 'only once');
});

test('undo a link: the sign-in leaves the account; the session that came in through it ends', async () => {
  const db = freshDb();
  const env = envFor(db);
  const restore = mockFetch(DISCORD_PETE);
  try {
    const steam = await steamTicket(env);
    await deviceSignIn(env, steam.token);
    const discordSession = await deviceSignIn(env);   // signed in through the Discord that was linked
    assert.equal(discordSession.user.id, steam.user.id);
    const [n] = (await (await call(env, '/me/notices', { token: steam.token })).json()).notices;
    // Seen: off the game's banner, still undoable on the account page.
    await call(env, '/me/notices/seen', { method: 'POST', token: steam.token, body: { id: n.id } });
    const after = (await (await call(env, '/me/notices', { token: steam.token })).json()).notices;
    assert.equal(after[0].seen, true);
    const undo = await (await call(env, '/me/notices/undo', { method: 'POST', token: discordSession.token, body: { id: n.id } })).json();
    assert.equal(undo.undone, true);
    assert.equal(undo.signed_out, true);
    assert.deepEqual(Object.keys((await (await call(env, '/me', { token: steam.token })).json()).user.identities), ['steam']);
    // That Discord now signs in to an account of its own.
    assert.notEqual((await deviceSignIn(env)).user.id, steam.user.id);
  } finally { restore(); }
});

test('undo a link never removes the last sign-in on an account', async () => {
  const db = freshDb();
  const env = envFor(db);
  const restore = mockFetch(DISCORD_PETE);
  try {
    const steam = await steamTicket(env);
    await deviceSignIn(env, steam.token);
    const [n] = (await (await call(env, '/me/notices', { token: steam.token })).json()).notices;
    db.prepare("DELETE FROM user_logins WHERE provider = 'steam'").run();   // only Discord is left
    const res = await call(env, '/me/notices/undo', { method: 'POST', token: steam.token, body: { id: n.id } });
    assert.equal(res.status, 409);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM user_logins').get().n, 1);
  } finally { restore(); }
});

test('the combine screen\'s No: nothing changes, the request is gone', async () => {
  const db = freshDb();
  const env = envFor(db);
  const { restore } = mockSteamOpenId(true);
  try {
    await steamTicket(env);
    const web = await deviceSignIn(env);
    const cb = await steamWebSignIn(env, { token: web.token });
    const { id, code } = heldLink(cb);
    assert.equal((await (await complete(env, web.token, { id, code, secret: cb.begin.secret })).json()).status, 'combine');
    assert.equal((await (await combine(env, web.token, { id, secret: cb.begin.secret, ok: false })).json()).status, 'cancelled');
    assert.equal((await combine(env, web.token, { id, secret: cb.begin.secret, ok: true })).status, 410);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n, 2);
  } finally { restore(); }
});

test('the account\'s Discord is told by direct message, with the undo date and the account page', async () => {
  const db = freshDb();
  const env = { ...envFor(db), DISCORD_BOT_TOKEN: 'bot', ACCOUNT_URL: 'https://housetandem.com/account.html' };
  const restore = mockFetch(DISCORD_PETE);
  const inner = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (input, init) => {
    const u = String(input && input.url ? input.url : input);
    if (u.endsWith('/v10/users/@me/channels')) { sent.push(['open', JSON.parse(init.body).recipient_id, init.headers.Authorization]); return Response.json({ id: 'dm1' }); }
    if (u.endsWith('/v10/channels/dm1/messages')) { sent.push(['msg', JSON.parse(init.body).content]); return Response.json({ id: 'm1' }); }
    return inner(input, init);
  };
  try {
    const web = await deviceSignIn(env);   // Discord account
    const { addLogin } = await import('../../worker/accounts/identity.js');
    await addLogin(env, web.user.id, { provider: 'steam', providerId: '76561190000000009', name: 'petesteam', avatar: null });
    assert.deepEqual(sent[0], ['open', DISCORD_PETE.id, 'Bot bot']);
    assert.match(sent[1][1], /Steam account "petesteam" was added to your House Tandem account "Pete"/);
    assert.match(sent[1][1], /until [A-Z][a-z]{2} \d{1,2}: https:\/\/housetandem\.com\/account\.html/);
  } finally { globalThis.fetch = inner; restore(); }
});

// ------------------------------------------------------------
// 2026-11-17 · who rode together: a score or Daily post names a partner only with proof
// ------------------------------------------------------------
import { signPairProof, guestKey as guestKeyFor } from '../../worker/room-proof.js';

const RIDE = { levelId: 'grandma', distance: 1200, timeMs: 200000 };
const C2 = (stoker) => ({ captain: { overallPct: 55 }, stoker: { overallPct: 45, ...stoker } });
const freshScoreClock = (db) => db.prepare("UPDATE scores SET created_at = datetime('now', '-1 minute')").run();
const contribUser = (db, role) => db.prepare('SELECT player_user_id FROM score_contributions WHERE role = ? ORDER BY id DESC LIMIT 1').get(role).player_user_id;

test('online score: a partner named in the body is not kept; the room’s proof names them', async () => {
  const db = freshDb();
  const env = { ...envFor(db), SCORE_LIMITER: allow };
  const restore = mockFetch(DISCORD_PETE);
  try {
    const pete = await (await call(env, '/auth/steam', { method: 'POST', body: STEAM_PETE })).json();
    const sam = await deviceSignIn(env);
    const post = (body) => { freshScoreClock(db); return call(env, '/score', { method: 'POST', token: pete.token, body: { ...RIDE, mode: 'captain', ...body } }); };

    // No proof: the ride is Pete's; the claimed partner is dropped, no pair, no Daily access.
    assert.equal((await post({ contributions: C2({ userId: sam.user.id }) })).status, 200);
    assert.equal(contribUser(db, 'captain'), pete.user.id, 'the caller’s own seat is always the caller');
    assert.equal(contribUser(db, 'stoker'), null);
    assert.equal(pairRows(db).length, 0);

    // Proofs that don't fit: forged, someone else's room, Pete in the other seat.
    const forged = await signPairProof('wrong-secret', 'TNDM-ABCD', { u: pete.user.id }, { u: sam.user.id });
    const others = await signPairProof('relay-secret', 'TNDM-ABCD', { u: sam.user.id }, { u: 999 });
    const swapped = await signPairProof('relay-secret', 'TNDM-ABCD', { u: sam.user.id }, { u: pete.user.id });
    for (const pairProof of [forged, others, swapped, 'junk']) {
      assert.equal((await post({ pairProof, contributions: C2({ userId: sam.user.id }) })).status, 200);
      assert.equal(contribUser(db, 'stoker'), null);
    }
    assert.equal(pairRows(db).length, 0);

    // The room's proof: Sam is the partner (even if the body says someone else).
    const proof = await signPairProof('relay-secret', 'TNDM-ABCD', { u: pete.user.id }, { u: sam.user.id });
    assert.equal((await post({ pairProof: proof, contributions: C2({ userId: 12345 }) })).status, 200);
    assert.equal(contribUser(db, 'stoker'), sam.user.id);
    const pair = await (await call(env, '/pair?with=' + sam.user.id, { token: pete.token })).json();
    assert.equal(pair.rides, 1);
  } finally { restore(); }
});

test('online score with a guest partner: keyed by the guest key from the proof, claimed when that device signs in', async () => {
  const db = freshDb();
  const env = { ...envFor(db), SCORE_LIMITER: allow };
  const restore = mockFetch(DISCORD_PETE);
  try {
    const sam = await deviceSignIn(env);
    const gk = await guestKeyFor('relay-secret', 'device-guest-1');
    freshScoreClock(db);
    // A body naming a guest (by device id or key) without proof records nothing.
    await call(env, '/score', { method: 'POST', token: sam.token, body: { ...RIDE, mode: 'stoker',
      contributions: { captain: { overallPct: 50, guestDeviceId: 'device-guest-1', guestKey: gk }, stoker: { overallPct: 50 } } } });
    assert.equal(pairRows(db).length, 0);

    freshScoreClock(db);
    const proof = await signPairProof('relay-secret', 'TNDM-ABCD', { g: gk }, { u: sam.user.id });
    await call(env, '/score', { method: 'POST', token: sam.token, body: { ...RIDE, mode: 'stoker', pairProof: proof,
      contributions: { captain: { overallPct: 50 }, stoker: { overallPct: 50 } } } });
    const guest = db.prepare("SELECT login_id, user_id FROM user_logins WHERE provider = 'device' AND provider_id = ?").get(gk);
    assert.ok(guest, 'the guest is a device login, keyed by the guest key');
    assert.deepEqual(pairRows(db).map((r) => [r.login_lo, r.login_hi].sort()), [[loginOf(db, sam.user.id), guest.login_id].sort()]);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM user_logins WHERE provider_id LIKE '%device-guest-1%'").get().n, 0, 'the device id is never stored');
    assert.equal(db.prepare("SELECT player_login_id FROM score_contributions WHERE role = 'captain' ORDER BY id DESC LIMIT 1").get().player_login_id, guest.login_id);
    assert.equal((await (await call(env, '/pair?with=guest%3A' + gk, { token: sam.token })).json()).rides, 1);

    const pete = await (await call(env, '/auth/steam', { method: 'POST', body: { ...STEAM_PETE, device_id: 'device-guest-1' } })).json();
    assert.equal((await (await call(env, '/pair?with=' + sam.user.id, { token: pete.token })).json()).rides, 1, 'the guest’s history is now Pete’s');
  } finally { restore(); }
});

test('Daily: a partner is kept only with the room’s proof or the partner’s own sign-in; numbers stay numbers', async () => {
  const db = freshDb();
  const env = { ...envFor(db), SCORE_LIMITER: allow, DAILY_LIMITER: allow };
  const restore = mockFetch(DISCORD_PETE);
  try {
    const pete = await (await call(env, '/auth/steam', { method: 'POST', body: STEAM_PETE })).json();
    const sam = await deviceSignIn(env);
    const day = new Date(Date.now() - 9 * 3600 * 1000).toISOString().slice(0, 10);
    const daily = async (extra, timeMs) => call(env, '/daily', { method: 'POST', token: pete.token,
      body: { dayKey: day, mode: 'pair', timeMs, dnf: false, distance: 1200, partnerUserId: sam.user.id, ...extra } });
    const partner = () => db.prepare('SELECT partner_user_id p FROM daily_results WHERE user_id = ?').get(pete.user.id).p;

    assert.equal((await daily({}, 300000)).status, 200);
    assert.equal(partner(), null, 'no proof: not kept');
    const proof = await signPairProof('relay-secret', 'TNDM-ABCD', { u: pete.user.id }, { u: sam.user.id });
    await daily({ pairProof: proof }, 290000);
    assert.equal(partner(), sam.user.id);
    await daily({ seatToken: sam.token }, 280000);
    assert.equal(partner(), sam.user.id, 'a couch Player 2’s own sign-in proves it too');

    freshScoreClock(db);
    assert.equal((await call(env, '/score', { method: 'POST', token: pete.token, body: { ...RIDE, distance: '1200' } })).status, 400);
    freshScoreClock(db);
    await call(env, '/score', { method: 'POST', token: pete.token, body: { ...RIDE, mode: 'solo', collectiblesCount: '<b>9</b>',
      inputSource: '<img>', contributions: { solo: { overallPct: 'x', totalTaps: 1e12 }, evil: { overallPct: 1 } } } });
    const row = db.prepare('SELECT collectibles_count c, input_source i FROM scores ORDER BY id DESC LIMIT 1').get();
    assert.deepEqual({ ...row }, { c: 0, i: 'none' });
    const c = db.prepare('SELECT role, contribution_pct p, pedal_taps t FROM score_contributions ORDER BY id DESC LIMIT 2').all().map((r) => ({ ...r }));
    assert.deepEqual(c, [{ role: 'solo', p: 0, t: 1e6 }], 'junk becomes numbers in range; unknown roles are dropped');
  } finally { restore(); }
});

test('a name outside Latin-1 signs in, and its session reads back with the name intact', async () => {
  const db = freshDb();
  const env = envFor(db);
  const name = '“Pétè” 山口 🚲';
  const restore = mockFetch({ ...DISCORD_PETE, global_name: name });
  try {
    const begin = await (await call(env, '/auth/discord/begin', { method: 'POST', body: { mode: 'redirect', return_to: 'https://tandemonium.housetandem.com/' } })).json();
    const cb = await call(env, `/auth/discord/callback?code=c&state=${encodeURIComponent(begin.id)}`);
    assert.equal(cb.status, 302);
    const token = decodeURIComponent(cb.headers.get('Location').split('#ht_auth=')[1]);
    assert.match(token, /^[A-Za-z0-9_.-]+$/);
    const claims = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    assert.equal(claims.name, name, 'a plain atob + JSON.parse reader gets the name');
    const me = await call(env, '/me', { token });
    assert.equal(me.status, 200);
  } finally { restore(); }
});

test('a failure inside a sign-in page is answered with a page and logged, never left unhandled', async () => {
  const db = freshDb();
  const env = envFor(db);
  const restore = mockFetch(DISCORD_PETE);
  const logged = [];
  const realError = console.error;
  console.error = (...a) => logged.push(a.join(' '));
  try {
    const begin = await (await call(env, '/auth/discord/begin', { method: 'POST', body: { mode: 'redirect', return_to: 'https://tandemonium.housetandem.com/' } })).json();
    const realPrepare = env.DB.prepare;
    // The first sign-in makes the account (an INSERT); the second updates it, and that fails.
    await call(env, `/auth/discord/callback?code=c&state=${encodeURIComponent(begin.id)}`);
    const again = await (await call(env, '/auth/discord/begin', { method: 'POST', body: { mode: 'redirect', return_to: 'https://tandemonium.housetandem.com/' } })).json();
    env.DB.prepare = (sql) => { if (/^UPDATE users SET/.test(sql)) throw new Error('database said no'); return realPrepare(sql); };
    const cb = await call(env, `/auth/discord/callback?code=c&state=${encodeURIComponent(again.id)}`);
    assert.equal(cb.status, 500);
    assert.match(cb.headers.get('Content-Type'), /text\/html/);
    const html = await cb.text();
    assert.ok(html.includes('Something went wrong'));
    assert.ok(!html.includes('database said no'), 'the page does not show the cause');
    assert.ok(logged.some((l) => l.includes('/auth/discord/callback') && l.includes('database said no')), 'the log does');
    // A script's route answers in JSON.
    env.DB.prepare = () => { throw new Error('database said no'); };
    const api = await call(env, '/auth/poll', { method: 'POST', body: { id: again.id, secret: again.secret } });
    assert.equal(api.status, 500);
    assert.equal((await api.json()).error, 'database said no');
  } finally { console.error = realError; restore(); }
});
