// ============================================================
// MUSIC TRACK (#567): the background music, with a Web Audio fallback
// ============================================================
//
// The music is an <audio> element, as before (streams, cheap). But a browser
// can refuse `element.play()` while it still lets the AudioContext play: the
// Google TV browser plays the game's effects (Web Audio) and no music, and its
// players press keys on a remote, a phone or a pad, so a click on the page
// may never come. When play() is refused, the track is decoded once and
// played from the AudioContext on the music bus instead (where the element is
// routed during a ride anyway, so ducking and clip capture still apply).
//
// If neither may play yet, `blocked` says why (the play() error's name) until
// a later play() works; the game retries on the first key, click or touch.
//
// The API is the subset of HTMLAudioElement the game used: play() (a promise),
// pause(), loop, volume, currentTime.

export class MusicTrack {
  /**
   * @param {string} src
   * @param {{ensureContext: () => AudioContext|null, ctx: AudioContext|null, musicBus: AudioNode|null}} engine
   * @param {object} [o]
   * @param {boolean} [o.makeContext] may the fallback create the AudioContext (TV browsers; elsewhere it waits
   *   for the context a gesture made, so a desktop browser logs no "AudioContext was not allowed" warning)
   * @param {(src: string) => HTMLAudioElement} [o.makeElement]
   * @param {(src: string) => Promise<ArrayBuffer>} [o.load]
   */
  constructor(src, engine, { makeContext = false, makeElement = (s) => new Audio(s), load = null } = {}) {
    this.src = src;
    this.engine = engine;
    this.el = makeElement(src);
    this._makeContext = makeContext;
    this._load = load || ((s) => fetch(s).then((r) => r.arrayBuffer()));
    /** @type {null|'element'|'webaudio'} how it is playing (null: not playing) */
    this.mode = null;
    /** @type {string|null} why the last play() could not start (e.g. 'NotAllowedError'); null once it plays */
    this.blocked = null;
    /** @type {null|(() => void)} mode or blocked changed */
    this.onstate = null;
    this._want = false;
    this._attempt = null;
    this._volume = 1;
    this._buf = null;
    this._bufP = null;
    this._src = null;
    this._gain = null;
    this._offset = 0;
    this._startedAt = 0;
    // the browser can pause the element itself (media session, tab hidden): not playing any more
    if (this.el && this.el.addEventListener) {
      this.el.addEventListener('pause', () => { if (this.mode === 'element') this._set(null, this.blocked); });
    }
  }

  get playing() { return this.mode !== null; }
  get paused() { return this.mode === null; }

  get loop() { return this.el.loop; }
  set loop(v) { this.el.loop = v; if (this._src) this._src.loop = v; }

  get volume() { return this._volume; }
  set volume(v) {
    this._volume = v;
    this.el.volume = v;
    if (this._gain) this._gain.gain.value = v;
  }

  get currentTime() {
    if (this.mode === 'webaudio' && this._buf && this.engine.ctx) {
      return (this.engine.ctx.currentTime - this._startedAt) % this._buf.duration;
    }
    return this.mode === 'element' ? this.el.currentTime : this._offset;
  }
  set currentTime(t) {
    try { this.el.currentTime = t; } catch { /* not loaded yet */ }
    this._offset = t;
    if (this.mode === 'webaudio') { this._stopSource(); this._startSource(); }
  }

  /** Start (or keep) playing. Resolves once it plays; rejects with the refusal when nothing may play yet. */
  play() {
    this._want = true;
    if (this.mode) return Promise.resolve();
    if (!this._attempt) this._attempt = this._play().finally(() => { this._attempt = null; });
    return this._attempt;
  }

  async _play() {
    let refusal;
    try {
      await this.el.play();
      if (!this._want) { this.el.pause(); return; }
      this._set('element', null);
      return;
    } catch (e) {
      refusal = e;
    }
    if (!this._want) return;   // paused while play() was pending (an AbortError)
    if (await this._playBuffer()) return;
    if (this.mode) return;
    const name = (refusal && refusal.name) || String(refusal);
    try { console.warn('[music] play() refused:', name, refusal && refusal.message); } catch { /* no console */ }
    this._set(null, name);
    throw refusal;
  }

  /** The Web Audio fallback. True once it plays. */
  async _playBuffer() {
    const eng = this.engine;
    if (!eng) return false;
    const ctx = eng.ctx || (this._makeContext && eng.ensureContext ? eng.ensureContext() : null);
    if (!ctx || !eng.musicBus) return false;
    if (ctx.state !== 'running') {
      // resume() never settles in some browsers until a gesture: don't wait on it for long
      try { await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, 300))]); } catch { /* refused */ }
    }
    if (ctx.state !== 'running') return false;
    let buf;
    try { buf = await this._decode(ctx); } catch (e) {
      try { console.warn('[music] decode failed:', e && (e.name || e.message)); } catch { /* no console */ }
      return false;
    }
    if (!this._want) return false;
    if (this.mode) return true;
    this._startSource();
    this._set('webaudio', null);
    return true;
  }

  _decode(ctx) {
    if (this._buf) return Promise.resolve(this._buf);
    if (!this._bufP) {
      this._bufP = this._load(this.src)
        .then((data) => new Promise((resolve, reject) => {
          // the callback form too: older WebKit returns no promise
          const p = ctx.decodeAudioData(data, resolve, reject);
          if (p && typeof p.then === 'function') p.then(resolve, reject);
        }))
        .then((b) => { this._buf = b; return b; })
        .catch((e) => { this._bufP = null; throw e; });
    }
    return this._bufP;
  }

  _startSource() {
    const ctx = this.engine.ctx, buf = this._buf;
    if (!ctx || !buf) return;
    if (!this._gain) {
      this._gain = ctx.createGain();
      this._gain.connect(this.engine.musicBus);
    }
    this._gain.gain.value = this._volume;
    const s = ctx.createBufferSource();
    s.buffer = buf;
    s.loop = this.el.loop;
    s.connect(this._gain);
    const off = ((this._offset % buf.duration) + buf.duration) % buf.duration;
    s.start(0, off);
    this._startedAt = ctx.currentTime - off;
    s.onended = () => {
      if (this._src !== s) return;
      this._src = null;
      this._offset = 0;
      this._set(null, this.blocked);
    };
    this._src = s;
  }

  _stopSource() {
    const s = this._src;
    if (!s) return;
    this._src = null;
    try { s.stop(); } catch { /* not started */ }
    try { s.disconnect(); } catch { /* gone */ }
  }

  pause() {
    this._want = false;
    try { this.el.pause(); } catch { /* gone */ }
    if (this._src) {
      this._offset = this.currentTime;
      this._stopSource();
    }
    if (this.mode) this._set(null, this.blocked);
  }

  _set(mode, blocked) {
    const changed = mode !== this.mode || blocked !== this.blocked;
    this.mode = mode;
    this.blocked = blocked;
    if (changed && this.onstate) { try { this.onstate(); } catch { /* UI */ } }
  }
}
