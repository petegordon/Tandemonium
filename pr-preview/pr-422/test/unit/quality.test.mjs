// Quality tiers (js/quality.js): High / Medium / Low + Auto.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveQualityTier, migrateQualityPref, getQualityPref, setQualityPref,
  getLearnedAutoTier, saveLearnedAutoTier, tierBelow, autoFloorTier, tierRank, AutoTierWatcher,
} from '../../js/quality.js';

function store(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    _m: m,
  };
}

test('resolve: URL param wins, then the Options choice, then Auto', () => {
  assert.deepEqual(resolveQualityTier({ param: 'low', pref: 'high' }), { tier: 'low', auto: false });
  assert.deepEqual(resolveQualityTier({ param: null, pref: 'medium', hwTier: 'high' }), { tier: 'medium', auto: false });
  assert.deepEqual(resolveQualityTier({ pref: 'auto', hwTier: 'high' }), { tier: 'high', auto: true });
  assert.deepEqual(resolveQualityTier({ pref: 'auto', hwTier: null }), { tier: 'high', auto: true });
});

test('resolve: Auto starts a low-end GPU at Medium (the old Low), and a learned tier beats detection', () => {
  assert.deepEqual(resolveQualityTier({ pref: 'auto', hwTier: 'low' }), { tier: 'medium', auto: true });
  assert.deepEqual(resolveQualityTier({ pref: 'auto', hwTier: 'high', learned: 'low' }), { tier: 'low', auto: true });
  assert.deepEqual(resolveQualityTier({ param: 'bogus', pref: 'bogus', hwTier: 'low' }), { tier: 'medium', auto: true });
});

test('migrate: a saved "low" from the two-tier days becomes "medium", once', () => {
  const s = store({ tandemonium_quality: 'low' });
  migrateQualityPref(s);
  assert.equal(getQualityPref(s), 'medium');
  setQualityPref('low', s);            // a new Low, chosen after the update
  migrateQualityPref(s);
  assert.equal(getQualityPref(s), 'low', 'not migrated twice');
  const fresh = store();
  migrateQualityPref(fresh);
  assert.equal(getQualityPref(fresh), 'auto');
});

test('learned Auto tier: saved, expires after a week, and choosing Auto again forgets it', () => {
  const s = store();
  const now = 1_000_000_000_000;
  saveLearnedAutoTier('low', s, now);
  assert.equal(getLearnedAutoTier(s, now + 86400000), 'low');
  assert.equal(getLearnedAutoTier(s, now + 8 * 86400000), null);
  saveLearnedAutoTier('medium', s, now);
  setQualityPref('auto', s);
  assert.equal(getLearnedAutoTier(s, now), null);
});

test('tierBelow steps High → Medium → Low and stops', () => {
  assert.equal(tierBelow('high'), 'medium');
  assert.equal(tierBelow('medium'), 'low');
  assert.equal(tierBelow('low'), 'low');
});

test('Auto never steps a desktop down to Low (it would hide the riders); phones and TVs may', () => {
  assert.equal(autoFloorTier(false), 'medium');
  assert.equal(autoFloorTier(true), 'low');
  assert.ok(tierRank('low') < tierRank('medium') && tierRank('medium') < tierRank('high'));
});

test('a learned Low on a desktop comes back up to Medium; a phone keeps it; a manual Low stays', () => {
  assert.deepEqual(resolveQualityTier({ pref: 'auto', learned: 'low', floor: 'medium' }), { tier: 'medium', auto: true });
  assert.deepEqual(resolveQualityTier({ pref: 'auto', learned: 'low', floor: 'low' }), { tier: 'low', auto: true });
  assert.deepEqual(resolveQualityTier({ pref: 'low', learned: 'low', floor: 'medium' }), { tier: 'low', auto: false });
});

test('watcher: a slow ride steps down after the grace + one window; a fast one never does', () => {
  const w = new AutoTierWatcher({ minFps: 24, windowSec: 8, graceSec: 6 });
  let out = null, t = 0;
  while (!out && t < 30) { out = w.sample(1 / 10); t += 1 / 10; }   // 10 fps
  assert.equal(out, 'down');
  assert.ok(t >= 14 && t < 14.5, `stepped down at ${t.toFixed(1)} s`);
  const fast = new AutoTierWatcher();
  for (let i = 0; i < 60 * 60; i++) assert.equal(fast.sample(1 / 60), null);
});

test('watcher: pauses and hitches over 1 s are not frames', () => {
  const w = new AutoTierWatcher({ windowSec: 8, graceSec: 0 });
  for (let i = 0; i < 20; i++) assert.equal(w.sample(5), null);   // a tab switch, repeatedly
  for (let i = 0; i < 8 * 30; i++) assert.equal(w.sample(1 / 30), null);
});

test('display testing: saved overrides, URL switches win, reset clears them', async () => {
  const { getDisplayTest, setDisplayTest, clearDisplayTest, resolveDisplayTest, displayTestActive } = await import('../../js/quality.js');
  const s = store();
  assert.deepEqual(getDisplayTest(s), { lines: 0, aa: 'tier', perf: false });
  assert.equal(displayTestActive(getDisplayTest(s)), false);
  setDisplayTest({ lines: 720, aa: 'on' }, s);
  setDisplayTest({ perf: true }, s);
  assert.deepEqual(getDisplayTest(s), { lines: 720, aa: 'on', perf: true });
  setDisplayTest({ lines: 99999 }, s);
  assert.equal(getDisplayTest(s).lines, 0, 'out-of-range lines fall back to the tier');
  const saved = { lines: 720, aa: 'on', perf: false };
  assert.deepEqual(resolveDisplayTest(new URLSearchParams('lines=540&aa=0&debug=perf'), saved), { lines: 540, aa: 'off', perf: true });
  assert.deepEqual(resolveDisplayTest(new URLSearchParams(''), saved), saved);
  clearDisplayTest(s);
  assert.deepEqual(getDisplayTest(s), { lines: 0, aa: 'tier', perf: false });
});
