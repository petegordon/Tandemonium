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
const RECENT_CAP = 60;
const MAX_CLIENT_ADD = 1e8;   // more than a lifetime of metres in one sync is junk
const MAX_STATS_BYTES = 64 * 1024;

function checkGame(game) {
  if (typeof game !== 'string' || !GAME_RE.test(game)) throw new Error('bad game');
}

/**
 * Merge a stats delta into stored stats.
 *   add:    counters, summed           { rolls: 1 }
 *   max:    bests, highest kept        { bestStreak: 5 }
 *   or:     bit sets, OR-ed            { doubles: 0b100001 }
 *   union:  string sets, joined        { partners: ['42'] } (capped: the first ones stay)
 *   recent: day sets, newest kept      { dayList: ['2026-11-08'] } (sorted, the newest 60)
 *   latest: [at, value], newest `at`   { dailyRun: ['2026-11-08', 3] } (a run and the day it last moved)
 *   maxmap: { id: [v, ...note] }       { bests: { top_speed: [41.2, 'grandma', 1762600000000] } }
 *           per id, the entry with the higher v (the note says where and when it was set)
 */
export function mergeStats(stats, delta) {
  const out = { ...(stats || {}) };
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const d = delta || {};
  for (const [k, v] of Object.entries(d.add || {})) {
    if (KEY_RE.test(k) && num(v) !== null) out[k] = (num(out[k]) || 0) + v;
  }
  for (const [k, v] of Object.entries(d.max || {})) {
    if (KEY_RE.test(k) && num(v) !== null) out[k] = Math.max(num(out[k]) ?? -Infinity, v);
  }
  for (const [k, v] of Object.entries(d.or || {})) {
    if (KEY_RE.test(k) && Number.isInteger(v) && v >= 0 && v < 2 ** 31) out[k] = ((num(out[k]) || 0) | v) >>> 0;
  }
  for (const [k, v] of Object.entries(d.union || {})) {
    if (!KEY_RE.test(k) || !Array.isArray(v)) continue;
    const set = new Set(Array.isArray(out[k]) ? out[k] : []);
    for (const s of v) if (typeof s === 'string' && s.length <= 64 && set.size < UNION_CAP) set.add(s);
    out[k] = [...set];
  }
  for (const [k, v] of Object.entries(d.recent || {})) {
    if (!KEY_RE.test(k) || !Array.isArray(v)) continue;
    const set = new Set((Array.isArray(out[k]) ? out[k] : []).filter((s) => typeof s === 'string'));
    for (const s of v.slice(0, UNION_CAP)) if (typeof s === 'string' && s.length <= 64) set.add(s);
    out[k] = [...set].sort().slice(-RECENT_CAP);
  }
  for (const [k, v] of Object.entries(d.latest || {})) {
    if (!KEY_RE.test(k) || !isLatest(v)) continue;
    const cur = isLatest(out[k]) ? out[k] : null;
    if (!cur || v[0] > cur[0] || (v[0] === cur[0] && num(v[1]) !== null && v[1] > (num(cur[1]) ?? -Infinity))) out[k] = [v[0], v[1]];
  }
  for (const [k, v] of Object.entries(d.maxmap || {})) {
    if (!KEY_RE.test(k) || !v || typeof v !== 'object' || Array.isArray(v)) continue;
    const map = { ...(out[k] && typeof out[k] === 'object' && !Array.isArray(out[k]) ? out[k] : {}) };
    for (const [id, e] of Object.entries(v)) {
      if (!KEY_RE.test(id) || !isMaxEntry(e)) continue;
      if (!(id in map) && Object.keys(map).length >= UNION_CAP) continue;
      if (!isMaxEntry(map[id]) || e[0] > map[id][0]) map[id] = e.slice(0, 4);
    }
    out[k] = map;
  }
  return out;
}

const isLatest = (v) => Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && v[0].length <= 32
  && (v[1] === null || (typeof v[1] === 'string' && v[1].length <= 64) || (typeof v[1] === 'number' && Number.isFinite(v[1])));
const isMaxEntry = (e) => Array.isArray(e) && e.length >= 1 && e.length <= 4 && typeof e[0] === 'number' && Number.isFinite(e[0])
  && e.slice(1).every((x) => x === null || (typeof x === 'string' && x.length <= 64) || (typeof x === 'number' && Number.isFinite(x)));

