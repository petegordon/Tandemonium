// #365 · the gyro drift correction in _applyTilt is scaled by a taper on the
// smoothed lean. It used to fade to exactly zero past a large lean, which is a
// positive-feedback loop under a constant uncorrected gyro bias: rawGamma grows,
// lean grows, taper shrinks, correction weakens, lean grows faster — and once
// past ZERO_AT the correction stopped and the pull could never recover. The
// taper now has a floor so a slow pull-back stays alive through any lean.
// #522: the taper reads the UNGAINED lean (gyro now carries TUNE.motionGain),
// so these checks read getMotionLeanVisual().
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  InputManager, driftTaper,
  DRIFT_TAPER_FULL_BELOW, DRIFT_TAPER_ZERO_AT, DRIFT_TAPER_FLOOR,
} from '../../js/input-manager.js';

test('driftTaper is full strength at and below FULL_BELOW', () => {
  assert.equal(DRIFT_TAPER_FULL_BELOW, 0.2);
  assert.equal(driftTaper(0), 1);
  assert.equal(driftTaper(0.1), 1);
  assert.equal(driftTaper(0.2), 1);
});

test('driftTaper sits on the floor at and beyond ZERO_AT — never zero', () => {
  assert.equal(DRIFT_TAPER_ZERO_AT, 0.7);
  assert.equal(DRIFT_TAPER_FLOOR, 0.15);
  assert.equal(driftTaper(0.7), 0.15);
  assert.equal(driftTaper(0.9), 0.15);
  assert.equal(driftTaper(1), 0.15);
  assert.equal(driftTaper(5), 0.15, 'even an out-of-range lean keeps the floor');
  for (let L = 0; L <= 1.5; L += 0.01) assert.ok(driftTaper(L) > 0, `taper is 0 at L=${L}`);
});

test('driftTaper is linear between FULL_BELOW and ZERO_AT, clamped by the floor', () => {
  const lin = (L) => (0.7 - L) / 0.5;
  // Above the floor the ramp is the original straight line.
  for (const L of [0.25, 0.3, 0.4, 0.5, 0.6]) {
    assert.ok(Math.abs(driftTaper(L) - lin(L)) < 1e-12, `L=${L} → ${driftTaper(L)} vs ${lin(L)}`);
  }
  assert.ok(Math.abs(driftTaper(0.45) - 0.5) < 1e-12, 'halfway down the ramp is half strength');
  // Where the line would dip under the floor, the floor wins.
  assert.equal(driftTaper(0.65), 0.15, 'line gives 0.1 here — floored to 0.15');
  // Monotonic non-increasing across the whole range.
  let prev = Infinity;
  for (let L = 0; L <= 1; L += 0.005) {
    const t = driftTaper(L);
    assert.ok(t <= prev + 1e-12, `taper rose at L=${L}`);
    prev = t;
  }
});

/** A bare InputManager with only the gyro-tilt pipeline's state. */
function gyroPad() {
  const im = Object.create(InputManager.prototype);
  Object.assign(im, {
    motionEnabled: true, rawGamma: 0, motionOffset: 0, _calibrating: false, _warmupCount: 5,
    _driftEma: null, _driftRate: 0.015, _driftWindowK: 0.005,
    _smoothedLean: 0, _prevLeanRaw: 0, motionLean: 0, motionLeanVisual: 0,
    bikeSpeed: 0, bikeMaxSpeed: 12, _lastApplyTiltTime: 0,
  });
  return im;
}

/** Feed `n` gyro roll samples from `rollAt(i)` degrees, 60 Hz. */
function feed(im, rollAt, n) {
  const realNow = performance.now;
  let t = (im.__t || 1000);
  performance.now = () => t;
  try {
    for (let i = 0; i < n; i++) { t += 1000 / 60; im._applyTilt(rollAt(i), true); }
  } finally { performance.now = realNow; im.__t = t; }
}

test('a saturated one-sided gyro pull keeps being corrected and recovers (#365)', () => {
  const im = gyroPad();
  feed(im, () => 0, 60);
  // Integrated roll runs away under an uncorrected bias, then sits far past a
  // full lean: lean saturates at 1.0, well beyond ZERO_AT.
  feed(im, (i) => Math.min(60, i * 2), 60);
  assert.ok(Math.abs(im.getMotionLeanVisual()) > 0.95, `lean should be saturated, got ${im.getMotionLeanVisual()}`);
  const offsetAtSaturation = im.motionOffset;

  // Before the floor, the taper was exactly 0 here and motionOffset froze for
  // good. With the floor the offset keeps chasing the held roll.
  feed(im, () => 60, 60 * 20);   // 20 s of the same one-sided pull
  assert.ok(im.motionOffset > offsetAtSaturation + 10,
    `offset should keep moving toward the pull, went ${offsetAtSaturation.toFixed(2)} → ${im.motionOffset.toFixed(2)}`);
  assert.ok(Math.abs(im.getMotionLeanVisual()) < 0.7,
    `lean should have come back under ZERO_AT, got ${im.getMotionLeanVisual().toFixed(3)}`);

  feed(im, () => 60, 60 * 40);   // another 40 s — the pull is fully absorbed
  assert.ok(Math.abs(im.getMotionLeanVisual()) < 0.1, `lean should be ~centred, got ${im.getMotionLeanVisual().toFixed(3)}`);
});

test('the floor still does not re-centre a quick deliberate corner', () => {
  const im = gyroPad();
  feed(im, () => 0, 120);
  feed(im, () => 55, 60);   // 1 s full lean — longer than a real corner's peak
  assert.ok(Math.abs(im.motionOffset) < 2, `offset chased the corner to ${im.motionOffset.toFixed(2)}°`);
  assert.ok(im.getMotionLeanVisual() > 0.8, `the corner is still a strong lean, got ${im.getMotionLeanVisual().toFixed(3)}`);
});
