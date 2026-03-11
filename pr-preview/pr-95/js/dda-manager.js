// ============================================================
// DDA MANAGER — Dynamic Difficulty Adjustment
// ============================================================

import { TUNE, DIFFICULTY_PRESETS } from './config.js';

export class DDAManager {
  constructor(difficulty) {
    this._baseDifficulty = difficulty || 'normal';
    this._basePreset = { ...DIFFICULTY_PRESETS[this._baseDifficulty] || DIFFICULTY_PRESETS.normal };
    this._failureCounts = {}; // checkpoint distance → failure count
    this._currentCheckpoint = 0;
    this._adjustmentsActive = false;
    this._assistOffered = false;
    this._skipOffered = false;
  }

  recordFailure(checkpointD) {
    const key = checkpointD || 0;
    this._failureCounts[key] = (this._failureCounts[key] || 0) + 1;
    this._currentCheckpoint = key;
  }

  getFailureCount(checkpointD) {
    return this._failureCounts[checkpointD || 0] || 0;
  }

  evaluate(checkpointD) {
    const failures = this.getFailureCount(checkpointD);
    const result = {
      adjustTune: false,
      offerAssist: false,
      offerSkip: false,
    };

    if (failures >= 2) {
      result.adjustTune = true;
    }
    if (failures >= 4 && !this._assistOffered) {
      result.offerAssist = true;
    }
    if (failures >= 6 && !this._skipOffered) {
      result.offerSkip = true;
    }

    return result;
  }

  applyInvisibleAdjustments() {
    const failures = this.getFailureCount(this._currentCheckpoint);
    if (failures < 2) return;

    // Widen crash threshold by 5-15% based on failure count
    const widening = Math.min(0.15, (failures - 1) * 0.05);
    TUNE.crashThreshold = this._basePreset.crashThreshold * (1 + widening);

    // Reduce gravity slightly after 2+ failures
    const gravityReduction = Math.min(0.2, (failures - 1) * 0.05);
    TUNE.gravityForce = this._basePreset.gravityForce * (1 - gravityReduction);

    this._adjustmentsActive = true;
  }

  onCheckpointPassed(checkpointD) {
    // Reset TUNE to base preset values for next segment
    if (this._adjustmentsActive) {
      TUNE.crashThreshold = this._basePreset.crashThreshold;
      TUNE.gravityForce = this._basePreset.gravityForce;
      this._adjustmentsActive = false;
    }
    // Clear failure count for the passed checkpoint
    this._currentCheckpoint = checkpointD;
    this._assistOffered = false;
    this._skipOffered = false;
  }

  markAssistOffered() {
    this._assistOffered = true;
  }

  markSkipOffered() {
    this._skipOffered = true;
  }

  reset() {
    this._failureCounts = {};
    this._currentCheckpoint = 0;
    this._adjustmentsActive = false;
    this._assistOffered = false;
    this._skipOffered = false;
    // Restore base TUNE values
    TUNE.crashThreshold = this._basePreset.crashThreshold;
    TUNE.gravityForce = this._basePreset.gravityForce;
  }
}
