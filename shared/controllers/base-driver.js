// ============================================================
// BASE CONTROLLER DRIVER — abstract interface for WebHID controllers
// ============================================================

export class ControllerDriver {
  /**
   * @param {HIDDevice} device — the WebHID device
   * @param {string} connectionType — 'usb' or 'bluetooth'
   */
  constructor(device, connectionType) {
    this.device = device;
    this.connectionType = connectionType;
  }

  // ── Identity (override in subclass) ──

  /** @returns {number} USB vendor ID */
  static get vendorId() { return 0; }

  /** @returns {number[]} USB product IDs */
  static get productIds() { return []; }

  /** @returns {string} Human-readable name */
  static get driverName() { return 'Unknown'; }

  /** @returns {RegExp} Pattern to match Gamepad API id string */
  static get gamepadIdPattern() { return /^$/; }

  // ── Capabilities (override in subclass) ──

  static get capabilities() {
    return { gyro: false, accel: false, touchpad: false };
  }

  /**
   * HID filters for requestDevice(). Override per driver if needed.
   * Default: vendorId + productId + gamepad usage page.
   * @returns {Array<{vendorId: number, productId: number, usagePage?: number, usage?: number}>}
   */
  static get hidFilters() {
    return this.productIds.map(productId => ({
      vendorId: this.vendorId,
      productId,
      usagePage: 0x0001,
      usage: 0x0005
    }));
  }

  // ── Lifecycle ──

  /**
   * Send any init commands needed (e.g., Switch Pro IMU enable).
   * No-op by default.
   */
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
