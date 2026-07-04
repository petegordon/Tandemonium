// ============================================================
// VERSUS PEDAL HUD — per-team pedal buttons + rhythm arrows
// Mirrors the singleton HUD's pedal visualization (identical CSS classes:
// pressed / wrong / brake / idle-pulse / tap-flash on the buttons, and
// flash / flash-wrong on the purple ▲▼ arrows), scoped to one split-screen
// half and driven by that team's own pedal state. One instance per rig.
// ============================================================

export class VersusPedalHud {
  constructor(barEl) {
    this.left = barEl.querySelector('.vp-left');
    this.right = barEl.querySelector('.vp-right');
    this.arrowUp = barEl.querySelector('.vp-arrow-up');
    this.arrowDown = barEl.querySelector('.vp-arrow-down');

    this._flashTimer = 0;
    this._flashEl = null;
    this._flashWrong = false;
    this._prevCorrect = false;
    this._prevWrong = false;

    this._arrowTimer = 0;
    this._arrowEl = null;
    this._arrowWrong = false;
  }

  /**
   * @param {boolean} leftHeld  any team member pressing the left pedal
   * @param {boolean} rightHeld any team member pressing the right pedal
   * @param {{wasBrake:boolean,wasWrong:boolean,wasCorrect:boolean}} pedalCtrl
   * @param {number} speed bike speed (for the idle pulse)
   * @param {number} dt
   */
  update(leftHeld, rightHeld, pedalCtrl, speed, dt) {
    const brake = (leftHeld && rightHeld) || !!pedalCtrl.wasBrake;

    // Big-button states — same classes the singleton HUD uses.
    this.left.classList.toggle('brake', brake);
    this.right.classList.toggle('brake', brake);
    this.left.classList.toggle('pressed', !brake && leftHeld && !pedalCtrl.wasWrong);
    this.right.classList.toggle('pressed', !brake && rightHeld && !pedalCtrl.wasWrong);
    this.left.classList.toggle('wrong', !brake && leftHeld && !!pedalCtrl.wasWrong);
    this.right.classList.toggle('wrong', !brake && rightHeld && !!pedalCtrl.wasWrong);

    const isIdle = speed < 0.3 && !leftHeld && !rightHeld;
    this.left.classList.toggle('idle-pulse', isIdle);
    this.right.classList.toggle('idle-pulse', isIdle);

    // New-stroke edge (gated on a pedal actually being held this frame, so a
    // duo teammate's tap doesn't phantom-flash the other foot — same guard as
    // the HUD). Up arrow = left foot, down arrow = right foot.
    const newCorrect = pedalCtrl.wasCorrect && !this._prevCorrect;
    const newWrong = pedalCtrl.wasWrong && !this._prevWrong;
    this._prevCorrect = !!pedalCtrl.wasCorrect;
    this._prevWrong = !!pedalCtrl.wasWrong;
    if ((newCorrect || newWrong) && (leftHeld || rightHeld)) {
      this._flashTimer = 0.2;
      this._flashEl = leftHeld ? this.left : this.right;
      this._flashWrong = newWrong;
      this._arrowTimer = 0.3;
      this._arrowEl = leftHeld ? this.arrowUp : this.arrowDown;
      this._arrowWrong = newWrong;
    }

    if (this._flashTimer > 0) {
      this._flashTimer -= dt;
      if (this._flashEl) this._flashEl.classList.add(this._flashWrong ? 'tap-flash-wrong' : 'tap-flash');
      if (this._flashTimer <= 0) {
        this.left.classList.remove('tap-flash', 'tap-flash-wrong');
        this.right.classList.remove('tap-flash', 'tap-flash-wrong');
      }
    }

    if (this._arrowTimer > 0) {
      this._arrowTimer -= dt;
      if (this._arrowEl) this._arrowEl.classList.add(this._arrowWrong ? 'flash-wrong' : 'flash');
      if (this._arrowTimer <= 0) {
        this.arrowUp.classList.remove('flash', 'flash-wrong');
        this.arrowDown.classList.remove('flash', 'flash-wrong');
      }
    }
  }

  /** Clear all state classes (e.g. leaving versus). */
  clear() {
    for (const el of [this.left, this.right]) {
      el.classList.remove('brake', 'pressed', 'wrong', 'idle-pulse', 'tap-flash', 'tap-flash-wrong');
    }
    this.arrowUp.classList.remove('flash', 'flash-wrong');
    this.arrowDown.classList.remove('flash', 'flash-wrong');
    this._flashTimer = 0;
    this._arrowTimer = 0;
  }
}
