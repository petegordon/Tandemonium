// ============================================================
// LEADERBOARD API — Cloudflare Worker + D1
// ============================================================

/**
 * CORS_ORIGIN is a comma-separated list of allowed site origins ('*' allows any).
 * The first entry is the fallback, so a disallowed origin gets a header that doesn't match it.
 */
export function pickCorsOrigin(requestOrigin, corsSetting) {
  const allowed = (corsSetting || '*').split(',').map(s => s.trim()).filter(Boolean);
  if (allowed.includes('*')) return requestOrigin || '*';
  if (originListed(requestOrigin, corsSetting)) return requestOrigin;
  return allowed[0];
}

import { originListed } from './accounts/origins.js';

import { monthCost, GOOGLE_DAILY_CAPS } from '../js/tourist-costs.js';
import {
  upsertIdentity, listIdentities,
  handleDiscordBegin, handleDiscordGo, handleDiscordCallback, handleDiscordConfirm, handleAuthPoll,
  handleSteamWebBegin, handleSteamWebGo, handleSteamWebCallback, handleDiscordMembership,
  handleHandoffCreate, handleHandoffRedeem, discordAvatarUrl, cleanDeviceId, claimGuestPairs,
  handleLinkComplete, handleLinkCombine, handleNotices, handleNoticeSeen, handleNoticeUndo,
  resolveSession, firstLogin, ensureDeviceLogin, signInErrorPage,
  handleAuthExchange, handleSignOutEverywhere, freshEnough, needFreshSignIn, realSignInClaims,
} from './accounts/identity.js';
import { registerAccountTables } from './accounts/combine.js';
import { publicPlayerIds, ensurePublicId, userIdForPublicId, isPublicPlayerId } from './accounts/public-id.js';
import { pruneAnalytics } from './retention.js';
import { handleConsentRegion, handleConsentRecord, handleAccountConsent, consentMissing, CONSENT_ACCOUNT_TABLES } from './accounts/consent.js';
import { gameProfile, recordGame, handleMeGames, handleGameSync, recordPlay, GAME_ACCOUNT_TABLES } from './games.js';
import { handleShareRoute } from './share.js';   // #657
import { partnerFromProof, guestKey, isGuestKey } from './room-proof.js';   // 2026-11-17 · who rode together

/**
 * #612 · what other House Tandem game Workers may do, through the private
 * HouseTandemGames RPC entrypoint (worker/index.js). Each takes env first.
 */
export const houseTandemGames = {
  async resolveDiscord(env, profile) {
    const discordId = String((profile && profile.discordId) || '');
    if (!/^\d{5,25}$/.test(discordId)) throw new Error('bad Discord id');
    const name = String((profile && profile.name) || 'Discord player').slice(0, 64);
    const avatar = typeof (profile && profile.avatar) === 'string' && /^https:\/\/cdn\.discordapp\.com\//.test(profile.avatar)
      ? profile.avatar : discordAvatarUrl({ id: discordId });
    const { userId, loginId } = await upsertIdentity(env, { provider: 'discord', providerId: discordId, name, avatar }, null, identityDeps());
    const user = await env.DB.prepare('SELECT display_name, avatar_url FROM users WHERE id = ?').bind(userId).first();
    // #783 · loginId: pass it back to recordGame / recordPlay so the write is recorded under this Discord.
    return { userId, loginId, name: user ? user.display_name : name, avatar: user ? user.avatar_url : avatar };
  },
  async verifySession(env, token) {
    if (typeof token !== 'string' || token.length > 4096) return null;
    let payload;
    try { payload = await resolveSession(env, await verifyJWT(token, env.JWT_SECRET)); } catch { return null; }
    if (!payload) return null;
    const user = await env.DB.prepare('SELECT id, display_name, avatar_url FROM users WHERE id = ?').bind(payload.sub).first();
    if (!user) return null;
    const ids = await listIdentities(env, user.id);
    const avatar = (ids.discord && ids.discord.avatar) || user.avatar_url;
    return { userId: user.id, loginId: payload.lid, name: user.display_name, avatar };
  },
  gameProfile: (env, userId, game) => gameProfile(env, userId, game),
  // #783 · loginId (from resolveDiscord / verifySession) says which login recorded it. A game
  // Worker that doesn't pass one yet: the account's Discord login (they are Discord Activities),
  // else its first sign-in.
  recordGame: async (env, userId, game, delta, earned, loginId) =>
    recordGame(env, userId, game, delta, earned, await rpcLogin(env, userId, loginId)),
  /** housetandem-web #37 · active seconds in a game (a delta, capped to real time). */
  recordPlay: async (env, userId, game, seconds, loginId) =>
    recordPlay(env, userId, game, seconds, Date.now(), await rpcLogin(env, userId, loginId)),
};

/** The login an RPC write is recorded under (see houseTandemGames.recordGame). */
async function rpcLogin(env, userId, loginId) {
  if (Number.isInteger(loginId)) {
    const row = await env.DB.prepare('SELECT 1 AS x FROM user_logins WHERE login_id = ? AND user_id = ?').bind(loginId, userId).first();
    if (row) return loginId;
  }
  const discord = await env.DB.prepare("SELECT login_id FROM user_logins WHERE user_id = ? AND provider = 'discord' ORDER BY login_id LIMIT 1")
    .bind(userId).first();
  return discord ? discord.login_id : firstLogin(env, userId);
}

// #783 · Tandemonium's tables that carry (account, login): what a combine or a separate
// updates. The accounts module never names them itself.
registerAccountTables([
  { table: 'scores', user: 'user_id', login: 'login_id' },
  { table: 'score_contributions', user: 'player_user_id', login: 'player_login_id' },
  { table: 'user_achievements', user: 'user_id', login: 'login_id' },
  { table: 'daily_results', user: 'user_id', login: 'login_id' },
  { table: 'daily_results', user: 'partner_user_id', login: 'partner_login_id' },
  { table: 'ride_seats', user: 'user_id', login: 'login_id' },
  { table: 'pairs', user: 'user_lo', login: 'login_lo' },
  { table: 'pairs', user: 'user_hi', login: 'login_hi' },
  { table: 'friends', user: 'user_id', login: 'login_id' },
  { table: 'friends', user: 'friend_user_id', login: 'friend_login_id' },
  { table: 'discord_posts', user: 'user_id', login: 'login_id' },
  { table: 'sessions', user: 'google_uid', login: 'login_id', text: true },
  ...GAME_ACCOUNT_TABLES,
  ...CONSENT_ACCOUNT_TABLES,
]);

/** What the identity module needs from this worker. */
const identityDeps = () => ({
  jsonResponse, createJWT, getUserFromRequest, pickCorsOrigin, writeMetric, deviceKeys,
  userFromToken, claimsFromRequest, sessionFromRequest, sessionFromToken,
});

/** A device id's guest login keys: the guest key, and the raw id (records from before the keys). */
async function deviceKeys(env, deviceId) {
  const gk = await guestKey(env.RELAY_SECRET, deviceId);
  return gk ? [gk, deviceId] : [deviceId];
}

export default {
  /** Once a day (wrangler-api.toml): gameplay analytics older than 24 months are deleted. */
  async scheduled(_event, env, ctx) {
    const work = pruneAnalytics(env).then((out) => {
      const total = Object.values(out.removed).reduce((a, b) => a + b, 0);
      if (total || out.errors.length) console.log('analytics retention', JSON.stringify(out));
      if (out.errors.length) console.error('analytics retention failed', out.errors.join(' | '));
    }).catch((e) => console.error('analytics retention failed', (e && e.message) || e));
    if (ctx && ctx.waitUntil) ctx.waitUntil(work);
    return work;
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const requestOrigin = request.headers.get('Origin') || '';
    const corsOrigin = pickCorsOrigin(requestOrigin, env.CORS_ORIGIN);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(corsOrigin) });
    }

    // Every route is awaited here, so a failure anywhere in one is answered below (and
    // logged) instead of leaving the Worker with an unhandled rejection: Cloudflare's 1101 page.
    const route = async () => {
      const path = url.pathname;
      const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
      // Rate limits, one place for every route (see limitRequest).
      const limited = await limitRequest(request, env, path, clientIP, corsOrigin);
      if (limited) return limited;

      // Analytics consent (EEA, UK, Switzerland): is this player to be asked, and their answer.
      if (path === '/consent/region' && request.method === 'GET') {
        return handleConsentRegion(request, corsOrigin, { jsonResponse });
      }
      if (path === '/me/consent' && request.method === 'GET') {
        return withAuth(request, env, corsOrigin, (req, e, c, uid) => handleAccountConsent(req, e, c, uid, { jsonResponse }));
      }
      if (path === '/consent' && request.method === 'POST') {
        const text = await readBodyLimited(request, 4096);
        if (text === null) return jsonResponse({ error: 'Too large' }, 413, corsOrigin);
        return handleConsentRecord(request, env, corsOrigin, text, clientIP, { jsonResponse, sessionFromToken });
      }

      // Analytics writes take no sign-in: their size is checked before anything parses them.
      if (isAnalyticsWrite(path, request.method)) {
        // From a country where the player is asked first, nothing is kept without their yes.
        if (consentMissing(request, url)) return new Response(null, { status: 204, headers: corsHeaders(corsOrigin) });
        const text = await readBodyLimited(request, analyticsBodyLimit(path));
        if (text === null) return jsonResponse({ error: 'Too large' }, 413, corsOrigin);
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { /* answered below */ }
        if (!parsed || typeof parsed !== 'object') return jsonResponse({ error: 'Invalid body' }, 400, corsOrigin);
        request = new Request(request.url, { method: request.method, headers: request.headers, body: text });
      }

      // Auth routes
      if (path === '/auth/google' && request.method === 'POST') {
        return handleGoogleAuth(request, env, corsOrigin);
      }
      if (path === '/auth/steam' && request.method === 'POST') {
        return handleSteamAuth(request, env, corsOrigin);
      }

      // #612 · Discord sign-in (redirect on the same device, or a device code for TV / Steam)
      if (path === '/auth/discord/begin' && request.method === 'POST') {
        return handleDiscordBegin(request, env, url, corsOrigin, identityDeps());
      }
      if (path === '/auth/discord/go' && request.method === 'GET') {
        return handleDiscordGo(request, env, url);
      }
      if (path === '/auth/discord/callback' && request.method === 'GET') {
        return handleDiscordCallback(request, env, url, identityDeps());
      }
      if (path === '/auth/discord/confirm' && request.method === 'POST') {
        return handleDiscordConfirm(request, env, url, identityDeps());
      }
      // #612 · Steam on the web ("Sign in through Steam"); the Steam build uses /auth/steam with a ticket.
      if (path === '/auth/steam/begin' && request.method === 'POST') {
        return handleSteamWebBegin(request, env, url, corsOrigin, identityDeps());
      }
      if (path === '/auth/steam/go' && request.method === 'GET') {
        return handleSteamWebGo(request, env, url);
      }
      if (path === '/auth/steam/callback' && request.method === 'GET') {
        return handleSteamWebCallback(request, env, url, identityDeps());
      }
      if (path === '/auth/poll' && request.method === 'POST') {
        return handleAuthPoll(request, env, corsOrigin, identityDeps());
      }
      // A redirect sign-in's code + the value its browser kept → the session.
      if (path === '/auth/exchange' && request.method === 'POST') {
        return handleAuthExchange(request, env, corsOrigin, identityDeps());
      }
      // #612 · a link finishes in the tab that began it; a combine only after the player said yes.
      if (path === '/auth/link/complete' && request.method === 'POST') {
        return handleLinkComplete(request, env, corsOrigin, identityDeps());
      }
      if (path === '/auth/link/combine' && request.method === 'POST') {
        return handleLinkCombine(request, env, corsOrigin, identityDeps());
      }

      // Authed routes
      if (path === '/score' && request.method === 'POST') return withAuth(request, env, corsOrigin, submitScoreWithLimit);
      if (path === '/me') return withAuth(request, env, corsOrigin, getMe);
      if (path === '/me/games') {
        return withAuth(request, env, corsOrigin, (req, e, c, uid) => handleMeGames(req, e, c, uid, identityDeps()));
      }
      // #612 · open another House Tandem site (dice) already signed in.
      if (path === '/auth/handoff' && request.method === 'POST') {
        return withAuth(request, env, corsOrigin, (req, e, c, uid, lid) => handleHandoffCreate(req, e, c, uid, identityDeps(), lid));
      }
      if (path === '/auth/handoff/redeem' && request.method === 'POST') {
        return handleHandoffRedeem(request, env, corsOrigin, identityDeps());
      }
      // #612 · what was linked or combined lately, and its 7-day undo.
      if (path === '/me/notices' && request.method === 'GET') {
        return withAuth(request, env, corsOrigin, (req, e, c, uid) => handleNotices(req, e, c, uid, identityDeps()));
      }
      if (path === '/me/notices/seen' && request.method === 'POST') {
        return withAuth(request, env, corsOrigin, (req, e, c, uid) => handleNoticeSeen(req, e, c, uid, identityDeps()));
      }
      if (path === '/me/notices/undo' && request.method === 'POST') {
        return withAuth(request, env, corsOrigin, (req, e, c, uid) => handleNoticeUndo(req, e, c, uid, identityDeps()));
      }
      if (path === '/me/discord') {
        return withAuth(request, env, corsOrigin, (req, e, c, uid) => handleDiscordMembership(req, e, c, uid, identityDeps()));
      }
      if (path === '/me/signout-all' && request.method === 'POST') {
        return withAuth(request, env, corsOrigin, (req, e, c, uid) => handleSignOutEverywhere(req, e, c, uid, identityDeps()));
      }
      // #612 · delete the House Tandem account and everything on it (account page, typed confirmation).
      if (path === '/me/delete' && request.method === 'POST') {
        return withAuth(request, env, corsOrigin, handleDeleteAccount);
      }
      if (path === '/achievements/sync' && request.method === 'POST') return withAuth(request, env, corsOrigin, syncAchievements);
      // housetandem-web #37 · time in game (every game) and Tandemonium's lifetime stats, as deltas.
      const gameSync = path.match(/^\/games\/([a-z][a-z0-9_-]{0,19})\/sync$/);
      if (gameSync && request.method === 'POST') {
        return handleGameSync(request, env, corsOrigin, gameSync[1], identityDeps());
      }
      if (path === '/partners') return withAuth(request, env, corsOrigin, handlePartners);
      // D-6 / D-7 · the pair, and the day's ranked results of people you have
      // actually ridden with. There is no global daily board (decision 5).
      if (path === '/pair') return withAuth(request, env, corsOrigin, handlePair);
      if (path === '/daily' && request.method === 'POST') {
        return withAuth(request, env, corsOrigin, handleDailySubmit);
      }
      if (path === '/daily') return withAuth(request, env, corsOrigin, handleDailyBoard);
      if (path === '/relay-token' && request.method === 'POST') return withAuth(request, env, corsOrigin, issueRelayToken);

      // Public routes (rate limited by IP)
      // #657 · share a result: the card for the TV's QR, the #daily-ride post.
      if (path === '/share' || path.startsWith('/share/')) {
        const res = await handleShareRoute(request, env, { path, url, clientIP, corsOrigin },
          { jsonResponse, corsHeaders, getUserFromRequest, checkRateLimit, listIdentities, writeMetric });
        if (res) return res;
      }

      if (path === '/leaderboard') {
        return handleLeaderboard(request, env, url, corsOrigin);
      }
      if (path.startsWith('/player/')) {
        return handlePlayerProfile(request, env, url, corsOrigin);
      }

      // ---- Analytics routes (fire-and-forget, no auth required) ----
      if (path === '/api/analytics/session' && request.method === 'POST') {
        return handleAnalyticsSession(request, env, corsOrigin, clientIP);
      }
      if (path.match(/^\/api\/analytics\/session\/[^/]+$/) && request.method === 'PUT') {
        const sessId = path.split('/')[4];
        return handleAnalyticsSessionUpdate(request, env, corsOrigin, sessId, clientIP);
      }
      if (path === '/api/analytics/event/batch' && request.method === 'POST') {
        return handleAnalyticsEventBatch(request, env, corsOrigin);
      }
      if (path === '/api/analytics/ride' && request.method === 'POST') {
        return handleAnalyticsRideCreate(request, env, corsOrigin);
      }
      if (path.match(/^\/api\/analytics\/ride\/[^/]+$/) && request.method === 'PUT') {
        const rideId = path.split('/')[4];
        return handleAnalyticsRideUpdate(request, env, corsOrigin, rideId);
      }
      if (path.match(/^\/api\/analytics\/ride\/[^/]+\/events$/) && request.method === 'POST') {
        const rideId = path.split('/')[4];
        return handleAnalyticsRideEvents(request, env, corsOrigin, rideId);
      }
      if (path === '/api/analytics/room' && request.method === 'POST') {
        return handleAnalyticsRoomCreate(request, env, corsOrigin);
      }
      if (path.match(/^\/api\/analytics\/room\/[^/]+$/) && request.method === 'PUT') {
        const roomCode = path.split('/')[4];
        return handleAnalyticsRoomUpdate(request, env, corsOrigin, roomCode);
      }
      if (path === '/api/analytics/conversion' && request.method === 'POST') {
        return handleAnalyticsConversion(request, env, corsOrigin);
      }

      // ---- Dashboard query routes (authenticated, rate limited) ----
      if (path.startsWith('/api/analytics/dashboard/')) {
        const dashRoute = path.replace('/api/analytics/dashboard/', '');
        return withDashboardAuth(request, env, corsOrigin, (_r, _e, _c, viewerId) =>
          handleDashboard(dashRoute, url, env, corsOrigin, { clientIP, viewerId })
        );
      }

      return jsonResponse({ error: 'Not found' }, 404, corsOrigin);
    };
    try {
      return await route();
    } catch (e) {
      const message = (e && e.message) || String(e);
      console.error('request failed', request.method, url.pathname, (e && e.stack) || message);
      try { writeMetric(env, 'error', message); } catch (_) { /* don't mask original error */ }
      // The pages a browser is sent to during sign-in get a page, not JSON.
      if (SIGNIN_PAGES.has(url.pathname)) return signInErrorPage();
      // What went wrong is in the log (above), never in the answer.
      return jsonResponse({ error: 'Something went wrong on our side. Try again in a moment.' }, 500, corsOrigin);
    }
  }
};

