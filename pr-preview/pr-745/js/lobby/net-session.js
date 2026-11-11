// @ts-check
// ============================================================
// NetSession — NetworkManager instance + stale-callback epoch guard
// ============================================================
//
// The join flow tears down and recreates the room NetworkManager on every
// create/join/rejoin attempt. In-flight callbacks captured by closures on a
// discarded instance must NOT clobber UI for the new room — so each replace()
// bumps an epoch, and callbacks early-return when their captured epoch is no
// longer current. That guard was repeated ~20× inline across lobby.js; this
// isolates the net-lifecycle + epoch pattern into one tested unit (#318 Step 3).
//
// Usage:
//   this._netSession.replace();               // new net, epoch++ (old torn down)
//   const epoch = this._netSession.epoch;     // capture for this attempt
//   net.onConnected = () => {
//     if (!this._netSession.isCurrent(epoch)) return;  // stale → no-op
//     …
//   };
// Lobby exposes `this.net` as a getter/setter over `session.net`, so every
// existing `this.net.*` read/write is unchanged.
// ============================================================

import { NetworkManager } from '../network-manager.js';

export class NetSession {
  /** @param {() => any} [makeNet]  builds a transport (default: a NetworkManager; tests pass a fake) */
  constructor(makeNet) {
    this.net = null;
    this._epoch = 0;
    this._makeNet = makeNet || (() => new NetworkManager());
    /** @type {((net: any) => void)|null} told after a transport is retired (replaced, adopted over, cleared) */
    this.onRetire = null;
  }

  /** The current epoch. Capture immediately after replace(); guard callbacks. */
  get epoch() {
    return this._epoch;
  }

  /** True while `epoch` is still the live session (false after a replace()). */
  isCurrent(epoch) {
    return epoch === this._epoch;
  }

  /**
   * Tear down the current net (detach callbacks + destroy) and start a fresh
   * one, bumping the epoch so stale in-flight callbacks no-op. Returns the new
   * NetworkManager.
   */
  replace() {
    this._retire(this.net, false);
    this._epoch++;
    this.net = this._makeNet();
    return this.net;
  }

  /**
   * #346 · leave the room: retire the current net (every callback detached, destroyed: it says
   * goodbye to the partner) and bump the epoch, so a create/join still awaiting a token, a
   * pending "open the room screen" or a stale-room timer from it does nothing.
   */
  clear() {
    this._retire(this.net, false);
    this._epoch++;
    this.net = null;
  }

  /**
   * #667 · HOST INSTEAD: make an already-connected transport (the new room's) the live one.
   * The old one is closed QUIETLY: callbacks detached and no partnerLeft, because the
   * partner is moving to the new room too (js/lobby/room-move.js). Bumps the epoch.
   */
  adopt(net) {
    const old = this.net;
    if (old && old !== net) this._retire(old, true);
    this._epoch++;
    this.net = net;
    return net;
  }

  /**
   * #346 · a transport this session is done with: EVERY consumer callback detached — the
   * lobby's and the ride's (game.js sets the pedal / state / lean / event / reconnect / P2P
   * ones, and they stayed on a transport the lobby threw away) — then destroyed, and
   * `onRetire` told so the ride can drop its reference too.
   */
  _retire(net, quiet) {
    if (!net) return;
    for (const k of NET_CALLBACKS) net[k] = null;
    if (quiet) net._partnerLeft = true;   // NetworkManager.destroy says goodbye only when this is false
    try { net.destroy(); } catch (e) {}
    if (this.onRetire) { try { this.onRetire(net); } catch (e) {} }
  }
}

/** Every callback a consumer assigns on a room transport (RoomTransport + NetworkManager). */
export const NET_CALLBACKS = [
  'onRoomJoined', 'onRoomWaiting', 'onConnected', 'onDisconnected', 'onReconnecting', 'onAuthError',
  'onRemoteStream', 'onP2PUpgrade', 'onPartnerLeft',
  'onProfileReceived', 'onPedalReceived', 'onStateReceived', 'onLeanReceived', 'onEventReceived',
];
