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
//   GET /pr-preview/pr-7/assets/music.mp3      the preview's own copy, if any
//     └ 404 → GET /assets/music.mp3            otherwise the live game's
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

// "/pr-preview/pr-7/": taken from where this worker was registered, so the
// same file works for every preview.
const SCOPE_PATH = new URL(self.registration.scope).pathname;

// Take over at once. Without these a new worker waits until every tab of the
// preview has closed, and a first visit stays uncontrolled until the next
// navigation; the page (see the script stage-preview.mjs puts in <head>)
// reloads itself once as soon as a worker is active.
self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()); });

/** The path inside the preview ("assets/a b.mp3") if this request is ours to handle, else null. */
function heavyPath(request) {
  if (request.method !== 'GET') return null;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return null;
  if (!url.pathname.startsWith(SCOPE_PATH)) return null;
  const rel = url.pathname.slice(SCOPE_PATH.length);
  return HEAVY_DIRS.some((dir) => rel.startsWith(dir + '/')) ? rel : null;
}

async function previewThenLive(request, rel) {
  // The preview's own copy first: a file the pull request changed must win.
  const own = await fetch(request);
  // Only "not there" falls through. A server error or anything else goes back
  // as it is, so a real problem is not hidden behind the live game's file.
  if (own.status !== 404) return own;

  const live = new URL(request.url);
  live.pathname = '/' + rel;   // rel is still percent-encoded, as it arrived
  // A new request for the live path that keeps the original's headers (Range
  // above all). 'same-origin' because it is our own origin by construction and
  // because the original's mode can be 'navigate', which a script may not use.
  return fetch(new Request(live.href, {
    method: 'GET',
    headers: request.headers,
    mode: 'same-origin',
    credentials: request.credentials,
    cache: request.cache === 'only-if-cached' ? 'default' : request.cache,
    redirect: 'follow',
    referrer: request.referrer,
    signal: request.signal,
  }));
}

self.addEventListener('fetch', (event) => {
  const rel = heavyPath(event.request);
  // Not calling respondWith() hands the request back to the browser untouched.
  if (rel === null) return;
  event.respondWith(previewThenLive(event.request, rel));
});
