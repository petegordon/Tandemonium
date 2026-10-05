// ============================================================
// RoomStore — recent multiplayer rooms (localStorage persistence)
// ============================================================
//
// The rejoin-UX persistence layer extracted from lobby.js (#318 Step 3):
// which rooms you've recently been in, so RIDE TOGETHER can offer a quick
// rejoin. Pure localStorage — no DOM, no transport, no nav. Entries are
//   { roomCode, role, timestamp, partnerName }
// and rooms older than RECENT_WINDOW_MS are pruned on read. Logic is
// byte-faithful to the previous inline _saveRoom/_clearRoom/_getRecentRooms.
// ============================================================

const ROOMS_KEY = 'tandemonium-rooms';
const LEGACY_ROOM_KEY = 'tandemonium-room'; // old single-room format
const RECENT_WINDOW_MS = 5 * 60 * 1000;

export class RoomStore {
  /** Upsert a room, preserving an existing partnerName when none is supplied. */
  save(roomCode, role, partnerName) {
    try {
      const rooms = this.getRecent();
      const entry = { roomCode, role, timestamp: Date.now(), partnerName: partnerName || null };
      const existing = rooms.findIndex(r => r.roomCode === roomCode);
      if (existing >= 0) {
        // Preserve partner name if not provided
        if (!entry.partnerName && rooms[existing].partnerName) entry.partnerName = rooms[existing].partnerName;
        rooms[existing] = entry;
      } else {
        rooms.push(entry);
      }
      localStorage.setItem(ROOMS_KEY, JSON.stringify(rooms));
    } catch (e) {}
  }

  /** Remove one room by code, or clear all recent rooms when no code is given. */
  clear(roomCode) {
    try {
      if (roomCode) {
        const rooms = this.getRecent().filter(r => r.roomCode !== roomCode);
        localStorage.setItem(ROOMS_KEY, JSON.stringify(rooms));
      } else {
        localStorage.removeItem(ROOMS_KEY);
      }
    } catch (e) {}
  }

  /**
   * Recent rooms (within RECENT_WINDOW_MS). Migrates the legacy single-room
   * key into the array form and prunes stale entries as a side effect.
   */
  getRecent() {
    try {
      // Migrate old single-room format
      const oldRaw = localStorage.getItem(LEGACY_ROOM_KEY);
      if (oldRaw) {
        localStorage.removeItem(LEGACY_ROOM_KEY);
        const old = JSON.parse(oldRaw);
        if (old.roomCode) {
          const existing = localStorage.getItem(ROOMS_KEY);
          const rooms = existing ? JSON.parse(existing) : [];
          if (!rooms.some(r => r.roomCode === old.roomCode)) rooms.push(old);
          localStorage.setItem(ROOMS_KEY, JSON.stringify(rooms));
        }
      }
      const raw = localStorage.getItem(ROOMS_KEY);
      if (!raw) return [];
      const rooms = JSON.parse(raw);
      const cutoff = Date.now() - RECENT_WINDOW_MS;
      const recent = rooms.filter(r => r.timestamp > cutoff);
      if (recent.length !== rooms.length) {
        localStorage.setItem(ROOMS_KEY, JSON.stringify(recent));
      }
      return recent;
    } catch (e) { return []; }
  }
}
