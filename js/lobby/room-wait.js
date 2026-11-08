// @ts-check
// ============================================================
// RoomWait — what a player sees while an online room waits (#694)
// ============================================================
//
// Every waiting message says WHO (the partner's name when known, else "your Captain" /
// "your Stoker"), HOW LONG (counts up in 5 s steps, m:ss) and WHAT YOU CAN DO. A way out shows
// up after a sensible delay, never at once, and never goes away once shown; the pad's focus
// starts on the waiting choice so a press doesn't bail by accident.
//
//   A  host made a room, nobody joined        "You're the only one in room ABCD" … "Waiting 0:35…"
//   B  joined a code, nobody there            "No one else is in room ABCD yet · 0:05" → Try another code
//   C  rejoin, partner seen < 10 min ago      "Pete (your Captain) was here 3 min ago …" → New Room
//   D  rejoin, partner gone long / never      "Pete hasn't been in room ABCD for 2 h" → New Room at once
//   E  the room server can't be reached       "Can't reach the room server. Retrying in 5…"
//   F  both in, the partner idle              "Your Captain (Pete) hasn't moved for 0:30"
//   G  the in-race disconnect pause (#468)    "Pete (your Captain) lost connection" (game.js uses the copy)
//
// All the words are in ROOM_WAIT_COPY so they can be tweaked in one place. The views are pure
// functions of (state, now); RoomWait and IdleWatch only add a clock and a 1 s tick, both
// injectable (unit tests and smokes use fake clocks, no real 30 s waits).
// ============================================================

/** Delays, in ms. A smoke may shift the clock instead of changing these. */
export const ROOM_WAIT_MS = {
  step: 5000,               // count-ups move in 5 s steps
  hostCount: 30000,         // A · "Waiting 0:35…" from here
  joinGrace: 3000,          // B · the room open this long with no partner (or the relay said "waiting")
  joinOut: 15000,           // B · "Try another code" from here
  rejoinOut: 30000,         // C · "New Room" from here
  recentSeen: 10 * 60000,   // C vs D · last seen within this = "recently"
  unreachable: 5000,        // E · the room server hasn't let us in by now
  retryEvery: 5000,         // E · automatic retry period
  idle: 30000,              // F · "hasn't moved" from here
  pingEvery: 4000,          // F · at most one activity ping per this
  seenEvery: 30000,         // "partner last seen" is refreshed this often while connected
};

/** m:ss, floored to the count-up step. */
export function fmtClock(ms, step = ROOM_WAIT_MS.step) {
  const s = Math.max(0, Math.floor(Math.max(0, ms) / step) * step / 1000);
  const m = Math.floor(s / 60);
  return m + ':' + String(Math.floor(s % 60)).padStart(2, '0');
}

/** A duration in words: "1 min", "25 min", "2 h", "3 days". */
export function fmtSpan(ms) {
  const min = Math.max(1, Math.floor(ms / 60000));
  if (min < 60) return min + ' min';
  const h = Math.floor(min / 60);
  if (h < 48) return h + ' h';
  return Math.floor(h / 24) + ' days';
}

/** "just now" / "3 min ago" / "2 h ago". */
export function fmtAgo(ms) {
  return ms < 60000 ? 'just now' : fmtSpan(ms) + ' ago';
}

const ROLE_WORD = { captain: 'Captain', stoker: 'Stoker' };
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const shortCode = (code) => String(code || '').replace(/^TNDM-/, '');

/**
 * Every word the waits show. `p` = { name, role } of the PARTNER (role is theirs).
 * Tweak freely; the smokes match on the stable parts (room code, "only one", "Retrying", m:ss).
 */
