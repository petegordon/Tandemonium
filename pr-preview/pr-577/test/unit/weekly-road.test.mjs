// #400 · the demo's "This Week's Road": one road per ISO week, keyed by its Monday.
import test from 'node:test';
import assert from 'node:assert/strict';
import { weeklyKey, weeklySeed, seedFromKey, dailyKey } from '../../js/daily-seed.js';
import {
  asWeeklyRoad, resolveWeeklyLevel, weeklyDescription, WEEKLY_NAME, WEEKLY_DIFFICULTY
} from '../../js/daily-ride.js';

test('the week key is the Monday, for every day of the week', () => {
  // Mon 2026-09-28 .. Sun 2026-10-04 (after the 09:00 UTC rollover)
  for (const d of ['28', '29', '30']) {
    assert.equal(weeklyKey(new Date(`2026-09-${d}T12:00:00Z`)), '2026-09-28');
  }
  for (const d of ['01', '02', '03', '04']) {
    assert.equal(weeklyKey(new Date(`2026-10-${d}T12:00:00Z`)), '2026-09-28');
  }
  assert.equal(weeklyKey(new Date('2026-10-05T12:00:00Z')), '2026-10-05');
});

test('the week rolls over on Monday at 09:00 UTC, like the daily road', () => {
  assert.equal(weeklyKey(new Date('2026-10-05T08:59:59Z')), '2026-09-28');
  assert.equal(weeklyKey(new Date('2026-10-05T09:00:00Z')), '2026-10-05');
});

test('year boundaries: the week that spans New Year belongs to its Monday', () => {
  // Thu 2026-01-01 is in the week of Mon 2025-12-29.
  assert.equal(weeklyKey(new Date('2026-01-01T12:00:00Z')), '2025-12-29');
  assert.equal(weeklyKey(new Date('2026-01-04T12:00:00Z')), '2025-12-29');
  assert.equal(weeklyKey(new Date('2025-12-31T12:00:00Z')), '2025-12-29');
  // Mon 2029-01-01 starts its own week; Sun 2028-12-31 is still the old one.
  assert.equal(weeklyKey(new Date('2029-01-01T12:00:00Z')), '2029-01-01');
  assert.equal(weeklyKey(new Date('2028-12-31T12:00:00Z')), '2028-12-25');
  // Leap day.
  assert.equal(weeklyKey(new Date('2028-02-29T12:00:00Z')), '2028-02-28');
  // New Year's Day before 09:00 UTC is still the previous day's road/week.
  assert.equal(weeklyKey(new Date('2029-01-01T08:00:00Z')), '2028-12-25');
});

test('the week key is always a Monday and a valid day key', () => {
  for (let t = Date.parse('2026-01-01T00:00:00Z'); t < Date.parse('2027-01-01T00:00:00Z'); t += 5 * 3600 * 1000) {
    const k = weeklyKey(new Date(t));
    assert.equal(new Date(k + 'T00:00:00Z').getUTCDay(), 1, k);
    assert.ok(k <= dailyKey(new Date(t)));
  }
});

test('one seed per week: the Monday road', () => {
  const mon = weeklySeed(new Date('2026-09-28T12:00:00Z'));
  assert.equal(mon, weeklySeed(new Date('2026-10-04T12:00:00Z')));
  assert.equal(mon, seedFromKey('2026-09-28'));
  assert.notEqual(mon, weeklySeed(new Date('2026-10-05T12:00:00Z')));
});

test('the weekly road is the daily level renamed, on Chill', () => {
  const base = { id: 'daily', name: "Today's Road", isDaily: true, fixedDifficulty: 'adventurous', distance: 500 };
  const shown = asWeeklyRoad(base);
  assert.equal(shown.name, WEEKLY_NAME);
  assert.equal(shown.fixedDifficulty, WEEKLY_DIFFICULTY);
  assert.equal(WEEKLY_DIFFICULTY, 'chill');
  assert.equal(shown.isDaily, true);
  assert.equal(base.name, "Today's Road");          // the base is untouched

  const lvl = resolveWeeklyLevel(base, { key: '2026-09-28', seed: 42 });
  assert.equal(lvl.key, '2026-09-28');
  assert.equal(lvl.seed, 42);
  assert.equal(lvl.dateLabel, 'Week of Sep 28');
  const def = resolveWeeklyLevel(base);
  assert.equal(def.key, weeklyKey());
  assert.equal(def.seed, weeklySeed());
});

test('the card line names the week, not the day', () => {
  const d = weeklyDescription({ practiced: 0, best: null }, '2026-09-28');
  assert.match(d, /A new road every week/);
  assert.match(d, /Week of Sep 28 · not ridden yet/);
  assert.doesNotMatch(d, /Mon, Sep 28/);
});
