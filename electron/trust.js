// What is ours, for the desktop build (electron/main.js).
//
// The game runs from tandemonium://app and talks to House Tandem's own servers. Anything
// else that ends up in a window or a frame (a credits link, the Steam store widget) is a
// web page like any other: it gets no device permissions and none of the game's bridge.
// Pure functions, so the unit tests can load them without Electron.

const GAME_ORIGIN = 'tandemonium://app';

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch (e) { return ''; }
}

/** House Tandem's own servers: housetandem.com and its subdomains, and our workers.dev account. */
function isOurHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  return h === 'housetandem.com' || h.endsWith('.housetandem.com') || h.endsWith('.pete-872.workers.dev');
}

/**
 * The API servers the game calls: they get the game's web Origin, and their answers are
 * opened to the game's page. Matched on the host name, never on a word in the address.
 */
function isApiUrl(url) {
  const h = hostOf(url);
  return h.endsWith('.pete-872.workers.dev') || h === 'api.housetandem.com' || h === 'tandemonium.jimandi.love';
}

/** Google's map servers (Tourist Mode): they get the Referer the Maps key is restricted to. */
function isTilesUrl(url) {
  return /^(?:tile|maps)\.googleapis\.com$/.test(hostOf(url));
}

/** Is this address the game's own page? */
function isGameUrl(url) {
  return typeof url === 'string' && (url === GAME_ORIGIN || url.startsWith(GAME_ORIGIN + '/'));
}

/** A web page's origin (http or https). The game's own page is not one. */
function isWebOrigin(origin) {
  return /^https?:/i.test(String(origin || ''));
}

/** May a link open in a new window? Only a web address. */
function isWebLink(url) {
  try { return /^https?:$/.test(new URL(url).protocol); } catch (e) { return false; }
}

/** A sign-in page the game may hand to the system browser: https, our host, under /auth/. */
function isSignInUrl(url) {
  try {
    const u = new URL(String(url));
    return u.protocol === 'https:' && isOurHost(u.hostname) && u.pathname.startsWith('/auth/');
  } catch (e) { return false; }
}

/**
 * The file under rootDir that a tandemonium://app path names, or null when the path is not
 * one of the app's own files. The path is decoded once; anything still encoded after that,
 * a drive, a backslash or a control character is refused, so no later decoding can change
 * which file is meant.
 */
function appFilePath(rootDir, pathname) {
  const path = require('path');
  let p;
  try { p = decodeURIComponent(String(pathname || '/')); } catch { return null; }
  if (p === '' || p === '/') p = '/index.html';
  if (!p.startsWith('/') || /[%\\:\u0000-\u001f]/.test(p)) return null;
  const root = path.resolve(rootDir);
  const full = path.resolve(root, '.' + p);
  const rel = path.relative(root, full);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return full;
}

module.exports = { appFilePath, GAME_ORIGIN, hostOf, isOurHost, isApiUrl, isTilesUrl, isGameUrl, isWebOrigin, isWebLink, isSignInUrl };
