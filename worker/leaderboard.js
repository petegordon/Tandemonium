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
  if (allowed.includes(requestOrigin) || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(requestOrigin)) return requestOrigin;
  return allowed[0];
}

import {
  upsertIdentity, listIdentities,
  handleDiscordBegin, handleDiscordGo, handleDiscordCallback, handleDiscordConfirm, handleAuthPoll,
  handleSteamWebBegin, handleSteamWebGo, handleSteamWebCallback, handleDiscordMembership,
  handleHandoffCreate, handleHandoffRedeem, discordAvatarUrl, cleanDeviceId, claimGuestPairs,
} from './identity.js';
import { gameProfile, recordGame, handleMeGames } from './games.js';
import { handleShareRoute } from './share.js';   // #657

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
    const { userId } = await upsertIdentity(env, { provider: 'discord', providerId: discordId, name, avatar }, null, identityDeps());
    const user = await env.DB.prepare('SELECT display_name, avatar_url FROM users WHERE id = ?').bind(userId).first();
    return { userId, name: user ? user.display_name : name, avatar: user ? user.avatar_url : avatar };
  },
  async verifySession(env, token) {
    if (typeof token !== 'string' || token.length > 4096) return null;
    let payload;
    try { payload = await verifyJWT(token, env.JWT_SECRET); } catch { return null; }
    const user = await env.DB.prepare('SELECT id, display_name, avatar_url FROM users WHERE id = ?').bind(payload.sub).first();
    if (!user) return null;
    const ids = await listIdentities(env, user.id);
    const avatar = (ids.discord && ids.discord.avatar) || user.avatar_url;
    return { userId: user.id, name: user.display_name, avatar };
  },
  gameProfile: (env, userId, game) => gameProfile(env, userId, game),
  recordGame: (env, userId, game, delta, earned) => recordGame(env, userId, game, delta, earned),
};

