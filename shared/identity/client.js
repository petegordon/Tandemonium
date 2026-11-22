// @ts-check
// ============================================================
// IdentityClient — a House Tandem session, in any game or site
// ============================================================
//
// One account, several logins (Discord, Steam, Google). This is the client half
// of the account system every House Tandem game shares (the server half lives in
// Tandemonium's API, worker/accounts/). It has no DOM and no game in it: a game
// gives it an API address and somewhere to keep the session, and gets
//
//   - the session (who is signed in, through which login, with which logins linked)
//   - sign-in: a redirect (a browser on the same device), or a device code (a TV or a
//     desktop build shows a QR and a 4-letter code; the player signs in on their phone
//     and types the code)
//   - linking another login, which the server lets only the starting tab or device
//     finish, and which needs a sign-in from the last few minutes
//   - the combine question (the login already has its own account): both accounts,
//     yes or no
//   - notices of what was linked or combined lately, with undo
//
// A session is a LOGIN: its account is whatever account that login belongs to now.
// So after a combine or a separate the same token keeps working, for the account the
// login is on; `refresh()` re-reads it.
//
// 0.5 · a sign-in result belongs to the browser that began it. begin() keeps a random
// value in this tab and sends the server only its hash; the provider's callback comes
// back with a short single-use code, and the page swaps code + value for the session
// over POST. A session already here is never replaced by a different account without
// the player saying so (`confirmSwitch`).

const POLL_MS = 2000;
const LINK_PENDING_TTL_MS = 15 * 60 * 1000;
const SIGNIN_PENDING_KEY = 'ht_signin_pending';
const SIGNIN_PENDING_TTL_MS = 15 * 60 * 1000;
const SIGNIN_PENDING_MAX = 6;
const OTHER_BROWSER = 'This sign-in was started in another browser or tab. Start it again here.';

