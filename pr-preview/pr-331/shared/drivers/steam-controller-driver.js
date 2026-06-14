// ============================================================
// STEAM CONTROLLER 2026 DRIVER (Ibex / Proteus)
// ============================================================
//
// Parses the Valve Steam Input HID format for the 2026 Steam Controller.
// Two physical paths, one protocol:
//
//   0x28DE:0x1302 — controller body plugged via USB-C. Single HID
//                   interface. STATE reports start flowing immediately
//                   at ~249 Hz on connect, no handshake.
//
//   0x28DE:0x1304 — wireless Puck dongle. Five HID interfaces; only
//                   one emits STATE reports, and only after the
//                   "lizard-mode disable" feature reports are sent +
//                   re-sent on an 800ms heartbeat. Without that, the
//                   Puck stays in keyboard/mouse fallback mode and
//                   iface[3] is silent. Manager pools all five
//                   HIDDevice instances; the driver init below sends
//                   the feature reports on every instance (most will
//                   error — that's expected and swallowed). The one
//                   instance whose interface accepts feature reports
//                   activates the mode for the entire Puck.
//
// Byte layout sourced from ddeverill/SteamlessController v1.1 and
// libsdl-org/SDL's hidapi_steam.c (May 2026 commits). See issue #8 for
// the prior-art survey and the per-byte verification against our own
// captures.
//
// IMU is a quaternion (4× int16 at WebHID offsets 31-38). Phase 1 omits
// it — parsed.gyro / parsed.accel return null so the existing fusion
// pipeline isn't fed bogus integrate-from-zero data. Wiring quaternion
// orientation through the visualizer (bypassing fusion's integrate-and-
// correct loop) is follow-up work.

import { ControllerDriver } from './base-driver.js';

// 53-byte STATE report on the 2026 device. Length alone is NOT enough to
// identify it: the firmware emits *multiple* 53-byte report types (a real
// at-rest Puck capture showed 0x45 ×1343 STATE plus 0x7b ×9 and 0x43 ×2
// non-STATE, all 53 bytes). The non-STATE reports parse as garbage —
// phantom buttons/sticks + zeroed IMU that trips the stuck-IMU self-heal.
// So we gate on BOTH length and the STATE report id. 2026 firmware uses
// 0x45; SteamlessController docs note 0x42 — accept both, reject the rest.
// See issue #28.
const STATE_REPORT_LEN = 53;
const STATE_REPORT_IDS = new Set([0x45, 0x42]);

const PUCK_PID = 0x1304;
const LIZARD_HEARTBEAT_MS = 800;

const CMD_CLEAR_DIGITAL_MAPPINGS = 0x81;
const CMD_SET_SETTINGS = 0x87;
const SETTING_RIGHT_TRACKPAD_MODE = 0x07;
const SETTING_LEFT_TRACKPAD_MODE = 0x08;
const TRACKPAD_MODE_NONE = 0x00;

const FEATURE_REPORT_ID_PRIMARY = 0x01;
const FEATURE_REPORT_ID_FALLBACK = 0x02;

export class SteamControllerDriver extends ControllerDriver {

  // Steam Controller emits raw 3-axis gyro (bytes 39-44, ±2000 dps)
  // and 3-axis accel (bytes 33-38, ±2g) — same rate-based encoding as
  // DualSense, so it flows through the standard SensorFusion pipeline.
  // emitsRawGyro=true (the default in the base class) opts back into
  // the calibration UX, which is correct for this driver.

  // Valve's HID interfaces are vendor-defined (usage page 0xFF0x), not
  // the standard gamepad usage. Filter on vid:pid only or the picker
  // never lists the Puck/Ibex.
  static makeHidFilter(vendorId, productId) {
    return { vendorId, productId };
  }

