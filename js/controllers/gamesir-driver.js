// ============================================================
// GAMESIR NOVA SUPER CONTROLLER DRIVER
// ============================================================
//
// Handles GameSir controllers in native/DirectInput mode (VID 0x3537).
// When the Nova Super is in Switch Pro mode it spoofs VID 0x057e:0x2009
// and is handled by SwitchProDriver instead.
//
// The native GameSir HID protocol is not fully documented, so this
// driver includes aggressive debug logging to map out report layout.
// IMU parsing offsets were determined empirically — adjust as needed.

import { ControllerDriver } from './base-driver.js';

export class GameSirDriver extends ControllerDriver {

  static get vendorId() { return 0x3537; }
  static get productIds() { return [0x100e, 0x0093, 0x0094, 0x0099, 0x1099]; }
  static get driverName() { return 'GameSir Nova'; }
  static get gamepadIdPattern() { return /gamesir|nova|3537/i; }

  static get capabilities() {
    return { gyro: true, accel: true, touchpad: false };
  }

  // Accept any HID interface — don't restrict by usagePage/usage
  // since the native GameSir protocol may use a non-standard usage.
  static get hidFilters() {
    return this.productIds.map(productId => ({
      vendorId: this.vendorId,
      productId
    }));
  }

  constructor(device, connectionType) {
    super(device, connectionType);
    this._debugCount = 0;
    this._reportIds = new Set();
    this._maxDebugReports = 40;
    this._imuFound = false;
  }

  /**
   * Attempt to enable IMU if the controller requires init commands.
   * GameSir native mode may need specific enable sequences — we try
   * common patterns and log results.
   */
  async init() {
    console.log('GameSir Nova: connected in', this.connectionType, 'mode');
    console.log('GameSir Nova: device productName =', this.device.productName);
    console.log('GameSir Nova: collections =', this.device.collections.length);

    // Log collection details to help identify report structure
    for (const col of this.device.collections) {
      console.log('  Collection: usagePage=0x' + col.usagePage.toString(16) +
        ' usage=0x' + col.usage.toString(16));
      if (col.inputReports) {
        for (const r of col.inputReports) {
          console.log('    InputReport: id=0x' + r.reportId.toString(16));
        }
      }
      if (col.outputReports) {
        for (const r of col.outputReports) {
          console.log('    OutputReport: id=0x' + r.reportId.toString(16));
        }
      }
    }

    // Inspect report descriptors to find expected sizes
    for (const col of this.device.collections) {
      if (col.inputReports) {
        for (const r of col.inputReports) {
          const bits = (r.items || []).reduce((sum, item) => sum + (item.reportSize || 0) * (item.reportCount || 0), 0);
          console.log('  InputReport 0x' + r.reportId.toString(16) +
            ': items=' + (r.items || []).length + ', ~' + Math.ceil(bits / 8) + ' bytes');
          (r.items || []).forEach((item, i) => {
            console.log('    item[' + i + ']: size=' + item.reportSize +
              ' count=' + item.reportCount +
              ' usagePage=0x' + (item.usageMinimum !== undefined ? 'range' : (item.usages || []).map(u => u.toString(16)).join(',')) +
              ' logMin=' + item.logicalMinimum + ' logMax=' + item.logicalMaximum);
          });
        }
      }
      if (col.outputReports) {
        for (const r of col.outputReports) {
          const bits = (r.items || []).reduce((sum, item) => sum + (item.reportSize || 0) * (item.reportCount || 0), 0);
          console.log('  OutputReport 0x' + r.reportId.toString(16) +
            ': items=' + (r.items || []).length + ', ~' + Math.ceil(bits / 8) + ' bytes');
          (r.items || []).forEach((item, i) => {
            console.log('    item[' + i + ']: size=' + item.reportSize +
              ' count=' + item.reportCount);
          });
        }
      }
    }

    // Output report is 63 bytes. Try various enable commands.
    const commands = [
      // [description, byte0, byte1, ...]
      ['enable 0x01', 0x01],
      ['enable 0x02', 0x02],
      ['enable 0x04', 0x04],
      ['mode switch 0x05,0x01', 0x05, 0x01],
      ['imu enable 0x06,0x01', 0x06, 0x01],
      ['handshake 0xA1', 0xA1],
      ['handshake 0xA2', 0xA2],
      ['query 0x12', 0x12],
    ];

    for (const [desc, ...payload] of commands) {
      try {
        const buf = new Uint8Array(63);
        for (let i = 0; i < payload.length; i++) buf[i] = payload[i];
        await this.device.sendReport(0x05, buf);
        console.log('GameSir Nova: sent ' + desc + ' — OK');
        await GameSirDriver._delay(50);
      } catch (e) {
        console.log('GameSir Nova: sent ' + desc + ' — FAILED: ' + e.message);
      }
    }

    // Try feature reports
    for (const fid of [0x01, 0x02, 0x03, 0x04, 0x05]) {
      try {
        const feature = await this.device.receiveFeatureReport(fid);
        const bytes = [];
        for (let i = 0; i < Math.min(feature.byteLength, 48); i++) {
          bytes.push(feature.getUint8(i).toString(16).padStart(2, '0'));
        }
        console.log('GameSir Nova: featureReport 0x' + fid.toString(16) +
          ' [' + feature.byteLength + 'B]: ' + bytes.join(' '));
      } catch (e) {
        // silent
      }
    }

    console.log('GameSir Nova: init done — try pressing buttons/moving sticks!');
  }

  static _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  destroy() {}

