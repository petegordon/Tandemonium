-- A public id on each account: the short id that boards and profiles show for a player in
-- place of the account number. The worker makes it from the account number (see
-- worker/accounts/public-id.js) and stores it here the first time an account signs in or
-- appears in a public answer, so a profile can be found by it (GET /player/<pid>).
--
-- Additive, and safe in either order with the worker: until this is applied the worker
-- still shows public ids on boards, and a profile lookup by public id finds nobody (404).
-- Rows start NULL and are filled as accounts are seen.
--
-- Apply with:
--   npx wrangler d1 execute tandemonium-leaderboard --remote --file worker/migrations/0024_public_ids.sql
-- (No semicolons inside statements or comments below: the test loader splits on them.)

ALTER TABLE users ADD COLUMN public_id TEXT;

CREATE INDEX IF NOT EXISTS idx_users_public_id ON users (public_id);
