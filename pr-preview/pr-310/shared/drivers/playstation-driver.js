// ============================================================
// PLAYSTATION DRIVER — DualSense (DS5) + DualShock 4 (DS4) protocol
// ============================================================
//
// Covers both Sony PlayStation HID protocols and any clones that spoof
// them (GameSir Super Nova / Cyclone 2 in DS4 mode, etc.). The two
// protocols share most of the input-report layout, differing mainly in
// IMU byte offsets — that branch is driven by the dictionary entry's
// `mode` field ('ds5' vs 'ds4'), not by a separate driver class.
//
// Registered in PROTOCOLS under the key 'dualsense' (preserved as-is so
// existing visualizer profile mappings keep working without forcing a
// controllerProfile override on every Sony PlayStation entry).
//
// Identity (vid:pid, name, capabilities, gamepad-id pattern) lives in
// devices.js — this class is purely the protocol implementation.

import { ControllerDriver } from './base-driver.js';

export class PlayStationDriver extends ControllerDriver {

  constructor(device, connectionType, entry = null) {
    super(device, connectionType, entry);
    this._rumbleStopTimer = null;
  }

  async init() {
    // Over Bluetooth both Sony families default to a compatibility mode that
    // streams only the short report 0x01 (sticks/buttons, no IMU). Reading a
    // family-specific feature report flips them into full-report mode:
    //   DualSense (DS5) → feature 0x05, then streams report 0x31 (gyro+accel)
    //   DualShock 4 (DS4) → feature 0x02, then streams report 0x11 (gyro+accel)
    // Same trick Linux's hid-playstation / hid-sony drivers use. Without the
    // DS4-specific 0x02 read, a DualShock 4 over BT never leaves compatibility
    // mode and no gyro ever arrives (see the DS4-BT investigation).
    if (this.connectionType === 'bluetooth') {
      const featureId = this.entry?.mode === 'ds4' ? 0x02 : 0x05;
      await this._activateFullReportMode(featureId);
    }

    // IMU-offset probe: PlayStation-family controllers (real Sony DS4/DS5 +
    // GameSir clones in DS4 mode) share vid:pid families and differ only in
    // IMU byte offsets. Score candidate offsets by at-rest accel magnitude
    // (≈ 8192 raw = 1g at ±4g/16-bit) plus gyro-near-zero; the winner sets
    // this._detectedImuOffset, which parseReport prefers over the mode
    // default. Runs over USB (report 0x01) AND Bluetooth (DS4 0x11 / DS5
    // 0x31) — so after the feature-report activation above it auto-corrects
    // the BT offset too.
    //
    // Family mapping by USB-equivalent offset (= gyroOffset − baseOffset):
    //   12 → 'gamesir-ds4'   13 → 'sony-ds4'   15 → 'sony-ds5'
    //
    // Best-effort: if no reports arrive within the timeout, parseReport falls
    // back to the mode/transport default offset.
    const probe = await this._probeImuOffset();
    if (probe) {
      // At-rest accel magnitude is ambiguous to ±2 bytes: gravity sits on a
      // single axis that's shared between an offset and its neighbour-by-2, so
      // both score ~1g. If the pad isn't perfectly still during the probe, the
      // gyro tie-breaker can flip to the wrong (off-by-2) neighbour — which
      // reads an accel axis as gyro and makes steering jerk hard side to side.
      // So: trust the DOCUMENTED default offset whenever it scored plausibly
      // (~1g); only let the probe override when the default is clearly wrong
      // (a clone with a genuinely different layout).
      const defaultOffset = this._defaultGyroOffset();
      const defaultScore = probe.scores?.find((s) => s.gyroOffset === defaultOffset);
      const plausible = (s) => s && s.meanAccelMag > 6500 && s.meanAccelMag < 11500;
      const chosen = plausible(defaultScore) ? defaultScore : probe;
      this._detectedImuOffset = chosen;
      this._detectedImuFamily = PlayStationDriver._imuFamilyFor(chosen.gyroOffset, chosen.baseOffset);
      console.log(`PlayStation IMU offset=${chosen.gyroOffset} (default=${defaultOffset}, probe-best=${probe.gyroOffset}, accelMag≈${chosen.meanAccelMag.toFixed(0)}) → family='${this._detectedImuFamily}' (${this.entry?.name || 'unknown'})`);
    }
  }

