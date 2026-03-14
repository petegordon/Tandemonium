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

  // Create server JWT
  const jwt = await createJWT({ sub: userId, name, picture }, env.JWT_SECRET);

  return jsonResponse({ token: jwt, user: { id: userId, name, avatar: picture } }, 200, corsOrigin);
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
         difficulty || 'normal', safetyUsed ? 1 : 0, scoreMultiplier || 1.0).run();

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
  const diffFilter = url.searchParams.get('difficulty'); // 'chill' | 'normal' | 'daredevil'
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
  if (diffFilter && ['chill', 'normal', 'daredevil'].includes(diffFilter)) {
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
// HELPERS
// ============================================================

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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