// ============================================================
// ANALYTICS
// ============================================================

function writeMetric(env, event, extra) {
  if (!env.ANALYTICS) return;
  env.ANALYTICS.writeDataPoint({
    blobs: [event, ...(extra ? [extra] : [])],
    doubles: [1],
    indexes: [event],
  });
}

// ============================================================
// AUTH
// ============================================================

async function handleGoogleAuth(request, env, corsOrigin) {
  const body = await request.json();
  const { credential } = body;
  if (!credential) return jsonResponse({ error: 'Missing credential' }, 400, corsOrigin);

  // Cryptographically verify the Google ID token (RS256 JWT)
  let payload;
  try {
    payload = await verifyGoogleIdToken(credential, env.GOOGLE_CLIENT_ID);
  } catch (e) {
    console.error('google sign-in refused', (e && e.message) || e);
    return jsonResponse({ error: 'Google did not confirm this sign-in' }, 401, corsOrigin);
  }

  writeMetric(env, 'auth_google');

  const googleId = payload.sub;
  const name = payload.name || 'Player';
  const picture = payload.picture || null;
  // Only an address Google itself has confirmed is carried (the dashboard's check reads it).
  const email = (payload.email_verified === true || payload.email_verified === 'true') && typeof payload.email === 'string' ? payload.email : null;

  // #612: Google is a legacy sign-in; its users keep their account.
  const { userId, loginId } = await upsertIdentity(env, { provider: 'google', providerId: googleId, name, avatar: picture }, null, identityDeps());
  await claimGuestPairs(env, cleanDeviceId(body.device_id), userId, identityDeps());   // #678

  // Create server JWT (include email for dashboard access control). #783: lid = this login.
  const jwt = await createJWT({ sub: userId, lid: loginId, name, picture, email, via: 'google:' + googleId, ...(await realSignInClaims(env, loginId)) }, env.JWT_SECRET);

  const identities = await listIdentities(env, userId);
  return jsonResponse({ token: jwt, user: { id: userId, pid: await ensurePublicId(env, userId), name, avatar: picture, identities } }, 200, corsOrigin);
}

/** A Steam web-API auth ticket as the game sends it: hex (a few hundred characters). */
const STEAM_TICKET_RE = /^[0-9a-fA-F]{16,8192}$/;

async function handleSteamAuth(request, env, corsOrigin) {
  if (!env.STEAM_WEB_API_KEY) {
    return jsonResponse({ error: 'Steam authentication not configured' }, 503, corsOrigin);
  }

  const body = await request.json();
  const { steamId, personaName, ticket } = body;
  if (!steamId || !ticket) return jsonResponse({ error: 'Missing steamId or ticket' }, 400, corsOrigin);
  // A ticket is hex. Anything else is refused here, so nothing but a ticket is ever put
  // into the address we ask Steam with.
  if (typeof ticket !== 'string' || !STEAM_TICKET_RE.test(ticket)) return jsonResponse({ error: 'Steam ticket invalid' }, 401, corsOrigin);

  // Verify the auth ticket via Steam Web API
  // Try both the playtest app ID and the main game app ID
  const appIds = [4510250, 4482940];
  let verified = false;
  let verifiedSteamId = null;
  let lastError = null;

  for (const appId of appIds) {
    try {
      const verifyUrl = `https://api.steampowered.com/ISteamUserAuth/AuthenticateUserTicket/v1/?key=${env.STEAM_WEB_API_KEY}&appid=${appId}&ticket=${encodeURIComponent(ticket)}`;
      const steamRes = await fetch(verifyUrl, { signal: AbortSignal.timeout(5000) });
      if (!steamRes.ok) {
        lastError = `Steam API returned ${steamRes.status} for appId ${appId}`;
        continue;
      }
      const steamData = await steamRes.json();
      const params = steamData?.response?.params;
      if (params && params.steamid) {
        // Verify the Steam ID matches
        if (params.steamid !== steamId) {
          lastError = `Steam ID mismatch: expected ${steamId}, got ${params.steamid}`;
          continue;
        }
        verified = true;
        verifiedSteamId = params.steamid;
        break;
      }
      lastError = `Steam response missing params for appId ${appId}: ${JSON.stringify(steamData)}`;
    } catch (e) {
      lastError = `Steam verification error for appId ${appId}: ${e.message}`;
    }
  }

  if (!verified) {
    console.error('steam ticket refused', lastError);
    return jsonResponse({ error: 'Steam ticket invalid' }, 401, corsOrigin);
  }

  writeMetric(env, 'auth_steam');

  const name = personaName || 'Steam Player';

  // Fetch real avatar URL from Steam (avatars use content hashes, not Steam IDs)
  let avatarUrl = 'https://avatars.steamstatic.com/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_medium.jpg'; // default
  try {
    const summaryUrl = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${env.STEAM_WEB_API_KEY}&steamids=${steamId}`;
    const summaryRes = await fetch(summaryUrl, { signal: AbortSignal.timeout(5000) });
    if (summaryRes.ok) {
      const summaryData = await summaryRes.json();
      const player = summaryData?.response?.players?.[0];
      if (player?.avatarmedium) avatarUrl = player.avatarmedium;
    }
  } catch (e) {
    // Non-fatal — proceed with default avatar
  }

  // #612: Steam is one sign-in on the account; a linked Discord rides along.
  const { userId, loginId } = await upsertIdentity(env, { provider: 'steam', providerId: steamId, name, avatar: avatarUrl }, null, identityDeps());
  await claimGuestPairs(env, cleanDeviceId(body.device_id), userId, identityDeps());   // #678
  // The Steam build signs in just after launch: this ride's analytics session
  // takes the account here, in the same request (no extra request to lose).
  await attachSessionAccount(env, body.session_id, userId, loginId);

  // #783 · lid: the login this session is (its account is whatever that login belongs to).
  const jwt = await createJWT({ sub: userId, lid: loginId, name, picture: avatarUrl, via: 'steam:' + steamId, ...(await realSignInClaims(env, loginId)) }, env.JWT_SECRET);

  const identities = await listIdentities(env, userId);
  return jsonResponse({ token: jwt, user: { id: userId, pid: await ensurePublicId(env, userId), name, avatar: avatarUrl, identities } }, 200, corsOrigin);
}

// ============================================================
// SCORES
// ============================================================

/** The roles a ride's contributions may have. */
const CONTRIBUTION_ROLES = ['captain', 'stoker', 'solo'];

/** A ride's optional fields, made safe to store (finite numbers in range, short strings). */
export function scoreFields({ collectiblesCount, inputSource, difficulty, scoreMultiplier } = {}) {
  const str = (v, dflt) => (typeof v === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(v) ? v : dflt);
  return {
    collectiblesCount: typeof collectiblesCount === 'number' && Number.isFinite(collectiblesCount) && collectiblesCount >= 0
      ? Math.min(Math.round(collectiblesCount), 10000) : 0,
    inputSource: str(inputSource, 'none'),
    difficulty: str(difficulty, 'adventurous'),
    scoreMultiplier: typeof scoreMultiplier === 'number' && Number.isFinite(scoreMultiplier) && scoreMultiplier > 0
      ? Math.min(scoreMultiplier, 10) : 1.0,
  };
}

/** A contribution's numbers: finite and in range, anything else 0. */
export function contributionNumbers(s = {}) {
  const num = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(v, hi)) : 0);
  return {
    overallPct: num(s.overallPct, 0, 100), totalTaps: Math.round(num(s.totalTaps, 0, 1e6)),
    correctTaps: Math.round(num(s.correctTaps, 0, 1e6)), wrongTaps: Math.round(num(s.wrongTaps, 0, 1e6)),
    totalPower: num(s.totalPower, 0, 1e9), safePct: num(s.safePct, 0, 100), dangerPct: num(s.dangerPct, 0, 100),
    onRoadPct: num(s.onRoadPct, 0, 100), centerPct: num(s.centerPct, 0, 100), avgLateral: num(s.avgLateral, -1000, 1000),
  };
}

async function submitScore(request, env, corsOrigin, userId, loginId) {
  const body = await request.json();
  if (loginId == null) loginId = await firstLogin(env, userId);
  const { levelId, distance, timeMs, collectiblesCount, inputSource, contributions, newAchievements,
          difficulty, safetyUsed, scoreMultiplier } = body;
  let { mode } = body;

  if (!levelId || !distance || !timeMs) {
    return jsonResponse({ error: 'Missing required fields' }, 400, corsOrigin);
  }
  // Numbers are numbers (the tables aren't STRICT: a string would be stored as text).
  if (typeof distance !== 'number' || !Number.isFinite(distance) || typeof timeMs !== 'number' || !Number.isFinite(timeMs)) {
    return jsonResponse({ error: 'Invalid numbers' }, 400, corsOrigin);
  }

  // Validate level ID
  const VALID_LEVELS = ['grandma'];
  if (!VALID_LEVELS.includes(levelId)) {
    return jsonResponse({ error: 'Invalid level' }, 400, corsOrigin);
  }

  // Validate mode. #612: 'local' (couch co-op) is stored as Player 1's captain ride; a
  // signed-in Player 2 gets their own stoker row from their own sign-in (body.seats).
  const VALID_MODES = ['solo', 'captain', 'stoker', 'local'];
  if (mode && !VALID_MODES.includes(mode)) {
    return jsonResponse({ error: 'Invalid mode' }, 400, corsOrigin);
  }
  const isLocal = mode === 'local';
  if (isLocal) mode = 'captain';

  // #612 · the seats on this couch who signed in themselves: each token is checked
  // here, so Player 1's game can't put a ride on anyone else's account.
  const seatRiders = [];
  if (isLocal && Array.isArray(body.seats)) {
    for (const seat of body.seats.slice(0, 3)) {
      if (!seat || typeof seat.token !== 'string' || !['captain', 'stoker'].includes(seat.role)) continue;
      const p = await claimsFromToken(seat.token, env);   // #783: the seat's account and login, as they stand now
      const sid = p && p.sub;
      if (!sid || String(sid) === String(userId) || seatRiders.some((r) => String(r.userId) === String(sid))) continue;
      seatRiders.push({ userId: sid, loginId: p.lid, role: seat.role, newAchievements: Array.isArray(seat.newAchievements) ? seat.newAchievements.slice(0, 100) : [] });
    }
  }

  // Plausibility checks
  if (timeMs < 30000) {
    return jsonResponse({ error: 'Ride too short' }, 400, corsOrigin);
  }
  if (distance <= 0 || distance > 50000) {
    return jsonResponse({ error: 'Invalid distance' }, 400, corsOrigin);
  }
  if (distance / (timeMs / 1000) > 25) {
    return jsonResponse({ error: 'Implausible speed' }, 400, corsOrigin);
  }

  // Reject duplicate submissions within 10 seconds
  const recent = await env.DB.prepare(
    'SELECT id FROM scores WHERE user_id = ? AND created_at > datetime(\'now\', \'-10 seconds\')'
  ).bind(userId).first();
  if (recent) {
    return jsonResponse({ error: 'Too many submissions' }, 429, corsOrigin);
  }

  writeMetric(env, 'score_submit', levelId);

  const f = scoreFields({ collectiblesCount, inputSource, difficulty, scoreMultiplier });

  // 2026-11-17 · online: who rode with the caller comes only from the room's pair proof
  // (the relay signs who held each seat). A couch whose Player 1 is signed out posts under
  // Player 2 with this device as the guest captain (couch-pair.js guestCaptainSubmit).
  const partner = !isLocal && (mode === 'captain' || mode === 'stoker')
    ? await partnerFromProof(env.RELAY_SECRET, body.pairProof, userId, mode) : null;
  const couchGuest = !partner && body.couchGuest === true && mode === 'stoker' && contributions && contributions.captain
    ? await guestKey(env.RELAY_SECRET, cleanDeviceId(contributions.captain.guestDeviceId)) : null;
  if (contributions && typeof contributions === 'object' && !isLocal) {
    const own = mode || 'solo';
    for (const [role, stats] of Object.entries(contributions)) {
      if (!stats || typeof stats !== 'object' || !CONTRIBUTION_ROLES.includes(role)) { delete contributions[role]; continue; }
      delete stats.guestDeviceId;
      delete stats.guestKey;
      stats.userId = null;        // a partner named without proof is not kept
      stats.loginId = null;
      stats.pairUser = null;      // the account a pair record is kept with (a guest's small account too)
      if (role === own || role === 'solo') {
        stats.userId = stats.pairUser = userId;
        stats.loginId = loginId;
      } else if (partner && partner.role === role) {
        const who = await partnerLogin(env, partner);
        if (who) { stats.userId = who.guest ? null : who.userId; stats.loginId = who.loginId; stats.pairUser = who.userId; }
      } else if (couchGuest && role === 'captain') {
        const who = await ensureDeviceLogin(env, couchGuest);
        stats.loginId = who.loginId;
        stats.pairUser = who.userId;
      }
    }
  }

  // Insert score (#783: under this login, for this account)
  const scoreRes = await env.DB.prepare(
    'INSERT INTO scores (user_id, login_id, level_id, distance, time_ms, mode, collectibles_count, input_source, difficulty, safety_used, score_multiplier) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(userId, loginId, levelId, distance, timeMs, mode || 'solo', f.collectiblesCount, f.inputSource,
         f.difficulty, safetyUsed ? 1 : 0, f.scoreMultiplier).run();

  const scoreId = scoreRes.meta.last_row_id;

  // Batch insert contributions and achievements in a single round-trip
  const batchStmts = [];

  // A local ride's contribution ids come from the checked sign-ins, never the body.
  if (contributions && isLocal) {
    for (const [role, stats] of Object.entries(contributions)) {
      if (!stats || typeof stats !== 'object') continue;
      const seat = seatRiders.find((r) => r.role === role);
      stats.userId = stats.pairUser = role === 'captain' ? userId : (seat ? seat.userId : null);
      stats.loginId = role === 'captain' ? loginId : (seat ? seat.loginId : null);
      delete stats.guestDeviceId;
      delete stats.guestKey;
    }
  }

  if (contributions && isLocal) {
    for (const role of Object.keys(contributions)) {
      if (!CONTRIBUTION_ROLES.includes(role) || !contributions[role] || typeof contributions[role] !== 'object') delete contributions[role];
    }
  }
  if (contributions) {
    for (const [role, raw] of Object.entries(contributions)) {
      const stats = { ...raw, ...contributionNumbers(raw) };
      batchStmts.push(
        env.DB.prepare(
          `INSERT INTO score_contributions
           (score_id, role, player_user_id, player_login_id, contribution_pct, pedal_taps, pedal_correct, pedal_wrong, pedal_power,
            balance_safe_pct, balance_danger_pct, on_road_pct, center_pct, avg_lateral_offset)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          scoreId, role, stats.userId || null, stats.loginId ?? null, stats.overallPct || 0,
          stats.totalTaps || 0, stats.correctTaps || 0, stats.wrongTaps || 0, stats.totalPower || 0,
          stats.safePct || 0, stats.dangerPct || 0, stats.onRoadPct || 0, stats.centerPct || 0,
          stats.avgLateral || 0
        )
      );
    }
  }

  if (newAchievements && Array.isArray(newAchievements)) {
    for (const achId of newAchievements) {
      if (typeof achId !== 'string' || !achId || achId.length > 64) continue;
      batchStmts.push(badgeInsert(env, userId, loginId, achId, scoreId));
    }
  }

  if (batchStmts.length > 0) {
    await env.DB.batch(batchStmts);
  }

  // #612 · each signed-in seat's own copy of the ride, and the achievements it earned them.
  for (const seat of seatRiders) {
    try {
      await env.DB.prepare(
        'INSERT INTO scores (user_id, login_id, level_id, distance, time_ms, mode, collectibles_count, input_source, difficulty, safety_used, score_multiplier) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(seat.userId, seat.loginId, levelId, distance, timeMs, seat.role, f.collectiblesCount, f.inputSource,
             f.difficulty, safetyUsed ? 1 : 0, f.scoreMultiplier).run();
      const achStmts = seat.newAchievements.filter((a) => typeof a === 'string' && a.length <= 64).map((achId) =>
        badgeInsert(env, seat.userId, seat.loginId, achId, scoreId));
      if (achStmts.length) await env.DB.batch(achStmts);
    } catch (err) {
      console.error('seat ride failed', err);   // Player 1's ride is saved either way
    }
  }

  // D-7 · fold this ride into the pair's history when two riders can be
  // identified. Both signed-in gives two account ids; a signed-in captain with
  // a guest stoker gives an account id and 'guest:<device_id>' (D-9), so the
  // record still accumulates and is migrated if that guest ever signs in.
  if (contributions) {
    // #783 · a pair is two logins (a guest is a device login), each with its account beside it.
    const riders = [];
    for (const [role, stats] of Object.entries(contributions)) {
      if (role === 'solo') continue;
      if (stats.loginId != null && stats.pairUser != null) riders.push({ loginId: stats.loginId, userId: stats.pairUser });   // set above, never from the body
    }
    if (riders.length === 2 && String(riders[0].userId) !== String(riders[1].userId)) {
      try {
        await upsertPairRide(env, riders[0], riders[1], {
          levelId, timeMs, distance, dayKey: body.dailyKey || null
        });
      } catch (err) {
        // A pair row is a nicety; a score submission must not fail over it.
        console.error('pairs upsert failed', err);
      }
    }
  }

  // Check if personal best
  const best = await env.DB.prepare(
    'SELECT MIN(time_ms) as best_time FROM scores WHERE user_id = ? AND level_id = ? AND distance >= ?'
  ).bind(userId, levelId, distance).first();

  return jsonResponse({
    scoreId,
    isNewBest: !best || timeMs <= best.best_time
  }, 200, corsOrigin);
}

