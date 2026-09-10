// ============================================================
// RACE MANAGER — tracks race progress, checkpoints, finish
// ============================================================

import { TUNE } from './config.js';

// ============================================================
// A-6 · the first-segment grace
// ============================================================
//
// The timer used to start on GO. A first-timer reading the screen, finding the
// pedals, or working out which way to lean was already losing, and the recorded
// confusion in this game all sits inside the first 60 seconds. So:
//
//   - the first segment's clock does not start until the rider's first correct
//     pedal tap, or GRACE_MAX_S after the countdown, whichever comes first;
//   - the first segment gets FIRST_SEGMENT_BONUS_S extra on every difficulty;
//   - until it starts, the HUD shows a dash instead of a number.
//
// Nobody times out while reading.
export const GRACE_MAX_S = 10;
export const FIRST_SEGMENT_BONUS_S = 8;

/**
 * When does the first segment's clock start? Pure, so it can be tested.
 * @param {number|null} firstTapAt   seconds since countdown end, or null
 * @param {number} maxGrace          hard cap on the grace period
 * @returns {number} seconds after the countdown at which the timer starts
 */
export function segmentStartsAt(firstTapAt, maxGrace = GRACE_MAX_S) {
  if (firstTapAt === null || firstTapAt === undefined || !(firstTapAt >= 0)) return maxGrace;
  return Math.min(firstTapAt, maxGrace);
}

export class RaceManager {
  constructor(level) {
    this.level = level;
    this.raceDistance = level.distance;
    this.checkpointInterval = level.checkpointInterval;

    // Build checkpoint list
    this.checkpoints = [];
    for (let d = this.checkpointInterval; d < this.raceDistance; d += this.checkpointInterval) {
      this.checkpoints.push(d);
    }

    this.passedCheckpoints = new Set();
    this.finished = false;
    this.startTime = 0;
    this.finishTime = 0;
    this.collectiblesCount = 0;
    this.crashCount = 0;
    this.timeoutCount = 0;
    this.restartCount = 0;
    this.inputSource = 'none';

    // Segment countdown timer (seconds)
    this.segmentTimeRemaining = 0;
    this.segmentTimeTotal = 0;

    // A-6 · first-segment grace: the clock is held until the rider actually
    // starts riding (or the grace runs out).
    this.timerHeld = true;
    this.graceElapsed = 0;
  }

  /**
   * A-6 · called on the rider's first correct pedal tap. Releases the clock.
   * Idempotent — later taps do nothing.
   */
  noteFirstPedal() {
    this.timerHeld = false;
  }

  _segmentBudget(segmentDistance) {
    const base = Math.max(10, (segmentDistance / 250) * 60); // 60 seconds per 250m, minimum 10s
    return base * (TUNE.timeMultiplier || 1.0);
  }

  start() {
    // Only set on first start — preserve total time across checkpoint restarts
    if (this.startTime === 0) {
      this.startTime = performance.now();
      // Init segment timer for first segment
      const firstTarget = this.checkpoints.length > 0 ? this.checkpoints[0] : this.raceDistance;
      // A-6: the first segment is the one people lose to confusion, not to
      // difficulty — it gets a fixed bonus on every preset.
      this.segmentTimeTotal = this._segmentBudget(firstTarget) + FIRST_SEGMENT_BONUS_S;
      this.segmentTimeRemaining = this.segmentTimeTotal;
      this.timerHeld = true;
      this.graceElapsed = 0;
    }
  }

  resetSegmentTimer(distanceTraveled) {
    // Find current segment: from last passed checkpoint (or 0) to next target
    let segStart = 0;
    for (const cp of this.checkpoints) {
      if (this.passedCheckpoints.has(cp)) {
        segStart = cp;
      }
    }
    // Next target: first unpassed checkpoint or finish
    let segEnd = this.raceDistance;
    for (const cp of this.checkpoints) {
      if (!this.passedCheckpoints.has(cp)) {
        segEnd = cp;
        break;
      }
    }
    const segDist = segEnd - segStart;
    // The first segment carries the A-6 bonus whenever it is ridden, not only
    // the first time. A rider who crashes at 120 m and is put back on the start
    // line has the same 125 m to ride as they did on the countdown, and taking
    // the bonus away made every retry harder than the attempt that failed.
    const bonus = segStart === 0 ? FIRST_SEGMENT_BONUS_S : 0;
    this.segmentTimeTotal = this._segmentBudget(segDist) + bonus;
    this.segmentTimeRemaining = this.segmentTimeTotal;
  }

