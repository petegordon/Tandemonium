// ============================================================
// ACHIEVEMENTS — the manager: persistence, events, toasts, Steam
// ============================================================
//
// The 100 definitions, the lifetime stats and the pure rules live in
// js/achievement-defs.js (#401). This file keeps what touches the browser:
// localStorage, the economy-event listener, Steam, server sync, the toast and
// the badges — plus the thin readers that turn Game state into the plain
// objects the rules take, so game.js only holds one-line call sites.

import { API_BASE, TUNE } from './config.js';
import { getEditionRules } from './edition.js';
import { playDayKey } from './time-warp.js';   // #611 · the warped day while in time warp, else the real day
import { computeStreak, browserStore, STORAGE_KEY as DAILY_KEY } from './daily-ride.js';
import { STORAGE_KEY as RECORDS_KEY } from './records.js';
import { loadSave as loadSlingSave, STORAGE_KEY as SLING_KEY } from './slingshot.js';
import { WALLET_KEY, sanitizeWallet, canRebuild } from './wallet.js';
import {
  ACHIEVEMENTS, SECTIONS, STATS_VERSION,
  migrateStats, applyEvent, seedStats, RideTracker, versusResult, migrateEarned, foldBests, bestProgress, emptyStats } from './achievement-defs.js';
import {
  ACCOUNT_GAME, toAccountDelta, mergeAfterSync, baseFromAccount, baseAfterSend, cleanBase, emptyBase, hasCounters, tokenUser,
} from './account-stats.js';

export { ACHIEVEMENTS, SECTIONS };

const STORAGE_KEY = 'tandemonium_achievements';
const STATS_KEY = 'tandemonium_achievement_stats';
/** housetandem-web #37 · how much of each counter the account already has (js/account-stats.js). */
const STATS_BASE_KEY = 'tandemonium_achievement_stats_base';
/** After a stats change, wait this long for more before pushing (a ride's crashes, boosts, finish). */
const STATS_SYNC_DEBOUNCE_MS = 8000;
const ECONOMY_EVENT = 'tandemonium:economy';

export class AchievementManager {
  constructor() {
    this._earned = new Map(); // id → { earnedAt, ... }
    this._newThisSession = []; // newly earned this session
    this._syncHighScore = 0; // consecutive seconds with offsetScore > 0.9
    this._stats = migrateStats(null);
    /** The ride in progress (js/achievement-defs.js · RideTracker). */
    this.ride = new RideTracker();
    /** Called with each newly earned record (the game toasts it). */
    this.onEarned = null;
    this._demo = null;
    /**
     * #666 · this side is the demo riding in a full-game host's room: the
     * full-game achievements can be earned, and are HELD (kept here and on the
     * House Tandem account, never pushed to the demo's Steam app) until the
     * full game claims them (mergeFromServer + syncToSteam). The game sets
     * guestPassSource (true while in such a room); `guestPass = true` forces it.
     */
    this._guestPass = false;
    this.guestPassSource = null;
    this._versus = null;
    // Injected identity ({ getToken() }) — lets achievements push to the
    // backend without knowing about auth. Set via setIdentity(). (#318 Step 4)
    this._identity = null;
    this._load();
    this._loadStats();
    this._base = this._loadBase();
    this._statsSyncTimer = null;
    this._statsSync = null;      // the sync in flight (a promise)
    this._statsSent = null;      // the stats it was taken from
    this._beaconSent = null;     // stats a page-hide beacon sent while it was out (already counted)
  }

  /** The demo never awards the full-game-only achievements (defs `demo: false`). */
  get demo() {
    if (this._demo === null) {
      try { this._demo = !!getEditionRules().isDemo; } catch (e) { this._demo = false; }
    }
    return this._demo;
  }
  set demo(v) { this._demo = !!v; }

  /** #666 · is this side riding in a full-game host's room on the demo? */
  get guestPass() {
    if (this._guestPass) return true;
    try { return !!(this.guestPassSource && this.guestPassSource()); } catch (e) { return false; }
  }
  set guestPass(v) { this._guestPass = !!v; }

