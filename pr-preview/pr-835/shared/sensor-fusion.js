// ============================================================
// SENSOR FUSION — gyro + accel → world-space orientation
// ============================================================
//
// Ported from InputManager's sensor fusion block (see PR #186 and the
// follow-up polish in feature/gyro-sensor-fusion). Derived from
// JibbSmart/GamepadMotionHelpers by Julian "Jibb" Smart — see the GyroWiki
// "Finding Gravity with Sensor Fusion" article (http://gyrowiki.jibbsmart.com/)
// for the algorithm derivation. The original C++ is MIT-licensed; this is a
// JavaScript port adapted for the WebHID runtime. The required copyright and
// permission notice is reproduced below and in packages/core/THIRD_PARTY_NOTICES.md.
//
// ── Upstream license (GamepadMotionHelpers) ──────────────────
//   MIT License — Copyright (c) 2020-2023 Julian "Jibb" Smart
//
//   Permission is hereby granted, free of charge, to any person obtaining a
//   copy of this software and associated documentation files (the "Software"),
//   to deal in the Software without restriction, including without limitation
//   the rights to use, copy, modify, merge, publish, distribute, sublicense,
//   and/or sell copies of the Software, and to permit persons to whom the
//   Software is furnished to do so, subject to the following conditions:
//
//   The above copyright notice and this permission notice shall be included in
//   all copies or substantial portions of the Software.
//
//   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
//   IMPLIED. See THIRD_PARTY_NOTICES.md for the full warranty disclaimer.
// ─────────────────────────────────────────────────────────────
//
// Three pipelines run in parallel each ingest() call:
//  1. Axis-angle quaternion integration of gyro rates
//  2. Gravity-vector tracking + accelerometer correction (tilt drift fix)
//  3. Continuous bias refinement via
//     a. stillness calibration (when controller is at rest)
//     b. sensor-fusion calibration (when controller is moving, cross-
//        checks gyro rates against accel-derived angular velocity)
//
// The class is stateful. Each physical controller needs its own instance
// (local-MP P1 and P2 must not share one).
// ============================================================

import * as THREE from 'three';

import { twistAngleY, stepYawReturn, composeHeadingOffset, DEFAULT_YAW_RETURN_HALF_LIFE_S } from './yaw-return.js';
import { rollFromGravity } from './gravity-roll.js';
import { RollZero } from './roll-zero.js';

// ── Initial one-shot bias calibration ──
// Bluetooth captures are noisier (lower effective sample rate + packet
// jitter) than USB, so BT gets a longer window and a slightly relaxed
// ideal-stddev bar to avoid repeated retries on a connection that simply
// cannot produce a tighter window. USB stays at the original tuning.
export const FUSION_CALIB_COUNT = 150;    // ~1.5s at 100Hz — USB default
export const FUSION_CALIB_COUNT_BT = 250; // ~2.5s — BT needs more samples
// Variance thresholds for bias calibration.
//  - IDEAL: commit immediately when any axis's per-sample stddev is under
//    this. A still DualSense typically produces stddev 5–15 raw units.
//  - ABORT: if after all retries the best window is still above this, the
//    controller was being moved throughout the entire calibration period
//    and committing would produce orientation drift. Leave bias unchanged
//    (previous value, zero on first pass) and let the continuous stillness
//    calibration refine it in the background once the user settles.
const FUSION_CALIB_IDEAL_STDDEV = 150;
const FUSION_CALIB_IDEAL_STDDEV_BT = 200; // BT packet jitter raises the floor
const FUSION_CALIB_ABORT_STDDEV = 1500;
const FUSION_CALIB_MAX_RETRIES = 5;
// A bias already in use is replaced only by a window about as quiet as the one
// that produced it (#822). Games recalibrate at each ride start with the
// controller in hand, and those windows pass the IDEAL bar while their mean
// holds the hand's motion. Real at-rest windows from one controller vary by up
// to 1.33x, and an in-hand window from the owner's session was 1.6x.
const BIAS_REPLACE_STDDEV_RATIO = 1.5;
// A window this quiet was taken at rest (measured floors are 2-5 raw units on
// Steam Controller, DualShock 4 and Switch Pro; in-hand windows are 66-75).
const BIAS_AT_REST_STDDEV = 30;
// How far in-motion refinement may move an at-rest bias. Stillness refinement
// moves the bias and this center with it, so slow temperature drift is followed.
const SENSOR_FUSION_MAX_BIAS_SHIFT_DPS = 0.5;

// ── Gravity tracking ──
const GRAVITY_STILL_SPEED = 1.0;
const GRAVITY_SHAKY_SPEED = 0.1;
const SHAKINESS_MIN_THRESHOLD = 0.01;
const SHAKINESS_MAX_THRESHOLD = 0.4;
const GRAVITY_GYRO_FACTOR = 0.1;       // cap correction at 10% of gyro speed
const GRAVITY_MIN_SPEED = 0.01;
const GRAVITY_GYRO_MIN_THRESHOLD = 0.05;
const GRAVITY_GYRO_MAX_THRESHOLD = 0.25;
const STEADINESS_HALF_TIME = 0.25;

