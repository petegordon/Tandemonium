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
  const stmt = (sql, args) => ({ _sql: sql, _args: args, ...bound(sql, args) });
  return {
    prepare: (sql) => ({ bind: (...args) => stmt(sql, args), ...stmt(sql, []) }),
    batch: async (list) => { for (const x of list) db.prepare(x._sql).run(...x._args); return list.map(() => ({ success: true })); },
  };
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
  for (const route of ['daily', 'funnel', 'rides', 'crashes', 'conversions', 'network', 'devices', 'dda', 'overview', 'retention', 'dropoff', 'pairs', 'players']) {
    await dash(seeded(), route, 'exclude_ips=9.9.9.9,2603:6013:1400:66:*&exclude_accounts=1,steam:7656-pete');
  }
});

// ── Signed in after launch: the session row picks the account up ──
async function putSession(db, id, body) {
  const res = await worker.fetch(new Request(`https://api.test/api/analytics/session/${id}`, {
    method: 'PUT', headers: { 'Content-Type': 'text/plain', 'CF-Connecting-IP': '3.3.3.3' }, body: JSON.stringify(body),
  }), { DB: d1(db), CORS_ORIGIN: '*', JWT_SECRET: SECRET }, { waitUntil() {} });
  assert.equal(res.status, 200);
}
const SID2 = '22222222-3333-4444-8555-666666666666';

test('a sign-in after launch attaches the account to the guest session, once', async () => {
  const db = seeded();
  db.prepare('INSERT INTO sessions (id, started_at, platform) VALUES (?, ?, ?)').run(SID2, new Date().toISOString(), 'steam');
  await putSession(db, SID2, { account_token: 'not-a-token' });
  assert.equal(db.prepare('SELECT google_uid FROM sessions WHERE id = ?').get(SID2).google_uid, null, 'a bad token attaches nothing');
  await putSession(db, SID2, { account_token: await token({ sub: 42 }) });
  assert.equal(db.prepare('SELECT google_uid FROM sessions WHERE id = ?').get(SID2).google_uid, '42');
  await putSession(db, SID2, { ended_at: 'x', account_token: await token({ sub: 7 }) });
  assert.equal(db.prepare('SELECT google_uid FROM sessions WHERE id = ?').get(SID2).google_uid, '42', 'never moves to another account');
});

test('players: signed-in accounts by sign-in name, guests only if they rode, developer excluded', async () => {
  const db = seeded();
  const now = Date.now();
  const iso = (m) => new Date(now + m * 60000).toISOString();
  db.prepare("INSERT INTO users (id, provider, provider_id, display_name) VALUES (28, 'steam', 's-wolf', 'wolfg4m3r')").run();
  db.prepare("INSERT INTO user_identities (user_id, provider, provider_id, display_name) VALUES (28, 'steam', 's-wolf', 'wolfg4m3r')").run();
  db.prepare('UPDATE sessions SET started_at = ? ').run(iso(-60));
  db.prepare("INSERT INTO sessions (id, started_at, google_uid, platform) VALUES ('wolf-1', ?, '28.0', 'steam')").run(iso(-50));
  db.prepare(`INSERT INTO rides (id, session_id, level, input_method, started_at, ended_at, completed)
              VALUES ('r1', 'wolf-1', 'grandma', 'gamepad_stick', ?, ?, 1), ('r2', 'player-a', 'tutorial', 'keyboard', ?, ?, 0)`)
    .run(iso(-49), iso(-30), iso(-59), iso(-58));
  const r = await dash(db, 'players', 'exclude_accounts=1,38');
  const wolf = r.players.find((p) => p.acct === 28);
  assert.deepEqual(wolf.sign_ins, [{ provider: 'steam', name: 'wolfg4m3r' }]);
  assert.equal(wolf.minutes, 20);
  assert.equal(wolf.finished, 1);
  const guests = r.players.filter((p) => p.guest);
  assert.equal(guests.length, 1, 'player-a rode; player-b never did');
  assert.ok(!r.players.some((p) => p.acct === 1 || p.acct === 38), 'developer excluded');
  assert.ok(r.players.some((p) => p.acct === 12), 'a signed-in player who never rode still shows');
});

test('the sign-in update can beat the create: the row is made, and the create keeps the account', async () => {
  const db = seeded();
  const SID3 = '33333333-4444-4555-8666-777777777777';
  await putSession(db, SID3, { account_token: await token({ sub: 28 }) });
  assert.equal(db.prepare('SELECT google_uid FROM sessions WHERE id = ?').get(SID3).google_uid, '28');
  const res = await worker.fetch(new Request('https://api.test/api/analytics/session', {
    method: 'POST', headers: { 'Content-Type': 'text/plain', 'CF-Connecting-IP': '3.3.3.3' },
    body: JSON.stringify({ id: SID3, started_at: '2026-10-17T21:26:51.000Z', platform: 'steam', google_uid: null }),
  }), { DB: d1(db), CORS_ORIGIN: '*', JWT_SECRET: SECRET }, { waitUntil() {} });
  assert.equal(res.status, 200);
  const row = db.prepare('SELECT google_uid, platform, started_at FROM sessions WHERE id = ?').get(SID3);
  assert.deepEqual({ ...row }, { google_uid: '28', platform: 'steam', started_at: '2026-10-17T21:26:51.000Z' });
});

