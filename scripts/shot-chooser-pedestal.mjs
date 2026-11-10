#!/usr/bin/env node
// shot: the three holiday bikes in the chooser with their outfit geese beside them (Settings › Bike Chooser
// Geese: Beside the bike), each on its pedestal; one image, side by side. SMOKE_GPU=1 for the real GPU.
import fs from 'node:fs';
import path from 'node:path';
import { startHarness, sleep } from './lib/smoke-harness.mjs';

const out = process.argv[2] || path.join(process.env.TEMP || '.', 'chooser-pedestal');
fs.mkdirSync(out, { recursive: true });
const h = await startHarness({ port: 8991, outDir: 'tandemonium-chooser-pedestal' });
const page = await h.gamePage({ viewport: { width: 1600, height: 900 }, storage: { tandemonium_tutorial_done: 'smoke', tandemonium_chooser_geese: 'stand' } });
await page.waitForFunction(() => window._game && window._game.lobby._presetKeys.length > 1 && !!window._game.lobby._previewModel, { timeout: 90000 });
const files = [];
const KEYS = process.env.SHOT_ALL ? ['bike_green', 'bike_christmas', 'solo_flight', 'time_warp', 'gold_standard', 'bike_birthday'] : ['bike_christmas', 'bike_newyears', 'bike_birthday'];
for (const key of KEYS) {
  await page.evaluate((k) => { const l = window._game.lobby; l._stopChooserAttract && l._stopChooserAttract(); l._presetIndex = l._presetKeys.indexOf(k); l._applyPresetToPreview(); }, key);
  await page.waitForFunction((k) => { const sp = (window._game.lobby._specialPreviews || {})[k];
    if (!/^bike_(christmas|newyears|birthday)$|^solo_flight$/.test(k)) return /^bike_(green|magenta)$/.test(k) ? true : !!(sp && sp.model && sp.model.visible);
    return !!(sp && sp.model && sp.model.visible && sp.actors && sp.actors.length === 2 && sp.model.getObjectByName('BikePedestal')); }, { timeout: 90000 }, key);
  await sleep(2600);   // (a three-quarter turn, a greeting under way)
  const el = await page.$('#bike-preview-wrap');
  const f = path.join(out, key + '.png');
  await el.screenshot({ path: f });
  files.push(f);
  console.log('shot', f);
}
// side by side
const imgs = files.map((f) => 'data:image/png;base64,' + fs.readFileSync(f).toString('base64'));
const sheet = await h.browser.newPage();
await sheet.setViewport({ width: 1500, height: 1000 });
await sheet.setContent(`<body style="margin:0;background:#1b1a2e;display:flex;flex-wrap:wrap;gap:12px;padding:12px;align-items:center">${imgs.map((s) => `<img src="${s}" style="width:calc((100% - 24px)/3);margin-bottom:12px;border-radius:10px">`).join('')}</body>`);
await sleep(300);
const all = path.join(out, 'holiday-bikes-pedestal.png');
await sheet.screenshot({ path: all, fullPage: true });
console.log('sheet', all);
await h.finish();
