// ============================================================
// REMOTE BIKE STATE — jitter buffer + extrapolation for the stoker
// Receives the captain's state at ~30Hz, renders it smoothly at 60fps
// ============================================================
//
// The stoker runs no physics: it draws the captain's bike (and the chase
// camera follows it), so any hitch here is a hitch of the whole screen.
// The old two-sample lerp froze whenever a packet was late and skipped when
// packets bunched (issue #390). Instead:
//
//   • Every STATE carries the captain's send time. Snapshots are kept in a
//     short buffer on the SENDER's clock, and we render a moment in the past
//     (renderTime = now − clockOffset − playoutDelay), interpolating between
//     the two snapshots that bracket it. Late or bunched arrivals just fill
//     the buffer — the rendered timeline stays even.
//   • The playout delay adapts to measured jitter (40–200ms), and changes
//     are slewed (≤5% playback-rate change) so it never visibly time-warps.
//   • If the buffer runs dry (a real stall), we extrapolate forward from the
//     newest snapshot along its velocity for up to 250ms, then hold.
//   • Stale / duplicate packets (the fast data channel is unordered) are
//     dropped by send time.
//
// Legacy senders without a send time fall back to arrival time, which still
// buffers but can't separate network jitter from send jitter.

function lerp(a, b, t) { return a + (b - a) * t; }

const MAX_SNAPSHOTS = 32;
const BUFFER_SPAN = 1.0;        // s of sender time kept behind renderTime
const MIN_DELAY = 0.04;         // s
const MAX_DELAY = 0.2;          // s
const INITIAL_DELAY = 0.08;     // s
const MAX_SLEW = 0.05;          // max |d(delay)/dt| → playback rate 0.95–1.05x
const MAX_EXTRAPOLATE = 0.25;   // s past the newest snapshot before holding
const TELEPORT_DIST_SQ = 20 * 20; // m² — larger jumps are resets, not motion
const ROADD_WRAP = 50;          // m — larger roadD steps are loop wraps / resets
const CLOCK_RESET_MS = 5000;    // sender clock jumped (captain reloaded) → start over

export class RemoteBikeState {
  constructor() {
    this._buf = [];              // snapshots, ascending by .t (sender clock, s)
    this._lastSenderMs = null;   // raw u32 of the newest accepted send time
    this._lastSenderT = 0;       // unwrapped sender time of the newest snapshot (s)
    this._offset = null;         // local − sender clock (s), lower-envelope estimate
    this._jitter = 0.01;         // s, arrival lateness above the envelope
    this._gap = 1 / 30;          // s, smoothed send interval
    this._delay = INITIAL_DELAY; // s, current playout delay
    this._lastSampleAt = 0;      // local s of the previous getInterpolated()

    // Reusable result object (avoid per-frame allocation)
    this._interpState = {
      x: 0, y: 0, z: 0, heading: 0, lean: 0, leanVelocity: 0,
      speed: 0, crankAngle: 0, distanceTraveled: 0, roadD: 0, flags: 0
    };
  }

  /** Current playout delay in ms (for diagnostics). */
  get delayMs() { return this._delay * 1000; }

  reset() {
    this._buf.length = 0;
    this._lastSenderMs = null;
    this._offset = null;
    this._jitter = 0.01;
    this._gap = 1 / 30;
    this._delay = INITIAL_DELAY;
  }

  /**
   * Drop buffered snapshots on a ride reset, keeping the sender-clock
   * high-water mark and clock estimates. The captain sends nothing during the
   * countdown, so without this the stoker's first frame back in play would
   * replay the pre-reset crash (fallen) snapshots — which trips the stoker's
   * "fallen → upright" game-over backup and strands it on game over while the
   * captain rides on. Keeping _lastSenderMs means a late pre-reset packet
   * (possible on the unordered fast channel) is still rejected as stale.
   */
  flush() {
    this._buf.length = 0;
  }

  /** Buffer a received STATE. Returns false if it was stale/duplicate and dropped. */
  pushState(state) {
    const now = performance.now() / 1000;

    // Sender time → unwrapped seconds, dropping stale/duplicate packets.
    let t;
    if (state.sendTime !== undefined) {
      if (this._lastSenderMs === null) {
        t = state.sendTime / 1000;
      } else {
        const diffMs = (state.sendTime - this._lastSenderMs) | 0; // signed, wrap-safe
        if (diffMs <= 0 && diffMs > -CLOCK_RESET_MS) return false; // late or duplicate
        if (diffMs <= -CLOCK_RESET_MS || diffMs > CLOCK_RESET_MS) {
          this.reset();                                          // captain's clock restarted
          t = state.sendTime / 1000;
        } else {
          t = this._lastSenderT + diffMs / 1000;
        }
      }
      this._lastSenderMs = state.sendTime;
    } else {
      t = now; // legacy sender: arrival time is all we have
      if (this._buf.length && t <= this._lastSenderT) return false;
    }

    if (this._buf.length) {
      const gap = t - this._lastSenderT;
      if (gap > 0 && gap < 0.5) this._gap += (gap - this._gap) * 0.1;
    }
    this._lastSenderT = t;

    // Clock offset: follow the lower envelope of (arrival − send). New minima
    // are taken at once; otherwise creep up slowly to track clock drift.
    const d = now - t;
    if (this._offset === null || d < this._offset) {
      this._offset = d;
    } else {
      this._offset += (d - this._offset) * 0.005;
    }
    // Jitter: how late above the envelope packets arrive. Rise fast, decay slow.
    const late = d - this._offset;
    this._jitter += (late - this._jitter) * (late > this._jitter ? 0.25 : 0.01);

    state.t = t;
    this._buf.push(state);
    if (this._buf.length > MAX_SNAPSHOTS) this._buf.shift();
    return true;
  }

