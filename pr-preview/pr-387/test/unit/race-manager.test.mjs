// A-6 · nobody times out while reading the screen.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RaceManager, segmentStartsAt, GRACE_MAX_S, FIRST_SEGMENT_BONUS_S
} from '../../js/race-manager.js';

const level = { id: 'grandma', name: "Grandma's", distance: 250, checkpointInterval: 62 };

test('the clock starts at the first tap, or when the grace runs out', () => {
  assert.equal(segmentStartsAt(3.2), 3.2);
  assert.equal(segmentStartsAt(0), 0);
  assert.equal(segmentStartsAt(null), GRACE_MAX_S);
  assert.equal(segmentStartsAt(undefined), GRACE_MAX_S);
  assert.equal(segmentStartsAt(30), GRACE_MAX_S, 'grace is a cap, not a licence');
  assert.equal(segmentStartsAt(-1), GRACE_MAX_S, 'nonsense falls back to the cap');
});

test('the first segment gets the bonus on top of its budget', () => {
  const rm = new RaceManager(level);
  rm.start();
  const plain = rm._segmentBudget(62);
  assert.equal(rm.segmentTimeTotal, plain + FIRST_SEGMENT_BONUS_S);
});

test('the timer is held until the first pedal stroke', () => {
  const rm = new RaceManager(level);
  rm.start();
  const total = rm.segmentTimeTotal;
  for (let i = 0; i < 100; i++) rm.update(0, 0.05);   // 5 s of doing nothing
  assert.equal(rm.timerHeld, true);
  assert.equal(rm.segmentTimeRemaining, total, 'the clock must not have moved');

  rm.noteFirstPedal();
  rm.update(1, 1.0);
  assert.equal(rm.timerHeld, false);
  assert.ok(rm.segmentTimeRemaining < total, 'the clock must run once you ride');
});

test('the grace expires on its own after GRACE_MAX_S', () => {
  const rm = new RaceManager(level);
  rm.start();
  const total = rm.segmentTimeTotal;
  for (let i = 0; i < GRACE_MAX_S * 20 + 2; i++) rm.update(0, 0.05);
  assert.equal(rm.timerHeld, false);
  assert.ok(rm.segmentTimeRemaining < total);
});

test('a player who sits still for 8 s is not bounced', () => {
  const rm = new RaceManager(level);
  rm.start();
  for (let i = 0; i < 160; i++) {          // 8 s
    const ev = rm.update(0, 0.05);
    assert.notEqual(ev && ev.event, 'timeout');
  }
});

test('later segments have no grace', () => {
  const rm = new RaceManager(level);
  rm.start();
  rm.noteFirstPedal();
  const ev = rm.update(62, 0.05);           // cross the first checkpoint
  assert.equal(ev.event, 'checkpoint');
  assert.equal(rm.timerHeld, false);
  const total = rm.segmentTimeTotal;
  rm.update(63, 1.0);
  assert.ok(rm.segmentTimeRemaining < total);
});