  /**
   * #666 · is `id` held on this build? The demo holds every full-game
   * achievement it has (earned in a full host's room, or pulled from the
   * account): they never go to the demo's Steam app.
   */
  isHeld(id) {
    if (!this.demo) return false;
    const def = ACHIEVEMENTS.find(a => a.id === id);
    return !def || !def.demo;
  }

  /** #666 · the earned ids this build holds (always [] on the full game). */
  getHeldIds() {
    return this.demo ? this.getEarnedIds().filter(id => this.isHeld(id)) : [];
  }

  /** The earned ids this build may put on its Steam profile (#666: not the held ones). */
  steamIds() {
    return this.getEarnedIds().filter(id => !this.isHeld(id));
  }

  /** Inject the identity provider used to authorize server sync. */
  setIdentity(identity) {
    this._identity = identity;
    return this;
  }

  /**
   * Push earned achievement IDs to the backend (D1). Uses the injected
   * identity's token; no-op if not logged in or nothing earned. This is the
   * achievements→server glue that used to live in auth.syncAchievements —
   * inverted so identity doesn't know achievements exist. (#318 Step 4)
   */
  async syncToServer() {
    const ids = this.getEarnedIds();
    const token = this._identity && this._identity.getToken && this._identity.getToken();
    if (!token || !ids || ids.length === 0) return null;
    try {
      const res = await fetch(`${API_BASE}/achievements/sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ achievements: ids }),
      });
      return res.ok ? res.json() : null;
    } catch (e) {
      return null;
    }
  }

  _load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        // #575: an earned todays_launch becomes daily_launch, written back once.
        const { list, changed } = migrateEarned(JSON.parse(raw));
        list.forEach(a => this._earned.set(a.id, a));
        if (changed) this._save();
      }
    } catch (e) {}
  }

  _save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...this._earned.values()]));
    } catch (e) {}
  }

  /**
   * v1 ({ cumulativeDistance }) and v2 both load; an old save is rewritten as
   * v2. m21: on that migration (or with no stats at all) the counters are
   * seeded from the saves the player already has, and anything those already
   * satisfy is granted (quietly: no toast is hooked up yet).
   */
  _loadStats() {
    let raw = null;
    try {
      const s = localStorage.getItem(STATS_KEY);
      raw = s ? JSON.parse(s) : null;
    } catch (e) {}
    this._stats = migrateStats(raw);
    if (raw && raw.v === STATS_VERSION) return;
    const saves = this._readSaves();
    if (!raw && !saves.any) return;
    this._stats = seedStats(this._stats, saves);
    this._saveStats();
    this._evaluate({});
  }

  /** The saves m21 seeds from (each null when absent or unreadable). */
  _readSaves() {
    const get = (k) => { try { const s = localStorage.getItem(k); return s ? JSON.parse(s) : null; } catch (e) { return null; } };
    const records = get(RECORDS_KEY), daily = get(DAILY_KEY), rawSling = get(SLING_KEY), rawWallet = get(WALLET_KEY);
    let sling = null, wallet = null;
    try { if (rawSling) sling = loadSlingSave(browserStore()); } catch (e) {}
    try { if (rawWallet) wallet = sanitizeWallet(rawWallet); } catch (e) {}
    return { records, daily, sling, wallet, any: !!(records || daily || sling || wallet) };
  }

  _saveStats() {
    try {
      localStorage.setItem(STATS_KEY, JSON.stringify(this._stats));
    } catch (e) {}
    this._scheduleStatsSync();
  }

  // ── Lifetime stats on the House Tandem account (housetandem-web #37) ──
  //
  // Signed in, every change is pushed (debounced) as a delta from the synced
  // baseline; the answer is the account's totals, which the device takes.
  // Sign-in = a sync (the device's unsynced counts are added once, then it
  // has the account's numbers); sign-out = a sync, then resetStats().

  _loadBase() {
    try { return cleanBase(JSON.parse(localStorage.getItem(STATS_BASE_KEY) || 'null')); } catch (e) { return emptyBase(); }
  }

  _saveBase() {
    try { localStorage.setItem(STATS_BASE_KEY, JSON.stringify(this._base)); } catch (e) {}
  }

  _token() {
    try { return (this._identity && this._identity.getToken && this._identity.getToken()) || null; } catch (e) { return null; }
  }

  _scheduleStatsSync() {
    if (!this._token() || typeof setTimeout === 'undefined') return;
    if (this._statsSyncTimer) clearTimeout(this._statsSyncTimer);
    this._statsSyncTimer = setTimeout(() => { this._statsSyncTimer = null; this.syncStats(); }, STATS_SYNC_DEBOUNCE_MS);
  }

  /**
   * Push this device's stats to the signed-in account and take the account's
   * back. Resolves { ok, newlyEarned }: newlyEarned are badges the merged
   * stats earn that this list didn't have, awarded quietly (no toast each;
   * the caller may show one summary). Signed out: { ok: false }.
   */
  async syncStats() {
    // One at a time: a call while one is out waits for it, then sends what's new since.
    if (this._statsSync) {
      try { await this._statsSync; } catch (e) {}
      return this.syncStats();
    }
    const token = this._token();
    const user = tokenUser(token);
    if (!token || !user) return { ok: false, newlyEarned: [] };
    if (this._statsSyncTimer) { clearTimeout(this._statsSyncTimer); this._statsSyncTimer = null; }
    this._statsSync = (async () => {
      // Another account's numbers (it signed in here without a sign-out): not this player's to add.
      // base.user null = counted signed out since the last sign-out: this sign-in claims them.
      if (this._base.user && this._base.user !== user) this._resetDeviceStats(user);
      const sent = migrateStats(this._stats);
      const delta = toAccountDelta(sent, this._base);
      this._statsSent = sent;
      this._beaconSent = null;
      let res;
      try {
        res = await fetch(`${API_BASE}/games/${ACCOUNT_GAME}/sync`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({ delta }),
        });
      } catch (e) { return { ok: false, newlyEarned: [] }; }
      if (!res || !res.ok) return { ok: false, newlyEarned: [] };
      let data = null;
      try { data = await res.json(); } catch (e) {}
      if (!data || !data.stats) return { ok: false, newlyEarned: [] };
      if (this._token() !== token) return { ok: false, newlyEarned: [] };   // signed out or switched meanwhile
      // A beacon that went out meanwhile already sent the counts up to its snapshot.
      this._stats = mergeAfterSync(data.stats, this._stats, this._beaconSent || sent);
      this._base = baseFromAccount(data.stats, user);
      this._saveBase();
      try { localStorage.setItem(STATS_KEY, JSON.stringify(this._stats)); } catch (e) {}
      const newlyEarned = this._evaluate({}, { quiet: true });
      if (newlyEarned.length) this.syncToServer();
      return { ok: true, newlyEarned };
    })();
    try {
      return await this._statsSync;
    } finally {
      this._statsSync = null;
      this._statsSent = null;
      this._beaconSent = null;
    }
  }

  /**
   * The page is going away: send what's unsynced without waiting for an
   * answer (a beacon), and count it as sent. A lost beacon loses a little;
   * it never counts twice.
   */
  flushStatsBeacon() {
    const token = this._token();
    const user = tokenUser(token);
    if (!token || !user || (this._base.user && this._base.user !== user)) return false;
    const sent = migrateStats(this._stats);
    // A sync is out: its counts are on their way, so the beacon sends only what came after.
    const from = this._statsSync && this._statsSent ? baseAfterSend(this._base, this._statsSent) : this._base;
    const delta = toAccountDelta(sent, from);
    if (!hasCounters(delta) && !this._statsSyncTimer) return false;
    if (this._statsSyncTimer) { clearTimeout(this._statsSyncTimer); this._statsSyncTimer = null; }
    const url = `${API_BASE}/games/${ACCOUNT_GAME}/sync`;
    const body = JSON.stringify({ token, delta });
    let ok = false;
    try {
      ok = typeof navigator !== 'undefined' && !!navigator.sendBeacon && navigator.sendBeacon(url, new Blob([body], { type: 'text/plain' }));
    } catch (e) {}
    if (!ok) {
      try { fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body, keepalive: true }).catch(() => {}); ok = true; } catch (e) {}
    }
    if (ok) {
      this._base = { ...baseAfterSend(from, sent), user };
      if (this._statsSync) this._beaconSent = sent;
      this._saveBase();
    }
    return ok;
  }

  _resetDeviceStats(user = null) {
    this._stats = emptyStats();
    this._base = emptyBase(user);
    try { localStorage.setItem(STATS_KEY, JSON.stringify(this._stats)); } catch (e) {}
    this._saveBase();
  }

  /**
   * Sign-out: the device starts again from empty stats (written as an empty
   * v2, so the m21 seeding doesn't refill them from the device's other saves).
   * Call after syncStats() pushed them to the account.
   */
  resetStats() {
    if (this._statsSyncTimer) { clearTimeout(this._statsSyncTimer); this._statsSyncTimer = null; }
    this._resetDeviceStats(null);
  }

  /** Re-read earned achievements and stats from localStorage (e.g. after a ride). */
  reload() {
    this._earned = new Map();
    this._load();
    this._loadStats();
  }

  /** Lifetime stats (a copy). */
  getStats() {
    return { ...this._stats };
  }

  /** Kept for old callers: distance now arrives through the 'ride' event. */
  addCompletedDistance(distance) {
    this._stats = { ...this._stats, cumulativeDistance: this._stats.cumulativeDistance + Math.max(0, distance || 0) };
    this._saveStats();
  }

  getCumulativeDistance() {
    return this._stats.cumulativeDistance;
  }

  /** Per-frame / finish check against the state of the moment. */
  check(state) {
    // Track sync duration for Perfect Sync
    if (state.offsetScore > 0.9) {
      this._syncHighScore += state.dt || 0;
    } else {
      this._syncHighScore = 0;
    }
    state.syncDuration = this._syncHighScore;
    return this._evaluate(state);
  }

  /** Fold an event into the lifetime stats, save, and check. */
  record(type, detail = {}) {
    this._stats = applyEvent(this._stats, type, detail, playDayKey());
    this._saveStats();
    return this._evaluate({});
  }

  /**
   * `quiet`: award without the per-badge toast (onEarned). After a sign-in
   * brings the account's stats, the caller shows one summary instead.
   */
  _evaluate(state, { quiet = false } = {}) {
    const newlyEarned = [];
    const demo = this.demo;
    const guestPass = demo && this.guestPass;   // #666: once per check, not per achievement
    // Best-so-far values (top speed, longest steady stretch, …): kept for the lobby's progress (Pete 2026-11-07).
    // Saved when a whole unit improves or at a finish, not every frame.
    const folded = foldBests(this._stats, state, new Set(this._earned.keys()));
    if (folded !== this._stats) {
      const prev = this._stats.bests;
      this._stats = folded;
      const crossed = Object.keys(folded.bests).some(k => Math.floor(folded.bests[k]) > Math.floor(prev[k] || 0));
      if (crossed || (state && state.finishedLevel)) this._saveStats();
    }
    for (const ach of ACHIEVEMENTS) {
      if (this._earned.has(ach.id)) continue;
      if (demo && !ach.demo && !guestPass) continue;   // #666: a full host's room opens them (held)
      try {
        if (ach.condition(state, this._stats)) {
          const record = { id: ach.id, name: ach.name, icon: ach.icon, earnedAt: Date.now() };
          this._earned.set(ach.id, record);
          if (!quiet) this._newThisSession.push(record);
          newlyEarned.push(record);
        }
      } catch (e) {}
    }

    if (newlyEarned.length > 0) {
      this._save();
      // Mirror newly earned achievements to Steam (#666: never a held one to the demo's app)
      if (typeof window !== 'undefined' && window.steam) {
        for (const a of newlyEarned) {
          if (this.isHeld(a.id)) continue;
          window.steam.activateAchievement(a.id.toUpperCase());
        }
      }
      if (this.onEarned && !quiet) {
        for (const a of newlyEarned) {
          try { this.onEarned(a); } catch (e) {}
        }
      }
    }
    return newlyEarned;
  }

  // ── Game glue: plain readers so game.js stays one-liners ──────────────

  /** Listen for the economy events (js/economy-mode.js · _economyEvent). Once, from the game. */
  listen(target = (typeof window !== 'undefined' ? window : null)) {
    if (!target || this._listening) return;
    this._listening = true;
    target.addEventListener(ECONOMY_EVENT, (e) => {
      const d = (e && e.detail) || {};
      if (!d.type) return;
      if (d.type === 'upgrade') {
        let allMaxed = false;
        try { allMaxed = canRebuild(sanitizeWallet(JSON.parse(localStorage.getItem(WALLET_KEY) || 'null'))); } catch (_) {}
        this.record('upgrade', { ...d, allMaxed });
      } else {
        this.record(d.type, d);
      }
    });
  }

  /** A good pedal stroke. Writes once, the first time. */
  notePedal() {
    if (!this._stats.pedalled) this.record('pedal');
  }

  /** A crash, anywhere. Feeds the ride (False Start, So Close, Weathered) and the lifetime count. */
  crash(cause, { ref, distance, raceDistance } = {}) {
    const r = this.ride.crash({ ref, cause, distance, raceDistance });
    return this.record('crash', r);
  }

  /** A gust starts (true) or ends (false). */
  gust(starting) {
    // The ride tracker has to see the gust start too, or no gust is ever "ridden out" (Weathered).
    if (starting) { this.ride.gust(true); return this.record('gust'); }
    return this.ride.gust(false) ? this.record('weathered') : [];
  }

  /**
   * The per-ride numbers for this frame, from the game: off-road time, the
   * centre strip, boost chains, steady hands. Returns them for the state.
   */
  rideFrame(dt, game) {
    const b = game.bike;
    if (!b) return {};
    const crashThreshold = TUNE.crashThreshold || 1.35;
    const dangerOnset = TUNE.dangerOnset || 0.55;
    const shaking = Math.abs(b.lean || 0) / crashThreshold > dangerOnset || (b._edgeIntensity || 0) > 0;
    return this.ride.frame(dt, {
      ref: game.raceManager || null,
      playing: game.state === 'playing',
      fallen: !!b.fallen,
      speed: b.speed || 0,
      lateralOffset: b._lateralOffset || 0,
      onCenterStrip: !!b.onCenterStrip,
      boosting: (b.boostTimer || 0) > 0,
      shaking,
      helped: (() => { try { const h = game._helpFlags ? game._helpFlags() : null; return !!(h && (h.helped || h.skipped)); } catch (e) { return false; } })(),
    });
  }

  /** The finish: the ride's numbers + the lifetime counters it moves. */
  finish(state) {
    const ride = this.ride.ref === state.ref ? this.ride.snapshot() : {};
    const s = { ...ride, ...state };
    s.crashes = Math.max(s.crashes || 0, ride.rideCrashes || 0);
    this.lastFinishState = s;   // #612: a signed-in seat's achievements read the same finish
    this._stats = applyEvent(this._stats, 'finish', s, playDayKey());
    this._saveStats();
    return this._evaluate(s);
  }

  /** Versus, each frame: who led when the leader crossed halfway. */
  versusFrame(rigs, raceDistance) {
    if (!rigs || !rigs.length) return;
    const key = rigs[0].raceManager;
    if (!this._versus || this._versus.key !== key) this._versus = { key, halfLeader: null };
    if (this._versus.halfLeader || !(raceDistance > 0)) return;
    let lead = rigs[0];
    for (const r of rigs) if (r.bike.distanceTraveled > lead.bike.distanceTraveled) lead = r;
    if (lead.bike.distanceTraveled >= raceDistance / 2) this._versus.halfLeader = lead.id;
  }

  /** Versus: the race is won. */
  versusFinish(winner, loser, raceDistance) {
    if (!winner || !loser) return [];
    const team = r => ({ id: r.id, members: r.members, distance: r.bike.distanceTraveled, speed: r.bike.speed, crashes: r.crashCount || 0 });
    const halfLeader = this._versus && this._versus.key === winner.raceManager ? this._versus.halfLeader
      : (this._versus && this._versus.key === loser.raceManager ? this._versus.halfLeader : null);
    const res = versusResult({ winner: team(winner), loser: team(loser), raceDistance, halfLeader });
    this._versus = null;
    return this.record('versus', res);
  }

  getEarned() {
    // Pull icon from current definitions (not stale localStorage)
    const defMap = new Map(ACHIEVEMENTS.map(a => [a.id, a]));
    return [...this._earned.values()].map(e => {
      const def = defMap.get(e.id);
      return def ? { ...e, icon: def.icon } : e;
    });
  }

  getEarnedIds() {
    return [...this._earned.keys()];
  }

  getNewThisSession() {
    return this._newThisSession;
  }

  /**
   * What the lobby's badge screen lists: all 100 achievements. Hidden ones
   * read "???" until earned; counters
   * carry [current, goal] progress; demoLocked marks full-game-only rows.
   */
  getAllDefinitions() {
    const demo = this.demo;
    // The day-streak badges read the streak held today (m6).
    let live = { dailyStreak: 0, wallet: null };
    try { live.dailyStreak = computeStreak(browserStore(), playDayKey()).current; } catch (e) {}
    try { const w = localStorage.getItem(WALLET_KEY); live.wallet = w ? sanitizeWallet(JSON.parse(w)) : null; } catch (e) {}
    return ACHIEVEMENTS
      .map((a, i) => {
        const record = this._earned.get(a.id);
        const earned = !!record;
        const secret = a.hidden && !earned;
        let progress = null;
        if (!earned && !secret && a.progress) {
          try { progress = a.progress(this._stats, live); } catch (e) { progress = null; }
        } else if (!earned && !secret && a.best) {
          progress = bestProgress(a, this._stats);
        }
        const bestAt = a.best && this._stats.bestsAt ? this._stats.bestsAt[a.id] || null : null;
        return {
          id: a.id,
          n: i + 1,                                   // #540: "No. 12 of 100" on the detail card
          section: a.section,
          name: secret ? '???' : a.name,
          icon: secret ? '❔' : a.icon,
          desc: secret ? 'A hidden achievement' : a.desc,
          earned,
          earnedAt: record && record.earnedAt ? record.earnedAt : null,   // ms since epoch, or null
          hidden: !!a.hidden,
          secret,
          progress,
          unit: a.unit || '',
          demoLocked: demo && !a.demo,
          held: earned && demo && !a.demo,             // #666: earned with a friend, claimed by the full game
          medal: a.medal || null,
          bestAt,                                      // { level, at }: where and when the best-so-far was set                      // { level, rank }: the detail card prints the live times
        };
      });
  }

  /** getAllDefinitions grouped by section, in section order (empty sections dropped). */
  getSections() {
    const defs = this.getAllDefinitions();
    return SECTIONS
      .map(sec => ({ ...sec, items: defs.filter(d => d.section === sec.id) }))
      .filter(sec => sec.items.length > 0);
  }

  /**
   * Push all earned achievements to Steam profile (catches web/mobile unlocks).
   * #666: the demo pushes only its own 20; the full game pushes everything,
   * which is how a guest's held achievements reach Steam once they buy.
   */
  async syncToSteam() {
    if (!window.steam) return;
    try {
      for (const id of this.steamIds()) {
        await window.steam.activateAchievement(id.toUpperCase());
      }
      await window.steam.storeStats();
    } catch (e) {
      console.warn('Failed to sync achievements to Steam:', e);
    }
  }

  mergeFromServer(serverAchievements) {
    if (!Array.isArray(serverAchievements)) return;
    for (const sa of serverAchievements) {
      if (!this._earned.has(sa.id)) {
        this._earned.set(sa.id, sa);
      }
    }
    this._save();
  }

  clear() {
    this._earned.clear();
    this._newThisSession = [];
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
  }
}

// Toast notification
let _toastContainer = null;

/** Unlocked-this-ride badges shown with their names; beyond this the end screen shows icons only. */
export const END_LIST_NAMES_MAX = 10;

export function showAchievementToast(achievement) {
  if (!_toastContainer) {
    _toastContainer = document.getElementById('achievement-toast-container');
    if (!_toastContainer) {
      _toastContainer = document.createElement('div');
      _toastContainer.id = 'achievement-toast-container';
      document.body.appendChild(_toastContainer);
    }
  }

  // A kit <uf-achievement state="new"> (#428). While an end-of-ride sheet is
  // up, it joins that sheet's "unlocked this ride" list instead of floating
  // over the headline.
  const badge = /** @type {any} */ (document.createElement('uf-achievement'));
  Object.assign(badge, { icon: achievement.icon || '🏅', name: achievement.name || '', state: 'new', size: 'sm' });
  const endList = document.querySelector('#victory-overlay.visible #victory-unlocked, #gameover-overlay:not([style*="none"]) #gameover-unlocked');
  if (endList) {
    endList.hidden = false;
    badge.title = achievement.name || '';
    endList.appendChild(badge);
    // Pete (Steam playtest 2026-11-07): more than 10 unlocked in one ride shows icons only (the names in tooltips)
    endList.classList.toggle('icons-only', endList.querySelectorAll('uf-achievement').length > END_LIST_NAMES_MAX);
    return;
  }
  const toast = document.createElement('div');
  toast.className = 'achievement-toast';
  toast.appendChild(badge);

  _toastContainer.appendChild(toast);

  // Animate in
  requestAnimationFrame(() => toast.classList.add('show'));

  // Remove after 3s
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 400);
  }, 3000);
}

// Info toast (blue styling, for system messages like performance mode)
export function showInfoToast(icon, title, subtitle) {
  if (!_toastContainer) {
    _toastContainer = document.getElementById('achievement-toast-container');
    if (!_toastContainer) {
      _toastContainer = document.createElement('div');
      _toastContainer.id = 'achievement-toast-container';
      document.body.appendChild(_toastContainer);
    }
  }

  const toast = document.createElement('div');
  toast.className = 'info-toast';
  toast.innerHTML = '<span class="toast-icon">' + icon + '</span>' +
    '<div class="toast-text"><strong>' + title + '</strong><br><small>' + subtitle + '</small></div>';

  _toastContainer.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));

  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 400);
  }, 4000);
}

// Badge rendering around a PiP
// shape: 'rect' to trace rectangle perimeter (TV/Monitor room), default circular
export function updateBadgeDisplay(containerId, achievements, shape) {
  const container = document.getElementById(containerId);
  if (!container) return;

  // Clear existing badges
  container.querySelectorAll('.pip-badge').forEach(el => el.remove());

  const earned = achievements.filter(a => a.earned !== false);
  const count = earned.length;
  if (count === 0) return;

  const spacing = Math.max(count, 6);

  if (shape === 'rect') {
    // Arrange badges along the rectangle perimeter
    const w = container.offsetWidth || 220;
    const h = container.offsetHeight || 280;
    const perimeter = 2 * (w + h);
    earned.forEach((ach, i) => {
      const badge = document.createElement('div');
      badge.className = 'pip-badge';
      badge.textContent = ach.icon;
      badge.title = ach.name;
      const dist = (i / spacing) * perimeter;
      let x, y;
      if (dist < w) {
        x = dist; y = 0;
      } else if (dist < w + h) {
        x = w; y = dist - w;
      } else if (dist < 2 * w + h) {
        x = w - (dist - w - h); y = h;
      } else {
        x = 0; y = h - (dist - 2 * w - h);
      }
      badge.style.transform = 'translate(' + (x - w / 2) + 'px, ' + (y - h / 2) + 'px)';
      container.appendChild(badge);
    });
  } else {
    // Circular arrangement (mobile / non-lobby)
    const angleStep = 360 / spacing;
    earned.forEach((ach, i) => {
      const badge = document.createElement('div');
      badge.className = 'pip-badge';
      badge.textContent = ach.icon;
      badge.title = ach.name;
      badge.style.transform = 'rotate(' + (i * angleStep) + 'deg) translateX(48px) rotate(-' + (i * angleStep) + 'deg)';
      container.appendChild(badge);
    });
  }
}
