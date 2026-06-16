// ============================================================
// BikeCodec — Tandemonium's game-specific multiplayer message codec
// ============================================================
//
// The binary schema for the bike-physics messages that ride on top of the
// generic room transport. Extracted from network-manager.js (#318 Step 2) so
// the transport can send/receive OPAQUE bytes and know nothing about bikes —
// the first separation toward @usersfirst/room. Wire format is unchanged
// (byte-for-byte identical to the previous inline encoder/decoder).
//
// Message layout (little-endian), keyed by a 1-byte type tag (MSG_*):
//   STATE  (46B): [type][x f32][y f32][z f32][heading f32][lean f32]
//                 [leanVelocity f32][speed f32][crankAngle f32]
//                 [distanceTraveled f32][roadD f32][flags u8][timer f32]
//                 — legacy 42B messages omit the trailing timer field.
//   LEAN   (5B):  [type][lean f32]
//   PEDAL  (2B):  [type][0x01 down | 0x00 up]
//   EVENT  (2B):  [type][eventByte]
//   PROFILE(var): [type][utf-8 JSON…]
//
// HEARTBEAT stays in the transport — it's a generic keepalive, not game data.
// ============================================================

import { MSG_PEDAL, MSG_STATE, MSG_EVENT, MSG_LEAN, MSG_PROFILE } from '../config.js';

export class BikeCodec {
  constructor() {
    // Pre-allocated send buffers — STATE/LEAN are on the ~60Hz send path, so
    // we reuse one buffer each instead of allocating per send. The returned
    // view is sent synchronously by the transport, so reuse next frame is safe.
    this._stateBuf = new ArrayBuffer(46);
    this._stateView = new DataView(this._stateBuf);
    this._stateBytes = new Uint8Array(this._stateBuf);
    this._leanBuf = new ArrayBuffer(5);
    this._leanView = new DataView(this._leanBuf);
    this._leanBytes = new Uint8Array(this._leanBuf);
  }

  /** Encode bike physics + timer into the shared 46-byte STATE buffer. */
  encodeState(bike, timerRemaining) {
    const view = this._stateView;
    view.setUint8(0, MSG_STATE);
    view.setFloat32(1, bike.position.x, true);
    view.setFloat32(5, bike.position.y, true);
    view.setFloat32(9, bike.position.z, true);
    view.setFloat32(13, bike.heading, true);
    view.setFloat32(17, bike.lean, true);
    view.setFloat32(21, bike.leanVelocity, true);
    view.setFloat32(25, bike.speed, true);
    view.setFloat32(29, bike.crankAngle || 0, true);
    view.setFloat32(33, bike.distanceTraveled, true);
    view.setFloat32(37, bike.roadD, true);
    let flags = 0;
    if (bike.fallen) flags |= 1;
    if (bike._braking) flags |= 2;
    view.setUint8(41, flags);
    view.setFloat32(42, timerRemaining >= 0 ? timerRemaining : -1, true);
    return this._stateBytes;
  }

  /** Decode a STATE message. Tolerates legacy 42-byte (timer-less) messages. */
  decodeState(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const state = {
      x: view.getFloat32(1, true),
      y: view.getFloat32(5, true),
      z: view.getFloat32(9, true),
      heading: view.getFloat32(13, true),
      lean: view.getFloat32(17, true),
      leanVelocity: view.getFloat32(21, true),
      speed: view.getFloat32(25, true),
      crankAngle: view.getFloat32(29, true),
      distanceTraveled: view.getFloat32(33, true),
      roadD: view.getFloat32(37, true),
      flags: view.getUint8(41)
    };
    // Timer field added in 46-byte messages; absent in legacy 42-byte messages.
    if (bytes.byteLength >= 46) {
      state.timerRemaining = view.getFloat32(42, true);
    }
    return state;
  }

  /** Encode lean into the shared 5-byte LEAN buffer. */
  encodeLean(leanValue) {
    const view = this._leanView;
    view.setUint8(0, MSG_LEAN);
    view.setFloat32(1, leanValue, true);
    return this._leanBytes;
  }

  /** Decode a LEAN message → lean float. Caller guards length (>= 5). */
  decodeLean(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return view.getFloat32(1, true);
  }

  /** Encode a pedal up/down event (fresh 2-byte buffer). */
  encodePedal(foot) {
    return new Uint8Array([MSG_PEDAL, foot === 'down' ? 0x01 : 0x00]);
  }

  /** Decode a PEDAL message → 'down' | 'up'. */
  decodePedal(bytes) {
    return (bytes.length >= 2 && bytes[1] === 0x01) ? 'down' : 'up';
  }

  /** Encode a one-byte game event (fresh 2-byte buffer). */
  encodeEvent(eventType) {
    return new Uint8Array([MSG_EVENT, eventType]);
  }

  /** Encode a JSON profile payload (fresh buffer). */
  encodeProfile(data) {
    const json = JSON.stringify(data);
    const encoded = new TextEncoder().encode(json);
    const msg = new Uint8Array(1 + encoded.length);
    msg[0] = MSG_PROFILE;
    msg.set(encoded, 1);
    return msg;
  }

  /** Decode a PROFILE message → parsed object. May throw on malformed JSON. */
  decodeProfile(bytes) {
    const json = new TextDecoder().decode(bytes.slice(1));
    return JSON.parse(json);
  }

  /**
   * Route an opaque inbound frame to the matching game handler. This is the
   * inbound half of the protocol — it keeps the transport free of any
   * `MSG_*` knowledge (the transport hands over any non-keepalive bytes and
   * this decides what they mean). Returns true if the frame was a known game
   * message, false otherwise (so the transport can ignore unknown frames).
   *
   * @param {Uint8Array} bytes
   * @param {{onState?:Function,onPedal?:Function,onEvent?:Function,onLean?:Function,onProfile?:Function}} h
   */
  dispatch(bytes, h) {
    if (!bytes || bytes.length === 0) return false;
    switch (bytes[0]) {
      case MSG_PEDAL:
        if (h.onPedal) h.onPedal(this.decodePedal(bytes));
        return true;
      case MSG_STATE:
        if (h.onState) h.onState(this.decodeState(bytes));
        return true;
      case MSG_EVENT:
        if (bytes.length >= 2 && h.onEvent) h.onEvent(bytes[1]);
        return true;
      case MSG_LEAN:
        if (bytes.length >= 5 && h.onLean) h.onLean(this.decodeLean(bytes));
        return true;
      case MSG_PROFILE:
        try { if (h.onProfile) h.onProfile(this.decodeProfile(bytes)); } catch (e) { /* malformed */ }
        return true;
      default:
        return false;
    }
  }
}
