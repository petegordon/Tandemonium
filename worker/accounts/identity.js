// ============================================================
// IDENTITY — one account, several sign-ins (#612)
// ============================================================
//
// A House Tandem account (a `users` row) can have several sign-ins linked to
// it in `user_logins`: Discord, Steam, and the legacy Google. They are
// joined by provider id, never by email.
//
// #783 · a session is a LOGIN (the token's `lid`), and its account is whatever
// account that login belongs to now (resolveSession). Every record a game writes
// carries both ids, so combining accounts and separating them again is exact
// (combine.js). A guest device is a login too (provider 'device').
//
// Discord sign-in has two modes:
//   - redirect: the web game on the same device. The browser goes to Discord
//     and comes back to the game with the session in the URL fragment.
//   - device: the sign-in finishes somewhere else (a phone scanning the TV's
//     QR, or the system browser opened by the Steam build). The game polls
//     with a secret only it holds. The player types the code the screen shows
//     before the session is handed over, so a shared link can't sign someone
//     else into a stranger's game (they would have to read that screen).
//
// Signed in already, either mode adds the sign-in to the account instead. See
// "Linking and combining" below for the rules (#612).
//
// This lives in the Tandemonium worker for now. The House Tandem service
// (auth.housetandem.com, UsersFirst/housetandem-web#21) takes it over later;
// the tables and routes are shaped so they can move as they are.

import { combineAccounts, separateAccount, splitLogin, absorbLogin } from './combine.js';
import { originListed } from './origins.js';
import { ensurePublicId } from './public-id.js';

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
  // A guest key ('h_' + 22, worker/room-proof.js) is made from a device id by the server; it is
  // never a device id itself, so one sent in a device id's place is ignored.
  return typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(v) && !/^h_[A-Za-z0-9_-]{22}$/.test(v) ? v : null;
}

/** What a begin call stored on the request (profile_json holds only this until the callback). */
function beginInfo(row) {
  try { return JSON.parse(row.profile_json || '{}') || {}; } catch { return {}; }
}
/** The device id a begin call stored on the request. */
function requestDeviceId(row) {
  return cleanDeviceId(beginInfo(row).deviceId);
}
/**
 * The extra Discord permissions a sign-in may ask for (the website's Join checklist,
 * each one a switch under "Permissions"). identify is always asked for.
 *   guilds.join  add the player to the House Tandem server
 *   email        Discord's verified email, for new game news
 *   connections  the accounts linked to Discord: a verified Steam account is linked here too
 */
