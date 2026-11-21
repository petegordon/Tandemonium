// #483: the canned crash tumble starts from the lean the bike crashed at.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fallLean, FALL_EASE_S } from '../../js/crash-tumble.js';

const TARGET = Math.PI / 2.2;

test('the first frame of a fall is the impact lean, not upright', () => {
  assert.equal(fallLean(1.2, TARGET, 0), 1.2);
  assert.equal(fallLean(-0.3, -TARGET, 0), -0.3);
});

test('a lean-out crash never draws more upright than it crashed (no pop up, fall again)', () => {
  const start = 1.3;   // nearly flat already when the balance gave out
  for (let e = 0; e <= 1.2; e += 1 / 60) {
    assert.ok(fallLean(start, TARGET, e) >= start - 0.06, `upright pop at ${e.toFixed(3)} s`);
  }
});

test('lands on the fallen side within the ease, both directions', () => {
  assert.ok(Math.abs(fallLean(0.2, TARGET, FALL_EASE_S) - TARGET) < 1e-9);
  assert.ok(Math.abs(fallLean(-0.2, -TARGET, FALL_EASE_S) + TARGET) < 1e-9);
  // the bounce dies out
  assert.ok(Math.abs(fallLean(0.2, TARGET, 1.2) - TARGET) < 1e-6);
});

test('moves monotonically towards the fallen side during the ease', () => {
  let prev = fallLean(0.4, TARGET, 0);
  for (let e = 1 / 60; e <= FALL_EASE_S; e += 1 / 60) {
    const v = fallLean(0.4, TARGET, e);
    assert.ok(v >= prev - 1e-12);
    prev = v;
  }
});
