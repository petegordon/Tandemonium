// A-3 · the one pure bit of the tap feel: cadence -> pitch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tapPitch } from '../../js/audio-engine.js';

test('pitch rises with cadence between 0.5 and 2 Hz', () => {
  assert.equal(tapPitch(0.5), 180);
  assert.equal(tapPitch(2), 320);
  assert.ok(tapPitch(1) > tapPitch(0.75));
  assert.ok(tapPitch(1.5) > tapPitch(1));
});

test('pitch is clamped outside the musical range', () => {
  assert.equal(tapPitch(0), 180);
  assert.equal(tapPitch(-5), 180);
  assert.equal(tapPitch(12), 320);
});

test('nonsense cadence falls back to the middle of the range', () => {
  assert.equal(tapPitch(undefined), tapPitch(1));
  assert.equal(tapPitch(NaN), tapPitch(1));
});
