// Ride Together room proofs, shared by the relay worker (relay.js) and the API (leaderboard.js).
//
// The relay knows who holds each seat of a room: a signed-in seat by its relay token (an
// account id), a guest seat by the device it dialled from. When both seats are there it
// signs a PAIR PROOF naming them and gives it to both riders. A score or Daily post may
// name a partner only with that proof, so a post can't put a ride, or a pair history, on
// someone who wasn't in the room.
//
// A guest is never named by their device id outside our servers: device ids open a guest's
// ride history when they sign in, so they work like a password. The proof and the partner
// see a GUEST KEY instead, an HMAC of the device id that only our servers can make.

const enc = new TextEncoder();

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function b64urlJson(obj) {
  return b64url(enc.encode(JSON.stringify(obj)));
}
function fromB64url(s) {
  return Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
}

async function hmacKey(secret, usage) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}

/** A guest's key for pair records: 'h_' + 22 characters. Same device → same key. */
export async function guestKey(secret, deviceId) {
  if (!secret || typeof deviceId !== 'string' || !deviceId) return null;
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret, 'sign'), enc.encode('tandemonium-guest:' + deviceId));
  return 'h_' + b64url(new Uint8Array(sig)).slice(0, 22);
}

/** Is this a guest key (as opposed to a raw device id)? */
export function isGuestKey(v) {
  return typeof v === 'string' && /^h_[A-Za-z0-9_-]{22}$/.test(v);
}

/** HS256 JWT. */
export async function signToken(payload, secret, ttlSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const data = b64urlJson({ alg: 'HS256', typ: 'JWT' }) + '.' + b64urlJson({ ...payload, iat: now, exp: now + ttlSeconds });
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret, 'sign'), enc.encode(data));
  return data + '.' + b64url(new Uint8Array(sig));
}

/**
 * Check an HS256 JWT's signature. Throws when it is malformed or forged; an expired one
 * throws too, unless `graceSeconds` covers it.
 */
export async function readToken(token, secret, graceSeconds = 0) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('Invalid token');
  const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret, 'verify'), fromB64url(parts[2]), enc.encode(parts[0] + '.' + parts[1]));
  if (!ok) throw new Error('Invalid signature');
  const payload = JSON.parse(new TextDecoder().decode(fromB64url(parts[1])));
  if (payload.exp && payload.exp + graceSeconds < Math.floor(Date.now() / 1000)) throw new Error('Token expired');
  return payload;
}

/** A relay seat stays its holder's this long after they leave (a dropped connection, a reload, an app restart). */
export const SEAT_HOLD_MS = 10 * 60 * 1000;

/** How long a pair proof lets the two riders post their ride. */
export const PAIR_PROOF_TTL_S = 6 * 3600;

/** A seat as a proof names it: { u: accountId, l?: loginId } or { g: guestKey }. */
function seatOf(s) {
  if (s && s.u != null && s.u !== '') return Number.isInteger(s.l) ? { u: String(s.u), l: s.l } : { u: String(s.u) };
  if (s && isGuestKey(s.g)) return { g: s.g };
  return null;
}

/** The relay: sign who holds each seat. */
export async function signPairProof(secret, room, captain, stoker) {
  return signToken({ typ: 'pair', room, captain: seatOf(captain), stoker: seatOf(stoker) }, secret, PAIR_PROOF_TTL_S);
}

/**
 * The API: from a posted proof, the partner of `userId` riding as `myRole`, or null.
 * → { role, userId, loginId? } (a signed-in partner, with the login in the seat when the
 *   relay knew it) or { role, guestKey } (a guest partner).
 */
export async function partnerFromProof(secret, proof, userId, myRole) {
  if (!secret || !proof || typeof proof !== 'string' || proof.length > 2000) return null;
  if (myRole !== 'captain' && myRole !== 'stoker') return null;
  let p;
  try { p = await readToken(proof, secret); } catch { return null; }
  if (!p || p.typ !== 'pair') return null;
  const me = seatOf(p[myRole]);
  if (!me || me.u !== String(userId)) return null;
  const role = myRole === 'captain' ? 'stoker' : 'captain';
  const other = seatOf(p[role]);
  if (!other) return null;
  if (other.u) return other.u === String(userId) ? null : { role, userId: other.u, loginId: other.l ?? null };
  return { role, guestKey: other.g };
}
