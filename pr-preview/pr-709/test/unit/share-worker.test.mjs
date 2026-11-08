// #657 parts 2 + 3 · share a result through the API Worker: the card held for
// the TV's QR (store / fetch / TTL / limits) and the House Tandem Discord
// #daily-ride post (auth, Discord only, Daily Ride only, one a day, the webhook
// call). Runs the real worker on SQLite, as identity-worker.test.mjs does.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import worker from '../../worker/leaderboard.js';
import {
  SHARE_TTL_MS, SHARE_MAX_BYTES, SHARES_PER_DEVICE_DAY, SHARES_PER_IP_DAY,
  sniffImage, cleanLink, webhookName, dayKeyIsCurrent,
} from '../../worker/share.js';

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
    run: async () => { const r = db.prepare(sql).run(...args); return { success: true, meta: { last_row_id: Number(r.lastInsertRowid), changes: Number(r.changes) } }; },
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
  });
  return {
    prepare: (sql) => ({ bind: (...args) => bound(sql, args.map((a) => (a === undefined ? null : a))), ...bound(sql, []) }),
    batch: async (stmts) => { for (const s of stmts) db.prepare(s._sql).run(...s._args); return stmts.map(() => ({ success: true })); },
  };
}

const allow = { limit: async () => ({ success: true }) };
const HOOK = 'https://discord.com/api/webhooks/123/abc';
function envFor(db, extra = {}) {
  return {
    DB: d1(db), CORS_ORIGIN: 'https://tandemonium.housetandem.com', JWT_SECRET: 'test-secret',
    AUTH_LIMITER: allow, READ_LIMITER: allow, SHARE_LIMITER: allow, DISCORD_SHARE_WEBHOOK: HOOK, ...extra,
  };
}

const b64url = (b) => Buffer.from(b).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
function jwt(sub) {
  const data = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' })) + '.' + b64url(JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + 3600 }));
  return data + '.' + b64url(crypto.createHmac('sha256', 'test-secret').update(data).digest());
}

const call = (env, p, { method = 'GET', body, token, ip = '1.2.3.4' } = {}) => {
  const headers = { 'CF-Connecting-IP': ip, Origin: 'https://tandemonium.housetandem.com' };
  if (token) headers.Authorization = 'Bearer ' + token;
  let payload;
  if (body) { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
  return worker.fetch(new Request('https://api.test' + p, { method, headers, body: payload }), env, { waitUntil() {} });
};

// A tiny real PNG (1×1) and a fake JPEG header.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const today = () => new Date().toISOString().slice(0, 10);
const LINK = 'https://tandemonium.housetandem.com/?daily=' + today();
const upload = (env, extra = {}, opts = {}) => call(env, '/share', {
  method: 'POST', ...opts,
  body: { image: PNG.toString('base64'), caption: 'Tandemonium · Daily Ride · Nov 7 · 1:48 · 🥉', link: LINK, dayKey: today(), ...extra },
});

function addUser(db, { name = 'Pete', discord = true } = {}) {
  const r = db.prepare("INSERT INTO users (provider, provider_id, display_name, avatar_url) VALUES ('steam', ?, ?, NULL)").run(String(Math.random()), name);
  const id = Number(r.lastInsertRowid);
  if (discord) db.prepare("INSERT INTO user_identities (user_id, provider, provider_id, display_name, avatar_url) VALUES (?, 'discord', ?, ?, ?)")
    .run(id, '8035' + id, name + ' on discord', 'https://cdn.discordapp.com/avatars/8035/abc.png?size=128');
  return id;
}

/** Answer the webhook from a fixture; records what was posted. */
function fakeWebhook(status = 200) {
  const real = globalThis.fetch;
  const posts = [];
  globalThis.fetch = async (input, init = {}) => {
    const u = String(input && input.url ? input.url : input);
    if (!u.startsWith(HOOK)) throw new Error('unexpected fetch ' + u);
    const form = init.body;
    posts.push({ url: u, payload: JSON.parse(form.get('payload_json')), file: form.get('files[0]') });
    return new Response('{}', { status });
  };
  return { posts, restore: () => { globalThis.fetch = real; } };
}

test('helpers: image sniffing, links to the game only, Discord-safe names, the current day', () => {
  assert.equal(sniffImage(PNG), 'image/png');
  assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0])), 'image/jpeg');
  assert.equal(sniffImage(Buffer.from('GIF89a..')), null);
  assert.equal(cleanLink('https://tandemonium.housetandem.com/?daily=2026-11-07'), 'https://tandemonium.housetandem.com/?daily=2026-11-07');
  assert.equal(cleanLink('https://evil.example/?daily=1'), null);
  assert.equal(cleanLink('javascript:alert(1)'), null);
  assert.equal(webhookName('My Discord name'), 'My D-cord name');
  assert.equal(webhookName(''), 'A rider');
  const now = Date.parse('2026-11-07T15:00:00Z');
  assert.ok(dayKeyIsCurrent('2026-11-07', now));
  assert.ok(dayKeyIsCurrent('2026-11-06', now));
  assert.ok(!dayKeyIsCurrent('2026-11-04', now));
  assert.ok(!dayKeyIsCurrent('nope', now));
});

