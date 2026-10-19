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

// ── Phase 2: menu pad, modes, drop / return, pause ──
import { mergeRemoteNavPad } from '../../js/input-manager.js';
import { PhonePadHost } from '../../js/remote/phone-pad-host.js';

test('the phone menu pad is a standard gamepad: d-pad, A/B (with the swap), Start', () => {
  const pad = mergeRemoteNavPad(null, NAV.up | NAV.ok | NAV.pause, false);
  assert.equal(pad.buttons.length, 17);
  assert.equal(pad.buttons[12].pressed, true);
  assert.equal(pad.buttons[0].pressed, true, 'OK = A');
  assert.equal(pad.buttons[9].pressed, true, 'Pause = Start');
  assert.equal(pad.buttons[1].pressed, false);
  assert.deepEqual(pad.axes, [0, 0, 0, 0], 'stick centred: no gamepad lean');
  assert.equal(pad.buttons[4].pressed || pad.buttons[6].pressed, false, 'no pedal buttons');
  const swapped = mergeRemoteNavPad(null, NAV.back, true);
  assert.equal(swapped.buttons[0].pressed, true, 'Back = B, which is button 0 on a swapped pad');
});

test('a real pad keeps its buttons and stick; the phone only adds presses', () => {
  const real = { id: 'X', index: 0, axes: [0.7, 0, 0, 0], buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: i === 5, touched: i === 5, value: i === 5 ? 1 : 0 })) };
  const pad = mergeRemoteNavPad(real, NAV.down, false);
  assert.equal(pad.buttons[5].pressed, true);
  assert.equal(pad.buttons[13].pressed, true);
  assert.equal(pad.axes[0], 0.7);
});

test('setRemoteNav makes the seat look like a gamepad only while the phone shows its menu', () => {
  const im = bare();
  assert.equal(im.gamepadConnected, false);
  im.setRemoteNav(true, NAV.left);
  assert.equal(im.gamepadConnected, true);
  assert.equal(im.getGamepadState().buttons[14].pressed, true);
  im.setRemoteNav(false);
  assert.equal(im.gamepadConnected, false, 'riding: ride-time pad checks are unchanged');
  assert.equal(im.getGamepadState(), null);
  im.setRemoteNav(true, 0);
  im.detachRemote();
  assert.equal(im.gamepadConnected, false);
});

/** A PhonePadHost wired to a fake input + socket (no network). */
function hostWithFakes(hooks = {}) {
  const calls = [];
  const input = {
    feedRemoteTilt: (t) => calls.push(['tilt', t]),
    setRemotePedals: (...a) => calls.push(['pedals', ...a]),
    setRemoteNav: (on, nav) => calls.push(['nav', on, nav]),
    startTiltCalibration: () => calls.push(['recenter']),
    detachRemote: () => calls.push(['detach']),
  };
  const host = new PhonePadHost({ input, relay: 'ws://127.0.0.1:1', siteBase: 'http://127.0.0.1/', ...hooks });
  const sent = [];
  host._ws = { readyState: 1, send: (d) => sent.push(JSON.parse(d)) };
  host.redials = 0;
  host._redial = () => { host.redials++; };   // no real sockets in unit tests
  const frame = (f) => { const b = encodeFrame({ seq: 1, tilt: 0, left: false, right: false, tapsL: 0, tapsR: 0, nav: 0, ...f }); const w = new Uint8Array(9); w[0] = 1; w.set(b, 1); host._onMessage(w.buffer); };
  return { host, input, calls, sent, frame };
}

test('host: a joining phone is told its seat; mode changes send nothing (the phone layout is fixed)', () => {
  const { host, sent } = hostWithFakes();
  host._onMessage(JSON.stringify({ type: 'pad-joined', seat: 1 }));
  assert.equal(host.status, 'connected');
  assert.deepEqual(sent.map((m) => m.msg.type), ['seat']);
  const n = sent.length;
  host.setMode('ride');
  host.setMode('menu');
  assert.equal(sent.length, n, 'nothing to send: the game reads presses by its own mode');
  assert.equal(host.mode, 'menu');
});

