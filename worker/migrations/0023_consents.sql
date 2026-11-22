-- Analytics consent answers (EEA, UK, Switzerland). One row per answer. A yes keeps when it
-- was given, the country, the IP address and, when signed in, the account and its name. A no
-- keeps the choice, the time and the country only. See worker/accounts/consent.js.
--
-- Additive, and safe in either order with the worker (the game asks, and holds analytics
-- back, whether or not the answer could be stored).
--
-- Apply with:
--   npx wrangler d1 execute tandemonium-leaderboard --remote --file worker/migrations/0023_consents.sql
-- (No semicolons inside statements or comments below: the test loader splits on them.)

CREATE TABLE IF NOT EXISTS consents (
  id TEXT PRIMARY KEY,
  choice TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  user_id INTEGER,
  login_id INTEGER,
  username TEXT,
  country TEXT,
  ip_address TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_consents_user ON consents (user_id);
