-- GHSA-9fv3 · every link and combine on an account, for the notice and the 7-day undo.
-- kind 'link': a sign-in was added (provider / provider_id / login_name).
-- kind 'combine': account from_user_id was folded into user_id; undo_json is the
-- record worker/account-merge.js needs to separate them again.
-- No foreign key on user_id: the account a combine folded away is gone until undone.
CREATE TABLE IF NOT EXISTS account_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  provider TEXT,
  provider_id TEXT,
  login_name TEXT,
  from_user_id INTEGER,
  from_name TEXT,
  undo_json TEXT,
  created_at INTEGER NOT NULL,
  undo_until INTEGER NOT NULL,
  seen_at INTEGER,
  undone_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_account_events_user ON account_events(user_id, created_at);
