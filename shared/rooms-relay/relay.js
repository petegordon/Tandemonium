// @usersfirst/rooms-relay — the room relay: a Cloudflare Worker + Durable Object (lab #137)
//
// Lifted from Tandemonium's worker/relay.js with its behaviour unchanged. A game deploys it
// from its own Worker entry (so the Durable Object class is exported under the game's own
// name) and sets what is its own in env:
//   ROOM_BINDING       name of the Durable Object binding (default "ROOM")
//   ROOM_CODE_PATTERN  a regular expression's source for the room codes it accepts
//                      (default: 4 to 16 of A-Z, 0-9 and "-")
//   ALLOWED_ORIGINS    comma-separated origins for CORS; the first is the fallback. localhost
//                      and 127.0.0.1 are always allowed.
//   RELAY_NAME         the word in the health line ("<name> Relay OK")
// and, as before: RELAY_SECRET, TURN_KEY_ID, TURN_KEY_API_TOKEN, ANALYTICS, RELAY_IP_LIMITER.
//
// Who may sit in a room (2026-11-17): each seat (captain, stoker) belongs to the first
// connection that takes it — known by its account (a valid relay token) or, for a guest,
// the device it dialled from. While the seat is held, and for SEAT_HOLD_MS after it
// leaves, only that account or device may take it again (its own reconnects and re-dials
// replace the old socket as before). Anyone else is told the room is full and closed.
// A relay token that is present must be genuine and for this room and seat.
// With both seats taken the room hands both riders a pair proof (room-proof.js) for their
// score posts, and a P2P key so only they can find each other's peer ids.
// TURN credentials go only to a connection that holds a seat.

import { guestKey, readToken, signPairProof, SEAT_HOLD_MS } from './room-proof.js';

const ROOM_TTL_MS = 30 * 60 * 1000; // 30 minutes
/** A relay token's signature is what matters; one that expired during a long ride still names its account. */
const TOKEN_GRACE_S = 24 * 3600;
/** TURN credentials last a long ride (a refresh needs them still valid). */
const TURN_TTL_S = 3 * 3600;
/** Close code + reason for "both seats are taken". */
// (Not exported: a Worker's main module may export only handlers and classes.)
const ROOM_FULL_CODE = 4009;
const ROOM_FULL_REASON = 'room-full';

/** A device id from the query: what the game's analytics id looks like, or null. */
export function cleanDevice(raw) {
    return typeof raw === 'string' && /^[A-Za-z0-9_.:-]{8,64}$/.test(raw) ? raw : null;
}

/**
 * May this connection take `role`'s seat? `seat` is what the room stored for it (or null),
 * `open` whether a socket holds it now. → 'owner' (it's theirs), 'free' (a new holder), 'full'.
 */
export function seatDecision(seat, open, who, now) {
    if (seat) {
        const mine = (who.sub && seat.sub && String(who.sub) === String(seat.sub))
            || (who.device && seat.device && who.device === seat.device);
        if (mine) return 'owner';
        const held = open || (seat.releasedAt != null && now - seat.releasedAt < SEAT_HOLD_MS);
        if (held) return 'full';
    }
    return 'free';
}

const DEFAULT_ROOM_CODE = /^[A-Z0-9-]{4,16}$/;
/**
 * A room code this relay accepts. `pattern` is env.ROOM_CODE_PATTERN (a regular expression's
 * source, e.g. "^TNDM-[A-Z0-9]{4}$"); without one, 4 to 16 of A-Z, 0-9 and "-". A pattern that
 * does not compile accepts nothing.
 */
export function isRoomCode(v, pattern) {
    if (typeof v !== 'string') return false;
    if (!pattern) return DEFAULT_ROOM_CODE.test(v);
    try { return new RegExp(pattern).test(v); } catch (e) { return false; }
}

function randomKey() {
    const b = crypto.getRandomValues(new Uint8Array(12));
    return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}
// #694 · the room remembers when it was last used and when each seat was last here (and the
// name it gave), for a week, so a joiner or a rejoin can hear "Room ABCD hasn't been used for
// 2 h" or "Pete was here 3 min ago" even on a device with no history. Only a few small fields;
// an old client ignores them (they ride on the 'waiting' message it already reads by type).
const ROOM_META_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** A display name from the query: trimmed, no control characters, at most 32 characters. */
export function cleanName(raw) {
    if (typeof raw !== 'string') return null;
    const n = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 32);
    return n || null;
}

