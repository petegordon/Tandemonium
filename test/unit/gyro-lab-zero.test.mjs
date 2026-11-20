// #365 · controller gyro steers by the controller lab's roll zero ('zero' mode, the default).
//
// The report: "gyro pulls to one side and sticks". The cause found in the lab (issue 112): a
// recentre reset the fusion, and after a reset the gravity roll takes many seconds to come
// back to the real pose, so the centre just taken was wrong against it.
//
// These run the REAL SensorFusion (shared/sensor-fusion.js) with a simulated controller:
// a rigid roll where the gyro and the accelerometer agree, 250 Hz, a small hand tremor and
// sensor noise; the game reads it at 60 Hz. Time is the simulation's.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { SensorFusion } from '../../shared/sensor-fusion.js';
import {
  InputManager, readGyroRollMode, normalizeGyroRollMode, GYRO_MODE_KEY,
  ZERO_FIRST_WAIT_MS, ZERO_GIVE_UP_MS,
} from '../../js/input-manager.js';

const DEG = Math.PI / 180, GS = 2000 / 32768;

/** A controller in a hand, its fusion, and an InputManager reading it. */
function rig(mode, { accel = true } = {}) {
  const fusion = new SensorFusion();
  const im = Object.create(InputManager.prototype);
  Object.assign(im, {
    _slot: { fusion, _hidEntry: { hidActiveSince: 1 } }, _gyroRollMode: mode, _tmpEuler: new THREE.Euler(),
    motionEnabled: true, rawGamma: 0, motionOffset: null, _calibrating: false, _warmupCount: 0, _calibBuf: [],
    _driftEma: null, _driftRate: 0.015, _driftWindowK: 0.005, _rideCentring: false,
    _smoothedLean: 0, _prevLeanRaw: 0, motionLean: 0, motionLeanVisual: 0, motionRawRelative: 0,
    bikeSpeed: 0, bikeMaxSpeed: 12, _lastApplyTiltTime: 0, _gyroRollAccum: 0, _accelRoll: null,
  });
  let seed = 11; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
  const s = { fusion, im, t: 1000, phi: 0, frameAt: 1000, resets: 0, worst: 0 };
  const reset = fusion.reset.bind(fusion);
  fusion.reset = () => { s.resets++; reset(); };
  /** Advance `ms`, rolling toward `target` degrees at up to `rate` deg/s. Tracks the largest |relative| seen. */
  s.run = (ms, target = s.phi, rate = 120) => {
    const realNow = performance.now;
    performance.now = () => s.t;
    try {
      const end = s.t + ms;
      s.worst = 0;
      while (s.t < end) {
        s.t += 4;
        const d = Math.max(-rate * 0.004, Math.min(rate * 0.004, target - s.phi));
        s.phi += d;
        const p = (s.phi + 0.15 * Math.sin(s.t / 37)) * DEG;
        const rateDps = d / 0.004 + 0.15 * Math.cos(s.t / 37) / 37 * 1000;
        if (accel) fusion.ingest(rnd() * 4, rnd() * 4, rateDps / GS, Math.sin(p) * 8192 + rnd() * 20, Math.cos(p) * 8192 + rnd() * 20, rnd() * 20, GS, 1 / 8192, s.t);
        else fusion.ingest(rnd() * 4, rnd() * 4, rateDps / GS, null, null, null, GS, 1 / 8192, s.t);
        if (s.t >= s.frameAt) {                                 // the game's frame, 60 Hz
          s.frameAt += 1000 / 60;
          im._projectFusionToLean(fusion, 'test');
          s.worst = Math.max(s.worst, Math.abs(im.motionRawRelative));
        }
      }
    } finally { performance.now = realNow; }
  };
  s.rel = () => im.motionRawRelative;
  s.call = (fn) => { const realNow = performance.now; performance.now = () => s.t; try { return fn(); } finally { performance.now = realNow; } };
  return s;
}

test('the new mode is the default, under a new key: a choice saved under the old key holds nobody back', () => {
  const store = new Map([['tandemonium_gyro_roll_mode', 'gravity']]);
  const real = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
  try {
    assert.equal(readGyroRollMode(), 'zero');
    store.set(GYRO_MODE_KEY, 'gravity'); assert.equal(readGyroRollMode(), 'gravity');
    store.set(GYRO_MODE_KEY, 'euler'); assert.equal(readGyroRollMode(), 'euler');
    store.set(GYRO_MODE_KEY, 'nonsense'); assert.equal(readGyroRollMode(), 'zero');
  } finally { if (real === undefined) delete globalThis.localStorage; else globalThis.localStorage = real; }
  assert.equal(normalizeGyroRollMode(undefined), 'zero');
});

test('first level: the lean holds at 0 until the controller has been at rest, then the grip is level', () => {
  const s = rig('zero');
  s.phi = 8;                         // held 8 degrees off flat from the start
  s.run(300);
  assert.equal(s.fusion.rollZero.zero, null, 'no level after 300 ms');
  assert.equal(s.im.getMotionLean(), 0);
  s.run(1200);
  assert.ok(s.fusion.rollZero.zero != null, 'level taken once at rest');
  assert.ok(Math.abs(s.fusion.rollZero.zero / DEG + 8) < 1, `zero ${(s.fusion.rollZero.zero / DEG).toFixed(2)} is the grip`);
  assert.ok(Math.abs(s.rel()) < 1, `relative ${s.rel().toFixed(2)} reads level`);
  s.run(1500, 28);                   // lean 20 more
  assert.ok(Math.abs(Math.abs(s.rel()) - 20) < 1, `a 20 degree lean reads ${s.rel().toFixed(2)}`);
  assert.ok(Math.abs(s.im.getMotionLeanVisual()) > 0.2 || Math.abs(s.im.getMotionLean()) > 0.05, 'and steers: lean ' + s.im.getMotionLean() + ' visual ' + s.im.getMotionLeanVisual());
});

