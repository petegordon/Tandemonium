// ============================================================
// CONTROLLER INVENTORY — registry of every controller we've seen
// ============================================================
//
// A headless, dependency-free record of each controller the app has
// observed: identity, capabilities, and connection lifecycle (first
// seen / last connected / last disconnected / connected now). Feeds the
// overlay's "all controllers" table. No `three`, no DOM — runs in the
// browser, Electron, and node:test alike (and so stays out of the
// `three` import graph, keeping CI dependency-free).
//
// IDENTITY — best available wins:
//   1. serialNumber  — a true per-unit id. In the browser this is
//      unavailable (Chromium blocklists the MAC/serial feature reports);
//      in Electron the main process's HID device events DO expose it, so
//      desktop can tell two identical pads apart. (Verified: even a
//      GameSir Super Nova reports a unique MAC via the OS HID layer.)
//   2. vendorId:productId — merges identical pads when no serial is
//      available (the browser case).
//   3. productName — last resort for an unparseable Gamepad-API id.
//
// SOURCES — a controller can be seen via WebHID and/or the Gamepad API
// (e.g. an Xbox pad is Gamepad-API-only). Observations from both fold
// into one record by vid:pid when unambiguous, with `transports`
// recording which APIs saw it. Two *identical* pads that each have a
// serial stay separate (correct); a serial-less Gamepad-API sighting
// can't be correlated to a specific one of them, so it stays its own
// row (honest about the limit).

import { ControllerRegistry } from './drivers/controller-registry.js';

const hex4 = (n) => (n & 0xffff).toString(16).padStart(4, '0');

