// Tandemonium WebSocket Relay — Cloudflare Worker + Durable Object
// Primary relay transport
// Deploy: wrangler deploy

const ROOM_TTL_MS = 30 * 60 * 1000; // 30 minutes
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

export class TandemRoom {
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

    async fetch(request) {
        const url = new URL(request.url);
        const role = url.searchParams.get('role');
        if (!role || !['captain', 'stoker'].includes(role)) {
            return new Response('Invalid role', { status: 400 });
        }

        // Verify relay token if provided (optional — unauthenticated connections allowed)
        const token = url.searchParams.get('token');
        if (token && this.env.RELAY_SECRET) {
            try {
                const payload = await verifyJWT(token, this.env.RELAY_SECRET);
                const room = url.searchParams.get('room') || this.state.id.toString();
                if (payload.room !== room || payload.role !== role) {
                    return new Response('Token mismatch', { status: 403 });
                }
            } catch (e) {
                // Invalid token — allow connection anyway (don't block gameplay)
                console.warn('Relay: invalid token, allowing unauthenticated connection');
            }
        }

        // #694: what the room knew BEFORE this connection (read first: touching it changes it).
        // Read before the stale sockets close: from there to acceptWebSocket must not await, or a
        // replaced socket's close sees no seat-holder and tells the partner "disconnect" (#620).
        const prior = await this._readMeta();
        const partnerRoleForMeta = role === 'captain' ? 'stoker' : 'captain';
        const partnerSeen = prior && prior.seen && prior.seen[partnerRoleForMeta];

        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);

        // Close stale sockets for same role (reconnection dedup)
        const existing = this.state.getWebSockets(role);
        for (const sock of existing) {
            try { sock.close(1000, 'replaced'); } catch (e) {}
        }

        this.state.acceptWebSocket(server, [role]);
        const myName = cleanName(url.searchParams.get('name'));
        await this._touch(role, myName);   // after accept: safe to await

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
            // Tell the new joiner their partner is here
            // #694: with the name each gave the relay (null when none), so both screens can say
            // "Sam (your Stoker) joined" at once instead of waiting for the profile message.
            const joinMsg = JSON.stringify({ type: 'partner-ready', role: partnerRole, name: (partnerSeen && partnerSeen.name) || null });
            try { server.send(joinMsg); } catch (e) { /* just connected, shouldn't fail */ }

            // Tell the existing partner the new player joined
            const readyMsg = JSON.stringify({ type: 'partner-ready', role: role, name: myName });
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
            }
        } else {
            // Still active — reschedule
            await this.state.storage.setAlarm(Date.now() + ROOM_TTL_MS);
        }
    }
}

// JWT verification (shared HMAC-SHA256 with API worker)
async function verifyJWT(token, secret) {
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('Invalid token');

    const key = await crypto.subtle.importKey(
        'raw', new TextEncoder().encode(secret),
        { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
    );

    const data = `${parts[0]}.${parts[1]}`;
    const sig = Uint8Array.from(
        atob(parts[2].replace(/-/g, '+').replace(/_/g, '/')),
        c => c.charCodeAt(0)
    );
    const valid = await crypto.subtle.verify('HMAC', key, sig, new TextEncoder().encode(data));
    if (!valid) throw new Error('Invalid signature');

    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) throw new Error('Token expired');

    return payload;
}

function getCorsHeaders(request) {
    const origin = request.headers.get('Origin') || '';
    const allowed = origin === 'https://tandemonium.housetandem.com'
        || origin === 'https://tandemonium.jimandi.love'
        || /^https?:\/\/localhost(:\d+)?$/.test(origin)
        || /^https?:\/\/127\.0\.0\.1(:\d+)?$/.test(origin);
    return {
        'Access-Control-Allow-Origin': allowed ? origin : 'https://tandemonium.housetandem.com',
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
            return new Response(null, { status: 204, headers: getCorsHeaders(request) });
        }

        // TURN credential endpoint
        if (url.pathname === '/turn-credentials') {
            writeMetric(env, 'turn_credentials');
            try {
                const resp = await fetch(
                    `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
                    {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${env.TURN_KEY_API_TOKEN}`,
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({ ttl: 86400 }),
                    }
                );
                const data = await resp.json();
                return new Response(JSON.stringify(data), {
                    headers: { 'Content-Type': 'application/json', ...getCorsHeaders(request) },
                });
            } catch (e) {
                writeMetric(env, 'turn_error', e.message);
                return new Response(JSON.stringify({ error: 'Failed to generate TURN credentials' }), {
                    status: 502,
                    headers: { 'Content-Type': 'application/json', ...getCorsHeaders(request) },
                });
            }
        }

        const room = url.searchParams.get('room');

        if (!room) {
            return new Response('Tandemonium Relay OK', { status: 200 });
        }

        writeMetric(env, 'relay_connect', room);

        // Route to Durable Object by room code
        const id = env.TANDEM_ROOM.idFromName(room);
        const obj = env.TANDEM_ROOM.get(id);
        return obj.fetch(request);
    }
};
