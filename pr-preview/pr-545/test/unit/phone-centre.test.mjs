// #531 · phone tilt's centre comes from a still phone, and a ride's countdown
// takes it again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { InputManager } from '../../js/input-manager.js';

/** A bare InputManager whose phone tilt has not been centred yet. */
function phone(extra = {}) {
  const im = Object.create(InputManager.prototype);
  Object.assign(im, {
    motionEnabled: true, rawGamma: 0, motionOffset: null, _calibrating: false, _warmupCount: 0, _calibBuf: [],
    _driftEma: null, _driftRate: 0.015, _driftWindowK: 0.005,
    _smoothedLean: 0, _prevLeanRaw: 0, motionLean: 0, motionLeanVisual: 0,
    bikeSpeed: 0, bikeMaxSpeed: 12, _lastApplyTiltTime: 0, _remoteTilt: false,
  }, extra);
  Object.defineProperty(im, 'gyroConnected', { value: !!extra.__gyro, configurable: true });
  return im;
}
const feed = (im, samples, isGyro = false) => { for (const d of samples) im._applyTilt(d, isGyro); };

test('a still phone is centred where it is held', () => {
  const im = phone();
  feed(im, Array(15).fill(12));
  assert.equal(im._calibrating, false);
  assert.equal(im.motionOffset, 12);
});

test('turning the phone over while it pairs does not become the centre', () => {
  const im = phone();
  // warm-up, then waving between -30° and +35°, then held level
  feed(im, [0, 0, 0, 0, 0]);
  feed(im, [-30, 35, -20, 30, 10, -25, 35, 0, 20, -10]);
  assert.equal(im._calibrating, true, 'no centre from a moving phone');
  feed(im, Array(10).fill(1));
  assert.equal(im._calibrating, false);
  assert.ok(Math.abs(im.motionOffset - 1) < 1e-9, `centre ${im.motionOffset}`);
});

test('a slant held then levelled: the centre is the level hold, not the mix', () => {
  const im = phone();
  feed(im, [0, 0, 0, 0, 0]);
  feed(im, [18, 18, 18, 17, 9, 4, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(im._calibrating, false);
  assert.ok(Math.abs(im.motionOffset) <= 4, `centre ${im.motionOffset} (the old average would be ~6)`);
});

test('a hand that never steadies still gets a centre (median) after 60 samples', () => {
  const im = phone();
  feed(im, [0, 0, 0, 0, 0]);
  const shaky = Array.from({ length: 60 }, (_, i) => (i % 2 ? 6 : -6) + (i % 3));
  feed(im, shaky);
  assert.equal(im._calibrating, false);
  assert.ok(Math.abs(im.motionOffset) <= 6, `centre ${im.motionOffset}`);
});

test('gyro centring is unchanged: the first 10 samples, moving or not', () => {
  const im = phone({ __gyro: true });
  feed(im, [0, 0, 0, 0, 0], true);
  feed(im, [-10, 10, -10, 10, -10, 10, -10, 10, -10, 10], true);
  assert.equal(im._calibrating, false);
  assert.equal(im.motionOffset, 0);
});

test('ride start re-centres phone tilt (local or remote) and not controller gyro', () => {
  const local = phone({ motionOffset: 15 });
  assert.equal(local.recenterTiltForRide(), true);
  assert.equal(local._calibrating, true);
  assert.equal(local.motionLean, 0);
  feed(local, Array(10).fill(-2));
  assert.equal(local.motionOffset, -2);

  const remote = phone({ motionOffset: 15, motionEnabled: false, _remoteTilt: true });
  assert.equal(remote.recenterTiltForRide(), true);

  const gyro = phone({ motionOffset: 3, __gyro: true });
  assert.equal(gyro.recenterTiltForRide(), false);
  assert.equal(gyro._calibrating, false);

  const off = phone({ motionOffset: 3, motionEnabled: false });
  assert.equal(off.recenterTiltForRide(), false, 'no tilt steering: nothing to re-centre');
});
