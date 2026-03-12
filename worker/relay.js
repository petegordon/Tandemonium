// Tandemonium WebSocket Relay — Cloudflare Worker + Durable Object
// Primary relay transport
// Deploy: wrangler deploy

const ROOM_TTL_MS = 30 * 60 * 1000; // 30 minutes

export class TandemRoom {
    constructor(state, env) {
        this.state = state;
        this.env = env;
    }

    async fetch(request) {
        const url = new URL(request.url);
        const role = url.searchParams.get('role');
        if (!role || !['captain', 'stoker'].includes(role)) {
            return new Response('Invalid role', { status: 400 });
        }

        // Verify relay token if RELAY_SECRET is configured
        if (this.env.RELAY_SECRET) {
            const token = url.searchParams.get('token');
            if (!token) {
                return new Response('Missing relay token', { status: 401 });
            }
            try {
                const payload = await verifyJWT(token, this.env.RELAY_SECRET);
                const room = url.searchParams.get('room') || this.state.id.toString();
                if (payload.room !== room || payload.role !== role) {
                    return new Response('Token mismatch', { status: 403 });
                }
            } catch (e) {
                return new Response('Invalid relay token', { status: 401 });
            }
        }

        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);

        // Close stale sockets for same role (reconnection dedup)
        const existing = this.state.getWebSockets(role);
        for (const sock of existing) {
            try { sock.close(1000, 'replaced'); } catch (e) {}
        }

        this.state.acceptWebSocket(server, [role]);

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
            const joinMsg = JSON.stringify({ type: 'partner-ready', role: partnerRole });
            try { server.send(joinMsg); } catch (e) { /* just connected, shouldn't fail */ }

            // Tell the existing partner the new player joined
            const readyMsg = JSON.stringify({ type: 'partner-ready', role: role });
            for (const sock of partnerReady) {
                try { sock.send(readyMsg); } catch (e) { /* closed */ }
            }
        } else {
            // No partner yet — confirm room is valid
            try { server.send(JSON.stringify({ type: 'waiting' })); } catch (e) {}
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

        // Notify partner
        const closeMsg = JSON.stringify({ type: 'disconnect', role: senderRole });
        for (const sock of this.state.getWebSockets(targetRole)) {
            try { sock.send(closeMsg); } catch (e) { /* closed */ }
        }
    }

    async webSocketError(ws) {
        ws.close();
    }

    async alarm() {
        // Clean up room if no active WebSockets remain
        const sockets = this.state.getWebSockets();
        if (sockets.length === 0) {
            await this.state.storage.deleteAll();
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

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': 'https://tandemonium.jimandi.love',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};

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
            return new Response(null, { status: 204, headers: CORS_HEADERS });
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
                    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
                });
            } catch (e) {
                writeMetric(env, 'turn_error', e.message);
                return new Response(JSON.stringify({ error: 'Failed to generate TURN credentials' }), {
                    status: 502,
                    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
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
