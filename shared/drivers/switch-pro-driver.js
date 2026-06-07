// ============================================================
// NINTENDO SWITCH PRO CONTROLLER DRIVER
// ============================================================

import { ControllerDriver } from './base-driver.js';

// Identity (vid:pid, name, capabilities, gamepad-id pattern, GameSir Cyclone
// swapAB quirk) lives in devices.js — this class is the Switch Pro protocol
// only.

export class SwitchProDriver extends ControllerDriver {

  // No usagePage/usage filter — the Gamepad API claims the gamepad interface
  // exclusively on macOS Chrome. Using vendor+product only lets the picker
  // show any available HID interface for this device.
  static makeHidFilter(vendorId, productId) {
    return { vendorId, productId };
  }

  constructor(device, connectionType, entry = null) {
    super(device, connectionType, entry);
    this._packetNumber = 0;
    this._debugCount = 0;
    this._reportIds = new Set();
    this._initSuccess = false;
    // Declared byte count for output report 0x01. USB Switch Pro declares
    // 48+ bytes, BT declares a smaller count. Computed from device.collections
    // at init() time. Null means "unknown — use the USB default size of 49."
    this._output01Size = null;
  }

  /**
   * Inspect device.collections and find the declared byte size for an
   * output report. Returns null if the report isn't declared anywhere —
   * _sendSubCommand will then fall back to a sensible default.
   */
  _declaredOutputSize(reportId) {
    if (!this.device || !this.device.collections) return null;
    for (const col of this.device.collections) {
      const reports = col.outputReports || [];
      for (const r of reports) {
        if (r.reportId !== reportId) continue;
        let bits = 0;
        for (const item of r.items || []) {
          bits += (item.reportSize || 0) * (item.reportCount || 0);
        }
        if (bits > 0) return Math.ceil(bits / 8);
      }
    }
    return null;
  }

