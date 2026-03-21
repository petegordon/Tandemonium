// ============================================================
// LEADERBOARD API — Cloudflare Worker + D1
// ============================================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const requestOrigin = request.headers.get('Origin') || '';
    const allowed = env.CORS_ORIGIN || '*';
    const corsOrigin = (allowed === '*' || requestOrigin === allowed || /^https?:\/\/localhost(:\d+)?$/.test(requestOrigin))
      ? requestOrigin || allowed
      : allowed;

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

      // Authed routes
      if (path === '/score' && request.method === 'POST') return withAuth(request, env, corsOrigin, submitScoreWithLimit);
      if (path === '/me') return withAuth(request, env, corsOrigin, getMe);
      if (path === '/achievements/sync' && request.method === 'POST') return withAuth(request, env, corsOrigin, syncAchievements);
      if (path === '/partners') return withAuth(request, env, corsOrigin, handlePartners);
      if (path === '/relay-token' && request.method === 'POST') return withAuth(request, env, corsOrigin, issueRelayToken);

      // Public routes (rate limited by IP)
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
        return handleAnalyticsSession(request, env, corsOrigin);
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

  // Upsert user
  const existing = await env.DB.prepare(
    'SELECT id FROM users WHERE provider = ? AND provider_id = ?'
  ).bind('google', googleId).first();

  let userId;
  if (existing) {
    userId = existing.id;
    await env.DB.prepare(
      'UPDATE users SET display_name = ?, avatar_url = ? WHERE id = ?'
    ).bind(name, picture, userId).run();
  } else {
    const ins = await env.DB.prepare(
      'INSERT INTO users (provider, provider_id, display_name, avatar_url) VALUES (?, ?, ?, ?)'
    ).bind('google', googleId, name, picture).run();
    userId = ins.meta.last_row_id;
  }

  // Create server JWT (include email for dashboard access control)
  const jwt = await createJWT({ sub: userId, name, picture, email }, env.JWT_SECRET);

  return jsonResponse({ token: jwt, user: { id: userId, name, avatar: picture } }, 200, corsOrigin);
}

