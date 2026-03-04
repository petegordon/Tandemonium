// ============================================================
// HUD — on-screen display
// ============================================================

import { isMobile } from './config.js';

export class HUD {
  constructor(input) {
    this.input = input;
    this.speedValueEl = document.getElementById('speed-value');
    this.speedBarFill = document.getElementById('speed-bar-fill');
    this.distanceEl = document.getElementById('distance-display');
    this.elapsedEl = document.getElementById('elapsed-display');
    this.raceManager = null;
    this.statusEl = document.getElementById('status');
    this.crashOverlay = document.getElementById('crash-overlay');
    this.crashFlash = 0;

    // Gauges
    this.bikeNeedle = document.getElementById('bike-needle');
    this.bikeLabel = document.getElementById('bike-label');
    this.phoneNeedle = document.getElementById('phone-needle');
    this.phoneLabel = document.getElementById('phone-label');
    this.phoneGauge = document.getElementById('phone-gauge');

    // Partner gauge
    this.partnerGauge = document.getElementById('partner-gauge');
    this.partnerNeedle = document.getElementById('partner-needle');
    this.partnerLabel = document.getElementById('partner-label');
    this.partnerPedalUp = document.getElementById('partner-pedal-up');
    this.partnerPedalDown = document.getElementById('partner-pedal-down');
    this._lastRemoteTapTime = 0;
    this._lastRemoteFootValue = null;
    this._pedalFlashTimer = 0;

    // Touch buttons
    this.touchLeftEl = document.getElementById('touch-left');
    this.touchRightEl = document.getElementById('touch-right');

    // Progress bar
    this.progressWrap = document.getElementById('progress-bar-wrap');
    this.progressFill = document.getElementById('progress-bar-fill');
    this.progressBike = document.getElementById('progress-bar-bike');
    this.progressDest = document.getElementById('progress-destination');
    this._checkpointEls = [];

    // Collectible counter
    this.collectibleWrap = document.getElementById('collectible-counter');
    this.collectibleIcon = document.getElementById('collectible-icon');
    this.collectibleCount = document.getElementById('collectible-count');

    // Segment timer
    this.timerRow = document.getElementById('timer-row');
    this.timerEl = document.getElementById('segment-timer');

    // Center countdown overlay
    this.countdownOverlay = document.getElementById('countdown-overlay');
    this.countdownNumber = document.getElementById('countdown-number');
    this._lastCountdownSec = -1;

    // Cached previous values — skip DOM writes when unchanged
    this._prevKmh = -1;
    this._prevSpeedColor = '';
    this._prevDistText = '';
    this._prevBikeDeg = NaN;
    this._prevBikeDangerZone = -1;
    this._prevPhoneDeg = NaN;
    this._prevStatusText = '';
    this._prevStatusColor = '';
  }

  initProgress(level) {
    this.progressWrap.style.display = 'block';
    this.progressDest.textContent = level.icon;

    // Remove old checkpoint markers
    this._checkpointEls.forEach(el => el.remove());
    this._checkpointEls = [];

    // Add checkpoint markers
    for (let d = level.checkpointInterval; d < level.distance; d += level.checkpointInterval) {
      const pct = (d / level.distance) * 100;
      const marker = document.createElement('div');
      marker.className = 'progress-checkpoint';
      marker.style.left = pct + '%';
      marker.dataset.distance = d;
      this.progressWrap.appendChild(marker);
      this._checkpointEls.push(marker);
    }
  }

  updateProgress(distanceTraveled, raceDistance, passedCheckpoints) {
    const pct = Math.min(100, (distanceTraveled / raceDistance) * 100);
    this.progressFill.style.width = pct + '%';
    this.progressBike.style.left = pct + '%';

    // Mark passed checkpoints
    this._checkpointEls.forEach(el => {
      if (passedCheckpoints && passedCheckpoints.has(Number(el.dataset.distance))) {
        el.classList.add('passed');
      }
    });
  }

  hideProgress() {
    this.progressWrap.style.display = 'none';
  }

  initTimer() {
    this.timerRow.classList.add('visible');
    this.timerEl.className = '';
    this.timerEl.textContent = '';
    this.elapsedEl.textContent = '\u23F1 0s';
  }

  updateTimer(remaining, total) {
    const secs = Math.max(0, Math.ceil(remaining));
    this.timerEl.textContent = '\u23F1 ' + secs + 's';
    if (remaining <= 5) {
      this.timerEl.className = 'danger';
    } else if (remaining <= 10) {
      this.timerEl.className = 'warning';
    } else if (remaining <= 15) {
      this.timerEl.className = 'normal';
    } else {
      this.timerEl.className = '';
    }

    // Center countdown overlay for final 3 seconds
    if (remaining > 0 && remaining <= 3) {
      this.countdownOverlay.classList.add('visible');
      if (secs !== this._lastCountdownSec) {
        this._lastCountdownSec = secs;
        this.countdownNumber.textContent = secs;
        this.countdownNumber.className = 'tick-' + secs;
        // Re-trigger animation
        this.countdownNumber.style.animation = 'none';
        this.countdownNumber.offsetHeight; // force reflow
        this.countdownNumber.style.animation = '';
      }
    } else {
      this.countdownOverlay.classList.remove('visible');
      this._lastCountdownSec = -1;
    }
  }

