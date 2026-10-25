-- Migration 0006: Add WebRTC quality metrics to rooms
ALTER TABLE rooms ADD COLUMN avg_rtt_ms INTEGER;
ALTER TABLE rooms ADD COLUMN max_rtt_ms INTEGER;
ALTER TABLE rooms ADD COLUMN packet_loss_pct REAL;
