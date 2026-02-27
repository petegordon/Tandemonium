// ============================================================
// CONTRIBUTION TRACKER — tracks pedaling, balance, and
// steering quality per player
// ============================================================

export class ContributionTracker {
  constructor(mode) {
    this.mode = mode; // 'solo' | 'captain' | 'stoker'

    // Per-player stats
    this.captain = this._emptyStats();
    this.stoker = this._emptyStats();
    this.solo = this._emptyStats();

    // Running accumulators
    this._totalTime = 0;
    this._captainLeanAccum = 0;
    this._stokerLeanAccum = 0;
  }

  _emptyStats() {
    return {
      // Pedaling (fed from pedal controller stats)
      totalTaps: 0,
      correctTaps: 0,
      wrongTaps: 0,
      totalPower: 0,

      // Balance
      safeTime: 0,        // time with |lean| < 0.5 rad
      dangerTime: 0,      // time with |lean| > 0.75 rad
      leanInputAccum: 0,  // total absolute lean input magnitude
      leanCorrectionAccum: 0, // how much lean input opposed gravity direction

      // Road tracking (shared metric, attributed proportionally)
      onRoadTime: 0,      // time with |lateralOffset| < 2.5
      centerTime: 0,      // time with |lateralOffset| < 0.5
      lateralAccum: 0,    // total |lateralOffset| for averaging
      lateralSamples: 0,
    };
  }

  update(dt, bike, captainLeanInput, stokerLeanInput, pedalStats) {
    this._totalTime += dt;

    const absLean = Math.abs(bike.lean);
    const lateralOffset = Math.abs(bike._lateralOffset || 0);
    const onRoad = lateralOffset < 2.5;
    const onCenter = lateralOffset < 0.5;

    if (this.mode === 'solo') {
      this._updatePlayer(this.solo, dt, absLean, captainLeanInput, bike.lean, onRoad, onCenter, lateralOffset, pedalStats);
    } else {
      // Attribute road tracking proportionally to lean input magnitude
      const captainMag = Math.abs(captainLeanInput || 0);
      const stokerMag = Math.abs(stokerLeanInput || 0);
      const totalMag = captainMag + stokerMag;
      const captainFrac = totalMag > 0.01 ? captainMag / totalMag : 0.5;
      const stokerFrac = 1 - captainFrac;

      this._captainLeanAccum += captainMag * dt;
      this._stokerLeanAccum += stokerMag * dt;

      // Balance stats per player
      this._updatePlayerBalance(this.captain, dt, absLean, captainLeanInput, bike.lean);
      this._updatePlayerBalance(this.stoker, dt, absLean, stokerLeanInput, bike.lean);

      // Road tracking — shared but attributed proportionally
      this._updatePlayerRoad(this.captain, dt * captainFrac, onRoad, onCenter, lateralOffset);
      this._updatePlayerRoad(this.stoker, dt * stokerFrac, onRoad, onCenter, lateralOffset);

      // Pedal stats from shared controller
      if (pedalStats) {
        this._syncPedalStats(this.captain, pedalStats.captain);
        this._syncPedalStats(this.stoker, pedalStats.stoker);
      }
    }
  }

  _updatePlayer(stats, dt, absLean, leanInput, bikeLean, onRoad, onCenter, lateralOffset, pedalStats) {
    this._updatePlayerBalance(stats, dt, absLean, leanInput, bikeLean);
    this._updatePlayerRoad(stats, dt, onRoad, onCenter, lateralOffset);
    if (pedalStats) {
      this._syncPedalStats(stats, pedalStats);
    }
  }

  _updatePlayerBalance(stats, dt, absLean, leanInput, bikeLean) {
    if (absLean < 0.5) stats.safeTime += dt;
    if (absLean > 0.75) stats.dangerTime += dt;

    stats.leanInputAccum += Math.abs(leanInput || 0) * dt;

    // Lean correction quality: positive when input opposes lean direction
    if (leanInput && bikeLean) {
      const correcting = (bikeLean > 0 && leanInput < 0) || (bikeLean < 0 && leanInput > 0);
      if (correcting) stats.leanCorrectionAccum += Math.abs(leanInput) * dt;
    }
  }

  _updatePlayerRoad(stats, dt, onRoad, onCenter, lateralOffset) {
    if (onRoad) stats.onRoadTime += dt;
    if (onCenter) stats.centerTime += dt;
    stats.lateralAccum += lateralOffset * dt;
    stats.lateralSamples += dt;
  }

  _syncPedalStats(stats, source) {
    if (!source) return;
    stats.totalTaps = source.totalTaps || 0;
    stats.correctTaps = source.correctTaps || 0;
    stats.wrongTaps = source.wrongTaps || 0;
    stats.totalPower = source.totalPower || 0;
  }

  getSummary() {
    const t = this._totalTime || 1;

    if (this.mode === 'solo') {
      return {
        mode: 'solo',
        solo: this._playerSummary(this.solo, t),
        totalTime: t
      };
    }

    const capSummary = this._playerSummary(this.captain, t);
    const stokeSummary = this._playerSummary(this.stoker, t);

    // Overall contribution percentage (weighted across categories)
    const capTotal = this.captain.totalTaps + this._captainLeanAccum * 100;
    const stokeTotal = this.stoker.totalTaps + this._stokerLeanAccum * 100;
    const sum = capTotal + stokeTotal;
    capSummary.overallPct = sum > 0 ? Math.round((capTotal / sum) * 100) : 50;
    stokeSummary.overallPct = 100 - capSummary.overallPct;

    return {
      mode: 'multiplayer',
      captain: capSummary,
      stoker: stokeSummary,
      totalTime: t
    };
  }

  _playerSummary(stats, totalTime) {
    return {
      totalTaps: stats.totalTaps,
      correctTaps: stats.correctTaps,
      wrongTaps: stats.wrongTaps,
      totalPower: Math.round(stats.totalPower * 100) / 100,
      safePct: Math.round((stats.safeTime / totalTime) * 100),
      dangerPct: Math.round((stats.dangerTime / totalTime) * 100),
      onRoadPct: Math.round((stats.onRoadTime / totalTime) * 100),
      centerPct: stats.lateralSamples > 0 ? Math.round((stats.centerTime / stats.lateralSamples) * 100) : 0,
      avgLateral: stats.lateralSamples > 0 ? Math.round((stats.lateralAccum / stats.lateralSamples) * 100) / 100 : 0,
      leanInputTotal: Math.round(stats.leanInputAccum * 100) / 100,
      leanCorrectionTotal: Math.round(stats.leanCorrectionAccum * 100) / 100,
    };
  }
}
