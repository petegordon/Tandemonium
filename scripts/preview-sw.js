// ============================================================
// PREVIEW SERVICE WORKER — unchanged heavy files come from the live game
// ============================================================
//
// Only a pull-request preview has this file. scripts/stage-preview.mjs copies
// it to the preview's root (/pr-preview/pr-<N>/preview-sw.js), so its scope is
// that one preview. It is never part of the live site or the desktop build.
//
// Why: a preview used to be a full ~340 MB copy of the game, and GitHub Pages
// allows 1 GB per site, so the live game plus two open previews broke
// publishing (#760). A preview now leaves out every file in the heavy folders
// that the pull request did not add or change. Previews are served from the
// same address as the live game, so this worker fetches a left-out file from
// the live game instead:
//
//   GET /pr-preview/pr-7/assets/music.mp3
//     the preview published it (the PR changed it) → the preview's own copy;
//                                                    only if that is a 404,
//                                                    the live game's
//     the preview left it out                      → GET /assets/music.mp3
//
// The worker knows which is which from the list stage-preview.mjs writes into
// it (OWN_FILES). It does not find out by asking the preview and waiting for a
// 404: GitHub Pages does not always give one. For some minutes on 18 Nov 2026
// this site answered "503" instead of "404" for about four in ten requests for
// a file that is not there, and a 503 cannot be told from a real outage.
// Knowing also saves a wasted request for every shared file.
//
// Rules it keeps:
//   - Only GETs for a heavy folder inside THIS preview are handled. Everything
//     else (the game's code, other previews, the live game, other sites) is
//     left to the browser exactly as if no worker existed.
//   - It stores nothing: no Cache API, no memory of earlier answers. A stale
//     preview is worse than a slow one (see js/build-badge.js), so every
//     request asks the network (the browser's ordinary HTTP cache still
//     applies, as it does without a worker).
//   - A Range request (video and audio seek with these) is passed on with its
//     Range header, to the preview and to the live game alike, and the 206
//     answer goes back untouched.

// The folders a preview leaves unchanged files out of, relative to the preview
// root. stage-preview.mjs owns the list and rewrites the next line when it
// copies this file, so the worker and the staging can never disagree.
const HEAVY_DIRS = ['tandem-3d', 'assets', 'images', 'goose-stage/reels']; // %%HEAVY_DIRS%%

// The files in those folders that this preview did publish: the ones the pull
// request added or changed, plus any pages (.html). Also rewritten at staging.
// Each new build of a preview therefore has a different worker file, which is
// what makes the browser replace the old worker with the new one.
const OWN_FILES = new Set([]); // %%OWN_FILES%%

// "/pr-preview/pr-7/": taken from where this worker was registered, so the
// same file works for every preview.
const SCOPE_PATH = new URL(self.registration.scope).pathname;

// Take over at once. Without these a new worker waits until every tab of the
// preview has closed, and a first visit stays uncontrolled until the next
// navigation. The page (see the script stage-preview.mjs puts in <head>)
// reloads itself once when a worker first takes charge or a newer one does.
self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()); });

/**
 * The path inside the preview, still percent-encoded as it arrived
 * ("assets/a%20b.mp3"), if this request is ours to handle. Otherwise null.
 */
function heavyPath(request) {
  if (request.method !== 'GET') return null;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return null;
  if (!url.pathname.startsWith(SCOPE_PATH)) return null;
  const rel = url.pathname.slice(SCOPE_PATH.length);
  return HEAVY_DIRS.some((dir) => rel.startsWith(dir + '/')) ? rel : null;
}

/** Did the preview publish this path? ("tandem-3d/" means its index.html, as on the server.) */
function isOwn(rel) {
  let file;
  try { file = decodeURIComponent(rel); } catch { return false; }
  return OWN_FILES.has(file.endsWith('/') ? file + 'index.html' : file);
}

/** The same request, for the same path in the live game at the site root. */
function liveRequest(request, rel) {
  const live = new URL(request.url);
  live.pathname = '/' + rel;
  // The original's headers go along (Range above all). 'same-origin' because
  // it is our own origin by construction and because the original's mode can
  // be 'navigate', which a script may not use.
  return new Request(live.href, {
    method: 'GET',
    headers: request.headers,
    mode: 'same-origin',
    credentials: request.credentials,
    cache: request.cache === 'only-if-cached' ? 'default' : request.cache,
    redirect: 'follow',
    referrer: request.referrer,
    signal: request.signal,
  });
}

async function previewThenLive(request, rel) {
  // The preview's own copy: a file the pull request changed must win.
  const own = await fetch(request);
  // 404 here means this worker is older than the preview (a newer build no
  // longer changes the file). Anything else, a server error included, goes
  // back as it is: the live game's copy would be the wrong bytes.
  if (own.status !== 404) return own;
  return fetch(liveRequest(request, rel));
}

self.addEventListener('fetch', (event) => {
  const rel = heavyPath(event.request);
  // Not calling respondWith() hands the request back to the browser untouched.
  if (rel === null) return;
  event.respondWith(isOwn(rel) ? previewThenLive(event.request, rel) : fetch(liveRequest(event.request, rel)));
});