async function handleSteamAuth(request, env, corsOrigin) {
  if (!env.STEAM_WEB_API_KEY) {
    return jsonResponse({ error: 'Steam authentication not configured' }, 503, corsOrigin);
  }

  const body = await request.json();
  const { steamId, personaName, ticket } = body;
  if (!steamId || !ticket) return jsonResponse({ error: 'Missing steamId or ticket' }, 400, corsOrigin);

  // Verify the session ticket via Steam Web API
  try {
    const verifyUrl = `https://api.steampowered.com/ISteamUserAuth/AuthenticateUserTicket/v1/?key=${env.STEAM_WEB_API_KEY}&appid=4510250&ticket=${ticket}`;
    const steamRes = await fetch(verifyUrl, { signal: AbortSignal.timeout(5000) });
    if (!steamRes.ok) return jsonResponse({ error: 'Steam verification failed' }, 401, corsOrigin);
    const steamData = await steamRes.json();
    const params = steamData?.response?.params;
    if (!params || params.result !== 'OK') {
      return jsonResponse({ error: 'Steam ticket invalid' }, 401, corsOrigin);
    }
    // Verify the Steam ID matches the ticket
    if (params.steamid !== steamId) {
      return jsonResponse({ error: 'Steam ID mismatch' }, 401, corsOrigin);
    }
  } catch (e) {
    return jsonResponse({ error: 'Steam verification error: ' + e.message }, 500, corsOrigin);
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

  // Upsert user
  const existing = await env.DB.prepare(
    'SELECT id FROM users WHERE provider = ? AND provider_id = ?'
  ).bind('steam', steamId).first();

  let userId;
  if (existing) {
    userId = existing.id;
    await env.DB.prepare(
      'UPDATE users SET display_name = ?, avatar_url = ? WHERE id = ?'
    ).bind(name, avatarUrl, userId).run();
  } else {
    const ins = await env.DB.prepare(
      'INSERT INTO users (provider, provider_id, display_name, avatar_url) VALUES (?, ?, ?, ?)'
    ).bind('steam', steamId, name, avatarUrl).run();
    userId = ins.meta.last_row_id;
  }

  const jwt = await createJWT({ sub: userId, name, picture: avatarUrl }, env.JWT_SECRET);

  return jsonResponse({ token: jwt, user: { id: userId, name, avatar: avatarUrl } }, 200, corsOrigin);
}

// ============================================================
// SCORES
// ============================================================

async function submitScore(request, env, corsOrigin, userId) {
  const body = await request.json();
  const { levelId, distance, timeMs, mode, collectiblesCount, inputSource, contributions, newAchievements,
          difficulty, safetyUsed, scoreMultiplier } = body;

  if (!levelId || !distance || !timeMs) {
    return jsonResponse({ error: 'Missing required fields' }, 400, corsOrigin);
  }

  // Validate level ID
  const VALID_LEVELS = ['grandma', 'castle'];
  if (!VALID_LEVELS.includes(levelId)) {
    return jsonResponse({ error: 'Invalid level' }, 400, corsOrigin);
  }

  // Validate mode
  const VALID_MODES = ['solo', 'captain', 'stoker'];
  if (mode && !VALID_MODES.includes(mode)) {
    return jsonResponse({ error: 'Invalid mode' }, 400, corsOrigin);
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

async function handleAnalyticsSession(request, env, corsOrigin) {
  const body = await request.json();
  if (!body.id || !isValidUUID(body.id)) {
    return jsonResponse({ error: 'Invalid session id' }, 400, corsOrigin);
  }

  await env.DB.prepare(
    `INSERT OR IGNORE INTO sessions (id, started_at, device_type, input_method, referrer, user_agent,
     is_stoker, joined_via_url, room_code, google_uid, platform, screen_width, screen_height)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
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
    body.screen_height || null
  ).run();

  writeMetric(env, 'analytics_session');
  return jsonResponse({ success: true }, 200, corsOrigin);
}

async function handleAnalyticsEventBatch(request, env, corsOrigin) {
  const body = await request.json();
  const events = body.events;
  if (!Array.isArray(events) || events.length === 0) {
    return jsonResponse({ error: 'No events' }, 400, corsOrigin);
  }

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
  await env.DB.batch(batch);

  writeMetric(env, 'analytics_events', String(events.length));
  return jsonResponse({ success: true }, 200, corsOrigin);
}

async function handleAnalyticsRideCreate(request, env, corsOrigin) {
  const body = await request.json();
  if (!body.id || !isValidUUID(body.id)) {
    return jsonResponse({ error: 'Invalid ride id' }, 400, corsOrigin);
  }
  if (!body.session_id || !isValidUUID(body.session_id)) {
    return jsonResponse({ error: 'Invalid session_id' }, 400, corsOrigin);
  }

  await env.DB.prepare(
    `INSERT OR IGNORE INTO rides (id, session_id, room_code, level, role, difficulty,
     input_method, bike_preset, steering_feel, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    body.id,
    body.session_id,
    body.room_code || null,
    body.level || 'unknown',
    body.role || 'solo',
    body.difficulty || 'normal',
    body.input_method || 'unknown',
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
    'dda_assists_offered', 'dda_assists_accepted', 'dda_skips_used', 'safety_used'
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
    'p2p_upgrade_succeeded', 'video_enabled', 'audio_enabled'
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
  if (!body.session_id || !body.action) {
    return jsonResponse({ error: 'Missing session_id or action' }, 400, corsOrigin);
  }

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

  const handlers = {
    daily: () => dashDaily(env, since),
    funnel: () => dashFunnel(env, since),
    rides: () => dashRides(env, since),
    crashes: () => dashCrashes(env, since),
    conversions: () => dashConversions(env, since),
    network: () => dashNetwork(env, since),
    devices: () => dashDevices(env, since),
    dda: () => dashDDA(env, since),
    overview: () => dashOverview(env, since),
  };

  const handler = handlers[route];
  if (!handler) return jsonResponse({ error: 'Unknown dashboard route' }, 404, corsOrigin);

  const data = await handler();
  return jsonResponse(data, 200, corsOrigin);
}

async function dashOverview(env, since) {
  const sessions = await env.DB.prepare(
    `SELECT COUNT(*) as total, COUNT(CASE WHEN is_stoker = 1 THEN 1 END) as stokers,
     COUNT(CASE WHEN joined_via_url = 1 THEN 1 END) as url_joins
     FROM sessions WHERE started_at >= ?`
  ).bind(since).first();

  const rides = await env.DB.prepare(
    `SELECT COUNT(*) as total, SUM(completed) as completed,
     COUNT(CASE WHEN level = 'tutorial' THEN 1 END) as tutorials
     FROM rides WHERE started_at >= ?`
  ).bind(since).first();

  const conversions = await env.DB.prepare(
    `SELECT COUNT(*) as total,
     COUNT(CASE WHEN action = 'steam_wishlist_click' THEN 1 END) as steam_clicks,
     COUNT(CASE WHEN action = 'replay_click' THEN 1 END) as replays,
     COUNT(CASE WHEN action = 'room_code_generated' THEN 1 END) as rooms_created
     FROM conversions WHERE created_at >= ?`
  ).bind(since).first();

  const rooms = await env.DB.prepare(
    `SELECT COUNT(*) as total,
     COUNT(stoker_joined_at) as stokers_joined,
     COUNT(CASE WHEN webrtc_connected = 1 THEN 1 END) as connected
     FROM rooms WHERE created_at >= ?`
  ).bind(since).first();

  return { sessions, rides, conversions, rooms };
}

async function dashDaily(env, since) {
  const rows = await env.DB.prepare(
    `SELECT DATE(s.started_at) AS day,
     COUNT(DISTINCT s.id) AS sessions,
     COUNT(DISTINCT CASE WHEN s.is_stoker = 1 THEN s.id END) AS stoker_sessions,
     COUNT(DISTINCT r.id) AS total_rides,
     COUNT(DISTINCT CASE WHEN r.completed = 1 THEN r.id END) AS completed_rides,
     COUNT(DISTINCT CASE WHEN r.level = 'tutorial' THEN r.id END) AS tutorial_rides
     FROM sessions s
     LEFT JOIN rides r ON r.session_id = s.id
     WHERE s.started_at >= ?
     GROUP BY DATE(s.started_at)
     ORDER BY day DESC
     LIMIT 30`
  ).bind(since).all();
  return { daily: rows.results };
}

async function dashFunnel(env, since) {
  // Tutorial starts by input method
  const tutStarts = await env.DB.prepare(
    `SELECT input_method, COUNT(*) AS started
     FROM events WHERE event_type = 'tutorial_start' AND created_at >= ?
     GROUP BY input_method`
  ).bind(since).all();

  // Tutorial completions by input method
  const tutCompletes = await env.DB.prepare(
    `SELECT input_method, COUNT(*) AS completed
     FROM events WHERE event_type = 'tutorial_complete' AND created_at >= ?
     GROUP BY input_method`
  ).bind(since).all();

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
     WHERE event_type = 'tutorial_phase' AND created_at >= ?
     GROUP BY phase ORDER BY phase`
  ).bind(since).all();

  // Solo to MP: separate queries to avoid cross-table join issues
  const soloRiders = await env.DB.prepare(
    `SELECT COUNT(DISTINCT session_id) AS cnt FROM rides
     WHERE role IN ('captain', 'solo') AND started_at >= ?`
  ).bind(since).first();

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

async function dashRides(env, since) {
  const byLevel = await env.DB.prepare(
    `SELECT level, difficulty, input_method,
     COUNT(*) AS attempts, SUM(completed) AS completions,
     ROUND(AVG(CASE WHEN completed = 1 THEN duration_ms END) / 1000.0, 1) AS avg_time_sec,
     ROUND(AVG(crash_count), 1) AS avg_crashes,
     ROUND(AVG(timeout_count), 1) AS avg_timeouts
     FROM rides WHERE level != 'tutorial' AND started_at >= ?
     GROUP BY level, difficulty, input_method
     ORDER BY level, difficulty`
  ).bind(since).all();

  const abandons = await env.DB.prepare(
    `SELECT level, abandon_reason,
     COUNT(*) AS abandonments,
     ROUND(AVG(distance), 0) AS avg_distance,
     ROUND(AVG(crash_count), 1) AS avg_crashes
     FROM rides
     WHERE completed = 0 AND abandon_reason IS NOT NULL AND started_at >= ?
     GROUP BY level, abandon_reason
     ORDER BY level, abandonments DESC`
  ).bind(since).all();

  const steeringFeel = await env.DB.prepare(
    `SELECT
      CASE WHEN steering_feel < 0.33 THEN 'stable (0-0.33)'
           WHEN steering_feel < 0.67 THEN 'balanced (0.33-0.67)'
           ELSE 'responsive (0.67-1.0)' END AS feel_bucket,
      COUNT(*) AS rides, SUM(completed) AS completed,
      ROUND(AVG(crash_count), 1) AS avg_crashes
     FROM rides WHERE level != 'tutorial' AND steering_feel IS NOT NULL AND started_at >= ?
     GROUP BY feel_bucket`
  ).bind(since).all();

  const bikePresets = await env.DB.prepare(
    `SELECT bike_preset, COUNT(*) AS rides,
     COUNT(DISTINCT session_id) AS unique_players,
     SUM(completed) AS completed
     FROM rides WHERE level != 'tutorial' AND started_at >= ?
     GROUP BY bike_preset ORDER BY rides DESC`
  ).bind(since).all();

  return {
    byLevel: byLevel.results,
    abandons: abandons.results,
    steeringFeel: steeringFeel.results,
    bikePresets: bikePresets.results,
  };
}

async function dashCrashes(env, since) {
  const heatmap = await env.DB.prepare(
    `SELECT r.level,
     CAST(ROUND(re.distance / 10) * 10 AS INTEGER) AS distance_bucket,
     JSON_EXTRACT(re.event_data, '$.cause') AS cause,
     COUNT(*) AS crashes
     FROM ride_events re
     JOIN rides r ON re.ride_id = r.id
     WHERE re.event_type = 'crash' AND re.created_at >= ?
     GROUP BY r.level, distance_bucket, cause
     ORDER BY r.level, distance_bucket`
  ).bind(since).all();

  const timeouts = await env.DB.prepare(
    `SELECT r.level, r.difficulty,
     JSON_EXTRACT(re.event_data, '$.checkpoint_index') AS checkpoint,
     COUNT(*) AS timeouts
     FROM ride_events re
     JOIN rides r ON re.ride_id = r.id
     WHERE re.event_type = 'timeout' AND re.created_at >= ?
     GROUP BY r.level, r.difficulty, checkpoint
     ORDER BY r.level, checkpoint`
  ).bind(since).all();

  const pylons = await env.DB.prepare(
    `SELECT r.level,
     JSON_EXTRACT(re.event_data, '$.pylon_index') AS pylon,
     ROUND(re.distance, 0) AS distance_m,
     SUM(CASE WHEN re.event_type = 'pylon_pass' THEN 1 ELSE 0 END) AS passes,
     SUM(CASE WHEN re.event_type = 'pylon_hit' THEN 1 ELSE 0 END) AS hits
     FROM ride_events re
     JOIN rides r ON re.ride_id = r.id
     WHERE re.event_type IN ('pylon_pass', 'pylon_hit') AND re.created_at >= ?
     GROUP BY r.level, pylon ORDER BY r.level, re.distance`
  ).bind(since).all();

  return { heatmap: heatmap.results, timeouts: timeouts.results, pylons: pylons.results };
}

async function dashConversions(env, since) {
  const byAction = await env.DB.prepare(
    `SELECT action, context, COUNT(*) AS clicks,
     COUNT(DISTINCT session_id) AS unique_sessions
     FROM conversions WHERE created_at >= ?
     GROUP BY action, context ORDER BY clicks DESC`
  ).bind(since).all();

  const daily = await env.DB.prepare(
    `SELECT DATE(created_at) AS day, action, COUNT(*) AS clicks
     FROM conversions WHERE created_at >= ?
     GROUP BY day, action ORDER BY day DESC`
  ).bind(since).all();

  const clips = await env.DB.prepare(
    `SELECT DATE(created_at) AS day,
     COUNT(CASE WHEN event_type = 'clip_save' THEN 1 END) AS saved,
     COUNT(CASE WHEN event_type = 'clip_save' AND JSON_EXTRACT(event_data, '$.method') = 'share' THEN 1 END) AS shared,
     COUNT(CASE WHEN event_type = 'clip_discard' THEN 1 END) AS discarded
     FROM events WHERE event_type IN ('clip_save', 'clip_discard') AND created_at >= ?
     GROUP BY day ORDER BY day DESC`
  ).bind(since).all();

  return { byAction: byAction.results, daily: daily.results, clips: clips.results };
}

async function dashNetwork(env, since) {
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
     FROM rooms WHERE created_at >= ?`
  ).bind(since).first();

  const disconnects = await env.DB.prepare(
    `SELECT DATE(e.created_at) AS day,
     COUNT(CASE WHEN e.event_type = 'room_disconnect' THEN 1 END) AS disconnects,
     COUNT(CASE WHEN e.event_type = 'room_disconnect'
       AND JSON_EXTRACT(e.event_data, '$.during_ride') = 1 THEN 1 END) AS during_ride,
     COUNT(CASE WHEN e.event_type = 'room_reconnect' THEN 1 END) AS reconnects
     FROM events e
     WHERE e.event_type IN ('room_disconnect', 'room_reconnect') AND e.created_at >= ?
     GROUP BY day ORDER BY day DESC`
  ).bind(since).all();

  return { roomHealth, disconnects: disconnects.results };
}

async function dashDevices(env, since) {
  const devices = await env.DB.prepare(
    `SELECT device_type, platform, COUNT(*) AS sessions
     FROM sessions WHERE started_at >= ?
     GROUP BY device_type, platform ORDER BY sessions DESC`
  ).bind(since).all();

  const inputMethods = await env.DB.prepare(
    `SELECT input_method, COUNT(*) AS rides,
     SUM(completed) AS completed
     FROM rides WHERE started_at >= ? AND input_method IS NOT NULL
     GROUP BY input_method ORDER BY rides DESC`
  ).bind(since).all();

  return { devices: devices.results, inputMethods: inputMethods.results };
}

async function dashDDA(env, since) {
  const interventions = await env.DB.prepare(
    `SELECT JSON_EXTRACT(re.event_data, '$.type') AS assist_type,
     SUM(CASE WHEN re.event_type = 'dda_assist_offered' THEN 1 ELSE 0 END) AS offered,
     SUM(CASE WHEN re.event_type = 'dda_assist_accepted' THEN 1 ELSE 0 END) AS accepted,
     SUM(CASE WHEN re.event_type = 'dda_assist_declined' THEN 1 ELSE 0 END) AS declined
     FROM ride_events re
     WHERE re.event_type IN ('dda_assist_offered', 'dda_assist_accepted', 'dda_assist_declined')
       AND re.created_at >= ?
     GROUP BY assist_type`
  ).bind(since).all();

  const rideImpact = await env.DB.prepare(
    `SELECT
      CASE WHEN dda_skips_used > 0 THEN 'used_skip'
           WHEN dda_assists_accepted > 0 THEN 'used_assist'
           WHEN dda_assists_offered > 0 THEN 'declined_all'
           ELSE 'no_dda' END AS dda_group,
      COUNT(*) AS rides, SUM(completed) AS completed,
      ROUND(AVG(crash_count), 1) AS avg_crashes
     FROM rides WHERE level != 'tutorial' AND started_at >= ?
     GROUP BY dda_group`
  ).bind(since).all();

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
  return handler(request, env, corsOrigin, userId);
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
