// @ts-check
// ============================================================
// SEAT ACCOUNTS (#612 item 5) — players 2–4 sign in with Discord from the Wardrobe
// ============================================================
//
// Player 1 is the game's own account (js/auth.js). Every other seat can sign
// in to its own House Tandem account with a device code (QR + 4-letter code,
// the same flow as the TV sign-in). A seat's session never touches Player 1's.
//
// Remembering: the account is saved against the controller's key. A serial key
// ('serial:…', the desktop app can read one) names the unit, so it is kept in
// localStorage and "this DualSense is Sam" carries over to the next launch.
// Any other key (a browser sees only vendor:product + slot) lasts the session.

import { API_BASE } from './config.js';

const STORE_KEY = 'tandemonium_seat_accounts';
const POLL_MS = 2000;

/** Is this pad key specific enough to remember across launches? */
export function rememberable(padKey) {
  return typeof padKey === 'string' && padKey.startsWith('serial:');
}

function tokenExp(token) {
  try { return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).exp || 0; } catch { return 0; }
}
const tokenValid = (t) => !!t && tokenExp(t) > Date.now() / 1000 + 60;

/**
 * @typedef {{ token: string, user: { id: number, name: string, avatar: string|null, identities: Record<string, {name: string, avatar: string}> } }} SeatAccount
 */

export class SeatAccounts {
  /**
   * @param {{ store?: Storage|null, fetchImpl?: typeof fetch, apiBase?: string }} [o]
   */
  constructor({ store = null, fetchImpl = null, apiBase = API_BASE } = {}) {
    this._store = store;
    this._fetch = fetchImpl || ((...a) => fetch(...a));
    this._api = apiBase;
    /** @type {Map<string, SeatAccount>} padKey → account (this session, plus remembered ones) */
    this._byPad = new Map();
    /** @type {Map<number, string>} seat number → pad key */
    this._seatPad = new Map();
    /** @type {Map<number, any>} seat number → device sign-in in progress */
    this._devices = new Map();
    this._listeners = [];
    this._load();
  }

  _load() {
    try {
      const raw = this._store && this._store.getItem(STORE_KEY);
      const data = raw ? JSON.parse(raw) : {};
      for (const [k, v] of Object.entries(data || {})) {
        if (rememberable(k) && v && tokenValid(v.token)) this._byPad.set(k, v);
      }
    } catch (e) { /* a bad store is an empty one */ }
  }

  _save() {
    if (!this._store) return;
    const out = {};
    for (const [k, v] of this._byPad) if (rememberable(k)) out[k] = v;
    try { this._store.setItem(STORE_KEY, JSON.stringify(out)); } catch (e) {}
  }

  /** @returns {() => void} unsubscribe */
  onChange(fn) { this._listeners.push(fn); return () => { this._listeners = this._listeners.filter((f) => f !== fn); }; }
  _emit(n) { for (const fn of this._listeners) { try { fn(n); } catch (e) {} } }

  /** Seat n is held by the controller with this key (the Wardrobe and seat screens call this). */
  bindSeat(n, padKey) {
    const before = this.get(n);
    if (padKey) this._seatPad.set(n, padKey); else this._seatPad.delete(n);
    if (before !== this.get(n)) this._emit(n);
  }

  /** @returns {SeatAccount|null} the account signed in on seat n, if its token is still good */
  get(n) {
    const key = this._seatPad.get(n);
    const acc = key ? this._byPad.get(key) : null;
    if (acc && !tokenValid(acc.token)) { this._byPad.delete(key); this._save(); return null; }
    return acc || null;
  }

  /** The account ids on seats 2–4 right now: {n: token} for the score submit. */
  tokens(seats) {
    const out = {};
    for (const n of seats) { const a = this.get(n); if (a) out[n] = a.token; }
    return out;
  }

  /** "Not me": forget seat n's account (and the controller's memory of it). */
  signOut(n) {
    this.cancel(n);
    const key = this._seatPad.get(n);
    if (key && this._byPad.delete(key)) { this._save(); this._emit(n); }
  }

  /** Is a sign-in for seat n in progress? Returns it ({ code, url, status }) or null. */
  pending(n) { return this._devices.get(n) || null; }

  cancel(n) {
    const dev = this._devices.get(n);
    if (!dev) return;
    dev.stopped = true;
    clearTimeout(dev.timer);
    this._devices.delete(n);
    this._emit(n);
  }

  /**
   * Start a device-code sign-in for seat n. Resolves { code, url } for the
   * QR; polling carries on and the account lands on the seat's controller.
   * Rejects with the server's message when Discord sign-in is unavailable.
   */
  async startSignIn(n) {
    const live = this._devices.get(n);
    if (live && live.expiresAt > Date.now() + 30000) return live;
    this.cancel(n);
    const res = await this._fetch(`${this._api}/auth/discord/begin`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'device' }),
    });
    const req = await res.json().catch(() => ({}));
    if (!res.ok || !req.id) throw new Error(req.error || 'Discord sign-in is unavailable');
    const dev = {
      n, id: req.id, secret: req.secret, url: req.url, code: req.code, status: 'pending', error: null,
      expiresAt: Date.now() + (req.expires_in || 600) * 1000, timer: 0, stopped: false,
    };
    this._devices.set(n, dev);
    const tick = async () => {
      if (dev.stopped) return;
      if (Date.now() > dev.expiresAt) { this._fail(dev, 'expired'); return; }
      try {
        const r = await this._fetch(`${this._api}/auth/poll`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: dev.id, secret: dev.secret }),
        });
        const data = await r.json().catch(() => ({}));
        if (dev.stopped) return;
        if (data.status === 'done' && data.token && data.user) {
          this._finish(dev, { token: data.token, user: data.user });
          return;
        }
        if (data.status === 'error' || data.status === 'expired') { this._fail(dev, data.error || data.status); return; }
        const status = data.status === 'confirming' ? 'confirming' : 'pending';
        if (status !== dev.status) { dev.status = status; this._emit(n); }
      } catch (e) { /* offline for a moment: keep polling */ }
      dev.timer = setTimeout(tick, POLL_MS);
    };
    dev.timer = setTimeout(tick, POLL_MS);
    this._emit(n);
    return dev;
  }

  _finish(dev, acc) {
    dev.stopped = true;
    this._devices.delete(dev.n);
    const key = this._seatPad.get(dev.n) || `seat:${dev.n}`;
    if (!this._seatPad.get(dev.n)) this._seatPad.set(dev.n, key);
    // One account on one seat: signing in on seat 3 as someone already on seat 2 moves them.
    for (const [k, v] of this._byPad) if (k !== key && v.user && v.user.id === acc.user.id) this._byPad.delete(k);
    this._byPad.set(key, acc);
    this._save();
    this._emit(dev.n);
  }

  _fail(dev, error) {
    dev.stopped = true;
    dev.status = 'error';
    dev.error = error;
    this._devices.delete(dev.n);
    this.lastError = { n: dev.n, error };
    this._emit(dev.n);
  }
}