  constructor(device, connectionType, entry = null) {
    super(device, connectionType, entry);
    this._lizardTimer = null;
    this._loggedReportIds = new Set();
    // All candidate Puck HID handles we'll send lizard-mode CLEAR to
    // each heartbeat tick — NOT just the one that accepted on init.
    // Empirically, the first interface to "accept" feature reports may
    // not be the one that actually controls keyboard/mouse emulation
    // (other interfaces may stall with NotAllowedError on init but
    // start accepting once the right channel gets the right command).
    // Heartbeat fires on all 5; errors are swallowed silently.
    this._lizardCandidates = [];
  }

  async init() {
    if (this.device.productId !== PUCK_PID) return;

    // Puck path: disable lizard-mode (the firmware's default keyboard +
    // mouse + scroll emulation) by sending CLEAR_DIGITAL_MAPPINGS +
    // SET_SETTINGS (trackpads = NONE) to every Puck HID handle, then
    // heartbeating CLEAR every 800ms — without the heartbeat the
    // firmware reverts to lizard mode after roughly that interval.
    //
    // VERIFIED on 2026 firmware: trackpad mouse + scroll wheel, dpad
    // arrow keys, and button-to-keyboard scancodes are ALL suppressed
    // while the heartbeat is active. The paired controller acts as a
    // pure HID source through the vendor collection. When this app
    // exits the heartbeat stops, the firmware reverts to lizard mode
    // within ~800ms, and the controller behaves as default mouse/kbd
    // again on the user's desktop — that's the correct lifecycle.
    //
    // Key implementation details that made this work:
    //   1. Broadcasting to all 5 sibling HID handles each tick (not
    //      just the first one that accepted on init) — only one is the
    //      gamepad-control channel and we can't tell which in advance.
    //   2. SET_SETTINGS key/value pair order matching SteamlessController
    //      exactly (LEFT then RIGHT trackpad).
    //   3. Heartbeat re-issuing CLEAR every 800ms to keep firmware out
    //      of fallback.
    //
    // The app.js banner alongside this driver tells the user that the
    // suppression is conditional on the overlay running, and recommends
    // direct USB-C (pid 0x1302) for a setup that has no lizard-mode
    // dependency at all.
    const candidates = await this._candidatePuckDevices();
    console.log(`Steam Controller (Puck): probing ${candidates.length} candidate HID interface(s) for feature reports`);
    for (const dev of candidates) {
      try {
        if (!dev.opened) await dev.open();
      } catch (err) {
        console.log(`  [${dev.productName}] open failed: ${err.message}`);
        continue;
      }
      const declared = this._declaredFeatureReports(dev);
      const usages = this._collectionUsages(dev);
      console.log(`  [${dev.productName}] usagePages=[${usages.join(', ')}] featureReports=[${declared.length > 0 ? declared.map((r) => '0x' + r.id.toString(16) + (r.size ? '@' + r.size + 'B' : '')).join(', ') : 'none'}]`);
      const reportId = declared[0]?.id ?? FEATURE_REPORT_ID_PRIMARY;
      const size = declared[0]?.size ?? 64;
      this._lizardCandidates.push({ device: dev, reportId, size });
      const probeResult = await this._trySendLizardModeDisable(dev, declared);
      if (probeResult != null) {
        console.log(`  [${dev.productName}] lizard-mode disable ACCEPTED on feature report id 0x${probeResult.reportId.toString(16)}`);
      }
    }

    console.log(
      'Steam Controller (Puck): lizard-mode (mouse/keyboard/scroll emulation) is suppressed via the 800ms ' +
      'CLEAR_DIGITAL_MAPPINGS heartbeat. The paired controller acts as a pure HID source while this overlay ' +
      'is running. Closing the overlay stops the heartbeat and the firmware reverts to lizard mode within ' +
      '~800ms. Direct USB-C (pid 0x1302) avoids lizard mode entirely. See ' +
      'https://github.com/UsersFirst/tandemonium-controller-lab/issues/8 for the implementation history.'
    );

    if (this._lizardCandidates.length === 0) return;
    this._lizardTimer = setInterval(() => {
      for (const { device, reportId, size } of this._lizardCandidates) {
        const payload = SteamControllerDriver._buildLizardClearPayload(size);
        device.sendFeatureReport(reportId, payload).catch(() => {});
      }
    }, LIZARD_HEARTBEAT_MS);
  }

