// ============================================================
// CONTROLLER UNITS — one physical controller, however many sources
// ============================================================
//
// A single pad can reach a page through several sources at once:
//
//   webhid        our driver's HidEntry (real vid:pid, gyro, synthetic buttons)
//   gamepad       a Gamepad-API pad: live, or FROZEN (a DualSense listed from
//                 its compat-mode reports, then switched to full reports by the
//                 driver, which Chromium can't parse: still listed, never
//                 changes again)
//   steam-xinput  Steam's virtual XInput pad for a controller Steam captured
//                 ("Xbox 360 Controller (XInput STANDARD GAMEPAD)", no vid:pid,
//                 mirrors the hardware's presses a few ms late)
//
// A ControllerUnit is that physical controller. The ControllerManager builds
// and maintains units every frame (manager.js `_reconcileUnits`); claims, the
// roster and join lists operate on units, so one controller is one row, one
// card and one seat whatever it arrives through. The design and the platform
// facts behind it: docs/controller-units.md.
// ============================================================

import { identityOf, identifyGamepadId, identifyHidDevice, connectionOf } from './device-identity.js';

/** Default silence after which a controller that streams while idle is "switched off". */
export const DEFAULT_SILENT_AFTER_MS = 4000;

/**
 * @typedef {'latent' | 'present' | 'silent' | 'gone'} UnitPresence
 *   latent   a receiver interface that has never streamed (an idle Puck slot):
 *            not a controller yet, never listed, can't claim
 *   present  connected (and, for a controller that streams while idle,
 *            reporting within silentAfterMs)
 *   silent   connected device, but a controller that streams while idle has
 *            sent nothing for silentAfterMs: switched off (a Steam Controller
 *            body on a Puck that stays plugged in)
 *   gone     every source disconnected (the unit is about to be dropped)
 */

/**
 * @typedef {object} UnitSource
 * @property {'webhid' | 'gamepad' | 'steam-xinput'} kind
 * @property {object} [device]  the HIDDevice (webhid)
 * @property {number} [index]   Gamepad index (gamepad, steam-xinput)
 * @property {string} [id]      Gamepad id (gamepad, steam-xinput)
 * @property {boolean} [frozen] a gamepad source Chromium stopped updating
 * @property {{index:number, handle:string, type:string}|null} [steamSlot]  Steam's XInput slot, when known
 */

/** Does this HidEntry's driver keep reporting while the controller lies still? (silence = off) */
export function streamsWhileIdle(entry) {
  return !!(entry && entry.driver && entry.driver.constructor && entry.driver.constructor.streamsWhileIdle);
}

/** Is this HidEntry a fan-out receiver interface (Steam Puck), whose idle siblings never stream? */
export function isFanoutEntry(entry) {
  return !!(entry && entry.driver && entry.driver.constructor && entry.driver.constructor.needsSiblingFanout);
}

/** A Steam Controller (any transport): Steam always captures it, so under Steam it always has an XInput twin. */
export function isSteamControllerEntry(entry) {
  const d = entry && entry.driver;
  if (!d) return false;
  if (d.constructor && d.constructor.needsSiblingFanout) return true;
  return !!(d.entry && d.entry.protocol === 'steam');
}

/** When this entry last delivered a parsed report (0 = never). Never zeroed. */
export function lastReportOf(entry) {
  if (!entry) return 0;
  return entry.lastReportAt || entry.hidActiveSince || 0;
}

/**
 * Presence of a WebHID source, by the rules in the typedef above.
 * @returns {UnitPresence}
 */
export function hidPresence(entry, now, silentAfterMs = DEFAULT_SILENT_AFTER_MS) {
  const last = lastReportOf(entry);
  if (!last) return isFanoutEntry(entry) ? 'latent' : 'present';
  if (streamsWhileIdle(entry) && now - last > silentAfterMs) return 'silent';
  return 'present';
}

// ── Steam's XInput slot map (fed by the app: window.steam.input.getXInputMap) ──

