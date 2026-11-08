// @ts-check
// ============================================================
// SEAT ACHIEVEMENTS (#612 item 5) — a signed-in Player 2 earns their own
// ============================================================
//
// Player 1's achievements come from the lifetime stats this device keeps for
// them (js/achievements.js). A signed-in seat gets the same thing, per account:
// its own lifetime stats on this device, and the earned list its account
// already has on the server (so nothing is awarded twice). Each shared ride
// they finish folds into their stats, and the achievements it newly meets go
// up with the ride's score submit under their own sign-in.
//
// The seat sees the ride's finish (time, medal, crashes, the pair, the
// partner); the per-frame events only Player 1's tracker hears (each pedal,
// boost, gust) are summarised: finishing a ride means they pedalled.

import { ACHIEVEMENTS, emptyStats, migrateStats, applyEvent } from './achievement-defs.js';

const STORE_KEY = 'tandemonium_seat_achievements';

export class SeatAchievements {
  /** @param {{ store?: Storage|null }} [o] */
  constructor({ store = null } = {}) {
    this._store = store;
  }

  _read() {
    try { const raw = this._store && this._store.getItem(STORE_KEY); return raw ? JSON.parse(raw) || {} : {}; } catch (e) { return {}; }
  }

  _write(all) {
    try { if (this._store) this._store.setItem(STORE_KEY, JSON.stringify(all)); } catch (e) {}
  }

  _entry(all, userId) {
    const k = String(userId);
    const e = all[k] && typeof all[k] === 'object' ? all[k] : {};
    let stats;
    try { stats = e.stats ? migrateStats(e.stats) : emptyStats(); } catch (err) { stats = emptyStats(); }
    return { stats, earned: Array.isArray(e.earned) ? e.earned : [] };
  }

  /** What the account already has on the server (from /me with the seat's token). */
  mergeEarned(userId, ids) {
    if (!userId || !Array.isArray(ids)) return;
    const all = this._read();
    const e = this._entry(all, userId);
    e.earned = [...new Set([...e.earned, ...ids])];
    all[String(userId)] = e;
    this._write(all);
  }

  /** The ids this account has earned (that this device knows of). */
  earned(userId) { return this._entry(this._read(), userId).earned; }

  /**
   * The seat finished a ride: fold it into their stats and return the
   * achievements it newly earns, as [{ id, name, icon, desc }].
   * @param {number|string} userId
   * @param {any} state the ride's finish state (the one Player 1's manager saw)
   * @param {{ today?: string|null, demo?: boolean }} [o]
   */
  finish(userId, state, { today = null, demo = false } = {}) {
    if (!userId || !state) return [];
    const all = this._read();
    const e = this._entry(all, userId);
    let L = applyEvent(e.stats, 'pedal', {}, today);
    for (let i = 0; i < Math.min(50, Math.max(0, Math.floor(Number(state.crashes) || 0))); i++) L = applyEvent(L, 'crash', {}, today);
    L = applyEvent(L, 'finish', state, today);
    const have = new Set(e.earned);
    const fresh = [];
    for (const a of ACHIEVEMENTS) {
      if (have.has(a.id)) continue;
      if (demo && !a.demo) continue;
      try {
        if (a.condition(state, L)) { fresh.push({ id: a.id, name: a.name, icon: a.icon, desc: a.desc }); have.add(a.id); }
      } catch (err) { /* a condition that needs a frame field: not earned */ }
    }
    all[String(userId)] = { stats: L, earned: [...have] };
    this._write(all);
    return fresh;
  }
}