  /**
   * Bring a Bluetooth DualShock 4 / DualSense out of compatibility mode
   * (short report 0x01, no IMU) into full-report mode (DS4 0x11 / DS5 0x31,
   * with gyro+accel) by reading the family-specific feature report — then
   * CONFIRM the full report stream actually started, retrying if not.
   *
   * A single read at connect time is enough on a settled link (controller
   * paired before the app launched — the cold-plug case that always worked).
   * But on a HOT-PLUG / reconnect the BT link is often still negotiating when
   * init() runs: the feature read returns without error, yet the controller
   * keeps streaming 0x01 and no gyro ever arrives ("thinks it has gyro but
   * the data isn't used"). So re-issue the read and wait for the first full
   * report, a few times, until the stream flips. On the settled case the
   * first full report lands almost immediately, so this adds negligible cost.
   *
   * @returns {Promise<boolean>} whether the full report stream was confirmed
   */
  async _activateFullReportMode(featureId, { attempts = 5, perAttemptMs = 450 } = {}) {
    const fullId = this._fullReportId();
    const hex = (n) => '0x' + n.toString(16).padStart(2, '0');
    // A device without receiveFeatureReport is a test/unsupported handle —
    // don't hammer it; make a single pass and rely on whatever it streams.
    const canRead = typeof this.device.receiveFeatureReport === 'function';
    const maxAttempts = canRead ? attempts : 1;

    for (let i = 1; i <= maxAttempts; i++) {
      if (canRead) {
        try {
          await this.device.receiveFeatureReport(featureId);
        } catch (err) {
          console.warn(`PlayStation BT: feature ${hex(featureId)} query failed (attempt ${i}/${maxAttempts}):`, err.message);
        }
      }
      const streaming = await this._waitForReport(fullId, perAttemptMs);
      if (streaming) {
        console.log(`PlayStation BT: full report mode active (${hex(fullId)}) after ${i} attempt(s)`);
        return true;
      }
      if (i < maxAttempts) {
        console.log(`PlayStation BT: still in compatibility mode after feature ${hex(featureId)} (attempt ${i}/${maxAttempts}); retrying`);
      }
    }
    console.warn(`PlayStation BT: full report mode (${hex(fullId)}) did not start after ${maxAttempts} attempt(s) — gyro unavailable until reconnect`);
    return false;
  }

  /** The IMU-bearing input report id for this transport/mode. */
  _fullReportId() {
    if (this.connectionType !== 'bluetooth') return 0x01;
    return this.entry?.mode === 'ds4' ? 0x11 : 0x31;
  }

