// @ts-check
// ============================================================
// PhonePadHost — the game's end of a phone remote (#421)
// ============================================================
//
// Opens a pad room on the pad relay (worker/pad-relay.js), registers the
// pairing secret for a seat, and turns the phone's input frames into calls on
// that seat's InputManager: feedRemoteTilt() for steering, setRemotePedals()
// for the pedal halves. The tilt pipeline itself (calibration, drift, curve)
// is the InputManager's, so a remote phone steers exactly like a phone
// playing the game.
//
// Phase 1: one seat (Player 1). Menus from the phone come in Phase 2.
// ============================================================

import {
  DEFAULT_PAD_RELAY, padSocketUrl, makePadCode, makePadSecret, sha256hex,
  buildPadLink, decodeFrame, counterDelta, isNewerSeq, NAV, relayOverrideAllowed,
} from './pad-protocol.js';

/** No frame for this long while connected = treat the phone as gone. */
const STALE_MS = 1000;

/**
 * @typedef {'idle'|'connecting'|'waiting'|'connected'|'error'} PadStatus
 */

export class PhonePadHost {
  /**
   * @param {object} opts
   * @param {import('../input-manager.js').InputManager} opts.input  the seat's InputManager
   * @param {number} [opts.seat]
   * @param {string} [opts.relay]   relay base URL (wss://…)
   * @param {string} [opts.siteBase] folder URL the phone link points into
   * @param {(status: PadStatus) => void} [opts.onStatus]
   * @param {(nav: number) => void} [opts.onNav]  nav button edges (Phase 2)
   * @param {() => void} [opts.onRecenter]
   */
  constructor({ input, seat = 1, relay, siteBase, onStatus, onNav, onRecenter }) {
    this.input = input;
    this.seat = seat;
    this.relay = relay || resolveRelay();
    this.siteBase = siteBase || resolveSiteBase();
    this.onStatus = onStatus || null;
    this.onNav = onNav || null;
    this.onRecenter = onRecenter || null;
    /** @type {PadStatus} */
    this.status = 'idle';
    this.code = null;
    this.link = null;
    this._secret = null;
    this._ws = null;
    this._closed = true;
    this._retry = 0;
    this._retryTimer = null;
    this._last = null;      // last frame applied
    this._lastAt = 0;
    this._phoneHere = false;
    this._watchdog = null;
    this.framesReceived = 0;
  }

  /** Start (or keep) a pad room and return the link for the phone. */
  async open() {
    if (!this._closed && this.link) return this.link;
    this._closed = false;
    this.code = makePadCode();
    this._secret = makePadSecret();
    this._hash = await sha256hex(this._secret);
    const override = this.relay !== DEFAULT_PAD_RELAY ? this.relay : null;
    this.link = buildPadLink(this.siteBase, this.code, this.seat, this._secret, { relay: override });
    this._connect();
    this._watchdog = setInterval(() => this._checkStale(), 250);
    return this.link;
  }

  /** Stop listening to the phone and release its input. */
  close() {
    this._closed = true;
    clearTimeout(this._retryTimer);
    clearInterval(this._watchdog);
    this._watchdog = null;
    if (this._ws) { try { this._ws.close(1000, 'host closed'); } catch { /* closed */ } }
    this._ws = null;
    this._release();
    this.code = null;
    this.link = null;
    this._setStatus('idle');
  }

  get connected() { return this.status === 'connected'; }

  /** Send a control message to the phone (Phase 2: mode / cue). */
  sendToPad(msg) {
    if (this._ws && this._ws.readyState === 1) {
      this._ws.send(JSON.stringify({ type: 'to-pad', seat: this.seat, msg }));
    }
  }

