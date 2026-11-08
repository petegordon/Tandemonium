// #346 · RoomSession (js/lobby/room-session.js): the online room's create / join / rejoin /
// leave lifecycle, with fake transports, a fake host (the lobby's side) and manual timers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomSession, CONNECT_SETTLE_MS } from '../../js/lobby/room-session.js';
import { ROOM_WAIT_MS } from '../../js/lobby/room-wait.js';
const LONG = 60 * 60000;   // longer than any wait's clock
import { NetSession, NET_CALLBACKS } from '../../js/lobby/net-session.js';
const noop = () => {};

let codeSeq = 0;
class FakeNet {
  constructor() {
    this.entered = [];
    this.retried = [];
    this.connected = false;
    this.roomCode = null;
    this._destroyed = false;
    this.destroyCount = 0;
    this.media = null;
    for (const k of FakeNet.CALLBACKS) this[k] = null;
  }
  generateRoomCode() { return 'TNDM-' + 'ABCDEFGH'.slice(codeSeq % 5, codeSeq++ % 5 + 4); }
  enterRoom(code, role) { this.roomCode = code; this.role = role; this.entered.push([code, role]); }
  retryWithToken(t) { this.retried.push(t); }
  async acquireLocalMedia(cam, mic) { this.media = [cam, mic]; }
  destroy() { this._destroyed = true; this.destroyCount++; this.connected = false; }
  // relay events, as RoomTransport fires them
  open() { if (this.onRoomJoined) this.onRoomJoined(); }
  partnerReady() { this.connected = true; if (this.onConnected) this.onConnected(); }
  drop(reason) { this.connected = false; if (this.onDisconnected) this.onDisconnected(reason); }
  profile(p) { if (this.onProfileReceived) this.onProfileReceived(p); }
}
FakeNet.CALLBACKS = ['onRoomJoined', 'onConnected', 'onDisconnected', 'onAuthError', 'onProfileReceived', 'onPartnerLeft',
  'onReconnecting', 'onRemoteStream', 'onP2PUpgrade', 'onPedalReceived', 'onStateReceived', 'onLeanReceived', 'onEventReceived'];

class FakeStore {
  constructor(now = () => 0) { this.rooms = new Map(); this.log = []; this.now = now; }
  save(code, role, partnerName) { const old = this.rooms.get(code) || {}; this.rooms.set(code, { ...old, roomCode: code, role, partnerName: partnerName || old.partnerName || null }); this.log.push(['save', code, role]); }
  markSeen(code) { const r = this.rooms.get(code); if (r) r.partnerSeenAt = this.now(); this.log.push(['seen', code]); }
  clear(code) { if (code) this.rooms.delete(code); else this.rooms.clear(); this.log.push(['clear', code || null]); }
  getRecent() { return [...this.rooms.values()]; }
}

function timers() {
  let now = 0; let id = 0;
  const pending = new Map();
  return {
    setTimeout: (fn, ms) => { pending.set(++id, { at: now + ms, fn }); return id; },
    clearTimeout: (t) => { pending.delete(t); },
    setInterval: (fn, ms) => { pending.set(++id, { at: now + ms, fn, every: ms }); return id; },
    clearInterval: (t) => { pending.delete(t); },
    get now() { return now; },
    get count() { return pending.size; },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let next = null;
        for (const [k, v] of pending) if (v.at <= end && (!next || v.at < next[1].at)) next = [k, v];
        if (!next) break;
        pending.delete(next[0]); now = next[1].at;
        if (next[1].every) pending.set(next[0], { ...next[1], at: now + next[1].every });
        next[1].fn();
      }
      now = end;
    },
  };
}

const tick = () => new Promise((r) => setImmediate(r));

