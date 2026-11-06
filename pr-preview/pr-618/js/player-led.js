// ============================================================
// PLAYER LED (#548) — a player's controller light in their chosen colour, and "Find me"
// ============================================================
//
// The ControllerManager (shared/manager.js, vendored from the controller lab) lights a pad by
// its slot ordinal when it claims it: opts.playerColors[n] on the DualSense lightbar plus the
// player-LED row. This module changes that colour to the player's Wardrobe pick and re-applies
// it to the pad sitting in slot P<n> right now:
//   DualSense (WebHID)   lightbar colour + player LEDs (driver.setPlayerFeedback / setLightbar)
//   Switch Pro (WebHID)  player lights only (sub-command 0x30) — no colour; Find me flashes them
//   Steam Controller     Steam Input SetLEDColor on its handle (#617): Steam applies it where the
//                        controller has a light it can colour (needs a hardware test)
//   anything else        no-op (Gamepad API pads, keyboard have no light we can set)
// Nothing here touches shared/: the manager's own hooks are used as they are.

import { ledRgb } from './player-look.js';
import { hapticFindMe } from './haptics.js';
import { steamTargetForEntry } from './input-manager.js';

const SWITCH_VID = 0x057e;

/** Test seam: the smokes swap `driverFor` for a recorder. */
export const ledHooks = {
  /** The WebHID driver of the pad in slot P<n>, or null. */
  driverFor(mgr, n) {
    const slot = mgr && mgr.getSlot ? mgr.getSlot('P' + n) : null;
    return (slot && slot.state === 'claimed' && slot.driver) || null;
  },
  /** Steam Input's handle for the Steam Controller in slot P<n>, or null. */
  steamHandleFor(mgr, n) {
    const slot = mgr && mgr.getSlot ? mgr.getSlot('P' + n) : null;
    const t = slot && slot.state === 'claimed' ? steamTargetForEntry(slot._hidEntry) : null;
    return (t && t.handle) || null;
  },
  /** preload's window.steam.input, or null outside the Steam build. */
  steamInput: () => (typeof window !== 'undefined' && window.steam && window.steam.input) || null,
  /** setTimeout (tests run the flash synchronously). */
  timer: (fn, ms) => setTimeout(fn, ms),
};
if (typeof window !== 'undefined') window.__playerLed = ledHooks;

function isSwitch(driver) {
  const d = driver && driver.device;
  return !!(d && d.vendorId === SWITCH_VID) || !!(driver && driver.constructor && /Switch/i.test(driver.constructor.name || ''));
}

/** The player-LED pattern the driver uses for player n (DualSense table), else n's own bit. */
function playerPattern(driver, n) {
  const table = driver && driver.constructor && driver.constructor.PLAYER_LED_PATTERNS;
  if (table && table[n] != null) return table[n];
  return 1 << Math.max(0, Math.min(3, n - 1));
}

/**
 * Light the pad of player n: lightbar in `rgb`, player LEDs for n.
 * @returns {boolean} true when a driver took the call
 */
function lightPad(driver, n, rgb, steamHandle = null) {
  if (steamHandle) {
    const si = ledHooks.steamInput();
    if (si && typeof si.setLed === 'function') { si.setLed(steamHandle, rgb.r, rgb.g, rgb.b); return true; }
  }
  if (!driver) return false;
  try {
    if (isSwitch(driver)) {
      if (typeof driver._sendSubCommand !== 'function') return false;
      driver._sendSubCommand(0x30, [playerPattern(driver, n) & 0x0f]).catch(() => {});
      return true;
    }
    if (typeof driver.setPlayerFeedback === 'function') {
      driver.setPlayerFeedback({ playerLEDs: playerPattern(driver, n), lightbar: rgb }).catch(() => {});
      return true;
    }
    if (typeof driver.setLightbar === 'function') {
      driver.setLightbar(rgb.r, rgb.g, rgb.b).catch(() => {});
      return true;
    }
  } catch (e) { /* a pad that went away mid-call */ }
  return false;
}

/**
 * Make `led` player n's controller colour: the manager lights the pad with it on every claim from
 * now on, and the pad in P<n> now (if any) changes at once.
 * @param {any} mgr the ControllerManager (may be null)
 * @param {number} n player number 1–4
 * @param {string} led a LED_COLOURS key
 * @returns {boolean} true when a pad was lit
 */
export function applyPlayerLed(mgr, n, led) {
  const rgb = ledRgb(led);
  if (mgr && mgr.opts) {
    if (!mgr.opts.playerColors) mgr.opts.playerColors = {};
    mgr.opts.playerColors[n] = rgb;
  }
  return lightPad(ledHooks.driverFor(mgr, n), n, rgb, ledHooks.steamHandleFor(mgr, n));
}

/**
 * "Find me": pulse player n's pad and flash its light, then leave it in `led`.
 * @param {any} mgr the ControllerManager
 * @param {number} n player number
 * @param {string} led the player's LED colour (restored at the end)
 * @param {{gamepadIndex: number|null}|null} input that player's InputManager (rumble target)
 * @returns {{rumbled: boolean, lit: boolean}}
 */
export function findMe(mgr, n, led, input) {
  const rumbled = !!input;
  if (input) hapticFindMe([input], ledHooks.timer);
  const driver = ledHooks.driverFor(mgr, n);
  // A Steam Controller under Steam: flash through Steam Input's light instead (#617).
  const steamHandle = ledHooks.steamHandleFor(mgr, n);
  if (steamHandle && ledHooks.steamInput()) {
    const on = { r: 255, g: 255, b: 255 }, dark = { r: 0, g: 0, b: 0 };
    [on, dark, on, dark, on, dark].forEach((c, i) => ledHooks.timer(() => lightPad(null, n, c, steamHandle), i * 160));
    ledHooks.timer(() => lightPad(null, n, ledRgb(led), steamHandle), 6 * 160);
    return { rumbled, lit: true };
  }
  if (!driver) return { rumbled, lit: false };
  const rgb = ledRgb(led);
  const white = { r: 255, g: 255, b: 255 };
  const off = { r: 0, g: 0, b: 0 };
  let lit = false;
  if (isSwitch(driver)) {
    if (typeof driver._sendSubCommand !== 'function') return { rumbled, lit };
    // 0x30: low nibble = steady lights, high nibble = flashing lights.
    lit = true;
    driver._sendSubCommand(0x30, [0xf0]).catch(() => {});
    ledHooks.timer(() => lightPad(driver, n, rgb), 1500);
    return { rumbled, lit };
  }
  lit = typeof driver.setPlayerFeedback === 'function' || typeof driver.setLightbar === 'function';
  if (!lit) return { rumbled, lit };
  const steps = [white, off, white, off, white, off];
  steps.forEach((c, i) => ledHooks.timer(() => lightPad(driver, n, c), i * 160));
  ledHooks.timer(() => lightPad(driver, n, rgb), steps.length * 160);
  return { rumbled, lit };
}