export const ROOM_WAIT_COPY = {
  /** "Pete (your Captain)" / "your Captain" */
  partner: (p) => p.name ? `${p.name} (your ${ROLE_WORD[p.role] || 'partner'})` : `your ${ROLE_WORD[p.role] || 'partner'}`,
  /** F's order: "Your Captain (Pete)" / "Your Captain" */
  partnerRoleFirst: (p) => `Your ${ROLE_WORD[p.role] || 'partner'}` + (p.name ? ` (${p.name})` : ''),
  /** "Pete" / "Your Captain" (sentence start) */
  partnerShort: (p) => p.name || `Your ${ROLE_WORD[p.role] || 'partner'}`,

  // A
  hostAlone: (code) => `You're the only one in room ${shortCode(code)}. Share the code or the QR with your partner.`,
  hostAloneLong: (code, t) => `You're the only one in room ${shortCode(code)}. Waiting ${t}…`,
  // B
  joinEmpty: (code, t) => `No one else is in room ${shortCode(code)} yet · ${t}`,
  joinEmptyOut: (code, t) => `No one else is in room ${shortCode(code)} yet · ${t}. Check the code, or keep waiting.`,
  // B, when the room server remembers (#694): an old or never-used room is most likely a wrong code
  joinUnused: (code, span, t) => `Room ${shortCode(code)} hasn't been used for ${span}. Check the code · ${t}`,
  joinNeverUsed: (code, t) => `No one has opened room ${shortCode(code)} yet. Check the code · ${t}`,
  // C
  rejoinRecent: (p, ago, t) => `${cap(ROOM_WAIT_COPY.partner(p))} was here ${ago}. Waiting for them to come back · ${t}`,
  // D
  rejoinGone: (p, code, span, t) => `${ROOM_WAIT_COPY.partnerShort(p)} hasn't been in room ${shortCode(code)} for ${span}. Waiting ${t}`,
  rejoinNever: (code, t) => `No one else has been in room ${shortCode(code)} yet. Waiting ${t}`,
  // E
  unreachable: (n) => `Can't reach the room server. Retrying in ${n}…`,
  retrying: () => `Can't reach the room server. Retrying…`,
  // F
  idle: (p, t) => `${ROOM_WAIT_COPY.partnerRoleFirst(p)} hasn't moved for ${t}`,
  // G (game.js, the in-race disconnect pause)
  dropTitle: (p) => `${cap(ROOM_WAIT_COPY.partner(p))} lost connection`,
  dropWait: (t) => `Waiting for them to come back · ${t}.`,

  // buttons
  keepWaiting: 'Keep waiting',
  otherCode: 'Try another code',
  newRoom: 'New Room',
  back: 'Back',
  retry: 'Retry',
};

/**
 * @typedef {{ id: 'keep'|'other-code'|'new-room'|'back'|'retry', label: string }} WaitAction
 * @typedef {{ kind: 'A'|'B'|'C'|'D'|'E', text: string, actions: WaitAction[], focus: string|null, cls: string }} WaitView
 * @typedef {{ seat: 'host'|'join', kind: 'create'|'join'|'rejoin', code: string, role: 'captain'|'stoker',
 *             partner: { name?: string|null, seenAt?: number|null } | null,
 *             startedAt: number, openAt: number|null, absentAt: number|null,
 *             retryAt: number|null, outShown: boolean,
 *             relay?: { fresh: boolean, lastUsedAt: number|null, partnerSeenAt: number|null, partnerName: string|null } | null }} WaitState
 */

const act = (id) => ({ id, label: { keep: ROOM_WAIT_COPY.keepWaiting, 'other-code': ROOM_WAIT_COPY.otherCode, 'new-room': ROOM_WAIT_COPY.newRoom, back: ROOM_WAIT_COPY.back, retry: ROOM_WAIT_COPY.retry }[id] });

/** The partner's role, seen from `role`. */
export const otherRole = (role) => role === 'captain' ? 'stoker' : 'captain';

/**
 * What the wait shows at `now` (pure). Null = nothing to add yet (the lobby's own
 * "Creating room…" / "Connecting…" line stays).
 * @param {WaitState} s @param {number} now @returns {WaitView|null}
 */
