// ============================================================
// ACCOUNTS · public player ids
// ============================================================
//
// What a board or a profile shows for a player is a public id (`pid`): 16 hex characters
// made from the account number with HMAC-SHA256, under a key made from JWT_SECRET and a
// fixed label. The same account always gets the same pid, and a pid says nothing about the
// account number or about any other account.
//
// users.public_id (migration 0024) keeps each account's pid so a profile can be found by
// it. It is filled the first time an account signs in or appears in a public answer.
// Everything here works before that migration too: pids are still made and shown, and a
// lookup by pid finds nobody.

const LABEL = 'house-tandem:public-player-id:v1';
const PID_RE = /^[0-9a-f]{16}$/;
const enc = new TextEncoder();
/** JWT_SECRET → the key public ids are made with (made once per secret). */
const keys = new Map();

const missing = (e) => /no such (table|column)/i.test(String(e && e.message));
const hmacKey = (bytes) => crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);

function pidKey(secret) {
  if (!keys.has(secret)) {
    keys.set(secret, hmacKey(enc.encode(secret))
      .then((k) => crypto.subtle.sign('HMAC', k, enc.encode(LABEL)))
      .then((derived) => hmacKey(derived)));
  }
  return keys.get(secret);
}

/** Is this text shaped like a public player id? */
export function isPublicPlayerId(v) {
  return typeof v === 'string' && PID_RE.test(v);
}

/** The public id of account `userId`, or null (no account, or no secret set). */
export async function publicPlayerId(env, userId) {
  if (userId == null || userId === '' || !env || !env.JWT_SECRET) return null;
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await pidKey(String(env.JWT_SECRET)), enc.encode(String(userId))));
  return Array.from(sig.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The public ids of these accounts, as a Map of account id → pid. Any that users.public_id
 * does not hold yet is stored. Storing is a convenience for lookups: a failure never fails
 * the answer.
 */
export async function publicPlayerIds(env, userIds) {
  const ids = [...new Set((userIds || []).filter((id) => id != null))];
  const out = new Map();
  for (const id of ids) out.set(id, await publicPlayerId(env, id));
  const pids = new Map(ids.map((id) => [String(id), out.get(id)]));
  try {
    for (let i = 0; i < ids.length; i += 90) {
      const part = ids.slice(i, i + 90);
      const rows = (await env.DB.prepare(`SELECT id, public_id FROM users WHERE id IN (${part.map(() => '?').join(',')})`)
        .bind(...part).all()).results || [];
      const stale = rows.filter((r) => pids.get(String(r.id)) && r.public_id !== pids.get(String(r.id)));
      if (stale.length) {
        await env.DB.batch(stale.map((r) => env.DB.prepare('UPDATE users SET public_id = ? WHERE id = ?').bind(pids.get(String(r.id)), r.id)));
      }
    }
  } catch (e) {
    if (!missing(e)) console.error('public ids not stored', (e && e.message) || e);
  }
  return out;
}

/** One account's public id, stored if it was not yet. */
export async function ensurePublicId(env, userId) {
  return (await publicPlayerIds(env, [userId])).get(userId) || null;
}

/** The account a public id names, or null (also before migration 0024, when none is stored). */
export async function userIdForPublicId(env, pid) {
  if (!isPublicPlayerId(pid)) return null;
  let rows;
  try {
    rows = (await env.DB.prepare('SELECT id FROM users WHERE public_id = ? LIMIT 5').bind(pid).all()).results || [];
  } catch (e) {
    if (missing(e)) return null;
    throw e;
  }
  // The stored value is only an index: the id is checked against the account it claims.
  for (const r of rows) if ((await publicPlayerId(env, r.id)) === pid) return r.id;
  return null;
}
