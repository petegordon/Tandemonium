// m22 (PR #397 review): the Steam Input "Steer" analog fallback is a stick-like
// axis, so it gets the same dead zone + response curve as the gamepad left
// stick (#399) instead of steering linearly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { InputManager } from '../../js/input-manager.js';
import { stickResponse } from '../../js/config.js';

/** A bare InputManager whose Steam Input has the pad, with no motion data. */
function steamSteer(steerX) {
  const im = Object.create(InputManager.prototype);
  Object.assign(im, {
    motionEnabled: true, _steamInputActive: true, _steamInputPrevActive: true,
    _wasFusionCalibrating: false, motionLean: 0, motionLeanVisual: 0,
    _smoothedLean: 0, _prevLeanRaw: 0, _gyroRollAccum: 0, _accelRoll: 0,
  });
  im._refreshSteamInputSnapshot = () => {};
  im.getGamepadState = () => null;
  im._slotFusionIsLive = () => false;
  im._selectedSteamEntry = () => ({ handle: 1, type: 'steamcontroller', steerX, motion: null });
  im._markActive = () => {};
  im.pollGamepad();
  return im;
}

test('Steam steerX fallback uses the stick curve', () => {
  for (const x of [0, 0.1, 0.3, 0.6, -0.6, 1, -1]) {
    const im = steamSteer(x);
    assert.equal(im.motionLean, stickResponse(x), `x=${x}`);
    assert.equal(im.getMotionLean(), stickResponse(x));
  }
  // a light push inside the dead zone steers nothing; half a push is well under half a lean
  assert.equal(steamSteer(0.1).motionLean, 0);
  assert.ok(steamSteer(0.5).motionLean < 0.25);
});

test('the pseudo roll angle the tutorial samples stays raw', () => {
  assert.equal(steamSteer(0.5)._gyroRollAccum, -45);
});
