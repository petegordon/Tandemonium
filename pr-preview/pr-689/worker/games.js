// ============================================================
// HOUSE TANDEM GAMES — achievements + lifetime stats for every game (#612)
// ============================================================
//
// Tandemonium keeps its own tables (user_achievements, scores). The other
// House Tandem games (dice first, then roulette, coins, ...) store here:
// game_achievements and game_stats, keyed by account and game.
//
// Games never write over the public API. A game's own Worker reaches these
// through the HouseTandemGames RPC entrypoint (worker/index.js), bound as a
// Cloudflare service binding, so there's no shared secret to manage. The
// game decides what was earned (it knows its rules); this module stores it.

const GAME_RE = /^[a-z][a-z0-9_-]{0,19}$/;
const ACH_RE = /^[a-z0-9_]{1,40}$/;
const KEY_RE = /^[A-Za-z0-9_]{1,40}$/;
const MAX_EARNED_PER_CALL = 50;
const UNION_CAP = 200;

function checkGame(game) {
  if (typeof game !== 'string' || !GAME_RE.test(game)) throw new Error('bad game');
}

/**
 * Merge a stats delta into stored stats.
 *   add:   counters, summed          { rolls: 1 }
 *   max:   bests, highest kept       { bestStreak: 5 }
 *   or:    bit sets, OR-ed           { doubles: 0b100001 }
 *   union: string sets, joined       { partners: ['42'] } (capped)
 */
export function mergeStats(stats, delta) {
  const out = { ...(stats || {}) };
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  for (const [k, v] of Object.entries((delta && delta.add) || {})) {
    if (KEY_RE.test(k) && num(v) !== null) out[k] = (num(out[k]) || 0) + v;
  }
  for (const [k, v] of Object.entries((delta && delta.max) || {})) {
    if (KEY_RE.test(k) && num(v) !== null) out[k] = Math.max(num(out[k]) ?? -Infinity, v);
  }
  for (const [k, v] of Object.entries((delta && delta.or) || {})) {
    if (KEY_RE.test(k) && Number.isInteger(v) && v >= 0 && v < 2 ** 31) out[k] = ((num(out[k]) || 0) | v) >>> 0;
  }
  for (const [k, v] of Object.entries((delta && delta.union) || {})) {
    if (!KEY_RE.test(k) || !Array.isArray(v)) continue;
    const set = new Set(Array.isArray(out[k]) ? out[k] : []);
    for (const s of v) if (typeof s === 'string' && s.length <= 64 && set.size < UNION_CAP) set.add(s);
    out[k] = [...set];
  }
  return out;
}

/** What an account has in one game: earned achievement ids and lifetime stats. */
export async function gameProfile(env, userId, game) {
  checkGame(game);
  const rows = await env.DB.prepare('SELECT achievement_id FROM game_achievements WHERE user_id = ? AND game = ?')
    .bind(userId, game).all();
  const s = await env.DB.prepare('SELECT stats_json FROM game_stats WHERE user_id = ? AND game = ?').bind(userId, game).first();
  let stats = {};
  try { stats = JSON.parse((s && s.stats_json) || '{}'); } catch {}
  return { earned: (rows.results || []).map((r) => r.achievement_id), stats };
}

/** Store a game's stats delta and achievements; returns the ones that are new. */
export async function recordGame(env, userId, game, delta, earned) {
  checkGame(game);
  const user = await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(userId).first();
  if (!user) throw new Error('account not found');
  if (delta && typeof delta === 'object') {
    const cur = await env.DB.prepare('SELECT stats_json FROM game_stats WHERE user_id = ? AND game = ?').bind(userId, game).first();
    let stats = {};
    try { stats = JSON.parse((cur && cur.stats_json) || '{}'); } catch {}
    const next = JSON.stringify(mergeStats(stats, delta));
    await env.DB.prepare(
      `INSERT INTO game_stats (user_id, game, stats_json, updated_at) VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(user_id, game) DO UPDATE SET stats_json = excluded.stats_json, updated_at = excluded.updated_at`
    ).bind(userId, game, next).run();
  }
  const ids = [...new Set((Array.isArray(earned) ? earned : []).filter((a) => typeof a === 'string' && ACH_RE.test(a)))]
    .slice(0, MAX_EARNED_PER_CALL);
  if (!ids.length) return { newlyEarned: [] };
  const have = new Set((await gameProfile(env, userId, game)).earned);
  const fresh = ids.filter((a) => !have.has(a));
  for (const a of fresh) {
    await env.DB.prepare('INSERT OR IGNORE INTO game_achievements (user_id, game, achievement_id) VALUES (?, ?, ?)')
      .bind(userId, game, a).run();
  }
  return { newlyEarned: fresh };
}

/** GET /me/games → { games: { dice: { earned: [{ id, earnedAt }], stats } } } */
export async function handleMeGames(request, env, corsOrigin, userId, deps) {
  const rows = await env.DB.prepare(
    'SELECT game, achievement_id, earned_at FROM game_achievements WHERE user_id = ? ORDER BY earned_at'
  ).bind(userId).all();
  const stats = await env.DB.prepare('SELECT game, stats_json FROM game_stats WHERE user_id = ?').bind(userId).all();
  const games = {};
  const of = (g) => (games[g] ||= { earned: [], stats: {} });
  for (const r of rows.results || []) of(r.game).earned.push({ id: r.achievement_id, earnedAt: r.earned_at });
  for (const r of stats.results || []) {
    try { of(r.game).stats = JSON.parse(r.stats_json || '{}'); } catch {}
  }
  return deps.jsonResponse({ games }, 200, corsOrigin);
}
