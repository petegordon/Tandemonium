// Tandemonium WebSocket Relay — Cloudflare Worker + Durable Object
// Fallback transport for when WebRTC P2P fails (~20% of connections)
// Deploy: wrangler deploy

export class TandemRoom {
    constructor(state) {
        this.state = state;
    }

    async fetch(request) {
        const url = new URL(request.url);
        const role = url.searchParams.get('role');
        if (!role || !['captain', 'stoker'].includes(role)) {
            return new Response('Invalid role', { status: 400 });
        }

        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);

        this.state.acceptWebSocket(server, [role]);

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
        }

        return new Response(null, { status: 101, webSocket: client });
    }

    async webSocketMessage(ws, message) {
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
}

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': 'https://tandemonium.jimandi.love',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        // CORS preflight
        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: CORS_HEADERS });
        }

        // TURN credential endpoint
        if (url.pathname === '/turn-credentials') {
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

        // Route to Durable Object by room code
        const id = env.TANDEM_ROOM.idFromName(room);
        const obj = env.TANDEM_ROOM.get(id);
        return obj.fetch(request);
    }
};
