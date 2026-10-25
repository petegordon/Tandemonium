-- A-9 · persistent anonymous device id
--
-- Sessions were identified only by a per-tab UUID in sessionStorage, so two
-- visits from the same browser looked like two strangers and D1/D7 retention
-- was unmeasurable for anyone not signed in. device_id is a UUID kept in
-- localStorage on the client; it is anonymous, per-browser-profile, and never
-- shown to players.
--
-- Nullable on purpose: older clients (and private-mode browsers whose
-- localStorage throws) keep sending sessions without one, and those must still
-- be accepted.

ALTER TABLE sessions ADD COLUMN device_id TEXT;
CREATE INDEX IF NOT EXISTS idx_sessions_device ON sessions(device_id);