export class Room {
    constructor(state, env) {
        this.state = state;
        this.env = env;
        this._meta = undefined;      // #694 · { createdAt, lastUsedAt, seen: { captain?: {at, name}, stoker?: {at, name} } } | null
    }

    /** #694 · the room's record (cached; null for a room never used). Storage trouble = no record. */
    async _readMeta() {
        if (this._meta === undefined) {
            try { this._meta = (await this.state.storage.get('meta')) || null; } catch (e) { this._meta = null; }
        }
        return this._meta;
    }

    /** #694 · the room is in use now, and `role` (with `name`, if given) is here. */
    async _touch(role, name) {
        const now = Date.now();
        const prev = await this._readMeta();
        const seen = { ...((prev && prev.seen) || {}) };
        if (role) seen[role] = { at: now, name: name || (seen[role] && seen[role].name) || null };
        this._meta = { createdAt: (prev && prev.createdAt) || now, lastUsedAt: now, seen };
        try { await this.state.storage.put('meta', this._meta); } catch (e) { /* the record is a nicety */ }
    }

    /** Who holds each seat: { captain?: { sub, device, gk, releasedAt }, stoker?: …, p2p? } */
    async _readSeats() {
        if (this._seats === undefined) {
            try { this._seats = (await this.state.storage.get('seats')) || {}; } catch (e) { this._seats = {}; }
        }
        return this._seats;
    }

    async _writeSeats() {
        try { await this.state.storage.put('seats', this._seats); } catch (e) { /* kept in memory */ }
    }

    _seatOpen(role, except = null) {
        return this.state.getWebSockets(role).some((s) => s !== except && s.readyState === 1);
    }

    /** GET /turn on the room: TURN credentials for a connection that holds a seat. */
    async _turn(url) {
        const role = url.searchParams.get('role');
        const device = cleanDevice(url.searchParams.get('device'));
        const seats = await this._readSeats();
        const seat = (role === 'captain' || role === 'stoker') ? seats[role] : null;
        if (!seat || !device || seat.device !== device || !this._seatOpen(role)) {
            return new Response(JSON.stringify({ error: 'Not in this room' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
        }
        const resp = await fetch(
            `https://rtc.live.cloudflare.com/v1/turn/keys/${this.env.TURN_KEY_ID}/credentials/generate-ice-servers`,
            {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${this.env.TURN_KEY_API_TOKEN}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ ttl: TURN_TTL_S }),
            }
        );
        return new Response(await resp.text(), { status: resp.ok ? 200 : 502, headers: { 'Content-Type': 'application/json' } });
    }

    async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === '/turn-credentials') return this._turn(url);
        const role = url.searchParams.get('role');
        if (!role || !['captain', 'stoker'].includes(role)) {
            return new Response('Invalid role', { status: 400 });
        }
        const room = url.searchParams.get('room') || this.state.id.toString();

        // A relay token, when sent, must be genuine and for this room and seat.
        let sub = null;
        let lid = null;
        const token = url.searchParams.get('token');
        if (token && this.env.RELAY_SECRET) {
            let payload;
            try { payload = await readToken(token, this.env.RELAY_SECRET, TOKEN_GRACE_S); } catch (e) {
                return new Response('Invalid token', { status: 403 });
            }
            if (payload.room !== room || payload.role !== role) {
                return new Response('Token mismatch', { status: 403 });
            }
            sub = payload.sub != null ? String(payload.sub) : null;
            lid = Number.isInteger(payload.lid) ? payload.lid : null;   // #783: the login in this seat
        }
        const device = cleanDevice(url.searchParams.get('device'));
        const gk = !sub && device && this.env.RELAY_SECRET ? await guestKey(this.env.RELAY_SECRET, device) : null;

        // Whose seat is it? (Decided before the stale sockets close; see below.)
        const seats = await this._readSeats();
        const decision = seatDecision(seats[role] || null, this._seatOpen(role), { sub, device }, Date.now());