// ── Continuous stillness calibration ──
const STILLNESS_WINDOW_TIME = 0.5;     // min collection time (seconds)
const STILLNESS_CORRECTION_TIME = 2.0; // must be still this long to recalibrate
const STILLNESS_CAL_HALF_TIME = 0.1;   // exponential lerp half-life
const STILLNESS_CAL_EASE_IN = 3.0;     // ramp-up time
const STILLNESS_DETERIORATION = 0.2;   // how fast min deltas grow per second

// ── Sensor-fusion calibration (motion-time bias refinement) ──
// Matches GamepadMotionHelpers AutoCalibration::AddSampleSensorFusion.
const SENSOR_FUSION_SMOOTHING_STRENGTH = 2.0;
const SENSOR_FUSION_ANGULAR_ACCEL_THRESHOLD = 20.0;  // deg/s² gate
const SENSOR_FUSION_EASE_IN_TIME = 3.0;
const SENSOR_FUSION_HALF_TIME = 0.1;

// ── At-rest yaw return-to-neutral (SC yaw-drift fix, issue #88) ──
// Gravity correction anchors pitch and roll but can never touch yaw: the
// accelerometer has no reference for heading about the gravity axis, so any
// residual yaw-axis gyro bias integrates without bound and re-accumulates
// after every recenter. When the controller is detected at rest, slowly bleed
// the *displayed* heading back toward the recenter reference — pitch/roll are
// left physically true. Mirrors how Steam Input's gyro re-centers "when you
// let go". Gated on rest so it never fights an intentional slow turn.
const YAW_RETURN_REST_DELAY = 0.75; // must be at rest this long before decay starts (s)

export class SensorFusion {
  constructor() {
    // Bias in raw sensor units (subtracted from raw gyro every frame).
    this.bias = { x: 0, y: 0, z: 0 };

    // Scalar on gravity correction strength. 0 disables gravity tracking
    // (raw quaternion integration only — will drift). 1.0 is full strength
    // (same as the game uses). 0.5 = gentle. Exposed for the overlay's
    // user-facing "Gravity Correction: Off/Gentle/Strong" setting.
    this.gravityMode = 1.0;

    // Initial one-shot calibration: collects FUSION_CALIB_COUNT samples,
    // runs a variance check, then sets bias to the mean. On high-variance
    // captures (user moving the controller), retries up to
    // FUSION_CALIB_MAX_RETRIES times. Tracks the best attempt across
    // retries and commits that one (or aborts if even the best is too
    // noisy to trust).
    this._calibrating = false;
    this._calibSamples = [];
    this._calibRetries = 0;
    this._calibBest = null; // { meanX, meanY, meanZ, stddev }
    // The bias in use and how quiet its source was: { x, y, z, stddev }, or
    // null until the first calibration. Cleared by resetBias().
    this._trustedBias = null;

    // Fusion state
    this.orientation = new THREE.Quaternion();
    this._gravityVec = new THREE.Vector3(0, -1, 0);
    this._smoothAccel = new THREE.Vector3(0, -1, 0);
    this._shakiness = 0;

    // Recentered orientation the overlay actually displays. Equals the raw
    // integrated `orientation` with its heading (yaw) offset removed, so a
    // recenter — or the at-rest auto-return below — sticks without fighting
    // the gravity-anchored pitch/roll. Consumers should read THIS, not the raw
    // `orientation`, when they want what the user sees.
    this.displayOrientation = new THREE.Quaternion();

    // Heading offset (radians about world-up) subtracted from `orientation` to
    // form `displayOrientation`. recenter() snaps it to the current heading;
    // the at-rest yaw return slews it toward the current heading over time.
    this._refYaw = 0;

    // Half-life (seconds) of the at-rest yaw return-to-neutral. 0 disables it
    // (raw yaw passes straight through). Set from the overlay's "Yaw Drift"
    // setting; larger = slower return. On by default since core 0.7 (#596).
    this.yawReturnHalfLife = DEFAULT_YAW_RETURN_HALF_LIFE_S;

    // Seconds the controller has been continuously detected at rest, updated by
    // the stillness pipeline. Gates the yaw return.
    this._restDuration = 0;

    // Stillness window (continuous bias refinement at rest)
    this._stillnessWindow = {
      samples: [],
      stillSince: 0,
      minDeltaGyro: 1.0,
      minDeltaAccel: 0.25,
      easeIn: 0,
    };

    // Sensor-fusion calibration state (in-motion bias refinement)
    this._sfSmoothedGyro = new THREE.Vector3();
    this._sfSmoothedPreviousAccel = new THREE.Vector3();
    this._sfPreviousAccel = new THREE.Vector3();
    this._sfTimeSteady = 0;
    this._sfSkippedTime = 0;

    // performance.now() until which the in-motion bias-refinement
    // pipeline is suppressed. Set by suppressCalibrationFor() when
    // rumble fires so vibration-induced accel noise can't pollute the
    // gyro/accel cross-check. The stillness calibration auto-gates on
    // its own thresholds and is not affected.
    this._suppressCalibUntilMs = 0;

    // The roll that counts as level for this controller as it is held (#112).
    // Fed the gravity roll on every ingest(); see roll-zero.js.
    this.rollZero = new RollZero();
    // The accelerometer's own reading, lightly smoothed (50 ms half-life), for
    // the roll zero's stillness check and its at-rest value. Separate from
    // _smoothAccel, whose 250 ms half-life and reset value serve shakiness.
    this._rzAccel = new THREE.Vector3();
    this._rzAccelInit = false;
    this._rzAccelLen = 0;

    // Timekeeping: set to performance.now() on first ingest().
    this._lastGyroTime = 0;
    // The last device IMU timestamp, for drivers that report one (#822).
    this._lastImuTicks = null;

    // Reusable scratch vectors — instance-scoped so two SensorFusion
    // instances can't clobber each other mid-frame.
    this._tmpVec = new THREE.Vector3();
    this._tmpVec2 = new THREE.Vector3();
    this._tmpVec3 = new THREE.Vector3();
    this._tmpQuat = new THREE.Quaternion();
  }

