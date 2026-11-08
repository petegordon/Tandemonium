// Steam playtest 2026-11-07 · hold the d-pad / left stick to run down a long
// list (the 100 achievements): one row per press, then repeat, faster and faster.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RowFocusController, REPEAT, holdRepeatStep } from '../../js/row-focus.js';

const fakeEl = () => {
  const set = new Set();
  return { classList: { add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c) } };
};
const pad = () => {
  const gp = { axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false })) };
  return { gp, input: { gamepadConnected: true, getGamepadState: () => gp } };
};
/** A linear list of `n`, a pad, and a clock the test drives frame by frame (60 Hz). */
function rig(t, n = 100, repeat = true) {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const { gp, input } = pad();
  const items = Array.from({ length: n }, fakeEl);
  const fc = new RowFocusController({ input, repeat });
  fc.setItems(items, 0);
  const run = (ms) => { for (let e = now + ms; now < e; now += 1000 / 60) fc.poll(); };
  return { gp, input, fc, run };
}

test('the curve: waits, then speeds up to the floor, then moves two rows a step', () => {
  assert.equal(REPEAT.delay, 350);
  assert.equal(holdRepeatStep(0).gap, REPEAT.first);
  assert.ok(holdRepeatStep(5).gap < holdRepeatStep(1).gap);
  assert.equal(holdRepeatStep(40).gap, REPEAT.min);
  assert.equal(holdRepeatStep(0).rows, 1);
  assert.equal(holdRepeatStep(REPEAT.burstAfter).rows, REPEAT.burst);
});

test('a tap moves one row', (t) => {
  const { gp, fc, run } = rig(t);
  gp.buttons[13].pressed = true; run(160);
  gp.buttons[13].pressed = false; run(500);
  assert.equal(fc.index, 1);
});

test('holding d-pad down runs far in 1.5 s, and releasing stops it', (t) => {
  const { gp, fc, run } = rig(t);
  gp.buttons[13].pressed = true; run(300);
  assert.equal(fc.index, 1, 'nothing repeats inside the first 350 ms');
  run(1200);
  assert.ok(fc.index >= 18, `ran to ${fc.index}`);
  gp.buttons[13].pressed = false; run(16);
  const stopped = fc.index; run(1000);
  assert.equal(fc.index, stopped);
});

test('the left stick holds the same way, and up runs back', (t) => {
  const { gp, fc, run } = rig(t);
  gp.axes[1] = 0.9; run(1500);
  const far = fc.index;
  assert.ok(far >= 18, `ran to ${far}`);
  gp.axes[1] = 0; run(100);
  gp.axes[1] = -0.9; run(1500);
  assert.ok(fc.index < far - 15, `back to ${fc.index}`);
});

test('the whole list in about two seconds', (t) => {
  const { gp, fc, run } = rig(t, 40);
  gp.buttons[13].pressed = true; run(2200);
  assert.equal(fc.index, 39);
});

test('no repeat when it is off, or for a direction already held when the list opened', (t) => {
  const off = rig(t, 100, false);
  off.gp.buttons[13].pressed = true; off.run(1500);
  assert.equal(off.fc.index, 1);

  const held = rig(t, 100, () => true);
  held.gp.buttons[13].pressed = true;
  held.fc.setItems(held.fc.items, 0);   // re-scoped with ↓ down
  held.run(1500);
  assert.equal(held.fc.index, 0);
});
