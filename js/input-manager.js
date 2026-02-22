// ============================================================
// INPUT MANAGER — keyboard + touch + device motion + gamepad
// ============================================================

import { isMobile } from './config.js';

// WebHID gyro constants (PlayStation DualSense / DualShock 4)
const VENDOR_ID_SONY = 0x054c;
const SONY_PRODUCT_IDS = [0x0ce6, 0x0df2, 0x05c4, 0x09cc];
const GYRO_SCALE = 2000.0 / 32768.0; // raw → degrees/sec
const GYRO_CALIB_COUNT = 150;         // ~1.5s at 100Hz

export class InputManager {
  constructor() {
    this.keys = {};
    this.touchLeft = false;
    this.touchRight = false;
    this.motionLean = 0;
    this.motionEnabled = false;
    this.motionReady = false;
    this.rawGamma = 0;
    this.motionOffset = null;
    this.motionRawRelative = 0;

    // Gamepad state
    this.gamepadIndex = null;
    this.gamepadConnected = false;
    this.gamepadLean = 0;
    this._gpTriggerLeftVal = 0;
    this._gpTriggerRightVal = 0;
    this._gpTriggerLeftPressed = false;
    this._gpTriggerRightPressed = false;

    // WebHID gyro state
    this.gyroDevice = null;
    this.gyroConnected = false;
    this._gyroConnType = null;       // 'usb' | 'bluetooth'
    this._gyroBias = { x: 0, y: 0, z: 0 };
    this._gyroCalibrating = false;
    this._gyroCalibSamples = [];
    this._gyroRollAccum = 0;         // cumulative roll angle in degrees
    this._lastGyroTime = 0;
    this._gyroReportHandler = null;

    this._setupKeyboard();
    this._setupGamepad();
    if (isMobile) {
      this._setupTouch();
      this._setupMotion();
      this._setupCalibration();
    }
  }

  _setupKeyboard() {
    window.addEventListener('keydown', (e) => {
      const tag = document.activeElement && document.activeElement.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (['ArrowUp','ArrowDown','KeyA','KeyD'].includes(e.code)) e.preventDefault();
      this.keys[e.code] = true;
    });
    window.addEventListener('keyup', (e) => {
      const tag = document.activeElement && document.activeElement.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      this.keys[e.code] = false;
    });
  }

  _setupTouch() {
    const leftBtn = document.getElementById('touch-left');
    const rightBtn = document.getElementById('touch-right');

    // Track which touch identifiers are on each pedal
    this._leftTouchId = null;
    this._rightTouchId = null;

    // Passive listeners — touch-action:none on <body> already prevents
    // scrolling/zooming, so e.preventDefault() is unnecessary.  Non-passive
    // touchstart + preventDefault under rapid tapping can lock up Safari's
    // gesture recogniser, freezing ALL touch/click dispatch on the page.
    leftBtn.addEventListener('touchstart', (e) => {
      this._leftTouchId = e.changedTouches[0].identifier;
      this.touchLeft = true;
    }, { passive: true });

    rightBtn.addEventListener('touchstart', (e) => {
      this._rightTouchId = e.changedTouches[0].identifier;
      this.touchRight = true;
    }, { passive: true });

    // Global touchend — catches releases even if finger drifted off the button
    const resetIfEmpty = (e) => {
      for (let i = 0; i < e.changedTouches.length; i++) {
        const id = e.changedTouches[i].identifier;
        if (id === this._leftTouchId) { this.touchLeft = false; this._leftTouchId = null; }
        if (id === this._rightTouchId) { this.touchRight = false; this._rightTouchId = null; }
      }
      // Safety: when no fingers remain on screen, clear any stuck state
      if (e.touches.length === 0) {
        this.touchLeft = false;
        this.touchRight = false;
        this._leftTouchId = null;
        this._rightTouchId = null;
      }
    };
    window.addEventListener('touchend', resetIfEmpty, { passive: true });
    window.addEventListener('touchcancel', resetIfEmpty, { passive: true });
  }

