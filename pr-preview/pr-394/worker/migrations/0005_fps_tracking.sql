-- Migration 0005: Add FPS tracking to rides
ALTER TABLE rides ADD COLUMN avg_fps INTEGER;
ALTER TABLE rides ADD COLUMN min_fps INTEGER;
