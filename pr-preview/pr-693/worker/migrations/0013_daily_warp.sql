-- ============================================================
-- #611 · time warp mode: Daily Ride results ridden ahead of the real date
-- ============================================================
--
-- With the Time Warp reward a player may ride up to 7 days ahead (the road is
-- procedural from the day key, so it is the road everyone gets on that day).
-- Those rides may post to the board, marked ⏳ on the row: `warp` = 1.
--
-- One row per (user, day, mode) stays the rule. The row's flag follows its
-- best time: a faster real-day finish replaces a warped one and clears the
-- mark, and vice versa.
--
-- Additive: existing rows read as warp = 0. Apply BEFORE deploying the worker
-- that writes the column:
--   npx wrangler d1 migrations apply tandemonium-leaderboard --remote -c worker/wrangler-api.toml

ALTER TABLE daily_results ADD COLUMN warp INTEGER NOT NULL DEFAULT 0;
