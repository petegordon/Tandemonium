// #364 · geese scattered per team. GeeseManager tallies each startled goose
// against the index of the bike that flushed it (the anchor index the versus
// update passes, i.e. versusRigs[i]); getDisruptedCount(i) reads one team's
// tally and getDisruptedCount() the shared total the solo/co-op screen shows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { GeeseManager } from '../../js/geese.js';

/** A bare `this` for the tally methods: no scene, no audio, no feathers. */
function fakeManager() {
  return {
    _disrupted: [0, 0, 0, 0],
    audio: null,
    _emitFeathers() {},
  };
}

const startle = GeeseManager.prototype._startle;
const count = GeeseManager.prototype.getDisruptedCount;

test('each startled goose is tallied against the bike index that flushed it', () => {
  const m = fakeManager();
  startle.call(m, {}, 1, 0, 1, 0);   // blue (anchor 0)
  startle.call(m, {}, 1, 0, 1, 1);   // red (anchor 1)
  startle.call(m, {}, 0, 1, 1, 1);
  startle.call(m, {}, 0, 1, 1, 1);
  assert.equal(count.call(m, 0), 1, 'team A (anchor 0) sees only its own');
  assert.equal(count.call(m, 1), 3, 'team B (anchor 1) sees only its own');
  assert.equal(count.call(m, 2), 0, 'an unused anchor is 0, not undefined');
});

test('no index = the shared total (solo and co-op victory screen)', () => {
  const m = fakeManager();
  startle.call(m, {}, 1, 0, 1, 0);
  startle.call(m, {}, 1, 0, 1, 1);
  startle.call(m, {}, 1, 0, 1, 1);
  assert.equal(count.call(m), 3);
  assert.equal(count.call(m, undefined), 3);
  assert.equal(count.call(m, null), 3);
});

test('a one-bike update (solo / co-op) defaults to anchor 0', () => {
  const m = fakeManager();
  startle.call(m, {}, 1, 0, 1);
  assert.deepEqual(m._disrupted, [1, 0, 0, 0]);
  assert.equal(count.call(m), count.call(m, 0));
});
