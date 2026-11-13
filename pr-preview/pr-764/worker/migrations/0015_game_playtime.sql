-- Time in game, per account and per House Tandem game (housetandem-web #37).
-- Its own table, not keys in game_stats: every game reports it the same way,
-- the account page and the dashboard read it as columns, and the cap needs the
-- server's time of the last report. Games only ever send deltas.

CREATE TABLE IF NOT EXISTS game_playtime (
  user_id INTEGER NOT NULL REFERENCES users(id),
  game TEXT NOT NULL,                 -- 'tandemonium', 'dice', 'coins', ...
  seconds INTEGER NOT NULL DEFAULT 0, -- active time: tab visible, not idle
  sessions INTEGER NOT NULL DEFAULT 0,-- a report after 30 min without one starts a session
  first_played TEXT,
  last_played TEXT,
  last_report_ms INTEGER,             -- server clock, caps the next delta to real time
  PRIMARY KEY (user_id, game)
);
