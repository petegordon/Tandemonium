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
//
// Single-use QR (#454), when the relay and the phone both speak v2+: a phone
// that joins with the QR's secret is given its own key over the relay
// ({type:'rekey', k}). Once it acks ({type:'rekeyed', k}) the host registers
// that key and moves the QR to a new secret ({type:'pair'}), so the old QR no
// longer opens the seat, while the paired phone reconnects with its key. A
// phone joining with the QR while another phone holds a key is a takeover:
// the old phone's key is revoked and onTakeover fires. With an older relay or
// phone none of this happens, and the QR keeps working as before.
//
// Several seats, one room (#562). The relay has seats 1..4, each with its own
// secrets and seat-tagged frames. PhonePadHost is the room (one socket, one
// code) AND its seat 1, Player 1's phone, with the same API as before. More
// seats come from addSeat(n): each a PadSeat with its own input, pairing,
// drop and reconnect. Seats 2..4 are JOIN seats and share one QR:
//   - while a join seat is free, it is registered with the room's join secret
//     (joinLink), so one QR on screen opens every free seat; the phone tries
//     seats 2, 3, 4 in order until one opens;
//   - the moment a phone takes a join seat ('pad-joined' via 'qr'), that seat
//     moves to a secret of its own ('pair' never drops the phone), so the next
//     phone to scan the same QR lands on the next free seat, not this one;
//   - then the #454 rekey gives the phone its own key, as for seat 1.
// The join QR stays the same while it is offered; rotateJoin() retires it.
//
// #563 · a phone on a join seat may ask {type:'open-room'}: if the game allows
// it now (allowPlay) the room's onOpenRoom opens the RIDE TOGETHER room and we
// reply {type:'room', code, url}, else {type:'room', error}.
// ============================================================

