import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FULL_RULES, DEMO_RULES, resolveIsDemo, rulesFor, levelAllowed, resolveMediaEnabled
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

test('demo keeps multiplayer, gates the slingshot, is weekly and unranked', () => {
  assert.equal(DEMO_RULES.rideTogether, true);
  assert.equal(DEMO_RULES.versus, true);
  assert.equal(DEMO_RULES.weeklyRoad, true);
  assert.equal(DEMO_RULES.ranked, false);
  assert.ok(DEMO_RULES.slingshot.maxStage >= 1);
  assert.equal(FULL_RULES.slingshot.maxStage, null);
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