  update(distanceTraveled, dt) {
    if (this.finished) return null;

    // A-6 · hold the clock through the grace window.
    if (this.timerHeld) {
      this.graceElapsed += dt || 0;
      if (this.graceElapsed >= GRACE_MAX_S) this.timerHeld = false;
    }

    // Decrement segment timer
    if (dt && !this.timerHeld && this.segmentTimeRemaining > 0) {
      this.segmentTimeRemaining -= dt;
    }

    // Check checkpoints + finish + timeout
    return this._checkProgress(distanceTraveled);
  }

  // Update distance-based progress (checkpoints/finish) without touching timer.
  // Used by the stoker whose timer is synced from captain.
  updateProgressOnly(distanceTraveled) {
    if (this.finished) return null;
    return this._checkProgress(distanceTraveled);
  }

  _checkProgress(distanceTraveled) {
    // Check checkpoints
    for (const cp of this.checkpoints) {
      if (distanceTraveled >= cp && !this.passedCheckpoints.has(cp)) {
        this.passedCheckpoints.add(cp);
        // Reset timer for next segment
        let nextTarget = this.raceDistance;
        for (const ncp of this.checkpoints) {
          if (!this.passedCheckpoints.has(ncp)) {
            nextTarget = ncp;
            break;
          }
        }
        const segDist = nextTarget - cp;
        this.segmentTimeTotal = this._segmentBudget(segDist);
        this.segmentTimeRemaining = this.segmentTimeTotal;
        this.timerHeld = false;   // grace is for the first segment only
        return { event: 'checkpoint', distance: cp, total: this.checkpoints.length, passed: this.passedCheckpoints.size };
      }
    }

    // Check finish
    if (distanceTraveled >= this.raceDistance) {
      this.finished = true;
      this.finishTime = performance.now();
      return { event: 'finish' };
    }

    // Check timeout
    if (this.segmentTimeRemaining <= 0 && this.startTime > 0) {
      this.timeoutCount++;
      return { event: 'timeout' };
    }

    return null;
  }

  addCollectible() {
    this.collectiblesCount++;
  }

  getElapsedMs() {
    if (this.startTime === 0) return 0;
    const end = this.finishTime || performance.now();
    return end - this.startTime;
  }

  getElapsedFormatted() {
    const ms = this.getElapsedMs();
    const totalSec = Math.floor(ms / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    if (min > 0) return min + ':' + String(sec).padStart(2, '0');
    return sec + 's';
  }

  getProgress(distanceTraveled) {
    return Math.min(1, distanceTraveled / this.raceDistance);
  }

  getCheckpointPositions() {
    return this.checkpoints.map(d => ({
      distance: d,
      progress: d / this.raceDistance,
      passed: this.passedCheckpoints.has(d)
    }));
  }

  getSummary(distanceTraveled) {
    return {
      levelId: this.level.id,
      levelName: this.level.name,
      distance: Math.round(distanceTraveled),
      raceDistance: this.raceDistance,
      timeMs: Math.round(this.getElapsedMs()),
      timeFormatted: this.getElapsedFormatted(),
      checkpointsPassed: this.passedCheckpoints.size,
      checkpointsTotal: this.checkpoints.length,
      collectibles: this.collectiblesCount,
      collectiblesTotal: this._collectiblesTotal || 0,
      crashes: this.crashCount,
      timeoutCount: this.timeoutCount,
      restarts: this.restartCount,
      inputSource: this.inputSource,
      finished: this.finished
    };
  }

  setCollectiblesTotal(total) {
    this._collectiblesTotal = total;
  }
}
