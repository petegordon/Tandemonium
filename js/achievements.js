// ============================================================
// ACHIEVEMENTS — unlock conditions, persistence, toast display
// ============================================================

const ACHIEVEMENTS = [
  // Distance milestones (cumulative across completed rides)
  { id: 'first_500m',   name: 'First 500m',      icon: '\uD83D\uDC5F', condition: s => s.cumulativeDistance >= 500 },  // 👟
  { id: 'first_km',     name: '1K Club',          icon: '\uD83C\uDFC5', condition: s => s.cumulativeDistance >= 1000 },   // 🏅
  { id: 'five_k',       name: '5K Champion',      icon: '\uD83C\uDFC6', condition: s => s.cumulativeDistance >= 5000 },   // 🏆

  // Speed
  { id: 'speed_demon',  name: 'Speed Demon',      icon: '\u26A1',       condition: s => s.speed >= 13.9 },      // ⚡ (50 km/h)

  // Sync (multiplayer)
  { id: 'perfect_sync', name: 'Perfect Sync',     icon: '\uD83E\uDD1D', condition: s => s.offsetScore > 0.9 && s.syncDuration >= 10 }, // 🤝

  // Collection
  { id: 'collector',    name: 'Collector',         icon: '\uD83C\uDF1F', condition: s => s.collectibles >= 10 }, // 🌟
  { id: 'hoarder',      name: 'Hoarder',           icon: '\uD83D\uDC51', condition: s => s.collectibles > 0 && s.collectibles >= s.totalCollectibles }, // 👑

  // Finish levels
  { id: 'home_sweet',   name: "Home Sweet Home",   icon: '\uD83C\uDFE0', condition: s => s.finishedLevel === 'grandma' }, // 🏠
  { id: 'royal',        name: 'Royal Arrival',     icon: '\uD83C\uDFF0', condition: s => s.finishedLevel === 'castle' },   // 🏰

  // Per-bike Grandma's House achievements
  { id: 'grandma_default',  name: "Grandma's Classic",     icon: '🚲', condition: s => s.finishedLevel === 'grandma' && s.bikeKey === 'default' },
  { id: 'grandma_orange',   name: 'Marmalade Delivery',    icon: '🍊', condition: s => s.finishedLevel === 'grandma' && s.bikeKey === 'bike_orange' },
  { id: 'grandma_magenta',  name: 'Berry Special Visit',   icon: '🫐', condition: s => s.finishedLevel === 'grandma' && s.bikeKey === 'bike_magenta' },
  { id: 'grandma_red',      name: 'Cherry on Top',         icon: '🍒', condition: s => s.finishedLevel === 'grandma' && s.bikeKey === 'bike_red' },
  { id: 'grandma_blue',     name: "Ocean to Grandma's",    icon: '🌊', condition: s => s.finishedLevel === 'grandma' && s.bikeKey === 'bike_blue' },
  { id: 'grandma_green',    name: 'Jungle Express',        icon: '🌿', condition: s => s.finishedLevel === 'grandma' && s.bikeKey === 'bike_green' },
  { id: 'grandma_yellow',   name: 'Banana Delivery',       icon: '🍌', condition: s => s.finishedLevel === 'grandma' && s.bikeKey === 'bike_yellow' },

  // Perfect rides (no crashes, no checkpoint restarts)
  { id: 'perfect_1k',   name: 'Flawless',           icon: '\uD83D\uDCAE', condition: s => s.finishedLevel === 'grandma' && s.crashes === 0 && s.restarts === 0 },  // 💮
  { id: 'perfect_5k',   name: 'Untouchable',        icon: '\uD83D\uDC8E', condition: s => s.finishedLevel === 'castle' && s.crashes === 0 && s.restarts === 0 },   // 💎

  // Contribution
  { id: 'team_player',  name: 'Team Player',       icon: '\uD83E\uDD1C', condition: s => s.isMultiplayer && s.safePct >= 80 }, // 🤜
];

const STORAGE_KEY = 'tandemonium_achievements';
const STATS_KEY = 'tandemonium_achievement_stats';

export class AchievementManager {
  constructor() {
    this._earned = new Map(); // id → { earnedAt, ... }
    this._newThisSession = []; // newly earned this session
    this._syncHighScore = 0; // consecutive seconds with offsetScore > 0.9
    this._cumulativeDistance = 0;
    this._load();
    this._loadStats();
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

  _loadStats() {
    try {
      const raw = localStorage.getItem(STATS_KEY);
      if (raw) {
        const data = JSON.parse(raw);
        this._cumulativeDistance = data.cumulativeDistance || 0;
      }
    } catch (e) {}
  }

  _saveStats() {
    try {
      localStorage.setItem(STATS_KEY, JSON.stringify({
        cumulativeDistance: this._cumulativeDistance,
      }));
    } catch (e) {}
  }

  /** Re-read earned achievements from localStorage (e.g. after a ride). */
  reload() {
    this._earned = new Map();
    this._load();
  }

  /** Record distance from a completed ride. */
  addCompletedDistance(distance) {
    this._cumulativeDistance += distance;
    this._saveStats();
  }

  getCumulativeDistance() {
    return this._cumulativeDistance;
  }

  check(state) {
    const newlyEarned = [];

    // Track sync duration for Perfect Sync
    if (state.offsetScore > 0.9) {
      this._syncHighScore += state.dt || 0;
    } else {
      this._syncHighScore = 0;
    }
    state.syncDuration = this._syncHighScore;

    for (const ach of ACHIEVEMENTS) {
      if (this._earned.has(ach.id)) continue;
      try {
        if (ach.condition(state)) {
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
      if (window.steam) {
        for (const a of newlyEarned) {
          window.steam.activateAchievement(a.id.toUpperCase());
        }
      }
    }
    return newlyEarned;
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

  getAllDefinitions() {
    return ACHIEVEMENTS.map(a => ({
      id: a.id,
      name: a.name,
      icon: a.icon,
      earned: this._earned.has(a.id)
    }));
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
