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

  async init() {
    // Over Bluetooth, DualSense defaults to a compatibility mode that only
    // streams report 0x01 (sticks/buttons, no IMU). Reading feature report
    // 0x05 (calibration) switches it into full-report mode, after which it
    // streams 0x31 reports containing gyro and accel. Same trick used by
    // Linux's hid-playstation driver.
    if (this.connectionType === 'bluetooth') {
      try {
        await this.device.receiveFeatureReport(0x05);
        console.log('DualSense BT: enabled full report mode via feature 0x05');
      } catch (err) {
        console.warn('DualSense BT: feature 0x05 query failed:', err.message);
      }
    }
  }

  parseReport(reportId, data) {
    // USB 0x01 and BT 0x31 share a common input-report layout, shifted by
    // one byte: BT prefixes with a sequence/counter byte. baseOffset handles
    // the shift so everything downstream stays symmetric.
    let baseOffset, gyroOffset, touchOffset;

    if (this.connectionType === 'usb' && reportId === 0x01) {
      baseOffset = 0;
      gyroOffset = 15;
      touchOffset = 32;
    } else if (this.connectionType === 'bluetooth' && reportId === 0x31) {
      baseOffset = 1;
      gyroOffset = 16;
      touchOffset = 33;
    } else {
      return null;
    }

    const r = ControllerDriver.readSigned16;

    // ── Sticks (4 bytes, unsigned 0-255, center ~128) ──
    const rawLX = data.getUint8(baseOffset + 0);
    const rawLY = data.getUint8(baseOffset + 1);
    const rawRX = data.getUint8(baseOffset + 2);
    const rawRY = data.getUint8(baseOffset + 3);
    const sticks = {
      lx: (rawLX - 128) / 128,
      ly: (rawLY - 128) / 128,
      rx: (rawRX - 128) / 128,
      ry: (rawRY - 128) / 128,
    };

    // ── Triggers (analog 0-255 → 0-1) ──
    const triggers = {
      l2: data.getUint8(baseOffset + 4) / 255,
      r2: data.getUint8(baseOffset + 5) / 255,
    };

    // ── Buttons + dpad ──
    // byte +7: dpad nibble (0-7 = dir, 8 = neutral) | face buttons
    // byte +8: shoulders / options / stick clicks
    // byte +9: PS / touchpad click / mute
    const faceByte = data.getUint8(baseOffset + 7);
    const optByte  = data.getUint8(baseOffset + 8);
    const psByte   = data.getUint8(baseOffset + 9);

    const dpadDir = faceByte & 0x0F;
    const buttons = {
      square:   !!(faceByte & 0x10),
      cross:    !!(faceByte & 0x20),
      circle:   !!(faceByte & 0x40),
      triangle: !!(faceByte & 0x80),
      l1:       !!(optByte & 0x01),
      r1:       !!(optByte & 0x02),
      l2:       !!(optByte & 0x04),
      r2:       !!(optByte & 0x08),
      create:   !!(optByte & 0x10),
      options:  !!(optByte & 0x20),
      l3:       !!(optByte & 0x40),
      r3:       !!(optByte & 0x80),
      ps:       !!(psByte  & 0x01),
      dpadUp:    dpadDir === 7 || dpadDir === 0 || dpadDir === 1,
      dpadRight: dpadDir === 1 || dpadDir === 2 || dpadDir === 3,
      dpadDown:  dpadDir === 3 || dpadDir === 4 || dpadDir === 5,
      dpadLeft:  dpadDir === 5 || dpadDir === 6 || dpadDir === 7,
    };

    // ── Gyro (6 bytes) + Accel (6 bytes immediately after) ──
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

    // ── Touchpad — 2 touch points, 4 bytes each ──
    const touchpad = [
      DualSenseDriver._parseTouchPoint(data, touchOffset),
      DualSenseDriver._parseTouchPoint(data, touchOffset + 4)
    ];

    // Touchpad click: bit 1 of the PS byte
    const touchpadButton = !!(psByte & 0x02);

    return {
      sticks,
      triggers,
      buttons,
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
