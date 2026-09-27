// D-4 · the rider you were yesterday.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GhostRecorder, GhostPlayer, ghostDeltaAt, trackBytes,
  SAMPLE_HZ, MAX_SECONDS, STRIDE
} from '../../js/ghost.js';

/** Record a straight ride at a constant speed. */
function record(seconds, speed = 5, opts) {
  const r = new GhostRecorder(opts);
  const dt = 1 / 60;
  for (let t = 0; t < seconds; t += dt) {
    r.sample(dt, { roadD: r.elapsed * speed, lateral: 0.2, lean: 0.1 });
  }
  return r.finish();
}

test('recording takes samples at the stated rate, not per frame', () => {
  const track = record(10);
  // 10 s at SAMPLE_HZ, give or take the frame the loop lands on.
  assert.ok(Math.abs(track.count - 10 * SAMPLE_HZ) <= 2, `got ${track.count} samples`);
  assert.equal(track.hz, SAMPLE_HZ);
  assert.equal(track.data.length, track.count * STRIDE);
});

test('the longest ride we keep stays inside its storage budget', () => {
  // The plan guessed 14 KB at 10 Hz; the real cost there was ~50 KB of JSON,
  // which is why the rate is 5 Hz. Six minutes now costs about 26 KB, and
  // localStorage is what actually holds it. Asserted so the number stays a
  // decision rather than becoming a surprise.
  const track = record(MAX_SECONDS, 5);
  assert.ok(trackBytes(track) <= 24000, `${trackBytes(track)} bytes in memory`);
  const json = JSON.stringify(track).length;
  assert.ok(json <= 30000, `${json} bytes as JSON`);
});

test('a normal ride is small', () => {
  const track = record(150, 4);          // 2.5 minutes on Grandma's
  assert.ok(JSON.stringify(track).length < 12000, `${JSON.stringify(track).length} bytes`);
});

test('a ride longer than the cap simply stops recording', () => {
  const track = record(MAX_SECONDS + 30, 5);
  assert.ok(track.count <= MAX_SECONDS * SAMPLE_HZ + 1);
  const player = new GhostPlayer(track);
  assert.ok(player.duration <= MAX_SECONDS + 1);
});

test('playback interpolates between samples', () => {
  const track = record(10, 5);
  const p = new GhostPlayer(track);
  const at5 = p.at(5);
  assert.ok(Math.abs(at5.roadD - 25) < 0.6, `roadD ${at5.roadD} at t=5 of a 5 m/s ride`);
  // Halfway between two samples is halfway between their values.
  const a = p.at(5.00), b = p.at(5.05), c = p.at(5.10);
  assert.ok(b.roadD > a.roadD && c.roadD > b.roadD, 'monotonic through a sample gap');
});

test('playback before the start and after the end is clamped', () => {
  const track = record(6, 5);
  const p = new GhostPlayer(track);
  const before = p.at(-3);
  assert.ok(before.roadD >= 0 && !before.finished);
  const after = p.at(999);
  assert.equal(after.finished, true, 'the ghost has finished its ride');
});

test('playing forwards does not rescan the whole track', () => {
  const track = record(60, 5);
  const p = new GhostPlayer(track);
  let last = -1;
  for (let t = 0; t < 60; t += 0.016) {
    const s = p.at(t);
    assert.ok(s.roadD >= last - 1e-6, 'road distance must not go backwards');
    last = s.roadD;
  }
});

test('a seek backwards still works', () => {
  const p = new GhostPlayer(record(30, 5));
  const late = p.at(25).roadD;
  const early = p.at(2).roadD;
  assert.ok(early < late, 'rewinding the ghost must not strand the cursor');
});

test('the delta says who reached a point first', () => {
  const track = record(20, 5);            // the ghost is at 50 m after 10 s
  assert.ok(Math.abs(ghostDeltaAt(track, 50, 10)) < 0.3, 'dead level');
  assert.ok(ghostDeltaAt(track, 50, 12) > 1.5, 'two seconds behind reads positive');
  assert.ok(ghostDeltaAt(track, 50, 8) < -1.5, 'two seconds ahead reads negative');
});

test('the delta is null past the end of the ghost ride', () => {
  const track = record(10, 5);            // never gets past ~50 m
  assert.equal(ghostDeltaAt(track, 400, 12), null);
});

test('an empty or missing track is harmless', () => {
  const p = new GhostPlayer(null);
  assert.equal(p.at(1), null);
  assert.equal(p.duration, 0);
  assert.equal(ghostDeltaAt(null, 10, 1), null);
  assert.equal(trackBytes(undefined), 0);
});

test('a track survives a JSON round trip', () => {
  const track = record(12, 6);
  const revived = JSON.parse(JSON.stringify(track));
  const a = new GhostPlayer(track).at(6);
  const b = new GhostPlayer(revived).at(6);
  assert.ok(Math.abs(a.roadD - b.roadD) < 1e-3);
});

test('the recorder can be reused between rides', () => {
  const r = new GhostRecorder();
  for (let i = 0; i < 100; i++) r.sample(1 / 60, { roadD: i, lateral: 0, lean: 0 });
  const first = r.finish().count;
  r.reset();
  assert.equal(r.count, 0);
  assert.equal(r.elapsed, 0);
  for (let i = 0; i < 100; i++) r.sample(1 / 60, { roadD: i, lateral: 0, lean: 0 });
  assert.equal(r.finish().count, first, 'a reset recorder records the same way again');
});
