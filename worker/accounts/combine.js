// ============================================================
// ACCOUNTS · combine and separate (#783)
// ============================================================
//
// Every record carries two ids:
//   login_id  the sign-in it was recorded under. Never changes.
//   user_id   the account that login belongs to now. A copy, for queries.
//
// So combining account B into account A is: point B's logins at A, and set the
// user_id copy to A on B's rows. Separating a login again is the reverse, by
// login: its rows (whenever they were recorded) go with it. No snapshots.
//
// This module never names a game's table. Each game registers the tables that
// carry the two ids (registerAccountTables); the account system's own tables
// (users, user_logins, account_events) are handled here.

/**
 * @typedef {object} AccountTable
 * @property {string} table
 * @property {string} user    the account-id column (the copy)
 * @property {string} login   the login-id column (permanent)
 * @property {boolean} [text] the account id is stored as text (analytics sessions)
 */

/** @type {AccountTable[]} */
const TABLES = [];
const NAME = /^[a-z_][a-z0-9_]*$/;

/** A game says which of its tables carry (account, login). Safe to call again with the same list. */
export function registerAccountTables(list) {
  for (const t of list) {
    if (!t || !NAME.test(t.table) || !NAME.test(t.user) || !NAME.test(t.login)) throw new Error('bad account table');
    if (!TABLES.some((x) => x.table === t.table && x.user === t.user)) TABLES.push({ ...t });
  }
}

export function accountTables() {
  return TABLES.map((t) => ({ ...t }));
}

/** Run a statement; a table that isn't there yet (a migration not applied) is skipped. */
async function run(env, sql, ...args) {
  try {
    return await env.DB.prepare(sql).bind(...args).run();
  } catch (e) {
    if (/no such (table|column)/i.test(String(e && e.message))) return null;
    throw e;
  }
}
const marks = (ids) => ids.map(() => '?').join(',');

/** The login ids on an account, oldest first. */
export async function loginsOf(env, userId) {
  const rows = (await env.DB.prepare('SELECT login_id FROM user_logins WHERE user_id = ? ORDER BY login_id').bind(userId).all()).results || [];
  return rows.map((r) => r.login_id);
}

/**
 * Fold account `from` into account `to`. → what moved, for separating again:
 * { user: <from's users row>, logins: [login ids], events: [account_events ids] }
 */
export async function combineAccounts(env, from, to) {
  if (from == null || to == null || String(from) === String(to)) return null;
  const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(from).first();
  if (!user) return null;
  const logins = await loginsOf(env, from);
  const first = logins[0] ?? null;

  for (const t of TABLES) {
    const a = t.text ? String(from) : from;
    const b = t.text ? String(to) : to;
    // A row from before logins were recorded: it was this account's, so its first login's.
    if (first != null) await run(env, `UPDATE ${t.table} SET ${t.login} = ? WHERE ${t.user} = ? AND ${t.login} IS NULL`, first, a);
    await run(env, `UPDATE ${t.table} SET ${t.user} = ? WHERE ${t.user} = ?`, b, a);
  }
  let events = [];
  try {
    events = ((await env.DB.prepare('SELECT id FROM account_events WHERE user_id = ?').bind(from).all()).results || []).map((r) => r.id);
  } catch (e) { if (!/no such table/i.test(String(e && e.message))) throw e; }
  await run(env, 'UPDATE account_events SET user_id = ? WHERE user_id = ?', to, from);
  await run(env, 'UPDATE auth_requests SET link_user_id = ? WHERE link_user_id = ?', to, from);
  await env.DB.prepare('UPDATE user_logins SET user_id = ? WHERE user_id = ?').bind(to, from).run();
  await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(from).run();
  return { user, logins, events };
}

async function insertUser(env, row) {
  const cols = Object.keys(row).filter((c) => NAME.test(c));
  await env.DB.prepare(`INSERT INTO users (${cols.join(', ')}) VALUES (${marks(cols)})`).bind(...cols.map((c) => row[c])).run();
}

/** Give `logins` (and every row recorded under them) to account `userId`. */
async function moveLogins(env, logins, userId) {
  if (!logins.length) return;
  await env.DB.prepare(`UPDATE user_logins SET user_id = ? WHERE login_id IN (${marks(logins)})`).bind(userId, ...logins).run();
  for (const t of TABLES) {
    await run(env, `UPDATE ${t.table} SET ${t.user} = ? WHERE ${t.login} IN (${marks(logins)})`, t.text ? String(userId) : userId, ...logins);
  }
}

/**
 * Undo a combine: the folded-in account comes back with its number, name and picture,
 * and the logins that came with it (those still on `fromUserId`) return to it with
 * everything recorded under them. → { userId, logins } or null when nothing can move.
 */
export async function separateAccount(env, moved, fromUserId) {
  if (!moved || !moved.user || !Array.isArray(moved.logins)) return null;
  const ids = moved.logins.filter((n) => Number.isInteger(n));
  if (!ids.length) return null;
  const still = ((await env.DB.prepare(`SELECT login_id FROM user_logins WHERE user_id = ? AND login_id IN (${marks(ids)})`)
    .bind(fromUserId, ...ids).all()).results || []).map((r) => r.login_id);
  if (!still.length) return null;
  const taken = await env.DB.prepare('SELECT 1 AS x FROM users WHERE id = ?').bind(moved.user.id).first();
  if (taken) return null;
  await insertUser(env, moved.user);
  await moveLogins(env, still, moved.user.id);
  const events = (moved.events || []).filter((n) => Number.isInteger(n));
  if (events.length) await run(env, `UPDATE account_events SET user_id = ? WHERE id IN (${marks(events)})`, moved.user.id, ...events);
  return { userId: moved.user.id, logins: still };
}

/**
 * Take one login off its account into a new account of its own (undoing a link):
 * what was recorded under it goes with it. → the new account's id.
 */
export async function splitLogin(env, loginId, { name, avatar } = {}) {
  const login = await env.DB.prepare('SELECT * FROM user_logins WHERE login_id = ?').bind(loginId).first();
  if (!login) return null;
  const ins = await env.DB.prepare('INSERT INTO users (provider, provider_id, display_name, avatar_url) VALUES (?, ?, ?, ?)')
    .bind('account', crypto.randomUUID(), name || login.display_name || 'Player', avatar || login.avatar_url || null).run();
  const userId = ins.meta && ins.meta.last_row_id;
  await moveLogins(env, [loginId], userId);
  return userId;
}

/**
 * Move one login (a guest device that just signed in) into account `toUserId`, with what
 * was recorded under it. Its old account is removed when no login is left on it.
 */
export async function absorbLogin(env, loginId, toUserId) {
  const login = await env.DB.prepare('SELECT login_id, user_id FROM user_logins WHERE login_id = ?').bind(loginId).first();
  if (!login || login.user_id === toUserId) return;
  await moveLogins(env, [loginId], toUserId);
  const left = await env.DB.prepare('SELECT 1 AS x FROM user_logins WHERE user_id = ? LIMIT 1').bind(login.user_id).first();
  if (!left) {
    await run(env, 'UPDATE account_events SET user_id = ? WHERE user_id = ?', toUserId, login.user_id);
    await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(login.user_id).run();
  }
}
