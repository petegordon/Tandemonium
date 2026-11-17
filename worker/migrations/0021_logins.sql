-- #783 · every record carries the LOGIN it was recorded under and the ACCOUNT it counts for.
--
--   login_id  the sign-in (user_logins row) the activity came from. Set once, never changes.
--   user_id   the House Tandem account that login belongs to right now. A copy, for queries.
--             It changes only when logins are combined into, or separated from, an account.
--
-- user_identities becomes user_logins (its id is login_id). A guest device is a login too
-- (provider 'device'), with a small account of its own until that device signs in.
-- Existing rows are credited to the account's earliest login: we never recorded which
-- login made them, so that is the honest default.
--
-- Database rules move to the login (one badge per login, one Daily row per login per day);
-- the per-person rules (a badge shows once, the day's best time) are applied when reading
-- by user_id. That is what lets a combine be undone exactly: separate = give each login's
-- rows back to its own account.
--
-- Apply with the worker deploy that reads this shape (see docs/logins.md for the order):
--   npx wrangler d1 execute tandemonium-leaderboard --remote --file worker/migrations/0021_logins.sql
-- (No semicolons inside statements or comments below: the test loader splits on them.)

-- ── logins ──────────────────────────────────────────────────────────────────
ALTER TABLE user_identities RENAME TO user_logins;
ALTER TABLE user_logins RENAME COLUMN id TO login_id;
DROP INDEX IF EXISTS idx_identities_user;
CREATE INDEX IF NOT EXISTS idx_logins_user ON user_logins(user_id);

-- An account with no login row (none are expected) gets the one it was created with.
INSERT OR IGNORE INTO user_logins (user_id, provider, provider_id, display_name, avatar_url, linked_at)
  SELECT id, provider, provider_id, display_name, avatar_url, created_at FROM users
  WHERE id NOT IN (SELECT user_id FROM user_logins);

-- Guests in pair records ('guest:<key>') become device logins, each with its own account.
INSERT OR IGNORE INTO users (provider, provider_id, display_name)
  SELECT DISTINCT 'device', substr(k, 7), 'Guest' FROM (
    SELECT user_lo AS k FROM pairs WHERE user_lo LIKE 'guest:%'
    UNION SELECT user_hi AS k FROM pairs WHERE user_hi LIKE 'guest:%'
  );
INSERT OR IGNORE INTO user_logins (user_id, provider, provider_id, display_name)
  SELECT id, 'device', provider_id, 'Guest' FROM users WHERE provider = 'device';

-- ── Tandemonium rides ───────────────────────────────────────────────────────
ALTER TABLE scores ADD COLUMN login_id INTEGER;
UPDATE scores SET login_id = (SELECT MIN(l.login_id) FROM user_logins l WHERE l.user_id = scores.user_id);
CREATE INDEX IF NOT EXISTS idx_scores_login ON scores(login_id);

ALTER TABLE score_contributions ADD COLUMN player_login_id INTEGER;
UPDATE score_contributions SET player_login_id = (SELECT MIN(l.login_id) FROM user_logins l WHERE l.user_id = score_contributions.player_user_id)
  WHERE player_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_contrib_login ON score_contributions(player_login_id);

ALTER TABLE ride_seats ADD COLUMN login_id INTEGER;
UPDATE ride_seats SET login_id = (SELECT MIN(l.login_id) FROM user_logins l WHERE l.user_id = ride_seats.user_id)
  WHERE user_id IS NOT NULL;

ALTER TABLE sessions ADD COLUMN login_id INTEGER;

-- ── badges: one per login, shown once per account ───────────────────────────
CREATE TABLE user_achievements_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  login_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  achievement_id TEXT NOT NULL,
  earned_at TEXT DEFAULT (datetime('now')),
  score_id INTEGER REFERENCES scores(id),
  UNIQUE(login_id, achievement_id)
);
INSERT INTO user_achievements_v2 (id, login_id, user_id, achievement_id, earned_at, score_id)
  SELECT a.id, (SELECT MIN(l.login_id) FROM user_logins l WHERE l.user_id = a.user_id), a.user_id, a.achievement_id, a.earned_at, a.score_id
  FROM user_achievements a;
DROP TABLE user_achievements;
ALTER TABLE user_achievements_v2 RENAME TO user_achievements;
CREATE INDEX IF NOT EXISTS idx_achievements_user ON user_achievements(user_id);

