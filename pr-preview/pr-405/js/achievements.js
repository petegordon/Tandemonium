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
import { dailyKey } from './daily-seed.js';
import { computeStreak, browserStore, STORAGE_KEY as DAILY_KEY } from './daily-ride.js';
import { STORAGE_KEY as RECORDS_KEY } from './records.js';
import { loadSave as loadSlingSave, STORAGE_KEY as SLING_KEY } from './slingshot.js';
import { WALLET_KEY, sanitizeWallet, canRebuild } from './wallet.js';
import {
  ACHIEVEMENTS, RETIRED_IDS, SECTIONS, STATS_VERSION,
  migrateStats, applyEvent, seedStats, RideTracker, versusResult,
} from './achievement-defs.js';

export { ACHIEVEMENTS, RETIRED_IDS, SECTIONS };

const STORAGE_KEY = 'tandemonium_achievements';
const STATS_KEY = 'tandemonium_achievement_stats';
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
    this._versus = null;
    // Injected identity ({ getToken() }) — lets achievements push to the
    // backend without knowing about auth. Set via setIdentity(). (#318 Step 4)
    this._identity = null;
    this._load();
    this._loadStats();
  }

  /** The demo never awards the full-game-only achievements (defs `demo: false`). */
  get demo() {
    if (this._demo === null) {
      try { this._demo = !!getEditionRules().isDemo; } catch (e) { this._demo = false; }
    }
    return this._demo;
  }
  set demo(v) { this._demo = !!v; }

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
        const arr = JSON.parse(raw);
        arr.forEach(a => this._earned.set(a.id, a));
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
    this._stats = applyEvent(this._stats, type, detail, dailyKey());
    this._saveStats();
    return this._evaluate({});
  }

  _evaluate(state) {
    const newlyEarned = [];
    const demo = this.demo;
    for (const ach of ACHIEVEMENTS) {
      if (this._earned.has(ach.id)) continue;
      if (demo && !ach.demo) continue;
      try {
        if (ach.condition(state, this._stats)) {
          const record = { id: ach.id, name: ach.name, icon: ach.icon, earnedAt: Date.now() };
          this._earned.set(ach.id, record);
          this._newThisSession.push(record);
          newlyEarned.push(record);
        }
      } catch (e) {}
    }

    if (newlyEarned.length > 0) {
      this._save();
      // Mirror newly earned achievements to Steam
      if (typeof window !== 'undefined' && window.steam) {
        for (const a of newlyEarned) {
          window.steam.activateAchievement(a.id.toUpperCase());
        }
      }
      if (this.onEarned) {
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
    if (starting) return this.record('gust');
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
      assistOn: (game._assistWeight || 0) > 0,
    });
  }

  /** The finish: the ride's numbers + the lifetime counters it moves. */
  finish(state) {
    const ride = this.ride.ref === state.ref ? this.ride.snapshot() : {};
    const s = { ...ride, ...state };
    s.crashes = Math.max(s.crashes || 0, ride.rideCrashes || 0);
    this._stats = applyEvent(this._stats, 'finish', s, dailyKey());
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
    const team = r => ({ id: r.id, members: r.members, distance: r.bike.distanceTraveled, speed: r.bike.speed });
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
   * What the lobby's badge screen lists: the 93 visible achievements (the
   * retired colours never show). Hidden ones read "???" until earned; counters
   * carry [current, goal] progress; demoLocked marks full-game-only rows.
   */
  getAllDefinitions() {
    const demo = this.demo;
    // The day-streak badges read the streak held today (m6).
    let live = { dailyStreak: 0 };
    try { live = { dailyStreak: computeStreak(browserStore(), dailyKey()).current }; } catch (e) {}
    return ACHIEVEMENTS
      .filter(a => !RETIRED_IDS.has(a.id))
      .map(a => {
        const earned = this._earned.has(a.id);
        const secret = a.hidden && !earned;
        let progress = null;
        if (!earned && !secret && a.progress) {
          try { progress = a.progress(this._stats, live); } catch (e) { progress = null; }
        }
        return {
          id: a.id,
          section: a.section,
          name: secret ? '???' : a.name,
          icon: secret ? '❔' : a.icon,
          desc: secret ? 'A hidden achievement' : a.desc,
          earned,
          hidden: !!a.hidden,
          secret,
          retired: false,
          progress,
          unit: a.unit || '',
          demoLocked: demo && !a.demo,
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

  /** Push all earned achievements to Steam profile (catches web/mobile unlocks). */
  async syncToSteam() {
    if (!window.steam) return;
    try {
      for (const id of this._earned.keys()) {
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

export function showAchievementToast(achievement) {
  if (!_toastContainer) {
    _toastContainer = document.getElementById('achievement-toast-container');
    if (!_toastContainer) {
      _toastContainer = document.createElement('div');
      _toastContainer.id = 'achievement-toast-container';
      document.body.appendChild(_toastContainer);
    }
  }

  const toast = document.createElement('div');
  toast.className = 'achievement-toast';
  toast.innerHTML = '<span class="toast-icon">' + achievement.icon + '</span>' +
    '<div class="toast-text"><strong>' + achievement.name + '</strong><br><small>Achievement Unlocked!</small></div>';

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
