// ============================================================
// DUALSENSE / DUALSHOCK 4 DRIVER
// ============================================================

import { ControllerDriver } from './base-driver.js';

export class DualSenseDriver extends ControllerDriver {

  static get vendorId() { return 0x054c; }
  static get productIds() { return [0x0ce6, 0x0df2, 0x05c4, 0x09cc]; }
  static get driverName() { return 'DualSense'; }
  static get gamepadIdPattern() { return /playstation|dualsense|dualshock|054c/i; }

  static get capabilities() {
    return { gyro: true, accel: true, touchpad: true };
  }

  // DualSense streams full reports by default — no init needed.

  parseReport(reportId, data) {
    let gyroOffset, touchOffset;

    if (this.connectionType === 'usb' && reportId === 0x01) {
      gyroOffset = 15;
      touchOffset = 32;
    } else if (this.connectionType === 'bluetooth' && reportId === 0x31) {
      gyroOffset = 16;
      touchOffset = 33;
    } else {
      return null;
    }

    const r = ControllerDriver.readSigned16;

    // Gyro (6 bytes) + Accel (6 bytes immediately after)
    const gyro = {
      x: r(data, gyroOffset),
      y: r(data, gyroOffset + 2),
      z: r(data, gyroOffset + 4)
    };
    const accel = {
      x: r(data, gyroOffset + 6),
      y: r(data, gyroOffset + 8),
      z: r(data, gyroOffset + 10)
    };

    // Touchpad — 2 touch points, 4 bytes each
    const touchpad = [
      DualSenseDriver._parseTouchPoint(data, touchOffset),
      DualSenseDriver._parseTouchPoint(data, touchOffset + 4)
    ];

    // Touchpad button
    let touchpadButton = false;
    if (this.connectionType === 'usb') {
      touchpadButton = !!(data.getUint8(9) & 0x02);
    } else {
      touchpadButton = !!(data.getUint8(10) & 0x02);
    }

    return {
      gyro,
      accel,
      touchpad,
      touchpadButton,
      gyroScale: 2000.0 / 32768.0,   // ±2000 dps, 16-bit
      accelScale: 1.0 / 8192.0        // ±2g, 16-bit (gravity ~8192)
    };
  }

  static detectConnectionType(device) {
    for (const col of device.collections) {
      if (col.outputReports && col.outputReports.length > 0) {
        for (const report of col.outputReports) {
          if (report.reportId === 0x31) return 'bluetooth';
        }
      }
    }
    return 'usb';
  }

  static _parseTouchPoint(data, offset) {
    if (offset + 4 > data.byteLength) return { active: false, id: 0, x: 0, y: 0 };
    const b0 = data.getUint8(offset);
    const b1 = data.getUint8(offset + 1);
    const b2 = data.getUint8(offset + 2);
    const b3 = data.getUint8(offset + 3);
    return {
      active: !(b0 & 0x80),
      id: b0 & 0x7F,
      x: b1 | ((b2 & 0x0F) << 8),
      y: ((b2 & 0xF0) >> 4) | (b3 << 4)
    };
  }
}
