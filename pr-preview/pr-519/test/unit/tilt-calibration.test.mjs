// B1 (PR #397 review): phone tilt steers at TUNE.mobileTiltGain (0.25), so the
// gained lean tops out at 0.25. The tutorial's tilt calibration waits for a
// lean strictly past ±0.25, and the drift tracker only paused at |lean| ≥ 0.3,
// so on a phone the calibration could never pass and every held tilt was
// slowly re-centred away. Both now read the ungained lean.
import test from 'node:test';
import assert from 'node:assert/strict';
import { InputManager } from '../../js/input-manager.js';
import { TUNE } from '../../js/config.js';

/** A bare InputManager with only the phone-tilt pipeline's state. */
function phone() {
  const im = Object.create(InputManager.prototype);
  Object.assign(im, {
    motionEnabled: true, rawGamma: 0, motionOffset: 0, _calibrating: false, _warmupCount: 5,
    _driftEma: null, _driftRate: 0.015, _driftWindowK: 0.005,
    _smoothedLean: 0, _prevLeanRaw: 0, motionLean: 0, motionLeanVisual: 0,
    bikeSpeed: 0, bikeMaxSpeed: 12, _lastApplyTiltTime: 0,
  });
  return im;
}

/** Feed `n` orientation samples at `deg`, 60 Hz. */
function hold(im, deg, n) {
  const realNow = performance.now;
  let t = (im.__t || 1000);
  performance.now = () => t;
  try {
    for (let i = 0; i < n; i++) { t += 1000 / 60; im._applyTilt(deg); }
  } finally { performance.now = realNow; im.__t = t; }
}

test('a full phone tilt passes the ±0.25 calibration targets on the ungained lean', () => {
  assert.equal(TUNE.mobileTiltGain, 0.25);
  const im = phone();
  hold(im, 0, 30);
  hold(im, -40, 60);
  assert.ok(im.getMotionLean() >= -0.25 - 1e-9, 'the gained lean can never pass -0.25 — why B1 happened');
  assert.ok(im.getMotionLeanVisual() < -0.25, `visual ${im.getMotionLeanVisual()}`);
  hold(im, 40, 120);
  assert.ok(im.getMotionLeanVisual() > 0.25);
});

test('holding a phone tilt does not drag the centre along with it', () => {
  const im = phone();
  hold(im, 0, 60);
  hold(im, 30, 180);   // 3 s held turn
  assert.ok(Math.abs(im.motionOffset) < 0.5, `offset chased the tilt to ${im.motionOffset.toFixed(2)}°`);
  assert.ok(im.getMotionLeanVisual() > 0.9, 'the held turn is still a full lean');
});
