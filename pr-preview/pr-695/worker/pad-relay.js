// Tandemonium phone-pad relay (#421): Cloudflare Worker + Durable Object
//
// A phone remote ("pad") steers a seat in a game on another screen. One
// PadRoom per pad code. Roles: `host` (the game) and `pad-1`..`pad-4`.
//
//   pad  -> host : binary input frames, forwarded with a 1-byte seat prefix;
//                  JSON text wrapped as {type:'from-pad', seat, msg}
//   host -> pads : JSON {type:'to-pad', seat?: n, msg}  (no seat = every pad)
//   relay -> host: {type:'relay', v} first (#454; an old relay never sends it),
//                  then {type:'pad-joined', seat, via}|{type:'pad-left', seat}
//   relay -> pad : {type:'host-ready'|'host-left'|'waiting'}
//
// Host: the first host socket claims the room with ?k=<host key> (its SHA-256
// is stored); a reconnect must present the same key, so knowing the code alone
// can't take over or wipe a game's room.
//
// Pairing: the host registers SHA-256(secret) per seat. A pad connects with
// ?k=<secret>; the relay hashes it and compares, so knowing the 6-letter code
// alone is not enough. The secret travels in the link's #fragment (never sent
// to the game site or to link-preview bots).
//
// Two secrets per seat (#454):
//   - the QR secret, {type:'allow', seat, hash} (every host version). A new
//     hash here drops the seat's phone and its phone key, as it always has.
//   - the phone's own key, set with {type:'pair', seat, qr, phone} (hosts that
//     saw {type:'relay', v>=2}). The host gives a phone that joined with the
//     QR a private key and then moves the QR to a new secret, so the QR is
//     single-use while the paired phone can still reconnect by itself.
//     'pair' never drops anyone.
// pad-joined says which one the phone used: via 'qr' or 'paired'.
//
// Kept separate from relay.js (RIDE TOGETHER) so each deploys on its own.
// Deploy: CI (deploy-workers.yml), or wrangler deploy --config wrangler-pad.toml

import { parsePadRole, seatOfRole, isValidPadCode, sha256hex, MAX_SEATS, PAD_PROTOCOL } from '../js/remote/pad-protocol.js';

const ROOM_TTL_MS = 30 * 60 * 1000;   // like RIDE TOGETHER rooms
const MAX_FRAME_BYTES = 64;           // input frames are 8 bytes
const MSG_RATE = 90;                  // per socket, per second (phones send ~30)
const MSG_BURST = 180;
const ALARM_REFRESH_MS = 60 * 1000;   // TTL refresh: at most a storage write a minute
const HASH_RE = /^[0-9a-f]{64}$/;

/**
 * Where a message from `senderRole` goes. Pure; exported for tests.
 * @param {string} senderRole
 * @param {string|ArrayBuffer|Uint8Array} message
 */
export function routeMessage(senderRole, message) {
  if (senderRole === 'host') {
    if (typeof message !== 'string') return null;
    let m;
    try { m = JSON.parse(message); } catch { return null; }
    if (!m || typeof m !== 'object') return null;
    const seat = Number(m.seat);
    const seatOk = seat >= 1 && seat <= MAX_SEATS;
    if (m.type === 'allow') {
      if (!seatOk || typeof m.hash !== 'string' || !HASH_RE.test(m.hash)) return null;
      return { allow: { seat, hash: m.hash } };
    }
    if (m.type === 'pair') {
      if (!seatOk || typeof m.qr !== 'string' || !HASH_RE.test(m.qr)) return null;
      if (m.phone != null && (typeof m.phone !== 'string' || !HASH_RE.test(m.phone))) return null;
      return { pair: { seat, qr: m.qr, phone: m.phone || null } };
    }
    if (m.type === 'to-pad') {
      const seats = m.seat ? [seat] : [1, 2, 3, 4];
      return {
        to: seats.filter((s) => s >= 1 && s <= MAX_SEATS).map((s) => 'pad-' + s),
        data: JSON.stringify(m.msg ?? null),
      };
    }
    return null;
  }
  const padSeat = seatOfRole(senderRole);
  if (!padSeat) return null;
  if (typeof message === 'string') {
    if (message.length > 2048) return null;
    let msg;
    try { msg = JSON.parse(message); } catch { return null; }
    return { to: ['host'], data: JSON.stringify({ type: 'from-pad', seat: padSeat, msg }) };
  }
  const bytes = message instanceof Uint8Array ? message : new Uint8Array(message);
  if (bytes.length === 0 || bytes.length > MAX_FRAME_BYTES) return null;
  const out = new Uint8Array(bytes.length + 1);
  out[0] = padSeat;
  out.set(bytes, 1);
  return { to: ['host'], data: out };
}

