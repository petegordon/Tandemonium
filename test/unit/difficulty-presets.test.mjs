// A-5 · the presets must be internally honest: a difficulty that says you can
// fall has to be able to fall, and one that says you cannot must clamp.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DIFFICULTY_PRESETS } from '../../js/config.js';
import { DIFFICULTY_INSTRUCTIONS, getInstructions } from '../../js/race-config.js';

const SAFETY_CLAMP = 1.0;   // bike-model clamps |lean| to this when safety is on

test('every preset declares whether safety starts on', () => {
  for (const [name, p] of Object.entries(DIFFICULTY_PRESETS)) {
    assert.equal(typeof p.safetyDefault, 'boolean', `${name} is missing safetyDefault`);
  }
});

test('the gentle presets cannot fall even with safety off by accident', () => {
  for (const name of ['tutorial', 'chill']) {
    const p = DIFFICULTY_PRESETS[name];
    assert.equal(p.safetyDefault, true, `${name} must start with safety on`);
    assert.ok(p.crashThreshold > SAFETY_CLAMP,
      `${name}: crashThreshold ${p.crashThreshold} must sit above the safety clamp`);
  }
});

test('the crashable presets warn before they crash, even under the clamp', () => {
  for (const name of ['adventurous', 'daredevil']) {
    const p = DIFFICULTY_PRESETS[name];
    assert.equal(p.safetyDefault, false, `${name} must start with safety off`);
    // The danger wobble starts at |lean| = crashThreshold * dangerOnset. It has
    // to be reachable while safety is on, or a player who turns safety back on
    // never gets to feel the edge.
    const warnAt = p.crashThreshold * p.dangerOnset;
    assert.ok(warnAt < SAFETY_CLAMP,
      `${name}: warning starts at ${warnAt.toFixed(2)}, above the clamp`);
    // And it has to be a real warning, not a rounding error before the fall.
    assert.ok(p.crashThreshold - warnAt > 0.3,
      `${name}: only ${(p.crashThreshold - warnAt).toFixed(2)} rad of warning`);
  }
});

test('harder presets fall sooner and help less', () => {
  const { chill, adventurous, daredevil } = DIFFICULTY_PRESETS;
  assert.ok(adventurous.crashThreshold < chill.crashThreshold);
  assert.ok(daredevil.crashThreshold < adventurous.crashThreshold);
  assert.ok(daredevil.autoCorrectionStrength < adventurous.autoCorrectionStrength);
  assert.ok(adventurous.autoCorrectionStrength < chill.autoCorrectionStrength);
});

test('every preset has instruction text, and only the crashable ones threaten', () => {
  for (const name of Object.keys(DIFFICULTY_PRESETS)) {
    const text = getInstructions(name);
    assert.ok(text.lines.length >= 2, `${name} needs instruction lines`);
    const all = text.lines.join(' ').toLowerCase();
    if (DIFFICULTY_PRESETS[name].safetyDefault) {
      assert.ok(/cannot fall/.test(all), `${name} should say you cannot fall`);
      assert.ok(!/safety is off/.test(all), `${name} must not claim safety is off`);
    } else {
      assert.ok(/go down|falls fast/.test(all), `${name} should say you can go down`);
      assert.ok(/safety is off/.test(all), `${name} must say safety is off`);
    }
  }
});

test('an unknown difficulty still gets text', () => {
  assert.equal(getInstructions('nope'), DIFFICULTY_INSTRUCTIONS.adventurous);
});
