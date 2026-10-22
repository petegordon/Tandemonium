// ============================================================
// CRANK MOTION (pure) — a smooth, circular crank from pedal taps (#441)
// ============================================================
//
// The pedal controllers add a quarter turn to crankAngle for each stroke. The
// crank used to chase that target in ~80 ms and then stop dead until the next
// press: a tick, not a turn. And while coasting it spun ahead on its own, so the
// next press snapped it BACKWARDS to the controller's angle.
//
// Now the crank has its own angular velocity. Each stroke both adds a quarter
// turn to the goal and updates the cadence (quarter turns per second, from the
// gap between strokes). Between strokes the crank keeps turning at the cadence,
// and may run a little ahead of the goal, expecting the next stroke. If that
// stroke doesn't come, it eases to a stop. The faster the riders pedal, the
// faster it spins. A press still pulls it forward at once, so it still follows
// the buttons. Velocity changes are eased, so the motion never jerks.

const QUARTER = Math.PI / 2;
const LEAD = QUARTER * 0.9;    // how far the crank may run ahead of the strokes
const PHASE = 0.6;             // share of a stroke shown at once, so it reads in sync with the press
const CATCH_UP = 7;            // rad/s of extra spin per radian off the smooth path
const EASE = 10;               // 1/s: how fast the spin rate follows the wanted rate
const MAX_OMEGA = 40;          // rad/s, a ~6 rev/s blur
const MAX_GAP = 1.2;           // s: a slower stroke than this is a fresh start, not a cadence
const COAST_AFTER = 1.5;       // s without a stroke: turn with the wheels instead

export class CrankMotion {
  constructor() { this.reset(0); }

  /** Start over at `angle` (a new ride). The display never jumps. */
  reset(angle = 0) {
    this.angle = angle;      // what is drawn
    this.goal = angle;       // where the strokes say it should be
    this._from = angle;      // where the smooth path starts for the latest stroke
    this._raw = 0;           // last crankAngle seen from the controller (they start at 0)
    this.omega = 0;          // rad/s, current spin
    this.cadence = 0;        // rad/s, from the strokes
    this._lastStrokeAt = -Infinity;
  }

  /**
   * @param {number} raw         the pedal controller's crankAngle
   * @param {number} dt          seconds this frame
   * @param {number} now         seconds (any clock, only differences matter)
   * @param {number} coastOmega  rad/s to turn at while coasting (from road speed)
   * @returns {number} the angle to draw
   */
  update(raw, dt, now, coastOmega = 0) {
    if (!(dt > 0)) return this.angle;
    raw = raw || 0;
    if (raw < this._raw - 1e-6) {
      // The controller was reset (new ride, respawn): keep the crank where it
      // is and stop it there, rather than spinning it backwards.
      this._raw = raw;
      this.goal = this.angle;
      this.omega = 0;
      this.cadence = 0;
      this._lastStrokeAt = -Infinity;
    } else if (raw > this._raw + QUARTER * 2.5) {
      // A jump of several strokes at once is a resync (an online partner's
      // crank arriving mid-ride), not pedaling: take the new angle, don't spin.
      this._raw = raw;
    } else if (raw > this._raw + 1e-6) {
      const delta = raw - this._raw;
      this._raw = raw;
      const gap = now - this._lastStrokeAt;
      const rate = gap > 0 && gap < MAX_GAP ? delta / gap : 0;
      this.cadence = this.cadence > 0 && rate > 0 ? this.cadence * 0.4 + rate * 0.6 : rate;
      this.cadence = Math.min(this.cadence, MAX_OMEGA);
      this._lastStrokeAt = now;
      // A press after coasting starts from where the crank is now.
      const base = Math.max(this.goal, this.angle - LEAD);
      this._from = base + delta * PHASE;
      this.goal = base + delta;
    }

    const since = now - this._lastStrokeAt;
    let want;
    if (since > COAST_AFTER) {
      // Coasting: turn with the wheels.
      this.cadence = 0;
      want = Math.max(0, coastOmega);
      this.goal = this.angle;
    } else {
      // Follow the smooth path the cadence predicts: from part-way into the
      // latest stroke, turning at the cadence, through the next stroke's due
      // time to at most LEAD past the goal. Chasing the stroke goal itself pulses the spin every press.
      // No cadence yet (the first stroke): the path is the goal itself.
      const cap = this.goal + LEAD;
      const path = this.cadence > 0 ? Math.min(cap, this._from + this.cadence * since) : this.goal;
      const onPath = this.cadence > 0 && path < cap;
      // Off the end of the path (the next stroke is late): ease to a stop at it.
      want = (onPath ? this.cadence : 0) + CATCH_UP * (path - this.angle);
    }
    want = Math.min(MAX_OMEGA, want);

    this.omega += (want - this.omega) * Math.min(1, EASE * dt);
    let next = this.angle + Math.max(0, this.omega) * dt;
    if (since <= COAST_AFTER) next = Math.min(next, this.goal + LEAD);
    this.angle = Math.max(this.angle, next);   // the crank only ever turns forwards
    return this.angle;
  }
}
