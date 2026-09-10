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

// ── the retry that was harder than the attempt it replaced ────────────────
//
// A crash or a timeout before the first checkpoint puts the bike back on the
// start line. The clock has to go back with it. It did not: resetSegmentTimer
// was only called when a checkpoint had been passed, and when it was called it
// left out the first-segment bonus — so the rider got 30 s to ride the 125 m
// they had just been given 38 s for, and a second crash made the ride
// arithmetically impossible to finish.
const dailyLevel = { id: 'daily', name: "Today's Road", distance: 500, checkpointInterval: 125 };

test('restarting the first segment restores the budget it started with', () => {
  const rm = new RaceManager(dailyLevel);
  rm.start();
  const atCountdown = rm.segmentTimeTotal;

  // Ride most of it, then crash.
  rm.update(110, 0);
  rm.segmentTimeRemaining = 4;

  rm.resetSegmentTimer(0);
  assert.equal(rm.segmentTimeTotal, atCountdown,
    'the same 125 m must be worth the same seconds every time it is ridden');
  assert.equal(rm.segmentTimeRemaining, atCountdown);
});

test('a later segment restarts on its own budget, with no first-segment bonus', () => {
  const rm = new RaceManager(dailyLevel);
  rm.start();
  const first = rm.update(125, 0);
  assert.equal(first.event, 'checkpoint');

  rm.segmentTimeRemaining = 2;
  rm.resetSegmentTimer(125);
  assert.equal(rm.segmentTimeTotal, rm._segmentBudget(125),
    'the bonus belongs to the segment people lose to confusion, not to all of them');
});

test('the budget for a restart never shrinks below what the rider first had', () => {
  // The property, stated once: for any segment, restarting it gives you no less
  // time than you were given the first time you were sent into it.
  const rm = new RaceManager(dailyLevel);
  rm.start();
  let opening = rm.segmentTimeTotal;
  for (const cp of [...rm.checkpoints, dailyLevel.distance]) {
    rm.resetSegmentTimer(cp - dailyLevel.checkpointInterval);
    assert.ok(rm.segmentTimeTotal >= opening - 1e-9,
      `restarting the segment ending at ${cp} m lost time`);
    const ev = rm.update(cp, 0);
    if (ev && ev.event === 'checkpoint') opening = rm.segmentTimeTotal;
  }
});