// ============================================================
// D-6 / D-7 / D-9 · pairs and the partners board
// ============================================================
//
// The pair is the unit this game is actually about. These endpoints are what
// let it survive the room closing.
//
// Design notes that are easy to get wrong later:
//
//   - a pair key is UNORDERED. `pairKey(a, b)` sorts, so who was captain never
//     produces a second row;
//   - keys are TEXT. A signed-in account is its numeric id as a string; a
//     guest is 'guest:<device_id>' (D-9), so a captain still builds a history
//     with the friend who never signs in, and that history is migrated to
//     their account if they ever do;
//   - the daily board returns the caller and the people they have ridden with,
//     and nobody else. There is no global daily leaderboard, on purpose: a
//     stranger's time is not a target for this audience.

/** Unordered, TEXT-keyed pair. */
function pairKey(a, b) {
  const x = String(a);
  const y = String(b);
  return x < y ? [x, y] : [y, x];
}

/**
 * D-7 · fold one finished shared ride into the pair's history.
 * Called from the score submit path when two riders are identifiable.
 */
async function upsertPairRide(env, a, b, { levelId, timeMs, distance, dayKey }) {
  if (!a || !b || a.loginId == null || b.loginId == null || a.loginId === b.loginId) return;
  if (String(a.userId) === String(b.userId)) return;   // a pair with yourself is not a pair
  const [lo, hi] = a.loginId < b.loginId ? [a, b] : [b, a];

  // #783 · the row is these two LOGINS'. The two PEOPLE's record is all their logins' rows
  // together (pairSummary), which is where the streak carries on from.
  const existing = await env.DB.prepare(
    'SELECT * FROM pairs WHERE login_lo = ? AND login_hi = ?'
  ).bind(lo.loginId, hi.loginId).first();
  const together = pairSummary(await pairRows(env, a.userId, b.userId));

  let best = {};
  try { best = existing && existing.best_json ? JSON.parse(existing.best_json) : {}; } catch { best = {}; }
  if (levelId && typeof timeMs === 'number' && timeMs > 0) {
    if (!best[levelId] || timeMs < best[levelId]) best[levelId] = timeMs;
  }

  // The pair's daily streak counts CONSECUTIVE DAYS here only when the ride was
  // on Today's Road; ordinary rides update everything else and leave it alone.
  let streak = together ? together.daily_streak : 0;
  let bestStreak = together ? together.daily_best_streak : 0;
  let lastKey = together ? together.daily_last_key : null;
  if (dayKey) {
    if (lastKey === dayKey) {
      // already counted today
    } else if (lastKey && dayGap(lastKey, dayKey) === 1) {
      streak += 1;
    } else {
      streak = 1;
    }
    bestStreak = Math.max(bestStreak || 0, streak);
    lastKey = dayKey;
  }

  await env.DB.prepare(
    `INSERT INTO pairs (login_lo, login_hi, user_lo, user_hi, rides, distance, best_json, last_ride,
                        daily_streak, daily_best_streak, daily_last_key)
     VALUES (?, ?, ?, ?, 1, ?, ?, datetime('now'), ?, ?, ?)
     ON CONFLICT(login_lo, login_hi) DO UPDATE SET
       user_lo = excluded.user_lo, user_hi = excluded.user_hi,
       rides = rides + 1,
       distance = distance + excluded.distance,
       best_json = excluded.best_json,
       last_ride = excluded.last_ride,
       daily_streak = excluded.daily_streak,
       daily_best_streak = excluded.daily_best_streak,
       daily_last_key = excluded.daily_last_key`
  ).bind(lo.loginId, hi.loginId, lo.userId, hi.userId, distance || 0, JSON.stringify(best), streak, bestStreak, lastKey).run();
}

/** Every pair row between two accounts (one per pair of their logins). */
async function pairRows(env, userA, userB) {
  if (userA == null || userB == null || String(userA) === String(userB)) return [];
  const res = await env.DB.prepare(
    'SELECT * FROM pairs WHERE (user_lo = ? AND user_hi = ?) OR (user_lo = ? AND user_hi = ?)'
  ).bind(userA, userB, userB, userA).all();
  return res.results || [];
}

/**
 * Two people's record from their logins' rows: rides and distance add, the better time
 * per level and the later last ride win, the streak is the most recent one. Null for none.
 */
export function pairSummary(rows) {
  if (!rows || !rows.length) return null;
  const out = { rides: 0, distance: 0, best: {}, last_ride: null, daily_streak: 0, daily_best_streak: 0, daily_last_key: null };
  for (const r of rows) {
    out.rides += r.rides || 0;
    out.distance += r.distance || 0;
    let best = {};
    try { best = r.best_json ? JSON.parse(r.best_json) : {}; } catch { best = {}; }
    for (const [level, ms] of Object.entries(best)) {
      if (typeof ms === 'number' && (!out.best[level] || ms < out.best[level])) out.best[level] = ms;
    }
    if (r.last_ride && (!out.last_ride || r.last_ride > out.last_ride)) out.last_ride = r.last_ride;
    out.daily_best_streak = Math.max(out.daily_best_streak, r.daily_best_streak || 0);
    if (r.daily_last_key && (!out.daily_last_key || r.daily_last_key > out.daily_last_key
        || (r.daily_last_key === out.daily_last_key && (r.daily_streak || 0) > out.daily_streak))) {
      out.daily_last_key = r.daily_last_key;
      out.daily_streak = r.daily_streak || 0;
    }
  }
  return out;
}

/** The account a /pair?with= value names: an account number, or 'guest:<guest key | device id>'. */
async function pairPartner(env, other) {
  if (/^[1-9]\d{0,15}$/.test(other)) return Number(other);
  if (!other.startsWith('guest:')) return null;
  const key = other.slice(6);
  const keys = isGuestKey(key) ? [key] : await deviceKeys(env, cleanDeviceId(key) || '');
  for (const k of keys) {
    if (!k) continue;
    // A guest's login keeps its key until that device signs in; then it is "<key>:claimed:<n>".
    const row = await env.DB.prepare(
      "SELECT user_id FROM user_logins WHERE provider = 'device' AND (provider_id = ? OR provider_id LIKE ?) ORDER BY login_id DESC LIMIT 1"
    ).bind(k, k + ':claimed:%').first();
    if (row) return row.user_id;
  }
  return null;
}

/** The partner a pair proof names, as a login: { userId, loginId, guest } or null. */
async function partnerLogin(env, partner) {
  if (partner.guestKey) return { ...(await ensureDeviceLogin(env, partner.guestKey)), guest: true };
  // The login the relay saw (its account may have changed since); else the account's first sign-in.
  if (Number.isInteger(partner.loginId)) {
    const row = await env.DB.prepare('SELECT login_id, user_id FROM user_logins WHERE login_id = ?').bind(partner.loginId).first();
    if (row) return { userId: row.user_id, loginId: row.login_id, guest: false };
  }
  const user = await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(partner.userId).first();
  if (!user) return null;
  const loginId = await firstLogin(env, user.id);
  return loginId == null ? null : { userId: user.id, loginId, guest: false };
}

function dayGap(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}

/** D-8 · GET /pair?with=<userId|guest:id> — what the two of you have done. */
async function handlePair(request, env, corsOrigin, userId) {
  const url = new URL(request.url);
  const other = url.searchParams.get('with');
  if (!other) return jsonResponse({ error: 'Missing ?with' }, 400, corsOrigin);

  // A guest is looked up by their guest key (what the room gave the partner). A couch asks
  // with this device's own id, which maps to the same key. #783: the answer is the two
  // ACCOUNTS' record, whichever of their logins rode.
  const partner = await pairPartner(env, other);
  const sum = partner == null ? null : pairSummary(await pairRows(env, userId, partner));
  if (!sum) {
    return jsonResponse({ pair: null, rides: 0, distance: 0, best: {}, daily_streak: 0 }, 200, corsOrigin);
  }
  return jsonResponse({
    pair: pairKey(userId, partner),
    rides: sum.rides,
    distance: sum.distance,
    best: sum.best,
    last_ride: sum.last_ride,
    daily_streak: sum.daily_streak,
    daily_best_streak: sum.daily_best_streak
  }, 200, corsOrigin);
}

/**
 * D-6 / #641 · POST /daily — a finished Daily Ride. The board shows each
 * account's BEST time of the day per mode, so a faster finish replaces the
 * row and a slower one changes nothing. A DNF (only pre-#641 builds send one)
 * is kept only when the day has no row yet, and never replaces a finish.
 * Responds { success, improved } — improved = this ride is now the day's best.
 */
async function handleDailySubmit(request, env, corsOrigin, userId, loginId) {
  const body = await request.json();
  const { dayKey, mode, timeMs, dnf, distance, collectibles, crashes, safetyUsed, syncPct, partnerUserId } = body;
  const warp = body.warp === true;   // #611 · ridden in time warp (ahead of the real date)

  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dayKey || ''))) {
    return jsonResponse({ error: 'Bad day key' }, 400, corsOrigin);
  }
  if (mode !== 'solo' && mode !== 'pair') {
    return jsonResponse({ error: 'Bad mode' }, 400, corsOrigin);
  }
  // Today or yesterday only — a client whose clock is a week out is not
  // submitting a result anyone can compare against. #611: a time-warp ride
  // (flagged) may be up to WARP_MAX_DAYS ahead; an unflagged future day is not.
  const today = dailyKeyUTC();
  if (!dailyDayAllowed(dayKey, today, warp)) {
    return jsonResponse({ error: 'Stale day key' }, 400, corsOrigin);
  }
  if (!dnf && !(typeof timeMs === 'number' && timeMs >= 30000 && timeMs <= 900000)) {
    return jsonResponse({ error: 'Implausible time' }, 400, corsOrigin);
  }

  // daily_results is not a STRICT table: a string sent here would be stored as
  // text and shown on other players' boards. Whole numbers in range, or 0 / null.
  const d = dailyNumbers({ distance, collectibles, crashes, syncPct, partnerUserId });
  // 2026-11-17 · a partner is kept only with proof: the room's pair proof (online) or
  // the partner's own sign-in (a couch Player 2's seat token).
  const partner = d.partnerUserId != null ? await dailyPartner(env, body, userId, d.partnerUserId) : null;
  if (loginId == null) loginId = await firstLogin(env, userId);
  // #783 · the row is this login's (one per login, day and mode). The account's result for
  // the day is the best of its logins' rows, so "improved" is judged against that.
  const before = await env.DB.prepare(
    'SELECT MIN(time_ms) AS best FROM daily_results WHERE user_id = ? AND day_key = ? AND mode = ? AND dnf = 0 AND time_ms IS NOT NULL'
  ).bind(userId, dayKey, mode).first();
  await env.DB.prepare(dailyUpsertSql(!!dnf)).bind(
    loginId, userId, dayKey, mode, dnf ? null : Math.round(timeMs), dnf ? 1 : 0,
    d.distance, d.collectibles, d.crashes, safetyUsed ? 1 : 0,
    d.syncPct, partner ? partner.userId : null, partner ? partner.loginId : null, warp ? 1 : 0
  ).run();
  const improved = !dnf && (!before || before.best == null || Math.round(timeMs) < before.best);

  writeMetric(env, 'daily_submit', mode);
  return jsonResponse({ success: true, improved }, 200, corsOrigin);
}

/**
 * The partner a Daily post may name: `partnerId` only when the post proves they rode
 * together (the room's pair proof, or a couch Player 2's own sign-in). → { userId, loginId } | null
 */
async function dailyPartner(env, body, userId, partnerId) {
  for (const role of ['captain', 'stoker']) {
    const p = await partnerFromProof(env.RELAY_SECRET, body.pairProof, userId, role);
    if (p && p.userId && String(p.userId) === String(partnerId)) {
      const who = await partnerLogin(env, p);
      if (who && !who.guest) return { userId: who.userId, loginId: who.loginId };
    }
  }
  if (typeof body.seatToken === 'string' && env.JWT_SECRET) {
    const t = await claimsFromToken(body.seatToken, env);
    if (t && t.sub != null && String(t.sub) === String(partnerId) && String(t.sub) !== String(userId)) return { userId: t.sub, loginId: t.lid };
  }
  return null;
}

/**
 * The Daily Ride's numeric fields, made safe to store: a finite number in range
 * becomes a whole number, anything else (a string, NaN, a negative) becomes 0,
 * or null for the optional ones.
 */
export function dailyNumbers({ distance, collectibles, crashes, syncPct, partnerUserId } = {}) {
  const whole = (v, max) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(Math.round(v), max) : 0);
  return {
    distance: whole(distance, 1000000),
    collectibles: whole(collectibles, 10000),
    crashes: whole(crashes, 10000),
    syncPct: typeof syncPct === 'number' && Number.isFinite(syncPct) ? Math.max(0, Math.min(100, Math.round(syncPct))) : null,
    // An account id; a partner's client may have sent it as a numeric string.
    partnerUserId: /^[1-9]\d{0,15}$/.test(String(partnerUserId ?? '')) ? Number(partnerUserId) : null,
  };
}

/**
 * #641 · the daily_results write. One row per (login, day, mode) is the rule
 * (the UNIQUE key, #783); a better time UPDATES it. A finish replaces a DNF or a
 * slower finish; a DNF only fills an empty day. The account's result for the day
 * is the best of its logins' rows (DAILY_BEST).
 */