  /** Whether the initial one-shot bias calibration is still collecting. */
  get calibrating() { return this._calibrating; }

  /**
   * Roll (bank) angle in radians from the gravity-anchored down vector — the
   * drift-free steering axis for lean-to-steer games. Reads only `_gravityVec`
   * (accelerometer-tracked), never yaw (which a 6-axis IMU can't anchor) or the
   * gyro, so it can't "fuse to one side" the way Euler-Z of the integrated
   * orientation does. Sign matches the -EulerZ convention consumers already use,
   * so it's a drop-in that only removes the drift. See gravity-roll.js (#314).
   */
  gravityRollRadians() {
    return rollFromGravity(this._gravityVec.x, this._gravityVec.y);
  }

  /**
   * Take the roll zero now: the way the controller is held at this moment is
   * level. The result's `still` says whether it was at rest; a zero taken
   * while it moved is committed, and reported as not still (#112).
   * @returns {import('./roll-zero.js').RollZeroResult}
   */
  setRollZero() {
    const r = this.rollZero.set();
    if (r.still) this._alignGravityToRest();
    return r;
  }

  /**
   * At rest the accelerometer measures down directly, so when a zero is taken
   * at rest the tracked gravity vector is put on it. Without this, a zero
   * taken while gravity is still coming back after reset() would read as a
   * lean that slowly fades (the gravity correction is slow by design when the
   * gap is small). Changes nothing when the two already agree.
   */
  _alignGravityToRest() {
    if (!this._rzAccelInit || this._rzAccelLen < 1e-6) return;
    this._gravityVec.copy(this._rzAccel).multiplyScalar(-this._gravityVec.length() / this._rzAccelLen);
  }

  /**
   * Take the roll zero at the next still moment instead of now (for a consumer
   * that used to pick a fixed moment, such as a countdown). The old zero stays
   * in force until then. `fallback` is what happens when no still moment comes
   * before `timeoutMs`: 'best' uses the steadiest window seen, 'keep' leaves
   * the zero as it was. Listen on `rollZero.onResult` for the outcome.
   * @param {{timeoutMs?: number, fallback?: 'best'|'keep'}} [opts]
   */
  requestRollZero(opts) { this.rollZero.request(opts); }

  /** Forget the roll zero: rollRelativeRadians() is the gravity roll again. */
  clearRollZero() { return this.rollZero.clear(); }

  /**
   * Gravity roll measured from the roll zero, radians in (-π, π]. Equal to
   * gravityRollRadians() until a zero is taken. Same sign convention.
   */
  rollRelativeRadians() { return this.rollZero.relative(this.gravityRollRadians()); }

  /**
   * Begin initial one-shot bias calibration. Clears any prior samples.
   * @param {string} [connectionType] — 'bluetooth' or 'usb'. BT gets a
   *   longer capture window and relaxed ideal-stddev threshold to match
   *   the noisier transport. Defaults to USB tuning when unspecified.
   */
  startCalibration(connectionType) {
    this._calibrating = true;
    this._calibSamples = [];
    this._calibRetries = 0;
    this._calibBest = null;
    const isBT = connectionType === 'bluetooth';
    this._calibCount = isBT ? FUSION_CALIB_COUNT_BT : FUSION_CALIB_COUNT;
    this._calibIdealStddev = isBT ? FUSION_CALIB_IDEAL_STDDEV_BT : FUSION_CALIB_IDEAL_STDDEV;
  }

  /** Abort calibration without touching bias. */
  cancelCalibration() {
    this._calibrating = false;
    this._calibSamples = [];
  }

  /**
   * Suppress the in-motion sensor-fusion calibration pipeline for the
   * next `ms` milliseconds. Called by the haptics module when rumble
   * fires — rumble vibration produces high-frequency accel noise that
   * aliases below the normal threshold gate and would otherwise pollute
   * the gyro-vs-accel bias cross-check.
   */
  suppressCalibrationFor(ms) {
    const until = performance.now() + ms;
    if (until > this._suppressCalibUntilMs) this._suppressCalibUntilMs = until;
  }