test('host: menu buttons pass through only in menu mode; Pause fires only while riding', () => {
  let paused = 0;
  const { host, calls, frame } = hostWithFakes({ onPause: () => paused++ });
  host._onMessage(JSON.stringify({ type: 'pad-joined', seat: 1 }));
  frame({ seq: 2, nav: NAV.ok });
  assert.deepEqual(calls.filter((c) => c[0] === 'nav').at(-1), ['nav', true, NAV.ok]);
  frame({ seq: 3, nav: NAV.pause });
  assert.equal(paused, 0, 'Pause in menu mode is the Start button, not a second pause');
  host.setMode('ride');
  frame({ seq: 4, nav: 0 });
  assert.deepEqual(calls.filter((c) => c[0] === 'nav').at(-1), ['nav', false, 0]);
  frame({ seq: 5, nav: NAV.pause });
  assert.equal(paused, 1);
  frame({ seq: 6, nav: NAV.pause });
  assert.equal(paused, 1, 'held Pause fires once');
});

test('host: a phone that drops calls onDrop once; coming back calls onReturn', () => {
  let drops = 0, returns = 0;
  const { host, calls, frame } = hostWithFakes({ onDrop: () => drops++, onReturn: () => returns++ });
  host._onMessage(JSON.stringify({ type: 'pad-joined', seat: 1 }));
  frame({ seq: 2 });
  host._lastAt -= 5000;          // silent for 5 s (asleep)
  host._lastCheckAt = performance.now();
  host._checkStale();
  assert.equal(drops, 1);
  assert.equal(host.drops.at(-1).reason, 'silent');
  assert.equal(host.status, 'waiting');
  assert.ok(calls.some((c) => c[0] === 'detach'));
  host._onMessage(JSON.stringify({ type: 'pad-left', seat: 1 }));
  assert.equal(drops, 1, 'pad-left after going silent is not a second drop');
  frame({ seq: 3 });
  assert.equal(returns, 1);
  assert.equal(host.status, 'connected');
});

test('host: a game freeze or a relay blip is not the phone dropping', () => {
  let drops = 0;
  const { host, frame } = hostWithFakes({ onDrop: () => drops++ });
  host._onMessage(JSON.stringify({ type: 'pad-joined', seat: 1 }));
  frame({ seq: 2 });
  // The game froze for 3 s (watchdog ran late): frames were queued, not missing.
  host._lastAt -= 3000;
  host._lastCheckAt = performance.now() - 3000;
  host._checkStale();
  assert.equal(drops, 0, 'a freeze is not a drop');
  // Our relay socket blipped for 3 s: still not the phone's fault.
  host._lastCheckAt = performance.now();
  host._ws = null;
  host._wsDownAt = performance.now() - 3000;
  host._lastAt -= 3000;
  host._checkStale();
  assert.equal(drops, 0, 'a short relay blip is not a drop');
  // ...but down for good: give up on the phone.
  host._wsDownAt = performance.now() - 6000;
  host._lastCheckAt = performance.now();
  host._checkStale();
  assert.equal(drops, 1);
  assert.equal(host.drops.at(-1).reason, 'relay');
});

test('host: cues are sent only to a connected phone, and only known ones', () => {
  const { host, sent } = hostWithFakes();
  host.cue('crash');
  assert.equal(sent.length, 0);
  host._onMessage(JSON.stringify({ type: 'pad-joined', seat: 1 }));
  host.cue('crash');
  host.cue('confetti');
  assert.deepEqual(sent.filter((m) => m.msg.type === 'cue').map((m) => m.msg.cue), ['crash']);
});

test('host: the Pause press that switched to the menu does not also press Start', () => {
  let paused = 0;
  const { host, calls, frame } = hostWithFakes({ onPause: () => paused++ });
  host._onMessage(JSON.stringify({ type: 'pad-joined', seat: 1 }));
  host.setMode('ride');
  frame({ seq: 2, nav: 0 });
  frame({ seq: 3, nav: NAV.pause });
  assert.equal(paused, 1);
  host.setMode('menu');                      // the game paused
  frame({ seq: 4, nav: NAV.pause });         // still held
  assert.deepEqual(calls.filter((c) => c[0] === 'nav').at(-1), ['nav', true, 0], 'held Pause is not Start');
  frame({ seq: 5, nav: 0 });                 // released
  frame({ seq: 6, nav: NAV.pause });         // a fresh press in the menu = Start
  assert.deepEqual(calls.filter((c) => c[0] === 'nav').at(-1), ['nav', true, NAV.pause]);
});

