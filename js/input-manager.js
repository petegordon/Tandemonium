// ============================================================
// INPUT MANAGER — keyboard + touch + device motion + gamepad
// ============================================================

import { isMobile, TUNE } from './config.js';

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
    this._leftTapped = false;   // buffered tap: survives until consumeTaps()
    this._rightTapped = false;
    this.motionLean = 0;
    this.motionEnabled = false;
    this.motionReady = false;
    this.onMotionEnabled = null; // callback when motionEnabled first becomes true
    this.rawGamma = 0;
    this.motionOffset = null;
    this.motionRawRelative = 0;
    this._smoothedLean = 0;
    this._calibBuf = [];
    this._calibrating = false;

    // Gamepad state
    this.gamepadIndex = null;
    this.gamepadConnected = false;
    this.gamepadLean = 0;
    this._gpTriggerLeftVal = 0;
    this._gpTriggerRightVal = 0;
    this._gpTriggerLeftPressed = false;
    this._gpTriggerRightPressed = false;
    this.suppressGamepadBadge = false;

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
    this._accelVerified = false;     // accel byte offsets validated

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
      if (['ArrowLeft','ArrowRight','KeyA','KeyD'].includes(e.code)) e.preventDefault();
      this.keys[e.code] = true;
    });
    window.addEventListener('keyup', (e) => {
      const tag = document.activeElement && document.activeElement.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      this.keys[e.code] = false;
    });
  }

  _setupTouch() {
    const pedalBar = document.getElementById('pedal-bar');

    // Track which touch identifiers are on each pedal
    this._leftTouchId = null;
    this._rightTouchId = null;
    this._pedalMidX = 0;

    // Use the full pedal-bar as the touch zone so the 10px gap between
    // buttons isn't a dead spot.  Left/right is split at the midpoint.
    pedalBar.style.pointerEvents = 'auto';

    const assignTouch = (t) => {
      if (t.clientX < this._pedalMidX) {
        this._leftTouchId = t.identifier;
        this.touchLeft = true;
        this._leftTapped = true;   // buffered: persists until game loop reads it
      } else {
        this._rightTouchId = t.identifier;
        this.touchRight = true;
        this._rightTapped = true;
      }
    };

    pedalBar.addEventListener('touchstart', (e) => {
      // Cache midpoint each touchstart (handles orientation changes)
      const rect = pedalBar.getBoundingClientRect();
      this._pedalMidX = rect.left + rect.width / 2;
      for (let i = 0; i < e.changedTouches.length; i++) {
        assignTouch(e.changedTouches[i]);
      }
    }, { passive: true });

    // Finger slides between pedals — reassign the touch to the new side
    pedalBar.addEventListener('touchmove', (e) => {
      for (let i = 0; i < e.changedTouches.length; i++) {
        const t = e.changedTouches[i];
        const isLeft = t.clientX < this._pedalMidX;
        if (isLeft && t.identifier === this._rightTouchId) {
          this.touchRight = false; this._rightTouchId = null;
          this._leftTouchId = t.identifier;
          this.touchLeft = true; this._leftTapped = true;
        } else if (!isLeft && t.identifier === this._leftTouchId) {
          this.touchLeft = false; this._leftTouchId = null;
          this._rightTouchId = t.identifier;
          this.touchRight = true; this._rightTapped = true;
        }
      }
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
    // iOS 13+ requires a user-gesture-gated requestPermission() call
    if (typeof DeviceMotionEvent !== 'undefined' &&
        typeof DeviceMotionEvent.requestPermission === 'function') {
      this.needsMotionPermission = true;
    } else if (typeof DeviceOrientationEvent !== 'undefined' &&
        typeof DeviceOrientationEvent.requestPermission === 'function') {
      this.needsMotionPermission = true;
    } else if (typeof DeviceOrientationEvent !== 'undefined' || typeof DeviceMotionEvent !== 'undefined') {
      this._startMotionListening();
    }
  }

  async requestMotionPermission() {
    if (this.motionEnabled) return;
    this.needsMotionPermission = false;
    // iOS: DeviceMotionEvent.requestPermission() grants access to BOTH
    // motion and orientation events — call it first (proven iOS API).
    if (typeof DeviceMotionEvent !== 'undefined' &&
        typeof DeviceMotionEvent.requestPermission === 'function') {
      try {
        const response = await DeviceMotionEvent.requestPermission();
        if (response === 'granted') this._startMotionListening();
      } catch (e) {
        console.warn('Motion permission error:', e);
      }
    }
    // Also request orientation permission if available and not yet listening
    if (!this.motionReady &&
        typeof DeviceOrientationEvent !== 'undefined' &&
        typeof DeviceOrientationEvent.requestPermission === 'function') {
      try {
        const response = await DeviceOrientationEvent.requestPermission();
        if (response === 'granted') this._startMotionListening();
      } catch (e) {
        console.warn('Orientation permission error:', e);
      }
    }
  }

  _startMotionListening() {
    if (this.motionReady) return; // prevent duplicate listeners
    this.motionReady = true;
    this._useOrientation = false;
    this._gx = 0; this._gy = 0; this._gz = 0;
    this._gravityInit = false;

    // Primary: deviceorientation (browser sensor fusion — smoother)
    window.addEventListener('deviceorientation', (e) => {
      const orient = screen.orientation ? screen.orientation.angle : (window.orientation || 0);
      let rawTilt;
      if (orient === 90) rawTilt = e.beta;
      else if (orient === 270 || orient === -90) rawTilt = -e.beta;
      else {
        // When phone is tilted past vertical (|beta| > 90°, e.g. lying in bed
        // with screen facing down at user), gamma's left-right direction inverts.
        // Use a smooth blend zone (80°–100°) to avoid jitter at the boundary.
        const absBeta = Math.abs(e.beta || 0);
        if (absBeta > 100) {
          rawTilt = -e.gamma;
        } else if (absBeta > 80) {
          const t = (absBeta - 80) / 20;
          rawTilt = e.gamma * (1 - 2 * t);
        } else {
          rawTilt = e.gamma;
        }
      }

      if (rawTilt != null) {
        this._useOrientation = true;
        if (!this.motionEnabled && this.onMotionEnabled) this.onMotionEnabled();
        this.motionEnabled = true;
        this._applyTilt(rawTilt);
      }
    });

    // Fallback: devicemotion (only if orientation events don't fire)
    window.addEventListener('devicemotion', (e) => {
      if (this._useOrientation) return;
      const a = e.accelerationIncludingGravity;
      if (!a || a.x == null) return;
      if (!this.motionEnabled && this.onMotionEnabled) this.onMotionEnabled();
      this.motionEnabled = true;

      const dtMs = e.interval || 16;  // event.interval is in ms; fallback 16ms ≈ 60Hz
      const dt = dtMs / 1000;
      const k = 1 - Math.pow(1 - TUNE.lowPassK, dt * 60);
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
  }

  startTiltCalibration() {
    this._calibrating = true;
    this._calibBuf = [];
  }

  _applyTilt(rawTilt, isGyro = false) {
    this.rawGamma = rawTilt;

    if (this.motionOffset === null && !this._calibrating) {
      this.startTiltCalibration();
    }

    if (this._calibrating) {
      this._calibBuf.push(this.rawGamma);
      if (this._calibBuf.length >= TUNE.calibSamples) {
        const sum = this._calibBuf.reduce((a, b) => a + b, 0);
        this.motionOffset = sum / this._calibBuf.length;
        this._calibrating = false;
        this._calibBuf = [];
      }
      return;
    }

    let relative = this.rawGamma - this.motionOffset;
    if (relative > 180) relative -= 360;
    else if (relative < -180) relative += 360;
    this.motionRawRelative = relative;

    // Select tuning parameters based on input source
    const sensitivity = isGyro ? TUNE.gyroSensitivity : TUNE.sensitivity;
    const deadzone = isGyro ? TUNE.gyroDeadzone : TUNE.deadzone;
    const responseCurve = isGyro ? TUNE.gyroResponseCurve : TUNE.responseCurve;
    const outputSmoothing = isGyro ? TUNE.gyroOutputSmoothing : TUNE.outputSmoothing;

    const absRel = Math.abs(relative);
    let lean;

    if (absRel < deadzone) {
      lean = 0;
    } else {
      const reduced = absRel - deadzone;
      const range = sensitivity - deadzone;
      const normalized = Math.min(reduced / range, 1.0);
      lean = Math.sign(relative) * Math.pow(normalized, responseCurve);
    }

    this._smoothedLean += (lean - this._smoothedLean) * outputSmoothing;
    this.motionLean = this._smoothedLean;
  }

  _setupCalibration() {
    const gauge = document.getElementById('phone-gauge');
    const flash = document.getElementById('calibrate-flash');
    const doCalibrate = (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.startTiltCalibration();
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
      if (!this.suppressGamepadBadge) {
        const badge = document.getElementById('gamepad-badge');
        if (badge) badge.style.display = 'block';
      }
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
          if (!this.suppressGamepadBadge) {
            const badge = document.getElementById('gamepad-badge');
            if (badge) badge.style.display = 'block';
          }
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

    // Pedal buttons: LB/RB (buttons[4]/[5]) or LT/RT (buttons[6]/[7])
    const THRESHOLD = 0.5;
    const lb = gp.buttons[4] && gp.buttons[4].pressed;
    const rb = gp.buttons[5] && gp.buttons[5].pressed;
    this._gpTriggerLeftVal = gp.buttons[6] ? gp.buttons[6].value : 0;
    this._gpTriggerRightVal = gp.buttons[7] ? gp.buttons[7].value : 0;
    this._gpTriggerLeftPressed = lb || this._gpTriggerLeftVal >= THRESHOLD;
    this._gpTriggerRightPressed = rb || this._gpTriggerRightVal >= THRESHOLD;
  }

  getGamepadLean() {
    return this.gamepadConnected ? this.gamepadLean : 0;
  }

  isPressed(code) {
    if (code === 'ArrowLeft') return !!this.keys[code] || this.touchLeft || this._leftTapped || this._gpTriggerLeftPressed;
    if (code === 'ArrowRight') return !!this.keys[code] || this.touchRight || this._rightTapped || this._gpTriggerRightPressed;
    return !!this.keys[code];
  }

  /** Clear buffered tap flags — call once per frame after all input reading. */
  consumeTaps() {
    this._leftTapped = false;
    this._rightTapped = false;
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
    this._accelVerified = false;
  }

  calibrateGyro() {
    this._startGyroCalibration();
  }

  recenterGyro() {
    this._gyroRollAccum = 0;
    // Don't reset _smoothedLean/motionLean — they're shared with mobile tilt.
    // The EMA filter (gyroOutputSmoothing: 0.3) converges within ~100ms.
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

    // Accelerometer data sits immediately after gyro (6 bytes later)
    const rawAx = this._readSigned16(report, gyroOffset + 6);
    const rawAy = this._readSigned16(report, gyroOffset + 8);
    const rawAz = this._readSigned16(report, gyroOffset + 10);

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

        // Accelerometer-assisted drift correction
        if (!this._accelVerified) {
          // Verify accel byte offsets: gravity magnitude should be ~8192 (DualSense ±2g, 16-bit)
          const mag = Math.sqrt(rawAx * rawAx + rawAy * rawAy + rawAz * rawAz);
          if (mag > 4000 && mag < 16000) {
            this._accelVerified = true;
            console.log('Accel verified, magnitude:', mag.toFixed(0));
          } else {
            // Bad data — fall back to blanket decay instead of accel correction
            this._gyroRollAccum *= (1 - 0.5 * dt);
          }
        }
        if (this._accelVerified) {
          const accelRoll = Math.atan2(rawAx, rawAy) * (180 / Math.PI);
          const correction = (accelRoll - this._gyroRollAccum) * TUNE.gyroAccelCorrection;
          this._gyroRollAccum += correction;
        }
      }
    }
    this._lastGyroTime = now;

    // Clamp to sane range
    this._gyroRollAccum = Math.max(-90, Math.min(90, this._gyroRollAccum));

    // Feed into tilt pipeline with gyro-specific tuning
    // Only update if motion is enabled (lobby toggle can disable it)
    if (!this.motionEnabled) return;
    this._applyTilt(this._gyroRollAccum, true);
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
