// How long does the bike chooser take to show a bike that brings an outfit, and its geese?
//   node scripts/measure-chooser.mjs [--mode stand|ride] [--wait ms]
// Opens the game, waits `--wait` ms on the menu, then picks each outfit bike for the first time and
// reports, per bike: ms and frames until the bike shows, and until both geese show. Run it before
// and after a change. Headless Chrome draws in software, so the numbers are for comparing, not
// what a player's machine does.
import { startHarness, sleep } from './lib/smoke-harness.mjs';

const arg = (name, dflt) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : dflt; };
const mode = arg('mode', 'stand');
const waitMs = Number(arg('wait', '0'));
const only = arg('bikes', '');

const h = await startHarness({ port: 8987, outDir: 'tandemonium-measure-chooser' });
const page = await h.gamePage({ viewport: { width: 1600, height: 900 }, storage: { tandemonium_tutorial_done: 'smoke', tandemonium_chooser_geese: mode } });
await page.waitForFunction(() => window._game && window._game.lobby._presetKeys && window._game.lobby._presetKeys.length > 1 && !!window._game.lobby._previewModel, { timeout: 90000 });
const keys = await page.evaluate(() => window._game.lobby._presetKeys);
if (waitMs) await sleep(waitMs);

const rows = [];
const outfitBikes = await page.evaluate(async () => { const { giftOutfit } = await import("/js/bike-celebration.js"); return window._game.lobby._presetKeys.filter((k) => !!giftOutfit(k)); });
for (const key of (only ? only.split(",") : outfitBikes).filter((k) => keys.includes(k))) {
  const r = await page.evaluate((key) => new Promise((resolve) => {
    const l = window._game.lobby;
    const t0 = performance.now();
    let frames = 0, bike = null, long = 0, last = t0;
    l._presetIndex = l._presetKeys.indexOf(key);
    l._applyPresetToPreview();
    const tick = () => {
      const now = performance.now();
      frames++;
      long = Math.max(long, now - last);
      last = now;
      const sp = (l._specialPreviews || {})[key];
      const shown = !!(sp && sp.model && sp.model.visible);
      if (shown && !bike) bike = { ms: Math.round(now - t0), frames };
      const geese = sp && (sp.riders ? Object.values(sp.riders.riders).filter(Boolean).every((x) => x.root.visible)
        : (sp.actors && sp.actors.length === 2 && sp.stand && sp.stand.visible));
      if (shown && (geese || !sp.outfit)) return resolve({ key, bike, geese: { ms: Math.round(now - t0), frames }, worstFrame: Math.round(long) });
      if (now - t0 > 120000) return resolve({ key, bike, geese: null, worstFrame: Math.round(long) });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }), key);
  rows.push(r);
  console.log(`${r.key.padEnd(16)} bike ${String(r.bike ? r.bike.ms : '-').padStart(6)} ms (${r.bike ? r.bike.frames : '-'} frames)   geese ${String(r.geese ? r.geese.ms : 'never').padStart(6)} ms (${r.geese ? r.geese.frames : '-'} frames)   worst frame ${r.worstFrame} ms`);
}
// a bike already seen once: back to it
if (rows.length) {
  const key = rows[0].key;
  const again = await page.evaluate((key) => new Promise((resolve) => {
    const l = window._game.lobby, t0 = performance.now();
    l._presetIndex = l._presetKeys.indexOf(key);
    l._applyPresetToPreview();
    const tick = () => { const sp = l._specialPreviews[key]; if (sp && sp.model && sp.model.visible) resolve(Math.round(performance.now() - t0)); else requestAnimationFrame(tick); };
    tick();
  }), key);
  console.log(`${key.padEnd(16)} again: ${again} ms`);
}
console.log(`mode ${mode}, waited ${waitMs} ms first; bikes in this build: ${keys.join(' ')}`);
await h.finish();
