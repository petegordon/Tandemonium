// ============================================================
// INPUT MANAGER — keyboard + touch + device motion + gamepad
// ============================================================

import * as THREE from 'three';
import { isMobile, TUNE } from './config.js';
import { ControllerRegistry } from './controllers/controller-registry.js';
import * as analytics from './analytics.js';
import { setHapticSources, addHapticSource, removeHapticSource } from './haptics.js';

const GYRO_CALIB_COUNT = 150;         // ~1.5s at 100Hz

// Stuck-IMU self-heal thresholds (see #198 — BT Switch Pro hot-swap race
// with macOS Game Controller framework).
const IMU_ZERO_TIMEOUT_MS = 500;      // how long zero IMU has to persist before we act
const MAX_IMU_REINIT = 2;             // cap on driver.init() re-runs per connect session

// Sensor fusion constants (from JibbSmart/GamepadMotionHelpers, ported via
// the controller-overlay sensor fusion implementation in PR #186). These
// govern how gravity tracking, shakiness detection, gyro rate limiting,
// and continuous stillness calibration all interact. See the GyroWiki
// "Finding Gravity with Sensor Fusion" article for the derivation.
const GRAVITY_STILL_SPEED = 1.0;
const GRAVITY_SHAKY_SPEED = 0.1;
const SHAKINESS_MIN_THRESHOLD = 0.01;
const SHAKINESS_MAX_THRESHOLD = 0.4;
const GRAVITY_GYRO_FACTOR = 0.1;       // cap correction at 10% of gyro speed
const GRAVITY_MIN_SPEED = 0.01;
const GRAVITY_GYRO_MIN_THRESHOLD = 0.05;
const GRAVITY_GYRO_MAX_THRESHOLD = 0.25;
const STEADINESS_HALF_TIME = 0.25;     // shakiness smoothing half-life (seconds)

// Continuous stillness calibration
const STILLNESS_WINDOW_TIME = 0.5;     // min collection time (seconds)
const STILLNESS_CORRECTION_TIME = 2.0; // must be still this long to recalibrate
const STILLNESS_CAL_HALF_TIME = 0.1;   // exponential lerp half-life
const STILLNESS_CAL_EASE_IN = 3.0;     // ramp-up time
const STILLNESS_DETERIORATION = 0.2;   // how fast min deltas grow per second

// Sensor-fusion calibration (runs during active motion, complements
// stillness calibration). Matches GamepadMotionHelpers
// AutoCalibration::AddSampleSensorFusion parameters exactly.
const SENSOR_FUSION_SMOOTHING_STRENGTH = 2.0;           // exponential smoothing factor for gyro/accel
const SENSOR_FUSION_ANGULAR_ACCEL_THRESHOLD = 20.0;     // deg/s² gate — above this we're being shaken too hard to trust
const SENSOR_FUSION_EASE_IN_TIME = 3.0;                 // ramp-up seconds before calibration blends in
const SENSOR_FUSION_HALF_TIME = 0.1;                    // exponential lerp half-life toward new bias

