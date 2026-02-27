// ============================================================
// LEADERBOARD API — Cloudflare Worker + D1
// ============================================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const corsOrigin = env.CORS_ORIGIN || '*';

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(corsOrigin) });
    }

    try {
      const path = url.pathname;

      // Auth routes
      if (path === '/auth/google') return handleGoogleAuth(env, url);
      if (path === '/auth/google/callback') return handleGoogleCallback(request, env, url, corsOrigin);

      // Authed routes
      if (path === '/score' && request.method === 'POST') return withAuth(request, env, corsOrigin, submitScore);
      if (path === '/me') return withAuth(request, env, corsOrigin, getMe);
      if (path === '/achievements/sync' && request.method === 'POST') return withAuth(request, env, corsOrigin, syncAchievements);

      // Public routes
      if (path === '/leaderboard') return handleLeaderboard(request, env, url, corsOrigin);
      if (path.startsWith('/player/')) return handlePlayerProfile(request, env, url, corsOrigin);

      return jsonResponse({ error: 'Not found' }, 404, corsOrigin);
    } catch (e) {
      return jsonResponse({ error: e.message }, 500, corsOrigin);
    }
  }
};

// ============================================================
// AUTH
// ============================================================

function handleGoogleAuth(env, url) {
  const redirectUri = `${url.origin}/auth/google/callback`;
  const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid profile email',
    prompt: 'select_account'
  });
  return Response.redirect(authUrl, 302);
}

async function handleGoogleCallback(request, env, url, corsOrigin) {
  const code = url.searchParams.get('code');
  if (!code) return jsonResponse({ error: 'Missing code' }, 400, corsOrigin);

  const redirectUri = `${url.origin}/auth/google/callback`;

  // Exchange code for tokens
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code'
    })
  });
  const tokens = await tokenRes.json();
  if (!tokens.access_token) return jsonResponse({ error: 'Token exchange failed' }, 400, corsOrigin);

  // Get user info
  const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${tokens.access_token}` }
  });
  const userInfo = await userRes.json();

  // Upsert user
  const existing = await env.DB.prepare(
    'SELECT id FROM users WHERE provider = ? AND provider_id = ?'
  ).bind('google', userInfo.id).first();

  let userId;
  if (existing) {
    userId = existing.id;
    await env.DB.prepare(
      'UPDATE users SET display_name = ?, avatar_url = ? WHERE id = ?'
    ).bind(userInfo.name, userInfo.picture, userId).run();
  } else {
    const ins = await env.DB.prepare(
      'INSERT INTO users (provider, provider_id, display_name, avatar_url) VALUES (?, ?, ?, ?)'
    ).bind('google', userInfo.id, userInfo.name, userInfo.picture).run();
    userId = ins.meta.last_row_id;
  }

  // Create JWT
  const jwt = await createJWT({ sub: userId, name: userInfo.name, picture: userInfo.picture }, env.JWT_SECRET);

  // Return HTML that posts message to opener and closes
  const html = `<!DOCTYPE html><html><body><script>
    window.opener.postMessage({ type: 'auth', token: '${jwt}', user: ${JSON.stringify({
      id: userId, name: userInfo.name, avatar: userInfo.picture
    })} }, '*');
    window.close();
  </script></body></html>`;

  return new Response(html, { headers: { 'Content-Type': 'text/html' } });
}

// ============================================================
// SCORES
// ============================================================

async function submitScore(request, env, corsOrigin, userId) {
  const body = await request.json();
  const { levelId, distance, timeMs, mode, collectiblesCount, contributions, newAchievements } = body;

  if (!levelId || !distance || !timeMs) {
    return jsonResponse({ error: 'Missing required fields' }, 400, corsOrigin);
  }

  // Insert score
  const scoreRes = await env.DB.prepare(
    'INSERT INTO scores (user_id, level_id, distance, time_ms, mode, collectibles_count) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(userId, levelId, distance, timeMs, mode || 'solo', collectiblesCount || 0).run();

  const scoreId = scoreRes.meta.last_row_id;

  // Insert contributions
  if (contributions) {
    for (const [role, stats] of Object.entries(contributions)) {
      await env.DB.prepare(
        `INSERT INTO score_contributions
         (score_id, role, player_user_id, contribution_pct, pedal_taps, pedal_correct, pedal_wrong, pedal_power,
          balance_safe_pct, balance_danger_pct, on_road_pct, center_pct, avg_lateral_offset)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        scoreId, role, stats.userId || null, stats.overallPct || 0,
        stats.totalTaps || 0, stats.correctTaps || 0, stats.wrongTaps || 0, stats.totalPower || 0,
        stats.safePct || 0, stats.dangerPct || 0, stats.onRoadPct || 0, stats.centerPct || 0,
        stats.avgLateral || 0
      ).run();
    }
  }

  // Save achievements
  if (newAchievements && Array.isArray(newAchievements)) {
    for (const achId of newAchievements) {
      await env.DB.prepare(
        'INSERT OR IGNORE INTO user_achievements (user_id, achievement_id, score_id) VALUES (?, ?, ?)'
      ).bind(userId, achId, scoreId).run();
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
// LEADERBOARD
// ============================================================

async function handleLeaderboard(request, env, url, corsOrigin) {
  const levelId = url.searchParams.get('level') || 'grandma';
  const scope = url.searchParams.get('scope') || 'global';
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '20'), 100);

  let query;
  let params;

  if (scope === 'global') {
    query = `
      SELECT s.id, s.distance, s.time_ms, s.mode, s.collectibles_count, s.created_at,
             u.display_name, u.avatar_url, u.id as user_id
      FROM scores s
      JOIN users u ON s.user_id = u.id
      WHERE s.level_id = ?
      ORDER BY s.time_ms ASC
      LIMIT ?`;
    params = [levelId, limit];
  } else {
    // Friends scope requires auth
    const userId = await getUserFromRequest(request, env);
    if (!userId) return jsonResponse({ error: 'Auth required for friends scope' }, 401, corsOrigin);

    query = `
      SELECT s.id, s.distance, s.time_ms, s.mode, s.collectibles_count, s.created_at,
             u.display_name, u.avatar_url, u.id as user_id
      FROM scores s
      JOIN users u ON s.user_id = u.id
      WHERE s.level_id = ? AND (s.user_id = ? OR s.user_id IN (SELECT friend_id FROM friends WHERE user_id = ?))
      ORDER BY s.time_ms ASC
      LIMIT ?`;
    params = [levelId, userId, userId, limit];
  }

  const results = await env.DB.prepare(query).bind(...params).all();

  // Fetch contributions for each score
  const entries = [];
  for (const row of results.results) {
    const contribs = await env.DB.prepare(
      'SELECT role, contribution_pct, pedal_taps, pedal_correct, pedal_wrong, balance_safe_pct, on_road_pct FROM score_contributions WHERE score_id = ?'
    ).bind(row.id).all();

    // Fetch player achievements
    const achievements = await env.DB.prepare(
      'SELECT achievement_id FROM user_achievements WHERE user_id = ?'
    ).bind(row.user_id).all();

    entries.push({
      ...row,
      contributions: contribs.results,
      achievements: achievements.results.map(a => a.achievement_id)
    });
  }

  return jsonResponse({ entries }, 200, corsOrigin);
}

