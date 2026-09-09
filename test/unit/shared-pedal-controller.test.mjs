// A-2 · the live controller, driven the way the game drives it.
// The regression this locks down: a cooperating pair must out-score, and
// out-accelerate, one rider pedalling alone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SharedPedalController } from '../../js/shared-pedal-controller.js';

// receiveTap() stamps taps with performance.now(); drive it deterministically.
function at(seconds, fn) {
  const real = performance.now;
  performance.now = () => seconds * 1000;
  try { return fn(); } finally { performance.now = real; }
}

/**
 * Ride for `beats` beats. `pair` = both riders answering each other 100 ms
 * apart; otherwise the captain pedals alone. Returns the controller plus the
 * total acceleration handed to the bike.
 */
function ride({ beats, pair, beatPeriod = 0.5 }) {
  const ctrl = new SharedPedalController();
  let t = 0;
  let capFoot = 'up', stoFoot = 'down';
  let accel = 0;
  for (let i = 0; i < beats; i++) {
    at(t, () => ctrl.receiveTap('captain', capFoot));
    accel += ctrl.update(0.016).acceleration;
    if (pair) {
      at(t + 0.1, () => ctrl.receiveTap('stoker', stoFoot));
      accel += ctrl.update(0.016).acceleration;
      stoFoot = stoFoot === 'up' ? 'down' : 'up';
    }
    // the rest of the beat passes with no taps
    ctrl.update(beatPeriod - 0.1);
    capFoot = capFoot === 'up' ? 'down' : 'up';
    t += beatPeriod;
  }
  return { ctrl, accel };
}

test('a cooperating pair reaches offsetScore >= 0.9 within 15 s', () => {
  const { ctrl } = ride({ beats: 20, pair: true });   // 20 beats x 0.5 s = 10 s
  assert.ok(ctrl.offsetScore >= 0.9, `offsetScore was ${ctrl.offsetScore.toFixed(3)}`);
});

test('one rider alone never rises above the starting offsetScore', () => {
  const { ctrl } = ride({ beats: 20, pair: false });
  assert.ok(ctrl.offsetScore <= 0.5, `offsetScore was ${ctrl.offsetScore.toFixed(3)}`);
});

test('a pair records perfect taps for both seats', () => {
  const { ctrl } = ride({ beats: 10, pair: true });
  assert.ok(ctrl.stats.captain.perfectTaps >= 9, `captain ${ctrl.stats.captain.perfectTaps}`);
  assert.ok(ctrl.stats.stoker.perfectTaps >= 9, `stoker ${ctrl.stats.stoker.perfectTaps}`);
  assert.equal(ctrl.stats.captain.wrongTaps, 0);
  assert.equal(ctrl.stats.stoker.wrongTaps, 0);
});

test('a pair on the beat out-accelerates the same rider alone, per tap', () => {
  const paired = ride({ beats: 10, pair: true });
  const alone  = ride({ beats: 10, pair: false });
  const perTapPaired = paired.accel / 20;
  const perTapAlone = alone.accel / 10;
  assert.ok(perTapPaired > perTapAlone,
    `paired ${perTapPaired.toFixed(3)} should beat alone ${perTapAlone.toFixed(3)}`);
});

test('same foot at the same moment is a crank fight, and it brakes', () => {
  const ctrl = new SharedPedalController();
  at(0, () => ctrl.receiveTap('captain', 'up'));
  ctrl.update(0.016);
  at(0.02, () => ctrl.receiveTap('stoker', 'up'));
  const r = ctrl.update(0.016);
  assert.equal(r.braking, true);
  assert.equal(r.acceleration, 0);
  assert.equal(r.wobble, 0.8);
  assert.equal(ctrl.wasBrake, true);
});

test('repeating your own foot is penalised and flagged', () => {
  const ctrl = new SharedPedalController();
  at(0, () => ctrl.receiveTap('captain', 'up'));
  ctrl.update(0.016);
  at(0.3, () => ctrl.receiveTap('captain', 'up'));
  const r = ctrl.update(0.016);
  assert.equal(ctrl.wasWrong, true);
  assert.equal(ctrl.stats.captain.wrongTaps, 1);
  assert.ok(r.wobble >= 0.5);
});

test('a solo stroke still drives the bike', () => {
  const ctrl = new SharedPedalController();
  at(0, () => ctrl.receiveTap('captain', 'up'));
  const r = ctrl.update(0.016);
  assert.ok(r.acceleration > 0.3, `accel was ${r.acceleration}`);
  assert.equal(ctrl.wasInPhase, true);
});

test('the crank advances a quarter turn per tap', () => {
  const ctrl = new SharedPedalController();
  at(0, () => ctrl.receiveTap('captain', 'up'));
  at(0.5, () => ctrl.receiveTap('captain', 'down'));
  const r = ctrl.update(0.016);
  assert.ok(Math.abs(r.crankAngle - Math.PI) < 1e-9);
});

test('tapEvents describe the last frame for the HUD and audio', () => {
  const ctrl = new SharedPedalController();
  at(0, () => ctrl.receiveTap('captain', 'up'));
  ctrl.update(0.016);
  at(0.05, () => ctrl.receiveTap('stoker', 'down'));
  ctrl.update(0.016);
  assert.deepEqual(ctrl.tapEvents.map(e => e.kind), ['perfect']);
  assert.equal(ctrl.tapEvents[0].seat, 'stoker');
  assert.equal(ctrl.lastTapKind, 'perfect');
});