export class InputManager {
  /**
   * @param {Object} [options]
   * @param {number|null} [options.gamepadSlot=null] — if set, only claim the gamepad at this index (for local-MP P2). null = claim first available (legacy behavior).
   * @param {boolean} [options.enableKeyboard=true] — subscribe to window keydown/keyup.
   * @param {boolean} [options.enableTouch=true] — subscribe to mobile touch events (still guarded by isMobile).
   * @param {boolean} [options.enableMotion=true] — subscribe to device motion/orientation (still guarded by isMobile).
   */
  constructor(options = {}) {
    const {
      gamepadSlot = null,
      enableKeyboard = true,
      enableTouch = true,
      enableMotion = true,
    } = options;
    this._gamepadSlot = gamepadSlot;
    this.keyboardActive = enableKeyboard;

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
    this._prevLeanRaw = 0;       // for asymmetric smoothing direction detection
    this._calibBuf = [];
    this._calibrating = false;
    this._warmupCount = 0;

    // Time-based filtering for deviceorientation events
    this._lastOrientTime = 0;
    this._filteredRawTilt = null;
    this._lastApplyTiltTime = 0;

    // Velocity-dependent sensitivity: set by game loop each frame
    this.bikeSpeed = 0;
    this.bikeMaxSpeed = 19;

    // Drift compensation (mobile tilt only)
    this._driftEma = null;
    this._driftRate = 0.015;
    this._driftWindowK = 0.005;

    // Gamepad state
    this.gamepadIndex = null;
    this.gamepadConnected = false;
    this.gamepadLean = 0;
    this._gpTriggerLeftVal = 0;
    this._gpTriggerRightVal = 0;
    this._gpTriggerLeftPressed = false;
    this._gpTriggerRightPressed = false;
    this.suppressGamepadBadge = false;
    this.suppressGamepadLean = false;

    // WebHID gyro state
    this.gyroDevice = null;
    this.gyroConnected = false;
    this._gyroConnType = null;       // 'usb' | 'bluetooth'
    this._gyroBias = { x: 0, y: 0, z: 0 };
    this._gyroCalibrating = false;
    this._gyroCalibSamples = [];
    this._gyroRollAccum = 0;         // cumulative roll angle in degrees (derived from _gyroOrientation)
    this._lastGyroTime = 0;
    this._gyroReportHandler = null;
    this._accelVerified = false;     // accel byte offsets validated

    // Sensor fusion state (ported from controller-overlay — see PR #186
    // and the follow-up sensor fusion polish in feature/gyro-sensor-fusion).
    // Replaces the old scalar Euler integration + atan2 drift correction
    // with a full 3D quaternion integration and accelerometer-tracked
    // gravity vector. Per-instance so local MP (#195) sees clean state
    // on both P1 and P2.
    this._gyroOrientation = new THREE.Quaternion();
    this._gravityVec = new THREE.Vector3(0, -1, 0);
    this._smoothAccel = new THREE.Vector3(0, -1, 0);
    this._shakiness = 0;
    this._stillnessWindow = {
      samples: [],
      stillSince: 0,
      minDeltaGyro: 1.0,
      minDeltaAccel: 0.25,
      easeIn: 0,
    };
    // Sensor-fusion calibration state (Phase C #3). Ported from
    // GamepadMotion.hpp AutoCalibration::AddSampleSensorFusion. Runs
    // alongside stillness calibration — stillness handles "at rest",
    // sensor fusion handles "in motion" by cross-checking gyro rates
    // against accel-direction-change-derived angular velocity.
    this._sfSmoothedGyro = new THREE.Vector3();
    this._sfSmoothedPreviousAccel = new THREE.Vector3();
    this._sfPreviousAccel = new THREE.Vector3();
    this._sfTimeSteady = 0;
    this._sfSkippedTime = 0;
    // Reusable scratch vectors to avoid per-frame allocations in the hot
    // path. Instance-scoped so two InputManager instances can't clobber
    // each other mid-frame.
    this._tmpVec = new THREE.Vector3();
    this._tmpVec2 = new THREE.Vector3();
    this._tmpVec3 = new THREE.Vector3();
    this._tmpQuat = new THREE.Quaternion();
    this._tmpEuler = new THREE.Euler();

    // Stuck-IMU self-heal (see #198). When hot-swapping from a BT DualSense
    // to a BT Switch Pro on macOS, the Switch Pro's IMU-enable sub-command
    // races with macOS Game Controller framework's parallel SPI probes and
    // the IMU ends up disabled — 0x30 reports keep arriving but their IMU
    // byte range is all zeros. Detect that state post-calibration and
    // re-run driver.init() to re-send the enable-IMU sub-command. Capped
    // so a genuinely-broken controller can't loop forever.
    this._imuZeroSince = 0;          // ms timestamp when we first saw zero IMU, 0 = not currently zero
    this._imuReinitAttempts = 0;     // bounded by MAX_IMU_REINIT
    this._imuReinitInFlight = false; // guard against re-entering during the init await

    // Synthetic gamepad built from HID input reports. Required because
    // DualSense over Bluetooth, once switched into 0x31 full-report mode,
    // disappears from Chromium's Gamepad API entirely — sticks, buttons,
    // and triggers have to be parsed from the raw HID report and fed into
    // the same state pollGamepad() would otherwise read from a real
    // Gamepad. Null whenever we're not HID-driven; pollGamepad prefers
    // navigator.getGamepads() and only falls through here when that slot
    // comes back empty.
    this._syntheticGamepad = null;

    // Listener for the WebHID-level disconnect event. Needed because a
    // BT DualSense that's in 0x31 mode is invisible to the Gamepad API,
    // so the 'gamepaddisconnected' event never fires on unplug — only
    // the navigator.hid 'disconnect' event does.
    this._hidDisconnectListener = null;

    // Set while connectControllerGyro() is in flight. Protects the sticky
    // gamepad claim from being torn down by a silent Gamepad API drop
    // that fires DURING DualSenseDriver.init() — where the feature-0x05
    // write kicks the controller out of Chromium's gamepad mapper before
    // this.gyroDevice / this._controllerDriver have been assigned.
    this._hidConnecting = false;

    // Diagnostic properties (exposed for test pages)
    this._gpName = '';
    this._gpRawStickX = 0;
    this._gpLB = false;
    this._gpRB = false;
    this._gyroRawZ = 0;
    this._accelRawX = 0;
    this._accelRawY = 0;
    this._accelRawZ = 0;
    this._accelRoll = 0;

    if (enableKeyboard) this._setupKeyboard();
    this._setupGamepad();
    if (isMobile) {
      if (enableTouch) this._setupTouch();
      if (enableMotion) this._setupMotion();
      if (enableTouch || enableMotion) this._setupCalibration();
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

        // Time-based low-pass pre-filter on raw gamma.
        // This makes TUNE.lowPassK functional on the deviceorientation path.
        // Without this, lowPassK only applied to the devicemotion fallback,
        // which Android never uses (since deviceorientation events fire).
        // Uses the same frame-rate-independent formula as the devicemotion
        // fallback (line ~254) so behavior is consistent at any event rate.
        const now = performance.now();
        if (this._filteredRawTilt === null) {
          this._filteredRawTilt = rawTilt;
          this._lastOrientTime = now;
        } else {
          const dtSec = Math.min((now - this._lastOrientTime) / 1000, 0.1);
          const k = 1 - Math.pow(1 - TUNE.lowPassK, dtSec * 60);
          this._filteredRawTilt += (rawTilt - this._filteredRawTilt) * k;
          this._lastOrientTime = now;
        }

        this._applyTilt(this._filteredRawTilt);
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
    this._warmupCount = 5; // already warmed up if explicitly called
  }

  _applyTilt(rawTilt, isGyro = false) {
    this.rawGamma = rawTilt;

    // Track time between calls for rate-independent output smoothing
    const now = performance.now();
    const dtSec = this._lastApplyTiltTime
      ? Math.min((now - this._lastApplyTiltTime) / 1000, 0.1)
      : 1 / 60; // assume 60Hz on first call
    this._lastApplyTiltTime = now;

    if (this.motionOffset === null && !this._calibrating) {
      this._warmupCount++;
      if (this._warmupCount >= 5) {
        this.startTiltCalibration();
      }
      return;
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

    // Drift compensation: nudge motionOffset toward long-term average rawGamma
    // Only for mobile tilt (!isGyro), only when not actively steering
    if (!isGyro) {
      if (this._driftEma === null) {
        this._driftEma = this.rawGamma;
      } else {
        this._driftEma += (this.rawGamma - this._driftEma) * this._driftWindowK;
      }
      if (Math.abs(this._smoothedLean) < 0.3) {
        this.motionOffset += (this._driftEma - this.motionOffset) * this._driftRate;
      }
    }

    let relative = this.rawGamma - this.motionOffset;
    if (relative > 180) relative -= 360;
    else if (relative < -180) relative += 360;
    this.motionRawRelative = relative;

    // Select tuning parameters based on input source
    const sensitivity = isGyro ? TUNE.gyroSensitivity : TUNE.sensitivity;
    const deadzone = isGyro ? TUNE.gyroDeadzone : TUNE.deadzone;
    const outputSmoothing = isGyro ? TUNE.gyroOutputSmoothing : TUNE.outputSmoothing;

    const absRel = Math.abs(relative);
    let lean;

    // Piecewise response curve: linear zone near deadzone edge for fine control,
    // then power curve beyond for aggressive large corrections
    const linearZoneFrac = 0.15; // 15% of range is linear

    if (isGyro) {
      const norm = absRel < deadzone ? 0 : Math.min((absRel - deadzone) / (sensitivity - deadzone), 1.0);
      if (norm <= linearZoneFrac) {
        lean = Math.sign(relative) * (norm / linearZoneFrac) * linearZoneFrac;
      } else {
        const curved = (norm - linearZoneFrac) / (1 - linearZoneFrac);
        lean = Math.sign(relative) * (linearZoneFrac + (1 - linearZoneFrac) * Math.pow(curved, TUNE.gyroResponseCurve));
      }
    } else {
      // Mobile tilt: same piecewise approach
      if (absRel < deadzone) {
        lean = 0;
      } else {
        const reduced = absRel - deadzone;
        const range = sensitivity - deadzone;
        const norm = Math.min(reduced / range, 1.0);
        if (norm <= linearZoneFrac) {
          lean = Math.sign(relative) * (norm / linearZoneFrac) * linearZoneFrac;
        } else {
          const curved = (norm - linearZoneFrac) / (1 - linearZoneFrac);
          lean = Math.sign(relative) * (linearZoneFrac + (1 - linearZoneFrac) * Math.pow(curved, TUNE.responseCurve));
        }
      }
    }

    // Velocity-dependent sensitivity: scale down lean at high speed for stability
    const speedFrac = Math.min(this.bikeSpeed / this.bikeMaxSpeed, 1.0);
    const velocityScale = 1.0 - speedFrac * 0.4; // 1.0 at rest → 0.6 at max speed
    lean *= velocityScale;

    // Asymmetric smoothing: less smoothing when initiating a turn (responsive),
    // more smoothing when returning to center (stable)
    const initiating = Math.abs(lean) > Math.abs(this._prevLeanRaw) && Math.abs(lean) > 0.05;
    const baseSmooth = initiating ? Math.min(outputSmoothing * 1.6, 0.9) : outputSmoothing * 0.7;
    this._prevLeanRaw = lean;

    // Frame-rate-independent EMA: normalize so smoothing converges at the
    // same wall-clock rate regardless of event frequency (60Hz vs 200Hz).
    // At 60Hz, dtSec * 60 ≈ 1.0, so smoothK ≈ baseSmooth (unchanged).
    // At 120Hz, dtSec * 60 ≈ 0.5, so smoothK is smaller per event but
    // the per-second convergence rate is identical.
    const smoothK = 1 - Math.pow(1 - baseSmooth, dtSec * 60);

    this._smoothedLean += (lean - this._smoothedLean) * smoothK;
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
      // Slot filter: if this instance is scoped to a specific gamepad index, ignore others.
      if (this._gamepadSlot !== null && e.gamepad.index !== this._gamepadSlot) return;
      // Sticky claim: once we've bound a real gamepad slot, don't switch.
      // Exception: -1 is a sentinel from bootstrapFromHID (WebHID-only
      // controller invisible to the Gamepad API). Upgrade it to a real
      // slot so local-MP P2 detection can tell P1's slot apart from P2's.
      if (this.gamepadIndex !== null && this.gamepadIndex !== -1) return;
      this.gamepadIndex = e.gamepad.index;
      this.gamepadConnected = true;
      this._gpName = e.gamepad.id;
      // GameSir Cyclone reports as "Gamepad" with Switch Pro vendor/product (057e:2009)
      // but has rotated face button mapping — swap A/B to fix confirm/back
      this._gpSwapAB = /^Gamepad/i.test(e.gamepad.id) && /057e/i.test(e.gamepad.id);
      console.log('Gamepad connected:', e.gamepad.id, this._gpSwapAB ? '(A/B swapped)' : '');
      const info = ControllerRegistry.identifyFromGamepadId(e.gamepad.id);
      analytics.setController(info ? info.driverName : e.gamepad.id, 'standard');
      if (!this.suppressGamepadBadge) {
        const badge = document.getElementById('gamepad-badge');
        if (badge) badge.style.display = 'block';
      }
      const pedalBar = document.getElementById('pedal-bar');
      if (pedalBar) pedalBar.classList.add('gamepad-active');
    });
    window.addEventListener('gamepaddisconnected', (e) => {
      if (this.gamepadIndex !== e.gamepad.index) return;

      // DualSense BT edge case: when the driver sends feature report 0x05,
      // the controller drops out of Chromium's Gamepad API. Chromium *may*
      // fire gamepaddisconnected for this transition even though the
      // physical device is fine. Two cases to cover:
      //
      // - _hidConnecting is set while connectControllerGyro() is in flight.
      //   This catches the race window where feature 0x05 has already been
      //   written but this.gyroDevice / this._controllerDriver haven't been
      //   assigned yet — without this, the sticky claim gets torn down
      //   before HID comes fully online and pollGamepad returns nothing.
      //
      // - Post-connect: gyroDevice is live. pollGamepad() will serve state
      //   from the synthetic gamepad. Real physical unplugs arrive via the
      //   navigator.hid 'disconnect' listener, which is the source of
      //   truth for this path.
      if (this._hidConnecting ||
          (this.gyroDevice && this.gyroDevice.opened && this._controllerDriver)) {
        console.log('Ignoring Gamepad API disconnect — HID is coming online or live');
        return;
      }

      this.gamepadIndex = null;
      this.gamepadConnected = false;
      this.gamepadLean = 0;
      this._gpName = '';
      this._gpRawStickX = 0;
      this._gpLB = false;
      this._gpRB = false;
      this._gpTriggerLeftVal = 0;
      this._gpTriggerRightVal = 0;
      this._gpTriggerLeftPressed = false;
      this._gpTriggerRightPressed = false;
      console.log('Gamepad disconnected');
      const badge = document.getElementById('gamepad-badge');
      if (badge) badge.style.display = 'none';
      const pedalBar = document.getElementById('pedal-bar');
      if (pedalBar) pedalBar.classList.remove('gamepad-active');
      // Tear down the WebHID gyro pipeline too — the controller that was
      // feeding it is gone, so its inputreport handler is dead. Without
      // this, gyroConnected stays true pointing at a stale device and
      // subsequent connect events can't re-claim gyro for a new pad.
      if (this.gyroConnected) {
        this.disconnectControllerGyro();
      }
    });
  }

