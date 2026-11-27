// ============================================================
// VERIFIED DELETE — housetandem.com/account-delete
// ============================================================
//
// Anyone can type someone else's Steam ID into an email, so a delete is never done on what
// someone says. It is done on what Steam and Discord confirm:
//
//   1. The delete page starts a delete (POST /erase/start) and keeps its secret.
//   2. The player signs in with Steam or Discord, only to prove the account is theirs
//      (POST /erase/signin → Steam's or Discord's own page). Nothing is made or linked.
//   3. The page attaches that confirmation (POST /erase/attach) and shows what we hold:
//      the House Tandem account that sign-in belongs to, and the game sessions recorded
//      with that Steam ID (with or without an account).
//   4. When the account has both a Steam and a Discord sign-in, BOTH must be confirmed
//      (every Steam and Discord sign-in on it). Until then nothing can be deleted.
//   5. The player confirms (typed DELETE + "I understand") and everything goes at once
//      (POST /erase/confirm). The scope is worked out again at that moment.
//
// A delete lasts FLOW_TTL_S. Its row lives in auth_requests (provider 'erase'); each sign-in
// is its own auth_requests row (mode 'erase', worker/accounts/identity.js).

import { beginEraseSignIn, takeEraseSignIn, accountSummary, loginRow } from './identity.js';

export const FLOW_TTL_S = 900;
const MAX_CONFIRMED = 4;
const PROVIDERS = new Set(['steam', 'discord']);
// The sign-ins a delete must confirm. Google is a retired sign-in with no web button.
const MUST_CONFIRM = ['steam', 'discord'];

const nowS = () => Math.floor(Date.now() / 1000);
function b64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
const randomId = (n) => b64url(crypto.getRandomValues(new Uint8Array(n)));
async function sha256(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return b64url(new Uint8Array(d));
}
async function readJson(request) {
  try { return (await request.json()) || {}; } catch { return {}; }
}
const noColumn = (e) => /no such (column|table)/i.test(String(e && e.message));

/** The live delete for { id, secret }, with its confirmed sign-ins, or null. */
async function liveFlow(env, body) {
  if (typeof body.id !== 'string' || typeof body.secret !== 'string' || body.secret.length > 128) return null;
  const row = await env.DB.prepare("SELECT * FROM auth_requests WHERE id = ? AND provider = 'erase'").bind(body.id).first();
  if (!row || row.created_at < nowS() - FLOW_TTL_S) return null;
  if ((await sha256(body.secret)) !== row.secret_hash) return null;
  let held = {};
  try { held = JSON.parse(row.profile_json || '{}') || {}; } catch {}
  return { row, confirmed: Array.isArray(held.confirmed) ? held.confirmed : [] };
}

/** A delete's sign-ins that are still waiting (begun, or confirmed and not attached). */
function dropSignIns(env, flowId) {
  return env.DB.prepare("DELETE FROM auth_requests WHERE mode = 'erase' AND provider != 'erase' AND json_extract(profile_json, '$.flow') = ?")
    .bind(flowId).run();
}

const GONE = 'This delete has expired or was started in another browser. Start again: nothing was deleted.';
const gone = (deps, corsOrigin) => deps.jsonResponse({ error: GONE, code: 'erase_gone' }, 410, corsOrigin);

/**
 * Everything a set of confirmed sign-ins reaches, and what still needs confirming.
 *   accounts   House Tandem accounts the confirmed sign-ins belong to, each with the
 *              Steam and Discord sign-ins on it (confirmed or not)
 *   steamIds   confirmed Steam IDs (their game sessions go, with or without an account)
 *   devices    devices only these Steam IDs played on: their guest records go too
 *   needed     sign-ins on those accounts not confirmed yet
 */
