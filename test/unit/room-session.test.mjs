// #346 · RoomSession (js/lobby/room-session.js): the online room's create / join / rejoin /
// leave lifecycle, with fake transports, a fake host (the lobby's side) and manual timers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomSession, CONNECT_SETTLE_MS, STALE_ROOM_MS } from '../../js/lobby/room-session.js';
import { NetSession } from '../../js/lobby/net-session.js';

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
  constructor() { this.rooms = new Map(); this.log = []; }
  save(code, role, partnerName) { this.rooms.set(code, { roomCode: code, role, partnerName: partnerName || null }); this.log.push(['save', code, role]); }
  clear(code) { if (code) this.rooms.delete(code); else this.rooms.clear(); this.log.push(['clear', code || null]); }
  getRecent() { return [...this.rooms.values()]; }
}

function timers() {
  let now = 0; let id = 0;
  const pending = new Map();
  return {
    setTimeout: (fn, ms) => { pending.set(++id, { at: now + ms, fn }); return id; },
    clearTimeout: (t) => { pending.delete(t); },
    get count() { return pending.size; },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let next = null;
        for (const [k, v] of pending) if (v.at <= end && (!next || v.at < next[1].at)) next = [k, v];
        if (!next) break;
        pending.delete(next[0]); now = next[1].at; next[1].fn();
      }
      now = end;
    },
  };
}

const tick = () => new Promise((r) => setImmediate(r));

function setup({ step = 'host', token = null } = {}) {
  const t = timers();
  const ns = new NetSession(() => new FakeNet());
  const store = new FakeStore();
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
    staleRoom: (seat) => calls.push(['staleRoom', seat]),
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
  const rs = new RoomSession({ netSession: ns, store, relayUrl: 'ws://relay', auth, host, analytics, setTimeout: t.setTimeout, clearTimeout: t.clearTimeout });
  const last = (seat) => statuses[seat][statuses[seat].length - 1];
  return { t, ns, store, calls, statuses, host, auth, events, rs, last };
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
  assert.deepEqual(calls.at(-1), ['roomOpen', code, false]);
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
  assert.deepEqual(calls.at(-1), ['roomOpen', 'TNDM-WXYZ', true]);
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

test('stale rejoin: still alone after STALE_ROOM_MS offers New Room; New Room forgets it and leaves', async () => {
  const { rs, ns, store, calls, t } = setup();
  await rs.rejoin({ roomCode: 'TNDM-ABCD', role: 'captain' });
  ns.net.open();
  t.advance(STALE_ROOM_MS - 1);
  assert.ok(!calls.some((c) => c[0] === 'staleRoom'));
  t.advance(1);
  assert.deepEqual(calls.at(-1), ['staleRoom', 'host']);
  const net = ns.net;
  rs.abandonStale();
  assert.ok(net._destroyed);
  assert.equal(ns.net, null);
  assert.ok(!store.rooms.has('TNDM-ABCD'));
});

test('stale rejoin: the partner arriving in time cancels the prompt', async () => {
  const { rs, ns, calls, t } = setup();
  await rs.rejoin({ roomCode: 'TNDM-ABCD', role: 'stoker' });
  ns.net.open();
  ns.net.partnerReady();
  t.advance(STALE_ROOM_MS * 2);
  assert.ok(!calls.some((c) => c[0] === 'staleRoom'));
});

test('queueProfiles hands a moved room\'s early messages to the room screen', () => {
  const { rs } = setup();
  rs.queueProfiles([{ name: 'G' }]);
  assert.deepEqual(rs.takeQueued(), [{ name: 'G' }]);
  rs.queueProfiles([]);
  assert.deepEqual(rs.takeQueued(), []);
});