  pollGamepad() {
    // Polling fallback: detect gamepads even without events
    if (this.gamepadIndex === null) {
      const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
      // Slot filter: if scoped to a specific index, only try that one; otherwise take the first non-null.
      const tryClaim = (i) => {
        if (!gamepads[i]) return false;
        this.gamepadIndex = i;
        this.gamepadConnected = true;
        this._gpName = gamepads[i].id;
        const pollInfo = ControllerRegistry.identifyFromGamepadId(gamepads[i].id);
        analytics.setController(pollInfo ? pollInfo.driverName : gamepads[i].id, 'standard');
        if (!this.suppressGamepadBadge) {
          const badge = document.getElementById('gamepad-badge');
          if (badge) badge.style.display = 'block';
        }
        const pedalBar = document.getElementById('pedal-bar');
        if (pedalBar) pedalBar.classList.add('gamepad-active');
        return true;
      };
      if (this._gamepadSlot !== null) {
        tryClaim(this._gamepadSlot);
      } else {
        for (let i = 0; i < gamepads.length; i++) {
          if (tryClaim(i)) break;
        }
      }
    }

    if (this.gamepadIndex === null) return;

    // Single source of truth for "what is the gamepad right now" — handles
    // real → synthetic fallback AND the BT-DualSense stale-slot case where
    // Chromium's Gamepad API mapper returns frozen axes/buttons after the
    // controller has switched to 0x31 full-report mode.
    const gp = this.getGamepadState();
    if (!gp) return;

    // Left stick X — deadzone 0.08
    const rawX = gp.axes[0] || 0;
    this._gpRawStickX = rawX;
    this.gamepadLean = this.suppressGamepadLean ? 0 : (Math.abs(rawX) < 0.08 ? 0 : rawX);

    // Pedal buttons: LB/RB (buttons[4]/[5]) or LT/RT (buttons[6]/[7])
    const THRESHOLD = 0.5;
    this._gpLB = !!(gp.buttons[4] && gp.buttons[4].pressed);
    this._gpRB = !!(gp.buttons[5] && gp.buttons[5].pressed);
    this._gpTriggerLeftVal = gp.buttons[6] ? gp.buttons[6].value : 0;
    this._gpTriggerRightVal = gp.buttons[7] ? gp.buttons[7].value : 0;
    this._gpTriggerLeftPressed = this._gpLB || this._gpTriggerLeftVal >= THRESHOLD;
    this._gpTriggerRightPressed = this._gpRB || this._gpTriggerRightVal >= THRESHOLD;
  }

  /**
   * Return the current gamepad state — real Gamepad API object when one
   * exists for our claimed slot, otherwise the HID-synthesized fallback
   * (populated from parsed DualSense reports when the Gamepad API is
   * blind to a controller in 0x31 full-report mode). Callers that used
   * to read `navigator.getGamepads()[inputManager.gamepadIndex]` directly
   * should call this instead so menu navigation, trigger polling, and
   * any other gamepad-backed UI keep working during BT-synthesized
   * sessions.
   *
   * DualSense over Bluetooth specifically: once `init()` sends feature
   * report 0x05 the controller streams 0x31 reports that Chromium's
   * Gamepad API mapper can't decode. On Chrome/Mac the slot comes back
   * null; on Electron 33 (Chromium 130) the slot continues to return a
   * *stale* Gamepad object with frozen axes/buttons from the moment the
   * mode switch occurred. The stale object would win a "real-or-null"
   * check and silently freeze menu nav, so we force-prefer the synthetic
   * gamepad whenever the HID driver is live AND connected over Bluetooth.
   * USB DualSense, Switch Pro, Xbox, and anything without a matching
   * driver keep using the Gamepad API exactly as before.
   *
   * @returns {Gamepad|null} null when no pad is claimed.
   */
  getGamepadState() {
    if (this.gamepadIndex === null) return null;
    if (this._controllerDriver &&
        this._syntheticGamepad &&
        this._gyroConnType === 'bluetooth') {
      return this._syntheticGamepad;
    }
    const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
    const gp = gamepads[this.gamepadIndex];
    if (gp) return gp;
    if (this._syntheticGamepad) return this._syntheticGamepad;
    return null;
  }

  getGamepadLean() {
    if (this.suppressGamepadLean) return 0;
    return this.gamepadConnected ? this.gamepadLean : 0;
  }

  isPressed(code) {
    // keyboardActive gates the raw key state so an InputManager instance can
    // "release" the keyboard to another instance (local MP: P1 on gamepad
    // stops reading keys when P2 is on keyboard).
    const keyDown = this.keyboardActive && !!this.keys[code];
    if (code === 'ArrowLeft') return keyDown || this.touchLeft || this._leftTapped || this._gpTriggerLeftPressed;
    if (code === 'ArrowRight') return keyDown || this.touchRight || this._rightTapped || this._gpTriggerRightPressed;
    return keyDown;
  }

  /** Clear buffered tap flags — call once per frame after all input reading. */
  consumeTaps() {
    this._leftTapped = false;
    this._rightTapped = false;
  }

  // ── WebHID gyro (PlayStation controllers) ──────────────────

