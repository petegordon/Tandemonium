// ============================================================
// SHARED PEDAL CONTROLLER (multiplayer)
// Offset-aware two-foot tracking: captain + stoker coordinate
// opposite feet on a shared crank (180° offset)
// ============================================================

export class SharedPedalController {
  constructor() {
    this.pedalPower = 0;
    this.crankAngle = 0;
    this.wasCorrect = false;
    this.wasWrong = false;
    this.wasBrake = false;
    this.wasInPhase = false;
    this._pendingTaps = [];

    // Per-player tracking
    this.captainLastFoot = null;
    this.captainLastTime = 0;
    this.stokerLastFoot = null;
    this.stokerLastTime = 0;

    // Running offset quality score (0-1)
    this.offsetScore = 0.5;
  }

  receiveTap(source, foot) {
    this._pendingTaps.push({ source, foot, time: performance.now() / 1000 });
  }

  update(dt) {
    let acceleration = 0;
    let wobble = 0;

    // Only reset flags when there are new taps (so they persist while held)
    if (this._pendingTaps.length > 0) {
      this.wasCorrect = false;
      this.wasWrong = false;
      this.wasBrake = false;
      this.wasInPhase = false;
    }

    // Check for simultaneous same-foot taps (within 100ms) = crank fight
    if (this._pendingTaps.length >= 2) {
      const t0 = this._pendingTaps[0];
      const t1 = this._pendingTaps[1];
      if (Math.abs(t0.time - t1.time) < 0.1 &&
          t0.source !== t1.source &&
          t0.foot === t1.foot) {
        this.wasBrake = true;
        this.pedalPower *= 0.9;
        this.offsetScore = Math.max(0, this.offsetScore - 0.15);
        this._updatePlayerState(t0);
        this._updatePlayerState(t1);
        this._pendingTaps = [];
        return { acceleration: 0, wobble: 0.8, braking: true, crankAngle: this.crankAngle };
      }
    }

    // Process taps one at a time
    while (this._pendingTaps.length > 0) {
      const tap = this._pendingTaps.shift();
      const playerLastFoot = tap.source === 'captain' ? this.captainLastFoot : this.stokerLastFoot;
      const otherLastFoot = tap.source === 'captain' ? this.stokerLastFoot : this.captainLastFoot;
      const gap = tap.time - (tap.source === 'captain' ? this.captainLastTime : this.stokerLastTime);

      if (playerLastFoot === tap.foot) {
        // Repeated own foot — wrong foot penalty
        this.wasWrong = true;
        this.pedalPower = Math.max(this.pedalPower - 0.15, 0);
        this.offsetScore = Math.max(0, this.offsetScore - 0.1);
        acceleration += 0.06;
        wobble += 0.5;
      } else if (otherLastFoot !== null && tap.foot === otherLastFoot) {
        // Same foot as other player — in-phase (poor offset)
        this.wasInPhase = true;
        this.offsetScore = Math.max(0, this.offsetScore - 0.08);
        const cadence = gap < 0.8 ? (0.8 - gap) * 0.3 : 0;
        this.pedalPower = Math.min(this.pedalPower + 0.1 + cadence * 0.5, 1.0);
        acceleration += 0.15 + 0.3 * this.pedalPower;
        wobble += 0.2;
      } else {
        // Opposite foot — perfect offset!
        this.wasCorrect = true;
        this.offsetScore = Math.min(1, this.offsetScore + 0.1);
        const cadence = gap < 0.8 ? (0.8 - gap) * 0.4 : 0;
        const offsetBonus = this.offsetScore * 0.15;
        this.pedalPower = Math.min(this.pedalPower + 0.2 + cadence, 1.0);
        acceleration += 0.35 + 0.6 * this.pedalPower + offsetBonus;
      }

      this._updatePlayerState(tap);
      this.crankAngle += Math.PI / 2;
    }

    // Decay
    this.pedalPower *= (1 - 0.4 * dt);
    this.offsetScore *= (1 - 0.05 * dt);

    return { acceleration, wobble, braking: false, crankAngle: this.crankAngle };
  }

  _updatePlayerState(tap) {
    if (tap.source === 'captain') {
      this.captainLastFoot = tap.foot;
      this.captainLastTime = tap.time;
    } else {
      this.stokerLastFoot = tap.foot;
      this.stokerLastTime = tap.time;
    }
  }
}
