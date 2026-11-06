-- Migration: 0002_analytics.sql

-- ============================================================
-- SESSIONS — one row per visitor (browser tab)
-- ============================================================
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,                -- UUID generated client-side
  started_at TEXT NOT NULL,           -- ISO 8601
  device_type TEXT,                   -- 'mobile', 'desktop', 'tablet'
  input_method TEXT,                  -- initial: 'gyro', 'tilt', 'gamepad_stick', 'gamepad_gyro', 'keyboard'
  referrer TEXT,                      -- document.referrer or UTM source
  user_agent TEXT,
  is_stoker INTEGER DEFAULT 0,       -- 1 if joined via room code
  joined_via_url INTEGER DEFAULT 0,  -- 1 if stoker arrived with ?room= query param
  room_code TEXT,                     -- nullable, set if joined a room
  google_uid TEXT,                    -- nullable, set if authenticated
  platform TEXT,                      -- 'browser', 'electron', 'steam'
  screen_width INTEGER,
  screen_height INTEGER
);

-- ============================================================
-- EVENTS — UI/flow events outside of rides
-- ============================================================
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  event_type TEXT NOT NULL,           -- see Event Types
  event_data TEXT,                    -- JSON string for event-specific payload
  created_at TEXT NOT NULL,           -- ISO 8601
  page TEXT,                          -- current screen identifier
  input_method TEXT                   -- input method at time of event
);

CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);

-- ============================================================
-- RIDES — one row per ride attempt (merged rides + ride_metrics)
-- ============================================================
CREATE TABLE IF NOT EXISTS rides (
  id TEXT PRIMARY KEY,                -- UUID generated client-side
  session_id TEXT NOT NULL REFERENCES sessions(id),
  room_code TEXT,                     -- nullable, set for multiplayer
  level TEXT NOT NULL,                -- 'tutorial', 'grandma', 'castle'
  role TEXT NOT NULL DEFAULT 'solo',  -- 'captain', 'stoker', or 'solo'
  difficulty TEXT DEFAULT 'normal',   -- 'chill', 'normal', 'daredevil'
  input_method TEXT NOT NULL,
  bike_preset TEXT,                   -- 'default', 'bike_orange', etc.
  steering_feel REAL,                 -- 0.0 (stable) to 1.0 (responsive)
  started_at TEXT NOT NULL,           -- ISO 8601
  ended_at TEXT,                      -- ISO 8601, set on complete/abandon
  completed INTEGER DEFAULT 0,       -- 1 if finished the level
  abandon_reason TEXT,                -- nullable: 'lobby_button', 'end_ride', 'page_close', 'disconnect', 'reset'
  duration_ms INTEGER,               -- total ride time in milliseconds
  distance REAL,                      -- meters traveled

  -- Checkpoint / progress
  checkpoints_passed INTEGER,        -- number of checkpoints reached
  checkpoints_total INTEGER,         -- total checkpoints in level
  collectibles INTEGER,              -- items collected
  collectibles_total INTEGER,        -- total items available in level

  -- Crash & timeout summary
  crash_count INTEGER DEFAULT 0,     -- falls from balance/obstacle/tree
  timeout_count INTEGER DEFAULT 0,   -- segment timer expirations
  restarts INTEGER DEFAULT 0,        -- checkpoint restarts used

  -- Speed metrics
  max_speed REAL,                    -- m/s peak speed during ride
  avg_speed REAL,                    -- m/s average speed during ride

  -- Balance / steering
  balance_safe_pct REAL,             -- % time |lean| < 0.5 rad
  balance_danger_pct REAL,           -- % time |lean| > 0.75 rad
  on_road_pct REAL,                  -- % time |offset| < 2.5m
  center_pct REAL,                   -- % time |offset| < 0.5m
  avg_lateral_offset REAL,           -- average |offset| from road center

  -- Physics engagement
  lean_input_total REAL,             -- cumulative |lean input|
  lean_correction_total REAL,        -- cumulative corrective lean

  -- Pedaling
  pedal_taps INTEGER,                -- total pedal inputs
  pedal_correct INTEGER,             -- correct alternating taps
  pedal_wrong INTEGER,               -- same-foot repeats
  pedal_power REAL,                  -- cumulative power output

  -- Multiplayer sync (NULL for solo)
  offset_quality REAL,               -- 0-1 crank offset score
  contribution_pct REAL,             -- this player's contribution %

  -- DDA (dynamic difficulty adjustment)
  dda_assists_offered INTEGER DEFAULT 0,
  dda_assists_accepted INTEGER DEFAULT 0,
  dda_skips_used INTEGER DEFAULT 0,
  safety_used INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_rides_session ON rides(session_id);
CREATE INDEX IF NOT EXISTS idx_rides_level ON rides(level);
CREATE INDEX IF NOT EXISTS idx_rides_created ON rides(started_at);

-- ============================================================
-- RIDE_EVENTS — things that happen during a ride
-- ============================================================
CREATE TABLE IF NOT EXISTS ride_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ride_id TEXT NOT NULL REFERENCES rides(id),
  event_type TEXT NOT NULL,           -- crash, timeout, checkpoint, collectible, pylon_pass, etc.
  distance REAL,                      -- meters along route
  event_data TEXT,                    -- JSON string for event-specific payload
  created_at TEXT NOT NULL            -- ISO 8601
);

CREATE INDEX IF NOT EXISTS idx_ride_events_ride ON ride_events(ride_id);
CREATE INDEX IF NOT EXISTS idx_ride_events_type ON ride_events(event_type);

-- ============================================================
-- ROOMS — multiplayer session lifecycle
-- ============================================================
CREATE TABLE IF NOT EXISTS rooms (
  code TEXT PRIMARY KEY,              -- 'TNDM-XXXX'
  captain_session_id TEXT NOT NULL REFERENCES sessions(id),
  created_at TEXT NOT NULL,           -- ISO 8601
  stoker_joined_at TEXT,
  stoker_session_id TEXT,
  stoker_joined_via_url INTEGER DEFAULT 0,
  webrtc_connected INTEGER DEFAULT 0,
  webrtc_fail_reason TEXT,
  connection_type TEXT,               -- 'p2p' or 'relay'
  p2p_upgrade_succeeded INTEGER,
  video_enabled INTEGER DEFAULT 0,
  audio_enabled INTEGER DEFAULT 0,
  disconnect_count INTEGER DEFAULT 0,
  rides_played INTEGER DEFAULT 0
);

-- ============================================================
-- CONVERSIONS — high-value actions (KPIs)
-- ============================================================
CREATE TABLE IF NOT EXISTS conversions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  action TEXT NOT NULL,               -- steam_wishlist_click, room_code_generated, etc.
  context TEXT,                       -- where in the flow
  url TEXT,                           -- destination URL if applicable
  created_at TEXT NOT NULL            -- ISO 8601
);

CREATE INDEX IF NOT EXISTS idx_conversions_action ON conversions(action);
CREATE INDEX IF NOT EXISTS idx_conversions_created ON conversions(created_at);
