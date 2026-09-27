// E-2 · the road does something to the pair, and does it identically on both
// screens without a single byte crossing the wire.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  planDisruptions, disruptionAt, telegraphText, beatWindowFor,
  KIND, DURATION, TELEGRAPH_S, COBBLES_WINDOW_S,
  COUNT_BY_DIFFICULTY, START_CLEARANCE_M, CHECKPOINT_CLEARANCE_M,
  GUST_FORCE, gustEnvelope
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

// E-2 · the gust has to be a shove that arrives and passes, and it has to be
// big enough to feel. It was 0.55 lean-units/sec — about 6 degrees of lean,
// under 8% of the crash threshold and roughly the size of a phone's tilt
// deadzone. The banner said HOLD IT and there was nothing to hold.
test('the gust is strong enough to have to correct against', () => {
  assert.ok(GUST_FORCE >= 2.5, 'a gust under 2.5 is inside the input noise floor');
  assert.ok(GUST_FORCE <= 5, 'a gust over 5 stops being recoverable');
});

test('the gust ramps in and out rather than switching on', () => {
  assert.equal(gustEnvelope(0), 0);
  assert.equal(gustEnvelope(1), 0);
  assert.equal(gustEnvelope(0.5), 1, 'full strength through the middle');
  // Rising through the attack, falling through the release.
  assert.ok(gustEnvelope(0.05) < gustEnvelope(0.12));
  assert.ok(gustEnvelope(0.8) > gustEnvelope(0.95));
});

test('the envelope is bounded and never negative', () => {
  for (let p = -0.5; p <= 1.5; p += 0.01) {
    const v = gustEnvelope(p);
    assert.ok(v >= 0 && v <= 1, `envelope(${p.toFixed(2)}) = ${v}`);
  }
  assert.equal(gustEnvelope(NaN), 0);
  assert.equal(gustEnvelope(undefined), 0);
});

// The bug this fixes: a flat 40 m checkpoint clearance is wider than half the
// gap on a short course. Grandma's Cottage is 250 m with a checkpoint every
// 62 m, so every candidate position clashed, every event was dropped, and that
// level had no disruptions at all — on every seed.
test('a short course with close checkpoints still gets disruptions', () => {
  const checkpoints = [62, 124, 186, 248];
  let empty = 0;
  for (let seed = 1; seed <= 200; seed++) {
    const ev = planDisruptions({ seed, distance: 250, difficulty: 'adventurous', checkpoints });
    if (ev.length === 0) empty++;
  }
  assert.equal(empty, 0, `${empty}/200 seeds produced a ride with nothing in it`);
});

test('events still keep clear of checkpoints', () => {
  const checkpoints = [125, 250, 375];
  for (let seed = 1; seed <= 200; seed++) {
    for (const e of planDisruptions({ seed, distance: 500, difficulty: 'daredevil', checkpoints })) {
      for (const cp of checkpoints) {
        assert.ok(Math.abs(cp - e.atM) >= 20, `${e.kind}@${e.atM} sits on checkpoint ${cp}`);
      }
    }
  }
});

test('a ride shows as many different things as it has room for', () => {
  // Adventurous gets two events. Picking each independently from three kinds
  // meant a third of rides drew the same one twice — Today's Road drew gust,
  // gust, so nobody riding it could meet the cobbles at all. Whatever else the
  // schedule does, it must not hide a feature behind a coin flip.
  for (let seed = 1; seed <= 400; seed++) {
    for (const [difficulty, want] of [['adventurous', 2], ['daredevil', 3]]) {
      const events = planDisruptions({ seed, distance: 500, difficulty, checkpoints: [125, 250, 375] });
      if (events.length < want) continue;   // one was dropped for a checkpoint
      const kinds = events.map(e => e.kind);
      assert.equal(new Set(kinds).size, kinds.length,
        `seed ${seed} on ${difficulty} repeated a kind: ${kinds.join(', ')}`);
    }
  }
});

test('across many roads every kind still turns up about as often as the others', () => {
  const seen = { gust: 0, goose: 0, cobbles: 0 };
  for (let seed = 1; seed <= 600; seed++) {
    for (const e of planDisruptions({ seed, distance: 500, difficulty: 'adventurous', checkpoints: [125, 250, 375] })) {
      seen[e.kind]++;
    }
  }
  const counts = Object.values(seen);
  const total = counts.reduce((a, b) => a + b, 0);
  for (const [kind, n] of Object.entries(seen)) {
    assert.ok(n > total * 0.25, `${kind} only appeared ${n} times in ${total}`);
  }
});