  _setupMotion() {
    if (typeof DeviceMotionEvent !== 'undefined' &&
        typeof DeviceMotionEvent.requestPermission === 'function') {
      this.needsMotionPermission = true;
    } else if (typeof DeviceMotionEvent !== 'undefined') {
      this._startMotionListening();
    }
  }

  async requestMotionPermission() {
    if (this.motionEnabled) return;
    this.needsMotionPermission = false;
    if (typeof DeviceMotionEvent === 'undefined' ||
        typeof DeviceMotionEvent.requestPermission !== 'function') return;
    try {
      const response = await DeviceMotionEvent.requestPermission();
      if (response === 'granted') this._startMotionListening();
    } catch (e) {
      console.warn('Motion permission error:', e);
    }
  }

  _startMotionListening() {
    this.motionReady = true;
    this._useAccel = false;
    this._gx = 0; this._gy = 0; this._gz = 0;
    this._gravityInit = false;

    window.addEventListener('devicemotion', (e) => {
      const a = e.accelerationIncludingGravity;
      if (!a || a.x == null) return;
      this._useAccel = true;
      this.motionEnabled = true;

      const k = 0.3;
      if (!this._gravityInit) {
        this._gx = a.x; this._gy = a.y; this._gz = a.z;
        this._gravityInit = true;
      } else {
        this._gx += (a.x - this._gx) * k;
        this._gy += (a.y - this._gy) * k;
        this._gz += (a.z - this._gz) * k;
      }

      const orient = screen.orientation ? screen.orientation.angle : (window.orientation || 0);
      let rollRad;
      if (orient === 90) rollRad = Math.atan2(this._gy, -this._gx);
      else if (orient === 270 || orient === -90) rollRad = Math.atan2(-this._gy, this._gx);
      else rollRad = Math.atan2(this._gx, this._gy);

      this._applyTilt(-rollRad * 180 / Math.PI);
    });

    window.addEventListener('deviceorientation', (e) => {
      if (this._useAccel) return;
      const orient = screen.orientation ? screen.orientation.angle : (window.orientation || 0);
      let rawTilt;
      if (orient === 90) rawTilt = e.beta;
      else if (orient === 270 || orient === -90) rawTilt = -e.beta;
      else rawTilt = e.gamma;

      if (rawTilt != null) {
        this.motionEnabled = true;
        this._applyTilt(rawTilt);
      }
    });
  }

  _applyTilt(rawTilt) {
    this.rawGamma = rawTilt;
    if (this.motionOffset === null) this.motionOffset = this.rawGamma;

    let relative = this.rawGamma - this.motionOffset;
    if (relative > 180) relative -= 360;
    else if (relative < -180) relative += 360;
    this.motionRawRelative = relative;

    const deadZone = 2;
    if (Math.abs(relative) < deadZone) {
      relative = 0;
    } else {
      relative = relative - Math.sign(relative) * deadZone;
    }
    this.motionLean = Math.max(-1, Math.min(1, relative / 40));
  }

  _setupCalibration() {
    const gauge = document.getElementById('phone-gauge');
    const flash = document.getElementById('calibrate-flash');
    const doCalibrate = (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.motionOffset = this.rawGamma;
      this.motionLean = 0;
      if (flash) { flash.style.display = 'block'; setTimeout(() => { flash.style.display = 'none'; }, 800); }
    };
    gauge.addEventListener('touchstart', doCalibrate, { passive: false });
    gauge.addEventListener('click', doCalibrate);
  }

