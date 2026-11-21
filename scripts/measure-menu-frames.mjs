// Frame times on the main menu for the first seconds after it is ready: what anything done in the
// background there costs (preparing the chooser's bikes ahead cost about ten slow frames, 2026-11-17). node scripts/measure-menu-frames.mjs [--seconds 12]
// Use SMOKE_GPU=1 for the machine's own GPU; run before and after a change to compare.
import { startHarness } from './lib/smoke-harness.mjs';

const i = process.argv.indexOf('--seconds');
const seconds = i > 0 ? Number(process.argv[i + 1]) : 12;
const h = await startHarness({ port: 8988, outDir: 'tandemonium-measure-menu' });
const page = await h.gamePage({ viewport: { width: 1600, height: 900 }, storage: { tandemonium_tutorial_done: 'smoke' } });
await page.waitForFunction(() => window._game && window._game.lobby._presetKeys && window._game.lobby._presetKeys.length > 1 && !!window._game.lobby._previewModel, { timeout: 90000 });
const r = await page.evaluate((seconds) => new Promise((resolve) => {
  const t0 = performance.now();
  let last = t0, n = 0, worst = 0, over33 = 0, over50 = 0, over100 = 0;
  const tick = () => {
    const now = performance.now(), d = now - last;
    last = now; n++;
    worst = Math.max(worst, d);
    if (d > 33.4) over33++;
    if (d > 50) over50++;
    if (d > 100) over100++;
    if (now - t0 < seconds * 1000) return requestAnimationFrame(tick);
    const loaded = Object.entries(window._game.lobby._specialPreviews || {}).filter(([, sp]) => sp.model).map(([k]) => k);
    resolve({ frames: n, fps: Math.round(n / seconds), worst: Math.round(worst), over33, over50, over100, ready: loaded });
  };
  requestAnimationFrame(tick);
}), seconds);
console.log(`${seconds} s on the menu: ${r.frames} frames (${r.fps} fps), worst ${r.worst} ms, frames over 33 ms: ${r.over33}, over 50 ms: ${r.over50}, over 100 ms: ${r.over100}`);
console.log(`chooser bikes loaded: ${r.ready.length ? r.ready.join(' ') : 'none'}`);
await h.finish();
