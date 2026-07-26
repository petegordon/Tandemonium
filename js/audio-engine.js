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
    this._lastBikeUpdate = 0;
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

  // Goose honk (#363). Synthesized rather than sampled — the whole engine is
  // procedural, and per-honk pitch/length jitter is what keeps a gaggle from
  // sounding like one sound effect fired six times.
  //
  // A goose is a nasal buzz, not a tone: a sawtooth (rich in harmonics) with a
  // fast upward pitch bend on the attack and a sag on the release, squeezed
  // through a bandpass around the vocal formant. The short noise blip at the
  // start is the breath that makes it read as an animal instead of a synth.
  gooseHonk(gain = 0.52) {
    const ctx = this.ctx;
    if (!ctx) return;
    this.resume();
    const now = ctx.currentTime;

    const base = 300 + Math.random() * 190;     // per-goose voice
    const dur = 0.20 + Math.random() * 0.13;

    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(base * 0.72, now);
    osc.frequency.linearRampToValueAtTime(base, now + 0.035);        // bend up
    osc.frequency.linearRampToValueAtTime(base * 0.82, now + dur);   // sag off

    // TWO formants in parallel, not one narrow band. The original single
    // bandpass sat at base*2.2 with Q=3.2, so its passband (~1.9x-2.5x base)
    // excluded the fundamental entirely and passed mainly the 2nd harmonic at
    // half amplitude — throwing away most of the level the gain implied. Wide,
    // overlapping formants keep far more energy and sound more like a voice
    // than a filtered buzz.
    //
    // The upper formant carries the small-speaker case: phone speakers roll
    // off hard below ~500Hz, and the fundamental is 300-490Hz, so on iOS
    // almost everything audible comes from the 1.1kHz-2kHz band.
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, now);
    env.gain.exponentialRampToValueAtTime(gain, now + 0.02);
    env.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    env.connect(this.sfxBus);

    for (const f of [
      { hz: base * 1.6, q: 1.4, amp: 0.80 },
      { hz: base * 3.4, q: 1.8, amp: 0.72 },   // survives phone-speaker rolloff
    ]) {
      const band = ctx.createBiquadFilter();
      band.type = 'bandpass';
      band.frequency.value = f.hz;
      band.Q.value = f.q;
      const fg = ctx.createGain();
      fg.gain.value = f.amp;
      osc.connect(band).connect(fg).connect(env);
    }

    osc.start(now);
    osc.stop(now + dur + 0.02);

    // Breath transient
    const noise = ctx.createBufferSource();
    noise.buffer = this._getNoiseBuffer();
    const nFilt = ctx.createBiquadFilter();
    nFilt.type = 'bandpass';
    nFilt.frequency.value = 1500;
    nFilt.Q.value = 0.8;
    const nGain = ctx.createGain();
    nGain.gain.setValueAtTime(gain * 0.5, now);
    nGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.05);
    noise.connect(nFilt).connect(nGain).connect(this.sfxBus);
    noise.start(now);
    noise.stop(now + 0.06);
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

    // Track every node so stopBike() can fully tear down the graph.
    // Without holding refs to the filters, they were leaked-connected to
    // bikeBus across races and accumulated on iOS WebKit (browser freeze
    // while audio kept playing — main thread starved by node graph).
    this._bike = {
      windSrc, tireSrc, chainOsc,
      windFilt, tireFilt, chainFilt,
      windGain, tireGain, chainGain,
    };

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
      // Stop sources first so they're eligible for auto-release.
      try { b.windSrc.stop();  } catch (e) {}
      try { b.tireSrc.stop();  } catch (e) {}
      try { b.chainOsc.stop(); } catch (e) {}
      // Explicitly disconnect every node from the graph. Sources auto-GC
      // after stop(), but BiquadFilter / GainNode are kept alive by their
      // outgoing connection to bikeBus until disconnect() is called.
      try { b.windSrc.disconnect();  } catch (e) {}
      try { b.tireSrc.disconnect();  } catch (e) {}
      try { b.chainOsc.disconnect(); } catch (e) {}
      try { b.windFilt.disconnect();  } catch (e) {}
      try { b.tireFilt.disconnect();  } catch (e) {}
      try { b.chainFilt.disconnect(); } catch (e) {}
      try { b.windGain.disconnect();  } catch (e) {}
      try { b.tireGain.disconnect();  } catch (e) {}
      try { b.chainGain.disconnect(); } catch (e) {}
    }, 400);
  }

  // Called each frame while playing. `speed` in the bike's units,
  // `maxSpeed` the configured cap, `offRoad` 0-1 surface roughness.
  //
  // Perf: throttled to ~20Hz and uses setTargetAtTime rather than
  // cancel+setValue+linearRamp every frame. The old pattern tore down the
  // automation timeline and forced an audio-thread sync on every call,
  // which caused main-thread stalls on high-refresh displays (#277).
  updateBike(speed, maxSpeed, offRoad = 0, fallen = false) {
    if (!this.ctx || !this._bike) return;
    const now = this.ctx.currentTime;
    if (now - this._lastBikeUpdate < 0.05) return;
    this._lastBikeUpdate = now;

    const norm = Math.max(0, Math.min(1, speed / (maxSpeed || 19)));
    const wind  = fallen ? 0 : norm * norm * 0.22;
    const tire  = fallen ? 0 : norm * 0.16 + offRoad * 0.28;
    const chain = fallen ? 0 : norm * 0.09;
    const chainHz = 58 + norm * 112;

    const tc = 0.08;
    const b = this._bike;
    b.windGain.gain.setTargetAtTime(wind, now, tc);
    b.tireGain.gain.setTargetAtTime(tire, now, tc);
    b.chainGain.gain.setTargetAtTime(chain, now, tc);
    b.chainOsc.frequency.setTargetAtTime(chainHz, now, tc);
  }
}