export function dailyUpsertSql(dnf) {
  const insert = `INSERT INTO daily_results
       (login_id, user_id, day_key, mode, time_ms, dnf, distance, collectibles, crashes, safety_used, sync_pct, partner_user_id, partner_login_id, warp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  if (dnf) return insert + `
       ON CONFLICT(login_id, day_key, mode) DO NOTHING`;
  return insert + `
       ON CONFLICT(login_id, day_key, mode) DO UPDATE SET
         user_id = excluded.user_id,
         time_ms = excluded.time_ms, dnf = 0, distance = excluded.distance,
         collectibles = excluded.collectibles, crashes = excluded.crashes,
         safety_used = excluded.safety_used, sync_pct = excluded.sync_pct,
         partner_user_id = excluded.partner_user_id, partner_login_id = excluded.partner_login_id, warp = excluded.warp
       WHERE daily_results.dnf = 1 OR daily_results.time_ms IS NULL
          OR excluded.time_ms < daily_results.time_ms`;
}

/** #611 · how far ahead of the real date a time-warp ride may post. */
export const WARP_MAX_DAYS = 7;

/**
 * May a Daily result for `dayKey` post when the server's day is `today`?
 * Today or yesterday always; with the time-warp flag, up to WARP_MAX_DAYS ahead.
 */
export function dailyDayAllowed(dayKey, today, warp = false) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dayKey || ''))) return false;
  const ahead = dayGap(today, dayKey);
  if (ahead === 0 || ahead === -1) return true;
  return !!warp && ahead >= 1 && ahead <= WARP_MAX_DAYS;
}

/**
 * D-6 · GET /daily?key=YYYY-MM-DD — you, and the people you have ridden with.
 *
 * Never returns a stranger. The join is against `pairs`, so "someone I have
 * ridden with" means exactly that, and a player who has never ridden with
 * anyone sees only themselves — which reads as "ride with someone", not as a
 * dead game.
 */
async function handleDailyBoard(request, env, corsOrigin, userId) {
  const url = new URL(request.url);
  const key = url.searchParams.get('key') || dailyKeyUTC();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) {
    return jsonResponse({ error: 'Bad day key' }, 400, corsOrigin);
  }

  const rows = await env.DB.prepare(
    `SELECT d.user_id, d.mode, d.time_ms, d.dnf, d.distance, d.collectibles,
            d.crashes, d.safety_used, d.sync_pct, d.warp, u.display_name, u.avatar_url
     FROM daily_results d
     JOIN users u ON u.id = d.user_id
     WHERE d.day_key = ?
       AND (
         d.user_id = ?
         OR EXISTS (
           SELECT 1 FROM pairs p
           WHERE (p.user_lo = ? AND p.user_hi = d.user_id)
              OR (p.user_hi = ? AND p.user_lo = d.user_id)
         )
       )
     ORDER BY d.dnf ASC, d.time_ms ASC`
  ).bind(key, userId, userId, userId).all();

  // #783 · an account with two logins can have two rows for a day and mode: its result is
  // the better one (the rows come best first).
  const seen = new Set();
  const best = (rows.results || []).filter((r) => {
    const k = r.user_id + ':' + r.mode;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  // Each rider is named by public id (pid). The caller's own rows keep their account
  // number too: it is theirs, and game builds from before public ids find "you" by it.
  const pids = await publicPlayerIds(env, best.map((r) => r.user_id));
  const results = best.map(({ user_id, ...r }) => ({
    ...(String(user_id) === String(userId) ? { user_id } : {}),
    pid: pids.get(user_id) || null,
    ...r,
  }));

  return jsonResponse({
    key,
    results,
    note: 'You and the people you have ridden with. There is no global daily board.'
  }, 200, corsOrigin);
}

/** The day key the server considers current (09:00 UTC rollover). */
function dailyKeyUTC(now = Date.now()) {
  return new Date(now - 9 * 3600 * 1000).toISOString().slice(0, 10);
}

// (#783 · a guest who signs in: their device login joins the account, with its pair rows
// (accounts/identity.js claimGuestPairs). Nothing is merged row by row any more: two
// people's record is read from all their logins' rows, see pairSummary.)

// ============================================================
// LEADERBOARD
// ============================================================

async function handleLeaderboard(request, env, url, corsOrigin) {
  const levelId = url.searchParams.get('level') || 'grandma';
  const scope = url.searchParams.get('scope') || 'global';
  const mode = url.searchParams.get('mode');       // 'solo' | 'together'
  const diffFilter = url.searchParams.get('difficulty'); // 'chill' | 'adventurous' | 'daredevil'
  const userFilter = url.searchParams.get('user_id'); // 'me'
  const asked = parseInt(url.searchParams.get('limit') || '20', 10);
  let limit = Number.isFinite(asked) ? Math.max(1, Math.min(asked, 200)) : 20;

  // Cache public global leaderboard requests (30s TTL)
  const isPublic = scope === 'global' && !userFilter;
  if (isPublic) {
    const cache = caches.default;
    const cacheKey = new Request(url.toString(), request);
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
  }

  const conditions = ['s.level_id = ?'];
  const params = [levelId];

  // Mode filter
  if (mode === 'solo') {
    conditions.push("s.mode = 'solo'");
  } else if (mode === 'together') {
    conditions.push("s.mode IN ('captain', 'stoker')");
  }

  // Difficulty filter
  if (diffFilter && ['chill', 'adventurous', 'daredevil'].includes(diffFilter)) {
    conditions.push('s.difficulty = ?');
    params.push(diffFilter);
  }

  // User filter (requires auth)
  let authedUserId = null;
  if (userFilter === 'me' || scope === 'friends') {
    authedUserId = await getUserFromRequest(request, env);
    if (!authedUserId) return jsonResponse({ error: 'Auth required' }, 401, corsOrigin);
  }

  if (userFilter === 'me') {
    conditions.push('s.user_id = ?');
    params.push(authedUserId);
    if (!url.searchParams.has('limit')) limit = 200;
  }

  // Friends scope
  if (scope === 'friends') {
    conditions.push('(s.user_id = ? OR s.user_id IN (SELECT friend_user_id FROM friends WHERE user_id = ?))');
    params.push(authedUserId, authedUserId);
  }

  params.push(limit);

  const query = `
    SELECT s.id, s.distance, s.time_ms, s.mode, s.collectibles_count, s.input_source, s.created_at,
           s.difficulty, s.safety_used, s.score_multiplier,
           u.display_name, u.avatar_url, u.id as user_id
    FROM scores s
    JOIN users u ON s.user_id = u.id
    WHERE ${conditions.join(' AND ')}
    ORDER BY s.time_ms ASC
    LIMIT ?`;

  const results = await env.DB.prepare(query).bind(...params).all();
  const rows = results.results;

  if (rows.length === 0) return jsonResponse({ entries: [] }, 200, corsOrigin);

  // Batch contributions (fixes N+1). D1 takes at most 100 bound values a query, and "my
  // rides" asks for up to 200 rows: ask in chunks.
  const chunks = (list, n = 90) => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, i * n + n));
  const scoreIds = rows.map(r => r.id);
  const contribMap = {};
  for (const ids of chunks(scoreIds)) {
    const contribResults = await env.DB.prepare(
      `SELECT sc.score_id, sc.role, sc.contribution_pct, sc.pedal_taps, sc.pedal_correct, sc.pedal_wrong,
              sc.balance_safe_pct, sc.on_road_pct, sc.player_user_id,
              u.display_name as partner_name, u.avatar_url as partner_avatar
       FROM score_contributions sc
       LEFT JOIN users u ON sc.player_user_id = u.id
       WHERE sc.score_id IN (${ids.map(() => '?').join(',')})`
    ).bind(...ids).all();
    for (const c of contribResults.results) {
      if (!contribMap[c.score_id]) contribMap[c.score_id] = [];
      contribMap[c.score_id].push(c);
    }
  }

  // Batch achievements (fixes N+1)
  const userIds = [...new Set(rows.map(r => r.user_id))];
  const achMap = {};
  for (const ids of chunks(userIds)) {
    const achResults = await env.DB.prepare(
      `SELECT user_id, achievement_id, MIN(score_id) AS score_id FROM user_achievements
       WHERE user_id IN (${ids.map(() => '?').join(',')}) GROUP BY user_id, achievement_id`
    ).bind(...ids).all();
    for (const a of achResults.results) {
      if (!achMap[a.user_id]) achMap[a.user_id] = [];
      achMap[a.user_id].push(a);
    }
  }

  // Assemble entries. A player is named by public id (pid): account numbers stay here.
  const riders = Object.values(contribMap).flat().map(c => c.player_user_id);
  const pids = await publicPlayerIds(env, [...userIds, ...riders]);
  const entries = rows.map(({ user_id, ...row }) => ({
    ...row,
    pid: pids.get(user_id) || null,
    contributions: (contribMap[row.id] || []).map(({ player_user_id, ...c }) => ({
      ...c, player_pid: player_user_id == null ? null : pids.get(player_user_id) || null
    })),
    achievements: (achMap[user_id] || []).map(a => ({ achievement_id: a.achievement_id, score_id: a.score_id }))
  }));

  const response = jsonResponse({ entries }, 200, corsOrigin);

  // Store in cache for public requests
  if (isPublic) {
    const cache = caches.default;
    const cacheKey = new Request(url.toString(), request);
    const cachedResponse = new Response(response.clone().body, response);
    cachedResponse.headers.set('Cache-Control', 'public, max-age=30');
    await cache.put(cacheKey, cachedResponse);
  }

  return response;
}

// ============================================================
// PLAYER PROFILE
// ============================================================

async function handlePlayerProfile(request, env, url, corsOrigin) {
  // GET /player/<pid>: a player is asked for by public id, never by account number.
  const pid = url.pathname.split('/')[2] || '';
  if (!isPublicPlayerId(pid)) return jsonResponse({ error: 'Invalid player ID' }, 400, corsOrigin);
  const playerId = await userIdForPublicId(env, pid);
  if (playerId == null) return jsonResponse({ error: 'Player not found' }, 404, corsOrigin);

  const levelFilter = url.searchParams.get('level');

  const user = await env.DB.prepare('SELECT display_name, avatar_url, created_at FROM users WHERE id = ?')
    .bind(playerId).first();
  if (!user) return jsonResponse({ error: 'Player not found' }, 404, corsOrigin);
  user.pid = pid;

  const achievements = await env.DB.prepare(ACCOUNT_BADGES).bind(playerId).all();

  let bestScores, recentScores;
  if (levelFilter) {
    bestScores = await env.DB.prepare(
      `SELECT level_id, MIN(time_ms) as best_time, MAX(distance) as max_distance, COUNT(*) as rides
       FROM scores WHERE user_id = ? AND level_id = ? GROUP BY level_id`
    ).bind(playerId, levelFilter).all();

    recentScores = await env.DB.prepare(
      'SELECT id, level_id, distance, time_ms, mode, collectibles_count, input_source, created_at FROM scores WHERE user_id = ? AND level_id = ? ORDER BY created_at DESC LIMIT 10'
    ).bind(playerId, levelFilter).all();
  } else {
    bestScores = await env.DB.prepare(
      `SELECT level_id, MIN(time_ms) as best_time, MAX(distance) as max_distance, COUNT(*) as rides
       FROM scores WHERE user_id = ? GROUP BY level_id`
    ).bind(playerId).all();

    recentScores = await env.DB.prepare(
      'SELECT id, level_id, distance, time_ms, mode, collectibles_count, input_source, created_at FROM scores WHERE user_id = ? ORDER BY created_at DESC LIMIT 10'
    ).bind(playerId).all();
  }

  return jsonResponse({
    user,
    achievements: achievements.results,
    bestScores: bestScores.results,
    recentScores: recentScores.results
  }, 200, corsOrigin);
}

// ============================================================
// ME + SYNC
// ============================================================

/**
 * #783 · an account's badges: one row per badge, whichever of its logins earned it
 * (two that both did: the earlier date).
 */
const ACCOUNT_BADGES = `SELECT achievement_id, MIN(earned_at) AS earned_at, MIN(score_id) AS score_id
  FROM user_achievements WHERE user_id = ? GROUP BY achievement_id`;

/** A badge for the account, recorded under this login, unless the account already has it. */
function badgeInsert(env, userId, loginId, achievementId, scoreId = null) {
  return env.DB.prepare(
    `INSERT OR IGNORE INTO user_achievements (user_id, login_id, achievement_id, score_id)
     SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM user_achievements WHERE user_id = ? AND achievement_id = ?)`
  ).bind(userId, loginId, achievementId, scoreId, userId, achievementId);
}

async function getMe(request, env, corsOrigin, userId) {
  const user = await env.DB.prepare('SELECT id, display_name, avatar_url, created_at FROM users WHERE id = ?')
    .bind(userId).first();

  const achievements = await env.DB.prepare(ACCOUNT_BADGES).bind(userId).all();

  const bestScores = await env.DB.prepare(
    `SELECT level_id, MIN(time_ms) as best_time, MAX(distance) as max_distance, COUNT(*) as rides
     FROM scores WHERE user_id = ? GROUP BY level_id`
  ).bind(userId).all();

  // #612: every sign-in linked to the account (the TV's Profile pill shows Discord + Steam).
  if (user) user.identities = await listIdentities(env, userId);
  // The player's own public id: what a board row's pid is compared with to find "you".
  if (user) user.pid = await ensurePublicId(env, userId);

  return jsonResponse({
    user,
    achievements: achievements.results,
    bestScores: bestScores.results
  }, 200, corsOrigin);
}

async function syncAchievements(request, env, corsOrigin, userId, loginId) {
  const body = await request.json();
  const { achievements } = body;

  if (!Array.isArray(achievements)) {
    return jsonResponse({ error: 'Invalid achievements' }, 400, corsOrigin);
  }
  if (loginId == null) loginId = await firstLogin(env, userId);

  // A device sends everything it holds, most of it the account's already: only what the
  // account lacks is recorded (under this login).
  let synced = 0;
  for (const achId of achievements.slice(0, 500)) {
    if (typeof achId !== 'string' || !achId || achId.length > 64) continue;
    const res = await badgeInsert(env, userId, loginId, achId).run();
    if (res.meta.changes > 0) synced++;
  }

  // Return all server-side achievements
  const serverAchs = await env.DB.prepare(ACCOUNT_BADGES).bind(userId).all();

  return jsonResponse({
    synced,
    achievements: serverAchs.results
  }, 200, corsOrigin);
}

// ============================================================
// RELAY TOKEN
// ============================================================

async function issueRelayToken(request, env, corsOrigin, userId, loginId) {
  if (!env.RELAY_SECRET) {
    return jsonResponse({ error: 'Relay auth not configured' }, 503, corsOrigin);
  }
  const body = await request.json();
  const { room, role } = body;
  if (!room || !role || !['captain', 'stoker'].includes(role)) {
    return jsonResponse({ error: 'Missing room or role' }, 400, corsOrigin);
  }

  writeMetric(env, 'relay_token', room);

  // Short-lived token (5 minutes)
  // lid: the login in this seat, so the room's pair proof can name it (#783).
  const token = await createJWT({ sub: userId, lid: loginId ?? null, room, role }, env.RELAY_SECRET, 300);
  return jsonResponse({ token }, 200, corsOrigin);
}

// ============================================================
// PARTNERS
// ============================================================

async function handlePartners(request, env, corsOrigin, userId) {
  const results = await env.DB.prepare(
    `SELECT u.id, u.display_name, u.avatar_url,
            COUNT(DISTINCT my.score_id) as rides_together,
            MAX(s.created_at) as last_ride
     FROM score_contributions my
     JOIN score_contributions partner ON my.score_id = partner.score_id AND partner.player_user_id != ?
     JOIN users u ON partner.player_user_id = u.id
     JOIN scores s ON my.score_id = s.id
     WHERE my.player_user_id = ?
     GROUP BY partner.player_user_id
     ORDER BY last_ride DESC`
  ).bind(userId, userId).all();

  return jsonResponse({ partners: results.results }, 200, corsOrigin);
}

// ============================================================
// GOOGLE ID TOKEN VERIFICATION
// ============================================================

const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
let cachedJWKS = null;
let cachedJWKSExpiry = 0;

async function fetchGoogleJWKS() {
  const now = Date.now();
  if (cachedJWKS && now < cachedJWKSExpiry) return cachedJWKS;

  const res = await fetch(GOOGLE_JWKS_URL, {
    cf: { cacheEverything: true, cacheTtl: 21600 }
  });
  if (!res.ok) throw new Error('Failed to fetch Google JWKS');

  const jwks = await res.json();
  cachedJWKS = jwks;
  cachedJWKSExpiry = now + 6 * 60 * 60 * 1000; // 6 hours
  return jwks;
}

function base64UrlDecode(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded);
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}

async function verifyGoogleIdToken(token, expectedAud) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid token format');

  // Decode header to get kid
  let header;
  try {
    header = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[0])));
  } catch {
    throw new Error('Invalid token header');
  }

  if (header.alg !== 'RS256') throw new Error('Unsupported algorithm');

  // Fetch JWKS and find matching key
  const jwks = await fetchGoogleJWKS();
  const jwk = jwks.keys.find(k => k.kid === header.kid);
  if (!jwk) throw new Error('Unknown signing key');

  // Import public key and verify signature
  const key = await crypto.subtle.importKey(
    'jwk', jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['verify']
  );

  const signature = base64UrlDecode(parts[2]);
  const signedData = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, signedData);
  if (!valid) throw new Error('Invalid token signature');

  // Decode and validate claims
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[1])));
  } catch {
    throw new Error('Invalid token payload');
  }

  const validIssuers = ['accounts.google.com', 'https://accounts.google.com'];
  if (!validIssuers.includes(payload.iss)) throw new Error('Invalid token issuer');
  if (payload.aud !== expectedAud) throw new Error('Invalid token audience');
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) throw new Error('Token expired');

  return payload;
}

// ============================================================
// RATE LIMITING
// ============================================================

// ── Rate limits (Pete 2026-11-09): two rules, the same for every route ──
//   1. Per player: 30 a minute for each kind of write, keyed by the signed-in
//      account (or the IP when a write has no valid token).
//   2. Per IP: 300 a minute across every route. A venue puts every machine on
//      one IP (one machine sends ~15-20 a minute while riding). Analytics
//      writes carry no sign-in and their ids are the sender's to choose, so
//      this per-IP rule is the one that counts them.
// Starting a sign-in has no player yet: 30 a minute per IP. Share uploads
// keep their own tighter limit (they post publicly to Discord; worker/share.js).
export const PLAYER_LIMIT = 30;
export const IP_LIMIT = 300;
const SIGNIN_PATHS = new Set(['/auth/google', '/auth/steam', '/auth/discord/begin', '/auth/discord/callback',
  '/auth/discord/confirm', '/auth/steam/begin', '/auth/steam/callback', '/auth/handoff', '/auth/handoff/redeem', '/me/delete',
  '/auth/link/complete', '/auth/link/combine', '/me/notices/undo', '/auth/exchange', '/me/signout-all']);
// The sign-in routes a browser is sent to (not called by a script): a failure shows a page.
const SIGNIN_PAGES = new Set(['/auth/discord/go', '/auth/discord/callback', '/auth/discord/confirm',
  '/auth/steam/go', '/auth/steam/callback']);

/** Which per-player bucket a request writes to, or null (reads: the IP ceiling only). */
export async function playerBucket(request, env, path, clientIP) {
  const method = request.method;
  if (method !== 'POST' && method !== 'PUT') return null;
  // Analytics: counted by the per-IP rule alone (see above). A key taken from the request
  // would let one sender spend another player's allowance, or make up a new one each time.
  if (isAnalyticsWrite(path, method)) return null;
  if (path === '/score' || path === '/daily' || path === '/achievements/sync' || /^\/games\/[^/]+\/sync$/.test(path)) {
    const auth = request.headers.get('Authorization') || '';
    const sub = auth.startsWith('Bearer ') && env.JWT_SECRET ? await userFromToken(auth.slice(7), env) : null;
    return path.split('/')[1] + ':' + (sub ? 'user:' + sub : 'ip:' + clientIP);
  }
  return null;
}

/** The two rules (plus sign-in starts) for this request: a 429 response or null. */
export async function limitRequest(request, env, path, clientIP, corsOrigin) {
  if (request.method === 'OPTIONS') return null;
  const ip = await checkRateLimit(env.IP_LIMITER, 'ip:' + clientIP, corsOrigin, env);
  if (ip) return ip;
  if (SIGNIN_PATHS.has(path)) {
    return checkRateLimit(env.SIGNIN_LIMITER, 'signin:' + clientIP, corsOrigin, env);
  }
  const bucket = await playerBucket(request, env, path, clientIP);
  return bucket ? checkRateLimit(env.PLAYER_LIMITER, bucket, corsOrigin, env) : null;
}

async function checkRateLimit(limiter, key, corsOrigin, env) {
  if (!limiter) return null; // graceful fallback if binding not configured
  const { success } = await limiter.limit({ key });
  if (!success) {
    if (env) writeMetric(env, 'rate_limit_hit', key);
    return new Response(JSON.stringify({ error: 'Too many requests' }), {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': '60',
        ...corsHeaders(corsOrigin || '*')
      }
    });
  }
  return null;
}

// The per-player limit is applied in limitRequest, like every route's.
async function submitScoreWithLimit(request, env, corsOrigin, userId, loginId) {
  return submitScore(request, env, corsOrigin, userId, loginId);
}

// ============================================================
// ANALYTICS HANDLERS
// ============================================================

function isValidUUID(str) {
  return typeof str === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

// Analytics comes from any browser, signed in or not, and is read on the dashboard:
// text is plain and short, numbers are numbers, and nothing else is stored.
export const analyticsText = (v, n = 64) => (typeof v === 'string' && v ? (v.replace(/[<>\u0000-\u001f\u007f]/g, '').slice(0, n) || null) : null);
const txt = analyticsText;
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'boolean' ? (v ? 1 : 0) : null);
const scalar = (v, n = 64) => (typeof v === 'string' ? txt(v, n) : num(v));
const jsonText = (v, n = 8000) => {
  if (!v) return null;
  let s;
  try { s = JSON.stringify(v); } catch { return null; }
  return typeof s === 'string' && s.length <= n ? s.replace(/[<>]/g, '') : '{"dropped":"too long"}';
};

/** The largest analytics body, in bytes. The game's own are far smaller (test/unit/analytics-limits). */
export const ANALYTICS_BODY_MAX = 16 * 1024;
/**
 * The two event batches can legitimately be larger, and installed builds can't be changed: a
 * ride's events go in one batch when it ends, and a burst of achievements shares one UI batch
 * (about 60 events is already 16 KB). 64 KB is what a browser's keepalive fetch can send.
 */
export const ANALYTICS_RIDE_EVENTS_MAX = 64 * 1024;

function isAnalyticsWrite(path, method) {
  return (method === 'POST' || method === 'PUT')
    && path.startsWith('/api/analytics/') && !path.startsWith('/api/analytics/dashboard/');
}

export function analyticsBodyLimit(path) {
  return path === '/api/analytics/event/batch' || /^\/api\/analytics\/ride\/[^/]+\/events$/.test(path)
    ? ANALYTICS_RIDE_EVENTS_MAX : ANALYTICS_BODY_MAX;
}

/**
 * The body as text, or null when it is over `max` bytes. The declared length is checked first,
 * and the bytes are counted as they arrive (a declared length can be missing or wrong).
 */
export async function readBodyLimited(request, max) {
  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      try { await reader.cancel(); } catch { /* already closed */ }
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { bytes.set(c, at); at += c.byteLength; }
  return new TextDecoder().decode(bytes);
}

async function handleAnalyticsSession(request, env, corsOrigin, clientIP) {
  const body = await request.json();
  if (!body.id || !isValidUUID(body.id)) {
    return jsonResponse({ error: 'Invalid session id' }, 400, corsOrigin);
  }

  const baseValues = [
    body.id,
    txt(body.started_at, 40) || new Date().toISOString(),
    txt(body.device_type, 32),
    txt(body.input_method, 32),
    txt(body.referrer, 300),
    txt(body.user_agent, 300),
    body.is_stoker ? 1 : 0,
    body.joined_via_url ? 1 : 0,
    txt(body.room_code, 16),
    null,   // google_uid: the account comes only from a verified token (below)
    txt(body.platform, 16) || 'browser',
    num(body.screen_width),
    num(body.screen_height),
    clientIP || null,
  ];
  // A-9: anonymous per-browser id. Old clients don't send it; that is fine.
  const deviceId = typeof body.device_id === 'string' && body.device_id.length <= 64 ? body.device_id : null;

  // Upsert: the session may already exist as a placeholder that its events
  // created (see ensureSessions) when this create was late or rate-limited.
  // Fill it in; keep the earlier start time. Only a placeholder (no user agent yet) is
  // filled: a create repeated for a session already described changes nothing on it,
  // and the account column is never written here.
  const blank = 'sessions.user_agent IS NULL';
  const fill = (cols) => cols.map((c) => `${c} = CASE WHEN ${blank} THEN COALESCE(excluded.${c}, sessions.${c}) ELSE sessions.${c} END`).join(', ');
  const FILL = ['device_type', 'input_method', 'referrer', 'user_agent', 'room_code',
    'platform', 'screen_width', 'screen_height', 'ip_address'];
  const firsts = `started_at = CASE WHEN ${blank} THEN MIN(sessions.started_at, excluded.started_at) ELSE sessions.started_at END,
       is_stoker = CASE WHEN ${blank} THEN MAX(sessions.is_stoker, excluded.is_stoker) ELSE sessions.is_stoker END,
       joined_via_url = CASE WHEN ${blank} THEN MAX(sessions.joined_via_url, excluded.joined_via_url) ELSE sessions.joined_via_url END`;
  try {
    await env.DB.prepare(
      `INSERT INTO sessions (id, started_at, device_type, input_method, referrer, user_agent,
       is_stoker, joined_via_url, room_code, google_uid, platform, screen_width, screen_height, ip_address,
       device_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET ${firsts},
       ${fill([...FILL, 'device_id'])}`
    ).bind(...baseValues, deviceId).run();
  } catch (e) {
    // Worker deploys on push; migration 0008 is applied by hand. Until it is,
    // the column doesn't exist — record the session without it rather than
    // losing every session (the pre-A-9 behaviour).
    if (!/device_id/.test(String(e && e.message))) throw e;
    await env.DB.prepare(
      `INSERT INTO sessions (id, started_at, device_type, input_method, referrer, user_agent,
       is_stoker, joined_via_url, room_code, google_uid, platform, screen_width, screen_height, ip_address)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET ${firsts},
       ${fill(FILL)}`
    ).bind(...baseValues).run();
  }

  // Signed in when the session started: the account comes from the verified token.
  await attachFromToken(env, body.id, body.account_token);

  writeMetric(env, 'analytics_session');
  return jsonResponse({ success: true }, 200, corsOrigin);
}

/** A session takes the account in a sign-in token, once the token is verified. */
async function attachFromToken(env, sessionId, token) {
  if (typeof token !== 'string' || !env.JWT_SECRET) return;
  const who = await sessionFromToken(token, env);
  const acct = parseInt((who && who.userId) ?? '', 10);
  if (acct > 0) await attachSessionAccount(env, sessionId, acct, who.loginId);
}

async function handleAnalyticsSessionUpdate(request, env, corsOrigin, sessionId, clientIP) {
  if (!isValidUUID(sessionId)) {
    return jsonResponse({ error: 'Invalid session id' }, 400, corsOrigin);
  }

  const body = await request.json();
  const allowedFields = ['ended_at', 'controller_name', 'controller_connection'];
  const sets = [];
  const values = [];
  for (const field of allowedFields) {
    if (body[field] !== undefined) {
      sets.push(`${field} = ?`);
      values.push(txt(body[field], 80));
    }
  }

  // Player 1 signed in after the session started (the Steam build's ticket
  // sign-in finishes after launch): attach the account from the verified
  // token. Only to a guest session, so it can't move one between accounts.
  await attachFromToken(env, sessionId, body.account_token);

  // Keep the IP current. A described session with no device id has had its details
  // cleared (a deleted account), or predates device ids: its IP is left as it is.
  if (clientIP) {
    sets.push('ip_address = CASE WHEN user_agent IS NOT NULL AND device_id IS NULL THEN ip_address ELSE ? END');
    values.push(clientIP);
  }

  if (sets.length === 0) {
    return jsonResponse({ success: true }, 200, corsOrigin);
  }

  values.push(sessionId);
  await env.DB.prepare(
    `UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`
  ).bind(...values).run();

  return jsonResponse({ success: true }, 200, corsOrigin);
}

/**
 * Player 1 signed in during this session: a guest session takes the account.
 * Safe under any ordering or repeat: the placeholder insert is a no-op when
 * the row exists, the create's upsert keeps the account (COALESCE), and
 * COALESCE here never moves a session that already has one. Never fails the
 * caller (a sign-in must not fail over analytics).
 */
export async function attachSessionAccount(env, sessionId, userId, loginId = null) {
  const acct = parseInt(userId, 10);
  if (!isValidUUID(sessionId) || !(acct > 0)) return;
  try {
    await env.DB.batch([
      ...ensureSessions(env, [{ session_id: sessionId, created_at: new Date().toISOString() }]),
      // #783: with the login it signed in through (kept only when the account is taken here too).
      env.DB.prepare(
        'UPDATE sessions SET login_id = CASE WHEN google_uid IS NULL THEN ? ELSE login_id END, google_uid = COALESCE(google_uid, ?) WHERE id = ?'
      ).bind(Number.isInteger(loginId) ? loginId : null, String(acct), sessionId),
    ]);
  } catch (e) {
    console.error('session account attach failed', e);
  }
}

/**
 * Placeholder session rows for events whose session was never created. The
 * create is fire-and-forget: rate-limited (429), dropped, or simply later than
 * the first events. events.session_id REFERENCES sessions(id) and D1 enforces
 * foreign keys, so one missing session used to fail the whole batch (500) and
 * every event of that session after it, js_error reports included. A later
 * create fills the placeholder in (handleAnalyticsSession upserts).
 */
function ensureSessions(env, events) {
  const first = new Map();
  for (const e of events) {
    const at = e.created_at || new Date().toISOString();
    if (!first.has(e.session_id) || at < first.get(e.session_id)) first.set(e.session_id, at);
  }
  const stmt = env.DB.prepare('INSERT OR IGNORE INTO sessions (id, started_at) VALUES (?, ?)');
  return [...first].map(([id, at]) => stmt.bind(id, at));
}

/** Events the database can hold: a real session id and an event type. */
function storableEvents(list, max = 200) {
  if (!Array.isArray(list)) return [];
  return list.filter((e) => e && isValidUUID(e.session_id) && typeof e.event_type === 'string' && e.event_type).slice(0, max);
}

async function handleAnalyticsEventBatch(request, env, corsOrigin) {
  const body = await request.json();
  if (!Array.isArray(body.events) || body.events.length === 0) {
    return jsonResponse({ error: 'No events' }, 400, corsOrigin);
  }
  // An event tracked before the session existed has no session id; a NULL in
  // the batch used to fail all of it (session_id is NOT NULL).
  const events = storableEvents(body.events);
  if (events.length === 0) return jsonResponse({ success: true, stored: 0 }, 200, corsOrigin);

  const stmt = env.DB.prepare(
    'INSERT INTO events (session_id, event_type, event_data, created_at, page, input_method) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const batch = events.map(e =>
    stmt.bind(
      e.session_id,
      txt(e.event_type, 64) || 'unknown',
      jsonText(e.event_data),
      txt(e.created_at, 40) || new Date().toISOString(),
      txt(e.page, 64),
      txt(e.input_method, 32)
    )
  );
  await env.DB.batch([...ensureSessions(env, events), ...batch]);

  writeMetric(env, 'analytics_events', String(events.length));
  return jsonResponse({ success: true, stored: events.length }, 200, corsOrigin);
}

async function handleAnalyticsRideCreate(request, env, corsOrigin) {
  const body = await request.json();
  if (!body.id || !isValidUUID(body.id)) {
    return jsonResponse({ error: 'Invalid ride id' }, 400, corsOrigin);
  }
  if (!body.session_id || !isValidUUID(body.session_id)) {
    return jsonResponse({ error: 'Invalid session_id' }, 400, corsOrigin);
  }
  await ensureSessions(env, [{ session_id: body.session_id, created_at: body.started_at }])[0].run();

  await env.DB.prepare(
    `INSERT OR IGNORE INTO rides (id, session_id, room_code, level, role, difficulty,
     input_method, controller_name, controller_connection, bike_preset, steering_feel, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    body.id,
    body.session_id,
    txt(body.room_code, 16),
    txt(body.level, 64) || 'unknown',
    txt(body.role, 16) || 'solo',
    txt(body.difficulty, 16) || 'normal',
    txt(body.input_method, 32) || 'unknown',
    txt(body.controller_name, 80),
    txt(body.controller_connection, 24),
    txt(body.bike_preset, 32),
    scalar(body.steering_feel, 32),
    txt(body.started_at, 40) || new Date().toISOString()
  ).run();

  await saveRideSeats(env, body.id, body.seats);

  writeMetric(env, 'analytics_ride_start', body.level);
  return jsonResponse({ success: true }, 200, corsOrigin);
}

