// ============================================================
// BALANCE CONTROLLER
// ============================================================

export class BalanceController {
  constructor(input) {
    this.input = input;
    this.steerFrames = { keyboard: 0, gamepad: 0, motion: 0, 'gamepad-gyro': 0 };
  }

  computeAutoSteer(bike) {
    if (!bike || !bike.roadPath) return 0;

    // Look-ahead: steer toward where the road is heading
    const lookAheadD = bike.roadD + bike.speed * 0.5;
    const ahead = bike.roadPath.getPointAtDistance(lookAheadD);
    const headingDiff = ahead.heading - bike.heading;
    // Normalize to [-PI, PI]
    let hDiff = headingDiff;
    if (hDiff > Math.PI) hDiff -= 2 * Math.PI;
    if (hDiff < -Math.PI) hDiff += 2 * Math.PI;

    // Lateral offset correction: steer toward road center
    const lateralCorrection = -bike._lateralOffset * 0.3;

    // Combine heading alignment and lateral correction
    const autoLean = Math.max(-1, Math.min(1, hDiff * 2.0 + lateralCorrection));
    return autoLean;
  }

  update(bike = null, assistWeight = 0) {
    let leanInput = 0;
    if (this.input.isPressed('KeyA')) { leanInput -= 1; this.steerFrames.keyboard++; }
    if (this.input.isPressed('KeyD')) { leanInput += 1; this.steerFrames.keyboard++; }
    const motion = this.input.getMotionLean();
    if (motion !== 0) {
      leanInput += motion;
      // Only count as intentional input above noise floor (avoids laptop sensor drift)
      if (Math.abs(motion) > 0.01) {
        if (this.input.gyroConnected) {
          this.steerFrames['gamepad-gyro']++;
        } else {
          this.steerFrames.motion++;
        }
      }
    }
    const gpLean = this.input.getGamepadLean();
    if (gpLean !== 0) { leanInput += gpLean; this.steerFrames.gamepad++; }
    leanInput = Math.max(-1, Math.min(1, leanInput));

    // Blend with auto-steer if assist is active
    if (assistWeight > 0 && bike) {
      const autoLean = this.computeAutoSteer(bike);
      leanInput = autoLean * assistWeight + leanInput * (1 - assistWeight);
      leanInput = Math.max(-1, Math.min(1, leanInput));
    }

    return { leanInput };
  }

  getSteerSource() {
    let best = 'none';
    let max = 0;
    for (const [key, count] of Object.entries(this.steerFrames)) {
      if (count > max) { max = count; best = key; }
    }
    return best;
  }

  resetSteerFrames() {
    this.steerFrames = { keyboard: 0, gamepad: 0, motion: 0, 'gamepad-gyro': 0 };
  }
}
