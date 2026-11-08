#!/usr/bin/env node
// smoke-share-card.mjs — #657 part 1: SHARE RESULT in the Steam build saves a
// clean result card to the Steam screenshot library.
//
//   1. Steam (fake bridge): finish a Daily Ride → SHARE RESULT sends a
//      1920×1080 PNG + its RGB pixels + the caption to steam.saveScreenshot,
//      and the button says where it went. A second press does not save twice.
//   2. Steam refuses the save → the clipboard, and the button says so.
//   3. No Steam (a desktop browser) → the clipboard, unchanged.
//
// Headless renders slowly, so the ride's distance is set directly (as
// shot-end-sheets.mjs does). Polls, never fixed sleeps.
import fs from 'node:fs';
import path from 'node:path';
import { startHarness, clickId, waitState } from './lib/smoke-harness.mjs';
import { installFakeSteam, fakeSteam, ELECTRON_UA } from './lib/fake-steam.mjs';

const h = await startHarness({ port: 8979 });
const STORAGE = { tandemonium_tutorial_done: 'smoke' };
const OUT = process.env.SMOKE_SHARE_OUT || null;
const SAVED = /^Saved to your Steam screenshots · (Shift\+Tab|Steam button) to share$/;

/** Daily Ride → START RIDE → the finish; resolves when SHARE RESULT is on the victory sheet. */
async function finishDaily(page) {
  await page.waitForFunction(() => !!document.getElementById('btn-solo'), { timeout: 30000, polling: 100 });
  await page.evaluate(() => document.getElementById('btn-solo').click());
  await page.waitForFunction(() => !!document.querySelector('#level-cards .level-card[data-level-id="daily"]'), { timeout: 30000, polling: 100 });
  await page.evaluate(() => document.querySelector('#level-cards .level-card[data-level-id="daily"]').click());
  await page.waitForFunction(() => window._game.lobby.selectedLevel && window._game.lobby.selectedLevel.id === 'daily', { timeout: 10000, polling: 100 });
  await clickId(page, 'btn-start-ride');
  await waitState(page, 'playing');
  await page.evaluate(() => {
    const g = window._game;
    // Take a few presents so the card has a presents line.
    const m = g.collectibleManager;
    if (m) for (const it of m._items.slice(0, 3)) if (!it.collected) { it.collected = true; m.collected++; }
    if (g.raceManager && m) g.raceManager.collectiblesCount = m.collected;
    g.bike.distanceTraveled = g.lobby.selectedLevel.distance - 0.5; g.bike.speed = 10;
  });
  await waitState(page, 'victory', 240000);
  await page.waitForFunction(() => {
    const b = document.getElementById('btn-daily-share-victory');
    return b && b.style.display !== 'none' && !!window._game._dailyStripText;
  }, { timeout: 20000, polling: 100 });
}

/** Record clipboard writes instead of needing the permission headless. */
const stubClipboard = (page) => page.evaluate(() => {
  window.__copied = [];
  const clip = navigator.clipboard || {};
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { ...clip, writeText: async (t) => { window.__copied.push(t); } } });
});
const shareLabel = (page) => page.evaluate(() => document.getElementById('btn-daily-share-victory').textContent.trim());
const pressShare = (page) => page.evaluate(() => document.getElementById('btn-daily-share-victory').click());

