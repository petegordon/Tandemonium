-- housetandem.com account page "Playing the playtest": look up an account's Steam sessions
-- (sessions.google_uid holds the account number as text) without scanning every session.
CREATE INDEX IF NOT EXISTS idx_sessions_account_platform ON sessions(google_uid, platform);
