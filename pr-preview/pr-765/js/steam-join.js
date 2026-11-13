// @ts-check
// ============================================================
// Steam Join Game / invites (#694 E5) — the renderer side
// ============================================================
//
// While the captain's online room has a free seat, our Steam rich presence carries the room
// ("connect" = "+tandemonium_room TNDM-ABCD"): Steam friends see Join Game next to the
// player's name, and the room's "Invite a Steam friend" button opens Steam's invite picker
// with the same string. When a friend clicks either one, Steam hands that string to their
// game (electron/main.js forwards it: a cold start, or a join request while running), and
// this module reads the room code out of it and asks the game to join it, the same path a
// ?room= QR link takes, so every wait and drop message of #694 applies.
//
// Steam only offers Join Game between copies of the same app: the demo and the full game are
// separate apps, so a demo player joins a full-game friend's room by its code or QR instead.
//
// Pure helpers (unit-tested in test/unit/steam-join.test.mjs) + SteamJoin, which needs the
// desktop app's window.steam bridge (electron/preload.js) and does nothing without it.
// ============================================================

export const STEAM_CONNECT_FLAG = '+tandemonium_room';

/** How often the presence is brought up to date with the room (ms). */
export const PRESENCE_POLL_MS = 1000;

const CODE_CHARS = /^[A-Z0-9]{4,8}$/;

/** "TNDM-ABCD" from "TNDM-abcd" / "abcd"; null when it isn't a room code. */
export function normalizeRoomCode(code) {
  const s = String(code || '').trim().toUpperCase().replace(/^TNDM-/, '');
  return CODE_CHARS.test(s) ? 'TNDM-' + s : null;
}

/** The connect string for a room: "+tandemonium_room TNDM-ABCD" (null for a bad code). */
export function steamConnectString(code) {
  const c = normalizeRoomCode(code);
  return c ? `${STEAM_CONNECT_FLAG} ${c}` : null;
}

/**
 * The room code in text Steam handed us: a connect string, or a whole command line that
 * carries one ("Tandemonium.exe +tandemonium_room TNDM-ABCD"). Null when there is none.
 */
export function roomCodeFromConnect(text) {
  const m = /\+tandemonium_room\s+"?((?:TNDM-)?[A-Z0-9]{4,8})\b/i.exec(String(text || ''));
  return m ? normalizeRoomCode(m[1]) : null;
}

/**
 * What our rich presence should say for the lobby's room state. Join Game is offered only
 * while we are the captain of an open room whose partner seat is free.
 * @param {{ code?: string|null, role?: string|null, partner?: boolean }} s
 * @returns {{ connect: string|null, status: string|null }}
 */
export function steamPresence(s) {
  const code = s && s.role === 'captain' && !s.partner ? normalizeRoomCode(s.code) : null;
  if (!code) return { connect: null, status: null };
  return { connect: steamConnectString(code), status: `Waiting for a partner in room ${code.slice(5)}` };
}

export class SteamJoin {
  /**
   * @param {object} o
   * @param {any} o.steam                        window.steam (electron/preload.js)
   * @param {() => { code?: string|null, role?: string|null, partner?: boolean }} o.roomState
   * @param {(req: { code: string, friendName: string|null, via: string }) => void} o.onJoin
   * @param {() => void} [o.onReady]            Steam answered: the Invite button can show
   * @param {(fn: () => void, ms: number) => any} [o.setInterval]
   * @param {(t: any) => void} [o.clearInterval]
   */
  constructor({ steam, roomState, onJoin, onReady, setInterval: si, clearInterval: ci }) {
    this._steam = steam;
    this._roomState = roomState;
    this._onJoin = onJoin;
    this._onReady = onReady || (() => {});
    this._setInterval = si || ((fn, ms) => setInterval(fn, ms));
    this._clearInterval = ci || ((t) => clearInterval(t));
    this._timer = null;
    this._presenceKey = null;
    this._started = false;
    this._ready = false;
  }

  /** The desktop app's bridge has the join calls (the web and phone builds don't). */
  get bridged() {
    const s = this._steam;
    return !!(s && typeof s.setPresence === 'function' && typeof s.onJoinRequest === 'function');
  }

  /** Steam itself is running (the desktop app launched outside Steam has the bridge but no Steam). */
  get available() { return this._ready; }

  /**
   * Once Steam answers: listen for joins (a waiting cold-start one first) and keep the
   * presence current. False when there's no bridge at all.
   */
  start() {
    if (!this.bridged || this._started) return false;
    this._started = true;
    const s = this._steam;
    const go = () => {
      this._ready = true;
      s.onJoinRequest((req) => { this.handleRequest(req); });
      Promise.resolve(s.takePendingJoin && s.takePendingJoin())
        .then((req) => { if (req) this.handleRequest(req); })
        .catch(() => {});
      this.syncPresence();
      this._timer = this._setInterval(() => this.syncPresence(), PRESENCE_POLL_MS);
      try { this._onReady(); } catch (e) { /* the lobby's redraw */ }
    };
    if (typeof s.isAvailable !== 'function') go();
    else Promise.resolve(s.isAvailable()).then((ok) => { if (ok) go(); }).catch(() => {});
    return true;
  }

  stop() {
    if (this._timer) this._clearInterval(this._timer);
    this._timer = null;
    if (this._ready) this._set({ connect: null, status: null });
  }

  /** Bring the presence up to date (only talks to Steam when it changes). */
  syncPresence() {
    let state = null;
    try { state = this._roomState(); } catch (e) { state = null; }
    this._set(steamPresence(state || {}));
  }

  _set(p) {
    const key = `${p.connect || ''}|${p.status || ''}`;
    if (key === this._presenceKey) return;
    this._presenceKey = key;
    try { Promise.resolve(this._steam.setPresence(p)).catch(() => {}); } catch (e) { /* bridge gone */ }
  }

  /**
   * A join Steam handed us ({ connect, friend, via }): the room code out of it, the friend's
   * name when Steam says who, then onJoin. Resolves with what was passed on (null: nothing).
   */
  async handleRequest(req) {
    const code = roomCodeFromConnect(req && req.connect);
    if (!code) return null;
    let friendName = null;
    if (req.friend && typeof this._steam.friendName === 'function') {
      try { friendName = (await this._steam.friendName(req.friend)) || null; } catch (e) { friendName = null; }
    }
    const out = { code, friendName, via: String(req.via || 'steam') };
    this._onJoin(out);
    return out;
  }

  /** The room's "Invite a Steam friend": Steam's invite picker for `code`. */
  invite(code) {
    const connect = steamConnectString(code);
    if (!connect || !this._steam || typeof this._steam.inviteFriends !== 'function') return Promise.resolve(false);
    return Promise.resolve(this._steam.inviteFriends(connect)).catch(() => false);
  }
}
