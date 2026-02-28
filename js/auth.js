// ============================================================
// AUTH — Google Identity Services (GSI) client-side auth
// ============================================================

const STORAGE_USER = 'tandemonium_auth_user';
const GOOGLE_CLIENT_ID = '640682648249-dp1dou0mmpkm6m697oakbe9odabt1dui.apps.googleusercontent.com';

export class AuthManager {
  constructor() {
    this.user = null;
    this._onLoginCallback = null;
    this._gsiInitialized = false;
    this._load();
  }

  _load() {
    try {
      const raw = localStorage.getItem(STORAGE_USER);
      if (raw) this.user = JSON.parse(raw);
    } catch (e) {}
  }

  _save() {
    try {
      if (this.user) localStorage.setItem(STORAGE_USER, JSON.stringify(this.user));
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

  _handleCredential(response) {
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
    } catch (e) {
      console.error('Failed to decode Google credential', e);
    }
  }

  login() {
    if (typeof google === 'undefined' || !google.accounts) return;
    google.accounts.id.prompt();
  }

  logout() {
    this.user = null;
    try {
      localStorage.removeItem(STORAGE_USER);
    } catch (e) {}
    if (typeof google !== 'undefined' && google.accounts) {
      google.accounts.id.disableAutoSelect();
    }
  }
}
