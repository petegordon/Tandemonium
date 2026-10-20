// node scripts/ui-audit/layout-mock.mjs <outDir> [variant...]
// Layout mockups for the desktop/TV lobby (#428). Each variant is a CSS file in
// ./layouts/ injected over the live game, so no game code changes. One page per
// screen; the variant stylesheet is swapped in place and screenshotted.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { start, wait, click, fake } from './harness.mjs';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'layouts');
const [out, ...want] = process.argv.slice(2);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) tandemonium/1.0.0 Chrome/130.0.0.0 Electron/33.0.0 Safari/537.36';
const RETURNING = { tandemonium_started: '1', tandemonium_tutorial_done: 'audit' };
const shared = fs.existsSync(path.join(DIR, '_wide.css')) ? fs.readFileSync(path.join(DIR, '_wide.css'), 'utf8') : '';
const variants = ['current', ...fs.readdirSync(DIR).filter((f) => /^[a-z].*\.css$/.test(f)).map((f) => f.slice(0, -4))]
  .filter((v) => !want.length || want.includes(v));
const css = (v) => (v === 'current' ? '' : shared + '\n' + fs.readFileSync(path.join(DIR, v + '.css'), 'utf8'));

const h = await start({ out });
const open = (pads, pucks) => h.open({ setup: (pg) => pg.setUserAgent(UA), storage: RETURNING, pads, pucks });

const SCREENS = {
  async mode() { const p = await open(['dualsense']); await wait(1000); return p; },
  async level() { const p = await open(['dualsense']); await click(p, '#btn-solo'); await wait(1500); return p; },
  async versus() {
    const p = await open(['dualsense', 'switch', 'supernova'], 1);
    await click(p, '#btn-together'); await wait(1200); await click(p, '#btn-versus'); await wait(2000);
    for (const [f, ...a] of [['press', 0, 'a'], ['pressHid', 0, 'a'], ['press', 1, 'a'], ['press', 2, 'a']]) { await fake(p, f, ...a); await wait(1200); }
    return p;
  },
};

for (const [name, open] of Object.entries(SCREENS)) {
  const p = await open();
  for (const v of variants) {
    await p.evaluate((text) => {
      let s = document.getElementById('mock-layout');
      if (!s) { s = document.createElement('style'); s.id = 'mock-layout'; document.head.appendChild(s); }
      s.textContent = text;
      window.dispatchEvent(new Event('resize'));
    }, css(v));
    await wait(700);
    await h.shot(p, `${v}-${name}`, { title: `${v}: ${name}`, scenario: 'layout' });
  }
  await p.close();
}
await h.close();