  /**
   * Request WebHID access to a controller's gyro and wire up the report
   * handler. In local multiplayer two InputManager instances call this
   * independently (one per player) and MUST land on their own physical
   * device — pass a vendor/product filter to prevent cross-wiring.
   *
   * @param {{vendorId?: number, productId?: number}} [filter] — when
   *   provided, both findApprovedDevice and the requestDevice fallback
   *   are scoped to this specific physical controller. Without a filter
   *   the first approved gyro device wins, which in a two-controller
   *   session is non-deterministic.
   */
  async connectControllerGyro(filter = null, excludeDevices = []) {
    if (this.gyroConnected || !navigator.hid) return;
    // Concurrent-call guard: the lobby has two gamepadconnected listeners
    // (main + hot-swap) that both schedule _autoConnectGyro with different
    // delays. For drivers whose init() is slow (Switch Pro sub-commands
    // take 500ms+), the first call's .then hasn't yet flipped
    // motionActive=true when the second call fires, so both calls race
    // through the lobby-side guard. Without this flag they'd both proceed
    // into ControllerRegistry.connect — opening the same device twice,
    // attaching two inputreport listeners, running init() twice, and
    // resetting calibration after the first completed.
    //
    // The flag also serves a second purpose: it tells the
    // gamepaddisconnected handler to preserve the sticky claim while
    // init() is mid-flight, since BT DualSense's feature 0x05 write
    // synchronously flips the controller out of the Gamepad API before
    // gyroDevice / _controllerDriver get assigned.
    if (this._hidConnecting) return;
    this._hidConnecting = true;

    try {
      // If a filter is supplied, narrow the WebHID request to just that
      // physical device. Otherwise ask for all known gyro-capable drivers.
      const hidFilters = filter
        ? [{ vendorId: filter.vendorId, productId: filter.productId }]
        : ControllerRegistry.getHIDFilters();
      let device;

      // In Electron/Steam, try getDevices() first (no user gesture needed),
      // then fall back to requestDevice() which triggers the auto-select handler.
      const isDesktop = window.steam || navigator.userAgent.includes('Electron');
      if (isDesktop) {
        device = await ControllerRegistry.findApprovedDevice('gyro', filter, excludeDevices);
        if (!device) {
          const devices = await navigator.hid.requestDevice({ filters: hidFilters });
          device = devices && devices[0];
        }
      } else {
        const devices = await navigator.hid.requestDevice({ filters: hidFilters });
        device = devices && devices[0];
      }
      if (!device) return;

      // Use the registry to connect with the correct driver
      this._controllerDriver = await ControllerRegistry.connect(device);
      this.gyroDevice = device;
      this._gyroConnType = this._controllerDriver.connectionType;
    } finally {
      this._hidConnecting = false;
    }

    // From this point on, the rest of the setup happens synchronously — no
    // awaits — so we're out of the race window and it's safe for
    // subsequent concurrent calls to see gyroConnected=true below.
    if (!this._controllerDriver || !this.gyroDevice) return;
    analytics.setController(this._controllerDriver.constructor.driverName, this._controllerDriver.connectionType);

    this._gyroReportHandler = (e) => this._handleGyroReport(e);
    this.gyroDevice.addEventListener('inputreport', this._gyroReportHandler);

    // WebHID-level disconnect is our source of truth for physical unplug
    // when a DualSense is in 0x31 mode (invisible to the Gamepad API).
    if (!this._hidDisconnectListener) {
      this._hidDisconnectListener = (e) => {
        if (this.gyroDevice && e.device === this.gyroDevice) {
          console.log('HID device disconnected');
          this.disconnectControllerGyro();
          // Also clear gamepad-level state, since Gamepad API may not
          // have seen the drop.
          this.gamepadIndex = null;
          this.gamepadConnected = false;
          this.gamepadLean = 0;
          this._gpTriggerLeftPressed = false;
          this._gpTriggerRightPressed = false;
        }
      };
      if (navigator.hid && navigator.hid.addEventListener) {
        navigator.hid.addEventListener('disconnect', this._hidDisconnectListener);
      }
    }

    // Register this InputManager as a haptic target so js/haptics.js can
    // route rumble to our claimed gamepad (and, for DualSense, our driver's
    // WebHID rumble path as a fallback around Chromium's broken macOS
    // vibrationActuator). Use addHapticSource (not setHapticSources) so we
    // don't clobber another player's registration in local MP — the old
    // setHapticSources([this]) call replaced the whole array, dropping P1
    // when P2 connected and vice versa.
    addHapticSource(this);

    this.gyroConnected = true;
    this._startGyroCalibration();
  }

  /**
   * Cold-start probe: when the app launches and navigator.getGamepads() is
   * empty, a previously-paired DualSense may still be in 0x31 full-report
   * mode from a prior session, in which case it's invisible to the Gamepad
   * API and no 'gamepadconnected' event will ever fire. Call this at boot
   * (via the lobby) to walk navigator.hid.getDevices() for an already-
   * approved gyro-capable controller and bring it online via the normal
   * WebHID path. The synthetic-gamepad fallback in pollGamepad() then
   * serves sticks/buttons straight from the HID report stream.
   *
   * @returns {Promise<boolean>} true if a device was claimed via HID
   */
  async bootstrapFromHID() {
    if (!navigator.hid || this.gyroConnected) return false;
    // Only probe when the Gamepad API actually has nothing — if a pad is
    // already claimed, the normal event-driven path will handle gyro.
    if (this.gamepadIndex !== null) return false;
    // If scoped to a specific gamepad slot (local MP P2), the bootstrap
    // path has no way to bind to that slot deterministically — skip it.
    if (this._gamepadSlot !== null) return false;

    let devices;
    try {
      devices = await navigator.hid.getDevices();
    } catch (err) {
      console.log('bootstrapFromHID: getDevices failed:', err.message);
      return false;
    }
    for (const d of devices) {
      const drv = ControllerRegistry.getDriver(d.vendorId, d.productId);
      if (!drv || !drv.capabilities.gyro) continue;
      console.log('bootstrapFromHID: found', d.productName,
        'vid:' + d.vendorId.toString(16), 'pid:' + d.productId.toString(16));

      // Seed our sticky claim with a sentinel index so pollGamepad() is
      // willing to fall through to the synthetic gamepad while we wait
      // for the first HID inputreport.
      this.gamepadIndex = -1;
      this.gamepadConnected = true;
      this._gpName = d.productName || drv.driverName;
      this._syntheticGamepad = this._createSyntheticGamepad(d.productName);

      const badge = document.getElementById('gamepad-badge');
      if (badge && !this.suppressGamepadBadge) badge.style.display = 'block';
      const pedalBar = document.getElementById('pedal-bar');
      if (pedalBar) pedalBar.classList.add('gamepad-active');

      try {
        await this.connectControllerGyro({ vendorId: d.vendorId, productId: d.productId });
      } catch (err) {
        console.warn('bootstrapFromHID: connectControllerGyro failed:', err.message);
        // Roll back the sticky claim so the normal event-driven path can
        // still try later when the user wakes the controller.
        this.gamepadIndex = null;
        this.gamepadConnected = false;
        this._gpName = '';
        this._syntheticGamepad = null;
        if (badge) badge.style.display = 'none';
        if (pedalBar) pedalBar.classList.remove('gamepad-active');
        return false;
      }
      return true;
    }
    console.log('bootstrapFromHID: no granted gyro-capable device found');
    return false;
  }

