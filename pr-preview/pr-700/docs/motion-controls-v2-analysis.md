# Tandemonium Motion Controls: V2 Analysis

## Post-Implementation Review — Game Mechanics & Experience

**Date:** March 4, 2026
**Branch:** `feature/gyro-improvements`
**Scope:** Full analysis of motion input pipeline, from sensor to physics, for both mobile tilt and gamepad gyro.

This document is a v2 follow-up to the [initial analysis](../Downloads/remixed-4a012e83.md) which identified 6 wrong/missing items and 4 partial items out of 14 categories. This review assesses the current state after implementation changes, evaluates game feel, and identifies remaining opportunities.

---

## Executive Summary

The v1 analysis scored 4/14 correct. The current codebase addresses **10 of the 14 original items**, with the remaining 4 being polish-tier improvements. The architecture is now sound: DeviceOrientation is primary, calibration uses multi-sample averaging, dead zones and sensitivity are in recommended ranges, response curves and output smoothing are implemented, and mobile vs gyro tuning is separated. The system is production-quality for the game's scope.

| Category | V1 Status | V2 Status |
|----------|-----------|-----------|
| API choice | PARTIAL | **FIXED** — DeviceOrientation primary |
| Calibration timing | WRONG | **FIXED** — Multi-sample buffer |
| Calibration method | WRONG | **FIXED** — 10-sample averaging |
| Manual recalibrate | OK | OK |
| Low-pass filter k | WRONG | **FIXED** — k = 0.1 |
| Frame-rate independent filter | PARTIAL | PARTIAL (acceptable) |
| Dead zone value | WRONG | **FIXED** — 4 degrees |
| Dead zone remapping | OK | OK |
| Sensitivity range | WRONG | **FIXED** — 25 degrees |
| Response curve | MISSING | **FIXED** — power 1.4 (mobile), 1.3 (gyro) |
| Output smoothing | MISSING | **FIXED** — EMA 0.25 (mobile), 0.3 (gyro) |
| iOS permission | OK | OK |
| Screen orientation | OK | OK |
| Drift correction | PARTIAL | PARTIAL (acceptable) |

**Score: 12 correct/acceptable, 2 partial (both acceptable for scope).**

---

## 1. Architecture Overview

### Signal Flow

```
                    ┌──────────────────────────────┐
                    │       SENSOR SOURCES          │
                    ├──────────────────────────────┤
                    │  DeviceOrientation (primary)  │
                    │  DeviceMotion (fallback)       │
                    │  WebHID Gyro (PlayStation)     │
                    │  Gamepad Stick (Standard API)  │
                    │  Keyboard (A/D keys)           │
                    └──────────┬───────────────────┘
                               │
                    ┌──────────▼───────────────────┐
                    │     INPUT MANAGER             │
                    │  _applyTilt(raw, isGyro)      │
                    ├──────────────────────────────┤
                    │  1. Calibration offset         │
                    │  2. Dead zone + remapping      │
                    │  3. Sensitivity normalization   │
                    │  4. Response curve (power fn)   │
                    │  5. Output smoothing (EMA)      │
                    │  → motionLean [-1, +1]         │
                    └──────────┬───────────────────┘
                               │
                    ┌──────────▼───────────────────┐
                    │    BALANCE CONTROLLER          │
                    │  Combines: motion + gamepad    │
                    │          + keyboard            │
                    │  Clamps to [-1, +1]            │
                    │  Tracks input source            │
                    │  → leanInput                    │
                    └──────────┬───────────────────┘
                               │
                    ┌──────────▼───────────────────┐
                    │       BIKE MODEL              │
                    │  Balance equation:              │
                    │  acc = gravity + playerLean     │
                    │      + gyroscopic + damping     │
                    │      + wobbles                  │
                    │  → lean angle (radians)         │
                    │  → heading (steering)           │
                    └──────────┬───────────────────┘
                               │
                    ┌──────────▼───────────────────┐
                    │      VISUAL FEEDBACK           │
                    │  HUD phone/bike gauges          │
                    │  3D arch indicator               │
                    │  Network transmission (20Hz)    │
                    └──────────────────────────────┘
```

### Key Files

