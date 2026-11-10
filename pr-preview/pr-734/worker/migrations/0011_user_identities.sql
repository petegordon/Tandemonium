-- #612 · one House Tandem account, several sign-ins (Discord, Steam, Google).
-- users stays the account (its provider/provider_id is whichever sign-in
-- created it). user_identities lists every sign-in linked to the account,
-- keyed by provider id, never by email. Every existing user gets their
-- current sign-in as their first identity.

CREATE TABLE IF NOT EXISTS user_identities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  display_name TEXT,
  avatar_url TEXT,
  linked_at TEXT DEFAULT (datetime('now')),
  last_login_at TEXT,
  UNIQUE(provider, provider_id)
);

CREATE INDEX IF NOT EXISTS idx_identities_user ON user_identities(user_id);

INSERT OR IGNORE INTO user_identities (user_id, provider, provider_id, display_name, avatar_url, linked_at)
  SELECT id, provider, provider_id, display_name, avatar_url, created_at FROM users;

-- A sign-in started on one screen and finished in a browser (the TV's QR, the
-- Steam build's system browser). The game polls with a secret only it holds;
-- the row lives for 10 minutes and is deleted once read.
CREATE TABLE IF NOT EXISTS auth_requests (
  id TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL,
  provider TEXT NOT NULL,
  mode TEXT NOT NULL,
  user_code TEXT,
  link_user_id INTEGER,
  return_to TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  profile_json TEXT,
  result_json TEXT,
  created_at INTEGER NOT NULL
);
