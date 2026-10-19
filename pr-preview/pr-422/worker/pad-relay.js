// Tandemonium phone-pad relay (#421): Cloudflare Worker + Durable Object
//
// A phone remote ("pad") steers a seat in a game on another screen. One
// PadRoom per pad code. Roles: `host` (the game) and `pad-1`..`pad-4`.
//
//   pad  -> host : binary input frames, forwarded with a 1-byte seat prefix;
//                  JSON text wrapped as {type:'from-pad', seat, msg}
//   host -> pads : JSON {type:'to-pad', seat?: n, msg}  (no seat = every pad)
//   relay -> host: {type:'pad-joined'|'pad-left', seat}
//   relay -> pad : {type:'host-ready'|'host-left'|'waiting'}
//
// Host: the first host socket claims the room with ?k=<host key> (its SHA-256
// is stored); a reconnect must present the same key, so knowing the code alone
// can't take over or wipe a game's room.
//
// Pairing: the host registers SHA-256(secret) per seat with
// {type:'allow', seat, hash}. A pad connects with ?k=<secret>; the relay hashes
// it and compares, so knowing the 6-letter code alone is not enough. The secret
// travels in the link's #fragment (never sent to the game site or to
// link-preview bots). Kept separate from relay.js (RIDE TOGETHER) so each
// deploys on its own.
//
// Deploy: wrangler deploy --config wrangler-pad.toml

import { parsePadRole, seatOfRole, isValidPadCode, sha256hex, MAX_SEATS } from '../js/remote/pad-protocol.js';

const ROOM_TTL_MS = 30 * 60 * 1000;   // like RIDE TOGETHER rooms
const MAX_FRAME_BYTES = 64;           // input frames are 8 bytes
const MSG_RATE = 90;                  // per socket, per second (phones send ~30)
const MSG_BURST = 180;
const ALARM_REFRESH_MS = 60 * 1000;   // TTL refresh: at most a storage write a minute

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
    if (m.type === 'allow') {
      const seat = Number(m.seat);
      if (!(seat >= 1 && seat <= MAX_SEATS) || typeof m.hash !== 'string' || !/^[0-9a-f]{64}$/.test(m.hash)) return null;
      return { allow: { seat, hash: m.hash } };
    }
    if (m.type === 'to-pad') {
      const seats = m.seat ? [Number(m.seat)] : [1, 2, 3, 4];
      return {
        to: seats.filter((s) => s >= 1 && s <= MAX_SEATS).map((s) => 'pad-' + s),
        data: JSON.stringify(m.msg ?? null),
      };
    }
    return null;
  }
  const seat = seatOfRole(senderRole);
  if (!seat) return null;
  if (typeof message === 'string') {
    if (message.length > 2048) return null;
    let msg;
    try { msg = JSON.parse(message); } catch { return null; }
    return { to: ['host'], data: JSON.stringify({ type: 'from-pad', seat, msg }) };
  }
  const bytes = message instanceof Uint8Array ? message : new Uint8Array(message);
  if (bytes.length === 0 || bytes.length > MAX_FRAME_BYTES) return null;
  const out = new Uint8Array(bytes.length + 1);
  out[0] = seat;
  out.set(bytes, 1);
  return { to: ['host'], data: out };
}

/** Does `secret` match the hash the host registered? Pure; exported for tests. */
export async function secretMatches(secret, allowedHash) {
  if (!allowedHash || typeof secret !== 'string' || !/^[0-9a-f]{32}$/.test(secret)) return false;
  return (await sha256hex(secret)) === allowedHash;
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

    if (role === 'host') {
      const key = url.searchParams.get('k');
      const claimed = await this.state.storage.get('hostkey');
      if (!claimed) {
        if (typeof key !== 'string' || !/^[0-9a-f]{32}$/.test(key)) return new Response('Host key required', { status: 403 });
        await this.state.storage.put('hostkey', await sha256hex(key));
      } else if (!(await secretMatches(key, claimed))) {
        return new Response('Not this room\'s host', { status: 403 });
      }
    } else {
      const allowed = await this.state.storage.get('allow:' + seatOfRole(role));
      if (!(await secretMatches(url.searchParams.get('k'), allowed))) {
        return new Response('Not paired', { status: 403 });
      }
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // A reconnect replaces the old socket for the same role.
    for (const sock of this.state.getWebSockets(role)) {
      try { sock.close(1000, 'replaced'); } catch { /* closed */ }
    }
    this.state.acceptWebSocket(server, [role]);
    await this.state.storage.setAlarm(Date.now() + ROOM_TTL_MS);

    if (role === 'host') {
      // Tell the host which phones are already here, and those phones the host is back.
      for (let seat = 1; seat <= MAX_SEATS; seat++) {
        const pads = this.state.getWebSockets('pad-' + seat);
        if (pads.length) {
          this._send(server, { type: 'pad-joined', seat });
          for (const p of pads) this._send(p, { type: 'host-ready' });
        }
      }
    } else {
      const hosts = this.state.getWebSockets('host');
      this._send(server, { type: hosts.length ? 'host-ready' : 'waiting' });
      for (const h of hosts) this._send(h, { type: 'pad-joined', seat: seatOfRole(role) });
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
      // A new secret for a seat drops the phone that used the old one.
      for (const p of this.state.getWebSockets('pad-' + r.allow.seat)) {
        try { p.close(4001, 'new link'); } catch { /* closed */ }
      }
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
    const obj = env.PAD_ROOM.get(env.PAD_ROOM.idFromName(code));
    return obj.fetch(request);
  },
};
