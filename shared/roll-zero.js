// ============================================================
// ROLL ZERO — what counts as level for this controller, as it is held (#112)
// ============================================================
//
// SensorFusion's gravity roll cannot drift, but a consumer still needs a zero:
// the roll that means "no lean" for this player's grip. Each consumer used to
// keep its own, and took it at a moment it chose (a race countdown), when the
// controller was often tilted and moving. A zero taken then is wrong for the
// whole ride and reads as a permanent lean ("pulls to one side and sticks",
// Tandemonium #365).
//
// RollZero keeps that zero next to the roll it belongs to:
//
//   - set(): take the zero now. The result says whether the controller was
//     still, so a zero taken mid-motion is never silent.
//   - request(): take the zero at the next still moment instead of now. If no
//     still moment comes before the timeout, it either uses the steadiest
//     window it saw (and says it was not still) or keeps the old zero.
//   - relative(roll): roll minus the zero, wrapped to (-π, π].
//
// Roll only. Pitch and yaw have no zero here: gravity roll is the one axis
// that is drift-free with no heading reference, and it is what tilt steering
// reads. A pitch zero can follow the same shape when a consumer needs one.
//
// Still means: over the last WINDOW_MS the roll stayed within STILL_SPREAD_RAD.
// The check reads a roll (not the raw gyro), so it needs no unit scales and
// works the same on every controller.
//
// Two rolls come in with each sample. `roll` is the one consumers steer by
// (SensorFusion's gravity roll). `restRoll` is the roll the accelerometer
// alone reports. They agree once the fusion has settled, but after a fusion
// reset the gravity roll takes seconds to come back to the real pose, and for
// part of that time it barely moves: judged by itself it would look still and
// give a zero that is wrong by the whole tilt. So stillness is judged on
// `restRoll`, and a zero taken at rest IS the rest roll: at rest the
// accelerometer measures down directly. A zero taken while moving cannot use
// it (a moving hand adds its own acceleration) and uses `roll`.
//
// Deliberately THREE-free and clock-free (like gravity-roll.js): the caller
// passes the roll and the time, so the core test job runs it with no install.
// ============================================================

/** How much of the recent past a still check looks at. */
export const ROLL_ZERO_WINDOW_MS = 400;
/** Fewest samples in the window before it can count as still. */
export const ROLL_ZERO_MIN_SAMPLES = 8;
/** The roll may move this much (max minus min) inside the window and still be still: 1.5 degrees. */
export const ROLL_ZERO_STILL_SPREAD_RAD = 1.5 * Math.PI / 180;
/** How long request() waits for a still moment by default. */
export const ROLL_ZERO_DEFAULT_TIMEOUT_MS = 3000;

const TWO_PI = Math.PI * 2;

/** Wrap an angle to (-π, π]. */
export function wrapAngle(a) {
  a = a % TWO_PI;
  if (a > Math.PI) a -= TWO_PI;
  else if (a <= -Math.PI) a += TWO_PI;
  return a;
}

/**
 * @typedef {object} RollZeroResult
 * @property {number|null} zero     the zero now in force, radians (null: none)
 * @property {boolean} changed      whether this call or request moved the zero
 * @property {boolean} still        whether the controller was still when it was taken
 * @property {number|null} spread   how far the roll moved in the window it was taken from, radians (null: no samples;
 *   Infinity: the accelerometer could not be trusted in that window)
 * @property {'now'|'given'|'still'|'best'|'kept'|'cleared'} source
 *   now: set() took it at once. given: setTo() was handed it. still: request() found a still moment.
 *   best: request() timed out and used its steadiest window. kept: request()
 *   timed out and left the zero as it was. cleared: clear().
 * @property {number} at            the time it was decided (the caller's clock, ms)
 */

