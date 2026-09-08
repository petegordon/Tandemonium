// ============================================================
// XBOX CONTROLLER DRIVER (stub — Gamepad API only, no WebHID features)
// ============================================================

import { ControllerDriver } from './base-driver.js';

// Identity lives in devices.js. Xbox has no WebHID features — all input
// flows through the standard Gamepad API.

export class XboxDriver extends ControllerDriver {
  parseReport() { return null; }
  static detectConnectionType() { return 'usb'; }
}
