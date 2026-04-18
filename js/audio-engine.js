// Shared Web Audio engine for Tandemonium.
//
// Design goals:
//   - One AudioContext, lazily created on first user gesture (iOS-safe).
//   - Three buses off a single master: music, sfx, bike. Lets us duck music
//     during gameplay without touching individual volumes (St2).
//   - Procedural bike motion sound (wind + tire hiss + chain) driven by
//     speed (Sp3), so the bike is never silent while rolling.
//   - Richer SFX timbres (bell-like chime with inharmonic partials, noise-
//     based crash) instead of bare square/sine oscillators (Ti1).
//   - Linear crossfades on music start/stop/duck changes (St3).
//   - Recorder tap: connecting a MediaStreamDestination on the master bus
//     keeps music + SFX + bike audio in exported clips automatically.
//
// The engine never disconnects the <audio> MediaElementSource after creating
// it. Muting is handled by ramping the music bus gain to zero and pausing
// the element — this avoids the iOS looping-artifact bug the old code
// worked around with disconnect/reconnect.

// Shared motif for the Tandemonium audio signature (Re4). C major triad
// inherited from the original finish chime; reused in checkpoint & victory.
export const MOTIF = {
  C5: 523.25,
  E5: 659.25,
  G5: 783.99,
};

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.musicBus = null;
    this.sfxBus = null;
    this.bikeBus = null;
    this._musicDuck = null;
    this._musicSrc = null;
    this._recorderDest = null;
    this._noiseBuf = null;
    this._bike = null;
    this._duckTarget = 1.0;
  }

  // Create the AudioContext and bus graph. Safe to call multiple times.
  // Returns the context (or null if Web Audio is unavailable).
  ensureContext() {
    if (this.ctx) return this.ctx;
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    const ctx = new Ctor();
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = 1.0;
    this.master.connect(ctx.destination);

    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = 1.0;
    this._musicDuck = ctx.createGain();
    this._musicDuck.gain.value = 1.0;
    this.musicBus.connect(this._musicDuck).connect(this.master);

    this.sfxBus = ctx.createGain();
    this.sfxBus.gain.value = 1.0;
    this.sfxBus.connect(this.master);

    this.bikeBus = ctx.createGain();
    this.bikeBus.gain.value = 0.0;
    this.bikeBus.connect(this.master);

    return ctx;
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  // Silent warmup buffer primes the iOS audio session so the first real
  // sound isn't delayed 2-3 seconds.
  warmup() {
    if (!this.ctx) return;
    try {
      const buf = this.ctx.createBuffer(1, 1, this.ctx.sampleRate);
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.ctx.destination);
      src.start();
    } catch (e) {}
  }

  // Tap the full mix into a MediaStreamDestination (for GameRecorder).
  attachRecorderDestination(dest) {
    if (!this.ctx || !this.master || !dest) return;
    this._recorderDest = dest;
    try { this.master.connect(dest); } catch (e) {}
  }

  detachRecorderDestination() {
    if (this._recorderDest && this.master) {
      try { this.master.disconnect(this._recorderDest); } catch (e) {}
    }
    this._recorderDest = null;
  }

  // Route a background-music <audio> element through the music bus.
  connectMusicElement(el) {
    if (!this.ctx || !el || this._musicSrc) return;
    try {
      this._musicSrc = this.ctx.createMediaElementSource(el);
      this._musicSrc.connect(this.musicBus);
    } catch (e) {}
  }

  // St2 — ramp the music duck gain to target (typically 1.0 idle, 0.55 play).
  duckMusic(target, duration = 0.6) {
    if (!this._musicDuck || !this.ctx) return;
    this._duckTarget = target;
    const now = this.ctx.currentTime;
    const g = this._musicDuck.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(target, now + duration);
  }

  // St3 — linear crossfade helper for any GainNode.
  crossfade(gainNode, target, duration = 0.3) {
    if (!gainNode || !this.ctx) return;
    const now = this.ctx.currentTime;
    gainNode.gain.cancelScheduledValues(now);
    gainNode.gain.setValueAtTime(gainNode.gain.value, now);
    gainNode.gain.linearRampToValueAtTime(target, now + duration);
  }

  // Instant mute of the entire mix (honoured by the existing M shortcut).
  setMuted(muted) {
    if (!this.master) return;
    this.master.gain.value = muted ? 0 : 1;
  }

  // ── SFX (Ti1) ────────────────────────────────────────────────────────────

  // Short tone with attack/decay envelope. Used as the general-purpose beep.
  // `type` defaults to 'triangle' — warmer than the old 'square' without
  // losing the arcade-y feel.
  tone(freq, duration, opts = {}) {
    const ctx = this.ctx;
    if (!ctx) return;
    this.resume();
    const { type = 'triangle', gain = 0.14, attack = 0.006 } = opts;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(gain, now + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    osc.connect(g).connect(this.sfxBus);
    osc.start(now);
    osc.stop(now + duration + 0.02);
  }

  // Bell-like chime: fundamental + a few inharmonic partials. Far less
  // "test-tone" sounding than a plain sine oscillator.
  chime(freq, duration, gain = 0.28) {
    const ctx = this.ctx;
    if (!ctx) return;
    this.resume();
    const now = ctx.currentTime;
    const partials = [
      { mult: 1.0,  amp: 1.0  },
      { mult: 2.0,  amp: 0.45 },
      { mult: 3.01, amp: 0.22 },
      { mult: 4.07, amp: 0.10 }, // slight inharmonicity for bell character
    ];
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, now);
    env.gain.exponentialRampToValueAtTime(gain, now + 0.005);
    env.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    env.connect(this.sfxBus);
    for (const p of partials) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq * p.mult;
      const pg = ctx.createGain();
      pg.gain.value = p.amp;
      osc.connect(pg).connect(env);
      osc.start(now);
      osc.stop(now + duration + 0.02);
    }
  }

  // Noise-based crash impact with a low-frequency thump. Replaces the old
  // double-beep crash cue with something that actually reads as an impact.
  crash(intensity = 1) {
    const ctx = this.ctx;
    if (!ctx) return;
    this.resume();
    const now = ctx.currentTime;
    const duration = 0.45;

    // Bandpassed white noise — the "clatter"
    const src = ctx.createBufferSource();
    src.buffer = this._getNoiseBuffer();
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 900;
    bp.Q.value = 0.6;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.35 * intensity, now);
    ng.gain.exponentialRampToValueAtTime(0.001, now + duration);
    src.connect(bp).connect(ng).connect(this.sfxBus);
    src.start(now);
    src.stop(now + duration);

    // Pitch-falling sine — the "thump"
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(140, now);
    osc.frequency.exponentialRampToValueAtTime(55, now + 0.22);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.45 * intensity, now);
    og.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
    osc.connect(og).connect(this.sfxBus);
    osc.start(now);
    osc.stop(now + 0.32);
  }

  _getNoiseBuffer() {
    if (this._noiseBuf) return this._noiseBuf;
    const sr = this.ctx.sampleRate;
    const buf = this.ctx.createBuffer(1, Math.floor(sr * 2), sr);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this._noiseBuf = buf;
    return buf;
  }

  // ── Bike motion loop (Sp3) ───────────────────────────────────────────────

  startBike() {
    const ctx = this.ctx;
    if (!ctx || this._bike) return;

    // Wind: lowpassed pink-ish noise
    const windSrc = ctx.createBufferSource();
    windSrc.buffer = this._getNoiseBuffer();
    windSrc.loop = true;
    const windFilt = ctx.createBiquadFilter();
    windFilt.type = 'lowpass';
    windFilt.frequency.value = 420;
    windFilt.Q.value = 0.5;
    const windGain = ctx.createGain();
    windGain.gain.value = 0;
    windSrc.connect(windFilt).connect(windGain).connect(this.bikeBus);

    // Tires: bandpassed noise around 1200 Hz
    const tireSrc = ctx.createBufferSource();
    tireSrc.buffer = this._getNoiseBuffer();
    tireSrc.loop = true;
    const tireFilt = ctx.createBiquadFilter();
    tireFilt.type = 'bandpass';
    tireFilt.frequency.value = 1200;
    tireFilt.Q.value = 1.0;
    const tireGain = ctx.createGain();
    tireGain.gain.value = 0;
    tireSrc.connect(tireFilt).connect(tireGain).connect(this.bikeBus);

    // Drivetrain: low filtered saw whose pitch tracks cadence
    const chainOsc = ctx.createOscillator();
    chainOsc.type = 'sawtooth';
    chainOsc.frequency.value = 60;
    const chainFilt = ctx.createBiquadFilter();
    chainFilt.type = 'lowpass';
    chainFilt.frequency.value = 240;
    chainFilt.Q.value = 2;
    const chainGain = ctx.createGain();
    chainGain.gain.value = 0;
    chainOsc.connect(chainFilt).connect(chainGain).connect(this.bikeBus);

    windSrc.start();
    tireSrc.start();
    chainOsc.start();

    this._bike = { windSrc, tireSrc, chainOsc, windGain, tireGain, chainGain };

    // Fade the bus in; individual sources stay at 0 until speed rises.
    const now = ctx.currentTime;
    this.bikeBus.gain.cancelScheduledValues(now);
    this.bikeBus.gain.setValueAtTime(this.bikeBus.gain.value, now);
    this.bikeBus.gain.linearRampToValueAtTime(1.0, now + 0.2);
  }

  stopBike() {
    if (!this.ctx || !this._bike) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    this.bikeBus.gain.cancelScheduledValues(now);
    this.bikeBus.gain.setValueAtTime(this.bikeBus.gain.value, now);
    this.bikeBus.gain.linearRampToValueAtTime(0, now + 0.3);
    const b = this._bike;
    this._bike = null;
    setTimeout(() => {
      try { b.windSrc.stop(); } catch (e) {}
      try { b.tireSrc.stop(); } catch (e) {}
      try { b.chainOsc.stop(); } catch (e) {}
    }, 400);
  }

  // Called each frame while playing. `speed` in the bike's units,
  // `maxSpeed` the configured cap, `offRoad` 0-1 surface roughness.
  updateBike(speed, maxSpeed, offRoad = 0, fallen = false) {
    if (!this.ctx || !this._bike) return;
    const ctx = this.ctx;
    const norm = Math.max(0, Math.min(1, speed / (maxSpeed || 19)));
    const ramp = 0.12;
    const now = ctx.currentTime;

    const wind  = fallen ? 0 : norm * norm * 0.22;
    const tire  = fallen ? 0 : norm * 0.16 + offRoad * 0.28;
    const chain = fallen ? 0 : norm * 0.09;
    const chainHz = 58 + norm * 112;

    const { windGain, tireGain, chainGain, chainOsc } = this._bike;
    [windGain.gain, tireGain.gain, chainGain.gain].forEach((g, i) => {
      const t = [wind, tire, chain][i];
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(t, now + ramp);
    });
    chainOsc.frequency.cancelScheduledValues(now);
    chainOsc.frequency.setValueAtTime(chainOsc.frequency.value, now);
    chainOsc.frequency.linearRampToValueAtTime(chainHz, now + ramp);
  }
}