export const OPTIONAL_SCOPES = ['guilds.join', 'email', 'connections'];
export function cleanScopes(list) {
  return Array.isArray(list) ? OPTIONAL_SCOPES.filter((s) => list.includes(s)) : [];
}
function requestScopes(env, row) {
  const info = beginInfo(row);
  const scopes = cleanScopes(info.scopes);
  if (info.joinServer && !scopes.includes('guilds.join')) scopes.push('guilds.join');
  // No bot in the server: nothing could add the player, so don't ask.
  return scopes.filter((s) => s !== 'guilds.join' || (env.DISCORD_BOT_TOKEN && env.DISCORD_GUILD_ID));
}
/** Did the sign-in ask to join the House Tandem server too? */
function wantsServerJoin(env, row) {
  return requestScopes(env, row).includes('guilds.join');
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
    "SELECT provider, provider_id, display_name, avatar_url, last_login_at, linked_at FROM user_logins WHERE user_id = ? AND provider != 'device' ORDER BY linked_at"
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

/** The account a sign-in belongs to (or null). */
async function identityOwner(env, provider, providerId, name = null, avatar = null) {
  providerId = String(providerId);
  const existing = await env.DB.prepare(
    'SELECT user_id FROM user_logins WHERE provider = ? AND provider_id = ?'
  ).bind(provider, providerId).first();
  return existing ? existing.user_id : null;
}

/** A sign-in's row: { login_id, user_id } or null. */
export async function loginRow(env, provider, providerId) {
  return env.DB.prepare('SELECT login_id, user_id FROM user_logins WHERE provider = ? AND provider_id = ?')
    .bind(provider, String(providerId)).first();
}

/** An account's first real sign-in (not a guest device): where records go when a session names none. */
export async function firstLogin(env, userId) {
  const row = await env.DB.prepare("SELECT login_id FROM user_logins WHERE user_id = ? AND provider != 'device' ORDER BY login_id LIMIT 1")
    .bind(userId).first();
  return row ? row.login_id : null;
}

/**
 * #783 · who a verified session token is, now: its login (the token's `lid`) and the
 * account that login belongs to today. So a session follows its login through a combine or a separate. A token with
 * neither is its account's first sign-in. → the claims with `sub` and `lid` set, or null
 * when the login and the account are both gone.
 */
export async function resolveSession(env, claims) {
  if (!claims) return null;
  // SELECT *: token_version arrives with migration 0022, and this runs before or after it.
  let login = null;
  if (Number.isInteger(claims.lid)) {
    // A token that names a login is that login or nothing: login ids are never reused.
    login = await env.DB.prepare('SELECT * FROM user_logins WHERE login_id = ?').bind(claims.lid).first();
    if (!login) return null;
  }
  if (!login && claims.sub != null) {
    login = await env.DB.prepare("SELECT * FROM user_logins WHERE user_id = ? AND provider != 'device' ORDER BY login_id LIMIT 1")
      .bind(claims.sub).first();
  }
  if (login) {
    if (!sessionCurrent(claims, login)) return null;
    return { ...claims, sub: login.user_id, lid: login.login_id };
  }
  if (claims.sub == null) return null;
  // An account with no sign-in row at all (none are expected): still that account.
  const user = await env.DB.prepare('SELECT 1 AS x FROM users WHERE id = ?').bind(claims.sub).first();
  return user ? { ...claims, lid: null } : null;
}

/** Has this login's sessions been ended since the token was made? A token with no `tv` is version 0. */
function sessionCurrent(claims, login) {
  const have = Number.isInteger(claims.tv) ? claims.tv : 0;
  return have >= (Number(login.token_version) || 0);
}

/**
 * End every session of an account (and of `alsoLogins`, which just left it): each login's
 * version goes up, so older tokens stop resolving, and hand-off codes already made are
 * dropped. The version is kept per login because a session follows its login through a
 * combine or a separate. → false when migration 0022 is not applied yet.
 */
export async function revokeSessions(env, userId, alsoLogins = []) {
  const ids = alsoLogins.filter(Number.isInteger);
  const where = ids.length ? `user_id = ? OR login_id IN (${ids.map(() => '?').join(',')})` : 'user_id = ?';
  try {
    await env.DB.batch([
      env.DB.prepare(`UPDATE user_logins SET token_version = COALESCE(token_version, 0) + 1 WHERE ${where}`).bind(userId, ...ids),
      env.DB.prepare("DELETE FROM auth_requests WHERE provider = 'handoff' AND link_user_id = ?").bind(userId),
    ]);
    return true;
  } catch (e) {
    if (/no such column/i.test(String(e && e.message))) return false;
    throw e;
  }
}

/**
 * Find or create the account for a sign-in. Returns { userId }.
 *
 * Adding a sign-in to an account someone is already signed in to is not done
 * here: see addLogin (a sign-in with no account joins) and combineInto (one
 * with its own account, after the player confirmed both). #612: nothing
 * merges accounts as a side effect of signing in.
 */
export async function upsertIdentity(env, { provider, providerId, name, avatar }, linkUserId = null) {
  if (linkUserId) throw new Error('upsertIdentity no longer links: use addLogin');
  providerId = String(providerId);
  const ownerId = await identityOwner(env, provider, providerId, name, avatar);
  const existing = ownerId ? { user_id: ownerId } : null;

  let userId;
  if (existing) {
    userId = existing.user_id;
    await env.DB.prepare('UPDATE users SET display_name = ?, avatar_url = ? WHERE id = ?')
      .bind(name, avatar, userId).run();
  } else {
    // (users.provider / provider_id are legacy columns: a unique filler now, never read.)
    const filler = crypto.randomUUID();
    const ins = await env.DB.prepare(
      'INSERT INTO users (provider, provider_id, display_name, avatar_url) VALUES (?, ?, ?, ?)'
    ).bind('account', filler, name, avatar).run();
    userId = ins.meta && ins.meta.last_row_id;
    if (!userId) {
      const row = await env.DB.prepare('SELECT id FROM users WHERE provider = ? AND provider_id = ?')
        .bind('account', filler).first();
      userId = row.id;
    }
    await env.DB.prepare(
      'INSERT OR IGNORE INTO user_logins (user_id, provider, provider_id, display_name, avatar_url) VALUES (?, ?, ?, ?, ?)'
    ).bind(userId, provider, providerId, name, avatar).run();
  }

  await env.DB.prepare(
    "UPDATE user_logins SET display_name = ?, avatar_url = ?, last_login_at = datetime('now') WHERE provider = ? AND provider_id = ?"
  ).bind(name, avatar, provider, providerId).run();
  const login = await loginRow(env, provider, providerId);
  return { userId, loginId: login ? login.login_id : null };
}

// ------------------------------------------------------------
// Linking and combining (#612)
// ------------------------------------------------------------
//
// A sign-in is added to an account only when the player has proved both:
//   1. the account: a sign-in to it within LINK_FRESH_S, checked when the link begins;
//   2. the new sign-in: they just completed it at Discord or Steam;
// and the link is completed by the same browser that began it (the request's
// secret and the account's session), never by whoever opens the provider's page.
// A sign-in that already has its own account is combined only after the player
// saw both accounts and said yes. Every link and combine is an account event:
// the account's Discord gets a message, the game and the website show a notice,
// and it can be undone for UNDO_DAYS.

const LINK_FRESH_S = 600;
// Opening another House Tandem site signed in: a longer window than a link, since a
// session that is too old only means the other site asks the player to sign in.
const HANDOFF_FRESH_S = 3600;
// However a session is passed on, it ends this long after the real sign-in behind it.
const SESSION_MAX_S = 30 * 86400;
const UNDO_DAYS = 7;
const PROVIDER_NAMES = { discord: 'Discord', steam: 'Steam', google: 'Google' };

/** The session's claims, or null. */
async function sessionClaims(request, env, deps) {
  if (deps.claimsFromRequest) return deps.claimsFromRequest(request, env);
  const sub = await deps.getUserFromRequest(request, env);
  return sub ? { sub } : null;
}

/**
 * Was this session made by a real sign-in within `within` seconds? `auth_time` is set only
 * by a provider sign-in and carried through hand-offs, links and combines. A token without
 * it (from before it existed) works but is never fresh, and neither is one issued by device
 * code: whoever began a device sign-in is not proven to be whoever approved it.
 */
export function freshEnough(claims, within = LINK_FRESH_S) {
  return !!(claims && !claims.dev && Number.isInteger(claims.auth_time) && claims.auth_time >= nowS() - within);
}
export function needFreshSignIn(deps, corsOrigin, doing = 'linking another account') {
  return deps.jsonResponse({
    error: `For your safety, sign in again before ${doing}.`,
    code: 'fresh_signin',
  }, 401, corsOrigin);
}

/** What a new token keeps from the session it continues. */
function basisOf(claims) {
  return { authTime: claims.auth_time, dev: claims.dev ? 1 : 0, exp: claims.exp };
}
/** The claims a provider sign-in puts on its session: when it happened, and the login's version. */
export async function realSignInClaims(env, loginId) {
  const row = loginId == null ? null : await env.DB.prepare('SELECT * FROM user_logins WHERE login_id = ?').bind(loginId).first();
  return { auth_time: nowS(), ...(row && row.token_version ? { tv: row.token_version } : {}) };
}

/**
 * A session for an account, and what the game and the website show about it.
 * `basis`: { authTime, dev, exp } of the sign-in or session this continues. A continued
 * session keeps its auth_time and never ends later than the one it came from.
 */
export async function sessionFor(env, userId, deps, login = null, basis = null) {
  const user = await env.DB.prepare('SELECT id, display_name, avatar_url FROM users WHERE id = ?').bind(userId).first();
  const identities = await listIdentities(env, userId);
  const claims = { sub: userId, name: user.display_name, picture: user.avatar_url };
  // `login`: a login id, or 'provider:id'. None given: the account's first sign-in.
  let row = null;
  if (Number.isInteger(login)) {
    row = await env.DB.prepare('SELECT * FROM user_logins WHERE login_id = ? AND user_id = ?').bind(login, userId).first();
  } else if (typeof login === 'string' && login.includes(':')) {
    const i = login.indexOf(':');
    row = await env.DB.prepare('SELECT * FROM user_logins WHERE provider = ? AND provider_id = ? AND user_id = ?')
      .bind(login.slice(0, i), login.slice(i + 1), userId).first();
  }
  if (!row) {
    row = await env.DB.prepare("SELECT * FROM user_logins WHERE user_id = ? AND provider != 'device' ORDER BY login_id LIMIT 1")
      .bind(userId).first();
  }
  if (row) {
    claims.lid = row.login_id;
    claims.via = row.provider + ':' + row.provider_id;
    if (row.token_version) claims.tv = row.token_version;
  }
  const b = basis || {};
  const now = nowS();
  if (Number.isInteger(b.authTime)) claims.auth_time = b.authTime;
  if (b.dev) claims.dev = 1;
  const ends = [now + SESSION_MAX_S];
  if (Number.isInteger(b.authTime)) ends.push(b.authTime + SESSION_MAX_S);
  if (Number.isFinite(b.exp)) ends.push(b.exp);
  const token = await deps.createJWT(claims, env.JWT_SECRET, Math.max(Math.min(...ends) - now, 1));
  // pid: the player's own public id, which is what boards show for them.
  return { token, user: { id: userId, pid: await ensurePublicId(env, userId), name: user.display_name, avatar: user.avatar_url, identities } };
}

/** What the combine screen shows about an account. */
export async function accountSummary(env, userId) {
  const u = await env.DB.prepare('SELECT id, display_name, avatar_url FROM users WHERE id = ?').bind(userId).first();
  if (!u) return null;
  const n = async (sql) => ((await env.DB.prepare(sql).bind(userId).first()) || {}).n || 0;
  const logins = Object.entries(await listIdentities(env, userId)).map(([provider, v]) => ({ provider, name: v.name, avatar: v.avatar }));
  // A combine moves everything in every House Tandem game, so the summary names the other games too.
  const games = new Map();
  const rows = async (sql) => {
    try { return (await env.DB.prepare(sql).bind(userId).all()).results || []; } catch { return []; }
  };
  for (const r of await rows('SELECT game, COUNT(DISTINCT achievement_id) AS n FROM game_achievements WHERE user_id = ? GROUP BY game')) {
    games.set(r.game, Number(r.n) || 0);
  }
  for (const r of await rows('SELECT DISTINCT game FROM game_stats WHERE user_id = ?')) if (!games.has(r.game)) games.set(r.game, 0);
  for (const r of await rows('SELECT game FROM game_playtime WHERE user_id = ? AND seconds > 0')) if (!games.has(r.game)) games.set(r.game, 0);
  games.delete('tandemonium');
  return {
    name: u.display_name, avatar: u.avatar_url, logins,
    rides: await n('SELECT COUNT(*) AS n FROM scores WHERE user_id = ?'),
    badges: await n('SELECT COUNT(DISTINCT achievement_id) AS n FROM user_achievements WHERE user_id = ?'),
    games: [...games].map(([game, badges]) => ({ game, title: GAME_TITLES[game] || game, badges })),
  };
}

const GAME_TITLES = Object.freeze({
  dice: '7, 11, Doubles', coins: 'Carnival Dozer', roulette: 'Roulette', wheel: 'Carnival Wheel',
  timber: 'Timber Tandem', sandhands: 'SandHands',
});

function untilText(s) {
  return new Date(s * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}
function accountUrl(env) {
  return env.ACCOUNT_URL || 'https://housetandem.com/account.html';
}

/**
 * Tell the account's Discord (every Discord on it) by direct message from the
 * House Tandem bot. Discord only lets a bot message someone who shares a server
 * with it; the sign-in joins most players to it. Never fails the link.
 */
export async function notifyAccountDiscord(env, userId, content, deps = {}) {
  if (!env.DISCORD_BOT_TOKEN) return 0;
  const fetchImpl = deps.fetchImpl || fetch;
  let sent = 0;
  try {
    const rows = (await env.DB.prepare("SELECT provider_id FROM user_logins WHERE user_id = ? AND provider = 'discord'")
      .bind(userId).all()).results || [];
    for (const r of rows) {
      try {
        const headers = { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' };
        const ch = await fetchImpl(`${DISCORD_API}/v10/users/@me/channels`, {
          method: 'POST', headers, body: JSON.stringify({ recipient_id: String(r.provider_id) }), signal: AbortSignal.timeout(5000),
        });
        if (!ch.ok) continue;
        const { id } = await ch.json();
        const msg = await fetchImpl(`${DISCORD_API}/v10/channels/${id}/messages`, {
          method: 'POST', headers, body: JSON.stringify({ content, allowed_mentions: { parse: [] } }), signal: AbortSignal.timeout(5000),
        });
        if (msg.ok) sent++;
      } catch {}
    }
  } catch (e) { console.error('account notice DM failed', e); }
  deps.writeMetric && deps.writeMetric(env, sent ? 'account_notice_dm' : 'account_notice_dm_none');
  return sent;
}

/**
 * The statement that records a link or combine (its notice, and what an undo needs). It
 * goes in the same batch as the change itself, so one is never written without the other.
 */
function eventInsert(env, ev, at = nowS()) {
  return env.DB.prepare(
    `INSERT INTO account_events (user_id, kind, provider, provider_id, login_name, from_user_id, from_name, moved_json, created_at, undo_until)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(ev.userId, ev.kind, ev.provider || null, ev.providerId ? String(ev.providerId) : null, ev.loginName || null,
         ev.fromUserId || null, ev.fromName || null, ev.moved ? JSON.stringify(ev.moved) : null, at, at + UNDO_DAYS * 86400);
}

/** Tell the account's Discord about a link or combine that was just recorded. */
async function announceEvent(env, ev, deps, at = nowS()) {
  const until = at + UNDO_DAYS * 86400;
  const account = await env.DB.prepare('SELECT display_name FROM users WHERE id = ?').bind(ev.userId).first();
  const accountName = (account && account.display_name) || 'your account';
  const what = PROVIDER_NAMES[ev.provider] || 'A sign-in';
  const content = ev.kind === 'combine'
    ? `House Tandem: the ${what} account "${ev.fromName || ev.loginName || ''}" was combined into "${accountName}". Not you, or didn't mean to? You can separate them until ${untilText(until)}: ${accountUrl(env)}`
    : `House Tandem: ${what} account "${ev.loginName || ''}" was added to your House Tandem account "${accountName}". Not you? You can remove it until ${untilText(until)}: ${accountUrl(env)}`;
  await notifyAccountDiscord(env, ev.userId, content, deps);
}

/**
 * Add a sign-in to account `userId` when it has no account of its own.
 * → { status: 'linked' | 'already' | 'combine', otherId? }
 */
export async function addLogin(env, userId, profile, deps = {}) {
  const { provider, name, avatar } = profile;
  const providerId = String(profile.providerId);
  const owner = await identityOwner(env, provider, providerId, name, avatar);
  if (owner && owner !== userId) return { status: 'combine', otherId: owner };
  const ev = { userId, kind: 'link', provider, providerId, loginName: name };
  const at = nowS();
  const seen = env.DB.prepare(
    "UPDATE user_logins SET display_name = ?, avatar_url = ?, last_login_at = datetime('now') WHERE provider = ? AND provider_id = ?"
  ).bind(name, avatar, provider, providerId);
  if (owner) {
    await seen.run();
  } else {
    // The new sign-in and its undo record are written together or not at all.
    await env.DB.batch([
      env.DB.prepare('INSERT INTO user_logins (user_id, provider, provider_id, display_name, avatar_url) VALUES (?, ?, ?, ?, ?)')
        .bind(userId, provider, providerId, name, avatar),
      seen,
      eventInsert(env, ev, at),
    ]);
  }
  const login = await loginRow(env, provider, providerId);
  const loginId = login ? login.login_id : null;
  if (owner) return { status: 'already', loginId };
  await announceEvent(env, ev, deps, at);
  deps.writeMetric && deps.writeMetric(env, 'link_' + provider);
  return { status: 'linked', loginId };
}

/** The player confirmed: fold the sign-in's own account into `userId`. */
async function combineInto(env, userId, profile, deps) {
  const otherId = await identityOwner(env, profile.provider, profile.providerId);
  if (!otherId || otherId === userId) return addLogin(env, userId, profile, deps);
  const other = await env.DB.prepare('SELECT display_name FROM users WHERE id = ?').bind(otherId).first();
  const ev = {
    userId, kind: 'combine', provider: profile.provider, providerId: profile.providerId, loginName: profile.name,
    fromUserId: otherId, fromName: other && other.display_name,
  };
  const at = nowS();
  // With the combine, in its batch: the sign-in's latest name and the undo record. A combine
  // whose undo record cannot be written does not happen.
  const withIt = (moved) => [
    env.DB.prepare(
      "UPDATE user_logins SET display_name = ?, avatar_url = ?, last_login_at = datetime('now') WHERE provider = ? AND provider_id = ?"
    ).bind(profile.name, profile.avatar, profile.provider, String(profile.providerId)),
    eventInsert(env, { ...ev, moved }, at),
  ];
  const moved = await combineAccounts(env, otherId, userId, withIt);
  if (!moved) await env.DB.batch(withIt(null));   // the other account's row is gone: nothing to move
  await announceEvent(env, ev, deps, at);
  deps.writeMetric && deps.writeMetric(env, 'combine_' + profile.provider);
  return { status: 'combined' };
}

/** A return URL is only followed back to a site the API already serves. */
export function allowedReturnTo(returnTo, corsSetting, pickCorsOrigin) {
  if (!returnTo || typeof returnTo !== 'string' || returnTo.length > 1000) return null;
  let u;
  try { u = new URL(returnTo); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  // Only a site on this API's own list (local addresses only where the list names them).
  if (!originListed(u.origin, corsSetting)) return null;
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
 * Discord's consent screen for this request. With join_server it also asks for
 * guilds.join, so the callback can add the player to the House Tandem server.
 */
function discordAuthorizeUrl(env, url, row) {
  const auth = new URL('https://discord.com/oauth2/authorize');
  auth.searchParams.set('client_id', env.DISCORD_CLIENT_ID);
  auth.searchParams.set('response_type', 'code');
  auth.searchParams.set('redirect_uri', redirectUri(env, url));
  auth.searchParams.set('scope', ['identify', ...requestScopes(env, row)].join(' '));
  auth.searchParams.set('state', row.id);
  return auth.toString();
}

/**
 * POST /auth/discord/begin  { mode: 'redirect'|'device', return_to?, device_id?, scopes?, join_server? }
 * scopes: any of OPTIONAL_SCOPES (join_server: true is the same as 'guilds.join').
 * With a Bearer token the sign-in is linked to that account.
 * → { id, secret, url, authorize_url, code, expires_in }
 *
 * authorize_url is Discord's own address. The website puts it straight on the
 * button: a tap on a discord.com link can open the Discord app on a phone
 * (already signed in there), where a redirect through this worker cannot.
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
  // Signed in: this links a Discord to the account, which needs a recent sign-in to it.
  const claims = await sessionClaims(request, env, deps);
  const linkUserId = claims ? claims.sub : null;
  if (linkUserId && !freshEnough(claims)) return needFreshSignIn(deps, corsOrigin);
  // A login is added in a browser, never by a code approved on another device.
  if (linkUserId && mode === 'device') return linkNeedsBrowser(deps, corsOrigin);
  // A redirect sign-in is bound to the browser that began it.
  const nonceHash = cleanNonceHash(body.nonce_hash);
  if (mode === 'redirect' && !linkUserId && !nonceHash) return updateRequired(deps, corsOrigin);

  const deviceId = cleanDeviceId(body.device_id);
  const info = {};
  if (deviceId) info.deviceId = deviceId;
  if (nonceHash) info.nonceHash = nonceHash;
  if (body.join_server === true) info.joinServer = true;
  // An explicit list is the player's decision, an empty one included (it clears the stored email).
  if (Array.isArray(body.scopes)) info.scopes = cleanScopes(body.scopes);
  if (linkUserId) info.basis = basisOf(claims);
  if (mode === 'device') info.asker = requestingDevice(request);

  const id = randomId(12);
  const secret = randomId(24);
  const code = mode === 'device' ? randomCode(4) : null;
  await env.DB.prepare('DELETE FROM auth_requests WHERE created_at < ?').bind(nowS() - 3600).run();
  await env.DB.prepare(
    `INSERT INTO auth_requests (id, secret_hash, provider, mode, user_code, link_user_id, link_login_id, return_to, status, profile_json, created_at)
     VALUES (?, ?, 'discord', ?, ?, ?, ?, ?, 'pending', ?, ?)`
  ).bind(id, await sha256(secret), mode, code, linkUserId || null, linkUserId ? (claims.lid ?? null) : null, returnTo,
         Object.keys(info).length ? JSON.stringify(info) : null, nowS()).run();

  return deps.jsonResponse({
    id, secret, code, expires_in: REQUEST_TTL_S,
    url: `${url.origin}/auth/discord/go?r=${encodeURIComponent(id)}`,
    authorize_url: discordAuthorizeUrl(env, url, { id, profile_json: JSON.stringify(info) }),
  }, 200, corsOrigin);
}

/** The hash of the value a browser keeps for its sign-in (base64url SHA-256), or null. */
function cleanNonceHash(v) {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{43}$/.test(v) ? v : null;
}
function updateRequired(deps, corsOrigin) {
  return deps.jsonResponse({ error: 'Reload this page, then sign in again.', code: 'update_required' }, 400, corsOrigin);
}
function linkNeedsBrowser(deps, corsOrigin) {
  return deps.jsonResponse({ error: 'Add this sign-in from your account page in a browser.', code: 'link_needs_browser' }, 403, corsOrigin);
}

/**
 * What the approval page says about the screen that asked: a kind of device from a fixed
 * list (the header is the requester's to write, so none of it is shown as sent) and
 * Cloudflare's idea of where it is.
 */
function requestingDevice(request) {
  const ua = String(request.headers.get('User-Agent') || '');
  const kind = /Valve Steam|SteamDeck|Electron/i.test(ua) ? 'the Steam game'
    : /SMART-TV|SmartTV|Tizen|Web0S|BRAVIA|AFT[A-Z]|Android TV|CrKey/i.test(ua) ? 'a TV'
    : /iPhone/i.test(ua) ? 'an iPhone'
    : /iPad/i.test(ua) ? 'an iPad'
    : /Android/i.test(ua) ? 'an Android device'
    : /Windows/i.test(ua) ? 'a Windows computer'
    : /Macintosh/i.test(ua) ? 'a Mac'
    : /Linux|CrOS/i.test(ua) ? 'a Linux computer'
    : 'an unknown device';
  const cf = request.cf || {};
  const place = [cf.city, cf.country].filter((s) => typeof s === 'string' && s).join(', ').slice(0, 80);
  return { kind, place };
}

async function liveRequest(env, id) {
  if (!id) return null;
  const row = await env.DB.prepare('SELECT * FROM auth_requests WHERE id = ?').bind(id).first();
  if (!row || row.created_at < nowS() - REQUEST_TTL_S) return null;
  return row;
}

/** A live request that a Discord endpoint may act on. */
async function liveDiscordRequest(env, id) {
  const row = await liveRequest(env, id);
  return row && row.provider === 'discord' ? row : null;
}

/** GET /auth/discord/go?r=<id> → Discord's consent screen. Short, so it fits a QR. */
export async function handleDiscordGo(request, env, url) {
  const row = await liveDiscordRequest(env, url.searchParams.get('r'));
  if (!row || row.status !== 'pending') return page('This sign-in link has expired', '<p>Go back to the game and choose <b>Sign in with Discord</b> again.</p>', 410);
  return Response.redirect(discordAuthorizeUrl(env, url, row), 302);
}

async function fetchDiscordUser(env, url, code, scopes = []) {
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
  // What the player actually granted (they can't untick on Discord's screen, but trust the answer, not the ask).
  const granted = String(tok.scope || '').split(' ').filter(Boolean);
  const has = (s) => scopes.includes(s) && (!granted.length || granted.includes(s));
  let steamId = null;
  if (has('connections')) {
    try {
      const cRes = await fetch(`${DISCORD_API}/users/@me/connections`, {
        headers: { Authorization: `Bearer ${tok.access_token}` },
        signal: AbortSignal.timeout(6000),
      });
      const conns = cRes.ok ? await cRes.json() : [];
      // Only a Steam account Discord has verified (it checked ownership with Steam).
      const steam = (Array.isArray(conns) ? conns : []).find((c) => c && c.type === 'steam' && c.verified && /^\d{17}$/.test(String(c.id)));
      if (steam) steamId = String(steam.id);
    } catch {}
  }
  return {
    accessToken: tok.access_token,
    scopes: ['identify', ...scopes.filter(has)],
    email: has('email') && me.email && me.verified ? String(me.email).slice(0, 254) : null,
    steamId,
    profile: {
      provider: 'discord',
      providerId: me.id,
      name: me.global_name || me.username || 'Discord player',
      avatar: discordAvatarUrl(me),
    },
  };
}

/**
 * Add the player to the House Tandem server with the guilds.join grant they
 * just gave. → 'added' | 'already' | 'failed'. Never fails the sign-in.
 * The bot needs the Create Invite permission in the server for this.
 */
export async function addToServer(env, discordUserId, accessToken, deps = {}) {
  const fetchImpl = deps.fetchImpl || fetch;
  let outcome = 'failed';
  try {
    const res = await fetchImpl(`${DISCORD_API}/v10/guilds/${env.DISCORD_GUILD_ID}/members/${discordUserId}`, {
      method: 'PUT',
      headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ access_token: accessToken }),
      signal: AbortSignal.timeout(6000),
    });
    if (res.status === 201) outcome = 'added';
    else if (res.status === 204) outcome = 'already';
    else console.error('House Tandem server join failed', res.status, await res.text().catch(() => ''));
  } catch (e) {
    console.error('House Tandem server join failed', e);
  }
  deps.writeMetric && deps.writeMetric(env, 'discord_join_' + outcome);
  return outcome;
}

/**
 * #678 · fold this device's guest pairs into the account it just signed in to.
 * A pair row is a nicety: a failure here never fails the sign-in.
 */
export async function claimGuestPairs(env, deviceId, userId, deps) {
  if (!deviceId || !userId || !deps || !deps.deviceKeys) return;
  try {
    // #783 · the guest is a device login with a small account of its own: it joins this
    // account, with what was recorded under it. Its key is then retired, so the next guest
    // on this device starts a new record (for whoever signs in next).
    for (const key of await deps.deviceKeys(env, deviceId)) {
      const login = await loginRow(env, 'device', key);
      if (!login || login.user_id === userId) continue;
      const real = await env.DB.prepare("SELECT 1 AS x FROM user_logins WHERE user_id = ? AND provider != 'device' LIMIT 1").bind(login.user_id).first();
      if (real) continue;   // already someone's
      await absorbLogin(env, login.login_id, userId);
      await env.DB.prepare('UPDATE user_logins SET provider_id = ? WHERE login_id = ?').bind(key + ':claimed:' + login.login_id, login.login_id).run();
    }
  } catch (e) {
    console.error('guest claim failed', e);
  }
}

/**
 * The website's Join checklist, after a Discord sign-in: record what was granted, keep the
 * verified email only while email is granted, and add the Steam account Discord verified
 * (Discord checked it with Steam). Only a Steam with no account of its own is added: one
 * with its own rides is combined only on the combine screen (#612).
 * Never fails the sign-in. → 'linked' | 'already' | 'combine' | null
 */
async function applyDiscordExtras(env, userId, profile, extras, deps) {
  try {
    await env.DB.prepare('UPDATE user_logins SET scopes = ?, email = ? WHERE provider = ? AND provider_id = ?')
      .bind(extras.scopes.join(' '), extras.email || null, 'discord', String(profile.providerId)).run();
  } catch (e) { console.error('saving Discord permissions failed', e); }
  if (!extras.steamId) return null;
  try {
    const mine = await env.DB.prepare("SELECT 1 FROM user_logins WHERE user_id = ? AND provider = 'steam' AND provider_id = ?")
      .bind(userId, extras.steamId).first();
    if (mine) return 'already';
    const steam = await fetchSteamProfile(env, extras.steamId, deps.fetchImpl || fetch);
    const { status } = await addLogin(env, userId, steam, deps);
    if (status === 'linked') deps.writeMetric && deps.writeMetric(env, 'link_steam_via_discord');
    return status;
  } catch (e) {
    console.error('Steam link from Discord connections failed', e);
    return null;
  }
}

/**
 * A plain sign-in (no link): find or make the account, and its session.
 * `viaDevice`: approved on another device, so the session is marked (see freshEnough).
 */
async function finish(env, row, profile, deps, deviceId = null, extras = null, viaDevice = false) {
  const { userId } = await upsertIdentity(env, profile);
  await claimGuestPairs(env, deviceId, userId, deps);
  const steamLink = extras ? await applyDiscordExtras(env, userId, profile, extras, deps) : null;
  const result = await sessionFor(env, userId, deps, `${profile.provider}:${profile.providerId}`,
    { authTime: nowS(), dev: viaDevice ? 1 : 0 });
  if (steamLink === 'combine') result.steam_has_account = true;
  const p = profile.provider || 'discord';
  deps.writeMetric && deps.writeMetric(env, 'auth_' + p + (p === 'steam' ? '_web' : ''));
  return result;
}

/**
 * A link's provider sign-in is done: hold the verified profile on the request
 * and send the browser back with a one-time code. Only the tab that began the
 * link (its secret + the account's session) can use it: POST /auth/link/complete.
 */
async function holdLink(env, row, profile, extras, server = null) {
  const code = randomId(18);
  const held = { profile, codeHash: await sha256(code), deviceId: requestDeviceId(row) };
  if (extras) held.extras = { scopes: extras.scopes, email: extras.email, steamId: extras.steamId };
  if (server) held.server = server;
  await env.DB.prepare("UPDATE auth_requests SET status = 'verified', profile_json = ? WHERE id = ?")
    .bind(JSON.stringify(held), row.id).run();
  return `${row.return_to}#ht_link=${encodeURIComponent(row.id + '.' + code)}`;
}

const EXCHANGE_TTL_S = 120;

/**
 * A redirect sign-in whose browser kept a value (begin's nonce_hash): the session is not put
 * in the address. The browser comes back with a short single-use code, and POST /auth/exchange
 * gives the session only to the holder of both the code and the value. Nothing about the
 * account changes until then: a sign-in page opened from someone else's link does nothing.
 */
async function holdSignIn(env, row, profile, extras = null, server = null) {
  const code = randomId(24);
  const held = {
    profile, deviceId: requestDeviceId(row), nonceHash: beginInfo(row).nonceHash, at: nowS(), server: server || null,
    extras: extras ? { scopes: extras.scopes, email: extras.email, steamId: extras.steamId } : null,
  };
  await env.DB.prepare("UPDATE auth_requests SET status = 'exchange', secret_hash = ?, profile_json = ? WHERE id = ?")
    .bind(await sha256(code), JSON.stringify(held), row.id).run();
  return `${row.return_to}#ht_result=${encodeURIComponent(row.id + '.' + code)}`;
}

/**
 * POST /auth/exchange { id, code, nonce } → { token, user, server?, steam? }
 * The row is removed by the same statement that reads it, so a code works once. A code with
 * the wrong value is used up and refused.
 */
export async function handleAuthExchange(request, env, corsOrigin, deps) {
  let body = {};
  try { body = await request.json(); } catch {}
  const gone = () => deps.jsonResponse({ error: 'This sign-in has expired. Start it again.', code: 'signin_gone' }, 410, corsOrigin);
  if (typeof body.id !== 'string' || typeof body.code !== 'string' || typeof body.nonce !== 'string') return gone();
  if (body.code.length > 128 || body.nonce.length > 128) return gone();
  const taken = await env.DB.prepare("DELETE FROM auth_requests WHERE id = ? AND status = 'exchange' AND secret_hash = ? RETURNING *")
    .bind(body.id, await sha256(body.code)).all();
  const row = taken.results && taken.results[0];
  if (!row) return gone();
  let held = null;
  try { held = JSON.parse(row.profile_json); } catch {}
  if (!held || !held.nonceHash || held.at < nowS() - EXCHANGE_TTL_S) return gone();
  if ((await sha256(body.nonce)) !== held.nonceHash) {
    deps.writeMetric && deps.writeMetric(env, 'auth_exchange_mismatch');
    return deps.jsonResponse({ error: 'This sign-in was started in another browser or tab. Start it again here.', code: 'signin_mismatch' }, 403, corsOrigin);
  }
  const { steam_has_account: hasSteam, ...result } = await finish(env, row, held.profile, deps, cleanDeviceId(held.deviceId), held.extras);
  return deps.jsonResponse({ ...result, server: held.server || undefined, steam: hasSteam ? 'has_account' : undefined }, 200, corsOrigin);
}

/** A sign-in page failed on our side: say so, and nothing about why (that is in the log). */
export const signInErrorPage = () => page('Something went wrong',
  '<p>Sign-in did not finish, and nothing was changed. Go back and try again.</p><p>If it keeps happening, try again later, or write to <a href="mailto:hello@housetandem.com">hello@housetandem.com</a>.</p>', 500);

const EXPIRED_PAGE = () => page('This sign-in link has expired', '<p>Go back to the game and choose <b>Sign in with Discord</b> again.</p>', 410);

/** GET /auth/discord/callback?code&state — Discord sends the browser back here. */
export async function handleDiscordCallback(request, env, url, deps) {
  const row = await liveDiscordRequest(env, url.searchParams.get('state'));
  if (!row || row.status !== 'pending') return EXPIRED_PAGE();
  if (url.searchParams.get('error')) {
    await env.DB.prepare("UPDATE auth_requests SET status = 'error', result_json = ? WHERE id = ?")
      .bind(JSON.stringify({ error: 'cancelled' }), row.id).run();
    if (row.mode === 'redirect' && row.return_to) return Response.redirect(row.return_to, 302);
    return page('Sign-in cancelled', '<p>Nothing was changed. You can close this tab.</p>');
  }
  let profile, accessToken, extras;
  try {
    const got = await fetchDiscordUser(env, url, url.searchParams.get('code'), requestScopes(env, row));
    ({ profile, accessToken } = got);
    extras = beginInfo(row).scopes || beginInfo(row).joinServer ? got : null;
  } catch (e) {
    console.error('discord sign-in failed', (e && e.message) || e);
    return page('Discord sign-in failed', '<p>Discord did not confirm this sign-in.</p><p>Go back to the game and try again.</p>', 502);
  }
  // The website's checklist: signing in also joins the House Tandem server.
  const joined = wantsServerJoin(env, row) ? await addToServer(env, profile.providerId, accessToken, deps) : null;
  const server = joined ? `&ht_server=${joined}` : '';
  const bound = !!beginInfo(row).nonceHash;   // a current client: hints travel over POST, not in the address

  if (row.mode === 'redirect') {
    if (row.link_user_id) {
      const back = await holdLink(env, row, profile, extras, bound ? joined : null);
      return Response.redirect(bound ? back : back + server, 302);
    }
    // A sign-in is only ever handed to the browser that began it (begin refuses any other).
    if (!bound) return EXPIRED_PAGE();
    return Response.redirect(await holdSignIn(env, row, profile, extras, joined), 302);
  }

  // Device mode: hold the profile until the player types the code their screen shows.
  const confirmKey = randomId(12);
  const { basis, asker } = beginInfo(row);
  await env.DB.prepare("UPDATE auth_requests SET status = 'confirm', profile_json = ? WHERE id = ?")
    .bind(JSON.stringify({ ...profile, confirmKey, deviceId: requestDeviceId(row), tries: 0, basis, asker }), row.id).run();
  return confirmPage(env, row, profile, confirmKey, '', asker);
}

const MAX_CODE_TRIES = 3;

/**
 * The phone's page: type the code the TV shows. Typing it (instead of agreeing
 * with a code printed here) means a link someone sent you can't sign their TV
 * in as you: you would have to read the code off their screen.
 */
async function confirmPage(env, row, profile, confirmKey, error = '', asker = null) {
  // A device code only ever signs a screen in. (A login is added in a browser: handleLinkComplete.)
  const action = 'sign the game in as you';
  const from = asker && asker.kind
    ? `<p class="asker">This request came from <b>${escapeHtml(asker.kind)}</b>${asker.place ? ` near <b>${escapeHtml(asker.place)}</b>` : ''}.</p>`
    : '';
  return page('Type the code on your screen', `
    <div class="who"><img src="${escapeHtml(profile.avatar)}" alt=""><span>${escapeHtml(profile.name)}</span></div>
    ${from}
    <p>Type the 4-letter code your TV or game screen is showing. This will ${action}.</p>
    <p class="warn" role="alert"><b>Whoever is at that screen will be signed in as you.</b> Only continue for a screen in front of you. If someone sent you this link or read you a code, close this page.</p>
    ${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ''}
    <form method="POST" action="/auth/discord/confirm">
      <input type="hidden" name="r" value="${escapeHtml(row.id)}">
      <input type="hidden" name="k" value="${escapeHtml(confirmKey)}">
      <input class="code-input" name="code" inputmode="text" autocomplete="off" autocapitalize="characters" spellcheck="false"
             maxlength="4" minlength="4" required aria-label="Code on your screen" placeholder="····" autofocus>
      <button type="submit" name="ok" value="1">Continue</button>
      <button type="submit" name="ok" value="0" class="ghost" formnovalidate>Cancel</button>
    </form>`);
}

/** POST /auth/discord/confirm (form) — the player typed the code on their screen. */
export async function handleDiscordConfirm(request, env, url, deps) {
  let form;
  try { form = await request.formData(); } catch { return page('Something went wrong', '<p>Try again from the game.</p>', 400); }
  const row = await liveDiscordRequest(env, String(form.get('r') || ''));
  if (!row || row.status !== 'confirm') return EXPIRED_PAGE();
  let held = null;
  try { held = JSON.parse(row.profile_json); } catch {}
  if (!held || held.confirmKey !== String(form.get('k') || '')) return page('Something went wrong', '<p>Try again from the game.</p>', 400);
  const fail = async (error, title, body) => {
    await env.DB.prepare("UPDATE auth_requests SET status = 'error', result_json = ?, profile_json = NULL WHERE id = ?")
      .bind(JSON.stringify({ error }), row.id).run();
    return page(title, body);
  };
  if (String(form.get('ok')) !== '1') {
    return fail('cancelled', 'Cancelled', '<p>Nothing was changed. You can close this tab.</p>');
  }
  // A device code signs a screen in and nothing else: it never adds a login or combines
  // accounts (that is done in a browser), so a request or a form that says otherwise is refused.
  if (row.link_user_id || form.get('step')) return page('Something went wrong', '<p>Try again from the game.</p>', 400);

  const typed = String(form.get('code') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (typed !== row.user_code) {
    const tries = (held.tries || 0) + 1;
    if (tries >= MAX_CODE_TRIES) {
      return fail('cancelled', 'That code didn\'t match', '<p>Nothing was changed. Choose <b>Sign in with Discord</b> in the game again.</p>');
    }
    await env.DB.prepare('UPDATE auth_requests SET profile_json = ? WHERE id = ?').bind(JSON.stringify({ ...held, tries }), row.id).run();
    const profile = { provider: held.provider, providerId: held.providerId, name: held.name, avatar: held.avatar };
    return confirmPage(env, row, profile, held.confirmKey, 'That isn\'t the code on the screen. Check it and try again.', held.asker);
  }

  const deviceId = cleanDeviceId(held.deviceId);
  const profile = { provider: held.provider, providerId: held.providerId, name: held.name, avatar: held.avatar };
  const result = await finish(env, row, profile, deps, deviceId, null, true);
  await env.DB.prepare("UPDATE auth_requests SET status = 'done', result_json = ?, profile_json = NULL WHERE id = ?")
    .bind(JSON.stringify(result), row.id).run();
  return page(`Signed in as ${escapeHtml(result.user.name)}`, '<p>Look back at the game. You can close this tab.</p>');
}

/** The verified link request this browser began: right secret, right account. */
async function heldLinkRequest(request, env, body, deps, wantStatus) {
  const claims = await sessionClaims(request, env, deps);
  const row = await liveRequest(env, typeof body.id === 'string' ? body.id : '');
  if (!row || !row.link_user_id || !claims || claims.sub !== row.link_user_id) return null;
  if (!body.secret || (await sha256(String(body.secret))) !== row.secret_hash) return null;
  if (row.status !== wantStatus) return null;
  let held = null;
  try { held = JSON.parse(row.profile_json); } catch {}
  return held && held.profile ? { row, held, basis: basisOf(claims) } : null;
}

const LINK_GONE = 'This link has expired or was started somewhere else. Start it again from your account.';

/**
 * POST /auth/link/complete { id, code, secret } (signed in to the account that began it)
 * → { status: 'linked', token, user } | { status: 'combine', into, other }
 */
export async function handleLinkComplete(request, env, corsOrigin, deps) {
  let body = {};
  try { body = await request.json(); } catch {}
  const got = await heldLinkRequest(request, env, body, deps, 'verified');
  if (!got || !body.code || (await sha256(String(body.code))) !== got.held.codeHash) {
    return deps.jsonResponse({ error: LINK_GONE, code: 'link_gone' }, 410, corsOrigin);
  }
  const { row, held, basis } = got;
  const userId = row.link_user_id;
  const { status, otherId } = await addLogin(env, userId, held.profile, deps);
  if (status === 'combine') {
    await env.DB.prepare("UPDATE auth_requests SET status = 'combine' WHERE id = ?").bind(row.id).run();
    return deps.jsonResponse({
      status: 'combine', provider: held.profile.provider,
      login: { name: held.profile.name, avatar: held.profile.avatar },
      into: await accountSummary(env, userId), other: await accountSummary(env, otherId),
    }, 200, corsOrigin);
  }
  await env.DB.prepare('DELETE FROM auth_requests WHERE id = ?').bind(row.id).run();
  await claimGuestPairs(env, cleanDeviceId(held.deviceId), userId, deps);
  const steamLink = held.extras ? await applyDiscordExtras(env, userId, held.profile, held.extras, deps) : null;
  const result = await sessionFor(env, userId, deps, row.link_login_id ?? null, basis);
  if (steamLink === 'combine') result.steam_has_account = true;
  if (held.server) result.server = held.server;
  return deps.jsonResponse({ status: 'linked', ...result }, 200, corsOrigin);
}

/**
 * POST /auth/link/combine { id, secret, ok } (signed in to the account that began it)
 * ok: the player saw both accounts and chose to combine. → { status: 'combined', token, user }
 */
export async function handleLinkCombine(request, env, corsOrigin, deps) {
  let body = {};
  try { body = await request.json(); } catch {}
  const got = await heldLinkRequest(request, env, body, deps, 'combine');
  if (!got) return deps.jsonResponse({ error: LINK_GONE, code: 'link_gone' }, 410, corsOrigin);
  const { row, held, basis } = got;
  await env.DB.prepare('DELETE FROM auth_requests WHERE id = ?').bind(row.id).run();
  if (body.ok !== true) return deps.jsonResponse({ status: 'cancelled' }, 200, corsOrigin);
  await combineInto(env, row.link_user_id, held.profile, deps);
  if (held.extras) await applyDiscordExtras(env, row.link_user_id, held.profile, held.extras, deps);
  return deps.jsonResponse({ status: 'combined', ...(await sessionFor(env, row.link_user_id, deps, row.link_login_id ?? null, basis)) }, 200, corsOrigin);
}

// ------------------------------------------------------------
// Notices and undo (#612)
// ------------------------------------------------------------

/** GET /me/notices → { notices: [{ id, kind, provider, login_name, from_name, created_at, undo_until, seen }] } */
export async function handleNotices(request, env, corsOrigin, userId, deps) {
  let rows = [];
  try {
    rows = (await env.DB.prepare(
      `SELECT id, kind, provider, login_name, from_name, created_at, undo_until, seen_at FROM account_events
       WHERE user_id = ? AND undone_at IS NULL AND undo_until > ? ORDER BY created_at DESC LIMIT 20`
    ).bind(userId, nowS()).all()).results || [];
  } catch { rows = []; }   // migration 0020 not applied yet
  return deps.jsonResponse({
    notices: rows.map((r) => ({
      id: r.id, kind: r.kind, provider: r.provider, login_name: r.login_name, from_name: r.from_name,
      created_at: r.created_at, undo_until: r.undo_until, seen: !!r.seen_at,
    })),
  }, 200, corsOrigin);
}

async function readBody(request) {
  try { return await request.json(); } catch { return {}; }
}

/** POST /me/notices/seen { id } — the player read it; it stays undoable on the account page. */
export async function handleNoticeSeen(request, env, corsOrigin, userId, deps) {
  const body = await readBody(request);
  await env.DB.prepare('UPDATE account_events SET seen_at = ? WHERE id = ? AND user_id = ?')
    .bind(nowS(), Number(body.id) || 0, userId).run();
  return deps.jsonResponse({ ok: true }, 200, corsOrigin);
}

/**
 * POST /me/notices/undo { id } — remove a linked sign-in, or separate a combined
 * account, within UNDO_DAYS. → { undone: true, signed_out }
 * signed_out: this session came in through the sign-in that left, so it ends here
 * (the game signs in again; the website asks the player to).
 */
export async function handleNoticeUndo(request, env, corsOrigin, userId, deps) {
  const body = await readBody(request);
  const claims = await sessionClaims(request, env, deps);
  if (!freshEnough(claims)) return needFreshSignIn(deps, corsOrigin, 'undoing this');
  const ev = await env.DB.prepare('SELECT * FROM account_events WHERE id = ? AND user_id = ?').bind(Number(body.id) || 0, userId).first();
  if (!ev || ev.undone_at || ev.undo_until <= nowS()) {
    return deps.jsonResponse({ error: 'This can no longer be undone.' }, 410, corsOrigin);
  }
  // #783 · the logins that leave this account. A session follows its login, so one that came
  // in through a leaving login is that login's own account from here on (signed_out tells
  // the game and the website to sign in again and show it).
  let leaving = [];
  // In the same batch as the change: the event is marked undone, and the copy of what was
  // moved is cleared (nothing reads it again).
  const undone = () => [env.DB.prepare('UPDATE account_events SET undone_at = ?, moved_json = NULL WHERE id = ?').bind(nowS(), ev.id)];
  if (ev.kind === 'link') {
    const login = await loginRow(env, ev.provider, ev.provider_id);
    if (!login || login.user_id !== userId) return deps.jsonResponse({ error: 'This can no longer be undone.' }, 410, corsOrigin);
    const others = await env.DB.prepare("SELECT COUNT(*) AS n FROM user_logins WHERE user_id = ? AND login_id != ? AND provider != 'device'")
      .bind(userId, login.login_id).first();
    if (!others || !others.n) {
      return deps.jsonResponse({ error: "That is the only sign-in on this account, so it can't be removed. Delete the account instead." }, 409, corsOrigin);
    }
    // The sign-in gets an account of its own again, with whatever was recorded under it.
    await splitLogin(env, login.login_id, { name: ev.login_name }, undone);
    leaving = [login.login_id];
  } else if (ev.kind === 'combine') {
    let moved = null;
    try { moved = JSON.parse(ev.moved_json); } catch {}
    let back = null;
    try {
      back = moved ? await separateAccount(env, moved, userId, undone) : null;
    } catch (e) {
      console.error('separate failed', e);
      return deps.jsonResponse({ error: 'The accounts could not be separated. Nothing more was changed.' }, 409, corsOrigin);
    }
    if (!back) return deps.jsonResponse({ error: 'This can no longer be undone.' }, 410, corsOrigin);
    leaving = back.logins;
  } else {
    return deps.jsonResponse({ error: 'This can no longer be undone.' }, 410, corsOrigin);
  }
  deps.writeMetric && deps.writeMetric(env, 'undo_' + ev.kind);
  // Whatever came in through this change stops working, on every device. The session that
  // asked carries on with a new token, unless its own login is the one that left.
  await revokeSessions(env, userId, leaving);
  const signedOut = !!(claims && leaving.includes(claims.lid));
  const next = signedOut ? {} : await sessionFor(env, userId, deps, claims.lid ?? null, basisOf(claims));
  return deps.jsonResponse({ undone: true, kind: ev.kind, signed_out: signedOut, ...next }, 200, corsOrigin);
}

/** POST /me/signout-all: every session of this account stops working, the one asking too. */
export async function handleSignOutEverywhere(request, env, corsOrigin, userId, deps) {
  if (!(await revokeSessions(env, userId))) {
    return deps.jsonResponse({ error: 'That is not available yet. Try again later.' }, 503, corsOrigin);
  }
  deps.writeMetric && deps.writeMetric(env, 'signout_everywhere');
  return deps.jsonResponse({ ok: true }, 200, corsOrigin);
}

/** POST /auth/poll { id, secret } → { status: pending | done | error | expired, ... } */
export async function handleAuthPoll(request, env, corsOrigin, deps) {
  let body = {};
  try { body = await request.json(); } catch {}
  const row = await liveRequest(env, body.id);
  if (!row || row.mode !== 'device' || !body.secret || (await sha256(String(body.secret))) !== row.secret_hash) {
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
 * With a Bearer token (signed in within LINK_FRESH_S) the Steam account is linked
 * to that account; the page finishes it with `secret` (POST /auth/link/complete).
 * → { id, secret, url, expires_in }
 */
export async function handleSteamWebBegin(request, env, url, corsOrigin, deps) {
  if (!env.STEAM_WEB_API_KEY) return deps.jsonResponse({ error: 'Steam sign-in is not set up yet' }, 503, corsOrigin);
  let body = {};
  try { body = await request.json(); } catch {}
  const returnTo = allowedReturnTo(body.return_to, env.CORS_ORIGIN, deps.pickCorsOrigin);
  if (!returnTo) return deps.jsonResponse({ error: 'return_to not allowed' }, 400, corsOrigin);
  const claims = await sessionClaims(request, env, deps);
  const linkUserId = claims ? claims.sub : null;
  if (linkUserId && !freshEnough(claims)) return needFreshSignIn(deps, corsOrigin);
  const nonceHash = cleanNonceHash(body.nonce_hash);
  if (!linkUserId && !nonceHash) return updateRequired(deps, corsOrigin);
  const deviceId = cleanDeviceId(body.device_id);
  const info = {};
  if (deviceId) info.deviceId = deviceId;
  if (nonceHash) info.nonceHash = nonceHash;
  const id = randomId(12);
  const secret = randomId(24);
  await env.DB.prepare('DELETE FROM auth_requests WHERE created_at < ?').bind(nowS() - 3600).run();
  await env.DB.prepare(
    `INSERT INTO auth_requests (id, secret_hash, provider, mode, user_code, link_user_id, link_login_id, return_to, status, profile_json, created_at)
     VALUES (?, ?, 'steam', 'redirect', NULL, ?, ?, ?, 'pending', ?, ?)`
  ).bind(id, await sha256(secret), linkUserId || null, linkUserId ? (claims.lid ?? null) : null, returnTo,
         Object.keys(info).length ? JSON.stringify(info) : null, nowS()).run();
  return deps.jsonResponse({
    id, secret, expires_in: REQUEST_TTL_S,
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
  // Every openid.* field appears once, so the values read here are exactly the ones Steam checks.
  for (const k of new Set(q.keys())) {
    if (k.startsWith('openid.') && q.getAll(k).length !== 1) throw new Error('Steam returned an answer we could not read');
  }
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

/**
 * A Steam account's name and picture, from Steam (one request, 5 s at most). When Steam
 * does not answer: `fallbackName` and Steam's default picture.
 */
export async function fetchSteamProfile(env, steamId, fetchImpl = fetch, fallbackName = 'Steam Player') {
  let name = fallbackName || 'Steam Player';
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
  // Single use, whatever happens next (a link's request lives on, held, for the page to finish).
  await env.DB.prepare("UPDATE auth_requests SET status = 'used' WHERE id = ?").bind(row.id).run();
  const drop = () => env.DB.prepare('DELETE FROM auth_requests WHERE id = ?').bind(row.id).run();
  if (url.searchParams.get('openid.mode') === 'cancel') { await drop(); return Response.redirect(row.return_to, 302); }
  const fetchImpl = deps.fetchImpl || fetch;
  let steamId;
  try {
    steamId = await verifySteamAssertion(url, row.id, fetchImpl);
  } catch (e) {
    await drop();
    console.error('steam sign-in failed', (e && e.message) || e);
    return page('Steam sign-in failed', '<p>Steam did not confirm this sign-in.</p><p>Go back and try again.</p>', 401);
  }
  const profile = await fetchSteamProfile(env, steamId, fetchImpl);
  if (row.link_user_id) return Response.redirect(await holdLink(env, row, profile, null), 302);
  if (!beginInfo(row).nonceHash) { await drop(); return page('This sign-in link has expired', '<p>Go back and choose <b>Sign in with Steam</b> again.</p>', 410); }
  return Response.redirect(await holdSignIn(env, row, profile), 302);
}

// ------------------------------------------------------------
// House Tandem Discord membership (#612)
// ------------------------------------------------------------
//
// The House Tandem bot sits in the players' server. It looks up one member by
// id (no privileged intent). With the Create Invite permission it also adds a
// player who signed in from the website with the guilds.join grant (addToServer).

/**
 * GET /me/discord → { linked, member: true | false | null, invite, server_url }
 * member is null when it can't be checked (no bot set up, or Discord is down).
 * server_url opens the server in Discord (the app on a phone).
 */
export async function handleDiscordMembership(request, env, corsOrigin, userId, deps) {
  const invite = env.DISCORD_INVITE_URL || null;
  const server = env.DISCORD_GUILD_ID ? { server_url: `https://discord.com/channels/${env.DISCORD_GUILD_ID}` } : {};
  const { linked, member, discordId, joinedAt } = await discordMemberStatus(env, userId, deps.fetchImpl);
  const said_hello = member === true ? await discordSaidHello(env, discordId, joinedAt, deps) : null;
  return deps.jsonResponse({ linked, member, said_hello, invite, ...server }, 200, corsOrigin);
}

/**
 * Has this member posted in the House Tandem server's hello channel(s)? (the Join checklist's
 * "say hello" step) → true | false, or null when it can't be checked.
 * DISCORD_HELLO_CHANNEL_IDS: comma-separated channel ids (#welcome). The bot needs View Channel +
 * Read Message History there; only author ids are read, never message text. Once seen, it's kept
 * on the Discord sign-in row (said_hello_at), so Discord is only asked until the first hello.
 * Pages back through each channel only as far as the member's join time (at most HELLO_PAGES x 100).
 */
const HELLO_PAGES = 5;
// Only messages the member typed: DEFAULT (0) and REPLY (19). Discord's own "X joined the
// server" notice (USER_JOIN, 7) in the system channel lists the new member as its author.
const TYPED = new Set([0, 19]);
export async function discordSaidHello(env, discordId, joinedAt, deps = {}) {
  const channels = String(env.DISCORD_HELLO_CHANNEL_IDS || '').split(',').map((c) => c.trim()).filter((c) => /^\d+$/.test(c));
  if (!discordId || !channels.length || !env.DISCORD_BOT_TOKEN) return null;
  try {
    const row = await env.DB.prepare("SELECT said_hello_at FROM user_logins WHERE provider = 'discord' AND provider_id = ?")
      .bind(String(discordId)).first();
    if (row && row.said_hello_at) return true;
  } catch { return null; }   // migration 0018 not applied yet
  const fetchImpl = deps.fetchImpl || fetch;
  const since = joinedAt ? Date.parse(joinedAt) || 0 : 0;
  let unknown = false;
  for (const ch of channels) {
    let before = '';
    for (let page = 0; page < HELLO_PAGES; page++) {
      let msgs;
      try {
        const res = await fetchImpl(`${DISCORD_API}/v10/channels/${ch}/messages?limit=100${before ? `&before=${before}` : ''}`, {
          headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` },
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) { unknown = true; break; }
        msgs = await res.json();
      } catch { unknown = true; break; }
      if (!Array.isArray(msgs) || !msgs.length) break;
      if (msgs.some((m) => m && m.author && String(m.author.id) === String(discordId) && TYPED.has(Number(m.type || 0)))) {
        try {
          await env.DB.prepare("UPDATE user_logins SET said_hello_at = ? WHERE provider = 'discord' AND provider_id = ?")
            .bind(nowS(), String(discordId)).run();
        } catch {}
        deps.writeMetric && deps.writeMetric(env, 'discord_said_hello');
        return true;
      }
      const last = msgs[msgs.length - 1];
      if (msgs.length < 100 || (since && Date.parse(last.timestamp) < since)) break;
      before = last.id;
    }
  }
  return unknown ? null : false;
}

/**
 * Is this account's Discord in the House Tandem server? → { linked, member, discordId, joinedAt }
 * member: true | false, or null when it can't be checked. Also used by the
 * #daily-ride-clips post (worker/share.js), which needs a member.
 */
export async function discordMemberStatus(env, userId, fetchImpl = fetch) {
  const row = await env.DB.prepare(
    "SELECT provider_id FROM user_logins WHERE user_id = ? AND provider = 'discord' ORDER BY last_login_at DESC LIMIT 1"
  ).bind(userId).first();
  if (!row) return { linked: false, member: null };
  const discordId = row.provider_id;
  if (!env.DISCORD_BOT_TOKEN || !env.DISCORD_GUILD_ID) return { linked: true, member: null, discordId };
  fetchImpl = fetchImpl || fetch;
  let member = null, joinedAt = null;
  try {
    const res = await fetchImpl(`${DISCORD_API}/v10/guilds/${env.DISCORD_GUILD_ID}/members/${row.provider_id}`, {
      headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      member = true;
      try { joinedAt = (await res.json()).joined_at || null; } catch {}
    } else if (res.status === 404) member = false;
  } catch {}
  return { linked: true, member, discordId, joinedAt };
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
export async function handleHandoffCreate(request, env, corsOrigin, userId, deps, loginId = null) {
  const claims = await sessionClaims(request, env, deps);
  if (!freshEnough(claims, HANDOFF_FRESH_S)) return needFreshSignIn(deps, corsOrigin, 'opening another site signed in');
  const id = randomId(12);
  const secret = randomId(18);
  await env.DB.prepare('DELETE FROM auth_requests WHERE created_at < ?').bind(nowS() - 3600).run();
  await env.DB.prepare(
    `INSERT INTO auth_requests (id, secret_hash, provider, mode, user_code, link_user_id, link_login_id, return_to, status, profile_json, created_at)
     VALUES (?, ?, 'handoff', 'handoff', NULL, ?, ?, NULL, 'done', ?, ?)`
  ).bind(id, await sha256(secret), userId, loginId ?? null, JSON.stringify({ basis: basisOf(claims) }), nowS()).run();
  return deps.jsonResponse({ code: `${id}.${secret}`, expires_in: HANDOFF_TTL_S }, 200, corsOrigin);
}

/** POST /auth/handoff/redeem { code } → { token, user } */
export async function handleHandoffRedeem(request, env, corsOrigin, deps) {
  let body = {};
  try { body = await request.json(); } catch {}
  const [id, secret] = String(body.code || '').split('.');
  const gone = () => deps.jsonResponse({ error: 'This sign-in link has expired' }, 410, corsOrigin);
  if (!id || !secret) return gone();
  // One statement finds and removes it, so two requests with the same code can't both win.
  const taken = await env.DB.prepare("DELETE FROM auth_requests WHERE id = ? AND provider = 'handoff' AND secret_hash = ? RETURNING *")
    .bind(id, await sha256(secret)).all();
  const row = taken.results && taken.results[0];
  if (!row || row.created_at < nowS() - HANDOFF_TTL_S) return gone();
  const user = await env.DB.prepare('SELECT id, display_name, avatar_url FROM users WHERE id = ?').bind(row.link_user_id).first();
  if (!user) return gone();
  let held = null;
  try { held = JSON.parse(row.profile_json || 'null'); } catch {}
  // A code made just before this version has no record of its session: a short one, not fresh.
  const basis = (held && held.basis) || { exp: nowS() + 86400 };
  // The other site is the same login as the one that asked (#783).
  const { token } = await sessionFor(env, user.id, deps, row.link_login_id ?? null, basis);
  const identities = await listIdentities(env, user.id);
  deps.writeMetric && deps.writeMetric(env, 'auth_handoff');
  return deps.jsonResponse({ token, user: { id: user.id, pid: await ensurePublicId(env, user.id), name: user.display_name, avatar: user.avatar_url, identities } }, 200, corsOrigin);
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
  .code-input { font: 700 40px/1 ui-monospace, Consolas, monospace; letter-spacing: .3em; text-align: center; text-transform: uppercase;
                padding: 12px 8px 12px calc(8px + .3em); border-radius: 12px; border: 2px solid #5b5068; background: #2a2335; color: #ffd36b; width: 100%; box-sizing: border-box; }
  .code-input:focus { outline: none; border-color: #ffd36b; }
  .note { font-size: 14px; opacity: .75; }
  .asker { font-size: 15px; }
  .warn { font-size: 14px; background: #3a2320; border: 1px solid #8a4a3f; border-radius: 10px; padding: 10px 12px; text-align: left; }
  .error { color: #ff9b8a; font-weight: 600; }
</style></head><body><main><div class="brand">House Tandem</div><h1>${escapeHtml(title)}</h1>${body}</main></body></html>`;
  return new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' } });
}

/**
 * #783 · a guest device as a login: provider 'device', its guest key as the id, with a
 * small account of its own (it joins a real account when that device signs in, see
 * claimGuestPairs). Made the first time a guest is recorded. → { userId, loginId }
 */
export async function ensureDeviceLogin(env, key) {
  const have = await loginRow(env, 'device', key);
  if (have) return { userId: have.user_id, loginId: have.login_id };
  const ins = await env.DB.prepare('INSERT INTO users (provider, provider_id, display_name, avatar_url) VALUES (?, ?, ?, NULL)')
    .bind('account', crypto.randomUUID(), 'Guest').run();
  const userId = ins.meta && ins.meta.last_row_id;
  await env.DB.prepare('INSERT OR IGNORE INTO user_logins (user_id, provider, provider_id, display_name) VALUES (?, ?, ?, ?)')
    .bind(userId, 'device', String(key), 'Guest').run();
  const row = await loginRow(env, 'device', key);
  if (row && row.user_id !== userId) await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId).run();   // lost a race
  return { userId: row.user_id, loginId: row.login_id };
}
