// #399 · forgiving steering. 5 of 5 playtesters found lean/steer too
// sensitive and one quit, so the defaults moved to the gentle end. These tests
// pin the stick response curve's shape and that each default is what its
// comment in js/config.js / js/dda-manager.js says it is.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BALANCE_DEFAULTS, TUNE, TUNING_BASE, TUNING_KEYS, stickResponse, applySteeringFeel, setTuningBase, migrateSavedTuning } from '../../js/config.js';
import { DDAManager, DDA_ASSIST_AFTER, DDA_SILENT_ADJUST_AFTER, DDA_SKIP_AFTER } from '../../js/dda-manager.js';

test('stick: inside the dead zone steers nothing', () => {
  for (const x of [0, 0.05, 0.08, 0.1, 0.149, -0.149, -0.1]) {
    assert.equal(stickResponse(x), 0, `x=${x}`);
  }
  assert.equal(stickResponse(0.15), 0, 'the dead-zone edge is still zero, no jump');
  assert.equal(stickResponse(NaN), 0);
  assert.equal(stickResponse(undefined), 0);
});

test('stick: full deflection is still a full lean', () => {
  assert.equal(stickResponse(1), 1);
  assert.equal(stickResponse(-1), -1);
  // pads can overshoot slightly past ±1
  assert.equal(stickResponse(1.02), 1);
  assert.equal(stickResponse(-1.02), -1);
});

test('stick: monotonic, odd-symmetric, and below linear in between', () => {
  let prev = 0;
  for (let i = 0; i <= 200; i++) {
    const x = i / 200;
    const y = stickResponse(x);
    assert.ok(y >= prev, `not monotonic at x=${x}`);
    assert.equal(stickResponse(-x), y === 0 ? 0 : -y, `not symmetric at x=${x}`);
    if (x > 0.15 && x < 1) assert.ok(y < x, `curve should be gentler than linear at x=${x}`);
    prev = y;
  }
  // a light thumb (30% deflection) barely steers
  assert.ok(stickResponse(0.3) < 0.05, `0.3 → ${stickResponse(0.3)}`);
  // half deflection is clearly less than half a lean
  assert.ok(stickResponse(0.5) < 0.25, `0.5 → ${stickResponse(0.5)}`);
});

test('stick: the curve matches sign(x)·t^1.8 with t rescaled past the dead zone', () => {
  const t = (0.6 - 0.15) / 0.85;
  assert.ok(Math.abs(stickResponse(0.6) - Math.pow(t, 1.8)) < 1e-12);
  assert.ok(Math.abs(stickResponse(-0.6) + Math.pow(t, 1.8)) < 1e-12);
});

test('defaults are the #399 values the config comments state', () => {
  assert.equal(BALANCE_DEFAULTS.stickDeadzone, 0.15);
  assert.equal(BALANCE_DEFAULTS.stickResponseCurve, 1.8);
  assert.equal(BALANCE_DEFAULTS.gyroSensitivity, 55);
  assert.equal(BALANCE_DEFAULTS.gyroResponseCurve, 2.0);
  assert.equal(BALANCE_DEFAULTS.gyroOutputSmoothing, 0.4,
    'EMA weight: lower = more smoothing');
  assert.equal(BALANCE_DEFAULTS.steeringFeel, 0.3);
  // unchanged on purpose
  assert.equal(BALANCE_DEFAULTS.mobileTiltGain, 0.25);
  assert.equal(BALANCE_DEFAULTS.gyroDeadzone, 4);
});

test('the default steering feel is applied at load, not just shown on the slider', () => {
  assert.equal(TUNE.steeringFeel, 0.3);
  // applySteeringFeel(0.3): sensitivity ×1.06 (more degrees = gentler, B2), smoothing ×0.87, dead zone ×1.16
  assert.ok(Math.abs(TUNE.gyroSensitivity - 55 * 1.06) < 1e-9, `gyroSensitivity ${TUNE.gyroSensitivity}`);
  assert.ok(Math.abs(TUNE.gyroOutputSmoothing - 0.4 * 0.87) < 1e-9);
  assert.ok(Math.abs(TUNE.gyroDeadzone - 4 * 1.16) < 1e-9);
  assert.equal(TUNE.gyroResponseCurve, 2.0, 'already at the 2.0 ceiling');
});

test('DDA offers ASSIST after 2 failures; silent assist unchanged; SKIP after 5 (#403)', () => {
  assert.equal(DDA_ASSIST_AFTER, 2);
  assert.equal(DDA_SILENT_ADJUST_AFTER, 2);
  assert.equal(DDA_SKIP_AFTER, 5);
  const dda = new DDAManager('chill');
  dda.recordFailure(100);
  assert.equal(dda.evaluate(100).offerAssist, false, 'one failure is not enough');
  dda.recordFailure(100);
  const r = dda.evaluate(100);
  assert.equal(r.offerAssist, true);
  assert.equal(r.adjustTune, true);
  assert.equal(r.offerSkip, false);
  for (let i = 0; i < 4; i++) dda.recordFailure(100);
  assert.equal(dda.evaluate(100).offerSkip, true);
});

// ── B2 (PR #397 review): steering feel is applied to an un-feeled base ──

