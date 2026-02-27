-- Tandemonium Leaderboard D1 Schema

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,          -- 'google'
  provider_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(provider, provider_id)
);

CREATE TABLE IF NOT EXISTS scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  level_id TEXT NOT NULL,
  distance REAL NOT NULL,
  time_ms INTEGER NOT NULL,
  mode TEXT NOT NULL,               -- 'solo' | 'captain' | 'stoker'
  collectibles_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_scores_level_dist ON scores(level_id, distance DESC);
CREATE INDEX IF NOT EXISTS idx_scores_user ON scores(user_id);

CREATE TABLE IF NOT EXISTS score_contributions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  score_id INTEGER NOT NULL REFERENCES scores(id),
  role TEXT NOT NULL,                -- 'captain' | 'stoker' | 'solo'
  player_user_id INTEGER REFERENCES users(id),
  contribution_pct INTEGER,
  pedal_taps INTEGER DEFAULT 0,
  pedal_correct INTEGER DEFAULT 0,
  pedal_wrong INTEGER DEFAULT 0,
  pedal_power REAL DEFAULT 0,
  balance_safe_pct INTEGER DEFAULT 0,
  balance_danger_pct INTEGER DEFAULT 0,
  on_road_pct INTEGER DEFAULT 0,
  center_pct INTEGER DEFAULT 0,
  avg_lateral_offset REAL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_contrib_score ON score_contributions(score_id);

CREATE TABLE IF NOT EXISTS user_achievements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  achievement_id TEXT NOT NULL,
  earned_at TEXT DEFAULT (datetime('now')),
  score_id INTEGER REFERENCES scores(id),
  UNIQUE(user_id, achievement_id)
);

CREATE INDEX IF NOT EXISTS idx_achievements_user ON user_achievements(user_id);

CREATE TABLE IF NOT EXISTS friends (
  user_id INTEGER NOT NULL REFERENCES users(id),
  friend_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY(user_id, friend_id)
);