  /**
   * Switch Pro requires sub-commands to enable IMU and full report mode.
   * Over BT, the output report 0x01 is declared with a smaller byte count
   * than USB, so we size the sub-command buffer from device.collections
   * instead of hard-coding 49. Retries in case the device isn't ready
   * immediately after open().
   */
  async init() {
    const MAX_ATTEMPTS = 3;

    // Snapshot the declared output-report size so _sendSubCommand can match
    // what the HID descriptor actually accepts. The previous hard-coded
    // 49-byte buffer over-ran BT's declared size and made sendReport() fail
    // with "Failed to write the report."
    this._output01Size = this._declaredOutputSize(0x01);
    console.log('Switch Pro: declared size for output 0x01 =',
      this._output01Size == null ? 'unknown (using default 49)' : this._output01Size);

    // USB-specific Nintendo handshake (#225). Over BT, macOS / Linux /
    // Windows all host the transport and the sub-commands on output 0x01
    // Just Work. Over USB on Windows + Linux, the Nintendo Pro Controller
    // needs its handshake on output report 0x80 BEFORE the 0x01
    // sub-commands take full effect — otherwise 0x30 reports stream but
    // the IMU byte range stays all-zero. macOS's IOKit HID transport does
    // this handshake in-kernel, which is why macOS "just worked" before.
    if (this.connectionType === 'usb') {
      try {
        await this._nintendoUsbHandshake();
      } catch (err) {
        console.warn('Switch Pro USB handshake failed (continuing anyway):', err.message);
      }
    }

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        // Wait before sending commands — device needs time after open()
        await SwitchProDriver._delay(attempt === 1 ? 200 : 500);

        // Order matters for some USB Switch Pro clones (GameSir Super Nova,
        // Cyclone): setting full-report mode before enabling IMU avoids the
        // case where IMU enable is silently dropped by a controller still in
        // "standard" input mode. We also re-send IMU enable after the mode
        // switch as belt-and-suspenders — some clones reset IMU state when
        // the input report mode changes.
        await this._sendSubCommand(0x03, [0x30]);
        await SwitchProDriver._delay(200);

        await this._sendSubCommand(0x40, [0x01]);
        await SwitchProDriver._delay(200);

        // Second IMU enable after mode settle
        await this._sendSubCommand(0x40, [0x01]);
        await SwitchProDriver._delay(150);

        this._initSuccess = true;
        console.log('Switch Pro Controller: full report mode set, IMU enabled (attempt ' + attempt + ')');
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
    //   Byte 0:     timer
    //   Byte 1:     battery + connection info
    //   Bytes 2-4:  button status (3 bytes)
    //   Bytes 5-7:  left stick (3 bytes packed)
    //   Bytes 8-10: right stick (3 bytes packed)
    //   Byte 11:    vibrator input report
    //   Bytes 12-47: 3 IMU frames × 12 bytes each
    //     Each frame: [accelX(2), accelY(2), accelZ(2), gyroX(2), gyroY(2), gyroZ(2)]
    //
    // Wire size: BT sends exactly 48 bytes; USB pads further. We only read the
    // first IMU frame, so the true minimum is 24 bytes (header + frame 0).

    if (data.byteLength < 24) return null;

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

    // Remap axes to the common DualSense-aligned frame expected by
    // InputManager's sensor fusion pipeline. This is the same transform
    // the controller-overlay applies via controller-profiles.js's
    // Switch Pro gyroTransform: (gx, gy, gz) => [-gz, gy, -gx] chained
    // after an initial (x: rawX, y: rawZ, z: rawY) swap — collapsing to
    // a single transform that takes the Switch Pro's raw IMU axes
    // directly to the final common frame:
    //
    //   gyro.x = -rawGyroY   (roll-axis mapped to final -X)
    //   gyro.y =  rawGyroZ   (yaw-axis mapped to final Y)
    //   gyro.z = -rawGyroX   (sign-flipped mapping to final -X... wait see below)
    //
    // The pre-sensor-fusion scalar integration only used gyro.z for
    // steering, so the partial remap `{rawX, rawZ, rawY}` was good
    // enough for that; it put "something roll-like" at index z. With
    // full 3D sensor fusion, all three axes need to be in the final
    // common frame, otherwise pitch/yaw contaminate the Z integration.
    // The previous partial remap also had the wrong sign for gyro.z
    // relative to DualSense, which surfaced as "Switch Pro lean is
    // inverted" once sensor fusion landed.
    return {
      gyro: { x: -rawGyroY, y: rawGyroZ, z: -rawGyroX },
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

  // ── Nintendo USB handshake (output report 0x80) ──
  //
  // On USB, the Nintendo Pro Controller expects a small handshake sequence
  // on output report 0x80 before the normal sub-commands on 0x01 fully
  // take effect. macOS's IOKit HID transport runs this in-kernel, which is
  // why the overlay + game historically "just worked" on macOS but the
  // IMU byte range stayed all-zero on Windows / Linux.
  //
  // Command bytes (single-byte payload after the 0x80 report ID):
  //   0x02 — request handshake / device info
  //   0x03 — switch to 3 Mbps baud
  //   0x04 — disable USB timeout (keeps link alive)
  //
  // Sequence follows hid-nintendo / joycond:
  //   handshake → baud-up → handshake → disable-timeout
  //
  // If any write is rejected (some clones don't accept output 0x80 at all)
  // we log and move on — the caller's existing sub-command path will try
  // its best and the retry loop handles the rest.
  async _nintendoUsbHandshake() {
    const steps = [
      { cmd: 0x02, desc: 'handshake', delayMs: 100 },
      { cmd: 0x03, desc: 'baud 3Mbps', delayMs: 100 },
      { cmd: 0x02, desc: 'handshake (post-baud)', delayMs: 100 },
      { cmd: 0x04, desc: 'disable USB timeout', delayMs: 100 },
    ];
    for (const step of steps) {
      try {
        await this._sendUsbCommand(step.cmd);
        console.log(`Switch Pro USB: sent ${step.desc} (0x80 0x${step.cmd.toString(16).padStart(2, '0')})`);
      } catch (err) {
        console.warn(`Switch Pro USB: ${step.desc} (0x80 0x${step.cmd.toString(16).padStart(2, '0')}) failed: ${err.message}`);
        // Clone controllers may not accept 0x80 at all. Bail out — the
        // downstream sub-commands on 0x01 will still run and may work
        // for devices that don't need the handshake.
        return;
      }
      await SwitchProDriver._delay(step.delayMs);
    }
    console.log('Switch Pro USB: Nintendo handshake complete');
  }

  /** Send a single-byte command on output report 0x80. */
  async _sendUsbCommand(cmd) {
    const buf = new Uint8Array(1);
    buf[0] = cmd;
    await this.device.sendReport(0x80, buf);
  }

  // ── Sub-command protocol ──

  async _sendSubCommand(subCmd, args = []) {
    // Output report 0x01 layout (shared by USB and BT):
    //   byte 0:    packet counter (nibble)
    //   bytes 1-8: rumble data (8 bytes, neutral here)
    //   byte 9:    sub-command ID
    //   byte 10+:  sub-command args
    //
    // The total buffer size has to match what the HID descriptor declares
    // for report 0x01 on this device — USB declares 48+ bytes, BT declares
    // a smaller count. Over-sizing on BT causes sendReport to reject with
    // "Failed to write the report." Under-sizing on USB truncates the
    // rumble payload.
    const minSize = 10 + args.length;
    const declared = this._output01Size;
    const bufSize = declared != null
      ? Math.max(declared, minSize)
      : Math.max(49, minSize);           // USB default when descriptor is silent

    const buf = new Uint8Array(bufSize);
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
