// ============================================================
// RACE MANAGER — tracks race progress, checkpoints, finish
// ============================================================

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

    // Segment countdown timer (seconds)
    this.segmentTimeRemaining = 0;
    this.segmentTimeTotal = 0;
  }

  _segmentBudget(segmentDistance) {
    return Math.max(10, (segmentDistance / 250) * 60); // 60 seconds per 250m, minimum 10s
  }

  start() {
    // Only set on first start — preserve total time across checkpoint restarts
    if (this.startTime === 0) {
      this.startTime = performance.now();
      // Init segment timer for first segment
      const firstTarget = this.checkpoints.length > 0 ? this.checkpoints[0] : this.raceDistance;
      this.segmentTimeTotal = this._segmentBudget(firstTarget);
      this.segmentTimeRemaining = this.segmentTimeTotal;
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
    this.segmentTimeTotal = this._segmentBudget(segDist);
    this.segmentTimeRemaining = this.segmentTimeTotal;
  }

  update(distanceTraveled, dt) {
    if (this.finished) return null;

    // Decrement segment timer
    if (dt && this.segmentTimeRemaining > 0) {
      this.segmentTimeRemaining -= dt;
    }

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
      crashes: this.crashCount,
      finished: this.finished
    };
  }
}