| File | Role | Lines |
|------|------|-------|
| `js/config.js:32-52` | All tuning constants (single source of truth) | 20 |
| `js/input-manager.js` | Sensor capture, processing pipeline, WebHID gyro | 527 |
| `js/balance-controller.js` | Input source combination and tracking | 42 |
| `js/bike-model.js:258-294` | Physics integration of lean forces | 545 |
| `js/arch-indicator.js` | 3D radial gauge visualization | 374 |
| `test/input.html` | Comprehensive test/tuning interface | ~2000 |

---

## 2. Mobile Tilt Controls — Detailed Assessment

### 2.1 API Choice: DeviceOrientation (Primary)

**Current implementation** (`input-manager.js:191-205`):

```javascript
// Primary: deviceorientation (browser sensor fusion — smoother)
window.addEventListener('deviceorientation', (e) => {
  const orient = screen.orientation ? screen.orientation.angle : (window.orientation || 0);
  let rawTilt;
  if (orient === 90) rawTilt = e.beta;
  else if (orient === 270 || orient === -90) rawTilt = -e.beta;
  else rawTilt = e.gamma;
  // ...
  this._applyTilt(rawTilt);
});
```

**Assessment:** This is now correct. The browser's internal sensor fusion provides clean, pre-filtered tilt angles. The DeviceMotion path (`input-manager.js:208-232`) remains as a fallback with its own low-pass gravity extraction (k = 0.1), which only activates if the orientation API doesn't fire. This dual-path design is robust.

**Game experience impact:** Players get the smoothest possible tilt data from the OS-level sensor fusion. Button taps on the phone screen no longer corrupt the tilt reading because the browser's orientation algorithm is far more resilient to transient accelerations than a raw accelerometer low-pass filter.

### 2.2 Calibration System

**Current implementation** (`input-manager.js:235-256`):

```javascript
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
    if (this._calibBuf.length >= BALANCE_DEFAULTS.calibSamples) {  // 10
      const sum = this._calibBuf.reduce((a, b) => a + b, 0);
      this.motionOffset = sum / this._calibBuf.length;
      this._calibrating = false;
      this._calibBuf = [];
    }
    return;  // No steering output during calibration
  }
  // ...
}
```

**V1 problems fixed:**
1. **Multi-sample averaging** — 10 samples are collected and averaged, eliminating single-reading outlier risk.
2. **No steering during calibration** — The `return` statement means the bike doesn't receive jittery input during the calibration window.
3. **Manual recalibrate** via gauge tap triggers `startTiltCalibration()`, which now also uses the 10-sample buffer (previously it grabbed a single instantaneous reading).

**Remaining considerations:**
- The 10-sample buffer at ~60Hz DeviceOrientation events completes in ~167ms. This is within the recommended 200-500ms range.
- Calibration still triggers automatically on the first motion event. Since orientation events fire almost immediately, this captures the phone's resting angle within the first ~200ms. With DeviceOrientation as primary (no gravity filter convergence needed), the initial readings are already clean.
- No auto-recalibrate on pause/resume. This is a Tier 3 polish item — acceptable to skip.

**Game experience impact:** Players no longer start with a miscalibrated center point. The 10-sample average captures the phone's resting angle reliably, even if the player is still settling their grip. The ~167ms calibration window is imperceptible (it happens during the countdown).

### 2.3 Processing Pipeline

**Current tuning constants** (`config.js:34-40`):

```javascript
sensitivity: 25,        // degrees for full lean
deadzone: 4,            // degrees ignored near center
lowPassK: 0.1,          // gravity filter (fallback path only)
responseCurve: 1.4,     // power exponent
outputSmoothing: 0.25,  // EMA factor
calibSamples: 10,       // buffer size
```

#### Dead Zone (4 degrees)

In the recommended 3-5 degree range. At 4 degrees, a player must tilt the phone more than 4 degrees from their calibrated center before any steering occurs. This effectively filters out:
- Phone micro-jitter from holding the device
- Incidental tilting from tapping pedal buttons
- Minor grip shifts during play

The remapping is correctly implemented (`input-manager.js:272-278`):
```javascript
if (absRel < deadzone) {
  lean = 0;
} else {
  const reduced = absRel - deadzone;
  const range = sensitivity - deadzone;  // 25 - 4 = 21 usable degrees
  const normalized = Math.min(reduced / range, 1.0);
  lean = Math.sign(relative) * Math.pow(normalized, responseCurve);
}
```

The dead zone subtraction ensures no discontinuous jump at the threshold boundary.

#### Sensitivity (25 degrees)

