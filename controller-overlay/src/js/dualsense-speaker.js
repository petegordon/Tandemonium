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
    console.log('  [speaker.playTone] entered', { freq, durationMs, deviceId: this._deviceId, volume: this._volume });
    if (!this._deviceId) {
      console.warn('  [speaker.playTone] no deviceId bound — returning early');
      return;
    }
    const sampleRate = 48000;
    const samples = Math.floor((durationMs / 1000) * sampleRate);
    const ctx = new OfflineAudioContext(1, samples, sampleRate);
    const osc = ctx.createOscillator();
    osc.frequency.value = freq;
    const gain = ctx.createGain();
    const fade = Math.min(0.02, (durationMs / 1000) / 4);
    gain.gain.setValueAtTime(0, 0);
    gain.gain.linearRampToValueAtTime(this._volume, fade);
    gain.gain.setValueAtTime(this._volume, (durationMs / 1000) - fade);
    gain.gain.linearRampToValueAtTime(0, durationMs / 1000);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(0);
    osc.stop(durationMs / 1000);
    console.log('  [speaker.playTone] rendering offline buffer…');
    const rendered = await ctx.startRendering();
    console.log('  [speaker.playTone] rendered', {
      length: rendered.length,
      duration: rendered.duration,
      channels: rendered.numberOfChannels,
      sampleRate: rendered.sampleRate,
    });

    const blob = _bufferToWav(rendered);
    const url = URL.createObjectURL(blob);
    console.log('  [speaker.playTone] WAV blob created', { size: blob.size });
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
    console.log('  [speaker._playUrl] Audio element created', { volume: audio.volume, src: url.slice(0, 40) + '…' });
    await this._applySink(audio);
    console.log('  [speaker._playUrl] sinkId after setSinkId:', audio.sinkId);
    const playStart = performance.now();
    try {
      await audio.play();
      console.log(`  [speaker._playUrl] play() resolved in ${Math.round(performance.now() - playStart)}ms — paused=${audio.paused} readyState=${audio.readyState} duration=${audio.duration}`);
    } catch (err) {
      console.error('  [speaker._playUrl] play() rejected:', err);
      throw err;
    }
    await new Promise((resolve, reject) => {
      audio.addEventListener('ended', () => {
        console.log(`  [speaker._playUrl] 'ended' fired after ${Math.round(performance.now() - playStart)}ms — currentTime=${audio.currentTime}`);
        resolve();
      }, { once: true });
      audio.addEventListener('error', () => {
        console.error('  [speaker._playUrl] error event:', audio.error);
        reject(audio.error || new Error('audio error'));
      }, { once: true });
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
      console.warn('  [speaker._applySink] setSinkId unsupported in this runtime');
      return;
    }
    try {
      console.log('  [speaker._applySink] calling setSinkId →', this._deviceId);
      await audioEl.setSinkId(this._deviceId);
      console.log('  [speaker._applySink] setSinkId OK — audioEl.sinkId =', audioEl.sinkId);
    } catch (err) {
      console.warn('  [speaker._applySink] setSinkId failed:', err.name, err.message);
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
