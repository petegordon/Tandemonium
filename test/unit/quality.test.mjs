// Quality tiers (js/quality.js): High / Medium / Low + Auto.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveQualityTier, migrateQualityPref, getQualityPref, setQualityPref,
  getLearnedAutoTier, saveLearnedAutoTier, tierBelow, autoFloorTier, tierRank, AutoTierWatcher,
  clipsOffAtBoot, keepDrawingBuffer, CLIP_SLOW_KEY,
  getLearnedAuto, tierAbove, autoStepUpTarget, AUTO_TIER_DAYS,
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

test('learned Auto tier: saved, expires after AUTO_TIER_DAYS, and choosing Auto again forgets it', () => {
  const s = store();
  const now = 1_000_000_000_000;
  const day = 86400000;
  saveLearnedAutoTier('low', s, now);
  assert.equal(getLearnedAutoTier(s, now + day), 'low');
  assert.equal(getLearnedAutoTier(s, now + AUTO_TIER_DAYS * day), 'low');
  assert.equal(getLearnedAutoTier(s, now + AUTO_TIER_DAYS * day + 1), null, 'expired: back to hardware detection');
  assert.equal(getLearnedAutoTier(s, now + 8 * day), null);
  saveLearnedAutoTier('medium', s, now);
  setQualityPref('auto', s);
  assert.equal(getLearnedAutoTier(s, now), null);
});

test('learned Auto record keeps the tier that proved slow, and it expires with the tier', () => {
  const s = store();
  const now = 1_000_000_000_000;
  saveLearnedAutoTier('medium', s, now, 'high');
  assert.deepEqual(getLearnedAuto(s, now), { tier: 'medium', slow: 'high' });
  assert.equal(getLearnedAuto(s, now + (AUTO_TIER_DAYS + 1) * 86400000), null);
  // A record saved before #456 Q2 has no slow tier.
  const old = store({ tandemonium_auto_tier: JSON.stringify({ tier: 'low', at: now }) });
  assert.deepEqual(getLearnedAuto(old, now), { tier: 'low', slow: null });
  // Junk / a missing timestamp is not fresh.
  assert.equal(getLearnedAuto(store({ tandemonium_auto_tier: '{"tier":"low"}' }), now), null);
  assert.equal(getLearnedAuto(store({ tandemonium_auto_tier: 'nope' }), now), null);
});

test('step-up target: one tier at a time, never past High, never back to a tier that proved slow', () => {
  assert.equal(tierAbove('low'), 'medium');
  assert.equal(tierAbove('medium'), 'high');
  assert.equal(tierAbove('high'), 'high');
  assert.equal(autoStepUpTarget({ tier: 'low' }), 'medium');
  assert.equal(autoStepUpTarget({ tier: 'medium' }), 'high');
  assert.equal(autoStepUpTarget({ tier: 'high' }), null);
  assert.equal(autoStepUpTarget({ tier: 'medium', slow: 'high' }), null, 'High was too slow');
  assert.equal(autoStepUpTarget({ tier: 'low', slow: 'medium' }), null, 'Medium was too slow');
  assert.equal(autoStepUpTarget({ tier: 'low', slow: 'high' }), 'medium', 'Medium is still worth a try');
});

test('watcher: a long fast stretch says up only when allowed, and only after upWindows fast windows in a row', () => {
  const w = new AutoTierWatcher({ windowSec: 8, graceSec: 6, upFps: 50, upWindows: 8 });
  let out = null, t = 0;
  while (!out && t < 200) { out = w.sample(1 / 60, { canUp: true }); t += 1 / 60; }
  assert.equal(out, 'up');
  assert.ok(t >= 6 + 64 - 0.1 && t < 6 + 64 + 0.5, `stepped up at ${t.toFixed(1)} s`);
  // Not allowed (already at the top, or the next tier proved slow): never.
  const no = new AutoTierWatcher();
  for (let i = 0; i < 60 * 300; i++) assert.equal(no.sample(1 / 60), null);
});

test('watcher: a single slower window restarts the step-up count (hysteresis)', () => {
  const w = new AutoTierWatcher({ windowSec: 8, graceSec: 0, upFps: 50, upWindows: 3 });
  const run = (fps, sec) => { let r = null; for (let i = 0; i < fps * sec; i++) r = w.sample(1 / fps, { canUp: true }) || r; return r; };
  assert.equal(run(64, 16), null);        // two fast windows (64 / 32 fps: exact in binary)
  assert.equal(run(32, 8), null);         // 32 fps: fine, not "comfortably fast": count restarts
  assert.equal(run(64, 16), null);        // two again, not three
  assert.equal(run(64, 8), 'up');         // third in a row
});

test('watcher: between minFps and upFps nothing happens; slow still steps down while up is allowed', () => {
  const mid = new AutoTierWatcher({ graceSec: 0 });
  for (let i = 0; i < 35 * 300; i++) assert.equal(mid.sample(1 / 35, { canUp: true }), null);
  const slow = new AutoTierWatcher({ graceSec: 0 });
  let out = null;
  for (let i = 0; i < 10 * 20 && !out; i++) out = slow.sample(1 / 10, { canUp: true });
  assert.equal(out, 'down');
  // At the floor (canDown false) a slow ride says nothing.
  const floor = new AutoTierWatcher({ graceSec: 0 });
  for (let i = 0; i < 10 * 60; i++) assert.equal(floor.sample(1 / 10, { canDown: false, canUp: true }), null);
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

// #456 · Low gives up preserveDrawingBuffer only when clip recording is off.
test('clips are off at boot with ?noclip, no way to record, or a slow probe last time', () => {
  assert.equal(clipsOffAtBoot({ search: '', canRecord: true, store: store() }), false);
  assert.equal(clipsOffAtBoot({ search: '?quality=low&noclip', canRecord: true, store: store() }), true);
  assert.equal(clipsOffAtBoot({ search: '', canRecord: false, store: store() }), true);
  assert.equal(clipsOffAtBoot({ search: '', canRecord: true, store: store({ [CLIP_SLOW_KEY]: '1' }) }), true);
  assert.equal(clipsOffAtBoot({ search: '', canRecord: true, store: store({ [CLIP_SLOW_KEY]: '0' }) }), false);
  const broken = { getItem() { throw new Error('no storage'); } };
  assert.equal(clipsOffAtBoot({ search: '', canRecord: true, store: /** @type {any} */ (broken) }), false);
});

test('only Low with clips off drops the kept drawing buffer', () => {
  assert.equal(keepDrawingBuffer('low', true), false);
  assert.equal(keepDrawingBuffer('low', false), true);
  assert.equal(keepDrawingBuffer('medium', true), true);
  assert.equal(keepDrawingBuffer('high', true), true);
});
