// ============================================================
// HUD — on-screen display
// ============================================================

import { isMobile } from './config.js';
import { formatDelta } from './records.js';
import { LOOKAHEAD_M } from './lookahead.js';
import { pingLabel } from './sync-ping.js';

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

    // Partner pedal indicators. The YOU / BIKE / PARTNER lean gauges that used
    // to sit beside them were removed from the HUD entirely — see index.html.
    this.partnerPedalUp = document.getElementById('partner-pedal-up');
    this.partnerPedalDown = document.getElementById('partner-pedal-down');
    this._lastRemoteTapTime = 0;
    this._lastRemoteFootValue = null;
    this._pedalFlashTimer = 0;

    // A-4 · co-op sync display. Hidden entirely in solo.
    this.syncRow = document.getElementById('sync-row');
    this.syncBarFill = document.getElementById('sync-bar-fill');
    this.seatChips = {
      captain: document.getElementById('seat-chip-captain'),
      stoker: document.getElementById('seat-chip-stoker')
    };
    this.crankFightStamp = document.getElementById('crank-fight-stamp');
    this.crankFightHint = document.getElementById('crank-fight-hint');
    this.coopCoach = document.getElementById('coop-coach');
    this._chipTimers = { captain: 0, stoker: 0 };
    this._prevSyncPct = -1;
    this._prevSyncHue = -1;
    this._fightStampTimer = 0;
    this._fightHintsShown = 0;      // hint text only the first two times per session
    this._coachPerfects = 0;
    this._coachDone = false;
    this._coopActive = false;
    this._coopForced = false;
    this._selfSeat = 'captain';
    this._remoteSyncScore = null;

    // Stoker self-flash: instant feedback on own pedal taps
    this._ownFlashTimer = 0;
    this._ownFlashFoot = null;
    this._ownFlashWrong = false;
    this._prevOwnCorrect = false;
    this._prevOwnWrong = false;

    // Touch buttons
    this.touchLeftEl = document.getElementById('touch-left');
    this.touchRightEl = document.getElementById('touch-right');

    // Progress bar
    this.progressWrap = document.getElementById('progress-bar-wrap');
    this.progressFill = document.getElementById('progress-bar-fill');
    this.progressBike = document.getElementById('progress-bar-bike');
    this.progressDest = document.getElementById('progress-destination');
    this._checkpointEls = [];

    // Collectible + geese counters (both stats in the top strip)
    this.collectibleWrap = document.getElementById('collectible-counter');
    this.collectibleIcon = document.getElementById('collectible-icon');
    this.collectibleCount = document.getElementById('collectible-count');
    this.geeseWrap = document.getElementById('geese-counter');
    this.geeseCount = document.getElementById('geese-count');
    this.collectibleIconChar = '';
    this._prevGeese = -1;

    // Segment timer
    this.timerRow = document.getElementById('timer-row');
    this.timerEl = document.getElementById('segment-timer');
    this.elapsedRow = document.getElementById('elapsed-row');

    // Center countdown overlay
    this.countdownOverlay = document.getElementById('countdown-overlay');
    this.countdownNumber = document.getElementById('countdown-number');
    this._lastCountdownSec = -1;

    // Cached previous values — skip DOM writes when unchanged
    this._prevKmh = -1;
    this._prevSpeedColor = '';
    this._prevDistText = '';
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

  /**
   * B-4 · show the two speed sources the game has always had and never told
   * anyone about: the collectible boost, and the compacted middle of the road.
   * Called every frame from update().
   */
  _updateSpeedSignals(bike) {
    const boostEl = this._boostEl || (this._boostEl = document.getElementById('boost-ribbon'));
    const glowEl = this._glowEl || (this._glowEl = document.getElementById('center-strip-glow'));
    const boosting = !!(bike && bike.boostTimer > 0);
    if (boostEl && boosting !== this._prevBoosting) {
      this._prevBoosting = boosting;
      boostEl.classList.toggle('show', boosting);
    }
    const onStrip = !!(bike && bike.onCenterStrip && !bike.fallen);
    if (glowEl && onStrip !== this._prevOnStrip) {
      this._prevOnStrip = onStrip;
      glowEl.classList.toggle('show', onStrip);
    }
  }

  /**
   * B-3 · flash the split delta at a checkpoint. Green when you are ahead of
   * your best, red when behind; shown only when a best exists, so a first ride
   * is never told it is losing to nothing.
   */
  showSplitDelta(deltaMs) {
    const el = this._splitDeltaEl || (this._splitDeltaEl = document.getElementById('split-delta'));
    if (!el) return;
    el.textContent = formatDelta(deltaMs);
    el.className = 'show ' + (deltaMs <= 0 ? 'ahead' : 'behind');
    clearTimeout(this._splitDeltaTimer);
    this._splitDeltaTimer = setTimeout(() => { el.className = ''; }, 1500);
  }

  /**
   * D-2 · say when a ride counts. A ranked run looks exactly like a practice
   * run from the saddle, and finding out afterwards that the one that counted
   * was the one you were not trying on would be miserable.
   */
  setRankedBadge(on) {
    const el = this._rankedBadgeEl || (this._rankedBadgeEl = document.getElementById('ranked-badge'));
    if (el) el.classList.toggle('show', !!on);
  }

  /**
   * E-2 · the road's three-second warning, and the event itself.
   * Null hides it.
   */
  updateDisruption(active) {
    const el = this._disruptEl || (this._disruptEl = document.getElementById('disruption-banner'));
    if (!el) return;
    const text = active ? active.text : null;
    const now = !!(active && active.phase === 'active');
    if (text === this._prevDisruptText && now === this._prevDisruptNow) return;
    this._prevDisruptText = text;
    this._prevDisruptNow = now;
    el.textContent = text || '';
    el.classList.toggle('show', !!text);
    el.classList.toggle('now', now);
  }

  /**
   * E-3 · the sprint call and the emote bubbles.
   *
   * Both riders see the same thing at the same time: that is the whole point —
   * a sprint one rider knows about is just a rider going faster.
   */
  updatePing(state) {
    const callEl = this._pingCallEl || (this._pingCallEl = document.getElementById('ping-call'));
    const bubbleEl = this._pingBubblesEl || (this._pingBubblesEl = document.getElementById('ping-bubbles'));
    if (!callEl || !bubbleEl) return;

    const label = state ? pingLabel(state) : null;
    if (label !== this._prevPingLabel) {
      this._prevPingLabel = label;
      callEl.textContent = label || '';
      callEl.classList.toggle('show', !!label);
      callEl.classList.toggle('go', label === 'SPRINT!');
    }

    const sig = state ? state.bubbles.map(b => b.seat + b.emote).join('|') : '';
    if (sig !== this._prevBubbleSig) {
      this._prevBubbleSig = sig;
      bubbleEl.innerHTML = '';
      for (const b of (state ? state.bubbles : [])) {
        const el = document.createElement('div');
        el.className = 'ping-bubble';
        el.innerHTML = '<span class="ping-seat">' + (b.seat === 'stoker' ? 'S' : 'C') + '</span>' + b.emote;
        bubbleEl.appendChild(el);
      }
    }
  }

  /**
   * E-1 · draw the stoker's road-ahead panel.
   *
   * Called at 10 Hz, not per frame: the panel is a thing to read and call out,
   * and a lane map that jitters every frame is harder to read, not easier.
   *
   * @param {Array} items from buildLookahead(), or null to hide the panel
   */
  updateLookahead(items) {
    const el = this._lookaheadEl || (this._lookaheadEl = document.getElementById('lookahead'));
    if (!el) return;
    if (!items) {
      if (this._lookaheadOn) { this._lookaheadOn = false; el.classList.remove('visible'); }
      return;
    }
    if (!this._lookaheadOn) { this._lookaheadOn = true; el.classList.add('visible'); }

    this._lookaheadLanes = this._lookaheadLanes ||
      Array.from(el.querySelectorAll('.lookahead-lane'));

    // Cheap change detection: the panel only redraws when what it says changes.
    const signature = items.map(i => i.kind[0] + i.lane + Math.round(i.distance / 2)).join('|');
    if (signature === this._lookaheadSig) return;
    this._lookaheadSig = signature;

    const ICON = { obstacle: '⚠️', present: '🎁', goose: '🦢' };
    for (const lane of this._lookaheadLanes) lane.innerHTML = '';
    for (const item of items) {
      const lane = this._lookaheadLanes[item.lane];
      if (!lane) continue;
      const dot = document.createElement('span');
      dot.className = 'lookahead-item';
      dot.textContent = ICON[item.kind] || '•';
      // Nearest at the bottom: the panel reads like the road coming towards you.
      dot.style.top = (100 - (item.distance / LOOKAHEAD_M) * 100).toFixed(1) + '%';
      dot.style.opacity = (0.45 + 0.55 * item.urgency).toFixed(2);
      lane.appendChild(dot);
    }
  }

  /** B-2 · edge-darkening crash vignette; `k` is 0..1. */
  _setCrashVignette(k) {
    const edge = (k * 0.55).toFixed(3);
    const mid = (k * 0.12).toFixed(3);
    this.crashOverlay.style.background =
      `radial-gradient(ellipse at center, rgba(255,40,40,${mid}) 35%, rgba(120,0,0,${edge}) 100%)`;
  }

  /**
   * Ride start: which seat is this screen, and is this a co-op ride at all?
   * The stoker runs a local (solo) pedal controller for its own feel, so the
   * HUD cannot infer co-op from the controller shape on that side.
   */
  setSeat(seat, isCoop) {
    this._selfSeat = seat || 'captain';
    this._coopForced = !!isCoop;
    this._remoteSyncScore = null;
  }

  /** Stoker side: the captain's authoritative sync score, off the wire. */
  setRemoteSync(score) {
    if (typeof score === 'number') this._remoteSyncScore = score;
  }

  /**
   * A-4 · make the pair legible.
   *
   * The sync bar is offsetScore, red -> amber -> green. The seat chips flash
   * per tap in that seat's own colour, so a rider can see WHO fell off the beat
   * without the game ever printing "S missed" at them. CRANK FIGHT! is stamped
   * on the shared mistake, with the fix spelled out the first two times.
   *
   * A no-op in solo: `pedalCtrl.stats.stoker` only exists on the shared
   * (co-op) controller, and setSeat() marks the co-op modes explicitly.
   */
  _updateSync(pedalCtrl, dt) {
    const shared = !!(pedalCtrl && pedalCtrl.stats && pedalCtrl.stats.stoker);
    const coop = shared || this._coopForced;
    if (coop !== this._coopActive) {
      this._coopActive = coop;
      if (this.syncRow) this.syncRow.classList.toggle('visible', coop);
      if (!coop && this.coopCoach) this.coopCoach.classList.remove('show');
    }
    if (!coop) return;

    // Sync bar. The captain computes it; the stoker receives it in the state
    // packet, so both screens show the same number.
    const raw = shared ? (pedalCtrl.offsetScore ?? 0.5) : (this._remoteSyncScore ?? 0.5);
    const score = Math.max(0, Math.min(1, raw));
    const pct = Math.round(score * 100);
    if (pct !== this._prevSyncPct) {
      this._prevSyncPct = pct;
      if (this.syncBarFill) this.syncBarFill.style.width = pct + '%';
    }
    const hue = Math.round(score * 120);          // 0 red -> 120 green
    if (hue !== this._prevSyncHue) {
      this._prevSyncHue = hue;
      if (this.syncBarFill) this.syncBarFill.style.background = `hsl(${hue}, 90%, 55%)`;
    }

    // Seat chips + the fight stamp, driven by this frame's taps.
    const events = (pedalCtrl && pedalCtrl.tapEvents) || [];
    for (const ev of events) {
      // On the stoker's screen the local controller labels every tap 'captain'
      // because it only knows about one rider — that rider is this one.
      const seat = shared ? ev.seat : this._selfSeat;
      const chip = this.seatChips[seat];
      if (chip) {
        chip.classList.remove('perfect', 'solo', 'wrong');
        chip.classList.add(ev.kind === 'fight' ? 'wrong' : ev.kind);
        this._chipTimers[seat] = 0.35;
      }
      if (ev.kind === 'perfect') this._coachPerfects++;
    }
    for (const seat of ['captain', 'stoker']) {
      if (this._chipTimers[seat] > 0) {
        this._chipTimers[seat] -= dt;
        if (this._chipTimers[seat] <= 0 && this.seatChips[seat]) {
          this.seatChips[seat].classList.remove('perfect', 'solo', 'wrong');
        }
      }
    }

    if (pedalCtrl && pedalCtrl.wasBrake && this._fightStampTimer <= 0 && this.crankFightStamp) {
      this._fightStampTimer = 0.6;
      this._fightHintsShown++;
      if (this.crankFightHint) {
        this.crankFightHint.style.display = this._fightHintsShown <= 2 ? 'block' : 'none';
      }
      this.crankFightStamp.classList.remove('show');
      void this.crankFightStamp.offsetWidth;   // restart the animation
      this.crankFightStamp.classList.add('show');
    } else if (this._fightStampTimer > 0) {
      this._fightStampTimer -= dt;
      if (this._fightStampTimer <= 0 && this.crankFightStamp) {
        this.crankFightStamp.classList.remove('show');
      }
    }

    // Coaching line, in two stages.
    //
    //   1. the rule, until the pair proves they have it;
    //   2. then ONCE, how to call a sprint.
    //
    // Stage 2 exists because a review found the sprint call and the emotes were
    // completely undiscoverable: nothing anywhere told a player the button
    // existed, so E-3 would have produced nothing at a playtest. It is taught
    // after the rhythm rather than with it — a sprint means nothing to a pair
    // who cannot yet pedal together, and two instructions at once is none.
    //
    // Never at the same time as the A-6 coach card — they occupy the same slot
    // above the pedals and say overlapping things. The card goes first: it
    // explains which buttons pedal at all, which comes before rhythm.
    const cardUp = this._coachCardEl === undefined
      ? (this._coachCardEl = document.getElementById('coach-card'))
      : this._coachCardEl;
    if (cardUp && cardUp.classList.contains('show')) {
      this.coopCoach.classList.remove('show');
      return;
    }
    if (this.coopCoach && !this._coachDone) {
      if (this._coachPerfects >= 5) {
        this._coachDone = true;
        // Stage 2: they have the rhythm — now tell them what else they can do.
        if (this._pingHint && !this._pingHintShown) {
          this._pingHintShown = true;
          this._pingHintTimer = 5;
          this.coopCoach.textContent = this._pingHint;
        } else {
          this.coopCoach.classList.remove('show');
        }
      } else {
        this.coopCoach.classList.add('show');
      }
    } else if (this._pingHintTimer > 0) {
      this._pingHintTimer -= dt;
      if (this._pingHintTimer <= 0) this.coopCoach.classList.remove('show');
    }
  }

  /** Called at ride start: the coaching line is per session, not per ride. */
  resetCoopCoaching(showCoach) {
    this._coachPerfects = 0;
    this._coachDone = !showCoach;
    if (this.coopCoach) {
      this.coopCoach.textContent = 'Match your partner’s beat with the opposite foot';
      if (!showCoach) this.coopCoach.classList.remove('show');
    }
  }

  /**
   * E-3 · what to say, once, about the sprint call. Input-specific, because
   * "press Space" is useless to somebody holding a controller.
   */
  setPingHint(text) {
    this._pingHint = text || null;
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
    this.elapsedRow.classList.add('visible');
    this.timerEl.className = '';
    this.timerEl.textContent = '';
    this.elapsedEl.textContent = '\u23F1 0s';
  }

  updateTimer(remaining, total, held = false) {
    // A-6: during the first-segment grace the clock is not running, and saying
    // so is kinder than showing a number that refuses to move.
    if (held) {
      if (this._prevTimerText !== 'held') {
        this._prevTimerText = 'held';
        this.timerEl.textContent = '⏱ —';
        this.timerEl.className = '';
      }
      this.countdownOverlay.classList.remove('visible');
      return;
    }
    this._prevTimerText = null;
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
    this.elapsedRow.classList.remove('visible');
    this.countdownOverlay.classList.remove('visible');
    this.countdownNumber.textContent = '';
    this._lastCountdownSec = -1;
    this.elapsedEl.textContent = '';
  }

  showCollectibles(level, total) {
    const icons = { presents: '\uD83C\uDF81', gems: '\uD83D\uDC8E' }; // 🎁 💎
    // Kept as a field too: GameRecorder redraws this strip into saved clips.
    this.collectibleIconChar = icons[level.collectibles] || '\u2B50';
    this.collectibleIcon.textContent = this.collectibleIconChar;
    // Show the target from the start — "0" alone reads as a stat with no scale.
    this.collectibleCount.textContent = total > 0 ? '0/' + total : '0';
    this.collectibleWrap.classList.add('visible');
  }

  updateCollectibles(collected, total) {
    this.collectibleCount.textContent = collected + '/' + total;
  }

  hideCollectibles() {
    this.collectibleWrap.classList.remove('visible');
  }

  /** Start the geese tally at zero and reveal it in the top strip. */
  showGeese() {
    if (!this.geeseWrap) return;
    this._prevGeese = 0;
    this.geeseCount.textContent = '0';
    this.geeseWrap.classList.add('visible');
  }

  updateGeese(count) {
    if (!this.geeseWrap || count === this._prevGeese) return;
    this._prevGeese = count;
    this.geeseCount.textContent = count;
  }

  hideGeese() {
    if (!this.geeseWrap) return;
    this.geeseWrap.classList.remove('visible');
    this._prevGeese = -1;
  }

  update(bike, input, pedalCtrl, dt, remoteData) {
    this._updateSync(pedalCtrl, dt);
    this._updateSpeedSignals(bike);
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

      // Stoker self-flash: instant visual confirmation of own pedal taps.
      // SharedPedalController.wasCorrect/wasWrong fire on ANY tap (captain OR
      // stoker), so we only attribute a flash to the local pedal button when
      // the local player is actually holding a pedal this frame. Without this
      // gate, a stoker tap (online partner, or P2 keyboard in local MP) would
      // phantom-flash the captain's own big pedal button — which is the bug
      // seen in local MP where pressing P2's arrow key lit up P1's pedal.
      const newCorrect = pedalCtrl.wasCorrect && !this._prevOwnCorrect;
      const newWrong = pedalCtrl.wasWrong && !this._prevOwnWrong;
      this._prevOwnCorrect = !!pedalCtrl.wasCorrect;
      this._prevOwnWrong = !!pedalCtrl.wasWrong;
      if ((newCorrect || newWrong) && (leftHeld || rightHeld)) {
        this._ownFlashTimer = 0.2;
        this._ownFlashFoot = leftHeld ? 'left' : 'right';
        this._ownFlashWrong = newWrong;
      }
      if (this._ownFlashTimer > 0) {
        this._ownFlashTimer -= dt;
        const cls = this._ownFlashWrong ? 'tap-flash-wrong' : 'tap-flash';
        const el = this._ownFlashFoot === 'left' ? this.touchLeftEl : this.touchRightEl;
        if (el) el.classList.add(cls);
        if (this._ownFlashTimer <= 0) {
          this.touchLeftEl.classList.remove('tap-flash', 'tap-flash-wrong');
          this.touchRightEl.classList.remove('tap-flash', 'tap-flash-wrong');
        }
      }
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

    // Partner pedal indicators
    if (remoteData) {
      if (this.partnerPedalUp) this.partnerPedalUp.style.display = 'flex';
      if (this.partnerPedalDown) this.partnerPedalDown.style.display = 'flex';

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
    } else {
      if (this.partnerPedalUp) this.partnerPedalUp.style.display = 'none';
      if (this.partnerPedalDown) this.partnerPedalDown.style.display = 'none';
    }

    // Crash vignette (B-2). Fades over ~1 s, which is the whole length of the
    // fall now, so the screen is clear again before the bike stands up.
    if (bike.fallen && this.crashFlash === 0) {
      this.crashFlash = 1;
      this._setCrashVignette(1);
    }
    if (this.crashFlash > 0) {
      this.crashFlash -= dt * 1.0;
      if (this.crashFlash <= 0) {
        this.crashFlash = 0;
        this._setCrashVignette(0);
      } else {
        this._setCrashVignette(this.crashFlash);
      }
    }
  }
}
