// Phone remote (#421): wire format, pairing link, relay routing, and the
// InputManager hooks a remote phone drives.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeFrame, decodeFrame, counterDelta, isNewerSeq, NAV, FRAME_BYTES,
  makePadCode, makePadSecret, isValidPadCode, parsePadRole, seatOfRole,
  buildPadLink, parsePadLink, padSocketUrl, sha256hex, relayOverrideAllowed,
} from '../../js/remote/pad-protocol.js';
import { orientationToRawTilt, gravityToRawTilt } from '../../js/tilt-math.js';
import { routeMessage, secretMatches } from '../../worker/pad-relay.js';
import { InputManager } from '../../js/input-manager.js';

test('an input frame round-trips in 8 bytes', () => {
  const f = { seq: 255, tilt: -37.25, left: true, right: false, tapsL: 3, tapsR: 200, nav: NAV.ok | NAV.recenter };
  const buf = encodeFrame(f);
  assert.equal(buf.length, FRAME_BYTES);
  assert.deepEqual(decodeFrame(buf), f);
});

test('a frame without tilt says so, and tilt is clamped to i16', () => {
  const none = decodeFrame(encodeFrame({ seq: 1, tilt: null, left: false, right: true, tapsL: 0, tapsR: 0, nav: 0 }));
  assert.equal(none.tilt, null);
  assert.equal(none.right, true);
  const big = decodeFrame(encodeFrame({ seq: 1, tilt: 9999, left: false, right: false, tapsL: 0, tapsR: 0, nav: 0 }));
  assert.equal(big.tilt, 327.67);
});

test('decodeFrame reads a seat-prefixed frame and rejects junk', () => {
  const buf = encodeFrame({ seq: 7, tilt: 12, left: false, right: false, tapsL: 1, tapsR: 1, nav: 0 });
  const withSeat = new Uint8Array(9); withSeat[0] = 2; withSeat.set(buf, 1);
  assert.equal(decodeFrame(withSeat, 1).seq, 7);
  assert.equal(decodeFrame(new Uint8Array(8)), null);
  assert.equal(decodeFrame(new Uint8Array(3)), null);
});

test('tap counters and sequence numbers wrap at 256', () => {
  assert.equal(counterDelta(254, 1), 3);
  assert.equal(counterDelta(5, 5), 0);
  assert.equal(isNewerSeq(250, 3), true);
  assert.equal(isNewerSeq(3, 250), false);
  assert.equal(isNewerSeq(9, 9), false);
});

test('pad codes and secrets have the right shape', () => {
  for (let i = 0; i < 50; i++) {
    const c = makePadCode();
    assert.ok(isValidPadCode(c), c);
    assert.ok(!/[01OIL]/.test(c), c);
  }
  assert.match(makePadSecret(), /^[0-9a-f]{32}$/);
  assert.equal(isValidPadCode('abc'), false);
});

test('roles: host and pad-1..pad-4 only', () => {
  assert.equal(parsePadRole('host'), 'host');
  assert.equal(parsePadRole('pad-4'), 'pad-4');
  assert.equal(parsePadRole('pad-5'), null);
  assert.equal(parsePadRole('captain'), null);
  assert.equal(seatOfRole('pad-3'), 3);
  assert.equal(seatOfRole('host'), 0);
});

test('the phone link keeps the secret in the #fragment and parses back', () => {
  const link = buildPadLink('https://tandemonium.jimandi.love/pr-preview/pr-422/', 'ABCDEF', 1, 'a'.repeat(32));
  assert.equal(link, 'https://tandemonium.jimandi.love/pr-preview/pr-422/remote/?pad=ABCDEF&seat=1#k=' + 'a'.repeat(32));
  assert.deepEqual(parsePadLink(link), { code: 'ABCDEF', seat: 1, secret: 'a'.repeat(32), relay: null });
  assert.equal(parsePadLink('https://x/remote/?pad=AB&seat=1'), null);
  assert.equal(parsePadLink('https://x/remote/?pad=ABCDEF&seat=9#k=' + 'a'.repeat(32)), null);
  assert.equal(parsePadLink('https://x/remote/?pad=ABCDEF&seat=2').secret, null);
});

test('a relay override is only honoured on localhost', () => {
  assert.equal(relayOverrideAllowed('127.0.0.1'), true);
  assert.equal(relayOverrideAllowed('tandemonium.jimandi.love'), false);
  assert.equal(padSocketUrl('ws://127.0.0.1:8787', 'ABCDEF', 'pad-1', 'ff'), 'ws://127.0.0.1:8787/pad?code=ABCDEF&role=pad-1&k=ff');
});

test('relay: pad frames go to the host with a seat prefix; JSON is wrapped', () => {
  const frame = encodeFrame({ seq: 1, tilt: 5, left: true, right: false, tapsL: 1, tapsR: 0, nav: 0 });
  const r = routeMessage('pad-2', frame);
  assert.deepEqual(r.to, ['host']);
  assert.equal(r.data[0], 2);
  assert.equal(decodeFrame(r.data, 1).left, true);
  const j = routeMessage('pad-1', JSON.stringify({ hi: 1 }));
  assert.deepEqual(JSON.parse(j.data), { type: 'from-pad', seat: 1, msg: { hi: 1 } });
  assert.equal(routeMessage('pad-1', new Uint8Array(100)), null, 'oversized frame dropped');
});

