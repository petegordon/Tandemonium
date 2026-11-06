#!/usr/bin/env node
// shot-dressing-room · manual: screenshots of the Dressing Room (#548) at TV,
// laptop and phone-landscape sizes, one card editing and one ready, so a layout
// change can be eyeballed. Not a pass/fail smoke.
//
//   node scripts/shot-dressing-room.mjs [outDir]
import { startHarness, sleep } from './lib/smoke-harness.mjs';
import { installFakeGamepads, fakePads } from './lib/fake-gamepads.mjs';

const outDir = process.argv[2] || 'tandemonium-dressing-room';
const h = await startHarness({ port: 8977, outDir });
const until = (page, fn, timeout = 15000) => page.waitForFunction(fn, { timeout }).then(() => true, () => false);
const SIZES = [{ name: 'tv-1080p', width: 1920, height: 1080 }, { name: 'laptop-1280x800', width: 1280, height: 800 }];

for (const v of SIZES) {
  const page = await h.gamePage({ viewport: { width: v.width, height: v.height }, storage: { tandemonium_tutorial_done: 'smoke' }, before: (p) => installFakeGamepads(p, { atBoot: ['xbox'] }) });
  const pads = fakePads(page);
  await until(page, () => !!window.__controllerManager && !!window.__playerLooks);
  await page.evaluate(() => {
    const l = window._game.lobby;
    document.getElementById('room-code-display').textContent = 'TNDM-WARD';
    l._pendingMode = 'multiplayer'; l._roomRole = 'captain';
    l._showStep(l.hostStep); l._refreshHostNext();
  });
  const p2 = await pads.plug('dualsense');
  await until(page, () => (window._game.lobby._detectLocalJoinCandidates() || []).length > 0);
  await pads.tap(p2, 'A');
  await until(page, () => window._game.lobby._localSeatedOnHost);
  await pads.tap(p2, 'Y');
  await until(page, () => window._game.lobby._room && document.getElementById('dressing-room').open && window._game.lobby._room.cards.size === 2);
  await sleep(2500);   // previews load + the Edit transition settles
  await h.shot(page, `${v.name}-editing`);
  const fit = await page.evaluate(() => {
    const card = document.querySelector('#dressing-room > .uf-sheet__card').getBoundingClientRect();
    const body = document.querySelector('#dressing-room .uf-sheet__body');
    const btn = document.querySelector('#dr-cards .dr-card .opt-btn');
    const prev = [...document.querySelectorAll('#dr-cards .dr-preview')].map((e) => Math.round(e.getBoundingClientRect().height));
    return { card: { w: Math.round(card.width), h: Math.round(card.height) }, bodyScrolls: body.scrollHeight > body.clientHeight + 1,
      btnFont: btn ? getComputedStyle(btn).fontSize : null, previewHeights: prev };
  });
  console.log(v.name, 'editing', JSON.stringify(fit));
  // P2 done: both cards Ready.
  await page.evaluate(() => { const b = document.querySelector('#dr-cards .dr-card[data-n="2"] .dr-actions uf-button, #dr-cards .dr-card[data-n="2"] .dr-actions button'); if (b) b.click(); });
  await sleep(1500);
  await h.shot(page, `${v.name}-ready`);
  const fit2 = await page.evaluate(() => ({ previewHeights: [...document.querySelectorAll('#dr-cards .dr-preview')].map((e) => Math.round(e.getBoundingClientRect().height)),
    bodyScrolls: (() => { const b = document.querySelector('#dressing-room .uf-sheet__body'); return b.scrollHeight > b.clientHeight + 1; })() }));
  console.log(v.name, 'ready', JSON.stringify(fit2));
  await page.close();
}
await h.finish();