function setup({ step = 'host', token = null } = {}) {
  const t = timers();
  const ns = new NetSession(() => new FakeNet());
  const store = new FakeStore(() => t.now);
  const calls = [];
  const statuses = { host: [], join: [] };
  const host = {
    step,
    replaceNet: () => { calls.push(['replaceNet']); return ns.replace(); },
    media: () => ({ camera: true, audio: false, cameraPermitted: true, audioPermitted: false }),
    newRoom: (kind) => calls.push(['newRoom', kind]),
    status: (seat, text, cls) => statuses[seat].push([text, cls]),
    showCode: (text) => calls.push(['showCode', text]),
    roomOpen: (code, o) => calls.push(['roomOpen', code, o.rejoin]),
    partnerHere: (role) => calls.push(['partnerHere', role]),
    partnerConnected: (role) => calls.push(['partnerConnected', role]),
    connectFailed: (role, code) => calls.push(['connectFailed', role, code]),
    onStep: (name) => name === host.step,
    // #694: the waiting line (RoomWait); logged as [wait, seat, kind, action ids, text]
    wait: (seat, v) => calls.push(['wait', seat, v ? v.kind : null, v ? v.actions.map((a) => a.id).join(',') : '', v ? v.text : '']),
  };
  const auth = {
    tokens: 0,
    getRelayToken: async () => { auth.tokens++; return token; },
    ensureValidToken: async () => auth.refreshed,
    refreshed: false,
  };
  const events = [];
  const analytics = {
    trackRoomCreate: (c) => events.push(['create', c]),
    trackEvent: (n, d) => events.push([n, d]),
    trackRoomUpdate: (c, d) => events.push(['update', c, d]),
    trackConversion: (n) => events.push(['conv', n]),
    getSessionId: () => 'sid',
  };
  const rs = new RoomSession({ netSession: ns, store, relayUrl: 'ws://relay', auth, host, analytics, setTimeout: t.setTimeout, clearTimeout: t.clearTimeout,
    setInterval: t.setInterval, clearInterval: t.clearInterval, now: () => t.now });
  const lastWait = () => calls.filter((c) => c[0] === 'wait').at(-1) || null;
  const last = (seat) => statuses[seat][statuses[seat].length - 1];
  return { t, ns, store, calls, statuses, host, auth, events, rs, last, lastWait };
}

test('autoJoinCode reads ?room= with or without the TNDM- prefix', () => {
  assert.equal(RoomSession.autoJoinCode('?room=ab2c'), 'TNDM-AB2C');
  assert.equal(RoomSession.autoJoinCode('?demo=1&room=tndm-ab2c'), 'TNDM-AB2C');
  assert.equal(RoomSession.autoJoinCode('?demo=1'), null);
  assert.equal(RoomSession.autoJoinCode(''), null);
});

test('create: opens a captain room, saves it once the relay has us, opens the room screen after the settle delay', async () => {
  const { rs, ns, store, calls, last, t, events } = setup({ token: 'tok' });
  const code = await rs.create();
  const net = ns.net;
  assert.deepEqual(net.entered, [[code, 'captain']]);
  assert.equal(net._fallbackUrl, 'ws://relay');
  assert.equal(net.cameraEnabled, true);
  assert.equal(net.audioEnabled, false);
  assert.equal(net._relayToken, 'tok');
  assert.deepEqual(calls.slice(0, 3), [['replaceNet'], ['newRoom', 'create'], ['showCode', '----']]);
  assert.ok(events.some((e) => e[0] === 'room_create'));
  net.open();
  assert.deepEqual(calls.filter((c) => c[0] !== 'wait').at(-1), ['roomOpen', code, false]);
  assert.deepEqual(last('host'), ['Waiting for partner...', undefined]);
  assert.equal(store.rooms.get(code).role, 'captain');
  net.partnerReady();
  assert.deepEqual(last('host'), ['Partner connected!', 'connected']);
  assert.ok(!calls.some((c) => c[0] === 'partnerConnected'));
  t.advance(CONNECT_SETTLE_MS);
  assert.deepEqual(calls.at(-1), ['partnerConnected', 'captain']);
  net.drop('gone');
  assert.deepEqual(last('host'), ['gone', 'error']);
});

test('join: stoker room; a failed join tells the host the code to retry', async () => {
  const { rs, ns, store, calls, last, t, events } = setup({ step: 'join' });
  await rs.join('TNDM-WXYZ', { viaUrl: true });
  const net = ns.net;
  assert.deepEqual(net.entered, [['TNDM-WXYZ', 'stoker']]);
  assert.equal(net._relayToken, undefined);
  assert.ok(events.some((e) => e[0] === 'conv' && e[1] === 'stoker_joined_via_url'));
  net.open();
  assert.deepEqual(last('join'), ['Waiting for captain...', undefined]);
  assert.equal(store.rooms.get('TNDM-WXYZ').role, 'stoker');
  net.partnerReady();
  assert.deepEqual(calls.at(-1), ['partnerHere', 'stoker']);
  t.advance(CONNECT_SETTLE_MS);
  assert.deepEqual(calls.at(-1), ['partnerConnected', 'stoker']);
  net.drop();
  assert.deepEqual(last('join'), ['Could not connect', 'error']);
  assert.deepEqual(calls.at(-1), ['connectFailed', 'stoker', 'TNDM-WXYZ']);
});