const b64url = (/** @type {Uint8Array} */ bytes) => btoa(String.fromCharCode(...bytes)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

/** A random value and its SHA-256, or null where the browser has no crypto (not https). */
async function newSignInNonce() {
  const c = globalThis.crypto;
  if (!c || !c.subtle || !c.getRandomValues) return null;
  const nonce = b64url(c.getRandomValues(new Uint8Array(32)));
  const hash = b64url(new Uint8Array(await c.subtle.digest('SHA-256', new TextEncoder().encode(nonce))));
  return { nonce, hash };
}

/** The browser's own yes/no. No dialog available: the answer is no. */
function askInBrowser({ from, to }) {
  const ask = /** @type {any} */ (globalThis).confirm;
  if (typeof ask !== 'function') return false;
  const next = to && to.name ? `"${to.name}"` : 'another account';
  return !!ask(from && from.name
    ? `You are signed in as "${from.name}". Switch this browser to ${next}?`
    : `Sign in here as ${next}? Only continue if you started this sign-in yourself.`);
}

/**
 * @typedef {{ name?: string, avatar?: string|null }} LoginInfo
 * @typedef {{ id: number|string, name: string, avatar: string|null, identities: Record<string, LoginInfo>, provider?: string } & Record<string, any>} IdentityUser
 * @typedef {{ id: number, kind: 'link'|'combine', provider: string, login_name: string|null, from_name: string|null, created_at: number, undo_until: number, seen: boolean }} AccountNotice
 * @typedef {{ name: string, avatar: string|null, logins: { provider: string, name?: string, avatar?: string|null }[], rides: number, badges: number, games?: { game: string, title: string, badges: number }[] }} AccountSummary
 * @typedef {{ getItem(k: string): string|null, setItem(k: string, v: string): void, removeItem(k: string): void }} KeyValue
 *
 * @typedef {Object} IdentityOptions
 * @property {string} apiBase                        e.g. 'https://api.housetandem.com'
 * @property {KeyValue} [storage]                    where the session is kept (default localStorage)
 * @property {KeyValue} [tabStorage]                 this tab only: a link in progress (default sessionStorage)
 * @property {{ user: string, token: string }} [keys] storage keys (each site keeps its own session)
 * @property {typeof fetch} [fetch]
 * @property {() => (string|undefined)} [deviceId]   this device's id: a guest's rides on it join the account at sign-in
 * @property {() => (string|undefined)} [sessionId]  this launch's analytics session
 * @property {() => Promise<boolean>} [reauth]       get a fresh sign-in for the same player without asking them
 *                                                   (the Steam build: sign in again by ticket). True = done.
 * @property {(user: any, extra: Record<string, any>, prev: IdentityUser|null) => IdentityUser} [shapeUser]
 *                                                   how a server user becomes this game's stored user
 * @property {Location} [location]
 * @property {History} [history]
 * @property {() => number} [now]
 * @property {boolean} [forgetOn401]                  refresh(): any 401 ends the session (default: only `account_gone` does; meStatus says 401)
 * @property {(q: { from: { name?: string }|null, to: { name?: string } }) => boolean|Promise<boolean>} [confirmSwitch]
 *                                                   ask before a sign-in replaces a different account (default: the browser's confirm)
 */

/** The JWT's claims, unverified (the server verifies; this is for expiry and display). */
export function decodeToken(token) {
  try {
    const part = String(token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = typeof atob === 'function' ? atob(part) : /** @type {any} */ (globalThis).Buffer.from(part, 'base64').toString('binary');
    return JSON.parse(decodeURIComponent(Array.from(json, (c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join('')));
  } catch { return null; }
}

/**
 * Pull what a sign-in redirect brought back out of the URL fragment, and clean the URL:
 *   #ht_result=<id>.<code>      a sign-in to swap for a session (with this tab's value)
 *   #ht_link=<id>.<code>        a link to finish (completeLink)
 *   #ht_auth=<token>            a sign-in from an older server or tab
 *   &ht_server=joined|…         older servers: the Discord server join's result
 *   &ht_steam=has_account       older servers: Discord's verified Steam has its own account
 * @returns {{ token?: string, result?: { id: string, code: string }, link?: { id: string, code: string }, server?: string, steam?: string }|null}
 */
export function takeRedirect(loc = globalThis.location, hist = globalThis.history) {
  if (!loc || !loc.hash || !/ht_(auth|link|result)=/.test(loc.hash)) return null;
  const params = new URLSearchParams(loc.hash.slice(1));
  /** @type {{ token?: string, result?: { id: string, code: string }, link?: { id: string, code: string }, server?: string, steam?: string }} */
  const out = {};
  const token = params.get('ht_auth');
  if (token) out.token = token;
  const pair = (/** @type {string|null} */ v) => {
    if (!v || !v.includes('.')) return undefined;
    const i = v.indexOf('.');
    return { id: v.slice(0, i), code: v.slice(i + 1) };
  };
  const result = pair(params.get('ht_result'));
  if (result) out.result = result;
  const link = pair(params.get('ht_link'));
  if (link) out.link = link;
  const server = params.get('ht_server');
  if (server) out.server = server;
  const steam = params.get('ht_steam');
  if (steam) out.steam = steam;
  for (const k of ['ht_auth', 'ht_result', 'ht_link', 'ht_server', 'ht_steam']) params.delete(k);
  const rest = params.toString();
  try { hist.replaceState(null, '', loc.pathname + loc.search + (rest ? '#' + rest : '')); } catch (e) { /* no history here */ }
  return out.token || out.result || out.link ? out : null;
}

/** The logins to picture, left to right: Discord, then Steam, then anything else. */
export function loginPictures(user) {
  if (!user) return [];
  const ids = user.identities || {};
  const out = [];
  for (const p of ['discord', 'steam']) {
    if (ids[p] && ids[p].avatar) out.push({ provider: p, avatar: ids[p].avatar, name: ids[p].name });
  }
  if (!out.length && user.avatar) out.push({ provider: user.provider || 'account', avatar: user.avatar, name: user.name });
  return out;
}

const memory = () => {
  const m = new Map();
  return /** @type {KeyValue} */ ({ getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } });
};
const safe = (/** @type {() => KeyValue|undefined} */ get) => { try { return get() || memory(); } catch { return memory(); } };

const AFTER_KEY = 'ht_after_signin';
const AFTER_TTL_MS = 15 * 60 * 1000;

export class IdentityClient {
  /** @param {IdentityOptions} opts */
  constructor(opts) {
    if (!opts || !opts.apiBase) throw new Error('IdentityClient needs apiBase');
    this.apiBase = String(opts.apiBase).replace(/\/+$/, '');
    this._storage = opts.storage || safe(() => globalThis.localStorage);
    this._tab = opts.tabStorage || safe(() => globalThis.sessionStorage);
    this._keys = opts.keys || { user: 'ht_auth_user', token: 'ht_auth_token' };
    this._fetch = opts.fetch || ((...a) => globalThis.fetch(...a));
    this._deviceId = opts.deviceId || (() => undefined);
    this._sessionId = opts.sessionId || (() => undefined);
    this._reauth = opts.reauth || null;
    this._shape = opts.shapeUser || defaultShape;
    this._loc = opts.location;
    this._hist = opts.history;
    this._now = opts.now || (() => Date.now());
    this._forgetOn401 = !!opts.forgetOn401;
    this._confirmSwitch = opts.confirmSwitch || askInBrowser;
    /** @type {IdentityUser|null} */ this.user = null;
    /** @type {string|null} */ this.token = null;
    /** @type {string|null} */ this.lastError = null;
    /** The last refresh()'s HTTP status (0: offline). 401 without `account_gone` is a token the server no longer takes. */ this.meStatus = 0;
    /** The last /me answer (the user, and what the API adds: achievements, best scores), or null. @type {any} */ this.me = null;
    this._listeners = new Set();
    this._device = null;
    this._load();
  }

  // ── the session ──

  _load() {
    try {
      const raw = this._storage.getItem(this._keys.user);
      this.user = raw ? JSON.parse(raw) : null;
      this.token = this._storage.getItem(this._keys.token) || null;
    } catch (e) { this.user = null; this.token = null; }
    // A site that used to store the token alone (no profile): the token's own claims name the
    // player until refresh() reads the account. Nothing is written until then.
    if (this.token && !this.user) {
      const c = decodeToken(this.token);
      if (c && c.sub != null) {
        const provider = typeof c.via === 'string' ? c.via.split(':')[0] : undefined;
        this.user = this._shape({ id: c.sub, name: typeof c.name === 'string' ? c.name : undefined, avatar: typeof c.picture === 'string' ? c.picture : null }, provider ? { provider } : {}, null);
      }
    }
  }

  _save() {
    try {
      if (this.user) this._storage.setItem(this._keys.user, JSON.stringify(this.user)); else this._storage.removeItem(this._keys.user);
      if (this.token) this._storage.setItem(this._keys.token, this.token); else this._storage.removeItem(this._keys.token);
    } catch (e) { /* storage full or blocked: the session lasts this page */ }
  }

  isSignedIn() { return !!(this.user && this.token); }

  /** The session's claims: `sub` the account, `lid` the login it is, `exp`. Unverified. */
  claims() { return this.token ? decodeToken(this.token) : null; }

  /** Has the token expired (or will it within `marginSec`)? */
  tokenExpired(marginSec = 60) {
    const c = this.claims();
    return !c || !c.exp || c.exp < Math.floor(this._now() / 1000) + marginSec;
  }

  /** Is this provider's login on the account? */
  hasLogin(provider) { return !!(this.user && this.user.identities && this.user.identities[provider]); }

  /** Called with (user|null, reason) whenever the session changes. → unsubscribe */
  onChange(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }

  _emit(reason) { for (const fn of [...this._listeners]) { try { fn(this.user, reason); } catch (e) { console.error(e); } } }

  /**
   * Take a server answer ({ token, user }) as the signed-in state. `extra.keep`: this is
   * the same player (a link, a fresh sign-in), so what the game stored about them stays.
   * @param {string} token @param {any} serverUser @param {Record<string, any>} [extra] @param {string} [reason]
   */
  apply(token, serverUser, extra = {}, reason = 'signin') {
    const { keep, ...rest } = extra;
    this.token = token;
    this.user = this._shape(serverUser, rest, keep ? this.user : null);
    this.lastError = null;
    this._save();
    this._emit(reason);
    return this.user;
  }

  /** Forget the token only (the profile stays, for signing in again as the same player). */
  clearToken() {
    this.token = null;
    try { this._storage.removeItem(this._keys.token); } catch (e) { /* blocked */ }
  }

  signOut() {
    this.cancelDevice();
    this.user = null;
    this.token = null;
    this.me = null;
    this._save();
    this._emit('signout');
  }

  // ── talking to the API ──

  /**
   * @param {string} path
   * @param {{ method?: string, body?: any, auth?: boolean }} [o]
   * @returns {Promise<{ ok: boolean, status: number, data: any }>}
   */
  async api(path, { method = 'GET', body, auth = true } = {}) {
    /** @type {Record<string, string>} */ const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (auth && this.token) headers.Authorization = 'Bearer ' + this.token;
    const res = await this._fetch(this.apiBase + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    return { ok: res.ok, status: res.status, data: data || {} };
  }

  /** Re-read the account (name, picture, linked logins) from the server. → the user, or null */
  async refresh() {
    if (!this.token) return null;
    const r = await this.api('/me').catch(() => null);
    this.meStatus = r ? r.status : 0;
    if (!r) return null;
    if (r.status === 401 && r.data.code === 'account_gone') { this.clearToken(); this._emit('gone'); return null; }
    // `forgetOn401`: a token the server no longer takes (signed out elsewhere, a login undone)
    // ends the session here too. Without the option the session is kept and meStatus says 401.
    if (r.status === 401 && this._forgetOn401) { this.signOut(); return null; }
    if (!r.ok || !r.data.user || !this.user) return null;
    this.me = r.data;
    const u = r.data.user;
    this.user = { ...this.user, identities: u.identities || this.user.identities || {} };
    if (u.display_name) this.user.name = u.display_name;
    if (u.avatar_url) this.user.avatar = u.avatar_url;
    this._save();
    this._emit('refresh');
    return this.user;
  }

  // ── sign in and link ──

  /**
   * Begin a sign-in or (with `link`) adding a login to the signed-in account.
   * A link needs a sign-in from the last few minutes: when the server asks for one
   * (`fresh_signin`), `reauth` is tried once; without it the error has `fresh: true`
   * so the page can ask the player to sign in again.
   * `scopes`: the Discord permissions chosen. An empty list is a choice too (none of them).
   * `anyTab`: the provider may come back in a new tab of this browser (a prepared link that
   * opens the Discord app on a phone), so the sign-in's value is kept for the browser.
   * @param {'discord'|'steam'} provider
   * @param {{ mode?: 'redirect'|'device', link?: boolean, returnTo?: string, joinServer?: boolean, scopes?: string[], anyTab?: boolean }} [o]
   */
  async begin(provider, { mode = 'redirect', link = false, returnTo, joinServer, scopes, anyTab = false } = {}) {
    /** @type {Record<string, any>} */
    const body = { device_id: this._deviceId() };
    if (provider === 'discord') {
      body.mode = mode;
      if (joinServer) body.join_server = true;
      if (Array.isArray(scopes)) body.scopes = scopes;
    }
    let pending = null;
    if (mode === 'redirect') {
      body.return_to = returnTo || this._here();
      pending = await newSignInNonce();
      if (pending) body.nonce_hash = pending.hash;
    }
    const r = await this._withFresh(() => this.api(`/auth/${provider}/begin`, { method: 'POST', body, auth: link }));
    if (r.status === 401 && r.data.code === 'fresh_signin') throw Object.assign(new Error(r.data.error || 'Sign in again first.'), { fresh: true, code: 'fresh_signin' });
    if (!r.ok) throw Object.assign(new Error(r.data.error || `Sign-in unavailable (${r.status})`), { code: r.data.code, status: r.status });
    if (pending && r.data.id && !link) this._rememberNonce(r.data.id, pending.nonce, anyTab);
    return r.data;
  }

  /** Send; if the server wants a recent sign-in and this game can get one quietly, send again. */
  async _withFresh(/** @type {() => Promise<{ ok: boolean, status: number, data: any }>} */ send) {
    const r = await send();
    if (r.status !== 401 || r.data.code !== 'fresh_signin' || !this._reauth) return r;
    let again = false;
    try { again = !!(await this._reauth()); } catch (e) { again = false; }
    return again ? send() : r;
  }

  _readPending(/** @type {KeyValue} */ store) {
    try {
      const all = JSON.parse(store.getItem(SIGNIN_PENDING_KEY) || '{}') || {};
      const now = this._now();
      return Object.fromEntries(Object.entries(all).filter(([, v]) => v && now - /** @type {any} */ (v).at < SIGNIN_PENDING_TTL_MS));
    } catch (e) { return {}; }
  }

  _writePending(/** @type {KeyValue} */ store, /** @type {Record<string, any>} */ all) {
    try {
      if (Object.keys(all).length) store.setItem(SIGNIN_PENDING_KEY, JSON.stringify(all)); else store.removeItem(SIGNIN_PENDING_KEY);
    } catch (e) { /* blocked: this sign-in will be asked to start again */ }
  }

  _rememberNonce(/** @type {string} */ id, /** @type {string} */ nonce, /** @type {boolean} */ anyTab) {
    for (const store of anyTab ? [this._tab, this._storage] : [this._tab]) {
      const all = this._readPending(store);
      all[id] = { n: nonce, at: this._now() };
      const newest = Object.entries(all).sort((a, b) => b[1].at - a[1].at).slice(0, SIGNIN_PENDING_MAX);
      this._writePending(store, Object.fromEntries(newest));
    }
  }

  /** This browser's value for a sign-in it began. Read once. */
  _takeNonce(/** @type {string} */ id) {
    let nonce = null;
    for (const store of [this._tab, this._storage]) {
      const all = this._readPending(store);
      if (all[id]) { nonce = nonce || all[id].n; delete all[id]; this._writePending(store, all); }
    }
    return nonce;
  }

  /**
   * Is it fine for a session for `next` to take this browser's place? A working session for
   * a different account needs a yes. `ask`: also ask when nothing is signed in here.
   */
  async _mayTake(/** @type {any} */ next, /** @type {{ name?: string }} */ to, ask = false) {
    const cur = this.token ? this.claims() : null;
    const working = !!(cur && typeof cur.exp === 'number' && cur.exp > Math.floor(this._now() / 1000));
    if (working && String(cur.sub) === String(next.sub)) return true;
    if (!working && !ask) return true;
    try {
      return !!(await this._confirmSwitch({ from: working ? { name: (this.user && this.user.name) || cur.name } : null, to }));
    } catch (e) { return false; }
  }

  /** Swap the code the provider's callback brought for a session, with this browser's value. */
  async _exchange(/** @type {{ id: string, code: string }} */ { id, code }) {
    const nonce = this._takeNonce(id);
    if (!nonce) return { signedIn: false, mismatch: true, error: OTHER_BROWSER };
    const r = await this.api('/auth/exchange', { method: 'POST', body: { id, code, nonce }, auth: false }).catch(() => null);
    if (!r) return { signedIn: false, error: 'offline' };
    if (!r.ok || !r.data.token) {
      return { signedIn: false, mismatch: r.data.code === 'signin_mismatch', error: r.data.error || 'This sign-in has expired. Start it again.' };
    }
    const c = decodeToken(r.data.token);
    if (!c) return { signedIn: false, error: 'This sign-in has expired. Start it again.' };
    const u = r.data.user || { id: c.sub, name: c.name, avatar: c.picture };
    if (!(await this._mayTake(c, { name: u.name }))) return { signedIn: false, declined: true };
    const provider = typeof c.via === 'string' ? c.via.split(':')[0] : 'discord';
    this.apply(r.data.token, u, { provider });
    return { signedIn: true, server: r.data.server || undefined, steam: r.data.steam || undefined, after: this._takeAfter(c.sub) };
  }

  _here() {
    const l = this._loc || globalThis.location;
    return l.origin + l.pathname + l.search;
  }

  /** Same device: go to the provider and come back signed in (see resume). */
  async signInRedirect(provider, opts = {}) {
    const req = await this.begin(provider, { ...opts, mode: 'redirect', link: false });
    (this._loc || globalThis.location).assign(req.url);
    return req;
  }

  /**
   * Same device, signed in: go to the provider and come back with a link to finish.
   * Only this tab can finish it: the request's secret stays here.
   */
  async linkRedirect(provider, opts = {}) {
    const req = await this.begin(provider, { ...opts, mode: 'redirect', link: true });
    try { this._tab.setItem('ht_link_pending', JSON.stringify({ id: req.id, secret: req.secret, at: this._now() })); } catch (e) { /* no tab storage */ }
    (this._loc || globalThis.location).assign(req.url);
    return req;
  }

  /**
   * "Confirm it's you": a link needs a recent sign-in, and a browser has no quiet way to
   * get one. Sign in again with a login this account already has; when it comes back as
   * the same account, resume() answers with `after` (say 'link:steam'), for the page to
   * carry on with what the player asked for.
   * @param {'discord'|'steam'} provider @param {string} [then]
   */
  async confirmRedirect(provider, then, opts = {}) {
    const c = this.claims();
    try { this._storage.setItem(AFTER_KEY, JSON.stringify({ sub: c ? c.sub : null, then: then || null, at: this._now() })); } catch (e) { /* blocked */ }
    return this.signInRedirect(provider, opts);
  }

  /** What confirmRedirect left, if this sign-in is the same account and recent. Read once. */
  _takeAfter(sub) {
    let after = null;
    try { after = JSON.parse(this._storage.getItem(AFTER_KEY) || 'null'); } catch (e) { after = null; }
    try { this._storage.removeItem(AFTER_KEY); } catch (e) { /* blocked */ }
    return after && after.then && after.sub != null && String(after.sub) === String(sub) && this._now() - after.at < AFTER_TTL_MS ? String(after.then) : undefined;
  }

  _pendingSecret(id) {
    try {
      const p = JSON.parse(this._tab.getItem('ht_link_pending') || 'null');
      return p && p.id === id && this._now() - p.at < LINK_PENDING_TTL_MS ? p.secret : null;
    } catch (e) { return null; }
  }

  /**
   * Back from a redirect? Sign in with what it carried, or finish the link this tab began.
   * → null (nothing to do), { signedIn: true, server?, steam?, after? },
   *   { signedIn: false, mismatch?, declined?, expired?, error? } (the session here is unchanged),
   *   { link: 'linked' }, { link: 'combine', id, provider, into, other },
   *   or { link: 'failed', error }.
   */
  async resume() {
    const back = takeRedirect(this._loc || globalThis.location, this._hist || globalThis.history);
    if (!back) return null;
    if (back.result) return this._exchange(back.result);
    if (back.token) {
      const c = decodeToken(back.token);
      if (!c) return null;
      // An old link opened again (a bookmark, the back button): the token in it has expired.
      // The session already here, if any, stays as it is.
      if (typeof c.exp === 'number' && c.exp <= Math.floor(this._now() / 1000)) return { signedIn: false, expired: true };
      // A token in the address (an older server or tab) proves nothing about who began it,
      // so it needs a yes even with nobody signed in here. Its hints are not read.
      if (!(await this._mayTake(c, { name: typeof c.name === 'string' ? c.name : undefined }, true))) return { signedIn: false, declined: true };
      const before = this.token;
      this.token = back.token;
      const r = await this.api('/me').catch(() => null);
      if (r && r.status === 401) { this.token = before; return { signedIn: false, expired: true }; }
      const u = r && r.ok && r.data.user;
      const provider = typeof c.via === 'string' ? c.via.split(':')[0] : 'discord';
      this.apply(back.token, u ? { id: u.id, name: u.display_name, avatar: u.avatar_url, identities: u.identities } : { id: c.sub, name: c.name, avatar: c.picture }, { provider });
      return { signedIn: true, after: this._takeAfter(c.sub) };
    }
    return this.completeLink(/** @type {{ id: string, code: string }} */ (back.link));
  }

  /** Finish a link this tab began (its secret is here, and the session is the account's). */
  async completeLink({ id, code }) {
    const secret = this._pendingSecret(id);
    if (!secret || !this.token) return { link: 'failed', error: 'This link was started somewhere else. Start it again from your account.' };
    const r = await this.api('/auth/link/complete', { method: 'POST', body: { id, code, secret } });
    if (!r.ok) return { link: 'failed', error: r.data.error || 'That link has expired. Start it again.' };
    if (r.data.status === 'combine') return { link: 'combine', id, provider: r.data.provider, into: r.data.into, other: r.data.other, login: r.data.login };
    try { this._tab.removeItem('ht_link_pending'); } catch (e) { /* fine */ }
    if (r.data.token) this.apply(r.data.token, r.data.user, { keep: true }, 'link');
    return { link: 'linked', steam: r.data.steam_has_account ? 'has_account' : undefined, server: r.data.server || undefined };
  }

  /** The combine question's answer. → { status: 'combined' | 'cancelled' } or { error } */
  async combine(id, ok) {
    const secret = this._pendingSecret(id);
    if (!secret) return { error: 'This link was started somewhere else. Start it again from your account.' };
    const r = await this.api('/auth/link/combine', { method: 'POST', body: { id, secret, ok: !!ok } });
    try { this._tab.removeItem('ht_link_pending'); } catch (e) { /* fine */ }
    if (!r.ok) return { error: r.data.error || 'That link has expired. Start it again.' };
    if (r.data.status === 'combined' && r.data.token) this.apply(r.data.token, r.data.user, { keep: true }, 'combine');
    return { status: r.data.status };
  }

  /**
   * Device code: a sign-in finished on another device. Resolves { url, code, expiresAt } for
   * the QR, then polls. `onStatus('confirming')`: they are on their phone typing the code.
   * `onDone(user, { linked, merged })` or `onDone(null, { error })` with error
   * 'expired' | 'cancelled' | 'has_account' | 'declined'. One at a time.
   * Adding a login to an account is done in a browser (linkRedirect), never by device code:
   * `link: true` is refused with code 'link_needs_browser'.
   */
  /** @param {{ link?: boolean, onDone?: (user: IdentityUser|null, info: any) => void, onStatus?: (status: string) => void }} [o] */
  async startDevice({ link = false, onDone, onStatus } = {}) {
    if (link) throw Object.assign(new Error('Add this sign-in from your account page in a browser.'), { code: 'link_needs_browser' });
    if (this._device && this._device.expiresAt > this._now() + 30000 && this._device.link === link) {
      this._device.onDone = onDone;
      this._device.onStatus = onStatus;
      return this._device;
    }
    this.cancelDevice();
    const req = await this.begin('discord', { mode: 'device', link });
    const dev = {
      id: req.id, secret: req.secret, url: req.url, code: req.code, link,
      expiresAt: this._now() + (req.expires_in || 600) * 1000,
      onDone, onStatus, timer: /** @type {any} */ (null), stopped: false,
    };
    this._device = dev;
    const tick = async () => {
      if (dev.stopped) return;
      if (this._now() > dev.expiresAt) { this._finishDevice(dev, null, { error: 'expired' }); return; }
      try {
        const r = await this.api('/auth/poll', { method: 'POST', body: { id: dev.id, secret: dev.secret }, auth: false });
        if (dev.stopped) return;
        if (r.data.status === 'done') {
          const same = !!(this.user && r.data.linked);
          const next = decodeToken(r.data.token);
          if (!same && next && !(await this._mayTake(next, { name: r.data.user && r.data.user.name }))) {
            this._finishDevice(dev, null, { error: 'declined' });
            return;
          }
          this.apply(r.data.token, r.data.user, same ? { keep: true } : { provider: 'discord' }, same ? 'link' : 'signin');
          this._finishDevice(dev, this.user, { linked: !!r.data.linked, merged: !!r.data.merged });
          return;
        }
        if (r.data.status === 'error' || r.data.status === 'expired') {
          this._finishDevice(dev, null, { error: r.data.error || r.data.status });
          return;
        }
        if (dev.onStatus) dev.onStatus(r.data.status);
      } catch (e) { /* offline for a moment: keep polling */ }
      dev.timer = setTimeout(tick, POLL_MS);
    };
    dev.timer = setTimeout(tick, POLL_MS);
    return dev;
  }

  _finishDevice(dev, user, info) {
    dev.stopped = true;
    if (dev.timer) clearTimeout(dev.timer);
    if (this._device === dev) this._device = null;
    if (dev.onDone) dev.onDone(user, info);
  }

  /** Stop polling (the panel closed). The phone's side simply expires. */
  cancelDevice() {
    const dev = this._device;
    if (!dev) return;
    dev.stopped = true;
    if (dev.timer) clearTimeout(dev.timer);
    this._device = null;
  }

  /**
   * A sign-in the platform vouches for (the Steam build's ticket): POST `path` with `body`,
   * and the answer's { token, user } is the session. `quiet`: a fresh session for the
   * same player (before a link), so listeners hear 'fresh', not 'signin'.
   */
  /** @param {string} path @param {Record<string, any>} body @param {{ provider?: string, quiet?: boolean, extra?: Record<string, any> }} [o] */
  async signInWith(path, body, { provider, quiet = false, extra = {} } = {}) {
    const r = await this.api(path, { method: 'POST', auth: false, body: { ...body, device_id: this._deviceId(), session_id: this._sessionId() } });
    if (!r.ok || !r.data.token) {
      this.lastError = (r.data && r.data.error) || `Sign-in failed (${r.status})`;
      return false;
    }
    this.apply(r.data.token, r.data.user, { provider, ...extra, ...(quiet ? { keep: true } : {}) }, quiet ? 'fresh' : 'signin');
    return true;
  }

  // ── the account's games, server membership, hand-off, delete ──

  /** Achievements, stats and time played in every House Tandem game: { dice: { earned: [{ id, earnedAt }], stats, playtime } }. */
  async games() {
    if (!this.token) return {};
    try {
      const r = await this.api('/me/games');
      return r.ok ? (r.data.games || {}) : {};
    } catch (e) { return {}; }
  }

  /** Is the account's Discord in the House Tandem server? { linked, member: true|false|null, invite, server_url } or null. */
  async membership() {
    if (!this.token) return null;
    try {
      const r = await this.api('/me/discord');
      return r.ok ? r.data : null;
    } catch (e) { return null; }
  }

  /** A one-time code that opens another House Tandem site signed in (it goes in that site's URL; the session never does). → code or null */
  /**
   * The other end of handoff(): this page was opened with `?ht_code=…` (a link from a signed-in
   * page of another House Tandem site). The code comes off the address at once, and is swapped
   * for a session. A code that is refused or has expired leaves the session already here alone,
   * and so does one for a different account unless the player says yes. For the same account
   * the session here stays as it is.
   * @returns {Promise<{ signedIn: boolean, error?: string, declined?: boolean }|null>} null when there was no code
   */
  async redeemHandoff() {
    const loc = this._loc || globalThis.location;
    const hist = this._hist || globalThis.history;
    if (!loc || !loc.search || !/[?&]ht_code=/.test(loc.search)) return null;
    const params = new URLSearchParams(loc.search);
    const code = params.get('ht_code');
    params.delete('ht_code');
    const rest = params.toString();
    try { hist.replaceState(null, '', loc.pathname + (rest ? '?' + rest : '') + (loc.hash || '')); } catch (e) { /* no history here */ }
    if (!code) return null;
    const r = await this.api('/auth/handoff/redeem', { method: 'POST', body: { code }, auth: false }).catch(() => null);
    if (!r) return { signedIn: false, error: 'offline' };
    if (!r.ok || !r.data.token) return { signedIn: false, error: r.data.error || 'This sign-in link has expired' };
    const c = decodeToken(r.data.token);
    if (!c || (typeof c.exp === 'number' && c.exp <= Math.floor(this._now() / 1000))) return { signedIn: false, error: 'This sign-in link has expired' };
    const to = { name: (r.data.user && r.data.user.name) || c.name };
    if (!(await this._mayTake(c, to))) return { signedIn: false, declined: true };
    const cur = this.token ? this.claims() : null;
    if (cur && String(cur.sub) === String(c.sub) && !this.tokenExpired(0)) return { signedIn: true };
    const provider = typeof c.via === 'string' ? c.via.split(':')[0] : undefined;
    this.apply(r.data.token, r.data.user || { id: c.sub, name: c.name, avatar: c.picture }, provider ? { provider } : {});
    return { signedIn: true };
  }

  async handoff() {
    if (!this.token) return null;
    try {
      const r = await this._withFresh(() => this.api('/auth/handoff', { method: 'POST' }));
      return (r.ok && r.data.code) || null;
    } catch (e) { return null; }
  }

  /**
   * Sign out on every device: every session of this account stops working, this one too.
   * → { ok: true } or { error } (still signed in).
   */
  async signOutEverywhere() {
    if (!this.token) return { error: 'Sign in first' };
    try {
      const r = await this.api('/me/signout-all', { method: 'POST', body: {} });
      if (!r.ok) return { error: r.data.error || 'That did not work. Nothing was changed.' };
      this.signOut();
      return { ok: true };
    } catch (e) { return { error: 'Offline. Nothing was changed.' }; }
  }

  /**
   * Delete the account and everything on it. The server wants the typed word and a recent
   * sign-in. → { deleted: true } (and this session is over) or { error, fresh? }.
   */
  async deleteAccount(confirmWord) {
    if (!this.token) return { error: 'Sign in first' };
    try {
      const r = await this._withFresh(() => this.api('/me/delete', { method: 'POST', body: { confirm: confirmWord } }));
      if (!r.ok || !r.data.deleted) {
        return { error: r.data.error || 'The account could not be deleted. Nothing was changed.', ...(r.data.code === 'fresh_signin' ? { fresh: true } : {}) };
      }
      this.signOut();
      return r.data;
    } catch (e) { return { error: 'Offline. Nothing was changed.' }; }
  }

  // ── notices ──

  /** What was linked to or combined into this account lately (each can be undone). @returns {Promise<AccountNotice[]>} */
  async notices() {
    if (!this.token) return [];
    try {
      const r = await this.api('/me/notices');
      return r.ok ? (r.data.notices || []) : [];
    } catch (e) { return []; }
  }

  /** "That was me": stop showing it (it stays undoable). */
  async seen(id) {
    if (!this.token) return;
    try { await this.api('/me/notices/seen', { method: 'POST', body: { id } }); } catch (e) { /* next time */ }
  }

  /**
   * Remove a linked login, or separate a combined account.
   * → { undone: true, kind, signed_out } or { error, fresh? }. Needs a recent sign-in.
   * An undo ends the account's other sessions; this one continues with the token the
   * server sends back. signed_out: this session's own login left with the other account,
   * so sign in again to show it.
   */
  async undo(id) {
    if (!this.token) return { error: 'Sign in first' };
    try {
      const r = await this._withFresh(() => this.api('/me/notices/undo', { method: 'POST', body: { id } }));
      if (!r.ok) return { error: r.data.error || 'That could not be undone.', ...(r.data.code === 'fresh_signin' ? { fresh: true } : {}) };
      if (r.data.token && !r.data.signed_out) this.apply(r.data.token, r.data.user, { keep: true }, 'fresh');
      if (!r.data.signed_out) await this.refresh();
      const { token: _token, user: _user, ...out } = r.data;
      return out;
    } catch (e) { return { error: 'Offline. Try again in a moment.' }; }
  }
}

/** A server user as stored when a game gives no `shapeUser`. */
function defaultShape(serverUser, extra, prev) {
  const p = prev || /** @type {any} */ ({});
  return {
    ...p, ...extra,
    id: (serverUser && serverUser.id) ?? p.id,
    name: (serverUser && serverUser.name) || p.name || 'Player',
    avatar: (serverUser && serverUser.avatar) || p.avatar || null,
    identities: (serverUser && serverUser.identities) || p.identities || {},
    provider: extra.provider || p.provider,
  };
}
