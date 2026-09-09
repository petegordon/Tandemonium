-- ============================================================
-- D-6 / D-7 / D-9 · the pair as a thing the software knows about
-- ============================================================
--
-- The persona's job-to-be-done is "a ritual with one specific person", and
-- until now the software forgot that person the moment the room closed. Scores
-- were per account; a pair existed only as two rows that happened to share a
-- score_id.
--
-- Two tables:
--
--   pairs         what two riders have done together: rides, distance, best
--                 times per level, when they last rode, and their weekly
--                 streak. Keyed by an UNORDERED pair, so "Sam and Jo" is one
--                 row regardless of who was captain.
--
--   daily_results one ranked run per account per day per mode on Today's Road.
--                 Read back only for the caller and the people they have
--                 actually ridden with — there is no global daily board, by
--                 decision (plan §3 decision 5). A stranger's time is not a
--                 target for this game's audience; the person they ride with
--                 is.
--
-- The pair key columns are TEXT, not INTEGER, on purpose (D-9): a guest who
-- never signs in is stored as 'guest:<device_id>' so a signed-in captain still
-- accumulates a record with them, and that record is migrated to their real id
-- if they later sign in. Making these INTEGER would have meant a second
-- migration to undo it.

CREATE TABLE IF NOT EXISTS pairs (
  user_lo TEXT NOT NULL,              -- lower key of the unordered pair
  user_hi TEXT NOT NULL,              -- higher key ('123' or 'guest:<device_id>')
  rides INTEGER NOT NULL DEFAULT 0,
  distance REAL NOT NULL DEFAULT 0,
  best_json TEXT,                     -- { "<level_id>": time_ms }
  last_ride TEXT,
  daily_streak INTEGER NOT NULL DEFAULT 0,
  daily_best_streak INTEGER NOT NULL DEFAULT 0,
  daily_last_key TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (user_lo, user_hi)
);

CREATE INDEX IF NOT EXISTS idx_pairs_lo ON pairs(user_lo);
CREATE INDEX IF NOT EXISTS idx_pairs_hi ON pairs(user_hi);
CREATE INDEX IF NOT EXISTS idx_pairs_last_ride ON pairs(last_ride);

CREATE TABLE IF NOT EXISTS daily_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  day_key TEXT NOT NULL,              -- 'YYYY-MM-DD', rolled at 09:00 UTC
  mode TEXT NOT NULL,                 -- 'solo' | 'pair'
  time_ms INTEGER,                    -- NULL on a DNF
  dnf INTEGER NOT NULL DEFAULT 0,
  distance REAL DEFAULT 0,
  collectibles INTEGER DEFAULT 0,
  crashes INTEGER DEFAULT 0,
  safety_used INTEGER DEFAULT 0,
  sync_pct INTEGER,                   -- pair rides only
  partner_user_id INTEGER REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE (user_id, day_key, mode)     -- one ranked run per day per mode
);

CREATE INDEX IF NOT EXISTS idx_daily_day ON daily_results(day_key);
CREATE INDEX IF NOT EXISTS idx_daily_user ON daily_results(user_id, day_key);
