// ============================================================
// DDA MANAGER — Dynamic Difficulty Adjustment
// ============================================================

import { TUNE, DIFFICULTY_PRESETS } from './config.js';
import { HELP_SKIP_AFTER } from './helping-hand.js';

// Failures at one checkpoint before each kind of help appears.
// #399 (5/5 playtesters found steering too sensitive, one quit): ASSIST is now
// offered after 2 failures instead of 4. The silent tune is unchanged.
// #403: SKIP CHECKPOINT ("Take the Royal Shortcut") after 5 failures, not 6 —
// the helping hand's schedule (js/helping-hand.js) owns the number.
export const DDA_SILENT_ADJUST_AFTER = 2;
export const DDA_ASSIST_AFTER = 2;
export const DDA_SKIP_AFTER = HELP_SKIP_AFTER;

export class DDAManager {
  constructor(difficulty) {
    this._baseDifficulty = difficulty || 'adventurous';
    this._basePreset = { ...DIFFICULTY_PRESETS[this._baseDifficulty] || DIFFICULTY_PRESETS.adventurous };
    this._failureCounts = {}; // checkpoint distance → failure count
    this._currentCheckpoint = 0;
    this._adjustmentsActive = false;
    this._assistOffered = false;
    this._skipOffered = false;

    // Analytics counters
    this.offeredCount = 0;
    this.acceptedCount = 0;
    this.skipsUsed = 0;
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

    if (failures >= DDA_SILENT_ADJUST_AFTER) {
      result.adjustTune = true;
    }
    if (failures >= DDA_ASSIST_AFTER && !this._assistOffered) {
      result.offerAssist = true;
    }
    // #403: offered on every failure from the 5th, not once — the game-over
    // screen is rebuilt each time, and a hidden way out helps nobody.
    if (failures >= DDA_SKIP_AFTER) {
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
    // Clear the failure counts: passing the checkpoint ends the stretch the
    // player was stuck on (#403 — the helping hand resets with it).
    this._failureCounts = {};
    this._currentCheckpoint = checkpointD;
    this._assistOffered = false;
    this._skipOffered = false;
  }

  markAssistOffered() {
    this._assistOffered = true;
    this.offeredCount++;
  }

  markSkipOffered() {
    this._skipOffered = true;
    this.offeredCount++;
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