/**
 * A stats delta from a game client (not a game's own Worker): only the known
 * ops, counters that only go up, and sizes a real client sends. Null if junk.
 */
export function cleanClientDelta(delta) {
  if (!delta || typeof delta !== 'object' || Array.isArray(delta)) return null;
  const out = {};
  const obj = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? Object.entries(o).slice(0, 100) : []);
  const fin = (v) => typeof v === 'number' && Number.isFinite(v);
  for (const [k, v] of obj(delta.add)) if (KEY_RE.test(k) && fin(v) && v > 0 && v <= MAX_CLIENT_ADD) (out.add ||= {})[k] = v;
  for (const [k, v] of obj(delta.max)) if (KEY_RE.test(k) && fin(v) && Math.abs(v) <= MAX_CLIENT_ADD) (out.max ||= {})[k] = v;
  for (const [k, v] of obj(delta.or)) if (KEY_RE.test(k) && Number.isInteger(v) && v >= 0 && v < 2 ** 31) (out.or ||= {})[k] = v;
  for (const op of ['union', 'recent']) {
    for (const [k, v] of obj(delta[op])) {
      if (KEY_RE.test(k) && Array.isArray(v)) (out[op] ||= {})[k] = v.filter((s) => typeof s === 'string' && s.length <= 64).slice(0, UNION_CAP);
    }
  }
  for (const [k, v] of obj(delta.latest)) if (KEY_RE.test(k) && isLatest(v)) (out.latest ||= {})[k] = v;
  for (const [k, v] of obj(delta.maxmap)) {
    if (!KEY_RE.test(k) || !v || typeof v !== 'object' || Array.isArray(v)) continue;
    const m = {};
    for (const [id, e] of Object.entries(v).slice(0, UNION_CAP)) if (KEY_RE.test(id) && isMaxEntry(e)) m[id] = e;
    (out.maxmap ||= {})[k] = m;
  }
  return out;
}

// ============================================================
// TIME IN GAME (housetandem-web #37)
// ============================================================
//
// Games report ACTIVE seconds (tab visible, player not idle) as deltas, about
// once a minute and when the page hides. The server never takes a total, and
// caps each delta to the real time since this account's last report in this
// game (+ a little slack), so two devices or a replayed request can't count
// the same minute twice, and a junk number can't add hours.

/** The games that may report time in game. */
export const PLAYTIME_GAMES = Object.freeze(['tandemonium', 'dice', 'coins', 'roulette', 'wheel', 'timber', 'sandhands']);
export const MAX_PLAY_REPORT_S = 600;   // one report covers at most 10 minutes (a retry after being offline)
export const PLAY_SLACK_S = 5;          // clocks and network jitter
export const SESSION_GAP_S = 30 * 60;   // a report after 30 minutes without one starts a new session

/** How many of `seconds` a report may add, given the last report's server time (ms) or null. */
export function capPlaySeconds(seconds, lastReportMs, nowMs) {
  const s = typeof seconds === 'number' && Number.isFinite(seconds) ? seconds : 0;
  if (s <= 0) return 0;
  let cap = MAX_PLAY_REPORT_S;
  if (typeof lastReportMs === 'number' && Number.isFinite(lastReportMs)) {
    const elapsed = (nowMs - lastReportMs) / 1000;
    cap = Math.min(cap, Math.max(0, elapsed + PLAY_SLACK_S));
  }
  return Math.floor(Math.min(s, cap));
}

const playtimeOut = (r) => (r ? {
  seconds: r.seconds || 0, sessions: r.sessions || 0, firstPlayed: r.first_played || null, lastPlayed: r.last_played || null,
} : { seconds: 0, sessions: 0, firstPlayed: null, lastPlayed: null });

/** An account's time in one game. */
export async function getPlaytime(env, userId, game) {
  checkGame(game);
  const r = await env.DB.prepare('SELECT seconds, sessions, first_played, last_played FROM game_playtime WHERE user_id = ? AND game = ?')
    .bind(userId, game).first();
  return playtimeOut(r);
}

