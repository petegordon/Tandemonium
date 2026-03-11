// ============================================================
// REMOTE BIKE STATE — interpolation buffer for stoker
// Receives state at 20Hz, interpolates for 60fps rendering
// ============================================================

function lerp(a, b, t) { return a + (b - a) * t; }

export class RemoteBikeState {
  constructor() {
    this.prev = null;
    this.curr = null;
    this.receiveTime = 0;
    this.interpDuration = 0.05; // 50ms default, adapts to jitter
    this._lastReceiveDelta = 0.05;

    // Reusable result object (avoid per-frame allocation)
    this._interpState = {
      x: 0, y: 0, z: 0, heading: 0, lean: 0, leanVelocity: 0,
      speed: 0, crankAngle: 0, distanceTraveled: 0, roadD: 0, flags: 0
    };
  }

  pushState(state) {
    this.prev = this.curr;
    this.curr = state;
    const now = performance.now() / 1000;
    if (this.prev) {
      this._lastReceiveDelta = now - this.receiveTime;
      // Adaptive interpolation: clamp between 30-100ms
      this.interpDuration = Math.max(0.03, Math.min(0.1, this._lastReceiveDelta));
    }
    this.receiveTime = now;
  }

  getInterpolated() {
    if (!this.curr) return null;
    if (!this.prev) return this.curr;

    const now = performance.now() / 1000;
    const elapsed = now - this.receiveTime;
    const t = Math.min(1, elapsed / this.interpDuration);

    const s = this._interpState;
    s.x = lerp(this.prev.x, this.curr.x, t);
    s.y = lerp(this.prev.y, this.curr.y, t);
    s.z = lerp(this.prev.z, this.curr.z, t);
    s.heading = lerp(this.prev.heading, this.curr.heading, t);
    s.lean = lerp(this.prev.lean, this.curr.lean, t);
    s.leanVelocity = lerp(this.prev.leanVelocity, this.curr.leanVelocity, t);
    s.speed = lerp(this.prev.speed, this.curr.speed, t);
    s.crankAngle = lerp(this.prev.crankAngle, this.curr.crankAngle, t);
    s.distanceTraveled = lerp(this.prev.distanceTraveled, this.curr.distanceTraveled, t);
    s.roadD = lerp(this.prev.roadD, this.curr.roadD, t);
    s.flags = this.curr.flags;
    return s;
  }
}