  _connect() {
    if (this._closed) return;
    this._setStatus(this._phoneHere ? 'connected' : 'connecting');
    let ws;
    try {
      ws = new WebSocket(padSocketUrl(this.relay, /** @type {string} */ (this.code), 'host'));
    } catch (e) {
      this._setStatus('error');
      return this._scheduleRetry();
    }
    ws.binaryType = 'arraybuffer';
    this._ws = ws;
    ws.onopen = () => {
      this._retry = 0;
      ws.send(JSON.stringify({ type: 'allow', seat: this.seat, hash: this._hash }));
      if (!this._phoneHere) this._setStatus('waiting');
    };
    ws.onmessage = (ev) => this._onMessage(ev.data);
    ws.onclose = () => {
      if (this._ws !== ws) return;
      this._ws = null;
      if (!this._closed) this._scheduleRetry();
    };
    ws.onerror = () => { /* onclose follows */ };
  }

  _scheduleRetry() {
    if (this._closed) return;
    const delay = Math.min(8000, 500 * 2 ** this._retry++);
    clearTimeout(this._retryTimer);
    this._retryTimer = setTimeout(() => this._connect(), delay);
  }

  /** @param {string|ArrayBuffer} data */
  _onMessage(data) {
    if (typeof data !== 'string') {
      const bytes = new Uint8Array(data);
      if (bytes[0] !== this.seat) return;
      const f = decodeFrame(bytes, 1);
      if (f) this._applyFrame(f);
      return;
    }
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (m.type === 'pad-joined' && m.seat === this.seat) {
      this._phoneHere = true;
      this._last = null;
      this._setStatus('connected');
      this.sendToPad({ type: 'seat', seat: this.seat, label: 'Player ' + this.seat });
    } else if (m.type === 'pad-left' && m.seat === this.seat) {
      this._phoneHere = false;
      this._release();
      this._setStatus('waiting');
    }
  }

  /** @param {import('./pad-protocol.js').PadFrame} f */
  _applyFrame(f) {
    const prev = this._last;
    if (prev && !isNewerSeq(prev.seq, f.seq)) return;   // late / duplicate
    this.framesReceived++;
    this._lastAt = performance.now();
    if (!this._phoneHere) { this._phoneHere = true; this._setStatus('connected'); }

    if (f.tilt != null) this.input.feedRemoteTilt(f.tilt);
    const tapsL = prev ? counterDelta(prev.tapsL, f.tapsL) : 0;
    const tapsR = prev ? counterDelta(prev.tapsR, f.tapsR) : 0;
    this.input.setRemotePedals(f.left, f.right, tapsL, tapsR);

    const pressed = f.nav & ~(prev ? prev.nav : 0);
    if (pressed & NAV.recenter) {
      if (this.onRecenter) this.onRecenter();
      else this.input.startTiltCalibration();
    }
    if (pressed && this.onNav) this.onNav(pressed);
    this._last = f;
  }

  _checkStale() {
    if (this._last && performance.now() - this._lastAt > STALE_MS) {
      this._release();
      this._last = null;
    }
  }

  _release() {
    this._last = null;
    if (this.input && this.input.detachRemote) this.input.detachRemote();
  }

  /** @param {PadStatus} s */
  _setStatus(s) {
    if (this.status === s) return;
    this.status = s;
    if (this.onStatus) this.onStatus(s);
  }
}

/** ?padRelay=ws://… on localhost (local smoke tests); otherwise production. */
export function resolveRelay(loc = globalThis.location) {
  try {
    const p = new URLSearchParams(loc.search).get('padRelay');
    if (p && relayOverrideAllowed(loc.hostname)) return p;
  } catch { /* no location */ }
  return DEFAULT_PAD_RELAY;
}

/**
 * The folder the phone link points into. Electron serves from file:// or
 * localhost, which a phone can't reach, so it uses the public site.
 */
export function resolveSiteBase() {
  const isDesktop = typeof navigator !== 'undefined' && navigator.userAgent.includes('Electron');
  if (isDesktop) return 'https://tandemonium.jimandi.love/';
  return new URL('./', document.baseURI).toString();
}
