// ============================================================
// IDENTITY — one account, several sign-ins (#612)
// ============================================================
//
// A House Tandem account (a `users` row) can have several sign-ins linked to
// it in `user_identities`: Discord, Steam, and the legacy Google. They are
// joined by provider id, never by email.
//
// Discord sign-in has two modes:
//   - redirect: the web game on the same device. The browser goes to Discord
//     and comes back to the game with the session in the URL fragment.
//   - device: the sign-in finishes somewhere else (a phone scanning the TV's
//     QR, or the system browser opened by the Steam build). The game polls
//     with a secret only it holds. The browser shows a short code and asks
//     "is this your screen?" before the session is handed over, so a shared
//     link can't sign someone else into a stranger's game.
//
// This lives in the Tandemonium worker for now. The House Tandem service
// (auth.housetandem.com, UsersFirst/housetandem-web#21) takes it over later;
// the tables and routes are shaped so they can move as they are.

const REQUEST_TTL_S = 600;
const DISCORD_API = 'https://discord.com/api';
// No 0/O/1/I/L: the code is read off a TV across a room.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function b64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function randomId(n) {
  return b64url(crypto.getRandomValues(new Uint8Array(n)));
}
function randomCode(n = 4) {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}
async function sha256(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return b64url(new Uint8Array(d));
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const nowS = () => Math.floor(Date.now() / 1000);

/**
 * #678 · the game's device id (js/analytics.js getDeviceId), sent with a
 * sign-in so the pairs this device rode as 'guest:<device id>' move to the
 * account. Anything that isn't a short plain token is ignored.
 */
export function cleanDeviceId(v) {
  return typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(v) ? v : null;
}

/** The device id a begin call stored on the request (profile_json is empty until the callback). */
function requestDeviceId(row) {
  try { return cleanDeviceId(JSON.parse(row.profile_json || '{}').deviceId); } catch { return null; }
}

/** The picture for a Discord user: their avatar, or Discord's default for their id. */
export function discordAvatarUrl(user) {
  if (user && user.avatar) return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`;
  let idx = 0;
  try { idx = Number((BigInt(user.id) >> 22n) % 6n); } catch { idx = 0; }
  return `https://cdn.discordapp.com/embed/avatars/${idx}.png`;
}

/** Every sign-in on an account, as { provider: { name, avatar } }. */
export async function listIdentities(env, userId) {
  const rows = await env.DB.prepare(
    'SELECT provider, provider_id, display_name, avatar_url, last_login_at, linked_at FROM user_identities WHERE user_id = ? ORDER BY linked_at'
  ).bind(userId).all();
  const out = {};
  for (const r of rows.results || []) {
    // Two of one provider (two Steam accounts merged into one): keep the latest login.
    const prev = out[r.provider];
    if (prev && (prev._at || '') > (r.last_login_at || r.linked_at || '')) continue;
    out[r.provider] = { name: r.display_name, avatar: r.avatar_url, _at: r.last_login_at || r.linked_at || '' };
  }
  for (const k of Object.keys(out)) delete out[k]._at;
  return out;
}

/**
 * Find or create the account for a sign-in. With `linkUserId` (the player is
 * already signed in and is adding a sign-in), the sign-in joins that account;
 * if it was already on another account, that account is merged into this one.
 * Returns { userId, merged }.
 */
export async function upsertIdentity(env, { provider, providerId, name, avatar }, linkUserId = null, deps = {}) {
  providerId = String(providerId);
  let existing = await env.DB.prepare(
    'SELECT user_id FROM user_identities WHERE provider = ? AND provider_id = ?'
  ).bind(provider, providerId).first();
  if (!existing) {
    // A user made by the old code after the migration's backfill: give them
    // their identity row now instead of a second account.
    const legacy = await env.DB.prepare('SELECT id FROM users WHERE provider = ? AND provider_id = ?')
      .bind(provider, providerId).first();
    if (legacy) {
      await env.DB.prepare(
        'INSERT OR IGNORE INTO user_identities (user_id, provider, provider_id, display_name, avatar_url) VALUES (?, ?, ?, ?, ?)'
      ).bind(legacy.id, provider, providerId, name, avatar).run();
      existing = { user_id: legacy.id };
    }
  }

  let userId;
  let merged = false;
  if (linkUserId) {
    const target = await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(linkUserId).first();
    if (!target) throw new Error('Account not found');
    userId = target.id;
    if (existing && existing.user_id !== userId) {
      await mergeAccounts(env, existing.user_id, userId, deps);
      merged = true;
    } else if (!existing) {
      await env.DB.prepare(
        'INSERT INTO user_identities (user_id, provider, provider_id, display_name, avatar_url) VALUES (?, ?, ?, ?, ?)'
      ).bind(userId, provider, providerId, name, avatar).run();
    }
  } else if (existing) {
    userId = existing.user_id;
    await env.DB.prepare('UPDATE users SET display_name = ?, avatar_url = ? WHERE id = ?')
      .bind(name, avatar, userId).run();
  } else {
    const ins = await env.DB.prepare(
      'INSERT INTO users (provider, provider_id, display_name, avatar_url) VALUES (?, ?, ?, ?)'
    ).bind(provider, providerId, name, avatar).run();
    userId = ins.meta && ins.meta.last_row_id;
    if (!userId) {
      const row = await env.DB.prepare('SELECT id FROM users WHERE provider = ? AND provider_id = ?')
        .bind(provider, providerId).first();
      userId = row.id;
    }
    await env.DB.prepare(
      'INSERT OR IGNORE INTO user_identities (user_id, provider, provider_id, display_name, avatar_url) VALUES (?, ?, ?, ?, ?)'
    ).bind(userId, provider, providerId, name, avatar).run();
  }

  await env.DB.prepare(
    "UPDATE user_identities SET display_name = ?, avatar_url = ?, last_login_at = datetime('now') WHERE provider = ? AND provider_id = ?"
  ).bind(name, avatar, provider, providerId).run();
  return { userId, merged };
}

/**
 * Move everything from account `from` onto account `to`, then delete `from`.
 * Used when a player links a sign-in that already had its own account (signed
 * in with Discord on the web first, then linked Discord from the Steam build).
 */
export async function mergeAccounts(env, from, to, deps = {}) {
  if (!from || !to || from === to) return;
  const q = (sql, ...args) => env.DB.prepare(sql).bind(...args).run();
  await q('UPDATE user_identities SET user_id = ? WHERE user_id = ?', to, from);
  await q('UPDATE scores SET user_id = ? WHERE user_id = ?', to, from);
  await q('UPDATE score_contributions SET player_user_id = ? WHERE player_user_id = ?', to, from);
  // Analytics sessions name the account by number ("26.0"): they follow it too.
  await q('UPDATE sessions SET google_uid = ? WHERE CAST(google_uid AS INTEGER) = ?', String(to), from);
  // Seats 2–4 on couch rides (migration 0016; absent before it is applied).
  try { await q('UPDATE ride_seats SET user_id = ? WHERE user_id = ?', to, from); } catch (e) { if (!/no such table/.test(String(e && e.message))) throw e; }
  await q(`INSERT OR IGNORE INTO user_achievements (user_id, achievement_id, earned_at, score_id)
           SELECT ?, achievement_id, earned_at, score_id FROM user_achievements WHERE user_id = ?`, to, from);
  await q('DELETE FROM user_achievements WHERE user_id = ?', from);
  // One daily row per day per mode: keep `to`'s where both rode.
  await q('UPDATE OR IGNORE daily_results SET user_id = ? WHERE user_id = ?', to, from);
  await q('DELETE FROM daily_results WHERE user_id = ?', from);
  await q('UPDATE daily_results SET partner_user_id = ? WHERE partner_user_id = ?', to, from);
  await q('UPDATE OR IGNORE friends SET user_id = ? WHERE user_id = ?', to, from);
  await q('UPDATE OR IGNORE friends SET friend_id = ? WHERE friend_id = ?', to, from);
  await q('DELETE FROM friends WHERE user_id = ? OR friend_id = ? OR user_id = friend_id', from, from);
  if (deps.mergePairKey) await deps.mergePairKey(env, String(from), String(to));
  // The other games' rows (and time in game) reference users(id): move them before the delete.
  if (deps.mergeGameAccounts) await deps.mergeGameAccounts(env, from, to);
  await q('DELETE FROM users WHERE id = ?', from);
}

/** A return URL is only followed back to a site the API already serves. */
export function allowedReturnTo(returnTo, corsSetting, pickCorsOrigin) {
  if (!returnTo || typeof returnTo !== 'string' || returnTo.length > 1000) return null;
  let u;
  try { u = new URL(returnTo); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const allowed = (corsSetting || '').split(',').map((s) => s.trim()).filter(Boolean);
  const local = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(u.origin);
  if (!local && !allowed.includes(u.origin)) return null;
  u.hash = '';
  return u.toString();
}

function discordConfigured(env) {
  return !!(env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET);
}
function redirectUri(env, url) {
  return env.DISCORD_REDIRECT_URI || `${url.origin}/auth/discord/callback`;
}

/**
 * POST /auth/discord/begin  { mode: 'redirect'|'device', return_to?, device_id? }
 * With a Bearer token the sign-in is linked to that account.
 * → { id, secret, url, code, expires_in }
 */
export async function handleDiscordBegin(request, env, url, corsOrigin, deps) {
  if (!discordConfigured(env)) return deps.jsonResponse({ error: 'Discord sign-in is not set up yet' }, 503, corsOrigin);
  let body = {};
  try { body = await request.json(); } catch {}
  const mode = body.mode === 'redirect' ? 'redirect' : 'device';
  let returnTo = null;
  if (mode === 'redirect') {
    returnTo = allowedReturnTo(body.return_to, env.CORS_ORIGIN, deps.pickCorsOrigin);
    if (!returnTo) return deps.jsonResponse({ error: 'return_to not allowed' }, 400, corsOrigin);
  }
  const linkUserId = await deps.getUserFromRequest(request, env);

  const deviceId = cleanDeviceId(body.device_id);

  const id = randomId(12);
  const secret = randomId(24);
  const code = mode === 'device' ? randomCode(4) : null;
  await env.DB.prepare('DELETE FROM auth_requests WHERE created_at < ?').bind(nowS() - 3600).run();
  await env.DB.prepare(
    `INSERT INTO auth_requests (id, secret_hash, provider, mode, user_code, link_user_id, return_to, status, profile_json, created_at)
     VALUES (?, ?, 'discord', ?, ?, ?, ?, 'pending', ?, ?)`
  ).bind(id, await sha256(secret), mode, code, linkUserId || null, returnTo,
         deviceId ? JSON.stringify({ deviceId }) : null, nowS()).run();

  return deps.jsonResponse({
    id, secret, code, expires_in: REQUEST_TTL_S,
    url: `${url.origin}/auth/discord/go?r=${encodeURIComponent(id)}`,
  }, 200, corsOrigin);
}

async function liveRequest(env, id) {
  if (!id) return null;
  const row = await env.DB.prepare('SELECT * FROM auth_requests WHERE id = ?').bind(id).first();
  if (!row || row.created_at < nowS() - REQUEST_TTL_S) return null;
  return row;
}

/** GET /auth/discord/go?r=<id> → Discord's consent screen. Short, so it fits a QR. */
export async function handleDiscordGo(request, env, url) {
  const row = await liveRequest(env, url.searchParams.get('r'));
  if (!row || row.status !== 'pending') return page('This sign-in link has expired', '<p>Go back to the game and choose <b>Sign in with Discord</b> again.</p>', 410);
  const auth = new URL('https://discord.com/oauth2/authorize');
  auth.searchParams.set('client_id', env.DISCORD_CLIENT_ID);
  auth.searchParams.set('response_type', 'code');
  auth.searchParams.set('redirect_uri', redirectUri(env, url));
  auth.searchParams.set('scope', 'identify');
  auth.searchParams.set('state', row.id);
  return Response.redirect(auth.toString(), 302);
}

async function fetchDiscordUser(env, url, code) {
  const tokenRes = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID,
      client_secret: env.DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(env, url),
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!tokenRes.ok) throw new Error('Discord token exchange failed (' + tokenRes.status + ')');
  const tok = await tokenRes.json();
  const meRes = await fetch(`${DISCORD_API}/users/@me`, {
    headers: { Authorization: `Bearer ${tok.access_token}` },
    signal: AbortSignal.timeout(8000),
  });
  if (!meRes.ok) throw new Error('Discord profile fetch failed (' + meRes.status + ')');
  const me = await meRes.json();
  if (!me || !me.id) throw new Error('Discord returned no user');
  return {
    provider: 'discord',
    providerId: me.id,
    name: me.global_name || me.username || 'Discord player',
    avatar: discordAvatarUrl(me),
  };
}

/**
 * #678 · fold this device's guest pairs into the account it just signed in to.
 * A pair row is a nicety: a failure here never fails the sign-in.
 */
export async function claimGuestPairs(env, deviceId, userId, deps) {
  if (!deviceId || !userId || !deps || !deps.mergeGuestPairs) return;
  try {
    await deps.mergeGuestPairs(env, deviceId, userId);
  } catch (e) {
    console.error('guest pair merge failed', e);
  }
}

/** Sign the profile in (or link it), store the session on the request. */
async function finish(env, row, profile, deps, deviceId = null) {
  const { userId, merged } = await upsertIdentity(env, profile, row.link_user_id || null, deps);
  await claimGuestPairs(env, deviceId, userId, deps);
  const user = await env.DB.prepare('SELECT id, display_name, avatar_url FROM users WHERE id = ?').bind(userId).first();
  const identities = await listIdentities(env, userId);
  const token = await deps.createJWT({ sub: userId, name: user.display_name, picture: user.avatar_url }, env.JWT_SECRET);
  const result = {
    token, merged, linked: !!row.link_user_id,
    user: { id: userId, name: user.display_name, avatar: user.avatar_url, identities },
  };
  const p = profile.provider || 'discord';
  deps.writeMetric && deps.writeMetric(env, (row.link_user_id ? 'link_' : 'auth_') + p + (p === 'steam' ? '_web' : ''));
  return result;
}

/** GET /auth/discord/callback?code&state — Discord sends the browser back here. */
export async function handleDiscordCallback(request, env, url, deps) {
  const row = await liveRequest(env, url.searchParams.get('state'));
  if (!row || row.status !== 'pending') return page('This sign-in link has expired', '<p>Go back to the game and choose <b>Sign in with Discord</b> again.</p>', 410);
  if (url.searchParams.get('error')) {
    await env.DB.prepare("UPDATE auth_requests SET status = 'error', result_json = ? WHERE id = ?")
      .bind(JSON.stringify({ error: 'cancelled' }), row.id).run();
    if (row.mode === 'redirect' && row.return_to) return Response.redirect(row.return_to, 302);
    return page('Sign-in cancelled', '<p>Nothing was changed. You can close this tab.</p>');
  }
  let profile;
  try {
    profile = await fetchDiscordUser(env, url, url.searchParams.get('code'));
  } catch (e) {
    return page('Discord sign-in failed', `<p>${escapeHtml(e.message)}</p><p>Go back to the game and try again.</p>`, 502);
  }

  if (row.mode === 'redirect') {
    const result = await finish(env, row, profile, deps, requestDeviceId(row));
    await env.DB.prepare('DELETE FROM auth_requests WHERE id = ?').bind(row.id).run();
    return Response.redirect(`${row.return_to}#ht_auth=${encodeURIComponent(result.token)}`, 302);
  }

  // Device mode: hold the profile until the player confirms the code on their screen.
  const confirmKey = randomId(12);
  await env.DB.prepare("UPDATE auth_requests SET status = 'confirm', profile_json = ? WHERE id = ?")
    .bind(JSON.stringify({ ...profile, confirmKey, deviceId: requestDeviceId(row) }), row.id).run();
  const action = row.link_user_id ? 'Link this Discord account to the game' : 'Sign in to the game';
  return page('Is this your screen?', `
    <div class="who"><img src="${escapeHtml(profile.avatar)}" alt=""><span>${escapeHtml(profile.name)}</span></div>
    <p>The game is showing this code:</p>
    <div class="code">${escapeHtml(row.user_code)}</div>
    <p>Only continue if it matches the code on your TV or game screen.</p>
    <form method="POST" action="/auth/discord/confirm">
      <input type="hidden" name="r" value="${escapeHtml(row.id)}">
      <input type="hidden" name="k" value="${escapeHtml(confirmKey)}">
      <button type="submit" name="ok" value="1">Yes, ${escapeHtml(action.charAt(0).toLowerCase() + action.slice(1))}</button>
      <button type="submit" name="ok" value="0" class="ghost">No, cancel</button>
    </form>`);
}

/** POST /auth/discord/confirm (form) — the player said the code matches. */
export async function handleDiscordConfirm(request, env, url, deps) {
  let form;
  try { form = await request.formData(); } catch { return page('Something went wrong', '<p>Try again from the game.</p>', 400); }
  const row = await liveRequest(env, String(form.get('r') || ''));
  if (!row || row.status !== 'confirm') return page('This sign-in link has expired', '<p>Go back to the game and choose <b>Sign in with Discord</b> again.</p>', 410);
  let profile = null;
  try { profile = JSON.parse(row.profile_json); } catch {}
  if (!profile || profile.confirmKey !== String(form.get('k') || '')) return page('Something went wrong', '<p>Try again from the game.</p>', 400);
  if (String(form.get('ok')) !== '1') {
    await env.DB.prepare("UPDATE auth_requests SET status = 'error', result_json = ? WHERE id = ?")
      .bind(JSON.stringify({ error: 'cancelled' }), row.id).run();
    return page('Cancelled', '<p>Nothing was changed. You can close this tab.</p>');
  }
  const deviceId = cleanDeviceId(profile.deviceId);
  delete profile.confirmKey;
  delete profile.deviceId;
  const result = await finish(env, row, profile, deps, deviceId);
  await env.DB.prepare("UPDATE auth_requests SET status = 'done', result_json = ?, profile_json = NULL WHERE id = ?")
    .bind(JSON.stringify(result), row.id).run();
  const done = row.link_user_id ? 'Discord is linked' : `Signed in as ${escapeHtml(result.user.name)}`;
  return page(done, '<p>Look back at the game. You can close this tab.</p>');
}

/** POST /auth/poll { id, secret } → { status: pending | done | error | expired, ... } */
export async function handleAuthPoll(request, env, corsOrigin, deps) {
  let body = {};
  try { body = await request.json(); } catch {}
  const row = await liveRequest(env, body.id);
  if (!row || !body.secret || (await sha256(String(body.secret))) !== row.secret_hash) {
    return deps.jsonResponse({ status: 'expired' }, 404, corsOrigin);
  }
  if (row.status === 'pending' || row.status === 'confirm') {
    return deps.jsonResponse({ status: row.status === 'confirm' ? 'confirming' : 'pending' }, 200, corsOrigin);
  }
  await env.DB.prepare('DELETE FROM auth_requests WHERE id = ?').bind(row.id).run();
  let result = {};
  try { result = JSON.parse(row.result_json || '{}'); } catch {}
  if (row.status === 'done') return deps.jsonResponse({ status: 'done', ...result }, 200, corsOrigin);
  return deps.jsonResponse({ status: 'error', error: result.error || 'failed' }, 200, corsOrigin);
}

// ------------------------------------------------------------
// Steam on the web (#612): "Sign in through Steam" (OpenID 2.0)
// ------------------------------------------------------------
//
// For websites (housetandem.com, the web game). The Steam build signs in with a
// Steam ticket instead. Both land on the same identity: provider 'steam' with
// the 17-digit SteamID64, so the web finds the account the game made.
// Redirect only: the browser goes to steamcommunity.com and comes back here,
// then to the site with the session in the URL fragment.

const STEAM_OPENID = 'https://steamcommunity.com/openid/login';
const OPENID_NS = 'http://specs.openid.net/auth/2.0';
const STEAM_ID_RE = /^https:\/\/steamcommunity\.com\/openid\/id\/(7656119\d{10})$/;
const STEAM_DEFAULT_AVATAR = 'https://avatars.steamstatic.com/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_medium.jpg';

function steamCallbackUrl(url, id) {
  return `${url.origin}/auth/steam/callback?r=${encodeURIComponent(id)}`;
}

/**
 * POST /auth/steam/begin  { return_to, device_id? }
 * With a Bearer token the Steam account is linked to that account.
 * → { id, url, expires_in }
 */
export async function handleSteamWebBegin(request, env, url, corsOrigin, deps) {
  if (!env.STEAM_WEB_API_KEY) return deps.jsonResponse({ error: 'Steam sign-in is not set up yet' }, 503, corsOrigin);
  let body = {};
  try { body = await request.json(); } catch {}
  const returnTo = allowedReturnTo(body.return_to, env.CORS_ORIGIN, deps.pickCorsOrigin);
  if (!returnTo) return deps.jsonResponse({ error: 'return_to not allowed' }, 400, corsOrigin);
  const linkUserId = await deps.getUserFromRequest(request, env);
  const deviceId = cleanDeviceId(body.device_id);
  const id = randomId(12);
  await env.DB.prepare('DELETE FROM auth_requests WHERE created_at < ?').bind(nowS() - 3600).run();
  await env.DB.prepare(
    `INSERT INTO auth_requests (id, secret_hash, provider, mode, user_code, link_user_id, return_to, status, profile_json, created_at)
     VALUES (?, ?, 'steam', 'redirect', NULL, ?, ?, 'pending', ?, ?)`
  ).bind(id, await sha256(randomId(24)), linkUserId || null, returnTo,
         deviceId ? JSON.stringify({ deviceId }) : null, nowS()).run();
  return deps.jsonResponse({
    id, expires_in: REQUEST_TTL_S,
    url: `${url.origin}/auth/steam/go?r=${encodeURIComponent(id)}`,
  }, 200, corsOrigin);
}

/** GET /auth/steam/go?r=<id> → Steam's sign-in page. */
export async function handleSteamWebGo(request, env, url) {
  const row = await liveRequest(env, url.searchParams.get('r'));
  if (!row || row.provider !== 'steam' || row.status !== 'pending') {
    return page('This sign-in link has expired', '<p>Go back and choose <b>Sign in with Steam</b> again.</p>', 410);
  }
  const auth = new URL(STEAM_OPENID);
  auth.searchParams.set('openid.ns', OPENID_NS);
  auth.searchParams.set('openid.mode', 'checkid_setup');
  auth.searchParams.set('openid.return_to', steamCallbackUrl(url, row.id));
  auth.searchParams.set('openid.realm', url.origin);
  auth.searchParams.set('openid.identity', OPENID_NS + '/identifier_select');
  auth.searchParams.set('openid.claimed_id', OPENID_NS + '/identifier_select');
  return Response.redirect(auth.toString(), 302);
}

/**
 * Check Steam's answer: it is for this request, and Steam itself confirms it
 * (check_authentication). Returns the SteamID64 or throws.
 */
export async function verifySteamAssertion(url, rowId, fetchImpl = fetch) {
  const q = url.searchParams;
  if (q.get('openid.mode') !== 'id_res') throw new Error('Steam did not sign you in');
  if (q.get('openid.op_endpoint') !== STEAM_OPENID) throw new Error('Not a Steam sign-in');
  if (q.get('openid.return_to') !== steamCallbackUrl(url, rowId)) throw new Error('This sign-in was for a different request');
  const m = STEAM_ID_RE.exec(q.get('openid.claimed_id') || '');
  if (!m || q.get('openid.identity') !== q.get('openid.claimed_id')) throw new Error('Steam returned no account');
  const signed = (q.get('openid.signed') || '').split(',');
  for (const f of ['op_endpoint', 'claimed_id', 'identity', 'return_to', 'response_nonce', 'assoc_handle']) {
    if (!signed.includes(f)) throw new Error('The Steam sign-in was not signed');
  }
  const check = new URLSearchParams();
  for (const [k, v] of q) if (k.startsWith('openid.')) check.set(k, v);
  check.set('openid.mode', 'check_authentication');
  const res = await fetchImpl(STEAM_OPENID, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: check.toString(),
    signal: AbortSignal.timeout(8000),
  });
  const text = res.ok ? await res.text() : '';
  if (!/^is_valid\s*:\s*true\s*$/m.test(text)) throw new Error('Steam could not confirm the sign-in');
  return m[1];
}

