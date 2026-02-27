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
  }

  start() {
    this.startTime = performance.now();
  }

  update(distanceTraveled) {
    if (this.finished) return null;

    // Check checkpoints
    for (const cp of this.checkpoints) {
      if (distanceTraveled >= cp && !this.passedCheckpoints.has(cp)) {
        this.passedCheckpoints.add(cp);
        return { event: 'checkpoint', distance: cp, total: this.checkpoints.length, passed: this.passedCheckpoints.size };
      }
    }

    // Check finish
    if (distanceTraveled >= this.raceDistance) {
      this.finished = true;
      this.finishTime = performance.now();
      return { event: 'finish' };
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
      finished: this.finished
    };
  }
}