import {
  DEFAULT_PAD_RELAY, padSocketUrl, makePadCode, makePadSecret, sha256hex,
  buildPadLink, decodeFrame, counterDelta, isNewerSeq, NAV, MENU_NAV_MASK, PAD_CUES,
  relayOverrideAllowed, PAD_PROTOCOL, peerVersion, JOIN_SEATS,
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

/** A hash nobody holds the secret for: registering it closes a seat to every phone. */
const deadHash = () => makePadSecret() + makePadSecret();

/**
 * @typedef {'idle'|'connecting'|'waiting'|'connected'|'error'} PadStatus
 */

/**
 * @typedef {object} SeatOptions
 * @property {any} input  the seat's InputManager
 * @property {number} [seat]
 * @property {(status: PadStatus) => void} [onStatus]
 * @property {() => void} [onRecenter]
 * @property {() => void} [onPause]   the phone's Pause button while riding
 * @property {() => void} [onDrop]    a connected phone went away
 * @property {() => void} [onReturn]  ...and came back
 * @property {(link: string) => void} [onLink]  the seat's QR link changed: redraw it
 * @property {() => void} [onTakeover]  another phone took this seat over with the QR
 * @property {(on: boolean) => void} [onHandOff]  the phone asked to play on itself (true), or that failed (false) (#563)
 * @property {string} [label]  what the phone shows as its seat (default "Player <seat>")
 * @property {string} [note]   a line the phone shows when it is seated: where to look (#562)
 * @property {(f: import('./pad-protocol.js').PadFrame, nav: number) => void} [onFrame]
 *   #562: every applied frame, with the menu buttons held (latch removed)
 */

/** One seat of a pad room: its phone, its secrets, its InputManager. */
export class PadSeat {
  /**
   * @param {PhonePadHost|null} room  (null only while PhonePadHost builds itself)
   * @param {SeatOptions & {joinSeat?: boolean}} opts
   */
  constructor(room, { input, seat = 1, onStatus, onRecenter, onPause, onDrop, onReturn, onLink, onTakeover, onHandOff, label, note, onFrame, joinSeat = false }) {
    /** @type {PhonePadHost} */
    this.room = /** @type {any} */ (room);
    this.input = input;
    this.seat = seat;
    /** #562: a join seat (2..4) registers the room's shared join QR while it is free. */
    this.joinSeat = joinSeat;
    this.label = label || null;
    this.note = note || null;
    this.onFrame = onFrame || null;
    this.onStatus = onStatus || null;
    this.onRecenter = onRecenter || null;
    this.onPause = onPause || null;
    this.onDrop = onDrop || null;
    this.onReturn = onReturn || null;
    this.onLink = onLink || null;
    this.onTakeover = onTakeover || null;
    this.onHandOff = onHandOff || null;
    // #454 versions: 1 = the other side never said hello (an older build).
    this.phoneVersion = 1;
    this.takeovers = 0;       // times another phone took the seat (debug aid)
    this._padVia = null;      // how the seat's phone joined: 'qr' | 'paired' | null (old relay)
    this._phoneHash = null;   // SHA-256 of the key the seat's phone holds (single-use QR)
    this._rekey = null;       // a key offered to the phone, not yet acked
    /** @type {'menu'|'ride'} */
    this.mode = 'menu';
    this._dropped = false;     // was connected, then lost
    // Buttons held when the mode switched: ignored until released, so the
    // press that paused (Pause = Start in menu mode) can't also un-pause.
    this._navLatched = 0;
    /** @type {PadStatus} */
    this.status = 'idle';
    this.link = null;
    this._secret = null;
    this._hash = null;
    this._last = null;      // last frame applied
    this._lastAt = 0;
    this._phoneHere = false;
    this._lastCheckAt = 0;
    this.framesReceived = 0;
    /** The QR panel is on screen (set by phone-pad-ui); game pad polling waits. */
    this.panelOpen = false;
    /** Why the phone was last dropped: 'left' | 'silent' | 'relay' (debug aid). */
    this.drops = [];
    // #562
    this._active = false;    // registered with the relay (opened, not closed)
    this._retired = false;   // closed: anything its phone still sends is ignored
    this._offered = false;   // registered with the room's join secret (free join seat)
    this._claimNext = null;  // the secret a join seat moves to when a phone takes it
    /** #563: the phone asked to play on itself; it isn't a controller. */
    this.handedOff = false;
  }

  /**
   * Start (or keep) this seat in the pad room and return the link for its
   * phone (a join seat's is the room's shared join link). A second call while
   * opening gets the same link; null if close() came first.
   * @returns {Promise<string|null>}
   */
  open() {
    if (this._active && this.link) return Promise.resolve(this.link);
    if (!this._opening) this._opening = this._openSeat().finally(() => { this._opening = null; });
    return this._opening;
  }

  async _openSeat() {
    this._retired = false;
    if (!(await this.room._ensureRoom())) return null;
    if (this._retired) return null;
    if (!(await this._freshSecrets())) return null;
    this._active = true;
    this._lastCheckAt = performance.now();
    this._sendPairing();
    const ws = this.room._ws;
    if (!this._phoneHere) this._setStatus(ws && ws.readyState === 1 ? 'waiting' : 'connecting');
    return this.link;
  }

  /**
   * New secrets for this seat (a free join seat takes the room's join secret)
   * and the link for them. False if closed meanwhile.
   */
  async _freshSecrets() {
    const room = this.room;
    if (this.joinSeat) {
      const [join, next] = await Promise.all([room._ensureJoin(), newSecret()]);
      if (room._closed || this._retired || !join) return false;
      this._secret = join.secret;
      this._hash = join.hash;
      this._offered = true;
      this._claimNext = next;
    } else {
      const s = await newSecret();
      if (room._closed || this._retired) return false;
      this._secret = s.secret;
      this._hash = s.hash;
      this._offered = false;
    }
    this._phoneHash = null;
    this._rekey = null;
    this._padVia = null;
    this._seen = false;
    this._buildLink();
    return true;
  }

  _buildLink() {
    const room = this.room;
    if (this._offered) { this.link = room.joinLink(); return; }
    const override = room.relay !== DEFAULT_PAD_RELAY ? room.relay : null;
    this.link = buildPadLink(room.siteBase, /** @type {string} */ (room.code), this.seat, /** @type {string} */ (this._secret), { relay: override });
  }

  /** Register this seat's secrets: 'pair' (QR + phone key) on a v2+ relay, else the old 'allow'. */
  _sendPairing() {
    const ws = this.room._ws;
    if (!ws || ws.readyState !== 1 || !this._hash) return;
    const msg = this.room.relayVersion >= 2
      ? { type: 'pair', seat: this.seat, qr: this._hash, phone: this._phoneHash }
      : { type: 'allow', seat: this.seat, hash: this._hash };
    ws.send(JSON.stringify(msg));
  }

  /** Give the phone that joined with the QR its own key (it acks with 'rekeyed'). */
  async _offerKey() {
    const k = makePadSecret();
    const qr = makePadSecret();
    const [kHash, qrHash] = await Promise.all([sha256hex(k), sha256hex(qr)]);
    if (this.room._closed || this._retired || this._padVia !== 'qr') return;
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
    this._offered = false;
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
   * #562 · a phone took this free join seat with the shared QR: the seat moves
   * to a secret of its own at once, so the next phone scanning the same QR
   * can't land here. ('pair' keeps the phone; an old relay's 'allow' would
   * drop it, so there the seat keeps the join secret.)
   */
  _claim() {
    this._offered = false;
    const next = this._claimNext;
    this._claimNext = null;
    if (!next || this.room.relayVersion < 2) return;
    this._secret = next.secret;
    this._hash = next.hash;
    this._phoneHash = null;
    this._buildLink();
    this._sendPairing();
  }

  /**
   * Let this seat go: its phone is told goodbye, its secrets stop working and
   * its input is released. The room closes once no seat is open.
   */
  close() {
    const room = this.room;
    const wasActive = this._active;
    this._active = false;
    this._retired = true;
    this._phoneHere = false;
    this._dropped = false;
    this.handedOff = false;
    // Tell the phone it's done, so it stops waiting (and lets the room expire).
    this.sendToPad({ type: 'bye' });
    // Other seats keep the room open: make sure nothing can open this one.
    if (wasActive && !room._closed && room._activeSeats().length) {
      this._hash = deadHash();
      this._phoneHash = null;
      this._sendPairing();
    }
    this._release();
    this.link = null;
    this._secret = null;
    this._hash = null;
    this._phoneHash = null;
    this._rekey = null;
    this._padVia = null;
    this._offered = false;
    this._claimNext = null;
    this.phoneVersion = 1;
    this._setStatus('idle');
    room._seatClosed(this);
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

  /** Send a control message to this seat's phone. */
  sendToPad(msg) {
    const ws = this.room._ws;
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'to-pad', seat: this.seat, msg }));
    }
  }

  /** The relay says a phone is on this seat (it joined, or our socket reconnected). @param {unknown} rawVia */
  _padJoined(rawVia) {
    const via = rawVia === 'qr' || rawVia === 'paired' ? rawVia : null;
    if (via === 'qr' && this._offered) this._claim();
    else if (via === 'qr' && this._phoneHash) this._takenOver();
    this._seen = true;
    this._padVia = via;
    this._rekey = null;
    this.phoneVersion = 1;   // until this phone says hello
    this._last = null;
    // After a drop only a real frame brings the phone back: a socket the
    // relay still holds for an asleep phone would otherwise flap the panel.
    if (this._dropped) this._greet();
    else this._arrive();
  }

  /** JSON from the seat's phone (via the relay's from-pad). @param {any} msg */
  _onPadMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'hello') {
      this.phoneVersion = peerVersion(msg);
      this.sendToPad({ type: 'hello', v: PAD_PROTOCOL });
      if (this.phoneVersion >= 2) this.sendToPad({ type: 'mode', mode: this.mode });
      if (this._padVia === 'qr' && this.room.relayVersion >= 2 && this.phoneVersion >= 2) this._offerKey();
    } else if (msg.type === 'rekeyed' && this._rekey && msg.k === this._rekey.k) {
      this._keyAcked();
    } else if (msg.type === 'open-room') {
      this.room._openRoomFor(this);
    }
  }

  /** @param {import('./pad-protocol.js').PadFrame} f */
  _applyFrame(f) {
    // #562: a seat only listens to a phone the relay announced since it opened
    // (not one left over from before the seat was given back).
    if (!this._seen && this.room !== /** @type {any} */ (this)) return;
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
    if (this.onFrame) this.onFrame(f, nav);
  }

  _checkStale() {
    const now = performance.now();
    const gap = now - this._lastCheckAt;
    this._lastCheckAt = now;
    if (!this._phoneHere) return;
    const room = this.room;
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
    if (!room._ws || room._ws.readyState !== 1) {
      if (room._wsDownAt && now - room._wsDownAt > HOST_LOST_MS) this._leave('relay');
      return;
    }
    // The game froze (a level load, a slow TV): the phone's frames are queued
    // behind us, not missing. Start a fresh window.
    if (gap > STALL_MS) { this._lastAt = now; return; }
    // Silent, or joined and never sent a frame: gone. Our socket may be the
    // dead one (it can't tell), so dial again too, unless another phone in the
    // room is still getting through (then it's this phone, not our socket).
    if (silent > STALE_MS) { this._leave('silent'); room._silentRedial(this); }
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
    const msg = { type: 'seat', seat: this.seat, label: this.label || ('Player ' + this.seat) };
    if (this.note) /** @type {any} */ (msg).note = this.note;
    this.sendToPad(msg);
  }

  /** #562 · change what the phone shows as its seat (e.g. once it sits down). @param {string} label */
  setLabel(label) {
    if (label === this.label) return;
    this.label = label;
    if (this._phoneHere) this._greet();
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

/** A fresh secret and its hash. */
async function newSecret() {
  const secret = makePadSecret();
  return { secret, hash: await sha256hex(secret) };
}

/**
 * The pad room (one relay socket, one code) and its seat 1. Its seat API is
 * PadSeat's, so Player 1's phone works exactly as it did with one seat.
 */
export class PhonePadHost extends PadSeat {
  /**
   * @param {SeatOptions & {relay?: string, siteBase?: string}} opts
   *   relay: relay base URL (wss://…); siteBase: folder URL the phone link points into
   */
  constructor(opts) {
    super(null, opts);
    this.room = this;
    this.relay = opts.relay || resolveRelay();
    this.siteBase = opts.siteBase || resolveSiteBase();
    this.relayVersion = 1;
    this._failedOpens = 0;    // connects in a row that closed before opening
    this.rekeys = 0;          // times the room moved to a new code (debug aid)
    this.code = null;
    this._hostKey = null;
    this._ws = null;
    this._closed = true;
    this._retry = 0;
    this._retryTimer = null;
    this._watchdog = null;
    this._wsDownAt = 0;       // when our relay socket went down (0 = up)
    this._pinger = null;
    this._lastRecv = 0;
    /** Every seat by number; this one (Player 1) is always here. @type {Map<number, PadSeat>} */
    this.seats = new Map([[this.seat, /** @type {PadSeat} */ (this)]]);
    /** #562: the shared join secret for free join seats. @type {{secret: string, hash: string}|null} */
    this._join = null;
    /** @type {Promise<{secret: string, hash: string}|null>|null} */
    this._joinP = null;
    /** #563: a join-seat phone may ask for the online room now. */
    this.allowPlay = false;
    /** #563: open (or reuse) the RIDE TOGETHER room. @type {null | ((seat: number) => Promise<{code: string, url?: string}|null>)} */
    this.onOpenRoom = null;
  }

  /**
   * #562 · another seat in this room (2..4: a join seat sharing joinLink).
   * @param {number} n @param {SeatOptions} opts
   * @returns {PadSeat}
   */
  addSeat(n, opts) {
    const had = this.seats.get(n);
    if (had && !had._retired) throw new Error(`pad seat ${n} is in use`);
    const s = new PadSeat(this, { ...opts, seat: n, joinSeat: JOIN_SEATS.includes(n) });
    this.seats.set(n, s);
    return s;
  }

  /**
   * #562 · the shared "Scan to join" link for the free join seats, or null
   * until the room and its join secret are ready.
   * @param {{play?: boolean}} [opts]  offer "Play on this phone" too (#563)
   */
  joinLink({ play = false } = {}) {
    if (this._closed || !this.code || !this._join) return null;
    const override = this.relay !== DEFAULT_PAD_RELAY ? this.relay : null;
    return buildPadLink(this.siteBase, this.code, JOIN_SEATS[0], this._join.secret, { relay: override, seats: JOIN_SEATS, play });
  }

  /** The join secret, made once per room (until rotateJoin). */
  _ensureJoin() {
    if (!this._joinP) {
      const p = this._joinP = newSecret().then((j) => {
        if (this._joinP !== p) return this._join;   // rotated meanwhile
        this._join = j;
        return j;
      });
    }
    return this._joinP;
  }

  /** #562 · retire the shared join QR: the next offer shows a new one. */
  rotateJoin() {
    this._join = null;
    this._joinP = null;
  }

  /** Open the room if it isn't (a new code + host key, then dial). False if closed meanwhile. */
  _ensureRoom() {
    if (!this._closed && this.code) return Promise.resolve(true);
    if (!this._roomOpening) {
      this._roomOpening = (async () => {
        this._closed = false;
        if (!(await this._newRoom())) return false;
        this._connect();
        this._watchdog = setInterval(() => this._checkAllStale(), 250);
        this._pinger = setInterval(() => {
          const ws = this._ws;
          if (!ws || ws.readyState !== 1) return;
          // A socket can say "open" long after the network under it died (a Wi-Fi
          // switch, a NAT drop). Then the phone looks silent while it's fine.
          if (performance.now() - this._lastRecv > DEAD_MS) { this._redial(); return; }
          try { ws.send('ping'); } catch { /* closed */ }
        }, PING_MS);
        return true;
      })().finally(() => { this._roomOpening = null; });
    }
    return this._roomOpening;
  }

  /** Seats that are open (registered with the relay). */
  _activeSeats() {
    return [...this.seats.values()].filter((s) => s._active);
  }

  /**
   * A fresh code and host key, and fresh secrets + links for every open seat.
   * False if closed meanwhile.
   */
  async _newRoom() {
    const code = makePadCode();
    const hostKey = makePadSecret();   // proves to the relay we are this room's host
    if (this._closed) return false;
    this.code = code;
    this._hostKey = hostKey;
    this._failedOpens = 0;
    this.rotateJoin();
    for (const s of this._activeSeats()) {
      if (!(await s._freshSecrets())) return false;
    }
    return !this._closed;
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
      // The old room's phones can't reach us anyway; they have to scan the new code.
      for (const s of this.seats.values()) if (s._phoneHere) s._leave('relay');
      this._retry = 0;
      clearTimeout(this._retryTimer);
      this._connect();
      for (const s of this._activeSeats()) if (s.onLink && s.link) s.onLink(s.link);
    } finally {
      this._checkingRefused = false;
    }
  }

  /** A seat closed: drop it (seat 1 stays), and close the room once none is open. @param {PadSeat} s */
  _seatClosed(s) {
    if (s !== /** @type {PadSeat} */ (this) && this.seats.get(s.seat) === s) this.seats.delete(s.seat);
    if (!this._activeSeats().length) this._closeRoom();
  }

  /** Stop the room: socket, timers, code. */
  _closeRoom() {
    this._closed = true;
    clearTimeout(this._retryTimer);
    clearTimeout(this._openTimer);
    clearInterval(this._watchdog);
    clearInterval(this._pinger);
    this._watchdog = null;
    this._pinger = null;
    if (this._ws) { try { this._ws.close(1000, 'host closed'); } catch { /* closed */ } }
    this._ws = null;
    this.code = null;
    this.rotateJoin();
  }

  _connect() {
    if (this._closed) return;
    for (const s of this._activeSeats()) s._setStatus(s._phoneHere ? 'connected' : 'connecting');
    let ws;
    try {
      ws = new WebSocket(padSocketUrl(this.relay, /** @type {string} */ (this.code), 'host', this._hostKey));
    } catch (e) {
      for (const s of this._activeSeats()) s._setStatus('error');
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
      for (const s of this._activeSeats()) {
        s._lastAt = performance.now();   // a fresh window for the phone's frames
        s._sendPairing();
        if (!s._phoneHere) s._setStatus('waiting');
      }
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

  /** A seat's phone went silent: redial unless another seat's phone is still getting through. @param {PadSeat} seat */
  _silentRedial(seat) {
    const now = performance.now();
    const others = [...this.seats.values()].some((s) => s !== seat && s._phoneHere && now - s._lastAt < STALE_MS);
    if (!others) this._redial();
  }

  _scheduleRetry() {
    if (this._closed) return;
    const delay = Math.min(8000, 500 * 2 ** this._retry++);
    clearTimeout(this._retryTimer);
    this._retryTimer = setTimeout(() => this._connect(), delay);
  }

  _checkAllStale() {
    for (const s of this.seats.values()) if (!s._retired) s._checkStale();
  }

  /** The seat a relay message is for, if it's listening. @param {unknown} n */
  _seatFor(n) {
    const s = this.seats.get(Number(n));
    return s && !s._retired ? s : null;
  }

  /** @param {string|ArrayBuffer} data */
  _onMessage(data) {
    if (typeof data !== 'string') {
      const bytes = new Uint8Array(data);
      const s = this._seatFor(bytes[0]);
      const f = s && decodeFrame(bytes, 1);
      if (s && f) s._applyFrame(f);
      return;
    }
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (m.type === 'relay') { this.relayVersion = peerVersion(m); return; }
    const s = this._seatFor(m.seat);
    if (!s) return;
    if (m.type === 'from-pad') s._onPadMessage(m.msg);
    else if (m.type === 'pad-joined') s._padJoined(m.via);
    else if (m.type === 'pad-left') s._leave('left');
  }

  /**
   * #563 · a phone on a join seat asked to play on itself: open the online
   * room (only while the game allows it) and send it the code. Only a phone
   * the relay let onto one of our seats (it held a valid key) gets this far.
   * @param {PadSeat} seat
   */
  async _openRoomFor(seat) {
    const reply = (/** @type {object} */ m) => seat.sendToPad({ type: 'room', ...m });
    if (seat.handedOff) return;   // already asked: the answer is on its way
    if (!seat.joinSeat || !seat._phoneHere || !this.allowPlay || !this.onOpenRoom) { reply({ error: 'not-now' }); return; }
    seat.handedOff = true;
    seat.onHandOff?.(true);
    /** @type {{code: string, url?: string}|null} */
    let r = null;
    try { r = await this.onOpenRoom(seat.seat); } catch { r = null; }
    if (seat._retired) return;
    if (!r || !r.code) {
      seat.handedOff = false;
      seat.onHandOff?.(false);
      reply({ error: 'failed' });
      return;
    }
    reply({ code: r.code, url: r.url || null });
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