  /**
   * Inspect a device's collections and return a short usagePage/usage
   * string per collection, e.g. ['FF00/0001', '0001/0005']. Helps
   * identify which interface is the gamepad-control channel (typically
   * usagePage 0x0001 / usage 0x0005 for standard gamepads, but the
   * Puck is all vendor-defined so the relevant signal is the specific
   * vendor usage page assigned to each interface).
   */
  _collectionUsages(device) {
    const out = [];
    if (!device.collections) return out;
    for (const col of device.collections) {
      const up = (col.usagePage ?? 0).toString(16).padStart(4, '0');
      const u = (col.usage ?? 0).toString(16).padStart(4, '0');
      out.push(`${up}/${u}`);
    }
    return out;
  }

  /**
   * Inspect a device's collections and return the feature reports it
   * declares: [{ id, size }] where size is the byte count summed across
   * the report's items. WebHID's sendFeatureReport often requires the
   * payload to match the declared size; sending a shorter buffer can
   * silently fail or throw, so we want the size when available.
   */
  _declaredFeatureReports(device) {
    const out = [];
    if (!device.collections) return out;
    for (const col of device.collections) {
      const reports = col.featureReports || [];
      for (const r of reports) {
        let bits = 0;
        for (const item of r.items || []) {
          bits += (item.reportSize || 0) * (item.reportCount || 0);
        }
        out.push({ id: r.reportId, size: bits > 0 ? Math.ceil(bits / 8) : 0 });
      }
    }
    return out;
  }

  /**
   * Build the CLEAR_DIGITAL_MAPPINGS feature-report payload, padded out
   * to the declared report size (when known). Padding past the command
   * byte stays zero — Valve's protocol ignores trailing zeros.
   */
  static _buildLizardClearPayload(size) {
    const len = size && size > 0 ? size : 64;
    const buf = new Uint8Array(len);
    buf[0] = CMD_CLEAR_DIGITAL_MAPPINGS;
    return buf;
  }

  static _buildLizardSetSettingsPayload(size) {
    const len = size && size > 0 ? size : 64;
    const buf = new Uint8Array(len);
    buf[0] = CMD_SET_SETTINGS;
    buf[1] = 6;                                        // payload length byte
    // Key/value pair order matches SteamlessController exactly: LEFT, RIGHT.
    buf[2] = SETTING_LEFT_TRACKPAD_MODE;  buf[3] = TRACKPAD_MODE_NONE; buf[4] = 0x00;
    buf[5] = SETTING_RIGHT_TRACKPAD_MODE; buf[6] = TRACKPAD_MODE_NONE; buf[7] = 0x00;
    return buf;
  }

  destroy() {
    if (this._lizardTimer) {
      clearInterval(this._lizardTimer);
      this._lizardTimer = null;
    }
    this._lizardCandidates = [];
  }

  /**
   * Enumerate already-approved HID handles for this Puck (primary +
   * siblings sharing vid:pid). Returns at least [this.device] even if
   * getDevices() is unavailable. Siblings sort to a stable order so
   * the heartbeat hits them in the same sequence each tick.
   */
  async _candidatePuckDevices() {
    const result = [this.device];
    if (!navigator.hid) return result;
    try {
      const all = await navigator.hid.getDevices();
      const siblings = all.filter((d) =>
        d !== this.device &&
        d.vendorId === this.device.vendorId &&
        d.productId === this.device.productId
      );
      result.push(...siblings);
    } catch {
      // getDevices errored; we still have the primary handle.
    }
    return result;
  }

