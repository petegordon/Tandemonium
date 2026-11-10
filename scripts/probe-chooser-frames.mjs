#!/usr/bin/env node
// SMOKE_GPU=1 node scripts/probe-chooser-frames.mjs (real GPU; without it, software WebGL runs ~12 fps)
// probe: the chooser's frame times headless, while Solo Flight's Robot geese load and once they pedal.
import { startHarness, sleep } from './lib/smoke-harness.mjs';
import { soloAchievementIds } from '../js/rewards.js';

const h = await startHarness({ port: 8987, outDir: 'tandemonium-probe-frames' });
const solo = soloAchievementIds();
const page = await h.gamePage({ viewport: { width: 1920, height: 1080 }, storage: {
  tandemonium_tutorial_done: 'smoke', tandemonium_chooser_geese: process.env.CHOOSER_GEESE || 'ride',   // CHOOSER_GEESE=stand: beside the bike
  tandemonium_achievements: JSON.stringify(solo.slice(1).map(id => ({ id, earnedAt: 1 }))),
  tandemonium_bike_ladder: JSON.stringify({ bikes: ['default', 'bike_orange', 'bike_magenta', 'bike_red', 'bike_blue', 'bike_green', 'bike_yellow', 'bike_newyears', 'bike_christmas', 'bike_birthday', 'solo_flight', 'time_warp', 'gold_standard'], edition: 'full', count: 100 }) } });
await page.waitForFunction(() => window._game && window._game.lobby._presetKeys.length > 1 && !!window._game.lobby._previewModel, { timeout: 90000 });
await sleep(3000);
console.log('GL:', await page.evaluate(() => {
  const g = document.createElement('canvas').getContext('webgl2'), x = g.getExtension('WEBGL_debug_renderer_info');
  return x ? g.getParameter(x.UNMASKED_RENDERER_WEBGL) : '?';
}));

const measure = (ms) => page.evaluate((ms) => new Promise((res) => {
  const d = []; let last = performance.now(); const end = last + ms;
  const tick = (t) => { d.push(t - last); last = t; if (t < end) requestAnimationFrame(tick); else res(d); };
  requestAnimationFrame(tick);
}), ms);
const stats = (label, d) => {
  const s = [...d].sort((a, b) => a - b);
  const p = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))].toFixed(1);
  console.log(`${label}: ${d.length} frames, median ${p(0.5)} ms, p95 ${p(0.95)} ms, max ${s[s.length - 1].toFixed(1)} ms, >100 ms: ${d.filter(x => x > 100).length}`);
};

stats('idle menu (colour bike)', await measure(3000));
await page.evaluate(() => { const l = window._game.lobby; l._presetIndex = l._presetKeys.indexOf('solo_flight'); l._applyPresetToPreview(); });
stats('Solo Flight shown, geese loading', await measure(4000));
await page.waitForFunction(() => { const sp = (window._game.lobby._specialPreviews || {}).solo_flight; return !!(sp && (sp.riders || (sp.actors && sp.actors.length === 2))); }, { timeout: 60000 });
stats('Solo Flight, geese pedalling / standing', await measure(3000));
await page.evaluate(() => { const l = window._game.lobby; l._presetIndex = l._presetKeys.indexOf('bike_christmas'); l._applyPresetToPreview(); });
stats('Christmas shown, geese loading', await measure(4000));
await sleep(5000);
stats('Christmas, geese pedalling / standing', await measure(3000));
await h.finish();