export async function eraseScope(env, confirmed, deps = {}) {
  const have = new Set(confirmed.map((c) => `${c.provider}:${c.providerId}`));
  const accounts = new Map();
  for (const c of confirmed) {
    const row = await loginRow(env, c.provider, c.providerId);
    if (!row || accounts.has(row.user_id)) continue;
    const logins = (await env.DB.prepare(
      `SELECT provider, provider_id, display_name, avatar_url FROM user_logins
       WHERE user_id = ? AND provider IN (${MUST_CONFIRM.map(() => '?').join(', ')}) ORDER BY login_id`
    ).bind(row.user_id, ...MUST_CONFIRM).all()).results || [];
    accounts.set(row.user_id, logins.map((l) => ({
      provider: l.provider, name: l.display_name, avatar: l.avatar_url,
      confirmed: have.has(`${l.provider}:${l.provider_id}`),
    })));
  }
  const steamIds = [...new Set(confirmed.filter((c) => c.provider === 'steam').map((c) => c.providerId))];
  let sessions = 0;
  const devices = [];
  if (steamIds.length) {
    const marks = steamIds.map(() => '?').join(', ');
    try {
      sessions = ((await env.DB.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE steam_id IN (${marks})`)
        .bind(...steamIds).first()) || {}).n || 0;
      // A device counts as theirs only when no other Steam account ever played on it
      // (a family computer keeps everyone else's records).
      const rows = (await env.DB.prepare(
        `SELECT DISTINCT device_id FROM sessions WHERE steam_id IN (${marks}) AND device_id IS NOT NULL`
      ).bind(...steamIds).all()).results || [];
      for (const r of rows) {
        const other = await env.DB.prepare(
          `SELECT 1 AS x FROM sessions WHERE device_id = ? AND steam_id IS NOT NULL AND steam_id NOT IN (${marks}) LIMIT 1`
        ).bind(r.device_id, ...steamIds).first();
        if (!other) devices.push(r.device_id);
      }
    } catch (e) { if (!noColumn(e)) throw e; }   // migration 0025 not applied yet
  }
  // A guest device's own small account (provider 'device'): only one that never signed in.
  const guestAccounts = [];
  for (const d of devices) {
    const keys = deps.deviceKeys ? await deps.deviceKeys(env, d) : [d];
    for (const k of keys) {
      const row = await loginRow(env, 'device', k);
      if (!row || accounts.has(row.user_id) || guestAccounts.includes(row.user_id)) continue;
      const real = await env.DB.prepare("SELECT 1 AS x FROM user_logins WHERE user_id = ? AND provider != 'device' LIMIT 1")
        .bind(row.user_id).first();
      if (!real) guestAccounts.push(row.user_id);
    }
  }
  const needed = [];
  for (const logins of accounts.values()) for (const l of logins) if (!l.confirmed) needed.push(l);
  return { accounts, steamIds, sessions, devices, guestAccounts, needed };
}

/** What the page shows: no provider ids, only names and pictures. */
async function statusBody(env, flow, scope) {
  const accounts = [];
  for (const [userId, logins] of scope.accounts) {
    const s = await accountSummary(env, userId);
    if (!s) continue;
    accounts.push({
      name: s.name, avatar: s.avatar, rides: s.rides, badges: s.badges,
      games: s.games.map((g) => ({ title: g.title, badges: g.badges })),
      logins: logins.map(({ provider, name, avatar, confirmed }) => ({ provider, name, avatar, confirmed })),
    });
  }
  const nothing = !accounts.length && !scope.sessions && !scope.guestAccounts.length;
  return {
    expires_in: Math.max(0, flow.row.created_at + FLOW_TTL_S - nowS()),
    confirmed: flow.confirmed.map(({ provider, name, avatar }) => ({ provider, name, avatar })),
    accounts,
    sessions: scope.sessions,
    guest_records: scope.guestAccounts.length > 0,
    needed: scope.needed.map(({ provider, name, avatar }) => ({ provider, name, avatar })),
    nothing,
    ready: flow.confirmed.length > 0 && !scope.needed.length && !nothing,
  };
}

/** POST /erase/start { return_to } → { id, secret, expires_in } */
export async function handleEraseStart(request, env, corsOrigin, deps) {
  const body = await readJson(request);
  const returnTo = deps.allowedReturnTo(body.return_to, env.CORS_ORIGIN, deps.pickCorsOrigin);
  if (!returnTo) return deps.jsonResponse({ error: 'return_to not allowed' }, 400, corsOrigin);
  const id = randomId(12);
  const secret = randomId(24);
  await env.DB.prepare('DELETE FROM auth_requests WHERE created_at < ?').bind(nowS() - 3600).run();
  await env.DB.prepare(
    `INSERT INTO auth_requests (id, secret_hash, provider, mode, user_code, link_user_id, return_to, status, profile_json, created_at)
     VALUES (?, ?, 'erase', 'erase', NULL, NULL, ?, 'open', ?, ?)`
  ).bind(id, await sha256(secret), returnTo, JSON.stringify({ confirmed: [] }), nowS()).run();
  return deps.jsonResponse({ id, secret, expires_in: FLOW_TTL_S }, 200, corsOrigin);
}

/** POST /erase/signin { id, secret, provider } → { url } (Steam's or Discord's sign-in page) */
export async function handleEraseSignIn(request, env, url, corsOrigin, deps) {
  const body = await readJson(request);
  const flow = await liveFlow(env, body);
  if (!flow) return gone(deps, corsOrigin);
  if (!PROVIDERS.has(body.provider)) return deps.jsonResponse({ error: 'Choose Steam or Discord' }, 400, corsOrigin);
  if (body.provider === 'steam' && !env.STEAM_WEB_API_KEY) return deps.jsonResponse({ error: 'Steam sign-in is not set up yet' }, 503, corsOrigin);
  if (body.provider === 'discord' && !(env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET)) {
    return deps.jsonResponse({ error: 'Discord sign-in is not set up yet' }, 503, corsOrigin);
  }
  if (flow.confirmed.length >= MAX_CONFIRMED) return deps.jsonResponse({ error: 'Too many sign-ins for one delete. Start again.' }, 400, corsOrigin);
  const signin = await beginEraseSignIn(env, url, flow.row.id, body.provider, flow.row.return_to);
  return deps.jsonResponse({ url: signin }, 200, corsOrigin);
}

/**
 * POST /erase/attach { id, secret, ticket } → the status, plus `added`: what the sign-in confirmed
 * and `matched`: false when it reached nothing new (another Discord than the one linked, say).
 */
export async function handleEraseAttach(request, env, corsOrigin, deps) {
  const body = await readJson(request);
  const flow = await liveFlow(env, body);
  if (!flow) return gone(deps, corsOrigin);
  const who = await takeEraseSignIn(env, flow.row.id, body.ticket);
  if (!who) return deps.jsonResponse({ error: 'That sign-in has expired or was for another delete. Sign in again.', code: 'ticket_gone' }, 410, corsOrigin);
  const before = await eraseScope(env, flow.confirmed, deps);
  const key = `${who.provider}:${who.providerId}`;
  if (!flow.confirmed.some((c) => `${c.provider}:${c.providerId}` === key)) {
    if (flow.confirmed.length >= MAX_CONFIRMED) return deps.jsonResponse({ error: 'Too many sign-ins for one delete. Start again.' }, 400, corsOrigin);
    flow.confirmed.push(who);
    await env.DB.prepare('UPDATE auth_requests SET profile_json = ? WHERE id = ?')
      .bind(JSON.stringify({ confirmed: flow.confirmed }), flow.row.id).run();
  }
  const scope = await eraseScope(env, flow.confirmed, deps);
  const wasNeeded = before.needed.length > scope.needed.length;
  const reachesMore = scope.accounts.size > before.accounts.size || scope.sessions > before.sessions;
  return deps.jsonResponse({
    ...(await statusBody(env, flow, scope)),
    added: { provider: who.provider, name: who.name, avatar: who.avatar },
    matched: wasNeeded || reachesMore || flow.confirmed.length === 1,
  }, 200, corsOrigin);
}

/** POST /erase/status { id, secret } → what the confirmed sign-ins reach. */
export async function handleEraseStatus(request, env, corsOrigin, deps) {
  const flow = await liveFlow(env, await readJson(request));
  if (!flow) return gone(deps, corsOrigin);
  return deps.jsonResponse(await statusBody(env, flow, await eraseScope(env, flow.confirmed, deps)), 200, corsOrigin);
}

/** POST /erase/confirm { id, secret, confirm: 'DELETE', understood: true } → { deleted, ... } */
export async function handleEraseConfirm(request, env, corsOrigin, deps) {
  const body = await readJson(request);
  const flow = await liveFlow(env, body);
  if (!flow) return gone(deps, corsOrigin);
  if (body.confirm !== 'DELETE' || body.understood !== true) {
    return deps.jsonResponse({ error: 'Tick the box and type DELETE to confirm.' }, 400, corsOrigin);
  }
  // Worked out again now: a sign-in linked since the page last looked must be confirmed too.
  const scope = await eraseScope(env, flow.confirmed, deps);
  const status = await statusBody(env, flow, scope);
  if (!status.ready) {
    return deps.jsonResponse({ error: status.nothing ? 'There is nothing to delete.' : 'Confirm every sign-in on the account first.', code: 'not_ready', ...status }, 409, corsOrigin);
  }
  // Single use: the delete is gone before anything is removed, so a second click does nothing.
  const taken = await env.DB.prepare("DELETE FROM auth_requests WHERE id = ? AND provider = 'erase' RETURNING id").bind(flow.row.id).all();
  if (!(taken.results && taken.results.length)) return gone(deps, corsOrigin);

  const totals = { accounts: 0, rides: 0, achievements: 0, sessions: scope.sessions };
  for (const userId of scope.accounts.keys()) {
    const n = await deps.deleteAccountRecords(env, userId);
    totals.accounts += 1;
    totals.rides += n.rides || 0;
    totals.achievements += n.achievements || 0;
  }
  for (const userId of scope.guestAccounts) await deps.deleteAccountRecords(env, userId);

  // The game sessions recorded with these Steam IDs, and every session on a device only
  // they played on, stay only as anonymous counts: the Steam ID, account, login, address and
  // device id are cleared (the same as an account delete).
  const q = (sql, ...args) => env.DB.prepare(sql).bind(...args);
  const clear = `SET steam_id = NULL, google_uid = NULL, login_id = NULL, ip_address = NULL, device_id = NULL,
                 user_agent = COALESCE(user_agent, '')`;
  const stmts = [];
  if (scope.devices.length) {
    stmts.push(q(`UPDATE sessions ${clear} WHERE device_id IN (${scope.devices.map(() => '?').join(', ')})`, ...scope.devices));
  }
  if (scope.steamIds.length) {
    stmts.push(q(`UPDATE sessions ${clear} WHERE steam_id IN (${scope.steamIds.map(() => '?').join(', ')})`, ...scope.steamIds));
  }
  if (stmts.length) {
    try { await env.DB.batch(stmts); } catch (e) { if (!noColumn(e)) throw e; }
  }
  await dropSignIns(env, flow.row.id);
  deps.writeMetric && deps.writeMetric(env, 'account_deleted_verified');
  return deps.jsonResponse({ deleted: true, ...totals }, 200, corsOrigin);
}

/** POST /erase/cancel { id, secret } → { cancelled: true }. Nothing is deleted. */
export async function handleEraseCancel(request, env, corsOrigin, deps) {
  const flow = await liveFlow(env, await readJson(request));
  if (flow) {
    await env.DB.prepare('DELETE FROM auth_requests WHERE id = ?').bind(flow.row.id).run();
    await dropSignIns(env, flow.row.id);
  }
  return deps.jsonResponse({ cancelled: true }, 200, corsOrigin);
}

/**
 * The Steam and Discord sign-ins on an account. An account delete from a signed-in page
 * (POST /me/delete) proves only the one it signed in with, so an account with more than one
 * goes through the confirmed delete instead.
 */
export async function signInsToConfirm(env, userId) {
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM user_logins WHERE user_id = ? AND provider IN (${MUST_CONFIRM.map(() => '?').join(', ')})`
  ).bind(userId, ...MUST_CONFIRM).first();
  return (r && r.n) || 0;
}