  /** Resolve true if an inputreport with `reportId` arrives within `ms`. */
  _waitForReport(reportId, ms) {
    return new Promise((resolve) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.device.removeEventListener('inputreport', onReport);
      };
      const onReport = (event) => {
        if (event.reportId !== reportId) return;
        cleanup();
        resolve(true);
      };
      const timer = setTimeout(() => { cleanup(); resolve(false); }, ms);
      this.device.addEventListener('inputreport', onReport);
    });
  }

  // Documented gyro start offset per transport/mode. The IMU probe defers to
  // this when it scores plausibly (~1g); see init() for why.
  _defaultGyroOffset() {
    const isDs4 = this.entry?.mode === 'ds4';
    if (this.connectionType === 'usb') return isDs4 ? 12 : 15;
    return isDs4 ? 14 : 16; // Bluetooth: DS4 0x11 (+2) / DS5 0x31 (+1)
  }

  /**
   * One-shot IMU layout probe. Listens to inputreport for up to `timeoutMs`,
   * collecting up to 10 reports, then scores each candidate gyro offset by
   * how close the at-rest accel magnitude is to 8192 (1g). Returns the
   * winner, or null if no usable reports arrived.
   *
   * Only runs on USB report 0x01 today. BT branch differs (offset shifts
   * with the leading counter byte) and the offset relationship is the same
   * up to that constant, so the same probe-then-add-baseOffset logic could
   * extend to BT later — punted for now since the immediate case is USB.
   *
   * @param {number} [timeoutMs=500]
   * @returns {Promise<{gyroOffset:number, accelOffset:number, meanAccelMag:number}|null>}
   */
  // Per-transport probe configuration: which input report carries the IMU,
  // the byte its payload starts at (BT prepends counter/header bytes — DS5
  // 0x31 is +1, DS4 0x11 is +2 vs USB), and the candidate gyro offsets to
  // score.
  _probeConfig() {
    if (this.connectionType === 'usb') {
      return { reportId: 0x01, baseOffset: 0, candidates: [12, 13, 15] };
    }
    if (this.entry?.mode === 'ds4') {
      return { reportId: 0x11, baseOffset: 2, candidates: [14, 15, 13, 16] };
    }
    return { reportId: 0x31, baseOffset: 1, candidates: [16, 15, 17] };
  }

  async _probeImuOffset(timeoutMs = 600) {
    const { reportId: wantId, baseOffset, candidates } = this._probeConfig();
    const reports = [];

    return new Promise((resolve) => {
      const onReport = (event) => {
        if (event.reportId !== wantId) return;
        reports.push(event.data);
        if (reports.length >= 10) finish();
      };

      const finish = () => {
        clearTimeout(timer);
        this.device.removeEventListener('inputreport', onReport);

        if (reports.length === 0) { resolve(null); return; }
        const r = ControllerDriver.readSigned16;
        const scores = [];
        for (const gyroOffset of candidates) {
          const accelOffset = gyroOffset + 6;
          let sumMag = 0, sumGyroAbs = 0, n = 0;
          for (const data of reports) {
            if (data.byteLength < accelOffset + 6) continue;
            sumMag += Math.hypot(r(data, accelOffset), r(data, accelOffset + 2), r(data, accelOffset + 4));
            sumGyroAbs += Math.abs(r(data, gyroOffset)) + Math.abs(r(data, gyroOffset + 2)) + Math.abs(r(data, gyroOffset + 4));
            n++;
          }
          if (n === 0) continue;
          const meanAccelMag = sumMag / n;
          const meanGyroAbs = sumGyroAbs / n;
          // Best = at-rest accel closest to 1g (8192 raw) with gyro near zero.
          scores.push({ gyroOffset, accelOffset, baseOffset, meanAccelMag, meanGyroAbs, score: Math.abs(meanAccelMag - 8192) + meanGyroAbs });
        }
        if (scores.length === 0) { resolve(null); return; }
        scores.sort((a, b) => a.score - b.score);
        // Diagnostic: full candidate table (report id + length + per-offset).
        console.log(`PlayStation IMU probe scan (report 0x${wantId.toString(16)}, ${reports[0].byteLength}B):`,
          scores.map(s => `g=${s.gyroOffset} accel≈${s.meanAccelMag.toFixed(0)} gyro≈${s.meanGyroAbs.toFixed(0)}`).join('  |  '));
        resolve({ ...scores[0], scores });
      };

      this.device.addEventListener('inputreport', onReport);
      const timer = setTimeout(finish, timeoutMs);
    });
  }

  destroy() {
    if (this._rumbleStopTimer) {
      clearTimeout(this._rumbleStopTimer);
      this._rumbleStopTimer = null;
    }
  }

  parseReport(reportId, data) {
    // USB 0x01 and BT 0x31 share most of the input-report layout, shifted by
    // one byte (BT prefixes with a sequence/counter byte). baseOffset handles
    // the shift. The IMU and touchpad bytes also shift based on protocol
    // mode: DS4 packs IMU 3 bytes earlier than DualSense (DS5).
    //
    // DS4 offsets (mode === 'ds4') confirmed by Test Report captures of BOTH a
    // GameSir Super Nova (USB) and a genuine Sony DualShock 4 v1 (Bluetooth):
    // gyro at USB offset 12 / accel 18 (BT: 14 / 20, +2 for the BT header),
    // accel ≈8192 raw (1g) with gyro bias ≈0 at rest. So a real Sony DS4 uses
    // the SAME byte-12 layout as the clones — NOT the byte-13 "Linux hid-sony"
    // layout once assumed. Axis mapping is identical too (pitch→gyroX,
    // roll→gyroZ, yaw→gyroY). See test/fixtures/sony-dualshock4-v1-bt_*.json.
    let baseOffset, gyroOffset, touchOffset;
    const isDs4 = this.entry?.mode === 'ds4';
    // Runtime IMU probe (set during init) is the source of truth when
    // available; the mode/transport default is the fallback when the probe
    // couldn't collect any reports.
    const probeOffset = this._detectedImuOffset?.gyroOffset;

    if (this.connectionType === 'usb' && reportId === 0x01) {
      baseOffset = 0;
      gyroOffset = probeOffset ?? (isDs4 ? 12 : 15);
      touchOffset = isDs4 ? 35 : 32;
    } else if (this.connectionType === 'bluetooth' && reportId === 0x31) {
      // DualSense (DS5) Bluetooth full report — 1-byte counter prefix.
      baseOffset = 1;
      gyroOffset = probeOffset ?? 16;
      touchOffset = 33;
    } else if (this.connectionType === 'bluetooth' && reportId === 0x11) {
      // DualShock 4 (DS4) Bluetooth full report (enabled via feature 0x02).
      // A 2-byte BT header precedes the otherwise-USB-identical layout, so
      // every offset is USB + 2.
      baseOffset = 2;
      gyroOffset = probeOffset ?? 14;   // USB 12 + 2
      touchOffset = 37;                 // USB 35 + 2
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
      mic:      !!(psByte  & 0x04),
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
      PlayStationDriver._parseTouchPoint(data, touchOffset),
      PlayStationDriver._parseTouchPoint(data, touchOffset + 4)
    ];

    // Touchpad click: bit 1 of the PS byte
    const touchpadButton = !!(psByte & 0x02);

    if (isDs4) {
      // DS4-family (real Sony DS4 + GameSir clones): WebHID supplies the IMU
      // only. Buttons/sticks/triggers come from the Gamepad API (a DS4
      // enumerates as a standard gamepad on every OS). We deliberately omit
      // them here — parsing at the DualSense offsets is wrong for a real DS4,
      // and a non-empty button set would make ControllerManager prefer this
      // mis-parsed synthetic over the correct Gamepad-API pad. Touchpad is
      // omitted too until a real-DS4 button/touchpad layout is captured and
      // validated.
      return {
        gyro,
        accel,
        gyroScale: 2000.0 / 32768.0,   // ±2000 dps, 16-bit
        accelScale: 1.0 / 8192.0        // ±4g, 16-bit (gravity ~8192)
      };
    }
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
    const crc = PlayStationDriver._crc32(crcInput);
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
    // Bluetooth is identified by the family-specific full-report ID:
    //   DualSense BT → report 0x31   DualShock 4 BT → report 0x11
    // Over USB the input report is 0x01; crucially DS4 USB lists 0x11 only as
    // a *feature* report, so we must check INPUT reports for 0x11 (not feature
    // reports) or a USB DS4 would misdetect as Bluetooth. The legacy
    // output-report 0x31 check is kept for DualSense.
    for (const col of device.collections) {
      for (const report of (col.outputReports || [])) {
        if (report.reportId === 0x31) return 'bluetooth';
      }
      for (const report of (col.inputReports || [])) {
        if (report.reportId === 0x31 || report.reportId === 0x11) return 'bluetooth';
      }
    }
    return 'usb';
  }

  // USB-equivalent gyro offset → IMU family. baseOffset removes the BT
  // counter/header shift (USB 0, DS5 BT 1, DS4 BT 2) so one map covers all
  // transports.
  static _imuFamilyFor(gyroOffset, baseOffset = 0) {
    const usbEquiv = gyroOffset - baseOffset;
    return (
      usbEquiv === 12 ? 'gamesir-ds4' :
      usbEquiv === 13 ? 'sony-ds4' :
      usbEquiv === 15 ? 'sony-ds5' :
      null
    );
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