test('POST /share stores the card; GET returns its metadata and the image; no account needed', async () => {
  const db = freshDb();
  const env = envFor(db);
  const res = await upload(env);
  const out = await res.json();
  assert.equal(res.status, 201, JSON.stringify(out));
  assert.match(out.id, /^[A-Za-z0-9]{12}$/);
  assert.equal(out.url, 'https://tandemonium.housetandem.com/share/?id=' + out.id);
  assert.equal(out.imageUrl, 'https://api.test/share/' + out.id + '/image');

  const meta = await call(env, '/share/' + out.id);
  const m = await meta.json();
  assert.equal(meta.status, 200);
  assert.equal(m.caption, 'Tandemonium · Daily Ride · Nov 7 · 1:48 · 🥉');
  assert.equal(m.link, LINK);
  assert.equal(m.dayKey, today());
  assert.equal(meta.headers.get('Access-Control-Allow-Origin'), 'https://tandemonium.housetandem.com');

  const img = await call(env, '/share/' + out.id + '/image');
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('Content-Type'), 'image/png');
  assert.deepEqual(Buffer.from(await img.arrayBuffer()), PNG);

  assert.equal((await call(env, '/share/AAAAAAAAAAAA')).status, 404);
});

test('POST /share refuses what is not a card: not an image, too big; a foreign link is dropped', async () => {
  const db = freshDb();
  const env = envFor(db);
  assert.equal((await call(env, '/share', { method: 'POST', body: { image: Buffer.from('GIF89a......').toString('base64') } })).status, 415);
  assert.equal((await call(env, '/share', { method: 'POST', body: {} })).status, 400);
  const big = Buffer.concat([PNG, Buffer.alloc(SHARE_MAX_BYTES)]);
  assert.equal((await call(env, '/share', { method: 'POST', body: { image: big.toString('base64') } })).status, 413);
  const res = await upload(env, { link: 'https://evil.example/', caption: 'hi\n\u0007there' });
  const { id } = await res.json();
  const m = await (await call(env, '/share/' + id)).json();
  assert.equal(m.link, null);
  assert.equal(m.caption, 'hi there');
});

test('a share expires after its TTL and is cleaned up by the next upload', async () => {
  const db = freshDb();
  const env = envFor(db);
  const { id } = await (await upload(env)).json();
  const realNow = Date.now;
  try {
    const later = realNow() + SHARE_TTL_MS + 1000;
    Date.now = () => later;
    assert.equal((await call(env, '/share/' + id)).status, 404);
    assert.equal((await call(env, '/share/' + id + '/image')).status, 404);
    await upload(env);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM shares WHERE id = ?').get(id).n, 0, 'the expired row is gone');
  } finally { Date.now = realNow; }
});

test('rate limits: the per-minute limiter, and a daily cap per device and per IP', async () => {
  const db = freshDb();
  const deny = { limit: async () => ({ success: false }) };
  assert.equal((await upload(envFor(db, { SHARE_LIMITER: deny }))).status, 429);

  const env = envFor(db);
  const dev = '0f8fad5b-d9cb-469f-a165-70867728950e';
  for (let i = 0; i < SHARES_PER_DEVICE_DAY; i++) assert.equal((await upload(env, { deviceId: dev }, { ip: '9.9.9.' + i })).status, 201);
  const capped = await upload(env, { deviceId: dev }, { ip: '9.9.9.200' });
  assert.equal(capped.status, 429);
  assert.equal((await capped.json()).code, 'daily_cap');

  for (let i = 0; i < SHARES_PER_IP_DAY; i++) assert.equal((await upload(env, {}, { ip: '5.5.5.5' })).status, 201);
  assert.equal((await upload(env, {}, { ip: '5.5.5.5' })).status, 429);
  assert.equal((await upload(env, {}, { ip: '5.5.5.6' })).status, 201, 'another IP is not held back');
});

