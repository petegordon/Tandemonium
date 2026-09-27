// A-2 · the beat-window co-op rule.
// The bug being fixed: two people genuinely alternating scored ~50% perfect,
// while one person pedalling alone scored 100%.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BEAT_WINDOW_S,
  createScoringState,
  classifyTap,
  applyTap,
  scoreSequence,
  perfectShare
} from '../../js/pedal-scoring.js';

const tap = (source, foot, time) => ({ source, foot, time });

test('interleaved alternating pair: every tap after the first is perfect', () => {
  // C:L, S:R, C:R, S:L … 100 ms apart — the pattern the HUD asks for.
  const explicit = [
    tap('captain', 'up', 0.0), tap('stoker', 'down', 0.1),
    tap('captain', 'down', 0.2), tap('stoker', 'up', 0.3),
    tap('captain', 'up', 0.4), tap('stoker', 'down', 0.5),
    tap('captain', 'down', 0.6), tap('stoker', 'up', 0.7)
  ];
  const kinds = scoreSequence(explicit);
  assert.deepEqual(kinds, Array(8).fill('perfect'));
  assert.equal(perfectShare(kinds), 1);
});

test('a realistic pair (0.5 s beat, 100 ms interleave) is all perfect', () => {
  const taps = [];
  let t = 0;
  let capFoot = 'up', stoFoot = 'down';
  for (let beat = 0; beat < 8; beat++) {
    taps.push(tap('captain', capFoot, t));
    taps.push(tap('stoker', stoFoot, t + 0.1));
    capFoot = capFoot === 'up' ? 'down' : 'up';
    stoFoot = stoFoot === 'up' ? 'down' : 'up';
    t += 0.5;
  }
  assert.equal(perfectShare(scoreSequence(taps)), 1);
});

test('simultaneous opposite feet is perfect', () => {
  const kinds = scoreSequence([
    tap('captain', 'up', 1.0),
    tap('stoker', 'down', 1.0)
  ]);
  assert.deepEqual(kinds, ['perfect', 'perfect']);
});

test('simultaneous same feet is a crank fight', () => {
  const kinds = scoreSequence([
    tap('captain', 'up', 1.0),
    tap('stoker', 'up', 1.02)
  ]);
  assert.deepEqual(kinds, ['solo', 'fight']);
});

test('captain alone alternating never scores perfect', () => {
  const taps = [];
  for (let i = 0; i < 10; i++) taps.push(tap('captain', i % 2 ? 'down' : 'up', i * 0.4));
  const kinds = scoreSequence(taps);
  assert.deepEqual(kinds, Array(10).fill('solo'));
  assert.equal(perfectShare(kinds), 0);
});

test('repeating your own foot is wrong', () => {
  const kinds = scoreSequence([
    tap('captain', 'up', 0),
    tap('captain', 'up', 0.4)
  ]);
  assert.deepEqual(kinds, ['solo', 'wrong']);
});

test('a partner tap outside the window is two solo strokes', () => {
  const kinds = scoreSequence([
    tap('captain', 'up', 0),
    tap('stoker', 'down', 0.3)      // 300 ms > 250 ms window
  ]);
  assert.deepEqual(kinds, ['solo', 'solo']);
});

test('the window boundary is inclusive', () => {
  assert.deepEqual(
    scoreSequence([tap('captain', 'up', 0), tap('stoker', 'down', BEAT_WINDOW_S)]),
    ['perfect', 'perfect']
  );
  assert.deepEqual(
    scoreSequence([tap('captain', 'up', 0), tap('stoker', 'down', BEAT_WINDOW_S + 0.001)]),
    ['solo', 'solo']
  );
});

test('a wrong tap does not open a beat, but an earlier good one stays open', () => {
  const kinds = scoreSequence([
    tap('captain', 'up', 0),
    tap('captain', 'up', 0.1),     // wrong: same own foot
    tap('stoker', 'down', 0.15)    // pairs with the captain's GOOD tap, not the mistake
  ]);
  assert.deepEqual(kinds, ['perfect', 'wrong', 'perfect']);
});

test('the partner cannot pair with a mistake alone', () => {
  const kinds = scoreSequence([
    tap('captain', 'up', 0),
    tap('stoker', 'down', 0.05),   // consumes the captain's open beat
    tap('captain', 'up', 0.10),    // wrong: same own foot as the last captain tap
    tap('stoker', 'up', 0.15)      // no open beat to answer -> solo, not a fight
  ]);
  assert.deepEqual(kinds, ['perfect', 'perfect', 'wrong', 'solo']);
});

test('a pair is consumed: a third tap in the window does not double-pair', () => {
  const kinds = scoreSequence([
    tap('captain', 'up', 0),
    tap('stoker', 'down', 0.05),   // pairs with the captain
    tap('captain', 'down', 0.10)   // opposite own foot, but the beat is used
  ]);
  assert.deepEqual(kinds, ['perfect', 'perfect', 'solo']);
});

test('classifyTap is pure and applyTap advances feet and times', () => {
  const s0 = createScoringState();
  const t0 = tap('captain', 'up', 5);
  const r = classifyTap(s0, t0);
  assert.equal(r.kind, 'solo');
  assert.equal(s0.captainLastFoot, null, 'classifyTap must not mutate');
  const s1 = applyTap(s0, t0, r.kind);
  assert.equal(s1.captainLastFoot, 'up');
  assert.equal(s1.captainLastTime, 5);
  assert.equal(s1.openBeat.source, 'captain');
});

test('a wider window can be passed in', () => {
  const taps = [tap('captain', 'up', 0), tap('stoker', 'down', 0.4)];
  assert.deepEqual(scoreSequence(taps, 0.5), ['perfect', 'perfect']);
});