  parseReport(reportId, data) {
    // Track unique report IDs
    if (!this._reportIds.has(reportId)) {
      this._reportIds.add(reportId);
      console.log('GameSir Nova: new report ID 0x' + reportId.toString(16) +
        ', length=' + data.byteLength);
    }

    // Debug: hex-dump first N reports to map out the format
    if (this._debugCount < this._maxDebugReports) {
      this._debugCount++;
      const bytes = [];
      for (let i = 0; i < Math.min(data.byteLength, 64); i++) {
        bytes.push(data.getUint8(i).toString(16).padStart(2, '0'));
      }
      console.log('GameSir report 0x' + reportId.toString(16) +
        ' [' + data.byteLength + 'B]: ' + bytes.join(' '));

      // Look for potential IMU data — scan for int16 pairs that look like
      // accelerometer (~0 on X/Z, ~8192 or ~-8192 on gravity axis) when still
      if (data.byteLength >= 20 && !this._imuFound) {
        this._scanForIMU(data);
      }
    }

    // ── Attempt IMU parse ──
    // These offsets are initial guesses based on common HID gamepad layouts.
    // Adjust once actual report structure is confirmed via debug logs.
    //
    // Many GameSir controllers in native mode use a report format where:
    //   Bytes 0-9: buttons + sticks
    //   Bytes 10+: extended data (may include IMU)
    //
    // If the report is too short or doesn't contain IMU, return null
    // to avoid feeding garbage to the gyro scene.

    if (data.byteLength < 24) return null;

    // Try to parse IMU from a plausible offset.
    // Common layout: accel(6 bytes) then gyro(6 bytes) or vice-versa.
    // We'll try offset 12 as a starting guess (after buttons+sticks).
    const imuOffset = this._guessIMUOffset(data);
    if (imuOffset < 0) return null;

    const r = ControllerDriver.readSigned16;

    const rawGyroX = r(data, imuOffset);
    const rawGyroY = r(data, imuOffset + 2);
    const rawGyroZ = r(data, imuOffset + 4);
    const rawAccelX = r(data, imuOffset + 6);
    const rawAccelY = r(data, imuOffset + 8);
    const rawAccelZ = r(data, imuOffset + 10);

    if (this._debugCount <= 5) {
      console.log('GameSir IMU (offset ' + imuOffset + '): gyro=(' +
        rawGyroX + ',' + rawGyroY + ',' + rawGyroZ +
        ') accel=(' + rawAccelX + ',' + rawAccelY + ',' + rawAccelZ + ')');
    }

    return {
      gyro: { x: rawGyroX, y: rawGyroY, z: rawGyroZ },
      accel: { x: rawAccelX, y: rawAccelY, z: rawAccelZ },
      touchpad: null,
      touchpadButton: false,
      gyroScale: 2000.0 / 32768.0,   // ±2000 dps default — adjust per datasheet
      accelScale: 1.0 / 8192.0        // ±2g default — adjust per datasheet
    };
  }

  /**
   * Heuristic: guess where IMU data starts in the report.
   * Looks for a 12-byte region containing plausible signed16 IMU values.
   * Returns byte offset or -1 if nothing looks right.
   */
  _guessIMUOffset(data) {
    // If we've already locked an offset, reuse it
    if (this._lockedIMUOffset !== undefined) return this._lockedIMUOffset;

    const r = ControllerDriver.readSigned16;
    const len = data.byteLength;

    // Scan for accelerometer signature: when controller is still, one axis
    // should read ~±4096..16384 (gravity) while the others are near zero.
    for (let off = 6; off + 12 <= len; off++) {
      const v0 = r(data, off);
      const v1 = r(data, off + 2);
      const v2 = r(data, off + 4);
      const v3 = r(data, off + 6);
      const v4 = r(data, off + 8);
      const v5 = r(data, off + 10);

      // Check for accelerometer-like pattern in first or second triplet
      if (this._looksLikeAccel(v0, v1, v2) || this._looksLikeAccel(v3, v4, v5)) {
        console.log('GameSir Nova: locked IMU offset at byte ' + off);
        this._lockedIMUOffset = off;
        this._imuFound = true;
        return off;
      }
    }

    return -1;
  }

  /**
   * Check if three int16 values look like accelerometer data at rest.
   * Expect one axis near ±4096..16384 (gravity) and others near zero.
   */
  _looksLikeAccel(x, y, z) {
    const vals = [Math.abs(x), Math.abs(y), Math.abs(z)];
    vals.sort((a, b) => b - a); // descending
    // Largest should be in the gravity range, others should be small
    return vals[0] > 3000 && vals[0] < 20000 &&
           vals[1] < 2000 && vals[2] < 2000;
  }

  /**
   * Scan entire report for potential IMU regions and log candidates.
   */
  _scanForIMU(data) {
    const r = ControllerDriver.readSigned16;
    const candidates = [];
    for (let off = 0; off + 6 <= data.byteLength; off += 2) {
      const v0 = r(data, off);
      const v1 = r(data, off + 2);
      const v2 = r(data, off + 4);
      if (this._looksLikeAccel(v0, v1, v2)) {
        candidates.push({ offset: off, values: [v0, v1, v2] });
      }
    }
    if (candidates.length > 0) {
      console.log('GameSir Nova: accel candidates:', candidates);
    }
  }

  static detectConnectionType(device) {
    // Check for Bluetooth-specific output reports
    for (const col of device.collections) {
      if (col.outputReports && col.outputReports.length > 0) {
        for (const report of col.outputReports) {
          if (report.reportId === 0x31) return 'bluetooth';
        }
      }
    }
    return 'usb';
  }
}
