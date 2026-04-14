// ============================================================
// CONTROLLER REGISTRY — auto-detection, driver lookup, connection
// ============================================================

import { DualSenseDriver } from './dualsense-driver.js';
import { SwitchProDriver } from './switch-pro-driver.js';
import { XboxDriver } from './xbox-driver.js';

const DRIVERS = [DualSenseDriver, SwitchProDriver, XboxDriver];

export class ControllerRegistry {

  /**
   * Find a driver class by vendor + product ID.
   * @returns {typeof ControllerDriver|null}
   */
  static getDriver(vendorId, productId) {
    for (const D of DRIVERS) {
      if (D.vendorId === vendorId && D.productIds.includes(productId)) return D;
    }
    return null;
  }

  /**
   * Build WebHID filter array for requestDevice().
   * Only includes drivers that have at least one WebHID capability (gyro, accel, touchpad).
   * @returns {Array<{vendorId: number, productId: number, usagePage: number, usage: number}>}
   */
  static getHIDFilters() {
    const filters = [];
    for (const D of DRIVERS) {
      const caps = D.capabilities;
      if (!caps.gyro && !caps.accel && !caps.touchpad) continue;
      filters.push(...D.hidFilters);
    }
    return filters;
  }

  /**
   * Identify a controller from the Gamepad API id string.
   * @param {string} idString — e.g. "DualSense Wireless Controller"
   * @returns {{ driverName: string, hasGyro: boolean, hasTouchpad: boolean, hasAccel: boolean }|null}
   */
  static identifyFromGamepadId(idString) {
    if (!idString) return null;
    for (const D of DRIVERS) {
      if (D.gamepadIdPattern.test(idString)) {
        const caps = D.capabilities;
        return {
          driverName: D.driverName,
          hasGyro: caps.gyro,
          hasTouchpad: caps.touchpad,
          hasAccel: caps.accel
        };
      }
    }
    return null;
  }

  /**
   * Return per-id quirk flags by dispatching to each registered driver's
   * `getGamepadQuirks(idString)`. Used so callers that care about
   * device variants (GameSir Cyclone's swapped A/B, future quirks)
   * don't have to re-implement the id pattern checks themselves.
   *
   * @param {string} idString — gamepad.id from the Gamepad API
   * @returns {{ swapAB?: boolean }} merged quirks — `{}` when none apply
   */
  static getGamepadQuirks(idString) {
    if (!idString) return {};
    const out = {};
    for (const D of DRIVERS) {
      const q = D.getGamepadQuirks(idString);
      if (q) Object.assign(out, q);
    }
    return out;
  }

  /**
   * Check if a given HID device matches any registered driver with WebHID capabilities.
   * @param {HIDDevice} device
   * @returns {boolean}
   */
  static isKnownDevice(device) {
    return !!ControllerRegistry.getDriver(device.vendorId, device.productId);
  }

  /**
   * Find a previously-approved device from navigator.hid.getDevices()
   * that matches any registered driver with the requested capability.
   * @param {string} capability — 'gyro', 'accel', or 'touchpad'
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
      const D = ControllerRegistry.getDriver(device.vendorId, device.productId);
      if (!D || !D.capabilities[capability]) continue;
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
   * This helper extracts the hex values so callers can pass them as a
   * filter to findApprovedDevice() or navigator.hid.requestDevice().
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
   * Connect to an HID device: match the right driver, instantiate, init.
   * @param {HIDDevice} device
   * @returns {Promise<ControllerDriver>}
   * @throws {Error} if no matching driver found
   */
  static async connect(device) {
    const D = ControllerRegistry.getDriver(device.vendorId, device.productId);
    if (!D) throw new Error('No driver for device ' + device.vendorId.toString(16) + ':' + device.productId.toString(16));

    if (!device.opened) await device.open();

    const connType = D.detectConnectionType(device);
    const driver = new D(device, connType);
    await driver.init();

    console.log('Controller connected:', D.driverName, '(' + connType + ')', device.productName);
    return driver;
  }

  /** @returns {Array<typeof ControllerDriver>} all registered drivers */
  static get drivers() { return DRIVERS; }
}