/** Add a delta of active seconds (capped). → { seconds, sessions, firstPlayed, lastPlayed, added } */
export async function recordPlay(env, userId, game, seconds, nowMs = Date.now()) {
  checkGame(game);
  if (!PLAYTIME_GAMES.includes(game)) throw new Error('bad game');
  const row = await env.DB.prepare(
    'SELECT seconds, sessions, first_played, last_played, last_report_ms FROM game_playtime WHERE user_id = ? AND game = ?'
  ).bind(userId, game).first();
  const added = capPlaySeconds(seconds, row ? row.last_report_ms : null, nowMs);
  if (added <= 0) return { ...playtimeOut(row), added: 0 };
  if (!row) {
    const user = await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(userId).first();
    if (!user) throw new Error('account not found');
  }
  const gap = row && Number.isFinite(row.last_report_ms) ? (nowMs - row.last_report_ms) / 1000 : Infinity;
  const newSession = gap > SESSION_GAP_S ? 1 : 0;
  const iso = new Date(nowMs).toISOString();
  await env.DB.prepare(
    `INSERT INTO game_playtime (user_id, game, seconds, sessions, first_played, last_played, last_report_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, game) DO UPDATE SET seconds = seconds + excluded.seconds, sessions = sessions + excluded.sessions,
       first_played = COALESCE(first_played, excluded.first_played), last_played = excluded.last_played,
       last_report_ms = excluded.last_report_ms`
  ).bind(userId, game, added, newSession, iso, iso, nowMs).run();
  return {
    seconds: ((row && row.seconds) || 0) + added, sessions: ((row && row.sessions) || 0) + newSession,
    firstPlayed: (row && row.first_played) || iso, lastPlayed: iso, added,
  };
}

/**
 * An account merge (identity.js · mergeAccounts): the games' rows move to `to`.
 * Achievements join; time in game adds up; stats keep `to`'s where both have
 * them (a game's merge rules aren't known here) and move `from`'s otherwise.
 */
export async function mergeGameAccounts(env, from, to) {
  const q = (sql, ...args) => env.DB.prepare(sql).bind(...args).run();
  await q(`INSERT OR IGNORE INTO game_achievements (user_id, game, achievement_id, earned_at)
           SELECT ?, game, achievement_id, earned_at FROM game_achievements WHERE user_id = ?`, to, from);
  await q('DELETE FROM game_achievements WHERE user_id = ?', from);
  await q('UPDATE OR IGNORE game_stats SET user_id = ? WHERE user_id = ?', to, from);
  await q('DELETE FROM game_stats WHERE user_id = ?', from);
  await q(`INSERT INTO game_playtime (user_id, game, seconds, sessions, first_played, last_played, last_report_ms)
           SELECT ?, game, seconds, sessions, first_played, last_played, last_report_ms FROM game_playtime WHERE user_id = ? AND true
           ON CONFLICT(user_id, game) DO UPDATE SET seconds = seconds + excluded.seconds, sessions = sessions + excluded.sessions,
             first_played = MIN(COALESCE(first_played, excluded.first_played), COALESCE(excluded.first_played, first_played)),
             last_played = MAX(COALESCE(last_played, ''), COALESCE(excluded.last_played, '')),
             last_report_ms = MAX(COALESCE(last_report_ms, 0), COALESCE(excluded.last_report_ms, 0))`, to, from);
  await q('DELETE FROM game_playtime WHERE user_id = ?', from);
}