export function roomWaitView(s, now, ms = ROOM_WAIT_MS) {
  if (!s) return null;
  // #694: what the room server remembers fills in what this device doesn't know (and a later
  // sighting there wins: the partner may have come back from another device).
  const r = s.relay || null;
  const localSeen = s.partner && typeof s.partner.seenAt === 'number' ? s.partner.seenAt : null;
  const relaySeen = r && typeof r.partnerSeenAt === 'number' ? r.partnerSeenAt : null;
  const p = { name: (s.partner && s.partner.name) || (r && r.partnerName) || null, role: otherRole(s.role) };
  // E · the room server never let us in (a refusal and a dead network look the same from here).
  if (s.openAt == null && now - s.startedAt >= ms.unreachable) {
    const n = s.retryAt == null ? Math.ceil(ms.retryEvery / 1000) : Math.max(0, Math.ceil((s.retryAt - now) / 1000));
    return { kind: 'E', text: n > 0 ? ROOM_WAIT_COPY.unreachable(n) : ROOM_WAIT_COPY.retrying(), actions: [act('retry'), act('back')], focus: 'retry', cls: 'error' };
  }
  if (s.kind === 'create') {
    if (s.openAt == null) return null;
    const t = now - s.openAt;
    return { kind: 'A', text: t >= ms.hostCount ? ROOM_WAIT_COPY.hostAloneLong(s.code, fmtClock(t)) : ROOM_WAIT_COPY.hostAlone(s.code), actions: [], focus: null, cls: '' };
  }
  if (s.kind === 'join') {
    if (s.openAt == null) return null;
    // Wait for the relay's "waiting" (or a moment) so a partner who IS there never flashes "no one".
    if (s.absentAt == null && now - s.openAt < ms.joinGrace) return null;
    const t = now - s.openAt;
    // #694: the room server says the room was never opened, or not for a long while: most
    // likely a wrong code, so say so and offer another code at once (Keep waiting still focused).
    if (r && (r.fresh || (r.lastUsedAt && now - r.lastUsedAt >= ms.recentSeen))) {
      const text = r.fresh ? ROOM_WAIT_COPY.joinNeverUsed(s.code, fmtClock(t)) : ROOM_WAIT_COPY.joinUnused(s.code, fmtSpan(now - r.lastUsedAt), fmtClock(t));
      return { kind: 'B', text, actions: [act('keep'), act('other-code')], focus: 'keep', cls: '' };
    }
    const out = s.outShown || t >= ms.joinOut;
    return out
      ? { kind: 'B', text: ROOM_WAIT_COPY.joinEmptyOut(s.code, fmtClock(t)), actions: [act('keep'), act('other-code')], focus: 'keep', cls: '' }
      : { kind: 'B', text: ROOM_WAIT_COPY.joinEmpty(s.code, fmtClock(t)), actions: [], focus: null, cls: '' };
  }
  // rejoin · C or D, from when the partner was last seen (stored with the recent room)
  const t = now - s.startedAt;
  const seens = [localSeen, relaySeen].filter((x) => x != null);
  const seenAt = seens.length ? Math.max(...seens) : null;
  // The stoker can't make a room of their own (the captain's code is the room): their way out
  // is another code. The captain's is a real fresh room, same seat.
  const fresh = s.role === 'captain' ? 'new-room' : 'other-code';
  if (seenAt != null && now - seenAt < ms.recentSeen) {
    const out = s.outShown || t >= ms.rejoinOut;
    return { kind: 'C', text: ROOM_WAIT_COPY.rejoinRecent(p, fmtAgo(now - seenAt), fmtClock(t)),
      actions: out ? [act('keep'), act(fresh), act('back')] : [], focus: out ? 'keep' : null, cls: '' };
  }
  const text = seenAt != null ? ROOM_WAIT_COPY.rejoinGone(p, s.code, fmtSpan(now - seenAt), fmtClock(t)) : ROOM_WAIT_COPY.rejoinNever(s.code, fmtClock(t));
  return { kind: 'D', text, actions: [act('keep'), act(fresh)], focus: 'keep', cls: '' };
}

/**
 * The live wait for one room attempt: holds its state, ticks once a second, and hands the
 * host a view whenever the words or the buttons change.
 */
export class RoomWait {
  /**
   * @param {object} o
   * @param {(seat: 'host'|'join', view: WaitView|null) => void} o.render
   * @param {() => void} [o.retry]                         E · dial the room server again
   * @param {() => number} [o.now]
   * @param {(fn: () => void, ms: number) => any} [o.setInterval]
   * @param {(t: any) => void} [o.clearInterval]
   */
  constructor({ render, retry, now, setInterval: si, clearInterval: ci }) {
    this._render = render;
    this._retry = retry || (() => {});
    /** The clock (a smoke may replace it to skip ahead). */
    this.now = now || (() => Date.now());
    this._setInterval = si || ((fn, ms) => setInterval(fn, ms));
    this._clearInterval = ci || ((t) => clearInterval(t));
    /** @type {WaitState|null} */
    this.state = null;
    this._timer = null;
    this._last = '';
  }

