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
      // Render a persistent Sign-In button (immune to One Tap cooldown)
      const btnContainer = document.getElementById('gsi-button-container');
      if (btnContainer) {
        google.accounts.id.renderButton(btnContainer, {
          type: 'standard',
          theme: 'filled_black',
          size: 'medium',
          text: 'signin_with',
          shape: 'pill',
        });
      }
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

      // Exchange GSI credential for server JWT before firing callback
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

      if (this._onLoginCallback) this._onLoginCallback(this.user);
    } catch (e) {
      console.error('Auth error', e);
    }
  }

  login() {
    if (typeof google === 'undefined' || !google.accounts) return;
    google.accounts.id.prompt();
  }

  // Clear server JWT token only (keeps user profile for re-auth)
  clearToken() {
    this.token = null;
    try { localStorage.removeItem(STORAGE_TOKEN); } catch (e) {}
  }

  // Force a fresh Google sign-in to get a new server JWT
  refreshLogin() {
    this.clearToken();
    if (typeof google !== 'undefined' && google.accounts) {
      google.accounts.id.disableAutoSelect();
      google.accounts.id.prompt();
    }
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
    const res = await fetch(`${API_BASE}/me`, {
      headers: { 'Authorization': `Bearer ${this.token}` },
    });
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
