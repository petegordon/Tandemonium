// ============================================================
// AUTH — Google sign-in + leaderboard API client
// ============================================================

const STORAGE_TOKEN = 'tandemonium_auth_token';
const STORAGE_USER = 'tandemonium_auth_user';

export class AuthManager {
  constructor(apiBase) {
    this.apiBase = apiBase || '';
    this.token = null;
    this.user = null;
    this._load();

    // Listen for auth callback from popup
    window.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'auth') {
        this.token = e.data.token;
        this.user = e.data.user;
        this._save();
        if (this._onLoginCallback) this._onLoginCallback(this.user);
      }
    });
  }

  _load() {
    try {
      this.token = localStorage.getItem(STORAGE_TOKEN);
      const userRaw = localStorage.getItem(STORAGE_USER);
      if (userRaw) this.user = JSON.parse(userRaw);
    } catch (e) {}
  }

  _save() {
    try {
      if (this.token) localStorage.setItem(STORAGE_TOKEN, this.token);
      if (this.user) localStorage.setItem(STORAGE_USER, JSON.stringify(this.user));
    } catch (e) {}
  }

  isLoggedIn() {
    return !!this.token && !!this.user;
  }

  getUser() {
    return this.user;
  }

  onLogin(callback) {
    this._onLoginCallback = callback;
  }

  login(provider = 'google') {
    const url = this.apiBase + '/auth/' + provider;
    window.open(url, 'auth', 'width=500,height=600,popup=yes');
  }

  logout() {
    this.token = null;
    this.user = null;
    try {
      localStorage.removeItem(STORAGE_TOKEN);
      localStorage.removeItem(STORAGE_USER);
    } catch (e) {}
  }

  async submitScore(data) {
    if (!this.token) return null;
    const res = await fetch(this.apiBase + '/score', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + this.token
      },
      body: JSON.stringify(data)
    });
    if (res.status === 401) { this.logout(); return null; }
    return res.json();
  }

  async getLeaderboard(levelId, scope = 'global', limit = 20) {
    const params = new URLSearchParams({ level: levelId, scope, limit });
    const headers = {};
    if (this.token) headers['Authorization'] = 'Bearer ' + this.token;
    const res = await fetch(this.apiBase + '/leaderboard?' + params, { headers });
    return res.json();
  }

  async getMe() {
    if (!this.token) return null;
    const res = await fetch(this.apiBase + '/me', {
      headers: { 'Authorization': 'Bearer ' + this.token }
    });
    if (res.status === 401) { this.logout(); return null; }
    return res.json();
  }

  async syncAchievements(achievementIds) {
    if (!this.token) return null;
    const res = await fetch(this.apiBase + '/achievements/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + this.token
      },
      body: JSON.stringify({ achievements: achievementIds })
    });
    if (res.status === 401) { this.logout(); return null; }
    return res.json();
  }

  async getPlayerProfile(playerId) {
    const res = await fetch(this.apiBase + '/player/' + playerId);
    return res.json();
  }
}
