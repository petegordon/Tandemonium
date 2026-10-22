// #403 · the helping hand's schedule: per-checkpoint failures → what eases.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  helpingHandFor, helpTier, HELP_TIER1_AFTER, HELP_TIER2_AFTER, HELP_SKIP_AFTER, SKIP_LABEL
} from '../../js/helping-hand.js';
import { DDAManager, DDA_SKIP_AFTER } from '../../js/dda-manager.js';

test('thresholds: ease on the 4th attempt, more on the 5th, skip after the 5th failure', () => {
  assert.equal(HELP_TIER1_AFTER, 3);
  assert.equal(HELP_TIER2_AFTER, 4);
  assert.equal(HELP_SKIP_AFTER, 5);
  assert.equal(DDA_SKIP_AFTER, HELP_SKIP_AFTER, 'the DDA offers SKIP on the same schedule');
});

test('attempts 1-3 ride the road as designed', () => {
  for (const f of [0, 1, 2]) {
    const h = helpingHandFor(f);
    assert.equal(h.tier, 0, `failures ${f}`);
    assert.equal(h.gustScale, 1);
    assert.equal(h.timeScale, 1);
    assert.equal(h.safety, false);
    assert.equal(h.offerSkip, false);
    assert.equal(h.label, '');
  }
});

test('attempt 4: Lady Victoria — half gusts, +25 % time, safety untouched', () => {
  const h = helpingHandFor(3);
  assert.equal(h.tier, 1);
  assert.equal(h.gustScale, 0.5);
  assert.equal(h.timeScale, 1.25);
  assert.equal(h.safety, false);
  assert.equal(h.offerSkip, false);
  assert.equal(h.icon, '💨');
  assert.equal(h.label, '💨 Lady Victoria sends a tailwind');
});

test('attempt 5: Sir Winston — no gusts, +50 % time, safety on', () => {
  const h = helpingHandFor(4);
  assert.equal(h.tier, 2);
  assert.equal(h.gustScale, 0);
  assert.equal(h.timeScale, 1.5);
  assert.equal(h.safety, true);
  assert.equal(h.offerSkip, false, 'skip comes after the 5th failure, not the 4th');
  assert.equal(h.icon, '🎩');
  assert.equal(h.label, '🎩 Sir Winston clears the road');
});

test('after 5 failures the Royal Shortcut is offered, and it stays offered', () => {
  for (const f of [5, 6, 12]) {
    const h = helpingHandFor(f);
    assert.equal(h.tier, 2);
    assert.equal(h.offerSkip, true);
    assert.equal(h.skipLabel, SKIP_LABEL);
  }
  assert.equal(SKIP_LABEL, '👑 Take the Royal Shortcut');
});

test('junk input is treated as no failures; helpTier clamps', () => {
  for (const f of [undefined, null, NaN, -3, 'x']) assert.equal(helpingHandFor(f).tier, 0);
  assert.equal(helpTier(7), 2);
  assert.equal(helpTier(-1), 0);
  assert.equal(helpTier(1), 1);
});

test('the DDA counts per checkpoint and offers SKIP on every failure from the 5th', () => {
  const dda = new DDAManager('adventurous');
  for (let i = 0; i < 4; i++) dda.recordFailure(125);
  assert.equal(dda.evaluate(125).offerSkip, false);
  dda.recordFailure(125);
  assert.equal(dda.evaluate(125).offerSkip, true);
  dda.markSkipOffered();
  dda.recordFailure(125);
  assert.equal(dda.evaluate(125).offerSkip, true, 'still offered on the 6th failure');
  assert.equal(dda.getFailureCount(250), 0, 'another checkpoint has its own count');
});

test('passing the checkpoint resets its count', () => {
  const dda = new DDAManager('adventurous');
  for (let i = 0; i < 4; i++) dda.recordFailure(125);
  assert.equal(helpingHandFor(dda.getFailureCount(125)).tier, 2);
  dda.onCheckpointPassed(250);
  assert.equal(dda.getFailureCount(125), 0);
  assert.equal(helpingHandFor(dda.getFailureCount(250)).tier, 0);
});