function snapshot() {
  const t = {}, b = {};
  for (const k of TUNING_KEYS) { t[k] = TUNE[k]; b[k] = TUNING_BASE[k]; }
  return { t, b, feel: TUNE.steeringFeel };
}
function restore(s) { Object.assign(TUNING_BASE, s.b); applySteeringFeel(s.feel); }

test('B2: applying the same feel N times gives the same tuning (no compounding)', () => {
  const saved = snapshot();
  try {
    applySteeringFeel(0.3);
    const once = {}; for (const k of TUNING_KEYS) once[k] = TUNE[k];
    for (let i = 0; i < 25; i++) applySteeringFeel(0.3);
    for (const k of TUNING_KEYS) assert.equal(TUNE[k], once[k], k);
    // the base is never touched by applying a feel
    for (const k of TUNING_KEYS) assert.equal(TUNING_BASE[k], saved.b[k], 'base ' + k);
  } finally { restore(saved); }
});

test('B2: adaptation-style passes (write base, re-apply feel) do not drift with no new data', () => {
  const saved = snapshot();
  try {
    const before = TUNE.gyroSensitivity;
    for (let i = 0; i < 12; i++) {           // ~2 min of 10 s adaptation passes, zero blend
      setTuningBase({ gyroSensitivity: TUNING_BASE.gyroSensitivity, gyroDeadzone: TUNING_BASE.gyroDeadzone });
      applySteeringFeel(TUNE.steeringFeel);
    }
    assert.equal(TUNE.gyroSensitivity, before);
  } finally { restore(saved); }
});

test('B2: Stable is LESS sensitive (more degrees for a full lean) than Responsive', () => {
  const saved = snapshot();
  try {
    applySteeringFeel(0);
    const stable = { s: TUNE.sensitivity, g: TUNE.gyroSensitivity };
    applySteeringFeel(1);
    const responsive = { s: TUNE.sensitivity, g: TUNE.gyroSensitivity };
    assert.ok(stable.g > responsive.g, `gyro ${stable.g} vs ${responsive.g}`);
    assert.ok(stable.s > responsive.s, `tilt ${stable.s} vs ${responsive.s}`);
    applySteeringFeel(0.5);
    assert.ok(Math.abs(TUNE.gyroSensitivity - TUNING_BASE.gyroSensitivity) < 1e-9, 'the middle is the base');
  } finally { restore(saved); }
});

test('B2: setTuningBase takes only finite tuning numbers', () => {
  const saved = snapshot();
  try {
    setTuningBase({ sensitivity: 30, deadzone: NaN, steeringFeel: 0.9, bogus: 1 });
    assert.equal(TUNING_BASE.sensitivity, 30);
    assert.equal(TUNING_BASE.deadzone, saved.b.deadzone);
    assert.equal(TUNING_BASE.bogus, undefined);
  } finally { restore(saved); }
});

test('B2 migration: a pre-fix save with a steering feel has the old feel scale divided out', () => {
  const feel = 0.3;   // old scales: sensitivity ×0.94, dead zone ×1.16, curve +0.12
  const legacy = { version: 1, inputType: 'phone', sensitivity: 23 * 0.94, deadzone: 4 * 1.16,
    responseCurve: 2.0 + 0.12, outputSmoothing: 0.38, steeringFeel: feel };
  const { values, migrated } = migrateSavedTuning(legacy);
  assert.equal(migrated, true);
  assert.ok(Math.abs(values.sensitivity - 23) < 1e-9, String(values.sensitivity));
  assert.ok(Math.abs(values.deadzone - 4) < 1e-9, String(values.deadzone));
  assert.ok(Math.abs(values.responseCurve - 2.0) < 1e-9, String(values.responseCurve));
  assert.equal(values.outputSmoothing, 0.38, 'only ever saved un-feeled by the tutorial');
});

test('B2 migration: a value pinned at its clamp cannot be un-scaled, so it resets to the default', () => {
  const defaults = { ...BALANCE_DEFAULTS, sensitivity: 23, deadzone: 4 };
  const { values } = migrateSavedTuning({ version: 1, inputType: 'phone', sensitivity: 15, deadzone: 8, steeringFeel: 0.3 }, defaults);
  assert.equal(values.sensitivity, 23);   // compounded down to the 15° floor
  assert.equal(values.deadzone, 4);       // compounded up to the 8° ceiling
  // a gyro save keeps its values under the phone-named keys; gyro's curve ceiling is 2.0
  const g = migrateSavedTuning({ version: 1, inputType: 'gyro', responseCurve: 2.0, steeringFeel: 0.3 }, defaults);
  assert.equal(g.values.responseCurve, defaults.responseCurve);
});

test('B2 migration: new saves and feel-less legacy saves are already the base', () => {
  const fresh = migrateSavedTuning({ version: 1, sensitivity: 30, steeringFeel: 0.3, tuningBase: true });
  assert.deepEqual(fresh, { values: { sensitivity: 30 }, migrated: false });
  const old = migrateSavedTuning({ version: 1, sensitivity: 30 });
  assert.deepEqual(old, { values: { sensitivity: 30 }, migrated: false });
  assert.deepEqual(migrateSavedTuning(null), { values: {}, migrated: false });
});
