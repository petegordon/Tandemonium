-- Migration: 0007_session_ip_address.sql
-- Add IP address to sessions for developer session exclusion filtering.

ALTER TABLE sessions ADD COLUMN ip_address TEXT;

CREATE INDEX IF NOT EXISTS idx_sessions_ip ON sessions(ip_address);
