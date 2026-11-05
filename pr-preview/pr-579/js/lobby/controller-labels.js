// @ts-check
// ============================================================
// controller-labels — what the lobby calls a controller (#458)
// ============================================================
//
// Game-side rules on top of core's device-identity (shared/, vendored from the
// lab — not edited here):
//
//   - A WebHID binding's vendor:product is the truth. Core's slotIdentity()
//     tries the slot's Gamepad label first, and a HID slot's label is the
//     synthetic pad's "HID::<productName>" — no vid:pid — so the registry's
//     pattern fallback picked the FIRST Steam entry and a Steam Controller on
//     the Puck (28de:1304) read "Steam Controller 2026 (direct USB-C)".
//   - Steam Input reports a controller type, not a vid:pid: map it to the
//     prompts printed on that pad (a Switch Pro under Steam is still Nintendo),
//     instead of drawing Steam's A/B/X/Y (or nothing) for everything.
//   - A Gamepad-API id that matched only by pattern (no exact vid:pid) gets the
//     entry's short name, not one variant's full name.
//   - Versus seats are numbered from the lowest free number, so a joiner never
//     gets a number another player already shows.

import { ControllerRegistry } from '../../shared/drivers/controller-registry.js';
import { identityOf } from '../../shared/device-identity.js';
import { steamTypeIdentity } from '../controller-overlay-hud.js';

const STEAM_VID = 0x28de;

/** Visualizer profile → button-prompt family. */
const PROFILE_FAMILY = {
  dualsense: 'playstation',
  xbox: 'xbox',
  'switch-pro': 'nintendo',
  'steam-controller': 'steam',
};

/**
 * Identity for a WebHID device from its vendor:product, or null when the
 * registry doesn't know it. An unknown Valve device (the 2015 Steam Controller,
 * 28de:1102 / 1142) is still a Steam Controller with Steam's prompts.
 * @param {{ vendorId?: number, productId?: number, productName?: string }|null|undefined} device
 * @returns {import('../../shared/device-identity.js').DeviceIdentity|null}
 */
export function hidDeviceIdentity(device) {
  if (!device || device.vendorId == null || device.productId == null) return null;
  const entry = ControllerRegistry.getEntry(device.vendorId, device.productId);
  if (entry) return identityOf(entry);
  if (device.vendorId === STEAM_VID) {
    return { name: 'Steam Controller', shortName: 'Steam Controller', glyphFamily: 'steam', swapAB: false, entry: null };
  }
  return null;
}

/**
 * Core's slot identity, corrected so a bound WebHID device's vendor:product
 * wins over the slot's Gamepad label.
 * @param {any} slot a ControllerManager slot
 * @param {(slot: any) => import('../../shared/device-identity.js').DeviceIdentity} coreIdentity mgr.slotIdentity
 */
export function slotIdentityHidFirst(slot, coreIdentity) {
  if (slot && slot.driver && slot.driver.entry) return identityOf(slot.driver.entry);
  const hid = slot ? hidDeviceIdentity(slot.hidDevice) : null;
  if (hid) return hid;
  return coreIdentity(slot);
}

/**
 * Identity for a Steam Input controller type ('13', 'k_ESteamInputType_…').
 * @param {string|number|null|undefined} type
 * @param {string} [fallbackName]
 * @returns {import('../../shared/device-identity.js').DeviceIdentity}
 */
export function steamTypeGlyphIdentity(type, fallbackName = 'Steam Controller') {
  const st = steamTypeIdentity(type);
  if (!st.profile) return { ...identityOf(null, fallbackName), glyphFamily: 'steam' };
  const family = /** @type {any} */ (PROFILE_FAMILY[st.profile] || 'steam');
  return { name: st.name, shortName: st.name, glyphFamily: family, swapAB: false, entry: null };
}

/**
 * Correct a core controllerRoster() row whose WebHID device the registry knows
 * (the slot rows inherit core's label-first naming).
 * @template {{ device?: any, name?: string, shortName?: string, glyphFamily?: string, swapAB?: boolean }} R
 * @param {R} row
 * @returns {R}
 */
export function fixRosterRow(row) {
  const id = row && row.device ? hidDeviceIdentity(row.device) : null;
  if (!id) return row;
  return { ...row, name: id.name, shortName: id.shortName, glyphFamily: id.glyphFamily, swapAB: id.swapAB };
}

/**
 * Upper-case display name for a Gamepad-API id or WebHID product name, as the
 * lobby's join cards show it. A registry hit by exact vid:pid (or by a
 * variant's own id match) names that entry; a pattern-only hit names the
 * family (shortName) — the id doesn't say which variant it is.
 * @param {string|null|undefined} rawId
 * @returns {string}
 */
export function prettyGamepadName(rawId) {
  if (!rawId) return 'CONTROLLER';
  const info = ControllerRegistry.identifyFromGamepadId(rawId);
  if (info && info.entry) {
    const e = info.entry;
    const vp = ControllerRegistry.parseGamepadVendorProduct(rawId);
    const exact = !!e.gamepadIdMatch || (vp && vp.vendorId === e.vendorId && vp.productId === e.productId);
    return String(exact ? e.name : (e.shortName || e.name)).toUpperCase();
  }
  // Unknown device — strip the parenthetical suffix and uppercase.
  let name = String(rawId).replace(/^HID::/, '').replace(/\s*\(.*\)\s*$/, '').trim();
  if (!name) name = 'CONTROLLER';
  if (name.length > 20) name = name.slice(0, 20) + '…';
  return name.toUpperCase();
}

/**
 * Display name for a WebHID device: its registry entry by vendor:product,
 * else whatever its product name (or `fallback`) says.
 * @param {{ vendorId?: number, productId?: number, productName?: string }|null|undefined} device
 * @param {string} [fallback]
 */
export function prettyHidName(device, fallback = '') {
  const id = hidDeviceIdentity(device);
  if (id) return id.name.toUpperCase();
  return prettyGamepadName((device && device.productName) || fallback || 'Controller');
}

/**
 * The lowest player number (1…max) no current player holds.
 * @param {{ n: number }[]} players
 * @param {number} [max]
 * @returns {number|null} null when every number is taken
 */
export function lowestFreePlayerNumber(players, max = 4) {
  const used = new Set((players || []).map((p) => p.n));
  for (let n = 1; n <= max; n++) if (!used.has(n)) return n;
  return null;
}

/**
 * Where a joining pad sits in versus (#458 item 2). When Player 1's seat is
 * only a keyboard placeholder (the pad that would own it never pressed, e.g.
 * several pads were connected at launch and none was picked), the first pad to
 * join takes Player 1 — it used to be seated P2 and the LAST joiner ended up
 * in P1 through the full-roster takeover. Otherwise the joiner gets the lowest
 * free player number.
 * @param {{ n: number, type: string, slotId?: string|null }[]} players
 * @param {{ p1SlotEmpty: boolean, kind: string }} ctx
 * @returns {{ takeP1: boolean, n: number|null }}
 */
export function versusJoinSeat(players, { p1SlotEmpty, kind }) {
  const p1 = players[0];
  if (p1 && p1.type === 'keyboard' && p1SlotEmpty && kind !== 'steam') return { takeP1: true, n: 1 };
  return { takeP1: false, n: lowestFreePlayerNumber(players) };
}
