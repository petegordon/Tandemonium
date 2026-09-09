// ============================================================
// SHARED PEDAL CONTROLLER (multiplayer)
// Beat-window two-foot tracking: captain + stoker answer each
// other's beat with the opposite foot on a shared crank
// ============================================================
//
// Scoring lives in js/pedal-scoring.js (pure, unit tested). This class owns the
// physical side: pedal power, crank angle, acceleration, wobble, per-seat stats
// and the wasCorrect/wasWrong/wasInPhase/wasBrake flags the HUD reads.
//
// AUTHORITY: only the captain runs update(). The stoker sends taps over the net
// (game.js `_updateStoker` → `net.sendPedal`) and receives bike state back via
// RemoteBikeState, so there is exactly one simulation of this model per ride.
// Local co-op and each VERSUS duo team have their own instance. Changing the
// beat window therefore cannot desync two clients.
// ============================================================

import { BEAT_WINDOW_S, createScoringState, classifyTap, applyTap } from './pedal-scoring.js';

export class SharedPedalController {
  constructor() {
    this.pedalPower = 0;
    this.crankAngle = 0;
    this.wasCorrect = false;
    this.wasWrong = false;
    this.wasBrake = false;
    this.wasInPhase = false;
    this._pendingTaps = [];

    // Beat-window scoring state (feet, times, the open beat)
    this._scoring = createScoringState();
    this.beatWindow = BEAT_WINDOW_S;

    // Running offset quality score (0-1)
    this.offsetScore = 0.5;

    // Kind of the last tap processed ('perfect' | 'solo' | 'wrong' | 'fight'),
    // and which seat played it — A-3 (audio/haptics) and A-4 (seat chips) read
    // these; they are cleared by the consumer, not here.
    this.lastTapKind = null;
    this.lastTapSeat = null;
    this.tapEvents = [];

    // Stats tracking per player
    this.stats = {
      captain: { totalTaps: 0, correctTaps: 0, wrongTaps: 0, totalPower: 0, perfectTaps: 0 },
      stoker:  { totalTaps: 0, correctTaps: 0, wrongTaps: 0, totalPower: 0, perfectTaps: 0 }
    };
  }

  // Legacy accessors — some call sites (and tests) still read these.
  get captainLastFoot() { return this._scoring.captainLastFoot; }
  get captainLastTime() { return this._scoring.captainLastTime; }
  get stokerLastFoot()  { return this._scoring.stokerLastFoot; }
  get stokerLastTime()  { return this._scoring.stokerLastTime; }

  receiveTap(source, foot) {
    this._pendingTaps.push({ source, foot, time: performance.now() / 1000 });
  }

  update(dt) {
    let acceleration = 0;
    let wobble = 0;

    // Only reset flags when there are new taps (so they persist while held)
    if (this._pendingTaps.length > 0) {
      this.wasCorrect = false;
      this.wasWrong = false;
      this.wasBrake = false;
      this.wasInPhase = false;
      this.tapEvents.length = 0;
    }

    // Process taps one at a time
    while (this._pendingTaps.length > 0) {
      const tap = this._pendingTaps.shift();
      const { kind, pair } = classifyTap(this._scoring, tap, this.beatWindow);
      const pStats = this.stats[tap.source] || this.stats.captain;
      const gap = tap.time - (tap.source === 'captain'
        ? this._scoring.captainLastTime
        : this._scoring.stokerLastTime);

      pStats.totalTaps++;
      this.lastTapKind = kind;
      this.lastTapSeat = tap.source;
      this.tapEvents.push({ kind, seat: tap.source, foot: tap.foot, time: tap.time });

      if (kind === 'fight') {
        // Both riders shoving the same crank arm at the same moment: the crank
        // locks, the bike lurches. Same penalty as before, now on the beat
        // window instead of a separate 100 ms rule.
        this.wasBrake = true;
        this.pedalPower *= 0.9;
        this.offsetScore = Math.max(0, this.offsetScore - 0.15);
        this._scoring = applyTap(this._scoring, tap, kind);
        this._pendingTaps.length = 0;
        return { acceleration: 0, wobble: 0.8, braking: true, crankAngle: this.crankAngle };
      }

      if (kind === 'wrong') {
        // Repeated own foot — you have to alternate your own feet.
        this.wasWrong = true;
        pStats.wrongTaps++;
        this.pedalPower = Math.max(this.pedalPower - 0.15, 0);
        this.offsetScore = Math.max(0, this.offsetScore - 0.1);
        acceleration += 0.06;
        pStats.totalPower += 0.06;
        wobble += 0.5;
      } else if (kind === 'perfect') {
        // Answered the partner's beat with the opposite foot. Both taps of the
        // pair are perfect: the earlier one is credited retroactively here (the
        // offset bonus is paid twice, the +0.10 offset score only once).
        this.wasCorrect = true;
        pStats.correctTaps++;
        pStats.perfectTaps++;
        const partnerStats = this.stats[pair && pair.source === 'captain' ? 'captain' : 'stoker'];
        if (pair && partnerStats) partnerStats.perfectTaps++;
        this.offsetScore = Math.min(1, this.offsetScore + 0.1);
        const startBoost = this._scoring.captainLastFoot === null && this._scoring.stokerLastFoot === null ? 0.3 : 0;
        const cadence = gap > 0 && gap < 0.8 ? (0.8 - gap) * 0.4 : 0;
        const offsetBonus = this.offsetScore * 0.15;
        this.pedalPower = Math.min(this.pedalPower + 0.2 + cadence, 1.0);
        const accel = 0.35 + 0.6 * this.pedalPower + offsetBonus * 2 + startBoost;
        acceleration += accel;
        pStats.totalPower += accel;
      } else {
        // Solo stroke: nobody answered (or nobody is there). It still drives the
        // bike at the full base rate — riding alone must never feel punished —
        // it just earns no offset bonus, so a pair on the beat is strictly
        // faster than one rider carrying.
        this.wasInPhase = true;
        pStats.correctTaps++;
        const startBoost = this._scoring.captainLastFoot === null && this._scoring.stokerLastFoot === null ? 0.3 : 0;
        const cadence = gap > 0 && gap < 0.8 ? (0.8 - gap) * 0.4 : 0;
        this.pedalPower = Math.min(this.pedalPower + 0.2 + cadence, 1.0);
        const accel = 0.35 + 0.6 * this.pedalPower + startBoost;
        acceleration += accel;
        pStats.totalPower += accel;
      }

      this._scoring = applyTap(this._scoring, tap, kind);
      this.crankAngle += Math.PI / 2;
    }

    // Decay
    this.pedalPower *= (1 - 0.4 * dt);
    this.offsetScore *= (1 - 0.05 * dt);

    return { acceleration, wobble, braking: false, crankAngle: this.crankAngle };
  }
}