test('relay: host messages go to one pad or all; allow registers a hash', () => {
  const one = routeMessage('host', JSON.stringify({ type: 'to-pad', seat: 3, msg: { type: 'seat' } }));
  assert.deepEqual(one.to, ['pad-3']);
  assert.deepEqual(JSON.parse(one.data), { type: 'seat' });
  assert.deepEqual(routeMessage('host', JSON.stringify({ type: 'to-pad', msg: {} })).to, ['pad-1', 'pad-2', 'pad-3', 'pad-4']);
  const hash = 'b'.repeat(64);
  assert.deepEqual(routeMessage('host', JSON.stringify({ type: 'allow', seat: 1, hash })), { allow: { seat: 1, hash } });
  assert.equal(routeMessage('host', JSON.stringify({ type: 'allow', seat: 9, hash })), null);
  assert.equal(routeMessage('host', new Uint8Array(8)), null, 'host never sends binary');
});

test('relay: only the matching secret pairs', async () => {
  const secret = makePadSecret();
  const hash = await sha256hex(secret);
  assert.equal(await secretMatches(secret, hash), true);
  assert.equal(await secretMatches(makePadSecret(), hash), false);
  assert.equal(await secretMatches(secret, undefined), false);
  assert.equal(await secretMatches('../../etc', hash), false);
});

test('tilt-math matches the old inline InputManager mapping', () => {
  assert.equal(orientationToRawTilt(20, 5, 90), 20);
  assert.equal(orientationToRawTilt(20, 5, 270), -20);
  assert.equal(orientationToRawTilt(20, 5, -90), -20);
  assert.equal(orientationToRawTilt(10, 15, 0), 15);
  assert.equal(orientationToRawTilt(120, 15, 0), -15);
  assert.equal(orientationToRawTilt(90, 10, 0), 0);       // mid-blend
  assert.equal(orientationToRawTilt(10, null, 0), null);
  assert.ok(Math.abs(gravityToRawTilt(0, 9.8, 0)) < 1e-9);
  assert.ok(gravityToRawTilt(-4, 9, 0) > 0);
});

/** A bare InputManager with only the tilt + pedal state (as in tilt-calibration.test). */
function bare() {
  const im = Object.create(InputManager.prototype);
  Object.assign(im, {
    keys: {}, keyboardActive: true, touchLeft: false, touchRight: false, _leftTapped: false, _rightTapped: false,
    motionEnabled: false, motionReady: false, onMotionEnabled: null, rawGamma: 0, motionOffset: 0,
    _calibrating: false, _warmupCount: 5, _driftEma: null, _driftRate: 0.015, _driftWindowK: 0.005,
    _smoothedLean: 0, _prevLeanRaw: 0, motionLean: 0, motionLeanVisual: 0, _filteredRawTilt: null,
    _lastOrientTime: 0, bikeSpeed: 0, bikeMaxSpeed: 12, _lastApplyTiltTime: 0, _lastActivityMs: 0,
    _gpTriggerLeftPressed: false, _gpTriggerRightPressed: false,
  });
  return im;
}

function feed(im, deg, n) {
  const realNow = performance.now;
  let t = im.__t || 1000;
  performance.now = () => t;
  try { for (let i = 0; i < n; i++) { t += 1000 / 30; im.feedRemoteTilt(deg); } }
  finally { performance.now = realNow; im.__t = t; }
}

test('a remote phone tilt turns motion on and steers through the normal pipeline', () => {
  const im = bare();
  let fired = 0;
  im.onMotionEnabled = () => fired++;
  feed(im, 0, 10);
  assert.equal(im.motionEnabled, true);
  assert.equal(fired, 1);
  feed(im, 30, 60);
  assert.ok(im.getMotionLeanVisual() > 0.5, `visual ${im.getMotionLeanVisual()}`);
  assert.ok(im.getMotionLean() > 0, 'physics lean follows');
});

test('remote pedals press, taps survive a short press, detach releases everything', () => {
  const im = bare();
  im.setRemotePedals(true, false);
  assert.equal(im.isPressed('ArrowLeft'), true);
  assert.equal(im.isPressed('ArrowRight'), false);
  im.setRemotePedals(false, false, 0, 1);    // a right tap that came and went between frames
  assert.equal(im.isPressed('ArrowRight'), true, 'buffered tap');
  im.consumeTaps();
  assert.equal(im.isPressed('ArrowRight'), false);

  feed(im, 0, 10); feed(im, 30, 60);
  im.setRemotePedals(true, true);
  im.detachRemote();
  assert.equal(im.isPressed('ArrowLeft'), false);
  assert.equal(im.getMotionLean(), 0);
  assert.equal(im.motionEnabled, false, 'a desktop host falls back to keyboard steering');
});

test('detach keeps motion on when the host device tilts by itself', () => {
  const im = bare();
  im.motionReady = true;           // this device has its own motion listeners
  feed(im, 0, 10);
  im.detachRemote();
  assert.equal(im.motionEnabled, true);
});
