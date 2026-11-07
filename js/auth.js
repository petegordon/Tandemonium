// ============================================================
// AUTH — House Tandem account: Discord + Steam (#612)
// ============================================================
//
// One account, several sign-ins. The Steam build signs in by Steam ticket on
// its own; anyone can sign in (or a Steam player can link) with Discord.
// Google is no longer offered (2026-11-06); a stored Google session keeps
// working until it expires.
//
// Discord sign-in:
//   - same device (a browser with a mouse or touch): a full-page redirect to
//     Discord and back; the session comes back in the URL fragment.
//   - device code (TV, Steam build, or linking): the game shows a QR + a
//     4-letter code; the player finishes in a browser (their phone, or the
//     system browser the Steam build opens) and confirms the code. The game
//     polls the API with a secret only it holds.

import { API_BASE } from './config.js';

const STORAGE_USER = 'tandemonium_auth_user';
const STORAGE_TOKEN = 'tandemonium_auth_token';
const POLL_MS = 2000;

/** Pull `#ht_auth=<jwt>` off the URL (a Discord redirect coming back). */
export function takeRedirectToken(loc = globalThis.location, hist = globalThis.history) {
  if (!loc || !loc.hash || !loc.hash.includes('ht_auth=')) return null;
  const params = new URLSearchParams(loc.hash.slice(1));
  const token = params.get('ht_auth');
  params.delete('ht_auth');
  const rest = params.toString();
  try { hist.replaceState(null, '', loc.pathname + loc.search + (rest ? '#' + rest : '')); } catch (e) {}
  return token || null;
}

/** The sign-ins to picture, left to right: Discord, then Steam (then anything else). */
export function identityPictures(user) {
  if (!user) return [];
  const ids = user.identities || {};
  const out = [];
  for (const p of ['discord', 'steam']) {
    if (ids[p] && ids[p].avatar) out.push({ provider: p, avatar: ids[p].avatar, name: ids[p].name });
  }
  if (!out.length && user.avatar) out.push({ provider: user.provider || 'account', avatar: user.avatar, name: user.name });
  return out;
}

function decodeJwt(token) {
  try {
    return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
  } catch { return null; }
}

export class AuthManager {
  constructor() {
    this.user = null;
    this.token = null;
    this.lastAuthError = null;
    this._onLoginCallback = null;
    this._device = null;   // the device-code sign-in in progress
    this._load();
  }

  _load() {
    try {
      const raw = localStorage.getItem(STORAGE_USER);
      if (raw) this.user = JSON.parse(raw);
      this.token = localStorage.getItem(STORAGE_TOKEN) || null;
    } catch (e) {}
  }

  _save() {
    try {
      if (this.user) localStorage.setItem(STORAGE_USER, JSON.stringify(this.user));
      if (this.token) localStorage.setItem(STORAGE_TOKEN, this.token);
    } catch (e) {}
  }

  isLoggedIn() {
    return !!(this.user && this.token);
  }

  getUser() {
    return this.user;
  }

  /** Current server JWT (or null). The injected-identity surface other modules
   *  depend on, so they can make authed requests without knowing about auth. */
  getToken() {
    return this.token;
  }

  /** Is this sign-in linked to the account? ('discord' | 'steam' | 'google') */
  hasIdentity(provider) {
    return !!(this.user && this.user.identities && this.user.identities[provider]);
  }

  onLogin(callback) {
    this._onLoginCallback = callback;
  }

  /**
   * Take a server answer ({ token, user }) as the signed-in state. Only a link
   * (`extra.keep`) carries anything over from the previous user; a fresh
   * sign-in starts clean, so one player's id never sticks to the next.
   */
  _applySession(token, serverUser, extra = {}) {
    this.token = token;
    const prev = (extra.keep && this.user) || {};
    delete extra.keep;
    this.user = {
      ...extra,
      id: extra.id || prev.id || (serverUser && serverUser.id),
      name: (serverUser && serverUser.name) || prev.name || 'Player',
      avatar: (serverUser && serverUser.avatar) || prev.avatar || null,
      serverId: serverUser && serverUser.id,
      identities: (serverUser && serverUser.identities) || prev.identities || {},
    };
    if (extra.provider) this.user.provider = extra.provider;
    else if (prev.provider) this.user.provider = prev.provider;
    this.lastAuthError = null;
    this._save();
  }

  /**
   * Back from a Discord redirect? Then sign in with the token it carried.
   * Called once the lobby has registered onLogin. Returns true when it did.
   */
  async resumeFromRedirect() {
    const token = takeRedirectToken();
    if (!token) return false;
    const claims = decodeJwt(token);
    if (!claims) return false;
    this.token = token;
    const me = await this.getMe().catch(() => null);
    const u = me && me.user;
    this._applySession(token, u ? { id: u.id, name: u.display_name, avatar: u.avatar_url, identities: u.identities } : { id: claims.sub, name: claims.name, avatar: claims.picture }, { provider: 'discord' });
    if (this._onLoginCallback) this._onLoginCallback(this.user);
    return true;
  }

