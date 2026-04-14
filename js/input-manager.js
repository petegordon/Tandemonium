// ============================================================
// INPUT MANAGER — keyboard + touch + device motion + gamepad
// ============================================================

import * as THREE from 'three';
import { isMobile, TUNE } from './config.js';
import * as analytics from './analytics.js';
import { addHapticSource, removeHapticSource } from './haptics.js';
import { ControllerRegistry } from '../shared/controllers/controller-registry.js';

// Controller state (gamepad binding, WebHID, sensor fusion, synthetic
// gamepad for BT-silent DualSense) now lives on a ControllerManager slot.
// See shared/controller-manager.js. InputManager is a thin consumer that
// reads the slot's effective gamepad + fusion orientation each frame and
// turns them into tilt/lean/trigger state for the game loop.

export class InputManager {
  /**
   * @param {Object} [options]
   * @param {import('../shared/controller-manager.js').Slot|null} [options.slot=null]
   *   — ControllerManager slot this InputManager consumes for gamepad +
   *   gyro state. Null means no controller bound yet; the InputManager
   *   still serves keyboard/touch/motion. Call `attachSlot(slot)` later
   *   to bind after construction.
   * @param {boolean} [options.enableKeyboard=true]
   * @param {boolean} [options.enableTouch=true]
   * @param {boolean} [options.enableMotion=true]
   */
  constructor(options = {}) {
    const {
      slot = null,
      enableKeyboard = true,
      enableTouch = true,
      enableMotion = true,
    } = options;
    this._slot = slot;
    this._slotUnsubscribe = null;
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

    // Derived gamepad state (updated by pollGamepad each frame from slot)
    this.gamepadLean = 0;
    this._gpTriggerLeftVal = 0;
    this._gpTriggerRightVal = 0;
    this._gpTriggerLeftPressed = false;
    this._gpTriggerRightPressed = false;
    this.suppressGamepadBadge = false;
    this.suppressGamepadLean = false;

    // Quirk flag: Cyclone A/B swap. Set by attachSlot() / _onSlotChange.
    this._gpSwapAB = false;

    // Scratch for extracting lean from slot.fusion.orientation each frame.
    this._tmpEuler = new THREE.Euler();

    // Diagnostic properties (read by test/input.html + in-game HUD)
    this._gpRawStickX = 0;
    this._gpLB = false;
    this._gpRB = false;
    this._gyroRollAccum = 0;
    this._accelRoll = 0;
    this._lastApplyGyroTime = 0;

    // Track last-seen connection state for the 'connected'/'disconnected'
    // DOM badge updates and haptic source registration.
    this._lastGamepadConnected = false;
    this._lastHidBound = false;

    if (enableKeyboard) this._setupKeyboard();
    if (isMobile) {
      if (enableTouch) this._setupTouch();
      if (enableMotion) this._setupMotion();
      if (enableTouch || enableMotion) this._setupCalibration();
    }

    if (this._slot) this.attachSlot(this._slot);
  }

  // ── Slot accessors ──
  // Legacy callers read these as fields. They now delegate to the slot so
  // a single source of truth (the ControllerManager) owns the lifecycle.
  // Setters are no-ops so transitional lobby.js code paths that still
  // write to them (manual sticky-claim patterns slated for removal in the
  // Step 5b follow-up) don't throw. Safe to remove once lobby migrates.
  get gamepadConnected() { return this._slot?.state === 'claimed'; }
  set gamepadConnected(_) { /* noop — owned by slot */ }
  get gamepadIndex() { return this._slot?.gamepadIndex ?? null; }
  set gamepadIndex(_) { /* noop */ }
  get gyroConnected() { return !!(this._slot?.fusion); }
  set gyroConnected(_) { /* noop */ }
  get gyroDevice() { return this._slot?.hidDevice ?? null; }
  set gyroDevice(_) { /* noop */ }
  get _gpName() { return this._slot?.controllerLabel ?? ''; }
  set _gpName(_) { /* noop */ }
  get _syntheticGamepad() { return this._slot?.synthetic ?? null; }
  set _syntheticGamepad(_) { /* noop */ }
  get _controllerDriver() { return this._slot?.driver ?? null; }
  get _gyroConnType() { return this._slot?.driver?.connectionType ?? null; }

  // ── Deprecated shims ──
  // These methods are called from lobby.js paths not yet migrated. They
  // return no-op promises so the legacy code runs without errors; the real
  // work (HID pairing, gyro wiring) is done by ControllerManager. Remove
  // once the Step 5b lobby rewrite lands.
  bootstrapFromHID() { return Promise.resolve(false); }
  connectControllerGyro() { return Promise.resolve(); }
  disconnectControllerGyro() { /* noop */ }
  _createSyntheticGamepad() { return null; }

  /**
   * Bind (or rebind) a ControllerManager slot. Updates DOM badge + haptic
   * registration + quirk flag to match the slot's current state. Safe to
   * call with `null` to unbind.
   */
  attachSlot(slot) {
    if (this._slotUnsubscribe) { this._slotUnsubscribe(); this._slotUnsubscribe = null; }
    this._slot = slot || null;
    if (!slot) {
      this._onSlotChange(null, 'detached');
      return;
    }
    this._slotUnsubscribe = slot.on((s, reason) => this._onSlotChange(s, reason));
    // Prime from current state.
    if (slot.state === 'claimed') this._onSlotChange(slot, 'claimed');
  }

