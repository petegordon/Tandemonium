// #805 · on desktop a clip saved more than 20 s into a recording could not be opened: the rolling buffer
// dropped the chunk that holds the file header. The recordings now take turns, overlapping.
import test from 'node:test';
import assert from 'node:assert/strict';

// game-recorder.js touches navigator/window at import time: give it just enough of a browser.
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node', platform: 'node', maxTouchPoints: 0 }, configurable: true });
globalThis.window ??= { location: { search: '' }, addEventListener() {} };
globalThis.document ??= { getElementById: () => null, createElement: () => ({ getContext: () => null, style: {} }) };
globalThis.Image ??= class { };

const { rollStep, ROLL_MAX_SECONDS, ROLL_OVERLAP_SECONDS } = await import('../../js/game-recorder.js');

test('the next recording starts an overlap before the current one ends, and then takes over', () => {
  assert.equal(rollStep(0, false), null);
  assert.equal(rollStep(ROLL_MAX_SECONDS - ROLL_OVERLAP_SECONDS - 0.5, false), null);
  assert.equal(rollStep(ROLL_MAX_SECONDS - ROLL_OVERLAP_SECONDS, false), 'start-next');
  assert.equal(rollStep(ROLL_MAX_SECONDS - 1, true), null, "both run through the overlap");
  assert.equal(rollStep(ROLL_MAX_SECONDS, true), 'promote');
  assert.equal(rollStep(ROLL_MAX_SECONDS + 30, false), 'start-next', 'a missed start is made up');
  assert.equal(rollStep(NaN, false), null);
});

test('over a long ride the clip on hand is always a whole file between the overlap and the maximum long', () => {
  // simulate the turn-taking second by second for ten minutes
  let cur = 0, next = null, shortest = Infinity, longest = 0;
  for (let t = 1; t <= 600; t++) {
    const step = rollStep(t - cur, next !== null);
    if (step === 'start-next') next = t;
    else if (step === 'promote') { cur = next; next = null; }
    const have = t - cur;
    if (t >= ROLL_OVERLAP_SECONDS) shortest = Math.min(shortest, have);
    longest = Math.max(longest, have);
  }
  assert.ok(shortest >= ROLL_OVERLAP_SECONDS, "never less than the overlap (" + shortest + " s)");
  assert.ok(longest <= ROLL_MAX_SECONDS, "never more than the maximum (" + longest + " s)");
});
