// #805 · on desktop a clip saved more than 20 s into a recording could not be opened: the rolling buffer
// dropped the chunk that holds the file header. Recordings are now started a stagger apart and the clip
// is the whole of the oldest. Pete, 2026-11-18: "Can we do the 30-40 seconds and they choose the 8 seconds?"
import test from 'node:test';
import assert from 'node:assert/strict';

// game-recorder.js touches navigator/window at import time: give it just enough of a browser.
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node', platform: 'node', maxTouchPoints: 0 }, configurable: true });
globalThis.window ??= { location: { search: '' }, addEventListener() {} };
globalThis.document ??= { getElementById: () => null, createElement: () => ({ getContext: () => null, style: {} }) };
globalThis.Image ??= class { };

const { rollPlan, ROLL_MAX_SECONDS, ROLL_STAGGER_SECONDS, ROLL_STAGGER_SECONDS_PHONE } = await import('../../js/game-recorder.js');
const { frameTimes, windowStart, GIF_SECONDS } = await import('../../js/clip-gif.js');

/** Run the turn-taking second by second; what is on hand (the oldest recording) at each second. */
function simulate(seconds, opts) {
  let gens = [0];            // start times, oldest first
  const have = [], running = [];
  for (let t = 1; t <= seconds; t++) {
    const plan = rollPlan(gens.map((s) => t - s), opts);
    if (plan.start) gens.push(t);
    if (plan.drop) gens.shift();
    have.push(t - gens[0]);
    running.push(gens.length);
  }
  return { have, running };
}

test('once a ride is 40 s old there is always 30 to 40 s of it on hand', () => {
  const { have, running } = simulate(900);
  const later = have.slice(ROLL_MAX_SECONDS);
  assert.ok(Math.min(...later) >= ROLL_MAX_SECONDS - ROLL_STAGGER_SECONDS, "never less than 30 s (" + Math.min(...later) + ")");
  assert.ok(Math.max(...have) <= ROLL_MAX_SECONDS, "never more than 40 s (" + Math.max(...have) + ")");
  assert.equal(have[19], 20, "and before that, all of the ride so far");
  assert.ok(Math.max(...running) <= 5, "with at most five recordings alive at a tick (" + Math.max(...running) + ")");
});

test('a phone runs fewer: 20 to 40 s on hand', () => {
  const { have, running } = simulate(900, { stagger: ROLL_STAGGER_SECONDS_PHONE });
  const later = have.slice(ROLL_MAX_SECONDS);
  assert.ok(Math.min(...later) >= 20 && Math.max(...have) <= ROLL_MAX_SECONDS);
  assert.ok(Math.max(...running) <= 3, String(Math.max(...running)));
});

test('the plan: start another a stagger after the newest, drop the oldest when it is full', () => {
  assert.deepEqual(rollPlan([]), { start: true, drop: false });
  assert.deepEqual(rollPlan([5]), { start: false, drop: false });
  assert.deepEqual(rollPlan([10]), { start: true, drop: false });
  assert.deepEqual(rollPlan([40, 30, 20, 10]), { start: true, drop: true });
  assert.deepEqual(rollPlan([45]), { start: true, drop: false }, "the only one is never dropped");
});

test('the GIF is the chosen 8 seconds, held inside the clip', () => {
  assert.equal(windowStart(34, GIF_SECONDS, undefined), 26, "no choice: the last 8");
  assert.equal(windowStart(34, GIF_SECONDS, 0), 0);
  assert.equal(windowStart(34, GIF_SECONDS, 12.5), 12.5);
  assert.equal(windowStart(34, GIF_SECONDS, -3), 0);
  assert.equal(windowStart(34, GIF_SECONDS, 99), 26);
  assert.equal(windowStart(5, GIF_SECONDS, 3), 0, "a clip shorter than the window starts at its start");
  const t = frameTimes(34, 8, 12, 10);
  assert.equal(t[0], 10);
  assert.ok(t[t.length - 1] < 18 && t[t.length - 1] > 17.8);
  assert.equal(t.length, 96);
  assert.equal(frameTimes(34, 8, 12)[0], 26, "as before without a choice");
});
