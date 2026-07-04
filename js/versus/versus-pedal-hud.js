// ============================================================
// VERSUS PEDAL HUD — per-team pedal buttons + rhythm arrows
// Mirrors the singleton HUD's pedal visualization (identical CSS classes),
// scoped to one split-screen half:
//   * big buttons (pressed/wrong/brake/idle-pulse/tap-flash) = CAPTAIN's foot
//   * purple ▲▼ arrows (flash/flash-wrong)                    = STOKER's foot
// so the two riders on a duo team can watch each other and alternate. A SOLO
// team has no stoker, so its arrows are hidden entirely (like the arch's
// stoker needle). One instance per rig.
// ============================================================

export class VersusPedalHud {
  constructor(barEl, hasStoker) {
    this.left = barEl.querySelector('.vp-left');
    this.right = barEl.querySelector('.vp-right');
    this.arrowUp = barEl.querySelector('.vp-arrow-up');
    this.arrowDown = barEl.querySelector('.vp-arrow-down');
    this.hasStoker = !!hasStoker;

    // Solo team: no stoker → no arrows (inline overrides the mode-versus flex).
    this.arrowUp.style.display = this.hasStoker ? '' : 'none';
    this.arrowDown.style.display = this.hasStoker ? '' : 'none';

    // Captain button tap-flash
    this._flashTimer = 0;
    this._flashEl = null;
    this._flashWrong = false;
    this._prevCorrect = false;
    this._prevWrong = false;

    // Stoker arrow flash
    this._arrowTimer = 0;
    this._arrowEl = null;
    this._arrowWrong = false;
    this._prevStoLeft = false;
    this._prevStoRight = false;
    this._prevStoFoot = null;
  }

  /**
   * @param {boolean} capLeft  captain pressing the left pedal
   * @param {boolean} capRight captain pressing the right pedal
   * @param {boolean} stoLeft  stoker pressing the left pedal (duo only)
   * @param {boolean} stoRight stoker pressing the right pedal (duo only)
   * @param {{wasBrake:boolean,wasWrong:boolean,wasCorrect:boolean}} pedalCtrl
   * @param {number} speed bike speed (for the idle pulse)
   * @param {number} dt
   */
  update(capLeft, capRight, stoLeft, stoRight, pedalCtrl, speed, dt) {
    // ── Captain → big buttons ──
    const brake = (capLeft && capRight) || !!pedalCtrl.wasBrake;
    this.left.classList.toggle('brake', brake);
    this.right.classList.toggle('brake', brake);
    this.left.classList.toggle('pressed', !brake && capLeft && !pedalCtrl.wasWrong);
    this.right.classList.toggle('pressed', !brake && capRight && !pedalCtrl.wasWrong);
    this.left.classList.toggle('wrong', !brake && capLeft && !!pedalCtrl.wasWrong);
    this.right.classList.toggle('wrong', !brake && capRight && !!pedalCtrl.wasWrong);

    const isIdle = speed < 0.3 && !capLeft && !capRight;
    this.left.classList.toggle('idle-pulse', isIdle);
    this.right.classList.toggle('idle-pulse', isIdle);

    // Captain tap-flash: team stroke while the captain is actually holding
    // (the gate that stops a stoker tap from phantom-flashing the button).
    const newCorrect = pedalCtrl.wasCorrect && !this._prevCorrect;
    const newWrong = pedalCtrl.wasWrong && !this._prevWrong;
    this._prevCorrect = !!pedalCtrl.wasCorrect;
    this._prevWrong = !!pedalCtrl.wasWrong;
    if ((newCorrect || newWrong) && (capLeft || capRight)) {
      this._flashTimer = 0.2;
      this._flashEl = capLeft ? this.left : this.right;
      this._flashWrong = newWrong;
    }
    if (this._flashTimer > 0) {
      this._flashTimer -= dt;
      if (this._flashEl) this._flashEl.classList.add(this._flashWrong ? 'tap-flash-wrong' : 'tap-flash');
      if (this._flashTimer <= 0) {
        this.left.classList.remove('tap-flash', 'tap-flash-wrong');
        this.right.classList.remove('tap-flash', 'tap-flash-wrong');
      }
    }

    // ── Stoker → arrows (duo only) ──
    if (!this.hasStoker) return;
    const leftEdge = stoLeft && !this._prevStoLeft;
    const rightEdge = stoRight && !this._prevStoRight;
    this._prevStoLeft = stoLeft;
    this._prevStoRight = stoRight;
    if (leftEdge || rightEdge) {
      const foot = leftEdge ? 'left' : 'right';
      const wrong = this._prevStoFoot === foot; // stoker repeated their own foot
      this._prevStoFoot = foot;
      this._arrowTimer = 0.3;
      this._arrowEl = leftEdge ? this.arrowUp : this.arrowDown;
      this._arrowWrong = wrong;
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
