// The warm-up queue works to a time budget per frame (js/gpu-warmup.js): cheap first draws share a
// frame, a slow one gets a frame to itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import { WarmQueue, FRAME_BUDGET_MS } from '../../js/gpu-warmup.js';

/** Hold the thread for about ms. */
const busy = (ms) => { const t = performance.now(); while (performance.now() - t < ms) { /* spin */ } };

test('cheap first draws share a frame; a step always runs at least one', async () => {
  const q = new WarmQueue();
  const drawn = [];
  const done = Promise.all([0, 1, 2, 3, 4, 5].map((i) => q.add(() => drawn.push(i))));
  assert.equal(q.size, 6);
  assert.equal(q.step(), 6, 'six draws that cost nothing fit one frame');
  assert.deepEqual(drawn, [0, 1, 2, 3, 4, 5], 'in order');
  await done;
  assert.equal(q.step(), 0, 'nothing left');
  assert.ok(FRAME_BUDGET_MS > 0 && FRAME_BUDGET_MS <= 8, 'a few milliseconds, well inside a frame');
});

test('a slow first draw ends the frame: the rest wait for the next', () => {
  const q = new WarmQueue();
  const drawn = [];
  q.add(() => { drawn.push('slow'); busy(12); });
  q.add(() => drawn.push('a'));
  q.add(() => drawn.push('b'));
  assert.equal(q.step(5), 1, 'the slow one alone');
  assert.deepEqual(drawn, ['slow']);
  assert.equal(q.step(5), 2, 'then the cheap ones together');
  assert.deepEqual(drawn, ['slow', 'a', 'b']);
});

test('a draw that throws still lets its waiter go, and the queue carry on', async () => {
  const q = new WarmQueue();
  let after = false;
  const bad = q.add(() => { throw new Error('lost context'); });
  const good = q.add(() => { after = true; });
  q.step();
  await bad; await good;
  assert.equal(after, true);
  const waiting = q.add(() => {});
  q.flush();   // (its loop stopped)
  await waiting;
  assert.equal(q.size, 0);
});
