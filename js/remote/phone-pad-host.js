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
// Phase 2: the game tells us whether it's in menus or riding (setMode); in
// menu mode the phone's held buttons become a gamepad on the seat's
// InputManager (setRemoteNav). The phone's own layout never changes. A phone
// that said hello (v2+, #454) is told the mode only so it can send less in
// menus (on change plus a heartbeat); one that didn't is sent nothing new.
// One seat (Player 1) until Phase 4.
//
// Single-use QR (#454), when the relay and the phone both speak v2+: a phone
// that joins with the QR's secret is given its own key over the relay
// ({type:'rekey', k}). Once it acks ({type:'rekeyed', k}) the host registers
// that key and moves the QR to a new secret ({type:'pair'}), so the old QR no
// longer opens the seat, while the paired phone reconnects with its key. A
// phone joining with the QR while another phone holds a key is a takeover:
// the old phone's key is revoked and onTakeover fires. With an older relay or
// phone none of this happens, and the QR keeps working as before.
// ============================================================

import {
  DEFAULT_PAD_RELAY, padSocketUrl, makePadCode, makePadSecret, sha256hex,
  buildPadLink, decodeFrame, counterDelta, isNewerSeq, NAV, MENU_NAV_MASK, PAD_CUES,
  relayOverrideAllowed, PAD_PROTOCOL, peerVersion,
} from './pad-protocol.js';

/** No frame for this long (while the game is running freely) = the phone is gone. */
const STALE_MS = 2000;
/** The watchdog ran this late = the game itself froze; the phone isn't to blame. */
const STALL_MS = 750;
/** Our own link to the relay down this long = give up on the phone. */
const HOST_LOST_MS = 5000;
/** A short silence (a Wi-Fi hiccup): let go of held pedals / menu buttons so nothing sticks. */
const RELEASE_MS = 400;
/** Keep the game's relay socket from going idle. */
const PING_MS = 5000;
/** Nothing from the relay (not even a pong) this long = our socket is dead. */
const DEAD_MS = PING_MS * 2 + 1000;
/** A connection attempt that hasn't opened by now is abandoned and retried. */
const CONNECT_TIMEOUT_MS = 8000;
/** This many connects in a row that never open, with the relay reachable =
 *  the relay is refusing this room (a code collision, or another host took the
 *  code after ours expired): make a new code. */
