#!/usr/bin/env node
// SMOKE_GPU=1 node scripts/probe-chooser-stall.mjs (or =d3d11 / =gl): renders over 20 ms when a bike's geese load.
// probe: what freezes the chooser when a bike's outfit geese load (render = shader compile / texture upload, or the load itself).
import { startHarness, sleep } from './lib/smoke-harness.mjs';

const h = await startHarness({ port: 8988, outDir: 'tandemonium-probe-stall' });
const page = await h.gamePage({ viewport: { width: 1920, height: 1080 }, storage: { tandemonium_tutorial_done: 'smoke' } });
await page.waitForFunction(() => window._game && window._game.lobby._presetKeys.length > 1 && !!window._game.lobby._previewModel, { timeout: 90000 });
await sleep(3000);
const out = await page.evaluate(() => new Promise((res) => {
  const l = window._game.lobby, r = l._previewRenderer, log = [];
  const t0 = performance.now();
  const render = r.render.bind(r);
  r.render = (s, c) => { const a = performance.now(); render(s, c); const d = performance.now() - a; if (d > 20) log.push(`render ${d.toFixed(0)} ms at +${(a - t0).toFixed(0)} (programs ${r.info.programs.length}, textures ${r.info.memory.textures})`); };
  new PerformanceObserver((list) => { for (const e of list.getEntries()) log.push(`long task ${e.duration.toFixed(0)} ms at +${(e.startTime - t0).toFixed(0)}`); }).observe({ type: 'longtask' });
  l._presetIndex = l._presetKeys.indexOf('bike_christmas'); l._applyPresetToPreview();
  const wait = () => { const sp = (l._specialPreviews || {}).bike_christmas; if (sp && sp.riders) { log.push(`geese seated at +${(performance.now() - t0).toFixed(0)}`); setTimeout(() => res(log), 1500); } else setTimeout(wait, 20); };
  wait();
}));
console.log(out.join('\n'));
await h.finish();
