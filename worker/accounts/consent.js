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
//                                 → { ok: true }
//
// Every answer is a row in `consents` (migration 0023). A yes is kept with when it was
// given, the country, the IP address it came from and, when the player is signed in, their
// account and name: that is the record that the player agreed. A no keeps only the choice,
// the time and the country. A later sign-in sends the same `id` again with its token, and
// the row gains the account.
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

/**
 * Record an answer. `text` is the request body (already size-limited by the caller).
 * deps: { jsonResponse, sessionFromToken(token, env) → { userId, loginId } | null }
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
  if (choice === 'accept' && typeof body.account_token === 'string' && env.JWT_SECRET) {
    const who = await deps.sessionFromToken(body.account_token, env);
    const n = parseInt((who && who.userId) ?? '', 10);
    if (n > 0) {
      userId = n;
      loginId = Number.isInteger(who.loginId) ? who.loginId : null;
      const row = await env.DB.prepare('SELECT display_name FROM users WHERE id = ?').bind(userId).first();
      username = row && typeof row.display_name === 'string' ? row.display_name.slice(0, 80) : null;
    }
  }
  const now = Math.floor(Date.now() / 1000);
  const country = requestCountry(request);
  const ip = choice === 'accept' && clientIP && clientIP !== 'unknown' ? clientIP : null;

  const prior = await env.DB.prepare('SELECT choice, policy_version, user_id FROM consents WHERE id = ?').bind(id).first();
  if (!prior) {
    await env.DB.prepare(
      `INSERT INTO consents (id, choice, policy_version, user_id, login_id, username, country, ip_address, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, choice, version, userId, loginId, username, country, ip, now, now).run();
    return deps.jsonResponse({ ok: true }, 200, corsOrigin);
  }
  // The same answer again, now signed in: the row gains the account. An answer is never
  // rewritten into a different one (a new choice is a new id), and never moved to another account.
  if (prior.choice !== choice || prior.policy_version !== version) return deps.jsonResponse({ error: 'Already recorded' }, 409, corsOrigin);
  if (userId && prior.user_id == null) {
    await env.DB.prepare('UPDATE consents SET user_id = ?, login_id = ?, username = ?, updated_at = ? WHERE id = ? AND user_id IS NULL')
      .bind(userId, loginId, username, now, id).run();
  }
  return deps.jsonResponse({ ok: true }, 200, corsOrigin);
}