-- ── Daily: one row per login per day and mode, the account's best is read ───
CREATE TABLE daily_results_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  login_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  day_key TEXT NOT NULL,
  mode TEXT NOT NULL,
  time_ms INTEGER,
  dnf INTEGER NOT NULL DEFAULT 0,
  distance REAL DEFAULT 0,
  collectibles INTEGER DEFAULT 0,
  crashes INTEGER DEFAULT 0,
  safety_used INTEGER DEFAULT 0,
  sync_pct INTEGER,
  partner_user_id INTEGER REFERENCES users(id),
  partner_login_id INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  warp INTEGER NOT NULL DEFAULT 0,
  UNIQUE (login_id, day_key, mode)
);
INSERT INTO daily_results_v2 (id, login_id, user_id, day_key, mode, time_ms, dnf, distance, collectibles, crashes, safety_used, sync_pct, partner_user_id, partner_login_id, created_at, warp)
  SELECT d.id, (SELECT MIN(l.login_id) FROM user_logins l WHERE l.user_id = d.user_id), d.user_id, d.day_key, d.mode, d.time_ms, d.dnf, d.distance,
         d.collectibles, d.crashes, d.safety_used, d.sync_pct, d.partner_user_id,
         (SELECT MIN(l.login_id) FROM user_logins l WHERE l.user_id = d.partner_user_id), d.created_at, d.warp
  FROM daily_results d;
DROP TABLE daily_results;
ALTER TABLE daily_results_v2 RENAME TO daily_results;
CREATE INDEX IF NOT EXISTS idx_daily_day ON daily_results(day_key);
CREATE INDEX IF NOT EXISTS idx_daily_user ON daily_results(user_id, day_key);

-- ── the other House Tandem games ────────────────────────────────────────────
CREATE TABLE game_achievements_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  login_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  game TEXT NOT NULL,
  achievement_id TEXT NOT NULL,
  earned_at TEXT DEFAULT (datetime('now')),
  UNIQUE (login_id, game, achievement_id)
);
INSERT INTO game_achievements_v2 (id, login_id, user_id, game, achievement_id, earned_at)
  SELECT a.id, (SELECT MIN(l.login_id) FROM user_logins l WHERE l.user_id = a.user_id), a.user_id, a.game, a.achievement_id, a.earned_at
  FROM game_achievements a;
DROP TABLE game_achievements;
ALTER TABLE game_achievements_v2 RENAME TO game_achievements;
CREATE INDEX IF NOT EXISTS idx_game_ach_user ON game_achievements(user_id, game);

-- ops_json remembers how each stat combines ({ "rides": "add", "bestStreak": "max" }), so
-- two logins' stats can be read as one account's.
CREATE TABLE game_stats_v2 (
  login_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  game TEXT NOT NULL,
  stats_json TEXT NOT NULL DEFAULT '{}',
  ops_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (login_id, game)
);
INSERT INTO game_stats_v2 (login_id, user_id, game, stats_json, updated_at)
  SELECT (SELECT MIN(l.login_id) FROM user_logins l WHERE l.user_id = s.user_id), s.user_id, s.game, s.stats_json, s.updated_at
  FROM game_stats s;
DROP TABLE game_stats;
ALTER TABLE game_stats_v2 RENAME TO game_stats;
CREATE INDEX IF NOT EXISTS idx_game_stats_user ON game_stats(user_id, game);

CREATE TABLE game_playtime_v2 (
  login_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  game TEXT NOT NULL,
  seconds INTEGER NOT NULL DEFAULT 0,
  sessions INTEGER NOT NULL DEFAULT 0,
  first_played TEXT,
  last_played TEXT,
  last_report_ms INTEGER,
  PRIMARY KEY (login_id, game)
);
INSERT INTO game_playtime_v2 (login_id, user_id, game, seconds, sessions, first_played, last_played, last_report_ms)
  SELECT (SELECT MIN(l.login_id) FROM user_logins l WHERE l.user_id = p.user_id), p.user_id, p.game, p.seconds, p.sessions, p.first_played, p.last_played, p.last_report_ms
  FROM game_playtime p;
DROP TABLE game_playtime;
ALTER TABLE game_playtime_v2 RENAME TO game_playtime;
CREATE INDEX IF NOT EXISTS idx_game_playtime_user ON game_playtime(user_id, game);

-- ── Discord posts: who posted, one a day per account (checked on write) ─────
CREATE TABLE discord_posts_v2 (
  login_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  day_key TEXT NOT NULL,
  share_id TEXT,
  posted_at INTEGER NOT NULL,
  PRIMARY KEY (login_id, day_key)
);
INSERT INTO discord_posts_v2 (login_id, user_id, day_key, share_id, posted_at)
  SELECT (SELECT MIN(l.login_id) FROM user_logins l WHERE l.user_id = p.user_id), p.user_id, p.day_key, p.share_id, p.posted_at
  FROM discord_posts p
  WHERE EXISTS (SELECT 1 FROM user_logins l WHERE l.user_id = p.user_id);