  /** Re-read the account (its linked sign-ins) from the server. */
  async refreshProfile() {
    const me = await this.getMe().catch(() => null);
    if (!me || !me.user || !this.user) return null;
    this.user.identities = me.user.identities || this.user.identities || {};
    if (me.user.display_name) this.user.name = me.user.display_name;
    if (me.user.avatar_url) this.user.avatar = me.user.avatar_url;
    this._save();
    return this.user;
  }

  async _beginDiscord(body) {
    const headers = { 'Content-Type': 'application/json' };
    // Signed in already: the Discord sign-in is linked to this account.
    if (this.token && !this.isTokenExpired()) headers.Authorization = `Bearer ${this.token}`;
    const res = await fetch(`${API_BASE}/auth/discord/begin`, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || ('Discord sign-in unavailable (' + res.status + ')'));
    }
    return res.json();
  }

  /** Same device: go to Discord and come back here signed in. */
  async signInWithDiscordRedirect() {
    try {
      const returnTo = location.origin + location.pathname + location.search;
      const req = await this._beginDiscord({ mode: 'redirect', return_to: returnTo });
      location.assign(req.url);
      return true;
    } catch (e) {
      this.lastAuthError = e.message;
      return false;
    }
  }

  /**
   * Device code: start (or reuse) a sign-in finished in another browser.
   * Resolves { url, code, expiresAt } for the QR, then keeps polling; `onDone`
   * gets (user, { linked, merged }) or (null, { error }). One at a time.
   */
  async startDiscordDevice({ onDone, onStatus } = {}) {
    if (this._device && this._device.expiresAt > Date.now() + 30000) {
      this._device.onDone = onDone;
      this._device.onStatus = onStatus;
      return this._device;
    }
    this.cancelDiscordDevice();
    const req = await this._beginDiscord({ mode: 'device' });
    const dev = {
      id: req.id, secret: req.secret, url: req.url, code: req.code,
      expiresAt: Date.now() + (req.expires_in || 600) * 1000,
      onDone, onStatus, timer: null, stopped: false,
    };
    this._device = dev;
    const tick = async () => {
      if (dev.stopped) return;
      if (Date.now() > dev.expiresAt) { this._finishDevice(dev, null, { error: 'expired' }); return; }
      try {
        const res = await fetch(`${API_BASE}/auth/poll`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: dev.id, secret: dev.secret }),
        });
        const data = await res.json().catch(() => ({}));
        if (dev.stopped) return;
        if (data.status === 'done') {
          this._applySession(data.token, data.user, this.user && data.linked ? { keep: true } : { provider: 'discord' });
          this._finishDevice(dev, this.user, { linked: !!data.linked, merged: !!data.merged });
          if (this._onLoginCallback) this._onLoginCallback(this.user);
          return;
        }
        if (data.status === 'error' || data.status === 'expired') {
          this._finishDevice(dev, null, { error: data.error || data.status });
          return;
        }
        if (dev.onStatus) dev.onStatus(data.status);
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

  /** Stop polling (the popup closed). The browser side simply expires. */
  cancelDiscordDevice() {
    const dev = this._device;
    if (!dev) return;
    dev.stopped = true;
    if (dev.timer) clearTimeout(dev.timer);
    this._device = null;
  }

  /** Check if the stored server JWT is expired (or will expire within marginSec). */
  isTokenExpired(marginSec = 60) {
    if (!this.token) return true;
    const payload = decodeJwt(this.token);
    return !payload || !payload.exp || payload.exp < Math.floor(Date.now() / 1000) + marginSec;
  }

  /**
   * Ensure the server JWT is valid. The Steam build signs in again by ticket;
   * a Discord session lasts 30 days, then the player signs in again.
   * Returns true if a valid token is available afterward.
   */
  async ensureValidToken() {
    if (!this.isTokenExpired()) return true;
    if (typeof window !== 'undefined' && window.steam) {
      try {
        if (await window.steam.isAvailable()) return await this.loginWithSteam();
      } catch (e) {}
    }
    return false;
  }

  async loginWithSteam() {
    try {
      const steamId = await window.steam.getSteamId();
      const personaName = await window.steam.getPlayerName();
      const ticket = await window.steam.getAuthTicket();
      if (!steamId || !ticket) {
        console.error('AUTH: Steam credentials unavailable');
        return false;
      }

      const res = await fetch(`${API_BASE}/auth/steam`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ steamId, personaName, ticket }),
      });
      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        this.lastAuthError = 'Steam auth failed (' + res.status + ')';
        console.error('AUTH: Steam auth failed:', res.status, errBody);
        return false;
      }

      const data = await res.json();
      // #612: the account's name and picture; the Steam picture comes along in identities.
      this._applySession(data.token, { ...data.user, name: personaName || data.user.name }, { id: steamId, provider: 'steam' });

      if (this._onLoginCallback) this._onLoginCallback(this.user);
      return true;
    } catch (e) {
      console.error('AUTH: Steam login error:', e);
      this.lastAuthError = 'Steam auth error: ' + (e.message || 'unknown');
      return false;
    }
  }

  // Clear server JWT token only (keeps user profile for re-auth)
  clearToken() {
    this.token = null;
    try { localStorage.removeItem(STORAGE_TOKEN); } catch (e) {}
  }

  logout() {
    this.cancelDiscordDevice();
    this.user = null;
    this.token = null;
    try {
      localStorage.removeItem(STORAGE_USER);
      localStorage.removeItem(STORAGE_TOKEN);
    } catch (e) {}
  }

  /**
   * #612 · the account behind this session is gone (deleted on housetandem.com):
   * drop the session; the Steam build signs in again by ticket (a fresh account).
   */
  async _recoverGoneAccount(res) {
    if (res.status !== 401) return false;
    const body = await res.clone().json().catch(() => ({}));
    if (body.code !== 'account_gone') return false;
    this.clearToken();
    return this.ensureValidToken();
  }

  async submitScore(data) {
    if (!this.token) return null;
    const send = () => fetch(`${API_BASE}/score`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.token}`,
      },
      body: JSON.stringify(data),
    });
    let res = await send();
    if (!res.ok && (await this._recoverGoneAccount(res))) res = await send();
    return res.ok ? res.json() : null;
  }

  async getLeaderboard(levelId, scope, limit, options) {
    const params = new URLSearchParams({ level: levelId || 'grandma' });
    if (scope) params.set('scope', scope);
    if (limit) params.set('limit', String(limit));
    if (options) {
      if (options.mode) params.set('mode', options.mode);
      if (options.userId) params.set('user_id', options.userId);
    }
    const headers = {};
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;
    const res = await fetch(`${API_BASE}/leaderboard?${params}`, { headers });
    return res.ok ? res.json() : { entries: [] };
  }

  async getMe() {
    if (!this.token) return null;
    const send = () => fetch(`${API_BASE}/me`, {
      headers: { 'Authorization': `Bearer ${this.token}` },
    });
    let res = await send();
    if (!res.ok && (await this._recoverGoneAccount(res))) res = await send();
    return res.ok ? res.json() : null;
  }

  /**
   * D-8 · what these two riders have done together: rides, distance, best
   * time per level, and their streak. `withId` is a user id, or a
   * 'guest:<device_id>' key for a partner who has not signed in (D-9).
   */
  async fetchPair(withId) {
    if (!this.token || !withId) return null;
    const res = await fetch(`${API_BASE}/pair?with=${encodeURIComponent(withId)}`, {
      headers: { 'Authorization': `Bearer ${this.token}` },
    });
    return res.ok ? res.json() : null;
  }

  /**
   * D-6 · today's ranked results for this player and the people they have
   * ridden with. The server never returns a stranger.
   */
  async fetchDailyBoard(dayKey) {
    if (!this.token) return null;
    const q = dayKey ? `?key=${encodeURIComponent(dayKey)}` : '';
    const res = await fetch(`${API_BASE}/daily${q}`, {
      headers: { 'Authorization': `Bearer ${this.token}` },
    });
    return res.ok ? res.json() : null;
  }

  /** D-6 / #641 · submit a finished Daily Ride; the server keeps the day's best. */
  async submitDaily(data) {
    if (!this.token) return null;
    const res = await fetch(`${API_BASE}/daily`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.token}`,
      },
      body: JSON.stringify(data),
    });
    if (res.status === 409) return { alreadyRidden: true };   // a pre-#641 server
    return res.ok ? res.json() : null;
  }

  async getPartners() {
    if (!this.token) return { partners: [] };
    const res = await fetch(`${API_BASE}/partners`, {
      headers: { 'Authorization': `Bearer ${this.token}` },
    });
    return res.ok ? res.json() : { partners: [] };
  }

  async getRelayToken(room, role) {
    if (!this.token) return null;
    try {
      const res = await fetch(`${API_BASE}/relay-token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`,
        },
        body: JSON.stringify({ room, role }),
      });
      if (res.ok) {
        const data = await res.json();
        return data.token;
      }
    } catch (e) { /* relay auth unavailable — fall through */ }
    return null;
  }
}
