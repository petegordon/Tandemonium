// ============================================================
// AUTH — House Tandem account: Discord + Steam (#612)
// ============================================================
//
// One account, several sign-ins. The Steam build signs in by Steam ticket on
// its own; anyone can sign in (or a Steam player can link) with Discord.
// Google is no longer offered (2026-11-06); a stored Google session keeps
// working until it expires.
//
// #783 · the session and the sign-in flows are @usersfirst/identity's
// IdentityClient (shared/identity/, vendored from the controller lab: the same
// client every House Tandem game and housetandem.com use). This file is what
// is Tandemonium's own: where the session is stored, the Steam ticket, the
// shape the lobby expects of `user`, and the game's API calls.
//
// Discord sign-in:
//   - same device (a browser with a mouse or touch): a full-page redirect to
//     Discord and back; the session comes back in the URL fragment.
//   - device code (TV, Steam build, or linking): the game shows a QR + a
//     4-letter code; the player finishes in a browser (their phone, or the
//     system browser the Steam build opens) and types the code. The game
//     polls the API with a secret only it holds. Linking from a phone adds a
//     Discord with no account of its own; if it has one, the phone shows both
//     accounts and the player chooses Combine (#612). Every link and combine
//     shows a notice with undo.

import { API_BASE } from './config.js';
import { getDeviceId, getSessionId, attachAccount } from './analytics.js';
import { IdentityClient, takeRedirect, loginPictures } from '../shared/identity/client.js';

/**
 * #678 · this device's id, sent with Player 1's sign-in so the rides it
 * logged as a guest move to the account. Seat sign-ins
 * (js/seat-accounts.js) never send it: that guest is Player 1, not them.
 */
function deviceIdForSignIn() {
  try { return getDeviceId() || undefined; } catch (e) { return undefined; }
}

/** This launch's analytics session: the sign-in attaches the account to it. */
function sessionIdForSignIn() {
  try { return getSessionId() || undefined; } catch (e) { return undefined; }
}

const STORAGE_USER = 'tandemonium_auth_user';
const STORAGE_TOKEN = 'tandemonium_auth_token';

/** Pull `#ht_auth=<jwt>` off the URL (a Discord redirect coming back). */
export function takeRedirectToken(loc = globalThis.location, hist = globalThis.history) {
  const back = takeRedirect(loc, hist);
  return (back && back.token) || null;
}

/** The sign-ins to picture, left to right: Discord, then Steam (then anything else). */
export const identityPictures = loginPictures;

/**
 * A server user as the lobby keeps it. Only a link or a fresh sign-in for the same player
 * (`prev`) carries anything over; a new sign-in starts clean, so one player's id never
 * sticks to the next. `id` is the Steam id in the Steam build (tuning and saves are keyed
 * by it); `serverId` is always the House Tandem account.
 */
function shapeUser(serverUser, extra, prev) {
  const p = prev || {};
  const { displayName, ...rest } = extra;
  const user = {
    ...rest,
    id: rest.id || p.id || (serverUser && serverUser.id),
    name: displayName || (serverUser && serverUser.name) || p.name || 'Player',
    avatar: (serverUser && serverUser.avatar) || p.avatar || null,
    serverId: serverUser && serverUser.id,
    identities: (serverUser && serverUser.identities) || p.identities || {},
  };
  if (rest.provider) user.provider = rest.provider;
  else if (p.provider) user.provider = p.provider;
  return user;
}

export class AuthManager {
  constructor() {
    this.lastAuthError = null;
    this._onLoginCallback = null;
    this.identity = new IdentityClient({
      apiBase: API_BASE,
      keys: { user: STORAGE_USER, token: STORAGE_TOKEN },
      deviceId: deviceIdForSignIn,
      sessionId: sessionIdForSignIn,
      shapeUser,
      // A link needs a sign-in from the last few minutes (#612): the Steam build gets one
      // by signing in again with Steam, without asking the player.
      reauth: async () => {
        const steam = typeof window !== 'undefined' && window.steam;
        return !!(steam && (await steam.isAvailable()) && (await this.loginWithSteam({ quiet: true })));
      },
    });
    this.identity.onChange((user, reason) => {
      if (!user || reason === 'signout' || reason === 'refresh' || reason === 'gone') return;
      this.lastAuthError = null;
      try { attachAccount(this.identity.token); } catch (e) { /* analytics only */ }
    });
  }

