// @ts-check
// ============================================================
// RoomMove — HOST INSTEAD (#667): move an online room to a new code
// ============================================================
//
// A full-game owner who joined a demo player's room (a "Demo room", #666) can
// host it instead: the room moves to a new code with the full owner as captain
// (the host, whose edition sets the room), and the demo player follows. Nobody
// types a code and nobody is left stranded. Pete, 2026-11-07: it just happens
// (no accept step), and only from the room screens.
//
// The sequence. G = the full-game guest who pressed HOST INSTEAD, H = the demo
// host; O = the old room (H captain, G stoker), N = the new one.
//
//   1. G opens a SECOND transport into N as captain while staying in O.
//      N not open on the relay within OPEN_MS → G drops it and stays in O
//      (nothing was sent; H never knew), with a toast.
//   2. N is open: G sends ROOM_MOVED { code: N } over O.
//   3. H opens a second transport into N as stoker, also staying in O.
//   4. Both see each other connected in N → each side ADOPTS its N transport
//      as the room and closes O quietly (no partnerLeft: the partner is coming
//      along). While a move is on, O dropping is ignored, so the first side to
//      close O doesn't throw the other back to the role screen.
//      G lands as captain and H as stoker, both on level select; G hosts, so
//      it is a "Full game room". Phones stay seated: the pad room (phone remote
//      seats 2-4, #562/#643) is each screen's own relay room and never moves,
//      and local seats/controllers are untouched.
//   5. Not connected in N in time (H: FOLLOW_MS after the message; G:
//      CONNECT_MS after sending it, longer, so H always gives up first) → each
//      drops N and stays in O, which both kept the whole time, with a toast.
//      If O itself dropped meanwhile, its ordinary disconnect handling runs
//      then (back to the role screen), so no one sits in a dead room.
//
// A partner without the 'rehost' room cap (an older build) is never offered
// the button, so it never gets the message (edition.canHostInstead).
//
// Pure of the DOM: the lobby passes in how to open a transport. Tested in
// test/unit/room-move.test.mjs with fake transports.
// ============================================================

/** G: the new room must be open on the relay by now. */
export const OPEN_MS = 8000;
/** H: connected with G in the new room by now (from the message). */
export const FOLLOW_MS = 10000;
/** G: H arrived in the new room by now (from sending the message). Longer than FOLLOW_MS. */
export const CONNECT_MS = 13000;

/**
 * @typedef {object} MoveNet  a transport (NetworkManager) in the new room
 * @property {any} net
 * @property {any[]} queue          room messages heard before the lobby took it over
 * @property {Promise<boolean>} opened     resolves true once the relay has us in the room
 * @property {Promise<boolean>} connected  resolves true once the partner is here too
 */

/**
 * Watch a fresh transport: its room messages queue up and its first
 * onRoomJoined / onConnected resolve promises. Call before enterRoom.
 * @param {any} net
 * @returns {MoveNet}
 */
export function watchMoveNet(net) {
  const queue = [];
  net.onProfileReceived = (p) => queue.push(p);
  const opened = new Promise((res) => { net.onRoomJoined = () => res(true); });
  const connected = new Promise((res) => { net.onConnected = () => res(true); });
  return { net, queue, opened, connected };
}

/** Close a transport without telling the partner it left (they are moving too). */
export function closeQuietly(net) {
  if (!net) return;
  net.onRoomJoined = null; net.onConnected = null; net.onDisconnected = null;
  net.onAuthError = null; net.onProfileReceived = null; net.onPartnerLeft = null;
  net._partnerLeft = true;   // NetworkManager.destroy sends partnerLeft only when this is false
  try { net.destroy(); } catch (e) { /* already gone */ }
}

/** true when `p` settles true before `ms`, else false. */
export function within(p, ms) {
  return new Promise((res) => {
    const t = setTimeout(() => res(false), ms);
    Promise.resolve(p).then((v) => { clearTimeout(t); res(!!v); }, () => { clearTimeout(t); res(false); });
  });
}

