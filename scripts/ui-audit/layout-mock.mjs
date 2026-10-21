// node scripts/ui-audit/layout-mock.mjs <outDir> [variant...] [--screens=mode,level,...]
// Layout mockups for the desktop/TV lobby (#428). Each variant is a CSS file in
// ./layouts/ injected over the live game, so no game code changes. A variant may
// start with `/* extends: a, _b */` to pull in other files first; files starting
// with "_" are partials, not variants. One page per screen; the stylesheet is
// swapped in place and screenshotted.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { start, wait, click, fake } from './harness.mjs';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'layouts');
const args = process.argv.slice(2);
const out = args.shift();
const screensArg = args.find((a) => a.startsWith('--screens='));
const want = args.filter((a) => !a.startsWith('--'));
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) tandemonium/1.0.0 Chrome/130.0.0.0 Electron/33.0.0 Safari/537.36';
const RETURNING = { tandemonium_started: '1', tandemonium_tutorial_done: 'audit' };

const read = (name) => fs.readFileSync(path.join(DIR, name + '.css'), 'utf8');
function cssFor(name, seen = new Set()) {
  if (seen.has(name)) return '';
  seen.add(name);
  const text = read(name);
  const ext = /^\/\*\s*extends:\s*([^*]+)\*\//.exec(text);
  const parents = ext ? ext[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
  return parents.map((p) => cssFor(p, seen)).join('\n') + '\n' + text;
}
const variants = ['current', ...fs.readdirSync(DIR).filter((f) => /^[a-z].*\.css$/.test(f)).map((f) => f.slice(0, -4))]
  .filter((v) => !want.length || want.includes(v));
const css = (v) => (v === 'current' ? '' : cssFor('_wide') + cssFor(v));
// A variant's CSS (or anything it extends) may name proposal-only scripts:
// `/* script: _controls */` runs layouts/_controls.js in the page. Scripts add
// elements with class "mock-dom", which are removed before the next variant.
const scriptsFor = (v) => {
  if (v === 'current') return [];
  const names = [...css(v).matchAll(/\/\*\s*script:\s*([^*]+)\*\//g)].flatMap((m) => m[1].split(',').map((x) => x.trim()));
  return [...new Set(names)].map((n) => fs.readFileSync(path.join(DIR, n + '.js'), 'utf8'));
};

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
  // Captain's room: code + QR for an online partner, plus a second controller on this screen.
  async host() {
    const p = await open(['dualsense'], 1);
    await click(p, '#btn-together'); await wait(1200); await click(p, '#btn-captain'); await wait(3000);
    return p;
  },
  // Captain's room with three controllers: who takes the back seat?
  async host3() {
    const p = await open(['dualsense', 'switch'], 1);
    await click(p, '#btn-together'); await wait(1200); await click(p, '#btn-captain'); await wait(3000);
    return p;
  },
  // Versus with five controllers: four seated, one left over.
  async versus5() {
    const p = await open(['dualsense', 'switch', 'supernova', 'xbox'], 1);
    await click(p, '#btn-together'); await wait(1200); await click(p, '#btn-versus'); await wait(2000);
    for (const [f, ...a] of [['press', 0, 'a'], ['pressHid', 0, 'a'], ['press', 1, 'a'], ['press', 2, 'a']]) { await fake(p, f, ...a); await wait(1200); }
    return p;
  },
  // Stoker: enter the captain's code with a DualSense.
  async join() {
    const p = await open(['dualsense']);
    await click(p, '#btn-together'); await wait(1200); await click(p, '#btn-stoker'); await wait(1500);
    return p;
  },
  // The Controls sheet (proposal): the mode screen; the variant's script opens it.
  async controls() { const p = await open(['dualsense', 'switch'], 1); await wait(1000); return p; },
  // Phone as controller: the QR sheet over the mode screen.
  async phone() { const p = await open(['dualsense']); await wait(800); await click(p, '#btn-mode-phone'); await wait(3000); return p; },
};
const screens = screensArg ? screensArg.slice(10).split(',') : Object.keys(SCREENS);

for (const name of screens) {
  const p = await SCREENS[name]();
  for (const v of variants) {
    await p.evaluate((text) => {
      let s = document.getElementById('mock-layout');
      if (!s) { s = document.createElement('style'); s.id = 'mock-layout'; document.head.appendChild(s); }
      s.textContent = text;
      window.dispatchEvent(new Event('resize'));
      document.querySelectorAll('.mock-dom').forEach((e) => e.remove());
    }, css(v));
    await p.evaluate((n) => { window.__mockScreen = n; }, name);
    for (const js of scriptsFor(v)) await p.evaluate(`(() => { ${js}
})()`);
    await wait(400);
    // The bike preview sizes its renderer once at startup; resize it to the new box.
    await p.evaluate(() => {
      const l = window._game?.lobby, c = document.getElementById('bike-preview-canvas');
      if (!l?._previewRenderer || !c?.clientWidth) return;
      l._previewRenderer.setSize(c.clientWidth, c.clientHeight, false);
      l._previewCamera.aspect = c.clientWidth / c.clientHeight;
      l._previewCamera.updateProjectionMatrix();
    });
    await wait(500);
    await h.shot(p, `${v}-${name}`, { title: `${v}: ${name}`, scenario: 'layout' });
  }
  await p.close();
}
await h.close();