// ============================================================
// PLAYER PROFILE
// ============================================================

async function handlePlayerProfile(request, env, url, corsOrigin) {
  const parts = url.pathname.split('/');
  const playerId = parseInt(parts[2]);
  if (!playerId) return jsonResponse({ error: 'Invalid player ID' }, 400, corsOrigin);

  const user = await env.DB.prepare('SELECT id, display_name, avatar_url, created_at FROM users WHERE id = ?')
    .bind(playerId).first();
  if (!user) return jsonResponse({ error: 'Player not found' }, 404, corsOrigin);

  const achievements = await env.DB.prepare(
    'SELECT achievement_id, earned_at FROM user_achievements WHERE user_id = ?'
  ).bind(playerId).all();

  const bestScores = await env.DB.prepare(
    `SELECT level_id, MIN(time_ms) as best_time, MAX(distance) as max_distance, COUNT(*) as rides
     FROM scores WHERE user_id = ? GROUP BY level_id`
  ).bind(playerId).all();

  const recentScores = await env.DB.prepare(
    'SELECT id, level_id, distance, time_ms, mode, collectibles_count, created_at FROM scores WHERE user_id = ? ORDER BY created_at DESC LIMIT 10'
  ).bind(playerId).all();

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
    'SELECT achievement_id, earned_at FROM user_achievements WHERE user_id = ?'
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
    'SELECT achievement_id, earned_at FROM user_achievements WHERE user_id = ?'
  ).bind(userId).all();

  return jsonResponse({
    synced,
    achievements: serverAchs.results
  }, 200, corsOrigin);
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
async function createJWT(payload, secret) {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const body = btoa(JSON.stringify({ ...payload, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 86400 * 30 }))
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
