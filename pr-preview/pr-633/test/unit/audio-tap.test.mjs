// A-3 · the one pure bit of the tap feel: cadence -> pitch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tapPitch } from '../../js/audio-engine.js';

test('pitch rises with cadence across the whole range', () => {
  assert.equal(tapPitch(0.5), 180);
  assert.equal(Math.round(tapPitch(8)), 560);
  assert.ok(tapPitch(1) > tapPitch(0.75));
  assert.ok(tapPitch(1.5) > tapPitch(1));
  // The half of the range mobile actually lives in has to be audible too —
  // this is what the old 0.5-2 Hz mapping flattened into a single pitch.
  assert.ok(tapPitch(4) > tapPitch(2) + 50, 'a phone cadence is distinguishable');
  assert.ok(tapPitch(8) > tapPitch(4) + 50);
});

test('a keyboard rider hears what they always heard', () => {
  // The bottom of the curve is deliberately unchanged in feel: the old linear
  // mapping put 0.5 Hz at 180 Hz and 2 Hz at 320 Hz.
  assert.equal(tapPitch(0.5), 180);
  assert.ok(Math.abs(tapPitch(2) - 320) < 5);
});

test('pitch is clamped outside the range', () => {
  assert.equal(tapPitch(0), 180);
  assert.equal(tapPitch(-5), 180);
  assert.equal(tapPitch(12), tapPitch(8));
  assert.equal(tapPitch(1e6), tapPitch(8));
});

test('nonsense cadence falls back to the middle of the range', () => {
  assert.equal(tapPitch(undefined), tapPitch(1));
  assert.equal(tapPitch(NaN), tapPitch(1));
  assert.equal(tapPitch(Infinity), tapPitch(1));
});

test('equal ratios of cadence are equal musical intervals', () => {
  // The mapping is logarithmic in both axes, so every doubling of cadence is
  // the same interval. This is what keeps the curve readable by ear.
  const a = tapPitch(2) / tapPitch(1);
  const b = tapPitch(4) / tapPitch(2);
  assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);
});

// The reported bug: on a phone, tapping faster made the pitch JUMP DOWN. The
// call site guarded with `gap > 0.05` and fell back to cadence 1 below that, so
// a fast thumb roll landed back in the middle of the range. This mirrors the
// formula in game.js (_playPedalTaps) so the discontinuity cannot come back.
const cadenceFromGap = (gap) => (gap > 0 && gap < 4 ? 1 / gap : 1);

test('pitch never falls as the gap between taps shrinks', () => {
  const gaps = [3.5, 2, 1, 0.8, 0.5, 0.35, 0.25, 0.2, 0.15, 0.125,
                0.1, 0.08, 0.06, 0.05, 0.04, 0.03, 0.02, 0.01];
  let prev = -Infinity;
  for (const gap of gaps) {
    const pitch = tapPitch(cadenceFromGap(gap));
    assert.ok(pitch >= prev, `gap ${gap}s dropped the pitch: ${pitch} < ${prev}`);
    prev = pitch;
  }
});

test('the old 50 ms cliff is gone', () => {
  // 0.06 s and 0.04 s are both far past the ceiling; they must agree, not
  // straddle a 100 Hz drop the way they used to.
  assert.equal(tapPitch(cadenceFromGap(0.06)), tapPitch(cadenceFromGap(0.04)));
});
