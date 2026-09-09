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

// B-3 · medal thresholds have to be ordered and achievable.
test('medals get harder in the right direction', async () => {
  const { getMedals } = await import('../../js/race-config.js');
  for (const difficulty of ['chill', 'adventurous', 'daredevil']) {
    const m = getMedals('grandma', difficulty);
    assert.ok(m.gold < m.silver, `${difficulty}: gold must be faster than silver`);
    assert.ok(m.silver < m.bronze, `${difficulty}: silver must be faster than bronze`);
    assert.ok(m.gold > 20000, `${difficulty}: gold at ${m.gold} ms is not a real ride`);
  }
});

test('a harder difficulty demands a faster ride', async () => {
  const { getMedals } = await import('../../js/race-config.js');
  assert.ok(getMedals('grandma', 'daredevil').gold < getMedals('grandma', 'chill').gold);
});

test('the tutorial has no medals', async () => {
  const { getMedals } = await import('../../js/race-config.js');
  assert.equal(getMedals('tutorial', 'chill'), null);
});

// B-3 (review) · a medal nobody can earn is worse than no medal. The first
// version of the table derived medals from a guessed pace, and bronze came out
// UNREACHABLE on five of nine level/difficulty combinations — the segment timer
// expired before a rider could finish that slowly. This is the invariant that
// makes that impossible; keep it when A-1 replaces the numbers with measured
// percentiles.
test('every medal is reachable within the time the game itself allows', async () => {
  const { getMedals, timerBudgetMs, LEVELS } = await import('../../js/race-config.js');
  for (const level of LEVELS) {
    for (const difficulty of ['chill', 'adventurous', 'daredevil']) {
      const m = getMedals(level.id, difficulty);
      if (!m) continue;
      const budget = timerBudgetMs(level, difficulty);
      assert.ok(m.bronze <= budget,
        `${level.id}/${difficulty}: bronze ${(m.bronze / 1000).toFixed(0)}s but the timer only allows ${(budget / 1000).toFixed(0)}s`);
      assert.ok(m.gold < m.silver && m.silver < m.bronze, `${level.id}/${difficulty}: out of order`);
      assert.ok(m.gold > 15000, `${level.id}/${difficulty}: gold is not a real ride`);
    }
  }
});
