// node scripts/ui-audit/tv-check.mjs <outDir>
// Layout A smoke (#428): system bar, Controls sheet, popups, bar focus.
import { start, wait, click, fake } from './harness.mjs';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) tandemonium/1.0.0 Chrome/130.0.0.0 Electron/33.0.0 Safari/537.36';
const h = await start({ out: process.argv[2] });
const p = await h.open({ setup: (pg) => pg.setUserAgent(UA), storage: { tandemonium_started: '1', tandemonium_tutorial_done: 'audit' }, pads: ['dualsense', 'switch'], pucks: 1 });
const shot = (id, title) => h.shot(p, id, { title, scenario: 'tv' });
const X = () => fake(p, 'press', 0, 'a'), DN = () => fake(p, 'press', 0, 'down'), RT = () => fake(p, 'press', 0, 'right'), O = () => fake(p, 'press', 0, 'b');
await wait(1200);
await X(); await wait(800);   // P1 claims (DualSense), focus on RIDE TOGETHER
await shot('tv-mode', 'Mode screen with the system bar');
for (let i = 0; i < 6; i++) { await DN(); await wait(300); }
await shot('tv-bar-focus', 'D-pad ↓ past the buttons reaches the bar');
console.log('focused after ↓×6:', await p.evaluate(() => document.querySelector('.gamepad-focus')?.id || document.querySelector('.gamepad-focus')?.className));
await click(p, '#bar-controls'); await wait(900);
await shot('tv-controls', 'Controls sheet');
console.log('sheet:', await p.evaluate(() => ({ open: document.getElementById('controls-sheet').open, label: document.getElementById('bar-controls-label').textContent,
  seat: document.getElementById('controls-seat').who, rows: document.querySelectorAll('#controls-roster .ucr-row').length,
  stick: document.getElementById('set-stick').checked, focus: document.querySelector('.gamepad-focus')?.id || document.querySelector('.gamepad-focus')?.tagName })));
await O(); await wait(700);
console.log('after ◯:', await p.evaluate(() => ({ open: document.getElementById('controls-sheet').open })));
await click(p, '#bar-music'); await wait(500);
await shot('tv-music', 'Music volume picker above its pill');
await p.keyboard.press('Escape'); await click(p, '#lobby-wordmark').catch(() => {}); await wait(300);
await p.evaluate(() => document.getElementById('volume-picker').classList.remove('visible'));
await click(p, '#bar-profile'); await wait(700);
await shot('tv-profile', 'Profile popup above its pill');
await p.evaluate(() => document.getElementById('profile-popup').classList.remove('visible'));
await click(p, '#bar-help'); await wait(700);
await shot('tv-help', 'Help (credits + version at the bottom)');
await p.evaluate(() => document.getElementById('help-close')?.click()); await wait(400);
await click(p, '#btn-solo'); await wait(1500);
await shot('tv-level', 'Level select with Back in the bar');
console.log('bar back visible on level:', await p.evaluate(() => !document.querySelector('#lobby-bar .uf-bar__back').hidden));
const errs = p.logs.filter((l) => /pageerror|Uncaught/i.test(l));
console.log('page errors:', errs.length ? [...new Set(errs)].slice(0, 6) : 'none');
await p.close(); await h.close();