/** What the identity module needs from this worker. */
const identityDeps = () => ({
  jsonResponse, createJWT, getUserFromRequest, pickCorsOrigin, writeMetric, mergePairKey, mergeGuestPairs,
});

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const requestOrigin = request.headers.get('Origin') || '';
    const corsOrigin = pickCorsOrigin(requestOrigin, env.CORS_ORIGIN);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(corsOrigin) });
    }

    try {
      const path = url.pathname;
      const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';

      // Auth routes
      if (path === '/auth/google' && request.method === 'POST') {
        const limited = await checkRateLimit(env.AUTH_LIMITER, clientIP, corsOrigin, env);
        if (limited) return limited;
        return handleGoogleAuth(request, env, corsOrigin);
      }
      if (path === '/auth/steam' && request.method === 'POST') {
        const limited = await checkRateLimit(env.AUTH_LIMITER, clientIP, corsOrigin, env);
        if (limited) return limited;
        return handleSteamAuth(request, env, corsOrigin);
      }

      // #612 · Discord sign-in (redirect on the same device, or a device code for TV / Steam)
      if (path === '/auth/discord/begin' && request.method === 'POST') {
        const limited = await checkRateLimit(env.AUTH_LIMITER, clientIP, corsOrigin, env);
        if (limited) return limited;
        return handleDiscordBegin(request, env, url, corsOrigin, identityDeps());
      }
      if (path === '/auth/discord/go' && request.method === 'GET') {
        const limited = await checkRateLimit(env.READ_LIMITER, clientIP, corsOrigin, env);
        if (limited) return limited;
        return handleDiscordGo(request, env, url);
      }
      if (path === '/auth/discord/callback' && request.method === 'GET') {
        const limited = await checkRateLimit(env.AUTH_LIMITER, clientIP, corsOrigin, env);
        if (limited) return limited;
        return handleDiscordCallback(request, env, url, identityDeps());
      }
      if (path === '/auth/discord/confirm' && request.method === 'POST') {
        const limited = await checkRateLimit(env.AUTH_LIMITER, clientIP, corsOrigin, env);
        if (limited) return limited;
        return handleDiscordConfirm(request, env, url, identityDeps());
      }
      // #612 · Steam on the web ("Sign in through Steam"); the Steam build uses /auth/steam with a ticket.
      if (path === '/auth/steam/begin' && request.method === 'POST') {
        const limited = await checkRateLimit(env.AUTH_LIMITER, clientIP, corsOrigin, env);
        if (limited) return limited;
        return handleSteamWebBegin(request, env, url, corsOrigin, identityDeps());
      }
      if (path === '/auth/steam/go' && request.method === 'GET') {
        const limited = await checkRateLimit(env.READ_LIMITER, clientIP, corsOrigin, env);
        if (limited) return limited;
        return handleSteamWebGo(request, env, url);
      }
      if (path === '/auth/steam/callback' && request.method === 'GET') {
        const limited = await checkRateLimit(env.AUTH_LIMITER, clientIP, corsOrigin, env);
        if (limited) return limited;
        return handleSteamWebCallback(request, env, url, identityDeps());
      }
      if (path === '/auth/poll' && request.method === 'POST') {
        const limited = await checkRateLimit(env.READ_LIMITER, clientIP, corsOrigin, env);
        if (limited) return limited;
        return handleAuthPoll(request, env, corsOrigin, identityDeps());
      }

      // Authed routes
      if (path === '/score' && request.method === 'POST') return withAuth(request, env, corsOrigin, submitScoreWithLimit);
      if (path === '/me') return withAuth(request, env, corsOrigin, getMe);
      if (path === '/me/games') {
        const limited = await checkRateLimit(env.READ_LIMITER, clientIP, corsOrigin, env);
        if (limited) return limited;
        return withAuth(request, env, corsOrigin, (req, e, c, uid) => handleMeGames(req, e, c, uid, identityDeps()));
      }
      // #612 · open another House Tandem site (dice) already signed in.
      if (path === '/auth/handoff' && request.method === 'POST') {
        const limited = await checkRateLimit(env.AUTH_LIMITER, clientIP, corsOrigin, env);
        if (limited) return limited;
        return withAuth(request, env, corsOrigin, (req, e, c, uid) => handleHandoffCreate(req, e, c, uid, identityDeps()));
      }
      if (path === '/auth/handoff/redeem' && request.method === 'POST') {
        const limited = await checkRateLimit(env.AUTH_LIMITER, clientIP, corsOrigin, env);
        if (limited) return limited;
        return handleHandoffRedeem(request, env, corsOrigin, identityDeps());
      }
      if (path === '/me/discord') {
        const limited = await checkRateLimit(env.READ_LIMITER, clientIP, corsOrigin, env);
        if (limited) return limited;
        return withAuth(request, env, corsOrigin, (req, e, c, uid) => handleDiscordMembership(req, e, c, uid, identityDeps()));
      }
      // #612 · delete the House Tandem account and everything on it (account page, typed confirmation).
      if (path === '/me/delete' && request.method === 'POST') {
        const limited = await checkRateLimit(env.AUTH_LIMITER, clientIP, corsOrigin, env);
        if (limited) return limited;
        return withAuth(request, env, corsOrigin, handleDeleteAccount);
      }
      if (path === '/achievements/sync' && request.method === 'POST') return withAuth(request, env, corsOrigin, syncAchievements);
      if (path === '/partners') return withAuth(request, env, corsOrigin, handlePartners);
      // D-6 / D-7 · the pair, and the day's ranked results of people you have
      // actually ridden with. There is no global daily board (decision 5).
      if (path === '/pair') return withAuth(request, env, corsOrigin, handlePair);
      if (path === '/daily' && request.method === 'POST') {
        const limited = await checkRateLimit(env.SCORE_LIMITER || env.READ_LIMITER, clientIP, corsOrigin, env);
        if (limited) return limited;
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
        const limited = await checkRateLimit(env.READ_LIMITER, clientIP, corsOrigin, env);
        if (limited) return limited;
        return handleLeaderboard(request, env, url, corsOrigin);
      }
      if (path.startsWith('/player/')) {
        const limited = await checkRateLimit(env.READ_LIMITER, clientIP, corsOrigin, env);
        if (limited) return limited;
        return handlePlayerProfile(request, env, url, corsOrigin);
      }

      // ---- Analytics routes (fire-and-forget, no auth required) ----
      if (path === '/api/analytics/session' && request.method === 'POST') {
        const limited = await checkRateLimit(env.ANALYTICS_SESSION_LIMITER, clientIP, corsOrigin, env);
        if (limited) return limited;
        return handleAnalyticsSession(request, env, corsOrigin, clientIP);
      }
      if (path.match(/^\/api\/analytics\/session\/[^/]+$/) && request.method === 'PUT') {
        // Its own budget: updates used to share the create limit, so a burst of
        // them (a controller seated over and over) made the NEXT session's
        // create 429, and every event of that session then failed.
        const limited = await checkRateLimit(env.ANALYTICS_SESSION_UPDATE_LIMITER || env.ANALYTICS_SESSION_LIMITER, clientIP, corsOrigin, env);
        if (limited) return limited;
        const sessId = path.split('/')[4];
        return handleAnalyticsSessionUpdate(request, env, corsOrigin, sessId, clientIP);
      }
      if (path === '/api/analytics/event/batch' && request.method === 'POST') {
        const limited = await checkRateLimit(env.ANALYTICS_EVENT_LIMITER, clientIP, corsOrigin, env);
        if (limited) return limited;
        return handleAnalyticsEventBatch(request, env, corsOrigin);
      }
      if (path === '/api/analytics/ride' && request.method === 'POST') {
        const limited = await checkRateLimit(env.ANALYTICS_RIDE_LIMITER, clientIP, corsOrigin, env);
        if (limited) return limited;
        return handleAnalyticsRideCreate(request, env, corsOrigin);
      }
      if (path.match(/^\/api\/analytics\/ride\/[^/]+$/) && request.method === 'PUT') {
        const limited = await checkRateLimit(env.ANALYTICS_RIDE_LIMITER, clientIP, corsOrigin, env);
        if (limited) return limited;
        const rideId = path.split('/')[4];
        return handleAnalyticsRideUpdate(request, env, corsOrigin, rideId);
      }
      if (path.match(/^\/api\/analytics\/ride\/[^/]+\/events$/) && request.method === 'POST') {
        const limited = await checkRateLimit(env.ANALYTICS_EVENT_LIMITER, clientIP, corsOrigin, env);
        if (limited) return limited;
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
        const limited = await checkRateLimit(env.READ_LIMITER, clientIP, corsOrigin, env);
        if (limited) return limited;
        const dashRoute = path.replace('/api/analytics/dashboard/', '');
        return withDashboardAuth(request, env, corsOrigin, () =>
          handleDashboard(dashRoute, url, env, corsOrigin)
        );
      }

      return jsonResponse({ error: 'Not found' }, 404, corsOrigin);
    } catch (e) {
      try { writeMetric(env, 'error', e.message); } catch (_) { /* don't mask original error */ }
      return jsonResponse({ error: e.message }, 500, corsOrigin);
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
    return jsonResponse({ error: e.message }, 401, corsOrigin);
  }

  writeMetric(env, 'auth_google');

  const googleId = payload.sub;
  const name = payload.name || 'Player';
  const picture = payload.picture || null;
  const email = payload.email || null;

  // #612: Google is a legacy sign-in; its users keep their account.
  const { userId } = await upsertIdentity(env, { provider: 'google', providerId: googleId, name, avatar: picture }, null, identityDeps());
  await claimGuestPairs(env, cleanDeviceId(body.device_id), userId, identityDeps());   // #678

  // Create server JWT (include email for dashboard access control)
  const jwt = await createJWT({ sub: userId, name, picture, email }, env.JWT_SECRET);

  const identities = await listIdentities(env, userId);
  return jsonResponse({ token: jwt, user: { id: userId, name, avatar: picture, identities } }, 200, corsOrigin);
}

