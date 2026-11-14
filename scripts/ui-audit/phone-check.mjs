// The phone layout must not pick up any desktop/TV pieces (#428).
import { start, wait, click } from './harness.mjs';
const h = await start({ out: process.argv[2], width: 390, height: 844 });
const p = await h.open({ storage: { tandemonium_started: '1', tandemonium_tutorial_done: 'audit' } });
await wait(1500);
await click(p, '#tap-overlay').catch(() => {});
await p.mouse.click(195, 400).catch(() => {}); await wait(800);
const vis = (sel) => p.evaluate((s) => { const e = document.querySelector(s); if (!e) return 'missing'; const r = e.getBoundingClientRect(); return getComputedStyle(e).display !== 'none' && r.width > 0 ? 'VISIBLE' : 'hidden'; }, sel);
for (const s of ['#lobby-bar', '#lobby-wordmark', '#controls-sheet', '#versus-roster', '.lobby-toggle-col', '#btn-together .uf-button__sub', '#host-local'])
  console.log(s.padEnd(30), await vis(s));
await h.shot(p, 'phone-mode', { title: 'Phone mode screen', scenario: 'phone' });
const errs = p.logs.filter((l) => /pageerror|Uncaught/i.test(l)); console.log('page errors:', errs.length ? errs.slice(0, 4) : 'none');
await p.close(); await h.close();
