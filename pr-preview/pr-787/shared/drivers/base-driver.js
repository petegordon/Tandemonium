// ============================================================
// BASE CONTROLLER DRIVER — protocol-implementation interface
// ============================================================
//
// Drivers are pure protocol implementations: parse HID reports, run any
// init handshakes, expose the connection type. Identity (vid:pid, name,
// capabilities, gamepad-id patterns, quirks) lives in ../devices.js;
// the dictionary entry is passed to the constructor and stored on the
// instance as `this.entry` for consumers that need to display the name
// or check capabilities.

export class ControllerDriver {
  // Whether the overlay should fan `inputreport` out to OTHER approved handles
  // sharing this device's vid:pid. Only true for controllers whose one physical
  // unit legitimately exposes several same-vid:pid interfaces (Steam Controller
  // Puck). Default false: for Sony pads a "sibling" same-vid:pid handle is a
  // DIFFERENT physical device (a real DS4 next to a DS4-spoofing GameSir), and
  // feeding its reports into this driver corrupts the stream — kills gyro.
  static needsSiblingFanout = false;

  /**
   * @param {HIDDevice} device — the WebHID device
   * @param {string} connectionType — 'usb' | 'bluetooth'
   * @param {object} [entry] — dictionary entry from devices.js (name,
   *   capabilities, mode, quirks, ...). Optional so drivers can still be
   *   instantiated directly in tests, but the registry always passes it.
   */
  constructor(device, connectionType, entry = null) {
    this.device = device;
    this.connectionType = connectionType;
    this.entry = entry;
  }

  // ── HID filter shape (override per protocol if needed) ──

  /**
   * Build the filter object passed to navigator.hid.requestDevice() for
   * a given vid:pid. Default: vendor+product+gamepad usage page (so the
   * picker only lists the gamepad interface, hiding e.g. the audio
   * interface on DualSense). Protocols whose Gamepad-API interface is
   * claimed exclusively (Switch Pro on macOS Chrome) should override
   * to return just `{ vendorId, productId }`.
   *
   * @param {number} vendorId
   * @param {number} productId
   * @returns {{vendorId: number, productId: number, usagePage?: number, usage?: number}}
   */
  static makeHidFilter(vendorId, productId) {
    return { vendorId, productId, usagePage: 0x0001, usage: 0x0005 };
  }

  // ── Lifecycle ──

  /** Send any init commands needed (e.g., Switch Pro IMU enable). No-op by default. */
  async init() {}

  /** Clean up event listeners. */
  destroy() {}

  // ── Report parsing ──

  /**
   * Parse a HID input report into a unified data shape.
   * @param {number} reportId
   * @param {DataView} data
   * @returns {ParsedReport|null} null if report is not relevant
   *
   * ParsedReport shape:
   * {
   *   gyro:       { x, y, z } | null,       // raw signed16 values
   *   accel:      { x, y, z } | null,        // raw signed16 values
   *   touchpad:   [{ active, id, x, y }] | null,
   *   gyroScale:  number,                     // raw → degrees/sec multiplier
   *   accelScale: number                      // raw → g multiplier
   * }
   */
  parseReport(reportId, data) { return null; }

  // ── Connection type detection ──

  /**
   * Detect USB vs Bluetooth from device collections.
   * @param {HIDDevice} device
   * @returns {string} 'usb' or 'bluetooth'
   */
  static detectConnectionType(device) { return 'usb'; }

  // ── Shared utilities ──

  static readSigned16(data, offset) {
    let val = data.getUint8(offset) | (data.getUint8(offset + 1) << 8);
    if (val > 0x7FFF) val -= 0x10000;
    return val;
  }
}
