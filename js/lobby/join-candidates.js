// @ts-check
// ============================================================
// join-candidates — one join card per physical controller
// ============================================================
//
// The versus / RIDE TOGETHER join detection sees the same pad from several
// sources at once. Under a Steam launch, Steam Input captures a DualSense and
// reports it in the snapshot, while our PlayStation driver still streams it
// over WebHID (Bluetooth). The Steam entry's join press is the IGA action
// `Confirm`, which the shipped DualSense binding (steam/controller_ps5.vdf, an
// XInput gamepad template) never wires — so a card driven by that entry can be
// pressed forever. The WebHID entry's ✕ lands in its synthetic buttons[0].
//
// WebHID-first is the architecture's rule (isSteamTwinPad, steamController-
// LiveOnWebHid do the same for Steam Controllers): when a controller streams
// on WebHID, its Steam twin is dropped and the WebHID entry is the one joined.

import { hidDeviceIdentity, steamTypeGlyphIdentity } from './controller-labels.js';

/**
 * Prompt family of a WebHID device ('playstation' | 'xbox' | 'nintendo' |
 * 'steam'), or null when the registry doesn't know it.
 * @param {{ vendorId?: number, productId?: number, productName?: string }|null|undefined} device
 */
export function hidFamily(device) {
  const id = hidDeviceIdentity(device);
  return id ? id.glyphFamily : null;
}

/**
 * Prompt family of a Steam Input controller type ('13', 'k_ESteamInputType_…').
 * Unknown / unnamed types count as Steam's own family (#535: a Steam
 * Controller switched on after launch keeps type 0).
 * @param {string|number|null|undefined} type
 */
export function steamFamily(type) {
  return steamTypeGlyphIdentity(type).glyphFamily;
}

/**
 * The Steam Input snapshot entries that are NOT the same physical pads as
 * controllers already streaming on WebHID. Steam reports a type, not a
 * vid:pid, so the match is by prompt family, one Steam entry per WebHID
 * device of that family: two DualSenses on WebHID consume two PS entries; a
 * third PS entry (a DualSense Steam holds exclusively) stays joinable.
 * @template {{ type?: string|number|null }} E
 * @param {E[]} steamEntries
 * @param {Iterable<any>} hidDevices every WebHID device in play — seated or joinable
 * @returns {E[]}
 */
export function withoutWebHidTwins(steamEntries, hidDevices) {
  const budget = new Map();
  for (const d of hidDevices || []) {
    const f = hidFamily(d);
    if (f) budget.set(f, (budget.get(f) || 0) + 1);
  }
  const out = [];
  for (const e of steamEntries || []) {
    const f = steamFamily(e && e.type);
    const n = budget.get(f) || 0;
    if (n > 0) { budget.set(f, n - 1); continue; }
    out.push(e);
  }
  return out;
}