  // The session lives in the client. (Smokes and the lobby read and set these directly.)
  get user() { return this.identity.user; }
  set user(v) { this.identity.user = v; }
  get token() { return this.identity.token; }
  set token(v) { this.identity.token = v; }
  /** The device-code sign-in in progress (the P1 seat panel shows its QR again). */
  get _device() { return this.identity._device; }

  isLoggedIn() {
    return this.identity.isSignedIn();
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
    return this.identity.hasLogin(provider);
  }

  onLogin(callback) {
    this._onLoginCallback = callback;
  }

  /**
   * Back from a Discord redirect? Then sign in with the token it carried.
   * Called once the lobby has registered onLogin. Returns true when it did.
   */
  async resumeFromRedirect() {
    const back = await this.identity.resume();
    if (!back || !back.signedIn) return false;
    if (this._onLoginCallback) this._onLoginCallback(this.user);
    return true;
  }

  /** Re-read the account (its linked sign-ins) from the server. */
  async refreshProfile() {
    return this.identity.refresh();
  }

  /** Same device: go to Discord and come back here signed in. */
  async signInWithDiscordRedirect() {
    try {
      await this.identity.signInRedirect('discord');
      return true;
    } catch (e) {
      this.lastAuthError = e.message;
      return false;
    }
  }

  /**
   * Device code: start (or reuse) a sign-in finished in another browser. Signed in
   * already, it links Discord to this account instead.
   * Resolves { url, code, expiresAt } for the QR, then keeps polling; `onDone`
   * gets (user, { linked, merged }) or (null, { error }). One at a time.
   */
  async startDiscordDevice({ onDone, onStatus } = {}) {
    const link = this.isLoggedIn() && !this.isTokenExpired();
    try {
      return await this.identity.startDevice({
        link,
        onStatus,
        onDone: (user, info) => {
          if (onDone) onDone(user, info);
          if (user && this._onLoginCallback) this._onLoginCallback(user);
        },
      });
    } catch (e) {
      if (e && e.fresh) throw new Error('For your safety, sign out and sign in again, then link Discord.');
      throw e;
    }
  }

  /** Stop polling (the popup closed). The browser side simply expires. */
  cancelDiscordDevice() {
    this.identity.cancelDevice();
  }

  /** Check if the stored server JWT is expired (or will expire within marginSec). */
  isTokenExpired(marginSec = 60) {
    return this.identity.tokenExpired(marginSec);
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

  /** `quiet`: a fresh session for the same player (before a link), so no login callback. */
  async loginWithSteam({ quiet = false } = {}) {
    try {
      const steamId = await window.steam.getSteamId();
      const personaName = await window.steam.getPlayerName();
      const ticket = await window.steam.getAuthTicket();
      if (!steamId || !ticket) {
        console.error('AUTH: Steam credentials unavailable');
        return false;
      }

      // #612: the account's name and picture; the Steam picture comes along in identities.
      const ok = await this.identity.signInWith('/auth/steam', { steamId, personaName, ticket },
        { provider: 'steam', quiet, extra: { id: steamId, displayName: personaName || undefined } });
      if (!ok) {
        this.lastAuthError = this.identity.lastError || 'Steam auth failed';
        console.error('AUTH: Steam auth failed:', this.lastAuthError);
        return false;
      }
      if (!quiet && this._onLoginCallback) this._onLoginCallback(this.user);
      return true;
    } catch (e) {
      console.error('AUTH: Steam login error:', e);
      this.lastAuthError = 'Steam auth error: ' + (e.message || 'unknown');
      return false;
    }
  }

  // Clear server JWT token only (keeps user profile for re-auth)
  clearToken() {
    this.identity.clearToken();
  }

  logout() {
    this.identity.signOut();
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

  /**
   * #612 · what was linked to or combined into this account lately:
   * [{ id, kind: 'link'|'combine', provider, login_name, from_name, created_at, undo_until, seen }]
   */
  async fetchNotices() {
    return this.identity.notices();
  }

  async markNoticeSeen(id) {
    return this.identity.seen(id);
  }

  /** Remove a linked sign-in / separate a combined account. → { undone, signed_out } or { error } */
  async undoNotice(id) {
    return this.identity.undo(id);
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