const clip = (v, n) => (typeof v === 'string' && v ? v.slice(0, n) : null);

/**
 * Everyone on the ride (migration 0016). A seat's account comes only from its
 * own sign-in token, verified here. Never fails the ride's create: analytics
 * extras must not cost the ride row (nor does a missing table, before the
 * migration is applied).
 */
export async function saveRideSeats(env, rideId, seats) {
  if (!Array.isArray(seats) || !seats.length) return;
  try {
    const rows = [];
    const used = new Set();
    for (const s of seats.slice(0, 4)) {
      const seat = parseInt(s && s.seat, 10);
      if (!(seat >= 1 && seat <= 4) || used.has(seat)) continue;
      used.add(seat);
      let userId = null;
      let loginId = null;
      if (typeof s.account_token === 'string' && env.JWT_SECRET) {
        const who = await sessionFromToken(s.account_token, env);
        const sub = parseInt((who && who.userId) ?? '', 10);
        if (sub > 0) { userId = sub; loginId = who.loginId ?? null; }
      }
      rows.push(env.DB.prepare(
        `INSERT OR IGNORE INTO ride_seats (ride_id, seat, user_id, login_id, role, team, input_type, controller)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(rideId, seat, userId, loginId, clip(s.role, 16), clip(s.team, 4), clip(s.input_type, 24), clip(s.controller, 80)));
    }
    if (rows.length) await env.DB.batch(rows);
  } catch (e) {
    console.error('ride seats not saved', e);
  }
}

async function handleAnalyticsRideUpdate(request, env, corsOrigin, rideId) {
  if (!isValidUUID(rideId)) {
    return jsonResponse({ error: 'Invalid ride id' }, 400, corsOrigin);
  }

  const body = await request.json();

  // Build dynamic UPDATE from provided fields
  const allowedFields = [
    'ended_at', 'completed', 'abandon_reason', 'duration_ms', 'distance',
    'checkpoints_passed', 'checkpoints_total', 'collectibles', 'collectibles_total',
    'crash_count', 'timeout_count', 'restarts',
    'max_speed', 'avg_speed',
    'balance_safe_pct', 'balance_danger_pct', 'on_road_pct', 'center_pct', 'avg_lateral_offset',
    'lean_input_total', 'lean_correction_total',
    'pedal_taps', 'pedal_correct', 'pedal_wrong', 'pedal_power',
    'offset_quality', 'contribution_pct',
    'dda_assists_offered', 'dda_assists_accepted', 'dda_skips_used', 'safety_used',
    'avg_fps', 'min_fps'
  ];

  const sets = [];
  const values = [];
  for (const field of allowedFields) {
    if (body[field] !== undefined) {
      sets.push(`${field} = ?`);
      values.push(scalar(body[field]));
    }
  }

  if (sets.length === 0) {
    return jsonResponse({ success: true }, 200, corsOrigin);
  }

  values.push(rideId);
  await env.DB.prepare(
    `UPDATE rides SET ${sets.join(', ')} WHERE id = ?`
  ).bind(...values).run();

  writeMetric(env, 'analytics_ride_end', body.completed ? 'complete' : 'abandon');
  return jsonResponse({ success: true }, 200, corsOrigin);
}

async function handleAnalyticsRideEvents(request, env, corsOrigin, rideId) {
  if (!isValidUUID(rideId)) {
    return jsonResponse({ error: 'Invalid ride id' }, 400, corsOrigin);
  }

  const body = await request.json();
  if (!Array.isArray(body.events) || body.events.length === 0) {
    return jsonResponse({ error: 'No events' }, 400, corsOrigin);
  }
  const events = body.events.filter((e) => e && typeof e === 'object').slice(0, 200);
  if (events.length === 0) return jsonResponse({ success: true }, 200, corsOrigin);

  const stmt = env.DB.prepare(
    'INSERT INTO ride_events (ride_id, event_type, distance, event_data, created_at) VALUES (?, ?, ?, ?, ?)'
  );
  const batch = events.map(e =>
    stmt.bind(
      rideId,
      txt(e.event_type, 64) || 'unknown',
      num(e.distance),
      jsonText(e.event_data),
      txt(e.created_at, 40) || new Date().toISOString()
    )
  );
  await env.DB.batch(batch);

  writeMetric(env, 'analytics_ride_events', String(events.length));
  return jsonResponse({ success: true }, 200, corsOrigin);
}

async function handleAnalyticsRoomCreate(request, env, corsOrigin) {
  const body = await request.json();
  body.code = txt(body.code, 16);
  body.captain_session_id = txt(body.captain_session_id, 40);
  body.created_at = txt(body.created_at, 40);
  if (!body.code || !body.captain_session_id) {
    return jsonResponse({ error: 'Missing code or captain_session_id' }, 400, corsOrigin);
  }

  await env.DB.prepare(
    `INSERT OR IGNORE INTO rooms (code, captain_session_id, created_at)
     VALUES (?, ?, ?)`
  ).bind(
    body.code,
    body.captain_session_id,
    body.created_at || new Date().toISOString()
  ).run();

  writeMetric(env, 'analytics_room_create');
  return jsonResponse({ success: true }, 200, corsOrigin);
}

async function handleAnalyticsRoomUpdate(request, env, corsOrigin, roomCode) {
  const body = await request.json();

  // Handle disconnect_count_increment specially
  if (body.disconnect_count_increment) {
    await env.DB.prepare(
      'UPDATE rooms SET disconnect_count = disconnect_count + ? WHERE code = ?'
    ).bind(Math.max(0, Math.min(100, Math.floor(num(body.disconnect_count_increment) || 0))), roomCode).run();
    delete body.disconnect_count_increment;
  }

  // Handle rides_played_increment
  if (body.rides_played_increment) {
    await env.DB.prepare(
      'UPDATE rooms SET rides_played = rides_played + ? WHERE code = ?'
    ).bind(Math.max(0, Math.min(100, Math.floor(num(body.rides_played_increment) || 0))), roomCode).run();
    delete body.rides_played_increment;
  }

  // Build dynamic UPDATE for remaining fields
  const allowedFields = [
    'stoker_joined_at', 'stoker_session_id', 'stoker_joined_via_url',
    'webrtc_connected', 'webrtc_fail_reason', 'connection_type',
    'p2p_upgrade_succeeded', 'video_enabled', 'audio_enabled',
    'avg_rtt_ms', 'max_rtt_ms', 'packet_loss_pct'
  ];

  const sets = [];
  const values = [];
  for (const field of allowedFields) {
    if (body[field] !== undefined) {
      sets.push(`${field} = ?`);
      values.push(scalar(body[field], 80));
    }
  }

  if (sets.length > 0) {
    values.push(roomCode);
    await env.DB.prepare(
      `UPDATE rooms SET ${sets.join(', ')} WHERE code = ?`
    ).bind(...values).run();
  }

  return jsonResponse({ success: true }, 200, corsOrigin);
}

async function handleAnalyticsConversion(request, env, corsOrigin) {
  const body = await request.json();
  body.action = txt(body.action, 64);
  body.created_at = txt(body.created_at, 40);
  if (!isValidUUID(body.session_id) || !body.action) {
    return jsonResponse({ error: 'Missing session_id or action' }, 400, corsOrigin);
  }
  await ensureSessions(env, [{ session_id: body.session_id, created_at: body.created_at }])[0].run();

  await env.DB.prepare(
    'INSERT INTO conversions (session_id, action, context, url, created_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(
    body.session_id,
    body.action,
    txt(body.context, 200),
    txt(body.url, 300),
    body.created_at || new Date().toISOString()
  ).run();

  writeMetric(env, 'analytics_conversion', body.action);
  return jsonResponse({ success: true }, 200, corsOrigin);
}

// ============================================================
// DASHBOARD QUERIES
// ============================================================

async function handleDashboard(route, url, env, corsOrigin, viewer = {}) {
  const days = parseInt(url.searchParams.get('days') || '30');
  const since = new Date(Date.now() - days * 86400000).toISOString();

  // Developer exclusion: IPs (a trailing * matches a prefix) and accounts.
  const ex = await resolveDevExclusions(env, parseDevExclusions(url));

  const handlers = {
    daily: () => dashDaily(env, since, ex),
    funnel: () => dashFunnel(env, since, ex),
    rides: () => dashRides(env, since, ex),
    crashes: () => dashCrashes(env, since, ex),
    conversions: () => dashConversions(env, since, ex),
    network: () => dashNetwork(env, since, ex),
    devices: () => dashDevices(env, since, ex),
    dda: () => dashDDA(env, since, ex),
    overview: () => dashOverview(env, since, ex),
    // C-1 · the three questions the pipeline was never asked.
    retention: () => dashRetention(env, since, ex).catch(e => {
      // Needs migration 0008 (sessions.device_id). Until it's applied, answer
      // with an empty cohort list instead of a 500 — the dashboard loads its
      // panels with Promise.all, so one failing panel blanks the whole page.
      if (!/device_id/.test(String(e && e.message))) throw e;
      return {
        cohorts: [],
        overall: { d1: null, d7: null },
        coverage: { sessions: 0, with_device_id: 0, note: 'Retention needs migration 0008 (sessions.device_id) — not applied yet.' }
      };
    }),
    dropoff: () => dashDropoff(env, since, ex),
    pairs: () => dashPairs(env, since, ex),
    players: () => dashPlayers(env, since, ex),
    tourist_costs: () => dashTouristCosts(env, since),   // #824
  };

  // Auto-detect for the exclusion editor: this browser's IP, plus the IPs the
  // excluded accounts rode from in the last 30 days (older ones may be a venue
  // other players shared). An IPv6 address comes back as its /64, since home
  // IPv6 addresses change every day or so.
  if (route === 'dev_ips') {
    const ips = new Map();
    const add = (ip, note) => { const k = ipForExclusion(ip); if (k && !ips.has(k)) ips.set(k, note); };
    add(viewer.clientIP, 'this browser, now');
    const viewerAccount = parseInt(viewer.viewerId, 10) || null;
    const accounts = [...new Set([...ex.accounts, ...(viewerAccount ? [viewerAccount] : [])])];
    if (accounts.length) {
      const recent = new Date(Date.now() - 30 * 86400000).toISOString();
      const rows = await env.DB.prepare(
        `SELECT ip_address, COUNT(*) AS n, MAX(started_at) AS last FROM sessions
         WHERE ip_address IS NOT NULL AND started_at >= ?
           AND CAST(google_uid AS INTEGER) IN (${accounts.map(() => '?').join(',')})
         GROUP BY ip_address ORDER BY n DESC`
      ).bind(recent, ...accounts).all();
      // A /64 gathers many addresses: add their counts up.
      const seen = new Map();
      for (const r of rows.results || []) {
        const k = ipForExclusion(r.ip_address);
        if (!k) continue;
        const s = seen.get(k) || { n: 0, last: '' };
        s.n += r.n;
        if (String(r.last) > s.last) s.last = String(r.last);
        seen.set(k, s);
      }
      for (const [k, s] of seen) add(k, `${s.n} sessions, last ${s.last.slice(0, 10)}`);
    }
    return jsonResponse({ ips: [...ips].map(([ip, note]) => ({ ip, note })), viewer_account: viewerAccount }, 200, corsOrigin);
  }

  const handler = handlers[route];
  if (!handler) return jsonResponse({ error: 'Unknown dashboard route' }, 404, corsOrigin);

  const data = await handler();
  return jsonResponse(data, 200, corsOrigin);
}

// ── Developer exclusion ──
// The dashboard sends:
//   exclude_ips       IPs; one ending in * matches by prefix (an IPv6 /64)
//   exclude_accounts  account numbers (users.id), or provider:id sign-ins
//                     (steam:7656…, discord:…, google:…) looked up to their account
// sessions.google_uid holds the signed-in account's number (as text, often
// "38.0"), whichever sign-in it was: Google, Discord or Steam. It never held an
// email, so the old email list matched nothing.

/** Read the exclusion params (no database). Unknown tokens are ignored. */
export function parseDevExclusions(url) {
  const list = (k) => (url.searchParams.get(k) || '').split(',').map((s) => s.trim()).filter(Boolean);
  const ips = [];
  const prefixes = [];
  for (const ip of list('exclude_ips')) {
    if (ip.endsWith('*')) {
      const p = ip.slice(0, -1);
      if (/^[0-9a-fA-F:.]{3,}$/.test(p)) prefixes.push(p);
    } else ips.push(ip);
  }
  const accounts = new Set();
  const identities = [];
  // exclude_uids is what older dashboards sent (emails, which match nothing).
  for (const t of [...list('exclude_accounts'), ...list('exclude_uids')]) {
    if (/^\d+(\.0)?$/.test(t)) { const n = parseInt(t, 10); if (n > 0) accounts.add(n); continue; }
    const m = /^(google|discord|steam):(.+)$/i.exec(t);
    if (m) identities.push({ provider: m[1].toLowerCase(), providerId: m[2] });
  }
  return { ips, prefixes, accounts: [...accounts], identities };
}

/** Turn provider:id sign-ins into account numbers. */
async function resolveDevExclusions(env, ex) {
  if (!ex.identities.length) return ex;
  const accounts = new Set(ex.accounts);
  for (const { provider, providerId } of ex.identities) {
    const row = await env.DB.prepare(
      'SELECT user_id FROM user_logins WHERE provider = ? AND provider_id = ?'
    ).bind(provider, providerId).first();
    if (row && row.user_id) accounts.add(Number(row.user_id));
  }
  return { ...ex, accounts: [...accounts] };
}

/** An IP as an exclusion entry: IPv4 as is, IPv6 as its /64 prefix with a *. */
export function ipForExclusion(ip) {
  if (!ip || ip === 'unknown') return null;
  if (!ip.includes(':')) return ip;
  if (ip.endsWith(':*')) return ip;
  let groups;
  if (ip.includes('::')) {
    const [head, tail] = ip.split('::');
    const h = head ? head.split(':') : [];
    const t = tail ? tail.split(':') : [];
    groups = [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  } else groups = ip.split(':');
  return groups.slice(0, 4).join(':') + ':*';
}

/**
 * "This session is the developer's" as SQL, or null when nothing is excluded.
 * Never NULL itself: a NOT IN against an empty column is NULL, which dropped
 * every signed-out session (most players) instead of keeping it.
 */
export function devSessionCondition(ex, alias = '') {
  if (!ex) return null;
  const col = (c) => (alias ? `${alias}.${c}` : c);
  const conds = [];
  const binds = [];
  if (ex.ips.length) {
    conds.push(`COALESCE(${col('ip_address')}, '') IN (${ex.ips.map(() => '?').join(',')})`);
    binds.push(...ex.ips);
  }
  for (const p of ex.prefixes) {
    conds.push(`COALESCE(${col('ip_address')}, '') LIKE ?`);
    binds.push(p + '%');
  }
  if (ex.accounts.length) {
    conds.push(`COALESCE(CAST(${col('google_uid')} AS INTEGER), 0) IN (${ex.accounts.map(() => '?').join(',')})`);
    binds.push(...ex.accounts);
  }
  return conds.length ? { cond: `(${conds.join(' OR ')})`, binds } : null;
}

// For a query that has sessions aliased as 's': " AND NOT (…)".
export function sessionFilter(ex, alias = 's') {
  const d = devSessionCondition(ex, alias);
  return d ? { clause: ` AND NOT ${d.cond}`, binds: d.binds } : { clause: '', binds: [] };
}

// For a table with a session_id column and no sessions join. Callers may
// rename session_id to r.session_id, so it must appear once, at the front.
export function excludedSessionSubquery(ex) {
  const d = devSessionCondition(ex);
  return d
    ? { clause: ` AND session_id NOT IN (SELECT id FROM sessions WHERE ${d.cond})`, binds: d.binds }
    : { clause: '', binds: [] };
}

// ============================================================
// C-1 · Retention, drop-off, pairs
// ============================================================
//
// The analytics pipeline has been collecting since it was built and has never
// been asked a question. These three routes answer the three that decide
// whether any of this work paid off:
//
//   retention — do people come back tomorrow? in a week?
//   dropoff   — where do rides end, and how long does a crash cost?
//   pairs     — do two specific people ride together more than once?
//
// Retention needs the A-9 device_id: before it, every visit from the same
// browser looked like a new person, so D1/D7 was unmeasurable for anyone not
// signed in — which is most players. Rows before the migration have a NULL
// device_id and are excluded rather than guessed at; the response says how
// many, so a low number is never mistaken for a low retention rate.

async function dashRetention(env, since, ex) {
  const sf = sessionFilter(ex, 's');

  // Cohort = the day a device was first seen (in the window). d1/d7 = the
  // share of that cohort with any later session on the following day, or
  // within the following seven days.
  const rows = await env.DB.prepare(
    `WITH d AS (
       SELECT device_id, DATE(started_at) AS day
       FROM sessions s
       WHERE started_at >= ? AND device_id IS NOT NULL${sf.clause}
       GROUP BY device_id, day
     ),
     first_seen AS (
       SELECT device_id, MIN(day) AS cohort FROM d GROUP BY device_id
     )
     SELECT f.cohort AS day,
            COUNT(DISTINCT f.device_id) AS n,
            COUNT(DISTINCT CASE WHEN julianday(d.day) - julianday(f.cohort) = 1
                                THEN f.device_id END) AS d1,
            COUNT(DISTINCT CASE WHEN julianday(d.day) - julianday(f.cohort) BETWEEN 1 AND 7
                                THEN f.device_id END) AS d7
     FROM first_seen f
     LEFT JOIN d ON d.device_id = f.device_id
     GROUP BY f.cohort
     ORDER BY f.cohort DESC`
  ).bind(since, ...sf.binds).all();

  const cohorts = (rows.results || []).map(r => ({
    day: r.day,
    n: r.n,
    d1: r.n ? +(r.d1 / r.n).toFixed(3) : 0,
    d7: r.n ? +(r.d7 / r.n).toFixed(3) : 0
  }));

  // Overall, weighted by cohort size, ignoring cohorts too recent to have had
  // their chance (a cohort from yesterday cannot have a d7).
  const sum = (list, k) => list.reduce((a, c) => a + c[k], 0);
  const d1Pool = cohorts.filter(c => c.day < todayUTC(-1));
  const d7Pool = cohorts.filter(c => c.day < todayUTC(-7));
  const weighted = (pool, k) => {
    const total = sum(pool, 'n');
    return total ? +(pool.reduce((a, c) => a + c[k] * c.n, 0) / total).toFixed(3) : null;
  };

  // How much of the data can even answer this question?
  const coverage = await env.DB.prepare(
    `SELECT COUNT(*) AS total,
            COUNT(CASE WHEN device_id IS NOT NULL THEN 1 END) AS with_device
     FROM sessions s WHERE started_at >= ?${sf.clause}`
  ).bind(since, ...sf.binds).first();

  return {
    cohorts,
    overall: { d1: weighted(d1Pool, 'd1'), d7: weighted(d7Pool, 'd7') },
    coverage: {
      sessions: coverage ? coverage.total : 0,
      with_device_id: coverage ? coverage.with_device : 0,
      note: 'Sessions before the device_id migration are excluded, not guessed at.'
    }
  };
}

/** ISO day, `offsetDays` from today, in UTC. */
function todayUTC(offsetDays = 0) {
  return new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);
}

async function dashDropoff(env, since, ex) {
  const esq = excludedSessionSubquery(ex);

  const byLevel = await env.DB.prepare(
    `SELECT level, difficulty, completed,
            COALESCE(abandon_reason, '-') AS abandon_reason,
            COUNT(*) AS n,
            CAST(AVG(duration_ms) AS INTEGER) AS avg_ms,
            CAST(AVG(distance) AS INTEGER) AS avg_distance
     FROM rides WHERE started_at >= ?${esq.clause}
     GROUP BY level, difficulty, completed, abandon_reason
     ORDER BY n DESC`
  ).bind(since, ...esq.binds).all();

  // Where do abandoned rides die? 30-second buckets, and by checkpoint.
  const buckets = await env.DB.prepare(
    `SELECT (duration_ms / 30000) AS bucket_30s, COUNT(*) AS n
     FROM rides
     WHERE started_at >= ? AND completed = 0 AND duration_ms IS NOT NULL${esq.clause}
     GROUP BY bucket_30s ORDER BY bucket_30s`
  ).bind(since, ...esq.binds).all();

  const byCheckpoint = await env.DB.prepare(
    `SELECT checkpoints_passed, COUNT(*) AS n
     FROM rides WHERE started_at >= ? AND completed = 0${esq.clause}
     GROUP BY checkpoints_passed ORDER BY checkpoints_passed`
  ).bind(since, ...esq.binds).all();

  // First ride of a session: the demo's key number.
  const firstRide = await env.DB.prepare(
    `WITH firsts AS (
       SELECT id, session_id, completed, duration_ms,
              ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY started_at) AS rn
       FROM rides WHERE started_at >= ?${esq.clause}
     )
     SELECT COUNT(*) AS n, SUM(completed) AS completed,
            CAST(AVG(duration_ms) AS INTEGER) AS avg_ms
     FROM firsts WHERE rn = 1`
  ).bind(since, ...esq.binds).first();

  // B-2's promise, measured: how long does a crash actually cost?
  const recover = await env.DB.prepare(
    `SELECT COUNT(*) AS n,
            CAST(AVG(CAST(json_extract(event_data, '$.ms') AS INTEGER)) AS INTEGER) AS avg_ms
     FROM events
     WHERE created_at >= ? AND event_type = 'crash_recover'${esq.clause}`
  ).bind(since, ...esq.binds).first();

  return {
    by_level: byLevel.results || [],
    abandoned_duration_30s_buckets: buckets.results || [],
    abandoned_by_checkpoint: byCheckpoint.results || [],
    first_ride: firstRide || null,
    crash_recover: recover || null
  };
}

async function dashPairs(env, since, ex) {
  // An unordered pair of signed-in accounts that finished a ride together.
  // Ordering the ids in the key is what makes "Sam and Jo" one pair rather
  // than two, regardless of who was captain.
  const rows = await env.DB.prepare(
    `WITH pairs AS (
       SELECT MIN(a.player_user_id) AS lo, MAX(a.player_user_id) AS hi,
              a.score_id, s.created_at
       FROM score_contributions a
       JOIN scores s ON s.id = a.score_id
       WHERE a.player_user_id IS NOT NULL AND s.created_at >= ?
       GROUP BY a.score_id
       HAVING COUNT(DISTINCT a.player_user_id) = 2
     )
     SELECT lo, hi, COUNT(*) AS rides,
            MIN(created_at) AS first_ride, MAX(created_at) AS last_ride
     FROM pairs GROUP BY lo, hi ORDER BY rides DESC`
  ).bind(since).all();

  const pairs = rows.results || [];
  const repeat = pairs.filter(p => p.rides >= 2);

  // Median gap in days between a pair's first and last ride, over their rides.
  // This is what decides whether the pair streak in D-5 is daily or weekly:
  // if two people who ride together do it every nine days, a daily streak is a
  // punishment.
  const gaps = repeat
    .map(p => (Date.parse(p.last_ride) - Date.parse(p.first_ride)) / 86400000 / Math.max(1, p.rides - 1))
    .filter(n => Number.isFinite(n))
    .sort((a, b) => a - b);
  const median = gaps.length ? +gaps[Math.floor(gaps.length / 2)].toFixed(1) : null;

  return {
    pairs: pairs.slice(0, 100),
    total_pairs: pairs.length,
    repeat_pairs: repeat.length,
    repeat_share: pairs.length ? +(repeat.length / pairs.length).toFixed(3) : 0,
    median_days_between_rides: median,
    note: 'Signed-in accounts only. Guest pairs are invisible here until D-9.'
  };
}

// Who played, and for how long (Pete 2026-11-09). One row per signed-in
// account (Steam, Discord, Google: its sign-ins by name) and one per guest
// device that rode at least once (bots and bounces never ride).
// A session's time runs from its start to its last event or ride end: the game
// never recorded a session's end. One session counts at most 2 hours, so a
// window left open overnight doesn't read as a marathon.
export const PLAYER_SESSION_CAP_MIN = 120;
/**
 * #824 · Tourist's Google use and our estimate of its cost. Counts every session (developers too), because the
 * bill does. Google's billing report stays the source of truth.
 */
async function dashTouristCosts(env, since) {
  const NAMES = ['tourist_tiles_session', 'tourist_session_reused', 'tourist_lookup', 'tourist_limit_hit', 'tourist_quota_refused'];
  const marks = NAMES.map(() => '?').join(',');
  const rows = (await env.DB.prepare(
    `SELECT substr(e.created_at, 1, 10) AS day, e.event_type AS type, json_extract(e.event_data, '$.kind') AS kind,
            json_extract(e.event_data, '$.ok') AS ok, COUNT(*) AS n
     FROM events e WHERE e.created_at >= ? AND e.event_type IN (${marks}) GROUP BY day, type, kind, ok`
  ).bind(since, ...NAMES).all()).results || [];
  const players = (await env.DB.prepare(
    `SELECT CASE WHEN s.google_uid IS NOT NULL THEN 'Account ' || CAST(s.google_uid AS INTEGER) ELSE 'Guest' END AS who,
            CASE WHEN s.google_uid IS NOT NULL THEN 'a:' || CAST(s.google_uid AS INTEGER) ELSE 'g:' || COALESCE(s.device_id, s.ip_address, s.id) END AS id,
            SUM(CASE WHEN e.event_type = 'tourist_tiles_session' AND json_extract(e.event_data, '$.ok') = 1 THEN 1 ELSE 0 END) AS sessions,
            SUM(CASE WHEN e.event_type = 'tourist_lookup' AND json_extract(e.event_data, '$.ok') = 1 THEN 1 ELSE 0 END) AS lookups
     FROM events e JOIN sessions s ON s.id = e.session_id
     WHERE e.created_at >= ? AND e.event_type IN ('tourist_tiles_session', 'tourist_lookup')
     GROUP BY id ORDER BY sessions DESC, lookups DESC LIMIT 200`
  ).bind(since).all()).results || [];
  const blank = () => ({ tiles: 0, geocode: 0, elevation: 0, reused: 0, failed: 0, limit_sessions: 0, limit_addresses: 0, refused: 0 });
  const days = new Map();
  for (const r of rows) {
    if (!days.has(r.day)) days.set(r.day, blank());
    const d = days.get(r.day);
    const ok = r.ok === 1 || r.ok === true;
    if (r.type === 'tourist_tiles_session') { if (ok) d.tiles += r.n; else d.failed += r.n; }
    else if (r.type === 'tourist_session_reused') d.reused += r.n;
    else if (r.type === 'tourist_lookup') { if (!ok) d.failed += r.n; else if (r.kind === 'geocode') d.geocode += r.n; else if (r.kind === 'elevation') d.elevation += r.n; }
    else if (r.type === 'tourist_limit_hit') { if (r.kind === 'addresses') d.limit_addresses += r.n; else d.limit_sessions += r.n; }
    else if (r.type === 'tourist_quota_refused') d.refused += r.n;
  }
  const byMonth = new Map();
  for (const [day, d] of days) {
    const m = day.slice(0, 7);
    if (!byMonth.has(m)) byMonth.set(m, blank());
    const t = byMonth.get(m);
    for (const k of Object.keys(t)) t[k] += d[k];
  }
  const active = players.filter((p) => p.sessions > 0 || p.lookups > 0).length;
  const months = [...byMonth].sort().map(([month, c]) => ({ month, ...c, cost: monthCost(month, c) }));
  const total = months.reduce((a, m) => a + m.cost.total, 0);
  const today = days.get(new Date().toISOString().slice(0, 10)) || blank();
  return {
    days: [...days].sort().reverse().map(([day, c]) => ({ day, ...c })),
    months, total_usd: total, active_players: active, cost_per_player: active ? total / active : 0,
    top_players: players.slice(0, 10).map(({ who, sessions, lookups }) => ({ who, sessions, lookups })),
    today_of_cap: {
      tiles: pct0(today.tiles, GOOGLE_DAILY_CAPS.tiles), geocode: pct0(today.geocode, GOOGLE_DAILY_CAPS.geocode),
      elevation: pct0(today.elevation, GOOGLE_DAILY_CAPS.elevation),
    },
    caps: GOOGLE_DAILY_CAPS,
  };
}
const pct0 = (n, of) => (of > 0 ? Math.round((n * 100) / of) : 0);

async function dashPlayers(env, since, ex) {
  const sf = sessionFilter(ex, 's');
  const rows = await env.DB.prepare(
    `WITH ss AS (
       SELECT s.id, s.started_at, s.platform, s.controller_name,
              CAST(s.google_uid AS INTEGER) AS acct,
              CASE WHEN s.google_uid IS NOT NULL THEN 'a:' || CAST(s.google_uid AS INTEGER)
                   ELSE 'g:' || COALESCE(s.device_id, s.ip_address, s.id) END AS who
       FROM sessions s WHERE s.started_at >= ?${sf.clause}
     ),
     ev AS (SELECT session_id, MAX(created_at) AS last FROM events
            WHERE session_id IN (SELECT id FROM ss) GROUP BY session_id),
     rd AS (SELECT session_id, COUNT(*) AS rides, SUM(completed) AS done,
                   MAX(COALESCE(ended_at, started_at)) AS last
            FROM rides WHERE session_id IN (SELECT id FROM ss) GROUP BY session_id),
     per AS (
       SELECT ss.*, COALESCE(rd.rides, 0) AS rides, COALESCE(rd.done, 0) AS done,
              MIN(${PLAYER_SESSION_CAP_MIN}, MAX(0, (julianday(MAX(COALESCE(ev.last, ss.started_at), COALESCE(rd.last, ss.started_at)))
                - julianday(ss.started_at)) * 1440)) AS mins
       FROM ss LEFT JOIN ev ON ev.session_id = ss.id LEFT JOIN rd ON rd.session_id = ss.id
     )
     SELECT who, MAX(acct) AS acct, COUNT(*) AS sessions, COUNT(DISTINCT substr(started_at, 1, 10)) AS days,
            ROUND(SUM(mins), 1) AS minutes, SUM(rides) AS rides, SUM(done) AS finished,
            MIN(started_at) AS first_seen, MAX(started_at) AS last_seen,
            GROUP_CONCAT(DISTINCT platform) AS platforms,
            GROUP_CONCAT(DISTINCT controller_name) AS controllers
     FROM per GROUP BY who
     HAVING acct IS NOT NULL OR SUM(rides) > 0
     ORDER BY minutes DESC
     LIMIT 300`
  ).bind(since, ...sf.binds).all();
  const players = rows.results || [];

  // Couch seats 2–4 (migration 0016): their rides count toward the seat's own
  // account. Excluded by account only: a real player in seat 2 on the
  // developer's machine still counts.
  try {
    const exAcc = ex && ex.accounts && ex.accounts.length ? ex.accounts : [];
    const seatRows = await env.DB.prepare(
      `SELECT rs.user_id AS acct, COUNT(*) AS rides, SUM(r.completed) AS finished,
              ROUND(SUM(MIN(${PLAYER_SESSION_CAP_MIN}, COALESCE(r.duration_ms / 60000.0,
                (julianday(r.ended_at) - julianday(r.started_at)) * 1440, 0))), 1) AS minutes,
              COUNT(DISTINCT substr(r.started_at, 1, 10)) AS days,
              MIN(r.started_at) AS first_seen, MAX(r.started_at) AS last_seen,
              GROUP_CONCAT(DISTINCT rs.controller) AS controllers
       FROM ride_seats rs JOIN rides r ON r.id = rs.ride_id
       WHERE rs.seat > 1 AND rs.user_id IS NOT NULL AND r.started_at >= ?
         ${exAcc.length ? `AND rs.user_id NOT IN (${exAcc.map(() => '?').join(',')})` : ''}
       GROUP BY rs.user_id`
    ).bind(since, ...exAcc).all();
    const byAcct = new Map(players.filter(p => p.acct).map(p => [p.acct, p]));
    for (const s of seatRows.results || []) {
      let p = byAcct.get(s.acct);
      if (!p) {
        p = { acct: s.acct, sessions: 0, days: 0, minutes: 0, rides: 0, finished: 0,
              first_seen: s.first_seen, last_seen: s.last_seen, platforms: '', controllers: null };
        players.push(p);
        byAcct.set(s.acct, p);
      }
      p.seat_rides = s.rides;
      p.seat_minutes = s.minutes || 0;
      p.minutes = Math.round(((p.minutes || 0) + (s.minutes || 0)) * 10) / 10;
      p.rides += s.rides;
      p.finished += s.finished || 0;
      p.days = Math.max(p.days, s.days);
      if (!p.first_seen || s.first_seen < p.first_seen) p.first_seen = s.first_seen;
      if (!p.last_seen || s.last_seen > p.last_seen) p.last_seen = s.last_seen;
      p.controllers = [p.controllers, s.controllers].filter(Boolean).join(',') || null;
    }
    players.sort((a, b) => (b.minutes || 0) - (a.minutes || 0));
  } catch (e) {
    if (!/no such table/.test(String(e && e.message))) throw e;
  }

  // Each account's sign-ins, by name.
  const accts = [...new Set(players.map(p => p.acct).filter(Boolean))];
  const names = new Map();
  if (accts.length) {
    const ids = await env.DB.prepare(
      `SELECT user_id, provider, display_name FROM user_logins
       WHERE user_id IN (${accts.map(() => '?').join(',')}) AND provider != 'device' ORDER BY login_id`
    ).bind(...accts).all();
    for (const r of ids.results || []) {
      if (!names.has(r.user_id)) names.set(r.user_id, []);
      names.get(r.user_id).push({ provider: r.provider, name: r.display_name });
    }
  }
  return {
    players: players.map(p => ({
      ...p,
      who: undefined,
      guest: !p.acct,
      sign_ins: p.acct ? (names.get(p.acct) || []) : [],
    })),
    note: `Time = first to last activity in each session (at most ${PLAYER_SESSION_CAP_MIN / 60} h a session), plus rides as couch Player 2–4. Guests listed only if they rode.`,
  };
}

async function dashOverview(env, since, ex) {
  const sf = sessionFilter(ex, 's');
  const sessions = await env.DB.prepare(
    `SELECT COUNT(*) as total, COUNT(CASE WHEN is_stoker = 1 THEN 1 END) as stokers,
     COUNT(CASE WHEN joined_via_url = 1 THEN 1 END) as url_joins
     FROM sessions s WHERE started_at >= ?${sf.clause}`
  ).bind(since, ...sf.binds).first();

  const esq = excludedSessionSubquery(ex);
  const rides = await env.DB.prepare(
    `SELECT COUNT(*) as total, SUM(completed) as completed,
     COUNT(CASE WHEN level = 'tutorial' THEN 1 END) as tutorials
     FROM rides WHERE started_at >= ?${esq.clause}`
  ).bind(since, ...esq.binds).first();

  const conversions = await env.DB.prepare(
    `SELECT COUNT(*) as total,
     COUNT(CASE WHEN action = 'steam_wishlist_click' THEN 1 END) as steam_clicks,
     COUNT(CASE WHEN action = 'replay_click' THEN 1 END) as replays,
     COUNT(CASE WHEN action = 'room_code_generated' THEN 1 END) as rooms_created
     FROM conversions WHERE created_at >= ?${esq.clause}`
  ).bind(since, ...esq.binds).first();

  const rooms = await env.DB.prepare(
    `SELECT COUNT(*) as total,
     COUNT(stoker_joined_at) as stokers_joined,
     COUNT(CASE WHEN webrtc_connected = 1 THEN 1 END) as connected
     FROM rooms WHERE created_at >= ?`
  ).bind(since).first();

  return { sessions, rides, conversions, rooms };
}

async function dashDaily(env, since, ex) {
  const sf = sessionFilter(ex, 's');
  const rows = await env.DB.prepare(
    `SELECT DATE(s.started_at) AS day,
     COUNT(DISTINCT s.id) AS sessions,
     COUNT(DISTINCT CASE WHEN s.is_stoker = 1 THEN s.id END) AS stoker_sessions,
     COUNT(DISTINCT r.id) AS total_rides,
     COUNT(DISTINCT CASE WHEN r.completed = 1 THEN r.id END) AS completed_rides,
     COUNT(DISTINCT CASE WHEN r.level = 'tutorial' THEN r.id END) AS tutorial_rides
     FROM sessions s
     LEFT JOIN rides r ON r.session_id = s.id
     WHERE s.started_at >= ?${sf.clause}
     GROUP BY DATE(s.started_at)
     ORDER BY day DESC
     LIMIT 30`
  ).bind(since, ...sf.binds).all();
  return { daily: rows.results };
}

async function dashFunnel(env, since, ex) {
  const esq = excludedSessionSubquery(ex);

  // Tutorial starts by input method
  const tutStarts = await env.DB.prepare(
    `SELECT input_method, COUNT(*) AS started
     FROM events WHERE event_type = 'tutorial_start' AND created_at >= ?${esq.clause}
     GROUP BY input_method`
  ).bind(since, ...esq.binds).all();

  // Tutorial completions by input method
  const tutCompletes = await env.DB.prepare(
    `SELECT input_method, COUNT(*) AS completed
     FROM events WHERE event_type = 'tutorial_complete' AND created_at >= ?${esq.clause}
     GROUP BY input_method`
  ).bind(since, ...esq.binds).all();

  // Merge starts and completions
  const completeMap = {};
  (tutCompletes.results || []).forEach(r => { completeMap[r.input_method || 'unknown'] = r.completed; });
  const tutorial = (tutStarts.results || []).map(r => ({
    input_method: r.input_method || 'unknown',
    started: r.started,
    completed: completeMap[r.input_method || 'unknown'] || 0,
  }));

  const tutorialPhases = await env.DB.prepare(
    `SELECT
      JSON_EXTRACT(event_data, '$.phase') AS phase,
      JSON_EXTRACT(event_data, '$.phase_name') AS phase_name,
      COUNT(*) AS completions,
      ROUND(AVG(CAST(JSON_EXTRACT(event_data, '$.attempts') AS REAL)), 1) AS avg_attempts,
      ROUND(AVG(CAST(JSON_EXTRACT(event_data, '$.time_sec') AS REAL)), 1) AS avg_time_sec
     FROM events
     WHERE event_type = 'tutorial_phase' AND created_at >= ?${esq.clause}
     GROUP BY phase ORDER BY phase`
  ).bind(since, ...esq.binds).all();

  // Solo to MP: separate queries to avoid cross-table join issues
  const soloRiders = await env.DB.prepare(
    `SELECT COUNT(DISTINCT session_id) AS cnt FROM rides
     WHERE role IN ('captain', 'solo') AND started_at >= ?${esq.clause}`
  ).bind(since, ...esq.binds).first();

  const roomsCreated = await env.DB.prepare(
    `SELECT COUNT(*) AS cnt FROM rooms WHERE created_at >= ?`
  ).bind(since).first();

  const roomsJoined = await env.DB.prepare(
    `SELECT COUNT(*) AS cnt FROM rooms WHERE stoker_joined_at IS NOT NULL AND created_at >= ?`
  ).bind(since).first();

  const soloToMp = {
    solo_riders: soloRiders?.cnt || 0,
    created_rooms: roomsCreated?.cnt || 0,
    rooms_with_stoker: roomsJoined?.cnt || 0,
  };

  return { tutorial, tutorialPhases: tutorialPhases.results, soloToMp };
}

async function dashRides(env, since, ex) {
  const esq = excludedSessionSubquery(ex);
  const sf = sessionFilter(ex, 's');

  const byLevel = await env.DB.prepare(
    `SELECT level, difficulty, input_method,
     COUNT(*) AS attempts, SUM(completed) AS completions,
     ROUND(AVG(CASE WHEN completed = 1 THEN duration_ms END) / 1000.0, 1) AS avg_time_sec,
     ROUND(AVG(crash_count), 1) AS avg_crashes,
     ROUND(AVG(timeout_count), 1) AS avg_timeouts
     FROM rides WHERE level != 'tutorial' AND started_at >= ?${esq.clause}
     GROUP BY level, difficulty, input_method
     ORDER BY level, difficulty`
  ).bind(since, ...esq.binds).all();

  const abandons = await env.DB.prepare(
    `SELECT level, abandon_reason,
     COUNT(*) AS abandonments,
     ROUND(AVG(distance), 0) AS avg_distance,
     ROUND(AVG(crash_count), 1) AS avg_crashes
     FROM rides
     WHERE completed = 0 AND abandon_reason IS NOT NULL AND started_at >= ?${esq.clause}
     GROUP BY level, abandon_reason
     ORDER BY level, abandonments DESC`
  ).bind(since, ...esq.binds).all();

  const steeringFeel = await env.DB.prepare(
    `SELECT
      CASE WHEN steering_feel < 0.33 THEN 'stable (0-0.33)'
           WHEN steering_feel < 0.67 THEN 'balanced (0.33-0.67)'
           ELSE 'responsive (0.67-1.0)' END AS feel_bucket,
      COUNT(*) AS rides, SUM(completed) AS completed,
      ROUND(AVG(crash_count), 1) AS avg_crashes
     FROM rides WHERE level != 'tutorial' AND steering_feel IS NOT NULL AND started_at >= ?${esq.clause}
     GROUP BY feel_bucket`
  ).bind(since, ...esq.binds).all();

  const bikePresets = await env.DB.prepare(
    `SELECT bike_preset, COUNT(*) AS rides,
     COUNT(DISTINCT session_id) AS unique_players,
     SUM(completed) AS completed
     FROM rides WHERE level != 'tutorial' AND started_at >= ?${esq.clause}
     GROUP BY bike_preset ORDER BY rides DESC`
  ).bind(since, ...esq.binds).all();

  const performance = await env.DB.prepare(
    `SELECT device_type, platform,
     ROUND(AVG(avg_fps)) AS avg_fps,
     ROUND(AVG(min_fps)) AS avg_min_fps,
     COUNT(*) AS rides,
     SUM(completed) AS completed
     FROM rides r JOIN sessions s ON r.session_id = s.id
     WHERE r.started_at >= ? AND r.avg_fps IS NOT NULL${sf.clause}
     GROUP BY device_type, platform ORDER BY rides DESC`
  ).bind(since, ...sf.binds).all();

  return {
    byLevel: byLevel.results,
    abandons: abandons.results,
    steeringFeel: steeringFeel.results,
    bikePresets: bikePresets.results,
    performance: performance.results,
  };
}

async function dashCrashes(env, since, ex) {
  const esq = excludedSessionSubquery(ex);

  const heatmap = await env.DB.prepare(
    `SELECT r.level,
     CAST(ROUND(re.distance / 10) * 10 AS INTEGER) AS distance_bucket,
     JSON_EXTRACT(re.event_data, '$.cause') AS cause,
     COUNT(*) AS crashes
     FROM ride_events re
     JOIN rides r ON re.ride_id = r.id
     WHERE re.event_type = 'crash' AND re.created_at >= ?${esq.clause.replace(/session_id/g, 'r.session_id')}
     GROUP BY r.level, distance_bucket, cause
     ORDER BY r.level, distance_bucket`
  ).bind(since, ...esq.binds).all();

  const crashesByInput = await env.DB.prepare(
    `SELECT JSON_EXTRACT(re.event_data, '$.input_method') AS input_method,
     JSON_EXTRACT(re.event_data, '$.cause') AS cause,
     COUNT(*) AS crashes
     FROM ride_events re
     JOIN rides r ON re.ride_id = r.id
     WHERE re.event_type = 'crash' AND re.created_at >= ?
       AND JSON_EXTRACT(re.event_data, '$.input_method') IS NOT NULL${esq.clause.replace(/session_id/g, 'r.session_id')}
     GROUP BY input_method, cause ORDER BY crashes DESC`
  ).bind(since, ...esq.binds).all();

  const timeouts = await env.DB.prepare(
    `SELECT r.level, r.difficulty,
     JSON_EXTRACT(re.event_data, '$.checkpoint_index') AS checkpoint,
     COUNT(*) AS timeouts
     FROM ride_events re
     JOIN rides r ON re.ride_id = r.id
     WHERE re.event_type = 'timeout' AND re.created_at >= ?${esq.clause.replace(/session_id/g, 'r.session_id')}
     GROUP BY r.level, r.difficulty, checkpoint
     ORDER BY r.level, checkpoint`
  ).bind(since, ...esq.binds).all();

  const pylons = await env.DB.prepare(
    `SELECT r.level,
     JSON_EXTRACT(re.event_data, '$.pylon_index') AS pylon,
     ROUND(re.distance, 0) AS distance_m,
     SUM(CASE WHEN re.event_type = 'pylon_pass' THEN 1 ELSE 0 END) AS passes,
     SUM(CASE WHEN re.event_type = 'pylon_hit' THEN 1 ELSE 0 END) AS hits
     FROM ride_events re
     JOIN rides r ON re.ride_id = r.id
     WHERE re.event_type IN ('pylon_pass', 'pylon_hit') AND re.created_at >= ?${esq.clause.replace(/session_id/g, 'r.session_id')}
     GROUP BY r.level, pylon ORDER BY r.level, re.distance`
  ).bind(since, ...esq.binds).all();

  return { heatmap: heatmap.results, timeouts: timeouts.results, pylons: pylons.results, crashesByInput: crashesByInput.results };
}

async function dashConversions(env, since, ex) {
  const esq = excludedSessionSubquery(ex);

  const byAction = await env.DB.prepare(
    `SELECT action, context, COUNT(*) AS clicks,
     COUNT(DISTINCT session_id) AS unique_sessions
     FROM conversions WHERE created_at >= ?${esq.clause}
     GROUP BY action, context ORDER BY clicks DESC`
  ).bind(since, ...esq.binds).all();

  const daily = await env.DB.prepare(
    `SELECT DATE(created_at) AS day, action, COUNT(*) AS clicks
     FROM conversions WHERE created_at >= ?${esq.clause}
     GROUP BY day, action ORDER BY day DESC`
  ).bind(since, ...esq.binds).all();

  const clips = await env.DB.prepare(
    `SELECT DATE(created_at) AS day,
     COUNT(CASE WHEN event_type = 'clip_save' THEN 1 END) AS saved,
     COUNT(CASE WHEN event_type = 'clip_save' AND JSON_EXTRACT(event_data, '$.method') = 'share' THEN 1 END) AS shared,
     COUNT(CASE WHEN event_type = 'clip_discard' THEN 1 END) AS discarded
     FROM events WHERE event_type IN ('clip_save', 'clip_discard') AND created_at >= ?${esq.clause}
     GROUP BY day ORDER BY day DESC`
  ).bind(since, ...esq.binds).all();

  return { byAction: byAction.results, daily: daily.results, clips: clips.results };
}

async function dashNetwork(env, since, ex) {
  const esq = excludedSessionSubquery(ex);

  // Rooms: filter by captain_session_id
  const roomExcl = esq.clause.replace(/session_id/g, 'captain_session_id');
  const roomHealth = await env.DB.prepare(
    `SELECT COUNT(*) AS total_rooms,
     COUNT(stoker_joined_at) AS stokers_joined,
     COUNT(CASE WHEN stoker_joined_via_url = 1 THEN 1 END) AS joined_via_url,
     COUNT(CASE WHEN webrtc_connected = 1 THEN 1 END) AS webrtc_success,
     COUNT(CASE WHEN webrtc_connected = 0 AND stoker_joined_at IS NOT NULL THEN 1 END) AS webrtc_failed,
     COUNT(CASE WHEN connection_type = 'relay' THEN 1 END) AS relay_connections,
     COUNT(CASE WHEN connection_type = 'p2p' THEN 1 END) AS p2p_connections,
     COUNT(CASE WHEN p2p_upgrade_succeeded = 1 THEN 1 END) AS p2p_upgrades,
     SUM(disconnect_count) AS total_disconnects
     FROM rooms WHERE created_at >= ?${roomExcl}`
  ).bind(since, ...esq.binds).first();

  const disconnects = await env.DB.prepare(
    `SELECT DATE(e.created_at) AS day,
     COUNT(CASE WHEN e.event_type = 'room_disconnect' THEN 1 END) AS disconnects,
     COUNT(CASE WHEN e.event_type = 'room_disconnect'
       AND JSON_EXTRACT(e.event_data, '$.during_ride') = 1 THEN 1 END) AS during_ride,
     COUNT(CASE WHEN e.event_type = 'room_reconnect' THEN 1 END) AS reconnects
     FROM events e
     WHERE e.event_type IN ('room_disconnect', 'room_reconnect') AND e.created_at >= ?${esq.clause.replace(/session_id/g, 'e.session_id')}
     GROUP BY day ORDER BY day DESC`
  ).bind(since, ...esq.binds).all();

  const quality = await env.DB.prepare(
    `SELECT connection_type,
     COUNT(*) AS rooms,
     ROUND(AVG(avg_rtt_ms)) AS avg_rtt_ms,
     ROUND(AVG(max_rtt_ms)) AS avg_max_rtt_ms,
     ROUND(AVG(packet_loss_pct), 2) AS avg_packet_loss_pct
     FROM rooms WHERE created_at >= ? AND avg_rtt_ms IS NOT NULL${roomExcl}`
  ).bind(since, ...esq.binds).all();

  return { roomHealth, disconnects: disconnects.results, quality: quality.results };
}

async function dashDevices(env, since, ex) {
  const sf = sessionFilter(ex, 's');
  const esq = excludedSessionSubquery(ex);

  const devices = await env.DB.prepare(
    `SELECT device_type, platform, COUNT(*) AS sessions
     FROM sessions s WHERE started_at >= ?${sf.clause}
     GROUP BY device_type, platform ORDER BY sessions DESC`
  ).bind(since, ...sf.binds).all();

  const inputMethods = await env.DB.prepare(
    `SELECT input_method, COUNT(*) AS rides,
     SUM(completed) AS completed
     FROM rides WHERE started_at >= ? AND input_method IS NOT NULL${esq.clause}
     GROUP BY input_method ORDER BY rides DESC`
  ).bind(since, ...esq.binds).all();

  const controllers = await env.DB.prepare(
    `SELECT controller_name, controller_connection, COUNT(*) AS rides,
     SUM(completed) AS completed
     FROM rides WHERE started_at >= ? AND controller_name IS NOT NULL${esq.clause}
     GROUP BY controller_name, controller_connection ORDER BY rides DESC`
  ).bind(since, ...esq.binds).all();

  const browsers = await env.DB.prepare(
    `SELECT user_agent, COUNT(*) AS sessions
     FROM sessions s WHERE started_at >= ? AND user_agent IS NOT NULL${sf.clause}
     GROUP BY user_agent ORDER BY sessions DESC`
  ).bind(since, ...sf.binds).all();

  const sessionDuration = await env.DB.prepare(
    `SELECT device_type,
     COUNT(*) AS sessions,
     ROUND(AVG(CASE WHEN ended_at IS NOT NULL
       THEN (julianday(ended_at) - julianday(started_at)) * 86400 END)) AS avg_duration_sec,
     ROUND(AVG(CASE WHEN ended_at IS NOT NULL
       THEN (julianday(ended_at) - julianday(started_at)) * 86400 END) / 60.0, 1) AS avg_duration_min
     FROM sessions s WHERE started_at >= ?${sf.clause}
     GROUP BY device_type ORDER BY sessions DESC`
  ).bind(since, ...sf.binds).all();

  return {
    devices: devices.results,
    inputMethods: inputMethods.results,
    controllers: controllers.results,
    browsers: browsers.results,
    sessionDuration: sessionDuration.results,
  };
}

async function dashDDA(env, since, ex) {
  const esq = excludedSessionSubquery(ex);

  const interventions = await env.DB.prepare(
    `SELECT JSON_EXTRACT(re.event_data, '$.type') AS assist_type,
     SUM(CASE WHEN re.event_type = 'dda_assist_offered' THEN 1 ELSE 0 END) AS offered,
     SUM(CASE WHEN re.event_type = 'dda_assist_accepted' THEN 1 ELSE 0 END) AS accepted,
     SUM(CASE WHEN re.event_type = 'dda_assist_declined' THEN 1 ELSE 0 END) AS declined
     FROM ride_events re
     JOIN rides r ON re.ride_id = r.id
     WHERE re.event_type IN ('dda_assist_offered', 'dda_assist_accepted', 'dda_assist_declined')
       AND re.created_at >= ?${esq.clause.replace(/session_id/g, 'r.session_id')}
     GROUP BY assist_type`
  ).bind(since, ...esq.binds).all();

  const rideImpact = await env.DB.prepare(
    `SELECT
      CASE WHEN dda_skips_used > 0 THEN 'used_skip'
           WHEN dda_assists_accepted > 0 THEN 'used_assist'
           WHEN dda_assists_offered > 0 THEN 'declined_all'
           ELSE 'no_dda' END AS dda_group,
      COUNT(*) AS rides, SUM(completed) AS completed,
      ROUND(AVG(crash_count), 1) AS avg_crashes
     FROM rides WHERE level != 'tutorial' AND started_at >= ?${esq.clause}
     GROUP BY dda_group`
  ).bind(since, ...esq.binds).all();

  return { interventions: interventions.results, rideImpact: rideImpact.results };
}

// ============================================================
// HELPERS
// ============================================================

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400'
  };
}

function jsonResponse(data, status, corsOrigin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(corsOrigin || '*')
    }
  });
}

/**
 * A signed-in route. The handler gets the account (userId) and, last, the login the
 * session is (loginId): every write records both (#783).
 */
async function withAuth(request, env, corsOrigin, handler) {
  const auth = request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) return jsonResponse({ error: 'Unauthorized' }, 401, corsOrigin);
  let raw;
  try { raw = await verifyJWT(auth.slice(7), env.JWT_SECRET); } catch { return jsonResponse({ error: 'Unauthorized' }, 401, corsOrigin); }
  // #612: a session can outlive its account (deleted). One whose login moved to another
  // account (combined, separated) follows the login.
  const claims = await resolveSession(env, raw);
  if (!claims) return jsonResponse({ error: 'Account not found', code: 'account_gone' }, 401, corsOrigin);
  return handler(request, env, corsOrigin, claims.sub, claims.lid);
}

/**
 * POST /me/delete { confirm: 'DELETE' } — remove the House Tandem account and
 * every record on it, in one transaction: sign-ins, rides, achievements, daily
 * results, friends and pair records. A partner's own rides stay, with this
 * player taken off them. Their analytics sessions stay as anonymous counts: the account,
 * login, IP and device id are cleared in the same batch.
 */
async function handleDeleteAccount(request, env, corsOrigin, userId) {
  let body = {};
  try { body = await request.json(); } catch {}
  if (body.confirm !== 'DELETE') return jsonResponse({ error: 'Type DELETE to confirm' }, 400, corsOrigin);
  if (!freshEnough(await claimsFromRequest(request, env))) return needFreshSignIn(identityDeps(), corsOrigin, 'deleting your account');
  const key = userId;
  const counts = {};
  for (const [name, sql, arg] of [
    ['rides', 'SELECT COUNT(*) AS n FROM scores WHERE user_id = ?', userId],
    ['achievements', 'SELECT COUNT(DISTINCT achievement_id) AS n FROM user_achievements WHERE user_id = ?', userId],
    // the people ridden with (two people's record can be several rows, one per pair of logins)
    ['pairs', 'SELECT COUNT(DISTINCT CASE WHEN user_lo = ? THEN user_hi ELSE user_lo END) AS n FROM pairs WHERE (user_lo = ? OR user_hi = ?) AND user_lo != user_hi', key],
  ]) {
    const r = await env.DB.prepare(sql).bind(...(name === 'pairs' ? [arg, arg, arg] : [arg])).first();
    counts[name] = (r && r.n) || 0;
  }
  const mine = 'SELECT id FROM scores WHERE user_id = ?';
  const q = (sql, ...args) => env.DB.prepare(sql).bind(...args);
  await env.DB.batch([
    q(`UPDATE user_achievements SET score_id = NULL WHERE score_id IN (${mine})`, userId),
    q(`DELETE FROM score_contributions WHERE score_id IN (${mine})`, userId),
    q('UPDATE score_contributions SET player_user_id = NULL, player_login_id = NULL WHERE player_user_id = ?', userId),
    q('DELETE FROM scores WHERE user_id = ?', userId),
    q('DELETE FROM user_achievements WHERE user_id = ?', userId),
    q('DELETE FROM daily_results WHERE user_id = ?', userId),
    q('UPDATE daily_results SET partner_user_id = NULL, partner_login_id = NULL WHERE partner_user_id = ?', userId),
    q('DELETE FROM friends WHERE user_id = ? OR friend_user_id = ?', userId, userId),
    q('DELETE FROM pairs WHERE user_lo = ? OR user_hi = ?', key, key),
    q('DELETE FROM auth_requests WHERE link_user_id = ?', userId),
    q('DELETE FROM game_achievements WHERE user_id = ?', userId),
    q('DELETE FROM game_stats WHERE user_id = ?', userId),
    q('DELETE FROM game_playtime WHERE user_id = ?', userId),
    q('DELETE FROM discord_posts WHERE user_id = ?', userId),
    q('UPDATE ride_seats SET user_id = NULL, login_id = NULL WHERE user_id = ?', userId),
    // Before the logins go (it finds rows by them). Some account numbers are stored as "26.0".
    // The user agent stays non-NULL so a late write from an open tab can't fill the row in again.
    q(`UPDATE sessions SET google_uid = NULL, login_id = NULL, ip_address = NULL, device_id = NULL,
         user_agent = COALESCE(user_agent, '')
       WHERE google_uid IN (?, ?) OR login_id IN (SELECT login_id FROM user_logins WHERE user_id = ?)`,
      String(userId), `${userId}.0`, userId),
    q('DELETE FROM user_logins WHERE user_id = ?', userId),
    q('DELETE FROM users WHERE id = ?', userId),
  ]);
  // #612 · its link / combine notices (migration 0020; absent before it is applied).
  try {
    await env.DB.batch([
      q('DELETE FROM account_events WHERE user_id = ?', userId),
      // Another account's notice that names this one (combined earlier, separated since).
      q('UPDATE account_events SET from_user_id = NULL, from_name = NULL, moved_json = NULL WHERE from_user_id = ?', userId),
    ]);
  } catch (e) { if (!/no such (table|column)/i.test(String(e && e.message))) throw e; }
  // Its analytics consent answers (migration 0023; absent before it is applied).
  try {
    await env.DB.prepare('DELETE FROM consents WHERE user_id = ?').bind(userId).run();
  } catch (e) { if (!/no such (table|column)/i.test(String(e && e.message))) throw e; }
  writeMetric(env, 'account_deleted');
  return jsonResponse({ deleted: true, ...counts }, 200, corsOrigin);
}

// Dashboard auth: verify JWT + check email against allow-list
const DASHBOARD_EMAILS = [
  'pete@usersfirst.com',
  'pete@petegordon.com',
];

async function withDashboardAuth(request, env, corsOrigin, handler) {
  const auth = request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) {
    return jsonResponse({ error: 'Unauthorized — sign in required' }, 401, corsOrigin);
  }
  const token = auth.slice(7);
  let payload;
  try {
    payload = await verifyJWT(token, env.JWT_SECRET);
  } catch {
    return jsonResponse({ error: 'Invalid or expired token' }, 401, corsOrigin);
  }
  if (!payload.email || !DASHBOARD_EMAILS.includes(payload.email.toLowerCase())) {
    return jsonResponse({ error: 'Access denied — not authorized for dashboard' }, 403, corsOrigin);
  }
  // A session ended from the account (sign out everywhere, undo, delete) ends here too.
  const session = await resolveSession(env, payload);
  if (!session) return jsonResponse({ error: 'Invalid or expired token' }, 401, corsOrigin);
  return handler(request, env, corsOrigin, session.sub);
}

/**
 * #783 · a session token's claims as they stand now: `lid` is the login the session is,
 * `sub` the account that login belongs to today (see resolveSession). Null when the token
 * is bad or its account is gone.
 */
async function claimsFromToken(token, env) {
  try {
    return await resolveSession(env, await verifyJWT(token, env.JWT_SECRET));
  } catch {
    return null;
  }
}

/** The account id in a session token (or null). */
async function userFromToken(token, env) {
  const c = await claimsFromToken(token, env);
  return c ? c.sub : null;
}

/** The session's claims (sub, lid, iat, via...), or null. */
async function claimsFromRequest(request, env) {
  const auth = request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) return null;
  return claimsFromToken(auth.slice(7), env);
}

async function getUserFromRequest(request, env) {
  const c = await claimsFromRequest(request, env);
  return c ? c.sub : null;
}

/** { userId, loginId } for a request / a token, or null. */
async function sessionFromRequest(request, env) {
  const c = await claimsFromRequest(request, env);
  return c ? { userId: c.sub, loginId: c.lid } : null;
}
async function sessionFromToken(token, env) {
  const c = await claimsFromToken(token, env);
  return c ? { userId: c.sub, loginId: c.lid } : null;
}

// Simple JWT implementation using Web Crypto
async function createJWT(payload, secret, ttlSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  // A name can hold any character, and btoa takes only Latin-1: write the rest as \uXXXX,
  // so the token is plain ASCII and every reader's JSON.parse gives the name back.
  const json = JSON.stringify({ ...payload, iat: now, exp: now + (ttlSeconds || 86400 * 30) })
    .replace(/[\u0080-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  const body = btoa(json)
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const data = `${header}.${body}`;

  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  const sigStr = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

  return `${data}.${sigStr}`;
}

async function verifyJWT(token, secret) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid token');

  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
  );

  const data = `${parts[0]}.${parts[1]}`;
  const sig = Uint8Array.from(atob(parts[2].replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
  const valid = await crypto.subtle.verify('HMAC', key, sig, new TextEncoder().encode(data));
  if (!valid) throw new Error('Invalid signature');

  const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) throw new Error('Token expired');

  return payload;
}
