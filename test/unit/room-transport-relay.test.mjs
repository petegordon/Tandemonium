// TV playtest 2026-11-06 · the online ride dropped in a relay replace loop. The relay keeps one
// socket per room + role and closes the older one ("replaced"); a socket the transport had
// already moved on from still acted on its close, re-dialled, replaced the live socket, and so on.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { RoomTransport } from '../../js/net/room-transport.js';

let sockets;
class FakeWS {
  static OPEN = 1;
  constructor(url) { this.url = url; this.readyState = 0; this.closed = false; sockets.push(this); }
  open() { this.readyState = 1; this.onopen && this.onopen(); }
  // Like a browser: close() fires onclose (later) on whatever handler is still attached.
  close() { if (this.closed) return; this.closed = true; this.readyState = 3; const h = this.onclose; if (h) queueMicrotask(() => h({ code: 1005, reason: '' })); }
  /** The server closes it. */
  drop(reason = '') { this.readyState = 3; this.onclose && this.onclose({ code: 1000, reason }); }
  send() {}
}

let timers;
const realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout;
beforeEach(() => {
  sockets = [];
  timers = [];
  globalThis.WebSocket = FakeWS;
  globalThis.setTimeout = (fn, ms) => { const t = { fn, ms, done: false }; timers.push(t); return t; };
  globalThis.clearTimeout = (t) => { if (t) t.done = true; };
});
afterEach(() => { globalThis.setTimeout = realSetTimeout; globalThis.clearTimeout = realClearTimeout; });
const runTimers = () => { for (const t of timers.splice(0)) if (!t.done) { t.done = true; t.fn(); } };
const live = () => sockets.filter((s) => !s.closed && s.readyState !== 3);

function transport() {
  const t = new RoomTransport();
  t._fallbackUrl = 'wss://relay.test/room';
  t._attemptP2PUpgrade = () => {};
  return t;
}

test('entering the room again closes the old socket first; its late close does nothing', () => {
  const t = transport();
  t.enterRoom('TNDM-AAAA', 'captain');
  sockets[0].open();
  t.enterRoom('TNDM-AAAA', 'captain');   // the auth-refresh path
  assert.equal(sockets.length, 2);
  assert.equal(sockets[0].closed, true, 'the first socket was closed');
  assert.equal(sockets[0].onclose, null, 'and its handlers detached');
  sockets[1].open();
  runTimers();
  assert.equal(sockets.length, 2, 'no extra dial');
});

test('a plain drop still reconnects, once', () => {
  const t = transport();
  t.enterRoom('TNDM-AAAA', 'captain');
  sockets[0].open();
  sockets[0].drop();
  runTimers();
  assert.equal(sockets.length, 2);
  assert.equal(live().length, 1);
});

test('a retry timer does not dial when something else already has', () => {
  const t = transport();
  t.enterRoom('TNDM-AAAA', 'captain');
  sockets[0].open();
  sockets[0].drop();                       // schedules a retry
  t.retryWithToken('fresh');               // meanwhile: an auth refresh dials
  runTimers();
  assert.equal(sockets.length, 2, 'the retry saw the refresh socket and stood down');
});

test('after destroy nothing re-dials and late events are ignored', () => {
  const t = transport();
  t.enterRoom('TNDM-AAAA', 'captain');
  sockets[0].open();
  const old = sockets[0];
  const onclose = old.onclose;
  globalThis.document = { getElementById: () => null, removeEventListener() {} };
  try { t.destroy(); } finally { delete globalThis.document; }
  if (onclose) onclose({ code: 1006, reason: '' });
  runTimers();
  assert.equal(sockets.length, 1);
  t._connectRelay();
  assert.equal(sockets.length, 1, 'a destroyed transport never dials');
});

test('relay refusals back off instead of hammering', () => {
  const t = transport();
  const calls = [];
  t.onAuthError = () => calls.push(timers.length);
  t.enterRoom('TNDM-AAAA', 'captain');
  sockets[0].drop();                       // never opened = refused
  assert.equal(timers.at(-1).ms, 0, 'first refusal: handled at once');
  runTimers();
  assert.equal(calls.length, 1);
  t.enterRoom('TNDM-AAAA', 'captain');
  sockets[1].drop();
  assert.equal(timers.at(-1).ms, 1000);
  runTimers();
  t.enterRoom('TNDM-AAAA', 'captain');
  sockets[2].drop();
  assert.equal(timers.at(-1).ms, 2000);
  runTimers();
  t.enterRoom('TNDM-AAAA', 'captain');
  sockets[3].open();                       // accepted: the backoff resets
  assert.equal(t._relayAuthFailures, 0);
});

const flush = () => new Promise((r) => realSetTimeout(r, 0));

test('the storm itself: a CONNECTING socket dropped by a token retry never reports a refusal', async () => {
  const t = transport();
  let refusals = 0;
  t.onAuthError = () => { refusals++; };
  t.enterRoom('TNDM-AAAA', 'captain');     // socket 0 still connecting
  t.retryWithToken('fresh');               // drops it, dials socket 1
  await flush();
  runTimers();
  assert.equal(refusals, 0, 'the dropped socket is not a refusal');
  assert.equal(sockets.length, 2);
});

