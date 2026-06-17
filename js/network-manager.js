// ============================================================
// NETWORK MANAGER — game adapter over the generic RoomTransport
// ============================================================
//
// Tandemonium's multiplayer entry point. Extends the game-agnostic
// RoomTransport (js/net/room-transport.js) with the bike message protocol:
// outbound send* helpers encode via BikeCodec; inbound opaque frames are
// routed by the codec's dispatch to the game callbacks. The transport owns
// room join, relay + P2P + fallback, reconnect, heartbeat, and media — it
// never sees a bike. This is the @usersfirst/room consumer seam (#318 Step 2).
// ============================================================

import { RoomTransport } from './net/room-transport.js';
import { BikeCodec } from './net/bike-codec.js';

export class NetworkManager extends RoomTransport {
  constructor() {
    super();

    // Game receive callbacks (consumers assign these).
    this.onPedalReceived = null;
    this.onStateReceived = null;
    this.onEventReceived = null;
    this.onLeanReceived = null;
    this.onProfileReceived = null;

    // Game message codec — owns the wire schema, the pre-allocated 60Hz send
    // buffers, and the inbound dispatch.
    this._codec = new BikeCodec();
    // Inbound routing table handed to the codec — maps decoded game messages
    // back to the public callbacks. Reads the (possibly reassigned) on*Received
    // fields at call time. The pedal role-flip lives here (session state).
    this._msgHandlers = {
      onState:   (s) => { if (this.onStateReceived) this.onStateReceived(s); },
      onPedal:   (foot) => { if (this.onPedalReceived) this.onPedalReceived(this.role === 'captain' ? 'stoker' : 'captain', foot); },
      onEvent:   (b) => { if (this.onEventReceived) this.onEventReceived(b); },
      onLean:    (v) => { if (this.onLeanReceived) this.onLeanReceived(v); },
      onProfile: (p) => { if (this.onProfileReceived) this.onProfileReceived(p); },
    };
    // Wire the transport's opaque inbound frames into the game protocol.
    this.onMessage = (bytes) => this._codec.dispatch(bytes, this._msgHandlers);

    // Pending retries for sendEventReliable (eventByte → setTimeout id list).
    this._reliableEventTimers = [];
  }

  sendPedal(foot) {
    this._send(this._codec.encodePedal(foot));
  }

  sendLean(leanValue) {
    this._send(this._codec.encodeLean(leanValue));
  }

  sendState(bike, timerRemaining) {
    this._send(this._codec.encodeState(bike, timerRemaining));
  }

  sendEvent(eventType) {
    this._send(this._codec.encodeEvent(eventType));
  }

  // Send a one-shot terminal event (FINISH, GAMEOVER) with retries so a
  // single dropped packet at the relay/WebRTC boundary doesn't strand the
  // partner waiting forever. Receiver-side handlers must be idempotent
  // (state-guarded) — they already are for FINISH and GAMEOVER.
  sendEventReliable(eventType, attempts = 3, intervalMs = 200) {
    const msg = this._codec.encodeEvent(eventType);
    this._send(msg);
    for (let i = 1; i < attempts; i++) {
      const t = setTimeout(() => {
        this._send(msg);
        // Drop the timer id from the list once it fires
        const idx = this._reliableEventTimers.indexOf(t);
        if (idx >= 0) this._reliableEventTimers.splice(idx, 1);
      }, intervalMs * i);
      this._reliableEventTimers.push(t);
    }
  }

  sendProfile(data) {
    this._send(this._codec.encodeProfile(data));
  }

  destroy() {
    // Cancel any pending reliable-event retries, then tear down the transport.
    for (const t of this._reliableEventTimers) clearTimeout(t);
    this._reliableEventTimers.length = 0;
    super.destroy();
  }
}
