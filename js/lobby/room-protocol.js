// ============================================================
// RoomProtocol — lobby↔partner coordination message vocabulary
// ============================================================
//
// The typed `sendProfile({ type: … })` messages two players exchange while in
// a room before the ride starts (level/difficulty selection, camera state,
// bike choice, and the play/start handoff). Extracted from scattered string
// literals across lobby.js (#318 Step 3) into one source of truth, used by
// both the send sites and the _handleRoomMessage receive switch.
//
// This is the lobby-level protocol that rides ON TOP of the room transport's
// opaque profile channel — distinct from the in-race bike codec (js/net).
// Builders return plain payloads; the caller still owns the connected-guard
// and `this.net.sendProfile(...)`. The untyped profile broadcast (name/avatar/
// achievements) is a separate concern and stays in _sendRoomProfile.
// ============================================================

export const ROOM_MSG = {
  LEVEL_SYNC:      'levelSync',
  DIFFICULTY_SYNC: 'difficultySync',
  PLAY_GAME:       'playGame',
  START_RIDE:      'startRide',
  CAMERA_TOGGLE:   'cameraToggle',
  BIKE_SYNC:       'bikeSync',
};

export const RoomProtocol = {
  /**
   * Captain picked a level (mirrored to the stoker's display).
   *
   * C-2: `extra` carries Today's Road identity ({ key, seed }). The captain's
   * clock is authoritative — a stoker on the other side of the 09:00 UTC
   * rollover must ride the captain's road, not a road of their own.
   */
  levelSync: (levelId, extra = null) =>
    extra ? { type: ROOM_MSG.LEVEL_SYNC, levelId, ...extra } : { type: ROOM_MSG.LEVEL_SYNC, levelId },

  /** Captain picked a difficulty. */
  difficultySync: (difficulty) => ({ type: ROOM_MSG.DIFFICULTY_SYNC, difficulty }),

  /** Captain advanced the room to level selection. */
  playGame: () => ({ type: ROOM_MSG.PLAY_GAME }),

  /**
   * Captain started the ride — both peers transition to the game.
   *
   * B-4: carries the run's placement salt (and, for a seeded level, the world
   * seed) so both clients build the same items. The captain is authoritative;
   * a stoker that receives nothing falls back to legacy placement, which is
   * what an older build already does.
   */
  startRide: (placementSalt = 0, worldSeed = null) =>
    ({ type: ROOM_MSG.START_RIDE, placementSalt, worldSeed }),

  /** A player's bike preset (so the partner renders the right bike). */
  bikeSync: (presetKey) => ({ type: ROOM_MSG.BIKE_SYNC, presetKey }),

  /** Camera on/off; carries the sender's avatar (when known) so the partner
   *  can show it while video is off. avatar is omitted when falsy. */
  cameraToggle: (enabled, avatar) => {
    const m = { type: ROOM_MSG.CAMERA_TOGGLE, enabled };
    if (avatar) m.avatar = avatar;
    return m;
  },
};
