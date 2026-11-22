// ============================================================
// ANALYTICS CONSENT — asked in the EEA, the UK and Switzerland
// ============================================================
//
// What needs a yes: gameplay analytics (sessions, events, the device id and IP stored with
// them). What does not: the account and the play that belongs to it (sign-in, rides,
// achievements, rooms), which the game cannot work without.
//
//   GET  /consent/region          → { required, country, version }
//   POST /consent  (text/plain JSON) { id, choice: 'accept'|'decline', version, account_token? }
//                                 → { ok: true, consent }
//   GET  /me/consent              → { consent, required, version }   (signed in)
//
// The answer belongs to the House Tandem account and is kept in one place, the `consents`
// table here (migration 0023): every House Tandem game and device reads it, so a signed-in
// player is asked once. A yes is kept with when it was given, the country, the IP address it
// came from, and the account and its name: that is the record that the player agreed. A no
// keeps the choice, the time, the country and the account. A player who is not signed in is
// asked on their device, and the answer joins the account when they sign in.
//
// Analytics writes from these countries are dropped unless they carry `?consent=<version>`,
// which the game adds only after a yes (see consentMissing; leaderboard.js calls it before
// any analytics write is read).

/** The wording's version: a new one asks everyone again. */
export const CONSENT_VERSION = '2026-11-22';

// EU member states, the rest of the EEA (Iceland, Liechtenstein, Norway), the UK, Switzerland.
const CONSENT_COUNTRIES = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU',
  'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
  'IS', 'LI', 'NO', 'GB', 'CH',
]);

/** The two-letter country Cloudflare saw the request come from, or null. */
export function requestCountry(request) {
  const c = (request && request.cf && request.cf.country) || (request && request.headers && request.headers.get('CF-IPCountry')) || '';
  return /^[A-Z]{2}$/.test(c) ? c : null;
}

/** Does a player in this country have to be asked first? */
export function consentRequired(country) {
  return !!country && CONSENT_COUNTRIES.has(country);
}

/** An analytics write from a country that must be asked, without the mark of a yes. */
export function consentMissing(request, url) {
  if (!consentRequired(requestCountry(request))) return false;
  return !/^[\w.-]{1,32}$/.test(url.searchParams.get('consent') || '');
}

export function handleConsentRegion(request, corsOrigin, deps) {
  const country = requestCountry(request);
  return deps.jsonResponse({ required: consentRequired(country), country, version: CONSENT_VERSION }, 200, corsOrigin);
}

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The table's place in combine and separate: an answer follows the login it was given under. */
export const CONSENT_ACCOUNT_TABLES = Object.freeze([{ table: 'consents', user: 'user_id', login: 'login_id' }]);

/** An account's answer, for every House Tandem game: { choice, version, at } or null. The latest row is the answer. */
export async function accountConsent(env, userId) {
  const row = await env.DB.prepare('SELECT choice, policy_version, updated_at FROM consents WHERE user_id = ? ORDER BY updated_at DESC, created_at DESC LIMIT 1')
    .bind(userId).first();
  return row ? { choice: row.choice, version: row.policy_version, at: row.updated_at } : null;
}

/** GET /me/consent → { consent, required, version }: the account's answer, and whether this player is asked. */
export async function handleAccountConsent(request, env, corsOrigin, userId, deps) {
  let consent = null;
  try { consent = await accountConsent(env, userId); } catch (e) { if (!/no such table/i.test(String(e && e.message))) throw e; }
  return deps.jsonResponse({ consent, required: consentRequired(requestCountry(request)), version: CONSENT_VERSION }, 200, corsOrigin);
}

/**
 * Record an answer. `text` is the request body (already size-limited by the caller).
 * deps: { jsonResponse, sessionFromToken(token, env) → { userId, loginId } | null }
 *
 * Signed in, the answer is the ACCOUNT's: it is kept once, here, and every House Tandem game
 * and device reads it (GET /me/consent), so the player is asked once. A new answer from the
 * account replaces its earlier one. An answer given before signing in (a row with no account)
 * joins the account at sign-in, unless the account already has an answer: then the account's
 * stands and the other row is removed. → { ok, consent } where `consent` is the account's
 * answer now (null when signed out).
 */
export async function handleConsentRecord(request, env, corsOrigin, text, clientIP, deps) {
  let body = null;
  try { body = JSON.parse(text); } catch { /* answered below */ }
  if (!body || typeof body !== 'object') return deps.jsonResponse({ error: 'Invalid body' }, 400, corsOrigin);
  const id = typeof body.id === 'string' && ID_RE.test(body.id) ? body.id.toLowerCase() : null;
  const choice = body.choice === 'accept' || body.choice === 'decline' ? body.choice : null;
  const version = typeof body.version === 'string' && /^[\w.-]{1,32}$/.test(body.version) ? body.version : null;
  if (!id || !choice || !version) return deps.jsonResponse({ error: 'Invalid consent' }, 400, corsOrigin);

  let userId = null;
  let loginId = null;
  let username = null;
  if (typeof body.account_token === 'string' && env.JWT_SECRET) {
    const who = await deps.sessionFromToken(body.account_token, env);
    const n = parseInt((who && who.userId) ?? '', 10);
    if (n > 0) {
      userId = n;
      loginId = Number.isInteger(who.loginId) ? who.loginId : null;
      // A yes is kept with the name it was given under. A no keeps the account only (so it holds everywhere).
      if (choice === 'accept') {
        const row = await env.DB.prepare('SELECT display_name FROM users WHERE id = ?').bind(userId).first();
        username = row && typeof row.display_name === 'string' ? row.display_name.slice(0, 80) : null;
      }
    }
  }
  const now = Math.floor(Date.now() / 1000);
  const country = requestCountry(request);
  const ip = choice === 'accept' && clientIP && clientIP !== 'unknown' ? clientIP : null;
  const q = (sql, ...args) => env.DB.prepare(sql).bind(...args);
  const answer = async () => deps.jsonResponse({ ok: true, consent: userId ? await accountConsent(env, userId) : null }, 200, corsOrigin);

  const prior = await q('SELECT choice, policy_version, user_id FROM consents WHERE id = ?', id).first();
  if (!prior) {
    // A new answer. From an account, it takes the place of the account's earlier one.
    await env.DB.batch([
      ...(userId ? [q('DELETE FROM consents WHERE user_id = ?', userId)] : []),
      q(`INSERT INTO consents (id, choice, policy_version, user_id, login_id, username, country, ip_address, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, choice, version, userId, loginId, username, country, ip, now, now),
    ]);
    return answer();
  }
  // The same answer again. An answer is never rewritten into a different one (a new choice is a new id).
  if (prior.choice !== choice || prior.policy_version !== version) return deps.jsonResponse({ error: 'Already recorded' }, 409, corsOrigin);
  if (userId && prior.user_id == null) {
    const has = await q('SELECT 1 AS x FROM consents WHERE user_id = ? LIMIT 1', userId).first();
    // Given before signing in. The account already has its answer: that one stands.
    if (has) await q('DELETE FROM consents WHERE id = ? AND user_id IS NULL', id).run();
    else await q('UPDATE consents SET user_id = ?, login_id = ?, username = ?, updated_at = ? WHERE id = ? AND user_id IS NULL', userId, loginId, username, now, id).run();
  }
  return answer();
}
