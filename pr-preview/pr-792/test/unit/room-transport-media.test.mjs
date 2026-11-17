// #400 D7 — room camera/mic behind a flag. With media off the transport must
// never place a media call, never touch getUserMedia, and must close (not
// answer) an incoming call. Data connections are not part of this gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomTransport } from '../../js/net/room-transport.js';

function fakeCall() {
  const c = { closed: false, answered: false, handlers: {} };
  c.close = () => { c.closed = true; };
  c.answer = () => { c.answered = true; };
  c.on = (ev, fn) => { c.handlers[ev] = fn; };
  return c;
}

test('media is off by default (no ?media=1 in node)', () => {
  assert.equal(new RoomTransport().mediaEnabled, false);
});

test('media off: incoming call is closed, never answered', () => {
  const t = new RoomTransport();
  const call = fakeCall();
  t._handleIncomingCall(call);
  assert.equal(call.closed, true);
  assert.equal(call.answered, false);
  assert.equal(t._mediaCall, null);
});

test('media off: initiateCall never calls peer.call', () => {
  const t = new RoomTransport();
  let calls = 0;
  t.peer = { call: () => { calls++; return fakeCall(); } };
  t.conn = { peer: 'remote-id' };
  t.initiateCall();
  assert.equal(calls, 0);
  assert.equal(t._mediaCall, null);
});

test('media off: acquireLocalMedia never asks for a stream', async () => {
  const t = new RoomTransport();
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let gum = 0;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { mediaDevices: { getUserMedia: async () => { gum++; return {}; } } },
  });
  try {
    await t.acquireLocalMedia(true, true);
  } finally {
    if (saved) Object.defineProperty(globalThis, 'navigator', saved);
    else delete globalThis.navigator;
  }
  assert.equal(gum, 0);
  assert.equal(t._localMediaStream, null);
});

test('media on: incoming call is answered as before', () => {
  const t = new RoomTransport();
  t.mediaEnabled = true;
  const call = fakeCall();
  t._handleIncomingCall(call);
  assert.equal(call.answered, true);
  assert.equal(call.closed, false);
  assert.equal(t._mediaCall, call);
});

test('media on: initiateCall places a call to the data-connection peer', () => {
  const t = new RoomTransport();
  t.mediaEnabled = true;
  const placed = [];
  t.peer = { call: (id) => { placed.push(id); return fakeCall(); } };
  t.conn = { peer: 'remote-id' };
  const savedMS = globalThis.MediaStream;
  globalThis.MediaStream = class {};
  try { t.initiateCall(); } finally { globalThis.MediaStream = savedMS; }
  assert.deepEqual(placed, ['remote-id']);
});
