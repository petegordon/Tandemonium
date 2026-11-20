-- House Tandem games beyond Tandemonium (dice first): achievements and
-- lifetime stats per account and game. Tandemonium keeps user_achievements.

CREATE TABLE IF NOT EXISTS game_achievements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  game TEXT NOT NULL,                 -- 'dice', later 'roulette', 'coins', ...
  achievement_id TEXT NOT NULL,
  earned_at TEXT DEFAULT (datetime('now')),
  UNIQUE (user_id, game, achievement_id)
);

CREATE INDEX IF NOT EXISTS idx_game_ach_user ON game_achievements(user_id, game);

CREATE TABLE IF NOT EXISTS game_stats (
  user_id INTEGER NOT NULL REFERENCES users(id),
  game TEXT NOT NULL,
  stats_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, game)
);
