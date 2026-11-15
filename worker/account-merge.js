// ============================================================
// ACCOUNT MERGE — combine two accounts, and separate them again (#612, GHSA-9fv3)
// ============================================================
//
// mergeAccounts(from, to) moves everything on account `from` onto `to` and
// deletes `from`. It returns a record of what it did, kept on the account event
// for 7 days, so unmergeAccounts(record) can give `from` back:
//
//   - rows that moved as they were (scores, sign-ins, rides...) move back by key;
//   - rows the merge dropped because `to` already had one (a Daily ride on the
//     same day, an achievement both had) come back from the snapshot;
//   - rows the merge added up (pairs, time in game) have `from`'s share taken off.
//
// Progress made on the combined account after the merge stays on it.
//
// A table that doesn't exist yet (a migration not applied, a trimmed test schema)
// is skipped, the same way the merge always treated ride_seats.

const missingTable = (e) => /no such table/i.test(String(e && e.message));

function db(env) {
  const run = (sql, ...args) => env.DB.prepare(sql).bind(...args).run();
  const all = async (sql, ...args) => (await env.DB.prepare(sql).bind(...args).all()).results || [];
  const first = (sql, ...args) => env.DB.prepare(sql).bind(...args).first();
  /** Run fn; a missing table means there is nothing to do there. */
  const opt = async (fn, fallback = null) => {
    try { return await fn(); } catch (e) { if (missingTable(e)) return fallback; throw e; }
  };
  return { run, all, first, opt };
}

/** A user id list as a SQL IN list of placeholders. */
const marks = (list) => list.map(() => '?').join(',');

/** Run `UPDATE ... WHERE <keycol> IN (...)` in chunks (SQLite caps bound values). */
async function updateIn(d, sqlHead, keyCol, ids, ...lead) {
  for (let i = 0; i < ids.length; i += 90) {
    const part = ids.slice(i, i + 90);
    await d.run(`${sqlHead} WHERE ${keyCol} IN (${marks(part)})`, ...lead, ...part);
  }
}

/** Put a snapshot row back as it was. */
async function insertRow(d, table, row, verb = 'INSERT OR IGNORE') {
  const cols = Object.keys(row);
  await d.run(`${verb} INTO ${table} (${cols.join(', ')}) VALUES (${marks(cols)})`, ...cols.map((c) => row[c]));
}

/**
 * Move everything from account `from` onto account `to`, then delete `from`.
 * Returns the record unmergeAccounts needs (null when there was nothing to do).
 */
