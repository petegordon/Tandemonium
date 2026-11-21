// @usersfirst/rooms — see README.md
import { RoomTransport } from './room-transport.js';
import { withP2P } from './p2p.js';
import { withMedia } from './media.js';

export { RoomTransport, withP2P, withMedia };
/** The relay room with the PeerJS P2P upgrade. */
export const P2PRoomTransport = withP2P(RoomTransport);
/** …and with camera and microphone calls. */
export const MediaRoomTransport = withMedia(P2PRoomTransport);