test('auth refusal: the captain keeps dialling and, on the host step only, queues "sign in, then create"', async () => {
  const { rs, ns, host } = setup({ step: 'host' });
  await rs.create();
  const net = ns.net;
  await net.onAuthError();
  assert.equal(net.entered.length, 2);
  assert.equal(rs.pendingCreate, true);
  rs.pendingCreate = false;
  host.step = 'level';
  await net.onAuthError();
  assert.equal(rs.pendingCreate, false);
});

test('auth refusal: the stoker retries and, on the join step only, queues the code', async () => {
  const { rs, ns } = setup({ step: 'join' });
  await rs.join('TNDM-WXYZ');
  await ns.net.onAuthError();
  assert.equal(ns.net.retried.length, 1);
  assert.equal(rs.pendingJoinCode, 'TNDM-WXYZ');
});

test('rejoin: same seat and code, media first, the partner\'s early messages buffered for the room screen', async () => {
  const { rs, ns, store, calls, last, t } = setup();
  await rs.rejoin({ roomCode: 'TNDM-ABCD', role: 'stoker' });
  const net = ns.net;
  assert.deepEqual(net.media, [true, false]);
  assert.deepEqual(net.entered, [['TNDM-ABCD', 'stoker']]);
  assert.deepEqual(calls[1], ['newRoom', 'rejoin']);
  assert.deepEqual(last('join'), ['Rejoining room...', '']);
  net.open();
  assert.equal(store.rooms.get('TNDM-ABCD').role, 'stoker');
  net.partnerReady();
  net.profile({ name: 'Pat' });
  net.profile({ type: 'levelSync', levelId: 'daily' });
  t.advance(CONNECT_SETTLE_MS);
  assert.deepEqual(calls.at(-1), ['partnerConnected', 'stoker']);
  assert.deepEqual(rs.takeQueued(), [{ name: 'Pat' }, { type: 'levelSync', levelId: 'daily' }]);
  assert.deepEqual(rs.takeQueued(), [], 'taken once');
});

test('rejoin as captain shows the code (roomOpen rejoin=true)', async () => {
  const { rs, ns, calls } = setup();
  await rs.rejoin({ roomCode: 'TNDM-WXYZ', role: 'captain' });
  ns.net.open();
  assert.deepEqual(calls.filter((c) => c[0] !== 'wait').at(-1), ['roomOpen', 'TNDM-WXYZ', true]);
});

test('a superseded attempt never touches the newer room', async () => {
  const { rs, ns, calls, last } = setup({ step: 'join' });
  await rs.join('TNDM-AAAA');
  const first = ns.net;
  await rs.join('TNDM-BBBB');
  assert.ok(first._destroyed);
  const n = calls.length;
  first.onRoomJoined?.(); first.onConnected?.(); first.onDisconnected?.('x');
  assert.equal(calls.length, n);
  assert.notDeepEqual(last('join'), ['x', 'error']);
});

test('leave destroys the room; forget drops it from Recent Rooms', async () => {
  const { rs, ns, store } = setup();
  await rs.create();
  const net = ns.net;
  net.open();
  rs.leave();
  assert.ok(net._destroyed);
  assert.equal(ns.net, null);
  assert.equal(store.rooms.size, 1, 'kept for a rejoin');
  await rs.create();
  const net2 = ns.net; net2.open();
  rs.leave({ forget: true });
  assert.ok(!store.rooms.has(net2.roomCode));
  rs.leave();   // nothing to leave: no throw
});

test('dropIfCurrent leaves only when the dropped transport is still the room', async () => {
  const { rs, ns } = setup();
  await rs.create();
  const a = ns.net;
  assert.equal(rs.dropIfCurrent(a), true);
  assert.equal(ns.net, null);
  await rs.create();
  const b = ns.net;
  assert.equal(rs.dropIfCurrent(a), false);
  assert.equal(ns.net, b);
});