  _onSlotChange(slot, reason) {
    const connected = !!slot && slot.state === 'claimed';
    const hidBound = !!slot && !!slot._hidEntry;

    // Update Cyclone A/B quirk from the claimed controller label.
    if (connected && slot.controllerLabel) {
      this._gpSwapAB = !!ControllerRegistry.getGamepadQuirks(slot.controllerLabel).swapAB;
    } else if (!connected) {
      this._gpSwapAB = false;
    }

    // Badge / pedal-bar visibility — only for the primary input (!suppressGamepadBadge).
    if (connected !== this._lastGamepadConnected) {
      this._lastGamepadConnected = connected;
      if (!this.suppressGamepadBadge) {
        const badge = document.getElementById('gamepad-badge');
        if (badge) badge.style.display = connected ? 'block' : 'none';
        const pedalBar = document.getElementById('pedal-bar');
        if (pedalBar) pedalBar.classList.toggle('gamepad-active', connected);
      }
      if (connected) {
        const info = slot.controllerLabel ? ControllerRegistry.identifyFromGamepadId(slot.controllerLabel) : null;
        analytics.setController(info ? info.driverName : (slot.controllerLabel || 'Gamepad'), 'standard');
      } else {
        this.gamepadLean = 0;
        this._gpTriggerLeftPressed = false;
        this._gpTriggerRightPressed = false;
      }
    }

    // Haptic source registration follows HID binding (DualSense WebHID
    // rumble path) — register whenever HID attaches, unregister on detach.
    if (hidBound !== this._lastHidBound) {
      this._lastHidBound = hidBound;
      if (hidBound) addHapticSource(this);
      else removeHapticSource(this);
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

  /**
   * Called once per frame by the game/lobby raf loop. Reads the current
   * effective gamepad from the attached slot, derives stick + trigger
   * state, and (when the slot has an active sensor fusion) runs the
   * orientation → lean projection that used to live in _handleGyroReport.
   *
   * Assumes the caller has already run manager.ingestFrame() for the
   * current frame so the slot's state reflects the latest pads.
   */
  pollGamepad() {
    const gp = this.getGamepadState();
    if (gp) {
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

    // Orientation → tilt projection. The slot's HidEntry ingests gyro at
    // HID-report frequency (100–250Hz) independently; we read the output
    // quaternion once per frame at raf rate. `_applyTilt` uses
    // rate-independent EMA smoothing so cadence doesn't affect feel.
    const fusion = this._slot?.fusion;
    if (!fusion || fusion.calibrating) return;
    // Auto-arm motion pipeline the first time a live fusion is present
    // past its initial bias calibration. Matches the old semantic of
    // `_finishGyroCalibration` setting motionEnabled=true at the end.
    if (!this.motionEnabled) {
      this.motionEnabled = true;
      if (this.onMotionEnabled) this.onMotionEnabled();
    }
    this._tmpEuler.setFromQuaternion(fusion.orientation, 'XYZ');
    const leanDeg = -this._tmpEuler.z * (180 / Math.PI);
    const clampedLean = Math.max(-90, Math.min(90, leanDeg));
    this._gyroRollAccum = -clampedLean;
    this._accelRoll = clampedLean;
    this._applyTilt(clampedLean, true);
  }

  /**
   * Return the current gamepad state — HID-synthetic when the slot's
   * driver emits buttons (BT DualSense case), else the Gamepad API pad.
   * Stale-synthetic protection and button-mode detection live on the
   * slot itself, in `Slot.effectiveGamepad(pads)`.
   *
   * @returns {Gamepad|null}
   */
  getGamepadState() {
    if (!this._slot) return null;
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    return this._slot.effectiveGamepad(pads);
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

  /** Restart the attached slot's initial bias-capture calibration. */
  calibrateGyro() {
    this._slot?.startGyroCalibration();
  }

  /**
   * Recenter semantic: "whatever I'm holding right now = zero lean."
   * Captures the current accel-derived roll as motionOffset so the tilt
   * pipeline sees zero relative lean, then resets the slot's fusion so
   * orientation re-converges from identity.
   */
  recenterGyro() {
    if (this._accelRoll != null) {
      this.motionOffset = -this._accelRoll;
    } else {
      this.motionOffset = 0;
    }
    console.log('Gyro recentered: rollAccum=' + this._gyroRollAccum.toFixed(1) +
      ' accelRoll=' + (this._accelRoll != null ? this._accelRoll.toFixed(1) : 'null') +
      ' offset=' + (this.motionOffset != null ? this.motionOffset.toFixed(1) : 'null') +
      ' conn=' + (this._gyroConnType || 'unknown'));
    this._gyroRollAccum = 0;
    this._smoothedLean = 0;
    this.motionLean = 0;
    this._slot?.fusion?.reset();
  }

  /** Full lean-input reset for tutorial/demo restarts. */
  resetLeanState() {
    this._smoothedLean = 0;
    this._prevLeanRaw = 0;
    this.motionLean = 0;
    if (this.gyroConnected && this._accelRoll != null) {
      this.motionOffset = -this._accelRoll;
    }
    this._gyroRollAccum = 0;
    this._slot?.fusion?.reset();
    this._driftEma = null;
  }



  getMotionLean() {
    return this.motionEnabled ? this.motionLean : 0;
  }
}
