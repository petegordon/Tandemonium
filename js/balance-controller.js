// ============================================================
// BALANCE CONTROLLER
// ============================================================

export class BalanceController {
  constructor(input) {
    this.input = input;
    this.steerFrames = { keyboard: 0, gamepad: 0, motion: 0, 'gamepad-gyro': 0 };
  }

  update() {
    let leanInput = 0;
    if (this.input.isPressed('KeyA')) { leanInput -= 1; this.steerFrames.keyboard++; }
    if (this.input.isPressed('KeyD')) { leanInput += 1; this.steerFrames.keyboard++; }
    const motion = this.input.getMotionLean();
    if (motion !== 0) {
      leanInput += motion;
      if (this.input.gyroConnected) {
        this.steerFrames['gamepad-gyro']++;
      } else {
        this.steerFrames.motion++;
      }
    }
    const gpLean = this.input.getGamepadLean();
    if (gpLean !== 0) { leanInput += gpLean; this.steerFrames.gamepad++; }
    leanInput = Math.max(-1, Math.min(1, leanInput));
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