  disconnectControllerGyro() {
    if (this.gyroDevice) {
      if (this._gyroReportHandler) {
        this.gyroDevice.removeEventListener('inputreport', this._gyroReportHandler);
        this._gyroReportHandler = null;
      }
      if (this._controllerDriver) {
        this._controllerDriver.destroy();
        this._controllerDriver = null;
      }
      this.gyroDevice.close().catch(() => {});
    }
    if (this._hidDisconnectListener && navigator.hid && navigator.hid.removeEventListener) {
      navigator.hid.removeEventListener('disconnect', this._hidDisconnectListener);
      this._hidDisconnectListener = null;
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
    this._syntheticGamepad = null;
    // Reset the stuck-IMU self-heal budget so the next controller gets
    // a fresh set of retries. Without this, two successive hot-swaps
    // that both need self-heal would exhaust the cap on the second one.
    this._imuZeroSince = 0;
    this._imuReinitAttempts = 0;
    this._imuReinitInFlight = false;
    // Clear sensor fusion state too so the next controller starts with
    // a clean quaternion/gravity vector instead of the last one's pose.
    this._resetSensorFusionState();
    removeHapticSource(this);
  }

  calibrateGyro() {
    this._startGyroCalibration();
  }

  recenterGyro() {
    // Recenter semantic: "whatever I'm holding right now = zero lean."
    // With sensor fusion, the cleanest way to achieve that is to capture
    // the current accel-derived roll, absorb it into motionOffset so the
    // tilt pipeline sees zero relative lean, and reset the orientation
    // quaternion to identity so sensor fusion re-converges from the
    // current pose.
    if (this._accelVerified && this._accelRoll != null) {
      this.motionOffset = -this._accelRoll;
    } else {
      // Accel not verified yet (e.g. WebHID-bootstrapped P2 between games).
      // Reset offset to 0 so the tilt pipeline starts clean — sensor fusion
      // will re-converge from identity within ~1 second.
      this.motionOffset = 0;
    }
    console.log('Gyro recentered: rollAccum=' + this._gyroRollAccum.toFixed(1) +
      ' accelRoll=' + (this._accelRoll != null ? this._accelRoll.toFixed(1) : 'null') +
      ' offset=' + (this.motionOffset != null ? this.motionOffset.toFixed(1) : 'null') +
      ' accelVerified=' + this._accelVerified +
      ' conn=' + (this._gyroConnType || 'unknown'));
    this._gyroRollAccum = 0;
    this._smoothedLean = 0;
    this.motionLean = 0;
    this._resetSensorFusionState();
    // Don't reset _smoothedLean/motionLean — they're shared with mobile
    // tilt. The EMA filter (gyroOutputSmoothing: 0.3) converges within
    // ~100ms.
  }

  /** Full lean-input reset for tutorial/demo restarts. */
  resetLeanState() {
    this._smoothedLean = 0;
    this._prevLeanRaw = 0;
    this.motionLean = 0;
    if (this.gyroConnected && this._accelVerified && this._accelRoll != null) {
      // Absorb current physical tilt into motionOffset so the tilt
      // pipeline sees relative = 0 immediately after the reset. The
      // orientation quaternion is also reset so sensor fusion
      // re-converges from identity in the next ~1 second.
      this.motionOffset = -this._accelRoll;
    }
    this._gyroRollAccum = 0;
    this._resetSensorFusionState();
    this._driftEma = null;
  }

  // Connection type detection delegated to controller driver

  _startGyroCalibration() {
    this._gyroCalibrating = true;
    this._gyroCalibSamples = [];
    this._gyroRollAccum = 0;
    this._lastGyroTime = 0;
    this.motionOffset = null;
    // Throw away any accumulated sensor fusion state so the post-
    // calibration orientation starts from identity.
    this._resetSensorFusionState();
  }

  /**
   * Stuck-IMU recovery path (#198). Re-run the current driver's init()
   * to re-send its enable-IMU sub-command, then restart the bias
   * calibration so the new (hopefully non-zero) samples aren't averaged
   * against the stale (0,0,0) readings from before the reset.
   */
  async _reinitDriverAndCalibrate() {
    if (!this._controllerDriver) {
      this._imuReinitInFlight = false;
      return;
    }
    try {
      await this._controllerDriver.init();
      this._startGyroCalibration();
    } catch (err) {
      console.warn('Driver re-init failed:', err.message);
    } finally {
      this._imuReinitInFlight = false;
    }
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
    // Re-reset sensor fusion state after bias is established so the
    // orientation starts clean from a known-good bias.
    this._resetSensorFusionState();
    console.log('Gyro bias:', this._gyroBias);
  }

  _createSyntheticGamepad(id) {
    return {
      id: id || 'HID Controller',
      index: this.gamepadIndex != null ? this.gamepadIndex : -1,
      axes: [0, 0, 0, 0],
      buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
      _synthetic: true,
    };
  }

  /**
   * Map parsed HID report fields into the Chrome Standard Gamepad layout
   * so pollGamepad() can read stick/button state uniformly. Only the
   * indices that the game actually consumes are wired — buttons 4/5 (LB/RB),
   * 6/7 (triggers), and axes[0] (steering). Other slots stay neutral.
   */
  _updateSyntheticFromParsed(parsed) {
    if (!this._syntheticGamepad) {
      this._syntheticGamepad = this._createSyntheticGamepad(
        this.gyroDevice && this.gyroDevice.productName
      );
    }
    const g = this._syntheticGamepad;

    if (parsed.sticks) {
      g.axes[0] = parsed.sticks.lx;
      g.axes[1] = parsed.sticks.ly;
      g.axes[2] = parsed.sticks.rx;
      g.axes[3] = parsed.sticks.ry;
    }

    if (parsed.buttons) {
      const b = parsed.buttons;
      const set = (i, pressed, value) => {
        const slot = g.buttons[i];
        slot.pressed = !!pressed;
        slot.value = value === undefined ? (pressed ? 1 : 0) : value;
      };
      set(0, b.cross);
      set(1, b.circle);
      set(2, b.square);
      set(3, b.triangle);
      set(4, b.l1);
      set(5, b.r1);
      const l2v = parsed.triggers?.l2 ?? 0;
      const r2v = parsed.triggers?.r2 ?? 0;
      set(6, b.l2 || l2v > 0.05, l2v);
      set(7, b.r2 || r2v > 0.05, r2v);
      set(8, b.create);
      set(9, b.options);
      set(10, b.l3);
      set(11, b.r3);
      set(12, b.dpadUp);
      set(13, b.dpadDown);
      set(14, b.dpadLeft);
      set(15, b.dpadRight);
      set(16, b.ps);
    }
  }

  _handleGyroReport(event) {
    if (!this._controllerDriver) return;

    const parsed = this._controllerDriver.parseReport(event.reportId, event.data);
    if (!parsed) return;

    // Feed sticks/buttons/triggers into the synthetic gamepad regardless
    // of whether gyro is usable — when BT DualSense is in 0x31 mode the
    // Gamepad API is blind and this is our only source for pedal input.
    if (parsed.sticks || parsed.buttons || parsed.triggers) {
      this._updateSyntheticFromParsed(parsed);
    }

    if (!parsed.gyro) return;

    const now = performance.now();
    const gyroScale = parsed.gyroScale;
    const rawGx = parsed.gyro.x;
    const rawGy = parsed.gyro.y;
    const rawGz = parsed.gyro.z;

    const rawAx = parsed.accel ? parsed.accel.x : 0;
    const rawAy = parsed.accel ? parsed.accel.y : 0;
    const rawAz = parsed.accel ? parsed.accel.z : 0;

    // Store raw values for diagnostics
    this._gyroRawZ = rawGz;
    this._accelRawX = rawAx;
    this._accelRawY = rawAy;
    this._accelRawZ = rawAz;

    // Calibration sampling
    if (this._gyroCalibrating) {
      this._gyroCalibSamples.push({ x: rawGx, y: rawGy, z: rawGz });
      if (this._gyroCalibSamples.length >= GYRO_CALIB_COUNT) this._finishGyroCalibration();
      this._lastGyroTime = now;
      return;
    }

    // Stuck-IMU self-heal: detect the BT Switch Pro hot-swap race (#198)
    // where macOS's Game Controller framework disables the IMU shortly
    // after our init() completes. Real IMU data is never all-zero across
    // six axes — noise alone produces small non-zero values — so all six
    // reading as exactly 0 for 500ms+ is unambiguously a stuck-IMU signal.
    // When we detect it, re-run driver.init() to re-send the enable-IMU
    // sub-command and restart calibration. Capped to avoid looping on a
    // genuinely broken controller.
    const imuIsZero = rawGx === 0 && rawGy === 0 && rawGz === 0 &&
                      rawAx === 0 && rawAy === 0 && rawAz === 0;
    if (imuIsZero) {
      if (this._imuZeroSince === 0) this._imuZeroSince = now;
      if (!this._imuReinitInFlight &&
          (now - this._imuZeroSince) >= IMU_ZERO_TIMEOUT_MS &&
          this._imuReinitAttempts < MAX_IMU_REINIT) {
        this._imuReinitAttempts++;
        this._imuZeroSince = 0;
        this._imuReinitInFlight = true;
        console.warn('IMU stuck at zero for ' + IMU_ZERO_TIMEOUT_MS +
          'ms — re-running driver init (' + this._imuReinitAttempts +
          '/' + MAX_IMU_REINIT + ')');
        this._reinitDriverAndCalibrate();
      }
    } else if (this._imuZeroSince !== 0) {
      this._imuZeroSince = 0;
    }

    // Apply bias correction
    const gx = rawGx - this._gyroBias.x;
    const gy = rawGy - this._gyroBias.y;
    const gz = rawGz - this._gyroBias.z;

    if (this._lastGyroTime > 0) {
      const dt = (now - this._lastGyroTime) / 1000.0;
      if (dt < 0.1) {
        // Raw gyro rates are in sensor-frame degrees per second (via the
        // per-driver parsed.gyroScale). Convert to radians and scale by
        // dt to get a per-frame angular displacement vector.
        const scale = parsed.gyroScale * (Math.PI / 180.0);
        const angX = gx * scale * dt;
        const angY = gy * scale * dt;
        const angZ = gz * scale * dt;
        const angle = Math.sqrt(angX * angX + angY * angY + angZ * angZ);

        // ── 1. Axis-angle quaternion integration ──
        // Proper axis-angle construction, eliminating gimbal coupling
        // from the old Euler-based integration.
        if (angle > 1e-10) {
          const ha = angle * 0.5;
          const s = Math.sin(ha) / angle;
          this._tmpQuat.set(angX * s, angY * s, angZ * s, Math.cos(ha));
          this._gyroOrientation.multiply(this._tmpQuat);
        }

        // ── 2. Gravity tracking + accelerometer correction ──
        if (parsed.accel) {
          const accelScale = parsed.accelScale || (1.0 / 8192.0);
          const ax = rawAx * accelScale;
          const ay = rawAy * accelScale;
          const az = rawAz * accelScale;
          this._tmpVec.set(ax, ay, az);
          const accelVec = this._tmpVec;  // alias (don't mutate below — use _tmpVec2/3 for scratch)
          const accelLen = accelVec.length();

          // Verify accel magnitude is reasonable (gravity ~1g, allowing for
          // controller-specific scale). Same check as the pre-sensor-fusion
          // implementation — we still log this once for diagnostics.
          if (!this._accelVerified) {
            const mag = Math.sqrt(rawAx * rawAx + rawAy * rawAy + rawAz * rawAz);
            const expectedG = parsed.accelScale ? (1.0 / parsed.accelScale) : 8192;
            const magLow = expectedG * 0.4;
            const magHigh = expectedG * 2.0;
            if (mag > magLow && mag < magHigh) {
              this._accelVerified = true;
              console.log('Accel verified, magnitude:', mag.toFixed(0),
                'expected ~' + expectedG.toFixed(0));
            }
          }

          // Rotate gravity vector by the inverse of this frame's gyro
          // rotation — keeps it pointing at world-down in the rotating
          // sensor-local frame.
          if (angle > 1e-10) {
            const ha2 = angle * 0.5;
            const s2 = Math.sin(ha2) / angle;
            this._tmpQuat.set(-angX * s2, -angY * s2, -angZ * s2, Math.cos(ha2));
            this._gravityVec.applyQuaternion(this._tmpQuat);
          }

          // Shakiness tracking — exponential-moving-average of accel,
          // peak-detected difference gives "how much the controller is
          // bouncing around right now."
          const smoothFactor = Math.pow(2, -dt / STEADINESS_HALF_TIME);
          this._smoothAccel.lerp(accelVec, 1 - smoothFactor);
          const accelDiff = this._tmpVec2.copy(accelVec).sub(this._smoothAccel).length();
          this._shakiness = Math.max(this._shakiness * smoothFactor, accelDiff);

          // Adaptive correction speed: fast when still, slow when shaking.
          const shakyT = Math.max(0, Math.min(1,
            (this._shakiness - SHAKINESS_MIN_THRESHOLD) /
            (SHAKINESS_MAX_THRESHOLD - SHAKINESS_MIN_THRESHOLD)));
          let correctionSpeed = (1 - shakyT) * GRAVITY_STILL_SPEED + shakyT * GRAVITY_SHAKY_SPEED;

          // Gyro rate limiting: taper correction toward a gyro-proportional
          // ceiling so gravity corrections stay visually imperceptible
          // relative to how fast the controller is turning. Small gap →
          // fully clamp. Large gap → skip the clamp. See the overlay
          // implementation in PR #186 for the math bug history.
          const angularSpeed = angle / dt;
          let gravGapLen = 0;
          if (accelLen > 0.001) {
            const gravLen = this._gravityVec.length();
            gravGapLen = this._tmpVec2.copy(accelVec)
              .multiplyScalar(-gravLen / accelLen)
              .sub(this._gravityVec)
              .length();
          }
          const gyroLimit = Math.max(angularSpeed * GRAVITY_GYRO_FACTOR, GRAVITY_MIN_SPEED);
          if (correctionSpeed > gyroLimit) {
            const closeEnoughT = Math.max(0, Math.min(1,
              (gravGapLen - GRAVITY_GYRO_MIN_THRESHOLD) /
              (GRAVITY_GYRO_MAX_THRESHOLD - GRAVITY_GYRO_MIN_THRESHOLD)));
            correctionSpeed = gyroLimit + (correctionSpeed - gyroLimit) * closeEnoughT;
          }

          // Correct gravity toward the accelerometer reading, but only
          // when the accel magnitude is near 1g (not free-fall or impact).
          if (accelLen > 0.4 && accelLen < 1.6) {
            const gravLen = this._gravityVec.length();
            this._tmpVec2.copy(accelVec).multiplyScalar(-gravLen / accelLen);
            const corrAmount = Math.min(correctionSpeed * dt, 1.0);
            this._gravityVec.lerp(this._tmpVec2, corrAmount);
          }

          // ── 3. Apply tilt correction to orientation quaternion ──
          // Transform gravityVec (sensor-local) into the world frame by
          // applying gyroOrientation directly. NOT its inverse — see
          // PR #186's follow-up fix. Compare with worldDown = (0,-1,0)
          // and nudge the orientation to close any gap.
          const gravWorld = this._tmpVec2.copy(this._gravityVec)
            .applyQuaternion(this._gyroOrientation)
            .normalize();
          const worldDown = this._tmpVec3.set(0, -1, 0);
          const errorAngle = Math.acos(Math.max(-1, Math.min(1, worldDown.dot(gravWorld))));
          if (errorAngle > 1e-6) {
            // corrAxis is in world space (cross of two world-space vectors)
            // so we premultiply (world-frame rotation applied before the
            // existing orientation).
            const corrAxis = this._tmpVec.crossVectors(gravWorld, worldDown).normalize();
            const cha = errorAngle * 0.5;
            const cs = Math.sin(cha);
            this._tmpQuat.set(corrAxis.x * cs, corrAxis.y * cs, corrAxis.z * cs, Math.cos(cha));
            this._gyroOrientation.premultiply(this._tmpQuat);
          }
        }

        this._gyroOrientation.normalize();

        // ── 4. Continuous stillness calibration ──
        // Refines gyroBias in the background when the controller is
        // still for 2+ seconds. Doesn't run during the initial one-shot
        // calibration (that still happens for the first GYRO_CALIB_COUNT
        // samples up-front).
        this._updateStillnessCalibration(rawGx, rawGy, rawGz, parsed.accel, parsed.accelScale, dt, now);

        // ── 5. Sensor-fusion calibration (Phase C #3) ──
        // Refines gyroBias during ACTIVE motion by cross-checking gyro
        // rates against accel-derived angular velocity. Complements the
        // stillness path above — stillness requires accel to be stable,
        // sensor fusion requires accel to be changing, so they're
        // mutually exclusive per frame and both can safely target
        // _gyroBias. Pass parsed.gyroScale so the calibration can
        // convert raw gyro values into deg/sec — the accel-derived
        // angular velocity inside is in deg/sec and the two sides must
        // match before the subtraction that yields the bias estimate.
        this._updateSensorFusionCalibration(rawGx, rawGy, rawGz, parsed.gyroScale, parsed.accel, dt);
      }
    }
    this._lastGyroTime = now;

    // ── Output: derive a scalar lean angle from the orientation ──
    // Sign convention matches the pre-fusion implementation so game.js
    // diagnostic reads (`-input._gyroRollAccum`) and `_applyTilt`
    // continue to point the bike in the correct direction.
    //
    // Pre-fusion: `_gyroRollAccum -= gz * scale * dt`, then
    // `_applyTilt(-_gyroRollAccum)` — the double negation combined with
    // the driver-internal coordinate remap meant positive physical
    // right-roll ended up passing a NEGATIVE value to _applyTilt.
    //
    // Post-fusion: extract Euler Z from the orientation quaternion,
    // negate to match the old effective sign. The old convention was
    // empirically verified on real hardware across the board; matching
    // it keeps the bike leaning in the direction the user tilts.
    this._tmpEuler.setFromQuaternion(this._gyroOrientation, 'XYZ');
    const leanDeg = -this._tmpEuler.z * (180 / Math.PI);
    const clampedLean = Math.max(-90, Math.min(90, leanDeg));
    this._gyroRollAccum = -clampedLean;
    // Expose the current roll as _accelRoll so recenterGyro / resetLeanState
    // can absorb it into motionOffset. (Name is legacy — the old code
    // computed it via atan2(accelX, accelY); now it's the sensor-fusion-
    // derived roll, which is more accurate but semantically equivalent.)
    this._accelRoll = clampedLean;

    // Feed into the tilt pipeline
    if (!this.motionEnabled) return;
    this._applyTilt(clampedLean, true);
  }

  /**
   * Continuous stillness calibration (ported from the controller-overlay).
   * Maintains a sliding window of recent samples; when gyro/accel variance
   * stays below adaptive minimum thresholds for STILLNESS_CORRECTION_TIME
   * seconds, gradually refines _gyroBias toward the window mean with an
   * exponential lerp that eases in over STILLNESS_CAL_EASE_IN seconds.
   *
   * Doesn't replace the initial one-shot calibration — that still runs
   * at connect time to quickly establish a reasonable bias. This runs
   * on top of it to keep the bias fresh as temperature drift accumulates.
   */
  _updateStillnessCalibration(gx, gy, gz, accel, accelScale, dt, now) {
    // Don't run during the initial one-shot calibration — that's still
    // averaging its own samples and setting _gyroBias at the end.
    if (this._gyroCalibrating) return;

    const sw = this._stillnessWindow;
    const s = accelScale || (1.0 / 8192.0);
    const ax = accel ? accel.x * s : 0;
    const ay = accel ? accel.y * s : 0;
    const az = accel ? accel.z * s : 0;

    sw.samples.push({ gx, gy, gz, ax, ay, az, t: now });

    // Trim samples older than the window
    const windowStart = now - STILLNESS_WINDOW_TIME * 1000;
    while (sw.samples.length > 0 && sw.samples[0].t < windowStart) sw.samples.shift();
    if (sw.samples.length < 10) { sw.stillSince = 0; return; }

    // Compute min/max delta across the window
    let gxMin = Infinity, gxMax = -Infinity, gyMin = Infinity, gyMax = -Infinity, gzMin = Infinity, gzMax = -Infinity;
    let axMin = Infinity, axMax = -Infinity, ayMin = Infinity, ayMax = -Infinity, azMin = Infinity, azMax = -Infinity;
    let sgx = 0, sgy = 0, sgz = 0;
    for (const sample of sw.samples) {
      gxMin = Math.min(gxMin, sample.gx); gxMax = Math.max(gxMax, sample.gx);
      gyMin = Math.min(gyMin, sample.gy); gyMax = Math.max(gyMax, sample.gy);
      gzMin = Math.min(gzMin, sample.gz); gzMax = Math.max(gzMax, sample.gz);
      axMin = Math.min(axMin, sample.ax); axMax = Math.max(axMax, sample.ax);
      ayMin = Math.min(ayMin, sample.ay); ayMax = Math.max(ayMax, sample.ay);
      azMin = Math.min(azMin, sample.az); azMax = Math.max(azMax, sample.az);
      sgx += sample.gx; sgy += sample.gy; sgz += sample.gz;
    }
    const dGyro = Math.max(gxMax - gxMin, gyMax - gyMin, gzMax - gzMin);
    const dAccel = Math.max(axMax - axMin, ayMax - ayMin, azMax - azMin);

    // Adaptive thresholds — deteriorate over time so we don't get stuck
    // with unreachable strictness after a long stationary period.
    sw.minDeltaGyro = Math.min(sw.minDeltaGyro, dGyro);
    sw.minDeltaAccel = Math.min(sw.minDeltaAccel, dAccel);
    sw.minDeltaGyro += STILLNESS_DETERIORATION * dt;
    sw.minDeltaAccel += STILLNESS_DETERIORATION * 0.01 * dt;

    const isStill = dGyro < sw.minDeltaGyro * 2.0 && dAccel < sw.minDeltaAccel * 2.0;

    if (isStill) {
      if (sw.stillSince === 0) sw.stillSince = now;
      const stillDuration = (now - sw.stillSince) / 1000;

      if (stillDuration >= STILLNESS_CORRECTION_TIME) {
        // Ease in over time, then exponentially lerp toward the window mean.
        sw.easeIn = Math.min(sw.easeIn + dt / STILLNESS_CAL_EASE_IN, 1.0);
        const lerpFactor = Math.pow(2, -sw.easeIn * dt / STILLNESS_CAL_HALF_TIME);

        const meanGx = sgx / sw.samples.length;
        const meanGy = sgy / sw.samples.length;
        const meanGz = sgz / sw.samples.length;

        this._gyroBias.x = this._gyroBias.x * lerpFactor + meanGx * (1 - lerpFactor);
        this._gyroBias.y = this._gyroBias.y * lerpFactor + meanGy * (1 - lerpFactor);
        this._gyroBias.z = this._gyroBias.z * lerpFactor + meanGz * (1 - lerpFactor);
      }
    } else {
      sw.stillSince = 0;
      sw.easeIn = 0;
    }
  }

  /**
   * Reset all sensor fusion state to its initial values. Called on
   * disconnect, on calibration start/finish, and by recenterGyro —
   * anywhere we want to throw away the accumulated orientation and
   * let the fusion re-converge from scratch.
   */
  _resetSensorFusionState() {
    this._gyroOrientation.identity();
    this._gravityVec.set(0, -1, 0);
    this._smoothAccel.set(0, -1, 0);
    this._shakiness = 0;
    this._stillnessWindow.samples.length = 0;
    this._stillnessWindow.stillSince = 0;
    this._stillnessWindow.minDeltaGyro = 1.0;
    this._stillnessWindow.minDeltaAccel = 0.25;
    this._stillnessWindow.easeIn = 0;
    this._sfSmoothedGyro.set(0, 0, 0);
    this._sfSmoothedPreviousAccel.set(0, 0, 0);
    this._sfPreviousAccel.set(0, 0, 0);
    this._sfTimeSteady = 0;
    this._sfSkippedTime = 0;
  }

  /**
   * Sensor-fusion calibration path (Phase C #3). Ported from
   * GamepadMotion.hpp AutoCalibration::AddSampleSensorFusion.
   *
   * Complements _updateStillnessCalibration by refining _gyroBias
   * during ACTIVE MOTION instead of only during stillness. The
   * algorithm cross-checks gyro rates against angular velocity
   * derived from accelerometer direction changes: if the controller
   * is rotating, the accel direction should change in a way that's
   * consistent with the gyro reading minus the bias. Subtract the
   * accel-derived rotation from the smoothed gyro and you have a
   * running estimate of bias — lerp toward that estimate.
   *
   * Gating:
   *   - Rejects all-zero sensor input (stuck IMU, uninit state)
   *   - Rejects when the accel hasn't changed frame-to-frame (no
   *     rotation to cross-check against — skips and accumulates dt)
   *   - Rejects when gyro angular acceleration exceeds 20 deg/s²
   *     (controller is being shaken too erratically to trust)
   *
   * Axis-selective update:
   *   - Gravity can't measure rotation AROUND the gravity axis
   *   - When abs(accelNormal.axis) > 0.7 (axis is aligned with
   *     gravity), that axis's bias update is skipped
   *   - Other axes get partial update proportional to how orthogonal
   *     they are to gravity
   *
   * Runs in parallel with _updateStillnessCalibration — they have
   * mutually-exclusive gating (stillness requires accel stable,
   * sensor fusion requires accel changing), so both contributing
   * to _gyroBias is safe.
   *
   * @param {number} rawGx raw gyro X from parseReport
   * @param {number} rawGy raw gyro Y
   * @param {number} rawGz raw gyro Z
   * @param {number} gyroScale deg/sec per raw unit (from parsed.gyroScale)
   * @param {object|null} accel parsed.accel ({x, y, z}) or null
   * @param {number} dt seconds since last gyro report
   */
  _updateSensorFusionCalibration(rawGx, rawGy, rawGz, gyroScale, accel, dt) {
    if (dt <= 0 || this._gyroCalibrating || !accel || !gyroScale) return;

    // Accel scale cancels out in normalize() — we can use raw values
    // directly. The cross-product angle computation is unit-independent.
    const inAx = accel.x;
    const inAy = accel.y;
    const inAz = accel.z;

    // Convert gyro to deg/sec. The reference (GamepadMotion.hpp) works
    // in deg/sec throughout, and the accel-derived angular velocity
    // computed below is also in deg/sec — both sides of the bias
    // subtraction must be in the SAME units or the newBias estimate
    // is meaningless and slowly pulls _gyroBias toward garbage.
    //
    // A previous version of this method smoothed raw gyro values and
    // compared them against deg/sec, which (on DualSense) produced a
    // ~16.4× unit-scale mismatch and made _gyroBias drift toward
    // artificially small values. The symptom was "gyro feels more
    // sensitive after Phase C lands" because `rawGx - _gyroBias.x`
    // grew larger than it should.
    const inGxDps = rawGx * gyroScale;
    const inGyDps = rawGy * gyroScale;
    const inGzDps = rawGz * gyroScale;

    // Zero-input rejection
    if (rawGx === 0 && rawGy === 0 && rawGz === 0 &&
        inAx === 0 && inAy === 0 && inAz === 0) {
      this._sfTimeSteady = 0;
      this._sfSkippedTime = 0;
      this._sfPreviousAccel.set(0, 0, 0);
      this._sfSmoothedPreviousAccel.set(0, 0, 0);
      this._sfSmoothedGyro.set(0, 0, 0);
      return;
    }

    // Initial state: no previous accel captured yet
    if (this._sfPreviousAccel.x === 0 && this._sfPreviousAccel.y === 0 && this._sfPreviousAccel.z === 0) {
      this._sfTimeSteady = 0;
      this._sfSkippedTime = 0;
      this._sfPreviousAccel.set(inAx, inAy, inAz);
      this._sfSmoothedPreviousAccel.set(inAx, inAy, inAz);
      this._sfSmoothedGyro.set(0, 0, 0);
      return;
    }

    // Controller state hasn't updated (some firmware batches reports) —
    // accumulate the skipped time so the next non-duplicate frame gets
    // the full dt. Without this, rapid duplicate reports would produce
    // false "no rotation" readings and wreck the bias estimate.
    if (inAx === this._sfPreviousAccel.x &&
        inAy === this._sfPreviousAccel.y &&
        inAz === this._sfPreviousAccel.z) {
      this._sfSkippedTime += dt;
      return;
    }

    // Absorb any accumulated skipped time
    const effDt = dt + this._sfSkippedTime;
    this._sfSkippedTime = 0;

    // Framerate-independent exponential smoothing factor
    const smoothingLerp = Math.pow(2, -SENSOR_FUSION_SMOOTHING_STRENGTH * effDt);

    // Smooth gyro (in deg/sec) — capture previous value for angular
    // acceleration calc. _sfSmoothedGyro stores deg/sec throughout.
    const prevSmGx = this._sfSmoothedGyro.x;
    const prevSmGy = this._sfSmoothedGyro.y;
    const prevSmGz = this._sfSmoothedGyro.z;
    // Reference: Smoothed = inGyro.Lerp(Smoothed, factor)
    //          = inGyro * (1-factor) + Smoothed * factor
    this._sfSmoothedGyro.set(
      inGxDps * (1 - smoothingLerp) + prevSmGx * smoothingLerp,
      inGyDps * (1 - smoothingLerp) + prevSmGy * smoothingLerp,
      inGzDps * (1 - smoothingLerp) + prevSmGz * smoothingLerp,
    );

    // Angular acceleration magnitude of the smoothed gyro
    const dGx = this._sfSmoothedGyro.x - prevSmGx;
    const dGy = this._sfSmoothedGyro.y - prevSmGy;
    const dGz = this._sfSmoothedGyro.z - prevSmGz;
    const gyroAccelMag = Math.sqrt(dGx * dGx + dGy * dGy + dGz * dGz) / effDt;

    // Previous accel normal (from the smoothed state we captured last frame)
    const prevNormal = this._tmpVec.copy(this._sfSmoothedPreviousAccel).normalize();

    // Smooth this frame's accel
    const smoothAx = inAx * (1 - smoothingLerp) + this._sfSmoothedPreviousAccel.x * smoothingLerp;
    const smoothAy = inAy * (1 - smoothingLerp) + this._sfSmoothedPreviousAccel.y * smoothingLerp;
    const smoothAz = inAz * (1 - smoothingLerp) + this._sfSmoothedPreviousAccel.z * smoothingLerp;
    const thisNormal = this._tmpVec2.set(smoothAx, smoothAy, smoothAz).normalize();

    // Angular velocity from accel direction change: cross(thisNormal, prevNormal)
    // scaled by the angle between them divided by effDt
    const angVel = this._tmpVec3.crossVectors(thisNormal, prevNormal);
    const crossLen = angVel.length();
    if (crossLen > 0) {
      const dot = Math.max(-1, Math.min(1, thisNormal.dot(prevNormal)));
      const angleChangeDeg = Math.acos(dot) * (180 / Math.PI);
      const anglePerSec = angleChangeDeg / effDt;
      angVel.multiplyScalar(anglePerSec / crossLen);
    }
    // angVel now holds the accel-derived angular velocity (in deg/s, matching
    // the smoothed gyro units since parsed.gyro came through in raw units
    // scaled by parsed.gyroScale in deg/s/raw — both sides are in deg/s).

    // Angular acceleration gate: if the controller is being shaken too
    // hard, the smoothed gyro estimate is unreliable — reset steady time
    // and skip calibration this frame.
    if (gyroAccelMag > SENSOR_FUSION_ANGULAR_ACCEL_THRESHOLD) {
      this._sfTimeSteady = 0;
    } else {
      // Accumulate steady time up to the ease-in cap
      this._sfTimeSteady = Math.min(
        this._sfTimeSteady + effDt,
        SENSOR_FUSION_EASE_IN_TIME,
      );
      const easeIn = SENSOR_FUSION_EASE_IN_TIME <= 0
        ? 1
        : this._sfTimeSteady / SENSOR_FUSION_EASE_IN_TIME;
      const lerpFactor = SENSOR_FUSION_HALF_TIME <= 0
        ? 0
        : Math.pow(2, -easeIn * effDt / SENSOR_FUSION_HALF_TIME);

      // Candidate new bias = smoothedGyro - accel-derived angular velocity
      // If gyro reports `rate` and real rotation is `accelDerived`, the
      // difference is the gyro bias (what the gyro sees when it shouldn't
      // see anything). Lerp toward this candidate with the ease-in-scaled
      // half-time.
      //
      // Everything in this block is in DEG/SEC. The stored _gyroBias is
      // in RAW sensor units, so we convert it into deg/sec for the math
      // and back to raw units on the way out.
      const oldBiasXDps = this._gyroBias.x * gyroScale;
      const oldBiasYDps = this._gyroBias.y * gyroScale;
      const oldBiasZDps = this._gyroBias.z * gyroScale;
      let newBiasX = (this._sfSmoothedGyro.x - angVel.x) * (1 - lerpFactor) + oldBiasXDps * lerpFactor;
      let newBiasY = (this._sfSmoothedGyro.y - angVel.y) * (1 - lerpFactor) + oldBiasYDps * lerpFactor;
      let newBiasZ = (this._sfSmoothedGyro.z - angVel.z) * (1 - lerpFactor) + oldBiasZDps * lerpFactor;

      // Axis-selective update: accel can't measure rotation around the
      // gravity axis, so axes strongly aligned with gravity don't get
      // their bias updated from this sample. The reference clamps any
      // |normal.axis| > 0.7 to 1.0, which is the lerp strength toward
      // oldBias — so those axes end up keeping the old bias.
      let strengthX = Math.abs(thisNormal.x);
      let strengthY = Math.abs(thisNormal.y);
      let strengthZ = Math.abs(thisNormal.z);
      if (strengthX > 0.7) strengthX = 1.0;
      if (strengthY > 0.7) strengthY = 1.0;
      if (strengthZ > 0.7) strengthZ = 1.0;
      // Clamp to [0, 1]
      strengthX = Math.min(strengthX, 1.0);
      strengthY = Math.min(strengthY, 1.0);
      strengthZ = Math.min(strengthZ, 1.0);

      // lerp(newBias, oldBias, strength) = newBias*(1-strength) + oldBias*strength
      newBiasX = newBiasX * (1 - strengthX) + oldBiasXDps * strengthX;
      newBiasY = newBiasY * (1 - strengthY) + oldBiasYDps * strengthY;
      newBiasZ = newBiasZ * (1 - strengthZ) + oldBiasZDps * strengthZ;

      // Convert back to raw units for storage — the rest of the pipeline
      // subtracts `this._gyroBias.x` from raw gyro values.
      this._gyroBias.x = newBiasX / gyroScale;
      this._gyroBias.y = newBiasY / gyroScale;
      this._gyroBias.z = newBiasZ / gyroScale;
    }

    // Store for next frame
    this._sfSmoothedPreviousAccel.set(smoothAx, smoothAy, smoothAz);
    this._sfPreviousAccel.set(inAx, inAy, inAz);
  }

  getMotionLean() {
    return this.motionEnabled ? this.motionLean : 0;
  }
}