  _setupGamepad() {
    window.addEventListener('gamepadconnected', (e) => {
      this.gamepadIndex = e.gamepad.index;
      this.gamepadConnected = true;
      console.log('Gamepad connected:', e.gamepad.id);
      const badge = document.getElementById('gamepad-badge');
      if (badge) badge.style.display = 'block';
      const pedalBar = document.getElementById('pedal-bar');
      if (pedalBar) pedalBar.classList.add('gamepad-active');
    });
    window.addEventListener('gamepaddisconnected', (e) => {
      if (this.gamepadIndex === e.gamepad.index) {
        this.gamepadIndex = null;
        this.gamepadConnected = false;
        this.gamepadLean = 0;
        this._gpTriggerLeftVal = 0;
        this._gpTriggerRightVal = 0;
        this._gpTriggerLeftPressed = false;
        this._gpTriggerRightPressed = false;
        console.log('Gamepad disconnected');
        const badge = document.getElementById('gamepad-badge');
        if (badge) badge.style.display = 'none';
        const pedalBar = document.getElementById('pedal-bar');
        if (pedalBar) pedalBar.classList.remove('gamepad-active');
      }
    });
  }

  pollGamepad() {
    // Polling fallback: detect gamepads even without events
    if (this.gamepadIndex === null) {
      const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
      for (let i = 0; i < gamepads.length; i++) {
        if (gamepads[i]) {
          this.gamepadIndex = i;
          this.gamepadConnected = true;
          const badge = document.getElementById('gamepad-badge');
          if (badge) badge.style.display = 'block';
          const pedalBar = document.getElementById('pedal-bar');
          if (pedalBar) pedalBar.classList.add('gamepad-active');
          break;
        }
      }
    }

    if (this.gamepadIndex === null) return;

    const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
    const gp = gamepads[this.gamepadIndex];
    if (!gp) return;

    // Left stick X — deadzone 0.08
    const rawX = gp.axes[0] || 0;
    this.gamepadLean = Math.abs(rawX) < 0.08 ? 0 : rawX;

    // Triggers: buttons[6] = LT, buttons[7] = RT
    const THRESHOLD = 0.5;
    this._gpTriggerLeftVal = gp.buttons[6] ? gp.buttons[6].value : 0;
    this._gpTriggerRightVal = gp.buttons[7] ? gp.buttons[7].value : 0;
    this._gpTriggerLeftPressed = this._gpTriggerLeftVal >= THRESHOLD;
    this._gpTriggerRightPressed = this._gpTriggerRightVal >= THRESHOLD;
  }

  getGamepadLean() {
    return this.gamepadConnected ? this.gamepadLean : 0;
  }

  isPressed(code) {
    if (code === 'ArrowUp') return !!this.keys[code] || this.touchLeft || this._gpTriggerLeftPressed;
    if (code === 'ArrowDown') return !!this.keys[code] || this.touchRight || this._gpTriggerRightPressed;
    return !!this.keys[code];
  }

  // ── WebHID gyro (PlayStation controllers) ──────────────────

  async connectControllerGyro() {
    if (this.gyroConnected || !navigator.hid) return;

    const filters = SONY_PRODUCT_IDS.map(productId => ({
      vendorId: VENDOR_ID_SONY, productId,
      usagePage: 0x0001, usage: 0x0005
    }));

    const devices = await navigator.hid.requestDevice({ filters });
    if (!devices || devices.length === 0) return;

    const device = devices[0];
    if (!device.opened) await device.open();

    this.gyroDevice = device;
    this._gyroConnType = this._detectGyroConnType(device);
    console.log('WebHID gyro connected:', device.productName, '(' + this._gyroConnType + ')');

    this._gyroReportHandler = (e) => this._handleGyroReport(e);
    device.addEventListener('inputreport', this._gyroReportHandler);

    this.gyroConnected = true;
    this._startGyroCalibration();
  }