        // #694: what the room knew BEFORE this connection (read first: touching it changes it).
        // Read before the stale sockets close: from there to acceptWebSocket must not await, or a
        // replaced socket's close sees no seat-holder and tells the partner "disconnect" (#620).
        const prior = await this._readMeta();
        const partnerRoleForMeta = role === 'captain' ? 'stoker' : 'captain';
        const partnerSeen = prior && prior.seen && prior.seen[partnerRoleForMeta];

        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);

        if (decision === 'full') {
            // Someone else holds this seat: say so and close. Nothing of the room is sent.
            server.accept();
            try { server.send(JSON.stringify({ type: ROOM_FULL_REASON })); } catch (e) {}
            server.close(ROOM_FULL_CODE, ROOM_FULL_REASON);
            return new Response(null, { status: 101, webSocket: client });
        }
        const prev = seats[role];
        const newHolder = decision === 'free';
        seats[role] = {
            sub: sub || (newHolder ? null : prev.sub || null),
            lid: sub ? lid : (newHolder ? null : prev.lid ?? null),
            device: device || (newHolder ? null : prev.device || null),
            gk: sub ? null : (gk || (newHolder ? null : prev.gk || null)),
            releasedAt: null,
        };
        // A new rider in a seat: a new P2P key, so an earlier holder can't find the peers.
        if (newHolder || !seats.p2p) seats.p2p = randomKey();

        // Close stale sockets for same role (reconnection dedup)
        const existing = this.state.getWebSockets(role);
        for (const sock of existing) {
            try { sock.close(1000, 'replaced'); } catch (e) {}
        }

        this.state.acceptWebSocket(server, [role]);
        const myName = cleanName(url.searchParams.get('name'));
        await this._writeSeats();          // after accept: safe to await
        await this._touch(role, myName);

        // Reset room TTL on new connection
        await this.state.storage.setAlarm(Date.now() + ROOM_TTL_MS);

        // Notify both sides when partner is already connected
        const partnerRole = role === 'captain' ? 'stoker' : 'captain';
        const partnerSockets = this.state.getWebSockets(partnerRole);
        const partnerReady = [];
        for (const sock of partnerSockets) {
            partnerReady.push(sock);
        }

        if (partnerReady.length > 0) {
            // Both seats taken: a pair proof for their score posts, the P2P key, and each
            // side's guest key (a guest partner's pair record is found by it, never by device id).
            const cap = seats.captain || {};
            const sto = seats.stoker || {};
            const proof = this.env.RELAY_SECRET
                ? await signPairProof(this.env.RELAY_SECRET, room, { u: cap.sub, l: cap.lid, g: cap.gk }, { u: sto.sub, l: sto.lid, g: sto.gk })
                : null;
            const extra = (r) => ({ pair: proof, p2p: seats.p2p, partnerGuest: (r === 'captain' ? cap : sto).gk || null });
            // Tell the new joiner their partner is here
            // #694: with the name each gave the relay (null when none), so both screens can say
            // "Sam (your Stoker) joined" at once instead of waiting for the profile message.
            const joinMsg = JSON.stringify({ type: 'partner-ready', role: partnerRole, name: (partnerSeen && partnerSeen.name) || null, ...extra(partnerRole) });
            try { server.send(joinMsg); } catch (e) { /* just connected, shouldn't fail */ }

            // Tell the existing partner the new player joined
            const readyMsg = JSON.stringify({ type: 'partner-ready', role: role, name: myName, ...extra(role) });
            for (const sock of partnerReady) {
                try { sock.send(readyMsg); } catch (e) { /* closed */ }
            }
        } else {
            // No partner yet — confirm room is valid
            // #694: plus what the room remembers: when it was last used (null = never, before
            // this connection) and when the partner's seat was last here, with their name.
            try {
                server.send(JSON.stringify({
                    type: 'waiting',
                    fresh: !prior,
                    lastUsedAt: prior ? prior.lastUsedAt : null,
                    partnerSeenAt: partnerSeen ? partnerSeen.at : null,
                    partnerName: partnerSeen ? partnerSeen.name : null,
                }));
            } catch (e) {}
        }

        return new Response(null, { status: 101, webSocket: client });
    }

    async webSocketMessage(ws, message) {
        // Reset TTL on activity
        await this.state.storage.setAlarm(Date.now() + ROOM_TTL_MS);

        // Relay to the other player
        const tags = this.state.getTags(ws);
        const senderRole = tags[0];
        const targetRole = senderRole === 'captain' ? 'stoker' : 'captain';

        for (const sock of this.state.getWebSockets(targetRole)) {
            try { sock.send(message); } catch (e) { /* closed */ }
        }
    }

    async webSocketClose(ws) {
        const tags = this.state.getTags(ws);
        const senderRole = tags[0];
        const targetRole = senderRole === 'captain' ? 'stoker' : 'captain';

        // Another socket already holds this seat (a re-dial replaced this one): the player is
        // still here, so don't tell the partner they left. That notice made the partner re-dial
        // too, and the two sides could chase each other (TV playtest 2026-11-06, #620).
        const stillHere = this.state.getWebSockets(senderRole).some((s) => s !== ws && s.readyState === 1);
        if (stillHere) return;

        // The seat stays theirs for SEAT_HOLD_MS (a reload, a dropped connection).
        const seats = await this._readSeats();
        if (seats[senderRole]) {
            seats[senderRole].releasedAt = Date.now();
            await this._writeSeats();
        }

        // Notify partner
        const closeMsg = JSON.stringify({ type: 'disconnect', role: senderRole });
        for (const sock of this.state.getWebSockets(targetRole)) {
            try { sock.send(closeMsg); } catch (e) { /* closed */ }
        }
        await this._touch(senderRole);   // #694: they were here until now
    }

    async webSocketError(ws) {
        ws.close();
    }

    async alarm() {
        // Clean up room if no active WebSockets remain
        const sockets = this.state.getWebSockets();
        if (sockets.length === 0) {
            // #694: keep the small "last used" record for a week, then forget the room.
            const meta = await this._readMeta();
            const until = meta && meta.lastUsedAt ? meta.lastUsedAt + ROOM_META_TTL_MS : 0;
            if (until > Date.now()) {
                await this.state.storage.setAlarm(until);
            } else {
                await this.state.storage.deleteAll();
                this._meta = null;
                this._seats = undefined;
            }
        } else {
            // Still active — reschedule
            await this.state.storage.setAlarm(Date.now() + ROOM_TTL_MS);
        }
    }
}