test('queueProfiles hands a moved room\'s early messages to the room screen', () => {
  const { rs } = setup();
  rs.queueProfiles([{ name: 'G' }]);
  assert.deepEqual(rs.takeQueued(), [{ name: 'G' }]);
  rs.queueProfiles([]);
  assert.deepEqual(rs.takeQueued(), []);
});

// ── #346 hardening ───────────────────────────────────────────

test('NetSession retires a transport fully: every callback (the ride\'s too) detached, onRetire told', () => {
  const retired = [];
  const ns = new NetSession(() => new FakeNet());
  ns.onRetire = (n) => retired.push(n);
  const a = ns.replace();
  for (const k of NET_CALLBACKS) a[k] = () => { throw new Error(k + ' ran on a retired transport'); };
  const b = ns.replace();
  assert.ok(a._destroyed);
  for (const k of NET_CALLBACKS) assert.equal(a[k], null, k);
  assert.deepEqual(retired, [a]);
  const e = ns.epoch;
  for (const k of NET_CALLBACKS) b[k] = noop;
  ns.clear();
  assert.equal(ns.net, null);
  assert.ok(b._destroyed);
  for (const k of NET_CALLBACKS) assert.equal(b[k], null, k);
  assert.ok(!ns.isCurrent(e), 'clear bumps the epoch');
  assert.deepEqual(retired, [a, b]);
  ns.clear();   // nothing to clear: no throw, no retire
  assert.equal(retired.length, 2);
  const c = ns.replace(); const d = new FakeNet();
  ns.adopt(d);
  assert.ok(c._destroyed && c._partnerLeft === true, 'adopt closes quietly');
  assert.deepEqual(retired, [a, b, c]);
});

test('every callback a consumer sets on a NetworkManager is in NET_CALLBACKS', async () => {
  const fs = await import('node:fs');
  const src = ['js/game.js', 'js/lobby.js', 'js/lobby/room-session.js', 'js/lobby/room-move.js']
    .map((f) => fs.readFileSync(new URL('../../' + f, import.meta.url), 'utf8')).join('\n');
  const set = new Set([...src.matchAll(/\b(?:net|Net|this\.net|rideNet|roomNet|old)\.(on[A-Z]\w+)\s*=(?!=)/g)].map((m) => m[1]));
  set.delete('onMessage');   // the transport's own codec hook, never a consumer's
  for (const k of set) assert.ok(NET_CALLBACKS.includes(k), k + ' is set by a consumer but not detached on retire');
});

test('a create superseded while its token is on its way never touches the newer room', async () => {
  const s = setup();
  let release;
  s.auth.getRelayToken = () => new Promise((r) => { release = r; });
  const first = s.rs.create();
  const firstNet = s.ns.net;
  const releaseFirst = release;
  const second = s.rs.create();
  const secondNet = s.ns.net;
  releaseFirst('old-token');
  assert.equal(await first, null);
  assert.deepEqual(secondNet.entered, [], 'the first create did not dial the second room');
  assert.equal(secondNet.onRoomJoined, null, 'nor wire its callbacks onto it');
  assert.ok(firstNet._destroyed);
  release(null);
  const code = await second;
  assert.deepEqual(secondNet.entered, [[code, 'captain']]);
});

test('a join that is left while its token is on its way does not dial', async () => {
  const s = setup({ step: 'join' });
  let release;
  s.auth.getRelayToken = () => new Promise((r) => { release = r; });
  const p = s.rs.join('TNDM-WXYZ');
  const net = s.ns.net;
  s.rs.leave();
  release(null);
  await p;
  assert.deepEqual(net.entered, []);
  assert.equal(s.ns.net, null);
});

test('Back within the settle second: the room screen never opens over the role screen', async () => {
  const { rs, ns, calls, t } = setup();
  await rs.create();
  ns.net.open();
  ns.net.partnerReady();
  rs.leave();
  t.advance(CONNECT_SETTLE_MS * 2);
  assert.ok(!calls.some((c) => c[0] === 'partnerConnected'));
});

