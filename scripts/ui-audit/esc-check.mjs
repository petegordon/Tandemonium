// Keyboard player: Esc backs out (#428).
import { start, wait, click } from './harness.mjs';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) tandemonium/1.0.0 Chrome/130.0.0.0 Electron/33.0.0 Safari/537.36';
const h = await start({ out: process.argv[2] });
const p = await h.open({ setup: (pg) => pg.setUserAgent(UA), storage: { tandemonium_started: '1', tandemonium_tutorial_done: 'audit' } });
const step = () => p.evaluate(() => document.getElementById('lobby-flow').current);
await wait(1000);
await click(p, '#btn-solo'); await wait(1000); console.log('after SOLO:', await step());
await p.keyboard.press('Escape'); await wait(600); console.log('after Esc:', await step());
await click(p, '#btn-together'); await wait(800); await click(p, '#bar-help'); await wait(500);
await p.keyboard.press('Escape'); await wait(400); console.log('help closed, still on:', await step(), 'help visible:', await p.evaluate(() => document.getElementById('help-modal').classList.contains('visible')));
await click(p, '#bar-controls'); await wait(600);
await p.keyboard.press('Escape'); await wait(400); console.log('sheet closed, still on:', await step(), 'sheet open:', await p.evaluate(() => document.getElementById('controls-sheet').open));
await p.keyboard.press('Escape'); await wait(600); console.log('after Esc:', await step());
await p.close(); await h.close();
