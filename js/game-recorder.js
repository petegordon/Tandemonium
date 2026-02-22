// ============================================================
// GAME RECORDER — rolling buffer, compositing, selfie/partner PiP
// ============================================================

export class GameRecorder {
  constructor(gameCanvas, input) {
    this.gameCanvas = gameCanvas;
    this.input = input || null;
    this.supported = this._checkSupport();

    // Compositing canvas (offscreen, same size as game canvas)
    this.compCanvas = document.createElement('canvas');
    this.compCtx = this.compCanvas.getContext('2d');
    this._syncCanvasSize();

    // MediaRecorder state
    this.recorder = null;
    this._stream = null;
    this._mimeType = '';
    this._pendingBlob = null;  // blob from current recorder cycle
    this._lastBlob = null;     // blob from previous cycle (the one we serve)
    this._cycleInterval = null;
    this.buffering = false;
    this.bufferDuration = 20; // seconds

    // Selfie camera
    this.selfieStream = null;
    this.selfieVideo = document.getElementById('selfie-pip');
    this.selfieWrap = document.getElementById('selfie-pip-wrap');
    this.selfieLabel = document.getElementById('selfie-pip-label');
    this.selfieActive = false;

    // Partner video
    this.partnerStream = null;
    this.partnerVideo = document.getElementById('partner-pip');
    this.partnerWrap = document.getElementById('partner-pip-wrap');
    this.partnerLabel = document.getElementById('partner-pip-label');
    this.partnerActive = false;

    // Audio mixing for clip recording
    this._audioCtx = null;
    this._audioDestination = null;

    // Pedal images (pre-loaded for canvas drawing)
    this._pedalLeftImg = new Image();
    this._pedalLeftImg.src = 'images/pedal_left.png';
    this._pedalRightImg = new Image();
    this._pedalRightImg.src = 'images/pedal_right.png';

    // UI elements
    this.shareBtn = document.getElementById('share-btn');
    this.previewModal = document.getElementById('clip-preview-modal');
    this.previewVideo = document.getElementById('clip-preview');
    this.previewShareBtn = document.getElementById('clip-share-btn');
    this.previewSaveBtn = document.getElementById('clip-save-btn');
    this.previewDiscardBtn = document.getElementById('clip-discard-btn');

    // Current clip blob URL
    this._clipUrl = null;
    this._clipBlob = null;

    // Bind UI events
    if (this.shareBtn) {
      this.shareBtn.addEventListener('click', () => this.saveClip());
    }
    if (this.previewShareBtn) {
      this.previewShareBtn.addEventListener('click', () => this._shareClip());
    }
    if (this.previewSaveBtn) {
      this.previewSaveBtn.addEventListener('click', () => this._downloadClip());
    }
    if (this.previewDiscardBtn) {
      this.previewDiscardBtn.addEventListener('click', () => this._discardClip());
    }

    // Hide share button if not supported
    if (!this.supported && this.shareBtn) {
      this.shareBtn.style.display = 'none';
    }

    // Gamepad navigation for clip preview modal
    this._previewItems = [this.previewShareBtn, this.previewSaveBtn, this.previewDiscardBtn].filter(Boolean);
    this._previewFocusIndex = 0;
    this._previewPollId = null;
    this._gpPrevLeft = false;
    this._gpPrevRight = false;
    this._gpPrevA = false;
    this._gpPrevB = false;

    // Resize listener to keep compositing canvas in sync
    window.addEventListener('resize', () => this._syncCanvasSize());
  }

  // ── Feature detection ──

  _checkSupport() {
    if (typeof MediaRecorder === 'undefined') return false;
    const canvas = document.createElement('canvas');
    if (typeof canvas.captureStream !== 'function') return false;
    return true;
  }

  _getMimeType() {
    // Prefer VP9 WebM (Chrome), fall back to VP8, then MP4 (Safari)
    const types = [
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
      'video/mp4'
    ];
    for (const type of types) {
      if (MediaRecorder.isTypeSupported(type)) return type;
    }
    return '';
  }

  // ── Canvas sync ──

  _syncCanvasSize() {
    this.compCanvas.width = this.gameCanvas.width;
    this.compCanvas.height = this.gameCanvas.height;
  }

  // ── Selfie camera (Phase 2) ──

