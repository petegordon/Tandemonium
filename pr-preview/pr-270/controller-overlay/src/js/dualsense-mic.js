// ============================================================
// DUALSENSE MICROPHONE
// ============================================================
//
// Captures audio from the DualSense's built-in microphone. Over Bluetooth
// the audio comes through the OS HFP gateway; over USB it's USB Audio
// Class. Either way it's a standard MediaStream, opened against the
// deviceId supplied by AudioDeviceManager.
//
// Exposes:
//   - A level (0..1) sampled from an AnalyserNode for visualization.
//   - An enabled toggle that honors the hardware mute button state —
//     disabling the MediaStreamTrack stops audio from leaving the
//     controller, matching what the HW mute LED is telling the user.
//   - Optional passthrough: route captured audio to a user-chosen sink
//     (default system output) for mic-monitor use.
//
// Chromium applies echo cancellation, noise suppression and auto-gain
// by default. We turn them off — the DualSense's capture is clean enough
// and AGC bouncing the level meter would be distracting for streamers.

export class DualSenseMic extends EventTarget {
  constructor() {
    super();
    this._deviceId = null;
    this._stream = null;
    this._track = null;
    this._ctx = null;
    this._source = null;
    this._analyser = null;
    this._passthroughGain = null;
    this._timeDomain = null;
    this._level = 0;
    this._passthrough = false;
  }

  get level() { return this._level; }
  get isOpen() { return !!this._stream; }
  get deviceId() { return this._deviceId; }

  async open(deviceId) {
    if (this._stream && this._deviceId === deviceId) return;
    if (this._stream) await this.close();

    const constraints = {
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    };

    this._stream = await navigator.mediaDevices.getUserMedia(constraints);
    this._track = this._stream.getAudioTracks()[0] || null;
    this._deviceId = deviceId || null;

    // Lazily create the AudioContext on open so browsers that gate it
    // behind a user gesture don't throw at module load. Overlay UI does
    // require a user gesture to toggle the mic panel, which unblocks it.
    this._ctx = new (window.AudioContext || window.webkitAudioContext)();
    this._source = this._ctx.createMediaStreamSource(this._stream);

    this._analyser = this._ctx.createAnalyser();
    this._analyser.fftSize = 1024;
    this._analyser.smoothingTimeConstant = 0.4;
    this._timeDomain = new Uint8Array(this._analyser.fftSize);
    this._source.connect(this._analyser);

    // Passthrough path — connects source → gain → destination. Gain is
    // held at 0 until enabled, so the node stays in the graph (audio
    // hardware resampling + connection can take tens of ms to engage).
    this._passthroughGain = this._ctx.createGain();
    this._passthroughGain.gain.value = 0;
    this._source.connect(this._passthroughGain);
    this._passthroughGain.connect(this._ctx.destination);

    this.dispatchEvent(new CustomEvent('open', { detail: { deviceId: this._deviceId } }));
  }

  async close() {
    if (this._passthroughGain) {
      try { this._passthroughGain.disconnect(); } catch (e) { /* ok */ }
      this._passthroughGain = null;
    }
    if (this._analyser) {
      try { this._analyser.disconnect(); } catch (e) { /* ok */ }
      this._analyser = null;
    }
    if (this._source) {
      try { this._source.disconnect(); } catch (e) { /* ok */ }
      this._source = null;
    }
    if (this._ctx) {
      try { await this._ctx.close(); } catch (e) { /* ok */ }
      this._ctx = null;
    }
    if (this._stream) {
      for (const t of this._stream.getTracks()) t.stop();
      this._stream = null;
    }
    this._track = null;
    this._deviceId = null;
    this._level = 0;
    this._passthrough = false;
    this.dispatchEvent(new CustomEvent('close'));
  }

  /**
   * Mirror the DualSense mute button state onto the MediaStreamTrack.
   * When disabled, silence is transmitted downstream regardless of what
   * the mic is actually picking up — matching the HW mute LED.
   */
  setEnabled(enabled) {
    if (this._track) this._track.enabled = !!enabled;
  }

  get enabled() {
    return this._track ? this._track.enabled : false;
  }

  /**
   * Route mic audio to the system default output for real-time monitor.
   * No-op when mic isn't open.
   */
  setPassthrough(on) {
    this._passthrough = !!on;
    if (this._passthroughGain) {
      // Ramp to avoid a click when toggling at the hardware boundary.
      const t = this._ctx.currentTime;
      this._passthroughGain.gain.cancelScheduledValues(t);
      this._passthroughGain.gain.setTargetAtTime(on ? 1 : 0, t, 0.01);
    }
  }

  get passthrough() { return this._passthrough; }

  /**
   * Call once per animation frame (or less) to update .level. Uses RMS
   * over the most recent time-domain buffer, normalized to roughly 0..1.
   * Returns the same value for convenience.
   */
  sampleLevel() {
    if (!this._analyser) { this._level = 0; return 0; }
    this._analyser.getByteTimeDomainData(this._timeDomain);
    // Time-domain samples are 0..255 centered at 128; convert to -1..1,
    // compute RMS, scale so a normal-voice peak lands near 1.0.
    let sumSq = 0;
    const n = this._timeDomain.length;
    for (let i = 0; i < n; i++) {
      const s = (this._timeDomain[i] - 128) / 128;
      sumSq += s * s;
    }
    const rms = Math.sqrt(sumSq / n);
    // Soft scale (~3×) so normal speech reaches 0.5–0.8 rather than 0.2.
    this._level = Math.min(1, rms * 3);
    return this._level;
  }

  /** Expose the capture MediaStream (for e.g. piping into a recorder). */
  get stream() { return this._stream; }
}
