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
   * @returns {Promise<HIDDevice|null>}
   */
  static async findApprovedDevice(capability) {
    if (!navigator.hid) return null;
    const devices = await navigator.hid.getDevices();
    for (const device of devices) {
      const D = ControllerRegistry.getDriver(device.vendorId, device.productId);
      if (D && D.capabilities[capability]) return device;
    }
    return null;
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