test('merging accounts moves the analytics sessions too', async () => {
  const { mergeAccounts } = await import('../../worker/identity.js');
  const db = seeded();
  db.prepare("INSERT INTO users (id, provider, provider_id, display_name) VALUES (26, 'steam', 's-old', 'pete')").run();
  db.prepare("INSERT INTO sessions (id, started_at, google_uid) VALUES ('old-steam', ?, '26.0')").run(new Date().toISOString());
  await mergeAccounts({ DB: d1(db) }, 26, 38);
  assert.equal(db.prepare("SELECT google_uid FROM sessions WHERE id = 'old-steam'").get().google_uid, '38');
});

// ── Couch seats 2–4 (migration 0016) ──
async function postRide(db, body) {
  const res = await worker.fetch(new Request('https://api.test/api/analytics/ride', {
    method: 'POST', headers: { 'Content-Type': 'text/plain', 'CF-Connecting-IP': '3.3.3.3' }, body: JSON.stringify(body),
  }), { DB: d1(db), CORS_ORIGIN: '*', JWT_SECRET: SECRET }, { waitUntil() {} });
  assert.equal(res.status, 200);
}
const RIDE = '66666666-7777-4888-8999-aaaaaaaaaaaa';

test('a ride records every seat; accounts only from each seat\'s own token', async () => {
  const db = seeded();
  db.prepare("INSERT INTO sessions (id, started_at) VALUES (?, ?)").run(SID2, new Date().toISOString());
  await postRide(db, {
    id: RIDE, session_id: SID2, level: 'grandma', role: 'versus', input_method: 'gamepad_stick', started_at: new Date().toISOString(),
    seats: [
      { seat: 1, role: 'versus', team: 'A', input_type: 'gamepad', controller: 'DualSense', account_token: await token({ sub: 38 }) },
      { seat: 2, role: 'versus', team: 'A', input_type: 'gamepad', controller: 'Xbox', account_token: await token({ sub: 12 }) },
      { seat: 3, role: 'versus', team: 'B', input_type: 'phone', account_token: 'forged' },
      { seat: 4, role: 'versus', team: 'B', input_type: 'bot' },
      { seat: 9, role: 'versus' },
    ],
  });
  const rows = db.prepare('SELECT seat, user_id, team, input_type, controller FROM ride_seats WHERE ride_id = ? ORDER BY seat').all(RIDE).map((r) => ({ ...r }));
  assert.deepEqual(rows, [
    { seat: 1, user_id: 38, team: 'A', input_type: 'gamepad', controller: 'DualSense' },
    { seat: 2, user_id: 12, team: 'A', input_type: 'gamepad', controller: 'Xbox' },
    { seat: 3, user_id: null, team: 'B', input_type: 'phone', controller: null },
    { seat: 4, user_id: null, team: 'B', input_type: 'bot', controller: null },
  ]);
});

test('players: couch seat time counts for the seat\'s account, even on the developer\'s machine', async () => {
  const db = seeded();
  db.prepare("INSERT INTO users (id, provider, provider_id, display_name) VALUES (50, 'discord', 'd-sam', 'sam')").run();
  db.prepare("INSERT INTO user_identities (user_id, provider, provider_id, display_name) VALUES (50, 'discord', 'd-sam', 'sam')").run();
  const start = new Date(Date.now() - 30 * 60000).toISOString();
  // Pete's session (account 1), Sam rides as Player 2 for 12 minutes and finishes.
  db.prepare(`INSERT INTO rides (id, session_id, level, input_method, started_at, ended_at, completed, duration_ms)
              VALUES (?, 'pete-google', 'grandma', 'gamepad_stick', ?, ?, 1, 720000)`).run(RIDE, start, new Date().toISOString());
  db.prepare("INSERT INTO ride_seats (ride_id, seat, user_id, role, controller) VALUES (?, 1, 1, 'captain', 'DualSense'), (?, 2, 50, 'stoker', 'Xbox')").run(RIDE, RIDE);
  const r = await dash(db, 'players', 'exclude_accounts=1,38');
  const sam = r.players.find((p) => p.acct === 50);
  assert.ok(sam, 'a couch-only player is listed');
  assert.equal(sam.seat_rides, 1);
  assert.equal(sam.minutes, 12);
  assert.equal(sam.finished, 1);
  assert.deepEqual(sam.sign_ins, [{ provider: 'discord', name: 'sam' }]);
  assert.ok(!r.players.some((p) => p.acct === 1), 'Pete still excluded');
});

test('merging accounts moves couch seats too', async () => {
  const { mergeAccounts } = await import('../../worker/identity.js');
  const db = seeded();
  db.prepare("INSERT INTO users (id, provider, provider_id, display_name) VALUES (51, 'steam', 's-x', 'x')").run();
  db.prepare("INSERT INTO rides (id, session_id, level, input_method, started_at) VALUES (?, 'player-a', 'grandma', 'k', ?)").run(RIDE, new Date().toISOString());
  db.prepare("INSERT INTO ride_seats (ride_id, seat, user_id) VALUES (?, 2, 51)").run(RIDE);
  await mergeAccounts({ DB: d1(db) }, 51, 38);
  assert.equal(db.prepare('SELECT user_id FROM ride_seats WHERE ride_id = ?').get(RIDE).user_id, 38);
});
