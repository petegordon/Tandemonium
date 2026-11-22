// Analytics consent: players in the EEA, the UK and Switzerland are asked first, their
// answer is recorded, and nothing is kept from those countries without a yes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

// analytics.js reaches for browser globals at import time and on use.
const mem = () => { const m = new Map(); return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
globalThis.localStorage = globalThis.localStorage || mem();
globalThis.sessionStorage = globalThis.sessionStorage || mem();

const worker = (await import('../../worker/leaderboard.js')).default;
const { consentRequired, CONSENT_VERSION: SERVER_VERSION } = await import('../../worker/accounts/consent.js');
const { resolveConsent, storedConsent, saveConsent, europeanTimeZone, CONSENT_VERSION } = await import('../../js/consent.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SECRET = 'test-secret';

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
const envFor = (db) => ({ DB: d1(db), CORS_ORIGIN: '*', JWT_SECRET: SECRET });
const ADDRESS = '203.0.113.9';
const call = (env, p, { country = 'DE', body, method = body === undefined ? 'GET' : 'POST' } = {}) => worker.fetch(new Request('https://api.test' + p, {
  method, headers: { 'Content-Type': 'text/plain', 'CF-Connecting-IP': ADDRESS, ...(country ? { 'CF-IPCountry': country } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
}), env, { waitUntil() {} });

const b64 = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
function token(claims) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64({ iat: now, exp: now + 3600, ...claims });
  return head + '.' + crypto.createHmac('sha256', SECRET).update(head).digest('base64url');
}
/** An account with one Discord login. → { userId, loginId, token } */
function account(db, name = 'Greta') {
  const userId = Number(db.prepare("INSERT INTO users (provider, provider_id, display_name) VALUES ('account', ?, ?)").run('u-' + name, name).lastInsertRowid);
  const loginId = Number(db.prepare("INSERT INTO user_logins (user_id, provider, provider_id, display_name) VALUES (?, 'discord', ?, ?)").run(userId, 'd-' + name, name).lastInsertRowid);
  return { userId, loginId, token: token({ sub: userId, lid: loginId, name }) };
}

const ID = '11111111-2222-4333-8444-555555555555';
const ID2 = '11111111-2222-4333-8444-666666666666';
const SID = '99999999-2222-4333-8444-555555555555';

test('which countries are asked: the EU, the rest of the EEA, the UK and Switzerland; nobody else', () => {
  for (const c of ['DE', 'FR', 'IE', 'PL', 'SE', 'NO', 'IS', 'LI', 'GB', 'CH']) assert.equal(consentRequired(c), true, c);
  for (const c of ['US', 'CA', 'JP', 'BR', 'AU', 'TR', null, '']) assert.equal(consentRequired(c), false, String(c));
  assert.equal(SERVER_VERSION, CONSENT_VERSION, 'the game and the server ask about the same wording');
});

test('GET /consent/region says whether this player is asked', async () => {
  const env = envFor(freshDb());
  assert.deepEqual(await (await call(env, '/consent/region', { country: 'DE' })).json(), { required: true, country: 'DE', version: CONSENT_VERSION });
  assert.deepEqual(await (await call(env, '/consent/region', { country: 'US' })).json(), { required: false, country: 'US', version: CONSENT_VERSION });
  assert.equal((await (await call(env, '/consent/region', { country: null })).json()).required, false);
});

test('a yes is recorded with the account, its name, the time, the country and the address', async () => {
  const db = freshDb();
  const env = envFor(db);
  const who = account(db);
  const before = Math.floor(Date.now() / 1000);
  const res = await call(env, '/consent', { country: 'DE', body: { id: ID, choice: 'accept', version: CONSENT_VERSION, account_token: who.token } });
  assert.equal(res.status, 200);
  const row = db.prepare('SELECT * FROM consents WHERE id = ?').get(ID);
  assert.equal(row.choice, 'accept');
  assert.equal(row.policy_version, CONSENT_VERSION);
  assert.equal(row.user_id, who.userId);
  assert.equal(row.login_id, who.loginId);
  assert.equal(row.username, 'Greta');
  assert.equal(row.country, 'DE');
  assert.equal(row.ip_address, ADDRESS);
  assert.ok(row.created_at >= before && row.created_at <= before + 5);
});

test('a yes before signing in is recorded without an account, and gains it on the same id later, once', async () => {
  const db = freshDb();
  const env = envFor(db);
  await call(env, '/consent', { body: { id: ID, choice: 'accept', version: CONSENT_VERSION } });
  assert.equal(db.prepare('SELECT user_id FROM consents WHERE id = ?').get(ID).user_id, null);
  const greta = account(db, 'Greta');
  const hans = account(db, 'Hans');
  assert.equal((await call(env, '/consent', { body: { id: ID, choice: 'accept', version: CONSENT_VERSION, account_token: greta.token } })).status, 200);
  await call(env, '/consent', { body: { id: ID, choice: 'accept', version: CONSENT_VERSION, account_token: hans.token } });
  const row = db.prepare('SELECT user_id, username FROM consents WHERE id = ?').get(ID);
  assert.deepEqual({ ...row }, { user_id: greta.userId, username: 'Greta' }, 'the answer stays with the first account');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM consents').get().n, 1);
});

test('a no keeps the choice, the time and the country, and nothing about who', async () => {
  const db = freshDb();
  const who = account(db);
  await call(envFor(db), '/consent', { country: 'FR', body: { id: ID, choice: 'decline', version: CONSENT_VERSION, account_token: who.token } });
  const row = db.prepare('SELECT * FROM consents WHERE id = ?').get(ID);
  assert.equal(row.choice, 'decline');
  assert.equal(row.country, 'FR');
  assert.equal(row.user_id, null);
  assert.equal(row.username, null);
  assert.equal(row.ip_address, null);
});

test('an answer is never rewritten: the other choice on the same id is refused, and bad input is refused', async () => {
  const db = freshDb();
  const env = envFor(db);
  await call(env, '/consent', { body: { id: ID, choice: 'decline', version: CONSENT_VERSION } });
  assert.equal((await call(env, '/consent', { body: { id: ID, choice: 'accept', version: CONSENT_VERSION } })).status, 409);
  assert.equal(db.prepare('SELECT choice FROM consents WHERE id = ?').get(ID).choice, 'decline');
  for (const body of [{ id: 'nope', choice: 'accept', version: CONSENT_VERSION }, { id: ID2, choice: 'maybe', version: CONSENT_VERSION }, { id: ID2, choice: 'accept' }]) {
    assert.equal((await call(env, '/consent', { body })).status, 400);
  }
  assert.equal((await call(env, '/consent', { body: { id: ID2, choice: 'accept', version: CONSENT_VERSION, pad: 'x'.repeat(5000) } })).status, 413);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM consents').get().n, 1);
});

test('analytics from a country that asks are kept only with the mark of a yes; elsewhere as before', async () => {
  const db = freshDb();
  const env = envFor(db);
  const batch = { events: [{ session_id: SID, event_type: 'page_view', created_at: '2026-11-22T10:00:00.000Z' }] };
  const count = () => db.prepare('SELECT COUNT(*) n FROM events').get().n;
  const dropped = await call(env, '/api/analytics/event/batch', { country: 'DE', body: batch });
  assert.equal(dropped.status, 204);
  assert.equal(count(), 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sessions').get().n, 0, 'no session row, so no address either');
  assert.equal((await call(env, '/api/analytics/event/batch?consent=' + CONSENT_VERSION, { country: 'DE', body: batch })).status, 200);
  assert.equal(count(), 1);
  assert.equal((await call(env, '/api/analytics/event/batch', { country: 'US', body: batch })).status, 200);
  assert.equal(count(), 2);
});

test('deleting the account removes its consent answers', async () => {
  const db = freshDb();
  const env = envFor(db);
  const who = account(db);
  await call(env, '/consent', { body: { id: ID, choice: 'accept', version: CONSENT_VERSION, account_token: who.token } });
  const fresh = token({ sub: who.userId, lid: who.loginId, name: 'Greta', auth_time: Math.floor(Date.now() / 1000) });
  const res = await worker.fetch(new Request('https://api.test/me/delete', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + fresh, 'CF-Connecting-IP': ADDRESS }, body: JSON.stringify({ confirm: 'DELETE' }),
  }), env, { waitUntil() {} });
  assert.equal(res.status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM consents').get().n, 0);
});

// ── the game's side ──

const regionApi = (required, log = []) => async (url, init = {}) => {
  log.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
  if (String(url).endsWith('/consent/region')) return { ok: true, json: async () => ({ required, country: required ? 'DE' : 'US' }) };
  return { ok: true, json: async () => ({ ok: true }) };
};

test('outside those countries nobody is asked and analytics run', async () => {
  let asked = 0;
  const out = await resolveConsent({ ask: async () => { asked++; return 'accept'; }, storage: mem(), fetchImpl: regionApi(false), apiBase: 'https://api.test', nav: {} });
  assert.deepEqual(out, { allowed: true, required: false, mark: null });
  assert.equal(asked, 0);
});

test('inside them the player is asked once; a yes is kept, sent with the session, and marks analytics', async () => {
  const storage = mem();
  const log = [];
  let asked = 0;
  const o = { ask: async () => { asked++; return 'accept'; }, getToken: () => 'tok', storage, fetchImpl: regionApi(true, log), apiBase: 'https://api.test', nav: {} };
  assert.deepEqual(await resolveConsent(o), { allowed: true, required: true, mark: CONSENT_VERSION });
  const sent = log.find((c) => c.url.endsWith('/consent'));
  assert.equal(sent.body.choice, 'accept');
  assert.equal(sent.body.account_token, 'tok');
  assert.equal(sent.body.id, storedConsent(storage).id);
  assert.deepEqual(await resolveConsent(o), { allowed: true, required: true, mark: CONSENT_VERSION });
  assert.equal(asked, 1, 'not asked again');
});

test('a no turns analytics off, is remembered, and sends no token; new wording asks again', async () => {
  const storage = mem();
  const log = [];
  let asked = 0;
  const o = { ask: async () => { asked++; return 'decline'; }, getToken: () => 'tok', storage, fetchImpl: regionApi(true, log), apiBase: 'https://api.test', nav: {} };
  assert.deepEqual(await resolveConsent(o), { allowed: false, required: true, mark: null });
  assert.equal(log.find((c) => c.url.endsWith('/consent')).body.account_token, undefined);
  await resolveConsent(o);
  assert.equal(asked, 1);
  storage.setItem('tandemonium_consent', JSON.stringify({ ...storedConsent(storage), version: '2020-01-01' }));
  await resolveConsent(o);
  assert.equal(asked, 2);
});

test('Global Privacy Control is a no without asking, anywhere; an unreachable server falls back to the time zone', async () => {
  let asked = 0;
  const ask = async () => { asked++; return 'accept'; };
  const gpc = await resolveConsent({ ask, storage: mem(), fetchImpl: regionApi(false), apiBase: 'https://api.test', nav: { globalPrivacyControl: true } });
  assert.equal(gpc.allowed, false);
  assert.equal(asked, 0);
  const down = async (url) => { if (String(url).endsWith('/consent/region')) throw new Error('offline'); return { ok: true, json: async () => ({}) }; };
  const berlin = await resolveConsent({ ask, storage: mem(), fetchImpl: down, apiBase: 'https://api.test', nav: {}, timeZone: 'Europe/Berlin' });
  assert.equal(berlin.required, true);
  assert.equal(asked, 1);
  const ohio = await resolveConsent({ ask, storage: mem(), fetchImpl: down, apiBase: 'https://api.test', nav: {}, timeZone: 'America/New_York' });
  assert.deepEqual(ohio, { allowed: true, required: false, mark: null });
  assert.ok(europeanTimeZone('Atlantic/Reykjavik') && !europeanTimeZone('Asia/Tokyo') && !europeanTimeZone(undefined));
});

test('Settings changes the answer with a new record each time', () => {
  const storage = mem();
  const sent = [];
  const fetchImpl = async (_u, init) => { sent.push(JSON.parse(init.body)); return { ok: true }; };
  const a = saveConsent('accept', { storage, fetchImpl, apiBase: 'https://api.test' });
  const b = saveConsent('decline', { storage, fetchImpl, apiBase: 'https://api.test' });
  assert.notEqual(a.id, b.id);
  assert.equal(storedConsent(storage).choice, 'decline');
  assert.deepEqual(sent.map((s) => s.choice), ['accept', 'decline']);
});

test('the analytics client sends nothing until a yes, drops what waited on a no, and marks what it sends', async () => {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => { calls.push({ url: String(url), method: init.method }); return { ok: true, status: 200, headers: { get: () => null } }; };
  const nav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'test' }, configurable: true });
  const realInterval = globalThis.setInterval;
  globalThis.setInterval = () => 0;
  try {
    const a = await import('../../js/analytics.js');
    assert.equal(a.analyticsAllowed(), null);
    a.initSession({ device_type: 'desktop' });
    a.trackEvent('landing_view');
    assert.equal(calls.length, 0, 'held while the answer is not known');
    a.setAnalyticsAllowed(false);
    a.trackEvent('after_no');
    a.startRide({ level: 'meadow' });
    assert.equal(calls.length, 0, 'nothing after a no');
    a.setAnalyticsAllowed(true, CONSENT_VERSION);
    assert.equal(calls.length, 1, 'turned on in Settings: the session row goes now');
    assert.ok(calls[0].url.endsWith('/session?consent=' + CONSENT_VERSION), calls[0].url);
    a.startRide({ level: 'meadow' });
    assert.ok(calls[1].url.includes('/ride?consent='));
    a.setAnalyticsAllowed(false);
    a.startRide({ level: 'meadow' });
    assert.equal(calls.length, 2, 'and off again stops it at once');
  } finally {
    globalThis.fetch = realFetch;
    globalThis.setInterval = realInterval;
    if (nav) Object.defineProperty(globalThis, 'navigator', nav);
  }
});
