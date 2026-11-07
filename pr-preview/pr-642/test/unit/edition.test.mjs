import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FULL_RULES, DEMO_RULES, resolveIsDemo, rulesFor, levelAllowed, resolveMediaEnabled,
  dailyRideGate, bikeAllowed, achievementAllowed
} from '../../js/edition.js';

test('demo is detected from ?demo=1 or the Steam flag, nothing else', () => {
  assert.equal(resolveIsDemo('?demo=1', false), true);
  assert.equal(resolveIsDemo('', true), true);
  assert.equal(resolveIsDemo('?demo=0', false), false);
  assert.equal(resolveIsDemo('', undefined), false);
});

test('full game offers every level; demo only Tutorial, Grandma and the road', () => {
  assert.equal(levelAllowed(FULL_RULES, 'tourist'), true);
  assert.equal(levelAllowed(DEMO_RULES, 'grandma'), true);
  assert.equal(levelAllowed(DEMO_RULES, 'daily'), true);
  assert.equal(levelAllowed(DEMO_RULES, 'tourist'), false);
  assert.equal(rulesFor(true), DEMO_RULES);
  assert.equal(rulesFor(false), FULL_RULES);
});

test('#641 demo: co-op stays, Versus goes, the Slingshot stops at stage 3, two bikes', () => {
  assert.equal(DEMO_RULES.rideTogether, true);
  assert.equal(DEMO_RULES.versus, false);
  assert.equal(FULL_RULES.versus, true);
  assert.equal(DEMO_RULES.slingshot.maxStage, 3);
  assert.equal(FULL_RULES.slingshot.maxStage, null);
  assert.equal(bikeAllowed(DEMO_RULES, 'default'), true);
  assert.equal(bikeAllowed(DEMO_RULES, 'bike_orange'), true);
  assert.equal(bikeAllowed(DEMO_RULES, 'bike_red'), false);
  assert.equal(bikeAllowed(DEMO_RULES, 'bike_christmas'), false);
  assert.equal(bikeAllowed(FULL_RULES, 'bike_red'), true);
  assert.equal(achievementAllowed(DEMO_RULES, 'first_pedal'), true);
  assert.equal(achievementAllowed(DEMO_RULES, 'versus_first'), false);
  assert.equal(achievementAllowed(FULL_RULES, 'versus_first'), true);
  // Level scores: the full game posts them, the demo doesn't (as #400).
  assert.equal(FULL_RULES.postScores, true);
  assert.equal(DEMO_RULES.postScores, false);
});

test('#641 Daily Ride gate: the demo opens it after the Tutorial and Grandma\'s, then 3 rides a day', () => {
  const both = ['tutorial_done', 'home_sweet'];
  assert.deepEqual(dailyRideGate(DEMO_RULES, 0, []), { ok: false, reason: 'needs', needs: both });
  assert.deepEqual(dailyRideGate(DEMO_RULES, 0, ['tutorial_done']), { ok: false, reason: 'needs', needs: ['home_sweet'] });
  assert.deepEqual(dailyRideGate(DEMO_RULES, 0, both), { ok: true, left: 3 });
  assert.deepEqual(dailyRideGate(DEMO_RULES, 2, both), { ok: true, left: 1 });
  assert.deepEqual(dailyRideGate(DEMO_RULES, 3, both), { ok: false, reason: 'cap' });
  assert.deepEqual(dailyRideGate(DEMO_RULES, 9, both), { ok: false, reason: 'cap' });
  // The full game: open from the start, no limit.
  assert.deepEqual(dailyRideGate(FULL_RULES, 0, []), { ok: true, left: null });
  assert.deepEqual(dailyRideGate(FULL_RULES, 50, []), { ok: true, left: null });
});

test('room camera/mic is off unless ?media=1', () => {
  assert.equal(resolveMediaEnabled(''), false);
  assert.equal(resolveMediaEnabled('?demo=1'), false);
  assert.equal(resolveMediaEnabled('?media=1'), true);
});

test('NEXT LEVEL skips levels the edition does not offer, and locked ones', async () => {
  const { nextAllowedLevel } = await import('../../js/edition.js');
  const levels = [
    { id: 'tutorial', isTutorial: true }, { id: 'grandma' }, { id: 'castle' }, { id: 'daily' }
  ];
  // Demo: Grandma's goes to the road, never to a level it does not offer.
  assert.equal(nextAllowedLevel(levels, 'grandma', DEMO_RULES).id, 'daily');
  assert.equal(nextAllowedLevel(levels, 'tutorial', DEMO_RULES).id, 'grandma');
  assert.equal(nextAllowedLevel(levels, 'daily', DEMO_RULES), null);
  // Full game: locked levels are skipped too.
  assert.equal(nextAllowedLevel(levels, 'grandma', FULL_RULES).id, 'castle');
  assert.equal(nextAllowedLevel(levels, 'grandma', FULL_RULES, l => l.id === 'castle').id, 'daily');
  assert.equal(nextAllowedLevel(levels, 'unknown', FULL_RULES), null);
});
