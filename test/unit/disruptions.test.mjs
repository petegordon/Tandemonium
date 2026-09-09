// E-2 · the road does something to the pair, and does it identically on both
// screens without a single byte crossing the wire.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  planDisruptions, disruptionAt, telegraphText, beatWindowFor,
  KIND, DURATION, TELEGRAPH_S, COBBLES_WINDOW_S,
  COUNT_BY_DIFFICULTY, START_CLEARANCE_M, CHECKPOINT_CLEARANCE_M
} from '../../js/disruptions.js';

const ride = (over = {}) => ({
  seed: 123456, distance: 500, difficulty: 'adventurous',
  checkpoints: [125, 250, 375], ...over
});

test('the same seed plans the same ride on both screens', () => {
  const a = planDisruptions(ride());
  const b = planDisruptions(ride());
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, planDisruptions(ride({ seed: 999 })));
});

test('each difficulty gets the number of events it should', () => {
  assert.equal(planDisruptions(ride({ difficulty: 'chill' })).length, 0,
    'Chill promises nothing will happen to you');
  assert.equal(planDisruptions(ride({ difficulty: 'tutorial' })).length, 0);
  assert.equal(planDisruptions(ride({ difficulty: 'adventurous' })).length,
    COUNT_BY_DIFFICULTY.adventurous);
  assert.equal(planDisruptions(ride({ difficulty: 'daredevil' })).length,
    COUNT_BY_DIFFICULTY.daredevil);
});

test('nothing happens in the opening stretch', () => {
  for (const seed of [1, 7, 42, 1000, 999999]) {
    for (const e of planDisruptions(ride({ seed }))) {
      assert.ok(e.atM >= START_CLEARANCE_M, `event at ${e.atM} m is too early`);
    }
  }
});

test('nothing lands on a checkpoint', () => {
  for (const seed of [1, 7, 42, 1000, 999999, 31337]) {
    const r = ride({ seed });
    for (const e of planDisruptions(r)) {
      for (const cp of r.checkpoints) {
        assert.ok(Math.abs(cp - e.atM) >= CHECKPOINT_CLEARANCE_M,
          `event at ${e.atM} m is ${Math.abs(cp - e.atM).toFixed(1)} m from checkpoint ${cp}`);
      }
    }
  }
});

test('events are spread out, not bunched', () => {
  const events = planDisruptions(ride({ difficulty: 'daredevil' }));
  for (let i = 1; i < events.length; i++) {
    assert.ok(events[i].atM - events[i - 1].atM > 40,
      `two events ${(events[i].atM - events[i - 1].atM).toFixed(1)} m apart`);
  }
});

test('every event is telegraphed well before it lands', () => {
  for (const e of planDisruptions(ride({ difficulty: 'daredevil' }))) {
    assert.ok(e.telegraphM < e.atM, 'the warning must come first');
    // ~3 s at 8 m/s. Asserted in metres because that is what the ride uses.
    assert.ok(e.atM - e.telegraphM >= TELEGRAPH_S * 8 - 1,
      `only ${(e.atM - e.telegraphM).toFixed(1)} m of warning`);
  }
});

test('the schedule is in metres, so a slow pair and a fast pair meet the same gust', () => {
  const events = planDisruptions(ride());
  // Nothing in the plan refers to time except the durations.
  for (const e of events) {
    assert.equal(typeof e.atM, 'number');
    assert.equal(e.duration, DURATION[e.kind]);
  }
});

test('the ride reports what is happening where', () => {
  const events = [{ kind: KIND.GUST, atM: 200, telegraphM: 176, duration: 2 }];
  assert.equal(disruptionAt(events, 100), null, 'nothing yet');
  const warn = disruptionAt(events, 180);
  assert.equal(warn.phase, 'telegraph');
  assert.ok(warn.progress > 0 && warn.progress < 1);
  const now = disruptionAt(events, 205, () => 220);
  assert.equal(now.phase, 'active');
  assert.equal(disruptionAt(events, 300, () => 220), null, 'over and done');
});

test('cobbles tighten the beat window, and nothing else does', () => {
  const cobbles = { phase: 'active', event: { kind: KIND.COBBLES } };
  const gust = { phase: 'active', event: { kind: KIND.GUST } };
  const warning = { phase: 'telegraph', event: { kind: KIND.COBBLES } };
  assert.equal(beatWindowFor(cobbles, 0.25), COBBLES_WINDOW_S);
  assert.equal(beatWindowFor(gust, 0.25), 0.25);
  assert.equal(beatWindowFor(warning, 0.25), 0.25, 'the warning is not the event');
  assert.equal(beatWindowFor(null, 0.25), 0.25);
});

test('every kind has a banner that says what to do', () => {
  for (const kind of Object.values(KIND)) {
    const text = telegraphText(kind);
    assert.ok(text.length > 3, `${kind} has no banner`);
  }
  assert.match(telegraphText(KIND.GOOSE), /COAST/, 'the goose banner must say the verb');
});

test('a short ride is left alone rather than crammed', () => {
  assert.deepEqual(planDisruptions(ride({ distance: 40 })), []);
  assert.deepEqual(planDisruptions(ride({ distance: 0 })), []);
});

test('only the three kinds we built ever appear', () => {
  const kinds = new Set();
  for (let seed = 1; seed < 200; seed++) {
    for (const e of planDisruptions(ride({ seed, difficulty: 'daredevil' }))) kinds.add(e.kind);
  }
  assert.deepEqual([...kinds].sort(), Object.values(KIND).sort());
});
