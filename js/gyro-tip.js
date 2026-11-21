// @ts-check
// ============================================================
// Gyro tip (#820) — the Steam build's "best with motion control" popup.
// ============================================================
//
// Shown on the main menu when nothing here can steer by motion: no gyro
// controller and no paired phone. At most once per launch, until the player
// turns on "Don't show this again".

export const GYRO_TIP_OFF_KEY = 'tandemonium_gyro_tip_off';
/** How long the menu must sit idle first, so controllers have time to be seen (ms). */
export const GYRO_TIP_SETTLE_MS = 3000;
const POLL_MS = 250;

// ESteamInputType values with motion sensors: Steam Controller, PS4, Joy-Con pair,
// single Joy-Con, Switch Pro, PS5, Steam Deck / 2026 Steam Controller.
const STEAM_GYRO_TYPES = new Set(['1', '5', '8', '9', '10', '13', '14']);

/** Does Steam's type say gyro? A pad Steam has not named yet gets the benefit of the doubt. */
export function steamTypeMayHaveGyro(type) {
  const t = String(type ?? '').trim();
  return t === '' || t === '0' || STEAM_GYRO_TYPES.has(t);
}

/**
 * Can anyone here steer by motion? Pure, for the unit test.
 * @param {{ active?: boolean, phones?: number, hidGyro?: boolean, padGyro?: boolean, steamTypes?: any[] }} seen
 */
export function gyroOptionAvailable({ active = false, phones = 0, hidGyro = false, padGyro = false, steamTypes = [] }) {
  return active || phones > 0 || hidGyro || padGyro || steamTypes.some(steamTypeMayHaveGyro);
}

export class GyroTip {
  /**
   * @param {object} deps
   * @param {any} deps.sheet the <uf-sheet>, focus already attached
   * @param {any} deps.toggle the "Don't show this again" <uf-setting>
   * @param {any} deps.ok the GOT IT button
   * @param {any} deps.focus the FocusController driving the sheet
   * @param {() => boolean} deps.canShow the main menu is up with nothing over it
   * @param {() => Promise<boolean>} deps.hasGyro
   */
  constructor({ sheet, toggle, ok, focus, canShow, hasGyro }) {
    this.sheet = sheet;
    this.canShow = canShow;
    this.hasGyro = hasGyro;
    this._shown = false;
    this._checking = false;
    /** @type {any} */ this._timer = null;
    ok.addEventListener('click', () => sheet.close());
    // Every way out (GOT IT, B, Esc, the scrim) keeps the choice.
    sheet.addEventListener('uf-sheet:close', () => {
      if (!toggle.checked) return;
      try { localStorage.setItem(GYRO_TIP_OFF_KEY, '1'); } catch (e) {}
    });
    // The sheet starts on its first body item, which here is the option: an A press
    // must dismiss rather than opt out. This frame runs after the sheet's own.
    sheet.addEventListener('uf-sheet:open', () => requestAnimationFrame(() => {
      if (sheet.open) focus.setSpatial(sheet.focusables(), ok);
    }));
  }

  get _optedOut() {
    try { return localStorage.getItem(GYRO_TIP_OFF_KEY) === '1'; } catch (e) { return false; }
  }

  /** The main menu came up: start waiting for it to settle. */
  arm() {
    if (this._shown || this._timer || this._optedOut) return;
    let idle = 0;
    this._timer = setInterval(async () => {
      if (!this.canShow()) { idle = 0; return; }
      idle += POLL_MS;
      if (idle < GYRO_TIP_SETTLE_MS || this._checking) return;
      this._checking = true;
      const has = await this.hasGyro().catch(() => true);   // unsure: don't nag
      this._checking = false;
      if (!this._timer) return;
      this._stop();
      if (has || !this.canShow()) return;   // checked again on the next return to the menu
      this._shown = true;
      this.sheet.show();
    }, POLL_MS);
  }

  _stop() { clearInterval(this._timer); this._timer = null; }
}