/** Does `secret` match the hash the host registered? Pure; exported for tests. */
export async function secretMatches(secret, allowedHash) {
  if (!allowedHash || typeof secret !== 'string' || !/^[0-9a-f]{32}$/.test(secret)) return false;
  return (await sha256hex(secret)) === allowedHash;
}

/**
 * Which of a seat's secrets a pad presented: its own key ('paired'), the QR
 * ('qr'), or neither (null). Pure; exported for tests.
 * @param {string|null} secret @param {{qr?: string|null, phone?: string|null}} hashes
 */
export async function padCredential(secret, { qr = null, phone = null } = {}) {
  if (await secretMatches(secret, phone)) return 'paired';
  if (await secretMatches(secret, qr)) return 'qr';
  return null;
}

/**
 * Cloudflare's free plan: rooms opened by a script could use up the daily
 * request and storage limits. The PAD_LIMITER binding (wrangler-pad.toml,
 * 30 a minute) caps /pad connects per IP. (A Worker module may only export
 * functions and classes, so the limit lives in the toml.)
 *
 * May this /pad request go on? Uses the PAD_LIMITER rate-limit binding, keyed
 * by the caller's IP. Fails open: no binding (local dev, tests), no IP, or a
 * binding error lets the request through. Exported for tests.
 * @param {any} env @param {Request} request
 */
export async function padRateOk(env, request) {
  const limiter = env && env.PAD_LIMITER;
  if (!limiter || typeof limiter.limit !== 'function') return true;
  const ip = request.headers.get('CF-Connecting-IP');
  if (!ip) return true;
  try {
    const { success } = await limiter.limit({ key: ip });
    return success !== false;
  } catch {
    return true;
  }
}