export class RollZero {
  /**
   * @param {object} [opts]
   * @param {number} [opts.windowMs]
   * @param {number} [opts.minSamples]
   * @param {number} [opts.stillSpreadRad]
   */
  constructor(opts = {}) {
    this.windowMs = opts.windowMs ?? ROLL_ZERO_WINDOW_MS;
    this.minSamples = opts.minSamples ?? ROLL_ZERO_MIN_SAMPLES;
    this.stillSpreadRad = opts.stillSpreadRad ?? ROLL_ZERO_STILL_SPREAD_RAD;

    /** The zero in force, radians. null until one is taken. @type {number|null} */
    this.zero = null;
    /** How the zero in force was taken. @type {RollZeroResult|null} */
    this.last = null;
    /** Called with a RollZeroResult whenever a set, request or clear is decided. @type {((r: RollZeroResult) => void)|null} */
    this.onResult = null;

    /** @type {{roll: number, rest: number, t: number}[]} */
    this._samples = [];
    this._lastRoll = 0;
    this._lastT = 0;
    this._hasSample = false;
    /** @type {{deadline: number, fallback: 'best'|'keep', started: boolean, timeoutMs: number, best: {mean: number, spread: number}|null}|null} */
    this._pending = null;
  }

  /** Whether a request() is still waiting for a still moment. */
  get pending() { return !!this._pending; }

  /**
   * Feed the current roll. Call once per IMU sample (SensorFusion does this).
   * @param {number} rollRad  gravity roll, radians
   * @param {number} nowMs    the caller's clock
   * @param {number} [restRollRad]  the accelerometer's own roll, radians. NaN
   *   when it cannot be trusted right now (not near 1g): the window then cannot
   *   be still. Defaults to rollRad for a caller with one roll only.
   * @returns {RollZeroResult|null} a result if a pending request was decided by this sample
   */
  sample(rollRad, nowMs, restRollRad = rollRad) {
    if (!Number.isFinite(rollRad) || !Number.isFinite(nowMs)) return null;
    // the clock went backwards (a reconnect, a new time base): start the window again
    if (this._hasSample && nowMs < this._lastT) this._samples.length = 0;
    this._samples.push({ roll: rollRad, rest: restRollRad, t: nowMs });
    const from = nowMs - this.windowMs;
    while (this._samples.length && this._samples[0].t < from) this._samples.shift();
    this._lastRoll = rollRad;
    this._lastT = nowMs;
    this._hasSample = true;

    const p = this._pending;
    if (!p) return null;
    if (!p.started) { p.started = true; p.deadline = nowMs + p.timeoutMs; }
    const w = this._window();
    if (w && w.full) {
      if (w.spread <= this.stillSpreadRad) return this._decide(w.rest, true, w.spread, 'still', nowMs);
      if (!p.best || w.rollSpread < p.best.spread) p.best = { mean: w.mean, spread: w.rollSpread };
    }
    if (nowMs >= p.deadline) {
      if (p.fallback === 'best' && p.best) return this._decide(p.best.mean, false, p.best.spread, 'best', nowMs);
      return this._decide(this.zero, false, p.best ? p.best.spread : (w ? w.rollSpread : null), 'kept', nowMs);
    }
    return null;
  }

  /**
   * Whether the controller is still right now: the window is full and the roll
   * stayed within the spread.
   */
  get still() {
    const w = this._window();
    return !!w && w.full && w.spread <= this.stillSpreadRad;
  }

  /**
   * Take the zero now, from the roll as it is (the rest roll's mean over the
   * window when the controller is still, else the latest roll). Cancels a
   * pending request.
   * The result's `still` says whether it was taken at rest.
   * @param {number} [nowMs] defaults to the last sample's time
   * @returns {RollZeroResult}
   */
  set(nowMs = this._lastT) {
    const w = this._window();
    const still = !!w && w.full && w.spread <= this.stillSpreadRad;
    const value = still ? w.rest : (this._hasSample ? this._lastRoll : 0);
    return this._decide(value, still, w ? (still ? w.spread : w.rollSpread) : null, 'now', nowMs);
  }

