/**
 * Body: High-frequency physics control (Balance & Pedal)
 */
(function() {
  console.log('Tandy Body: Injected and Running.');

  class TandyBody {
    constructor() {
      this.game = null;
      this.active = false;
      this.lastTick = 0;

      // Controllable Parameters (via Skills)
      this.targetCadence = 2.5;
      this.effortMode = 'normal';
      this.misfireChance = 0.02; // 2% chance to hit the wrong foot

      this.lastPedalTime = 0;
      this.nextFoot = 'up';

      // Balance: human-like drift and reaction
      this._driftBias = 0;          // slow random wander (-0.15 to 0.15)
      this._driftTimer = 0;
      this._driftInterval = 2 + Math.random() * 3; // change drift every 2-5s
      this._reactionNoise = 0;      // per-frame jitter
      this._lastLeanVel = 0;        // for smoothing

      this.init();
    }

    init() {
      const check = setInterval(() => {
        if (window._game) {
          this.game = window._game;
          clearInterval(check);
          this.start();
        }
      }, 500);
    }

    start() {
      this.active = true;
      requestAnimationFrame((t) => this.tick(t));
    }

    tick(timestamp) {
      if (!this.active) return;
      const dt = (timestamp - this.lastTick) / 1000;
      this.lastTick = timestamp;

      if (this.game.state === 'playing') {
        this.controlBalance(dt);
        this.controlPedals(dt);
      }
      requestAnimationFrame((t) => this.tick(t));
    }

    controlBalance(dt) {
      const bike = this.game.bike;
      if (!bike || !this.game.input) return;
      if (dt <= 0 || dt > 0.1) return;

      const lean = bike.lean;                    // current lean angle (radians)
      const leanVel = bike.leanVelocity || 0;    // lean angular velocity
      const absLean = Math.abs(lean);
      const fallThreshold = 1.35;                // bike falls at this lean

      // Effort mode tuning
      let dampGain = 1.2;    // how strongly we counteract lean velocity
      let dangerGain = 2.5;  // how strongly we correct near fall threshold
      let reactionDelay = 0.12; // smoothing (higher = sluggish, more human)
      if (this.effortMode === 'low') { dampGain = 0.6; dangerGain = 1.2; reactionDelay = 0.2; }
      if (this.effortMode === 'aggressive') { dampGain = 2.0; dangerGain = 4.0; reactionDelay = 0.05; }

      // === 1. Primary: dampen lean velocity (stabilizer, not steering) ===
      // Counteract the rate of lean change — this smooths wobbles
      // without fighting the captain's intentional steering direction
      let dampOutput = -leanVel * dampGain;

      // === 2. Danger correction: kick in hard only near fall threshold ===
      // Ramps from 0 at 60% of threshold to full at 100%
      const dangerStart = fallThreshold * 0.6;   // ~0.81 rad / ~46 degrees
      let dangerOutput = 0;
      if (absLean > dangerStart) {
        const dangerFrac = (absLean - dangerStart) / (fallThreshold - dangerStart);
        const urgency = dangerFrac * dangerFrac; // quadratic ramp for punch
        dangerOutput = -Math.sign(lean) * urgency * dangerGain;
      }

      // === 3. Human-like drift: slow random wander ===
      this._driftTimer += dt;
      if (this._driftTimer >= this._driftInterval) {
        this._driftTimer = 0;
        this._driftInterval = 2 + Math.random() * 3;
        // Target a new drift bias, weighted toward zero
        this._driftBias = (Math.random() - 0.5) * 0.3;
      }

      // === 4. Per-frame reaction noise (small jitter) ===
      this._reactionNoise = (Math.random() - 0.5) * 0.08;

      // === Combine ===
      const rawOutput = dampOutput + dangerOutput + this._driftBias + this._reactionNoise;

      // Smooth with reaction delay (exponential moving average)
      const smoothing = Math.min(1, dt / Math.max(0.01, reactionDelay));
      const smoothed = this._lastLeanVel + (rawOutput - this._lastLeanVel) * smoothing;
      this._lastLeanVel = smoothed;

      // Write to input.motionLean so balanceCtrl.update() picks it up via getMotionLean()
      this.game.input.motionEnabled = true;
      this.game.input.motionLean = Math.max(-1, Math.min(1, smoothed));
    }

    controlPedals(dt) {
      if (this.targetCadence <= 0) return;

      const now = performance.now();

      // Add slight jitter to the interval for more "human" timing
      const jitter = (Math.random() - 0.5) * 50;
      const interval = (1000 / this.targetCadence) + jitter;
      const holdDuration = 100;

      if (now - this.lastPedalTime > interval) {
        // Coordinate with captain: pick the opposite foot of what the captain last hit.
        // The shared pedal controller on the captain's side rewards opposite-foot taps.
        // _remoteLastFoot tracks the captain's last pedal as seen by this stoker.
        let footToHit = this.nextFoot;
        const captainFoot = this.game._remoteLastFoot;
        if (captainFoot) {
          footToHit = captainFoot === 'up' ? 'down' : 'up';
        }

        // Occasionally "misfire" by hitting the same foot as captain
        const isMisfire = Math.random() < this.misfireChance;
        if (isMisfire) {
          footToHit = (footToHit === 'up' ? 'down' : 'up');
        }

        const keyCode = footToHit === 'up' ? 'ArrowUp' : 'ArrowDown';

        if (this.game.input && this.game.input.keys) {
          this.game.input.keys[keyCode] = true;

          setTimeout(() => {
            if (this.game.input && this.game.input.keys) {
              this.game.input.keys[keyCode] = false;
            }
          }, holdDuration);

          this.nextFoot = (footToHit === 'up' ? 'down' : 'up');
          this.lastPedalTime = now;
        }
      }
    }
  }

  window._agent = new TandyBody();
})();
