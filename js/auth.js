// ============================================================
// AUTH — Google Identity Services (GSI) client-side auth
// ============================================================

const STORAGE_USER = 'tandemonium_auth_user';
const STORAGE_TOKEN = 'tandemonium_auth_token';
const GOOGLE_CLIENT_ID = '640682648249-dp1dou0mmpkm6m697oakbe9odabt1dui.apps.googleusercontent.com';
const API_BASE = 'https://tandemonium-api.pete-872.workers.dev';

export class AuthManager {
  constructor() {
    this.user = null;
    this.token = null;
    this._onLoginCallback = null;
    this._gsiInitialized = false;
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
    return !!this.user;
  }

  getUser() {
    return this.user;
  }

  onLogin(callback) {
    this._onLoginCallback = callback;
  }

  initGSI() {
    if (this._gsiInitialized) return;
    this._gsiInitialized = true;

    const tryInit = () => {
      if (typeof google === 'undefined' || !google.accounts) {
        setTimeout(tryInit, 200);
        return;
      }
      google.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback: (response) => this._handleCredential(response),
        auto_select: true,
      });
    };
    tryInit();
  }

  async _handleCredential(response) {
    try {
      const payload = JSON.parse(atob(response.credential.split('.')[1]));
      this.user = {
        id: payload.sub,
        name: payload.name,
        email: payload.email,
        avatar: payload.picture,
      };
      this._save();
      if (this._onLoginCallback) this._onLoginCallback(this.user);

      // Exchange GSI credential for server JWT
      const res = await fetch(`${API_BASE}/auth/google`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credential: response.credential }),
      });
      if (res.ok) {
        const data = await res.json();
        this.token = data.token;
        if (data.user && data.user.id) this.user.serverId = data.user.id;
        this._save();
      }
    } catch (e) {
      console.error('Auth error', e);
    }
  }

  login() {
    if (typeof google === 'undefined' || !google.accounts) return;
    google.accounts.id.prompt();
  }

  logout() {
    this.user = null;
    this.token = null;
    try {
      localStorage.removeItem(STORAGE_USER);
      localStorage.removeItem(STORAGE_TOKEN);
    } catch (e) {}
    if (typeof google !== 'undefined' && google.accounts) {
      google.accounts.id.disableAutoSelect();
    }
  }

  async submitScore(data) {
    if (!this.token) return null;
    const res = await fetch(`${API_BASE}/score`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.token}`,
      },
      body: JSON.stringify(data),
    });
    return res.ok ? res.json() : null;
  }

  async syncAchievements(ids) {
    if (!this.token || !ids || ids.length === 0) return null;
    const res = await fetch(`${API_BASE}/achievements/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.token}`,
      },
      body: JSON.stringify({ achievements: ids }),
    });
    return res.ok ? res.json() : null;
  }

  async getLeaderboard(levelId, scope, limit) {
    const params = new URLSearchParams({ level: levelId || 'grandma' });
    if (scope) params.set('scope', scope);
    if (limit) params.set('limit', String(limit));
    const headers = {};
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;
    const res = await fetch(`${API_BASE}/leaderboard?${params}`, { headers });
    return res.ok ? res.json() : { entries: [] };
  }
}