/** What an account has in one game: earned achievement ids and lifetime stats. */
export async function gameProfile(env, userId, game) {
  checkGame(game);
  const rows = await env.DB.prepare('SELECT achievement_id FROM game_achievements WHERE user_id = ? AND game = ?')
    .bind(userId, game).all();
  const s = await env.DB.prepare('SELECT stats_json FROM game_stats WHERE user_id = ? AND game = ?').bind(userId, game).first();
  let stats = {};
  try { stats = JSON.parse((s && s.stats_json) || '{}'); } catch {}
  return { earned: (rows.results || []).map((r) => r.achievement_id), stats, playtime: await getPlaytime(env, userId, game) };
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
    if (next.length > MAX_STATS_BYTES) throw new Error('stats too large');
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

/**
 * GET /me/games → { games: { dice: { earned: [{ id, earnedAt }], stats, playtime } } }
 * Tandemonium is in it too (its achievements live in user_achievements), so the
 * account page reads every game the same way. `playtime` is
 * { seconds, sessions, firstPlayed, lastPlayed } (zeros when never reported).
 */
export async function handleMeGames(request, env, corsOrigin, userId, deps) {
  const rows = await env.DB.prepare(
    'SELECT game, achievement_id, earned_at FROM game_achievements WHERE user_id = ? ORDER BY earned_at'
  ).bind(userId).all();
  const tand = await env.DB.prepare(
    'SELECT achievement_id, earned_at FROM user_achievements WHERE user_id = ? ORDER BY earned_at'
  ).bind(userId).all();
  const stats = await env.DB.prepare('SELECT game, stats_json FROM game_stats WHERE user_id = ?').bind(userId).all();
  const play = await env.DB.prepare('SELECT game, seconds, sessions, first_played, last_played FROM game_playtime WHERE user_id = ?')
    .bind(userId).all();
  const games = {};
  const of = (g) => (games[g] ||= { earned: [], stats: {}, playtime: playtimeOut(null) });
  for (const r of rows.results || []) of(r.game).earned.push({ id: r.achievement_id, earnedAt: r.earned_at });
  for (const r of tand.results || []) of(TANDEMONIUM).earned.push({ id: r.achievement_id, earnedAt: r.earned_at });
  for (const r of stats.results || []) {
    try { of(r.game).stats = JSON.parse(r.stats_json || '{}'); } catch {}
  }
  for (const r of play.results || []) of(r.game).playtime = playtimeOut(r);
  of(TANDEMONIUM).steamPlayed = await steamPlayed(env, userId);
  return deps.jsonResponse({ games }, 200, corsOrigin);
}

const TANDEMONIUM = 'tandemonium';

/**
 * Has this account played the Steam build? (the account page's "Playing the playtest").
 * The game's analytics session records platform 'steam' and, once signed in, the account
 * number in sessions.google_uid (text: "38" or "38.0"). Index: migration 0019.
 */
async function steamPlayed(env, userId) {
  try {
    const row = await env.DB.prepare(
      "SELECT 1 AS yes FROM sessions WHERE google_uid IN (?, ?) AND platform = 'steam' LIMIT 1"
    ).bind(String(userId), `${userId}.0`).first();
    return !!row;
  } catch { return false; }
}

/**
 * POST /games/:game/sync  { seconds?, delta?, token? }  → { game, playtime, stats? }
 *
 * A signed-in game client reports time in game (`seconds`, a capped delta) and,
 * for Tandemonium only, its lifetime-stats delta (worker games stay the
 * authority for their own stats: they write through recordGame over RPC). The
 * merged stats come back, so one call is both "push" and "pull"; an empty body
 * just reads. The token may come in the body instead of the Authorization
 * header: navigator.sendBeacon (page hide) can't set headers, and a text/plain
 * body needs no CORS preflight.
 */
export async function handleGameSync(request, env, corsOrigin, game, deps) {
  if (!GAME_RE.test(game) || !PLAYTIME_GAMES.includes(game)) return deps.jsonResponse({ error: 'Unknown game' }, 404, corsOrigin);
  let body = {};
  try {
    const text = await request.text();
    if (text.length > 96 * 1024) return deps.jsonResponse({ error: 'Too large' }, 413, corsOrigin);
    body = text ? JSON.parse(text) : {};
  } catch { return deps.jsonResponse({ error: 'Invalid body' }, 400, corsOrigin); }
  if (!body || typeof body !== 'object') body = {};
  let userId = await deps.getUserFromRequest(request, env);
  if (!userId && typeof body.token === 'string' && body.token.length < 4096) userId = await deps.userFromToken(body.token, env);
  if (!userId) return deps.jsonResponse({ error: 'Unauthorized' }, 401, corsOrigin);
  const user = await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(userId).first();
  if (!user) return deps.jsonResponse({ error: 'Account not found' }, 401, corsOrigin);

  const out = { game };
  if (body.seconds !== undefined) {
    const p = await recordPlay(env, userId, game, Number(body.seconds));
    out.playtime = p;
  } else {
    out.playtime = await getPlaytime(env, userId, game);
  }
  if (game === TANDEMONIUM) {
    const delta = body.delta !== undefined ? cleanClientDelta(body.delta) : null;
    if (body.delta !== undefined && !delta) return deps.jsonResponse({ error: 'Invalid delta' }, 400, corsOrigin);
    if (delta && Object.keys(delta).length) await recordGame(env, userId, game, delta, []);
    out.stats = (await gameProfile(env, userId, game)).stats;
  }
  return deps.jsonResponse(out, 200, corsOrigin);
}
