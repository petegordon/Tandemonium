#!/usr/bin/env node
// shot-end-sheets.mjs — #512: screenshots of the end-of-ride sheets at the
// viewports Pete cares about, so a layout change can be eyeballed without a
// playtest. Not a smoke (nothing is checked beyond "no page errors"); it writes
// <outDir>/<viewport>-<scene>.png:
//   grandma-victory · grandma-gameover · daily-practice-victory (first of the
//   day, 3-day streak) · daily-ranked-victory · coop-victory (local co-op)
// at lap 1280×800 (laptop / Steam Deck), tv 1920×1080 and phone 844×390
// (landscape). Headless renders slowly, so distances are set directly.
//   node scripts/shot-end-sheets.mjs [--out <dir>] [--only lap,tv,phone]
import path from 'node:path';
import fs from 'node:fs';
import { startHarness, sleep, clickId, waitState } from './lib/smoke-harness.mjs';
import { dailyKey } from '../js/daily-seed.js';

const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const OUT = arg('--out', null);
const ONLY = arg('--only', 'lap,tv,phone').split(',');
const VIEWPORTS = {
  lap: { width: 1280, height: 800 },
  tv: { width: 1920, height: 1080 },
  phone: { width: 844, height: 390 },   // landscape phone; the kit's breakpoints are width-based, so no mobile UA is needed
};
const h = await startHarness({ port: 8966, outDir: OUT ? null : 'tandemonium-end-sheets' });
const outDir = OUT || h.out;
fs.mkdirSync(outDir, { recursive: true });
const shot = async (page, name) => { const f = path.join(outDir, name + '.png'); await page.screenshot({ path: f }); console.log('  shot', f); };

// A 3-day streak into today: yesterday and the day before were ridden.
const shiftKey = (key, days) => new Date(Date.parse(key + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);
const today = dailyKey();
const STREAK = JSON.stringify({ [shiftKey(today, -1)]: { practice: 1, best: 95000 }, [shiftKey(today, -2)]: { practice: 2, best: 99000 } });
const STORAGE = { tandemonium_tutorial_done: 'smoke' };

async function open(vp, storage = {}) {
  const page = await h.gamePage({ viewport: { width: vp.width, height: vp.height }, storage: { ...STORAGE, ...storage }, userAgent: vp.ua || null });
  await sleep(800);
  return page;
}
const pickLevel = async (page, id, difficulty = 'chill') => {
  await page.evaluate(() => document.getElementById('btn-solo').click());
  await page.waitForFunction((id) => !!document.querySelector(`#level-cards .level-card[data-level-id="${id}"]`), { timeout: 20000 }, id);
  await page.evaluate((id, difficulty) => {
    document.querySelector(`#level-cards .level-card[data-level-id="${id}"]`).click();
    const d = Array.from(document.querySelectorAll('.difficulty-btn')).find(x => x.dataset.difficulty === difficulty); d && d.click();
  }, id, difficulty);
  await sleep(300);
};
// Take some of the road's presents and tokens so every tally line has a number.
const collectSome = (page, presents = 3, tokens = 7) => page.evaluate((presents, tokens) => {
  const g = window._game;
  const take = (m, n) => { if (!m) return; for (const it of m._items.slice(0, n)) if (!it.collected) { it.collected = true; m.collected++; } };
  take(g.collectibleManager, presents); take(g.tokenManager, tokens);
  if (g.raceManager) g.raceManager.collectiblesCount = g.collectibleManager ? g.collectibleManager.collected : 0;
  if (g._syncTokenTally) g._syncTokenTally(0);
}, presents, tokens);
const finishRide = async (page) => {
  await page.evaluate(() => { const g = window._game; g.bike.distanceTraveled = g.lobby.selectedLevel.distance - 0.5; g.bike.speed = 10; });
  await waitState(page, 'victory', 240000);
  // The destination video decodes slowly headless: wait for a frame, then the tally's roll-up.
  await page.waitForFunction(() => { const v = window._game._victoryVideo; return !v || v.video.readyState >= 2; }, { timeout: 15000, polling: 100 }).catch(() => {});
  await sleep(1600);
};

for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
  if (!ONLY.includes(vpName)) continue;
  console.log(`\n== ${vpName} ${vp.width}×${vp.height}`);

  // Grandma's: a crash at 140 m (game over), RESTART, then the finish (victory).
  {
    const page = await open(vp);
    await pickLevel(page, 'grandma');
    await clickId(page, 'btn-start-ride');
    await waitState(page, 'playing');
    await collectSome(page, 2, 4);
    await page.evaluate(() => { const g = window._game, rm = g.raceManager; rm.passedCheckpoints.add(rm.checkpoints[1]); g.bike.distanceTraveled = 140; g._showGameOver(); });
    await sleep(1600);
    await shot(page, `${vpName}-grandma-gameover`);
    await clickId(page, 'btn-restart');
    await waitState(page, 'playing');
    await collectSome(page, 4, 11);
    await finishRide(page);
    await shot(page, `${vpName}-grandma-victory`);
    await page.close();
  }

  // The Daily Ride, practice then ranked: first finish of the day on a 3-day streak.
  for (const mode of ['practice', 'ranked']) {
    const page = await open(vp, { tandemonium_daily: STREAK });
    await pickLevel(page, 'daily', 'adventurous');
    await clickId(page, 'btn-start-ride');
    await sleep(400);
    const chooser = await page.evaluate(() => document.getElementById('daily-mode-overlay')?.classList.contains('visible'));
    if (chooser) await clickId(page, 'btn-daily-' + mode);
    await waitState(page, 'playing');
    await collectSome(page, 5, 23);
    await finishRide(page);
    await shot(page, `${vpName}-daily-${mode}-victory`);
    await page.close();
  }

  // Local co-op (P1 keyboard captain + P2 keyboard stoker): the finish with the contribution breakdown.
  {
    const page = await open(vp);
    await page.evaluate(() => {
      const l = window._game.lobby;
      document.getElementById('room-code-display').textContent = 'TNDM-LOCL';
      l._pendingMode = 'multiplayer'; l._roomRole = 'captain';
      l._showStep(l.hostStep); l._refreshHostNext();
    });
    await sleep(500);
    const joined = await page.evaluate(() => { const b = document.getElementById('btn-local-join-kb'); if (b && b.offsetParent !== null) { b.click(); return true; } return false; });
    if (!joined) await page.evaluate(() => window._game.lobby._onLocalJoinClick('keyboard', null));
    await sleep(600);
    await clickId(page, 'btn-host-local-next');
    await sleep(700);
    await page.evaluate(() => { const c = document.querySelector('#level-cards .level-card[data-level-id="grandma"]'); c && c.click(); });
    await sleep(300);
    await clickId(page, 'btn-start-ride');
    await waitState(page, 'playing');
    await collectSome(page, 3, 9);
    await finishRide(page);
    await shot(page, `${vpName}-coop-victory`);
    await page.close();
  }
}
console.log(`\nscreenshots: ${outDir}`);
await h.finish();