export async function mergeAccounts(env, from, to, deps = {}) {
  if (!from || !to || from === to) return null;
  const d = db(env);
  const log = { v: 1, from, to, at: Math.floor(Date.now() / 1000) };

  log.user = await d.first('SELECT * FROM users WHERE id = ?', from);

  // Rows that move as they are: remember their keys.
  const ids = async (sql, ...args) => (await d.all(sql, ...args)).map((r) => r.k);
  log.identities = await ids('SELECT id AS k FROM user_identities WHERE user_id = ?', from);
  await d.run('UPDATE user_identities SET user_id = ? WHERE user_id = ?', to, from);
  log.scores = await ids('SELECT id AS k FROM scores WHERE user_id = ?', from);
  await d.run('UPDATE scores SET user_id = ? WHERE user_id = ?', to, from);
  log.contributions = await ids('SELECT id AS k FROM score_contributions WHERE player_user_id = ?', from);
  await d.run('UPDATE score_contributions SET player_user_id = ? WHERE player_user_id = ?', to, from);
  // Analytics sessions name the account by number ("26.0"): they follow it too.
  log.sessions = await d.opt(() => ids('SELECT id AS k FROM sessions WHERE CAST(google_uid AS INTEGER) = ?', from), []);
  await d.opt(() => d.run('UPDATE sessions SET google_uid = ? WHERE CAST(google_uid AS INTEGER) = ?', String(to), from));
  // Seats 2–4 on couch rides (migration 0016).
  log.seats = await d.opt(() => d.all('SELECT ride_id, seat FROM ride_seats WHERE user_id = ?', from), []);
  await d.opt(() => d.run('UPDATE ride_seats SET user_id = ? WHERE user_id = ?', to, from));
  // Earlier link / combine notices travel with the account.
  log.events = await d.opt(() => ids('SELECT id AS k FROM account_events WHERE user_id = ?', from), []);
  await d.opt(() => d.run('UPDATE account_events SET user_id = ? WHERE user_id = ?', to, from));

  // Achievements: both sets join. Keep `from`'s rows; note the ones `to` gains.
  log.achievements = await d.all('SELECT * FROM user_achievements WHERE user_id = ?', from);
  const toAch = new Set((await d.all('SELECT achievement_id FROM user_achievements WHERE user_id = ?', to)).map((r) => r.achievement_id));
  log.achievementsAdded = log.achievements.map((r) => r.achievement_id).filter((a) => !toAch.has(a));
  await d.run(`INSERT OR IGNORE INTO user_achievements (user_id, achievement_id, earned_at, score_id)
               SELECT ?, achievement_id, earned_at, score_id FROM user_achievements WHERE user_id = ?`, to, from);
  await d.run('DELETE FROM user_achievements WHERE user_id = ?', from);

  // One Daily row per day per mode: keep `to`'s where both rode.
  const daily = await d.opt(() => d.all('SELECT * FROM daily_results WHERE user_id = ?', from), []);
  log.dailyPartner = await d.opt(() => ids('SELECT id AS k FROM daily_results WHERE partner_user_id = ?', from), []);
  await d.opt(async () => {
    await d.run('UPDATE OR IGNORE daily_results SET user_id = ? WHERE user_id = ?', to, from);
    const left = await d.all('SELECT * FROM daily_results WHERE user_id = ?', from);
    const leftIds = new Set(left.map((r) => r.id));
    log.dailyMoved = daily.filter((r) => !leftIds.has(r.id)).map((r) => r.id);
    log.dailyDropped = left;
    await d.run('DELETE FROM daily_results WHERE user_id = ?', from);
    await d.run('UPDATE daily_results SET partner_user_id = ? WHERE partner_user_id = ?', to, from);
  });

  // Friends: rows on `from` move unless `to` already has them.
  await d.opt(async () => {
    log.friends = await d.all('SELECT * FROM friends WHERE user_id = ? OR friend_id = ?', from, from);
    const before = new Set((await d.all('SELECT user_id, friend_id FROM friends WHERE user_id = ? OR friend_id = ?', to, to))
      .map((r) => r.user_id + ':' + r.friend_id));
    await d.run('UPDATE OR IGNORE friends SET user_id = ? WHERE user_id = ?', to, from);
    await d.run('UPDATE OR IGNORE friends SET friend_id = ? WHERE friend_id = ?', to, from);
    await d.run('DELETE FROM friends WHERE user_id = ? OR friend_id = ? OR user_id = friend_id', from, from);
    log.friendsAdded = (await d.all('SELECT user_id, friend_id FROM friends WHERE user_id = ? OR friend_id = ?', to, to))
      .map((r) => r.user_id + ':' + r.friend_id).filter((k) => !before.has(k));
  });

  // Pairs add up (rides, distance; the better time wins): keep `from`'s rows to take off later.
  log.pairs = await d.opt(() => d.all('SELECT * FROM pairs WHERE user_lo = ? OR user_hi = ?', String(from), String(from)), []);
  if (deps.mergePairKey) await deps.mergePairKey(env, String(from), String(to));

  // The other games' rows (and time in game) reference users(id).
  log.games = await d.opt(async () => {
    const g = {
      achievements: await d.all('SELECT * FROM game_achievements WHERE user_id = ?', from),
      stats: await d.all('SELECT * FROM game_stats WHERE user_id = ?', from),
      playtime: await d.opt(() => d.all('SELECT * FROM game_playtime WHERE user_id = ?', from), []),
    };
    const toAch2 = new Set((await d.all('SELECT game, achievement_id FROM game_achievements WHERE user_id = ?', to)).map((r) => r.game + ':' + r.achievement_id));
    g.achievementsAdded = g.achievements.map((r) => r.game + ':' + r.achievement_id).filter((k) => !toAch2.has(k));
    const toStats = new Set((await d.all('SELECT game FROM game_stats WHERE user_id = ?', to)).map((r) => r.game));
    g.statsMoved = g.stats.map((r) => r.game).filter((x) => !toStats.has(x));
    return g;
  }, null);
  if (deps.mergeGameAccounts) await deps.mergeGameAccounts(env, from, to);

  await d.run('DELETE FROM users WHERE id = ?', from);
  return log;
}

/**
 * Give account `log.from` back, as it was when it was combined into `log.to`.
 * The account keeps its old number. Throws if that number is somehow taken.
 */