  getInterpolated() {
    const buf = this._buf;
    if (!buf.length) return null;
    const now = performance.now() / 1000;

    // Ease the playout delay toward its target without time-warping.
    const target = Math.max(MIN_DELAY, Math.min(MAX_DELAY,
      this._gap * 1.5 + this._jitter * 2 + 0.01));
    const frameDt = this._lastSampleAt ? Math.min(0.1, now - this._lastSampleAt) : 0;
    this._lastSampleAt = now;
    const maxStep = MAX_SLEW * frameDt;
    this._delay += Math.max(-maxStep, Math.min(maxStep, target - this._delay));

    const renderT = now - this._offset - this._delay;

    // Drop snapshots we'll never need again (keep one before renderT).
    while (buf.length > 2 && buf[1].t < renderT - BUFFER_SPAN) buf.shift();

    const s = this._interpState;
    const newest = buf[buf.length - 1];

    if (renderT <= buf[0].t) {
      this._copy(s, buf[0]);
      return s;
    }

    if (renderT >= newest.t) {
      this._extrapolate(s, renderT - newest.t);
      return s;
    }

    // Bracketing pair: a.t <= renderT < b.t
    let i = buf.length - 2;
    while (i > 0 && buf[i].t > renderT) i--;
    const a = buf[i], b = buf[i + 1];
    const u = (renderT - a.t) / (b.t - a.t);

    const dx = b.x - a.x, dz = b.z - a.z;
    if (dx * dx + dz * dz > TELEPORT_DIST_SQ) {
      this._copy(s, u < 0.5 ? a : b); // respawn/reset — don't sweep across it
      return s;
    }

    s.x = lerp(a.x, b.x, u);
    s.y = lerp(a.y, b.y, u);
    s.z = lerp(a.z, b.z, u);
    s.heading = lerp(a.heading, b.heading, u);
    s.lean = lerp(a.lean, b.lean, u);
    s.leanVelocity = lerp(a.leanVelocity, b.leanVelocity, u);
    s.speed = lerp(a.speed, b.speed, u);
    s.crankAngle = u < 0.5 ? a.crankAngle : b.crankAngle; // quarter-turn steps
    s.distanceTraveled = lerp(a.distanceTraveled, b.distanceTraveled, u);
    s.roadD = Math.abs(b.roadD - a.roadD) > ROADD_WRAP ? b.roadD : lerp(a.roadD, b.roadD, u);
    s.flags = a.flags;
    return s;
  }

  // Buffer ran dry: carry the newest snapshot forward along its motion.
  _extrapolate(s, ahead) {
    const buf = this._buf;
    const n = buf[buf.length - 1];
    this._copy(s, n);
    if (buf.length < 2 || (n.flags & 1)) return; // no velocity yet, or fallen — hold
    const p = buf[buf.length - 2];
    const span = n.t - p.t;
    if (span <= 0) return;
    const dx = n.x - p.x, dz = n.z - p.z;
    if (dx * dx + dz * dz > TELEPORT_DIST_SQ) return;

    const e = Math.min(ahead, MAX_EXTRAPOLATE);
    const k = e / span;
    s.x = n.x + dx * k;
    s.y = n.y + (n.y - p.y) * k;
    s.z = n.z + dz * k;
    s.heading = n.heading + (n.heading - p.heading) * k;
    const adv = Math.max(0, n.speed) * e;
    s.distanceTraveled = n.distanceTraveled + adv;
    s.roadD = n.roadD + adv; // applyRemoteState wraps roadD into the loop
  }

  _copy(s, src) {
    s.x = src.x; s.y = src.y; s.z = src.z;
    s.heading = src.heading;
    s.lean = src.lean;
    s.leanVelocity = src.leanVelocity;
    s.speed = src.speed;
    s.crankAngle = src.crankAngle;
    s.distanceTraveled = src.distanceTraveled;
    s.roadD = src.roadD;
    s.flags = src.flags;
  }
}
