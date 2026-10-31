// #522 · controller gyro steered up to 4x harder than phone tilt, even on Chill:
// the steering gain was phone-only (mobileTiltGain 0.25), and in-ride
// adaptation could shrink the gyro's "degrees for a full lean" to 15°. Now one
// TUNE.motionGain (set per difficulty) scales phone tilt and gyro alike, and
// the gyro's degrees-for-a-full-lean never goes under GYRO_MIN_SENSITIVITY.
import test from 'node:test';
import assert from 'node:assert/strict';
import { InputManager } from '../../js/input-manager.js';
import {
  TUNE, TUNING_BASE, BALANCE_DEFAULTS, DIFFICULTY_PRESETS, GYRO_MIN_SENSITIVITY,
  applyDifficulty, applySteeringFeel, setTuningBase, migrateSavedTuning,
  tuningBaseFromSave, observedFullLeanDegrees, TUNING_SAVE_BASE_FLAG,
} from '../../js/config.js';

/** A bare InputManager with only the tilt pipeline's state. */
function pad() {
  const im = Object.create(InputManager.prototype);
  Object.assign(im, {
    motionEnabled: true, rawGamma: 0, motionOffset: 0, _calibrating: false, _warmupCount: 5,
    _driftEma: null, _driftRate: 0.015, _driftWindowK: 0.005,
    _smoothedLean: 0, _prevLeanRaw: 0, motionLean: 0, motionLeanVisual: 0,
    bikeSpeed: 0, bikeMaxSpeed: 12, _lastApplyTiltTime: 0,
  });
  return im;
}

/** Hold `deg` for `n` samples at 60 Hz through the gyro or phone path. */
function hold(im, deg, n, isGyro) {
  const realNow = performance.now;
  let t = (im.__t || 1000);
  performance.now = () => t;
  try {
    for (let i = 0; i < n; i++) { t += 1000 / 60; im._applyTilt(deg, isGyro); }
  } finally { performance.now = realNow; im.__t = t; }
}

/** Snapshot + restore TUNE / TUNING_BASE around a test (they are module globals). */
function keepTune(fn) {
  const tune = { ...TUNE }, base = { ...TUNING_BASE };
  try { fn(); } finally { Object.assign(TUNE, tune); Object.assign(TUNING_BASE, base); }
}

test('each difficulty sets its own motion gain; Chill and the tutorial are the gentle ones', () => {
  assert.equal(DIFFICULTY_PRESETS.tutorial.motionGain, 0.3);
  assert.equal(DIFFICULTY_PRESETS.chill.motionGain, 0.3);
  assert.equal(DIFFICULTY_PRESETS.adventurous.motionGain, 0.6);
  assert.equal(DIFFICULTY_PRESETS.daredevil.motionGain, 1.0);
  assert.equal(BALANCE_DEFAULTS.motionGain, 0.3, 'before any ride, Chill\'s gain');
  keepTune(() => {
    for (const [name, p] of Object.entries(DIFFICULTY_PRESETS)) {
      applyDifficulty(name);
      assert.equal(TUNE.motionGain, p.motionGain, name);
      assert.equal(TUNE.mobileTiltGain, p.motionGain, `${name}: the old name reads the shared gain`);
    }
  });
});

