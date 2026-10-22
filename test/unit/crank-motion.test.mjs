// #441 · the crank turns in a smooth circle from pedal taps.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CrankMotion } from '../../js/crank-motion.js';

const Q = Math.PI / 2;
const DT = 1 / 60;

/** Ride `seconds`, tapping every `gap` s; returns the per-frame angle steps. */
function ride(c, { seconds, gap, start = 0, raw0 = 0, coast = 0 }) {
  let raw = raw0, t = start, nextTap = start, prev = c.angle;
  const steps = [];
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    t += DT;
    if (gap && t >= nextTap) { raw += Q; nextTap += gap; }
    c.update(raw, DT, t, coast);
    steps.push(c.angle - prev);
    prev = c.angle;
  }
  return { steps, raw, t };
}

test('a press moves the crank at once (it still follows the buttons)', () => {
  const c = new CrankMotion();
  c.update(0, DT, 0);
  c.update(Q, DT, 0.1);
  for (let i = 0; i < 9; i++) c.update(Q, DT, 0.1 + DT * (i + 1));
  assert.ok(c.angle > Q * 0.5, `a quarter turn is half done within 150 ms (${c.angle.toFixed(2)})`);
});

test('steady pedaling turns smoothly: no stops, no jumps between strokes', () => {
  const c = new CrankMotion();
  const { steps } = ride(c, { seconds: 6, gap: 0.25 });
  const settled = steps.slice(Math.round(2 / DT));      // after it gets up to speed
  const min = Math.min(...settled), max = Math.max(...settled);
  assert.ok(min > 0, 'the crank never stops between strokes');
  assert.ok(max / min < 2.5, `frame-to-frame speed stays even (min ${min.toFixed(3)}, max ${max.toFixed(3)} rad)`);
});

test('the crank keeps up with the strokes: it neither lags nor runs away', () => {
  const c = new CrankMotion();
  const { raw } = ride(c, { seconds: 6, gap: 0.25 });
  assert.ok(Math.abs(c.angle - raw) < Q * 1.2, `angle ${c.angle.toFixed(2)} vs strokes ${raw.toFixed(2)}`);
});

test('faster pedaling spins it faster', () => {
  const slow = new CrankMotion(), fast = new CrankMotion();
  ride(slow, { seconds: 4, gap: 0.4 });
  ride(fast, { seconds: 4, gap: 0.15 });
  assert.ok(fast.omega > slow.omega * 2, `fast ${fast.omega.toFixed(1)} rad/s vs slow ${slow.omega.toFixed(1)} rad/s`);
});

test('when the presses stop it eases to a stop, not past one quarter turn ahead', () => {
  const c = new CrankMotion();
  const { raw, t } = ride(c, { seconds: 3, gap: 0.2 });
  const { steps } = ride(c, { seconds: 1.2, start: t, raw0: raw });
  assert.ok(c.angle <= raw + Q, 'never more than a quarter turn ahead of the strokes');
  assert.ok(steps[steps.length - 1] < 1e-3, 'it has come to rest');
  for (let i = 1; i < steps.length; i++) {
    assert.ok(steps[i] <= steps[i - 1] + 0.02, `slows down smoothly (frame ${i})`);
  }
});

test('coasting turns with the wheels, and the next press never spins it backwards', () => {
  const c = new CrankMotion();
  const { raw, t } = ride(c, { seconds: 1, gap: 0.25 });
  const coasted = ride(c, { seconds: 3, start: t, raw0: raw, coast: 6 });
  assert.ok(coasted.steps.slice(-30).every(s => s > 0.05), 'turning while coasting');
  const before = c.angle;
  const back = ride(c, { seconds: 0.5, gap: 0.25, start: coasted.t, raw0: raw });
  assert.ok(back.steps.every(s => s >= 0), 'never backwards');
  assert.ok(c.angle > before, 'and the press moves it on');
});

test('a controller reset (new ride) stops the crank where it is', () => {
  const c = new CrankMotion();
  const { t } = ride(c, { seconds: 1, gap: 0.2 });
  const at = c.angle;
  c.update(0, DT, t + DT);
  assert.equal(c.angle, at, 'no jump back to zero');
  assert.equal(c.omega, 0);
});
