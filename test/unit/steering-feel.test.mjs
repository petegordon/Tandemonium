// #399 · forgiving steering. 5 of 5 playtesters found lean/steer too
// sensitive and one quit, so the defaults moved to the gentle end. These tests
// pin the stick response curve's shape and that each default is what its
// comment in js/config.js / js/dda-manager.js says it is.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BALANCE_DEFAULTS, TUNE, stickResponse } from '../../js/config.js';
import { DDAManager, DDA_ASSIST_AFTER, DDA_SILENT_ADJUST_AFTER, DDA_SKIP_AFTER } from '../../js/dda-manager.js';

test('stick: inside the dead zone steers nothing', () => {
  for (const x of [0, 0.05, 0.08, 0.1, 0.149, -0.149, -0.1]) {
    assert.equal(stickResponse(x), 0, `x=${x}`);
  }
  assert.equal(stickResponse(0.15), 0, 'the dead-zone edge is still zero, no jump');
  assert.equal(stickResponse(NaN), 0);
  assert.equal(stickResponse(undefined), 0);
});

test('stick: full deflection is still a full lean', () => {
  assert.equal(stickResponse(1), 1);
  assert.equal(stickResponse(-1), -1);
  // pads can overshoot slightly past ±1
  assert.equal(stickResponse(1.02), 1);
  assert.equal(stickResponse(-1.02), -1);
});

test('stick: monotonic, odd-symmetric, and below linear in between', () => {
  let prev = 0;
  for (let i = 0; i <= 200; i++) {
    const x = i / 200;
    const y = stickResponse(x);
    assert.ok(y >= prev, `not monotonic at x=${x}`);
    assert.equal(stickResponse(-x), y === 0 ? 0 : -y, `not symmetric at x=${x}`);
    if (x > 0.15 && x < 1) assert.ok(y < x, `curve should be gentler than linear at x=${x}`);
    prev = y;
  }
  // a light thumb (30% deflection) barely steers
  assert.ok(stickResponse(0.3) < 0.05, `0.3 → ${stickResponse(0.3)}`);
  // half deflection is clearly less than half a lean
  assert.ok(stickResponse(0.5) < 0.25, `0.5 → ${stickResponse(0.5)}`);
});

test('stick: the curve matches sign(x)·t^1.8 with t rescaled past the dead zone', () => {
  const t = (0.6 - 0.15) / 0.85;
  assert.ok(Math.abs(stickResponse(0.6) - Math.pow(t, 1.8)) < 1e-12);
  assert.ok(Math.abs(stickResponse(-0.6) + Math.pow(t, 1.8)) < 1e-12);
});

test('defaults are the #399 values the config comments state', () => {
  assert.equal(BALANCE_DEFAULTS.stickDeadzone, 0.15);
  assert.equal(BALANCE_DEFAULTS.stickResponseCurve, 1.8);
  assert.equal(BALANCE_DEFAULTS.gyroSensitivity, 55);
  assert.equal(BALANCE_DEFAULTS.gyroResponseCurve, 2.0);
  assert.equal(BALANCE_DEFAULTS.gyroOutputSmoothing, 0.4,
    'EMA weight: lower = more smoothing');
  assert.equal(BALANCE_DEFAULTS.steeringFeel, 0.3);
  // unchanged on purpose
  assert.equal(BALANCE_DEFAULTS.mobileTiltGain, 0.25);
  assert.equal(BALANCE_DEFAULTS.gyroDeadzone, 4);
});

test('the default steering feel is applied at load, not just shown on the slider', () => {
  assert.equal(TUNE.steeringFeel, 0.3);
  // applySteeringFeel(0.3): sensitivity ×0.94, smoothing ×0.87, dead zone ×1.16
  assert.ok(Math.abs(TUNE.gyroSensitivity - 55 * 0.94) < 1e-9, `gyroSensitivity ${TUNE.gyroSensitivity}`);
  assert.ok(Math.abs(TUNE.gyroOutputSmoothing - 0.4 * 0.87) < 1e-9);
  assert.ok(Math.abs(TUNE.gyroDeadzone - 4 * 1.16) < 1e-9);
  assert.equal(TUNE.gyroResponseCurve, 2.0, 'already at the 2.0 ceiling');
});

test('DDA offers ASSIST after 2 failures; silent assist unchanged; SKIP after 5 (#403)', () => {
  assert.equal(DDA_ASSIST_AFTER, 2);
  assert.equal(DDA_SILENT_ADJUST_AFTER, 2);
  assert.equal(DDA_SKIP_AFTER, 5);
  const dda = new DDAManager('chill');
  dda.recordFailure(100);
  assert.equal(dda.evaluate(100).offerAssist, false, 'one failure is not enough');
  dda.recordFailure(100);
  const r = dda.evaluate(100);
  assert.equal(r.offerAssist, true);
  assert.equal(r.adjustTune, true);
  assert.equal(r.offerSkip, false);
  for (let i = 0; i < 4; i++) dda.recordFailure(100);
  assert.equal(dda.evaluate(100).offerSkip, true);
});
