// Carries a player's saved data from the old address (tandemonium.jimandi.love) to the new one
// (tandemonium.housetandem.com). Browsers keep each site's localStorage separately, so without
// this a player who follows an old link would arrive with no progress, settings or achievements.
//
// The old address is a redirect page (repo petegordon/tandemonium-jimandi-redirect, which keeps
// a copy of this file). It reads that origin's localStorage, packs it into the URL fragment
// (never sent to a server) and opens /migrate/ here, which fills in any keys this browser doesn't
// already have and then continues to the page the player asked for.

export const OLD_ORIGIN = 'https://tandemonium.jimandi.love';
export const NEW_ORIGIN = 'https://tandemonium.housetandem.com';
// Browsers accept fragments far longer than this, but stay well inside every one of them.
export const MAX_ENCODED = 1_500_000;

/** Only the game's own keys travel. */
export function isGameKey(key) {
  return /^(tandemonium|tndm)/.test(key);
}

/** A same-site path to continue to; anything else falls back to the home page. */
export function safeTarget(to) {
  return typeof to === 'string' && to.startsWith('/') && !to.startsWith('//') && !to.startsWith('/\\') ? to : '/';
}

/**
 * The full URL to continue to on `origin`. It checks the resolved URL, not the string,
 * because browsers drop tabs/newlines and treat "\" as "/" while parsing.
 */
export function resolveTarget(to, origin) {
  try {
    const u = new URL(safeTarget(to), origin);
    if (u.origin === origin) return u.toString();
  } catch { /* fall through */ }
  return origin + '/';
}

function toB64url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function pipe(bytes, stream) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}

/** { to, ls } → a URL-safe string. Gzipped when the browser can. */
export async function encodePayload(data) {
  const json = new TextEncoder().encode(JSON.stringify(data));
  if (typeof CompressionStream === 'function') return 'z' + toB64url(await pipe(json, new CompressionStream('gzip')));
  return 'j' + toB64url(json);
}

export async function decodePayload(s) {
  const kind = s[0];
  let bytes = fromB64url(s.slice(1));
  if (kind === 'z') bytes = await pipe(bytes, new DecompressionStream('gzip'));
  else if (kind !== 'j') throw new Error('unknown payload');
  return JSON.parse(new TextDecoder().decode(bytes));
}

/** Copies the game's keys out of a Storage-like object. */
export function readGameKeys(storage) {
  const ls = {};
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k && isGameKey(k)) ls[k] = storage.getItem(k);
  }
  return ls;
}

/**
 * The /migrate/ URL carrying `ls`, or null when there is nothing to carry.
 * If the data is too big for a URL, the largest values are left behind first.
 */
export async function buildMigrateUrl(ls, to, newOrigin = NEW_ORIGIN) {
  const entries = { ...ls };
  if (!Object.keys(entries).length) return null;
  for (;;) {
    const encoded = await encodePayload({ v: 1, to: safeTarget(to), ls: entries });
    if (encoded.length <= MAX_ENCODED) return `${newOrigin}/migrate/#d=${encoded}`;
    const keys = Object.keys(entries);
    if (keys.length <= 1) return null;
    const biggest = keys.reduce((a, b) => (String(entries[a]).length >= String(entries[b]).length ? a : b));
    delete entries[biggest];
  }
}

/** Fills in keys this browser doesn't have yet. Data already saved here always wins. */
export function applyEntries(storage, ls) {
  let added = 0;
  for (const [k, v] of Object.entries(ls || {})) {
    if (!isGameKey(k) || typeof v !== 'string') continue;
    if (storage.getItem(k) === null) {
      storage.setItem(k, v);
      added++;
    }
  }
  return added;
}

/**
 * Only accept data handed over by the old address itself. A link crafted elsewhere would
 * otherwise be able to plant values in a player's storage.
 */
export function cameFromOldSite(referrer) {
  try { return new URL(referrer).origin === OLD_ORIGIN; } catch { return false; }
}
