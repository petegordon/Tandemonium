// @ts-check
// ============================================================
// pad-protocol — phone remote (#421) wire format + pairing helpers
// ============================================================
//
// The phone sends one 8-byte binary INPUT frame per tick:
//
//   [0] u8  PAD_INPUT (0x50)
//   [1] u8  seq            wraps at 256
//   [2] i16 tilt × 100     raw tilt degrees (tilt-math.js), little-endian
//   [4] u8  flags          bit0 L held, bit1 R held, bit2 tilt valid
//   [5] u8  tapsL          running press counter, wraps at 256
//   [6] u8  tapsR
//   [7] u8  nav            bit0 up 1 down 2 left 3 right 4 ok 5 back 6 recenter 7 pause
//
// Through the relay the host receives it with a 1-byte seat prefix (9 bytes).
// Control messages are JSON text. Pure module: runs in the browser, Node tests
// and the relay Worker.
// ============================================================

export const PAD_INPUT = 0x50;
export const FRAME_BYTES = 8;
export const MAX_SEATS = 4;

export const NAV = Object.freeze({
  up: 1, down: 2, left: 4, right: 8, ok: 16, back: 32, recenter: 64, pause: 128,
});

/** Buttons that act on menus (held state is passed through as a pad). */
export const MENU_NAV_MASK = NAV.up | NAV.down | NAV.left | NAV.right | NAV.ok | NAV.back | NAV.pause;

/** How the game reads the phone's buttons: as a menu pad, or riding. */
export const PAD_MODES = Object.freeze(['menu', 'ride']);

/** Short sounds/buzzes the game asks the phone for. */
export const PAD_CUES = Object.freeze(['countdown', 'go', 'crash', 'finish']);

/**
 * @typedef {object} PadFrame
 * @property {number} seq
 * @property {number|null} tilt  degrees, or null when the phone has no tilt yet
 * @property {boolean} left
 * @property {boolean} right
 * @property {number} tapsL
 * @property {number} tapsR
 * @property {number} nav
 */

/** @param {PadFrame} f @returns {Uint8Array} */
export function encodeFrame(f) {
  const buf = new Uint8Array(FRAME_BYTES);
  const dv = new DataView(buf.buffer);
  buf[0] = PAD_INPUT;
  buf[1] = f.seq & 0xff;
  const valid = typeof f.tilt === 'number' && Number.isFinite(f.tilt);
  const t = valid ? Math.max(-32767, Math.min(32767, Math.round(/** @type {number} */ (f.tilt) * 100))) : 0;
  dv.setInt16(2, t, true);
  buf[4] = (f.left ? 1 : 0) | (f.right ? 2 : 0) | (valid ? 4 : 0);
  buf[5] = f.tapsL & 0xff;
  buf[6] = f.tapsR & 0xff;
  buf[7] = f.nav & 0xff;
  return buf;
}

/** @param {Uint8Array} buf @param {number} [offset] @returns {PadFrame|null} */
export function decodeFrame(buf, offset = 0) {
  if (!buf || buf.length < offset + FRAME_BYTES || buf[offset] !== PAD_INPUT) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset + offset, FRAME_BYTES);
  const flags = buf[offset + 4];
  return {
    seq: buf[offset + 1],
    tilt: flags & 4 ? dv.getInt16(2, true) / 100 : null,
    left: !!(flags & 1),
    right: !!(flags & 2),
    tapsL: buf[offset + 5],
    tapsR: buf[offset + 6],
    nav: buf[offset + 7],
  };
}

/** Presses between two wrapping u8 counters. */
export function counterDelta(prev, next) {
  return (next - prev + 256) & 0xff;
}

/** Is `seq` newer than `last` (u8, wrapping)? Equal or up to 127 behind = stale. */
export function isNewerSeq(last, seq) {
  const d = (seq - last + 256) & 0xff;
  return d !== 0 && d < 128;
}

// Pad codes: no 0/O/1/I/L, so they survive being read aloud or typed.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** @param {number} [len] @returns {string} */
export function makePadCode(len = 6) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let s = '';
  for (const b of bytes) s += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return s;
}

/** A 128-bit secret as hex. It rides in the link's #fragment, never a query. */
export function makePadSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** SHA-256 hex of a string (WebCrypto: browser, Node 18+, Workers). */
export async function sha256hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function isValidPadCode(code) {
  return typeof code === 'string' && /^[A-Z2-9]{4,10}$/.test(code);
}

/** 'host' | 'pad-1'..'pad-4' | null */
export function parsePadRole(role) {
  if (role === 'host') return 'host';
  const m = /^pad-([1-9])$/.exec(role || '');
  if (m && Number(m[1]) <= MAX_SEATS) return role;
  return null;
}

export function seatOfRole(role) {
  const m = /^pad-(\d)$/.exec(role || '');
  return m ? Number(m[1]) : 0;
}

/**
 * The link a phone opens. `base` is the game's folder URL (ending in "/").
 * `relay` is only set for local testing (a non-default relay URL).
 * @param {string} base @param {string} code @param {number} seat @param {string} secret
 * @param {{relay?: string|null}} [opts]
 */
export function buildPadLink(base, code, seat, secret, { relay = null } = {}) {
  const url = new URL('remote/', base);
  url.searchParams.set('pad', code);
  url.searchParams.set('seat', String(seat));
  if (relay) url.searchParams.set('relay', relay);
  url.hash = 'k=' + secret;
  return url.toString();
}

/**
 * Read a pad link on the phone.
 * @param {string} href
 * @returns {{code: string, seat: number, secret: string|null, relay: string|null}|null}
 */
export function parsePadLink(href) {
  const url = new URL(href);
  const code = (url.searchParams.get('pad') || '').toUpperCase();
  const seat = Number(url.searchParams.get('seat') || '1');
  if (!isValidPadCode(code) || !(seat >= 1 && seat <= MAX_SEATS)) return null;
  const m = /(?:^#|&)k=([0-9a-f]{32})/.exec(url.hash);
  return { code, seat, secret: m ? m[1] : null, relay: url.searchParams.get('relay') };
}

/** Only localhost pages may point at a non-default relay (local smoke tests). */
export function relayOverrideAllowed(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1';
}

/** The phone-pad relay Worker (worker/pad-relay.js, deployed separately). */
export const DEFAULT_PAD_RELAY = 'wss://tandemonium-pad.pete-872.workers.dev';

/** WebSocket URL for one role in one pad room. */
export function padSocketUrl(relay, code, role, secret = null) {
  const url = new URL('/pad', relay);
  url.searchParams.set('code', code);
  url.searchParams.set('role', role);
  if (secret) url.searchParams.set('k', secret);
  return url.toString();
}
