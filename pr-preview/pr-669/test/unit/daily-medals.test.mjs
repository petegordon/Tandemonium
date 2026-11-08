// Pete 2026-11-07: Daily Ride gold at Grandma's pace (per metre), the rider picks the difficulty.
import test from 'node:test';
import assert from 'node:assert/strict';
import { getMedals, getLevelById, timerBudgetMs } from '../../js/race-config.js';

test('Daily Ride gold is Grandma\'s gold pace per metre, every difficulty; bronze stays inside the clock', () => {
  const daily = getLevelById('daily'), grandma = getLevelById('grandma');
  assert.equal(daily.fixedDifficulty, undefined, 'the rider picks the difficulty');
  for (const d of ['chill', 'adventurous', 'daredevil']) {
    const m = getMedals('daily', d), g = getMedals('grandma', d);
    assert.equal(m.gold, Math.round(g.gold * daily.distance / grandma.distance), d);
    assert.ok(m.gold < m.silver && m.silver < m.bronze, d);
    assert.ok(m.bronze <= timerBudgetMs(daily, d), d + ': bronze reachable');
  }
  assert.equal(Math.round(getMedals('daily', 'adventurous').gold / 1000), 91);
});