const XINPUT_ID = /xinput/i;
/** Is this a Gamepad id of an XInput pad (no vid:pid: a real Xbox pad, or Steam's virtual one)? */
export function isXInputPadId(id) { return XINPUT_ID.test(String(id || '')); }

// ESteamInputType as Steam reports it (main.js stringifies the enum: '14', not 'SteamDeckController').
const STEAM_TYPE_FAMILY = {
  1: 'steam', 14: 'steam',          // Steam Controller; Steam Deck / 2026 Steam Controller
  5: 'dualsense', 13: 'dualsense',  // PS4, PS5 (our PlayStation driver's protocol id)
  10: 'switch-pro',
  2: 'xbox', 3: 'xbox', 4: 'xbox',  // Xbox 360, Xbox One, generic XInput
};

/** Our driver protocol family for a Steam input type, or null (0 / unknown → null). */
export function steamTypeFamily(type) {
  const t = String(type ?? '').trim().replace(/^k_ESteamInputType_/i, '');
  if (/^steam/i.test(t)) return 'steam';
  return STEAM_TYPE_FAMILY[Number(t)] || null;
}

/** Steam has not said what this slot is (type 0): a Steam Controller switched on after launch stays 0. */
export function isUnknownSteamType(type) {
  const t = String(type ?? '').trim().replace(/^k_ESteamInputType_/i, '');
  return t === '' || t === '0' || /^unknown$/i.test(t);
}

/**
 * Steam's XInput slot behind the XInput pad at `index`, by rank: Chromium hands
 * XInput pads ascending Gamepad indices in enumeration order, so the k-th XInput
 * pad is the k-th occupied XInput slot. Only sound when every XInput pad
 * Chromium shows is one Steam emitted, so it refuses (null) whenever the counts
 * differ, which they do exactly while players press A/B (Chromium reveals a pad
 * only after its first press). Press correlation covers that window.
 */
export function steamSlotForPadIndex(pads, index, map) {
  if (!Array.isArray(map) || !map.length) return null;
  const xinput = [];
  for (const p of pads || []) if (p && isXInputPadId(p.id)) xinput.push(p);
  xinput.sort((a, b) => a.index - b.index);
  const k = xinput.findIndex((p) => p.index === index);
  if (k < 0) return null;
  const slots = [...map].sort((a, b) => a.index - b.index);
  if (xinput.length !== slots.length) return null;
  return slots[k] || null;
}

/**
 * One gamepad-shaped object whose buttons are pressed when ANY source has them
 * pressed and whose axes take the largest deflection. Keeps the first source's
 * id; says 'standard' mapping only when every source does.
 */
export function mergeGamepads(sources) {
  const list = sources.filter(Boolean);
  let n = 0, m = 4;
  for (const s of list) { n = Math.max(n, (s.buttons || []).length); m = Math.max(m, (s.axes || []).length); }
  const buttons = [];
  for (let i = 0; i < n; i++) {
    let pressed = false, value = 0;
    for (const s of list) {
      const b = s.buttons && s.buttons[i];
      if (!b) continue;
      const v = typeof b.value === 'number' ? b.value : (b.pressed ? 1 : 0);
      if (b.pressed || v > 0.5) pressed = true;
      if (v > value) value = v;
    }
    buttons.push({ pressed, touched: pressed, value: pressed && value === 0 ? 1 : value });
  }
  const axes = [];
  for (let i = 0; i < m; i++) {
    let a = 0;
    for (const s of list) { const x = Number(s.axes && s.axes[i]) || 0; if (Math.abs(x) > Math.abs(a)) a = x; }
    axes.push(a);
  }
  const mapping = list.length && list.every((s) => s.mapping === 'standard') ? 'standard' : '';
  const id = String((list[0] && list[0].id) || '');
  return { id, index: -1, mapping, connected: true, timestamp: Math.max(0, ...list.map((s) => s.timestamp || 0)), buttons, axes, _isUnitFrame: true };
}

