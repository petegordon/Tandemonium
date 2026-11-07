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
  await q(`INSERT OR IGNORE INTO user_achievements (user_id, achievement_id, earned_at, score_id)
           SELECT ?, achievement_id, earned_at, score_id FROM user_achievements WHERE user_id = ?`, to, from);
  await q('DELETE FROM user_achievements WHERE user_id = ?', from);
  // One ranked daily run per day per mode: keep `to`'s where both rode.
  await q('UPDATE OR IGNORE daily_results SET user_id = ? WHERE user_id = ?', to, from);
  await q('DELETE FROM daily_results WHERE user_id = ?', from);
  await q('UPDATE daily_results SET partner_user_id = ? WHERE partner_user_id = ?', to, from);
  await q('UPDATE OR IGNORE friends SET user_id = ? WHERE user_id = ?', to, from);
  await q('UPDATE OR IGNORE friends SET friend_id = ? WHERE friend_id = ?', to, from);
  await q('DELETE FROM friends WHERE user_id = ? OR friend_id = ? OR user_id = friend_id', from, from);
  if (deps.mergePairKey) await deps.mergePairKey(env, String(from), String(to));
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
 * POST /auth/discord/begin  { mode: 'redirect'|'device', return_to? }
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

  const id = randomId(12);
  const secret = randomId(24);
  const code = mode === 'device' ? randomCode(4) : null;
  await env.DB.prepare('DELETE FROM auth_requests WHERE created_at < ?').bind(nowS() - 3600).run();
  await env.DB.prepare(
    `INSERT INTO auth_requests (id, secret_hash, provider, mode, user_code, link_user_id, return_to, status, created_at)
     VALUES (?, ?, 'discord', ?, ?, ?, ?, 'pending', ?)`
  ).bind(id, await sha256(secret), mode, code, linkUserId || null, returnTo, nowS()).run();

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

/** Sign the profile in (or link it), store the session on the request. */
async function finish(env, row, profile, deps) {
  const { userId, merged } = await upsertIdentity(env, profile, row.link_user_id || null, deps);
  const user = await env.DB.prepare('SELECT id, display_name, avatar_url FROM users WHERE id = ?').bind(userId).first();
  const identities = await listIdentities(env, userId);
  const token = await deps.createJWT({ sub: userId, name: user.display_name, picture: user.avatar_url }, env.JWT_SECRET);
  const result = {
    token, merged, linked: !!row.link_user_id,
    user: { id: userId, name: user.display_name, avatar: user.avatar_url, identities },
  };
  deps.writeMetric && deps.writeMetric(env, row.link_user_id ? 'link_discord' : 'auth_discord');
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
    const result = await finish(env, row, profile, deps);
    await env.DB.prepare('DELETE FROM auth_requests WHERE id = ?').bind(row.id).run();
    return Response.redirect(`${row.return_to}#ht_auth=${encodeURIComponent(result.token)}`, 302);
  }

  // Device mode: hold the profile until the player confirms the code on their screen.
  const confirmKey = randomId(12);
  await env.DB.prepare("UPDATE auth_requests SET status = 'confirm', profile_json = ? WHERE id = ?")
    .bind(JSON.stringify({ ...profile, confirmKey }), row.id).run();
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
  delete profile.confirmKey;
  const result = await finish(env, row, profile, deps);
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

/** The small page the browser shows during a Discord sign-in. */
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
