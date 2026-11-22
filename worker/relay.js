// Tandemonium WebSocket Relay — Cloudflare Worker + Durable Object
// Primary relay transport
// Deploy: wrangler deploy
//
// The relay itself (who may sit in a room, forwarding, the pair proof, the P2P key, TURN
// credentials, what a room remembers) lives in the controller lab's @usersfirst/rooms-relay
// now, vendored into shared/rooms-relay/ (`npm run sync-rooms-relay`; lab #137). Edit it
// there, not here. This file is what is Tandemonium's own: the Durable Object's name
// (wrangler.toml binds TANDEM_ROOM to the class TandemRoom), its room codes, the sites
// that may call it, and its name.

import relay, { Room, cleanDevice, seatDecision, cleanName, isRoomCode as sharedIsRoomCode } from '../shared/rooms-relay/relay.js';

/** A room code as the game makes them: TNDM- and 4 letters/digits. */
const ROOM_CODE_PATTERN = '^TNDM-[A-Z0-9]{4}$';

/** Tandemonium's settings. A var of the same name in wrangler.toml would win. */
const SETTINGS = {
    ROOM_BINDING: 'TANDEM_ROOM',
    ROOM_CODE_PATTERN,
    ALLOWED_ORIGINS: 'https://tandemonium.housetandem.com',
    RELAY_NAME: 'Tandemonium',
};

export { cleanDevice, seatDecision, cleanName };
export function isRoomCode(v) { return sharedIsRoomCode(v, ROOM_CODE_PATTERN); }

/** The Durable Object, under the name wrangler.toml already uses (the rooms' storage is keyed to it). */
export class TandemRoom extends Room {}

export default {
    fetch(request, env, ctx) {
        const e = Object.create(env || null);
        for (const k of Object.keys(SETTINGS)) if (!env || env[k] === undefined) e[k] = SETTINGS[k];
        return relay.fetch(request, e, ctx);
    },
};