/** env.ALLOWED_ORIGINS as a list. */
export function allowedOrigins(env) {
    return String((env && env.ALLOWED_ORIGINS) || '').split(',').map((o) => o.trim()).filter(Boolean);
}

function getCorsHeaders(request, env) {
    const origin = request.headers.get('Origin') || '';
    const list = allowedOrigins(env);
    const allowed = list.includes(origin)
        || /^https?:\/\/localhost(:\d+)?$/.test(origin)
        || /^https?:\/\/127\.0\.0\.1(:\d+)?$/.test(origin);
    return {
        'Access-Control-Allow-Origin': allowed ? origin : (list[0] || 'null'),
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
    };
}

function writeMetric(env, event, extra) {
    if (!env.ANALYTICS) return;
    env.ANALYTICS.writeDataPoint({
        blobs: [event, ...(extra ? [extra] : [])],
        doubles: [1],
        indexes: [event],
    });
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        // CORS preflight
        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: getCorsHeaders(request, env) });
        }

        const room = url.searchParams.get('room');
        const isTurn = url.pathname === '/turn-credentials';
        if (!room && !isTurn) {
            return new Response((env.RELAY_NAME || 'Rooms') + ' Relay OK', { status: 200 });
        }
        const json = (body, status) => new Response(JSON.stringify(body), {
            status, headers: { 'Content-Type': 'application/json', ...getCorsHeaders(request, env) },
        });
        if (!isRoomCode(room, env.ROOM_CODE_PATTERN)) return isTurn ? json({ error: 'Not in this room' }, 403) : new Response('Bad room', { status: 400 });

        // Per IP: room codes are short, so guessing them has to be slow.
        if (env.RELAY_IP_LIMITER) {
            const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
            try {
                const { success } = await env.RELAY_IP_LIMITER.limit({ key: ip });
                if (!success) return isTurn ? json({ error: 'Too many requests' }, 429) : new Response('Too many requests', { status: 429 });
            } catch (e) { /* the limiter is a guard, not a gate */ }
        }

        writeMetric(env, isTurn ? 'turn_credentials' : 'relay_connect', room);

        // Route to Durable Object by room code (TURN credentials too: only a seat holder gets them)
        const rooms = env[env.ROOM_BINDING || 'ROOM'];
        const id = rooms.idFromName(room);
        const obj = rooms.get(id);
        if (!isTurn) return obj.fetch(request);
        try {
            const res = await obj.fetch(request);
            return new Response(await res.text(), { status: res.status, headers: { 'Content-Type': 'application/json', ...getCorsHeaders(request, env) } });
        } catch (e) {
            writeMetric(env, 'turn_error', e.message);
            return json({ error: 'Failed to generate TURN credentials' }, 502);
        }
    }
};
