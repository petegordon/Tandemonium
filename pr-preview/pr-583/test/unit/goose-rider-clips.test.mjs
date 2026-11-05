// The goose riders' clip contract: which bones each clip drives, lean weights, crank -> clip time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { trackBone, isUpperBone, isLowerBone, boneFilterFor, leanWeights, turnTime, seatOffset, HIP_UP }
  from '../../js/goose-rider-clips.js';

test('track names map to their bone', () => {
  assert.equal(trackBone('LeftLeg.quaternion'), 'LeftLeg');
  assert.equal(trackBone('Cloth_skirt_BL_1.scale'), 'Cloth_skirt_BL_1');
  assert.equal(trackBone('Hips'), 'Hips');
});

test('pedal clips drive legs + cloth chains only; ride/lean clips the upper body only', () => {
  const pedal = boneFilterFor('Pedal_Stoker');
  const lean = boneFilterFor('Lean_R_Captain');
  for (const b of ['LeftUpLeg', 'RightLeg', 'LeftFoot', 'RightToeBase', 'Cloth_skirt_BL_1', 'Cloth_coat_FR_3']) {
    assert.ok(pedal(b), b);
    assert.ok(!lean(b), b);
  }
  for (const b of ['Spine', 'Spine2', 'Neck3', 'Head', 'LeftArm', 'RightHand', 'RightShoulder']) {
    assert.ok(lean(b), b);
    assert.ok(!pedal(b), b);
  }
  // nobody drives the hips (the goose sits on the socket), the eyes or the beak
  for (const b of ['Hips', 'LeftEye', 'Jaw', 'Tongue', 'Tail']) {
    assert.ok(!isUpperBone(b) && !isLowerBone(b), b);
  }
  assert.equal(boneFilterFor('Ride_Captain'), isUpperBone);
  assert.equal(boneFilterFor('idle'), null);
});

test("the bike's clips keep only their own bones (uncut, WheelSpin halved the crank turn)", () => {
  const pedal = boneFilterFor('Pedal'), wheels = boneFilterFor('WheelSpin');
  for (const b of ['Crank_F', 'Crank_R', 'Pedal_FL', 'Pedal_RR']) { assert.ok(pedal(b), b); assert.ok(!wheels(b), b); }
  for (const b of ['Wheel_F', 'Wheel_R']) { assert.ok(wheels(b), b); assert.ok(!pedal(b), b); }
  for (const b of ['Bike_root', 'Steer', 'Seat_Captain', 'Grip_C_L']) { assert.ok(!pedal(b) && !wheels(b), b); }
  // a rider's Pedal_<seat> is not the bike's Pedal
  assert.ok(!boneFilterFor('Pedal_Captain')('Crank_F'));
});

test('each rider: ride fades as the lean grows, the matching side fades in, weights sum to 1', () => {
  assert.deepEqual(leanWeights(0), { ride: 1, left: 0, right: 0 });
  assert.deepEqual(leanWeights(1), { ride: 0, left: 0, right: 1 });
  assert.deepEqual(leanWeights(-1), { ride: 0, left: 1, right: 0 });
  const w = leanWeights(-0.25);
  assert.equal(w.ride, 0.75);
  assert.equal(w.left, 0.25);
  assert.equal(w.right, 0);
  for (const l of [-3, -0.6, 0.3, 0.99, 7, NaN]) {
    const v = leanWeights(l);
    assert.ok(Math.abs(v.ride + v.left + v.right - 1) < 1e-12, String(l));
  }
});

test('crank angle -> time on a one-turn clip (wraps both ways)', () => {
  assert.equal(turnTime(0, 1), 0);
  assert.equal(turnTime(Math.PI, 1), 0.5);
  assert.ok(Math.abs(turnTime(2 * Math.PI + Math.PI / 2, 1) - 0.25) < 1e-12);
  assert.ok(Math.abs(turnTime(-Math.PI / 2, 2) - 1.5) < 1e-12);
  assert.equal(turnTime(1, 0), 0);
  assert.equal(turnTime(NaN, 1), 0);
});

test('a goose sits with its hip joints HIP_UP above the saddle socket', () => {
  const o = seatOffset({ x: 0, y: 0.81, z: -0.025 });
  assert.ok(Math.abs(o.y - (HIP_UP - 0.81)) < 1e-12);
  assert.equal(o.z, 0.025);
  assert.equal(o.x, -0);
});
