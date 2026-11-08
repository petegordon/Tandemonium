// @ts-check
// ============================================================
// SHARE RESULT — where the result card goes (#657 parts 2 + 3)
// ============================================================
// Part 1 (js/result-card.js) draws the card and the Steam build saves it as a
// Steam screenshot. This module is the rest:
//
//   2. TV / big screen → phone: the card is uploaded to the API Worker
//      (POST /share, held 7 days) and the share sheet shows a QR for
//      SITE_URL/share/?id=… — share/index.html, where the phone's own share
//      sheet takes over.
//   3. The House Tandem Discord: a signed-in player with Discord linked can
//      post a Daily Ride card to #daily-ride (POST /share/discord) — once from
//      the share sheet, or every Daily Ride finish with the Settings option on.
//
// Pure decisions (what the sheet shows) are exported for the unit test; the
// network helpers take their fetch, so the smoke and tests fake the Worker.
// No imports: share/index.html (the phone page) uses this file too.

/** The API Worker (same as API_BASE in js/config.js; the unit test holds them together). */
export const SHARE_API_BASE = 'https://tandemonium-api.pete-872.workers.dev';
/** The site the phone opens (SITE_URL in js/config.js). */
export const SHARE_SITE_URL = 'https://tandemonium.housetandem.com';
/** Settings: "Post my Daily Ride results to the House Tandem Discord" — off unless 'on'. */
export const DISCORD_AUTOPOST_KEY = 'tandemonium_share_discord';

/**
 * What SHARE RESULT does on this device.
 *  - sheet: open the share sheet (a TV, the Steam build, a browser with no
 *    clipboard, or whenever the Discord post is on offer);
 *  - qr: the sheet shows the QR to the phone page (not on a phone itself);
 *  - nativeShare: the device's own share sheet (a phone);
 *  - copy: copy the strip first (a desktop browser, as before #657);
 *  - discord: the sheet offers POST TO DISCORD.
 * @param {{ tv?: boolean, steam?: boolean, mobile?: boolean, clipboard?: boolean, discord?: boolean }} d
 */
export function shareSurface({ tv = false, steam = false, mobile = false, clipboard = true, discord = false } = {}) {
  const phone = mobile && !tv && !steam;
  const copy = !tv && !steam && !phone && clipboard;
  return {
    sheet: tv || steam || (!phone && !clipboard) || discord,
    qr: !phone,
    nativeShare: phone,
    copy,
    steam,
    discord,
  };
}

/**
 * May this player post this result to the House Tandem Discord?
 * The Daily Ride only, signed in with Discord linked, and the Worker set up.
 * @param {{ isDaily?: boolean, auth?: any, configured?: boolean }} d
 */
export function discordPostable({ isDaily = false, auth = null, configured = false } = {}) {
  if (!isDaily || !configured || !auth) return false;
  const signedIn = typeof auth.isLoggedIn === 'function' ? auth.isLoggedIn() : false;
  const hasDiscord = typeof auth.hasIdentity === 'function' ? auth.hasIdentity('discord') : false;
  return !!(signedIn && hasDiscord);
}

/** @param {Storage | null | undefined} store */
export function getDiscordAutoPost(store) {
  try { return !!store && store.getItem(DISCORD_AUTOPOST_KEY) === 'on'; } catch { return false; }
}
/** @param {Storage | null | undefined} store @param {boolean} on */
export function setDiscordAutoPost(store, on) {
  try { if (store) store.setItem(DISCORD_AUTOPOST_KEY, on ? 'on' : 'off'); } catch { /* private mode */ }
}

/** The phone page for a share id. */
export function sharePageUrl(id, site = SHARE_SITE_URL) {
  return site.replace(/\/$/, '') + '/share/?id=' + encodeURIComponent(id);
}

/**
 * The POST TO DISCORD button's words for a state.
 * @param {'idle'|'posting'|'posted'|'already'|'error'|'signin'} state
 */
export function discordButtonLabel(state) {
  switch (state) {
    case 'posting': return 'POSTING…';
    case 'posted': return 'POSTED TO #daily-ride ✓';
    case 'already': return 'ALREADY POSTED TODAY';
    case 'error': return "COULDN'T POST · TRY AGAIN";
    case 'signin': return 'SIGN IN WITH DISCORD TO POST';
    default: return 'POST TO DISCORD';
  }
}

/** Base64 of bytes, in chunks (no stack blow-up on a 300 KB card). */
export function bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, /** @type {any} */ (bytes.subarray(i, i + 0x8000)));
  return btoa(bin);
}

/**
 * The card as a JPEG for upload (a 1920×1080 PNG of gradients is ~2 MB; the
 * Worker holds at most 1 MB). Falls back to PNG if JPEG will not encode.
 * @param {HTMLCanvasElement} canvas
 * @returns {Promise<Blob>}
 */
export function cardUploadBlob(canvas, quality = 0.86) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => {
      if (b && b.size > 0) return resolve(b);
      canvas.toBlob((p) => (p ? resolve(p) : reject(new Error('toBlob failed'))), 'image/png');
    }, 'image/jpeg', quality);
  });
}

let _configPromise = null;
/**
 * GET /share/config, once per session: { discord } — whether the #daily-ride
 * post is set up. A failure reads as "not set up" (and is retried next time).
 */
export function fetchShareConfig({ apiBase = SHARE_API_BASE, fetchFn = globalThis.fetch } = {}) {
  if (!_configPromise) {
    _configPromise = fetchFn(apiBase + '/share/config')
      .then((r) => (r.ok ? r.json() : { discord: false }))
      .then((j) => ({ discord: !!(j && j.discord) }))
      .catch(() => { _configPromise = null; return { discord: false }; });
  }
  return _configPromise;
}
/** For tests: forget the cached config. */
export function _resetShareConfig() { _configPromise = null; }

/**
 * Upload the card (POST /share). Resolves { id, url, imageUrl, expiresAt }.
 * @param {{ blob: Blob, caption?: string, link?: string | null, dayKey?: string | null, deviceId?: string | null }} card
 */
export async function uploadCard({ blob, caption = '', link = null, dayKey = null, deviceId = null }, { apiBase = SHARE_API_BASE, fetchFn = globalThis.fetch } = {}) {
  const image = bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
  const res = await fetchFn(apiBase + '/share', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image, contentType: blob.type, caption, link, dayKey, deviceId }),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok || !out.id) {
    const err = /** @type {any} */ (new Error(out.error || 'upload failed (' + res.status + ')'));
    err.status = res.status;
    err.code = out.code || null;
    throw err;
  }
  return out;
}

/**
 * Post an uploaded card to #daily-ride (POST /share/discord).
 * Resolves { ok, state } where state is a discordButtonLabel() state.
 * @param {{ id: string, token: string }} p
 */
export async function postCardToDiscord({ id, token }, { apiBase = SHARE_API_BASE, fetchFn = globalThis.fetch } = {}) {
  let res;
  try {
    res = await fetchFn(apiBase + '/share/discord', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ id }),
    });
  } catch { return { ok: false, state: 'error', status: 0 }; }
  const out = await res.json().catch(() => ({}));
  if (res.ok) return { ok: true, state: 'posted', status: res.status };
  if (res.status === 409) return { ok: false, state: 'already', status: 409, code: out.code };
  if (res.status === 401 || res.status === 403) return { ok: false, state: 'signin', status: res.status, code: out.code };
  return { ok: false, state: 'error', status: res.status, code: out.code };
}