  /**
   * Reset all fusion state to identity. Bias is preserved (it's not fusion
   * state — it's the learned zero offset). Call on driver disconnect, on
   * recenter, or any other "start fresh" event.
   */
  reset() {
    this.orientation.identity();
    this.displayOrientation.identity();
    this._refYaw = 0;
    this._restDuration = 0;
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
    this._lastGyroTime = 0;
    this._lastImuTicks = null;
    // Gravity starts again from straight down and converges on the real pose:
    // that jump is not the player, so it must not count as movement or as a
    // still window. The zero itself is kept (it is the grip, not fusion state).
    this.rollZero.resetWindow();
    this._rzAccelInit = false;
  }

  /**
   * Soft recenter: zero the *displayed* heading without disturbing the raw
   * integrated orientation, the fusion state, or the gravity-anchored
   * pitch/roll. Only yaw (heading about world-up) is offset out, so
   * recentering while the controller is tilted keeps the tilt physically true.
   * Unlike reset(), accumulated orientation is preserved.
   */
  recenter() {
    this._refYaw = twistAngleY(this.orientation);
  }

  /**
   * Clear bias back to zero. Use this when starting a fresh calibration
   * pass so the learned-at-motion bias doesn't contaminate the new zero.
   */
  resetBias() {
    this.bias.x = 0;
    this.bias.y = 0;
    this.bias.z = 0;
    this._trustedBias = null;
  }

  /** Record the current bias as trusted, from a source this quiet. */
  _trustBias(stddev) {
    this._trustedBias = { x: this.bias.x, y: this.bias.y, z: this.bias.z, stddev };
  }

  /**
   * The bias a calibration settled on, in degrees per second. A window taken while the controller was moving
   * commits a wrong bias, which turns into heading drift, so a diagnostic log has to be able to show it (#822).
   * A warning, because the desktop build's diagnostic log keeps warnings and errors only.
   */
  _logCalibCommit(kind, stddev, gyroScale) {
    const dps = (v) => (v * gyroScale).toFixed(2);
    console.warn(`Fusion calib committed ${kind} (stddev ${stddev.toFixed(0)}): bias ${dps(this.bias.x)}, ${dps(this.bias.y)}, ${dps(this.bias.z)} deg/s`);
  }