  disconnectControllerGyro() {
    if (this.gyroDevice) {
      if (this._gyroReportHandler) {
        this.gyroDevice.removeEventListener('inputreport', this._gyroReportHandler);
        this._gyroReportHandler = null;
      }
      this.gyroDevice.close().catch(() => {});
    }
    this.gyroDevice = null;
    this.gyroConnected = false;
    this._gyroConnType = null;
    this._gyroBias = { x: 0, y: 0, z: 0 };
    this._gyroCalibrating = false;
    this._gyroCalibSamples = [];
    this._gyroRollAccum = 0;
    this._lastGyroTime = 0;
  }

  calibrateGyro() {
    this._startGyroCalibration();
  }

  _detectGyroConnType(device) {
    for (const col of device.collections) {
      if (col.outputReports && col.outputReports.length > 0) {
        for (const report of col.outputReports) {
          if (report.reportId === 0x31) return 'bluetooth';
        }
      }
    }
    return 'usb';
  }

  _startGyroCalibration() {
    this._gyroCalibrating = true;
    this._gyroCalibSamples = [];
    this._gyroRollAccum = 0;
    this._lastGyroTime = 0;
    this.motionOffset = null;
  }

  _finishGyroCalibration() {
    if (this._gyroCalibSamples.length === 0) return;
    let sx = 0, sy = 0, sz = 0;
    for (const s of this._gyroCalibSamples) { sx += s.x; sy += s.y; sz += s.z; }
    this._gyroBias.x = sx / this._gyroCalibSamples.length;
    this._gyroBias.y = sy / this._gyroCalibSamples.length;
    this._gyroBias.z = sz / this._gyroCalibSamples.length;
    this._gyroCalibrating = false;
    this._gyroCalibSamples = [];
    this._gyroRollAccum = 0;
    this._lastGyroTime = 0;
    this.motionOffset = null;
    this.motionEnabled = true;
    console.log('Gyro bias:', this._gyroBias);
  }

  _handleGyroReport(event) {
    const report = event.data;
    const reportId = event.reportId;
    const now = performance.now();

    let gyroOffset;
    if (this._gyroConnType === 'usb' && reportId === 0x01) {
      gyroOffset = 15;
    } else if (this._gyroConnType === 'bluetooth' && reportId === 0x31) {
      gyroOffset = 16;
    } else {
      return;
    }

    const rawGx = this._readSigned16(report, gyroOffset);
    const rawGy = this._readSigned16(report, gyroOffset + 2);
    const rawGz = this._readSigned16(report, gyroOffset + 4);

    // Calibration sampling
    if (this._gyroCalibrating) {
      this._gyroCalibSamples.push({ x: rawGx, y: rawGy, z: rawGz });
      if (this._gyroCalibSamples.length >= GYRO_CALIB_COUNT) this._finishGyroCalibration();
      this._lastGyroTime = now;
      return;
    }

    // Apply bias correction
    const gx = rawGx - this._gyroBias.x;
    const gy = rawGy - this._gyroBias.y;
    const gz = rawGz - this._gyroBias.z;

    // Integrate Z axis for steering (negated to match tilt direction)
    if (this._lastGyroTime > 0) {
      const dt = (now - this._lastGyroTime) / 1000.0;
      if (dt < 0.1) {
        this._gyroRollAccum -= gz * GYRO_SCALE * dt;
        // Drift correction: decay toward zero to prevent runaway accumulation
        this._gyroRollAccum *= (1 - 0.5 * dt);
      }
    }
    this._lastGyroTime = now;

    // Clamp to sane range
    this._gyroRollAccum = Math.max(-90, Math.min(90, this._gyroRollAccum));

    // Feed into tilt pipeline — full lean at ~40° of controller tilt
    // Only update if motion is enabled (lobby toggle can disable it)
    if (!this.motionEnabled) return;
    this._applyTilt(this._gyroRollAccum);
  }

  _readSigned16(data, offset) {
    let val = data.getUint8(offset) | (data.getUint8(offset + 1) << 8);
    if (val > 0x7FFF) val -= 0x10000;
    return val;
  }

  getMotionLean() {
    return this.motionEnabled ? this.motionLean : 0;
  }
}
