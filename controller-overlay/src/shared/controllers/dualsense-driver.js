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

  // ── Rumble + LED + lightbar output (DualSense only) ──────────
  //
  // Chromium's Gamepad API vibrationActuator.playEffect() is flaky on macOS
  // for DualSense. The generic _sendOutputReport() path below writes the
  // HID output report directly using the same open WebHID handle we already
  // have for gyro reads — works reliably across USB and BT, and lets us
  // combine rumble + player-LED + lightbar-color into a single packet.
  // See issue #193 (rumble) and #222 (lights).
  //
  // Player LED bitmask layout (byte 43 USB / byte 44 BT, 5 LEDs):
  //   bit 0 = leftmost, bit 4 = rightmost
  //   Symmetric "dot count" patterns we use:
  //     P1: 0b00100 (0x04) — single center dot
  //     P2: 0b01010 (0x0A) — two dots flanking center
  //     P3: 0b10101 (0x15) — three dots (odd positions)
  //     P4: 0b11011 (0x1B) — four dots (all but center)
  //
  // Lightbar RGB: three bytes, 0..255 each.

  /** Symmetric dot-count LED patterns for up to 4 players. */
  static PLAYER_LED_PATTERNS = {
    1: 0b00100,
    2: 0b01010,
    3: 0b10101,
    4: 0b11011,
  };

  /**
   * Rumble both motors, auto-stop after durationMs.
   * @param {number} strong — strong (left) rumble 0..1
   * @param {number} weak   — weak  (right) rumble 0..1
   * @param {number} durationMs
   */
  async setRumble(strong, weak, durationMs) {
    if (!this._supportsOutputReports()) return;
    const s = Math.max(0, Math.min(1, strong));
    const w = Math.max(0, Math.min(1, weak));
    const strongByte = Math.round(s * 255);
    const weakByte = Math.round(w * 255);

    try {
      await this._sendOutputReport({ rumble: { weak: weakByte, strong: strongByte } });
    } catch (err) {
      console.warn('DualSense setRumble failed:', err.message);
      return;
    }

    if (this._rumbleStopTimer) clearTimeout(this._rumbleStopTimer);
    this._rumbleStopTimer = setTimeout(() => {
      this._rumbleStopTimer = null;
      this._sendOutputReport({ rumble: { weak: 0, strong: 0 } }).catch(() => {});
    }, Math.max(10, durationMs));
  }

  /**
   * Set the 5-LED player indicator row under the touchpad.
   * @param {number} bitmask — 5-bit mask (bit 0 = leftmost, bit 4 = rightmost)
   */
  async setPlayerLEDs(bitmask) {
    if (!this._supportsOutputReports()) return;
    try {
      await this._sendOutputReport({ playerLEDs: bitmask & 0x1F });
    } catch (err) {
      console.warn('DualSense setPlayerLEDs failed:', err.message);
    }
  }

  /**
   * Set the lightbar color. Pass (0,0,0) to turn it off.
   */
  async setLightbar(r, g, b) {
    if (!this._supportsOutputReports()) return;
    try {
      await this._sendOutputReport({
        lightbar: {
          r: Math.max(0, Math.min(255, r | 0)),
          g: Math.max(0, Math.min(255, g | 0)),
          b: Math.max(0, Math.min(255, b | 0)),
        },
      });
    } catch (err) {
      console.warn('DualSense setLightbar failed:', err.message);
    }
  }

  /**
   * Combined player feedback — LEDs + lightbar in a single output report.
   * Preferred by ControllerManager on slot claim/release because sequential
   * sendReport calls for LED then lightbar can interleave oddly over BT;
   * a single packet with both valid_flags set is more reliable.
   */
  async setPlayerFeedback({ playerLEDs, lightbar } = {}) {
    if (!this._supportsOutputReports()) return;
    try {
      const payload = {};
      if (playerLEDs != null) payload.playerLEDs = playerLEDs & 0x1F;
      if (lightbar) {
        payload.lightbar = {
          r: Math.max(0, Math.min(255, lightbar.r | 0)),
          g: Math.max(0, Math.min(255, lightbar.g | 0)),
          b: Math.max(0, Math.min(255, lightbar.b | 0)),
        };
      }
      await this._sendOutputReport(payload);
    } catch (err) {
      console.warn('DualSense setPlayerFeedback failed:', err.message);
    }
  }

  _supportsOutputReports() {
    if (!this.device || !this.device.opened) return false;
    // Only DualSense (not DualShock 4) uses the 0x02 / 0x31 output formats
    // implemented here.
    const pid = this.device.productId;
    return pid === 0x0ce6 || pid === 0x0df2;
  }

  /**
   * Generic output-report writer. Fields:
   *   rumble:     { weak, strong }  0..255 each — sets valid_flag0 bits 0+1
   *   lightbar:   { r, g, b }                   — sets valid_flag1 bit 2
   *   playerLEDs: bitmask 0..0x1F               — sets valid_flag1 bit 4
   *
   * Any field omitted leaves its valid-flag bit clear, so the controller
   * keeps its current value for that feature.
   *
   * Byte offsets (payload after the report ID is stripped by WebHID):
   *   USB report 0x02 (47-byte payload):
   *     [0]      valid_flag0
   *     [1]      valid_flag1
   *     [2]      motor_right (weak)
   *     [3]      motor_left  (strong)
   *     [42]     led_brightness (0 = high)
   *     [43]     player_leds bitmask
   *     [44..46] lightbar R, G, B
   *
   *   BT report 0x31 (77-byte payload, +1 for the data tag):
   *     [0]      0x02 (DualSense BT data tag)
   *     [1]      valid_flag0
   *     [2]      valid_flag1
   *     [3]      motor_right
   *     [4]      motor_left
   *     [43]     led_brightness
   *     [44]     player_leds
   *     [45..47] lightbar R, G, B
   *     [73..76] CRC-32 little-endian over [0xA2, 0x31, buf[0..72]]
   *
   * Flag bits (match Linux hid-playstation + pydualsense conventions):
   *   valid_flag0 bit 0 (0x01): compatible vibration (rumble emulation)
   *   valid_flag0 bit 1 (0x02): haptics select
   *   valid_flag1 bit 2 (0x04): lightbar control enable
   *   valid_flag1 bit 4 (0x10): player indicator control enable
   */
  async _sendOutputReport({ rumble, lightbar, playerLEDs } = {}) {
    if (this.connectionType === 'bluetooth') {
      await this._sendOutputReportBT({ rumble, lightbar, playerLEDs });
    } else {
      await this._sendOutputReportUSB({ rumble, lightbar, playerLEDs });
    }
  }

  // Byte offsets referenced from pydualsense wire layout (report_id at [0]).
  // WebHID's sendReport strips the report_id so our payload indices are
  // wire_index - 1. USB output report 0x02 has no leading data-tag byte,
  // so USB offsets are another -1 relative to BT (which DOES prepend a
  // 0x02 data tag at [0]).
  //
  //          wire  USB  BT
  //   flag0   [2]   [0]  [1]
  //   flag1   [3]   [1]  [2]
  //   motor_right/weak  [4]  [2]  [3]
  //   motor_left/strong [5]  [3]  [4]
  //   lightbar_setup  [44] [42] [43]
  //   led_brightness  [45] [43] [44]
  //   player_leds     [46] [44] [45]
  //   lightbar_red    [47] [45] [46]
  //   lightbar_green  [48] [46] [47]
  //   lightbar_blue   [49] [47] [48]

  // Empirically determined byte offsets via setLightbar probe tests
  // (see #222 phase 4 debugging thread). Two rounds of tests pinned R/G/B
  // to buf[45]/[46]/[47] on BT (buf[44]/[45]/[46] on USB — one lower
  // because BT payload has a leading 0x02 data tag). Struct layout
  // upstream of the RGB bytes: led_brightness, player_leds.
  //
  //          BT    USB
  //   led_brightness  [43]  [42]
  //   player_leds     [44]  [43]
  //   lightbar_red    [45]  [44]
  //   lightbar_green  [46]  [45]
  //   lightbar_blue   [47]  [46]

  async _sendOutputReportUSB({ rumble, lightbar, playerLEDs }) {
    const buf = new Uint8Array(47);
    let flag0 = 0, flag1 = 0;
    if (rumble) {
      flag0 |= 0x03;          // rumble emu + haptics select
      buf[2] = rumble.weak & 0xFF;
      buf[3] = rumble.strong & 0xFF;
    }
    if (playerLEDs != null) {
      flag1 |= 0x10;          // player indicator enable
      buf[42] = 0x00;         // led_brightness: high
      buf[43] = playerLEDs & 0x1F;
    }
    if (lightbar) {
      flag1 |= 0x04;          // lightbar control enable
      buf[44] = lightbar.r;
      buf[45] = lightbar.g;
      buf[46] = lightbar.b;
    }
    buf[0] = flag0;
    buf[1] = flag1;
    await this.device.sendReport(0x02, buf);
  }

  async _sendOutputReportBT({ rumble, lightbar, playerLEDs }) {
    const PAYLOAD_LEN = 77;
    const buf = new Uint8Array(PAYLOAD_LEN);
    buf[0] = 0x02;             // BT data tag
    let flag0 = 0, flag1 = 0;
    if (rumble) {
      flag0 |= 0x03;
      buf[3] = rumble.weak & 0xFF;
      buf[4] = rumble.strong & 0xFF;
    }
    if (playerLEDs != null) {
      flag1 |= 0x10;
      buf[43] = 0x00;          // led_brightness: high
      buf[44] = playerLEDs & 0x1F;
    }
    if (lightbar) {
      flag1 |= 0x04;
      buf[45] = lightbar.r;
      buf[46] = lightbar.g;
      buf[47] = lightbar.b;
    }
    buf[1] = flag0;
    buf[2] = flag1;

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