async function fetchSteamProfile(env, steamId, fetchImpl = fetch) {
  let name = 'Steam Player';
  let avatar = STEAM_DEFAULT_AVATAR;
  try {
    const r = await fetchImpl(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${env.STEAM_WEB_API_KEY}&steamids=${steamId}`,
      { signal: AbortSignal.timeout(5000) });
    if (r.ok) {
      const p = (await r.json())?.response?.players?.[0];
      if (p?.personaname) name = p.personaname;
      if (p?.avatarmedium) avatar = p.avatarmedium;
    }
  } catch {}
  return { provider: 'steam', providerId: steamId, name, avatar };
}

/** GET /auth/steam/callback?r=<id>&openid.* — Steam sends the browser back here. */
export async function handleSteamWebCallback(request, env, url, deps) {
  const row = await liveRequest(env, url.searchParams.get('r'));
  if (!row || row.provider !== 'steam' || row.status !== 'pending') {
    return page('This sign-in link has expired', '<p>Go back and choose <b>Sign in with Steam</b> again.</p>', 410);
  }
  // Single use, whatever happens next.
  await env.DB.prepare('DELETE FROM auth_requests WHERE id = ?').bind(row.id).run();
  if (url.searchParams.get('openid.mode') === 'cancel') return Response.redirect(row.return_to, 302);
  const fetchImpl = deps.fetchImpl || fetch;
  let steamId;
  try {
    steamId = await verifySteamAssertion(url, row.id, fetchImpl);
  } catch (e) {
    return page('Steam sign-in failed', `<p>${escapeHtml(e.message)}</p><p>Go back and try again.</p>`, 401);
  }
  const profile = await fetchSteamProfile(env, steamId, fetchImpl);
  const result = await finish(env, row, profile, deps, requestDeviceId(row));
  return Response.redirect(`${row.return_to}#ht_auth=${encodeURIComponent(result.token)}`, 302);
}

// ------------------------------------------------------------
// House Tandem Discord membership (#612)
// ------------------------------------------------------------
//
// The House Tandem bot sits in the players' server with no permissions; it
// only looks up one member by id. That needs no privileged intent and no
// extra consent from the player.

/**
 * GET /me/discord → { linked, member: true | false | null, invite }
 * member is null when it can't be checked (no bot set up, or Discord is down).
 */
export async function handleDiscordMembership(request, env, corsOrigin, userId, deps) {
  const invite = env.DISCORD_INVITE_URL || null;
  const { linked, member } = await discordMemberStatus(env, userId, deps.fetchImpl);
  return deps.jsonResponse({ linked, member, invite }, 200, corsOrigin);
}

/**
 * Is this account's Discord in the House Tandem server? → { linked, member }
 * member: true | false, or null when it can't be checked. Also used by the
 * #daily-ride-clips post (worker/share.js), which needs a member.
 */
export async function discordMemberStatus(env, userId, fetchImpl = fetch) {
  const row = await env.DB.prepare(
    "SELECT provider_id FROM user_identities WHERE user_id = ? AND provider = 'discord' ORDER BY last_login_at DESC LIMIT 1"
  ).bind(userId).first();
  if (!row) return { linked: false, member: null };
  if (!env.DISCORD_BOT_TOKEN || !env.DISCORD_GUILD_ID) return { linked: true, member: null };
  fetchImpl = fetchImpl || fetch;
  let member = null;
  try {
    const res = await fetchImpl(`${DISCORD_API}/v10/guilds/${env.DISCORD_GUILD_ID}/members/${row.provider_id}`, {
      headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) member = true;
    else if (res.status === 404) member = false;
  } catch {}
  return { linked: true, member };
}

// ------------------------------------------------------------
// Handoff: open another House Tandem site already signed in (#612)
// ------------------------------------------------------------
//
// Each site keeps its own session (localStorage is per origin). A signed-in
// link from housetandem.com to dice.housetandem.com carries a one-time code
// instead of the session itself: single use, a minute long, and only good
// for a fresh session on the same account.

const HANDOFF_TTL_S = 60;

/** POST /auth/handoff (signed in) → { code, expires_in } */
export async function handleHandoffCreate(request, env, corsOrigin, userId, deps) {
  const id = randomId(12);
  const secret = randomId(18);
  await env.DB.prepare('DELETE FROM auth_requests WHERE created_at < ?').bind(nowS() - 3600).run();
  await env.DB.prepare(
    `INSERT INTO auth_requests (id, secret_hash, provider, mode, user_code, link_user_id, return_to, status, created_at)
     VALUES (?, ?, 'handoff', 'handoff', NULL, ?, NULL, 'done', ?)`
  ).bind(id, await sha256(secret), userId, nowS()).run();
  return deps.jsonResponse({ code: `${id}.${secret}`, expires_in: HANDOFF_TTL_S }, 200, corsOrigin);
}

/** POST /auth/handoff/redeem { code } → { token, user } */
export async function handleHandoffRedeem(request, env, corsOrigin, deps) {
  let body = {};
  try { body = await request.json(); } catch {}
  const [id, secret] = String(body.code || '').split('.');
  const gone = () => deps.jsonResponse({ error: 'This sign-in link has expired' }, 410, corsOrigin);
  if (!id || !secret) return gone();
  const row = await env.DB.prepare("SELECT * FROM auth_requests WHERE id = ? AND provider = 'handoff'").bind(id).first();
  if (!row) return gone();
  await env.DB.prepare('DELETE FROM auth_requests WHERE id = ?').bind(id).run();
  if (row.created_at < nowS() - HANDOFF_TTL_S || (await sha256(secret)) !== row.secret_hash) return gone();
  const user = await env.DB.prepare('SELECT id, display_name, avatar_url FROM users WHERE id = ?').bind(row.link_user_id).first();
  if (!user) return gone();
  const token = await deps.createJWT({ sub: user.id, name: user.display_name, picture: user.avatar_url }, env.JWT_SECRET);
  const identities = await listIdentities(env, user.id);
  deps.writeMetric && deps.writeMetric(env, 'auth_handoff');
  return deps.jsonResponse({ token, user: { id: user.id, name: user.display_name, avatar: user.avatar_url, identities } }, 200, corsOrigin);
}

/** The small page the browser shows during a sign-in. */
function page(title, body, status = 200) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · House Tandem</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #17131f; color: #f4efe6;
         font: 17px/1.5 system-ui, -apple-system, Segoe UI, sans-serif; padding: 16px; box-sizing: border-box; }
  main { max-width: 420px; width: 100%; text-align: center; }
  h1 { font-size: 24px; margin: 0 0 12px; }
  .brand { letter-spacing: .12em; text-transform: uppercase; font-size: 12px; opacity: .6; margin-bottom: 20px; }
  .who { display: inline-flex; align-items: center; gap: 10px; background: #2a2335; border-radius: 999px; padding: 6px 16px 6px 6px; }
  .who img { width: 40px; height: 40px; border-radius: 50%; }
  .code { font: 700 44px/1 ui-monospace, Consolas, monospace; letter-spacing: .25em; margin: 8px 0 12px; color: #ffd36b; }
  form { display: grid; gap: 10px; margin-top: 20px; }
  button { font: inherit; font-weight: 700; padding: 14px; border-radius: 12px; border: 0; background: #5865f2; color: #fff; cursor: pointer; }
  button.ghost { background: transparent; color: #f4efe6; border: 1px solid #5b5068; font-weight: 500; }
</style></head><body><main><div class="brand">House Tandem</div><h1>${escapeHtml(title)}</h1>${body}</main></body></html>`;
  return new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' } });
}
