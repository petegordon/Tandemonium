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
      // Rumble is best-effort, but surface the failure at warn level so
      // misconfigured packet layouts or permission errors are visible
      // instead of silently disabled.
      console.warn('DualSense setRumble failed:', err.message);
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
   * USB output report 0x02. WebHID strips the report ID, so the payload
   * is the 47-byte feature-map body:
   *   [0] valid_flag0 = 0x03 (ENABLE_RUMBLE_EMU | HAPTICS_SELECT)
   *   [1] valid_flag1 = 0x00
   *   [2] motor_right (weak rumble)
   *   [3] motor_left  (strong rumble)
   *   rest untouched (0)
   * Using 0x03 instead of just 0x01 hits both the legacy rumble-emulation
   * bit AND the haptic select bit, which is what most known-working
   * DualSense drivers (Linux hid-playstation, pydualsense, DS4Windows) do
   * to cover variations across firmware revisions.
   */
  async _sendRumbleUSB(strongByte, weakByte) {
    const payload = new Uint8Array(47);
    payload[0] = 0x03;          // valid_flag0: enable rumble emu + haptics select
    payload[1] = 0x00;          // valid_flag1
    payload[2] = weakByte;      // motor_right (weak)
    payload[3] = strongByte;    // motor_left  (strong)
    await this.device.sendReport(0x02, payload);
  }

  /**
   * BT output report 0x31. The full on-wire packet is 78 bytes including
   * the report ID; WebHID's sendReport() strips the report ID so the
   * payload handed to the API is 77 bytes.
   *
   * Layout (payload offsets, matching pydualsense which is known-working):
   *   [0]    = 0x02 (data tag — this is NOT the feature byte; required
   *                  by DualSense firmware to identify the packet type)
   *   [1]    = valid_flag0 = 0x03 (rumble emu + haptic select)
   *   [2]    = valid_flag1 = 0x00
   *   [3]    = motor_right (weak rumble)
   *   [4]    = motor_left  (strong rumble)
   *   [5..72] = 0 (LEDs, trigger effects, etc. — untouched)
   *   [73..76] = CRC-32 (little-endian) computed over [0xA2, 0x31, [0..72]]
   *
   * The CRC-32 variant is the STANDARD reflected CRC-32 (same as zlib /
   * IEEE 802.3 — polynomial 0xEDB88320 in reflected form, init 0xFFFFFFFF,
   * xorout 0xFFFFFFFF). This matches what Linux's hid-playstation driver
   * computes with crc32_le() and what pydualsense uses via binascii.crc32.
   * An earlier attempt used CRC-32/MPEG-2 (non-reflected); that's wrong
   * for DualSense and made every packet get rejected silently.
   *
   * The 0xA2 seed byte prepended to the CRC input is the HID SET_REPORT
   * OUTPUT transfer-type byte — a protocol-level value that the device
   * folds into its integrity check but never appears on the wire.
   */
  async _sendRumbleBT(strongByte, weakByte) {
    const PAYLOAD_LEN = 77;  // 78-byte wire packet minus the report ID
    const buf = new Uint8Array(PAYLOAD_LEN);

    buf[0] = 0x02;              // data tag
    buf[1] = 0x03;              // valid_flag0: rumble emu + haptic select
    buf[2] = 0x00;              // valid_flag1
    buf[3] = weakByte;          // motor_right (weak)
    buf[4] = strongByte;        // motor_left  (strong)
    // buf[5..72] = 0 (reserved / LED / trigger effects — leave alone)

    // CRC input: seed (0xA2) + report ID (0x31) + buf[0..72] = 75 bytes
    const crcInput = new Uint8Array(1 + 1 + (PAYLOAD_LEN - 4));
    crcInput[0] = 0xA2;
    crcInput[1] = 0x31;
    crcInput.set(buf.subarray(0, PAYLOAD_LEN - 4), 2);
    const crc = DualSenseDriver._crc32(crcInput);
    buf[PAYLOAD_LEN - 4] = crc & 0xFF;
    buf[PAYLOAD_LEN - 3] = (crc >>> 8) & 0xFF;
    buf[PAYLOAD_LEN - 2] = (crc >>> 16) & 0xFF;
    buf[PAYLOAD_LEN - 1] = (crc >>> 24) & 0xFF;

    await this.device.sendReport(0x31, buf);
  }

  /**
   * Standard reflected CRC-32 (same as zlib / PKZIP / Ethernet).
   * Polynomial 0xEDB88320 (reversed form of 0x04C11DB7), initial value
   * 0xFFFFFFFF, final XOR 0xFFFFFFFF, input and output reflected. This is
   * what DualSense BT output reports expect.
   */
  static _crc32(bytes) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) {
      crc ^= bytes[i];
      for (let b = 0; b < 8; b++) {
        crc = (crc & 1) ? ((crc >>> 1) ^ 0xEDB88320) : (crc >>> 1);
      }
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
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