// ── 1. Steam: the card goes to the screenshot library ──────────────────────
{
  const page = await h.gamePage({ storage: STORAGE, userAgent: ELECTRON_UA, before: (p) => installFakeSteam(p) });
  const steam = fakeSteam(page);
  await finishDaily(page);
  await stubClipboard(page);
  const strip = await page.evaluate(() => window._game._dailyStripText);
  const model = await page.evaluate(() => { const m = window._game._resultCardModel(); return m && { caption: m.caption, badges: m.badges.length, stats: m.stats.map(s => s.kind), link: m.link }; });
  h.check(model && /^Tandemonium · Daily Ride · [A-Z][a-z]{2} \d{1,2} · \d+:\d\d/.test(model.caption), 'card model: caption is the strip headline', model);
  h.check(model && model.badges >= 1, 'card model: the badges this ride unlocked', model && model.badges);
  h.check(model && model.stats.includes('presents') && model.stats.includes('tokens'), 'card model: presents and Tandem Tokens', model && model.stats);
  h.check(model && /^https?:\/\/.+\?daily=\d{4}-\d\d-\d\d$/.test(model.link || ''), 'card model: the road link', model && model.link);

  await pressShare(page);
  await page.waitForFunction(() => window.__fakeSteam.state.screenshots.length >= 1, { timeout: 30000, polling: 100 });
  const shots = await steam.screenshots();
  const s = shots[0] || {};
  h.check(shots.length === 1, 'one saveScreenshot call', shots.length);
  h.check(s.isPng && s.pngWidth === 1920 && s.pngHeight === 1080 && s.width === 1920 && s.height === 1080, 'a 1920×1080 PNG', { w: s.pngWidth, h: s.pngHeight });
  h.check(s.pngBytes > 50000, 'the PNG is not empty', s.pngBytes);
  h.check(s.rgbBytes === 1920 * 1080 * 3, 'RGB pixels for WriteScreenshot (3 bytes a pixel)', s.rgbBytes);
  h.check(model && s.caption === model.caption, 'captioned with the strip headline', s.caption);
  await page.waitForFunction((src) => new RegExp(src).test(document.getElementById('btn-daily-share-victory').textContent.trim()), { timeout: 10000, polling: 100 }, SAVED.source);
  h.check(SAVED.test(await shareLabel(page)), 'button says it is in the Steam screenshots', await shareLabel(page));
  if (OUT) {   // SMOKE_SHARE_OUT=<dir>: keep the card and the sheet to look at
    const b64 = await page.evaluate(async () => {
      const { renderResultCard } = await import('./js/result-card.js');
      return (await renderResultCard(window._game._resultCardModel())).canvas.toDataURL('image/png').split(',')[1];
    });
    fs.writeFileSync(path.join(OUT, 'share-card-ingame.png'), Buffer.from(b64, 'base64'));
    await page.screenshot({ path: path.join(OUT, 'share-card-sheet.png') });
  }
  const copied1 = await page.evaluate(() => window.__copied.length);
  h.check(copied1 === 0, 'nothing copied to the clipboard on a Steam save', copied1);

  // A second press: says where it went again, no second screenshot.
  await page.evaluate(() => { document.getElementById('btn-daily-share-victory').textContent = 'x'; });
  await pressShare(page);
  await page.waitForFunction((src) => new RegExp(src).test(document.getElementById('btn-daily-share-victory').textContent.trim()), { timeout: 10000, polling: 100 }, SAVED.source);
  h.check((await steam.screenshots()).length === 1, 'a second press does not save twice', (await steam.screenshots()).length);

  // ── 2. Steam refuses: the clipboard, and the button says so ──────────────
  await steam.setScreenshotMode('fail');
  await page.evaluate(() => { window._game._shareSavedToSteam = false; });
  await pressShare(page);
  await page.waitForFunction(() => window.__copied.length >= 1, { timeout: 30000, polling: 100 });
  const copied = await page.evaluate(() => window.__copied.slice());
  h.check(copied[0] === strip, 'failed save: the strip is copied instead', copied[0] && copied[0].split('\n')[0]);
  await page.waitForFunction(() => /COPIED INSTEAD/.test(document.getElementById('btn-daily-share-victory').textContent), { timeout: 10000, polling: 100 });
  h.check(/COULDN'T SAVE TO STEAM · COPIED INSTEAD/.test(await shareLabel(page)), 'failed save: the button says so', await shareLabel(page));
  await page.close();
}

// ── 3. No Steam: the clipboard, as before ─────────────────────────────────
{
  const page = await h.gamePage({ storage: STORAGE });
  await finishDaily(page);
  await stubClipboard(page);
  const strip = await page.evaluate(() => window._game._dailyStripText);
  h.check(await page.evaluate(() => !window.steam), 'browser: no Steam bridge');
  await pressShare(page);
  await page.waitForFunction(() => window.__copied.length >= 1, { timeout: 30000, polling: 100 });
  const copied = await page.evaluate(() => window.__copied.slice());
  h.check(copied.length === 1 && copied[0] === strip, 'browser: the strip is copied', copied[0] && copied[0].split('\n')[0]);
  await page.waitForFunction(() => document.getElementById('btn-daily-share-victory').textContent.trim() === 'COPIED', { timeout: 10000, polling: 100 });
  h.check(true, 'browser: the button says COPIED');
  await page.close();
}

await h.finish();
