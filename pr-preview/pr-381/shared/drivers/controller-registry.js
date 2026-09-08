// ============================================================
// CONTROLLER REGISTRY — DEVICES-dictionary-backed lookup + connect
// ============================================================
//
// All identity (vid, pid, name, capability flags, gamepad-id patterns,
// quirks) lives in ../devices.js. This file only provides the lookup
// surface that callers use: getEntry / getDriver / identifyFromGamepadId
// / getGamepadQuirks / getHIDFilters / findApprovedDevice / connect.
//
// To add a new controller that speaks an existing protocol: add an entry
// to DEVICES. To add a new protocol: write a driver class under ./ and
// register it in the PROTOCOLS map in devices.js.

import { DEVICES, PROTOCOLS } from '../devices.js';

export class ControllerRegistry {

  /**
   * Find the primary (first-registered) dictionary entry for a vid:pid.
   * When multiple entries share a vid:pid (clones spoofing another's USB
   * identity), this returns whichever was declared first — the convention
   * is that the "real" Sony/Nintendo/etc. entry is first, with clones
   * after. Callers that need to present a chooser should use
   * `getAllEntries` instead.
   *
   * @param {number} vendorId
   * @param {number} productId
   * @returns {object|null}
   */
  static getEntry(vendorId, productId) {
    for (const e of DEVICES) {
      if (e.vendorId === vendorId && e.productId === productId) return e;
    }
    return null;
  }

  /**
   * Return EVERY dictionary entry matching a vid:pid. Used by the Test
   * Report wizard's spoof picker so the user can tell us "this 054c:09cc
   * is actually a GameSir Super Nova, not a real Sony DS4 v2" — vital
   * because we can't auto-distinguish at the USB level.
   *
   * @param {number} vendorId
   * @param {number} productId
   * @returns {object[]}
   */
  static getAllEntries(vendorId, productId) {
    return DEVICES.filter(e => e.vendorId === vendorId && e.productId === productId);
  }

  /**
   * Find entries whose vid:pid AND imuSignature match. Called by the
   * overlay after the PlayStation driver's IMU probe identifies the
   * family at runtime — narrows getAllEntries() down to entries that
   * actually match the observed wire-level layout, so a GameSir clone
   * spoofing Sony's PID can pick its own entry (and therefore its own
   * controllerProfile / GLB) without user input.
   *
   * @param {number} vendorId
   * @param {number} productId
   * @param {string} imuSignature — e.g. 'sony-ds5' | 'sony-ds4' | 'gamesir-ds4'
   * @returns {object[]}
   */
  static getEntriesByImuFamily(vendorId, productId, imuSignature) {
    return DEVICES.filter(e =>
      e.vendorId === vendorId &&
      e.productId === productId &&
      e.imuSignature === imuSignature
    );
  }

  /**
   * Find the driver class for a vid:pid. Returns the protocol implementation
   * (PlayStationDriver, SwitchProDriver, etc.) or null.
   * @returns {typeof ControllerDriver|null}
   */
  static getDriver(vendorId, productId) {
    const entry = ControllerRegistry.getEntry(vendorId, productId);
    return entry ? (PROTOCOLS[entry.protocol] || null) : null;
  }

  /**
   * Build WebHID filter array for navigator.hid.requestDevice(). Only
   * includes entries with at least one WebHID capability (gyro, accel,
   * touchpad) — adding usage-less devices like Xbox stubs would pull in
   * non-gamepad HID devices from the same vendor.
   *
   * Default filter shape is bare vendor+product. Protocols that need a
   * tighter filter (e.g. DualSense limits to the gamepad usage page so
   * the picker doesn't list the audio interface) override `makeHidFilter`
   * on their driver class.
   */
  static getHIDFilters() {
    const filters = [];
    for (const entry of DEVICES) {
      const caps = entry.capabilities;
      if (!caps.gyro && !caps.accel && !caps.touchpad) continue;
      const Driver = PROTOCOLS[entry.protocol];
      if (!Driver) continue;
      filters.push(Driver.makeHidFilter(entry.vendorId, entry.productId));
    }
    return filters;
  }

  /**
   * Identify a controller from the Gamepad API id string. Walks DEVICES
   * in two passes: variants first (entries with a `gamepadIdMatch`
   * secondary filter), then defaults. Variants-first is what lets a
   * specific entry (e.g. GameSir Cyclone) claim a Gamepad-API id before
   * the broader entry it shares vid:pid with (Switch Pro) sees it.
   *
   * @param {string} idString
   * @returns {{ driverName: string, protocol: string, hasGyro: boolean, hasTouchpad: boolean, hasAccel: boolean }|null}
   */
  static identifyFromGamepadId(idString) {
    if (!idString) return null;

    const toResult = (entry) => ({
      driverName: entry.name,
      protocol: entry.protocol,
      // The visualizer profile key. Defaults to protocol so existing
      // entries (Sony DS4/DS5 → 'dualsense', Switch Pro → 'switch-pro')
      // keep loading the same GLB models. Override per-entry to point a
      // clone at a controller-specific GLB.
      controllerProfile: entry.controllerProfile || entry.protocol,
      hasGyro: entry.capabilities.gyro,
      hasTouchpad: entry.capabilities.touchpad,
      hasAccel: entry.capabilities.accel,
    });

    // Pass 1: variants — must satisfy both primary AND secondary patterns
    for (const entry of DEVICES) {
      if (!entry.gamepadIdMatch) continue;
      if (!entry.gamepadIdPattern.test(idString)) continue;
      if (!entry.gamepadIdMatch.test(idString)) continue;
      return toResult(entry);
    }
    // Pass 2: EXACT vid:pid among default entries. Sony DualSense and DualShock 4
    // (v1 05c4 / v2 09cc) all share ONE PLAYSTATION_ID pattern, so a bare
    // first-pattern-match returns DualSense for EVERY Sony pad — mislabeling a
    // DS4 (05c4) as "DualSense". The vid:pid in the id string disambiguates them;
    // variants that share a vid:pid are already resolved by Pass 1.
    const vp = ControllerRegistry.parseGamepadVendorProduct(idString);
    if (vp) {
      for (const entry of DEVICES) {
        if (entry.gamepadIdMatch) continue;
        if (entry.vendorId !== vp.vendorId || entry.productId !== vp.productId) continue;
        if (!entry.gamepadIdPattern.test(idString)) continue;
        return toResult(entry);
      }
    }
    // Pass 3: first default pattern match (fallback when the id carries no
    // recognisable vid:pid, or the pid isn't in the dictionary).
    for (const entry of DEVICES) {
      if (entry.gamepadIdMatch) continue;
      if (!entry.gamepadIdPattern.test(idString)) continue;
      return toResult(entry);
    }
    return null;
  }

