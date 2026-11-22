// Deleting an account leaves nothing that points back at it: every table registered as
// carrying an account or login is seeded, and so is every other column that names a user.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import worker from '../../worker/leaderboard.js';
import { accountTables } from '../../worker/accounts/combine.js';
import { signToken } from '../../worker/room-proof.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SECRET = 'delete-secret';
const ME = 77;
const OTHER = 78;

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(ROOT, 'worker/schema.sql'), 'utf8'));
  for (const m of fs.readdirSync(path.join(ROOT, 'worker/migrations')).sort()) {
    const text = fs.readFileSync(path.join(ROOT, 'worker/migrations', m), 'utf8').split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
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

let seq = 1000;
/** Insert a row with only the named values, inventing whatever else the table requires. */
function seed(db, table, values) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  const row = { ...values };
  for (const c of cols) {
    if (c.name in row || !c.notnull || c.dflt_value !== null) continue;
    if (c.pk && /INT/i.test(c.type) && cols.filter((x) => x.pk).length === 1) continue;
    row[c.name] = /INT|REAL|NUM/i.test(c.type) ? ++seq : `v${++seq}`;
  }
  const names = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`).run(...names.map((n) => row[n]));
}

function setup() {
  const db = freshDb();
  db.exec('PRAGMA foreign_keys = OFF;');
  seed(db, 'users', { id: ME });
  seed(db, 'users', { id: OTHER });
  seed(db, 'user_logins', { login_id: 501, user_id: ME, provider: 'discord', provider_id: 'me' });
  seed(db, 'user_logins', { login_id: 502, user_id: OTHER, provider: 'discord', provider_id: 'other' });
  return db;
}

const call = async (db, token) => worker.fetch(new Request('https://api.test/me/delete', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, 'CF-Connecting-IP': '1.2.3.4' },
  body: JSON.stringify({ confirm: 'DELETE' }),
}), { DB: d1(db), CORS_ORIGIN: '*', JWT_SECRET: SECRET }, { waitUntil() {} });

test('after a delete, no registered account table points at the account or its logins', async () => {
  const db = setup();
  const tables = accountTables();
  assert.ok(tables.length >= 12, 'the registry is populated');
  for (const t of tables) {
    const mine = t.text ? String(ME) : ME;
    seed(db, t.table, { [t.user]: mine, [t.login]: 501 });
    seed(db, t.table, { [t.user]: t.text ? String(OTHER) : OTHER, [t.login]: 502 });
  }
  const res = await call(db, await signToken({ sub: ME, lid: 501 }, SECRET, 3600));
  assert.equal(res.status, 200, await res.clone().text());

  for (const t of tables) {
    const n = (col, v) => db.prepare(`SELECT COUNT(*) n FROM ${t.table} WHERE ${col} = ?`).get(v).n;
    assert.equal(n(t.user, t.text ? String(ME) : ME), 0, `${t.table}.${t.user}`);
    assert.equal(n(t.login, 501), 0, `${t.table}.${t.login}`);
  }
  // Everyone else's rows are untouched where they aren't shared with this player.
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sessions WHERE google_uid = ?').get(String(OTHER)).n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM user_logins WHERE user_id = ?').get(OTHER).n, 1);
});

test('every column that names a user is empty of the account afterwards', async () => {
  const db = setup();
  const named = [];
  for (const { name: table } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()) {
    for (const c of db.prepare(`PRAGMA table_info(${table})`).all()) {
      if (table !== 'users' && /(^|_)user_id$|^user_(lo|hi)$/.test(c.name)) named.push([table, c.name]);
    }
  }
  assert.ok(named.length >= 14);
  for (const [table, col] of named) {
    if (table === 'user_logins') continue;
    seed(db, table, { [col]: ME });
  }
  const res = await call(db, await signToken({ sub: ME, lid: 501 }, SECRET, 3600));
  assert.equal(res.status, 200, await res.clone().text());
  for (const [table, col] of named) {
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE ${col} = ?`).get(ME).n, 0, `${table}.${col}`);
  }
});

