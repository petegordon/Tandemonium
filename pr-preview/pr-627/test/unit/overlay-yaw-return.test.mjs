// #596 · the controller overlay's model drifted in yaw: the fusion's at-rest
// yaw return ships disabled and the game never turned it on. Attaching a slot
// now sets it on the slot's fusion.
import test from 'node:test';
import assert from 'node:assert/strict';
import { InputManager, YAW_RETURN_HALF_LIFE_S } from '../../js/input-manager.js';
import { SensorFusion } from '../../shared/sensor-fusion.js';
import { stepYawReturn } from '../../shared/yaw-return.js';

globalThis.document = globalThis.document || { getElementById: () => null, addEventListener: () => {}, activeElement: null };
globalThis.window = globalThis.window || { addEventListener: () => {} };
const storage = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
globalThis.sessionStorage = globalThis.sessionStorage || storage();   // analytics.setController runs on attach
globalThis.localStorage = globalThis.localStorage || storage();

function fakeSlot(fusion) {
  const listeners = [];
  return {
    state: 'claimed', controllerLabel: 'HID::DualSense Wireless Controller Vendor: 054c Product: 0ce6',
    _hidEntry: { device: { vendorId: 0x054c, productId: 0x0ce6 } }, fusion,
    on(fn) { listeners.push(fn); return () => {}; },
  };
}

test('attaching a slot turns the fusion\'s yaw return on', () => {
  const fusion = new SensorFusion();
  assert.equal(fusion.yawReturnHalfLife, 0, 'the lab default: raw yaw passes straight through');
  const im = new InputManager({ slot: fakeSlot(fusion), enableKeyboard: false, enableMotion: false, enableTouch: false });
  assert.ok(im);
  assert.equal(fusion.yawReturnHalfLife, YAW_RETURN_HALF_LIFE_S);
});

test('a half-life someone already set (the lab overlay\'s Yaw Drift) is kept', () => {
  const fusion = new SensorFusion();
  fusion.yawReturnHalfLife = 5;
  new InputManager({ slot: fakeSlot(fusion), enableKeyboard: false, enableMotion: false, enableTouch: false });
  assert.equal(fusion.yawReturnHalfLife, 5);
});

test('with the half-life on, a displayed heading decays toward centre at rest', () => {
  // Pad turned 60° about world-up; the reference heading starts at 0.
  const yaw = Math.PI / 3;
  const q = { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
  let ref = 0;
  for (let t = 0; t < YAW_RETURN_HALF_LIFE_S; t += 0.05) ref = stepYawReturn(ref, q, 0.05, YAW_RETURN_HALF_LIFE_S);
  const displayed = Math.abs(yaw - ref);
  assert.ok(displayed < yaw * 0.55 && displayed > yaw * 0.45, `after one half-life about half remains: ${displayed.toFixed(3)} of ${yaw.toFixed(3)}`);
  assert.equal(stepYawReturn(0, q, 0.05, 0), 0, 'half-life 0 = no return (the old behaviour)');
});