async function handleSteamAuth(request, env, corsOrigin) {
  if (!env.STEAM_WEB_API_KEY) {
    return jsonResponse({ error: 'Steam authentication not configured' }, 503, corsOrigin);
  }

  const body = await request.json();
  const { steamId, personaName, ticket } = body;
  if (!steamId || !ticket) return jsonResponse({ error: 'Missing steamId or ticket' }, 400, corsOrigin);

  // Verify the auth ticket via Steam Web API
  // Try both the playtest app ID and the main game app ID
  const appIds = [4510250, 4482940];
  let verified = false;
  let verifiedSteamId = null;
  let lastError = null;

  for (const appId of appIds) {
    try {
      const verifyUrl = `https://api.steampowered.com/ISteamUserAuth/AuthenticateUserTicket/v1/?key=${env.STEAM_WEB_API_KEY}&appid=${appId}&ticket=${ticket}`;
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
    return jsonResponse({ error: 'Steam ticket invalid', detail: lastError }, 401, corsOrigin);
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
  const { userId } = await upsertIdentity(env, { provider: 'steam', providerId: steamId, name, avatar: avatarUrl }, null, identityDeps());
  await claimGuestPairs(env, cleanDeviceId(body.device_id), userId, identityDeps());   // #678

  const jwt = await createJWT({ sub: userId, name, picture: avatarUrl }, env.JWT_SECRET);

  const identities = await listIdentities(env, userId);
  return jsonResponse({ token: jwt, user: { id: userId, name, avatar: avatarUrl, identities } }, 200, corsOrigin);
}

// ============================================================
// SCORES
// ============================================================

async function submitScore(request, env, corsOrigin, userId) {
  const body = await request.json();
  const { levelId, distance, timeMs, collectiblesCount, inputSource, contributions, newAchievements,
          difficulty, safetyUsed, scoreMultiplier } = body;
  let { mode } = body;

  if (!levelId || !distance || !timeMs) {
    return jsonResponse({ error: 'Missing required fields' }, 400, corsOrigin);
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
      let p;
      try { p = await verifyJWT(seat.token, env.JWT_SECRET); } catch { continue; }
      const sid = p && p.sub;
      if (!sid || String(sid) === String(userId) || seatRiders.some((r) => String(r.userId) === String(sid))) continue;
      seatRiders.push({ userId: sid, role: seat.role, newAchievements: Array.isArray(seat.newAchievements) ? seat.newAchievements.slice(0, 100) : [] });
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

  // Insert score
  const scoreRes = await env.DB.prepare(
    'INSERT INTO scores (user_id, level_id, distance, time_ms, mode, collectibles_count, input_source, difficulty, safety_used, score_multiplier) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(userId, levelId, distance, timeMs, mode || 'solo', collectiblesCount || 0, inputSource || 'none',
         difficulty || 'adventurous', safetyUsed ? 1 : 0, scoreMultiplier || 1.0).run();

  const scoreId = scoreRes.meta.last_row_id;

  // Batch insert contributions and achievements in a single round-trip
  const batchStmts = [];

  // A local ride's contribution ids come from the checked sign-ins, never the body.
  if (contributions && isLocal) {
    for (const [role, stats] of Object.entries(contributions)) {
      if (!stats || typeof stats !== 'object') continue;
      const seat = seatRiders.find((r) => r.role === role);
      stats.userId = role === 'captain' ? userId : (seat ? seat.userId : null);
      delete stats.guestDeviceId;
    }
  }

  if (contributions) {
    for (const [role, stats] of Object.entries(contributions)) {
      batchStmts.push(
        env.DB.prepare(
          `INSERT INTO score_contributions
           (score_id, role, player_user_id, contribution_pct, pedal_taps, pedal_correct, pedal_wrong, pedal_power,
            balance_safe_pct, balance_danger_pct, on_road_pct, center_pct, avg_lateral_offset)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          scoreId, role, stats.userId || null, stats.overallPct || 0,
          stats.totalTaps || 0, stats.correctTaps || 0, stats.wrongTaps || 0, stats.totalPower || 0,
          stats.safePct || 0, stats.dangerPct || 0, stats.onRoadPct || 0, stats.centerPct || 0,
          stats.avgLateral || 0
        )
      );
    }
  }

  if (newAchievements && Array.isArray(newAchievements)) {
    for (const achId of newAchievements) {
      batchStmts.push(
        env.DB.prepare(
          'INSERT OR IGNORE INTO user_achievements (user_id, achievement_id, score_id) VALUES (?, ?, ?)'
        ).bind(userId, achId, scoreId)
      );
    }
  }

  if (batchStmts.length > 0) {
    await env.DB.batch(batchStmts);
  }

  // #612 · each signed-in seat's own copy of the ride, and the achievements it earned them.
  for (const seat of seatRiders) {
    try {
      await env.DB.prepare(
        'INSERT INTO scores (user_id, level_id, distance, time_ms, mode, collectibles_count, input_source, difficulty, safety_used, score_multiplier) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(seat.userId, levelId, distance, timeMs, seat.role, collectiblesCount || 0, inputSource || 'none',
             difficulty || 'adventurous', safetyUsed ? 1 : 0, scoreMultiplier || 1.0).run();
      const achStmts = seat.newAchievements.filter((a) => typeof a === 'string' && a.length <= 64).map((achId) =>
        env.DB.prepare('INSERT OR IGNORE INTO user_achievements (user_id, achievement_id, score_id) VALUES (?, ?, ?)').bind(seat.userId, achId, scoreId));
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
    const riders = [];
    for (const [role, stats] of Object.entries(contributions)) {
      if (role === 'solo') continue;
      if (stats.userId) riders.push(String(stats.userId));
      else if (stats.guestDeviceId) riders.push('guest:' + stats.guestDeviceId);
    }
    if (riders.length === 2) {
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
  if (!a || !b || String(a) === String(b)) return;
  const [lo, hi] = pairKey(a, b);

  const existing = await env.DB.prepare(
    'SELECT * FROM pairs WHERE user_lo = ? AND user_hi = ?'
  ).bind(lo, hi).first();

  let best = {};
  try { best = existing && existing.best_json ? JSON.parse(existing.best_json) : {}; } catch { best = {}; }
  if (levelId && typeof timeMs === 'number' && timeMs > 0) {
    if (!best[levelId] || timeMs < best[levelId]) best[levelId] = timeMs;
  }

  // The pair's daily streak counts CONSECUTIVE DAYS here only when the ride was
  // on Today's Road; ordinary rides update everything else and leave it alone.
  let streak = existing ? existing.daily_streak : 0;
  let bestStreak = existing ? existing.daily_best_streak : 0;
  let lastKey = existing ? existing.daily_last_key : null;
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
    `INSERT INTO pairs (user_lo, user_hi, rides, distance, best_json, last_ride,
                        daily_streak, daily_best_streak, daily_last_key)
     VALUES (?, ?, 1, ?, ?, datetime('now'), ?, ?, ?)
     ON CONFLICT(user_lo, user_hi) DO UPDATE SET
       rides = rides + 1,
       distance = distance + excluded.distance,
       best_json = excluded.best_json,
       last_ride = excluded.last_ride,
       daily_streak = excluded.daily_streak,
       daily_best_streak = excluded.daily_best_streak,
       daily_last_key = excluded.daily_last_key`
  ).bind(lo, hi, distance || 0, JSON.stringify(best), streak, bestStreak, lastKey).run();
}

function dayGap(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}

/** D-8 · GET /pair?with=<userId|guest:id> — what the two of you have done. */
async function handlePair(request, env, corsOrigin, userId) {
  const url = new URL(request.url);
  const other = url.searchParams.get('with');
  if (!other) return jsonResponse({ error: 'Missing ?with' }, 400, corsOrigin);

  const [lo, hi] = pairKey(userId, other);
  let row;
  try {
    row = await env.DB.prepare(
      'SELECT * FROM pairs WHERE user_lo = ? AND user_hi = ?'
    ).bind(lo, hi).first();
  } catch (e) {
    // Migration 0009 (pairs) is applied by hand after the worker deploys;
    // until then there is simply no history to show.
    if (!/no such table: pairs/.test(String(e && e.message))) throw e;
    row = null;
  }

  if (!row) {
    return jsonResponse({ pair: null, rides: 0, distance: 0, best: {}, daily_streak: 0 }, 200, corsOrigin);
  }
  let best = {};
  try { best = row.best_json ? JSON.parse(row.best_json) : {}; } catch { best = {}; }
  return jsonResponse({
    pair: [row.user_lo, row.user_hi],
    rides: row.rides,
    distance: row.distance,
    best,
    last_ride: row.last_ride,
    daily_streak: row.daily_streak,
    daily_best_streak: row.daily_best_streak
  }, 200, corsOrigin);
}

/**
 * D-6 / #641 · POST /daily — a finished Daily Ride. The board shows each
 * account's BEST time of the day per mode, so a faster finish replaces the
 * row and a slower one changes nothing. A DNF (only pre-#641 builds send one)
 * is kept only when the day has no row yet, and never replaces a finish.
 * Responds { success, improved } — improved = this ride is now the day's best.
 */
async function handleDailySubmit(request, env, corsOrigin, userId) {
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
  if (!dnf && !(timeMs >= 30000 && timeMs <= 900000)) {
    return jsonResponse({ error: 'Implausible time' }, 400, corsOrigin);
  }

  const res = await env.DB.prepare(dailyUpsertSql(!!dnf)).bind(
    userId, dayKey, mode, dnf ? null : Math.round(timeMs), dnf ? 1 : 0,
    distance || 0, collectibles || 0, crashes || 0, safetyUsed ? 1 : 0,
    typeof syncPct === 'number' ? Math.round(syncPct) : null,
    partnerUserId || null, warp ? 1 : 0
  ).run();
  const improved = !dnf && !!(res && res.meta && res.meta.changes > 0);

  writeMetric(env, 'daily_submit', mode);
  return jsonResponse({ success: true, improved }, 200, corsOrigin);
}

/**
 * #641 · the daily_results write. One row per (user, day, mode) stays the rule
 * (the UNIQUE key); what changed is that a better time UPDATES it. A finish
 * replaces a DNF or a slower finish; a DNF only fills an empty day.
 */
export function dailyUpsertSql(dnf) {
  const insert = `INSERT INTO daily_results
       (user_id, day_key, mode, time_ms, dnf, distance, collectibles, crashes, safety_used, sync_pct, partner_user_id, warp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  if (dnf) return insert + `
       ON CONFLICT(user_id, day_key, mode) DO NOTHING`;
  return insert + `
       ON CONFLICT(user_id, day_key, mode) DO UPDATE SET
         time_ms = excluded.time_ms, dnf = 0, distance = excluded.distance,
         collectibles = excluded.collectibles, crashes = excluded.crashes,
         safety_used = excluded.safety_used, sync_pct = excluded.sync_pct,
         partner_user_id = excluded.partner_user_id, warp = excluded.warp
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

  const me = String(userId);
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
           WHERE (p.user_lo = ? AND p.user_hi = CAST(d.user_id AS TEXT))
              OR (p.user_hi = ? AND p.user_lo = CAST(d.user_id AS TEXT))
         )
       )
     ORDER BY d.dnf ASC, d.time_ms ASC`
  ).bind(key, userId, me, me).all();

  return jsonResponse({
    key,
    results: rows.results || [],
    note: 'You and the people you have ridden with. There is no global daily board.'
  }, 200, corsOrigin);
}

/** The day key the server considers current (09:00 UTC rollover). */
function dailyKeyUTC(now = Date.now()) {
  return new Date(now - 9 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * D-9 / #678 · when a guest signs in, the history they built as a guest
 * becomes theirs. Called on sign-in (/auth/steam, /auth/google, and the
 * Discord / Steam-web finish) with the device id the game sent.
 */
async function mergeGuestPairs(env, deviceId, userId) {
  if (!deviceId || !userId) return;
  return mergePairKey(env, 'guest:' + deviceId, String(userId));
}

/**
 * Fold every pair row keyed by `fromKey` into `toKey`: a guest who signed in,
 * or (#612) an account merged into another when a sign-in was linked.
 *
 *   - no row for the new pair yet: the guest row moves over as it is;
 *   - a row already there: rides and distance add up, the better time per
 *     level wins, the later last ride wins, the best streak is the larger;
 *   - a row between `fromKey` and `toKey` themselves (this device's guest rode
 *     with the account now signing in on it) would become a pair with
 *     yourself, so it is dropped.
 *
 * Each row's write and the guest row's delete go in one batch (a D1
 * transaction), so a retry after a failure never counts a ride twice, and a
 * second sign-in finds nothing left to move.
 */
async function mergePairKey(env, fromKey, toKey) {
  const guestKey = String(fromKey);
  const real = String(toKey);
  if (!guestKey || !real || guestKey === real) return;

  const rows = await env.DB.prepare(
    'SELECT * FROM pairs WHERE user_lo = ? OR user_hi = ?'
  ).bind(guestKey, guestKey).all();

  for (const row of rows.results || []) {
    const other = row.user_lo === guestKey ? row.user_hi : row.user_lo;
    const dropGuestRow = env.DB.prepare(
      'DELETE FROM pairs WHERE user_lo = ? AND user_hi = ?'
    ).bind(row.user_lo, row.user_hi);
    if (other === real) {                               // riding with yourself
      await dropGuestRow.run();
      continue;
    }
    const [lo, hi] = pairKey(real, other);

    const target = await env.DB.prepare(
      'SELECT * FROM pairs WHERE user_lo = ? AND user_hi = ?'
    ).bind(lo, hi).first();

    let write;
    if (!target) {
      write = env.DB.prepare(
        `INSERT INTO pairs (user_lo, user_hi, rides, distance, best_json, last_ride,
                            daily_streak, daily_best_streak, daily_last_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(lo, hi, row.rides, row.distance, row.best_json, row.last_ride,
             row.daily_streak, row.daily_best_streak, row.daily_last_key);
    } else {
      // Both rows exist: add the rides together and keep the better times.
      let a = {}, b = {};
      try { a = target.best_json ? JSON.parse(target.best_json) : {}; } catch {}
      try { b = row.best_json ? JSON.parse(row.best_json) : {}; } catch {}
      for (const [level, t] of Object.entries(b)) {
        if (typeof t === 'number' && t > 0 && (!a[level] || t < a[level])) a[level] = t;
      }
      write = env.DB.prepare(
        `UPDATE pairs SET rides = rides + ?, distance = distance + ?, best_json = ?,
                          last_ride = NULLIF(MAX(COALESCE(last_ride, ''), COALESCE(?, '')), ''),
                          daily_best_streak = MAX(COALESCE(daily_best_streak, 0), ?)
         WHERE user_lo = ? AND user_hi = ?`
      ).bind(row.rides || 0, row.distance || 0, JSON.stringify(a), row.last_ride,
             row.daily_best_streak || 0, lo, hi);
    }
    await env.DB.batch([write, dropGuestRow]);
  }
}

// ============================================================
// LEADERBOARD
// ============================================================

async function handleLeaderboard(request, env, url, corsOrigin) {
  const levelId = url.searchParams.get('level') || 'grandma';
  const scope = url.searchParams.get('scope') || 'global';
  const mode = url.searchParams.get('mode');       // 'solo' | 'together'
  const diffFilter = url.searchParams.get('difficulty'); // 'chill' | 'adventurous' | 'daredevil'
  const userFilter = url.searchParams.get('user_id'); // 'me'
  let limit = Math.min(parseInt(url.searchParams.get('limit') || '20'), 200);

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
    conditions.push('(s.user_id = ? OR s.user_id IN (SELECT friend_id FROM friends WHERE user_id = ?))');
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

  // Batch contributions (fixes N+1)
  const scoreIds = rows.map(r => r.id);
  const placeholders = scoreIds.map(() => '?').join(',');

  const contribResults = await env.DB.prepare(
    `SELECT sc.score_id, sc.role, sc.contribution_pct, sc.pedal_taps, sc.pedal_correct, sc.pedal_wrong,
            sc.balance_safe_pct, sc.on_road_pct, sc.player_user_id,
            u.display_name as partner_name, u.avatar_url as partner_avatar
     FROM score_contributions sc
     LEFT JOIN users u ON sc.player_user_id = u.id
     WHERE sc.score_id IN (${placeholders})`
  ).bind(...scoreIds).all();

  const contribMap = {};
  for (const c of contribResults.results) {
    if (!contribMap[c.score_id]) contribMap[c.score_id] = [];
    contribMap[c.score_id].push(c);
  }

  // Batch achievements (fixes N+1)
  const userIds = [...new Set(rows.map(r => r.user_id))];
  const userPlaceholders = userIds.map(() => '?').join(',');

  const achResults = await env.DB.prepare(
    `SELECT user_id, achievement_id, score_id FROM user_achievements WHERE user_id IN (${userPlaceholders})`
  ).bind(...userIds).all();

  const achMap = {};
  for (const a of achResults.results) {
    if (!achMap[a.user_id]) achMap[a.user_id] = [];
    achMap[a.user_id].push(a);
  }

  // Assemble entries
  const entries = rows.map(row => ({
    ...row,
    contributions: contribMap[row.id] || [],
    achievements: (achMap[row.user_id] || []).map(a => ({ achievement_id: a.achievement_id, score_id: a.score_id }))
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
  const parts = url.pathname.split('/');
  const playerId = parseInt(parts[2]);
  if (!playerId) return jsonResponse({ error: 'Invalid player ID' }, 400, corsOrigin);

  const levelFilter = url.searchParams.get('level');

  const user = await env.DB.prepare('SELECT id, display_name, avatar_url, created_at FROM users WHERE id = ?')
    .bind(playerId).first();
  if (!user) return jsonResponse({ error: 'Player not found' }, 404, corsOrigin);

  const achievements = await env.DB.prepare(
    'SELECT achievement_id, earned_at, score_id FROM user_achievements WHERE user_id = ?'
  ).bind(playerId).all();

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

async function getMe(request, env, corsOrigin, userId) {
  const user = await env.DB.prepare('SELECT id, display_name, avatar_url, created_at FROM users WHERE id = ?')
    .bind(userId).first();

  const achievements = await env.DB.prepare(
    'SELECT achievement_id, earned_at, score_id FROM user_achievements WHERE user_id = ?'
  ).bind(userId).all();

  const bestScores = await env.DB.prepare(
    `SELECT level_id, MIN(time_ms) as best_time, MAX(distance) as max_distance, COUNT(*) as rides
     FROM scores WHERE user_id = ? GROUP BY level_id`
  ).bind(userId).all();

  // #612: every sign-in linked to the account (the TV's Profile pill shows Discord + Steam).
  if (user) user.identities = await listIdentities(env, userId);

  return jsonResponse({
    user,
    achievements: achievements.results,
    bestScores: bestScores.results
  }, 200, corsOrigin);
}

async function syncAchievements(request, env, corsOrigin, userId) {
  const body = await request.json();
  const { achievements } = body;

  if (!Array.isArray(achievements)) {
    return jsonResponse({ error: 'Invalid achievements' }, 400, corsOrigin);
  }

  let synced = 0;
  for (const achId of achievements) {
    const res = await env.DB.prepare(
      'INSERT OR IGNORE INTO user_achievements (user_id, achievement_id) VALUES (?, ?)'
    ).bind(userId, achId).run();
    if (res.meta.changes > 0) synced++;
  }

  // Return all server-side achievements
  const serverAchs = await env.DB.prepare(
    'SELECT achievement_id, earned_at, score_id FROM user_achievements WHERE user_id = ?'
  ).bind(userId).all();

  return jsonResponse({
    synced,
    achievements: serverAchs.results
  }, 200, corsOrigin);
}

// ============================================================
// RELAY TOKEN
// ============================================================

async function issueRelayToken(request, env, corsOrigin, userId) {
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
  const token = await createJWT({ sub: userId, room, role }, env.RELAY_SECRET, 300);
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

async function submitScoreWithLimit(request, env, corsOrigin, userId) {
  const limited = await checkRateLimit(env.SCORE_LIMITER, 'user:' + userId, corsOrigin, env);
  if (limited) return limited;
  return submitScore(request, env, corsOrigin, userId);
}

// ============================================================
// ANALYTICS HANDLERS
// ============================================================

function isValidUUID(str) {
  return typeof str === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

async function handleAnalyticsSession(request, env, corsOrigin, clientIP) {
  const body = await request.json();
  if (!body.id || !isValidUUID(body.id)) {
    return jsonResponse({ error: 'Invalid session id' }, 400, corsOrigin);
  }

  const baseValues = [
    body.id,
    body.started_at || new Date().toISOString(),
    body.device_type || null,
    body.input_method || null,
    body.referrer || null,
    body.user_agent || null,
    body.is_stoker ? 1 : 0,
    body.joined_via_url ? 1 : 0,
    body.room_code || null,
    body.google_uid || null,
    body.platform || 'browser',
    body.screen_width || null,
    body.screen_height || null,
    clientIP || null,
  ];
  // A-9: anonymous per-browser id. Old clients don't send it; that is fine.
  const deviceId = typeof body.device_id === 'string' && body.device_id.length <= 64 ? body.device_id : null;

  // Upsert: the session may already exist as a placeholder that its events
  // created (see ensureSessions) when this create was late or rate-limited.
  // Fill it in; keep the earlier start time.
  const fill = (cols) => cols.map((c) => `${c} = COALESCE(excluded.${c}, sessions.${c})`).join(', ');
  const FILL = ['device_type', 'input_method', 'referrer', 'user_agent', 'room_code', 'google_uid',
    'platform', 'screen_width', 'screen_height', 'ip_address'];
  try {
    await env.DB.prepare(
      `INSERT INTO sessions (id, started_at, device_type, input_method, referrer, user_agent,
       is_stoker, joined_via_url, room_code, google_uid, platform, screen_width, screen_height, ip_address,
       device_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET started_at = MIN(sessions.started_at, excluded.started_at),
       is_stoker = MAX(sessions.is_stoker, excluded.is_stoker), joined_via_url = MAX(sessions.joined_via_url, excluded.joined_via_url),
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
       ON CONFLICT(id) DO UPDATE SET started_at = MIN(sessions.started_at, excluded.started_at),
       is_stoker = MAX(sessions.is_stoker, excluded.is_stoker), joined_via_url = MAX(sessions.joined_via_url, excluded.joined_via_url),
       ${fill(FILL)}`
    ).bind(...baseValues).run();
  }

  writeMetric(env, 'analytics_session');
  return jsonResponse({ success: true }, 200, corsOrigin);
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
      values.push(body[field]);
    }
  }

  // Always update IP address (captures it even for sessions created before migration)
  if (clientIP) {
    sets.push('ip_address = ?');
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
      e.event_type,
      e.event_data ? JSON.stringify(e.event_data) : null,
      e.created_at || new Date().toISOString(),
      e.page || null,
      e.input_method || null
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
    body.room_code || null,
    body.level || 'unknown',
    body.role || 'solo',
    body.difficulty || 'normal',
    body.input_method || 'unknown',
    body.controller_name || null,
    body.controller_connection || null,
    body.bike_preset || null,
    body.steering_feel ?? null,
    body.started_at || new Date().toISOString()
  ).run();

  writeMetric(env, 'analytics_ride_start', body.level);
  return jsonResponse({ success: true }, 200, corsOrigin);
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
      values.push(body[field]);
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
  const events = body.events;
  if (!Array.isArray(events) || events.length === 0) {
    return jsonResponse({ error: 'No events' }, 400, corsOrigin);
  }

  const stmt = env.DB.prepare(
    'INSERT INTO ride_events (ride_id, event_type, distance, event_data, created_at) VALUES (?, ?, ?, ?, ?)'
  );
  const batch = events.map(e =>
    stmt.bind(
      rideId,
      e.event_type,
      e.distance ?? null,
      e.event_data ? JSON.stringify(e.event_data) : null,
      e.created_at || new Date().toISOString()
    )
  );
  await env.DB.batch(batch);

  writeMetric(env, 'analytics_ride_events', String(events.length));
  return jsonResponse({ success: true }, 200, corsOrigin);
}

async function handleAnalyticsRoomCreate(request, env, corsOrigin) {
  const body = await request.json();
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
    ).bind(body.disconnect_count_increment, roomCode).run();
    delete body.disconnect_count_increment;
  }

  // Handle rides_played_increment
  if (body.rides_played_increment) {
    await env.DB.prepare(
      'UPDATE rooms SET rides_played = rides_played + ? WHERE code = ?'
    ).bind(body.rides_played_increment, roomCode).run();
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
      values.push(body[field]);
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
  if (!isValidUUID(body.session_id) || !body.action) {
    return jsonResponse({ error: 'Missing session_id or action' }, 400, corsOrigin);
  }
  await ensureSessions(env, [{ session_id: body.session_id, created_at: body.created_at }])[0].run();

  await env.DB.prepare(
    'INSERT INTO conversions (session_id, action, context, url, created_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(
    body.session_id,
    body.action,
    body.context || null,
    body.url || null,
    body.created_at || new Date().toISOString()
  ).run();

  writeMetric(env, 'analytics_conversion', body.action);
  return jsonResponse({ success: true }, 200, corsOrigin);
}

// ============================================================
// DASHBOARD QUERIES
// ============================================================

async function handleDashboard(route, url, env, corsOrigin) {
  const days = parseInt(url.searchParams.get('days') || '30');
  const since = new Date(Date.now() - days * 86400000).toISOString();

  // Developer exclusion: comma-separated IPs and/or google_uids
  const excludeIPs = (url.searchParams.get('exclude_ips') || '').split(',').map(s => s.trim()).filter(Boolean);
  const excludeUIDs = (url.searchParams.get('exclude_uids') || '').split(',').map(s => s.trim()).filter(Boolean);
  const ex = { ips: excludeIPs, uids: excludeUIDs };

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
  };

  // Also expose a 'dev_ips' route so the dashboard can show known developer IPs
  if (route === 'dev_ips') {
    const rows = await env.DB.prepare(
      `SELECT DISTINCT ip_address FROM sessions
       WHERE google_uid IN ('pete@usersfirst.com', 'pete@petegordon.com')
       AND ip_address IS NOT NULL`
    ).all();
    return jsonResponse({ ips: (rows.results || []).map(r => r.ip_address) }, 200, corsOrigin);
  }

  const handler = handlers[route];
  if (!handler) return jsonResponse({ error: 'Unknown dashboard route' }, 404, corsOrigin);

  const data = await handler();
  return jsonResponse(data, 200, corsOrigin);
}

// Build SQL exclusion for filtering out developer sessions.
// Two forms depending on whether the query already joins the sessions table:
//
// sessionFilter(ex, 's')  → " AND s.ip_address NOT IN (?) AND s.google_uid NOT IN (?)"
//   Use when query already has sessions aliased as 's'.
//
// sessionFilter(ex)       → same, default alias 's'
//
// For queries on tables that have session_id but no sessions join, use:
//   excludedSessionSubquery(ex) → "session_id NOT IN (SELECT id FROM sessions WHERE ip_address IN (?) OR google_uid IN (?))"
//   This returns { clause, binds } where clause is empty when no exclusions.

function sessionFilter(ex, alias = 's') {
  if (!ex || (ex.ips.length === 0 && ex.uids.length === 0)) return { clause: '', binds: [] };
  const parts = [];
  const binds = [];
  if (ex.ips.length > 0) {
    parts.push(`${alias}.ip_address NOT IN (${ex.ips.map(() => '?').join(',')})`);
    binds.push(...ex.ips);
  }
  if (ex.uids.length > 0) {
    parts.push(`${alias}.google_uid NOT IN (${ex.uids.map(() => '?').join(',')})`);
    binds.push(...ex.uids);
  }
  return { clause: ' AND ' + parts.join(' AND '), binds };
}

function excludedSessionSubquery(ex) {
  if (!ex || (ex.ips.length === 0 && ex.uids.length === 0)) return { clause: '', binds: [] };
  const conds = [];
  const binds = [];
  if (ex.ips.length > 0) {
    conds.push(`ip_address IN (${ex.ips.map(() => '?').join(',')})`);
    binds.push(...ex.ips);
  }
  if (ex.uids.length > 0) {
    conds.push(`google_uid IN (${ex.uids.map(() => '?').join(',')})`);
    binds.push(...ex.uids);
  }
  return {
    clause: ` AND session_id NOT IN (SELECT id FROM sessions WHERE ${conds.join(' OR ')})`,
    binds,
  };
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

async function withAuth(request, env, corsOrigin, handler) {
  const userId = await getUserFromRequest(request, env);
  if (!userId) return jsonResponse({ error: 'Unauthorized' }, 401, corsOrigin);
  // #612: a session can outlive its account (deleted, or merged into another).
  const exists = await env.DB.prepare('SELECT 1 AS ok FROM users WHERE id = ?').bind(userId).first();
  if (!exists) return jsonResponse({ error: 'Account not found', code: 'account_gone' }, 401, corsOrigin);
  return handler(request, env, corsOrigin, userId);
}

/**
 * POST /me/delete { confirm: 'DELETE' } — remove the House Tandem account and
 * every record on it, in one transaction: sign-ins, rides, achievements, daily
 * results, friends and pair records. A partner's own rides stay, with this
 * player taken off them. Anonymous analytics carry no account and stay.
 */
async function handleDeleteAccount(request, env, corsOrigin, userId) {
  let body = {};
  try { body = await request.json(); } catch {}
  if (body.confirm !== 'DELETE') return jsonResponse({ error: 'Type DELETE to confirm' }, 400, corsOrigin);
  const key = String(userId);
  const counts = {};
  for (const [name, sql, arg] of [
    ['rides', 'SELECT COUNT(*) AS n FROM scores WHERE user_id = ?', userId],
    ['achievements', 'SELECT COUNT(*) AS n FROM user_achievements WHERE user_id = ?', userId],
    ['pairs', 'SELECT COUNT(*) AS n FROM pairs WHERE user_lo = ? OR user_hi = ?', key],
  ]) {
    const r = await env.DB.prepare(sql).bind(...(name === 'pairs' ? [arg, arg] : [arg])).first();
    counts[name] = (r && r.n) || 0;
  }
  const mine = 'SELECT id FROM scores WHERE user_id = ?';
  const q = (sql, ...args) => env.DB.prepare(sql).bind(...args);
  await env.DB.batch([
    q(`UPDATE user_achievements SET score_id = NULL WHERE score_id IN (${mine})`, userId),
    q(`DELETE FROM score_contributions WHERE score_id IN (${mine})`, userId),
    q('UPDATE score_contributions SET player_user_id = NULL WHERE player_user_id = ?', userId),
    q('DELETE FROM scores WHERE user_id = ?', userId),
    q('DELETE FROM user_achievements WHERE user_id = ?', userId),
    q('DELETE FROM daily_results WHERE user_id = ?', userId),
    q('UPDATE daily_results SET partner_user_id = NULL WHERE partner_user_id = ?', userId),
    q('DELETE FROM friends WHERE user_id = ? OR friend_id = ?', userId, userId),
    q('DELETE FROM pairs WHERE user_lo = ? OR user_hi = ?', key, key),
    q('DELETE FROM auth_requests WHERE link_user_id = ?', userId),
    q('DELETE FROM game_achievements WHERE user_id = ?', userId),
    q('DELETE FROM game_stats WHERE user_id = ?', userId),
    q('DELETE FROM user_identities WHERE user_id = ?', userId),
    q('DELETE FROM users WHERE id = ?', userId),
  ]);
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
  return handler(request, env, corsOrigin, payload.sub);
}

async function getUserFromRequest(request, env) {
  const auth = request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  try {
    const payload = await verifyJWT(token, env.JWT_SECRET);
    return payload.sub;
  } catch {
    return null;
  }
}

// Simple JWT implementation using Web Crypto
async function createJWT(payload, secret, ttlSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const body = btoa(JSON.stringify({ ...payload, iat: now, exp: now + (ttlSeconds || 86400 * 30) }))
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
