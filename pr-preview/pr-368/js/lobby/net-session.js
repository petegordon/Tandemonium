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
  constructor() {
    this.net = null;
    this._epoch = 0;
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
    if (this.net) {
      this.net.onRoomJoined = null;
      this.net.onConnected = null;
      this.net.onDisconnected = null;
      this.net.onAuthError = null;
      this.net.onProfileReceived = null;
      try { this.net.destroy(); } catch (e) {}
    }
    this._epoch++;
    this.net = new NetworkManager();
    return this.net;
  }
}
