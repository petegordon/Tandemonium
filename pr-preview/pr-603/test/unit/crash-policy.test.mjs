// B-2 · a crash is a beat, not a menu — except when the player is stuck.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decideAfterCrash, countCrash, STUCK_AFTER_CRASHES } from '../../js/crash-policy.js';

test('the first two crashes in a segment go straight back to riding', () => {
  assert.equal(decideAfterCrash({ crashesThisSegment: 1 }).action, 'resume');
  assert.equal(decideAfterCrash({ crashesThisSegment: 2 }).action, 'resume');
});

test('the third crash in a segment offers help', () => {
  const d = decideAfterCrash({ crashesThisSegment: STUCK_AFTER_CRASHES });
  assert.equal(d.action, 'modal');
  assert.equal(d.reason, 'stuck');
});

test('a ranked run ends on any crash', () => {
  assert.equal(decideAfterCrash({ crashesThisSegment: 1, rankedRun: true }).reason, 'ranked');
});

test('a finished ride always shows the result', () => {
  assert.equal(decideAfterCrash({ crashesThisSegment: 1, rideOver: true }).reason, 'ride-over');
});

test('crossing a checkpoint forgives the crashes behind you', () => {
  let s = { segmentKey: 0, crashes: 0 };
  s = countCrash(s, 0); assert.equal(s.crashes, 1);
  s = countCrash(s, 0); assert.equal(s.crashes, 2);
  s = countCrash(s, 1); assert.equal(s.crashes, 1, 'new segment, fresh count');
  assert.equal(decideAfterCrash({ crashesThisSegment: s.crashes }).action, 'resume');
});

test('three crashes on the same stretch, then a checkpoint, then a resume', () => {
  let s = { segmentKey: 2, crashes: 0 };
  for (let i = 0; i < 3; i++) s = countCrash(s, 2);
  assert.equal(decideAfterCrash({ crashesThisSegment: s.crashes }).action, 'modal');
  s = countCrash(s, 3);
  assert.equal(decideAfterCrash({ crashesThisSegment: s.crashes }).action, 'resume');
});
