// ============================================================
// TOURIST TILES SESSION — one paid Google session per run of the game
// ============================================================
//
// Google bills Photorealistic 3D Tiles per ROOT request: the first request a viewer makes, which
// returns the globe's root tileset and a session token good for about three hours. Every tile fetched
// with that token is covered by it, anywhere in the world.
//
// Each ride used to build a new TilesRenderer, and each one asked for the root again: one paid request
// per ride, per device (measured in the desktop build, 2026-11-17). This plugin keeps the root answer
// for the life of the page and hands it to the next ride's renderer, so the game makes one root request
// per run (or per 2.5 hours, whichever is sooner) however many places are ridden. That is how any 3D
// globe viewer uses a session: it flies anywhere on one root request.
//
// The library asks its plugins in order for `fetchData` and takes the first answer, so this one has
// to come before GoogleCloudAuthPlugin in its list. Its list is ordered by `priority`, lowest first,
// and (3d-tiles-renderer 0.3.46) a plugin registered among equals is put BEFORE the last of them, not
// after: so this plugin has a priority below the others' default of 0 and is registered last, which
// puts it at the front whatever the order of the rest. It answers only for the root; every tile
// request falls through to Google's plugin, which also refreshes the token itself if Google ever
// rejects it.
// Nothing is written to disk: the copy lasts as long as the page.

const ROOT_RE = /\/v1\/3dtiles\/root\.json(?:\?|$)/;

/** Reuse a root for this long. Google's session lasts about 3 hours; stop short of it. */
export const SESSION_REUSE_MS = 150 * 60 * 1000;

/** @type {{ text: string, at: number } | null} */
let _root = null;
let _rootRequests = 0;

/** How many root requests this page has made (for the smoke and for a debug readout). */
export function rootRequestCount() { return _rootRequests; }

/** Forget the kept root (tests; and when Google has rejected its token). */
export function forgetTilesSession() { _root = null; }

export class TilesSessionPlugin {
  /** @param {{ now?: () => number, fetchImpl?: typeof fetch }} [opts] */
  constructor({ now = () => Date.now(), fetchImpl = null } = {}) {
    this.name = 'TANDEM_TILES_SESSION_PLUGIN';
    this.priority = -100;
    this._now = now;
    this._fetch = fetchImpl || ((...a) => fetch(...a));
    /** Did this renderer start from the kept root (true) or ask Google for one (false)? */
    this.reused = null;
  }

  /**
   * The library's fetch hook. Root: the kept answer, or a real request whose answer is then kept.
   * Anything else: null, so the next plugin (Google's) handles it.
   */
  fetchData(uri, options) {
    if (!ROOT_RE.test(String(uri))) return null;
    const now = this._now();
    if (_root && now - _root.at < SESSION_REUSE_MS) {
      this.reused = true;
      return Promise.resolve(new Response(_root.text, { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }
    this.reused = false;
    _rootRequests++;
    return this._fetch(uri, options).then(async (res) => {
      if (!res.ok) return res;
      const text = await res.text();
      _root = { text, at: now };
      return new Response(text, { status: res.status, statusText: res.statusText, headers: { 'Content-Type': 'application/json' } });
    });
  }
}