test('the same roll gives the same lean on gyro and phone tilt, at every difficulty', () => {
  keepTune(() => {
    // Equal shaping on both paths, so only the gain could tell them apart.
    Object.assign(TUNE, { sensitivity: 40, gyroSensitivity: 40, deadzone: 4, gyroDeadzone: 4,
      responseCurve: 2, gyroResponseCurve: 2, outputSmoothing: 0.4, gyroOutputSmoothing: 0.4 });
    for (const name of Object.keys(DIFFICULTY_PRESETS)) {
      applyDifficulty(name);
      for (const deg of [8, 15, 25, 45]) {
        const g = pad(), p = pad();
        for (const im of [g, p]) { im._driftRate = 0; im._driftWindowK = 0; }   // drift tracking differs by design; compare the shaping + gain
        hold(g, 0, 30, true); hold(p, 0, 30, false);
        hold(g, deg, 90, true); hold(p, deg, 90, false);
        assert.ok(Math.abs(g.getMotionLean() - p.getMotionLean()) < 1e-9,
          `${name} ${deg}°: gyro ${g.getMotionLean()} vs phone ${p.getMotionLean()}`);
        // The gain is the only scale between what steers and what the player does.
        assert.ok(Math.abs(g.getMotionLean() - g.getMotionLeanVisual() * TUNE.motionGain) < 1e-9, `${name} ${deg}° gain`);
      }
    }
  });
});

test('on Chill a 10° controller roll asks for under 0.1 lean (it asked for 0.10 before, up to 0.41 adapted)', () => {
  keepTune(() => {
    setTuningBase(BALANCE_DEFAULTS);
    applySteeringFeel(BALANCE_DEFAULTS.steeringFeel);
    applyDifficulty('chill');
    const g = pad();
    hold(g, 0, 30, true);
    hold(g, 10, 120, true);
    assert.ok(Math.abs(g.getMotionLean()) < 0.1, `lean ${g.getMotionLean()}`);
    assert.ok(Math.abs(g.getMotionLean()) < 0.035, `≈ 0.3 × the old 0.10, got ${g.getMotionLean()}`);
  });
});

test('the ungained path (visual lean, centre, drift) does not depend on the gain at all', () => {
  // smoke:phone-pad reads getMotionLeanVisual() after a phone remote calibrates
  // its centre and tilts. Everything that feeds it — calibration, the drift
  // gate, the "starting a turn" smoothing threshold — must come out the same at
  // every gain, or a difficulty would change how the geese lean and where the
  // centre lands. (The smoothing threshold used to compare the GAINED lean
  // against a fixed 0.05.)
  keepTune(() => {
    for (const isGyro of [false, true]) {
      const runs = [0.25, 0.3, 0.6, 1.0].map((g) => {
        TUNE.motionGain = g;
        const im = pad();
        im.motionOffset = null; im._warmupCount = 0;   // fresh: warm-up then calibration
        const trace = [];
        const seq = [...Array(12).fill(0), ...Array(8).fill(35), ...Array(90).fill(35), ...Array(40).fill(-20), ...Array(60).fill(4)];
        const realNow = performance.now; let t = 1000; performance.now = () => t;
        try {
          for (const deg of seq) { t += 1000 / 30; im._applyTilt(deg, isGyro); trace.push([im.getMotionLeanVisual(), im.motionOffset ?? NaN]); }
        } finally { performance.now = realNow; }
        return { g, trace, gained: im.getMotionLean() };
      });
      const [ref, ...rest] = runs;
      for (const r of rest) {
        r.trace.forEach(([v, off], i) => {
          assert.ok(Math.abs(v - ref.trace[i][0]) < 1e-9, `${isGyro ? 'gyro' : 'phone'} gain ${r.g} sample ${i}: visual ${v} vs ${ref.trace[i][0]}`);
          assert.ok(Number.isNaN(off) ? Number.isNaN(ref.trace[i][1]) : Math.abs(off - ref.trace[i][1]) < 1e-9, `${isGyro ? 'gyro' : 'phone'} gain ${r.g} sample ${i}: centre ${off} vs ${ref.trace[i][1]}`);
        });
        assert.ok(Math.abs(r.gained / r.g - ref.gained / ref.g) < 1e-9, 'only the steering lean scales with the gain');
      }
    }
  });
});

