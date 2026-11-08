// @ts-check
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
  BACK_TO_ROOM:    'backToRoom',     // #167 · captain left level select for the room
  START_RIDE:      'startRide',
  CAMERA_TOGGLE:   'cameraToggle',
  BIKE_SYNC:       'bikeSync',
  TOURIST_PLAN:    'touristPlan',    // #400 · co-op Tourist route, captain → stoker
  TOURIST_READY:   'touristReady',   // #400 · in-ride: my tiles world is up (or not)
  LEVEL_REFUSED:   'levelRefused',   // PR #397 M1/m17 · stoker → captain: my edition can't ride that
  DRESSING:        'dressing',       // #672 · my Wardrobe opened / closed (a "dressing…" tag on my card)
  ROOM_MOVED:      'roomMoved',      // #667 · HOST INSTEAD: the room is moving to { code }; follow it
  ACTIVITY:        'activity',       // #694 · I did something on the room screens (throttled; "hasn't moved for 0:30")
};

/** #667 · a room code as RoomTransport.generateRoomCode makes it ('TNDM-' + 4 of its letters). */
export function isRoomCode(code) {
  return typeof code === 'string' && /^TNDM-[A-HJ-NP-Z2-9]{4}$/.test(code);
}

export const RoomProtocol = {
  /**
   * Captain picked a level (mirrored to the stoker's display).
   *
   * C-2: `extra` carries Today's Road identity ({ key, seed }). The captain's
   * clock is authoritative — a stoker on the other side of the 09:00 UTC
   * rollover must ride the captain's road, not a road of their own.
   *
   * PR #397 M1: `extra` also carries the room's EFFECTIVE road — roadKind
   * ('daily'; #400's 'weekly' is retired) and difficulty — which the stoker adopts instead of
   * resolving from its own edition. Old stokers read only key/seed.
   */
  levelSync: (levelId, extra = null) =>
    extra ? { type: ROOM_MSG.LEVEL_SYNC, levelId, ...extra } : { type: ROOM_MSG.LEVEL_SYNC, levelId },

  /**
   * PR #397 m17 · stoker → captain: the level just synced is one this side's
   * edition does not offer (reason 'demo' = I'm on the demo). The stoker stays
   * on the level list; an old captain drops the unknown type.
   */
  levelRefused: (levelId, reason = 'demo') => ({ type: ROOM_MSG.LEVEL_REFUSED, levelId: String(levelId || ''), reason: String(reason) }),

  /** Captain picked a difficulty. */
  difficultySync: (difficulty) => ({ type: ROOM_MSG.DIFFICULTY_SYNC, difficulty }),

  /** Captain advanced the room to level selection. */
  playGame: () => ({ type: ROOM_MSG.PLAY_GAME }),

  /**
   * #167 · Captain pressed Back on level select: the stoker follows to the
   * room. Without it the captain sat in the room while the stoker stayed on
   * level select until the next PLAY GAME. An old stoker drops the unknown type.
   */
  backToRoom: () => ({ type: ROOM_MSG.BACK_TO_ROOM }),

  /**
   * Captain started the ride — both peers transition to the game.
   *
   * B-4: carries the run's placement salt (and, for a seeded level, the world
   * seed) so both clients build the same items. The captain is authoritative;
   * a stoker that receives nothing falls back to legacy placement, which is
   * what an older build already does.
   */
  //
  // #623: it also carries the ride's difficulty. The stoker otherwise kept its own (the last one
  // it had, maybe from a solo ride) whenever the captain never touched the difficulty buttons,
  // and disruptions (none on Chill), obstacles and pickups are planned from it: the cobbles
  // showed on one screen and not the other. An old stoker ignores the extra field.
  startRide: (placementSalt = 0, worldSeed = null, tourist = false, difficulty = null) => {
    const m = tourist
      ? { type: ROOM_MSG.START_RIDE, placementSalt, worldSeed, tourist: true }
      : { type: ROOM_MSG.START_RIDE, placementSalt, worldSeed };
    if (difficulty) m.difficulty = difficulty;
    return m;
  },

  /**
   * #400 · the captain planned a Tourist route. Only the two end points travel:
   * the stoker rebuilds the identical plan with the pure planRoute(). Sent
   * immediately before a startRide(…, tourist = true).
   */
  touristPlan: (from, to, anchor = null) => {
    const m = {
      type: ROOM_MSG.TOURIST_PLAN,
      from: { lat: from.lat, lon: from.lon, label: String(from.label || '') },
      // #400: null = an open-world ride around `from` (one address).
      to: to ? { lat: to.lat, lon: to.lon, label: String(to.label || '') } : null,
    };
    // PR #397 m16: the captain looked the anchor's ground height up once; the
    // stoker uses it instead of a second lookup inside the shared deadline.
    if (anchor && Number.isFinite(anchor.height)) m.anchor = { height: anchor.height, anchored: !!anchor.anchored };
    return m;
  },

  /** #400 · in-ride ready barrier for co-op Tourist. */
  touristReady: (ok) => ({ type: ROOM_MSG.TOURIST_READY, ok: !!ok }),

  /**
   * #672 · this player's Wardrobe opened (true) or closed (false). The partner's room screen tags
   * this player's card "dressing…" and the captain's START RIDE says "Partner is still dressing"
   * (it never blocks). An old peer drops the unknown type.
   */
  dressing: (open) => ({ type: ROOM_MSG.DRESSING, open: !!open }),

  /**
   * #667 · HOST INSTEAD: the stoker (a full-game guest) opened room `code` as its captain; the
   * old captain follows it as the stoker (js/lobby/room-move.js). Only sent to a partner with
   * the 'rehost' cap.
   */
  roomMoved: (code) => ({ type: ROOM_MSG.ROOM_MOVED, code: String(code || '') }),

  /**
   * #694 · this player did something on the room screens (a key, a click, a pad button). Sent
   * at most every few seconds and only after a change (ActivityPinger), so the partner can say
   * "Your Captain (Pete) hasn't moved for 0:30". An old peer drops the unknown type, and a
   * peer that never sends it never shows "hasn't moved".
   */
  activity: () => ({ type: ROOM_MSG.ACTIVITY }),

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
