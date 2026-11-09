// Dashboard "Exclude developer": sessions store the signed-in account's number
// (as text, often "38.0"), never an email, so the email list matched nothing;
// and NOT IN against an empty ip/account dropped every signed-out session.
// Pete 2026-11-09: sessions went 74 → 33 with his own rides still in.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import worker, { parseDevExclusions, ipForExclusion } from '../../worker/leaderboard.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SECRET = 'test-secret';

function freshDb() {
  const db = new DatabaseSync(':memory:');
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
    run: async () => { db.prepare(sql).run(...args); return { success: true }; },
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
  });
  return { prepare: (sql) => ({ bind: (...args) => bound(sql, args), ...bound(sql, []) }) };
}

const b64url = (s) => Buffer.from(s).toString('base64url');
async function token(payload) {
  const data = `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + 600 }))}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))).toString('base64url');
  return `${data}.${sig}`;
}

function seeded() {
  const db = freshDb();
  const now = new Date().toISOString();
  const add = (id, uid, ip) => db.prepare(
    'INSERT INTO sessions (id, started_at, google_uid, ip_address, platform) VALUES (?, ?, ?, ?, ?)'
  ).run(id, now, uid, ip, 'browser');
  // Pete: Google account 1, Discord account 38 (+ a linked Steam sign-in), home IPv6 that rotates.
  add('pete-google', '1.0', '9.9.9.9');
  add('pete-discord', '38.0', '8.8.8.8');
  add('pete-signed-out-v6', null, '2603:6013:1400:66:aaaa:bbbb:cccc:dddd');
  // Players: signed out (no account), one with no IP at all, one signed in.
  add('player-a', null, '1.1.1.1');
  add('player-b', null, null);
  add('player-c', '12.0', '2.2.2.2');
  db.prepare("INSERT INTO users (id, provider, provider_id, display_name) VALUES (38, 'discord', 'd-pete', 'petegordon')").run();
  db.prepare("INSERT INTO user_identities (user_id, provider, provider_id) VALUES (38, 'discord', 'd-pete'), (38, 'steam', '7656-pete')").run();
  return db;
}

async function dash(db, route, query) {
  const auth = await token({ sub: 1, email: 'pete@petegordon.com' });
  const res = await worker.fetch(new Request(`https://api.test/api/analytics/dashboard/${route}?days=30&${query}`, {
    headers: { Authorization: 'Bearer ' + auth, 'CF-Connecting-IP': '2603:6013:1400:66::1' },
  }), { DB: d1(db), CORS_ORIGIN: '*', JWT_SECRET: SECRET }, { waitUntil() {} });
  assert.equal(res.status, 200, await res.clone().text());
  return res.json();
}

test('no exclusion counts every session', async () => {
  const o = await dash(seeded(), 'overview', '');
  assert.equal(o.sessions.total, 6);
});

test('excluding accounts keeps signed-out players (the 74 → 33 bug)', async () => {
  const o = await dash(seeded(), 'overview', 'exclude_accounts=1,38');
  assert.equal(o.sessions.total, 4, 'pete-signed-out-v6 + the three players');
});

test('a Steam sign-in id excludes its whole account', async () => {
  const o = await dash(seeded(), 'overview', 'exclude_accounts=steam:7656-pete');
  assert.equal(o.sessions.total, 5, 'account 38 out, everything else in');
});

test('an IPv6 /64 prefix catches a rotated address; the old email list matches nothing', async () => {
  const o = await dash(seeded(), 'overview', 'exclude_ips=2603:6013:1400:66:*&exclude_uids=pete@petegordon.com');
  assert.equal(o.sessions.total, 5);
  const all = await dash(seeded(), 'overview', 'exclude_ips=2603:6013:1400:66:*,9.9.9.9&exclude_accounts=38');
  assert.equal(all.sessions.total, 3, 'only the players remain');
});

test('auto-detect returns this browser /64 and the excluded accounts\' recent IPs', async () => {
  const r = await dash(seeded(), 'dev_ips', 'exclude_accounts=38');
  const ips = r.ips.map((x) => x.ip);
  assert.deepEqual(ips.sort(), ['2603:6013:1400:66:*', '8.8.8.8', '9.9.9.9'].sort(), 'viewer (account 1) included');
  assert.equal(r.viewer_account, 1);
});

test('parse + IPv6 helpers', () => {
  const ex = parseDevExclusions(new URL('https://x/?exclude_ips=1.2.3.4,2603:1:2:3:*,*&exclude_accounts=38,26.0,0,steam:76,bogus'));
  assert.deepEqual(ex.ips, ['1.2.3.4']);
  assert.deepEqual(ex.prefixes, ['2603:1:2:3:']);
  assert.deepEqual(ex.accounts, [38, 26]);
  assert.deepEqual(ex.identities, [{ provider: 'steam', providerId: '76' }]);
  assert.equal(ipForExclusion('2603:6013:1400:66:a9f6:53dd:7b0c:a4a9'), '2603:6013:1400:66:*');
  assert.equal(ipForExclusion('2603:6013::1'), '2603:6013:0:0:*');
  assert.equal(ipForExclusion('174.101.210.132'), '174.101.210.132');
  assert.equal(ipForExclusion('unknown'), null);
});

test('every dashboard panel runs with exclusions on', async () => {
  for (const route of ['daily', 'funnel', 'rides', 'crashes', 'conversions', 'network', 'devices', 'dda', 'overview', 'retention', 'dropoff', 'pairs']) {
    await dash(seeded(), route, 'exclude_ips=9.9.9.9,2603:6013:1400:66:*&exclude_accounts=1,steam:7656-pete');
  }
});
