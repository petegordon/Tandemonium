-- A session version on each login. A token records the version of its login when it was
-- made, and stops working once the login's version is higher: signing out everywhere and
-- undoing a link or combine raise it for every login on the account. It is kept per login
-- because a session follows its login through a combine or a separate.
--
-- Additive, and safe in either order with the worker: until this is applied the worker
-- treats every login as version 0 and "sign out everywhere" answers 503. Tokens from before
-- this column have no version and count as 0, so they keep working.
--
-- Apply with:
--   npx wrangler d1 execute tandemonium-leaderboard --remote --file worker/migrations/0022_session_version.sql
-- (No semicolons inside statements or comments below: the test loader splits on them.)

ALTER TABLE user_logins ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0;