  /**
   * Merged per-id quirk flags. Walks DEVICES, returns the union of `quirks`
   * from every entry whose patterns match the id string. Used so consumers
   * with device variants (GameSir Cyclone's swapped A/B, future quirks)
   * don't re-implement the id pattern checks themselves.
   *
   * @param {string} idString
   * @returns {{ swapAB?: boolean }}
   */
  static getGamepadQuirks(idString) {
    if (!idString) return {};
    const out = {};
    for (const entry of DEVICES) {
      if (!entry.quirks) continue;
      if (!entry.gamepadIdPattern.test(idString)) continue;
      if (entry.gamepadIdMatch && !entry.gamepadIdMatch.test(idString)) continue;
      Object.assign(out, entry.quirks);
    }
    return out;
  }

  /** True if the device's vid:pid is known to the dictionary. */
  static isKnownDevice(device) {
    return !!ControllerRegistry.getEntry(device.vendorId, device.productId);
  }

  /**
   * Find a previously-approved device from navigator.hid.getDevices()
   * that matches a known entry with the requested capability.
   *
   * @param {string} capability — 'gyro' | 'accel' | 'touchpad'
   * @param {{vendorId?: number, productId?: number}} [filter] — optional
   *   vendor/product filter so a caller can demand a SPECIFIC physical
   *   device rather than "any approved gyro device" (critical for local
   *   multiplayer where two controllers are attached and each player
   *   needs their own gyro pipeline wired to the correct physical pad).
   * @param {HIDDevice[]} [excludeDevices] — HID devices to skip (already
   *   claimed by another player). When two identical controllers are
   *   connected, vendorId/productId can't distinguish them; this
   *   exclude list is the only way to ensure P2 lands on a different
   *   physical device than P1.
   * @returns {Promise<HIDDevice|null>}
   */
  static async findApprovedDevice(capability, filter = null, excludeDevices = []) {
    if (!navigator.hid) return null;
    const devices = await navigator.hid.getDevices();
    for (const device of devices) {
      if (excludeDevices.length > 0 && excludeDevices.includes(device)) continue;
      const entry = ControllerRegistry.getEntry(device.vendorId, device.productId);
      if (!entry || !entry.capabilities[capability]) continue;
      if (filter) {
        if (filter.vendorId !== undefined && device.vendorId !== filter.vendorId) continue;
        if (filter.productId !== undefined && device.productId !== filter.productId) continue;
      }
      return device;
    }
    return null;
  }

  /**
   * Parse the vendor and product IDs out of a Gamepad API `gamepad.id`
   * string. Browsers format these as e.g.
   *   "DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)"
   * Helper for callers that want to pass them as a filter to
   * findApprovedDevice() or navigator.hid.requestDevice().
   *
   * @param {string} idString
   * @returns {{vendorId: number, productId: number}|null}
   */
  static parseGamepadVendorProduct(idString) {
    if (!idString) return null;
    const m = String(idString).match(/Vendor:\s*([0-9a-fA-F]+)\s+Product:\s*([0-9a-fA-F]+)/);
    if (!m) return null;
    const vendorId = parseInt(m[1], 16);
    const productId = parseInt(m[2], 16);
    if (Number.isNaN(vendorId) || Number.isNaN(productId)) return null;
    return { vendorId, productId };
  }

  /**
   * Connect to an HID device: look up the entry, instantiate the protocol
   * driver, init it. The dictionary entry is attached to the driver instance
   * as `driver.entry` so consumers can read `driver.entry.name` and
   * `driver.entry.capabilities` without going back through the registry.
   *
   * @param {HIDDevice} device
   * @returns {Promise<ControllerDriver>}
   * @throws {Error} if no matching entry found
   */
  static async connect(device) {
    const entry = ControllerRegistry.getEntry(device.vendorId, device.productId);
    if (!entry) {
      throw new Error('No driver for device ' + device.vendorId.toString(16) + ':' + device.productId.toString(16));
    }
    const Driver = PROTOCOLS[entry.protocol];
    if (!Driver) {
      throw new Error('Unknown protocol "' + entry.protocol + '" for ' + entry.name);
    }

    if (!device.opened) await device.open();

    const connType = Driver.detectConnectionType(device);
    const driver = new Driver(device, connType, entry);
    await driver.init();

    console.log('Controller connected:', entry.name, '(' + connType + ')', device.productName);
    return driver;
  }
}
