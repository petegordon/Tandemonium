// ============================================================
// device-identity — what a UI shows for a controller
// ============================================================
//
// One place that turns a DEVICES entry, a Gamepad-API id string or a WebHID
// device into the three things every seat, chip and button prompt needs:
//
//   name         full name ("Sony DualSense", "GameSir Super Nova (DS4 mode)")
//   shortName    what a seat or roster row shows ("DualSense", "Super Nova")
//   glyphFamily  which button prompts to draw: 'playstation' | 'xbox' |
//                'nintendo' | 'steam' | 'generic' | 'keyboard'
//   swapAB       Nintendo-order confirm/back (entry.quirks.swapAB)
//
// The lab lobby and Tandemonium each worked these out per screen before
// (lobby-app devName(), the game's _prettyGamepadName). See
// docs/UI-KIT-TV-COMPONENTS.md §1.

import { ControllerRegistry } from './drivers/controller-registry.js';

/** @typedef {'playstation' | 'xbox' | 'nintendo' | 'steam' | 'generic' | 'keyboard'} GlyphFamily */
/**
 * @typedef {object} DeviceIdentity
 * @property {string} name
 * @property {string} shortName
 * @property {GlyphFamily} glyphFamily
 * @property {boolean} swapAB
 * @property {object|null} entry  the DEVICES entry, when one matched
 */

/** @type {readonly GlyphFamily[]} */
export const GLYPH_FAMILIES = Object.freeze(['playstation', 'xbox', 'nintendo', 'steam', 'generic', 'keyboard']);

// A protocol's own button labels. An entry overrides with `glyphFamily` when
// its printed buttons differ from the protocol it speaks.
const PROTOCOL_GLYPHS = {
  'dualsense': 'playstation',
  'switch-pro': 'nintendo',
  'xbox': 'xbox',
  'steam-controller': 'steam',
};

/**
 * @param {object|null|undefined} entry a DEVICES entry
 * @returns {GlyphFamily}
 */
export function glyphFamilyOf(entry) {
  if (!entry) return 'generic';
  if (entry.glyphFamily && GLYPH_FAMILIES.includes(entry.glyphFamily)) return entry.glyphFamily;
  return /** @type {GlyphFamily} */ (PROTOCOL_GLYPHS[entry.protocol] || 'generic');
}

/**
 * @param {object|null|undefined} entry a DEVICES entry
 * @returns {string}
 */
export function shortNameOf(entry) {
  return (entry && (entry.shortName || entry.name)) || 'Controller';
}

/**
 * Identity from a DEVICES entry; `fallbackName` names an unknown controller.
 * @param {object|null|undefined} entry
 * @param {string} [fallbackName]
 * @returns {DeviceIdentity}
 */
export function identityOf(entry, fallbackName = 'Controller') {
  if (!entry) {
    const name = fallbackName || 'Controller';
    return { name, shortName: name, glyphFamily: 'generic', swapAB: false, entry: null };
  }
  return {
    name: entry.name,
    shortName: shortNameOf(entry),
    glyphFamily: glyphFamilyOf(entry),
    swapAB: !!(entry.quirks && entry.quirks.swapAB),
    entry,
  };
}

/**
 * The readable part of a Gamepad-API id: "USB Gamepad (STANDARD GAMEPAD Vendor:
 * 0079 Product: 0011)" → "USB Gamepad". Chromium and Firefox both put the
 * product name first; anything in brackets after it is mapping/vid:pid noise.
 * @param {string} id
 * @returns {string}
 */
export function readableGamepadName(id) {
  const raw = String(id || '').trim();
  // Firefox: "054c-0ce6-DualSense Wireless Controller"
  const ff = /^[0-9a-f]{4}-[0-9a-f]{4}-(.+)$/i.exec(raw);
  const name = (ff ? ff[1] : raw).replace(/\s*\(.*$/, '').trim();
  return name || 'Controller';
}

/**
 * Identity from a Gamepad-API id string.
 * @param {string} id
 * @returns {DeviceIdentity}
 */
export function identifyGamepadId(id) {
  const hit = ControllerRegistry.identifyFromGamepadId(id);
  const quirks = ControllerRegistry.getGamepadQuirks(id);
  const ident = identityOf(hit ? hit.entry : null, readableGamepadName(id));
  if (quirks.swapAB) ident.swapAB = true;
  return ident;
}

/**
 * Identity from a WebHID device (vid:pid lookup; productName for unknowns).
 * @param {{ vendorId?: number, productId?: number, productName?: string }|null|undefined} device
 * @returns {DeviceIdentity}
 */
export function identifyHidDevice(device) {
  if (!device) return identityOf(null);
  const entry = ControllerRegistry.getEntry(device.vendorId, device.productId);
  return identityOf(entry, device.productName || 'Controller');
}

/** @type {DeviceIdentity} */
export const KEYBOARD_IDENTITY = Object.freeze({ name: 'Keyboard', shortName: 'Keyboard', glyphFamily: 'keyboard', swapAB: false, entry: null });

const STEAM_VID = 0x28de;
const STEAM_PUCK_PID = 0x1304;

/**
 * How a controller reaches the page, as a roster row shows it.
 *   'usb' | 'bluetooth'  a bound WebHID driver that knows its transport
 *   'puck'               a Steam Controller through its wireless receiver
 *   'webhid'             WebHID with no transport known yet
 *   'gamepad'            Gamepad API only (no HID binding)
 * @param {{ driver?: { connectionType?: string }|null, device?: { vendorId?: number, productId?: number }|null }} src
 * @returns {'usb' | 'bluetooth' | 'puck' | 'webhid' | 'gamepad'}
 */
export function connectionOf({ driver = null, device = null } = {}) {
  if (device && device.vendorId === STEAM_VID && device.productId === STEAM_PUCK_PID) return 'puck';
  const t = driver && driver.connectionType;
  if (t === 'usb' || t === 'bluetooth') return t;
  return device ? 'webhid' : 'gamepad';
}
