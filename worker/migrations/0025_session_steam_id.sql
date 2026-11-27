-- #889 · the Steam ID on Steam sessions, signed in or not. The Steam build sends the
-- player's SteamID64 (17 digits, starting 7656119) with its analytics session, so signed-out
-- Steam players can be told apart and their Steam achievements followed. Analytics only: it is
-- claimed by the client and never trusted for sign-in or anything that needs to know who
-- someone is. Nothing else from Steam (persona name, avatar, friends) is stored.
--
-- Kept for 24 months like the rest of the session row (worker/retention.js). An account delete
-- clears it on the account's sessions and on every session with that account's Steam ID.
--
-- Additive, and safe in either order with the worker: until this is applied the worker skips
-- the Steam ID and stores the session as before. Rows start NULL.
--
-- Apply with:
--   npx wrangler d1 execute tandemonium-leaderboard --remote --file worker/migrations/0025_session_steam_id.sql
-- (No semicolons inside statements or comments below: the test loader splits on them.)

ALTER TABLE sessions ADD COLUMN steam_id TEXT;

CREATE INDEX IF NOT EXISTS idx_sessions_steam_id ON sessions (steam_id);
