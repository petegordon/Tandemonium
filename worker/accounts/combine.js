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

// Each change here is one env.DB.batch (a transaction): every statement applies or none does.
// What is read to build it is read first.

const st = (env, sql, ...args) => env.DB.prepare(sql).bind(...args);
const marks = (ids) => ids.map(() => '?').join(',');
const extras = (extra, arg) => (typeof extra === 'function' ? extra(arg) : extra) || [];

/**
 * Is this table (with these columns) there? One that isn't yet (a migration not applied) is
 * left out of the batch, so it never fails the batch part-way. Any other error is thrown.
 */
async function present(env, table, ...cols) {
  try {
    await env.DB.prepare(`SELECT ${cols.length ? cols.join(', ') : '1'} FROM ${table} LIMIT 1`).first();
    return true;
  } catch (e) {
    if (/no such (table|column)/i.test(String(e && e.message))) return false;
    throw e;
  }
}

/** The registered tables that are there. */
async function presentTables(env) {
  const out = [];
  for (const t of TABLES) if (await present(env, t.table, t.user, t.login)) out.push(t);
  return out;
}

/** The login ids on an account, oldest first. */
export async function loginsOf(env, userId) {
  const rows = (await env.DB.prepare('SELECT login_id FROM user_logins WHERE user_id = ? ORDER BY login_id').bind(userId).all()).results || [];
  return rows.map((r) => r.login_id);
}

/**
 * Fold account `from` into account `to`, all or nothing. → what moved, for separating again:
 * { user: <from's users row>, logins: [login ids], events: [account_events ids] }
 * `extra`: more statements for the same batch (a list, or a function of what moved), so
 * what must be written with the combine is written with it or the combine does not happen.
 */
export async function combineAccounts(env, from, to, extra = null) {
  if (from == null || to == null || String(from) === String(to)) return null;
  const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(from).first();
  if (!user) return null;
  const logins = await loginsOf(env, from);
  const first = logins[0] ?? null;
  const hasEvents = await present(env, 'account_events', 'user_id');
  const events = hasEvents
    ? ((await env.DB.prepare('SELECT id FROM account_events WHERE user_id = ?').bind(from).all()).results || []).map((r) => r.id)
    : [];
  const moved = { user, logins, events };

  const stmts = [];
  for (const t of await presentTables(env)) {
    // (Analytics sessions keep the account number as text, some as "26.0".)
    const olds = t.text ? [String(from), from + '.0'] : [from];
    const b = t.text ? String(to) : to;
    for (const a of olds) {
      // A row from before logins were recorded: it was this account's, so its first login's.
      if (first != null) stmts.push(st(env, `UPDATE ${t.table} SET ${t.login} = ? WHERE ${t.user} = ? AND ${t.login} IS NULL`, first, a));
      stmts.push(st(env, `UPDATE ${t.table} SET ${t.user} = ? WHERE ${t.user} = ?`, b, a));
    }
  }
  if (hasEvents) stmts.push(st(env, 'UPDATE account_events SET user_id = ? WHERE user_id = ?', to, from));
  if (await present(env, 'auth_requests', 'link_user_id')) stmts.push(st(env, 'UPDATE auth_requests SET link_user_id = ? WHERE link_user_id = ?', to, from));
  stmts.push(st(env, 'UPDATE user_logins SET user_id = ? WHERE user_id = ?', to, from));
  stmts.push(st(env, 'DELETE FROM users WHERE id = ?', from));
  await env.DB.batch([...stmts, ...extras(extra, moved)]);
  return moved;
}

function insertUser(env, row) {
  const cols = Object.keys(row).filter((c) => NAME.test(c));
  return st(env, `INSERT INTO users (${cols.join(', ')}) VALUES (${marks(cols)})`, ...cols.map((c) => row[c]));
}

/**
 * The statements that give `logins` (and every row recorded under them) to an account.
 * `to`: { sql, args, text, textArgs } naming the account: a bound id, or a query for one made in
 * the same batch. `text` is the same account as text, for tables that keep it that way.
 */