test('create and join hold the partner\'s first messages for the room screen too', async () => {
  for (const kind of ['create', 'join']) {
    const { rs, ns, t } = setup({ step: kind === 'create' ? 'host' : 'join' });
    if (kind === 'create') await rs.create(); else await rs.join('TNDM-WXYZ');
    ns.net.open();
    ns.net.partnerReady();
    ns.net.profile({ type: 'cameraToggle', enabled: false });
    t.advance(CONNECT_SETTLE_MS);
    assert.deepEqual(rs.takeQueued(), [{ type: 'cameraToggle', enabled: false }], kind);
  }
});

test('repeated room in / out leaves nothing behind', async () => {
  const retired = [];
  const s = setup({ step: 'join' });
  s.ns.onRetire = (n) => retired.push(n);
  const nets = [];
  for (let i = 0; i < 5; i++) {
    await s.rs.join('TNDM-WXYZ'); nets.push(s.ns.net); s.ns.net.open(); s.ns.net.partnerReady();
    await s.rs.rejoin({ roomCode: 'TNDM-WXYZ', role: 'stoker' }); nets.push(s.ns.net); s.ns.net.open();
    await s.rs.create(); nets.push(s.ns.net);
    s.rs.leave();
  }
  s.t.advance(LONG);
  assert.equal(s.ns.net, null);
  assert.equal(retired.length, nets.length);
  for (const n of nets) {
    assert.equal(n.destroyCount, 1, 'destroyed exactly once');
    for (const k of NET_CALLBACKS) assert.equal(n[k], null, k);
  }
  assert.ok(!s.calls.some((c) => c[0] === 'partnerConnected'));
  assert.equal(s.lastWait()[2], null, 'the last wait was cleared');
  assert.equal(s.t.count, 0);
});

// ── #694 · the waiting line (RoomWait inside RoomSession) ──

test('A: a captain alone in a new room: "only one in room", then a count-up after 0:30', async () => {
  const { rs, ns, t, lastWait } = setup();
  const code = await rs.create();
  assert.equal(lastWait(), null, 'nothing before the relay opens');
  ns.net.open();
  assert.deepEqual(lastWait().slice(0, 4), ['wait', 'host', 'A', '']);
  assert.match(lastWait()[4], new RegExp(`only one in room ${code.slice(5)}`));
  t.advance(ROOM_WAIT_MS.hostCount + 5000);
  assert.match(lastWait()[4], /Waiting 0:35…/);
  ns.net.partnerReady();
  assert.equal(lastWait()[2], null, 'the partner arriving clears it');
  rs.leave();
  t.advance(LONG);
  assert.equal(t.count, 0, 'no timers left behind');
});

test('B: a joiner alone: "No one else" once the relay says waiting, the way out after 0:15 and never gone', async () => {
  const { rs, ns, t, lastWait } = setup({ step: 'join' });
  await rs.join('TNDM-WXYZ');
  ns.net.open();
  assert.equal(lastWait(), null, 'no "no one" flash while a partner may still be arriving');
  ns.net.onRoomWaiting();
  assert.deepEqual(lastWait().slice(0, 4), ['wait', 'join', 'B', '']);
  assert.match(lastWait()[4], /No one else is in room WXYZ yet · 0:00/);
  t.advance(ROOM_WAIT_MS.joinOut - 1000);
  assert.equal(lastWait()[3], '');
  t.advance(1000);
  assert.equal(lastWait()[3], 'keep,other-code');
  assert.match(lastWait()[4], /0:15\. Check the code/);
  t.advance(60000);
  assert.equal(lastWait()[3], 'keep,other-code', 'still offered');
  rs.leave({ forget: true });
});

test('C: rejoin, partner seen 3 min ago: names them, New Room (captain) only after 0:30', async () => {
  const { rs, ns, t, store, lastWait } = setup();
  t.advance(LONG);
  store.rooms.set('TNDM-ABCD', { roomCode: 'TNDM-ABCD', role: 'captain', partnerName: 'Pat', partnerSeenAt: t.now - 3 * 60000 });
  await rs.rejoin({ roomCode: 'TNDM-ABCD', role: 'captain' });
  assert.equal(lastWait()[2], 'C');
  assert.match(lastWait()[4], /^Pat \(your Stoker\) was here 3 min ago\. Waiting for them to come back · 0:00$/);
  assert.equal(lastWait()[3], '');
  ns.net.open();
  t.advance(ROOM_WAIT_MS.rejoinOut);
  assert.equal(lastWait()[3], 'keep,new-room,back');
  // New Room is a REAL fresh room in the same seat (not the role screen)
  const old = ns.net;
  const code = await rs.newRoom();
  assert.ok(old._destroyed);
  assert.ok(!store.rooms.has('TNDM-ABCD'), 'the stale room is forgotten');
  assert.ok(code && code !== 'TNDM-ABCD');
  assert.deepEqual(ns.net.entered, [[code, 'captain']]);
});