  /**
   * Ingest one HID report's worth of IMU data. Caller is responsible for
   * unit scales (gyroScale: deg/sec per raw unit; accelScale: g per raw
   * unit — typical values 2000/32768 * π/180 after conversion for gyro,
   * 1/8192 for DualSense accel).
   *
   * @param {number} rawGx raw gyro x (sensor units)
   * @param {number} rawGy raw gyro y
   * @param {number} rawGz raw gyro z
   * @param {number|null} rawAx raw accel x, or null if driver has no accel
   * @param {number|null} rawAy
   * @param {number|null} rawAz
   * @param {number} gyroScale deg/sec per raw gyro unit
   * @param {number} accelScale g per raw accel unit (used by fusion only;
   *                            gravity correction is unit-scale-invariant
   *                            so this can be approximate)
   * @param {number} nowMs performance.now() from the caller
   * @param {number} [imuTicks] the device's own uint32 sample timestamp, if the
   *   driver has one. Reports queued behind a busy main thread all arrive at
   *   about the same nowMs, so the time between samples must come from here.
   * @param {number} [imuTicksPerMs] that timestamp's clock rate
   */
  ingest(rawGx, rawGy, rawGz, rawAx, rawAy, rawAz, gyroScale, accelScale, nowMs, imuTicks, imuTicksPerMs) {
    // Initial one-shot bias capture with best-of-N retry selection.
    if (this._calibrating) {
      this._calibSamples.push({ x: rawGx, y: rawGy, z: rawGz });
      const calibCount = this._calibCount || FUSION_CALIB_COUNT;
      if (this._calibSamples.length >= calibCount) {
        const n = this._calibSamples.length;
        let sx = 0, sy = 0, sz = 0;
        for (const s of this._calibSamples) { sx += s.x; sy += s.y; sz += s.z; }
        const meanX = sx / n, meanY = sy / n, meanZ = sz / n;
        let varX = 0, varY = 0, varZ = 0;
        for (const s of this._calibSamples) {
          varX += (s.x - meanX) ** 2;
          varY += (s.y - meanY) ** 2;
          varZ += (s.z - meanZ) ** 2;
        }
        const maxStd = Math.max(
          Math.sqrt(varX / n),
          Math.sqrt(varY / n),
          Math.sqrt(varZ / n),
        );
        // Track the best attempt seen so far so even a later retry that's
        // dirtier doesn't overwrite an earlier clean one.
        if (!this._calibBest || maxStd < this._calibBest.stddev) {
          this._calibBest = { meanX, meanY, meanZ, stddev: maxStd };
        }
        const idealStddev = this._calibIdealStddev || FUSION_CALIB_IDEAL_STDDEV;
        if (this._trustedBias && maxStd > this._trustedBias.stddev * BIAS_REPLACE_STDDEV_RATIO) {
          // Noisier than the bias in use: keep that bias and hand control back.
          console.warn(`Fusion calib kept bias (window stddev ${maxStd.toFixed(0)} vs ${this._trustedBias.stddev.toFixed(0)})`);
          this._calibSamples = [];
          this._calibrating = false;
          this._calibBest = null;
        } else if (maxStd <= idealStddev) {
          // Great sample — commit immediately.
          this.bias.x = meanX;
          this.bias.y = meanY;
          this.bias.z = meanZ;
          this._trustBias(maxStd);
          this._logCalibCommit('clean', maxStd, gyroScale);
          this._calibSamples = [];
          this._calibrating = false;
          this._calibBest = null;
        } else if (this._calibRetries < FUSION_CALIB_MAX_RETRIES) {
          // Noisy window — try again.
          this._calibRetries++;
          this._calibSamples = [];
          console.log(`Fusion calib retry ${this._calibRetries}/${FUSION_CALIB_MAX_RETRIES} (stddev ${maxStd.toFixed(0)})`);
        } else {
          // All retries exhausted. Commit the best window we saw IF it's
          // trustworthy; otherwise abort and leave bias unchanged so the
          // continuous stillness calibration can refine it in the
          // background once the user settles.
          const best = this._calibBest;
          if (best.stddev <= FUSION_CALIB_ABORT_STDDEV) {
            this.bias.x = best.meanX;
            this.bias.y = best.meanY;
            this.bias.z = best.meanZ;
            this._trustBias(best.stddev);
            this._logCalibCommit(`best-of-${FUSION_CALIB_MAX_RETRIES + 1}`, best.stddev, gyroScale);
          } else {
            console.warn(`Fusion calib aborted — all ${FUSION_CALIB_MAX_RETRIES + 1} captures too noisy (best stddev ${best.stddev.toFixed(0)}); keeping previous bias, letting continuous calibration refine`);
          }
          this._calibSamples = [];
          this._calibrating = false;
          this._calibBest = null;
        }
      }
    }

    // First-frame dt init: skip integration, just remember the time.
    const hasImuClock = Number.isFinite(imuTicks) && imuTicksPerMs > 0;
    if (this._lastGyroTime === 0) {
      this._lastGyroTime = nowMs;
      this._lastImuTicks = hasImuClock ? imuTicks : null;
      return;
    }

    let dt = (nowMs - this._lastGyroTime) / 1000.0;
    this._lastGyroTime = nowMs;
    if (hasImuClock) {
      if (this._lastImuTicks !== null) {
        // >>> 0 keeps the difference right across the uint32 wrap. Zero means
        // the report repeats the last IMU sample, so there is nothing to add.
        dt = ((imuTicks - this._lastImuTicks) >>> 0) / imuTicksPerMs / 1000.0;
      }
      this._lastImuTicks = imuTicks;
    } else {
      this._lastImuTicks = null;
    }
    if (dt <= 0 || dt >= 0.1) return;

    const hasAccel = rawAx != null && rawAy != null && rawAz != null;

    // Apply bias
    const gx = rawGx - this.bias.x;
    const gy = rawGy - this.bias.y;
    const gz = rawGz - this.bias.z;

    // 1. Axis-angle integration
    const scale = gyroScale * (Math.PI / 180.0);
    const angX = gx * scale * dt;
    const angY = gy * scale * dt;
    const angZ = gz * scale * dt;
    const angle = Math.sqrt(angX * angX + angY * angY + angZ * angZ);
    if (angle > 1e-10) {
      const ha = angle * 0.5;
      const s = Math.sin(ha) / angle;
      this._tmpQuat.set(angX * s, angY * s, angZ * s, Math.cos(ha));
      this.orientation.multiply(this._tmpQuat);
    }

    // 2. Gravity tracking + accel correction (skipped if user disabled it)
    if (hasAccel && this.gravityMode > 0) {
      const as = accelScale || (1.0 / 8192.0);
      const ax = rawAx * as;
      const ay = rawAy * as;
      const az = rawAz * as;
      this._tmpVec.set(ax, ay, az);
      const accelVec = this._tmpVec;
      const accelLen = accelVec.length();

      // Rotate gravity vec into rotating sensor-local frame
      if (angle > 1e-10) {
        const ha2 = angle * 0.5;
        const s2 = Math.sin(ha2) / angle;
        this._tmpQuat.set(-angX * s2, -angY * s2, -angZ * s2, Math.cos(ha2));
        this._gravityVec.applyQuaternion(this._tmpQuat);
      }

      // Shakiness tracking (EMA peak-detect)
      const smoothFactor = Math.pow(2, -dt / STEADINESS_HALF_TIME);
      this._smoothAccel.lerp(accelVec, 1 - smoothFactor);
      const accelDiff = this._tmpVec2.copy(accelVec).sub(this._smoothAccel).length();
      this._shakiness = Math.max(this._shakiness * smoothFactor, accelDiff);

      // Adaptive correction speed
      const shakyT = Math.max(0, Math.min(1,
        (this._shakiness - SHAKINESS_MIN_THRESHOLD) /
        (SHAKINESS_MAX_THRESHOLD - SHAKINESS_MIN_THRESHOLD)));
      let correctionSpeed = ((1 - shakyT) * GRAVITY_STILL_SPEED + shakyT * GRAVITY_SHAKY_SPEED) * this.gravityMode;

      // Gyro rate limiting — taper toward a gyro-proportional ceiling
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

      // Correct gravity toward accel when magnitude is near 1g
      if (accelLen > 0.4 && accelLen < 1.6) {
        const gravLen = this._gravityVec.length();
        this._tmpVec2.copy(accelVec).multiplyScalar(-gravLen / accelLen);
        const corrAmount = Math.min(correctionSpeed * dt, 1.0);
        this._gravityVec.lerp(this._tmpVec2, corrAmount);
      }

      // 3. Apply tilt correction to orientation
      const gravWorld = this._tmpVec2.copy(this._gravityVec)
        .applyQuaternion(this.orientation)
        .normalize();
      const worldDown = this._tmpVec3.set(0, -1, 0);
      const errorAngle = Math.acos(Math.max(-1, Math.min(1, worldDown.dot(gravWorld))));
      if (errorAngle > 1e-6) {
        const corrAxis = this._tmpVec.crossVectors(gravWorld, worldDown).normalize();
        const cha = errorAngle * 0.5;
        const cs = Math.sin(cha);
        this._tmpQuat.set(corrAxis.x * cs, corrAxis.y * cs, corrAxis.z * cs, Math.cos(cha));
        this.orientation.premultiply(this._tmpQuat);
      }
    }

    this.orientation.normalize();

    // Roll zero (#112): only with an accelerometer, since the roll is gravity's.
    if (hasAccel && this.gravityMode > 0) {
      const as = accelScale || (1.0 / 8192.0);
      const a = this._tmpVec.set(rawAx * as, rawAy * as, rawAz * as);
      if (!this._rzAccelInit) { this._rzAccel.copy(a); this._rzAccelInit = true; }
      else this._rzAccel.lerp(a, 1 - Math.pow(2, -dt / 0.05));
      this._rzAccelLen = this._rzAccel.length();
      // near 1g only: otherwise the hand's own acceleration is in the reading
      const restRoll = (this._rzAccelLen > 0.85 && this._rzAccelLen < 1.15)
        ? rollFromGravity(-this._rzAccel.x, -this._rzAccel.y) : NaN;
      const decided = this.rollZero.sample(this.gravityRollRadians(), nowMs, restRoll);
      if (decided && decided.still && decided.changed) this._alignGravityToRest();
    }

    // 4. Continuous stillness calibration (runs when accel is stable)
    if (!this._calibrating) {
      this._updateStillnessCalibration(rawGx, rawGy, rawGz, hasAccel ? rawAx : 0, hasAccel ? rawAy : 0, hasAccel ? rawAz : 0, accelScale, dt, nowMs);
    }

    // 5. Sensor-fusion calibration (runs when accel is changing). Skipped
    // while rumble is suppressing calibration — vibration noise would
    // otherwise contaminate the gyro-vs-accel bias cross-check.
    if (!this._calibrating && hasAccel && nowMs >= this._suppressCalibUntilMs) {
      this._updateSensorFusionCalibration(rawGx, rawGy, rawGz, gyroScale, rawAx, rawAy, rawAz, dt);
    }

    this._updateDisplayOrientation(dt);
  }