test('current socket replaced: one re-dial; replaced again soon after = seat taken, stop and say so', async () => {
  const t = transport();
  const lost = [];
  t.onDisconnected = (why) => lost.push(why);
  t.enterRoom('TNDM-AAAA', 'captain');
  sockets[0].open();
  t.connected = true;
  sockets[0].drop('replaced');
  assert.equal(timers.at(-1).ms, 3000, 'one re-dial, a moment later');
  runTimers();
  assert.equal(sockets.length, 2);
  sockets[1].open();
  sockets[1].drop('replaced');
  runTimers();
  assert.equal(sockets.length, 2, 'no second re-dial');
  assert.equal(t.connected, false);
  assert.equal(lost.length, 1);
  t._handleDisconnect();                   // e.g. the heartbeat timing out afterwards
  runTimers();
  assert.equal(sockets.length, 2, 'an evicted transport does not reconnect by itself');
  t.retryConnection();                     // the player's Try again
  runTimers();
  assert.equal(sockets.length, 3, 'Try again dials');
});

test('destroy() also stops a pending reconnect chain', () => {
  const t = transport();
  let reconnecting = 0;
  t.onReconnecting = () => { reconnecting++; };
  t.enterRoom('TNDM-AAAA', 'captain');
  sockets[0].open();
  t._handleDisconnect();                   // schedules _attemptReconnect
  const before = reconnecting;
  globalThis.document = { getElementById: () => null, removeEventListener() {} };
  try { t.destroy(); } finally { delete globalThis.document; }
  runTimers();
  runTimers();
  assert.equal(sockets.length, 1, 'no dial after destroy');
  assert.equal(reconnecting, before, 'no reconnecting callback after destroy');
});

test('an evicted transport is not re-dialled by a token retry, a pending refusal retry or a plain retry', async () => {
  const t = transport();
  t.onAuthError = () => t.retryWithToken('x');   // what the lobby's handler does
  t.enterRoom('TNDM-AAAA', 'captain');
  sockets[0].open(); t.connected = true;
  sockets[0].drop('replaced'); runTimers();      // the one re-dial
  sockets[1].drop();                              // refused before opening: a refusal retry is pending…
  t.enterRoom('TNDM-AAAA', 'captain');
  sockets[2].open(); sockets[2].drop('replaced'); // …then evicted
  const n = sockets.length;
  runTimers(); runTimers();
  t.retryWithToken('y');
  t._connectRelay();
  assert.equal(sockets.length, n, 'nothing dials while evicted');
});

test('two P2P upgrade attempts close together leave one Peer, not a leaked one', async () => {
  const t = transport();
  t.roomCode = 'TNDM-AAAA'; t.role = 'captain';
  delete t._attemptP2PUpgrade;                    // the real one this time
  const peers = [];
  globalThis.window = { Peer: class { constructor(id) { this.id = id; this.destroyed = false; peers.push(this); } on() {} destroy() { this.destroyed = true; } } };
  t._fetchIceServers = () => Promise.resolve([]);
  try {
    t._attemptP2PUpgrade();
    t._attemptP2PUpgrade();
    await flush();
  } finally { delete globalThis.window; }
  assert.equal(peers.length, 2);
  assert.equal(peers.filter((p) => !p.destroyed).length, 1, 'exactly one live Peer');
  assert.equal(t.peer, peers.find((p) => !p.destroyed));
});

test('a transport that gave up says so (_gaveUp) until Try again starts a fresh cycle', () => {
  const t = transport();
  const lost = [];
  t.onDisconnected = (why) => lost.push(why);
  t.enterRoom('TNDM-AAAA', 'captain');
  t._reconnectAttempts = t._maxReconnectAttempts;   // the last attempt failed
  t._handleDisconnect();
  assert.equal(t._gaveUp, true);
  assert.deepEqual(lost, ['Connection lost']);
  t.retryConnection();
  assert.equal(t._gaveUp, false);
  assert.equal(t._reconnectAttempts, 1, 'a fresh cycle started');
});

// #346 · a stale relay room: the relay's "waiting" (room open, partner not in it) reaches the
// lobby, so a rejoin into a room whose partner is gone offers "New Room" sooner.
test('the relay saying "waiting" marks the partner absent and tells onRoomWaiting; partner-ready clears it', () => {
  const t = transport();
  let waiting = 0;
  t.onRoomWaiting = () => { waiting++; };
  t.enterRoom('TNDM-AAAA', 'stoker');
  sockets[0].open();
  sockets[0].onmessage({ data: JSON.stringify({ type: 'waiting' }) });
  assert.equal(waiting, 1);
  assert.equal(t.partnerAbsent, true);
  sockets[0].onmessage({ data: JSON.stringify({ type: 'partner-ready', role: 'captain' }) });
  assert.equal(t.partnerAbsent, false);
  assert.equal(t.connected, true);
  t._stopHeartbeat();
});

// #694 · a relay from #694 on says what the room remembers on "waiting"; an older one doesn't.
test('"waiting" with the room record fills roomInfo; a bare "waiting" (old relay) leaves it null', () => {
  const t = transport();
  let got;
  t.onRoomWaiting = (info) => { got = info; };
  t._displayName = 'Pete';
  t.enterRoom('TNDM-AAAA', 'stoker');
  assert.match(sockets.at(-1).url, /[?&]name=Pete(&|$)/, 'the seat\'s name goes to the relay');
  sockets.at(-1).open();
  sockets.at(-1).onmessage({ data: JSON.stringify({ type: 'waiting', fresh: false, lastUsedAt: 1000, partnerSeenAt: 900, partnerName: 'Pat' }) });
  assert.deepEqual(got, { fresh: false, lastUsedAt: 1000, partnerSeenAt: 900, partnerName: 'Pat' });
  sockets.at(-1).onmessage({ data: JSON.stringify({ type: 'waiting' }) });
  assert.equal(got, null);
  assert.equal(t.roomInfo, null);
  t._stopHeartbeat();
});
