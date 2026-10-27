// #505 · the fit tolerances judge a report the way the viewer and the smoke expect.
import test from 'node:test';
import assert from 'node:assert/strict';
import { judge, nudgePatch, TOL, HIP_UP } from '../../js/fit/fit-rules.js';

const good = () => ({
  bike: {
    rearWheel: { inside: 0, clearance: 0.012, nearest: 'NurbsPath011_cycle_0', penetrating: [] },
    saddles: { Captain: { socketAboveMesh: 0.001 }, Stoker: { socketAboveMesh: -0.002 } },
  },
  riders: {
    Captain: { hipAboveSaddle: 0.11, seatProbe: -0.01, foot: { L: { err: 0.003, crank: 90 }, R: { err: 0.004, crank: 270 } }, hand: { L: { dist: 0.11 }, R: { dist: 0.11 } }, clothInWheel: 0 },
    Stoker: { hipAboveSaddle: 0.11, seatProbe: 0.0, foot: { L: { err: 0.002 }, R: { err: 0.002 } }, hand: { L: { dist: 0.12 }, R: { dist: 0.12 } }, clothInWheel: 21 },
  },
});

test('a clean fit passes every line', () => {
  const j = judge(good());
  assert.equal(j.pass, true);
  assert.ok(j.lines.length >= 14);
  assert.ok(j.lines.every(l => typeof l.name === 'string' && typeof l.pass === 'boolean'));
});

test('the rear end inside the tyre fails the wheel line and names the parts', () => {
  const r = good();
  r.bike.rearWheel = { inside: 1416, clearance: -0.016, nearest: 'Cylinder016_cycle_0', penetrating: [{ mesh: 'Cylinder009_cycle_0', depth: 0.010 }] };
  const j = judge(r);
  assert.equal(j.pass, false);
  const w = j.lines.find(l => /tread band/.test(l.name));
  assert.equal(w.pass, false);
  assert.match(w.note, /Cylinder009_cycle_0 10 mm/);
});

test('a goose floating above the saddle fails the seat probe; a little sink passes', () => {
  const r = good();
  r.riders.Captain.seatProbe = 0.047;
  assert.equal(judge(r).lines.find(l => /Captain · bottom over saddle/.test(l.name)).pass, false);
  r.riders.Captain.seatProbe = TOL.seatProbe.min;
  assert.equal(judge(r).lines.find(l => /Captain · bottom over saddle/.test(l.name)).pass, true);
  // the thighs wrap the nose: 11 cm into the breeches there is by nature, 15 is not
  r.riders.Captain.noseProbe = -0.11;
  assert.equal(judge(r).lines.find(l => /Captain · thighs over saddle nose/.test(l.name)).pass, true);
  r.riders.Captain.noseProbe = -0.15;
  assert.equal(judge(r).lines.find(l => /Captain · thighs over saddle nose/.test(l.name)).pass, false);
});

test('the root must sit HIP_UP above the socket, within 5 mm', () => {
  const r = good();
  r.riders.Stoker.hipAboveSaddle = HIP_UP + 0.004;
  assert.equal(judge(r).lines.find(l => /Stoker · hip joints/.test(l.name)).pass, true);
  r.riders.Stoker.hipAboveSaddle = HIP_UP + 0.006;
  assert.equal(judge(r).lines.find(l => /Stoker · hip joints/.test(l.name)).pass, false);
});

test('a foot off its pedal at any crank step fails that side', () => {
  const r = good();
  r.riders.Captain.foot.R = { err: 0.02, crank: 180 };
  const l = judge(r).lines.find(l => /Captain · R foot/.test(l.name));
  assert.equal(l.pass, false);
  assert.match(l.note, /180/);
});

test('the nudge patch carries only what moved', () => {
  assert.deepEqual(nudgePatch({ hipUp: HIP_UP, seats: { Captain: { dy: 0, dz: 0, scale: 1 } } }), {});
  assert.deepEqual(nudgePatch({ hipUp: 0.09, seats: { Stoker: { dy: -0.02, scale: 1.05, saddleDy: 0.01, saddleDz: -0.08 } } }),
    { HIP_UP: 0.09, seats: { Stoker: { dy: -0.02, scale: 1.05, saddleDy: 0.01, saddleDz: -0.08 } } });
});