  /**
   * Rebuild displayOrientation from the raw orientation and the heading offset.
   * When yaw return is enabled and the controller has been at rest past the
   * delay, first bleed the displayed heading back toward center (yaw-only —
   * pitch/roll pass straight through, since gravity already anchors them).
   * displayOrientation = R_y(-refYaw) · orientation.
   */
  _updateDisplayOrientation(dt) {
    if (this._restDuration >= YAW_RETURN_REST_DELAY) {
      this._refYaw = stepYawReturn(this._refYaw, this.orientation, dt, this.yawReturnHalfLife);
    }
    composeHeadingOffset(this.displayOrientation, this._refYaw, this.orientation);
  }

  _updateStillnessCalibration(gxRaw, gyRaw, gzRaw, axRaw, ayRaw, azRaw, accelScale, dt, nowMs) {
    const sw = this._stillnessWindow;
    const s = accelScale || (1.0 / 8192.0);
    const ax = axRaw * s;
    const ay = ayRaw * s;
    const az = azRaw * s;

    sw.samples.push({ gx: gxRaw, gy: gyRaw, gz: gzRaw, ax, ay, az, t: nowMs });

    const windowStart = nowMs - STILLNESS_WINDOW_TIME * 1000;
    while (sw.samples.length > 0 && sw.samples[0].t < windowStart) sw.samples.shift();
    if (sw.samples.length < 10) { sw.stillSince = 0; this._restDuration = 0; return; }

    let gxMin = Infinity, gxMax = -Infinity, gyMin = Infinity, gyMax = -Infinity, gzMin = Infinity, gzMax = -Infinity;
    let axMin = Infinity, axMax = -Infinity, ayMin = Infinity, ayMax = -Infinity, azMin = Infinity, azMax = -Infinity;
    let sgx = 0, sgy = 0, sgz = 0;
    for (const sample of sw.samples) {
      if (sample.gx < gxMin) gxMin = sample.gx; if (sample.gx > gxMax) gxMax = sample.gx;
      if (sample.gy < gyMin) gyMin = sample.gy; if (sample.gy > gyMax) gyMax = sample.gy;
      if (sample.gz < gzMin) gzMin = sample.gz; if (sample.gz > gzMax) gzMax = sample.gz;
      if (sample.ax < axMin) axMin = sample.ax; if (sample.ax > axMax) axMax = sample.ax;
      if (sample.ay < ayMin) ayMin = sample.ay; if (sample.ay > ayMax) ayMax = sample.ay;
      if (sample.az < azMin) azMin = sample.az; if (sample.az > azMax) azMax = sample.az;
      sgx += sample.gx; sgy += sample.gy; sgz += sample.gz;
    }
    const dGyro = Math.max(gxMax - gxMin, gyMax - gyMin, gzMax - gzMin);
    const dAccel = Math.max(axMax - axMin, ayMax - ayMin, azMax - azMin);

    sw.minDeltaGyro = Math.min(sw.minDeltaGyro, dGyro);
    sw.minDeltaAccel = Math.min(sw.minDeltaAccel, dAccel);
    sw.minDeltaGyro += STILLNESS_DETERIORATION * dt;
    sw.minDeltaAccel += STILLNESS_DETERIORATION * 0.01 * dt;

    const isStill = dGyro < sw.minDeltaGyro * 2.0 && dAccel < sw.minDeltaAccel * 2.0;

    if (isStill) {
      if (sw.stillSince === 0) sw.stillSince = nowMs;
      const stillDuration = (nowMs - sw.stillSince) / 1000;
      this._restDuration = stillDuration;
      if (stillDuration >= STILLNESS_CORRECTION_TIME) {
        sw.easeIn = Math.min(sw.easeIn + dt / STILLNESS_CAL_EASE_IN, 1.0);
        const lerpFactor = Math.pow(2, -sw.easeIn * dt / STILLNESS_CAL_HALF_TIME);
        const meanGx = sgx / sw.samples.length;
        const meanGy = sgy / sw.samples.length;
        const meanGz = sgz / sw.samples.length;
        this.bias.x = this.bias.x * lerpFactor + meanGx * (1 - lerpFactor);
        this.bias.y = this.bias.y * lerpFactor + meanGy * (1 - lerpFactor);
        this.bias.z = this.bias.z * lerpFactor + meanGz * (1 - lerpFactor);
        // Real rest: the bias center follows it, and a fully eased-in window
        // vouches for the bias even if the last one-shot window was in hand.
        const t = this._trustedBias;
        if (t) { t.x = this.bias.x; t.y = this.bias.y; t.z = this.bias.z; }
        if (sw.easeIn >= 1) {
          let vx = 0, vy = 0, vz = 0;
          for (const q of sw.samples) {
            vx += (q.gx - meanGx) ** 2; vy += (q.gy - meanGy) ** 2; vz += (q.gz - meanGz) ** 2;
          }
          const windowStd = Math.sqrt(Math.max(vx, vy, vz) / sw.samples.length);
          if (!t || windowStd < t.stddev) this._trustBias(windowStd);
        }
      }
    } else {
      sw.stillSince = 0;
      sw.easeIn = 0;
      this._restDuration = 0;
    }
  }