export async function unmergeAccounts(env, log) {
  if (!log || !log.from || !log.to || !log.user) throw new Error('Nothing to separate');
  const d = db(env);
  const { from, to } = log;
  if (await d.first('SELECT id FROM users WHERE id = ?', from)) throw new Error('That account is already back');

  await insertRow(d, 'users', log.user, 'INSERT');

  if (log.identities && log.identities.length) await updateIn(d, 'UPDATE user_identities SET user_id = ?', 'id', log.identities, from);
  if (log.scores && log.scores.length) await updateIn(d, 'UPDATE scores SET user_id = ?', 'id', log.scores, from);
  if (log.contributions && log.contributions.length) await updateIn(d, 'UPDATE score_contributions SET player_user_id = ?', 'id', log.contributions, from);
  if (log.sessions && log.sessions.length) await d.opt(() => updateIn(d, 'UPDATE sessions SET google_uid = ?', 'id', log.sessions, String(from)));
  for (const s of log.seats || []) {
    await d.opt(() => d.run('UPDATE ride_seats SET user_id = ? WHERE ride_id = ? AND seat = ?', from, s.ride_id, s.seat));
  }
  if (log.events && log.events.length) await d.opt(() => updateIn(d, 'UPDATE account_events SET user_id = ?', 'id', log.events, from));

  // Achievements: the ones only `from` had leave `to`; `from` gets its whole set back.
  for (const a of log.achievementsAdded || []) {
    await d.run('DELETE FROM user_achievements WHERE user_id = ? AND achievement_id = ?', to, a);
  }
  for (const r of log.achievements || []) await insertRow(d, 'user_achievements', r);

  await d.opt(async () => {
    if (log.dailyMoved && log.dailyMoved.length) await updateIn(d, 'UPDATE daily_results SET user_id = ?', 'id', log.dailyMoved, from);
    for (const r of log.dailyDropped || []) await insertRow(d, 'daily_results', r);
    if (log.dailyPartner && log.dailyPartner.length) await updateIn(d, 'UPDATE daily_results SET partner_user_id = ?', 'id', log.dailyPartner, from);
  });

  await d.opt(async () => {
    for (const k of log.friendsAdded || []) {
      const [u, f] = k.split(':').map(Number);
      await d.run('DELETE FROM friends WHERE user_id = ? AND friend_id = ?', u, f);
    }
    for (const r of log.friends || []) await insertRow(d, 'friends', r);
  });

  // Pairs: take `from`'s rides and distance off the combined rows, then put `from`'s rows back.
  await d.opt(async () => {
    for (const r of log.pairs || []) {
      const other = r.user_lo === String(from) ? r.user_hi : r.user_lo;
      if (other !== String(to)) {
        const [lo, hi] = String(to) < other ? [String(to), other] : [other, String(to)];
        await d.run('UPDATE pairs SET rides = MAX(0, rides - ?), distance = MAX(0, distance - ?) WHERE user_lo = ? AND user_hi = ?',
          r.rides || 0, r.distance || 0, lo, hi);
        await d.run('DELETE FROM pairs WHERE user_lo = ? AND user_hi = ? AND rides <= 0', lo, hi);
      }
      await insertRow(d, 'pairs', r, 'INSERT OR REPLACE');
    }
  });

  const g = log.games;
  if (g) {
    await d.opt(async () => {
      for (const k of g.achievementsAdded || []) {
        const i = k.indexOf(':');
        await d.run('DELETE FROM game_achievements WHERE user_id = ? AND game = ? AND achievement_id = ?', to, k.slice(0, i), k.slice(i + 1));
      }
      for (const r of g.achievements || []) await insertRow(d, 'game_achievements', r);
      for (const game of g.statsMoved || []) await d.run('DELETE FROM game_stats WHERE user_id = ? AND game = ?', to, game);
      for (const r of g.stats || []) await insertRow(d, 'game_stats', r);
    });
    await d.opt(async () => {
      for (const r of g.playtime || []) {
        await d.run('UPDATE game_playtime SET seconds = MAX(0, seconds - ?), sessions = MAX(0, sessions - ?) WHERE user_id = ? AND game = ?',
          r.seconds || 0, r.sessions || 0, to, r.game);
        await d.run('DELETE FROM game_playtime WHERE user_id = ? AND game = ? AND seconds <= 0 AND sessions <= 0', to, r.game);
        await insertRow(d, 'game_playtime', r, 'INSERT OR REPLACE');
      }
    });
  }
}
