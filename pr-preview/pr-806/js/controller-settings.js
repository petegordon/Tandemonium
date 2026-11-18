// @ts-check
// ============================================================
// CONTROLLER SETTINGS (#646) — steering settings follow the controller
// ============================================================
//
// Stick steering, gyro steering, steering feel and button prompts belong to the
// CONTROLLER, not the person and not the screen (Pete, 2026-11-07). The key is
// the pad key from js/player-look.js with the slot taken off:
//   serial:<serial>        the desktop app reads the unit's serial (Steam build)
//   pad:<vid>:<pid>        a browser sees only the model (vendor:product)
//   pad:name:<slug>        an XInput pad with no vendor:product in its id
//   steam                  a Steam Input handle with no serial
//   keyboard
// So "this DualSense steers Responsive" holds wherever it sits (P1 or P4) and,
// in a browser, for every DualSense on this machine.
//
// Migration: before #646 these were one set for the whole screen
// (tandemonium_joystick, tandemonium_steering_feel), read for Player 1 and
// mirrored onto every other seat. The first time this store opens it snapshots
// those values as `defaults`, so every existing pad keeps riding the way it did;
// a pad's own record only holds what was changed on it.
//
// stick / gyro: true | false | null. null = automatic, the behaviour before
// #646: the stick is on unless the pad's gyro is live (#576), gyro is on when
// the pad's motion sensors are bound. A choice made on a pad is explicit.

const STORE_KEY = 'tandemonium_controller_settings';
const LEGACY_JOYSTICK = 'tandemonium_joystick';
const LEGACY_FEEL = 'tandemonium_steering_feel';

/** Button-prompt choices, in the order the setting cycles through them. */
export const PROMPT_CHOICES = /** @type {const} */ (['auto', 'playstation', 'xbox', 'nintendo', 'steam']);
export const PROMPT_LABELS = { auto: 'Automatic', playstation: 'PlayStation', xbox: 'Xbox', nintendo: 'Nintendo', steam: 'Steam' };

/** @typedef {{ stick: boolean|null, gyro: boolean|null, feel: number, prompts: string }} PadSettings */

/**
 * The settings key for a pad key (js/player-look.js padKeyFor): the slot comes off,
 * so the same controller has the same settings in any seat.
 * @param {string|null|undefined} padKey @returns {string|null}
 */
export function settingsKeyFor(padKey) {
  if (!padKey || typeof padKey !== 'string') return null;
  if (padKey === 'keyboard' || padKey.startsWith('serial:')) return padKey;
  if (padKey.startsWith('steam:')) return 'steam';
  // pad:vvvv:pppp:P2 / pad:name:slug:P2 → drop the trailing slot (P1–P4, or P? when unknown)
  return padKey.replace(/:(P\d+|P\?)$/, '');
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const round2 = (v) => Math.round(v * 100) / 100;

/**
 * The pre-#646 screen-wide values, as the defaults every pad starts from.
 * @param {{getItem: (k: string) => string|null}|null} store @param {number} defaultFeel
 * @returns {PadSettings}
 */
export function legacyDefaults(store, defaultFeel) {
  let joy = null, feelRaw = null;
  try { joy = store ? store.getItem(LEGACY_JOYSTICK) : null; } catch (e) {}
  try { feelRaw = store ? store.getItem(LEGACY_FEEL) : null; } catch (e) {}
  const feelNum = feelRaw != null ? Number(feelRaw) : NaN;
  return {
    stick: joy === 'off' ? false : joy === 'on' ? true : null,
    gyro: null,
    feel: Number.isFinite(feelNum) ? clamp01(feelNum) : defaultFeel,
    prompts: 'auto',
  };
}

/** Keep only well-formed fields of a saved record. @param {any} r @returns {Partial<PadSettings>} */
function clean(r) {
  /** @type {Partial<PadSettings>} */
  const out = {};
  if (!r || typeof r !== 'object') return out;
  if (r.stick === true || r.stick === false || r.stick === null) out.stick = r.stick;
  if (r.gyro === true || r.gyro === false || r.gyro === null) out.gyro = r.gyro;
  if (Number.isFinite(r.feel)) out.feel = clamp01(r.feel);
  if (PROMPT_CHOICES.includes(r.prompts)) out.prompts = r.prompts;
  return out;
}

export class ControllerSettings {
  /**
   * @param {{ store?: {getItem: (k: string) => string|null, setItem: (k: string, v: string) => void}|null, defaultFeel?: number }} [o]
   */
  constructor({ store = null, defaultFeel = 0.3 } = {}) {
    this._store = store;
    /** @type {PadSettings} */
    this._defaults = legacyDefaults(store, defaultFeel);
    /** @type {Record<string, Partial<PadSettings>>} */
    this._pads = {};
    this._listeners = [];
    let data = null;
    try { const raw = store && store.getItem(STORE_KEY); data = raw ? JSON.parse(raw) : null; } catch (e) { data = null; }
    if (data && typeof data === 'object' && data.v === 1) {
      this._defaults = { ...this._defaults, ...clean(data.defaults) };
      for (const [k, v] of Object.entries(data.pads || {})) this._pads[k] = clean(v);
    } else {
      // First open: freeze the old screen-wide values as every pad's starting point.
      this._save();
    }
  }

  _save() {
    if (!this._store) return;
    try { this._store.setItem(STORE_KEY, JSON.stringify({ v: 1, defaults: this._defaults, pads: this._pads })); } catch (e) {}
  }

  /** @returns {() => void} */
  onChange(fn) { this._listeners.push(fn); return () => { this._listeners = this._listeners.filter((f) => f !== fn); }; }

  /** @returns {PadSettings} the starting point for a pad never changed on this device */
  defaults() { return { ...this._defaults }; }

  /** Has anything been chosen on this pad? @param {string|null} key */
  has(key) { return !!(key && this._pads[key] && Object.keys(this._pads[key]).length); }

  /**
   * A pad's settings: its own choices over the defaults. A null key (no pad) gets the defaults.
   * @param {string|null} key @returns {PadSettings}
   */
  get(key) {
    return { ...this._defaults, ...((key && this._pads[key]) || {}) };
  }

  /**
   * Change some of a pad's settings (only the fields given).
   * @param {string|null} key @param {Partial<PadSettings>} patch @returns {PadSettings}
   */
  set(key, patch) {
    if (!key) return this.get(key);
    const next = { ...(this._pads[key] || {}), ...clean(patch) };
    if (next.feel != null) next.feel = round2(next.feel);
    const before = JSON.stringify(this._pads[key] || {});
    this._pads[key] = next;
    if (JSON.stringify(next) !== before) {
      this._save();
      for (const fn of this._listeners) { try { fn(key); } catch (e) {} }
    }
    return this.get(key);
  }
}

/**
 * The next button-prompt choice after `current` (the setting cycles on confirm).
 * @param {string} current @returns {string}
 */
export function nextPrompt(current) {
  const i = PROMPT_CHOICES.indexOf(/** @type {any} */ (current));
  return PROMPT_CHOICES[(i + 1) % PROMPT_CHOICES.length];
}