test('GET /share/config says whether the Discord post is set up', async () => {
  const db = freshDb();
  assert.deepEqual(await (await call(envFor(db), '/share/config')).json(), { discord: true });
  assert.deepEqual(await (await call(envFor(db, { DISCORD_SHARE_WEBHOOK: undefined }), '/share/config')).json(), { discord: false });
});

test('POST /share/discord posts the card under the Discord name and picture, once a day', async () => {
  const db = freshDb();
  const env = envFor(db);
  const uid = addUser(db, { name: 'Pete' });
  const { id } = await (await upload(env)).json();
  const hook = fakeWebhook();
  try {
    const res = await call(env, '/share/discord', { method: 'POST', token: jwt(uid), body: { id } });
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(hook.posts.length, 1);
    const p = hook.posts[0];
    assert.ok(p.url.startsWith(HOOK) && p.url.includes('wait=true'));
    assert.equal(p.payload.username, 'Pete on D-cord');
    assert.equal(p.payload.avatar_url, 'https://cdn.discordapp.com/avatars/8035/abc.png?size=128');
    assert.deepEqual(p.payload.allowed_mentions, { parse: [] });
    assert.match(p.payload.content, /^Tandemonium · Daily Ride · Nov 7 · 1:48 · 🥉\n<https:\/\/tandemonium\.housetandem\.com\/\?daily=/);
    assert.equal(p.file.type, 'image/png');
    assert.equal(p.file.size, PNG.length);

    // A second post the same day: refused, no webhook call.
    const { id: id2 } = await (await upload(env)).json();
    const again = await call(env, '/share/discord', { method: 'POST', token: jwt(uid), body: { id: id2 } });
    assert.equal(again.status, 409);
    assert.equal((await again.json()).code, 'already_posted');
    assert.equal(hook.posts.length, 1);
  } finally { hook.restore(); }
});

test('POST /share/discord: guests, no Discord, not the Daily Ride, an old day, and no webhook are refused', async () => {
  const db = freshDb();
  const env = envFor(db);
  const hook = fakeWebhook();
  try {
    const { id } = await (await upload(env)).json();
    let r = await call(env, '/share/discord', { method: 'POST', body: { id } });
    assert.equal(r.status, 401, 'a guest cannot post');

    const steamOnly = addUser(db, { discord: false });
    r = await call(env, '/share/discord', { method: 'POST', token: jwt(steamOnly), body: { id } });
    assert.equal(r.status, 403);
    assert.equal((await r.json()).code, 'no_discord');

    const uid = addUser(db);
    const { id: other } = await (await upload(env, { dayKey: undefined, link: 'https://tandemonium.housetandem.com/' })).json();
    r = await call(env, '/share/discord', { method: 'POST', token: jwt(uid), body: { id: other } });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).code, 'not_daily');

    const { id: old } = await (await upload(env, { dayKey: '2020-01-01' })).json();
    r = await call(env, '/share/discord', { method: 'POST', token: jwt(uid), body: { id: old } });
    assert.equal((await r.json()).code, 'old_day');

    r = await call(envFor(db, { DISCORD_SHARE_WEBHOOK: '' }), '/share/discord', { method: 'POST', token: jwt(uid), body: { id } });
    assert.equal(r.status, 503);
    assert.equal((await r.json()).code, 'discord_off');
    assert.equal(hook.posts.length, 0);
  } finally { hook.restore(); }
});

test('POST /share/discord: when Discord refuses, the day is not used up', async () => {
  const db = freshDb();
  const env = envFor(db);
  const uid = addUser(db);
  const { id } = await (await upload(env)).json();
  let hook = fakeWebhook(500);
  try {
    const r = await call(env, '/share/discord', { method: 'POST', token: jwt(uid), body: { id } });
    assert.equal(r.status, 502);
  } finally { hook.restore(); }
  hook = fakeWebhook(200);
  try {
    const r = await call(env, '/share/discord', { method: 'POST', token: jwt(uid), body: { id } });
    assert.equal(r.status, 200);
    assert.equal(hook.posts.length, 1);
  } finally { hook.restore(); }
});
