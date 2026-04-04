// ============================================================
// NINTENDO SWITCH PRO CONTROLLER DRIVER
// ============================================================

import { ControllerDriver } from './base-driver.js';

export class SwitchProDriver extends ControllerDriver {

  static get vendorId() { return 0x057e; }
  static get productIds() { return [0x2009]; }
  static get driverName() { return 'Switch Pro'; }
  static get gamepadIdPattern() { return /pro controller|057e.*2009|nintendo/i; }

  static get capabilities() {
    return { gyro: true, accel: true, touchpad: false };
  }

  // No usagePage/usage filter — the Gamepad API claims the gamepad interface
  // exclusively on macOS Chrome. Using vendor+product only lets the picker
  // show any available HID interface for this device.
  static get hidFilters() {
    return this.productIds.map(productId => ({
      vendorId: this.vendorId,
      productId
    }));
  }

  constructor(device, connectionType) {
    super(device, connectionType);
    this._packetNumber = 0;
    this._debugCount = 0;
    this._reportIds = new Set();
    this._initSuccess = false;
  }

  /**
   * Switch Pro requires sub-commands to enable IMU and full report mode.
   * Retries up to 3 times with increasing delays since the device may
   * not be ready for commands immediately after USB enumeration.
   */
  async init() {
    const MAX_ATTEMPTS = 3;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        // Wait before sending commands — device needs time after open()
        await SwitchProDriver._delay(attempt === 1 ? 200 : 500);

        // Enable IMU (sub-command 0x40, arg 0x01)
        await this._sendSubCommand(0x40, [0x01]);
        await SwitchProDriver._delay(150);

        // Set input report mode to 0x30 (full report with IMU)
        await this._sendSubCommand(0x03, [0x30]);
        await SwitchProDriver._delay(150);

        this._initSuccess = true;
        console.log('Switch Pro Controller: IMU enabled, full report mode set (attempt ' + attempt + ')');
        return;
      } catch (err) {
        console.warn('Switch Pro init attempt ' + attempt + '/' + MAX_ATTEMPTS + ' failed:', err.message);
        if (attempt < MAX_ATTEMPTS) {
          await SwitchProDriver._delay(500);
        }
      }
    }

    console.error('Switch Pro init failed after ' + MAX_ATTEMPTS + ' attempts');
  }

  destroy() {
    this._initSuccess = false;
  }

  parseReport(reportId, data) {
    // Log new report IDs for debugging
    if (!this._reportIds.has(reportId)) {
      this._reportIds.add(reportId);
      console.log('Switch Pro: new report ID 0x' + reportId.toString(16) +
        ', length=' + data.byteLength);
    }
    if (this._debugCount < 5) {
      this._debugCount++;
      const bytes = [];
      for (let i = 0; i < Math.min(data.byteLength, 50); i++) {
        bytes.push(data.getUint8(i).toString(16).padStart(2, '0'));
      }
      console.log('Switch Pro report 0x' + reportId.toString(16) +
        ' [' + data.byteLength + ' bytes]: ' + bytes.join(' '));
    }

    // Full report mode uses report ID 0x30
    if (reportId !== 0x30) return null;

    // Report 0x30 layout (DataView excludes report ID):
    // Byte 0: timer
    // Byte 1: battery + connection info
    // Bytes 2-4: button status (3 bytes)
    // Bytes 5-7: left stick (3 bytes packed)
    // Bytes 8-10: right stick (3 bytes packed)
    // Byte 11: vibrator input report
    // Byte 12: padding
    // Bytes 13-48: 3 IMU frames × 12 bytes each
    //
    // Each IMU frame (12 bytes):
    //   [accelX(2), accelY(2), accelZ(2), gyroX(2), gyroY(2), gyroZ(2)]

    if (data.byteLength < 49) {
      if (this._debugCount <= 20) {
        console.warn('Switch Pro: report too short:', data.byteLength);
      }
      return null;
    }

    // IMU data starts at offset 12 (no padding byte after vibrator report)
    // Frame 0: offset 12, Frame 1: offset 24, Frame 2: offset 36
    const imuOffset = 12;

    const r = ControllerDriver.readSigned16;

    // Raw IMU values (Switch Pro physical axes: X=forward, Y=right, Z=up)
    const rawAccelX = r(data, imuOffset);
    const rawAccelY = r(data, imuOffset + 2);
    const rawAccelZ = r(data, imuOffset + 4);
    const rawGyroX = r(data, imuOffset + 6);
    const rawGyroY = r(data, imuOffset + 8);
    const rawGyroZ = r(data, imuOffset + 10);

    // Remap axes to match DualSense convention so the game's steering (gz)
    // and drift correction (atan2(accelX, accelY)) work unchanged.
    // Switch Pro: gyro Y = roll, DualSense: gyro Z = roll
    // Switch Pro: accel Y = lateral, accel Z = gravity
    // DualSense:  accel X = lateral, accel Y = gravity
    return {
      gyro: { x: rawGyroX, y: rawGyroZ, z: rawGyroY },
      accel: { x: -rawAccelY, y: rawAccelZ, z: rawAccelX },
      touchpad: null,
      touchpadButton: false,
      gyroScale: 2000.0 / 32768.0,
      accelScale: 1.0 / 4096.0
    };
  }

  static detectConnectionType(device) {
    return 'usb';
  }

  // ── Sub-command protocol ──

  async _sendSubCommand(subCmd, args = []) {
    // Output report 0x01: rumble + sub-command
    // Padded to 49 bytes (some firmware requires fixed report size)
    const buf = new Uint8Array(49);
    buf[0] = this._packetNumber & 0x0F;
    this._packetNumber = (this._packetNumber + 1) & 0x0F;

    // Neutral rumble data (bytes 1-8)
    buf[1] = 0x00; buf[2] = 0x01; buf[3] = 0x40; buf[4] = 0x40;
    buf[5] = 0x00; buf[6] = 0x01; buf[7] = 0x40; buf[8] = 0x40;

    buf[9] = subCmd;
    for (let i = 0; i < args.length; i++) {
      buf[10 + i] = args[i];
    }

    await this.device.sendReport(0x01, buf);
  }

  static _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