  /**
   * Try lizard-mode-disable against a single HID handle. Walks the
   * device's declared feature reports first (best signal — only those
   * ids will accept SET_REPORT), then falls back to the documented
   * 0x01 / 0x02 if the descriptor didn't declare any. Returns
   * { reportId, size } on success or null if every attempt threw.
   */
  async _trySendLizardModeDisable(device, declared) {
    const candidates = declared.length > 0
      ? declared
      : [{ id: FEATURE_REPORT_ID_PRIMARY, size: 64 }, { id: FEATURE_REPORT_ID_FALLBACK, size: 64 }];

    for (const { id, size } of candidates) {
      const clear = SteamControllerDriver._buildLizardClearPayload(size);
      const setSettings = SteamControllerDriver._buildLizardSetSettingsPayload(size);
      try {
        await device.sendFeatureReport(id, clear);
        await device.sendFeatureReport(id, setSettings);
        return { reportId: id, size };
      } catch (err) {
        console.log(`    id 0x${id.toString(16)} (${clear.length}B): ${err.name || 'Error'}: ${err.message}`);
      }
    }
    return null;
  }

  parseReport(reportId, data) {
    // Gate on length AND the STATE report id. The 2026 firmware emits
    // several 53-byte report types; only 0x45 (and per docs 0x42) is the
    // STATE report. Parsing the others (0x7b, 0x43, …) as STATE produced
    // phantom button/stick input and zeroed IMU that tripped the manager's
    // stuck-IMU self-heal — the spurious-input + gyro-dropout bug (#28).
    // Reject anything not on the allow-list. Log accepted and rejected
    // ids once each so future firmware variants are easy to spot.
    if (data.byteLength !== STATE_REPORT_LEN) return null;
    if (!STATE_REPORT_IDS.has(reportId)) {
      if (!this._loggedReportIds.has(reportId)) {
        this._loggedReportIds.add(reportId);
        console.log(`Steam Controller: ignoring non-STATE 53-byte report id 0x${reportId.toString(16)} (#28 guard)`);
      }
      return null;
    }
    if (!this._loggedReportIds.has(reportId)) {
      this._loggedReportIds.add(reportId);
      console.log(`Steam Controller STATE report id observed: 0x${reportId.toString(16)} (${data.byteLength} bytes)`);
    }

    const r = ControllerDriver.readSigned16;
    const u16 = (offset) => data.getUint8(offset) | (data.getUint8(offset + 1) << 8);

    const btn0 = data.getUint8(1);
    const btn1 = data.getUint8(2);
    const btn2 = data.getUint8(3);
    // byte 4 = flags (touch/click state) — not surfaced in Phase 1

    // Sticks: int16 LE centered at 0, range ±0x7FFF → normalize to [-1, 1].
    // Y axes are inverted relative to the Gamepad-API "up = -1" convention,
    // so negate ly / ry. Confirmed via the level-B DevTools demo.
    const STICK_SCALE = 1 / 0x7FFF;
    const sticks = {
      lx: r(data, 9)  * STICK_SCALE,
      ly: -r(data, 11) * STICK_SCALE,
      rx: r(data, 13) * STICK_SCALE,
      ry: -r(data, 15) * STICK_SCALE,
    };

    // Triggers: int16 LE 0..0x7FFF (positive only). Right trigger has an
    // explicit "full pull" digital bit (btn2 0x80) for the hard click;
    // left trigger appears to be analog-only in this firmware.
    const TRIG_SCALE = 1 / 0x7FFF;
    const triggers = {
      l2: Math.max(0, r(data, 5)) * TRIG_SCALE,
      r2: Math.max(0, r(data, 7)) * TRIG_SCALE,
    };

    const buttons = {
      // Face buttons (Xbox layout per the printed glyphs on the pad)
      cross:    !!(btn0 & 0x01), // A
      circle:   !!(btn0 & 0x02), // B
      square:   !!(btn0 & 0x04), // X
      triangle: !!(btn0 & 0x08), // Y
      // Shoulders
      l1:       !!(btn2 & 0x08), // LB
      r1:       !!(btn1 & 0x02), // RB
      // System buttons
      create:   !!(btn1 & 0x40), // View
      options:  !!(btn0 & 0x40), // Menu
      ps:       !!(btn2 & 0x01), // Steam (PS-equivalent)
      // Stick clicks
      l3:       !!(btn1 & 0x80),
      r3:       !!(btn0 & 0x20),
      // D-pad
      dpadUp:    !!(btn1 & 0x20),
      dpadDown:  !!(btn1 & 0x04),
      dpadLeft:  !!(btn1 & 0x10),
      dpadRight: !!(btn1 & 0x08),
    };

    // Back paddles aren't in the standard Gamepad-API slot map. Surface
    // them on a separate `paddles` field so future consumers (HUD
    // widgets, custom binding UI) can pick them up without us mis-
    // synthesizing them as duplicate face buttons.
    const paddles = {
      l4: !!(btn2 & 0x02),
      l5: !!(btn2 & 0x04),
      r4: !!(btn0 & 0x80),
      r5: !!(btn1 & 0x01),
    };

    // Trackpads: two int16 LE XY pairs + a contact-area uint16 each.
    // The contact-area being non-zero is the cleanest "is the finger
    // touching this trackpad" signal; X/Y read 0 when not touching but
    // also legitimately 0 dead-center.
    const lPadArea = u16(21);
    const rPadArea = u16(27);
    const touchpad = [
      {
        active: lPadArea > 0,
        id: 0,
        x: r(data, 17),
        y: r(data, 19),
        area: lPadArea,
      },
      {
        active: rPadArea > 0,
        id: 1,
        x: r(data, 23),
        y: r(data, 25),
        area: rPadArea,
      },
    ];

    // IMU encoding (2026 firmware) — determined by per-axis variance
    // analysis of a real Test Report capture (see issue #8). The
    // 53-byte STATE report's IMU layout is:
    //
    //   bytes 29-32 = uint32 LE timestamp (~1 MHz clock tick)
    //   bytes 33-38 = 3-axis accelerometer (int16 LE per axis, ±2g full scale)
    //   bytes 39-44 = 3-axis gyroscope    (int16 LE per axis, ±2000 dps)
    //   bytes 45+   = always-zero padding
    //
    // This differs from SteamlessController's documented layout (which
    // claims a 4-int16 quaternion at data[31-38]) — that overlaps the
    // timestamp on 2026 firmware. The rate-based encoding is identical
    // to DualSense's, so parsed.gyro + parsed.accel flow through the
    // standard SensorFusion pipeline; orientation/calibration/drift-
    // correction all work the same way as on Sony controllers, with no
    // need for a quaternion fast-path.
    //
    // At-rest verification on real hardware:
    //   gyro all axes: 0 ± 0.2 dps (perfect zero-bias)
    //   accel Z: ≈ 0.5 normalized = 1.0g at ±2g scale (gravity vector)
    //
    // Body-to-visualizer frame remap: swap Y↔Z on both gyro AND accel.
    // The Steam Controller's IMU body frame has +Z pointing up (gravity
    // reads as +1g on body-Z when flat face-up). The visualizer's
    // SensorFusion expects gravity along world +Y (Three.js "Y up"
    // convention, same as DualSense). Swapping Y and Z on accel moves
    // gravity to body-Y so fusion converges to identity at rest instead
    // of slerping for ~5 seconds. The matching swap on gyro keeps
    // rotations consistent: physical roll (rotation about body Y, which
    // becomes body Z after swap) maps to visualizer roll axis; physical
    // yaw (body Z → body Y after swap) maps to visualizer yaw axis.
    const gyro = {
      x: r(data, 39),
      y: r(data, 43),
      z: -r(data, 41),
    };
    const accel = {
      x: r(data, 33),
      y: r(data, 37),
      z: -r(data, 35),
    };

    return {
      sticks,
      triggers,
      buttons,
      paddles,
      touchpad,
      touchpadButton: false,
      gyro,
      accel,
      gyroScale: 2000.0 / 32768.0,  // ±2000 dps, 16-bit
      accelScale: 1.0 / 16384.0,    // ±2g, 16-bit (gravity ≈ 16384)
    };
  }

  static detectConnectionType() { return 'usb'; }
}