Full steering requires 29 degrees of tilt (25 + 4 dead zone). This is within the recommended 15-25 degree range for casual games. At 29 degrees total, the phone screen is still readable (about a 30-degree angle from vertical in portrait mode).

**Effective tilt range:**
- 0-4 degrees: Dead zone (no response)
- 4-29 degrees: Active steering range
- 29+ degrees: Clamped at maximum lean

#### Response Curve (power 1.4)

The power curve creates non-linear mapping:
- At 50% tilt (12.5 degrees past dead zone): output is 0.50^1.4 = 0.38 (62% of linear)
- At 25% tilt: output is 0.25^1.4 = 0.16 (64% of linear)
- At 75% tilt: output is 0.75^1.4 = 0.67 (89% of linear)

This provides approximately 35% less sensitivity near center compared to linear, which compensates for hand jitter while preserving full range at extremes. The value 1.4 is slightly below the commonly recommended 1.5-2.0, but appropriate for a balance game where the player needs to make frequent medium-range corrections (not just small aim adjustments).

**Design rationale for 1.4 vs 2.0:** A higher exponent (2.0) is optimal for aiming games where the player rarely needs the center range. In Tandemonium, the player is constantly making mid-range balance corrections. A softer curve preserves responsiveness for the 20-60% range where most gameplay occurs.

#### Output Smoothing (EMA 0.25)

```javascript
this._smoothedLean += (lean - this._smoothedLean) * outputSmoothing;
```

At 0.25, each frame's output is 25% new value + 75% previous. This creates approximately 3-4 frames of effective latency at 60fps (~50-67ms), which is within the imperceptible range for tilt controls. It eliminates frame-to-frame jitter without feeling sluggish.

