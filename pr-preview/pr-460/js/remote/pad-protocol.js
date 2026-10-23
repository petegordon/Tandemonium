// @ts-check
// ============================================================
// pad-protocol — phone remote (#421) wire format + pairing helpers
// ============================================================
//
// The phone sends one 8-byte binary INPUT frame per tick:
//
//   [0] u8  type << 4 | layout version. PAD_INPUT (0x50) = input, layout 0
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
//
// Versions (#454). PAD_PROTOCOL 1 is the first release, which never says
// hello. From 2 on, the phone sends {type:'hello', v} each time the game is
// there, and a game that knows hello answers {type:'hello', v}. Each side
// uses the lower of the two versions, and a side that never says hello is
// version 1. So old Steam builds pair with the newest phone page, and the
// newest game pairs with an older cached phone page: both just fall back to
// version 1 behaviour. The frame layout is the same in both (layout 0 in
// byte 0). A future layout gets a new low nibble, and a phone sends it only
// to a game whose hello says it reads it; a game skips layouts it doesn't know.
// ============================================================

export const PAD_INPUT = 0x50;
export const FRAME_BYTES = 8;
/** This build's protocol version (hello). 1 = no hello (the first release). */
export const PAD_PROTOCOL = 2;
/** The newest input-frame layout this build reads (byte 0's low nibble). */
export const FRAME_LAYOUT = 0;

/** The version the other side speaks: its hello's v, or 1 if it never said hello. */
export function peerVersion(hello) {
  const v = hello ? Number(hello.v) : NaN;
  return Number.isInteger(v) && v >= 1 ? v : 1;
}

/**
 * Menu-mode sending (#454). A phone whose game said hello (v2+) and is in
 * menus sends on a change plus this heartbeat, instead of 30 Hz. The
 * heartbeat is well under the game's 2 s "phone gone" rule. While anything is
 * held the phone still sends at the full rate, so the game's 400 ms "let go
 * of held buttons" rule never cuts a held press.
 */
export const MENU_HEARTBEAT_MS = 500;
/** After a change, keep the full rate this long, so the tilt settles. */
export const MENU_ACTIVE_TAIL_MS = 300;
/** A tilt move of at least this many degrees counts as a change in menus. */
export const MENU_TILT_STEP = 1;

/**
 * Should the phone send a frame now? Pure; exported for tests.
 * Full rate (every `sendMs`) unless `light` (menu mode with a v2+ game) and
 * idle: nothing held and nothing changed for MENU_ACTIVE_TAIL_MS. Idle sends
 * only the heartbeat. A change (`dirty`) always sends at once.
 * @param {{dirty: boolean, light: boolean, held: boolean, now: number,
 *   lastSend: number, lastChange: number, sendMs: number}} s
 */
export function shouldSendFrame({ dirty, light, held, now, lastSend, lastChange, sendMs }) {
  if (dirty) return true;
  const since = now - lastSend;
  if (!light || held || now - lastChange < MENU_ACTIVE_TAIL_MS) return since >= sendMs - 2;
  return since >= MENU_HEARTBEAT_MS;
}
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
  if (!buf || buf.length < offset + FRAME_BYTES) return null;
  // An input frame in a layout this build knows; a newer layout is skipped.
  const b0 = buf[offset];
  if ((b0 & 0xf0) !== (PAD_INPUT & 0xf0) || (b0 & 0x0f) > FRAME_LAYOUT) return null;
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

const isSecret = (s) => typeof s === 'string' && /^[0-9a-f]{32}$/.test(s);

/**
 * The secrets a phone page tries, newest first (#454). A stored key (given to
 * this tab by the game) goes before the link's QR secret, so re-opening the
 * QR in the same tab doesn't look like another phone taking over.
 * @param {string|null} linkSecret  from the #fragment, if the page was opened from the QR
 * @param {string|null} stored  this tab's newest secret
 * @param {string|null} prev    its fallback
 * @returns {string[]}
 */
export function padKeysOnBoot(linkSecret, stored, prev) {
  const list = linkSecret ? [stored, linkSecret] : [stored, prev];
  return [...new Set(list.filter(isSecret))];
}

/**
 * The game gave this phone key `k` while it was connected with `used`: try
 * `k` first, `used` if `k` is refused (the game never got our ack). Null for
 * a malformed key.
 * @param {string} used @param {unknown} k @returns {string[]|null}
 */
export function padKeysAfterRekey(used, k) {
  if (!isSecret(k)) return null;
  return k === used ? [k] : [/** @type {string} */ (k), used];
}

/** Only localhost pages may point at a non-default relay (local smoke tests). */
export function relayOverrideAllowed(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1';
}

/** The phone-pad relay Worker (worker/pad-relay.js, deployed separately). */
// #454 · Q5: the custom domain on the tandemonium-pad Worker. The old
// tandemonium-pad.pete-872.workers.dev address reaches the same Worker and rooms,
// so older builds that still dial it pair fine with newer ones.
export const DEFAULT_PAD_RELAY = 'wss://tandemonium-remote.housetandem.com';

/** WebSocket URL for one role in one pad room. */
export function padSocketUrl(relay, code, role, secret = null) {
  const url = new URL('/pad', relay);
  url.searchParams.set('code', code);
  url.searchParams.set('role', role);
  if (secret) url.searchParams.set('k', secret);
  return url.toString();
}