test('analytics sessions lose the account, login, IP and device id, and stay as counts', async () => {
  const db = setup();
  const put = db.prepare('INSERT INTO sessions (id, started_at, google_uid, login_id, ip_address, device_id, user_agent, platform) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  put.run('s-plain', '2026-11-01', String(ME), 501, '1.1.1.1', 'device-aaaa', 'ua', 'steam');
  put.run('s-float', '2026-11-01', ME + '.0', null, '1.1.1.2', 'device-aaaa', 'ua', 'steam');
  put.run('s-login', '2026-11-01', null, 501, '1.1.1.3', 'device-bbbb', null, 'browser');
  put.run('s-other', '2026-11-01', String(OTHER), 502, '2.2.2.2', 'device-cccc', 'ua', 'browser');
  const res = await call(db, await signToken({ sub: ME, lid: 501 }, SECRET, 3600));
  assert.equal(res.status, 200, await res.clone().text());

  for (const id of ['s-plain', 's-float', 's-login']) {
    const r = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
    assert.equal(r.google_uid, null, id);
    assert.equal(r.login_id, null, id);
    assert.equal(r.ip_address, null, id);
    assert.equal(r.device_id, null, id);
  }
  assert.equal(db.prepare('SELECT platform FROM sessions WHERE id = ?').get('s-plain').platform, 'steam', 'the anonymous count stays');
  const other = db.prepare("SELECT * FROM sessions WHERE id = 's-other'").get();
  assert.equal(other.google_uid, String(OTHER));
  assert.equal(other.ip_address, '2.2.2.2');
  assert.equal(other.device_id, 'device-cccc');
});

test('an open tab writing after the delete cannot put the details back', async () => {
  const db = setup();
  const SID = '11111111-2222-4333-8444-555555555555';
  db.prepare('INSERT INTO sessions (id, started_at, google_uid, login_id, ip_address, device_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run(SID, '2026-11-01', String(ME), 501, '1.1.1.1', 'device-aaaa');
  const token = await signToken({ sub: ME, lid: 501 }, SECRET, 3600);
  assert.equal((await call(db, token)).status, 200);
  db.exec('PRAGMA foreign_keys = ON;');

  const env = { DB: d1(db), CORS_ORIGIN: '*', JWT_SECRET: SECRET };
  const send = (p, body, method) => worker.fetch(new Request('https://api.test' + p, {
    method, headers: { 'Content-Type': 'text/plain', 'CF-Connecting-IP': '9.9.9.9' }, body: JSON.stringify(body),
  }), env, { waitUntil() {} });
  await send(`/api/analytics/session/${SID}`, { ended_at: '2026-11-02', account_token: token }, 'PUT');
  await send('/api/analytics/session', { id: SID, device_id: 'device-aaaa', user_agent: 'ua', account_token: token }, 'POST');
  const r = db.prepare('SELECT * FROM sessions WHERE id = ?').get(SID);
  assert.equal(r.google_uid, null);
  assert.equal(r.login_id, null);
  assert.equal(r.ip_address, null);
  assert.equal(r.device_id, null);
});

test("another account's notice stops naming a deleted account", async () => {
  const db = setup();
  seed(db, 'account_events', { user_id: OTHER, kind: 'combine', from_user_id: ME, from_name: 'Me', moved_json: '{"logins":[501]}', created_at: 1, undo_until: 2 });
  const res = await call(db, await signToken({ sub: ME, lid: 501 }, SECRET, 3600));
  assert.equal(res.status, 200, await res.clone().text());
  const e = db.prepare('SELECT * FROM account_events WHERE user_id = ?').get(OTHER);
  assert.equal(e.from_user_id, null);
  assert.equal(e.from_name, null);
  assert.equal(e.moved_json, null);
});
