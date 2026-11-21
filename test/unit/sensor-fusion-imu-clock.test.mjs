// #822 · gyro integration follows the controller's own clock when it has one.
//
// Reports queued behind a busy main thread arrive together, so arrival time
// says almost no time passed between them, and a stall of 100 ms or more threw
// the sample away. The Steam Controller stamps each IMU sample, so the time
// between samples is known however late they are delivered.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SensorFusion } from '../../shared/sensor-fusion.js';
import { SteamControllerDriver } from '../../shared/drivers/steam-controller-driver.js';

const GS = 2000 / 32768, DEG = 180 / Math.PI;
const TICKS_PER_MS = 934, HZ = 240, TICKS = Math.round(TICKS_PER_MS * 1000 / HZ);
const rate = (dps) => Math.round(dps / GS);

// No accelerometer: pure integration, so the angle is exactly what timing gave it.
const feed = (f, dps, nowMs, ticks, perMs = TICKS_PER_MS) =>
  f.ingest(0, rate(dps), 0, null, null, null, GS, 1 / 16384, nowMs, ticks, perMs);
const yawDeg = (f) => 2 * Math.atan2(f.orientation.y, f.orientation.w) * DEG;
const fusion = () => {
  const f = new SensorFusion();
  f._updateStillnessCalibration = () => {}; // a constant test rate is not "at rest"
  return f;
};

test('reports queued behind a stall keep their real spacing', () => {
  const f = fusion();
  let ticks = 1000;
  feed(f, 30, 1000, ticks);
  // 240 samples (1 s) all delivered within the same millisecond.
  for (let i = 0; i < 240; i++) { ticks += TICKS; feed(f, 30, 1250, ticks); }
  assert.ok(Math.abs(yawDeg(f) - 30) < 0.2, `got ${yawDeg(f).toFixed(2)} deg of 30`);
});

test('a long gap in arrival loses no motion when the samples were only delayed', () => {
  const f = fusion();
  let ticks = 1000, now = 1000;
  feed(f, 30, now, ticks);
  for (let i = 0; i < 240; i++) {
    ticks += TICKS;
    now += i % 60 === 59 ? 250 : 0.1; // a 250 ms stall every quarter second of samples
    feed(f, 30, now, ticks);
  }
  assert.ok(Math.abs(yawDeg(f) - 30) < 0.2, `got ${yawDeg(f).toFixed(2)} deg of 30`);
});

test('the uint32 timestamp wrap is one normal step', () => {
  const f = fusion();
  let ticks = 0xFFFFFFFF - TICKS * 5, now = 1000;
  feed(f, 30, now, ticks);
  for (let i = 0; i < 24; i++) { ticks = (ticks + TICKS) >>> 0; now += 4; feed(f, 30, now, ticks); }
  assert.ok(ticks < TICKS * 24, 'the test crossed the wrap');
  assert.ok(Math.abs(yawDeg(f) - 3) < 0.05, `got ${yawDeg(f).toFixed(3)} deg of 3`);
});

test('a report repeating the last IMU sample adds nothing', () => {
  const f = fusion();
  feed(f, 30, 1000, 5000);
  feed(f, 30, 1004, 5000 + TICKS);
  const before = yawDeg(f);
  feed(f, 30, 1008, 5000 + TICKS);
  assert.equal(yawDeg(f), before);
});

test('a real gap in the device clock is still dropped, and timing recovers', () => {
  const f = fusion();
  feed(f, 30, 1000, 1000);
  feed(f, 30, 1200, 1000 + TICKS_PER_MS * 200); // 200 ms of samples never arrived
  assert.equal(yawDeg(f), 0);
  feed(f, 30, 1204, 1000 + TICKS_PER_MS * 200 + TICKS);
  assert.ok(yawDeg(f) > 0);
});

test('a controller with no clock still integrates on arrival time', () => {
  const f = fusion();
  let now = 1000;
  f.ingest(0, rate(30), 0, null, null, null, GS, 1 / 8192, now);
  for (let i = 0; i < 250; i++) { now += 4; f.ingest(0, rate(30), 0, null, null, null, GS, 1 / 8192, now); }
  assert.ok(Math.abs(yawDeg(f) - 30) < 0.1, `got ${yawDeg(f).toFixed(2)} deg of 30`);
});

test('reset() forgets the last device timestamp', () => {
  const f = fusion();
  feed(f, 30, 1000, 1000);
  feed(f, 30, 1004, 1000 + TICKS);
  f.reset();
  feed(f, 30, 2000, 50);          // first sample after a reset only sets the clock
  assert.equal(yawDeg(f), 0);
  feed(f, 30, 2004, 50 + TICKS);
  assert.ok(Math.abs(yawDeg(f) - 30 * TICKS / TICKS_PER_MS / 1000) < 0.01);
});

test('the Steam Controller driver reports its IMU clock', () => {
  const buf = new DataView(new ArrayBuffer(53));
  buf.setUint32(29, 0xDEADBEEF, true);
  const parsed = new SteamControllerDriver().parseReport(0x45, buf);
  assert.equal(parsed.imuTicks, 0xDEADBEEF);
  assert.equal(parsed.imuTicksPerMs, TICKS_PER_MS);
});

test('the manager hands the IMU clock to the fusion', () => {
  const src = readFileSync(new URL('../../shared/manager.js', import.meta.url), 'utf8');
  assert.match(src, /performance\.now\(\),\s+parsed\.imuTicks,\s+parsed\.imuTicksPerMs,\s+\);/);
});
