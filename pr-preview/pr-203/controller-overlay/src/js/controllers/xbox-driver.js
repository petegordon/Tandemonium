// ============================================================
// XBOX CONTROLLER DRIVER (stub — Gamepad API only, no WebHID features)
// ============================================================

import { ControllerDriver } from './base-driver.js';

export class XboxDriver extends ControllerDriver {

  static get vendorId() { return 0x045e; }
  static get productIds() { return [0x0b12, 0x0b13, 0x02fd, 0x02e0, 0x028e]; }
  static get driverName() { return 'Xbox'; }
  static get gamepadIdPattern() { return /xbox|microsoft|045e/i; }

  static get capabilities() {
    return { gyro: false, accel: false, touchpad: false };
  }

  // No WebHID features — all input via standard Gamepad API
  parseReport() { return null; }

  static detectConnectionType() { return 'usb'; }
}
