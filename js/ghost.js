// ============================================================
// GHOST (pure) — the rider you were yesterday
// ============================================================
//
// D-4. A best time is a number; a ghost is an opponent. Mario Kart has done
// this since 1992 for the same reason it works here: the fastest way to teach
// somebody a road is to show them a better line down it, and the cheapest
// possible multiplayer is a recording.
//
// Two sources, both local:
//   - your own personal best on this level (B-3 already stores the time; this
//     stores the line);
//   - your partner's last run on Today's Road, so you can chase each other
//     without both being free at the same moment.
//
// This module holds only the recording and the interpolation. The mesh, the
// scene and the frame loop live in game.js — nothing here imports three or
// touches the DOM, so all of it is tested.

/**
 * Samples per second.
 *
 * The plan said 10 Hz and estimated 14 KB per track; the real cost at 10 Hz is
 * ~50 KB of JSON for a long ride, which is a lot to keep in localStorage next
 * to everything else. At 5 Hz a bike travelling 8 m/s moves 1.6 m between
 * samples, and linear interpolation across that is invisible on a translucent
 * ghost — so this is 5 Hz, and a long ride costs about 25 KB.
 */
export const SAMPLE_HZ = 5;

/** Longest ride we keep. */
export const MAX_SECONDS = 360;

/**
 * Fields per sample: road distance, lateral offset, lean.
 *
 * The timestamp is NOT stored — samples are taken at a fixed interval, so
 * sample i happens at i/hz seconds. That is a quarter of the storage for free.
 * A six-minute ride is 3,600 samples ≈ 43 KB in memory and, once rounded to
 * two decimals for JSON, roughly 25-30 KB in localStorage. A typical Grandma's
 * ride is a third of that. records.js keeps tracks only for the newest few
 * bests and drops them first when the store gets large.
 */
export const STRIDE = 3;

/**
 * Records a ride into a flat Float32Array. Flat because this is written every
 * frame of every ride and read every frame of the next one: an array of
 * objects would allocate 3,600 of them per ride.
 */
export class GhostRecorder {
  constructor({ hz = SAMPLE_HZ, maxSeconds = MAX_SECONDS } = {}) {
    this.hz = hz;
    this.interval = 1 / hz;
    this.capacity = Math.ceil(maxSeconds * hz) * STRIDE;
    this.data = new Float32Array(this.capacity);
    this.count = 0;
    this.elapsed = 0;
    this._nextSampleAt = 0;
  }

  /** Feed one frame. Returns true when a sample was taken. */
  sample(dt, state) {
    this.elapsed += dt;
    if (this.elapsed < this._nextSampleAt) return false;
    if (this.count * STRIDE >= this.capacity) return false;   // ride longer than the cap
    const i = this.count * STRIDE;
    this.data[i] = state.roadD || 0;
    this.data[i + 1] = state.lateral || 0;
    this.data[i + 2] = state.lean || 0;
    this.count++;
    this._nextSampleAt += this.interval;
    return true;
  }

  /**
   * The recorded track, trimmed and rounded. Two decimals is a centimetre of
   * road position and a thousandth of a radian of lean — well under what a
   * translucent bike 40% opaque can show, and it halves the JSON.
   */
  finish() {
    const out = new Array(this.count * STRIDE);
    for (let i = 0; i < out.length; i++) out[i] = Math.round(this.data[i] * 100) / 100;
    return { hz: this.hz, count: this.count, data: out };
  }

  reset() {
    this.count = 0;
    this.elapsed = 0;
    this._nextSampleAt = 0;
  }
}

/**
 * Reads a track back. `at(seconds)` interpolates between the two nearest
 * samples, so a 10 Hz recording plays back smoothly at 60 fps.
 */
export class GhostPlayer {
  constructor(track) {
    this.track = normalizeTrack(track);
    this._cursor = 0;
  }

  get duration() {
    const n = this.track.count;
    return n ? (n - 1) / this.track.hz : 0;
  }

  /** The time of sample `i`, implied by the fixed sampling interval. */
  timeOf(i) { return i / this.track.hz; }

  /**
   * The ghost's state at `seconds` into its ride. Interpolated, so a 10 Hz
   * recording is smooth at 60 fps.
   * @returns {{roadD, lateral, lean, finished}|null}
   */
  at(seconds) {
    const { data, count, hz } = this.track;
    if (!count) return null;
    const exact = seconds * hz;               // in sample units
    if (exact <= 0) {
      return { roadD: data[0], lateral: data[1], lean: data[2], finished: false };
    }
    if (exact >= count - 1) {
      const i = (count - 1) * STRIDE;
      return { roadD: data[i], lateral: data[i + 1], lean: data[i + 2], finished: true };
    }
    const idx = Math.floor(exact);
    const k = exact - idx;
    const a = idx * STRIDE;
    const b = a + STRIDE;
    return {
      roadD: lerp(data[a], data[b], k),
      lateral: lerp(data[a + 1], data[b + 1], k),
      lean: lerp(data[a + 2], data[b + 2], k),
      finished: false
    };
  }

  reset() { this._cursor = 0; }
}

/**
 * Time difference against the ghost at a given road distance, in seconds.
 * Negative means the ghost got there first — you are behind.
 */
export function ghostDeltaAt(track, roadD, elapsed) {
  const t = normalizeTrack(track);
  if (!t.count) return null;
  for (let i = 0; i < t.count; i++) {
    if (t.data[i * STRIDE] >= roadD) return elapsed - i / t.hz;
  }
  return null;   // the ghost never got this far: you are ahead of its whole ride
}

/** Storage size of a track, in bytes, for the cap in records.js. */
export function trackBytes(track) {
  const t = normalizeTrack(track);
  return t.count * STRIDE * 4;
}

function normalizeTrack(track) {
  if (!track) return { hz: SAMPLE_HZ, count: 0, data: [] };
  const data = track.data instanceof Float32Array ? track.data : Float32Array.from(track.data || []);
  const count = Math.min(track.count ?? Math.floor(data.length / STRIDE), Math.floor(data.length / STRIDE));
  return { hz: track.hz || SAMPLE_HZ, count, data };
}

function lerp(a, b, k) { return a + (b - a) * k; }
