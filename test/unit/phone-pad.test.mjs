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
import { InputManager, REMOTE_LEAN_EASE_MS } from '../../js/input-manager.js';

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
  const link = buildPadLink('https://tandemonium.housetandem.com/pr-preview/pr-422/', 'ABCDEF', 1, 'a'.repeat(32));
  assert.equal(link, 'https://tandemonium.housetandem.com/pr-preview/pr-422/remote/?pad=ABCDEF&seat=1#k=' + 'a'.repeat(32));
  assert.deepEqual(parsePadLink(link), { code: 'ABCDEF', seat: 1, secret: 'a'.repeat(32), relay: null, seats: [1], play: false });
  assert.equal(parsePadLink('https://x/remote/?pad=AB&seat=1'), null);
  assert.equal(parsePadLink('https://x/remote/?pad=ABCDEF&seat=9#k=' + 'a'.repeat(32)), null);
  assert.equal(parsePadLink('https://x/remote/?pad=ABCDEF&seat=2').secret, null);
});

test('a relay override is only honoured on localhost', () => {
  assert.equal(relayOverrideAllowed('127.0.0.1'), true);
  assert.equal(relayOverrideAllowed('tandemonium.housetandem.com'), false);
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

/** Run fn with performance.now() pinned to t. */
function atTime(t, fn) {
  const realNow = performance.now;
  performance.now = () => t;
  try { return fn(); } finally { performance.now = realNow; }
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
  atTime(im.__t, () => im.detachRemote());
  assert.equal(im.isPressed('ArrowLeft'), false);
  atTime(im.__t + REMOTE_LEAN_EASE_MS + 1, () => assert.equal(im.getMotionLean(), 0, 'lean has eased out'));
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

test('host: a game stall past the release window does not let go of a held button', () => {
  const { host, calls, frame } = hostWithFakes();
  host._onMessage(JSON.stringify({ type: 'pad-joined', seat: 1 }));
  frame({ seq: 2, left: true, nav: NAV.down });
  calls.length = 0;
  // One 600 ms game frame: the watchdog ran late, the phone's frames are queued.
  host._lastAt -= 600;
  host._lastCheckAt = performance.now() - 600;
  host._checkStale();
  assert.equal(calls.filter((c) => c[0] === 'pedals' || c[0] === 'nav').length, 0, 'nothing released');
  frame({ seq: 3, left: true, nav: NAV.down });
  assert.equal(calls.filter((c) => c[0] === 'nav').at(-1)[2] & NAV.down, NAV.down, 'DOWN still held');
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

// ── #424 follow-ups: lean eases out on a drop; a refused room gets a new code ──

test("a dropped phone's lean eases to 0 instead of snapping", () => {
  const im = bare();
  feed(im, 0, 10); feed(im, 30, 60);
  const lean = im.getMotionLean(), visual = im.getMotionLeanVisual();
  assert.ok(lean > 0 && visual > 0);
  const t = im.__t;
  atTime(t, () => im.detachRemote());
  atTime(t, () => assert.ok(Math.abs(im.getMotionLean() - lean) < 1e-9, 'no snap at the drop'));
  atTime(t + REMOTE_LEAN_EASE_MS / 2, () => {
    assert.ok(Math.abs(im.getMotionLean() - lean / 2) < 1e-6, 'halfway');
    assert.ok(Math.abs(im.getMotionLeanVisual() - visual / 2) < 1e-6, 'visual too');
  });
  atTime(t + REMOTE_LEAN_EASE_MS, () => assert.equal(im.getMotionLean(), 0));
  atTime(t + REMOTE_LEAN_EASE_MS, () => assert.equal(im.getMotionLeanVisual(), 0));
});

test('the phone coming back, or a lean reset, cancels the ease', () => {
  const im = bare();
  feed(im, 0, 10); feed(im, 30, 60);
  atTime(im.__t, () => im.detachRemote());
  im.resetLeanState();
  atTime(im.__t + 10, () => assert.equal(im.getMotionLean(), 0, 'reset'));
  feed(im, 30, 60);
  atTime(im.__t, () => im.detachRemote());
  feed(im, 0, 1);   // the phone is back
  assert.equal(im._leanEase, null);
});

/** Open a host whose relay sockets never open (each close is a refusal or a dead network). */
async function refusedHost({ reachable }) {
  const links = [];
  const { host } = hostWithFakes({ onLink: (l) => links.push(l) });
  const OrigWS = globalThis.WebSocket, origFetch = globalThis.fetch;
  const sockets = [];
  globalThis.WebSocket = class { constructor(url) { this.url = url; this.readyState = 0; sockets.push(this); } send() {} close() {} };
  globalThis.fetch = async () => { if (!reachable) throw new TypeError('offline'); return {}; };
  host._scheduleRetry = () => {};   // the test dials by hand
  // Await the refusal check itself (#493): it runs async work (the reachability
  // fetch, fresh secrets via crypto) that a fixed number of ticks can't cover.
  const checks = [];
  const check = host._checkRefused.bind(host);
  host._checkRefused = () => { const p = check(); checks.push(p); return p; };
  const restore = () => { globalThis.WebSocket = OrigWS; globalThis.fetch = origFetch; host.close(); };
  try {
    await host.open();
    const firstCode = host.code, firstLink = host.link;
    for (let i = 0; i < 4; i++) {
      const ws = sockets.at(-1);
      ws.readyState = 3;
      ws.onclose();
      if (i < 3) host._connect();
    }
    assert.ok(checks.length >= 1, 'the failed connects ask whether the relay is reachable');
    await Promise.all(checks);
    return { host, links, sockets, firstCode, firstLink, restore };
  } catch (e) { restore(); throw e; }
}

test('host: repeated refusals with the relay reachable move the room to a new code', async () => {
  const r = await refusedHost({ reachable: true });
  try {
    assert.notEqual(r.host.code, r.firstCode);
    assert.notEqual(r.host.link, r.firstLink);
    assert.deepEqual(r.links, [r.host.link], 'the UI is told to redraw the QR');
    assert.equal(r.host.rekeys, 1);
    assert.ok(r.sockets.at(-1).url.includes('code=' + r.host.code), 'dials the new room');
  } finally { r.restore(); }
});

test('host: failures while the relay is unreachable keep the code (a paired phone can come back)', async () => {
  const r = await refusedHost({ reachable: false });
  try {
    assert.equal(r.host.code, r.firstCode);
    assert.deepEqual(r.links, []);
  } finally { r.restore(); }
});

// ── #454: versions, single-use QR, menu traffic, rate limit ──
import {
  PAD_INPUT, PAD_PROTOCOL, peerVersion, shouldSendFrame, MENU_HEARTBEAT_MS, MENU_ACTIVE_TAIL_MS,
  padKeysOnBoot, padKeysAfterRekey,
} from '../../js/remote/pad-protocol.js';
import { padCredential, padRateOk } from '../../worker/pad-relay.js';

test('byte 0 is type + layout: layout 0 (what every phone sends) decodes, a newer layout is skipped', () => {
  const buf = encodeFrame({ seq: 3, tilt: 1, left: false, right: false, tapsL: 0, tapsR: 0, nav: 0 });
  assert.equal(buf[0], PAD_INPUT, 'phones still send 0x50, so old games read them');
  const newer = buf.slice(); newer[0] = PAD_INPUT | 1;
  assert.equal(decodeFrame(newer), null);
  const other = buf.slice(); other[0] = 0x60;
  assert.equal(decodeFrame(other), null);
});

test('a side that never says hello is version 1', () => {
  assert.equal(peerVersion(null), 1);
  assert.equal(peerVersion({ type: 'hello' }), 1);
  assert.equal(peerVersion({ type: 'hello', v: 'x' }), 1);
  assert.equal(peerVersion({ type: 'hello', v: 2 }), 2);
  assert.equal(peerVersion({ type: 'relay', v: 7 }), 7);
  assert.ok(PAD_PROTOCOL >= 2);
});

test('menu traffic: idle sends only the heartbeat; changes, held buttons and riding stream', () => {
  const base = { dirty: false, held: false, lastSend: 1000, lastChange: 0, sendMs: 33 };
  // Riding, or a game that never said hello: 30 Hz as before.
  assert.equal(shouldSendFrame({ ...base, light: false, now: 1040 }), true);
  assert.equal(shouldSendFrame({ ...base, light: false, now: 1020 }), false);
  // Menus, idle: nothing until the heartbeat.
  assert.equal(shouldSendFrame({ ...base, light: true, now: 1040 }), false);
  assert.equal(shouldSendFrame({ ...base, light: true, now: 1000 + MENU_HEARTBEAT_MS - 1 }), false);
  assert.equal(shouldSendFrame({ ...base, light: true, now: 1000 + MENU_HEARTBEAT_MS }), true);
  // A change goes at once, and the full rate carries on a moment after it.
  assert.equal(shouldSendFrame({ ...base, light: true, dirty: true, now: 1001 }), true);
  assert.equal(shouldSendFrame({ ...base, light: true, lastChange: 1030, now: 1040 }), true);
  assert.equal(shouldSendFrame({ ...base, light: true, lastChange: 1040 - MENU_ACTIVE_TAIL_MS, now: 1040 }), false);
  // A held button keeps streaming, so the game's 400 ms release never cuts it.
  assert.equal(shouldSendFrame({ ...base, light: true, held: true, now: 1040 }), true);
});

test("the heartbeat is well inside the game's stale rule (2 s)", () => {
  assert.ok(MENU_HEARTBEAT_MS * 3 < 2000);
});

test('phone keys: own key first, the QR as fallback; a rekey keeps the joining key as fallback', () => {
  const q = 'a'.repeat(32), p = 'b'.repeat(32), old = 'c'.repeat(32);
  assert.deepEqual(padKeysOnBoot(q, null, null), [q], 'first scan');
  assert.deepEqual(padKeysOnBoot(q, p, null), [p, q], 'a re-scan in the same tab tries its own key first');
  assert.deepEqual(padKeysOnBoot(q, q, null), [q]);
  assert.deepEqual(padKeysOnBoot(null, p, q), [p, q], 'a reload keeps both');
  assert.deepEqual(padKeysOnBoot(null, 'junk', null), []);
  assert.deepEqual(padKeysAfterRekey(q, p), [p, q]);
  assert.deepEqual(padKeysAfterRekey(p, p), [p]);
  assert.equal(padKeysAfterRekey(old, 'nope'), null);
});

test('relay: pair sets the QR and phone key; malformed pairs are dropped', () => {
  const qr = 'd'.repeat(64), phone = 'e'.repeat(64);
  assert.deepEqual(routeMessage('host', JSON.stringify({ type: 'pair', seat: 1, qr, phone })), { pair: { seat: 1, qr, phone } });
  assert.deepEqual(routeMessage('host', JSON.stringify({ type: 'pair', seat: 2, qr, phone: null })), { pair: { seat: 2, qr, phone: null } });
  assert.equal(routeMessage('host', JSON.stringify({ type: 'pair', seat: 1, qr: 'x', phone })), null);
  assert.equal(routeMessage('host', JSON.stringify({ type: 'pair', seat: 1, qr, phone: 'x' })), null);
  assert.equal(routeMessage('host', JSON.stringify({ type: 'pair', seat: 5, qr })), null);
  assert.deepEqual(routeMessage('pad-1', JSON.stringify({ type: 'pair', seat: 1, qr })).to, ['host'], 'a pad cannot pair: it is only relayed as from-pad');
});

test('relay: a pad joins with its own key (paired) or the QR (qr), nothing else', async () => {
  const q = makePadSecret(), p = makePadSecret();
  const hashes = { qr: await sha256hex(q), phone: await sha256hex(p) };
  assert.equal(await padCredential(p, hashes), 'paired');
  assert.equal(await padCredential(q, hashes), 'qr');
  assert.equal(await padCredential(makePadSecret(), hashes), null);
  assert.equal(await padCredential(q, { qr: hashes.qr }), 'qr', 'an old room (no phone key) still pairs by QR');
  assert.equal(await padCredential(null, hashes), null);
});

test('relay rate limit: per IP and per seat of a room, and open when a binding is missing or fails', async () => {
  const req = (ip) => ({ headers: new Map(ip ? [['CF-Connecting-IP', ip]] : []) });
  const keys = [];
  const limiter = (success) => ({ limit: async ({ key }) => { keys.push(key); return { success }; } });
  assert.equal(await padRateOk({}, req('1.2.3.4'), 'ABCDEF', 'host'), true, 'no binding (local dev)');
  assert.equal(await padRateOk(undefined, req('1.2.3.4')), true);
  assert.equal(await padRateOk({ PAD_IP_LIMITER: limiter(true), PAD_PLAYER_LIMITER: limiter(true) }, req('1.2.3.4'), 'ABCDEF', 'pad2'), true);
  assert.deepEqual(keys, ['ip:1.2.3.4', 'pad:ABCDEF:pad2']);
  assert.equal(await padRateOk({ PAD_IP_LIMITER: limiter(false) }, req('1.2.3.4'), 'ABCDEF', 'host'), false, 'over the IP ceiling');
  assert.equal(await padRateOk({ PAD_PLAYER_LIMITER: limiter(false) }, req('1.2.3.4'), 'ABCDEF', 'host'), false, 'one seat over its limit');
  assert.equal(await padRateOk({ PAD_IP_LIMITER: limiter(false) }, req(null), 'ABCDEF', 'host'), true, 'no IP: no IP limit');
  assert.equal(await padRateOk({ PAD_IP_LIMITER: { limit: async () => { throw new Error('down'); } } }, req('1.2.3.4')), true, 'a binding error fails open');
});

/** A host with a room already set up (no network). */
function roomHost(hooks = {}) {
  const h = hostWithFakes(hooks);
  h.host.code = 'ABCDEF';
  h.host._secret = 'f'.repeat(32);
  h.host._hash = 'f'.repeat(64);
  h.host._closed = false;
  h.host._buildLink();
  return h;
}
// The host hashes keys with crypto.subtle, which settles off the main thread:
// one tick isn't always enough on a loaded CI runner, so give it ~100 ms of turns.
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5)); };
const toPad = (sent, type) => sent.filter((m) => m.type === 'to-pad' && m.msg.type === type).map((m) => m.msg);

test('mix: new game + older phone (no hello) works as before: no mode, no rekey, the QR stays', async () => {
  const { host, sent, frame } = roomHost();
  host._onMessage(JSON.stringify({ type: 'relay', v: 2 }));
  host._onMessage(JSON.stringify({ type: 'pad-joined', seat: 1, via: 'qr' }));
  frame({ seq: 2, left: true });
  assert.equal(host.status, 'connected');
  host.setMode('ride'); host.setMode('menu');
  await flush();
  assert.deepEqual(toPad(sent, 'mode'), [], 'an older phone is never sent mode');
  assert.deepEqual(toPad(sent, 'rekey'), []);
  assert.deepEqual(toPad(sent, 'hello'), [], 'we only answer a hello');
  assert.equal(host.phoneVersion, 1);
  assert.ok(host.link.endsWith('#k=' + 'f'.repeat(32)), 'the QR keeps working');
});

test('mix: new game + new phone through an older relay: hello + mode, but no rekey; pairs with allow', async () => {
  const { host, sent } = roomHost();
  host._sendPairing();
  assert.equal(sent.at(-1).type, 'allow', 'no relay hello: the old message');
  host._onMessage(JSON.stringify({ type: 'pad-joined', seat: 1 }));   // no via
  host._onMessage(JSON.stringify({ type: 'from-pad', seat: 1, msg: { type: 'hello', v: 2 } }));
  await flush();
  assert.deepEqual(toPad(sent, 'hello'), [{ type: 'hello', v: PAD_PROTOCOL }]);
  assert.deepEqual(toPad(sent, 'mode'), [{ type: 'mode', mode: 'menu' }]);
  assert.deepEqual(toPad(sent, 'rekey'), [], 'an old relay has no phone keys');
  host.setMode('ride');
  assert.deepEqual(toPad(sent, 'mode').at(-1), { type: 'mode', mode: 'ride' });
});

test('single-use QR: a QR phone gets its own key, then the QR moves to a new secret', async () => {
  const links = [];
  const { host, sent } = roomHost({ onLink: (l) => links.push(l) });
  host._onMessage(JSON.stringify({ type: 'relay', v: 2 }));
  host._sendPairing();
  assert.deepEqual([sent.at(-1).type, sent.at(-1).phone], ['pair', null]);
  const firstLink = host.link;
  host._onMessage(JSON.stringify({ type: 'pad-joined', seat: 1, via: 'qr' }));
  host._onMessage(JSON.stringify({ type: 'from-pad', seat: 1, msg: { type: 'hello', v: 2 } }));
  await flush();
  const [rekey] = toPad(sent, 'rekey');
  assert.match(rekey.k, /^[0-9a-f]{32}$/);
  assert.equal(host.link, firstLink, 'nothing changes before the phone acks');
  host._onMessage(JSON.stringify({ type: 'from-pad', seat: 1, msg: { type: 'rekeyed', k: 'a'.repeat(32) } }));
  assert.equal(host.link, firstLink, 'a wrong ack is ignored');
  host._onMessage(JSON.stringify({ type: 'from-pad', seat: 1, msg: { type: 'rekeyed', k: rekey.k } }));
  const pair = sent.at(-1);
  assert.equal(pair.type, 'pair');
  assert.equal(pair.phone, await sha256hex(rekey.k), 'the phone key is registered');
  assert.notEqual(pair.qr, 'f'.repeat(64), 'the QR secret moved');
  assert.notEqual(host.link, firstLink);
  assert.deepEqual(links, [host.link], 'the UI redraws the QR');
  // The paired phone reconnecting is just a reconnect.
  host._onMessage(JSON.stringify({ type: 'pad-joined', seat: 1, via: 'paired' }));
  host._onMessage(JSON.stringify({ type: 'from-pad', seat: 1, msg: { type: 'hello', v: 2 } }));
  await flush();
  assert.equal(toPad(sent, 'rekey').length, 1, 'no second key for a paired phone');
  assert.equal(host.takeovers, 0);
});

test('takeover: a phone joining with the QR while another holds the key is reported, and the old key revoked', async () => {
  let takeovers = 0;
  const { host, sent } = roomHost({ onTakeover: () => takeovers++ });
  host._onMessage(JSON.stringify({ type: 'relay', v: 2 }));
  host._onMessage(JSON.stringify({ type: 'pad-joined', seat: 1, via: 'qr' }));
  host._onMessage(JSON.stringify({ type: 'from-pad', seat: 1, msg: { type: 'hello', v: 2 } }));
  await flush();
  const k = toPad(sent, 'rekey')[0].k;
  host._onMessage(JSON.stringify({ type: 'from-pad', seat: 1, msg: { type: 'rekeyed', k } }));
  assert.equal(takeovers, 0);
  host._onMessage(JSON.stringify({ type: 'pad-joined', seat: 1, via: 'qr' }));   // someone scanned the (new) QR
  assert.equal(takeovers, 1);
  assert.equal(host.takeovers, 1);
  assert.equal(sent.filter((m) => m.type === 'pair').at(-1).phone, null, "the first phone's key stops working");
  host._onMessage(JSON.stringify({ type: 'pad-joined', seat: 1, via: 'qr' }));   // our relay link blipped: re-announced
  assert.equal(takeovers, 1, 'reported once');
  // The new phone is offered its own key in turn.
  host._onMessage(JSON.stringify({ type: 'from-pad', seat: 1, msg: { type: 'hello', v: 2 } }));
  await flush();
  assert.equal(toPad(sent, 'rekey').length, 2);
});

test("an older relay's pad-joined (no via) never counts as a takeover", () => {
  let takeovers = 0;
  const { host } = roomHost({ onTakeover: () => takeovers++ });
  host._phoneHash = 'e'.repeat(64);
  host._onMessage(JSON.stringify({ type: 'pad-joined', seat: 1 }));
  assert.equal(takeovers, 0);
});

test('a phone sending only the menu heartbeat stays connected; silent past 2 s it is gone', () => {
  let drops = 0;
  const { host, frame } = hostWithFakes({ onDrop: () => drops++ });
  host._onMessage(JSON.stringify({ type: 'pad-joined', seat: 1 }));
  let seq = 2;
  for (let i = 0; i < 6; i++) {             // 3 s of heartbeats
    host._lastAt -= MENU_HEARTBEAT_MS;
    host._lastCheckAt = performance.now();
    host._checkStale();
    frame({ seq: seq++ });
  }
  assert.equal(drops, 0);
  assert.equal(host.status, 'connected');
  host._lastAt -= 2100;
  host._lastCheckAt = performance.now();
  host._checkStale();
  assert.equal(drops, 1);
});

// ── #562 · several seats in ONE pad room; #563 · open-room ──
import { JOIN_SEATS, playJoinUrl } from '../../js/remote/pad-protocol.js';

/** A fake seat input that records its calls. */
function seatInput() {
  const calls = [];
  return {
    calls,
    feedRemoteTilt: (t) => calls.push(['tilt', t]),
    setRemotePedals: (...a) => calls.push(['pedals', ...a]),
    setRemoteNav: (on, nav) => calls.push(['nav', on, nav]),
    startTiltCalibration: () => calls.push(['recenter']),
    detachRemote: () => calls.push(['detach']),
  };
}

/** A room (seat 1 = Player 1) on a v2 relay, plus join seats 2 and 3 opened. */
async function multiRoom(hooks = {}) {
  const h = roomHost(hooks);
  h.host._onMessage(JSON.stringify({ type: 'relay', v: 2 }));
  const in2 = seatInput(), in3 = seatInput();
  const ev = [];
  const s2 = h.host.addSeat(2, { input: in2, label: 'Phone 2', onDrop: () => ev.push('drop2'), onReturn: () => ev.push('return2'), onHandOff: (on) => ev.push('handoff2:' + on) });
  const s3 = h.host.addSeat(3, { input: in3, label: 'Phone 3', onDrop: () => ev.push('drop3') });
  await Promise.all([s2.open(), s3.open()]);
  const seatFrame = (seat, f) => { const b = encodeFrame({ seq: 1, tilt: 0, left: false, right: false, tapsL: 0, tapsR: 0, nav: 0, ...f }); const w = new Uint8Array(9); w[0] = seat; w.set(b, 1); h.host._onMessage(w.buffer); };
  return { ...h, s2, s3, in2, in3, ev, seatFrame };
}
const pairsFor = (sent, seat) => sent.filter((m) => m.type === 'pair' && m.seat === seat);
const roomReplies = (sent, seat) => sent.filter((m) => m.type === 'to-pad' && m.seat === seat && m.msg.type === 'room').map((m) => m.msg);

test('links: a shared join link lists its seats and parses back seat-first; play=1 is the #563 choice', () => {
  const link = buildPadLink('https://x/', 'ABCDEF', 2, 'b'.repeat(32), { seats: JOIN_SEATS, play: true });
  assert.equal(link, 'https://x/remote/?pad=ABCDEF&seat=2&seats=2%2C3%2C4&play=1#k=' + 'b'.repeat(32));
  const p = parsePadLink(link);
  assert.deepEqual([p.seat, p.seats, p.play, p.secret], [2, [2, 3, 4], true, 'b'.repeat(32)]);
  assert.deepEqual(parsePadLink('https://x/remote/?pad=ABCDEF&seat=3&seats=2,3,4,9#k=' + 'b'.repeat(32)).seats, [3, 4, 2], 'starts at seat, wraps, drops junk');
  assert.deepEqual(parsePadLink('https://x/remote/?pad=ABCDEF&seat=1#k=' + 'b'.repeat(32)).seats, [1]);
});

test('play link: the join link the TV sent if it is on our site and names the room, else ../?room=CODE', () => {
  const page = 'https://t.example/pr/remote/index.html?pad=ABCDEF&seat=2';
  assert.equal(playJoinUrl(page, 'TNDM-AB12', 'https://t.example/pr/index.html?room=TNDM-AB12&demo=1'), 'https://t.example/pr/index.html?room=TNDM-AB12&demo=1');
  assert.equal(playJoinUrl(page, 'TNDM-AB12', 'https://evil.example/?room=TNDM-AB12'), 'https://t.example/pr/?room=TNDM-AB12', 'another site is never followed');
  assert.equal(playJoinUrl(page, 'TNDM-AB12', 'https://t.example/pr/?room=OTHER'), 'https://t.example/pr/?room=TNDM-AB12');
  assert.equal(playJoinUrl(page, 'TNDM-AB12', null), 'https://t.example/pr/?room=TNDM-AB12');
  assert.equal(playJoinUrl(page, '<script>', null), null);
});

test('multi-seat: free join seats share ONE join secret; the join link names them all', async () => {
  const { host, sent, s2, s3 } = await multiRoom();
  const [p2, p3] = [pairsFor(sent, 2).at(-1), pairsFor(sent, 3).at(-1)];
  assert.ok(p2 && p3);
  assert.equal(p2.qr, p3.qr, 'one QR opens every free seat');
  assert.equal(p2.qr, await sha256hex(host._join.secret));
  assert.equal(s2.link, host.joinLink());
  assert.equal(s3.link, host.joinLink());
  assert.match(host.joinLink(), /seat=2&seats=2%2C3%2C4&/);
  assert.match(host.joinLink({ play: true }), /&play=1/);
  assert.notEqual(host.joinLink(), host.link, 'the Player 1 QR is separate');
});

test('multi-seat: a phone taking a join seat moves THAT seat to its own secret at once (without dropping it); the QR stays', async () => {
  const { host, sent, s2, s3 } = await multiRoom();
  const join = pairsFor(sent, 2).at(-1).qr;
  const link = host.joinLink();
  host._onMessage(JSON.stringify({ type: 'pad-joined', seat: 2, via: 'qr' }));
  const moved = pairsFor(sent, 2).at(-1);
  assert.notEqual(moved.qr, join, 'the next phone scanning the QR cannot land on seat 2');
  assert.equal(moved.phone, null);
  assert.equal(pairsFor(sent, 3).at(-1).qr, join, 'seat 3 is still on offer');
  assert.equal(host.joinLink(), link, 'the QR on screen does not change');
  assert.equal(s2.status, 'connected');
  assert.equal(s3.status, 'waiting');
  assert.equal(s2.takeovers, 0, 'taking a free seat is not a takeover');
  // Then the #454 rekey, as for seat 1.
  host._onMessage(JSON.stringify({ type: 'from-pad', seat: 2, msg: { type: 'hello', v: 2 } }));
  await flush();
  const rekey = sent.filter((m) => m.type === 'to-pad' && m.seat === 2 && m.msg.type === 'rekey')[0];
  assert.ok(rekey, 'the phone gets its own key');
  host._onMessage(JSON.stringify({ type: 'from-pad', seat: 2, msg: { type: 'rekeyed', k: rekey.msg.k } }));
  assert.equal(pairsFor(sent, 2).at(-1).phone, await sha256hex(rekey.msg.k));
  assert.notEqual(s2.link, host.joinLink(), 'the seat 2 link (shown if it drops) is its own');
});

test('multi-seat: frames go to their own seat input; a seat ignores frames before its phone joined', async () => {
  const { host, calls, in2, in3, seatFrame } = await multiRoom();
  host._onMessage(JSON.stringify({ type: 'pad-joined', seat: 2, via: 'qr' }));
  const before = calls.length;
  seatFrame(2, { seq: 2, left: true, tilt: 12 });
  assert.deepEqual(in2.calls.find((c) => c[0] === 'tilt'), ['tilt', 12]);
  assert.ok(in2.calls.some((c) => c[0] === 'pedals' && c[1] === true));
  seatFrame(3, { seq: 2, right: true });
  assert.equal(in3.calls.filter((c) => c[0] === 'pedals').length, 0, 'seat 3 has no phone yet');
  assert.equal(calls.length, before, 'the Player 1 input is untouched');
  host._onMessage(JSON.stringify({ type: 'pad-joined', seat: 3, via: 'qr' }));
  seatFrame(3, { seq: 3, right: true });
  assert.ok(in3.calls.some((c) => c[0] === 'pedals' && c[2] === true));
});

test('multi-seat: drop and reconnect are per seat; a silent phone does not redial while another phone gets through', async () => {
  const { host, s2, s3, ev, seatFrame } = await multiRoom();
  host._onMessage(JSON.stringify({ type: 'pad-joined', seat: 2, via: 'paired' }));
  host._onMessage(JSON.stringify({ type: 'pad-joined', seat: 3, via: 'paired' }));
  seatFrame(2, { seq: 2 }); seatFrame(3, { seq: 2 });
  s2._lastAt -= 2500;
  s2._lastCheckAt = performance.now();
  s2._checkStale();
  assert.deepEqual(ev, ['drop2']);
  assert.equal(s2.status, 'waiting');
  assert.equal(s3.status, 'connected');
  assert.equal(host.redials, 0, 'seat 3 still gets through: it is the seat 2 phone, not our socket');
  host._onMessage(JSON.stringify({ type: 'pad-left', seat: 3 }));
  assert.deepEqual(ev, ['drop2', 'drop3']);
  seatFrame(2, { seq: 3 });
  assert.deepEqual(ev, ['drop2', 'drop3', 'return2']);
});

test('multi-seat: closing a seat says bye and locks it; the room stays open until its last seat closes', async () => {
  const { host, sent, s2, s3 } = await multiRoom();
  host._active = true;   // the Player 1 seat is open too
  s3.close();
  assert.equal(sent.filter((m) => m.type === 'to-pad' && m.seat === 3).at(-1).msg.type, 'bye');
  const locked = pairsFor(sent, 3).at(-1);
  assert.notEqual(locked.qr, pairsFor(sent, 2).at(-1).qr, 'the join QR no longer opens seat 3');
  assert.equal(host.seats.has(3), false);
  assert.equal(host._closed, false);
  host._onMessage(JSON.stringify({ type: 'pad-joined', seat: 3, via: 'qr' }));
  assert.equal(s3.status, 'idle', 'a closed seat ignores the relay');
  s2.close();
  host.close();
  assert.equal(host._closed, true, 'no seat open: the room closes');
  assert.equal(host.code, null);
});

test('multi-seat: a new seat on a number is a fresh seat (the old one is retired)', async () => {
  const { host, s3 } = await multiRoom();
  assert.throws(() => host.addSeat(3, { input: seatInput() }), /in use/);
  s3.close();
  const again = host.addSeat(3, { input: seatInput() });
  assert.notEqual(again, s3);
  await again.open();
  assert.equal(again.link, host.joinLink());
});

test('open-room (#563): only a join seat with its phone here, while the game allows it; the reply carries the code', async () => {
  const { host, sent, ev } = await multiRoom();
  const asked = [];
  host.onOpenRoom = async (seat) => { asked.push(seat); return { code: 'TNDM-AB12', url: 'https://x/index.html?room=TNDM-AB12' }; };
  host._onMessage(JSON.stringify({ type: 'pad-joined', seat: 2, via: 'qr' }));
  // Not allowed now (e.g. versus, or the partner seat is taken).
  host._onMessage(JSON.stringify({ type: 'from-pad', seat: 2, msg: { type: 'open-room' } }));
  await flush();
  assert.deepEqual(roomReplies(sent, 2), [{ type: 'room', error: 'not-now' }]);
  assert.deepEqual(asked, []);
  // The Player 1 seat never opens a room.
  host.allowPlay = true;
  host._onMessage(JSON.stringify({ type: 'pad-joined', seat: 1, via: 'paired' }));
  host._onMessage(JSON.stringify({ type: 'from-pad', seat: 1, msg: { type: 'open-room' } }));
  await flush();
  assert.deepEqual(roomReplies(sent, 1), [{ type: 'room', error: 'not-now' }]);
  // A seat whose phone is not here (no valid key got one onto the relay) is refused.
  host._onMessage(JSON.stringify({ type: 'from-pad', seat: 3, msg: { type: 'open-room' } }));
  await flush();
  assert.deepEqual(roomReplies(sent, 3), [{ type: 'room', error: 'not-now' }]);
  // Allowed: the game opens the room and the phone gets its code.
  host._onMessage(JSON.stringify({ type: 'from-pad', seat: 2, msg: { type: 'open-room' } }));
  await flush();
  assert.deepEqual(asked, [2]);
  assert.deepEqual(roomReplies(sent, 2).at(-1), { type: 'room', code: 'TNDM-AB12', url: 'https://x/index.html?room=TNDM-AB12' });
  assert.deepEqual(ev, ['handoff2:true']);
  assert.equal(host.seats.get(2).handedOff, true);
});

test('open-room (#563): a room that fails to open is reported, and the phone is a controller again', async () => {
  const { host, sent, ev } = await multiRoom();
  host.allowPlay = true;
  host.onOpenRoom = async () => null;
  host._onMessage(JSON.stringify({ type: 'pad-joined', seat: 2, via: 'qr' }));
  host._onMessage(JSON.stringify({ type: 'from-pad', seat: 2, msg: { type: 'open-room' } }));
  await flush();
  assert.deepEqual(roomReplies(sent, 2), [{ type: 'room', error: 'failed' }]);
  assert.deepEqual(ev, ['handoff2:true', 'handoff2:false']);
  assert.equal(host.seats.get(2).handedOff, false);
});

test('multi-seat: a refused room moves every open seat to the new code (and a new join QR)', async () => {
  const { host, s2 } = await multiRoom();
  host._active = true;
  const oldJoin = host.joinLink(), oldCode = host.code;
  assert.ok(await host._newRoom());
  assert.notEqual(host.code, oldCode);
  assert.notEqual(host.joinLink(), oldJoin);
  assert.equal(s2.link, host.joinLink());
  assert.ok(host.link.includes('pad=' + host.code));
});
