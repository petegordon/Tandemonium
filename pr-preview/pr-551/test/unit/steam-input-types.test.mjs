// Steam Input fixes from #472: the numeric DualSense type, and Steam motion
// fed across long frames.
import test from 'node:test';
import assert from 'node:assert/strict';
import { InputManager, isDualSenseSteamType } from '../../js/input-manager.js';

test('isDualSenseSteamType: the numeric enum and the names', () => {
  assert.equal(isDualSenseSteamType('13'), true, 'main.js sends the number');
  assert.equal(isDualSenseSteamType(13), true);
  assert.equal(isDualSenseSteamType('PS5Controller'), true);
  assert.equal(isDualSenseSteamType('k_ESteamInputType_PS5Controller'), true);
  assert.equal(isDualSenseSteamType('5'), false, 'PS4Controller');
  assert.equal(isDualSenseSteamType('14'), false, 'Steam Deck / Puck');
  assert.equal(isDualSenseSteamType(null), false);
});

/** A fusion stand-in that records each ingest's timestamp. */
function fakeFusion(lastGyroTime) {
  const times = [];
  return { times, _lastGyroTime: lastGyroTime, ingest(...a) { times.push(a[8]); this._lastGyroTime = a[8]; } };
}
const motion = { rotVel: [0, 0, 100], accel: [0, 16384, 0], rotQuat: [0, 0, 0, 1] };

// performance.now() counts from process start; the long-gap cases below need a
// clock that has run past them (a 0 time means "no sample yet" to the fusion).
test.before(async () => { while (performance.now() < 1200) await new Promise((r) => setTimeout(r, 50)); });

test('Steam motion: a normal frame feeds one sample', () => {
  const now = performance.now();
  const f = fakeFusion(now - 16);
  InputManager.prototype._ingestSteamMotion.call({}, f, motion);
  assert.equal(f.times.length, 1);
});

test('Steam motion: a 250 ms frame is fed in steps under the fusion gate', () => {
  const now = performance.now();
  const f = fakeFusion(now - 250);
  InputManager.prototype._ingestSteamMotion.call({}, f, motion);
  assert.ok(f.times.length >= 5, `fed ${f.times.length} times`);
  const steps = f.times.map((t, i) => t - (i ? f.times[i - 1] : now - 250));
  assert.ok(steps.every((d) => d > 0 && d < 100), `every step under 100 ms: ${steps.map((d) => d.toFixed(0))}`);
});

test('Steam motion: a gap over a second is a pause, not stepped', () => {
  const now = performance.now();
  const f = fakeFusion(now - 3000);
  InputManager.prototype._ingestSteamMotion.call({}, f, motion);
  assert.equal(f.times.length, 1);
});
