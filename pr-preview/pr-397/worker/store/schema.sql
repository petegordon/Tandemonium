-- UserFirst Store — Centralized Licensing & Payments (Cloudflare D1)

-- Games catalog
CREATE TABLE IF NOT EXISTS games (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Products / SKUs (one per game × platform × tier)
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL REFERENCES games(id),
  platform TEXT NOT NULL,          -- 'web' | 'steam' | 'ios' | 'android'
  tier TEXT NOT NULL,              -- 'early_access' | 'general'
  price_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'usd',
  stripe_price_id TEXT,            -- Stripe Price object ID
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_products_game ON products(game_id);

-- Licenses — the core entitlement table
CREATE TABLE IF NOT EXISTS licenses (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,        -- maps to tandemonium-leaderboard users.id
  game_id TEXT NOT NULL REFERENCES games(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  platform TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'revoked' | 'refunded'
  granted_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT,                  -- NULL = permanent
  UNIQUE(user_id, game_id, platform)
);

CREATE INDEX IF NOT EXISTS idx_licenses_user ON licenses(user_id);
CREATE INDEX IF NOT EXISTS idx_licenses_game_user ON licenses(game_id, user_id);

-- Payment records
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  license_id TEXT REFERENCES licenses(id),
  user_id INTEGER NOT NULL,
  product_id TEXT NOT NULL REFERENCES products(id),
  stripe_checkout_session_id TEXT UNIQUE,
  stripe_payment_intent_id TEXT,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'usd',
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'succeeded' | 'failed' | 'refunded'
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id);
CREATE INDEX IF NOT EXISTS idx_payments_stripe_session ON payments(stripe_checkout_session_id);
CREATE INDEX IF NOT EXISTS idx_payments_stripe_pi ON payments(stripe_payment_intent_id);

-- Steam key activations (bridge Steam purchases into license system)
CREATE TABLE IF NOT EXISTS steam_activations (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  game_id TEXT NOT NULL REFERENCES games(id),
  steam_id TEXT NOT NULL,
  license_id TEXT REFERENCES licenses(id),
  activated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(steam_id, game_id)
);

CREATE INDEX IF NOT EXISTS idx_steam_user ON steam_activations(user_id);

-- Promo / beta keys
CREATE TABLE IF NOT EXISTS promo_keys (
  code TEXT PRIMARY KEY,
  game_id TEXT NOT NULL REFERENCES games(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  max_uses INTEGER NOT NULL DEFAULT 1,
  times_used INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Promo key redemptions
CREATE TABLE IF NOT EXISTS promo_redemptions (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL REFERENCES promo_keys(code),
  user_id INTEGER NOT NULL,
  license_id TEXT REFERENCES licenses(id),
  redeemed_at TEXT DEFAULT (datetime('now')),
  UNIQUE(code, user_id)
);

-- Seed data
INSERT OR IGNORE INTO games (id, name, description)
VALUES ('tandemonium', 'Tandemonium', 'Physics-based tandem bicycle party game');

INSERT OR IGNORE INTO products (id, game_id, platform, tier, price_cents, currency, active)
VALUES
  ('tandemonium-web-early',   'tandemonium', 'web',   'early_access', 599, 'usd', 1),
  ('tandemonium-web-general', 'tandemonium', 'web',   'general',      899, 'usd', 0),
  ('tandemonium-steam-early', 'tandemonium', 'steam', 'early_access', 999, 'usd', 0),
  ('tandemonium-steam-general','tandemonium','steam', 'general',     1499, 'usd', 0);
