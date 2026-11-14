// Type a code on the desktop join keypad with a DualSense (#428).
import { start, wait, click, fake } from './harness.mjs';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) tandemonium/1.0.0 Chrome/130.0.0.0 Electron/33.0.0 Safari/537.36';
const h = await start({ out: process.argv[2] });
const p = await h.open({ setup: (pg) => pg.setUserAgent(UA), storage: { tandemonium_started: '1', tandemonium_tutorial_done: 'audit' }, pads: ['dualsense'] });
const pr = async (b) => { await fake(p, "press", 0, b); await wait(420); };
await wait(1000); await pr('a'); await wait(400);
await click(p, '#btn-together'); await wait(1000); await click(p, '#btn-stoker'); await wait(1500);
// K = row 2 col 2 from A (top-left): down, right ; then 9 = row 4 col 8
await pr('down'); await pr('right'); await pr('a');
await pr('down'); await pr('down'); for (let i = 0; i < 6; i++) await pr('right'); await pr('a');
console.log(await p.evaluate(() => ({ code: document.getElementById('join-code-tv').code, focus: document.querySelector('.gamepad-focus')?.dataset?.key || document.querySelector('.gamepad-focus')?.id })));
await h.shot(p, 'join-typed', { title: 'Typed K9 with a DualSense', scenario: 'join' });
await p.keyboard.type('NE'); await wait(300);
console.log(await p.evaluate(() => ({ code: document.getElementById('join-code-tv').code, done: !document.querySelector('#join-keypad-tv uf-button[data-key="Done"]').disabled })));
const errs = p.logs.filter((l) => /pageerror|Uncaught/i.test(l)); console.log('page errors:', errs.length ? errs.slice(0, 4) : 'none');
await p.close(); await h.close();