test('host: a short silence lets go of held pedals and buttons; a button still held after it is not a new press', () => {
  const { host, calls, frame } = hostWithFakes();
  host._onMessage(JSON.stringify({ type: 'pad-joined', seat: 1 }));
  frame({ seq: 2, left: true, nav: NAV.ok });
  calls.length = 0;
  host._lastAt -= 500;                     // 0.5 s: past the release, short of a drop
  host._lastCheckAt = performance.now();
  host._checkStale();
  assert.deepEqual(calls.filter((c) => c[0] === 'pedals').at(-1), ['pedals', false, false]);
  assert.deepEqual(calls.filter((c) => c[0] === 'nav').at(-1), ['nav', true, 0]);
  frame({ seq: 3, left: true, nav: NAV.ok }); // frames resume, OK still held
  assert.equal(calls.filter((c) => c[0] === 'nav').at(-1)[2] & NAV.ok, 0, 'held OK is latched');
});

test('host: opening twice makes one room; Stop says goodbye to the phone', async () => {
  const { host, sent } = hostWithFakes();
  const OrigWS = globalThis.WebSocket;
  let sockets = 0;
  globalThis.WebSocket = class { constructor() { sockets++; this.readyState = 0; } send() {} close() {} };
  try {
    const [a, b] = await Promise.all([host.open(), host.open()]);
    assert.equal(a, b);
    assert.equal(sockets, 1);
    host._ws = { readyState: 1, send: (d) => sent.push(JSON.parse(d)), close() {} };
    host.close();
    assert.equal(sent.at(-1).msg.type, 'bye');
  } finally { globalThis.WebSocket = OrigWS; host.close(); }
});

test('detach puts a gyro pad\'s motion back as it was', () => {
  const im = bare();
  im.motionEnabled = false;                // the player had pad motion off
  feed(im, 0, 10);
  assert.equal(im.motionEnabled, true);
  im.detachRemote();
  assert.equal(im.motionEnabled, false);
});

test('host: a silent phone also makes the game redial (its own socket may be the dead one)', () => {
  let drops = 0;
  const { host } = hostWithFakes({ onDrop: () => drops++ });
  host._onMessage(JSON.stringify({ type: 'pad-joined', seat: 1 }));
  host._lastAt -= 2500;                    // joined, then never a frame
  host._lastCheckAt = performance.now();
  host._checkStale();
  assert.equal(drops, 1, 'a phone that joins but never sends is not connected forever');
  assert.equal(host.redials, 1);
});

test('host: held input is released even while our own relay socket is down', () => {
  const { host, calls, frame } = hostWithFakes();
  host._onMessage(JSON.stringify({ type: 'pad-joined', seat: 1 }));
  frame({ seq: 2, left: true });
  host._ws = null;
  host._wsDownAt = performance.now();
  host._lastAt -= 500;
  host._lastCheckAt = performance.now();
  calls.length = 0;
  host._checkStale();
  assert.deepEqual(calls.filter((c) => c[0] === 'pedals').at(-1), ['pedals', false, false]);
});

test('host: after a drop, a leftover relay socket joining is not the phone coming back', () => {
  let drops = 0, returns = 0;
  const { host, frame } = hostWithFakes({ onDrop: () => drops++, onReturn: () => returns++ });
  host._onMessage(JSON.stringify({ type: 'pad-joined', seat: 1 }));
  frame({ seq: 2 });
  host._lastAt -= 2500;
  host._lastCheckAt = performance.now();
  host._checkStale();
  assert.equal(drops, 1);
  host._onMessage(JSON.stringify({ type: 'pad-joined', seat: 1 }));   // after our redial
  assert.equal(returns, 0, 'no frame yet: still disconnected');
  assert.equal(host.status, 'waiting');
  frame({ seq: 3 });
  assert.equal(returns, 1);
});
