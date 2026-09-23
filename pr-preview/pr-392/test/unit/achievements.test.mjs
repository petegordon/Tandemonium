// F-1 · the achievements now point at the loops the plan built.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// achievements.js reaches for localStorage at construction, so read the source
// for the list shape and only import when a fake store is in place.
const src = fs.readFileSync(new URL('../../js/achievements.js', import.meta.url), 'utf8');

test('the new loop achievements exist', () => {
  for (const id of ['daily_first', 'daily_streak_7', 'daily_streak_30',
                    'pair_10_rides', 'pair_100km', 'distance_between_us']) {
    assert.match(src, new RegExp(`id: '${id}'`), `${id} is missing`);
  }
});

test('the retired colour achievements are still defined, not deleted', () => {
  // Deleting them would take the achievement away from everyone who earned it,
  // and break the Steam sync.
  for (const id of ['grandma_default', 'grandma_orange', 'grandma_yellow']) {
    assert.match(src, new RegExp(`id: '${id}'`), `${id} must not be deleted`);
  }
  assert.match(src, /RETIRED_IDS/, 'they must be marked retired');
});

test('the Steam sync script describes every achievement', () => {
  const sync = fs.readFileSync(new URL('../../scripts/sync-steam-achievements.js', import.meta.url), 'utf8');
  const ids = [...src.matchAll(/\{\s*id: '([^']+)'/g)].map(m => m[1]);
  assert.ok(ids.length >= 25, `only found ${ids.length} achievements`);
  for (const id of ids) {
    assert.ok(sync.includes(id + ':'), `${id} has no Steam description`);
  }
});

test('the retired list only retires bike colours', () => {
  const retired = /const RETIRED_IDS = new Set\(\[([\s\S]*?)\]\)/.exec(src)[1];
  const ids = [...retired.matchAll(/'([^']+)'/g)].map(m => m[1]);
  assert.equal(ids.length, 7);
  for (const id of ids) assert.match(id, /^grandma_/);
});
