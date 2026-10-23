// A-4 · the co-op sync byte rides along with the state packet, and old-format
// packets must still decode (a stoker on an older build).
import test from 'node:test';
import assert from 'node:assert/strict';
import { BikeCodec } from '../../js/net/bike-codec.js';

const bike = {
  position: { x: 1, y: 2, z: 3 },
  heading: 0.5, lean: -0.2, leanVelocity: 0.1, speed: 7.5,
  crankAngle: Math.PI, distanceTraveled: 123.5, roadD: 99.25,
  fallen: false, _braking: false
};

test('state round-trips with a sync score', () => {
  const codec = new BikeCodec();
  const bytes = codec.encodeState(bike, 12.5, 0.82);
  const out = codec.decodeState(bytes.slice());
  assert.equal(out.speed, 7.5);
  assert.equal(out.timerRemaining, 12.5);
  assert.ok(Math.abs(out.syncScore - 0.82) < 0.01, `syncScore ${out.syncScore}`);
});

test('solo rides send no sync score', () => {
  const codec = new BikeCodec();
  const out = codec.decodeState(codec.encodeState(bike, 5, -1).slice());
  assert.equal(out.syncScore, undefined);
});

test('a legacy 46-byte packet still decodes', () => {
  const codec = new BikeCodec();
  const full = codec.encodeState(bike, 5, 1).slice();
  const legacy = full.slice(0, 46);
  const out = codec.decodeState(legacy);
  assert.equal(out.timerRemaining, 5);
  assert.equal(out.syncScore, undefined);
  assert.equal(out.distanceTraveled, 123.5);
});

test('a legacy 42-byte packet still decodes', () => {
  const codec = new BikeCodec();
  const out = codec.decodeState(codec.encodeState(bike, 5, 1).slice(0, 42));
  assert.equal(out.timerRemaining, undefined);
  assert.equal(out.roadD, 99.25);
});

test('the extremes of the sync range survive the byte', () => {
  const codec = new BikeCodec();
  assert.equal(codec.decodeState(codec.encodeState(bike, 1, 0).slice()).syncScore, 0);
  assert.equal(codec.decodeState(codec.encodeState(bike, 1, 1).slice()).syncScore, 1);
});

// #390 · the send time rides after the sync byte so the stoker can run a
// jitter buffer on the captain's clock and order packets off the unordered
// fast channel.
test('state carries the send time after the sync byte', () => {
  const codec = new BikeCodec();
  const bytes = codec.encodeState(bike, 12.5, 0.5);
  assert.equal(bytes.byteLength, 52);
  const out = codec.decodeState(bytes.slice());
  const now = Math.floor(performance.now());
  assert.ok(Math.abs(out.sendTime - now) < 1000, `sendTime ${out.sendTime} vs ${now}`);
  assert.ok(Math.abs(out.syncScore - 0.5) < 0.01);
});

test('a legacy 48-byte packet decodes its sync but has no send time', () => {
  const codec = new BikeCodec();
  const out = codec.decodeState(codec.encodeState(bike, 5, 0.25).slice(0, 48));
  assert.ok(Math.abs(out.syncScore - 0.25) < 0.01);
  assert.equal(out.sendTime, undefined);
});

test('lean carries a send time; a legacy 5-byte lean has none', () => {
  const codec = new BikeCodec();
  const bytes = codec.encodeLean(0.3).slice();
  assert.equal(bytes.byteLength, 9);
  assert.ok(Math.abs(codec.decodeLean(bytes) - 0.3) < 1e-6);
  assert.equal(typeof codec.decodeLeanTime(bytes), 'number');
  assert.equal(codec.decodeLeanTime(bytes.slice(0, 5)), undefined);
  let got = null;
  assert.equal(codec.dispatch(bytes.slice(0, 5), { onLean: (v, t) => { got = [v, t]; } }), true);
  assert.ok(Math.abs(got[0] - 0.3) < 1e-6);
  assert.equal(got[1], undefined);
});
