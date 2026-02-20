// ============================================================
// BALANCE CONTROLLER
// ============================================================

export class BalanceController {
  constructor(input) {
    this.input = input;
  }

  update() {
    let leanInput = 0;
    if (this.input.isPressed('KeyA')) leanInput -= 1;
    if (this.input.isPressed('KeyD')) leanInput += 1;
    const motion = this.input.getMotionLean();
    if (motion !== 0) leanInput += motion;
    const gpLean = this.input.getGamepadLean();
    if (gpLean !== 0) leanInput += gpLean;
    leanInput = Math.max(-1, Math.min(1, leanInput));
    return { leanInput };
  }
}
