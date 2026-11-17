-- Migration: 0010_rename_todays_launch.sql
-- #575: the achievement id todays_launch is now daily_launch. Move each
-- player's row. A player may already hold the new id from a migrated client
-- (UNIQUE(user_id, achievement_id)), so insert-or-ignore, then drop the old row.

INSERT OR IGNORE INTO user_achievements (user_id, achievement_id, earned_at, score_id)
  SELECT user_id, 'daily_launch', earned_at, score_id
  FROM user_achievements WHERE achievement_id = 'todays_launch';
DELETE FROM user_achievements WHERE achievement_id = 'todays_launch';
