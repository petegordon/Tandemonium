// Quality tiers (js/quality.js): High / Medium / Low + Auto.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveQualityTier, migrateQualityPref, getQualityPref, setQualityPref,
  getLearnedAutoTier, saveLearnedAutoTier, tierBelow, AutoTierWatcher,
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
