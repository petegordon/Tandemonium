// ============================================================
// INPUT MANAGER — keyboard + touch + device motion + gamepad
// ============================================================

import { isMobile, TUNE } from './config.js';
import { ControllerRegistry } from './controllers/controller-registry.js';
import * as analytics from './analytics.js';
import { setHapticSources } from './haptics.js';

const GYRO_CALIB_COUNT = 150;         // ~1.5s at 100Hz

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
    this._gyroRollAccum = 0;         // cumulative roll angle in degrees
    this._lastGyroTime = 0;
    this._gyroReportHandler = null;
    this._accelVerified = false;     // accel byte offsets validated

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
      // Sticky claim: once we've bound a gamepad, don't silently switch to a newly-connected one.
      if (this.gamepadIndex !== null) return;
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
  async connectControllerGyro(filter = null) {
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
        device = await ControllerRegistry.findApprovedDevice('gyro', filter);
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
    // vibrationActuator).
    setHapticSources([this]);

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
    setHapticSources(null);
  }

  calibrateGyro() {
    this._startGyroCalibration();
  }

  recenterGyro() {
    // Set accumulator to current physical tilt so drift correction is aligned,
    // and update motionOffset so the tilt pipeline sees zero lean.
    if (this._accelVerified && this._accelRoll != null) {
      this._gyroRollAccum = this._accelRoll;
      this.motionOffset = -this._accelRoll;
    } else {
      this._gyroRollAccum = 0;
    }
    // Don't reset _smoothedLean/motionLean — they're shared with mobile tilt.
    // The EMA filter (gyroOutputSmoothing: 0.3) converges within ~100ms.
  }

  /** Full lean-input reset for tutorial/demo restarts. */
  resetLeanState() {
    this._smoothedLean = 0;
    this._prevLeanRaw = 0;
    this.motionLean = 0;
    if (this.gyroConnected && this._accelVerified && this._accelRoll != null) {
      // Set accumulator to current physical tilt so drift correction
      // won't fight the reset. Then set motionOffset so the tilt pipeline
      // sees relative = 0 (i.e. -_gyroRollAccum - motionOffset = 0).
      this._gyroRollAccum = this._accelRoll;
      this.motionOffset = -this._accelRoll;
    } else {
      this._gyroRollAccum = 0;
    }
    this._driftEma = null;
  }

  // Connection type detection delegated to controller driver

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

    // Apply bias correction
    const gz = rawGz - this._gyroBias.z;

    // Integrate Z axis for steering (negated to match tilt direction)
    if (this._lastGyroTime > 0) {
      const dt = (now - this._lastGyroTime) / 1000.0;
      if (dt < 0.1) {
        this._gyroRollAccum -= gz * gyroScale * dt;

        // Accelerometer-assisted drift correction
        if (parsed.accel) {
          if (!this._accelVerified) {
            const mag = Math.sqrt(rawAx * rawAx + rawAy * rawAy + rawAz * rawAz);
            // Expected gravity magnitude varies by controller:
            // DualSense ±2g: ~8192, Switch Pro ±8g: ~4096
            const expectedG = parsed.accelScale ? (1.0 / parsed.accelScale) : 8192;
            const magLow = expectedG * 0.4;
            const magHigh = expectedG * 2.0;
            if (mag > magLow && mag < magHigh) {
              this._accelVerified = true;
              console.log('Accel verified, magnitude:', mag.toFixed(0), 'expected ~' + expectedG.toFixed(0));
            } else {
              this._gyroRollAccum *= (1 - 0.5 * dt);
            }
          }
          if (this._accelVerified) {
            const accelRoll = Math.atan2(rawAx, rawAy) * (180 / Math.PI);
            this._accelRoll = accelRoll;
            const correction = (accelRoll - this._gyroRollAccum) * TUNE.gyroAccelCorrection;
            this._gyroRollAccum += correction;
          }
        } else {
          // No accel data — use blanket decay for drift correction
          this._gyroRollAccum *= (1 - 0.5 * dt);
        }
      }
    }
    this._lastGyroTime = now;

    // Clamp to sane range
    this._gyroRollAccum = Math.max(-90, Math.min(90, this._gyroRollAccum));

    // Feed into tilt pipeline with gyro-specific tuning
    if (!this.motionEnabled) return;
    this._applyTilt(-this._gyroRollAccum, true);
  }

  getMotionLean() {
    return this.motionEnabled ? this.motionLean : 0;
  }
}
