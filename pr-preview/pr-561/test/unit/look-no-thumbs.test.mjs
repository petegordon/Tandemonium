// #500 · Look, No Thumbs: finish a ride steering only by controller gyro.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACHIEVEMENTS, gyroOnlySteer, GYRO_ONLY_MIN_FRAMES } from '../../js/achievement-defs.js';

const ach = ACHIEVEMENTS.find(a => a.id === 'look_no_thumbs');
const frames = (o = {}) => ({ keyboard: 0, gamepad: 0, motion: 0, 'gamepad-gyro': 0, ...o });
const G = GYRO_ONLY_MIN_FRAMES;

test('defined: #100 (last), clean section, in the demo, not hidden, Steam name LOOK_NO_THUMBS', () => {
  assert.ok(ach);
  assert.equal(ACHIEVEMENTS.length, 100);
  assert.equal(ach.section, 'clean');
  assert.equal(ach.demo, true);
  assert.ok(!ach.hidden);
  assert.equal(ach.id.toUpperCase(), 'LOOK_NO_THUMBS');
});

test('a gyro-only ride earns it', () => {
  assert.equal(gyroOnlySteer(frames({ 'gamepad-gyro': G + 500 })), true);
  assert.equal(ach.condition({ finishedLevel: 'grandma', gyroOnly: true }, {}), true);
});

test('any stick / D-pad or keyboard lean disqualifies', () => {
  assert.equal(gyroOnlySteer(frames({ 'gamepad-gyro': 5000, gamepad: 1 })), false);
  assert.equal(gyroOnlySteer(frames({ 'gamepad-gyro': 5000, keyboard: 1 })), false);
});

test('phone tilt is not controller gyro', () => {
  assert.equal(gyroOnlySteer(frames({ motion: 5000 })), false);
  assert.equal(gyroOnlySteer(frames({ 'gamepad-gyro': 5000, motion: 3 })), false);
});

test('needs real gyro steering, and a finish', () => {
  assert.equal(gyroOnlySteer(frames({ 'gamepad-gyro': G - 1 })), false);
  assert.equal(gyroOnlySteer(null), false);
  assert.equal(ach.condition({ gyroOnly: true }, {}), false);
  assert.equal(ach.condition({ finishedLevel: 'grandma', gyroOnly: false }, {}), false);
});

test('co-op: each rider on this device counts on their own', () => {
  // game.js · state.gyroOnly = [P1, local P2].some(gyroOnlySteer)
  const p1Stick = frames({ 'gamepad-gyro': 4000, gamepad: 40 });
  const p2Gyro = frames({ 'gamepad-gyro': 4000 });
  assert.equal([p1Stick, p2Gyro].some(gyroOnlySteer), true);
  assert.equal([p1Stick, frames({ gamepad: 900 })].some(gyroOnlySteer), false);
});