let _nextUnitId = 1;

/**
 * One physical controller. Created and kept current by the ControllerManager;
 * apps read it, they never construct one.
 */
export class ControllerUnit {
  constructor(mgr) {
    this._mgr = mgr;
    /** Stable for the unit's lifetime in this page. */
    this.id = _nextUnitId++;
    /** @type {any|null} the WebHID HidEntry, when the controller has one */
    this.entry = null;
    /** Gamepad index of its own pad (live or frozen), or null. */
    this.padIndex = null;
    /** @type {string|null} */
    this.padId = null;
    /** Its Gamepad source has stopped changing while the WebHID source streams. */
    this.padFrozen = false;
    /** Gamepad index of Steam's virtual XInput twin, or null. */
    this.twinPadIndex = null;
    /** @type {string|null} */
    this.twinPadId = null;
    /** @type {{index:number, handle:string, type:string}|null} Steam's XInput slot for this controller, when known */
    this.steamSlot = null;
    /** @type {UnitPresence} */
    this.presence = 'present';
    this.createdAt = 0;
    /** When presence last changed. */
    this.presenceSince = 0;
  }

  /** Stable string for UI keys / maps. */
  get key() { return 'u' + this.id; }
  get device() { return this.entry ? this.entry.device : null; }
  /** Present and usable: what an app's "connected" means. */
  get connected() { return this.presence === 'present'; }
  /** When its WebHID source last delivered a report (0 = never / no WebHID). Never zeroed. */
  get lastReportAt() { return lastReportOf(this.entry); }
  /** The slot holding this controller, or null. */
  get slot() { return this._mgr._slotForUnit(this); }

  /** @returns {UnitSource[]} */
  get sources() {
    const out = [];
    if (this.entry) out.push({ kind: 'webhid', device: this.entry.device });
    if (this.padIndex != null) out.push({ kind: 'gamepad', index: this.padIndex, id: this.padId, frozen: this.padFrozen });
    if (this.twinPadIndex != null) out.push({ kind: 'steam-xinput', index: this.twinPadIndex, id: this.twinPadId, steamSlot: this.steamSlot });
    return out;
  }

  /** What to call it (driver entry first: a GameSir that claims as a Sony pad is named by its HID driver). */
  get identity() {
    const e = this.entry;
    if (e && e.driver && e.driver.entry) return identityOf(e.driver.entry);
    if (this.padId) {
      const byId = identifyGamepadId(this.padId);
      if (byId.entry || !e) return byId;
    }
    return e ? identifyHidDevice(e.device) : identityOf(null);
  }

  get connection() {
    if (this.entry) return connectionOf({ driver: this.entry.driver, device: this.entry.device });
    return 'gamepad';
  }

  /**
   * This controller's input this frame as ONE gamepad-shaped object: buttons
   * pressed on any live source, the largest stick deflection. A frozen pad adds
   * nothing (it never changes); Steam's twin is left out (it echoes the
   * hardware late, which would stretch every press).
   * @param {Array<Gamepad|null>} [pads] defaults to the snapshot of the last ingestFrame
   */
  frame(pads = this._mgr._lastPads || []) {
    const srcs = [];
    const e = this.entry;
    if (e && e.synthetic && lastReportOf(e) > 0 && (this._mgr._frameNow - lastReportOf(e)) <= this._mgr.opts.hidStaleMs) srcs.push(e.synthetic);
    const gp = this.padIndex != null ? pads[this.padIndex] : null;
    if (gp) srcs.push(gp);
    if (!srcs.length && this.twinPadIndex != null && !e && pads[this.twinPadIndex]) srcs.push(pads[this.twinPadIndex]);
    const merged = mergeGamepads(srcs.length ? srcs : [e && e.synthetic].filter(Boolean));
    // Keep the pad's id when there is one (the registry names it from that).
    if (gp) merged.id = gp.id;
    return merged;
  }
}