/** "DualSense … (… Vendor: 054c Product: 0ce6)" → "DualSense …". */
function stripGamepadIdSuffix(id) {
  return String(id).replace(/\s*\((?:STANDARD GAMEPAD\s*)?Vendor:.*$/i, '').trim();
}

/**
 * Normalize a raw observation into a common shape. Accepts either an
 * HID-style descriptor ({vendorId, productId, productName, serialNumber})
 * or a Gamepad-API one ({gamepadId}); resolves the dictionary entry.
 * @param {object} d
 * @param {'hid'|'gamepad'} [d.source]
 */
export function normalizeDescriptor(d) {
  let { source = 'hid', vendorId = null, productId = null, productName = null, serialNumber = null, gamepadId = null } = d || {};
  if ((vendorId == null || productId == null) && gamepadId) {
    const vp = ControllerRegistry.parseGamepadVendorProduct(gamepadId);
    if (vp) { vendorId = vp.vendorId; productId = vp.productId; }
    if (!productName) productName = stripGamepadIdSuffix(gamepadId);
  }
  const entry = (vendorId != null && productId != null)
    ? ControllerRegistry.getEntry(vendorId, productId)
    : null;
  return {
    source,
    vendorId,
    productId,
    productName: productName || entry?.name || null,
    serialNumber: serialNumber || null,
    entry: entry || null,
  };
}

/** Stable identity key for a normalized observation. */
export function identityKey(n) {
  if (n.serialNumber) return `serial:${n.serialNumber}`;
  if (n.vendorId != null && n.productId != null) return `vidpid:${hex4(n.vendorId)}:${hex4(n.productId)}`;
  if (n.productName) return `name:${n.productName.toLowerCase()}`;
  return 'unknown';
}

/**
 * Capability snapshot for a dictionary entry. Counts come from the entry
 * when present (devices.js `trackpadCount` / `haptics`) and fall back to
 * deriving presence from the capability/feature booleans.
 */
export function capabilitiesFor(entry) {
  const caps = entry?.capabilities || {};
  const feat = entry?.features || {};
  const touchpad = !!caps.touchpad;
  const trackpadCount = entry?.trackpadCount ?? (touchpad ? 1 : 0);
  let haptics = entry?.haptics ?? null;
  if (haptics == null && feat.rumble) haptics = { count: null, type: 'rumble' };
  return {
    gyro: !!caps.gyro,
    accel: !!caps.accel,
    touchpad,
    trackpadCount,
    haptics,                 // { count, type } | null
    lightbar: !!feat.lightbar,
  };
}

/**
 * If `serial` is a 12-hex-digit Bluetooth MAC, return its OUI — the first 3
 * bytes (6 hex chars, lowercase). Else null (e.g. the Steam Controller's
 * "FXB99…" product serial isn't a MAC). Used to tell a Bluetooth pad (has a
 * MAC) from a USB one (no serial) for the transport column — NOT for vendor
 * lookup: genuine PlayStation pads carry a Foxconn OUI, not Sony's, and the
 * GameSir clones' OUIs aren't in any registry, so OUI→vendor is unreliable
 * (see [[controller-identity]] memory). Per-unit identity comes from the full
 * MAC, which is solid.
 */
function macHex(serial) {
  if (!serial) return null;
  const s = String(serial).trim();
  // Accept ONLY a bare 12-hex string or a separated aa:bb:.. / aa-bb-.. form.
  // Don't strip-then-measure: a product serial like "FXB9960202571" reduces to
  // 12 hex chars by accident and must NOT be mistaken for a MAC.
  if (/^[0-9a-fA-F]{12}$/.test(s)) return s.toLowerCase();
  if (/^([0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}$/.test(s)) return s.replace(/[:-]/g, '').toLowerCase();
  return null;
}

export function macOui(serial) {
  const hex = macHex(serial);
  return hex ? hex.slice(0, 6) : null;
}

/** True if this serial is a Bluetooth MAC (vs a USB/product serial or none). */
export function isMacSerial(serial) {
  return macHex(serial) != null;
}

/** Format a Bluetooth MAC serial as aa:bb:cc:dd:ee:ff; pass non-MAC serials through. */
export function formatSerial(serial) {
  if (!serial) return null;
  const hex = macHex(serial);
  return hex ? hex.match(/../g).join(':') : String(serial);
}

// NOTE: OUI→vendor clone detection was evaluated and DROPPED — genuine
// PlayStation controllers carry a Foxconn (Hon Hai) OUI, not Sony's, and the
// GameSir clones' OUIs aren't in any public registry, so the heuristic isn't
// worth its weight. The full MAC remains a solid per-unit identifier. If a
// vendor lookup is ever wanted, inject one (see [[controller-identity]] for
// the layered design + the parked "OUI web API" idea).

export class ControllerInventory {
  /** @param {{now?: () => number}} [opts] inject a clock for deterministic tests */
  constructor({ now = () => Date.now() } = {}) {
    this._now = now;
    this._records = new Map(); // key -> record
  }

  /**
   * Find an existing record this observation should merge into — the same
   * physical controller seen via another transport, or a vid:pid sighting
   * for a pad we already know by serial. Returns null when it should be a
   * new record (including the ambiguous identical-pads case).
   */
  _findMergeTarget(n, candidateKey) {
    const exact = this._records.get(candidateKey);
    if (exact) return exact;
    if (n.vendorId == null || n.productId == null) return null;
    const sameVp = [...this._records.values()].filter(
      (r) => r.vendorId === n.vendorId && r.productId === n.productId,
    );
    if (sameVp.length !== 1) return null; // none, or ambiguous (identical pads)
    const cand = sameVp[0];
    // Never merge two DIFFERENT serials — those are distinct physical units.
    if (n.serialNumber && cand.serialNumber && n.serialNumber !== cand.serialNumber) return null;
    return cand;
  }

  /** Re-key a record (e.g. a vid:pid record gains a serial → becomes per-unit). */
  _rekey(rec, newKey) {
    if (rec.key === newKey) return;
    this._records.delete(rec.key);
    rec.key = newKey;
    this._records.set(newKey, rec);
  }

  /** Record that a controller is connected (new or returning). */
  observeConnect(descriptor) {
    const n = normalizeDescriptor(descriptor);
    const candidateKey = identityKey(n);
    const t = this._now();
    const target = this._findMergeTarget(n, candidateKey);

    if (!target) {
      const rec = {
        key: candidateKey,
        vendorId: n.vendorId,
        productId: n.productId,
        name: n.productName,
        serialNumber: n.serialNumber,
        capabilities: capabilitiesFor(n.entry),
        transports: new Set([n.source]),
        firstSeen: t,
        lastConnected: t,
        lastDisconnected: null,
        connected: true,
        connectCount: 1,
      };
      this._records.set(candidateKey, rec);
      return rec;
    }

    // Merge into the existing record.
    target.connected = true;
    target.lastConnected = t;
    target.connectCount += 1;
    target.transports.add(n.source);
    if (n.serialNumber && !target.serialNumber) {
      target.serialNumber = n.serialNumber;
      this._rekey(target, `serial:${n.serialNumber}`); // upgrade to per-unit identity
    }
    if (n.productName && (!target.name || target.name === 'unknown')) target.name = n.productName;
    if (n.entry) target.capabilities = capabilitiesFor(n.entry);
    return target;
  }

  /** Record that a controller disconnected. */
  observeDisconnect(descriptor) {
    const n = normalizeDescriptor(descriptor);
    const target = this._findMergeTarget(n, identityKey(n));
    if (!target) return null;
    target.connected = false;
    target.lastDisconnected = this._now();
    return target;
  }

  get(key) { return this._records.get(key) || null; }

  /** All records; connected first, then most-recently-connected. */
  list({ connectedFirst = true } = {}) {
    const arr = [...this._records.values()];
    arr.sort((a, b) => {
      if (connectedFirst && a.connected !== b.connected) return a.connected ? -1 : 1;
      return (b.lastConnected || 0) - (a.lastConnected || 0);
    });
    return arr;
  }

  /** Serializable snapshot for persistence (localStorage / userData file). */
  toJSON() {
    return {
      version: 1,
      records: [...this._records.values()].map((r) => ({ ...r, transports: [...r.transports] })),
    };
  }

  /**
   * Restore history. Loaded records start DISCONNECTED — nothing is live
   * until a fresh observeConnect this session — but keep their firstSeen /
   * lastConnected / lastDisconnected / connectCount.
   */
  loadJSON(data) {
    if (!data || !Array.isArray(data.records)) return;
    for (const r of data.records) {
      if (!r || !r.key) continue;
      this._records.set(r.key, {
        ...r,
        transports: new Set(r.transports || []),
        connected: false,
      });
    }
  }

  clear() { this._records.clear(); }
}