/**
 * One move, from either side. `run()` resolves
 *   { ok: true, moveNet }  connected in the new room: the caller adopts moveNet.net
 *   { ok: false, reason }  'open' | 'connect' | 'follow' | 'cancelled' | 'old-gone': still in the old room
 */
export class RoomMove {
  /**
   * @param {object} o
   * @param {'lead'|'follow'} o.side   lead = G (the new host), follow = H
   * @param {any} o.old                the old room's transport
   * @param {string} o.code            the new room's code
   * @param {(code: string, role: 'captain'|'stoker') => Promise<MoveNet>} o.openNet
   * @param {(msg: object) => void} [o.sendMoved]  lead: send ROOM_MOVED over the old room
   * @param {() => boolean} [o.live]  still on a room screen? false at any step = 'cancelled'
   *                                   (a ride started, the room was left)
   * @param {{open?: number, follow?: number, connect?: number}} [o.timeouts]
   */
  constructor({ side, old, code, openNet, sendMoved, live, timeouts = {} }) {
    this.side = side;
    this.old = old;
    this.oldCode = old && old.roomCode;
    this.code = code;
    /** @type {'captain'|'stoker'} */
    this.role = side === 'lead' ? 'captain' : 'stoker';
    this._openNet = openNet;
    this._sendMoved = sendMoved || (() => {});
    this._live = live || (() => true);
    this._t = { open: timeouts.open ?? OPEN_MS, follow: timeouts.follow ?? FOLLOW_MS, connect: timeouts.connect ?? CONNECT_MS };
    this.cancelled = false;
    this.done = false;
    /** @type {MoveNet|null} */
    this.moveNet = null;
    /** The old room dropped during the move: [reason] (replayed on failure). */
    this.oldDropped = null;
    this._origDisconnect = null;
  }

  /** Ignore the old room dropping while the move runs (the partner may close it first). */
  _guardOld() {
    const old = this.old;
    if (!old) return;
    this._origDisconnect = old.onDisconnected;
    old.onDisconnected = (reason) => {
      if (!this.done) { this.oldDropped = [reason]; return; }
      if (this._origDisconnect) this._origDisconnect(reason);
    };
  }

  /** Give the old room back its own disconnect handling; replay a drop it missed. */
  _restoreOld() {
    const old = this.old;
    if (!old) return;
    old.onDisconnected = this._origDisconnect;
    if (this.oldDropped && !old.connected && this._origDisconnect) this._origDisconnect(...this.oldDropped);
  }

  /** Stop the move (the ride started, the room was left): it fails with 'cancelled'. */
  cancel() { this.cancelled = true; }

  _stopped() {
    if (this.cancelled) return true;
    try { if (!this._live()) this.cancelled = true; } catch (e) { this.cancelled = true; }
    return this.cancelled;
  }

  _fail(reason) {
    this.done = true;
    if (this.moveNet) closeQuietly(this.moveNet.net);
    this.moveNet = null;
    this._restoreOld();
    return { ok: false, reason };
  }

  async run() {
    this._guardOld();
    this.moveNet = await this._openNet(this.code, this.role);
    if (this._stopped()) return this._fail('cancelled');
    if (this.side === 'lead') {
      const open = await within(this.moveNet.opened, this._t.open);
      if (this._stopped()) return this._fail('cancelled');
      if (!open) return this._fail('open');
      if (!this.old || !this.old.connected) return this._fail('old-gone');
      this._sendMoved({ code: this.code });
    }
    const ok = await within(this.moveNet.connected, this.side === 'lead' ? this._t.connect : this._t.follow);
    if (this._stopped()) return this._fail('cancelled');
    if (!ok) return this._fail(this.side === 'lead' ? 'connect' : 'follow');
    this.done = true;
    // The old room is now dead weight: its drop must not reach the room UI. The caller adopts
    // moveNet.net (NetSession.adopt), which closes the old transport quietly.
    if (this.old) this.old.onDisconnected = null;
    return { ok: true, moveNet: this.moveNet };
  }
}
