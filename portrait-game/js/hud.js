// ============================================================
// HUD — on-screen display
// ============================================================

import { isMobile } from './config.js';

export class HUD {
  constructor(input) {
    this.input = input;
    this.speedEl = document.getElementById('speed-display');
    this.distanceEl = document.getElementById('distance-display');
    this.statusEl = document.getElementById('status');
    this.crashOverlay = document.getElementById('crash-overlay');
    this.crashFlash = 0;

    // Gauges
    this.bikeNeedle = document.getElementById('bike-needle');
    this.bikeLabel = document.getElementById('bike-label');
    this.phoneNeedle = document.getElementById('phone-needle');
    this.phoneLabel = document.getElementById('phone-label');
    this.phoneGauge = document.getElementById('phone-gauge');

    // Touch buttons
    this.touchLeftEl = document.getElementById('touch-left');
    this.touchRightEl = document.getElementById('touch-right');

    // Hide phone gauge on desktop
    if (!isMobile && this.phoneGauge) {
      this.phoneGauge.style.display = 'none';
    }
  }

  update(bike, input, pedalCtrl, dt) {
    const kmh = Math.round(bike.speed * 3.6);
    this.speedEl.textContent = 'Speed: ' + kmh + ' km/h';
    this.distanceEl.textContent = 'Distance: ' + Math.round(bike.distanceTraveled) + ' m';

    const leftHeld = input.isPressed('ArrowUp');
    const rightHeld = input.isPressed('ArrowDown');
    const braking = leftHeld && rightHeld;

    // Touch button feedback (supports both solo and multiplayer pedal controllers)
    if (this.touchLeftEl && this.touchRightEl) {
      let lClass = 'pedal-touch';
      let rClass = 'pedal-touch';

      const wasBrake = pedalCtrl.wasBrake || false;
      const wasInPhase = pedalCtrl.wasInPhase || false;

      if (braking || wasBrake) {
        lClass += ' brake';
        rClass += ' brake';
      } else if (wasInPhase) {
        if (leftHeld) lClass += ' wrong';
        if (rightHeld) rClass += ' wrong';
      } else {
        if (leftHeld) lClass += (pedalCtrl.wasWrong ? ' wrong' : ' pressed');
        if (rightHeld) rClass += (pedalCtrl.wasWrong ? ' wrong' : ' pressed');
      }

      this.touchLeftEl.className = lClass;
      this.touchRightEl.className = rClass;
    }

    // Phone gauge
    if (isMobile) {
      const rawRel = input.motionRawRelative || 0;
      const phoneDeg = Math.max(-90, Math.min(90, rawRel));
      this.phoneNeedle.setAttribute('transform', 'rotate(' + phoneDeg.toFixed(1) + ', 60, 60)');
      this.phoneLabel.textContent = Math.abs(rawRel).toFixed(1) + '\u00B0';
    }

    // Bike gauge
    const tiltDeg = (bike.lean * 180 / Math.PI);
    const bikeDeg = Math.max(-90, Math.min(90, tiltDeg));
    const danger = Math.abs(bike.lean) / 1.35;
    this.bikeNeedle.setAttribute('transform', 'rotate(' + bikeDeg.toFixed(1) + ', 60, 60)');
    this.bikeLabel.textContent = Math.abs(tiltDeg).toFixed(1) + '\u00B0';
    if (danger > 0.75) {
      this.bikeLabel.style.color = '#ff4444';
    } else if (danger > 0.5) {
      this.bikeLabel.style.color = '#ffaa22';
    } else {
      this.bikeLabel.style.color = '#ffffff';
    }

    // Status text (only when not controlled by countdown)
    if (bike.fallen) {
      this.statusEl.textContent = 'CRASHED! Resetting...';
      this.statusEl.style.color = '#ff4444';
    } else if (bike.speed < 0.3 && bike.distanceTraveled > 0.5) {
      this.statusEl.textContent = isMobile ? 'Tap pedals to ride!' : 'Pedal! Alternate \u2191 \u2193';
      this.statusEl.style.color = '#ffdd44';
    } else {
      this.statusEl.textContent = '';
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
