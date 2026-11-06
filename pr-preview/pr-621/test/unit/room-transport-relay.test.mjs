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
  close() { this.closed = true; this.readyState = 3; }
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

test('a socket the relay replaced does not re-dial', () => {
  const t = transport();
  t.enterRoom('TNDM-AAAA', 'captain');
  sockets[0].open();
  sockets[0].drop('replaced');
  runTimers();
  assert.equal(sockets.length, 1, 'no reconnect after "replaced"');
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
