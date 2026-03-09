// ============================================================
// LICENSE MANAGER — checks entitlements against usersfirst-store
// ============================================================

const STORE_API = 'https://usersfirst-store.pete-872.workers.dev';
const CACHE_KEY = 'tandemonium_license';
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export class LicenseManager {
  constructor(auth) {
    this.auth = auth;
    this._license = null;      // { licensed, tier, platform, granted_at }
    this._cachedAt = 0;
    this._loading = false;
    this._loadPromise = null;
    this._restoreCache();
  }

  /** True if the user has an active license for Tandemonium. */
  get isLicensed() {
    return !!(this._license && this._license.licensed);
  }

  /** Current tier ('early_access' | 'general') or null. */
  get tier() {
    return this._license ? this._license.tier : null;
  }

  /**
   * Determine the user's access level:
   *   'licensed'   — logged in + paid
   *   'free'       — logged in, no license
   *   'anonymous'  — not logged in
   */
  get accessLevel() {
    if (!this.auth || !this.auth.isLoggedIn()) return 'anonymous';
    return this.isLicensed ? 'licensed' : 'free';
  }

  /**
   * Fetch (or return cached) license status from the store API.
   * Safe to call frequently — deduplicates and caches.
   */
  async check() {
    if (!this.auth || !this.auth.isLoggedIn() || !this.auth.token) {
      this._license = null;
      this._clearCache();
      return this._license;
    }

    // Return cache if fresh
    if (this._license && (Date.now() - this._cachedAt < CACHE_TTL)) {
      return this._license;
    }

    // Deduplicate concurrent calls
    if (this._loading) return this._loadPromise;

    this._loading = true;
    this._loadPromise = this._fetch();
    try {
      await this._loadPromise;
    } finally {
      this._loading = false;
    }
    return this._license;
  }

  /** Force a fresh check (e.g. after purchase). */
  async refresh() {
    this._cachedAt = 0;
    this._license = null;
    return this.check();
  }

  /** Clear cached state (call on logout). */
  clear() {
    this._license = null;
    this._cachedAt = 0;
    this._clearCache();
  }

  /** Start a Stripe checkout for the given product. Returns the checkout URL. */
  async startCheckout(productId, successUrl, cancelUrl) {
    const res = await fetch(`${STORE_API}/checkout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.auth.token}`,
      },
      body: JSON.stringify({ productId, successUrl, cancelUrl }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Checkout failed (${res.status})`);
    }
    const data = await res.json();
    return data.url;
  }

  /** Redeem a promo code. Returns { success, licenseId, gameId, tier }. */
  async redeem(code) {
    const res = await fetch(`${STORE_API}/redeem`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.auth.token}`,
      },
      body: JSON.stringify({ code }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Redeem failed');
    // Refresh license after successful redemption
    await this.refresh();
    return data;
  }

  // ── Private ──────────────────────────────────────────────

  async _fetch() {
    try {
      const serverId = this.auth.user ? this.auth.user.serverId : null;
      if (!serverId) return;

      const res = await fetch(`${STORE_API}/license/${serverId}/tandemonium`, {
        headers: { 'Authorization': `Bearer ${this.auth.token}` },
      });
      if (res.ok) {
        this._license = await res.json();
        this._cachedAt = Date.now();
        this._saveCache();
      } else {
        this._license = { licensed: false };
      }
    } catch (e) {
      console.warn('License check failed', e);
      // Keep stale cache on network error
      if (!this._license) this._license = { licensed: false };
    }
  }

  _saveCache() {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({
        license: this._license,
        cachedAt: this._cachedAt,
      }));
    } catch (e) {}
  }

  _restoreCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (raw) {
        const { license, cachedAt } = JSON.parse(raw);
        if (Date.now() - cachedAt < CACHE_TTL) {
          this._license = license;
          this._cachedAt = cachedAt;
        }
      }
    } catch (e) {}
  }

  _clearCache() {
    try { localStorage.removeItem(CACHE_KEY); } catch (e) {}
  }
}
