// @ts-check
// ============================================================
// PhoneEntry + PhonePool — phones as controllers for extra seats (#562)
// ============================================================
//
// A phone that joins the co-op or versus screen is a controller like any
// other: it shows in the screen's roster, takes a seat with OK, switches
// team with the D-pad and leaves with Back. This module is shaped like
// controller-core's HidEntry (shared/manager.js) so it can move into the lab
// as a controller source later:
//
//   entry.synthetic            standard-mapping gamepad built from the
//                              phone's held menu buttons (+ pedals on 6/7)
//   entry.hasFreshInput()      a button pressed that wasn't held when it joined
//   entry.hasFreshButtonPress()
//   entry.identity             { kind: 'phone', name: 'Phone 2', glyphFamily }
//   entry.attach() / release() a seat takes / gives back the phone
//   entry.destroy()            the phone is let go (relay room closed)
//
// Each phone has its own pad room (one PhonePadHost, seat 1 of its room) and
// its own InputManager (remoteOnly), which becomes the seat's input when the
// phone sits down. Ride-time tilt and pedals flow host → that InputManager
// (feedRemoteTilt / setRemotePedals), exactly as the Player 1 phone does.
// Phone 1 is the first page's "Phone as controller" (Player 1's own input);
// the pool numbers its phones 2..4 (the relay's seat count).
// ============================================================

import { mergeRemoteNavPad } from '../input-manager.js';

/** What a pool phone shows once it joins: the game is on the big screen, not here. */
export const PHONE_SEAT_NOTE = 'You’re the controller — watch the TV';

/** Phones the pool hands out: 2..4 (Phone 1 is Player 1's, see phone-pad-ui). */
export const FIRST_POOL_PHONE = 2;
export const LAST_POOL_PHONE = 4;

/** A fresh standard-mapping synthetic gamepad (same shape as controller-core's). @param {number} n */
export function makePhoneSynthetic(n) {
  const buttons = [];
  for (let i = 0; i < 17; i++) buttons.push({ pressed: false, touched: false, value: 0 });
  return {
    id: `Phone ${n} (Tandemonium phone remote)`,
    index: -1,
    mapping: 'standard',
    connected: true,
    timestamp: 0,
    buttons,
    axes: [0, 0, 0, 0],
    _isSynthetic: true,
  };
}

/**
 * Write a phone frame into a synthetic: the held menu buttons (NAV bits →
 * standard indices, OK = 0, Back = 1) and the pedal halves on 6 / 7.
 * @param {ReturnType<typeof makePhoneSynthetic>} gp
 * @param {number} nav  NAV bits held (latched buttons already removed)
 * @param {{left?: boolean, right?: boolean}} [pedals]
 */