async function moveLogins(env, logins, to) {
  if (!logins.length) return [];
  const stmts = [st(env, `UPDATE user_logins SET user_id = ${to.sql} WHERE login_id IN (${marks(logins)})`, ...to.args, ...logins)];
  for (const t of await presentTables(env)) {
    const [value, args] = t.text ? [to.text, to.textArgs] : [to.sql, to.args];
    stmts.push(st(env, `UPDATE ${t.table} SET ${t.user} = ${value} WHERE ${t.login} IN (${marks(logins)})`, ...args, ...logins));
  }
  return stmts;
}
const account = (userId) => ({ sql: '?', args: [userId], text: '?', textArgs: [String(userId)] });

/**
 * Undo a combine, all or nothing: the folded-in account comes back with its number, name and
 * picture, and the logins that came with it (those still on `fromUserId`) return to it with
 * everything recorded under them. → { userId, logins } or null when nothing can move.
 * `extra`: more statements for the same batch.
 */
export async function separateAccount(env, moved, fromUserId, extra = null) {
  if (!moved || !moved.user || !Array.isArray(moved.logins)) return null;
  const ids = moved.logins.filter((n) => Number.isInteger(n));
  if (!ids.length) return null;
  const still = ((await env.DB.prepare(`SELECT login_id FROM user_logins WHERE user_id = ? AND login_id IN (${marks(ids)})`)
    .bind(fromUserId, ...ids).all()).results || []).map((r) => r.login_id);
  if (!still.length) return null;
  const taken = await env.DB.prepare('SELECT 1 AS x FROM users WHERE id = ?').bind(moved.user.id).first();
  if (taken) return null;
  const stmts = [insertUser(env, moved.user), ...(await moveLogins(env, still, account(moved.user.id)))];
  const events = (moved.events || []).filter((n) => Number.isInteger(n));
  if (events.length && await present(env, 'account_events', 'user_id')) {
    stmts.push(st(env, `UPDATE account_events SET user_id = ? WHERE id IN (${marks(events)})`, moved.user.id, ...events));
  }
  const back = { userId: moved.user.id, logins: still };
  await env.DB.batch([...stmts, ...extras(extra, back)]);
  return back;
}

/**
 * Take one login off its account into a new account of its own (undoing a link), all or
 * nothing: what was recorded under it goes with it. → the new account's id.
 * `extra`: more statements for the same batch.
 */
export async function splitLogin(env, loginId, { name, avatar } = {}, extra = null) {
  const login = await env.DB.prepare('SELECT * FROM user_logins WHERE login_id = ?').bind(loginId).first();
  if (!login) return null;
  // The new account is found by its filler, so the rows can move to it in the batch that makes it.
  const filler = crypto.randomUUID();
  const find = "(SELECT id FROM users WHERE provider = 'account' AND provider_id = ?)";
  const made = { sql: find, args: [filler], text: `CAST(${find} AS TEXT)`, textArgs: [filler] };
  await env.DB.batch([
    st(env, 'INSERT INTO users (provider, provider_id, display_name, avatar_url) VALUES (?, ?, ?, ?)',
      'account', filler, name || login.display_name || 'Player', avatar || login.avatar_url || null),
    ...(await moveLogins(env, [loginId], made)),
    ...extras(extra, null),
  ]);
  const row = await env.DB.prepare("SELECT id FROM users WHERE provider = 'account' AND provider_id = ?").bind(filler).first();
  return row ? row.id : null;
}

/**
 * Move one login (a guest device that just signed in) into account `toUserId`, with what
 * was recorded under it, all or nothing. Its old account is removed when no login is left on it.
 */
export async function absorbLogin(env, loginId, toUserId) {
  const login = await env.DB.prepare('SELECT login_id, user_id FROM user_logins WHERE login_id = ?').bind(loginId).first();
  if (!login || login.user_id === toUserId) return;
  const stmts = await moveLogins(env, [loginId], account(toUserId));
  const empty = 'NOT EXISTS (SELECT 1 FROM user_logins WHERE user_id = ?)';
  if (await present(env, 'account_events', 'user_id')) {
    stmts.push(st(env, `UPDATE account_events SET user_id = ? WHERE user_id = ? AND ${empty}`, toUserId, login.user_id, login.user_id));
  }
  stmts.push(st(env, `DELETE FROM users WHERE id = ? AND ${empty}`, login.user_id, login.user_id));
  await env.DB.batch(stmts);
}
