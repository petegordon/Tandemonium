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

/** @type {{ onRoot?: (r: {ok: boolean, status: number}) => void, onReused?: () => void, onRefused?: (status: number) => void }} */
let _hooks = {};

/** #824 · who hears about paid sessions, reused ones and Google refusing us. */
export function setTilesSessionHooks(hooks) { _hooks = hooks || {}; }

const call = (fn, ...a) => { try { if (fn) fn(...a); } catch (e) { console.warn('[Tourist] session hook failed', e); } };

/** Is a kept root still good for the next ride (so that ride costs nothing)? */
export function hasLiveTilesSession(now = Date.now()) {
  return !!_root && now - _root.at < SESSION_REUSE_MS;
}

/** How many refused tile requests (403) in this window mean refused, not one expired token. */
const REFUSED_403S = 3;
const REFUSED_WINDOW_MS = 10000;

/**
 * #824 · a hit quota refuses the tiles themselves (429, or 403 again and again; a single 403 is an expired
 * token, which Google's plugin renews). The renderer has no error event for it, so the page's fetch is watched
 * while a tiles world is up. → stop watching
 */
export function watchTileRefusals(now = () => Date.now()) {
  const original = globalThis.fetch;
  if (typeof original !== 'function') return () => {};
  let recent = [];
  const watched = async (input, init) => {
    const res = await original.call(globalThis, input, init);
    const url = String(typeof input === 'string' ? input : input && input.url);
    if (url.includes('tile.googleapis.com') && !ROOT_RE.test(url) && (res.status === 403 || res.status === 429)) {
      const t = now();
      recent = recent.filter((x) => t - x < REFUSED_WINDOW_MS);
      recent.push(t);
      if (res.status === 429 || recent.length >= REFUSED_403S) call(_hooks.onRefused, res.status);
    }
    return res;
  };
  globalThis.fetch = watched;
  return () => { if (globalThis.fetch === watched) globalThis.fetch = original; };
}

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
      call(_hooks.onReused);
      return Promise.resolve(new Response(_root.text, { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }
    this.reused = false;
    _rootRequests++;
    return this._fetch(uri, options).then(async (res) => {
      // #824 · only an answered request is a paid session; a refusal uses nothing up
      call(_hooks.onRoot, { ok: res.ok, status: res.status });
      if (res.status === 403 || res.status === 429) call(_hooks.onRefused, res.status);
      if (!res.ok) return res;
      const text = await res.text();
      _root = { text, at: now };
      return new Response(text, { status: res.status, statusText: res.statusText, headers: { 'Content-Type': 'application/json' } });
    }, (err) => {
      call(_hooks.onRoot, { ok: false, status: 0 });
      throw err;
    });
  }
}
