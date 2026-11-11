// Phone tilt at a gentler steering gain: the physics gets the gentle lean,
// the riders' body lean (the look) gets the player's full tilt.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BalanceController } from '../../js/balance-controller.js';

/** An InputManager stand-in: a phone tilted to `visual`, steering at `gain`. */
function fakePhone({ visual = 0, gain = 0.25, keys = [], stick = 0, withVisual = true } = {}) {
  const input = {
    gyroConnected: false,
    isPressed: (code) => keys.includes(code),
    getMotionLean: () => visual * gain,
    getGamepadLean: () => stick,
  };
  if (withVisual) input.getMotionLeanVisual = () => visual;
  return input;
}

test('tilt: physics steers a quarter as much, the riders still lean the full tilt', () => {
  const r = new BalanceController(fakePhone({ visual: 0.56 })).update();
  assert.equal(r.leanInput, 0.56 * 0.25);
  assert.equal(r.visualLean, 0.56);
});

test('keyboard and stick steer both the same (only phone tilt has a gain)', () => {
  const r = new BalanceController(fakePhone({ visual: 0, keys: ['KeyD'] })).update();
  assert.equal(r.leanInput, 1);
  assert.equal(r.visualLean, 1);
  const s = new BalanceController(fakePhone({ visual: 0.4, stick: -0.2 })).update();
  assert.equal(s.leanInput, 0.4 * 0.25 - 0.2);
  assert.equal(s.visualLean, 0.4 - 0.2);
});

test('both are clamped to [-1, 1]', () => {
  const r = new BalanceController(fakePhone({ visual: 1, keys: ['KeyD'] })).update();
  assert.equal(r.leanInput, 1);
  assert.equal(r.visualLean, 1);
});

test('an input without the look-only lean falls back to the steering lean', () => {
  const r = new BalanceController(fakePhone({ visual: 0.8, withVisual: false })).update();
  assert.equal(r.visualLean, r.leanInput);
});

test('with assist on, both blend toward the auto-steer the same way', () => {
  const bc = new BalanceController(fakePhone({ visual: 0.8 }));
  bc.computeAutoSteer = () => 0;                    // assist pulls to centre
  const r = bc.update({ roadPath: {} }, 0.5);
  assert.equal(r.leanInput, 0.8 * 0.25 * 0.5);
  assert.equal(r.visualLean, 0.8 * 0.5);
});
