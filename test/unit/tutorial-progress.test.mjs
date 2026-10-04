// D6 (#400) · first SOLO goes to the tutorial until it is finished or skipped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isTutorialDone, markTutorialDone, TUTORIAL_DONE_KEY } from '../../js/tutorial-progress.js';

function memStore(init = {}) {
  const m = new Map(Object.entries(init));
  return { get: k => m.get(k) ?? null, set: (k, v) => m.set(k, String(v)), keys: () => [...m.keys()], _m: m };
}

test('a fresh profile has not done the tutorial', () => {
  assert.equal(isTutorialDone(memStore()), false);
  assert.equal(isTutorialDone(memStore({ tandemonium_daily: '{}' })), false);
});

test('finishing or skipping marks it done', () => {
  for (const how of ['complete', 'skip']) {
    const s = memStore();
    markTutorialDone(s, how);
    assert.equal(s._m.get(TUTORIAL_DONE_KEY), how);
    assert.equal(isTutorialDone(s), true);
  }
});

test('a returning player with saved motion tuning is not forced back in', () => {
  assert.equal(isTutorialDone(memStore({ tandemonium_motion_tuning: '{"version":1}' })), true);
  assert.equal(isTutorialDone(memStore({ tandemonium_motion_tuning_abc123: '{"version":1}' })), true);
});

test('blocked storage never traps a player in the tutorial', () => {
  const angry = { get() { throw new Error('blocked'); }, set() { throw new Error('blocked'); }, keys() { throw new Error('blocked'); } };
  assert.equal(isTutorialDone(angry), true);
  assert.doesNotThrow(() => markTutorialDone(angry));
});
