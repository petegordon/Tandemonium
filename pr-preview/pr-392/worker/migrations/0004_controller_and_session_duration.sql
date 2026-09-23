-- Migration 0004: Add controller identification + session duration
--
-- 1. controller_name & controller_connection on rides (e.g. "DualSense" / "usb")
-- 2. controller_name & controller_connection on sessions (for device breakdown)
-- 3. ended_at on sessions (for session duration tracking)

ALTER TABLE sessions ADD COLUMN controller_name TEXT;
ALTER TABLE sessions ADD COLUMN controller_connection TEXT;
ALTER TABLE sessions ADD COLUMN ended_at TEXT;

ALTER TABLE rides ADD COLUMN controller_name TEXT;
ALTER TABLE rides ADD COLUMN controller_connection TEXT;
