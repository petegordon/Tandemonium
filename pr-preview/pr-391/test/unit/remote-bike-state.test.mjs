// #390 · the stoker's view of the captain's bike: a jitter buffer on the
// captain's clock with extrapolation, instead of a two-sample lerp that froze
// on every late packet and skipped on every bunched pair.
import test from 'node:test';
import assert from 'node:assert/strict';

let clock = 0; // ms, drives performance.now() for the module under test
const realNow = performance.now.bind(performance);
performance.now = () => clock;
const { RemoteBikeState } = await import('../../js/remote-bike-state.js');
test.after(() => { performance.now = realNow; });

function rng(seed) { return () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32; }

const SPEED = 8; // m/s
function snap(sendMs, withTime = true) {
  const x = SPEED * sendMs / 1000;
  const s = { x, y: 0, z: 0, heading: 0, lean: 0, leanVelocity: 0, speed: SPEED,
    crankAngle: 0, distanceTraveled: x, roadD: x, flags: 0 };
  if (withTime) s.sendTime = Math.floor(sendMs) >>> 0;
  return s;
}

/** Ride 20 s: 30 Hz sends on an uneven 60 fps cadence, jitter + loss. */
function ride({ jitter, loss, seed }) {
  const r = rng(seed);
  const rbs = new RemoteBikeState();
  const events = [];
  let t = 0;
  for (let i = 0; i < 600; i++) {
    t += r() < 0.5 ? 33.3 : (r() < 0.5 ? 16.7 : 50);
    if (r() < loss) continue;
    events.push({ at: t + 40 + (r() < 0.1 ? r() * jitter * 3 : r() * jitter), st: t });
  }
  events.sort((a, b) => a.at - b.at);
  const ideal = SPEED / 60;
  let ei = 0, prev = null, freezes = 0, maxStep = 0, errSq = 0, n = 0;
  for (clock = 0; clock < 19000; clock += 1000 / 60) {
    while (ei < events.length && events[ei].at <= clock) rbs.pushState(snap(events[ei++].st));
    const o = rbs.getInterpolated();
    if (!o || clock < 2000) { prev = o ? o.x : null; continue; }
    const d = o.x - prev;
    prev = o.x;
    if (Math.abs(d) < 1e-9) freezes++;
    maxStep = Math.max(maxStep, Math.abs(d) / ideal);
    errSq += ((d - ideal) / ideal) ** 2; n++;
  }
  return { freezes, maxStep, rms: Math.sqrt(errSq / n) };
}

test('motion stays smooth through phone-grade jitter and loss', () => {
  for (const cfg of [{ jitter: 15, loss: 0 }, { jitter: 60, loss: 0.02 }, { jitter: 120, loss: 0.05 }]) {
    const r = ride({ ...cfg, seed: 7 });
    assert.equal(r.freezes, 0, `freezes at ${JSON.stringify(cfg)}`);
    assert.ok(r.maxStep < 2, `max step ${r.maxStep.toFixed(2)}x at ${JSON.stringify(cfg)}`);
    assert.ok(r.rms < 0.25, `rms step error ${r.rms.toFixed(2)} at ${JSON.stringify(cfg)}`);
  }
});

test('late and duplicate packets are dropped by send time', () => {
  clock = 1000;
  const rbs = new RemoteBikeState();
  rbs.pushState(snap(100));
  rbs.pushState(snap(133));
  rbs.pushState(snap(116)); // arrived out of order
  rbs.pushState(snap(133)); // duplicate
  assert.equal(rbs._buf.length, 2);
});

test('a restarted captain clock resets the buffer instead of freezing', () => {
  clock = 1000;
  const rbs = new RemoteBikeState();
  rbs.pushState(snap(900000));
  rbs.pushState(snap(900033));
  rbs.pushState(snap(50)); // captain reloaded: performance.now() started over
  assert.equal(rbs._buf.length, 1);
  assert.equal(rbs._buf[0].sendTime, 50);
});

test('a stall extrapolates briefly, then holds', () => {
  clock = 0;
  const rbs = new RemoteBikeState();
  for (let t = 0; t <= 1000; t += 33) { clock = t + 50; rbs.pushState(snap(t)); rbs.getInterpolated(); }
  const lastX = SPEED * 0.99;
  clock += 100;
  const a = rbs.getInterpolated().x;
  clock += 2000;
  const b = rbs.getInterpolated().x;
  clock += 1000;
  const c = rbs.getInterpolated().x;
  assert.ok(a > lastX - 1, 'still moving shortly after the stall');
  assert.ok(b <= lastX + SPEED * 0.25 + 0.01, `held within 250 ms of travel, got ${b - lastX}`);
  assert.equal(b, c, 'holds once the extrapolation budget is spent');
});

test('legacy senders without a send time still render', () => {
  clock = 0;
  const rbs = new RemoteBikeState();
  for (let t = 0; t <= 500; t += 33) { clock = t; rbs.pushState(snap(t, false)); }
  clock += 100;
  const o = rbs.getInterpolated();
  assert.ok(o && o.x > 0);
});

test('pushState reports whether the packet was kept', () => {
  clock = 1000;
  const rbs = new RemoteBikeState();
  assert.equal(rbs.pushState(snap(100)), true);
  assert.equal(rbs.pushState(snap(133)), true);
  assert.equal(rbs.pushState(snap(116)), false);
});