test('a held lean is never pulled back to centre (no drift tracking on the lab zero)', () => {
  const s = rig('zero');
  s.run(2000);
  s.run(1000, 15);
  const at = s.rel();
  s.run(60000);                      // hold the lean for a minute
  assert.ok(Math.abs(s.rel() - at) < 0.5, `after a minute: ${s.rel().toFixed(2)} (was ${at.toFixed(2)})`);
  assert.ok(Math.abs(Math.abs(s.rel()) - 15) < 1);
});

test('recentre at rest while tilted: level at once, it stays level, and the fusion is not reset', () => {
  const s = rig('zero');
  s.run(2000);
  s.run(2000, 30);
  s.call(() => s.im.recenterGyro());
  assert.equal(s.resets, 0, 'no fusion reset');
  s.run(100);
  assert.ok(Math.abs(s.rel()) < 1, `100 ms after: ${s.rel().toFixed(2)}`);
  s.run(10000);
  assert.ok(s.worst < 1, `over the next 10 s the centre never moved more than ${s.worst.toFixed(2)} degrees`);
  s.run(1500, 50);
  assert.ok(Math.abs(Math.abs(s.rel()) - 20) < 1, `a 20 degree lean from the new centre reads ${s.rel().toFixed(2)}`);
});

test('the bug this replaces: in the old mode the same recentre leaves the centre wandering for seconds', () => {
  const s = rig('gravity');
  s.run(3000);                       // the old first calibration
  s.run(2000, 30);
  s.call(() => s.im.recenterGyro());
  assert.equal(s.resets, 1, 'the old recentre resets the fusion');
  s.run(10000);                      // nobody moves the controller
  assert.ok(s.worst > 5, `old mode: the steering input moved up to ${s.worst.toFixed(1)} degrees by itself`);
});

test('recentre during a countdown: tilted and moving, then a steady grip; the grip is level, not the swing', () => {
  const s = rig('zero');
  s.run(2000);
  // the player is getting a grip: swinging around 20 degrees
  for (let i = 0; i < 3; i++) { s.run(150, 35, 200); s.run(150, 5, 200); }
  s.call(() => s.im.recenterGyro());
  assert.equal(s.fusion.rollZero.pending, true, 'not at rest: the level waits for a still moment');
  for (let i = 0; i < 2; i++) { s.run(150, 35, 200); s.run(150, 5, 200); }
  assert.equal(s.fusion.rollZero.pending, true);
  s.run(1200, 12);                   // settles at 12 degrees
  assert.equal(s.fusion.rollZero.pending, false);
  assert.ok(Math.abs(s.fusion.rollZero.zero / DEG + 12) < 1, `zero ${(s.fusion.rollZero.zero / DEG).toFixed(2)} is the settled grip`);
  s.run(500);
  assert.ok(Math.abs(s.rel()) < 1);
});

test('a tutorial restart keeps the grip as level and does not reset the fusion', () => {
  const s = rig('zero');
  s.phi = 10;
  s.run(2500);
  const zero = s.fusion.rollZero.zero;
  s.run(800, 30);
  s.call(() => s.im.resetLeanState());
  assert.equal(s.resets, 0);
  assert.equal(s.fusion.rollZero.zero, zero);
  assert.equal(s.im.getMotionLean(), 0, 'the lean restarts from 0');
  s.run(300);
  assert.ok(Math.abs(Math.abs(s.rel()) - 20) < 1.5, 'and the held 20 degrees still reads as a lean');
});

test('no accelerometer data: after a short wait the roll as it is becomes level, and gyro still steers', () => {
  const s = rig('zero', { accel: false });
  s.run(ZERO_FIRST_WAIT_MS);
  assert.equal(s.fusion.rollZero.zero, null);
  s.run(ZERO_GIVE_UP_MS);
  assert.ok(s.fusion.rollZero.zero != null, 'gave up waiting and took the roll as it is');
  assert.equal(s.fusion.rollZero.pending, false);
});

test('switching to the old mode mid-ride carries on from the same centre', () => {
  const s = rig('zero');
  s.phi = 9;
  s.run(2500);
  s.run(1000, 24);
  const before = s.rel();
  s.im.setGyroRollMode('gravity');
  s.run(34);                         // (two frames: the old mode's drift tracking then starts to move its centre, as it always did)
  assert.ok(Math.abs(s.rel() - before) < 1, `${before.toFixed(2)} then ${s.rel().toFixed(2)}`);
  s.im.setGyroRollMode('whatever');
  assert.equal(s.im._gyroRollMode, 'zero');
});

test('a fusion without the lab zero (an older vendored core) falls back to the old centre', () => {
  const s = rig('zero');
  s.fusion.rollRelativeRadians = undefined;
  s.run(3000);
  assert.ok(s.im.motionOffset != null, 'the old calibration ran');
  s.call(() => s.im.recenterGyro());
  assert.equal(s.resets, 1, 'and the old recentre');
});