DROP TABLE discord_posts;
ALTER TABLE discord_posts_v2 RENAME TO discord_posts;
CREATE INDEX IF NOT EXISTS idx_discord_posts_user ON discord_posts(user_id, day_key);

-- ── friends (not written yet): the login that added, and the login added ────
CREATE TABLE friends_v2 (
  login_id INTEGER NOT NULL,
  friend_login_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  friend_user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (login_id, friend_login_id)
);
INSERT OR IGNORE INTO friends_v2 (login_id, friend_login_id, user_id, friend_user_id, created_at)
  SELECT (SELECT MIN(l.login_id) FROM user_logins l WHERE l.user_id = f.user_id),
         (SELECT MIN(l.login_id) FROM user_logins l WHERE l.user_id = f.friend_id), f.user_id, f.friend_id, f.created_at
  FROM friends f
  WHERE EXISTS (SELECT 1 FROM user_logins l WHERE l.user_id = f.user_id)
    AND EXISTS (SELECT 1 FROM user_logins l WHERE l.user_id = f.friend_id);
DROP TABLE friends;
ALTER TABLE friends_v2 RENAME TO friends;
CREATE INDEX IF NOT EXISTS idx_friends_user ON friends(user_id);

-- ── pairs: keyed by the two logins, with each one's account beside it ───────
-- login_lo < login_hi. user_lo is login_lo's account, user_hi is login_hi's. Two people's
-- record is the sum of their logins' rows (read by user_lo / user_hi).
CREATE TABLE pairs_v2 (
  login_lo INTEGER NOT NULL,
  login_hi INTEGER NOT NULL,
  user_lo INTEGER NOT NULL,
  user_hi INTEGER NOT NULL,
  rides INTEGER NOT NULL DEFAULT 0,
  distance REAL NOT NULL DEFAULT 0,
  best_json TEXT,
  last_ride TEXT,
  daily_streak INTEGER NOT NULL DEFAULT 0,
  daily_best_streak INTEGER NOT NULL DEFAULT 0,
  daily_last_key TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (login_lo, login_hi)
);
INSERT OR IGNORE INTO pairs_v2 (login_lo, login_hi, user_lo, user_hi, rides, distance, best_json, last_ride, daily_streak, daily_best_streak, daily_last_key, created_at)
  SELECT MIN(la, lb), MAX(la, lb),
         CASE WHEN la < lb THEN ua ELSE ub END, CASE WHEN la < lb THEN ub ELSE ua END,
         rides, distance, best_json, last_ride, daily_streak, daily_best_streak, daily_last_key, created_at
  FROM (
    SELECT p.*,
      CASE WHEN p.user_lo LIKE 'guest:%'
        THEN (SELECT l.login_id FROM user_logins l WHERE l.provider = 'device' AND l.provider_id = substr(p.user_lo, 7))
        ELSE (SELECT MIN(l.login_id) FROM user_logins l WHERE l.user_id = CAST(p.user_lo AS INTEGER)) END AS la,
      CASE WHEN p.user_hi LIKE 'guest:%'
        THEN (SELECT l.login_id FROM user_logins l WHERE l.provider = 'device' AND l.provider_id = substr(p.user_hi, 7))
        ELSE (SELECT MIN(l.login_id) FROM user_logins l WHERE l.user_id = CAST(p.user_hi AS INTEGER)) END AS lb,
      CASE WHEN p.user_lo LIKE 'guest:%'
        THEN (SELECT l.user_id FROM user_logins l WHERE l.provider = 'device' AND l.provider_id = substr(p.user_lo, 7))
        ELSE CAST(p.user_lo AS INTEGER) END AS ua,
      CASE WHEN p.user_hi LIKE 'guest:%'
        THEN (SELECT l.user_id FROM user_logins l WHERE l.provider = 'device' AND l.provider_id = substr(p.user_hi, 7))
        ELSE CAST(p.user_hi AS INTEGER) END AS ub
    FROM pairs p
  )
  WHERE la IS NOT NULL AND lb IS NOT NULL AND la != lb;
DROP TABLE pairs;
ALTER TABLE pairs_v2 RENAME TO pairs;
CREATE INDEX IF NOT EXISTS idx_pairs_user_lo ON pairs(user_lo);
CREATE INDEX IF NOT EXISTS idx_pairs_user_hi ON pairs(user_hi);
CREATE INDEX IF NOT EXISTS idx_pairs_last_ride ON pairs(last_ride);

-- ── account events: a combine now records which logins moved (moved_json) ───
-- Combines made before this migration were recorded the old way and can no longer be
-- separated by the new code: their undo window is closed here.
ALTER TABLE account_events ADD COLUMN moved_json TEXT;
UPDATE account_events SET undo_until = created_at WHERE kind = 'combine' AND undone_at IS NULL;
