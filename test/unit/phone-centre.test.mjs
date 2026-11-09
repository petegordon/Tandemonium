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

// ── #716 · "starting a race sometimes pulls strong left" ──

test('#716 ride centre is not pulled back to the lobby pose by a stale drift average', () => {
  const im = phone();
  // In the menus: held at 10° long enough for the drift average to settle there.
  feed(im, Array(300).fill(10));
  assert.ok(Math.abs(im.motionOffset - 10) < 0.5);
  // Countdown: the player now holds the phone level.
  assert.equal(im.recenterTiltForRide(), true);
  feed(im, Array(30).fill(0));
  im.commitTiltCentre?.();   // GO
  feed(im, Array(150).fill(0));
  assert.ok(Math.abs(im.motionOffset) < 1, `centre ${im.motionOffset.toFixed(2)}° (stale drift pulls it toward 10°)`);
  assert.ok(Math.abs(im.motionLean) < 0.02, `lean ${im.motionLean}`);
});

test('#716 the centre is the grip at GO, not the tapping pose at the countdown start', () => {
  const im = phone({ motionOffset: 0 });
  assert.equal(im.recenterTiltForRide(), true);
  feed(im, Array(20).fill(10));          // still in the one-thumb tap pose
  feed(im, [8, 6, 4, 2, 1]);             // settling into the two-thumb grip
  feed(im, Array(40).fill(0.5));         // riding grip, through to GO
  assert.equal(im._calibrating, true, 'lean held at 0 until GO');
  assert.equal(im.motionLean, 0);
  im.commitTiltCentre();
  assert.equal(im._calibrating, false);
  assert.ok(Math.abs(im.motionOffset - 0.5) < 1e-9, `centre ${im.motionOffset}`);
});

test('#716 a phone still moving at GO keeps calibrating after GO until it is still', () => {
  const im = phone({ motionOffset: 0 });
  im.recenterTiltForRide();
  feed(im, [-20, 15, -10, 20, -15, 10, -20, 15, -10, 20, -15, 10]);
  im.commitTiltCentre();
  assert.equal(im._calibrating, true, 'no still window yet: no centre');
  feed(im, Array(10).fill(3));
  assert.equal(im._calibrating, false);
  assert.ok(Math.abs(im.motionOffset - 3) < 1e-9, `centre ${im.motionOffset}`);
});

test('#716 a ride centring nobody commits ends by itself', () => {
  const im = phone({ motionOffset: 0 });
  im.recenterTiltForRide();
  feed(im, Array(12).fill(4));
  im._rideCentreStart -= 7000;            // no GO for 7 s
  im._rideStillAt = performance.now();    // the still window is current
  feed(im, [4]);
  assert.equal(im._rideCentring, false);
  assert.equal(im._calibrating, false);
  assert.ok(Math.abs(im.motionOffset - 4) < 1e-9);
});

test('#716 a screen rotation re-takes the centre (lean held at 0 meanwhile)', () => {
  const im = phone();
  feed(im, Array(100).fill(12));
  assert.equal(im._calibrating, false);
  im.motionLean = 0.4; im.motionLeanVisual = 0.4; im._filteredRawTilt = 12;
  // Landscape 90 → 270: the same hold now reads as -12°.
  im._onScreenRotate();
  assert.equal(im._calibrating, true);
  assert.equal(im.motionLean, 0);
  assert.equal(im._filteredRawTilt, null);
  assert.equal(im._driftEma, null);
  feed(im, Array(10).fill(-12));
  assert.equal(im._calibrating, false);
  assert.equal(im.motionOffset, -12);
  feed(im, Array(100).fill(-12));
  assert.ok(Math.abs(im.motionLean) < 0.02, `lean ${im.motionLean}`);
});

test('#716 a rotation before the first centre does not start one early', () => {
  const im = phone();
  im._onScreenRotate();
  assert.equal(im._calibrating, false);
  assert.equal(im.motionOffset, null);
});
