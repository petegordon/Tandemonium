-- Everyone on a ride, not just Player 1 (Pete 2026-11-09). A session is one
-- copy of the game running and belongs to Player 1; couch players 2–4 come and
-- go between rides, so they are recorded per ride. user_id is set only from
-- the seat's own verified sign-in token, never from an id the game claims.
-- An online partner is not a seat here: their own game logs their own ride.

CREATE TABLE IF NOT EXISTS ride_seats (
  ride_id TEXT NOT NULL REFERENCES rides(id),
  seat INTEGER NOT NULL,              -- 1-4, the player number
  user_id INTEGER,                    -- the seat's account (users.id), null for a guest
  role TEXT,                          -- 'solo', 'captain', 'stoker', 'versus'
  team TEXT,                          -- versus: 'A' or 'B'
  input_type TEXT,                    -- 'gamepad', 'keyboard', 'phone', 'touch', 'gyro', 'bot', ...
  controller TEXT,                    -- the controller's name, when there is one
  PRIMARY KEY (ride_id, seat)
);

CREATE INDEX IF NOT EXISTS idx_ride_seats_user ON ride_seats(user_id);