  /** A new room attempt (replaces any other). */
  begin({ seat, kind, code, role, partner = null }) {
    this.end();
    this.state = { seat, kind, code, role, partner, startedAt: this.now(), openAt: null, absentAt: null, retryAt: null, outShown: false };
    this._timer = this._setInterval(() => this.tick(), 1000);
    this.tick();
  }

  /** The relay let us into the room. */
  roomOpen() { if (this.state && this.state.openAt == null) { this.state.openAt = this.now(); this.state.retryAt = null; this.tick(); } }

  /** The relay says the partner is not in the room (and, from #694 on, what the room remembers). */
  partnerAbsent(info = null) {
    const s = this.state;
    if (!s) return;
    if (info) s.relay = info;
    if (s.absentAt == null) s.absentAt = this.now();
    this.tick();
  }

  /** Retry now (the E line's button); the countdown starts over. */
  retryNow() {
    const s = this.state;
    if (!s) return;
    s.retryAt = this.now() + ROOM_WAIT_MS.retryEvery;
    try { this._retry(true); } catch (e) { /* the transport is gone */ }
    this.tick();
  }

  /** The partner arrived, or the room was left: stop (and clear what the wait showed). */
  end() {
    if (this._timer) { this._clearInterval(this._timer); this._timer = null; }
    const was = this.state;
    this.state = null;
    this._last = '';
    if (was) this._render(was.seat, null);
  }

  /** The current view (pure; for tests and the lobby). */
  view() { return this.state ? roomWaitView(this.state, this.now()) : null; }

  tick() {
    const s = this.state;
    if (!s) return;
    const now = this.now();
    let v = roomWaitView(s, now);
    if (v && v.kind === 'E') {
      if (s.retryAt == null) s.retryAt = now + ROOM_WAIT_MS.retryEvery;
      else if (now >= s.retryAt) { s.retryAt = now + ROOM_WAIT_MS.retryEvery; try { this._retry(false); } catch (e) { /* gone */ } }
      v = roomWaitView(s, now);
    }
    // A way out, once shown, stays (B and C keep their buttons even if the clock moves back).
    if (v && v.actions.some((a) => a.id !== 'retry' && a.id !== 'back')) s.outShown = true;
    const key = v ? v.kind + '|' + v.text + '|' + v.actions.map((a) => a.id).join(',') : '';
    // A view is drawn every tick (cheap: the lobby only touches what changed), so a status the
    // lobby wrote meanwhile ("Waiting for partner...", "Reconnecting...") never sticks over it.
    if (!v && key === this._last) return;
    this._last = key;
    this._render(s.seat, v);
  }
}

/**
 * F · is the connected partner idle? Fed by the partner's room messages (any message counts;
 * the ACTIVITY ping is the steady one). Old builds that never ping never show "hasn't moved".
 */
export class IdleWatch {
  /** @param {{ now?: () => number }} [o] */
  constructor({ now } = {}) {
    this.now = now || (() => Date.now());
    this.reset();
  }

  reset() { this.pingSeen = false; this.lastAt = this.now(); }

  /** Something from the partner. `ping` = it was an ACTIVITY ping (the partner's build sends them). */
  heard(ping = false) {
    if (ping) this.pingSeen = true;
    this.lastAt = this.now();
  }

  /** "Your Captain (Pete) hasn't moved for 0:30", or '' while they're active (or can't say). */
  text(partner, ms = ROOM_WAIT_MS) {
    if (!this.pingSeen) return '';
    const t = this.now() - this.lastAt;
    return t >= ms.idle ? ROOM_WAIT_COPY.idle(partner, fmtClock(t)) : '';
  }
}

/**
 * F · the sending side: at most one ping per `every`, and only when this player did
 * something since the last one ("only on change").
 */
export class ActivityPinger {
  /** @param {{ send: () => void, now?: () => number, every?: number }} o */
  constructor({ send, now, every = ROOM_WAIT_MS.pingEvery }) {
    this._send = send;
    this.now = now || (() => Date.now());
    this.every = every;
    this.dirty = true;     // the first ping goes out as soon as the room is up
    this.lastSent = -Infinity;
  }

  /** This player did something (a key, a click, a pad button). */
  mark() { this.dirty = true; }

  /** Called often; sends when due. Returns true if it sent. */
  pump() {
    const now = this.now();
    if (!this.dirty || now - this.lastSent < this.every) return false;
    this.dirty = false;
    this.lastSent = now;
    try { this._send(); } catch (e) { return false; }
    return true;
  }
}
