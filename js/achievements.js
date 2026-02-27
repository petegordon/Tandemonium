// ============================================================
// ACHIEVEMENTS — unlock conditions, persistence, toast display
// ============================================================

const ACHIEVEMENTS = [
  // Distance milestones
  { id: 'first_500m',   name: 'First 500m',      icon: '\uD83D\uDC5F', condition: s => s.distance >= 500 },  // 👟
  { id: 'first_km',     name: '1K Club',          icon: '\uD83C\uDFC5', condition: s => s.distance >= 1000 },   // 🏅
  { id: 'five_k',       name: '5K Champion',      icon: '\uD83C\uDFC6', condition: s => s.distance >= 5000 },   // 🏆

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

  // Perfect rides (no crashes)
  { id: 'perfect_1k',   name: 'Flawless 1K',       icon: '\uD83D\uDCAE', condition: s => s.finishedLevel && s.crashes === 0 && s.raceDistance >= 1000 },  // 💮
  { id: 'perfect_5k',   name: 'Untouchable',       icon: '\uD83D\uDC8E', condition: s => s.finishedLevel && s.crashes === 0 && s.raceDistance >= 5000 },  // 💎

  // Contribution
  { id: 'team_player',  name: 'Team Player',       icon: '\uD83E\uDD1C', condition: s => s.isMultiplayer && s.safePct >= 80 }, // 🤜
];

const STORAGE_KEY = 'tandemonium_achievements';

export class AchievementManager {
  constructor() {
    this._earned = new Map(); // id → { earnedAt, ... }
    this._newThisSession = []; // newly earned this session
    this._syncHighScore = 0; // consecutive seconds with offsetScore > 0.9
    this._load();
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

    if (newlyEarned.length > 0) this._save();
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

  mergeFromServer(serverAchievements) {
    if (!Array.isArray(serverAchievements)) return;
    for (const sa of serverAchievements) {
      if (!this._earned.has(sa.id)) {
        this._earned.set(sa.id, sa);
      }
    }
    this._save();
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

// Badge rendering around a PiP circle
export function updateBadgeDisplay(containerId, achievements) {
  const container = document.getElementById(containerId);
  if (!container) return;

  // Clear existing badges
  container.querySelectorAll('.pip-badge').forEach(el => el.remove());

  const earned = achievements.filter(a => a.earned !== false);
  const count = earned.length;
  if (count === 0) return;

  const angleStep = 360 / Math.max(count, 6); // at least 60° spacing
  earned.forEach((ach, i) => {
    const badge = document.createElement('div');
    badge.className = 'pip-badge';
    badge.textContent = ach.icon;
    badge.title = ach.name;
    badge.style.transform = 'rotate(' + (i * angleStep) + 'deg) translateX(48px) rotate(-' + (i * angleStep) + 'deg)';
    container.appendChild(badge);
  });
}