const REFUSED_TRIES = 4;

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
   * @param {() => void} [opts.onRecenter]
   * @param {() => void} [opts.onPause]   the phone's Pause button while riding
   * @param {() => void} [opts.onDrop]    a connected phone went away
   * @param {() => void} [opts.onReturn]  ...and came back
   * @param {(link: string) => void} [opts.onLink]  the QR's link changed (new code or new secret): redraw it
   * @param {() => void} [opts.onTakeover]  another phone took this seat over with the QR
   */
  constructor({ input, seat = 1, relay, siteBase, onStatus, onRecenter, onPause, onDrop, onReturn, onLink, onTakeover }) {
    this.input = input;
    this.seat = seat;
    this.relay = relay || resolveRelay();
    this.siteBase = siteBase || resolveSiteBase();
    this.onStatus = onStatus || null;
    this.onRecenter = onRecenter || null;
    this.onPause = onPause || null;
    this.onDrop = onDrop || null;
    this.onReturn = onReturn || null;
    this.onLink = onLink || null;
    this.onTakeover = onTakeover || null;
    // #454 versions: 1 = the other side never said hello (an older build).
    this.relayVersion = 1;
    this.phoneVersion = 1;
    this.takeovers = 0;       // times another phone took the seat (debug aid)
    this._padVia = null;      // how the seat's phone joined: 'qr' | 'paired' | null (old relay)
    this._phoneHash = null;   // SHA-256 of the key the seat's phone holds (single-use QR)
    this._rekey = null;       // a key offered to the phone, not yet acked
    this._failedOpens = 0;    // connects in a row that closed before opening
    this.rekeys = 0;          // times the room moved to a new code (debug aid)
    /** @type {'menu'|'ride'} */
    this.mode = 'menu';
    this._dropped = false;     // was connected, then lost
    // Buttons held when the mode switched: ignored until released, so the
    // press that paused (Pause = Start in menu mode) can't also un-pause.
    this._navLatched = 0;
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
    this._lastCheckAt = 0;
    this._wsDownAt = 0;       // when our relay socket went down (0 = up)
    this._pinger = null;
    this.framesReceived = 0;
    /** The QR panel is on screen (set by phone-pad-ui); game pad polling waits. */
    this.panelOpen = false;
    /** Why the phone was last dropped: 'left' | 'silent' | 'relay' (debug aid). */
    this.drops = [];
  }

  /**
   * Start (or keep) a pad room and return the link for the phone. A second
   * call while opening gets the same room; null if close() came first.
   * @returns {Promise<string|null>}
   */
  open() {
    if (!this._closed && this.link) return Promise.resolve(this.link);
    if (!this._opening) this._opening = this._open().finally(() => { this._opening = null; });
    return this._opening;
  }

  async _open() {
    this._closed = false;
    if (!(await this._newRoom())) return null;
    this._connect();
    this._lastCheckAt = performance.now();
    this._watchdog = setInterval(() => this._checkStale(), 250);
    this._pinger = setInterval(() => {
      const ws = this._ws;
      if (!ws || ws.readyState !== 1) return;
      // A socket can say "open" long after the network under it died (a Wi-Fi
      // switch, a NAT drop). Then the phone looks silent while it's fine.
      if (performance.now() - this._lastRecv > DEAD_MS) { this._redial(); return; }
      try { ws.send('ping'); } catch { /* closed */ }
    }, PING_MS);
    return this.link;
  }

  /** A fresh code, pairing secret and host key, and the link for them. False if closed meanwhile. */
  async _newRoom() {
    const code = makePadCode();
    const secret = makePadSecret();
    const hostKey = makePadSecret();   // proves to the relay we are this room's host
    const hash = await sha256hex(secret);
    if (this._closed) return false;
    this.code = code;
    this._secret = secret;
    this._hostKey = hostKey;
    this._hash = hash;
    this._phoneHash = null;
    this._rekey = null;
    this._padVia = null;
    this._buildLink();
    this._failedOpens = 0;
    return true;
  }

  _buildLink() {
    const override = this.relay !== DEFAULT_PAD_RELAY ? this.relay : null;
    this.link = buildPadLink(this.siteBase, /** @type {string} */ (this.code), this.seat, /** @type {string} */ (this._secret), { relay: override });
  }

  /** Register this seat's secrets: 'pair' (QR + phone key) on a v2+ relay, else the old 'allow'. */
  _sendPairing() {
    const ws = this._ws;
    if (!ws || ws.readyState !== 1) return;
    const msg = this.relayVersion >= 2
      ? { type: 'pair', seat: this.seat, qr: this._hash, phone: this._phoneHash }
      : { type: 'allow', seat: this.seat, hash: this._hash };
    ws.send(JSON.stringify(msg));
  }

  /** Give the phone that joined with the QR its own key (it acks with 'rekeyed'). */
  async _offerKey() {
    const k = makePadSecret();
    const qr = makePadSecret();
    const [kHash, qrHash] = await Promise.all([sha256hex(k), sha256hex(qr)]);
    if (this._closed || this._padVia !== 'qr') return;
    this._rekey = { k, kHash, qr, qrHash };
    this.sendToPad({ type: 'rekey', k });
  }

  /** The phone stored its key: register it and move the QR to a fresh secret. */
  _keyAcked() {
    const r = /** @type {{k: string, kHash: string, qr: string, qrHash: string}} */ (this._rekey);
    this._rekey = null;
    this._phoneHash = r.kHash;
    this._secret = r.qr;
    this._hash = r.qrHash;
    this._padVia = 'paired';
    this._buildLink();
    this._sendPairing();
    if (this.onLink && this.link) this.onLink(this.link);
  }

  /** A phone joined with the QR while another phone held the seat's key. */
  _takenOver() {
    this.takeovers++;
    this._phoneHash = null;   // the old phone's key stops working
    this._sendPairing();
    if (this.onTakeover) this.onTakeover();
  }

  /**
   * Several connects failed before opening. A refusal (HTTP 403) and a dead
   * network look the same to a WebSocket, so ask the relay over plain HTTP:
   * if it answers, the room is refused and we move to a new code. If it
   * doesn't, keep the code so an already-paired phone can still come back.
   */
  async _checkRefused() {
    if (this._checkingRefused || this._closed) return;
    this._checkingRefused = true;
    try {
      const reachable = await relayReachable(this.relay);
      if (!reachable || this._closed || (this._ws && this._ws.readyState === 1)) return;
      if (!(await this._newRoom())) return;
      this.rekeys++;
      // The old room's phone can't reach us anyway; it has to scan the new code.
      if (this._phoneHere) this._leave('relay');
      this._retry = 0;
      clearTimeout(this._retryTimer);
      this._connect();
      if (this.onLink && this.link) this.onLink(this.link);
    } finally {
      this._checkingRefused = false;
    }
  }

  /** Stop listening to the phone and release its input. */
  close() {
    this._closed = true;
    this._phoneHere = false;
    this._dropped = false;
    clearTimeout(this._retryTimer);
    clearTimeout(this._openTimer);
    clearInterval(this._watchdog);
    clearInterval(this._pinger);
    this._watchdog = null;
    this._pinger = null;
    // Tell the phone it's done, so it stops waiting (and lets the room expire).
    this.sendToPad({ type: 'bye' });
    if (this._ws) { try { this._ws.close(1000, 'host closed'); } catch { /* closed */ } }
    this._ws = null;
    this._release();
    this.code = null;
    this.link = null;
    this._phoneHash = null;
    this._rekey = null;
    this._padVia = null;
    this.phoneVersion = 1;
    this._setStatus('idle');
  }

  get connected() { return this.status === 'connected'; }

  /**
   * Menus or riding: how the phone's buttons are read. Cheap every frame.
   * @param {'menu'|'ride'} mode
   */
  setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    this._navLatched = this._last ? this._last.nav : 0;
    if (this._phoneHere) this.input.setRemoteNav(mode === 'menu', 0);
    // #454: only a phone that said hello is told (it sends less in menus).
    if (this.phoneVersion >= 2) this.sendToPad({ type: 'mode', mode });
  }

  /** A short sound/buzz on the phone. @param {string} cue */
  cue(cue) {
    if (this._phoneHere && PAD_CUES.includes(cue)) this.sendToPad({ type: 'cue', cue });
  }

  /** Send a control message to the phone. */
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
      ws = new WebSocket(padSocketUrl(this.relay, /** @type {string} */ (this.code), 'host', this._hostKey));
    } catch (e) {
      this._setStatus('error');
      return this._scheduleRetry();
    }
    ws.binaryType = 'arraybuffer';
    this._ws = ws;
    clearTimeout(this._openTimer);
    const openTimer = this._openTimer = setTimeout(() => { if (ws.readyState === 0) { try { ws.close(); } catch { /* closed */ } } }, CONNECT_TIMEOUT_MS);
    let opened = false;
    ws.onopen = () => {
      opened = true;
      clearTimeout(openTimer);
      this._lastRecv = performance.now();
      this._retry = 0;
      this._failedOpens = 0;
      this._wsDownAt = 0;
      this._lastAt = performance.now();   // a fresh window for the phone's frames
      this._sendPairing();
      if (!this._phoneHere) this._setStatus('waiting');
    };
    ws.onmessage = (ev) => { this._lastRecv = performance.now(); this._onMessage(ev.data); };
    ws.onclose = () => {
      clearTimeout(openTimer);
      if (this._ws !== ws) return;
      this._ws = null;
      if (!this._wsDownAt) this._wsDownAt = performance.now();
      if (this._closed) return;
      if (!opened && ++this._failedOpens >= REFUSED_TRIES) {
        this._failedOpens = 0;
        this._checkRefused();
      }
      this._scheduleRetry();
    };
    ws.onerror = () => { /* onclose follows */ };
  }

  /** Drop our relay socket and dial again now. */
  _redial() {
    const ws = this._ws;
    if (!ws || this._closed) return;
    this._ws = null;
    if (!this._wsDownAt) this._wsDownAt = performance.now();
    try { ws.close(); } catch { /* closed */ }
    this._retry = 0;
    clearTimeout(this._retryTimer);
    this._connect();
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
    if (m.type === 'relay') {
      this.relayVersion = peerVersion(m);
    } else if (m.type === 'from-pad' && m.seat === this.seat) {
      this._onPadMessage(m.msg);
    } else if (m.type === 'pad-joined' && m.seat === this.seat) {
      const via = m.via === 'qr' || m.via === 'paired' ? m.via : null;
      if (via === 'qr' && this._phoneHash) this._takenOver();
      this._padVia = via;
      this._rekey = null;
      this.phoneVersion = 1;   // until this phone says hello
      this._last = null;
      // After a drop only a real frame brings the phone back: a socket the
      // relay still holds for an asleep phone would otherwise flap the panel.
      if (this._dropped) this._greet();
      else this._arrive();
    } else if (m.type === 'pad-left' && m.seat === this.seat) {
      this._leave('left');
    }
  }

  /** JSON from the seat's phone (via the relay's from-pad). @param {any} msg */
  _onPadMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'hello') {
      this.phoneVersion = peerVersion(msg);
      this.sendToPad({ type: 'hello', v: PAD_PROTOCOL });
      if (this.phoneVersion >= 2) this.sendToPad({ type: 'mode', mode: this.mode });
      if (this._padVia === 'qr' && this.relayVersion >= 2 && this.phoneVersion >= 2) this._offerKey();
    } else if (msg.type === 'rekeyed' && this._rekey && msg.k === this._rekey.k) {
      this._keyAcked();
    }
  }

  /** @param {import('./pad-protocol.js').PadFrame} f */
  _applyFrame(f) {
    const prev = this._last;
    if (prev && !isNewerSeq(prev.seq, f.seq)) return;   // late / duplicate
    this.framesReceived++;
    this._lastAt = performance.now();
    this._heldReleased = false;
    if (!this._phoneHere) this._arrive();

    if (f.tilt != null) this.input.feedRemoteTilt(f.tilt);
    const tapsL = prev ? counterDelta(prev.tapsL, f.tapsL) : 0;
    const tapsR = prev ? counterDelta(prev.tapsR, f.tapsR) : 0;
    this.input.setRemotePedals(f.left, f.right, tapsL, tapsR);

    // Menu mode: the held buttons are a gamepad for the menus.
    this._navLatched &= f.nav;
    const nav = f.nav & ~this._navLatched;
    this.input.setRemoteNav(this.mode === 'menu', nav & MENU_NAV_MASK);
    const pressed = nav & ~(prev ? prev.nav & ~this._navLatched : 0);
    if (pressed & NAV.recenter) {
      if (this.onRecenter) this.onRecenter();
      else this.input.startTiltCalibration();
    }
    if ((pressed & NAV.pause) && this.mode === 'ride' && this.onPause) this.onPause();
    this._last = f;
  }

  _checkStale() {
    const now = performance.now();
    const gap = now - this._lastCheckAt;
    this._lastCheckAt = now;
    if (!this._phoneHere) return;
    // The game itself stalled (a slow frame, a level load, a slow TV): the
    // phone's frames are queued behind us, not missing, so the silence is ours.
    // Start a fresh window rather than letting go of a button still held.
    if (gap > RELEASE_MS) { this._lastAt = now; return; }
    const silent = now - this._lastAt;
    // Any short silence (the phone, our socket, or a stall): let go of held
    // pedals and menu buttons so nothing sticks. Frames resuming take over
    // again; the tap counters carry on from _last.
    if (silent > RELEASE_MS && !this._heldReleased) {
      this._heldReleased = true;
      // Buttons still held when frames resume are not a fresh press.
      this._navLatched = this._last ? this._last.nav : 0;
      this.input.setRemotePedals(false, false);
      this.input.setRemoteNav(this.mode === 'menu', 0);
    }
    // Our own relay socket is down: the phone's frames can't reach us, which
    // says nothing about the phone. Wait for the reconnect, up to a point.
    if (!this._ws || this._ws.readyState !== 1) {
      if (this._wsDownAt && now - this._wsDownAt > HOST_LOST_MS) this._leave('relay');
      return;
    }
    // The game froze (a level load, a slow TV): the phone's frames are queued
    // behind us, not missing. Start a fresh window.
    if (gap > STALL_MS) { this._lastAt = now; return; }
    // Silent, or joined and never sent a frame: gone. Our socket may be the
    // dead one (it can't tell), so dial again too.
    if (silent > STALE_MS) { this._leave('silent'); this._redial(); }
  }

  /** The phone is here (joined, or frames resumed). */
  _arrive() {
    this._phoneHere = true;
    this._lastAt = performance.now();   // frames must follow within STALE_MS
    this._setStatus('connected');
    this._greet();
    this.input.setRemoteNav(this.mode === 'menu', 0);
    if (this._dropped) { this._dropped = false; if (this.onReturn) this.onReturn(); }
  }

  /** Tell the phone its seat. */
  _greet() {
    this.sendToPad({ type: 'seat', seat: this.seat, label: 'Player ' + this.seat });
  }

  /** The phone left, or went silent (asleep, out of range). */
  /** @param {'left'|'silent'|'relay'} [reason] */
  _leave(reason = 'left') {
    const was = this._phoneHere;
    if (was) { this.drops.push({ reason, at: Date.now() }); if (this.drops.length > 10) this.drops.shift(); }
    this._phoneHere = false;
    this._release();
    this._setStatus('waiting');
    if (was) { this._dropped = true; if (this.onDrop) this.onDrop(); }
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

/**
 * Does the relay answer plain HTTP? Any response at all counts (no-cors: we
 * can't read it, and don't need to). Used to tell "refused" from "offline".
 * @param {string} relay  wss://… or ws://…
 * @param {number} [timeoutMs]
 */
export async function relayReachable(relay, timeoutMs = 4000) {
  if (typeof fetch !== 'function') return false;
  const url = relay.replace(/^ws/, 'http');
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : 0;
  try {
    await fetch(url, { mode: 'no-cors', cache: 'no-store', signal: ctl ? ctl.signal : undefined });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
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
  if (isDesktop) return 'https://tandemonium.housetandem.com/';
  return new URL('./', document.baseURI).toString();
}
