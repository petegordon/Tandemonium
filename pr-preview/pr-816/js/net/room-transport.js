// ============================================================
// RoomTransport — Tandemonium's settings for @usersfirst/rooms
// ============================================================
//
// The transport itself (room join-by-code, relay primary + P2P upgrade +
// automatic fallback, reconnect/backoff, the HEARTBEAT keepalive, media calls)
// now lives in the controller lab as @usersfirst/rooms and is vendored into
// shared/rooms/ (`npm run sync-rooms`; #346, lab #137). Edit it there, not here.
//
// What is left in this file is what is Tandemonium's own: where its relay and
// PeerJS server are, its heartbeat message type, its room-code prefix, this
// device's id, whether this edition has camera/mic, where the partner's voice
// plays, and keeping the stored room's timestamp fresh. NetworkManager extends
// this and adds the bike codec + protocol.
// ============================================================

// (rooms 0.2: the relay, the P2P upgrade and camera/mic calls are separate layers; this is all three)
import { MediaRoomTransport as SharedRoomTransport } from '../../shared/rooms/index.js';
import {
  MSG_HEARTBEAT,
  TURN_CREDENTIALS_URL, PEERJS_HOST, PEERJS_PORT, PEERJS_PATH, PEERJS_SECURE
} from '../config.js';
import { isMediaEnabled } from '../edition.js';
import { getDeviceId } from '../analytics.js';

/** The recent-rooms list (js/lobby/room-store.js): keep this room's entry from ageing out while we hold it. */
function refreshRoomTimestamp(roomCode) {
  try {
    const raw = localStorage.getItem('tandemonium-rooms');
    if (raw) {
      const rooms = JSON.parse(raw);
      const entry = rooms.find(r => r.roomCode === roomCode);
      if (entry) {
        entry.timestamp = Date.now();
        localStorage.setItem('tandemonium-rooms', JSON.stringify(rooms));
      }
    }
  } catch (e) {}
}

export class RoomTransport extends SharedRoomTransport {
  constructor() {
    super({
      heartbeatType: MSG_HEARTBEAT,
      turnCredentialsUrl: TURN_CREDENTIALS_URL,
      peerjs: { host: PEERJS_HOST, port: PEERJS_PORT, path: PEERJS_PATH, secure: PEERJS_SECURE },
      deviceId: getDeviceId,
      // Room camera/mic (#400 D7): off unless this edition and URL allow it.
      mediaEnabled: isMediaEnabled(),
      codePrefix: 'TNDM-',
      fastChannelLabel: 'tndm-fast',
      audioElement: () => (typeof document !== 'undefined' ? document.getElementById('partner-audio') : null),
      onKeepalive: refreshRoomTimestamp,
    });
  }
}