  _updateSensorFusionCalibration(rawGx, rawGy, rawGz, gyroScale, inAx, inAy, inAz, dt) {
    if (dt <= 0 || !gyroScale) return;

    const inGxDps = rawGx * gyroScale;
    const inGyDps = rawGy * gyroScale;
    const inGzDps = rawGz * gyroScale;

    // Zero-input rejection
    if (rawGx === 0 && rawGy === 0 && rawGz === 0 && inAx === 0 && inAy === 0 && inAz === 0) {
      this._sfTimeSteady = 0;
      this._sfSkippedTime = 0;
      this._sfPreviousAccel.set(0, 0, 0);
      this._sfSmoothedPreviousAccel.set(0, 0, 0);
      this._sfSmoothedGyro.set(0, 0, 0);
      return;
    }

    // Initial state
    if (this._sfPreviousAccel.x === 0 && this._sfPreviousAccel.y === 0 && this._sfPreviousAccel.z === 0) {
      this._sfTimeSteady = 0;
      this._sfSkippedTime = 0;
      this._sfPreviousAccel.set(inAx, inAy, inAz);
      this._sfSmoothedPreviousAccel.set(inAx, inAy, inAz);
      this._sfSmoothedGyro.set(0, 0, 0);
      return;
    }

    // Duplicate report — accumulate skipped time
    if (inAx === this._sfPreviousAccel.x && inAy === this._sfPreviousAccel.y && inAz === this._sfPreviousAccel.z) {
      this._sfSkippedTime += dt;
      return;
    }

    const effDt = dt + this._sfSkippedTime;
    this._sfSkippedTime = 0;

    const smoothingLerp = Math.pow(2, -SENSOR_FUSION_SMOOTHING_STRENGTH * effDt);

    const prevSmGx = this._sfSmoothedGyro.x;
    const prevSmGy = this._sfSmoothedGyro.y;
    const prevSmGz = this._sfSmoothedGyro.z;
    this._sfSmoothedGyro.set(
      inGxDps * (1 - smoothingLerp) + prevSmGx * smoothingLerp,
      inGyDps * (1 - smoothingLerp) + prevSmGy * smoothingLerp,
      inGzDps * (1 - smoothingLerp) + prevSmGz * smoothingLerp,
    );

    const dGx = this._sfSmoothedGyro.x - prevSmGx;
    const dGy = this._sfSmoothedGyro.y - prevSmGy;
    const dGz = this._sfSmoothedGyro.z - prevSmGz;
    const gyroAccelMag = Math.sqrt(dGx * dGx + dGy * dGy + dGz * dGz) / effDt;

    const prevNormal = this._tmpVec.copy(this._sfSmoothedPreviousAccel).normalize();

    const smoothAx = inAx * (1 - smoothingLerp) + this._sfSmoothedPreviousAccel.x * smoothingLerp;
    const smoothAy = inAy * (1 - smoothingLerp) + this._sfSmoothedPreviousAccel.y * smoothingLerp;
    const smoothAz = inAz * (1 - smoothingLerp) + this._sfSmoothedPreviousAccel.z * smoothingLerp;
    const thisNormal = this._tmpVec2.set(smoothAx, smoothAy, smoothAz).normalize();

    const angVel = this._tmpVec3.crossVectors(thisNormal, prevNormal);
    const crossLen = angVel.length();
    if (crossLen > 0) {
      const dot = Math.max(-1, Math.min(1, thisNormal.dot(prevNormal)));
      const angleChangeDeg = Math.acos(dot) * (180 / Math.PI);
      const anglePerSec = angleChangeDeg / effDt;
      angVel.multiplyScalar(anglePerSec / crossLen);
    }

    if (gyroAccelMag > SENSOR_FUSION_ANGULAR_ACCEL_THRESHOLD) {
      this._sfTimeSteady = 0;
    } else {
      this._sfTimeSteady = Math.min(this._sfTimeSteady + effDt, SENSOR_FUSION_EASE_IN_TIME);
      const easeIn = SENSOR_FUSION_EASE_IN_TIME <= 0 ? 1 : this._sfTimeSteady / SENSOR_FUSION_EASE_IN_TIME;
      const lerpFactor = SENSOR_FUSION_HALF_TIME <= 0 ? 0 : Math.pow(2, -easeIn * effDt / SENSOR_FUSION_HALF_TIME);

      const oldBiasXDps = this.bias.x * gyroScale;
      const oldBiasYDps = this.bias.y * gyroScale;
      const oldBiasZDps = this.bias.z * gyroScale;
      let newBiasX = (this._sfSmoothedGyro.x - angVel.x) * (1 - lerpFactor) + oldBiasXDps * lerpFactor;
      let newBiasY = (this._sfSmoothedGyro.y - angVel.y) * (1 - lerpFactor) + oldBiasYDps * lerpFactor;
      let newBiasZ = (this._sfSmoothedGyro.z - angVel.z) * (1 - lerpFactor) + oldBiasZDps * lerpFactor;

      let strengthX = Math.abs(thisNormal.x);
      let strengthY = Math.abs(thisNormal.y);
      let strengthZ = Math.abs(thisNormal.z);
      if (strengthX > 0.7) strengthX = 1.0;
      if (strengthY > 0.7) strengthY = 1.0;
      if (strengthZ > 0.7) strengthZ = 1.0;
      strengthX = Math.min(strengthX, 1.0);
      strengthY = Math.min(strengthY, 1.0);
      strengthZ = Math.min(strengthZ, 1.0);

      newBiasX = newBiasX * (1 - strengthX) + oldBiasXDps * strengthX;
      newBiasY = newBiasY * (1 - strengthY) + oldBiasYDps * strengthY;
      newBiasZ = newBiasZ * (1 - strengthZ) + oldBiasZDps * strengthZ;

      this.bias.x = newBiasX / gyroScale;
      this.bias.y = newBiasY / gyroScale;
      this.bias.z = newBiasZ / gyroScale;

      // Hand motion leaks into this estimate: keep it near a bias taken at rest.
      const t = this._trustedBias;
      if (t && t.stddev <= BIAS_AT_REST_STDDEV) {
        const m = SENSOR_FUSION_MAX_BIAS_SHIFT_DPS / gyroScale;
        this.bias.x = Math.max(t.x - m, Math.min(t.x + m, this.bias.x));
        this.bias.y = Math.max(t.y - m, Math.min(t.y + m, this.bias.y));
        this.bias.z = Math.max(t.z - m, Math.min(t.z + m, this.bias.z));
      }
    }

    this._sfSmoothedPreviousAccel.set(smoothAx, smoothAy, smoothAz);
    this._sfPreviousAccel.set(inAx, inAy, inAz);
  }
}