test('the riders\' lean (visual) is ungained for gyro and phone alike', () => {
  keepTune(() => {
    applyDifficulty('chill');
    for (const isGyro of [true, false]) {
      const im = pad();
      hold(im, 0, 30, isGyro);
      hold(im, 70, 180, isGyro);   // far past a full lean
      assert.ok(im.getMotionLeanVisual() > 0.95, `${isGyro ? 'gyro' : 'phone'} visual ${im.getMotionLeanVisual()}`);
      assert.ok(im.getMotionLean() <= 0.3 + 1e-9, `${isGyro ? 'gyro' : 'phone'} steers at most the gain`);
    }
  });
});

test('a held gyro turn on Chill is not drift-corrected away (taper reads the ungained lean)', () => {
  keepTune(() => {
    applyDifficulty('chill');
    const g = pad();
    hold(g, 0, 60, true);
    hold(g, 50, 180, true);   // a 3 s held turn
    assert.ok(Math.abs(g.motionOffset) < 2, `offset chased the turn to ${g.motionOffset.toFixed(2)}°`);
    assert.ok(g.getMotionLeanVisual() > 0.6, `still a strong lean: ${g.getMotionLeanVisual()}`);
  });
});

test('adaptation never pushes the gyro\'s degrees-for-a-full-lean under the floor; phone keeps 15°', () => {
  assert.equal(GYRO_MIN_SENSITIVITY, 35);
  for (const p95 of [0, 5, 12, 20, 30, 40]) assert.ok(observedFullLeanDegrees(p95, true) >= 35, `gyro p95 ${p95}`);
  assert.equal(observedFullLeanDegrees(12, false), 15);
  assert.equal(observedFullLeanDegrees(100, true), 60);
  keepTune(() => {
    // A whole ride of tiny rolls, blended in the way _updateMotionAdaptation does.
    for (let i = 0; i < 50; i++) {
      TUNING_BASE.gyroSensitivity += (observedFullLeanDegrees(8, true) - TUNING_BASE.gyroSensitivity) * 0.2;
    }
    assert.ok(TUNING_BASE.gyroSensitivity >= 35 - 1e-9, `${TUNING_BASE.gyroSensitivity}`);
    // And no feel can take the ridden value under it.
    setTuningBase({ gyroSensitivity: 20 });
    assert.equal(TUNING_BASE.gyroSensitivity, 35, 'setTuningBase raises a calibration under the floor');
    applySteeringFeel(1);   // Responsive: ×0.85
    assert.equal(TUNE.gyroSensitivity, 35);
    setTuningBase({ sensitivity: 16 });
    assert.equal(TUNING_BASE.sensitivity, 16, 'phone tilt keeps its own range');
  });
});

test('saved gyro calibrations under the floor are raised (and re-saved)', () => {
  // This build's saves (flagged as the base).
  const flagged = { inputType: 'gyro', sensitivity: 18, deadzone: 3, responseCurve: 1.5, [TUNING_SAVE_BASE_FLAG]: true };
  const a = migrateSavedTuning(flagged);
  assert.equal(a.values.sensitivity, 35);
  assert.equal(a.migrated, true, 'raised, so the caller rewrites the save');
  assert.equal(tuningBaseFromSave(flagged, a.values).gyroSensitivity, 35);
  // A flagged save already over the floor is left alone.
  const ok = migrateSavedTuning({ ...flagged, sensitivity: 48 });
  assert.equal(ok.values.sensitivity, 48);
  assert.equal(ok.migrated, false);
  // A pre-B2 feel-scaled save pinned at the old 15° floor falls back to the GYRO default, not the phone one.
  const legacy = migrateSavedTuning({ inputType: 'gyro', sensitivity: 15, deadzone: 4, responseCurve: 2, steeringFeel: 0.5 });
  assert.equal(legacy.values.sensitivity, BALANCE_DEFAULTS.gyroSensitivity);
  // A phone save is untouched by the gyro floor.
  const phone = migrateSavedTuning({ inputType: 'phone', sensitivity: 18, [TUNING_SAVE_BASE_FLAG]: true });
  assert.equal(phone.values.sensitivity, 18);
  assert.equal(phone.migrated, false);
});