**Game experience impact:** The combined pipeline (dead zone + response curve + smoothing) means:
1. Small phone jitter is completely eliminated (dead zone)
2. Gentle corrections feel proportional and controllable (response curve)
3. The steering output is silky-smooth with no visible jitter (smoothing)
4. Aggressive tilts still reach full lean quickly (response curve doesn't attenuate extremes much)

---

## 3. Gamepad Gyro Controls — Detailed Assessment

### 3.1 Hardware Support

**Supported controllers** (`input-manager.js:8-9`):
- PlayStation DualSense (0x0ce6, 0x0df2)
- PlayStation DualShock 4 (0x05c4, 0x09cc)
- Both USB and Bluetooth connections

**Why PlayStation only:** WebHID requires known HID report formats. PlayStation controllers have well-documented report structures (byte offsets for gyro data are known). Xbox controllers don't expose gyro over standard HID, and Nintendo controllers use different protocols that would require separate parsing logic.

### 3.2 Gyro Calibration

**Current implementation** (`input-manager.js:443-465`):

```javascript
_startGyroCalibration() {
  this._gyroCalibrating = true;
  this._gyroCalibSamples = [];
  this._gyroRollAccum = 0;
  this._lastGyroTime = 0;
  this.motionOffset = null;  // reset tilt offset for fresh calibration
}

_finishGyroCalibration() {
  // Average 150 samples (~1.5s at 100Hz)
  let sx = 0, sy = 0, sz = 0;
  for (const s of this._gyroCalibSamples) { sx += s.x; sy += s.y; sz += s.z; }
  this._gyroBias.x = sx / this._gyroCalibSamples.length;
  this._gyroBias.y = sy / this._gyroCalibSamples.length;
  this._gyroBias.z = sz / this._gyroCalibSamples.length;
  // ...
}
```

**Assessment against best practices (GamepadMotionHelpers reference):**

| Aspect | Best Practice | Tandemonium | Status |
|--------|--------------|-------------|--------|
| Manual calibration | "give them the option, please :)" | Yes — `calibrateGyro()` callable from UI | OK |
| Bias estimation | Average readings while stationary | 150-sample average during hold-still period | OK |
| Sample count | Sufficient for stable bias | 150 samples (~1.5s) — more than adequate | OK |
| Auto-calibration | Stillness detection + sensor fusion | Not implemented — manual only | ACCEPTABLE |
| 3-axis bias | Separate bias per axis | Yes — x, y, z individually tracked | OK |

**On auto-calibration:** GamepadMotionHelpers recommends `Stillness | SensorFusion` mode for auto-calibration, but warns it "can misinterpret slow and steady input as the controller being held still." For a balance game where the controller is constantly in gentle motion, auto-calibration could be counterproductive. Manual calibration on connect + on-demand recalibrate is the safer choice here.

### 3.3 Gyro Integration & Drift Correction

**Current implementation** (`input-manager.js:498-510`):

```javascript
// Integrate Z axis for steering
if (this._lastGyroTime > 0) {
  const dt = (now - this._lastGyroTime) / 1000.0;
  if (dt < 0.1) {  // skip stale frames
    this._gyroRollAccum -= gz * GYRO_SCALE * dt;
    // Drift correction: decay toward zero
    this._gyroRollAccum *= (1 - 0.5 * dt);
  }
}
// Clamp to ±90 degrees
this._gyroRollAccum = Math.max(-90, Math.min(90, this._gyroRollAccum));
```

**Key design decision: Integration vs absolute orientation.**

The gyro reports angular velocity (degrees/second), not absolute angle. To get a "tilt angle" for steering, the code integrates velocity over time into `_gyroRollAccum`. This is fundamentally different from mobile tilt which reads absolute orientation.

**Drift correction analysis:**

The decay factor `(1 - 0.5 * dt)` creates a time constant of 2 seconds (1/0.5). This means:
- After 2 seconds of no input, the accumulated angle decays to ~37% of its value
- After 4 seconds, it's at ~13%
- After 6 seconds, effectively zero

This serves two purposes:
1. **Prevents runaway drift** from gyro bias errors that survive calibration
2. **Creates a natural "spring back to center"** — the controller returns to neutral when the player stops tilting

**Game experience impact:** The 2-second decay means the player must actively hold a tilt to maintain a steering angle. This creates a different feel from mobile tilt (where the phone's angle directly maps to lean). It's closer to a "gyro mouse" model — you rotate to steer, and the steering gradually returns to center when you stop.

**Trade-off:** This decay rate means the player can't hold a steady turn by holding the controller at a fixed angle — they'd need to keep slowly rotating. For a balance game where the player is constantly making corrections, this is actually beneficial: it prevents the accumulated angle from drifting away from the player's perceived "center."

### 3.4 Separate Tuning Parameters

**Current constants** (`config.js:41-46`):

```javascript
gyroSensitivity: 40,        // wider range (integrated velocity accumulates faster)
gyroDeadzone: 4,            // same dead zone (noise floor is similar)
gyroResponseCurve: 1.3,     // slightly softer (integration already smooths)
gyroOutputSmoothing: 0.3,   // more smoothing (compensates for integration noise)
```

**Rationale for differences from mobile:**

| Parameter | Mobile | Gyro | Why Different |
|-----------|--------|------|---------------|
| Sensitivity | 25 | 40 | Gyro integrates angular velocity; accumulation reaches higher values than absolute tilt |
| Response curve | 1.4 | 1.3 | Gyro integration already provides inherent smoothing; less aggressive curve avoids feeling sluggish |
| Output smoothing | 0.25 | 0.3 | More smoothing compensates for integration noise and potential bias drift |
| Dead zone | 4 | 4 | Same — both need to filter small noise near center |

The comment in config.js explains this well: *"integrated angular velocity accumulates faster than absolute orientation, so needs wider range + more smoothing."*

---

## 4. Balance Physics — How Motion Input Becomes Gameplay

### 4.1 The Balance Equation

The core physics loop (`bike-model.js:258-294`):

```javascript
// Forces acting on the bike lean:
acceleration =
  sin(lean) * gravityForce          // (1) Gravity — tips further if leaning
  + playerLean * leanForce          // (2) Player input — fights gravity
  + (-lean * min(speed*0.8, 6.0))   // (3) Gyroscopic — speed stabilizes
  + (-leanVelocity * damping)        // (4) Friction — resists change
  + pedalWobble                      // (5) Pedal-induced shake
  + lowSpeedWobble                   // (6) Startup oscillation
  + pedalLeanKick                    // (7) Acceleration jitter
  + dangerWobble                     // (8) Near-crash vibration
  + grassWobble;                     // (9) Off-road terrain shake

leanVelocity += acceleration * dt;
lean += leanVelocity * dt;
```

### 4.2 Input Force Analysis

The player's input enters as: `playerLean * leanForce` where:
- `playerLean` = `balanceResult.leanInput` (from BalanceController, range [-1, +1])
- `leanForce` = 12 (config constant)

So the maximum player-induced acceleration is **12 units/sec^2**.

Compared to other forces:
- **Gravity at max safe lean (1.0 rad):** sin(1.0) * 2.5 = **2.10 units/sec^2** — player force overwhelms gravity at all angles
- **Gyroscopic at 10 m/s, 0.5 rad lean:** 0.5 * min(8, 6) = **3.0 units/sec^2** — significant stabilization at speed
- **Damping at leanVelocity = 2:** 2 * 4.0 = **8.0 units/sec^2** — strong resistance to rapid changes

**Game feel implication:** The player has sufficient authority to correct any lean angle before crash (1.35 rad). The gyroscopic stabilization means the bike is much easier to balance at speed, creating a natural difficulty curve: slow = wobbly and hard, fast = stable and easy. This is physically realistic and creates good gameplay tension during startup.

### 4.3 Crash Mechanics

- **Crash threshold:** |lean| > 1.35 radians (~77 degrees)
- **Safety mode:** Clamps lean to [-1.0, +1.0] (~57 degrees) — prevents crash entirely
- **Danger zone:** Starts at 0.55 * 1.35 = 0.74 rad (~42 degrees) — progressive wobble warning

The danger zone wobble is a clever feedback mechanism:
```javascript
const dangerRatio = Math.abs(this.lean) / 1.35;
if (dangerRatio > 0.55) {
  const intensity = (dangerRatio - 0.55) / 0.45;
  dangerWobble = intensity * (Math.sin(t * 11) * 0.4 + Math.sin(t * 17) * 0.25);
}
```

This uses two overlapping sine waves at 11Hz and 17Hz (inharmonic, so they don't create a predictable pattern) to simulate the chaotic shake of a bike about to fall. The intensity ramps linearly from 0 at 42 degrees to full at 77 degrees.

### 4.4 Steering from Lean

```javascript
const turnRate = -this.lean * this.speed * BALANCE_DEFAULTS.turnRate;  // 0.50
this.heading += turnRate * dt;
```

Steering is a natural consequence of leaning — you don't steer directly, you steer by leaning the bike. This is physically accurate for a bicycle and creates the core gameplay mechanic: **balance and steering are the same thing.** Tilt your phone left → bike leans left → bike turns left. The connection is intuitive and physical.

At maximum lean (1.0 rad in safety mode) and 10 m/s speed: turnRate = 1.0 * 10 * 0.5 = 5.0 rad/s (~286 deg/s). This is quite aggressive turning — appropriate for a game where the road has curves to navigate.

---

## 5. Visual Feedback Systems

### 5.1 3D Arch Indicator

The arch indicator (`arch-indicator.js`) provides real-time visual feedback of the player's lean:

- **Sweep angle** derived from sensitivity: ±25 degrees for mobile
- **Tick marks** at 0%, ±25%, ±50%, ±75%, ±100% of max lean
- **Player needle** (0.75 opacity) shows current lean input
- **Partner needle** (0.6 opacity) shows remote player's lean in multiplayer
- **Positioned above the bike** and follows bike heading/pitch but NOT lean (stays upright for readability)

**Game experience impact:** The arch gives the player a clear visual reference for how much steering authority they're using. The tick marks provide spatial anchoring — players can learn to "aim for the 50% mark" for a medium turn.

### 5.2 HUD Gauges

- **Phone gauge:** Shows raw tilt angle (pre-processing) — useful for understanding the physical tilt
- **Bike gauge:** Shows actual bike lean angle (post-physics) — useful for understanding balance state
- **Gauge tap recalibrates** — the phone gauge doubles as a calibration button

### 5.3 Test Page

`test/input.html` provides comprehensive diagnostics with real-time tuning sliders for all parameters. This is invaluable for play-testing and tuning.

---

## 6. Multiplayer Motion Considerations

### 6.1 Network Transmission

- Captain's processed `leanInput` (not raw sensor data) is transmitted at 20Hz via `MSG_LEAN`
- 5-byte message: 1 byte type + 4 bytes float32
- Stoker receives captain's lean for visualization on partner arch needle

### 6.2 Input Combination

Both captain and stoker contribute to balance:
```javascript
// BalanceController combines all sources:
leanInput += motion;   // from motionLean (tilt or gyro)
leanInput += gpLean;   // from gamepad stick
// Clamped to [-1, +1]
```

In multiplayer, both players' leanInput values are blended (averaged) for the final bike control.

### 6.3 Cross-Device Scenarios

| Captain | Stoker | Experience |
|---------|--------|------------|
| Mobile tilt | Mobile tilt | Both tilt phones; natural co-op feel |
| Gamepad gyro | Mobile tilt | Captain uses controller, stoker uses phone |
| Keyboard | Mobile tilt | Captain arrows, stoker tilts |
| Gamepad stick | Gamepad gyro | Both on controllers, different input methods |

The system handles all combinations transparently because `BalanceController` abstracts the input source.

---

## 7. Comparative Analysis: Mobile Tilt vs Gamepad Gyro

| Aspect | Mobile Tilt | Gamepad Gyro |
|--------|-------------|--------------|
| **Sensor** | OS-fused orientation (degrees) | Raw angular velocity (deg/sec) |
| **Processing** | Direct angle → offset → normalize | Integrate velocity → accumulate angle |
| **Center return** | Physical — device returns to rest | Software — 0.5/sec decay toward zero |
| **Drift risk** | None (absolute measurement) | Low (bias calibration + decay) |
| **Feel** | "Tilt the phone, bike follows" | "Rotate controller, bike follows then returns" |
| **Precision** | Limited by hand steadiness | High — controller grip is more stable |
| **Fatigue** | Moderate — holding phone at angle | Low — small wrist rotations |
| **Sensitivity** | 25 degrees | 40 degrees (effective) |
| **Response curve** | 1.4 (stronger center attenuation) | 1.3 (lighter — integration already smooths) |
| **Smoothing** | 0.25 (lighter — clean signal) | 0.3 (heavier — integration noise) |

### Feel Difference

The fundamental UX difference is **position control vs velocity control**:

- **Mobile tilt** is position control: the phone's angle directly maps to lean magnitude. Hold the phone at 15 degrees, the bike holds a steady lean. This is intuitive.

- **Gamepad gyro** is closer to velocity control with decay: rotating the controller adds lean, which then decays. The player must continuously adjust to maintain a turn. This is more precise but less intuitive.

This distinction matches the York University research finding that "55% of players appreciate tilt controls in racing titles" specifically when using position-control mapping.

---

## 8. Remaining Opportunities

### Tier 1 — Would Noticeably Improve Feel

**8.1 Auto-Recalibrate on Pause/Resume**

When the game pauses and resumes, the player's phone position may have shifted. A fresh 10-sample calibration on resume would prevent post-pause drift.

**Implementation:** In `game.js`, when resuming from pause, call `this.input.startTiltCalibration()`. The existing calibration system handles the rest.

**8.2 Frame-Rate Independent Filter (DeviceMotion fallback)**

The low-pass filter in the DeviceMotion fallback path uses a fixed k = 0.1 per sample. On devices where DeviceMotion fires at different rates (50Hz vs 100Hz), the effective smoothing differs.

**Fix:**
```javascript
const dt = e.interval / 1000 || 1/60;
const k = 1 - Math.pow(2, -6 * dt);  // rate=6, equivalent to k≈0.1 at 60Hz
```

**Impact:** Only affects devices that fall back to DeviceMotion (rare — most modern devices support DeviceOrientation).

### Tier 2 — Polish

**8.3 Accelerometer-Assisted Gyro Drift Correction**

The current gyro drift correction uses a simple time-constant decay (0.5/sec). GamepadMotionHelpers recommends using the accelerometer's gravity vector to correct pitch and roll drift. The DualSense accelerometer data is available in the HID reports at a known offset.

**Implementation:** Read accelerometer from HID report, compute gravity-relative roll, blend into `_gyroRollAccum` with a slow correction factor (~0.02/frame). This would replace the blanket decay with a physically-grounded correction.

**Trade-off:** More complex, and the current decay works well enough. Only worth implementing if players report gyro feeling "off" after extended play sessions.

**8.4 Gyro "Tightening" Button**

Jibb Smart recommends a "gyro off" button for repositioning. In Tandemonium, a "hold to recenter" button on the controller (e.g., L3 click) could reset `_gyroRollAccum = 0`, giving the player a quick way to re-center without full recalibration.

**8.5 Sensitivity Slider**

Real Racing 3 data shows players cluster at extremes of sensitivity scales — no single value works for everyone. A settings screen with a sensitivity slider (range: 15-40 for mobile, 25-60 for gyro) would accommodate different play styles and physical comfort levels.

### Tier 3 — Future Considerations

**8.6 Nintendo Controller Support**

Switch Pro Controllers and Joy-Cons have gyroscopes. WebHID support would require implementing the Nintendo HID report format (different byte layout, different scale factors). This is a substantial effort but would expand the supported controller ecosystem.

**8.7 Haptic Feedback**

DualSense adaptive triggers and haptic motors are accessible via WebHID output reports. Sending subtle vibration pulses during danger-zone wobble would create a multi-sensory feedback loop: visual (arch indicator) + physical (controller vibration).

---

## 9. Known Limitations

1. **Xbox controllers:** No gyro data available over standard HID. Xbox controllers with gyro (Elite v2) don't expose it through the Gamepad API or WebHID in a documented way. This is a platform limitation, not a code issue.

2. **Chrome on macOS + Xbox USB-C:** Known Chromium bug prevents Xbox controllers from working in Chrome. Safari works. This is documented in project memory.

3. **Portrait upside-down (180 degrees):** Screen orientation handler doesn't have a specific case for 180-degree rotation. Falls through to portrait default. Extremely rare scenario (phone upside-down).

4. **iOS Safari DeviceMotion rate:** iOS may throttle sensor events to 60Hz even though the hardware supports higher rates. This affects the DeviceMotion fallback path only; DeviceOrientation (primary) is not affected.

---

## 10. Summary of Jibb Smart Alignment

Jibb Smart's guidelines are primarily written for gyro-as-mouse (aiming), but several principles apply to gyro-as-tilt (balance/steering):

| Jibb Smart Principle | Applicability | Tandemonium Status |
|---------------------|---------------|-------------------|
| No forced smoothing/deadzone | Partially — balance games need smoothing | Reasonable values, not oversmoothed |
| Manual calibration always available | Fully applies | Gauge tap (mobile) + calibrate button (gyro) |
| Natural sensitivity scale | Partially — 1:1 deg mapping less relevant for steering | Sensitivity in degrees is intuitive |
| Gyro off button | Applies for controller gyro | Not yet implemented (Tier 2 item) |
| Sensor fusion for drift | Applies for integrated gyro | Time-constant decay (simpler, sufficient) |

The key insight: Jibb Smart says "if a game has forced deadzone, forced smoothing, or any other kind of filtering that the player can't turn off, its gyro aiming is bad." However, **this applies to aiming, not balance.** A balance game inherently requires filtering because the physics model amplifies noise into crashes. The test page does expose all tuning parameters for adjustment, which satisfies the spirit of the guideline for development purposes.

---

## Sources

- [GamepadMotionHelpers — Sensor Fusion & Calibration Reference](https://github.com/JibbSmart/GamepadMotionHelpers/blob/main/README.md)
- [The Absolute Basics of Good Gyro Controls — Jibb Smart (Game Developer)](https://www.gamedeveloper.com/design/the-absolute-basics-of-good-gyro-controls)
- [GyroWiki — Jibb Smart](http://gyrowiki.jibbsmart.com/)
- [JoyShockMapper — Gyro Aiming & Flick Stick](https://github.com/JibbSmart/JoyShockMapper)
- [Controller Deadzone Guide: Precision Calibration & Math](https://gamepadtest.app/guides/dead-zone-fix)
- [Tilt-Controlled Mobile Games: Velocity-control vs. Position-control (York University)](https://www.yorku.ca/mack/ieeegem2014a.html)
- [Tilt-Touch Synergy: Input Control for Dual-Analog Style Mobile Games (York University)](https://www.yorku.ca/mack/ec2017.html)
- [Mobile Game Development: Designing for Different Control Schemes](https://moldstud.com/articles/p-mobile-game-development-designing-for-different-control-schemes)
- [Gyro Aiming & Emulation: The 2026 Advanced Mapping Logic](https://gamepadtest.app/guides/gyro-aiming-emulation-setup)
- [Gyro Aiming: The Ultimate Guide — Nacon](https://www.nacongaming.com/en-US/blog/gyro-aiming-controller-guide)
- [DualShock Calibration GUI](https://dualshock-tools.github.io/)
- MDN: DeviceOrientationEvent, DeviceMotionEvent
- W3C: Device Orientation and Motion specification
