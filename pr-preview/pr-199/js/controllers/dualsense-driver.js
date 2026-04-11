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

  constructor(device, connectionType) {
    super(device, connectionType);
    this._btSeq = 0;              // 4-bit BT output sequence counter
    this._rumbleStopTimer = null;
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

  destroy() {
    if (this._rumbleStopTimer) {
      clearTimeout(this._rumbleStopTimer);
      this._rumbleStopTimer = null;
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

  // ── Rumble output (DualSense only, not DualShock 4) ───────────
  //
  // Chromium's Gamepad API vibrationActuator.playEffect() is flaky on macOS
  // for DualSense — sometimes returns null, sometimes resolves without
  // writing an output report. This is a direct WebHID path that bypasses
  // the Gamepad API entirely, using the same open HID handle we already
  // have for gyro reads. See issue #193.
  //
  // @param {number} strong  — strong (left) rumble 0..1
  // @param {number} weak    — weak (right) rumble 0..1
  // @param {number} durationMs — auto-stop after this many ms

  async setRumble(strong, weak, durationMs) {
    if (!this.device || !this.device.opened) return;
    // Only DualSense (not DualShock 4) uses the 0x02 / 0x31 output formats
    // implemented here. DS4 has a different output layout and is out of scope
    // for issue #193.
    const pid = this.device.productId;
    if (pid !== 0x0ce6 && pid !== 0x0df2) return;

    const s = Math.max(0, Math.min(1, strong));
    const w = Math.max(0, Math.min(1, weak));
    const strongByte = Math.round(s * 255);
    const weakByte = Math.round(w * 255);

    try {
      if (this.connectionType === 'bluetooth') {
        await this._sendRumbleBT(strongByte, weakByte);
      } else {
        await this._sendRumbleUSB(strongByte, weakByte);
      }
    } catch (err) {
      // Swallow: rumble is best-effort. Log once at debug level.
      console.debug('DualSense setRumble failed:', err.message);
      return;
    }

    // Auto-stop after the effect duration. Clear any pending stop first so
    // overlapping rumble calls don't leave a zero-write racing behind a
    // subsequent non-zero write.
    if (this._rumbleStopTimer) clearTimeout(this._rumbleStopTimer);
    this._rumbleStopTimer = setTimeout(() => {
      this._rumbleStopTimer = null;
      if (this.connectionType === 'bluetooth') {
        this._sendRumbleBT(0, 0).catch(() => {});
      } else {
        this._sendRumbleUSB(0, 0).catch(() => {});
      }
    }, Math.max(10, durationMs));
  }

  /**
   * USB output report 0x02: first byte is a feature mask (0x01 = rumble on),
   * second byte is a secondary flag mask (0x00 for rumble-only), then right
   * (weak) and left (strong) motor amplitudes. Everything else stays zero —
   * the report is 47 bytes of feature payload.
   */
  async _sendRumbleUSB(strongByte, weakByte) {
    const payload = new Uint8Array(47);
    payload[0] = 0x01;          // feature flags 1: enable compatible rumble
    payload[1] = 0x00;          // feature flags 2
    payload[2] = weakByte;      // right motor (weak)
    payload[3] = strongByte;    // left  motor (strong)
    await this.device.sendReport(0x02, payload);
  }

  /**
   * BT output report 0x31 wraps the same feature payload with a flags/seq
   * byte pair at the front and a CRC-32/MPEG-2 trailer at the end. The CRC
   * is computed over a synthetic packet that includes the HID "output"
   * transfer-type byte (0xA2) and the report ID itself — a DualSense
   * firmware-level integrity check that doesn't go on the wire.
   */
  async _sendRumbleBT(strongByte, weakByte) {
    // 78 bytes of wire payload: 1 flags, 1 seq/flags, 1+1 feature mask,
    // rumble bytes, rest zero, then 4 bytes CRC at the end.
    const WIRE_LEN = 78;
    const buf = new Uint8Array(WIRE_LEN);

    this._btSeq = (this._btSeq + 1) & 0x0F;
    buf[0] = 0x02;              // tag: "DATA" — required for output reports
    buf[1] = (this._btSeq << 4) | 0x00;
    buf[2] = 0x01;              // feature flags 1: enable compatible rumble
    buf[3] = 0x00;              // feature flags 2
    buf[4] = weakByte;          // right motor (weak)
    buf[5] = strongByte;        // left  motor (strong)
    // buf[6..73] = 0 (LED color, trigger effects, etc. — all untouched)

    // CRC input = 0xA2 || reportId || buf[0..73]
    const crcInput = new Uint8Array(1 + 1 + (WIRE_LEN - 4));
    crcInput[0] = 0xA2;
    crcInput[1] = 0x31;
    crcInput.set(buf.subarray(0, WIRE_LEN - 4), 2);
    const crc = DualSenseDriver._crc32Mpeg2(crcInput);
    // Little-endian CRC trailer
    buf[WIRE_LEN - 4] = crc & 0xFF;
    buf[WIRE_LEN - 3] = (crc >>> 8) & 0xFF;
    buf[WIRE_LEN - 2] = (crc >>> 16) & 0xFF;
    buf[WIRE_LEN - 1] = (crc >>> 24) & 0xFF;

    await this.device.sendReport(0x31, buf);
  }

  static _crc32Mpeg2(bytes) {
    // CRC-32/MPEG-2: poly 0x04C11DB7, init 0xFFFFFFFF, refin=false, refout=false, xorout=0
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) {
      crc ^= bytes[i] << 24;
      for (let b = 0; b < 8; b++) {
        if (crc & 0x80000000) {
          crc = ((crc << 1) ^ 0x04C11DB7) >>> 0;
        } else {
          crc = (crc << 1) >>> 0;
        }
      }
    }
    return crc >>> 0;
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
