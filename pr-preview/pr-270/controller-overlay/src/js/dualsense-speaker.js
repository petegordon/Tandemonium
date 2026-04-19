// ============================================================
// DUALSENSE SPEAKER
// ============================================================
//
// Routes audio to the DualSense's built-in speaker. Over Bluetooth this
// goes through the A2DP sink exposed by the OS as a regular audio
// device; over USB it uses USB Audio Class. HTMLAudioElement.setSinkId()
// drives both cases uniformly as long as we have the deviceId from
// AudioDeviceManager.
//
// A2DP introduces 150–250 ms of latency. That's fine for notification
// sounds and voice effects, but too much for anything that needs to be
// frame-accurate with game visuals. If the caller needs low latency they
// should use the system default sink (not this module).
//
// Usage:
//   const spk = new DualSenseSpeaker();
//   await spk.setSink(deviceId);
//   await spk.playTone(880, 200);
//   await spk.playClip('assets/notify.mp3');
//   await spk.routeStream(remotePeerStream);

export class DualSenseSpeaker {
  constructor() {
    this._deviceId = null;
    this._volume = 1;
    // Hidden <audio> kept around for routeStream() — replaced when the
    // sink changes. Not appended to the DOM; still plays and still honors
    // setSinkId as long as the element is alive.
    this._routeAudio = null;
  }

  get deviceId() { return this._deviceId; }
  get volume() { return this._volume; }
  get ready() { return !!this._deviceId; }

  /**
   * Point this speaker at a specific audio output sink. Pass null to
   * clear the binding. Persists between calls — subsequent playTone /
   * playClip invocations use this sink until changed.
   */
  async setSink(deviceId) {
    this._deviceId = deviceId || null;
    if (this._routeAudio) {
      await this._applySink(this._routeAudio);
    }
  }

  setVolume(v) {
    this._volume = Math.max(0, Math.min(1, v));
    if (this._routeAudio) this._routeAudio.volume = this._volume;
  }

  /**
   * Synthesize and play a sine tone. Returns a promise that resolves
   * after the tone has finished.
   */
  async playTone(freq = 880, durationMs = 200) {
    if (!this._deviceId) return;
    // Build the tone offline, pack into a WAV, send through an <audio>
    // element so we can route via setSinkId. Using an AudioContext +
    // destination + MediaStreamDestination would also work, but <audio>
    // + setSinkId is the shortest path that respects the chosen sink.
    const sampleRate = 48000;
    const samples = Math.floor((durationMs / 1000) * sampleRate);
    const ctx = new OfflineAudioContext(1, samples, sampleRate);
    const osc = ctx.createOscillator();
    osc.frequency.value = freq;
    const gain = ctx.createGain();
    // Short fade in/out to avoid clicks at tone boundaries.
    const fade = Math.min(0.02, (durationMs / 1000) / 4);
    gain.gain.setValueAtTime(0, 0);
    gain.gain.linearRampToValueAtTime(this._volume, fade);
    gain.gain.setValueAtTime(this._volume, (durationMs / 1000) - fade);
    gain.gain.linearRampToValueAtTime(0, durationMs / 1000);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(0);
    osc.stop(durationMs / 1000);
    const rendered = await ctx.startRendering();

    const blob = _bufferToWav(rendered);
    const url = URL.createObjectURL(blob);
    try {
      await this._playUrl(url);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /**
   * Play an audio file (mp3/ogg/wav/…) through the DualSense speaker.
   * @param {string} url
   */
  async playClip(url) {
    if (!this._deviceId) return;
    await this._playUrl(url);
  }

  async _playUrl(url) {
    const audio = new Audio(url);
    audio.volume = this._volume;
    await this._applySink(audio);
    // Wait for metadata so duration is known; await play() to surface
    // autoplay errors immediately rather than swallowing them.
    await audio.play();
    await new Promise((resolve, reject) => {
      audio.addEventListener('ended', resolve, { once: true });
      audio.addEventListener('error', () => reject(audio.error || new Error('audio error')), { once: true });
    });
  }

  /**
   * Pipe a live MediaStream (e.g. a WebRTC remote audio track) to the
   * DualSense speaker. Persistent until closeStream() is called or a
   * different stream is routed.
   */
  async routeStream(stream) {
    if (!this._deviceId) return;
    this.closeStream();
    const audio = new Audio();
    audio.srcObject = stream;
    audio.volume = this._volume;
    audio.autoplay = true;
    await this._applySink(audio);
    await audio.play().catch((err) => {
      console.warn('DualSenseSpeaker routeStream play failed:', err.message);
    });
    this._routeAudio = audio;
  }

  closeStream() {
    if (this._routeAudio) {
      try { this._routeAudio.pause(); } catch (e) { /* ok */ }
      this._routeAudio.srcObject = null;
      this._routeAudio = null;
    }
  }

  async _applySink(audioEl) {
    if (typeof audioEl.setSinkId !== 'function') {
      console.warn('DualSenseSpeaker: setSinkId unsupported in this runtime');
      return;
    }
    try {
      await audioEl.setSinkId(this._deviceId);
    } catch (err) {
      // Common cause: deviceId stale after a disconnect/reconnect. Caller
      // should rescan via AudioDeviceManager; log and fall through so the
      // element still plays through the default sink.
      console.warn('DualSenseSpeaker setSinkId failed:', err.message);
    }
  }
}

// Minimal 16-bit PCM WAV encoder for OfflineAudioContext output. Only
// mono buffers are produced in playTone() so the channel-count branch
// here is single-track; extend if stereo tones are ever needed.
function _bufferToWav(audioBuffer) {
  const numChannels = 1;
  const sampleRate = audioBuffer.sampleRate;
  const samples = audioBuffer.getChannelData(0);
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeString = (off, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i));
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);           // PCM chunk size
  view.setUint16(20, 1, true);            // audio format (1 = PCM)
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);           // bits per sample
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  let off = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    off += 2;
  }
  return new Blob([buffer], { type: 'audio/wav' });
}