  hideTimer() {
    this.timerRow.classList.remove('visible');
    this.countdownOverlay.classList.remove('visible');
    this.countdownNumber.textContent = '';
    this._lastCountdownSec = -1;
    this.elapsedEl.textContent = '';
  }

  showCollectibles(level) {
    const icons = { presents: '\uD83C\uDF81', gems: '\uD83D\uDC8E' }; // 🎁 💎
    this.collectibleIcon.textContent = icons[level.collectibles] || '\u2B50';
    this.collectibleCount.textContent = '0';
    this.collectibleWrap.style.display = 'flex';
  }

  updateCollectibles(collected, total) {
    this.collectibleCount.textContent = collected + ' / ' + total;
  }

  hideCollectibles() {
    this.collectibleWrap.style.display = 'none';
  }

  update(bike, input, pedalCtrl, dt, remoteData) {
    const kmh = Math.round(bike.speed * 3.6);
    const maxKmh = 58;

    // Speed number + color coding (skip DOM write when unchanged)
    if (kmh !== this._prevKmh) {
      this._prevKmh = kmh;
      this.speedValueEl.textContent = kmh;
      const pct = Math.min(100, (kmh / maxKmh) * 100);
      this.speedBarFill.style.width = pct + '%';
    }
    const speedColor = kmh > 35 ? '#00e040' : (kmh > 15 ? '#88ff88' : '#ffffff');
    if (speedColor !== this._prevSpeedColor) {
      this._prevSpeedColor = speedColor;
      this.speedValueEl.style.color = speedColor;
      this.speedBarFill.style.background = speedColor;
    }

    // Distance: "m" under 1000, "km" above
    const dist = bike.distanceTraveled;
    const distText = dist >= 1000
      ? (dist / 1000).toFixed(2) + ' km'
      : Math.round(dist) + ' m';
    if (distText !== this._prevDistText) {
      this._prevDistText = distText;
      this.distanceEl.textContent = distText;
    }

    // Total elapsed time
    if (this.raceManager && this.raceManager.startTime > 0) {
      this.elapsedEl.textContent = '\u23F1 ' + this.raceManager.getElapsedFormatted();
    }

    const leftHeld = input.isPressed('ArrowLeft');
    const rightHeld = input.isPressed('ArrowRight');
    const braking = leftHeld && rightHeld;

    // Touch button feedback (supports both solo and multiplayer pedal controllers)
    if (this.touchLeftEl && this.touchRightEl) {
      let lClass = 'pedal-touch';
      let rClass = 'pedal-touch';

      const wasBrake = pedalCtrl.wasBrake || false;

      if (braking || wasBrake) {
        lClass += ' brake';
        rClass += ' brake';
      } else {
        if (leftHeld) lClass += (pedalCtrl.wasWrong ? ' wrong' : ' pressed');
        if (rightHeld) rClass += (pedalCtrl.wasWrong ? ' wrong' : ' pressed');
      }

      this.touchLeftEl.className = lClass;
      this.touchRightEl.className = rClass;

      // Idle pulse when stopped and buttons are neutral
      const isIdle = bike.speed < 0.3 && !leftHeld && !rightHeld;
      this.touchLeftEl.classList.toggle('idle-pulse', isIdle);
      this.touchRightEl.classList.toggle('idle-pulse', isIdle);
    }

    // Phone gauge (show on both mobile and desktop)
    let phoneDeg;
    if (isMobile) {
      const rawRel = input.motionRawRelative || 0;
      phoneDeg = Math.round(Math.max(-90, Math.min(90, rawRel)));
    } else if (input.gamepadConnected) {
      phoneDeg = Math.round(input.gamepadLean * 90);
    } else {
      const aHeld = input.isPressed('KeyA');
      const dHeld = input.isPressed('KeyD');
      phoneDeg = aHeld ? -45 : (dHeld ? 45 : 0);
    }
    if (phoneDeg !== this._prevPhoneDeg) {
      this._prevPhoneDeg = phoneDeg;
      this.phoneNeedle.setAttribute('transform', 'rotate(' + phoneDeg + ', 60, 60)');
      this.phoneLabel.textContent = Math.abs(phoneDeg) + '\u00B0';
    }

    // Bike gauge (round to integer degrees to reduce DOM writes)
    const tiltDeg = (bike.lean * 180 / Math.PI);
    const bikeDeg = Math.round(Math.max(-90, Math.min(90, tiltDeg)));
    if (bikeDeg !== this._prevBikeDeg) {
      this._prevBikeDeg = bikeDeg;
      this.bikeNeedle.setAttribute('transform', 'rotate(' + bikeDeg + ', 60, 60)');
      this.bikeLabel.textContent = Math.abs(tiltDeg).toFixed(1) + '\u00B0';
    }
    const danger = Math.abs(bike.lean) / 1.35;
    const dangerZone = danger > 0.75 ? 2 : (danger > 0.5 ? 1 : 0);
    if (dangerZone !== this._prevBikeDangerZone) {
      this._prevBikeDangerZone = dangerZone;
      this.bikeLabel.style.color = dangerZone === 2 ? '#ff4444' : (dangerZone === 1 ? '#ffaa22' : '#ffffff');
    }

    // Status text (only when not controlled by countdown)
    let statusText = '';
    let statusColor = '';
    if (bike.fallen) {
      statusText = 'CRASHED! Resetting...';
      statusColor = '#ff4444';
    } else if (bike.speed < 0.3 && bike.distanceTraveled > 0.5) {
      statusText = isMobile ? 'Tap pedals to ride!' :
        (input.gamepadConnected ? 'Pedal! Alternate LB/RB or LT/RT' : 'Pedal! Alternate \u2190 \u2192');
      statusColor = '#ffdd44';
    }
    if (statusText !== this._prevStatusText) {
      this._prevStatusText = statusText;
      this.statusEl.textContent = statusText;
    }
    if (statusColor !== this._prevStatusColor) {
      this._prevStatusColor = statusColor;
      if (statusColor) this.statusEl.style.color = statusColor;
    }

    // Partner gauge + pedal indicators
    if (remoteData && this.partnerGauge) {
      this.partnerGauge.style.display = '';
      if (this.partnerPedalUp) this.partnerPedalUp.style.display = 'flex';
      if (this.partnerPedalDown) this.partnerPedalDown.style.display = 'flex';
      // Needle: remoteLean (-1..1) → degrees (-90..90)
      const partnerDeg = Math.max(-90, Math.min(90, remoteData.remoteLean * 90));
      this.partnerNeedle.setAttribute('transform', 'rotate(' + partnerDeg.toFixed(1) + ', 60, 60)');
      this.partnerLabel.textContent = Math.abs(partnerDeg).toFixed(1) + '\u00B0';

      // Pedal flash: detect new taps, red for wrong (same foot repeated)
      if (remoteData.remoteLastTapTime && remoteData.remoteLastTapTime !== this._lastRemoteTapTime) {
        const isWrong = this._lastRemoteFootValue !== null && remoteData.remoteLastFoot === this._lastRemoteFootValue;
        this._lastRemoteTapTime = remoteData.remoteLastTapTime;
        this._lastRemoteFootValue = remoteData.remoteLastFoot;
        this._pedalFlashTimer = 0.3;
        const cls = isWrong ? 'flash-wrong' : 'flash';
        this._pedalFlashClass = cls;
        if (this.partnerPedalUp) { this.partnerPedalUp.classList.remove('flash', 'flash-wrong'); this.partnerPedalUp.classList.toggle(cls, remoteData.remoteLastFoot === 'up'); }
        if (this.partnerPedalDown) { this.partnerPedalDown.classList.remove('flash', 'flash-wrong'); this.partnerPedalDown.classList.toggle(cls, remoteData.remoteLastFoot === 'down'); }
      }
      if (this._pedalFlashTimer > 0) {
        this._pedalFlashTimer -= dt;
        if (this._pedalFlashTimer <= 0) {
          this._pedalFlashTimer = 0;
          if (this.partnerPedalUp) this.partnerPedalUp.classList.remove('flash', 'flash-wrong');
          if (this.partnerPedalDown) this.partnerPedalDown.classList.remove('flash', 'flash-wrong');
        }
      }
    } else if (this.partnerGauge) {
      this.partnerGauge.style.display = 'none';
      if (this.partnerPedalUp) this.partnerPedalUp.style.display = 'none';
      if (this.partnerPedalDown) this.partnerPedalDown.style.display = 'none';
    }

    // Crash flash
    if (bike.fallen && this.crashFlash === 0) {
      this.crashFlash = 1;
      this.crashOverlay.style.background = 'rgba(255, 0, 0, 0.35)';
    }
    if (this.crashFlash > 0) {
      this.crashFlash -= dt * 0.5;
      if (this.crashFlash <= 0) {
        this.crashFlash = 0;
        this.crashOverlay.style.background = 'rgba(255, 0, 0, 0)';
      } else {
        const alpha = (this.crashFlash * 0.35).toFixed(3);
        this.crashOverlay.style.background = 'rgba(255, 0, 0, ' + alpha + ')';
      }
    }
  }
}
