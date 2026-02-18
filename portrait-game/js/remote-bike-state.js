// ============================================================
// REMOTE BIKE STATE — interpolation buffer for stoker
// Receives state at 20Hz, interpolates for 60fps rendering
// ============================================================

export class RemoteBikeState {
  constructor() {
    this.prev = null;
    this.curr = null;
    this.receiveTime = 0;
    this.interpDuration = 0.05; // 50ms default, adapts to jitter
    this._lastReceiveDelta = 0.05;
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

    const lerp = (a, b, t) => a + (b - a) * t;
    return {
      x: lerp(this.prev.x, this.curr.x, t),
      y: lerp(this.prev.y, this.curr.y, t),
      z: lerp(this.prev.z, this.curr.z, t),
      heading: lerp(this.prev.heading, this.curr.heading, t),
      lean: lerp(this.prev.lean, this.curr.lean, t),
      leanVelocity: lerp(this.prev.leanVelocity, this.curr.leanVelocity, t),
      speed: lerp(this.prev.speed, this.curr.speed, t),
      crankAngle: lerp(this.prev.crankAngle, this.curr.crankAngle, t),
      distanceTraveled: lerp(this.prev.distanceTraveled, this.curr.distanceTraveled, t),
      flags: this.curr.flags
    };
  }
}