  /**
   * Set the zero to a given roll (a stored one, or one a consumer measured).
   * @param {number} rollRad @param {number} [nowMs]
   * @returns {RollZeroResult}
   */
  setTo(rollRad, nowMs = this._lastT) {
    return this._decide(wrapAngle(rollRad), true, null, 'given', nowMs);
  }

  /**
   * Take the zero at the next still moment. Until then the old zero stays in
   * force. Decided inside sample(); listen on onResult or poll `pending`.
   * A second request replaces the first.
   * @param {object} [opts]
   * @param {number} [opts.timeoutMs]  how long to wait, counted from the next sample
   * @param {'best'|'keep'} [opts.fallback]  when no still moment came: use the
   *   steadiest window seen (best, the default), or keep the old zero (keep)
   */
  request(opts = {}) {
    const timeoutMs = Math.max(0, opts.timeoutMs ?? ROLL_ZERO_DEFAULT_TIMEOUT_MS);
    this._pending = { deadline: 0, fallback: opts.fallback === 'keep' ? 'keep' : 'best', started: false, timeoutMs, best: null };
  }

  /** Drop a pending request; the zero stays as it is. */
  cancelRequest() { this._pending = null; }

  /**
   * Forget the zero (relative() then returns the roll unchanged) and any pending request.
   * @param {number} [nowMs] @returns {RollZeroResult}
   */
  clear(nowMs = this._lastT) {
    return this._decide(null, false, null, 'cleared', nowMs);
  }

  /**
   * Forget the recent samples, keeping the zero and any pending request. Call
   * when the roll is about to jump for a reason that is not the player (the
   * fusion was reset and gravity is converging again).
   */
  resetWindow() {
    this._samples.length = 0;
    this._hasSample = false;
  }

  /**
   * The roll measured from the zero, wrapped to (-π, π]. With no zero, the roll itself.
   * @param {number} [rollRad] defaults to the latest sample
   */
  relative(rollRad = this._lastRoll) {
    return this.zero == null ? wrapAngle(rollRad) : wrapAngle(rollRad - this.zero);
  }

  /**
   * The window's numbers. mean / rollSpread: of the steering roll. rest /
   * spread: of the rest roll (spread is Infinity when any sample had none, so
   * such a window is never still).
   * @returns {{mean: number, rollSpread: number, rest: number, spread: number, full: boolean}|null}
   */
  _window() {
    const s = this._samples;
    if (!s.length) return null;
    // Unwrap around the first sample so a window that straddles ±π is not read as a full turn.
    const ref = s[0].roll, restRef = s[0].rest;
    let min = Infinity, max = -Infinity, sum = 0;
    let rMin = Infinity, rMax = -Infinity, rSum = 0, restOk = Number.isFinite(restRef);
    for (const x of s) {
      const d = wrapAngle(x.roll - ref);
      if (d < min) min = d;
      if (d > max) max = d;
      sum += d;
      if (!Number.isFinite(x.rest)) restOk = false;
      if (restOk) {
        const r = wrapAngle(x.rest - restRef);
        if (r < rMin) rMin = r;
        if (r > rMax) rMax = r;
        rSum += r;
      }
    }
    const span = s[s.length - 1].t - s[0].t;
    // full: enough samples, and they cover most of the window (not a burst at its end)
    const full = s.length >= this.minSamples && span >= this.windowMs * 0.75;
    return {
      mean: wrapAngle(ref + sum / s.length), rollSpread: max - min,
      rest: restOk ? wrapAngle(restRef + rSum / s.length) : NaN, spread: restOk ? rMax - rMin : Infinity, full,
    };
  }

  /** @returns {RollZeroResult} */
  _decide(value, still, spread, source, nowMs) {
    const changed = value !== this.zero;
    this.zero = value;
    this._pending = null;
    /** @type {RollZeroResult} */
    const result = { zero: value, changed, still, spread, source, at: nowMs };
    if (source !== 'kept') this.last = result;
    if (this.onResult) { try { this.onResult(result); } catch (e) { /* a listener's error is not ours */ } }
    return result;
  }
}