  async startSelfie() {
    if (this.selfieActive) return;
    try {
      this.selfieStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: 240, height: 240 },
        audio: false
      });
      if (this.selfieVideo) {
        this.selfieVideo.srcObject = this.selfieStream;
        this.selfieVideo.play().catch(() => {});
        if (this.selfieWrap) this.selfieWrap.style.display = 'block';
      }
      this.selfieActive = true;
    } catch (e) {
      // Permission denied or no camera — silent fallback
      this.selfieActive = false;
    }
  }

  stopSelfie() {
    if (this.selfieStream) {
      this.selfieStream.getTracks().forEach(t => t.stop());
      this.selfieStream = null;
    }
    if (this.selfieVideo) {
      this.selfieVideo.srcObject = null;
    }
    if (this.selfieWrap) this.selfieWrap.style.display = 'none';
    this.selfieActive = false;
  }

  // ── Partner video (Phase 3) ──

  setPartnerStream(stream) {
    this.partnerStream = stream;
    if (this.partnerVideo && stream) {
      this.partnerVideo.srcObject = stream;
      this.partnerVideo.play().catch(() => {});
      if (this.partnerWrap) this.partnerWrap.style.display = 'block';
      this.partnerActive = true;
    }
  }

  clearPartnerStream() {
    this.partnerStream = null;
    if (this.partnerVideo) {
      this.partnerVideo.srcObject = null;
    }
    if (this.partnerWrap) this.partnerWrap.style.display = 'none';
    this.partnerActive = false;
  }

  setLabels(mode) {
    const selfieText = mode === 'captain' ? 'CAPTAIN' : (mode === 'stoker' ? 'STOKER' : 'YOU');
    const partnerText = mode === 'captain' ? 'STOKER' : 'CAPTAIN';
    if (this.selfieLabel) this.selfieLabel.textContent = selfieText;
    if (this.partnerLabel) this.partnerLabel.textContent = partnerText;
  }

  // ── Audio mixing for clip recording ──

  addAudioStreams(localStream, remoteStream) {
    if (!this._stream) return;
    try {
      this._audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      this._audioDestination = this._audioCtx.createMediaStreamDestination();

      if (localStream) {
        const localAudio = localStream.getAudioTracks();
        if (localAudio.length > 0) {
          this._audioCtx.createMediaStreamSource(new MediaStream(localAudio))
            .connect(this._audioDestination);
        }
      }
      if (remoteStream) {
        const remoteAudio = remoteStream.getAudioTracks();
        if (remoteAudio.length > 0) {
          this._audioCtx.createMediaStreamSource(new MediaStream(remoteAudio))
            .connect(this._audioDestination);
        }
      }

      for (const track of this._audioDestination.stream.getAudioTracks()) {
        this._stream.addTrack(track);
      }
    } catch (e) {
      console.warn('Audio mix for recording failed:', e);
    }
  }

  // ── Rolling buffer ──
  // Strategy: run MediaRecorder with NO timeslice (one blob per stop).
  // Cycle every 20s: stop → save blob as _lastBlob → start fresh recorder.
  // Each blob is a complete, self-contained video file with proper headers.

  startBuffer() {
    if (!this.supported || this.buffering) return;

    this._syncCanvasSize();
    this._stream = this.compCanvas.captureStream(30);
    this._mimeType = this._getMimeType();
    if (!this._mimeType) return;

    this._pendingBlob = null;
    this._lastBlob = null;
    this.buffering = true;

    this._startFreshRecorder();

    // Cycle the recorder every bufferDuration seconds
    this._cycleInterval = setInterval(() => this._cycleRecorder(), this.bufferDuration * 1000);

    // Show share button
    if (this.shareBtn) this.shareBtn.style.display = 'block';
  }

  _startFreshRecorder() {
    if (!this._stream || !this._mimeType) return;

    try {
      this.recorder = new MediaRecorder(this._stream, {
        mimeType: this._mimeType,
        videoBitsPerSecond: 2500000
      });
    } catch (e) {
      try {
        this.recorder = new MediaRecorder(this._stream, { mimeType: this._mimeType });
      } catch (e2) {
        return;
      }
    }

    this.recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        this._pendingBlob = e.data;
      }
    };

    this.recorder.start(); // No timeslice — one complete blob per stop()
  }

  _cycleRecorder() {
    if (!this.recorder || this.recorder.state !== 'recording') return;

    this.recorder.addEventListener('stop', () => {
      // Previous cycle's blob becomes the serveable clip
      this._lastBlob = this._pendingBlob;
      this._pendingBlob = null;
      this._startFreshRecorder();
    }, { once: true });

    this.recorder.stop();
  }

  stopBuffer() {
    if (this._cycleInterval) {
      clearInterval(this._cycleInterval);
      this._cycleInterval = null;
    }
    if (this.recorder && this.recorder.state !== 'inactive') {
      try { this.recorder.stop(); } catch (e) {}
    }
    this.recorder = null;
    this._stream = null;
    this.buffering = false;
    this._pendingBlob = null;
    this._lastBlob = null;

    // Hide share button (unless preview modal is open)
    if (this.shareBtn && !this._clipUrl) {
      this.shareBtn.style.display = 'none';
    }
  }

  // ── Compositing (called every frame) ──

  composite(state) {
    if (!this.buffering) return;

    const ctx = this.compCtx;
    const w = this.compCanvas.width;
    const h = this.compCanvas.height;
    const s = w / 375; // scale factor (designed for 375px wide portrait)

    // Draw game canvas
    ctx.drawImage(this.gameCanvas, 0, 0, w, h);

    // ── Speed dashboard (top-left, matches #hud-dashboard) ──
    this._drawSpeedDashboard(ctx, s, state);

    // ── Pedal buttons (bottom, matches .pedal-touch) ──
    this._drawPedalButtons(ctx, w, h, s, state);

    // ── Gauges (YOU + BIKE, centered above pedals) ──
    this._drawGauges(ctx, w, h, s, state);

    // ── Partner pedal indicators (wider apart, flanking partner label) ──
    if (state.hasPartner) {
      this._drawPartnerIndicators(ctx, w, h, s, state);
    }

    // ── Selfie PiP (top-right corner of recording) ──
    if (this.selfieActive && this.selfieVideo && this.selfieVideo.readyState >= 2) {
      const selfieLabel = state.mode === 'captain' ? 'CAPTAIN' : (state.mode === 'stoker' ? 'STOKER' : 'YOU');
      this._drawCircularPiP(ctx, this.selfieVideo, w, h, 'right', selfieLabel);
    }

    // ── Partner PiP (left of selfie, top-right area) ──
    if (this.partnerActive && this.partnerVideo && this.partnerVideo.readyState >= 2) {
      const partnerLabel = state.mode === 'captain' ? 'STOKER' : 'CAPTAIN';
      this._drawCircularPiP(ctx, this.partnerVideo, w, h, 'left', partnerLabel);
    }

    // ── Role label at bottom center ──
    if (state.mode === 'captain' || state.mode === 'stoker') {
      ctx.save();
      const fontSize = Math.round(10 * s);
      ctx.font = 'bold ' + fontSize + 'px Helvetica Neue, Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillText(state.mode.toUpperCase(), w / 2 + 1, h - 3 * s + 1);
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.fillText(state.mode.toUpperCase(), w / 2, h - 3 * s);
      ctx.restore();
    }

    // ── Watermark ──
    ctx.save();
    ctx.font = Math.round(9 * s) + 'px Helvetica Neue, Arial, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillText('TANDEMONIUM', w - 12 * s, h - 8 * s);
    ctx.restore();
  }

  // ── Speed dashboard — replicates #hud-dashboard ──

  _drawSpeedDashboard(ctx, s, state) {
    const kmh = Math.round((state.speed || 0) * 3.6);
    const maxKmh = 58;
    const dist = state.distance || 0;
    const distText = dist >= 1000 ? (dist / 1000).toFixed(1) + ' km' : Math.round(dist) + ' m';

    // Speed color coding (matches HUD)
    let speedColor = '#ffffff';
    let barColor = '#ffffff';
    if (kmh > 35) { speedColor = '#00e040'; barColor = '#00e040'; }
    else if (kmh > 15) { speedColor = '#88ff88'; barColor = '#88ff88'; }

    // Dashboard card dimensions
    const px = 14 * s;
    const py = 10 * s;
    const padH = 8 * s;
    const padV = 8 * s;
    const speedFontSize = Math.round(28 * s);
    const unitFontSize = Math.round(11 * s);
    const distFontSize = Math.round(11 * s);
    const barH = 4 * s;
    const lineGap = 3 * s;

    // Measure text to size the card
    ctx.font = 'bold ' + speedFontSize + 'px Helvetica Neue, Arial, sans-serif';
    const speedTextW = ctx.measureText('' + kmh).width;
    ctx.font = '600 ' + unitFontSize + 'px Helvetica Neue, Arial, sans-serif';
    const unitTextW = ctx.measureText('km/h').width;
    const rowW = speedTextW + 4 * s + unitTextW;
    ctx.font = '500 ' + distFontSize + 'px Helvetica Neue, Arial, sans-serif';
    const distTextW = ctx.measureText(distText).width;
    const cardW = Math.max(rowW, distTextW) + padH * 2;
    const cardH = speedFontSize + lineGap + barH + lineGap + distFontSize + padV * 2;

    // Card background (rgba(0,0,0,0.45) + border)
    ctx.save();
    this._roundRect(ctx, px, py, cardW, cardH, 12 * s,
      'rgba(0,0,0,0.45)', 'rgba(255,255,255,0.12)', 1);

    // Speed value
    let cy = py + padV;
    ctx.font = 'bold ' + speedFontSize + 'px Helvetica Neue, Arial, sans-serif';
    ctx.fillStyle = speedColor;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillText('' + kmh, px + padH, cy);

    // "km/h" unit
    ctx.font = '600 ' + unitFontSize + 'px Helvetica Neue, Arial, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.textBaseline = 'bottom';
    ctx.fillText('km/h', px + padH + speedTextW + 4 * s, cy + speedFontSize);

    // Speed bar
    cy += speedFontSize + lineGap;
    const barW = cardW - padH * 2;
    // Bar track
    this._roundRect(ctx, px + padH, cy, barW, barH, 2 * s,
      'rgba(255,255,255,0.1)', 'transparent', 0);
    // Bar fill
    const fillW = Math.min(1, kmh / maxKmh) * barW;
    if (fillW > 0) {
      this._roundRect(ctx, px + padH, cy, fillW, barH, 2 * s,
        barColor, 'transparent', 0);
    }

    // Distance
    cy += barH + lineGap;
    ctx.font = '500 ' + distFontSize + 'px Helvetica Neue, Arial, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.textBaseline = 'top';
    ctx.fillText(distText, px + padH, cy);

    ctx.restore();
  }

  // ── Pedal buttons — replicates .pedal-touch with gradient + 3D shadow ──

  _drawPedalButtons(ctx, w, h, s, state) {
    const btnW = w * 0.44;
    const btnH = Math.min(Math.max(80 * s, h * 0.12), 140 * s);
    const gap = 10 * s;
    const radius = 24 * s;
    const bottomPad = 8 * s;
    const lx = (w - gap) / 2 - btnW;
    const rx = (w + gap) / 2;
    const by = h - bottomPad - btnH;
    const lw = 2.5 * s;

    // State-dependent styles per button
    const btnStyles = (pressed, isLeft, pedalState) => {
      if (pedalState === 'brake') {
        return {
          gradTop: 'rgba(230,170,20,0.5)', gradBot: 'rgba(180,130,15,0.35)',
          border: 'rgba(220,160,20,0.8)', shadowColor: 'rgba(220,160,20,0.3)', down: true
        };
      }
      if (pressed && pedalState === 'wrong') {
        return {
          gradTop: 'rgba(230,60,40,0.5)', gradBot: 'rgba(180,40,30,0.35)',
          border: 'rgba(220,60,40,0.8)', shadowColor: 'rgba(220,60,40,0.3)', down: true
        };
      }
      if (pressed) {
        return {
          gradTop: 'rgba(60,220,80,0.5)', gradBot: 'rgba(40,160,50,0.35)',
          border: 'rgba(60,200,80,0.8)', shadowColor: 'rgba(60,200,80,0.3)', down: true
        };
      }
      return {
        gradTop: 'rgba(255,255,255,0.22)', gradBot: 'rgba(255,255,255,0.08)',
        border: isLeft ? 'rgba(100,160,255,0.4)' : 'rgba(255,160,60,0.4)',
        shadowColor: 'rgba(0,0,0,0.2)', down: false
      };
    };

    const drawBtn = (bx, pressed, isLeft) => {
      const st = btnStyles(pressed, isLeft, state.pedalState);
      const yOff = st.down ? 2 * s : 0;

      ctx.save();

      // Drop shadow beneath button (3D effect)
      if (!st.down) {
        this._roundRect(ctx, bx, by + 4 * s, btnW, btnH, radius,
          'rgba(0,0,0,0.25)', 'transparent', 0);
      }

      // Button body with gradient
      const grad = ctx.createLinearGradient(bx, by + yOff, bx, by + yOff + btnH);
      grad.addColorStop(0, st.gradTop);
      grad.addColorStop(1, st.gradBot);
      this._roundRect(ctx, bx, by + yOff, btnW, btnH, radius, grad, st.border, lw);

      // Top inner highlight
      ctx.globalAlpha = st.down ? 0.15 : 0.3;
      ctx.beginPath();
      const hlY = by + yOff + lw;
      ctx.moveTo(bx + radius, hlY);
      ctx.lineTo(bx + btnW - radius, hlY);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.globalAlpha = 1;

      // Outer glow for pressed states
      if (st.down) {
        ctx.shadowColor = st.shadowColor;
        ctx.shadowBlur = 6 * s;
        this._roundRectPath(ctx, bx, by + yOff, btnW, btnH, radius);
        ctx.strokeStyle = 'transparent';
        ctx.lineWidth = 0;
        ctx.stroke();
        ctx.shadowBlur = 0;
      }

      // Pedal foot image (centered, 95% of button area)
      const img = isLeft ? this._pedalLeftImg : this._pedalRightImg;
      if (img && img.complete && img.naturalWidth > 0) {
        const pad = 2 * s;
        const availW = btnW - pad * 2;
        const availH = btnH - pad * 2;
        const imgAspect = img.naturalWidth / img.naturalHeight;
        let imgW, imgH;
        if (availW / availH > imgAspect) {
          imgH = availH * 0.95;
          imgW = imgH * imgAspect;
        } else {
          imgW = availW * 0.95;
          imgH = imgW / imgAspect;
        }
        const imgX = bx + (btnW - imgW) / 2;
        const imgY = by + yOff + (btnH - imgH) / 2;
        ctx.globalAlpha = 0.85;
        ctx.drawImage(img, imgX, imgY, imgW, imgH);
        ctx.globalAlpha = 1;
      }

      // "L" or "R" label (top corner)
      ctx.font = 'bold ' + Math.round(10 * s) + 'px Helvetica Neue, Arial, sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.3)';
      ctx.textBaseline = 'top';
      if (isLeft) {
        ctx.textAlign = 'left';
        ctx.fillText('L', bx + 10 * s, by + yOff + 6 * s);
      } else {
        ctx.textAlign = 'right';
        ctx.fillText('R', bx + btnW - 10 * s, by + yOff + 6 * s);
      }

      ctx.restore();
    };

    drawBtn(lx, state.leftPressed, true);
    drawBtn(rx, state.rightPressed, false);
  }

  // ── Gauges — replicates .gauge-wrap (YOU + BIKE, optionally PARTNER) ──

  _drawGauges(ctx, w, h, s, state) {
    const btnH = Math.min(Math.max(80 * s, h * 0.12), 140 * s);
    const bottomPad = 8 * s;
    const pedalTop = h - bottomPad - btnH;
    const gaugeSize = 54 * s;
    const gaugeGap = 6 * s;

    // Position gauges above pedal buttons, centered
    const gaugeY = pedalTop - gaugeGap - gaugeSize;

    if (state.hasPartner) {
      // 3 gauges: YOU | BIKE | PARTNER
      const totalW = gaugeSize * 3 + gaugeGap * 2;
      const startX = (w - totalW) / 2;
      this._drawSingleGauge(ctx, startX, gaugeY, gaugeSize, s, 'YOU', state.youDeg, '#fa3', 'green', 0);
      this._drawSingleGauge(ctx, startX + gaugeSize + gaugeGap, gaugeY, gaugeSize, s, 'BIKE', state.bikeDeg, '#4af', 'red', state.bikeDanger);
      this._drawSingleGauge(ctx, startX + (gaugeSize + gaugeGap) * 2, gaugeY, gaugeSize, s,
        state.mode === 'captain' ? 'STOKER' : 'CAPTAIN', state.partnerDeg, '#a6f', 'purple', 0);
    } else {
      // 2 gauges: YOU | BIKE
      const totalW = gaugeSize * 2 + gaugeGap;
      const startX = (w - totalW) / 2;
      this._drawSingleGauge(ctx, startX, gaugeY, gaugeSize, s, 'YOU', state.youDeg, '#fa3', 'green', 0);
      this._drawSingleGauge(ctx, startX + gaugeSize + gaugeGap, gaugeY, gaugeSize, s, 'BIKE', state.bikeDeg, '#4af', 'red', state.bikeDanger);
    }
  }

  _drawSingleGauge(ctx, gx, gy, size, s, title, needleDeg, needleColor, sectorType, danger) {
    const cx = gx + size / 2;
    const cy = gy + size / 2;
    const r = size * 52 / 120; // matches SVG r=52 in viewBox 120

    ctx.save();

    // Background circle
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 1.5 * s;
    ctx.stroke();

    // Sector zones
    if (sectorType === 'green') {
      // Right safe zone (45° to 135° from top = π/4 to 3π/4 from right)
      ctx.fillStyle = 'rgba(0,180,0,0.2)';
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, -Math.PI * 3 / 4, -Math.PI / 4);
      ctx.closePath();
      ctx.fill();
      // Left safe zone
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, Math.PI / 4, Math.PI * 3 / 4);
      ctx.closePath();
      ctx.fill();
    } else if (sectorType === 'red') {
      // Danger zones at sides (horizontal = tipped over)
      ctx.fillStyle = 'rgba(255,50,50,0.25)';
      // Left danger
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, Math.PI * 0.55, Math.PI * 0.8);
      ctx.closePath();
      ctx.fill();
      // Right danger
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, -Math.PI * 0.8, -Math.PI * 0.55);
      ctx.closePath();
      ctx.fill();
    } else if (sectorType === 'purple') {
      ctx.fillStyle = 'rgba(170,102,255,0.15)';
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, -Math.PI * 3 / 4, -Math.PI / 4);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, Math.PI / 4, Math.PI * 3 / 4);
      ctx.closePath();
      ctx.fill();
    }

    // Top tick mark
    const tickLen = size * 9 / 120;
    ctx.beginPath();
    ctx.moveTo(cx, gy + size * 9 / 120);
    ctx.lineTo(cx, gy + size * 18 / 120);
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 1.2 * s;
    ctx.stroke();

    // Red danger ticks for BIKE gauge
    if (sectorType === 'red') {
      ctx.strokeStyle = 'rgba(255,50,50,0.5)';
      ctx.lineWidth = 0.8 * s;
      const drawTick = (ang, inner, outer) => {
        const a = (ang - 90) * Math.PI / 180;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * r * outer, cy + Math.sin(a) * r * outer);
        ctx.lineTo(cx + Math.cos(a) * r * inner, cy + Math.sin(a) * r * inner);
        ctx.stroke();
      };
      drawTick(-60, 0.75, 0.95);
      drawTick(60, 0.75, 0.95);
      drawTick(-75, 0.8, 0.95);
      drawTick(75, 0.8, 0.95);
    }

    // Needle (rotated)
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(needleDeg * Math.PI / 180);
    const needleW = 2.2 * s;
    // Left arm
    ctx.beginPath();
    ctx.moveTo(-r * 0.7, 0);
    ctx.lineTo(-r * 0.2, 0);
    ctx.strokeStyle = needleColor;
    ctx.lineWidth = needleW;
    ctx.lineCap = 'round';
    ctx.stroke();
    // Right arm
    ctx.beginPath();
    ctx.moveTo(r * 0.2, 0);
    ctx.lineTo(r * 0.7, 0);
    ctx.stroke();
    // Center ring
    ctx.beginPath();
    ctx.arc(0, 0, 3 * s, 0, Math.PI * 2);
    ctx.strokeStyle = needleColor;
    ctx.lineWidth = 1.5 * s;
    ctx.stroke();
    // Center crosshair lines
    ctx.lineWidth = 1.2 * s;
    ctx.beginPath(); ctx.moveTo(-3 * s, 0); ctx.lineTo(-r * 0.2, 0); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(3 * s, 0); ctx.lineTo(r * 0.2, 0); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, -3 * s); ctx.lineTo(0, -r * 0.18); ctx.stroke();
    ctx.restore();

    // Top pointer triangle
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.beginPath();
    ctx.moveTo(cx, gy + size * 10 / 120);
    ctx.lineTo(cx - 2.5 * s, gy + size * 16 / 120);
    ctx.lineTo(cx + 2.5 * s, gy + size * 16 / 120);
    ctx.closePath();
    ctx.fill();

    // Title text above gauge
    ctx.font = '600 ' + Math.round(7 * s) + 'px Helvetica Neue, Arial, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(title, cx, gy - 1 * s);

    // Degree label below gauge
    const degText = Math.abs(needleDeg).toFixed(1) + '\u00B0';
    let labelColor = '#fff';
    if (sectorType === 'red') {
      if (danger > 0.75) labelColor = '#ff4444';
      else if (danger > 0.5) labelColor = '#ffaa22';
    }
    ctx.font = 'bold ' + Math.round(9 * s) + 'px Helvetica Neue, Arial, sans-serif';
    ctx.fillStyle = labelColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.shadowColor = 'rgba(0,0,0,0.7)';
    ctx.shadowBlur = 2 * s;
    ctx.fillText(degText, cx, gy + size + 1 * s);
    ctx.shadowBlur = 0;

    ctx.restore();
  }

  // ── Partner pedal indicators — wider apart with partner role label ──

  _drawPartnerIndicators(ctx, w, h, s, state) {
    const btnH = Math.min(Math.max(80 * s, h * 0.12), 140 * s);
    const bottomPad = 8 * s;
    const pedalTop = h - bottomPad - btnH;
    const gaugeSize = 54 * s;
    const gaugeGap = 6 * s;
    // Indicators sit at same Y as gauges, flanking the gauge row
    const gaugeY = pedalTop - gaugeGap - gaugeSize;

    const indW = 28 * s;
    const indH = 54 * s;
    const indR = 8 * s;

    // Position: wider apart — outside the 3-gauge row
    const totalGaugeW = gaugeSize * 3 + gaugeGap * 2;
    const gaugeStartX = (w - totalGaugeW) / 2;
    const upX = gaugeStartX - indW - 6 * s;
    const downX = gaugeStartX + totalGaugeW + 6 * s;
    const indY = gaugeY;

    const drawInd = (ix, iy, isUp, isFlash, isWrong) => {
      let bg, border;
      if (isFlash && isWrong) {
        bg = 'rgba(220,60,40,0.5)'; border = 'rgba(220,60,40,0.8)';
      } else if (isFlash) {
        bg = 'rgba(170,102,255,0.5)'; border = 'rgba(170,102,255,0.8)';
      } else {
        bg = 'rgba(170,102,255,0.08)'; border = 'rgba(170,102,255,0.2)';
      }

      ctx.save();

      // Glow on flash
      if (isFlash) {
        ctx.shadowColor = isWrong ? 'rgba(220,60,40,0.5)' : 'rgba(170,102,255,0.5)';
        ctx.shadowBlur = 8 * s;
      }

      this._roundRect(ctx, ix, iy, indW, indH, indR, bg, border, 1.5 * s);
      ctx.shadowBlur = 0;

      // Arrow character
      ctx.font = 'bold ' + Math.round(16 * s) + 'px Helvetica Neue, Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = isFlash ? '#fff' : 'rgba(170,102,255,0.4)';
      ctx.fillText(isUp ? '\u25B2' : '\u25BC', ix + indW / 2, iy + indH / 2);

      ctx.restore();
    };

    drawInd(upX, indY, true, state.partnerUpFlash, state.partnerFlashWrong);
    drawInd(downX, indY, false, state.partnerDownFlash, state.partnerFlashWrong);

    // Partner role label between indicators, just above them
    const partnerRole = state.mode === 'captain' ? 'STOKER' : 'CAPTAIN';
    ctx.save();
    ctx.font = '600 ' + Math.round(7 * s) + 'px Helvetica Neue, Arial, sans-serif';
    ctx.fillStyle = 'rgba(170,102,255,0.6)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(partnerRole, w / 2, indY - 2 * s);
    ctx.restore();
  }

  // ── Clip preview gamepad navigation ──

  _startPreviewGamepadNav() {
    // Build visible items list (SHARE may be hidden)
    this._previewItems = [this.previewShareBtn, this.previewSaveBtn, this.previewDiscardBtn]
      .filter(el => el && el.style.display !== 'none');
    this._previewFocusIndex = 0;
    this._gpPrevUp = false;
    this._gpPrevDown = false;
    this._gpPrevLeft = false;
    this._gpPrevRight = false;
    this._gpPrevA = false;
    this._gpPrevB = false;

    // Prime edge-detect from current gamepad state
    if (this.input && this.input.gamepadConnected) {
      const gp = (navigator.getGamepads())[this.input.gamepadIndex];
      if (gp) {
        this._gpPrevUp = (gp.buttons[12] && gp.buttons[12].pressed) || gp.axes[1] < -0.5;
        this._gpPrevDown = (gp.buttons[13] && gp.buttons[13].pressed) || gp.axes[1] > 0.5;
        this._gpPrevLeft = (gp.buttons[14] && gp.buttons[14].pressed) || gp.axes[0] < -0.5;
        this._gpPrevRight = (gp.buttons[15] && gp.buttons[15].pressed) || gp.axes[0] > 0.5;
        this._gpPrevA = gp.buttons[0] && gp.buttons[0].pressed;
        this._gpPrevB = gp.buttons[1] && gp.buttons[1].pressed;
      }
    }

    this._applyPreviewFocus();
    this._pollPreviewGamepad();
  }

  _stopPreviewGamepadNav() {
    if (this._previewPollId) {
      cancelAnimationFrame(this._previewPollId);
      this._previewPollId = null;
    }
    this._clearPreviewFocus();
  }

  _pollPreviewGamepad() {
    this._previewPollId = requestAnimationFrame(() => this._pollPreviewGamepad());

    if (!this.input || !this.input.gamepadConnected) return;
    const gp = (navigator.getGamepads())[this.input.gamepadIndex];
    if (!gp) return;

    const up = (gp.buttons[12] && gp.buttons[12].pressed) || gp.axes[1] < -0.5;
    const down = (gp.buttons[13] && gp.buttons[13].pressed) || gp.axes[1] > 0.5;
    const left = (gp.buttons[14] && gp.buttons[14].pressed) || gp.axes[0] < -0.5;
    const right = (gp.buttons[15] && gp.buttons[15].pressed) || gp.axes[0] > 0.5;
    const a = gp.buttons[0] && gp.buttons[0].pressed;
    const b = gp.buttons[1] && gp.buttons[1].pressed;

    // Both axes navigate the button list (buttons wrap vertically on narrow screens)
    if ((up && !this._gpPrevUp) || (left && !this._gpPrevLeft)) this._movePreviewFocus(-1);
    if ((down && !this._gpPrevDown) || (right && !this._gpPrevRight)) this._movePreviewFocus(1);
    if (a && !this._gpPrevA) this._confirmPreviewFocus();
    if (b && !this._gpPrevB) this._discardClip();

    this._gpPrevUp = up;
    this._gpPrevDown = down;
    this._gpPrevLeft = left;
    this._gpPrevRight = right;
    this._gpPrevA = a;
    this._gpPrevB = b;
  }

  _movePreviewFocus(dir) {
    if (!this._previewItems.length) return;
    this._clearPreviewFocus();
    this._previewFocusIndex = Math.max(0, Math.min(this._previewItems.length - 1, this._previewFocusIndex + dir));
    this._applyPreviewFocus();
  }

  _confirmPreviewFocus() {
    const el = this._previewItems[this._previewFocusIndex];
    if (el) el.click();
  }

  _applyPreviewFocus() {
    const el = this._previewItems[this._previewFocusIndex];
    if (el) el.classList.add('gamepad-focus');
  }

  _clearPreviewFocus() {
    for (const el of this._previewItems) {
      if (el) el.classList.remove('gamepad-focus');
    }
  }

  // ── Canvas drawing helpers ──

  _roundRect(ctx, x, y, w, h, r, fill, stroke, lineWidth) {
    ctx.save();
    this._roundRectPath(ctx, x, y, w, h, r);
    if (typeof fill === 'object' && fill instanceof CanvasGradient) {
      ctx.fillStyle = fill;
    } else {
      ctx.fillStyle = fill;
    }
    ctx.fill();
    if (stroke && stroke !== 'transparent' && lineWidth > 0) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = lineWidth;
      ctx.stroke();
    }
    ctx.restore();
  }

  _roundRectPath(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  _drawCircularPiP(ctx, videoEl, canvasW, canvasH, side, label) {
    const sc = canvasW / 375;
    const size = Math.round(80 * sc);
    const margin = Math.round(14 * sc);
    const borderWidth = 2.5 * sc;
    // Position at top-right of canvas (selfie right, partner left of selfie)
    const topPad = 14 * sc;
    const x = side === 'left' ? canvasW - margin - size - 6 * sc - size / 2 : canvasW - margin - size / 2;
    const y = topPad + size / 2;

    ctx.save();

    // Circular clip
    ctx.beginPath();
    ctx.arc(x, y, size / 2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();

    // Draw video scaled to fill circle
    const vw = videoEl.videoWidth || size;
    const vh = videoEl.videoHeight || size;
    const scale = Math.max(size / vw, size / vh);
    const dw = vw * scale;
    const dh = vh * scale;
    ctx.drawImage(videoEl, x - dw / 2, y - dh / 2, dw, dh);

    ctx.restore();

    // White border ring
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, size / 2, 0, Math.PI * 2);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = borderWidth;
    ctx.stroke();
    ctx.restore();

    // Role label below circle
    if (label) {
      ctx.save();
      const fontSize = Math.round(9 * sc);
      ctx.font = 'bold ' + fontSize + 'px Helvetica Neue, Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillText(label, x + 1, y + size / 2 + 4 * sc + 1);
      ctx.fillStyle = '#fff';
      ctx.fillText(label, x, y + size / 2 + 4 * sc);
      ctx.restore();
    }
  }

  // ── Save clip ──

  saveClip() {
    if (!this.buffering || !this.recorder) return;

    // Stop the cycle timer while we handle the save
    if (this._cycleInterval) {
      clearInterval(this._cycleInterval);
      this._cycleInterval = null;
    }

    // Stop current recorder to get its blob
    this.recorder.addEventListener('stop', () => {
      // Prefer the last full 20s cycle; fall back to current partial segment
      const blob = this._lastBlob || this._pendingBlob;
      if (blob) {
        this._clipBlob = blob;
        this._clipUrl = URL.createObjectURL(blob);
        this._showPreview();
      }

      // Reset and restart buffer immediately
      this._pendingBlob = null;
      this._lastBlob = null;
      this._startFreshRecorder();
      this._cycleInterval = setInterval(() => this._cycleRecorder(), this.bufferDuration * 1000);
    }, { once: true });

    try {
      this.recorder.stop();
    } catch (e) {
      // Fallback: use last completed cycle's blob
      const blob = this._lastBlob;
      if (blob) {
        this._clipBlob = blob;
        this._clipUrl = URL.createObjectURL(blob);
        this._showPreview();
      }
      this._pendingBlob = null;
      this._lastBlob = null;
      this._startFreshRecorder();
      this._cycleInterval = setInterval(() => this._cycleRecorder(), this.bufferDuration * 1000);
    }
  }

  _showPreview() {
    if (!this.previewModal || !this.previewVideo || !this._clipUrl) return;

    this.previewVideo.src = this._clipUrl;
    this.previewVideo.play().catch(() => {});
    this.previewModal.classList.add('visible');

    // Only show SHARE on actual mobile/tablet where the native share sheet
    // is useful; on desktop it just falls back to download (same as SAVE).
    // Use UA + screen heuristic since ontouchstart is unreliable on desktop.
    if (this.previewShareBtn) {
      const ua = navigator.userAgent;
      const isMobile = /Android|iPhone|iPad|iPod/i.test(ua) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
      const canShare = isMobile && navigator.share && navigator.canShare;
      this.previewShareBtn.style.display = canShare ? '' : 'none';
    }

    // Start gamepad navigation for preview buttons
    this._startPreviewGamepadNav();
  }

  async _shareClip() {
    if (!this._clipBlob) return;

    const ext = this._clipBlob.type.includes('mp4') ? 'mp4' : 'webm';
    const file = new File([this._clipBlob], 'tandemonium-clip.' + ext, {
      type: this._clipBlob.type
    });

    try {
      if (navigator.share && navigator.canShare({ files: [file] })) {
        await navigator.share({
          title: 'Tandemonium Clip',
          files: [file]
        });
      } else {
        // Fallback to download
        this._downloadClip();
      }
    } catch (e) {
      if (e.name !== 'AbortError') {
        this._downloadClip();
      }
    }
  }

  _downloadClip() {
    if (!this._clipUrl) return;

    const ext = this._clipBlob && this._clipBlob.type.includes('mp4') ? 'mp4' : 'webm';
    const a = document.createElement('a');
    a.href = this._clipUrl;
    a.download = 'tandemonium-clip.' + ext;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  _discardClip() {
    this._stopPreviewGamepadNav();
    if (this._clipUrl) {
      URL.revokeObjectURL(this._clipUrl);
      this._clipUrl = null;
    }
    this._clipBlob = null;
    if (this.previewVideo) {
      this.previewVideo.pause();
      this.previewVideo.src = '';
    }
    if (this.previewModal) {
      this.previewModal.classList.remove('visible');
    }
  }

  // ── Cleanup ──

  destroy() {
    this.stopBuffer();
    this.stopSelfie();
    this.clearPartnerStream();
    this._discardClip();
    if (this._audioCtx) { this._audioCtx.close().catch(() => {}); this._audioCtx = null; }
  }
}