export function applyNavToSynthetic(gp, nav, pedals = {}) {
  const merged = mergeRemoteNavPad(null, nav, false);
  for (let i = 0; i < gp.buttons.length; i++) {
    const on = !!(merged.buttons[i] && merged.buttons[i].pressed);
    gp.buttons[i].pressed = on; gp.buttons[i].touched = on; gp.buttons[i].value = on ? 1 : 0;
  }
  const setPedal = (i, on) => { gp.buttons[i].pressed = on; gp.buttons[i].touched = on; gp.buttons[i].value = on ? 1 : 0; };
  if (pedals.left) setPedal(6, true);
  if (pedals.right) setPedal(7, true);
  gp.timestamp = typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** Let go of everything on a synthetic. @param {ReturnType<typeof makePhoneSynthetic>} gp */
export function resetPhoneSynthetic(gp) {
  for (const b of gp.buttons) { b.pressed = false; b.touched = false; b.value = 0; }
  for (let i = 0; i < gp.axes.length; i++) gp.axes[i] = 0;
}

/**
 * @typedef {object} PhoneHostLike   the parts of PhonePadHost an entry uses
 * @property {() => Promise<string|null>} open
 * @property {() => void} close
 * @property {(mode: 'menu'|'ride') => void} setMode
 * @property {(cue: string) => void} cue
 * @property {(label: string) => void} setLabel
 * @property {string|null} link
 * @property {string} status
 */

export class PhoneEntry {
  /**
   * @param {number} n  phone number (2..4)
   * @param {object} deps
   * @param {() => any} deps.makeInput  a remoteOnly InputManager for this phone
   * @param {(opts: any) => PhoneHostLike} deps.makeHost  a PhonePadHost
   * @param {(entry: PhoneEntry) => void} [deps.onArrive]  first join
   * @param {(entry: PhoneEntry) => void} [deps.onDrop]    a joined phone went away
   * @param {(entry: PhoneEntry) => void} [deps.onReturn]  ...and came back
   * @param {(entry: PhoneEntry) => void} [deps.onLink]    the QR link changed
   * @param {(entry: PhoneEntry) => void} [deps.onPause]   Pause on the phone while riding
   */
  constructor(n, { makeInput, makeHost, onArrive, onDrop, onReturn, onLink, onPause }) {
    this.n = n;
    this.identity = { kind: 'phone', name: `Phone ${n}`, shortName: `Phone ${n}`, glyphFamily: 'generic' };
    this.synthetic = makePhoneSynthetic(n);
    this.input = makeInput();
    /** A seat holds this phone (its input is that seat's). */
    this.attached = false;
    /** The phone joined at least once (the pool's QR has moved on from it). */
    this.everJoined = false;
    /** The phone is connected right now. */
    this.present = false;
    this._initialPressedMask = /** @type {Set<number>|null} */ (null);
    this.host = makeHost({
      input: this.input,
      seat: 1,
      label: this.identity.name,
      note: PHONE_SEAT_NOTE,
      onFrame: (/** @type {any} */ f, /** @type {number} */ nav) => applyNavToSynthetic(this.synthetic, nav, f),
      onStatus: (/** @type {string} */ s) => this._onStatus(s),
      onDrop: () => onDrop?.(this),
      onReturn: () => onReturn?.(this),
      onLink: () => onLink?.(this),
      onPause: () => onPause?.(this),
    });
    this._onArrive = onArrive || null;
  }

  get link() { return this.host.link; }
  get status() { return this.host.status; }

  /** Open this phone's pad room (its QR link). */
  open() { return this.host.open(); }

  /** @param {string} s */
  _onStatus(s) {
    const was = this.present;
    this.present = s === 'connected';
    this.input.remotePresent = this.present;
    if (!this.present) { resetPhoneSynthetic(this.synthetic); this._initialPressedMask = null; }
    if (this.present && !was && !this.everJoined) {
      this.everJoined = true;
      this._onArrive?.(this);
    }
  }

  /** True if any button not held when the phone joined is pressed now (HidEntry's rule). */
  hasFreshButtonPress() {
    if (!this.present) return false;
    const buttons = this.synthetic.buttons;
    if (this._initialPressedMask == null) {
      this._initialPressedMask = new Set();
      for (let i = 0; i < buttons.length; i++) if (buttons[i].pressed) this._initialPressedMask.add(i);
      return false;   // the first look never counts as fresh
    }
    for (let i = 0; i < buttons.length; i++) {
      if (buttons[i].pressed && !this._initialPressedMask.has(i)) return true;
    }
    return false;
  }

  /** A phone has no sticks: fresh input is a fresh button. */
  hasFreshInput() { return this.hasFreshButtonPress(); }

  /**
   * A seat takes this phone: its InputManager becomes the seat's input.
   * @param {string} [label]  what the phone shows now (e.g. "Player 3")
   * @returns {any} the InputManager
   */
  attach(label) {
    this.attached = true;
    if (label) this.host.setLabel(label);
    return this.input;
  }

  /** The seat gave the phone back: it's a free controller again. */
  release() {
    this.attached = false;
    this.host.setLabel(this.identity.name);
  }

  /** Let the phone go for good (closes its relay room). */
  destroy() {
    this.attached = false;
    this.present = false;
    this.input.remotePresent = false;
    this.host.close();
    resetPhoneSynthetic(this.synthetic);
  }
}

export class PhonePool {
  /**
   * @param {object} deps  as PhoneEntry, plus:
   * @param {() => any} deps.makeInput
   * @param {(opts: any) => PhoneHostLike} deps.makeHost
   * @param {(pool: PhonePool) => void} [deps.onChange]   entries / pending / presence changed
   * @param {(entry: PhoneEntry) => void} [deps.onDrop]   a SEATED phone went away
   * @param {(entry: PhoneEntry) => void} [deps.onReturn]
   * @param {(entry: PhoneEntry) => void} [deps.onPause]
   */
  constructor(deps) {
    this.deps = deps;
    /** @type {Map<number, PhoneEntry>} */
    this.entries = new Map();
    /** The entry whose QR is on offer (no phone has joined it yet). @type {PhoneEntry|null} */
    this.pending = null;
    /** @type {'menu'|'ride'} */
    this.mode = 'menu';
  }

  /** The lowest free phone number, or null when all are out. */
  _freeNumber() {
    for (let n = FIRST_POOL_PHONE; n <= LAST_POOL_PHONE; n++) if (!this.entries.has(n)) return n;
    return null;
  }

  /**
   * Offer a QR for the next phone: the pending entry, made if needed.
   * Null when every phone number is taken.
   * @returns {PhoneEntry|null}
   */
  offer() {
    if (this.pending) return this.pending;
    const n = this._freeNumber();
    if (n == null) return null;
    const d = this.deps;
    const entry = new PhoneEntry(n, {
      makeInput: d.makeInput,
      makeHost: d.makeHost,
      onArrive: (e) => this._arrived(e),
      onDrop: (e) => { this._changed(); if (e.attached) d.onDrop?.(e); },
      onReturn: (e) => { this._changed(); d.onReturn?.(e); },
      onLink: () => this._changed(),
      onPause: (e) => { if (e.attached) d.onPause?.(e); },
    });
    entry.host.setMode(this.mode);
    this.entries.set(n, entry);
    this.pending = entry;
    entry.open();
    this._changed();
    return entry;
  }

  /** The pending phone joined: the QR moves on to the next phone. @param {PhoneEntry} e */
  _arrived(e) {
    if (this.pending === e) this.pending = null;
    this._changed();
    if (this.offering) this.offer();
  }

  /**
   * While true (the join panel is open) a join moves the QR straight on to the
   * next free phone. Closing the panel stops offering: the pending room closes.
   * @param {boolean} on
   * @returns {PhoneEntry|null} the entry now on offer
   */
  setOffering(on) {
    this.offering = !!on;
    if (on) return this.offer();
    const p = this.pending;
    if (p) { this.pending = null; this.entries.delete(p.n); p.destroy(); this._changed(); }
    return null;
  }

  /** Joined phones that are here and not seated: the screens' join candidates. */
  presentableEntries() {
    return [...this.entries.values()].filter((e) => e.everJoined && e.present && !e.attached);
  }

  /** Every phone that has joined (here or dropped). */
  joinedEntries() {
    return [...this.entries.values()].filter((e) => e.everJoined);
  }

  /** The entry whose input is `input`, or null. @param {any} input */
  entryForInput(input) {
    if (!input) return null;
    for (const e of this.entries.values()) if (e.input === input) return e;
    return null;
  }

  /** Menus or riding, for every phone. @param {'menu'|'ride'} mode */
  setMode(mode) {
    this.mode = mode;
    for (const e of this.entries.values()) e.host.setMode(mode);
  }

  /** A cue on every seated phone. @param {string} cue */
  cue(cue) {
    for (const e of this.entries.values()) if (e.attached) e.host.cue(cue);
  }

  /** Let one phone go. @param {PhoneEntry} e */
  remove(e) {
    if (this.pending === e) this.pending = null;
    this.entries.delete(e.n);
    e.destroy();
    this._changed();
  }

  _changed() { this.deps.onChange?.(this); }
}
