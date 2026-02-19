// ============================================================
// PEDAL CONTROLLER (solo mode)
// ============================================================

export class PedalController {
  constructor(input) {
    this.input = input;
    this.lastPedal = null;
    this.pedalPower = 0;
    this.crankAngle = 0;
    this.prevLeft = false;
    this.prevRight = false;
    this.lastPedalTime = 0;
    this.wasCorrect = false;
    this.wasWrong = false;
  }

  update(dt) {
    const now = performance.now() / 1000;
    const leftHeld = this.input.isPressed('ArrowUp');
    const rightHeld = this.input.isPressed('ArrowDown');
    const leftJust = leftHeld && !this.prevLeft;
    const rightJust = rightHeld && !this.prevRight;
    const braking = leftHeld && rightHeld;

    let acceleration = 0;
    let wobble = 0;
    this.wasCorrect = false;
    this.wasWrong = false;

    if (braking) {
      this.pedalPower *= 0.95;
      this.prevLeft = leftHeld;
      this.prevRight = rightHeld;
      return { acceleration: 0, wobble: 0, braking: true, crankAngle: this.crankAngle };
    }

    if (leftJust) {
      const gap = now - this.lastPedalTime;
      if (this.lastPedal !== 'left') {
        this.wasCorrect = true;
        const cadence = gap < 0.8 ? (0.8 - gap) * 0.4 : 0;
        this.pedalPower = Math.min(this.pedalPower + 0.2 + cadence, 1.0);
        acceleration = 0.35 + 0.6 * this.pedalPower;
      } else {
        this.wasWrong = true;
        this.pedalPower = Math.max(this.pedalPower - 0.15, 0);
        acceleration = 0.06;
        wobble = 0.5;
      }
      this.lastPedal = 'left';
      this.lastPedalTime = now;
      this.crankAngle += Math.PI / 2;
    }

    if (rightJust) {
      const gap = now - this.lastPedalTime;
      if (this.lastPedal !== 'right') {
        this.wasCorrect = true;
        const cadence = gap < 0.8 ? (0.8 - gap) * 0.4 : 0;
        this.pedalPower = Math.min(this.pedalPower + 0.2 + cadence, 1.0);
        acceleration = 0.35 + 0.6 * this.pedalPower;
      } else {
        this.wasWrong = true;
        this.pedalPower = Math.max(this.pedalPower - 0.15, 0);
        acceleration = 0.06;
        wobble = 0.5;
      }
      this.lastPedal = 'right';
      this.lastPedalTime = now;
      this.crankAngle += Math.PI / 2;
    }

    this.pedalPower *= (1 - 0.4 * dt);
    this.prevLeft = leftHeld;
    this.prevRight = rightHeld;

    return { acceleration, wobble, braking: false, crankAngle: this.crankAngle };
  }
}