export class PadRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    // Answered by the runtime without waking the object (phones ping every 5 s).
    try { state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong')); } catch { /* old runtime */ }
    /** @type {WeakMap<WebSocket, {t: number, at: number}>} */
    this._buckets = new WeakMap();
    this._alarmAt = 0;
  }

  /** A token bucket per socket: a flood is dropped, not relayed or billed twice. */
  _withinRate(ws) {
    const now = Date.now();
    let b = this._buckets.get(ws);
    if (!b) { b = { t: MSG_BURST, at: now }; this._buckets.set(ws, b); }
    b.t = Math.min(MSG_BURST, b.t + ((now - b.at) * MSG_RATE) / 1000);
    b.at = now;
    if (b.t < 1) return false;
    b.t -= 1;
    return true;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const role = parsePadRole(url.searchParams.get('role'));
    if (!role) return new Response('Invalid role', { status: 400 });
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected WebSocket', { status: 426 });

    /** @type {'qr'|'paired'|null} */
    let via = null;
    if (role === 'host') {
      const key = url.searchParams.get('k');
      if (typeof key !== 'string' || !/^[0-9a-f]{32}$/.test(key)) return new Response('Host key required', { status: 403 });
      // Hash first: no await other than storage between get and put, so two
      // first hosts can't both claim the room.
      const keyHash = await sha256hex(key);
      const claimed = await this.state.storage.get('hostkey');
      if (!claimed) {
        await this.state.storage.put('hostkey', keyHash);
      } else if (claimed !== keyHash) {
        return new Response('Not this room\'s host', { status: 403 });
      }
    } else {
      const seat = seatOfRole(role);
      const [qr, phone] = await Promise.all([
        this.state.storage.get('allow:' + seat),
        this.state.storage.get('phone:' + seat),
      ]);
      via = await padCredential(url.searchParams.get('k'), { qr, phone });
      if (!via) return new Response('Not paired', { status: 403 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // A reconnect replaces the old socket for the same role.
    for (const sock of this.state.getWebSockets(role)) {
      try { sock.close(1000, 'replaced'); } catch { /* closed */ }
    }
    this.state.acceptWebSocket(server, [role]);
    if (via) this._setVia(server, via);
    await this.state.storage.setAlarm(Date.now() + ROOM_TTL_MS);

    if (role === 'host') {
      // Our version first, so the host knows it may use 'pair'.
      this._send(server, { type: 'relay', v: PAD_PROTOCOL });
      // Tell the host which phones are already here, and those phones the host is back.
      for (let seat = 1; seat <= MAX_SEATS; seat++) {
        const pads = this.state.getWebSockets('pad-' + seat);
        if (pads.length) {
          this._send(server, { type: 'pad-joined', seat, via: this._via(pads[pads.length - 1]) });
          for (const p of pads) this._send(p, { type: 'host-ready' });
        }
      }
    } else {
      const hosts = this.state.getWebSockets('host');
      this._send(server, { type: hosts.length ? 'host-ready' : 'waiting' });
      for (const h of hosts) this._send(h, { type: 'pad-joined', seat: seatOfRole(role), via });
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    if (!this._withinRate(ws)) return;
    const role = this.state.getTags(ws)[0];
    const r = routeMessage(role, message);
    if (!r) return;
    if ('allow' in r) {
      const key = 'allow:' + r.allow.seat;
      // A host reconnect re-sends the same pairing: that is not a new link,
      // and must not drop the phone.
      if ((await this.state.storage.get(key)) === r.allow.hash) return;
      await this.state.storage.put(key, r.allow.hash);
      await this.state.storage.delete('phone:' + r.allow.seat);
      // A new secret for a seat drops the phone that used the old one.
      for (const p of this.state.getWebSockets('pad-' + r.allow.seat)) {
        try { p.close(4001, 'new link'); } catch { /* closed */ }
      }
      return;
    }
    if ('pair' in r) {
      const { seat, qr, phone } = r.pair;
      const [oldQr, oldPhone] = await Promise.all([
        this.state.storage.get('allow:' + seat),
        this.state.storage.get('phone:' + seat),
      ]);
      if (oldQr !== qr) await this.state.storage.put('allow:' + seat, qr);
      if ((oldPhone || null) !== phone) {
        if (phone) await this.state.storage.put('phone:' + seat, phone);
        else await this.state.storage.delete('phone:' + seat);
      }
      // A phone key is only ever given to the phone on the seat now (it just
      // acked it): from here on that socket counts as paired.
      if (phone) for (const p of this.state.getWebSockets('pad-' + seat)) this._setVia(p, 'paired');
      return;
    }
    for (const target of r.to) {
      for (const sock of this.state.getWebSockets(target)) {
        try { sock.send(r.data); } catch { /* closed */ }
      }
    }
    // Input streams constantly; refresh the TTL only on control traffic.
    if (typeof message === 'string' && Date.now() - this._alarmAt > ALARM_REFRESH_MS) {
      this._alarmAt = Date.now();
      await this.state.storage.setAlarm(Date.now() + ROOM_TTL_MS);
    }
  }

  async webSocketClose(ws) {
    try { ws.close(1000); } catch { /* already closed */ }
    const role = this.state.getTags(ws)[0];
    // A socket closed because it was replaced must not report its seat as gone.
    if (this.state.getWebSockets(role).some((s) => s !== ws)) return;
    if (role === 'host') {
      for (let seat = 1; seat <= MAX_SEATS; seat++) {
        for (const p of this.state.getWebSockets('pad-' + seat)) this._send(p, { type: 'host-left' });
      }
    } else {
      for (const h of this.state.getWebSockets('host')) this._send(h, { type: 'pad-left', seat: seatOfRole(role) });
    }
  }

  async webSocketError(ws) {
    try { ws.close(); } catch { /* closed */ }
  }

  async alarm() {
    if (this.state.getWebSockets().length === 0) await this.state.storage.deleteAll();
    else await this.state.storage.setAlarm(Date.now() + ROOM_TTL_MS);
  }

  /** Which secret a pad socket joined with (kept across hibernation). */
  _via(ws) {
    try { return ws.deserializeAttachment()?.via || 'qr'; } catch { return 'qr'; }
  }

  _setVia(ws, via) {
    try { ws.serializeAttachment({ via }); } catch { /* old runtime */ }
  }

  _send(ws, obj) {
    try { ws.send(JSON.stringify(obj)); } catch { /* closed */ }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/pad') return new Response('Tandemonium Pad Relay OK', { status: 200 });
    const code = (url.searchParams.get('code') || '').toUpperCase();
    if (!isValidPadCode(code)) return new Response('Invalid code', { status: 400 });
    // Checked before the Durable Object: a refused request costs no DO request
    // or storage. Normal play (a game and a phone redialling with backoff)
    // stays far below the limit.
    if (!(await padRateOk(env, request))) return new Response('Too many requests', { status: 429 });
    const obj = env.PAD_ROOM.get(env.PAD_ROOM.idFromName(code));
    return obj.fetch(request);
  },
};