test('C for a stoker: the way out is another code (only a captain can make a room)', async () => {
  const { rs, ns, t, store, lastWait } = setup({ step: 'join' });
  t.advance(LONG);
  store.rooms.set('TNDM-ABCD', { roomCode: 'TNDM-ABCD', role: 'stoker', partnerName: null, partnerSeenAt: t.now - 30000 });
  await rs.rejoin({ roomCode: 'TNDM-ABCD', role: 'stoker' });
  assert.match(lastWait()[4], /^Your Captain was here just now/);
  ns.net.open();
  t.advance(ROOM_WAIT_MS.rejoinOut);
  assert.equal(lastWait()[3], 'keep,other-code,back');
});

test('D: rejoin, partner gone 2 h (or never seen): New Room at once, Keep waiting focused', async () => {
  const { rs, ns, t, store, lastWait } = setup();
  t.advance(LONG * 3);
  store.rooms.set('TNDM-ABCD', { roomCode: 'TNDM-ABCD', role: 'captain', partnerName: 'Pat', partnerSeenAt: t.now - 2 * LONG });
  await rs.rejoin({ roomCode: 'TNDM-ABCD', role: 'captain' });
  assert.equal(lastWait()[2], 'D');
  assert.equal(lastWait()[3], 'keep,new-room');
  assert.match(lastWait()[4], /^Pat hasn't been in room ABCD for 2 h\./);
  rs.leave();
  await rs.rejoin({ roomCode: 'TNDM-NEVR', role: 'captain' });
  assert.match(lastWait()[4], /^No one else has been in room NEVR yet/);
  assert.equal(lastWait()[3], 'keep,new-room');
  ns.net.open();
  ns.net.partnerReady();
  assert.equal(lastWait()[2], null);
});

test('E: a room server that never lets us in says so (no partner wording) and retries every 5 s', async () => {
  const { rs, ns, t, lastWait } = setup({ step: 'join' });
  await rs.rejoin({ roomCode: 'TNDM-ABCD', role: 'stoker' });
  t.advance(ROOM_WAIT_MS.unreachable);
  assert.equal(lastWait()[2], 'E');
  assert.equal(lastWait()[3], 'retry,back');
  assert.match(lastWait()[4], /^Can't reach the room server\. Retrying in 5…$/);
  assert.doesNotMatch(lastWait()[4], /partner|captain|stoker/i);
  t.advance(ROOM_WAIT_MS.retryEvery);
  assert.equal(ns.net.retried.length, 1, 'retried on its own');
  rs.wait.retryNow();
  assert.equal(ns.net.retried.length, 2, 'Retry dials at once');
  ns.net.open();
  assert.notEqual(lastWait()[2], 'E', 'in the room: E is over');
  rs.leave();
});

test('partner last seen: stored on connect, kept fresh while connected, and on leaving', async () => {
  const { rs, ns, t, store } = setup();
  const code = await rs.create();
  ns.net.open();
  ns.net.partnerReady();
  assert.equal(store.rooms.get(code).partnerSeenAt, t.now);
  t.advance(ROOM_WAIT_MS.seenEvery * 2);
  assert.equal(store.rooms.get(code).partnerSeenAt, t.now);
  t.advance(1000);
  rs.leave();
  assert.equal(store.rooms.get(code).partnerSeenAt, t.now);
  t.advance(LONG);
  assert.equal(t.count, 0);
});

test('a left or superseded attempt never draws a wait again', async () => {
  const { rs, ns, t, calls } = setup();
  await rs.rejoin({ roomCode: 'TNDM-ABCD', role: 'captain' });
  const old = ns.net;
  rs.leave();
  const n = calls.length;
  t.advance(LONG);
  if (old.onRoomWaiting) old.onRoomWaiting();
  assert.equal(calls.length, n);
  assert.equal(t.count, 0);
});
