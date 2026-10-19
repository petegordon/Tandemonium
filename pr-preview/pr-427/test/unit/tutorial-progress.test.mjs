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

// m12 (PR #397 review): returning keyboard/stick players have no motion tuning,
// but plainly have played before — they are not forced into the tutorial.
test('a returning player with any earlier progress is not forced in', () => {
  const played = {
    records: { tandemonium_records: JSON.stringify({ 'grandma|chill|solo': { timeMs: 90000 } }) },
    achievements: { tandemonium_achievements: JSON.stringify([{ id: 'first_finish', date: 1 }]) },
    walletCoins: { tandemonium_wallet: JSON.stringify({ v: 1, coins: 40, earned: 40, lv: {}, rebuilds: 0 }) },
    walletSpent: { tandemonium_wallet: JSON.stringify({ v: 1, coins: 0, earned: 0, lv: { magnet: 1 }, rebuilds: 0 }) },
    slingshotRuns: { tandemonium_slingshot: JSON.stringify({ v: 2, best: 0, runs: 3, stage: 1 }) },
    slingshotStage: { tandemonium_slingshot: JSON.stringify({ v: 2, best: 0, runs: 0, stage: 2 }) },
    slingshotLegacyCoins: { tandemonium_slingshot: JSON.stringify({ coins: 25 }) },
    daily: { tandemonium_daily: JSON.stringify({ '2026-10-01': { best: 80000 } }) },
  };
  for (const [name, seed] of Object.entries(played)) {
    assert.equal(isTutorialDone(memStore(seed)), true, name);
  }
});

test('empty or fresh saves are not progress', () => {
  const fresh = {
    tandemonium_records: '{}',
    tandemonium_achievements: '[]',
    tandemonium_wallet: JSON.stringify({ v: 1, coins: 0, earned: 0, lv: {}, rebuilds: 0 }),
    tandemonium_slingshot: JSON.stringify({ v: 2, best: 0, runs: 0, stage: 1, daily: null }),
    tandemonium_daily: '{}',
    tandemonium_music: '1',
  };
  assert.equal(isTutorialDone(memStore(fresh)), false);
  // a corrupt save is not progress either
  assert.equal(isTutorialDone(memStore({ tandemonium_records: '{not json' })), false);
});
