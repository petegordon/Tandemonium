-- #657 · share a result. A result card image held for a short time (7 days) so
-- a phone can open it from the TV's QR (tandemonium.housetandem.com/share/?id=…),
-- and the one-post-a-day record for the House Tandem Discord #daily-ride post.
-- The image is base64 text (a JPEG/PNG of at most ~1 MB), so D1 hands it back
-- the same in every runtime. Expired rows are deleted on the next upload.

CREATE TABLE IF NOT EXISTS shares (
  id TEXT PRIMARY KEY,
  image_b64 TEXT NOT NULL,
  content_type TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  caption TEXT,
  link TEXT,
  day_key TEXT,                       -- the Daily Ride's day, NULL for any other road
  ip_hash TEXT,
  device_id TEXT,
  created_at INTEGER NOT NULL,        -- ms since epoch
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_shares_expires ON shares(expires_at);
CREATE INDEX IF NOT EXISTS idx_shares_ip ON shares(ip_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_shares_device ON shares(device_id, created_at);

-- One #daily-ride post per player per Daily Ride day.
CREATE TABLE IF NOT EXISTS discord_posts (
  user_id INTEGER NOT NULL,
  day_key TEXT NOT NULL,
  share_id TEXT,
  posted_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, day_key)
);
