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

const POLL_MS = 2000;
const LINK_PENDING_TTL_MS = 15 * 60 * 1000;

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
 *   #ht_auth=<token>            a sign-in
 *   #ht_link=<id>.<code>        a link to finish (completeLink)
 *   &ht_server=joined|…         the Discord server join's result
 *   &ht_steam=has_account       Discord's verified Steam has its own account (offer the combine)
 * @returns {{ token?: string, link?: { id: string, code: string }, server?: string, steam?: string }|null}
 */
export function takeRedirect(loc = globalThis.location, hist = globalThis.history) {
  if (!loc || !loc.hash || !/ht_(auth|link)=/.test(loc.hash)) return null;
  const params = new URLSearchParams(loc.hash.slice(1));
  /** @type {{ token?: string, link?: { id: string, code: string }, server?: string, steam?: string }} */
  const out = {};
  const token = params.get('ht_auth');
  if (token) out.token = token;
  const link = params.get('ht_link');
  if (link && link.includes('.')) {
    const i = link.indexOf('.');
    out.link = { id: link.slice(0, i), code: link.slice(i + 1) };
  }
  const server = params.get('ht_server');
  if (server) out.server = server;
  const steam = params.get('ht_steam');
  if (steam) out.steam = steam;
  for (const k of ['ht_auth', 'ht_link', 'ht_server', 'ht_steam']) params.delete(k);
  const rest = params.toString();
  try { hist.replaceState(null, '', loc.pathname + loc.search + (rest ? '#' + rest : '')); } catch (e) { /* no history here */ }
  return out.token || out.link ? out : null;
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
   * @param {'discord'|'steam'} provider
   * @param {{ mode?: 'redirect'|'device', link?: boolean, returnTo?: string, joinServer?: boolean, scopes?: string[] }} [o]
   */
  async begin(provider, { mode = 'redirect', link = false, returnTo, joinServer, scopes } = {}) {
    /** @type {Record<string, any>} */
    const body = { device_id: this._deviceId() };
    if (provider === 'discord') {
      body.mode = mode;
      if (joinServer) body.join_server = true;
      if (scopes && scopes.length) body.scopes = scopes;
    }
    if (mode === 'redirect') body.return_to = returnTo || this._here();
    const send = () => this.api(`/auth/${provider}/begin`, { method: 'POST', body, auth: link });
    let r = await send();
    if (r.status === 401 && r.data.code === 'fresh_signin') {
      let again = false;
      try { again = !!(this._reauth && (await this._reauth())); } catch (e) { again = false; }
      if (!again) throw Object.assign(new Error(r.data.error || 'Sign in again first.'), { fresh: true, code: 'fresh_signin' });
      r = await send();
    }
    if (!r.ok) throw Object.assign(new Error(r.data.error || `Sign-in unavailable (${r.status})`), { code: r.data.code, status: r.status });
    return r.data;
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
   *   { link: 'linked' }, { link: 'combine', id, provider, into, other },
   *   or { link: 'failed', error }.
   */
  async resume() {
    const back = takeRedirect(this._loc || globalThis.location, this._hist || globalThis.history);
    if (!back) return null;
    if (back.token) {
      const c = decodeToken(back.token);
      if (!c) return null;
      this.token = back.token;
      const r = await this.api('/me').catch(() => null);
      const u = r && r.ok && r.data.user;
      const provider = typeof c.via === 'string' ? c.via.split(':')[0] : 'discord';
      this.apply(back.token, u ? { id: u.id, name: u.display_name, avatar: u.avatar_url, identities: u.identities } : { id: c.sub, name: c.name, avatar: c.picture }, { provider });
      return { signedIn: true, server: back.server, steam: back.steam, after: this._takeAfter(c.sub) };
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
    return { link: 'linked', steam: r.data.steam_has_account ? 'has_account' : undefined };
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
   * Device code: a sign-in (or, signed in with `link`, a link) finished on another device.
   * Resolves { url, code, expiresAt } for the QR, then polls. `onStatus('confirming')`: they
   * are on their phone typing the code. `onDone(user, { linked, merged })` or
   * `onDone(null, { error })` with error 'expired' | 'cancelled' | 'has_account'. One at a time.
   */
  /** @param {{ link?: boolean, onDone?: (user: IdentityUser|null, info: any) => void, onStatus?: (status: string) => void }} [o] */
  async startDevice({ link = false, onDone, onStatus } = {}) {
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
  async handoff() {
    if (!this.token) return null;
    try {
      const r = await this.api('/auth/handoff', { method: 'POST' });
      return (r.ok && r.data.code) || null;
    } catch (e) { return null; }
  }

  /**
   * Delete the account and everything on it. The server wants the typed word.
   * → { deleted: true } (and this session is over) or { error }.
   */
  async deleteAccount(confirmWord) {
    if (!this.token) return { error: 'Sign in first' };
    try {
      const r = await this.api('/me/delete', { method: 'POST', body: { confirm: confirmWord } });
      if (!r.ok || !r.data.deleted) return { error: r.data.error || 'The account could not be deleted. Nothing was changed.' };
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
   * → { undone: true, kind, signed_out } or { error }.
   * signed_out: this session's own login left with the other account. The session still
   * works, as THAT account: sign in again (or `refresh()`) to show it.
   */
  async undo(id) {
    if (!this.token) return { error: 'Sign in first' };
    try {
      const r = await this.api('/me/notices/undo', { method: 'POST', body: { id } });
      if (!r.ok) return { error: r.data.error || 'That could not be undone.' };
      if (!r.data.signed_out) await this.refresh();
      return r.data;
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
